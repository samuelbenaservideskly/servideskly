import { clientOne, count, execute, query, queryOne, transaction, type DbClient } from '../db/index.js';
import { conflict } from '../lib/errors.js';
import { announce, asAutomatic, isAutomatic } from './events.js';
import { newId, nowIso, ticketReference } from '../lib/util.js';
import crypto from 'node:crypto';
import { settings } from '../settings/index.js';
import { audit } from '../lib/audit.js';
import { removeStoredFile } from './attachments.js';
import { isStaff, type UserRow } from './users.js';
import { loadSlaFacts, slaFromFacts, slaMatches, type SlaFilter } from './sla.js';

export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'pending',
  'resolved',
  'closed',
  'cancelled',
] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TICKET_CATEGORIES = ['access', 'hardware', 'software', 'network', 'other'] as const;

/**
 * What kind of work a ticket is.
 *
 * Fixed rather than configurable, because the four behave differently: a
 * task is the only one that belongs to another ticket, and the other three
 * are the only ones a task can belong to.
 */
export const TICKET_TYPES = ['incident', 'service_request', 'change_request', 'task'] as const;

/** The types a task can be raised under - everything except another task. */
export const PARENT_TYPES = ['incident', 'service_request', 'change_request'] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketType = (typeof TICKET_TYPES)[number];

/** Statuses that count as still needing work, for the default queue view. */
const OPEN_STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'pending'];

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  // The stored value stays 'pending': it is in every ticket row and every
  // query, and a label is not worth a migration that rewrites both.
  pending: 'On-hold',
  resolved: 'Resolved',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const TYPE_LABELS: Record<TicketType, string> = {
  incident: 'Incident',
  service_request: 'Service request',
  change_request: 'Change request',
  task: 'Task',
};

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  access: 'Access / accounts',
  hardware: 'Hardware',
  software: 'Software',
  network: 'Network',
  other: 'Other',
};

export interface TicketRow {
  seq: string | number;
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  requester_id: string;
  assignee_id: string | null;
  group_id: string | null;
  /**
   * Who to reply to when a ticket arrived by email from somebody with no
   * account. Empty for everything raised in the application.
   */
  external_email: string;
  type: TicketType;
  /** The ticket this task belongs to. Null for everything else. */
  parent_id: string | null;
  /** The template it was raised from, if any. */
  template_id?: string | null;
  /** Who filled in the form, when the ticket was raised on behalf of its requester. */
  raised_by?: string | null;
  /** On a task: it has to be done (from its task template). */
  task_mandatory?: boolean;
  /** On a ticket with tasks: close it once every mandatory task is done. */
  close_when_tasks_done?: boolean;
  /** On a ticket with tasks: no resolving or closing while any task is open. */
  require_tasks_done?: boolean;
  /** Catalogue node, at whatever depth was chosen. */
  category_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  /** The prefix this ticket's reference is written with, fixed at creation. */
  ref_prefix: string;
  /** The number within that prefix. Not unique on its own; `seq` is. */
  ref_seq: string | number;
  /** Who was asked to approve this, if anybody. */
  approval_email: string;
  approval_status: 'none' | 'pending' | 'approved' | 'rejected';
  approval_decided_at: string | null;
  approval_token: string;
}

export interface TicketListItem extends TicketRow {
  reference: string;
  requester_name: string;
  /**
   * The person's own names and company, beside the built display name.
   *
   * The display name follows a format an administrator chose, which may fold
   * the company into it ("Tomas Dvorak - (Contoso)"). A list column is the
   * one place that reads badly: it truncates in the middle of the company and
   * buries the name. The queue shows the name and, under it, the company.
   */
  requester_first_name: string | null;
  requester_last_name: string | null;
  requester_company: string | null;
  assignee_first_name: string | null;
  assignee_last_name: string | null;
  assignee_company: string | null;
  requester_email: string;
  assignee_name: string | null;
  comment_count: number;
}

export interface CommentRow {
  id: string;
  ticket_id: string;
  author_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
  author_name: string;
  author_role: string;
}

export interface EventRow {
  id: string;
  kind: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
  actor_name: string | null;
}

const TICKET_SELECT = `
  SELECT t.*,
         requester.display_name AS requester_name,
         requester.email        AS requester_email,
         requester.first_name   AS requester_first_name,
         requester.last_name    AS requester_last_name,
         requester.company      AS requester_company,
         assignee.display_name  AS assignee_name,
         assignee.first_name    AS assignee_first_name,
         assignee.last_name     AS assignee_last_name,
         assignee.company       AS assignee_company,
         grp.name               AS group_name,
         parent.seq             AS parent_seq,
         parent.title           AS parent_title,
         (SELECT count(*) FROM ticket_comments c WHERE c.ticket_id = t.id) AS comment_count
    FROM tickets t
    JOIN users requester ON requester.id = t.requester_id
    LEFT JOIN users assignee ON assignee.id = t.assignee_id
    LEFT JOIN technician_groups grp ON grp.id = t.group_id
    LEFT JOIN tickets parent ON parent.id = t.parent_id
`;

