import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { settings, updateSettings, type SlaSettings } from '../src/settings/index.js';
import { addBusinessMinutes, firstResponseAt, slaFor } from '../src/services/sla.js';
import { addComment, createTicket, getTicketById } from '../src/services/tickets.js';
import { execute, query } from '../src/db/index.js';
import { seedNotifications } from '../src/services/mail/notifications.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { announceSlaBreaches, notifySlaBreaches } from '../src/services/sla-alerts.js';
import { addNode, configureNode, connect, createAutomation, findAutomation, setAutomationEnabled } from '../src/services/automation.js';
import { createGroup, setGroupManager } from '../src/services/groups.js';
import { queuedMail } from './support/outbox.js';

let app: Express;
let admin: TestSession;
let agent: TestSession;
let requester: TestSession;

const PRAGUE: SlaSettings = {
  enabled: true,
  notifyManager: false,
  timeZone: 'Europe/Prague',
  days: [1, 2, 3, 4, 5],
  start: '08:00',
  end: '17:00',
  targets: {
    urgent: { response: 30, resolution: 240 },
    high: { response: 120, resolution: 540 },
    normal: { response: 240, resolution: 1620 },
    low: { response: 540, resolution: 2700 },
  },
};

function as(session: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', session.cookie);
  return a;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('sla.admin@example.com', 'admin');
  agent = await signInAs('sla.agent@example.com', 'agent');
  requester = await signInAs('sla.requester@example.com', 'user');
});

describe('business time', () => {
  test('inside the day it is plain addition', () => {
    // Tue 14 Oct 2025, 10:00 Prague (CEST, UTC+2) = 08:00Z.
    const due = addBusinessMinutes(new Date('2025-10-14T08:00:00Z'), 30, PRAGUE);
    assert.equal(due.toISOString(), '2025-10-14T08:30:00.000Z');
  });

  test('Friday evening rolls to Monday morning', () => {
    // Fri 17 Oct 2025 16:55 Prague = 14:55Z; 5 minutes left that day, 25 on Monday.
    const due = addBusinessMinutes(new Date('2025-10-17T14:55:00Z'), 30, PRAGUE);
    // Mon 20 Oct 08:25 Prague = 06:25Z.
    assert.equal(due.toISOString(), '2025-10-20T06:25:00.000Z');
  });

  test('a raise before opening starts at opening', () => {
    // Wed 15 Oct 06:00 Prague = 04:00Z -> starts 08:00, due 08:30 = 06:30Z.
    const due = addBusinessMinutes(new Date('2025-10-15T04:00:00Z'), 30, PRAGUE);
    assert.equal(due.toISOString(), '2025-10-15T06:30:00.000Z');
  });

  test('the clock change is honoured', () => {
    // Fri 24 Oct 2025 16:00 Prague (CEST) = 14:00Z; 120 minutes:
    // 60 that day, 60 on Mon 27 Oct, which is CET (UTC+1): 09:00 = 08:00Z.
    const due = addBusinessMinutes(new Date('2025-10-24T14:00:00Z'), 120, PRAGUE);
    assert.equal(due.toISOString(), '2025-10-27T08:00:00.000Z');
  });
});

