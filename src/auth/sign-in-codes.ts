import crypto from 'node:crypto';
import { config } from '../config.js';
import { execute, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { normaliseEmail, nowIso, safeEqual, sha256 } from '../lib/util.js';
import { settings } from '../settings/index.js';
import { findUserById, type UserRow } from '../services/users.js';
import { userGroupsFor } from '../services/user-groups.js';
import { defaultMailbox, listMailboxes } from '../services/mail/mailboxes.js';
import { anyRelayReady, relayForGroup } from '../services/mail/relay.js';
import { queueMail, sendSoon } from '../services/mail/outbox.js';
import { LOCAL_ISSUER, isLocalAccount, isLocalAdmin } from './local-accounts.js';

const log = logger.child({ module: 'sign-in-codes' });

/**
 * Signing in with a one-time code sent by email, instead of a password.
 *
 * Settings - Users. One switch for password accounts, with a user group that
 * keeps passwords; and a separate switch for the break-glass account, which
 * is off by default because a mailbox outage must not lock out the account
 * that exists for outages. FORCE_LOCAL_SIGNIN turns the break-glass account
 * back to its password without touching the stored choice.
 *
 * The code is six digits, stored only as a hash, lives ten minutes, allows
 * five tries and is single use. A new one is not sent more than once a
 * minute per account, so the form cannot be used to flood a mailbox.
 */

export const CODE_TTL_MS = 5 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RESEND_MS = 60_000;

interface CodeRow {
  user_id: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  created_at: string;
}

function hashCode(userId: string, code: string): string {
  return sha256(userId + ':' + code);
}

/** Whether this account signs in with an emailed code rather than its password. */
export async function signsInWithCode(user: Pick<UserRow, 'id' | 'issuer' | 'external_id'>): Promise<boolean> {
  if (!isLocalAccount(user)) return false;
  const local = settings().localAccounts;
  if (isLocalAdmin(user)) return local.breakGlassOtp && !config.forceLocalSignIn;
  if (!local.otpEnabled) return false;
  if (local.otpExcludedGroupId) {
    const groups = await userGroupsFor(user.id);
    if (groups.some((g) => g.id === local.otpExcludedGroupId)) return false;
  }
  return true;
}

/** Whether the sign-in page should offer "Email me a sign-in code" at all. */
export function codeSignInOffered(): boolean {
  const local = settings().localAccounts;
  return local.otpEnabled || (local.breakGlassOtp && !config.forceLocalSignIn);
}

/**
 * Why code sign-in cannot be switched on for these accounts, or null.
 * Without a mailbox no code could ever arrive, which is a lockout.
 */
export async function cannotEnableCodes(forBreakGlass: boolean, breakGlassEmail?: string): Promise<string | null> {
  if ((await listMailboxes()).length === 0 && !(await anyRelayReady())) {
    return 'Sign-in codes are sent by email. Add a mailbox or set up an SMTP relay under Mail first.';
  }
  // @local and .invalid (a hosted helpdesk's random break-glass address) receive no mail.
  if (forBreakGlass && (!breakGlassEmail || breakGlassEmail.endsWith('@local') || breakGlassEmail.endsWith('.invalid'))) {
    return 'Give the break-glass account an email address that can receive mail first. Codes cannot be delivered to ' +
      (breakGlassEmail || 'this address') + '.';
  }
  return null;
}

async function accountByEmail(email: string): Promise<UserRow | undefined> {
  const row = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = ? AND issuer = ?', [
    normaliseEmail(email),
    LOCAL_ISSUER,
  ]);
  return row ? findUserById(row.id) : undefined;
}

/** Whether the account behind this address signs in with a code. */
export async function emailSignsInWithCode(email: string): Promise<boolean> {
  const user = await accountByEmail(email);
  return Boolean(user && (await signsInWithCode(user)));
}

/**
 * Sends a code when the address belongs to an active account that signs in
 * with one. Says nothing either way: the page reads the same for an unknown
 * address, so this cannot be used to discover who has an account.
 */
export async function requestSignInCode(email: string, ip: string | null): Promise<void> {
  const user = await accountByEmail(email);
  if (!user || user.status !== 'active' || !(await signsInWithCode(user))) return;
  await sendCodeTo(user, ip);
}

/**
 * A code for an account that signs in with a password, as a second step.
 *
 * Used by conditional access (auth/conditional-access.ts) once the password
 * has been checked, so there is no "who is this" to leak here: the caller
 * already knows.
 */
export async function requestCodeFor(user: UserRow, ip: string | null): Promise<boolean> {
  if (user.status !== 'active') return false;
  return sendCodeTo(user, ip);
}

