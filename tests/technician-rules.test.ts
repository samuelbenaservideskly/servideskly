import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute, query } from '../src/db/index.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { createGroup, listMembers, setMembersWithin } from '../src/services/groups.js';
import { addTechnicianRule, applyTechnicianRules, deleteTechnicianRule, listTechnicianRules } from '../src/services/technician-rules.js';

let app: Express;
let admin: TestSession;
let itAgent: TestSession;
let itUser: TestSession;
let hrAgent: TestSession;
let groupId = '';

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}
async function memberIds(): Promise<string[]> {
  return (await listMembers(groupId)).map((m) => m.id).sort();
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('tr.admin@example.com', 'admin');
  itAgent = await signInAs('tr.it.agent@example.com', 'agent');
  itUser = await signInAs('tr.it.user@example.com', 'user');
  hrAgent = await signInAs('tr.hr.agent@example.com', 'agent');
  for (const [s, dept] of [[itAgent, 'IT'], [itUser, 'IT'], [hrAgent, 'HR']] as const) {
    await execute('UPDATE users SET department = ? WHERE id = ?', [dept, s.user.id]);
  }
  groupId = (await createGroup({ name: 'Service desk', description: '', isActive: true }, null)).id;
});

describe('technician group rules', () => {
  test('a rule adds matching staff, and never a plain user', async () => {
    await addTechnicianRule(groupId, { attribute: 'department', operator: 'equals', value: 'it' }, null);
    assert.deepEqual(await memberIds(), [itAgent.user.id]);
    const rows = await query<{ source: string }>('SELECT source FROM technician_group_members WHERE group_id = ?', [groupId]);
    assert.deepEqual(rows.map((r) => r.source), ['rule']);
  });

  test('a hand-picked member stays when the rules change, and a rule member cannot be unticked', async () => {
    await setMembersWithin(groupId, [hrAgent.user.id], [hrAgent.user.id], null);
    await setMembersWithin(groupId, [itAgent.user.id], [], null);
    assert.deepEqual(await memberIds(), [itAgent.user.id, hrAgent.user.id].sort());

    const [rule] = await listTechnicianRules(groupId);
    await deleteTechnicianRule(groupId, rule!.id, null);
    assert.deepEqual(await memberIds(), [hrAgent.user.id]);
  });

  test('a change of department or role is picked up when the rules are applied', async () => {
    await addTechnicianRule(groupId, { attribute: 'department', operator: 'equals', value: 'IT' }, null);
    await execute("UPDATE users SET department = 'Finance' WHERE id = ?", [itAgent.user.id]);
    await applyTechnicianRules(groupId, null);
    assert.equal((await memberIds()).includes(itAgent.user.id), false);

    // The IT user is promoted through the page: the rule now takes them in.
    await post(admin, '/admin/settings/users/' + itUser.user.id + '/role', { role: 'agent' }).expect(302);
    assert.equal((await memberIds()).includes(itUser.user.id), true);
  });

  test('the group page shows the rules, the dialog and which members came by rule', async () => {
    const page = await as(admin).get('/admin/settings/groups/' + groupId).expect(200);
    assert.match(page.text, /id="rules"/);
    assert.match(page.text, /id="add-rule"/);
    assert.match(page.text, /by rule/);

    const refused = await post(admin, '/admin/settings/groups/' + groupId + '/rules', { attribute: 'department', operator: 'equals', value: '' }).expect(400);
    assert.match(refused.text, /class="dialog dialog--open" id="add-rule"/);

    await post(admin, '/admin/settings/groups/' + groupId + '/rules', { attribute: 'office', operator: 'is_set' }).expect(302);
    assert.equal((await listTechnicianRules(groupId)).length, 2);
  });
});
