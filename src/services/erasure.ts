import { execute, query, queryOne, transaction } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import { findUserByEmail, type UserRow } from './users.js';

/**
 * Removing somebody and keeping their tickets: the right to erasure.
 *
 * Deleting an account outright is refused when it has tickets - they
 * reference their requester with ON DELETE RESTRICT, and a service desk
 * cannot lose the history of work it did. So the ordinary Remove disables
 * such an account instead, which keeps the person's name and address in the
 * database, and that is exactly what somebody who has left and asked to be
 * forgotten does not want.
 *
 * This is the other answer, asked for 15 Oct 2026: the tickets stay, the
 * person goes. Every row that pointed at them points at **one hidden
 * placeholder account** instead, and the account itself is deleted.
 *
 * Four things worth knowing:
 *
 * 1. **One placeholder for everybody.** Not one per erased person - that
 *    would be a pseudonym, which still distinguishes one ex-colleague from
 *    another and can be linked back by anybody who knows who worked here.
 * 2. **It carries nothing.** No email anybody can write to, no role beyond
 *    `user`, disabled, in no group - the same shape as the hidden account
 *    mail from a stranger is filed against.
 * 3. **What is repointed, and why.** The three columns that would otherwise
 *    refuse the delete (requester, comment author, who uploaded a file) and
 *    the three that would quietly become empty (assignee, who raised it on
 *    their behalf, who an event was by). Nulling those last three would say
 *    the ticket was unassigned, or raised by nobody, which is not what
 *    happened.
 * 4. **The audit entry names no name.** It records that an account with that
 *    id was erased and how many tickets moved. Writing the name into the
 *    audit trail would undo the erasure in the one table nobody ever deletes
 *    from.
 *
 * What this does **not** reach: words people typed. A comment saying "ring
 * Jan on 555 1234" still says it. There is no way to find that mechanically,
 * and a service desk that silently rewrote its own history would be worse
 * than one that says so plainly - which the dialog does.
 */

const ANONYMOUS_EMAIL = 'anonymous@localhost.invalid';

/** The placeholder every erased person's work is filed against. */
export async function anonymousUserId(): Promise<string> {
  const existing = await findUserByEmail(ANONYMOUS_EMAIL);
  if (existing) return existing.id;

  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO users
       (id, issuer, external_id, email, upn, display_name, role, role_locked, status,
        source, directory_present, created_at, updated_at)
     VALUES (?, 'urn:helpdesk:anonymous', NULL, ?, NULL, 'Anonymous', 'user', 1,
             'disabled', 'manual', 0, ?, ?)`,
    [id, ANONYMOUS_EMAIL, now, now],
  );
  return id;
}

/** Whether this row is the placeholder, which must never be erased or edited. */
export function isAnonymousAccount(user: Pick<UserRow, 'email'>): boolean {
  return user.email === ANONYMOUS_EMAIL;
}

export interface ErasureResult {
  /** Tickets whose requester is now the placeholder. */
  tickets: number;
  comments: number;
}

/**
 * Deletes the account and files everything it left behind under the
 * placeholder. The caller has already decided this person may be erased.
 */
export async function eraseUser(user: UserRow, actorId: string | null): Promise<ErasureResult> {
  if (user.role_locked && user.role === 'admin') {
    throw conflict('The break-glass account cannot be removed.');
  }
  if (isAnonymousAccount(user)) {
    throw conflict('That is the placeholder erased accounts are filed under.');
  }

  const anonymous = await anonymousUserId();
  if (anonymous === user.id) throw conflict('That is the placeholder erased accounts are filed under.');

  const counted = await transaction(async () => {
    const tickets = Number(
      (await queryOne<{ n: number }>('SELECT count(*) AS n FROM tickets WHERE requester_id = ?', [user.id]))?.n ?? 0,
    );
    const comments = Number(
      (await queryOne<{ n: number }>('SELECT count(*) AS n FROM ticket_comments WHERE author_id = ?', [user.id]))?.n ?? 0,
    );

    // The three that would refuse the delete...
    await execute('UPDATE tickets SET requester_id = ? WHERE requester_id = ?', [anonymous, user.id]);
    await execute('UPDATE ticket_comments SET author_id = ? WHERE author_id = ?', [anonymous, user.id]);
    await execute('UPDATE ticket_attachments SET uploaded_by = ? WHERE uploaded_by = ?', [anonymous, user.id]);
    // ...and the three that would otherwise go quietly empty.
    await execute('UPDATE tickets SET assignee_id = ? WHERE assignee_id = ?', [anonymous, user.id]);
    await execute('UPDATE tickets SET raised_by = ? WHERE raised_by = ?', [anonymous, user.id]);
    await execute('UPDATE ticket_events SET actor_id = ? WHERE actor_id = ?', [anonymous, user.id]);

    // The audit trail keeps what was done; who did it is the person being
    // erased, so the row keeps the action and loses the name.
    await execute("UPDATE audit_log SET actor_id = NULL, actor_email = '' WHERE actor_id = ?", [user.id]);

    // Everything else - memberships, pins, dashboards, sign-in codes,
    // availability - is ON DELETE CASCADE and goes with the row.
    await execute('DELETE FROM users WHERE id = ?', [user.id]);
    return { tickets, comments };
  });

  audit({
    action: 'user.erased',
    actorId,
    actorEmail: '',
    targetType: 'user',
    targetId: user.id,
    // No name, no address: see above.
    detail: { tickets: counted.tickets, comments: counted.comments },
  });

  return counted;
}

/** How much of this person's work the placeholder would take on. */
export async function erasureFootprint(userId: string): Promise<{ tickets: number; comments: number }> {
  const rows = await query<{ tickets: number; comments: number }>(
    `SELECT
       (SELECT count(*) FROM tickets WHERE requester_id = ? OR assignee_id = ? OR raised_by = ?) AS tickets,
       (SELECT count(*) FROM ticket_comments WHERE author_id = ?) AS comments`,
    [userId, userId, userId, userId],
  );
  return { tickets: Number(rows[0]?.tickets ?? 0), comments: Number(rows[0]?.comments ?? 0) };
}
