import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { InlineImage } from './inline-images.js';
import type { MailAttachment } from './transport.js';

/**
 * Sending mail over SMTP.
 *
 * Written against the protocol rather than pulled in as a dependency. SMTP is
 * a line-oriented conversation and sending one message is a dozen commands;
 * a client library would be several thousand lines of someone else's code in
 * a project whose short dependency list is its main defence.
 *
 * It covers what a service desk needs and no more: one recipient, an HTML
 * body, images the body points at with `cid:`, implicit TLS or STARTTLS, and
 * AUTH LOGIN or PLAIN. It does **not** cover files a reader downloads,
 * multiple recipients or delivery-status notifications. If those are wanted,
 * this is the place to decide a library is worth it.
 *
 * Every read has a timeout. A mail server that accepts the connection and
 * then says nothing would otherwise hold the send queue open forever.
 */

const TIMEOUT = 30_000;

export interface SmtpConfig {
  host: string;
  port: number;
  /** True for implicit TLS (465); false to connect plain and STARTTLS (587). */
  implicitTls: boolean;
  /**
   * No TLS at all: an internal relay on port 25 that offers none. Only ever
   * without a password - a credential is never sent in the clear.
   */
  plain?: boolean;
  username: string;
  password: string;
}

export interface SmtpMessage {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  html: string;
  messageId: string;
  inReplyTo?: string;
  /** Images the HTML references as `cid:<id>`, carried with the message. */
  inlineImages?: InlineImage[];
  /** Files sent alongside the body, for the reader to download. */
  attachments?: MailAttachment[];
}

/** One SMTP reply: the code, and everything the server said with it. */
interface Reply {
  code: number;
  text: string;
}

/**
 * A conversation with one server.
 *
 * Holds the socket and a buffer, because SMTP replies arrive in whatever
 * chunks TCP feels like and a multi-line reply is only finished when a line
 * has a space rather than a hyphen after its code.
 */
class Session {
  private socket: Socket | TLSSocket;
  private buffer = '';
  private waiting: ((reply: Reply) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.listen();
  }

  private listen(): void {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    this.socket.on('error', (error: Error) => this.failed?.(error));
    this.socket.on('close', () => {
      this.failed?.(new Error('The mail server closed the connection unexpectedly.'));
    });
  }

