import './env.js';
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { flushOutbox, queueMail } from '../src/services/mail/outbox.js';
import { setTransportFactory, type OutgoingMessage } from '../src/services/mail/transport.js';

const sent: OutgoingMessage[] = [];
let mailboxId = '';

before(async () => {
  await bootstrapTestDatabase();
  setTransportFactory(() => ({
    async send(m: OutgoingMessage) {
      sent.push(m);
    },
    async fetch() {
      return [];
    },
    async acknowledge() {},
  }));
  const box = await createMailbox(
    { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
    null,
  );
  mailboxId = box.id;
});

test('urgent mail jumps a backlog, and two flushes never send a message twice', async () => {
  for (let i = 0; i < 30; i += 1) {
    await queueMail({ mailboxId, ticketId: null, to: 'n' + i + '@example.com', subject: 'Notification ' + i, bodyHtml: '<p>x</p>' });
  }
  await queueMail({ mailboxId, ticketId: null, to: 'me@example.com', subject: 'Your sign-in code: 123456', bodyHtml: '<p>123456</p>', urgent: true });

  // Two at once, as the timer and a sign-in code can: one sender, one copy each.
  await Promise.all([flushOutbox(), flushOutbox()]);
  assert.equal(sent[0]?.subject, 'Your sign-in code: 123456');
  assert.equal(sent.length, 31);
  assert.equal(new Set(sent.map((m) => m.to)).size, 31);
});
