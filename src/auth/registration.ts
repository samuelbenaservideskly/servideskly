import crypto from 'node:crypto';
import { config } from '../config.js';
import { execute, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { normaliseEmail, sha256 } from '../lib/util.js';
import { settings } from '../settings/index.js';
import { defaultMailbox, listMailboxes } from '../services/mail/mailboxes.js';
import { anyRelayReady, relayForGroup } from '../services/mail/relay.js';
import { queueMail, sendSoon } from '../services/mail/outbox.js';
import { createLocalAccount, isEmailAddress } from './local-accounts.js';
import { hashPassword, passwordProblems } from './password.js';
import type { UserRow } from '../services/users.js';

const log = logger.child({ module: 'registration' });

/**
 * "Create an account" on the sign-in page (Users - Other settings - Let
 * people register; off by default).
 *
 * **Nothing exists until the address is confirmed.** The form keeps a row in
 * `registrations` - names, the address, the password already hashed - and
 * mails a link. Only using that link (a POST, behind a button: a mail
 * scanner that follows links must not activate anything) makes the account:
 * a plain user, a password account, active. Without that, anybody could sign
 * up as anybody@yourcompany.
 *
 * - The answer to the form is the same for every address: one that already
 *   has an account is sent nothing, so the form cannot find out who has one.
 * - The link lives 24 hours and works once; a new attempt for the same
 *   address replaces the old one; at most one mail a minute per address.
 * - Listed domains: only those addresses may register.
 * - The password policy applies, as everywhere a password is set.
 */

export const REGISTRATION_TTL_MS = 24 * 3_600_000;
const RESEND_MS = 60_000;
const hashToken = (token: string) => sha256('registration:' + token);

/** Whether the sign-in page offers "Create an account": switched on, local sign-in on, and mail to confirm with. */
export async function registrationOffered(): Promise<boolean> {
  const local = settings().localAccounts;
  if (!local.registration?.enabled || !local.signInEnabled) return false;
  return (await listMailboxes()).length > 0 || (await anyRelayReady());
}

/** Lower-case domains, one per entry, without "@" or spaces; invalid ones dropped. */
export function cleanDomains(input: string): string[] {
  return [...new Set(input.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 50);
}

export interface RegistrationInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

/** What is wrong with the form, field by field; empty when it may go ahead. */
export function registrationProblems(input: RegistrationInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.firstName.trim()) errors.firstName = 'Enter your first name.';
  if (!input.lastName.trim()) errors.lastName = 'Enter your last name.';
  const email = normaliseEmail(input.email);
  if (!isEmailAddress(email)) {
    errors.email = 'Enter your email address.';
  } else {
    const domains = settings().localAccounts.registration?.domains ?? [];
    const domain = email.split('@')[1] ?? '';
    if (domains.length > 0 && !domains.includes(domain)) errors.email = 'Accounts can be created only for ' + domains.map((d) => '@' + d).join(', ') + ' addresses.';
  }
  const weak = passwordProblems(input.password, { email, firstName: input.firstName, lastName: input.lastName });
  if (weak.length > 0) errors.password = weak[0]!.message;
  return errors;
}

/** Keeps the registration and mails its link. Says nothing about whether the address had an account. */
export async function startRegistration(input: RegistrationInput, ip: string | null): Promise<void> {
  const email = normaliseEmail(input.email);
  if (await queryOne('SELECT id FROM users WHERE email = ?', [email])) {
    log.info('a registration for an address that already has an account was ignored');
    return;
  }
  const last = await queryOne<{ created_at: string }>('SELECT created_at FROM registrations WHERE email = ?', [email]);
  if (last && Date.now() - new Date(last.created_at).getTime() < RESEND_MS) return;

  const options = settings().smtpRelay;
  const relay = options.useForCodes || options.relaysOnly ? await relayForGroup(null) : undefined;
  const mailbox = relay ? undefined : await defaultMailbox();
  if (!relay && !mailbox) return;

  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await execute('DELETE FROM registrations WHERE email = ? OR expires_at < ?', [email, now.toISOString()]);
  await execute(
    'INSERT INTO registrations (id, email, first_name, last_name, password_hash, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), email, input.firstName.trim().slice(0, 100), input.lastName.trim().slice(0, 100), await hashPassword(input.password),
      hashToken(token), now.toISOString(), new Date(now.getTime() + REGISTRATION_TTL_MS).toISOString()],
  );
  const link = config.publicOrigin + '/register/confirm/' + token;
  const appName = settings().branding.appName.replace(/[<>&"]/g, '');
  await queueMail({
    mailboxId: mailbox?.id ?? null,
    ...(relay ? { viaRelay: true, relayId: relay.id } : {}),
    urgent: true,
    ticketId: null,
    to: email,
    subject: 'Confirm your account',
    bodyHtml:
      '<p>Somebody asked to create an account for ' + email.replace(/[<>&"]/g, '') + ' on ' + appName + '.</p>' +
      '<p><a href="' + link + '" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1a5d74;color:#ffffff;text-decoration:none;font-weight:bold">Confirm and create the account</a></p>' +
      '<p>The link works once, for 24 hours. If it was not you, ignore this message - nothing is created.</p>',
  });
  sendSoon();
  audit({ action: 'local_account.registration.started', actorEmail: email, ip });
}

/** The registration a link is for, while it is still good. */
export async function pendingRegistration(token: string): Promise<{ id: string; email: string; first_name: string; last_name: string; password_hash: string } | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  return queryOne('SELECT id, email, first_name, last_name, password_hash FROM registrations WHERE token_hash = ? AND expires_at > ?', [hashToken(token), new Date().toISOString()]);
}

/** Uses the link: creates the account (once) and returns it; undefined when the link is no good. */
export async function confirmRegistration(token: string, ip: string | null): Promise<UserRow | undefined> {
  const pending = await pendingRegistration(token);
  if (!pending) return undefined;
  // Claimed first: a second press finds nothing.
  if ((await execute('DELETE FROM registrations WHERE id = ?', [pending.id])) !== 1) return undefined;
  if (await queryOne('SELECT id FROM users WHERE email = ?', [pending.email])) return undefined;
  const user = await createLocalAccount(
    {
      displayName: (pending.first_name + ' ' + pending.last_name).trim(),
      firstName: pending.first_name,
      lastName: pending.last_name,
      email: pending.email,
      role: 'user',
      password: '',
      passwordHash: pending.password_hash,
      mustChange: false,
    },
    null,
  );
  audit({ action: 'local_account.registration.confirmed', actorId: user.id, actorEmail: user.email, ip });
  return user;
}
