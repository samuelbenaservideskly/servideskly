import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import {
  clearGroupsForUser,
  createGroup,
  deleteGroup,
  groupIdsForUser,
  groupsForUser,
  listActiveGroups,
  listGroups,
  listMembers,
  setGroupsForUser,
  setMembers,
  updateGroup,
} from '../src/services/groups.js';
import { createTicket, getTicketById, listTickets, updateTicket } from '../src/services/tickets.js';
import { findUserById, setUserRole } from '../src/services/users.js';
import { queryOne } from '../src/db/index.js';

let app: Express;
let admin: TestSession;
let adminAgent: request.Agent;
let userAgent: request.Agent;

const BASE = { description: '', isActive: true };

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();

  admin = await signInAs('groups.admin@example.com', 'admin');
  adminAgent = request.agent(app);
  adminAgent.set('Cookie', admin.cookie);

  const plain = await signInAs('groups.user@example.com', 'user');
  userAgent = request.agent(app);
  userAgent.set('Cookie', plain.cookie);
});

describe('group storage', () => {
  test('refuses a second group with the same name, whatever the case', async () => {
    await createGroup({ ...BASE, name: 'Networks' }, null);
    await assert.rejects(
      () => createGroup({ ...BASE, name: 'networks' }, null),
      /already exists/,
    );
  });

  test('groups come back alphabetically, whatever order they were made in', async () => {
    // There is no sort order to set any more: a list read by name has no
    // right answer for a number, so the name decides.
    for (const name of ['Zebra Team', 'alpha team', 'Middle Team']) {
      await createGroup({ ...BASE, name }, null);
    }

    const names = (await listGroups()).map((g) => g.name);
    const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    assert.deepEqual(names, sorted, 'case must not push a lower-case name to the end');
  });

  test('a retired group is kept but no longer offered', async () => {
    const created = await createGroup({ ...BASE, name: 'To Retire' }, null);
    assert.ok((await listActiveGroups()).some((g) => g.id === created.id));

    await updateGroup(created.id, { ...BASE, name: 'To Retire', isActive: false }, null);
    assert.ok(
      !(await listActiveGroups()).some((g) => g.id === created.id),
      'a retired group must not be offered for routing',
    );
    assert.ok(
      (await listGroups()).some((g) => g.id === created.id),
      'but it must still be listed for an administrator',
    );
  });

  test('counts members and open tickets', async () => {
    const group = await createGroup({ ...BASE, name: 'Counting' }, null);
    const agent = await signInAs('groups.counter@example.com', 'agent');
    const agentUser = await findUserById(agent.user.id);
    assert.ok(agentUser);
    await setMembers(group.id, [agentUser.id], null);

    const ticket = await createTicket({
      title: 'A ticket to count against the group',
      description: 'It is routed to the group so the open count can be checked.',
      priority: 'normal',
      category: 'other',
      requesterId: agentUser.id,
    });
    await updateTicket(ticket.id, agentUser.id, { groupId: group.id });

    const listed = (await listGroups()).find((g) => g.id === group.id);
    assert.equal(listed?.member_count, 1);
    assert.equal(listed?.open_count, 1);

    // A closed ticket is no longer open work.
    await updateTicket(ticket.id, agentUser.id, { status: 'closed' });
    const after = (await listGroups()).find((g) => g.id === group.id);
    assert.equal(after?.open_count, 0);
  });

  test('removing a group leaves its tickets, unrouted', async () => {
    const group = await createGroup({ ...BASE, name: 'Doomed' }, null);
    const agent = await signInAs('groups.doomed@example.com', 'agent');
    const ticket = await createTicket({
      title: 'A ticket whose group is about to be removed',
      description: 'It must survive the group being deleted, and simply lose its routing.',
      priority: 'normal',
      category: 'other',
      requesterId: agent.user.id,
    });
    await updateTicket(ticket.id, agent.user.id, { groupId: group.id });
    assert.equal((await getTicketById(ticket.id))?.group_id, group.id);

    await deleteGroup(group.id, null);

    const after = await getTicketById(ticket.id);
    assert.ok(after, 'the ticket must still exist');
    assert.equal(after.group_id, null, 'and simply have no group any more');
  });
});

