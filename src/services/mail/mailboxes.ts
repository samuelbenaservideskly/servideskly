import { execute, query, queryOne, transaction } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { open, seal, type SealedValue } from '../../lib/secret-box.js';
import { newId, normaliseEmail, nowIso } from '../../lib/util.js';

/**
 * The mailboxes the service desk sends from and reads.
 *
 * Two kinds, because not every tenant wants an application-permission Graph
 * registration: `graph` talks to Microsoft Graph, `imap_smtp` speaks the open
 * protocols with XOAUTH2. Both authenticate with OAuth2 client credentials -
 * no password is ever stored, and the client secret is sealed with the same
 * box that protects the Entra secret.
 *
 * **As many as you like.** A mailbox may handle a technician group's tickets,
 * and one is marked the default for everything else. Several mailboxes can
 * share a group - the first by name is used - but only one can be the
 * default, which a partial unique index enforces rather than code, so two
 * cannot exist however the rows were written.
 */

export const MAILBOX_KINDS = ['graph', 'imap_smtp'] as const;
export type MailboxKind = (typeof MAILBOX_KINDS)[number];

export const KIND_LABELS: Record<MailboxKind, string> = {
  graph: 'Microsoft Graph',
  imap_smtp: 'IMAP and SMTP',
};

export interface MailboxRow {
  id: string;
  name: string;
  address: string;
  kind: MailboxKind;
  is_active: boolean;
  group_id: string | null;
  /** The mailbox used when a ticket's group has none of its own. */
  is_default: boolean;
  /**
   * Graph credentials. OAuth2 client credentials, so no password exists.
   * Empty on an IMAP/SMTP mailbox, which signs in the other way.
   */
  tenant_id: string;
  client_id: string;
  /** Sealed. Read it with `mailboxSecret`, never directly. */
  client_secret: string;
  graph_user_id: string;
  /** IMAP and SMTP: host, port, and a username and password. */
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: boolean;
  username: string;
  /** Sealed, like the client secret. Read it with `mailboxPassword`. */
  password: string;
  receive_enabled: boolean;
  last_polled_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
}

const ORDER = ' ORDER BY is_default DESC, lower(name)';

export function listMailboxes(): Promise<MailboxRow[]> {
  return query<MailboxRow>('SELECT * FROM mailboxes' + ORDER);
}

export function listActiveMailboxes(): Promise<MailboxRow[]> {
  return query<MailboxRow>('SELECT * FROM mailboxes WHERE is_active = 1' + ORDER);
}

export function findMailbox(id: string): Promise<MailboxRow | undefined> {
  return queryOne<MailboxRow>('SELECT * FROM mailboxes WHERE id = ?', [id]);
}

export function findMailboxByAddress(address: string): Promise<MailboxRow | undefined> {
  return queryOne<MailboxRow>('SELECT * FROM mailboxes WHERE lower(address) = lower(?)', [
    address.trim(),
  ]);
}

/**
 * Which mailbox handles a ticket.
 *
 * Its technician group's, then the default, then nothing. Several mailboxes
 * may name the same group, so the choice is made by name to be stable rather
 * than by insertion order, which would change under you.
 *
 * Returns undefined when nothing is set up, and the caller then does not
 * send: silence is better than a reply from the wrong address.
 */
export async function mailboxFor(groupId: string | null): Promise<MailboxRow | undefined> {
  if (groupId) {
    const own = await queryOne<MailboxRow>(
      'SELECT * FROM mailboxes WHERE group_id = ? AND is_active = 1 ORDER BY lower(name) LIMIT 1',
      [groupId],
    );
    if (own) return own;
  }
  return queryOne<MailboxRow>(
    'SELECT * FROM mailboxes WHERE is_default = 1 AND is_active = 1',
  );
}

/** The mailbox everything falls back to, if one is set. */
export function defaultMailbox(): Promise<MailboxRow | undefined> {
  return queryOne<MailboxRow>('SELECT * FROM mailboxes WHERE is_default = 1');
}

