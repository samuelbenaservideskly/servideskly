import './env.js';
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { createApp } from '../src/app.js';
import { findLocalAdmin } from '../src/auth/local-accounts.js';

let app: Express;
before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
});

/**
 * A hosted helpdesk has no break-glass account; its administrators set a
 * password from the portal's link. The sign-in form must be there anyway -
 * it was hidden, leaving "not set up yet" and a dead Microsoft button
 * (reported 17 Oct 2026).
 */
test('with no break-glass account, the password sign-in form is offered, and no dead button', async () => {
  assert.equal(await findLocalAdmin(), undefined, 'none in this database');
  const page = await request(app).get('/login').expect(200);
  assert.match(page.text, /name="email"/);
  assert.doesNotMatch(page.text, /Sign-in is not set up yet/);
  assert.doesNotMatch(page.text, /disabled>Sign in with Microsoft/);
});
