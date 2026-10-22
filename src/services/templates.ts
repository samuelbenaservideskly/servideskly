import { execute, query, queryOne, transaction } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import { TICKET_PRIORITIES } from './tickets.js';
import type { TicketCategory, TicketPriority, TicketType } from './tickets.js';

/**
 * Ticket templates.
 *
 * A template is a saved starting point: the category, priority and wording a
 * particular kind of request always needs, plus a short list of prompts for
 * the details the service desk would otherwise have to ask for.
 *
 * The prompts are deliberately not stored as columns or as their own table.
 * Their answers are folded into the ticket description at submission, so a
 * ticket raised from a template is an ordinary ticket: searchable, editable,
 * and unaffected if the template is later changed or retired.
 */

/**
 * What a template does to one field of the raise-a-ticket form.
 *
 * The form is not a fixed layout any more: a template holds an **ordered list
 * of fields**, mixing the built-in ones (title, category, priority,
 * description, attachments) with its own questions. Reordering a template
 * reorders the form.
 */
export const FIELD_MODES = ['optional', 'mandatory', 'view_only'] as const;
export type FieldMode = (typeof FIELD_MODES)[number];

export const MODE_LABELS: Record<FieldMode, string> = {
  optional: 'Optional',
  mandatory: 'Mandatory',
  view_only: 'View only',
};

export const MODE_HINTS: Record<FieldMode, string> = {
  optional: 'Shown. The requester may fill it in or leave it.',
  mandatory: 'Shown. The requester cannot submit without it.',
  view_only: 'Shown with the value this template sets, and not editable.',
};

export const BUILTIN_KEYS = [
  'title',
  'category',
  'subcategory',
  'item',
  'priority',
  'description',
  'attachments',
  'approval',
  'onbehalf',
  'requester',
  // Where the work goes, and who does it. Asked for 16 Oct 2026: a form
  // that cannot ask either has to be triaged by hand even when the person
  // raising it knows the answer.
  'group',
  'assignee',
] as const;
export type BuiltinKey = (typeof BUILTIN_KEYS)[number];

export interface BuiltinSpec {
  key: BuiltinKey;
  label: string;
  /** The modes that make sense for this field; the first is its default. */
  modes: readonly FieldMode[];
  hint: string;
  /**
   * The grey text inside the empty box, when the template sets none.
   *
   * Only fields that are typed into have one - a select prompts with its
   * first option and a file picker has nowhere to put it - and that is what
   * `acceptsPlaceholder` below is derived from.
   */
  placeholder?: string;
}

/** Whether this field is typed into, and so can carry ghost text. */
/**
 * The kinds of custom field a template can ask. A question carried over from
 * before types existed is plain text, so an absent type means 'text'.
 */
export const CUSTOM_FIELD_TYPES = [
  { key: 'text', label: 'Single line' },
  { key: 'textarea', label: 'Several lines' },
  { key: 'select', label: 'Choice' },
  { key: 'multiselect', label: 'Several choices' },
  { key: 'date', label: 'Date' },
  { key: 'number', label: 'Number' },
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]['key'];

export function isCustomFieldType(value: unknown): value is CustomFieldType {
  return CUSTOM_FIELD_TYPES.some((t) => t.key === value);
}

/** The types a requester chooses from a list, and so the ones with options. */
export function hasOptions(type: CustomFieldType | undefined): boolean {
  return type === 'select' || type === 'multiselect';
}

/** One option per line, trimmed, unique, at most 30 of up to 100 characters. */
export function parseOptions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const option = line.trim().slice(0, 100);
    if (option && !seen.has(option.toLowerCase())) {
      seen.add(option.toLowerCase());
      out.push(option);
    }
    if (out.length >= 30) break;
  }
  return out;
}

export function acceptsPlaceholder(field: { kind: string; key: string; fieldType?: CustomFieldType }): boolean {
  if (field.kind === 'question') return field.fieldType === undefined || ['text', 'textarea', 'number'].includes(field.fieldType);
  return builtinSpec(field.key)?.placeholder !== undefined;
}

/**
 * The built-in fields, and which modes each may take.
 *
 * Not every mode fits every field, and offering one that cannot work would
 * only produce a form that refuses itself:
 *
 * - **Title** can never be hidden or optional. A ticket with no title is
 *   unreadable in a queue, so a template either asks for one or fixes it.
 * - **Attachments** cannot be view only. There is no value to display; a
 *   template can require a file, or not ask for one.
 */
export const BUILTIN_FIELDS: readonly BuiltinSpec[] = [
  {
    key: 'title',
    label: 'Title',
    modes: ['mandatory', 'view_only'],
    hint: 'View only fixes it to the title this template sets. Every template needs this field before it can be offered.',
    placeholder: 'One line, e.g. “Cannot open the shared finance drive”',
  },
  {
    key: 'category',
    label: 'Category',
    modes: ['optional', 'mandatory', 'view_only'],
    hint: 'The top level of the catalogue. Leave it off the form to file every ticket under the category this template sets.',
  },
  {
    key: 'subcategory',
    label: 'Sub category',
    modes: ['optional', 'mandatory', 'view_only'],
    hint: 'The second level. Grouped by the category it belongs to, so the pairing is visible without having to choose one first.',
  },
  {
    key: 'item',
    label: 'Item',
    modes: ['optional', 'mandatory', 'view_only'],
    hint: 'The deepest level. The ticket is filed against the deepest of these three that is answered.',
  },
  {
    key: 'priority',
    label: 'Priority',
    modes: ['optional', 'mandatory', 'view_only'],
    hint: 'Leave it off the form to fix the priority to the one this template sets.',
  },
  {
    key: 'description',
    label: 'Description',
    modes: ['optional', 'mandatory', 'view_only'],
    hint: 'Left off, or view only, uses this template’s opening text unchanged.',
    placeholder:
      'What you were doing, what you expected, and what happened instead. Include any error message.',
  },
  {
    key: 'attachments',
    label: 'Attachments',
    modes: ['optional', 'mandatory'],
    hint: 'Mandatory means the ticket cannot be raised without a file.',
  },
  {
    key: 'approval',
    label: 'Send for approval',
    modes: ['optional', 'mandatory'],
    hint: 'An email address that has to approve the request before it can be resolved or closed. Mandatory means the ticket cannot be raised without one.',
    placeholder: 'manager@example.com',
  },
  {
    key: 'onbehalf',
    label: 'On behalf of',
    modes: ['optional', 'mandatory'],
    hint: 'The email address of the colleague the ticket is for. They become its requester; whoever filled in the form can still follow it.',
    placeholder: 'colleague@example.com',
  },
  {
    key: 'requester',
    label: 'Requester',
    modes: ['view_only'],
    hint: 'Shows who is raising the ticket, with the details ticked here. Nothing to fill in; the ticket shows the same details to the service desk.',
  },
  {
    key: 'group',
    label: 'Technician group',
    modes: ['optional', 'mandatory', 'view_only'],
    hint: 'Which team the ticket goes to. Left off the form, it is this template\'s group, or the one its category names - which is what every ticket did before.',
  },
  {
    key: 'assignee',
    label: 'Assignee',
    modes: ['optional', 'view_only'],
    hint: 'The person the ticket starts with. Only active agents and administrators are offered; left off, it arrives unassigned for the team to pick up.',
  },
] as const;

/** What the Requester field can show about the person, beside their name. */
export const REQUESTER_DETAILS = [
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'department', label: 'Department' },
  { key: 'job_title', label: 'Job title' },
  { key: 'office', label: 'Office' },
] as const;
export type RequesterDetail = (typeof REQUESTER_DETAILS)[number]['key'];
const DEFAULT_REQUESTER_DETAILS: RequesterDetail[] = ['email', 'phone'];

function readDetails(value: unknown): RequesterDetail[] {
  if (!Array.isArray(value)) return [...DEFAULT_REQUESTER_DETAILS];
  return REQUESTER_DETAILS.map((d) => d.key).filter((k) => value.includes(k));
}

/** The details a Requester field shows, as label and value, for one person. */
export function requesterDetails(
  field: { details?: readonly string[] } | undefined,
  person: Partial<Record<RequesterDetail, string | null>>,
): { label: string; value: string }[] {
  const wanted = field?.details ?? DEFAULT_REQUESTER_DETAILS;
  return REQUESTER_DETAILS.filter((d) => wanted.includes(d.key)).map((d) => ({ label: d.label, value: person[d.key] || '-' }));
}

export function builtinSpec(key: string): BuiltinSpec | undefined {
  return BUILTIN_FIELDS.find((spec) => spec.key === key);
}

/**
 * One field a template knows about.
 *
 * `placed` is the whole model: a template's form starts **empty** and holds
 * only what has been dragged onto it. A field that is not placed is not on
 * the form at all - for a built-in that means the template's own value is
 * used without asking, and for a question it means the wording is kept in the
 * palette for later rather than thrown away.
 */
/** How much of a section's row a field takes: one of two columns, or both. */
export type FieldWidth = 'half' | 'full';
export const FIELD_WIDTHS: readonly FieldWidth[] = ['half', 'full'];

/** Fields that read best across the whole row unless told otherwise. */
const FULL_BY_DEFAULT = new Set(['description', 'attachments']);

export function defaultWidth(key: string): FieldWidth {
  return FULL_BY_DEFAULT.has(key) ? 'full' : 'half';
}

