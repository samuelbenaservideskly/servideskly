import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { settings } from '../settings/index.js';
import { asyncHandler } from '../lib/async-handler.js';
import { audit, auditRequest } from '../lib/audit.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { confirmRegistration, pendingRegistration, registrationOffered, registrationProblems, startRegistration } from '../auth/registration.js';
import { minPasswordLength, passwordProblems, passwordRules, personOf } from '../auth/password.js';
import { accountForResetToken, completePasswordReset, passwordResetOffered, requestPasswordReset } from '../auth/password-reset.js';
import { logger } from '../lib/logger.js';
import { randomToken, safeRedirectPath } from '../lib/util.js';
import {
  clearBindingCookie,
  consumeAuthRequest,
  createAuthRequest,
  setBindingCookie,
  verifyBinding,
} from '../auth/flow-state.js';
import {
  buildAuthorizationUrl,
  createPkcePair,
  endSessionUrl,
  configuredProviders,
  isProviderKey,
  authorizationOrigins,
  providerConfig,
  providerLabel,
  exchangeCode,
  identityFromClaims,
  profileDetails,
  signOutRedirectUri,
  verifyIdToken,
} from '../auth/oidc.js';
import { linkCandidate, linkToProvider, provisionOnLogin, type DirectoryIdentity } from '../auth/provisioning.js';
import { setLocalPassword, verifyLocalSignIn } from '../auth/local-accounts.js';
import { accessDecision, codeSignInAllowed } from '../auth/conditional-access.js';
import { findUserById } from '../services/users.js';
import { allowOwnScripts } from '../middleware/security.js';
import { promoteIfListed } from '../auth/portal-admins.js';
import {
  codeSignInOffered,
  emailSignsInWithCode,
  requestCodeFor,
  requestSignInCode,
  verifyCodeFor,
  verifySignInCode,
} from '../auth/sign-in-codes.js';
import { HttpError } from '../lib/errors.js';
import { destroySession, regenerateSession, saveSession } from '../middleware/session.js';
import { rotateCsrfToken } from '../middleware/csrf.js';
import { allowFormActionTo, callbackLimiter, loginLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import type { UserRow, UserSource } from '../services/users.js';
import { hasAuthenticator, useAuthenticatorCode } from '../auth/authenticator.js';

const log = logger.child({ module: 'routes/auth' });

export const authRouter = Router();

/** What a provider sign-in leaves on the session: which provider, and what sign-out hands back. */
type IdpSession = { sessionIndex?: string; nameId?: string; nameIdFormat?: string; provider?: string; idToken?: string; loginHint?: string };

/**
 * Establishes the browser session for a verified identity.
 *
 * Order matters here: provisioning (which may refuse the account) happens
 * before any session is issued, and the session id is regenerated before the
 * user id is written into it, which closes the session-fixation window.
 */
async function completeLogin(
  req: Request,
  res: Response,
  identity: DirectoryIdentity,
  source: UserSource,
  redirectTo: string | null,
  idpSession?: IdpSession,
): Promise<void> {
  // A password account with this address: ask for its password once, then connect.
  if (source === 'jit' && idpSession?.provider) {
    const candidate = await linkCandidate(identity);
    if (candidate) {
      req.session.linkPending = { userId: candidate.id, identity, redirectTo, provider: idpSession.provider, idToken: idpSession.idToken, loginHint: idpSession.loginHint, at: Date.now() };
      await saveSession(req);
      res.redirect('/login/link');
      return;
    }
  }
  const { user, created } = await provisionOnLogin(identity, source);
  await establishSession(req, res, user, created, source, redirectTo, idpSession);
}

/**
 * Issues the browser session for an already-provisioned account.
 *
 * Split out from completeLogin because the local administrator sign-in has
 * already established who the user is and has no directory identity to
 * provision. Callers must have authenticated and authorised the account first:
 * this function performs no checks of its own.
 */
async function establishSession(
  req: Request,
  res: Response,
  user: UserRow,
  created: boolean,
  source: UserSource,
  redirectTo: string | null,
  idpSession?: IdpSession,
): Promise<void> {
  // On the customer portal's list: an administrator from the first sign-in,
  // however the account arrived (a password, an identity provider).
  user = await promoteIfListed(user);
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.createdAt = Date.now();
  req.session.lastSeenAt = Date.now();
  rotateCsrfToken(req);
  if (idpSession?.sessionIndex) req.session.idpSessionIndex = idpSession.sessionIndex;
  if (idpSession?.nameId) req.session.idpNameId = idpSession.nameId;
  if (idpSession?.nameIdFormat) req.session.idpNameIdFormat = idpSession.nameIdFormat;
  // Set after regenerating: whatever was on the old session is gone.
  if (idpSession?.provider) req.session.idpProvider = idpSession.provider;
  if (idpSession?.idToken) req.session.idpIdToken = idpSession.idToken;
  if (idpSession?.loginHint) req.session.idpLoginHint = idpSession.loginHint;
  await saveSession(req);

  clearBindingCookie(res);

  log.info({ userId: user.id, role: user.role, created, source }, 'sign-in succeeded');
  audit({
    action: 'auth.login.success',
    actorId: user.id,
    actorEmail: user.email,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    detail: { source, role: user.role, provisioned: created },
  });

  res.redirect(safeRedirectPath(redirectTo, '/home'));
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

authRouter.get(
  '/login',
  asyncHandler(async (req, res) => {
    // Signed in, the sign-in page has nothing to offer - except to an
    // administrator previewing it in the portal editor's frame.
    const previewing = req.currentUser?.role === 'admin' && typeof req.query.portalFrame === 'string';
    if (req.currentUser && !previewing) {
      res.redirect('/home');
      return;
    }
    const returnTo = safeRedirectPath(req.query.returnTo, '/home');
    // Back from the password or code page: offer the address again.
    const email = req.query.change === '1' ? (req.session.signinEmail ?? req.session.otpEmail ?? '') : '';
    if (req.query.change === '1') {
      delete req.session.signinEmail;
      delete req.session.otpEmail;
    }
    // "Sign in with ..." posts here and is redirected to the provider; the
    // page's form-action has to allow that redirect (allowFormActionTo).
    allowFormActionTo(res, await authorizationOrigins());
    res.render('login', {
      title: 'Sign in',
      returnTo,
      // Off under Settings - Users - Local users: the form is not drawn at all.
      // Any password account - not only break-glass, which a hosted helpdesk no
      // longer has; its administrators set passwords from the portal's link.
      localAdminAvailable: settings().localAccounts.signInEnabled,
      ssoConfigured: settings().anySsoConfigured,
      // One button per identity provider that can sign people in.
      providers: configuredProviders().map((key) => ({ key, label: providerLabel(key) })),
      email,
      expired: req.query.expired === '1',
      disabled: req.query.disabled === '1',
      signedOut: req.query.signedOut === '1',
      registrationOffered: await registrationOffered(),
    });
  }),
);

// ---------------------------------------------------------------------------
// Start single sign-on
// ---------------------------------------------------------------------------

authRouter.post(
  '/auth/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectTo = safeRedirectPath(body.returnTo, '/home');
    // Which identity provider: Entra ID when a form does not say, as before
    // there were several.
    const provider = isProviderKey(body.provider) ? body.provider : 'entra';

    // An unconfigured provider fails closed here rather than bouncing the
    // user to a half-built authorization request.
    if (!providerConfig(provider).configured) {
      log.warn({ provider }, 'sign-in attempted with an identity provider that is not configured');
      throw badRequest(
        'Single sign-on has not been configured yet. An administrator must complete ' +
          'the setup under Settings - Integrations.',
        'sso_not_configured',
      );
    }

    {
      const pkce = createPkcePair();
      const nonce = randomToken(24);
      const flow = await createAuthRequest({
        kind: 'oidc',
        provider,
        nonce,
        codeVerifier: pkce.verifier,
        redirectTo,
      });
      setBindingCookie(res, flow.bindingSecret, 'oidc');
      let url: string;
      try {
        url = await buildAuthorizationUrl({
          provider,
          state: flow.id,
          nonce,
          codeChallenge: pkce.challenge,
        });
      } catch (err) {
        // Only discovery happens here, so any failure - an error answer
        // included - means the provider's discovery document could not be
        // read, or is not one we trust. The reason is for the log and the
        // settings page; the person signing in gets a page that says what to
        // do, not a 500 (reported 18 Oct 2026: an issuer with the discovery
        // path pasted in).
        log.warn({ provider, err: (err as Error).message }, 'identity provider discovery failed');
        throw new HttpError(
          503,
          'Signing in with ' + providerLabel(provider) + ' is not available right now. Try again later, or ask an ' +
            'administrator to check it under Settings - Integrations.',
          'idp_unavailable',
        );
      }
      res.redirect(url);
      return;
    }

    // Unreachable: OpenID Connect is the only single sign-on method. Kept so
    // a future one cannot silently fall through to a successful response.
    throw badRequest('That sign-in method is not available.', 'unknown_auth_mode');
  }),
);

