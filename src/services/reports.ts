import { query } from '../db/index.js';
import { settings } from '../settings/index.js';
import { businessMinutesBetween, loadSlaFacts as slaFacts, slaFromFacts, type TicketSla } from './sla.js';
import { TICKET_PRIORITIES, TICKET_TYPES, type TicketPriority, type TicketStatus, type TicketType } from './tickets.js';
import { managedGroups, memberGroups, type GroupRef } from './work-dashboard.js';
import type { UserRow } from './users.js';
import { ticketReference } from '../lib/util.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import { workbook, type Sheet } from '../lib/xlsx.js';
import { words } from '../i18n/current.js';
import { BLANK, columnClauses, MAX_VALUES, menuValues, withoutColumn, type ColumnFilters, type ColumnValue } from '../lib/column-filters.js';

/**
 * Reports (/reports): what a group did over a period - raised, resolved,
 * closed, cancelled; how its service levels held; how long things took;
 * which customer companies it served; and, for those who manage it, each
 * technician's share.
 *
 * Who sees which groups: an administrator every active group; a manager the
 * groups they manage; a technician the groups they are in. The per-person
 * breakdown is only shown when every group in the report is one the reader
 * manages (or they are an administrator) - a technician sees the group's
 * figures, not a league table of their colleagues.
 *
 * **Company** is the requester's (users.company). A report can be narrowed
 * to one company - for a managed service provider, what one customer got -
 * and always shows the companies side by side.
 *
 * Computed on demand from the tickets themselves, like the SLA clocks
 * (nothing stored per ticket), so a changed target re-reads history. Top-level
 * tickets only: a task is part of the ticket it hangs off. The facts the SLA
 * clocks need - each ticket's first response and status changes - are loaded
 * in two queries per few hundred tickets, never two per ticket: that was the
 * page's whole cost.
 */

const DAY = 86_400_000;
/** Tickets read per report for the SLA and timing figures. */
export const REPORT_CAP = 3000;
/** Companies listed side by side; the rest are summed into "Other". */
const COMPANY_ROWS = 25;
/** The company filter's value for requesters with none. */
export const NO_COMPANY = '-';

export interface ReportGroup extends GroupRef {
  /** May this reader see the per-technician figures for it? */
  manages: boolean;
}

/** The groups a person may report on, by name. */
export async function reportGroups(user: UserRow): Promise<ReportGroup[]> {
  if (user.role === 'admin') {
    return (await managedGroups(user)).map((g) => ({ ...g, manages: true }));
  }
  if (user.role === 'user') return [];
  const managed = await managedGroups(user);
  const member = await memberGroups(user.id);
  const all = new Map<string, ReportGroup>();
  for (const g of member) all.set(g.id, { ...g, manages: false });
  for (const g of managed) all.set(g.id, { ...g, manages: true });
  return [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const PERIODS = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: 'custom', label: 'Between dates', days: 0 },
] as const;

export interface ReportInput {
  group: string;
  period: string;
  from?: string;
  to?: string;
  /** A requester company; empty for all, NO_COMPANY for those with none. */
  company?: string;
  /** Also list each ticket (the download's Tickets sheet). Off: the page stays light. */
  details?: boolean;
  /**
   * An exact window, set only by this file for the previous period - never
   * from a request. A report with one is "light": totals, service levels,
   * timings and backlog only, and no comparison of its own.
   */
  range?: { from: Date; to: Date };
}

/**
 * What each figure means. One place, read by the page (the ⓘ marks), the
 * list behind a figure, the Excel Definitions sheet and docs/REPORTING.md -
 * so a figure means the same wherever it appears.
 */
export const METRIC_DEFINITIONS = {
  raised: { label: 'Raised', definition: 'Top-level tickets created in the period (tasks are part of their ticket). Cancelled ones included.' },
  resolved: { label: 'Resolved', definition: 'Tickets whose current resolution date falls in the period. Closing a ticket directly also resolves it. A ticket reopened and resolved again counts once, at its latest resolution.' },
  closed: { label: 'Closed', definition: 'Tickets whose closing date falls in the period.' },
  cancelled: { label: 'Cancelled', definition: 'Tickets changed to Cancelled in the period, each counted once.' },
  reopened: { label: 'Reopened', definition: 'Tickets changed from Resolved or Closed back to Open or In progress in the period, each counted once. The rate is reopened / resolved.' },
  backlog: { label: 'Open', definition: 'Tickets Open, In progress or On-hold. "At start" and "at end" are worked out from creation, resolution, closing and cancellation dates, so a ticket reopened later may count as open at a moment it was resolved.' },
  response_rate: { label: 'Response target met', definition: 'Tickets raised in the period, by their response clock: met if answered before the target; breached if answered after it, or not answered and already past it; running if still within it. The rate is met / (met + breached) - running clocks count neither way. A response is the first public comment or status change by somebody other than the requester. Internal notes, notification emails and anything an automation writes do not count. Business time, in the SLA calendar.' },
  resolution_rate: { label: 'Resolution target met', definition: 'Tickets raised in the period, by their resolution clock: met if resolved before the target; breached if resolved after it, or unresolved and already past it; running (or paused, while On-hold with "Pause on hold" on) if still within it. The rate is met / (met + breached). Business time, with On-hold time added when "Pause on hold" is on. Cancelled tickets and tasks have no clock.' },
  first_response: { label: 'First response', definition: 'From creation to the first response, for tickets raised in the period that have one. Calendar time; business time counts only the working hours of the SLA calendar.' },
  resolution_time: { label: 'Resolution time', definition: 'From creation to resolution (or closing), for tickets raised in the period that are resolved. Calendar time; business time counts only the working hours of the SLA calendar. P90: nine in ten took no longer.' },
  aging: { label: 'Backlog age', definition: 'Open tickets now, by time since they were raised. "No change in 7 days" is the time since the ticket last changed in any way.' },
  breached: { label: 'Breached', definition: 'A ticket raised in the period with its response or resolution target missed - finished late, or still running past the target.' },
  company: { label: 'Company', definition: "The requester's company (Settings - Users)." },
  category: { label: 'Category', definition: 'The top level of the category a ticket was filed under.' },
} as const;
export type MetricKey = keyof typeof METRIC_DEFINITIONS;

/** One ticket raised in the period, for the download. */
export interface TicketDetail {
  reference: string;
  title: string;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  group: string;
  requesterName: string;
  requesterEmail: string;
  company: string;
  /** Who filled in the form: the requester, or somebody on their behalf. */
  raisedByName: string;
  raisedByEmail: string;
  assignee: string;
  createdAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  responseSla: string;
  resolutionSla: string;
}

/** A calendar day in the Locale time zone, as YYYY-MM-DD. */
function dayFormatter(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone: settings().locale.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The period asked for, clamped: at most a year, never in the future. */
export function resolvePeriod(input: ReportInput, now = new Date()): { key: string; from: Date; to: Date; problem?: string } {
  if (input.range) return { key: input.period, from: input.range.from, to: input.range.to };
  const preset = PERIODS.find((p) => p.key === input.period && p.key !== 'custom');
  if (preset) return { key: preset.key, from: new Date(now.getTime() - preset.days * DAY), to: now };
  if (input.period === 'custom') {
    const from = ISO_DAY.test(input.from ?? '') ? new Date(input.from + 'T00:00:00Z') : null;
    const to = ISO_DAY.test(input.to ?? '') ? new Date(new Date(input.to + 'T00:00:00Z').getTime() + DAY) : null;
    if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return { key: '30', from: new Date(now.getTime() - 30 * DAY), to: now, problem: 'Choose both dates.' };
    }
    if (to <= from) return { key: '30', from: new Date(now.getTime() - 30 * DAY), to: now, problem: 'The end date must be after the start date.' };
    const capped = new Date(Math.max(from.getTime(), to.getTime() - 366 * DAY));
    return { key: 'custom', from: capped, to: to > now ? now : to, ...(capped > from ? { problem: 'A report covers a year at most; the start was moved.' } : {}) };
  }
  return { key: '30', from: new Date(now.getTime() - 30 * DAY), to: now };
}

