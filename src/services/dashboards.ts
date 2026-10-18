import { execute, query, queryOne, transaction } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import { settings } from '../settings/index.js';
import { formatDateIn } from '../lib/format.js';
import { userGroupsFor } from './user-groups.js';
import type { UserRow } from './users.js';
import { STATUS_LABELS, type TicketStatus } from './tickets.js';
import { ticketReference } from '../lib/util.js';

/**
 * Dashboards shown to requesters.
 *
 * Settings - Dashboards. Each dashboard is built in (a row per kind, created
 * by migration 32) and is either off, or on: shown above My tickets in the
 * standard look, and wherever a custom portal writes
 * `{{dashboard:<id>}}`. It draws either in the standard design or from the
 * administrator's own HTML with the dashboard's variables.
 *
 * The first is **Technician availability**: each technician states their
 * usual week and dated exceptions on their profile page, and the dashboard
 * shows who is where. Two things decide what a requester may read:
 *
 *  - **Statuses.** Each one is shown by name or folded into a plain
 *    "Available" / "Not available". A sick day is folded by default; why
 *    somebody is away is often nobody else's business.
 *  - **Locations.** A location is shown to everyone or to listed user
 *    groups. A technician at a location the reader may not see is shown
 *    without one.
 */

// ---------------------------------------------------------------------------
// Statuses and options
// ---------------------------------------------------------------------------

export const AVAILABILITY_STATUSES = [
  { key: 'office', label: 'Office', available: true, weekly: true },
  { key: 'home_office', label: 'Home office', available: true, weekly: true },
  { key: 'business_trip', label: 'Business trip', available: false, weekly: false },
  { key: 'vacation', label: 'Vacation', available: false, weekly: false },
  { key: 'sick', label: 'Sick day', available: false, weekly: false },
  { key: 'day_off', label: 'Day off', available: false, weekly: true },
] as const;

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number]['key'];

export function isAvailabilityStatus(value: string): value is AvailabilityStatus {
  return AVAILABILITY_STATUSES.some((s) => s.key === value);
}

