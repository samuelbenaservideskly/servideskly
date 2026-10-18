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
  recentRuns,
  setAutomationEnabled,
} from '../src/services/automation.js';
import { createApiKey, setApiKeyActions } from '../src/services/api-keys.js';
import { createTicket, getTicketById } from '../src/services/tickets.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';

let app: Express;
let admin: TestSession;
let requester: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('keys.admin@example.com', 'admin');
  requester = await signInAs('keys.requester@example.com', 'user');
});

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

async function httpAutomation(name: string, apiKeyId: string) {
  const a = await createAutomation(name, 'http.received', admin.user.id);
  const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
  await configureNode(a.id, trigger, { event: 'http.received', apiKeyId }, null);
  const status = await addNode(a.id, 'set_status', 300, 100, null);
  await configureNode(a.id, status, { status: 'in_progress' }, null);
  const note = await addNode(a.id, 'add_comment', 500, 100, null);
  await configureNode(a.id, note, { body: 'Monitoring says: {{request.json.message}}', internal: 'on' }, null);
  await connect(a.id, trigger, 'next', status, null);
  await connect(a.id, status, 'next', note, null);
  return a;
}

describe('API keys', () => {
  test('the secret is shown once, and only its hash is kept', async () => {
    const page = await as(admin)
      .post('/admin/settings/advanced/api-keys')
      .type('form')
      .send({ _csrf: admin.csrfToken, name: 'Monitoring', actions: ['set_status', 'add_comment'] })
      .expect(200);
    const secret = /<pre class="api-key-created__secret mono">(hd_[^<]+)<\/pre>/.exec(page.text)?.[1];
    assert.ok(secret, 'the key is on the page');
    assert.ok(page.text.includes('data-copy="' + secret + '"'), 'with a copy button');
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
    const row = (await query<{ secret_hash: string; allowed_actions: string }>("SELECT secret_hash, allowed_actions FROM api_keys WHERE name = 'Monitoring'"))[0]!;
    assert.notEqual(row.secret_hash, secret);
    assert.ok(!JSON.stringify(row).includes(secret!));

    const later = await as(admin).get('/admin/settings/advanced/api-keys').expect(200);
    assert.ok(!later.text.includes(secret!), 'never shown again');
    assert.match(later.text, /Set status, Add a comment/);
  });

  test('a key needs a name and at least one step; a refusal keeps the dialog open', async () => {
    const res = await as(admin)
      .post('/admin/settings/advanced/api-keys')
      .type('form')
      .send({ _csrf: admin.csrfToken, name: 'Nothing allowed' })
      .expect(400);
    assert.match(res.text, /class="dialog dialog--open" id="new-key"/);
    assert.match(res.text, /Tick at least one step/);
    // Cancel goes to #top, which the stylesheet uses to close a reopened dialog.
    assert.match(res.text, /<a class="btn btn--quiet" href="#top">Cancel<\/a>/);
    assert.match(res.text, /<span id="top"/);
  });
});

