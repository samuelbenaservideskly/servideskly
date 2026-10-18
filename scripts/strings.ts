/**
 * Builds the catalogue of the reader's text: `npm run strings`.
 *
 * Walks every view, keys each string by its own content and writes
 * src/i18n/strings.json - which is what the translator's markdown and the
 * coverage count read. **Nothing here is maintained by hand**, which is the
 * requirement the whole feature hangs off: a string written this afternoon
 * is in the document this afternoon.
 *
 * `npm run verify` fails when the file is stale (tests/strings.test.ts), the
 * same way the PostgreSQL schema test fails when the schema drifts. A check,
 * not a promise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, stringId, type CatalogueEntry } from '../src/i18n/extract.js';
import { codeStrings } from '../src/i18n/code-strings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VIEWS_DIR = path.join(ROOT, 'views');
export const CATALOGUE_PATH = path.join(ROOT, 'src', 'i18n', 'strings.json');

/** Every .ejs under views, in a stable order so the file does not churn. */
export function viewFiles(dir = VIEWS_DIR): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...viewFiles(full));
    else if (entry.name.endsWith('.ejs')) out.push(full);
  }
  return out;
}

/** How many places one string's context names before it stops listing them. */
const CONTEXTS = 3;

/**
 * Add one string, or note that an existing one is used somewhere else too.
 *
 * **The context lists every kind of place the word appears**, up to three.
 * One row per English string is what keeps a 1,300-row document translatable
 * and a word translated once - but it means "Open" the status and "Open" the
 * button share a row, and in most languages those are different words. The
 * translator cannot know that from "A ticket's status" alone, so the row says
 * both and they can pick one that works, or the owner can edit the word
 * afterwards.
 */
function add(
  catalogue: Record<string, CatalogueEntry>,
  id: string,
  text: string,
  context: string,
  where: string,
): void {
  const existing = catalogue[id];
  if (!existing) {
    catalogue[id] = { text, context, where, uses: 1 };
    return;
  }
  existing.uses += 1;
  const seen = existing.context.split(' / ');
  if (!seen.includes(context) && seen.length < CONTEXTS) {
    existing.context = [...seen, context].join(' / ');
  }
}

/** The catalogue as it should be, read from the views and the code. */
export function buildCatalogue(): Record<string, CatalogueEntry> {
  const catalogue: Record<string, CatalogueEntry> = {};

  /*
   * The text that is a constant rather than a view - the settings sections,
   * the words for a status, a priority and a type. Derived from the
   * constants themselves (src/i18n/code-strings.ts), so a section added
   * later is in the document without anybody adding it here.
   */
  for (const entry of codeStrings()) {
    add(catalogue, stringId(entry.text), entry.text, entry.context, 'src/i18n/code-strings.ts');
  }

  for (const file of viewFiles()) {
    const where = path.relative(ROOT, file).replace(/\\/g, '/');
    const source = fs.readFileSync(file, 'utf8');
    for (const found of scan(source, where)) {
      add(catalogue, found.id, found.text, found.context, where);
    }
  }
  // Sorted by id, so two runs of the script give the same bytes.
  return Object.fromEntries(Object.entries(catalogue).sort(([a], [b]) => a.localeCompare(b)));
}

export function catalogueJson(catalogue: Record<string, CatalogueEntry>): string {
  return JSON.stringify(catalogue, null, 2) + '\n';
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const catalogue = buildCatalogue();
  fs.writeFileSync(CATALOGUE_PATH, catalogueJson(catalogue));
  const strings = Object.keys(catalogue).length;
  const uses = Object.values(catalogue).reduce((n, e) => n + e.uses, 0);
  console.log(`${strings} strings in ${uses} places -> ${path.relative(ROOT, CATALOGUE_PATH)}`);
  // A reminder of what is deliberately left alone, so nobody reads the
  // count as "the whole interface".
  console.log('(a sentence broken by a value or by inline markup is left in English - see src/i18n/extract.ts)');
  if (stringId('Save') !== stringId('Save')) throw new Error('ids are not stable');
}