export function statusLabel(key: string): string {
  return AVAILABILITY_STATUSES.find((s) => s.key === key)?.label ?? key;
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export interface AvailabilityOptions {
  /** Today only, or Monday to Friday of this week. */
  view: 'today' | 'week';
  /** Statuses shown by name; the rest read "Available" / "Not available". */
  statuses: AvailabilityStatus[];
  showLocation: boolean;
  /** Technician groups whose members are listed; empty means every technician. */
  groupIds: string[];
}

export const DEFAULT_AVAILABILITY_OPTIONS: AvailabilityOptions = {
  view: 'today',
  statuses: ['office', 'home_office', 'business_trip', 'vacation', 'day_off'],
  showLocation: true,
  groupIds: [],
};

export interface DashboardRow {
  id: string;
  kind: DashboardKind;
  name: string;
  is_enabled: boolean;
  design: 'standard' | 'custom';
  custom_html: string;
  dashboard_options: Partial<AvailabilityOptions>;
  updated_at: string;
}

export function availabilityOptions(row: DashboardRow): AvailabilityOptions {
  const stored = row.dashboard_options && typeof row.dashboard_options === 'object' ? row.dashboard_options : {};
  return {
    view: stored.view === 'week' ? 'week' : 'today',
    statuses: Array.isArray(stored.statuses)
      ? stored.statuses.filter(isAvailabilityStatus)
      : DEFAULT_AVAILABILITY_OPTIONS.statuses,
    showLocation: stored.showLocation !== false,
    groupIds: Array.isArray(stored.groupIds) ? stored.groupIds.filter((g) => typeof g === 'string') : [],
  };
}

/** The variables a custom design may use, for the reference beside the editor. */
export type DashboardKind = 'technician_availability' | 'my_tickets' | 'announcements' | 'service_desk';

export const DASHBOARD_VARIABLES = [
  { name: 'title', gives: "The dashboard's name." },
  { name: 'date', gives: "Today's date." },
  { name: 'today', gives: 'Who is where today, as a list.' },
  { name: 'week', gives: 'Monday to Friday of this week, as a table.' },
  { name: 'available_count', gives: 'How many technicians are available today.' },
  { name: 'unavailable_count', gives: 'How many are not available today.' },
  {
    name: 'count:<status>',
    gives: 'How many have that status today: ' + AVAILABILITY_STATUSES.map((s) => s.key).join(', ') + '.',
  },
] as const;

/** Each kind's variables, for its editor and for checking a design. */
export const VARIABLES_BY_KIND: Record<DashboardKind, readonly { name: string; gives: string }[]> = {
  technician_availability: DASHBOARD_VARIABLES,
  my_tickets: [
    { name: 'title', gives: "The dashboard's name." },
    { name: 'open_count', gives: "How many of the reader's tickets are open or in progress." },
    { name: 'on_hold_count', gives: 'How many are on hold.' },
    { name: 'resolved_count', gives: 'How many were resolved in the last 30 days.' },
    { name: 'list', gives: 'The five most recently updated, as a list of links.' },
  ],
  announcements: [
    { name: 'title', gives: "The dashboard's name." },
    { name: 'count', gives: 'How many announcements are current.' },
    { name: 'list', gives: 'The current announcements, most serious first.' },
  ],
  service_desk: [
    { name: 'title', gives: "The dashboard's name." },
    { name: 'open_count', gives: 'Tickets open, in progress or on hold.' },
    { name: 'today_count', gives: 'Tickets raised today.' },
    { name: 'typical_resolution', gives: 'The median time to resolve, over the last 30 days.' },
  ],
};

const DASHBOARD_VARIABLE = /\{\{\s*([a-z_]+)(?:\s*:\s*([a-z_]+))?\s*\}\}/g;
const MAX_HTML = 50_000;

/** Why a custom design cannot be saved, in words. */
export function designProblems(html: string, kind: DashboardKind = 'technician_availability'): string[] {
  const simple = new Set(VARIABLES_BY_KIND[kind].map((v) => v.name).filter((n) => !n.includes(':')));
  const problems: string[] = [];
  if (html.length > MAX_HTML) problems.push('This is longer than 50,000 characters.');
  if (/<\s*script\b/i.test(html)) problems.push('Scripts are not allowed in a dashboard.');
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) {
    problems.push('Event handlers such as onclick are not allowed - they would never run.');
  }
  if (/<\s*style\b/i.test(html) || /<[^>]*\sstyle\s*=/i.test(html)) {
    problems.push("Put styles in the requester portal's CSS. Inline styles are blocked by the page's security policy.");
  }
  const unknown = new Set<string>();
  for (const [whole, name, arg] of html.matchAll(DASHBOARD_VARIABLE)) {
    const ok = arg
      ? kind === 'technician_availability' && name === 'count' && isAvailabilityStatus(arg)
      : simple.has(name ?? '');
    if (!ok) unknown.add(whole);
  }
  if (unknown.size > 0) {
    problems.push('Not a variable this dashboard knows: ' + Array.from(unknown).join(', ') + '.');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export function listDashboards(): Promise<DashboardRow[]> {
  return query<DashboardRow>('SELECT * FROM dashboards ORDER BY lower(name)');
}

export function findDashboard(id: string): Promise<DashboardRow | undefined> {
  return queryOne<DashboardRow>('SELECT * FROM dashboards WHERE id = ?', [id]);
}

/** The dashboards that ship. They cannot be deleted; each is a starting point for copies. */
export const BUILT_IN_DASHBOARDS: Record<string, DashboardKind> = {
  'technician-availability': 'technician_availability',
  'my-tickets': 'my_tickets',
  announcements: 'announcements',
  'service-desk': 'service_desk',
};

/**
 * What a new dashboard may be based on. Only kinds a copy can differ in:
 * availability is scoped by technician group. The others would be the same
 * page twice - My tickets is always the reader's own, and announcements are
 * one shared list.
 */
export const COPYABLE_KINDS: { key: DashboardKind; label: string; from: string; differs: string }[] = [
  { key: 'technician_availability', label: 'Technician availability', from: 'technician-availability', differs: 'its own technician groups' },
  { key: 'service_desk', label: 'Service desk at a glance', from: 'service-desk', differs: 'counted for chosen technician groups' },
  { key: 'announcements', label: 'Announcements', from: 'announcements', differs: 'its own announcements' },
  { key: 'my_tickets', label: 'My tickets', from: 'my-tickets', differs: 'its own design' },
];

/** Service desk at a glance: which technician groups' tickets it counts; empty is all. */
export function serviceDeskGroups(row: DashboardRow): string[] {
  const stored = (row.dashboard_options ?? {}) as { groupIds?: unknown };
  return Array.isArray(stored.groupIds) ? stored.groupIds.filter((g): g is string => typeof g === 'string') : [];
}

export async function saveServiceDeskGroups(id: string, groupIds: string[], actorId: string | null): Promise<void> {
  await execute('UPDATE dashboards SET dashboard_options = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify({ groupIds }),
    nowIso(),
    id,
  ]);
  audit({ action: 'dashboard.options_changed', actorId, targetType: 'dashboard', targetId: id, detail: { groupIds } });
}

function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dashboard';
}

/**
 * A new dashboard, starting as a copy of the built-in one of its kind -
 * options and design - and switched off. Its id is a readable slug, because
 * it is what a portal writes in {{dashboard:<id>}}.
 */
