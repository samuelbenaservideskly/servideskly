import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { normaliseLine } from '../lib/util.js';
import { writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import {
  createLibraryField,
  deleteLibraryField,
  libraryFieldProblems,
  libraryUsage,
  listLibraryFields,
  updateLibraryField,
  type LibraryFieldInput,
} from '../services/custom-fields.js';
import { CUSTOM_FIELD_TYPES, isCustomFieldType, parseOptions } from '../services/templates.js';
import { attempt, type FieldErrors } from './form-errors.js';
import { settingsView } from './settings-shared.js';

/**
 * Settings - Tickets - Custom fields: the library. A field written
 * once and placed on any template from the builder's palette.
 */
export const customFieldsAdminRouter = Router();

const BASE = '/admin/settings/templates/custom-fields';

async function render(
  res: Response,
  extra: { status?: number; openDialog?: string | null; errors?: FieldErrors; values?: Record<string, unknown> } = {},
): Promise<void> {
  const [fields, usage] = await Promise.all([listLibraryFields(), libraryUsage()]);
  if (extra.status) res.status(extra.status);
  res.render(
    'admin/settings/custom-fields',
    settingsView('templates', {
      tab: 'custom-fields',
      fields: fields.map((f) => ({ ...f, usedBy: usage.get(f.id) ?? [] })),
      types: CUSTOM_FIELD_TYPES,
      typeLabels: Object.fromEntries(CUSTOM_FIELD_TYPES.map((t) => [t.key, t.label])),
      openDialog: extra.openDialog ?? null,
      errors: extra.errors ?? {},
      values: extra.values ?? {},
    }),
  );
}

function read(body: Record<string, unknown>): LibraryFieldInput {
  return {
    label: typeof body.label === 'string' ? normaliseLine(body.label) : '',
    fieldType: isCustomFieldType(body.fieldType) ? body.fieldType : 'text',
    options: typeof body.options === 'string' ? parseOptions(body.options) : [],
  };
}

customFieldsAdminRouter.get('/', asyncHandler(async (_req, res) => render(res)));

customFieldsAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = read(body);
    const refuse = (errors: FieldErrors) => render(res, { status: 400, openDialog: 'new-field', errors, values: body });
    const problems = libraryFieldProblems(input);
    if (Object.keys(problems).length > 0) return refuse(problems);
    const done = await attempt(() => createLibraryField(input, req.currentUser?.id ?? null));
    if (!done.ok) return refuse(done.errors);
    flash(req, 'success', '"' + input.label + '" is in the library. Add it to a template from the builder\'s palette.');
    res.redirect(BASE + '#row-' + done.value.id);
  }),
);

customFieldsAdminRouter.post(
  '/:id',
  writeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = read(body);
    const refuse = (errors: FieldErrors) => render(res, { status: 400, openDialog: 'field-' + id, errors, values: body });
    const problems = libraryFieldProblems(input);
    if (Object.keys(problems).length > 0) return refuse(problems);
    const done = await attempt(() => updateLibraryField(id, input, req.currentUser?.id ?? null));
    if (!done.ok) return refuse(done.errors);
    flash(req, 'success', done.value > 0 ? 'Saved, and updated on ' + done.value + ' template' + (done.value === 1 ? '' : 's') + '.' : 'Saved.');
    res.redirect(BASE + '#row-' + id);
  }),
);

customFieldsAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    await deleteLibraryField(String(req.params.id), req.currentUser?.id ?? null);
    flash(req, 'success', 'Removed from the library. Templates that ask it keep it as a field of their own.');
    res.redirect(BASE);
  }),
);