describe('a ticket against its targets', () => {
  test('off by default: no clocks at all', async () => {
    assert.equal(settings().sla.enabled, false);
    const ticket = await createTicket({
      title: 'Nothing measured',
      description: 'SLA has not been switched on yet.',
      priority: 'urgent',
      category: 'other',
      requesterId: requester.user.id,
    });
    assert.equal(await slaFor(ticket), null);
  });

  test('the first public reply by staff is the response; a requester comment is not', async () => {
    await updateSettings({ sla: PRAGUE }, null);
    const ticket = await createTicket({
      title: 'Response timing',
      description: 'Checking what counts as a response.',
      priority: 'high',
      category: 'other',
      requesterId: requester.user.id,
    });
    await addComment({ ticketId: ticket.id, authorId: requester.user.id, body: 'Any news?', isInternal: false });
    await addComment({ ticketId: ticket.id, authorId: agent.user.id, body: 'Internal only', isInternal: true });
    assert.equal(await firstResponseAt(ticket), null);

    await addComment({ ticketId: ticket.id, authorId: agent.user.id, body: 'On it.', isInternal: false });
    assert.ok(await firstResponseAt(ticket));
  });

  test('past due and unanswered is breached; answered in time is met', async () => {
    const ticket = await createTicket({
      title: 'Old urgent',
      description: 'Raised a long time ago.',
      priority: 'urgent',
      category: 'other',
      requesterId: requester.user.id,
    });
    await execute('UPDATE tickets SET created_at = ? WHERE id = ?', ['2025-10-14T08:00:00.000Z', ticket.id]);
    const old = { ...ticket, created_at: '2025-10-14T08:00:00.000Z' };
    const breached = await slaFor(old, new Date('2025-10-14T12:00:00Z'));
    assert.equal(breached?.response.state, 'breached');

    await addComment({ ticketId: ticket.id, authorId: agent.user.id, body: 'Looking.', isInternal: false });
    await execute(
      "UPDATE ticket_comments SET created_at = '2025-10-14T08:10:00.000Z' WHERE ticket_id = ? AND author_id = ?",
      [ticket.id, agent.user.id],
    );
    // Due 14:00 Prague (12:00Z); an hour later it is breached.
    const met = await slaFor(old, new Date('2025-10-14T13:00:00Z'));
    assert.equal(met?.response.state, 'met');
    assert.equal(met?.resolution.state, 'breached', '4 business hours passed unresolved');
  });

  test('staff see it on the ticket and in the queue; requesters do not', async () => {
    const ticket = await createTicket({
      title: 'Visible clocks',
      description: 'Who sees the SLA.',
      priority: 'urgent',
      category: 'other',
      requesterId: requester.user.id,
    });
    await execute('UPDATE tickets SET created_at = ? WHERE id = ?', ['2025-01-06T08:00:00.000Z', ticket.id]);

    const staffPage = await as(admin).get('/tickets/' + ticket.id).expect(200);
    assert.match(staffPage.text, /<small>First response<\/small>/);
    assert.match(staffPage.text, /sla-clock sla-clock--breached/);

    const queue = await as(admin).get('/tickets?scope=all').expect(200);
    assert.match(queue.text, /SLA breached/);

    const own = await as(requester).get('/tickets/' + ticket.id).expect(200);
    assert.doesNotMatch(own.text, /First response/);
  });
});

describe('the settings page', () => {
  test('Other settings is one page: prefixes, service levels, notes and deleting', async () => {
    const page = await as(admin).get('/admin/settings/templates/other').expect(200);
    assert.match(page.text, />Reference prefixes</);
    assert.match(page.text, />Service levels</);
    assert.match(page.text, />Status notes</);
    assert.match(page.text, />Delete closed tickets</);
    // The SLA sub-tab's address opens its panel on that page.
    const sla = await as(admin).get('/admin/settings/templates/other/sla').expect(308);
    assert.equal(sla.headers.location, '/admin/settings/templates/other#sla');
  });

  test('targets are saved in hours and stored as minutes', async () => {
    const form: Record<string, string | string[]> = {
      _csrf: admin.csrfToken,
      enabled: 'on',
      timeZone: 'Europe/Prague',
      days: ['1', '2', '3', '4', '5'],
      start: '09:00',
      end: '17:30',
    };
    for (const p of ['urgent', 'high', 'normal', 'low']) {
      form['response_' + p] = '1,5';
      form['resolution_' + p] = '8';
    }
    await as(admin).post('/admin/settings/templates/other/sla').type('form').send(form).expect(302);
    assert.equal(settings().sla.targets.urgent.response, 90);
    assert.equal(settings().sla.start, '09:00');
  });

  test('impossible hours and no working days are refused on the page', async () => {
    const refused = await as(admin)
      .post('/admin/settings/templates/other/sla')
      .type('form')
      .send({ _csrf: admin.csrfToken, timeZone: 'Mars/Olympus', start: '17:00', end: '09:00' })
      .expect(400);
    // The zone is Locale's now; this page links to it.
    assert.match(refused.text, /Change under Locale/);
    assert.match(refused.text, /must end after they start/);
    assert.match(refused.text, /Choose at least one working day/);
  });
});

