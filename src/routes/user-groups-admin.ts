import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { normaliseLine, normaliseText } from '../lib/util.js';
import { allowOwnRequests, allowOwnScripts, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import {
  ATTRIBUTE_LABELS,
  OPERATOR_LABELS,
  RULE_ATTRIBUTES,
  RULE_OPERATORS,
  VALUELESS,
  addRule,
  applyRules,
  createUserGroup,
  deleteRule,
  deleteUserGroup,
  findUserGroup,
  listRules,
  listUserGroupMembers,
  searchUserGroups,
  setManualMember,
  updateUserGroup,
} from '../services/user-groups.js';
import { listUsers } from '../services/users.js';
import { attempt, issueErrors, type FieldErrors } from './form-errors.js';
import { settingsView } from './settings-shared.js';
import { listView as columnListView, type Cells } from '../lib/column-filters.js';
import {
  pageOf,
  pickerQuery,
  pickerReturn,
  pickerSelection,
  type PickerQuery,
} from './member-picker.js';

/**
 * Groups of requesters.
 *
 * A sibling of the technician groups router, under the same Groups section:
 * one says who works a ticket, the other says who may read it. They are two
 * tabs rather than two sections because an administrator thinks of them
 * together and should not have to remember which menu holds which.
 */
export const userGroupAdminRouter = Router();

const PAGE = '/admin/settings/groups/users';

const groupBody = z.object({
  name: z.string().trim().min(2, 'Give the group a name.').max(80),
  description: z.string().trim().max(500).default(''),
});

const checkbox = (value: unknown): boolean => value === 'on' || value === 'true' || value === '1';

function parseForm(raw: Record<string, unknown>) {
  return groupBody.safeParse({
    name: typeof raw.name === 'string' ? normaliseLine(raw.name) : '',
    description: typeof raw.description === 'string' ? normaliseText(raw.description) : '',
  });
}

const labels = {
  ruleAttributes: RULE_ATTRIBUTES,
  ruleOperators: RULE_OPERATORS,
  attributeLabels: ATTRIBUTE_LABELS,
  operatorLabels: OPERATOR_LABELS,
  valueless: VALUELESS,
};


const PER_PAGE = 50;

/** ?q= and ?page=, forgiving: anything odd is the first page of everything. */
function listQuery(query: Record<string, unknown>): { q: string; page: number } {
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const page = Math.min(10_000, Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1));
  return { q, page };
}

async function listView(extra: Record<string, unknown> = {}, list = { q: '', page: 1 }, query: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  // Excel-like headers (lib/column-filters.ts): every match is read, then
  // filtered, sorted and paged here - a list of groups is short.
  const all = await searchUserGroups(list.q, 1, 5000);
  type Row = (typeof all.rows)[number];
  const cells: Cells<Row> = {
    name: (r) => r.name,
    members: (r) => String(r.member_count),
    rules: (r) => String(r.rule_count),
    templates: (r) => String(r.template_count),
    status: (r) => (r.is_active ? 'Active' : 'Retired'),
  };
  const view = columnListView(query, all.rows, cells, {
    sortCells: { members: (r) => String(r.member_count).padStart(8, '0') },
    keep: { q: list.q || undefined },
  });
  const found = { rows: view.rows.slice((list.page - 1) * PER_PAGE, list.page * PER_PAGE), total: view.rows.length };
  return settingsView('groups', {
    sectionTitle: 'Groups',
    tab: 'users',
    groups: found.rows,
    columnMenus: view.columnMenus,
    listState: view.listState,
    search: { q: list.q, page: list.page, total: found.total, pageCount: Math.max(1, Math.ceil(found.total / PER_PAGE)) },
    values: {},
    errors: {},
    openDialog: null as string | null,
    ...labels,
    ...extra,
  });
}

userGroupAdminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.render('admin/settings/user-groups', await listView({}, listQuery(req.query as Record<string, unknown>), req.query as Record<string, unknown>));
  }),
);

userGroupAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseForm(raw);

    const refuse = async (errors: FieldErrors): Promise<void> => {
      res.status(400).render(
        'admin/settings/user-groups',
        await listView({ values: raw, errors, openDialog: 'new-user-group' }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      createUserGroup({ ...parsed.data, isActive: true }, req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }

    flash(req, 'success', 'Group "' + attempted.value.name + '" created.');
    res.redirect(PAGE + '/' + attempted.value.id);
  }),
);

// ---------------------------------------------------------------------------
// One group
// ---------------------------------------------------------------------------

