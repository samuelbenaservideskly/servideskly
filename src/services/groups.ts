import { execute, query, queryOne, transaction } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import { isStaff, type UserRow } from './users.js';

/**
 * Technician groups.
 *
 * A team a ticket can be routed to - desktop support, networks, and so on -
 * so the queue can be filtered by who is meant to pick something up rather
 * than only by who already has.
 *
 * Membership grants nothing. Being in a group does not let anyone see or do
 * more than their role already allows; it only answers "whose queue is this".
 * That is why only agents and administrators can be members: a plain user has
 * no queue to put anything in.
 */

export interface GroupRow {
  id: string;
  name: string;
  description: string;
  is_active: boolean;
  /** Who answers for the group. Shown, never a permission. */
  manager_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupWithCount extends GroupRow {
  member_count: number;
  /** Every manager's name, by name; empty with none. */
  manager_names: string[];
  open_count: number;
}

/**
 * Alphabetical, always.
 *
 * Groups used to carry a sort_order, which meant every group needed a number
 * chosen for it before it could be created - a decision with no right answer
 * for a list that is read by name. The column still exists (migrations are
 * forward-only) and is written with its default; nothing reads it.
 */
const ORDER = ' ORDER BY lower(name)';

/** Every group, with the numbers the administration page shows. */
/** Name or description containing the words, for the list's search. */
function groupSearch(q: string | undefined): { where: string; params: unknown[] } {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return { where: '', params: [] };
  return {
    where: ' WHERE ' + words.map(() => "(lower(g.name) LIKE ? ESCAPE '\\' OR lower(g.description) LIKE ? ESCAPE '\\')").join(' AND '),
    params: words.flatMap((w) => {
      const like = '%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      return [like, like];
    }),
  };
}

/** One page of the list, searched in SQL - a list of thousands is never read whole. */
export async function searchGroups(q: string, page: number, perPage: number): Promise<{ rows: GroupWithCount[]; total: number }> {
  const { where, params } = groupSearch(q);
  const total = (await queryOne<{ n: number }>('SELECT count(*) AS n FROM technician_groups g' + where, params))?.n ?? 0;
  const rows = await query<GroupWithCount>(
    `SELECT g.*,
            (SELECT count(*) FROM technician_group_members m WHERE m.group_id = g.id) AS member_count,
            (SELECT count(*) FROM tickets t
              WHERE t.group_id = g.id
                AND t.status IN ('open', 'in_progress', 'pending')) AS open_count
       FROM technician_groups g` + where + ORDER + ' LIMIT ? OFFSET ?',
    [...params, perPage, (page - 1) * perPage],
  );
  return { rows: await withManagerNames(rows), total: Number(total) };
}

export async function listGroups(): Promise<GroupWithCount[]> {
  return withManagerNames(await query<GroupWithCount>(
    `SELECT g.*,
            (SELECT count(*) FROM technician_group_members m WHERE m.group_id = g.id)
              AS member_count,
            (SELECT count(*) FROM tickets t
              WHERE t.group_id = g.id
                AND t.status IN ('open', 'in_progress', 'pending')) AS open_count
       FROM technician_groups g` + ORDER,
  ));
}

/** Groups a ticket can be routed to. */
export function listActiveGroups(): Promise<GroupRow[]> {
  return query<GroupRow>('SELECT * FROM technician_groups WHERE is_active = 1' + ORDER);
}

export function findGroup(id: string): Promise<GroupRow | undefined> {
  return queryOne<GroupRow>('SELECT * FROM technician_groups WHERE id = ?', [id]);
}

export interface GroupInput {
  name: string;
  description: string;
  isActive: boolean;
}

async function assertNameFree(name: string, exceptId: string | null): Promise<void> {
  const clash = await queryOne<{ id: string }>(
    'SELECT id FROM technician_groups WHERE lower(name) = lower(?)',
    [name],
  );
  if (clash && clash.id !== exceptId) {
    throw conflict('A group with that name already exists.', 'group_name_taken');
  }
}

export async function createGroup(input: GroupInput, actorId: string | null): Promise<GroupRow> {
  await assertNameFree(input.name, null);

  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO technician_groups
       (id, name, description, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.description, input.isActive ? 1 : 0, now, now],
  );

  audit({
    action: 'group.created',
    actorId,
    targetType: 'group',
    targetId: id,
    detail: { name: input.name },
  });

  const created = await findGroup(id);
  if (!created) throw new Error('group vanished immediately after insert: ' + id);
  return created;
}

/** A group's managers, by name. */
export function groupManagers(groupId: string): Promise<{ id: string; display_name: string; email: string; status: string }[]> {
  return query(
    `SELECT u.id, u.display_name, u.email, u.status FROM technician_group_managers gm
       JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY lower(u.display_name)`,
    [groupId],
  );
}

