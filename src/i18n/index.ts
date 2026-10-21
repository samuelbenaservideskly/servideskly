import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { execute, query, queryOne, transaction } from '../db/index.js';
import { nowIso } from '../lib/util.js';
import { stringId, type CatalogueEntry } from './extract.js';

/**
 * Custom languages: the interface in somebody else's words.
 *
 * Asked for on 16 Oct 2026, and the design is in
 * docs/custom-language-brief.md. The short version:
 *
 * - The catalogue of English strings is **generated from the views**
 *   (`npm run strings`), so a feature written this afternoon is in the
 *   translator's document this afternoon. That was the owner's hardest
 *   requirement and it is the reason nothing here is hand-keyed.
 * - A language is a tag (`cs-CZ`), a name, a two-character label for the
 *   notification sub-tab, and one JSON document of translations keyed by
 *   string id.
 * - **Only the service desk's own text is translated.** A template name, a
 *   portal page, a category, a ticket - anything a person wrote - is left
 *   exactly as written. It is their text, and nothing here second-guesses
 *   which language it is in.
 * - A missing translation renders the English. A language is never a reason
 *   for a page to be empty, and a half-translated page beats a blank one.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The catalogue, as `npm run strings` last wrote it. */
export const catalogue: Record<string, CatalogueEntry> = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'strings.json'), 'utf8'),
) as Record<string, CatalogueEntry>;

