import { execute, query, queryOne, sqlJsonText } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import { CUSTOM_FIELD_TYPES } from './templates.js';
import { BLANK, columnClauses, MAX_VALUES, withoutColumn, type ColumnFilters, type ColumnValue } from '../lib/column-filters.js';
import { findUserByEmail, findUserById, type UserRow } from './users.js';
import { settings } from '../settings/index.js';

/**
 * Assets (asked for 21 Oct 2026): laptops, phones and the like, assigned to
 * people, with columns an administrator shapes.
 *
 * - **Columns** (`asset_columns`, migration 67): ten built in - Model,
 *   Assigned to, Date bought, Serial number, IMEI / Other, PO number, Type,
 *   Vendor, Company, Comment - each of which can be renamed, switched off or
 *   given another format, and any number added. A column's `key` never
 *   changes: it is the variable a document or a notification writes
 *   ({{SerialNumber}}), so renaming the label breaks nothing.
 * - **Assigned to** is always a person (format `person`, fixed): it is what
 *   notifications and automations act on. It is stored in `assets.assigned_to`,
 *   not among the values, so a deleted account leaves the asset unassigned.
 * - **Status** is its own list (`asset_statuses`), editable, and always shown.
 * - **Every change is history** (`asset_events`): who, what, before and after.
 * - Who may: `assets.manage` (auth/permissions.ts); the columns and statuses
 *   are Settings - Assets (`settings.assets`).
 */

export const ASSIGNED_TO = 'AssignedTo';

/** The formats a column can have; `person` belongs to Assigned to alone. */
export const ASSET_FORMATS = CUSTOM_FIELD_TYPES;
export type AssetFormat = (typeof ASSET_FORMATS)[number]['key'] | 'person';
const hasChoices = (format: string) => format === 'select' || format === 'multiselect';

export interface AssetColumn {
  key: string;
  label: string;
  format: AssetFormat;
  choices: string[];
  is_enabled: boolean;
  is_builtin: boolean;
  sort_order: number;
}

export interface AssetStatus {
  id: string;
  name: string;
  sort_order: number;
}

export interface AssetRow {
  id: string;
  status_id: string | null;
  assigned_to: string | null;
  field_values: Record<string, string>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetListItem extends AssetRow {
  status_name: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
}

type Actor = { id: string; email?: string } | null;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function columnOf(row: AssetColumn & { choices: unknown }): AssetColumn {
  return { ...row, choices: Array.isArray(row.choices) ? (row.choices as string[]) : [], sort_order: Number(row.sort_order) };
}

export async function listColumns(): Promise<AssetColumn[]> {
  const rows = await query<AssetColumn & { choices: unknown }>('SELECT * FROM asset_columns ORDER BY sort_order, key');
  return rows.map(columnOf);
}

/** The columns switched on, in order. */
export async function enabledColumns(): Promise<AssetColumn[]> {
  return (await listColumns()).filter((c) => c.is_enabled);
}

/** A key from a label: "Purchase price" -> PurchasePrice, unique among the columns. */
function keyFrom(label: string, taken: Set<string>): string {
  const base =
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join('')
      .replace(/^[0-9]+/, '')
      .slice(0, 40) || 'Column';
  let key = base;
  for (let n = 2; taken.has(key.toLowerCase()); n += 1) key = base + n;
  return key;
}

export interface ColumnInput {
  label: string;
  format: string;
  choices: string[];
  enabled: boolean;
}

function columnProblems(input: ColumnInput, column: AssetColumn | null): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!input.label.trim()) problems.label = 'Give the column a name.';
  else if (input.label.length > 60) problems.label = 'Keep the name under 60 characters.';
  const person = column?.format === 'person';
  if (!person && !ASSET_FORMATS.some((f) => f.key === input.format)) problems.format = 'Choose a format.';
  if (!person && hasChoices(input.format) && input.choices.length < 2) problems.choices = 'A choice needs at least two options, one per line.';
  if (input.choices.length > 50) problems.choices = 'At most 50 options.';
  return problems;
}