/**
 * `seq` is a bigint, which node-postgres returns as a string to avoid losing
 * precision. The reference is derived from it as a string either way.
 */
function withReference<T extends TicketRow>(row: T): T & { reference: string } {
  // The stored prefix, not one worked out from the type now: a reference
  // already quoted in somebody's mail must keep naming the same ticket, so
  // changing a prefix in settings never rewrites one that exists.
  return { ...row, reference: ticketReference(Number(row.ref_seq), row.ref_prefix) };
}

/**
 * The prefix a new ticket's reference is written with.
 *
 * A **change task** is the only type that is not simply the ticket's own: a
 * task is a change task when the thing it hangs off is a change request, and
 * that is true at the moment it is raised rather than a column on the row.
 */
export function prefixFor(type: TicketType, parent?: TicketRow | undefined): string {
  const prefixes = settings().tickets.prefixes;
  if (type === 'task' && parent?.type === 'change_request') return prefixes.change_task;
  return prefixes[type];
}

/**
 * Removes a ticket, its comments, its files and its mail history.
 *
 * The only destructive action in the application, which is why it is
 * administrator-only, needs a reason, and tells the group manager (else the other administrators).
 *
 * A **real** delete, not a flag. A ticket kept with a "deleted" column is
 * still a ticket somebody can be shown by a query that forgets the column,
 * and the point of deleting one is usually that its contents should not be
 * here. Comments, attachment rows, mail threads and any tasks beneath it go
 * with it through ON DELETE CASCADE; the attachment **files** are removed
 * here, because the filesystem has no foreign keys.
 *
 * What survives: the audit entry, and the email about it.
 * That is deliberate - a deletion that leaves no trace is indistinguishable
 * from a ticket that never existed.
 */
export async function deleteTicket(ticketId: string): Promise<void> {
  const files = await query<AttachmentFile>(
    'SELECT storage_key FROM ticket_attachments WHERE ticket_id = ?',
    [ticketId],
  );

  await execute('DELETE FROM tickets WHERE id = ?', [ticketId]);

  // After the row is gone, so a failure here leaves an unreferenced file
  // rather than a ticket pointing at a file that is not there.
  for (const file of files) {
    await removeStoredFile(file.storage_key);
  }
}

interface AttachmentFile {
  storage_key: string;
}

/**
 * Statuses that say the work is finished, and so need the approval first.
 *
 * Cancelled is **not** one of them: withdrawing a request nobody approved is
 * exactly what should still be possible, and making somebody approve a ticket
 * before it can be cancelled would be a trap.
 */
export const CLOSING_STATUSES: readonly TicketStatus[] = ['resolved', 'closed'];

/** Why this ticket cannot move to that status yet, or '' when it can. */
export function approvalBlocks(ticket: TicketRow, next: TicketStatus): string {
  if (!CLOSING_STATUSES.includes(next)) return '';
  if (ticket.approval_status === 'pending') {
    return 'This ticket is waiting for ' + ticket.approval_email + ' to approve it.';
  }
  if (ticket.approval_status === 'rejected') {
    return (
      ticket.approval_email +
      ' did not approve this ticket, so it cannot be resolved. Cancel it instead.'
    );
  }
  return '';
}

/** A task in one of these needs nothing more. Cancelled counts: a task that will not be done must not hold the ticket for ever. */
export const DONE_STATUSES: readonly TicketStatus[] = ['resolved', 'closed', 'cancelled'];

/**
 * Why this ticket cannot be resolved or closed while its tasks are open, or
 * ''. Only for a ticket raised from a template that asked for it.
 */
export async function tasksBlock(ticket: TicketRow, next: TicketStatus): Promise<string> {
  if (!CLOSING_STATUSES.includes(next) || !ticket.require_tasks_done) return '';
  const open = await query<{ c: number }>(
    'SELECT count(*) AS c FROM tickets WHERE parent_id = ? AND status NOT IN (?, ?, ?)',
    [ticket.id, ...DONE_STATUSES],
  );
  const n = Number(open[0]?.c ?? 0);
  if (n === 0) return '';
  return n === 1
    ? 'One task is still open. Resolve or cancel it before this ticket can be ' + (next === 'closed' ? 'closed' : 'resolved') + '.'
    : n + ' tasks are still open. Resolve or cancel them before this ticket can be ' + (next === 'closed' ? 'closed' : 'resolved') + '.';
}

/**
 * After a task is done: closes its parent when the parent asked for that and
 * every mandatory task is now done. Never past the parent's own gates - an
 * approval still awaited, or other tasks it requires - and never when it
 * has no mandatory task at all, which would close it on the first one done.
 */
