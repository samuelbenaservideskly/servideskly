import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { normaliseLine, normaliseText } from '../lib/util.js';
import { allowOwnRequests, allowOwnScripts, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import {
  BUILTIN_FIELDS,
  FIELD_DEFAULTS,
  FIELD_MODES,
  MODE_HINTS,
  MODE_LABELS,
  addQuestion,
  availableFields,
  configureField,
  deleteQuestion,
  fieldDefault,
  createTemplate,
  deleteTemplate,
  findTemplate,
  isUsable,
  layoutField,
  listAllTemplates,
  listTaskTemplatesOfKind,
  listTemplatesOfType,
  isTemplateKind,
  TEMPLATE_KINDS,
  moveField,
  placeField,
  unplaceField,
  reorderFields,
  setDefaultTemplate,
  setFieldDefault,
  setTemplateAudience,
  templateAudience,
  templateLayout,
  formSections,
  conditionChoices,
  isCustomFieldType,
  parseOptions,
  CUSTOM_FIELD_TYPES,
  addSection,
  renameSection,
  FIELD_WIDTHS,
  type FieldWidth,
  updateTemplate,
  addTaskTemplate,
  deleteTaskTemplate,
  setTaskMandatory,
  setTaskRules,
  listTaskTemplates,
  type FieldMode,
  type TemplateField,
  type TemplateRow,
  REQUESTER_DETAILS,
  duplicateTemplate,
} from '../services/templates.js';
import { attempt, issueErrors, type FieldErrors } from './form-errors.js';
import { serviceCatalogueAdminRouter } from './service-catalogue-admin.js';
import { settingsView } from './settings-shared.js';
import { settings, updateSettings } from '../settings/index.js';
import {
  CATEGORY_LABELS,
  PARENT_TYPES,
  PRIORITY_LABELS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_TYPES,
  TYPE_LABELS,
} from '../services/tickets.js';
import { listActiveGroups } from '../services/groups.js';
import { catalogueTree, categoryPath, flatten, selectableCategories } from '../services/catalogue.js';
import { listActiveUserGroups } from '../services/user-groups.js';
import { catalogueAdminRouter } from './catalogue-admin.js';
import { customFieldsAdminRouter } from './custom-fields-admin.js';
import { createLibraryField, listLibraryFields, placeLibraryField } from '../services/custom-fields.js';
import { filterParams, filterRows, readColumnFilters, rowMenus, sortRows, type Cells } from '../lib/column-filters.js';

/**
 * Administration of ticket templates.
 *
 * Mounted under /admin, which has already required an administrator, so there
 * is no further role check here.
 */
export const templateAdminRouter = Router();

const labels = {
  priorities: TICKET_PRIORITIES,
  categories: TICKET_CATEGORIES,
  priorityLabels: PRIORITY_LABELS,
  categoryLabels: CATEGORY_LABELS,
  types: TICKET_TYPES,
  parentTypes: PARENT_TYPES,
  typeLabels: TYPE_LABELS,
};

// The catalogue lives under Templates, as a tab rather than a section of
// its own: it is what a template's classification is drawn from.
templateAdminRouter.use('/categories', catalogueAdminRouter);
// The custom-field library, a tab beside it.
templateAdminRouter.use('/custom-fields', customFieldsAdminRouter);

/**
 * What the settings form carries - and only that.
 *
 * The title, category, priority and opening text are **not** here. They are
 * what a field falls back to, so they are set in that field's gear, in the
 * builder. Having them in both places meant the same thing appeared twice on
 * the page, with nothing to say they were the same thing.
 */
const templateBody = z.object({
  name: z.string().trim().min(2, 'Give the template a name.').max(80),
  summary: z.string().trim().max(200).default(''),
  type: z.enum(TICKET_TYPES),
});

/** Everything the template form offers to pick from. */
async function formChoices(): Promise<Record<string, unknown>> {
  const [groups, categories] = await Promise.all([
    listActiveGroups(),
    selectableCategories(),
  ]);
  return { groups, categoryOptions: categories };
}

/** The technician group, which is routing rather than a form field. */
function routingFrom(raw: Record<string, unknown>): { groupId: string | null } {
  return { groupId: typeof raw.groupId === 'string' && raw.groupId ? raw.groupId : null };
}

/**
 * The values the settings form no longer carries.
 *
 * Kept as they are on an update, and started blank on a create. Reading them
 * from this form would let it overwrite what the builder's gear just set.
 */
function keepDefaults(existing: TemplateRow | undefined) {
  return {
    title: existing?.title ?? '',
    body: existing?.body ?? '',
    priority: existing?.priority ?? ('normal' as const),
    category: existing?.category ?? ('other' as const),
    categoryId: existing?.category_id ?? null,
  };
}

/**
 * The fields are **not** read from this form.
 *
 * They belong to the builder below it, which saves each change on its own.
 * Posting them here as well would mean the settings form could silently undo
 * a layout change made after the page was drawn.
 */
function keepFields(existing: TemplateRow | undefined): TemplateField[] {
  return existing?.fields ?? [];
}

function parseForm(raw: Record<string, unknown>) {
  return templateBody.safeParse({
    name: typeof raw.name === 'string' ? normaliseLine(raw.name) : '',
    summary: typeof raw.summary === 'string' ? normaliseLine(raw.summary) : '',
    type: raw.type ?? 'incident',
  });
}

const BLANK = {
  id: null,
  name: '',
  summary: '',
  title: '',
  body: '',
  priority: 'normal',
  category: 'other',
  type: 'incident',
  group_id: null as string | null,
  category_id: null as string | null,
  parent_template_id: null as string | null,
  fields: [] as TemplateField[],
  is_active: true,
  sort_order: 100,
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

templateAdminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    // A tab per ticket type, beside "All". The two task kinds are task
    // templates, listed with the template each hangs off.
    const kind = isTemplateKind(req.query.type) ? req.query.type : null;
    if (kind === 'task' || kind === 'change_task') {
      const tasks = await listTaskTemplatesOfKind(kind);
      // What a task of this kind may hang off: a change task belongs to a
      // change request, any other task to a service request or an incident.
      const parentTypes = kind === 'change_task'
        ? (['change_request'] as const)
        : (['service_request', 'incident'] as const);
      const parents = (
        await Promise.all(parentTypes.map((type) => listTemplatesOfType(type)))
      ).flat();

      res.render(
        'admin/settings/templates',
        settingsView('templates', {
          title: 'Tickets',
          kind,
          kinds: TEMPLATE_KINDS,
          templates: [],
          parents,
          groups: await listActiveGroups(),
          openDialog: null,
          tasks: tasks.map((t) => ({
            ...t,
            fieldCount: templateLayout(t).length,
            usable: isUsable(t),
          })),
          ...labels,
        }),
      );
      return;
    }

    // The list reads a template at a glance, so the things it shows are
    // worked out here rather than in the view: what it is really filed under
    // (the catalogue path, not the vestigial enum), how many questions its
    // form asks, and whether that form is finished.
    const rows = kind ? await listTemplatesOfType(kind) : await listAllTemplates();
    const templates = await Promise.all(
      rows.map(async (template) => ({
        ...template,
        categoryPath: await categoryPath(template.category_id),
        fieldCount: templateLayout(template).length,
        usable: isUsable(template),
      })),
    );

    // Excel-like headers (lib/column-filters.ts), in memory: the list is whole.
    type Row = (typeof templates)[number];
    const cells: Cells<Row> = {
      name: (r) => r.name,
      raises: (r) => r.type,
      filed: (r) => r.categoryPath ?? '',
      priority: (r) => r.priority,
      form: (r) => (r.usable ? 'Finished' : 'Unfinished'),
      status: (r) => (r.is_active ? 'Active' : 'Retired'),
    };
    const sortCells: Cells<Row> = {
      ...cells,
      priority: (r) => String(['low', 'normal', 'high', 'urgent'].indexOf(r.priority)),
      form: (r) => (r.usable ? String(r.fieldCount).padStart(4, '0') : ''),
    };
    const asked = req.query as Record<string, unknown>;
    const columns = readColumnFilters(asked, Object.keys(cells));
    const sort = typeof asked.sort === 'string' && sortCells[asked.sort] ? asked.sort : undefined;
    const dir = asked.dir === 'desc' ? 'desc' : 'asc';
    const labelOf = (key: string, v: string) =>
      key === 'raises' ? (TYPE_LABELS[v as keyof typeof TYPE_LABELS] ?? v)
      : key === 'priority' ? (PRIORITY_LABELS[v as keyof typeof PRIORITY_LABELS] ?? v)
      : key === 'filed' && !v ? 'Not filed'
      : v;

    res.render(
      'admin/settings/templates',
      settingsView('templates', {
        title: 'Tickets',
        kind,
        kinds: TEMPLATE_KINDS,
        templates: sortRows(filterRows(templates, columns, cells), sort, dir, sortCells),
        columnMenus: rowMenus(templates, columns, cells, labelOf),
        listState: { type: kind ?? undefined, sort, dir: sort ? dir : undefined, ...filterParams(columns) },
        tasks: [],
        ...labels,
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// New / edit form, and the builder on the same page
// ---------------------------------------------------------------------------

/**
 * Everything the editor page needs.
 *
 * The builder only exists for a saved template - it edits a stored field
 * list, one change at a time - so on /new the canvas is absent and the page
 * is just the settings form.
 */
async function editView(
  template: TemplateRow | null,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return settingsView('templates', {
    title: template ? 'Edit template' : 'New template',
    template: template ?? BLANK,
    tasks: template ? await listTaskTemplates(template.id) : [],
    // The canvas: only what has been put on the form, in order.
    layout: template ? templateLayout(template) : [],
    // The same, grouped into its sections (empty ones kept, to drop into).
    builderSections: template ? formSections(template, { keepEmpty: true }) : [],
    conditionChoices: template ? conditionChoices(template) : [],
    customFieldTypes: CUSTOM_FIELD_TYPES,
    requesterDetailOptions: REQUESTER_DETAILS,
    // Library fields this form does not ask yet (a copy set aside counts as
    // not asked: adding it puts the copy back).
    library: template
      ? (await listLibraryFields()).filter((f) => !templateLayout(template).some((x) => x.libraryId === f.id))
      : [],
    // The palette on the right: what could still be added.
    palette: template ? availableFields(template) : { builtins: [], questions: [] },
    builtins: BUILTIN_FIELDS,
    modes: FIELD_MODES,
    modeLabels: MODE_LABELS,
    modeHints: MODE_HINTS,
    isDefault: template?.is_default ?? false,
    // The gear sets the value a field falls back to, so the dialogs need to
    // know which fields have one and what it currently is.
    fieldDefaults: FIELD_DEFAULTS,
    defaultFor: (key: string) => (template ? fieldDefault(template, key) : ''),
    // The preview of a Category field prints the path, so it needs resolving
    // here. Leaving it to the view is what crashed the page the moment
    // Category was dragged onto a form.
    templateCategoryPath: template ? await categoryPath(template.category_id) : '',
    // One stored node, read back a level at a time: a template filed at
    // "Hardware > Not working > Mouse" has a category of Hardware and an item
    // of Mouse, and each row should say its own, not all three.
    templateCategoryTrail: template ? await categoryTrail(template.category_id) : {},
    // Every template a task could hang off, for the dialog's picker.
    parentChoices: (await listAllTemplates()).filter((t) => t.is_active || t.id === template?.id),
    usable: template ? isUsable(template) : false,
    // Which user groups may raise a ticket from this, and what there is to
    // choose from. Empty means everybody.
    userGroups: await listActiveUserGroups(),
    audience: template ? await templateAudience(template.id) : [],
    errors: {},
    openDialog: null as string | null,
    ...(await formChoices()),
    ...labels,
    ...extra,
  });
}

templateAdminRouter.get(
  '/new',
  asyncHandler(async (req, res) => {
    // From a type's tab, the new template starts as that type.
    const type = req.query.type;
    const preset =
      type === 'incident' || type === 'service_request' || type === 'change_request'
        ? { template: { ...BLANK, type } }
        : {};
    res.render('admin/settings/template-edit', await editView(null, preset));
  }),
);

// ---------------------------------------------------------------------------
// Other settings
// ---------------------------------------------------------------------------

/**
 * How a reference is written.
 *
 * Here rather than in its own section because it is a decision about the
 * tickets a template raises, and because a third thing under Tickets
 * is cheaper to find than a ninth thing under Settings.
 *
 * **A prefix applies to tickets raised after it is set.** It is stored on the
 * ticket, so changing it never rewrites a reference that is already in
 * somebody's inbox - and a reply quoting the old one still threads, because
 * the number is what identifies a ticket and the prefix is only how it reads.
 */
const PREFIX_FIELDS = [
  { key: 'incident', label: 'Incident' },
  { key: 'service_request', label: 'Service request' },
  { key: 'change_request', label: 'Change request' },
  { key: 'task', label: 'Task' },
  {
    key: 'change_task',
    label: 'Change task',
    note: 'Applied to tasks created under a change request.',
  },
] as const;

/**
 * Other settings: one page, each decision behind its own chevron.
 *
 * They were four sub-tabs, which meant a page load to read what is mostly a
 * short list of switches - and the SLA form, the only long one, was no
 * easier to find for it. Every panel is drawn on every render, so a refused
 * save lands beside the fields that caused it (trap 6) and leaves the others
 * alone; "openPanel" says which chevron to open.
 */
function otherView(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const current = settings();
  return settingsView('templates', {
    sectionTitle: 'Tickets',
    tab: 'other',
    prefixes: current.tickets.prefixes,
    prefixFields: PREFIX_FIELDS,
    sla: current.sla,
    slaPriorities: SLA_PRIORITIES,
    weekdays: WEEKDAYS,
    requireCancelNote: current.tickets.requireCancelNote,
    requireResolveNote: current.tickets.requireResolveNote,
    deleteClosedAfterDays: current.tickets.deleteClosedAfterDays,
    errors: {},
    openPanel: '',
    ...labels,
    ...extra,
  });
}

/** Back to the one page, with the panel that was being saved open. */
function otherUrl(panel: string): string {
  return '/admin/settings/templates/other' + (panel ? '#' + panel : '');
}

templateAdminRouter.get(
  '/other',
  asyncHandler(async (_req, res) => {
    res.render('admin/settings/template-other', otherView());
  }),
);

templateAdminRouter.post(
  '/other',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const errors: Record<string, string> = {};
    const next: Record<string, string> = {};

    for (const field of PREFIX_FIELDS) {
      const value = typeof raw[field.key] === 'string' ? String(raw[field.key]).trim() : '';
      // Letters and digits only: it goes in a mail subject inside brackets,
      // and a space or a bracket there would break the pattern that finds a
      // reply's ticket.
      if (!/^[A-Za-z0-9]{1,8}$/.test(value)) {
        errors[field.key] = 'One to eight letters or digits, with no spaces.';
        continue;
      }
      next[field.key] = value.toUpperCase();
    }

    if (Object.keys(errors).length > 0) {
      res.status(400).render(
        'admin/settings/template-other',
        otherView({ errors, openPanel: 'prefixes', prefixes: { ...settings().tickets.prefixes, ...next, ...raw } }),
      );
      return;
    }

    await updateSettings(
      { tickets: { prefixes: next as never } },
      req.currentUser?.id ?? null,
    );

    auditRequest(req, {
      action: 'settings.ticket_prefixes.changed',
      targetType: 'settings',
      targetId: 'current',
      detail: next,
    });

    flash(req, 'success', 'Reference prefixes saved. They apply to tickets raised from now on.');
    res.redirect(otherUrl('prefixes'));
  }),
);

// ---------------------------------------------------------------------------
// Other settings - SLA
// ---------------------------------------------------------------------------

const SLA_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
const WEEKDAYS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 0, label: 'Sun' },
];

/** Hours as typed, to whole minutes. Comma or point. */
function hoursToMinutes(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 8760) return null;
  return Math.max(1, Math.round(n * 60));
}