describe('membership is for staff only', () => {
  test('refuses to put a plain user in a group', async () => {
    const group = await createGroup({ ...BASE, name: 'Staff Only' }, null);
    const plain = await findUserById((await signInAs('groups.plain@example.com', 'user')).user.id);
    assert.ok(plain);

    await assert.rejects(
      () => setGroupsForUser(plain, [group.id], null),
      /Only agents and administrators/,
    );
    assert.deepEqual(await groupIdsForUser(plain.id), []);
  });

  test('allows an agent, and replaces the whole set on each save', async () => {
    const one = await createGroup({ ...BASE, name: 'Set A' }, null);
    const two = await createGroup({ ...BASE, name: 'Set B' }, null);
    const agent = await findUserById((await signInAs('groups.setter@example.com', 'agent')).user.id);
    assert.ok(agent);

    await setGroupsForUser(agent, [one.id, two.id], null);
    assert.equal((await groupsForUser(agent.id)).length, 2);

    await setGroupsForUser(agent, [two.id], null);
    const after = await groupsForUser(agent.id);
    assert.equal(after.length, 1, 'saving replaces rather than adds');
    assert.equal(after[0]?.id, two.id);

    await setGroupsForUser(agent, [], null);
    assert.deepEqual(await groupsForUser(agent.id), []);
  });

  test('clearing membership is what a demotion does', async () => {
    const group = await createGroup({ ...BASE, name: 'Demotion' }, null);
    const agent = await findUserById((await signInAs('groups.demote@example.com', 'agent')).user.id);
    assert.ok(agent);
    await setGroupsForUser(agent, [group.id], null);
    assert.equal((await groupIdsForUser(agent.id)).length, 1);

    const dropped = await clearGroupsForUser(agent.id);
    assert.equal(dropped, 1);
    assert.deepEqual(await groupIdsForUser(agent.id), []);
  });

  test('membership disappears with the account', async () => {
    const group = await createGroup({ ...BASE, name: 'Cascade' }, null);
    const agent = await findUserById((await signInAs('groups.cascade@example.com', 'agent')).user.id);
    assert.ok(agent);
    await setMembers(group.id, [agent.id], null);

    const { execute } = await import('../src/db/index.js');
    await execute('DELETE FROM users WHERE id = ?', [agent.id]);

    const orphans = await queryOne<{ c: number }>(
      'SELECT count(*) AS c FROM technician_group_members WHERE user_id = ?',
      [agent.id],
    );
    assert.equal(orphans?.c, 0, 'the membership row must cascade away');
  });
});

