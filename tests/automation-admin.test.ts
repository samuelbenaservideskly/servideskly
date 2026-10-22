import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { addNode, findAutomation, listAutomations } from '../src/services/automation.js';
import { settings } from '../src/settings/index.js';

const BASE = '/admin/settings/advanced/automation';
const CONNECTIONS = '/admin/settings/advanced/connections';

let app: Express;
let admin: TestSession;
let agent: TestSession;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('autoui.admin@example.com', 'admin');
  agent = await signInAs('autoui.agent@example.com', 'agent');
});

describe('the automation pages', () => {
  let id = '';
  let triggerId = '';

  test('only administrators reach them', async () => {
    await as(agent).get(BASE).expect(403);
    await as(agent).get(CONNECTIONS).expect(403);
  });

  test('a new automation is made in a dialog and opens its editor with a diagram', async () => {
    const refused = await post(admin, BASE, { name: '' }).expect(400);
    assert.match(refused.text, /class="dialog dialog--open" id="new-automation"/);

    const created = await post(admin, BASE, { name: 'Notify upstream', trigger: 'ticket.created' }).expect(302);
    id = String(created.headers.location).split('/').pop()!;
    const page = await as(admin).get(BASE + '/' + id).expect(200);
    assert.match(page.text, /<svg class="automation-diagram"/);
    assert.match(page.text, /Connect the trigger to the first step/);
    triggerId = (await findAutomation(id))!.graph.nodes[0]!.id;
  });

  test('a step is added after another, configured, and refused while incomplete', async () => {
    await post(admin, BASE + '/' + id + '/nodes', { type: 'http_request', after: triggerId + ':next' }).expect(302);
    const graph = (await findAutomation(id))!.graph;
    const step = graph.nodes.find((n) => n.type === 'http_request')!;
    assert.deepEqual(graph.edges, [{ from: triggerId, pin: 'next', to: step.id }]);

    await post(admin, BASE + '/' + id + '/enabled', { enabled: 'on' }).expect(302);
    assert.equal((await findAutomation(id))!.is_enabled, false);

    await post(admin, BASE + '/' + id + '/nodes/' + step.id, {
      method: 'POST',
      url: 'https://api.example.com/hook/{{ticket.reference}}',
      bodyType: 'json',
      body: '{"t": "{{ticket.title}}"}',
      output: 'hook',
      // Not a field of this step: never stored.
      evil: 'x',
    }).expect(302).expect('location', BASE + '/' + id + '#step-' + step.id);
    const saved = (await findAutomation(id))!.graph.nodes.find((n) => n.id === step.id)!;
    assert.equal(saved.config.url, 'https://api.example.com/hook/{{ticket.reference}}');
    assert.equal(saved.config.evil, undefined);

    await post(admin, BASE + '/' + id + '/enabled', { enabled: 'on' }).expect(302);
    assert.equal((await findAutomation(id))!.is_enabled, true);
  });

  test('a bad step is shown with what it needs, on its card and in the diagram', async () => {
    const step = (await findAutomation(id))!.graph.nodes.find((n) => n.type === 'http_request')!;
    await post(admin, BASE + '/' + id + '/nodes/' + step.id, { method: 'GET', url: 'https://x.example.com/', headers: 'Authorization: Bearer abc' }).expect(302);
    const page = await as(admin).get(BASE + '/' + id).expect(200);
    assert.match(page.text, /Needs: Do not put credentials in a header/);
    assert.match(page.text, /automation-diagram__box--problem/);
  });

  test('the private-network switch is off by default and audited', async () => {
    assert.equal(settings().httpRequests.allowPrivateNetwork, false);
    await post(admin, BASE + '/network', { allowPrivateNetwork: 'on' }).expect(302);
    assert.equal(settings().httpRequests.allowPrivateNetwork, true);
    await post(admin, BASE + '/network', {}).expect(302);
    assert.equal(settings().httpRequests.allowPrivateNetwork, false);
    const audit = await query("SELECT id FROM audit_log WHERE action LIKE 'settings.http_requests.%'");
    assert.equal(audit.length, 2);
  });

  test('deleting an automation goes through its dialog', async () => {
    const page = await as(admin).get(BASE + '/' + id).expect(200);
    assert.match(page.text, /id="delete-automation"/);
    await post(admin, BASE + '/' + id + '/delete').expect(302).expect('location', BASE);
    assert.equal((await listAutomations()).some((a) => a.id === id), false);
  });
});

