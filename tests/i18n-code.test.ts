import './env.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';
import { createTicket } from '../src/services/tickets.js';
import { execute } from '../src/db/index.js';
import { stringId } from '../src/i18n/extract.js';
import { scanCode } from '../src/i18n/code-scan.js';
import {
  catalogue,
  createLanguage,
  importTranslations,
  interpolateText,
  loadLanguages,
  setLanguageEnabled,
} from '../src/i18n/index.js';
import { words, withWords } from '../src/i18n/current.js';
import { formatRelative } from '../src/lib/format.js';

/**
 * The words a page gets from code (21 Oct 2026): label lists, the date
 * helpers, refusals and flashes, and text a service draws itself. Measured
 * with a pseudo-language render of every page a requester or a technician
 * opens; these are the checks that keep the mechanisms honest.
 */

describe('the code scan', () => {
  test('finds a refusal, a flash, a page title and a t() call', () => {
    const found = scanCode(
      [
        "throw badRequest('Give the ticket a short title.');",
        "flash(req, 'success', 'Ticket updated');",
        "res.render('x', { title: 'Raise a ticket' });",
        "const label = t('Raised today');",
        "const clock = tx('Responds in {0}', [left]);",
      ].join('\n'),
      'src/routes/tickets.ts',
    ).map((f) => f.text);
    for (const text of ['Give the ticket a short title.', 'Ticket updated', 'Raise a ticket', 'Raised today', 'Responds in {0}']) {
      assert.ok(found.includes(text), text);
    }
  });

  test('skips SQL, log lines and comments', () => {
    const found = scanCode(
      [
        "await execute('DELETE FROM sessions WHERE sid = ?', [sid]);",
        "log.warn({ err }, 'Something went wrong in the poller.');",
        "// 'A sentence in a comment.'",
      ].join('\n'),
      'src/services/x.ts',
    );
    assert.deepEqual(found, []);
  });

  test('the catalogue holds what it found', () => {
    assert.ok(catalogue[stringId('Give the ticket a short title.')], 'a refusal from routes/tickets.ts');
    assert.ok(catalogue[stringId('Responds in {0}')], 'a clock from services/work-dashboard.ts');
    assert.ok(catalogue[stringId('Open')], 'a status, from code-strings.ts');
  });
});

describe('plain text with values', () => {
  test('puts the values where the translation wants them, unescaped', () => {
    const cs = (text: string) => (text === 'Up to {0} files, {1} each.' ? 'Nejvýše {0} souborů, každý {1}.' : text);
    assert.equal(interpolateText(cs, 'Up to {0} files, {1} each.', [10, '10 MB']), 'Nejvýše 10 souborů, každý 10 MB.');
    assert.equal(interpolateText(cs, 'Remove {0}', ['a&b.png']), 'Remove a&b.png', 'the caller escapes, so this does not');
  });

  test('a translation that lost a value is not used', () => {
    const broken = () => 'Nejvýše souborů';
    assert.equal(interpolateText(broken, 'Up to {0} files', [10]), 'Up to 10 files');
  });
});

describe('the date helpers', () => {
  test('say "ago" in the reader\'s words', () => {
    const cs = (text: string) => ({ 'just now': 'právě teď', '{0} minutes ago': 'před {0} minutami' })[text] ?? text;
    const now = Date.now();
    assert.equal(formatRelative(new Date(now - 5_000).toISOString(), cs), 'právě teď');
    assert.equal(formatRelative(new Date(now - 5 * 60_000).toISOString(), cs), 'před 5 minutami');
    assert.equal(formatRelative(new Date(now - 5 * 60_000).toISOString()), '5 minutes ago', 'English by default');
  });

  test('code outside a request writes English', () => {
    assert.equal(words()('Open'), 'Open');
    assert.equal(withWords(() => 'Otevřeno', () => words()('Open')), 'Otevřeno');
  });
});

describe('a translated page', () => {
  let app: Express;
  let agent: TestSession;

  before(async () => {
    await bootstrapTestDatabase();
    await ensureDefaultTemplate();
    app = createApp();
    agent = await signInAs('code.agent@example.com', 'agent');
    await execute('DELETE FROM languages');
    await createLanguage({ tag: 'cs-CZ', name: 'Czech', label: 'cz' }, null);
    const rows: [string, string][] = [
      ['Open', 'Otevřeno'],
      ['High', 'Vysoká'],
      ['Reference', 'Číslo'],
      ['Write something before posting.', 'Nejdřív něco napište.'],
    ];
    await importTranslations(
      'cs-CZ',
      ['| id | context | English | Translation |', '| --- | --- | --- | --- |', ...rows.map(([en, cs]) => '| ' + stringId(en) + ' | x | ' + en + ' | ' + cs + ' |')].join('\n'),
      null,
    );
    await setLanguageEnabled('cs-CZ', true, null);
    await execute('UPDATE users SET language = ? WHERE id = ?', ['cs-CZ', agent.user.id]);
    await loadLanguages();
  });

  after(async () => {
    await execute('DELETE FROM languages');
    await loadLanguages();
  });

  test('shows the status and priority words, and the column headings, translated', async () => {
    await createTicket({ title: 'Printer', description: 'It jams on every job', priority: 'high', category: 'other', requesterId: agent.user.id });
    const res = await request(app).get('/tickets?scope=all&status=any').set('Cookie', agent.cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, />Otevřeno</, 'a status, from statusLabels');
    assert.match(res.text, />Vysoká</, 'a priority, from priorityLabels');
    assert.match(res.text, /Číslo/, 'a heading built in an expression');
  });

  test('a refusal beside a form is in the reader\'s language', async () => {
    const ticket = await createTicket({ title: 'Mouse', description: 'The wheel does not scroll', priority: 'normal', category: 'other', requesterId: agent.user.id });
    const res = await request(app)
      .post('/tickets/' + ticket.id + '/comments')
      .set('Cookie', agent.cookie)
      .type('form')
      .send({ _csrf: agent.csrfToken, body: '' });
    const page = res.status === 302 ? await request(app).get(res.headers.location as string).set('Cookie', agent.cookie) : res;
    assert.match(page.text, /Nejdřív něco napište\./);
  });
});
