import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyDisplayName } from '../services/display-names.js';
import { z } from 'zod';
import { config, type Role } from '../config.js';
import { settings } from '../settings/index.js';
import { execute, query, queryOne, transaction } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { newId, normaliseEmail, nowIso } from '../lib/util.js';
import { findUserById, type UserRow } from '../services/users.js';
import { generatePassword, hashPassword, needsRehash, verifyPassword } from './password.js';

const log = logger.child({ module: 'local-accounts' });

/**
 * Accounts that sign in with an email address and a password, rather than
 * through Entra ID. There is no separate username: the address is the
 * sign-in name. (local_credentials.username still exists - migrations only
 * add - and always holds the email, lower-cased.)
 *
 * Two jobs:
 *
 *  - **Break-glass.** The break-glass account (`admin@local` in development,
 *    a random address on a hosted helpdesk) is always present and always an
 *    administrator, so a mistyped tenant id, an expired client secret or an
 *    identity provider outage cannot lock everybody out of the settings
 *    needed to fix it. It cannot be deleted, demoted or disabled.
 *  - **Working without an identity provider at all.** A deployment that has
 *    not been connected to Entra ID - a proof of concept, a demo, a local
 *    development copy - still needs real accounts to exercise the queue from
 *    both sides.
 *
 * The trade-off is deliberate: a standing password credential is a permanent
 * thing to protect, so every account here is rate-limited, locked out after
 * repeated failures, audited on every attempt, and never given a password
 * that was not either generated or set by an administrator.
 */

/** Fixed issuer for password accounts. Not a directory principal. */
export const LOCAL_ISSUER = 'urn:helpdesk:local';
/**
 * The break-glass administrator's immutable key - it is found by this, never
 * by its address - and the address it has in development and the tests.
 */
export const LOCAL_EXTERNAL_ID = 'local:administrator';
export const LOCAL_EMAIL = 'admin@local';

/**
 * The address a hosted helpdesk's break-glass account is created with: random
 * on both sides, so the sign-in name is not the one every helpdesk shares
 * (asked for 17 Oct 2026, "admin@local can be an issue"). .invalid is
 * reserved (RFC 2606) and never resolves, so no mail can reach it - and, like
 * @local, it keeps sign-in codes off for this account (sign-in-codes.ts).
 */
