import { Router, type Request, type Response } from 'express';
import { settings } from '../settings/index.js';
import { enabledDashboards } from '../services/dashboards.js';
import { SLA_FILTERS, SLA_STATE_LABELS, slaFor, type TicketSla } from '../services/sla.js';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { logger } from '../lib/logger.js';
import { auditRequest } from '../lib/audit.js';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { normaliseEmail, normaliseLine, normaliseText } from '../lib/util.js';
import { requireAuth } from '../middleware/auth.js';
import { assertCsrfToken } from '../middleware/csrf.js';
import { allowOwnScripts, writeLimiter } from '../middleware/security.js';
import { buildTimeline } from '../services/ticket-timeline.js';
import { flash } from '../middleware/view-locals.js';
import { isStaff, listAssignableStaff, findUserById, findUserByEmail, type UserRow } from '../services/users.js';
import { mayRaiseFor } from '../services/teams.js';
import { BLANK, filterParams, menuValues, readColumnFilters, type ColumnValue } from '../lib/column-filters.js';
import { findGroup, groupManagers, groupsForUser, listActiveGroups, type GroupRow } from '../services/groups.js';
import { userGroupIdsFor } from '../services/user-groups.js';
import { notifyTicket } from '../services/mail/outbox.js';
import {
  findCategory,
  flatten,
  catalogueTree,
  categoryPath,
  routingGroupFor,
  selectableCategories,
} from '../services/catalogue.js';
import {
  serviceCatalogueFor,
  serviceCatalogueGrid,
  serviceCatalogueHeading,
  serviceCatalogueOn,
} from '../services/service-catalogue.js';
import {
  composeDescription,
  defaultLayout,
  canUseTemplate,
  defaultTemplate,
  findTemplate,
  layoutField,
  formSections,
  defaultSections,
  listTaskTemplates,
  missingAnswers,
  answerProblems,
  hiddenFieldKeys,
  sectionsCss,
  templatesVisibleTo,
  visibleLayout,
  type FieldMode,
  type TemplateRow,
  requesterDetails,
} from '../services/templates.js';
import {
  ALLOWED_EXTENSIONS,
  attachmentLimits,
  readAttachment,
  countAttachments,
  deleteAttachment,
  findAttachment,
  formatBytes,
  listAttachments,
  markEmailed,
  sanitiseFilename,
  storeAttachment,
  verifyType,
} from '../services/attachments.js';
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  TYPE_LABELS,
  type TicketType,
  addComment,
  canSeeTicket, seesInternal, writesInternal,
  approvalBlocks,
  tasksBlock,
  createTicket,
  deleteComment,
  deleteTicket,
  getTicketById,
  listComments,
  listEvents,
  listTasks,
  listTickets,
  ticketColumnValues,
  ticketCounts,
  updateTicket,
} from '../services/tickets.js';
import { can } from '../auth/permissions.js';

export const ticketRouter = Router();

ticketRouter.use(requireAuth());

const uuid = z.string().uuid();

const listQuery = z.object({
  scope: z.enum(['all', 'mine', 'assigned', 'unassigned', 'myGroups']).default('all'),
  group: z.union([uuid, z.literal('')]).optional(),
  type: z.enum([...TICKET_TYPES, 'any']).default('any'),
  category: z.union([uuid, z.literal('')]).optional(),
  status: z.enum([...TICKET_STATUSES, 'any', 'active']).default('active'),
  priority: z.enum([...TICKET_PRIORITIES, 'any']).default('any'),
  sla: z.enum([...SLA_FILTERS, 'any']).default('any'),
  q: z.string().trim().max(200).optional(),
  requester: z.union([uuid, z.literal('')]).optional(),
  // A column of the queue, and which way. Anything else falls back to the
  // default order (most recently updated first), as every other filter does.
  sort: z.enum(['reference', 'title', 'type', 'status', 'priority', 'requester', 'assignee', 'updated']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

/**
 * What a raised ticket must contain.
 *
 * The description's minimum applies **only when the form asked for one**. A
 * template may leave Description off its form entirely - the title and the
 * classification carry the meaning, and the template's opening text fills the
 * body - and insisting on ten characters there would refuse the ticket with
 * an error pointing at a box the requester cannot see.
 */
function createBody(typedDescription: boolean) {
  return z.object({
    title: z.string().trim().min(3, 'Give the ticket a short title.').max(200),
    description: typedDescription
      ? z.string().trim().min(10, 'Describe the problem in a little more detail.').max(20_000)
      : z.string().trim().max(20_000),
    priority: z.enum(TICKET_PRIORITIES).default('normal'),
    category: z.enum(TICKET_CATEGORIES).default('other'),
  });
}

const updateBody = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  // Empty string means "unassign"; absent means "leave alone".
  assigneeId: z.union([uuid, z.literal('')]).optional(),
  // Likewise for the technician group.
  groupId: z.union([uuid, z.literal('')]).optional(),
  categoryId: z.union([uuid, z.literal('')]).optional(),
  /** Why the ticket is going on hold. Required when the status becomes that. */
  holdReason: z.string().max(2000).optional(),
  /** Why the ticket is cancelled. Required when the setting says so. */
  cancelNote: z.string().max(2000).optional(),
  /** How it was resolved. Required when the setting says so. */
  resolveNote: z.string().max(2000).optional(),
});

/**
 * A category id plus everything beneath it.
 *
 * Filtering on "Hardware" has to mean its subcategories and items too, or
 * the filter would only match tickets filed at exactly that level.
 */
async function withDescendants(id: string): Promise<string[]> {
  const node = flatten(await catalogueTree()).find((n) => n.id === id);
  if (!node) return [id];
  const out: string[] = [];
  const visit = (n: typeof node): void => {
    out.push(n.id);
    for (const child of n.children) visit(child);
  };
  visit(node);
  return out;
}

const labels = {
  statuses: TICKET_STATUSES,
  priorities: TICKET_PRIORITIES,
  categories: TICKET_CATEGORIES,
  statusLabels: STATUS_LABELS,
  priorityLabels: PRIORITY_LABELS,
  categoryLabels: CATEGORY_LABELS,
  types: TICKET_TYPES,
  typeLabels: TYPE_LABELS,
};

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

ticketRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const viewer = req.currentUser;
    if (!viewer) throw forbidden();

    const parsed = listQuery.safeParse(req.query);
    // A malformed filter falls back to the defaults rather than erroring.
    const filters = parsed.success ? parsed.data : listQuery.parse({});

    // Needed both to resolve the "my teams" scope and to render the filter.
    const viewerGroups = isStaff(viewer.role)
      ? await groupsForUser(viewer.id)
      : [];

    // Excel-like column filters (lib/column-filters.ts): the people columns
    // are staff's only, as the columns themselves are.
    const filterable = isStaff(viewer.role) ? ['type', 'status', 'priority', 'requester', 'assignee'] : ['type', 'status', 'priority'];
    const columns = readColumnFilters(req.query as Record<string, unknown>, filterable);
    const query = {
      scope: filters.scope,
      status: filters.status,
      priority: filters.priority,
      ...(filters.sla !== 'any' ? { sla: filters.sla } : {}),
      ...(filters.q ? { search: filters.q } : {}),
      ...(filters.group ? { groupId: filters.group } : {}),
      ...(filters.requester && isStaff(viewer.role) ? { requesterId: filters.requester } : {}),
      ...(filters.type !== 'any' ? { type: filters.type } : {}),
      ...(filters.category ? { categoryIds: await withDescendants(filters.category) } : {}),
      viewerGroupIds: viewerGroups.map((g) => g.id),
      columns,
    } as const;

    const [page, counts, allGroups, menuRows] = await Promise.all([
      listTickets(viewer, {
        ...query,
        ...(filters.sort ? { sort: filters.sort, dir: filters.dir ?? 'asc' } : {}),
        page: filters.page,
        perPage: 25,
      }),
      ticketCounts(viewer),
      isStaff(viewer.role) ? listActiveGroups() : Promise.resolve([]),
      Promise.all(filterable.map((key) => ticketColumnValues(viewer, query, key))),
    ]);

    // Each header's menu: its values with their labels, and what is ticked.
    const labelFor: Record<string, (v: string, fallback: string) => string> = {
      type: (v) => TYPE_LABELS[v as TicketType] ?? v,
      status: (v) => STATUS_LABELS[v as keyof typeof STATUS_LABELS] ?? v,
      priority: (v) => PRIORITY_LABELS[v as keyof typeof PRIORITY_LABELS] ?? v,
      requester: (_v, fallback) => fallback,
      assignee: (v, fallback) => (v === BLANK ? 'Unassigned' : fallback),
    };
    const columnMenus: Record<string, { values: ColumnValue[]; selected: string[] }> = {};
    filterable.forEach((key, i) => {
      const rows = menuRows[i]!.map((r) => ({ ...r, label: labelFor[key]!(r.value, r.label || r.value) }));
      columnMenus[key] = { values: menuValues(rows, columns[key] ?? [], (v) => labelFor[key]!(v, v)), selected: columns[key] ?? [] };
    });

    // SLA is the service desk's measure, so only staff see it. One
    // query per row, on a page of 25.
    const slaById: Record<string, TicketSla | null> = {};
    if (isStaff(viewer.role)) {
      for (const row of page.items) slaById[row.id] = await slaFor(row);
    }

    // Settings - Dashboards: every one switched on, above a requester's list
    // in the standard look. A custom portal places its own with
    // {{dashboard:<id>}} instead, so it is not drawn twice.
    const dashboards =
      viewer.role === 'user' && !res.locals.portal ? await enabledDashboards(viewer) : [];

    // "All their tickets" from a ticket's requester card: say whose they are.
    const requesterFilter =
      filters.requester && isStaff(viewer.role) ? ((await findUserById(filters.requester)) ?? null) : null;

    res.render('tickets/index', {
      title: 'Tickets',
      requesterFilter: requesterFilter ? { id: requesterFilter.id, name: requesterFilter.display_name } : null,
      dashboards: dashboards.filter((d) => d !== ''),
      page,
      slaById,
      slaStateLabels: SLA_STATE_LABELS,
      // The SLA filter: staff only, while SLA is on.
      slaFilterOffered: isStaff(viewer.role) && settings().sla.enabled,
      filters,
      columnFilters: columns,
      columnMenus,
      // Everything the address says, for header links and filter forms that keep it all.
      queueState: {
        scope: filters.scope, group: filters.group, type: filters.type, category: filters.category,
        status: filters.status, priority: filters.priority, sla: filters.sla, q: filters.q,
        requester: filters.requester, sort: filters.sort, dir: filters.dir,
        ...filterParams(columns),
      },
      groups: allGroups,
      viewerGroups,
      categoryOptions: await selectableCategories(),
      levels: await catalogueLevels(),
      counts,
      ...labels,
    });
  }),
);

