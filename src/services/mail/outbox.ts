import { config } from '../../config.js';
import { formatDateTime } from '../../lib/format.js';
import { execute, query, queryOne } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { newId, nowIso, ticketReference } from '../../lib/util.js';
import { findGroup, groupManagers } from '../groups.js';
import { listMembers } from '../groups.js';
import { listAdmins } from '../users.js';
import { findUserByEmail, findUserById } from '../users.js';
import { languageFor } from '../../i18n/resolve.js';
import { getTicketById, STATUS_LABELS, TYPE_LABELS, type TicketRow } from '../tickets.js';
import { mailboxFor, findMailbox, recordMailboxResult, type MailboxRow } from './mailboxes.js';
import { defaultRelay, findRelay, recordRelayResult, relayAsMailbox, relayForGroup, relayReady, relaysOnlyInForce, usableRelay } from './relay.js';
import {
  AUDIENCE,
  findNotification,
  notificationFor,
  render,
  type NotificationEvent,
  type NotificationRow,
} from './notifications.js';
import { mailLog, newMessageId, transportFor } from './transport.js';
import { inlineImagesFor } from './inline-images.js';
import { findAttachment, readAttachment } from '../attachments.js';
import { findAssetFile, readAssetFile } from '../asset-documents.js';
import { sealText } from '../../lib/field-crypto.js';
import type { MailAttachment } from './transport.js';

/**
 * Sending.
 *
 * Everything is queued rather than sent inline. A slow or broken mail service
 * must never hold up the request that triggered it - somebody raising a ticket
 * should not wait on Microsoft - and a failure needs somewhere to be seen and
 * retried rather than disappearing into a log line.
 */

export interface OutboxRow {
  id: string;
  mailbox_id: string | null;
  ticket_id: string | null;
  to_address: string;
  subject: string;
  body_html: string;
  message_id: string;
  in_reply_to: string;
  /** Ids of this ticket's attachments to send with it. Read at send time. */
  attachment_ids: string[];
  /** Ids of asset documents to send with it (migration 68). Read at send time. */
  asset_file_ids?: string[];
  /** Sent through an SMTP relay rather than a mailbox. */
  via_relay: boolean;
  /** Which relay; null with via_relay means the default relay. */
  relay_id: string | null;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  last_error: string;
  created_at: string;
  sent_at: string | null;
}

const MAX_ATTEMPTS = 5;

export interface QueueInput {
  mailboxId: string | null;
  ticketId: string | null;
  to: string;
  subject: string;
  bodyHtml: string;
  inReplyTo?: string;
  /** Attachments of the ticket to send with this one message. */
  attachmentIds?: string[];
  /** Through an SMTP relay; mailboxId is then null. */
  viaRelay?: boolean;
  /** Which relay (none: the default relay). */
  relayId?: string | null;
  /** Sent ahead of everything else waiting (a sign-in code). */
  urgent?: boolean;
  /** Asset documents to send with it (services/asset-documents.ts). */
  assetFileIds?: string[];
}

export async function queueMail(input: QueueInput): Promise<OutboxRow> {
  const id = newId();
  const messageId = newMessageId();

  await execute(
    `INSERT INTO mail_outbox
       (id, mailbox_id, ticket_id, to_address, subject, body_html, message_id, in_reply_to,
        attachment_ids, via_relay, relay_id, urgent, asset_file_ids, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
    [
      id,
      input.mailboxId,
      input.ticketId,
      // Who it goes to and what it says are encrypted at rest; read back
      // decrypted by the database layer (lib/field-crypto.ts).
      sealText(input.to),
      sealText(input.subject.slice(0, 300)),
      sealText(input.bodyHtml),
      messageId,
      input.inReplyTo ?? '',
      JSON.stringify(input.attachmentIds ?? []),
      input.viaRelay ? 1 : 0,
      input.viaRelay ? (input.relayId ?? null) : null,
      input.urgent ? 1 : 0,
      JSON.stringify(input.assetFileIds ?? []),
      nowIso(),
    ],
  );

  // Recorded now, not after sending: a reply can arrive before the send is
  // even acknowledged, and a thread with a gap in it is a ticket nobody
  // can find.
  if (input.ticketId) {
    await execute(
      `INSERT INTO mail_threads (message_id, ticket_id, direction, created_at)
       VALUES (?, ?, 'out', ?)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, input.ticketId, nowIso()],
    );
  }

  const queued = await queryOne<OutboxRow>('SELECT * FROM mail_outbox WHERE id = ?', [id]);
  if (!queued) throw new Error('queued mail vanished immediately after insert: ' + id);
  return queued;
}

