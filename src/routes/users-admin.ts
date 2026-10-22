import { cleanDomains } from '../auth/registration.js';
import { listMailboxes } from '../services/mail/mailboxes.js';
import { anyRelayReady } from '../services/mail/relay.js';
import { SELF_EDIT_LABELS } from './profile.js';
import { SELF_EDIT_FIELDS } from '../settings/index.js';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { normaliseLine } from '../lib/util.js';
import { NAME_VARIABLES, applyAllDisplayNames, buildDisplayName, formatProblem, setSourceName } from '../services/display-names.js';
import { allowOwnScripts, writeLimiter } from '../middleware/security.js';
import { assertCsrfToken } from '../middleware/csrf.js';
import { config } from '../config.js';
import { count } from '../db/index.js';
import { settings, updateSettings } from '../settings/index.js';
import { flash } from '../middleware/view-locals.js';
import { sessionStore } from '../auth/session-store.js';
import { erasureFootprint, eraseUser } from '../services/erasure.js';
import { addressAllowed, parseRange } from '../auth/conditional-access.js';
import { notifyPerson } from '../services/mail/outbox.js';
import {
  countAdmins,
  findUserById,
  isStaff,
  listUsers,
  userColumnValues,
  USER_SORTS,
  type UserListOptions,
  type UserKind,
  setProfileAttributes,
  setUserRole,
  setUserStatus,
} from '../services/users.js';
import {
  clearGroupsForUser,
  groupsForUser,
  listActiveGroups,
  listGroups,
  setGroupsForUser,
} from '../services/groups.js';
import { ticketActivityFor } from '../services/tickets.js';
import {
  createLocalAccount,
  deleteLocalAccount,
  findLocalAdmin,
  isLocalAccount,
  isLocalAdmin,
  localAccountStatus,
  setLocalEmail,
  setLocalPassword,
} from '../auth/local-accounts.js';
import { MIN_PASSWORD_LENGTH as MIN_PASSWORD_FLOOR, minPasswordLength, passwordPolicyText, generatePassword, passwordProblems, personOf } from '../auth/password.js';
import { attempt, type FieldErrors } from './form-errors.js';
import { managerEmailOf, setManagerByEmail } from '../services/teams.js';
import { assetsAssignedTo, assetTitle } from '../services/assets.js';
import { applyAllRules, listActiveUserGroups, listUserGroups, setUserGroupsForUser, userGroupSourcesFor, userGroupsFor } from '../services/user-groups.js';
import { applyAllTechnicianRules } from '../services/technician-rules.js';
import { settingsView } from './settings-shared.js';
import { cannotEnableCodes } from '../auth/sign-in-codes.js';
import { availabilityRouter, availabilityView, tracksAvailability, userInPath } from './availability.js';
import type { UserRow } from '../services/users.js';
import { ADMINS_IN_PORTAL, portalManagesAdmins } from '../auth/portal-admins.js';

const BREAK_GLASS_URL = '/admin/settings/users/break-glass';

/** Where one account's page is: the break-glass one has a tab of its own. */
function userUrl(user: Pick<UserRow, 'id' | 'issuer' | 'external_id'>): string {
  return isLocalAdmin(user) ? BREAK_GLASS_URL : '/admin/settings/users/' + user.id;
}
import {
  MAX_IMPORT_ROWS,
  importTemplateCsv,
  planImport,
  runImport,
  type ImportedAccount,
} from '../services/local-import.js';
import { PROVIDERS, providerConfig, providerName, type ProviderKey } from '../auth/oidc.js';
import { hasAuthenticator, removeAuthenticator } from '../auth/authenticator.js';
import { PERMISSIONS, READ, canRead, countRoleMembers, createRole, deleteRole, listRoles, roleById, roleProblems, setCustomRole, updateRole } from '../auth/permissions.js';
import { BLANK, filterParams, menuValues, readColumnFilters, type ColumnValue } from '../lib/column-filters.js';
import { roleLabel, sourceLabel, stateLabel } from '../lib/format.js';

/**
 * Users.
 *
 * Two tabs: Local users (password accounts, created here or imported from a
 * CSV file, signing in with their email address) and Entra ID (everyone who
 * arrived through the directory). They were one list once; they are split
 * because the two are managed differently - one here, one in the tenant - and
 * because local sign-in can now be switched off as a whole.
 *
 * This is also the only place a role can be set. Nothing in the directory
 * grants one.
 */
export const userAdminRouter = Router();

// The eye beside a password box (password-reveal.js) - a script of ours,
// no requests. Approved 15 Oct 2026.
userAdminRouter.use(allowOwnScripts());
// The role lists offer Administrator only while this helpdesk adds its own.
userAdminRouter.use((_req, res, next) => {
  res.locals.adminsInPortal = portalManagesAdmins() ? ADMINS_IN_PORTAL : '';
  next();
});
// Whether there is a break-glass account to show a tab for: a hosted helpdesk has none.
userAdminRouter.use((_req, res, next) => {
  findLocalAdmin()
    .then((a) => {
      res.locals.hasBreakGlass = Boolean(a);
      next();
    })
    .catch(next);
});

const uuid = z.string().uuid();
const PER_PAGE = 50;

// --- custom roles (auth/permissions.ts, 21 Oct 2026) ---------------------------------
// An administrator's only: the gate in routes/admin.ts keeps everybody else out.

function readRole(body: Record<string, unknown>) {
  const text = (k: string) => (typeof body[k] === 'string' ? String(body[k]) : '');
  const ticked = body.permissions;
  // A permission with levels posts its own choice (level_<key>: read or
  // write); one radio group each, so read only and read and write can never
  // both be chosen. The rest are tick boxes, as before.
  const levelled = PERMISSIONS.filter((p) => p.levels).flatMap((p) => {
    const chosen = text('level_' + p.key);
    return chosen === 'write' ? [p.key] : chosen === 'read' ? [p.key + READ] : [];
  });
  return {
    name: normaliseLine(text('name')).slice(0, 80),
    description: text('description').trim().slice(0, 400),
    permissions: [...(Array.isArray(ticked) ? ticked : ticked === undefined ? [] : [ticked]).map(String), ...levelled],
  };
}

async function renderRoles(res: Response, extra: { editing?: string | null; values?: ReturnType<typeof readRole>; problems?: Record<string, string>; status?: number } = {}) {
  if (extra.status) res.status(extra.status);
  res.render(
    'admin/settings/roles',
    settingsView('users', {
      sectionTitle: 'Users',
      tab: 'roles',
      entraReady: entraReady(),
      roles: listRoles(),
      members: await countRoleMembers(),
      permissions: PERMISSIONS,
      editing: extra.editing ?? null,
      values: extra.values ?? null,
      problems: extra.problems ?? {},
      openDialog: extra.problems && Object.keys(extra.problems).length ? (extra.editing ? 'role-' + extra.editing : 'new-role') : null,
    }),
  );
}

userAdminRouter.get('/roles', asyncHandler(async (_req, res) => renderRoles(res)));

