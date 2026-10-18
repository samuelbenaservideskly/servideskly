import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import {
  deleteTemplate,
  ensureDefaultTemplate,
  ensureStarterTemplates,
  listTaskTemplatesOfKind,
  listTemplatesOfType,
} from '../src/services/templates.js';

let app: Express;
let admin: TestSession;

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  await ensureStarterTemplates();
  app = createApp();
  admin = await signInAs('kinds.admin@example.com', 'admin');
});

describe('a starter template per kind', () => {
  test('every kind has one, and the default incident is not duplicated', async () => {
    assert.equal((await listTemplatesOfType('service_request')).length, 1);
    assert.equal((await listTemplatesOfType('incident')).length, 1, 'the default is the incident');
    assert.equal((await listTemplatesOfType('change_request')).length, 1);

    const tasks = await listTaskTemplatesOfKind('task');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.parent_type, 'service_request');

    const changeTasks = await listTaskTemplatesOfKind('change_task');
    assert.equal(changeTasks.length, 1);
    assert.equal(changeTasks[0]?.parent_type, 'change_request');
  });

  test('runs once: a starter deleted stays deleted after a restart', async () => {
    const [sr] = await listTemplatesOfType('change_request');
    assert.ok(sr);
    await deleteTemplate(sr.id);
    await ensureStarterTemplates();
    assert.equal((await listTemplatesOfType('change_request')).length, 0);
  });
});

describe('the type tabs', () => {
  test('All plus one tab per kind, each filtering the list', async () => {
    const all = await as(admin).get('/admin/settings/templates').expect(200);
    assert.match(all.text, /aria-current="page">All</);
    for (const label of ['Service request', 'Incident', 'Change request', 'Task', 'Change task']) {
      assert.match(all.text, new RegExp('>' + label + '</a>'));
    }

    const sr = await as(admin).get('/admin/settings/templates?type=service_request').expect(200);
    assert.match(sr.text, /aria-current="page">Service request</);
    assert.match(sr.text, /Standard service request/);
    assert.doesNotMatch(sr.text, /Default request/);
    assert.match(sr.text, /href="\/admin\/settings\/templates\/new\?type=service_request"/);
  });

  test('the task tabs list task templates with the template they are raised with', async () => {
    const page = await as(admin).get('/admin/settings/templates?type=task').expect(200);
    assert.match(page.text, /Standard task/);
    assert.match(page.text, /Raised with/);
    assert.match(page.text, /Standard service request/);
    assert.doesNotMatch(page.text, /New template/, 'tasks are added on their parent');
  });

  test('a new template from a type tab starts as that type', async () => {
    const page = await as(admin).get('/admin/settings/templates/new?type=change_request').expect(200);
    assert.match(page.text, /<option value="change_request"[^>]*selected/);
  });
});