describe('the HTTP trigger', () => {
  test('a request with the right key runs the steps, reading what was sent', async () => {
    const { row, secret } = await createApiKey('Pager', ['set_status', 'add_comment'], null);
    const a = await httpAutomation('From the pager', row.id);
    await setAutomationEnabled(a.id, true, null);
    const ticket = await createTicket({ title: 'Disk full', description: 'Raised by the API key tests.', priority: 'normal', category: 'other', requesterId: requester.user.id });

    const res = await request(app)
      .post('/hooks/automations/' + a.id)
      .set('Authorization', 'Bearer ' + secret)
      .send({ ticket: ticket.reference, message: 'disk at 99%' })
      .expect(200);
    assert.deepEqual(res.body, { outcome: 'success', ticket: ticket.reference });
    assert.equal((await getTicketById(ticket.id))?.status, 'in_progress');
    const comments = await query<{ body: string }>('SELECT body FROM ticket_comments WHERE ticket_id = ?', [ticket.id]);
    assert.ok(comments.some((c) => c.body === 'Monitoring says: disk at 99%'));
    assert.equal((await recentRuns(a.id))[0]?.outcome, 'success');
  });

  test('a wrong, missing or other key is refused alike; a missing ticket is named', async () => {
    const { row, secret } = await createApiKey('Probe', ['set_status', 'add_comment'], null);
    const other = await createApiKey('Other', ['set_status', 'add_comment'], null);
    const a = await httpAutomation('Probed', row.id);
    await setAutomationEnabled(a.id, true, null);
    const url = '/hooks/automations/' + a.id;
    await request(app).post(url).send({ ticket: 'INC-000001' }).expect(401);
    await request(app).post(url).set('Authorization', 'Bearer hd_nonsense_nonsense_nonsense').send({}).expect(401);
    await request(app).post(url).set('Authorization', 'Bearer ' + other.secret).send({}).expect(401);
    await request(app).post('/hooks/automations/nope').set('Authorization', 'Bearer ' + secret).send({}).expect(401);
    await request(app).post(url).set('Authorization', 'Bearer ' + secret).send({}).expect(400);
    await request(app).post(url).set('Authorization', 'Bearer ' + secret).send({ ticket: 'INC-999999' }).expect(404);
    const bad = await request(app).post(url).set('Authorization', 'Bearer ' + secret).set('Content-Type', 'application/json').send('{oops').expect(400);
    assert.equal(bad.body.error, 'The body is not valid JSON.');
  });

  test('a key can run only the steps ticked on it', async () => {
    const { row, secret } = await createApiKey('Narrow', ['set_status'], null);
    const a = await httpAutomation('Too much for its key', row.id);
    await assert.rejects(() => setAutomationEnabled(a.id, true, null), /may not run: Add a comment/);

    // Allowed when switched on, narrowed afterwards: refused before anything runs.
    await setApiKeyActions(row.id, ['set_status', 'add_comment'], null);
    await setAutomationEnabled(a.id, true, null);
    await setApiKeyActions(row.id, ['set_status'], null);
    const ticket = await createTicket({ title: 'Narrowed', description: 'Raised by the API key tests.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    await request(app).post('/hooks/automations/' + a.id).set('Authorization', 'Bearer ' + secret).send({ ticket: ticket.reference }).expect(403);
    assert.equal((await getTicketById(ticket.id))?.status, 'open');
  });

  test('an HTTP trigger is never set off by a ticket event', async () => {
    const { row } = await createApiKey('Quiet', ['set_status', 'add_comment'], null);
    const a = await httpAutomation('Only by request', row.id);
    await setAutomationEnabled(a.id, true, null);
    const ticket = await createTicket({ title: 'Untouched', description: 'Raised by the API key tests.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    assert.equal((await getTicketById(ticket.id))?.status, 'open');
  });
});

describe('Create a ticket, values from the request, and templates', () => {
  test('a request with no ticket creates one from a template, with its priority from the request', async () => {
    const template = await ensureDefaultTemplate();
    const { row, secret } = await createApiKey('Intake', ['create_ticket', 'set_priority'], null);
    const a = await createAutomation('Intake by request', 'http.received', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    await configureNode(a.id, trigger, { event: 'http.received', apiKeyId: row.id }, null);
    const make = await addNode(a.id, 'create_ticket', 300, 100, null);
    await configureNode(a.id, make, { templateId: template.id, title: '{{request.json.title}}', description: 'From monitoring: {{request.json.detail}}', requesterEmail: '{{request.json.email}}' }, null);
    const prio = await addNode(a.id, 'set_priority', 500, 100, null);
    await configureNode(a.id, prio, { priority: 'variable', variable: 'request.json.priority' }, null);
    await connect(a.id, trigger, 'next', make, null);
    await connect(a.id, make, 'next', prio, null);
    await setAutomationEnabled(a.id, true, null);

    const res = await request(app)
      .post('/hooks/automations/' + a.id)
      .set('Authorization', 'Bearer ' + secret)
      .send({ title: 'Disk full on srv-12', detail: 'under 5%', email: 'outsider@example.net', priority: 'Urgent' })
      .expect(200);
    assert.equal(res.body.outcome, 'success');
    assert.match(res.body.ticket, /^[A-Z]+-\d{6}$/);
    const made = (await query<{ title: string; priority: string; external_email: string | null; template_id: string; description: string }>(
      "SELECT title, priority, external_email, template_id, description FROM tickets WHERE title = 'Disk full on srv-12'",
    ))[0]!;
    assert.equal(made.priority, 'urgent', 'the label was accepted');
    assert.equal(made.external_email, 'outsider@example.net', 'a stranger gets a ticket, not an account');
    assert.equal(made.template_id, template.id);
    assert.match(made.description, /From monitoring: under 5%/);

    // A value that is not a priority stops the run rather than guessing.
    await request(app).post('/hooks/automations/' + a.id).set('Authorization', 'Bearer ' + secret)
      .send({ title: 'Bad priority', priority: 'whenever' }).expect(500);
  });

  test('a key limited to some templates touches only their tickets, and creates only from them', async () => {
    const template = await ensureDefaultTemplate();
    const { row, secret } = await createApiKey('Narrow templates', ['set_status', 'create_ticket'], null, ['not-this-template']);
    const a = await createAutomation('Status by request', 'http.received', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    await configureNode(a.id, trigger, { event: 'http.received', apiKeyId: row.id }, null);
    const status = await addNode(a.id, 'set_status', 300, 100, null);
    await configureNode(a.id, status, { status: 'variable', variable: 'request.json.status' }, null);
    await connect(a.id, trigger, 'next', status, null);
    await setAutomationEnabled(a.id, true, null);

    const ticket = await createTicket({ title: 'Other template', description: 'Raised by the API key tests.', priority: 'normal', category: 'other', requesterId: requester.user.id, templateId: template.id });
    await request(app).post('/hooks/automations/' + a.id).set('Authorization', 'Bearer ' + secret)
      .send({ ticket: ticket.reference, status: 'resolved' }).expect(404);
    assert.equal((await getTicketById(ticket.id))?.status, 'open');

    // Allowed once the template is ticked.
    await setApiKeyActions(row.id, ['set_status', 'create_ticket'], null, [template.id]);
    await request(app).post('/hooks/automations/' + a.id).set('Authorization', 'Bearer ' + secret)
      .send({ ticket: ticket.reference, status: 'in progress' }).expect(200);
    assert.equal((await getTicketById(ticket.id))?.status, 'in_progress');

    // No ticket named, and the first step needs one: said, as a 400.
    const none = await request(app).post('/hooks/automations/' + a.id).set('Authorization', 'Bearer ' + secret).send({ status: 'resolved' }).expect(400);
    assert.match(none.body.error, /Create a ticket/);
  });

  test('an If can check the template a ticket was raised from', async () => {
    const template = await ensureDefaultTemplate();
    const a = await createAutomation('Per template', 'ticket.created', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    const cond = await addNode(a.id, 'if', 300, 100, null);
    await configureNode(a.id, cond, { field: 'template', op: 'equals', value: template.id }, null);
    const note = await addNode(a.id, 'add_comment', 500, 100, null);
    await configureNode(a.id, note, { body: 'Raised from the default form.', internal: 'on' }, null);
    await connect(a.id, trigger, 'next', cond, null);
    await connect(a.id, cond, 'true', note, null);
    await setAutomationEnabled(a.id, true, null);

    const from = await createTicket({ title: 'From the default', description: 'Raised by the API key tests.', priority: 'normal', category: 'other', requesterId: requester.user.id, templateId: template.id });
    const not = await createTicket({ title: 'From nothing', description: 'Raised by the API key tests.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    const notes = async (id: string) => (await query("SELECT id FROM ticket_comments WHERE ticket_id = ? AND body = 'Raised from the default form.'", [id])).length;
    assert.equal(await notes(from.id), 1);
    assert.equal(await notes(not.id), 0);
    await setAutomationEnabled(a.id, false, null);
  });
});

describe('the examples in every language', () => {
  test('one language bar, and each example written in all eight; the key comes from the environment', async () => {
    const agent = request.agent(app);
    agent.set('Cookie', admin.cookie);
    const page = await agent.get('/admin/settings/advanced/api-keys').expect(200);
    for (const label of ['cURL', 'Postman', 'PowerShell', 'Python', 'JavaScript', 'C#', 'Java', 'Go', 'PHP']) {
      assert.match(page.text, new RegExp('class="api-lang-bar__tab[^"]*">' + label.replace('#', '#') + '</label>'));
    }
    assert.match(page.text, /api-snippet--python">\s*<pre class="api-guide__code mono">import os/);
    // Each example can be copied: copy.js, ours, on this page only.
    assert.match(page.text, /data-copy="import os/);
    assert.match(page.text, /<script src="\/assets\/js\/copy\.js\?v=/);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
    assert.doesNotMatch(String(page.headers['content-security-policy']), /unsafe-inline/);
    assert.match(page.text, /requests\.post\(/);
    assert.match(page.text, /System\.getenv\(&#34;HELPDESK_KEY&#34;\)/);
    // Exactly one bar, before the examples, so one choice sets them all.
    assert.equal(page.text.split('class="api-lang-bar"').length - 1, 1);
    assert.ok(page.text.indexOf('name="apiLanguage"') < page.text.indexOf('class="api-guide__examples"'));
  });
});

describe('files sent with a request', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);

  async function attaching(name: string, actions: string[], internal = false) {
    const { row, secret } = await createApiKey(name, actions, null);
    const a = await createAutomation(name + ' automation', 'http.received', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    await configureNode(a.id, trigger, { event: 'http.received', apiKeyId: row.id }, null);
    const attach = await addNode(a.id, 'attach_files', 300, 100, null);
    if (internal) await configureNode(a.id, attach, { internal: 'on' }, null);
    await connect(a.id, trigger, 'next', attach, null);
    await setAutomationEnabled(a.id, true, null);
    return { url: '/hooks/automations/' + a.id, secret };
  }

  test('as base64 in JSON: stored on the ticket; a file that is not what it says is refused in an internal note', async () => {
    const { url, secret } = await attaching('Files by JSON', ['attach_files']);
    const ticket = await createTicket({ title: 'Needs a screenshot', description: 'Raised by the API key tests.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    const res = await request(app).post(url).set('Authorization', 'Bearer ' + secret).send({
      ticket: ticket.reference,
      files: [
        { name: 'screen.png', content: PNG.toString('base64') },
        { name: 'fake.png', content: Buffer.from('<html>not an image</html>').toString('base64') },
      ],
    }).expect(200);
    assert.equal(res.body.outcome, 'success');
    const stored = await query<{ filename: string; is_internal: number }>('SELECT filename, is_internal FROM ticket_attachments WHERE ticket_id = ?', [ticket.id]);
    assert.deepEqual(stored.map((f) => f.filename), ['screen.png']);
    const notes = await query<{ body: string; is_internal: number }>('SELECT body, is_internal FROM ticket_comments WHERE ticket_id = ?', [ticket.id]);
    assert.ok(notes.some((n) => n.body.includes('fake.png') && n.is_internal), 'the refusal is said, internally');
  });

  test('as a multipart upload (Postman form-data), internal when the step says so', async () => {
    const { url, secret } = await attaching('Files by form', ['attach_files'], true);
    const ticket = await createTicket({ title: 'Upload by form', description: 'Raised by the API key tests.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    await request(app).post(url).set('Authorization', 'Bearer ' + secret)
      .field('ticket', ticket.reference)
      .attach('file', PNG, 'photo.png')
      .expect(200);
    const stored = await query<{ filename: string; is_internal: number }>('SELECT filename, is_internal FROM ticket_attachments WHERE ticket_id = ?', [ticket.id]);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.filename, 'photo.png');
    assert.ok(stored[0]!.is_internal);
  });

  test('a key without "attach files" is refused before the body is used; a wrong key never gets it read', async () => {
    const { url } = await attaching('Files not allowed', ['attach_files']);
    const other = await createApiKey('No files', ['set_status'], null);
    await request(app).post(url).set('Authorization', 'Bearer ' + other.secret).field('ticket', 'INC-000001').attach('file', PNG, 'x.png').expect(401);
  });
});

describe('the key carries the helpdesk name and an identifier', () => {
  test('the name is the first part of the address; nothing usable is hd', async () => {
    const { keyName } = await import('../src/services/api-keys.js');
    assert.equal(keyName('https://acme.servideskly.com'), 'acme');
    assert.equal(keyName('https://test-sd.azurewebsites.net'), 'testsd');
    assert.equal(keyName('https://a-very-long-company-name.example.com'), 'averylongcom');
    assert.equal(keyName('http://localhost:3000'), 'hd');
    assert.equal(keyName('http://127.0.0.1:3000'), 'hd');
  });

  test('a new secret keeps the identifier, refuses the old secret, and an old-style key still works', async () => {
    const { rotateApiKey, keyForSecret, keyStart } = await import('../src/services/api-keys.js');
    const made = await createApiKey('Rotated', ['set_status'], null);
    assert.ok(made.secret.startsWith(keyStart(made.row) + '_'));
    const again = await rotateApiKey(made.row.id, null);
    assert.ok(again.secret.startsWith(keyStart(made.row) + '_'), 'same identifier');
    assert.notEqual(again.secret, made.secret);
    assert.equal(await keyForSecret(made.secret), undefined, 'the old secret is refused');
    assert.equal((await keyForSecret(again.secret))?.id, made.row.id);

    // A key made before: hd_<identifier>_<secret>, the identifier alone stored.
    const { execute } = await import('../src/db/index.js');
    const { sha256 } = await import('../src/lib/util.js');
    const legacy = 'hd_old12345_' + 'x'.repeat(43);
    await execute('UPDATE api_keys SET prefix = ?, secret_hash = ? WHERE id = ?', ['old12345', sha256(legacy), made.row.id]);
    assert.equal((await keyForSecret(legacy))?.id, made.row.id);
    assert.equal(keyStart({ prefix: 'old12345' }), 'hd_old12345');
  });

  test('the page offers a new secret behind a confirmation', async () => {
    const page = await request(app).get('/admin/settings/advanced/api-keys').set('Cookie', admin.cookie).expect(200);
    assert.match(page.text, /href="#rotate-/);
    assert.match(page.text, /The current secret stops working at once/);
  });
});