// ---------------------------------------------------------------------------
// New ticket
// ---------------------------------------------------------------------------

/** Answers to a template's prompts, as field_0, field_1 ... */
function answersFrom(raw: Record<string, unknown>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // `answer_<id>` is what the builder emits; `field_<n>` is what templates
    // written before it used, and is still accepted so an open form submits.
    if (!/^(answer_[\w-]+|field_\d+)$/.test(key)) continue;
    if (typeof value === 'string') {
      answers[key] = normaliseText(value);
    } else if (Array.isArray(value)) {
      // Several choices: the ticks, in the order the form lists them.
      answers[key] = value.filter((v): v is string => typeof v === 'string').map((v) => normaliseLine(v)).join(', ');
    }
  }
  return answers;
}


/**
 * The catalogue split into its three levels, for three separate pickers.
 *
 * Category, Sub category and Item are their own fields on the form, so each
 * can be made mandatory on its own. Nothing narrows a list as you go - that
 * would need a script, and none is served here - so each level offers all of
 * its nodes, grouped under the parent they belong to. The grouping is what
 * makes the pairing readable: "sam" on its own means nothing, "sam" under
 * "Hardware" is obvious.
 */
async function catalogueLevels(): Promise<{
  category: { id: string; name: string }[];
  subcategory: { group: string; options: { id: string; name: string }[] }[];
  item: { group: string; options: { id: string; name: string }[] }[];
}> {
  const nodes = await selectableCategories();
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const grouped = (level: number) => {
    const groups = new Map<string, { id: string; name: string }[]>();
    for (const node of nodes) {
      if (node.level !== level) continue;
      const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
      const label = parent ? parent.path : 'Unfiled';
      const list = groups.get(label) ?? [];
      list.push({ id: node.id, name: node.name });
      groups.set(label, list);
    }
    return [...groups.entries()].map(([group, options]) => ({ group, options }));
  };

  return {
    category: nodes.filter((n) => n.level === 1).map((n) => ({ id: n.id, name: n.name })),
    subcategory: grouped(2),
    item: grouped(3),
  };
}

/**
 * A node's ancestors, keyed by the level each sits at.
 *
 * A template filed at "Hardware > Not working > Mouse" should open with all
 * three pickers already on that branch, not just the deepest one - so the
 * trail is spread back across the three fields it came from.
 */
/** A node's ancestors, named by the level each sits at, for a locked field. */
async function levelTrail(categoryId: string | null): Promise<Record<string, string>> {
  if (!categoryId) return {};
  const node = flatten(await catalogueTree()).find((n) => n.id === categoryId);
  if (!node) return {};

  const keys = ['category', 'subcategory', 'item'];
  const trail: Record<string, string> = {};
  node.trail.forEach((step, depth) => {
    const key = keys[depth];
    if (key) trail[key] = step.name;
  });
  return trail;
}

async function levelValues(categoryId: string | null): Promise<Record<string, string>> {
  const empty = { categoryId: '', subcategoryId: '', itemId: '' };
  if (!categoryId) return empty;

  const node = flatten(await catalogueTree()).find((n) => n.id === categoryId);
  if (!node) return empty;

  const inputs = ['categoryId', 'subcategoryId', 'itemId'];
  const values = { ...empty };
  node.trail.forEach((step, depth) => {
    const input = inputs[depth];
    if (input) values[input as keyof typeof values] = step.id;
  });
  return values;
}

/**
 * The stylesheet that shows a template's conditional sections once their
 * answers are picked - CSS, because the ticket form serves no script. A
 * file, because the page policy forbids inline styles.
 */
ticketRouter.get(
  '/form/:templateId/sections.css',
  asyncHandler(async (req: Request, res: Response) => {
    const template = await findTemplate(String(req.params.templateId));
    if (!template) throw notFound('No such template.');
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', typeof req.query.v === 'string' ? 'private, max-age=604800, immutable' : 'private, no-cache');
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    res.send(sectionsCss(template));
  }),
);

/** The address of a template's section stylesheet, or null when it has no conditions. */
function sectionsCssUrl(template: { id: string; updated_at: string } | null | undefined, sections: { showWhen: unknown[] }[]): string | null {
  if (!template || !sections.some((s) => s.showWhen.length > 0)) return null;
  return '/tickets/form/' + template.id + '/sections.css?v=' + encodeURIComponent(template.updated_at);
}

ticketRouter.get(
  '/new',
  // The chosen files as chips (public/js/reply-files.js), as in a reply.
  allowOwnScripts(),
  asyncHandler(async (req: Request, res: Response) => {
    const viewer = req.currentUser;
    if (!viewer) throw forbidden();

    // Only the forms this person may raise. A template restricted to a user
    // group is not in the picker for anybody outside it.
    const mine = await userGroupIdsFor(viewer.id);
    const templates = await templatesVisibleTo(mine);
    const requested = typeof req.query.template === 'string' ? req.query.template : '';

    /*
     * The service catalogue, when the service desk has switched it on and
     * nothing has been chosen yet: "New ticket" opens a page of tiles rather
     * than a form. A tile is a link carrying ?template=, so choosing one
     * arrives back here and falls through to the form below - which is also
     * why a link somebody saved to a form still opens that form.
     *
     * Access is the template's own: serviceCatalogueFor() leaves out a tile
     * whose form this person may not raise, and the tiles after it close the
     * gap, so a catalogue never advertises a service to the one person who
     * cannot have it.
     */
    if (!requested && serviceCatalogueOn()) {
      const all = await serviceCatalogueFor(mine);
      const grid = serviceCatalogueGrid();

      /*
       * The filter buttons, when the service desk switched them on: the
       * kinds its own tiles actually offer, never a button that would
       * empty the page. The chosen one narrows the tiles and decides what
       * the New ticket button raises - that kind's default template.
       */
      const kinds = grid.filters
        ? (['service_request', 'incident', 'change_request'] as const).filter((kind) =>
            all.some((entry) => entry.template.type === kind),
          )
        : [];
      const askedKind = typeof req.query.kind === 'string' ? req.query.kind : '';
      const kind = kinds.find((k) => k === askedKind) ?? '';
      const entries = kind ? all.filter((entry) => entry.template.type === kind) : all;

      // What "New ticket" raises here: the chosen kind's default, or the
      // service desk's own when nothing is chosen.
      const fallback = await defaultTemplate((kind || undefined) as TicketType | undefined);
      /*
       * A page at a time, by the cells the tiles are in - so a gap the
       * service desk left is a gap here too. A page with nothing on it is
       * not a page: tiles placed only on the editor's second page should
       * not give a requester an empty first one.
       */
      const byPage = new Map<number, typeof entries>();
      for (const entry of entries) {
        const page = Math.floor(entry.cell / grid.perPage);
        byPage.set(page, [...(byPage.get(page) ?? []), entry]);
      }
      const filled = [...byPage.keys()].sort((a, b) => a - b);
      const pages = Math.max(1, filled.length);
      const asked = Number(req.query.page);
      const pageNumber = Math.min(pages, Math.max(1, Number.isFinite(asked) ? Math.trunc(asked) : 1));
      const shown = byPage.get(filled[pageNumber - 1] ?? 0) ?? [];

      // As wide as the widest column in use, never wider than the setting:
      // three tiles do not sit in three fifths of the page.
      const columns = Math.min(
        grid.columns,
        shown.reduce((widest, entry) => Math.max(widest, (entry.cell % grid.columns) + 1), 1),
      );
      res.render('tickets/catalogue', {
        title: 'New ticket',
        heading: serviceCatalogueHeading() || 'What do you need?',
        entries,
        grid,
        columns,
        pages,
        pageNumber,
        // Each tile with the column it belongs in, so a gap stays a gap.
        page: shown.map((entry) => ({ ...entry, column: (entry.cell % grid.columns) + 1 })),
        kinds,
        kind,
        typeLabels: TYPE_LABELS,
        defaultTemplateId: fallback?.id ?? '',
      });
      return;
    }

    // Every ticket is raised on a form, and the default is that form - so
    // there is no "no template" any more. `?template=` picks a different one;
    // anything else, including a stale or retired id, falls back to the
    // default rather than to a blank page.
    // A template they may not use is treated as though it were not there,
    // so a shared link cannot bypass the restriction.
    const chosen = requested ? await findTemplate(requested) : undefined;
    const allowed = chosen && chosen.is_active && (await canUseTemplate(chosen, mine));
    const template = allowed ? chosen : await defaultTemplate();
    const usable = template && template.is_active ? template : undefined;

    res.render('tickets/new', {
      title: 'Raise a ticket',
      templates,
      // On, the picker gives way to a link back to the tiles: choosing the
      // form twice, in two different ways, is one way too many.
      catalogue: serviceCatalogueOn(),
      requesterLines: requesterLinesFor(usable ?? null, viewer),
      template: usable ?? null,
      layout: usable ? visibleLayout(usable) : defaultLayout(),
      sections: usable ? formSections(usable) : defaultSections(),
      sectionsCss: usable ? sectionsCssUrl(usable, formSections(usable)) : null,
      values: {
        title: usable?.title ?? '',
        description: '',
        priority: usable?.priority ?? 'normal',
        category: usable?.category ?? 'other',
        // The three pickers open on the branch this template is filed under.
        ...(await levelValues(usable?.category_id ?? null)),
      },
      answers: {},
      errors: {},
      categoryOptions: await selectableCategories(),
      levels: await catalogueLevels(),
      categoryId: usable?.category_id ?? null,
      templateCategoryPath: usable ? await categoryPath(usable.category_id) : "",
      levelTrail: await levelTrail(usable?.category_id ?? null),
      taskPreview: usable ? await listTaskTemplates(usable.id) : [],
      ...(await routingChoices(usable ?? null)),
      ...attachmentViewData(),
      ...labels,
    });
  }),
);

