import { execute, query, queryOne } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { newId, nowIso } from '../../lib/util.js';

/**
 * The notifications the system can send.
 *
 * The **trigger** is ours - the code decides that a ticket was just assigned
 * to a group - and the **wording** is the administrator's. So the rows are
 * seeded once with sensible text and then edited, never replaced: a start-up
 * that overwrote them would silently undo somebody's work every deploy.
 *
 * The body is HTML, written by an administrator, and is **not** escaped when
 * it is sent. That is the point of the feature, and it is safe here because
 * only an administrator can write one and it is never rendered in a browser
 * on this origin - the values interpolated into it are escaped, so a ticket
 * title containing a tag cannot break out.
 */

export const NOTIFICATION_EVENTS = [
  'ticket.created.requester',
  'ticket.created.on_behalf',
  'ticket.created.group',
  'ticket.assigned.technician',
  'ticket.status.changed',
  'ticket.resolved',
  'comment.added.requester',
  'comment.added.technician',
  'ticket.deleted.admins',
  'ticket.approval.requested',
  'ticket.approval.decided',
  'ticket.sla.breached',
  // Not about a ticket: sent to one person, from the Users page. See
  // notifyPerson() in outbox.ts.
  'account.temporary_password',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export interface NotificationRow {
  id: string;
  event: NotificationEvent;
  name: string;
  description: string;
  subject: string;
  body_html: string;
  is_enabled: boolean;
  mailbox_id: string | null;
  /** Sent through an SMTP relay instead of a mailbox. */
  via_relay?: boolean;
  /** That relay; null with via_relay is the ticket's own relay. */
  relay_id?: string | null;
  /** The language this wording is in; empty is English (migration 63). */
  language?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Who each notification goes to.
 *
 * Kept here rather than in the row so an administrator cannot point a
 * requester's notification at the technicians by editing a field: the
 * audience is part of what the event *means*.
 */
export const AUDIENCE: Record<
  NotificationEvent,
  'requester' | 'group' | 'assignee' | 'admins' | 'approver' | 'manager' | 'manager_or_admins' | 'person'
> = {
  'ticket.created.requester': 'requester',
  'ticket.created.on_behalf': 'requester',
  'ticket.created.group': 'group',
  'ticket.assigned.technician': 'assignee',
  'ticket.status.changed': 'requester',
  'ticket.resolved': 'requester',
  'comment.added.requester': 'requester',
  'comment.added.technician': 'group',
  // The manager of the ticket's group - the person who answers for that
  // work (asked for 15 Oct 2026). With no group, no manager, or the manager
  // doing the deleting, every other administrator instead: a deletion
  // destroys a record, so it is never silent. The key keeps its old name;
  // it is stored.
  'ticket.deleted.admins': 'manager_or_admins',
  // The one notification that goes to somebody who may have no account here
  // at all: approval is asked of a line manager, not of a colleague.
  'ticket.approval.requested': 'approver',
  // And the answer goes back to the people working the ticket.
  'ticket.approval.decided': 'group',
  // The person who answers for the group the ticket is routed to.
  'ticket.sla.breached': 'manager',
  // Sent to the one account it is about, at the address on that account.
  'account.temporary_password': 'person',
};

const SIGNATURE = `
  <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e4e7ec;color:#667085;font-size:12px;line-height:1.5">
    Reply to this email to add to the request. Please keep the reference in the
    subject so your reply reaches the right place.
  </p>`;

/**
 * The logo, at a size a mail client will respect.
 *
 * **The width attribute is what does the work.** A logo is whatever pixels
 * its author exported - a 1,200px wordmark arrives 1,200px wide - and Outlook
 * on Windows ignores `max-width` on an image, so CSS alone leaves it full
 * size (reported 16 Oct 2026, with a logo filling half the message). The
 * attribute is honoured everywhere; the style is there for the clients that
 * prefer it and for a narrow phone.
 */
const LOGO = `
  <img src="cid:logo" alt="" width="150"
       style="display:block;width:150px;max-width:150px;height:auto;border:0;margin:0 0 20px">`;

/**
 * A button to the request.
 *
 * Every default body carries one - "this should also have a link to the
 * request" (16 Oct 2026). A requester who has to go and find their own ticket
 * is a requester who replies to the email instead, which is slower for both
 * sides. Drawn as a padded anchor rather than a table: every client in the
 * last decade draws it, and a table here would be three nested elements an
 * administrator has to edit around.
 */
function button(label: string, url: string): string {
  return (
    `<p style="margin:24px 0 0">` +
    `<a href="${url}" style="display:inline-block;padding:11px 20px;border-radius:6px;` +
    `background:#1a5d74;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">` +
    `${label}</a></p>`
  );
}

/**
 * The facts of the ticket, as a card rather than a paragraph of middots.
 *
 * It was `Reference INC-000123 &middot; raised ... &middot; priority ...`,
 * which reads as one long line in a mail client and wraps in the middle of a
 * date on a phone.
 */
const FACTS = `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"
         style="width:100%;margin:16px 0;background:#f9fafb;border:1px solid #e4e7ec;border-radius:10px">
    <tr><td style="padding:14px 16px;font-size:14px;line-height:1.6;color:#1d1d1b">
      <strong style="font-size:15px">{{title}}</strong><br>
      <span style="color:#667085">{{reference}} &middot; {{type}} &middot; priority {{priority}}</span>
    </td></tr>
  </table>`;

/** The requester's own words, quoted. */
const QUOTE = `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 4px">
    <tr><td style="padding:0 0 0 14px;border-left:3px solid #e4e7ec;color:#475467;font-size:14px;line-height:1.6">
      {{description}}
    </td></tr>
  </table>`;

/**
 * One shell for every notification: the logo, the message, the signature.
 *
 * A mail client is not a browser - no stylesheet, no classes - so the styles
 * are inline and the layout is a centred table, which is the one thing every
 * client agrees on.
 */
function wrap(inner: string, opts: { signature?: boolean } = {}): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f4f5f7">` +
    `<tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e4e7ec;border-radius:14px">` +
    `<tr><td style="padding:28px 28px 24px;font-family:Inter,'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.6;color:#1d1d1b">` +
    LOGO +
    inner +
    (opts.signature === false ? '' : SIGNATURE) +
    `</td></tr></table></td></tr></table>`
  );
}

