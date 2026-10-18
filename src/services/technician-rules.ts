import { execute, query, queryOne, transaction } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import { RULE_ATTRIBUTES, RULE_OPERATORS, VALUELESS, matchesAny, type RuleRow } from './user-groups.js';
import type { UserRow } from './users.js';

/**
 * Dynamic membership for technician groups: the same rules user groups have
 * ("Department equals IT", any rule matching is enough), with one rule of
 * their own - **only active agents and administrators** are ever added. A
 * technician group is a queue, and a rule must never put a plain user in one.
 *
 * Membership rows carry a source. 'manual' rows are hand-picked and stay
 * whatever the rules say; 'rule' rows are recomputed, so somebody who
 * changes department, or stops being staff, drops out by themselves.
 */

export function listTechnicianRules(groupId: string): Promise<RuleRow[]> {
  return query<RuleRow>('SELECT * FROM technician_group_rules WHERE group_id = ? ORDER BY created_at', [groupId]);
}

export async function addTechnicianRule(
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
    throw conflict('Give the rule something to compare against, or use "is set" / "is empty".', 'rule_value_required');
  }

  const id = newId();
  await execute(
    'INSERT INTO technician_group_rules (id, group_id, attribute, operator, value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, groupId, attribute, operator, value, nowIso()],
  );
  audit({ action: 'group.rule.added', actorId, targetType: 'group', targetId: groupId, detail: { attribute, operator, value } });
  await applyTechnicianRules(groupId, actorId);
  const created = await queryOne<RuleRow>('SELECT * FROM technician_group_rules WHERE id = ?', [id]);
  if (!created) throw new Error('rule vanished immediately after insert: ' + id);
  return created;
}

export async function deleteTechnicianRule(groupId: string, ruleId: string, actorId: string | null): Promise<void> {
  await execute('DELETE FROM technician_group_rules WHERE id = ? AND group_id = ?', [ruleId, groupId]);
  audit({ action: 'group.rule.removed', actorId, targetType: 'group', targetId: groupId, detail: { rule: ruleId } });
  await applyTechnicianRules(groupId, actorId);
}

/** Recomputes one group's rule members. Returns how many are in by rule. */
export async function applyTechnicianRules(groupId: string, actorId: string | null): Promise<number> {
  const rules = await listTechnicianRules(groupId);
  // Staff only, whatever the rule says.
  const staff = await query<UserRow>("SELECT * FROM users WHERE status = 'active' AND role IN ('agent', 'admin')");
  const wanted = rules.length === 0 ? [] : staff.filter((user) => matchesAny(user, rules));

  await transaction(async (client) => {
    await client.query("DELETE FROM technician_group_members WHERE group_id = ? AND source = 'rule'", [groupId]);
    for (const user of wanted) {
      // A hand-picked member stays hand-picked.
      await client.query(
        `INSERT INTO technician_group_members (group_id, user_id, source, added_at)
         VALUES (?, ?, 'rule', ?)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupId, user.id, nowIso()],
      );
    }
  });
  audit({ action: 'group.rules.applied', actorId, targetType: 'group', targetId: groupId, detail: { rules: rules.length, matched: wanted.length } });
  return wanted.length;
}

/**
 * Every technician group with rules. Called wherever an account changes in
 * a way a rule could read: sign-in, an administrator editing the profile,
 * and a change of role - promotion can bring somebody in, demotion takes
 * them out.
 */
export async function applyAllTechnicianRules(actorId: string | null = null): Promise<void> {
  const groups = await query<{ id: string }>('SELECT DISTINCT group_id AS id FROM technician_group_rules');
  for (const group of groups) await applyTechnicianRules(group.id, actorId);
}
