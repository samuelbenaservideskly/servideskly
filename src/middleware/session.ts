import session from 'express-session';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { sessionStore } from '../auth/session-store.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

const log = logger.child({ module: 'session' });

export function sessionMiddleware(): RequestHandler {
  return session({
    name: config.session.name,
    // Array form lets the first key sign new cookies while older keys still
    // verify existing ones, so secrets can be rotated without mass logout.
    secret: [...config.session.keys],
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    // Refresh the cookie on activity so the idle timeout tracks real use.
    rolling: true,
    proxy: config.trustProxy !== false,
    cookie: {
      httpOnly: true,
      secure: config.session.secureCookies,
      // Lax keeps the cookie on top-level navigations back from the identity
      // provider while withholding it from cross-site subresource requests.
      sameSite: 'lax',
      path: '/',
      maxAge: config.session.idleTimeoutMs,
    },
  });
}

/**
 * Enforces an absolute session lifetime on top of the rolling idle timeout, so
 * a continuously-active session still has to re-authenticate eventually.
 */
export function enforceSessionLifetime(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const sess = req.session;
    if (!sess.userId) {
      next();
      return;
    }

    const now = Date.now();
    if (!sess.createdAt) sess.createdAt = now;

    if (now - sess.createdAt > config.session.absoluteTimeoutMs) {
      const userId = sess.userId;
      log.info({ userId }, 'session reached absolute lifetime, re-authentication required');
      audit({
        action: 'auth.session.expired',
        actorId: userId,
        detail: { reason: 'absolute_timeout' },
        ip: req.ip ?? null,
      });
      sess.destroy((err) => {
        if (err) log.warn({ err }, 'failed to destroy expired session');
        res.redirect('/login?expired=1');
      });
      return;
    }

    sess.lastSeenAt = now;
    next();
  };
}

/**
 * Rotates the session id after a successful authentication, which is the
 * standard defence against session fixation.
 */
export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    // Values worth preserving across the rotation.
    const flash = req.session.flash;
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }
      if (flash) req.session.flash = flash;
      resolve();
    });
  });
}

/** Persists pending session changes before a redirect or render. */
export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

/** Destroys the session and clears its cookie. */
export function destroySession(req: Request, res: Response): Promise<void> {
  return new Promise((resolve) => {
    req.session.destroy(() => {
      res.clearCookie(config.session.name, {
        httpOnly: true,
        secure: config.session.secureCookies,
        sameSite: 'lax',
        path: '/',
      });
      resolve();
    });
  });
}
