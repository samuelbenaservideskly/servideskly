import './env.js';
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { simpleParser } from 'mailparser';
import { plainText, trimQuotedHistory } from '../src/services/mail/transport.js';

/**
 * What arrives from a real mail client.
 *
 * These are the shapes that break a naive reader: a quoted-printable body in
 * a non-ASCII charset, a base64 body, an RFC 2047 subject, and a multipart
 * message where the readable part is not the first one. Each is written out
 * as raw bytes rather than built with a helper, because the point is to prove
 * the parser handles what a mail client actually sends.
 */

const CZECH = 'Příliš žluťoučký kůň úpěl ďábelské ódy.';

function raw(lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

describe('reading what a mail client sends', () => {
  test('a quoted-printable body in UTF-8 comes back as text', async () => {
    const parsed = await simpleParser(
      raw([
        'From: Jan Novák <jan@example.cz>',
        'To: help@example.com',
        'Subject: =?UTF-8?B?' + Buffer.from('Tiskárna nefunguje', 'utf8').toString('base64') + '?=',
        'Message-ID: <qp@example.cz>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'P=C5=99=C3=ADli=C5=A1 =C5=BElu=C5=A5ou=C4=8Dk=C3=BD k=C5=AF=C5=88.',
        '',
      ]),
    );

    assert.equal(parsed.subject, 'Tiskárna nefunguje', 'the header is decoded');
    assert.match(parsed.text ?? '', /Příliš žluťoučký kůň/, 'and so is the body');
    assert.equal(parsed.from?.value?.[0]?.name, 'Jan Novák');
  });

  test('a base64 body in UTF-8 comes back as text', async () => {
    const parsed = await simpleParser(
      raw([
        'From: jan@example.cz',
        'Subject: Test',
        'Message-ID: <b64@example.cz>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(CZECH, 'utf8').toString('base64'),
        '',
      ]),
    );

    assert.equal((parsed.text ?? '').trim(), CZECH);
  });

  test('a windows-1250 body is converted, not mangled', async () => {
    // A Czech mail client left on its defaults sends this, and reading it as
    // UTF-8 is exactly how you get a ticket full of replacement characters.
    const parsed = await simpleParser(
      Buffer.concat([
        Buffer.from(
          [
            'From: jan@example.cz',
            'Subject: Test',
            'Message-ID: <cp1250@example.cz>',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=windows-1250',
            'Content-Transfer-Encoding: 8bit',
            '',
            '',
          ].join('\r\n'),
          'ascii',
        ),
        // "Příliš" in windows-1250.
        Buffer.from([0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a]),
      ]),
    );

    assert.match(parsed.text ?? '', /Příliš/);
    assert.doesNotMatch(parsed.text ?? '', /\uFFFD/);
  });

  test('a multipart message yields its text part, not its HTML', async () => {
    const parsed = await simpleParser(
      raw([
        'From: jan@example.cz',
        'Subject: Multipart',
        'Message-ID: <multi@example.cz>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'The plain words.',
        '',
        '--b1',
        'Content-Type: text/html; charset=UTF-8',
        '',
        '<p>The <b>marked up</b> words.</p>',
        '',
        '--b1--',
        '',
      ]),
    );

    assert.match(parsed.text ?? '', /The plain words/);
    assert.doesNotMatch(parsed.text ?? '', /<b>/, 'markup belongs in the html part');
  });

  test('the threading headers survive', async () => {
    const parsed = await simpleParser(
      raw([
        'From: jan@example.cz',
        'Subject: Re: something',
        'Message-ID: <reply@example.cz>',
        'In-Reply-To: <original@helpdesk.local>',
        'References: <first@helpdesk.local> <original@helpdesk.local>',
        '',
        'A reply.',
        '',
      ]),
    );

    assert.equal(parsed.inReplyTo, '<original@helpdesk.local>');
    const references = Array.isArray(parsed.references) ? parsed.references : [parsed.references];
    assert.ok(references.includes('<original@helpdesk.local>'));
  });

  test('a message with no Message-ID is still readable', async () => {
    // Malformed, but they exist. It must not throw.
    const parsed = await simpleParser(
      raw(['From: jan@example.cz', 'Subject: No id', '', 'Body.', '']),
    );
    assert.equal(parsed.messageId, undefined);
    assert.match(parsed.text ?? '', /Body/);
  });
});

describe('tidying a reply before it becomes a comment', () => {
  test('HTML is reduced to text and script never survives', () => {
    const text = plainText('<p>Dobrý den</p><script>alert(1)</script>', 'html');
    assert.match(text, /Dobrý den/, 'accents survive the reduction');
    assert.doesNotMatch(text, /alert/);
    assert.doesNotMatch(text, /<[a-z]/i);
  });

  test('quoted history is cut, but a reply is never emptied', () => {
    assert.equal(
      trimQuotedHistory('Díky za odpověď.\n\nOn Tuesday, Bob wrote:\n> old'),
      'Díky za odpověď.',
    );
    const onlyQuote = 'On Tuesday, Bob wrote:\n> old';
    assert.equal(trimQuotedHistory(onlyQuote), onlyQuote);
  });
});
