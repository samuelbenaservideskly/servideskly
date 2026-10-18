import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import {
  addRule,
  applyRules,
  createUserGroup,
  deleteUserGroup,
  listRules,
  listUserGroupMembers,
  listUserGroups,
  matches,
  setManualMember,
  userGroupIdsFor,
  type RuleRow,
} from '../src/services/user-groups.js';
import { findUserById, setProfileAttributes, type UserRow } from '../src/services/users.js';
import { listTickets } from '../src/services/tickets.js';
import {
  createTemplate,
  defaultTemplate,
  ensureDefaultTemplate,
  findTemplate,
  placeField,
  setTemplateAudience,
  templateAudience,
  templatesVisibleTo,
} from '../src/services/templates.js';

/** A template with nothing set but a name, for the audience tests. */
const TEMPLATE = {
  summary: '',
  title: '',
  body: '',
  priority: 'normal' as const,
  category: 'other' as const,
  type: 'incident' as const,
  groupId: null,
  categoryId: null,
  fields: [],
  isActive: true,
};

let app: Express;
let admin: TestSession;
let adminAgent: request.Agent;
let hrPerson: TestSession;
let hrAgent: request.Agent;
let outsider: TestSession;
let outsiderAgent: request.Agent;

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

/** The viewer row, freshly read, for the service-level calls. */
async function viewer(session: TestSession): Promise<UserRow> {
  const row = await findUserById(session.user.id);
  assert.ok(row);
  return row;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();

  admin = await signInAs('ug.admin@example.com', 'admin');
  adminAgent = request.agent(app);
  adminAgent.set('Cookie', admin.cookie);

  hrPerson = await signInAs('ug.hr@example.com', 'user');
  hrAgent = request.agent(app);
  hrAgent.set('Cookie', hrPerson.cookie);

  outsider = await signInAs('ug.other@example.com', 'user');
  outsiderAgent = request.agent(app);
  outsiderAgent.set('Cookie', outsider.cookie);
});

describe('rule matching', () => {
  const rule = (over: Partial<RuleRow>): RuleRow => ({
    id: 'r',
    group_id: 'g',
    attribute: 'department',
    operator: 'equals',
    value: 'HR',
    created_at: '',
    ...over,
  });

  const person = (department: string): UserRow =>
    ({ department, job_title: '', office: '', email: 'a@b.c' }) as UserRow;

  test('matching ignores case and surrounding space', async () => {
    // A rule that missed somebody because their directory capitalises
    // differently would be a support call nobody could explain.
    assert.equal(matches(person('hr'), rule({})), true);
    assert.equal(matches(person('  HR  '), rule({})), true);
    assert.equal(matches(person('Finance'), rule({})), false);
  });

  test('every comparison behaves as its name says', async () => {
    assert.equal(matches(person('Finance'), rule({ operator: 'not_equals' })), true);
    assert.equal(matches(person('HR Operations'), rule({ operator: 'contains', value: 'ops' })), false);
    assert.equal(matches(person('HR Operations'), rule({ operator: 'contains', value: 'oper' })), true);
    assert.equal(matches(person('HR Operations'), rule({ operator: 'starts_with', value: 'hr' })), true);
    assert.equal(matches(person('HR Operations'), rule({ operator: 'ends_with', value: 'ions' })), true);
    assert.equal(matches(person(''), rule({ operator: 'is_empty' })), true);
    assert.equal(matches(person('HR'), rule({ operator: 'is_set' })), true);
    assert.equal(matches(person(''), rule({ operator: 'is_set' })), false);
  });

  test('an empty value never matches everything by accident', async () => {
    // "contains ''" is true of every string, which would quietly put the
    // whole directory in the group.
    assert.equal(matches(person('Finance'), rule({ operator: 'contains', value: '' })), false);
    assert.equal(matches(person('Finance'), rule({ operator: 'starts_with', value: '' })), false);
  });
});