/**
 * One field a template knows about - or a **section**, which is an entry in
 * the same list (`kind: 'section'`, key `s:<id>`, its title in `label`).
 * Everything after a section belongs to it until the next one, so ordering,
 * drag and drop and the arrows all keep working on one list. Sections never
 * reach templateLayout(), so nothing that reads a ticket's fields has to know
 * they exist; formSections() is what groups the fields for drawing.
 */
export interface TemplateField {
  /** Stable identity: a built-in key, `q:<id>` for a question, `s:<id>` for a section. */
  key: string;
  kind: 'builtin' | 'question' | 'section';
  /** The prompt. Empty on a built-in means "use its standard label". */
  label: string;
  mode: FieldMode;
  /** Shown in place of an input when the mode is view only. */
  value: string;
  /**
   * Ghost text inside the empty box.
   *
   * Empty means "use the standard one for this field". It replaces the line of
   * help that used to sit under every input: the same words, in the place the
   * reader is already looking, and gone the moment they start typing.
   */
  placeholder: string;
  /** On the form, in this list's order. A section is always placed. */
  placed: boolean;
  /** Half a row (the default) or all of it. Absent means the field's default. */
  width?: FieldWidth;
  /** On a question: what kind of answer it takes. Absent means single-line text. */
  fieldType?: CustomFieldType;
  /** On a choice question: what the requester picks from. */
  options?: string[];
  /** On a question placed from the custom-field library: which one it copies. */
  libraryId?: string;
  /** On the Requester field: which details to show beside the name. */
  details?: RequesterDetail[];
  /** On a section: labels above each control (default) or beside it. */
  labels?: SectionLabels;
  /** On a section: whether a requester can fold it away, and how it starts. */
  collapse?: SectionCollapse;
  /**
   * On a section: shown only when one of these answers is given. Empty or
   * absent means always shown. `field` is a field key ('priority', 'q:...').
   */
  showWhen?: SectionCondition[];
}

export interface SectionCondition {
  field: string;
  value: string;
}

export type SectionLabels = 'above' | 'beside';
export type SectionCollapse = 'none' | 'open' | 'closed';

/** A field resolved for rendering: the spec and the label already worked out. */
export interface LayoutField extends TemplateField {
  /** The label to print, the built-in's own if the template set none. */
  shown: string;
  /** Which modes the gear menu may offer. */
  modes: readonly FieldMode[];
  hint: string;
  /** The ghost text to print: the template's, or the field's standard one. */
  ghost: string;
  /** Whether this field can carry ghost text at all. */
  typed: boolean;
  /** Where the answer arrives in the submitted form. */
  input: string;
  /** Resolved: the stored width, or this field's default. */
  width: FieldWidth;
}

export interface TemplateRow {
  id: string;
  name: string;
  summary: string;
  title: string;
  body: string;
  priority: TicketPriority;
  category: TicketCategory;
  /** What kind of ticket this raises. */
  type: TicketType;
  /** Default technician group the raised ticket is routed to. */
  group_id: string | null;
  /** Default catalogue classification. */
  category_id: string | null;
  /** Set on a task template: the template it is raised alongside. */
  parent_template_id: string | null;
  /** On a task template: the task has to be done. */
  task_mandatory?: boolean;
  /** On a template with tasks: close the ticket once every mandatory task is done. */
  close_when_tasks_done?: boolean;
  /** On a template with tasks: no resolving or closing while a task is open. */
  require_tasks_done?: boolean;
  /** Parsed from the JSON column by the data layer. */
  fields: TemplateField[];
  is_active: boolean;
  /** The form raised when none was asked for. At most one row has this. */
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = 'SELECT * FROM ticket_templates';
/**
 * Alphabetical, always.
 *
 * Templates used to carry a sort_order, which meant choosing a number for
 * every one before it could be saved - a decision with no right answer for a
 * list read by name. The column still exists (migrations are forward-only)
 * and keeps its default; nothing reads it.
 */
const ORDER = ' ORDER BY lower(name)';

/**
 * Tasks run in the order they were attached.
 *
 * Sequence genuinely matters here - prepare the laptop before handing it over
 * - so unlike a template, a task keeps sort_order. Nobody types it:
 * addTaskTemplate numbers each new task after the last, so the order is the
 * order they were added.
 *
 * created_at alone would not do. Two tasks added in the same millisecond -
 * which a script, or a fast pair of clicks, manages easily - would come back
 * in whichever order the name happened to sort in.
 */
const TASK_ORDER = ' ORDER BY sort_order, created_at';

/** Guards against a hand-edited row: the column is text, not a typed array. */
function withFields(row: TemplateRow | undefined): TemplateRow | undefined {
  if (!row) return undefined;
  row.fields = normaliseFields(row.fields);
  return row;
}

/** The mode a stored value means, falling back rather than throwing. */
function readMode(raw: unknown, allowed: readonly FieldMode[]): FieldMode {
  const mode = FIELD_MODES.find((m) => m === raw);
  if (mode && allowed.includes(mode)) return mode;
  return allowed[0] ?? 'optional';
}

/**
 * Reads the stored field list, and migrates the one that came before it.
 *
 * Templates created before the form builder stored `{ label, required }` with
 * no key, no mode and no built-in fields. Those rows are still in the
 * database and are **not** rewritten on read - only interpreted: a question
 * keyed by its position, required becoming mandatory. The row is brought up to
 * date the next time the template is saved.
 */
export function normaliseFields(value: unknown): TemplateField[] {
  if (!Array.isArray(value)) return [];

  const fields: TemplateField[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    if (fields.length >= 60) return;
    const raw = entry as Record<string, unknown>;

    const rawKey = typeof raw.key === 'string' ? raw.key.trim() : '';
    const width = raw.width === 'full' || raw.width === 'half' ? (raw.width as FieldWidth) : undefined;

    // A section: a titled break in the form. Always on it.
    if (raw.kind === 'section') {
      if (!rawKey.startsWith('s:') || seen.has(rawKey)) return;
      seen.add(rawKey);
      fields.push({
        key: rawKey,
        kind: 'section',
        label: String(raw.label ?? '').trim().slice(0, 80),
        mode: 'optional',
        value: '',
        placeholder: '',
        placed: true,
        ...(raw.labels === 'beside' ? { labels: 'beside' as const } : {}),
        ...(raw.collapse === 'open' || raw.collapse === 'closed' ? { collapse: raw.collapse as SectionCollapse } : {}),
        ...(Array.isArray(raw.showWhen) && raw.showWhen.length > 0
          ? {
              showWhen: (raw.showWhen as unknown[])
                .filter((c): c is SectionCondition => !!c && typeof (c as SectionCondition).field === 'string' && typeof (c as SectionCondition).value === 'string')
                .slice(0, 30)
                .map((c) => ({ field: c.field.slice(0, 80), value: c.value.slice(0, 100) })),
            }
          : {}),
      });
      return;
    }

    const builtin = builtinSpec(rawKey);

    // A question: either keyed already, or a legacy entry keyed by position.
    if (!builtin) {
      const label = String(raw.label ?? '').trim();
      if (!label) return;
      const key = rawKey.startsWith('q:') ? rawKey : 'q:legacy' + index;
      if (seen.has(key)) return;
      seen.add(key);
      fields.push({
        key,
        kind: 'question',
        label: label.slice(0, 120),
        // The old shape had `required` and nothing else.
        mode:
          raw.mode === undefined
            ? raw.required === true
              ? 'mandatory'
              : 'optional'
            : readMode(raw.mode, FIELD_MODES),
        value: String(raw.value ?? '').slice(0, 2000),
        placeholder: String(raw.placeholder ?? '').slice(0, 200),
        // A question written before the builder was on the form by
        // definition, so an absent flag means placed.
        placed: raw.placed !== false,
        ...(width ? { width } : {}),
        ...(isCustomFieldType(raw.fieldType) && raw.fieldType !== 'text' ? { fieldType: raw.fieldType } : {}),
        ...(Array.isArray(raw.options)
          ? { options: parseOptions(raw.options.filter((o): o is string => typeof o === 'string').join('\n')) }
          : {}),
        ...(typeof raw.libraryId === 'string' && /^[0-9a-f-]{8,64}$/i.test(raw.libraryId) ? { libraryId: raw.libraryId } : {}),
      });
      return;
    }

    if (seen.has(builtin.key)) return;
    seen.add(builtin.key);
    fields.push({
      key: builtin.key,
      kind: 'builtin',
      label: String(raw.label ?? '').trim().slice(0, 120),
      mode: readMode(raw.mode, builtin.modes),
      value: '',
      placeholder: String(raw.placeholder ?? '').slice(0, 200),
      placed: raw.placed !== false,
      ...(width ? { width } : {}),
      ...(builtin.key === 'requester' ? { details: readDetails(raw.details) } : {}),
    });
  });

  return fields;
}

/** Decorates a stored field with everything a view needs to render it. */
function resolve(fields: readonly TemplateField[]): LayoutField[] {
  return fields.map((field) => {
    const spec = field.kind === 'builtin' ? builtinSpec(field.key) : undefined;
    return {
      ...field,
      shown: field.label || spec?.label || field.key,
      ghost: field.placeholder || spec?.placeholder || '',
      typed: acceptsPlaceholder(field),
      modes: spec ? spec.modes : FIELD_MODES,
      hint: spec?.hint ?? 'View only shows the text below instead of asking.',
      // Built-ins keep the names the ticket form has always used, so nothing
      // downstream of the form has to know the builder exists - and a
      // question carried over from before the builder keeps `field_<n>`, so
      // a form already open in somebody's browser still submits.
      input: inputNameFor(field),
      width: field.kind === 'section' ? 'full' : (field.width ?? defaultWidth(field.key)),
    };
  });
}

