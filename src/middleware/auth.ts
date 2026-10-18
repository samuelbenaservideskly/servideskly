import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '../config.js';
import { forbidden } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { findUserById, roleAtLeast } from '../services/users.js';
import { safeRedirectPath } from '../lib/util.js';

const log = logger.child({ module: 'auth' });

/**
 * Resolves the session's user on every request.
 *
 * The role is read from the database rather than the session, so a role change
 * or a lockout takes effect on the user's very next request instead of when
 * their session happens to expire.
 */
export function loadCurrentUser(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = req.session.userId;
    if (!userId) {
      next();
      return;
    }

    void resolve(req, res, next, userId).catch(next);
  };
}

/** Loads and vets the session owner. Split out so the middleware can be sync. */
async function resolve(
  req: Request,
  res: Response,
  next: NextFunction,
  userId: string,
): Promise<void> {
  {
    const user = await findUserById(userId);
    if (!user) {
      log.warn({ userId }, 'session referenced a missing user, signing out');
      req.session.destroy(() => res.redirect('/login'));
      return;
    }

    if (user.status !== 'active') {
      log.info({ userId }, 'session belongs to a disabled account, signing out');
      audit({
        action: 'auth.session.revoked',
        outcome: 'failure',
        actorId: user.id,
        actorEmail: user.email,
        detail: { reason: 'account_disabled' },
        ip: req.ip ?? null,
      });
      req.session.destroy(() => res.redirect('/login?disabled=1'));
      return;
    }

    req.currentUser = user;
    res.locals.currentUser = user;
    next();
  }
}

/** Requires a signed-in user; otherwise sends the browser through SSO. */
export function requireAuth(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.currentUser) {
      next();
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      // Remember where they were headed, validated to a local path.
      const returnTo = safeRedirectPath(req.originalUrl, '/tickets');
      res.redirect('/login?returnTo=' + encodeURIComponent(returnTo));
      return;
    }

    next(forbidden('Please sign in again and retry.', 'not_authenticated'));
  };
}

/** Requires at least the given role. Denials are audited. */
export function requireRole(required: Role): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.currentUser;
    if (!user) {
      next(forbidden('Please sign in again and retry.', 'not_authenticated'));
      return;
    }
    if (!roleAtLeast(user.role, required)) {
      log.warn(
        { userId: user.id, role: user.role, required, path: req.originalUrl },
        'authorisation denied',
      );
      audit({
        action: 'authz.denied',
        outcome: 'failure',
        actorId: user.id,
        actorEmail: user.email,
        targetType: 'route',
        targetId: req.originalUrl,
        detail: { role: user.role, required },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      next(forbidden('You do not have permission to view that.', 'insufficient_role'));
      return;
    }
    next();
  };
}