// It held only cancellation at first; resolution joined it.
templateAdminRouter.use('/other/cancellation', (req, res) => {
  res.redirect(308, '/admin/settings/templates/other/status-notes' + req.url.replace(/^\/(?=\?|$)/, ''));
});

// The sub-tabs' own addresses still work: each opens its panel on the one
// page. The GET only - every POST keeps its own address, so a form already
// open in somebody's browser still saves.
templateAdminRouter.get('/other/status-notes', (_req, res) => {
  res.redirect(308, otherUrl('status-notes'));
});

templateAdminRouter.post(
  '/other/status-notes',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const cancel = body.requireCancelNote === 'on';
    const resolve = body.requireResolveNote === 'on';
    const before = settings().tickets;
    await updateSettings({ tickets: { requireCancelNote: cancel, requireResolveNote: resolve } }, req.currentUser?.id ?? null);
    if (before.requireCancelNote !== cancel) {
      auditRequest(req, { action: 'settings.cancel_note.' + (cancel ? 'required' : 'optional'), targetType: 'settings' });
    }
    if (before.requireResolveNote !== resolve) {
      auditRequest(req, { action: 'settings.resolve_note.' + (resolve ? 'required' : 'optional'), targetType: 'settings' });
    }
    flash(req, 'success', 'Status notes saved.');
    res.redirect(otherUrl('status-notes'));
  }),
);

