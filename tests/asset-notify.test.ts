import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { seedNotifications } from '../src/services/mail/notifications.js';
import { setTransportFactory } from '../src/services/mail/transport.js';
import { queuedMail } from './support/outbox.js';
import { createAsset, updateAsset, getAsset } from '../src/services/assets.js';

/** Step 3 of assets: the person gets an email when an asset is assigned to them, or taken back. */

let app: Express;
let agent: TestSession;
let alice: TestSession;
let bob: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  await seedNotifications();
  app = createApp();
  setTransportFactory(() => ({ async send() {}, async fetch() { return []; }, async acknowledge() {} }));
  await createMailbox(
    { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
    null,
  );
  agent = await signInAs('notify.agent@example.com', 'agent');
  alice = await signInAs('notify.alice@example.com', 'user');
  bob = await signInAs('notify.bob@example.com', 'user');
});

describe('emails about assets', () => {
  test('assigned: the person is told, with the asset in the subject', async () => {
    await createAsset({ statusId: 'assigned', assignee: 'notify.alice@example.com', values: { Model: 'Pixel 9', SerialNumber: 'PX-9' } }, { id: agent.user.id });
    const mails = await queuedMail((m) => m.to_address === 'notify.alice@example.com');
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.subject, 'Pixel 9 is now assigned to you');
    assert.match(mails[0]!.body_html, /PX-9/);
  });

  test('handed to somebody else: the first is told it was taken back, the second that it is theirs', async () => {
    const id = await createAsset({ statusId: 'assigned', assignee: 'notify.alice@example.com', values: { Model: 'MacBook Air' } }, null);
    const asset = (await getAsset(id))!;
    await updateAsset(id, { statusId: asset.status_id, assignee: 'notify.bob@example.com', values: asset.field_values }, null);
    const toAlice = await queuedMail((m) => m.to_address === 'notify.alice@example.com' && m.subject.includes('MacBook Air'));
    const toBob = await queuedMail((m) => m.to_address === 'notify.bob@example.com' && m.subject.includes('MacBook Air'));
    assert.deepEqual(toAlice.map((m) => m.subject).sort(), ['MacBook Air is no longer assigned to you', 'MacBook Air is now assigned to you']);
    assert.deepEqual(toBob.map((m) => m.subject), ['MacBook Air is now assigned to you']);
  });

  test('a change that leaves the person alone sends nothing', async () => {
    const id = await createAsset({ statusId: 'in-stock', assignee: 'notify.bob@example.com', values: { Model: 'ThinkPad X1' } }, null);
    const before = (await queuedMail((m) => m.subject.includes('ThinkPad X1'))).length;
    const asset = (await getAsset(id))!;
    await updateAsset(id, { statusId: 'in-repair', assignee: 'notify.bob@example.com', values: { ...asset.field_values, Comment: 'Hinge' } }, null);
    assert.equal((await queuedMail((m) => m.subject.includes('ThinkPad X1'))).length, before);
  });

  test('the editor lists the asset variables and previews with an invented asset', async () => {
    const admin = await signInAs('notify.admin@example.com', 'admin');
    const list = await request(app).get('/admin/settings/mail/notifications').set('Cookie', admin.cookie).expect(200);
    const id = /href="\/admin\/settings\/mail\/notifications\/([0-9a-f-]{36})"[^>]*>\s*An asset is assigned to you/.exec(list.text)?.[1];
    assert.ok(id, 'listed among the notifications');
    const page = await request(app).get('/admin/settings/mail/notifications/' + id).set('Cookie', admin.cookie).expect(200);
    assert.match(page.text, /SerialNumber/);
    assert.match(page.text, /Latitude 7440 is now assigned to you/);
    void bob;
    void alice;
  });
});