// ---------------------------------------------------------------------------
// OIDC / OAuth2 authorization code callback
// ---------------------------------------------------------------------------

const oidcCallbackQuery = z.object({
  code: z.string().min(1).max(8192).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(2000).optional(),
});

authRouter.get(
  '/auth/oidc/callback',
  callbackLimiter,
  asyncHandler(async (req, res) => {
    const parsed = oidcCallbackQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest('The sign-in response was malformed.', 'bad_callback');
    const { code, state, error } = parsed.data;

    if (error) {
      // error_description is attacker-influenceable; log it, never render it.
      log.warn({ error, description: parsed.data.error_description }, 'identity provider returned an error');
      auditRequest(req, {
        action: 'auth.login.failed',
        outcome: 'failure',
        detail: { stage: 'authorization', error },
      });
      throw unauthorized('Sign-in was not completed. Please try again.', 'idp_error');
    }

    if (!code || !state) throw badRequest('The sign-in response was incomplete.', 'bad_callback');

    // Single-use: a replayed callback finds the state already consumed.
    const flow = await consumeAuthRequest(state, 'oidc');
    if (!flow || !flow.code_verifier || !flow.nonce) {
      log.warn('OIDC state unknown, expired or already used');
      auditRequest(req, {
        action: 'auth.login.failed',
        outcome: 'failure',
        detail: { stage: 'state', reason: 'unknown_or_replayed' },
      });
      throw unauthorized('Your sign-in attempt expired. Please try again.', 'invalid_state');
    }

    // Proves this browser is the one that started the flow (login CSRF).
    if (!verifyBinding(req, flow)) {
      log.warn('OIDC binding cookie missing or mismatched');
      auditRequest(req, {
        action: 'auth.login.failed',
        outcome: 'failure',
        detail: { stage: 'binding', reason: 'binding_mismatch' },
      });
      throw unauthorized('Your sign-in attempt could not be verified. Please try again.', 'binding_mismatch');
    }

    const provider = isProviderKey(flow.provider) ? flow.provider : 'entra';
    const tokens = await exchangeCode(code, flow.code_verifier, provider);
    const claims = await verifyIdToken(tokens.id_token as string, flow.nonce, provider);
    const fromToken = identityFromClaims(claims);
    // The directory's own details win over the token's: Graph and userinfo
    // are read now, the token may carry what was true when it was configured.
    const identity = { ...fromToken, ...(await profileDetails(provider, tokens.access_token, claims.sub)) };

    // Remembered on the new session for sign-out, which ends that provider's
    // session too: the ID token is Okta's (and most others') proof of which
    // session, login_hint Entra's. A token too large to keep is not kept.
    const idToken = tokens.id_token as string;
    await completeLogin(req, res, identity, 'jit', flow.redirect_to, {
      provider,
      ...(idToken.length <= 8000 ? { idToken } : {}),
      ...(typeof claims.login_hint === 'string' && claims.login_hint.length <= 1000 ? { loginHint: claims.login_hint } : {}),
    });
  }),
);