/**
 * The form this template describes, in order.
 *
 * **Only what has been placed.** A template's form starts empty and is built
 * up by dragging fields onto it, so an unplaced built-in is not a gap to fill
 * in - it is a deliberate "do not ask for this", and the template's own value
 * is used instead.
 */
export function templateLayout(template: TemplateRow): LayoutField[] {
  // Normalised again here rather than trusting the caller: this runs on rows
  // read through withFields, on a template being previewed before it is
  // saved, and on hand-built objects in tests. normaliseFields is idempotent,
  // and the list is at most a few dozen entries.
  return resolve(normaliseFields(template.fields).filter((field) => field.placed && field.kind !== 'section'));
}

/** A titled group of fields, drawn as one card in two columns. */
export interface FormSection {
  /** '' for the fields before the first section, which have no title. */
  key: string;
  title: string;
  fields: LayoutField[];
  labels: SectionLabels;
  collapse: SectionCollapse;
  /** Shown only when one of these answers is given; empty means always. */
  showWhen: SectionCondition[];
}

/**
 * The form grouped into its sections, in order.
 *
 * The fields before the first section form an untitled group. With
 * `keepEmpty` (the builder) a section with nothing in it is kept, so there is
 * somewhere to drop the first field; the ticket form leaves it out.
 */
export function formSections(template: TemplateRow, options: { keepEmpty?: boolean } = {}): FormSection[] {
  const placed = resolve(normaliseFields(template.fields).filter((f) => f.placed));
  const out: FormSection[] = [{ key: '', title: '', fields: [], labels: 'above', collapse: 'none', showWhen: [] }];
  for (const field of placed) {
    if (field.kind === 'section') {
      out.push({
        key: field.key,
        title: field.label,
        fields: [],
        labels: field.labels ?? 'above',
        collapse: field.collapse ?? 'none',
        showWhen: field.showWhen ?? [],
      });
    } else {
      out[out.length - 1]!.fields.push(field);
    }
  }
  return out
    .filter((s) => s.fields.length > 0 || (options.keepEmpty && s.key !== ''))
    // A section that must be filled in does not fold: a mandatory field a
    // requester folded away is a form that refuses to submit for no reason
    // they can see.
    .map((s) =>
      s.collapse !== 'none' && s.fields.some((f) => f.mode === 'mandatory' || f.key === 'title')
        ? { ...s, collapse: 'none' as const }
        : s,
    );
}

/** The standard form, with no template behind it: one untitled group. */
export function defaultSections(): FormSection[] {
  return [{ key: '', title: '', fields: defaultLayout(), labels: 'above', collapse: 'none', showWhen: [] }];
}

/** Every key on the form, sections included, in order. */
function placedKeys(template: TemplateRow): string[] {
  return normaliseFields(template.fields).filter((f) => f.placed).map((f) => f.key);
}

/** Everything in the palette: what this template could still put on the form. */
export interface Palette {
  /** Built-in fields not on the form. */
  builtins: LayoutField[];
  /** Questions written earlier and taken off the form, kept for re-use. */
  questions: LayoutField[];
}

export function availableFields(template: TemplateRow): Palette {
  const known = normaliseFields(template.fields);
  const onForm = new Set(known.filter((f) => f.placed).map((f) => f.key));

  const builtins = BUILTIN_FIELDS.filter((spec) => !onForm.has(spec.key)).map<TemplateField>(
    (spec) => {
      const parked = known.find((f) => f.key === spec.key);
      return {
        key: spec.key,
        kind: 'builtin',
        label: parked?.label ?? '',
        mode: parked?.mode ?? spec.modes[0] ?? 'optional',
        value: '',
        placeholder: parked?.placeholder ?? '',
        placed: false,
      };
    },
  );

  const questions = known.filter((f) => f.kind === 'question' && !f.placed);

  return { builtins: resolve(builtins), questions: resolve(questions) };
}

/** Where one field's answer arrives in the submitted form. */
function inputNameFor(field: TemplateField): string {
  if (field.kind === 'builtin') return BUILTIN_INPUT[field.key as BuiltinKey] ?? field.key;
  const legacy = /^q:legacy(\d+)$/.exec(field.key);
  return legacy ? 'field_' + legacy[1] : 'answer_' + field.key.slice(2);
}

/** The form control each built-in field submits under. */
const BUILTIN_INPUT: Record<BuiltinKey, string> = {
  title: 'title',
  category: 'categoryId',
  subcategory: 'subcategoryId',
  item: 'itemId',
  priority: 'priority',
  description: 'description',
  attachments: 'files',
  approval: 'approval',
  onbehalf: 'onBehalfOf',
  // Nothing is posted: it only shows who is asking.
  requester: 'requester',
  group: 'groupId',
  assignee: 'assigneeId',
};

/**
 * The fields a requester actually sees, in order.
 *
 * The same list as the builder's canvas: what is on the form is what is
 * shown, which is the point of building it by hand.
 */
export function visibleLayout(template: TemplateRow): LayoutField[] {
  return templateLayout(template);
}

/**
 * The form with no template behind it.
 *
 * The built-ins in their standard order, which is what the blank form has
 * always been - so the view can render one loop rather than one loop and a
 * hand-written copy of the same fields.
 *
 * Description is mandatory here, unlike its default under a template: with no
 * questions to carry the detail, a ticket with an empty description says
 * nothing.
 */
export function defaultLayout(): LayoutField[] {
  const blank: TemplateRow = {
    fields: BUILTIN_FIELDS.map((spec) => ({
      key: spec.key,
      kind: 'builtin' as const,
      label: '',
      mode: spec.key === 'description' ? 'mandatory' : (spec.modes[0] ?? 'optional'),
      value: '',
      placeholder: '',
      placed: true,
    })),
  } as TemplateRow;
  return templateLayout(blank);
}

/** Looks one field up by key, whether it is on the form or in the palette. */
export function layoutField(template: TemplateRow, key: string): LayoutField | undefined {
  const known = resolve(normaliseFields(template.fields)).find((field) => field.key === key);
  if (known) return known;
  // A built-in never touched by this template is still a field it may have.
  const spec = builtinSpec(key);
  if (!spec) return undefined;
  return resolve([
    {
      key: spec.key,
      kind: 'builtin',
      label: '',
      mode: spec.modes[0] ?? 'optional',
      value: '',
      placeholder: '',
      placed: false,
    },
  ])[0];
}

/**
 * Whether a template is finished enough to raise a ticket from.
 *
 * The canvas starts empty, so a template exists for a while with no form at
 * all. The one field it cannot do without is the title: a ticket with no
 * title is unreadable in a queue, and there is nothing sensible to invent.
 *
 * This is checked rather than enforced on save, because being half-built is a
 * normal state for a template and refusing to save one would be infuriating.
 */
export function isUsable(template: TemplateRow): boolean {
  return templateLayout(template).some((field) => field.key === 'title');
}

/**
 * Templates a requester may choose from.
 *
 * Unfinished ones are left out rather than offered and then failing: see
 * isUsable. The builder says so plainly on the template's own page.
 */
export async function listActiveTemplates(): Promise<TemplateRow[]> {
  // A task template is raised with its parent, never chosen on its own.
  const rows = await query<TemplateRow>(
    SELECT + ' WHERE is_active = 1 AND parent_template_id IS NULL' + ORDER,
  );
  return rows.map((row) => withFields(row)!).filter(isUsable);
}

/** Every template, including retired ones, for the administration page. */
export async function listAllTemplates(): Promise<TemplateRow[]> {
  const rows = await query<TemplateRow>(
    SELECT + ' WHERE parent_template_id IS NULL' + ORDER,
  );
  return rows.map((row) => withFields(row)!);
}

export async function findTemplate(id: string): Promise<TemplateRow | undefined> {
  return withFields(await queryOne<TemplateRow>(SELECT + ' WHERE id = ?', [id]));
}

export interface TemplateInput {
  name: string;
  summary: string;
  title: string;
  body: string;
  priority: TicketPriority;
  category: TicketCategory;
  type: TicketType;
  groupId: string | null;
  categoryId: string | null;
  parentTemplateId?: string | null;
  fields: TemplateField[];
  isActive: boolean;
}

export async function createTemplate(
  input: TemplateInput,
  actorId: string | null,
): Promise<TemplateRow> {
  await assertNameFree(input.name, null);

  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO ticket_templates
       (id, name, summary, title, body, priority, category, fields, is_active,
        created_by, type, group_id, category_id, parent_template_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.summary,
      input.title,
      input.body,
      input.priority,
      input.category,
      JSON.stringify(normaliseFields(input.fields)),
      input.isActive ? 1 : 0,
      actorId,
      input.type,
      input.groupId,
      input.categoryId,
      input.parentTemplateId ?? null,
      now,
      now,
    ],
  );

  const created = await findTemplate(id);
  if (!created) throw new Error('template vanished immediately after insert: ' + id);
  return created;
}

export async function updateTemplate(
  id: string,
  input: TemplateInput,
  _actorId: string | null,
): Promise<TemplateRow> {
  const existing = await findTemplate(id);
  if (!existing) throw notFound('That template no longer exists.');
  await assertNameFree(input.name, id);

  // A default may be switched off too (asked for 22 Oct 2026): New ticket
  // then opens the first working template instead (defaultTemplate).

  await execute(
    `UPDATE ticket_templates SET
        name = ?, summary = ?, title = ?, body = ?, priority = ?, category = ?,
        fields = ?, is_active = ?, type = ?, group_id = ?,
        category_id = ?, updated_at = ?
      WHERE id = ?`,
    [
      input.name,
      input.summary,
      input.title,
      input.body,
      input.priority,
      input.category,
      JSON.stringify(normaliseFields(input.fields)),
      input.isActive ? 1 : 0,
      input.type,
      input.groupId,
      input.categoryId,
      nowIso(),
      id,
    ],
  );

  const updated = await findTemplate(id);
  if (!updated) throw new Error('template disappeared during update: ' + id);
  return updated;
}

