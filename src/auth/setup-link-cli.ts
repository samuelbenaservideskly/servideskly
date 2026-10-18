/**
 * Prints the one-time link that creates a helpdesk's first administrator,
 * for a helpdesk you run yourself:
 *
 *   npm run setup-link -- you@example.com           (from the source)
 *   node dist/auth/setup-link-cli.js you@example.com (a built deployment)
 *
 * A production helpdesk has no password account to start from (no
 * break-glass account), so its first administrator comes from a `/setup`
 * link signed with its own SESSION_SECRET (setup-token.ts) - the link a
 * hosting portal would otherwise make. Run it where the helpdesk's
 * environment is (SESSION_SECRET and APP_BASE_URL), open the link within an
 * hour, and choose a password. It works once: after that every link is
 * refused.
 */
import { config } from '../config.js';
import { signSetupToken } from './setup-token.js';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: setup-link <email address of the first administrator>');
  process.exit(1);
}
const nonce = Math.random().toString(36).slice(2, 10);
const link = config.publicOrigin + '/setup?t=' + signSetupToken(email, Date.now() + 60 * 60_000, nonce);
console.log('Open this within the hour to create the administrator ' + email + ':\n\n' + link + '\n');
