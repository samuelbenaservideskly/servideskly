import './env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { BREAK_GLASS_FILE, ensureLocalAdmin, findLocalAdmin, setLocalPassword } from '../src/auth/local-accounts.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';

let app: Express;

before(async () => {
  await bootstrapTestDatabase();
  await ensureLocalAdmin();
  app = createApp();
});

describe('the theme and the favicon', () => {
  test('are served without a session: no cookie, and cached', async () => {
    for (const url of ['/branding/theme.css?v=1', '/branding/favicon?v=1', '/favicon.ico']) {
      const res = await request(app).get(url).expect(200);
      assert.equal(res.headers['set-cookie'], undefined, url + ' sets no cookie');
      assert.doesNotMatch(String(res.headers['cache-control']), /no-store/, url + ' may be cached');
    }
  });
});

describe("the break-glass account's first password", () => {
  test('lives in the data folder, never the log, and goes when the password is changed', async () => {
    fs.writeFileSync(BREAK_GLASS_FILE, 'generated\n', { mode: 0o600 });
    const admin = (await findLocalAdmin())!;
    await setLocalPassword(admin.id, 'Lighthouse-velvet-9271', admin.id);
    assert.equal(fs.existsSync(BREAK_GLASS_FILE), false);
  });
});