userAdminRouter.post(
  '/roles',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const input = readRole((req.body ?? {}) as Record<string, unknown>);
    const problems = roleProblems(input, null);
    if (Object.keys(problems).length) {
      await renderRoles(res, { values: input, problems, status: 400 });
      return;
    }
    await createRole(input, req.currentUser!);
    flash(req, 'success', 'Role ' + input.name + ' created. Give it to people on their page.');
    res.redirect('/admin/settings/users/roles');
  }),
);

userAdminRouter.post(
  '/roles/:roleId',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.roleId);
    if (!roleById(id)) throw notFound();
    const input = readRole((req.body ?? {}) as Record<string, unknown>);
    const problems = roleProblems(input, id);
    if (Object.keys(problems).length) {
      await renderRoles(res, { editing: id, values: input, problems, status: 400 });
      return;
    }
    await updateRole(id, input, req.currentUser!);
    flash(req, 'success', 'Role ' + input.name + ' saved. Its people have the new permissions from their next page.');
    res.redirect('/admin/settings/users/roles');
  }),
);

userAdminRouter.post(
  '/roles/:roleId/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.roleId);
    const role = roleById(id);
    if (!role) throw notFound();
    const done = await attempt(() => deleteRole(id, req.currentUser!));
    if (!done.ok) {
      flash(req, 'error', Object.values(done.errors)[0] ?? 'That role could not be deleted.');
    } else {
      flash(req, 'success', 'Role ' + role.name + ' deleted.');
    }
    res.redirect('/admin/settings/users/roles');
  }),
);

const usersQuery = z.object({
  q: z.string().trim().max(200).optional(),
  // Filters. An empty value means "any", so the select's first option posts ''.
  role: z.enum(['user', 'agent', 'admin']).or(z.literal('')).optional(),
  tg: z.string().max(64).optional(),
  ug: z.string().max(64).optional(),
  // One identity provider's accounts, on the Identity providers tab.
  idp: z.enum(PROVIDERS).or(z.literal('')).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

const roleBody = z.object({ role: z.union([z.enum(['user', 'agent', 'admin']), z.string().regex(/^role:[0-9a-f-]{36}$/)]) });
const statusBody = z.object({ status: z.enum(['active', 'disabled']) });
const passwordBody = z.object({ password: z.string().max(200).optional() });

const createBody = z.object({
  displayName: z.string().trim().min(1, 'Give the account a name: a display name, or a first and last name.').max(120),
  // The sign-in name, so required.
  email: z.string().trim().email('That is not a valid email address.').max(200),
  role: z.enum(['user', 'agent', 'admin']),
  password: z.string().min(1, 'Set a password.').max(200),
});

async function load(req: { params: Record<string, unknown>; method?: string; currentUser?: UserRow | null }) {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) throw notFound('No such user.');
  const user = await findUserById(id.data);
  if (!user) throw notFound('No such user.');
  // Somebody given Users by a custom role may read an administrator's page but
  // change nothing on it: a password, an address or an authenticator set here
  // is a way into that administrator's account (review, 21 Oct 2026).
  if (req.method && req.method !== 'GET' && req.currentUser?.role !== 'admin' && (user.role === 'admin' || isLocalAdmin(user))) {
    throw forbidden("Only an administrator changes an administrator's account.", 'not_admin');
  }
  return user;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

const TAB_URL: Record<UserKind, string> = {
  local: '/admin/settings/users',
  directory: '/admin/settings/users/entra',
};

interface ListExtras {
  values?: Record<string, unknown>;
  errors?: FieldErrors;
  openDialog?: string | null;
  importProblems?: string[];
  imported?: ImportedAccount[] | null;
  skipped?: string[];
}

/**
 * The Identity providers tab, separated by provider (asked for 18 Oct 2026):
 * each one that is configured, or that accounts here came from, with how
 * many there are. An account is placed by its issuer (providerOfIssuer).
 */
async function providerTabs(): Promise<{ key: ProviderKey; name: string; count: number }[]> {
  const tabs: { key: ProviderKey; name: string; count: number }[] = [];
  for (const key of PROVIDERS) {
    const { total } = await listUsers({ kind: 'directory', provider: key, limit: 1, offset: 0 });
    if (total > 0 || providerConfig(key).configured) tabs.push({ key, name: providerName(key), count: total });
  }
  return tabs;
}

/** Either tab of the list. Every render of it goes through here. */
async function renderList(
  req: Request,
  res: Response,
  kind: UserKind,
  extra: ListExtras = {},
  status?: number,
): Promise<void> {
  const parsed = usersQuery.safeParse(req.method === 'GET' ? req.query : {});
  const filters = parsed.success ? parsed.data : usersQuery.parse({});

  // Excel-like headers (lib/column-filters.ts): sort any column, filter by values.
  const raw = (req.method === 'GET' ? req.query : {}) as Record<string, unknown>;
  const columns = readColumnFilters(raw, ['role', 'tgroups', 'ugroups', 'status', 'source']);
  const sort = typeof raw.sort === 'string' && USER_SORTS[raw.sort] ? raw.sort : undefined;
  const dir = raw.dir === 'desc' ? 'desc' : raw.dir === 'asc' ? 'asc' : undefined;
  const listOptions: UserListOptions = {
    ...(filters.q ? { search: filters.q } : {}),
    ...(filters.role ? { role: filters.role } : {}),
    ...(filters.tg ? { technicianGroupId: filters.tg } : {}),
    ...(filters.ug ? { userGroupId: filters.ug } : {}),
    ...(kind === 'directory' && filters.idp ? { provider: filters.idp } : {}),
    kind,
    columns,
    ...(sort ? { sort, ...(dir ? { dir } : {}) } : {}),
  };
  const { rows, total } = await listUsers({ ...listOptions, limit: PER_PAGE, offset: (filters.page - 1) * PER_PAGE });
  const menuKeys = ['role', 'tgroups', 'ugroups', 'status', 'source'];
  const menuRows = await Promise.all(menuKeys.map((key) => userColumnValues(listOptions, key)));
  const labelFor: Record<string, (v: string, fallback: string) => string> = {
    role: (v) => roleLabel(v),
    status: (v) => stateLabel(v),
    source: (v) => sourceLabel(v),
    tgroups: (v, fallback) => (v === BLANK ? 'None' : fallback),
    ugroups: (v, fallback) => (v === BLANK ? 'None' : fallback),
  };
  const columnMenus: Record<string, { values: ColumnValue[]; selected: string[] }> = {};
  menuKeys.forEach((key, i) => {
    const rowsFor = menuRows[i]!.map((r) => ({ ...r, label: labelFor[key]!(r.value, r.label || r.value) }));
    columnMenus[key] = { values: menuValues(rowsFor, columns[key] ?? [], (v) => labelFor[key]!(v, v)), selected: columns[key] ?? [] };
  });
  const listState = {
    q: filters.q, role: filters.role, tg: filters.tg, ug: filters.ug, idp: filters.idp,
    sort, dir, ...filterParams(columns),
  };

  // One round trip per page of users rather than per user.
  const users = await Promise.all(
    rows.map(async (user) => ({
      ...user,
      groups: await groupsForUser(user.id),
      userGroups: await userGroupsFor(user.id),
      isLocal: isLocalAccount(user),
      isProtected: isLocalAdmin(user),
    })),
  );

  // For the filter selects. Retired groups too: you may want to find who is
  // still in one.
  const [technicianGroups, allUserGroups] = await Promise.all([listGroups(), listUserGroups()]);
  // The paging links keep the filters.
  const keep = new URLSearchParams();
  if (filters.q) keep.set('q', filters.q);
  if (filters.role) keep.set('role', filters.role);
  if (filters.tg) keep.set('tg', filters.tg);
  if (filters.ug) keep.set('ug', filters.ug);
  if (filters.idp) keep.set('idp', filters.idp);
  if (sort) keep.set('sort', sort);
  if (dir) keep.set('dir', dir);
  for (const [k, values] of Object.entries(filterParams(columns))) for (const v of values) keep.append(k, v);

  if (status) res.status(status);
  res.render(
    'admin/settings/users',
    settingsView('users', {
      kind,
      listUrl: TAB_URL[kind],
      technicianGroups,
      allUserGroups,
      filterQuery: keep.toString(),
      filtering: Boolean(filters.q || filters.role || filters.tg || filters.ug || Object.keys(columns).length),
      columnMenus,
      columnFilters: columns,
      listState,
      // A tab per provider that is set up or already has accounts here.
      providerTabs: kind === 'directory' ? await providerTabs() : [],
      users,
      total,
      filters,
      pageCount: Math.max(Math.ceil(total / PER_PAGE), 1),
      minPasswordLength: minPasswordLength(), passwordPolicy: passwordPolicyText(),
      suggestion: generatePassword(),
      // Directory accounts exist only once Entra ID is connected, so until
      // then the tab is shown but cannot be opened.
      entraReady: entraReady(),
      codes: {
        enabled: settings().localAccounts.otpEnabled,
        excludedGroupId: settings().localAccounts.otpExcludedGroupId,
      },
      localSignIn: {
        enabled: settings().localAccounts.signInEnabled,
        // On only because the environment says so; the switch cannot win.
        forced: config.forceLocalSignIn,
      },
      maxImportRows: MAX_IMPORT_ROWS,
      // Whether there is anything to send a temporary password with: a
      // mailbox, or a relay. Without one the switch is shown disabled with
      // the reason rather than hidden.
      canMailPasswords: (await listMailboxes()).some((m) => m.is_active) || (await anyRelayReady()),
      values: extra.values ?? {},
      errors: extra.errors ?? {},
      openDialog: extra.openDialog ?? null,
      importProblems: extra.importProblems ?? [],
      imported: extra.imported ?? null,
      skipped: extra.skipped ?? [],
    }),
  );
}

userAdminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    await renderList(req, res, 'local');
  }),
);

