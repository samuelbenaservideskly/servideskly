import type { Request, RequestHandler, Response } from 'express';
import { settings } from '../settings/index.js';
import { isStaff } from '../services/users.js';
import { brandingVersion } from '../services/branding.js';
import { can, canOpenSettings, canRead, roleById } from '../auth/permissions.js';

export type FlashType = 'success' | 'error' | 'info';

/**
 * Queues a one-shot message to render on the next page the user sees.
 *
 * `where` names a place on that page. Without it the message is a banner at
 * the top, which is right for "Saved" and wrong for "that file is not what it
 * says it is" - a refusal belongs beside the control that caused it, or the
 * reader has to work out which of the things they just did went wrong. A view
 * that claims a `where` renders those messages itself; the banner skips them.
 */
export function flash(req: Request, type: FlashType, message: string, where?: string): void {
  if (!req.session.flash) req.session.flash = [];
  // Bounded, so a redirect loop cannot grow the session without limit.
  if (req.session.flash.length < 10) {
    req.session.flash.push({ type, message, ...(where ? { where } : {}) });
  }
}

/**
 * Exposes the small, fixed set of values every template needs, and drains
 * queued flash messages exactly once.
 */
export function viewLocals(): RequestHandler {
  return (req: Request, res: Response, next) => {
    const messages = req.session.flash ?? [];
    if (messages.length > 0) req.session.flash = [];

    res.locals.flashMessages = messages;
    res.locals.currentUser = req.currentUser ?? null;
    res.locals.isStaff = req.currentUser ? isStaff(req.currentUser.role) : false;
    res.locals.isAdmin = req.currentUser?.role === 'admin';
    // Custom roles (auth/permissions.ts): asked when a page is drawn.
    res.locals.can = (permission: string) => can(req.currentUser, permission);
    // Read only or more (permission levels, 22 Oct 2026): enough to show a link or a page.
    res.locals.canRead = (permission: string) => canRead(req.currentUser, permission);
    res.locals.canOpenSettings = () => canOpenSettings(req.currentUser);
    // Shown under the person's name in the sidebar instead of the base role.
    res.locals.roleName = req.currentUser?.role_id && req.currentUser.role !== 'admin' ? (roleById(req.currentUser.role_id)?.name ?? '') : '';
    res.locals.canSection = (slug: string) => {
      const user = req.currentUser;
      if (!user) return false;
      if (user.role === 'admin') return true;
      if (slug === 'advanced') return canRead(user, 'settings.advanced') || canRead(user, 'automation.manage') || canRead(user, 'api.manage');
      return canRead(user, 'settings.' + slug);
    };
    res.locals.currentPath = req.path;
    // Branding is read per request, so a change in Customisation shows up
    // immediately without a restart.
    const branding = settings().branding;
    res.locals.appName = branding.appName;
    res.locals.brandingLogo = branding.logo !== null;
    res.locals.brandingVersion = brandingVersion();
    next();
  };
}
