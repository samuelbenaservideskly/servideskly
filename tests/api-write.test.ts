import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { queryOne } from '../src/db/index.js';
import { createApiKey } from '../src/services/api-keys.js';
import { createGroup } from '../src/services/groups.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';

let app: Express;
let admin: TestSession;
let agent: TestSession;
let requester: TestSession;
let full = '';
let commentOnly = '';
let orphan = '';
let templateName = '';

const ALL = ['create_ticket', 'set_status', 'set_priority', 'route_group', 'assign', 'add_comment', 'send_notification', 'create_template', 'create_notification'];
const send = (method: 'post' | 'patch', url: string, key: string, body: unknown) =>
  request(app)[method](url).set('Authorization', 'Bearer ' + key).type('json').send(JSON.stringify(body));

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('write.admin@example.com', 'admin');
  agent = await signInAs('write.agent@example.com', 'agent');
  requester = await signInAs('write.requester@example.com', 'user');
  templateName = (await ensureDefaultTemplate()).name;
  await createGroup({ name: 'Network', description: '', isActive: true }, null);
  full = (await createApiKey('Everything', ALL, admin.user.id)).secret;
  commentOnly = (await createApiKey('Comments', ['add_comment'], admin.user.id)).secret;
  orphan = (await createApiKey('Nobody made it', ALL, null)).secret;
});

describe('POST and PATCH /api/v1, without an automation', () => {
  let ref = '';
  let id = '';

  test('creates a ticket from a template, routed and assigned in one request', async () => {
    const res = await send('post', '/api/v1/tickets', full, {
      template: templateName,
      title: 'VPN drops every hour',
      description: 'Since the update on Monday.',
      requester: 'write.requester@example.com',
      priority: 'high',
      group: 'Network',
      assignee: 'write.agent@example.com',
    }).expect(201);
    ref = res.body.reference;
    id = res.body.id;
    assert.match(ref, /^[A-Z]+-\d{6}$/);
    const row = await queryOne<{ priority: string; assignee_id: string; requester_id: string; title: string }>('SELECT * FROM tickets WHERE id = ?', [res.body.id]);
    assert.equal(row?.title, 'VPN drops every hour');
    assert.equal(row?.priority, 'high');
    assert.equal(row?.assignee_id, agent.user.id);
    assert.equal(row?.requester_id, requester.user.id);
  });

  test('changes status, priority, group and assignee; the label works as well as the word', async () => {
    const res = await send('patch', '/api/v1/tickets/' + ref, full, { status: 'In progress', priority: 'urgent', assignee: 'none' }).expect(200);
    assert.deepEqual([...res.body.changed].sort(), ['assignee', 'priority', 'status']);
    const row = await queryOne<{ status: string; assignee_id: string | null }>("SELECT status, assignee_id FROM tickets WHERE id = ?", [id]);
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.assignee_id, null);
  });

  test('on hold needs a reason, as on the page, and the reason becomes a comment', async () => {
    const refused = await send('patch', '/api/v1/tickets/' + ref, full, { status: 'on hold' }).expect(400);
    assert.match(refused.body.error, /reason/);
    await send('patch', '/api/v1/tickets/' + ref, full, { status: 'on hold', note: 'Waiting for the vendor.' }).expect(200);
    const note = await queryOne<{ body: string }>("SELECT body FROM ticket_comments WHERE body LIKE 'On hold:%' ORDER BY created_at DESC LIMIT 1");
    assert.equal(note?.body, 'On hold: Waiting for the vendor.');
  });

  test('a comment, public or internal', async () => {
    const res = await send('post', '/api/v1/tickets/' + ref + '/comments', commentOnly, { body: 'Monitoring: back to normal.', internal: true }).expect(201);
    assert.equal(res.body.internal, true);
  });

  test('each change needs its own tick on the key', async () => {
    const res = await send('patch', '/api/v1/tickets/' + ref, commentOnly, { status: 'resolved' }).expect(403);
    assert.match(res.body.error, /set the status/);
    await send('post', '/api/v1/tickets', commentOnly, { template: templateName }).expect(403);
  });

  test('refuses what the pages refuse: a stranger as assignee, an unknown group, a missing ticket', async () => {
    await send('patch', '/api/v1/tickets/' + ref, full, { assignee: 'write.requester@example.com' }).expect(400);
    await send('patch', '/api/v1/tickets/' + ref, full, { group: 'No such team' }).expect(400);
    await send('patch', '/api/v1/tickets/INC-999999', full, { priority: 'low' }).expect(404);
    await send('patch', '/api/v1/tickets/' + ref, full, {}).expect(400);
  });

  test('creates a template and a notification, and refuses a name already taken', async () => {
    const t = await send('post', '/api/v1/templates', full, { name: 'New starter laptop', type: 'service_request', summary: 'Order a laptop' }).expect(201);
    assert.equal(t.body.offered, false, 'not offered to requesters until somebody says so');
    await send('post', '/api/v1/templates', full, { name: 'New starter laptop' }).expect(409);
    await send('post', '/api/v1/notifications', full, { name: 'Laptop shipped', subject: '[{{reference}}] Shipped', body: '<p>On its way.</p>' }).expect(201);
    await send('post', '/api/v1/notifications', full, { name: 'Laptop shipped' }).expect(409);
  });

  test('a wrong key, or one whose author is gone, changes nothing', async () => {
    await send('post', '/api/v1/tickets', 'hd_nope_nopenopenopenope', { template: templateName }).expect(401);
    await send('post', '/api/v1/tickets', orphan, { template: templateName }).expect(403);
  });

  test('reading is still the read router, with its own permission', async () => {
    await request(app).get('/api/v1/tickets/' + ref).set('Authorization', 'Bearer ' + full).expect(403);
  });
});
