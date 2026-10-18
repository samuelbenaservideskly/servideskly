import { Router, type NextFunction, type Request, type Response } from 'express';
import { config as appConfig } from '../config.js';
import { query, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { ticketReference } from '../lib/util.js';
import { apiKeyGuessLimiter, hookLimiter } from '../middleware/security.js';
import { keyForSecret, markKeyUsed, type ApiKeyRow } from '../services/api-keys.js';
import { categoryPath } from '../services/catalogue.js';
import { slaFor } from '../services/sla.js';
import { PRIORITY_LABELS, STATUS_LABELS, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_TYPES, TYPE_LABELS, type TicketPriority, type TicketStatus, type TicketType } from '../services/tickets.js';
import { ticketFor } from './hooks.js';

const log = logger.child({ module: 'api' });

/**
 * GET /api/v1/... - reading tickets with an API key.
 *
 * The other half of the API keys: /hooks starts an automation that changes
 * something; this only reads. A key needs **Read tickets** ticked, and
 * **Read internal notes** for those. A key limited to some templates sees
 * only their tickets - anything else is "not found", exactly like a ticket
 * that does not exist, so a key cannot learn what it may not read.
 *
 * A machine API: bearer key, no session, no CSRF, JSON out, mounted beside
 * /hooks ahead of the browser pipeline, with the same rate limit.
 */
export const apiReadRouter = Router();

apiReadRouter.use(hookLimiter);
apiReadRouter.use(apiKeyGuessLimiter);

function refuse(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/** The key, and whether it may read at all. */
async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const secret = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? '';
    const key = await keyForSecret(secret);
    if (!key) {
      refuse(res, 401, 'Access denied.');
      return;
    }
    if (!key.allowed_actions.includes('read_tickets')) {
      refuse(res, 403, 'This key may not read tickets. Tick "Read tickets" on it under Settings - Advanced - API keys.');
      return;
    }
    await markKeyUsed(key.id);
    res.locals.key = key;
    next();
  } catch (err) {
    next(err);
  }
}
apiReadRouter.use(authenticate);

interface Row {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  ref_prefix: string;
  ref_seq: number;
  parent_id: string | null;
  template_id: string | null;
  template_name: string | null;
  category_id: string | null;
  requester_id: string;
  requester_name: string;
  requester_email: string;
  external_email: string;
  assignee_name: string | null;
  assignee_email: string | null;
  group_name: string | null;
  raised_by_name: string | null;
  approval_status: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
}

const SELECT = `SELECT t.id, t.title, t.description, t.status, t.priority, t.type, t.ref_prefix, t.ref_seq, t.parent_id,
    t.template_id, tt.name AS template_name, t.category_id, t.requester_id, t.external_email,
    r.display_name AS requester_name, r.email AS requester_email,
    a.display_name AS assignee_name, a.email AS assignee_email,
    g.name AS group_name, rb.display_name AS raised_by_name, t.approval_status,
    t.created_at, t.updated_at, t.resolved_at, t.closed_at
  FROM tickets t
  JOIN users r ON r.id = t.requester_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users rb ON rb.id = t.raised_by
  LEFT JOIN technician_groups g ON g.id = t.group_id
  LEFT JOIN ticket_templates tt ON tt.id = t.template_id`;

/** A key limited to templates reads only their tickets. */
function allowedFor(key: ApiKeyRow, row: { template_id: string | null }): boolean {
  return key.template_ids.length === 0 || (row.template_id !== null && key.template_ids.includes(row.template_id));
}

