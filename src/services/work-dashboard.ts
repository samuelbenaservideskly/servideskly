import { query, queryOne } from '../db/index.js';
import { ticketReference } from '../lib/util.js';
import { isStaff, type UserRow } from './users.js';
import { slaFor, type SlaState } from './sla.js';
import { settings } from '../settings/index.js';
import { formatDate, formatDuration } from '../lib/format.js';
import type { TicketPriority, TicketStatus } from './tickets.js';

/**
 * The technician's and the manager's dashboards (/dashboard).
 *
 * - **My work**: for a technician in at least one technician group - what is
 *   assigned to them, what is waiting unassigned in their groups, and how each
 *   group stands.
 * - **Manager**: for a group's manager (an administrator sees every group) -
 *   the selected groups' figures, each technician's load, what is at risk or
 *   breached, and what has waited longest. A manager of several groups
 *   filters by group; "All my groups" is the default.
 *
 * Read-only, drawn on the server, no script. Being in a group or managing one
 * is what opens it; it grants nothing a technician could not already see in
 * the queue.
 */

const OPEN: TicketStatus[] = ['open', 'in_progress', 'pending'];
const OPEN_SQL = "('open', 'in_progress', 'pending')";
const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const DAY = 86_400_000;

export interface GroupRef {
  id: string;
  name: string;
}

export interface DashTicket {
  id: string;
  reference: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  group_name: string | null;
  assignee_name: string | null;
  requester_name: string;
  /** incident, request, change or task - the dashboard's icon. */
  type: string;
  created_at: string;
  updated_at: string;
  /** The worse SLA clock still running, when it needs attention. */
  sla: SlaState | null;
  /** The clock in words - "Responds in 1 h 12 m", "Due Fri 12:00", "Paused - on hold", "Met". Null without SLA. */
  clock: string | null;
}

/** The active technician groups a person is a member of. */
export function memberGroups(userId: string): Promise<GroupRef[]> {
  return query<GroupRef>(
    `SELECT g.id, g.name FROM technician_groups g
       JOIN technician_group_members m ON m.group_id = g.id
      WHERE m.user_id = ? AND g.is_active = 1
      ORDER BY lower(g.name)`,
    [userId],
  );
}

/** The groups a person may see as a manager: those they manage; an administrator, all. */
export function managedGroups(user: UserRow): Promise<GroupRef[]> {
  return user.role === 'admin'
    ? query<GroupRef>('SELECT id, name FROM technician_groups WHERE is_active = 1 ORDER BY lower(name)')
    : query<GroupRef>('SELECT id, name FROM technician_groups WHERE is_active = 1 AND id IN (SELECT group_id FROM technician_group_managers WHERE user_id = ?) ORDER BY lower(name)', [user.id]);
}

/**
 * Whether the Dashboard is offered: to every technician and administrator.
 * It used to need a technician group, so an administrator in none (the
 * break-glass account, a new helpdesk) never saw it. Somebody in no group
 * still has their own tickets; an administrator in none sees the whole desk.
 */
export async function canUseWorkDashboard(user: UserRow | null | undefined): Promise<boolean> {
  return Boolean(user && isStaff(user.role));
}

const TICKET_COLUMNS = `t.id, t.title, t.status, t.priority, t.type, t.created_at, t.updated_at, t.resolved_at, t.closed_at,
  t.requester_id, t.parent_id, t.ref_prefix, t.ref_seq,
  g.name AS group_name, a.display_name AS assignee_name, r.display_name AS requester_name`;
const TICKET_JOINS = `FROM tickets t
  JOIN users r ON r.id = t.requester_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN technician_groups g ON g.id = t.group_id`;

type Row = Omit<DashTicket, 'reference' | 'sla'> & {
  ref_prefix: string;
  ref_seq: number;
  resolved_at: string | null;
  closed_at: string | null;
  requester_id: string;
  parent_id: string | null;
};

/** "Fri 12:00", or "12:00" for later today, in the Locale time zone. */
function dueText(due: Date, now: Date): string {
  const tz = settings().locale.timeZone;
  const day = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(due);
  if (day(due) === day(now)) return time;
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(due);
  return due.getTime() - now.getTime() < 6 * DAY ? weekday + ' ' + time : formatDate(due.toISOString());
}

