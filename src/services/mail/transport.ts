import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { settings } from '../../settings/index.js';
import { mailboxPassword, mailboxSecret, type MailboxRow } from './mailboxes.js';
import { buildMessage, sendOverSmtp } from './smtp.js';
import type { InlineImage } from './inline-images.js';
import {
  closeImap,
  markSeen,
  openImap,
  readUnread,
  type ImapConfig,
  type ImapSession,
} from './imap.js';

/**
 * Talking to a mail service.
 *
 * Two kinds behind one interface, so everything above this file - the outbox,
 * the poller, the notification code - is written once and does not know which
 * a mailbox uses.
 *
 * Both authenticate with **OAuth2 client credentials**. No password is ever
 * stored or sent, which is what lets a shared mailbox be used without anybody
 * holding its credentials.
 *
 * Neither path can be exercised without a real tenant, so the seam is here:
 * `setTransportFactory` replaces the whole thing in tests, and the code above
 * is covered by a fake that records what it was asked to send.
 */

const log = logger.child({ module: 'mail' });

export interface OutgoingMessage {
  to: string;
  subject: string;
  bodyHtml: string;
  /** RFC 5322 Message-ID we have already minted, so threading is ours. */
  messageId: string;
  /** The Message-ID this is a reply to, when it is one. */
  inReplyTo?: string;
  /**
   * Images the body points at with `cid:`, carried inside the message.
   * Resolved by the outbox at send time; see `inline-images.ts`.
   */
  inlineImages?: InlineImage[];
  /**
   * Files the reader downloads, as opposed to images the body displays.
   *
   * Only ever a ticket's own attachments, and only when somebody ticked
   * "inform the requester" on them: a notification does not carry files on
   * its own.
   */
  attachments?: MailAttachment[];
}

/** A file to send with a message. */
export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * A file that arrived on an incoming message.
 *
 * `contentType` is what the message **claimed**, and is kept only for the
 * record: what is stored is decided by `verifyType()` from the bytes, exactly
 * as it is for a file picked in the browser. Mail is the last place to trust
 * a declared type.
 */
export interface IncomingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** The Content-ID, when the body points at this with `cid:`. */
  cid: string;
  /** True for a part the body displays rather than offers as a download. */
  inline: boolean;
}

export interface IncomingMessage {
  messageId: string;
  from: string;
  fromName: string;
  subject: string;
  /** Plain text, already stripped of quoted history where possible. */
  body: string;
  /** The body before the quoted history was cut, when a transport cut it. */
  bodyFull?: string;
  inReplyTo: string;
  references: string[];
  receivedAt: string;
  /** Files the message carried. Absent and empty mean the same thing. */
  attachments?: IncomingAttachment[];
}