describe('the connections page', () => {
  test('a secret is required, sealed and never echoed back', async () => {
    const refused = await post(admin, CONNECTIONS, { name: 'Jira', tokenUrl: 'https://auth.example.com/token', clientId: 'abc', clientSecret: '' }).expect(400);
    assert.match(refused.text, /Enter the client secret/);

    await post(admin, CONNECTIONS, { name: 'Jira', tokenUrl: 'https://auth.example.com/token', clientId: 'abc', clientSecret: 'very-secret-value', clientAuth: 'basic' }).expect(302);
    const page = await as(admin).get(CONNECTIONS).expect(200);
    assert.match(page.text, /Jira/);
    assert.doesNotMatch(page.text, /very-secret-value/);

    // A refused edit does not put the typed secret back on the page.
    const row = (await query<{ id: string }>('SELECT id FROM automation_connections'))[0]!;
    const bad = await post(admin, CONNECTIONS + '/' + row.id, { name: '', tokenUrl: 'https://auth.example.com/token', clientId: 'abc', clientSecret: 'another-secret' }).expect(400);
    assert.doesNotMatch(bad.text, /another-secret/);

    // Blank keeps the stored secret.
    const before = (await query<{ client_secret: string }>('SELECT client_secret FROM automation_connections'))[0]!.client_secret;
    await post(admin, CONNECTIONS + '/' + row.id, { name: 'Jira cloud', tokenUrl: 'https://auth.example.com/token', clientId: 'abc', clientSecret: '' }).expect(302);
    const after = (await query<{ client_secret: string; name: string }>('SELECT client_secret, name FROM automation_connections'))[0]!;
    assert.equal(after.client_secret, before);
    assert.equal(after.name, 'Jira cloud');
  });

  test('a connection in use cannot be removed', async () => {
    const row = (await query<{ id: string }>('SELECT id FROM automation_connections'))[0]!;
    const created = await post(admin, BASE, { name: 'Uses Jira', trigger: 'ticket.created' }).expect(302);
    const id = String(created.headers.location).split('/').pop()!;
    await post(admin, BASE + '/' + id + '/nodes', { type: 'http_request_auth' }).expect(302);
    const step = (await findAutomation(id))!.graph.nodes.find((n) => n.type === 'http_request_auth')!;
    await post(admin, BASE + '/' + id + '/nodes/' + step.id, { connectionId: row.id, method: 'GET', url: 'https://api.example.com/' }).expect(302);

    await post(admin, CONNECTIONS + '/' + row.id + '/delete').expect(302);
    assert.equal((await query('SELECT id FROM automation_connections')).length, 1);
    const page = await as(admin).get(CONNECTIONS).expect(200);
    assert.match(page.text, /Used by Uses Jira/);
  });
});

describe('the canvas', () => {
  let id = '';
  let trigger = '';

  test('only the editor may run its script, and it loads it', async () => {
    const created = await post(admin, BASE, { name: 'Canvas', trigger: 'ticket.created' }).expect(302);
    id = String(created.headers.location).split('/').pop()!;
    trigger = (await findAutomation(id))!.graph.nodes[0]!.id;
    const editor = await as(admin).get(BASE + '/' + id).expect(200);
    assert.match(String(editor.headers['content-security-policy']), /script-src 'self'/);
    assert.match(editor.text, /<script src="\/assets\/js\/automation-canvas\.js\?v=[^"]+" defer><\/script>/);
    const list = await as(admin).get(BASE).expect(200);
    // The list may load the list search (select-search.js) for a long column
    // menu (lib/column-filters.ts), never the canvas.
    assert.doesNotMatch(list.text, /automation-canvas\.js/);
  });

  test('a new step is placed beside what it follows, not on top of it', async () => {
    await post(admin, BASE + '/' + id + '/arrange').expect(302);
    await post(admin, BASE + '/' + id + '/nodes', { type: 'set_priority', after: trigger + ':next' }).expect(302);
    await post(admin, BASE + '/' + id + '/nodes', { type: 'set_status', after: trigger + ':next' }).expect(302);
    const nodes = (await findAutomation(id))!.graph.nodes;
    const [t, a, b] = nodes;
    assert.ok(a!.x > t!.x, 'to the right of the trigger');
    assert.notDeepEqual([a!.x, a!.y], [b!.x, b!.y], 'two steps never share a spot');
  });

  test('a drag saves the position; a wire drawn on it connects the steps', async () => {
    const nodes = (await findAutomation(id))!.graph.nodes;
    const step = nodes[1]!;
    await post(admin, BASE + '/' + id + '/nodes/' + step.id + '/move', { x: '900', y: '420' }).expect(302).expect('location', BASE + '/' + id + '#diagram');
    const moved = (await findAutomation(id))!.graph.nodes.find((n) => n.id === step.id)!;
    assert.deepEqual([moved.x, moved.y], [900, 420]);

    await post(admin, BASE + '/' + id + '/nodes/' + step.id + '/connect', { pin: 'next', to: nodes[2]!.id }).expect(302);
    assert.ok((await findAutomation(id))!.graph.edges.some((e) => e.from === step.id && e.to === nodes[2]!.id));

    // Into the trigger is refused, as on the cards.
    await post(admin, BASE + '/' + id + '/nodes/' + step.id + '/connect', { pin: 'next', to: trigger }).expect(302);
    assert.equal((await findAutomation(id))!.graph.edges.some((e) => e.to === trigger), false);
  });

  test('the first drag of an automatically laid out graph keeps the other boxes where they were drawn', async () => {
    const created = await post(admin, BASE, { name: 'Auto laid out', trigger: 'ticket.created' }).expect(302);
    const autoId = String(created.headers.location).split('/').pop()!;
    const t = (await findAutomation(autoId))!.graph.nodes[0]!.id;
    // Two steps at the same spot, as graphs built before the canvas have:
    // the diagram lays them out itself.
    await addNode(autoId, 'set_priority', 0, 0, null);
    await addNode(autoId, 'set_status', 0, 0, null);
    assert.ok(t);
    const before = (await findAutomation(autoId))!.graph.nodes;
    assert.ok(before.filter((n) => n.x === 0 && n.y === 0).length >= 2);

    await post(admin, BASE + '/' + autoId + '/nodes/' + before[1]!.id + '/move', { x: '600', y: '300' }).expect(302);
    const after = (await findAutomation(autoId))!.graph.nodes;
    const spots = new Set(after.map((n) => n.x + ',' + n.y));
    assert.equal(spots.size, after.length, 'every box now has a place of its own');
  });
});

