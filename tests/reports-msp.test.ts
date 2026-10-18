import './env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createGroup, setGroupManager, setMembersWithin } from '../src/services/groups.js';
import { createTicket } from '../src/services/tickets.js';
import { updateSettings } from '../src/settings/index.js';
import { ageBucket, buildReport, timeStats } from '../src/services/reports.js';
import { findUserById } from '../src/services/users.js';

/**
 * The reporting module's promises: every figure has a list behind it that
 * counts the same tickets; comparisons, backlog and age are worked out from
 * the tickets' own dates and events; a reader reaches no further through a
 * list or a download than through the page.
 */

const DAY = 86_400_000;
const MIN = 60_000;
let app: Express;
let admin: TestSession;
let manager: TestSession;
let tech: TestSession;
let other: TestSession;
let alpha = '';
const now = Date.now();
const at = (ms: number) => new Date(now + ms).toISOString();

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

async function event(ticketId: string, actorId: string, from: string, to: string, when: number) {
  await execute(
    "INSERT INTO ticket_events (id, ticket_id, actor_id, kind, field, old_value, new_value, created_at) VALUES (?, ?, ?, 'field_changed', 'status', ?, ?, ?)",
    [randomUUID(), ticketId, actorId, from, to, at(when)],
  );
}

async function raise(title: string, priority: 'urgent' | 'high' | 'normal' | 'low', groupId: string | null, requesterId: string, ago: number) {
  const t = await createTicket({ title, description: 'For the MSP report.', priority, category: 'other', requesterId, ...(groupId ? { groupId } : {}) });
  await execute('UPDATE tickets SET created_at = ?, updated_at = ? WHERE id = ?', [at(-ago), at(-ago), t.id]);
  await execute("DELETE FROM ticket_events WHERE ticket_id = ? AND kind <> 'created'", [t.id]);
  return t.id;
}

/** The number in the list's heading. */
async function listed(s: TestSession, query: string): Promise<{ total: number; text: string }> {
  const res = await as(s).get('/reports/tickets?' + query).expect(200);
  const m = /class="report-count">(\d+)</.exec(res.text);
  return { total: Number(m?.[1] ?? -1), text: res.text };
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('msp.admin@example.com', 'admin');
  manager = await signInAs('msp.manager@example.com', 'agent');
  tech = await signInAs('msp.tech@example.com', 'agent');
  other = await signInAs('msp.other@example.com', 'agent');
  const requester = await signInAs('msp.requester@contoso.com', 'user');
  await execute("UPDATE users SET company = 'Contoso' WHERE id = ?", [requester.user.id]);

  // Round the clock, so business time is calendar time and nothing depends
  // on the day the tests run.
  await updateSettings({
    sla: {
      enabled: true, notifyManager: false, timeZone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59',
      targets: { urgent: { response: 30, resolution: 240 }, high: { response: 120, resolution: 540 }, normal: { response: 240, resolution: 1620 }, low: { response: 540, resolution: 2700 } },
    },
  } as never, null);

  alpha = (await createGroup({ name: 'Alpha', description: '', isActive: true }, null)).id;
  const beta = (await createGroup({ name: 'Beta', description: '', isActive: true }, null)).id;
  await setMembersWithin(alpha, [tech.user.id], [tech.user.id], null);
  await setMembersWithin(beta, [other.user.id], [other.user.id], null);
  await setGroupManager(alpha, manager.user.id, null);
  const req = requester.user.id;

  // Answered in ten minutes, resolved a day later: response met, resolution breached.
  const t1 = await raise('Server down', 'urgent', alpha, req, 10 * DAY);
  await event(t1, tech.user.id, 'open', 'in_progress', -10 * DAY + 10 * MIN);
  await event(t1, tech.user.id, 'in_progress', 'resolved', -9 * DAY);
  await execute("UPDATE tickets SET status = 'resolved', resolved_at = ? WHERE id = ?", [at(-9 * DAY), t1]);
  // Nobody has looked at it: both clocks past their targets.
  await raise('Printer jams', 'normal', alpha, req, 5 * DAY);
  // Resolved in half an hour: both targets met.
  const t3 = await raise('Password reset', 'normal', alpha, req, 2 * DAY);
  await event(t3, tech.user.id, 'open', 'resolved', -2 * DAY + 30 * MIN);
  await execute("UPDATE tickets SET status = 'resolved', resolved_at = ? WHERE id = ?", [at(-2 * DAY + 30 * MIN), t3]);
  // Cancelled, restored and cancelled again: one cancelled ticket.
  const t4 = await raise('Not needed', 'low', alpha, req, 3 * DAY);
  await event(t4, tech.user.id, 'open', 'cancelled', -2 * DAY);
  await event(t4, tech.user.id, 'cancelled', 'open', -1.5 * DAY);
  await event(t4, tech.user.id, 'open', 'cancelled', -1 * DAY);
  await execute("UPDATE tickets SET status = 'cancelled' WHERE id = ?", [t4]);
  // Raised before the period, reopened twice in it: one reopened ticket, and old.
  const t5 = await raise('Old open one', 'normal', alpha, req, 40 * DAY);
  await event(t5, tech.user.id, 'resolved', 'open', -6 * DAY);
  await event(t5, tech.user.id, 'closed', 'open', -3 * DAY);
  // Routed to nobody, and another group's.
  await raise('Unrouted request', 'normal', null, req, 1 * DAY);
  await raise('Beta thing', 'normal', beta, req, 1 * DAY);
});

