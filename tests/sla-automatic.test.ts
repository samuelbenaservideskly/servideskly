import './env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, describe } from 'node:test';
import { execute, queryOne } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { addComment, createTicket, updateTicket } from '../src/services/tickets.js';
import { asAutomatic } from '../src/services/events.js';
import { firstResponseAt } from '../src/services/sla.js';
import { createAutomation, markPastAutomationWrites } from '../src/services/automation.js';

/**
 * Nothing automatic is a first response: an automation's acknowledgement or
 * status change does not stop the response clock; a person's does. Closing
 * still resolves.
 */

let admin: TestSession;
let tech: TestSession;
let requester: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  admin = await signInAs('auto.admin@example.com', 'admin');
  tech = await signInAs('auto.tech@example.com', 'agent');
  requester = await signInAs('auto.requester@example.com', 'user');
});

const raise = (title: string) =>
  createTicket({ title, description: 'Waiting for a person.', priority: 'normal', category: 'other', requesterId: requester.user.id });

describe('automatic writes are not a first response', () => {
  test("an automation's public comment and status change do not count; a person's reply does", async () => {
    const t = await raise('Acknowledged by a robot');
    await asAutomatic(async () => {
      await addComment({ ticketId: t.id, authorId: admin.user.id, body: 'We have your ticket.', isInternal: false });
      await updateTicket(t.id, admin.user.id, { status: 'in_progress' });
    });
    assert.equal(await firstResponseAt({ id: t.id, requester_id: requester.user.id }), null, 'nobody has answered yet');
    const marked = await queryOne<{ n: number }>('SELECT count(*) AS n FROM ticket_comments WHERE ticket_id = ? AND automatic = 1', [t.id]);
    assert.equal(Number(marked?.n), 1);

    await addComment({ ticketId: t.id, authorId: tech.user.id, body: 'Looking now.', isInternal: false });
    assert.ok(await firstResponseAt({ id: t.id, requester_id: requester.user.id }), 'a person answered');
  });

  test('an automatic close still resolves the ticket', async () => {
    const t = await raise('Closed by a robot');
    await asAutomatic(() => updateTicket(t.id, admin.user.id, { status: 'resolved' }));
    const row = await queryOne<{ resolved_at: string | null }>('SELECT resolved_at FROM tickets WHERE id = ?', [t.id]);
    assert.ok(row?.resolved_at);
  });

  test('what automations wrote before writes were marked is found once, by its run', async () => {
    const t = await raise('Old automatic reply');
    const automation = await createAutomation('Acknowledge', 'ticket.created', admin.user.id);
    // As written before migration 56: unmarked, by the automation's account,
    // a moment before its run was recorded.
    const at = new Date(Date.now() - 30_000).toISOString();
    await execute('INSERT INTO ticket_comments (id, ticket_id, author_id, body, is_internal, created_at) VALUES (?, ?, ?, ?, 0, ?)', [randomUUID(), t.id, admin.user.id, 'Thanks, received.', at]);
    await execute("INSERT INTO automation_runs (id, automation_id, ticket_id, ran_at, outcome, steps) VALUES (?, ?, ?, ?, 'success', '[]')", [randomUUID(), automation.id, t.id, new Date().toISOString()]);
    assert.ok(await firstResponseAt({ id: t.id, requester_id: requester.user.id }), 'counted before the marking');

    assert.ok((await markPastAutomationWrites()) >= 1);
    assert.equal(await firstResponseAt({ id: t.id, requester_id: requester.user.id }), null, 'no longer counted');
    assert.equal(await markPastAutomationWrites(), 0, 'once ever');
  });
});