// ---------------------------------------------------------------------------
// Local break-glass administrator
// ---------------------------------------------------------------------------

const localLoginBody = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200),
  returnTo: z.string().max(512).optional(),
});

const codeRequestBody = z.object({
  email: z.string().trim().min(1).max(320),
  returnTo: z.string().max(512).optional(),
});

const identifyBody = z.object({
  email: z.string().trim().min(3).max(320),
  returnTo: z.string().max(512).optional(),
});

/**
 * Step one of signing in: the address. A code account is sent its code and
 * goes to the code page; everybody else - including an address with no
 * account at all, so this cannot be used to find out who has one - goes on
 * to the password page.
 */
authRouter.post(
  '/auth/local/identify',
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    if (!settings().localAccounts.signInEnabled) {
      throw forbidden('Signing in with a password is turned off.', 'local_signin_disabled');
    }
    const parsed = identifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.redirect('/login');
      return;
    }
    const email = parsed.data.email;
    const returnTo = safeRedirectPath(parsed.data.returnTo, '/home');
    if (await emailSignsInWithCode(email)) {
      await requestSignInCode(email, req.ip ?? null);
      req.session.otpEmail = email;
      req.session.otpReturnTo = returnTo;
      await saveSession(req);
      res.redirect('/login/code');
      return;
    }
    req.session.signinEmail = email;
    req.session.signinReturnTo = returnTo;
    await saveSession(req);
    res.redirect('/login/password');
  }),
);

async function renderPasswordPage(req: Request, res: Response, error: string | null, status?: number): Promise<void> {
  if (status) res.status(status);
  res.render('login-password', {
    title: 'Enter your password',
    email: req.session.signinEmail ?? '',
    returnTo: req.session.signinReturnTo ?? '/home',
    error,
    resetOffered: await passwordResetOffered(),
    justReset: req.query.reset === '1',
    justCreated: req.query.created === '1',
  });
}

// ---------------------------------------------------------------------------
// Create an account (auth/registration.ts) - only while switched on
// ---------------------------------------------------------------------------

