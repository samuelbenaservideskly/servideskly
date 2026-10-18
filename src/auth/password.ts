import crypto from 'node:crypto';
import { config } from '../config.js';
import { settings } from '../settings/index.js';

/**
 * Password hashing for the local administrator account.
 *
 * scrypt from Node's own crypto is used deliberately: it is memory-hard, it is
 * in the standard library (no native build step, nothing extra to keep
 * patched), and the cost parameters are stored alongside each hash so they can
 * be raised later without invalidating existing passwords.
 *
 * Encoding: scrypt$N$r$p$keylen$salt-b64$hash-b64
 */

const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

/** ~16 MB and roughly 100 ms per hash on ordinary server hardware. */
const COST = { N: 16_384, r: 8, p: 1 } as const;
/** scrypt needs 128 * N * r bytes; give it headroom or Node refuses. */
const MAX_MEM = 128 * COST.N * COST.r * 4;

/**
 * Length is the property that actually matters, so it is the one rule that
 * is enforced strictly. Configurable because a local proof of concept wants
 * to sign in as "user" with something short; production floors it at 12
 * whatever the environment says (see config.ts).
 */
/** The deployment's floor: 12 in production whatever the policy says. */
export const MIN_PASSWORD_LENGTH = config.localAccounts.minPasswordLength;

/** The minimum in force: the password policy's, never below the floor. */
export function minPasswordLength(): number {
  return Math.max(MIN_PASSWORD_LENGTH, settings().localAccounts.passwordPolicy?.minLength ?? 0);
}

/** The policy in words, for the hint beside a password field. */
export function passwordPolicyText(): string {
  const p = settings().localAccounts.passwordPolicy;
  const needs = [
    p?.requireUpper ? 'an upper-case letter' : '',
    p?.requireLower ? 'a lower-case letter' : '',
    p?.requireDigit ? 'a digit' : '',
    p?.requireSymbol ? 'a symbol' : '',
  ].filter(Boolean);
  return 'At least ' + minPasswordLength() + ' characters' + (needs.length ? ', with ' + needs.join(', ').replace(/, ([^,]*)$/, ' and $1') : '') + '.';
}
/**
 * The policy as a list of rules, for the box that ticks them as you type.
 *
 * One rule per line, in the order somebody fills them: length first, because
 * it is the one that takes the typing. Only the rules actually in force are
 * listed, so a service desk that asks for nothing but length shows one line.
 *
 * **`test` is the name of the check, not the check itself.** The rule is
 * enforced by `passwordProblems()` on the server; this only decides which
 * tick to draw. `public/js/password-reveal.js` holds the matching patterns
 * and the two must stay in step - there is a test that walks this list and
 * asserts the script names every one of them.
 */
export interface PasswordRule {
  test: 'length' | 'upper' | 'lower' | 'digit' | 'symbol';
  label: string;
  /** Only for `length`. */
  min?: number;
}

export function passwordRules(): PasswordRule[] {
  const p = settings().localAccounts.passwordPolicy;
  const min = minPasswordLength();
  const rules: PasswordRule[] = [
    { test: 'length', label: min + ' characters or more', min },
  ];
  if (p?.requireUpper) rules.push({ test: 'upper', label: 'An upper-case letter' });
  if (p?.requireLower) rules.push({ test: 'lower', label: 'A lower-case letter' });
  if (p?.requireDigit) rules.push({ test: 'digit', label: 'A digit' });
  if (p?.requireSymbol) rules.push({ test: 'symbol', label: 'A symbol, such as ! or -' });
  return rules;
}

export const MAX_PASSWORD_LENGTH = 200;

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number }, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEM },
      (err, derived) => (err ? reject(err) : resolve(derived)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, COST, KEY_LENGTH);
  return [
    ALGORITHM,
    COST.N,
    COST.r,
    COST.p,
    KEY_LENGTH,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash in constant time.
 *
 * Returns false for a malformed record rather than throwing, so a corrupt row
 * denies access instead of producing a 500 that would reveal its state.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== ALGORITHM) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const keylen = Number(parts[4]);
  if (![N, r, p, keylen].every((n) => Number.isInteger(n) && n > 0)) return false;
  // Refuse absurd parameters from a tampered row, which could otherwise be
  // used to exhaust memory.
  if (N > 1 << 20 || r > 64 || p > 16 || keylen > 256) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[5] as string, 'base64');
    expected = Buffer.from(parts[6] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== keylen) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, { N, r, p }, keylen);
  } catch {
    return false;
  }

  return crypto.timingSafeEqual(derived, expected);
}

