import './env-fresh.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { query, execute } from '../src/db/index.js';
import {
  LOCAL_EMAIL,
  ensureLocalAdmin,
  findLocalAdmin,
  isLocalAdmin,
  localAdminStatus,
  randomBreakGlassEmail,
  setLocalAdminPassword,
  verifyLocalSignIn,
} from '../src/auth/local-accounts.js';
import { cannotEnableCodes } from '../src/auth/sign-in-codes.js';
import {
  generatePassword,
  hashPassword,
  needsRehash,
  passwordProblems,
  verifyPassword,
} from '../src/auth/password.js';
import { HttpError } from '../src/lib/errors.js';
import { signInAs } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';

let app: Express;
const KNOWN_PASSWORD = 'A-long-enough-test-passphrase-1';

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

/** Clears any lockout left behind by a previous test. */
async function unlock(): Promise<void> {
  const user = await findLocalAdmin();
  assert.ok(user);
  await execute(
    'UPDATE local_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?',
    [user.id],
  );
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  await ensureLocalAdmin();
  await setLocalAdminPassword(KNOWN_PASSWORD, null);
});

describe('a hosted helpdesk\'s break-glass address', () => {
  test('is random on both sides, and never the same twice', () => {
    const a = randomBreakGlassEmail();
    assert.match(a, /^[a-z0-9]{12}@[a-z0-9]{12}\.invalid$/);
    assert.notEqual(a, randomBreakGlassEmail());
  });

  test('receives no mail, so it gets no sign-in codes - like admin@local', async () => {
    assert.match((await cannotEnableCodes(true, randomBreakGlassEmail())) ?? '', /./);
    assert.match((await cannotEnableCodes(true, LOCAL_EMAIL)) ?? '', /./);
  });
});

describe('password hashing', () => {
  test('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  test('stores parameters and a per-password salt, never a bare digest', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    assert.notEqual(a, b, 'identical passwords must not produce identical hashes');
    assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$\d+\$/);
    assert.doesNotMatch(a, /same password/);
    assert.equal(needsRehash(a), false);
  });

  test('treats a malformed or tampered record as a failure, not an error', async () => {
    assert.equal(await verifyPassword('x', 'garbage'), false);
    assert.equal(await verifyPassword('x', 'scrypt????$AA$AA'), false);
    // Absurd parameters must be refused rather than exhausting memory.
    assert.equal(await verifyPassword('x', 'scrypt????$AA$AA'), false);
    assert.equal(needsRehash('garbage'), true);
  });

  test('generates a long random password', async () => {
    const first = generatePassword();
    assert.ok(first.length >= 30);
    assert.notEqual(first, generatePassword());
  });

  test('rejects weak passwords', async () => {
    assert.ok(passwordProblems('short').length > 0);
    assert.ok(passwordProblems('mypassword123456').some((p) => /obvious word/.test(p.message)));
    assert.ok(passwordProblems('  padded passphrase  ').some((p) => /space/.test(p.message)));
    assert.deepEqual(passwordProblems('A perfectly fine passphrase-1'), []);
  });
});

describe('the local administrator account', () => {
  test('exists with a locked administrator role', async () => {
    const user = await findLocalAdmin();
    assert.ok(user, 'the account should have been created at startup');
    assert.equal(user.role, 'admin');
    assert.equal(user.role_locked, true, 'so no mapping or sync can demote it');
    assert.equal(user.status, 'active');
    // 'local' keeps it out of the directory sync deprovisioning sweep, which
    // only touches accounts sourced from 'sync' or 'jit'.
    assert.equal(user.source, 'local');
    assert.equal(isLocalAdmin(user), true);
  });

  test('is created only once', async () => {
    const before = await findLocalAdmin();
    await ensureLocalAdmin();
    const after = await findLocalAdmin();
    assert.equal(after?.id, before?.id, 'a second call must not replace the account');
  });

  test('is not treated as a directory account', async () => {
    const user = await findLocalAdmin();
    assert.ok(user);
    assert.equal(user.issuer, 'urn:helpdesk:local');
    assert.doesNotMatch(user.issuer, /microsoftonline/);
  });
});