/** Adds manager_names to listed groups: one query for the page, not one per group. */
async function withManagerNames<T extends { id: string }>(rows: T[]): Promise<(T & { manager_names: string[] })[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const found = await query<{ group_id: string; name: string }>(
    `SELECT gm.group_id, u.display_name AS name FROM technician_group_managers gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id IN (${ids.map(() => '?').join(', ')}) ORDER BY lower(u.display_name)`,
    ids,
  );
  return rows.map((r) => ({ ...r, manager_names: found.filter((m) => m.group_id === r.id).map((m) => m.name) }));
}

/**
 * Sets a group's managers - as many as it needs (asked for 15 Oct 2026).
 * Each an active agent or administrator: somebody who works a queue can
 * answer for one. They need not be members - a team lead often is not.
 * Managing grants Reports and the Manager dashboard for the group, the SLA
 * alert and the deletion email; nothing else.
 */
export async function setGroupManagers(groupId: string, managerIds: readonly string[], actorId: string | null): Promise<void> {
  const group = await findGroup(groupId);
  if (!group) throw notFound('That group no longer exists.');
  const wanted = [...new Set(managerIds.filter(Boolean))];
  for (const id of wanted) {
    const manager = await queryOne<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = ?', [id]);
    if (!manager || manager.status !== 'active' || !['agent', 'admin'].includes(manager.role)) {
      throw conflict('Every manager must be an active agent or administrator.', 'bad_manager');
    }
  }
  const before = (await groupManagers(groupId)).map((m) => m.id);
  if (before.length === wanted.length && before.every((id) => wanted.includes(id))) return;
  await transaction(async (client) => {
    await client.query('DELETE FROM technician_group_managers WHERE group_id = ?', [groupId]);
    for (const id of wanted) {
      await client.query('INSERT INTO technician_group_managers (group_id, user_id, added_at) VALUES (?, ?, ?)', [groupId, id, nowIso()]);
    }
    // The old single column keeps the first, so nothing reading it breaks.
    await client.query('UPDATE technician_groups SET manager_id = ?, updated_at = ? WHERE id = ?', [wanted[0] ?? null, nowIso(), groupId]);
  });
  audit({ action: 'group.managers.changed', actorId, targetType: 'group', targetId: groupId, detail: { from: before, to: wanted } });
}

/** One manager, or none - kept for callers from before groups had several. */
export function setGroupManager(groupId: string, managerId: string | null, actorId: string | null): Promise<void> {
  return setGroupManagers(groupId, managerId ? [managerId] : [], actorId);
}

export async function updateGroup(
  id: string,
  input: GroupInput,
  actorId: string | null,
): Promise<GroupRow> {
  const existing = await findGroup(id);
  if (!existing) throw notFound('That group no longer exists.');
  await assertNameFree(input.name, id);

  await execute(
    `UPDATE technician_groups SET
        name = ?, description = ?, is_active = ?, updated_at = ?
      WHERE id = ?`,
    [input.name, input.description, input.isActive ? 1 : 0, nowIso(), id],
  );

  audit({
    action: 'group.updated',
    actorId,
    targetType: 'group',
    targetId: id,
    detail: { name: input.name, active: input.isActive },
  });

  const updated = await findGroup(id);
  if (!updated) throw new Error('group disappeared during update: ' + id);
  return updated;
}

/**
 * Removes a group.
 *
 * Tickets keep no trace: the schema clears their `group_id`, so they fall back
 * to the unrouted queue rather than pointing at something that is gone.
 */