async function closeParentIfDone(parentId: string, actorId: string): Promise<void> {
  const parent = await queryOne<TicketRow>('SELECT * FROM tickets WHERE id = ?', [parentId]);
  if (!parent || !parent.close_when_tasks_done || parent.status === 'closed' || parent.status === 'cancelled') return;
  const tasks = await query<TicketRow>('SELECT * FROM tickets WHERE parent_id = ?', [parentId]);
  const mandatory = tasks.filter((t) => t.task_mandatory);
  if (mandatory.length === 0 || mandatory.some((t) => !DONE_STATUSES.includes(t.status))) return;
  if (approvalBlocks(parent, 'closed') || (await tasksBlock(parent, 'closed'))) return;
  // The service desk closing it by itself: the close still resolves it, but
  // nothing here is somebody answering the requester.
  await asAutomatic(async () => {
    await updateTicket(parentId, actorId, { status: 'closed' });
    await addComment({
      ticketId: parentId,
      authorId: actorId,
      body: 'Closed automatically: every mandatory task is resolved.',
      isInternal: false,
    });
  });
}

/** Records an approver's answer. Returns false if it was already answered. */
export async function recordApproval(
  ticketId: string,
  decision: 'approved' | 'rejected',
): Promise<boolean> {
  const changed = await execute(
    `UPDATE tickets
        SET approval_status = ?, approval_decided_at = ?, updated_at = ?
      WHERE id = ? AND approval_status = 'pending'`,
    [decision, nowIso(), nowIso(), ticketId],
  );
  return Number(changed ?? 0) > 0;
}

/** The ticket a decision link belongs to. The token is the whole check. */
export async function ticketByApprovalToken(token: string): Promise<(TicketRow & { reference: string }) | undefined> {
  if (!token || token.length < 32) return undefined;
  const row = await queryOne<TicketRow>(
    "SELECT * FROM tickets WHERE approval_token = ? AND approval_token <> ''",
    [token],
  );
  return row ? withReference(row) : undefined;
}


/**
 * Closes resolved tickets that have been sitting for long enough.
 *
 * A sweep on a timer rather than a per-ticket alarm: one query answers
 * "what is overdue" for every ticket at once, and a restart cannot lose a
 * timer that was only ever in memory.
 *
 * Only **resolved** tickets, never on hold or open ones: resolved means the
 * service desk believes the work is done and is waiting to be contradicted,
 * which is the only state where silence is consent.
 */
export async function autoCloseResolved(): Promise<number> {
  const days = settings().automation.autoCloseDays;
  if (days <= 0) return 0;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const due = await query<TicketRow>(
    "SELECT * FROM tickets WHERE status = (?) AND updated_at < ? LIMIT 200",
    ['resolved', cutoff],
  );

  for (const ticket of due) {
    await execute(
      "UPDATE tickets SET status = (?), closed_at = ?, updated_at = ? WHERE id = ? AND status = (?)",
      ['closed', nowIso(), nowIso(), ticket.id, 'resolved'],
    );
    audit({
      action: 'ticket.closed.automatically',
      actorId: null,
      actorEmail: '',
      targetType: 'ticket',
      targetId: ticket.id,
      detail: { afterDays: days },
    });
  }

  return due.length;
}

/**
 * Deletes closed tickets once they are older than the retention setting.
 *
 * A sweep beside autoCloseResolved, and for the same reason: one query
 * answers "what is past its day" for every ticket at once.
 *
 * Three things it has to get right:
 *
 * 1. **Top-level tickets only.** A task is part of its ticket and goes with
 *    it through ON DELETE CASCADE; deleting a task that closed months ago
 *    from under a ticket that is still open would take a piece out of an
 *    open ticket's history.
 * 2. **The audit entry is written before the row goes** - afterwards there
 *    is nothing left to describe - and it names the reference and the title,
 *    because the id means nothing once the ticket is gone.
 * 3. **Closed, by `closed_at`**, not by `updated_at`: a comment on a closed
 *    ticket should not buy it another year, and a ticket that was reopened
 *    and closed again counts from the second time.
 */
export async function deleteOldClosedTickets(): Promise<number> {
  const days = settings().tickets.deleteClosedAfterDays;
  if (days <= 0) return 0;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const due = await query<TicketRow>(
    `SELECT * FROM tickets
      WHERE status = (?) AND parent_id IS NULL
        AND closed_at IS NOT NULL AND closed_at < ?
      LIMIT 100`,
    ['closed', cutoff],
  );

  for (const ticket of due) {
    const { reference } = withReference(ticket);
    audit({
      action: 'ticket.deleted.automatically',
      actorId: null,
      actorEmail: '',
      targetType: 'ticket',
      targetId: ticket.id,
      detail: { reference, title: ticket.title, closedAt: ticket.closed_at, afterDays: days },
    });
    await deleteTicket(ticket.id);
  }

  return due.length;
}

// --- creation --------------------------------------------------------------

