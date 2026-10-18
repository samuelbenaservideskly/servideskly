import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { IncomingAttachment, IncomingMessage } from './transport.js';

/**
 * Reading mail over IMAP.
 *
 * Unlike SMTP, this is not hand-rolled. IMAP is a large protocol and the
 * messages it returns are MIME - nested parts, a transfer encoding and a
 * charset per part, and headers that may be RFC 2047 words. Writing both by
 * hand would be more code than the rest of the mail feature put together, and
 * the failure mode of getting MIME subtly wrong is a quietly corrupted ticket
 * rather than a loud error.
 *
 * So two dependencies, chosen for being the ones everybody uses: `imapflow`
 * for the protocol and `mailparser` for the message.
 *
 * One connection per **poll**, not per message: the poller reads, acts on each
 * message, then acknowledges it, and a connection per acknowledgement would
 * mean twenty-five logins to read twenty-five messages.
 */

export interface ImapConfig {
  host: string;
  port: number;
  /** True for implicit TLS (993); false to connect plain and STARTTLS (143). */
  implicitTls: boolean;
  username: string;
  password: string;
}

/** An open connection with INBOX selected, held for one poll. */
export interface ImapSession {
  client: ImapFlow;
  release: () => void;
}

/** Batched, so a mailbox left unread for a week does not arrive all at once. */
const PER_POLL = 25;

/**
 * An IMAP message carries a UID, which is what marks it read later. The RFC
 * Message-ID is what threading uses. The two are not interchangeable, so both
 * travel together.
 */
export interface ImapMessage extends IncomingMessage {
  providerId: string;
}

export async function openImap(config: ImapConfig): Promise<ImapSession> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.implicitTls,
    auth: { user: config.username, pass: config.password },
    // Otherwise the library logs every command at info level, which would put
    // mail bodies in the application log.
    logger: false,
    // A server that accepts the connection and then stalls must not hold the
    // poll open for ever.
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  return { client, release: () => lock.release() };
}

export async function closeImap(session: ImapSession): Promise<void> {
  try {
    session.release();
  } catch {
    // Already released, which is fine - this runs in a finally.
  }
  await session.client.logout().catch(() => {
    // The messages are already in hand; failing to say goodbye politely is
    // not worth failing the poll over.
  });
}

/**
 * The unread messages in the inbox, oldest first.
 *
 * Nothing is marked read here. A message is acknowledged only once its ticket
 * or comment exists, so a crash between reading and storing means it is read
 * again rather than lost.
 */
export async function readUnread(session: ImapSession): Promise<ImapMessage[]> {
  const messages: ImapMessage[] = [];

  for await (const message of session.client.fetch(
    { seen: false },
    { uid: true, source: true, envelope: true },
  )) {
    if (messages.length >= PER_POLL) break;
    if (!message.source) continue;

    // mailparser handles the whole of MIME: nested parts, transfer encodings,
    // and RFC 2047 words in the headers. `text` comes back already decoded
    // from whatever charset the part declared, which is what makes a Czech
    // reply arrive as Czech.
    const parsed = await simpleParser(message.source);

    const from = parsed.from?.value?.[0];
    const references = Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : [];

    // mailparser has already decoded each part from base64 or
    // quoted-printable, so `content` is the file itself.
    const attachments: IncomingAttachment[] = (parsed.attachments ?? []).map((part, index) => ({
      filename: part.filename ?? extensionlessName(part.contentType, index),
      contentType: part.contentType ?? 'application/octet-stream',
      content: Buffer.from(part.content),
      cid: part.cid ?? '',
      inline: part.contentDisposition === 'inline' || Boolean(part.cid),
    }));

    messages.push({
      ...(attachments.length > 0 ? { attachments } : {}),
      providerId: String(message.uid),
      // A message with no Message-ID is malformed, but they exist. One built
      // from the UID keeps de-duplication working; it simply cannot be
      // threaded against.
      messageId: parsed.messageId ?? '<uid-' + message.uid + '@imap.local>',
      from: from?.address ?? '',
      fromName: from?.name ?? '',
      subject: parsed.subject ?? '',
      body: (parsed.text ?? parsed.html ?? '').toString(),
      inReplyTo: parsed.inReplyTo ?? '',
      references,
      receivedAt: (parsed.date ?? new Date()).toISOString(),
    });
  }

  return messages;
}

/**
 * A name for a part that arrived without one.
 *
 * An image pasted into Outlook often has a Content-ID and no filename, and
 * the store decides a file's type from its extension - so a part with no name
 * would be refused for having none. The declared subtype supplies one; if it
 * is wrong, `verifyType()` still catches it from the bytes.
 */
function extensionlessName(contentType: string | undefined, index: number): string {
  const subtype = (contentType ?? '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/g, '');
  return 'attachment-' + (index + 1) + (extension ? '.' + extension : '');
}

/** Marks one message read, so the next poll does not see it again. */
export async function markSeen(session: ImapSession, uid: string): Promise<void> {
  await session.client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
}