export async function createDashboard(name: string, kind: string, actorId: string | null): Promise<string> {
  const base = COPYABLE_KINDS.find((k) => k.key === kind);
  if (!base) throw conflict('Choose what the dashboard is based on.', 'dashboard_kind');
  const clash = await queryOne<{ id: string }>('SELECT id FROM dashboards WHERE lower(name) = lower(?)', [name]);
  if (clash) throw conflict('A dashboard with that name already exists.', 'dashboard_name_taken');
  const ids = await dashboardIds();
  let id = slug(name);
  for (let n = 2; ids.has(id); n += 1) id = slug(name) + '-' + n;
  const from = await findDashboard(base.from);
  // A copy keeps the design; scoping starts from nothing (every group).
  const options = base.key === 'technician_availability' ? (from?.dashboard_options ?? {}) : {};
  await execute(
    `INSERT INTO dashboards (id, kind, name, is_enabled, design, custom_html, dashboard_options, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    [id, base.key, name, from?.design ?? 'standard', from?.custom_html ?? '', JSON.stringify(options), nowIso()],
  );
  audit({ action: 'dashboard.created', actorId, targetType: 'dashboard', targetId: id, detail: { name, kind: base.key } });
  return id;
}

/**
 * A new name. The id stays: it is what a portal wrote in
 * {{dashboard:<id>}}, and renaming must not break that page.
 */
export async function renameDashboard(id: string, name: string, actorId: string | null): Promise<void> {
  const row = await findDashboard(id);
  if (!row) throw notFound('No such dashboard.');
  const clash = await queryOne<{ id: string }>('SELECT id FROM dashboards WHERE lower(name) = lower(?) AND id <> ?', [name, id]);
  if (clash) throw conflict('A dashboard with that name already exists.', 'dashboard_name_taken');
  if (row.name === name) return;
  await execute('UPDATE dashboards SET name = ?, updated_at = ? WHERE id = ?', [name, nowIso(), id]);
  audit({ action: 'dashboard.renamed', actorId, targetType: 'dashboard', targetId: id, detail: { from: row.name, to: name } });
}

export async function deleteDashboard(id: string, actorId: string | null): Promise<void> {
  if (BUILT_IN_DASHBOARDS[id]) throw conflict('A built-in dashboard cannot be deleted. Turn it off instead.', 'dashboard_built_in');
  const row = await findDashboard(id);
  if (!row) throw notFound('No such dashboard.');
  await transaction(async (client) => {
    await client.query('DELETE FROM announcements WHERE dashboard_id = ?', [id]);
    await client.query('DELETE FROM dashboards WHERE id = ?', [id]);
  });
  audit({ action: 'dashboard.deleted', actorId, targetType: 'dashboard', targetId: id, detail: { name: row.name } });
}

export async function dashboardIds(): Promise<Set<string>> {
  return new Set((await listDashboards()).map((d) => d.id));
}

export async function setDashboardEnabled(id: string, enabled: boolean, actorId: string | null): Promise<void> {
  const row = await findDashboard(id);
  if (!row) throw notFound('No such dashboard.');
  await execute('UPDATE dashboards SET is_enabled = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, nowIso(), id]);
  audit({ action: 'dashboard.' + (enabled ? 'enabled' : 'disabled'), actorId, targetType: 'dashboard', targetId: id });
}

export async function saveAvailabilityOptions(id: string, options: AvailabilityOptions, actorId: string | null): Promise<void> {
  await execute('UPDATE dashboards SET dashboard_options = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(options),
    nowIso(),
    id,
  ]);
  audit({ action: 'dashboard.options_changed', actorId, targetType: 'dashboard', targetId: id, detail: { ...options } });
}

export async function saveDashboardDesign(
  id: string,
  design: 'standard' | 'custom',
  html: string,
  actorId: string | null,
): Promise<void> {
  await execute('UPDATE dashboards SET design = ?, custom_html = ?, updated_at = ? WHERE id = ?', [
    design,
    html,
    nowIso(),
    id,
  ]);
  audit({ action: 'dashboard.design_changed', actorId, targetType: 'dashboard', targetId: id, detail: { design } });
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface LocationRow {
  id: string;
  name: string;
  visible_to_everyone: boolean;
  created_at: string;
  /** User groups that may see it, when not everyone. */
  groupIds: string[];
}

export async function listLocations(): Promise<LocationRow[]> {
  const rows = await query<Omit<LocationRow, 'groupIds'>>('SELECT * FROM locations ORDER BY lower(name)');
  const links = await query<{ location_id: string; group_id: string }>('SELECT * FROM location_visibility');
  return rows.map((r) => ({
    ...r,
    groupIds: links.filter((l) => l.location_id === r.id).map((l) => l.group_id),
  }));
}

export interface LocationInput {
  name: string;
  everyone: boolean;
  groupIds: string[];
}

async function assertLocationName(name: string, exceptId: string | null): Promise<void> {
  const clash = await queryOne<{ id: string }>('SELECT id FROM locations WHERE lower(name) = lower(?)', [name]);
  if (clash && clash.id !== exceptId) throw conflict('A location with that name already exists.', 'location_exists');
}

async function writeVisibility(client: { query: (sql: string, params?: unknown[]) => unknown }, id: string, input: LocationInput): Promise<void> {
  await client.query('DELETE FROM location_visibility WHERE location_id = ?', [id]);
  if (input.everyone) return;
  for (const groupId of new Set(input.groupIds)) {
    await client.query('INSERT INTO location_visibility (location_id, group_id) VALUES (?, ?)', [id, groupId]);
  }
}

export async function createLocation(input: LocationInput, actorId: string | null): Promise<string> {
  await assertLocationName(input.name, null);
  const id = newId();
  await transaction(async (client) => {
    await client.query('INSERT INTO locations (id, name, visible_to_everyone, created_at) VALUES (?, ?, ?, ?)', [
      id,
      input.name,
      input.everyone ? 1 : 0,
      nowIso(),
    ]);
    await writeVisibility(client, id, input);
  });
  audit({ action: 'location.created', actorId, targetType: 'location', targetId: id, detail: { ...input } });
  return id;
}

export async function updateLocation(id: string, input: LocationInput, actorId: string | null): Promise<void> {
  const row = await queryOne<{ id: string }>('SELECT id FROM locations WHERE id = ?', [id]);
  if (!row) throw notFound('That location no longer exists.');
  await assertLocationName(input.name, id);
  await transaction(async (client) => {
    await client.query('UPDATE locations SET name = ?, visible_to_everyone = ? WHERE id = ?', [
      input.name,
      input.everyone ? 1 : 0,
      id,
    ]);
    await writeVisibility(client, id, input);
  });
  audit({ action: 'location.updated', actorId, targetType: 'location', targetId: id, detail: { ...input } });
}

export async function deleteLocation(id: string, actorId: string | null): Promise<void> {
  await execute('DELETE FROM locations WHERE id = ?', [id]);
  audit({ action: 'location.deleted', actorId, targetType: 'location', targetId: id });
}

// ---------------------------------------------------------------------------
// A technician's availability
// ---------------------------------------------------------------------------

export interface WeekRow {
  user_id: string;
  weekday: number;
  status: AvailabilityStatus;
  location_id: string | null;
}

export interface EntryRow {
  id: string;
  user_id: string;
  starts_on: string;
  ends_on: string;
  status: AvailabilityStatus;
  location_id: string | null;
  created_at: string;
}

export function usualWeek(userId: string): Promise<WeekRow[]> {
  return query<WeekRow>('SELECT * FROM availability_week WHERE user_id = ? ORDER BY weekday', [userId]);
}

/** Replaces the usual week. A day with no status is simply not stored. */
export async function setUsualWeek(
  userId: string,
  days: { weekday: number; status: AvailabilityStatus | ''; locationId: string | null }[],
): Promise<void> {
  await transaction(async (client) => {
    await client.query('DELETE FROM availability_week WHERE user_id = ?', [userId]);
    for (const day of days) {
      if (!day.status) continue;
      await client.query('INSERT INTO availability_week (user_id, weekday, status, location_id) VALUES (?, ?, ?, ?)', [
        userId,
        day.weekday,
        day.status,
        day.status === 'office' ? day.locationId : null,
      ]);
    }
  });
}

/** Dated entries that have not ended yet, soonest first. */
export function upcomingEntries(userId: string, today: string): Promise<EntryRow[]> {
  return query<EntryRow>(
    'SELECT * FROM availability_entries WHERE user_id = ? AND ends_on >= ? ORDER BY starts_on, created_at',
    [userId, today],
  );
}

export async function addEntry(
  userId: string,
  input: { startsOn: string; endsOn: string; status: AvailabilityStatus; locationId: string | null },
): Promise<void> {
  await execute(
    `INSERT INTO availability_entries (id, user_id, starts_on, ends_on, status, location_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      userId,
      input.startsOn,
      input.endsOn,
      input.status,
      input.status === 'office' || input.status === 'business_trip' ? input.locationId : null,
      nowIso(),
    ],
  );
}

