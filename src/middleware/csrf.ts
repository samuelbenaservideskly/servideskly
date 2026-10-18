import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { randomToken, safeEqual } from '../lib/util.js';

const log = logger.child({ module: 'csrf' });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_FIELD = '_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** An exact path, or a predicate for paths that carry an id. */
export type CsrfExemption = string | ((path: string) => boolean);

function isExempt(path: string, exemptions: readonly CsrfExemption[]): boolean {
  return exemptions.some((rule) => (typeof rule === 'string' ? rule === path : rule(path)));
}

/**
 * Validates the synchroniser token on the current request, throwing if it does
 * not match the one held in the session.
 *
 * Exported so routes that parse their own body can run the check at the right
 * moment. A multipart upload is the case that needs it: the global middleware
 * below runs before any multipart parser, so `req.body` is not populated yet
 * and the token can only be seen after the file parser has run.
 */
export function assertCsrfToken(req: Request): void {
  const body = req.body as Record<string, unknown> | undefined;
  const submitted =
    (typeof body?.[CSRF_FIELD] === 'string' ? (body[CSRF_FIELD] as string) : undefined) ??
    req.get(CSRF_HEADER);

  if (!safeEqual(submitted, req.session.csrfToken)) {
    log.warn({ path: req.originalUrl, method: req.method }, 'CSRF token missing or invalid');
    throw forbidden(
      'Your session has expired or the form was stale. Reload the page and try again.',
      'csrf_failed',
    );
  }
}

/**
 * Synchroniser-token CSRF protection.
 *
 * A token is minted per session and must be echoed back in the `_csrf` form
 * field (or the `X-CSRF-Token` header) on every state-changing request. The
 * token lives only in the server-side session, so a hostile page can neither
 * read it nor guess it, and the comparison is constant-time.
 *
 * Exempt paths must carry out their own protection: the SAML assertion
 * consumer relies on the assertion signature, and multipart routes call
 * `assertCsrfToken` themselves once their body has been parsed.
 */
export function csrfProtection(exemptions: readonly CsrfExemption[] = []): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.csrfToken) {
      req.session.csrfToken = randomToken(32);
    }
    req.csrfToken = req.session.csrfToken;
    res.locals.csrfToken = req.session.csrfToken;

    if (SAFE_METHODS.has(req.method) || isExempt(req.path, exemptions)) {
      next();
      return;
    }

    try {
      assertCsrfToken(req);
    } catch (err) {
      next(err);
      return;
    }

    next();
  };
}

/**
 * Issues a fresh token, used after privilege changes so a token captured
 * before a role change cannot be replayed after it.
 */
export function rotateCsrfToken(req: Request): void {
  req.session.csrfToken = randomToken(32);
  req.csrfToken = req.session.csrfToken;
}