/**
 * Removes a template.
 *
 * Tickets keep a reference for reporting, which the schema clears on delete,
 * so removing a template never touches the tickets raised from it.
 */
export async function deleteTemplate(id: string): Promise<void> {
  const existing = await findTemplate(id);
  if (!existing) return;

  const refusal = protectedReason(existing);
  if (refusal) throw conflict(refusal, 'template_is_default');

  await execute('DELETE FROM ticket_templates WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// The form builder
// ---------------------------------------------------------------------------

/** Writes a field list back, leaving everything else about the template alone. */
async function saveFields(
  template: TemplateRow,
  fields: TemplateField[],
  actorId: string | null,
  action: string,
  detail: Record<string, unknown>,
): Promise<TemplateRow> {
  await execute('UPDATE ticket_templates SET fields = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(normaliseFields(fields)),
    nowIso(),
    template.id,
  ]);

  audit({
    action,
    actorId,
    targetType: 'template',
    targetId: template.id,
    detail: { template: template.name, ...detail },
  });

  const saved = await findTemplate(template.id);
  if (!saved) throw new Error('template disappeared while saving its fields: ' + template.id);
  return saved;
}

/**
 * Puts the fields in the given order.
 *
 * Keys the template does not have are ignored, and keys the caller left out
 * keep their relative order at the end. Both matter: the order arrives from a
 * form, so it can be stale by one edit, and a reorder must never be able to
 * delete a field.
 */
export function reorderFields(
  template: TemplateRow,
  order: readonly string[],
  actorId: string | null,
): Promise<TemplateRow> {
  const known = normaliseFields(template.fields);
  const current = known.filter((field) => field.placed);
  const parked = known.filter((field) => !field.placed);

  const ranked = new Map<string, number>();
  order.forEach((key, index) => {
    if (!ranked.has(key)) ranked.set(key, index);
  });

  const sorted = current
    .map((field, index) => ({ field, index }))
    .sort((a, b) => {
      const ra = ranked.get(a.field.key) ?? Number.MAX_SAFE_INTEGER;
      const rb = ranked.get(b.field.key) ?? Number.MAX_SAFE_INTEGER;
      // The original index breaks ties, so an unlisted field does not jump.
      return ra - rb || a.index - b.index;
    })
    .map((entry) => entry.field);

  // Parked fields ride along at the end: they are not on the form, but
  // losing the wording of a question somebody set aside would be a quiet
  // data loss on an action that is only meant to move things about.
  return saveFields(template, [...sorted, ...parked], actorId, 'template.fields.reordered', {
    order: sorted.map((f) => f.key),
  });
}

/** Moves one field one place up or down. The no-JavaScript path. */
export function moveField(
  template: TemplateRow,
  key: string,
  direction: 'up' | 'down',
  actorId: string | null,
): Promise<TemplateRow> {
  const keys = placedKeys(template);
  const from = keys.indexOf(key);
  if (from < 0) throw notFound('That field is not on this template.');

  // A section moves with everything in it, past the neighbouring section.
  if (key.startsWith('s:')) {
    const blocks: string[][] = [];
    for (const k of keys) {
      if (k.startsWith('s:') || blocks.length === 0) blocks.push([k]);
      else blocks[blocks.length - 1]!.push(k);
    }
    const at = blocks.findIndex((b) => b[0] === key);
    const other = direction === 'up' ? at - 1 : at + 1;
    // Never above the untitled fields at the top: they would join it.
    if (other < 0 || other >= blocks.length || !blocks[other]![0]!.startsWith('s:')) return Promise.resolve(template);
    [blocks[at], blocks[other]] = [blocks[other]!, blocks[at]!];
    return reorderFields(template, blocks.flat(), actorId);
  }

  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= keys.length) return Promise.resolve(template);

  const reordered = [...keys];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved!);
  return reorderFields(template, reordered, actorId);
}

/** Adds a section at the end of the form. Fields put after it belong to it. */
export function addSection(template: TemplateRow, title: string, actorId: string | null): Promise<TemplateRow> {
  const fields = normaliseFields(template.fields);
  if (fields.filter((f) => f.kind === 'section').length >= 12) {
    throw conflict('A form can have at most 12 sections.', 'too_many_sections');
  }
  const onForm = fields.filter((f) => f.placed);
  const parked = fields.filter((f) => !f.placed);
  onForm.push({ key: 's:' + newId(), kind: 'section', label: title.trim().slice(0, 80), mode: 'optional', value: '', placeholder: '', placed: true });
  return saveFields(template, [...onForm, ...parked], actorId, 'template.section.added', { section: title.trim() });
}

/**
 * A section's title and how it lays out. An empty title is allowed: the
 * section is just untitled. Options left out keep what they were.
 */
export function renameSection(
  template: TemplateRow,
  key: string,
  title: string,
  actorId: string | null,
  options: { labels?: SectionLabels; collapse?: SectionCollapse; showWhen?: SectionCondition[] } = {},
): Promise<TemplateRow> {
  const fields = normaliseFields(template.fields);
  if (!fields.some((f) => f.key === key && f.kind === 'section')) throw notFound('That section is not on this template.');
  return saveFields(
    template,
    fields.map((f) =>
      f.key === key
        ? {
            ...f,
            label: title.trim().slice(0, 80),
            ...(options.labels ? { labels: options.labels } : {}),
            ...(options.collapse ? { collapse: options.collapse } : {}),
            ...(options.showWhen ? { showWhen: options.showWhen.slice(0, 30) } : {}),
          }
        : f,
    ),
    actorId,
    'template.section.renamed',
    { section: title.trim(), ...options },
  );
}

export interface FieldSettings {
  mode: FieldMode;
  /** Only meaningful on a question. */
  label?: string;
  /** Only meaningful in view-only mode. */
  value?: string;
  /** Ghost text inside the box. Empty restores this field's standard one. */
  placeholder?: string;
  /** Half a row or all of it. */
  width?: FieldWidth;
  /** A question's kind of answer, and the options of a choice. */
  fieldType?: CustomFieldType;
  options?: string[];
  /** The Requester field's details. */
  details?: string[];
}

/**
 * The value a template sets for a built-in field.
 *
 * These used to sit in a second form above the builder, which meant the title,
 * category, priority and opening text each appeared twice on the page - once
 * as a setting and once as a field - and it was not obvious that they were the
 * same thing. They are set in the field's own gear now, which is the only
 * place that reads as "what this field does".
 *
 * The value still lives in its own column, not in the fields JSON: it is what
 * the raised ticket gets when the field is left off the form, so it has to be
 * there whether or not the form mentions it.
 */
export interface FieldDefault {
  /** Which control the gear should offer. */
  control: 'text' | 'textarea' | 'priority' | 'category';
  label: string;
  hint: string;
  /** For a catalogue control: which depth of the tree it chooses from. */
  level?: 1 | 2 | 3;
}

export const FIELD_DEFAULTS: Partial<Record<BuiltinKey, FieldDefault>> = {
  title: {
    control: 'text',
    label: 'Default title',
    hint: 'Prefilled into the title box, and used as it stands when this field is view only or off the form.',
  },
  category: {
    control: 'category',
    label: 'Default category',
    hint: 'What the ticket is filed under when the requester is not asked, or has not chosen.',
    level: 1,
  },
  subcategory: {
    control: 'category',
    label: 'Default sub category',
    hint: 'Setting this files the ticket at this depth, which implies its category too.',
    level: 2,
  },
  item: {
    control: 'category',
    label: 'Default item',
    hint: 'Setting this files the ticket at this depth, which implies its category and sub category too.',
    level: 3,
  },
  priority: {
    control: 'priority',
    label: 'Default priority',
    hint: 'What the ticket is raised at when the requester is not asked.',
  },
  description: {
    control: 'textarea',
    label: 'Opening text',
    hint: 'Starts the description. Used on its own when this field is view only or off the form.',
  },
};

/** What this template currently sets for a field, for the gear to show. */
export function fieldDefault(template: TemplateRow, key: string): string {
  switch (key) {
    case 'title':
      return template.title;
    case 'description':
      return template.body;
    case 'priority':
      return template.priority;
    case 'category':
    case 'subcategory':
    case 'item':
      // One stored node, read back by whichever level it sits at: a template
      // filed at "Hardware > Mouse" has a category of Hardware and an item of
      // Mouse, and neither gear should show the other's answer.
      return template.category_id ?? '';
    default:
      return '';
  }
}

/**
 * Writes the value a template sets for one built-in field.
 *
 * Validated here rather than trusted: the gear is a form, and an unknown
 * priority or a category that has since been deleted would otherwise be
 * written straight into the column every ticket is raised from.
 */
