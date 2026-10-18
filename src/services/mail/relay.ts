import { isSealed, open, seal, type SealedValue } from '../../lib/secret-box.js';
import { settings, settingsDocument, updateSettings } from '../../settings/index.js';
import { execute, query, queryOne, transaction } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { newId, nowIso } from '../../lib/util.js';
import type { MailboxRow } from './mailboxes.js';
import { newMessageId, transportFor } from './transport.js';

/**
 * SMTP relays: Settings - Mail - Other settings - SMTP relays.
 *
 * An organisation's own relay (Exchange, Postfix, SendGrid, Amazon SES...)
 * that sends without a mailbox behind it. There may be several: each can be
 * assigned technician groups, and one is the default. A relay never
 * receives - replies reach whatever its From address is, not a ticket.
 *
 * Which relay sends a notification, strongest first:
 *  1. the relay the notification names (its Sent from);
 *  2. the relay of the ticket's technician group;
 *  3. the default relay.
 * Step 1 is used only when the notification chose a relay; steps 2 and 3
 * also when "Send notifications only through SMTP relays" is on, which
 * leaves the mailboxes to read mail.
 *
 * relayAsMailbox() dresses a relay as a send-only mailbox for the outbox and
 * the transport factory - which is also how the tests' fake transport sees it.
 */

export const RELAY_SECURITY = ['starttls', 'tls', 'none'] as const;
export type RelaySecurity = (typeof RELAY_SECURITY)[number];

export interface RelayRow {
  id: string;
  name: string;
  is_enabled: boolean;
  host: string;
  port: number;
  security: RelaySecurity;
  username: string;
  /** Sealed. Read it with relayPassword(), never directly. */
  password: string;
  from_address: string;
  from_name: string;
  is_default: boolean;
  last_error: string;
  created_at: string;
  updated_at: string;
}

const ORDER = ' ORDER BY is_default DESC, lower(name)';

export function listRelays(): Promise<RelayRow[]> {
  return query<RelayRow>('SELECT * FROM smtp_relays' + ORDER);
}

export function findRelay(id: string): Promise<RelayRow | undefined> {
  return queryOne<RelayRow>('SELECT * FROM smtp_relays WHERE id = ?', [id]);
}

export function defaultRelay(): Promise<RelayRow | undefined> {
  return queryOne<RelayRow>('SELECT * FROM smtp_relays WHERE is_default = 1');
}

function unseal(stored: string): string {
  if (!stored) return '';
  try {
    return open(JSON.parse(stored) as SealedValue);
  } catch {
    return '';
  }
}

export function relayPassword(relay: RelayRow): string {
  return unseal(relay.password);
}

/** Switched on, and enough is filled in to send. */
export function relayReady(relay: RelayRow | undefined): relay is RelayRow {
  return Boolean(
    relay &&
      relay.is_enabled &&
      relay.host !== '' &&
      relay.from_address !== '' &&
      (relay.username === '' || relayPassword(relay) !== ''),
  );
}

/** A relay that can send, by id - undefined when it cannot. */
export async function usableRelay(id: string): Promise<RelayRow | undefined> {
  const relay = await findRelay(id);
  return relayReady(relay) ? relay : undefined;
}

/** Whether any relay could send now. */
export async function anyRelayReady(): Promise<boolean> {
  return (await listRelays()).some((r) => relayReady(r));
}

/** The relay for a ticket's group: the group's own, else the default. */
export async function relayForGroup(groupId: string | null): Promise<RelayRow | undefined> {
  if (groupId) {
    const own = await queryOne<RelayRow>(
      'SELECT r.* FROM smtp_relays r JOIN smtp_relay_groups g ON g.relay_id = r.id WHERE g.group_id = ?',
      [groupId],
    );
    if (relayReady(own)) return own;
  }
  const fallback = await defaultRelay();
  return relayReady(fallback) ? fallback : undefined;
}

/**
 * Whether notifications go only through the relays. Only while one can
 * send: with every relay off or broken, the mailboxes send again rather than
 * the service desk going silent - and the relays page says so.
 */
export async function relaysOnlyInForce(): Promise<boolean> {
  return settings().smtpRelay.relaysOnly && Boolean(await relayForGroup(null));
}

/** groupId -> relayId, for the settings page. */
export async function relayGroupMap(): Promise<Map<string, string>> {
  const rows = await query<{ group_id: string; relay_id: string }>('SELECT group_id, relay_id FROM smtp_relay_groups');
  return new Map(rows.map((r) => [r.group_id, r.relay_id]));
}

/** The relay as a send-only mailbox. */
export function relayAsMailbox(relay: RelayRow): MailboxRow & { smtp_plain: boolean } {
  return {
    id: relay.id,
    name: relay.from_name,
    address: relay.from_address,
    kind: 'relay' as MailboxRow['kind'],
    is_active: true,
    group_id: null,
    is_default: false,
    tenant_id: '',
    client_id: '',
    client_secret: '',
    graph_user_id: '',
    imap_host: '',
    imap_port: 0,
    imap_tls: false,
    smtp_host: relay.host,
    smtp_port: relay.port,
    smtp_tls: relay.security === 'tls',
    smtp_plain: relay.security === 'none',
    username: relay.username,
    password: relay.password,
    receive_enabled: false,
    last_polled_at: null,
    last_error: relay.last_error,
    created_at: relay.created_at,
    updated_at: relay.updated_at,
  } as unknown as MailboxRow & { smtp_plain: boolean };
}