export interface CreateTicketInput {
  title: string;
  description: string;
  priority: TicketPriority;
  category: TicketCategory;
  requesterId: string;
  /** The template this was raised from, if any. Recorded for reporting. */
  templateId?: string | null;
  type?: TicketType;
  /** Routed to a team at creation, usually from the template. */
  groupId?: string | null;
  /**
   * Assigned at creation, when the form asked for it (the Assignee field).
   * Checked by the caller against the people a ticket may be assigned to -
   * this writes what it is given.
   */
  assigneeId?: string | null;
  /** Catalogue node, at whatever depth. */
  categoryId?: string | null;
  /** Set only for a task: the ticket it belongs to. */
  parentId?: string | null;
  /**
   * Where to reply when the ticket arrived by email from somebody with no
   * account. Empty for everything raised in the application.
   */
  externalEmail?: string;
  /** Somebody who has to approve this before it can be resolved or closed. */
  approvalEmail?: string;
  /** Who filled in the form, when not the requester ("On behalf of"). */
  raisedBy?: string | null;
  /** Task rules, copied from the template when the ticket is raised. */
  taskMandatory?: boolean;
  closeWhenTasksDone?: boolean;
  requireTasksDone?: boolean;
}

export async function createTicket(input: CreateTicketInput): Promise<TicketListItem> {
  const created = await createTicketRow(input);
  await announce({ kind: 'ticket.created', ticketId: created.id, actorId: input.requesterId });
  return created;
}

