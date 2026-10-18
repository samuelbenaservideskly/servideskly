import { AsyncLocalStorage } from 'node:async_hooks';
import Database from 'better-sqlite3';
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { isSealedText, openText } from '../lib/field-crypto.js';
import { migrations, PG_NOW } from './migrations.js';
import { PG_BASELINE_VERSION, PG_SCHEMA } from './pg-schema.js';

const log = logger.child({ module: 'db' });

/**
 * Database access: SQLite, or PostgreSQL when DATABASE_URL is set.
 *
 * The API is `async` even though better-sqlite3 is synchronous: every caller
 * already awaits, so PostgreSQL is a change to this file rather than to every
 * call site. The SQL above this layer is written once, in the SQLite dialect
 * the codebase has always used, and translated here for PostgreSQL:
 *
 *  - **Placeholders** are positional `?` (-> `$1, $2...`).
 *  - **LIKE** is case-insensitive in SQLite (-> `ILIKE`).
 *  - **Timestamps** are TEXT, ISO-8601 UTC with milliseconds
 *    (`2026-01-31T09:15:00.000Z`), which sorts correctly as text. `sqlNow`
 *    produces it in either database; a `Date` parameter is converted on the
 *    way in.
 *  - **Booleans** are 0 and 1 on disk (INTEGER / BIGINT). `true`/`false`
 *    parameters are converted on the way in; the columns in BOOLEAN_COLUMNS
 *    are converted back on the way out.
 *  - **JSON** columns are TEXT, parsed on the way out for JSON_COLUMNS and
 *    stringified on the way in. `sqlJsonText()` reads one key in SQL.
 *  - **Integers** come back as numbers from both (pg's 64-bit and numeric
 *    types are parsed; values here stay far below 2^53).
 *
 * Transactions keep SQLite's guarantee on PostgreSQL too: one writer at a
 * time (an advisory lock taken at BEGIN), and every query made while a
 * transaction is open - through its client or the plain helpers - runs on
 * that transaction's connection.
 */

export const dialect: 'sqlite' | 'postgres' = config.database.url ? 'postgres' : 'sqlite';
const isPg = dialect === 'postgres';

// ---------------------------------------------------------------------------
// Column conventions
// ---------------------------------------------------------------------------

/**
 * Columns stored as 0/1 that the application expects as booleans.
 *
 * Keyed by column name rather than table.column: the names are distinctive
 * across this schema, and a SELECT result does not reliably say which table a
 * column came from. Adding a boolean column means adding it here.
 */
const BOOLEAN_COLUMNS = new Set([
  'role_locked',
  'directory_present',
  'is_internal',
  'must_change',
  'is_active',
  'is_default',
  'receive_enabled',
  'is_enabled',
  'imap_tls',
  'smtp_tls',
  'visible_to_everyone',
  'via_relay',
  'task_mandatory',
  'close_when_tasks_done',
  'require_tasks_done',
  'urgent',
  'is_private',
  'automatic',
]);

/** Columns holding a JSON document as TEXT. */
const JSON_COLUMNS = new Set(['widgets', 'detail', 'document', 'data', 'fields', 'attachment_ids', 'pages', 'graph', 'dashboard_options', 'allowed_actions', 'template_ids', 'choices', 'strings', 'domains']);

const SQLITE_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** SQL expression for "now", in the text format described above. */
export const sqlNow = isPg ? PG_NOW : SQLITE_NOW;

/** SQL reading one top-level key of a JSON TEXT column, as text. */
export function sqlJsonText(column: string, key: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(column) || !/^\w+$/.test(key)) throw new Error('unsafe JSON path');
  return isPg ? '((' + column + '::jsonb) ->> \'' + key + '\')' : "json_extract(" + column + ", '$." + key + "')";
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

let sqlite: Database.Database | null = null;
let pool: pg.Pool | null = null;

if (isPg) {
  // 64-bit integers and numerics as numbers, like SQLite returns them.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  pool = new pg.Pool({
    connectionString: config.database.url!,
    max: 10,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
    // Idle connections must not keep a finished process (a test file, a script) alive.
    allowExitOnIdle: true,
  });
  // A connection dropped while idle must not take the process down.
  pool.on('error', (err) => log.error({ err }, 'idle database connection failed'));
} else {
  sqlite = new Database(config.database.path);
  // WAL lets readers carry on while a write is in progress, which matters as
  // soon as two requests overlap. NORMAL is the matching durability setting:
  // safe against process crashes, and only at risk from a host power loss.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  // Foreign keys are off by default in SQLite. Every REFERENCES clause in the
  // schema is meaningless without this.
  sqlite.pragma('foreign_keys = ON');
  // One writer at a time: queue behind it rather than failing with SQLITE_BUSY.
  sqlite.pragma('busy_timeout = ' + config.database.busyTimeoutMs);
}

/** The SQLite handle - for tooling (scripts/pg-schema.ts) only. */
export function sqliteHandle(): Database.Database {
  if (!sqlite) throw new Error('Not running on SQLite.');
  return sqlite;
}

