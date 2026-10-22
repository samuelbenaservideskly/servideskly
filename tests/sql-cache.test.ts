import './env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { query, sqlCacheSizes, toPostgres } from '../src/db/index.js';

/**
 * The prepared-statement and PostgreSQL caches are bounded (review,
 * 22 Oct 2026): SQL built with a list of ids is new text for every length,
 * and kept for ever it was memory a long-running server only gained.
 */
test('thousands of different SQL texts never grow the caches past their limit', async () => {
  await bootstrapTestDatabase();
  const { limit } = sqlCacheSizes();
  for (let n = 1; n <= limit + 300; n += 1) {
    const marks = Array.from({ length: n }, () => '?').join(', ');
    await query('SELECT id FROM users WHERE id IN (' + marks + ')', Array.from({ length: n }, (_, i) => 'none-' + i));
    toPostgres('SELECT ' + n + ' AS n WHERE 1 = ?');
  }
  const sizes = sqlCacheSizes();
  assert.ok(sizes.statements <= limit, 'statements ' + sizes.statements);
  assert.ok(sizes.translated <= limit, 'translations ' + sizes.translated);
  // A query run all the time stays cached and keeps working.
  const rows = await query<{ n: number }>('SELECT 1 AS n');
  assert.equal(Number(rows[0]!.n), 1);
});