/** Entra ID is connected: sign-in configured, or SCIM pushing accounts. */
function entraReady(): boolean {
  const current = settings();
  return current.anySsoConfigured || current.scim.enabled;
}

// ---------------------------------------------------------------------------
// Other settings: how a display name is built
// ---------------------------------------------------------------------------

const OTHER_URL = '/admin/settings/users/other';

/** A sample person, so the page can show what the format makes of a name. */
const SAMPLE_PERSON = {
  first_name: 'Emma', last_name: 'Wilson', company: 'Contoso', department: 'Finance', job_title: 'Accountant',
  office: 'London', email: 'emma.wilson@contoso.com', display_name_source: 'Emma Wilson',
};

async function renderOther(
  req: Request,
  res: Response,
  extra: {
    status?: number;
    error?: string;
    format?: string;
    policyError?: string;
    accessError?: string;
    accessRanges?: string;
    breakGlassRanges?: string;
  } = {},
): Promise<void> {
  const format = extra.format ?? settings().people.displayNameFormat;
  const allUserGroups = await listUserGroups();
  const usable = !formatProblem(format);
  if (extra.status) res.status(extra.status);
  res.render(
    'admin/settings/users-other',
    settingsView('users', {
      sectionTitle: 'Users',
      tab: 'other',
      entraReady: entraReady(),
      format,
      variables: NAME_VARIABLES,
      error: extra.error ?? '',
      // Sign in with a code sent by email (moved here from Local users).
      codes: {
        enabled: settings().localAccounts.otpEnabled,
        excludedGroupId: settings().localAccounts.otpExcludedGroupId,
        excludedGroupName: allUserGroups.find((g) => g.id === settings().localAccounts.otpExcludedGroupId)?.name ?? '',
      },
      allUserGroups,
      registration: settings().localAccounts.registration ?? { enabled: false, domains: [] },
      selfEdit: settings().people.selfEdit,
      selfEditLabels: SELF_EDIT_LABELS,
      directory: settings().people.directory,
      access: settings().localAccounts.conditionalAccess,
      /*
       * The address this request came from, as the service desk reads it -
       * which is not what a "what is my IP" page shows when the browser is
       * on localhost, or behind a proxy whose headers are not trusted.
       * Without it the setting cannot be tested: ranges were typed from a
       * public address while the server saw ::1, and the code step then
       * appeared to fire for no reason (reported 16 Oct 2026).
       */
      yourAddress: req.ip ?? '',
      yourAddressAllowed: addressAllowed(req.ip, settings().localAccounts.conditionalAccess.allowedRanges),
      breakGlassAllowed: addressAllowed(req.ip, settings().localAccounts.conditionalAccess.breakGlassRanges),
      accessError: extra.accessError ?? '',
      // What was typed, so a refusal does not lose it.
      accessRanges: extra.accessRanges,
      breakGlassRanges: extra.breakGlassRanges,
      policy: settings().localAccounts.passwordPolicy,
      policyFloor: MIN_PASSWORD_FLOOR,
      policyText: passwordPolicyText(),
      policyError: extra.policyError ?? '',
      examples: usable && format.trim()
        ? [
            buildDisplayName(SAMPLE_PERSON, format),
            buildDisplayName({ ...SAMPLE_PERSON, company: '', department: '', first_name: 'Peter', last_name: 'Fisher', email: 'peter@contoso.com' }, format),
            ...(req.currentUser ? [buildDisplayName(req.currentUser, format)] : []),
          ]
        : [],
    }),
  );
}

userAdminRouter.get(
  '/other',
  asyncHandler(async (req, res) => {
    await renderOther(req, res);
  }),
);

userAdminRouter.post(
  '/other',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const format = typeof raw.displayNameFormat === 'string' ? raw.displayNameFormat.replace(/[\r\n\t]+/g, ' ').trim() : '';
    const problem = formatProblem(format);
    if (problem) {
      await renderOther(req, res, { status: 400, error: problem, format });
      return;
    }
    await updateSettings({ people: { displayNameFormat: format } }, req.currentUser?.id ?? null);
    const changed = await applyAllDisplayNames();
    auditRequest(req, { action: 'settings.display_name_format.changed', targetType: 'settings', detail: { format, changed } });
    flash(req, 'success', (format ? 'Display name format saved. ' : 'Display name format removed. ') + changed + ' name' + (changed === 1 ? '' : 's') + ' changed.');
    res.redirect(OTHER_URL);
  }),
);