/**
 * Prepared statements are cached: preparing is the expensive half of a query,
 * and the SQL strings in this codebase are a fixed set.
 */
const statements = new Map<string, Database.Statement>();

function prepare(sql: string): Database.Statement {
  let statement = statements.get(sql);
  if (!statement) {
    statement = sqlite!.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

// ---------------------------------------------------------------------------
// The SQLite dialect, as PostgreSQL
// ---------------------------------------------------------------------------

const translated = new Map<string, string>();

/**
 * `?` -> `$n` and LIKE -> ILIKE, outside string literals, quoted
 * identifiers and comments. Cached: the SQL strings are a fixed set.
 */
export function toPostgres(sql: string): string {
  const hit = translated.get(sql);
  if (hit !== undefined) return hit;
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      // A literal or a quoted identifier: copied as is, '' and "" included.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? sql.length : j;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '?') {
      n += 1;
      out += '$' + n;
      i += 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /\w/.test(sql[j]!)) j += 1;
      const word = sql.slice(i, j);
      out += word.toUpperCase() === 'LIKE' ? 'ILIKE' : word;
      i = j;
    } else {
      out += c;
      i += 1;
    }
  }
  translated.set(sql, out);
  return out;
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

export type QueryParam = unknown;

/** What better-sqlite3 will accept as a bound value; pg accepts the same. */
type DriverValue = string | number | bigint | Buffer | null;

/** Application value -> something the driver can bind. */
function toDriver(value: unknown): DriverValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

function bind(params: QueryParam[]): DriverValue[] {
  return params.map(toDriver) as DriverValue[];
}

/** Row as the driver returns it -> row as the application expects it. */
function fromDriver<T>(row: Record<string, unknown> | undefined): T | undefined {
  if (!row) return undefined;
  for (const key of Object.keys(row)) {
    let value = row[key];
    if (value === null) continue;
    // Encrypted at rest (lib/field-crypto.ts): opened here, by its prefix
    // rather than its column, so an alias (`... AS by`) reads it too - and
    // before the JSON step, since an encrypted JSON column is sealed text.
    if (isSealedText(value)) row[key] = value = openText(value);
    if (BOOLEAN_COLUMNS.has(key)) {
      row[key] = value === 1 || value === '1' || value === true;
    } else if (JSON_COLUMNS.has(key) && typeof value === 'string') {
      try {
        row[key] = JSON.parse(value);
      } catch {
        // A hand-edited row. Leave the text as it is; the caller validates.
      }
    }
  }
  return row as T;
}

function fromDriverAll<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => fromDriver<T>(row)!);
}

// ---------------------------------------------------------------------------
// Running a statement
// ---------------------------------------------------------------------------

/** The connection a PostgreSQL transaction holds, for everything run inside it. */
const inTransaction = new AsyncLocalStorage<pg.PoolClient>();

async function pgRun(sql: string, params: QueryParam[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const client = inTransaction.getStore();
  const result = await (client ?? pool!).query(toPostgres(sql), bind(params));
  return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Every matching row. */
export async function query<T>(sql: string, params: QueryParam[] = []): Promise<T[]> {
  if (isPg) return fromDriverAll<T>((await pgRun(sql, params)).rows);
  return fromDriverAll<T>(prepare(sql).all(bind(params)) as Record<string, unknown>[]);
}

/** The first row, or undefined. */
export async function queryOne<T>(sql: string, params: QueryParam[] = []): Promise<T | undefined> {
  if (isPg) return fromDriver<T>((await pgRun(sql, params)).rows[0]);
  return fromDriver<T>(prepare(sql).get(bind(params)) as Record<string, unknown> | undefined);
}

/**
 * Number of rows affected.
 *
 * Also the right helper for a statement with no result, including DDL.
 */
export async function execute(sql: string, params: QueryParam[] = []): Promise<number> {
  if (isPg) return (await pgRun(sql, params)).rowCount;
  const statement = prepare(sql);
  // A statement with RETURNING is a reader as far as SQLite is concerned and
  // refuses to .run(); nothing here needs its rows, so drain and report them.
  if (statement.reader) {
    const rows = statement.all(bind(params)) as unknown[];
    return rows.length;
  }
  return statement.run(bind(params)).changes;
}

/** A single count(*) value. */
export async function count(sql: string, params: QueryParam[] = []): Promise<number> {
  const row = await queryOne<{ c: number }>(sql, params);
  return Number(row?.c ?? 0);
}

/**
 * The subset of a connection the data layer uses inside a transaction.
 *
 * Narrow on purpose: it is what a future server-database driver would have to
 * provide, and nothing here depends on a particular client object.
 */
export interface DbClient {
  query<T>(sql: string, params?: QueryParam[]): Promise<T[]>;
}

const transactionClient: DbClient = {
  async query<T>(sql: string, params: QueryParam[] = []): Promise<T[]> {
    if (isPg) return fromDriverAll<T>((await pgRun(sql, params)).rows);
    const statement = prepare(sql);
    if (statement.reader) {
      return fromDriverAll<T>(statement.all(bind(params)) as Record<string, unknown>[]);
    }
    statement.run(bind(params));
    return [];
  },
};

/** One fixed key: every transaction takes it, so writers go one at a time. */
const WRITER_LOCK = 72_001;

/**
 * Anything that reads and then writes based on what it read must go through
 * here, so the whole sequence is atomic.
 *
 * SQLite: BEGIN IMMEDIATE takes the write lock up front. Without it SQLite
 * starts the transaction as a reader and tries to upgrade on the first write,
 * which can fail outright with SQLITE_BUSY_SNAPSHOT when another writer got
 * there first - and a read-then-write sequence is exactly the shape that hits
 * it.
 *
 * PostgreSQL: the same one-writer guarantee with a transaction-scoped
 * advisory lock, which code such as allocating a ticket's number relies on.
 */
export async function transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  if (isPg) {
    // Already inside one: join it (waiting for our own lock would never end).
    if (inTransaction.getStore()) return fn(transactionClient);
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITER_LOCK]);
      const result = await inTransaction.run(client, () => fn(transactionClient));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.error({ err: rollbackErr }, 'rollback failed');
      }
      throw err;
    } finally {
      client.release();
    }
  }
  sqlite!.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn(transactionClient);
    sqlite!.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      sqlite!.exec('ROLLBACK');
    } catch (rollbackErr) {
      log.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  }
}

