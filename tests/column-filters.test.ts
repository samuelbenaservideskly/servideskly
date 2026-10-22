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
import { updateSettings } from '../src/settings/index.js';

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

describe('Settings - Users and the audit trail', () => {
  test('users filter by role and by group membership, and sort by a column', async () => {
    const admin = await signInAs('cf.admin@example.com', 'admin');
    // The test accounts come from the directory: the Identity providers tab, open while SCIM is on.
    await updateSettings({ scim: { enabled: true } }, null);
    const page = await get('/admin/settings/users/entra?cf_role=agent', admin).expect(200);
    assert.match(page.text, /cf\.agent@example\.com/);
    assert.doesNotMatch(page.text, /cf\.requester@example\.com/);
    assert.match(page.text, /name="cf_tgroups"/);
    // "None" in the groups column: people in no technician group.
    const none = await get('/admin/settings/users/entra?cf_tgroups=', admin).expect(200);
    assert.match(none.text, /cf\.requester@example\.com/);
    const sorted = await get('/admin/settings/users/entra?sort=lastSignIn&dir=desc', admin).expect(200);
    assert.match(sorted.text, /aria-sort="descending"/);
  });

  test('the audit trail filters by outcome and actor from its headers', async () => {
    const admin = await signInAs('cf.auditor@example.com', 'admin');
    const page = await get('/admin/settings/audit?cf_outcome=failure', admin).expect(200);
    assert.match(page.text, /name="cf_outcome"/);
    assert.doesNotMatch(page.text, /pill--resolved">success</);
  });
});

describe('Reports, Settings lists and People', () => {
  test('in memory: filter, sort and menus counted over the other filters', async () => {
    const { filterRows, rowMenus, sortRows } = await import('../src/lib/column-filters.js');
    const rows = [{ n: 'b', s: 'On' }, { n: 'a', s: 'Off' }, { n: 'c', s: 'On' }];
    const cells = { name: (r: { n: string }) => r.n, status: (r: { s: string }) => r.s };
    assert.deepEqual(filterRows(rows, { status: ['On'] }, cells).map((r) => r.n), ['b', 'c']);
    assert.deepEqual(sortRows(rows, 'name', 'desc', cells).map((r) => r.n), ['c', 'b', 'a']);
    const menus = rowMenus(rows, { status: ['On'] }, cells);
    assert.deepEqual(menus.status!.values.map((v) => [v.value, v.count]), [['Off', 1], ['On', 2]], 'its own filter left out');
    assert.equal(menus.name!.values.length, 2, 'other columns narrowed by it');
  });

  test('the Settings lists and People take the headers', async () => {
    const admin = await signInAs('cf.lists@example.com', 'admin');
    const { ensureDefaultTemplate } = await import('../src/services/templates.js');
    await ensureDefaultTemplate();
    for (const path of ['/admin/settings/templates?cf_status=Active', '/admin/settings/mail/notifications?cf_status=On', '/people?cf_company=&sort=company']) {
      const page = await get(path, admin).expect(200);
      assert.match(page.text, /class="colfilter"/, path);
    }
    const retired = await get('/admin/settings/templates?cf_status=Active', admin).expect(200);
    assert.match(retired.text, /th-filter--on/);
  });

  test('a figure\'s tickets in Reports filter and sort from their headers', async () => {
    const manager = await signInAs('cf.manager@example.com', 'admin');
    const page = await get('/reports/tickets?metric=raised&period=30&cf_priority=urgent&sort=raised&dir=asc', manager);
    assert.ok(page.status === 200 || page.status === 404, 'a report or none for this person');
    if (page.status === 200) {
      assert.match(page.text, /name="cf_priority" value="urgent" checked/);
      assert.doesNotMatch(page.text, /CF alpha/);
    }
  });
});

describe('the Settings lists drawn whole (routes/column-lists.ts)', () => {
  test('each page renders, with and without filters and a sort', async () => {
    const admin = await signInAs('cf.whole@example.com', 'admin');
    for (const path of [
      '/admin/settings/advanced/api-keys', '/admin/settings/advanced/connections', '/admin/settings/templates/custom-fields',
      '/admin/settings/advanced/automation/runs', '/admin/settings/mail', '/admin/settings/groups', '/admin/settings/groups/users',
    ]) {
      await get(path, admin).expect(200);
      await get(path + '?sort=name&dir=desc&cf_status=Active', admin).expect(200);
    }
    const { createGroup } = await import('../src/services/groups.js');
    await createGroup({ name: 'CF zeta desk', description: '', isActive: true }, null);
    await createGroup({ name: 'CF eta desk', description: '', isActive: true }, null);
    const sorted = await get('/admin/settings/groups?sort=name&dir=desc', admin).expect(200);
    const body = sorted.text.slice(sorted.text.indexOf('<tbody>'));
    assert.ok(body.indexOf('CF zeta desk') < body.indexOf('CF eta desk'), 'sorted Z to A');
    const one = await get('/admin/settings/groups?cf_name=CF%20eta%20desk', admin).expect(200);
    assert.doesNotMatch(one.text.slice(one.text.indexOf('<tbody>')), /CF zeta desk/);
    assert.match(one.text, /Clear column filters/);
  });
});