/** True when the stored hash should be re-computed at stronger settings. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== ALGORITHM) return true;
  return Number(parts[1]) < COST.N || Number(parts[2]) < COST.r;
}

/**
 * Generates a strong random password for the initial local administrator, so
 * no installation ever starts with a default or guessable one.
 */
export function generatePassword(): string {
  // 24 bytes of entropy, base64url: 32 characters, no ambiguous escaping.
  // One character of each kind is mixed in, so a generated password meets
  // any password policy (Settings - Users - Other settings).
  const pick = (set: string) => set[crypto.randomInt(set.length)]!;
  const chars = (crypto.randomBytes(24).toString('base64url') + pick('ABCDEFGHJKLMNPQRSTUVWXYZ') + pick('abcdefghijkmnopqrstuvwxyz') + pick('23456789') + pick('-_.!')).split('');
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** What is known about the person a password is for, for "common phrases". */
export interface PersonContext {
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  company?: string | null;
}

/** The person's own words (email name, names, company) and the service desk's name: 3 letters or more, lower case. */
export function commonPhrases(context: PersonContext): string[] {
  const words = [
    (context.email ?? '').split('@')[0] ?? '',
    context.firstName ?? '',
    context.lastName ?? '',
    ...(context.displayName ?? '').split(/[^\p{L}\p{N}]+/u),
    context.company ?? '',
    ...settings().branding.appName.split(/[^\p{L}\p{N}]+/u),
  ];
  return [...new Set(words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3))];
}

export interface PasswordProblem {
  message: string;
}

/**
 * The password policy (Settings - Users - Other settings), plus the rules
 * that always apply. Length is the property that actually matters; the
 * character kinds are there for organisations whose own policy asks.
 * `context.email` lets "not the email name" be checked where it is known.
 */
export function passwordProblems(password: string, context: PersonContext = {}): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const policy = settings().localAccounts.passwordPolicy;
  const min = minPasswordLength();
  if (password.length < min) {
    problems.push({ message: 'The password must be at least ' + min + ' characters long.' });
  }
  if (policy?.requireUpper && !/\p{Lu}/u.test(password)) problems.push({ message: 'The password must contain an upper-case letter.' });
  if (policy?.requireLower && !/\p{Ll}/u.test(password)) problems.push({ message: 'The password must contain a lower-case letter.' });
  if (policy?.requireDigit && !/\p{Nd}/u.test(password)) problems.push({ message: 'The password must contain a digit.' });
  if (policy?.requireSymbol && !/[^\p{L}\p{Nd}\s]/u.test(password)) problems.push({ message: 'The password must contain a symbol, such as ! or -.' });
  // "Don't allow common phrases" (stored as notEmail, its first name): the
  // person's own words and the service desk's name.
  if (policy?.notEmail) {
    const folded = password.toLowerCase();
    const hit = commonPhrases(context).find((w) => folded.includes(w));
    if (hit) problems.push({ message: 'The password must not contain a common phrase such as your name, email or company, or the service desk\'s name.' });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    problems.push({
      message: 'The password must be at most ' + MAX_PASSWORD_LENGTH + ' characters long.',
    });
  }
  if (/^\s|\s$/.test(password)) {
    problems.push({ message: 'The password must not start or end with a space.' });
  }
  const trivial = ['password', 'administrator', 'servicedesk', 'changeme', 'letmein'];
  const folded = password.toLowerCase();
  if (trivial.some((word) => folded.includes(word))) {
    problems.push({ message: 'The password must not contain an obvious word such as "password".' });
  }
  return problems;
}

/** A user, as "common phrases" reads them. */
export function personOf(user: { email: string; first_name?: string | null; last_name?: string | null; display_name?: string | null; company?: string | null }): PersonContext {
  return { email: user.email, firstName: user.first_name ?? null, lastName: user.last_name ?? null, displayName: user.display_name ?? null, company: user.company ?? null };
}
