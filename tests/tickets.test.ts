import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import { upsertUserFromDirectory, type UserRow } from '../src/services/users.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import {
  addComment,
  canViewTicket,
  createTicket,
  getTicketById,
  listComments,
  listEvents,
  listTickets,
  ticketCounts,
  updateTicket,
} from '../src/services/tickets.js';

const ISSUER = 'https://login.microsoftonline.com/test-tenant/v2.0';

async function makeUser(email: string, role: 'user' | 'agent' | 'admin'): Promise<UserRow> {
  return (
    await upsertUserFromDirectory({
    issuer: ISSUER,
    externalId: 'oid-' + email,
    email,
    upn: email,
    displayName: email.split('@')[0] ?? email,
    role,
      source: 'manual',
    })
  ).user;
}

let alice: UserRow;
let bob: UserRow;
let agent: UserRow;

before(async () => {
  await bootstrapTestDatabase();
  alice = await makeUser('alice.tickets@example.com', 'user');
  bob = await makeUser('bob.tickets@example.com', 'user');
  agent = await makeUser('agent.tickets@example.com', 'agent');
});

describe('ticket creation', () => {
  test('assigns sequential references and an opaque id', async () => {
    const first = await createTicket({
      title: 'Printer jams on duplex',
      description: 'The third floor printer jams whenever duplex printing is selected.',
      priority: 'normal',
      category: 'hardware',
      requesterId: alice.id,
    });
    const second = await createTicket({
      title: 'VPN drops every ten minutes',
      description: 'The connection drops roughly every ten minutes and has to be restarted.',
      priority: 'high',
      category: 'network',
      requesterId: alice.id,
    });

    // The prefix comes from the ticket's type; an incident is INC by default.
    assert.match(first.reference, /^INC-\d{6}$/);
    assert.equal(Number(second.seq), Number(first.seq) + 1);
    // The public id must not be the guessable counter.
    assert.notEqual(first.id, String(first.seq));
    assert.match(first.id, /^[0-9a-f-]{36}$/);
    assert.equal(first.status, 'open');
    assert.equal(first.assignee_id, null);
  });

  test('records a creation event', async () => {
    const ticket = await createTicket({
      title: 'Mailbox is full',
      description: 'Outlook reports the mailbox is full and will not send messages.',
      priority: 'low',
      category: 'software',
      requesterId: bob.id,
    });
    const events = await listEvents(ticket.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'created');
  });
});

describe('row-level access', () => {
  test('a requester sees only their own tickets', async () => {
    const aliceView = await listTickets(alice, { page: 1, perPage: 50, status: 'any' });
    assert.ok(aliceView.items.length > 0);
    assert.ok(
      aliceView.items.every((t) => t.requester_id === alice.id),
      'a requester must never see another person tickets',
    );

    const bobView = await listTickets(bob, { page: 1, perPage: 50, status: 'any' });
    assert.ok(bobView.items.every((t) => t.requester_id === bob.id));
  });

  test('a requester cannot widen the result set with a scope filter', async () => {
    // 'all' is the staff scope; for a requester it must still be scoped down.
    const forced = await listTickets(bob, { scope: 'all', page: 1, perPage: 50, status: 'any' });
    assert.ok(forced.items.every((t) => t.requester_id === bob.id));
  });

  test('staff see every ticket', async () => {
    const staffView = await listTickets(agent, { page: 1, perPage: 50, status: 'any' });
    const requesters = new Set(staffView.items.map((t) => t.requester_id));
    assert.ok(requesters.size > 1, 'staff should see tickets from more than one requester');
  });

  test('canViewTicket refuses another requester ticket', async () => {
    const ticket = await createTicket({
      title: 'Second monitor not detected',
      description: 'The docking station no longer drives the second monitor after a reboot.',
      priority: 'normal',
      category: 'hardware',
      requesterId: alice.id,
    });
    assert.equal(canViewTicket(alice, ticket), true);
    assert.equal(canViewTicket(bob, ticket), false);
    assert.equal(canViewTicket(agent, ticket), true);
  });

  test('counts are scoped to the viewer', async () => {
    const aliceCounts = await ticketCounts(alice);
    const staffCounts = await ticketCounts(agent);
    assert.ok(staffCounts.total !== undefined && aliceCounts.total !== undefined);
    assert.ok(
      (staffCounts.total ?? 0) > (aliceCounts.total ?? 0),
      'staff totals cover every ticket',
    );
    assert.equal(aliceCounts.unassigned, undefined, 'requesters get no queue metrics');
  });
});

describe('internal notes', () => {
  test('are hidden from the requester and visible to staff', async () => {
    const ticket = await createTicket({
      title: 'Access request for the finance share',
      description: 'I need read access to the finance share for the quarterly close.',
      priority: 'normal',
      category: 'access',
      requesterId: alice.id,
    });

    await addComment({ ticketId: ticket.id, authorId: alice.id, body: 'Any update?', isInternal: false });
    await addComment({
      ticketId: ticket.id,
      authorId: agent.id,
      body: 'Manager approval still outstanding.',
      isInternal: true,
    });

    const asRequester = await listComments(ticket.id, alice);
    assert.equal(asRequester.length, 1);
    assert.ok(
      asRequester.every((c) => c.is_internal === false),
      'internal notes must be filtered out in SQL',
    );

    const asStaff = await listComments(ticket.id, agent);
    assert.equal(asStaff.length, 2);
  });
});

