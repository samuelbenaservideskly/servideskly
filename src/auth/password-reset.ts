import crypto from 'node:crypto';
import { config } from '../config.js';
import { execute, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { normaliseEmail, sha256 } from '../lib/util.js';
import { settings } from '../settings/index.js';
import { findUserById, type UserRow } from '../services/users.js';
import { defaultMailbox, listMailboxes } from '../services/mail/mailboxes.js';
import { anyRelayReady, relayForGroup } from '../services/mail/relay.js';
import { queueMail, sendSoon } from '../services/mail/outbox.js';
import { LOCAL_ISSUER, isLocalAdmin, setLocalPassword } from './local-accounts.js';
import { sessionStore } from './session-store.js';
import { signsInWithCode } from './sign-in-codes.js';

const log = logger.child({ module: 'password-reset' });

/**
 * "Forgot password?" on the sign-in page: a link mailed to a password
 * account, which lets its owner choose a new password.
 *
 * - **Only a password account.** A directory account's password is the
 *   directory's; an account that signs in with an emailed code has none.
 * - **Never the break-glass account.** It exists for when the mail or the
 *   directory is broken, and a mailbox somebody could read must not be a way
 *   to take it over. Its password is changed from its own profile, or by
 *   FORCE_LOCAL_SIGNIN and the seed password.
 * - **The page says the same for every address**, account or not, so it
 *   cannot be used to find out who has one; nothing is sent for the others.
 * - The token is 32 random bytes, kept only as a sha256; it lives 30 minutes,
 *   works once, and a newer link replaces an older one. At most one mail a
 *   minute per account.
 * - Setting the password clears any lockout (setLocalPassword), and is
 *   audited.
 */

export const RESET_TTL_MS = 30 * 60_000;
export const RESET_RESEND_MS = 60_000;

const hashToken = (token: string) => sha256('password-reset:' + token);

/** Whether the sign-in page offers "Forgot password?": local sign-in on, and some way to send mail. */
export async function passwordResetOffered(): Promise<boolean> {
  if (!settings().localAccounts.signInEnabled) return false;
  return (await listMailboxes()).length > 0 || (await anyRelayReady());
}

async function resettableAccount(email: string): Promise<UserRow | undefined> {
  const row = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = ? AND issuer = ?', [normaliseEmail(email), LOCAL_ISSUER]);
  const user = row ? await findUserById(row.id) : undefined;
  if (!user || user.status !== 'active' || isLocalAdmin(user) || (await signsInWithCode(user))) return undefined;
  return user;
}

/** Mails a link when the address belongs to an account that may reset; says nothing either way. */
export async function requestPasswordReset(email: string, ip: string | null): Promise<void> {
  const user = await resettableAccount(email);
  if (!user) return;

  const last = await queryOne<{ created_at: string }>('SELECT created_at FROM password_resets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [user.id]);
  if (last && Date.now() - new Date(last.created_at).getTime() < RESET_RESEND_MS) return;

  const options = settings().smtpRelay;
  const relay = options.useForCodes || options.relaysOnly ? await relayForGroup(null) : undefined;
  const mailbox = relay ? undefined : await defaultMailbox();
  if (!relay && !mailbox) {
    log.warn({ userId: user.id }, 'a password reset was asked for, but there is no mailbox to send it');
    return;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  // A newer link replaces any older one.
  await execute('DELETE FROM password_resets WHERE user_id = ?', [user.id]);
  await execute(
    'INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)',
    [crypto.randomUUID(), user.id, hashToken(token), now.toISOString(), new Date(now.getTime() + RESET_TTL_MS).toISOString()],
  );

  const link = config.publicOrigin + '/login/reset/' + token;
  const appName = settings().branding.appName.replace(/[<>&"]/g, '');
  await queueMail({
    mailboxId: mailbox?.id ?? null,
    ...(relay ? { viaRelay: true, relayId: relay.id } : {}),
    urgent: true,
    ticketId: null,
    to: user.email,
    subject: 'Reset your password',
    // The link is ours and base64url; nothing else here comes from a user.
    bodyHtml:
      '<p>Somebody asked to reset the password for ' + user.email.replace(/[<>&"]/g, '') + '.</p>' +
      '<p><a href="' + link + '" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1a5d74;color:#ffffff;text-decoration:none;font-weight:bold">Choose a new password</a></p>' +
      '<p>The link works once, for 30 minutes. If it was not you, ignore this message - your password stays as it is.</p>' +
      '<p style="color:#666">' + appName + '</p>',
  });
  sendSoon();
  audit({ action: 'local_account.password_reset.sent', actorId: user.id, actorEmail: user.email, ip });
}

/** The account a link is for, while it is still good; undefined otherwise. */
export async function accountForResetToken(token: string): Promise<UserRow | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const row = await queryOne<{ user_id: string }>(
    'SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    [hashToken(token), new Date().toISOString()],
  );
  const user = row ? await findUserById(row.user_id) : undefined;
  return user && user.status === 'active' && !isLocalAdmin(user) ? user : undefined;
}

/**
 * Uses the link: claims it (once - a second press finds it used) and sets the
 * password. Returns the account, or undefined when the link is no good.
 */
export async function completePasswordReset(token: string, password: string, ip: string | null): Promise<UserRow | undefined> {
  const user = await accountForResetToken(token);
  if (!user) return undefined;
  const claimed = await execute(
    'UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    [new Date().toISOString(), hashToken(token), new Date().toISOString()],
  );
  if (claimed !== 1) return undefined;
  await setLocalPassword(user.id, password, user.id);
  // Every session goes. Somebody who has forgotten their password is the
  // person least able to say whether one of them is theirs.
  const ended = await sessionStore.destroyForUser(user.id);
  audit({
    action: 'local_account.password_reset.used',
    actorId: user.id,
    actorEmail: user.email,
    ip,
    detail: { sessionsEnded: ended },
  });
  return user;
}