/** Users - Other settings - Let people register (auth/registration.ts). */
userAdminRouter.post(
  '/other/registration',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const enabled = raw.enabled === 'on';
    const domains = cleanDomains(typeof raw.domains === 'string' ? raw.domains : '');
    // The confirmation is a mail: without a way to send one, nobody could finish.
    if (enabled && (await listMailboxes()).length === 0 && !(await anyRelayReady())) {
      flash(req, 'error', 'People confirm their address by email. Add a mailbox or set up an SMTP relay under Mail first.', 'registration');
      res.redirect(OTHER_URL + '#registration');
      return;
    }
    await updateSettings({ localAccounts: { registration: { enabled, domains } } }, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.registration.changed', targetType: 'settings', detail: { enabled, domains } });
    flash(req, 'success', enabled ? 'People can create their own account' + (domains.length ? ' with an address at ' + domains.join(', ') : '') + '.' : 'Registration is off.', 'registration');
    res.redirect(OTHER_URL + '#registration');
  }),
);

/**
 * Users - Other settings - conditional access for password accounts.
 *
 * The ranges are validated here, where somebody can fix a typo, rather than
 * at sign-in where a bad line would quietly match nothing - and the same
 * parser decides both, so the page and the gate cannot disagree.
 */
userAdminRouter.post(
  '/other/access',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const asLines = (value: unknown): string[] =>
      String(typeof value === 'string' ? value : '')
        .split(/[\r\n,]+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 100);

    const typed = typeof raw.allowedRanges === 'string' ? raw.allowedRanges : '';
    const typedBreakGlass = typeof raw.breakGlassRanges === 'string' ? raw.breakGlassRanges : '';
    const lines = asLines(typed);
    const breakGlassLines = asLines(typedBreakGlass);

    const bad = [...lines, ...breakGlassLines].filter((line) => !parseRange(line));
    if (bad.length > 0) {
      await renderOther(req, res, {
        status: 400,
        accessRanges: typed,
        breakGlassRanges: typedBreakGlass,
        accessError:
          (bad.length === 1 ? 'This is not an address or a range: ' : 'These are not addresses or ranges: ') +
          bad.slice(0, 3).join(', ') +
          '. Write 203.0.113.0/24, 10.0.0.0/8, 2001:db8::/32 or one address.',
      });
      return;
    }

    const access = {
      allowedRanges: lines,
      breakGlassRanges: breakGlassLines,
      elsewhereNeedsCode: raw.elsewhereNeedsCode === 'on',
      codeForEveryone: raw.codeForEveryone === 'on',
      requireAuthenticator: raw.requireAuthenticator === 'on',
    };
    await updateSettings(
      { localAccounts: { ...settings().localAccounts, conditionalAccess: access } },
      req.currentUser?.id ?? null,
    );
    auditRequest(req, {
      action: 'settings.conditional_access.changed',
      targetType: 'settings',
      // The ranges are the policy, not a secret, and the audit trail is
      // where "who shut the door" has to be answerable.
      detail: access,
    });
    flash(
      req,
      'success',
      access.allowedRanges.length === 0 && !access.codeForEveryone && !access.requireAuthenticator
        ? 'Saved. Password accounts can sign in from anywhere.'
        : 'Conditional access saved.',
    );
    res.redirect(OTHER_URL + '#access');
  }),
);

/**
 * Users - Other settings - who may look other people up (/people).
 *
 * Both off by default. An administrator always may, so there is no switch
 * for them: they read every account under Settings anyway.
 */
userAdminRouter.post(
  '/other/directory',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const directory = {
      technicians: raw.technicians === 'on',
      users: raw.users === 'on',
      ownCompanyOnly: raw.ownCompanyOnly === 'on',
    };
    await updateSettings({ people: { ...settings().people, directory } }, req.currentUser?.id ?? null);
    auditRequest(req, {
      action: 'settings.directory.changed',
      targetType: 'settings',
      detail: directory,
    });
    flash(
      req,
      'success',
      directory.technicians || directory.users
        ? 'Saved. ' +
            [directory.technicians ? 'Technicians' : '', directory.users ? 'Requesters' : '']
              .filter(Boolean)
              .join(' and ') +
            ' can look people up' +
            (directory.ownCompanyOnly ? ', within their own company.' : '.')
        : 'Only administrators can look people up.',
    );
    res.redirect(OTHER_URL + '#directory');
  }),
);

/** Users - Other settings - which of their own details people may change. */
userAdminRouter.post(
  '/other/self-edit',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const ticked = Array.isArray(raw.fields) ? raw.fields.map(String) : typeof raw.fields === 'string' ? [raw.fields] : [];
    const selfEdit = SELF_EDIT_FIELDS.filter((f) => ticked.includes(f));
    await updateSettings({ people: { ...settings().people, selfEdit } }, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.self_edit.changed', targetType: 'settings', detail: { fields: selfEdit } });
    flash(req, 'success', selfEdit.length ? 'People can now change: ' + selfEdit.map((f) => SELF_EDIT_LABELS[f].toLowerCase()).join(', ') + '.' : 'People can no longer change their own details.');
    res.redirect(OTHER_URL + '#self-edit');
  }),
);

/** Users - Other settings - Password policy, for password accounts. */
userAdminRouter.post(
  '/other/password-policy',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const minLength = Number(raw.minLength);
    const maxAgeDays = Number(raw.maxAgeDays ?? 0);
    if (!Number.isInteger(minLength) || minLength < 8 || minLength > 64) {
      await renderOther(req, res, { status: 400, policyError: 'The minimum length must be a whole number from 8 to 64.' });
      return;
    }
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0 || maxAgeDays > 730) {
      await renderOther(req, res, { status: 400, policyError: 'Expiry must be from 0 (never) to 730 days.' });
      return;
    }
    const on = (name: string) => raw[name] === 'on';
    const policy = {
      minLength,
      requireUpper: on('requireUpper'),
      requireLower: on('requireLower'),
      requireDigit: on('requireDigit'),
      requireSymbol: on('requireSymbol'),
      notEmail: on('notEmail'),
      maxAgeDays,
    };
    await updateSettings({ localAccounts: { passwordPolicy: policy } }, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.password_policy.changed', targetType: 'settings', detail: policy });
    flash(req, 'success', 'Password policy saved. It applies to every password set from now on' + (maxAgeDays ? '; older passwords are changed at the next sign-in once they are ' + maxAgeDays + ' days old.' : '.'));
    res.redirect(OTHER_URL + '#password-policy');
  }),
);

/** Before '/:id', which would otherwise read "entra" as an id. */
userAdminRouter.get(
  '/entra',
  asyncHandler(async (req, res) => {
    if (!entraReady()) {
      res.redirect('/admin/settings/users');
      return;
    }
    await renderList(req, res, 'directory');
  }),
);

// ---------------------------------------------------------------------------
// Local sign-in on or off
// ---------------------------------------------------------------------------

/**
 * Why password sign-in cannot be switched off right now, or null.
 *
 * Off means the only way in is Entra ID, and roles never come from the
 * directory - so unless Entra is configured *and* somebody who signs in
 * through it is already an administrator, switching this off would lock
 * every administrator out. FORCE_LOCAL_SIGNIN is the way back if that
 * changes later; this check stops it happening by accident.
 */
