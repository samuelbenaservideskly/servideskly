import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { normaliseLine } from '../lib/util.js';
import { writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { minPasswordLength, passwordPolicyText, generatePassword, passwordProblems, personOf } from '../auth/password.js';
import {
  createLocalAccount,
  deleteLocalAccount,
  isLocalAdmin,
  listLocalAccounts,
  normaliseUsername,
  setLocalPassword,
} from '../auth/local-accounts.js';
import { findUserById, setUserRole, setUserStatus } from '../services/users.js';
import { sessionStore } from '../auth/session-store.js';

/**
 * Administration of password accounts.
 *
 * Mounted under /admin, which has already required an administrator.
 *
 * Everything the running service needs in order to be used without an
 * identity provider is here: create an account, reset its password, change
 * its role, disable it. That is deliberate - a deployment that has not been
 * connected to Entra ID still has to be administrable from the UI.
 */
export const accountAdminRouter = Router();

const createBody = z.object({
  username: z.string().trim().min(2).max(32),
  displayName: z.string().trim().min(1, 'Give the account a display name.').max(120),
  email: z.string().trim().email('That is not a valid email address.').max(200).or(z.literal('')),
  role: z.enum(['user', 'agent', 'admin']),
  password: z.string().min(1, 'Set a password.').max(200),
});

const passwordBody = z.object({
  password: z.string().max(200).optional(),
});

const roleBody = z.object({ role: z.enum(['user', 'agent', 'admin']) });
const statusBody = z.object({ status: z.enum(['active', 'disabled']) });

async function renderList(
  res: { render: (view: string, locals: Record<string, unknown>) => void },
  extra: Record<string, unknown> = {},
) {
  res.render('admin/accounts', {
    title: 'Local accounts',
    accounts: await listLocalAccounts(),
    minPasswordLength: minPasswordLength(), passwordPolicy: passwordPolicyText(),
    suggestion: generatePassword(),
    values: {},
    errors: {},
    ...extra,
  });
}

accountAdminRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    await renderList(res);
  }),
);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

accountAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const candidate = {
      username: typeof raw.username === 'string' ? normaliseUsername(raw.username) : '',
      displayName: typeof raw.displayName === 'string' ? normaliseLine(raw.displayName) : '',
      email: typeof raw.email === 'string' ? normaliseLine(raw.email) : '',
      role: raw.role,
      password: typeof raw.password === 'string' ? raw.password : '',
    };

    const parsed = createBody.safeParse(candidate);
    const errors: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (!errors[key]) errors[key] = issue.message;
      }
    } else {
      const problems = passwordProblems(parsed.data.password, { email: parsed.data.email });
      if (problems.length > 0) errors.password = problems[0]!.message;
    }

    if (!parsed.success || Object.keys(errors).length > 0) {
      res.status(400);
      await renderList(res, { values: candidate, errors });
      return;
    }

    const created = await createLocalAccount(
      {
        displayName: parsed.data.displayName,
        email: parsed.data.email || parsed.data.username + '@local',
        seeded: !parsed.data.email,
        role: parsed.data.role,
        password: parsed.data.password,
        // The administrator chose it, so the owner is asked to replace it.
        mustChange: true,
      },
      req.currentUser?.id ?? null,
    );

    auditRequest(req, {
      action: 'local_account.created',
      targetType: 'user',
      targetId: created.id,
      detail: { username: parsed.data.username, role: parsed.data.role },
    });
    flash(req, 'success', 'Account "' + parsed.data.username + '" created.');
    res.redirect('/admin/accounts');
  }),
);

// ---------------------------------------------------------------------------
// Reset password
// ---------------------------------------------------------------------------

accountAdminRouter.post(
  '/:id/password',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = await findUserById(String(req.params.id));
    if (!user) throw notFound('That account no longer exists.');

    const parsed = passwordBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That password could not be read.');

    // An empty box means "generate one", which is the safer default.
    const password = parsed.data.password?.trim() ? parsed.data.password : generatePassword();
    const problems = passwordProblems(password, personOf(user));
    if (problems.length > 0) {
      flash(req, 'error', problems[0]!.message);
      res.redirect('/admin/accounts');
      return;
    }

    await setLocalPassword(user.id, password, req.currentUser?.id ?? null, { mustChange: true });

    // Every existing session for that account is now stale.
    await sessionStore.destroyForUser(user.id);

    auditRequest(req, {
      action: 'local_account.password.reset',
      targetType: 'user',
      targetId: user.id,
    });
    flash(
      req,
      'success',
      'Password for ' + user.display_name + ' is now: ' + password +
        ' - give it to them and ask them to change it. It is not shown again.',
    );
    res.redirect('/admin/accounts');
  }),
);

// ---------------------------------------------------------------------------
// Role and status
// ---------------------------------------------------------------------------

accountAdminRouter.post(
  '/:id/role',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = await findUserById(String(req.params.id));
    if (!user) throw notFound('That account no longer exists.');
    if (isLocalAdmin(user)) {
      throw forbidden(
        'The break-glass administrator keeps its role; it is what guarantees the service stays administrable.',
        'local_admin_protected',
      );
    }

    const parsed = roleBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That is not a role this service has.');

    await setUserRole(user.id, parsed.data.role, true);
    auditRequest(req, {
      action: 'user.role.changed',
      targetType: 'user',
      targetId: user.id,
      detail: { from: user.role, to: parsed.data.role },
    });
    flash(req, 'success', user.display_name + ' is now ' + parsed.data.role + '.');
    res.redirect('/admin/accounts');
  }),
);

accountAdminRouter.post(
  '/:id/status',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = await findUserById(String(req.params.id));
    if (!user) throw notFound('That account no longer exists.');
    if (isLocalAdmin(user)) {
      throw forbidden(
        'The break-glass administrator cannot be disabled.',
        'local_admin_protected',
      );
    }

    const parsed = statusBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That is not a status this service has.');

    await setUserStatus(user.id, parsed.data.status);
    if (parsed.data.status === 'disabled') await sessionStore.destroyForUser(user.id);

    auditRequest(req, {
      action: 'user.status.changed',
      targetType: 'user',
      targetId: user.id,
      detail: { to: parsed.data.status },
    });
    flash(req, 'success', user.display_name + ' is now ' + parsed.data.status + '.');
    res.redirect('/admin/accounts');
  }),
);

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

accountAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = await findUserById(String(req.params.id));
    if (!user) throw notFound('That account no longer exists.');

    await deleteLocalAccount(user.id, req.currentUser?.id ?? null);
    await sessionStore.destroyForUser(user.id);

    flash(req, 'success', user.display_name + ' removed.');
    res.redirect('/admin/accounts');
  }),
);
