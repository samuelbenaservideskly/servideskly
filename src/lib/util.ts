import crypto from 'node:crypto';

/** Opaque, unguessable identifier for rows exposed in URLs. */
export function newId(): string {
  return crypto.randomUUID();
}

/** URL-safe random token. 32 bytes = 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison. Hashing both sides first keeps the comparison
 * length-independent, so neither the length nor the content of the secret
 * leaks through timing.
 */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Human-facing ticket reference derived from the monotonic counter. */
/**
 * The prefix every ticket reference carries.
 *
 * Exported because the mail code has to recognise a reference in a subject
 * line, and a second hard-coded copy of this string is how that quietly stops
 * matching the day somebody rebrands.
 */
/**
 * The prefix a ticket raised before prefixes were configurable still carries.
 *
 * Kept so an old reference quoted back in a subject still matches, and as the
 * fallback for a row with none stored.
 */
export const TICKET_PREFIX = 'TKT';

/**
 * A ticket's reference.
 *
 * The number is the identity - it is the `seq` column, allocated once - and
 * the prefix is only how it reads. Which is why a reference can be matched
 * back to its ticket whatever prefix it carries.
 */
export function ticketReference(seq: number, prefix: string = TICKET_PREFIX): string {
  return (prefix || TICKET_PREFIX) + '-' + String(seq).padStart(6, '0');
}

const CODE_TAB = 0x09;
const CODE_LF = 0x0a;
const CODE_SPACE = 0x20;
const CODE_DEL = 0x7f;

function isControlCode(code: number): boolean {
  return code < CODE_SPACE || code === CODE_DEL;
}

/** True when the string contains any C0 control character or DEL. */
export function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (isControlCode(value.charCodeAt(i))) return true;
  }
  return false;
}

/** Drops control characters, optionally keeping newlines and tabs. */
function stripControlCharacters(value: string, keepNewlinesAndTabs: boolean): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (!isControlCode(code)) {
      out += value[i];
    } else if (keepNewlinesAndTabs && (code === CODE_LF || code === CODE_TAB)) {
      out += value[i];
    }
  }
  return out;
}

/**
 * Only ever redirect to a path on this site. Anything else - absolute URLs,
 * protocol-relative `//evil.test`, backslash tricks, embedded control
 * characters - is replaced by the fallback, which closes off open-redirect
 * abuse of the post-login `returnTo` value.
 */
export function safeRedirectPath(candidate: unknown, fallback = '/tickets'): string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512) {
    return fallback;
  }
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//')) return fallback;
  if (candidate.includes('\\')) return fallback;
  if (hasControlCharacters(candidate)) return fallback;
  // Resolving against a dummy origin normalises the value and proves it cannot
  // escape to another host.
  try {
    const resolved = new URL(candidate, 'https://placeholder.invalid');
    if (resolved.origin !== 'https://placeholder.invalid') return fallback;
    const resolvedPath = resolved.pathname + resolved.search;
    return resolvedPath.startsWith('/') && !resolvedPath.startsWith('//')
      ? resolvedPath
      : fallback;
  } catch {
    return fallback;
  }
}

/** Collapses whitespace and trims, for single-line text fields. */
export function normaliseLine(value: string): string {
  return stripControlCharacters(value, false).replace(/\s+/g, ' ').trim();
}

/** Normalises multi-line text: CRLF -> LF, drops other control characters. */
export function normaliseText(value: string): string {
  const unixNewlines = value.split('\r\n').join('\n').split('\r').join('\n');
  return stripControlCharacters(unixNewlines, true).trim();
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}