async function cannotDisableLocalSignIn(): Promise<string | null> {
  if (!settings().anySsoConfigured) {
    return (
      'Set up an identity provider under Integrations first.'
    );
  }
  // An administrator only counts if a *configured* provider can sign them in:
  // an Entra ID admin is no way back in when only Google is set up. Each
  // provider is recognised by the issuer its accounts carry.
  const current = settings();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (current.ssoConfigured) {
    clauses.push("issuer LIKE 'https://login.microsoftonline.com/%'", "issuer LIKE 'https://sts.windows.net/%'", 'issuer = ?');
    params.push('urn:helpdesk:scim'); // pushed in by Entra's provisioning, signs in through Entra
  }
  if (current.google.configured) {
    clauses.push('issuer = ?');
    params.push('https://accounts.google.com');
  }
  if (current.okta.configured) {
    clauses.push('issuer LIKE ?');
    params.push('https://' + current.okta.domain + '%');
  }
  if (current.genericOidc.configured) {
    const issuer = current.genericOidc.issuer.replace(/\/+$/, '');
    clauses.push('issuer IN (?, ?)');
    params.push(issuer, issuer + '/');
  }
  const directoryAdmins =
    clauses.length === 0
      ? 0
      : await count(
          `SELECT count(*) AS c FROM users
            WHERE role = 'admin' AND status = 'active' AND (` + clauses.join(' OR ') + ')',
          params,
        );
  if (directoryAdmins === 0) {
    return (
      'Give an account from your identity provider the Administrator role first.'
    );
  }
  return null;
}

userAdminRouter.post(
  '/local-signin',
  writeLimiter,
  asyncHandler(async (req, res) => {
    // One button each way: "Disable ..." posts off, "Enable ..." posts on.
    const enabled = (req.body as Record<string, unknown>)?.enabled === 'on';
    if (!enabled) {
      const refused = await cannotDisableLocalSignIn();
      if (refused) {
        flash(req, 'error', refused, 'local-signin');
        res.redirect('/admin/settings/users#local-signin');
        return;
      }
    }
    await updateSettings(
      { localAccounts: { signInEnabled: enabled } },
      req.currentUser?.id ?? null,
    );
    auditRequest(req, {
      action: 'settings.local_signin.' + (enabled ? 'enabled' : 'disabled'),
      targetType: 'settings',
    });
    flash(
      req,
      'success',
      enabled
        ? 'Sign-in with local accounts is enabled.'
        : 'Sign-in with local accounts is disabled. The sign-in page now offers single sign-on only.',
      'local-signin',
    );
    res.redirect('/admin/settings/users#local-signin');
  }),
);

// ---------------------------------------------------------------------------
// Sign-in codes (OTP) for password accounts
// ---------------------------------------------------------------------------

userAdminRouter.post(
  '/sign-in-codes',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const enabled = body.otpEnabled === 'on';
    const groupId = typeof body.excludedGroup === 'string' ? body.excludedGroup.trim() : '';

    if (groupId && !(await listUserGroups()).some((g) => g.id === groupId)) {
      flash(req, 'error', 'Choose a user group from the list.', 'sign-in-codes');
      res.redirect(OTHER_URL + '#sign-in-codes');
      return;
    }
    if (enabled && !settings().localAccounts.otpEnabled) {
      const refused = await cannotEnableCodes(false);
      if (refused) {
        flash(req, 'error', refused, 'sign-in-codes');
        res.redirect(OTHER_URL + '#sign-in-codes');
        return;
      }
    }

    await updateSettings(
      { localAccounts: { otpEnabled: enabled, otpExcludedGroupId: groupId || null } },
      req.currentUser?.id ?? null,
    );
    auditRequest(req, {
      action: 'settings.local_signin.codes_changed',
      targetType: 'settings',
      detail: { enabled, excludedGroupId: groupId || null },
    });
    flash(
      req,
      'success',
      enabled ? 'Local users now sign in with a code sent by email.' : 'Local users sign in with their password.',
      'sign-in-codes',
    );
    res.redirect(OTHER_URL + '#sign-in-codes');
  }),
);

// ---------------------------------------------------------------------------
// The break-glass account, on a tab of its own
// ---------------------------------------------------------------------------

userAdminRouter.get(
  '/break-glass',
  asyncHandler(async (req, res) => {
    const admin = await findLocalAdmin();
    if (!admin) throw notFound('The break-glass account has not been created yet.');
    await renderUser(req, res, admin);
  }),
);

userAdminRouter.post(
  '/break-glass/sign-in-code',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const admin = await findLocalAdmin();
    if (!admin) throw notFound('The break-glass account has not been created yet.');
    const enabled = (req.body as Record<string, unknown>)?.enabled === 'on';
    if (enabled && !settings().localAccounts.breakGlassOtp) {
      const refused = await cannotEnableCodes(true, admin.email);
      if (refused) {
        flash(req, 'error', refused, 'sign-in-codes');
        res.redirect(BREAK_GLASS_URL + '#sign-in-codes');
        return;
      }
    }
    await updateSettings({ localAccounts: { breakGlassOtp: enabled } }, req.currentUser?.id ?? null);
    auditRequest(req, {
      action: 'settings.local_signin.break_glass_code_' + (enabled ? 'enabled' : 'disabled'),
      targetType: 'settings',
    });
    flash(
      req,
      'success',
      enabled
        ? 'The break-glass account now signs in with a code sent to ' + admin.email + '.'
        : 'The break-glass account signs in with its password.',
      'sign-in-codes',
    );
    res.redirect(BREAK_GLASS_URL + '#sign-in-codes');
  }),
);

// An administrator sets a technician's availability for them.
userAdminRouter.use(
  '/:id/availability',
  availabilityRouter({ whose: userInPath, back: (req) => '/admin/settings/users/' + String(req.params.id) }),
);

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

userAdminRouter.get('/import/template.csv', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="local-users.csv"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(importTemplateCsv());
});

/** Memory storage: the file is read and thrown away, never kept. */
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1, fields: 5, parts: 8 },
}).single('file');

