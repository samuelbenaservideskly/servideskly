import { execute, query, queryOne } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { newId, normaliseEmail, nowIso } from '../../lib/util.js';
import { routingGroupFor } from '../catalogue.js';
import { createTicket, type TicketListItem, type TicketRow } from '../tickets.js';
import { findTemplate, listTaskTemplates, type TemplateRow } from '../templates.js';
import type { IncomingMessage } from './transport.js';

/**
 * Mail automation: Settings - Mail - Advanced settings - Mail automation.
 *
 * "When the subject contains INC, raise the ticket from the Incident
 * template." Rules are tried in order, first match wins, and only for a mail
 * that is **not already part of a ticket**: the caller (ingest) has by then
 * ruled out a message it has seen before (mail_seen) and a reply to an
 * existing ticket (In-Reply-To, References, [INC-000123] in the subject).
 *
 * One more check is the rule's own, for the mail that is neither of those
 * but is still the same request again - sent twice, or re-sent without
 * quoting the first: an **open** ticket from the **same sender** with the
 * **same subject**, raised from the same template within the rule's window.
 * The sender has to match too, so two people writing "Printer broken" are
 * never merged into one ticket - the reason subject text alone is never
 * matched anywhere else.
 */

export const RULE_FIELDS = [
  { key: 'subject', label: 'Subject' },
  // Somebody writing in rarely puts the word in the subject and nowhere
  // else: "printer" is in the subject of one mail and the first line of the
  // next (asked for 16 Oct 2026, "and not just subject"). One rule covers
  // both rather than two rules that have to be kept in step.
  { key: 'subject_or_body', label: 'Subject or message text' },
  { key: 'from', label: 'Sender address' },
  { key: 'body', label: 'Message text' },
] as const;
export type RuleField = (typeof RULE_FIELDS)[number]['key'];

export const RULE_OPERATORS = [
  { key: 'contains', label: 'contains' },
  { key: 'starts_with', label: 'starts with' },
  { key: 'equals', label: 'is' },
  { key: 'ends_with', label: 'ends with' },
  { key: 'matches', label: 'matches the expression' },
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number]['key'];

export interface MailRuleRow {
  id: string;
  name: string;
  field: RuleField;
  operator: RuleOperator;
  value: string;
  template_id: string;
  /** Hours within which a repeat from the same sender is the same ticket; 0 turns it off. */
  dedupe_hours: number;
  is_enabled: boolean;
  sort_order: number;
  created_at: string;
}

export interface MailRuleInput {
  name: string;
  field: string;
  operator: string;
  value: string;
  templateId: string;
  dedupeHours: number;
  isEnabled: boolean;
}

export function listMailRules(): Promise<MailRuleRow[]> {
  return query<MailRuleRow>('SELECT * FROM mail_rules ORDER BY sort_order, created_at');
}

/** Why a rule cannot be saved, by field; empty when it can. */
export async function mailRuleProblems(input: MailRuleInput): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (!input.name.trim() || input.name.length > 80) errors.name = 'Give the rule a name of up to 80 characters.';
  if (!RULE_FIELDS.some((f) => f.key === input.field)) errors.field = 'Choose what to look at.';
  if (!RULE_OPERATORS.some((o) => o.key === input.operator)) errors.operator = 'Choose a comparison.';
  if (!input.value.trim() || input.value.length > 200) errors.value = 'Enter what to look for, up to 200 characters.';
  else if (input.operator !== 'matches' && input.value.split(';').every((part) => !part.trim())) {
    errors.value = 'Enter what to look for. A semicolon separates alternatives: print; printer; printing.';
  } else if (input.operator === 'matches') {
    try {
      new RegExp(input.value, 'i');
    } catch (err) {
      errors.value = 'That is not a valid expression: ' + (err instanceof Error ? err.message : 'it could not be read.');
    }
  }
  const template = input.templateId ? await findTemplate(input.templateId) : undefined;
  if (!template || template.parent_template_id) errors.templateId = 'Choose the template the ticket is raised from.';
  if (!(input.dedupeHours >= 0 && input.dedupeHours <= 720)) errors.dedupeHours = 'Between 0 and 720 hours.';
  return errors;
}