describe('updates', () => {
  test('records one event per changed field and ignores no-ops', async () => {
    const ticket = await createTicket({
      title: 'Password reset for a shared account',
      description: 'The shared reception account password needs resetting after a staff change.',
      priority: 'normal',
      category: 'access',
      requesterId: bob.id,
    });

    const changes = await updateTicket(ticket.id, agent.id, {
      status: 'in_progress',
      priority: 'high',
      assigneeId: agent.id,
    });
    assert.equal(changes.length, 3);
    assert.deepEqual(
      changes.map((c) => c.field).sort(),
      ['assignee', 'priority', 'status'],
    );

    // Applying the same values again must be a no-op.
    const again = await updateTicket(ticket.id, agent.id, { status: 'in_progress', priority: 'high' });
    assert.equal(again.length, 0);

    const events = (await listEvents(ticket.id)).filter((e) => e.kind === 'field_changed');
    assert.equal(events.length, 3, 'no duplicate history entries for the no-op update');
  });

  test('derives the resolution timestamps rather than trusting input', async () => {
    const ticket = await createTicket({
      title: 'Laptop runs very hot',
      description: 'The fan runs constantly and the chassis becomes uncomfortably warm.',
      priority: 'normal',
      category: 'hardware',
      requesterId: bob.id,
    });

    await updateTicket(ticket.id, agent.id, { status: 'resolved' });
    const resolved = await getTicketById(ticket.id);
    assert.ok(resolved?.resolved_at, 'resolved_at is stamped on resolution');
    assert.equal(resolved?.closed_at, null);

    await updateTicket(ticket.id, agent.id, { status: 'closed' });
    const closed = await getTicketById(ticket.id);
    assert.ok(closed?.closed_at, 'closed_at is stamped on closure');
    assert.equal(closed?.resolved_at, resolved?.resolved_at, 'the original resolution time stands');

    // Reopening clears both stamps.
    await updateTicket(ticket.id, agent.id, { status: 'open' });
    const reopened = await getTicketById(ticket.id);
    assert.equal(reopened?.resolved_at, null);
    assert.equal(reopened?.closed_at, null);
  });

  test('unassigning is distinguishable from leaving the assignee alone', async () => {
    const ticket = await createTicket({
      title: 'Software licence request',
      description: 'A licence is needed for the statistics package used by the research team.',
      priority: 'low',
      category: 'software',
      requesterId: alice.id,
    });

    await updateTicket(ticket.id, agent.id, { assigneeId: agent.id });
    assert.equal((await getTicketById(ticket.id))?.assignee_id, agent.id);

    // undefined leaves it alone.
    await updateTicket(ticket.id, agent.id, { priority: 'normal' });
    assert.equal((await getTicketById(ticket.id))?.assignee_id, agent.id);

    // null clears it.
    const cleared = await updateTicket(ticket.id, agent.id, { assigneeId: null });
    assert.equal(cleared.length, 1);
    assert.equal((await getTicketById(ticket.id))?.assignee_id, null);
  });
});

describe('search', () => {
  test('treats LIKE wildcards in user input as literal characters', async () => {
    await createTicket({
      title: 'Exact literal 100% match test',
      description: 'A ticket containing a literal percent sign for the search escaping test.',
      priority: 'low',
      category: 'other',
      requesterId: alice.id,
    });

    const everything = await listTickets(agent, { page: 1, perPage: 100, status: 'any' });
    assert.ok(everything.total > 1, 'the fixture should hold several tickets');

    // Unescaped, '%' would match every row. Escaped, it matches only the one
    // ticket that actually contains a percent sign.
    const wildcard = await listTickets(agent, { search: '%', page: 1, perPage: 100, status: 'any' });
    assert.equal(wildcard.total, 1, 'a literal % must not act as a wildcard');

    const literal = await listTickets(agent, { search: '100%', page: 1, perPage: 50, status: 'any' });
    assert.equal(literal.total, 1);

    const underscore = await listTickets(agent, { search: '_', page: 1, perPage: 50, status: 'any' });
    assert.equal(underscore.total, 0, 'a literal _ must not match a single character');
  });
});

describe('the title on the raise-a-ticket form', () => {
  test('is marked mandatory with an asterisk, never as optional', async () => {
    const { createApp } = await import('../src/app.js');
    const { signInAs } = await import('./support/session.js');
    const { ensureDefaultTemplate } = await import('../src/services/templates.js');
    const supertest = (await import('supertest')).default;
    await ensureDefaultTemplate();
    const someone = await signInAs('title.star@example.com', 'user');
    const agent = supertest.agent(createApp());
    agent.set('Cookie', someone.cookie);
    const page = await agent.get('/tickets/new').expect(200);
    assert.match(page.text, /<label for="title">Title <span class="required">\*<\/span><\/label>/);
    assert.doesNotMatch(page.text, /<label for="title">Title <span class="hint-inline">\(optional\)/);
  });
});
