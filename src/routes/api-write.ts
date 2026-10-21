import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { config as appConfig } from '../config.js';
import { queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { ticketReference } from '../lib/util.js';
import { apiKeyGuessLimiter, hookLimiter } from '../middleware/security.js';
import { keyForSecret, markKeyUsed, type ApiKeyRow, type KeyAction } from '../services/api-keys.js';
import { createCustomNotification, findNotificationByName } from '../services/mail/notifications.js';
import { sendNotification, type AutomationRecipient } from '../services/mail/outbox.js';
import { systemRequesterId } from '../services/mail/inbound.js';
import { raiseFromRule } from '../services/mail/rules.js';
import { createTemplateFrom, findTemplate, findTemplateByName, isUsable } from '../services/templates.js';
import { can } from '../auth/permissions.js';
import { findUserById, type UserRow } from '../services/users.js';
import {
  addComment,
  approvalBlocks,
  canSeeTicket,
  seesInternal,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  updateTicket,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
  type TicketUpdate,
} from '../services/tickets.js';
import { settings } from '../settings/index.js';
import { ticketFor } from './hooks.js';

const log = logger.child({ module: 'api' });

/**
 * POST and PATCH /api/v1/... - changing things with an API key, without an
 * automation (asked for 18 Oct 2026). The same actions an automation's steps
 * take, and the same permissions: each change needs its own tick on the key
 * (Create a ticket, Set status, Route to group...), so a key that may only
 * read cannot write, and one that may only comment cannot close.
 *
 * Every change is done as the person who made the key - who must still be an
 * active administrator or technician - and audited as `api.*`. The rules the
 * pages apply apply here too: an approval awaited or a task open blocks
 * closing, an assignee must be staff, a group must exist, and On hold needs a
 * reason. A key limited to some templates acts only on their tickets (404
 * for any other, as when reading) and creates only from them.
 *
 * Mounted before the read router, which refuses a key without "Read tickets"
 * whatever the method.
 */
export const apiWriteRouter = Router();

apiWriteRouter.use(hookLimiter);
apiWriteRouter.use(apiKeyGuessLimiter);

/** Only writes are this router's; a GET falls through to reading. */
const WRITES = new Set(['POST', 'PATCH']);

function refuse(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const no = (status: number, message: string): never => {
  throw new Refusal(status, message);
};

interface Ctx {
  key: ApiKeyRow;
  actorId: string;
  /** The key's author: the key never does more than their role allows. */
  actor: UserRow;
}

async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!WRITES.has(req.method)) return next('router');
  try {
    const secret = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? '';
    const key = await keyForSecret(secret);
    if (!key) return refuse(res, 401, 'Access denied.');
    // Who the change is made as: the key's author, while they may still make it.
    const actor = key.created_by ? await findUserById(key.created_by) : undefined;
    if (!actor || actor.status !== 'active' || (actor.role !== 'admin' && actor.role !== 'agent')) return refuse(res, 403, 'The person who made this key is no longer an active administrator or technician. Make a new key.');
    await markKeyUsed(key.id);
    res.locals.ctx = { key, actorId: actor.id, actor } satisfies Ctx;
    next();
  } catch (err) {
    next(err);
  }
}

apiWriteRouter.use(authenticate);
apiWriteRouter.use(express.json({ limit: '64kb', type: () => true }));

const ctxOf = (res: Response) => res.locals.ctx as Ctx;

function need(ctx: Ctx, action: KeyAction, label: string): void {
  if (!ctx.key.allowed_actions.includes(action)) {
    no(403, 'This key may not ' + label + '. Tick it on the key under Settings - Advanced - API keys.');
  }
}

/** One handler: refusals become JSON with their status, everything else a 500 in the log. */
function handle(fn: (req: Request, res: Response, ctx: Ctx) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      const body = await fn(req, res, ctxOf(res));
      if (!res.headersSent) res.status(res.statusCode === 200 ? 200 : res.statusCode).json(body);
    } catch (err) {
      if (err instanceof Refusal) return refuse(res, err.status, err.message);
      if (err instanceof HttpError && err.status < 500) return refuse(res, err.status, err.message);
      log.error({ err, path: req.path }, 'API write failed');
      refuse(res, 500, 'Something went wrong. Nothing more is known here; the service desk log has the detail.');
    }
  };
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const truthy = (value: unknown) => value === true || value === 'true' || value === 'yes' || value === 'on' || value === 1;
const fold = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** A value given as the stored word or the label: "in_progress", "In progress", "on hold". */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], aliases: Record<string, T>, what: string): T {
  const v = fold(String(value ?? ''));
  const hit = (allowed as readonly string[]).includes(v) ? (v as T) : aliases[v];
  if (!hit) no(400, 'Unknown ' + what + ' "' + String(value).slice(0, 40) + '". Use one of: ' + allowed.join(', ') + '.');
  return hit!;
}
const STATUS_ALIASES: Record<string, TicketStatus> = { on_hold: 'pending', onhold: 'pending', hold: 'pending', inprogress: 'in_progress' };