export interface LanguageRow {
  tag: string;
  name: string;
  label: string;
  is_enabled: boolean;
  /** Email domains, parsed from JSON. */
  domains: string[];
  /** string id -> translation, parsed from JSON. */
  strings: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface LanguageGroupRow {
  language_tag: string;
  group_id: string;
  mode: 'assigned' | 'excluded';
}

/** A tag as a browser writes it: `cs`, `cs-CZ`, `pt-BR`. */
const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

export function tagProblem(tag: string): string {
  if (!TAG.test(tag.trim())) {
    return 'Use a language tag as a browser writes it: cs-CZ, de, pt-BR.';
  }
  return '';
}

/** `cs-CZ` is stored as the browser sends it, lower-cased for matching. */
export function normaliseTag(tag: string): string {
  const [language, ...rest] = tag.trim().split('-');
  return [language!.toLowerCase(), ...rest.map((part) => part.toUpperCase())].join('-');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function listLanguages(): Promise<LanguageRow[]> {
  return query<LanguageRow>('SELECT * FROM languages ORDER BY lower(name)');
}

export async function findLanguage(tag: string): Promise<LanguageRow | undefined> {
  return (
    (await queryOne<LanguageRow>('SELECT * FROM languages WHERE lower(tag) = lower(?)', [tag])) ?? undefined
  );
}

export function languageGroups(tag: string): Promise<LanguageGroupRow[]> {
  return query<LanguageGroupRow>(
    'SELECT language_tag, group_id, mode FROM language_groups WHERE lower(language_tag) = lower(?)',
    [tag],
  );
}

/** How much of the interface this language covers. */
export function coverage(row: Pick<LanguageRow, 'strings'>): { done: number; total: number } {
  const total = Object.keys(catalogue).length;
  const done = Object.keys(catalogue).filter((id) => (row.strings[id] ?? '').trim().length > 0).length;
  return { done, total };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface LanguageInput {
  tag: string;
  name: string;
  label: string;
}

export function languageProblems(input: LanguageInput): Record<string, string> {
  const errors: Record<string, string> = {};
  const tagSays = tagProblem(input.tag);
  if (tagSays) errors.tag = tagSays;
  if (!input.name.trim() || input.name.length > 60) errors.name = 'Name the language, up to 60 characters.';
  // The owner asked for exactly two characters here: it is a tab label, and
  // CZ beside EN reads as a pair where "Czech" beside "English" does not.
  if (!/^[A-Za-z]{2}$/.test(input.label.trim())) errors.label = 'Two letters, as the notification tab shows it: CZ.';
  return errors;
}

export async function createLanguage(input: LanguageInput, actorId: string | null): Promise<string> {
  const problems = languageProblems(input);
  const first = Object.values(problems)[0];
  if (first) throw badRequest(first);

  const tag = normaliseTag(input.tag);
  if (await findLanguage(tag)) throw conflict('That language is already here.', 'language_taken');

  await execute(
    `INSERT INTO languages (tag, name, label, is_enabled, domains, strings, created_at, updated_at)
     VALUES (?, ?, ?, 0, '[]', '{}', ?, ?)`,
    [tag, input.name.trim(), input.label.trim().toUpperCase(), nowIso(), nowIso()],
  );
  audit({ action: 'language.created', actorId, targetType: 'language', targetId: tag, detail: { name: input.name } });
  return tag;
}

export async function renameLanguage(tag: string, input: LanguageInput, actorId: string | null): Promise<void> {
  const row = await findLanguage(tag);
  if (!row) throw notFound('That language is no longer here.');
  const problems = languageProblems({ ...input, tag: row.tag });
  const first = Object.values(problems)[0];
  if (first) throw badRequest(first);
  await execute('UPDATE languages SET name = ?, label = ?, updated_at = ? WHERE tag = ?', [
    input.name.trim(),
    input.label.trim().toUpperCase(),
    nowIso(),
    row.tag,
  ]);
  audit({ action: 'language.renamed', actorId, targetType: 'language', targetId: row.tag });
}

/**
 * Switch a language on or off.
 *
 * Off leaves the translation where it is: a language switched off while it
 * is being checked must not cost the work. It is only ever offered, to
 * anybody, while it is on.
 */
export async function setLanguageEnabled(tag: string, enabled: boolean, actorId: string | null): Promise<void> {
  const row = await findLanguage(tag);
  if (!row) throw notFound('That language is no longer here.');
  await execute('UPDATE languages SET is_enabled = ?, updated_at = ? WHERE tag = ?', [
    enabled ? 1 : 0,
    nowIso(),
    row.tag,
  ]);
  await loadLanguages();
  audit({
    action: enabled ? 'language.enabled' : 'language.disabled',
    actorId,
    targetType: 'language',
    targetId: row.tag,
  });
}

export async function setLanguageDomains(tag: string, domains: string[], actorId: string | null): Promise<void> {
  const row = await findLanguage(tag);
  if (!row) throw notFound('That language is no longer here.');
  const cleaned = [...new Set(domains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  const bad = cleaned.find((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  if (bad) throw badRequest(`"${bad}" is not an email domain. Write contoso.com, one per line.`);
  if (cleaned.length > 50) throw badRequest('Up to 50 domains.');
  await execute('UPDATE languages SET domains = ?, updated_at = ? WHERE tag = ?', [
    JSON.stringify(cleaned),
    nowIso(),
    row.tag,
  ]);
  await loadLanguages();
  audit({ action: 'language.domains_set', actorId, targetType: 'language', targetId: row.tag, detail: { domains: cleaned } });
}

/** Which user groups get this language, and which are kept out of it. */
export async function setLanguageGroups(
  tag: string,
  assigned: string[],
  excluded: string[],
  actorId: string | null,
): Promise<void> {
  const row = await findLanguage(tag);
  if (!row) throw notFound('That language is no longer here.');
  // A group cannot be given and refused the same language; the refusal is
  // the narrower statement, so it wins rather than being resolved silently
  // somewhere later.
  const out = new Set(excluded);
  await transaction(async () => {
    await execute('DELETE FROM language_groups WHERE language_tag = ?', [row.tag]);
    for (const groupId of new Set([...assigned.filter((id) => !out.has(id)), ...excluded])) {
      await execute(
        'INSERT INTO language_groups (language_tag, group_id, mode, added_at) VALUES (?, ?, ?, ?)',
        [row.tag, groupId, out.has(groupId) ? 'excluded' : 'assigned', nowIso()],
      );
    }
  });
  await loadLanguages();
  audit({ action: 'language.groups_set', actorId, targetType: 'language', targetId: row.tag });
}

export async function deleteLanguage(tag: string, actorId: string | null): Promise<void> {
  const row = await findLanguage(tag);
  if (!row) throw notFound('That language is no longer here.');
  await transaction(async () => {
    // Anybody who chose it goes back to being worked out.
    await execute('UPDATE users SET language = ? WHERE lower(language) = lower(?)', ['', row.tag]);
    // ...and its notifications go with it: there is nothing left to send
    // them to, and the English rows are untouched.
    await execute('DELETE FROM mail_notifications WHERE language = ?', [row.tag]);
    await execute('DELETE FROM languages WHERE tag = ?', [row.tag]);
  });
  await loadLanguages();
  audit({ action: 'language.deleted', actorId, targetType: 'language', targetId: row.tag, detail: { name: row.name } });
}

// ---------------------------------------------------------------------------
// The translations themselves
// ---------------------------------------------------------------------------

export interface ImportResult {
  /** Rows the document carried. */
  rows: number;
  /** Rows whose id this catalogue knows. */
  matched: number;
  /** Rows for a string that has since changed or gone. */
  unknown: number;
  done: number;
  total: number;
}

/**
 * Read the table an AI handed back.
 *
 * Markdown, because that is what somebody pastes into a chat and gets back:
 * a row per string, the id first, the translation last. A row for an id this
 * catalogue does not know is **counted and dropped** rather than refused -
 * a string changed since the document was made is the normal case, and
 * refusing the whole file over it would mean doing the translation again.
 */
export function parseTranslationTable(markdown: string): { strings: Record<string, string>; rows: number; unknown: number } {
  const strings: Record<string, string> = {};
  let rows = 0;
  let unknown = 0;

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    // An escaped pipe is part of a cell, not a cell boundary.
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const id = cells[0] ?? '';
    if (!/^s[0-9a-f]{10}$/.test(id)) continue; // the header and its dashes
    rows += 1;
    const translation = unescapeCell(cells[cells.length - 1] ?? '');
    if (!catalogue[id]) {
      unknown += 1;
      continue;
    }
    if (translation) strings[id] = translation;
  }

  return { strings, rows, unknown };
}

/** A cell as the markdown holds it: pipes and newlines were escaped. */
function unescapeCell(cell: string): string {
  return cell.replace(/<br>/g, '\n').replace(/\\\|/g, '|').trim();
}

/** A cell as the markdown needs it. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export async function importTranslations(
  tag: string,
  markdown: string,
  actorId: string | null,
): Promise<ImportResult> {
  const row = await findLanguage(tag);
  if (!row) throw notFound('That language is no longer here.');
  const { strings, rows, unknown } = parseTranslationTable(markdown);
  if (rows === 0) {
    throw badRequest('No translation rows were found. Paste the whole table back, including the id column.');
  }

  await execute('UPDATE languages SET strings = ?, updated_at = ? WHERE tag = ?', [
    JSON.stringify(strings),
    nowIso(),
    row.tag,
  ]);
  await loadLanguages();

  const { done, total } = coverage({ strings });
  audit({
    action: 'language.imported',
    actorId,
    targetType: 'language',
    targetId: row.tag,
    // The words themselves are not the audit trail's business; how much
    // arrived is.
    detail: { rows, matched: rows - unknown, unknown, done, total },
  });
  return { rows, matched: rows - unknown, unknown, done, total };
}

/**
 * The document to hand an AI: the rules, then every string with its context.
 *
 * Generated from the catalogue each time, so it is never out of date - which
 * is the whole of the owner's "any new feature must be added automatically".
 */
export function translationMarkdown(row: Pick<LanguageRow, 'tag' | 'name' | 'strings'>): string {
  const lines: string[] = [];
  lines.push(`# Translate this service desk into ${row.name} (${row.tag})`);
  lines.push('');
  lines.push('Paste this whole document into an AI assistant and ask it to translate it.');
  lines.push('Then paste the table it gives back into Settings - Customisation - Locale.');
  lines.push('');
  lines.push('## Rules for the translation');
  lines.push('');
  lines.push('1. Return **the whole table**, with the `id` column exactly as it is.');
  lines.push('   The id is how each translation finds its way back.');
  lines.push('2. Fill in the last column only. Leave the English column alone.');
  lines.push('3. Keep `{{placeholders}}`, `<tags>` and references like `INC-000123`');
  lines.push('   exactly as they are.');
  lines.push('4. These are the words on buttons, labels and headings in an interface.');
  lines.push('   **Keep each one about as short as the English**: a button that is three');
  lines.push('   words in English cannot be eight.');
  lines.push('5. Use the formal register a workplace uses, and be consistent: the same');
  lines.push('   English word is one row here, so it is translated once.');
  lines.push('6. The `context` column says where the reader meets the words. Use it.');
  lines.push('   A row whose context lists **several** places - "A ticket\'s status / A');
  lines.push('   button" - is one word used in both, so choose one that reads correctly');
  lines.push('   in each. The same English string is one row by design: it is what keeps');
  lines.push('   the interface consistent.');
  lines.push('7. If a row should stay in English, leave its cell empty.');
  lines.push('');
  lines.push('## The strings');
  lines.push('');
  lines.push('| id | context | English | Translation |');
  lines.push('| --- | --- | --- | --- |');
  for (const [id, entry] of Object.entries(catalogue)) {
    lines.push(
      `| ${id} | ${escapeCell(entry.context)} | ${escapeCell(entry.text)} | ${escapeCell(row.strings[id] ?? '')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Serving a language
// ---------------------------------------------------------------------------

/**
 * The enabled languages, in memory.
 *
 * The same pattern as the settings cache, and for the same reason: `t()` is
 * called a few hundred times per page and cannot be asynchronous. One
 * process holds its own copy, and every writer above reloads it - a cache
 * that is merely emptied answers "no languages at all" to whatever reads it
 * next, which is a page in English for no reason anybody could see.
 */
let cached: LanguageRow[] | null = null;

export function forgetLanguages(): void {
  cached = null;
}

export async function loadLanguages(): Promise<LanguageRow[]> {
  cached = (await listLanguages()).filter((row) => row.is_enabled);
  return cached;
}

export function enabledLanguages(): LanguageRow[] {
  return cached ?? [];
}

/** The translator for one language: a missing string is the English. */
export type Translate = (text: string) => string;

/** A sentence with values in it, already escaped: "Last changed {0} by {1}". */
export type Interpolate = (pattern: string, parts: readonly unknown[]) => string;

export const english: Translate = (text) => text;

/**
 * A **value**, escaped exactly as `<%= %>` would escape it.
 *
 * It has to be exactly: with no language chosen, a rewritten template must
 * render byte-for-byte what it rendered before, and that property is what
 * makes the whole test suite a test of the rewriter.
 */
function escapeValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The **sentence**, escaped as little as text position needs.
 *
 * The pattern came from a view, where `Nothing matches "{0}".` had its
 * quotes as ordinary characters - escaping them would print `&quot;` where
 * the page used to show a quotation mark. What has to be escaped is what
 * could end text position and start markup: an ampersand and a less-than.
 * A translation is text somebody pasted in, so this is also the guard that
 * stops one carrying a tag onto the page.
 */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A sentence with its values put back, as HTML.
 *
 * **Everything is escaped, and in the right order**: the pattern first -
 * because a translation is text somebody pasted in, and nothing stops them
 * pasting a `<script>` - and then each value, which is a name, a count or
 * a date. The `{0}` markers survive escaping, so they are still there to
 * replace. The rewritten template prints the result with `<%- %>`, which
 * is only safe because of this function.
 *
 * A missing or empty value prints as empty rather than "undefined": a
 * sentence with a hole in it reads better than one with a bug in it.
 */
export function interpolate(translate: Translate, pattern: string, parts: readonly unknown[]): string {
  const offered = translate(pattern);
  /*
   * A translation that lost a marker takes the value with it - "Last
   * changed {0} by {1}" translated without the {0} would print a sentence
   * with no date in it, and nobody would know it was missing. The English
   * is used instead, which says the same thing and says all of it.
   */
  const markers = (text: string) => (text.match(/\{\d\}/g) ?? []).sort().join('');
  const translated = markers(offered) === markers(pattern) ? offered : pattern;
  return escapeText(translated).replace(/\{(\d)\}/g, (_whole, index: string) => {
    const value = parts[Number(index)];
    if (value === undefined || value === null) return '';
    return escapeValue(String(value));
  });
}

/**
 * The same sentence as **plain text**: `tx('Up to {0} files', [n])`.
 *
 * For a place that escapes what it is handed - an attribute, `<%= %>`, the
 * ⓘ's `text` - where the HTML `interpolate()` returns would be escaped twice.
 * Nothing here is escaped, so it must never go out through `<%- %>`.
 */
export function interpolateText(translate: Translate, pattern: string, parts: readonly unknown[]): string {
  const offered = translate(pattern);
  const markers = (text: string) => (text.match(/\{\d\}/g) ?? []).sort().join('');
  const chosen = markers(offered) === markers(pattern) ? offered : pattern;
  return chosen.replace(/\{(\d)\}/g, (_whole, index: string) => {
    const value = parts[Number(index)];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function textInterpolatorFor(translate: Translate): Interpolate {
  return (pattern, parts) => interpolateText(translate, pattern, parts);
}

/** The `tr` a template calls, bound to one language. */
export function interpolatorFor(translate: Translate): Interpolate {
  return (pattern, parts) => interpolate(translate, pattern, parts);
}

export function translatorFor(tag: string | null | undefined): Translate {
  if (!tag) return english;
  const row = enabledLanguages().find((l) => l.tag.toLowerCase() === tag.toLowerCase());
  if (!row) return english;
  /*
   * `strings` is JSON in a TEXT column; the data layer leaves it as text
   * when it cannot be parsed (a hand-edited row), so this checks rather
   * than trusting. Anything unreadable is English, which is the answer to
   * every other failure here too.
   */
  const table = row.strings && typeof row.strings === 'object' ? row.strings : {};
  return (text: string) => {
    const translated = table[stringId(text)];
    return typeof translated === 'string' && translated.trim() ? translated : text;
  };
}
