import { execute, query, queryOne } from '../db/index.js';
import { settings } from '../settings/index.js';
import { nowIso } from '../lib/util.js';

/**
 * Display names built from a format: Settings - Users - Other settings.
 *
 * The format is text with variables in square brackets, such as
 *   [First] [Last] - ([Company])
 * Everything else - spaces, hyphens, commas, brackets - is kept as typed.
 *
 * Three rules make it read well for everybody, not only for complete
 * profiles:
 *  1. **Empty pieces tidy themselves away.** A variable with no value leaves
 *     nothing; then an empty pair of brackets goes, separators left at the
 *     start or end go, and doubled ones collapse. "Jan Novak - ()" becomes
 *     "Jan Novak".
 *  2. **The format applies only to somebody with a first or last name.**
 *     Without either, the name as the directory or the person gave it
 *     (display_name_source) is shown - "- (Contoso)" alone is not a name.
 *  3. **Never empty**: the source name, else the address.
 *
 * display_name stays the one column everything reads (lists, notifications,
 * the audit trail), so nothing else had to change; it is rewritten whenever
 * a person's names change and for everyone when the format is saved.
 */

export const NAME_VARIABLES = [
  { token: 'First', column: 'first_name', label: 'First name' },
  { token: 'Last', column: 'last_name', label: 'Last name' },
  { token: 'Company', column: 'company', label: 'Company' },
  { token: 'Department', column: 'department', label: 'Department' },
  { token: 'Job title', column: 'job_title', label: 'Job title' },
  { token: 'Office', column: 'office', label: 'Office' },
  { token: 'Email', column: 'email', label: 'Email address' },
  { token: 'Name', column: 'display_name_source', label: 'The name from the directory or as typed' },
] as const;

export interface NameParts {
  first_name: string;
  last_name: string;
  company: string;
  department: string;
  job_title: string;
  office: string;
  email: string;
  display_name_source: string;
}

const TOKEN = /\[([^\]]{1,40})\]/g;
const find = (token: string) => NAME_VARIABLES.find((v) => v.token.toLowerCase() === token.trim().toLowerCase());

/** Why a format cannot be used, or null. */
export function formatProblem(format: string): string | null {
  if (format.length > 200) return 'Keep the format under 200 characters.';
  const unknown = [...format.matchAll(TOKEN)].map((m) => m[1]!).filter((t) => !find(t));
  if (unknown.length > 0) return 'Unknown variable: [' + unknown[0] + ']. Use one of the variables listed.';
  if (format.trim() && [...format.matchAll(TOKEN)].length === 0) return 'Use at least one variable, such as [First] or [Last].';
  return null;
}

const SEPARATORS = '\\-\u2013\u2014,;:|/\u00b7';

/** Removes what empty variables left behind. */
export function tidy(text: string): string {
  let s = text.replace(/\s+/g, ' ');
  for (let i = 0; i < 4; i += 1) {
    s = s
      .replace(/\(\s*\)|\[\s*\]|\{\s*\}|<\s*>|"\s*"|'\s*'/g, '')
      // A run of separators (with spaces) becomes the first one.
      .replace(new RegExp('\\s*([' + SEPARATORS + '])(?:\\s*[' + SEPARATORS + '])+\\s*', 'g'), ' $1 ')
      .replace(new RegExp('^[\\s' + SEPARATORS + ']+|[\\s' + SEPARATORS + ']+$', 'g'), '')
      .replace(/\s+([,;:])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return s;
}

/** The display name for these parts under this format. */
export function buildDisplayName(parts: NameParts, format = settings().people.displayNameFormat): string {
  const fallback = parts.display_name_source.trim() || parts.email;
  if (!format.trim() || formatProblem(format)) return fallback;
  if (!parts.first_name.trim() && !parts.last_name.trim()) return fallback;
  const filled = format.replace(TOKEN, (_m, token: string) => {
    const v = find(token);
    return v ? String(parts[v.column] ?? '').trim() : '';
  });
  return tidy(filled).slice(0, 200) || fallback;
}

const PARTS = 'first_name, last_name, company, department, job_title, office, email, display_name_source, display_name';

/** Rewrites one person's display name from their parts. Returns it. */
export async function applyDisplayName(userId: string): Promise<string | null> {
  const row = await queryOne<NameParts & { display_name: string }>('SELECT ' + PARTS + ' FROM users WHERE id = ?', [userId]);
  if (!row) return null;
  const name = buildDisplayName(row);
  if (name !== row.display_name) await execute('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', [name, nowIso(), userId]);
  return name;
}

/** Rewrites everybody's, after the format changed. Returns how many changed. */
export async function applyAllDisplayNames(): Promise<number> {
  const rows = await query<NameParts & { id: string; display_name: string }>('SELECT id, ' + PARTS + ' FROM users');
  let changed = 0;
  const now = nowIso();
  for (const row of rows) {
    const name = buildDisplayName(row);
    if (name === row.display_name) continue;
    await execute('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', [name, now, row.id]);
    changed += 1;
  }
  return changed;
}

/** Splits "Jana Novakova" into first and last, for a form that has only one name. */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: parts[0] ?? '', last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}

/** A password account's own name, typed by an administrator; then the format. */
export async function setSourceName(userId: string, name: string): Promise<void> {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) return;
  await execute('UPDATE users SET display_name_source = ?, updated_at = ? WHERE id = ?', [clean, nowIso(), userId]);
  await applyDisplayName(userId);
}
