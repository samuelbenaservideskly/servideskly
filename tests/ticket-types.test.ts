import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import {
  addTaskTemplate,
  createTemplate,
  findTemplate,
  listActiveTemplates,
  listAllTemplates,
  listTaskTemplates,
  placeField,
} from '../src/services/templates.js';
import {
  createTicket,
  listTasks,
  listTickets,
  openTaskCount,
} from '../src/services/tickets.js';
import { createGroup } from '../src/services/groups.js';
import { createCategory } from '../src/services/catalogue.js';
import { findUserById } from '../src/services/users.js';

let app: Express;
let admin: TestSession;
let adminAgent: request.Agent;
let userAgent: request.Agent;
let requesterId: string;

const BASE = {
  summary: '',
  title: '',
  body: '',
  priority: 'normal' as const,
  category: 'other' as const,
  type: 'incident' as const,
  groupId: null,
  categoryId: null,
  fields: [],
  isActive: true,
};

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();

  admin = await signInAs('types.admin@example.com', 'admin');
  adminAgent = request.agent(app);
  adminAgent.set('Cookie', admin.cookie);

  const plain = await signInAs('types.user@example.com', 'user');
  userAgent = request.agent(app);
  userAgent.set('Cookie', plain.cookie);
  requesterId = plain.user.id;
});

describe('ticket types', () => {
  test('a ticket defaults to an incident', async () => {
    const ticket = await createTicket({
      title: 'A ticket with no type given',
      description: 'The default has to be something, and an incident is the common case.',
      priority: 'normal',
      category: 'other',
      requesterId,
    });
    assert.equal(ticket.type, 'incident');
  });

  test('a template declares what it raises', async () => {
    for (const type of ['incident', 'service_request', 'change_request'] as const) {
      const template = await createTemplate({ ...BASE, name: 'Raises a ' + type, type }, null);
      assert.equal(template.type, type);

      const ticket = await createTicket({
        title: 'Raised from the ' + type + ' template',
        description: 'The type must carry across from the template to the ticket.',
        priority: 'normal',
        category: 'other',
        requesterId,
        templateId: template.id,
        type: template.type,
      });
      assert.equal(ticket.type, type);
    }
  });

  test('the queue can be filtered by type', async () => {
    const viewer = await findUserById(admin.user.id);
    assert.ok(viewer);

    const changes = await listTickets(viewer, {
      scope: 'all',
      status: 'any',
      type: 'change_request',
      page: 1,
      perPage: 50,
    });
    assert.ok(changes.total > 0);
    assert.ok(
      changes.items.every((t) => t.type === 'change_request'),
      'the filter must be applied in SQL, not just rendered',
    );
  });
});