templateAdminRouter.get('/other/sla', (_req, res) => {
  res.redirect(308, otherUrl('sla'));
});

templateAdminRouter.post(
  '/other/sla',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const errors: Record<string, string> = {};

    // The zone is Locale's; this page only shows it.
    const timeZone = settings().locale.timeZone;

    const dayValues = Array.isArray(raw.days) ? raw.days : raw.days === undefined ? [] : [raw.days];
    const days = Array.from(
      new Set(dayValues.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)),
    ).sort();
    if (days.length === 0) errors.days = 'Choose at least one working day.';

    const start = typeof raw.start === 'string' ? raw.start : '';
    const end = typeof raw.end === 'string' ? raw.end : '';
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || end <= start) {
      errors.hours = 'Working hours must end after they start.';
    }

    const targets: Record<string, { response: number; resolution: number }> = {};
    for (const p of SLA_PRIORITIES) {
      const response = hoursToMinutes(raw['response_' + p]);
      const resolution = hoursToMinutes(raw['resolution_' + p]);
      if (response === null || resolution === null) {
        errors['target_' + p] = 'Enter both targets in hours, more than zero.';
        continue;
      }
      if (resolution < response) {
        errors['target_' + p] = 'Resolving cannot be due before the first response.';
      }
      targets[p] = { response, resolution };
    }

    // One per line; "2026-12-24" that day, "12-25" every year.
    const holidayText = typeof raw.holidays === 'string' ? raw.holidays : '';
    const holidays: string[] = [];
    for (const line of holidayText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const m = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(line);
      const month = m ? Number(m[2]) : 0;
      const day = m ? Number(m[3]) : 0;
      if (!m || month < 1 || month > 12 || day < 1 || day > 31) {
        errors.holidays = '"' + line.slice(0, 20) + '" is not a date. Write 2026-12-24 for that day, or 12-25 for every year.';
        break;
      }
      const value = (m[1] ? m[1] + '-' : '') + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      if (!holidays.includes(value)) holidays.push(value);
    }
    if (holidays.length > 200) errors.holidays = 'At most 200 holidays.';

    const candidate = {
      enabled: raw.enabled === 'on',
      notifyManager: raw.notifyManager === 'on',
      pauseOnHold: raw.pauseOnHold === 'on',
      holidays,
      timeZone,
      days,
      start,
      end,
      targets: targets as never,
    };
    if (Object.keys(errors).length > 0) {
      // Re-rendered with what was typed, not an error page (trap 6).
      res.status(400).render(
        'admin/settings/template-other',
        otherView({
          openPanel: 'sla',
          sla: { ...settings().sla, ...candidate, targets: { ...settings().sla.targets, ...targets } },
          errors,
        }),
      );
      return;
    }

    await updateSettings({ sla: candidate }, req.currentUser?.id ?? null);
    auditRequest(req, {
      action: 'settings.sla.changed',
      targetType: 'settings',
      targetId: 'current',
      detail: candidate,
    });
    flash(req, 'success', candidate.enabled ? 'SLA saved and in force.' : 'SLA saved. It is switched off.');
    res.redirect(otherUrl('sla'));
  }),
);