/**
 * The lists the Technician group and Assignee fields offer.
 *
 * Read for everybody who opens the form, requester included: the fields are
 * only drawn when the template placed them, and a group's name and a
 * technician's name are what a requester reads on their own ticket anyway.
 * A field that is not on the form is not settable by posting it - that rule
 * lives in `modeOf`, not here.
 */
async function routingChoices(
  template?: { group_id: string | null; category_id: string | null } | null,
): Promise<{ groups: GroupRow[]; assignees: UserRow[]; templateGroupName: string }> {
  const [groups, assignees] = await Promise.all([listActiveGroups(), listAssignableStaff()]);
  // Where a view-only Technician group field says the ticket will land: the
  // template's own group, else whatever its category inherits - the same
  // two steps the ticket itself takes.
  const landsWith = template
    ? (template.group_id ?? (await routingGroupFor(template.category_id)))
    : null;
  return {
    groups,
    assignees,
    templateGroupName: landsWith ? (groups.find((g) => g.id === landsWith)?.name ?? '') : '',
  };
}

ticketRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const viewer = req.currentUser;
    if (!viewer) throw forbidden();

    // The form is multipart so a file can be attached while the ticket is
    // being raised. That means parsing the body here, before the token can
    // be checked - the global CSRF middleware runs too early to see it, so
    // this path is exempt there and does the check itself a few lines down.
    const limits = attachmentLimits();
    const files = limits.enabled ? await parseUpload(req, res, limits) : [];

    assertCsrfToken(req);

    const raw = (req.body ?? {}) as Record<string, unknown>;

    // A template contributes the opening text and a set of prompts; what the
    // requester typed is appended to it. The ticket that results is an
    // ordinary ticket, so a template edited later changes nothing.
    let template: TemplateRow | undefined;
    if (typeof raw.templateId === 'string' && raw.templateId) {
      template = await findTemplate(raw.templateId);
      if (template && !template.is_active) template = undefined;
      // Hiding a template from the picker is presentation. The rule lives
      // here: a posted templateId somebody is not entitled to is dropped, so
      // the ticket is raised on the plain form rather than theirs.
      if (template && !(await canUseTemplate(template, await userGroupIdsFor(viewer.id)))) {
        template = undefined;
      }
    }
    const answers = answersFrom(raw);

    /**
     * How this template treats one field.
     *
     * 'absent' means the field is not on this template's form at all - the
     * builder's canvas starts empty and holds only what was dragged onto it.
     * Without a template every field is simply editable, which is what the
     * plain form has always been.
     */
    const onForm = template ? new Set(visibleLayout(template).map((f) => f.key)) : null;
    // A section shown only for some answers, whose answers were not given:
    // its fields are as good as off the form, whatever was posted for them.
    const hidden = template ? hiddenFieldKeys(template, raw) : new Set<string>();
    const modeOf = (key: string): FieldMode | 'absent' => {
      if (!template || !onForm) return 'optional';
      if (!onForm.has(key) || hidden.has(key)) return 'absent';
      return layoutField(template, key)?.mode ?? 'optional';
    };

    /**
     * True when the template decides this field rather than asking for it.
     *
     * Both cases: shown but not editable, and not shown at all. Either way
     * the template's own value is what the ticket gets.
     */
    const locked = (key: string): boolean =>
      modeOf(key) === 'view_only' || modeOf(key) === 'absent';

    // A locked field is the template's decision, not the requester's, so
    // whatever arrived for it is **discarded** and the template's own value
    // used instead. `readonly` and `disabled` are display hints - a browser
    // can be told to post anything - so this has to happen here or "view
    // only" would be advice rather than a rule.
    const typed = typeof raw.description === 'string' ? normaliseText(raw.description) : '';
    const ownWords = template && locked('description') ? '' : typed;
    const description = template
      ? [composeDescription(template, answers, hidden), ownWords].filter(Boolean).join('\n\n')
      : typed;

    const submittedTitle = typeof raw.title === 'string' ? normaliseLine(raw.title) : '';
    const candidate = {
      title:
        template && locked('title') ? template.title || template.name : submittedTitle,
      description,
      priority: template && locked('priority') ? template.priority : raw.priority,
      category: raw.category,
    };

    // Asked for when the field is on the form and the requester can type in
    // it; a view-only or absent description is the template's, not theirs.
    const typedDescription = !template || modeOf('description') === 'optional' || modeOf('description') === 'mandatory';
    const parsed = createBody(typedDescription).safeParse(candidate);
    const unanswered = template ? missingAnswers(template, answers, hidden) : [];
    const badAnswers = template ? answerProblems(template, answers, hidden) : [];

    // The built-in fields a template marked mandatory. Questions are checked
    // by missingAnswers; these have no answer slot of their own.
    const required: string[] = [];
    const mismatched: string[] = [];

    /**
     * The three catalogue levels, as submitted.
     *
     * Each is its own field on the form - Category, Sub category, Item - so
     * each can be made mandatory on its own. Without JavaScript the lists
     * cannot narrow as you go, so every level offers all of its nodes and
     * the pairing is checked here instead.
     */
    const levelKeys = ['category', 'subcategory', 'item'] as const;
    const levelInputs = { category: 'categoryId', subcategory: 'subcategoryId', item: 'itemId' };
    const levelLabels = { category: 'Category', subcategory: 'Sub category', item: 'Item' };
    const picked: Record<string, string | null> = {};
    for (const key of levelKeys) {
      const value = raw[levelInputs[key]];
      picked[key] = typeof value === 'string' && value ? value : null;
    }

    if (template) {
      if (modeOf('description') === 'mandatory' && !typed) required.push('Description');

      const offered = await selectableCategories();
      for (const key of levelKeys) {
        // Only worth insisting on when there is something to choose from: an
        // empty level would otherwise make the form impossible to submit.
        const hasOptions = offered.some((node) => node.level === levelKeys.indexOf(key) + 1);
        if (modeOf(key) === 'mandatory' && !picked[key] && hasOptions) {
          required.push(levelLabels[key]);
        }
      }

      // A deeper choice has to sit under the shallower one. The lists cannot
      // narrow themselves, so saying plainly that the pair does not go
      // together beats filing the ticket somewhere nobody meant.
      for (const [deeper, shallower] of [
        ['subcategory', 'category'],
        ['item', 'subcategory'],
      ] as const) {
        const child = picked[deeper] ? offered.find((n) => n.id === picked[deeper]) : undefined;
        if (!child || !picked[shallower]) continue;
        if (child.parent_id !== picked[shallower]) {
          const parent = offered.find((n) => n.id === picked[shallower]);
          mismatched.push(
            '"' + child.name + '" is not under "' + (parent?.name ?? 'that ' + levelLabels[shallower].toLowerCase()) + '"',
          );
        }
      }
    }

    // Attachments are checked before anything is written. Verifying after
    // the ticket existed would leave one behind on every rejected file, and
    // the requester would raise it again - so the queue would fill with
    // duplicates of exactly the tickets that already went wrong once.
    let fileError: string | undefined;
    // An address a form does not offer is not settable by posting one -
    // the same rule as every other field, and `modeOf` is where it lives.
    const approvalMode = template ? modeOf('approval') : 'absent';
    const approvalEmail =
      approvalMode === 'absent' || approvalMode === 'view_only'
        ? ''
        : normaliseEmail(typeof raw.approval === 'string' ? raw.approval : '');

    let approvalError: string | undefined;
    if (approvalEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(approvalEmail)) {
      approvalError = 'That does not look like an email address.';
    } else if (approvalMode === 'mandatory' && !approvalEmail) {
      approvalError = 'Who should approve this request?';
    }

    // "On behalf of": the colleague the ticket is for. Like every field, not
    // settable unless the form offers it; the address must be an active
    // account, which then becomes the requester.
    const onBehalfMode = template ? modeOf('onbehalf') : 'absent';
    const onBehalfEmail =
      onBehalfMode === 'absent' || onBehalfMode === 'view_only'
        ? ''
        : normaliseEmail(typeof raw.onBehalfOf === 'string' ? raw.onBehalfOf : '');
    let onBehalfError: string | undefined;
    let onBehalfOf: Awaited<ReturnType<typeof findUserByEmail>>;
    if (onBehalfEmail) {
      const person = await findUserByEmail(onBehalfEmail);
      if (!person || person.status !== 'active') {
        onBehalfError = 'There is no active account with that address.';
      } else if (!mayRaiseFor(viewer, person)) {
        // Only for somebody in the same team (services/teams.ts); staff, for anybody.
        onBehalfError = 'You can raise a ticket only for people in your team.';
      } else if (person.id !== viewer.id) {
        onBehalfOf = person;
      }
    } else if (onBehalfMode === 'mandatory') {
      onBehalfError = 'Who is this request for?';
    }

    if (template && modeOf('attachments') === 'mandatory' && files.length === 0) {
      fileError = 'This request needs at least one file attached.';
    } else if (template && modeOf('attachments') === 'absent' && files.length > 0) {
      // Not an error: the form did not offer attachments, so anything that
      // arrived was not asked for and is simply not stored.
      files.length = 0;
    } else if (files.length > limits.maxPerTicket) {
      fileError = 'A ticket may hold at most ' + limits.maxPerTicket + ' attachments.';
    } else {
      for (const file of files) {
        try {
          verifyType(sanitiseFilename(file.originalname), file.buffer.subarray(0, 64));
        } catch (err) {
          fileError =
            err instanceof HttpError
              ? sanitiseFilename(file.originalname) + ': ' + err.message
              : 'That file could not be accepted.';
          break;
        }
      }
    }

    if (
      !parsed.success ||
      unanswered.length > 0 ||
      badAnswers.length > 0 ||
      required.length > 0 ||
      mismatched.length > 0 ||
      fileError ||
      approvalError ||
      onBehalfError
    ) {
      const errors: Record<string, string> = {};
      if (parsed.success === false) {
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? 'form');
          if (!errors[key]) errors[key] = issue.message;
        }
      }
      const missing = [...required, ...unanswered];
      const notes: string[] = [];
      if (missing.length > 0) notes.push('Please complete: ' + missing.join(', ') + '.');
      if (mismatched.length > 0) notes.push(mismatched.join('; ') + '.');
      if (badAnswers.length > 0) notes.push(badAnswers.join('; ') + '.');
      if (notes.length > 0) errors.form = notes.join(' ');
      if (approvalError) errors.approval = approvalError;
      if (onBehalfError) errors.onBehalfOf = onBehalfError;
      if (fileError) {
        errors.files = fileError;
      } else if (files.length > 0) {
        // A browser will not refill a file input, so say so rather than
        // let someone submit again and silently lose the attachment.
        errors.files =
          'Your file was not attached. Please choose it again before submitting.';
      }
      res.status(400).render('tickets/new', {
        title: 'Raise a ticket',
        requesterLines: requesterLinesFor(template ?? null, viewer),
        templates: await templatesVisibleTo(await userGroupIdsFor(viewer.id)),
        template: template ?? null,
        layout: template ? visibleLayout(template) : defaultLayout(),
        sections: template ? formSections(template) : defaultSections(),
        sectionsCss: template ? sectionsCssUrl(template, formSections(template)) : null,
        values: {
          ...candidate,
          onBehalfOf: onBehalfEmail,
          title: submittedTitle,
          description: typed,
          // What was chosen, so a refusal does not reset the pickers.
          categoryId: picked.category ?? '',
          subcategoryId: picked.subcategory ?? '',
          itemId: picked.item ?? '',
          groupId: typeof raw.groupId === 'string' ? raw.groupId : '',
          assigneeId: typeof raw.assigneeId === 'string' ? raw.assigneeId : '',
        },
        answers,
        errors,
        categoryOptions: await selectableCategories(),
        levels: await catalogueLevels(),
        categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : null,
        templateCategoryPath: template ? await categoryPath(template.category_id) : "",
        levelTrail: await levelTrail(template?.category_id ?? null),
        taskPreview: template ? await listTaskTemplates(template.id) : [],
        ...(await routingChoices(template ?? null)),
        ...attachmentViewData(),
        ...labels,
      });
      return;
    }

    // The classification comes from the form, falling back to whatever the
    // template declared. An id that no longer exists is dropped rather than
    // refused: the catalogue is editable, and a stale picker should not cost
    // someone the ticket they just typed.
    // The deepest level answered is what the ticket is filed against: an
    // item implies its sub category and category, so storing the deepest one
    // keeps the whole branch without three columns to disagree with.
    //
    // A level the template locked is the template's, whatever the form posted.
    const openLevels = levelKeys.filter((key) => !(template && locked(key)));
    const deepest = [...levelKeys]
      .reverse()
      .find((key) => openLevels.includes(key) && picked[key]);
    const chosenCategory = deepest ? picked[deepest] : (template?.category_id ?? null);
    const categoryId = chosenCategory && (await findCategory(chosenCategory))
      ? chosenCategory
      : null;

    /*
     * Who the work goes to.
     *
     * A template that names a group has been set up deliberately for this
     * kind of request, so it wins; otherwise the catalogue decides,
     * inheriting from the nearest level that names a group. Without that
     * fallback the group on a category would be decorative.
     *
     * **Unless the form asked.** A template may place the Technician group
     * field, and then whoever raises the ticket chooses - but only from the
     * active groups, and only when the field is theirs to fill in: a group
     * posted for a form that does not offer one is discarded, the same rule
     * as every other field (`modeOf`).
     */
    const askedGroup =
      template && !locked('group') && typeof raw.groupId === 'string' && raw.groupId
        ? (await findGroup(raw.groupId))
        : undefined;
    const groupId = (askedGroup && askedGroup.is_active ? askedGroup.id : null)
      ?? template?.group_id
      ?? (await routingGroupFor(categoryId));

    /*
     * And who picks it up. Only somebody the service desk would let you
     * assign a ticket to by hand - an active agent or administrator - so a
     * forged id cannot put a requester's name in the assignee column.
     */
    const askedAssignee =
      template && !locked('assignee') && typeof raw.assigneeId === 'string' && raw.assigneeId
        ? (await listAssignableStaff()).find((person) => person.id === raw.assigneeId)
        : undefined;

    const ticket = await createTicket({
      title: parsed.data.title,
      description: parsed.data.description,
      priority: parsed.data.priority,
      category: parsed.data.category,
      requesterId: onBehalfOf?.id ?? viewer.id,
      ...(onBehalfOf ? { raisedBy: viewer.id } : {}),
      templateId: template?.id ?? null,
      type: template?.type ?? 'incident',
      groupId,
      ...(askedAssignee ? { assigneeId: askedAssignee.id } : {}),
      categoryId,
      ...(approvalEmail ? { approvalEmail } : {}),
      ...(template?.close_when_tasks_done ? { closeWhenTasksDone: true } : {}),
      ...(template?.require_tasks_done ? { requireTasksDone: true } : {}),
    });

    // A template may carry tasks: the work that always goes with this kind
    // of request. They are raised with it, each routed to its own team.
    if (template) {
      for (const task of await listTaskTemplates(template.id)) {
        await createTicket({
          title: task.title || task.name,
          description: task.body || task.summary || task.name,
          priority: task.priority,
          category: task.category,
          requesterId: onBehalfOf?.id ?? viewer.id,
          templateId: task.id,
          type: 'task',
          groupId: task.group_id ?? (await routingGroupFor(task.category_id)),
          categoryId: task.category_id,
          parentId: ticket.id,
          ...(task.task_mandatory ? { taskMandatory: true } : {}),
        });
      }
    }

    // Already verified above, so this only writes.
    if (files.length > 0) {
      await storeFiles(req, ticket.id, viewer.id, files, false);
    }

    auditRequest(req, {
      action: 'ticket.created',
      targetType: 'ticket',
      targetId: ticket.id,
      detail: {
        reference: ticket.reference,
        priority: ticket.priority,
        category: ticket.category,
        ...(onBehalfOf ? { onBehalfOf: onBehalfOf.email } : {}),
      },
    });

    // Queued, not sent: a slow mail service must never hold up the person
    // who just raised a ticket.
    // Raised for somebody else: they hear who raised it, instead of thanks.
    await notifyTicket(onBehalfOf ? 'ticket.created.on_behalf' : 'ticket.created.requester', ticket.id);
    await notifyTicket('ticket.created.group', ticket.id);

    // The approver is asked at the same moment, and only when there is one.
    // `recipients` returns nothing for a ticket with no approval address, so
    // this is a no-op rather than a decision made twice.
    if (ticket.approval_email) {
      await notifyTicket('ticket.approval.requested', ticket.id);
    }

    flash(req, 'success', 'Ticket ' + ticket.reference + ' has been raised.');
    res.redirect('/tickets/' + ticket.id);
  }),
);