export interface ClockFigures {
  met: number;
  breached: number;
  /** Still running at the end of the period (or paused). */
  running: number;
  /** met / (met + breached), as a whole percentage; null with nothing finished. */
  rate: number | null;
}

export interface PersonFigures {
  id: string;
  name: string;
  resolved: number;
  openNow: number;
  breached: number;
  medianResolutionHours: number | null;
}

export interface CompanyFigures {
  /** The filter value: the company, NO_COMPANY, or '' for the "Other" row. */
  key: string;
  name: string;
  raised: number;
  resolved: number;
  openNow: number;
  breached: number;
  /** Of the tickets raised in the period with SLA running, the share met. */
  slaRate: number | null;
  medianResolutionHours: number | null;
}

/** Hours: how many, the median, the mean, and the 90th percentile (nearest rank). */
export interface TimeStats {
  n: number;
  median: number | null;
  mean: number | null;
  p90: number | null;
}

/** The previous period of the same length, for the comparison on every figure. */
export interface PeriodSummary {
  from: Date;
  to: Date;
  totals: Report['totals'];
  backlog: Report['backlog'];
  sla: Report['sla'];
  timing: Report['timing'];
}

export const AGE_BUCKETS = [
  { key: 'lt1', label: 'Under a day', minDays: 0, maxDays: 1 },
  { key: 'd1_7', label: '1-7 days', minDays: 1, maxDays: 7 },
  { key: 'd8_14', label: '8-14 days', minDays: 7, maxDays: 14 },
  { key: 'd15_30', label: '15-30 days', minDays: 14, maxDays: 30 },
  { key: 'gt30', label: 'Over 30 days', minDays: 30, maxDays: null },
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]['key'];
/** "No change in 7 days". */
const STALE_DAYS = 7;

export interface Report {
  groups: ReportGroup[];
  selected: string;
  scopeNames: string[];
  /** "All groups" for an administrator also takes in tickets routed to no group. */
  unrouted: boolean;
  /** Open at the start and at the end of the period (see METRIC_DEFINITIONS.backlog). */
  backlog: { start: number; end: number };
  /** Reopened / resolved, as a whole percentage; null with nothing resolved. */
  reopenRate: number | null;
  timing: { firstResponse: TimeStats; resolution: TimeStats; firstResponseBusiness: TimeStats | null; resolutionBusiness: TimeStats | null };
  /** The same figures for the period before; null for a light report. */
  previous: PeriodSummary | null;
  /** Open now, by age. Empty for a light report. */
  aging: {
    total: number;
    buckets: { key: AgeBucket; label: string; count: number }[];
    byPriority: { key: TicketPriority; counts: number[] }[];
    unassigned: number;
    onHold: number;
    stale: number;
  };
  byCategory: { key: string; name: string; raised: number; breached: number }[];
  /** Every requester company seen in these groups, for the filter. */
  companies: string[];
  company: string;
  period: { key: string; from: Date; to: Date; problem?: string };
  totals: { raised: number; resolved: number; closed: number; cancelled: number; reopened: number; backlog: number };
  sla: { enabled: boolean; response: ClockFigures; resolution: ClockFigures };
  medians: { firstResponseHours: number | null; resolutionHours: number | null };
  byPriority: { key: TicketPriority; raised: number; breached: number }[];
  byType: { key: TicketType; raised: number }[];
  byCompany: CompanyFigures[];
  daily: { day: string; raised: number; resolved: number }[];
  people: PersonFigures[] | null;
  /** Each ticket raised in the period, when asked for (details). */
  tickets: TicketDetail[] | null;
  /** More tickets were raised than were read for the SLA and timing figures. */
  capped: boolean;
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const rate = (met: number, breached: number) => (met + breached === 0 ? null : Math.round((100 * met) / (met + breached)));

/** n, median, mean and P90 (nearest rank) of some hours. Empty: all null. */
export function timeStats(values: number[]): TimeStats {
  if (values.length === 0) return { n: 0, median: null, mean: null, p90: null };
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    median: median(s),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p90: s[Math.max(0, Math.ceil(0.9 * s.length) - 1)]!,
  };
}

/** Which age bucket a ticket raised `ageDays` ago falls in. */
export function ageBucket(ageDays: number): AgeBucket {
  for (const b of AGE_BUCKETS) if (b.maxDays === null || ageDays < b.maxDays) return b.key;
  return 'gt30';
}

/** Each category's top level, by id - "Hardware" for "Hardware > Mouse". */
async function categoryRoots(): Promise<Map<string, { id: string; name: string }>> {
  const rows = await query<{ id: string; parent_id: string | null; name: string }>('SELECT id, parent_id, name FROM ticket_categories');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const roots = new Map<string, { id: string; name: string }>();
  for (const r of rows) {
    let at = r;
    for (let i = 0; i < 10 && at.parent_id && byId.has(at.parent_id); i++) at = byId.get(at.parent_id)!;
    roots.set(r.id, { id: at.id, name: at.name });
  }
  return roots;
}

/** The value of the category filter for tickets filed under none. */
export const NO_CATEGORY = '-';

/**
 * Who and what a report covers: the reader's groups (one, or all), plus -
 * for an administrator's "All groups" - tickets routed to no group, and the
 * company when one is chosen. The same WHERE clause serves the figures, the
 * lists behind them and the downloads, so they cannot disagree.
 */
export interface ReportScope {
  groups: ReportGroup[];
  selected: string;
  scope: ReportGroup[];
  unrouted: boolean;
  companies: string[];
  company: string;
  /** SQL over `tickets t`, with its parameters. */
  where: string;
  params: unknown[];
}

export async function reportScope(user: UserRow, input: ReportInput): Promise<ReportScope | null> {
  const groups = await reportGroups(user);
  if (groups.length === 0) return null;
  const selected = groups.some((g) => g.id === input.group) ? input.group : 'all';
  const scope = selected === 'all' ? groups : groups.filter((g) => g.id === selected);
  const ids = scope.map((g) => g.id);
  // Unrouted tickets belong to no group; only an administrator sees them all.
  const unrouted = selected === 'all' && user.role === 'admin';
  const groupScope = `t.parent_id IS NULL AND (t.group_id IN (${marks(ids.length)})${unrouted ? ' OR t.group_id IS NULL' : ''})`;
  // Every company these groups served, whatever the filter.
  const companies = (await query<{ company: string }>(
    `SELECT DISTINCT u.company FROM tickets t JOIN users u ON u.id = t.requester_id WHERE ${groupScope} AND u.company <> '' ORDER BY u.company`,
    ids,
  )).map((r) => r.company);
  const company = input.company === NO_COMPANY || companies.includes(input.company ?? '') ? input.company! : '';
  const companyClause = company === '' ? '' : ' AND t.requester_id IN (SELECT id FROM users WHERE company = ?)';
  return {
    groups,
    selected,
    scope,
    unrouted,
    companies,
    company,
    where: groupScope + companyClause,
    params: company === '' ? [...ids] : [...ids, company === NO_COMPANY ? '' : company],
  };
}

