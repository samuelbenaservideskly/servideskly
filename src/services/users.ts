import type { SelfEditField } from '../settings/index.js';
import { audit } from '../lib/audit.js';
import { clientOne, count, execute, query, queryOne, transaction } from '../db/index.js';
import type { Role } from '../config.js';
import { conflict } from '../lib/errors.js';
import { newId, normaliseEmail, normaliseLine, nowIso } from '../lib/util.js';
import { applyDisplayName } from './display-names.js';
import { sealText } from '../lib/field-crypto.js';
import { providerIssuerSql, type ProviderKey } from '../auth/oidc.js';

export type UserStatus = 'active' | 'disabled';
export type UserSource = 'jit' | 'sync' | 'manual' | 'dev';

export interface UserRow {
  /** A custom role (auth/permissions.ts), which set `role`; null for a built-in one. */
  role_id?: string | null;
  /**
   * Which sorts of line this person keeps in the dashboard's Activity feed
   * (services/work-dashboard.ts). Empty: everything they may see.
   */
  activity_kinds?: string;
  /**
   * The language this person chose, as a tag; empty means "work it out" and
   * 'en' means they chose English (which is not the same thing - it stops
   * their browser and their groups deciding for them).
   */
  language?: string;
  id: string;
  issuer: string;
  external_id: string | null;
  email: string;
  upn: string | null;
  /** What is shown: built from the format (services/display-names.ts), or the source. */
  display_name: string;
  /** The name as the directory, SCIM or the person gave it. */
  display_name_source: string;
  first_name: string;
  last_name: string;
  company: string;
  role: Role;
  role_locked: boolean;
  status: UserStatus;
  source: UserSource;
  directory_present: boolean;
  /**
   * What a user group's rules read.
   *
   * Empty unless something filled them in: SCIM's enterprise extension, an
   * OIDC claim if the tenant releases one, or an administrator typing it
   * under Users. They describe the person, never their access.
   */
  department: string;
  job_title: string;
  phone: string;
  extension_attribute_1: string;
  extension_attribute_2: string;
  extension_attribute_3: string;
  office: string;
  /** Who they report to (migration 66, services/teams.ts). */
  manager_id?: string | null;
  last_login_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export const ROLE_RANK: Record<Role, number> = { user: 1, agent: 2, admin: 3 };

/** True when `role` is at least as privileged as `required`. */
export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function isStaff(role: Role): boolean {
  return roleAtLeast(role, 'agent');
}

/**
 * Escapes the LIKE wildcards in user input so a search for `100%` matches a
 * literal percent sign rather than everything.
 */
function likePattern(search: string): string {
  return '%' + search.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

// --- queries ---------------------------------------------------------------

export function findUserById(id: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

export function findUserByExternalId(
  issuer: string,
  externalId: string,
): Promise<UserRow | undefined> {
  return queryOne<UserRow>('SELECT * FROM users WHERE issuer = ? AND external_id = ?', [
    issuer,
    externalId,
  ]);
}

export function findUserByEmail(email: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>('SELECT * FROM users WHERE email = ?', [normaliseEmail(email)]);
}

/**
 * The issuers that are not a directory. Spelled out rather than imported:
 * local-accounts.ts imports this file, and the cycle would be a start-up
 * crash (trap 4). The hidden mail account is neither kind and is listed by
 * neither tab.
 */
const LOCAL_ISSUER_URN = 'urn:helpdesk:local';
export const MAIL_ISSUER_URN = 'urn:helpdesk:mail';
/** The placeholder erased accounts are filed under; see services/erasure.ts. */
export const ANONYMOUS_ISSUER_URN = 'urn:helpdesk:anonymous';

/**
 * Accounts that are not people: the one mail from a stranger hangs off, and
 * the one an erased person's work is filed under.
 *
 * Neither can sign in - both are disabled, hold no password and have an
 * address no directory can assert - and neither is listed, offered as an
 * assignee or editable. They exist so a foreign key has something to point
 * at, and nothing else.
 */
export function isReservedAccount(user: Pick<UserRow, 'issuer'>): boolean {
  return user.issuer === MAIL_ISSUER_URN || user.issuer === ANONYMOUS_ISSUER_URN;
}

export type UserKind = 'local' | 'directory';

export async function listUsers(options: {
  search?: string;
  /** Password accounts, or directory (Entra ID) ones. Both when absent. */
  kind?: UserKind;
  role?: Role;
  /** Members of this technician group. */
  technicianGroupId?: string;
  /** Members of this user group, by hand or by rule. */
  userGroupId?: string;
  /** One identity provider's accounts (oidc.ts providerIssuerSql), on the Identity providers tab. */
  provider?: ProviderKey;
  limit: number;
  offset: number;
}): Promise<{ rows: UserRow[]; total: number }> {
  const search = options.search?.trim();

  // Conditions and their parameters are pushed together, so the positional
  // `?` can never drift from the value it stands for (trap 1).
  const where: string[] = [];
  const params: unknown[] = [];
  // Never the two accounts that are not people, on any tab.
  where.push('issuer NOT IN (?, ?)');
  params.push(MAIL_ISSUER_URN, ANONYMOUS_ISSUER_URN);
  if (search) {
    const pattern = likePattern(search);
    where.push("(email LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (options.kind === 'local') {
    // The break-glass administrator has a tab of its own.
    where.push('issuer = ? AND external_id <> ?');
    params.push(LOCAL_ISSUER_URN, 'local:administrator');
  } else if (options.kind === 'directory') {
    where.push('issuer <> ?');
    params.push(LOCAL_ISSUER_URN);
  }
  if (options.role) {
    where.push('role = ?');
    params.push(options.role);
  }
  if (options.technicianGroupId) {
    where.push('id IN (SELECT user_id FROM technician_group_members WHERE group_id = ?)');
    params.push(options.technicianGroupId);
  }
  if (options.userGroupId) {
    where.push('id IN (SELECT user_id FROM user_group_members WHERE group_id = ?)');
    params.push(options.userGroupId);
  }
  if (options.provider) {
    const byProvider = providerIssuerSql(options.provider);
    where.push(byProvider.sql);
    params.push(...byProvider.params);
  }
  const clause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';

  const rows = await query<UserRow>(
    'SELECT * FROM users' + clause + ' ORDER BY lower(display_name) LIMIT ? OFFSET ?',
    [...params, options.limit, options.offset],
  );
  const total = await count('SELECT count(*) AS c FROM users' + clause, params);
  return { rows, total };
}

/** Active agents and admins, for the assignee picker. */
export function listAssignableStaff(): Promise<UserRow[]> {
  return query<UserRow>(
    `SELECT * FROM users
      WHERE status = 'active' AND role IN ('agent', 'admin')
      ORDER BY lower(display_name)`,
  );
}


/**
 * Staff, searched and paged, for the member picker.
 *
 * The unpaged `listAssignableStaff` is still right for a dropdown of
 * assignees - that is a short list by nature. This one exists because a
 * group's member picker is the one place the whole directory can end up on
 * screen, and "show me everybody" stops working somewhere around the first
 * few hundred people.
 */
export async function listAssignableStaffPage(options: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: UserRow[]; total: number }> {
  const search = options.search?.trim();
  const where = "status = 'active' AND role IN ('agent', 'admin')";

  if (search) {
    const pattern = likePattern(search);
    const filter = where + " AND (email LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')";
    const rows = await query<UserRow>(
      'SELECT * FROM users WHERE ' + filter + ' ORDER BY lower(display_name) LIMIT ? OFFSET ?',
      [pattern, pattern, options.limit, options.offset],
    );
    const total = await count('SELECT count(*) AS c FROM users WHERE ' + filter, [
      pattern,
      pattern,
    ]);
    return { rows, total };
  }

  const rows = await query<UserRow>(
    'SELECT * FROM users WHERE ' + where + ' ORDER BY lower(display_name) LIMIT ? OFFSET ?',
    [options.limit, options.offset],
  );
  const total = await count('SELECT count(*) AS c FROM users WHERE ' + where);
  return { rows, total };
}

/** Active administrators, for the notifications that go to all of them. */
export function listAdmins(): Promise<UserRow[]> {
  return query<UserRow>(
    "SELECT * FROM users WHERE status = 'active' AND role = 'admin' ORDER BY lower(display_name)",
  );
}

export function countUsers(): Promise<number> {
  return count('SELECT count(*) AS c FROM users');
}

export function countAdmins(): Promise<number> {
  return count(
    "SELECT count(*) AS c FROM users WHERE role = 'admin' AND status = 'active'",
  );
}

// --- writes ----------------------------------------------------------------


export interface UpsertUserInput {
  issuer: string;
  externalId: string | null;
  email: string;
  upn: string | null;
  displayName: string;
  /** Role derived from the directory. Ignored when `role_locked` is set. */
  role: Role;
  source: UserSource;
  markLogin?: boolean;
  markSynced?: boolean;
  /** From the directory (given_name / family_name); absent keeps what is stored. */
  firstName?: string;
  lastName?: string;
}

export interface UpsertResult {
  user: UserRow;
  created: boolean;
}

/**
 * Creates or refreshes a local account from directory data.
 *
 * Matching order is deliberate:
 *   1. (issuer, external_id) - the Entra object id, immutable and authoritative;
 *   2. email, but only for a row that has no external_id yet.
 *
 * Step 2 exists so an account seeded by an administrator binds to its real
 * directory identity on first sign-in. It deliberately refuses to rebind a row
 * that already carries a different external_id, which would otherwise let a
 * recycled or spoofed email address take over an existing account.
 *
 * The read and the write are one transaction, so two simultaneous sign-ins for
 * the same new account cannot both decide to insert.
 */
export async function upsertUserFromDirectory(input: UpsertUserInput): Promise<UpsertResult> {
  const result = await upsertInTransaction(input);
  // The directory gives the source name; what is shown follows the format.
  const shown = await applyDisplayName(result.user.id);
  return shown ? { ...result, user: { ...result.user, display_name: shown } } : result;
}

function upsertInTransaction(input: UpsertUserInput): Promise<UpsertResult> {
  return transaction(async (client) => {
    const now = nowIso();
    const email = normaliseEmail(input.email);
    const displayName = normaliseLine(input.displayName).slice(0, 200) || email;
    const upn = input.upn ? normaliseLine(input.upn).slice(0, 320) : null;

    let existing: UserRow | undefined;
    if (input.externalId) {
      existing = await clientOne<UserRow>(
        client,
        'SELECT * FROM users WHERE issuer = ? AND external_id = ?',
        [input.issuer, input.externalId],
      );
    }
    if (!existing) {
      const byEmail = await clientOne<UserRow>(
        client,
        'SELECT * FROM users WHERE email = ?',
        [email],
      );
      if (byEmail && (byEmail.external_id === null || byEmail.external_id === input.externalId)) {
        existing = byEmail;
      } else if (byEmail) {
        // A refusal, not a crash: it was a 500 page (reported 17 Oct 2026).
        // The usual cause is SCIM sending a different externalId than the
        // object id the sign-in carries - Entra's default is mailNickname.
        throw conflict(
          'The address ' +
            email +
            ' already belongs to another account here, so this sign-in was refused. ' +
            'Ask your service desk administrator to check how accounts are provisioned.',
          'email_bound_elsewhere',
        );
      }
    }

    if (!existing) {
      const inserted = await clientOne<UserRow>(
        client,
        `INSERT INTO users
           (id, issuer, external_id, email, upn, display_name, display_name_source, first_name, last_name,
            role, role_locked, status,
            source, directory_present, last_login_at, last_synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, 1, ?, ?, ?, ?)
         RETURNING *`,
        [
          newId(),
          input.issuer,
          input.externalId,
          email,
          upn,
          displayName,
          displayName,
          (input.firstName ?? '').trim().slice(0, 100),
          (input.lastName ?? '').trim().slice(0, 100),
          input.role,
          input.source,
          input.markLogin ? now : null,
          input.markSynced ? now : null,
          now,
          now,
        ],
      );
      if (!inserted) throw new Error('user insert returned no row');
      return { user: inserted, created: true };
    }

    // A locked role was set by an administrator and outranks the directory.
    const role = existing.role_locked ? existing.role : input.role;

    const updated = await clientOne<UserRow>(
      client,
      `UPDATE users SET
          external_id       = COALESCE(?, external_id),
          email             = ?,
          upn               = COALESCE(?, upn),
          display_name      = ?,
          display_name_source = ?,
          first_name        = COALESCE(?, first_name),
          last_name         = COALESCE(?, last_name),
          role              = ?,
          directory_present = 1,
          last_login_at     = CASE WHEN ? THEN ? ELSE last_login_at END,
          last_synced_at    = CASE WHEN ? THEN ? ELSE last_synced_at END,
          updated_at        = ?
        WHERE id = ?
        RETURNING *`,
      [
        input.externalId,
        email,
        upn,
        displayName,
        displayName,
        input.firstName === undefined ? null : input.firstName.trim().slice(0, 100),
        input.lastName === undefined ? null : input.lastName.trim().slice(0, 100),
        role,
        Boolean(input.markLogin),
        now,
        Boolean(input.markSynced),
        now,
        now,
        existing.id,
      ],
    );
    if (!updated) throw new Error('User disappeared during upsert: ' + existing.id);

    return { user: updated, created: false };
  });
}

export async function markLogin(userId: string): Promise<void> {
  const now = nowIso();
  await execute('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [
    now,
    now,
    userId,
  ]);
}

/** Administrative role change. Locks the role against directory mappings. */
export async function setUserRole(userId: string, role: Role, locked: boolean): Promise<void> {
  await execute('UPDATE users SET role = ?, role_locked = ?, updated_at = ? WHERE id = ?', [
    role,
    locked,
    nowIso(),
    userId,
  ]);
}

export async function setUserStatus(userId: string, status: UserStatus): Promise<void> {
  const user = await findUserById(userId);
  // Enabling one of these would be the only way either could ever be signed
  // in to, so it is refused here rather than guarded at each caller.
  if (user && isReservedAccount(user) && status === 'active') {
    throw conflict('That account is a placeholder and cannot be enabled.');
  }
  await execute('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [
    status,
    nowIso(),
    userId,
  ]);
}

/** The profile attributes a user group's rules can match on. */
export interface ProfileAttributes {
  department: string;
  jobTitle: string;
  office: string;
  /** Absent leaves the stored number as it is. */
  phone?: string;
  /** Absent leaves each as it is; a change rewrites the display name. */
  firstName?: string;
  lastName?: string;
  company?: string;
  extension1: string;
  extension2: string;
  extension3: string;
}

/**
 * Writes the attributes a rule reads.
 *
 * Separate from the role and the status on purpose: those decide access and
 * are audited as such, these only describe the person. Trimmed and bounded
 * because they arrive from a directory as often as from a form.
 */
export async function setProfileAttributes(
  userId: string,
  input: ProfileAttributes,
  actorId: string | null,
): Promise<void> {
  await execute(
    `UPDATE users SET department = ?, job_title = ?, office = ?, phone = coalesce(?, phone),
                      first_name = coalesce(?, first_name), last_name = coalesce(?, last_name), company = coalesce(?, company),
                      extension_attribute_1 = ?, extension_attribute_2 = ?,
                      extension_attribute_3 = ?, updated_at = ?
      WHERE id = ?`,
    [
      sealText(input.department.trim().slice(0, 120)),
      sealText(input.jobTitle.trim().slice(0, 120)),
      sealText(input.office.trim().slice(0, 120)),
      input.phone === undefined ? null : sealText(input.phone.trim().slice(0, 40)),
      input.firstName === undefined ? null : input.firstName.trim().slice(0, 100),
      input.lastName === undefined ? null : input.lastName.trim().slice(0, 100),
      input.company === undefined ? null : input.company.trim().slice(0, 120),
      sealText(input.extension1.trim().slice(0, 200)),
      sealText(input.extension2.trim().slice(0, 200)),
      sealText(input.extension3.trim().slice(0, 200)),
      nowIso(),
      userId,
    ],
  );

  audit({
    action: 'user.profile.updated',
    actorId,
    targetType: 'user',
    targetId: userId,
    detail: {
      department: input.department,
      jobTitle: input.jobTitle,
      office: input.office,
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.company !== undefined ? { company: input.company } : {}),
      extension1: input.extension1,
      extension2: input.extension2,
      extension3: input.extension3,
    },
  });
  // The format may read any of these.
  await applyDisplayName(userId);
}

/** Each self-editable detail's column and its longest value. */
const SELF_EDIT_COLUMNS: Record<SelfEditField, number> = { company: 120, department: 120, job_title: 120, office: 120, phone: 40 };

/**
 * A person's details that are encrypted at rest (lib/field-crypto.ts): shown
 * and read by rules in the application, never searched, sorted or grouped in
 * SQL. Every write of one goes through sealText(); data-sealing.ts seals any
 * a write missed. Company, names and the email stay readable: Reports group
 * by company, lists sort and search by name, and sign-in finds by email.
 */
export const SEALED_USER_COLUMNS = ['department', 'job_title', 'office', 'phone', 'extension_attribute_1', 'extension_attribute_2', 'extension_attribute_3'] as const;

/**
 * A person changing their own details on their profile: only the fields
 * an administrator allowed (Users - Other settings), each trimmed and
 * capped. The display name is rebuilt, since its format may read them.
 * Returns the fields that changed.
 */
export async function setOwnDetails(userId: string, values: Partial<Record<SelfEditField, string>>, allowed: readonly SelfEditField[]): Promise<SelfEditField[]> {
  const user = await findUserById(userId);
  if (!user) return [];
  const changed: SelfEditField[] = [];
  for (const field of allowed) {
    const value = values[field];
    if (typeof value !== 'string') continue;
    const clean = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, SELF_EDIT_COLUMNS[field]);
    if (clean === String((user as unknown as Record<string, unknown>)[field] ?? '')) continue;
    const stored = (SEALED_USER_COLUMNS as readonly string[]).includes(field) ? sealText(clean) : clean;
    await execute('UPDATE users SET ' + field + ' = ?, updated_at = ? WHERE id = ?', [stored, nowIso(), userId]);
    changed.push(field);
  }
  if (changed.length > 0) {
    audit({ action: 'user.profile.self_updated', actorId: userId, targetType: 'user', targetId: userId, detail: { fields: changed } });
    await applyDisplayName(userId);
  }
  return changed;
}

/**
 * The language somebody chose on their profile.
 *
 * '' is "work it out from my groups, my address and my browser"; 'en' is a
 * decision for English, which those rules then cannot overturn. Anything
 * else must be a language this service desk actually serves - a form can
 * post whatever it likes.
 */
export async function setOwnLanguage(userId: string, tag: string, offered: readonly string[]): Promise<void> {
  const wanted = tag.trim();
  const allowed = wanted === '' || wanted === 'en' || offered.some((t) => t.toLowerCase() === wanted.toLowerCase());
  if (!allowed) return;
  await execute('UPDATE users SET language = ?, updated_at = ? WHERE id = ?', [wanted, nowIso(), userId]);
}
