import './env.js';
import assert from 'node:assert/strict';
import test, { before, beforeEach, describe } from 'node:test';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createGroup, setMembers } from '../src/services/groups.js';
import { createTicket, getTicketById } from '../src/services/tickets.js';
import { findUserByEmail } from '../src/services/users.js';
import { ticketReference } from '../src/lib/util.js';
import {
  createMailbox,
  defaultMailbox,
  deleteMailbox,
  findMailbox,
  mailboxPassword,
  listMailboxes,
  setDefaultMailbox,

  mailboxFor,
  mailboxSecret,
  updateMailbox,
} from '../src/services/mail/mailboxes.js';
import {
  NOTIFICATION_EVENTS,
  notificationFor,
  render,
  seedNotifications,
  updateNotification,
} from '../src/services/mail/notifications.js';
import {
  flushOutbox,
  listOutbox,
  notify,
  queueMail,
} from '../src/services/mail/outbox.js';
import {
  cleanSubject,
  ingest,
  matchTicket,
  pollMailbox,
} from '../src/services/mail/inbound.js';
import {
  plainText,
  setTransportFactory,
  trimQuotedHistory,
  type IncomingMessage,
  type MailTransport,
  type OutgoingMessage,
} from '../src/services/mail/transport.js';

let requester: TestSession;
let technician: TestSession;
let mailboxId: string;
let groupId: string;

/** Everything the fake transport was asked to do. */
const sent: OutgoingMessage[] = [];
let inbox: IncomingMessage[] = [];
const acknowledged: string[] = [];
let failNextSend = '';

class FakeTransport implements MailTransport {
  async send(message: OutgoingMessage): Promise<void> {
    if (failNextSend) {
      const reason = failNextSend;
      failNextSend = '';
      throw new Error(reason);
    }
    sent.push(message);
  }

  async fetch(): Promise<IncomingMessage[]> {
    const batch = inbox;
    inbox = [];
    return batch;
  }

  async acknowledge(messageId: string): Promise<void> {
    acknowledged.push(messageId);
  }
}

function incoming(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: '<' + Math.random().toString(36).slice(2) + '@example.com>',
    from: 'outsider@example.com',
    fromName: 'An Outsider',
    subject: 'The printer is on fire',
    body: 'It really is.',
    inReplyTo: '',
    references: [],
    receivedAt: new Date().toISOString(),
    ...over,
  };
}

