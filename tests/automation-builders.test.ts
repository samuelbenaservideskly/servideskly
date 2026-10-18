import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import {
  addNode,
  configureNode,
  connect,
  createAutomation,
  findAutomation,
  graphProblems,
  recentRuns,
  setAutomationEnabled,
} from '../src/services/automation.js';
import { createApiKey } from '../src/services/api-keys.js';
import { ensureDefaultTemplate, findTemplateByName, isUsable } from '../src/services/templates.js';
import { findNotificationByName } from '../src/services/mail/notifications.js';

let app: Express;
let admin: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('builders.admin@example.com', 'admin');
});

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

/** An HTTP-started automation: create a template, then a notification. */
async function builder(name: string, apiKeyId: string, template: Record<string, string>, notification: Record<string, string>) {
  const a = await createAutomation(name, 'http.received', admin.user.id);
  const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
  await configureNode(a.id, trigger, { event: 'http.received', apiKeyId }, null);
  const t = await addNode(a.id, 'create_template', 300, 100, null);
  await configureNode(a.id, t, template, null);
  const n = await addNode(a.id, 'create_notification', 500, 100, null);
  await configureNode(a.id, n, notification, null);
  await connect(a.id, trigger, 'next', t, null);
  await connect(a.id, t, 'next', n, null);
  return a;
}