export function listOutbox(limit = 50): Promise<OutboxRow[]> {
  return query<OutboxRow>('SELECT * FROM mail_outbox ORDER BY created_at DESC LIMIT ?', [limit]);
}

export function pendingCount(): Promise<{ queued: number; failed: number } | undefined> {
  return queryOne<{ queued: number; failed: number }>(
    `SELECT
       sum(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
       sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM mail_outbox`,
  );
}

/**
 * Sends whatever is waiting.
 *
 * Called on a timer and after anything queues mail. One message at a time, on
 * purpose: the volume is low, and a burst of parallel sends against a mailbox
 * is the fastest way to be throttled.
 */
let running: Promise<{ sent: number; failed: number }> | null = null;
let again = false;

/**
 * One pass at a time. A call while a pass is running asks for another pass
 * afterwards rather than starting a second sender, which would send the same
 * rows twice.
 */
export function flushOutbox(): Promise<{ sent: number; failed: number }> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    const total = { sent: 0, failed: 0 };
    do {
      again = false;
      const pass = await flushOnce();
      total.sent += pass.sent;
      total.failed += pass.failed;
    } while (again);
    return total;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Sends now, without waiting for the timer: for mail somebody is waiting on. */
export function sendSoon(): void {
  if (config.isTest) return; // tests flush when they choose to
  void flushOutbox().catch((err: unknown) => mailLog.warn({ err }, 'sending urgent mail failed'));
}

