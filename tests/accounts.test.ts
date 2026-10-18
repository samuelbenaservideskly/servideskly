import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import {
  LOCAL_EMAIL,
  createLocalAccount,
  deleteLocalAccount,
  ensureLocalAdmin,
  findLocalAdmin,
  isLocalAccount,
  isLocalAdmin,
  listLocalAccounts,
  verifyLocalSignIn,
} from '../src/auth/local-accounts.js';
import { createTicket } from '../src/services/tickets.js';
import { findUserByEmail, findUserById } from '../src/services/users.js';

let app: Express;
let admin: TestSession;
let adminAgent: request.Agent;
let userAgent: request.Agent;

const PASSWORD = 'A-long-enough-test-passphrase-1';

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureLocalAdmin();
  app = createApp();

  admin = await signInAs('accounts.admin@example.com', 'admin');
  adminAgent = request.agent(app);
  adminAgent.set('Cookie', admin.cookie);

  const user = await signInAs('accounts.user@example.com', 'user');
  userAgent = request.agent(app);
  userAgent.set('Cookie', user.cookie);
});

describe('creating password accounts', () => {
  test('an account can sign in with the password it was given', async () => {
    const created = await createLocalAccount(
      {
        email: 'tech1@example.org',
        displayName: 'Tess Harding',
        role: 'agent',
        password: PASSWORD,
      },
      null,
    );

    assert.equal(created.role, 'agent');
    assert.equal(created.source, 'local');
    assert.equal(isLocalAccount(created), true);
    assert.equal(isLocalAdmin(created), false, 'only the break-glass account is that');

    const result = await verifyLocalSignIn('tech1@example.org', PASSWORD);
    assert.equal(result.user.id, created.id);
  });

  test('the address is matched without regard to case', async () => {
    const result = await verifyLocalSignIn('TECH1@example.org', PASSWORD);
    assert.equal(result.user.display_name, 'Tess Harding');
  });

  test('a duplicate address is refused, whatever its case', async () => {
    await assert.rejects(
      () =>
        createLocalAccount(
          { email: 'TECH1@example.org', displayName: 'Someone else', role: 'user', password: PASSWORD },
          null,
        ),
      /already belongs/,
    );
  });

  test('something that is not an email address is refused', async () => {
    for (const email of ['a', 'admin', 'no-at-sign.example.org', '@example.org', 'x@local', '']) {
      await assert.rejects(
        () =>
          createLocalAccount(
            { email, displayName: 'Nope', role: 'user', password: PASSWORD },
            null,
          ),
        'expected ' + JSON.stringify(email) + ' to be refused',
      );
    }
  });

  test('an email already belonging to another account is refused', async () => {
    await assert.rejects(
      () =>
        createLocalAccount(
          {
            displayName: 'Clashing',
            email: 'accounts.user@example.com',
            role: 'user',
            password: PASSWORD,
          },
          null,
        ),
      /already belongs/,
    );
  });

  test('a new account has its role locked, so a sync cannot change it', async () => {
    const created = await createLocalAccount(
      { email: 'locked1@example.org', displayName: 'Locked role', role: 'admin', password: PASSWORD },
      null,
    );
    assert.equal(created.role_locked, true);
  });
});

describe('the break-glass administrator', () => {
  test('exists and is an administrator', async () => {
    const user = await findLocalAdmin();
    assert.ok(user);
    assert.equal(user.role, 'admin');
    assert.equal(isLocalAdmin(user), true);
  });

  test('is listed among the password accounts', async () => {
    const accounts = await listLocalAccounts();
    assert.ok(accounts.some((a) => a.email === LOCAL_EMAIL));
  });

  test('cannot be deleted', async () => {
    const user = await findLocalAdmin();
    assert.ok(user);
    await assert.rejects(() => deleteLocalAccount(user.id, null), /cannot be removed/);
    assert.ok(await findLocalAdmin(), 'it must still be there');
  });

  test('its role cannot be changed through the UI', async () => {
    const user = await findLocalAdmin();
    assert.ok(user);
    await adminAgent
      .post('/admin/settings/users/' + user.id + '/role')
      .type('form')
      .send({ _csrf: admin.csrfToken, role: 'user' })
      .expect(409);
    assert.equal((await findUserById(user.id))?.role, 'admin');
  });

  test('it cannot be disabled through the UI', async () => {
    const user = await findLocalAdmin();
    assert.ok(user);
    await adminAgent
      .post('/admin/settings/users/' + user.id + '/status')
      .type('form')
      .send({ _csrf: admin.csrfToken, status: 'disabled' })
      .expect(409);
    assert.equal((await findUserById(user.id))?.status, 'active');
  });
});

