import type { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';

/**
 * Turning a refused write back into a form, rather than an error page.
 *
 * The services refuse by throwing - `conflict('A group with that name already
 * exists.')` and so on - which the error handler renders as a standalone 409
 * page. That is right for an API and wrong for a browser: the person loses
 * everything they typed and has to find their way back to the form to read
 * what was wrong with it.
 *
 * So a route wraps its write in `attempt()`, gets the message back as a field
 * error, and re-renders the form it already knows how to render.
 *
 * Only refusals *about the submitted values* are converted. Anything else -
 * a 403, a 500, a bug - still becomes a page, because re-rendering a form is
 * not an answer to "you may not do this" or "something broke".
 */

export type FieldErrors = Record<string, string>;

export type Attempt<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

/**
 * Which input each refusal belongs against.
 *
 * Anything not listed lands on `form`, shown above the fields - correct for a
 * refusal that is about the combination rather than one value ("a task cannot
 * carry tasks of its own"), and a safe default for a code added later.
 */
const CONFLICT_FIELD: Record<string, string> = {
  group_name_taken: 'name',
  category_name_taken: 'name',
  template_name_taken: 'name',
  portal_name_taken: 'name',
  invalid_username: 'username',
  username_taken: 'username',
  email_taken: 'email',
  invalid_email: 'email',
  bad_manager: 'managerId',
  image_name_taken: 'name',
  notification_name_taken: 'name',
  location_exists: 'name',
  automation_name_taken: 'name',
  connection_name_taken: 'name',
  connection_certificate: 'clientCert',
  mail_rule_name_taken: 'name',
  field_options_required: 'options',
  custom_field_label_taken: 'label',
};

/** Statuses that mean "what you submitted cannot be accepted". */
const ABOUT_THE_INPUT = new Set([400, 404, 409]);

/** Collects a zod failure into one message per field, first one winning. */
export function issueErrors(error: ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

/**
 * Runs a write, converting a refusal about the input into field errors.
 *
 * Rethrows everything else untouched, so the error page keeps its job.
 */
export async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof HttpError && ABOUT_THE_INPUT.has(error.status)) {
      return { ok: false, errors: { [CONFLICT_FIELD[error.code] ?? 'form']: error.message } };
    }
    throw error;
  }
}
