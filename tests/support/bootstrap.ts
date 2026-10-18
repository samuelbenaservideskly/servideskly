import pg from 'pg';
import { runMigrations } from '../../src/db/index.js';
import { loadSettings } from '../../src/settings/index.js';

/**
 * Brings a test file's own schema up to date and loads the settings cache.
 *
 * The application does this in server.ts before it accepts traffic; a test
 * that builds the app directly has to do the same. On PostgreSQL the file's
 * own database is created first (see support/env.ts).
 */
export async function bootstrapTestDatabase(): Promise<void> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  const url = process.env.DATABASE_URL;
  if (adminUrl && url) {
    const name = new URL(url).pathname.slice(1);
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('unexpected test database name ' + name);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (!exists.rowCount) await admin.query('CREATE DATABASE ' + name);
    } finally {
      await admin.end();
    }
  }
  await runMigrations();
  await loadSettings();
}