export interface MailTransport {
  send(message: OutgoingMessage): Promise<void>;
  /** Unread messages, oldest first. Empty when the mailbox does not receive. */
  fetch(): Promise<IncomingMessage[]>;
  /** Marks a message dealt with, so the next poll does not see it again. */
  acknowledge(messageId: string): Promise<void>;
  /**
   * Releases whatever the poll was holding.
   *
   * Optional, because a transport that opens a connection per call has
   * nothing to release. IMAP does: without this the poller would log in
   * once per message it acknowledges.
   */
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// OAuth2
// ---------------------------------------------------------------------------

interface Token {
  value: string;
  expiresAt: number;
}

const tokens = new Map<string, Token>();

/**
 * A client-credentials access token, cached until shortly before it expires.
 *
 * Cached per mailbox and scope: a token lasts about an hour, and fetching one
 * per message would triple the traffic and the failure modes.
 */
async function accessToken(mailbox: MailboxRow, scope: string): Promise<string> {
  const key = mailbox.id + '|' + scope;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const secret = mailboxSecret(mailbox);
  if (!secret) {
    throw new Error(
      'The client secret for this mailbox cannot be read. Enter it again under Settings - Mail.',
    );
  }

  const body = new URLSearchParams({
    client_id: mailbox.client_id,
    client_secret: secret,
    scope,
    grant_type: 'client_credentials',
  });

  const response = await fetch(
    'https://login.microsoftonline.com/' + encodeURIComponent(mailbox.tenant_id) + '/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    // The body carries the reason - wrong secret, missing consent - and is
    // worth keeping, but it is not secret-bearing.
    throw new Error('Token request failed (' + response.status + '): ' + (await response.text()).slice(0, 300));
  }

  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('The token response contained no access token.');

  tokens.set(key, {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

/** Forgets cached tokens for a mailbox, after its credentials change. */
export function forgetTokens(mailboxId: string): void {
  for (const key of tokens.keys()) {
    if (key.startsWith(mailboxId + '|')) tokens.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

function graphUser(mailbox: MailboxRow): string {
  return encodeURIComponent(mailbox.graph_user_id || mailbox.address);
}

class GraphTransport implements MailTransport {
  constructor(private readonly mailbox: MailboxRow) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await accessToken(this.mailbox, GRAPH_SCOPE);
    const response = await fetch(GRAPH + path, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      // Usually an Exchange application access policy that leaves this
      // address out, or a permission not granted: say so, not the raw JSON.
      if (response.status === 403 || /ErrorAccessDenied/.test(detail)) {
        throw new Error(
          'Microsoft 365 refused access to ' + this.mailbox.address + '. The app registration may not use this mailbox: ' +
            'if it is limited to some mailboxes (an application access policy), add this one to the policy\'s group; ' +
            'otherwise check that Mail.ReadWrite and Mail.Send are granted as application permissions with admin consent. ' +
            'A policy change can take up to an hour to apply.',
        );
      }
      throw new Error('Graph ' + path + ' failed (' + response.status + '): ' + detail);
    }
    return response;
  }

  async send(message: OutgoingMessage): Promise<void> {
    // As MIME (18 Oct 2026). Graph's JSON message refuses any header not
    // named x-..., so In-Reply-To failed the whole send ("InvalidInternet
    // MessageHeader"), and it mints its own Message-ID, which threading
    // cannot match. The MIME form carries both as written - the same
    // message SMTP sends. Its request is capped at about 4 MB, so a large
    // set of files goes the JSON way, without the threading headers.
    const mime = buildMessage({
      from: this.mailbox.address,
      fromName: this.mailbox.name,
      to: message.to,
      subject: message.subject,
      html: message.bodyHtml,
      messageId: message.messageId,
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      ...(message.inlineImages?.length ? { inlineImages: message.inlineImages } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    });
    const encoded = Buffer.from(mime, 'utf8').toString('base64');
    if (encoded.length < 3_500_000) {
      await this.call('/users/' + graphUser(this.mailbox) + '/sendMail', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: encoded,
      });
      return;
    }
    // Too large for MIME: our ids ride as x- headers, which Graph allows.
    const headers: { name: string; value: string }[] = [];
    if (message.inReplyTo) headers.push({ name: 'X-Helpdesk-In-Reply-To', value: message.inReplyTo });

    // An image the body points at with `cid:`. `isInline` keeps it out of the
    // attachment list a reader sees, and `contentId` is what the `cid:` in
    // the HTML resolves against.
    const attachments = [
      ...(message.inlineImages ?? []).map((image) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: image.fileName,
        contentType: image.contentType,
        contentId: image.cid,
        isInline: true,
        contentBytes: image.content.toString('base64'),
      })),
      // Not inline, and no contentId: these are meant to be listed and
      // downloaded rather than drawn in the body.
      ...(message.attachments ?? []).map((file) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: file.filename,
        contentType: file.contentType,
        isInline: false,
        contentBytes: file.content.toString('base64'),
      })),
    ];

    await this.call('/users/' + graphUser(this.mailbox) + '/sendMail', {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject: message.subject,
          body: { contentType: 'HTML', content: message.bodyHtml },
          toRecipients: [{ emailAddress: { address: message.to } }],
          ...(headers.length > 0 ? { internetMessageHeaders: headers } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        saveToSentItems: true,
      }),
    });
  }

