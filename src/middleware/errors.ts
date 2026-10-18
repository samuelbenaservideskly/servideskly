import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { auditRequest } from '../lib/audit.js';
import { config } from '../config.js';

const log = logger.child({ module: 'errors' });

export function notFoundHandler(): RequestHandler {
  return (_req: Request, _res: Response, next: NextFunction) => {
    next(notFound());
  };
}

/**
 * Final error handler.
 *
 * Only HttpError messages, which are written for users, reach the browser.
 * Everything else becomes a generic 500 with a correlation id, so stack traces
 * and internal details are never disclosed.
 */
export function errorHandler(): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const isHttp = err instanceof HttpError;
    const status = isHttp ? err.status : 500;
    const code = isHttp ? err.code : 'internal_error';
    const reference = Math.random().toString(36).slice(2, 10);

    if (status >= 500) {
      log.error({ err, reference, path: req.originalUrl, method: req.method }, 'unhandled request error');
    } else {
      log.warn({ code, reference, path: req.originalUrl, method: req.method, status }, 'request rejected');
    }

    if (status === 401 || status === 403) {
      auditRequest(req, {
        action: 'request.rejected',
        outcome: 'failure',
        targetType: 'route',
        targetId: req.originalUrl,
        detail: { status, code },
      });
    }

    const message = isHttp
      ? err.message
      : 'Something went wrong on our side. Quote reference ' + reference + ' to the service desk.';

    res.status(status);

    if (req.accepts(['html', 'json']) === 'json') {
      res.json({ error: { code, message, reference } });
      return;
    }

    res.render(
      'error',
      {
        title: titleFor(status),
        status,
        message,
        reference: status >= 500 ? reference : null,
        // Developer-only, and only for genuine server faults: a client error
        // such as a 404 has nothing useful in its stack and need not expose
        // internal paths on a shared non-production environment.
        stack: !config.isProduction && status >= 500 && err instanceof Error ? err.stack : null,
      },
      (renderErr, html) => {
        if (renderErr) {
          log.error({ err: renderErr }, 'failed to render error page');
          res.type('text/plain').send(message);
          return;
        }
        res.send(html);
      },
    );
  };
}

function titleFor(status: number): string {
  if (status === 400) return 'Bad request';
  if (status === 401) return 'Sign-in required';
  if (status === 403) return 'Access denied';
  if (status === 404) return 'Not found';
  if (status === 409) return 'Conflict';
  if (status === 429) return 'Too many requests';
  return 'Something went wrong';
}