/** One ticket as the API gives it; `full` adds what a list leaves out. */
async function shape(row: Row, full: boolean) {
  const base = {
    reference: ticketReference(Number(row.ref_seq), row.ref_prefix),
    id: row.id,
    title: row.title,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    priority: row.priority,
    priorityLabel: PRIORITY_LABELS[row.priority],
    type: row.type,
    typeLabel: TYPE_LABELS[row.type],
    requester: {
      name: row.requester_name,
      // Mail from somebody without an account: the address it came from.
      email: row.external_email || row.requester_email,
    },
    assignee: row.assignee_name ? { name: row.assignee_name, email: row.assignee_email } : null,
    group: row.group_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    url: appConfig.publicOrigin + '/tickets/' + row.id,
  };
  if (!full) return base;

  const sla = await slaFor({ ...row, resolved_at: row.resolved_at, closed_at: row.closed_at });
  const files = await query<{ filename: string; content_type: string; byte_size: number; is_internal: number; created_at: string }>(
    'SELECT filename, content_type, byte_size, is_internal, created_at FROM ticket_attachments WHERE ticket_id = ? AND deleted_at IS NULL ORDER BY created_at',
    [row.id],
  );
  const parent = row.parent_id
    ? await queryOne<{ ref_prefix: string; ref_seq: number }>('SELECT ref_prefix, ref_seq FROM tickets WHERE id = ?', [row.parent_id])
    : undefined;
  const tasks = await query<{ ref_prefix: string; ref_seq: number; title: string; status: TicketStatus }>(
    'SELECT ref_prefix, ref_seq, title, status FROM tickets WHERE parent_id = ? ORDER BY created_at',
    [row.id],
  );
  return {
    ...base,
    description: row.description,
    template: row.template_name,
    category: row.category_id ? await categoryPath(row.category_id) : null,
    raisedBy: row.raised_by_name,
    approval: row.approval_status === 'none' ? null : row.approval_status,
    parent: parent ? ticketReference(Number(parent.ref_seq), parent.ref_prefix) : null,
    tasks: tasks.map((t) => ({ reference: ticketReference(Number(t.ref_seq), t.ref_prefix), title: t.title, status: t.status })),
    sla: sla
      ? {
          response: { state: sla.response.state, due: sla.response.due.toISOString(), doneAt: sla.response.doneAt?.toISOString() ?? null },
          resolution: { state: sla.resolution.state, due: sla.resolution.due.toISOString(), doneAt: sla.resolution.doneAt?.toISOString() ?? null },
        }
      : null,
    files: files.map((f) => ({ name: f.filename, type: f.content_type, size: Number(f.byte_size), internal: Boolean(f.is_internal), addedAt: f.created_at })),
  };
}

async function findReadable(req: Request, res: Response): Promise<Row | undefined> {
  const key = res.locals.key as ApiKeyRow;
  const id = await ticketFor(String(req.params.ref));
  const row = id ? await queryOne<Row>(SELECT + ' WHERE t.id = ?', [id]) : undefined;
  if (!row || !allowedFor(key, row)) {
    refuse(res, 404, 'There is no such ticket.');
    return undefined;
  }
  return row;
}

