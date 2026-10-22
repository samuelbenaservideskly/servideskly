import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { can } from '../auth/permissions.js';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { queryString } from '../lib/format.js';
import { requireAuth } from '../middleware/auth.js';
import { assertCsrfToken } from '../middleware/csrf.js';
import { auditRequest } from '../lib/audit.js';
import { assetTemplateCsv, MAX_ASSET_ROWS, planAssetImport, runAssetImport } from '../services/asset-import.js';
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
  type AssetFilters,
  type AssetInput,
  assetColumnValues,
} from '../services/assets.js';
import { BLANK, filterParams, menuValues, readColumnFilters, type ColumnValue } from '../lib/column-filters.js';
import { attempt, type FieldErrors } from './form-errors.js';
import { findAssetFile, listGeneratedFor, readAssetFile } from '../services/asset-documents.js';

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
  // The table shows the short columns; several lines belong on the asset's page.
  const shown = columns.filter((c) => c.format !== 'textarea').slice(0, 7);
  // Excel-like headers (lib/column-filters.ts): each shown column, and Status.
  const filterable = [...shown.map((c) => c.key), 'status'];
  const columnFilters = readColumnFilters(req.query as Record<string, unknown>, filterable);
  const query: AssetFilters = {
    ...(q ? { q } : {}),
    ...(statusId ? { statusId } : {}),
    ...(assigned === 'none' ? { unassigned: true } : assigned ? { assignedTo: assigned } : {}),
    ...(sort ? { sort } : {}),
    dir,
    columns: columnFilters,
  };
  const [found, menuRows] = await Promise.all([
    listAssets({ ...query, page, perPage: PER_PAGE }),
    Promise.all(filterable.map((key) => assetColumnValues(query, key))),
  ]);
  // Each header's menu: its values (a blank one reads Nobody or Empty) and what is ticked.
  const blankLabel = (key: string) => (key === ASSIGNED_TO ? 'Nobody' : key === 'status' ? 'No status' : 'Empty');
  const columnMenus: Record<string, { values: ColumnValue[]; selected: string[] }> = {};
  filterable.forEach((key, i) => {
    const rows = menuRows[i]!.map((r) => ({ ...r, label: r.value === BLANK ? blankLabel(key) : r.label || r.value }));
    const selected = columnFilters[key] ?? [];
    columnMenus[key] = { values: menuValues(rows, selected, (v) => (v === BLANK ? blankLabel(key) : v)), selected };
  });
  const filters = { q, status: statusId, assigned, sort, dir };
  const state = { ...filters, ...filterParams(columnFilters) };
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
    state,
    columnMenus,
    link: (over: Record<string, string | number | undefined>) => '/inventory' + queryString({ ...state, ...over }),
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

// --- import (step 2), before /:id so "import" is not read as an asset ---------

assetsRouter.get(
  '/import/template.csv',
  asyncHandler(async (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="assets.csv"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(await assetTemplateCsv());
  }),
);

assetsRouter.get('/import', (_req, res) => {
  res.render('assets/import', { title: 'Import assets', problems: [], skipped: [], imported: null, maxRows: MAX_ASSET_ROWS });
});

/** Memory storage: the file is read and thrown away, never kept. */
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5, parts: 8 },
}).single('file');

assetsRouter.post(
  '/import',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tooBig = await new Promise<boolean>((resolve, reject) => {
      importUpload(req, res, (err: unknown) => {
        if (!err) resolve(false);
        else if (err instanceof multer.MulterError) resolve(true);
        else reject(err);
      });
    });
    // The global CSRF check runs before a multipart body exists (app.ts), so
    // it is made here, once the token can be read.
    assertCsrfToken(req);
    const page = (problems: string[], skipped: string[] = [], imported: number | null = null, status = 200) =>
      res.status(status).render('assets/import', { title: 'Import assets', problems, skipped, imported, maxRows: MAX_ASSET_ROWS });

    if (tooBig) return page(['The file must be 2 MB or smaller.'], [], null, 400);
    const file = req.file;
    if (!file || file.size === 0) return page(['Choose a CSV file to upload.'], [], null, 400);
    const text = file.buffer.toString('utf8');
    if (text.includes('\u0000')) return page(['That is not a CSV file. Save the sheet as "CSV UTF-8" and upload that.'], [], null, 400);

    const plan = await planAssetImport(text);
    if (plan.problems.length) return page(plan.problems, [], null, 400);
    const imported = await runAssetImport(plan.create, req.currentUser ?? null);
    auditRequest(req, { action: 'asset.imported', targetType: 'asset', detail: { created: imported, skipped: plan.skipped.length } });
    return page([], plan.skipped, imported);
  }),
);

async function renderAsset(_req: Request, res: Response, id: string, extra: { errors?: FieldErrors; draft?: AssetInput; status?: number } = {}): Promise<void> {
  const asset = await getAsset(id);
  if (!asset) throw notFound('That asset does not exist.');
  const [columns, statuses, events, comments, documents] = await Promise.all([enabledColumns(), listStatuses(), listAssetEvents(id), listAssetComments(id), listGeneratedFor(id)]);
  res.status(extra.status ?? 200).render('assets/show', {
    title: assetTitle(asset),
    asset,
    columns,
    statuses,
    events,
    comments,
    documents,
    errors: extra.errors ?? {},
    draft: extra.draft ?? null,
    ASSIGNED_TO,
  });
}

assetsRouter.get('/:id', asyncHandler(async (req, res) => renderAsset(req, res, String(req.params.id))));

/** A document sent about this asset (step 5): a download, never shown in place. */
assetsRouter.get(
  '/:id/files/:fileId',
  asyncHandler(async (req, res) => {
    const row = await findAssetFile(String(req.params.fileId));
    if (!row || row.kind !== 'generated' || row.asset_id !== String(req.params.id)) throw notFound('That document does not exist.');
    const bytes = await readAssetFile(row);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + row.name.replace(/[^\w .()-]+/g, '_') + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  }),
);

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
