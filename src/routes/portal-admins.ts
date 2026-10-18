/**
 * POST /portal-sync/administrators - the customer portal's list of this
 * helpdesk's administrators (auth/portal-admins.ts has the rules).
 *
 * A machine endpoint like SCIM and the hooks: mounted ahead of sessions and
 * CSRF, with its own body parser. The body is read as text so the signature
 * is checked against exactly the bytes that were signed. Every refusal is the
 * same 401, so a prober learns nothing about why.
 */
import express, { Router } from 'express';
import { applyPortalAdmins, verifyPortalRequest } from '../auth/portal-admins.js';
import { apiKeyGuessLimiter, hookLimiter } from '../middleware/security.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'routes/portal-admins' });

export const portalAdminsRouter = Router();

portalAdminsRouter.use(hookLimiter);
// Refused signatures (401) count like refused API keys: ten, then a wait.
portalAdminsRouter.use(apiKeyGuessLimiter);

portalAdminsRouter.post('/administrators', express.text({ type: 'application/json', limit: '64kb' }), async (req, res) => {
  const body = typeof req.body === 'string' ? req.body : '';
  const at = verifyPortalRequest(body, req.get('x-portal-signature'));
  if (at === undefined) {
    res.status(401).json({ error: 'Access denied.' });
    return;
  }
  let parsed: { administrators?: unknown };
  try {
    parsed = JSON.parse(body) as { administrators?: unknown };
  } catch {
    res.status(400).json({ error: 'The body is not JSON.' });
    return;
  }
  try {
    const states = await applyPortalAdmins(parsed.administrators, at);
    res.json({ administrators: states });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'the administrator list could not be applied');
    res.status(500).json({ error: 'The list could not be applied.' });
  }
});