function createTicketRow(input: CreateTicketInput): Promise<TicketListItem> {
  return transaction(async (client) => {
    const id = newId();
    const now = nowIso();

    // The human-facing reference number. SQLite has no sequences, and the
    // one auto-increment it does have is reserved for the primary key,
    // which here is the opaque uuid. Allocating it inside the transaction
    // is safe: BEGIN IMMEDIATE means no other writer is in flight.
    const [seqRow] = await client.query<{ next: number }>(
      'SELECT coalesce(max(seq), 0) + 1 AS next FROM tickets',
    );
    const seq = seqRow?.next ?? 1;

    // A task takes the change-task prefix when its parent is a change
    // request, so the parent is looked up before the reference is written.
    const type = input.type ?? 'incident';
    const parent = input.parentId
      ? (await client.query<TicketRow>('SELECT * FROM tickets WHERE id = ?', [input.parentId]))[0]
      : undefined;
    const refPrefix = prefixFor(type, parent);

    // The number people read counts within its own prefix, so an incident
    // does not take a number from the service requests raised beside it.
    // Safe inside the transaction for the same reason `seq` is: BEGIN
    // IMMEDIATE means no other writer is in flight.
    const [refRow] = await client.query<{ next: number }>(
      'SELECT coalesce(max(ref_seq), 0) + 1 AS next FROM tickets WHERE ref_prefix = ?',
      [refPrefix],
    );
    const refSeq = refRow?.next ?? 1;

    const approvalEmail = (input.approvalEmail ?? '').trim().toLowerCase();

    await client.query(
      `INSERT INTO tickets
         (id, seq, title, description, status, priority, category, requester_id,
          assignee_id, template_id, type, group_id, category_id, parent_id,
          external_email, ref_prefix, ref_seq, approval_email, approval_status,
          approval_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        seq,
        input.title,
        input.description,
        input.priority,
        input.category,
        input.requesterId,
        input.assigneeId ?? null,
        input.templateId ?? null,
        type,
        input.groupId ?? null,
        input.categoryId ?? null,
        input.parentId ?? null,
        input.externalEmail ?? '',
        refPrefix,
        refSeq,
        approvalEmail,
        approvalEmail ? 'pending' : 'none',
        // A token only exists when somebody is being asked, so a ticket with
        // no approver has nothing that could be guessed.
        approvalEmail ? crypto.randomBytes(32).toString('hex') : '',
        now,
        now,
      ],
    );

    if (input.raisedBy && input.raisedBy !== input.requesterId) {
      await client.query('UPDATE tickets SET raised_by = ? WHERE id = ?', [input.raisedBy, id]);
    }
    if (input.taskMandatory || input.closeWhenTasksDone || input.requireTasksDone) {
      await client.query(
        'UPDATE tickets SET task_mandatory = ?, close_when_tasks_done = ?, require_tasks_done = ? WHERE id = ?',
        [input.taskMandatory ? 1 : 0, input.closeWhenTasksDone ? 1 : 0, input.requireTasksDone ? 1 : 0, id],
      );
    }

    await client.query(
      `INSERT INTO ticket_events (id, ticket_id, actor_id, kind, created_at)
       VALUES (?, ?, ?, 'created', ?)`,
      [newId(), id, input.requesterId, now],
    );

    const created = await clientOne<TicketListItem>(client, TICKET_SELECT + ' WHERE t.id = ?', [
      id,
    ]);
    if (!created) throw new Error('Ticket vanished immediately after insert: ' + id);
    return withReference(created);
  });
}

// --- reads -----------------------------------------------------------------

export async function getTicketById(id: string): Promise<TicketListItem | undefined> {
  const row = await queryOne<TicketListItem>(TICKET_SELECT + ' WHERE t.id = ?', [id]);
  return row ? withReference(row) : undefined;
}

/**
 * The columns the queue may be ordered by, and the SQL for each.
 *
 * A whitelist, not a column name from the query string: this text goes into
 * an ORDER BY, where a placeholder cannot stand.
 *
 * - **reference** is `seq`, the global counter, so it reads as "oldest first"
 *   rather than interleaving the per-type numbers.
 * - **priority** ranks by severity. Sorted as text it would read high, low,
 *   normal, urgent, which is nobody's idea of priority.
 * - **requester** and **assignee** sort by the name shown, not the id.
 */
export const SORTABLE = {
  reference: 't.seq',
  title: 'lower(t.title)',
  type: 't.type',
  status: 't.status',
  priority: "CASE t.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END",
  requester: 'lower(coalesce(requester.display_name, t.external_email))',
  assignee: 'lower(assignee.display_name)',
  updated: 't.updated_at',
} as const;

export type TicketSort = keyof typeof SORTABLE;

export function isTicketSort(value: unknown): value is TicketSort {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SORTABLE, value);
}

/** The ORDER BY for a sort choice. `seq` breaks every tie, so paging is stable. */
function orderBy(sort: TicketSort | undefined, dir: 'asc' | 'desc' | undefined): string {
  if (!sort) return ' ORDER BY t.updated_at DESC, t.seq DESC';
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  // Unassigned last whichever way the column is sorted: an empty cell is not
  // a name, and a column of them at the top is nobody's answer.
  const nulls = sort === 'assignee' ? 'assignee.display_name IS NULL, ' : '';
  return ' ORDER BY ' + nulls + SORTABLE[sort] + ' ' + direction + ', t.seq DESC';
}

export interface TicketFilters {
  /** 'mine' restricts to tickets the viewer raised, 'assigned' to their queue. */
  scope?: 'all' | 'mine' | 'assigned' | 'unassigned' | 'myGroups';
  type?: TicketType | 'any';
  /** A node and everything beneath it, expanded by the caller. */
  categoryIds?: readonly string[];
  /** Tasks are hidden from the queue by default; they belong to a parent. */
  includeTasks?: boolean;
  /** Restricts to one technician group, whatever the scope. */
  groupId?: string;
  /** Restricts to one requester (staff: "all their tickets" from a ticket). */
  requesterId?: string;
  /** Restricts to one assignee (staff: a person's page). */
  assigneeId?: string;
  /** Membership of the viewer, for scope 'myGroups'. Supplied by the route. */
  viewerGroupIds?: readonly string[];
  status?: TicketStatus | 'any' | 'active';
  priority?: TicketPriority | 'any';
  /** Staff only, and only while SLA is on: worked out per ticket, not in SQL. */
  sla?: SlaFilter;
  search?: string;
  /** A column from SORTABLE, or absent for the default (most recent first). */
  sort?: TicketSort;
  dir?: 'asc' | 'desc';
  page: number;
  perPage: number;
}

export interface TicketPage {
  items: TicketListItem[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
  /** The SLA filter read only the SLA_FILTER_CAP most recently updated matches. */
  slaCapped?: boolean;
}

/** Tickets the SLA filter reads at most: their clocks are worked out, not stored. */
export const SLA_FILTER_CAP = 2000;

/**
 * Lists tickets the viewer is allowed to see.
 *
 * Row-level authorisation is applied in SQL, not in the template: a requester
 * can only ever match their own tickets, so a crafted filter cannot widen the
 * result set.
 */
export async function listTickets(viewer: UserRow, filters: TicketFilters): Promise<TicketPage> {
  const where: string[] = [];
  const params: unknown[] = [];
  const placeholder = () => "?";

  if (!isStaff(viewer.role)) {
    params.push(viewer.id, viewer.id);
    where.push('(t.requester_id = ' + placeholder() + ' OR t.raised_by = ' + placeholder() + ')');
  } else if (filters.scope === 'mine') {
    params.push(viewer.id);
    where.push('t.requester_id = ' + placeholder());
  } else if (filters.scope === 'assigned') {
    params.push(viewer.id);
    where.push('t.assignee_id = ' + placeholder());
  } else if (filters.scope === 'unassigned') {
    where.push('t.assignee_id IS NULL');
  } else if (filters.scope === 'myGroups') {
    // Routed to a team this person belongs to. An empty membership matches
    // nothing rather than everything, which is the safe way round.
    const groupIds = filters.viewerGroupIds ?? [];
    if (groupIds.length === 0) {
      where.push('1 = 0');
    } else {
      params.push(...groupIds);
      where.push('t.group_id IN (' + groupIds.map(placeholder).join(', ') + ')');
    }
  }

  if (filters.groupId) {
    params.push(filters.groupId);
    where.push('t.group_id = ' + placeholder());
  }

  if (filters.requesterId) {
    params.push(filters.requesterId);
    where.push('t.requester_id = ' + placeholder());
  }

  if (filters.assigneeId) {
    params.push(filters.assigneeId);
    where.push('t.assignee_id = ' + placeholder());
  }

  if (filters.type && filters.type !== 'any') {
    params.push(filters.type);
    where.push('t.type = ' + placeholder());
  }

  // Filing against a parent category means the ones beneath it too, so the
  // route expands the id set before it gets here.
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    params.push(...filters.categoryIds);
    where.push('t.category_id IN (' + filters.categoryIds.map(placeholder).join(', ') + ')');
  }

  // Tasks live under their parent, so they would otherwise double up in the
  // queue. They are still reachable from the ticket they belong to.
  if (filters.includeTasks !== true) {
    where.push('t.parent_id IS NULL');
  }

  const status = filters.status ?? 'active';
  if (status === 'active') {
    params.push(...OPEN_STATUSES);
    where.push('t.status IN (' + OPEN_STATUSES.map(placeholder).join(', ') + ')');
  } else if (status !== 'any') {
    params.push(status);
    where.push('t.status = ' + placeholder());
  }

  if (filters.priority && filters.priority !== 'any') {
    params.push(filters.priority);
    where.push('t.priority = ' + placeholder());
  }

  const search = filters.search?.trim();
  if (search) {
    // LIKE with an explicit ESCAPE so user-supplied % and _ stay literal.
    const pattern = '%' + search.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    params.push(pattern, pattern);
    where.push(
      "(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')",
    );
  }

  const whereSql = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';

  // The SLA filter: the clocks are worked out from each ticket's dates and
  // history (nothing is stored), so the other filters choose the tickets in
  // SQL and the clocks are read for those in bulk - the same facts and the
  // same rules as Reports. Capped, newest first.
  if (filters.sla && isStaff(viewer.role) && settings().sla.enabled) {
    const candidates = await query<{ id: string; requester_id: string; priority: TicketPriority; status: TicketStatus; created_at: string; resolved_at: string | null; closed_at: string | null; parent_id: string | null }>(
      'SELECT t.id, t.requester_id, t.priority, t.status, t.created_at, t.resolved_at, t.closed_at, t.parent_id' +
        ' FROM tickets t' +
        ' JOIN users requester ON requester.id = t.requester_id' +
        ' LEFT JOIN users assignee ON assignee.id = t.assignee_id' +
        whereSql +
        orderBy(filters.sort, filters.dir) +
        ' LIMIT ' + (SLA_FILTER_CAP + 1),
      params,
    );
    const sample = candidates.slice(0, SLA_FILTER_CAP);
    const facts = await loadSlaFacts(sample);
    const now = new Date();
    const wanted = filters.sla;
    const matching = sample.filter((t) => {
      const f = facts.get(t.id)!;
      const clocks = slaFromFacts(t, f.responded, f.changes, now);
      return clocks !== null && slaMatches(clocks, wanted);
    });
    const perPage = Math.min(Math.max(filters.perPage, 1), 100);
    const pageCount = Math.max(Math.ceil(matching.length / perPage), 1);
    const page = Math.min(Math.max(filters.page, 1), pageCount);
    const ids = matching.slice((page - 1) * perPage, page * perPage).map((t) => t.id);
    const rows = ids.length === 0
      ? []
      : await query<TicketListItem>(TICKET_SELECT + ' WHERE t.id IN (' + ids.map(placeholder).join(', ') + ')', ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      items: ids.map((id) => byId.get(id)).filter((r): r is TicketListItem => r !== undefined).map(withReference),
      total: matching.length,
      page,
      perPage,
      pageCount,
      slaCapped: candidates.length > SLA_FILTER_CAP,
    };
  }

  const total = await count('SELECT count(*) AS c FROM tickets t' + whereSql, params);

  const perPage = Math.min(Math.max(filters.perPage, 1), 100);
  const pageCount = Math.max(Math.ceil(total / perPage), 1);
  const page = Math.min(Math.max(filters.page, 1), pageCount);
  const offset = (page - 1) * perPage;

  const rows = await query<TicketListItem>(
    TICKET_SELECT + whereSql + orderBy(filters.sort, filters.dir) + ' LIMIT ? OFFSET ?',
    [...params, perPage, offset],
  );

  return { items: rows.map(withReference), total, page, perPage, pageCount };
}

/** True when the viewer may open this ticket at all. */
export function canViewTicket(viewer: UserRow, ticket: TicketRow): boolean {
  // Whoever raised it on somebody's behalf may follow what they raised.
  return isStaff(viewer.role) || ticket.requester_id === viewer.id || ticket.raised_by === viewer.id;
}

/**
 * Comments for a ticket. Internal notes are filtered out in SQL for
 * requesters, so they cannot leak through a template change.
 */
export function listComments(ticketId: string, viewer: UserRow): Promise<CommentRow[]> {
  const internalClause = isStaff(viewer.role) ? '' : ' AND c.is_internal = 0';
  return query<CommentRow>(
    `SELECT c.*, u.display_name AS author_name, u.role AS author_role
       FROM ticket_comments c
       JOIN users u ON u.id = c.author_id
      WHERE c.ticket_id = ?` +
      internalClause +
      ' ORDER BY c.created_at ASC, c.id ASC',
    [ticketId],
  );
}

export function listEvents(ticketId: string): Promise<EventRow[]> {
  return query<EventRow>(
    `SELECT e.id, e.kind, e.field, e.old_value, e.new_value, e.created_at,
            u.display_name AS actor_name
       FROM ticket_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.ticket_id = ?
      ORDER BY e.created_at ASC, e.id ASC`,
    [ticketId],
  );
}

// --- writes ----------------------------------------------------------------

async function recordEvent(
  client: DbClient,
  input: {
    ticketId: string;
    actorId: string;
    kind: string;
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    at: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO ticket_events
       (id, ticket_id, actor_id, kind, field, old_value, new_value, created_at, automatic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      input.ticketId,
      input.actorId,
      input.kind,
      input.field ?? null,
      input.oldValue ?? null,
      input.newValue ?? null,
      input.at,
      isAutomatic(),
    ],
  );
}

export async function addComment(input: {
  ticketId: string;
  authorId: string;
  body: string;
  isInternal: boolean;
}): Promise<string> {
  const id = await addCommentRow(input);
  await announce({
    kind: 'comment.added',
    ticketId: input.ticketId,
    actorId: input.authorId,
    isInternal: input.isInternal,
  });
  return id;
}

function addCommentRow(input: {
  ticketId: string;
  authorId: string;
  body: string;
  isInternal: boolean;
}): Promise<string> {
  return transaction(async (client) => {
    const id = newId();
    const now = nowIso();
    await client.query(
      `INSERT INTO ticket_comments (id, ticket_id, author_id, body, is_internal, created_at, automatic)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.ticketId, input.authorId, input.body, input.isInternal, now, isAutomatic()],
    );
    await recordEvent(client, {
      ticketId: input.ticketId,
      actorId: input.authorId,
      kind: input.isInternal ? 'internal_note' : 'comment',
      at: now,
    });
    await client.query('UPDATE tickets SET updated_at = ? WHERE id = ?', [now, input.ticketId]);
    return id;
  });
}

