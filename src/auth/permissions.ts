import { execute, query, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import type { UserRow } from '../services/users.js';

/**
 * Custom roles: a name and a set of ticked permissions (asked for 21 Oct
 * 2026, "like RBAC").
 *
 * **Everybody still has a base role** - user, agent or admin, the column every
 * existing check reads. A custom role sets it: a role that may work on
 * tickets makes its people agents, any other makes them users, and none
 * makes an administrator. So the eighty-odd places that ask "is this staff?"
 * keep their meaning, and the ticks narrow or widen the particular things
 * below, each checked where it is used through `can()`.
 *
 * - The built-in roles keep what they had: an administrator may do
 *   everything, an agent what a technician always could, a user nothing here.
 * - **Only an administrator manages roles and gives roles to people.** A
 *   custom role may include Users, but never the power to raise anybody,
 *   itself included, above what it has (the owner's call, 21 Oct 2026).
 * - Roles are read once and kept in memory (like settings()); every write
 *   reloads them. At several instances each holds its own copy.
 */

export interface Permission {
  key: string;
  label: string;
  group: 'Tickets' | 'Reports and people' | 'Settings' | 'Automation and API';
}

/** Every permission a role can be given, in the order the role page lists them. */
export const PERMISSIONS: readonly Permission[] = [
  { key: 'tickets.work', label: 'Work on tickets as a technician', group: 'Tickets' },
  { key: 'tickets.view_all', label: "See every ticket, not only their groups' and their own", group: 'Tickets' },
  { key: 'tickets.edit', label: 'Change status, priority, assignee, group and category', group: 'Tickets' },
  { key: 'tickets.internal', label: 'Read and write internal notes', group: 'Tickets' },
  { key: 'tickets.delete', label: 'Delete tickets', group: 'Tickets' },
  { key: 'reports.view', label: 'Open Reports', group: 'Reports and people' },
  { key: 'people.directory', label: 'Search the people directory', group: 'Reports and people' },
  { key: 'settings.integrations', label: 'Integrations', group: 'Settings' },
  { key: 'settings.users', label: 'Users (not roles)', group: 'Settings' },
  { key: 'settings.groups', label: 'Groups', group: 'Settings' },
  { key: 'settings.templates', label: 'Tickets: forms, catalogue and service levels', group: 'Settings' },
  { key: 'settings.mail', label: 'Mail', group: 'Settings' },
  { key: 'settings.customization', label: 'Customisation', group: 'Settings' },
  { key: 'settings.dashboards', label: 'Dashboards', group: 'Settings' },
  { key: 'settings.advanced', label: 'Advanced settings: portal scripting, data', group: 'Settings' },
  { key: 'settings.audit', label: 'Audit trail', group: 'Settings' },
  { key: 'automation.manage', label: 'Build automations and connections', group: 'Automation and API' },
  { key: 'api.manage', label: 'Manage API keys', group: 'Automation and API' },
];

const KNOWN = new Set(PERMISSIONS.map((p) => p.key));

/** What a technician (agent) could always do, without a custom role. */
const AGENT_DEFAULT = ['tickets.work', 'tickets.view_all', 'tickets.edit', 'tickets.internal', 'reports.view'];

export interface RoleRow {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  created_at: string;
  updated_at: string;
}

let roles = new Map<string, RoleRow>();

function parse(row: { permissions: unknown } & Omit<RoleRow, 'permissions'>): RoleRow {
  const raw = typeof row.permissions === 'string' ? (JSON.parse(row.permissions) as unknown) : row.permissions;
  const list = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && KNOWN.has(p)) : [];
  return { ...row, permissions: list };
}

/** Reads every role into memory. Called at start-up and after every change. */
export async function loadRoles(): Promise<RoleRow[]> {
  const rows = await query<RoleRow & { permissions: unknown }>('SELECT * FROM roles ORDER BY lower(name)');
  roles = new Map(rows.map((r) => [r.id, parse(r)]));
  return [...roles.values()];
}