export async function setFieldDefault(
  template: TemplateRow,
  key: string,
  raw: string,
  actorId: string | null,
): Promise<void> {
  const spec = FIELD_DEFAULTS[key as BuiltinKey];
  if (!spec) return;

  let column: string;
  let value: string | null;

  switch (key) {
    case 'title':
      column = 'title';
      value = raw.slice(0, 200);
      break;
    case 'description':
      column = 'body';
      value = raw.slice(0, 8000);
      break;
    case 'priority': {
      column = 'priority';
      const allowed = TICKET_PRIORITIES.find((p) => p === raw);
      if (!allowed) throw conflict('That is not a priority.', 'bad_priority');
      value = allowed;
      break;
    }
    case 'category':
    case 'subcategory':
    case 'item': {
      column = 'category_id';
      if (!raw) {
        value = null;
        break;
      }
      const node = await queryOne<{ id: string; level: number }>(
        'SELECT id, level FROM ticket_categories WHERE id = ?',
        [raw],
      );
      if (!node) throw notFound('That category no longer exists.');
      if (node.level !== spec.level) {
        const what = spec.label.replace(/^Default /, '').toLowerCase();
        throw conflict(
          'That is not ' + (/^[aeiou]/.test(what) ? 'an ' : 'a ') + what + '.',
          'wrong_category_level',
        );
      }
      value = raw;
      break;
    }
    default:
      return;
  }

  await execute(
    'UPDATE ticket_templates SET ' + column + ' = ?, updated_at = ? WHERE id = ?',
    [value, nowIso(), template.id],
  );

  audit({
    action: 'template.field.default',
    actorId,
    targetType: 'template',
    targetId: template.id,
    detail: { template: template.name, field: key },
  });
}

/**
 * Applies the gear menu.
 *
 * The mode is checked against the field's own list rather than accepted as
 * given: a built-in that cannot be hidden must not become hidden because a
 * select was edited in the browser.
 */
export async function configureField(
  template: TemplateRow,
  key: string,
  settings: FieldSettings,
  actorId: string | null,
): Promise<TemplateRow> {
  const existing = layoutField(template, key);
  if (!existing) throw notFound('That field is not on this template.');

  const allowed = existing.modes;
  if (!allowed.includes(settings.mode)) {
    throw conflict(
      MODE_LABELS[settings.mode] + ' is not available for ' + existing.shown + '. ' + existing.hint,
      'field_mode_unavailable',
    );
  }

  if (existing.kind === 'question' && settings.label !== undefined && !settings.label.trim()) {
    throw conflict('A question needs a prompt.', 'field_label_required');
  }
  const nextType = settings.fieldType ?? existing.fieldType;
  if (existing.kind === 'question' && hasOptions(nextType) && (settings.options ?? existing.options ?? []).length < 2) {
    throw conflict('A choice needs at least two options, one per line.', 'field_options_required');
  }

  const fields = normaliseFields(template.fields).map((field) =>
    field.key !== key
      ? field
      : {
          ...field,
          label:
            field.kind === 'question' && settings.label !== undefined
              ? settings.label.trim().slice(0, 120)
              : field.label,
          mode: settings.mode,
          value: settings.value !== undefined ? settings.value.slice(0, 2000) : field.value,
          placeholder:
            settings.placeholder !== undefined
              ? settings.placeholder.slice(0, 200)
              : field.placeholder,
          ...(settings.width ? { width: settings.width } : field.width ? { width: field.width } : {}),
          ...(field.kind === 'question' && settings.fieldType !== undefined
            ? settings.fieldType === 'text'
              ? { fieldType: undefined }
              : { fieldType: settings.fieldType }
            : {}),
          ...(field.kind === 'question' && settings.options !== undefined ? { options: settings.options } : {}),
          ...(field.key === 'requester' && settings.details !== undefined ? { details: readDetails(settings.details) } : {}),
        },
  );

  return saveFields(template, fields, actorId, 'template.field.configured', {
    field: existing.shown,
    mode: settings.mode,
  });
}

/**
 * Puts a field on the form, at a position.
 *
 * Both halves of the builder end here: dropping a palette chip onto the
 * canvas, and the Add button beside it that does the same without a pointer.
 * `index` is where it lands; out of range means the end, which is what an Add
 * button wants.
 */
export function placeField(
  template: TemplateRow,
  key: string,
  index: number | null,
  actorId: string | null,
): Promise<TemplateRow> {
  const known = normaliseFields(template.fields);
  const spec = builtinSpec(key);
  const existing = known.find((field) => field.key === key);

  if (!existing && !spec) throw notFound('There is no such field.');
  if (existing?.placed) return Promise.resolve(template);

  const entry: TemplateField = existing
    ? { ...existing, placed: true }
    : {
        key: spec!.key,
        kind: 'builtin',
        label: '',
        mode: spec!.modes[0] ?? 'optional',
        value: '',
        placeholder: '',
        placed: true,
      };

  const onForm = known.filter((field) => field.placed && field.key !== key);
  const parked = known.filter((field) => !field.placed && field.key !== key);

  const at = index === null || index < 0 || index > onForm.length ? onForm.length : index;
  onForm.splice(at, 0, entry);

  return saveFields(template, [...onForm, ...parked], actorId, 'template.field.placed', {
    field: entry.label || spec?.label || key,
    at,
  });
}

/**
 * Takes a field off the form.
 *
 * Nothing is destroyed: the field moves back to the palette, keeping its mode
 * and - for a question - its wording, so taking something off to see how the
 * form reads without it costs nothing to undo.
 */
export function unplaceField(
  template: TemplateRow,
  key: string,
  actorId: string | null,
): Promise<TemplateRow> {
  const known = normaliseFields(template.fields);
  const existing = known.find((field) => field.key === key && field.placed);
  if (!existing) throw notFound('That field is not on this form.');

  // A section has nowhere to be parked: it goes, and its fields join the
  // section above.
  if (existing.kind === 'section') {
    return saveFields(template, known.filter((f) => f.key !== key), actorId, 'template.section.removed', {
      section: existing.label,
    });
  }

  const fields = known.map((field) =>
    field.key === key ? { ...field, placed: false } : field,
  );

  return saveFields(template, fields, actorId, 'template.field.unplaced', {
    field: existing.label || builtinSpec(key)?.label || key,
  });
}

/** Writes a new question, straight onto the form at the end. */
export function addQuestion(
  template: TemplateRow,
  label: string,
  actorId: string | null,
  kind: { fieldType?: CustomFieldType; options?: string[]; libraryId?: string } = {},
): Promise<TemplateRow> {
  const prompt = label.trim();
  if (!prompt) throw conflict('A question needs a prompt.', 'field_label_required');
  if (hasOptions(kind.fieldType) && (kind.options ?? []).length < 2) {
    throw conflict('A choice needs at least two options, one per line.', 'field_options_required');
  }

  const fields = normaliseFields(template.fields);
  if (fields.filter((f) => f.kind === 'question').length >= 20) {
    throw conflict(
      'A template can ask at most 20 questions. Anything longer is a form, not a ticket.',
      'too_many_questions',
    );
  }

  const onForm = fields.filter((f) => f.placed);
  const parked = fields.filter((f) => !f.placed);

  onForm.push({
    key: 'q:' + newId(),
    kind: 'question',
    label: prompt.slice(0, 120),
    mode: 'optional',
    value: '',
    placeholder: '',
    placed: true,
    ...(kind.fieldType && kind.fieldType !== 'text' ? { fieldType: kind.fieldType } : {}),
    ...(hasOptions(kind.fieldType) ? { options: kind.options ?? [] } : {}),
    // Several lines read better across the row.
    ...(kind.fieldType === 'textarea' ? { width: 'full' as const } : {}),
    ...(kind.libraryId ? { libraryId: kind.libraryId } : {}),
  });

  return saveFields(template, [...onForm, ...parked], actorId, 'template.field.added', {
    field: prompt,
  });
}

/**
 * Deletes a question outright, wording and all.
 *
 * Only a question: a built-in belongs to the ticket rather than the template,
 * so the most a template can do is leave it off the form.
 */
export function deleteQuestion(
  template: TemplateRow,
  key: string,
  actorId: string | null,
): Promise<TemplateRow> {
  const known = normaliseFields(template.fields);
  const existing = known.find((field) => field.key === key);
  if (!existing) throw notFound('That field is not on this template.');

  if (existing.kind !== 'question') {
    throw conflict(
      existing.label ||
        builtinSpec(key)?.label +
          ' belongs to the ticket rather than this template, so it can only be taken off the form.',
      'builtin_not_deletable',
    );
  }

  return saveFields(
    template,
    known.filter((field) => field.key !== key),
    actorId,
    'template.field.deleted',
    { field: existing.label },
  );
}

// ---------------------------------------------------------------------------
// The default template
// ---------------------------------------------------------------------------

/**
 * The template the raise-a-ticket form opens with when none was asked for.
 *
 * Retired templates are excluded: retiring one is how it is taken out of
 * circulation, and it would be surprising for that to leave it as the form
 * everybody still lands on.
 */
export async function defaultTemplate(type?: TicketType): Promise<TemplateRow | undefined> {
  // A type asks for that type's default; without one, the service desk's
  // own - the service request if it has one, else whichever is marked.
  const row = withFields(
    type
      ? await queryOne<TemplateRow>(
          SELECT + ' WHERE is_default = 1 AND is_active = 1 AND parent_template_id IS NULL AND type = ?',
          [type],
        )
      : ((await queryOne<TemplateRow>(
          SELECT +
            " WHERE is_default = 1 AND is_active = 1 AND parent_template_id IS NULL AND type = 'service_request'",
        )) ??
        (await queryOne<TemplateRow>(
          SELECT + ' WHERE is_default = 1 AND is_active = 1 AND parent_template_id IS NULL',
        ))),
  );
  if (row && isUsable(row)) return row;
  // The default switched off (allowed since 22 Oct 2026), or emptied: the
  // first working template that is on - of the type asked for, else a
  // service request, else any - rather than a form that cannot be sent.
  const candidates = (await query<TemplateRow>(
    SELECT + " WHERE is_active = 1 AND parent_template_id IS NULL AND type <> 'task' ORDER BY lower(name)",
  )).map(withFields).filter((t): t is TemplateRow => Boolean(t) && isUsable(t!));
  return (
    (type ? candidates.find((t) => t.type === type) : undefined) ??
    candidates.find((t) => t.type === 'service_request') ??
    candidates[0]
  );
}

