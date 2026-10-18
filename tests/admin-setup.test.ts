import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { createApp } from '../src/app.js';
import { query, queryOne } from '../src/db/index.js';
import { signSetupToken } from '../src/auth/setup-token.js';
import { signPortalRequest } from '../src/auth/portal-admins.js';
import { createLocalAccount, verifyLocalSignIn } from '../src/auth/local-accounts.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { findUserByEmail } from '../src/services/users.js';
import { provisionOnLogin } from '../src/auth/provisioning.js';
import { signInAs } from './support/session.js';

/**
 * The administrators the customer portal manages (asked for 17 Oct 2026):
 * a signed list, applied whole; an invitation for an address with no
 * account; an identity provider's account promoted when it arrives; a
 * removal demotes; and nobody here can demote one the portal lists.
 */
let app: Express;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  // Invitations need somewhere to be sent from.
  await createMailbox(
    { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
    null,
  );
});

let clock = Date.now() - 60_000;
/** Sends a list as the portal does: signed, and each newer than the last. */
function send(admins: string[], opts: { at?: number; signature?: string } = {}) {
  const body = JSON.stringify({ administrators: admins });
  clock += 1000;
  const at = opts.at ?? clock;
  return request(app)
    .post('/portal-sync/administrators')
    .set('content-type', 'application/json')
    .set('x-portal-signature', opts.signature ?? signPortalRequest(body, at))
    .send(body);
}

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

const inADay = () => Date.now() + 24 * 3600_000;