// ---------------------------------------------------------------------------
// Other settings - deleting old tickets
// ---------------------------------------------------------------------------

/**
 * Deleting closed tickets after a while.
 *
 * Off by default, and it is a **real delete** - the same one an administrator
 * does by hand, cascade and attachment files included - because a ticket kept
 * behind a "deleted" column is still a ticket a query that forgets the column
 * will show. A service desk that must keep its records for seven years and
 * one that may not keep them for more than one both exist, so the number is
 * theirs to set and the default is to keep everything.
 */
templateAdminRouter.post(
  '/other/retention',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const on = raw.enabled === 'on';
    const typed = typeof raw.days === 'string' ? raw.days.trim() : '';
    const days = on ? Number(typed) : 0;

    if (on && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      res.status(400).render(
        'admin/settings/template-other',
        otherView({
          openPanel: 'retention',
          deleteClosedAfterDays: 0,
          errors: { retention: 'A whole number of days, from 1 to 3650.' },
        }),
      );
      return;
    }

    const before = settings().tickets.deleteClosedAfterDays;
    await updateSettings({ tickets: { deleteClosedAfterDays: days } }, req.currentUser?.id ?? null);
    if (before !== days) {
      auditRequest(req, {
        action: days > 0 ? 'settings.ticket_retention.set' : 'settings.ticket_retention.off',
        targetType: 'settings',
        targetId: 'current',
        detail: { days },
      });
    }
    flash(
      req,
      'success',
      days > 0
        ? 'Closed tickets will be deleted ' + days + ' days after they close.'
        : 'Closed tickets are kept.',
    );
    res.redirect(otherUrl('retention'));
  }),
);