/**
 * Makes one template the default, or clears the default entirely.
 *
 * Both writes happen in one transaction. Without that, clearing the old
 * default and setting the new one are two statements that the unique index
 * will reject in the wrong order - and a crash between them would leave no
 * default at all.
 */
export async function setDefaultTemplate(id: string, actorId: string | null): Promise<void> {
  const template = await findTemplate(id);
  if (!template) throw notFound('That template no longer exists.');

  if (template.parent_template_id) {
    throw conflict(
      'A task template is raised alongside its parent, so it cannot be the default.',
      'task_cannot_default',
    );
  }
  if (!template.is_active) {
    throw conflict(
      'A retired template cannot be the default. Make it active first.',
      'retired_cannot_default',
    );
  }
  if (!isUsable(template)) {
    throw conflict(
      'A template with no Title field on its form cannot be the default, because every ' +
        'ticket raised from it would have no title. Add Title to its form first.',
      'unfinished_cannot_default',
    );
  }

  // Moved within its own type, never cleared: there is always exactly one
  // default per type, so the only way out of being it is for another
  // template of that type to take it on. Clearing and setting happen in one
  // transaction; in the other order the partial unique index rejects it.
  await transaction(async (client) => {
    await client.query('UPDATE ticket_templates SET is_default = 0 WHERE is_default = 1 AND type = ?', [
      template.type,
    ]);
    await client.query('UPDATE ticket_templates SET is_default = 1 WHERE id = ?', [id]);
  });

  audit({
    action: 'template.default.set',
    actorId,
    targetType: 'template',
    targetId: id,
    detail: { name: template.name, type: template.type },
  });
}

/** The form every new template starts from when the system makes one. */
const STARTER_FORM: readonly { key: BuiltinKey; mode: FieldMode }[] = [
  { key: 'title', mode: 'mandatory' },
  { key: 'category', mode: 'optional' },
  { key: 'priority', mode: 'optional' },
  { key: 'description', mode: 'mandatory' },
  { key: 'attachments', mode: 'optional' },
];

/**
 * Guarantees there is a default template, creating one if there is not.
 *
 * Raising a ticket always goes through a form, and that form is a template -
 * so one has to exist before the first requester arrives, and it cannot be
 * left to an administrator to remember. This runs at start-up.
 *
 * It only ever *adds*. If a default is already set it does nothing, so
 * restarting never overwrites a form somebody has arranged.
 */
export async function ensureDefaultTemplate(): Promise<TemplateRow> {
  const existing = await queryOne<TemplateRow>(
    SELECT + ' WHERE is_default = 1 AND parent_template_id IS NULL',
  );
  if (existing) return withFields(existing)!;

  // A template that is already usable may as well become the default rather
  // than a second one appearing beside it.
  const candidates = (await listAllTemplates()).filter((t) => t.is_active && isUsable(t));
  const adopt = candidates[0];
  if (adopt) {
    await execute('UPDATE ticket_templates SET is_default = 1 WHERE id = ?', [adopt.id]);
    audit({
      action: 'template.default.set',
      actorId: null,
      targetType: 'template',
      targetId: adopt.id,
      detail: { name: adopt.name, reason: 'no default was set' },
    });
    return (await findTemplate(adopt.id))!;
  }

  const created = await createTemplate(
    {
      name: await freeName('Default Incident request'),
      summary: 'The form a ticket is raised on when no other template is chosen.',
      title: '',
      body: '',
      priority: 'normal',
      category: 'other',
      type: 'incident',
      groupId: null,
      categoryId: null,
      fields: STARTER_FORM.map((entry) => ({
        key: entry.key,
        kind: 'builtin' as const,
        label: '',
        mode: entry.mode,
        value: '',
        placeholder: '',
        placed: true,
      })),
      isActive: true,
    },
    null,
  );

  await execute('UPDATE ticket_templates SET is_default = 1 WHERE id = ?', [created.id]);
  audit({
    action: 'template.default.created',
    actorId: null,
    targetType: 'template',
    targetId: created.id,
    detail: { name: created.name },
  });

  return (await findTemplate(created.id))!;
}

/**
 * A ticket template made by an automation: a copy of another template's form
 * and defaults (not its tasks), or the standard five fields. Offered to
 * requesters only when asked - something another system created is checked
 * by a person first, unless the automation says otherwise.
 */
export async function createTemplateFrom(
  input: { name: string; summary: string; type: Exclude<TicketType, 'task'>; basedOnId: string | null; isActive: boolean },
  actorId: string | null,
): Promise<TemplateRow> {
  const base = input.basedOnId ? await findTemplate(input.basedOnId) : undefined;
  if (input.basedOnId && !base) throw notFound('The template it is based on no longer exists.');
  const created = await createTemplate(
    {
      name: input.name,
      summary: input.summary,
      title: base?.title ?? '',
      body: base?.body ?? '',
      priority: base?.priority ?? 'normal',
      category: base?.category ?? 'other',
      type: input.type,
      groupId: base?.group_id ?? null,
      categoryId: base?.category_id ?? null,
      fields: base
        ? base.fields.map((f) => ({ ...f }))
        : STARTER_FORM.map((entry) => ({
            key: entry.key,
            kind: 'builtin' as const,
            label: '',
            mode: entry.mode,
            value: '',
            placeholder: '',
            placed: true,
          })),
      isActive: input.isActive,
    },
    actorId,
  );
  audit({
    action: 'template.created',
    actorId,
    targetType: 'template',
    targetId: created.id,
    detail: { name: created.name, by: 'automation', basedOn: base?.name ?? null },
  });
  return created;
}

/**
 * A copy of one template, with its form, its defaults and its tasks.
 *
 * Asked for 16 Oct 2026. Most templates on a service desk are a variation
 * of one that already works, and building the second one field by field is
 * the long way round.
 *
 * Three things it deliberately does:
 *
 * - **The tasks come too.** `createTemplateFrom` leaves them (an automation
 *   making a template from another should not quietly raise work nobody
 *   asked for), but somebody pressing Duplicate wants the whole thing.
 * - **It is never the default**, and it is **not offered to requesters**
 *   until somebody says so: a copy is a draft, and two identical forms in
 *   the catalogue is a worse first impression than none.
 * - The name is "<name> (copy)", or the next free number after it, so
 *   pressing it twice does not fail on the unique name.
 */
export async function duplicateTemplate(id: string, actorId: string | null): Promise<TemplateRow> {
  const source = await findTemplate(id);
  if (!source) throw notFound('That template no longer exists.');
  if (source.parent_template_id) throw badRequest('A task template is copied with the template it belongs to.');

  const freeCopyName = async (wanted: string): Promise<string> => {
    let name = wanted + ' (copy)';
    for (let n = 2; await findTemplateByName(name); n += 1) name = wanted + ' (copy ' + n + ')';
    return name;
  };

  const name = await freeCopyName(source.name);

  const copy = await createTemplate(
    {
      name,
      summary: source.summary,
      title: source.title,
      body: source.body,
      priority: source.priority,
      category: source.category,
      type: source.type as Exclude<TicketType, 'task'>,
      groupId: source.group_id,
      categoryId: source.category_id,
      fields: source.fields.map((f) => ({ ...f })),
      isActive: false,
    },
    actorId,
  );

  for (const task of await listTaskTemplates(source.id)) {
    // A task template's name is unique too, in the same space as every
    // other template - so each copied task needs its own free name.
    await addTaskTemplate(
      copy.id,
      {
        name: await freeCopyName(task.name),
        summary: task.summary,
        title: task.title,
        body: task.body,
        priority: task.priority,
        category: task.category,
        type: task.type as Exclude<TicketType, 'task'>,
        groupId: task.group_id,
        categoryId: task.category_id,
        fields: task.fields.map((f) => ({ ...f })),
        isActive: task.is_active,
      },
      actorId,
    );
  }

  audit({
    action: 'template.duplicated',
    actorId,
    targetType: 'template',
    targetId: copy.id,
    detail: { name: copy.name, from: source.name },
  });
  return copy;
}

/** The template of that name, if any (names are unique, any case). */
export async function findTemplateByName(name: string): Promise<TemplateRow | undefined> {
  return withFields(await queryOne<TemplateRow>(SELECT + ' WHERE lower(name) = lower(?)', [name]));
}

/** A name nothing else holds, so start-up cannot fail on a collision. */
async function freeName(wanted: string): Promise<string> {
  for (let suffix = 0; suffix < 50; suffix++) {
    const name = suffix === 0 ? wanted : wanted + ' ' + (suffix + 1);
    const clash = await queryOne<{ id: string }>(
      'SELECT id FROM ticket_templates WHERE lower(name) = lower(?)',
      [name],
    );
    if (!clash) return name;
  }
  return wanted + ' ' + newId().slice(0, 8);
}

/**
 * Why this template cannot be removed or retired, or null if it can be.
 *
 * The default is the form every ticket is raised on, so taking it away would
 * leave requesters with nothing. Making another template the default is the
 * way out - which is a step the administrator takes deliberately rather than
 * something that happens as a side effect of a delete.
 */