/** Mints, stores and sends one code. Returns false when nothing could send it. */
async function sendCodeTo(user: UserRow, ip: string | null): Promise<boolean> {

  const existing = await queryOne<CodeRow>('SELECT * FROM local_signin_codes WHERE user_id = ?', [user.id]);
  // One a minute per account: a second press is not a second mail, and the
  // first code is still good.
  if (existing && Date.now() - new Date(existing.created_at).getTime() < CODE_RESEND_MS) return true;

  // The default relay when codes go through it, or when notifications go
  // only through relays (Settings - Mail - SMTP relays); otherwise the
  // default mailbox.
  const options = settings().smtpRelay;
  const relay = options.useForCodes || options.relaysOnly ? await relayForGroup(null) : undefined;
  const viaRelay = Boolean(relay);
  const mailbox = viaRelay ? undefined : await defaultMailbox();
  if (!viaRelay && !mailbox) {
    log.warn({ userId: user.id }, 'a sign-in code was asked for, but there is no mailbox to send it');
    return false;
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const now = new Date();
  await execute(
    `INSERT INTO local_signin_codes (user_id, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       code_hash = excluded.code_hash, expires_at = excluded.expires_at,
       attempts = 0, created_at = excluded.created_at`,
    [user.id, hashCode(user.id, code), new Date(now.getTime() + CODE_TTL_MS).toISOString(), now.toISOString()],
  );

  const appName = settings().branding.appName;
  await queueMail({
    mailboxId: mailbox?.id ?? null,
    ...(relay ? { viaRelay: true, relayId: relay.id } : {}),
    // Expires in minutes: ahead of any backlog, and sent now.
    urgent: true,
    ticketId: null,
    to: user.email,
    subject: 'Your sign-in code: ' + code,
    // Nothing interpolated here comes from a user except through the
    // digits, which are digits.
    bodyHtml:
      '<p>Your code to sign in is:</p>' +
      '<p style="font-size:24px;font-weight:bold;letter-spacing:4px">' + code + '</p>' +
      '<p>It expires in 5 minutes and can be used once. If you did not try to sign in, ignore this message.</p>' +
      '<p style="color:#666">' + appName.replace(/[<>&"]/g, '') + '</p>',
  });
  sendSoon();
  audit({
    action: 'local_account.code.sent',
    actorId: user.id,
    actorEmail: user.email,
    ip,
  });
  return true;
}

/** Checks a code. Returns the account on success; throws a refusal otherwise. */
export async function verifySignInCode(email: string, code: string): Promise<UserRow> {
  const user = await accountByEmail(email);
  if (!user) throw conflict('That code is not valid. Check it, or ask for a new one.', 'bad_code');
  const checked = await checkCode(user, code);
  // A code account only: this is the sign-in itself.
  if (!(await signsInWithCode(checked))) {
    throw conflict('That code is not valid. Check it, or ask for a new one.', 'bad_code');
  }
  return checked;
}

/**
 * Checks a second-step code for an account the caller has already
 * identified by its password.
 */
export async function verifyCodeFor(user: UserRow, code: string): Promise<UserRow> {
  return checkCode(user, code);
}

async function checkCode(user: UserRow, code: string): Promise<UserRow> {
  const refuse = () => conflict('That code is not valid. Check it, or ask for a new one.', 'bad_code');
  const row = await queryOne<CodeRow>('SELECT * FROM local_signin_codes WHERE user_id = ?', [user.id]);
  if (!row) throw refuse();

  if (new Date(row.expires_at).getTime() < Date.now() || row.attempts >= CODE_MAX_ATTEMPTS) {
    await execute('DELETE FROM local_signin_codes WHERE user_id = ?', [user.id]);
    throw conflict('That code has expired. Ask for a new one.', 'code_expired');
  }

  const typed = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(typed) || !safeEqual(hashCode(user.id, typed), row.code_hash)) {
    await execute('UPDATE local_signin_codes SET attempts = attempts + 1 WHERE user_id = ?', [user.id]);
    audit({
      action: 'local_account.code.failed',
      outcome: 'failure',
      actorId: user.id,
      actorEmail: user.email,
      detail: { attempts: row.attempts + 1 },
    });
    throw refuse();
  }

  // Single use, whatever happens next.
  await execute('DELETE FROM local_signin_codes WHERE user_id = ?', [user.id]);

  if (user.status !== 'active') {
    throw conflict('That account is disabled.', 'account_disabled');
  }

  await execute('UPDATE local_credentials SET failed_attempts = 0, locked_until = NULL, last_success_at = ? WHERE user_id = ?', [
    nowIso(),
    user.id,
  ]);
  return user;
}