/**
 * Moves the default to another mailbox.
 *
 * Cleared and set in one transaction: the unique index rejects the write in
 * the other order, and a crash between the two would leave no default at all.
 */
export async function setDefaultMailbox(id: string, actorId: string | null): Promise<void> {
  const mailbox = await findMailbox(id);
  if (!mailbox) throw notFound('That mailbox no longer exists.');

  await transaction(async (client) => {
    await client.query('UPDATE mailboxes SET is_default = 0 WHERE is_default = 1');
    await client.query('UPDATE mailboxes SET is_default = 1 WHERE id = ?', [id]);
  });

  audit({
    action: 'mailbox.default.set',
    actorId,
    targetType: 'mailbox',
    targetId: id,
    detail: { address: mailbox.address },
  });
}

/** Unseals one stored credential, or empty when it cannot be read. */
function unseal(stored: string): string {
  if (!stored) return '';
  try {
    return open(JSON.parse(stored) as SealedValue);
  } catch {
    // Written with a session secret that has since rotated past the last
    // entry. Say nothing here; the send will fail and report it.
    return '';
  }
}

/** The Graph client secret in plain text, for the moment it is used. */
export function mailboxSecret(mailbox: MailboxRow): string {
  return unseal(mailbox.client_secret);
}

/** The IMAP/SMTP password in plain text, for the moment it is used. */
export function mailboxPassword(mailbox: MailboxRow): string {
  return unseal(mailbox.password);
}

export interface MailboxInput {
  name: string;
  address: string;
  kind: MailboxKind;
  groupId: string | null;
  tenantId: string;
  clientId: string;
  /** Empty leaves the stored secret alone, so a form need not repeat it. */
  clientSecret: string;
  graphUserId: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  username: string;
  /** Empty leaves the stored password alone, for the same reason. */
  password: string;
  receiveEnabled: boolean;
  isActive: boolean;
}

async function assertAddressFree(address: string, exceptId: string | null): Promise<void> {
  const clash = await findMailboxByAddress(address);
  if (clash && clash.id !== exceptId) {
    throw conflict('A mailbox with that address already exists.', 'mailbox_address_taken');
  }
}

/** Validates what each kind actually needs, rather than demanding everything. */
function assertComplete(input: MailboxInput, existing?: MailboxRow): void {
  const missing: string[] = [];

  if (input.kind === 'graph') {
    // OAuth2 client credentials, and nothing else.
    if (!input.tenantId) missing.push('Directory (tenant) ID');
    if (!input.clientId) missing.push('Application (client) ID');
    if (!input.graphUserId) missing.push('Mailbox user ID or address in Graph');
    if (!input.clientSecret && !existing?.client_secret) missing.push('Client secret');
  } else {
    // A username and a password, which is what these protocols take. Asking
    // for a tenant id here would be asking the wrong question.
    if (!input.smtpHost) missing.push('SMTP host');
    if (input.receiveEnabled && !input.imapHost) missing.push('IMAP host');
    if (!input.username) missing.push('Username');
    if (!input.password && !existing?.password) missing.push('Password');
  }

  if (missing.length > 0) {
    throw conflict(
      'Still needed for a ' + KIND_LABELS[input.kind] + ' mailbox: ' + missing.join(', ') + '.',
      'mailbox_incomplete',
    );
  }
}

function columns(input: MailboxInput, secret: string, password: string): unknown[] {
  return [
    input.name,
    normaliseEmail(input.address),
    input.kind,
    input.isActive ? 1 : 0,
    input.groupId,
    input.tenantId,
    input.clientId,
    secret,
    input.graphUserId,
    input.imapHost,
    input.imapPort,
    input.imapTls ? 1 : 0,
    input.smtpHost,
    input.smtpPort,
    input.smtpTls ? 1 : 0,
    input.username,
    password,
    input.receiveEnabled ? 1 : 0,
  ];
}