/** Open at a moment: raised before it, and not yet resolved, closed or cancelled by then. */
async function backlogAt(s: ReportScope, at: Date): Promise<number> {
  const t = at.toISOString();
  const row = await query<{ n: number }>(
    `SELECT count(*) AS n FROM tickets t
      WHERE ${s.where} AND t.created_at < ?
        AND (t.resolved_at IS NULL OR t.resolved_at >= ?)
        AND (t.closed_at IS NULL OR t.closed_at >= ?)
        AND NOT (t.status = 'cancelled' AND EXISTS (
          SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.kind = 'field_changed' AND e.field = 'status'
             AND e.new_value = 'cancelled' AND e.created_at < ?))`,
    [...s.params, t, t, t, t] as never[],
  );
  return Number(row[0]?.n ?? 0);
}

interface RaisedRow {
  id: string;
  requester_id: string;
  priority: TicketPriority;
  status: TicketStatus;
  type: TicketType;
  created_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  parent_id: string | null;
  assignee_id: string | null;
  category_id: string | null;
  company: string;
}

/** A status change in the period, as SQL over `tickets t` - "the ticket was cancelled in the period". */
const CANCELLED_IN = `EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.kind = 'field_changed' AND e.field = 'status'
  AND e.new_value = 'cancelled' AND e.created_at >= ? AND e.created_at < ?)`;
const REOPENED_IN = `EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.kind = 'field_changed' AND e.field = 'status'
  AND e.old_value IN ('resolved', 'closed') AND e.new_value IN ('open', 'in_progress') AND e.created_at >= ? AND e.created_at < ?)`;