const cleanChoices = (choices: string[]) => [...new Set(choices.map((c) => c.trim()).filter(Boolean))].map((c) => c.slice(0, 100));

export async function addColumn(input: ColumnInput, actor: Actor): Promise<string> {
  const problems = columnProblems(input, null);
  if (Object.keys(problems).length) throw badRequest(Object.values(problems)[0]!, 'bad_column');
  const columns = await listColumns();
  const key = keyFrom(input.label, new Set(columns.map((c) => c.key.toLowerCase())));
  const last = columns.reduce((max, c) => Math.max(max, c.sort_order), 0);
  await execute(
    'INSERT INTO asset_columns (key, label, format, choices, is_enabled, is_builtin, sort_order, created_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)',
    [key, input.label.trim(), input.format, JSON.stringify(hasChoices(input.format) ? cleanChoices(input.choices) : []), last + 10, nowIso()],
  );
  audit({ action: 'asset_column.created', actorId: actor?.id ?? null, targetType: 'asset_column', targetId: key, detail: { label: input.label, format: input.format } });
  return key;
}

export async function updateColumn(key: string, input: ColumnInput, actor: Actor): Promise<void> {
  const column = (await listColumns()).find((c) => c.key === key);
  if (!column) throw notFound('That column no longer exists.');
  const problems = columnProblems(input, column);
  if (Object.keys(problems).length) throw badRequest(Object.values(problems)[0]!, 'bad_column');
  // Assigned to keeps its format: it is a person, whatever it is called.
  const format = column.format === 'person' ? 'person' : input.format;
  await execute('UPDATE asset_columns SET label = ?, format = ?, choices = ?, is_enabled = ? WHERE key = ?', [
    input.label.trim(),
    format,
    JSON.stringify(hasChoices(format) ? cleanChoices(input.choices) : []),
    input.enabled ? 1 : 0,
    key,
  ]);
  audit({ action: 'asset_column.updated', actorId: actor?.id ?? null, targetType: 'asset_column', targetId: key, detail: { label: input.label, format, enabled: input.enabled } });
}

/** Moves a column one place up or down. */
export async function moveColumn(key: string, direction: 'up' | 'down'): Promise<void> {
  const columns = await listColumns();
  const at = columns.findIndex((c) => c.key === key);
  const other = columns[direction === 'up' ? at - 1 : at + 1];
  if (at < 0 || !other) return;
  const mine = columns[at]!;
  await execute('UPDATE asset_columns SET sort_order = ? WHERE key = ?', [other.sort_order, mine.key]);
  await execute('UPDATE asset_columns SET sort_order = ? WHERE key = ?', [mine.sort_order === other.sort_order ? mine.sort_order + (direction === 'up' ? 1 : -1) : mine.sort_order, other.key]);
}

/** Only a column of your own; a built-in one is switched off instead. The values stay in the assets. */
export async function deleteColumn(key: string, actor: Actor): Promise<void> {
  const column = (await listColumns()).find((c) => c.key === key);
  if (!column) throw notFound('That column no longer exists.');
  if (column.is_builtin) throw conflict('A built-in column is switched off rather than removed.', 'builtin_column');
  await execute('DELETE FROM asset_columns WHERE key = ?', [key]);
  audit({ action: 'asset_column.deleted', actorId: actor?.id ?? null, targetType: 'asset_column', targetId: key, detail: { label: column.label } });
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export async function listStatuses(): Promise<AssetStatus[]> {
  const rows = await query<AssetStatus>('SELECT id, name, sort_order FROM asset_statuses ORDER BY sort_order, name');
  return rows.map((s) => ({ ...s, sort_order: Number(s.sort_order) }));
}

function statusName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) throw badRequest('Give the status a name.', 'bad_status');
  if (n.length > 40) throw badRequest('Keep the name under 40 characters.', 'bad_status');
  return n;
}

