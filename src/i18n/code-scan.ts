import fs from 'node:fs';
import path from 'node:path';

/**
 * Reader text written in the code rather than in a view: the sentence a
 * service refuses with, the "Saved" a router flashes, a page's title.
 *
 * The views are read by extract.ts and the label lists by code-strings.ts.
 * These were the third kind, and the largest that was left in English on a
 * translated service desk (found 21 Oct 2026). They are shown through three
 * doors only - the flash list, a form's `errors` and the page title - and
 * i18n/localise.ts translates at those doors, so all this file has to do is
 * put the words in the translator's document. Like the rest of the
 * catalogue it is read from the source each time, so a message written
 * today is in the document today.
 *
 * What counts, deliberately narrow so the document does not fill with
 * things nobody reads:
 *
 * - **A sentence**: a single-quoted literal that starts with a capital,
 *   has at least two words and ends with `.`, `?` or `!`. The log lines in
 *   this code are lower-case and the error codes snake_case, so neither
 *   matches; a line that logs or audits is skipped all the same.
 * - **What a router flashes**: `flash(req, 'success', '...')`, sentence or not.
 * - **A page title** in a router: `title: '...'`.
 *
 * A sentence assembled with a value in it ("at most ' + n + ' files") is not
 * found, and stays English - the same rule the views follow.
 */

export interface CodeFound {
  text: string;
  context: string;
  where: string;
}

const LITERAL = String.raw`'((?:[^'\\\n]|\\.)*)'`;
const SENTENCE = new RegExp(LITERAL, 'g');
const FLASH = new RegExp(String.raw`\bflash\(\s*req\s*,\s*'[a-z]+'\s*,\s*` + LITERAL, 'g');
const TITLE = new RegExp(String.raw`\btitle:\s*` + LITERAL, 'g');
/** `t('...')` and `tx('...', [...])` - words code asks for by name (i18n/current.ts). */
const T_CALL = new RegExp(String.raw`\bt\(\s*` + LITERAL + String.raw`\s*\)`, 'g');
const TX_CALL = new RegExp(String.raw`\btx\(\s*` + LITERAL + String.raw`\s*,`, 'g');

/** Where the reader's sentences live. Not lib/ or db/, which talk to the code. */
const DIRS = ['routes', 'services', 'auth', 'middleware'];

function unescape(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

function isSentence(text: string): boolean {
  return (
    /^[A-Z]/.test(text) &&
    /\s\S/.test(text) &&
    /[.?!]$/.test(text) &&
    !/\{\{|\$\{/.test(text) &&
    // SQL ends with a placeholder `?` and starts with a capital too.
    !/^(SELECT|UPDATE|DELETE|INSERT|WITH|CREATE|ALTER|DROP|PRAGMA|BEGIN)\b/.test(text) &&
    !/\s=\s\?/.test(text)
  );
}

export function scanCode(source: string, where: string): CodeFound[] {
  const found: CodeFound[] = [];
  const isRouter = where.includes('/routes/');
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || /\b(log|logger|audit|console)\b[.(]/.test(line)) continue;
    for (const m of line.matchAll(FLASH)) {
      found.push({ text: unescape(m[1]!), context: 'A message shown after an action', where });
    }
    if (isRouter) {
      for (const m of line.matchAll(TITLE)) {
        const text = unescape(m[1]!);
        if (/[A-Za-z]/.test(text)) found.push({ text, context: 'The title of a page, in the browser tab', where });
      }
    }
    for (const m of line.matchAll(T_CALL)) {
      found.push({ text: unescape(m[1]!), context: 'Text drawn on a page', where });
    }
    for (const m of line.matchAll(TX_CALL)) {
      found.push({ text: unescape(m[1]!), context: 'Text drawn on a page. Keep each {0}, {1}...: it is a value', where });
    }
    for (const m of line.matchAll(SENTENCE)) {
      const text = unescape(m[1]!);
      if (isSentence(text)) found.push({ text, context: 'A message shown beside a form or after an action', where });
    }
  }
  return found;
}

/** Every .ts file the scan reads, in a stable order. */
export function codeFiles(srcDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  for (const dir of DIRS) {
    const full = path.join(srcDir, dir);
    if (fs.existsSync(full)) walk(full);
  }
  // Settings stays English (the owner's call, 21 Oct 2026): its routers are
  // the *-admin.ts files and settings.ts, and the files below serve only
  // Settings or answer machines in JSON (SCIM, the API, the webhooks), which
  // no page shows.
  const notForReaders =
    /-admin\.ts$|[\\/](settings|scim|hooks|api-[a-z-]+|api-examples|custom-images|automation[a-z-]*|portal|mail[\\/](relay|rules|transport))\.ts$/;
  return out.filter((file) => !notForReaders.test(file));
}