async function assertName(name: string, exceptId: string | null): Promise<void> {
  const clash = await queryOne<{ id: string }>('SELECT id FROM mail_rules WHERE lower(name) = lower(?)', [name]);
  if (clash && clash.id !== exceptId) throw conflict('A rule with that name already exists.', 'mail_rule_name_taken');
}

export async function createMailRule(input: MailRuleInput, actorId: string | null): Promise<string> {
  await assertName(input.name.trim(), null);
  const id = newId();
  const last = await queryOne<{ n: number }>('SELECT coalesce(max(sort_order), 0) AS n FROM mail_rules');
  await execute(
    `INSERT INTO mail_rules (id, name, field, operator, value, template_id, dedupe_hours, is_enabled, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.name.trim(), input.field, input.operator, input.value.trim(), input.templateId, Math.round(input.dedupeHours),
      input.isEnabled ? 1 : 0, (last?.n ?? 0) + 10, nowIso()],
  );
  audit({ action: 'mail.rule.created', actorId, targetType: 'mail_rule', targetId: id, detail: { name: input.name.trim() } });
  return id;
}

export async function updateMailRule(id: string, input: MailRuleInput, actorId: string | null): Promise<void> {
  const row = await queryOne<MailRuleRow>('SELECT * FROM mail_rules WHERE id = ?', [id]);
  if (!row) throw notFound('That rule no longer exists.');
  await assertName(input.name.trim(), id);
  await execute(
    `UPDATE mail_rules SET name = ?, field = ?, operator = ?, value = ?, template_id = ?, dedupe_hours = ?, is_enabled = ? WHERE id = ?`,
    [input.name.trim(), input.field, input.operator, input.value.trim(), input.templateId, Math.round(input.dedupeHours),
      input.isEnabled ? 1 : 0, id],
  );
  audit({ action: 'mail.rule.updated', actorId, targetType: 'mail_rule', targetId: id, detail: { name: input.name.trim() } });
}

export async function deleteMailRule(id: string, actorId: string | null): Promise<void> {
  await execute('DELETE FROM mail_rules WHERE id = ?', [id]);
  audit({ action: 'mail.rule.deleted', actorId, targetType: 'mail_rule', targetId: id });
}

/** Moves a rule one place up or down: the first match wins, so order matters. */
export async function moveMailRule(id: string, direction: 'up' | 'down', actorId: string | null): Promise<void> {
  const rules = await listMailRules();
  const at = rules.findIndex((r) => r.id === id);
  const other = direction === 'up' ? at - 1 : at + 1;
  if (at < 0 || other < 0 || other >= rules.length) return;
  [rules[at], rules[other]] = [rules[other]!, rules[at]!];
  for (const [i, rule] of rules.entries()) {
    await execute('UPDATE mail_rules SET sort_order = ? WHERE id = ?', [(i + 1) * 10, rule.id]);
  }
  audit({ action: 'mail.rule.moved', actorId, targetType: 'mail_rule', targetId: id, detail: { direction } });
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * What one rule looks for, as a list: a semicolon separates alternatives, so
 * "print; printer; printing" is one rule that any of the three satisfies
 * (asked for 16 Oct 2026). Three rules for one idea is three rules to keep in
 * step, and they would each need a name.
 *
 * **Never for "matches the expression".** A semicolon is an ordinary
 * character in a regular expression, and splitting one would quietly change
 * what it matches; an expression says "or" with `|` already.
 */
export function ruleAlternatives(rule: Pick<MailRuleRow, 'operator' | 'value'>): string[] {
  if (rule.operator === 'matches') return [rule.value];
  const parts = rule.value.split(';').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [rule.value.trim()];
}

/** Whether one rule picks out this message. */
export function ruleMatches(rule: Pick<MailRuleRow, 'field' | 'operator' | 'value'>, message: IncomingMessage): boolean {
  const raw =
    rule.field === 'from'
      ? normaliseEmail(message.from)
      : rule.field === 'body'
        ? message.body.slice(0, 20_000)
        : rule.field === 'subject_or_body'
          ? message.subject + '\n' + message.body.slice(0, 20_000)
          : message.subject;
  // Both sides lower-cased: a rule is about the words, never their case.
  const actual = raw.toLowerCase();
  // "starts with" and "ends with" are asked of each part on its own, so a
  // rule looking at the subject and the message text does not need the word
  // at the start of the subject *and* nothing after the body.
  const parts =
    rule.field === 'subject_or_body'
      ? [message.subject.trim().toLowerCase(), message.body.slice(0, 20_000).trim().toLowerCase()]
      : [actual.trim()];
  const alternatives = ruleAlternatives(rule).map((part) => part.toLowerCase());
  const any = (test: (wanted: string) => boolean) => alternatives.some(test);
  switch (rule.operator) {
    case 'contains':
      return any((wanted) => actual.includes(wanted));
    case 'starts_with':
      return parts.some((part) => any((wanted) => part.startsWith(wanted)));
    case 'ends_with':
      return parts.some((part) => any((wanted) => part.endsWith(wanted)));
    case 'equals':
      return parts.some((part) => any((wanted) => part === wanted));
    case 'matches':
      try {
        // Line by line and bounded, like signature patterns, so a careless
        // expression cannot hold the poller on one long line.
        const re = new RegExp(rule.value, 'i');
        return raw.split(/\r?\n/).some((line) => line.length <= 400 && re.test(line));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** The first enabled rule this message meets, with its template, or undefined. */
export async function firstMatchingRule(message: IncomingMessage): Promise<{ rule: MailRuleRow; template: TemplateRow } | undefined> {
  for (const rule of await listMailRules()) {
    if (!rule.is_enabled || !ruleMatches(rule, message)) continue;
    const template = await findTemplate(rule.template_id);
    // A template retired since the rule was written is skipped, not used.
    if (template && template.is_active && !template.parent_template_id) return { rule, template };
  }
  return undefined;
}

/**
 * The open ticket this mail repeats, if any: same sender, same subject, same
 * template, within the rule's window.
 */
export async function repeatOf(
  rule: MailRuleRow,
  cleanedSubject: string,
  fromAddress: string,
  senderId: string | null,
): Promise<TicketRow | undefined> {
  if (rule.dedupe_hours <= 0) return undefined;
  const since = new Date(Date.now() - rule.dedupe_hours * 3_600_000).toISOString();
  const from = normaliseEmail(fromAddress);
  const candidates = await query<TicketRow>(
    `SELECT * FROM tickets
      WHERE template_id = ? AND parent_id IS NULL AND created_at >= ?
        AND status NOT IN ('closed', 'cancelled')
        AND (requester_id = ? OR lower(external_email) = ?)
      ORDER BY created_at DESC`,
    [rule.template_id, since, senderId ?? '', from],
  );
  const subject = cleanedSubject.trim().toLowerCase();
  return candidates.find((t) => t.title.trim().toLowerCase() === subject);
}

/** Raises the ticket from the rule's template, with its tasks. */
export async function raiseFromRule(
  template: TemplateRow,
  input: { title: string; description: string; requesterId: string; externalEmail: string; fallbackGroupId: string | null },
): Promise<TicketListItem> {
  const groupId = template.group_id ?? (await routingGroupFor(template.category_id)) ?? input.fallbackGroupId;
  const ticket = await createTicket({
    title: input.title,
    description: template.body ? template.body + '\n\n' + input.description : input.description,
    priority: template.priority,
    category: template.category,
    requesterId: input.requesterId,
    externalEmail: input.externalEmail,
    templateId: template.id,
    type: template.type,
    groupId,
    categoryId: template.category_id,
    ...(template.close_when_tasks_done ? { closeWhenTasksDone: true } : {}),
    ...(template.require_tasks_done ? { requireTasksDone: true } : {}),
  });
  for (const task of await listTaskTemplates(template.id)) {
    await createTicket({
      title: task.title || task.name,
      description: task.body || task.summary || task.name,
      priority: task.priority,
      category: task.category,
      requesterId: input.requesterId,
      templateId: task.id,
      type: 'task',
      groupId: task.group_id ?? (await routingGroupFor(task.category_id)),
      categoryId: task.category_id,
      parentId: ticket.id,
      ...(task.task_mandatory ? { taskMandatory: true } : {}),
    });
  }
  return ticket;
}
