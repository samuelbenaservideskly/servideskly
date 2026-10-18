/**
 * The one-time link that creates a hosted helpdesk's first administrator.
 *
 * The customer portal makes it when the person who ordered the helpdesk
 * presses "Set up your administrator account": their email address and an
 * expiry, signed with a key derived from this helpdesk's SESSION_SECRET.
 * Only two things can read that secret - this helpdesk and the portal's
 * provisioner, both from Key Vault - so a valid link can only have come from
 * the portal, for the person signed in there. The link is never shown,
 * stored or mailed: the portal sends the browser straight here.
 *
 *   token = base64url(JSON {e: email, x: expiry ms, n: nonce}) "." base64url(HMAC)
 *   key   = HMAC-SHA256(SESSION_SECRET, "helpdesk-admin-setup-v1")
 *
 * It works once: setting up records the seed marker `admin_setup`, after
 * which every link is refused.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export interface SetupClaims {
  email: string;
  expires: number;
}

function key(): Buffer {
  return createHmac('sha256', config.session.keys[0]!).update('helpdesk-admin-setup-v1').digest();
}

/** For tests (and documentation of the format the portal produces). */
export function signSetupToken(email: string, expires: number, nonce = 'n'): string {
  const body = Buffer.from(JSON.stringify({ e: email, x: expires, n: nonce })).toString('base64url');
  return body + '.' + createHmac('sha256', key()).update(body).digest('base64url');
}

/** The claims of a valid, unexpired token; undefined for anything else. */
export function verifySetupToken(token: unknown): SetupClaims | undefined {
  if (typeof token !== 'string' || token.length > 2000) return undefined;
  const [body, mac] = token.split('.');
  if (!body || !mac) return undefined;
  const expected = Buffer.from(createHmac('sha256', key()).update(body).digest('base64url'));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as { e?: unknown; x?: unknown };
    if (typeof claims.e !== 'string' || typeof claims.x !== 'number') return undefined;
    if (claims.x < Date.now()) return undefined;
    return { email: claims.e.trim().toLowerCase(), expires: claims.x };
  } catch {
    return undefined;
  }
}