export interface TicketUpdate {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  /** null clears the assignee; undefined leaves it unchanged. */
  assigneeId?: string | null;
  /** null clears the technician group; undefined leaves it unchanged. */
  groupId?: string | null;
  /** null clears the catalogue classification. */
  categoryId?: string | null;
}

export interface AppliedChange {
  field: string;
  from: string;
  to: string;
}

/**
 * Applies an agent's changes and records one history event per changed field.
 * Returns the changes that were actually applied, for the audit log.
 *
 * The row is locked for the duration, so two agents saving at once cannot both
 * compute their diff against the same stale state.
 */
export async function updateTicket(
  ticketId: string,
  actorId: string,
  update: TicketUpdate,
): Promise<AppliedChange[]> {
  // The rule, wherever the change comes from - the page, an automation, a
  // reply. The page checks first so the refusal lands beside the form.
  if (update.status) {
    const current = await queryOne<TicketRow>('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    if (current && current.status !== update.status) {
      const blocked = await tasksBlock(current, update.status);
      if (blocked) throw conflict(blocked, 'tasks_open');
    }
  }
  const changes = await updateTicketRow(ticketId, actorId, update);
  // Only a real change is an event: saving the form unchanged is not.
  if (changes.length > 0) await announce({ kind: 'ticket.updated', ticketId, actorId, changes });

  // A task just finished: its parent may now be done too.
  const status = changes.find((c) => c.field === 'status');
  if (status && DONE_STATUSES.includes(status.to as TicketStatus)) {
    const row = await queryOne<{ parent_id: string | null }>('SELECT parent_id FROM tickets WHERE id = ?', [ticketId]);
    if (row?.parent_id) await closeParentIfDone(row.parent_id, actorId);
  }
  return changes;
}