userAdminRouter.post(
  '/import',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tooBig = await new Promise<boolean>((resolve, reject) => {
      importUpload(req, res, (err: unknown) => {
        if (!err) resolve(false);
        else if (err instanceof multer.MulterError) resolve(true);
        else reject(err);
      });
    });
    // The global CSRF check runs before a multipart body exists, so it is
    // made here, once the token can be read.
    assertCsrfToken(req);

    // Refused in the dialog, not on an error page (trap 6).
    const refuse = (problems: string[]) =>
      renderList(req, res, 'local', { openDialog: 'import-users', importProblems: problems }, 400);

    if (tooBig) {
      await refuse(['The file must be 1 MB or smaller.']);
      return;
    }
    const file = req.file;
    if (!file || file.size === 0) {
      await refuse(['Choose a CSV file to upload.']);
      return;
    }
    const text = file.buffer.toString('utf8');
    if (text.includes('\u0000')) {
      await refuse(['That is not a CSV file. Save the sheet as "CSV UTF-8" and upload that.']);
      return;
    }

    const plan = await planImport(text);
    if (plan.problems.length > 0) {
      await refuse(plan.problems);
      return;
    }
    // Only an administrator imports staff (custom roles, 21 Oct 2026).
    if (req.currentUser?.role !== 'admin' && plan.create.some((row) => row.role !== 'user')) {
      await refuse(['Only an administrator imports agents or administrators. Set every role to user, or ask an administrator.']);
      return;
    }

    const mailPassword = (req.body ?? {}).mailPassword === 'on';
    const imported = await runImport(plan.create, req.currentUser?.id ?? null, { mailPassword });
    auditRequest(req, {
      action: 'local_account.imported',
      targetType: 'user',
      detail: {
        created: imported.length,
        skipped: plan.skipped.length,
        mailed: imported.filter((a) => a.mailed).length,
      },
    });
    // Rendered, not redirected: the generated passwords are shown once, and
    // carrying them across a redirect would mean storing them in the session.
    await renderList(req, res, 'local', { imported, skipped: plan.skipped });
  }),
);

/**
 * Sends a temporary password to the address on the account.
 *
 * The same reset as above - a generated password that meets the policy, and
 * mustChange, so the person is sent to Choose a password at their next
 * sign-in and into the service desk once they have - but delivered instead
 * of read out over a desk. Asked for 15 Oct 2026.
 *
 * Two things it must get right:
 *
 * 1. **The password changes only if the mail was queued.** Queue first,
 *    then set: a password that was reset and never delivered locks somebody
 *    out of an account that worked a moment ago. The message is generated
 *    from the same value either way, so there is nothing to go out of step.
 * 2. **Never the break-glass account.** Its whole purpose is to work when
 *    mail does not, so its password is never sent anywhere.
 */
userAdminRouter.post(
  '/:id/password/send',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const target = await load(req);

    if (isLocalAdmin(target)) {
      flash(req, 'error', 'The break-glass password is never emailed. Reset it here and keep it somewhere safe.');
      res.redirect(userUrl(target));
      return;
    }
    if (!isLocalAccount(target)) {
      flash(req, 'error', 'That account signs in through an identity provider, so it has no password here.');
      res.redirect(userUrl(target));
      return;
    }

    const password = generatePassword();
    const problems = passwordProblems(password, personOf(target));
    if (problems.length > 0) {
      // generatePassword() mixes in one of each kind, so this means the
      // policy asks for something it cannot make - worth saying, not hiding.
      flash(req, 'error', problems[0]!.message);
      res.redirect(userUrl(target));
      return;
    }

    const sent = await notifyPerson('account.temporary_password', target.email, {
      personName: target.display_name,
      email: target.email,
      password,
      signInUrl: config.publicOrigin + '/login',
      appName: settings().branding.appName,
    });

    if (!sent) {
      flash(
        req,
        'error',
        'Nothing was sent, and the password is unchanged. Check that "Your temporary password" is switched on under Settings - Mail - Notifications, and that a mailbox or relay can send.',
      );
      res.redirect(userUrl(target));
      return;
    }

    await setLocalPassword(target.id, password, req.currentUser?.id ?? null, { mustChange: true });
    await sessionStore.destroyForUser(target.id);

    auditRequest(req, {
      action: 'local_account.password.sent',
      targetType: 'user',
      targetId: target.id,
    });
    flash(req, 'success', 'A temporary password is on its way to ' + target.email + '. They must change it at their next sign-in.');
    res.redirect(userUrl(target));
  }),
);

// ---------------------------------------------------------------------------
// One user
// ---------------------------------------------------------------------------

userAdminRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = await load(req);
    if (isLocalAdmin(user)) {
      res.redirect(BREAK_GLASS_URL);
      return;
    }
    await renderUser(req, res, user);
  }),
);

/**
 * Removes somebody's authenticator app: the way back for a lost phone and
 * lost recovery codes. Their password still works; they can set the app up
 * again. Audited as auth.authenticator.reset.
 */
userAdminRouter.post(
  '/:id/authenticator/reset',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const target = await load(req);
    const actor = req.currentUser!;
    await removeAuthenticator(target.id, actor, true);
    flash(req, 'success', 'The authenticator app is removed. ' + target.display_name + ' signs in with the password alone until they set it up again.');
    res.redirect(userUrl(target));
  }),
);

/**
 * One account's page. The break-glass account's is its tab.
 *
 * Administrators the customer portal set up used to be locked here (only
 * the portal could demote, disable or remove them). Since 22 Oct 2026 the
 * helpdesk manages its own administrators: nothing is sold, and the owner
 * asked to change them here like anybody else.
 */