// ---------------------------------------------------------------------------
// Single ticket
// ---------------------------------------------------------------------------

/** Loads a ticket and enforces row-level access in one place. */
async function loadTicket(req: Request) {
  const viewer = req.currentUser;
  if (!viewer) throw forbidden();

  const id = uuid.safeParse(req.params.id);
  if (!id.success) throw notFound('That ticket does not exist.');

  const ticket = await getTicketById(id.data);
  // Unauthorised access is reported as 404, so ticket ids are not confirmed to
  // people who should not see them.
  if (!ticket || !(await canSeeTicket(viewer, ticket))) throw notFound('That ticket does not exist.');

  return { viewer, ticket };
}

ticketRouter.get(
  '/:id',
  // The reply box's file list (public/js/reply-files.js), asked for 21 Oct 2026.
  allowOwnScripts(),
  asyncHandler(async (req, res) => {
    const { viewer, ticket } = await loadTicket(req);
    // A refused reply's words, once, and only on the ticket they were for.
    const draft = req.session.replyDraft && req.session.replyDraft.ticketId === ticket.id ? req.session.replyDraft : null;
    if (req.session.replyDraft) delete req.session.replyDraft;

    // Fetched together: these are independent reads on the same ticket.
    const [comments, attachments, events, staff, groups] = await Promise.all([
      listComments(ticket.id, viewer),
      listAttachments(ticket.id, viewer),
      isStaff(viewer.role) ? listEvents(ticket.id) : Promise.resolve([]),
      isStaff(viewer.role) ? listAssignableStaff() : Promise.resolve([]),
      isStaff(viewer.role) ? listActiveGroups() : Promise.resolve([]),
    ]);

    const [tasks, categoryOptions] = await Promise.all([
      listTasks(ticket.id),
      isStaff(viewer.role) ? selectableCategories() : Promise.resolve([]),
    ]);
    const categoryPath = ticket.category_id
      ? (flatten(await catalogueTree()).find((n) => n.id === ticket.category_id)?.path ?? null)
      : null;

    // The template's Requester field says which details the service desk
    // sees about the person; without one, nothing extra is shown.
    const raisedFrom = isStaff(viewer.role) && ticket.template_id ? await findTemplate(ticket.template_id) : undefined;
    const requesterField = raisedFrom ? visibleLayout(raisedFrom).find((f) => f.key === 'requester') : undefined;
    const requesterPerson = requesterField ? await findUserById(ticket.requester_id) : undefined;
    // "Assign to me": the technician's own groups, for its popup.
    const myGroups = isStaff(viewer.role) ? (await groupsForUser(viewer.id)).filter((g) => g.is_active) : [];
    res.render('tickets/show', {
      myGroups,
      // Shown under the group, to staff.
      groupManagerNames: isStaff(viewer.role) && ticket.group_id ? (await groupManagers(ticket.group_id)).map((m) => m.display_name) : [],
      requesterCard: isStaff(viewer.role) ? await requesterCardFor(viewer, ticket) : null,
      title: ticket.reference + ' - ' + ticket.title,
      ticket,
      mayDeleteComments: await mayDeleteComments(viewer, ticket),
      requireCancelNote: settings().tickets.requireCancelNote,
      requireResolveNote: settings().tickets.requireResolveNote,
      requesterLines: requesterField && requesterPerson ? requesterDetails(requesterField, requesterPerson) : [],
      raisedByName: ticket.raised_by ? ((await findUserById(ticket.raised_by))?.display_name ?? 'a former colleague') : null,
      sla: isStaff(viewer.role) ? await slaFor(ticket) : null,
      slaStateLabels: SLA_STATE_LABELS,
      comments,
      attachments,
      timeline: buildTimeline(ticket, comments, attachments),
      replyDraft: draft,
      formatBytes,
      ...attachmentViewData(),
      events,
      staff,
      groups,
      tasks,
      categoryOptions,
      categoryPath,
      ...labels,
    });
  }),
);