  /** Emits a reply once a complete one has arrived. */
  private drain(): void {
    if (!this.waiting) return;

    const lines = this.buffer.split('\r\n');
    // The last entry is an unfinished line, or empty.
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i] ?? '';
      // "250-SIZE" continues; "250 OK" ends. The fourth character says which.
      if (/^\d{3} /.test(line)) {
        const complete = lines.slice(0, i + 1).join('\r\n');
        this.buffer = lines.slice(i + 1).join('\r\n');
        const resolve = this.waiting;
        this.waiting = null;
        resolve?.({ code: Number.parseInt(line.slice(0, 3), 10), text: complete });
        return;
      }
    }
  }

  /** Waits for the next reply, or gives up. */
  read(): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error('The mail server did not reply within 30 seconds.'));
      }, TIMEOUT);

      this.waiting = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.failed = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.drain();
    });
  }

  write(line: string): void {
    this.socket.write(line + '\r\n');
  }

  /**
   * Sends a command and insists on the reply code it expects.
   *
   * The server's own words are kept in the error: "535 Authentication failed"
   * tells an administrator what to fix, and a generic "the send failed" does
   * not.
   */
  async command(line: string, expected: number[], redact = false): Promise<Reply> {
    this.write(line);
    const reply = await this.read();
    if (!expected.includes(reply.code)) {
      const shown = redact ? '(credentials)' : line;
      throw new Error('SMTP ' + shown.split(' ')[0] + ' failed: ' + reply.text.trim());
    }
    return reply;
  }

  upgrade(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('close');

      const secure = tlsConnect({ socket: plain as Socket, servername: host }, () => {
        this.socket = secure;
        this.buffer = '';
        this.listen();
        resolve();
      });
      secure.once('error', reject);
    });
  }

  end(): void {
    this.socket.removeAllListeners('close');
    this.socket.end();
    this.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const ASCII_ONLY = /^[\x20-\x7e]*$/;

/**
 * A header value that may contain anything.
 *
 * Headers are ASCII, so a subject with a Czech or French character has to be
 * an RFC 2047 encoded word or it arrives as mojibake. Base64 rather than
 * quoted-printable because it is one rule rather than several.
 */
export function encodeHeader(value: string): string {
  if (ASCII_ONLY.test(value)) return value;
  return '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
}

/** `Name <address>`, with the name encoded if it needs to be. */
function address(name: string, email: string): string {
  if (!name) return '<' + email + '>';
  return encodeHeader(name) + ' <' + email + '>';
}

/** Base64, wrapped at 76 characters as the MIME rules require. */
function base64Body(text: string): string {
  return wrap(Buffer.from(text, 'utf8').toString('base64'));
}

/** The same for bytes that were never text, such as an image. */
function base64Bytes(bytes: Buffer): string {
  return wrap(bytes.toString('base64'));
}

function wrap(encoded: string): string {
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join('\r\n');
}

/**
 * A boundary that cannot occur in what it separates.
 *
 * Every part of this message is base64, whose alphabet is letters, digits,
 * `+`, `/` and a trailing `=`. A boundary containing `_` therefore cannot
 * appear in any part's content, so no amount of body can accidentally end it -
 * which is the one way a multipart message goes badly wrong.
 */
function newBoundary(): string {
  return '=_' + randomBytes(16).toString('hex') + '_=';
}

/**
 * The message as it goes down the wire.
 *
 * Base64 for every part, so a long line of HTML cannot exceed the
 * 998-character limit and so UTF-8 survives a server that would otherwise
 * mangle it.
 *
 * With no images this is a plain `text/html` message, exactly as it was
 * before images existed - a notification that does not use a logo gains
 * nothing to go wrong. With images it becomes `multipart/related`, which is
 * the structure a `cid:` reference resolves within: the HTML first, then one
 * part per image carrying the `Content-ID` the HTML points at.
 *
 * `multipart/related`, not `multipart/mixed`: related says these parts are
 * pieces of the body, which is why a client shows the logo in place instead
 * of listing it as an attachment to download.
 */
export function buildMessage(message: SmtpMessage): string {
  const images = message.inlineImages ?? [];
  const files = message.attachments ?? [];

  const headers = [
    'From: ' + address(message.fromName, message.from),
    'To: <' + message.to + '>',
    'Subject: ' + encodeHeader(message.subject),
    'Message-ID: ' + message.messageId,
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    // Tells well-behaved auto-responders not to answer, which is one of the
    // two ways a mail loop starts.
    'Auto-Submitted: auto-generated',
  ];

  if (message.inReplyTo) {
    headers.push('In-Reply-To: ' + message.inReplyTo);
    headers.push('References: ' + message.inReplyTo);
  }

  if (images.length === 0 && files.length === 0) {
    headers.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return headers.join('\r\n') + '\r\n\r\n' + base64Body(message.html);
  }

  // The body, as one part: HTML on its own, or HTML plus the images it
  // displays wrapped in `related` so a `cid:` has something to resolve in.
  const htmlPart =
    ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64'].join('\r\n') +
    '\r\n\r\n' +
    base64Body(message.html);

  const body =
    images.length === 0
      ? htmlPart
      : (() => {
          const boundary = newBoundary();
          const parts = [htmlPart];
          for (const image of images) {
            parts.push(
              [
                'Content-Type: ' + image.contentType + '; name="' + mimeName(image.fileName) + '"',
                'Content-Transfer-Encoding: base64',
                // Angle brackets are part of the syntax: the body says
                // `cid:logo` and the header says `<logo>`.
                'Content-ID: <' + image.cid + '>',
                'Content-Disposition: inline; filename="' + mimeName(image.fileName) + '"',
              ].join('\r\n') +
                '\r\n\r\n' +
                base64Bytes(image.content),
            );
          }
          return (
            // `type` names the part a client should render; without it some
            // clients guess, and an image is as good a guess as the HTML.
            'Content-Type: multipart/related; type="text/html"; boundary="' +
            boundary +
            '"\r\n\r\n' +
            wrapParts(boundary, parts)
          );
        })();

  if (files.length === 0) {
    // `body` is already the related container, headers and all.
    const [first, ...rest] = body.split('\r\n\r\n');
    headers.push(first ?? '');
    return headers.join('\r\n') + '\r\n\r\n' + rest.join('\r\n\r\n');
  }

  // Files the reader downloads go one level further out, in `mixed`: related
  // says "these are pieces of the body", mixed says "these are things sent
  // alongside it", and a client lists only the second kind as attachments.
  const outer = newBoundary();
  headers.push('Content-Type: multipart/mixed; boundary="' + outer + '"');

  const parts = [body];
  for (const file of files) {
    parts.push(
      [
        'Content-Type: ' + file.contentType + '; name="' + mimeName(file.filename) + '"',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="' + mimeName(file.filename) + '"',
      ].join('\r\n') +
        '\r\n\r\n' +
        base64Bytes(file.content),
    );
  }

  return headers.join('\r\n') + '\r\n\r\n' + wrapParts(outer, parts);
}

/** The parts of a multipart body, with the boundaries between them. */
function wrapParts(boundary: string, parts: string[]): string {
  return (
    '--' + boundary + '\r\n' + parts.join('\r\n--' + boundary + '\r\n') + '\r\n--' + boundary + '--'
  );
}

/**
 * A filename safe to put in a header.
 *
 * Quoted, so a quote or a newline in it would end the parameter early or
 * inject a header outright - and the name came from an uploaded file, which
 * is to say from somebody's keyboard. Anything outside plain ASCII without
 * quotes is dropped rather than encoded: it is a label on an inline image
 * that nobody reads.
 */
function mimeName(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '');
  return safe.slice(0, 100) || 'image';
}