export async function createMailbox(
  input: MailboxInput,
  actorId: string | null,
): Promise<MailboxRow> {
  await assertAddressFree(input.address, null);
  // Which credential is required depends on the kind, so assertComplete says
  // so rather than a separate check here demanding a secret of everybody.
  assertComplete(input);

  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO mailboxes
       (id, name, address, kind, is_active, group_id, tenant_id, client_id, client_secret,
        graph_user_id, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls,
        username, password, receive_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ...columns(
        input,
        input.clientSecret ? JSON.stringify(seal(input.clientSecret)) : '',
        input.password ? JSON.stringify(seal(input.password)) : '',
      ),
      now,
      now,
    ],
  );

  // The first mailbox becomes the default, because a service desk with one
  // mailbox and no default would send nothing and give no clue why.
  if (!(await defaultMailbox())) {
    await execute('UPDATE mailboxes SET is_default = 1 WHERE id = ?', [id]);
  }

  audit({
    action: 'mailbox.created',
    actorId,
    targetType: 'mailbox',
    targetId: id,
    detail: { address: input.address, kind: input.kind },
  });

  const created = await findMailbox(id);
  if (!created) throw new Error('mailbox vanished immediately after insert: ' + id);
  return created;
}

export async function updateMailbox(
  id: string,
  input: MailboxInput,
  actorId: string | null,
): Promise<MailboxRow> {
  const existing = await findMailbox(id);
  if (!existing) throw notFound('That mailbox no longer exists.');
  await assertAddressFree(input.address, id);
  // The stored credential counts as present, so an edit need not retype it.
  assertComplete(input, existing);

  // An empty secret means "leave it alone", so the form need not echo it back
  // - which would put it in the page source of every edit.
  const secret = input.clientSecret
    ? JSON.stringify(seal(input.clientSecret))
    : existing.client_secret;
  const password = input.password
    ? JSON.stringify(seal(input.password))
    : existing.password;

  await execute(
    `UPDATE mailboxes SET
        name = ?, address = ?, kind = ?, is_active = ?, group_id = ?, tenant_id = ?,
        client_id = ?, client_secret = ?, graph_user_id = ?, imap_host = ?, imap_port = ?,
        imap_tls = ?, smtp_host = ?, smtp_port = ?, smtp_tls = ?, username = ?,
        password = ?, receive_enabled = ?, updated_at = ?
      WHERE id = ?`,
    [...columns(input, secret, password), nowIso(), id],
  );

  audit({
    action: 'mailbox.updated',
    actorId,
    targetType: 'mailbox',
    targetId: id,
    detail: { address: input.address, secretChanged: input.clientSecret !== '' },
  });

  const updated = await findMailbox(id);
  if (!updated) throw new Error('mailbox disappeared during update: ' + id);
  return updated;
}

export async function deleteMailbox(id: string, actorId: string | null): Promise<void> {
  const existing = await findMailbox(id);
  if (!existing) return;

  await execute('DELETE FROM mailboxes WHERE id = ?', [id]);

  // Removing the default would otherwise leave a service desk that silently
  // stops sending. The oldest survivor takes it on.
  if (existing.is_default) {
    const next = await queryOne<{ id: string }>(
      'SELECT id FROM mailboxes ORDER BY created_at LIMIT 1',
    );
    if (next) await execute('UPDATE mailboxes SET is_default = 1 WHERE id = ?', [next.id]);
  }

  audit({
    action: 'mailbox.deleted',
    actorId,
    targetType: 'mailbox',
    targetId: id,
    detail: { address: existing.address },
  });
}

/** Records how the last poll or send went, for the settings page to show. */
export async function recordMailboxResult(
  id: string,
  error: string,
  polled: boolean,
): Promise<void> {
  await execute(
    polled
      ? 'UPDATE mailboxes SET last_error = ?, last_polled_at = ?, updated_at = ? WHERE id = ?'
      : 'UPDATE mailboxes SET last_error = ?, updated_at = ? WHERE id = ?',
    polled
      ? [error.slice(0, 500), nowIso(), nowIso(), id]
      : [error.slice(0, 500), nowIso(), id],
  );
}
