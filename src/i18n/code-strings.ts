import { SETTINGS_SECTIONS } from '../routes/settings-shared.js';
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from '../services/tickets.js';

/**
 * Reader text that lives in code rather than in a view.
 *
 * The extractor reads text nodes out of the views, which is most of the
 * interface but not all of it: the settings sections and their descriptions,
 * and the words for a status, a priority and a ticket type, are constants.
 * They were missing from a translated service desk - reported 16 Oct 2026,
 * with a Czech page whose section list was still in English.
 *
 * **Nothing here is a copy.** Each entry is *derived from the constant
 * itself*, so a section added next year is in the translator's document
 * without anybody remembering this file - which is the same promise the
 * generated catalogue makes for the views. A list of strings typed out here
 * would be exactly the thing the whole feature was built to avoid.
 *
 * A string in a **view** that is not a text node - a label built inside an
 * EJS tag, as the sidebar's are - needs no entry: wrap it in `t()` where it
 * is written and the catalogue picks the call up (see scan() in extract.ts).
 */

export interface CodeString {
  text: string;
  /** What this is, written for a translator. */
  context: string;
}

export function codeStrings(): CodeString[] {
  const out: CodeString[] = [];

  for (const section of SETTINGS_SECTIONS) {
    out.push({ text: section.title, context: 'A section of Settings, in the list on the left' });
    out.push({ text: section.blurb, context: 'The line under "' + section.title + '" in the Settings list' });
  }

  for (const label of Object.values(STATUS_LABELS)) {
    out.push({ text: label, context: "A ticket's status - a badge on the ticket and in the queue" });
  }
  for (const label of Object.values(PRIORITY_LABELS)) {
    out.push({ text: label, context: "A ticket's priority" });
  }
  for (const label of Object.values(TYPE_LABELS)) {
    out.push({ text: label, context: 'A kind of ticket - incident, service request, change' });
  }

  return out;
}