export async function recordRelayResult(id: string, error: string): Promise<void> {
  await execute('UPDATE smtp_relays SET last_error = ? WHERE id = ?', [error.slice(0, 500), id]);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface RelayInput {
  name: string;
  enabled: boolean;
  host: string;
  port: number;
  security: RelaySecurity;
  username: string;
  /** Blank keeps the stored one. */
  password: string;
  fromAddress: string;
  fromName: string;
  /** Technician groups this relay sends for. */
  groupIds: string[];
}

const HOST = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** What is wrong with a relay as typed, by field. */
export async function relayProblems(input: RelayInput, existing?: RelayRow): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (!input.name) errors.name = 'Give the relay a name.';
  else {
    const clash = await queryOne<{ id: string }>('SELECT id FROM smtp_relays WHERE lower(name) = lower(?)', [input.name]);
    if (clash && clash.id !== existing?.id) errors.name = 'Another relay already has that name.';
  }
  if (!HOST.test(input.host)) errors.host = 'Enter the relay host name, such as smtp.example.com.';
  if (!(input.port >= 1 && input.port <= 65535)) errors.port = 'Enter a port between 1 and 65535 - usually 587, 465 or 25.';
  if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(input.fromAddress)) errors.fromAddress = 'Enter the address mail is sent from.';
  if (input.security === 'none' && input.username) {
    errors.username = 'A password is never sent without TLS. Choose STARTTLS or TLS, or leave the username empty.';
  }
  if (input.username && !input.password && !(existing && existing.username && existing.password)) {
    errors.password = 'Enter the password for this username.';
  }
  return errors;
}

async function setGroups(relayId: string, groupIds: string[]): Promise<void> {
  await transaction(async (client) => {
    await client.query('DELETE FROM smtp_relay_groups WHERE relay_id = ?', [relayId]);
    for (const groupId of [...new Set(groupIds)]) {
      const group = await client.query('SELECT id FROM technician_groups WHERE id = ?', [groupId]);
      if (group.length === 0) continue;
      // A group follows one relay: ticking it here takes it from another.
      await client.query(
        'INSERT INTO smtp_relay_groups (group_id, relay_id) VALUES (?, ?) ON CONFLICT (group_id) DO UPDATE SET relay_id = excluded.relay_id',
        [groupId, relayId],
      );
    }
  });
}