function updateTicketRow(
  ticketId: string,
  actorId: string,
  update: TicketUpdate,
): Promise<AppliedChange[]> {
  return transaction(async (client) => {
    const current = await clientOne<TicketRow>(
      client,
      'SELECT * FROM tickets WHERE id = ?',
      [ticketId],
    );
    if (!current) throw new Error('Ticket not found: ' + ticketId);

    const now = nowIso();
    const changes: AppliedChange[] = [];

    if (update.status && update.status !== current.status) {
      changes.push({ field: 'status', from: current.status, to: update.status });
      // Resolution timestamps are derived here, never taken from the client.
      const resolvedAt =
        update.status === 'resolved' || update.status === 'closed'
          ? (current.resolved_at ?? now)
          : null;
      const closedAt = update.status === 'closed' ? (current.closed_at ?? now) : null;
      await client.query(
        'UPDATE tickets SET status = ?, resolved_at = ?, closed_at = ? WHERE id = ?',
        [update.status, resolvedAt, closedAt, ticketId],
      );
    }

    if (update.priority && update.priority !== current.priority) {
      changes.push({ field: 'priority', from: current.priority, to: update.priority });
      await client.query('UPDATE tickets SET priority = ? WHERE id = ?', [
        update.priority,
        ticketId,
      ]);
    }

    if (update.category && update.category !== current.category) {
      changes.push({ field: 'category', from: current.category, to: update.category });
      await client.query('UPDATE tickets SET category = ? WHERE id = ?', [
        update.category,
        ticketId,
      ]);
    }

    if (update.assigneeId !== undefined && update.assigneeId !== current.assignee_id) {
      changes.push({
        field: 'assignee',
        from: current.assignee_id ?? 'unassigned',
        to: update.assigneeId ?? 'unassigned',
      });
      await client.query('UPDATE tickets SET assignee_id = ? WHERE id = ?', [
        update.assigneeId,
        ticketId,
      ]);
    }

    if (update.groupId !== undefined && update.groupId !== current.group_id) {
      changes.push({
        field: 'group',
        from: current.group_id ?? 'unrouted',
        to: update.groupId ?? 'unrouted',
      });
      await client.query('UPDATE tickets SET group_id = ? WHERE id = ?', [
        update.groupId,
        ticketId,
      ]);
    }

    if (update.categoryId !== undefined && update.categoryId !== current.category_id) {
      changes.push({
        field: 'category',
        from: current.category_id ?? 'unclassified',
        to: update.categoryId ?? 'unclassified',
      });
      await client.query('UPDATE tickets SET category_id = ? WHERE id = ?', [
        update.categoryId,
        ticketId,
      ]);
    }

    for (const change of changes) {
      await recordEvent(client, {
        ticketId,
        actorId,
        kind: 'field_changed',
        field: change.field,
        oldValue: change.from,
        newValue: change.to,
        at: now,
      });
    }

    if (changes.length > 0) {
      await client.query('UPDATE tickets SET updated_at = ? WHERE id = ?', [now, ticketId]);
    }
    return changes;
  });
}