/** The same frame and button, for a message written in code (portal-admins.ts). */
export const emailFrame = wrap;
export const emailButton = button;

/** The wording each notification starts with. Editable the moment it exists. */
const SEED: Record<NotificationEvent, Omit<NotificationRow, 'id' | 'event' | 'is_enabled' | 'mailbox_id' | 'created_at' | 'updated_at'>> = {
  'ticket.created.on_behalf': {
    name: 'A ticket was raised for you',
    description: 'To the requester, when a colleague raises a ticket on their behalf. Sent instead of "Thanks for your request".',
    subject: '[{{reference}}] {{raisedByName}} raised a request for you: {{title}}',
    body_html: wrap(
      `<p style="margin:0 0 12px">Hello {{requesterName}},</p>
       <p style="margin:0">{{raisedByName}} raised this request on your behalf. It is yours now: you will hear from the service desk about it, and can reply to this message.</p>` +
        FACTS +
        QUOTE +
        button('View your request', '{{ticketUrl}}'),
    ),
  },
  'ticket.created.requester': {
    name: 'Thanks for your request',
    description: 'To the requester, when they raise a ticket.',
    subject: '[{{reference}}] We have your request: {{title}}',
    body_html: wrap(
      `<p style="margin:0 0 12px">Hello {{requesterName}},</p>
       <p style="margin:0">Thanks - we have your request and the service desk will look at it.</p>` +
        FACTS +
        QUOTE +
        button('View your request', '{{ticketUrl}}'),
    ),
  },
  'ticket.created.group': {
    name: 'A new ticket for your group',
    description: 'To the technician group a new ticket is routed to.',
    subject: '[{{reference}}] New {{type}} for {{groupName}}: {{title}}',
    body_html: wrap(
      `<p style="margin:0">A new request has arrived for <strong>{{groupName}}</strong>, from {{requesterName}}.</p>` +
        FACTS +
        QUOTE +
        button('Open the ticket', '{{ticketUrl}}'),
    ),
  },
  'ticket.assigned.technician': {
    name: 'A ticket was assigned to you',
    description: 'To one technician, when a ticket is assigned to them by name.',
    subject: '[{{reference}}] Assigned to you: {{title}}',
    body_html: wrap(
      `<p style="margin:0 0 12px">Hello {{assigneeName}},</p>
       <p style="margin:0">This ticket has been assigned to you, from {{requesterName}}.</p>` +
        FACTS +
        button('Open the ticket', '{{ticketUrl}}'),
    ),
  },
  'ticket.status.changed': {
    name: 'Your request changed status',
    description: 'To the requester, when the status moves.',
    subject: '[{{reference}}] Now {{status}}: {{title}}',
    body_html: wrap(
      `<p style="margin:0 0 12px">Hello {{requesterName}},</p>
       <p style="margin:0">Your request is now <strong>{{status}}</strong>.</p>
       <p style="margin:12px 0 0;color:#475467">{{statusNote}}</p>` +
        FACTS +
        button('View your request', '{{ticketUrl}}'),
    ),
  },
  'ticket.resolved': {
    name: 'Your request has been resolved',
    description: 'To the requester, when a ticket is resolved or closed.',
    subject: '[{{reference}}] Resolved: {{title}}',
    body_html: wrap(
      `<p style="margin:0 0 12px">Hello {{requesterName}},</p>
       <p style="margin:0">We believe this is sorted.</p>
       <p style="margin:12px 0 0;color:#475467">{{statusNote}}</p>` +
        FACTS +
        `<p style="margin:0">If it is not, reply to this email and it will be reopened.</p>` +
        button('View your request', '{{ticketUrl}}'),
    ),
  },
  'comment.added.requester': {
    name: 'A note was added to your request',
    description: 'To the requester, when the service desk replies.',
    subject: '[{{reference}}] Update on: {{title}}',
    body_html: wrap(
      `<p style="margin:0 0 12px">Hello {{requesterName}},</p>
       <p style="margin:0">{{authorName}} has added to your request:</p>
       <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:16px 0">
         <tr><td style="padding:0 0 0 14px;border-left:3px solid #e4e7ec;color:#1d1d1b;font-size:14px;line-height:1.6">
           {{comment}}
         </td></tr>
       </table>` +
        FACTS +
        button('View your request', '{{ticketUrl}}'),
    ),
  },
  'ticket.approval.requested': {
    name: 'Please approve this request',
    description: 'To the approver named on the ticket, when it is raised.',
    subject: '[{{reference}}] Approval needed: {{title}}',
    body_html: wrap(
      `<p style="margin:0 0 12px">Hello,</p>
       <p style="margin:0">{{requesterName}} has raised a request that needs your approval.</p>` +
        FACTS +
        QUOTE +
        button('Approve or decline', '{{approvalUrl}}') +
        `<p style="margin:12px 0 0;color:#667085;font-size:12px">
          You will be asked to sign in first. Only you can answer this request,
          so a forwarded copy of this message cannot.</p>`,
      { signature: false },
    ),
  },
  'ticket.sla.breached': {
    name: 'An SLA was breached',
    description: "To the technician group's manager, when a ticket misses a target.",
    subject: '[{{reference}}] SLA breached - {{slaClock}}: {{title}}',
    body_html: wrap(
      `<p style="margin:0">This ticket has missed its <strong>{{slaClock}}</strong> target, which was due {{slaDue}}.</p>` +
        FACTS +
        `<p style="margin:0;color:#475467">Routed to {{groupName}}, assigned to {{assigneeName}}.</p>` +
        button('Open the ticket', '{{ticketUrl}}'),
      { signature: false },
    ),
  },
  'ticket.approval.decided': {
    name: 'An approval was answered',
    description: 'To the technician group, when the approver answers.',
    subject: '[{{reference}}] {{approvalDecision}}: {{title}}',
    body_html: wrap(
      `<p style="margin:0">{{approverEmail}} has <strong>{{approvalDecision}}</strong> this request.</p>` +
        FACTS +
        button('Open the ticket', '{{ticketUrl}}'),
      { signature: false },
    ),
  },
  'ticket.deleted.admins': {
    name: 'A ticket was deleted',
    description: "To the manager of the ticket's group when a ticket is deleted - or, without one, every other administrator.",
    subject: '[{{reference}}] Deleted: {{title}}',
    body_html: wrap(
      `<p style="margin:0">{{deletedBy}} deleted a ticket.</p>` +
        FACTS +
        `<p style="margin:0 0 12px"><strong>Reason given:</strong> {{deleteReason}}</p>
       <p style="margin:0;color:#475467">Raised by {{requesterName}} on {{createdAt}}. The ticket, its
          comments and its files are gone; this email and the audit trail are
          what is left of it.</p>`,
      { signature: false },
    ),
  },
  'comment.added.technician': {
    name: 'The requester has replied',
    description: 'To the technician group, when the requester adds to a ticket.',
    subject: '[{{reference}}] Reply from {{requesterName}}: {{title}}',
    body_html: wrap(
      `<p style="margin:0">{{requesterName}} has replied:</p>
       <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:16px 0">
         <tr><td style="padding:0 0 0 14px;border-left:3px solid #e4e7ec;color:#1d1d1b;font-size:14px;line-height:1.6">
           {{comment}}
         </td></tr>
       </table>` +
        FACTS +
        button('Open the ticket', '{{ticketUrl}}'),
    ),
  },
  /**
   * The temporary-password mail: the first built-in that is not about a
   * ticket.
   *
   * Deliberately plain - the password is the message - and with no ticket
   * signature, since there is no ticket to reply to. It is a built-in
   * rather than wording buried in the code because it is often the first
   * thing a new colleague reads, and the tone is the service desk's.
   */
  'account.temporary_password': {
    name: 'Your temporary password',
    description: 'To one person, when an administrator sends them a temporary password. They are asked to choose their own the first time they sign in.',
    subject: 'Your temporary password for {{appName}}',
    body_html: wrap(
      `<p style="margin:0 0 12px">Hello {{personName}},</p>
       <p style="margin:0">Here is a temporary password for {{appName}}. Sign in with <strong>{{email}}</strong> and:</p>
       <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:16px 0;background:#f9fafb;border:1px solid #e4e7ec;border-radius:10px">
         <tr><td align="center" style="padding:16px;font-family:ui-monospace,Consolas,monospace;font-size:20px;letter-spacing:0.04em;color:#1d1d1b">
           <strong>{{password}}</strong>
         </td></tr>
       </table>
       <p style="margin:0">You will be asked to choose your own password the first time you sign in.</p>` +
        button('Sign in', '{{signInUrl}}'),
      { signature: false },
    ),
  },
};