async function flushOnce(): Promise<{ sent: number; failed: number }> {
  // Urgent first (sign-in codes), then oldest first.
  const waiting = await query<OutboxRow>(
    "SELECT * FROM mail_outbox WHERE status = 'queued' ORDER BY urgent DESC, created_at LIMIT 25",
  );

  let sent = 0;
  let failed = 0;

  for (const message of waiting) {
    const relay = message.via_relay
      ? message.relay_id
        ? await findRelay(message.relay_id)
        : await defaultRelay()
      : undefined;
    const mailbox = message.via_relay
      ? relayReady(relay)
        ? relayAsMailbox(relay)
        : undefined
      : message.mailbox_id
        ? await findMailbox(message.mailbox_id)
        : undefined;
    if (!mailbox || !mailbox.is_active) {
      await fail(
        message,
        message.via_relay
          ? 'The SMTP relay is removed, switched off or not set up (Settings - Mail - SMTP relays).'
          : 'No active mailbox is configured to send this.',
      );
      failed++;
      continue;
    }

    try {
      // Read here rather than when the mail was queued: the queue then holds
      // no copy of an image, and a logo changed while something waited goes
      // out as the new one.
      const inlineImages = await inlineImagesFor(message.body_html);
      // Same reasoning as the logo: read now, from the ticket, so the queue
      // holds no copy and a file deleted meanwhile is simply not sent.
      const attachments = await filesFor(message);

      await transportFor(mailbox).send({
        to: message.to_address,
        subject: message.subject,
        bodyHtml: message.body_html,
        messageId: message.message_id,
        ...(message.in_reply_to ? { inReplyTo: message.in_reply_to } : {}),
        ...(inlineImages.length > 0 ? { inlineImages } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });

      await execute(
        "UPDATE mail_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?",
        [nowIso(), message.id],
      );
      if (message.via_relay) await recordRelayResult(mailbox.id, '');
      else await recordMailboxResult(mailbox.id, '', false);
      sent++;
    } catch (err) {
      await fail(message, err instanceof Error ? err.message : 'The send failed.');
      const reason = err instanceof Error ? err.message : 'The send failed.';
      if (message.via_relay) await recordRelayResult(mailbox.id, reason);
      else await recordMailboxResult(mailbox.id, reason, false);
      failed++;
    }
  }

  return { sent, failed };
}

/** Records a failure, giving up only after several tries. */
async function fail(message: OutboxRow, reason: string): Promise<void> {
  const attempts = message.attempts + 1;
  await execute(
    `UPDATE mail_outbox SET attempts = ?, last_error = ?, status = ? WHERE id = ?`,
    [attempts, reason.slice(0, 500), attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', message.id],
  );
  mailLog.warn({ outboxId: message.id, attempts, reason }, 'sending mail failed');
}

/** Puts a failed message back in the queue, for the settings page. */
export async function retryMail(id: string, actorId: string | null): Promise<void> {
  await execute(
    "UPDATE mail_outbox SET status = 'queued', attempts = 0, last_error = '' WHERE id = ?",
    [id],
  );
  audit({ action: 'mail.retried', actorId, targetType: 'mail', targetId: id, detail: {} });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotifyContext {
  ticket: TicketRow;
  /** The comment, when the event is about one. */
  comment?: string;
  /** Who wrote the comment or made the change. */
  authorName?: string;
  /** Why the status changed, when the change calls for a reason. */
  statusNote?: string;
  /** Why a ticket was deleted, and by whom. */
  deleteReason?: string;
  /** Who did it, so they are not told about their own action. */
  actorId?: string | null;
  /**
   * Attachments of this ticket to send with the notification.
   *
   * Never set by the application on its own: a notification carries files
   * only when somebody ticked "inform the requester" on the upload form, so
   * sending a ticket's contents out stays a decision rather than a default.
   */
  attachmentIds?: string[];
  /** Which SLA clock was breached, and when it was due. */
  slaClock?: string;
  slaDue?: string;
}

/**
 * The files a queued message should carry.
 *
 * Capped in total, not just per file. A mail server will refuse a message
 * over its own limit outright, and a refusal after the technician has moved
 * on is worse than sending the first few: the queue shows what went and the
 * ticket still has all of them.
 */
const MAX_MAIL_BYTES = 15 * 1024 * 1024;

async function filesFor(message: OutboxRow): Promise<MailAttachment[]> {
  const ids = Array.isArray(message.attachment_ids) ? message.attachment_ids : [];
  const assetIds = Array.isArray(message.asset_file_ids) ? message.asset_file_ids : [];
  if (ids.length === 0 && assetIds.length === 0) return [];

  const files: MailAttachment[] = [];
  let total = 0;

  // Asset documents: a copy filled in for this message, kept on the asset.
  for (const id of assetIds.slice(0, 5)) {
    const row = await findAssetFile(String(id));
    if (!row || row.kind !== 'generated' || total + row.byte_size > MAX_MAIL_BYTES) continue;
    try {
      const content = await readAssetFile(row);
      files.push({ filename: row.name, contentType: row.content_type, content });
      total += content.byteLength;
    } catch (err) {
      mailLog.warn({ err, assetFileId: row.id }, 'could not read an asset document to send');
    }
  }

  for (const id of ids.slice(0, 20)) {
    const row = await findAttachment(String(id));
    // Gone, or belonging to another ticket: either way not ours to send.
    if (!row || row.deleted_at || row.ticket_id !== message.ticket_id) continue;
    if (total + Number(row.byte_size) > MAX_MAIL_BYTES) continue;

    try {
      const content = await readAttachment(row);
      files.push({ filename: row.filename, contentType: row.content_type, content });
      total += content.byteLength;
    } catch (err) {
      mailLog.warn({ err, attachmentId: row.id }, 'could not read an attachment to send');
    }
  }

  return files;
}

/** The last outbound Message-ID on a ticket, so a reply threads under it. */
async function lastThreadId(ticketId: string): Promise<string> {
  const row = await queryOne<{ message_id: string }>(
    "SELECT message_id FROM mail_threads WHERE ticket_id = ? AND direction = 'out'" +
      ' ORDER BY created_at DESC LIMIT 1',
    [ticketId],
  );
  return row?.message_id ?? '';
}

/**
 * Where a notification goes.
 *
 * A ticket raised by email from somebody with no account still has an address
 * to reply to - `external_email` - which is the whole point of accepting mail
 * from strangers.
 */
async function recipients(
  event: NotificationEvent,
  ticket: TicketRow,
  context: NotifyContext,
): Promise<string[]> {
  switch (AUDIENCE[event]) {
    case 'requester': {
      if (ticket.external_email) return [ticket.external_email];
      const requester = await findUserById(ticket.requester_id);
      return requester?.email ? [requester.email] : [];
    }
    case 'assignee': {
      if (!ticket.assignee_id) return [];
      const assignee = await findUserById(ticket.assignee_id);
      return assignee?.email ? [assignee.email] : [];
    }
    case 'group': {
      if (!ticket.group_id) return [];
      const members = await listMembers(ticket.group_id);
      return members.map((member) => member.email).filter(Boolean);
    }
    case 'approver': {
      return ticket.approval_email ? [ticket.approval_email] : [];
    }
    case 'manager': {
      // Every manager of the ticket's group.
      if (!ticket.group_id) return [];
      return (await groupManagers(ticket.group_id)).filter((m) => m.status === 'active' && m.email).map((m) => m.email);
    }
    case 'manager_or_admins': {
      const managers = ticket.group_id
        ? (await groupManagers(ticket.group_id)).filter((m) => m.status === 'active' && m.email && m.id !== context.actorId)
        : [];
      if (managers.length > 0) return managers.map((m) => m.email);
      const admins = await listAdmins();
      return admins.filter((admin) => admin.id !== context.actorId).map((admin) => admin.email).filter(Boolean);
    }
    case 'admins': {
      // Everybody who could have done it, except whoever did. Telling
      // somebody what they have just done is noise; the rest of them are the
      // people who need to know a record is gone.
      const admins = await listAdmins();
      return admins
        .filter((admin) => admin.id !== context.actorId)
        .map((admin) => admin.email)
        .filter(Boolean);
    }
    default:
      return [];
  }
}

/** The values a template may interpolate. All escaped when rendered. */
async function placeholders(context: NotifyContext): Promise<Record<string, string>> {
  const { ticket } = context;
  const [requester, assignee, group] = await Promise.all([
    findUserById(ticket.requester_id),
    ticket.assignee_id ? findUserById(ticket.assignee_id) : Promise.resolve(undefined),
    ticket.group_id ? findGroup(ticket.group_id) : Promise.resolve(undefined),
  ]);

  return {
    reference: ticketReference(Number(ticket.ref_seq), ticket.ref_prefix),
    title: ticket.title,
    description: ticket.description,
    // The label, not the stored value: a requester reading "now pending"
    // is reading a database column.
    status: STATUS_LABELS[ticket.status] ?? ticket.status,
    // Why, when the change was one that needs a reason. Empty otherwise, so
    // a template can carry it without every other status change trailing a
    // stray line.
    statusNote: context.statusNote ?? '',
    slaClock: context.slaClock ?? '',
    slaDue: context.slaDue ? formatDateTime(context.slaDue) : '',
    deleteReason: context.deleteReason ?? '',
    approverEmail: ticket.approval_email,
    // Who filled in the form for the requester, when somebody did.
    raisedByName: ticket.raised_by ? ((await findUserById(ticket.raised_by))?.display_name ?? '') : '',
    approvalDecision:
      ticket.approval_status === 'approved'
        ? 'approved'
        : ticket.approval_status === 'rejected'
          ? 'declined'
          : 'not yet answered',
    // The link carries the token, which is the whole of the approver's
    // authority - they have no account here to sign in to.
    approvalUrl: ticket.approval_token
      ? config.publicOrigin + '/approvals/' + ticket.approval_token
      : '',
    deletedBy: context.authorName ?? 'An administrator',
    priority: ticket.priority,
    type: TYPE_LABELS[ticket.type] ?? ticket.type,
    requesterName: requester?.display_name ?? ticket.external_email ?? 'the requester',
    // The parts behind a display name (Users - Other settings). Empty when
    // unknown, so "Dear {{requesterFirstName}}" needs a template that reads
    // well either way.
    requesterFirstName: requester?.first_name ?? '',
    requesterLastName: requester?.last_name ?? '',
    requesterCompany: requester?.company ?? '',
    assigneeName: assignee?.display_name ?? 'nobody yet',
    assigneeFirstName: assignee?.first_name ?? '',
    assigneeLastName: assignee?.last_name ?? '',
    groupName: group?.name ?? 'the service desk',
    authorName: context.authorName ?? 'The service desk',
    comment: context.comment ?? '',
    // In the Locale's time zone and format, as on screen.
    createdAt: formatDateTime(ticket.created_at),
    ticketUrl: config.publicOrigin + '/tickets/' + ticket.id,
  };
}

/**
 * Queues one notification, if it is configured and has somewhere to go.
 *
 * Every reason not to send is a quiet return rather than an error: a service
 * desk with no mailbox yet must keep working, and an administrator who turned
 * a notification off meant it.
 */
export async function notify(event: NotificationEvent, context: NotifyContext): Promise<void> {
  const notification = await notificationFor(event);
  if (!notification || !notification.is_enabled) return;

  const to = await recipients(event, context.ticket, context);
  if (to.length === 0) return;

  const sender = await senderFor(notification, context.ticket.group_id);
  if (!sender) return;

  const values = await placeholders(context);
  const inReplyTo = await lastThreadId(context.ticket.id);

  /*
   * One message per recipient, **in their own language**.
   *
   * A notification goes to a group as often as to one person, and the
   * people in a group do not all read the same language - so the wording
   * is chosen per address rather than once. A language with no row for
   * this event falls back to the English one whole (notificationFor), and
   * an address with no account here is English: a stranger who wrote in
   * has told us nothing about what they read.
   */
  for (const address of to) {
    const wording = await wordingFor(event, address, notification);
    await queueMail({
      ...sender,
      ticketId: context.ticket.id,
      to: address,
      subject: render(wording.subject, values),
      bodyHtml: render(wording.body_html, values),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(context.attachmentIds?.length ? { attachmentIds: context.attachmentIds } : {}),
    });
  }
}

/**
 * The row to send to one address: theirs if they read another language.
 *
 * Costs one lookup per recipient, and only while a language is enabled -
 * `languageFor` answers '' immediately when none is.
 */
async function wordingFor(
  event: NotificationEvent,
  address: string,
  fallback: NotificationRow,
): Promise<NotificationRow> {
  try {
    const person = await findUserByEmail(address);
    if (!person) return fallback;
    const language = await languageFor(person);
    if (!language) return fallback;
    return (await notificationFor(event, language)) ?? fallback;
  } catch {
    // Working out a language must never cost the message.
    return fallback;
  }
}

/**
 * Where a notification is sent from. A relay when it chose one: that relay,
 * or with none named the ticket's group's relay, else the default relay.
 * With "only through SMTP relays" on, the group's or default relay whatever
 * mailbox it names. Otherwise its own mailbox, else the ticket's group's,
 * else the default. Null when there is nothing able to send.
 */
async function senderFor(
  notification: { mailbox_id: string | null; via_relay?: boolean; relay_id?: string | null },
  groupId: string | null,
): Promise<{ mailboxId: string | null; viaRelay?: boolean; relayId?: string } | null> {
  if (notification.via_relay) {
    const relay = notification.relay_id ? await usableRelay(notification.relay_id) : await relayForGroup(groupId);
    return relay ? { mailboxId: null, viaRelay: true, relayId: relay.id } : null;
  }
  if (await relaysOnlyInForce()) {
    const relay = await relayForGroup(groupId);
    if (relay) return { mailboxId: null, viaRelay: true, relayId: relay.id };
  }
  const mailbox: MailboxRow | undefined = notification.mailbox_id
    ? await findMailbox(notification.mailbox_id)
    : await mailboxFor(groupId);
  return mailbox && mailbox.is_active ? { mailboxId: mailbox.id } : null;
}

/**
 * Sends a built-in notification that is about a person, not a ticket.
 *
 * The ticket notifications all hang off notifyTicket, which needs a ticket
 * for its placeholders, its thread and its group's mailbox. This one has
 * none of those: it goes to one address, from the default mailbox or the
 * default relay, and its values are handed in.
 *
 * It is urgent for the same reason a sign-in code is - somebody is waiting
 * to get in - and it returns whether anything was queued, so the page that
 * asked can say so rather than claiming a send that never happened.
 */
export async function notifyPerson(
  event: NotificationEvent,
  to: string,
  values: Record<string, string>,
): Promise<boolean> {
  const notification = await notificationFor(event);
  if (!notification || !notification.is_enabled || !to) return false;

  const sender = await senderFor(notification, null);
  if (!sender) return false;

  // In their language, like every other notification. This one is about
  // their own account, so it is the one they are most likely to read.
  const wording = await wordingFor(event, to, notification);

  await queueMail({
    ...sender,
    urgent: true,
    ticketId: null,
    to,
    subject: render(wording.subject, values),
    bodyHtml: render(wording.body_html, values),
  });
  sendSoon();
  return true;
}

/**
 * One email an automation wrote itself (Email about the asset, 21 Oct
 * 2026): no notification, no ticket - a subject and a body to one address,
 * from the default mailbox or relay. Returns whether anything was queued.
 */
export async function mailOne(to: string, subject: string, bodyHtml: string, assetFileIds: string[] = []): Promise<boolean> {
  if (!to) return false;
  const sender = await senderFor({ mailbox_id: null }, null);
  if (!sender) return false;
  await queueMail({ ...sender, ticketId: null, to, subject, bodyHtml, assetFileIds });
  return true;
}

/** Whether mailOne() has anything to send through, before a document is made for it. */
export async function canMailOne(): Promise<boolean> {
  return (await senderFor({ mailbox_id: null }, null)) !== null;
}

/** Who an automation sends a notification to. */
export type AutomationRecipient = 'requester' | 'group' | 'assignee' | 'manager' | 'approver' | { email: string };

/**
 * Sends one notification - built-in or custom - about a ticket to whoever an
 * automation chose. The same wording, placeholders, mailbox choice and
 * outbox as an event notification; only the audience comes from outside.
 */
export async function sendNotification(
  notificationId: string,
  ticketId: string,
  recipient: AutomationRecipient,
): Promise<number> {
  const notification = await findNotification(notificationId);
  if (!notification || !notification.is_enabled) return 0;
  const ticket = await getTicketById(ticketId);
  if (!ticket) return 0;

  let to: string[];
  if (typeof recipient === 'object') {
    to = [recipient.email];
  } else {
    // The audience resolution events use, borrowed by a stand-in event.
    const stand: Record<string, NotificationEvent> = {
      requester: 'ticket.created.requester',
      group: 'ticket.created.group',
      assignee: 'ticket.assigned.technician',
      manager: 'ticket.sla.breached',
      approver: 'ticket.approval.requested',
    };
    to = await recipients(stand[recipient]!, ticket, { ticket });
  }
  if (to.length === 0) return 0;

  const sender = await senderFor(notification, ticket.group_id);
  if (!sender) return 0;

  const values = await placeholders({ ticket });
  const subject = render(notification.subject, values);
  const bodyHtml = render(notification.body_html, values);
  const inReplyTo = await lastThreadId(ticket.id);
  for (const address of to) {
    await queueMail({
      ...sender,
      ticketId: ticket.id,
      to: address,
      subject,
      bodyHtml,
      ...(inReplyTo ? { inReplyTo } : {}),
    });
  }
  return to.length;
}

/** Convenience for the routes: load the ticket, then notify. */
export async function notifyTicket(
  event: NotificationEvent,
  ticketId: string,
  extra: Omit<NotifyContext, 'ticket'> = {},
): Promise<void> {
  const ticket = await getTicketById(ticketId);
  if (!ticket) return;
  await notify(event, { ticket, ...extra });
}
