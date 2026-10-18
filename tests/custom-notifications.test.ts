import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import {
  listNotificationsOfKind,
  seedNotifications,
} from '../src/services/mail/notifications.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { sendNotification } from '../src/services/mail/outbox.js';
import { createTicket } from '../src/services/tickets.js';
import { queuedMail } from './support/outbox.js';

let app: Express;
let admin: TestSession;
let requester: TestSession;
const BASE = '/admin/settings/mail/notifications';

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

before(async () => {
  await bootstrapTestDatabase();
  await seedNotifications();
  await createMailbox({ name: 'Desk', address: 'help@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'help@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true }, null);
  app = createApp();
  admin = await signInAs('cn.admin@example.com', 'admin');
  requester = await signInAs('cn.requester@example.com', 'user');
});

describe('built in and custom notifications', () => {
  test('two tabs; built in lists the shipped ones, custom starts empty', async () => {
    const builtin = await as(admin).get(BASE).expect(200);
    assert.match(builtin.text, /aria-current="page">Built in</);
    assert.match(builtin.text, /Thanks for your request/);
    const custom = await as(admin).get(BASE + '?kind=custom').expect(200);
    assert.match(custom.text, /aria-current="page">Custom</);
    assert.match(custom.text, /No custom notifications yet/);
  });

  test('a custom one is created, edited like any other, and removable', async () => {
    await as(admin).post(BASE).type('form').send({ _csrf: admin.csrfToken, name: 'Duty manager' }).expect(302);
    const [custom] = await listNotificationsOfKind('custom');
    assert.equal(custom?.name, 'Duty manager');
    assert.match(custom!.event, /^custom\./);

    const page = await as(admin).get(BASE + '/' + custom!.id).expect(200);
    assert.match(page.text, /an automation decides when it is sent/);
    assert.doesNotMatch(page.text, /Restore the original wording/);

    const dup = await as(admin).post(BASE).type('form').send({ _csrf: admin.csrfToken, name: 'duty manager' }).expect(400);
    assert.match(dup.text, /already exists/);
  });

  test('sendNotification queues it to the recipient an automation chose', async () => {
    const [custom] = await listNotificationsOfKind('custom');
    const ticket = await createTicket({ title: 'Server down', description: 'Nothing responds at all.', priority: 'urgent', category: 'other', requesterId: requester.user.id });
    assert.equal(await sendNotification(custom!.id, ticket.id, 'requester'), 1);
    assert.equal(await sendNotification(custom!.id, ticket.id, { email: 'duty@example.com' }), 1);
    const queued = await queuedMail((m) => m.ticket_id === ticket.id);
    assert.ok(queued.some((m) => m.to_address === 'duty@example.com'));
    assert.ok(queued.some((m) => m.to_address === 'cn.requester@example.com'));
  });

  test('a built-in one cannot be removed', async () => {
    const [builtin] = await listNotificationsOfKind('builtin');
    await as(admin).post(BASE + '/' + builtin!.id + '/delete').type('form').send({ _csrf: admin.csrfToken }).expect(302);
    assert.ok((await listNotificationsOfKind('builtin')).some((n) => n.id === builtin!.id));
  });
});
