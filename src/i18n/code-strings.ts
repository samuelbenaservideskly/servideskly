import { SETTINGS_SECTIONS } from '../routes/settings-shared.js';
import { CATEGORY_LABELS, PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from '../services/tickets.js';
import { SLA_STATE_LABELS } from '../services/sla.js';
import { MONTHS, RELATIVE_PATTERNS, ROLE_LABELS, WEEKDAYS_SHORT } from '../lib/format.js';
import { AVAILABILITY_STATUSES, COPYABLE_KINDS, SEVERITIES, WEEKDAYS } from '../services/dashboards.js';
import { REPORT_METRICS, SCOPES, WIDGET_KINDS } from '../services/boards.js';
import { AGE_BUCKETS, DRILL_METRICS, METRIC_DEFINITIONS, PERIODS } from '../services/reports.js';
import { ACTIVITY_KINDS } from '../services/work-dashboard.js';
import { BUILTIN_FIELDS } from '../services/templates.js';

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
  for (const label of Object.values(CATEGORY_LABELS)) {
    out.push({ text: label, context: "A ticket's broad category, on the ticket page" });
  }
  for (const label of Object.values(SLA_STATE_LABELS)) {
    out.push({ text: label, context: "A service-level clock's state - met, breached, at risk" });
  }
  for (const label of Object.values(ROLE_LABELS)) {
    out.push({ text: label, context: "A person's role - shown beside their name" });
  }
  for (const s of AVAILABILITY_STATUSES) {
    out.push({ text: s.label, context: "Where a technician is on a day - their availability" });
  }
  for (const day of WEEKDAYS) {
    out.push({ text: day, context: 'A day of the week' });
  }
  for (const day of WEEKDAYS_SHORT) {
    out.push({ text: day, context: 'A day of the week, shortened, as in "Due Thu 12:00"' });
  }
  for (const k of COPYABLE_KINDS) {
    out.push({ text: k.label, context: "A built-in dashboard's name, shown to requesters as its title" });
  }
  for (const s of SEVERITIES) {
    out.push({ text: s.label, context: 'How serious an announcement is' });
  }
  for (const k of WIDGET_KINDS) {
    out.push({ text: k.label, context: 'A kind of widget on a personal dashboard' });
    out.push({ text: k.hint, context: 'What the "' + k.label + '" widget shows' });
  }
  for (const m of REPORT_METRICS) {
    out.push({ text: m.label, context: 'A figure from Reports, shown on a dashboard widget' });
  }
  for (const s of SCOPES) {
    out.push({ text: s.label, context: 'Which tickets a list shows' });
  }
  for (const p of PERIODS) {
    out.push({ text: p.label, context: 'A period a report covers' });
  }
  for (const d of Object.values(METRIC_DEFINITIONS)) {
    out.push({ text: d.label, context: 'A figure in Reports' });
    out.push({ text: d.definition, context: 'What the "' + d.label + '" figure in Reports counts, shown when pointed at' });
  }
  for (const d of Object.values(DRILL_METRICS)) {
    out.push({ text: d.label, context: 'The tickets behind one figure in Reports - a page heading' });
  }
  for (const b of AGE_BUCKETS) {
    out.push({ text: b.label, context: 'How long a ticket has been open, a column in Reports' });
  }
  for (const k of ACTIVITY_KINDS) {
    out.push({ text: k.label, context: 'A sort of line in the Activity feed on the dashboard' });
    if (k.hint) out.push({ text: k.hint, context: 'What "' + k.label + '" lines in the Activity feed are' });
  }
  for (const f of BUILTIN_FIELDS) {
    out.push({ text: f.label, context: 'A field on the form a ticket is raised with' });
    if (f.placeholder && !f.placeholder.includes('@')) {
      out.push({ text: f.placeholder, context: 'The example shown inside the "' + f.label + '" box until something is typed' });
    }
  }
  for (const month of MONTHS) {
    out.push({ text: month, context: 'A month, shortened, in a date such as "21 Oct 2026"' });
  }
  for (const pattern of RELATIVE_PATTERNS) {
    out.push({
      text: pattern,
      context: 'How long ago something happened. Keep {0}: it is the number',
    });
  }

  return out;
}
