import './env.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';
import { createUserGroup, setManualMember } from '../src/services/user-groups.js';
import { findUserByEmail } from '../src/services/users.js';
import { execute } from '../src/db/index.js';
import { loadSettings, settings, updateSettings } from '../src/settings/index.js';
import { rewrite, scan, stringId } from '../src/i18n/extract.js';
import { buildCatalogue, catalogueJson, CATALOGUE_PATH } from '../scripts/strings.js';
import fs from 'node:fs';
import {
  catalogue,
  coverage,
  createLanguage,
  deleteLanguage,
  findLanguage,
  importTranslations,
  listLanguages,
  loadLanguages,
  parseTranslationTable,
  setLanguageDomains,
  setLanguageEnabled,
  setLanguageGroups,
  translationMarkdown,
  translatorFor,
} from '../src/i18n/index.js';
import { forgetLanguageGroups, languageFor, languageForHeader } from '../src/i18n/resolve.js';
import {
  listNotifications,
  notificationFor,
  seedNotifications,
  updateNotification,
} from '../src/services/mail/notifications.js';

/**
 * Custom languages (16 Oct 2026). The three things worth a test:
 *
 * 1. **The catalogue is generated**, so it cannot fall behind the views -
 *    which was the owner's hardest requirement.
 * 2. **The rewriter is faithful**: with no language, a view renders exactly
 *    what it did before. The other thousand tests in this suite are the real
 *    check of that; the ones here are about the pieces.
 * 3. **The five resolution rules**, in order.
 */

let app: Express;
let admin: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('lang.admin@example.com', 'admin');
  // The database file survives a previous run of this file.
  await execute('DELETE FROM languages');
  await seedNotifications();
  await loadLanguages();
});

after(async () => {
  await loadLanguages();
});

describe('the catalogue', () => {
  test('is in step with the views', () => {
    // The check that makes "any new feature is added automatically" true. A
    // string written today and not in the file means `npm run strings` has
    // not been run, which is a one-line fix - not a decision.
    const built = catalogueJson(buildCatalogue());
    const onDisk = fs.readFileSync(CATALOGUE_PATH, 'utf8');
    assert.equal(
      built,
      onDisk,
      'src/i18n/strings.json is stale. Run: npm run strings',
    );
  });

  test('holds plenty of the interface, and no duplicates', () => {
    assert.ok(Object.keys(catalogue).length > 500, 'the interface has more than five hundred strings');
    const texts = Object.values(catalogue).map((e) => e.text);
    assert.equal(new Set(texts).size, texts.length, 'one row per string');
  });

  test('a string is keyed by its text, so the same word is one row', () => {
    assert.equal(stringId('Save'), stringId('Save'));
    assert.notEqual(stringId('Save'), stringId('Save '));
  });
});

describe('the rewriter', () => {
  const where = 'views/example.ejs';

  test('asks for a translation of a whole text node and of a tooltip', () => {
    const out = rewrite('<h1>Tickets</h1><input placeholder="Title or description">', where);
    assert.match(out, /<h1><%= t\('Tickets'\) %><\/h1>/);
    assert.match(out, /placeholder="<%= t\('Title or description'\) %>"/);
  });

  test('a sentence with a value in it becomes one pattern, values and all', () => {
    // The halves are not sentences, and a translator cannot move a value to
    // where their grammar needs it - so the whole run is one string with
    // {0} where the value goes, and the value itself is never translated.
    assert.equal(
      rewrite('<p>Showing <%= n %> tickets</p>', where),
      "<p><%- tr('Showing {0} tickets', [n]) %></p>",
    );
    assert.deepEqual(scan('<p>Showing <%= n %> tickets</p>', where).map((f) => f.text), ['Showing {0} tickets']);

    // Inline markup is still left alone: a translation carrying markup of
    // its own is a different and worse problem.
    const markup = '<p>Tickets from <strong><%= name %></strong></p>';
    assert.equal(rewrite(markup, where), markup);
  });

  test('never touches what is posted, matched or routed on', () => {
    const source = '<a href="/tickets/new" class="btn">New</a><input name="q" value="Open">';
    const out = rewrite(source, where);
    assert.match(out, /href="\/tickets\/new"/, 'a link is a path, not words');
    assert.match(out, /value="Open"/, 'a value is posted back');
    assert.match(out, /class="btn"><%= t\('New'\) %><\/a>/);
  });

  test('leaves code and comments alone', () => {
    const source = '<script src="/assets/js/copy.js"></script><%# A note to a reader of the code %>';
    assert.equal(rewrite(source, where), source);
  });

  test('scan and rewrite agree', () => {
    const source = '<h1>Tickets</h1><p class="hint">Nothing here yet</p>';
    const found = scan(source, where);
    assert.deepEqual(found.map((f) => f.text), ['Tickets', 'Nothing here yet']);
    for (const f of found) assert.ok(rewrite(source, where).includes("t('" + f.text + "')"));
  });

  test('the context says what a translator needs', () => {
    const [heading] = scan('<h1>Tickets</h1>', 'views/tickets/index.ejs');
    assert.equal(heading?.context, 'A heading on tickets/index');
  });
});

