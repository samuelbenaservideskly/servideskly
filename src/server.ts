import { createApp } from './app.js';
import { config } from './config.js';
import { assertDatabaseReachable, closeDatabase, pruneExpired, runMigrations } from './db/index.js';
import { logger } from './lib/logger.js';
import { ensureLocalAdmin } from './auth/local-accounts.js';
import { loadSettings, settings } from './settings/index.js';
import { ensureDefaultTemplate, ensureStarterTemplates, ensureTypeDefaults } from './services/templates.js';
import { loadLanguages } from './i18n/index.js';
import { adoptCurrentStarter } from './services/portal.js';
import { ensureExampleAutomations, markPastAutomationWrites } from './services/automation.js';
import { seedNotifications } from './services/mail/notifications.js';
import { adoptLegacyRelay } from './services/mail/relay.js';
import { adoptInitialBranding, adoptNewDefaultColours } from './services/branding.js';
import { flushOutbox } from './services/mail/outbox.js';
import { autoCloseResolved, deleteOldClosedTickets } from './services/tickets.js';
import { sealPlaintext } from './services/data-sealing.js';
import { announceSlaBreaches, notifySlaBreaches } from './services/sla-alerts.js';
import { pollAllMailboxes } from './services/mail/inbound.js';
import { flushAudit } from './lib/audit.js';
import { settleAutomations } from './services/automation.js';

const log = logger.child({ module: 'server' });

/**
 * Startup order matters and is deliberate:
 *
 *  1. prove the database is reachable, so a misconfigured DATABASE_URL fails
 *     with one clear message instead of a flood of request errors;
 *  2. apply migrations, under an advisory lock so concurrent containers are
 *     safe;
 *  3. read the settings into memory, because `settings()` is synchronous and
 *     is consulted by the first request;
 *  4. make sure the break-glass administrator exists;
 *  5. make sure there is a default ticket template, because raising a ticket
 *     always goes through one and the first requester must not have to wait
 *     for an administrator to create it;
 *  6. make sure the notification wording exists - seeding only ever adds, so
 *     an administrator's edits survive every restart;
 *  7. only then accept traffic.
 */
await assertDatabaseReachable();
await runMigrations();
await loadSettings();
// The languages this service desk serves, in memory beside the settings:
// t() is called a few hundred times a page and cannot go to the database.
await loadLanguages();
await adoptLegacyRelay();
// Once: what automations wrote before migration 56 stops counting as a response.
await markPastAutomationWrites();
await adoptNewDefaultColours();
// A logo and favicon the provisioner pointed at, once, before anybody has
// had a chance to upload their own.
await adoptInitialBranding();
// A requester portal nobody has touched moves onto the current design;
// one somebody wrote is never rewritten.
await adoptCurrentStarter();
await ensureLocalAdmin();
await ensureDefaultTemplate();
// After the default, so an empty install's default is the incident one.
await ensureStarterTemplates();
// Every ticket type gets a default, so "raise an incident" always opens
// something. Only ever adds; a type that has one keeps it.
await ensureTypeDefaults();
// Worked automation examples, switched off; once ever, like the starters.
await ensureExampleAutomations((await ensureDefaultTemplate())?.id ?? null);
await seedNotifications();
await pruneExpired();

// Data from before encryption at rest is encrypted in the background: the
// first pass over a large helpdesk takes a while, and reading works either way.
void sealPlaintext().catch((err) => log.warn({ err }, 'sealing pass failed'));

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  log.info(
    {
      host: config.host,
      port: config.port,
      publicOrigin: config.publicOrigin,
      env: config.env,
      database: config.database.description,
      jitProvisioning: settings().provisioning.jitEnabled,
      scim: settings().scim.enabled,
    },
    'service desk listening',
  );

  if (!settings().ssoConfigured) {
    log.warn(
      'OpenID Connect is not configured yet. Sign in with the local administrator ' +
        'account and complete the setup under Admin -> Settings.',
    );
  }
});

