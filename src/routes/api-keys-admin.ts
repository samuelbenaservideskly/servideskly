import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { normaliseLine } from '../lib/util.js';
import { allowOwnScripts, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { listAutomations } from '../services/automation.js';
import { listActiveTemplates } from '../services/templates.js';
import { API_LANGUAGES, apiGuide, apiReadGuide, apiWriteGuide } from '../services/api-examples.js';
import { KEY_ACTIONS, createApiKey, deleteApiKey, keyStart, listApiKeys, rotateApiKey, setApiKeyActions } from '../services/api-keys.js';
import { attempt, type FieldErrors } from './form-errors.js';
import { settingsView } from './settings-shared.js';
import { config as appConfig } from '../config.js';

/**
 * Settings - Advanced - API keys. A key starts the automations whose trigger
 * names it, and runs only the steps ticked on it. The secret is shown once,
 * on the page the create renders - never put in the session or a redirect.
 */
export const apiKeysAdminRouter = Router();

const BASE = '/admin/settings/advanced/api-keys';

function ticked(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? [value] : [];
}

async function render(
  res: Response,
  extra: {
    status?: number;
    openDialog?: string | null;
    errors?: FieldErrors;
    values?: Record<string, unknown>;
    created?: { name: string; secret: string; rotated?: boolean } | null;
  } = {},
): Promise<void> {
  const [keys, automations, active] = await Promise.all([listApiKeys(), listAutomations(), listActiveTemplates()]);
  // Which automations each key starts, so a delete says what it stops.
  const usedBy: Record<string, string[]> = {};
  for (const a of automations) {
    const trigger = a.graph.nodes.find((n) => n.type === 'trigger');
    if (trigger?.config.event === 'http.received' && trigger.config.apiKeyId) {
      (usedBy[trigger.config.apiKeyId] ??= []).push(a.name);
    }
  }
  // The examples name a real automation's address when there is one - one a
  // key can actually start, ahead of a worked example with no key chosen,
  // whose address only ever answers "Access denied".
  const httpTrigger = (a: (typeof automations)[number]) =>
    a.graph.nodes.find((n) => n.type === 'trigger' && n.config.event === 'http.received');
  const http = automations.filter((a) => httpTrigger(a));
  const firstHttp =
    http.find((a) => a.is_enabled && httpTrigger(a)?.config.apiKeyId) ??
    http.find((a) => httpTrigger(a)?.config.apiKeyId) ??
    http[0];
  const exampleUrl = appConfig.publicOrigin + '/hooks/automations/' + (firstHttp?.id ?? '<automation id>');
  if (extra.status) res.status(extra.status);
  res.render(
    'admin/settings/api-keys',
    settingsView('advanced', {
      tab: 'api-keys',
      keyStart,
      keys,
      usedBy,
      actions: KEY_ACTIONS,
      templates: active.filter((t) => t.type !== 'task'),
      templateNames: Object.fromEntries(active.map((t) => [t.id, t.name])),
      openDialog: extra.openDialog ?? null,
      errors: extra.errors ?? {},
      values: extra.values ?? {},
      created: extra.created ?? null,
      origin: appConfig.publicOrigin,
      exampleUrl,
      languages: API_LANGUAGES,
      guide: apiGuide(exampleUrl),
      readGuide: apiReadGuide(appConfig.publicOrigin),
      writeGuide: apiWriteGuide(appConfig.publicOrigin),
      httpAutomations: automations.filter((a) => a.graph.nodes.some((n) => n.type === 'trigger' && n.config.event === 'http.received')).map((a) => ({ id: a.id, name: a.name })),
    }),
  );
}

// The copy buttons: copy.js, ours, on this page only (approved 12 Oct 2026).
// The page works without it - the key and the code select with one click.
apiKeysAdminRouter.get('/', allowOwnScripts(), asyncHandler(async (_req, res) => render(res)));

apiKeysAdminRouter.post(
  '/',
  writeLimiter,
  // The new key is shown on this response, with its copy button.
  allowOwnScripts(),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = normaliseLine(typeof body.name === 'string' ? body.name : '').slice(0, 80);
    const actions = ticked(body.actions);
    const templateIds = ticked(body.templateIds);
    const values = { name, actions, templateIds };
    const refuse = (errors: FieldErrors) => render(res, { status: 400, openDialog: 'new-key', errors, values });
    if (!name) return refuse({ name: 'Name the key, after the system that will use it.' });
    if (actions.length === 0) return refuse({ actions: 'Tick at least one step the key may run.' });
    const done = await attempt(() => createApiKey(name, actions, req.currentUser?.id ?? null, templateIds));
    if (!done.ok) return refuse({ name: Object.values(done.errors)[0] ?? 'That key could not be made.' });
    auditRequest(req, { action: 'settings.api_key.created', targetType: 'api_key', targetId: done.value.row.id });
    // Rendered, not redirected: the secret must not travel anywhere else.
    res.setHeader('Cache-Control', 'no-store');
    return render(res, { created: { name: done.value.row.name, secret: done.value.secret } });
  }),
);

apiKeysAdminRouter.post(
  '/:id/actions',
  writeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const actions = ticked((req.body ?? {}).actions);
    const templateIds = ticked((req.body ?? {}).templateIds);
    if (actions.length === 0) {
      return render(res, { status: 400, openDialog: 'key-' + id, errors: { actions: 'Tick at least one step, or delete the key.' } });
    }
    await setApiKeyActions(id, actions, req.currentUser?.id ?? null, templateIds);
    flash(req, 'success', 'Saved.');
    res.redirect(BASE + '#row-' + id);
  }),
);

apiKeysAdminRouter.post(
  '/:id/rotate',
  writeLimiter,
  // The new secret is shown on this response, with its copy button.
  allowOwnScripts(),
  asyncHandler(async (req: Request, res: Response) => {
    const done = await rotateApiKey(String(req.params.id), req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.api_key.rotated', targetType: 'api_key', targetId: done.row.id });
    // Rendered, not redirected: the secret must not travel anywhere else.
    res.setHeader('Cache-Control', 'no-store');
    return render(res, { created: { name: done.row.name, secret: done.secret, rotated: true } });
  }),
);

apiKeysAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    await deleteApiKey(String(req.params.id), req.currentUser?.id ?? null);
    flash(req, 'success', 'Key deleted. Requests that use it are refused from now on.');
    res.redirect(BASE);
  }),
);