/** The worse running clock (when at risk or breached), and the clock in words. */
async function slaOf(row: Row, now: Date): Promise<{ sla: SlaState | null; clock: string | null }> {
  const s = await slaFor(row, now);
  if (!s) return { sla: null, clock: null };
  const states = [s.response, s.resolution].filter((c) => !c.doneAt).map((c) => c.state);
  const sla = states.includes('breached') ? 'breached' : states.includes('at_risk') ? 'at_risk' : null;
  let clock: string;
  if (!s.response.doneAt) {
    const left = s.response.due.getTime() - now.getTime();
    clock = left >= 0 ? 'Responds in ' + formatDuration(left) : 'Response ' + formatDuration(left) + ' late';
  } else if (s.resolution.state === 'paused') {
    clock = 'Paused - on hold';
  } else if (!s.resolution.doneAt) {
    const left = s.resolution.due.getTime() - now.getTime();
    clock = left >= 0 ? 'Due ' + dueText(s.resolution.due, now) : formatDuration(left) + ' overdue';
  } else {
    const spare = s.resolution.due.getTime() - s.resolution.doneAt.getTime();
    clock = spare >= 0 ? 'Met by ' + formatDuration(spare) : 'Missed by ' + formatDuration(spare);
  }
  return { sla, clock };
}

async function decorate(rows: Row[], now: Date): Promise<DashTicket[]> {
  const out: DashTicket[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      reference: ticketReference(Number(r.ref_seq), r.ref_prefix),
      title: r.title,
      status: r.status,
      priority: r.priority,
      group_name: r.group_name,
      assignee_name: r.assignee_name,
      requester_name: r.requester_name,
      type: r.type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      ...(await slaOf(r, now)),
    });
  }
  return out;
}

function byPriority(a: DashTicket, b: DashTicket): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updated_at.localeCompare(a.updated_at);
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

// ---------------------------------------------------------------------------
// My work
// ---------------------------------------------------------------------------

export interface MyWork {
  groups: (GroupRef & { open: number; unassigned: number })[];
  mine: DashTicket[];
  unassigned: DashTicket[];
  counts: { assigned: number; onHold: number; unassigned: number; attention: number; resolvedWeek: number; raisedToday: number };
  /**
   * The four figures at the top, over "my desk": my groups' tickets and my
   * own (an administrator in no group: every ticket). The last 24 hours,
   * not "today", so there is no time zone to argue about.
   */
  desk: {
    /** Every group, for an administrator in none. */
    everything: boolean;
    open: number;
    /** Raised in 24 h, less those that left the open states in 24 h. */
    openChange: number;
    raised: number;
    /** Raised in the 24 h before those. */
    raisedBefore: number;
    /** SLA targets met, both clocks, tickets raised in 30 days - the Reports definition. Null without SLA or data. */
    slaRate: number | null;
    slaEnabled: boolean;
  };
  /** The latest things that happened to my tickets and my groups' tickets. */
  activity: ActivityItem[];
}

export interface ActivityItem {
  /**
   * A ticket event's kind (created, comment, internal_note, field_changed),
   * or one of the desk's own: 'joined' (somebody joined one of my groups;
   * title is the group, newValue 'rule' or 'manual'), 'automation' (an
   * automation ran; title is its name, newValue the outcome), 'sla' (a clock
   * of mine at risk or breached; field is 'response' or 'resolution',
   * newValue the state, title the clock in words).
   */
  ticketId: string | null;
  reference: string;
  title: string;
  kind: string;
  field: string | null;
  newValue: string | null;
  actorName: string | null;
  at: string;
}

/**
 * The latest events on tickets assigned to somebody or routed to one of
 * their groups: raised, changed, commented. Internal notes included - the
 * dashboard is staff-only. One query, newest first.
 */
/** The sorts of line the Activity feed can carry. */
export const ACTIVITY_KINDS = [
  { key: 'tickets', label: 'Tickets', hint: 'Raised, updated, resolved' },
  { key: 'sla', label: 'Service levels', hint: 'Your clocks at risk or breached' },
  { key: 'groups', label: 'People joining your groups', hint: '' },
  { key: 'automations', label: 'Automation runs', hint: 'Administrators only' },
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]['key'];

/**
 * The kinds one person wants, narrowed to the ones they may see.
 *
 * Stored as a comma-separated list on the account; empty means everything
 * they are allowed to see, which is what it was before anybody chose.
 */