export function protectedReason(template: TemplateRow): string | null {
  if (!template.is_default) return null;
  return (
    'This is the default template, so it is the form every ticket is raised on. ' +
    'Make another template the default first, then this one can be removed.'
  );
}

async function assertNameFree(name: string, exceptId: string | null): Promise<void> {
  const clash = await queryOne<{ id: string }>(
    'SELECT id FROM ticket_templates WHERE lower(name) = lower(?)',
    [name],
  );
  if (clash && clash.id !== exceptId) {
    throw conflict('A template with that name already exists.', 'template_name_taken');
  }
}

/**
 * Builds the description for a ticket raised from a template.
 *
 * The template body comes first, then each prompt with the answer given. A
 * prompt left blank is omitted rather than written out empty, so the result
 * reads like something a person wrote.
 */
export function composeDescription(
  template: TemplateRow,
  answers: Record<string, string>,
  skip: ReadonlySet<string> = new Set(),
): string {
  const parts: string[] = [];
  const body = template.body.trim();
  if (body) parts.push(body);

  // Only the questions on the form: one taken off is not asked, so it has
  // nothing to contribute.
  for (const field of templateLayout(template)) {
    if (field.kind !== 'question' || skip.has(field.key)) continue;
    // A view-only question is the template talking, not the requester: its own
    // value is written out, and whatever was submitted for it is ignored.
    const answer = (field.mode === 'view_only' ? field.value : answers[field.input] ?? '').trim();
    if (!answer) continue;
    parts.push(field.shown.replace(/\s*[:：]\s*$/, '') + ':\n' + answer);
  }

  return parts.join('\n\n');
}

/**
 * Answers that are not what their field asks for, in words. A choice must be
 * one of its options - a browser can post anything - a date a real date, a
 * number a number. Blank answers are missingAnswers' business.
 */
export function answerProblems(
  template: TemplateRow,
  answers: Record<string, string>,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = [];
  for (const field of templateLayout(template)) {
    if (field.kind !== 'question' || field.mode === 'view_only' || skip.has(field.key)) continue;
    const answer = (answers[field.input] ?? '').trim();
    if (!answer) continue;
    const name = field.shown.replace(/\s*[:：]\s*$/, '');
    const options = field.options ?? [];
    switch (field.fieldType) {
      case 'select':
        if (!options.includes(answer)) problems.push(name + ': choose one of the options');
        break;
      case 'multiselect':
        if (answer.split(', ').some((a) => !options.includes(a))) problems.push(name + ': choose from the options');
        break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(answer) || Number.isNaN(new Date(answer + 'T12:00:00Z').getTime())) {
          problems.push(name + ': enter a date');
        }
        break;
      case 'number':
        if (!/^-?\d+(?:[.,]\d+)?$/.test(answer)) problems.push(name + ': enter a number');
        break;
      default:
        break;
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Sections shown only for some answers
// ---------------------------------------------------------------------------

export interface ConditionChoice {
  key: string;
  label: string;
  /** Where its answer arrives in the submitted form. */
  input: string;
  /** 'select' for a dropdown, 'checkbox' for several choices. */
  control: 'select' | 'checkbox';
  options: { value: string; label: string }[];
}

/**
 * What a section can depend on: the answers a requester picks from a list -
 * a choice or several-choices field, or Priority - that are on the form and
 * editable. A typed answer could be anything, so it cannot open a section.
 */
export function conditionChoices(template: TemplateRow): ConditionChoice[] {
  const out: ConditionChoice[] = [];
  for (const field of templateLayout(template)) {
    if (field.mode === 'view_only') continue;
    if (field.key === 'priority') {
      out.push({
        key: 'priority',
        label: field.shown,
        input: 'priority',
        control: 'select',
        options: TICKET_PRIORITIES.map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) })),
      });
    } else if (field.kind === 'question' && hasOptions(field.fieldType)) {
      out.push({
        key: field.key,
        label: field.shown,
        input: field.input,
        control: field.fieldType === 'multiselect' ? 'checkbox' : 'select',
        options: (field.options ?? []).map((o) => ({ value: o, label: o })),
      });
    }
  }
  return out;
}

/**
 * The fields a submission hides: everything in a section whose conditions
 * none of the submitted answers meet. The server's rule - a browser can post
 * anything - so a hidden section's fields are treated as not on the form.
 */
export function hiddenFieldKeys(template: TemplateRow, submitted: Record<string, unknown>): Set<string> {
  const choices = new Map(conditionChoices(template).map((c) => [c.key, c]));
  const hidden = new Set<string>();
  for (const section of formSections(template)) {
    if (section.showWhen.length === 0) continue;
    const shown = section.showWhen.some((cond) => {
      const choice = choices.get(cond.field);
      if (!choice) return false;
      const raw = submitted[choice.input];
      const given = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(', ') : [];
      return given.includes(cond.value);
    });
    if (!shown) for (const field of section.fields) hidden.add(field.key);
  }
  return hidden;
}