const registerBody = z.object({
  firstName: z.string().max(100).default(''),
  lastName: z.string().max(100).default(''),
  email: z.string().max(320).default(''),
  password: z.string().max(200).default(''),
  confirm: z.string().max(200).default(''),
});

function renderRegister(res: Response, values: Record<string, string>, errors: Record<string, string>, status = 200): void {
  res.status(status).render('login-register', {
    title: 'Create an account',
    values,
    errors,
    sent: false,
    minLength: minPasswordLength(),
    domains: settings().localAccounts.registration?.domains ?? [],
  });
}

authRouter.get(
  '/register',
  asyncHandler(async (req, res) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    if (!(await registrationOffered())) throw notFound();
    if (req.query.sent === '1') {
      res.render('login-register', { title: 'Check your email', values: {}, errors: {}, sent: true, minLength: minPasswordLength(), domains: [] });
      return;
    }
    renderRegister(res, {}, {});
  }),
);

authRouter.post(
  '/auth/register',
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    if (!(await registrationOffered())) throw notFound();
    const parsed = registerBody.safeParse(req.body ?? {});
    const data = parsed.success ? parsed.data : { firstName: '', lastName: '', email: '', password: '', confirm: '' };
    const values = { firstName: data.firstName, lastName: data.lastName, email: data.email };
    const errors = registrationProblems(data);
    if (!errors.password && data.password !== data.confirm) errors.confirm = 'The two passwords are not the same.';
    if (Object.keys(errors).length > 0) {
      renderRegister(res, values, errors, 400);
      return;
    }
    // The same answer for every address.
    await startRegistration(data, req.ip ?? null);
    res.redirect('/register?sent=1');
  }),
);

authRouter.get(
  '/register/confirm/:token',
  asyncHandler(async (req, res) => {
    const pending = await pendingRegistration(req.params.token ?? '');
    res.status(pending ? 200 : 404).render('login-register-confirm', {
      title: 'Confirm your account',
      token: req.params.token,
      email: pending?.email ?? '',
      valid: Boolean(pending),
    });
  }),
);

authRouter.post(
  '/register/confirm/:token',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const user = await confirmRegistration(req.params.token ?? '', req.ip ?? null);
    if (!user) {
      res.status(404).render('login-register-confirm', { title: 'Confirm your account', token: '', email: '', valid: false });
      return;
    }
    req.session.signinEmail = user.email;
    await saveSession(req);
    res.redirect('/login/password?created=1');
  }),
);

// ---------------------------------------------------------------------------
// Forgot password (auth/password-reset.ts)
// ---------------------------------------------------------------------------

authRouter.get(
  '/login/forgot',
  asyncHandler(async (req, res) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    // Always reachable from the password page; with no way to send mail it
    // says who can help instead.
    res.render('login-forgot', {
      title: 'Reset your password',
      email: req.session.signinEmail ?? '',
      sent: req.query.sent === '1',
      noMail: !(await passwordResetOffered()),
    });
  }),
);

authRouter.post(
  '/auth/local/forgot',
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    const parsed = identifyBody.safeParse(req.body);
    if (!parsed.success || !(await passwordResetOffered())) {
      res.redirect('/login/forgot');
      return;
    }
    // The same answer for every address.
    await requestPasswordReset(parsed.data.email, req.ip ?? null);
    req.session.signinEmail = parsed.data.email;
    await saveSession(req);
    res.redirect('/login/forgot?sent=1');
  }),
);

const resetBody = z.object({ password: z.string().max(200), confirm: z.string().max(200) });

authRouter.get(
  '/login/reset/:token',
  asyncHandler(async (req, res) => {
    const user = await accountForResetToken(req.params.token ?? '');
    res.status(user ? 200 : 404).render('login-reset', {
      title: 'Choose a new password',
      token: req.params.token,
      email: user?.email ?? '',
      valid: Boolean(user),
      error: null,
      minLength: minPasswordLength(),
    });
  }),
);

authRouter.post(
  '/login/reset/:token',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const token = req.params.token ?? '';
    const user = await accountForResetToken(token);
    const again = (error: string) =>
      res.status(user ? 400 : 404).render('login-reset', {
        title: 'Choose a new password', token, email: user?.email ?? '', valid: Boolean(user), error, minLength: minPasswordLength(),
      });
    if (!user) {
      again('This link has expired or was already used.');
      return;
    }
    const parsed = resetBody.safeParse(req.body);
    if (!parsed.success) {
      again('Enter the new password twice.');
      return;
    }
    const problems = passwordProblems(parsed.data.password, personOf(user)).map((p) => p.message);
    if (problems.length) {
      again(problems.join(' '));
      return;
    }
    if (parsed.data.password !== parsed.data.confirm) {
      again('The two passwords are not the same.');
      return;
    }
    if (!(await completePasswordReset(token, parsed.data.password, req.ip ?? null))) {
      again('This link has expired or was already used.');
      return;
    }
    req.session.signinEmail = user.email;
    await saveSession(req);
    res.redirect('/login/password?reset=1');
  }),
);

