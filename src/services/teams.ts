import { execute, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { nowIso } from '../lib/util.js';
import { findUserByEmail, findUserById, isStaff, type UserRow } from './users.js';

/**
 * A person's manager, and the team it makes (asked for 21 Oct 2026).
 *
 * `users.manager_id` (migration 66) is set by an administrator under
 * Settings - Users, or by SCIM from the enterprise extension's `manager`.
 * A team is the people who share a manager, with the manager: so a manager
 * and their reports, and colleagues under the same manager.
 *
 * It decides one thing: **who a requester may raise a ticket on behalf of**.
 * Service desk staff may raise one for anybody, as they always could - a
 * technician taking a call is the usual reason the field exists.
 */

/** Whether `viewer` may raise a ticket for `person`. */
export function mayRaiseFor(viewer: UserRow, person: UserRow): boolean {
  if (isStaff(viewer.role) || viewer.id === person.id) return true;
  const mine = viewer.manager_id ?? null;
  const theirs = person.manager_id ?? null;
  return (
    (mine !== null && mine === theirs) || // the same manager
    theirs === viewer.id || // my report
    mine === person.id // my manager
  );
}

/** The manager's address for a form, or ''. */
export async function managerEmailOf(user: Pick<UserRow, 'manager_id'>): Promise<string> {
  if (!user.manager_id) return '';
  return (await findUserById(user.manager_id))?.email ?? '';
}

/**
 * Sets somebody's manager by id ('' or null clears it). Refuses themselves and
 * a loop (somebody who reports to them, at any depth): a team must have a top.
 */
export async function setManager(userId: string, managerId: string | null, actorId: string | null): Promise<void> {
  const target = managerId || null;
  if (target === userId) throw badRequest('Somebody cannot be their own manager.', 'manager_self');
  if (target) {
    // Walk up from the new manager; reaching this person would make a loop.
    let at: string | null = target;
    for (let i = 0; at && i < 50; i++) {
      if (at === userId) throw badRequest('That person reports to them, so they cannot be their manager.', 'manager_loop');
      at = (await queryOne<{ manager_id: string | null }>('SELECT manager_id FROM users WHERE id = ?', [at]))?.manager_id ?? null;
    }
  }
  const before = (await queryOne<{ manager_id: string | null }>('SELECT manager_id FROM users WHERE id = ?', [userId]))?.manager_id ?? null;
  if (before === target) return;
  await execute('UPDATE users SET manager_id = ?, updated_at = ? WHERE id = ?', [target, nowIso(), userId]);
  audit({ action: 'user.manager_changed', actorId, targetType: 'user', targetId: userId, detail: { from: before, to: target } });
}

/** Sets somebody's manager from an address typed on their page. */
export async function setManagerByEmail(userId: string, email: string, actorId: string | null): Promise<void> {
  const typed = email.trim();
  if (!typed) return setManager(userId, null, actorId);
  const manager = await findUserByEmail(typed);
  if (!manager || manager.status !== 'active') throw badRequest('There is no active account with that address.', 'manager_unknown');
  await setManager(userId, manager.id, actorId);
}