async function renderUser(req: Request, res: Response, user: UserRow): Promise<void> {
  {
    const [groups, allGroups, activity, local, allUserGroups, userGroupSources] = await Promise.all([
      groupsForUser(user.id),
      listActiveGroups(),
      ticketActivityFor(user.id),
      isLocalAccount(user) ? localAccountStatus(user.id) : Promise.resolve(null),
      listActiveUserGroups(),
      userGroupSourcesFor(user.id),
    ]);

    res.render(
      'admin/settings/user-detail',
      settingsView('users', {
        sectionTitle: user.display_name,
        user,
        managerEmail: await managerEmailOf(user),
        // What is assigned to them (services/assets.ts), for those who manage assets.
        assets: canRead(req.currentUser, 'assets.manage') ? await assetsAssignedTo(user.id) : [],
        assetTitle,
        groups,
        groupIds: groups.map((g) => g.id),
        allGroups,
        // User groups, ticked here as well as from the group's own page.
        allUserGroups,
        userGroupSources: Object.fromEntries(userGroupSources),
        activity,
        local,
        // Custom roles, offered beside the built-in ones (auth/permissions.ts).
        customRoles: listRoles(),
        // Their authenticator app, which an administrator can remove after a lost phone.
        hasAuthenticator: isLocalAccount(user) ? await hasAuthenticator(user.id) : false,
        isLocal: isLocalAccount(user),
        isProtected: isLocalAdmin(user),
        isSelf: user.id === req.currentUser?.id,
        // What the Anonymous placeholder would take on, said in the dialog
        // so nobody erases an account without knowing what moves.
        footprint: await erasureFootprint(user.id),
        canHaveGroups: isStaff(user.role),
        minPasswordLength: minPasswordLength(), passwordPolicy: passwordPolicyText(),
        entraReady: entraReady(),
        availability: (await tracksAvailability(user))
          ? await availabilityView(user.id, '/admin/settings/users/' + user.id + '/availability', user.id === req.currentUser?.id)
          : null,
        breakGlassCodes: {
          enabled: settings().localAccounts.breakGlassOtp,
          forced: config.forceLocalSignIn,
        },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/**
 * The attributes a user group's rules read.
 *
 * Separate from the role on purpose: these describe the person, the role
 * decides their access, and the two should not be edited by one form. Saving
 * recalculates every rule, so a change of department takes effect at once
 * rather than at the next sign-in.
 */
/**
 * Changes a password account's email address.
 *
 * Separate from the profile attributes because this one decides where mail
 * goes, and a clash with another account has to be refused rather than
 * shrugged at.
 */
userAdminRouter.post(
  '/:id/email',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const target = await load(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;

    const attempted = await attempt(() =>
      setLocalEmail(
        target.id,
        typeof raw.email === 'string' ? raw.email : '',
        req.currentUser?.id ?? null,
      ),
    );

    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be saved.');
    } else {
      flash(req, 'success', 'Email address saved.');
    }
    res.redirect(userUrl(target));
  }),
);

userAdminRouter.post(
  '/:id/profile',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const target = await load(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;

    await setProfileAttributes(
      target.id,
      {
        department: typeof raw.department === 'string' ? normaliseLine(raw.department) : '',
        jobTitle: typeof raw.jobTitle === 'string' ? normaliseLine(raw.jobTitle) : '',
        office: typeof raw.office === 'string' ? normaliseLine(raw.office) : '',
        phone: typeof raw.phone === 'string' ? normaliseLine(raw.phone) : '',
        ...(typeof raw.firstName === 'string' ? { firstName: normaliseLine(raw.firstName) } : {}),
        ...(typeof raw.lastName === 'string' ? { lastName: normaliseLine(raw.lastName) } : {}),
        ...(typeof raw.company === 'string' ? { company: normaliseLine(raw.company) } : {}),
        extension1: typeof raw.extension1 === 'string' ? normaliseLine(raw.extension1) : '',
        extension2: typeof raw.extension2 === 'string' ? normaliseLine(raw.extension2) : '',
        extension3: typeof raw.extension3 === 'string' ? normaliseLine(raw.extension3) : '',
      },
      req.currentUser?.id ?? null,
    );

    // A directory account's name comes from the directory and would be
    // rewritten at the next sign-in or sync; only a password account's is typed.
    if (isLocalAccount(target) && typeof raw.displayName === 'string' && normaliseLine(raw.displayName)) {
      await setSourceName(target.id, normaliseLine(raw.displayName));
    }

    await applyAllRules(req.currentUser?.id ?? null);
    await applyAllTechnicianRules(req.currentUser?.id ?? null);

    // The manager (services/teams.ts): an address, '' for none.
    if (typeof raw.manager === 'string') {
      const manager = raw.manager;
      const set = await attempt(() => setManagerByEmail(target.id, manager, req.currentUser?.id ?? null));
      if (!set.ok) {
        flash(req, 'error', Object.values(set.errors)[0] ?? 'That manager could not be saved.');
        res.redirect(userUrl(target));
        return;
      }
    }

    flash(req, 'success', 'Profile saved, and group rules recalculated.');
    res.redirect(userUrl(target));
  }),
);

userAdminRouter.post(
  '/:id/role',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    if (!actor) throw notFound();
    const target = await load(req);

    const parsed = roleBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That role is not valid.', 'bad_role');
    // Giving roles stays an administrator's, whoever else may open Users (custom roles, 21 Oct 2026).
    if (actor.role !== 'admin') throw forbidden('Only an administrator changes a role.', 'not_admin');
    const custom = parsed.data.role.startsWith('role:') ? roleById(parsed.data.role.slice(5)) : undefined;
    if (parsed.data.role.startsWith('role:') && !custom) throw badRequest('That role no longer exists.', 'bad_role');
    if (custom) {
      if (isLocalAdmin(target)) throw conflict('The local administrator account must keep the administrator role.', 'local_admin_protected');
      if (target.role === 'admin' && target.id === actor.id) throw conflict('You cannot remove your own administrator role.', 'self_demotion');
      if (target.role === 'admin' && (await countAdmins()) <= 1) throw conflict('At least one administrator must remain.', 'last_admin');
      await setCustomRole(target.id, custom.id);
      auditRequest(req, { action: 'user.role.changed', targetType: 'user', targetId: target.id, detail: { from: target.role, to: 'role:' + custom.name } });
      flash(req, 'success', 'Role changed to ' + custom.name + '.');
      res.redirect(userUrl(target));
      return;
    }
    const builtin = parsed.data.role as 'user' | 'agent' | 'admin';

    // The local break-glass administrator exists precisely so administrative
    // access always remains; demoting it would defeat that.
    if (isLocalAdmin(target) && builtin !== 'admin') {
      throw conflict(
        'The local administrator account must keep the administrator role.',
        'local_admin_protected',
      );
    }

    // Refuse to remove the last administrator, and refuse self-demotion, so an
    // administrator cannot lock the whole organisation out by accident.
    const demotingAdmin = target.role === 'admin' && builtin !== 'admin';
    if (demotingAdmin && target.id === actor.id) {
      throw conflict('You cannot remove your own administrator role.', 'self_demotion');
    }
    if (demotingAdmin && (await countAdmins()) <= 1) {
      throw conflict('At least one administrator must remain.', 'last_admin');
    }

    if (builtin === 'admin' && target.role !== 'admin' && portalManagesAdmins()) {
      throw conflict(ADMINS_IN_PORTAL, 'admins_in_portal');
    }

    await setUserRole(target.id, builtin, true);
    await setCustomRole(target.id, null);

    // A plain user has no queue, so team membership would mean nothing. Drop
    // it rather than leave a membership the group page would have refused.
    let droppedGroups = 0;
    if (!isStaff(builtin)) {
      droppedGroups = await clearGroupsForUser(target.id);
    }
    // Promoted to staff, a rule may now want them in a technician group.
    await applyAllTechnicianRules(req.currentUser?.id ?? null);

    auditRequest(req, {
      action: 'user.role.changed',
      targetType: 'user',
      targetId: target.id,
      detail: {
        email: target.email,
        from: target.role,
        to: builtin,
        groupsDropped: droppedGroups,
      },
    });

    flash(
      req,
      'success',
      target.display_name +
        ' is now ' +
        builtin +
        (droppedGroups > 0
          ? ', and was removed from ' + droppedGroups + ' technician group(s).'
          : '.'),
    );
    res.redirect(userUrl(target));
  }),
);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

userAdminRouter.post(
  '/:id/status',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    if (!actor) throw notFound();
    const target = await load(req);

    const parsed = statusBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That status is not valid.', 'bad_status');

    if (parsed.data.status === 'disabled') {
      if (isLocalAdmin(target)) {
        throw conflict(
          'The local administrator account cannot be disabled. Change its password instead.',
          'local_admin_protected',
        );
      }
      if (target.id === actor.id) {
        throw conflict('You cannot disable your own account.', 'self_disable');
      }
      if (target.role === 'admin' && (await countAdmins()) <= 1) {
        throw conflict('At least one active administrator must remain.', 'last_admin');
      }
    }

    await setUserStatus(target.id, parsed.data.status);

    // Disabling must take effect immediately, not at session expiry.
    let revoked = 0;
    if (parsed.data.status === 'disabled') {
      revoked = await sessionStore.destroyForUser(target.id);
    }

    auditRequest(req, {
      action: parsed.data.status === 'disabled' ? 'user.disabled' : 'user.enabled',
      targetType: 'user',
      targetId: target.id,
      detail: { email: target.email, sessionsRevoked: revoked },
    });

    flash(
      req,
      'success',
      target.display_name +
        ' is now ' +
        parsed.data.status +
        (revoked > 0 ? ' and ' + revoked + ' active session(s) were signed out.' : '.'),
    );
    res.redirect(userUrl(target));
  }),
);