describe('a language, end to end', () => {
  test('is added, translated from a pasted table, and then serves pages', async () => {
    await createLanguage({ tag: 'cs-CZ', name: 'Czech', label: 'cz' }, null);
    const row = await findLanguage('cs-CZ');
    assert.ok(row);
    assert.equal(row.label, 'CZ', 'the label is the two characters the tab shows');
    assert.equal(row.is_enabled, false, 'off until somebody says otherwise');

    // The document, as an administrator hands it to an AI.
    const markdown = translationMarkdown(row);
    assert.match(markdown, /# Translate this service desk into Czech \(cs-CZ\)/);
    assert.match(markdown, /\| id \| context \| English \| Translation \|/);
    const ticketsId = stringId('Tickets');
    assert.ok(markdown.includes('| ' + ticketsId + ' |'), 'every string is a row');

    // ...and the table it gives back.
    const answer = [
      '| id | context | English | Translation |',
      '| --- | --- | --- | --- |',
      '| ' + ticketsId + ' | A heading | Tickets | Pozadavky |',
      '| ' + stringId('Raise a ticket') + ' | A button | Raise a ticket | Zadat pozadavek |',
      '| s0000000000 | gone | Something removed | Neco |',
    ].join('\n');
    const result = await importTranslations('cs-CZ', answer, null);
    assert.equal(result.rows, 3);
    assert.equal(result.unknown, 1, 'a row for text that has changed is counted and dropped');
    assert.equal(result.done, 2);

    await setLanguageEnabled('cs-CZ', true, null);
    await loadLanguages();
    const t = translatorFor('cs-CZ');
    assert.equal(t('Tickets'), 'Pozadavky');
    assert.equal(t('Something nobody translated'), 'Something nobody translated', 'the English, always');
  });

  test('a page is served in it, and nothing people wrote is touched', async () => {
    const person = await findUserByEmail('lang.admin@example.com');
    assert.ok(person);
    await execute('UPDATE users SET language = ? WHERE id = ?', ['cs-CZ', person.id]);
    const page = await request.agent(app).set('Cookie', admin.cookie).get('/tickets').expect(200);
    assert.match(page.text, /Pozadavky/, 'the heading is translated');
    assert.match(page.text, /Default request|Raise a ticket|Zadat pozadavek/, 'the page still has its contents');
    // The seeded template's name is an administrator's text: left as written.
    assert.doesNotMatch(page.text, /Výchozí/);
    await execute('UPDATE users SET language = ? WHERE id = ?', ['', person.id]);
  });

  test('a table with no rows at all is refused, not silently emptied', async () => {
    await assert.rejects(
      () => importTranslations('cs-CZ', 'the AI said hello and nothing else', null),
      /No translation rows/,
    );
    const row = await findLanguage('cs-CZ');
    assert.equal(coverage(row!).done, 2, 'what was translated is still there');
  });

  test('a cell may hold a pipe or a line break', () => {
    const id = stringId('Tickets');
    const { strings } = parseTranslationTable('| ' + id + ' | c | Tickets | A \\| B<br>C |');
    assert.equal(strings[id], 'A | B\nC');
  });
});

describe('the text that is not in a view', () => {
  // Reported 16 Oct 2026, with a Czech page whose sidebar and settings list
  // were still in English: the extractor reads text nodes, and these are
  // constants (the settings sections) or built inside an EJS tag (the
  // sidebar labels).
  test('the settings sections, their lines and the ticket words are in the catalogue', () => {
    for (const text of [
      'Customisation',
      'Branding, portal, images and locale',
      'Open',
      'Urgent',
      'Incident',
    ]) {
      assert.ok(catalogue[stringId(text)], JSON.stringify(text) + ' should be translatable');
    }
  });

  test('a sidebar label is in it too, through its t() call', () => {
    for (const text of ['New ticket', 'Dashboard', 'Reports', 'Settings']) {
      assert.ok(catalogue[stringId(text)], JSON.stringify(text) + ' should be translatable');
    }
  });

  test('and a translated page shows all of them', async () => {
    const person = await findUserByEmail('lang.admin@example.com');
    assert.ok(person);
    const words: Record<string, string> = {
      Dashboard: 'Prehled',
      Settings: 'Nastaveni',
      Customisation: 'Prizpusobeni',
      'Branding, portal, images and locale': 'Znacka, portal, obrazky a mistni nastaveni',
    };
    const table = [
      '| id | context | English | Translation |',
      '| --- | --- | --- | --- |',
      ...Object.entries(words).map(([en, cs]) => '| ' + stringId(en) + ' | c | ' + en + ' | ' + cs + ' |'),
    ].join('\n');
    await importTranslations('cs-CZ', table, null);
    await setLanguageEnabled('cs-CZ', true, null);
    await execute('UPDATE users SET language = ? WHERE id = ?', ['cs-CZ', person.id]);

    const page = await request.agent(app).set('Cookie', admin.cookie)
      .get('/admin/settings/customization').expect(200);
    assert.match(page.text, /Prehled/, 'the sidebar');
    assert.match(page.text, /Prizpusobeni/, 'the settings section');
    assert.match(page.text, /Znacka, portal, obrazky a mistni nastaveni/, 'and the line under it');

    await execute('UPDATE users SET language = ? WHERE id = ?', ['', person.id]);
  });
});

describe('which language a reader gets', () => {
  let groupId = '';
  let otherGroupId = '';

  before(async () => {
    // Named for this suite, so nothing else in the file can have taken them.
    await execute("DELETE FROM user_groups WHERE name LIKE 'Lang %'");
    groupId = (await createUserGroup({ name: 'Lang Prague', description: '', isActive: true }, null)).id;
    otherGroupId = (await createUserGroup({ name: 'Lang English speakers', description: '', isActive: true }, null)).id;
    await loadLanguages();
  });

  test('1. their own choice beats everything', async () => {
    const reader = { id: null, email: 'somebody@example.com', language: 'cs-CZ' };
    assert.equal(await languageFor(reader, 'de-DE'), 'cs-CZ');
  });

  test('   ...including a deliberate choice of English', async () => {
    await setLanguageDomains('cs-CZ', ['example.com'], null);
    await loadLanguages();
    const reader = { id: null, email: 'somebody@example.com', language: 'en' };
    assert.equal(await languageFor(reader), '', 'English, not the domain rule');
    await setLanguageDomains('cs-CZ', [], null);
    await loadLanguages();
  });

  test('2. a user group may be given a language, and another kept out of it', async () => {
    const person = await findUserByEmail('lang.admin@example.com');
    assert.ok(person);
    await setManualMember(groupId, person.id, true, null);
    await setLanguageGroups('cs-CZ', [groupId], [], null);
    forgetLanguageGroups();
    assert.equal(await languageFor(person), 'cs-CZ');

    // The narrower statement wins: in both groups, they stay in English.
    await setManualMember(otherGroupId, person.id, true, null);
    await setLanguageGroups('cs-CZ', [groupId], [otherGroupId], null);
    forgetLanguageGroups();
    assert.equal(await languageFor(person), '');

    await setManualMember(otherGroupId, person.id, false, null);
    await setLanguageGroups('cs-CZ', [], [], null);
    forgetLanguageGroups();
  });

  test('3. the email domain, for somebody no group speaks for', async () => {
    await setLanguageDomains('cs-CZ', ['@Contoso.CZ'], null);
    await loadLanguages();
    assert.equal(await languageFor({ id: null, email: 'jan@contoso.cz', language: '' }), 'cs-CZ');
    assert.equal(await languageFor({ id: null, email: 'jan@fabrikam.com', language: '' }), '');
    await setLanguageDomains('cs-CZ', [], null);
    await loadLanguages();
  });

  test('4. the browser, when the service desk allows it', async () => {
    assert.equal(languageForHeader('cs-CZ,cs;q=0.9,en;q=0.8'), 'cs-CZ');
    assert.equal(languageForHeader('cs-SK,en;q=0.8'), 'cs-CZ', 'the same language, another region');
    assert.equal(languageForHeader('de-DE'), '');

    await updateSettings({ locale: { ...settings().locale, followBrowser: false } }, null);
    await loadSettings();
    assert.equal(await languageFor({ id: null, email: '', language: '' }, 'cs-CZ'), '', 'not when it is off');
    await updateSettings({ locale: { ...settings().locale, followBrowser: true } }, null);
    await loadSettings();
    assert.equal(await languageFor({ id: null, email: '', language: '' }, 'cs-CZ'), 'cs-CZ');
  });

  test('5. English, and a language switched off is not a dead end', async () => {
    assert.equal(await languageFor({ id: null, email: '', language: '' }, 'fr-FR'), '');
    await setLanguageEnabled('cs-CZ', false, null);
    await loadLanguages();
    assert.equal(await languageFor({ id: null, email: '', language: 'cs-CZ' }), '', 'their choice is off: English');
    await setLanguageEnabled('cs-CZ', true, null);
    await loadLanguages();
  });
});

describe('a set of notifications per language', () => {
  test('the tab creates them, copied from the English ones and then owned', async () => {
    await setLanguageEnabled('cs-CZ', true, null);
    await loadLanguages();

    const page = await request.agent(app).set('Cookie', admin.cookie)
      .get('/admin/settings/mail/notifications?lang=cs-CZ').expect(200);
    assert.match(page.text, /CZ<\/a>/, 'the tab is labelled with the two characters');

    const theirs = await listNotifications('cs-CZ');
    const english = await listNotifications('');
    assert.equal(theirs.length, english.filter((n) => !n.event.startsWith('custom')).length || theirs.length);
    assert.ok(theirs.length > 0, 'a row per event');

    // Editing one never reaches the English wording.
    const created = theirs.find((n) => n.event === 'ticket.created.requester');
    assert.ok(created);
    await updateNotification(
      created.id,
      { subject: 'Mame vas pozadavek', bodyHtml: '<p>Dekujeme.</p>', isEnabled: true, mailboxId: null },
      null,
    );
    const stillEnglish = await notificationFor('ticket.created.requester');
    assert.doesNotMatch(stillEnglish!.subject, /Mame/);
    assert.match((await notificationFor('ticket.created.requester', 'cs-CZ'))!.subject, /Mame/);
  });

  test('an event with no row in that language falls back to the English one, whole', async () => {
    const theirs = await notificationFor('ticket.created.requester', 'cs-CZ');
    assert.ok(theirs);
    await execute('DELETE FROM mail_notifications WHERE id = ?', [theirs.id]);

    const fallback = await notificationFor('ticket.created.requester', 'cs-CZ');
    assert.ok(fallback);
    assert.equal(fallback.language ?? '', '', 'the English row, not half a translation');
  });

  test('removing the language removes its notifications and leaves the English ones', async () => {
    const before = (await listNotifications('')).length;
    await deleteLanguage('cs-CZ', null);
    assert.equal((await listNotifications('cs-CZ')).length, 0);
    assert.equal((await listNotifications('')).length, before);

    // Put it back for whatever runs after this.
    await createLanguage({ tag: 'cs-CZ', name: 'Czech', label: 'CZ' }, null);
  });
});

describe('the page that manages them', () => {
  test('lists the language with its coverage, and offers the document', async () => {
    const page = await request.agent(app).set('Cookie', admin.cookie)
      .get('/admin/settings/customization/locale').expect(200);
    assert.match(page.text, /Czech/);
    assert.match(page.text, /of \d+ strings translated/);
    assert.match(page.text, /locale\/languages\/cs-CZ\/document/);

    const document = await request.agent(app).set('Cookie', admin.cookie)
      .get('/admin/settings/customization/locale/languages/cs-CZ/document').expect(200);
    assert.match(document.headers['content-type'] ?? '', /text\/markdown/);
    assert.match(document.text, /Keep each one about as short as the English/);
  });

  test('refuses a tag that is not one, beside the field', async () => {
    const page = await request.agent(app).set('Cookie', admin.cookie)
      .get('/admin/settings/customization/locale').expect(200);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
    const refused = await request.agent(app).set('Cookie', admin.cookie)
      .post('/admin/settings/customization/locale/languages')
      .type('form')
      .send({ _csrf: csrf, tag: 'Czech please', name: 'Czech', label: 'CZ' })
      .expect(400);
    assert.match(refused.text, /language tag as a browser writes it/i);
    assert.equal((await listLanguages()).length, 1, 'nothing was added');
  });
});
