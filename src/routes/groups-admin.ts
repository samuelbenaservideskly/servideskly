import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { normaliseLine, normaliseText } from '../lib/util.js';
import { allowOwnRequests, allowOwnScripts, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import {
  createGroup,
  deleteGroup,
  findGroup,
  searchGroups,
  listMembers,
  groupManagers,
  setGroupManagers,
  setMembersWithin,
  updateGroup,
} from '../services/groups.js';
import { listAssignableStaff, listAssignableStaffPage } from '../services/users.js';
import { attempt, issueErrors, type FieldErrors } from './form-errors.js';
import {
  addTechnicianRule,
  applyTechnicianRules,
  deleteTechnicianRule,
  listTechnicianRules,
} from '../services/technician-rules.js';
import { ATTRIBUTE_LABELS, OPERATOR_LABELS, RULE_ATTRIBUTES, RULE_OPERATORS, VALUELESS } from '../services/user-groups.js';
import type { Request } from 'express';

/** How many people the manager search shows at once. */
const MANAGER_RESULTS = 8;

/** Everything the member card and the rules card need, for one group. */
async function memberLocals(groupId: string, req: Request) {
  const picker = pickerQuery(req);
  // Managers: several (15 Oct 2026). Found by a search of eight at most, as
  // you type - never a dropdown of every technician.
  const mq = typeof req.query.mq === 'string' ? req.query.mq.trim().slice(0, 100) : '';
  const [members, staff, rules, managers, managerFound] = await Promise.all([
    listMembers(groupId),
    listAssignableStaffPage({ search: picker.q, limit: picker.limit, offset: picker.offset }),
    listTechnicianRules(groupId),
    groupManagers(groupId),
    listAssignableStaffPage({ search: mq, limit: MANAGER_RESULTS, offset: 0 }),
  ]);
  return {
    managers,
    managerIds: managers.map((m) => m.id),
    managerCandidates: managerFound.rows,
    managerTotal: managerFound.total,
    mq,
    members,
    candidates: staff.rows,
    memberIds: members.map((m) => m.id),
    // Hand-picked ones; the picker marks the rest "by rule".
    manualIds: members.filter((m) => m.member_source === 'manual').map((m) => m.id),
    memberPage: pageOf(members, picker.msize, picker.mpage),
    total: staff.total,
    q: picker.q,
    size: picker.size,
    page: picker.page,
    rules,
    ruleAttributes: RULE_ATTRIBUTES,
    ruleOperators: RULE_OPERATORS,
    attributeLabels: ATTRIBUTE_LABELS,
    operatorLabels: OPERATOR_LABELS,
    valueless: VALUELESS,
  };
}
import { settingsView } from './settings-shared.js';
import { pageOf, pickerQuery, pickerReturn, pickerSelection } from './member-picker.js';

/**
 * Technician groups.
 *
 * Mounted under /admin/settings, which has already required an administrator.
 */
export const groupAdminRouter = Router();

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

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * The list, plus the state of the "New group" dialog.
 *
 * The dialog is a `:target` anchor - there is no JavaScript here - so on a GET
 * it is simply closed. After a refused POST there is no fragment to match, so
 * `openDialog` reopens it with what was typed still in it.
 */

const PER_PAGE = 50;

/** ?q= and ?page=, forgiving: anything odd is the first page of everything. */
function listQuery(query: Record<string, unknown>): { q: string; page: number } {
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const page = Math.min(10_000, Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1));
  return { q, page };
}

async function listView(extra: Record<string, unknown> = {}, list = { q: '', page: 1 }): Promise<Record<string, unknown>> {
  const found = await searchGroups(list.q, list.page, PER_PAGE);
  return settingsView('groups', {
    sectionTitle: 'Groups',
    tab: 'technicians',
    groups: found.rows,
    search: { q: list.q, page: list.page, total: found.total, pageCount: Math.max(1, Math.ceil(found.total / PER_PAGE)) },
    values: {},
    errors: {},
    openDialog: null as string | null,
    ...extra,
  });
}

groupAdminRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.render('admin/settings/groups', await listView({}, listQuery(req.query as Record<string, unknown>)));
  }),
);

groupAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseForm(raw);

    // One refused-form path for both a malformed value and a name already in
    // use: either way the answer is the form back, with what was typed still
    // in it and the reason on the field it belongs to.
    const refuse = async (errors: FieldErrors): Promise<void> => {
      res.status(400).render(
        'admin/settings/groups',
        await listView({ values: raw, errors, openDialog: 'new-group' }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      createGroup({ ...parsed.data, isActive: true }, req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }
    const created = attempted.value;

    auditRequest(req, {
      action: 'group.created',
      targetType: 'group',
      targetId: created.id,
      detail: { name: created.name },
    });
    flash(req, 'success', 'Group "' + created.name + '" created.');
    res.redirect('/admin/settings/groups/' + created.id);
  }),
);

// ---------------------------------------------------------------------------
// One group
// ---------------------------------------------------------------------------