/** Counts for the queue summary strip. */
export async function ticketCounts(viewer: UserRow): Promise<Record<string, number>> {
  if (!isStaff(viewer.role)) {
    const row = await queryOne<{ active: number; total: number }>(
      `SELECT
         (SELECT count(*) FROM tickets WHERE requester_id = ?
           AND status IN ('open', 'in_progress', 'pending')) AS active,
         (SELECT count(*) FROM tickets WHERE requester_id = ?) AS total`,
      [viewer.id, viewer.id],
    );
    return { active: row?.active ?? 0, total: row?.total ?? 0 };
  }

  const row = await queryOne<{
    active: number;
    unassigned: number;
    mine: number;
    total: number;
  }>(
    `SELECT
       (SELECT count(*) FROM tickets
         WHERE status IN ('open', 'in_progress', 'pending')) AS active,
       (SELECT count(*) FROM tickets
         WHERE assignee_id IS NULL AND status IN ('open', 'in_progress', 'pending')) AS unassigned,
       (SELECT count(*) FROM tickets
         WHERE assignee_id = ? AND status IN ('open', 'in_progress', 'pending')) AS mine,
       (SELECT count(*) FROM tickets) AS total`,
    [viewer.id],
  );
  return {
    active: row?.active ?? 0,
    unassigned: row?.unassigned ?? 0,
    mine: row?.mine ?? 0,
    total: row?.total ?? 0,
  };
}

/** Exposed so the profile page can report a user's own activity. */
export async function ticketActivityFor(
  userId: string,
): Promise<{ raised: number; assigned: number; open: number }> {
  const row = await queryOne<{ raised: number; assigned: number; open: number }>(
    `SELECT
       (SELECT count(*) FROM tickets WHERE requester_id = ?) AS raised,
       (SELECT count(*) FROM tickets WHERE assignee_id = ?) AS assigned,
       (SELECT count(*) FROM tickets
         WHERE requester_id = ? AND status IN ('open', 'in_progress', 'pending')) AS open`,
    [userId, userId, userId],
  );
  return row ?? { raised: 0, assigned: 0, open: 0 };
}

/** Used by the deletion path when a ticket is removed with its files. */
export async function touchTicket(ticketId: string): Promise<void> {
  await execute('UPDATE tickets SET updated_at = ? WHERE id = ?', [nowIso(), ticketId]);
}

/**
 * The tasks raised under one ticket.
 *
 * Tasks are excluded from the queue (they would double up alongside their
 * parent), so this is how they are reached.
 */
export async function listTasks(parentId: string): Promise<TicketListItem[]> {
  const rows = await query<TicketListItem>(
    TICKET_SELECT + ' WHERE t.parent_id = ? ORDER BY t.seq',
    [parentId],
  );
  return rows.map(withReference);
}

/** How many tasks under this ticket are still open, for the summary line. */
export async function openTaskCount(parentId: string): Promise<number> {
  return count(
    `SELECT count(*) AS c FROM tickets
      WHERE parent_id = ? AND status IN ('open', 'in_progress', 'pending')`,
    [parentId],
  );
}