/**
 * Escapes a line that would otherwise end the message.
 *
 * A line consisting of a single dot terminates DATA, so any line starting
 * with one gets another. Base64 never produces one, but the rule is cheap and
 * this function would be wrong without it the day the body stops being base64.
 */
function dotStuff(body: string): string {
  return body
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n');
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function open(config: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.implicitTls
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host }, () =>
          resolve(socket),
        )
      : netConnect({ host: config.host, port: config.port }, () => resolve(socket));

    socket.setTimeout(TIMEOUT, () => {
      socket.destroy();
      reject(new Error('Could not reach ' + config.host + ':' + config.port + ' within 30 seconds.'));
    });
    socket.once('error', reject);
  });
}

/** Which authentication the server offered. */
function authMethods(greeting: string): string[] {
  const line = greeting
    .split('\r\n')
    .find((entry) => /^\d{3}[ -]AUTH /i.test(entry));
  return line ? line.slice(9).trim().toUpperCase().split(/\s+/) : [];
}

export async function sendOverSmtp(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  if (config.plain && config.username) {
    throw new Error('Refused: a password is never sent without TLS. Choose STARTTLS or TLS, or remove the username.');
  }
  const socket = await open(config);
  const session = new Session(socket);

  try {
    const greeting = await session.read();
    if (greeting.code !== 220) {
      throw new Error('The mail server refused the connection: ' + greeting.text.trim());
    }

    const me = hostname() || 'localhost';
    let hello = await session.command('EHLO ' + me, [250]);

    if (!config.implicitTls && !config.plain) {
      // STARTTLS, then say hello again: the capabilities before and after an
      // upgrade are allowed to differ, and AUTH usually only appears after.
      await session.command('STARTTLS', [220]);
      await session.upgrade(config.host);
      hello = await session.command('EHLO ' + me, [250]);
    }

    const methods = authMethods(hello.text);
    if (config.username) {
      if (methods.includes('LOGIN') || methods.length === 0) {
        await session.command('AUTH LOGIN', [334]);
        await session.command(Buffer.from(config.username, 'utf8').toString('base64'), [334], true);
        await session.command(Buffer.from(config.password, 'utf8').toString('base64'), [235], true);
      } else if (methods.includes('PLAIN')) {
        const token = Buffer.from('\0' + config.username + '\0' + config.password, 'utf8').toString(
          'base64',
        );
        await session.command('AUTH PLAIN ' + token, [235], true);
      } else {
        throw new Error(
          'The mail server offers no authentication this client supports (' +
            methods.join(', ') +
            ').',
        );
      }
    }

    await session.command('MAIL FROM:<' + message.from + '>', [250]);
    await session.command('RCPT TO:<' + message.to + '>', [250, 251]);
    await session.command('DATA', [354]);

    session.write(dotStuff(buildMessage(message)));
    session.write('.');

    const accepted = await session.read();
    if (accepted.code !== 250) {
      throw new Error('The mail server did not accept the message: ' + accepted.text.trim());
    }

    // A failure here does not matter - the message is already accepted - so
    // QUIT is sent without waiting for its reply.
    session.write('QUIT');
  } finally {
    session.end();
  }
}
