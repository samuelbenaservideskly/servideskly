import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { isScriptOrigin } from '../services/portal.js';
import { settings, updateSettings } from '../settings/index.js';
import { settingsView } from './settings-shared.js';
import { automationAdminRouter, connectionsAdminRouter } from './automation-admin.js';
import { apiKeysAdminRouter } from './api-keys-admin.js';
import { attempt } from './form-errors.js';
import {
  DELETE_PHRASE,
  deleteEverything,
  exportEverything,
  exportSize,
} from '../services/data-export.js';

/**
 * Settings - Advanced settings.
 *
 * JavaScript: whether custom requester portals may run the administrator's
 * own script. Off by default, and switched on only through a dialog that
 * says what it means and asks for an explicit acknowledgement - a script on
 * a portal runs with every requester's session.
 */
export const advancedAdminRouter = Router();

const BASE = '/admin/settings/advanced';
const MAX_ORIGINS = 20;

function renderJavaScript(
  res: Response,
  options: {
    status?: number;
    openDialog?: string | null;
    errors?: Record<string, string>;
    originsText?: string;
  } = {},
): void {
  if (options.status) res.status(options.status);
  const current = settings().portalScripts;
  res.render(
    'admin/settings/advanced-javascript',
    settingsView('advanced', {
      scripts: current,
      originsText: options.originsText ?? current.allowedOrigins.join('\n'),
      openDialog: options.openDialog ?? null,
      errors: options.errors ?? {},
    }),
  );
}

advancedAdminRouter.get('/', (_req: Request, res: Response) => {
  res.redirect(BASE + '/javascript');
});

advancedAdminRouter.use('/automation', automationAdminRouter);
advancedAdminRouter.use('/connections', connectionsAdminRouter);
advancedAdminRouter.use('/api-keys', apiKeysAdminRouter);

advancedAdminRouter.get('/javascript', (_req: Request, res: Response) => {
  renderJavaScript(res);
});

// ---------------------------------------------------------------------------
// Data: everything out, and everything gone
// ---------------------------------------------------------------------------

async function renderData(
  _req: Request,
  res: Response,
  extra: { deleteError?: string; openDialog?: string | null } = {},
  status?: number,
): Promise<void> {
  if (status) res.status(status);
  const size = await exportSize();
  res.render(
    'admin/settings/advanced-data',
    settingsView('advanced', {
      size,
      megabytes: (size.bytes / (1024 * 1024)).toFixed(1),
      phrase: DELETE_PHRASE,
      deleteError: extra.deleteError ?? '',
      openDialog: extra.openDialog ?? null,
      // Every administrator: the wipe keeps whoever pressed it.
      canDeleteEverything: true,
    }),
  );
}

advancedAdminRouter.get(
  '/data',
  asyncHandler(async (req: Request, res: Response) => {
    await renderData(req, res);
  }),
);

advancedAdminRouter.get(
  '/data/export',
  asyncHandler(async (req: Request, res: Response) => {
    const { zip, summary } = await exportEverything(req.currentUser?.id ?? null);
    const stamp = new Date().toISOString().slice(0, 10);
    res.type('application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="service-desk-' + stamp + '.zip"');
    res.setHeader('X-Export-Rows', String(summary.rows));
    res.send(zip);
  }),
);

advancedAdminRouter.post(
  '/data/delete',
  writeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const phrase = String((req.body as Record<string, unknown>)?.phrase ?? '');
    const done = await attempt(() => deleteEverything(phrase, req.currentUser?.id ?? null));
    if (!done.ok) {
      await renderData(
        req,
        res,
        { deleteError: Object.values(done.errors)[0] ?? 'That could not be confirmed.', openDialog: 'delete-everything' },
        400,
      );
      return;
    }
    flash(
      req,
      'success',
      'Everything is gone: ' + done.value.rows.toLocaleString('en-GB') + ' rows and ' +
        done.value.files.toLocaleString('en-GB') + ' files. What is left is this installation and its break-glass administrator.',
    );
    res.redirect(BASE + '/data');
  }),
);

advancedAdminRouter.post(
  '/javascript/enable',
  writeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.understood !== 'on') {
      renderJavaScript(res, {
        status: 400,
        openDialog: 'enable-js',
        errors: { understood: 'Confirm that you understand the risks to continue.' },
      });
      return;
    }
    if (!settings().portalScripts.enabled) {
      await updateSettings({ portalScripts: { enabled: true } }, req.currentUser?.id ?? null);
      auditRequest(req, { action: 'settings.portal_scripts.enabled', targetType: 'settings' });
    }
    flash(req, 'success', 'JavaScript is allowed. Each custom portal now has a JavaScript tab.');
    res.redirect(BASE + '/javascript');
  }),
);

advancedAdminRouter.post(
  '/javascript/disable',
  writeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (settings().portalScripts.enabled) {
      await updateSettings({ portalScripts: { enabled: false } }, req.currentUser?.id ?? null);
      auditRequest(req, { action: 'settings.portal_scripts.disabled', targetType: 'settings' });
    }
    flash(req, 'success', 'JavaScript is turned off. Portal scripts are kept but no longer run.');
    res.redirect(BASE + '/javascript');
  }),
);

advancedAdminRouter.post(
  '/javascript/origins',
  writeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const originsText = typeof body.origins === 'string' ? body.origins : '';
    const origins = [
      ...new Set(
        originsText
          .split(/\r?\n/)
          .map((line) => line.trim().replace(/\/$/, ''))
          .filter((line) => line !== ''),
      ),
    ];

    const wrong = origins.filter((o) => !isScriptOrigin(o));
    let problem: string | null = null;
    if (wrong.length > 0) {
      problem =
        'Each line must be an https origin with nothing after the host, such as https://cdn.example.com. Not accepted: ' +
        wrong.slice(0, 3).join(', ') +
        (wrong.length > 3 ? ' and ' + (wrong.length - 3) + ' more.' : '.');
    } else if (origins.length > MAX_ORIGINS) {
      problem = 'List at most ' + MAX_ORIGINS + ' origins.';
    }
    if (problem) {
      renderJavaScript(res, { status: 400, errors: { origins: problem }, originsText });
      return;
    }

    await updateSettings({ portalScripts: { allowedOrigins: origins } }, req.currentUser?.id ?? null);
    auditRequest(req, {
      action: 'settings.portal_scripts.origins_changed',
      targetType: 'settings',
      detail: { allowedOrigins: origins },
    });
    flash(req, 'success', 'Allowed origins saved.');
    res.redirect(BASE + '/javascript');
  }),
);
