import crypto from 'node:crypto';
import signature from 'cookie-signature';
import { config } from '../../src/config.js';
import { sessionStore } from '../../src/auth/session-store.js';
import { upsertUserFromDirectory, setUserRole, type UserRow } from '../../src/services/users.js';
import type { Role } from '../../src/config.js';

/**
 * Test-only sign-in.
 *
 * The application deliberately ships no way to obtain a session without real
 * credentials - there is no development login mode - so tests mint a session
 * the same way express-session does: a row in the session store plus a cookie
 * signed with the configured key. This keeps the bypass entirely inside the
 * test suite rather than in the product.
 */

const TEST_CSRF_TOKEN = 'test-csrf-token-0000000000000000000000';

export interface TestSession {
  user: UserRow;
  /** Value for the Cookie request header. */
  cookie: string;
  /** The CSRF token to submit with state-changing requests. */
  csrfToken: string;
}

function signSessionCookie(sid: string): string {
  const key = config.session.keys[0];
  if (!key) throw new Error('no session key configured');
  const signed = 's:' + signature.sign(sid, key);
  return config.session.name + '=' + encodeURIComponent(signed);
}

/** Creates (or reuses) a local account and returns a signed-in session for it. */
export async function signInAs(email: string, role: Role): Promise<TestSession> {
  const { user } = await upsertUserFromDirectory({
    issuer: 'https://login.microsoftonline.com/test-tenant/v2.0',
    externalId: 'oid-' + email,
    email,
    upn: email,
    displayName: email,
    role,
    source: 'jit',
    markLogin: true,
  });
  // Locked, so nothing in the mapping logic can change it mid-test.
  setUserRole(user.id, role, true);
  return sessionFor(user);
}

/** A signed-in session for an account that already exists - the break-glass one, say. */
export async function sessionFor(user: UserRow): Promise<TestSession> {
  const sid = crypto.randomBytes(24).toString('hex');
  await new Promise<void>((resolve, reject) => {
    sessionStore.set(
      sid,
      {
        cookie: {
          originalMaxAge: config.session.idleTimeoutMs,
          maxAge: config.session.idleTimeoutMs,
          httpOnly: true,
          path: '/',
          secure: config.session.secureCookies,
          sameSite: 'lax',
        },
        userId: user.id,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        csrfToken: TEST_CSRF_TOKEN,
      } as never,
      (err) => (err ? reject(err) : resolve()),
    );
  });

  return { user, cookie: signSessionCookie(sid), csrfToken: TEST_CSRF_TOKEN };
}
