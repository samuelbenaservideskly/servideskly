import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { queryOne } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createGroup, setMembersWithin } from '../src/services/groups.js';
import { createTicket } from '../src/services/tickets.js';

/** "Assign to me" on a ticket: one group goes straight in; several ask which. */

let app: Express;
let single: TestSession;
let multi: TestSession;
let requester: TestSession;
let network = '';
let desk = '';

const as = (s: TestSession) => request.agent(app).set('Cookie', s.cookie);
const take = (s: TestSession, ticketId: string, form: Record<string, string> = {}) =>
  as(s).post('/tickets/' + ticketId + '/assign-me').type('form').send({ _csrf: s.csrfToken, ...form });
const raise = (title: string) => createTicket({ title, description: 'Who takes it?', priority: 'normal', category: 'other', requesterId: requester.user.id });
const row = (id: string) => queryOne<{ assignee_id: string | null; group_id: string | null }>('SELECT assignee_id, group_id FROM tickets WHERE id = ?', [id]);

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  single = await signInAs('assign.single@example.com', 'agent');
  multi = await signInAs('assign.multi@example.com', 'agent');
  requester = await signInAs('assign.requester@example.com', 'user');
  network = (await createGroup({ name: 'Network', description: '', isActive: true }, null)).id;
  desk = (await createGroup({ name: 'Desk', description: '', isActive: true }, null)).id;
  await setMembersWithin(network, [single.user.id, multi.user.id], [single.user.id, multi.user.id], null);
  await setMembersWithin(desk, [multi.user.id], [multi.user.id], null);
});

describe('assign to me', () => {
  test('in one group: one click, and the ticket goes to that group', async () => {
    const t = await raise('One group');
    const page = await as(single).get('/tickets/' + t.id).expect(200);
    assert.match(page.text, /action="\/tickets\/[^"]+\/assign-me"/);
    assert.doesNotMatch(page.text, /id="assign-me"/, 'no popup');
    await take(single, t.id).expect(302);
    assert.deepEqual(await row(t.id), { assignee_id: single.user.id, group_id: network });
    assert.doesNotMatch((await as(single).get('/tickets/' + t.id).expect(200)).text, /Assign to me/, 'gone once it is theirs');
  });

  test('in several groups: a popup, and the chosen group', async () => {
    const t = await raise('Several groups');
    const page = await as(multi).get('/tickets/' + t.id).expect(200);
    assert.match(page.text, /href="#assign-me"/);
    assert.match(page.text, /id="assign-me"/);
    await take(multi, t.id).expect(302).expect('location', /#assign-me$/);
    assert.equal((await row(t.id))?.assignee_id, null, 'nothing without a choice');
    await take(multi, t.id, { groupId: desk }).expect(302);
    assert.deepEqual(await row(t.id), { assignee_id: multi.user.id, group_id: desk });
  });

  test('a group one is not in is refused; a requester cannot take a ticket', async () => {
    const t = await raise('Not yours');
    const outsider = (await createGroup({ name: 'Facilities', description: '', isActive: true }, null)).id;
    await take(multi, t.id, { groupId: outsider }).expect(302).expect('location', /#assign-me$/);
    assert.equal((await row(t.id))?.assignee_id, null);
    await take(requester, t.id).expect(403);
  });
});