/** The placeholders a body may use, for the editor to list. */
export const PLACEHOLDERS = [
  'reference',
  'title',
  'description',
  'status',
  'statusNote',
  'deleteReason',
  'deletedBy',
  'approvalUrl',
  'approverEmail',
  'approvalDecision',
  'priority',
  'type',
  'requesterName',
  'requesterFirstName',
  'requesterLastName',
  'requesterCompany',
  'raisedByName',
  'assigneeName',
  'assigneeFirstName',
  'assigneeLastName',
  'groupName',
  'authorName',
  'comment',
  'createdAt',
  'ticketUrl',
  'slaClock',
  'slaDue',
  // account.temporary_password only.
  'personName',
  'email',
  'password',
  'signInUrl',
  'appName',
] as const;

export function listNotifications(language = ''): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    'SELECT * FROM mail_notifications WHERE language = ? ORDER BY name',
    [language],
  );
}

/**
 * Custom notifications.
 *
 * A built-in notification is tied to an event and an audience in code. A
 * custom one is just wording: an automation decides when it is sent and to
 * whom (Settings - Advanced - Automation). Stored in the same table so the
 * same editor, preview and outbox serve both; its event is
 * `custom.<id>`, which no built-in event can collide with.
 */
export const CUSTOM_PREFIX = 'custom.';