describe('Create a ticket template / Create a notification', () => {
  test('a request creates both, without a ticket; placeholders of the notification are kept', async () => {
    const base = await ensureDefaultTemplate();
    const { row, secret } = await createApiKey('Provisioning', ['create_template', 'create_notification'], null);
    const a = await builder(
      'Provisioning',
      row.id,
      { name: '{{request.json.name}}', summary: '{{request.json.summary}}', type: 'variable', variable: 'request.json.type', basedOnId: base.id, ifExists: 'skip' },
      { name: '{{request.json.name}} - update', subject: '[{{reference}}] {{title}}', body: '<p>Hello {{requesterName}},</p><p>{{request.json.message}}</p>', ifExists: 'skip' },
    );
    assert.deepEqual(graphProblems((await findAutomation(a.id))!.graph), []);
    await setAutomationEnabled(a.id, true, null);

    const res = await request(app)
      .post('/hooks/automations/' + a.id)
      .set('Authorization', 'Bearer ' + secret)
      .send({ name: 'New starter laptop', type: 'Service request', summary: 'For a new colleague', message: 'It is on its way.' })
      .expect(200);
    assert.equal(res.body.outcome, 'success');

    const made = (await findTemplateByName('New starter laptop'))!;
    assert.equal(made.type, 'service_request');
    assert.equal(made.summary, 'For a new colleague');
    assert.equal(made.is_active, false, 'not offered until somebody says so');
    assert.ok(isUsable(made), 'the default form was copied');
    assert.deepEqual(made.fields.map((f) => f.key), base.fields.map((f) => f.key));

    const note = (await findNotificationByName('New starter laptop - update'))!;
    assert.equal(note.subject, '[{{reference}}] {{title}}');
    assert.match(note.body_html, /Hello \{\{requesterName\}\},/);
    assert.match(note.body_html, /It is on its way\./);
    assert.ok(note.event.startsWith('custom.'));

    // Again: both names are taken, and "leave that one" goes on.
    await request(app).post('/hooks/automations/' + a.id).set('Authorization', 'Bearer ' + secret)
      .send({ name: 'New starter laptop', type: 'incident' }).expect(200);
    const run = (await recentRuns(a.id))[0]!;
    assert.equal(run.outcome, 'success');
    assert.match(run.steps, /already exists, left as it is/);
    assert.equal((await query("SELECT id FROM ticket_templates WHERE name = 'New starter laptop'")).length, 1);
  });

  test('"stop" on a taken name fails the run; a task type is refused; the key must allow the steps', async () => {
    const { row, secret } = await createApiKey('Strict', ['create_template', 'create_notification'], null);
    const a = await builder(
      'Strict builder',
      row.id,
      { name: '{{request.json.name}}', type: 'variable', variable: 'request.json.type', ifExists: 'stop', offer: 'on' },
      { name: 'Strict note', ifExists: 'stop' },
    );
    await setAutomationEnabled(a.id, true, null);
    const first = await request(app).post('/hooks/automations/' + a.id).set('Authorization', 'Bearer ' + secret)
      .send({ name: 'Strict form', type: 'change_request' }).expect(200);
    assert.equal(first.body.outcome, 'success');
    const made = (await findTemplateByName('Strict form'))!;
    assert.equal(made.is_active, true, 'offered when the step says so');
    assert.ok(made.fields.some((f) => f.key === 'title'), 'the standard form');

    await request(app).post('/hooks/automations/' + a.id).set('Authorization', 'Bearer ' + secret)
      .send({ name: 'Strict form', type: 'change_request' });
    assert.match((await recentRuns(a.id))[0]!.steps, /already exists/);
    assert.equal((await recentRuns(a.id))[0]!.outcome, 'failure');

    await request(app).post('/hooks/automations/' + a.id).set('Authorization', 'Bearer ' + secret)
      .send({ name: 'A task form', type: 'task' });
    assert.match((await recentRuns(a.id))[0]!.steps, /is not a ticket type/);
    assert.equal(await findTemplateByName('A task form'), undefined);

    // A key without the step cannot switch the automation on.
    const { row: narrow } = await createApiKey('Narrow', ['add_comment'], null);
    const b = await builder('Narrow builder', narrow.id, { name: 'X', type: 'incident' }, { name: 'Y' });
    await assert.rejects(setAutomationEnabled(b.id, true, null), /may not run: Create a ticket template, Create a notification/);
  });

  test('the steps say what they still need', async () => {
    const a = await createAutomation('Half done', 'ticket.created', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    const t = await addNode(a.id, 'create_template', 300, 100, null);
    const n = await addNode(a.id, 'create_notification', 500, 100, null);
    await connect(a.id, trigger, 'next', t, null);
    await connect(a.id, t, 'next', n, null);
    assert.deepEqual(graphProblems((await findAutomation(a.id))!.graph), [
      'Create a ticket template: write the name.',
      'Create a notification: write the name.',
    ]);
    await configureNode(a.id, t, { name: 'From {{ticket.title}}', type: 'incident' }, null);
    await configureNode(a.id, n, { name: 'Note', body: '{{reference}} {{nope.json.x}}' }, null);
    assert.deepEqual(graphProblems((await findAutomation(a.id))!.graph), ['Create a notification: unknown variable {{nope.json.x}}.']);
  });
});

describe('the automation list', () => {
  test('each row has a bin that opens a confirmation, which deletes', async () => {
    const a = await createAutomation('Bin me', 'ticket.created', admin.user.id);
    const page = await as(admin).get('/admin/settings/advanced/automation').expect(200);
    assert.ok(page.text.includes('href="#delete-' + a.id + '"'), 'the bin');
    assert.ok(page.text.includes('id="delete-' + a.id + '"'), 'its confirmation');
    await as(admin).post('/admin/settings/advanced/automation/' + a.id + '/delete').type('form')
      .send({ _csrf: admin.csrfToken }).expect(302);
    assert.equal(await findAutomation(a.id), undefined);
  });
});

describe('disconnecting one wire', () => {
  test('removes that wire only, and the canvas draws a hit area for each', async () => {
    const a = await createAutomation('Two wires', 'ticket.created', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    const one = await addNode(a.id, 'add_comment', 300, 60, null);
    const two = await addNode(a.id, 'add_comment', 300, 180, null);
    await connect(a.id, trigger, 'next', one, null);
    await connect(a.id, trigger, 'next', two, null);

    const page = await as(admin).get('/admin/settings/advanced/automation/' + a.id).expect(200);
    assert.equal((page.text.match(/class="automation-diagram__wire-hit"/g) ?? []).length, 2);
    assert.match(page.text, /data-menu-wire hidden/);

    await as(admin).post('/admin/settings/advanced/automation/' + a.id + '/disconnect').type('form')
      .send({ _csrf: admin.csrfToken, from: trigger, pin: 'next', to: one }).expect(302);
    const edges = (await findAutomation(a.id))!.graph.edges;
    assert.deepEqual(edges.map((e) => e.to), [two]);
  });
});
