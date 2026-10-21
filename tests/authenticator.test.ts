import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { createLocalAccount } from '../src/auth/local-accounts.js';
import { findUserByEmail } from '../src/services/users.js';
import { codeAt, currentStep, matchStep, newSecret } from '../src/auth/authenticator.js';

/**
 * An authenticator app after the password (auth/authenticator.ts, 21 Oct
 * 2026): set up on the profile page, asked for at sign-in, a code used once,
 * recovery codes for a lost phone, and an administrator's way back.
 */

let app: Express;
let admin: TestSession;
const PASSWORD = 'A-long-enough-test-passphrase-1';

function csrfFrom(html: string): string {
  return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
}

/** Signs in with the password; returns the agent and where it was sent. */
async function signIn(email: string) {
  const agent = request.agent(app);
  const page = await agent.get('/login').expect(200);
  const response = await agent.post('/auth/local').type('form').send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return { agent, response };
}

/** Turns the app on for an account, as its owner would; returns the secret and the recovery codes. */
async function setUp(email: string) {
  const { agent } = await signIn(email);
  const page = await agent.get('/profile/authenticator').expect(200);
  assert.match(page.text, /<svg/, 'a QR code, drawn on the server');
  const secret = /class="authenticator-key">([^<]+)</.exec(page.text)![1]!.replace(/\s+/g, '');
  const done = await agent
    .post('/profile/authenticator')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), code: codeAt(secret, currentStep()) })
    .expect(200);
  const codes = [...done.text.matchAll(/<li>([A-Z2-9]{5}-[A-Z2-9]{5})<\/li>/g)].map((m) => m[1]!);
  assert.equal(codes.length, 10);
  return { secret, codes };
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('totp.admin@example.com', 'admin');
  for (const email of ['totp.one@example.com', 'totp.two@example.com', 'totp.three@example.com']) {
    await createLocalAccount({ email, displayName: email, role: 'user', password: PASSWORD }, null);
  }
});

describe('the codes', () => {
  test('match RFC 6238 and are used once', () => {
    // RFC 6238 appendix B, SHA-1, T = 59 s: 94287082, last six digits.
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
    assert.equal(codeAt(rfcSecret, 1), '287082');
    const secret = newSecret();
    const now = Date.now();
    const step = matchStep(secret, codeAt(secret, currentStep(now)), 0, now);
    assert.equal(step, currentStep(now));
    assert.equal(matchStep(secret, codeAt(secret, currentStep(now)), step!, now), null, 'not twice');
  });
});

describe('signing in', () => {
  test('after it is set up, a password alone is not a way in', async () => {
    const { secret } = await setUp('totp.one@example.com');
    const { agent, response } = await signIn('totp.one@example.com');
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, '/login/authenticator');
    // No session yet: the profile is still out of reach.
    const profile = await agent.get('/profile');
    assert.equal(profile.status, 302);

    const page = await agent.get('/login/authenticator').expect(200);
    const wrong = await agent.post('/auth/local/authenticator').type('form').send({ _csrf: csrfFrom(page.text), code: '000000' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.text, /That code is not right/);

    // The next step's code: the one used to set it up is already spent.
    const ok = await agent
      .post('/auth/local/authenticator')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), code: codeAt(secret, currentStep() + 1) });
    assert.equal(ok.status, 302);
    await agent.get('/profile').expect(200);
  });

  test('a recovery code works once, for a lost phone', async () => {
    const { codes } = await setUp('totp.two@example.com');
    const first = await signIn('totp.two@example.com');
    const page = await first.agent.get('/login/authenticator').expect(200);
    await first.agent.post('/auth/local/authenticator').type('form').send({ _csrf: csrfFrom(page.text), code: codes[0]!.toLowerCase() }).expect(302);
    await first.agent.get('/profile').expect(200);

    const second = await signIn('totp.two@example.com');
    const again = await second.agent.get('/login/authenticator').expect(200);
    const reused = await second.agent.post('/auth/local/authenticator').type('form').send({ _csrf: csrfFrom(again.text), code: codes[0]! });
    assert.equal(reused.status, 400, 'used up');
  });

  test('an administrator can remove it, and the password works alone again', async () => {
    await setUp('totp.three@example.com');
    const target = (await findUserByEmail('totp.three@example.com'))!;
    const page = await request(app).get('/admin/settings/users/' + target.id).set('Cookie', admin.cookie).expect(200);
    assert.match(page.text, /Remove their authenticator app/);
    await request(app)
      .post('/admin/settings/users/' + target.id + '/authenticator/reset')
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ _csrf: admin.csrfToken })
      .expect(302);
    const { response } = await signIn('totp.three@example.com');
    assert.notEqual(response.headers.location, '/login/authenticator');
  });

  test('an account from an identity provider has its provider\'s second step, not this one', async () => {
    const directory = await signInAs('totp.entra@example.com', 'user');
    const res = await request(app).get('/profile/authenticator').set('Cookie', directory.cookie);
    assert.equal(res.status, 403);
  });
});
