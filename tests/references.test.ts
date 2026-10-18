import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { createTicket, getTicketById, prefixFor } from '../src/services/tickets.js';
import { updateSettings } from '../src/settings/index.js';
import { upsertUserFromDirectory } from '../src/services/users.js';
import { matchTicket } from '../src/services/mail/inbound.js';

/**
 * Reference prefixes.
 *
 * The number identifies a ticket; the prefix only says what kind it is. Three
 * things follow, and each of them is a way this could go quietly wrong.
 */

let requesterId: string;

const base = {
  description: 'Something is not working as it should.',
  priority: 'normal' as const,
  category: 'other' as const,
};

before(async () => {
  await bootstrapTestDatabase();
  const { user } = await upsertUserFromDirectory({
    issuer: 'https://login.microsoftonline.com/test-tenant/v2.0',
    externalId: 'oid-ref',
    email: 'ref@example.com',
    upn: 'ref@example.com',
    displayName: 'Ref Person',
    role: 'user',
    source: 'jit',
    markLogin: true,
  });
  requesterId = user.id;
});

describe('reference prefixes', () => {
  test('each type gets its own', async () => {
    const incident = await createTicket({ ...base, title: 'An incident', requesterId });
    const request = await createTicket({
      ...base,
      title: 'A request',
      type: 'service_request',
      requesterId,
    });
    const change = await createTicket({
      ...base,
      title: 'A change',
      type: 'change_request',
      requesterId,
    });

    assert.match(incident.reference, /^INC-\d{6}$/);
    assert.match(request.reference, /^SR-\d{6}$/);
    assert.match(change.reference, /^CR-\d{6}$/);
  });

  test('a task under a change request is a change task; under anything else it is a task', async () => {
    const change = await createTicket({
      ...base,
      title: 'A change to make',
      type: 'change_request',
      requesterId,
    });
    const incident = await createTicket({ ...base, title: 'A fault', requesterId });

    const changeTask = await createTicket({
      ...base,
      title: 'Step one',
      type: 'task',
      parentId: change.id,
      requesterId,
    });
    const plainTask = await createTicket({
      ...base,
      title: 'Chase the supplier',
      type: 'task',
      parentId: incident.id,
      requesterId,
    });

    assert.match(changeTask.reference, /^CTSK-\d{6}$/);
    assert.match(plainTask.reference, /^TSK-\d{6}$/);
  });

  test('changing a prefix never rewrites a reference that exists', async () => {
    const before = await createTicket({ ...base, title: 'Raised first', requesterId });
    assert.match(before.reference, /^INC-/);

    await updateSettings({ tickets: { prefixes: { incident: 'FAULT' } } }, null);

    const after = await createTicket({ ...base, title: 'Raised second', requesterId });
    assert.match(after.reference, /^FAULT-/);

    // The one already sent to somebody keeps naming the same ticket.
    const reloaded = await getTicketById(before.id);
    assert.equal(reloaded?.reference, before.reference);

    await updateSettings({ tickets: { prefixes: { incident: 'INC' } } }, null);
  });

  test('a reply threads on any prefix, including one from before they changed', async () => {
    const ticket = await createTicket({ ...base, title: 'Threaded', requesterId });

    const reply = (subject: string) => ({
      messageId: '<' + subject + '@example.test>',
      from: 'ref@example.com',
      fromName: 'Ref Person',
      subject,
      body: 'Any news?',
      inReplyTo: '',
      references: [],
      receivedAt: new Date().toISOString(),
    });

    const own = await matchTicket(reply('Re: [' + ticket.reference + '] Threaded'));
    assert.equal(own.ticket?.id, ticket.id);
    assert.equal(own.via, 'subject');

    // The same number under the prefix this application used to ship with.
    const legacy = await matchTicket(
      reply('Re: [TKT-' + String(ticket.seq).padStart(6, '0') + '] Threaded'),
    );
    assert.equal(legacy.ticket?.id, ticket.id);

    // And a sentence mentioning one still matches nothing.
    const passing = await matchTicket(reply('About ' + ticket.reference + ' again'));
    assert.equal(passing.ticket, undefined);
  });

  test('each kind counts on its own, from one', async () => {
    // A fresh prefix nothing else uses, so the count starts where it should.
    await updateSettings({ tickets: { prefixes: { service_request: 'REQ' } } }, null);

    const first = await createTicket({
      ...base,
      title: 'First request',
      type: 'service_request',
      requesterId,
    });
    const second = await createTicket({
      ...base,
      title: 'Second request',
      type: 'service_request',
      requesterId,
    });

    assert.equal(first.reference, 'REQ-000001');
    assert.equal(second.reference, 'REQ-000002');

    // And an incident raised in between does not take a number from them.
    const incident = await createTicket({ ...base, title: 'A fault', requesterId });
    assert.notEqual(Number(incident.ref_seq), Number(second.ref_seq));

    await updateSettings({ tickets: { prefixes: { service_request: 'SR' } } }, null);
  });

  test('the same number under two prefixes is two different tickets', async () => {
    await updateSettings({ tickets: { prefixes: { change_request: 'CHG' } } }, null);
    const change = await createTicket({
      ...base,
      title: 'A change',
      type: 'change_request',
      requesterId,
    });
    assert.equal(change.reference, 'CHG-000001');

    const reply = {
      messageId: '<two-prefixes@example.test>',
      from: 'ref@example.com',
      fromName: 'Ref Person',
      subject: 'Re: [CHG-000001] A change',
      body: 'Any news?',
      inReplyTo: '',
      references: [],
      receivedAt: new Date().toISOString(),
    };

    const found = await matchTicket(reply);
    assert.equal(
      found.ticket?.id,
      change.id,
      'the prefix has to be part of the match, or REQ-000001 answers for CHG-000001',
    );

    await updateSettings({ tickets: { prefixes: { change_request: 'CR' } } }, null);
  });

  test('prefixFor is where the change-task rule lives', () => {
    assert.equal(prefixFor('incident'), 'INC');
    assert.equal(prefixFor('task'), 'TSK');
    assert.equal(
      prefixFor('task', { type: 'change_request' } as never),
      'CTSK',
      'a task under a change request',
    );
    assert.equal(prefixFor('task', { type: 'incident' } as never), 'TSK');
  });
});
