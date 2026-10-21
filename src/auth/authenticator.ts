import crypto from 'node:crypto';
import { execute, queryOne } from '../db/index.js';
import { nowIso } from '../lib/util.js';
import { open, seal, type SealedValue } from '../lib/secret-box.js';
import { audit } from '../lib/audit.js';

/**
 * A code from an authenticator app, after the password (asked for 21 Oct
 * 2026: "the same MFA as on the portal"). The same as the customer portal's
 * src/mfa.ts, so one app on one phone serves both.
 *
 * - **Password accounts only.** An account that signs in through an identity
 *   provider has that provider's own second step, and one that signs in with
 *   an emailed code already has a second step.
 * - **Optional**, set up by the person on their profile page.
 * - RFC 6238: HMAC-SHA1, 30-second steps, six digits - what Microsoft
 *   Authenticator, Google Authenticator and 1Password all read.
 * - **The secret is sealed** (secret-box, from SESSION_SECRET), and **a code
 *   works once**: the last step used is kept, and one not newer is refused.
 * - **Ten recovery codes**, shown once, stored as hashes, each usable once.
 * - An administrator can remove it for somebody who lost their phone and
 *   their codes (Settings - Users, the person's page).
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret, base32, as an authenticator app takes it. */
export const newSecret = (): string => base32(crypto.randomBytes(20));

/** The code for one 30-second step. */
export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}

export const currentStep = (now = Date.now()): number => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * The step a typed code belongs to - this one, or one either side for a
 * phone whose clock is a little off - or null. Only steps after `lastUsed`
 * count, so a code already used is refused.
 */
export function matchStep(secret: string, typed: string, lastUsed: number, now = Date.now()): number | null {
  const code = typed.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const at = currentStep(now);
  for (const step of [at - 1, at, at + 1]) {
    if (step <= lastUsed) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** The address an authenticator app reads from the QR code. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=' + DIGITS + '&period=' + STEP_SECONDS;
}

/** Ten codes like 7KQ4M-T2XWP: the letters and digits nobody misreads. */
export function newRecoveryCodes(): string[] {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 10 }, () => {
    const s = Array.from(crypto.randomBytes(10), (x) => chars[x % chars.length]).join('');
    return s.slice(0, 5) + '-' + s.slice(5);
  });
}

/** How a recovery code is stored and compared: its hash, whatever its case and dash. */
export const hashRecovery = (code: string): string =>
  crypto.createHash('sha256').update('helpdesk-recovery:' + code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).digest('hex');

// --- stored ----------------------------------------------------------------------

interface Row {
  user_id: string;
  secret: string;
  last_step: number;
  recovery: string;
}

export async function hasAuthenticator(userId: string): Promise<boolean> {
  return !!(await queryOne<{ user_id: string }>('SELECT user_id FROM user_authenticators WHERE user_id = ?', [userId]));
}

/** Turns it on with a secret the person has just proved they hold; returns the recovery codes, shown once. */
export async function enableAuthenticator(userId: string, secret: string, actor: { id: string; email: string }): Promise<string[]> {
  const codes = newRecoveryCodes();
  await execute('DELETE FROM user_authenticators WHERE user_id = ?', [userId]);
  await execute(
    'INSERT INTO user_authenticators (user_id, secret, last_step, recovery, enabled_at) VALUES (?, ?, ?, ?, ?)',
    [userId, JSON.stringify(seal(secret)), currentStep(), JSON.stringify(codes.map(hashRecovery)), nowIso()],
  );
  audit({ action: 'auth.authenticator.enabled', actorId: actor.id, actorEmail: actor.email, targetType: 'user', targetId: userId });
  return codes;
}

export async function removeAuthenticator(userId: string, actor: { id: string; email: string }, byAdmin = false): Promise<void> {
  await execute('DELETE FROM user_authenticators WHERE user_id = ?', [userId]);
  audit({
    action: byAdmin ? 'auth.authenticator.reset' : 'auth.authenticator.disabled',
    actorId: actor.id,
    actorEmail: actor.email,
    targetType: 'user',
    targetId: userId,
  });
}

/**
 * Whether what was typed is this person's code now, or one of their unused
 * recovery codes - and if so it is used up. A code from the app is tried
 * first; a recovery code has letters in it, which six digits never do.
 */
export async function useAuthenticatorCode(userId: string, typed: string): Promise<'code' | 'recovery' | null> {
  const row = await queryOne<Row>('SELECT * FROM user_authenticators WHERE user_id = ?', [userId]);
  if (!row) return null;
  let secret: string;
  try {
    secret = open(JSON.parse(row.secret) as SealedValue);
  } catch {
    return null;
  }
  const step = matchStep(secret, typed, Number(row.last_step));
  if (step !== null) {
    // Only moves forward, and only the sign-in whose write moved it wins:
    // reading the step back let two racing with one code both through.
    const moved = await execute('UPDATE user_authenticators SET last_step = ? WHERE user_id = ? AND last_step < ?', [step, userId, step]);
    return moved === 1 ? 'code' : null;
  }
  if (!/[A-Za-z]/.test(typed)) return null;
  const hashes = JSON.parse(row.recovery) as string[];
  const hash = hashRecovery(typed);
  if (!hashes.includes(hash)) return null;
  // Used up only if the list is still the one read; a sign-in that lost the race is refused.
  const used = await execute('UPDATE user_authenticators SET recovery = ? WHERE user_id = ? AND recovery = ?', [
    JSON.stringify(hashes.filter((h) => h !== hash)),
    userId,
    row.recovery,
  ]);
  return used === 1 ? 'recovery' : null;
}

/** How many recovery codes somebody has left, for their profile page. */
export async function recoveryLeft(userId: string): Promise<number> {
  const row = await queryOne<{ recovery: string }>('SELECT recovery FROM user_authenticators WHERE user_id = ?', [userId]);
  return row ? (JSON.parse(row.recovery) as string[]).length : 0;
}