/** An administrator looking at a sign-in step in the portal editor's frame. */
function previewingStep(req: Request): boolean {
  return req.currentUser?.role === 'admin' && typeof req.query.portalFrame === 'string';
}

// ---------------------------------------------------------------------------
// Connecting a password account to an identity provider (provisioning.ts)
// ---------------------------------------------------------------------------

const LINK_TTL_MS = 10 * 60_000;

function linkPending(req: Request) {
  const p = req.session.linkPending;
  return p && Date.now() - p.at < LINK_TTL_MS ? p : undefined;
}

function renderLink(req: Request, res: Response, error: string | null, status = 200): void {
  const p = linkPending(req)!;
  res.status(status).render('login-link', {
    title: 'Connect your account',
    email: p.identity.email,
    provider: providerLabel(isProviderKey(p.provider ?? '') ? (p.provider as never) : 'entra'),
    error,
  });
}

authRouter.get('/login/link', asyncHandler(async (req: Request, res: Response) => {
  if (!linkPending(req)) return res.redirect('/login');
  renderLink(req, res, null);
}));

authRouter.post(
  '/login/link',
  loginLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const p = linkPending(req);
    if (!p) return res.redirect('/login');
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const account = await findUserById(p.userId);
    if (!account) return res.redirect('/login');
    try {
      // The same check as signing in with it: lockouts and refusals count.
      await verifyLocalSignIn(account.email, password);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403 || err.status === 429)) {
        return renderLink(req, res, err.status === 401 ? 'That password is not right.' : err.message, 400);
      }
      throw err;
    }
    await linkToProvider(account.id, p.identity);
    delete req.session.linkPending;
    await completeLogin(req, res, p.identity, 'jit', p.redirectTo, p.provider ? { provider: p.provider, idToken: p.idToken, loginHint: p.loginHint } : undefined);
  }),
);

authRouter.get('/login/password', asyncHandler(async (req: Request, res: Response) => {
  if (previewingStep(req)) {
    res.render('login-password', { title: 'Enter your password', email: 'name@example.com', returnTo: '/home', error: null, resetOffered: true });
    return;
  }
  if (req.currentUser) {
    res.redirect('/home');
    return;
  }
  if (!req.session.signinEmail) {
    res.redirect('/login');
    return;
  }
  await renderPasswordPage(req, res, null);
}));

/**
 * "Email me a sign-in code". The answer is the same whether or not the
 * address has an account, or signs in that way: the next page always says a
 * code is on its way if the address can use one.
 */
authRouter.post(
  '/auth/local/code',
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    if (!settings().localAccounts.signInEnabled || !codeSignInOffered()) {
      throw forbidden('Signing in with a code is turned off.', 'code_signin_disabled');
    }
    const parsed = codeRequestBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('Enter your email address.', 'bad_code_request');

    await requestSignInCode(parsed.data.email, req.ip ?? null);
    req.session.otpEmail = parsed.data.email;
    req.session.otpReturnTo = safeRedirectPath(parsed.data.returnTo, '/home');
    await saveSession(req);
    res.redirect('/login/code');
  }),
);

function renderCodePage(req: Request, res: Response, error: string | null, status?: number): void {
  if (status) res.status(status);
  res.render('login-code', { title: 'Enter your code', email: req.session.otpEmail ?? '', error });
}

/**
 * Step three: choosing a password, for an account that signed in with one
 * it has to replace.
 *
 * Reachable only with `mustChangeUserId` in the pre-auth session, which only
 * a correct password puts there. Nothing of the service desk is reachable
 * from here - there is no session yet - so the password cannot be left as it
 * was by navigating away. The script is the eye and the ticking rules; the
 * page says what is required without it.
 */
async function renderNewPasswordPage(
  req: Request,
  res: Response,
  error: string | null,
  status?: number,
): Promise<void> {
  const pending = req.session.mustChangeUserId
    ? await findUserById(req.session.mustChangeUserId)
    : undefined;
  if (!pending) {
    res.redirect('/login');
    return;
  }
  if (status) res.status(status);
  res.render('login-new-password', {
    title: 'Choose a password',
    email: pending.email,
    rules: passwordRules(),
    for: 'password',
    error,
  });
}

authRouter.get(
  '/login/new-password',
  allowOwnScripts(),
  asyncHandler(async (req: Request, res: Response) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    await renderNewPasswordPage(req, res, null);
  }),
);

