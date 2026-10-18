import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { settings, updateSettings, type SlaSettings } from '../src/settings/index.js';
import { addBusinessMinutes, businessMinutesBetween, slaFor } from '../src/services/sla.js';
import { createTicket, getTicketById } from '../src/services/tickets.js';
import { execute, query } from '../src/db/index.js';

let app: Express;
let admin: TestSession;
let requester: TestSession;

const CAL: SlaSettings = {
  enabled: true,
  notifyManager: false,
  timeZone: 'Europe/Prague',
  days: [1, 2, 3, 4, 5],
  start: '08:00',
  end: '17:00',
  targets: {
    urgent: { response: 30, resolution: 240 },
    high: { response: 120, resolution: 540 },
    normal: { response: 240, resolution: 540 },
    low: { response: 540, resolution: 2700 },
  },
};

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('slap.admin@example.com', 'admin');
  requester = await signInAs('slap.user@example.com', 'user');
});

describe('public holidays', () => {
  test('a holiday is skipped, dated or every year', () => {
    // Thursday 24 Dec 2026, 16:00 Prague, plus two business hours.
    const start = new Date('2026-12-24T15:00:00Z');
    const plain = addBusinessMinutes(start, 120, CAL);
    assert.equal(plain.toISOString(), '2026-12-25T08:00:00.000Z', 'Friday 25th at 09:00');
    const withHolidays = addBusinessMinutes(start, 120, { ...CAL, holidays: ['2026-12-24', '12-25'] });
    // Both days off: Monday 28th, 10:00 Prague.
    assert.equal(withHolidays.toISOString(), '2026-12-28T09:00:00.000Z');
  });

  test('business minutes between two moments, skipping a holiday', () => {
    const mon = new Date('2026-10-12T06:00:00Z'); // 08:00 Prague
    const tue = new Date('2026-10-13T15:00:00Z'); // 17:00 Prague
    assert.equal(businessMinutesBetween(mon, tue, CAL), 2 * 540);
    assert.equal(businessMinutesBetween(mon, tue, { ...CAL, holidays: ['10-13'] }), 540);
  });
});

describe('the clock pauses on hold', () => {
  test('time on hold is added to the resolution target, and the clock says Paused', async () => {
    await updateSettings({ sla: { ...CAL, pauseOnHold: true } }, null);
    const t = await createTicket({ title: 'Waits for a part', description: 'Waiting on the vendor.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    // Raised Monday 08:00 Prague; on hold from 09:00 to 13:00 the same day.
    await execute('UPDATE tickets SET created_at = ? WHERE id = ?', ['2026-10-12T06:00:00.000Z', t.id]);
    await execute(
      `INSERT INTO ticket_events (id, ticket_id, actor_id, kind, field, old_value, new_value, created_at)
       VALUES (?, ?, ?, 'field_changed', 'status', 'open', 'pending', ?), (?, ?, ?, 'field_changed', 'status', 'pending', 'open', ?)`,
      ['e1-' + t.id, t.id, admin.user.id, '2026-10-12T07:00:00.000Z', 'e2-' + t.id, t.id, admin.user.id, '2026-10-12T11:00:00.000Z'],
    );
    const row = (await getTicketById(t.id))!;
    const paused = await slaFor(row, new Date('2026-10-12T12:00:00Z'));
    // 540 business minutes + 240 on hold = 780: Monday 9 h, then 4 h on Tuesday -> 12:00 Prague.
    assert.equal(paused?.resolution.due.toISOString(), '2026-10-13T10:00:00.000Z');

    await updateSettings({ sla: { ...CAL, pauseOnHold: false } }, null);
    const running = await slaFor(row, new Date('2026-10-12T12:00:00Z'));
    assert.equal(running?.resolution.due.toISOString(), '2026-10-12T15:00:00.000Z');
  });

  test('a ticket on hold now shows Paused instead of running down', async () => {
    await updateSettings({ sla: { ...CAL, pauseOnHold: true } }, null);
    const t = await createTicket({ title: 'On hold now', description: 'Waiting on the requester.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    await execute("UPDATE tickets SET status = 'pending' WHERE id = ?", [t.id]);
    const sla = await slaFor((await getTicketById(t.id))!);
    assert.equal(sla?.resolution.state, 'paused');
    assert.notEqual(sla?.response.state, 'paused', 'the first-response clock is not paused');
  });
});

describe('the SLA page', () => {
  test('saves the pause switch and the holidays, and refuses a non-date', async () => {
    const form = (extra: Record<string, string>) => {
      const body: Record<string, string> = { _csrf: admin.csrfToken, enabled: 'on', start: '08:00', end: '17:00', days: '1', ...extra };
      for (const p of ['urgent', 'high', 'normal', 'low']) {
        body['response_' + p] = '2';
        body['resolution_' + p] = '8';
      }
      return as(admin).post('/admin/settings/templates/other/sla').type('form').send(body);
    };
    const bad = await form({ holidays: 'Christmas' }).expect(400);
    assert.match(bad.text, /is not a date/);
    await form({ pauseOnHold: 'on', holidays: '12-25\n2026-12-24\n1-1' }).expect(302);
    assert.equal(settings().sla.pauseOnHold, true);
    assert.deepEqual(settings().sla.holidays, ['12-25', '2026-12-24', '01-01']);
    const page = await as(admin).get('/admin/settings/templates/other').expect(200);
    assert.match(page.text, /name="pauseOnHold" value="on" checked/);
    assert.ok((await query('SELECT id FROM audit_log WHERE action = ?', ['settings.sla.changed'])).length >= 1);
  });
});