describe('telling the group manager about a breach', () => {
  test('once per clock, to the manager only, when the box is ticked', async () => {
    await seedNotifications();
    // Nothing is queued without a mailbox to send from.
    await createMailbox({ name: 'Desk', address: 'help@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'help@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true }, null);

    const group = await createGroup({ name: 'SLA team', description: '', isActive: true }, null);
    await setGroupManager(group.id, agent.user.id, null);
    const ticket = await createTicket({
      title: 'Late urgent',
      description: 'Nobody has touched this one.',
      priority: 'urgent',
      category: 'other',
      requesterId: requester.user.id,
    });
    await execute('UPDATE tickets SET created_at = ?, group_id = ? WHERE id = ?', [
      '2025-01-06T08:00:00.000Z',
      group.id,
      ticket.id,
    ]);

    await updateSettings({ sla: { ...PRAGUE, notifyManager: false } }, null);
    assert.equal(await notifySlaBreaches(), 0, 'off unless asked for');

    await updateSettings({ sla: { ...PRAGUE, notifyManager: true } }, null);
    assert.equal(await notifySlaBreaches(), 2, 'response and resolution both breached');
    assert.equal(await notifySlaBreaches(), 0, 'never twice');

    const queued = (await queuedMail((m) => m.subject.includes('SLA breached'))).map((m) => ({ recipient: m.to_address, subject: m.subject }));
    assert.equal(queued.length, 2);
    assert.ok(queued.every((m) => m.recipient === 'sla.agent@example.com'));
  });

  test('the SLA page offers the checkbox', async () => {
    const page = await as(admin).get('/admin/settings/templates/other').expect(200);
    assert.match(page.text, /name="notifyManager"/);
  });
});

describe('the "SLA is breached" automation trigger', () => {
  test('starts an automation once per ticket and clock, only for recent breaches', async () => {
    await updateSettings({ sla: { ...PRAGUE, notifyManager: false } }, null);
    const a = await createAutomation('Escalate late tickets', 'sla.breached', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    await configureNode(a.id, trigger, { event: 'sla.breached', clock: 'resolution' }, null);
    const note = await addNode(a.id, 'add_comment', 300, 100, null);
    await configureNode(a.id, note, { body: 'Resolution is overdue.', internal: 'on' }, null);
    await connect(a.id, trigger, 'next', note, null);
    await setAutomationEnabled(a.id, true, null);

    const fresh = await createTicket({ title: 'Just late', description: 'Overdue a little.', priority: 'urgent', category: 'other', requesterId: requester.user.id });
    const old = await createTicket({ title: 'Long late', description: 'Overdue for ages.', priority: 'urgent', category: 'other', requesterId: requester.user.id });
    await execute('UPDATE tickets SET created_at = ? WHERE id = ?', ['2025-01-06T08:00:00.000Z', old.id]);
    await execute('UPDATE tickets SET created_at = ? WHERE id = ?', ['2025-01-06T08:00:00.000Z', fresh.id]);

    // A moment just after the fresh one's resolution clock ran out.
    const clocks = (await slaFor((await getTicketById(fresh.id))!, new Date('2025-02-01T12:00:00Z')))!;
    const now = new Date(clocks.resolution.due.getTime() + 60_000);
    await execute('UPDATE tickets SET created_at = ? WHERE id = ?', ['2024-06-03T08:00:00.000Z', old.id]);

    const first = await announceSlaBreaches(now);
    assert.ok(first >= 1);
    const notes = async (id: string) =>
      (await query<{ body: string }>("SELECT body FROM ticket_comments WHERE ticket_id = ? AND body = 'Resolution is overdue.'", [id])).length;
    assert.equal(await notes(fresh.id), 1, 'the resolution breach started it');
    assert.equal(await notes(old.id), 0, 'a breach long past is recorded, not announced');

    await announceSlaBreaches(new Date(now.getTime() + 15 * 60_000));
    assert.equal(await notes(fresh.id), 1, 'never twice');
    await setAutomationEnabled(a.id, false, null);
  });
});
