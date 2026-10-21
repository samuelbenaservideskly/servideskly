import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createTicket } from '../src/services/tickets.js';
import { columnClause, readColumnFilters } from '../src/lib/column-filters.js';

/** Excel-like column filters (lib/column-filters.ts, 21 Oct 2026). */

let app: Express;
let agent: TestSession;
let requester: TestSession;

const get = (path: string, who: TestSession) => request(app).get(path).set('Cookie', who.cookie);

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  agent = await signInAs('cf.agent@example.com', 'agent');
  requester = await signInAs('cf.requester@example.com', 'user');
  const make = (title: string, priority: 'low' | 'high' | 'urgent') =>
    createTicket({ title, description: 'Column filter test', priority, category: 'other', requesterId: requester.user.id });
  await make('CF alpha', 'low');
  await make('CF beta', 'high');
  const gamma = await make('CF gamma', 'urgent');
  await execute('UPDATE tickets SET assignee_id = ? WHERE id = ?', [agent.user.id, gamma.id]);
});

describe('the engine', () => {
  test('reads only the columns a table allows, and a blank means an empty cell', () => {
    const read = readColumnFilters({ cf_status: ['open', 'open', 'closed'], cf_evil: 'x', cf_assignee: '' }, ['status', 'assignee']);
    assert.deepEqual(read, { status: ['open', 'closed'], assignee: [''] });
    assert.deepEqual(columnClause('t.assignee_id', ['', 'u1']), { sql: "(t.assignee_id IN (?) OR (t.assignee_id IS NULL OR t.assignee_id = ''))", params: ['u1'] });
  });
});

describe('the ticket queue', () => {
  test('every header has a menu; values are counted; filters narrow together and stay in the links', async () => {
    const page = await get('/tickets?scope=all&status=any', agent).expect(200);
    assert.match(page.text, /class="colfilter"/);
    assert.match(page.text, /name="cf_priority" value="urgent"/);

    const two = await get('/tickets?scope=all&status=any&cf_priority=low&cf_priority=urgent', agent).expect(200);
    assert.match(two.text, /CF alpha/);
    assert.match(two.text, /CF gamma/);
    assert.doesNotMatch(two.text, /CF beta/);
    assert.match(two.text, /th-filter--on/);

    // A second column narrows the same table rather than replacing the first.
    const both = await get('/tickets?scope=all&status=any&cf_priority=low&cf_priority=urgent&cf_assignee=' + agent.user.id, agent).expect(200);
    assert.match(both.text, /CF gamma/);
    assert.doesNotMatch(both.text, /CF alpha/);
    // Sorting keeps both filters, and Clear filter drops only its own column.
    const sortTitle = (both.text.match(/href="\/tickets\?[^"]*sort=title[^"]*"/g) ?? [])[0] ?? '';
    assert.ok(sortTitle.includes('cf_priority=low') && sortTitle.includes('cf_assignee='), 'sorting keeps both filters');
    const clear = both.text.match(/href="(\/tickets\?[^"]*)">Clear filter<\/a>/g) ?? [];
    assert.ok(clear.some((a) => a.includes('cf_priority=low') && !a.includes('cf_assignee=')), 'the assignee menu clears only the assignee');

    // Unassigned can be ticked.
    const unassigned = await get('/tickets?scope=all&status=any&cf_assignee=', agent).expect(200);
    assert.match(unassigned.text, /CF alpha/);
    assert.doesNotMatch(unassigned.text, /CF gamma/);
  });

  test('a requester gets no people columns, and a filter cannot show them anybody else\'s tickets', async () => {
    const page = await get('/tickets?cf_assignee=' + agent.user.id, requester).expect(200);
    assert.doesNotMatch(page.text, /name="cf_assignee"/);
    const other = await signInAs('cf.other@example.com', 'user');
    const theirs = await get('/tickets?status=any&cf_priority=urgent', other).expect(200);
    assert.doesNotMatch(theirs.text, /CF gamma/);
  });
});
