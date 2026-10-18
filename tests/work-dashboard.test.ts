import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { execute } from '../src/db/index.js';
import { createGroup, setGroupManager, setMembersWithin } from '../src/services/groups.js';
import { createTicket } from '../src/services/tickets.js';

let app: Express;
let tech: TestSession;
let outsider: TestSession;
let manager: TestSession;
let requester: TestSession;
let network = '';
let desk = '';

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

async function raise(title: string, groupId: string, assigneeId: string | null, priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal') {
  const t = await createTicket({ title, description: 'Raised by the dashboard tests.', priority, category: 'other', requesterId: requester.user.id });
  await execute('UPDATE tickets SET group_id = ?, assignee_id = ? WHERE id = ?', [groupId, assigneeId, t.id]);
  return t;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  tech = await signInAs('wd.tech@example.com', 'agent');
  outsider = await signInAs('wd.outsider@example.com', 'agent');
  manager = await signInAs('wd.manager@example.com', 'agent');
  requester = await signInAs('wd.requester@example.com', 'user');
  network = (await createGroup({ name: 'Network', description: '', isActive: true }, null)).id;
  desk = (await createGroup({ name: 'Desk', description: '', isActive: true }, null)).id;
  await setMembersWithin(network, [tech.user.id], [tech.user.id], null);
  await setGroupManager(network, manager.user.id, null);
  await setGroupManager(desk, manager.user.id, null);

  await raise('Switch down in B2', network, tech.user.id, 'urgent');
  await raise('VPN slow', network, tech.user.id, 'low');
  await raise('New cable wanted', network, null);
  await raise('Printer jammed', desk, null);
});

describe('the Dashboard link', () => {
  test('is offered to every technician and administrator, never to a requester', async () => {
    assert.match((await as(tech).get('/tickets').expect(200)).text, /href="\/dashboard"/);
    assert.match((await as(manager).get('/tickets').expect(200)).text, /href="\/dashboard"/);
    // In no group: their own tickets, and the page still opens.
    assert.match((await as(outsider).get('/tickets').expect(200)).text, /href="\/dashboard"/);
    assert.match((await as(outsider).get('/dashboard').expect(200)).text, /Open tickets/);
    assert.doesNotMatch((await as(requester).get('/tickets').expect(200)).text, /href="\/dashboard"/);
    await as(requester).get('/dashboard').expect(404);
  });

  test('an administrator in no group sees the whole desk: figures and activity', async () => {
    const admin = await signInAs('wd.admin@example.com', 'admin');
    const page = await as(admin).get('/dashboard').expect(200);
    assert.match(page.text, /Open tickets<\/small><b>\d+ /);
    assert.match(page.text, /Raised today/);
    assert.match(page.text, /SLA met/);
    assert.match(page.text, /-\d{6} raised<\/b>/, 'activity across every group');
    assert.match(page.text, /joined Network/, 'a member joining a group is activity');
  });
});

describe('My work', () => {
  test('shows what is assigned to me, most urgent first, and what waits unassigned in my groups', async () => {
    const page = await as(tech).get('/dashboard').expect(200);
    const mine = page.text.slice(page.text.indexOf('Assigned to me</h2>'), page.text.indexOf('Unassigned in my groups</h2>'));
    assert.ok(mine.indexOf('Switch down in B2') < mine.indexOf('VPN slow'), 'urgent before low');
    const waiting = page.text.slice(page.text.indexOf('Unassigned in my groups</h2>'));
    assert.match(waiting, /New cable wanted/);
    assert.doesNotMatch(waiting, /Printer jammed/, 'not my group');
    assert.doesNotMatch(page.text, /href="\/dashboard\/manager"/, 'not a manager');
    await as(tech).get('/dashboard/manager').expect(404);
  });
});

describe('Manager', () => {
  test('a manager of two groups sees both, and can narrow to one', async () => {
    // In no group of their own: straight to the manager's view.
    const first = await as(manager).get('/dashboard').expect(302);
    assert.equal(first.headers.location, '/dashboard/manager');

    const all = await as(manager).get('/dashboard/manager').expect(200);
    assert.match(all.text, /All my groups \(2\)/);
    assert.match(all.text, /Printer jammed/);
    assert.match(all.text, /Switch down in B2/);

    const one = await as(manager).get('/dashboard/manager?group=' + network).expect(200);
    assert.doesNotMatch(one.text, /Printer jammed/);
    assert.match(one.text, /wd\.tech|<td>[^<]*<\/td><td>2<\/td>/);

    // A group they do not manage is ignored, not shown.
    const other = (await createGroup({ name: 'Elsewhere', description: '', isActive: true }, null)).id;
    await raise('Not yours', other, null);
    const sneaky = await as(manager).get('/dashboard/manager?group=' + other).expect(200);
    assert.doesNotMatch(sneaky.text, /Not yours/);
  });
});

describe('what the Activity feed shows', () => {
  test('automation lines are for administrators, and each person keeps what they want', async () => {
    const { ACTIVITY_KINDS, activityChoice } = await import('../src/services/work-dashboard.js');
    assert.deepEqual(
      ACTIVITY_KINDS.map((k) => k.key),
      ['tickets', 'sla', 'groups', 'automations'],
    );

    // Nothing chosen: everything they may see - and a technician may not see
    // automation runs, which are an administrator's machinery.
    assert.deepEqual(activityChoice({ role: 'agent', activity_kinds: '' }), ['tickets', 'sla', 'groups']);
    assert.deepEqual(activityChoice({ role: 'admin', activity_kinds: '' }), [
      'tickets',
      'sla',
      'groups',
      'automations',
    ]);

    // A choice is narrowed to what they may see, so posting the value is no
    // way to keep a kind that is not theirs.
    assert.deepEqual(activityChoice({ role: 'agent', activity_kinds: 'automations,tickets' }), ['tickets']);
    assert.deepEqual(activityChoice({ role: 'admin', activity_kinds: 'automations' }), ['automations']);
  });
});
