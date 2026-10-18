import './env.js';
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { createApp } from '../src/app.js';
import { execute } from '../src/db/index.js';
import { signInAs } from './support/session.js';

let app: Express;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
});

/** The profile shows the details that are set - from the directory, SCIM or an administrator - and only those. */
test('the profile lists what is set about the person, and leaves out what is not', async () => {
  const person = await signInAs('profile.person@example.com', 'user');
  await execute('UPDATE users SET first_name = ?, company = ?, job_title = ?, phone = ? WHERE id = ?', [
    'Jana',
    'Contoso',
    'Controller',
    '+420 777 000 111',
    person.user.id,
  ]);
  const page = await request(app).get('/profile').set('Cookie', person.cookie).expect(200);
  assert.match(page.text, /<dt>First name<\/dt>\s*<dd>Jana<\/dd>/);
  assert.match(page.text, /<dt>Company<\/dt>\s*<dd>Contoso<\/dd>/);
  assert.match(page.text, /<dt>Job title<\/dt>\s*<dd>Controller<\/dd>/);
  assert.match(page.text, /<dt>Phone<\/dt>\s*<dd>\+420 777 000 111<\/dd>/);
  assert.doesNotMatch(page.text, /<dt>Department<\/dt>/, 'nothing set, nothing shown');
});
