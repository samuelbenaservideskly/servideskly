import './env.js';
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { dialect, query } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { PG_BASELINE_VERSION, PG_SCHEMA } from '../src/db/pg-schema.js';

before(async () => {
  await bootstrapTestDatabase();
});

test('the PostgreSQL schema has every table and column SQLite has', { skip: dialect !== 'sqlite' }, async () => {
  const tables = await query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'",
  );
  for (const { name } of tables) {
    const create = new RegExp('CREATE TABLE "?' + name + '"? \\(([\\s\\S]*?)\\);', 'i').exec(PG_SCHEMA);
    assert.ok(create, 'table ' + name + ' is missing from src/db/pg-schema.ts - run npx tsx scripts/pg-schema.ts');
    const columns = await query<{ name: string }>('SELECT name FROM pragma_table_info(?)', [name]);
    for (const column of columns) {
      assert.match(create[1]!, new RegExp('\\b' + column.name + '\\b'), name + '.' + column.name + ' is missing from the PostgreSQL schema');
    }
  }
});

test('every migration after the PostgreSQL baseline has a PostgreSQL variant', () => {
  const missing = migrations.filter((m) => m.version > PG_BASELINE_VERSION && !m.pg).map((m) => m.version + ' ' + m.name);
  assert.deepEqual(missing, [], 'add a pg variant, or regenerate the baseline with npx tsx scripts/pg-schema.ts');
});

test('the translation keeps literals and turns ? and LIKE into PostgreSQL', async () => {
  const { toPostgres } = await import('../src/db/index.js');
  assert.equal(
    toPostgres("SELECT * FROM t WHERE a = ? AND b LIKE ? ESCAPE '\\' AND c = 'is it?' AND \"d?\" NOT LIKE ?"),
    "SELECT * FROM t WHERE a = $1 AND b ILIKE $2 ESCAPE '\\' AND c = 'is it?' AND \"d?\" NOT ILIKE $3",
  );
  assert.equal(toPostgres("SELECT 'it''s ?' , ? -- a comment?\n, ?"), "SELECT 'it''s ?' , $1 -- a comment?\n, $2");
});
