import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
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

// Every route below requires an authenticated administrator.
adminRouter.use(requireAuth(), requireRole('admin'));

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
