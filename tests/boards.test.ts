import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { queryOne } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createTicket } from '../src/services/tickets.js';
import { pinHrefProblem } from '../src/services/boards.js';

let app: Express;
let tech: TestSession;
let other: TestSession;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
const post = (s: TestSession, url: string, form: Record<string, string> = {}) => as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  tech = await signInAs('board.tech@example.com', 'agent');
  other = await signInAs('board.other@example.com', 'agent');
  const requester = await signInAs('board.requester@example.com', 'user');
  for (const priority of ['urgent', 'urgent', 'normal'] as const) {
    const t = await createTicket({ title: 'Board ' + priority, description: 'For a dashboard.', priority, category: 'other', requesterId: requester.user.id });
    await (await import('../src/db/index.js')).execute('UPDATE tickets SET assignee_id = ? WHERE id = ?', [tech.user.id, t.id]);
  }
});

describe('my dashboards', () => {
  let boardId: string;

  test('a new dashboard is created, pinned, and opens to add a widget', async () => {
    const res = await post(tech, '/boards', { name: 'On call' }).expect(302);
    assert.match(String(res.headers.location), /^\/boards\/[^?]+\?edit=1#add-widget$/);
    boardId = String(res.headers.location).split('/')[2]!.split('?')[0]!;
    const page = await as(tech).get('/tickets').expect(200);
    assert.match(page.text, new RegExp('href="/boards/' + boardId + '"'), 'in the sidebar');
  });

  test('widgets show what their owner may see', async () => {
    await post(tech, '/boards/' + boardId + '/widgets', { kind: 'figure', title: 'My urgent', scope: 'assigned', status: 'active', priority: 'urgent', type: 'any', width: 'half' }).expect(302);
    await post(tech, '/boards/' + boardId + '/widgets', { kind: 'list', scope: 'assigned', status: 'active', priority: 'any', type: 'any', limit: '5', width: 'full' }).expect(302);
    await post(tech, '/boards/' + boardId + '/widgets', { kind: 'activity', width: 'half' }).expect(302);
    const page = await as(tech).get('/boards/' + boardId).expect(200);
    assert.match(page.text, /<h2>My urgent<\/h2>/);
    assert.match(page.text, /<b>2<\/b><small>tickets<\/small>/);
    assert.match(page.text, /Board normal/);
  });

  test('widgets move, change and go', async () => {
    const before = (await queryOne<{ widgets: string }>('SELECT widgets FROM user_boards WHERE id = ?', [boardId]))!;
    const widgets = (typeof before.widgets === 'string' ? JSON.parse(before.widgets) : before.widgets) as { id: string; kind: string }[];
    await post(tech, '/boards/' + boardId + '/widgets/' + widgets[2]!.id + '/move', { direction: 'up' }).expect(302);
    await post(tech, '/boards/' + boardId + '/widgets/' + widgets[0]!.id, { kind: 'figure', title: 'Renamed', scope: 'assigned', status: 'active', priority: 'any', type: 'any', width: 'half' }).expect(302);
    await post(tech, '/boards/' + boardId + '/widgets/' + widgets[1]!.id + '/delete').expect(302);
    const after = (await queryOne<{ widgets: unknown }>('SELECT widgets FROM user_boards WHERE id = ?', [boardId]))!;
    const list = (typeof after.widgets === 'string' ? JSON.parse(after.widgets) : after.widgets) as { kind: string; title: string }[];
    assert.deepEqual(list.map((w) => w.kind), ['figure', 'activity']);
    assert.equal(list[0]!.title, 'Renamed');
  });

  test("somebody else's dashboard is not found, and requesters have none", async () => {
    await as(other).get('/boards/' + boardId).expect(404);
    await post(other, '/boards/' + boardId + '/delete').expect(404);
    const requester = await signInAs('board.requester2@example.com', 'user');
    await as(requester).get('/boards').expect(404);
  });

  test('removing a dashboard removes its pin', async () => {
    await post(tech, '/boards/' + boardId + '/delete').expect(302);
    assert.equal(await queryOne('SELECT id FROM user_pins WHERE href = ?', ['/boards/' + boardId]), undefined);
  });
});

describe('pins', () => {
  test('a filtered queue or a report can be pinned; anything else cannot', async () => {
    assert.equal(pinHrefProblem('/tickets?scope=assigned&priority=urgent'), null);
    assert.equal(pinHrefProblem('/reports?group=all&period=30&company=Contoso'), null);
    assert.ok(pinHrefProblem('https://evil.example/'));
    assert.ok(pinHrefProblem('//evil.example/tickets'));
    assert.ok(pinHrefProblem('/admin/settings'));

    const res = await post(tech, '/boards/pins', { href: '/tickets?scope=assigned&priority=urgent', label: 'Urgent mine', icon: 'alert' }).expect(302);
    assert.equal(res.headers.location, '/tickets?scope=assigned&priority=urgent');
    const page = await as(tech).get('/tickets?scope=assigned&priority=urgent').expect(200);
    assert.match(page.text, /Urgent mine/);
    assert.match(page.text, /Pinned<\/span>/, 'the button says it is pinned');

    const refused = await post(tech, '/boards/pins', { href: 'https://evil.example/', label: 'x', icon: 'star' }).expect(302);
    assert.equal(refused.headers.location, '/boards', 'never redirected off-site');
  });
});

describe('sharing a dashboard', () => {
  test('a link imports a copy that reads with the importer\'s permissions; it can be stopped', async () => {
    const made = await post(tech, '/boards', { name: 'Shared desk' }).expect(302);
    const id = String(made.headers.location).split('/')[2]!.split('?')[0]!;
    await post(tech, '/boards/' + id + '/widgets', { kind: 'figure', title: 'My urgent', scope: 'assigned', status: 'active', priority: 'urgent', type: 'any', width: 'half' }).expect(302);

    const shared = await post(tech, '/boards/' + id + '/share').expect(200);
    const link = /value="(https?:\/\/[^"]+\/boards\/import\/[A-Za-z0-9_-]+)"/.exec(shared.text)?.[1];
    assert.ok(link, 'the link is shown once');
    const token = link.split('/').pop()!;
    // Only a fingerprint is stored.
    const row = await queryOne<{ token_hash: string }>('SELECT token_hash FROM board_shares WHERE board_id = ?', [id]);
    assert.notEqual(row!.token_hash, token);
    assert.doesNotMatch((await as(tech).get('/boards/' + id).expect(200)).text, new RegExp(token), 'never shown again');

    // Pasting the link leads to the preview; adding makes the colleague's own copy.
    const pasted = await post(other, '/boards/import', { link: 'Here: ' + link }).expect(302);
    assert.equal(pasted.headers.location, '/boards/import/' + token);
    const preview = await as(other).get('/boards/import/' + token).expect(200);
    assert.match(preview.text, /Shared desk/);
    assert.match(preview.text, /My urgent/);
    const added = await post(other, '/boards/import/' + token).expect(302);
    const copyId = String(added.headers.location).split('/')[2]!;
    assert.notEqual(copyId, id);
    const copy = await as(other).get('/boards/' + copyId).expect(200);
    assert.match(copy.text, /<b>0<\/b><small>tickets<\/small>/, 'the colleague sees their own urgent tickets: none');

    // Requesters cannot use a link; a stopped link is the same "expired" answer as a wrong one.
    const requester = await signInAs('board.requester3@example.com', 'user');
    await as(requester).get('/boards/import/' + token).expect(404);
    await post(tech, '/boards/' + id + '/share/stop').expect(302);
    const stopped = await as(other).get('/boards/import/' + token).expect(404);
    assert.match(stopped.text, /expired or was stopped/);
    await as(other).get('/boards/import/' + 'x'.repeat(43)).expect(404);
    await post(other, '/boards/import/' + token).expect(302);
  });

  test('sharing again stops the old link', async () => {
    const made = await post(tech, '/boards', { name: 'Twice' }).expect(302);
    const id = String(made.headers.location).split('/')[2]!.split('?')[0]!;
    const first = /\/boards\/import\/([A-Za-z0-9_-]+)"/.exec((await post(tech, '/boards/' + id + '/share').expect(200)).text)![1]!;
    await post(tech, '/boards/' + id + '/share').expect(200);
    await as(other).get('/boards/import/' + first).expect(404);
  });
});

describe('a dashboard as a widget', () => {
  test('the kind exists, stores which dashboard, and draws it', async () => {
    const { WIDGET_KINDS, widgetFromForm, viewWidget } = await import('../src/services/boards.js');
    assert.ok(WIDGET_KINDS.some((k) => k.key === 'dashboard'), 'offered in Add a widget');

    const widget = widgetFromForm({ kind: 'dashboard', dashboardId: 'technician-availability' });
    assert.equal(widget.kind, 'dashboard');
    assert.equal(widget.dashboardId, 'technician-availability');

    // Switched off, which every dashboard starts as: said, not silent.
    const off = await viewWidget(tech.user, widget);
    assert.equal(off.kind, 'empty');
    assert.match(off.message, /switched off/);

    // A widget pointing at a dashboard that is gone says so too.
    const missing = await viewWidget(tech.user, widgetFromForm({ kind: 'dashboard', dashboardId: 'no-such-thing' }));
    assert.equal(missing.kind, 'empty');
    assert.match(missing.message, /no longer exists/);
  });
});
