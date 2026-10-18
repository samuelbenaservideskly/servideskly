import { applyDisplayName } from '../services/display-names.js';
import { settings } from '../settings/index.js';
import { forbidden } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import {
  findUserByEmail,
  findUserByExternalId,
  findUserById,
  markLogin,
  upsertUserFromDirectory,
  type UserRow,
  type UserSource,
} from '../services/users.js';
import { nowIso } from '../lib/util.js';
import { applyAllRules } from '../services/user-groups.js';
import { applyAllTechnicianRules } from '../services/technician-rules.js';
import { execute, queryOne } from '../db/index.js';
import { LOCAL_EXTERNAL_ID, LOCAL_ISSUER } from './local-accounts.js';
import { sealText } from '../lib/field-crypto.js';

const log = logger.child({ module: 'provisioning' });

/** Identity as asserted by Entra ID through OpenID Connect. */
export interface DirectoryIdentity {
  /** OIDC issuer. */
  issuer: string;
  /** Entra object id ("oid" claim). */
  externalId: string | null;
  email: string;
  upn: string | null;
  displayName: string;
  /** given_name / family_name when the provider releases them. */
  firstName?: string;
  lastName?: string;
  /** From the directory (Graph, userinfo or custom claims); absent keeps what is stored. */
  company?: string;
  department?: string;
  jobTitle?: string;
  office?: string;
  phone?: string;
}

/**
 * Writes what the directory said about a person: only what it said, so a
 * provider that releases nothing leaves the stored details alone.
 */
async function applyDirectoryDetails(userId: string, identity: DirectoryIdentity): Promise<void> {
  const cut = (v: string | undefined, n: number) => (v ? v.trim().slice(0, n) : null);
  await execute(
    `UPDATE users SET company = COALESCE(?, company), department = COALESCE(?, department),
                      job_title = COALESCE(?, job_title), office = COALESCE(?, office), phone = COALESCE(?, phone)
      WHERE id = ?`,
    [cut(identity.company, 120), sealText(cut(identity.department, 120)), sealText(cut(identity.jobTitle, 120)), sealText(cut(identity.office, 120)), sealText(cut(identity.phone, 40)), userId],
  );
}

/**
 * The role every account starts with.
 *
 * Roles are **not** derived from the directory. Nothing in a token - not a
 * group, not an app role, not an address - grants agent or administrator
 * access, and signing in never changes a role that is already set. Roles are
 * assigned inside the application, under Admin -> Users, by someone who
 * already has the administrator role.
 *
 * That is a deliberate trade: it means a tenant administrator cannot grant
 * themselves access here by editing a group, and it means role changes are
 * made and audited in one place. The cost is that a new colleague needs an
 * administrator to promote them, rather than it following their group
 * membership automatically.
 */
export const INITIAL_ROLE = 'user' as const;

/** Finds the local account for an asserted identity, if one exists. */
async function locate(identity: DirectoryIdentity): Promise<UserRow | undefined> {
  if (identity.externalId) {
    const byExternal = await findUserByExternalId(identity.issuer, identity.externalId);
    if (byExternal) return byExternal;
  }
  const byEmail = await findUserByEmail(identity.email);
  // Only accept an email match when the row is not already bound elsewhere.
  if (byEmail && (byEmail.external_id === null || byEmail.external_id === identity.externalId)) {
    return byEmail;
  }
  return undefined;
}

/**
 * A password account with the address an identity provider just signed in,
 * that is not yet that provider's (asked for 17 Oct 2026). The two are never
 * joined because the addresses match: in a directory an administrator can set
 * anybody's email, so that would hand them an account here. Instead the
 * person is asked for the password account's password once - proof they own
 * both - and linkToProvider() makes it the provider's account. The
 * break-glass account is never linked.
 */
export async function linkCandidate(identity: DirectoryIdentity): Promise<UserRow | undefined> {
  if (await locate(identity)) return undefined;
  const byEmail = await findUserByEmail(identity.email);
  if (!byEmail || byEmail.issuer !== LOCAL_ISSUER || byEmail.external_id === LOCAL_EXTERNAL_ID) return undefined;
  const credential = await queryOne<{ user_id: string }>('SELECT user_id FROM local_credentials WHERE user_id = ?', [byEmail.id]);
  return credential ? byEmail : undefined;
}