export function listRoles(): RoleRow[] {
  return [...roles.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function roleById(id: string | null | undefined): RoleRow | undefined {
  return id ? roles.get(id) : undefined;
}

/** The base role a custom role gives its people. Never an administrator. */
export const baseRoleOf = (permissions: readonly string[]): 'agent' | 'user' =>
  permissions.includes('tickets.work') ? 'agent' : 'user';

/** Everything this person may do. */
export function permissionsOf(user: Pick<UserRow, 'role'> & { role_id?: string | null }): Set<string> {
  if (user.role === 'admin') return new Set(KNOWN);
  const custom = roleById(user.role_id);
  if (custom) return new Set(custom.permissions);
  return new Set(user.role === 'agent' ? AGENT_DEFAULT : []);
}

export function can(user: (Pick<UserRow, 'role'> & { role_id?: string | null }) | null | undefined, permission: string): boolean {
  return !!user && permissionsOf(user).has(permission);
}

/** Whether this person may open any part of Settings at all. */
export function canOpenSettings(user: (Pick<UserRow, 'role'> & { role_id?: string | null }) | null | undefined): boolean {
  if (!user) return false;
  const mine = permissionsOf(user);
  return [...mine].some((p) => p.startsWith('settings.') || p === 'automation.manage' || p === 'api.manage');
}

/**
 * The permission a path under /admin/settings needs, or 'admin' for what
 * stays with administrators: the roles themselves, and Settings' own front
 * page is open to anybody who may open any part of it.
 */
export function permissionForSettingsPath(path: string): string | 'admin' | 'any' {
  const parts = path.replace(/^\/+/, '').split('/');
  if (parts[0] === 'settings') parts.shift();
  const section = parts[0] ?? '';
  if (section === '' || section === 'search') return 'any';
  if (section === 'users' && parts[1] === 'roles') return 'admin';
  if (section === 'advanced' && (parts[1] === 'automation' || parts[1] === 'connections')) return 'automation.manage';
  if (section === 'advanced' && parts[1] === 'api-keys') return 'api.manage';
  return 'settings.' + section;
}

// --- writing roles ----------------------------------------------------------------

export interface RoleInput {
  name: string;
  description: string;
  permissions: string[];
}

export function roleProblems(input: RoleInput, exceptId: string | null): Record<string, string> {
  const problems: Record<string, string> = {};
  if (input.name.trim().length < 2) problems.name = 'Give the role a name.';
  else if (input.name.length > 60) problems.name = 'Keep the name under 60 characters.';
  else if (['user', 'agent', 'admin', 'administrator', 'technician'].includes(input.name.trim().toLowerCase())) {
    problems.name = 'That is the name of a built-in role. Choose another.';
  } else if (listRoles().some((r) => r.id !== exceptId && r.name.toLowerCase() === input.name.trim().toLowerCase())) {
    problems.name = 'Another role already has this name.';
  }
  if (input.description.length > 300) problems.description = 'Keep the description under 300 characters.';
  return problems;
}

const clean = (input: RoleInput) => ({
  name: input.name.trim(),
  description: input.description.trim(),
  permissions: [...new Set(input.permissions.filter((p) => KNOWN.has(p)))],
});

export async function createRole(input: RoleInput, actor: { id: string; email: string }): Promise<string> {
  const c = clean(input);
  const id = newId();
  const now = nowIso();
  await execute('INSERT INTO roles (id, name, description, permissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id, c.name, c.description, JSON.stringify(c.permissions), now, now,
  ]);
  await loadRoles();
  audit({ action: 'role.created', actorId: actor.id, actorEmail: actor.email, targetType: 'role', targetId: id, detail: c });
  return id;
}

/** Changes a role, and moves its people to the base role it now gives. */
export async function updateRole(id: string, input: RoleInput, actor: { id: string; email: string }): Promise<void> {
  if (!roleById(id)) throw notFound('That role no longer exists.');
  const c = clean(input);
  await execute('UPDATE roles SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE id = ?', [
    c.name, c.description, JSON.stringify(c.permissions), nowIso(), id,
  ]);
  await execute("UPDATE users SET role = ?, updated_at = ? WHERE role_id = ? AND role <> 'admin'", [baseRoleOf(c.permissions), nowIso(), id]);
  await loadRoles();
  audit({ action: 'role.updated', actorId: actor.id, actorEmail: actor.email, targetType: 'role', targetId: id, detail: c });
}

/** Only a role nobody has: moving people off it is a decision about each of them. */
export async function deleteRole(id: string, actor: { id: string; email: string }): Promise<void> {
  const used = await queryOne<{ c: number }>('SELECT count(*) AS c FROM users WHERE role_id = ?', [id]);
  if (Number(used?.c ?? 0) > 0) throw conflict('Give its people another role first.', 'role_in_use');
  await execute('DELETE FROM roles WHERE id = ?', [id]);
  await loadRoles();
  audit({ action: 'role.deleted', actorId: actor.id, actorEmail: actor.email, targetType: 'role', targetId: id });
}

export async function countRoleMembers(): Promise<Map<string, number>> {
  const rows = await query<{ role_id: string; c: number }>('SELECT role_id, count(*) AS c FROM users WHERE role_id IS NOT NULL GROUP BY role_id');
  return new Map(rows.map((r) => [r.role_id, Number(r.c)]));
}

/** Gives a person a custom role (its base role with it), or takes it away (null). */
export async function setCustomRole(userId: string, roleId: string | null): Promise<void> {
  if (roleId) {
    const role = roleById(roleId);
    if (!role) throw notFound('That role no longer exists.');
    await execute('UPDATE users SET role = ?, role_id = ?, role_locked = 1, updated_at = ? WHERE id = ?', [baseRoleOf(role.permissions), roleId, nowIso(), userId]);
  } else {
    await execute('UPDATE users SET role_id = NULL, updated_at = ? WHERE id = ?', [nowIso(), userId]);
  }
}
