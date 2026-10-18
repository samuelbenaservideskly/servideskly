import { randomBytes } from 'node:crypto';
import { audit } from '../lib/audit.js';
import { execute, query, queryOne } from '../db/index.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso, sha256 } from '../lib/util.js';
import { groupsForUser } from './groups.js';
import { buildReport, readableHours, PERIODS, NO_COMPANY } from './reports.js';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  listTickets,
  type TicketFilters,
  type TicketListItem,
} from './tickets.js';
import { recentActivity, type ActivityItem } from './work-dashboard.js';
import { findDashboard, listDashboards, renderDashboard } from './dashboards.js';
import type { UserRow } from './users.js';

/**
 * My dashboards and sidebar pins: a technician's or administrator's own.
 *
 * A **dashboard** is a list of widgets (user_boards.widgets, JSON), drawn on
 * the server. A **pin** is a link in the sidebar's Pinned section - to a
 * dashboard, a filtered queue, or a report - with an icon. Both belong to
 * one person and are a 404 to anybody else.
 *
 * **A widget shows only what its owner may see**: ticket widgets go through
 * listTickets() with the owner as the viewer, report widgets through
 * buildReport(), which already limits a person to their groups. A widget
 * stores filters, never results, so it is always current.
 */

export const WIDGET_KINDS = [
  { key: 'figure', label: 'Figure', hint: 'A count of tickets' },
  { key: 'list', label: 'Ticket list', hint: 'The first tickets that match' },
  { key: 'report', label: 'Report figure', hint: 'A service-level or volume figure' },
  { key: 'chart', label: 'Chart', hint: 'Raised and resolved, day by day' },
  { key: 'activity', label: 'Activity', hint: 'What just happened on your tickets' },
  { key: 'dashboard', label: 'Dashboard', hint: 'One of the dashboards from Settings' },
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number]['key'];

export const REPORT_METRICS = [
  { key: 'raised', label: 'Raised' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'backlog', label: 'Open now' },
  { key: 'sla_response', label: 'Response target met' },
  { key: 'sla_resolution', label: 'Resolution target met' },
  { key: 'median_resolution', label: 'Median resolution' },
  { key: 'median_response', label: 'Median first response' },
] as const;

export const SCOPES = [
  { key: 'assigned', label: 'Assigned to me' },
  { key: 'myGroups', label: 'My groups' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'all', label: 'All tickets' },
  { key: 'mine', label: 'Raised by me' },
] as const;

export const PIN_ICONS = ['bookmark', 'star', 'grid', 'layout', 'ticket', 'inbox', 'alert', 'chart', 'users', 'checkCircle'] as const;

export interface TicketWidgetFilter {
  scope: string;
  status: string;
  priority: string;
  type: string;
  group: string;
  q: string;
}

export interface ReportWidgetConfig {
  group: string;
  company: string;
  period: string;
  metric: string;
}

export interface Widget {
  id: string;
  kind: WidgetKind;
  title: string;
  width: 'half' | 'full';
  filter?: TicketWidgetFilter;
  report?: ReportWidgetConfig;
  limit?: number;
  /** For kind 'dashboard': which one, by its id from Settings - Dashboards. */
  dashboardId?: string;
}

export interface BoardRow {
  id: string;
  owner_id: string;
  name: string;
  widgets: Widget[];
  created_at: string;
  updated_at: string;
}

export interface PinRow {
  id: string;
  owner_id: string;
  label: string;
  href: string;
  icon: string;
  sort_order: number;
}

const MAX_BOARDS = 20;
const MAX_WIDGETS = 24;
const MAX_PINS = 20;

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export function listBoards(ownerId: string): Promise<BoardRow[]> {
  return query<BoardRow>('SELECT * FROM user_boards WHERE owner_id = ? ORDER BY lower(name)', [ownerId]);
}

/** One of the owner's dashboards; anybody else's is "not found". */
export async function findBoard(ownerId: string, id: string): Promise<BoardRow> {
  const board = await queryOne<BoardRow>('SELECT * FROM user_boards WHERE id = ? AND owner_id = ?', [id, ownerId]);
  if (!board) throw notFound('There is no such dashboard.');
  return board;
}

const cleanName = (v: string, max: number) => v.replace(/\s+/g, ' ').trim().slice(0, max);

