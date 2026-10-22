import { execute, queryOne } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import {
  newId,
  normaliseEmail,
  normaliseLine,
  nowIso,
  ticketReference,
} from '../../lib/util.js';
import { findUserByEmail, isStaff } from '../users.js';
import { addComment, createTicket, getTicketById, type TicketRow } from '../tickets.js';
import {
  listActiveMailboxes,
  recordMailboxResult,
  type MailboxRow,
} from './mailboxes.js';
import { notify } from './outbox.js';
import { placeInlineImages, skippedNote, storeIncomingAttachments } from './inbound-attachments.js';
import { stripSignature } from './signatures.js';
import { trimQuotedHistory } from './transport.js';
import { firstMatchingRule, raiseFromRule, repeatOf } from './rules.js';
import { settings } from '../../settings/index.js';
import {
  mailLog,
  transportFor,
  type IncomingAttachment,
  type IncomingMessage,
} from './transport.js';

/**
 * Mail coming in.
 *
 * Two jobs: decide which ticket a message belongs to, and turn it into a
 * ticket or a comment. The first is the one that has to be right - a reply
 * that starts a second ticket is worse than no email integration at all,
 * because now the conversation is split and nobody notices.
 */

// ---------------------------------------------------------------------------
// Matching a message to a ticket
// ---------------------------------------------------------------------------

/**
 * The reference as it appears in a subject: `[INC-000123]`, `[TKT-000123]`.
 *
 * **Any** prefix, not the configured ones. The number is the identity - it is
 * the `seq` column - and the prefix is only how it reads, so matching on the
 * shape finds the ticket whatever it was raised as. That also means a
 * reference from before a prefix was changed, or from before they were
 * configurable at all, still threads.
 *
 * Anchored to the brackets, so a sentence mentioning a reference in passing
 * cannot attach a message to that ticket.
 */
const SUBJECT_REFERENCE = /\[\s*([A-Za-z]{1,8})-(\d{6,})\s*\]/;

export interface MatchResult {
  ticket: TicketRow | undefined;
  /** How it was found, for the audit trail and for diagnosing a mismatch. */
  /** 'repeat': a mail automation rule found the same request, from the same sender, still open. */
  via: 'in-reply-to' | 'references' | 'subject' | 'repeat' | 'none';
}

/**
 * Which ticket an incoming message belongs to.
 *
 * Three ways, tried strongest first:
 *
 * 1. **In-Reply-To** against the Message-IDs we have sent. This is the RFC
 *    5322 answer and is exact: the id was minted by us and quoted back.
 * 2. **References**, which carries the whole chain. A client that drops
 *    In-Reply-To usually keeps this, and a forward-then-reply still names an
 *    id we know.
 * 3. **The reference in the subject**, for clients that strip headers and for
 *    people who start a fresh mail quoting the reference.
 *
 * Subject text alone is never used. "Re: printer broken" matching the last
 * ticket called that is exactly the kind of guess that merges two people's
 * problems into one.
 */
export async function matchTicket(message: IncomingMessage): Promise<MatchResult> {
  const byId = async (messageId: string): Promise<TicketRow | undefined> => {
    const row = await queryOne<{ ticket_id: string }>(
      'SELECT ticket_id FROM mail_threads WHERE message_id = ?',
      [messageId],
    );
    return row ? await getTicketById(row.ticket_id) : undefined;
  };

  if (message.inReplyTo) {
    const found = await byId(message.inReplyTo.trim());
    if (found) return { ticket: found, via: 'in-reply-to' };
  }

  // Newest first: the chain runs oldest to newest, and the most recent
  // message we sent is the most likely to be the one being answered.
  for (const reference of [...message.references].reverse()) {
    const found = await byId(reference.trim());
    if (found) return { ticket: found, via: 'references' };
  }

  const inSubject = SUBJECT_REFERENCE.exec(message.subject);
  if (inSubject?.[1] && inSubject[2]) {
    const prefix = inSubject[1];
    const number = Number.parseInt(inSubject[2], 10);

    if (Number.isFinite(number) && number > 0) {
      // Prefix **and** number: since each kind counts on its own,
      // INC-000001 and SR-000001 are two different tickets and the number
      // alone would match whichever was found first.
      let row = await queryOne<{ id: string }>(
        'SELECT id FROM tickets WHERE lower(ref_prefix) = lower(?) AND ref_seq = ?',
        [prefix, number],
      );

      // A reference issued before the counters were split, when every number
      // was the global `seq`. Still in inboxes, so still matched.
      if (!row) {
        row = await queryOne<{ id: string }>('SELECT id FROM tickets WHERE seq = ?', [number]);
      }

      if (row) {
        const ticket = await getTicketById(row.id);
        if (ticket) return { ticket, via: 'subject' };
      }
    }
  }

  return { ticket: undefined, via: 'none' };
}

