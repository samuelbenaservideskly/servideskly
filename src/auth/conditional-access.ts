import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { settings } from '../settings/index.js';
import { signsInWithCode } from './sign-in-codes.js';
import type { UserRow } from '../services/users.js';

/**
 * Conditional access for password accounts.
 *
 * Settings - Users - Other settings. Three decisions, asked for 16 Oct 2026:
 *
 * - **Addresses sign-in is allowed from**, as CIDR ranges. Empty means
 *   anywhere, which is what every service desk starts as.
 * - **Elsewhere, ask for a code by email** instead of refusing - the answer
 *   for somebody working from home on a desk that is otherwise office-only.
 * - **A code by email for every sign-in**, wherever it comes from.
 *
 * Four things this has to get right:
 *
 * 1. **It governs password accounts only.** A directory account is the
 *    identity provider's to gate, and it has its own conditional access -
 *    duplicating it here would be a second answer to the same question, in a
 *    place nobody would think to look.
 * 2. **An account that already signs in with a code is not asked twice.**
 *    The code *is* its sign-in; a second one proves nothing (asked for
 *    directly).
 * 3. **The break-glass account is never refused by address.** It exists for
 *    the day something is broken, and "the office network is unreachable" is
 *    one of those days. It can still be asked for a code when the service
 *    desk has turned codes on for it, which is its own switch.
 * 4. **An address that cannot be read is not a refusal.** With no client
 *    address - a misconfigured proxy, a unix socket - the rule cannot be
 *    applied, and locking everybody out because of a header is worse than
 *    not applying it. It is logged, and the MFA switches still apply.
 */

export type AccessDecision = 'allow' | 'code' | 'refuse';

/** One CIDR range, or a single address. IPv4 and IPv6. */
export interface Range {
  bytes: number[];
  bits: number;
}

/** The address as bytes: 4 for IPv4, 16 for IPv6. Undefined when unreadable. */
export function addressBytes(value: string): number[] | undefined {
  const text = value.trim().replace(/^\[|\]$/g, '');
  if (!text) return undefined;

  // Express gives "::ffff:10.0.0.1" for an IPv4 client on a dual-stack
  // socket; it is that IPv4 address, and an operator writing 10.0.0.0/8
  // means it.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  const plain = mapped ? mapped[1]! : text;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(plain)) {
    const parts = plain.split('.').map((p) => Number(p));
    return parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : undefined;
  }

  if (!plain.includes(':')) return undefined;

  // IPv6, including one "::" run and a trailing IPv4 form.
  const halves = plain.split('::');
  if (halves.length > 2) return undefined;
  const expand = (half: string): number[] | undefined => {
    if (!half) return [];
    const out: number[] = [];
    for (const group of half.split(':')) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(group)) {
        const four = addressBytes(group);
        if (!four) return undefined;
        out.push(...four);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      const n = Number.parseInt(group, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };

  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 16 ? head : undefined;
  const fill = 16 - head.length - tail.length;
  if (fill < 0) return undefined;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/**
 * One line of the setting as a range, or undefined when it is not one.
 *
 * Used both to validate what somebody typed - on the page, where they can
 * fix it - and to apply it, so the two can never disagree.
 */
export function parseRange(line: string): Range | undefined {
  const text = line.trim();
  if (!text) return undefined;
  const [address, prefix] = text.split('/');
  const bytes = addressBytes(address ?? '');
  if (!bytes) return undefined;

  // No prefix means the one address.
  if (prefix === undefined) return { bytes, bits: bytes.length * 8 };
  if (!/^\d{1,3}$/.test(prefix)) return undefined;
  const bits = Number(prefix);
  if (bits > bytes.length * 8) return undefined;
  return { bytes, bits };
}

/** Whether an address falls inside a range. */
export function inRange(address: number[], range: Range): boolean {
  // An IPv4 address is never inside an IPv6 range, or the other way round:
  // they are different address spaces, and a /0 in one is not "everything".
  if (address.length !== range.bytes.length) return false;

  let left = range.bits;
  for (let i = 0; i < address.length && left > 0; i += 1) {
    const take = Math.min(8, left);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((address[i]! & mask) !== (range.bytes[i]! & mask)) return false;
    left -= take;
  }
  return true;
}

/** Whether this address is inside any of the configured ranges. */
export function addressAllowed(ip: string | null | undefined, ranges: readonly string[]): boolean {
  if (ranges.length === 0) return true;
  const address = addressBytes(String(ip ?? ''));
  // Unreadable: the rule cannot be applied. See the note at the top.
  if (!address) return true;
  return ranges.some((line) => {
    const range = parseRange(line);
    return range ? inRange(address, range) : false;
  });
}

/**
 * Whether an account signing in **with a code** may do so from here.
 *
 * The code is its own second factor, so the only question left is the
 * address: inside the allowed ranges, or the service desk said elsewhere is
 * fine as long as a code is given - which it just was.
 */
export function codeSignInAllowed(user: UserRow, ip: string | null | undefined): boolean {
  const access = settings().localAccounts.conditionalAccess;

  if (isBreakGlass(user)) {
    if (access.breakGlassRanges.length === 0 || config.forceLocalSignIn) return true;
    return addressAllowed(ip, access.breakGlassRanges);
  }

  if (addressAllowed(ip, access.allowedRanges)) return true;
  return access.elsewhereNeedsCode;
}

/** The account that exists for the day everything else is broken. */
function isBreakGlass(user: Pick<UserRow, 'role' | 'role_locked'>): boolean {
  return user.role === 'admin' && Boolean(user.role_locked);
}

/**
 * What this sign-in needs: nothing more, a code by email, or refusal.
 *
 * Called after the password has been checked, so a refusal here says
 * nothing a wrong password would not have said.
 */
export async function accessDecision(
  user: UserRow,
  ip: string | null | undefined,
): Promise<AccessDecision> {
  const access = settings().localAccounts.conditionalAccess;

  /*
   * The break-glass account's own addresses, when the service desk has set
   * any (asked for 16 Oct 2026). FORCE_LOCAL_SIGNIN ignores them, which is
   * the way back in when the allowed network is the thing that broke.
   */
  if (isBreakGlass(user) && access.breakGlassRanges.length > 0 && !config.forceLocalSignIn) {
    if (!addressAllowed(ip, access.breakGlassRanges)) {
      audit({
        action: 'auth.login.denied',
        outcome: 'failure',
        actorId: user.id,
        actorEmail: user.email,
        ip: ip ?? null,
        detail: { reason: 'break_glass_address_not_allowed' },
      });
      return 'refuse';
    }
  }

  // The code is already this account's sign-in: asking for a second one
  // proves nothing.
  if (await signsInWithCode(user)) return 'allow';

  const allowed = addressAllowed(ip, access.allowedRanges);

  if (!allowed) {
    // The break-glass account answers to its own list, never this one.
    if (isBreakGlass(user)) return 'allow';
    if (access.elsewhereNeedsCode) return 'code';
    audit({
      action: 'auth.login.denied',
      outcome: 'failure',
      actorId: user.id,
      actorEmail: user.email,
      ip: ip ?? null,
      detail: { reason: 'address_not_allowed' },
    });
    return 'refuse';
  }

  return access.codeForEveryone ? 'code' : 'allow';
}
