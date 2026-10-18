import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute, query, queryOne } from '../src/db/index.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { setTransportFactory, type MailTransport, type OutgoingMessage } from '../src/services/mail/transport.js';
import type { MailboxRow } from '../src/services/mail/mailboxes.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { flushOutbox, sendNotification } from '../src/services/mail/outbox.js';
import { sendOverSmtp } from '../src/services/mail/smtp.js';
import { createLocalAccount } from '../src/auth/local-accounts.js';
import { createCustomNotification } from '../src/services/mail/notifications.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { createTicket } from '../src/services/tickets.js';
import { createGroup } from '../src/services/groups.js';
import { adoptLegacyRelay, findRelay, listRelays, relayPassword } from '../src/services/mail/relay.js';
import { queuedMail } from './support/outbox.js';

const RELAY = '/admin/settings/mail/relay';

let app: Express;
let admin: TestSession;
const sent: { from: MailboxRow; message: OutgoingMessage }[] = [];

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string | string[]> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}

const relayForm = (name: string, from: string, extra: Record<string, string | string[]> = {}) => ({
  name, enabled: 'on', host: 'relay.example.com', port: '587', security: 'starttls', username: '', password: '', fromAddress: from, fromName: name, ...extra,
});
async function relayId(name: string): Promise<string> {
  return (await queryOne<{ id: string }>('SELECT id FROM smtp_relays WHERE name = ?', [name]))!.id;
}
async function sendAndFlush(notificationId: string, groupId: string | null): Promise<string[]> {
  const ticket = await createTicket({ title: 'Relay ' + Math.random(), description: 'Through a relay.', priority: 'normal', category: 'other', requesterId: admin.user.id, groupId });
  await execute("UPDATE mail_outbox SET status = 'sent'");
  sent.length = 0;
  await sendNotification(notificationId, ticket.id, { email: 'someone@example.com' });
  await flushOutbox();
  return sent.map((s) => s.from.address);
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  setTransportFactory((mailbox) => {
    const fake: MailTransport = {
      async send(message) {
        sent.push({ from: mailbox, message });
      },
      async fetch() {
        return [];
      },
      async acknowledge() {},
    };
    return fake;
  });
  admin = await signInAs('relay.admin@example.com', 'admin');
});

describe('adding relays', () => {
  test('refuses a password over an unencrypted connection, and never echoes it', async () => {
    const refused = await post(admin, RELAY, relayForm('Plain', 'plain@example.com', { port: '25', security: 'none', username: 'svc', password: 'pw' })).expect(400);
    assert.match(refused.text, /never sent without TLS/);
    assert.doesNotMatch(refused.text, /value="pw"/);
    assert.match(refused.text, /dialog--open/);
    assert.equal((await listRelays()).length, 0);
  });

  test('the first is the default; its password is sealed, never shown, and blank keeps it', async () => {
    await post(admin, RELAY, relayForm('Office', 'desk@example.com', { username: 'svc', password: 'relay-secret' })).expect(302);
    const office = (await findRelay(await relayId('Office')))!;
    assert.equal(office.is_default, true);
    assert.equal(relayPassword(office), 'relay-secret');
    const page = await as(admin).get(RELAY).expect(200);
    assert.doesNotMatch(page.text, /relay-secret/);
    assert.match(page.text, /placeholder="Unchanged"/);
    assert.doesNotMatch(JSON.stringify(await query('SELECT * FROM smtp_relays')), /relay-secret/);

    await post(admin, RELAY + '/' + office.id, relayForm('Office', 'desk@example.com', { username: 'svc', password: '' })).expect(302);
    assert.equal(relayPassword((await findRelay(office.id))!), 'relay-secret');
  });

  test('a second relay, and a name may not be used twice', async () => {
    await post(admin, RELAY, relayForm('Office', 'other@example.com')).expect(400);
    await post(admin, RELAY, relayForm('Partner', 'partner@example.com')).expect(302);
    const partner = (await findRelay(await relayId('Partner')))!;
    assert.equal(partner.is_default, false);
  });

  test('the test message goes through the chosen relay, from its own address', async () => {
    sent.length = 0;
    await post(admin, RELAY + '/test', { relayId: await relayId('Partner'), to: 'me@example.com' }).expect(302);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.from.address, 'partner@example.com');
    assert.equal(sent[0]!.from.kind as string, 'relay');
  });

  test('a password is refused over plain SMTP at the client too', async () => {
    await assert.rejects(
      sendOverSmtp({ host: '127.0.0.1', port: 1, implicitTls: false, plain: true, username: 'u', password: 'p' }, {
        from: 'a@example.com', fromName: '', to: 'b@example.com', subject: 's', html: 'h', messageId: '<x@y>',
      }),
      /never sent without TLS/,
    );
  });
});