/** Removes one of the user's own entries. Somebody else's is "not found". */
export async function deleteEntry(userId: string, id: string): Promise<void> {
  await execute('DELETE FROM availability_entries WHERE id = ? AND user_id = ?', [id, userId]);
}

// ---------------------------------------------------------------------------
// Dates, in the Locale time zone
// ---------------------------------------------------------------------------

/** "2026-10-12" for today where the service desk is. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** 1 = Monday ... 7 = Sunday, for a yyyy-mm-dd date. */
export function isoWeekday(date: string): number {
  const day = new Date(date + 'T12:00:00Z').getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value + 'T12:00:00Z').getTime()) &&
    new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------
// Drawing the dashboard
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Technician {
  id: string;
  display_name: string;
}

/** Everyone who counts as a technician for this dashboard. */
async function technicians(options: AvailabilityOptions): Promise<Technician[]> {
  // Agents, and administrators who are in a technician group - the
  // break-glass account included: putting it in a group says it is
  // somebody's colleague, and leaving it out silently looked like a bug.
  const base = `SELECT u.id, u.display_name FROM users u
     WHERE u.status = 'active'
       AND (u.role = 'agent' OR (u.role = 'admin' AND u.id IN (SELECT user_id FROM technician_group_members)))`;
  if (options.groupIds.length === 0) {
    return query<Technician>(base + ' ORDER BY lower(u.display_name)');
  }
  return query<Technician>(
    base + ' AND u.id IN (SELECT user_id FROM technician_group_members WHERE group_id IN (' +
      options.groupIds.map(() => '?').join(', ') + ')) ORDER BY lower(u.display_name)',
    options.groupIds,
  );
}