  async fetch(): Promise<IncomingMessage[]> {
    if (!this.mailbox.receive_enabled) return [];

    const response = await this.call(
      '/users/' +
        graphUser(this.mailbox) +
        "/mailFolders/inbox/messages?$filter=isRead eq false&$top=25&$orderby=receivedDateTime asc" +
        '&$select=id,internetMessageId,subject,from,body,bodyPreview,receivedDateTime,internetMessageHeaders,hasAttachments',
    );

    const json = (await response.json()) as { value?: GraphMessage[] };
    const messages = (json.value ?? []).map((raw) => readGraphMessage(raw));

    // A second call per message that has files, because `$expand=attachments`
    // on a list returns every byte of every attachment in one response - and
    // twenty-five messages of that is a response large enough to fail.
    for (let i = 0; i < messages.length; i++) {
      // hasAttachments leaves out inline ones, so a mail whose only files are
      // pictures pasted into it says false (reported 23 Oct 2026: the
      // pictures never arrived). A body that shows a cid: picture has some.
      const raw = json.value?.[i];
      if (!raw?.hasAttachments && !/\bsrc\s*=\s*["']?cid:/i.test(raw?.body?.content ?? '')) continue;
      const message = messages[i];
      if (!message) continue;
      const attachments = await this.attachmentsOf(message.providerId);
      if (attachments.length > 0) message.attachments = attachments;
    }

    return messages;
  }

  private async attachmentsOf(messageId: string): Promise<IncomingAttachment[]> {
    const response = await this.call(
      '/users/' +
        graphUser(this.mailbox) +
        '/messages/' +
        encodeURIComponent(messageId) +
        '/attachments',
    );

    const json = (await response.json()) as { value?: GraphAttachment[] };

    return (json.value ?? [])
      // Only a fileAttachment carries bytes. An itemAttachment is a whole
      // message and a referenceAttachment is a link to OneDrive; neither can
      // be stored as a file, and both would arrive as empty content.
      .filter((raw) => raw['@odata.type'] === '#microsoft.graph.fileAttachment' && raw.contentBytes)
      .map((raw, index) => ({
        filename: raw.name || 'attachment-' + (index + 1),
        contentType: raw.contentType ?? 'application/octet-stream',
        content: Buffer.from(raw.contentBytes ?? '', 'base64'),
        // Without the angle brackets some senders keep, as the body's cid: has none.
        cid: (raw.contentId ?? '').replace(/^<|>$/g, ''),
        inline: Boolean(raw.isInline) || Boolean(raw.contentId),
      }));
  }

  async acknowledge(messageId: string): Promise<void> {
    // Graph's own id, not the RFC Message-ID: the caller passes back what
    // readGraphMessage put in `providerId`.
    await this.call('/users/' + graphUser(this.mailbox) + '/messages/' + encodeURIComponent(messageId), {
      method: 'PATCH',
      body: JSON.stringify({ isRead: true }),
    });
  }
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  body?: { content?: string; contentType?: string };
  bodyPreview?: string;
  receivedDateTime?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  hasAttachments?: boolean;
}

interface GraphAttachment {
  '@odata.type'?: string;
  name?: string;
  contentType?: string;
  contentId?: string;
  isInline?: boolean;
  /** Base64. Present on a fileAttachment and nothing else. */
  contentBytes?: string;
}

/** A Graph message in the shape the rest of the code understands. */
function readGraphMessage(raw: GraphMessage): IncomingMessage & { providerId: string } {
  const header = (name: string): string =>
    raw.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? '';

  return {
    providerId: raw.id,
    messageId: raw.internetMessageId ?? raw.id,
    from: raw.from?.emailAddress?.address ?? '',
    fromName: raw.from?.emailAddress?.name ?? '',
    subject: raw.subject ?? '',
    body: plainText(raw.body?.content ?? raw.bodyPreview ?? '', raw.body?.contentType),
    // The whole of it, quoted history too: a picture whose place is only in
    // the history that was cut belongs to an earlier message.
    bodyFull: plainText(raw.body?.content ?? raw.bodyPreview ?? '', raw.body?.contentType, false),
    inReplyTo: header('in-reply-to'),
    references: header('references').split(/\s+/).filter(Boolean),
    receivedAt: raw.receivedDateTime ?? new Date().toISOString(),
  };
}

/**
 * The readable part of a mail body.
 *
 * HTML is reduced to text rather than stored as markup: a ticket comment is
 * plain text everywhere else in this application, and storing a stranger's
 * HTML would mean rendering it somewhere eventually.
 */
export function plainText(content: string, contentType?: string, cutQuoted = quotedCutOn()): string {
  let text = content;
  if ((contentType ?? '').toLowerCase() === 'html' || /<[a-z][\s\S]*>/i.test(content)) {
    const html = cutQuoted ? cutQuotedHtml(content) : content;
    // Nothing above the quote - a forward with no words - keeps it all.
    text = (/\S/.test(html.replace(/<[^>]+>|&nbsp;/g, '')) ? html : content)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      // Every block ends a line: Outlook writes a reply as <div>s, and
      // without this "Okay, I will" and the quoted "From:" ran together.
      .replace(/<\/(div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
      .replace(/<hr[^>]*>/gi, '\n_____\n')
      // A picture pasted into the mail keeps its place, as the [cid:...]
      // Outlook writes in a text part; inbound-attachments.ts turns it into
      // [image: name] once the file is known (asked for 22 Oct 2026).
      .replace(/<img\b[^>]*?\bsrc\s*=\s*["']?cid:([^"'\s>]+)[^>]*>/gi, '\n[cid:$1]\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  // The quoted conversation is cut in inbound.ts (quotedCut), for every
  // kind of mailbox alike.
  return text.trim().slice(0, 20_000);
}

/**
 * Where the quoted conversation starts in a reply's HTML: the containers
 * mail clients wrap it in. Cut here, before the HTML becomes text, the cut
 * does not depend on how the text happened to wrap.
 */
const QUOTE_CONTAINERS = [
  /<div[^>]*id=["']?divRplyFwdMsg/i, // Outlook, Outlook on the web
  /<div[^>]*id=["']?appendonsend/i, // Outlook on the web
  /<div[^>]*class=["'][^"']*gmail_quote/i, // Gmail
  /<div[^>]*class=["'][^"']*moz-cite-prefix/i, // Thunderbird
  /<div[^>]*id=["']?mail-editor-reference-message-container/i, // Outlook for Mac
  /<blockquote[^>]*type=["']?cite/i, // Apple Mail and others
  /<hr[^>]*id=["']?stopSpelling/i, // older Outlook
];

export function cutQuotedHtml(html: string): string {
  let cut = html.length;
  for (const marker of QUOTE_CONTAINERS) {
    const found = marker.exec(html);
    if (found && found.index < cut) cut = found.index;
  }
  return html.slice(0, cut);
}

/**
 * Drops the quoted thread below a reply.
 *
 * Every mail client marks it differently, so this is a best effort on the
 * three common shapes. Getting it wrong only means a longer comment, never a
 * lost one, so it cuts conservatively.
 */
export function trimQuotedHistory(text: string): string {
  const markers = [
    /^\s*-{2,}\s*(Original Message|Původní zpráva|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}\s*$/im,
    /^\s*(On|Dne|Am|Le|El|Il) .+ (wrote|napsal\(a\)|napsal|napsala|schrieb|a écrit|escribió|ha scritto):\s*$/im,
    // The header block Outlook puts above the quote, in the languages it is
    // most often set to here.
    /^\s*(From|Od|Von|De|Da):\s.+$/im,
    /^\s*_{5,}\s*$/m,
    // Plain-text quoting: two or more lines in a row starting with ">".
    /^>.*\n>/m,
  ];

  let cut = text.length;
  for (const marker of markers) {
    const found = marker.exec(text);
    if (found && found.index < cut) cut = found.index;
  }
  // Never cut everything: a reply that is only quoted text is better kept
  // whole than delivered empty.
  const trimmed = text.slice(0, cut).trim();
  return trimmed.length > 0 ? trimmed : text;
}

// ---------------------------------------------------------------------------
// IMAP and SMTP
// ---------------------------------------------------------------------------

/**
 * The open-protocol transport.
 *
 * **Sending works**: `smtp.ts` speaks SMTP directly, with no dependency -
 * sending one message is a dozen commands, and a client library would be
 * thousands of lines of someone else's code in a project whose short
 * dependency list is its main defence.
 *
 * **Reading does not yet.** IMAP is a far larger protocol than SMTP and the
 * messages it returns are MIME, which needs a real parser; hand-rolling both
 * would be a liability rather than a saving. So it says so plainly instead of
 * failing in a way that looks like a configuration mistake.
 */
class ImapSmtpTransport implements MailTransport {
  constructor(private readonly mailbox: MailboxRow) {}

  async send(message: OutgoingMessage): Promise<void> {
    const password = mailboxPassword(this.mailbox);
    if (!this.mailbox.smtp_host) {
      throw new Error('This mailbox has no SMTP host set.');
    }
    if (!password) {
      throw new Error(
        'The password for this mailbox cannot be read. Enter it again under Settings - Mail.',
      );
    }

    await sendOverSmtp(
      {
        host: this.mailbox.smtp_host,
        port: this.mailbox.smtp_port,
        implicitTls: this.mailbox.smtp_tls,
        username: this.mailbox.username,
        password,
      },
      {
        from: this.mailbox.address,
        fromName: this.mailbox.name,
        to: message.to,
        subject: message.subject,
        html: message.bodyHtml,
        messageId: message.messageId,
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
        ...(message.inlineImages?.length ? { inlineImages: message.inlineImages } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      },
    );
  }

  /** The IMAP settings, or undefined when this mailbox cannot read. */
  private imapConfig(): ImapConfig | undefined {
    const password = mailboxPassword(this.mailbox);
    if (!this.mailbox.imap_host || !password) return undefined;
    return {
      host: this.mailbox.imap_host,
      port: this.mailbox.imap_port,
      implicitTls: this.mailbox.imap_tls,
      username: this.mailbox.username,
      password,
    };
  }

  async fetch(): Promise<IncomingMessage[]> {
    if (!this.mailbox.receive_enabled) return [];

    const config = this.imapConfig();
    if (!config) {
      throw new Error(
        'This mailbox is set to read, but has no IMAP host or no readable password. ' +
          'Fill those in under Settings - Mail, or clear "Read replies from this mailbox".',
      );
    }

    // One connection for the whole poll, released by dispose().
    this.session = await openImap(config);
    return readUnread(this.session);
  }

  async acknowledge(uid: string): Promise<void> {
    if (this.session) await markSeen(this.session, uid);
  }

  async dispose(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await closeImap(session);
  }

  private session: ImapSession | undefined;
}

// ---------------------------------------------------------------------------
// Choosing one
// ---------------------------------------------------------------------------

export type TransportFactory = (mailbox: MailboxRow) => MailTransport;

/**
 * The SMTP relay (services/mail/relay.ts), dressed as a mailbox so the
 * outbox, and the fake transport in tests, need no second path. Send only.
 */
class RelayTransport implements MailTransport {
  constructor(private readonly relay: MailboxRow & { smtp_plain?: boolean }) {}

  async send(message: OutgoingMessage): Promise<void> {
    const password = this.relay.username ? mailboxPassword(this.relay) : '';
    if (this.relay.username && !password) {
      throw new Error('The SMTP relay password cannot be read. Enter it again under Settings - Mail - SMTP relay.');
    }
    await sendOverSmtp(
      {
        host: this.relay.smtp_host,
        port: this.relay.smtp_port,
        implicitTls: this.relay.smtp_tls,
        plain: this.relay.smtp_plain === true,
        username: this.relay.username,
        password,
      },
      {
        from: this.relay.address,
        fromName: this.relay.name,
        to: message.to,
        subject: message.subject,
        html: message.bodyHtml,
        messageId: message.messageId,
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
        ...(message.inlineImages?.length ? { inlineImages: message.inlineImages } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      },
    );
  }

  async fetch(): Promise<IncomingMessage[]> {
    return [];
  }

  async acknowledge(): Promise<void> {
    // Nothing is ever read through the relay.
  }
}

let factory: TransportFactory = (mailbox) =>
  (mailbox.kind as string) === 'relay'
    ? new RelayTransport(mailbox)
    : mailbox.kind === 'graph'
      ? new GraphTransport(mailbox)
      : new ImapSmtpTransport(mailbox);

/**
 * Replaces the transport, for tests.
 *
 * Neither real transport can be reached from a test run, so everything above
 * this file is tested against a fake that records what it was asked to send.
 */
export function setTransportFactory(next: TransportFactory): () => void {
  const previous = factory;
  factory = next;
  return () => {
    factory = previous;
  };
}

export function transportFor(mailbox: MailboxRow): MailTransport {
  return factory(mailbox);
}

/** A Message-ID we mint, so a reply can be matched back to its ticket. */
export function newMessageId(): string {
  const host = new URL(config.publicOrigin).hostname;
  return (
    '<' +
    Date.now().toString(36) +
    '.' +
    Math.random().toString(36).slice(2, 12) +
    '@' +
    host +
    '>'
  );
}

export { log as mailLog };

/** Whether the quoted conversation below a reply is cut (Settings - Mail - Advanced - Signature stripping). */
function quotedCutOn(): boolean {
  return settings().automation.trimQuoted !== false;
}
