import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createGroup, groupManagers, setGroupManager, setGroupManagers } from '../src/services/groups.js';
import { createTicket } from '../src/services/tickets.js';
import { managedGroups } from '../src/services/work-dashboard.js';
import { execute } from '../src/db/index.js';
import { findUserById } from '../src/services/users.js';

/** A technician group has as many managers as it needs, found by a search of eight. */

let app: Express;
let admin: TestSession;
let lead: TestSession;
let second: TestSession;
let requester: TestSession;

const as = (s: TestSession) => request.agent(app).set('Cookie', s.cookie);
const manage = (groupId: string, userId: string, action: 'add' | 'remove') =>
  as(admin).post('/admin/settings/groups/' + groupId + '/managers').type('form').send({ _csrf: admin.csrfToken, userId, action });
const ids = async (groupId: string) => (await groupManagers(groupId)).map((m) => m.id).sort();

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('gm.admin@example.com', 'admin');
  lead = await signInAs('gm.lead@example.com', 'agent');
  second = await signInAs('gm.second@example.com', 'agent');
  requester = await signInAs('gm.requester@example.com', 'user');
});

describe('technician group managers', () => {
  test('are added and removed one at a time, several per group, staff only', async () => {
    const group = await createGroup({ name: 'Network', description: '', isActive: true }, null);
    const page = await as(admin).get('/admin/settings/groups/' + group.id).expect(200);
    assert.match(page.text, /id="managers"/);
    assert.match(page.text, /data-live-search="manager-results"/);
    assert.doesNotMatch(page.text, /<select id="managerId"/, 'no dropdown of every technician');

    await manage(group.id, lead.user.id, 'add').expect(302);
    await manage(group.id, second.user.id, 'add').expect(302);
    assert.deepEqual(await ids(group.id), [lead.user.id, second.user.id].sort());
    await manage(group.id, requester.user.id, 'add').expect(302);
    assert.deepEqual(await ids(group.id), [lead.user.id, second.user.id].sort(), 'a plain user is refused');

    const list = await as(admin).get('/admin/settings/groups').expect(200);
    assert.match(list.text, /gm\.lead@example\.com/);
    assert.match(list.text, /gm\.second@example\.com/);

    await manage(group.id, lead.user.id, 'remove').expect(302);
    assert.deepEqual(await ids(group.id), [second.user.id]);
  });

  test('the search shows eight at most', async () => {
    for (let i = 0; i < 10; i++) await signInAs('gm.many' + i + '@example.com', 'agent');
    const group = await createGroup({ name: 'Crowded', description: '', isActive: true }, null);
    const page = await as(admin).get('/admin/settings/groups/' + group.id + '?mq=gm.many').expect(200);
    const results = page.text.slice(page.text.indexOf('id="manager-results"'));
    assert.equal((results.match(/name="action" value="add"/g) ?? []).length, 8);
    assert.match(results, /Showing 8 of 10/);
  });

  test('every manager sees the group as theirs, and is shown on its tickets', async () => {
    const group = await createGroup({ name: 'Printers', description: '', isActive: true }, null);
    await setGroupManagers(group.id, [lead.user.id, second.user.id], null);
    for (const s of [lead, second]) {
      const user = (await findUserById(s.user.id))!;
      assert.ok((await managedGroups(user)).some((g) => g.id === group.id));
    }
    const ticket = await createTicket({ title: 'Printer jammed', description: 'The second floor printer is jammed again.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    await execute('UPDATE tickets SET group_id = ? WHERE id = ?', [group.id, ticket.id]);
    const page = await as(admin).get('/tickets/' + ticket.id).expect(200);
    assert.match(page.text, /Managers: gm\.lead@example\.com, gm\.second@example\.com/);
  });

  test('the single-manager call still works, and clears', async () => {
    const group = await createGroup({ name: 'Phones', description: '', isActive: true }, null);
    await setGroupManager(group.id, lead.user.id, null);
    assert.deepEqual(await ids(group.id), [lead.user.id]);
    await setGroupManager(group.id, null, null);
    assert.deepEqual(await ids(group.id), []);
  });
});