authRouter.post(
  '/auth/local/new-password',
  loginLimiter,
  allowOwnScripts(),
  asyncHandler(async (req: Request, res: Response) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    const pendingId = req.session.mustChangeUserId;
    const pending = pendingId ? await findUserById(pendingId) : undefined;
    if (!pending || pending.status !== 'active') {
      res.redirect('/login');
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = typeof body.password === 'string' ? body.password : '';
    const confirm = typeof body.confirm === 'string' ? body.confirm : '';

    if (password !== confirm) {
      await renderNewPasswordPage(req, res, 'The two passwords are not the same.', 400);
      return;
    }
    const problems = passwordProblems(password, personOf(pending));
    if (problems.length > 0) {
      await renderNewPasswordPage(req, res, problems[0]!.message, 400);
      return;
    }

    // mustChange is cleared by setting it: this is the person's own password
    // now, not one somebody handed them.
    await setLocalPassword(pending.id, password, pending.id, { mustChange: false });
    audit({ action: 'local_account.password.changed', actorId: pending.id, actorEmail: pending.email });

    delete req.session.mustChangeUserId;
    const returnTo = req.session.mustChangeReturnTo ?? '/home';
    delete req.session.mustChangeReturnTo;

    await establishSession(req, res, pending, false, 'manual', returnTo);
  }),
);

/**
 * The second step: a code by email, after a correct password.
 *
 * Reachable only with `mfaUserId` in the pre-auth session, which only a
 * correct password puts there - so this page is not a way to ask for a code
 * for somebody else's account. The markup is the sign-in code page's, which
 * is the same six boxes and one input.
 */
async function renderVerifyPage(
  req: Request,
  res: Response,
  error: string | null,
  status?: number,
): Promise<void> {
  const pending = req.session.mfaUserId ? await findUserById(req.session.mfaUserId) : undefined;
  if (!pending) {
    res.redirect('/login');
    return;
  }
  if (status) res.status(status);
  res.render('login-verify', { title: 'Enter your code', email: pending.email, error });
}

authRouter.get(
  '/login/verify',
  asyncHandler(async (req: Request, res: Response) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    await renderVerifyPage(req, res, null);
  }),
);

authRouter.post(
  '/auth/local/verify',
  loginLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    const pending = req.session.mfaUserId ? await findUserById(req.session.mfaUserId) : undefined;
    if (!pending) {
      res.redirect('/login');
      return;
    }

    const code = typeof (req.body ?? {}).code === 'string' ? String(req.body.code) : '';
    try {
      await verifyCodeFor(pending, code);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 409 || err.status === 403)) {
        await renderVerifyPage(req, res, err.message, 400);
        return;
      }
      throw err;
    }

    delete req.session.mfaUserId;
    const returnTo = req.session.mfaReturnTo ?? '/home';
    delete req.session.mfaReturnTo;

    // A temporary password is replaced after the code, not instead of it.
    if (req.session.mfaMustChange) {
      delete req.session.mfaMustChange;
      req.session.mustChangeUserId = pending.id;
      req.session.mustChangeReturnTo = returnTo;
      res.redirect('/login/new-password');
      return;
    }

    await establishSession(req, res, pending, false, 'manual', returnTo);
  }),
);

/**
 * The authenticator app's code (or a recovery code), after a correct
 * password. Reachable only with `totpUserId` in the pre-auth session, which
 * only a correct password puts there. Five wrong codes and the password has
 * to be given again.
 */
const AUTHENTICATOR_TRIES = 5;

authRouter.get('/login/authenticator', asyncHandler(async (req: Request, res: Response) => {
  if (req.currentUser) {
    res.redirect('/home');
    return;
  }
  if (!req.session.totpUserId) {
    res.redirect('/login');
    return;
  }
  res.render('login-authenticator', { title: 'Enter the code from your app', error: null });
}));

authRouter.post(
  '/auth/local/authenticator',
  loginLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    const pending = req.session.totpUserId ? await findUserById(req.session.totpUserId) : undefined;
    if (!pending) {
      res.redirect('/login');
      return;
    }
    const typed = typeof (req.body ?? {}).code === 'string' ? String(req.body.code).slice(0, 40) : '';
    const used = await useAuthenticatorCode(pending.id, typed);
    if (!used) {
      const tries = (req.session.totpTries ?? 0) + 1;
      auditRequest(req, { action: 'auth.login.failed', outcome: 'failure', detail: { stage: 'authenticator' } });
      if (tries >= AUTHENTICATOR_TRIES) {
        delete req.session.totpUserId;
        delete req.session.totpTries;
        flash(req, 'error', 'Too many wrong codes. Sign in again.');
        res.redirect('/login');
        return;
      }
      req.session.totpTries = tries;
      res.status(400).render('login-authenticator', {
        title: 'Enter the code from your app',
        error: 'That code is not right. Type the one your app shows now.',
      });
      return;
    }
    if (used === 'recovery') {
      audit({ action: 'auth.authenticator.recovery_used', actorId: pending.id, actorEmail: pending.email });
    }

    const returnTo = req.session.totpReturnTo ?? '/home';
    const mustChange = req.session.totpMustChange;
    delete req.session.totpUserId;
    delete req.session.totpReturnTo;
    delete req.session.totpMustChange;
    delete req.session.totpTries;

    if (mustChange) {
      req.session.mustChangeUserId = pending.id;
      req.session.mustChangeReturnTo = returnTo;
      res.redirect('/login/new-password');
      return;
    }
    await establishSession(req, res, pending, false, 'manual', returnTo);
  }),
);