/** The ticket named in the address, if this key - and its author - may act on it. */
async function ticketOf(ref: string, ctx: Ctx): Promise<TicketRow & { template_id: string | null }> {
  const id = await ticketFor(ref);
  const row = id ? await queryOne<TicketRow & { template_id: string | null }>('SELECT * FROM tickets WHERE id = ?', [id]) : undefined;
  if (!row || (ctx.key.template_ids.length > 0 && !(row.template_id && ctx.key.template_ids.includes(row.template_id))) || !(await canSeeTicket(ctx.actor, row))) {
    no(404, 'No such ticket.');
  }
  return row!;
}

/** What the key's author's role allows, checked as the pages check it. */
function author(ctx: Ctx, permission: string, label: string): void {
  if (!can(ctx.actor, permission)) no(403, 'The role of the person who made this key does not allow ' + label + '.');
}

const referenceOf = (row: { ref_prefix: string; ref_seq: number | string }) => ticketReference(Number(row.ref_seq), row.ref_prefix);
const urlOf = (id: string) => appConfig.publicOrigin + '/tickets/' + id;

/** A group by id or name: active only. */
async function groupOf(value: unknown): Promise<string | null> {
  if (value === null || value === '' || value === 'none') return null;
  const v = String(value).trim();
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM technician_groups WHERE is_active = 1 AND (id = ? OR lower(name) = lower(?))',
    [v, v],
  );
  if (!row) no(400, 'No active technician group "' + v.slice(0, 60) + '".');
  return row!.id;
}

/** A technician by email or id: an active agent or administrator. */
async function assigneeOf(value: unknown): Promise<string | null> {
  if (value === null || value === '' || value === 'none') return null;
  const v = String(value).trim();
  const row = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE status = 'active' AND role IN ('admin', 'agent') AND (id = ? OR email = lower(?))",
    [v, v],
  );
  if (!row) no(400, '"' + v.slice(0, 60) + '" is not an active technician here.');
  return row!.id;
}

/** A template by id or name, usable, and one this key may use. */
async function templateOf(value: unknown, ctx: Ctx) {
  const v = text(value, 120);
  const template = v ? ((await findTemplate(v).catch(() => undefined)) ?? (await findTemplateByName(v))) : undefined;
  if (!template || !template.is_active || !isUsable(template) || template.type === 'task') {
    no(400, 'No template "' + v.slice(0, 60) + '" that raises tickets (it may be retired, unfinished or a task template).');
  }
  if (ctx.key.template_ids.length > 0 && !ctx.key.template_ids.includes(template!.id)) {
    no(403, 'This key may not create tickets from "' + template!.name + '".');
  }
  return template!;
}

/** Status, priority, group and assignee: each checked, each needing its own tick. */
async function changesFrom(body: Record<string, unknown>, ctx: Ctx, ticket: TicketRow | null): Promise<{ update: TicketUpdate; note: string; internal: boolean }> {
  const update: TicketUpdate = {};
  let note = text(body.note, 4000);
  if (body.status !== undefined) {
    need(ctx, 'set_status', 'set the status');
    const status = oneOf(body.status, TICKET_STATUSES, STATUS_ALIASES, 'status');
    if (ticket && ticket.status !== status) {
      const blocked = approvalBlocks(ticket, status);
      if (blocked) no(409, blocked);
      // The pages' rules about saying why.
      const t = settings().tickets;
      if (!note && status === 'pending') no(400, 'Putting a ticket on hold needs a reason: send it as "note".');
      if (!note && status === 'cancelled' && t.requireCancelNote) no(400, 'This service desk asks for a note when cancelling: send it as "note".');
      if (!note && status === 'resolved' && t.requireResolveNote) no(400, 'This service desk asks for a resolution note: send it as "note".');
    }
    update.status = status;
  }
  if (body.priority !== undefined) {
    need(ctx, 'set_priority', 'set the priority');
    update.priority = oneOf(body.priority, TICKET_PRIORITIES, {}, 'priority') as TicketPriority;
  }
  if (body.group !== undefined) {
    need(ctx, 'route_group', 'route tickets to a group');
    update.groupId = await groupOf(body.group);
  }
  if (body.assignee !== undefined) {
    need(ctx, 'assign', 'assign tickets');
    update.assigneeId = await assigneeOf(body.assignee);
  }
  return { update, note, internal: truthy(body.noteInternal) };
}