/** A new dashboard, pinned to the sidebar at once. */
export async function createBoard(ownerId: string, name: string): Promise<BoardRow> {
  const clean = cleanName(name, 60);
  if (!clean) throw conflict('Give the dashboard a name.');
  const count = await queryOne<{ n: number }>('SELECT count(*) AS n FROM user_boards WHERE owner_id = ?', [ownerId]);
  if (Number(count?.n ?? 0) >= MAX_BOARDS) throw conflict('You have ' + MAX_BOARDS + ' dashboards already; remove one first.');
  const id = newId();
  const now = nowIso();
  await execute('INSERT INTO user_boards (id, owner_id, name, widgets, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id, ownerId, clean, '[]', now, now,
  ]);
  await addPin(ownerId, { label: clean, href: '/boards/' + id, icon: 'layout' }).catch(() => undefined);
  return findBoard(ownerId, id);
}

export async function renameBoard(ownerId: string, id: string, name: string): Promise<void> {
  await findBoard(ownerId, id);
  const clean = cleanName(name, 60);
  if (!clean) throw conflict('Give the dashboard a name.');
  await execute('UPDATE user_boards SET name = ?, updated_at = ? WHERE id = ?', [clean, nowIso(), id]);
  // Its pin follows the name.
  await execute('UPDATE user_pins SET label = ? WHERE owner_id = ? AND href = ?', [clean, ownerId, '/boards/' + id]);
}

export async function deleteBoard(ownerId: string, id: string): Promise<void> {
  await findBoard(ownerId, id);
  await execute('DELETE FROM user_boards WHERE id = ?', [id]);
  await execute('DELETE FROM user_pins WHERE owner_id = ? AND href = ?', [ownerId, '/boards/' + id]);
}

async function saveWidgets(id: string, widgets: Widget[]): Promise<void> {
  await execute('UPDATE user_boards SET widgets = ?, updated_at = ? WHERE id = ?', [JSON.stringify(widgets), nowIso(), id]);
}

const pickOne = (value: unknown, allowed: readonly string[], fallback: string) =>
  typeof value === 'string' && allowed.includes(value) ? value : fallback;

/** A widget from a posted form: every value checked against what exists. */
export function widgetFromForm(raw: Record<string, unknown>, id = newId()): Widget {
  const kind = pickOne(raw.kind, WIDGET_KINDS.map((k) => k.key), 'figure') as WidgetKind;
  const str = (k: string, max = 120) => (typeof raw[k] === 'string' ? cleanName(raw[k] as string, max) : '');
  const widget: Widget = {
    id,
    kind,
    title: str('title', 80),
    width: raw.width === 'full' ? 'full' : 'half',
  };
  if (kind === 'figure' || kind === 'list') {
    widget.filter = {
      scope: pickOne(raw.scope, SCOPES.map((s) => s.key), 'assigned'),
      status: pickOne(raw.status, ['active', 'any', ...TICKET_STATUSES], 'active'),
      priority: pickOne(raw.priority, ['any', ...TICKET_PRIORITIES], 'any'),
      type: pickOne(raw.type, ['any', ...TICKET_TYPES], 'any'),
      group: str('group', 60),
      q: str('q', 100),
    };
    if (kind === 'list') widget.limit = raw.limit === '10' ? 10 : 5;
  }
  if (kind === 'dashboard') {
    // Checked against the dashboards that exist when it is drawn, not here:
    // one can be removed between the two, and a widget pointing at nothing
    // says so rather than disappearing.
    widget.dashboardId = str('dashboardId', 60);
  }
  if (kind === 'report' || kind === 'chart') {
    widget.report = {
      group: str('reportGroup', 60) || 'all',
      company: str('company', 120),
      period: pickOne(raw.period, PERIODS.filter((p) => p.key !== 'custom').map((p) => p.key), '30'),
      metric: pickOne(raw.metric, REPORT_METRICS.map((m) => m.key), 'sla_resolution'),
    };
  }
  return widget;
}

export async function addWidget(ownerId: string, boardId: string, widget: Widget): Promise<void> {
  const board = await findBoard(ownerId, boardId);
  if (board.widgets.length >= MAX_WIDGETS) throw conflict('A dashboard holds ' + MAX_WIDGETS + ' widgets at most.');
  await saveWidgets(boardId, [...board.widgets, widget]);
}