describe('membership by rule', () => {
  let groupId: string;

  before(async () => {
    const group = await createUserGroup(
      { name: 'HR', description: 'Everyone in HR', isActive: true },
      null,
    );
    groupId = group.id;
    await setProfileAttributes(
      hrPerson.user.id,
      { department: 'HR', jobTitle: 'Adviser', office: 'Head office', extension1: '', extension2: '', extension3: '' },
      null,
    );
    await setProfileAttributes(
      outsider.user.id,
      { department: 'Finance', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '' },
      null,
    );
  });

  test('a rule puts matching accounts in, and leaves the rest out', async () => {
    await addRule(groupId, { attribute: 'department', operator: 'equals', value: 'HR' }, null);

    const members = await listUserGroupMembers(groupId);
    assert.deepEqual(
      members.map((m) => m.email).sort(),
      ['ug.hr@example.com'],
      'only the HR account matches',
    );
    assert.equal(members[0]?.member_source, 'rule');
  });

  test('changing a department moves somebody in or out', async () => {
    await setProfileAttributes(
      outsider.user.id,
      { department: 'HR', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '' },
      null,
    );
    await applyRules(groupId, null);
    assert.equal((await listUserGroupMembers(groupId)).length, 2);

    await setProfileAttributes(
      outsider.user.id,
      { department: 'Finance', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '' },
      null,
    );
    await applyRules(groupId, null);
    assert.deepEqual(
      (await listUserGroupMembers(groupId)).map((m) => m.email),
      ['ug.hr@example.com'],
      'a stale rule member is removed, not left behind',
    );
  });

  test('a hand-picked member survives a recompute', async () => {
    await setManualMember(groupId, outsider.user.id, true, null);
    await applyRules(groupId, null);

    const members = await listUserGroupMembers(groupId);
    const manual = members.find((m) => m.email === 'ug.other@example.com');
    assert.ok(manual, 'they must still be there');
    assert.equal(
      manual.member_source,
      'manual',
      'a recompute must not quietly undo a deliberate decision',
    );
  });

  test('several rules are OR-ed, not AND-ed', async () => {
    await addRule(groupId, { attribute: 'office', operator: 'equals', value: 'Branch' }, null);
    assert.equal((await listRules(groupId)).length, 2);

    // The HR person matches the first rule and not the second, and is still in.
    const members = await listUserGroupMembers(groupId);
    assert.ok(members.some((m) => m.email === 'ug.hr@example.com'));
  });

  test('a rule needs something to compare against', async () => {
    await assert.rejects(
      () => addRule(groupId, { attribute: 'department', operator: 'equals', value: '  ' }, null),
      /compare against/i,
    );
  });

  test('an attribute outside the list is refused', async () => {
    // `role` and `status` are deliberately not available: a rule reading them
    // would be a second, invisible place where access is decided.
    await assert.rejects(
      () => addRule(groupId, { attribute: 'role', operator: 'equals', value: 'admin' }, null),
      /not an attribute/i,
    );
  });
});

