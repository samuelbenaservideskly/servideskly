import fs from 'node:fs';
import ejs from 'ejs';
import type { Express } from 'express';
import { logger } from '../lib/logger.js';
import { rewrite } from './extract.js';

const log = logger.child({ module: 'i18n/engine' });

/**
 * The views, compiled with their strings asking to be translated.
 *
 * Express's own EJS engine reads a view and compiles it. This does the same
 * with one step in between: `rewrite()` turns each of the reader's strings
 * into `t('...')` on the way past, **in memory**. The files on disk stay
 * plain English.
 *
 * Why in memory rather than a mechanical commit over two hundred views:
 *
 * - A view's diff is still a view's diff. Nobody reviewing a page change has
 *   to read past a thousand `t()` calls to find it.
 * - A string written today is translatable today, with nothing to remember -
 *   the owner's requirement, and the reason the catalogue is generated.
 * - With no language chosen `t()` returns its argument, so a rewritten
 *   template renders **byte-for-byte** what it rendered before. The whole
 *   existing test suite is therefore a test of the rewriter, which is the
 *   only way a change this wide could be made safely.
 *
 * `includer` is the part that is easy to miss: EJS reads an `include()`
 * itself, straight off the disk, so without it every partial - the header,
 * the footer, every dialog - would compile untranslated.
 */

/** Compiled templates, by path, when the view cache is on. */
const compiled = new Map<string, ejs.TemplateFunction>();

/** Rewritten sources, by path, so one page does not rewrite a partial twice. */
const sources = new Map<string, string>();

export function forgetViews(): void {
  compiled.clear();
  sources.clear();
}

function sourceOf(file: string, cache: boolean): string {
  if (cache) {
    const held = sources.get(file);
    if (held !== undefined) return held;
  }
  const text = fs.readFileSync(file, 'utf8');
  let out: string;
  try {
    out = rewrite(text, file);
  } catch (err) {
    // A view that cannot be rewritten is still a view: render the English
    // rather than failing the page. This has never happened, and if it ever
    // does the log is where it says so.
    log.error({ err, file }, 'a view could not be prepared for translation');
    out = text;
  }
  if (cache) sources.set(file, out);
  return out;
}

function templateOf(file: string, cache: boolean): ejs.TemplateFunction {
  if (cache) {
    const held = compiled.get(file);
    if (held) return held;
  }
  const fn = ejs.compile(sourceOf(file, cache), {
    filename: file,
    // EJS's own cache holds the compiled partials, keyed by their path - and
    // what it holds is the rewritten one, so the include is prepared once
    // rather than on every render. Off in development, where a view is
    // edited and reloaded.
    cache,
    /*
     * Every partial goes through the same rewriting. Without this EJS reads
     * an include() straight off the disk and the header, the footer and
     * every dialog would compile untranslated.
     *
     * Both fields are honoured (ejs/lib/ejs.js, includeFile): the filename
     * is what nested includes resolve against, the template is what gets
     * compiled. The published types allow only one at a time, which is
     * stricter than the implementation.
     */
    includer: ((_original: string, parsed: string) => ({
      filename: parsed,
      template: sourceOf(parsed, cache),
    })) as unknown as ejs.Options['includer'],
  });
  if (cache) compiled.set(file, fn);
  return fn;
}

/**
 * Install the engine. Nothing else about rendering changes: the same files,
 * the same locals, the same escaping.
 */
export function useTranslatedViews(app: Express): void {
  app.engine('ejs', (file: string, data: ejs.Data, cb: (err: Error | null, html?: string) => void) => {
    try {
      const cache = app.enabled('view cache');
      cb(null, templateOf(file, cache)(data));
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