// The service catalogue: the tiles New ticket offers, and the switch that
// turns it on. Mounted before /:id, which would otherwise read "catalogue"
// as a template id.
templateAdminRouter.use('/catalogue', serviceCatalogueAdminRouter);

templateAdminRouter.get(
  '/:id',
  // The one page in the application allowed to load a script of ours: the
  // drag-and-drop cannot be done without one. See allowOwnScripts. Its
  // script also saves a move in place, without a reload (allowOwnRequests).
  allowOwnScripts(),
  allowOwnRequests(),
  asyncHandler(async (req, res) => {
    const template = await findTemplate(String(req.params.id));
    if (!template) throw notFound('That template no longer exists.');
    res.render('admin/settings/template-edit', await editView(template));
  }),
);

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

templateAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseForm(raw);
    const fields = keepFields(undefined);

    const refuse = async (errors: FieldErrors): Promise<void> => {
      res.status(400).render(
        'admin/settings/template-edit',
        await editView(null, { template: { ...BLANK, ...raw, fields }, errors }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      createTemplate(
        {
          ...parsed.data,
          ...keepDefaults(undefined),
          ...routingFrom(raw),
          fields,
          isActive: raw.isActive !== undefined,
        },
        req.currentUser?.id ?? null,
      ),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }
    const created = attempted.value;

    auditRequest(req, {
      action: 'template.created',
      targetType: 'template',
      targetId: created.id,
      detail: { name: created.name },
    });
    flash(req, 'success', 'Template "' + created.name + '" created.');
    // Land on the template itself: tasks are attached from its own page,
    // and a new template usually wants at least one.
    res.redirect('/admin/settings/templates/' + created.id);
  }),
);

templateAdminRouter.post(
  '/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const existing = await findTemplate(id);
    if (!existing) throw notFound('That template no longer exists.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseForm(raw);
    const fields = keepFields(existing);

    const refuse = async (errors: FieldErrors): Promise<void> => {
      res.status(400).render(
        'admin/settings/template-edit',
        await editView(existing, { template: { ...existing, ...raw, id, fields }, errors }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      updateTemplate(
        id,
        {
          ...parsed.data,
          ...keepDefaults(existing),
          ...routingFrom(raw),
          fields,
          isActive: raw.isActive !== undefined,
        },
        req.currentUser?.id ?? null,
      ),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }
    const updated = attempted.value;

    auditRequest(req, {
      action: 'template.updated',
      targetType: 'template',
      targetId: id,
      detail: { name: updated.name, active: updated.is_active },
    });
    flash(req, 'success', 'Template "' + updated.name + '" saved.');
    res.redirect('/admin/settings/templates');
  }),
);

// ---------------------------------------------------------------------------
// The form builder
//
// Each change is its own small POST that saves and returns to the page, so
// the canvas needs no draft state and nothing is lost if the tab is closed
// mid-edit. Drag-and-drop uses the same `fields/order` endpoint the arrow
// buttons use, which is why the page works identically without JavaScript.
// ---------------------------------------------------------------------------

/** Loads the template a builder request is about. */
async function builderTarget(req: { params: Record<string, string> }): Promise<TemplateRow> {
  const template = await findTemplate(String(req.params.id));
  if (!template) throw notFound('That template no longer exists.');
  return template;
}

/**
 * Back to the builder, at the row that was just touched.
 *
 * Every builder action is its own POST followed by a redirect, which without
 * a fragment lands at the top of a long page - so arranging a form meant
 * scrolling back down after every single change. The fragment names a canvas
 * row (`row-<key>`), never a dialog (`field-<key>`), because a dialog id
 * would re-open the dialog through its `:target` rule.
 */
const BUILDER_PAGE = (id: string, anchor = ''): string =>
  '/admin/settings/templates/' + id + (anchor ? '#' + anchor : '');

/** The canvas row for a field. */
const ROW = (key: string): string => 'row-' + key;

/** A node's ancestors, named by the level each sits at. */
async function categoryTrail(id: string | null): Promise<Record<string, string>> {
  if (!id) return {};
  const node = flatten(await catalogueTree()).find((n) => n.id === id);
  if (!node) return {};

  const keys = ['category', 'subcategory', 'item'];
  const trail: Record<string, string> = {};
  node.trail.forEach((step, depth) => {
    const key = keys[depth];
    if (key) trail[key] = step.name;
  });
  return trail;
}

templateAdminRouter.post(
  '/:id/fields/order',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;

    // Two callers: the script posts the whole order, the arrows post one move.
    const attempted = await attempt(async () => {
      if (typeof raw.order === 'string' && raw.order.trim()) {
        return reorderFields(
          template,
          raw.order.split(',').map((key) => key.trim()).filter(Boolean).slice(0, 60),
          req.currentUser?.id ?? null,
        );
      }
      const key = typeof raw.key === 'string' ? raw.key : '';
      // Neither an order nor a field: nothing was asked for, so nothing
      // happens. The canvas form has no submit button of its own, but it
      // should not be able to produce a 404 if one is ever added.
      if (!key) return template;
      const direction = raw.direction === 'up' ? 'up' : 'down';
      return moveField(template, key, direction, req.currentUser?.id ?? null);
    });

    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be moved.');
    }
    const moved = typeof raw.key === 'string' && raw.key ? raw.key : '';
    res.redirect(BUILDER_PAGE(template.id, moved ? ROW(moved) : 'the-form'));
  }),
);