describe('routing tickets to a group', () => {
  test('the queue can be filtered by group', async () => {
    const group = await createGroup({ ...BASE, name: 'Filterable' }, null);
    const agent = await findUserById((await signInAs('groups.filter@example.com', 'agent')).user.id);
    assert.ok(agent);

    const routed = await createTicket({
      title: 'Routed to the filterable group',
      description: 'This one carries a group so the queue filter can find it.',
      priority: 'normal',
      category: 'other',
      requesterId: agent.id,
    });
    await updateTicket(routed.id, agent.id, { groupId: group.id });

    await createTicket({
      title: 'Not routed anywhere at all',
      description: 'This one has no group, so the filter must not return it.',
      priority: 'normal',
      category: 'other',
      requesterId: agent.id,
    });

    const page = await listTickets(agent, {
      scope: 'all',
      status: 'any',
      groupId: group.id,
      page: 1,
      perPage: 50,
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.title, 'Routed to the filterable group');
  });

  test('"my teams" matches nothing for someone in no team, rather than everything', async () => {
    const agent = await findUserById((await signInAs('groups.noteam@example.com', 'agent')).user.id);
    assert.ok(agent);

    const page = await listTickets(agent, {
      scope: 'myGroups',
      status: 'any',
      viewerGroupIds: [],
      page: 1,
      perPage: 50,
    });
    assert.equal(page.total, 0, 'an empty membership must not match the whole queue');
  });

  test('"my teams" returns the tickets routed to a team the viewer is in', async () => {
    const group = await createGroup({ ...BASE, name: 'My Team' }, null);
    const agent = await findUserById((await signInAs('groups.myteam@example.com', 'agent')).user.id);
    assert.ok(agent);
    await setGroupsForUser(agent, [group.id], null);

    const ticket = await createTicket({
      title: 'Work for my own team',
      description: 'Routed to a group the viewer belongs to, so it shows under My teams.',
      priority: 'normal',
      category: 'other',
      requesterId: agent.id,
    });
    await updateTicket(ticket.id, agent.id, { groupId: group.id });

    const page = await listTickets(agent, {
      scope: 'myGroups',
      status: 'any',
      viewerGroupIds: await groupIdsForUser(agent.id),
      page: 1,
      perPage: 50,
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.id, ticket.id);
  });

  test('a routing change is recorded in the history', async () => {
    const group = await createGroup({ ...BASE, name: 'Historied' }, null);
    const agent = await findUserById((await signInAs('groups.history@example.com', 'agent')).user.id);
    assert.ok(agent);
    const ticket = await createTicket({
      title: 'A ticket whose routing changes',
      description: 'The change must appear in the per-ticket history like any other field.',
      priority: 'normal',
      category: 'other',
      requesterId: agent.id,
    });

    const changes = await updateTicket(ticket.id, agent.id, { groupId: group.id });
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.field, 'group');

    // Setting the same group again is a no-op.
    assert.equal((await updateTicket(ticket.id, agent.id, { groupId: group.id })).length, 0);

    // null clears it.
    const cleared = await updateTicket(ticket.id, agent.id, { groupId: null });
    assert.equal(cleared.length, 1);
    assert.equal((await getTicketById(ticket.id))?.group_id, null);
  });
});

describe('the administration pages', () => {
  test('are closed to anyone but an administrator', async () => {
    await userAgent.get('/admin/settings/groups').expect(403);
  });

  test('the create form is a dialog behind a button, not a form on the page', async () => {
    const page = await adminAgent.get('/admin/settings/groups').expect(200);

    assert.match(page.text, /href="#new-group"/, 'there should be a button that opens it');
    assert.match(page.text, /id="new-group"/);
    assert.match(page.text, /class="dialog"/, 'and it should start closed');
    assert.doesNotMatch(page.text, /dialog--open/, 'nothing was refused, so nothing is open');
    assert.doesNotMatch(page.text, /Sort order/, 'the order field is gone');
    // A long column menu may bring the list search (select-search.js); nothing else.
    assert.doesNotMatch(page.text, /<script(?![^>]*(?:select-search|sidebar)\.js)/i, 'the dialog must not need JavaScript');
  });

  test('a refused submission reopens the dialog rather than losing it', async () => {
    await createGroup({ ...BASE, name: 'Reopen Me' }, null);
    const page = await adminAgent.get('/admin/settings/groups').expect(200);
    const refused = await adminAgent
      .post('/admin/settings/groups')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), name: 'reopen me' })
      .expect(400);

    assert.match(refused.text, /dialog--open/);
    assert.match(refused.text, /already exists/);
  });

  test('a group can be created and edited through the UI', async () => {
    const page = await adminAgent.get('/admin/settings/groups').expect(200);
    const created = await adminAgent
      .post('/admin/settings/groups')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        name: 'Made In The UI',
        description: 'Created through the form.',
      })
      .expect(302);

    const id = (created.headers.location as string).split('/').pop()!;
    const detail = await adminAgent.get('/admin/settings/groups/' + id).expect(200);
    assert.match(detail.text, /Made In The UI/);
    assert.match(detail.text, /name="members"/);
  });

  test('a group without a name is refused rather than erroring', async () => {
    const page = await adminAgent.get('/admin/settings/groups').expect(200);
    await adminAgent
      .post('/admin/settings/groups')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), name: '' })
      .expect(400);
  });

  test('a duplicate name comes back on the form, not as a 409 page', async () => {
    await createGroup({ ...BASE, name: 'Already Here' }, null);

    const page = await adminAgent.get('/admin/settings/groups').expect(200);
    const refused = await adminAgent
      .post('/admin/settings/groups')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        name: 'already here',
        description: 'Typed out in full.',
      })
      // A form refusal, not a conflict page: the 409 the service throws must
      // not reach the browser as a page of its own.
      .expect(400);

    assert.match(refused.text, /field-error/, 'the reason belongs on the field');
    assert.match(refused.text, /already exists/);
    assert.match(refused.text, /name="name"/, 'and the form must still be there');
    assert.match(
      refused.text,
      /value="already here"/,
      'with what was typed still in it, so nothing has to be retyped',
    );
    assert.doesNotMatch(refused.text, /Conflict/, 'the standalone error page must not render');
  });

  test('a rename onto an existing name is refused the same way', async () => {
    const [a] = await Promise.all([createGroup({ ...BASE, name: 'Rename Source' }, null)]);
    await createGroup({ ...BASE, name: 'Rename Target' }, null);

    const page = await adminAgent.get('/admin/settings/groups/' + a.id).expect(200);
    const refused = await adminAgent
      .post('/admin/settings/groups/' + a.id)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), name: 'Rename Target', isActive: '1' })
      .expect(400);

    assert.match(refused.text, /already exists/);
    assert.match(refused.text, /name="members"/, 'the detail page comes back whole');
  });

  test('only staff are offered as members', async () => {
    const group = await createGroup({ ...BASE, name: 'Candidates' }, null);
    const page = await adminAgent.get('/admin/settings/groups/' + group.id).expect(200);

    // The plain user signed in at the top of this file must not be offered.
    const plain = await findUserById((await signInAs('groups.user@example.com', 'user')).user.id);
    assert.ok(plain);
    assert.doesNotMatch(
      page.text,
      new RegExp('name="members" value="' + plain.id + '"'),
      'a plain user has no queue, so must not be offered',
    );
  });

  test('promoting then demoting through the UI drops the membership', async () => {
    const group = await createGroup({ ...BASE, name: 'Round Trip' }, null);
    const person = await findUserById((await signInAs('groups.round@example.com', 'agent')).user.id);
    assert.ok(person);
    await setMembers(group.id, [person.id], null);
    assert.equal((await listMembers(group.id)).length, 1);

    await adminAgent
      .post('/admin/settings/users/' + person.id + '/role')
      .type('form')
      .send({ _csrf: admin.csrfToken, role: 'user' })
      .expect(302);

    assert.equal(
      (await listMembers(group.id)).length,
      0,
      'a demotion must take the membership with it',
    );
    assert.equal((await findUserById(person.id))?.role, 'user');
    await setUserRole(person.id, 'agent', true);
  });
});
