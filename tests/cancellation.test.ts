import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import { settings } from '../src/settings/index.js';
import { createTicket, getTicketById } from '../src/services/tickets.js';
import { addNode, configureNode, connect, createAutomation, findAutomation, setAutomationEnabled } from '../src/services/automation.js';

let app: Express;
let admin: TestSession;
let agent: TestSession;
let requester: TestSession;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}
const raise = (title: string) =>
  createTicket({ title, description: 'Raised by the cancellation tests.', priority: 'normal', category: 'other', requesterId: requester.user.id });
const comments = async (id: string) =>
  (await query<{ body: string; is_internal: number }>('SELECT body, is_internal FROM ticket_comments WHERE ticket_id = ?', [id]));

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('cancel.admin@example.com', 'admin');
  agent = await signInAs('cancel.agent@example.com', 'agent');
  requester = await signInAs('cancel.requester@example.com', 'user');
});

describe('Settings - Tickets - Other settings - Status notes', () => {
  test('a panel with both switches, off by default; the old addresses lead to it', async () => {
    assert.equal(settings().tickets.requireCancelNote, false);
    assert.equal(settings().tickets.requireResolveNote, false);
    const page = await as(admin).get('/admin/settings/templates/other').expect(200);
    assert.match(page.text, /id="status-notes"/);
    assert.match(page.text, /name="requireCancelNote"/);
    assert.match(page.text, /name="requireResolveNote"/);
    // Both sub-tabs of before open their panel on the one page.
    const notes = await as(admin).get('/admin/settings/templates/other/status-notes').expect(308);
    assert.equal(notes.headers.location, '/admin/settings/templates/other#status-notes');
    const old = await as(admin).get('/admin/settings/templates/other/cancellation').expect(308);
    assert.equal(old.headers.location, '/admin/settings/templates/other/status-notes');
  });

  test('off: cancelling needs no note, and one given is still posted', async () => {
    const plain = await raise('Cancel quietly');
    await post(agent, '/tickets/' + plain.id + '/update', { status: 'cancelled' }).expect(302);
    assert.equal((await getTicketById(plain.id))?.status, 'cancelled');
    assert.equal((await comments(plain.id)).length, 0);

    const noted = await raise('Cancel with a word');
    await post(agent, '/tickets/' + noted.id + '/update', { status: 'cancelled', cancelNote: 'Duplicate of INC-000001' }).expect(302);
    assert.deepEqual((await comments(noted.id)).map((c) => c.body), ['Cancelled: Duplicate of INC-000001']);
  });

  test('on: cancelling without a note is refused beside the form; with one it is a visible comment', async () => {
    await post(admin, '/admin/settings/templates/other/status-notes', { requireCancelNote: 'on' }).expect(302);
    assert.equal(settings().tickets.requireCancelNote, true);
    assert.equal(settings().tickets.requireResolveNote, false);

    const t = await raise('Needs a reason');
    await post(agent, '/tickets/' + t.id + '/update', { status: 'cancelled' }).expect(302);
    assert.equal((await getTicketById(t.id))?.status, 'open', 'refused');
    const page = await as(agent).get('/tickets/' + t.id).expect(200);
    assert.match(page.text, /Say why the ticket is being cancelled/);
    assert.match(page.text, /Cancellation note <span class="required">\*<\/span>/);

    await post(agent, '/tickets/' + t.id + '/update', { status: 'cancelled', cancelNote: 'Requester withdrew it' }).expect(302);
    assert.equal((await getTicketById(t.id))?.status, 'cancelled');
    const c = await comments(t.id);
    assert.equal(c[0]?.body, 'Cancelled: Requester withdrew it');
    assert.equal(Number(c[0]?.is_internal), 0, 'the requester sees it');

    // Other changes are untouched by the rule.
    const other = await raise('Just resolve it');
    await post(agent, '/tickets/' + other.id + '/update', { status: 'resolved' }).expect(302);
    assert.equal((await getTicketById(other.id))?.status, 'resolved');
  });

  test('resolving: optional note posted; required once switched on', async () => {
    const noted = await raise('Resolve with a word');
    await post(agent, '/tickets/' + noted.id + '/update', { status: 'resolved', resolveNote: 'Replaced the cable' }).expect(302);
    assert.deepEqual((await comments(noted.id)).map((c) => c.body), ['Resolved: Replaced the cable']);

    await post(admin, '/admin/settings/templates/other/status-notes', { requireCancelNote: 'on', requireResolveNote: 'on' }).expect(302);
    assert.equal(settings().tickets.requireResolveNote, true);

    const t = await raise('Needs a resolution');
    await post(agent, '/tickets/' + t.id + '/update', { status: 'resolved' }).expect(302);
    assert.equal((await getTicketById(t.id))?.status, 'open', 'refused');
    const page = await as(agent).get('/tickets/' + t.id).expect(200);
    assert.match(page.text, /Say how the ticket was resolved/);
    assert.match(page.text, /Resolution note <span class="required">\*<\/span>/);

    await post(agent, '/tickets/' + t.id + '/update', { status: 'resolved', resolveNote: 'Reset the password' }).expect(302);
    assert.equal((await getTicketById(t.id))?.status, 'resolved');
    const c = await comments(t.id);
    assert.equal(c[0]?.body, 'Resolved: Reset the password');
    assert.equal(Number(c[0]?.is_internal), 0);

    // Closing is not resolving.
    const closing = await raise('Close it');
    await post(agent, '/tickets/' + closing.id + '/update', { status: 'closed' }).expect(302);
    assert.equal((await getTicketById(closing.id))?.status, 'closed');
  });

  test('an automation decides for itself whether to add a note', async () => {
    const a = await createAutomation('Cancel stale ones', 'ticket.created', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    const step = await addNode(a.id, 'set_status', 300, 100, null);
    await configureNode(a.id, step, { status: 'cancelled', addNote: 'on', note: 'Cancelled by rule for {{ticket.reference}}', noteInternal: 'on' }, null);
    await connect(a.id, trigger, 'next', step, null);
    await setAutomationEnabled(a.id, true, null);

    const t = await raise('Cancelled by a rule');
    assert.equal((await getTicketById(t.id))?.status, 'cancelled');
    const c = await comments(t.id);
    assert.equal(c[0]?.body, 'Cancelled: Cancelled by rule for ' + t.reference);
    assert.equal(Number(c[0]?.is_internal), 1);

    // Without "Add a note" it cancels silently, even though the setting is on.
    await configureNode(a.id, step, { status: 'cancelled' }, null);
    const quiet = await raise('Cancelled without a word');
    assert.equal((await getTicketById(quiet.id))?.status, 'cancelled');
    assert.equal((await comments(quiet.id)).length, 0);
    await setAutomationEnabled(a.id, false, null);
  });
});