/** The subject with any reference and Re:/Fwd: prefixes removed. */
export function cleanSubject(subject: string): string {
  return (
    normaliseLine(
      subject
        .replace(SUBJECT_REFERENCE, '')
        .replace(/^\s*(re|fw|fwd|aw|sv)\s*:\s*/gi, '')
        .replace(/^\s*(re|fw|fwd|aw|sv)\s*:\s*/gi, ''),
    ) || 'Request by email'
  );
}

// ---------------------------------------------------------------------------
// Turning one message into a ticket or a comment
// ---------------------------------------------------------------------------

export type Outcome =
  | 'ticket.created'
  | 'comment.added'
  | 'ignored.duplicate'
  | 'ignored.empty'
  | 'ignored.loop'
  /** The sender has no account, and the mailbox only accepts people who do. */
  | 'ignored.stranger';

/**
 * Whether this message has already been dealt with.
 *
 * A poll that is retried, or a restart partway through one, must not raise
 * the ticket twice. The Message-ID is the natural key: it is globally unique
 * by definition and the same on every delivery of the same message.
 */
async function alreadySeen(messageId: string): Promise<boolean> {
  const row = await queryOne<{ message_id: string }>(
    'SELECT message_id FROM mail_seen WHERE message_id = ?',
    [messageId],
  );
  return row !== undefined;
}