describe('which relay sends', () => {
  let note: string;
  let hardware: string;
  let network: string;

  before(async () => {
    hardware = (await createGroup({ name: 'Hardware', description: '', isActive: true }, null)).id;
    network = (await createGroup({ name: 'Network', description: '', isActive: true }, null)).id;
    note = (await createCustomNotification('Relay note', null)).id;
  });

  test('a notification pinned to one relay uses that relay', async () => {
    const page = await as(admin).get('/admin/settings/mail/notifications/' + note).expect(200);
    assert.match(page.text, /value="relay:/);
    await post(admin, '/admin/settings/mail/notifications/' + note, {
      subject: 'Hello', bodyHtml: '<p>Hi</p>', isEnabled: 'on', mailboxId: 'relay:' + (await relayId('Partner')),
    }).expect(302);
    assert.deepEqual(await sendAndFlush(note, hardware), ['partner@example.com']);
  });

  test("the ticket's own relay: its group's, else the default", async () => {
    // Hardware follows Partner; Network follows nothing.
    await post(admin, RELAY + '/' + (await relayId('Partner')), relayForm('Partner', 'partner@example.com', { groupIds: [hardware] })).expect(302);
    await post(admin, '/admin/settings/mail/notifications/' + note, { subject: 'Hello', bodyHtml: '<p>Hi</p>', isEnabled: 'on', mailboxId: 'relay' }).expect(302);
    assert.deepEqual(await sendAndFlush(note, hardware), ['partner@example.com']);
    assert.deepEqual(await sendAndFlush(note, network), ['desk@example.com']);
    assert.deepEqual(await sendAndFlush(note, null), ['desk@example.com']);
  });

  test('a group follows one relay: ticking it elsewhere moves it', async () => {
    await post(admin, RELAY + '/' + (await relayId('Office')), relayForm('Office', 'desk@example.com', { groupIds: [hardware, network] })).expect(302);
    const rows = await query<{ group_id: string; relay_id: string }>('SELECT * FROM smtp_relay_groups');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.relay_id === rows[0]!.relay_id));
    // Back as it was, for what follows.
    await post(admin, RELAY + '/' + (await relayId('Partner')), relayForm('Partner', 'partner@example.com', { groupIds: [hardware] })).expect(302);
    await post(admin, RELAY + '/' + (await relayId('Office')), relayForm('Office', 'desk@example.com', { groupIds: [network] })).expect(302);
  });

  test('a pinned relay that is switched off sends nothing', async () => {
    await post(admin, '/admin/settings/mail/notifications/' + note, {
      subject: 'Hello', bodyHtml: '<p>Hi</p>', isEnabled: 'on', mailboxId: 'relay:' + (await relayId('Partner')),
    }).expect(302);
    const partner = (await findRelay(await relayId('Partner')))!;
    await post(admin, RELAY + '/' + partner.id, relayForm('Partner', 'partner@example.com', { enabled: '', groupIds: [hardware] })).expect(302);
    assert.deepEqual(await sendAndFlush(note, hardware), []);
    // A group whose relay is off falls back to the default.
    await post(admin, '/admin/settings/mail/notifications/' + note, { subject: 'Hello', bodyHtml: '<p>Hi</p>', isEnabled: 'on', mailboxId: 'relay' }).expect(302);
    assert.deepEqual(await sendAndFlush(note, hardware), ['desk@example.com']);
    await post(admin, RELAY + '/' + partner.id, relayForm('Partner', 'partner@example.com', { groupIds: [hardware] })).expect(302);
  });

  test('"only through relays": a notification naming a mailbox goes through the group relay', async () => {
    const box = await createMailbox({ name: 'Desk', address: 'help@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'help@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: true, isActive: true }, null);
    await post(admin, '/admin/settings/mail/notifications/' + note, { subject: 'Hello', bodyHtml: '<p>Hi</p>', isEnabled: 'on', mailboxId: box.id }).expect(302);
    assert.deepEqual(await sendAndFlush(note, hardware), ['help@example.com'], 'off: the mailbox it names');

    await post(admin, RELAY + '/options', { relaysOnly: 'on' }).expect(302);
    assert.equal(settings().smtpRelay.relaysOnly, true);
    assert.deepEqual(await sendAndFlush(note, hardware), ['partner@example.com']);
    assert.deepEqual(await sendAndFlush(note, network), ['desk@example.com']);
    const mailboxes = await as(admin).get('/admin/settings/mail').expect(200);
    assert.match(mailboxes.text, /The mailboxes\s+only read mail/);
  });

  test('sign-in codes go through the default relay while notifications do', async () => {
    await createLocalAccount({ displayName: 'Coder', email: 'coder@example.com', role: 'user', password: 'A-long-enough-test-passphrase-1', mustChange: false }, null);
    await post(admin, '/admin/settings/users/sign-in-codes', { otpEnabled: 'on' }).expect(302);
    const agent = request.agent(app);
    const login = await agent.get('/login');
    const csrf = /name="_csrf" value="([^"]+)"/.exec(login.text)![1]!;
    await agent.post('/auth/local/code').type('form').send({ _csrf: csrf, email: 'coder@example.com' }).expect(302);
    const queued = await queuedMail((m) => m.to_address === 'coder@example.com');
    assert.equal(queued.length, 1);
    assert.equal(Boolean(queued[0]!.via_relay), true);
    assert.equal(queued[0]!.relay_id, await relayId('Office'));
  });
});