export function randomBreakGlassEmail(): string {
  const part = (n: number) => Array.from(randomBytes(n), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  return part(12) + '@' + part(12) + '.invalid';
}
/** The second seeded account, outside production only. */
export const LOCAL_TEST_EMAIL = 'user@local';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60_000;

export interface LocalCredentialRow {
  user_id: string;
  username: string;
  password_hash: string;
  must_change: boolean;
  failed_attempts: number;
  locked_until: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  password_updated_at: string;
  created_at: string;
}

/** A password account joined to its user row, for the administration page. */
export interface LocalAccountRow extends UserRow {
  username: string;
  must_change: boolean;
  failed_attempts: number;
  locked_until: string | null;
  last_success_at: string | null;
  password_updated_at: string;
}

/** Usernames are matched case-insensitively and stored folded. */
export function normaliseUsername(value: string): string {
  return value.trim().toLowerCase();
}

const emailSchema = z.string().email().max(200);

/** An address a password account can sign in with. */
export function isEmailAddress(value: string): boolean {
  return emailSchema.safeParse(value).success;
}

function credentialByUsername(username: string): Promise<LocalCredentialRow | undefined> {
  return queryOne<LocalCredentialRow>('SELECT * FROM local_credentials WHERE username = ?', [
    normaliseUsername(username),
  ]);
}

function credentialByUserId(userId: string): Promise<LocalCredentialRow | undefined> {
  return queryOne<LocalCredentialRow>('SELECT * FROM local_credentials WHERE user_id = ?', [
    userId,
  ]);
}

/** Every password account, for Admin -> Users. */
export function listLocalAccounts(): Promise<LocalAccountRow[]> {
  return query<LocalAccountRow>(
    `SELECT u.*, c.username, c.must_change, c.failed_attempts, c.locked_until,
            c.last_success_at, c.password_updated_at
       FROM local_credentials c
       JOIN users u ON u.id = c.user_id
      ORDER BY u.role DESC, c.username`,
  );
}

/** The break-glass administrator's user row, if it has been created. */
export function findLocalAdmin(): Promise<UserRow | undefined> {
  return queryOne<UserRow>('SELECT * FROM users WHERE issuer = ? AND external_id = ?', [
    LOCAL_ISSUER,
    LOCAL_EXTERNAL_ID,
  ]);
}

/** True for any password account; such an account has no directory behind it. */
export function isLocalAccount(user: Pick<UserRow, 'issuer'>): boolean {
  return user.issuer === LOCAL_ISSUER;
}

/** True only for the one account that may never be demoted or removed. */
export function isLocalAdmin(user: Pick<UserRow, 'issuer' | 'external_id'>): boolean {
  return user.issuer === LOCAL_ISSUER && user.external_id === LOCAL_EXTERNAL_ID;
}

export interface LocalAdminStatus {
  exists: boolean;
  email: string;
  mustChange: boolean;
  passwordUpdatedAt: string | null;
  lockedUntil: string | null;
  failedAttempts: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

/** Password state for one account, used by the profile page. */
export async function localAccountStatus(userId?: string): Promise<LocalAdminStatus> {
  const user = userId ? await findUserById(userId) : await findLocalAdmin();
  const credential = user ? await credentialByUserId(user.id) : undefined;
  return {
    exists: Boolean(user && credential),
    email: user?.email ?? LOCAL_EMAIL,
    mustChange: credential?.must_change === true,
    passwordUpdatedAt: credential?.password_updated_at ?? null,
    lockedUntil: credential?.locked_until ?? null,
    failedAttempts: credential?.failed_attempts ?? 0,
    lastSuccessAt: credential?.last_success_at ?? null,
    lastFailureAt: credential?.last_failure_at ?? null,
  };
}

/** Kept for the sign-in page, which asks only about the break-glass account. */
export const localAdminStatus = (): Promise<LocalAdminStatus> => localAccountStatus();

// ---------------------------------------------------------------------------
// Creating and maintaining accounts
// ---------------------------------------------------------------------------

export interface CreateLocalAccountInput {
  displayName: string;
  /** The sign-in name. Required. */
  email: string;
  /**
   * The two seeded accounts use `@local` addresses, which no mail system
   * accepts and so no address check would pass. Only ensureLocalAdmin sets it.
   */
  seeded?: boolean;
  role: Role;
  password: string;
  /** Already hashed (a confirmed registration): used instead of hashing `password`. */
  passwordHash?: string;
  /** Force a change at next sign-in. True for an administrator-set password. */
  mustChange?: boolean;
  /** Only ensureLocalAdmin sets this; everything else gets a random uuid key. */
  externalId?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
}

export async function createLocalAccount(
  input: CreateLocalAccountInput,
  actorId: string | null,
): Promise<UserRow> {
  const email = normaliseEmail(input.email ?? '');
  if (!(input.seeded ? email.includes('@') : isEmailAddress(email))) {
    throw conflict('That is not a valid email address.', 'invalid_email');
  }
  // The address is the sign-in name; the column keeps its old name.
  const username = email;

  if (await credentialByUsername(username)) {
    throw conflict('That email address already belongs to another account.', 'email_taken');
  }
  const emailTaken = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = ?', [
    email,
  ]);
  if (emailTaken) {
    throw conflict('That email address already belongs to another account.', 'email_taken');
  }

  const hash = input.passwordHash ?? (await hashPassword(input.password));
  const now = nowIso();
  const id = newId();
  const externalId = input.externalId ?? 'local:' + id;

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO users
         (id, issuer, external_id, email, upn, display_name, display_name_source, first_name, last_name, company,
          role, role_locked, status,
          source, directory_present, last_login_at, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, 'active', 'local', 0, NULL, NULL, ?, ?)`,
      [id, LOCAL_ISSUER, externalId, email, input.displayName, input.displayName,
        (input.firstName ?? '').trim().slice(0, 100), (input.lastName ?? '').trim().slice(0, 100), (input.company ?? '').trim().slice(0, 120),
        input.role, now, now],
    );

    await client.query(
      `INSERT INTO local_credentials
         (user_id, username, password_hash, must_change, failed_attempts, locked_until,
          last_success_at, last_failure_at, password_updated_at, created_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)`,
      [id, username, hash, input.mustChange === true ? 1 : 0, now, now],
    );
  });

  audit({
    action: 'local_account.created',
    actorId,
    targetType: 'user',
    targetId: id,
    detail: { email, role: input.role },
  });
  log.info({ userId: id, email, role: input.role }, 'local account created');

  await applyDisplayName(id);
  const created = await findUserById(id);
  if (!created) throw new Error('local account vanished immediately after insert: ' + id);
  return created;
}

/**
 * Creates the break-glass administrator, and - outside production - a pair of
 * accounts to test with.
 *
 * In production the administrator gets a random password written to the log
 * exactly once: an installation nobody looks at is not left with a guessable
 * administrator. Outside production the seed password from
 * `LOCAL_SEED_PASSWORD` is used instead, so a proof of concept can be signed
 * into without reading the log.
 */
/**
 * Where a production helpdesk keeps the break-glass account's generated
 * password until it is changed: the data folder (the uploads folder's parent),
 * never the log.
 */
export const BREAK_GLASS_FILE = path.join(path.dirname(config.uploadDir), 'break-glass-password.txt');

export async function ensureLocalAdmin(): Promise<void> {
  const existingAdmin = await findLocalAdmin();
  const existingCredential = existingAdmin
    ? await credentialByUserId(existingAdmin.id)
    : undefined;

  if (existingAdmin && !existingCredential) {
    // An orphaned user row without credentials: start again from a known state.
    await execute('DELETE FROM users WHERE id = ?', [existingAdmin.id]);
  }

  // A hosted helpdesk has no break-glass account: the customer portal names
  // its administrators (portal-admins.ts). Development and the tests keep
  // admin@local, the only way into a local copy.
  if (config.isProduction) return;

  if (!existingAdmin || !existingCredential) {
    const seeded = config.localAccounts.seedPassword;
    const password = seeded ?? generatePassword();
    // A hosted helpdesk (production, no seed password) gets an address of its
    // own; development and the tests keep admin@local. One created before
    // keeps whatever it has - this runs only when there is none.
    const email = config.isProduction && !seeded ? randomBreakGlassEmail() : LOCAL_EMAIL;

    await createLocalAccount(
      {
        displayName: 'Local administrator',
        email,
        seeded: true,
        role: 'admin',
        password,
        // A generated password must be replaced; a seed password is one the
        // operator chose, so leave it alone.
        mustChange: seeded === null,
        externalId: LOCAL_EXTERNAL_ID,
      },
      null,
    );

    if (seeded) {
      log.warn(
        { email: LOCAL_EMAIL },
        'Local administrator created with the seed password from LOCAL_SEED_PASSWORD. ' +
          'Change it under Profile -> Password before this is reachable by anyone else.',
      );
    } else if (config.isProduction) {
      // Never into the log: a hosting platform keeps logs, often where more
      // people can read them than can read the server's disk (App Service
      // keeps them for days). The one copy goes into a file only this
      // account can read, beside the database, and is removed as soon as
      // the password is changed (setLocalPassword).
      // The address goes in the file too and not in the log: random, it is
      // half of what it takes to sign in.
      fs.writeFileSync(BREAK_GLASS_FILE, 'Address: ' + email + '\nPassword: ' + password + '\n', { mode: 0o600 });
      log.warn(
        { file: BREAK_GLASS_FILE },
        'Local administrator created. Its address and one-time password are in the file named here (readable only by this server); ' +
          'sign in at /login with them and change the password on your profile page, which deletes the file.',
      );
    } else {
      // Outside production, printed once: a local proof of concept without a
      // seed password still needs a way in.
      log.warn(
        { email },
        'Local administrator created. Sign in at /login as "' +
          email +
          '" and this one-time password, then change it on your profile page:\n\n    ' +
          password +
          '\n\nThis password is not stored in readable form and will not be shown again.',
      );
    }
  }

  // The second test account exists only where a seed password is configured,
  // which is never the case in production.
  const seeded = config.localAccounts.seedPassword;
  if (seeded && !(await credentialByUsername(LOCAL_TEST_EMAIL))) {
    await createLocalAccount(
      {
        displayName: 'Test user',
        email: LOCAL_TEST_EMAIL,
        seeded: true,
        role: 'user',
        password: seeded,
        mustChange: false,
      },
      null,
    );
    log.warn({ email: LOCAL_TEST_EMAIL }, 'test account created with the seed password');
  }
}

/** Replaces the password on one account and clears any lockout. */
export async function setLocalPassword(
  userId: string,
  plaintext: string,
  actorId: string | null,
  options: { mustChange?: boolean } = {},
): Promise<void> {
  const credential = await credentialByUserId(userId);
  if (!credential) {
    throw forbidden('That account does not sign in with a password.', 'not_a_local_account');
  }

  const hash = await hashPassword(plaintext);
  await execute(
    `UPDATE local_credentials SET
        password_hash = ?, must_change = ?, failed_attempts = 0,
        locked_until = NULL, password_updated_at = ?
      WHERE user_id = ?`,
    [hash, options.mustChange === true ? 1 : 0, nowIso(), userId],
  );

  // The generated first password, if it is still on disk, is no longer the password.
  if (credential.username === LOCAL_EMAIL || (await findUserById(userId))?.external_id === LOCAL_EXTERNAL_ID) {
    fs.rmSync(BREAK_GLASS_FILE, { force: true });
  }

  audit({
    action: 'local_account.password.changed',
    actorId,
    targetType: 'user',
    targetId: userId,
    detail: { byAdministrator: actorId !== userId },
  });
  log.info({ userId }, 'local password changed');
}

/** Kept for the profile page, which only ever changes its own password. */
export async function setLocalAdminPassword(
  plaintext: string,
  actorId: string | null,
): Promise<void> {
  const user = await findLocalAdmin();
  if (!user) throw forbidden('The local administrator account does not exist.', 'no_local_admin');
  await setLocalPassword(user.id, plaintext, actorId);
}

/** Removes a password account. The break-glass administrator is protected. */
export async function deleteLocalAccount(userId: string, actorId: string | null): Promise<void> {
  const user = await findUserById(userId);
  if (!user) return;
  if (isLocalAdmin(user)) {
    throw forbidden(
      'The break-glass administrator cannot be removed; it is what keeps the service administrable.',
      'local_admin_protected',
    );
  }
  // Tickets reference their requester with ON DELETE RESTRICT, so an account
  // that has raised anything is disabled rather than deleted.
  const raised = await queryOne<{ c: number }>(
    'SELECT count(*) AS c FROM tickets WHERE requester_id = ? OR assignee_id = ?',
    [userId, userId],
  );
  if ((raised?.c ?? 0) > 0) {
    await execute("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?", [
      nowIso(),
      userId,
    ]);
    audit({ action: 'local_account.disabled', actorId, targetType: 'user', targetId: userId });
    return;
  }

  await execute('DELETE FROM users WHERE id = ?', [userId]);
  audit({ action: 'local_account.deleted', actorId, targetType: 'user', targetId: userId });
  log.info({ userId }, 'local account deleted');
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export interface LocalSignInResult {
  user: UserRow;
  mustChange: boolean;
}

/** A hash of the right shape over a value nothing matches. */
const DUMMY_HASH =
  'scrypt$16384$8$1$64$' +
  Buffer.alloc(16).toString('base64') +
  '$' +
  Buffer.alloc(64).toString('base64');

/**
 * Verifies a local sign-in.
 *
 * Both a wrong address and a wrong password produce the same failure after
 * comparable work, so the response does not reveal whether the account
 * exists. Repeated failures lock the account for a period, which bounds
 * online guessing regardless of the rate limiter.
 */
export async function verifyLocalSignIn(
  email: string,
  password: string,
): Promise<LocalSignInResult> {
  // The address is the sign-in name. Matched through users.email as well,
  // so an account whose credential row predates that still gets in.
  let credential = await credentialByUsername(normaliseEmail(email));
  if (!credential) {
    const byEmail = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email = ? AND issuer = ?',
      [normaliseEmail(email), LOCAL_ISSUER],
    );
    if (byEmail) credential = await credentialByUserId(byEmail.id);
  }

  const user = credential ? await findUserById(credential.user_id) : undefined;

  if (!credential || !user) {
    // Spend comparable effort on an unknown name, so timing does not
    // distinguish "no such account" from "wrong password".
    await verifyPassword(password, DUMMY_HASH);
    throw unauthorized('Those sign-in details are not valid.', 'local_signin_failed');
  }

  const now = Date.now();
  const lockedUntilMs = credential.locked_until ? new Date(credential.locked_until).getTime() : 0;
  if (lockedUntilMs > now) {
    const minutes = Math.ceil((lockedUntilMs - now) / 60_000);
    audit({
      action: 'local_account.login.denied',
      outcome: 'failure',
      actorId: user.id,
      actorEmail: user.email,
      detail: { reason: 'locked_out', minutesRemaining: minutes },
    });
    throw unauthorized(
      'Too many failed attempts. Try again in ' + minutes + ' minute(s).',
      'local_locked_out',
    );
  }

  const ok = await verifyPassword(password, credential.password_hash);

  if (!ok) {
    const attempts = credential.failed_attempts + 1;
    const lockedUntil = attempts >= LOCKOUT_THRESHOLD ? new Date(now + LOCKOUT_MS) : null;
    await execute(
      `UPDATE local_credentials SET
          failed_attempts = ?, locked_until = ?, last_failure_at = ?
        WHERE user_id = ?`,
      [attempts, lockedUntil, nowIso(), user.id],
    );

    log.warn({ userId: user.id, attempts, lockedOut: lockedUntil !== null }, 'local sign-in failed');
    audit({
      action: 'local_account.login.failed',
      outcome: 'failure',
      actorId: user.id,
      actorEmail: user.email,
      detail: { attempts, lockedOut: lockedUntil !== null },
    });

    throw unauthorized('Those sign-in details are not valid.', 'local_signin_failed');
  }

  if (user.status !== 'active') {
    audit({
      action: 'local_account.login.denied',
      outcome: 'failure',
      actorId: user.id,
      detail: { reason: 'account_disabled' },
    });
    throw forbidden('That account is disabled.', 'account_disabled');
  }

  await execute(
    `UPDATE local_credentials SET
        failed_attempts = 0, locked_until = NULL, last_success_at = ?
      WHERE user_id = ?`,
    [nowIso(), user.id],
  );

  // Opportunistically strengthen the stored hash if the cost has been raised.
  if (needsRehash(credential.password_hash)) {
    try {
      const rehashed = await hashPassword(password);
      await execute('UPDATE local_credentials SET password_hash = ? WHERE user_id = ?', [
        rehashed,
        user.id,
      ]);
      log.info({ userId: user.id }, 'local password hash upgraded');
    } catch (err) {
      log.warn({ err }, 'could not upgrade the stored password hash');
    }
  }

  const refreshed = (await findUserById(user.id)) ?? user;
  // Password policy: older than the maximum age is changed now, like a
  // password an administrator set. Never the break-glass account - it exists
  // for the day nothing else works.
  const maxAgeDays = settings().localAccounts.passwordPolicy?.maxAgeDays ?? 0;
  const expired = maxAgeDays > 0 && !isLocalAdmin(refreshed) && Boolean(credential.password_updated_at) &&
    Date.now() - new Date(credential.password_updated_at).getTime() > maxAgeDays * 86_400_000;
  return { user: refreshed, mustChange: credential.must_change === true || expired };
}

/**
 * Changes the email address of a password account.
 *
 * Only a local account: a directory account's address comes from Entra ID and
 * is rewritten on every sign-in, so letting somebody edit it here would hand
 * them a change that silently reverts.
 *
 * The address is also the **sign-in name**, so changing it changes what the
 * person types to get in - the page says so. It is also where notifications
 * go, which for a local test account is the only way to receive one.
 */
export async function setLocalEmail(
  userId: string,
  email: string,
  actorId: string | null,
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw notFound('That account no longer exists.');
  if (!isLocalAccount(user)) {
    throw conflict(
      'This account signs in through Entra ID, so its address comes from the directory ' +
        'and would be overwritten at the next sign-in. Change it there.',
      'not_a_local_account',
    );
  }

  const wanted = normaliseEmail(email);
  if (!wanted || !wanted.includes('@')) {
    throw conflict('That is not an email address.', 'bad_email');
  }

  const clash = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = ?', [wanted]);
  if (clash && clash.id !== userId) {
    throw conflict('That email address already belongs to another account.', 'email_taken');
  }

  const credentialClash = await queryOne<{ user_id: string }>(
    'SELECT user_id FROM local_credentials WHERE username = ?',
    [wanted],
  );
  if (credentialClash && credentialClash.user_id !== userId) {
    throw conflict('That email address already belongs to another account.', 'email_taken');
  }

  await transaction(async (client) => {
    await client.query('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', [
      wanted,
      nowIso(),
      userId,
    ]);
    // The email is the sign-in name, so it moves with the address.
    await client.query('UPDATE local_credentials SET username = ? WHERE user_id = ?', [
      wanted,
      userId,
    ]);
  });

  audit({
    action: 'local_account.email.changed',
    actorId,
    targetType: 'user',
    targetId: userId,
    detail: { from: user.email, to: wanted },
  });
}
