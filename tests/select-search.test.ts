import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { createLocalAccount, verifyLocalSignIn } from '../src/auth/local-accounts.js';
import { wantsSelectSearch } from '../src/middleware/select-search.js';
import { createTemplate, ensureDefaultTemplate } from '../src/services/templates.js';

let app: Express;
let admin: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('search.admin@example.com', 'admin');
});

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

describe('search in long dropdowns', () => {
  test('only a long or narrowing dropdown asks for the script', () => {
    const options = (n: number) => '<option>x</option>'.repeat(n);
    assert.equal(wantsSelectSearch('<select>' + options(8) + '</select>'), false);
    assert.equal(wantsSelectSearch('<select>' + options(9) + '</select>'), true);
    assert.equal(wantsSelectSearch('<select multiple>' + options(20) + '</select>'), false);
    assert.equal(wantsSelectSearch('<select data-narrows="x"><option></option></select>'), true);
  });

  test('New ticket: kind narrows the form list; the page gets the script, never inline', async () => {
    await ensureDefaultTemplate();
    await createTemplate({
      name: 'Order a phone', summary: '', title: '', body: '', priority: 'normal', category: 'other',
      type: 'service_request', groupId: null, categoryId: null,
      fields: [{ key: 'title', kind: 'builtin', label: '', mode: 'mandatory', value: '', placeholder: '', placed: true }],
      isActive: true,
    }, null);
    const page = await as(admin).get('/tickets/new').expect(200);
    assert.match(page.text, /<select id="template-kind" data-narrows="template-choice"/);
    assert.match(page.text, /data-kind="service_request"[^>]*>Order a phone/);
    const policy = String(page.headers['content-security-policy']);
    assert.match(policy, /script-src 'self'/);
    assert.doesNotMatch(policy, /unsafe-inline/);
    assert.match(page.text, /<script src="\/assets\/js\/select-search\.js\?v=[^"]+" defer><\/script>\s*<\/body>/);

    // A page with no long dropdown keeps the strict policy. Sign-in is the
    // example that cannot drift: select-search skips /login outright, so it
    // is never given a script whatever the page grows into.
    const login = await request(app).get('/login').expect(200);
    assert.match(String(login.headers['content-security-policy']), /script-src 'none'/);
    assert.doesNotMatch(login.text, /select-search\.js/);

    // The profile page does run a script - the eye and the password rules
    // (allowOwnScripts, 15 Oct 2026) - but never this one.
    const profile = await as(admin).get('/profile').expect(200);
    assert.doesNotMatch(profile.text, /select-search\.js/);
  });
});

describe('a local user changes their own password', () => {
  test('on the profile page, with the current password', async () => {
    await createLocalAccount(
      { displayName: 'Petra Local', email: 'petra@example.com', role: 'user', password: 'The first long passphrase-1' },
      null,
    );
    const agent = request.agent(app);
    const login = await agent.get('/login').expect(200);
    await agent.post('/auth/local').type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'petra@example.com', password: 'The first long passphrase-1' })
      .expect(302);

    const page = await agent.get('/profile').expect(200);
    assert.match(page.text, /Change your password/);
    assert.match(page.text, /Local account - signs in with a password/);

    await agent.post('/profile/password').type('form').send({
      _csrf: csrfFrom(page.text),
      currentPassword: 'The first long passphrase-1',
      newPassword: 'A second even longer passphrase-1',
      confirmPassword: 'A second even longer passphrase-1',
    }).expect(302);
    await verifyLocalSignIn('petra@example.com', 'A second even longer passphrase-1');
  });
});
