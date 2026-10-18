import './env.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import {
  generatePassword,
  minPasswordLength,
  passwordProblems,
  passwordRules,
} from '../src/auth/password.js';
import {
  createLocalAccount,
  ensureLocalAdmin,
  setLocalAdminPassword,
  verifyLocalSignIn,
} from '../src/auth/local-accounts.js';
import { settings } from '../src/settings/index.js';

/** Users - Other settings - Password policy, and the eye beside a password box. */

let app: Express;
let admin: TestSession;
const KNOWN_PASSWORD = 'A-long-enough-test-passphrase-1';
const as = (s: TestSession) => request.agent(app).set('Cookie', s.cookie);
const savePolicy = (form: Record<string, string>) =>
  as(admin).post('/admin/settings/users/other/password-policy').type('form').send({ _csrf: admin.csrfToken, ...form });

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('policy.admin@example.com', 'admin');
  // A password this test knows, for the one check that signs in for real.
  await ensureLocalAdmin();
  await setLocalAdminPassword(KNOWN_PASSWORD, null);
});

describe('the password policy', () => {
  test('is behind its own chevron on Other settings', async () => {
    const page = await as(admin).get('/admin/settings/users/other').expect(200);
    assert.match(page.text, /<details class="mode-panel settings-panel" id="password-policy"/);
  });

  test('length, kinds of character and the email name are enforced; generated passwords always pass', async () => {
    await savePolicy({ minLength: '14', maxAgeDays: '0', requireUpper: 'on', requireLower: 'on', requireDigit: 'on', requireSymbol: 'on', notEmail: 'on' }).expect(302);
    assert.equal(settings().localAccounts.passwordPolicy.minLength, 14);
    assert.ok(minPasswordLength() >= 14);
    const messages = (p: string, email?: string) => passwordProblems(p, email ? { email } : {}).map((x) => x.message).join(' | ');
    assert.match(messages('alllowercaseletters'), /upper-case/);
    assert.match(messages('alllowercaseletters'), /digit/);
    assert.match(messages('alllowercaseletters'), /symbol/);
    assert.match(messages('Short1!'), /at least 14/);
    assert.match(messages('Jana.Novakova-2026!', 'jana.novakova@contoso.com'), /common phrase/);
    assert.equal(messages('Lighthouse-Velvet-9271'), '');
    for (let i = 0; i < 20; i++) assert.equal(messages(generatePassword()), '', 'a generated password meets the policy');
  });

  test('a password older than the maximum age is changed at the next sign-in', async () => {
    await savePolicy({ minLength: '12', maxAgeDays: '30' }).expect(302);
    const created = await createLocalAccount({ displayName: 'Old password', email: 'old.password@example.com', role: 'user', password: 'Lighthouse-Velvet-9271', mustChange: false }, null);
    assert.equal((await verifyLocalSignIn('old.password@example.com', 'Lighthouse-Velvet-9271')).mustChange, false);
    await execute('UPDATE local_credentials SET password_updated_at = ? WHERE user_id = ?', [new Date(Date.now() - 31 * 86_400_000).toISOString(), created.id]);
    assert.equal((await verifyLocalSignIn('old.password@example.com', 'Lighthouse-Velvet-9271')).mustChange, true);
    await savePolicy({ minLength: '8', maxAgeDays: '0' }).expect(302);
  });

  test('nonsense is refused beside the form', async () => {
    const res = await savePolicy({ minLength: '3', maxAgeDays: '0' }).expect(400);
    assert.match(res.text, /from 8 to 64/);
  });
});

describe('setting a password for somebody', () => {
  test('is a password box with an eye, not plain text', async () => {
    const page = await as(admin).get('/admin/settings/users').expect(200);
    assert.match(page.text, /<input id="password" name="password" type="password"/);
    assert.match(page.text, /class="password-reveal__toggle"/);
    assert.match(page.text, /password-reveal\.js/);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
    assert.doesNotMatch(page.text, /name="password" type="text"/);
  });
});

describe('the rules box', () => {
  test('lists the rules in force, and only those', async () => {
    await savePolicy({
      minLength: '14',
      maxAgeDays: '0',
      requireUpper: 'on',
      requireDigit: 'on',
    }).expect(302);

    const rules = passwordRules();
    assert.deepEqual(
      rules.map((rule) => rule.test),
      ['length', 'upper', 'digit'],
      'a rule that is off has no line',
    );
    assert.equal(rules[0]?.min, minPasswordLength(), 'the length rule carries the minimum');
  });

  test('the script names every rule the server can ask for', () => {
    // The ticks mirror passwordProblems(). A rule the policy can turn on but
    // the script does not know would draw a line that never ticks, however
    // good the password.
    const script = readFileSync('public/js/password-reveal.js', 'utf8');
    const from = script.indexOf('var RULES = {');
    assert.ok(from > 0, 'the script should carry the rule table');
    const table = script.slice(from, script.indexOf('};', from));

    for (const name of ['length', 'upper', 'lower', 'digit', 'symbol']) {
      assert.match(table, new RegExp('\\b' + name + ':'), name + ' is missing from the script');
    }
  });

  test('the profile page draws the box, and is allowed the script', async () => {
    await savePolicy({ minLength: '12', maxAgeDays: '0', requireUpper: 'on' }).expect(302);

    // A password account, signed in the ordinary way: the card only exists
    // for somebody who has a password here.
    const agent = request.agent(app);
    const login = await agent.get('/login').expect(200);
    const token = /name="_csrf" value="([^"]+)"/.exec(login.text);
    assert.ok(token);
    await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: token[1], email: 'admin@local', password: KNOWN_PASSWORD })
      .expect(302);

    const page = await agent.get('/profile').expect(200);

    assert.match(page.text, /data-pw-rules="newPassword"/);
    assert.match(page.text, /data-rule="length"/);
    assert.match(page.text, new RegExp('data-min="' + minPasswordLength() + '"'));
    assert.match(page.text, /data-rule="upper"/);

    // Rendered by the server, so the rules are there without the script...
    assert.match(page.text, /password-reveal\.js/);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);

    // ...and the old paragraph is gone.
    assert.doesNotMatch(page.text, /Length is what matters/);
  });
});
