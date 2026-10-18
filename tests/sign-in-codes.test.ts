import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute, query } from '../src/db/index.js';
import { createLocalAccount, ensureLocalAdmin, findLocalAdmin, setLocalEmail } from '../src/auth/local-accounts.js';
import { signsInWithCode } from '../src/auth/sign-in-codes.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { createUserGroup, setManualMember } from '../src/services/user-groups.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { queuedMail } from './support/outbox.js';

const USERS = '/admin/settings/users';
const PASSWORD = 'A-long-enough-test-passphrase-1';

let app: Express;
let admin: TestSession;
let localUserId = '';

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match);
  return match[1] as string;
}

function post(session: TestSession, url: string, form: Record<string, string> = {}) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent.post(url).type('form').send({ _csrf: session.csrfToken, ...form });
}

function get(session: TestSession, url: string) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent.get(url);
}

/** The code in the newest mail to this address. */
async function lastCodeFor(email: string): Promise<string | null> {
  const rows = await queuedMail((m) => m.to_address === email);
  return /(\d{6})/.exec(rows[0]?.subject ?? '')?.[1] ?? null;
}

async function codesSentTo(email: string): Promise<number> {
  return (await queuedMail((m) => m.to_address === email)).length;
}

/** Asks for a code through the sign-in page; returns the agent holding the session. */
async function askForCode(email: string) {
  const agent = request.agent(app);
  const page = await agent.get('/login').expect(200);
  await agent
    .post('/auth/local/code')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), email })
    .expect(302)
    .expect('location', '/login/code');
  const codePage = await agent.get('/login/code').expect(200);
  return { agent, csrf: csrfFrom(codePage.text) };
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureLocalAdmin();
  app = createApp();
  admin = await signInAs('codes.admin@example.com', 'admin');
  const created = await createLocalAccount(
    { displayName: 'Code user', email: 'code.user@example.com', role: 'user', password: PASSWORD, mustChange: false },
    null,
  );
  localUserId = created.id;
});

describe('the break-glass account has its own tab', () => {
  test('the Local users list leaves it out, and its page is the tab', async () => {
    const list = await get(admin, USERS).expect(200);
    assert.doesNotMatch(list.text, /admin@local/);
    assert.match(list.text, /href="\/admin\/settings\/users\/break-glass"/);

    const tab = await get(admin, USERS + '/break-glass').expect(200);
    assert.match(tab.text, /admin@local/);
    assert.match(tab.text, /aria-current="page">Break-glass account/);

    const breakGlass = await findLocalAdmin();
    await get(admin, USERS + '/' + breakGlass!.id).expect(302).expect('location', USERS + '/break-glass');
  });
});

