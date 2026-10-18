import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Populates process.env for a test file. Must run before anything imports
 * src/config.ts, which validates the environment at module load, so each test
 * file imports its environment module as its very first statement.
 *
 * Every file gets its own SQLite file in its own temp directory. The node test
 * runner puts each file in its own process, so that gives complete isolation
 * for nothing: creating a SQLite database is a file write.
 *
 * With TEST_PG_ADMIN_URL set (CI's PostgreSQL job), every file gets its own
 * PostgreSQL database instead, created by bootstrapTestDatabase().
 */
export function configureTestEnv(overrides: Record<string, string> = {}): string {
  // Named after the test file where possible, so a leftover directory is
  // traceable, plus randomness so repeated runs never collide.
  const label = (process.argv[1] ?? 'tests')
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.test\.ts$/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .slice(0, 24);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helpdesk-' + label + '-'));
  const databasePath = path.join(root, 'test.sqlite');
  const uploadDir = path.join(root, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const base: Record<string, string> = {
    NODE_ENV: 'test',
    APP_BASE_URL: 'http://localhost:3000',
    // No tenant credentials: the tests run against a deliberately
    // unconfigured installation, which is a state the application supports.
    AUTH_MODE: 'oidc',
    DATABASE_PATH: databasePath,
    UPLOAD_DIR: uploadDir,
    SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    PROVISIONING_MODE: 'jit',
    DEFAULT_ROLE: 'user',
    ROLE_MAP_ADMIN_GROUPS: '11111111-1111-1111-1111-111111111111,Helpdesk Admins',
    ROLE_MAP_AGENT_GROUPS: '22222222-2222-2222-2222-222222222222',
    ROLE_MAP_ADMIN_APP_ROLES: 'Helpdesk.Admin',
    ROLE_MAP_AGENT_APP_ROLES: 'Helpdesk.Agent',
    BOOTSTRAP_ADMIN_EMAILS: '',
    GRAPH_SYNC_ENABLED: 'false',
    // The tests assert the real policy, not the relaxed one a local proof of
    // concept runs with, so neither of these is inherited from .env.
    PASSWORD_MIN_LENGTH: '12',
    LOCAL_SEED_PASSWORD: '',
  };

  const pgAdmin = process.env.TEST_PG_ADMIN_URL;
  if (pgAdmin) {
    const name = 'helpdesk_' + label + '_' + crypto.randomBytes(4).toString('hex');
    const url = new URL(pgAdmin);
    url.pathname = '/' + name;
    base.DATABASE_URL = url.toString();
  } else {
    base.DATABASE_URL = '';
  }

  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    process.env[key] = value;
  }

  process.on('exit', () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Temp directory cleanup is best effort.
    }
  });

  return databasePath;
}
