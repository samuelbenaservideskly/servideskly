import { AsyncLocalStorage } from 'node:async_hooks';
import { english, interpolateText, type Translate } from './index.js';

/**
 * The reader's language, for code that builds text itself.
 *
 * Most words are translated in a view. Some pages are put together in a
 * service - a requester's dashboards are HTML drawn in services/dashboards.ts,
 * the technician's clocks ("Responds in 1 h") in services/work-dashboard.ts -
 * and threading a translator through every function that draws one would
 * touch them all for the sake of a word each. So the language middleware
 * holds it for the length of the request, the same way a database
 * transaction holds its connection (db/index.ts), and such code asks for it:
 *
 *     const t = words();
 *     return t('Raised today');
 *
 * Outside a request - a job, a test, an email - it is English, which is what
 * every one of those wrote before.
 *
 * The catalogue finds `t('...')` and `tx('...', [...])` in code as it does in
 * a view (i18n/code-scan.ts), so a word written this way is in the
 * translator's document by itself.
 */

const current = new AsyncLocalStorage<Translate>();

/** Runs the rest of a request with this language. */
export function withWords<T>(translate: Translate, run: () => T): T {
  return current.run(translate, run);
}

/** The reader's `t()`, or English. */
export function words(): Translate {
  return current.getStore() ?? english;
}

/** The reader's `tx()` - a sentence with values, as plain text. */
export function wordsWith(): (pattern: string, parts: readonly unknown[]) => string {
  const translate = words();
  return (pattern, parts) => interpolateText(translate, pattern, parts);
}
