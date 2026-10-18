import { Router, type Request, type Response, type NextFunction } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { allowOwnScripts, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { attempt } from './form-errors.js';
import { isStaff } from '../services/users.js';
import { listActiveGroups } from '../services/groups.js';
import { PERIODS, reportGroups } from '../services/reports.js';
import { PRIORITY_LABELS, STATUS_LABELS, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_TYPES, TYPE_LABELS } from '../services/tickets.js';
import {
  PIN_ICONS,
  REPORT_METRICS,
  SCOPES,
  WIDGET_KINDS,
  addPin,
  addWidget,
  createBoard,
  dashboardChoices,
  deleteBoard,
  findBoard,
  listBoards,
  listPins,
  movePin,
  moveWidget,
  pinHrefProblem,
  removePin,
  removeWidget,
  renameBoard,
  updatePin,
  updateWidget,
  viewWidget,
  widgetFromForm,
  widgetTitle,
  activeShare,
  boardForToken,
  importBoard,
  shareBoard,
  stopSharing,
  tokenFromLink,
} from '../services/boards.js';
import { config } from '../config.js';
import { auditRequest } from '../lib/audit.js';
import { query } from '../db/index.js';

/**
 * /boards - My dashboards and pins (services/boards.ts). Technicians and
 * administrators; a requester gets a 404. Everything here is the signed-in
 * person's own: another person's dashboard or pin is "not found".
 */
export const boardsRouter = Router();

boardsRouter.use(requireAuth());
boardsRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.currentUser || !isStaff(req.currentUser.role)) return next(notFound());
  next();
});

const owner = (req: Request) => req.currentUser!.id;
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const BASE = '/boards';

/** Choices for the widget form: groups, companies, labels. */
async function formChoices(req: Request) {
  const groups = await listActiveGroups();
  const reportable = await reportGroups(req.currentUser!);
  const ids = reportable.map((g) => g.id);
  const companies = ids.length
    ? (await query<{ company: string }>(
        `SELECT DISTINCT u.company FROM tickets t JOIN users u ON u.id = t.requester_id
          WHERE t.group_id IN (${ids.map(() => '?').join(', ')}) AND u.company <> '' ORDER BY u.company`,
        ids,
      )).map((r) => r.company)
    : [];
  return {
    widgetKinds: WIDGET_KINDS,
    // The dashboards a Dashboard widget can show. Every one, including the
    // ones switched off: a board owner may be setting one up before an
    // administrator turns it on, and the row says which are off.
    dashboards: await dashboardChoices(),
    scopes: SCOPES,
    statuses: TICKET_STATUSES,
    statusLabels: STATUS_LABELS,
    priorities: TICKET_PRIORITIES,
    priorityLabels: PRIORITY_LABELS,
    types: TICKET_TYPES,
    typeLabels: TYPE_LABELS,
    groups,
    reportGroups: reportable,
    companies,
    periods: PERIODS.filter((p) => p.key !== 'custom'),
    metrics: REPORT_METRICS,
    pinIcons: PIN_ICONS,
    groupName: (id: string) => groups.find((g) => g.id === id)?.name,
  };
}

// --- the list: my dashboards and my pins --------------------------------------------

async function renderList(req: Request, res: Response, extra: { status?: number; errors?: Record<string, string>; openDialog?: string | null } = {}) {
  if (extra.status) res.status(extra.status);
  res.render('boards/index', {
    title: 'My dashboards',
    boards: await listBoards(owner(req)),
    pins: await listPins(owner(req)),
    pinIcons: PIN_ICONS,
    errors: extra.errors ?? {},
    openDialog: extra.openDialog ?? null,
  });
}

// The copy buttons beside each pin's address: copy.js, on this page only
// (approved 15 Oct 2026). Nothing is fetched, so connect-src stays 'none'.
boardsRouter.get('/', allowOwnScripts(), asyncHandler(async (req, res) => renderList(req, res)));

boardsRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const done = await attempt(() => createBoard(owner(req), str(body(req).name)));
    if (!done.ok) return renderList(req, res, { status: 400, errors: { name: done.errors.form ?? Object.values(done.errors)[0] ?? '' }, openDialog: 'new-board' });
    flash(req, 'success', 'Dashboard created and pinned. Add its first widget.');
    res.redirect(BASE + '/' + done.value.id + '?edit=1#add-widget');
  }),
);

// --- importing a shared dashboard (before '/:id') ------------------------------------

/** A pasted link: to its preview. */
boardsRouter.post(
  '/import',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const token = tokenFromLink(str(body(req).link));
    if (!token) {
      flash(req, 'error', 'That is not a dashboard link. It looks like ' + config.publicOrigin + '/boards/import/...');
      return res.redirect(BASE + '#import');
    }
    res.redirect(BASE + '/import/' + token);
  }),
);

boardsRouter.get(
  '/import/:token',
  asyncHandler(async (req, res) => {
    const source = await boardForToken(String(req.params.token));
    // Expired, stopped, mistyped or never: the same answer.
    if (!source) {
      res.status(404).render('boards/import', { title: 'Import a dashboard', source: null, token: '' });
      return;
    }
    const choices = await formChoices(req);
    res.render('boards/import', {
      title: 'Import a dashboard',
      source,
      token: String(req.params.token),
      titles: source.widgets.map((w) => widgetTitle(w, choices.groupName)),
    });
  }),
);

boardsRouter.post(
  '/import/:token',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const done = await attempt(() => importBoard(owner(req), String(req.params.token)));
    if (!done.ok) {
      flash(req, 'error', done.errors.form ?? Object.values(done.errors)[0] ?? '');
      return res.redirect(BASE);
    }
    flash(req, 'success', 'Added to your dashboards and pinned. It shows what you may see.');
    res.redirect(BASE + '/' + done.value.id);
  }),
);