authRouter.get('/login/code', (req: Request, res: Response) => {
  if (previewingStep(req)) {
    res.render('login-code', { title: 'Enter your code', email: 'name@example.com', error: null });
    return;
  }
  if (req.currentUser) {
    res.redirect('/home');
    return;
  }
  if (!req.session.otpEmail) {
    res.redirect('/login');
    return;
  }
  renderCodePage(req, res, null);
});

authRouter.post(
  '/auth/local/code/verify',
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }
    const email = req.session.otpEmail;
    if (!email || !settings().localAccounts.signInEnabled) {
      res.redirect('/login');
      return;
    }
    const code = typeof (req.body as Record<string, unknown>)?.code === 'string' ? String(req.body.code) : '';
    let user;
    try {
      user = await verifySignInCode(email, code);
    } catch (err) {
      // A wrong code re-renders the form with the reason beside it, rather
      // than an error page that loses the address (trap 6).
      if (err instanceof HttpError && err.status === 409) {
        auditRequest(req, { action: 'auth.login.failed', outcome: 'failure', detail: { stage: 'code' } });
        renderCodePage(req, res, err.message, 400);
        return;
      }
      throw err;
    }

    // The code answers "who", and the ranges answer "from where": a code
    // account is exempt from a *second* code, never from the address rule.
    if (!codeSignInAllowed(user, req.ip)) {
      auditRequest(req, {
        action: 'auth.login.denied',
        outcome: 'failure',
        detail: { reason: 'address_not_allowed', stage: 'code' },
      });
      renderCodePage(req, res, 'Sign-in is not allowed from this network. Ask the service desk.', 403);
      return;
    }

    const returnTo = req.session.otpReturnTo ?? '/home';
    await establishSession(req, res, user, false, 'manual', returnTo);
  }),
);

/**
 * Password sign-in for the local administrator.
 *
 * Available in every AUTH_MODE, including when the identity provider is
 * misconfigured or unreachable - that is the entire point of the account. It
 * is rate limited by loginLimiter and locked out after repeated failures by
 * verifyLocalSignIn.
 */
