import { applyDisplayName } from './display-names.js';
import crypto from 'node:crypto';
import { execute, query, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { newId, normaliseEmail, normaliseLine, nowIso, safeEqual } from '../lib/util.js';
import { settings, updateSettings } from '../settings/index.js';
import { INITIAL_ROLE } from '../auth/provisioning.js';
import type { UserRow } from './users.js';
import { sealText } from '../lib/field-crypto.js';
import { setManager } from './teams.js';

const log = logger.child({ module: 'scim' });

/**
 * SCIM 2.0 user provisioning, for Entra ID.
 *
 * Entra pushes the members of an assigned group at this service: it creates
 * accounts, updates their details, and deactivates them when they leave the
 * group or the tenant. That replaces polling Microsoft Graph - the directory
 * tells us, rather than us asking.
 *
 * Two things this deliberately does **not** do:
 *
 *  - **Roles.** Nothing Entra sends grants agent or administrator access.
 *    Provisioned accounts arrive as plain users and are promoted inside the
 *    application, under Admin -> Users. A SCIM payload claiming a role is
 *    ignored rather than refused, because refusing would quarantine the whole
 *    provisioning job over something that is simply not our model.
 *  - **Deletion.** By default a SCIM DELETE disables the account instead of
 *    removing it, because tickets reference their requester. Removing the row
 *    would either fail or take the ticket history with it.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

/** The issuer recorded for SCIM-provisioned accounts. */
export const SCIM_ISSUER = 'urn:helpdesk:scim';

/** A SCIM failure, carrying the status and scimType the spec expects. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
    this.name = 'ScimError';
  }
}

// ---------------------------------------------------------------------------
// The bearer token
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Issues a new token, returning it once.
 *
 * Only the SHA-256 is stored. The token is 256 bits of randomness, so a plain
 * digest is the right choice here - there is nothing to brute-force, and a
 * slow hash would only add latency to every provisioning request.
 */
export async function generateScimToken(actorId: string | null): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await updateSettings(
    {
      scim: {
        enabled: true,
        tokenHash: hashToken(token),
        tokenHint: token.slice(-4),
        tokenSetAt: nowIso(),
      },
    },
    actorId,
  );
  audit({ action: 'scim.token.generated', actorId });
  log.info('a new SCIM bearer token was generated');
  return token;
}

export async function revokeScimToken(actorId: string | null): Promise<void> {
  await updateSettings(
    { scim: { enabled: false, tokenHash: '', tokenHint: '', tokenSetAt: null } },
    actorId,
  );
  audit({ action: 'scim.token.revoked', actorId });
  log.warn('the SCIM bearer token was revoked');
}

/** Constant-time check of the presented bearer token. */
export function tokenIsValid(presented: string | undefined): boolean {
  const scim = settings().scim;
  if (!scim.enabled || scim.tokenHash === '' || !presented) return false;
  return safeEqual(hashToken(presented), scim.tokenHash);
}

// ---------------------------------------------------------------------------
// Resource representation
// ---------------------------------------------------------------------------

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  displayName: string;
  name: { givenName?: string; familyName?: string; formatted: string };
  emails: { value: string; type: string; primary: boolean }[];
  active: boolean;
  meta: { resourceType: string; created: string; lastModified: string; location: string };
}