describe('tasks', () => {
  let parentTemplate: string;
  let groupId: string;

  before(async () => {
    const group = await createGroup(
      { name: 'Task Team', description: '', isActive: true },
      null,
    );
    groupId = group.id;

    const template = await createTemplate(
      { ...BASE, name: 'New starter', type: 'service_request', title: 'New starter' },
      null,
    );
    parentTemplate = template.id;
    // A template's form starts empty, so put on what a requester will use.
    for (const key of ['title', 'category', 'priority', 'description']) {
      await placeField((await findTemplate(parentTemplate))!, key, null, null);
    }

    await addTaskTemplate(
      parentTemplate,
      { ...BASE, name: 'Prepare the laptop', title: 'Prepare the laptop', groupId },
      null,
    );
    await addTaskTemplate(
      parentTemplate,
      { ...BASE, name: 'Create the accounts', title: 'Create the accounts'},
      null,
    );
  });

  test('task templates hang off their parent and are not offered alone', async () => {
    const tasks = await listTaskTemplates(parentTemplate);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.type === 'task'));
    assert.deepEqual(
      tasks.map((t) => t.name),
      ['Prepare the laptop', 'Create the accounts'],
      'ordered, so a sequence of steps stays in sequence',
    );

    const offered = await listActiveTemplates();
    assert.ok(!offered.some((t) => t.parent_template_id), 'a task is never a choice on its own');
    const listed = await listAllTemplates();
    assert.ok(!listed.some((t) => t.parent_template_id), 'nor in the administration list');
  });

  test('a task cannot carry tasks of its own', async () => {
    const [task] = await listTaskTemplates(parentTemplate);
    assert.ok(task);
    await assert.rejects(
      () => addTaskTemplate(task.id, { ...BASE, name: 'Nested' }, null),
      /cannot carry tasks/,
    );
  });

  test('raising the template raises its tasks, each routed on its own', async () => {
    const form = await userAgent.get('/tickets/new?template=' + parentTemplate).expect(200);
    const created = await userAgent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('templateId', parentTemplate)
      .field('title', 'New starter: Dana Scott')
      .field('priority', 'normal')
      .field('category', 'other')
      .field('description', 'Dana starts on Monday.')
      .expect(302);

    const path = created.headers.location as string;
    const id = path.split('/').pop()!;

    const tasks = await listTasks(id);
    assert.equal(tasks.length, 2, 'both tasks are raised with the ticket');
    assert.ok(tasks.every((t) => t.type === 'task'));
    assert.ok(tasks.every((t) => t.parent_id === id));

    const laptop = tasks.find((t) => t.title === 'Prepare the laptop');
    assert.equal(laptop?.group_id, groupId, 'a task carries its own routing');
    const accounts = tasks.find((t) => t.title === 'Create the accounts');
    assert.equal(accounts?.group_id, null, 'and one without a group stays unrouted');

    assert.equal(await openTaskCount(id), 2);
  });

  test('the ticket page shows its tasks and the task shows its parent', async () => {
    const queue = await adminAgent.get('/tickets?scope=all&status=any').expect(200);
    const match = /href="\/tickets\/([0-9a-f-]{36})"[^>]*>New starter: Dana Scott/.exec(queue.text);
    assert.ok(match, 'the parent should be in the queue');
    const parentId = match[1] as string;

    const page = await adminAgent.get('/tickets/' + parentId).expect(200);
    assert.match(page.text, /Prepare the laptop/);
    assert.match(page.text, /Create the accounts/);

    const tasks = await listTasks(parentId);
    const task = await adminAgent.get('/tickets/' + tasks[0]!.id).expect(200);
    assert.match(task.text, /A task under/);
    assert.match(task.text, /New starter: Dana Scott/);
  });

  test('tasks stay out of the queue, so they do not double up', async () => {
    const viewer = await findUserById(admin.user.id);
    assert.ok(viewer);

    const queue = await listTickets(viewer, {
      scope: 'all',
      status: 'any',
      page: 1,
      perPage: 200,
    });
    assert.ok(
      queue.items.every((t) => t.parent_id === null),
      'a task belongs under its parent, not alongside it',
    );

    // They are still reachable when asked for.
    const withTasks = await listTickets(viewer, {
      scope: 'all',
      status: 'any',
      type: 'task',
      includeTasks: true,
      page: 1,
      perPage: 200,
    });
    assert.ok(withTasks.total >= 2);
  });

  test('deleting the parent takes its tasks with it', async () => {
    const parent = await createTicket({
      title: 'A parent about to be deleted',
      description: 'Its tasks have no meaning once it is gone, so they cascade.',
      priority: 'low',
      category: 'other',
      requesterId,
    });
    await createTicket({
      title: 'A task that should cascade away',
      description: 'It belongs to the ticket above and nothing else.',
      priority: 'low',
      category: 'other',
      requesterId,
      type: 'task',
      parentId: parent.id,
    });
    assert.equal((await listTasks(parent.id)).length, 1);

    const { execute } = await import('../src/db/index.js');
    await execute('DELETE FROM tickets WHERE id = ?', [parent.id]);
    assert.equal((await listTasks(parent.id)).length, 0);
  });
});

describe('a template routes its work', () => {
  test('the default technician group and category carry to the ticket', async () => {
    const group = await createGroup(
      { name: 'Routing Team', description: '', isActive: true },
      null,
    );
    const category = await createCategory(
      { name: 'Routed', description: '', parentId: null, isActive: true, sortOrder: 100, groupId: null },
      null,
    );

    const template = await createTemplate(
      {
        ...BASE,
        name: 'Routed request',
        title: 'Routed request',
        type: 'service_request',
        groupId: group.id,
        categoryId: category.id,
      },
      null,
    );
    for (const key of ['title', 'category', 'priority', 'description']) {
      await placeField((await findTemplate(template.id))!, key, null, null);
    }

    const form = await userAgent.get('/tickets/new?template=' + template.id).expect(200);
    assert.match(
      form.text,
      new RegExp('value="' + category.id + '" selected'),
      'the category is preselected on the form',
    );

    const created = await userAgent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('templateId', template.id)
      .field('title', 'Please do the routed thing')
      .field('priority', 'normal')
      .field('category', 'other')
      .field('categoryId', category.id)
      .field('description', 'It should land with the right team without triage.')
      .expect(302);

    const id = (created.headers.location as string).split('/').pop()!;
    const { getTicketById } = await import('../src/services/tickets.js');
    const ticket = await getTicketById(id);

    assert.equal(ticket?.group_id, group.id, 'routed without anyone having to triage it');
    assert.equal(ticket?.category_id, category.id);
    assert.equal(ticket?.type, 'service_request');
  });

  test('a category that has since been removed is dropped, not fatal', async () => {
    const form = await userAgent.get('/tickets/new').expect(200);
    await userAgent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('title', 'Filed against a category that no longer exists')
      .field('priority', 'normal')
      .field('category', 'other')
      .field('categoryId', '00000000-0000-4000-8000-000000000000')
      .field('description', 'A stale picker must not cost someone the ticket they typed.')
      .expect(302);
  });
});
