import { settings } from '../settings/index.js';
import { userGroupIdsFor } from '../services/user-groups.js';
import { enabledLanguages, type LanguageRow } from './index.js';
import { query } from '../db/index.js';

/**
 * Which language a reader gets.
 *
 * The owner's order, and the first answer wins (16 Oct 2026):
 *
 * 1. **What they chose**, on their profile.
 * 2. **Their user group**, which may be given a language or kept out of one.
 * 3. **Their email domain**, for somebody in no group.
 * 4. **Their browser**, when the service desk allows it.
 * 5. English.
 *
 * The first and the last are the ones that must never fail: a person who
 * chose a language keeps it wherever they sign in from, and anything this
 * cannot answer is English rather than empty.
 */

export interface Reader {
  id?: string | null;
  email?: string | null;
  language?: string | null;
}

/** Which groups are given, and which are kept out of, each language. */
let groupMap: Map<string, { assigned: Set<string>; excluded: Set<string> }> | null = null;

export function forgetLanguageGroups(): void {
  groupMap = null;
}

async function groupsByLanguage(): Promise<Map<string, { assigned: Set<string>; excluded: Set<string> }>> {
  if (groupMap) return groupMap;
  const rows = await query<{ language_tag: string; group_id: string; mode: string }>(
    'SELECT language_tag, group_id, mode FROM language_groups',
  );
  const map = new Map<string, { assigned: Set<string>; excluded: Set<string> }>();
  for (const row of rows) {
    const key = row.language_tag.toLowerCase();
    const entry = map.get(key) ?? { assigned: new Set<string>(), excluded: new Set<string>() };
    (row.mode === 'excluded' ? entry.excluded : entry.assigned).add(row.group_id);
    map.set(key, entry);
  }
  groupMap = map;
  return map;
}

/** The part after the @, lower-cased. */
function domainOf(email: string | null | undefined): string {
  const at = (email ?? '').lastIndexOf('@');
  return at < 0 ? '' : email!.slice(at + 1).toLowerCase();
}

/**
 * The best enabled language for one `Accept-Language` header.
 *
 * Longest match first, so `cs-CZ` beats `cs`, and `cs` still answers a
 * browser asking for `cs-SK` - which is why the tag is stored as a browser
 * writes it and no table of its own is needed.
 */
export function languageForHeader(header: string | undefined, languages = enabledLanguages()): string {
  if (!header || languages.length === 0) return '';
  const wanted = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: (tag ?? '').trim().toLowerCase(), q: q ? Number(q) : 1 };
    })
    .filter((entry) => entry.tag && entry.tag !== '*')
    .sort((a, b) => b.q - a.q);

  for (const entry of wanted) {
    const exact = languages.find((l) => l.tag.toLowerCase() === entry.tag);
    if (exact) return exact.tag;
  }
  for (const entry of wanted) {
    const base = entry.tag.split('-')[0]!;
    const near = languages.find((l) => l.tag.toLowerCase().split('-')[0] === base);
    if (near) return near.tag;
  }
  return '';
}

/**
 * The language for this reader and this request, as a tag, or '' for English.
 */
export async function languageFor(reader: Reader | null | undefined, acceptLanguage?: string): Promise<string> {
  const languages = enabledLanguages();
  if (languages.length === 0) return '';
  const on = (tag: string | null | undefined): LanguageRow | undefined =>
    tag ? languages.find((l) => l.tag.toLowerCase() === tag.toLowerCase()) : undefined;

  // 1. Their own choice. A language switched off falls through to the rules
  //    rather than leaving somebody on a language nobody can see.
  const chosen = on(reader?.language);
  if (chosen) return chosen.tag;
  // "English" is a choice too, and it is not "work it out".
  if ((reader?.language ?? '') === 'en') return '';

  const groups = reader?.id ? await userGroupIdsFor(reader.id) : [];
  const byGroup = await groupsByLanguage();

  // 2. A group that names a language, unless a group of theirs is kept out
  //    of it: the narrower statement wins, so "everybody in Prague except
  //    the English-speaking team" is two rules rather than a list.
  for (const language of languages) {
    const entry = byGroup.get(language.tag.toLowerCase());
    if (!entry) continue;
    if (groups.some((id) => entry.excluded.has(id))) continue;
    if (groups.some((id) => entry.assigned.has(id))) return language.tag;
  }

  // 3. The email domain, for somebody with no group that says anything.
  const domain = domainOf(reader?.email);
  if (domain) {
    const excludedEverywhere = (language: LanguageRow) => {
      const entry = byGroup.get(language.tag.toLowerCase());
      return !!entry && groups.some((id) => entry.excluded.has(id));
    };
    const byDomain = languages.find((l) => l.domains.includes(domain) && !excludedEverywhere(l));
    if (byDomain) return byDomain.tag;
  }

  // 4. The browser, when the service desk allows it.
  if (settings().locale.followBrowser) {
    const header = languageForHeader(acceptLanguage, languages);
    if (header) return header;
  }

  return '';
}

/** What a person may choose on their profile: the enabled languages. */
export function offeredLanguages(): LanguageRow[] {
  return enabledLanguages();
}
