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
  createUserGroup,
  listUserGroupMembers,
  matches,
  RULE_ATTRIBUTES,
  type RuleRow,
} from '../src/services/user-groups.js';
import { findUserById, setProfileAttributes } from '../src/services/users.js';
import { readScimUser } from '../src/services/scim.js';

let app: Express;
let admin: TestSession;
let person: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('ext.admin@example.com', 'admin');
  person = await signInAs('ext.person@example.com', 'user');
});

describe('extension attributes 1 to 3', () => {
  test('are rule attributes', () => {
    for (const n of [1, 2, 3]) assert.ok(RULE_ATTRIBUTES.includes(('extension_attribute_' + n) as never));
  });

  test('are edited on the user page and saved', async () => {
    const agent = request.agent(app);
    agent.set('Cookie', admin.cookie);
    const page = await agent.get('/admin/settings/users/' + person.user.id).expect(200);
    for (const n of [1, 2, 3]) assert.match(page.text, new RegExp('name="extension' + n + '"'));

    await agent
      .post('/admin/settings/users/' + person.user.id + '/profile')
      .type('form')
      .send({ _csrf: admin.csrfToken, department: '', jobTitle: '', office: '', extension2: 'Cost centre 4410' })
      .expect(302);
    const saved = await findUserById(person.user.id);
    assert.equal(saved?.extension_attribute_2, 'Cost centre 4410');
    assert.equal(saved?.extension_attribute_1, '');
  });

  test('a dynamic group can be built on one', async () => {
    await setProfileAttributes(
      person.user.id,
      { department: '', jobTitle: '', office: '', extension1: 'VIP', extension2: '', extension3: '' },
      null,
    );
    const group = await createUserGroup({ name: 'VIPs', description: '', isActive: true }, null);
    await addRule(group.id, { attribute: 'extension_attribute_1', operator: 'equals', value: 'vip' }, null);
    const members = await listUserGroupMembers(group.id);
    assert.deepEqual(members.map((m) => m.email), ['ext.person@example.com']);
  });

  test('matching is case-insensitive, like every other attribute', async () => {
    const user = (await findUserById(person.user.id))!;
    const rule = { attribute: 'extension_attribute_1', operator: 'equals', value: 'Vip' } as RuleRow;
    assert.equal(matches(user, rule), true);
  });

  test('SCIM reads them at the top level, or under any extension schema', () => {
    const input = readScimUser({
      userName: 'a@example.com',
      extensionAttribute1: 'top',
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { extensionAttribute2: 'enterprise' },
      'urn:ietf:params:scim:schemas:extension:Contoso:2.0:User': { extensionAttribute3: 'custom' },
    });
    assert.equal(input.extension1, 'top');
    assert.equal(input.extension2, 'enterprise');
    assert.equal(input.extension3, 'custom');
  });
});
