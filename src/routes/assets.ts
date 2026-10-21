import { Router, type Request, type Response } from 'express';
import { can } from '../auth/permissions.js';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { queryString } from '../lib/format.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import {
  addAssetComment,
  ASSIGNED_TO,
  assetTitle,
  createAsset,
  deleteAsset,
  enabledColumns,
  getAsset,
  listAssetComments,
  listAssetEvents,
  listAssets,
  listColumns,
  listStatuses,
  updateAsset,
  type AssetColumn,
  type AssetInput,
} from '../services/assets.js';
import { attempt, type FieldErrors } from './form-errors.js';

/**
 * /assets: the list, a new asset, one asset (services/assets.ts). For anybody
 * with "Manage assets"; anybody else gets the same 404 as a page that does
 * not exist.
 */
export const assetsRouter = Router();

assetsRouter.use(requireAuth(), (req, _res, next) => {
  if (!can(req.currentUser, 'assets.manage')) return next(notFound());
  next();
});

const PER_PAGE = 50;

/** The values a form posted, one per column (`v_<key>`); several choices arrive as a list. */
function inputFrom(body: Record<string, unknown>, columns: readonly AssetColumn[]): AssetInput {
  const values: Record<string, string> = {};
  for (const column of columns) {
    const raw = body['v_' + column.key];
    values[column.key] = Array.isArray(raw) ? raw.filter((v) => typeof v === 'string').join(', ') : typeof raw === 'string' ? raw : '';
  }
  return {
    statusId: typeof body.statusId === 'string' && body.statusId ? body.statusId : null,
    assignee: typeof body.assignee === 'string' ? body.assignee : '',
    values,
  };
}

async function renderList(req: Request, res: Response, extra: { errors?: FieldErrors; draft?: AssetInput; status?: number } = {}): Promise<void> {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const statusId = typeof req.query.status === 'string' ? req.query.status : '';
  const assigned = typeof req.query.assigned === 'string' ? req.query.assigned : '';
  const sort = typeof req.query.sort === 'string' ? req.query.sort : '';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  const asked = Number(req.query.page);
  const page = Number.isInteger(asked) && asked > 0 ? asked : 1;

  const [columns, statuses] = await Promise.all([enabledColumns(), listStatuses()]);
  const found = await listAssets({
    ...(q ? { q } : {}),
    ...(statusId ? { statusId } : {}),
    ...(assigned === 'none' ? { unassigned: true } : assigned ? { assignedTo: assigned } : {}),
    ...(sort ? { sort } : {}),
    dir,
    page,
    perPage: PER_PAGE,
  });
  // The table shows the short columns; several lines belong on the asset's page.
  const shown = columns.filter((c) => c.format !== 'textarea').slice(0, 7);
  const filters = { q, status: statusId, assigned, sort, dir };
  res.status(extra.status ?? 200).render('assets/index', {
    title: 'Assets',
    assets: found.items,
    total: found.total,
    page,
    pages: Math.max(1, Math.ceil(found.total / PER_PAGE)),
    columns,
    shown,
    statuses,
    filters,
    link: (over: Record<string, string | number | undefined>) => '/inventory' + queryString({ ...filters, ...over }),
    assetTitle,
    errors: extra.errors ?? {},
    draft: extra.draft ?? null,
    openDialog: extra.errors ? 'new-asset' : null,
  });
}

assetsRouter.get('/', asyncHandler(async (req, res) => renderList(req, res)));

assetsRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const columns = await listColumns();
    const input = inputFrom(req.body ?? {}, columns);
    const made = await attempt(() => createAsset(input, req.currentUser ?? null));
    if (!made.ok) {
      await renderList(req, res, { errors: made.errors, draft: input, status: 400 });
      return;
    }
    flash(req, 'success', 'Asset added.');
    res.redirect('/inventory/' + made.value);
  }),
);

async function renderAsset(_req: Request, res: Response, id: string, extra: { errors?: FieldErrors; draft?: AssetInput; status?: number } = {}): Promise<void> {
  const asset = await getAsset(id);
  if (!asset) throw notFound('That asset does not exist.');
  const [columns, statuses, events, comments] = await Promise.all([enabledColumns(), listStatuses(), listAssetEvents(id), listAssetComments(id)]);
  res.status(extra.status ?? 200).render('assets/show', {
    title: assetTitle(asset),
    asset,
    columns,
    statuses,
    events,
    comments,
    errors: extra.errors ?? {},
    draft: extra.draft ?? null,
    ASSIGNED_TO,
  });
}

assetsRouter.get('/:id', asyncHandler(async (req, res) => renderAsset(req, res, String(req.params.id))));

assetsRouter.post(
  '/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const input = inputFrom(req.body ?? {}, await listColumns());
    const saved = await attempt(() => updateAsset(id, input, req.currentUser ?? null));
    if (!saved.ok) {
      await renderAsset(req, res, id, { errors: saved.errors, draft: input, status: 400 });
      return;
    }
    flash(req, 'success', 'Asset saved.');
    res.redirect('/inventory/' + id);
  }),
);

assetsRouter.post(
  '/:id/comments',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const body = typeof (req.body ?? {}).body === 'string' ? String(req.body.body) : '';
    const added = await attempt(() => addAssetComment(id, body, req.currentUser ?? null));
    if (!added.ok) flash(req, 'error', Object.values(added.errors)[0] ?? 'That comment could not be added.', 'comment');
    res.redirect('/inventory/' + id + '#comments');
  }),
);

assetsRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await deleteAsset(String(req.params.id), req.currentUser ?? null);
    flash(req, 'success', 'Asset removed.');
    res.redirect('/inventory');
  }),
);
