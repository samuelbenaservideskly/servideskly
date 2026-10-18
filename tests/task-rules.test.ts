import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import {
  addTaskTemplate,
  createTemplate,
  ensureDefaultTemplate,
  findTemplate,
  listTaskTemplates,
  placeField,
  setTaskMandatory,
  setTaskRules,
} from '../src/services/templates.js';
import { getTicketById, updateTicket } from '../src/services/tickets.js';

let app: Express;
let admin: TestSession;
let agent: TestSession;
let requester: TestSession;

const BASE = {
  summary: '',
  title: '',
  body: '',
  priority: 'normal' as const,
  category: 'other' as const,
  type: 'service_request' as const,
  groupId: null,
  categoryId: null,
  fields: [],
  isActive: true,
};

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}

/** A template with two tasks: Laptop (mandatory) and Welcome pack (optional). */
async function onboarding(name: string, rules: { closeWhenTasksDone: boolean; requireTasksDone: boolean }): Promise<string> {
  const t = await createTemplate({ ...BASE, name }, null);
  await placeField((await findTemplate(t.id))!, 'title', null, null);
  await placeField((await findTemplate(t.id))!, 'description', null, null);
  const laptop = await addTaskTemplate(t.id, { ...BASE, name: name + ' - Laptop', title: 'Laptop', type: 'task' }, null);
  await addTaskTemplate(t.id, { ...BASE, name: name + ' - Welcome pack', title: 'Welcome pack', type: 'task' }, null);
  await setTaskMandatory(t.id, laptop.id, true);
  await setTaskRules(t.id, rules);
  return t.id;
}

/** Raises a ticket from the template through the form; returns it and its tasks. */
async function raise(templateId: string, title: string) {
  await post(requester, '/tickets', { templateId, title, description: 'A new starter on Monday.' }).expect(302);
  const parent = (await query<{ id: string }>('SELECT id FROM tickets WHERE title = ? AND parent_id IS NULL', [title]))[0]!;
  const tasks = await query<{ id: string; title: string; task_mandatory: number }>(
    'SELECT id, title, task_mandatory FROM tickets WHERE parent_id = ? ORDER BY title',
    [parent.id],
  );
  return { parent: parent.id, laptop: tasks.find((t) => t.title === 'Laptop')!, pack: tasks.find((t) => t.title === 'Welcome pack')! };
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('tasks.admin@example.com', 'admin');
  agent = await signInAs('tasks.agent@example.com', 'agent');
  requester = await signInAs('tasks.user@example.com', 'user');
});

describe('mandatory tasks', () => {
  test('the mandatory flag travels from the template to the raised task', async () => {
    const id = await onboarding('Flags', { closeWhenTasksDone: false, requireTasksDone: false });
    const r = await raise(id, 'Flags ticket');
    assert.equal(Number(r.laptop.task_mandatory), 1);
    assert.equal(Number(r.pack.task_mandatory), 0);
  });

  test('closes the ticket once every mandatory task is resolved, and says so', async () => {
    const id = await onboarding('Auto close', { closeWhenTasksDone: true, requireTasksDone: false });
    const r = await raise(id, 'Auto close ticket');
    await updateTicket(r.laptop.id, agent.user.id, { status: 'resolved' });
    assert.equal((await getTicketById(r.parent))?.status, 'closed');
    const comments = await query<{ body: string }>('SELECT body FROM ticket_comments WHERE ticket_id = ?', [r.parent]);
    assert.match(comments.map((c) => c.body).join(' '), /Closed automatically/);
  });

  test('a cancelled mandatory task counts as done', async () => {
    const id = await onboarding('Cancelled counts', { closeWhenTasksDone: true, requireTasksDone: false });
    const r = await raise(id, 'Cancelled counts ticket');
    await updateTicket(r.laptop.id, agent.user.id, { status: 'cancelled' });
    assert.equal((await getTicketById(r.parent))?.status, 'closed');
  });
});

describe('closing only when every task is resolved', () => {
  test('the page refuses beside the form, and the service refuses too', async () => {
    const id = await onboarding('Gate', { closeWhenTasksDone: false, requireTasksDone: true });
    const r = await raise(id, 'Gate ticket');
    await post(agent, '/tickets/' + r.parent + '/update', { status: 'resolved' }).expect(302);
    assert.equal((await getTicketById(r.parent))?.status, 'open');
    const page = await as(agent).get('/tickets/' + r.parent).expect(200);
    assert.match(page.text, /2 tasks are still open/);
    await assert.rejects(updateTicket(r.parent, agent.user.id, { status: 'closed' }), /still open/);

    await updateTicket(r.laptop.id, agent.user.id, { status: 'resolved' });
    await updateTicket(r.pack.id, agent.user.id, { status: 'cancelled' });
    await post(agent, '/tickets/' + r.parent + '/update', { status: 'resolved' }).expect(302);
    assert.equal((await getTicketById(r.parent))?.status, 'resolved');
  });

  test('with both rules, the mandatory task alone does not close it while another is open', async () => {
    const id = await onboarding('Both', { closeWhenTasksDone: true, requireTasksDone: true });
    const r = await raise(id, 'Both ticket');
    await updateTicket(r.laptop.id, agent.user.id, { status: 'resolved' });
    assert.equal((await getTicketById(r.parent))?.status, 'open');
    await updateTicket(r.pack.id, agent.user.id, { status: 'resolved' });
    assert.equal((await getTicketById(r.parent))?.status, 'closed');
  });
});

describe('the template page', () => {
  test('a task is added mandatory, toggled, and the rules are saved', async () => {
    const t = await createTemplate({ ...BASE, name: 'Page rules' }, null);
    await post(admin, '/admin/settings/templates/' + t.id + '/tasks', { name: 'Badge', parentId: t.id, mandatory: 'on' }).expect(302);
    const [task] = await listTaskTemplates(t.id);
    assert.equal(task?.task_mandatory, true);

    await post(admin, '/admin/settings/templates/' + t.id + '/tasks/' + task!.id + '/mandatory', {}).expect(302);
    assert.equal((await listTaskTemplates(t.id))[0]?.task_mandatory, false);

    await post(admin, '/admin/settings/templates/' + t.id + '/task-rules', { closeWhenTasksDone: 'on' }).expect(302);
    const saved = (await findTemplate(t.id))!;
    assert.deepEqual([saved.close_when_tasks_done, saved.require_tasks_done], [true, false]);

    const page = await as(admin).get('/admin/settings/templates/' + t.id).expect(200);
    assert.match(page.text, /name="closeWhenTasksDone" value="on" checked/);
    assert.match(page.text, /Make mandatory/);
  });
});
