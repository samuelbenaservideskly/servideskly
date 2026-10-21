import type { Response } from 'express';
import type { Translate } from './index.js';
import { formatDate, formatDateTime, formatRelative } from '../lib/format.js';

/**
 * The words a page gets from code rather than from its view, translated at
 * the one moment every page passes through: rendering.
 *
 * The views translate their own text (engine.ts). What they did not cover is
 * text that arrives as a **value** - the label lists the routes hand over
 * (`statusLabels`, `typeLabels`, ...), the label helpers on `app.locals`
 * (`roleLabel()`, ...), and the date helpers, which spelled months and "just
 * now" in English. A Czech queue showed "Open" and "High" on every row
 * (found 21 Oct 2026, with a pseudo-language render of every page).
 *
 * Doing it here rather than at each of the forty-odd places a view prints a
 * label means a label list added next year is translated without anybody
 * remembering to - the same promise the generated catalogue makes. The words
 * themselves reach the translator's document through code-strings.ts.
 *
 * Only ever installed for a language other than English: an English page
 * renders byte-for-byte what it did, and the test suite stays a check of that.
 */
export function localise(res: Response, translate: Translate): void {
  const locals = res.app.locals as Record<string, unknown>;

  // roleLabel(), stateLabel()... - the same helper, its answer translated.
  for (const [name, value] of Object.entries(locals)) {
    if (/Label$/.test(name) && typeof value === 'function') {
      const helper = value as (...args: unknown[]) => unknown;
      res.locals[name] = (...args: unknown[]) => {
        const out = helper(...args);
        return typeof out === 'string' ? translate(out) : out;
      };
    }
  }

  res.locals.formatRelative = (iso: string | null | undefined) => formatRelative(iso, translate);
  res.locals.formatDate = (value: string | Date | null | undefined) => formatDate(value, translate);
  res.locals.formatDateTime = (value: string | Date | null | undefined) => formatDateTime(value, translate);

  const each = (value: unknown) =>
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? translate(v) : v]),
    );

  /*
   * What one render is handed: label lists (statusLabels, typeLabels...),
   * the page's title, and the refusals beside a form (`errors`, which
   * attempt() and the routes fill with the services' own sentences). Copied,
   * never changed in place - the label lists are the application's own
   * constants. A sentence built with a value in it ("at most 10 files") is
   * not in the catalogue and stays as it is.
   */
  const render = res.render.bind(res) as (view: string, options?: object, callback?: unknown) => void;
  res.render = ((view: string, options?: unknown, callback?: unknown) => {
    // "Saved", "Ticket updated": put in the session by one request, shown by the next.
    const flashes = res.locals.flashMessages;
    if (Array.isArray(flashes)) {
      res.locals.flashMessages = flashes.map((m: { message?: unknown }) =>
        m && typeof m.message === 'string' ? { ...m, message: translate(m.message) } : m,
      );
    }
    if (typeof options === 'function') return render(view, {}, options);
    if (options && typeof options === 'object') {
      const copy: Record<string, unknown> = { ...(options as Record<string, unknown>) };
      for (const [name, value] of Object.entries(copy)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        if (/Labels$/.test(name) || name === 'errors') copy[name] = each(value);
      }
      if (typeof copy.title === 'string') copy.title = translate(copy.title);
      return render(view, copy, callback);
    }
    return render(view, options as object | undefined, callback);
  }) as Response['render'];
}