export async function updateWidget(ownerId: string, boardId: string, widget: Widget): Promise<void> {
  const board = await findBoard(ownerId, boardId);
  if (!board.widgets.some((w) => w.id === widget.id)) throw notFound('That widget is no longer there.');
  await saveWidgets(boardId, board.widgets.map((w) => (w.id === widget.id ? widget : w)));
}

export async function removeWidget(ownerId: string, boardId: string, widgetId: string): Promise<void> {
  const board = await findBoard(ownerId, boardId);
  await saveWidgets(boardId, board.widgets.filter((w) => w.id !== widgetId));
}

export async function moveWidget(ownerId: string, boardId: string, widgetId: string, direction: 'up' | 'down'): Promise<void> {
  const board = await findBoard(ownerId, boardId);
  const list = [...board.widgets];
  const i = list.findIndex((w) => w.id === widgetId);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  await saveWidgets(boardId, list);
}

// ---------------------------------------------------------------------------
// What a widget shows
// ---------------------------------------------------------------------------

export type WidgetView =
  | { kind: 'figure'; value: number; href: string }
  | { kind: 'list'; items: TicketListItem[]; total: number; href: string }
  | { kind: 'report'; value: string; note: string; href: string }
  | { kind: 'chart'; daily: { day: string; raised: number; resolved: number }[]; href: string }
  | { kind: 'activity'; items: ActivityItem[] }
  | { kind: 'dashboard'; html: string }
  | { kind: 'empty'; message: string };

function queueHref(f: TicketWidgetFilter): string {
  const p = new URLSearchParams({ scope: f.scope, status: f.status, priority: f.priority, type: f.type });
  if (f.group) p.set('group', f.group);
  if (f.q) p.set('q', f.q);
  return '/tickets?' + p.toString();
}

function reportHref(r: ReportWidgetConfig): string {
  const p = new URLSearchParams({ group: r.group, period: r.period });
  if (r.company) p.set('company', r.company);
  return '/reports?' + p.toString();
}

async function filtersFor(viewer: UserRow, f: TicketWidgetFilter, perPage: number): Promise<TicketFilters> {
  return {
    scope: f.scope as TicketFilters['scope'],
    status: f.status as TicketFilters['status'],
    priority: f.priority as TicketFilters['priority'],
    ...(f.type !== 'any' ? { type: f.type as TicketFilters['type'] } : {}),
    ...(f.group ? { groupId: f.group } : {}),
    ...(f.q ? { search: f.q } : {}),
    viewerGroupIds: (await groupsForUser(viewer.id)).map((g) => g.id),
    page: 1,
    perPage,
  };
}

/** What one widget shows, read with its owner's permissions. */
export async function viewWidget(viewer: UserRow, widget: Widget): Promise<WidgetView> {
  if ((widget.kind === 'figure' || widget.kind === 'list') && widget.filter) {
    const perPage = widget.kind === 'list' ? (widget.limit ?? 5) : 1;
    const page = await listTickets(viewer, await filtersFor(viewer, widget.filter, perPage));
    if (widget.kind === 'figure') return { kind: 'figure', value: page.total, href: queueHref(widget.filter) };
    return {
      kind: 'list',
      total: page.total,
      href: queueHref(widget.filter),
      items: page.items,
    };
  }
  if ((widget.kind === 'report' || widget.kind === 'chart') && widget.report) {
    const r = widget.report;
    const report = await buildReport(viewer, { group: r.group, period: r.period, company: r.company });
    if (!report) return { kind: 'empty', message: 'You are in no technician group, so there is nothing to report.' };
    if (widget.kind === 'chart') return { kind: 'chart', daily: report.daily, href: reportHref(r) };
    const pct = (v: number | null) => (v === null ? '-' : v + '%');
    const values: Record<string, [string, string]> = {
      raised: [String(report.totals.raised), 'tickets raised'],
      resolved: [String(report.totals.resolved), 'tickets resolved'],
      backlog: [String(report.totals.backlog), 'open now'],
      sla_response: [report.sla.enabled ? pct(report.sla.response.rate) : 'Off', report.sla.response.breached + ' breached'],
      sla_resolution: [report.sla.enabled ? pct(report.sla.resolution.rate) : 'Off', report.sla.resolution.breached + ' breached'],
      median_resolution: [readableHours(report.medians.resolutionHours), 'median'],
      median_response: [readableHours(report.medians.firstResponseHours), 'median'],
    };
    const [value, note] = values[r.metric] ?? ['-', ''];
    return { kind: 'report', value, note, href: reportHref(r) };
  }
  if (widget.kind === 'activity') {
    const groups = (await groupsForUser(viewer.id)).map((g) => g.id);
    return { kind: 'activity', items: await recentActivity(viewer.id, groups, 6) };
  }
  if (widget.kind === 'dashboard' && widget.dashboardId) {
    const row = await findDashboard(widget.dashboardId);
    if (!row) return { kind: 'empty', message: 'That dashboard no longer exists.' };
    if (!row.is_enabled) {
      // Off is a state worth seeing on your own board: the dashboard draws
      // nothing at all for a requester, and silence would read as a bug.
      return { kind: 'empty', message: row.name + ' is switched off.' };
    }
    return { kind: 'dashboard', html: await renderDashboard(row, viewer) };
  }
  return { kind: 'empty', message: 'This widget needs its settings.' };
}