/** Convenience for reading one row inside a transaction. */
export async function clientOne<T>(
  client: DbClient,
  sql: string,
  params: QueryParam[] = [],
): Promise<T | undefined> {
  const rows = await client.query<T>(sql, params);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Applies every migration that has not been recorded yet.
 *
 * SQLite: each migration in its own transaction with the row that records
 * it. PostgreSQL: an empty database gets the baseline schema (src/db/pg-schema.ts,
 * equal to SQLite's after PG_BASELINE_VERSION) and records those versions;
 * a later migration runs its `pg` variant, and one without refuses.
 */
export async function runMigrations(): Promise<void> {
  if (isPg) return runPostgresMigrations();

  sqlite!.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (${SQLITE_NOW})
    )
  `);

  const applied = sqlite!.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  const done = new Set(applied.map((r) => r.version));
  const pending = migrations
    .filter((m) => !done.has(m.version))
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    log.debug({ applied: done.size }, 'schema up to date');
    return;
  }

  const record = sqlite!.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  for (const migration of pending) {
    const apply = sqlite!.transaction(() => {
      sqlite!.exec(migration.sql);
      record.run(migration.version, migration.name);
    });
    apply();
    log.info({ version: migration.version, name: migration.name }, 'migration applied');
  }
}

async function runPostgresMigrations(): Promise<void> {
  const client = await pool!.connect();
  try {
    // Two instances starting at once must not both build the schema.
    await client.query('SELECT pg_advisory_lock($1)', [WRITER_LOCK + 1]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    BIGINT PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (${PG_NOW})
      )`);
    const applied = (await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows;
    const done = new Set(applied.map((r) => Number(r.version)));

    if (done.size === 0) {
      await client.query('BEGIN');
      try {
        // The simple query protocol: several statements in one call.
        await client.query(PG_SCHEMA);
        for (const m of migrations.filter((x) => x.version <= PG_BASELINE_VERSION)) {
          await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
          done.add(m.version);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      log.info({ baseline: PG_BASELINE_VERSION }, 'PostgreSQL schema created');
    }

    const pending = migrations.filter((m) => !done.has(m.version)).sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      if (!migration.pg) {
        throw new Error('Migration ' + migration.version + ' (' + migration.name + ') has no PostgreSQL variant.');
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.pg);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      log.info({ version: migration.version, name: migration.name }, 'migration applied');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [WRITER_LOCK + 1]).catch(() => undefined);
    client.release();
  }
}

/** Fails fast with a clear message when the database is unusable. */
export async function assertDatabaseReachable(): Promise<void> {
  try {
    if (isPg) await pool!.query('SELECT 1');
    else sqlite!.prepare('SELECT 1').get();
    log.info({ database: config.database.description, dialect }, 'opened the database');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      'Cannot open the database at ' +
        config.database.description +
        ': ' +
        reason +
        (isPg
          ? '\nCheck DATABASE_URL (host, login, password) and that the server accepts this host.'
          : '\nCheck DATABASE_PATH and that the process may write to that directory.'),
    );
  }
}

/** Removes expired sessions, finished login flows and replay records. */
export async function pruneExpired(): Promise<void> {
  const sessions = await execute('DELETE FROM sessions WHERE expires_at <= ' + sqlNow);
  const authRequests = await execute('DELETE FROM auth_requests WHERE expires_at <= ' + sqlNow);
  if (sessions + authRequests > 0) {
    log.debug({ sessions, authRequests }, 'pruned expired records');
  }
}

export async function closeDatabase(): Promise<void> {
  if (isPg) {
    await pool!.end();
    return;
  }
  // WAL content is folded back into the main file, so a backup that copies
  // only the .sqlite file after a clean shutdown is complete.
  try {
    sqlite!.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    log.warn({ err }, 'could not checkpoint the write-ahead log');
  }
  statements.clear();
  sqlite!.close();
}