/** GET /api/v1/tickets/INC-000123 */
apiReadRouter.get('/tickets/:ref', async (req, res, next) => {
  try {
    const row = await findReadable(req, res);
    if (!row) return;
    res.json(await shape(row, true));
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tickets/INC-000123/comments */
apiReadRouter.get('/tickets/:ref/comments', async (req, res, next) => {
  try {
    const key = res.locals.key as ApiKeyRow;
    const row = await findReadable(req, res);
    if (!row) return;
    const internal = key.allowed_actions.includes('read_internal');
    const comments = await query<{ body: string; is_internal: number; created_at: string; author_name: string }>(
      `SELECT c.body, c.is_internal, c.created_at, u.display_name AS author_name
         FROM ticket_comments c JOIN users u ON u.id = c.author_id
        WHERE c.ticket_id = ?${internal ? '' : ' AND c.is_internal = 0'}
        ORDER BY c.created_at`,
      [row.id],
    );
    res.json({
      reference: ticketReference(Number(row.ref_seq), row.ref_prefix),
      // Without "Read internal notes" they are left out, and the answer says so.
      includesInternal: internal,
      items: comments.map((c) => ({ author: c.author_name, body: c.body, internal: Boolean(c.is_internal), createdAt: c.created_at })),
    });
  } catch (err) {
    next(err);
  }
});

const MAX_LIMIT = 100;

/**
 * GET /api/v1/tickets - all tickets, or only some:
 *   status, priority, type (comma-separated), requester, assignee (email or
 *   "none"), group, template (names), search (in the title), createdSince,
 *   updatedSince (date and time), tasks=include; limit (max 100), offset.
 */
apiReadRouter.get('/tickets', async (req, res, next) => {
  try {
    const key = res.locals.key as ApiKeyRow;
    const q = (name: string) => (typeof req.query[name] === 'string' ? (req.query[name] as string).trim() : '');
    const where: string[] = [];
    const params: unknown[] = [];

    const statuses = q('status').split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.some((s) => !(TICKET_STATUSES as readonly string[]).includes(s))) {
      refuse(res, 400, 'status is one or more of: ' + TICKET_STATUSES.join(', ') + ' (comma-separated).');
      return;
    }
    if (statuses.length) {
      where.push('t.status IN (' + statuses.map(() => '?').join(', ') + ')');
      params.push(...statuses);
    }
    const priorities = q('priority').split(',').map((s) => s.trim()).filter(Boolean);
    if (priorities.some((p) => !(TICKET_PRIORITIES as readonly string[]).includes(p))) {
      refuse(res, 400, 'priority is one or more of: ' + TICKET_PRIORITIES.join(', ') + '.');
      return;
    }
    if (priorities.length) {
      where.push('t.priority IN (' + priorities.map(() => '?').join(', ') + ')');
      params.push(...priorities);
    }
    if (q('requester')) {
      where.push('(lower(r.email) = lower(?) OR lower(t.external_email) = lower(?))');
      params.push(q('requester'), q('requester'));
    }
    if (q('group')) {
      where.push('lower(g.name) = lower(?)');
      params.push(q('group'));
    }
    const types = q('type').split(',').map((s) => s.trim()).filter(Boolean);
    if (types.some((t) => !(TICKET_TYPES as readonly string[]).includes(t))) {
      refuse(res, 400, 'type is one or more of: ' + TICKET_TYPES.join(', ') + '.');
      return;
    }
    if (types.length) {
      where.push('t.type IN (' + types.map(() => '?').join(', ') + ')');
      params.push(...types);
    }
    if (q('assignee') === 'none') {
      where.push('t.assignee_id IS NULL');
    } else if (q('assignee')) {
      where.push('lower(a.email) = lower(?)');
      params.push(q('assignee'));
    }
    if (q('template')) {
      where.push('lower(tt.name) = lower(?)');
      params.push(q('template'));
    }
    if (q('search')) {
      // Words in the title, any case; % and _ taken literally.
      where.push("lower(t.title) LIKE ? ESCAPE '\\'");
      params.push('%' + q('search').toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    }
    if (q('createdSince')) {
      const since = new Date(q('createdSince'));
      if (Number.isNaN(since.getTime())) {
        refuse(res, 400, 'createdSince is a date and time, such as 2026-10-01T00:00:00Z.');
        return;
      }
      where.push('t.created_at >= ?');
      params.push(since.toISOString());
    }
    if (q('updatedSince')) {
      const since = new Date(q('updatedSince'));
      if (Number.isNaN(since.getTime())) {
        refuse(res, 400, 'updatedSince is a date and time, such as 2026-10-01T00:00:00Z.');
        return;
      }
      where.push('t.updated_at >= ?');
      params.push(since.toISOString());
    }
    if (q('tasks') !== 'include') where.push('t.parent_id IS NULL');
    if (key.template_ids.length > 0) {
      where.push('t.template_id IN (' + key.template_ids.map(() => '?').join(', ') + ')');
      params.push(...key.template_ids);
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(q('limit') || '50', 10) || 50));
    const offset = Math.max(0, Number.parseInt(q('offset') || '0', 10) || 0);
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = await queryOne<{ n: number }>(
      // The same joins as the page itself, so every filter means the same here.
      'SELECT count(*) AS n' + SELECT.slice(SELECT.indexOf(' FROM tickets t')) + clause,
      params,
    );
    const rows = await query<Row>(SELECT + clause + ' ORDER BY t.updated_at DESC LIMIT ? OFFSET ?', [...params, limit, offset]);
    const items = [];
    for (const row of rows) items.push(await shape(row, false));
    const count = Number(total?.n ?? 0);
    res.json({ total: count, limit, offset, next: offset + limit < count ? offset + limit : null, items });
  } catch (err) {
    next(err);
  }
});

apiReadRouter.use((_req: Request, res: Response) => refuse(res, 404, 'Not found.'));

apiReadRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err }, 'api request failed');
  audit({ action: 'api.failed', outcome: 'failure', actorId: null, targetType: 'api', targetId: 'read' });
  refuse(res, 500, 'Something went wrong.');
});
