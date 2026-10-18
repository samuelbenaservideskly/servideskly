import './env.js';
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { plainText, trimQuotedHistory } from '../src/services/mail/transport.js';

describe('the quoted conversation below a reply', () => {
  test("Outlook's HTML reply: the quote is cut, and the reply keeps its own line", () => {
    const html = '<div dir="ltr">Okay, I will</div><hr style="display:inline-block"><div id="divRplyFwdMsg" dir="ltr"><b>From:</b> sales &lt;sales@servideskly.com&gt;<br><b>Sent:</b> Sunday, October 18, 2026 10:24 AM<br><b>Subject:</b> [INC-000006] We have your request: test2</div><div>Hello Jan</div>';
    assert.equal(trimQuotedHistory(plainText(html, 'html')), 'Okay, I will');
  });

  test('the block Outlook writes, once the HTML is text, in English and in Czech', () => {
    assert.equal(trimQuotedHistory('Okay, I will\n\nFrom: sales <sales@servideskly.com>\nSent: Sunday\nTo: Jan'), 'Okay, I will');
    assert.equal(trimQuotedHistory('Hotovo, díky.\n\nOd: Servis <s@example.cz>\nOdesláno: pondělí'), 'Hotovo, díky.');
    assert.equal(trimQuotedHistory('Works now.\n\nOn Mon, 12 Oct 2026 at 9:14, Service Desk <s@example.com> wrote:\n> Hello'), 'Works now.');
    assert.equal(trimQuotedHistory('Yes.\n> line one\n> line two'), 'Yes.');
  });

  test('Gmail and Apple quote containers', () => {
    assert.equal(trimQuotedHistory(plainText('<div>Thanks!</div><div class="gmail_quote">On Mon wrote: old</div>', 'html')), 'Thanks!');
    assert.equal(trimQuotedHistory(plainText('<p>Fixed</p><blockquote type="cite">old text</blockquote>', 'html')), 'Fixed');
  });

  test('a reply that is only a quote is kept whole, never emptied', () => {
    assert.equal(trimQuotedHistory('From: someone <a@b.c>\nSent: Monday'), 'From: someone <a@b.c>\nSent: Monday');
  });
});