interface Cell {
  status: AvailabilityStatus;
  locationId: string | null;
}

/** Who may read which location: null means every one of them. */
async function visibleLocations(viewer: UserRow | null): Promise<{ names: Map<string, string>; allowed: Set<string> | null }> {
  const locations = await listLocations();
  const names = new Map(locations.map((l) => [l.id, l.name]));
  if (viewer && viewer.role !== 'user') return { names, allowed: null };
  const groups = viewer ? new Set((await userGroupsFor(viewer.id)).map((g) => g.id)) : new Set<string>();
  const allowed = new Set(
    locations.filter((l) => l.visible_to_everyone || l.groupIds.some((g) => groups.has(g))).map((l) => l.id),
  );
  return { names, allowed };
}

export interface AvailabilityData {
  today: string;
  days: string[];
  rows: { name: string; cells: (Cell | null)[] }[];
}

/** Each technician's status on each day, from their week and dated entries. */
export async function availabilityData(options: AvailabilityOptions, today: string): Promise<AvailabilityData> {
  const monday = addDays(today, 1 - isoWeekday(today));
  const days = options.view === 'week' ? [0, 1, 2, 3, 4].map((i) => addDays(monday, i)) : [today];
  const people = await technicians(options);
  if (people.length === 0) return { today, days, rows: [] };

  const ids = people.map((p) => p.id);
  const marks = ids.map(() => '?').join(', ');
  const weeks = await query<WeekRow>('SELECT * FROM availability_week WHERE user_id IN (' + marks + ')', ids);
  const entries = await query<EntryRow>(
    'SELECT * FROM availability_entries WHERE user_id IN (' + marks + ') AND ends_on >= ? AND starts_on <= ? ORDER BY created_at DESC',
    [...ids, days[0], days[days.length - 1]],
  );

  const rows = people.map((p) => ({
    name: p.display_name,
    cells: days.map((day): Cell | null => {
      // The newest dated entry covering the day wins over the usual week.
      const entry = entries.find((e) => e.user_id === p.id && e.starts_on <= day && e.ends_on >= day);
      if (entry) return { status: entry.status, locationId: entry.location_id };
      const usual = weeks.find((w) => w.user_id === p.id && w.weekday === isoWeekday(day));
      return usual ? { status: usual.status, locationId: usual.location_id } : null;
    }),
  }));
  return { today, days, rows };
}

function cellMarkup(
  cell: Cell | null,
  options: AvailabilityOptions,
  locations: { names: Map<string, string>; allowed: Set<string> | null },
): string {
  if (!cell) return '<span class="availability__status availability__status--unset">-</span>';
  const spec = AVAILABILITY_STATUSES.find((s) => s.key === cell.status);
  const named = options.statuses.includes(cell.status);
  const label = named ? statusLabel(cell.status) : spec?.available ? 'Available' : 'Not available';
  const cls = named ? cell.status : spec?.available ? 'available' : 'unavailable';
  let out = '<span class="availability__status availability__status--' + cls + '">' + escapeHtml(label) + '</span>';
  const canSee = cell.locationId && (locations.allowed === null || locations.allowed.has(cell.locationId));
  if (named && options.showLocation && canSee) {
    out += ' <span class="availability__location">' + escapeHtml(locations.names.get(cell.locationId!) ?? '') + '</span>';
  }
  return out;
}

function dayLabel(date: string, long: boolean): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(date + 'T12:00:00Z'));
}