/** null when the person may report on nothing. */
export async function buildReport(user: UserRow, input: ReportInput, now = new Date()): Promise<Report | null> {
  const s = await reportScope(user, input);
  if (!s) return null;
  const { groups, selected, scope, companies, company } = s;
  const light = Boolean(input.range);
  const period = resolvePeriod(input, now);
  const from = period.from.toISOString();
  const to = period.to.toISOString();
  const inScope = s.where;
  const scopeParams = s.params;

  const count = async (where: string, params: unknown[]) =>
    Number((await query<{ n: number }>(`SELECT count(*) AS n FROM tickets t WHERE ${inScope} AND ${where}`, [...scopeParams, ...params] as never[]))[0]?.n ?? 0);

  // Cancelled and reopened count tickets, not events: a ticket cancelled,
  // restored and cancelled again in one period is one cancelled ticket.
  const totals = {
    raised: await count('t.created_at >= ? AND t.created_at < ?', [from, to]),
    resolved: await count('t.resolved_at >= ? AND t.resolved_at < ?', [from, to]),
    closed: await count('t.closed_at >= ? AND t.closed_at < ?', [from, to]),
    cancelled: await count(CANCELLED_IN, [from, to]),
    reopened: await count(REOPENED_IN, [from, to]),
    backlog: await count("t.status IN ('open', 'in_progress', 'pending')", []),
  };
  const backlog = { start: await backlogAt(s, period.from), end: await backlogAt(s, period.to) };

  // The tickets raised in the period: SLA, timings, priority, type, company.
  const raised = await query<RaisedRow>(
    `SELECT t.id, t.requester_id, t.priority, t.status, t.type, t.created_at, t.resolved_at, t.closed_at, t.parent_id, t.assignee_id,
            t.category_id, COALESCE(u.company, '') AS company
       FROM tickets t LEFT JOIN users u ON u.id = t.requester_id
      WHERE ${inScope} AND t.created_at >= ? AND t.created_at < ?
      ORDER BY t.created_at DESC LIMIT ${REPORT_CAP + 1}`,
    [...scopeParams, from, to] as never[],
  );
  const capped = raised.length > REPORT_CAP;
  const sample = raised.slice(0, REPORT_CAP);

  const slaOn = settings().sla.enabled;
  const facts = await slaFacts(sample);
  const response: ClockFigures = { met: 0, breached: 0, running: 0, rate: null };
  const resolution: ClockFigures = { met: 0, breached: 0, running: 0, rate: null };
  const firstResponses: number[] = [];
  const resolutions: number[] = [];
  const priorityBreaches = new Map<string, number>();
  const breachesByAssignee = new Map<string, number>();
  const perCompany = new Map<string, { raised: number; breached: number; met: number; hours: number[] }>();
  const slaById = new Map<string, { response: string; resolution: string }>();
  const companyOf = (c: string) => (c === '' ? NO_COMPANY : c);
  const cal = settings().sla;
  const firstResponsesBusiness: number[] = [];
  const resolutionsBusiness: number[] = [];
  const roots = light ? new Map<string, { id: string; name: string }>() : await categoryRoots();
  const categoryBreaches = new Map<string, number>();
  const rootOf = (t: RaisedRow) => (t.category_id && roots.get(t.category_id)?.id) || NO_CATEGORY;

  for (const t of sample) {
    const created = new Date(t.created_at).getTime();
    const done = t.resolved_at ?? t.closed_at;
    const pc = perCompany.get(companyOf(t.company)) ?? { raised: 0, breached: 0, met: 0, hours: [] };
    pc.raised += 1;
    if (done) {
      const hours = (new Date(done).getTime() - created) / 3_600_000;
      resolutions.push(hours);
      pc.hours.push(hours);
      if (slaOn) resolutionsBusiness.push(businessMinutesBetween(new Date(created), new Date(done), cal) / 60);
    }
    const f = facts.get(t.id)!;
    const sla = slaOn ? slaFromFacts(t, f.responded, f.changes, now) : null;
    const responded = sla ? sla.response.doneAt : f.responded;
    if (responded) {
      firstResponses.push((responded.getTime() - created) / 3_600_000);
      if (slaOn) firstResponsesBusiness.push(businessMinutesBetween(new Date(created), responded, cal) / 60);
    }
    if (sla) {
      slaById.set(t.id, { response: sla.response.state, resolution: sla.resolution.state });
      for (const [clock, figures] of [[sla.response, response], [sla.resolution, resolution]] as const) {
        if (clock.state === 'breached') figures.breached += 1;
        else if (clock.state === 'met') figures.met += 1;
        else figures.running += 1;
      }
      const breached = sla.response.state === 'breached' || sla.resolution.state === 'breached';
      if (breached) {
        pc.breached += 1;
        priorityBreaches.set(t.priority, (priorityBreaches.get(t.priority) ?? 0) + 1);
        categoryBreaches.set(rootOf(t), (categoryBreaches.get(rootOf(t)) ?? 0) + 1);
        if (t.assignee_id) breachesByAssignee.set(t.assignee_id, (breachesByAssignee.get(t.assignee_id) ?? 0) + 1);
      } else if (sla.response.state === 'met' && sla.resolution.state === 'met') {
        pc.met += 1;
      }
    }
    perCompany.set(companyOf(t.company), pc);
  }
  response.rate = rate(response.met, response.breached);
  resolution.rate = rate(resolution.met, resolution.breached);

  const byPriority = TICKET_PRIORITIES.map((key) => ({
    key,
    raised: raised.filter((t) => t.priority === key).length,
    breached: priorityBreaches.get(key) ?? 0,
  }));
  const byType = TICKET_TYPES.filter((k) => k !== 'task').map((key) => ({ key, raised: raised.filter((t) => t.type === key).length }));

  const timing = {
    firstResponse: timeStats(firstResponses),
    resolution: timeStats(resolutions),
    firstResponseBusiness: slaOn ? timeStats(firstResponsesBusiness) : null,
    resolutionBusiness: slaOn ? timeStats(resolutionsBusiness) : null,
  };
  const reopenRate = totals.resolved === 0 ? null : Math.round((100 * totals.reopened) / totals.resolved);
  const slaFigures = { enabled: slaOn, response, resolution };

  // The previous period is read for its headline figures only.
  if (light) {
    return {
      groups, selected, scopeNames: scope.map((g) => g.name), unrouted: s.unrouted, companies, company, period, totals, backlog, reopenRate,
      sla: slaFigures, timing, previous: null,
      aging: { total: 0, buckets: [], byPriority: [], unassigned: 0, onHold: 0, stale: 0 },
      byCategory: [],
      medians: { firstResponseHours: timing.firstResponse.median, resolutionHours: timing.resolution.median },
      byPriority, byType, byCompany: [], daily: [], people: null, tickets: null, capped,
    };
  }

  // By category: the top level each ticket was filed under.
  const perCategory = new Map<string, number>();
  for (const t of raised) perCategory.set(rootOf(t), (perCategory.get(rootOf(t)) ?? 0) + 1);
  const rootNames = new Map([...roots.values()].map((r) => [r.id, r.name]));
  const byCategory = [...perCategory.entries()]
    .map(([key, n]) => ({ key, name: key === NO_CATEGORY ? words()('No category') : rootNames.get(key) ?? words()('Removed category'), raised: n, breached: categoryBreaches.get(key) ?? 0 }))
    .sort((a, b) => b.raised - a.raised || a.name.localeCompare(b.name));

  // Open now, by age.
  const openRows = await query<{ priority: TicketPriority; status: TicketStatus; created_at: string; updated_at: string; assignee_id: string | null }>(
    `SELECT t.priority, t.status, t.created_at, t.updated_at, t.assignee_id FROM tickets t
      WHERE ${inScope} AND t.status IN ('open', 'in_progress', 'pending')`,
    scopeParams as never[],
  );
  const bucketIndex = new Map(AGE_BUCKETS.map((b, i) => [b.key, i]));
  const agingByPriority = TICKET_PRIORITIES.map((key) => ({ key, counts: AGE_BUCKETS.map(() => 0) }));
  const bucketCounts = AGE_BUCKETS.map(() => 0);
  const staleBefore = now.getTime() - STALE_DAYS * DAY;
  for (const o of openRows) {
    const i = bucketIndex.get(ageBucket((now.getTime() - new Date(o.created_at).getTime()) / DAY))!;
    bucketCounts[i]! += 1;
    agingByPriority.find((p) => p.key === o.priority)!.counts[i]! += 1;
  }
  const aging = {
    total: openRows.length,
    buckets: AGE_BUCKETS.map((b, i) => ({ key: b.key, label: b.label, count: bucketCounts[i]! })),
    byPriority: agingByPriority.reverse(),
    unassigned: openRows.filter((o) => !o.assignee_id).length,
    onHold: openRows.filter((o) => o.status === 'pending').length,
    stale: openRows.filter((o) => new Date(o.updated_at).getTime() < staleBefore).length,
  };

  // The period before, of the same length, with the same scope.
  const length = period.to.getTime() - period.from.getTime();
  const before = await buildReport(user, { ...input, details: false, range: { from: new Date(period.from.getTime() - length), to: period.from } }, now);
  const previous: PeriodSummary | null = before
    ? { from: before.period.from, to: before.period.to, totals: before.totals, backlog: before.backlog, sla: before.sla, timing: before.timing }
    : null;

  // Companies side by side: resolved in the period and open now, by company.
  const grouped = async (where: string, params: unknown[]) => new Map(
    (await query<{ company: string; n: number }>(
      `SELECT COALESCE(u.company, '') AS company, count(*) AS n FROM tickets t LEFT JOIN users u ON u.id = t.requester_id
        WHERE ${inScope} AND ${where} GROUP BY COALESCE(u.company, '')`,
      [...scopeParams, ...params] as never[],
    )).map((r) => [companyOf(r.company), Number(r.n)]),
  );
  const resolvedBy = await grouped('t.resolved_at >= ? AND t.resolved_at < ?', [from, to]);
  const openBy = await grouped("t.status IN ('open', 'in_progress', 'pending')", []);
  const keys = new Set([...perCompany.keys(), ...resolvedBy.keys(), ...openBy.keys()]);
  let byCompany: CompanyFigures[] = [...keys].map((key) => {
    const pc = perCompany.get(key) ?? { raised: 0, breached: 0, met: 0, hours: [] };
    return {
      key,
      name: key === NO_COMPANY ? words()('No company') : key,
      raised: pc.raised,
      resolved: resolvedBy.get(key) ?? 0,
      openNow: openBy.get(key) ?? 0,
      breached: pc.breached,
      slaRate: rate(pc.met, pc.breached),
      medianResolutionHours: median(pc.hours),
    };
  }).sort((a, b) => b.raised - a.raised || b.openNow - a.openNow || a.name.localeCompare(b.name));
  if (byCompany.length > COMPANY_ROWS) {
    const rest = byCompany.slice(COMPANY_ROWS - 1);
    byCompany = [...byCompany.slice(0, COMPANY_ROWS - 1), {
      key: '', name: rest.length + ' other companies',
      raised: rest.reduce((n, c) => n + c.raised, 0),
      resolved: rest.reduce((n, c) => n + c.resolved, 0),
      openNow: rest.reduce((n, c) => n + c.openNow, 0),
      breached: rest.reduce((n, c) => n + c.breached, 0),
      slaRate: null,
      medianResolutionHours: null,
    }];
  }

  // Day by day, in the Locale time zone.
  const fmt = dayFormatter();
  const dayOf = (d: Date) => fmt.format(d);
  const resolvedRows = await query<{ resolved_at: string }>(
    `SELECT t.resolved_at FROM tickets t WHERE ${inScope} AND t.resolved_at >= ? AND t.resolved_at < ?`,
    [...scopeParams, from, to] as never[],
  );
  const days: string[] = [];
  for (let at = period.from.getTime(); at < period.to.getTime(); at += DAY) days.push(dayOf(new Date(at)));
  days.push(dayOf(new Date(period.to.getTime() - 1)));
  const raisedByDay = new Map<string, number>();
  for (const t of raised) {
    const d = dayOf(new Date(t.created_at));
    raisedByDay.set(d, (raisedByDay.get(d) ?? 0) + 1);
  }
  const resolvedByDay = new Map<string, number>();
  for (const r of resolvedRows) {
    const d = dayOf(new Date(r.resolved_at));
    resolvedByDay.set(d, (resolvedByDay.get(d) ?? 0) + 1);
  }
  const daily = [...new Set(days)].map((day) => ({ day, raised: raisedByDay.get(day) ?? 0, resolved: resolvedByDay.get(day) ?? 0 }));

  // People: only for groups this reader manages (or an administrator).
  let people: PersonFigures[] | null = null;
  if (scope.every((g) => g.manages)) {
    const rows = await query<{ id: string; name: string; resolved_at: string | null; created_at: string; status: TicketStatus; in_period: number }>(
      `SELECT u.id, u.display_name AS name, t.resolved_at, t.created_at, t.status,
              CASE WHEN t.resolved_at >= ? AND t.resolved_at < ? THEN 1 ELSE 0 END AS in_period
         FROM tickets t JOIN users u ON u.id = t.assignee_id
        WHERE ${inScope} AND ((t.resolved_at >= ? AND t.resolved_at < ?) OR t.status IN ('open', 'in_progress', 'pending'))`,
      [from, to, ...scopeParams, from, to] as never[],
    );
    const map = new Map<string, PersonFigures & { hours: number[] }>();
    for (const r of rows) {
      const p = map.get(r.id) ?? { id: r.id, name: r.name, resolved: 0, openNow: 0, breached: breachesByAssignee.get(r.id) ?? 0, medianResolutionHours: null, hours: [] };
      if (Number(r.in_period) === 1 && r.resolved_at) {
        p.resolved += 1;
        p.hours.push((new Date(r.resolved_at).getTime() - new Date(r.created_at).getTime()) / 3_600_000);
      }
      if (['open', 'in_progress', 'pending'].includes(r.status)) p.openNow += 1;
      map.set(r.id, p);
    }
    people = [...map.values()]
      .map(({ hours, ...p }) => ({ ...p, medianResolutionHours: median(hours) }))
      .sort((a, b) => b.resolved - a.resolved || a.name.localeCompare(b.name));
  }

  // Each ticket, only when asked: the download's Tickets sheet.
  let tickets: TicketDetail[] | null = null;
  if (input.details) {
    const rows = await query<{
      id: string; ref_prefix: string; ref_seq: number; title: string; type: TicketType; priority: TicketPriority; status: TicketStatus;
      group_name: string | null; requester_name: string; requester_email: string; company: string; external_email: string;
      raised_name: string | null; raised_email: string | null; assignee_name: string | null;
      created_at: string; resolved_at: string | null; closed_at: string | null;
    }>(
      `SELECT t.id, t.ref_prefix, t.ref_seq, t.title, t.type, t.priority, t.status, g.name AS group_name,
              r.display_name AS requester_name, r.email AS requester_email, COALESCE(r.company, '') AS company, t.external_email,
              rb.display_name AS raised_name, rb.email AS raised_email, a.display_name AS assignee_name,
              t.created_at, t.resolved_at, t.closed_at
         FROM tickets t
         JOIN users r ON r.id = t.requester_id
         LEFT JOIN users rb ON rb.id = t.raised_by
         LEFT JOIN users a ON a.id = t.assignee_id
         LEFT JOIN technician_groups g ON g.id = t.group_id
        WHERE ${inScope} AND t.created_at >= ? AND t.created_at < ?
        ORDER BY t.created_at DESC LIMIT ${REPORT_CAP}`,
      [...scopeParams, from, to] as never[],
    );
    const word = (state: string | undefined) =>
      state === 'met' ? 'Met' : state === 'breached' ? 'Breached' : state === 'paused' ? 'Paused' : state ? 'Running' : '';
    tickets = rows.map((t) => ({
      reference: ticketReference(Number(t.ref_seq), t.ref_prefix),
      title: t.title,
      type: t.type,
      priority: t.priority,
      status: t.status,
      group: t.group_name ?? '',
      // Mail from a stranger: the hidden account is the requester; the address is who it was.
      requesterName: t.external_email || t.requester_name,
      requesterEmail: t.external_email || t.requester_email,
      company: t.company,
      raisedByName: t.raised_name ?? (t.external_email || t.requester_name),
      raisedByEmail: t.raised_email ?? (t.external_email || t.requester_email),
      assignee: t.assignee_name ?? '',
      createdAt: t.created_at,
      resolvedAt: t.resolved_at,
      closedAt: t.closed_at,
      responseSla: word(slaById.get(t.id)?.response),
      resolutionSla: word(slaById.get(t.id)?.resolution),
    }));
  }

  return {
    groups,
    selected,
    scopeNames: scope.map((g) => g.name),
    unrouted: s.unrouted,
    companies,
    company,
    period,
    totals,
    backlog,
    reopenRate,
    sla: slaFigures,
    timing,
    previous,
    aging,
    byCategory,
    medians: { firstResponseHours: timing.firstResponse.median, resolutionHours: timing.resolution.median },
    byPriority,
    byType,
    byCompany,
    daily,
    people,
    tickets,
    capped,
  };
}

