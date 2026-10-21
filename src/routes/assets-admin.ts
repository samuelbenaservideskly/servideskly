import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import {
  addColumn,
  addStatus,
  ASSET_FORMATS,
  deleteColumn,
  deleteStatus,
  listColumns,
  listStatuses,
  moveColumn,
  moveStatus,
  renameStatus,
  updateColumn,
  type ColumnInput,
} from '../services/assets.js';
import { attempt } from './form-errors.js';
import { settingsView } from './settings-shared.js';

/**
 * Settings - Assets (services/assets.ts): the columns an asset has and the
 * statuses it can be in. The gate is `settings.assets` (routes/admin.ts, by
 * the path's first part); working with assets themselves is /assets.
 */
export const assetsAdminRouter = Router();

const BASE = '/admin/settings/assets';

const text = (v: unknown) => (typeof v === 'string' ? v : '');

function columnInput(body: Record<string, unknown>): ColumnInput {
  return {
    label: text(body.label).replace(/\s+/g, ' ').trim(),
    format: text(body.format),
    choices: text(body.choices).split(/\r?\n/),
    enabled: body.enabled === 'on',
  };
}

/** A refusal said at the top of the page it came from, with what was refused. */
async function done(req: Request, res: Response, to: string, work: () => Promise<unknown>, success: string): Promise<void> {
  const result = await attempt(work);
  if (result.ok) flash(req, 'success', success);
  else flash(req, 'error', Object.values(result.errors)[0] ?? 'That could not be saved.');
  res.redirect(to);
}

assetsAdminRouter.get('/', (_req, res) => res.redirect(BASE + '/columns'));

assetsAdminRouter.get(
  '/columns',
  asyncHandler(async (_req, res) => {
    res.render('admin/settings/assets-columns', settingsView('assets', { tab: 'columns', columns: await listColumns(), formats: ASSET_FORMATS }));
  }),
);

assetsAdminRouter.post(
  '/columns',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const input = columnInput(req.body ?? {});
    await done(req, res, BASE + '/columns', () => addColumn({ ...input, enabled: true }, req.currentUser ?? null), 'Column added.');
  }),
);

assetsAdminRouter.post(
  '/columns/:key',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    await done(req, res, BASE + '/columns#row-' + key, () => updateColumn(key, columnInput(req.body ?? {}), req.currentUser ?? null), 'Column saved.');
  }),
);

assetsAdminRouter.post(
  '/columns/:key/move',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    await moveColumn(key, (req.body ?? {}).direction === 'up' ? 'up' : 'down');
    res.redirect(BASE + '/columns#row-' + key);
  }),
);

assetsAdminRouter.post(
  '/columns/:key/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await done(req, res, BASE + '/columns', () => deleteColumn(String(req.params.key), req.currentUser ?? null), 'Column removed.');
  }),
);

assetsAdminRouter.get(
  '/statuses',
  asyncHandler(async (_req, res) => {
    res.render('admin/settings/assets-statuses', settingsView('assets', { tab: 'statuses', statuses: await listStatuses() }));
  }),
);

assetsAdminRouter.post(
  '/statuses',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await done(req, res, BASE + '/statuses', () => addStatus(text((req.body ?? {}).name), req.currentUser ?? null), 'Status added.');
  }),
);

assetsAdminRouter.post(
  '/statuses/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    await done(req, res, BASE + '/statuses#row-' + id, () => renameStatus(id, text((req.body ?? {}).name), req.currentUser ?? null), 'Status renamed.');
  }),
);

assetsAdminRouter.post(
  '/statuses/:id/move',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    await moveStatus(id, (req.body ?? {}).direction === 'up' ? 'up' : 'down');
    res.redirect(BASE + '/statuses#row-' + id);
  }),
);

assetsAdminRouter.post(
  '/statuses/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await done(req, res, BASE + '/statuses', () => deleteStatus(String(req.params.id), req.currentUser ?? null), 'Status removed.');
  }),
);
