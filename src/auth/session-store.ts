import { Store, type SessionData } from 'express-session';
import { execute, query, queryOne, sqlJsonText, sqlNow } from '../db/index.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'session-store' });

/**
 * Server-side session store on the application database.
 *
 * Sessions live in PostgreSQL, never in the cookie, so the cookie carries only
 * a signed opaque id. That keeps session contents out of reach of the browser,
 * lets us revoke a session server-side on logout or lockout, and means every
 * application instance sees the same sessions - which is what allows more than
 * one container to serve the same users.
 *
 * express-session's store interface is callback-based, which suits an async
 * driver directly.
 */
export class PostgresSessionStore extends Store {
  private expiryOf(session: SessionData): Date {
    const maxAge = session.cookie?.maxAge;
    if (typeof maxAge === 'number' && Number.isFinite(maxAge)) {
      return new Date(Date.now() + maxAge);
    }
    const expires = session.cookie?.expires;
    if (expires) return new Date(expires);
    return new Date(Date.now() + 3_600_000);
  }

  override get(
    sid: string,
    callback: (err?: unknown, session?: SessionData | null) => void,
  ): void {
    queryOne<{ data: SessionData }>(
      'SELECT data FROM sessions WHERE sid = ? AND expires_at > ' + sqlNow,
      [sid],
    )
      .then((row) => {
        if (!row) {
          callback(null, null);
          return;
        }
        callback(null, row.data);
      })
      .catch((err) => {
        // A corrupt or unreadable row must not lock the user out: drop it and
        // let them start a new session.
        log.warn({ err }, 'discarding unreadable session');
        execute('DELETE FROM sessions WHERE sid = ?', [sid])
          .catch(() => undefined)
          .finally(() => callback(null, null));
      });
  }

  override set(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    execute(
      `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
      [sid, JSON.stringify(session), this.expiryOf(session)],
    )
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  override touch(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
    execute('UPDATE sessions SET expires_at = ? WHERE sid = ?', [this.expiryOf(session), sid])
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  override destroy(sid: string, callback?: (err?: unknown) => void): void {
    execute('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  /**
   * Revokes every session belonging to a user, e.g. when disabling them.
   *
   * Uses the expression index on `data ->> 'userId'`, so this stays cheap as
   * the table grows.
   */
  async destroyForUser(userId: string): Promise<number> {
    try {
      return await execute('DELETE FROM sessions WHERE ' + sqlJsonText('data', 'userId') + ' = ?', [userId]);
    } catch (err) {
      log.error({ err }, 'failed to revoke user sessions');
      return 0;
    }
  }

  /**
   * Every session of this user but the one making the request.
   *
   * Changing your own password should end the sessions you did not change
   * it from - a laptop left signed in, or whoever knew the old password -
   * and must not end the one you are using, which would read as the change
   * having failed.
   */
  async destroyOthersForUser(userId: string, keepSid: string): Promise<number> {
    try {
      return await execute(
        'DELETE FROM sessions WHERE ' + sqlJsonText('data', 'userId') + ' = ? AND sid <> ?',
        [userId, keepSid],
      );
    } catch (err) {
      log.error({ err }, 'failed to revoke the user other sessions');
      return 0;
    }
  }
}

export const sessionStore = new PostgresSessionStore();

/** Exposed for the readiness probe: a session write is the real dependency. */
export async function sessionStoreReachable(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM sessions LIMIT 1');
    return true;
  } catch {
    return false;
  }
}