// ---------------------------------------------------------------------------
// The tickets behind a figure (/reports/tickets)
// ---------------------------------------------------------------------------

export const DRILL_METRICS = {
  raised: { label: 'Raised', definition: 'raised' },
  resolved: { label: 'Resolved', definition: 'resolved' },
  closed: { label: 'Closed', definition: 'closed' },
  cancelled: { label: 'Cancelled', definition: 'cancelled' },
  reopened: { label: 'Reopened', definition: 'reopened' },
  open: { label: 'Open now', definition: 'backlog' },
  unassigned: { label: 'Open and unassigned', definition: 'aging' },
  on_hold: { label: 'On hold', definition: 'aging' },
  stale: { label: 'No change in 7 days', definition: 'aging' },
  breached: { label: 'Service level breached', definition: 'breached' },
  response_breached: { label: 'Response target breached', definition: 'response_rate' },
  resolution_breached: { label: 'Resolution target breached', definition: 'resolution_rate' },
  response_met: { label: 'Response target met', definition: 'response_rate' },
  resolution_met: { label: 'Resolution target met', definition: 'resolution_rate' },
} as const satisfies Record<string, { label: string; definition: MetricKey }>;
export type DrillMetric = keyof typeof DRILL_METRICS;
export const isDrillMetric = (v: string): v is DrillMetric => Object.prototype.hasOwnProperty.call(DRILL_METRICS, v);

export interface DrillFilter {
  metric: DrillMetric;
  priority?: string;
  type?: string;
  /** A top-level category id, or NO_CATEGORY. */
  category?: string;
  /** An AGE_BUCKETS key; with the open-ticket lists. */
  bucket?: string;
  page?: number;
  /** Excel-like column filters (DRILL_COLUMNS, lib/column-filters.ts). */
  columns?: ColumnFilters;
  /** A DRILL_SORTS key; newest first when absent. */
  sort?: string;
  dir?: 'asc' | 'desc';
}

/** Column filters on a figure's tickets: the stored value each header filters on. */
export const DRILL_COLUMNS: Record<string, string> = {
  status: 't.status',
  priority: 't.priority',
  group: 't.group_id',
  assignee: 't.assignee_id',
  company: "coalesce(r.company, '')",
};
const DRILL_LABELS: Record<string, string> = { group: 'max(g.name)', assignee: 'max(a.display_name)' };
export const DRILL_SORTS: Record<string, string> = {
  ticket: 'lower(t.title)',
  status: 't.status',
  priority: "CASE t.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END",
  group: "lower(coalesce(g.name, ''))",
  assignee: "lower(coalesce(a.display_name, ''))",
  company: "lower(coalesce(r.company, ''))",
  raised: 't.created_at',
  resolved: 't.resolved_at',
};
const DRILL_FROM = ' FROM tickets t JOIN users r ON r.id = t.requester_id LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN technician_groups g ON g.id = t.group_id';

export interface DrillRow {
  id: string;
  reference: string;
  title: string;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  group: string;
  assignee: string;
  requester: string;
  company: string;
  createdAt: string;
  resolvedAt: string | null;
  updatedAt: string;
  /** Why it is on the list, when that is not obvious: for a breach, which target, when it was due and how late. */
  detail: string;
}

export interface DrillList {
  title: string;
  definition: string;
  /** Filters applied besides the report's own, in words. */
  narrowed: string[];
  /** The group filter as resolved: one the reader may not see is "all". */
  selected: string;
  scopeNames: string[];
  unrouted: boolean;
  company: string;
  period: Report['period'];
  total: number;
  page: number;
  pages: number;
  rows: DrillRow[];
  /** The service-level lists read the same first REPORT_CAP tickets as the report. */
  capped: boolean;
  /** Each header's values for its menu, and what is ticked. */
  columnMenus: Record<string, { values: ColumnValue[]; selected: string[] }>;
}