export function activityChoice(user: Pick<UserRow, 'role' | 'activity_kinds'>): ActivityKind[] {
  const allowed = ACTIVITY_KINDS.map((k) => k.key).filter(
    (key) => key !== 'automations' || user.role === 'admin',
  );
  const stored = String(user.activity_kinds ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (stored.length === 0) return allowed;
  return allowed.filter((key) => stored.includes(key));
}

export async function recentActivity(userId: string, groupIds: string[], limit = 6, everything = false): Promise<ActivityItem[]> {
  const scope = everything
    ? '1 = 1'
    : groupIds.length
      ? `(t.assignee_id = ? OR t.group_id IN (${marks(groupIds.length)}))`
      : 't.assignee_id = ?';
  const rows = await query<{
    ticket_id: string; title: string; ref_prefix: string; ref_seq: number; kind: string;
    field: string | null; new_value: string | null; actor_name: string | null; created_at: string;
  }>(
    `SELECT e.ticket_id, t.title, t.ref_prefix, t.ref_seq, e.kind, e.field, e.new_value, u.display_name AS actor_name, e.created_at
       FROM ticket_events e
       JOIN tickets t ON t.id = e.ticket_id
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE ${scope}
      ORDER BY e.created_at DESC
      LIMIT ${limit}`,
    everything ? [] : [userId, ...groupIds],
  );
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    reference: ticketReference(Number(r.ref_seq), r.ref_prefix),
    title: r.title,
    kind: r.kind,
    field: r.field,
    newValue: r.new_value,
    actorName: r.actor_name,
    at: r.created_at,
  }));
}

/**
 * Desk events besides the tickets' own: people joining my groups, and
 * automation runs (an administrator's every run; anybody else's, the runs on
 * tickets in scope). Merged with the ticket events by time.
 */
async function deskEvents(user: UserRow, groupIds: string[], everything: boolean, limit: number): Promise<ActivityItem[]> {
  const out: ActivityItem[] = [];
  if (everything || groupIds.length) {
    const joins = await query<{ group_name: string; person: string; source: string | null; added_at: string }>(
      `SELECT g.name AS group_name, u.display_name AS person, m.source, m.added_at
         FROM technician_group_members m
         JOIN technician_groups g ON g.id = m.group_id
         JOIN users u ON u.id = m.user_id
        WHERE g.is_active = 1${everything ? '' : ` AND m.group_id IN (${marks(groupIds.length)})`}
        ORDER BY m.added_at DESC LIMIT ${limit}`,
      everything ? [] : groupIds,
    );
    for (const j of joins) {
      out.push({ ticketId: null, reference: '', title: j.group_name, kind: 'joined', field: null, newValue: j.source === 'rule' ? 'rule' : 'manual', actorName: j.person, at: j.added_at });
    }
  }
  const scope = user.role === 'admin'
    ? ''
    : groupIds.length
      ? `AND t.id IS NOT NULL AND (t.assignee_id = ? OR t.group_id IN (${marks(groupIds.length)}))`
      : 'AND t.id IS NOT NULL AND t.assignee_id = ?';
  const runs = await query<{ name: string; outcome: string; ran_at: string; ticket_id: string | null; ref_prefix: string | null; ref_seq: number | null }>(
    `SELECT a.name, r.outcome, r.ran_at, r.ticket_id, t.ref_prefix, t.ref_seq
       FROM automation_runs r
       JOIN automations a ON a.id = r.automation_id
       LEFT JOIN tickets t ON t.id = r.ticket_id
      WHERE 1 = 1 ${scope}
      ORDER BY r.ran_at DESC LIMIT ${limit}`,
    user.role === 'admin' ? [] : [user.id, ...groupIds],
  );
  for (const r of runs) {
    out.push({
      ticketId: r.ticket_id,
      reference: r.ref_seq != null && r.ref_prefix != null ? ticketReference(Number(r.ref_seq), r.ref_prefix) : '',
      title: r.name, kind: 'automation', field: null, newValue: r.outcome, actorName: null, at: r.ran_at,
    });
  }
  return out;
}

/** My clocks at risk or breached, as activity at the top of the feed. */
function slaAlerts(tickets: DashTicket[], now: Date): ActivityItem[] {
  return tickets
    .filter((t) => t.sla)
    .slice(0, 3)
    .map((t) => ({
      ticketId: t.id,
      reference: t.reference,
      title: t.clock ?? '',
      kind: 'sla',
      field: t.clock && /^Respon/.test(t.clock) ? 'response' : 'resolution',
      newValue: t.sla,
      actorName: null,
      at: now.toISOString(),
    }));
}