export function isCustomNotification(row: Pick<NotificationRow, 'event'>): boolean {
  return row.event.startsWith(CUSTOM_PREFIX);
}

export async function listNotificationsOfKind(
  kind: 'builtin' | 'custom',
  language = '',
): Promise<NotificationRow[]> {
  const all = await listNotifications(language);
  return all.filter((n) => isCustomNotification(n) === (kind === 'custom'));
}

export async function createCustomNotification(
  name: string,
  actorId: string | null,
  wording: { subject?: string; bodyHtml?: string } = {},
): Promise<NotificationRow> {
  const clash = await queryOne<{ id: string }>(
    'SELECT id FROM mail_notifications WHERE lower(name) = lower(?)',
    [name],
  );
  if (clash) throw conflict('A notification with that name already exists.', 'notification_name_taken');
  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO mail_notifications
       (id, event, name, description, subject, body_html, is_enabled, mailbox_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
    [
      id,
      CUSTOM_PREFIX + id,
      name,
      'Sent by an automation.',
      (wording.subject ?? '').trim().slice(0, 300) || '[{{reference}}] {{title}}',
      wording.bodyHtml?.trim()
        ? /<html[\s>]/i.test(wording.bodyHtml) ? wording.bodyHtml.slice(0, 100_000) : wrap(wording.bodyHtml.slice(0, 100_000))
        : wrap('<p>{{title}}</p>\n<p><a href="{{ticketUrl}}">Open the ticket</a></p>'),
      now,
      now,
    ],
  );
  audit({ action: 'mail.notification.created', actorId, targetType: 'notification', targetId: id, detail: { name } });
  return (await findNotification(id))!;
}