const DRILL_PAGE = 50;
const SLA_METRICS: readonly DrillMetric[] = ['breached', 'response_breached', 'resolution_breached', 'response_met', 'resolution_met'];


/**
 * The tickets that make up one figure of a report: the same scope, period
 * and company (reportScope), the same definitions, and for the service-level
 * figures the same clocks over the same tickets - so the count at the top
 * of the list is the number on the report. null when the reader may report
 * on nothing.
 */
export async function reportTickets(user: UserRow, input: ReportInput, filter: DrillFilter, now = new Date()): Promise<DrillList | null> {
  const s = await reportScope(user, input);
  if (!s) return null;
  const period = resolvePeriod(input, now);
  const from = period.from.toISOString();
  const to = period.to.toISOString();
  const where: string[] = [s.where];
  const params: unknown[] = [...s.params];
  const narrowed: string[] = [];

  if (filter.priority && (TICKET_PRIORITIES as readonly string[]).includes(filter.priority)) {
    where.push('t.priority = ?');
    params.push(filter.priority);
    narrowed.push('Priority: ' + filter.priority);
  }
  if (filter.type && (TICKET_TYPES as readonly string[]).includes(filter.type)) {
    where.push('t.type = ?');
    params.push(filter.type);
    narrowed.push('Type: ' + filter.type.replace('_', ' '));
  }
  if (filter.category) {
    if (filter.category === NO_CATEGORY) {
      where.push('(t.category_id IS NULL OR NOT EXISTS (SELECT 1 FROM ticket_categories c WHERE c.id = t.category_id))');
      narrowed.push('No category');
    } else {
      const roots = await categoryRoots();
      const ids = [...roots.entries()].filter(([, r]) => r.id === filter.category).map(([id]) => id);
      where.push(ids.length ? `t.category_id IN (${marks(ids.length)})` : '1 = 0');
      params.push(...ids);
      narrowed.push('Category: ' + (roots.get(filter.category)?.name ?? 'removed'));
    }
  }

  const metric = filter.metric;
  const open = "t.status IN ('open', 'in_progress', 'pending')";
  switch (metric) {
    case 'raised': where.push('t.created_at >= ? AND t.created_at < ?'); params.push(from, to); break;
    case 'resolved': where.push('t.resolved_at >= ? AND t.resolved_at < ?'); params.push(from, to); break;
    case 'closed': where.push('t.closed_at >= ? AND t.closed_at < ?'); params.push(from, to); break;
    case 'cancelled': where.push(CANCELLED_IN); params.push(from, to); break;
    case 'reopened': where.push(REOPENED_IN); params.push(from, to); break;
    case 'open': where.push(open); break;
    case 'unassigned': where.push(open, 't.assignee_id IS NULL'); break;
    case 'on_hold': where.push("t.status = 'pending'"); break;
    case 'stale': where.push(open, 't.updated_at < ?'); params.push(new Date(now.getTime() - STALE_DAYS * DAY).toISOString()); break;
    default: where.push('t.created_at >= ? AND t.created_at < ?'); params.push(from, to); // the service-level lists: raised in the period
  }
  const bucket = AGE_BUCKETS.find((b) => b.key === filter.bucket);
  if (bucket && ['open', 'unassigned', 'on_hold', 'stale'].includes(metric)) {
    // Age in [minDays, maxDays): raised at or before now - minDays, after now - maxDays.
    where.push('t.created_at <= ?');
    params.push(new Date(now.getTime() - bucket.minDays * DAY).toISOString());
    if (bucket.maxDays !== null) {
      where.push('t.created_at > ?');
      params.push(new Date(now.getTime() - bucket.maxDays * DAY).toISOString());
    }
    narrowed.push('Raised ' + bucket.label.toLowerCase() + ' ago');
  }
  const whereSql = where.join(' AND ');

  const page = Math.max(1, Math.floor(filter.page ?? 1));
  let total: number;
  let ids: string[];
  const details = new Map<string, string>();
  let capped = false;
  let base: { sql: string; params: unknown[] };

  if (SLA_METRICS.includes(metric)) {
    // The same tickets and clocks as the report's figures.
    const rows = await query<RaisedRow>(
      `SELECT t.id, t.requester_id, t.priority, t.status, t.type, t.created_at, t.resolved_at, t.closed_at, t.parent_id, t.assignee_id,
              t.category_id, '' AS company
         FROM tickets t WHERE ${whereSql} ORDER BY t.created_at DESC LIMIT ${REPORT_CAP + 1}`,
      params as never[],
    );
    capped = rows.length > REPORT_CAP;
    const sample = rows.slice(0, REPORT_CAP);
    const facts = await slaFacts(sample);
    const cal = settings().sla;
    const fmt = { at: formatDateTime, span: formatDuration };
    const explain = (name: string, clock: TicketSla['response'], doneWord: string) => {
      if (clock.state === 'breached') {
        const late = businessMinutesBetween(clock.due, clock.doneAt ?? now, cal) * 60_000;
        return `${name} due ${fmt.at(clock.due)}; ${clock.doneAt ? doneWord + ' ' + fmt.at(clock.doneAt) : 'still open'} - ${fmt.span(late)} late in business time`;
      }
      if (clock.state === 'met' && clock.doneAt) {
        const spare = businessMinutesBetween(clock.doneAt, clock.due, cal) * 60_000;
        return `${name} due ${fmt.at(clock.due)}; ${doneWord} ${fmt.at(clock.doneAt)} - ${fmt.span(spare)} to spare`;
      }
      return '';
    };
    const picked: string[] = [];
    if (cal.enabled) {
      for (const t of sample) {
        const f = facts.get(t.id)!;
        const sla = slaFromFacts(t, f.responded, f.changes, now);
        if (!sla) continue;
        const r = sla.response.state, z = sla.resolution.state;
        const hit =
          metric === 'breached' ? r === 'breached' || z === 'breached'
          : metric === 'response_breached' ? r === 'breached'
          : metric === 'resolution_breached' ? z === 'breached'
          : metric === 'response_met' ? r === 'met'
          : z === 'met';
        if (!hit) continue;
        picked.push(t.id);
        const lines = metric.startsWith('response')
          ? [explain('Response', sla.response, 'answered')]
          : metric.startsWith('resolution')
            ? [explain('Resolution', sla.resolution, 'resolved')]
            : [r === 'breached' ? explain('Response', sla.response, 'answered') : '', z === 'breached' ? explain('Resolution', sla.resolution, 'resolved') : ''];
        details.set(t.id, lines.filter(Boolean).join('. '));
      }
    }
    base = { sql: picked.length ? `t.id IN (${marks(picked.length)})` : '1 = 0', params: picked };
  } else {
    base = { sql: whereSql, params };
  }

  // Column filters and sorting, in SQL for both kinds of list: the
  // service-level ones hand over the tickets their clocks picked.
  const narrowedBy = (cols: ColumnFilters) => {
    const cf = columnClauses(cols, DRILL_COLUMNS);
    return { sql: [base.sql, ...cf.where].join(' AND '), params: [...base.params, ...cf.params] };
  };
  const current = narrowedBy(filter.columns ?? {});
  total = Number((await query<{ n: number }>('SELECT count(*) AS n' + DRILL_FROM + ' WHERE ' + current.sql, current.params as never[]))[0]?.n ?? 0);
  const order = filter.sort && DRILL_SORTS[filter.sort]
    ? DRILL_SORTS[filter.sort] + (filter.dir === 'desc' ? ' DESC' : ' ASC') + ', t.created_at DESC'
    : 't.created_at DESC';
  ids = (await query<{ id: string }>(
    'SELECT t.id' + DRILL_FROM + ' WHERE ' + current.sql + ' ORDER BY ' + order + ', t.id LIMIT ' + DRILL_PAGE + ' OFFSET ' + (page - 1) * DRILL_PAGE,
    current.params as never[],
  )).map((r) => r.id);
  const columnMenus: Record<string, { values: ColumnValue[]; selected: string[] }> = {};
  for (const [key, expr] of Object.entries(DRILL_COLUMNS)) {
    const other = narrowedBy(withoutColumn(filter.columns ?? {}, key));
    const label = DRILL_LABELS[key] ?? 'max(' + expr + ')';
    const found = await query<{ v: string | null; label: string | null; n: number }>(
      'SELECT ' + expr + ' AS v, ' + label + ' AS label, count(*) AS n' + DRILL_FROM + ' WHERE ' + other.sql + ' GROUP BY ' + expr + ' ORDER BY n DESC LIMIT ' + MAX_VALUES,
      other.params as never[],
    );
    const blank = key === 'group' ? 'Unrouted' : key === 'assignee' ? 'Unassigned' : key === 'company' ? 'No company' : '';
    const values = found.map((r) => ({ value: r.v ?? BLANK, label: r.v ? (r.label ?? r.v) : blank, count: Number(r.n) }));
    const selected = filter.columns?.[key] ?? [];
    columnMenus[key] = { values: menuValues(values, selected, (v) => (v === BLANK ? blank : v)), selected };
  }

  const found = ids.length === 0 ? [] : await query<{
    id: string; ref_prefix: string; ref_seq: number; title: string; type: TicketType; priority: TicketPriority; status: TicketStatus;
    created_at: string; resolved_at: string | null; updated_at: string; external_email: string;
    group_name: string | null; assignee_name: string | null; requester_name: string; company: string;
  }>(
    `SELECT t.id, t.ref_prefix, t.ref_seq, t.title, t.type, t.priority, t.status, t.created_at, t.resolved_at, t.updated_at, t.external_email,
            g.name AS group_name, a.display_name AS assignee_name, r.display_name AS requester_name, COALESCE(r.company, '') AS company
       FROM tickets t
       JOIN users r ON r.id = t.requester_id
       LEFT JOIN users a ON a.id = t.assignee_id
       LEFT JOIN technician_groups g ON g.id = t.group_id
      WHERE t.id IN (${marks(ids.length)})`,
    ids,
  );
  const byId = new Map(found.map((t) => [t.id, t]));
  const rows: DrillRow[] = ids.map((id) => byId.get(id)).filter((t) => t !== undefined).map((t) => ({
    id: t.id,
    reference: ticketReference(Number(t.ref_seq), t.ref_prefix),
    title: t.title,
    type: t.type,
    priority: t.priority,
    status: t.status,
    group: t.group_name ?? 'Unrouted',
    assignee: t.assignee_name ?? '',
    requester: t.external_email || t.requester_name,
    company: t.company,
    createdAt: t.created_at,
    resolvedAt: t.resolved_at,
    updatedAt: t.updated_at,
    detail: details.get(t.id) ?? '',
  }));

  const spec = DRILL_METRICS[metric];
  return {
    title: spec.label,
    definition: METRIC_DEFINITIONS[spec.definition].definition,
    narrowed,
    selected: s.selected,
    scopeNames: s.scope.map((g) => g.name),
    unrouted: s.unrouted,
    company: s.company,
    period,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / DRILL_PAGE)),
    rows,
    capped,
    columnMenus,
  };
}