/** A value safe inside a double-quoted CSS string. */
function cssString(value: string): string {
  return '"' + value.replace(/[\\"]/g, (c) => '\\' + c).replace(/[\r\n\f]/g, ' ') + '"';
}

/**
 * The stylesheet that shows a section once one of its answers is picked,
 * with no script: `:has()` looks at the form's own controls. Inside
 * `@supports`, so a browser without `:has()` hides nothing and shows every
 * section - the server still decides which answers count.
 */
export function sectionsCss(template: TemplateRow): string {
  const choices = new Map(conditionChoices(template).map((c) => [c.key, c]));
  const rules: string[] = [];
  for (const section of formSections(template)) {
    if (section.showWhen.length === 0) continue;
    const target = '.form-section[data-section=' + cssString(section.key) + ']';
    rules.push('  .ticket-form ' + target + ' { display: none; }');
    const shows = section.showWhen
      .map((cond) => {
        const choice = choices.get(cond.field);
        if (!choice) return '';
        const control =
          choice.control === 'checkbox'
            ? 'input[name=' + cssString(choice.input) + '][value=' + cssString(cond.value) + ']:checked'
            : 'select[name=' + cssString(choice.input) + '] option[value=' + cssString(cond.value) + ']:checked';
        return '  .ticket-form:has(' + control + ') ' + target;
      })
      .filter(Boolean);
    if (shows.length > 0) rules.push(shows.join(',\n') + ' { display: block; }');
  }
  return rules.length === 0 ? '' : '@supports selector(:has(*)) {\n' + rules.join('\n') + '\n}\n';
}

/** Which prompts were mandatory but left blank. */
export function missingAnswers(
  template: TemplateRow,
  answers: Record<string, string>,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  return templateLayout(template)
    .filter(
      (field) =>
        field.kind === 'question' &&
        !skip.has(field.key) &&
        field.mode === 'mandatory' &&
        !(answers[field.input] ?? '').trim(),
    )
    .map((field) => field.shown);
}

/**
 * The task templates raised alongside one template.
 *
 * Ordered the way they were given, so a sequence of steps stays in sequence.
 */
export async function listTaskTemplates(parentId: string): Promise<TemplateRow[]> {
  const rows = await query<TemplateRow>(
    SELECT + ' WHERE parent_template_id = ?' + TASK_ORDER,
    [parentId],
  );
  return rows.map((row) => withFields(row)!);
}

/**
 * Attaches a task to a template.
 *
 * A task template is a template like any other - it just carries a parent, is
 * never offered on its own, and is raised as a task when its parent is.
 */
export async function addTaskTemplate(
  parentId: string,
  input: Omit<TemplateInput, 'parentTemplateId'>,
  actorId: string | null,
): Promise<TemplateRow> {
  const parent = await findTemplate(parentId);
  if (!parent) throw notFound('That template no longer exists.');
  if (parent.parent_template_id) {
    throw conflict('A task cannot carry tasks of its own.', 'task_nesting');
  }

  const created = await createTemplate(
    { ...input, type: 'task', parentTemplateId: parentId },
    actorId,
  );

  // Numbered after the last one, so "the order they were added" survives
  // two tasks created in the same millisecond.
  const last = await queryOne<{ n: number }>(
    'SELECT coalesce(max(sort_order), 0) AS n FROM ticket_templates WHERE parent_template_id = ? AND id <> ?',
    [parentId, created.id],
  );
  await execute('UPDATE ticket_templates SET sort_order = ? WHERE id = ?', [
    (last?.n ?? 0) + 10,
    created.id,
  ]);

  return (await findTemplate(created.id))!;
}

/** Marks one task of a template mandatory, or not. */
export async function setTaskMandatory(parentId: string, taskId: string, mandatory: boolean): Promise<void> {
  const changed = await execute('UPDATE ticket_templates SET task_mandatory = ? WHERE id = ? AND parent_template_id = ?', [
    mandatory ? 1 : 0,
    taskId,
    parentId,
  ]);
  if (changed === 0) throw notFound('That task is not on this template.');
}

/** The two task rules of a template. */
export async function setTaskRules(
  templateId: string,
  rules: { closeWhenTasksDone: boolean; requireTasksDone: boolean },
): Promise<void> {
  await execute('UPDATE ticket_templates SET close_when_tasks_done = ?, require_tasks_done = ?, updated_at = ? WHERE id = ?', [
    rules.closeWhenTasksDone ? 1 : 0,
    rules.requireTasksDone ? 1 : 0,
    nowIso(),
    templateId,
  ]);
}

export async function deleteTaskTemplate(parentId: string, taskId: string): Promise<void> {
  await execute('DELETE FROM ticket_templates WHERE id = ? AND parent_template_id = ?', [
    taskId,
    parentId,
  ]);
}

// ---------------------------------------------------------------------------
// Who may use a template
// ---------------------------------------------------------------------------

/**
 * The user groups a template is offered to.
 *
 * **Empty means everybody.** That is the normal case and the safe default:
 * adding this feature must not quietly hide every form that already exists,
 * and a template nobody can see is a support call rather than a security
 * measure.
 */
export async function templateAudience(templateId: string): Promise<string[]> {
  const rows = await query<{ group_id: string }>(
    'SELECT group_id FROM ticket_template_visibility WHERE template_id = ?',
    [templateId],
  );
  return rows.map((row) => row.group_id);
}

/** The same, for several templates at once, so a list is one query. */
export async function audiencesFor(
  templateIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (templateIds.length === 0) return out;

  const rows = await query<{ template_id: string; group_id: string }>(
    'SELECT template_id, group_id FROM ticket_template_visibility WHERE template_id IN (' +
      templateIds.map(() => '?').join(', ') +
      ')',
    [...templateIds],
  );
  for (const row of rows) {
    const list = out.get(row.template_id) ?? [];
    list.push(row.group_id);
    out.set(row.template_id, list);
  }
  return out;
}

/**
 * Restricts a template to a set of user groups, or to nobody in particular.
 *
 * Rewritten wholesale rather than diffed: the form posts the complete set of
 * ticks, so anything missing from it was deliberately unticked.
 */
export async function setTemplateAudience(
  template: TemplateRow,
  groupIds: readonly string[],
  actorId: string | null,
): Promise<void> {
  if (template.is_default && groupIds.length > 0) {
    throw conflict(
      'The default template is the form every ticket starts from, so it cannot be ' +
        'restricted to a user group - anyone outside it would have no form at all. ' +
        'Make another template the default first.',
      'default_cannot_be_restricted',
    );
  }

  const wanted = Array.from(new Set(groupIds)).slice(0, 50);

  await transaction(async (client) => {
    await client.query('DELETE FROM ticket_template_visibility WHERE template_id = ?', [
      template.id,
    ]);
    for (const groupId of wanted) {
      await client.query(
        `INSERT INTO ticket_template_visibility (template_id, group_id, added_at)
         VALUES (?, ?, ?)`,
        [template.id, groupId, nowIso()],
      );
    }
  });

  audit({
    action: 'template.audience.set',
    actorId,
    targetType: 'template',
    targetId: template.id,
    detail: { template: template.name, groups: wanted.length },
  });
}

/**
 * The templates one person may raise a ticket from.
 *
 * A template with no audience is offered to everyone; one with an audience is
 * offered only to members of those groups. Staff are **not** exempt: a form
 * meant for external users would be noise in an agent's picker, and an agent
 * raising a ticket is a requester like any other.
 */
export async function templatesVisibleTo(userGroupIds: readonly string[]): Promise<TemplateRow[]> {
  const templates = await listActiveTemplates();
  const audiences = await audiencesFor(templates.map((t) => t.id));
  const mine = new Set(userGroupIds);

  return templates.filter((template) => {
    const audience = audiences.get(template.id) ?? [];
    return audience.length === 0 || audience.some((groupId) => mine.has(groupId));
  });
}

/** Whether one person may raise a ticket from one template. */
export async function canUseTemplate(
  template: TemplateRow,
  userGroupIds: readonly string[],
): Promise<boolean> {
  const audience = await templateAudience(template.id);
  return audience.length === 0 || audience.some((groupId) => userGroupIds.includes(groupId));
}

// ---------------------------------------------------------------------------
// Kinds, for the Templates tabs
// ---------------------------------------------------------------------------

/**
 * The tabs on Settings - Tickets - Templates, in order.
 *
 * Three are a template's own type. The other two are task templates, which
 * never stand alone - a task is raised with its parent - and are told apart
 * by that parent: a task under a change request *is* a change task, the same
 * rule prefixFor() applies to tickets.
 */
export const TEMPLATE_KINDS = [
  { key: 'service_request', label: 'Service request' },
  { key: 'incident', label: 'Incident' },
  { key: 'change_request', label: 'Change request' },
  { key: 'task', label: 'Task' },
  { key: 'change_task', label: 'Change task' },
] as const;

export type TemplateKind = (typeof TEMPLATE_KINDS)[number]['key'];

export function isTemplateKind(value: unknown): value is TemplateKind {
  return TEMPLATE_KINDS.some((k) => k.key === value);
}

/** A task template, with the template it hangs off. */
export interface TaskTemplateListRow extends TemplateRow {
  parent_name: string;
  parent_type: TicketType;
}

/** Top-level templates of one type, for its tab. */
export async function listTemplatesOfType(type: TicketType): Promise<TemplateRow[]> {
  const rows = await query<TemplateRow>(
    SELECT + ' WHERE parent_template_id IS NULL AND type = ?' + ORDER,
    [type],
  );
  return rows.map((row) => withFields(row)!);
}

/** Task templates, split by whether their parent is a change request. */
export async function listTaskTemplatesOfKind(
  kind: 'task' | 'change_task',
): Promise<TaskTemplateListRow[]> {
  const rows = await query<TaskTemplateListRow>(
    `SELECT t.*, p.name AS parent_name, p.type AS parent_type
       FROM ticket_templates t
       JOIN ticket_templates p ON p.id = t.parent_template_id
      WHERE ` + (kind === 'change_task' ? "p.type = 'change_request'" : "p.type <> 'change_request'") + `
      ORDER BY lower(p.name), t.sort_order, t.created_at`,
  );
  return rows.map((row) => withFields(row) as TaskTemplateListRow);
}

/**
 * One starter template per kind, once.
 *
 * Asked for directly: every tab should open on something to edit rather than
 * an empty list. Run at start-up, after ensureDefaultTemplate, and **only
 * ever once** - the seed_markers row records it - so a starter somebody
 * deleted stays deleted across a restart. A kind that already has a template
 * gets no starter: there is something to edit already.
 */
export async function ensureStarterTemplates(): Promise<void> {
  const done = await queryOne<{ key: string }>(
    "SELECT key FROM seed_markers WHERE key = 'starter_templates'",
  );
  if (done) return;

  const form = () =>
    STARTER_FORM.map((entry) => ({
      key: entry.key,
      kind: 'builtin' as const,
      label: '',
      mode: entry.mode,
      value: '',
      placeholder: '',
      placed: true,
    }));
  const base = (name: string, summary: string, type: TicketType) => ({
    name,
    summary,
    title: '',
    body: '',
    priority: 'normal' as const,
    category: 'other' as const,
    type,
    groupId: null,
    categoryId: null,
    fields: form(),
    isActive: true,
  });

  // The top-level three, each only if that type has nothing yet.
  const starters: Partial<Record<TicketType, TemplateRow>> = {};
  for (const [type, name, summary] of [
    ['service_request', 'Standard service request', 'Ask for something: access, equipment, information.'],
    ['incident', 'Standard incident', 'Report something that is broken or not working as it should.'],
    ['change_request', 'Standard change request', 'Propose a change to a system or service.'],
  ] as const) {
    const existing = await listTemplatesOfType(type);
    starters[type] = existing[0] ?? (await createTemplate(base(await freeName(name), summary, type), null));
  }

  // Tasks hang off a parent: a task under the service request, a change task
  // under the change request - again only where there are none of that kind.
  if ((await listTaskTemplatesOfKind('task')).length === 0 && starters.service_request) {
    await addTaskTemplate(
      starters.service_request.id,
      base(await freeName('Standard task'), 'A step raised alongside the request.', 'task'),
      null,
    );
  }
  if ((await listTaskTemplatesOfKind('change_task')).length === 0 && starters.change_request) {
    await addTaskTemplate(
      starters.change_request.id,
      base(await freeName('Standard change task'), 'A step in carrying out the change.', 'task'),
      null,
    );
  }

  await execute("INSERT INTO seed_markers (key, done_at) VALUES ('starter_templates', ?)", [
    nowIso(),
  ]);
  audit({ action: 'template.starters.created', actorId: null, targetType: 'template' });
}

/**
 * Every ticket type has a default template.
 *
 * "Raise an incident" has to open *something*, and the service catalogue's
 * filter buttons raise exactly this (asked for 16 Oct 2026). Runs at
 * start-up, after the starters, and **only ever adds**: a type that already
 * has a default keeps it, and a type with no usable template at all is left
 * alone rather than given one it never asked for.
 *
 * The oldest usable template of the type is the one adopted - on a desk
 * that has been running a while, the first one made is the one people have
 * been using.
 */
export async function ensureTypeDefaults(): Promise<void> {
  for (const type of ['service_request', 'incident', 'change_request'] as const) {
    const already = await queryOne<{ id: string }>(
      'SELECT id FROM ticket_templates WHERE is_default = 1 AND type = ? AND is_active = 1',
      [type],
    );
    if (already) continue;

    const candidates = (await listTemplatesOfType(type)).filter(
      (template) => template.is_active && isUsable(template),
    );
    const adopt = candidates[0];
    if (!adopt) continue;

    await execute('UPDATE ticket_templates SET is_default = 1 WHERE id = ?', [adopt.id]);
    audit({
      action: 'template.default.set',
      actorId: null,
      targetType: 'template',
      targetId: adopt.id,
      detail: { name: adopt.name, type, reason: 'every type needs one' },
    });
  }
}