describe('sign-in codes', () => {
  test('cannot be switched on without a mailbox to send them', async () => {
    await post(admin, USERS + '/sign-in-codes', { otpEnabled: 'on' }).expect(302);
    assert.equal(settings().localAccounts.otpEnabled, false);
    const page = await get(admin, USERS + "/other").expect(200);
    assert.match(page.text, /Add a mailbox or set up an SMTP relay under Mail first/);
  });

  test('switched on, a local user signs in with a code and not a password', async () => {
    await createMailbox(
      { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
      null,
    );
    await post(admin, USERS + '/sign-in-codes', { otpEnabled: 'on' }).expect(302);
    assert.equal(settings().localAccounts.otpEnabled, true);

    // Step one sends a code account straight to the code page.
    const stepOne = request.agent(app);
    const login = await stepOne.get('/login').expect(200);
    await stepOne.post('/auth/local/identify').type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'code.user@example.com' })
      .expect(302).expect('location', '/login/code');

    // The password is no longer a way in.
    const agent = request.agent(app);
    const page = await agent.get('/login');
    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'code.user@example.com', password: PASSWORD })
      .expect(302)
      .expect('location', '/login');
    await agent.get('/tickets').expect(302).expect('location', /^\/login/);

    const { agent: coded, csrf } = await askForCode('code.user@example.com');
    const code = await lastCodeFor('code.user@example.com');
    assert.ok(code, 'a code was mailed');
    await coded.post('/auth/local/code/verify').type('form').send({ _csrf: csrf, code }).expect(302);
    await coded.get('/tickets').expect(200);
  });

  test('a code is stored hashed, works once, and a wrong one is refused beside the field', async () => {
    const { agent, csrf } = await askForCode('code.user@example.com');
    const code = await lastCodeFor('code.user@example.com');
    const stored = await query<{ code_hash: string }>('SELECT code_hash FROM local_signin_codes WHERE user_id = ?', [localUserId]);
    assert.notEqual(stored[0]?.code_hash, code);

    const wrong = await agent.post('/auth/local/code/verify').type('form').send({ _csrf: csrf, code: '000000' === code ? '111111' : '000000' }).expect(400);
    assert.match(wrong.text, /That code is not valid/);

    await agent.post('/auth/local/code/verify').type('form').send({ _csrf: csrf, code }).expect(302);
    const replay = await askForCode('code.user@example.com');
    await replay.agent.post('/auth/local/code/verify').type('form').send({ _csrf: replay.csrf, code }).expect(400);
  });

  test('five wrong tries use the code up', async () => {
    await execute('DELETE FROM local_signin_codes', []);
    const { agent, csrf } = await askForCode('code.user@example.com');
    const code = await lastCodeFor('code.user@example.com');
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i += 1) {
      await agent.post('/auth/local/code/verify').type('form').send({ _csrf: csrf, code: wrong }).expect(400);
    }
    const last = await agent.post('/auth/local/code/verify').type('form').send({ _csrf: csrf, code }).expect(400);
    assert.match(last.text, /expired/);
  });

  test('an unknown address gets the same page and no mail', async () => {
    const before = await codesSentTo('nobody@example.com');
    await askForCode('nobody@example.com');
    assert.equal(await codesSentTo('nobody@example.com'), before);
  });

  test('members of the excluded user group keep their passwords', async () => {
    const group = await createUserGroup({ name: 'Keeps passwords', description: '', isActive: true }, null);
    await setManualMember(group.id, localUserId, true, null);
    await post(admin, USERS + '/sign-in-codes', { otpEnabled: 'on', excludedGroup: group.id }).expect(302);
    const user = { id: localUserId, issuer: 'urn:helpdesk:local', external_id: 'x' };
    assert.equal(await signsInWithCode(user), false);

    await post(admin, USERS + '/sign-in-codes', { otpEnabled: 'on', excludedGroup: '' }).expect(302);
    assert.equal(await signsInWithCode(user), true);
  });
});

describe('sign-in codes for the break-glass account', () => {
  test('off by default, and refused while its address cannot receive mail', async () => {
    assert.equal(settings().localAccounts.breakGlassOtp, false);
    const breakGlass = (await findLocalAdmin())!;
    assert.equal(await signsInWithCode(breakGlass), false);

    await post(admin, USERS + '/break-glass/sign-in-code', { enabled: 'on' }).expect(302);
    assert.equal(settings().localAccounts.breakGlassOtp, false);
    const tab = await get(admin, USERS + '/break-glass').expect(200);
    assert.match(tab.text, /can receive mail/);
  });

  test('with a real address it can be switched on, and only then uses a code', async () => {
    const breakGlass = (await findLocalAdmin())!;
    await setLocalEmail(breakGlass.id, 'breakglass@example.com', null);
    await post(admin, USERS + '/break-glass/sign-in-code', { enabled: 'on' }).expect(302);
    assert.equal(settings().localAccounts.breakGlassOtp, true);
    assert.equal(await signsInWithCode((await findLocalAdmin())!), true);

    await post(admin, USERS + '/break-glass/sign-in-code', {}).expect(302);
    assert.equal(settings().localAccounts.breakGlassOtp, false);
  });

  test('the local-user switch never covers it', async () => {
    await updateSettings({ localAccounts: { otpEnabled: true, breakGlassOtp: false } }, null);
    assert.equal(await signsInWithCode((await findLocalAdmin())!), false);
  });
});
