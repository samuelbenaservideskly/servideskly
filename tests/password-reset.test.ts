import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute, query } from '../src/db/index.js';
import { createLocalAccount, ensureLocalAdmin, findLocalAdmin } from '../src/auth/local-accounts.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { queuedMail } from './support/outbox.js';

/**
 * "Forgot password?": a link by email, kept as a hash, used once; the same
 * answer for every address; never for the break-glass account.
 */

const OLD = 'Old-password-1234!';
const NEW = 'Lighthouse-velvet-9271';
let app: Express;

function csrfFrom(html: string): string {
  return /name="_csrf" value="([^"]+)"/.exec(html)![1]!;
}

/** The link in the newest mail to this address, if any. */
async function linkFor(email: string): Promise<string | null> {
  const rows = (await queuedMail((m) => m.to_address === email)).slice(0, 1);
  const text = Object.values(rows[0] ?? {}).map(String).join(' ');
  return /\/login\/reset\/[A-Za-z0-9_-]{43}/.exec(text)?.[0] ?? null;
}

async function mailsTo(email: string): Promise<number> {
  return (await queuedMail((m) => m.to_address === email)).length;
}

async function askForReset(email: string) {
  const agent = request.agent(app);
  const page = await agent.get('/login/forgot').expect(200);
  await agent.post('/auth/local/forgot').type('form').send({ _csrf: csrfFrom(page.text), email }).expect(302).expect('location', '/login/forgot?sent=1');
  return agent;
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureLocalAdmin();
  app = createApp();
  await createLocalAccount({ displayName: 'Reset me', email: 'reset.me@example.com', role: 'user', password: OLD, mustChange: false }, null);
});

describe('forgot password', () => {
  test('without a way to send mail, it says who can help', async () => {
    assert.match((await request(app).get('/login/forgot').expect(200)).text, /Ask your service desk or an administrator/);
    await createMailbox(
      { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
      null,
    );
    await request(app).get('/login/forgot').expect(200);
  });

  test('the password page links to it', async () => {
    const agent = request.agent(app);
    const login = await agent.get('/login').expect(200);
    await agent.post('/auth/local/identify').type('form').send({ _csrf: csrfFrom(login.text), email: 'reset.me@example.com' }).expect(302);
    const page = await agent.get('/login/password').expect(200);
    assert.match(page.text, /href="\/login\/forgot"[^>]*>Forgot password\?/);
    assert.match(page.text, /class="signin-change"/);
  });

  test('a link is mailed, kept only as a hash, and sets a new password once', async () => {
    const agent = await askForReset('reset.me@example.com');
    const sent = await agent.get('/login/forgot?sent=1').expect(200);
    assert.match(sent.text, /a link to choose a new password is on its way/);
    const link = await linkFor('reset.me@example.com');
    assert.ok(link, 'a link was mailed');
    const token = link.split('/').pop()!;
    const stored = await query<{ token_hash: string }>('SELECT token_hash FROM password_resets');
    assert.ok(stored.every((r) => r.token_hash !== token));

    const form = await agent.get(link).expect(200);
    assert.match(form.text, /reset\.me@example\.com/);
    const tooShort = await agent.post(link).type('form').send({ _csrf: csrfFrom(form.text), password: 'x', confirm: 'x' }).expect(400);
    assert.match(tooShort.text, /field-error/);
    const different = await agent.post(link).type('form').send({ _csrf: csrfFrom(form.text), password: NEW, confirm: NEW + 'x' }).expect(400);
    assert.match(different.text, /not the same/);
    await agent.post(link).type('form').send({ _csrf: csrfFrom(form.text), password: NEW, confirm: NEW }).expect(302).expect('location', '/login/password?reset=1');

    // Used: the link is dead, and the new password works.
    await agent.get(link).expect(404);
    const fresh = request.agent(app);
    const login = await fresh.get('/login').expect(200);
    await fresh.post('/auth/local').type('form').send({ _csrf: csrfFrom(login.text), email: 'reset.me@example.com', password: NEW }).expect(302);
    await fresh.get('/tickets').expect(200);
  });

  test('the same answer for an unknown address and for break-glass; nothing is sent to either', async () => {
    await askForReset('nobody@example.com');
    assert.equal(await mailsTo('nobody@example.com'), 0);
    const breakGlass = (await findLocalAdmin())!;
    await askForReset(breakGlass.email);
    assert.equal(await mailsTo(breakGlass.email), 0);
  });

  test('at most one mail a minute per account; a made-up link is not found', async () => {
    // The last mail was sent over a minute ago.
    await execute('UPDATE password_resets SET created_at = ?', [new Date(Date.now() - 2 * 60_000).toISOString()]);
    const before = await mailsTo('reset.me@example.com');
    await askForReset('reset.me@example.com');
    await askForReset('reset.me@example.com');
    assert.equal(await mailsTo('reset.me@example.com'), before + 1);
    await request(app).get('/login/reset/' + 'A'.repeat(43)).expect(404);
  });
});

describe('the sign-in pages all carry the same mark', () => {
  test('the logo, or the plain shape, on every step', async () => {
    // Reported 16 Oct 2026: the first page showed the service desk's logo
    // and the password step did not, which reads as a different site
    // asking for the password.
    for (const path of ['/login', '/login/forgot']) {
      const page = await request(app).get(path).expect(200);
      assert.match(page.text, /signin-logo|signin-mark/, path + ' has the mark');
      // ...and only there: the masthead above it repeated the logo and ruled
      // a line across an empty page (asked for 16 Oct 2026).
      assert.doesNotMatch(page.text, /class="topbar"/, path + ' has no masthead');
    }
  });
});
