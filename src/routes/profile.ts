import { setOwnDetails, setOwnLanguage } from '../services/users.js';
import { enabledLanguages } from '../i18n/index.js';
import { applyAllRules } from '../services/user-groups.js';
import { applyAllTechnicianRules } from '../services/technician-rules.js';
import { settings, type SelfEditField } from '../settings/index.js';

/** The details a person may be allowed to change, in words. */
export const SELF_EDIT_LABELS: Record<SelfEditField, string> = { company: 'Company', department: 'Department', job_title: 'Job title', office: 'Office', phone: 'Phone' };
import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { forbidden } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { allowOwnScripts, loginLimiter, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { groupsForUser } from '../services/groups.js';
import { ticketActivityFor } from '../services/tickets.js';
import {
  isLocalAccount,
  isLocalAdmin,
  localAdminStatus,
  setLocalPassword,
  verifyLocalSignIn,
} from '../auth/local-accounts.js';
import { signsInWithCode } from '../auth/sign-in-codes.js';
import { sessionStore } from '../auth/session-store.js';
import {
  minPasswordLength,
  passwordPolicyText,
  passwordProblems,
  passwordRules,
  personOf,
} from '../auth/password.js';
import { availabilityRouter, availabilityView, tracksAvailability } from './availability.js';
/**
 * The signed-in user's own page: who the application thinks they are, where
 * that came from, and the one self-service action available - changing the
 * password, for any account that signs in with one (a local user or the
 * break-glass administrator). Directory accounts change theirs at the
 * directory; an account that signs in with an emailed code has none to change.
 */
export const profileRouter = Router();

profileRouter.use(requireAuth());

async function profileView(req: Request, extra: Record<string, unknown> = {}) {
  const user = req.currentUser;
  if (!user) throw forbidden();

  const local = isLocalAccount(user);
  const breakGlass = isLocalAdmin(user);
  // Independent reads, so they go together rather than in series.
  const [groups, activity, localAdmin, usesCode] = await Promise.all([
    groupsForUser(user.id),
    ticketActivityFor(user.id),
    breakGlass ? localAdminStatus() : Promise.resolve(null),
    local ? signsInWithCode(user) : Promise.resolve(false),
  ]);

  const availability = (await tracksAvailability(user)) ? await availabilityView(user.id, '/profile/availability', true) : null;

  return {
    title: 'Your profile',
    availability,
    user,
    groups,
    activity,
    isLocalAccount: local,
    isBreakGlass: breakGlass,
    usesSignInCode: usesCode,
    localAdmin,
    minPasswordLength: minPasswordLength(), passwordPolicy: passwordPolicyText(),
    // The rules, drawn by the server so they are there without the script.
    passwordRules: passwordRules(),
    problems: [] as string[],
    // The details this person may change themselves (Users - Other settings).
    selfEdit: settings().people.selfEdit,
    selfEditLabels: SELF_EDIT_LABELS,
    // The languages this service desk serves. The card is drawn only when
    // there is a choice to make.
    offeredLanguages: enabledLanguages().map((l) => ({ tag: l.tag, name: l.name })),
    ...extra,
  };
}

/** A person's own details, as far as an administrator allows. */
profileRouter.post(
  '/details',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = req.currentUser;
    if (!user) throw forbidden();
    const allowed = settings().people.selfEdit;
    if (allowed.length === 0) throw forbidden('Your details are kept by the service desk.', 'self_edit_off');
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const values = Object.fromEntries(allowed.map((f) => [f, typeof raw[f] === 'string' ? String(raw[f]) : undefined]));
    const changed = await setOwnDetails(user.id, values, allowed);
    // Group rules may read what changed.
    if (changed.length > 0) {
      await applyAllRules(user.id);
      await applyAllTechnicianRules(user.id);
    }
    flash(req, 'success', changed.length ? 'Your details are saved.' : 'Nothing changed.');
    res.redirect('/profile#details');
  }),
);