/**
 * A reply or an internal note, with files if there are any (redesign,
 * 21 Oct 2026: "files go with the reply"). One press sends both, so a reply
 * that says "see the attached document" arrives with the document.
 *
 * - A **staff reply** emails its files with it, through the same notification
 *   as before - which is why every file is checked *before* anything is
 *   stored: a refusal afterwards would leave half a reply behind.
 * - An **internal note**'s files are internal, and nothing is emailed.
 * - **Files with no words** are attached and emailed to nobody: a mail with
 *   nothing to say is not one a requester can act on.
 * - Still takes a plain form post with no files, which is what it was.
 *
 * A refusal goes back beside the box, with what was typed still in it
 * (`replyDraft`) - a long reply lost to "that file is too large" is the
 * mistake this page must not make. The files have to be chosen again; a
 * browser does not let a page put them back.
 */
ticketRouter.post(
  '/:id/comments',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const limits = attachmentLimits();
    const back = '/tickets/' + String(req.params.id) + '#reply';
    let files: Express.Multer.File[] = [];

    if (req.is('multipart/form-data')) {
      try {
        files = await parseUpload(req, res, limits);
      } catch (err) {
        flash(req, 'error', err instanceof HttpError && err.status === 400 ? err.message : 'That upload could not be read.', 'reply');
        res.redirect(back);
        return;
      }
    }
    // Here, with files or without, and before the ticket is looked up - a
    // forged post is refused as one, without saying whether the ticket
    // exists. The path is exempt from the global check, which runs before a
    // multipart body is read (app.ts, isAttachmentUploadPath).
    assertCsrfToken(req);
    const { viewer, ticket } = await loadTicket(req);

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof raw.body === 'string' ? normaliseText(raw.body).trim() : '';
    // Only staff whose role reads internal notes may write one, whatever the form claims.
    const isInternal = writesInternal(viewer) && raw.internal === 'on';
    // "Email the requester" (21 Oct 2026): unticked, a reply and its files are
    // only added to the ticket. A form without the box (`notifyChoice` absent)
    // emails as replies always did.
    const emailIt = raw.notifyChoice === '1' ? raw.notify === 'on' : true;

    const refuse = (message: string): void => {
      flash(req, 'error', message, 'reply');
      req.session.replyDraft = { ticketId: ticket.id, body: text, internal: isInternal, notify: emailIt };
      res.redirect(back);
    };

    if (text === '' && files.length === 0) {
      refuse('Write something before posting.');
      return;
    }
    if (text.length > 20_000) {
      refuse('That is too long to post. Shorten it, or attach it as a file.');
      return;
    }
    if (files.length > 0) {
      if (!limits.enabled) {
        refuse('Attachments are turned off.');
        return;
      }
      if ((await countAttachments(ticket.id)) + files.length > limits.maxPerTicket) {
        refuse('A ticket may hold at most ' + limits.maxPerTicket + ' attachments.');
        return;
      }
      // Every file, before any is stored: see above.
      for (const file of files) {
        try {
          verifyType(sanitiseFilename(file.originalname), file.buffer.subarray(0, 64));
        } catch (err) {
          if (err instanceof HttpError && err.status === 400) {
            refuse(sanitiseFilename(file.originalname) + ': ' + err.message);
            return;
          }
          throw err;
        }
      }
    }

    const stored = files.length > 0 ? await storeFiles(req, ticket.id, viewer.id, files, isInternal) : [];

    if (text !== '') {
      const commentId = await addComment({ ticketId: ticket.id, authorId: viewer.id, body: text, isInternal });
      auditRequest(req, {
        action: isInternal ? 'ticket.note.added' : 'ticket.comment.added',
        targetType: 'ticket',
        targetId: ticket.id,
        detail: { commentId, reference: ticket.reference, ...(stored.length ? { withFiles: stored.length } : {}) },
      });

      // An internal note is for the service desk, so it is never emailed to
      // the requester - that is the whole point of marking one internal.
      if (!isInternal) {
        if (isStaff(viewer.role)) {
          // Unticked "Email the requester": on the ticket, where they can read it, and no mail.
          if (emailIt) {
            // Recorded when the decision is made; the outbox shows a failure to deliver.
            if (stored.length) await markEmailed(stored);
            await notifyTicket('comment.added.requester', ticket.id, {
              comment: text,
              authorName: viewer.display_name,
              ...(stored.length ? { attachmentIds: stored } : {}),
            });
          }
        } else {
          await notifyTicket('comment.added.technician', ticket.id, { comment: text, authorName: viewer.display_name });
        }
      }
    }

    flash(
      req,
      'success',
      text === ''
        ? stored.length === 1 ? 'File attached.' : 'Files attached.'
        : isInternal
          ? 'Internal note added.'
          : isStaff(viewer.role) && !emailIt
            ? 'Added to the ticket. Nobody was emailed.'
            : isStaff(viewer.role) && stored.length
              ? 'Reply sent, with its files.'
              : 'Comment added.',
    );
    res.redirect(back);
  }),
);