export async function createRelay(input: RelayInput, actorId: string | null): Promise<RelayRow> {
  const problems = await relayProblems(input);
  if (Object.keys(problems).length > 0) throw conflict(Object.values(problems)[0]!);
  const id = newId();
  const now = nowIso();
  // The first relay is the default, as the first mailbox is.
  const first = !(await defaultRelay());
  await execute(
    `INSERT INTO smtp_relays
       (id, name, is_enabled, host, port, security, username, password, from_address, from_name, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.enabled ? 1 : 0,
      input.host,
      input.port,
      input.security,
      input.username,
      input.username && input.password ? JSON.stringify(seal(input.password)) : '',
      input.fromAddress,
      input.fromName,
      first ? 1 : 0,
      now,
      now,
    ],
  );
  await setGroups(id, input.groupIds);
  audit({
    action: 'settings.smtp_relay.created',
    actorId,
    targetType: 'smtp_relay',
    targetId: id,
    detail: { name: input.name, host: input.host, port: input.port, security: input.security, fromAddress: input.fromAddress, groups: input.groupIds.length },
  });
  return (await findRelay(id))!;
}

export async function updateRelay(id: string, input: RelayInput, actorId: string | null): Promise<RelayRow> {
  const existing = await findRelay(id);
  if (!existing) throw notFound('That relay no longer exists.');
  const problems = await relayProblems(input, existing);
  if (Object.keys(problems).length > 0) throw conflict(Object.values(problems)[0]!);
  // Blank keeps the password; no username means there is none to keep.
  const password = !input.username ? '' : input.password ? JSON.stringify(seal(input.password)) : existing.password;
  await execute(
    `UPDATE smtp_relays SET name = ?, is_enabled = ?, host = ?, port = ?, security = ?, username = ?, password = ?,
        from_address = ?, from_name = ?, last_error = '', updated_at = ?
      WHERE id = ?`,
    [input.name, input.enabled ? 1 : 0, input.host, input.port, input.security, input.username, password, input.fromAddress, input.fromName, nowIso(), id],
  );
  await setGroups(id, input.groupIds);
  audit({
    action: 'settings.smtp_relay.changed',
    actorId,
    targetType: 'smtp_relay',
    targetId: id,
    detail: { name: input.name, enabled: input.enabled, host: input.host, port: input.port, security: input.security, fromAddress: input.fromAddress, passwordChanged: input.password !== '', groups: input.groupIds.length },
  });
  return (await findRelay(id))!;
}

/** Moves the default to another relay, cleared and set in one transaction. */
export async function setDefaultRelay(id: string, actorId: string | null): Promise<void> {
  const relay = await findRelay(id);
  if (!relay) throw notFound('That relay no longer exists.');
  await transaction(async (client) => {
    await client.query('UPDATE smtp_relays SET is_default = 0 WHERE is_default = 1');
    await client.query('UPDATE smtp_relays SET is_default = 1 WHERE id = ?', [id]);
  });
  audit({ action: 'settings.smtp_relay.default', actorId, targetType: 'smtp_relay', targetId: id, detail: { name: relay.name } });
}

/**
 * Removes one relay. A notification pinned to it falls back to the ticket's
 * own relay; with no relay left, every notification that went through one
 * goes back to the mailboxes, codes too - none is left with nothing to send
 * it. Removing the default hands it to the oldest survivor. Returns how many
 * notifications moved back to a mailbox.
 */
export async function deleteRelay(id: string, actorId: string | null): Promise<number> {
  const existing = await findRelay(id);
  if (!existing) return 0;
  let moved = 0;
  // The plain helpers join the open transaction, and execute() counts rows.
  await transaction(async () => {
    await execute('DELETE FROM smtp_relays WHERE id = ?', [id]);
    const next = await queryOne<{ id: string }>('SELECT id FROM smtp_relays ORDER BY created_at LIMIT 1');
    if (existing.is_default && next) await execute('UPDATE smtp_relays SET is_default = 1 WHERE id = ?', [next.id]);
    if (!next) moved = await execute('UPDATE mail_notifications SET via_relay = 0, relay_id = NULL WHERE via_relay = 1');
  });
  if (!(await defaultRelay())) {
    await updateSettings({ smtpRelay: { useForCodes: false, relaysOnly: false } }, actorId);
  }
  audit({ action: 'settings.smtp_relay.removed', actorId, targetType: 'smtp_relay', targetId: id, detail: { name: existing.name, notificationsMoved: moved } });
  return moved;
}

/** Sends one test message straight away, bypassing the queue. */
export async function sendRelayTest(id: string, to: string): Promise<void> {
  const relay = await findRelay(id);
  if (!relay) throw new Error('That relay no longer exists.');
  if (!relayReady(relay)) throw new Error('Switch the relay on and fill in the server and the From address first.');
  try {
    await transportFor(relayAsMailbox(relay)).send({
      to,
      subject: 'Test message from ' + settings().branding.appName,
      bodyHtml: '<p>This is a test message sent through the SMTP relay ' + escapeHtml(relay.name) + '. It arrived, so the relay works.</p>',
      messageId: newMessageId(),
    });
    await recordRelayResult(id, '');
  } catch (err) {
    await recordRelayResult(id, err instanceof Error ? err.message : 'The send failed.');
    throw err;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Start-up: the single relay from before migration 50 lived in the settings
 * document. It becomes the first row (the default), with its sealed password
 * copied as it is, and the document's copy is cleared. Only ever adds; with
 * nothing filled in there is nothing to move.
 */
export async function adoptLegacyRelay(): Promise<void> {
  const doc = settingsDocument().smtpRelay;
  if (!doc.host && !doc.fromAddress) return;
  const id = newId();
  const now = nowIso();
  const sealed = isSealed(doc.password) ? JSON.stringify(doc.password) : typeof doc.password === 'string' && doc.password ? JSON.stringify(seal(doc.password)) : '';
  let name = 'SMTP relay';
  if (await queryOne('SELECT id FROM smtp_relays WHERE lower(name) = lower(?)', [name])) name = 'SMTP relay ' + now.slice(0, 10);
  await execute(
    `INSERT INTO smtp_relays
       (id, name, is_enabled, host, port, security, username, password, from_address, from_name, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, doc.enabled ? 1 : 0, doc.host, doc.port, doc.security, doc.username, sealed, doc.fromAddress, doc.fromName, (await defaultRelay()) ? 0 : 1, now, now],
  );
  await updateSettings(
    { smtpRelay: { enabled: false, host: '', port: 587, security: 'starttls', username: '', clearPassword: true, fromAddress: '', fromName: '' } },
    null,
  );
  audit({ action: 'settings.smtp_relay.created', actorId: null, targetType: 'smtp_relay', targetId: id, detail: { name, host: doc.host, adopted: true } });
}

/** The two switches on the relays page. */
export async function setRelayOptions(
  options: { useForCodes: boolean; relaysOnly: boolean },
  actorId: string | null,
): Promise<void> {
  if ((options.useForCodes || options.relaysOnly) && !(await relayForGroup(null))) {
    throw conflict('Set up a default relay that can send first - one that is switched on, with its server and From address filled in.');
  }
  await updateSettings({ smtpRelay: options }, actorId);
  audit({ action: 'settings.smtp_relay.options', actorId, targetType: 'settings', detail: options });
}