/**
 * The language this person reads the service desk in.
 *
 * Their own choice is the first rule and nothing overrides it - not their
 * group, not their browser (asked for 16 Oct 2026). "Follow my browser" is
 * the empty value, which puts them back in the hands of the rules.
 */
profileRouter.post(
  '/language',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = req.currentUser;
    if (!user) throw forbidden();
    const wanted = String((req.body as Record<string, unknown>)?.language ?? '');
    await setOwnLanguage(user.id, wanted, enabledLanguages().map((l) => l.tag));
    flash(req, 'success', 'Saved.');
    res.redirect('/profile#language');
  }),
);

profileRouter.get(
  '/',
  // The eye beside a password box, and the rules box ticking as it is
  // typed. Both are additions: the page works, and the password is still
  // checked on the server, with the script blocked. See allowOwnScripts.
  allowOwnScripts(),
  asyncHandler(async (req, res) => {
    res.render('profile', await profileView(req));
  }),
);

// Availability, for the Technician availability dashboard: their own.
profileRouter.use(
  '/availability',
  availabilityRouter({
    whose: async (req) => {
      if (!req.currentUser) throw forbidden();
      return req.currentUser;
    },
    back: () => '/profile',
  }),
);

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
  confirmPassword: z.string().min(1).max(200),
});

/**
 * Changes the signed-in password account's own password.
 *
 * The current password is required even though the caller is already signed in:
 * it stops someone who has taken over a session from quietly seizing the
 * permanent break-glass credential. loginLimiter throttles guessing here just
 * as it does on the sign-in form.
 */
profileRouter.post(
  '/password',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const user = req.currentUser;
    if (!user) throw forbidden();

    // Only a password account has one. Directory accounts change theirs at
    // the directory.
    if (!isLocalAccount(user)) {
      throw forbidden(
        'Your password is managed by your organisation directory, not here.',
        'not_a_local_account',
      );
    }

    const parsed = passwordBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .render(
          'profile',
          await profileView(req, {
            problems: ['Fill in your current password and the new password twice.'],
          }),
        );
      return;
    }

    if (parsed.data.newPassword !== parsed.data.confirmPassword) {
      res
        .status(400)
        .render('profile', await profileView(req, { problems: ['The two new passwords do not match.'] }));
      return;
    }

    const problems = passwordProblems(parsed.data.newPassword, req.currentUser ? personOf(req.currentUser) : {}).map((p) => p.message);
    if (problems.length > 0) {
      res.status(400).render('profile', await profileView(req, { problems }));
      return;
    }

    // Proves possession of the existing credential. A failure is audited and
    // counted towards the lockout, exactly like a failed sign-in.
    try {
      await verifyLocalSignIn(user.email, parsed.data.currentPassword);
    } catch {
      auditRequest(req, {
        action: (isLocalAdmin(user) ? 'local_admin' : 'local_account') + '.password.change_denied',
        outcome: 'failure',
        targetType: 'user',
        targetId: user.id,
        detail: { reason: 'current_password_incorrect' },
      });
      res
        .status(400)
        .render('profile', await profileView(req, { problems: ['Your current password is not correct.'] }));
      return;
    }

    await setLocalPassword(user.id, parsed.data.newPassword, user.id);

    /*
     * ...and every other session of theirs goes.
     *
     * Changing a password is how somebody answers "it may be known": a
     * laptop left signed in somewhere, or a password written down. Leaving
     * those sessions alive answers nothing. The session in hand is kept -
     * signing somebody out of the browser they just used would read as the
     * change having failed.
     */
    const ended = await sessionStore.destroyOthersForUser(user.id, req.sessionID);

    auditRequest(req, {
      action: (isLocalAdmin(user) ? 'local_admin' : 'local_account') + '.password.changed',
      targetType: 'user',
      targetId: user.id,
      detail: { via: 'profile', sessionsEnded: ended },
    });

    flash(
      req,
      'success',
      ended > 0
        ? 'Your password has been changed, and you were signed out everywhere else.'
        : 'Your password has been changed.',
    );
    res.redirect('/profile');
  }),
);