export function toScimUser(row: UserRow, baseUrl: string): ScimUser {
  // The directory's own name back, not the one a format built from it -
  // otherwise Entra would see a change on every cycle and send it again.
  const source = row.display_name_source || row.display_name;
  const parts = source.trim().split(/\s+/);
  const givenName = row.first_name || (parts.length > 1 ? parts.slice(0, -1).join(' ') : source);
  const familyName = row.last_name || (parts.length > 1 ? parts[parts.length - 1]! : '');

  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.upn ?? row.email,
    displayName: source,
    name: { givenName, familyName, formatted: source },
    emails: [{ value: row.email, type: 'work', primary: true }],
    active: row.status === 'active',
    meta: {
      resourceType: 'User',
      created: row.created_at,
      lastModified: row.updated_at,
      location: baseUrl + '/Users/' + row.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading the payloads Entra sends
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * `active` arrives as a boolean from the spec and as the strings "True" and
 * "False" from Entra's PATCH payloads. Both have to be understood.
 */
function readActive(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const folded = value.trim().toLowerCase();
    if (folded === 'true') return true;
    if (folded === 'false') return false;
  }
  return undefined;
}

export interface ScimUserInput {
  externalId?: string;
  userName?: string;
  displayName?: string;
  email?: string;
  active?: boolean;
  /**
   * Attributes a user group's rules read.
   *
   * `title` is a core SCIM attribute; `department` lives in the enterprise
   * extension, which Entra sends under its full schema URN. They describe the
   * person and grant nothing - a rule using them decides who may *read* a
   * ticket, never what anyone may do.
   */
  department?: string;
  jobTitle?: string;
  phone?: string;
  office?: string;
  /** name.givenName / name.familyName, and the enterprise extension's organization. */
  firstName?: string;
  lastName?: string;
  company?: string;
  /** extensionAttribute1-3, from whichever schema the tenant maps them under. */
  extension1?: string;
  extension2?: string;
  extension3?: string;
  /** The enterprise extension's manager: the SCIM id (ours) of the manager, '' when removed. */
  managerId?: string;
}

/**
 * extensionAttributeN wherever a tenant put it: at the top level, in the
 * enterprise extension, or in a custom extension schema of its own naming
 * (Entra's attribute mapping lets an administrator pick the target URN).
 */
function readExtension(body: Json, n: 1 | 2 | 3): string | undefined {
  const key = 'extensionAttribute' + n;
  const direct = str(body[key]);
  if (direct !== undefined) return direct;
  for (const [name, value] of Object.entries(body)) {
    if (name.startsWith('urn:') && value && typeof value === 'object' && !Array.isArray(value)) {
      const found = str((value as Json)[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The enterprise extension's URN, as Entra spells it. */
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

export function readScimUser(body: Json): ScimUserInput {
  const name = (body.name ?? {}) as Json;
  const emails = Array.isArray(body.emails) ? (body.emails as Json[]) : [];
  // Entra sends a work address; fall back to the first with a value, then to
  // userName, which is a UPN and therefore address-shaped.
  const primary =
    emails.find((e) => e.primary === true) ??
    emails.find((e) => str(e.type)?.toLowerCase() === 'work') ??
    emails[0];

  const assembled = [str(name.givenName), str(name.familyName)].filter(Boolean).join(' ');

  const input: ScimUserInput = {};
  const externalId = str(body.externalId);
  if (externalId) input.externalId = externalId;
  const userName = str(body.userName);
  if (userName) input.userName = userName;
  const displayName = str(body.displayName) ?? str(name.formatted) ?? (assembled || undefined);
  if (displayName) input.displayName = displayName;
  const email = str(primary?.value) ?? userName;
  if (email) input.email = email;
  const active = readActive(body.active);
  if (active !== undefined) input.active = active;
  const firstName = str(name.givenName);
  if (firstName) input.firstName = firstName;
  const lastName = str(name.familyName);
  if (lastName) input.lastName = lastName;

  // The enterprise extension, when the tenant maps it. Absent is normal, and
  // then these stay empty rather than being guessed at.
  // Two shapes: nested ({ "urn:...:User": { organization } }) as on a create,
  // or flat keys ("urn:...:User:organization") as Entra sends in a PATCH
  // without a path. Both are read, so a company set later is not lost.
  const enterprise: Json = { ...((body[ENTERPRISE] ?? {}) as Json) };
  for (const [k, v] of Object.entries(body)) {
    if (k.toLowerCase().startsWith(ENTERPRISE.toLowerCase() + ':')) enterprise[k.slice(ENTERPRISE.length + 1)] = v;
  }
  const manager = enterprise.manager;
  const managerId = str(manager) ?? str((manager as Json | undefined)?.value);
  if (managerId) input.managerId = managerId;
  const department = str(enterprise.department) ?? str(body.department);
  if (department) input.department = department;
  // Entra maps companyName to the enterprise extension's organization by
  // default; a custom mapping may send companyName or company instead.
  const company = str(enterprise.organization) ?? str(body.companyName) ?? str(body.company);
  if (company) input.company = company;
  const jobTitle = str(body.title) ?? str(enterprise.title);
  if (jobTitle) input.jobTitle = jobTitle;
  // Entra's default maps physicalDeliveryOfficeName to the work address's
  // `formatted`; locality (the city) is the fallback it always was.
  const addresses = Array.isArray(body.addresses) ? (body.addresses as Json[]) : [];
  const address = addresses.find((a) => a.type === 'work') ?? addresses[0];
  const office = str(body.office) ?? str(address?.formatted) ?? str(address?.locality);
  if (office) input.office = office;
  const phones = Array.isArray(body.phoneNumbers) ? (body.phoneNumbers as Json[]) : [];
  const phone = phones.find((p) => p.type === 'work') ?? phones.find((p) => p.primary === true) ?? phones[0];
  const phoneValue = str(phone?.value);
  if (phoneValue) input.phone = phoneValue;
  const e1 = readExtension(body, 1);
  if (e1 !== undefined) input.extension1 = e1;
  const e2 = readExtension(body, 2);
  if (e2 !== undefined) input.extension2 = e2;
  const e3 = readExtension(body, 3);
  if (e3 !== undefined) input.extension3 = e3;

  return input;
}

/**
 * Applies a PATCH.
 *
 * Entra uses two shapes: an operation with a `path` and a scalar value, and an
 * operation with no path and an object of attributes. Both appear in practice,
 * and the `op` is capitalised inconsistently.
 */
export function applyScimPatch(body: Json): ScimUserInput {
  const operations = Array.isArray(body.Operations)
    ? (body.Operations as Json[])
    : Array.isArray(body.operations)
      ? (body.operations as Json[])
      : [];
  if (operations.length === 0) {
    throw new ScimError(400, 'The patch carried no operations.', 'invalidSyntax');
  }

  const result: ScimUserInput = {};
  for (const operation of operations) {
    const op = str(operation.op)?.toLowerCase() ?? 'replace';
    if (op === 'remove') {
      // The only removal worth honouring is of `active`, which means the same
      // as setting it false. Anything else is ignored rather than refused.
      if (str(operation.path)?.toLowerCase() === 'active') result.active = false;
      // A manager removed in the directory is removed here.
      if (/(?:^|:)manager$/i.test(str(operation.path) ?? '')) result.managerId = '';
      continue;
    }

    const path = str(operation.path);
    if (path) {
      const key = path.toLowerCase().replace(/^urn:[^:]+:[^:]+:[^:]+:[^:]+:[^:]+:/i, '');
      const value = operation.value;
      if (key === 'active') {
        const active = readActive(value);
        if (active !== undefined) result.active = active;
      } else if (key === 'username') {
        const userName = str(value);
        if (userName) result.userName = userName;
      } else if (key === 'displayname') {
        const displayName = str(value);
        if (displayName) result.displayName = displayName;
      } else if (key === 'externalid') {
        const externalId = str(value);
        if (externalId) result.externalId = externalId;
      } else if (key.startsWith('emails')) {
        const email = Array.isArray(value) ? str((value[0] as Json)?.value) : str(value);
        if (email) result.email = email;
      } else if (key === 'name.givenname') {
        result.firstName = str(value) ?? '';
      } else if (key === 'name.familyname') {
        result.lastName = str(value) ?? '';
      } else if (key === 'name' && value && typeof value === 'object') {
        const n = value as Json;
        if (n.givenName !== undefined) result.firstName = str(n.givenName) ?? '';
        if (n.familyName !== undefined) result.lastName = str(n.familyName) ?? '';
      } else if (/(?:^|:)organization$/.test(key) || key === 'companyname' || key === 'company') {
        // The enterprise extension's organization, whatever its URN prefix.
        result.company = str(value) ?? '';
      } else if (/(?:^|:)manager$/.test(key)) {
        // Entra sends the manager's id as a plain value or as { value }.
        result.managerId = str(value) ?? str((value as Json | null)?.value) ?? '';
      } else if (/(?:^|:)department$/.test(key)) {
        result.department = str(value) ?? '';
      } else if (key === 'title') {
        result.jobTitle = str(value) ?? '';
      } else if (key.startsWith('phonenumbers')) {
        // phoneNumbers[type eq "work"].value as Entra sends it; mobile only
        // when nothing else is known, so it never replaces the desk number.
        const phone = Array.isArray(value) ? str((value[0] as Json)?.value) : str(value);
        if (!/mobile/.test(key) || result.phone === undefined) result.phone = phone ?? '';
      } else if (key.startsWith('addresses') && /formatted$/.test(key)) {
        result.office = str(value) ?? '';
      } else if (key === 'office') {
        result.office = str(value) ?? '';
      }
      // Any other path - roles included - is deliberately ignored.
      continue;
    }

    // No path: the value is an object of attributes.
    if (operation.value && typeof operation.value === 'object') {
      Object.assign(result, readScimUser(operation.value as Json));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface ScimFilter {
  attribute: 'userName' | 'externalId' | 'email';
  value: string;
}

/**
 * Parses the small subset of SCIM filter syntax Entra actually sends:
 * `userName eq "x"`, `externalId eq "x"`, `emails.value eq "x"`.
 *
 * Anything else is refused with `invalidFilter` rather than silently matching
 * everything, which would hand the caller the whole directory.
 */
export function parseScimFilter(filter: string): ScimFilter {
  const match = /^\s*([A-Za-z.]+)\s+eq\s+"([^"]*)"\s*$/.exec(filter);
  if (!match) {
    throw new ScimError(400, 'Only simple "attribute eq value" filters are supported.', 'invalidFilter');
  }
  const [, rawAttribute, value] = match;
  const attribute = rawAttribute!.toLowerCase();
  if (attribute === 'username') return { attribute: 'userName', value: value! };
  if (attribute === 'externalid') return { attribute: 'externalId', value: value! };
  if (attribute === 'emails.value' || attribute === 'email') {
    return { attribute: 'email', value: value! };
  }
  throw new ScimError(400, 'Filtering on ' + rawAttribute + ' is not supported.', 'invalidFilter');
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * The issuers an Entra sign-in to this tenant records (v2.0 and v1 tokens).
 * Nothing else can carry them: the sign-in refuses a token from any other
 * tenant.
 */
export function tenantIssuers(): string[] {
  const tenant = settings().oidc.tenantId;
  if (!tenant || !settings().ssoConfigured) return [];
  return ['https://login.microsoftonline.com/' + tenant + '/v2.0', 'https://sts.windows.net/' + tenant + '/'];
}

/**
 * What SCIM may see: the accounts it provisioned, and the accounts this
 * tenant's directory brought by signing in (asked for 18 Oct 2026). Entra
 * pairs before it creates - it asks for userName and links what it finds -
 * so leaving a signed-in account out made it create one, and the address
 * clashed (SystemForCrossDomainIdentityManagementServiceIncompatibleFiltering).
 * A password account, or one from Google, Okta or another provider, stays
 * out of reach: the directory does not own those.
 */
function scope(): { sql: string; params: string[] } {
  const issuers = [SCIM_ISSUER, ...tenantIssuers()];
  return { sql: ' WHERE issuer IN (' + issuers.map(() => '?').join(', ') + ')', params: issuers };
}

/** An account that signed in through Entra before SCIM knew it: its object id stays what the sign-in recorded. */
const signedInFirst = (row: UserRow) => row.issuer !== SCIM_ISSUER;

export function findScimUser(id: string): Promise<UserRow | undefined> {
  const { sql, params } = scope();
  return queryOne<UserRow>('SELECT * FROM users' + sql + ' AND id = ?', [...params, id]);
}

export async function findByFilter(filter: ScimFilter): Promise<UserRow[]> {
  const { sql, params } = scope();
  if (filter.attribute === 'externalId') {
    return query<UserRow>('SELECT * FROM users' + sql + ' AND external_id = ?', [...params, filter.value]);
  }
  if (filter.attribute === 'email') {
    return query<UserRow>('SELECT * FROM users' + sql + ' AND email = ?', [...params, normaliseEmail(filter.value)]);
  }
  // userName is the UPN, which falls back to the address for accounts that
  // have none.
  return query<UserRow>(
    'SELECT * FROM users' + sql + ' AND (lower(upn) = ? OR email = ?)',
    [...params, filter.value.toLowerCase(), normaliseEmail(filter.value)],
  );
}

export async function listScimUsers(startIndex: number, count: number): Promise<UserRow[]> {
  const { sql, params } = scope();
  return query<UserRow>(
    'SELECT * FROM users' + sql + ' ORDER BY created_at, id LIMIT ? OFFSET ?',
    [...params, count, Math.max(startIndex - 1, 0)],
  );
}

export async function countScimUsers(): Promise<number> {
  const { sql, params } = scope();
  const row = await queryOne<{ c: number }>('SELECT count(*) AS c FROM users' + sql, params);
  return row?.c ?? 0;
}

export async function createScimUser(input: ScimUserInput): Promise<UserRow> {
  const email = normaliseEmail(input.email ?? input.userName ?? '');
  if (!email || !email.includes('@')) {
    throw new ScimError(400, 'A userName or work email address is required.', 'invalidValue');
  }

  // An address already in use is a conflict whoever owns it: SCIM needs a
  // 409 so Entra marks the one user rather than failing the whole job.
  const clash = await queryOne<{ id: string; issuer: string }>(
    'SELECT id, issuer FROM users WHERE email = ?',
    [email],
  );
  if (clash) {
    throw new ScimError(409, 'An account with that address already exists.', 'uniqueness');
  }
  if (input.externalId) {
    const bound = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE issuer = ? AND external_id = ?',
      [SCIM_ISSUER, input.externalId],
    );
    if (bound) {
      throw new ScimError(409, 'That directory object is already provisioned.', 'uniqueness');
    }
  }

  const id = newId();
  const now = nowIso();
  const displayName = normaliseLine(input.displayName ?? email.split('@')[0] ?? email).slice(0, 120);

  await execute(
    `INSERT INTO users
       (id, issuer, external_id, email, upn, display_name, role, role_locked, status,
        source, directory_present, department, job_title, office, phone,
        extension_attribute_1, extension_attribute_2, extension_attribute_3,
        display_name_source, first_name, last_name, company,
        last_login_at, last_synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'sync', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      id,
      SCIM_ISSUER,
      input.externalId ?? null,
      email,
      input.userName ?? null,
      displayName,
      // Never from the payload. Roles are assigned in the application.
      INITIAL_ROLE,
      input.active === false ? 'disabled' : 'active',
      // These describe the person, so the directory is welcome to them.
      sealText((input.department ?? '').slice(0, 120)),
      sealText((input.jobTitle ?? '').slice(0, 120)),
      sealText((input.office ?? '').slice(0, 120)),
      sealText((input.phone ?? '').slice(0, 40)),
      sealText((input.extension1 ?? '').slice(0, 200)),
      sealText((input.extension2 ?? '').slice(0, 200)),
      sealText((input.extension3 ?? '').slice(0, 200)),
      displayName,
      (input.firstName ?? '').slice(0, 100),
      (input.lastName ?? '').slice(0, 100),
      (input.company ?? '').slice(0, 120),
      now,
      now,
      now,
    ],
  );
  await applyDisplayName(id);
  if (input.managerId) await applyScimManager(id, input.managerId);

  audit({
    action: 'scim.user.created',
    targetType: 'user',
    targetId: id,
    actorEmail: email,
    detail: { externalId: input.externalId ?? null, role: INITIAL_ROLE },
  });
  log.info({ userId: id, email }, 'SCIM provisioned an account');

  const created = await findScimUser(id);
  if (!created) throw new ScimError(500, 'The account could not be read back after creation.');
  return created;
}

export async function updateScimUser(
  existing: UserRow,
  input: ScimUserInput,
  { replace }: { replace: boolean },
): Promise<UserRow> {
  const email = input.email ? normaliseEmail(input.email) : undefined;
  if (email && email !== existing.email) {
    const clash = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email = ? AND id <> ?',
      [email, existing.id],
    );
    if (clash) {
      throw new ScimError(409, 'Another account already uses that address.', 'uniqueness');
    }
  }

  // PUT replaces the resource, so an absent `active` means true. PATCH only
  // carries what changed, so an absent `active` means "leave it".
  const active = input.active ?? (replace ? true : existing.status === 'active');
  const now = nowIso();

  await execute(
    `UPDATE users SET
        external_id    = COALESCE(?, external_id),
        email          = ?,
        upn            = COALESCE(?, upn),
        display_name   = ?,
        display_name_source = ?,
        first_name     = ?,
        last_name      = ?,
        company        = ?,
        status         = ?,
        department     = ?,
        job_title      = ?,
        office         = ?,
        phone          = ?,
        extension_attribute_1 = ?,
        extension_attribute_2 = ?,
        extension_attribute_3 = ?,
        last_synced_at = ?,
        updated_at     = ?
      WHERE id = ?`,
    [
      signedInFirst(existing) ? null : (input.externalId ?? null),
      email ?? existing.email,
      input.userName ?? null,
      input.displayName ? normaliseLine(input.displayName).slice(0, 120) : existing.display_name,
      input.displayName ? normaliseLine(input.displayName).slice(0, 120) : existing.display_name_source,
      input.firstName !== undefined ? input.firstName.slice(0, 100) : existing.first_name,
      input.lastName !== undefined ? input.lastName.slice(0, 100) : existing.last_name,
      input.company !== undefined ? input.company.slice(0, 120) : existing.company,
      active ? 'active' : 'disabled',
      // A PATCH that does not mention them must not blank them, so an absent
      // value keeps what is stored.
      sealText(input.department !== undefined ? input.department.slice(0, 120) : existing.department),
      sealText(input.jobTitle !== undefined ? input.jobTitle.slice(0, 120) : existing.job_title),
      sealText(input.office !== undefined ? input.office.slice(0, 120) : existing.office),
      sealText(input.phone !== undefined ? input.phone.slice(0, 40) : existing.phone),
      sealText(input.extension1 !== undefined ? input.extension1.slice(0, 200) : existing.extension_attribute_1),
      sealText(input.extension2 !== undefined ? input.extension2.slice(0, 200) : existing.extension_attribute_2),
      sealText(input.extension3 !== undefined ? input.extension3.slice(0, 200) : existing.extension_attribute_3),
      now,
      now,
      existing.id,
    ],
  );

  // Which attributes the directory sent - names only - so "why is the
  // company empty?" has an answer in the audit trail.
  const sent = (Object.keys(input) as (keyof ScimUserInput)[]).filter((k) => input[k] !== undefined);
  if (sent.length > 0) {
    audit({ action: 'scim.user.updated', targetType: 'user', targetId: existing.id, actorEmail: existing.email, detail: { attributes: sent } });
  }

  if (active !== (existing.status === 'active')) {
    audit({
      action: active ? 'scim.user.activated' : 'scim.user.deactivated',
      targetType: 'user',
      targetId: existing.id,
      actorEmail: existing.email,
    });
    log.info({ userId: existing.id, active }, 'SCIM changed an account status');
  }

  await applyDisplayName(existing.id);
  if (input.managerId !== undefined) await applyScimManager(existing.id, input.managerId);
  const updated = await findScimUser(existing.id);
  if (!updated) throw new ScimError(500, 'The account could not be read back after the update.');
  return updated;
}

/**
 * Handles a SCIM DELETE.
 *
 * Disabling rather than deleting is the default and the right one: tickets
 * reference their requester with ON DELETE RESTRICT, so a real delete would
 * either fail for anyone who has used the service or take their history with
 * them. An administrator who genuinely wants the row gone can remove it under
 * Admin -> Users.
 */
export async function deleteScimUser(existing: UserRow): Promise<void> {
  if (settings().scim.disableOnDelete) {
    await execute(
      "UPDATE users SET status = 'disabled', directory_present = 0, updated_at = ? WHERE id = ?",
      [nowIso(), existing.id],
    );
    audit({
      action: 'scim.user.deactivated',
      targetType: 'user',
      targetId: existing.id,
      actorEmail: existing.email,
      detail: { reason: 'scim_delete' },
    });
    return;
  }

  const used = await queryOne<{ c: number }>(
    'SELECT count(*) AS c FROM tickets WHERE requester_id = ? OR assignee_id = ?',
    [existing.id, existing.id],
  );
  if ((used?.c ?? 0) > 0) {
    // Falling back to disabling rather than failing: a provisioning job that
    // errors here would retry for ever on an account that can never be
    // removed.
    await execute(
      "UPDATE users SET status = 'disabled', directory_present = 0, updated_at = ? WHERE id = ?",
      [nowIso(), existing.id],
    );
    audit({
      action: 'scim.user.deactivated',
      targetType: 'user',
      targetId: existing.id,
      detail: { reason: 'has_tickets' },
    });
    return;
  }

  await execute('DELETE FROM users WHERE id = ?', [existing.id]);
  audit({ action: 'scim.user.deleted', targetType: 'user', targetId: existing.id });
  log.info({ userId: existing.id }, 'SCIM removed an account');
}

/**
 * The manager the directory names, by our own SCIM id (services/teams.ts).
 * One not provisioned yet, or a loop, is left alone rather than refusing the
 * whole update: Entra sends the manager again on its next cycle.
 */
async function applyScimManager(userId: string, managerId: string): Promise<void> {
  if (managerId && !(await findScimUser(managerId).catch(() => undefined))) return;
  try {
    await setManager(userId, managerId || null, null);
  } catch (err) {
    log.warn({ userId, err: (err as Error).message }, 'SCIM manager not applied');
  }
}
