import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso, randomToken, sha256 } from '../lib/util.js';
import { execute, query, queryOne } from '../db/index.js';
import { config } from '../config.js';

/**
 * API keys: Settings - Advanced - API keys.
 *
 * A key lets another system start an automation whose trigger is "An HTTP
 * request is received". Three rules:
 *
 * - **The secret is shown once.** Only its sha256 is stored, so neither the
 *   database nor this page can show it again; lost means make another.
 * - **A key can run only the steps ticked on it.** Checked when the
 *   automation is switched on and again on every run, so a key narrowed
 *   later stops the steps it lost.
 * - **Deleting is revoking.** The next request with it is refused.
 *
 * A key reads `<name>_<identifier>_<secret>`, the name being this helpdesk's
 * own (acme for acme.servideskly.com; asked for 17 Oct 2026), so a key found
 * in a file says whose it is. One value, so any tool with a single token
 * field can send it. Everything before the secret - stored as `prefix`,
 * shown on the page, never secret - says which key a request used. A key
 * from before reads `hd_<identifier>_<secret>` and keeps working.
 * **A new secret keeps the identifier** (rotateApiKey), and with it the
 * automations that name the key and what it may run.
 */

/**
 * What a key may do: the automation steps it may run, and - since 18 Oct
 * 2026 - the same actions through POST and PATCH /api/v1 without an
 * automation. "If" decides, so it needs no permission.
 */
export const KEY_ACTIONS = [
  // Reading, through GET /api/v1 - not automation steps.
  { key: 'read_tickets', label: 'Read tickets (GET /api/v1)' },
  { key: 'read_internal', label: 'Read internal notes too' },
  { key: 'create_ticket', label: 'Create a ticket' },
  { key: 'set_status', label: 'Set status' },
  { key: 'set_priority', label: 'Set priority' },
  { key: 'route_group', label: 'Route to group' },
  { key: 'assign', label: 'Assign to technician' },
  { key: 'add_comment', label: 'Add a comment' },
  { key: 'attach_files', label: 'Attach the files from the request' },
  { key: 'create_template', label: 'Create a ticket template' },
  { key: 'create_notification', label: 'Create a notification' },
  { key: 'send_notification', label: 'Send notification' },
  { key: 'http_request', label: 'Send HTTP request' },
  { key: 'http_request_auth', label: 'Send authenticated HTTP request' },
] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number]['key'];

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  allowed_actions: string[];
  /** Templates whose tickets it may act on, and create from; empty is any. */
  template_ids: string[];
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

function normalise(row: ApiKeyRow | undefined): ApiKeyRow | undefined {
  if (!row) return undefined;
  return {
    ...row,
    allowed_actions: Array.isArray(row.allowed_actions) ? row.allowed_actions : [],
    template_ids: Array.isArray(row.template_ids) ? row.template_ids : [],
  };
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  return (await query<ApiKeyRow>('SELECT * FROM api_keys ORDER BY lower(name)')).map((r) => normalise(r)!);
}

export async function findApiKey(id: string): Promise<ApiKeyRow | undefined> {
  return normalise(await queryOne<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', [id]));
}

/**
 * The start of this helpdesk's keys: the first label of its address, letters
 * and digits only, at most 12 - "hd" when there is nothing usable (localhost).
 */
export function keyName(origin = config.publicOrigin): string {
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    // Not a URL: the fallback below.
  }
  const label = /^[\d.]+$/.test(host) || host === 'localhost' ? '' : (host.split('.')[0] ?? '');
  return label.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'hd';
}

/** Everything before a key's secret, as shown on the page. */
export function keyStart(row: Pick<ApiKeyRow, 'prefix'>): string {
  // A key from before stored only its identifier, and started with hd_.
  return row.prefix.includes('_') ? row.prefix : 'hd_' + row.prefix;
}

/** The key a presented secret belongs to, if any. */
export async function keyForSecret(secret: string): Promise<ApiKeyRow | undefined> {
  if (!/^[a-z0-9]{1,12}_[A-Za-z0-9_-]{20,120}$/.test(secret)) return undefined;
  return normalise(await queryOne<ApiKeyRow>('SELECT * FROM api_keys WHERE secret_hash = ?', [sha256(secret)]));
}