export async function addStatus(name: string, actor: Actor): Promise<string> {
  const n = statusName(name);
  const statuses = await listStatuses();
  if (statuses.some((s) => s.name.toLowerCase() === n.toLowerCase())) throw conflict('There is already a status with that name.', 'status_taken');
  const id = newId();
  const last = statuses.reduce((max, s) => Math.max(max, s.sort_order), 0);
  await execute('INSERT INTO asset_statuses (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)', [id, n, last + 10, nowIso()]);
  audit({ action: 'asset_status.created', actorId: actor?.id ?? null, targetType: 'asset_status', targetId: id, detail: { name: n } });
  return id;
}

export async function renameStatus(id: string, name: string, actor: Actor): Promise<void> {
  const n = statusName(name);
  const statuses = await listStatuses();
  if (!statuses.some((s) => s.id === id)) throw notFound('That status no longer exists.');
  if (statuses.some((s) => s.id !== id && s.name.toLowerCase() === n.toLowerCase())) throw conflict('There is already a status with that name.', 'status_taken');
  await execute('UPDATE asset_statuses SET name = ? WHERE id = ?', [n, id]);
  audit({ action: 'asset_status.renamed', actorId: actor?.id ?? null, targetType: 'asset_status', targetId: id, detail: { name: n } });
}

export async function moveStatus(id: string, direction: 'up' | 'down'): Promise<void> {
  const statuses = await listStatuses();
  const at = statuses.findIndex((s) => s.id === id);
  const other = statuses[direction === 'up' ? at - 1 : at + 1];
  if (at < 0 || !other) return;
  const mine = statuses[at]!;
  await execute('UPDATE asset_statuses SET sort_order = ? WHERE id = ?', [other.sort_order, mine.id]);
  await execute('UPDATE asset_statuses SET sort_order = ? WHERE id = ?', [mine.sort_order === other.sort_order ? mine.sort_order + (direction === 'up' ? 1 : -1) : mine.sort_order, other.id]);
}

/** Only a status no asset has: moving assets off it is a decision about each of them. */
export async function deleteStatus(id: string, actor: Actor): Promise<void> {
  const used = await queryOne<{ c: number }>('SELECT count(*) AS c FROM assets WHERE status_id = ?', [id]);
  if (Number(used?.c ?? 0) > 0) throw conflict('Assets have this status. Give them another first.', 'status_in_use');
  if ((await listStatuses()).length <= 1) throw conflict('Keep at least one status.', 'last_status');
  await execute('DELETE FROM asset_statuses WHERE id = ?', [id]);
  audit({ action: 'asset_status.deleted', actorId: actor?.id ?? null, targetType: 'asset_status', targetId: id });
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * What is wrong with these values, by column key. A browser can post
 * anything, so a choice must be one of its options, a date a date, a
 * number a number. Unknown keys are dropped by cleanValues, not refused.
 */
export function valueProblems(columns: readonly AssetColumn[], values: Record<string, string>): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const column of columns) {
    if (column.format === 'person') continue;
    const value = (values[column.key] ?? '').trim();
    if (!value) continue;
    const name = column.label;
    switch (column.format) {
      case 'select':
        if (!column.choices.includes(value)) problems[column.key] = name + ': choose one of the options.';
        break;
      case 'multiselect':
        if (value.split(/\s*,\s*/).some((v) => !column.choices.includes(v))) problems[column.key] = name + ': choose from the options.';
        break;
      case 'date':
        if (!parseAssetDate(value)) problems[column.key] = name + ': "' + value.slice(0, 40) + '" is not a date. Write it as 2026-10-21 or 21.10.2026.';
        break;
      case 'number':
        if (!/^-?\d+(?:[.,]\d+)?$/.test(value)) problems[column.key] = name + ': enter a number.';
        break;
      case 'textarea':
        if (value.length > 5000) problems[column.key] = name + ': keep it under 5,000 characters.';
        break;
      default:
        if (value.length > 500) problems[column.key] = name + ': keep it under 500 characters.';
    }
  }
  return problems;
}