/** Everything a design can place, for one reader. */
async function availabilityParts(row: DashboardRow, viewer: UserRow | null, now: Date) {
  const options = availabilityOptions(row);
  const today = todayIn(settings().locale.timeZone, now);
  const locations = await visibleLocations(viewer);
  const todayData = await availabilityData({ ...options, view: 'today' }, today);
  const todayRows = todayData.rows.filter((r) => r.cells[0] !== null);

  const list = todayRows.length === 0
    ? '<p class="availability__empty">Nobody has shared their availability for today.</p>'
    : '<ul class="availability-list">' +
      todayRows.map((r) =>
        '<li class="availability"><span class="availability__name">' + escapeHtml(r.name) + '</span> ' +
          cellMarkup(r.cells[0]!, options, locations) + '</li>',
      ).join('') +
      '</ul>';

  const weekData = await availabilityData({ ...options, view: 'week' }, today);
  const weekRows = weekData.rows.filter((r) => r.cells.some((c) => c !== null));
  const week = weekRows.length === 0
    ? '<p class="availability__empty">Nobody has shared their availability for this week.</p>'
    : '<div class="table-scroll"><table class="table availability-week"><thead><tr><th scope="col">Technician</th>' +
      weekData.days.map((d) =>
        '<th scope="col"' + (d === today ? ' class="availability-week__today"' : '') + '>' + escapeHtml(dayLabel(d, false)) + '</th>',
      ).join('') +
      '</tr></thead><tbody>' +
      weekRows.map((r) =>
        '<tr><th scope="row">' + escapeHtml(r.name) + '</th>' +
          r.cells.map((c) => '<td>' + cellMarkup(c, options, locations) + '</td>').join('') + '</tr>',
      ).join('') +
      '</tbody></table></div>';

  const counts = new Map<string, number>();
  let available = 0;
  for (const r of todayRows) {
    const status = r.cells[0]!.status;
    counts.set(status, (counts.get(status) ?? 0) + 1);
    if (AVAILABILITY_STATUSES.find((s) => s.key === status)?.available) available += 1;
  }
  return {
    options,
    title: escapeHtml(row.name),
    date: escapeHtml(formatDateIn(new Date(today + 'T12:00:00Z'), { ...settings().locale, timeZone: 'UTC' })),
    dateLong: escapeHtml(dayLabel(today, true)),
    list,
    week,
    available,
    unavailable: todayRows.length - available,
    counts,
  };
}

/**
 * One dashboard's markup for one reader, or '' when it is switched off.
 * `viewer` null means a requester in no user group - what the settings
 * preview shows.
 */
export async function renderDashboard(
  row: DashboardRow,
  viewer: UserRow | null,
  options: { ignoreEnabled?: boolean; now?: Date } = {},
): Promise<string> {
  if (!row.is_enabled && !options.ignoreEnabled) return '';
  const now = options.now ?? new Date();
  if (row.kind !== 'technician_availability') return renderOther(row, viewer, now);
  const parts = await availabilityParts(row, viewer, now);

  if (row.design === 'custom' && row.custom_html.trim() !== '') {
    const body = row.custom_html.replace(DASHBOARD_VARIABLE, (whole, name: string, arg: string | undefined) => {
      if (arg) return name === 'count' ? String(parts.counts.get(arg) ?? 0) : whole;
      switch (name) {
        case 'title': return parts.title;
        case 'date': return parts.date;
        case 'today': return parts.list;
        case 'week': return parts.week;
        case 'available_count': return String(parts.available);
        case 'unavailable_count': return String(parts.unavailable);
        default: return whole;
      }
    });
    return '<section class="dashboard dashboard--custom" data-dashboard="' + escapeHtml(row.id) + '">' + body + '</section>';
  }

  return (
    '<section class="dashboard dashboard--availability" data-dashboard="' + escapeHtml(row.id) + '">' +
    '<div class="dashboard__head"><h2 class="dashboard__title">' + parts.title + '</h2>' +
    '<span class="dashboard__date">' + parts.dateLong + '</span></div>' +
    (parts.options.view === 'week' ? parts.week : parts.list) +
    '</section>'
  );
}

// ---------------------------------------------------------------------------
// My tickets, Announcements, Service desk at a glance
// ---------------------------------------------------------------------------

interface Drawn {
  /** The standard design; '' to show nothing at all. */
  standard: string;
  vars: Record<string, string>;
}

function stat(value: string | number, label: string): string {
  return '<div class="dashboard-stat"><span class="dashboard-stat__value">' + escapeHtml(String(value)) +
    '</span><span class="dashboard-stat__label">' + escapeHtml(label) + '</span></div>';
}

function head(title: string): string {
  return '<div class="dashboard__head"><h2 class="dashboard__title">' + title + '</h2></div>';
}