/** Hours, as a person reads them: "45 m", "6.5 h", "3.2 days". */
export function readableHours(hours: number | null): string {
  if (hours === null) return '-';
  if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' m';
  if (hours < 48) return (Math.round(hours * 10) / 10) + ' h';
  return (Math.round((hours / 24) * 10) / 10) + ' days';
}

/** The report as CSV: a summary, then the breakdowns, then people when shown. */
export function reportCsv(r: Report, labels: { priority: Record<string, string>; type: Record<string, string> }): string {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    // A leading =, +, - or @ would be a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
    return /[",\n;]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };
  const line = (...v: unknown[]) => v.map(cell).join(',');
  const hours = (h: number | null) => (h === null ? '' : h.toFixed(2));
  const out = [
    line('Report', r.scopeNames.join(' + ')),
    line('Company', r.company === '' ? 'All' : r.company === NO_COMPANY ? 'No company' : r.company),
    line('From', r.period.from.toISOString()),
    line('To', r.period.to.toISOString()),
    '',
    line('Figure', 'Value'),
    line('Raised', r.totals.raised),
    line('Resolved', r.totals.resolved),
    line('Closed', r.totals.closed),
    line('Cancelled', r.totals.cancelled),
    line('Reopened', r.totals.reopened),
    line('Open now', r.totals.backlog),
    line('Median first response (hours)', hours(r.medians.firstResponseHours)),
    line('Median resolution (hours)', hours(r.medians.resolutionHours)),
  ];
  if (r.sla.enabled) {
    out.push(
      line('Response target met', r.sla.response.met),
      line('Response target breached', r.sla.response.breached),
      line('Resolution target met', r.sla.resolution.met),
      line('Resolution target breached', r.sla.resolution.breached),
    );
  }
  out.push('', line('Company', 'Raised', 'Resolved', 'Open now', 'SLA breached', 'SLA met %', 'Median resolution (hours)'),
    ...r.byCompany.map((c) => line(c.name, c.raised, c.resolved, c.openNow, c.breached, c.slaRate ?? '', hours(c.medianResolutionHours))));
  out.push('', line('Priority', 'Raised', 'Breached'), ...r.byPriority.map((p) => line(labels.priority[p.key], p.raised, p.breached)));
  out.push('', line('Type', 'Raised'), ...r.byType.map((t) => line(labels.type[t.key], t.raised)));
  out.push('', line('Day', 'Raised', 'Resolved'), ...r.daily.map((d) => line(d.day, d.raised, d.resolved)));
  if (r.people) {
    out.push('', line('Technician', 'Resolved', 'Open now', 'SLA breached', 'Median resolution (hours)'),
      ...r.people.map((p) => line(p.name, p.resolved, p.openNow, p.breached, hours(p.medianResolutionHours))));
  }
  return '﻿' + out.join('\r\n') + '\r\n';
}

/**
 * The report as a styled Excel workbook: Summary, By company, Priority and
 * type, Day by day, Technicians (when shown) and Tickets (when asked for).
 * Real numbers, dates and percentages, so they sort and sum in Excel.
 */
export function reportWorkbook(
  r: Report,
  labels: { priority: Record<string, string>; type: Record<string, string>; status: Record<string, string> },
  brandColour: string,
): Buffer {
  const scope = r.scopeNames.join(', ') + (r.company ? ' - ' + (r.company === NO_COMPANY ? 'No company' : r.company) : '');
  const when = r.period.from.toISOString().slice(0, 10) + ' to ' + new Date(r.period.to.getTime() - 1).toISOString().slice(0, 10);
  const pct = (v: number | null) => (v === null ? '' : v / 100);
  const hours = (h: number | null) => (h === null ? '' : Math.round(h * 100) / 100);
  const p = r.previous;
  const prevWhen = p ? p.from.toISOString().slice(0, 10) + ' to ' + new Date(p.to.getTime() - 1).toISOString().slice(0, 10) : '';
  // [figure, this period, previous period]
  const summary: unknown[][] = [
    ['Raised', r.totals.raised, p?.totals.raised ?? ''],
    ['Resolved', r.totals.resolved, p?.totals.resolved ?? ''],
    ['Closed', r.totals.closed, p?.totals.closed ?? ''],
    ['Cancelled', r.totals.cancelled, p?.totals.cancelled ?? ''],
    ['Reopened', r.totals.reopened, p?.totals.reopened ?? ''],
    ['Open at start', r.backlog.start, p?.backlog.start ?? ''],
    ['Open at end', r.backlog.end, p?.backlog.end ?? ''],
    ['Open now', r.totals.backlog, ''],
    ['First response, median (hours)', hours(r.timing.firstResponse.median), hours(p?.timing.firstResponse.median ?? null)],
    ['First response, P90 (hours)', hours(r.timing.firstResponse.p90), hours(p?.timing.firstResponse.p90 ?? null)],
    ['Resolution, median (hours)', hours(r.timing.resolution.median), hours(p?.timing.resolution.median ?? null)],
    ['Resolution, average (hours)', hours(r.timing.resolution.mean), hours(p?.timing.resolution.mean ?? null)],
    ['Resolution, P90 (hours)', hours(r.timing.resolution.p90), hours(p?.timing.resolution.p90 ?? null)],
    ...(r.timing.resolutionBusiness
      ? [
          ['First response, median (business hours)', hours(r.timing.firstResponseBusiness?.median ?? null), hours(p?.timing.firstResponseBusiness?.median ?? null)],
          ['Resolution, median (business hours)', hours(r.timing.resolutionBusiness.median), hours(p?.timing.resolutionBusiness?.median ?? null)],
        ]
      : []),
    ...(r.sla.enabled
      ? [
          ['Response target met (%)', r.sla.response.rate ?? '', p?.sla.response.rate ?? ''],
          ['Response target met', r.sla.response.met, p?.sla.response.met ?? ''],
          ['Response target breached', r.sla.response.breached, p?.sla.response.breached ?? ''],
          ['Resolution target met (%)', r.sla.resolution.rate ?? '', p?.sla.resolution.rate ?? ''],
          ['Resolution target met', r.sla.resolution.met, p?.sla.resolution.met ?? ''],
          ['Resolution target breached', r.sla.resolution.breached, p?.sla.resolution.breached ?? ''],
        ]
      : [['Service levels', 'Off', '']]),
  ];
  const sheets: Sheet[] = [
    {
      name: 'Summary',
      title: 'Report - ' + scope,
      notes: [
        when + (p ? ' (previous period: ' + prevWhen + ')' : ''),
        ...(r.unrouted ? ['Includes tickets routed to no group.'] : []),
        ...(r.capped ? ['The first ' + REPORT_CAP + ' tickets raised were read for the service-level and timing figures.'] : []),
        'Each figure is defined on the Definitions sheet.',
      ],
      columns: [{ header: 'Figure', width: 40 }, { header: 'This period', width: 16, type: 'decimal' }, { header: 'Previous period', width: 16, type: 'decimal' }],
      rows: summary as never,
    },
    {
      name: 'Backlog age',
      title: 'Open now, by age',
      notes: ['Unassigned: ' + r.aging.unassigned + '. On hold: ' + r.aging.onHold + '. No change in 7 days: ' + r.aging.stale + '.'],
      columns: [{ header: 'Priority', width: 16 }, ...AGE_BUCKETS.map((b) => ({ header: b.label, width: 14, type: 'number' as const })), { header: 'Total', type: 'number' }],
      rows: [
        ...r.aging.byPriority.map((row) => [labels.priority[row.key] ?? row.key, ...row.counts, row.counts.reduce((a, b) => a + b, 0)]),
        ['All', ...r.aging.buckets.map((b) => b.count), r.aging.total],
      ],
    },
    {
      name: 'By category',
      title: 'Raised by category - ' + when,
      columns: [{ header: 'Category', width: 30 }, { header: 'Raised', type: 'number' }, { header: 'SLA breached', width: 14, type: 'number' }],
      rows: r.byCategory.map((c) => [c.name, c.raised, c.breached]),
    },
    {
      name: 'By company',
      title: 'By company - ' + when,
      columns: [
        { header: 'Company', width: 30 },
        { header: 'Raised', type: 'number' },
        { header: 'Resolved', type: 'number' },
        { header: 'Open now', type: 'number' },
        { header: 'SLA breached', width: 14, type: 'number' },
        { header: 'SLA met', type: 'percent' },
        { header: 'Median resolution (hours)', width: 24, type: 'decimal' },
      ],
      rows: r.byCompany.map((c) => [c.name, c.raised, c.resolved, c.openNow, c.breached, pct(c.slaRate), hours(c.medianResolutionHours)]),
    },
    {
      name: 'Priority and type',
      title: 'Raised by priority and type - ' + when,
      columns: [{ header: 'Priority or type', width: 24 }, { header: 'Raised', type: 'number' }, { header: 'SLA breached', width: 14, type: 'number' }],
      rows: [
        ...r.byPriority.map((p) => [labels.priority[p.key], p.raised, p.breached]),
        ...r.byType.map((t) => [labels.type[t.key], t.raised, '']),
      ],
    },
    {
      name: 'Day by day',
      title: 'Day by day - ' + when,
      columns: [{ header: 'Day', width: 14 }, { header: 'Raised', type: 'number' }, { header: 'Resolved', type: 'number' }],
      rows: r.daily.map((d) => [d.day, d.raised, d.resolved]),
    },
  ];
  if (r.people) {
    sheets.push({
      name: 'Technicians',
      title: 'Technicians - ' + when,
      columns: [
        { header: 'Technician', width: 32 },
        { header: 'Resolved', type: 'number' },
        { header: 'Open now', type: 'number' },
        { header: 'SLA breached', width: 14, type: 'number' },
        { header: 'Median resolution (hours)', width: 24, type: 'decimal' },
      ],
      rows: r.people.map((p) => [p.name, p.resolved, p.openNow, p.breached, hours(p.medianResolutionHours)]),
    });
  }
  if (r.tickets) {
    sheets.push({
      name: 'Tickets',
      title: 'Tickets raised - ' + when,
      columns: [
        { header: 'Reference', width: 13 },
        { header: 'Title', width: 40 },
        { header: 'Type', width: 16 },
        { header: 'Priority', width: 10 },
        { header: 'Status', width: 12 },
        { header: 'Group', width: 18 },
        { header: 'Requester', width: 30 },
        { header: 'Requester email', width: 30 },
        { header: 'Company', width: 20 },
        { header: 'Raised by', width: 30 },
        { header: 'Raised by email', width: 30 },
        { header: 'Assignee', width: 26 },
        { header: 'Raised', width: 17, type: 'date' },
        { header: 'Resolved', width: 17, type: 'date' },
        { header: 'Closed', width: 17, type: 'date' },
        { header: 'Response SLA', width: 14 },
        { header: 'Resolution SLA', width: 15 },
      ],
      rows: r.tickets.map((t) => [
        t.reference, t.title, labels.type[t.type] ?? t.type, labels.priority[t.priority] ?? t.priority, labels.status[t.status] ?? t.status,
        t.group, t.requesterName, t.requesterEmail, t.company, t.raisedByName, t.raisedByEmail, t.assignee,
        t.createdAt, t.resolvedAt ?? '', t.closedAt ?? '', t.responseSla, t.resolutionSla,
      ]),
    });
  }
  sheets.push({
    name: 'Definitions',
    title: 'What each figure means',
    notes: ['Dates and days are in the ' + settings().locale.timeZone + ' time zone.'],
    columns: [{ header: 'Figure', width: 26 }, { header: 'Definition', width: 120 }],
    rows: Object.values(METRIC_DEFINITIONS).map((d) => [d.label, d.definition]),
  });
  return workbook(sheets, brandColour);
}
