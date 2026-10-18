import { execute, query, queryOne, transaction } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import type { UserRow } from './users.js';

/**
 * Groups of requesters, and which ticket templates they are offered.
 *
 * Deliberately separate from `technician_groups`. That one answers "who works
 * this ticket"; this one answers "which forms may this person raise". Putting
 * both in one table would mean adding a requester to a queue in order to show
 * them a form.
 *
 * Membership is either **manual** - an administrator put them there - or
 * **by rule**, recomputed from the group's rules whenever an account changes.
 * The two are kept apart by the `source` column so a recompute never removes
 * somebody an administrator added by hand.
 */

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * The account fields a rule can match on.
 *
 * Only fields that describe the person, never `role` or `status`: a rule that
 * granted visibility by role would be a second, invisible place where access
 * is decided, and this project keeps that in one place.
 */
export const RULE_ATTRIBUTES = [
  'company',
  'department',
  'job_title',
  'office',
  'phone',
  'email',
  'upn',
  'display_name',
  'first_name',
  'last_name',
  'extension_attribute_1',
  'extension_attribute_2',
  'extension_attribute_3',
] as const;
export type RuleAttribute = (typeof RULE_ATTRIBUTES)[number];

export const ATTRIBUTE_LABELS: Record<RuleAttribute, string> = {
  company: 'Company',
  department: 'Department',
  job_title: 'Job title',
  office: 'Office',
  phone: 'Phone',
  email: 'Email',
  upn: 'User principal name',
  display_name: 'Display name',
  first_name: 'First name',
  last_name: 'Last name',
  extension_attribute_1: 'Extension attribute 1',
  extension_attribute_2: 'Extension attribute 2',
  extension_attribute_3: 'Extension attribute 3',
};

export const RULE_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'ends_with',
  'is_set',
  'is_empty',
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const OPERATOR_LABELS: Record<RuleOperator, string> = {
  equals: 'equals',
  not_equals: 'does not equal',
  contains: 'contains',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_set: 'is set',
  is_empty: 'is empty',
};

/** The two that compare against nothing, so the value box is pointless. */
export const VALUELESS: readonly RuleOperator[] = ['is_set', 'is_empty'];

export interface RuleRow {
  id: string;
  group_id: string;
  attribute: RuleAttribute;
  operator: RuleOperator;
  value: string;
  created_at: string;
}

/**
 * Whether one account satisfies one rule.
 *
 * Case-insensitive throughout: "HR" and "hr" are the same department, and a
 * rule that missed somebody because their directory capitalises differently
 * would be a support call nobody could explain.
 */
export function matches(user: UserRow, rule: RuleRow): boolean {
  const raw = (user as unknown as Record<string, unknown>)[rule.attribute];
  const actual = String(raw ?? '').trim().toLowerCase();
  const wanted = rule.value.trim().toLowerCase();

  switch (rule.operator) {
    case 'is_set':
      return actual !== '';
    case 'is_empty':
      return actual === '';
    case 'equals':
      return actual === wanted;
    case 'not_equals':
      return actual !== wanted;
    case 'contains':
      return wanted !== '' && actual.includes(wanted);
    case 'starts_with':
      return wanted !== '' && actual.startsWith(wanted);
    case 'ends_with':
      return wanted !== '' && actual.endsWith(wanted);
    default:
      return false;
  }
}

/** Several rules on one group are OR-ed: matching any of them is enough. */
export function matchesAny(user: UserRow, rules: readonly RuleRow[]): boolean {
  return rules.some((rule) => matches(user, rule));
}

export function listRules(groupId: string): Promise<RuleRow[]> {
  return query<RuleRow>(
    'SELECT * FROM user_group_rules WHERE group_id = ? ORDER BY created_at',
    [groupId],
  );
}