groupAdminRouter.get(
  '/:id',
  // Find people to add searches as you type (live-search.js): a script of
  // ours, fetching this page again - to this server only.
  allowOwnScripts(),
  allowOwnRequests(),
  asyncHandler(async (req, res) => {
    const group = await findGroup(String(req.params.id));
    if (!group) throw notFound('That group no longer exists.');

    // Only staff can be members, so only staff are offered - a page of them
    // at a time, because this is the one screen a whole directory can end
    // up on.
    res.render(
      'admin/settings/group-detail',
      settingsView('groups', {
        sectionTitle: group.name,
        tab: 'technicians',
        group,
        staff: await listAssignableStaff(),
        ...(await memberLocals(group.id, req)),
        errors: {},
        openDialog: null,
      }),
    );
  }),
);

groupAdminRouter.post(
  '/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const group = await findGroup(String(req.params.id));
    if (!group) throw notFound('That group no longer exists.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseForm(raw);

    const refuse = async (errors: FieldErrors): Promise<void> => {
      // The picker has to be rebuilt here too, or the error branch renders a
      // page whose member list is missing its paging locals and throws.
      res.status(400).render(
        'admin/settings/group-detail',
        settingsView('groups', {
          sectionTitle: group.name,
          tab: 'technicians',
          group: { ...group, ...raw },
          staff: await listAssignableStaff(),
          ...(await memberLocals(group.id, req)),
          errors,
          openDialog: null,
        }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      updateGroup(
        group.id,
        { ...parsed.data, isActive: checkbox(raw.isActive) },
        req.currentUser?.id ?? null,
      ),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }

    flash(req, 'success', 'Group "' + attempted.value.name + '" saved.');
    res.redirect('/admin/settings/groups/' + group.id);
  }),
);

// ---------------------------------------------------------------------------
// Managers - several per group, added and removed one at a time
// ---------------------------------------------------------------------------

groupAdminRouter.post(
  '/:id/managers',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const group = await findGroup(String(req.params.id));
    if (!group) throw notFound('That group no longer exists.');
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const userId = typeof raw.userId === 'string' ? raw.userId : '';
    const current = (await groupManagers(group.id)).map((m) => m.id);
    const next = raw.action === 'remove' ? current.filter((id) => id !== userId) : [...current, userId];
    const done = await attempt(() => setGroupManagers(group.id, next, req.currentUser?.id ?? null));
    flash(req, done.ok ? 'success' : 'error', done.ok ? (raw.action === 'remove' ? 'Manager removed.' : 'Manager added.') : (Object.values(done.errors)[0] ?? 'That person cannot manage a group.'), 'managers');
    res.redirect('/admin/settings/groups/' + group.id + '#managers');
  }),
);

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

groupAdminRouter.post(
  '/:id/members',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const group = await findGroup(String(req.params.id));
    if (!group) throw notFound('That group no longer exists.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const { shown, ticked } = pickerSelection(raw);

    // Only the people this page had on screen. Replacing the whole list
    // would empty the group of everybody on the other pages.
    await setMembersWithin(group.id, shown, ticked, req.currentUser?.id ?? null);

    auditRequest(req, {
      action: 'group.membership.changed',
      targetType: 'group',
      targetId: group.id,
      detail: { name: group.name, shown: shown.length, ticked: ticked.length },
    });
    flash(req, 'success', 'Membership of "' + group.name + '" updated.');
    res.redirect('/admin/settings/groups/' + group.id + pickerReturn(raw));
  }),
);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

groupAdminRouter.post(
  '/:id/rules',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const group = await findGroup(String(req.params.id));
    if (!group) throw notFound('That group no longer exists.');
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const attempted = await attempt(() =>
      addTechnicianRule(
        group.id,
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
        'admin/settings/group-detail',
        settingsView('groups', {
          sectionTitle: group.name,
          tab: 'technicians',
          group,
          staff: await listAssignableStaff(),
          ...(await memberLocals(group.id, req)),
          errors: attempted.errors,
          openDialog: 'add-rule',
        }),
      );
      return;
    }
    const byRule = (await listMembers(group.id)).filter((m) => m.member_source === 'rule').length;
    flash(req, 'success', 'Rule added. ' + byRule + ' technician(s) now match.');
    res.redirect('/admin/settings/groups/' + group.id + '#rules');
  }),
);

groupAdminRouter.post(
  '/:id/rules/:ruleId/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const group = await findGroup(String(req.params.id));
    if (!group) throw notFound('That group no longer exists.');
    await deleteTechnicianRule(group.id, String(req.params.ruleId), req.currentUser?.id ?? null);
    flash(req, 'success', 'Rule removed, and membership recalculated.');
    res.redirect('/admin/settings/groups/' + group.id + '#rules');
  }),
);

groupAdminRouter.post(
  '/:id/rules/apply',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const group = await findGroup(String(req.params.id));
    if (!group) throw notFound('That group no longer exists.');
    const matched = await applyTechnicianRules(group.id, req.currentUser?.id ?? null);
    flash(req, 'success', matched + ' technician(s) match the rules.');
    res.redirect('/admin/settings/groups/' + group.id + '#rules');
  }),
);

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

groupAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const group = await findGroup(String(req.params.id));
    if (!group) throw notFound('That group no longer exists.');

    await deleteGroup(group.id, req.currentUser?.id ?? null);
    flash(
      req,
      'success',
      'Group "' + group.name + '" removed. Tickets routed to it are now unrouted.',
    );
    res.redirect('/admin/settings/groups');
  }),
);