function cleanActions(actions: readonly string[]): KeyAction[] {
  return KEY_ACTIONS.map((a) => a.key).filter((k) => actions.includes(k));
}

/** Makes a key. The secret is in the return value and nowhere else. */
export async function createApiKey(
  name: string,
  actions: readonly string[],
  actorId: string | null,
  templateIds: readonly string[] = [],
): Promise<{ row: ApiKeyRow; secret: string }> {
  const clash = await queryOne<{ id: string }>('SELECT id FROM api_keys WHERE lower(name) = lower(?)', [name]);
  if (clash) throw conflict('An API key with that name already exists.', 'api_key_name_taken');
  const id = newId();
  // Unique, so an identifier names exactly one key.
  let prefix = '';
  do prefix = keyName() + '_' + randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
  while (await queryOne('SELECT id FROM api_keys WHERE prefix = ?', [prefix]));
  const secret = prefix + '_' + randomToken(32);
  await execute(
    `INSERT INTO api_keys (id, name, prefix, secret_hash, allowed_actions, template_ids, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, prefix, sha256(secret), JSON.stringify(cleanActions(actions)), JSON.stringify([...new Set(templateIds)]), actorId, nowIso()],
  );
  audit({ action: 'api_key.created', actorId, targetType: 'api_key', targetId: id, detail: { name, actions: cleanActions(actions) } });
  return { row: (await findApiKey(id))!, secret };
}

/** Changes what a key may run. The secret stays as it is. */
export async function setApiKeyActions(
  id: string,
  actions: readonly string[],
  actorId: string | null,
  templateIds?: readonly string[],
): Promise<void> {
  const row = await findApiKey(id);
  if (!row) throw notFound('That API key no longer exists.');
  const templates = templateIds === undefined ? row.template_ids : [...new Set(templateIds)];
  await execute('UPDATE api_keys SET allowed_actions = ?, template_ids = ? WHERE id = ?', [
    JSON.stringify(cleanActions(actions)),
    JSON.stringify(templates),
    id,
  ]);
  audit({ action: 'api_key.updated', actorId, targetType: 'api_key', targetId: id, detail: { actions: cleanActions(actions), templateIds: templates } });
}

/**
 * A new secret for a key: same identifier, same automations, same rights.
 * The old secret stops working at once. Shown once, like a new key's.
 */
export async function rotateApiKey(id: string, actorId: string | null): Promise<{ row: ApiKeyRow; secret: string }> {
  const row = await findApiKey(id);
  if (!row) throw notFound('That API key no longer exists.');
  const secret = keyStart(row) + '_' + randomToken(32);
  await execute('UPDATE api_keys SET secret_hash = ? WHERE id = ?', [sha256(secret), id]);
  audit({ action: 'api_key.rotated', actorId, targetType: 'api_key', targetId: id, detail: { name: row.name, identifier: row.prefix } });
  return { row, secret };
}

export async function deleteApiKey(id: string, actorId: string | null): Promise<void> {
  const row = await findApiKey(id);
  if (!row) throw notFound('That API key no longer exists.');
  await execute('DELETE FROM api_keys WHERE id = ?', [id]);
  audit({ action: 'api_key.deleted', actorId, targetType: 'api_key', targetId: id, detail: { name: row.name } });
}

export async function markKeyUsed(id: string): Promise<void> {
  await execute('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [nowIso(), id]);
}

/** The steps in a list of node types that this key may not run. */
export function forbiddenSteps(key: ApiKeyRow, nodeTypes: readonly string[]): string[] {
  const actionKeys = KEY_ACTIONS.map((a) => a.key) as readonly string[];
  return [...new Set(nodeTypes.filter((t) => actionKeys.includes(t) && !key.allowed_actions.includes(t)))];
}

export function actionLabel(key: string): string {
  return KEY_ACTIONS.find((a) => a.key === key)?.label ?? key;
}
