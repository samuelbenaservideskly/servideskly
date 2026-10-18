import './env.js';
import assert from 'node:assert/strict';
import test, { before, beforeEach, describe } from 'node:test';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { cutProblem, stripSignature } from '../src/services/mail/signatures.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { createMailbox, findMailbox } from '../src/services/mail/mailboxes.js';
import { setTransportFactory } from '../src/services/mail/transport.js';
import { queryOne } from '../src/db/index.js';
import { ingest } from '../src/services/mail/inbound.js';
import { upsertUserFromDirectory } from '../src/services/users.js';
import type { MailTransport } from '../src/services/mail/transport.js';

/**
 * Ticket automation: what happens to a message once it has been read.
 */

async function ticketCount(): Promise<number> {
  const row = await queryOne<{ c: number }>('SELECT count(*) AS c FROM tickets');
  return Number(row?.c ?? 0);
}

const REPLY = [
  'It is working again, thank you.',
  '',
  'Kind regards,',
  'Jan Novak',
  '+420 123 456 789',
].join('\n');

describe('stripping a signature', () => {
  test('cuts from the first line that matches, and keeps what came before', () => {
    assert.equal(
      stripSignature(REPLY, ['Kind regards']),
      'It is working again, thank you.',
    );
  });

  test('ignores case, because nobody types it the same way twice', () => {
    assert.equal(stripSignature(REPLY, ['kind REGARDS']), 'It is working again, thank you.');
  });

  test('is a regular expression, so one pattern can cover several sign-offs', () => {
    assert.equal(
      stripSignature(REPLY, ['^(Kind regards|Best wishes|S pozdravem)']),
      'It is working again, thank you.',
    );
  });

  test('leaves the message alone when cutting would empty it', () => {
    // A reply that is only a sign-off is still a reply, and an empty comment
    // is worse than a polite one.
    const polite = 'Kind regards,\nJan';
    assert.equal(stripSignature(polite, ['Kind regards']), polite);
  });

  test('does nothing with no patterns, which is how it ships', () => {
    assert.equal(stripSignature(REPLY, []), REPLY);
  });

  test('one unusable pattern does not stop the others', () => {
    assert.equal(
      stripSignature(REPLY, ['([unclosed', 'Kind regards']),
      'It is working again, thank you.',
    );
  });

  test('a very long line is left untested, so a careless pattern cannot stall', () => {
    const long = 'a'.repeat(5000);
    assert.equal(stripSignature('Hello\n' + long, ['(a+)+$']), 'Hello\n' + long);
  });

  test('a pattern that cannot compile is refused where it is typed', () => {
    assert.match(cutProblem('([unclosed'), /not a valid expression/);
    assert.equal(cutProblem('Kind regards'), '');
    assert.match(cutProblem('   '), /cannot be empty/);
  });
});

describe('who may raise a ticket by email', () => {
  let mailboxId: string;

  const quiet: MailTransport = {
    send: async () => undefined,
    fetch: async () => [],
    acknowledge: async () => undefined,
  };

  const message = (from: string, messageId: string) => ({
    messageId,
    from,
    fromName: 'A Sender',
    subject: 'The printer is broken',
    body: 'It makes a noise and then stops.',
    inReplyTo: '',
    references: [],
    receivedAt: new Date().toISOString(),
  });

  before(async () => {
    await bootstrapTestDatabase();
    setTransportFactory(() => quiet);

    const mailbox = await createMailbox(
      {
        name: 'Help',
        address: 'help@example.com',
        kind: 'graph',
        groupId: null,
        tenantId: 'tenant-1',
        clientId: 'client-1',
        clientSecret: 'super-secret',
        graphUserId: 'help@example.com',
        imapHost: '',
        imapPort: 993,
        imapTls: true,
        smtpHost: '',
        smtpPort: 587,
        smtpTls: false,
        username: '',
        password: '',
        receiveEnabled: true,
        isActive: true,
      },
      null,
    );
    mailboxId = mailbox.id;

    await upsertUserFromDirectory({
      issuer: 'https://login.microsoftonline.com/test-tenant/v2.0',
      externalId: 'oid-known',
      email: 'known@example.com',
      upn: 'known@example.com',
      displayName: 'Known Person',
      role: 'user',
      source: 'jit',
      markLogin: true,
    });
  });

  beforeEach(async () => {
    await updateSettings({ automation: { knownSendersOnly: false } }, null);
  });

  test('a stranger gets a ticket while the setting is off', async () => {
    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);

    const result = await ingest(mailbox, message('stranger@elsewhere.test', '<a@x>'));
    assert.equal(result.outcome, 'ticket.created');
  });

  test('with it on, a stranger is read and dropped', async () => {
    await updateSettings({ automation: { knownSendersOnly: true } }, null);
    assert.equal(settings().automation.knownSendersOnly, true);

    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);

    const before = await ticketCount();
    const result = await ingest(mailbox, message('stranger2@elsewhere.test', '<b@x>'));

    assert.equal(result.outcome, 'ignored.stranger');
    assert.equal(result.ticketId, null);
    assert.equal(
      await ticketCount(),
      before,
      'nothing may be raised for an address with no account',
    );
  });

  test('somebody with an account still gets through', async () => {
    await updateSettings({ automation: { knownSendersOnly: true } }, null);

    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);

    const result = await ingest(mailbox, message('known@example.com', '<c@x>'));
    assert.equal(result.outcome, 'ticket.created');
  });
});