/**
 * "Assign to me": the technician takes the ticket, and it goes to their
 * group - the only one they are in, or the one they chose in the popup when
 * they are in several. In no group, it is simply assigned to them. A group
 * they are not in is refused rather than quietly used.
 */
ticketRouter.post(
  '/:id/assign-me',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { viewer, ticket } = await loadTicket(req);
    if (!isStaff(viewer.role)) throw forbidden('Only service desk staff can take a ticket.', 'not_staff');
    if (!can(viewer, 'tickets.edit')) throw forbidden('Your role does not allow changing tickets.', 'not_permitted');
    const mine = (await groupsForUser(viewer.id)).filter((g) => g.is_active);
    const asked = typeof (req.body as Record<string, unknown>)?.groupId === 'string' ? String((req.body as Record<string, unknown>).groupId) : '';
    let groupId: string | null = null;
    if (mine.length === 1) {
      groupId = mine[0]!.id;
    } else if (mine.length > 1) {
      const chosen = mine.find((g) => g.id === asked);
      if (!chosen) {
        flash(req, 'error', 'Choose which of your groups the ticket goes to.', 'update');
        res.redirect('/tickets/' + ticket.id + '#assign-me');
        return;
      }
      groupId = chosen.id;
    }
    const changes = await updateTicket(ticket.id, viewer.id, {
      assigneeId: viewer.id,
      ...(groupId && groupId !== ticket.group_id ? { groupId } : {}),
    });
    if (changes.length > 0) {
      auditRequest(req, { action: 'ticket.updated', targetType: 'ticket', targetId: ticket.id, detail: { reference: ticket.reference, changes, via: 'assign-me' } });
    }
    const group = groupId ? mine.find((g) => g.id === groupId)?.name : null;
    flash(req, 'success', changes.length === 0 ? 'It was already yours.' : 'Assigned to you' + (group ? ', in ' + group : '') + '.');
    res.redirect('/tickets/' + ticket.id);
  }),
);

ticketRouter.post(
  '/:id/update',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { viewer, ticket } = await loadTicket(req);

    // Triage is a staff action. Requesters change tickets by commenting.
    if (!isStaff(viewer.role)) {
      throw forbidden('Only service desk staff can change ticket fields.', 'not_staff');
    }
    // "Change status, priority, assignee, group and category" (custom roles, part 2).
    if (!can(viewer, 'tickets.edit')) throw forbidden('Your role does not allow changing tickets.', 'not_permitted');

    const parsed = updateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That change is not valid.', 'bad_update');

    const update: Parameters<typeof updateTicket>[2] = {};
    if (parsed.data.status) update.status = parsed.data.status;

    /**
     * Putting a ticket on hold needs a reason.
     *
     * "On hold" with nothing else said is the state a ticket is forgotten in:
     * a week later nobody knows what it is waiting for or who is supposed to
     * end the wait. The reason is posted as an ordinary comment, so the
     * requester sees it too - which is the point of saying it.
     *
     * Only when the status is **changing** to on hold. Editing the priority
     * of a ticket that is already on hold is not a new decision to explain.
     */
    // Approval first. A ticket somebody is still waiting to approve cannot be
    // called finished, and the refusal lands on the triage form rather than
    // replacing the page with an error.
    if (parsed.data.status) {
      const blocked =
        approvalBlocks(ticket, parsed.data.status) ||
        (ticket.status !== parsed.data.status ? await tasksBlock(ticket, parsed.data.status) : '');
      if (blocked) {
        flash(req, 'error', blocked, 'update');
        res.redirect('/tickets/' + ticket.id);
        return;
      }
    }

    const goingOnHold = parsed.data.status === 'pending' && ticket.status !== 'pending';
    const holdReason = normaliseText(parsed.data.holdReason ?? '').trim();

    if (goingOnHold && holdReason.length < 3) {
      flash(req, 'error', 'Say what the ticket is waiting for before putting it on hold.', 'update');
      res.redirect('/tickets/' + ticket.id);
      return;
    }

    // Cancelling: a note, required when Settings - Tickets - Other
    // settings - Cancellation says so, and posted like the on-hold reason
    // whenever one is given.
    const cancelling = parsed.data.status === 'cancelled' && ticket.status !== 'cancelled';
    const cancelNote = normaliseText(parsed.data.cancelNote ?? '').trim();
    if (cancelling && settings().tickets.requireCancelNote && cancelNote.length < 3) {
      flash(req, 'error', 'Say why the ticket is being cancelled.', 'update');
      res.redirect('/tickets/' + ticket.id);
      return;
    }
    // Resolving: the same, with its own switch.
    const resolving = parsed.data.status === 'resolved' && ticket.status !== 'resolved';
    const resolveNote = normaliseText(parsed.data.resolveNote ?? '').trim();
    if (resolving && settings().tickets.requireResolveNote && resolveNote.length < 3) {
      flash(req, 'error', 'Say how the ticket was resolved.', 'update');
      res.redirect('/tickets/' + ticket.id);
      return;
    }
    if (parsed.data.priority) update.priority = parsed.data.priority;
    if (parsed.data.category) update.category = parsed.data.category;

    if (parsed.data.assigneeId !== undefined) {
      if (parsed.data.assigneeId === '') {
        update.assigneeId = null;
      } else {
        // Only an active agent or admin may be assigned work.
        const assignee = await findUserById(parsed.data.assigneeId);
        if (!assignee || assignee.status !== 'active' || !isStaff(assignee.role)) {
          throw badRequest('That person cannot be assigned tickets.', 'bad_assignee');
        }
        update.assigneeId = assignee.id;
      }
    }

    if (parsed.data.groupId !== undefined) {
      if (parsed.data.groupId === '') {
        update.groupId = null;
      } else {
        // Only a group that still exists and is still offered.
        const group = await findGroup(parsed.data.groupId);
        if (!group || !group.is_active) {
          throw badRequest('That technician group is not available.', 'bad_group');
        }
        update.groupId = group.id;
      }
    }

    if (parsed.data.categoryId !== undefined) {
      if (parsed.data.categoryId === '') {
        update.categoryId = null;
      } else {
        const node = await findCategory(parsed.data.categoryId);
        if (!node) throw badRequest('That category no longer exists.', 'bad_category');
        update.categoryId = node.id;
      }
    }

    const changes = await updateTicket(ticket.id, viewer.id, update);

    // After the change, so a failed update leaves no comment explaining one
    // that never happened.
    if (goingOnHold && changes.some((change) => change.field === 'status')) {
      await addComment({
        ticketId: ticket.id,
        authorId: viewer.id,
        body: 'On hold: ' + holdReason,
        isInternal: false,
      });
    }
    if (cancelling && cancelNote && changes.some((change) => change.field === 'status')) {
      await addComment({
        ticketId: ticket.id,
        authorId: viewer.id,
        body: 'Cancelled: ' + cancelNote,
        isInternal: false,
      });
    }
    if (resolving && resolveNote && changes.some((change) => change.field === 'status')) {
      await addComment({
        ticketId: ticket.id,
        authorId: viewer.id,
        body: 'Resolved: ' + resolveNote,
        isInternal: false,
      });
    }

    // One notification per thing that actually changed, and only for the
    // changes a requester or a technician would want to hear about.
    for (const change of changes) {
      if (change.field === 'status') {
        await notifyTicket(
          change.to === 'resolved' || change.to === 'closed'
            ? 'ticket.resolved'
            : 'ticket.status.changed',
          ticket.id,
          {
            authorName: viewer.display_name,
            ...(goingOnHold ? { statusNote: 'Waiting for: ' + holdReason } : {}),
            ...(cancelling && cancelNote ? { statusNote: 'Reason: ' + cancelNote } : {}),
            ...(resolving && resolveNote ? { statusNote: 'Resolution: ' + resolveNote } : {}),
          },
        );
      } else if (change.field === 'assignee' && change.to !== 'unassigned') {
        await notifyTicket('ticket.assigned.technician', ticket.id, {
          authorName: viewer.display_name,
        });
      } else if (change.field === 'group' && change.to !== 'unrouted') {
        await notifyTicket('ticket.created.group', ticket.id, {
          authorName: viewer.display_name,
        });
      }
    }

    if (changes.length === 0) {
      flash(req, 'info', 'Nothing changed.');
    } else {
      auditRequest(req, {
        action: 'ticket.updated',
        targetType: 'ticket',
        targetId: ticket.id,
        detail: { reference: ticket.reference, changes },
      });
      flash(req, 'success', 'Ticket updated.');
    }

    res.redirect('/tickets/' + ticket.id);
  }),
);

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Multipart handling.
 *
 * Memory storage is used deliberately: the type has to be proved from the
 * file's own leading bytes before anything is written to disk, so nothing
 * unverified ever lands in the filesystem. The size ceiling comes from settings
 * and is enforced by multer, so an oversized body is cut off during the upload
 * rather than after it has been buffered in full.
 */