authRouter.post(
  '/auth/local',
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (req.currentUser) {
      res.redirect('/home');
      return;
    }

    // Hiding the form is presentation; this is the rule. A password posted
    // here anyway is refused before it is even checked.
    if (!settings().localAccounts.signInEnabled) {
      throw forbidden('Signing in with a password is turned off.', 'local_signin_disabled');
    }

    const parsed = localLoginBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Enter both an email address and a password.', 'bad_local_login');
    }

    // An account that signs in with a code does not sign in with its
    // password too: one way in each, or the code adds nothing. Checked
    // before the password, which its owner may never have been told.
    if (await emailSignsInWithCode(parsed.data.email)) {
      flash(req, 'info', 'This account signs in with a code sent by email. Choose "Email me a sign-in code".');
      res.redirect('/login');
      return;
    }

    let verified: Awaited<ReturnType<typeof verifyLocalSignIn>>;
    try {
      verified = await verifyLocalSignIn(parsed.data.email, parsed.data.password);
    } catch (err) {
      // Through the two-step page: say it there, beside the password box.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403) && req.session.signinEmail) {
        req.session.signinEmail = parsed.data.email;
        await renderPasswordPage(req, res, err.message, err.status);
        return;
      }
      throw err;
    }
    const { user, mustChange } = verified;

    /*
     * Conditional access (Settings - Users - Other settings): this address
     * may be outside the ranges sign-in is allowed from, or the service
     * desk may ask every password account for a code.
     *
     * Checked **after** the password, so a refusal here says nothing a
     * wrong password would not have said; **before** the must-change step,
     * because a temporary password is still a password and a person who
     * may not sign in from here may not set one either (found by the owner
     * testing it, 16 Oct 2026); and before the session exists, so a second
     * step is a step rather than a message.
     */
    const decision = await accessDecision(user, req.ip);
    if (decision === 'refuse') {
      await renderPasswordPage(
        req,
        res,
        'Sign-in is not allowed from this network. Ask the service desk.',
        403,
      );
      return;
    }
    /*
     * An authenticator app (auth/authenticator.ts): its code is the second
     * step, and it answers conditional access's "a code" as well - one
     * second step, never two. Before the must-change step for the same
     * reason the emailed code is.
     */
    if (await hasAuthenticator(user.id)) {
      req.session.totpUserId = user.id;
      req.session.totpReturnTo = parsed.data.returnTo ?? '/home';
      req.session.totpMustChange = mustChange;
      req.session.totpTries = 0;
      res.redirect('/login/authenticator');
      return;
    }
    if (decision === 'code') {
      const sent = await requestCodeFor(user, req.ip ?? null);
      if (!sent) {
        // Nothing could send it, so the step cannot be taken. Refusing
        // would lock everybody out over a mailbox; saying so lets somebody
        // fix it, and the audit entry records that it happened.
        log.error({ userId: user.id }, 'a sign-in code was required but could not be sent');
        audit({
          action: 'auth.login.denied',
          outcome: 'failure',
          actorId: user.id,
          actorEmail: user.email,
          ip: req.ip ?? null,
          detail: { reason: 'code_required_but_unsendable' },
        });
        await renderPasswordPage(
          req,
          res,
          'This service desk asks for a code by email, and none could be sent. Ask the service desk.',
          503,
        );
        return;
      }
      req.session.mfaUserId = user.id;
      req.session.mfaReturnTo = parsed.data.returnTo ?? '/home';
      // Carried through the code step: a temporary password still has to be
      // replaced, after whoever is holding it has proved they may be here.
      req.session.mfaMustChange = mustChange;
      res.redirect('/login/verify');
      return;
    }

    /*
     * A password that has to change is not a way in.
     *
     * It used to sign the person in and send them to their profile with a
     * message, which meant a temporary password - one an administrator
     * emailed, or an import generated - reached the whole service desk
     * until somebody got round to changing it. Now the sign-in stops here:
     * the account is remembered in the pre-auth session, and the next step
     * sets the password and establishes the session (asked for 15 Oct 2026).
     */
    if (mustChange) {
      req.session.mustChangeUserId = user.id;
      req.session.mustChangeReturnTo = parsed.data.returnTo ?? '/home';
      res.redirect('/login/new-password');
      return;
    }

    await establishSession(req, res, user, false, 'manual', parsed.data.returnTo ?? '/home');
  }),
);

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

/** Which provider a session signed in through, or null for a password. */
function sessionProvider(req: import('express').Request): string | null {
  // A session from before providers were recorded was Entra ID's.
  const user = req.currentUser;
  if (!user) return null;
  return req.session.idpProvider ?? (user.issuer.startsWith('urn:helpdesk:') ? null : 'entra');
}

/**
 * Lets Sign out, on every page, lead to the provider's sign-out page.
 *
 * Sign out is a form, and /auth/logout answers with a redirect to the
 * provider - which `form-action 'self'` refused in Chrome, the same as
 * "Sign in with ..." once did. The session was gone but the page stayed, so
 * the button seemed to do nothing, and a second press failed its CSRF check
 * (reported 17 Oct 2026). Only a session that signed in through a provider
 * widens it, and only to that provider's sign-out origin.
 */
export function allowSignOutRedirect(): import('express').RequestHandler {
  return (req, res, next) => {
    const provider = sessionProvider(req);
    if (!provider || !isProviderKey(provider)) return next();
    endSessionUrl(signOutRedirectUri(), provider)
      .then((url) => {
        if (url) allowFormActionTo(res, [new URL(url).origin]);
        next();
      })
      .catch(() => next());
  };
}

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    const user = req.currentUser;


    if (user) {
      audit({
        action: 'auth.logout',
        actorId: user.id,
        actorEmail: user.email,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
    }

    // Which provider to sign out of, and how to name the session there,
    // read before the session is gone.
    const provider = sessionProvider(req);
    const hints = { idToken: req.session.idpIdToken, loginHint: req.session.idpLoginHint };

    // Terminate the local session first, so a failure to reach the identity
    // provider still leaves the user signed out here.
    await destroySession(req, res);

    // Ending the session at the identity provider too, so signing out here
    // does not leave a tenant session that silently signs them straight
    // back in. Falls back to the local landing page if it is unreachable.
    const url = provider && isProviderKey(provider) ? await endSessionUrl(signOutRedirectUri(), provider, hints) : null;
    res.redirect(url ?? '/login?signedOut=1');
  }),
);

/** Landing point for identity-provider-initiated logout redirects. */
authRouter.get(
  '/auth/logout/complete',
  asyncHandler(async (req, res) => {
    await destroySession(req, res);
    res.redirect('/login?signedOut=1');
  }),
);

