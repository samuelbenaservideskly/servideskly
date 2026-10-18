import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { execute, queryOne } from '../src/db/index.js';
import { createTicket } from '../src/services/tickets.js';
import { randomToken } from '../src/lib/util.js';
import { findPortal, setDefaultPortal, STANDARD_PORTAL } from '../src/services/portal.js';

const BASE = '/admin/settings/mail/approval';

let app: Express;
let admin: TestSession;
let requester: TestSession;
let approver: TestSession;
let stranger: TestSession;

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

function post(session: TestSession, url: string, form: Record<string, string> = {}) {
  return as(session).post(url).type('form').send({ _csrf: session.csrfToken, ...form });
}

/** A ticket waiting for the approver, and the token in its link. */
async function pendingApproval(): Promise<{ id: string; token: string }> {
  const ticket = await createTicket({
    title: 'New laptop',
    description: 'Three laptops for the new starters in finance.',
    priority: 'normal',
    category: 'other',
    requesterId: requester.user.id,
  });
  const token = randomToken(32);
  await execute(
    "UPDATE tickets SET approval_email = ?, approval_status = 'pending', approval_token = ? WHERE id = ?",
    [approver.user.email, token, ticket.id],
  );
  return { id: ticket.id, token };
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('approval.admin@example.com', 'admin');
  requester = await signInAs('approval.requester@example.com', 'user');
  approver = await signInAs('line.manager@example.com', 'user');
  stranger = await signInAs('someone.else@example.com', 'user');
});

describe('approving requires signing in as the approver', () => {
  test('without a session, the link goes to sign-in and comes back', async () => {
    const { token } = await pendingApproval();
    const response = await request(app).get('/approvals/' + token).expect(302);
    assert.match(String(response.headers.location), /^\/login\?returnTo=%2Fapprovals%2F/);
  });

  test('a decision posted without a session is refused', async () => {
    const { id, token } = await pendingApproval();
    await request(app).post('/approvals/' + token).type('form').send({ decision: 'approved' }).expect(403);
    const row = await queryOne<{ approval_status: string }>('SELECT approval_status FROM tickets WHERE id = ?', [id]);
    assert.equal(row?.approval_status, 'pending');
  });

  test('somebody else holding the link is told who it is for, and cannot answer', async () => {
    const { id, token } = await pendingApproval();
    const page = await as(stranger).get('/approvals/' + token).expect(403);
    assert.match(page.text, /waiting for <strong>line\.manager@example\.com<\/strong>/);
    assert.doesNotMatch(page.text, /name="decision"/);

    await post(stranger, '/approvals/' + token, { decision: 'approved' }).expect(403);
    const row = await queryOne<{ approval_status: string }>('SELECT approval_status FROM tickets WHERE id = ?', [id]);
    assert.equal(row?.approval_status, 'pending', 'a forwarded link must not approve');
  });

  test('the approver, signed in, can answer - and the audit names them', async () => {
    const { id, token } = await pendingApproval();
    const page = await as(approver).get('/approvals/' + token).expect(200);
    assert.match(page.text, /name="decision" value="approved"/);
    assert.match(page.text, /Answering as line\.manager@example\.com/);

    await post(approver, '/approvals/' + token, { decision: 'approved' }).expect(302);
    const row = await queryOne<{ approval_status: string }>('SELECT approval_status FROM tickets WHERE id = ?', [id]);
    assert.equal(row?.approval_status, 'approved');

    const entry = await queryOne<{ actor_id: string | null }>(
      "SELECT actor_id FROM audit_log WHERE action = 'ticket.approval.approved' AND target_id = ?",
      [id],
    );
    assert.equal(entry?.actor_id, approver.user.id);
  });

  test('the address is compared without regard to case', async () => {
    const { token } = await pendingApproval();
    await execute('UPDATE tickets SET approval_email = ? WHERE approval_token = ?', [
      'Line.Manager@Example.com',
      token,
    ]);
    await as(approver).get('/approvals/' + token).expect(200);
  });
});

describe('the approval page design', () => {
  test('Mail has an Approval page tab, listing the standard design as default', async () => {
    const page = await as(admin).get(BASE).expect(200);
    assert.match(page.text, /aria-current="page">Approval page/);
    assert.match(page.text, /Standard/);
    assert.match(page.text, /New approval page/);
    assert.doesNotMatch(page.text, /Assign to groups/, 'groups are the requester portal\'s alone');
  });

  test('a new design starts from a layout with {{content}}, edited with a sample preview', async () => {
    const created = await post(admin, BASE, { name: 'Branded approval' }).expect(302);
    const id = /\/approval\/([^/?#]+)$/.exec(String(created.headers.location))?.[1];
    assert.ok(id);
    const portal = await findPortal(id);
    assert.equal(portal?.kind, 'approval');
    assert.match(portal?.layout_html ?? '', /\{\{content\}\}/);

    const editor = await as(admin).get(BASE + '/' + id).expect(200);
    assert.match(editor.text, new RegExp('src="' + BASE + '/' + id + '/sample\\?frame=1"'));
    assert.doesNotMatch(editor.text, /\{\{nav\}\}/, 'requester-only variables are not offered');
    assert.match(editor.text, /\{\{ticket_reference\}\}/);

    const sample = await as(admin).get(BASE + '/' + id + '/sample?frame=1').expect(200);
    assert.equal(sample.headers['x-frame-options'], undefined);
    assert.match(sample.text, /SR-000123/);
    assert.match(sample.text, /class="approval-intro"/);
    assert.match(sample.text, / inert>/, 'the sample form cannot be submitted');
  });

  test('a layout without {{content}}, or with requester-only variables, is refused', async () => {
    const created = await post(admin, BASE, { name: 'Strict approval' }).expect(302);
    const id = /\/approval\/([^/?#]+)$/.exec(String(created.headers.location))![1];
    const missing = await post(admin, BASE + '/' + id + '/parts/layout', { code: '<h1>Hi</h1>' }).expect(400);
    assert.match(missing.text, /\{\{content\}\} exactly once/);
    const wrongKind = await post(admin, BASE + '/' + id + '/parts/layout', {
      code: '{{nav}}{{content}}',
    }).expect(400);
    assert.match(wrongKind.text, /Not a variable this portal knows/);
  });

  test('the default design is what the approver sees, with the request filled in', async () => {
    const created = await post(admin, BASE, { name: 'Live approval' }).expect(302);
    const id = /\/approval\/([^/?#]+)$/.exec(String(created.headers.location))![1]!;
    await post(admin, BASE + '/' + id + '/parts/layout', {
      code: '<p class="marker-approval">{{ticket_title}} for {{requester_name}}</p>{{content}}',
    }).expect(302);
    await post(admin, BASE + '/' + id + '/default').expect(302);

    const { token } = await pendingApproval();
    const page = await as(approver).get('/approvals/' + token).expect(200);
    assert.match(page.text, /class="marker-approval">New laptop for approval\.requester@example\.com/);
    assert.match(page.text, /name="decision" value="approved"/, 'the form is still there');

    // And the requester portal is untouched by it.
    const tickets = await as(requester).get('/tickets').expect(200);
    assert.doesNotMatch(tickets.text, /marker-approval/);

    await setDefaultPortal(STANDARD_PORTAL, null, 'approval');
  });

  test('an approval page is not reachable through the requester portal editor', async () => {
    const created = await post(admin, BASE, { name: 'Kind check' }).expect(302);
    const id = /\/approval\/([^/?#]+)$/.exec(String(created.headers.location))![1];
    await as(admin).get('/admin/settings/customization/portal/' + id).expect(404);
  });
});
