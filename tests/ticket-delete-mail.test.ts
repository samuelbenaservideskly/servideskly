import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createGroup, setGroupManager } from '../src/services/groups.js';
import { createTicket } from '../src/services/tickets.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { seedNotifications } from '../src/services/mail/notifications.js';
import { queuedMail } from './support/outbox.js';

/** Deleting a ticket tells its group's manager - or, with none, the other administrators. */

let app: Express;
let admin: TestSession;
let otherAdmin: TestSession;
let manager: TestSession;
let requester: TestSession;
let groupId = '';

const remove = (ticketId: string) =>
  request.agent(app).set('Cookie', admin.cookie).post('/tickets/' + ticketId + '/delete').type('form')
    .send({ _csrf: admin.csrfToken, reason: 'Raised in error, wrong customer' });

async function sentTo(subjectPart: string): Promise<string[]> {
  return (await queuedMail((m) => m.subject.includes(subjectPart))).map((r) => r.to_address).sort();
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('del.admin@example.com', 'admin');
  otherAdmin = await signInAs('del.other@example.com', 'admin');
  manager = await signInAs('del.manager@example.com', 'agent');
  requester = await signInAs('del.requester@example.com', 'user');
  await createMailbox(
    { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
    null,
  );
  await seedNotifications();
  await execute("UPDATE mail_notifications SET is_enabled = 1 WHERE event = 'ticket.deleted.admins'");
  groupId = (await createGroup({ name: 'Network', description: '', isActive: true }, null)).id;
  await setGroupManager(groupId, manager.user.id, null);
});

describe('deleting a ticket', () => {
  test("its group's manager is told the reason, and nobody else", async () => {
    const t = await createTicket({ title: 'Routed and removed', description: 'To be deleted.', priority: 'normal', category: 'other', requesterId: requester.user.id, groupId });
    await remove(t.id).expect(302);
    assert.deepEqual(await sentTo('Routed and removed'), ['del.manager@example.com']);
  });

  test('without a group manager, the other administrators are told', async () => {
    const t = await createTicket({ title: 'Unrouted and removed', description: 'To be deleted.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    await remove(t.id).expect(302);
    const told = await sentTo('Unrouted and removed');
    assert.ok(told.includes('del.other@example.com'));
    assert.ok(!told.includes('del.admin@example.com'), 'not the one who deleted it');
    assert.ok(!told.includes('del.manager@example.com'));
    void otherAdmin;
  });
});
