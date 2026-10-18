import { settings } from '../../settings/index.js';

/**
 * Cutting a signature off a mailed reply.
 *
 * A reply arrives with the sender's name, job title, telephone number, legal
 * disclaimer and a quoted copy of everything said before it. None of that is
 * the answer, and a ticket where every comment ends in twenty lines of
 * boilerplate is a ticket nobody reads to the end.
 *
 * The patterns are an administrator's, under Settings - Mail - Ticket
 * automation, and the list ships **empty**: what an organisation signs off
 * with is theirs, and in their language. "Regards" is the obvious one in
 * English; "S pozdravem" is the obvious one here.
 *
 * The rule is deliberately blunt: find the **first line** that matches any
 * pattern, and drop that line and everything after it. A signature is always
 * at the end, so anything cleverer would be guessing.
 */

/**
 * A line longer than this is not tested.
 *
 * The patterns come from a form, so a careless one can backtrack
 * catastrophically - `(a+)+$` against a long line is the classic. Matching
 * only short lines bounds that: a signature marker is a few words, and a
 * 400-character line is prose or a pasted log, not "Kind regards".
 */
const MAX_LINE = 400;

/** Enough of a message must survive, or the cut was wrong. */
const MIN_KEPT = 1;

/**
 * Compiles a pattern the way the stripper will use it.
 *
 * Exported because the settings form validates with it: a pattern that cannot
 * compile is refused at the point it is typed, which is the only place
 * anybody can do anything about it.
 */
export function compileCut(pattern: string): RegExp {
  // Case-insensitive, because nobody types "Regards" the same way twice.
  return new RegExp(pattern, 'i');
}

/** The reason a pattern is not usable, or '' when it is. */
export function cutProblem(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) return 'A phrase cannot be empty.';
  if (trimmed.length > 200) return 'That phrase is too long.';
  try {
    compileCut(trimmed);
  } catch (err) {
    return 'That is not a valid expression: ' + (err instanceof Error ? err.message : 'it could not be read.');
  }
  return '';
}

/**
 * The message with its signature removed.
 *
 * Returns the original whenever the cut would leave nothing: a reply that is
 * only "Regards, Jan" is a real reply, and an empty comment is worse than a
 * polite one.
 */
export function stripSignature(body: string, patterns?: string[]): string {
  const cuts = patterns ?? settings().automation.signatureCuts;
  if (cuts.length === 0) return body;

  const compiled: RegExp[] = [];
  for (const cut of cuts) {
    try {
      compiled.push(compileCut(cut));
    } catch {
      // Stored before the validation existed, or edited in the database.
      // One bad pattern must not stop the others working.
    }
  }
  if (compiled.length === 0) return body;

  const lines = body.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line || line.length > MAX_LINE) continue;
    if (!compiled.some((pattern) => pattern.test(line))) continue;

    const kept = lines.slice(0, i).join('\n').trim();
    return kept.length >= MIN_KEPT ? kept : body;
  }

  return body;
}
