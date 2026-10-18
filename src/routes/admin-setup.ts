/**
 * /setup?t=... - an administrator the customer portal added chooses their
 * password (auth/portal-admins.ts sends the link).
 *
 * The link is signed with this helpdesk's key (auth/setup-token.ts) and names
 * one address; it works only while the portal still lists that address, and
 * only until the account exists. Somebody who signs in through an identity
 * provider never needs it, and is told so if they open it.
 */
import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { HttpError } from '../lib/errors.js';
import { allowOwnScripts, loginLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { createLocalAccount, isLocalAccount } from '../auth/local-accounts.js';
import { minPasswordLength, passwordPolicyText, passwordProblems, passwordRules } from '../auth/password.js';
import { verifySetupToken } from '../auth/setup-token.js';
import { isPortalAdmin } from '../auth/portal-admins.js';
import { findUserByEmail } from '../services/users.js';

export const adminSetupRouter = Router();

type Response = import('express').Response;
type Request = import('express').Request;

function render(res: Response, status: number, locals: Record<string, unknown>): void {
  res.status(status).render('admin-setup', {
    title: 'Set up your password',
    email: '',
    token: '',
    error: null,
    done: false,
    directory: false,
    invalid: false,
    minPasswordLength: minPasswordLength(), passwordPolicy: passwordPolicyText(),
    // The rules box, ticking as the password is typed (password-reveal.js).
    rules: passwordRules(),
    for: 'password',
    ...locals,
  });
}

function toSignIn(req: Request, res: Response, email: string): void {
  flash(req, 'success', 'Your account is ready. Sign in with ' + email + '.');
  res.redirect(303, '/login');
}

/** The address a link may still set up, or why not. */
async function standing(token: unknown): Promise<{ email: string } | { page: Record<string, unknown>; status: number }> {
  const claims = verifySetupToken(token);
  if (!claims || !isPortalAdmin(claims.email)) return { page: { invalid: true }, status: 400 };
  const user = await findUserByEmail(claims.email);
  if (user) return { page: isLocalAccount(user) ? { done: true, email: claims.email } : { directory: true, email: claims.email }, status: 200 };
  return { email: claims.email };
}

adminSetupRouter.get(
  '/setup',
  allowOwnScripts(),
  asyncHandler(async (req, res) => {
    const s = await standing(req.query.t);
    if ('page' in s) return render(res, s.status, s.page);
    render(res, 200, { email: s.email, token: String(req.query.t) });
  }),
);

adminSetupRouter.post(
  '/setup',
  loginLimiter,
  allowOwnScripts(),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const s = await standing(body.t);
    if ('page' in s) {
      // Done already - usually the second of a double-click: send it to sign in.
      if (s.page.done) return toSignIn(req, res, String(s.page.email));
      return render(res, s.status, s.page);
    }
    const token = String(body.t);
    const password = typeof body.password === 'string' ? body.password : '';
    const confirm = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
    const problems = passwordProblems(password, { email: s.email }).map((p) => p.message);
    if (password !== confirm) problems.unshift('The two passwords do not match.');
    if (problems.length > 0) return render(res, 400, { email: s.email, token, error: problems[0] });

    let user;
    try {
      user = await createLocalAccount(
        { displayName: s.email.split('@')[0] || s.email, email: s.email, role: 'admin', password },
        null,
      );
    } catch (err) {
      // Two requests at once (a double-click): the other one made it - by
      // the check (409) or, a moment later, by the unique index.
      if ((err instanceof HttpError && err.status === 409) || (await findUserByEmail(s.email))) return toSignIn(req, res, s.email);
      throw err;
    }
    auditRequest(req, { action: 'portal.admin.password_set', targetType: 'user', targetId: user.id, detail: { email: s.email } });
    toSignIn(req, res, s.email);
  }),
);