templateAdminRouter.post(
  '/:id/fields/add',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const label = typeof raw.label === 'string' ? normaliseLine(raw.label) : '';
    const fieldType = isCustomFieldType(raw.fieldType) ? raw.fieldType : 'text';
    const options = typeof raw.options === 'string' ? parseOptions(raw.options) : [];

    // "Also save to the library": the library entry first, so a refused
    // label (already in the library) is said before anything is added.
    const toLibrary = raw.saveToLibrary === 'on';
    const attempted = await attempt(async () => {
      if (toLibrary) {
        const entry = await createLibraryField({ label, fieldType, options }, req.currentUser?.id ?? null);
        return placeLibraryField(template, entry.id, req.currentUser?.id ?? null);
      }
      return addQuestion(template, label, req.currentUser?.id ?? null, { fieldType, options });
    });
    if (!attempted.ok) {
      res.status(400).render(
        'admin/settings/template-edit',
        await editView(template, { errors: attempted.errors, openDialog: 'add-question' }),
      );
      return;
    }

    flash(req, 'success', '"' + label + '" added to the form.');
    // A new question goes on the end, so that is where to land.
    const added = templateLayout(attempted.value);
    res.redirect(
      BUILDER_PAGE(template.id, ROW(added[added.length - 1]?.key ?? '') || 'the-form'),
    );
  }),
);

/** Puts a library field on this form. */
templateAdminRouter.post(
  '/:id/fields/library',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const libraryId = typeof (req.body ?? {}).libraryId === 'string' ? String(req.body.libraryId) : '';
    const attempted = await attempt(() => placeLibraryField(template, libraryId, req.currentUser?.id ?? null));
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be added.');
      res.redirect(BUILDER_PAGE(template.id, 'the-form'));
      return;
    }
    const placed = templateLayout(attempted.value).find((f) => f.libraryId === libraryId);
    res.redirect(BUILDER_PAGE(template.id, placed ? ROW(placed.key) : 'the-form'));
  }),
);

templateAdminRouter.post(
  '/:id/fields/:key/configure',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const key = String(req.params.key);
    const existing = layoutField(template, key);
    if (!existing) throw notFound('That field is not on this template.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const mode = FIELD_MODES.find((m) => m === raw.mode);
    if (!mode) {
      res.status(400).render(
        'admin/settings/template-edit',
        await editView(template, {
          errors: { mode: 'Choose how this field behaves.' },
          openDialog: 'field-' + key,
        }),
      );
      return;
    }

    const attempted = await attempt(async () => {
      // The value this template sets first, so a refusal there does not leave
      // the mode changed and the value not.
      if (typeof raw.fieldDefault === 'string' && FIELD_DEFAULTS[key as never]) {
        await setFieldDefault(
          template,
          key,
          normaliseText(raw.fieldDefault),
          req.currentUser?.id ?? null,
        );
      }
      return configureField(
        template,
        key,
        {
          mode: mode as FieldMode,
          ...(existing.kind === 'question' && typeof raw.label === 'string'
            ? { label: normaliseLine(raw.label) }
            : {}),
          ...(typeof raw.value === 'string' ? { value: normaliseText(raw.value) } : {}),
          ...(typeof raw.placeholder === 'string'
            ? { placeholder: normaliseLine(raw.placeholder) }
            : {}),
          ...(FIELD_WIDTHS.includes(raw.width as FieldWidth) ? { width: raw.width as FieldWidth } : {}),
          // The Requester field's details: every ticked box; none ticked is the name alone.
          ...(key === 'requester'
            ? { details: Array.isArray(raw.details) ? raw.details.map(String) : typeof raw.details === 'string' ? [raw.details] : [] }
            : {}),
          ...(existing.kind === 'question' && isCustomFieldType(raw.fieldType) ? { fieldType: raw.fieldType } : {}),
          ...(existing.kind === 'question' && typeof raw.options === 'string' ? { options: parseOptions(raw.options) } : {}),
        },
        req.currentUser?.id ?? null,
      );
    });

    if (!attempted.ok) {
      res.status(400).render(
        'admin/settings/template-edit',
        await editView(template, { errors: attempted.errors, openDialog: 'field-' + key }),
      );
      return;
    }

    flash(req, 'success', existing.shown + ' is now ' + MODE_LABELS[mode].toLowerCase() + '.');
    res.redirect(BUILDER_PAGE(template.id, ROW(key)));
  }),
);