/**
 * The 30-day SLA figure, remembered for a few minutes.
 *
 * It is `buildReport()`'s own number - the dashboard and Reports must agree,
 * which is why the whole report is built rather than a figure of its own -
 * and that report reads every ticket raised in the period. Nobody needs it
 * to the second: a rate over thirty days does not move between two loads of
 * a page, and a stale one is corrected within the minute.
 *
 * Per process, like `settings()`. At one instance that is the whole cache;
 * at several each has its own, which is correct but no cheaper.
 */
const SLA_RATE_TTL = 5 * 60_000;
const slaRateCache = new Map<string, { at: number; rate: number | null }>();

/** Forgets the remembered rates. For the tests, and after a settings change. */
export function forgetSlaRates(): void {
  slaRateCache.clear();
}

async function slaRateFor(user: UserRow, now: Date): Promise<number | null> {
  if (!settings().sla.enabled) return null;

  const key = user.id;
  const held = slaRateCache.get(key);
  if (held && now.getTime() - held.at < SLA_RATE_TTL) return held.rate;

  // Imported here, not at the top: reports.ts imports this file.
  const { buildReport } = await import('./reports.js');
  const report = await buildReport(user, { group: 'all', period: '30' }, now);

  let rate: number | null = null;
  if (report) {
    const met = report.sla.response.met + report.sla.resolution.met;
    const breached = report.sla.response.breached + report.sla.resolution.breached;
    rate = met + breached === 0 ? null : Math.round((100 * met) / (met + breached));
  }

  slaRateCache.set(key, { at: now.getTime(), rate });
  return rate;
}