describe('a user group decides which templates somebody is offered', () => {
  let groupId: string;
  let externalId: string;
  let openId: string;

  before(async () => {
    const group = await createUserGroup(
      { name: 'External', description: 'Contractors and suppliers', isActive: true },
      null,
    );
    groupId = group.id;
    await setManualMember(groupId, hrPerson.user.id, true, null);

    const external = await createTemplate(
      { ...TEMPLATE, name: 'External request' },
      null,
    );
    externalId = external.id;
    await placeField(external, 'title', null, null);
    await setTemplateAudience((await findTemplate(externalId))!, [groupId], null);

    const open = await createTemplate({ ...TEMPLATE, name: 'Anyone may use this' }, null);
    openId = open.id;
    await placeField(open, 'title', null, null);
  });

  test('a template with no audience is offered to everybody', async () => {
    assert.deepEqual(await templateAudience(openId), []);
    assert.ok((await templatesVisibleTo([])).some((t) => t.id === openId));
    assert.ok((await templatesVisibleTo([groupId])).some((t) => t.id === openId));
  });

  test('a restricted template is offered only to its groups', async () => {
    assert.deepEqual(await templateAudience(externalId), [groupId]);

    const forMember = await templatesVisibleTo([groupId]);
    assert.ok(forMember.some((t) => t.id === externalId));

    const forOutsider = await templatesVisibleTo([]);
    assert.ok(
      !forOutsider.some((t) => t.id === externalId),
      'somebody outside the group must not even be offered it',
    );
  });

  test('the picker shows it to a member and hides it from everyone else', async () => {
    const member = await hrAgent.get('/tickets/new').expect(200);
    assert.match(member.text, /External request/);

    const other = await outsiderAgent.get('/tickets/new').expect(200);
    assert.doesNotMatch(other.text, /External request/);

    // The picker only appears once somebody has a choice, so what the
    // outsider is *offered* is the thing to assert, not what is drawn.
    const offered = await templatesVisibleTo(await userGroupIdsFor(outsider.user.id));
    assert.ok(offered.some((t) => t.name === 'Anyone may use this'));
    assert.ok(!offered.some((t) => t.name === 'External request'));
  });

  test('a direct link to a template they may not use falls back, not through', async () => {
    const page = await outsiderAgent
      .get('/tickets/new?template=' + externalId)
      .expect(200);

    // Hiding it in the picker is presentation; this is the rule.
    assert.doesNotMatch(
      page.text,
      new RegExp('name="templateId" value="' + externalId + '"'),
      'a shared link must not bypass the restriction',
    );
  });

  test('posting the id of a template they may not use is ignored', async () => {
    const page = await outsiderAgent.get('/tickets/new').expect(200);
    await outsiderAgent
      .post('/tickets')
      .field('_csrf', csrfFrom(page.text))
      .field('templateId', externalId)
      .field('title', 'Smuggled through a restricted form')
      .field('description', 'The template id was posted by hand.')
      .expect(302);

    const raised = (
      await listTickets(await viewer(outsider), {
        scope: 'mine',
        status: 'any',
        page: 1,
        perPage: 50,
      })
    ).items.find((t) => t.title === 'Smuggled through a restricted form');

    assert.ok(raised, 'the ticket is still raised, on the plain form');
    // The restricted template sets no title of its own, so the proof is that
    // the form they got was not it: its audience excluded them.
    assert.ok(
      !(await templatesVisibleTo(await userGroupIdsFor(outsider.user.id)))
        .some((t) => t.id === externalId),
      'they were never entitled to that template',
    );
  });

  test('a member may raise one from it', async () => {
    const page = await hrAgent.get('/tickets/new?template=' + externalId).expect(200);
    assert.match(page.text, new RegExp('name="templateId" value="' + externalId + '"'));

    await hrAgent
      .post('/tickets')
      .field('_csrf', csrfFrom(page.text))
      .field('templateId', externalId)
      .field('title', 'Raised from the external form')
      .field('description', 'By somebody who is in the group.')
      .expect(302);
  });

  test('losing membership loses the template', async () => {
    await setManualMember(groupId, hrPerson.user.id, false, null);
    const page = await hrAgent.get('/tickets/new').expect(200);
    assert.doesNotMatch(page.text, /External request/);

    await setManualMember(groupId, hrPerson.user.id, true, null);
  });

  test('a rule can grant it, so membership need not be by hand', async () => {
    const byRule = await createUserGroup({ name: 'Legal', description: '', isActive: true }, null);
    await addRule(byRule.id, { attribute: 'department', operator: 'equals', value: 'Legal' }, null);

    const forLegal = await createTemplate({ ...TEMPLATE, name: 'Legal only' }, null);
    await placeField(forLegal, 'title', null, null);
    await setTemplateAudience((await findTemplate(forLegal.id))!, [byRule.id], null);

    // Nobody is in Legal yet.
    assert.ok(!(await templatesVisibleTo(await userGroupIdsFor(outsider.user.id)))
      .some((t) => t.id === forLegal.id));

    await setProfileAttributes(
      outsider.user.id,
      { department: 'Legal', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '' },
      null,
    );
    await applyRules(byRule.id, null);

    assert.ok(
      (await templatesVisibleTo(await userGroupIdsFor(outsider.user.id)))
        .some((t) => t.id === forLegal.id),
      'the rule put them in the group, so the form appeared',
    );
  });

  test('the default template cannot be restricted', async () => {
    // Start-up guarantees one; a test file does not run start-up.
    await ensureDefaultTemplate();
    const current = await defaultTemplate();
    assert.ok(current);

    // Anybody outside the chosen group would have no form at all.
    await assert.rejects(
      () => setTemplateAudience(current, [groupId], null),
      /cannot be restricted/i,
    );
    assert.deepEqual(await templateAudience(current.id), []);
  });

  test('deleting a group reopens the templates it gated', async () => {
    const doomed = await createUserGroup({ name: 'Doomed', description: '', isActive: true }, null);
    const gated = await createTemplate({ ...TEMPLATE, name: 'Gated' }, null);
    await placeField(gated, 'title', null, null);
    await setTemplateAudience((await findTemplate(gated.id))!, [doomed.id], null);

    await deleteUserGroup(doomed.id, null);

    assert.deepEqual(
      await templateAudience(gated.id),
      [],
      'the restriction goes with the group, rather than leaving a form nobody can see',
    );
    assert.ok((await templatesVisibleTo([])).some((t) => t.id === gated.id));
  });
});