before(async () => {
  await bootstrapTestDatabase();
  setTransportFactory(() => new FakeTransport());
  await seedNotifications();

  requester = await signInAs('mail.requester@example.com', 'user');
  technician = await signInAs('mail.tech@example.com', 'agent');

  const group = await createGroup({ name: 'Mail Team', description: '', isActive: true }, null);
  groupId = group.id;
  await setMembers(groupId, [technician.user.id], null);

  const mailbox = await createMailbox(
    {
      name: 'Service desk',
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
});

beforeEach(() => {
  sent.length = 0;
  inbox = [];
  acknowledged.length = 0;
  failNextSend = '';
});

describe('mailbox configuration', () => {
  test('the client secret is sealed, never stored in the open', async () => {
    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);
    assert.notEqual(mailbox.client_secret, 'super-secret');
    assert.doesNotMatch(mailbox.client_secret, /super-secret/);
    assert.equal(mailboxSecret(mailbox), 'super-secret', 'and it reads back');
  });

  test('saving without a secret keeps the stored one', async () => {
    const before = await findMailbox(mailboxId);
    assert.ok(before);

    await updateMailbox(
      mailboxId,
      {
        name: 'Service desk',
        address: 'help@example.com',
        kind: 'graph',
        groupId: null,
        tenantId: 'tenant-1',
        clientId: 'client-1',
        // Empty: the form does not echo a secret back into the page.
        clientSecret: '',
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

    const after = await findMailbox(mailboxId);
    assert.ok(after);
    assert.equal(mailboxSecret(after), 'super-secret');
  });

  test('as many mailboxes as you like, with exactly one default', async () => {
    // The first version allowed one per group plus one with no group, which
    // with no groups set up read as a limit of one.
    const made: string[] = [];
    for (const name of ['Second', 'Third', 'Fourth', 'Fifth']) {
      const mailbox = await createMailbox(
        {
          name,
          address: name.toLowerCase() + '@example.com',
          kind: 'graph',
          groupId: null,
          tenantId: 't',
          clientId: 'c',
          clientSecret: 's',
          graphUserId: name.toLowerCase() + '@example.com',
          imapHost: '',
          imapPort: 993,
          imapTls: true,
          smtpHost: '',
          smtpPort: 587,
          smtpTls: false,
          username: '',
          password: '',
          receiveEnabled: false,
          isActive: true,
        },
        null,
      );
      made.push(mailbox.id);
    }

    const all = await listMailboxes();
    assert.ok(all.length >= 5);
    assert.equal(
      all.filter((mailbox) => mailbox.is_default).length,
      1,
      'the database refuses two defaults',
    );
  });

  test('the first mailbox becomes the default on its own', async () => {
    // Otherwise a service desk with one mailbox sends nothing and gives no
    // clue why.
    assert.equal((await defaultMailbox())?.id, mailboxId);
  });

  test('the default can be handed to another mailbox', async () => {
    const other = (await listMailboxes()).find((mailbox) => mailbox.name === 'Third');
    assert.ok(other);

    await setDefaultMailbox(other.id, null);
    assert.equal((await defaultMailbox())?.id, other.id);
    assert.equal(
      (await listMailboxes()).filter((mailbox) => mailbox.is_default).length,
      1,
      'the old one is released',
    );

    await setDefaultMailbox(mailboxId, null);
  });

  test('removing the default hands it on rather than leaving none', async () => {
    const doomed = await createMailbox(
      {
        name: 'Doomed',
        address: 'doomed@example.com',
        kind: 'graph',
        groupId: null,
        tenantId: 't',
        clientId: 'c',
        clientSecret: 's',
        graphUserId: 'doomed@example.com',
        imapHost: '',
        imapPort: 993,
        imapTls: true,
        smtpHost: '',
        smtpPort: 587,
        smtpTls: false,
        username: '',
        password: '',
        receiveEnabled: false,
        isActive: true,
      },
      null,
    );
    await setDefaultMailbox(doomed.id, null);
    await deleteMailbox(doomed.id, null);

    const current = await defaultMailbox();
    assert.ok(current, 'a service desk must not silently stop sending');
    assert.notEqual(current.id, doomed.id);

    await setDefaultMailbox(mailboxId, null);
  });

  test('each kind asks only for the credentials it actually uses', async () => {
    // Reported as: choosing IMAP and SMTP should not show OAuth2 with a
    // secret. It should not *require* them either - these protocols have no
    // notion of a tenant or a client secret.
    await assert.rejects(
      () =>
        createMailbox(
          {
            name: 'Half configured',
            address: 'half@example.com',
            kind: 'imap_smtp',
            groupId: null,
            tenantId: '',
            clientId: '',
            clientSecret: '',
            graphUserId: '',
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
        ),
      /SMTP host.*Username.*Password|Username/s,
    );

    // With what IMAP and SMTP need, and nothing Graph needs, it is accepted.
    const imap = await createMailbox(
      {
        name: 'Open protocols',
        address: 'imap@example.com',
        kind: 'imap_smtp',
        groupId: null,
        tenantId: '',
        clientId: '',
        clientSecret: '',
        graphUserId: '',
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapTls: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpTls: false,
        username: 'desk@example.com',
        password: 'A-real-password-1',
        receiveEnabled: true,
        isActive: true,
      },
      null,
    );

    const stored = await findMailbox(imap.id);
    assert.ok(stored);
    assert.equal(stored.tenant_id, '', 'no OAuth2 was asked for or stored');
    assert.notEqual(stored.password, 'A-real-password-1', 'the password is sealed');
    assert.equal(mailboxPassword(stored), 'A-real-password-1', 'and reads back');

    // And a Graph mailbox is still refused without its client secret.
    await assert.rejects(
      () =>
        createMailbox(
          {
            name: 'No secret',
            address: 'nosecret@example.com',
            kind: 'graph',
            groupId: null,
            tenantId: 't',
            clientId: 'c',
            clientSecret: '',
            graphUserId: 'nosecret@example.com',
            imapHost: '',
            imapPort: 993,
            imapTls: true,
            smtpHost: '',
            smtpPort: 587,
            smtpTls: false,
            username: '',
            password: '',
            receiveEnabled: false,
            isActive: true,
          },
          null,
        ),
      /Client secret/,
    );
  });

  test("a ticket's group chooses the mailbox, falling back when it has none", async () => {
    const forGroup = await createMailbox(
      {
        name: 'Mail Team inbox',
        address: 'mailteam@example.com',
        kind: 'graph',
        groupId,
        tenantId: 't',
        clientId: 'c',
        clientSecret: 's',
        graphUserId: 'mailteam@example.com',
        imapHost: '',
        imapPort: 993,
        imapTls: true,
        smtpHost: '',
        smtpPort: 587,
        smtpTls: false,
        username: '',
        password: '',
        receiveEnabled: false,
        isActive: true,
      },
      null,
    );

    assert.equal((await mailboxFor(groupId))?.id, forGroup.id, 'its own group wins');
    assert.equal((await mailboxFor(null))?.id, mailboxId, 'otherwise the default');
  });
});

describe('notification templates', () => {
  test('every event ships with wording, and keeps it across a restart', async () => {
    for (const event of NOTIFICATION_EVENTS) {
      const row = await notificationFor(event);
      assert.ok(row, event + ' should be seeded');
      assert.ok(row.subject.length > 0 && row.body_html.length > 0);
    }

    const before = await notificationFor('ticket.resolved');
    assert.ok(before);
    await updateNotification(
      before.id,
      { subject: 'Mine', bodyHtml: '<p>My wording</p>', isEnabled: true, mailboxId: null },
      null,
    );

    // Seeding again is what start-up does on every boot.
    await seedNotifications();

    const after = await notificationFor('ticket.resolved');
    assert.equal(after?.subject, 'Mine', 'a restart must not overwrite the wording');
  });

  test('interpolated values are escaped, the template is not', async () => {
    // An administrator writes the HTML; a ticket title does not.
    const out = render('<p>Hello {{title}}</p>', {
      title: '<img src=x onerror="alert(1)">',
    });
    assert.match(out, /^<p>Hello /, 'the template keeps its markup');
    assert.doesNotMatch(out, /<img/, 'the value does not');
    assert.match(out, /&lt;img/);
  });

  test('an unknown placeholder is left visible rather than blanked', async () => {
    assert.equal(render('Hi {{nope}}', { title: 'x' }), 'Hi {{nope}}');
  });
});

describe('sending', () => {
  test('mail is queued, then sent by the flush', async () => {
    const ticket = await createTicket({
      title: 'Queued send',
      description: 'Body',
      priority: 'normal',
      category: 'other',
      requesterId: requester.user.id,
    });

    await queueMail({
      mailboxId,
      ticketId: ticket.id,
      to: 'someone@example.com',
      subject: 'Hello',
      bodyHtml: '<p>Hello</p>',
    });

    assert.equal(sent.length, 0, 'queuing must not block on the mail service');

    const result = await flushOutbox();
    assert.equal(result.sent, 1);
    assert.equal(sent[0]?.to, 'someone@example.com');
  });

  test('a failure is retried, and gives up visibly rather than silently', async () => {
    failNextSend = 'The mail service said no.';
    await queueMail({
      mailboxId,
      ticketId: null,
      to: 'someone@example.com',
      subject: 'Will fail',
      bodyHtml: '<p>x</p>',
    });

    await flushOutbox();
    const queued = (await listOutbox()).find((row) => row.subject === 'Will fail');
    assert.ok(queued);
    assert.equal(queued.status, 'queued', 'still waiting, not given up on');
    assert.equal(queued.attempts, 1);
    assert.match(queued.last_error, /said no/);

    // The next pass succeeds.
    await flushOutbox();
    const after = (await listOutbox()).find((row) => row.subject === 'Will fail');
    assert.equal(after?.status, 'sent');
  });

  test('a notification goes to the requester with the ticket filled in', async () => {
    const ticket = await createTicket({
      title: 'Printer jam',
      description: 'It is jammed.',
      priority: 'high',
      category: 'other',
      requesterId: requester.user.id,
    });

    await notify('ticket.created.requester', { ticket });
    await flushOutbox();

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, 'mail.requester@example.com');
    assert.match(
      sent[0]?.subject ?? '',
      new RegExp(ticketReference(Number(ticket.seq), ticket.ref_prefix)),
    );
    assert.match(sent[0]?.bodyHtml ?? '', /Printer jam/);
  });

  test('a disabled notification sends nothing', async () => {
    const row = await notificationFor('ticket.status.changed');
    assert.ok(row);
    await updateNotification(
      row.id,
      { subject: row.subject, bodyHtml: row.body_html, isEnabled: false, mailboxId: null },
      null,
    );

    const ticket = await createTicket({
      title: 'Quiet one',
      description: 'x',
      priority: 'normal',
      category: 'other',
      requesterId: requester.user.id,
    });
    await notify('ticket.status.changed', { ticket });
    await flushOutbox();
    assert.equal(sent.length, 0);

    await updateNotification(
      row.id,
      { subject: row.subject, bodyHtml: row.body_html, isEnabled: true, mailboxId: null },
      null,
    );
  });

  test('no mailbox means no mail, not an error', async () => {
    // A service desk that has not set mail up yet must keep working.
    const ticket = await createTicket({
      title: 'No mailbox',
      description: 'x',
      priority: 'normal',
      category: 'other',
      requesterId: requester.user.id,
      groupId: null,
    });

    const restore = setTransportFactory(() => {
      throw new Error('the transport must not even be reached');
    });
    try {
      const row = await notificationFor('ticket.assigned.technician');
      assert.ok(row);
      // Nobody is assigned, so there is no recipient.
      await notify('ticket.assigned.technician', { ticket });
    } finally {
      restore();
      setTransportFactory(() => new FakeTransport());
    }
    assert.equal(sent.length, 0);
  });
});

describe('matching a reply to its ticket', () => {
  let ticketId: string;
  let outboundId: string;

  before(async () => {
    const ticket = await createTicket({
      title: 'Threaded',
      description: 'The original request.',
      priority: 'normal',
      category: 'other',
      requesterId: requester.user.id,
      groupId,
    });
    ticketId = ticket.id;

    const queued = await queueMail({
      mailboxId,
      ticketId,
      to: 'mail.requester@example.com',
      subject: '[' + ticketReference(Number(ticket.seq)) + '] Threaded',
      bodyHtml: '<p>hello</p>',
    });
    outboundId = queued.message_id;
  });

  test('In-Reply-To is matched first, and exactly', async () => {
    const match = await matchTicket(incoming({ inReplyTo: outboundId, subject: 'Re: anything' }));
    assert.equal(match.ticket?.id, ticketId);
    assert.equal(match.via, 'in-reply-to');
  });

  test('References catches a client that drops In-Reply-To', async () => {
    const match = await matchTicket(
      incoming({ references: ['<unrelated@x>', outboundId], subject: 'Re: anything' }),
    );
    assert.equal(match.ticket?.id, ticketId);
    assert.equal(match.via, 'references');
  });

  test('the reference in the subject catches a client that strips headers', async () => {
    const ticket = await getTicketById(ticketId);
    assert.ok(ticket);
    const match = await matchTicket(
      incoming({ subject: 'Fwd: [' + ticketReference(Number(ticket.seq)) + '] Threaded' }),
    );
    assert.equal(match.ticket?.id, ticketId);
    assert.equal(match.via, 'subject');
  });

  test('a subject alone never matches', async () => {
    // "Re: printer broken" matching the last ticket of that name is how two
    // people's problems get merged into one.
    const match = await matchTicket(incoming({ subject: 'Re: Threaded' }));
    assert.equal(match.ticket, undefined);
    assert.equal(match.via, 'none');
  });

  test('a reference mentioned in passing does not match', async () => {
    const ticket = await getTicketById(ticketId);
    assert.ok(ticket);
    const match = await matchTicket(
      incoming({ subject: 'About ' + ticketReference(Number(ticket.seq)) + ' and others' }),
    );
    assert.equal(match.ticket, undefined, 'only a bracketed reference counts');
  });

  test('an unknown Message-ID matches nothing', async () => {
    const match = await matchTicket(incoming({ inReplyTo: '<never-sent@example.com>' }));
    assert.equal(match.ticket, undefined);
  });
});

describe('turning mail into tickets and comments', () => {
  test('a message from a stranger raises a ticket, and no account', async () => {
    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);

    const message = incoming({ from: 'stranger@elsewhere.test', subject: 'Help me' });
    const { outcome, ticketId } = await ingest(mailbox, message);

    assert.equal(outcome, 'ticket.created');
    assert.ok(ticketId);

    const ticket = await getTicketById(ticketId);
    assert.equal(ticket?.title, 'Help me');
    assert.equal(
      ticket?.external_email,
      'stranger@elsewhere.test',
      'so a reply has somewhere to go',
    );

    // Who may sign in stays a question for Provisioning.
    assert.equal(await findUserByEmail('stranger@elsewhere.test'), undefined);
  });

  test('the same message twice raises one ticket', async () => {
    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);
    const message = incoming({ from: 'twice@elsewhere.test', subject: 'Only once' });

    const first = await ingest(mailbox, message);
    const second = await ingest(mailbox, message);

    assert.equal(first.outcome, 'ticket.created');
    assert.equal(second.outcome, 'ignored.duplicate', 'a retried poll must not double up');
  });

  test('a reply becomes a comment on the right ticket', async () => {
    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);

    const ticket = await createTicket({
      title: 'Will be replied to',
      description: 'x',
      priority: 'normal',
      category: 'other',
      requesterId: requester.user.id,
      groupId,
    });
    const queued = await queueMail({
      mailboxId,
      ticketId: ticket.id,
      to: 'mail.requester@example.com',
      subject: 'Hello',
      bodyHtml: '<p>x</p>',
    });

    const { outcome, ticketId } = await ingest(
      mailbox,
      incoming({
        from: 'mail.requester@example.com',
        inReplyTo: queued.message_id,
        body: 'Still broken, thanks.',
      }),
    );

    assert.equal(outcome, 'comment.added');
    assert.equal(ticketId, ticket.id);
  });

  test('a mail from the mailbox to itself is dropped, not looped', async () => {
    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);
    const { outcome } = await ingest(mailbox, incoming({ from: 'help@example.com' }));
    assert.equal(outcome, 'ignored.loop');
  });

  test('an empty message is ignored', async () => {
    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);
    const { outcome } = await ingest(mailbox, incoming({ body: '   ' }));
    assert.equal(outcome, 'ignored.empty');
  });

  test('a poll reads, acts, then acknowledges', async () => {
    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);

    inbox = [
      incoming({ from: 'one@elsewhere.test', subject: 'First' }),
      incoming({ from: 'two@elsewhere.test', subject: 'Second' }),
    ];

    const result = await pollMailbox(mailbox);
    assert.equal(result.fetched, 2);
    assert.equal(result.created, 2);
    assert.equal(
      acknowledged.length,
      2,
      'acknowledged only after the ticket exists, so a crash re-reads rather than loses',
    );
  });
});

describe('reading a mail body', () => {
  test('HTML is reduced to text', async () => {
    const text = plainText('<p>Hello <b>there</b></p><p>Second</p>', 'html');
    assert.match(text, /Hello there/);
    assert.doesNotMatch(text, /<[a-z]/i);
  });

  test('a script in the body never survives', async () => {
    const text = plainText('<p>Hi</p><script>alert(1)</script>', 'html');
    assert.doesNotMatch(text, /alert/);
  });

  test('quoted history is trimmed, but never everything', async () => {
    const trimmed = trimQuotedHistory('My reply.\n\nOn Tuesday, Bob wrote:\n> old stuff');
    assert.equal(trimmed, 'My reply.');

    // A reply that is only quoted text is better kept whole than empty.
    const onlyQuote = 'On Tuesday, Bob wrote:\n> old stuff';
    assert.equal(trimQuotedHistory(onlyQuote), onlyQuote);
  });

  test('the subject is cleaned of prefixes and the reference', async () => {
    assert.equal(cleanSubject('Re: Fwd: [TKT-000123] Printer broken'), 'Printer broken');
    assert.equal(cleanSubject('   '), 'Request by email');
  });
});