/** Makes a password account the identity provider's: same row, same role and history; the password goes. */
export async function linkToProvider(userId: string, identity: DirectoryIdentity): Promise<void> {
  await execute('UPDATE users SET issuer = ?, external_id = ?, upn = COALESCE(?, upn), updated_at = ? WHERE id = ?', [
    identity.issuer,
    identity.externalId,
    identity.upn,
    nowIso(),
    userId,
  ]);
  await execute('DELETE FROM local_credentials WHERE user_id = ?', [userId]);
  audit({ action: 'user.linked_to_provider', actorId: userId, actorEmail: identity.email, targetType: 'user', targetId: userId, detail: { issuer: identity.issuer } });
}

export interface ProvisionOutcome {
  user: UserRow;
  created: boolean;
}

/**
 * Applies the provisioning policy at sign-in time and returns the local
 * account to sign the browser in as.
 *
 * With just-in-time provisioning on, an unknown account is created as a plain
 * user. With it off, only accounts SCIM has already provisioned may sign in
 * and anything else is refused.
 *
 * Either way an existing account keeps the role it was given in the
 * application: this function updates the profile, never the role.
 */
export async function provisionOnLogin(
  identity: DirectoryIdentity,
  source: UserSource,
): Promise<ProvisionOutcome> {
  const existing = await locate(identity);

  if (existing) {
    assertUsable(existing, identity);

    // Profile only. The role is whatever an administrator set it to, and the
    // directory has no say in it.
    const now = nowIso();
    await execute(
      `UPDATE users SET
          external_id   = COALESCE(?, external_id),
          display_name  = ?,
          display_name_source = ?,
          first_name    = COALESCE(?, first_name),
          last_name     = COALESCE(?, last_name),
          upn           = COALESCE(?, upn),
          last_login_at = ?,
          updated_at    = ?
        WHERE id = ?`,
      [
        identity.externalId,
        identity.displayName || existing.display_name_source || existing.display_name,
        identity.displayName || existing.display_name_source || existing.display_name,
        identity.firstName ?? null,
        identity.lastName ?? null,
        identity.upn,
        now,
        now,
        existing.id,
      ],
    );

    await applyDirectoryDetails(existing.id, identity);
    await applyDisplayName(existing.id);
    // A changed department may move them between rule groups.
    await applyAllRules(existing.id);
    await applyAllTechnicianRules(existing.id);
    const refreshed = await findUserById(existing.id);
    if (!refreshed) throw forbidden('Account unavailable.', 'account_missing');
    return { user: refreshed, created: false };
  }

  if (!settings().provisioning.jitEnabled) {
    audit({
      action: 'auth.login.denied',
      outcome: 'failure',
      actorEmail: identity.email,
      detail: { reason: 'not_provisioned' },
    });
    throw forbidden(
      'Your account is not provisioned for this application. Contact the service desk.',
      'not_provisioned',
    );
  }

  const { user, created } = await upsertUserFromDirectory({
    issuer: identity.issuer,
    externalId: identity.externalId,
    email: identity.email,
    upn: identity.upn,
    displayName: identity.displayName,
    ...(identity.firstName !== undefined ? { firstName: identity.firstName } : {}),
    ...(identity.lastName !== undefined ? { lastName: identity.lastName } : {}),
    role: INITIAL_ROLE,
    source,
    markLogin: true,
  });

  assertUsable(user, identity);
  await applyDirectoryDetails(user.id, identity);
  // The company may be part of the display name format.
  await applyDisplayName(user.id);

  if (created) {
    log.info({ userId: user.id }, 'JIT provisioned new account');
    audit({
      action: 'user.provisioned.jit',
      actorId: user.id,
      actorEmail: user.email,
      targetType: 'user',
      targetId: user.id,
      detail: { role: user.role, source },
    });
  } else {
    await markLogin(user.id);
  }

  // Rule-derived group membership follows the account, so it is recalculated
  // whenever one arrives or changes. Cheap at this scale, and it means a
  // change of department takes effect at the next sign-in rather than when
  // somebody remembers to press a button.
  await applyAllRules(user.id);
  await applyAllTechnicianRules(user.id);

  return { user, created };
}

/** Refuses sign-in for accounts an administrator or the directory disabled. */
function assertUsable(user: UserRow, identity: DirectoryIdentity): void {
  if (user.status !== 'active') {
    audit({
      action: 'auth.login.denied',
      outcome: 'failure',
      actorId: user.id,
      actorEmail: identity.email,
      detail: { reason: 'account_disabled' },
    });
    throw forbidden('This account is disabled. Contact the service desk.', 'account_disabled');
  }
}