/** Only the columns there are (any, switched off or not), trimmed. */
/**
 * A date as people and spreadsheets write it, as 2026-10-21 - or null.
 *
 * The import template writes 2026-10-21, but opening it in Excel and saving
 * it again rewrites every date in the computer's own format: 21.10.2026 in
 * Czech, 21/10/2026 in British English, 10/21/2026 in American (reported
 * 22 Oct 2026, a template refused as it was downloaded). So the usual
 * writings are read: year first; day first with dots; slashes and dashes
 * with the order from Settings - Locale when both could be a month; a time
 * after the date is ignored; and an Excel day number (45951).
 */
export function parseAssetDate(input: string): string | null {
  const value = input.trim().replace(/[T\s]+\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[ap]m)?$/i, '');
  let y: number, m: number, d: number;
  let match: RegExpMatchArray | null;
  if ((match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = value.match(/^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})$/))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    y = Number(match[3]);
    // Whichever cannot be a month is the day; when both could be, the Locale says.
    const monthFirst = a > 12 ? false : b > 12 ? true : settings().locale.dateFormat === 'MM/dd/yyyy';
    [m, d] = monthFirst ? [a, b] : [b, a];
  } else if (/^\d{5}$/.test(value) && Number(value) > 20000 && Number(value) < 80000) {
    // An Excel day number: days since 30 Dec 1899.
    return new Date(Date.UTC(1899, 11, 30) + Number(value) * 86_400_000).toISOString().slice(0, 10);
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Dates as 2026-10-21 whatever way they were written; everything else as it came. */
function normaliseValues(columns: readonly AssetColumn[], values: Record<string, string>): Record<string, string> {
  const out = { ...values };
  for (const column of columns) {
    if (column.format !== 'date') continue;
    const iso = parseAssetDate(values[column.key] ?? '');
    if (iso) out[column.key] = iso;
  }
  return out;
}

function cleanValues(columns: readonly AssetColumn[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of columns) {
    if (column.format === 'person') continue;
    const value = (values[column.key] ?? '').trim();
    if (value) out[column.key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const LIST_SELECT = `SELECT a.*, s.name AS status_name, u.display_name AS assignee_name, u.email AS assignee_email
  FROM assets a
  LEFT JOIN asset_statuses s ON s.id = a.status_id
  LEFT JOIN users u ON u.id = a.assigned_to`;

function assetOf<T extends AssetRow>(row: T): T {
  const values = row.field_values && typeof row.field_values === 'object' ? row.field_values : {};
  return { ...row, field_values: values as Record<string, string> };
}

export async function getAsset(id: string): Promise<AssetListItem | undefined> {
  const row = await queryOne<AssetListItem>(LIST_SELECT + ' WHERE a.id = ?', [id]);
  return row ? assetOf(row) : undefined;
}

export interface AssetFilters {
  q?: string;
  statusId?: string;
  assignedTo?: string;
  /** 'none' for unassigned. */
  unassigned?: boolean;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
  /** Excel-like column filters (lib/column-filters.ts): ticked values per column key, or 'status'. */
  columns?: ColumnFilters;
}

const FROM = ' FROM assets a LEFT JOIN asset_statuses s ON s.id = a.status_id LEFT JOIN users u ON u.id = a.assigned_to';

/** The SQL for each column a header can filter on: the status, the person, every value by its key. */
async function columnExprs(): Promise<Record<string, string>> {
  const exprs: Record<string, string> = { status: 'a.status_id', [ASSIGNED_TO]: 'a.assigned_to' };
  for (const c of await listColumns()) if (c.format !== 'person') exprs[c.key] = sqlJsonText('a.field_values', c.key);
  return exprs;
}

/** The keys a header may filter on. */
export async function assetColumnKeys(): Promise<string[]> {
  return Object.keys(await columnExprs());
}

async function assetWhere(filters: AssetFilters): Promise<{ clause: string; params: unknown[] }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.q) {
    // Every word must appear in the values or the assignee's name or address.
    for (const word of filters.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = '%' + word.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      where.push("(lower(a.field_values) LIKE ? ESCAPE '\\' OR lower(coalesce(u.display_name, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(u.email, '')) LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
  }
  if (filters.statusId) {
    where.push('a.status_id = ?');
    params.push(filters.statusId);
  }
  if (filters.unassigned) where.push('a.assigned_to IS NULL');
  else if (filters.assignedTo) {
    where.push('a.assigned_to = ?');
    params.push(filters.assignedTo);
  }
  if (filters.columns) {
    const cols = columnClauses(filters.columns, await columnExprs());
    where.push(...cols.where);
    params.push(...cols.params);
  }
  return { clause: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

/**
 * One column's values, with how many assets have each, under every other
 * filter: what its header menu offers, as Excel's AutoFilter does.
 */
export async function assetColumnValues(filters: AssetFilters, key: string): Promise<ColumnValue[]> {
  const expr = (await columnExprs())[key];
  if (!expr) return [];
  const { clause, params } = await assetWhere({ ...filters, columns: withoutColumn(filters.columns ?? {}, key) });
  const label = key === 'status' ? 'max(s.name)' : key === ASSIGNED_TO ? 'max(u.display_name)' : 'max(' + expr + ')';
  const rows = await query<{ v: string | null; label: string | null; n: number }>(
    'SELECT ' + expr + ' AS v, ' + label + ' AS label, count(*) AS n' + FROM + clause + ' GROUP BY ' + expr + ' ORDER BY n DESC LIMIT ' + MAX_VALUES,
    params as never[],
  );
  return rows.map((r) => ({ value: r.v ?? BLANK, label: r.v ? (r.label ?? r.v) : '', count: Number(r.n) }));
}

/** A page of assets, searched, filtered and sorted in SQL. Sorting is a whitelist. */
export async function listAssets(filters: AssetFilters): Promise<{ items: AssetListItem[]; total: number }> {
  const { clause, params } = await assetWhere(filters);

  const columns = await listColumns();
  const dir = filters.dir === 'asc' ? 'ASC' : 'DESC';
  let order = 'a.updated_at ' + dir;
  if (filters.sort === 'status') order = 's.sort_order ' + dir + ', a.updated_at DESC';
  else if (filters.sort === ASSIGNED_TO) order = "lower(coalesce(u.display_name, '~')) " + dir;
  else if (filters.sort && columns.some((c) => c.key === filters.sort && c.format !== 'person')) {
    order = 'lower(coalesce(' + sqlJsonText('a.field_values', filters.sort) + ", '')) " + dir;
  }

  const perPage = Math.min(Math.max(filters.perPage ?? 50, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const total = await queryOne<{ n: number }>(
    'SELECT count(*) AS n' + FROM + clause,
    params as never[],
  );
  const rows = await query<AssetListItem>(LIST_SELECT + clause + ' ORDER BY ' + order + ', a.id LIMIT ? OFFSET ?', [
    ...(params as never[]),
    perPage,
    (page - 1) * perPage,
  ]);
  return { items: rows.map(assetOf), total: Number(total?.n ?? 0) };
}

/** Everything assigned to one person, for their pages. */
export async function assetsAssignedTo(userId: string): Promise<AssetListItem[]> {
  const rows = await query<AssetListItem>(LIST_SELECT + ' WHERE a.assigned_to = ? ORDER BY a.updated_at DESC LIMIT 100', [userId]);
  return rows.map(assetOf);
}

export interface AssetInput {
  statusId: string | null;
  /** An email address, or '' for nobody. */
  assignee: string;
  values: Record<string, string>;
}

/** The person an address names: an active account, or a refusal in words. */
async function assigneeOf(email: string): Promise<UserRow | null> {
  const typed = email.trim();
  if (!typed) return null;
  const person = await findUserByEmail(typed);
  if (!person || person.status !== 'active') throw badRequest('There is no active account with that address.', 'assignee_unknown');
  return person;
}

async function checkStatus(statusId: string | null): Promise<string | null> {
  if (!statusId) return null;
  if (!(await listStatuses()).some((s) => s.id === statusId)) throw badRequest('Choose one of the statuses.', 'bad_status');
  return statusId;
}

async function event(assetId: string, actor: Actor, kind: string, field = '', oldValue = '', newValue = ''): Promise<void> {
  await execute(
    'INSERT INTO asset_events (id, asset_id, actor_id, kind, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [newId(), assetId, actor?.id ?? null, kind, field, oldValue.slice(0, 500), newValue.slice(0, 500), nowIso()],
  );
}

/** What changed, for whoever reacts to assets (notifications, automations: later steps). */
export interface AssetChange {
  assetId: string;
  created: boolean;
  statusFrom: string | null;
  statusTo: string | null;
  assigneeFrom: string | null;
  assigneeTo: string | null;
  actorId: string | null;
}
type Listener = (change: AssetChange) => Promise<void>;
const listeners: Listener[] = [];
/** Registers something to run after an asset is created or changed. */
export function onAssetChange(listener: Listener): void {
  listeners.push(listener);
}
async function announce(change: AssetChange): Promise<void> {
  for (const listener of listeners) await listener(change);
}

export async function createAsset(asked: AssetInput, actor: Actor): Promise<string> {
  const columns = await listColumns();
  const input = { ...asked, values: normaliseValues(columns, asked.values) };
  const problems = valueProblems(columns, input.values);
  if (Object.keys(problems).length) throw badRequest(Object.values(problems)[0]!, 'bad_value');
  const statusId = await checkStatus(input.statusId);
  const assignee = await assigneeOf(input.assignee);
  const id = newId();
  const now = nowIso();
  await execute(
    'INSERT INTO assets (id, status_id, assigned_to, field_values, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, statusId, assignee?.id ?? null, JSON.stringify(cleanValues(columns, input.values)), actor?.id ?? null, now, now],
  );
  await event(id, actor, 'created');
  if (assignee) await event(id, actor, 'assigned', ASSIGNED_TO, '', assignee.display_name);
  audit({ action: 'asset.created', actorId: actor?.id ?? null, targetType: 'asset', targetId: id });
  await announce({ assetId: id, created: true, statusFrom: null, statusTo: statusId, assigneeFrom: null, assigneeTo: assignee?.id ?? null, actorId: actor?.id ?? null });
  return id;
}

/** Saves an asset: each value, status or assignee that changed is a line of history. */
export async function updateAsset(id: string, asked: AssetInput, actor: Actor): Promise<void> {
  const asset = await getAsset(id);
  if (!asset) throw notFound('That asset no longer exists.');
  const columns = await listColumns();
  const input = { ...asked, values: normaliseValues(columns, asked.values) };
  const problems = valueProblems(columns, input.values);
  if (Object.keys(problems).length) throw badRequest(Object.values(problems)[0]!, 'bad_value');
  const statusId = await checkStatus(input.statusId);
  const assignee = await assigneeOf(input.assignee);

  // Values of switched-off columns are kept: switching a column back on
  // brings them back.
  const enabled = new Set(columns.filter((c) => c.is_enabled).map((c) => c.key));
  const next = { ...asset.field_values };
  for (const column of columns) {
    if (column.format === 'person' || !enabled.has(column.key)) continue;
    const value = (input.values[column.key] ?? '').trim();
    const before = asset.field_values[column.key] ?? '';
    if (value === before) continue;
    if (value) next[column.key] = value;
    else delete next[column.key];
    await event(id, actor, 'value', column.label, before, value);
  }
  const statuses = await listStatuses();
  const nameOf = (sid: string | null) => statuses.find((s) => s.id === sid)?.name ?? '';
  if (statusId !== asset.status_id) await event(id, actor, 'status', 'Status', nameOf(asset.status_id), nameOf(statusId));
  const assigneeId = assignee?.id ?? null;
  if (assigneeId !== asset.assigned_to) {
    await event(id, actor, assigneeId ? 'assigned' : 'unassigned', ASSIGNED_TO, asset.assignee_name ?? '', assignee?.display_name ?? '');
  }
  await execute('UPDATE assets SET status_id = ?, assigned_to = ?, field_values = ?, updated_at = ? WHERE id = ?', [
    statusId,
    assigneeId,
    JSON.stringify(next),
    nowIso(),
    id,
  ]);
  audit({ action: 'asset.updated', actorId: actor?.id ?? null, targetType: 'asset', targetId: id });
  if (statusId !== asset.status_id || assigneeId !== asset.assigned_to) {
    await announce({
      assetId: id,
      created: false,
      statusFrom: asset.status_id,
      statusTo: statusId,
      assigneeFrom: asset.assigned_to,
      assigneeTo: assigneeId,
      actorId: actor?.id ?? null,
    });
  }
}

/** Sets the status alone (an automation's step, step 4). */
export async function setAssetStatus(id: string, statusId: string, actor: Actor): Promise<void> {
  const asset = await getAsset(id);
  if (!asset) throw notFound('That asset no longer exists.');
  await updateAsset(id, { statusId, assignee: asset.assignee_email ?? '', values: asset.field_values }, actor);
}

export async function deleteAsset(id: string, actor: Actor): Promise<void> {
  const asset = await getAsset(id);
  if (!asset) throw notFound('That asset no longer exists.');
  await execute('DELETE FROM assets WHERE id = ?', [id]);
  audit({ action: 'asset.deleted', actorId: actor?.id ?? null, targetType: 'asset', targetId: id, detail: { values: asset.field_values } });
}

// ---------------------------------------------------------------------------
// History and comments
// ---------------------------------------------------------------------------

export interface AssetEvent {
  id: string;
  kind: string;
  field: string;
  old_value: string;
  new_value: string;
  created_at: string;
  actor_name: string | null;
}

export function listAssetEvents(assetId: string): Promise<AssetEvent[]> {
  return query<AssetEvent>(
    `SELECT e.id, e.kind, e.field, e.old_value, e.new_value, e.created_at, u.display_name AS actor_name
       FROM asset_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.asset_id = ? ORDER BY e.created_at DESC LIMIT 200`,
    [assetId],
  );
}

export interface AssetComment {
  id: string;
  body: string;
  created_at: string;
  author_name: string | null;
}

export function listAssetComments(assetId: string): Promise<AssetComment[]> {
  return query<AssetComment>(
    `SELECT c.id, c.body, c.created_at, u.display_name AS author_name
       FROM asset_comments c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.asset_id = ? ORDER BY c.created_at`,
    [assetId],
  );
}

export async function addAssetComment(assetId: string, body: string, actor: Actor): Promise<void> {
  const text = body.trim();
  if (!text) throw badRequest('Write something first.', 'empty_comment');
  if (text.length > 10_000) throw badRequest('Keep a comment under 10,000 characters.', 'long_comment');
  if (!(await getAsset(assetId))) throw notFound('That asset no longer exists.');
  await execute('INSERT INTO asset_comments (id, asset_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)', [newId(), assetId, actor?.id ?? null, text, nowIso()]);
  await execute('UPDATE assets SET updated_at = ? WHERE id = ?', [nowIso(), assetId]);
}

// ---------------------------------------------------------------------------
// What an asset is called
// ---------------------------------------------------------------------------

/** A short name for an asset: its model and serial number, or its type. */
export function assetTitle(asset: Pick<AssetRow, 'field_values'>): string {
  const v = asset.field_values;
  const main = v.Model || v.Type || 'Asset';
  return v.SerialNumber ? main + ' (' + v.SerialNumber + ')' : main;
}

/** The person an asset is assigned to, if any. */
export async function assigneeOfAsset(asset: Pick<AssetRow, 'assigned_to'>): Promise<UserRow | undefined> {
  return asset.assigned_to ? findUserById(asset.assigned_to) : undefined;
}
