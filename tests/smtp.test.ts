import './env.js';
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { buildMessage, encodeHeader } from '../src/services/mail/smtp.js';

describe('building a message for the wire', () => {
  const base = {
    from: 'it-servicedesk@seznam.cz',
    fromName: 'IT servicedesk',
    to: 'somebody@example.com',
    subject: 'Plain subject',
    html: '<p>Hello</p>',
    messageId: '<abc@localhost>',
  };

  test('a plain header is left alone', () => {
    assert.equal(encodeHeader('Printer broken'), 'Printer broken');
  });

  test('a header with accents is encoded, not sent raw', () => {
    // Headers are ASCII. A Czech subject sent raw arrives as mojibake, which
    // is the first thing anybody notices about a new mail integration.
    const encoded = encodeHeader('Tiskárna nefunguje');
    assert.match(encoded, /^=\?UTF-8\?B\?/);
    assert.match(encoded, /\?=$/);
    assert.equal(
      Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'),
      'Tiskárna nefunguje',
    );
  });

  test('the body is base64, so long HTML and UTF-8 both survive', () => {
    const message = buildMessage({ ...base, html: '<p>Příliš žluťoučký kůň</p>' });

    assert.match(message, /Content-Transfer-Encoding: base64/);
    const body = message.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    assert.equal(
      Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
      '<p>Příliš žluťoučký kůň</p>',
    );
  });

  test('no line exceeds what SMTP allows', () => {
    // A line over 998 characters is a protocol violation, and one long line
    // of HTML would do it without the base64 wrapping.
    const long = '<p>' + 'x'.repeat(5000) + '</p>';
    for (const line of buildMessage({ ...base, html: long }).split('\r\n')) {
      assert.ok(line.length <= 998, 'line of ' + line.length + ' characters');
    }
  });

  test('the headers that make threading work are present', () => {
    const message = buildMessage({ ...base, inReplyTo: '<previous@localhost>' });
    assert.match(message, /Message-ID: <abc@localhost>/);
    assert.match(message, /In-Reply-To: <previous@localhost>/);
    assert.match(message, /References: <previous@localhost>/);
  });

  test('an auto-responder is asked not to answer', () => {
    // One of the two ways a mail loop starts.
    assert.match(buildMessage(base), /Auto-Submitted: auto-generated/);
  });

  test('the sender name is encoded when it needs to be', () => {
    const message = buildMessage({ ...base, fromName: 'Oddělení IT' });
    assert.match(message, /^From: =\?UTF-8\?B\?[^ ]+\?= <it-servicedesk@seznam\.cz>$/m);
  });

  test('headers and body are separated by exactly one blank line', () => {
    const message = buildMessage(base);
    const split = message.indexOf('\r\n\r\n');
    assert.ok(split > 0, 'there has to be a separator');
    assert.doesNotMatch(message.slice(0, split), /\r\n\r\n/, 'and only one');
  });
});