/** The reader's own tickets. Shown as an empty example in the settings preview. */
async function drawMyTickets(row: DashboardRow, viewer: UserRow | null): Promise<Drawn> {
  const title = escapeHtml(row.name);
  const id = viewer?.id ?? '';
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const counts = await queryOne<{ open: number; hold: number; resolved: number }>(
    `SELECT
       sum(CASE WHEN status IN ('open', 'in_progress') THEN 1 ELSE 0 END) AS open,
       sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS hold,
       sum(CASE WHEN status IN ('resolved', 'closed') AND coalesce(resolved_at, closed_at) >= ? THEN 1 ELSE 0 END) AS resolved
     FROM tickets WHERE requester_id = ? AND parent_id IS NULL`,
    [since, id],
  );
  const recent = await query<{ id: string; title: string; status: TicketStatus; ref_prefix: string; ref_seq: number }>(
    'SELECT id, title, status, ref_prefix, ref_seq FROM tickets WHERE requester_id = ? AND parent_id IS NULL ORDER BY updated_at DESC LIMIT 5',
    [id],
  );
  const list = recent.length === 0
    ? '<p class="dashboard__empty">' + (viewer ? 'You have no tickets yet.' : 'The reader\'s own tickets appear here.') + '</p>'
    : '<ul class="dashboard-list">' +
      recent.map((t) =>
        '<li><a href="/tickets/' + escapeHtml(t.id) + '">' + escapeHtml(t.title) + '</a> <span class="dashboard-list__meta">' +
          escapeHtml(ticketReference(Number(t.ref_seq), t.ref_prefix)) + ' - ' + escapeHtml(STATUS_LABELS[t.status] ?? t.status) + '</span></li>',
      ).join('') +
      '</ul>';
  const open = Number(counts?.open ?? 0);
  const hold = Number(counts?.hold ?? 0);
  const resolved = Number(counts?.resolved ?? 0);
  return {
    standard:
      head(title) +
      '<div class="dashboard-stats">' + stat(open, 'Open') + stat(hold, 'On hold') + stat(resolved, 'Resolved, 30 days') + '</div>' +
      list,
    vars: { title, open_count: String(open), on_hold_count: String(hold), resolved_count: String(resolved), list },
  };
}

const SEVERITY_ORDER = { outage: 0, warning: 1, info: 2 } as const;
const SEVERITY_LABELS = { outage: 'Outage', warning: 'Warning', info: 'Information' } as const;
export type Severity = keyof typeof SEVERITY_LABELS;
export const SEVERITIES = (Object.keys(SEVERITY_LABELS) as Severity[]).map((key) => ({ key, label: SEVERITY_LABELS[key] }));

/** Current announcements; with none, nothing is shown at all. */
async function drawAnnouncements(row: DashboardRow, now: Date): Promise<Drawn> {
  const title = escapeHtml(row.name);
  const today = todayIn(settings().locale.timeZone, now);
  const current = (await activeAnnouncements(today, row.id)).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const list = current
    .map((a) =>
      '<div class="announcement announcement--' + a.severity + '"><p class="announcement__title"><span class="announcement__severity">' +
        SEVERITY_LABELS[a.severity] + '</span> ' + escapeHtml(a.title) + '</p>' +
        (a.body ? '<p class="announcement__body">' + escapeHtml(a.body).replace(/\n/g, '<br>') + '</p>' : '') + '</div>',
    )
    .join('');
  return {
    standard: current.length === 0 ? '' : head(title) + list,
    vars: { title, count: String(current.length), list },
  };
}

/** How busy the service desk is: nothing about anybody in particular. */
async function drawServiceDesk(row: DashboardRow, now: Date): Promise<Drawn> {
  const title = escapeHtml(row.name);
  const today = todayIn(settings().locale.timeZone, now);
  // Scoped to chosen technician groups: one condition, its own parameters,
  // added to each query below.
  const groups = serviceDeskGroups(row);
  const scope = groups.length === 0 ? '' : ' AND group_id IN (' + groups.map(() => '?').join(', ') + ')';
  const openRow = await queryOne<{ c: number }>(
    "SELECT count(*) AS c FROM tickets WHERE parent_id IS NULL AND status IN ('open', 'in_progress', 'pending')" + scope,
    groups,
  );
  const recent = await query<{ created_at: string; resolved_at: string }>(
    'SELECT created_at, resolved_at FROM tickets WHERE parent_id IS NULL AND resolved_at IS NOT NULL AND resolved_at >= ?' + scope,
    [new Date(now.getTime() - 30 * 86_400_000).toISOString(), ...groups],
  );
  const created = await query<{ created_at: string }>(
    'SELECT created_at FROM tickets WHERE parent_id IS NULL AND created_at >= ?' + scope,
    [new Date(now.getTime() - 2 * 86_400_000).toISOString(), ...groups],
  );
  const raisedToday = created.filter((t) => todayIn(settings().locale.timeZone, new Date(t.created_at)) === today).length;
  const hours = recent
    .map((t) => (new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime()) / 3_600_000)
    .filter((h) => h >= 0)
    .sort((a, b) => a - b);
  const median = hours.length === 0 ? null : hours[Math.floor(hours.length / 2)]!;
  const typical =
    median === null ? '-' : median < 1 ? 'under an hour' : median < 48 ? 'about ' + Math.round(median) + ' h' : 'about ' + Math.round(median / 24) + ' days';
  const open = Number(openRow?.c ?? 0);
  return {
    standard:
      head(title) +
      '<div class="dashboard-stats">' + stat(open, 'Open now') + stat(raisedToday, 'Raised today') + stat(typical, 'Typical resolution') + '</div>',
    vars: { title, open_count: String(open), today_count: String(raisedToday), typical_resolution: escapeHtml(typical) },
  };
}

