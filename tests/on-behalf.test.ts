import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute, query } from '../src/db/index.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { configureField, createTemplate, ensureDefaultTemplate, findTemplate, placeField } from '../src/services/templates.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { seedNotifications } from '../src/services/mail/notifications.js';
import { setTransportFactory } from '../src/services/mail/transport.js';
import { queuedMail } from './support/outbox.js';

let app: Express;
let raiser: TestSession;
let colleague: TestSession;
let stranger: TestSession;
let templateId = '';

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  await seedNotifications();
  app = createApp();
  setTransportFactory(() => ({ async send() {}, async fetch() { return []; }, async acknowledge() {} }));
  await createMailbox(
    { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
    null,
  );
  raiser = await signInAs('ob.raiser@example.com', 'user');
  colleague = await signInAs('ob.colleague@example.com', 'user');
  stranger = await signInAs('ob.stranger@example.com', 'user');
  const t = await createTemplate(
    { summary: '', title: '', body: '', priority: 'normal', category: 'other', type: 'service_request', groupId: null, categoryId: null, fields: [], isActive: true, name: 'For a colleague' },
    null,
  );
  templateId = t.id;
  await placeField((await findTemplate(t.id))!, 'title', null, null);
  await placeField((await findTemplate(t.id))!, 'onbehalf', null, null);
});

describe('On behalf of', () => {
  test('the form offers it, and the ticket becomes the colleague\'s', async () => {
    const page = await as(raiser).get('/tickets/new?template=' + templateId).expect(200);
    assert.match(page.text, /name="onBehalfOf" type="email"/);

    await post(raiser, '/tickets', { templateId, title: 'New monitor for Eva', onBehalfOf: 'ob.colleague@example.com' }).expect(302);
    const row = (await query<{ id: string; requester_id: string; raised_by: string | null }>(
      "SELECT id, requester_id, raised_by FROM tickets WHERE title = 'New monitor for Eva'",
    ))[0]!;
    assert.equal(row.requester_id, colleague.user.id);
    assert.equal(row.raised_by, raiser.user.id);

    // Both can follow it; nobody else can.
    const page2 = await as(raiser).get('/tickets/' + row.id).expect(200);
    assert.match(page2.text, /Raised by/);
    await as(colleague).get('/tickets/' + row.id).expect(200);
    await as(stranger).get('/tickets/' + row.id).expect(404);
    const list = await as(raiser).get('/tickets').expect(200);
    assert.match(list.text, /New monitor for Eva/);
  });

  test('the colleague is told who raised it, instead of the usual thanks', async () => {
    const mails = await queuedMail((m) => m.subject.includes('New monitor for Eva'));
    const toColleague = mails.filter((m) => m.to_address === 'ob.colleague@example.com');
    assert.equal(toColleague.length, 1);
    assert.match(toColleague[0]!.subject, /raised a request for you/);
    assert.equal(mails.filter((m) => m.to_address === 'ob.raiser@example.com').length, 0);
  });

  test('an unknown or disabled address is refused beside the field', async () => {
    const unknown = await post(raiser, '/tickets', { templateId, title: 'For nobody', onBehalfOf: 'nobody@example.com' }).expect(400);
    assert.match(unknown.text, /There is no active account with that address/);
    await execute("UPDATE users SET status = 'disabled' WHERE id = ?", [stranger.user.id]);
    await post(raiser, '/tickets', { templateId, title: 'For a disabled one', onBehalfOf: 'ob.stranger@example.com' }).expect(400);
  });

  test('left empty, or one\'s own address, it is an ordinary ticket; mandatory, it must be given', async () => {
    await post(raiser, '/tickets', { templateId, title: 'For myself' }).expect(302);
    const mine = (await query<{ requester_id: string; raised_by: string | null }>("SELECT requester_id, raised_by FROM tickets WHERE title = 'For myself'"))[0]!;
    assert.deepEqual([mine.requester_id, mine.raised_by], [raiser.user.id, null]);

    await configureField((await findTemplate(templateId))!, 'onbehalf', { mode: 'mandatory' }, null);
    const refused = await post(raiser, '/tickets', { templateId, title: 'Who for?' }).expect(400);
    assert.match(refused.text, /Who is this request for\?/);
  });

  test('not settable when the form does not offer it', async () => {
    const plain = await createTemplate(
      { summary: '', title: '', body: '', priority: 'normal', category: 'other', type: 'incident', groupId: null, categoryId: null, fields: [], isActive: true, name: 'No on behalf' },
      null,
    );
    await placeField((await findTemplate(plain.id))!, 'title', null, null);
    await post(raiser, '/tickets', { templateId: plain.id, title: 'Forged behalf', onBehalfOf: 'ob.colleague@example.com' }).expect(302);
    const row = (await query<{ requester_id: string }>("SELECT requester_id FROM tickets WHERE title = 'Forged behalf'"))[0]!;
    assert.equal(row.requester_id, raiser.user.id);
  });
});

describe('the Requester field', () => {
  test('the form shows who is asking with the ticked details; the ticket shows them to the service desk', async () => {
    await execute("UPDATE users SET phone = '+420 111 222 333', department = 'Finance' WHERE id = ?", [colleague.user.id]);
    const t = await createTemplate(
      { summary: '', title: '', body: '', priority: 'normal', category: 'other', type: 'service_request', groupId: null, categoryId: null, fields: [], isActive: true, name: 'With requester' },
      null,
    );
    await placeField((await findTemplate(t.id))!, 'title', null, null);
    await placeField((await findTemplate(t.id))!, 'requester', null, null);
    await configureField((await findTemplate(t.id))!, 'requester', { mode: 'view_only', details: ['phone', 'department'] }, null);

    const form = await as(colleague).get('/tickets/new?template=' + t.id).expect(200);
    assert.match(form.text, /class="requester-card"/);
    assert.match(form.text, /\+420 111 222 333/);
    assert.match(form.text, /Finance/);
    assert.doesNotMatch(form.text, /requester-card__line"><span class="muted">Email/, 'email not ticked');

    await post(colleague, '/tickets', { templateId: t.id, title: 'Requester details please', requester: 'forged' }).expect(302);
    const row = (await query<{ id: string }>("SELECT id FROM tickets WHERE title = 'Requester details please'"))[0]!;
    const staff = await signInAs('ob.agent@example.com', 'agent');
    const page = await as(staff).get('/tickets/' + row.id).expect(200);
    assert.match(page.text, /Phone:<\/span> \+420 111 222 333/);
  });
});
