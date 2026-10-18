import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { z } from 'zod';

// A missing .env is not an error in itself - the environment may be supplied by
// the container or service manager - but it is by far the most likely reason
// for the validation below to fail, so remember it for the error message.
const dotenvResult = dotenv.config();
const envFileMissing =
  dotenvResult.error !== undefined &&
  (dotenvResult.error as NodeJS.ErrnoException).code === 'ENOENT';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Comma separated list -> trimmed, de-duplicated, non-empty entries. */
const csv = z
  .string()
  .optional()
  .transform((v) =>
    Array.from(
      new Set(
        (v ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ),
  );

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return dflt;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const int = (dflt: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? dflt : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const roleEnum = z.enum(['user', 'agent', 'admin']);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: int(3000, 1, 65535),
  APP_BASE_URL: z.string().url(),
  TRUST_PROXY: z.string().optional(),

  SESSION_SECRET: csv,
  SESSION_IDLE_TIMEOUT_MINUTES: int(30, 1, 24 * 60),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: int(12, 1, 24 * 30),

  // Path to the SQLite database file. Created on first start, along with
  // its parent directory.
  DATABASE_PATH: z.string().min(1).default('./data/ticketing.sqlite'),
  // PostgreSQL instead: postgres://user:password@host:5432/db?sslmode=require.
  // Set, it wins and DATABASE_PATH is ignored. On Azure it is a Key Vault
  // reference, so the password is never in configuration.
  DATABASE_URL: z.string().optional(),
  // How long to wait for another writer to release its lock before giving
  // up. SQLite allows one writer at a time; this is the queue.
  DATABASE_BUSY_TIMEOUT_MS: int(10_000, 100, 120_000),

  // Attachments and uploaded branding. A directory, mounted as a volume in a
  // container deployment.
  UPLOAD_DIR: z.string().min(1).default('./data/uploads'),

  // Password given to the seeded local accounts (admin and user) when they
  // are first created. Ignored in production, where a random password is
  // generated and logged once instead.
  LOCAL_SEED_PASSWORD: z.string().optional(),
  // Minimum password length. Floored at 12 in production regardless.
  PASSWORD_MIN_LENGTH: int(12, 1, 200),


  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default('openid profile email'),
  OIDC_EXTRA_ISSUERS: csv,

  // Whether an account unknown to the service may be created on its first
  // successful sign-in. With it off, only accounts SCIM has provisioned can
  // get in. Roles are never derived from the directory - see README.
  PROVISIONING_JIT: bool(true),
  FORCE_LOCAL_SIGNIN: bool(false),


  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Where this copy's source code and license are published, linked from
  // the foot of every page; whoever runs a changed copy points this at
  // their own repository.
  SOURCE_URL: z.string().url().default('https://github.com/servideskly/servideskly'),
});

// Treat an empty or whitespace-only variable as absent, so its documented
// default applies. Service managers, CI and .env templates all routinely leave
// a name in place with no value, and `NODE_ENV=` should not be a fatal error.
const rawEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string' && value.trim() !== '') rawEnv[key] = value;
}

const parsed = schema.safeParse(rawEnv);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => '  - ' + (i.path.join('.') || '(root)') + ': ' + i.message)
    .join('\n');
  const remedy = envFileMissing
    ? 'No .env file was found in ' +
      process.cwd() +
      '.\nCopy the template and fill it in:\n\n  cp .env.example .env\n\n' +
      'For a local run you need only NODE_ENV and APP_BASE_URL;\n' +
      'see the "First run" section of docs/MANUAL.md.'
    : 'Check these variables in your .env file or service environment.\nSee .env.example for the full list.';
  throw new Error('Invalid environment configuration:\n' + issues + '\n\n' + remedy);
}
const env = parsed.data;

const isProduction = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

const baseUrl = new URL(env.APP_BASE_URL);
if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
  throw new Error('APP_BASE_URL must be an origin only, e.g. https://helpdesk.example.com');
}
const publicOrigin = baseUrl.origin;
const secureCookies = baseUrl.protocol === 'https:';

// ---------------------------------------------------------------------------
// Fail-closed configuration checks. A misconfigured deployment must not start.
// ---------------------------------------------------------------------------
const fatal: string[] = [];
const warnings: string[] = [];

const weakSecret = (s: string) => s.length < 32 || /^(changeme|secret|password|test)/i.test(s);

if (env.SESSION_SECRET.length === 0) {
  if (isProduction) fatal.push('SESSION_SECRET is required.');
} else if (env.SESSION_SECRET.some(weakSecret)) {
  const msg = 'SESSION_SECRET entries must be at least 32 characters of unguessable random data.';
  if (isProduction) fatal.push(msg);
  else console.warn('[config] WARNING: ' + msg);
}

if (isProduction && !secureCookies) {
  fatal.push('APP_BASE_URL must use https:// when NODE_ENV=production.');
}