describe('one trigger, several actions; settings in popups', () => {
  let id = '';
  let trigger = '';

  test('the first box is called Trigger, and each step is edited in its own popup', async () => {
    const created = await post(admin, BASE, { name: 'Fan out', trigger: 'ticket.created' }).expect(302);
    id = String(created.headers.location).split('/').pop()!;
    trigger = (await findAutomation(id))!.graph.nodes[0]!.id;
    const page = await as(admin).get(BASE + '/' + id).expect(200);
    assert.match(page.text, />Trigger<\/text>/);
    assert.match(page.text, new RegExp('class="dialog dialog--wide" id="edit-' + trigger + '"'));
    assert.match(page.text, new RegExp('<a href="#edit-' + trigger + '">'), 'a box opens its popup');
    assert.match(page.text, /data-canvas-menu hidden/, 'the right-click menu is there for the script');
  });

  test('adding after the trigger twice keeps both, and lands in the new action popup', async () => {
    await post(admin, BASE + '/' + id + '/nodes', { type: 'set_priority', after: trigger + ':next' })
      .expect(302)
      .expect('location', /#edit-/);
    await post(admin, BASE + '/' + id + '/nodes', { type: 'add_comment', after: trigger + ':next' }).expect(302);
    const g = (await findAutomation(id))!.graph;
    assert.equal(g.edges.filter((e) => e.from === trigger).length, 2);
  });

  test('a right-click on an empty spot adds the action there', async () => {
    await post(admin, BASE + '/' + id + '/nodes', { type: 'set_status', x: '700', y: '380' }).expect(302);
    const added = (await findAutomation(id))!.graph.nodes.find((n) => n.type === 'set_status')!;
    assert.deepEqual([added.x, added.y], [700, 380]);
  });

  test('the trigger popup ticks every action it leads to, and saving keeps exactly those', async () => {
    const g = (await findAutomation(id))!.graph;
    const [prio, note, status] = ['set_priority', 'add_comment', 'set_status'].map((t) => g.nodes.find((n) => n.type === t)!.id);
    const page = await as(admin).get(BASE + '/' + id).expect(200);
    assert.match(page.text, new RegExp('name="pin_next" value="' + prio + '" checked'));

    await as(admin)
      .post(BASE + '/' + id + '/nodes/' + trigger)
      .type('form')
      .send('_csrf=' + admin.csrfToken + '&event=ticket.created&pin_next=' + status + '&pin_next=' + note)
      .expect(302);
    const after = (await findAutomation(id))!.graph.edges.filter((e) => e.from === trigger).map((e) => e.to);
    assert.deepEqual(after, [note, status], 'kept in wiring order, the unticked one gone');
    assert.ok(prio);
  });
});

describe('Save and test on the page', () => {
  test('saves the step, then shows the answer once in its popup', async () => {
    const created = await post(admin, BASE, { name: 'Tested call', trigger: 'ticket.created' }).expect(302);
    const id = String(created.headers.location).split('/').pop()!;
    await post(admin, BASE + '/' + id + '/nodes', { type: 'http_request' }).expect(302);
    const step = (await findAutomation(id))!.graph.nodes.find((n) => n.type === 'http_request')!;
    // The private network is not allowed here, so the test is refused - and says why.
    await post(admin, BASE + '/' + id + '/nodes/' + step.id, { method: 'GET', url: 'https://127.0.0.1/ping', test: '1' })
      .expect(302)
      .expect('location', BASE + '/' + id + '#edit-' + step.id);
    assert.equal((await findAutomation(id))!.graph.nodes.find((n) => n.id === step.id)!.config.url, 'https://127.0.0.1/ping', 'saved first');

    const page = await as(admin).get(BASE + '/' + id).expect(200);
    assert.match(page.text, /class="http-test http-test--failed"/);
    assert.match(page.text, /private network/);
    assert.match(page.text, />Save and test</);
    const again = await as(admin).get(BASE + '/' + id).expect(200);
    assert.doesNotMatch(again.text, /class="http-test /, 'shown once');
  });
});

describe('an If step’s value', () => {
  test('is a dropdown for a field with a list, a text box otherwise; the server reads the one that matches', async () => {
    await post(admin, BASE, { name: 'Value pickers', trigger: 'ticket.created' }).expect(302);
    const a = (await listAutomations()).find((x) => x.name === 'Value pickers')!;
    const cond = await addNode(a.id, 'if', 300, 100, null);

    const page = await as(admin).get(BASE + '/' + a.id).expect(200);
    assert.doesNotMatch(page.text, /<datalist/, 'no browser suggestion list');
    assert.match(page.text, /name="value_priority"/);
    assert.match(page.text, /name="value_text"/);

    // Priority chosen: the priority dropdown counts, the text box does not.
    await post(admin, BASE + '/' + a.id + '/nodes/' + cond, {
      field: 'priority', op: 'equals', value_priority: 'urgent', value_status: 'open', value_text: 'ignored',
    }).expect(302);
    let node = (await findAutomation(a.id))!.graph.nodes.find((n) => n.id === cond)!;
    assert.equal(node.config.value, 'urgent');

    // A text field: the text box counts.
    await post(admin, BASE + '/' + a.id + '/nodes/' + cond, {
      field: 'title', op: 'contains', value_priority: 'urgent', value_text: 'printer',
    }).expect(302);
    node = (await findAutomation(a.id))!.graph.nodes.find((n) => n.id === cond)!;
    assert.equal(node.config.value, 'printer');

    // The saved choice is selected when the popup is drawn again.
    await post(admin, BASE + '/' + a.id + '/nodes/' + cond, { field: 'status', op: 'equals', value_status: 'pending' }).expect(302);
    const again = await as(admin).get(BASE + '/' + a.id).expect(200);
    assert.match(again.text, /name="value_status">[\s\S]*?<option value="pending" selected>/);
  });
});

describe('the diagram reads like the settings', () => {
  test('a box names a template, not its id; the zoom controls are there for the script', async () => {
    const { ensureDefaultTemplate } = await import('../src/services/templates.js');
    const { configureNode } = await import('../src/services/automation.js');
    const template = await ensureDefaultTemplate();
    await post(admin, BASE, { name: 'Named boxes', trigger: 'ticket.created' }).expect(302);
    const a = (await listAutomations()).find((x) => x.name === 'Named boxes')!;
    const cond = await addNode(a.id, 'if', 300, 100, null);
    await configureNode(a.id, cond, { field: 'template', op: 'equals', value: template.id }, null);
    const { connect } = await import('../src/services/automation.js');
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    await connect(a.id, trigger, 'next', cond, null);

    const page = await as(admin).get(BASE + '/' + a.id).expect(200);
    const svg = page.text.slice(page.text.indexOf('<svg class="automation-diagram"'), page.text.indexOf('</svg>', page.text.indexOf('<svg class="automation-diagram"')));
    assert.match(svg, new RegExp('Template is ' + template.name.slice(0, 10)));
    assert.ok(!svg.includes(template.id.slice(0, 13) + '<'), 'no raw id in the box');
    assert.match(page.text, /data-canvas-zoom hidden/);
    assert.match(page.text, /data-zoom="fit"/);
  });
});