// ---------------------------------------------------------------------------
// Technician groups
// ---------------------------------------------------------------------------

userAdminRouter.post(
  '/:id/user-groups',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const target = await load(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const submitted = raw.userGroups;
    const wanted = Array.isArray(submitted) ? submitted.map(String) : typeof submitted === 'string' && submitted ? [submitted] : [];
    const changed = await setUserGroupsForUser(target.id, wanted, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'user.user_groups.changed', targetType: 'user', targetId: target.id, detail: { email: target.email, changed } });
    flash(req, 'success', 'User groups updated for ' + target.display_name + '.');
    res.redirect(userUrl(target) + '#user-groups');
  }),
);

userAdminRouter.post(
  '/:id/groups',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const target = await load(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const submitted = raw.groups;
    const groupIds = Array.isArray(submitted)
      ? submitted.map(String)
      : typeof submitted === 'string' && submitted
        ? [submitted]
        : [];

    // Refused for a plain user, who has no queue for a team to fill. Shown on
    // the page they submitted from, next to the role that has to change first.
    const attempted = await attempt(() =>
      setGroupsForUser(target, groupIds, req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'Those groups could not be set.');
      res.redirect(userUrl(target));
      return;
    }

    auditRequest(req, {
      action: 'user.groups.changed',
      targetType: 'user',
      targetId: target.id,
      detail: { email: target.email, groups: groupIds.length },
    });

    flash(req, 'success', 'Technician groups updated for ' + target.display_name + '.');
    res.redirect(userUrl(target));
  }),
);

// ---------------------------------------------------------------------------
// Password, for accounts that have one
// ---------------------------------------------------------------------------

userAdminRouter.post(
  '/:id/password',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const target = await load(req);
    const parsed = passwordBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That password could not be read.');

    // An empty box means "generate one", which is the safer default.
    const password = parsed.data.password?.trim() ? parsed.data.password : generatePassword();
    const problems = passwordProblems(password, personOf(target));
    if (problems.length > 0) {
      flash(req, 'error', problems[0]!.message);
      res.redirect(userUrl(target));
      return;
    }

    await setLocalPassword(target.id, password, req.currentUser?.id ?? null, {
      mustChange: true,
    });
    await sessionStore.destroyForUser(target.id);

    auditRequest(req, {
      action: 'local_account.password.reset',
      targetType: 'user',
      targetId: target.id,
    });
    flash(
      req,
      'success',
      'Password for ' +
        target.display_name +
        ' is now: ' +
        password +
        ' - give it to them and ask them to change it. It is not shown again.',
    );
    res.redirect(userUrl(target));
  }),
);

// ---------------------------------------------------------------------------
// Create a password account
// ---------------------------------------------------------------------------

userAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const firstName = typeof raw.firstName === 'string' ? normaliseLine(raw.firstName).slice(0, 100) : '';
    const lastName = typeof raw.lastName === 'string' ? normaliseLine(raw.lastName).slice(0, 100) : '';
    const company = typeof raw.company === 'string' ? normaliseLine(raw.company).slice(0, 120) : '';
    const candidate = {
      displayName: (typeof raw.displayName === 'string' ? normaliseLine(raw.displayName) : '') || [firstName, lastName].filter(Boolean).join(' '),
      firstName,
      lastName,
      company,
      email: typeof raw.email === 'string' ? normaliseLine(raw.email) : '',
      role: raw.role,
      password: typeof raw.password === 'string' ? raw.password : '',
    };

    const parsed = createBody.safeParse(candidate);
    const errors: Record<string, string> = {};
    if (parsed.success && parsed.data.role === 'admin' && portalManagesAdmins()) errors.role = ADMINS_IN_PORTAL;
    // Somebody who may open Users without being an administrator adds users, never staff (custom roles).
    if (parsed.success && parsed.data.role !== 'user' && req.currentUser?.role !== 'admin') errors.role = 'Only an administrator gives a role other than User.';
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (!errors[key]) errors[key] = issue.message;
      }
    } else {
      const problems = passwordProblems(parsed.data.password, { email: parsed.data.email });
      if (problems.length > 0) errors.password = problems[0]!.message;
    }

    const refuse = (shown: FieldErrors): Promise<void> =>
      renderList(
        req,
        res,
        'local',
        { values: candidate, errors: shown, openDialog: 'new-account' },
        400,
      );

    if (!parsed.success || Object.keys(errors).length > 0) {
      await refuse(errors);
      return;
    }

    // A username or address already in use is the commonest refusal here, and
    // it belongs on the field rather than on a page of its own.
    const attempted = await attempt(() =>
      createLocalAccount(
        {
          // No username: the email address is what they sign in with.
          displayName: parsed.data.displayName,
          email: parsed.data.email,
          role: parsed.data.role,
          password: parsed.data.password,
          // The administrator chose it, so the owner is asked to replace it.
          mustChange: true,
          firstName,
          lastName,
          company,
        },
        req.currentUser?.id ?? null,
      ),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }
    const created = attempted.value;

    auditRequest(req, {
      action: 'local_account.created',
      targetType: 'user',
      targetId: created.id,
      detail: { email: parsed.data.email, role: parsed.data.role },
    });
    flash(req, 'success', 'Account "' + parsed.data.email + '" created.');
    res.redirect('/admin/settings/users/' + created.id);
  }),
);

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

userAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    if (!actor) throw notFound();
    const target = await load(req);

    if (target.id === actor.id) {
      throw conflict('You cannot remove your own account.', 'self_delete');
    }

    await deleteLocalAccount(target.id, actor.id);
    await sessionStore.destroyForUser(target.id);

    flash(req, 'success', target.display_name + ' removed.');
    res.redirect('/admin/settings/users');
  }),
);

/**
 * Remove, and file their work under the placeholder: the right to erasure.
 *
 * The ordinary Remove above keeps an account that has tickets, disabled, so
 * the history survives - and with it the person's name and address. This is
 * the answer for somebody who has left and asked to be forgotten: the
 * tickets stay and point at one anonymous placeholder, the account goes.
 * services/erasure.ts has the reasoning. Asked for 15 Oct 2026.
 */
userAdminRouter.post(
  '/:id/erase',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const actor = req.currentUser;
    if (!actor) throw notFound();
    const target = await load(req);

    if (target.id === actor.id) {
      throw conflict('You cannot remove your own account.', 'self_delete');
    }
    if (isLocalAdmin(target)) {
      throw conflict('The break-glass account cannot be removed.');
    }

    const moved = await eraseUser(target, actor.id);
    await sessionStore.destroyForUser(target.id);

    flash(
      req,
      'success',
      'The account was erased. ' +
        (moved.tickets === 0
          ? 'It had no tickets.'
          : moved.tickets + (moved.tickets === 1 ? ' ticket is' : ' tickets are') + ' now filed under Anonymous.'),
    );
    res.redirect('/admin/settings/users');
  }),
);