describe('removing relays', () => {
  test('the default hands on; the last one sends its notifications back to the mailboxes and turns the switches off', async () => {
    const office = await relayId('Office');
    const partner = await relayId('Partner');
    await post(admin, RELAY + '/' + office + '/delete').expect(302);
    assert.equal((await findRelay(partner))!.is_default, true);
    assert.equal(settings().smtpRelay.relaysOnly, true, 'a relay is left, so the switch stays');

    const note = (await queryOne<{ id: string }>("SELECT id FROM mail_notifications WHERE name = 'Relay note'"))!.id;
    await post(admin, '/admin/settings/mail/notifications/' + note, { subject: 'Hello', bodyHtml: '<p>Hi</p>', isEnabled: 'on', mailboxId: 'relay:' + partner }).expect(302);
    await post(admin, RELAY + '/' + partner + '/delete').expect(302);
    const n = (await queryOne<{ via_relay: boolean; relay_id: string | null }>('SELECT via_relay, relay_id FROM mail_notifications WHERE id = ?', [note]))!;
    assert.deepEqual([Boolean(n.via_relay), n.relay_id], [false, null]);
    assert.deepEqual([settings().smtpRelay.relaysOnly, settings().smtpRelay.useForCodes], [false, false]);
  });

  test('"only through relays" is refused with no relay able to send', async () => {
    const res = await post(admin, RELAY + '/options', { relaysOnly: 'on' }).expect(400);
    assert.match(res.text, /default relay that can send first/);
  });
});

describe('the relay from before', () => {
  test('moves from the settings into a row at start-up, password and all, and the settings copy is cleared', async () => {
    await updateSettings({ smtpRelay: { enabled: true, host: 'old.example.com', port: 465, security: 'tls', username: 'old', password: 'old-secret', fromAddress: 'old@example.com', fromName: 'Old' } }, null);
    await adoptLegacyRelay();
    const rows = await listRelays();
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual([row.host, row.port, row.security, row.username, row.from_address, row.is_default], ['old.example.com', 465, 'tls', 'old', 'old@example.com', true]);
    assert.equal(relayPassword(row), 'old-secret');
    assert.equal(settings().smtpRelay.host, '');
    // Running again adds nothing.
    await adoptLegacyRelay();
    assert.equal((await listRelays()).length, 1);
  });
});