/** A new section at the end of the form. */
templateAdminRouter.post(
  '/:id/sections',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof raw.title === 'string' ? normaliseLine(raw.title) : '';
    const attempted = await attempt(() => addSection(template, title, req.currentUser?.id ?? null));
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'The section could not be added.');
      res.redirect(BUILDER_PAGE(template.id, 'the-form'));
      return;
    }
    flash(req, 'success', (title ? 'Section "' + title + '"' : 'An untitled section') + ' added at the end. Move fields into it.');
    const keys = formSections(attempted.value, { keepEmpty: true });
    res.redirect(BUILDER_PAGE(template.id, ROW(keys[keys.length - 1]?.key ?? '') || 'the-form'));
  }),
);

/** Renames a section. */
templateAdminRouter.post(
  '/:id/sections/:key',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const key = String(req.params.key);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof raw.title === 'string' ? normaliseLine(raw.title) : '';
    const labels = raw.labels === 'beside' ? 'beside' : raw.labels === 'above' ? 'above' : undefined;
    const collapse = raw.collapse === 'open' || raw.collapse === 'closed' || raw.collapse === 'none' ? raw.collapse : undefined;
    // "Show only when": ticked answers, each "<field key>|<value>". The
    // marker says the list was on the form, so ticking none clears it.
    let showWhen: { field: string; value: string }[] | undefined;
    if (raw.showWhenPresent === '1') {
      const ticked = Array.isArray(raw.showWhen) ? raw.showWhen : typeof raw.showWhen === 'string' ? [raw.showWhen] : [];
      const valid = new Map(conditionChoices(template).map((c) => [c.key, new Set(c.options.map((o) => o.value))]));
      showWhen = ticked
        .filter((t): t is string => typeof t === 'string')
        .map((t) => ({ field: t.slice(0, t.indexOf('|')), value: t.slice(t.indexOf('|') + 1) }))
        .filter((c) => valid.get(c.field)?.has(c.value));
    }
    const attempted = await attempt(() =>
      renameSection(template, key, title, req.currentUser?.id ?? null, {
        ...(labels ? { labels } : {}),
        ...(collapse ? { collapse } : {}),
        ...(showWhen ? { showWhen } : {}),
      }),
    );
    flash(req, attempted.ok ? 'success' : 'error', attempted.ok ? 'Section saved.' : Object.values(attempted.errors)[0] ?? 'Not saved.');
    res.redirect(BUILDER_PAGE(template.id, ROW(key)));
  }),
);

/** Drag a palette chip onto the canvas - or press the Add button beside it. */
templateAdminRouter.post(
  '/:id/fields/:key/place',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const key = String(req.params.key);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const at = Number.parseInt(String(raw.index ?? ''), 10);

    const attempted = await attempt(() =>
      placeField(
        template,
        key,
        Number.isFinite(at) ? at : null,
        req.currentUser?.id ?? null,
      ),
    );
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be added.');
    }
    res.redirect(BUILDER_PAGE(template.id, ROW(key)));
  }),
);

/** Takes a field off the form, back to the palette. Nothing is destroyed. */
templateAdminRouter.post(
  '/:id/fields/:key/remove',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const key = String(req.params.key);

    const attempted = await attempt(() =>
      unplaceField(template, key, req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be removed.');
    } else {
      flash(
        req,
        'success',
        key.startsWith('s:')
          ? 'Section removed. Its fields now belong to the section above.'
          : 'Taken off the form. It is in the palette if you want it back.',
      );
    }
    res.redirect(BUILDER_PAGE(template.id, 'the-form'));
  }),
);

/** Deletes a question for good, wording and all. Built-ins are refused. */
templateAdminRouter.post(
  '/:id/fields/:key/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const key = String(req.params.key);

    const attempted = await attempt(() =>
      deleteQuestion(template, key, req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be deleted.');
    } else {
      flash(req, 'success', 'Question deleted.');
    }
    res.redirect(BUILDER_PAGE(template.id, 'the-form'));
  }),
);

/**
 * Who may raise a ticket from this template.
 *
 * No groups ticked means everybody, which is the normal case. The default
 * template cannot be restricted at all - see setTemplateAudience.
 */
templateAdminRouter.post(
  '/:id/audience',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const submitted = raw.groups;
    const wanted = Array.isArray(submitted)
      ? submitted.map(String)
      : typeof submitted === 'string' && submitted
        ? [submitted]
        : [];

    const attempted = await attempt(() =>
      setTemplateAudience(template, wanted, req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be saved.');
    } else {
      flash(
        req,
        'success',
        wanted.length === 0
          ? '"' + template.name + '" is offered to everybody.'
          : '"' + template.name + '" is offered to ' + wanted.length + ' group(s).',
      );
    }
    res.redirect(BUILDER_PAGE(template.id, 'audience'));
  }),
);

// ---------------------------------------------------------------------------
// The default template
// ---------------------------------------------------------------------------

/**
 * Hands the default to another template.
 *
 * There is no "clear": one template is always the default, because it is the
 * form a ticket is raised on. The flag moves, and the list is where it is
 * chosen, so that is where this returns to.
 */
templateAdminRouter.post(
  '/:id/default',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);

    const attempted = await attempt(() =>
      setDefaultTemplate(template.id, req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be set.');
    } else {
      flash(req, 'success', '"' + template.name + '" is now the default form.');
    }
    res.redirect('/admin/settings/templates');
  }),
);

/**
 * A copy of a template, with its form and its tasks.
 *
 * It lands on the copy's own builder, because the next thing anybody does
 * is change the thing they copied it for.
 */
