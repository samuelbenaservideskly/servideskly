import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { can, canOpenSettings, permissionForSettingsPath } from '../auth/permissions.js';
import { settingsRouter } from './settings.js';

/**
 * Everything behind Admin.
 *
 * It is all one settings area now: authentication, provisioning, users,
 * technician groups, templates, attachments, customisation and the audit
 * trail. They used to be scattered between the top navigation and a settings
 * page, which meant guessing which of the two held the thing you wanted.
 */
export const adminRouter = Router();

/*
 * Who may come in (custom roles, 21 Oct 2026): an administrator everywhere;
 * anybody else only into the sections their role ticks, by the path's first
 * part (auth/permissions.ts). The roles themselves stay an administrator's.
 * Denials are audited, as requireRole's were.
 */
adminRouter.use(requireAuth(), (req, _res, next) => {
  const user = req.currentUser!;
  if (user.role === 'admin') return next();
  const needed = permissionForSettingsPath(req.path);
  const ok = needed === 'admin' ? false : needed === 'any' ? canOpenSettings(user) : can(user, needed);
  if (ok) return next();
  audit({ action: 'authz.denied', outcome: 'failure', actorId: user.id, actorEmail: user.email, detail: { path: req.originalUrl, needed } });
  next(forbidden('You do not have access to this part of Settings.', 'not_permitted'));
});

adminRouter.use('/settings', settingsRouter);

/**
 * The pages that used to live at the top level.
 *
 * Redirected rather than dropped, so an existing bookmark or link still lands
 * somewhere useful. **Whole subtrees**, not just the section roots: the first
 * version of this only matched the exact path, which left
 * `/admin/templates/new` and every `/admin/users/{id}/...` returning a 404.
 *
 * 308 rather than 302 because it preserves the method and body - a form that
 * still posts to an old URL goes through rather than silently turning into a
 * GET.
 */
const MOVED = [
  ['/users', '/admin/settings/users'],
  // Accounts merged into Users, so its sub-paths line up one for one.
  ['/accounts', '/admin/settings/users'],
  ['/templates', '/admin/settings/templates'],
  ['/audit', '/admin/settings/audit'],
  // Directory sync is gone; provisioning is where its settings went.
  ['/sync', '/admin/settings/integrations/entra/provisioning'],
] as const;

adminRouter.use((req, res, next) => {
  for (const [from, to] of MOVED) {
    if (req.path === from || req.path.startsWith(from + '/')) {
      const rest = req.path.slice(from.length);
      const query = req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
        : '';
      res.redirect(308, to + rest + query);
      return;
    }
  }
  next();
});

adminRouter.get('/', (_req, res) => res.redirect('/admin/settings'));