describe('removing an account', () => {
  test('an account with no tickets is deleted outright', async () => {
    const created = await createLocalAccount(
      { email: 'ephemeral@example.org', displayName: 'Ephemeral', role: 'user', password: PASSWORD },
      null,
    );
    await deleteLocalAccount(created.id, null);
    assert.equal(await findUserById(created.id), undefined);
  });

  test('an account that has raised a ticket is disabled instead, so its history survives', async () => {
    const created = await createLocalAccount(
      { email: 'hashistory@example.org', displayName: 'Has history', role: 'user', password: PASSWORD },
      null,
    );
    const ticket = await createTicket({
      title: 'A ticket that must outlive its requester account',
      description: 'Deleting the account outright would take this ticket with it.',
      priority: 'normal',
      category: 'other',
      requesterId: created.id,
    });

    await deleteLocalAccount(created.id, null);

    const after = await findUserById(created.id);
    assert.ok(after, 'the account must still exist');
    assert.equal(after.status, 'disabled');
    assert.ok(ticket.id, 'and so must its ticket');
  });
});

describe('the administration page', () => {
  test('is closed to anyone but an administrator', async () => {
    await userAgent.get('/admin/settings/users').expect(403);
  });

  test('lists the accounts and marks the protected one', async () => {
    const page = await adminAgent.get('/admin/settings/users').expect(200);
    assert.match(page.text, /tech1/);
    assert.match(page.text, /break-glass/);
  });

  test('the create form is a dialog behind a button, not a form on the page', async () => {
    const page = await adminAgent.get('/admin/settings/users').expect(200);

    assert.match(page.text, /href="#new-account"/, 'there should be a button that opens it');
    assert.match(page.text, /id="new-account"/);
    assert.doesNotMatch(page.text, /dialog--open/, 'nothing was refused, so nothing is open');
    // The only script is the eye beside the password box; the dialog opens without it.
    const scripts = page.text.match(/<script src="[^"]+"/g) ?? [];
    assert.ok(scripts.every((s) => /password-reveal\.js|select-search\.js/.test(s)), 'the dialog must not need JavaScript: ' + scripts.join(', '));
  });

  test('an administrator can create an account through the form', async () => {
    const page = await adminAgent.get('/admin/settings/users').expect(200);
    await adminAgent
      .post('/admin/settings/users')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        // No username: the email address is the sign-in name.
        displayName: 'Made on the form',
        email: 'formmade@example.org',
        role: 'agent',
        password: PASSWORD,
      })
      .expect(302);

    const result = await verifyLocalSignIn('formmade@example.org', PASSWORD);
    assert.equal(result.user.role, 'agent');
    assert.equal(result.mustChange, true, 'a password an administrator set must be replaced');
  });

  test('an address already taken comes back on the form, not as a 409 page', async () => {
    const page = await adminAgent.get('/admin/settings/users').expect(200);
    const refused = await adminAgent
      .post('/admin/settings/users')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        displayName: 'Second attempt',
        email: 'FormMade@example.org',
        role: 'user',
        password: PASSWORD,
      })
      .expect(400);

    assert.match(refused.text, /already belongs to another account/);
    assert.match(refused.text, /dialog--open/, 'the dialog must still be open');
    assert.doesNotMatch(refused.text, /name="username"/, 'the form no longer asks for one');
    assert.doesNotMatch(refused.text, /Conflict/, 'the standalone error page must not render');
  });

  test('the email address of a password account can be changed', async () => {
    // Without this there is no way to receive a notification on a test
    // account, which is how it was noticed.
    const created = await findUserByEmail('formmade@example.org');
    assert.ok(created, 'the account made above');

    const page = await adminAgent.get('/admin/settings/users/' + created.id).expect(200);
    assert.match(page.text, /name="email"/, 'a local account must offer the field');

    await adminAgent
      .post('/admin/settings/users/' + created.id + '/email')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'Real.Person@Example.com' })
      .expect(302);

    const updated = await findUserById(created.id);
    assert.equal(updated?.email, 'real.person@example.com', 'stored lower-cased');

    // The email is the sign-in name, so it moved with the address.
    const result = await verifyLocalSignIn('Real.Person@Example.com', PASSWORD);
    assert.equal(result.user.id, created.id);
    await assert.rejects(() => verifyLocalSignIn('formmade@example.org', PASSWORD));
    assert.equal(result.user.id, created.id);
  });

  test('an address another account already has is refused', async () => {
    const target = await findUserByEmail('real.person@example.com');
    assert.ok(target);

    const page = await adminAgent.get('/admin/settings/users/' + target.id).expect(200);
    await adminAgent
      .post('/admin/settings/users/' + target.id + '/email')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'accounts.admin@example.com' })
      .expect(302);

    const unchanged = await findUserById(target.id);
    assert.equal(
      unchanged?.email,
      'real.person@example.com',
      'two accounts cannot share an address',
    );
  });

  test('something that is not an address is refused', async () => {
    const target = await findUserByEmail('real.person@example.com');
    assert.ok(target);

    const page = await adminAgent.get('/admin/settings/users/' + target.id).expect(200);
    await adminAgent
      .post('/admin/settings/users/' + target.id + '/email')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'not-an-address' })
      .expect(302);

    assert.equal((await findUserById(target.id))?.email, 'real.person@example.com');
  });

  test('a password below the policy is refused', async () => {
    const page = await adminAgent.get('/admin/settings/users').expect(200);
    await adminAgent
      .post('/admin/settings/users')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        email: 'tooshort@example.org',
        displayName: 'Too short',
        role: 'user',
        password: 'abc',
      })
      .expect(400);
  });

  test('resetting a password signs that account out everywhere', async () => {
    const created = await createLocalAccount(
      { email: 'resetme@example.org', displayName: 'Reset me', role: 'user', password: PASSWORD },
      null,
    );

    const page = await adminAgent.get('/admin/settings/users').expect(200);
    await adminAgent
      .post('/admin/settings/users/' + created.id + '/password')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), password: 'A-brand-new-passphrase-1' })
      .expect(302);

    await assert.rejects(
      () => verifyLocalSignIn('resetme@example.org', PASSWORD),
      'the old password must stop working',
    );
    const result = await verifyLocalSignIn('resetme@example.org', 'A-brand-new-passphrase-1');
    assert.equal(result.mustChange, true);
  });

  test('a role can be changed, and a disabled account cannot sign in', async () => {
    const created = await createLocalAccount(
      { email: 'promoteme@example.org', displayName: 'Promote me', role: 'user', password: PASSWORD },
      null,
    );

    await adminAgent
      .post('/admin/settings/users/' + created.id + '/role')
      .type('form')
      .send({ _csrf: admin.csrfToken, role: 'agent' })
      .expect(302);
    assert.equal((await findUserById(created.id))?.role, 'agent');

    await adminAgent
      .post('/admin/settings/users/' + created.id + '/status')
      .type('form')
      .send({ _csrf: admin.csrfToken, status: 'disabled' })
      .expect(302);

    await assert.rejects(() => verifyLocalSignIn('promoteme@example.org', PASSWORD), /disabled/);
  });
});

describe('an administrator the portal does not list', () => {
  test('can be demoted by another administrator, as before', async () => {
    const other = await signInAs('accounts.other.admin@example.com', 'admin');
    const page = await adminAgent.get('/admin/settings/users/' + other.user.id).expect(200);
    assert.doesNotMatch(page.text, /managed in the customer portal/);
    await adminAgent.post('/admin/settings/users/' + other.user.id + '/role').type('form')
      .send({ _csrf: admin.csrfToken, role: 'agent' }).expect(302);
    assert.equal((await findUserById(other.user.id))?.role, 'agent');
  });
});