/** Removes a custom notification. Built-in ones belong to the code. */
export async function deleteCustomNotification(id: string, actorId: string | null): Promise<void> {
  const row = await findNotification(id);
  if (!row) throw notFound('That notification no longer exists.');
  if (!isCustomNotification(row)) {
    throw conflict('A built-in notification cannot be removed - switch it off instead.', 'builtin_notification');
  }
  await execute('DELETE FROM mail_notifications WHERE id = ?', [id]);
  audit({ action: 'mail.notification.deleted', actorId, targetType: 'notification', targetId: id, detail: { name: row.name } });
}

/** The notification of that name, if any. */
export function findNotificationByName(name: string): Promise<NotificationRow | undefined> {
  return queryOne<NotificationRow>('SELECT * FROM mail_notifications WHERE lower(name) = lower(?)', [name]);
}

export function findNotification(id: string): Promise<NotificationRow | undefined> {
  return queryOne<NotificationRow>('SELECT * FROM mail_notifications WHERE id = ?', [id]);
}

/**
 * The wording for one event, in one language.
 *
 * **The fallback is per row, not per string.** A language with no row for
 * this event gets the English one, whole - a notification is the one place
 * where half a translation reads worse than none, because the reader
 * cannot tell which half is missing.
 */
export async function notificationFor(
  event: NotificationEvent,
  language = '',
): Promise<NotificationRow | undefined> {
  if (language) {
    const translated = await queryOne<NotificationRow>(
      'SELECT * FROM mail_notifications WHERE event = ? AND language = ?',
      [event, language],
    );
    if (translated) return translated;
  }
  return queryOne<NotificationRow>(
    "SELECT * FROM mail_notifications WHERE event = ? AND language = ''",
    [event],
  );
}

/**
 * Give one language its own copy of every built-in notification.
 *
 * Copied from the English rows and then **owned**: editing one never
 * reaches the English wording, and the English wording never reaches back.
 * Run when a language's tab is opened, so a language added today has its
 * rows the moment somebody goes looking for them.
 */
export async function seedNotificationsFor(language: string): Promise<number> {
  if (!language) return 0;
  let made = 0;
  for (const event of NOTIFICATION_EVENTS) {
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM mail_notifications WHERE event = ? AND language = ?',
      [event, language],
    );
    if (existing) continue;
    const english = await queryOne<NotificationRow>(
      "SELECT * FROM mail_notifications WHERE event = ? AND language = ''",
      [event],
    );
    const seed = SEED[event];
    const now = nowIso();
    await execute(
      `INSERT INTO mail_notifications
         (id, event, name, description, subject, body_html, is_enabled, mailbox_id,
          language, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        event,
        english?.name ?? seed.name,
        english?.description ?? seed.description,
        english?.subject ?? seed.subject,
        english?.body_html ?? seed.body_html,
        // Whether it is sent at all stays the English row's decision: this
        // is a translation, not a second switch to forget.
        english?.is_enabled === false ? 0 : 1,
        english?.mailbox_id ?? null,
        language,
        now,
        now,
      ],
    );
    made += 1;
  }
  return made;
}

/** Every language that has a set of its own, so one can be deleted with it. */
export async function deleteNotificationsFor(language: string): Promise<void> {
  if (!language) return;
  await execute('DELETE FROM mail_notifications WHERE language = ?', [language]);
}

/**
 * Creates the rows that do not exist yet, and leaves the rest alone.
 *
 * Runs at start-up. Only ever inserts: an administrator's wording survives
 * every restart and every upgrade, and a notification added in a later
 * version appears without touching the others.
 */
export async function seedNotifications(): Promise<void> {
  for (const event of NOTIFICATION_EVENTS) {
    const existing = await notificationFor(event);
    if (existing) continue;

    const seed = SEED[event];
    const now = nowIso();
    await execute(
      `INSERT INTO mail_notifications
         (id, event, name, description, subject, body_html, is_enabled, mailbox_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [newId(), event, seed.name, seed.description, seed.subject, seed.body_html, now, now],
    );
  }
}

