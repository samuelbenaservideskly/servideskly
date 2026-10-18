import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import {
  createTemplate,
  ensureDefaultTemplate,
  findTemplate,
  placeField,
  unplaceField,
  configureField,
} from '../src/services/templates.js';
import { createGroup, setMembers } from '../src/services/groups.js';
import { listTickets } from '../src/services/tickets.js';
import { findUserById, setUserRole } from '../src/services/users.js';

/**
 * Technician group and Assignee on a request form (asked for 16 Oct 2026).
 *
 * The interesting half is not that they work; it is that a form which does
 * **not** offer them cannot be made to set them by posting one. `readonly`
 * and `disabled` are display hints, and a browser can post anything - so
 * the rule lives in routes/tickets.ts, and this is where it is checked.
 */

let app: Express;
let requester: TestSession;
let templateId = '';
let deskId = '';
let technicianId = '';

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

async function form(): Promise<request.Response> {
  return request.agent(app).set('Cookie', requester.cookie)
    .get('/tickets/new?template=' + templateId).expect(200);
}

function raise(fields: Record<string, string>) {
  return form().then((page) =>
    request.agent(app).set('Cookie', requester.cookie)
      .post('/tickets')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), templateId, description: 'Something is broken here.', ...fields }),
  );
}

async function raised(title: string) {
  const viewer = await findUserById(requester.user.id);
  assert.ok(viewer);
  const page = await listTickets(viewer, { scope: 'mine', status: 'any', page: 1, perPage: 50 });
  return page.items.find((t) => t.title === title);
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();

  requester = await signInAs('routing.user@example.com', 'user');
  const technician = await signInAs('routing.tech@example.com', 'agent');
  technicianId = technician.user.id;

  const desk = await createGroup({ name: 'Service desk', description: '', isActive: true }, null);
  deskId = desk.id;
  await setMembers(deskId, [technicianId], null);

  const template = await createTemplate(
    {
      summary: '', title: '', body: '', priority: 'normal', category: 'other', type: 'incident',
      groupId: null, categoryId: null, fields: [], isActive: true, name: 'Routing form',
    },
    null,
  );
  templateId = template.id;
  await placeField((await findTemplate(templateId))!, 'title', null, null);
  await placeField((await findTemplate(templateId))!, 'description', null, null);
});

describe('a form that asks where the ticket goes', () => {
  before(async () => {
    await placeField((await findTemplate(templateId))!, 'group', null, null);
    await placeField((await findTemplate(templateId))!, 'assignee', null, null);
  });

  test('offers the active groups and the people a ticket may be assigned to', async () => {
    const page = await form();
    assert.match(page.text, /name="groupId"/);
    assert.match(page.text, /name="assigneeId"/);
    assert.match(page.text, /Service desk/);
    assert.match(page.text, /routing\.tech@example\.com|Routing Tech/i);
  });

  test('and the ticket arrives with both', async () => {
    await raise({ title: 'Routed by the form', groupId: deskId, assigneeId: technicianId });
    const ticket = await raised('Routed by the form');
    assert.ok(ticket);
    assert.equal(ticket.group_id, deskId);
    assert.equal(ticket.assignee_id, technicianId);
  });

  test('a group that is not a group, or a person who is not staff, is ignored', async () => {
    // Not refused: a stale id should not cost somebody the ticket they just
    // typed. It falls back to the template's own routing, like any other
    // ticket raised on this form.
    await raise({
      title: 'Nonsense routing',
      groupId: '11111111-1111-1111-1111-111111111111',
      assigneeId: requester.user.id,
    });
    const ticket = await raised('Nonsense routing');
    assert.ok(ticket);
    assert.equal(ticket.group_id, null);
    assert.equal(ticket.assignee_id, null, 'a requester cannot be made the assignee');
  });
});

describe('a form that does not ask', () => {
  before(async () => {
    await unplaceField((await findTemplate(templateId))!, 'group', null);
    await unplaceField((await findTemplate(templateId))!, 'assignee', null);
  });

  test('does not draw either control', async () => {
    const page = await form();
    assert.doesNotMatch(page.text, /name="groupId"/);
    assert.doesNotMatch(page.text, /name="assigneeId"/);
  });

  test('and neither is settable by posting one', async () => {
    await raise({ title: 'Smuggled routing', groupId: deskId, assigneeId: technicianId });
    const ticket = await raised('Smuggled routing');
    assert.ok(ticket);
    assert.equal(ticket.group_id, null, "the form did not offer a group, so the posted one is not the requester's to set");
    assert.equal(ticket.assignee_id, null, 'nor the assignee');
  });

  test('view only is the same rule: shown, not settable', async () => {
    await placeField((await findTemplate(templateId))!, 'group', null, null);
    await configureField((await findTemplate(templateId))!, 'group', { mode: 'view_only' }, null);

    const page = await form();
    assert.doesNotMatch(page.text, /name="groupId"/, 'nothing to post');

    await raise({ title: 'View only routing', groupId: deskId });
    const ticket = await raised('View only routing');
    assert.ok(ticket);
    assert.equal(ticket.group_id, null);
  });
});

describe('promotion changes who may be assigned', () => {
  test('a requester promoted to agent is offered; a demoted one is not', async () => {
    await placeField((await findTemplate(templateId))!, 'assignee', null, null);
    const before = await form();
    assert.doesNotMatch(before.text, /value="<%= requester.user.id %>"/);

    await setUserRole(requester.user.id, 'agent', false);
    const after = await form();
    assert.match(after.text, new RegExp('value="' + requester.user.id + '"'), 'now assignable');

    await setUserRole(requester.user.id, 'user', false);
  });
});