describe('local sign-in', () => {
  test('accepts the correct password, by email in any case', async () => {
    await unlock();
    const byEmail = await verifyLocalSignIn(LOCAL_EMAIL, KNOWN_PASSWORD);
    assert.equal(byEmail.user.role, 'admin');
    assert.equal(byEmail.mustChange, false, 'the password was set explicitly');

    const shouted = await verifyLocalSignIn(LOCAL_EMAIL.toUpperCase(), KNOWN_PASSWORD);
    assert.equal(shouted.user.id, byEmail.user.id);

    // The old short name is gone with usernames.
    await assert.rejects(() => verifyLocalSignIn('admin', KNOWN_PASSWORD));
  });

  test('rejects a wrong password', async () => {
    await unlock();
    await assert.rejects(
      () => verifyLocalSignIn(LOCAL_EMAIL, 'not-the-password'),
      (err: unknown) => err instanceof HttpError && err.status === 401,
    );
  });

  test('rejects an unknown address with the same message', async () => {
    await unlock();
    await assert.rejects(
      () => verifyLocalSignIn('someone.else@example.com', KNOWN_PASSWORD),
      (err: unknown) =>
        err instanceof HttpError && err.code === 'local_signin_failed',
    );
  });

  test('locks the account after repeated failures, then releases it', async () => {
    await unlock();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(() => verifyLocalSignIn(LOCAL_EMAIL, 'wrong-' + attempt));
    }

    // Now locked: even the correct password is refused.
    await assert.rejects(
      () => verifyLocalSignIn(LOCAL_EMAIL, KNOWN_PASSWORD),
      (err: unknown) => err instanceof HttpError && err.code === 'local_locked_out',
    );
    assert.ok((await localAdminStatus()).lockedUntil, 'a lockout deadline should be recorded');

    await unlock();
    const ok = await verifyLocalSignIn(LOCAL_EMAIL, KNOWN_PASSWORD);
    assert.ok(ok.user);
  });

  test('a successful sign-in clears the failure counter', async () => {
    await unlock();
    await assert.rejects(() => verifyLocalSignIn(LOCAL_EMAIL, 'wrong'));
    assert.equal((await localAdminStatus()).failedAttempts, 1);

    await verifyLocalSignIn(LOCAL_EMAIL, KNOWN_PASSWORD);
    assert.equal((await localAdminStatus()).failedAttempts, 0);
    assert.equal((await localAdminStatus()).lockedUntil, null);
  });

  test('every attempt is audited', async () => {
    const actions = (
      await query<{ action: string }>(
        "SELECT DISTINCT action FROM audit_log WHERE action LIKE 'local_account.%'",
      )
    ).map((r) => r.action);
    assert.ok(actions.includes('local_account.login.failed'));
    assert.ok(actions.includes('local_account.created'));
  });
});

describe('local sign-in over HTTP', () => {
  test('the sign-in page asks for the address first, then the password', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    // The default way in: open on the page, not folded away - email only.
    assert.match(page.text, /action="\/auth\/local\/identify"/);
    assert.doesNotMatch(page.text, /<details class="local-signin"/);
    assert.match(page.text, /name="email"/);
    assert.doesNotMatch(page.text, /name="username"/);
    assert.doesNotMatch(page.text, /name="password"/);

    await agent.post('/auth/local/identify').type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'admin@local' })
      .expect(302).expect('location', '/login/password');
    const second = await agent.get('/login/password').expect(200);
    assert.match(second.text, /value="admin@local"/);
    assert.match(second.text, /name="password"/);
    assert.match(second.text, /href="\/login\?change=1"/);
  });

  test('a wrong password is said on the password page, and the right one signs in', async () => {
    await unlock();
    const agent = request.agent(app);
    const page = await agent.get('/login');
    await agent.post('/auth/local/identify').type('form').send({ _csrf: csrfFrom(page.text), email: 'admin@local' }).expect(302);
    const second = await agent.get('/login/password');
    const wrong = await agent.post('/auth/local').type('form')
      .send({ _csrf: csrfFrom(second.text), email: 'admin@local', password: 'Nope-nope-nope-1' })
      .expect(401);
    assert.match(wrong.text, /id="password-error"/);
    assert.match(wrong.text, /value="admin@local"/);
    await agent.post('/auth/local').type('form')
      .send({ _csrf: csrfFrom(wrong.text), email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(302);
    await agent.get('/admin/settings/users').expect(200);
  });

  test('an address with no account gets the same password page', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    await agent.post('/auth/local/identify').type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'nobody-here@example.com' })
      .expect(302).expect('location', '/login/password');
  });

  test('signs in and reaches the admin pages', async () => {
    await unlock();
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);

    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(302);

    await agent.get('/admin/settings/integrations/entra/authentication').expect(200);
    await agent.get('/admin/settings/users').expect(200);
  });

  test('a wrong password is refused and grants no session', async () => {
    await unlock();
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);

    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'admin@local', password: 'wrong-password' })
      .expect(401);

    await agent.get('/admin/settings/integrations/entra/authentication').expect(302).expect('location', /^\/login/);
  });

  test('a sign-in without a CSRF token is refused', async () => {
    await unlock();
    await request(app)
      .post('/auth/local')
      .type('form')
      .send({ email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(403);
  });

  test('it still works while single sign-on is unconfigured', async () => {
    // The whole point of the account: no tenant details are set in this test
    // environment, so the OIDC path could not possibly complete.
    await unlock();
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(302);
    await agent.get('/admin/settings/integrations/entra/authentication').expect(200);
  });
});

