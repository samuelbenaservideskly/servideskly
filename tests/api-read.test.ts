import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { execute } from '../src/db/index.js';
import { createApiKey } from '../src/services/api-keys.js';
import { addComment, createTicket } from '../src/services/tickets.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';

let app: Express;
let agent: TestSession;
let requester: TestSession;
let reader = '';
let insider = '';
let writer = '';
let narrow = '';
let ref = '';
let other = '';

const get = (url: string, key: string) => request(app).get(url).set('Authorization', 'Bearer ' + key);

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  agent = await signInAs('read.agent@example.com', 'agent');
  requester = await signInAs('read.requester@example.com', 'user');
  const template = await ensureDefaultTemplate();

  const t = await createTicket({ title: 'Disk full on srv-12', description: 'Free space under 5%.', priority: 'urgent', category: 'other', requesterId: requester.user.id, templateId: template.id });
  ref = t.reference;
  await execute("UPDATE tickets SET status = 'in_progress', assignee_id = ? WHERE id = ?", [agent.user.id, t.id]);
  await addComment({ ticketId: t.id, authorId: agent.user.id, body: 'Cleaning up the logs now.', isInternal: false });
  await addComment({ ticketId: t.id, authorId: agent.user.id, body: 'Root cause: log rotation off.', isInternal: true });
  other = (await createTicket({ title: 'Printer jammed', description: 'Tray 2 again.', priority: 'low', category: 'other', requesterId: agent.user.id })).reference;

  reader = (await createApiKey('Reader', ['read_tickets'], agent.user.id)).secret;
  insider = (await createApiKey('Insider', ['read_tickets', 'read_internal'], agent.user.id)).secret;
  writer = (await createApiKey('Writer only', ['set_status'], null)).secret;
  narrow = (await createApiKey('Default template only', ['read_tickets'], agent.user.id, [template.id])).secret;
});

describe('GET /api/v1', () => {
  test('one ticket, by reference: status and everything else', async () => {
    const res = await get('/api/v1/tickets/' + ref, reader).expect(200);
    assert.equal(res.body.reference, ref);
    assert.equal(res.body.status, 'in_progress');
    assert.equal(res.body.statusLabel, 'In progress');
    assert.equal(res.body.priority, 'urgent');
    assert.equal(res.body.requester.email, 'read.requester@example.com');
    assert.equal(res.body.assignee.email, 'read.agent@example.com');
    assert.equal(res.body.description, 'Free space under 5%.');
    assert.ok(Array.isArray(res.body.files) && Array.isArray(res.body.tasks));
  });

  test('no key, a wrong key, or a key that may not read: refused', async () => {
    await request(app).get('/api/v1/tickets/' + ref).expect(401);
    await get('/api/v1/tickets/' + ref, 'hd_nope_nopenopenopenopenope').expect(401);
    const res = await get('/api/v1/tickets/' + ref, writer).expect(403);
    assert.match(res.body.error, /Read tickets/);
    await get('/api/v1/tickets/INC-999999', reader).expect(404);
  });

  test('comments: internal notes only for a key allowed them', async () => {
    const plain = await get('/api/v1/tickets/' + ref + '/comments', reader).expect(200);
    assert.equal(plain.body.includesInternal, false);
    assert.deepEqual(plain.body.items.map((c: { body: string }) => c.body), ['Cleaning up the logs now.']);
    const all = await get('/api/v1/tickets/' + ref + '/comments', insider).expect(200);
    assert.equal(all.body.items.length, 2);
  });

  test('a list, filtered; a bad filter says why', async () => {
    const mine = await get('/api/v1/tickets?requester=read.requester@example.com&status=open,in_progress', reader).expect(200);
    assert.equal(mine.body.total, 1);
    assert.equal(mine.body.items[0].reference, ref);
    const urgent = await get('/api/v1/tickets?priority=urgent', reader).expect(200);
    assert.ok(urgent.body.items.every((t: { priority: string }) => t.priority === 'urgent'));
    const bad = await get('/api/v1/tickets?status=sleeping', reader).expect(400);
    assert.match(bad.body.error, /status is one or more of/);
    await get('/api/v1/tickets?updatedSince=yesterday', reader).expect(400);
  });

  test('a key limited to a template reads only its tickets; the rest are "not found"', async () => {
    await get('/api/v1/tickets/' + ref, narrow).expect(200);
    await get('/api/v1/tickets/' + other, narrow).expect(404);
    const list = await get('/api/v1/tickets', narrow).expect(200);
    assert.ok(list.body.items.every((t: { reference: string }) => t.reference !== other));
  });
});

describe('all tickets', () => {
  test('no filters gives every ticket the key may read, a page at a time', async () => {
    const first = await get('/api/v1/tickets?limit=1', reader).expect(200);
    assert.ok(first.body.total >= 2);
    assert.equal(first.body.items.length, 1);
    assert.equal(first.body.next, 1);
    const second = await get('/api/v1/tickets?limit=1&offset=1', reader).expect(200);
    assert.notEqual(second.body.items[0].reference, first.body.items[0].reference);
  });
});

describe('more filters', () => {
  test('type, assignee (or none), template, search and createdSince; a bad one says why', async () => {
    const unassigned = await get('/api/v1/tickets?assignee=none', reader).expect(200);
    assert.ok(unassigned.body.items.every((t: { assignee: unknown }) => t.assignee === null));
    const theirs = await get('/api/v1/tickets?assignee=read.agent@example.com', reader).expect(200);
    assert.deepEqual(theirs.body.items.map((t: { reference: string }) => t.reference), [ref]);
    const found = await get('/api/v1/tickets?search=DISK', reader).expect(200);
    assert.equal(found.body.total, 1);
    const none = await get('/api/v1/tickets?search=100%25', reader).expect(200);
    assert.equal(none.body.total, 0, '% is taken literally');
    const byTemplate = await get('/api/v1/tickets?template=Default%20request', reader).expect(200);
    assert.ok(byTemplate.body.items.some((t: { reference: string }) => t.reference === ref));
    const recent = await get('/api/v1/tickets?createdSince=2000-01-01T00:00:00Z&type=incident,service_request', reader).expect(200);
    assert.ok(recent.body.total >= 1);
    await get('/api/v1/tickets?type=meeting', reader).expect(400);
    await get('/api/v1/tickets?createdSince=soon', reader).expect(400);
  });
});