// SQLite is a file on local disk. On a platform whose filesystem is network
// backed or replaced on each deploy - an Azure Web App content share, for
// one - the database would be slow, corruptible, or simply lost. Warn rather
// than refuse: a single-instance proof of concept on such a host is a
// legitimate thing to do deliberately.
const databaseUrl = env.DATABASE_URL && /^postgres(ql)?:\/\//.test(env.DATABASE_URL.trim()) ? env.DATABASE_URL.trim() : null;
if (env.DATABASE_URL && !databaseUrl) {
  // Most often an Azure Key Vault reference that did not resolve.
  fatal.push('DATABASE_URL is set but is not a postgres:// address (an unresolved Key Vault reference?).');
}
// An Azure Key Vault reference App Service could not resolve arrives as its
// own text. As a session key that would be public knowledge - refuse it.
for (const [name, value] of Object.entries(process.env)) {
  if (typeof value === 'string' && value.trim().startsWith('@Microsoft.KeyVault(')) {
    fatal.push(name + ' is an Azure Key Vault reference that did not resolve: check the secret name and the web app\'s access to the vault.');
  }
}

if (isProduction && !databaseUrl) {
  warnings.push(
    'Running on SQLite in production. It suits a single instance with local disk only: it cannot be shared between instances, and on a network or ephemeral filesystem it will corrupt or vanish. Move to a server database before this carries real traffic.',
  );
}

// Identity provider credentials are deliberately NOT required here. An
// installation may start with none at all: the local break-glass
// administrator can sign in and configure single sign-on from
// Admin -> Settings. The settings form validates a configuration before
// storing it, and the sign-in route refuses to start a flow that is
// incomplete, so an unconfigured install fails closed rather than half-open.

for (const warning of warnings) {
  console.warn('[config] WARNING: ' + warning);
}

if (fatal.length > 0) {
  throw new Error(
    'Refusing to start, configuration is unsafe:\n' + fatal.map((f) => '  - ' + f).join('\n'),
  );
}

const uploadDir = path.isAbsolute(env.UPLOAD_DIR)
  ? env.UPLOAD_DIR
  : path.resolve(ROOT_DIR, env.UPLOAD_DIR);
fs.mkdirSync(uploadDir, { recursive: true });

const databasePath = path.isAbsolute(env.DATABASE_PATH)
  ? env.DATABASE_PATH
  : path.resolve(ROOT_DIR, env.DATABASE_PATH);
// ':memory:' is resolved above into a nonsense path; keep it as written.
const resolvedDatabasePath =
  env.DATABASE_PATH === ':memory:' ? ':memory:' : databasePath;
if (!databaseUrl && resolvedDatabasePath !== ':memory:') {
  fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
}

// Outside production an ephemeral random key is used when none is supplied, so
// that no weak default is ever baked into the codebase.
const sessionKeys =
  env.SESSION_SECRET.length > 0
    ? env.SESSION_SECRET
    : [crypto.randomBytes(48).toString('base64url')];

const tenant = encodeURIComponent(env.ENTRA_TENANT_ID ?? '');

export const config = {
  env: env.NODE_ENV,
  isProduction,
  isTest,
  host: env.HOST,
  port: env.PORT,
  publicOrigin,
  trustProxy:
    env.TRUST_PROXY && env.TRUST_PROXY.trim() !== '' ? env.TRUST_PROXY.trim() : false,
  logLevel: env.LOG_LEVEL,
  sourceUrl: env.SOURCE_URL,

  session: {
    // The __Host- prefix binds the cookie to this exact origin and requires
    // Secure + Path=/ + no Domain, which browsers enforce for us.
    name: secureCookies ? '__Host-hdsid' : 'hdsid',
    keys: sessionKeys,
    secureCookies,
    idleTimeoutMs: env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000,
    absoluteTimeoutMs: env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000,
  },

  database: {
    /** PostgreSQL when set; SQLite at `path` otherwise. */
    url: databaseUrl,
    path: resolvedDatabasePath,
    // Never the password: host and database name only.
    description: databaseUrl
      ? (() => {
          const u = new URL(databaseUrl);
          return 'postgres://' + u.host + u.pathname;
        })()
      : resolvedDatabasePath,
    busyTimeoutMs: env.DATABASE_BUSY_TIMEOUT_MS,
  },

  localAccounts: {
    // Only outside production: a known password for the seeded accounts, so
    // a proof of concept can be signed into without reading the log.
    seedPassword: isProduction ? null : (env.LOCAL_SEED_PASSWORD ?? null),
    // Production keeps the real policy whatever the environment asks for.
    minPasswordLength: isProduction ? Math.max(env.PASSWORD_MIN_LENGTH, 12) : env.PASSWORD_MIN_LENGTH,
  },

  uploadDir,


  oidc: {
    tenantId: env.ENTRA_TENANT_ID ?? '',
    clientId: env.ENTRA_CLIENT_ID ?? '',
    clientSecret: env.ENTRA_CLIENT_SECRET ?? '',
    scopes: env.OIDC_SCOPES.split(/\s+/).filter(Boolean),
    extraIssuers: env.OIDC_EXTRA_ISSUERS,
    redirectUri: publicOrigin + '/auth/oidc/callback',
    discoveryUrl:
      'https://login.microsoftonline.com/' + tenant + '/v2.0/.well-known/openid-configuration',
  },

  provisioning: {
    jitEnabled: env.PROVISIONING_JIT,
  },

  /**
   * Turns password sign-in back on whatever Settings says. The recovery
   * path for an installation whose only other door - Entra ID - has
   * stopped working (an expired client secret, a deleted app registration).
   */
  forceLocalSignIn: env.FORCE_LOCAL_SIGNIN,

} as const;

export type Config = typeof config;
export type Role = z.infer<typeof roleEnum>;