describe('protection from administrative mistakes', () => {
  test('cannot be demoted', async () => {
    await unlock();
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(302);

    const usersPage = await agent.get('/admin/settings/users').expect(200);
    const local = await findLocalAdmin();
    assert.ok(local);

    await agent
      .post('/admin/settings/users/' + local.id + '/role')
      .type('form')
      .send({ _csrf: csrfFrom(usersPage.text), role: 'user' })
      .expect(409);

    assert.equal((await findLocalAdmin())?.role, 'admin');
  });

  test('cannot be disabled', async () => {
    await unlock();
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(302);

    const usersPage = await agent.get('/admin/settings/users').expect(200);
    const local = await findLocalAdmin();
    assert.ok(local);

    await agent
      .post('/admin/settings/users/' + local.id + '/status')
      .type('form')
      .send({ _csrf: csrfFrom(usersPage.text), status: 'disabled' })
      .expect(409);

    assert.equal((await findLocalAdmin())?.status, 'active');
  });
});

describe('changing the password through the UI', () => {
  test('requires the current password', async () => {
    await unlock();
    const agent = request.agent(app);
    const login = await agent.get('/login').expect(200);
    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(302);

    const page = await agent.get('/admin/settings/integrations/entra/authentication').expect(200);
    const response = await agent
      .post('/profile/password')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        currentPassword: 'not-the-current-one',
        newPassword: 'A brand new long passphrase-1',
        confirmPassword: 'A brand new long passphrase-1',
      })
      .expect(400);
    assert.match(response.text, /current password is not correct/i);

    // The old password must still work.
    await unlock();
    await verifyLocalSignIn(LOCAL_EMAIL, KNOWN_PASSWORD);
  });

  test('rejects a mismatched confirmation and a weak password', async () => {
    await unlock();
    const agent = request.agent(app);
    const login = await agent.get('/login').expect(200);
    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(302);
    const page = await agent.get('/admin/settings/integrations/entra/authentication').expect(200);

    const mismatch = await agent
      .post('/profile/password')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        currentPassword: KNOWN_PASSWORD,
        newPassword: 'A brand new long passphrase-1',
        confirmPassword: 'A different long passphrase-1',
      })
      .expect(400);
    assert.match(mismatch.text, /do not match/i);

    await unlock();
    const weak = await agent
      .post('/profile/password')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        currentPassword: KNOWN_PASSWORD,
        newPassword: 'short',
        confirmPassword: 'short',
      })
      .expect(400);
    assert.match(weak.text, /at least/i);
  });

  test('changes the password and invalidates the old one', async () => {
    await unlock();
    const agent = request.agent(app);
    const login = await agent.get('/login').expect(200);
    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(302);
    const page = await agent.get('/admin/settings/integrations/entra/authentication').expect(200);

    const replacement = 'The replacement long passphrase-1';
    await agent
      .post('/profile/password')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        currentPassword: KNOWN_PASSWORD,
        newPassword: replacement,
        confirmPassword: replacement,
      })
      .expect(302);

    await unlock();
    const ok = await verifyLocalSignIn(LOCAL_EMAIL, replacement);
    assert.ok(ok.user);

    await unlock();
    await assert.rejects(() => verifyLocalSignIn(LOCAL_EMAIL, KNOWN_PASSWORD));

    // Put it back for any later test in this file.
    await setLocalAdminPassword(KNOWN_PASSWORD, null);
  });

  test('a directory administrator has no password form at all', async () => {
    // Only the local account has a password. A directory administrator sees
    // an explanation on their profile instead of a form, and the endpoint
    // refuses them outright.
    const session = await signInAs('dir.admin@example.com', 'admin');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    const profile = await agent.get('/profile').expect(200);
    assert.match(profile.text, /managed by your organisation/i);
    assert.doesNotMatch(profile.text, /name="currentPassword"/);

    await unlock();
    await agent
      .post('/profile/password')
      .type('form')
      .send({
        _csrf: session.csrfToken,
        currentPassword: 'guessing',
        newPassword: 'Another long passphrase here-1',
        confirmPassword: 'Another long passphrase here-1',
      })
      .expect(403);

    // The local password is untouched.
    await unlock();
    await verifyLocalSignIn(LOCAL_EMAIL, KNOWN_PASSWORD);
  });
});