function uploadHandler() {
  const limits = attachmentLimits();
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: limits.maxBytes,
      files: 5,
      fields: 10,
      fieldNameSize: 100,
      fieldSize: 1024 * 64,
      parts: 20,
    },
  }).array('files', 5);
}

/**
 * Runs the multipart parser, turning its limit errors into messages a person
 * can act on.
 *
 * Must run before the CSRF check on any route it is used from: the global
 * CSRF middleware cannot see a multipart body, so those routes are exempt
 * from it and call `assertCsrfToken` once this has populated `req.body`.
 */
async function parseUpload(
  req: Request,
  res: Response,
  limits: ReturnType<typeof attachmentLimits>,
): Promise<Express.Multer.File[]> {
  await new Promise<void>((resolve, reject) => {
    uploadHandler()(req, res, (err: unknown) => {
      if (!err) {
        resolve();
        return;
      }
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'That file is larger than the ' + formatBytes(limits.maxBytes) + ' limit.'
            : err.code === 'LIMIT_FILE_COUNT'
              ? 'Too many files in one upload.'
              : 'The upload could not be read.';
        reject(badRequest(message, 'upload_rejected'));
        return;
      }
      reject(err);
    });
  });

  return Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
}

/**
 * Verifies each file from its own leading bytes and stores it. The client's
 * Content-Type is never trusted.
 */
async function storeFiles(
  req: Request,
  ticketId: string,
  uploadedBy: string,
  files: Express.Multer.File[],
  isInternal: boolean,
): Promise<string[]> {
  // The ids, not a count: the caller may have to tell somebody about these
  // particular files.
  const ids: string[] = [];

  for (const file of files) {
    const filename = sanitiseFilename(file.originalname);
    const verified = verifyType(filename, file.buffer.subarray(0, 64));
    const row = await storeAttachment({
      ticketId,
      uploadedBy,
      filename,
      contentType: verified.contentType,
      bytes: file.buffer,
      isInternal,
    });

    auditRequest(req, {
      action: 'ticket.attachment.added',
      targetType: 'ticket',
      targetId: ticketId,
      detail: {
        attachmentId: row.id,
        filename: row.filename,
        contentType: row.content_type,
        bytes: row.byte_size,
        sha256: row.sha256,
        internal: isInternal,
      },
    });

    ids.push(row.id);
  }
  return ids;
}

ticketRouter.post(
  '/:id/attachments',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { viewer, ticket } = await loadTicket(req);

    const limits = attachmentLimits();

    /**
     * A refused upload goes back to the form, not to an error page.
     *
     * The services refuse by throwing, and the handler turns that into a
     * standalone 400 - so a file whose bytes contradict its name took the
     * reader away from the ticket to read one sentence and then navigate
     * back. Reported, and the same mistake as the 409 on a duplicate group
     * name; see `routes/form-errors.ts` for the other half of it.
     */
    const refuse = (message: string): void => {
      flash(req, 'error', message, 'attachments');
      // Shown beside the reply box, the one file picker the page has now.
      res.redirect('/tickets/' + ticket.id + '#reply');
    };

    if (!limits.enabled) {
      refuse('Attachments are turned off.');
      return;
    }

    let files: Express.Multer.File[];
    try {
      files = await parseUpload(req, res, limits);
    } catch (err) {
      // Nearly always "that file is too large", which multer reports once it
      // has stopped reading rather than as a validation result.
      refuse(err instanceof HttpError && err.status === 400 ? err.message : 'That upload could not be read.');
      return;
    }

    // The token is checked here rather than by the global middleware, which
    // runs before any multipart parser and so cannot see this body.
    assertCsrfToken(req);

    if (files.length === 0) {
      refuse('Choose at least one file to attach.');
      return;
    }

    const existing = await countAttachments(ticket.id);
    if (existing + files.length > limits.maxPerTicket) {
      refuse('A ticket may hold at most ' + limits.maxPerTicket + ' attachments.');
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Only staff may mark an attachment internal, whatever the form claims.
    const isInternal = writesInternal(viewer) && body.internal === 'on';

    // Sending a ticket's files out to the requester is a decision, so it is
    // made here, by somebody, rather than by a notification doing it always.
    const inform = isStaff(viewer.role) && body.inform === 'on';
    const note = typeof body.comment === 'string' ? normaliseText(body.comment).trim() : '';

    if (inform && isInternal) {
      refuse('An internal file cannot be sent to the requester. Untick one of the two.');
      return;
    }

    // Checked before anything is stored, for the same reason the raise-a-
    // ticket form verifies files before the insert: refusing afterwards would
    // leave the files attached and the requester never told about them.
    if (inform && note.length < 2) {
      refuse('Write a message to go with the files, or untick "inform the requester".');
      return;
    }

    let stored: string[];
    try {
      stored = await storeFiles(req, ticket.id, viewer.id, files, isInternal);
    } catch (err) {
      // `verifyType` refuses a file whose bytes contradict its name, and says
      // which file and why. That sentence is the whole value of the check, so
      // it is carried back to the form rather than replaced.
      if (err instanceof HttpError && err.status === 400) {
        refuse(err.message);
        return;
      }
      throw err;
    }

    if (inform) {
      // The message is an ordinary visible comment, so the ticket reads as a
      // conversation rather than as a file appearing with an email about it
      // that nobody here can see.
      const commentId = await addComment({
        ticketId: ticket.id,
        authorId: viewer.id,
        body: note,
        isInternal: false,
      });

      auditRequest(req, {
        action: 'ticket.comment.added',
        targetType: 'ticket',
        targetId: ticket.id,
        detail: { commentId, reference: ticket.reference, withFiles: stored.length },
      });

      // Recorded before the mail is queued rather than after it is sent: the
      // ticket should say the requester was told the moment the decision was
      // made, and the outbox is where a failure to deliver shows up.
      await markEmailed(stored);

      await notifyTicket('comment.added.requester', ticket.id, {
        comment: note,
        authorName: viewer.display_name,
        attachmentIds: stored,
      });
    }

    flash(
      req,
      'success',
      (stored.length === 1 ? 'Attachment added.' : stored.length + ' attachments added.') +
        (inform ? ' The requester has been emailed a copy.' : ''),
    );
    res.redirect('/tickets/' + ticket.id + '#conversation');
  }),
);

ticketRouter.get(
  '/:id/attachments/:attachmentId',
  asyncHandler(async (req, res) => {
    const { viewer, ticket } = await loadTicket(req);

    const attachmentId = uuid.safeParse(req.params.attachmentId);
    if (!attachmentId.success) throw notFound('That attachment does not exist.');

    const row = await findAttachment(attachmentId.data);
    // Reported as 404 rather than 403, so attachment ids belonging to other
    // tickets are not confirmed.
    if (!row || row.ticket_id !== ticket.id) throw notFound('That attachment does not exist.');
    if (row.is_internal && !seesInternal(viewer)) throw notFound('That attachment does not exist.');

    auditRequest(req, {
      action: 'ticket.attachment.downloaded',
      targetType: 'ticket',
      targetId: ticket.id,
      detail: { attachmentId: row.id, filename: row.filename },
    });

    // Encrypted at rest, so read whole and decrypted rather than streamed;
    // attachments are capped in size (Settings - Attachments).
    let bytes: Buffer;
    try {
      bytes = await readAttachment(row);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('That attachment is no longer available.');
      log.error({ err, attachmentId: row.id }, 'attachment could not be read');
      throw notFound('That attachment could not be opened.');
    }

    // Opening a screenshot should not mean fetching it out of a downloads
    // folder, so a type that a browser can show safely is shown - but only
    // ever under these three headers together:
    //
    //   `sandbox` puts the response in an opaque origin, so even if it did
    //   contain script it could not touch this application's session;
    //   `nosniff` stops the browser second-guessing the type we declare;
    //   and the type is one from a short list, never the one the uploader
    //   claimed.
    //
    // Everything else is still a download. An HTML or SVG file rendered in
    // place is the whole reason this route was octet-stream to begin with.
    // `?download` is the way back to a file on disk, for a file somebody
    // wants to keep rather than glance at.
    const inline = viewable(row.content_type) && req.query.download === undefined;

    res.setHeader('Content-Type', inline ? row.content_type : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', contentDisposition(row.filename, inline));
    res.end(bytes);
  }),
);

ticketRouter.post(
  '/:id/attachments/:attachmentId/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { viewer, ticket } = await loadTicket(req);

    const attachmentId = uuid.safeParse(req.params.attachmentId);
    if (!attachmentId.success) throw notFound('That attachment does not exist.');

    const row = await findAttachment(attachmentId.data);
    if (!row || row.ticket_id !== ticket.id) throw notFound('That attachment does not exist.');

    // Staff may remove anything on a ticket they can see; a requester may
    // remove only their own upload.
    const mayDelete = isStaff(viewer.role) || row.uploaded_by === viewer.id;
    if (!mayDelete) throw forbidden('You cannot remove that attachment.', 'not_owner');

    await deleteAttachment(row);

    auditRequest(req, {
      action: 'ticket.attachment.deleted',
      targetType: 'ticket',
      targetId: ticket.id,
      detail: { attachmentId: row.id, filename: row.filename },
    });

    flash(req, 'success', 'Attachment removed.');
    res.redirect('/tickets/' + ticket.id);
  }),
);