export interface NotificationInput {
  subject: string;
  bodyHtml: string;
  isEnabled: boolean;
  mailboxId: string | null;
  /** Through an SMTP relay; mailboxId is then ignored. */
  viaRelay?: boolean;
  /** Which relay; null is the ticket's own (its group's, else the default). */
  relayId?: string | null;
}

export async function updateNotification(
  id: string,
  input: NotificationInput,
  actorId: string | null,
): Promise<NotificationRow> {
  const existing = await findNotification(id);
  if (!existing) throw notFound('That notification no longer exists.');

  await execute(
    `UPDATE mail_notifications SET subject = ?, body_html = ?, is_enabled = ?, mailbox_id = ?,
        via_relay = ?, relay_id = ?, updated_at = ?
      WHERE id = ?`,
    [
      input.subject.trim().slice(0, 300),
      input.bodyHtml.slice(0, 100_000),
      input.isEnabled ? 1 : 0,
      input.viaRelay ? null : input.mailboxId,
      input.viaRelay ? 1 : 0,
      input.viaRelay ? (input.relayId ?? null) : null,
      nowIso(),
      id,
    ],
  );

  audit({
    action: 'mail.notification.updated',
    actorId,
    targetType: 'notification',
    targetId: id,
    detail: { event: existing.event, enabled: input.isEnabled },
  });

  const updated = await findNotification(id);
  if (!updated) throw new Error('notification disappeared during update: ' + id);
  return updated;
}

/**
 * Puts **every** built-in notification back to the wording it ships with.
 *
 * The designs changed on 16 Oct 2026 - a logo that scales, the ticket's facts
 * as a card, and a button to the request in each one - and a seed only
 * reaches a service desk that has never had that row. This is how an
 * existing one catches up, and it is a button somebody presses on purpose:
 * it replaces wording they may have written, which is why nothing does it
 * automatically.
 *
 * A custom notification (an automation's own) is left alone: there is no
 * original wording to go back to.
 */
export async function resetAllNotifications(actorId: string | null): Promise<number> {
  const rows = await listNotifications();
  let restored = 0;
  for (const row of rows) {
    if (!SEED[row.event as NotificationEvent]) continue;
    await resetNotification(row.id, actorId);
    restored += 1;
  }
  audit({
    action: 'mail.notifications.reset_all',
    actorId,
    targetType: 'settings',
    detail: { restored },
  });
  return restored;
}

/** Puts one notification back to the wording it shipped with. */
export async function resetNotification(
  id: string,
  actorId: string | null,
): Promise<NotificationRow> {
  const existing = await findNotification(id);
  if (!existing) throw notFound('That notification no longer exists.');

  const seed = SEED[existing.event as NotificationEvent];
  if (!seed) throw conflict('A custom notification has no original wording to go back to.', 'custom_notification');
  await execute(
    'UPDATE mail_notifications SET subject = ?, body_html = ?, updated_at = ? WHERE id = ?',
    [seed.subject, seed.body_html, nowIso(), id],
  );

  audit({
    action: 'mail.notification.reset',
    actorId,
    targetType: 'notification',
    targetId: id,
    detail: { event: existing.event },
  });

  const updated = await findNotification(id);
  if (!updated) throw new Error('notification disappeared during reset: ' + id);
  return updated;
}

/** HTML-escapes one interpolated value. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Fills a template in.
 *
 * **Every value is escaped**, and the template is not. An administrator writes
 * the HTML; a ticket title does not. Without this a title of
 * `<img src=x onerror=...>` would be HTML in somebody's mail client.
 *
 * An unknown placeholder is left as it stands rather than blanked, so a typo
 * is visible in the preview instead of producing a sentence with a hole in it.
 */
export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) =>
    key in values ? escape(values[key] ?? '') : whole,
  );
}