describe('calculations', () => {
  test('median, mean and P90 (nearest rank); nothing gives nothing', () => {
    assert.deepEqual(timeStats([10, 1, 4, 2, 3]), { n: 5, median: 3, mean: 4, p90: 10 });
    assert.deepEqual(timeStats([]), { n: 0, median: null, mean: null, p90: null });
  });

  test('age buckets meet without gaps', () => {
    assert.equal(ageBucket(0.5), 'lt1');
    assert.equal(ageBucket(1), 'd1_7');
    assert.equal(ageBucket(7), 'd8_14');
    assert.equal(ageBucket(14), 'd15_30');
    assert.equal(ageBucket(30), 'gt30');
  });

  test('the figures come from the tickets and their events', async () => {
    const r = (await buildReport((await findUserById(manager.user.id))!, { group: alpha, period: '30' }))!;
    assert.deepEqual(
      { raised: r.totals.raised, resolved: r.totals.resolved, cancelled: r.totals.cancelled, reopened: r.totals.reopened, open: r.totals.backlog },
      { raised: 4, resolved: 2, cancelled: 1, reopened: 1, open: 2 },
    );
    assert.deepEqual(r.backlog, { start: 1, end: 2 }, 'the old ticket was open at the start; at the end it and the printer are');
    assert.equal(r.sla.response.breached, 1);
    assert.equal(r.sla.resolution.breached, 2);
    assert.equal(r.sla.response.met, 2);
    assert.equal(r.reopenRate, 50);
    assert.equal(r.previous?.totals.raised, 1, 'the period before holds the old ticket');
    assert.equal(r.aging.buckets.find((b) => b.key === 'gt30')?.count, 1);
    assert.equal(r.timing.resolution.n, 2);
    assert.ok(r.timing.resolutionBusiness, 'business time is reported while SLA is on');
  });
});