/**
 * Deleting a ticket.
 *
 * Administrator only, a reason required, and the group manager told (else every other administrator)
 * by email. This is the one action here that destroys a record rather than
 * changing it, so all three of those are the price of having it at all.
 *
 * Cancelling is usually what somebody wants instead - a ticket raised by
 * mistake, or a request withdrawn - and that keeps the history. This is for
 * what must not be kept.
 */
/**
 * Who may delete a comment (Tickets - Other settings, 22 Oct 2026):
 * administrators always; technicians when "Allow technicians to delete
 * comments" is on; with "Only group managers", only managers of the ticket's
 * group. An internal note also needs the right to write internal notes.
 */
export async function mayDeleteComments(viewer: UserRow, ticket: { group_id?: string | null }): Promise<boolean> {
  if (viewer.role === 'admin') return true;
  if (!isStaff(viewer.role)) return false;
  const rules = settings().tickets;
  if (!rules.techniciansDeleteComments) return false;
  if (!rules.managersOnlyDeleteComments) return true;
  if (!ticket.group_id) return false;
  return (await groupManagers(ticket.group_id)).some((m) => m.id === viewer.id);
}

ticketRouter.post(
  '/:id/comments/:commentId/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { viewer, ticket } = await loadTicket(req);
    if (!(await mayDeleteComments(viewer, ticket))) {
      throw forbidden('You may not delete comments on this ticket.');
    }
    // A note this person cannot see is "not found", like the ticket itself.
    const visible = await listComments(ticket.id, viewer);
    const target = visible.find((c) => c.id === String(req.params.commentId));
    if (!target) throw notFound('That comment does not exist.');
    if (target.is_internal && !writesInternal(viewer)) {
      throw forbidden('Your role does not allow changing internal notes.');
    }
    const removed = await deleteComment(ticket.id, target.id, viewer.id);
    if (removed) {
      auditRequest(req, {
        action: 'ticket.comment.deleted',
        targetType: 'ticket',
        targetId: ticket.id,
        detail: {
          reference: ticket.reference,
          commentId: removed.id,
          authorId: removed.author_id,
          internal: Boolean(removed.is_internal),
          body: removed.body.slice(0, 2000),
        },
      });
    }
    flash(req, 'success', 'Comment deleted.');
    res.redirect('/tickets/' + ticket.id + '#conversation');
  }),
);

ticketRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { viewer, ticket } = await loadTicket(req);

    if (!can(viewer, 'tickets.delete')) {
      throw forbidden('Your role does not allow deleting tickets.', 'not_admin');
    }

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof raw.reason === 'string' ? normaliseText(raw.reason).trim() : '';

    if (reason.length < 5) {
      flash(req, 'error', 'Say why this ticket is being deleted.', 'delete');
      res.redirect('/tickets/' + ticket.id + '#delete');
      return;
    }

    // Told **before** the row goes, because the notification is built from
    // the ticket: afterwards there is nothing left to describe.
    await notifyTicket('ticket.deleted.admins', ticket.id, {
      authorName: viewer.display_name,
      deleteReason: reason,
      actorId: viewer.id,
    });

    // The audit entry is written before as well, and carries everything the
    // ticket is about to stop being able to answer.
    auditRequest(req, {
      action: 'ticket.deleted',
      targetType: 'ticket',
      targetId: ticket.id,
      detail: {
        reference: ticket.reference,
        title: ticket.title,
        status: ticket.status,
        requesterId: ticket.requester_id,
        externalEmail: ticket.external_email,
        createdAt: ticket.created_at,
        reason,
      },
    });

    await deleteTicket(ticket.id);

    flash(req, 'success', ticket.reference + ' has been deleted. Its group manager has been told - or, with no manager, the other administrators.');
    res.redirect('/tickets');
  }),
);

/** Values the ticket page needs for the upload form. */
export const attachmentViewData = () => {
  const limits = attachmentLimits();
  return {
    attachmentsEnabled: limits.enabled,
    attachmentMaxBytes: limits.maxBytes,
    attachmentMaxLabel: formatBytes(limits.maxBytes),
    attachmentMaxPerTicket: limits.maxPerTicket,
    attachmentAccept: ALLOWED_EXTENSIONS.join(','),
    // Which files the ticket page may open in a tab rather than download.
    viewableTypes: [...VIEWABLE_TYPES],
  };
};

const log = logger.child({ module: 'routes/tickets' });

/**
 * The types a browser may render in place.
 *
 * Images and PDFs, because those are what people attach to a ticket and then
 * want to look at. Nothing that can carry script: **not** SVG, which is a
 * document format with `<script>` in it, and not HTML whatever its extension
 * says. Text is included because `nosniff` holds the browser to the declared
 * `text/plain`, so a `.txt` full of markup is still shown as the text it is.
 *
 * Deliberately keyed on the **verified** type from the database, which was
 * decided from the file's own bytes, never on what an uploader claimed.
 */
const VIEWABLE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
]);

function viewable(contentType: string): boolean {
  return VIEWABLE_TYPES.has(contentType);
}

/**
 * RFC 6266 Content-Disposition.
 *
 * The ASCII `filename` is a conservative fallback and `filename*` carries the
 * real name for anything non-ASCII. Quotes and backslashes are already removed
 * by sanitiseFilename, so the quoted form cannot be broken out of.
 *
 * `inline` only changes where the browser puts it; what makes that safe is
 * the type and the headers beside it, not this word.
 */
function contentDisposition(filename: string, inline = false): string {
  let ascii = '';
  for (const char of filename) {
    const code = char.charCodeAt(0);
    ascii += code >= 0x20 && code <= 0x7e ? char : '_';
  }
  const quote = String.fromCharCode(34);
  return (
    (inline ? 'inline' : 'attachment') +
    '; filename=' +
    quote +
    ascii +
    quote +
    "; filename*=UTF-8''" +
    encodeURIComponent(filename)
  );
}

/**
 * What the service desk sees on clicking the requester: how to reach them and
 * what else they have raised. Mail from a stranger is carried by one hidden
 * account, so there the address is the stranger's own and there is no "all
 * their tickets" - it would be every stranger's.
 */
async function requesterCardFor(viewer: UserRow, ticket: { id: string; requester_id: string; requester_name: string; external_email: string | null }) {
  const person = await findUserById(ticket.requester_id);
  if (ticket.external_email || !person) {
    return { id: null, name: ticket.requester_name, email: ticket.external_email || null, lines: [], recent: [], total: 0, open: 0 };
  }
  const [recent, open] = await Promise.all([
    listTickets(viewer, { scope: 'all', status: 'any', requesterId: person.id, includeTasks: false, page: 1, perPage: 6 }),
    listTickets(viewer, { scope: 'all', status: 'active', requesterId: person.id, includeTasks: false, page: 1, perPage: 1 }),
  ]);
  const lines = [
    { label: 'Phone', value: person.phone },
    { label: 'Department', value: person.department },
    { label: 'Job title', value: person.job_title },
    { label: 'Office', value: person.office },
  ].filter((l) => l.value);
  return {
    id: person.id,
    name: person.display_name,
    email: person.email,
    phone: person.phone || null,
    lines,
    recent: recent.items.filter((t) => t.id !== ticket.id).slice(0, 5),
    total: recent.total,
    open: open.total,
  };
}

/** The Requester field's lines for the person filling in the form, or none. */
function requesterLinesFor(template: TemplateRow | null, person: UserRow): { label: string; value: string }[] {
  const field = template ? visibleLayout(template).find((f) => f.key === 'requester') : undefined;
  return field ? requesterDetails(field, person) : [];
}