export async function deleteGroup(id: string, actorId: string | null): Promise<void> {
  const existing = await findGroup(id);
  if (!existing) return;
  await execute('DELETE FROM technician_groups WHERE id = ?', [id]);
  audit({
    action: 'group.deleted',
    actorId,
    targetType: 'group',
    targetId: id,
    detail: { name: existing.name },
  });
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface GroupMember {
  id: string;
  display_name: string;
  email: string;
  role: UserRow['role'];
  status: UserRow['status'];
  department: string | null;
  /** 'manual' (hand-picked) or 'rule' (technician-rules.ts). */
  member_source: 'manual' | 'rule';
}

export function listMembers(groupId: string): Promise<GroupMember[]> {
  return query<GroupMember>(
    `SELECT u.id, u.display_name, u.email, u.role, u.status, u.department, m.source AS member_source
       FROM technician_group_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ?
      ORDER BY lower(u.display_name)`,
    [groupId],
  );
}

/** The groups one person belongs to. */
export function groupsForUser(userId: string): Promise<GroupRow[]> {
  return query<GroupRow>(
    `SELECT g.*
       FROM technician_group_members m
       JOIN technician_groups g ON g.id = m.group_id
      WHERE m.user_id = ?` + ' ORDER BY lower(g.name)',
    [userId],
  );
}

/** Just the ids, for the queue filter. */
export async function groupIdsForUser(userId: string): Promise<string[]> {
  const rows = await query<{ group_id: string }>(
    'SELECT group_id FROM technician_group_members WHERE user_id = ?',
    [userId],
  );
  return rows.map((row) => row.group_id);
}

/**
 * Replaces one person's group membership.
 *
 * Refuses for anyone who is not staff: a plain user has no queue, so putting
 * them in a team would be a promise the application does not keep.
 */
export async function setGroupsForUser(
  user: UserRow,
  groupIds: readonly string[],
  actorId: string | null,
): Promise<void> {
  if (groupIds.length > 0 && !isStaff(user.role)) {
    throw conflict(
      'Only agents and administrators can belong to a technician group. Change the role first.',
      'not_staff',
    );
  }

  const wanted = Array.from(new Set(groupIds)).slice(0, 50);
  await transaction(async (client) => {
    // Rule rows are the rules' business; only hand-picked ones are replaced.
    await client.query("DELETE FROM technician_group_members WHERE user_id = ? AND source = 'manual'", [user.id]);
    for (const groupId of wanted) {
      await client.query(
        `INSERT INTO technician_group_members (group_id, user_id, source, added_at)
         VALUES (?, ?, 'manual', ?)
         ON CONFLICT (group_id, user_id) DO UPDATE SET source = 'manual'`,
        [groupId, user.id, nowIso()],
      );
    }
  });

  audit({
    action: 'group.membership.changed',
    actorId,
    targetType: 'user',
    targetId: user.id,
    detail: { groups: wanted.length },
  });
}

/**
 * Replaces a group's membership wholesale.
 *
 * Set-based rather than add/remove per person, so the form is one submit and
 * the result is exactly what the page showed - no drift if two administrators
 * have the page open.
 */
/**
 * Applies a page of the member picker.
 *
 * `shown` is every candidate that was on screen; `ticked` is the subset the
 * form came back with. Membership changes **only** for people in `shown`.
 *
 * This is what makes paging the picker safe. `setMembers` replaces the whole
 * list, which was right while the form always carried everybody - and would
 * silently empty a group the moment the form carried one page of it.
 */
export async function setMembersWithin(
  groupId: string,
  shown: readonly string[],
  ticked: readonly string[],
  actorId: string | null,
): Promise<void> {
  const onScreen = Array.from(new Set(shown)).slice(0, 1000);
  if (onScreen.length === 0) return;

  const wanted = new Set(ticked);
  const added: string[] = [];
  const removed: string[] = [];

  await transaction(async (client) => {
    for (const userId of onScreen) {
      if (wanted.has(userId)) {
        await client.query(
          `INSERT INTO technician_group_members (group_id, user_id, source, added_at)
           VALUES (?, ?, 'manual', ?)
           ON CONFLICT (group_id, user_id) DO UPDATE SET source = 'manual'`,
          [groupId, userId, nowIso()],
        );
        added.push(userId);
      } else {
        // A rule member cannot be unticked: change the rule instead.
        await client.query(
          "DELETE FROM technician_group_members WHERE group_id = ? AND user_id = ? AND source = 'manual'",
          [groupId, userId],
        );
        removed.push(userId);
      }
    }
  });

  audit({
    action: 'group.membership.changed',
    actorId,
    targetType: 'group',
    targetId: groupId,
    detail: { shown: onScreen.length, ticked: added.length, untickedOnPage: removed.length },
  });
}

export async function setMembers(
  groupId: string,
  userIds: readonly string[],
  actorId: string | null,
): Promise<void> {
  const wanted = Array.from(new Set(userIds)).slice(0, 500);
  await transaction(async (client) => {
    await client.query("DELETE FROM technician_group_members WHERE group_id = ? AND source = 'manual'", [groupId]);
    for (const userId of wanted) {
      await client.query(
        `INSERT INTO technician_group_members (group_id, user_id, source, added_at)
         VALUES (?, ?, 'manual', ?)
         ON CONFLICT (group_id, user_id) DO UPDATE SET source = 'manual'`,
        [groupId, userId, nowIso()],
      );
    }
  });

  audit({
    action: 'group.membership.changed',
    actorId,
    targetType: 'group',
    targetId: groupId,
    detail: { members: wanted.length },
  });
}

/**
 * Drops someone out of every group.
 *
 * Called when a role falls below agent, so the membership rule above cannot be
 * sidestepped by promoting, joining, then demoting.
 */
export async function clearGroupsForUser(userId: string): Promise<number> {
  return execute('DELETE FROM technician_group_members WHERE user_id = ?', [userId]);
}