export async function myWork(user: UserRow, now: Date = new Date()): Promise<MyWork> {
  const groups = await memberGroups(user.id);
  // An administrator in no technician group watches the whole desk.
  const everything = groups.length === 0 && user.role === 'admin';
  const deskGroups = everything ? await managedGroups(user) : groups;
  const ids = deskGroups.map((g) => g.id);

  // Everything from here to the activity feed is independent of everything
  // else, so it goes together rather than one after another. On SQLite the
  // driver is synchronous and this changes little; on PostgreSQL each query
  // is a round trip, and they were serial.
  const minePromise = query<Row>(
    `SELECT ${TICKET_COLUMNS} ${TICKET_JOINS} WHERE t.assignee_id = ? AND t.status IN ${OPEN_SQL} LIMIT 300`,
    [user.id],
  ).then((rows) => decorate(rows, now));

  const unassignedPromise = ids.length === 0
    ? Promise.resolve([])
    : query<Row>(
        `SELECT ${TICKET_COLUMNS} ${TICKET_JOINS}
            WHERE t.assignee_id IS NULL AND t.status IN ${OPEN_SQL} AND t.group_id IN (${marks(ids.length)})
            ORDER BY t.created_at LIMIT 100`,
        ids,
      ).then((rows) => decorate(rows, now));

  const perGroupPromise = ids.length === 0
    ? Promise.resolve([])
    : query<{ group_id: string; open: number; unassigned: number }>(
        `SELECT group_id,
                count(*) AS open,
                sum(CASE WHEN assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned
           FROM tickets WHERE status IN ${OPEN_SQL} AND group_id IN (${marks(ids.length)})
          GROUP BY group_id`,
        ids,
      );

  const resolvedWeekPromise = queryOne<{ n: number }>(
    'SELECT count(*) AS n FROM tickets WHERE assignee_id = ? AND resolved_at >= ?',
    [user.id, new Date(now.getTime() - 7 * DAY).toISOString()],
  );

  // The last 24 hours rather than "today": no time zone to argue about.
  const raisedTodayPromise = ids.length === 0
    ? Promise.resolve({ n: 0 })
    : queryOne<{ n: number }>(
        `SELECT count(*) AS n FROM tickets WHERE group_id IN (${marks(ids.length)}) AND created_at >= ?`,
        [...ids, new Date(now.getTime() - DAY).toISOString()],
      );
  // The desk's figures. "In scope": routed to one of the groups, or mine.
  const since = new Date(now.getTime() - DAY).toISOString();
  const before = new Date(now.getTime() - 2 * DAY).toISOString();
  const inScope = everything
    ? '1 = 1'
    : ids.length ? `(t.assignee_id = ? OR t.group_id IN (${marks(ids.length)}))` : 't.assignee_id = ?';
  const scopeArgs = everything ? [] : [user.id, ...ids];
  const deskRowPromise = queryOne<{ open: number; raised: number; raised_before: number }>(
    `SELECT sum(CASE WHEN t.status IN ${OPEN_SQL} THEN 1 ELSE 0 END) AS open,
            sum(CASE WHEN t.created_at >= ? THEN 1 ELSE 0 END) AS raised,
            sum(CASE WHEN t.created_at >= ? AND t.created_at < ? THEN 1 ELSE 0 END) AS raised_before
       FROM tickets t WHERE t.parent_id IS NULL AND ${inScope}`,
    [since, before, since, ...scopeArgs],
  );
  // Left the open states in 24 h: a status change to resolved, closed or
  // cancelled from an open state - the same events Reports reads.
  const leftRowPromise = queryOne<{ n: number }>(
    `SELECT count(DISTINCT e.ticket_id) AS n FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
      WHERE e.kind = 'field_changed' AND e.field = 'status' AND e.created_at >= ?
        AND e.new_value IN ('resolved', 'closed', 'cancelled') AND e.old_value IN ${OPEN_SQL}
        AND t.parent_id IS NULL AND ${inScope}`,
    [since, ...scopeArgs],
  );
  const slaEnabled = settings().sla.enabled;

  const [
    mineRows,
    unassignedRows,
    perGroup,
    resolvedWeek,
    raisedToday,
    deskRow,
    leftRow,
    slaRate,
    desk,
    recent,
  ] = await Promise.all([
    minePromise,
    unassignedPromise,
    perGroupPromise,
    resolvedWeekPromise,
    raisedTodayPromise,
    deskRowPromise,
    leftRowPromise,
    slaRateFor(user, now),
    // The tickets come first in importance: at most two "joined" and three
    // automation lines, or a team set up in one go would fill the feed.
    deskEvents(user, ids, everything, 8),
    recentActivity(user.id, ids, 8, everything),
  ]);

  const mine = mineRows.sort(byPriority);
  const unassigned = unassignedRows.sort(byPriority);
  const raised24 = Number(deskRow?.raised ?? 0);

  // What this person keeps in their feed (the pen beside the heading).
  const wanted = activityChoice(user);
  const merged = [
    ...(wanted.includes('tickets') ? recent : []),
    ...(wanted.includes('groups') ? desk.filter((a) => a.kind === 'joined').slice(0, 2) : []),
    ...(wanted.includes('automations') ? desk.filter((a) => a.kind === 'automation').slice(0, 3) : []),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const activity = [
    ...(wanted.includes('sla') ? slaAlerts([...mine, ...unassigned], now) : []),
    ...merged,
  ].slice(0, 7);

  return {
    groups: deskGroups.map((g) => {
      const c = perGroup.find((p) => p.group_id === g.id);
      return { ...g, open: Number(c?.open ?? 0), unassigned: Number(c?.unassigned ?? 0) };
    }),
    mine,
    unassigned,
    counts: {
      assigned: mine.length,
      onHold: mine.filter((t) => t.status === 'pending').length,
      unassigned: unassigned.length,
      attention: mine.filter((t) => t.sla).length + unassigned.filter((t) => t.sla).length,
      resolvedWeek: Number(resolvedWeek?.n ?? 0),
      raisedToday: Number(raisedToday?.n ?? 0),
    },
    desk: {
      everything,
      open: Number(deskRow?.open ?? 0),
      openChange: raised24 - Number(leftRow?.n ?? 0),
      raised: raised24,
      raisedBefore: Number(deskRow?.raised_before ?? 0),
      slaRate,
      slaEnabled,
    },
    activity,
  };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface ManagerView {
  /** The groups this person may filter by, and which are shown. */
  groups: GroupRef[];
  /** The ids being shown. Empty means all of them, which is the default. */
  selected: string[];
  counts: { open: number; unassigned: number; onHold: number; attention: number; raisedWeek: number; resolvedWeek: number };
  typicalResolution: string;
  workload: { name: string; open: number; onHold: number; resolvedWeek: number; attention: number }[];
  attention: DashTicket[];
  oldest: DashTicket[];
}

function typical(hours: number[]): string {
  if (hours.length === 0) return '-';
  const sorted = [...hours].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return median < 1 ? 'under an hour' : median < 48 ? 'about ' + Math.round(median) + ' h' : 'about ' + Math.round(median / 24) + ' days';
}

/**
 * null when the person manages nothing (and is not an administrator).
 *
 * The filter takes **several** groups (asked for 15 Oct 2026): a manager of
 * five teams usually wants two of them side by side, not one or all. Ids
 * they do not manage are dropped rather than refused - the address is
 * shareable, and a link naming somebody else's group should show what the
 * reader may see, not an error.
 */
export async function managerView(
  user: UserRow,
  groupFilter: string | readonly string[] | undefined,
  now: Date = new Date(),
): Promise<ManagerView | null> {
  const groups = await managedGroups(user);
  if (groups.length === 0) return null;
  const asked = (Array.isArray(groupFilter) ? groupFilter : groupFilter ? [groupFilter] : [])
    .map((value) => String(value));
  // "all" is still a value the form can send, and so is nothing at all.
  const selected = asked.includes('all')
    ? []
    : Array.from(new Set(asked.filter((id) => groups.some((g) => g.id === id))));
  const ids = selected.length > 0 ? selected : groups.map((g) => g.id);
  const inScope = 't.group_id IN (' + marks(ids.length) + ')';

  const open = await decorate(
    await query<Row>(`SELECT ${TICKET_COLUMNS} ${TICKET_JOINS} WHERE ${inScope} AND t.status IN ${OPEN_SQL} LIMIT 1000`, ids),
    now,
  );
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const raised = await queryOne<{ n: number }>(`SELECT count(*) AS n FROM tickets t WHERE ${inScope} AND t.created_at >= ?`, [...ids, weekAgo]);
  const resolved = await query<{ created_at: string; resolved_at: string; assignee_id: string | null }>(
    `SELECT t.created_at, t.resolved_at, t.assignee_id FROM tickets t WHERE ${inScope} AND t.resolved_at >= ?`,
    [...ids, new Date(now.getTime() - 30 * DAY).toISOString()],
  );
  const resolvedWeek = resolved.filter((r) => r.resolved_at >= weekAgo);

  // Everybody who works these groups, and anybody holding one of their tickets.
  const people = await query<{ id: string; display_name: string }>(
    `SELECT u.id, u.display_name FROM users u
      WHERE u.status = 'active' AND (
        u.id IN (SELECT user_id FROM technician_group_members WHERE group_id IN (${marks(ids.length)}))
        OR u.id IN (SELECT assignee_id FROM tickets t WHERE ${inScope} AND t.status IN ${OPEN_SQL} AND assignee_id IS NOT NULL))
      ORDER BY lower(u.display_name)`,
    [...ids, ...ids],
  );
  const assigneeOf = new Map<string, string | null>();
  for (const row of await query<{ id: string; assignee_id: string | null }>(
    `SELECT t.id, t.assignee_id FROM tickets t WHERE ${inScope} AND t.status IN ${OPEN_SQL}`,
    ids,
  )) {
    assigneeOf.set(row.id, row.assignee_id);
  }
  const workload = people.map((p) => {
    const theirs = open.filter((t) => assigneeOf.get(t.id) === p.id);
    return {
      name: p.display_name,
      open: theirs.length,
      onHold: theirs.filter((t) => t.status === 'pending').length,
      attention: theirs.filter((t) => t.sla).length,
      resolvedWeek: resolvedWeek.filter((r) => r.assignee_id === p.id).length,
    };
  });
  const nobody = open.filter((t) => !assigneeOf.get(t.id));
  if (nobody.length > 0) {
    workload.push({ name: 'Unassigned', open: nobody.length, onHold: nobody.filter((t) => t.status === 'pending').length, attention: nobody.filter((t) => t.sla).length, resolvedWeek: 0 });
  }

  return {
    groups,
    selected,
    counts: {
      open: open.length,
      unassigned: nobody.length,
      onHold: open.filter((t) => t.status === 'pending').length,
      attention: open.filter((t) => t.sla).length,
      raisedWeek: Number(raised?.n ?? 0),
      resolvedWeek: resolvedWeek.length,
    },
    typicalResolution: typical(
      resolved.map((r) => (new Date(r.resolved_at).getTime() - new Date(r.created_at).getTime()) / 3_600_000).filter((h) => h >= 0),
    ),
    workload,
    attention: open
      .filter((t) => t.sla)
      .sort((a, b) => (a.sla === b.sla ? byPriority(a, b) : a.sla === 'breached' ? -1 : 1))
      .slice(0, 25),
    oldest: [...open].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, 10),
  };
}

export { OPEN };