async function renderOther(row: DashboardRow, viewer: UserRow | null, now: Date): Promise<string> {
  const drawn =
    row.kind === 'my_tickets'
      ? await drawMyTickets(row, viewer)
      : row.kind === 'announcements'
        ? await drawAnnouncements(row, now)
        : await drawServiceDesk(row, now);
  const id = escapeHtml(row.id);
  if (row.design === 'custom' && row.custom_html.trim() !== '') {
    // Announcements with nothing current show nothing, whatever the design.
    if (row.kind === 'announcements' && drawn.vars.count === '0') return '';
    const body = row.custom_html.replace(DASHBOARD_VARIABLE, (whole, name: string, arg: string | undefined) =>
      arg ? whole : (drawn.vars[name] ?? whole),
    );
    return '<section class="dashboard dashboard--custom" data-dashboard="' + id + '">' + body + '</section>';
  }
  if (!drawn.standard) return '';
  return '<section class="dashboard dashboard--' + escapeHtml(row.kind) + '" data-dashboard="' + id + '">' + drawn.standard + '</section>';
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  severity: Severity;
  starts_on: string;
  ends_on: string | null;
  created_by: string | null;
  created_at: string;
  dashboard_id: string;
}

/** One Announcements dashboard's notices. */
export function listAnnouncements(dashboardId: string): Promise<AnnouncementRow[]> {
  return query<AnnouncementRow>('SELECT * FROM announcements WHERE dashboard_id = ? ORDER BY starts_on DESC, created_at DESC', [dashboardId]);
}

export function activeAnnouncements(today: string, dashboardId: string): Promise<AnnouncementRow[]> {
  return query<AnnouncementRow>(
    'SELECT * FROM announcements WHERE dashboard_id = ? AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?) ORDER BY created_at DESC',
    [dashboardId, today, today],
  );
}

export function announcementProblems(input: { title: string; body: string; severity: string; startsOn: string; endsOn: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.title.trim() || input.title.length > 120) errors.title = 'Give it a title of up to 120 characters.';
  if (input.body.length > 2000) errors.body = 'Keep it under 2,000 characters.';
  if (!(input.severity in SEVERITY_LABELS)) errors.severity = 'Choose how serious it is.';
  if (!isDate(input.startsOn)) errors.startsOn = 'Choose the first day it shows.';
  if (input.endsOn && (!isDate(input.endsOn) || input.endsOn < input.startsOn)) errors.endsOn = 'The last day must be on or after the first.';
  return errors;
}

export async function createAnnouncement(
  dashboardId: string,
  input: { title: string; body: string; severity: Severity; startsOn: string; endsOn: string },
  actorId: string | null,
): Promise<string> {
  const id = newId();
  await execute(
    'INSERT INTO announcements (id, title, body, severity, starts_on, ends_on, created_by, created_at, dashboard_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.title.trim(), input.body.trim(), input.severity, input.startsOn, input.endsOn || null, actorId, nowIso(), dashboardId],
  );
  audit({ action: 'dashboard.announcement.created', actorId, targetType: 'announcement', targetId: id, detail: { title: input.title.trim(), severity: input.severity } });
  return id;
}

export async function deleteAnnouncement(dashboardId: string, id: string, actorId: string | null): Promise<void> {
  await execute('DELETE FROM announcements WHERE id = ? AND dashboard_id = ?', [id, dashboardId]);
  audit({ action: 'dashboard.announcement.deleted', actorId, targetType: 'announcement', targetId: id });
}

/** Every enabled dashboard, drawn for this reader: the standard look's panel. */
export async function enabledDashboards(viewer: UserRow): Promise<string[]> {
  const rows = (await listDashboards()).filter((d) => d.is_enabled);
  return Promise.all(rows.map((r) => renderDashboard(r, viewer)));
}

/** Pre-drawn markup for each `{{dashboard:<id>}}` a portal uses. */
export async function dashboardsForPortal(sources: string[], viewer: UserRow | null): Promise<Map<string, string>> {
  const wanted = new Set<string>();
  for (const source of sources) {
    for (const m of source.matchAll(/\{\{\s*dashboard\s*:\s*([A-Za-z0-9-]+)\s*\}\}/g)) wanted.add(m[1]!);
  }
  const out = new Map<string, string>();
  for (const id of wanted) {
    const row = await findDashboard(id);
    out.set(id, row ? await renderDashboard(row, viewer) : '');
  }
  return out;
}