export async function addRule(
  groupId: string,
  input: { attribute: string; operator: string; value: string },
  actorId: string | null,
): Promise<RuleRow> {
  const attribute = RULE_ATTRIBUTES.find((a) => a === input.attribute);
  const operator = RULE_OPERATORS.find((o) => o === input.operator);
  if (!attribute) throw conflict('That is not an attribute a rule can read.', 'bad_attribute');
  if (!operator) throw conflict('That is not a comparison.', 'bad_operator');

  const value = VALUELESS.includes(operator) ? '' : input.value.trim().slice(0, 200);
  if (!value && !VALUELESS.includes(operator)) {
    throw conflict(
      'Give the rule something to compare against, or use "is set" / "is empty".',
      'rule_value_required',
    );
  }

  const id = newId();
  await execute(
    `INSERT INTO user_group_rules (id, group_id, attribute, operator, value, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, groupId, attribute, operator, value, nowIso()],
  );

  audit({
    action: 'user_group.rule.added',
    actorId,
    targetType: 'user_group',
    targetId: groupId,
    detail: { attribute, operator, value },
  });

  await applyRules(groupId, actorId);
  const created = await queryOne<RuleRow>('SELECT * FROM user_group_rules WHERE id = ?', [id]);
  if (!created) throw new Error('rule vanished immediately after insert: ' + id);
  return created;
}

export async function deleteRule(
  groupId: string,
  ruleId: string,
  actorId: string | null,
): Promise<void> {
  await execute('DELETE FROM user_group_rules WHERE id = ? AND group_id = ?', [ruleId, groupId]);
  audit({
    action: 'user_group.rule.removed',
    actorId,
    targetType: 'user_group',
    targetId: groupId,
    detail: { rule: ruleId },
  });
  await applyRules(groupId, actorId);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface UserGroupRow {
  id: string;
  name: string;
  description: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserGroupWithCounts extends UserGroupRow {
  member_count: number;
  rule_count: number;
  /** How many ticket templates are offered only to this group. */
  template_count: number;
}

const ORDER = ' ORDER BY lower(name)';

/** One page of the list, searched in SQL by name or description. */
export async function searchUserGroups(q: string, page: number, perPage: number): Promise<{ rows: UserGroupWithCounts[]; total: number }> {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  const where = words.length
    ? ' WHERE ' + words.map(() => "(lower(g.name) LIKE ? ESCAPE '\\' OR lower(g.description) LIKE ? ESCAPE '\\')").join(' AND ')
    : '';
  const params = words.flatMap((w) => {
    const like = '%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    return [like, like];
  });
  const total = (await queryOne<{ n: number }>('SELECT count(*) AS n FROM user_groups g' + where, params))?.n ?? 0;
  const rows = await query<UserGroupWithCounts>(
    `SELECT g.*,
            (SELECT count(*) FROM user_group_members m WHERE m.group_id = g.id) AS member_count,
            (SELECT count(*) FROM user_group_rules r WHERE r.group_id = g.id) AS rule_count,
            (SELECT count(*) FROM ticket_template_visibility v WHERE v.group_id = g.id)
              AS template_count
       FROM user_groups g` + where + ORDER + ' LIMIT ? OFFSET ?',
    [...params, perPage, (page - 1) * perPage],
  );
  return { rows, total: Number(total) };
}

export function listUserGroups(): Promise<UserGroupWithCounts[]> {
  return query<UserGroupWithCounts>(
    `SELECT g.*,
            (SELECT count(*) FROM user_group_members m WHERE m.group_id = g.id) AS member_count,
            (SELECT count(*) FROM user_group_rules r WHERE r.group_id = g.id) AS rule_count,
            (SELECT count(*) FROM ticket_template_visibility v WHERE v.group_id = g.id)
              AS template_count
       FROM user_groups g` + ORDER,
  );
}

/** Groups a template may be restricted to. */
export function listActiveUserGroups(): Promise<UserGroupRow[]> {
  return query<UserGroupRow>('SELECT * FROM user_groups WHERE is_active = 1' + ORDER);
}

export function findUserGroup(id: string): Promise<UserGroupRow | undefined> {
  return queryOne<UserGroupRow>('SELECT * FROM user_groups WHERE id = ?', [id]);
}

export interface UserGroupInput {
  name: string;
  description: string;
  isActive: boolean;
}

async function assertNameFree(name: string, exceptId: string | null): Promise<void> {
  const clash = await queryOne<{ id: string }>(
    'SELECT id FROM user_groups WHERE lower(name) = lower(?)',
    [name],
  );
  if (clash && clash.id !== exceptId) {
    throw conflict('A user group with that name already exists.', 'user_group_name_taken');
  }
}

export async function createUserGroup(
  input: UserGroupInput,
  actorId: string | null,
): Promise<UserGroupRow> {
  await assertNameFree(input.name, null);

  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO user_groups (id, name, description, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.description, input.isActive ? 1 : 0, now, now],
  );

  audit({
    action: 'user_group.created',
    actorId,
    targetType: 'user_group',
    targetId: id,
    detail: { name: input.name },
  });

  const created = await findUserGroup(id);
  if (!created) throw new Error('user group vanished immediately after insert: ' + id);
  return created;
}

export async function updateUserGroup(
  id: string,
  input: UserGroupInput,
  actorId: string | null,
): Promise<UserGroupRow> {
  const existing = await findUserGroup(id);
  if (!existing) throw notFound('That user group no longer exists.');
  await assertNameFree(input.name, id);

  await execute(
    `UPDATE user_groups SET name = ?, description = ?, is_active = ?, updated_at = ?
      WHERE id = ?`,
    [input.name, input.description, input.isActive ? 1 : 0, nowIso(), id],
  );

  audit({
    action: 'user_group.updated',
    actorId,
    targetType: 'user_group',
    targetId: id,
    detail: { name: input.name, active: input.isActive },
  });

  const updated = await findUserGroup(id);
  if (!updated) throw new Error('user group disappeared during update: ' + id);
  return updated;
}

/**
 * Removes a group.
 *
 * Templates restricted to it become available to everybody again: the
 * visibility rows cascade away, and an empty audience means "anyone". That is
 * the safe direction - the alternative is a form nobody can see.
 */
export async function deleteUserGroup(id: string, actorId: string | null): Promise<void> {
  const existing = await findUserGroup(id);
  if (!existing) return;

  await execute('DELETE FROM user_groups WHERE id = ?', [id]);
  audit({
    action: 'user_group.deleted',
    actorId,
    targetType: 'user_group',
    targetId: id,
    detail: { name: existing.name },
  });
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface MemberRow extends UserRow {
  /** How they came to be in the group. */
  member_source: 'manual' | 'rule';
}

export function listUserGroupMembers(groupId: string): Promise<MemberRow[]> {
  return query<MemberRow>(
    `SELECT u.*, m.source AS member_source
       FROM user_group_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ?
      ORDER BY lower(u.display_name)`,
    [groupId],
  );
}

/** The groups one person is in, which decide the forms they are offered. */
export async function userGroupIdsFor(userId: string): Promise<string[]> {
  const rows = await query<{ group_id: string }>(
    `SELECT m.group_id
       FROM user_group_members m
       JOIN user_groups g ON g.id = m.group_id
      WHERE m.user_id = ? AND g.is_active = 1`,
    [userId],
  );
  return rows.map((row) => row.group_id);
}

export function userGroupsFor(userId: string): Promise<UserGroupRow[]> {
  return query<UserGroupRow>(
    `SELECT g.* FROM user_group_members m
       JOIN user_groups g ON g.id = m.group_id
      WHERE m.user_id = ?` + ' ORDER BY lower(g.name)',
    [userId],
  );
}

/** Adds or removes a hand-picked member. Rule members are left alone. */
export async function setManualMember(
  groupId: string,
  userId: string,
  wanted: boolean,
  actorId: string | null,
): Promise<void> {
  if (wanted) {
    await execute(
      `INSERT INTO user_group_members (group_id, user_id, source, added_at)
       VALUES (?, ?, 'manual', ?)
       ON CONFLICT (group_id, user_id) DO UPDATE SET source = 'manual'`,
      [groupId, userId, nowIso()],
    );
  } else {
    await execute(
      `DELETE FROM user_group_members
        WHERE group_id = ? AND user_id = ? AND source = 'manual'`,
      [groupId, userId],
    );
  }

  audit({
    action: wanted ? 'user_group.member.added' : 'user_group.member.removed',
    actorId,
    targetType: 'user_group',
    targetId: groupId,
    detail: { user: userId },
  });
}

/**
 * Recomputes one group's rule-derived membership.
 *
 * Only rows with `source = 'rule'` are touched. Somebody an administrator
 * added by hand stays whatever the rules say, because removing them would
 * silently undo a deliberate decision.
 *
 * Returns how many are now in by rule, which the page reports after a change
 * so the effect of a rule is visible immediately rather than next time
 * somebody signs in.
 */
export async function applyRules(groupId: string, actorId: string | null): Promise<number> {
  const rules = await listRules(groupId);
  const people = await query<UserRow>("SELECT * FROM users WHERE status = 'active'");
  const wanted = rules.length === 0 ? [] : people.filter((user) => matchesAny(user, rules));

  await transaction(async (client) => {
    await client.query("DELETE FROM user_group_members WHERE group_id = ? AND source = 'rule'", [
      groupId,
    ]);
    for (const user of wanted) {
      // A manual member stays manual: ON CONFLICT DO NOTHING rather than an
      // update, so the recompute cannot demote a deliberate choice.
      await client.query(
        `INSERT INTO user_group_members (group_id, user_id, source, added_at)
         VALUES (?, ?, 'rule', ?)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, user.id, nowIso()],
      );
    }
  });

  audit({
    action: 'user_group.rules.applied',
    actorId,
    targetType: 'user_group',
    targetId: groupId,
    detail: { rules: rules.length, matched: wanted.length },
  });

  return wanted.length;
}

