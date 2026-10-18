import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { normaliseLine } from '../lib/util.js';
import { writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import {
  LEVEL_LABELS,
  catalogueTree,
  createCategory,
  deleteCategory,
  findCategory,
  flatten,
  updateCategory,
  usageCount,
} from '../services/catalogue.js';
import { listActiveGroups } from '../services/groups.js';
import { attempt, issueErrors, type FieldErrors } from './form-errors.js';
import { settingsView } from './settings-shared.js';

/**
 * The category catalogue.
 *
 * Three levels - category, subcategory, item - on one page, each added through
 * its own dialog. The dialogs are plain `:target` anchors rather than scripted
 * modals, because no JavaScript is served; the browser does the showing and
 * hiding, which also means they survive a validation error unchanged.
 *
 * A category holds any number of subcategories, and a subcategory any number
 * of items: the table is self-referencing, so that falls out rather than being
 * a limit to work around.
 */
export const catalogueAdminRouter = Router();

const PAGE = '/admin/settings/templates/categories';

const categoryBody = z.object({
  name: z.string().trim().min(1, 'Give it a name.').max(80),
  description: z.string().trim().max(300).default(''),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(100),
});

const checkbox = (value: unknown): boolean => value === 'on' || value === 'true' || value === '1';
const id = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

function parseForm(raw: Record<string, unknown>) {
  return categoryBody.safeParse({
    name: typeof raw.name === 'string' ? normaliseLine(raw.name) : '',
    description: typeof raw.description === 'string' ? normaliseLine(raw.description) : '',
    sortOrder: raw.sortOrder === '' || raw.sortOrder === undefined ? 100 : raw.sortOrder,
  });
}

/**
 * Which node a new entry hangs off.
 *
 * The three dialogs ask differently - the category dialog asks nothing, the
 * subcategory dialog asks for a category, the item dialog asks for both - so
 * the parent is whichever of them was filled in, deepest first.
 */
function parentFrom(raw: Record<string, unknown>): string | null {
  return id(raw.subcategoryId) ?? id(raw.categoryId) ?? id(raw.parentId);
}

async function view(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tree = await catalogueTree();
  const nodes = flatten(tree);

  // Usage decides whether Remove is offered at all. The catalogue is small by
  // nature, so this is one pass rather than a query per row.
  const usage = new Map<string, number>();
  for (const node of nodes) usage.set(node.id, await usageCount(node.id));

  return settingsView('templates', {
    sectionTitle: 'Categories',
    tab: 'categories',
    tree,
    nodes,
    levelLabels: LEVEL_LABELS,
    usage: Object.fromEntries(usage),
    groups: await listActiveGroups(),
    categories: nodes.filter((n) => n.level === 1),
    subcategories: nodes.filter((n) => n.level === 2),
    // Set by "Save and add ...", so the next dialog opens with the thing just
    // created already chosen.
    preselect: null as string | null,
    openDialog: null as string | null,
    values: {},
    errors: {},
    ...extra,
  });
}

catalogueAdminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.render(
      'admin/settings/catalogue',
      await view({
        preselect: typeof req.query.parent === 'string' ? req.query.parent : null,
        openDialog: typeof req.query.add === 'string' ? req.query.add : null,
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

catalogueAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseForm(raw);
    const parentId = parentFrom(raw);
    // Which dialog this came from, so a validation error reopens the right one.
    const from = typeof raw.from === 'string' ? raw.from : 'category';

    // Reopens the dialog it came from with the reason inside it. A duplicate
    // name has to come back this way and not as a 409 page: the name is only
    // required to be unique among its siblings, so "already exists" is only
    // meaningful next to the parent that was chosen.
    const refuse = async (errors: FieldErrors): Promise<void> => {
      res.status(400).render(
        'admin/settings/catalogue',
        await view({ values: raw, errors, openDialog: from, preselect: parentId }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      createCategory(
        { ...parsed.data, parentId, isActive: true, groupId: id(raw.groupId) },
        req.currentUser?.id ?? null,
      ),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }
    const created = attempted.value;

    auditRequest(req, {
      action: 'category.created',
      targetType: 'category',
      targetId: created.id,
      detail: { name: created.name, level: created.level },
    });

    // "Save and add sub category" / "and add item": carry straight on, with
    // the thing just created already selected in the next dialog.
    const next = typeof raw.next === 'string' ? raw.next : '';
    if (next === 'subcategory' || next === 'item') {
      flash(req, 'success', '"' + created.name + '" added. Now add the next level.');
      res.redirect(PAGE + '?add=' + next + '&parent=' + encodeURIComponent(created.id));
      return;
    }

    flash(req, 'success', '"' + created.name + '" added.');
    res.redirect(PAGE);
  }),
);

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

catalogueAdminRouter.post(
  '/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const existing = await findCategory(String(req.params.id));
    if (!existing) throw notFound('That category no longer exists.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseForm(raw);

    const refuse = async (errors: FieldErrors): Promise<void> => {
      res.status(400).render(
        'admin/settings/catalogue',
        await view({ errors, openDialog: 'edit-' + existing.id, values: raw }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      updateCategory(
        existing.id,
        { ...parsed.data, isActive: checkbox(raw.isActive), groupId: id(raw.groupId) },
        req.currentUser?.id ?? null,
      ),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }

    flash(req, 'success', '"' + attempted.value.name + '" saved.');
    // Back to the row it was edited from, not the top of a long tree.
    res.redirect(PAGE + '#node-' + attempted.value.id);
  }),
);

catalogueAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const existing = await findCategory(String(req.params.id));
    if (!existing) throw notFound('That category no longer exists.');

    // Remove is only offered when nothing is filed here, so a refusal means
    // someone filed a ticket against it since the page was drawn. That is a
    // message on the list, not an error page.
    const attempted = await attempt(() =>
      deleteCategory(existing.id, req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      flash(req, 'error', Object.values(attempted.errors)[0] ?? 'That could not be removed.');
      res.redirect(PAGE);
      return;
    }

    flash(req, 'success', '"' + existing.name + '" and anything beneath it removed.');
    res.redirect(PAGE);
  }),
);
