import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { notFound } from '../lib/errors.js';
import { assertCsrfToken } from '../middleware/csrf.js';
import { pdfAvailable } from '../lib/pdf-convert.js';
import { addDocumentTemplate, deleteDocumentTemplate, findAssetFile, listDocumentTemplates, MAX_TEMPLATE_BYTES, readAssetFile } from '../services/asset-documents.js';
import { assetVariableNames } from '../services/asset-variables.js';
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

// ---------------------------------------------------------------------------
// Documents (step 5): Word templates with variables
// ---------------------------------------------------------------------------

/** Memory storage: the file is checked, then sealed to disk by the service. */
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TEMPLATE_BYTES, files: 1, fields: 5, parts: 8 },
}).single('file');

async function renderDocuments(res: Response, extra: { error?: string; added?: string } = {}, status = 200): Promise<void> {
  res.status(status).render(
    'admin/settings/assets-documents',
    settingsView('assets', {
      tab: 'documents',
      documents: await listDocumentTemplates(),
      variables: await assetVariableNames(),
      pdf: pdfAvailable(),
      error: extra.error ?? '',
      added: extra.added ?? '',
    }),
  );
}

assetsAdminRouter.get('/documents', asyncHandler(async (_req, res) => renderDocuments(res)));

assetsAdminRouter.post(
  '/documents',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tooBig = await new Promise<boolean>((resolve, reject) => {
      documentUpload(req, res, (err: unknown) => {
        if (!err) resolve(false);
        else if (err instanceof multer.MulterError) resolve(true);
        else reject(err);
      });
    });
    // The global CSRF check runs before a multipart body exists (app.ts).
    assertCsrfToken(req);
    if (tooBig) return renderDocuments(res, { error: 'A document must be 5 MB or smaller.' }, 400);
    if (!req.file || req.file.size === 0) return renderDocuments(res, { error: 'Choose a Word document (.docx) to upload.' }, 400);
    const added = await attempt(() => addDocumentTemplate(req.file!.originalname, req.file!.buffer, req.currentUser ?? null));
    if (!added.ok) return renderDocuments(res, { error: Object.values(added.errors)[0] ?? 'That document could not be added.' }, 400);
    return renderDocuments(res, { added: added.value.id });
  }),
);

assetsAdminRouter.get(
  '/documents/:id/download',
  asyncHandler(async (req, res) => {
    const row = await findAssetFile(String(req.params.id));
    if (!row || row.kind !== 'template') throw notFound('That document does not exist.');
    const bytes = await readAssetFile(row);
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Disposition', 'attachment; filename="' + row.name.replace(/[^\w .-]+/g, '_') + '.docx"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  }),
);

assetsAdminRouter.post(
  '/documents/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await done(req, res, BASE + '/documents', () => deleteDocumentTemplate(String(req.params.id), req.currentUser ?? null), 'Document removed.');
  }),
);