/**
 * Recomputes every group, for when one account changed.
 *
 * Called after a sign-in, a SCIM write and an administrator editing somebody's
 * department - the three ways an attribute a rule reads can change. Cheap at
 * this scale: a handful of groups, a few rules each, one pass over the
 * active accounts.
 */
export async function applyAllRules(actorId: string | null = null): Promise<void> {
  const groups = await query<{ id: string }>(
    'SELECT DISTINCT group_id AS id FROM user_group_rules',
  );
  for (const group of groups) await applyRules(group.id, actorId);
}

/** A person's user groups and how each came about: by hand, or by a rule. */
export async function userGroupSourcesFor(userId: string): Promise<Map<string, 'manual' | 'rule'>> {
  const rows = await query<{ group_id: string; source: 'manual' | 'rule' }>(
    'SELECT group_id, source FROM user_group_members WHERE user_id = ?',
    [userId],
  );
  return new Map(rows.map((r) => [r.group_id, r.source]));
}

/**
 * Sets a person's hand-picked user groups from their own page: the ticked
 * ones are added, the unticked ones removed - only among the active groups
 * offered, and never a membership a rule made (a rule would put it back).
 * Returns how many changed.
 */
export async function setUserGroupsForUser(userId: string, wanted: readonly string[], actorId: string | null): Promise<number> {
  const groups = await listActiveUserGroups();
  const sources = await userGroupSourcesFor(userId);
  const want = new Set(wanted);
  let changed = 0;
  for (const group of groups) {
    const source = sources.get(group.id);
    if (source === 'rule') continue;
    const isMember = source === 'manual';
    if (want.has(group.id) !== isMember) {
      await setManualMember(group.id, userId, want.has(group.id), actorId);
      changed += 1;
    }
  }
  return changed;
}