describe('the signed list', () => {
  test('an unsigned, mis-signed, stale or replayed request is refused, all alike', async () => {
    await send(['x@example.com'], { signature: 'nonsense' }).expect(401);
    await send(['x@example.com'], { signature: signPortalRequest('{"administrators":[]}', clock) }).expect(401);
    await send(['x@example.com'], { at: Date.now() - 10 * 60_000 }).expect(401);
    const body = JSON.stringify({ administrators: [] });
    const at = (clock += 1000);
    const sig = signPortalRequest(body, at);
    const first = () => request(app).post('/portal-sync/administrators').set('content-type', 'application/json').set('x-portal-signature', sig).send(body);
    await first().expect(200);
    await first().expect(401);
    assert.equal(await findUserByEmail('x@example.com'), undefined);
  });

  test('an existing account is promoted and told; an unknown address is invited', async () => {
    const existing = await createLocalAccount({ email: 'kept@example.com', displayName: 'Kept', role: 'user', password: 'A long enough passphrase-1' }, null);
    const res = await send(['Kept@Example.com', 'new.admin@example.com']).expect(200);
    assert.deepEqual(res.body.administrators, { 'kept@example.com': 'active', 'new.admin@example.com': 'invited' });
    assert.equal((await findUserByEmail('kept@example.com'))?.id, existing.id);
    assert.equal((await findUserByEmail('kept@example.com'))?.role, 'admin');
    const mail = await query<{ to_address: string; body_html: string }>('SELECT to_address, body_html FROM mail_outbox ORDER BY created_at');
    const invite = mail.find((m) => m.to_address === 'new.admin@example.com');
    assert.ok(invite, 'the new address is invited');
    assert.match(invite!.body_html, /Set up your password/);
    assert.match(invite!.body_html, /cid:logo/, 'with the logo');
    assert.match(invite!.body_html, /\/setup\?t=/);
    assert.ok(mail.find((m) => m.to_address === 'kept@example.com'), 'the existing one is told too');

    // Sent again, nobody is told twice.
    const before = mail.length;
    await send(['kept@example.com', 'new.admin@example.com']).expect(200);
    assert.equal((await query('SELECT id FROM mail_outbox')).length, before);
  });

  test('the invitation sets a password once, and gives an administrator', async () => {
    const t = signSetupToken('new.admin@example.com', inADay());
    const agent = request.agent(app);
    const page = await agent.get('/setup').query({ t }).expect(200);
    assert.match(page.text, /value="new.admin@example.com"/);
    // The eye beside both boxes, and the rules box: our one script, from /assets only.
    assert.match(page.text, /password-reveal\.js/);
    assert.equal((page.text.match(/password-reveal__toggle/g) ?? []).length, 2);
    assert.match(page.text, /<label for="confirmPassword">Confirm password<\/label>/);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
    const mismatch = await agent.post('/setup').type('form')
      .send({ _csrf: csrfFrom(page.text), t, password: 'A long enough passphrase-1', confirmPassword: 'another one' })
      .expect(400);
    assert.match(mismatch.text, /The two passwords do not match/);
    // Sent twice at once, as a double-click does: both land on sign-in, one account.
    const submit = () => agent.post('/setup').type('form')
      .send({ _csrf: csrfFrom(page.text), t, password: 'A long enough passphrase-1', confirmPassword: 'A long enough passphrase-1' });
    const answers = await Promise.all([submit(), submit()]);
    assert.deepEqual(answers.map((r) => r.status), [303, 303]);
    const signedIn = await verifyLocalSignIn('new.admin@example.com', 'A long enough passphrase-1');
    assert.equal(signedIn.user.role, 'admin');
    const again = await request(app).get('/setup').query({ t }).expect(200);
    assert.match(again.text, /already set up/);
  });

  test('a link for an address the portal does not list is refused', async () => {
    const res = await request(app).get('/setup').query({ t: signSetupToken('stranger@example.com', inADay()) }).expect(400);
    assert.match(res.text, /not valid any more/);
  });

  test('a listed address that signs in through an identity provider is an administrator, with no password', async () => {
    await send(['kept@example.com', 'new.admin@example.com', 'sso.person@example.com']).expect(200);
    const { user } = await provisionOnLogin(
      { issuer: 'https://login.microsoftonline.com/test-tenant/v2.0', externalId: 'oid-sso-person', email: 'sso.person@example.com', upn: null, displayName: 'Sso Person' },
      'jit',
    );
    const { promoteIfListed } = await import('../src/auth/portal-admins.js');
    assert.equal((await promoteIfListed(user)).role, 'admin');
    const link = await request(app).get('/setup').query({ t: signSetupToken('sso.person@example.com', inADay()) }).expect(200);
    assert.match(link.text, /organisation account/);
  });

  test('nobody here can demote one the portal lists; leaving the list demotes', async () => {
    const other = await signInAs('in.app.admin@example.com', 'admin');
    const listed = (await findUserByEmail('kept@example.com'))!;
    const page = await request(app).get('/admin/settings/users/' + listed.id).set('Cookie', other.cookie).expect(200);
    assert.match(page.text, /managed in the customer portal/);
    const refused = await request(app).post('/admin/settings/users/' + listed.id + '/role')
      .set('Cookie', other.cookie).type('form').send({ _csrf: other.csrfToken, role: 'user' });
    assert.equal(refused.status, 409);
    assert.equal((await findUserByEmail('kept@example.com'))?.role, 'admin');

    await send(['new.admin@example.com']).expect(200);
    assert.equal((await findUserByEmail('kept@example.com'))?.role, 'user');
    assert.equal((await findUserByEmail('sso.person@example.com'))?.role, 'user');
    // An administrator promoted here, never on the list, is left alone.
    assert.equal((await findUserByEmail('in.app.admin@example.com'))?.role, 'admin');
    await (await import('../src/lib/audit.js')).flushAudit();
    const audit = await queryOne<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'portal.admins.applied'");
    assert.ok(Number(audit?.n) >= 3);
  });

  test('once the portal keeps the list, nobody is made an administrator here', async () => {
    const actor = await signInAs('promoter@example.com', 'admin');
    const plain = await signInAs('wants.admin@example.com', 'user');
    const refused = await request(app).post('/admin/settings/users/' + plain.user.id + '/role')
      .set('Cookie', actor.cookie).type('form').send({ _csrf: actor.csrfToken, role: 'admin' });
    assert.equal(refused.status, 409);
    assert.equal((await findUserByEmail('wants.admin@example.com'))?.role, 'user');
    // A technician is still fine, and the page says where administrators come from.
    await request(app).post('/admin/settings/users/' + plain.user.id + '/role')
      .set('Cookie', actor.cookie).type('form').send({ _csrf: actor.csrfToken, role: 'agent' }).expect(302);
    const page = await request(app).get('/admin/settings/users/' + plain.user.id).set('Cookie', actor.cookie).expect(200);
    assert.match(page.text, /added in the customer portal/);
    assert.doesNotMatch(page.text, /<option value="admin"/);
  });
});