/** Every dashboard a widget could show, for the Add a widget form. */
export function dashboardChoices(): Promise<{ id: string; name: string; is_enabled: boolean }[]> {
  return listDashboards();
}

/** The title a widget shows when none was typed. */
export function widgetTitle(w: Widget, groupName: (id: string) => string | undefined): string {
  if (w.title) return w.title;
  const kind = WIDGET_KINDS.find((k) => k.key === w.kind)?.label ?? 'Widget';
  if (w.filter) {
    const scope = SCOPES.find((s) => s.key === w.filter!.scope)?.label ?? '';
    const group = w.filter.group ? groupName(w.filter.group) : '';
    return [scope, w.filter.priority !== 'any' ? w.filter.priority : '', group].filter(Boolean).join(' - ') || kind;
  }
  if (w.report) {
    const metric = w.kind === 'chart' ? 'Raised and resolved' : REPORT_METRICS.find((m) => m.key === w.report!.metric)?.label ?? kind;
    const company = w.report.company === NO_COMPANY ? 'No company' : w.report.company;
    return [metric, company || (w.report.group !== 'all' ? groupName(w.report.group) : '')].filter(Boolean).join(' - ');
  }
  return kind;
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

export function listPins(ownerId: string): Promise<PinRow[]> {
  return query<PinRow>('SELECT * FROM user_pins WHERE owner_id = ? ORDER BY sort_order, created_at', [ownerId]);
}

/**
 * Only places inside this application, and only those a pin is for: a queue,
 * a report, a dashboard. An address from a form is never trusted to stay
 * on this site by itself.
 */
export function pinHrefProblem(href: string): string | null {
  if (href.length > 600) return 'That address is too long to pin.';
  if (!/^\/(tickets|reports|boards|dashboard)(\/[A-Za-z0-9-]*)?(\?[^#\s<>"]*)?$/.test(href)) return 'Only a ticket list, a report or a dashboard can be pinned.';
  return null;
}

export async function addPin(ownerId: string, input: { label: string; href: string; icon: string }): Promise<PinRow> {
  const label = cleanName(input.label, 40);
  if (!label) throw conflict('Give the pin a name.');
  const problem = pinHrefProblem(input.href);
  if (problem) throw conflict(problem);
  const pins = await listPins(ownerId);
  if (pins.some((p) => p.href === input.href)) throw conflict('That is pinned already.');
  if (pins.length >= MAX_PINS) throw conflict('You have ' + MAX_PINS + ' pins already; remove one first.');
  const id = newId();
  await execute('INSERT INTO user_pins (id, owner_id, label, href, icon, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id, ownerId, label, input.href, pickOne(input.icon, PIN_ICONS, 'bookmark'), (pins.at(-1)?.sort_order ?? 0) + 10, nowIso(),
  ]);
  return (await queryOne<PinRow>('SELECT * FROM user_pins WHERE id = ?', [id]))!;
}

async function findPin(ownerId: string, id: string): Promise<PinRow> {
  const pin = await queryOne<PinRow>('SELECT * FROM user_pins WHERE id = ? AND owner_id = ?', [id, ownerId]);
  if (!pin) throw notFound('That pin is no longer there.');
  return pin;
}

export async function updatePin(ownerId: string, id: string, input: { label: string; icon: string }): Promise<void> {
  await findPin(ownerId, id);
  const label = cleanName(input.label, 40);
  if (!label) throw conflict('Give the pin a name.');
  await execute('UPDATE user_pins SET label = ?, icon = ? WHERE id = ?', [label, pickOne(input.icon, PIN_ICONS, 'bookmark'), id]);
}

export async function removePin(ownerId: string, id: string): Promise<void> {
  await findPin(ownerId, id);
  await execute('DELETE FROM user_pins WHERE id = ?', [id]);
}

export async function movePin(ownerId: string, id: string, direction: 'up' | 'down'): Promise<void> {
  const pins = await listPins(ownerId);
  const i = pins.findIndex((p) => p.id === id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= pins.length) return;
  [pins[i], pins[j]] = [pins[j]!, pins[i]!];
  for (const [n, p] of pins.entries()) await execute('UPDATE user_pins SET sort_order = ? WHERE id = ?', [(n + 1) * 10, p.id]);
}

// ---------------------------------------------------------------------------
// Sharing: a link to import a copy
// ---------------------------------------------------------------------------
//
// What travels is the layout - names and filters - never data: an imported
// copy reads with its new owner's permissions like any of their dashboards.
// The link holds a 32-byte random token; only its sha256 is stored, so the
// database cannot hand a link out. One live link per dashboard (a new one
// stops the old), 14 days, stoppable, audited. Staff only.

export const SHARE_DAYS = 14;

export interface ShareRow {
  id: string;
  board_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

/** The live link of a dashboard, if it has one (its token is not kept). */
export async function activeShare(boardId: string): Promise<ShareRow | undefined> {
  return queryOne<ShareRow>(
    'SELECT id, board_id, created_at, expires_at, revoked_at FROM board_shares WHERE board_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
    [boardId, nowIso()],
  );
}

/** A new link; the token is returned once, for the page to show, and never again. */
export async function shareBoard(ownerId: string, boardId: string, actorId: string): Promise<{ token: string; expiresAt: string }> {
  const board = await findBoard(ownerId, boardId);
  const now = nowIso();
  await execute('UPDATE board_shares SET revoked_at = ? WHERE board_id = ? AND revoked_at IS NULL', [now, board.id]);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SHARE_DAYS * 86_400_000).toISOString();
  await execute('INSERT INTO board_shares (id, board_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [
    newId(), board.id, sha256(token), now, expiresAt,
  ]);
  audit({ action: 'board.shared', actorId, targetType: 'board', targetId: board.id, detail: { name: board.name, expiresAt } });
  return { token, expiresAt };
}

export async function stopSharing(ownerId: string, boardId: string, actorId: string): Promise<void> {
  const board = await findBoard(ownerId, boardId);
  const changed = await execute('UPDATE board_shares SET revoked_at = ? WHERE board_id = ? AND revoked_at IS NULL', [nowIso(), board.id]);
  if (changed > 0) audit({ action: 'board.share_stopped', actorId, targetType: 'board', targetId: board.id, detail: { name: board.name } });
}

/** The dashboard a token names, while its link is live; undefined otherwise - one answer for every failure. */
export async function boardForToken(token: string): Promise<(BoardRow & { owner_name: string }) | undefined> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return undefined;
  return queryOne<BoardRow & { owner_name: string }>(
    `SELECT b.*, u.display_name AS owner_name FROM board_shares s
       JOIN user_boards b ON b.id = s.board_id JOIN users u ON u.id = b.owner_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    [sha256(token), nowIso()],
  );
}

/** A copy for the importer: new ids, their own, pinned; the original is untouched. */
export async function importBoard(importerId: string, token: string): Promise<BoardRow> {
  const source = await boardForToken(token);
  if (!source) throw notFound('This link has expired or was stopped. Ask for a new one.');
  const copy = await createBoard(importerId, source.owner_id === importerId ? source.name + ' (copy)' : source.name);
  await saveWidgets(copy.id, source.widgets.map((w) => ({ ...w, id: newId() })));
  audit({ action: 'board.imported', actorId: importerId, targetType: 'board', targetId: copy.id, detail: { from: source.id, name: source.name } });
  return findBoard(importerId, copy.id);
}

/** The token from a pasted link (or the bare token). */
export function tokenFromLink(text: string): string {
  const m = /\/boards\/import\/([A-Za-z0-9_-]{40,60})/.exec(text) ?? /^\s*([A-Za-z0-9_-]{40,60})\s*$/.exec(text);
  return m ? m[1]! : '';
}