/** A note with a status change, worded as the triage form words it. */
async function noteFor(ticketId: string, ctx: Ctx, status: TicketStatus | undefined, note: string, internal: boolean): Promise<void> {
  if (!note) return;
  const prefix = status === 'cancelled' ? 'Cancelled: ' : status === 'resolved' ? 'Resolved: ' : status === 'pending' ? 'On hold: ' : '';
  await addComment({ ticketId, authorId: ctx.actorId, body: prefix + note, isInternal: internal });
}

const bodyOf = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : no(400, 'The body must be a JSON object.');

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/** Create a ticket from a template; priority, group and assignee too, when the key may set them. */
apiWriteRouter.post('/tickets', handle(async (req, res, ctx) => {
  need(ctx, 'create_ticket', 'create tickets');
  const body = bodyOf(req);
  const template = await templateOf(body.template, ctx);
  const title = text(body.title, 200) || template.name;
  const description = text(body.description, 20000) || title;
  // The requester: an account by its address, or a stranger's address on
  // the hidden account - never a new account.
  const email = text(body.requester, 200).toLowerCase();
  let requesterId = await systemRequesterId();
  let externalEmail = '';
  if (email) {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) no(400, '"requester" must be an email address.');
    const person = await queryOne<{ id: string }>("SELECT id FROM users WHERE email = ? AND status = 'active'", [email]);
    if (person) requesterId = person.id;
    else externalEmail = email;
  }
  const { update } = await changesFrom({ priority: body.priority, group: body.group, assignee: body.assignee }, ctx, null);
  const created = await raiseFromRule(template, { title, description, requesterId, externalEmail, fallbackGroupId: null });
  if (Object.keys(update).length > 0) await updateTicket(created.id, ctx.actorId, update);
  audit({ action: 'api.ticket.created', actorId: ctx.actorId, targetType: 'ticket', targetId: created.id, detail: { key: ctx.key.name, template: template.name } });
  res.status(201);
  return { reference: created.reference, id: created.id, url: urlOf(created.id) };
}));

/** Change status, priority, group or assignee - any of them, each with its own permission. */
apiWriteRouter.patch('/tickets/:ref', handle(async (req, _res, ctx) => {
  const ticket = await ticketOf(String(req.params.ref), ctx);
  const body = bodyOf(req);
  const { update, note, internal } = await changesFrom(body, ctx, ticket);
  if (Object.keys(update).length === 0) no(400, 'Nothing to change: send status, priority, group or assignee.');
  author(ctx, 'tickets.edit', 'changing tickets');
  if (internal && note && !seesInternal(ctx.actor)) no(403, 'The role of the person who made this key does not allow internal notes.');
  const changes = await updateTicket(ticket.id, ctx.actorId, update);
  if (update.status && update.status !== ticket.status) await noteFor(ticket.id, ctx, update.status, note, internal);
  audit({ action: 'api.ticket.updated', actorId: ctx.actorId, targetType: 'ticket', targetId: ticket.id, detail: { key: ctx.key.name, fields: changes.map((c) => c.field) } });
  return { reference: referenceOf(ticket), changed: changes.map((c) => c.field) };
}));

/** A comment: public unless "internal" is true. */
apiWriteRouter.post('/tickets/:ref/comments', handle(async (req, res, ctx) => {
  need(ctx, 'add_comment', 'add comments');
  const ticket = await ticketOf(String(req.params.ref), ctx);
  const body = bodyOf(req);
  const message = text(body.body ?? body.message, 20000);
  if (!message) no(400, 'Send the comment as "body".');
  if (truthy(body.internal) && !seesInternal(ctx.actor)) no(403, 'The role of the person who made this key does not allow internal notes.');
  await addComment({ ticketId: ticket.id, authorId: ctx.actorId, body: message, isInternal: truthy(body.internal) });
  audit({ action: 'api.comment.added', actorId: ctx.actorId, targetType: 'ticket', targetId: ticket.id, detail: { key: ctx.key.name, internal: truthy(body.internal) } });
  res.status(201);
  return { reference: referenceOf(ticket), internal: truthy(body.internal) };
}));

