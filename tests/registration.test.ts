import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { queryOne } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { ensureLocalAdmin } from '../src/auth/local-accounts.js';
import { queuedMail } from './support/outbox.js';

/** "Create an account": confirmed by email before anything exists. */

let app: Express;
let admin: TestSession;
const as = (s: TestSession) => request.agent(app).set('Cookie', s.cookie);
const csrfFrom = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)![1]!;
const setRegistration = (form: Record<string, string>) =>
  as(admin).post('/admin/settings/users/other/registration').type('form').send({ _csrf: admin.csrfToken, ...form });
const PASSWORD = 'Lighthouse-Velvet-9271';

async function linkFor(email: string): Promise<string | null> {
  const rows = (await queuedMail((m) => m.to_address === email)).slice(0, 1);
  return /\/register\/confirm\/[A-Za-z0-9_-]{43}/.exec(Object.values(rows[0] ?? {}).map(String).join(' '))?.[0] ?? null;
}

async function register(form: Record<string, string>) {
  const agent = request.agent(app);
  const page = await agent.get('/register').expect(200);
  const res = await agent.post('/auth/register').type('form').send({ _csrf: csrfFrom(page.text), ...form });
  return { agent, res };
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureLocalAdmin();
  app = createApp();
  admin = await signInAs('reg.admin@example.com', 'admin');
});

describe('registration', () => {
  test('off by default, and cannot be switched on without mail', async () => {
    await request(app).get('/register').expect(404);
    assert.doesNotMatch((await request(app).get('/login').expect(200)).text, /Create an account/);
    await setRegistration({ enabled: 'on' }).expect(302);
    await request(app).get('/register').expect(404);
  });

  test('switched on: nothing exists until the mailed link is used', async () => {
    await createMailbox(
      { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
      null,
    );
    await setRegistration({ enabled: 'on', domains: '@contoso.com, nonsense' }).expect(302);
    assert.match((await request(app).get('/login').expect(200)).text, /href="\/register">Create an account/);

    const wrongDomain = await register({ firstName: 'Ana', lastName: 'Novak', email: 'ana@fabrikam.com', password: PASSWORD, confirm: PASSWORD });
    assert.equal(wrongDomain.res.status, 400);
    assert.match(wrongDomain.res.text, /only for @contoso\.com/);

    const { agent, res } = await register({ firstName: 'Ana', lastName: 'Novak', email: 'ana.novak@contoso.com', password: PASSWORD, confirm: PASSWORD });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/register?sent=1');
    assert.equal(await queryOne('SELECT id FROM users WHERE email = ?', ['ana.novak@contoso.com']), undefined, 'no account yet');
    const stored = await queryOne<{ password_hash: string }>('SELECT password_hash FROM registrations WHERE email = ?', ['ana.novak@contoso.com']);
    assert.ok(stored && !stored.password_hash.includes(PASSWORD), 'the password is kept hashed');

    const link = await linkFor('ana.novak@contoso.com');
    assert.ok(link);
    // Opening the link creates nothing - a mail scanner may follow it.
    const confirm = await agent.get(link).expect(200);
    assert.equal(await queryOne('SELECT id FROM users WHERE email = ?', ['ana.novak@contoso.com']), undefined);
    await agent.post(link).type('form').send({ _csrf: csrfFrom(confirm.text) }).expect(302).expect('location', '/login/password?created=1');

    const user = await queryOne<{ role: string; first_name: string; last_name: string }>('SELECT role, first_name, last_name FROM users WHERE email = ?', ['ana.novak@contoso.com']);
    assert.deepEqual(user, { role: 'user', first_name: 'Ana', last_name: 'Novak' });
    await agent.get(link).expect(404);

    // And the chosen password signs in.
    const fresh = request.agent(app);
    const login = await fresh.get('/login').expect(200);
    await fresh.post('/auth/local').type('form').send({ _csrf: csrfFrom(login.text), email: 'ana.novak@contoso.com', password: PASSWORD }).expect(302);
    await fresh.get('/tickets').expect(200);
  });

  test('an address that has an account gets the same answer, and nothing is sent', async () => {
    const before = (await queuedMail((m) => m.to_address === 'ana.novak@contoso.com')).length;
    const { res } = await register({ firstName: 'Ana', lastName: 'Again', email: 'ana.novak@contoso.com', password: PASSWORD, confirm: PASSWORD });
    assert.equal(res.headers.location, '/register?sent=1');
    assert.equal((await queuedMail((m) => m.to_address === 'ana.novak@contoso.com')).length, before);
  });

  test('the password policy and the confirmation apply', async () => {
    const weak = await register({ firstName: 'Bo', lastName: 'Lee', email: 'bo@contoso.com', password: 'short', confirm: 'short' });
    assert.equal(weak.res.status, 400);
    const mismatch = await register({ firstName: 'Bo', lastName: 'Lee', email: 'bo@contoso.com', password: PASSWORD, confirm: PASSWORD + 'x' });
    assert.match(mismatch.res.text, /not the same/);
  });
});