describe('the tickets behind each figure', () => {
  test('every list counts what its figure counts', async () => {
    const r = (await buildReport((await findUserById(manager.user.id))!, { group: alpha, period: '30' }))!;
    const breached = r.byPriority.reduce((n, p) => n + p.breached, 0);
    const expected: [string, number][] = [
      ['raised', r.totals.raised],
      ['resolved', r.totals.resolved],
      ['closed', r.totals.closed],
      ['cancelled', r.totals.cancelled],
      ['reopened', r.totals.reopened],
      ['open', r.totals.backlog],
      ['breached', breached],
      ['response_breached', r.sla.response.breached],
      ['resolution_breached', r.sla.resolution.breached],
      ['response_met', r.sla.response.met],
      ['resolution_met', r.sla.resolution.met],
      ['unassigned', r.aging.unassigned],
      ['stale', r.aging.stale],
    ];
    for (const [metric, value] of expected) {
      const { total } = await listed(manager, `group=${alpha}&period=30&metric=${metric}`);
      assert.equal(total, value, metric);
    }
  });

  test('a breach says which target, when it was due and how late', async () => {
    const { text } = await listed(manager, `group=${alpha}&period=30&metric=resolution_breached`);
    assert.match(text, /Server down/);
    assert.match(text, /Resolution due [^<]+; resolved [^<]+ - [^<]+ late in business time/);
    assert.match(text, /How this is counted/);
  });

  test('narrowing by priority, age and company', async () => {
    assert.equal((await listed(manager, `group=${alpha}&period=30&metric=raised&priority=urgent`)).total, 1);
    const old = await listed(manager, `group=${alpha}&period=30&metric=open&bucket=gt30`);
    assert.equal(old.total, 1);
    assert.match(old.text, /Old open one/);
    assert.equal((await listed(manager, `group=${alpha}&period=30&metric=raised&company=Contoso`)).total, 4);
  });

  test("an administrator's All groups takes in unrouted tickets; a group's report does not", async () => {
    const all = await listed(admin, 'period=30&metric=raised');
    assert.match(all.text, /Unrouted request/);
    assert.match(all.text, /Beta thing/);
    assert.doesNotMatch((await listed(manager, `group=${alpha}&period=30&metric=raised`)).text, /Unrouted request/);
    const page = await as(admin).get('/reports?period=30').expect(200);
    assert.match(page.text, /and unrouted tickets/);
  });
});

describe('the SLA filter on Tickets', () => {
  test('breached, at risk or on track - the same rules as Reports; staff only', async () => {
    const titles = async (s: TestSession, q: string) => (await as(s).get('/tickets?status=any&' + q).expect(200)).text;
    const breached = await titles(manager, 'sla=breached');
    assert.match(breached, /Server down/, 'resolved late is still breached');
    assert.match(breached, /Printer jams/);
    assert.doesNotMatch(breached, /Password reset/);
    assert.doesNotMatch(breached, /Not needed/, 'a cancelled ticket has no clock');
    const onTrack = await titles(manager, 'sla=on_track');
    assert.match(onTrack, /Password reset/);
    assert.doesNotMatch(onTrack, /Printer jams/);
    assert.match(breached, /<select id="sla" name="sla">/);

    const requester = await signInAs('msp.list.requester@example.com', 'user');
    assert.doesNotMatch((await as(requester).get('/tickets').expect(200)).text, /id="sla"/);
  });
});

describe('who may see what', () => {
  test("asking for another group's list falls back to one's own groups", async () => {
    const { text, total } = await listed(other, `group=${alpha}&period=30&metric=raised`);
    assert.equal(total, 1);
    assert.match(text, /Beta thing/);
    assert.doesNotMatch(text, /Server down/);
  });

  test('a requester has no lists; an unknown figure is not found', async () => {
    const requester = await signInAs('msp.someone@example.com', 'user');
    await as(requester).get('/reports/tickets?metric=raised').expect(404);
    await as(manager).get('/reports/tickets?metric=everything').expect(404);
  });
});

describe('the page and the download', () => {
  test('figures link to their tickets, compare with the period before, and say how they are counted', async () => {
    const page = await as(manager).get('/reports?group=' + alpha + '&period=30').expect(200);
    assert.match(page.text, /href="\/reports\/tickets\?[^"]*metric=raised"/);
    assert.match(page.text, /href="\/reports\/tickets\?[^"]*metric=resolution_breached"/);
    assert.match(page.text, /class="report-delta report-delta--/);
    assert.match(page.text, /Backlog now, by age/);
    assert.match(page.text, /How each figure is counted/);
  });

  test('the workbook carries the definitions and the backlog age', async () => {
    const res = await as(manager).get('/reports/export.xlsx?group=' + alpha + '&period=30').buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    const { inflateRawSync } = await import('node:zlib');
    const buf = res.body as Buffer;
    let book = '';
    for (let p = 0; buf.readUInt32LE(p) === 0x04034b50;) {
      const size = buf.readUInt32LE(p + 18), nameLength = buf.readUInt16LE(p + 26), extra = buf.readUInt16LE(p + 28);
      const name = buf.subarray(p + 30, p + 30 + nameLength).toString('utf8');
      const start = p + 30 + nameLength + extra;
      if (name === 'xl/workbook.xml') book = inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
      p = start + size;
    }
    assert.match(book, /name="Backlog age"/);
    assert.match(book, /name="Definitions"/);
  });
});