// --- pins (before '/:id') ----------------------------------------------------------

boardsRouter.post(
  '/pins',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const b = body(req);
    const href = str(b.href);
    const done = await attempt(() => addPin(owner(req), { label: str(b.label), href, icon: str(b.icon) }));
    flash(req, done.ok ? 'success' : 'error', done.ok ? 'Pinned to the sidebar.' : (done.errors.form ?? Object.values(done.errors)[0] ?? ''));
    // Back where the pin was made - only when it is a place a pin may name.
    res.redirect(pinHrefProblem(href) ? BASE : href);
  }),
);

boardsRouter.post(
  '/pins/:pin',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const done = await attempt(() => updatePin(owner(req), String(req.params.pin), { label: str(body(req).label), icon: str(body(req).icon) }));
    flash(req, done.ok ? 'success' : 'error', done.ok ? 'Pin saved.' : (done.errors.form ?? Object.values(done.errors)[0] ?? ''));
    res.redirect(BASE + '#pins');
  }),
);

boardsRouter.post(
  '/pins/:pin/move',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await movePin(owner(req), String(req.params.pin), body(req).direction === 'up' ? 'up' : 'down');
    res.redirect(BASE + '#pins');
  }),
);

boardsRouter.post(
  '/pins/:pin/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await removePin(owner(req), String(req.params.pin));
    flash(req, 'success', 'Unpinned.');
    res.redirect(str(body(req).returnTo).startsWith('/boards') ? str(body(req).returnTo) : BASE + '#pins');
  }),
);

// --- one dashboard ------------------------------------------------------------------

async function renderBoard(req: Request, res: Response, id: string, extra: { status?: number; openDialog?: string | null; error?: string; shareLink?: string } = {}) {
  const board = await findBoard(owner(req), id);
  const choices = await formChoices(req);
  const views = [];
  for (const w of board.widgets) {
    views.push({ widget: w, title: widgetTitle(w, choices.groupName), view: await viewWidget(req.currentUser!, w) });
  }
  const pins = await listPins(owner(req));
  if (extra.status) res.status(extra.status);
  res.render('boards/show', {
    title: board.name,
    board,
    views,
    editing: req.query.edit === '1' || Boolean(extra.openDialog && extra.openDialog !== 'share'),
    pinned: pins.find((p) => p.href === BASE + '/' + board.id) ?? null,
    share: await activeShare(board.id),
    // Shown once, on the page the share renders - never put in a redirect or the session.
    shareLink: extra.shareLink ?? '',
    openDialog: extra.openDialog ?? null,
    error: extra.error ?? '',
    ...choices,
  });
}

boardsRouter.get('/:id', asyncHandler(async (req, res) => renderBoard(req, res, String(req.params.id))));

boardsRouter.post(
  '/:id/rename',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const done = await attempt(() => renameBoard(owner(req), id, str(body(req).name)));
    if (!done.ok) return renderBoard(req, res, id, { status: 400, openDialog: 'rename-board', error: done.errors.form ?? Object.values(done.errors)[0] ?? '' });
    flash(req, 'success', 'Renamed.');
    res.redirect(BASE + '/' + id + '?edit=1');
  }),
);

boardsRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await deleteBoard(owner(req), String(req.params.id));
    flash(req, 'success', 'Dashboard removed.');
    res.redirect(BASE);
  }),
);

boardsRouter.post(
  '/:id/pin',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const board = await findBoard(owner(req), String(req.params.id));
    const done = await attempt(() => addPin(owner(req), { label: board.name, href: BASE + '/' + board.id, icon: 'layout' }));
    flash(req, done.ok ? 'success' : 'error', done.ok ? 'Pinned to the sidebar.' : (done.errors.form ?? Object.values(done.errors)[0] ?? ''));
    res.redirect(BASE + '/' + board.id);
  }),
);

boardsRouter.post(
  '/:id/share',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const { token } = await shareBoard(owner(req), id, owner(req));
    auditRequest(req, { action: 'board.share_link_shown', targetType: 'board', targetId: id });
    await renderBoard(req, res, id, { openDialog: 'share', shareLink: config.publicOrigin + BASE + '/import/' + token });
  }),
);

boardsRouter.post(
  '/:id/share/stop',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    await stopSharing(owner(req), id, owner(req));
    flash(req, 'success', 'The link no longer works.');
    res.redirect(BASE + '/' + id);
  }),
);

boardsRouter.post(
  '/:id/widgets',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const done = await attempt(() => addWidget(owner(req), id, widgetFromForm(body(req))));
    if (!done.ok) return renderBoard(req, res, id, { status: 400, openDialog: 'add-widget', error: done.errors.form ?? Object.values(done.errors)[0] ?? '' });
    res.redirect(BASE + '/' + id + '?edit=1#widgets');
  }),
);

boardsRouter.post(
  '/:id/widgets/:widget',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const wid = String(req.params.widget);
    await updateWidget(owner(req), id, widgetFromForm(body(req), wid));
    res.redirect(BASE + '/' + id + '?edit=1#w-' + wid);
  }),
);

boardsRouter.post(
  '/:id/widgets/:widget/move',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const wid = String(req.params.widget);
    await moveWidget(owner(req), id, wid, body(req).direction === 'up' ? 'up' : 'down');
    res.redirect(BASE + '/' + id + '?edit=1#w-' + wid);
  }),
);

boardsRouter.post(
  '/:id/widgets/:widget/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    await removeWidget(owner(req), id, String(req.params.widget));
    res.redirect(BASE + '/' + id + '?edit=1#widgets');
  }),
);