/** Everything the detail page needs. */
async function detailView(
  id: string,
  picker: PickerQuery,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const group = await findUserGroup(id);
  if (!group) throw notFound('That user group no longer exists.');

  const [members, rules, people] = await Promise.all([
    listUserGroupMembers(group.id),
    listRules(group.id),
    // Everyone, because a user group is about requesters: restricting the
    // picker to staff would make the common case impossible. A page at a
    // time, and searched in SQL - this is where a real directory shows up.
    listUsers({ search: picker.q, limit: picker.limit, offset: picker.offset }),
  ]);

  return settingsView('groups', {
    sectionTitle: group.name,
    tab: 'users',
    group,
    members,
    rules,
    candidates: people.rows,
    memberIds: members.map((member) => member.id),
    manualIds: members.filter((m) => m.member_source === 'manual').map((m) => m.id),
    memberPage: pageOf(members, picker.msize, picker.mpage),
    total: people.total,
    q: picker.q,
    size: picker.size,
    page: picker.page,
    errors: {},
    openDialog: null as string | null,
    ...labels,
    ...extra,
  });
}

userGroupAdminRouter.get(
  '/:id',
  // Find people to add searches as you type (live-search.js): a script of
  // ours, fetching this page again - to this server only.
  allowOwnScripts(),
  allowOwnRequests(),
  asyncHandler(async (req, res) => {
    res.render(
      'admin/settings/user-group-detail',
      await detailView(String(req.params.id), pickerQuery(req)),
    );
  }),
);

userGroupAdminRouter.post(
  '/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const group = await findUserGroup(id);
    if (!group) throw notFound('That user group no longer exists.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseForm(raw);

    const refuse = async (errors: FieldErrors): Promise<void> => {
      res.status(400).render(
        'admin/settings/user-group-detail',
        await detailView(id, pickerQuery(req), { errors, group: { ...group, ...raw } }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      updateUserGroup(
        id,
        { ...parsed.data, isActive: checkbox(raw.isActive) },
        req.currentUser?.id ?? null,
      ),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }

    flash(req, 'success', 'Group "' + attempted.value.name + '" saved.');
    res.redirect(PAGE + '/' + id);
  }),
);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

userGroupAdminRouter.post(
  '/:id/rules',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const group = await findUserGroup(id);
    if (!group) throw notFound('That user group no longer exists.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const attempted = await attempt(() =>
      addRule(
        id,
        {
          attribute: String(raw.attribute ?? ''),
          operator: String(raw.operator ?? ''),
          value: typeof raw.value === 'string' ? normaliseLine(raw.value) : '',
        },
        req.currentUser?.id ?? null,
      ),
    );

    if (!attempted.ok) {
      res.status(400).render(
        'admin/settings/user-group-detail',
        await detailView(id, pickerQuery(req), {
          errors: attempted.errors,
          openDialog: 'add-rule',
        }),
      );
      return;
    }

    // Say what the rule did, so its effect is visible without counting rows.
    const matched = await listUserGroupMembers(id);
    const byRule = matched.filter((m) => m.member_source === 'rule').length;
    flash(req, 'success', 'Rule added. ' + byRule + ' account(s) now match.');
    res.redirect(PAGE + '/' + id + '#rules');
  }),
);

userGroupAdminRouter.post(
  '/:id/rules/:ruleId/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!(await findUserGroup(id))) throw notFound('That user group no longer exists.');

    await deleteRule(id, String(req.params.ruleId), req.currentUser?.id ?? null);
    flash(req, 'success', 'Rule removed, and membership recalculated.');
    res.redirect(PAGE + '/' + id + '#rules');
  }),
);

/** Recalculates by hand, for when a directory changed outside a sign-in. */
userGroupAdminRouter.post(
  '/:id/rules/apply',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!(await findUserGroup(id))) throw notFound('That user group no longer exists.');

    const matched = await applyRules(id, req.currentUser?.id ?? null);
    flash(req, 'success', matched + ' account(s) match the rules.');
    res.redirect(PAGE + '/' + id + '#rules');
  }),
);

// ---------------------------------------------------------------------------
// Membership and removal
// ---------------------------------------------------------------------------

userGroupAdminRouter.post(
  '/:id/members',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const group = await findUserGroup(id);
    if (!group) throw notFound('That user group no longer exists.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const { shown, ticked } = pickerSelection(raw);
    const wanted = new Set(ticked);

    // Only the people this page had on screen, and only the hand-picked
    // ones: a rule member is not in this form's gift, since unticking them
    // would be undone by the next recompute.
    for (const personId of shown) {
      await setManualMember(id, personId, wanted.has(personId), req.currentUser?.id ?? null);
    }

    auditRequest(req, {
      action: 'user_group.membership.changed',
      targetType: 'user_group',
      targetId: id,
      detail: { name: group.name, shown: shown.length, ticked: wanted.size },
    });
    flash(req, 'success', 'Membership of "' + group.name + '" updated.');
    res.redirect(PAGE + '/' + id + pickerReturn(raw));
  }),
);

userGroupAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const group = await findUserGroup(id);
    if (!group) throw notFound('That user group no longer exists.');

    await deleteUserGroup(id, req.currentUser?.id ?? null);
    flash(
      req,
      'success',
      'Group "' + group.name + '" removed. Templates restricted to it are open to everybody again.',
    );
    res.redirect(PAGE);
  }),
);