async function remember(
  messageId: string,
  mailboxId: string,
  ticketId: string | null,
  outcome: Outcome,
): Promise<void> {
  await execute(
    `INSERT INTO mail_seen (message_id, mailbox_id, ticket_id, outcome, received_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, mailboxId, ticketId, outcome, nowIso()],
  );
}

/**
 * Handles one message.
 *
 * Returns what it did, which the poller records and the settings page shows -
 * "ignored" is a legitimate outcome and should be visible, not silent.
 */
export async function ingest(
  mailbox: MailboxRow,
  message: IncomingMessage,
): Promise<{ outcome: Outcome; ticketId: string | null }> {
  if (await alreadySeen(message.messageId)) {
    return { outcome: 'ignored.duplicate', ticketId: null };
  }

  const from = normaliseEmail(message.from);

  // A mailbox that answers itself, or an auto-reply from another system, can
  // loop forever. One check, at the only place a loop can start.
  if (!from || from === normaliseEmail(mailbox.address)) {
    await remember(message.messageId, mailbox.id, null, 'ignored.loop');
    return { outcome: 'ignored.loop', ticketId: null };
  }

  const attachments = message.attachments ?? [];

  // Cut before the empty check, so a mail that is nothing but a signature is
  // treated as the empty message it really is.
  // The quoted conversation first, then the signature: IMAP and Graph alike.
  const unquoted = settings().automation.trimQuoted !== false ? trimQuotedHistory(message.body) : message.body;
  // A picture pasted into the mail keeps its place as [image: name] (inbound-attachments.ts).
  const written = placeInlineImages(stripSignature(unquoted).trim(), message.body, attachments);

  // "Here you go" with the screenshot and nothing else is a real message, and
  // dropping it as empty threw away the only thing it carried. Empty now
  // means empty: no words **and** no files.
  const body = written || (attachments.length > 0 ? '(no message text)' : '');
  if (!body) {
    await remember(message.messageId, mailbox.id, null, 'ignored.empty');
    return { outcome: 'ignored.empty', ticketId: null };
  }

  const sender = await findUserByEmail(from);
  const match = await matchTicket(message);

  // Mail automation: the first rule this message meets, if any. Looked up
  // only when the message is not a reply to a ticket already.
  const ruled = match.ticket ? undefined : await firstMatchingRule(message);
  // ... and the same request again from the same sender is the same ticket.
  if (!match.ticket && ruled) {
    const repeat = await repeatOf(ruled.rule, cleanSubject(message.subject), from, sender?.id ?? null);
    if (repeat) {
      const ticket = await getTicketById(repeat.id);
      if (ticket) {
        match.ticket = ticket;
        match.via = 'repeat';
      }
    }
  }

  if (match.ticket) {
    // A reply from the service desk's own people is a technician's note; from
    // anybody else it is the requester adding to their request.
    const fromStaff = sender !== undefined && isStaff(sender.role);

    // From somebody who is not on the ticket (security review, 21 Oct 2026):
    // a reference in a subject is easy to guess, so anybody could otherwise
    // add to any ticket in the requester's name and reopen it. It becomes an
    // internal note saying who sent it - no reopening, nobody emailed - and
    // a technician decides what it is.
    const t = match.ticket;
    const onTicket =
      fromStaff ||
      (sender !== undefined && [t.requester_id, t.raised_by, t.assignee_id].includes(sender.id)) ||
      (!!t.external_email && t.external_email.toLowerCase() === from.toLowerCase());
    if (!onTicket) {
      const noteAuthor = sender?.id ?? (await systemRequesterId());
      await addComment({
        ticketId: t.id,
        authorId: noteAuthor,
        body: 'Email from ' + from + ', who is not on this ticket:\n\n' + body,
        isInternal: true,
      });
      if (attachments.length > 0) {
        try {
          const result = await storeIncomingAttachments(t.id, noteAuthor, attachments, { isInternal: true });
          const note = skippedNote(result.skipped);
          if (note) await addComment({ ticketId: t.id, authorId: noteAuthor, body: note, isInternal: true });
        } catch (err) {
          mailLog.warn({ err, ticketId: t.id }, 'could not store the files on an incoming message');
        }
      }
      await remember(message.messageId, mailbox.id, t.id, 'comment.added');
      audit({
        action: 'mail.comment.not_on_ticket',
        actorId: sender?.id ?? null,
        actorEmail: from,
        targetType: 'ticket',
        targetId: t.id,
        detail: { via: match.via, reference: ticketReference(Number(t.ref_seq), t.ref_prefix) },
      });
      return { outcome: 'comment.added', ticketId: t.id };
    }

    const author = sender?.id ?? match.ticket.requester_id;

    // A reply to a finished ticket is somebody saying it is not finished.
    // Reopened **before** the comment is added, so the ticket the comment
    // lands on is already open and the event order reads correctly.
    if (!fromStaff) await reopenIfReplied(match.ticket);

    await addComment({
      ticketId: match.ticket.id,
      authorId: author,
      body,
      // A mailed reply is always visible: it came from outside, so treating
      // it as an internal note would hide the requester's own words.
      isInternal: false,
    });

    await keepFiles(match.ticket.id, author, attachments);

    await execute(
      `INSERT INTO mail_threads (message_id, ticket_id, direction, created_at)
       VALUES (?, ?, 'in', ?) ON CONFLICT (message_id) DO NOTHING`,
      [message.messageId, match.ticket.id, nowIso()],
    );
    await remember(message.messageId, mailbox.id, match.ticket.id, 'comment.added');

    audit({
      action: 'mail.comment.added',
      actorId: sender?.id ?? null,
      actorEmail: from,
      targetType: 'ticket',
      targetId: match.ticket.id,
      detail: { via: match.via, reference: ticketReference(Number(match.ticket.ref_seq), match.ticket.ref_prefix) },
    });

    // Tell the other side. A technician's reply notifies the requester; a
    // requester's reply notifies the group.
    await notify(
      fromStaff ? 'comment.added.requester' : 'comment.added.technician',
      {
        ticket: match.ticket,
        comment: body,
        authorName: sender?.display_name ?? message.fromName ?? from,
      },
    );

    return { outcome: 'comment.added', ticketId: match.ticket.id };
  }

  // Nothing matched, so this would be a new request - and a service desk may
  // choose not to take one from an address it does not know. Only *new*
  // requests: a reply that matched a ticket above is already part of a
  // conversation somebody here started, whoever sent it.
  if (!sender && settings().automation.knownSendersOnly) {
    await remember(message.messageId, mailbox.id, null, 'ignored.stranger');
    audit({
      action: 'mail.ignored.stranger',
      actorId: null,
      actorEmail: from,
      targetType: 'mailbox',
      targetId: mailbox.id,
      detail: { subject: cleanSubject(message.subject) },
    });
    return { outcome: 'ignored.stranger', ticketId: null };
  }

  // An unknown sender gets a ticket but **no account**: who may sign in stays
  // a question for Provisioning, and a mailbox anyone can write to must not
  // be a way in.
  const requesterId = sender?.id ?? (await systemRequesterId());
  const ticket = ruled
    ? await raiseFromRule(ruled.template, {
        title: cleanSubject(message.subject),
        description: body,
        requesterId,
        externalEmail: sender ? '' : from,
        fallbackGroupId: mailbox.group_id,
      })
    : await createTicket({
        title: cleanSubject(message.subject),
        description: body,
        priority: 'normal',
        category: 'other',
        requesterId,
        externalEmail: sender ? '' : from,
        groupId: mailbox.group_id,
      });

  await keepFiles(ticket.id, ticket.requester_id, attachments);

  await execute(
    `INSERT INTO mail_threads (message_id, ticket_id, direction, created_at)
     VALUES (?, ?, 'in', ?) ON CONFLICT (message_id) DO NOTHING`,
    [message.messageId, ticket.id, nowIso()],
  );
  await remember(message.messageId, mailbox.id, ticket.id, 'ticket.created');

  audit({
    action: 'mail.ticket.created',
    actorId: sender?.id ?? null,
    actorEmail: from,
    targetType: 'ticket',
    targetId: ticket.id,
    detail: {
      mailbox: mailbox.address,
      knownSender: sender !== undefined,
      ...(ruled ? { rule: ruled.rule.name, template: ruled.template.name } : {}),
    },
  });

  await notify('ticket.created.requester', { ticket });
  await notify('ticket.created.group', { ticket });

  return { outcome: 'ticket.created', ticketId: ticket.id };
}

/**
 * Reopens a finished ticket that its requester has replied to.
 *
 * Only for a reply from outside the service desk: a technician answering a
 * closed ticket is tidying up, not reporting that it is still broken.
 *
 * The window exists because a reply three months later is usually a new
 * problem that happens to quote an old thread - reopening then buries a
 * current ticket under an answer to something else. Zero means no limit.
 */
async function reopenIfReplied(ticket: TicketRow): Promise<void> {
  const rules = settings().automation;
  if (!rules.reopenOnReply) return;
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') return;

  if (rules.reopenWithinDays > 0) {
    const since = Date.now() - Date.parse(ticket.closed_at ?? ticket.updated_at);
    if (since > rules.reopenWithinDays * 24 * 60 * 60 * 1000) return;
  }

  await execute("UPDATE tickets SET status = 'open', closed_at = NULL, updated_at = ? WHERE id = ?", [
    nowIso(),
    ticket.id,
  ]);

  audit({
    action: 'ticket.reopened.by_reply',
    actorId: null,
    actorEmail: '',
    targetType: 'ticket',
    targetId: ticket.id,
    detail: { from: ticket.status },
  });
}

/**
 * Stores what the email carried, and says what it could not.
 *
 * The refusals go in an **internal note**: a technician reading a ticket that
 * says "see the attached screenshot" needs to know why there is no
 * screenshot, and the requester does not need to read about type rules. It is
 * authored by the same person as the message for want of a system account,
 * which is also what makes it a note rather than a reply.
 *
 * Nothing in here may cost the ticket. A mailbox misconfigured for
 * attachments must not turn a request into a message that vanished.
 */
async function keepFiles(
  ticketId: string,
  authorId: string,
  attachments: IncomingAttachment[],
): Promise<void> {
  if (attachments.length === 0) return;

  try {
    const result = await storeIncomingAttachments(ticketId, authorId, attachments);
    const note = skippedNote(result.skipped);
    if (note) {
      await addComment({ ticketId, authorId, body: note, isInternal: true });
    }
  } catch (err) {
    mailLog.warn({ err, ticketId }, 'could not store the files on an incoming message');
  }
}

/**
 * The account a ticket from a stranger is filed against.
 *
 * Tickets reference a requester with ON DELETE RESTRICT and the column is not
 * nullable, so mail from somebody with no account still needs *an* account to
 * hang off. One hidden, disabled row carries them all, and `external_email`
 * on the ticket records who it was really from.
 */
const SYSTEM_EMAIL = 'mail-sender@localhost.invalid';

export async function systemRequesterId(): Promise<string> {
  const existing = await findUserByEmail(SYSTEM_EMAIL);
  if (existing) return existing.id;

  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO users
       (id, issuer, external_id, email, upn, display_name, role, role_locked, status,
        source, directory_present, created_at, updated_at)
     VALUES (?, 'urn:helpdesk:mail', NULL, ?, NULL, 'Email (no account)', 'user', 1,
             'disabled', 'manual', 0, ?, ?)`,
    [id, SYSTEM_EMAIL, now, now],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface PollResult {
  mailbox: string;
  fetched: number;
  created: number;
  comments: number;
  ignored: number;
  error: string;
}

/** Reads one mailbox and deals with everything in it. */
export async function pollMailbox(mailbox: MailboxRow): Promise<PollResult> {
  const result: PollResult = {
    mailbox: mailbox.address,
    fetched: 0,
    created: 0,
    comments: 0,
    ignored: 0,
    error: '',
  };

  if (!mailbox.receive_enabled) return result;

  const transport = transportFor(mailbox);
  let messages: IncomingMessage[] = [];

  try {
    try {
      messages = await transport.fetch();
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Reading the mailbox failed.';
      await recordMailboxResult(mailbox.id, result.error, true);
      return result;
    }

    result.fetched = messages.length;

    for (const message of messages) {
      try {
        const { outcome } = await ingest(mailbox, message);
        if (outcome === 'ticket.created') result.created++;
        else if (outcome === 'comment.added') result.comments++;
        else result.ignored++;

        // Acknowledged only after it is safely a ticket or a comment, so a
        // crash mid-message means it is read again rather than lost.
        const providerId = (message as IncomingMessage & { providerId?: string }).providerId;
        await transport.acknowledge(providerId ?? message.messageId);
      } catch (err) {
        result.error = err instanceof Error ? err.message : 'Handling a message failed.';
        mailLog.error({ err, mailbox: mailbox.address }, 'could not handle an incoming message');
        break;
      }
    }
  } finally {
    // IMAP holds a connection open across the whole poll, so it has to be
    // let go however the poll ended.
    await transport.dispose?.().catch((err: unknown) => {
      mailLog.warn({ err, mailbox: mailbox.address }, 'could not close the mailbox connection');
    });
  }

  await recordMailboxResult(mailbox.id, result.error, true);
  return result;
}

/** Reads every mailbox that is set up to receive. */
export async function pollAllMailboxes(): Promise<PollResult[]> {
  const mailboxes = (await listActiveMailboxes()).filter((mailbox) => mailbox.receive_enabled);
  const results: PollResult[] = [];
  for (const mailbox of mailboxes) results.push(await pollMailbox(mailbox));
  return results;
}