// A port clash is an ordinary operator mistake, not a crash. Report it plainly
// instead of letting it surface as an uncaught exception with a stack trace.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.fatal(
      { host: config.host, port: config.port },
      'Port ' +
        config.port +
        ' is already in use on ' +
        config.host +
        '. Another instance is probably still running: stop it, or set PORT to a free port.',
    );
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    log.fatal(
      { port: config.port },
      'Permission denied binding port ' + config.port + '. Ports below 1024 need elevation.',
    );
    process.exit(1);
  }
  log.fatal({ err }, 'the server could not start');
  process.exit(1);
});

// Slow-loris style connections are cut off rather than held open forever.
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 15_000;

// Housekeeping: expired sessions, finished login flows, replay records.
const pruneTimer = setInterval(() => {
  void pruneExpired().catch((err) => log.warn({ err }, 'housekeeping pass failed'));
}, 10 * 60_000);
pruneTimer.unref();

/**
 * Mail.
 *
 * Two passes on different clocks. Sending is frequent because somebody is
 * waiting for the mail; reading is less so because polling a mailbox harder
 * than it fills up only earns a rate limit.
 *
 * Both swallow their errors into a log line: a mail service that is down must
 * never stop the application, and the failure is already recorded against the
 * mailbox for the settings page to show.
 */
const outboxTimer = setInterval(() => {
  void flushOutbox().catch((err) => log.warn({ err }, 'sending queued mail failed'));
}, 30_000);
outboxTimer.unref();

/**
 * Closing resolved tickets that have gone quiet.
 *
 * Hourly, because the setting is in days: checking more often would do
 * nothing but wake the process up.
 */
const closeTimer = setInterval(() => {
  void autoCloseResolved().catch((err) => log.warn({ err }, 'auto-close pass failed'));
  // Deleting old closed tickets rides the same hourly pass: the setting is
  // in days, and both read the clock rather than a timer set per ticket.
  void deleteOldClosedTickets().catch((err) => log.warn({ err }, 'ticket retention pass failed'));
  // Anything a write left in plain text is encrypted (data-sealing.ts).
  void sealPlaintext().catch((err) => log.warn({ err }, 'sealing pass failed'));
}, 60 * 60_000);
closeTimer.unref();

/**
 * Telling group managers about SLA breaches. Every 15 minutes: targets are
 * in business minutes, and an hour late is too late for a 30-minute one.
 */
const slaTimer = setInterval(() => {
  void notifySlaBreaches().catch((err) => log.warn({ err }, 'SLA breach pass failed'));
  void announceSlaBreaches().catch((err) => log.warn({ err }, 'SLA breach automation pass failed'));
}, 15 * 60_000);
slaTimer.unref();

const mailboxTimer = setInterval(() => {
  void pollAllMailboxes().catch((err) => log.warn({ err }, 'reading the mailboxes failed'));
}, 2 * 60_000);
mailboxTimer.unref();

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');

  clearInterval(pruneTimer);
  clearInterval(outboxTimer);
  clearInterval(mailboxTimer);
  clearInterval(closeTimer);

  server.close((err) => {
    if (err) log.error({ err }, 'error while closing the server');
    // Let the audit trail catch up, then drain the connection pool, so
    // in-flight queries are not cut off mid-transaction.
    // Background automation runs (HTTP steps) finish first: cutting one off
    // would leave its run unrecorded. The 15 s timeout below still applies.
    settleAutomations()
      .then(() => flushAudit())
      .catch((auditErr) => log.error({ err: auditErr }, 'error flushing the audit trail'))
      .then(() => closeDatabase())
      .catch((closeErr) => log.error({ err: closeErr }, 'error closing the database'))
      .finally(() => process.exit(err ? 1 : 0));
  });

  // Do not hang forever on lingering keep-alive connections.
  setTimeout(() => {
    log.warn('forcing shutdown after timeout');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  // An unknown-state process is not trustworthy: log and let the supervisor
  // restart it.
  log.fatal({ err }, 'uncaught exception, exiting');
  shutdown('uncaughtException');
});