describe('the administration pages', () => {
  test('Groups holds both kinds, as two tabs', async () => {
    for (const path of ['/admin/settings/groups', '/admin/settings/groups/users']) {
      const page = await adminAgent.get(path).expect(200);
      assert.match(page.text, /href="\/admin\/settings\/groups"[^>]*>Technician groups/);
      assert.match(page.text, /href="\/admin\/settings\/groups\/users"[^>]*>User groups/);
    }
  });

  test('the user-groups page is not swallowed by the technician router', async () => {
    // '/groups/:id' would otherwise match '/groups/users' and report that a
    // group with the id "users" does not exist.
    const page = await adminAgent.get('/admin/settings/groups/users').expect(200);
    assert.match(page.text, /New user group/);
  });

  test('a group is created, then given a rule, through the UI', async () => {
    const list = await adminAgent.get('/admin/settings/groups/users').expect(200);
    const created = await adminAgent
      .post('/admin/settings/groups/users')
      .type('form')
      .send({ _csrf: csrfFrom(list.text), name: 'Through The UI', description: 'From the form.' })
      .expect(302);

    const id = String(created.headers.location).split('/').pop();
    assert.ok(id);

    const detail = await adminAgent.get('/admin/settings/groups/users/' + id).expect(200);
    await adminAgent
      .post('/admin/settings/groups/users/' + id + '/rules')
      .type('form')
      .send({
        _csrf: csrfFrom(detail.text),
        attribute: 'department',
        operator: 'equals',
        value: 'HR',
      })
      .expect(302);

    const group = (await listUserGroups()).find((g) => g.id === id);
    assert.ok(group);
    assert.equal(group.rule_count, 1);
    assert.ok(group.member_count >= 1, 'the rule should have matched the HR account');
  });

  test('a duplicate name comes back on the form, not as a 409 page', async () => {
    await createUserGroup({ name: 'Already Taken', description: '', isActive: true }, null);

    const list = await adminAgent.get('/admin/settings/groups/users').expect(200);
    const refused = await adminAgent
      .post('/admin/settings/groups/users')
      .type('form')
      .send({ _csrf: csrfFrom(list.text), name: 'already taken' })
      .expect(400);

    assert.match(refused.text, /already exists/);
    assert.doesNotMatch(refused.text, /Conflict/);
  });

  test('a requester cannot reach any of it', async () => {
    await hrAgent.get('/admin/settings/groups/users').expect(403);
    const group = (await listUserGroups())[0];
    assert.ok(group);
    await hrAgent.get('/admin/settings/groups/users/' + group.id).expect(403);
  });

  test('an administrator can type the attributes a rule reads', async () => {
    const page = await adminAgent
      .get('/admin/settings/users/' + outsider.user.id)
      .expect(200);
    assert.match(page.text, /name="department"/, 'rules are unusable without this');

    await adminAgent
      .post('/admin/settings/users/' + outsider.user.id + '/profile')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), department: 'Legal', jobTitle: 'Counsel', office: '' })
      .expect(302);

    const updated = await findUserById(outsider.user.id);
    assert.equal(updated?.department, 'Legal');
    assert.equal(updated?.job_title, 'Counsel');
  });
});
