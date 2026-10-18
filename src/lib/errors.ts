/**
 * Error carrying an HTTP status and a message that is safe to show a user.
 * Anything thrown that is not an HttpError is reported as a generic 500, so
 * internal details never reach the browser.
 */
export class HttpError extends Error {
  readonly status: number;
  /** Machine-readable code recorded in the audit log. */
  readonly code: string;

  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message = 'The request could not be processed.', code = 'bad_request') =>
  new HttpError(400, message, code);

export const unauthorized = (message = 'You need to sign in to continue.', code = 'unauthorized') =>
  new HttpError(401, message, code);

export const forbidden = (message = 'You do not have access to this resource.', code = 'forbidden') =>
  new HttpError(403, message, code);

export const notFound = (message = 'The page you requested does not exist.', code = 'not_found') =>
  new HttpError(404, message, code);

export const conflict = (message = 'That change conflicts with the current state.', code = 'conflict') =>
  new HttpError(409, message, code);