const RECIPIENTS = ['requester', 'assignee', 'group', 'manager', 'approver'] as const;

/** Send a notification (built-in or custom, by name or id) about the ticket. */
apiWriteRouter.post('/tickets/:ref/notifications', handle(async (req, _res, ctx) => {
  need(ctx, 'send_notification', 'send notifications');
  const ticket = await ticketOf(String(req.params.ref), ctx);
  const body = bodyOf(req);
  const name = text(body.notification, 120);
  // The English row: a language's copy is chosen per recipient when it is sent.
  const row = name
    ? await queryOne<{ id: string }>("SELECT id FROM mail_notifications WHERE language = '' AND (id = ? OR lower(name) = lower(?))", [name, name])
    : undefined;
  if (!row) no(400, 'No notification "' + name.slice(0, 60) + '". Send its name as "notification".');
  const to = text(body.to, 200).toLowerCase() || 'requester';
  const recipient: AutomationRecipient = (RECIPIENTS as readonly string[]).includes(to)
    ? (to as (typeof RECIPIENTS)[number])
    : /^[^@\s]+@[^@\s]+$/.test(to) ? { email: to } : no(400, '"to" is requester, assignee, group, manager, approver or an email address.');
  const sent = await sendNotification(row!.id, ticket.id, recipient);
  audit({ action: 'api.notification.sent', actorId: ctx.actorId, targetType: 'ticket', targetId: ticket.id, detail: { key: ctx.key.name, to: typeof recipient === 'string' ? recipient : 'address' } });
  return { reference: referenceOf(ticket), queued: sent };
}));

// ---------------------------------------------------------------------------
// Templates and notifications
// ---------------------------------------------------------------------------

const TEMPLATE_TYPES = TICKET_TYPES.filter((t) => t !== 'task');

/** A ticket template: a copy of another, or the standard five fields. Not offered to requesters unless "offer" is true. */
apiWriteRouter.post('/templates', handle(async (req, res, ctx) => {
  need(ctx, 'create_template', 'create ticket templates');
  author(ctx, 'settings.templates', 'creating templates');
  const body = bodyOf(req);
  const name = text(body.name, 120).replace(/\s+/g, ' ');
  if (!name) no(400, 'Send the template\'s name as "name".');
  if (await findTemplateByName(name)) no(409, 'A template named "' + name + '" already exists.');
  const type = oneOf(body.type ?? 'service_request', TEMPLATE_TYPES, { request: 'service_request', change: 'change_request' }, 'type');
  const basedOn = body.basedOn !== undefined ? await templateOf(body.basedOn, ctx) : undefined;
  const made = await createTemplateFrom(
    { name, summary: text(body.summary, 300), type: type as never, basedOnId: basedOn?.id ?? null, isActive: truthy(body.offer) },
    ctx.actorId,
  );
  audit({ action: 'api.template.created', actorId: ctx.actorId, targetType: 'template', targetId: made.id, detail: { key: ctx.key.name, name } });
  res.status(201);
  return { id: made.id, name: made.name, type: made.type, offered: Boolean(made.is_active) };
}));

/** A custom notification, sent later by Send notification (an automation, or the endpoint above). */
apiWriteRouter.post('/notifications', handle(async (req, res, ctx) => {
  need(ctx, 'create_notification', 'create notifications');
  author(ctx, 'settings.mail', 'creating notifications');
  const body = bodyOf(req);
  const name = text(body.name, 120).replace(/\s+/g, ' ');
  if (!name) no(400, 'Send the notification\'s name as "name".');
  if (await findNotificationByName(name)) no(409, 'A notification named "' + name + '" already exists.');
  const made = await createCustomNotification(name, ctx.actorId, {
    subject: text(body.subject, 300),
    bodyHtml: text(body.body, 50000),
  });
  audit({ action: 'api.notification.created', actorId: ctx.actorId, targetType: 'notification', targetId: made.id, detail: { key: ctx.key.name, name } });
  res.status(201);
  return { id: made.id, name: made.name };
}));

/** Whatever else was posted here: not an address this API has. */
apiWriteRouter.use((req, res) => refuse(res, 404, 'No such address for ' + req.method + '.'));