templateAdminRouter.post(
  '/:id/duplicate',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const template = await builderTarget(req);
    const copied = await attempt(() => duplicateTemplate(template.id, req.currentUser?.id ?? null));
    if (!copied.ok) {
      flash(req, 'error', Object.values(copied.errors)[0] ?? 'That could not be copied.');
      res.redirect('/admin/settings/templates');
      return;
    }
    flash(req, 'success', '"' + copied.value.name + '" is a copy, not offered to requesters yet.');
    res.redirect('/admin/settings/templates/' + copied.value.id);
  }),
);

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

templateAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const existing = await findTemplate(id);
    if (!existing) throw notFound('That template no longer exists.');

    const attempted = await attempt(() => deleteTemplate(id));
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be removed.');
      res.redirect('/admin/settings/templates');
      return;
    }

    auditRequest(req, {
      action: 'template.deleted',
      targetType: 'template',
      targetId: id,
      detail: { name: existing.name },
    });
    flash(req, 'success', 'Template "' + existing.name + '" removed.');
    res.redirect('/admin/settings/templates');
  }),
);

// ---------------------------------------------------------------------------
// Tasks attached to a template
// ---------------------------------------------------------------------------

/**
 * Adds a task to a template.
 *
 * The parent is chosen in the dialog, the same way a subcategory chooses its
 * category, so one template can carry as many tasks as the work needs. The
 * task itself is deliberately thin - a name, a team and a priority; anything
 * more elaborate is a template of its own.
 */
templateAdminRouter.post(
  '/:id/tasks',
  writeLimiter,
  asyncHandler(async (req, res) => {
    // The dialog may name a different template than the page it sits on.
    const wanted = typeof req.body?.parentId === 'string' && req.body.parentId
      ? String(req.body.parentId)
      : String(req.params.id);
    const parent = await findTemplate(wanted);
    if (!parent) throw notFound('That template no longer exists.');
    if (parent.parent_template_id) {
      flash(req, 'error', 'A task cannot carry tasks of its own.');
      res.redirect('/admin/settings/templates/' + String(req.params.id));
      return;
    }

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? normaliseLine(raw.name) : '';
    if (name.length < 2) {
      res.status(400).render(
        'admin/settings/template-edit',
        await editView(parent, {
          errors: { name: 'Give the task a name.' },
          openDialog: 'add-task',
        }),
      );
      return;
    }

    const priority = TICKET_PRIORITIES.includes(raw.priority as never)
      ? (raw.priority as (typeof TICKET_PRIORITIES)[number])
      : parent.priority;

    const attempted = await attempt(() =>
      addTaskTemplate(
        parent.id,
        {
          name,
          summary: typeof raw.summary === 'string' ? normaliseLine(raw.summary) : '',
          title: name,
          body: typeof raw.body === 'string' ? normaliseText(raw.body) : '',
          priority,
          category: parent.category,
          categoryId: parent.category_id,
          type: 'task',
          ...routingFrom(raw),
          fields: [],
          isActive: true,
        },
        req.currentUser?.id ?? null,
      ),
    );
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That task could not be added.');
      res.redirect(BUILDER_PAGE(parent.id, 'tasks'));
      return;
    }
    const created = attempted.value;
    if (raw.mandatory === 'on') await setTaskMandatory(parent.id, created.id, true);

    auditRequest(req, {
      action: 'template.task.added',
      targetType: 'template',
      targetId: parent.id,
      detail: { task: created.name },
    });
    flash(req, 'success', 'Task "' + created.name + '" added to ' + parent.name + '.');
    res.redirect(BUILDER_PAGE(parent.id, 'tasks'));
  }),
);

/** Mandatory or not, one task at a time. */
templateAdminRouter.post(
  '/:id/tasks/:taskId/mandatory',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const parent = await findTemplate(String(req.params.id));
    if (!parent) throw notFound('That template no longer exists.');
    const mandatory = (req.body as Record<string, unknown>)?.mandatory === 'on';
    await setTaskMandatory(parent.id, String(req.params.taskId), mandatory);
    auditRequest(req, {
      action: 'template.task.' + (mandatory ? 'made_mandatory' : 'made_optional'),
      targetType: 'template',
      targetId: parent.id,
      detail: { task: String(req.params.taskId) },
    });
    res.redirect(BUILDER_PAGE(parent.id, 'tasks'));
  }),
);

/** The two rules about closing a ticket by its tasks. */
templateAdminRouter.post(
  '/:id/task-rules',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const parent = await findTemplate(String(req.params.id));
    if (!parent) throw notFound('That template no longer exists.');
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const rules = { closeWhenTasksDone: raw.closeWhenTasksDone === 'on', requireTasksDone: raw.requireTasksDone === 'on' };
    await setTaskRules(parent.id, rules);
    auditRequest(req, { action: 'template.task_rules.changed', targetType: 'template', targetId: parent.id, detail: rules });
    flash(req, 'success', 'Task rules saved. They apply to tickets raised from now on.');
    res.redirect(BUILDER_PAGE(parent.id, 'tasks'));
  }),
);

templateAdminRouter.post(
  '/:id/tasks/:taskId/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const parent = await findTemplate(String(req.params.id));
    if (!parent) throw notFound('That template no longer exists.');

    await deleteTaskTemplate(parent.id, String(req.params.taskId));
    auditRequest(req, {
      action: 'template.task.removed',
      targetType: 'template',
      targetId: parent.id,
    });
    flash(req, 'success', 'Task removed.');
    res.redirect(BUILDER_PAGE(parent.id, 'tasks'));
  }),
);
