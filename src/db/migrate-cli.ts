import { assertDatabaseReachable, closeDatabase, queryOne, runMigrations } from './index.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'migrate-cli' });

await assertDatabaseReachable();
await runMigrations();

const latest = await queryOne<{ version: number; name: string }>(
  'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1',
);
log.info({ schemaVersion: latest?.version ?? 0, name: latest?.name }, 'database is up to date');

await closeDatabase();
