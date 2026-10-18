import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { ALLOWED_FONTS, FONTS, fontProblems } from '../src/services/branding.js';

let app: Express;
let admin: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('font.admin@example.com', 'admin');
});

const as = () => request.agent(app).set('Cookie', admin.cookie);

const saveFont = (font: string) =>
  as().post('/admin/settings/customization/font').type('form').send({ _csrf: admin.csrfToken, font });

const saveColours = (form: Record<string, string>) =>
  as().post('/admin/settings/customization').type('form').send({
    _csrf: admin.csrfToken,
    appName: 'Service Desk',
    brandColour: '#635bff',
    inkColour: '#101828',
    ...form,
  });

describe('Appearance - Font', () => {
  test('offers only fonts this service desk is licensed to use', async () => {
    const page = await as().get('/admin/settings/customization').expect(200);

    for (const font of FONTS) {
      assert.match(page.text, new RegExp('name="font" value="' + font.key + '"'));
    }

    // The faces that used to be offered are proprietary (Monotype, Microsoft,
    // Apple). Nothing here is allowed to name one - see ALLOWED_FONTS.
    for (const gone of ['helvetica', 'arial', 'segoe', 'verdana', 'trebuchet', 'georgia']) {
      assert.doesNotMatch(
        page.text,
        new RegExp('name="font" value="' + gone + '"'),
        gone + ' must not be offered',
      );
    }
  });

  test('every stack names only allowed families and CSS generics', () => {
    for (const font of FONTS) {
      assert.deepEqual(
        fontProblems('a { font-family: ' + font.stack + ' }'),
        [],
        font.key + ' names something that is not licensed',
      );
    }
  });

  test('a chosen font reaches every page through the theme stylesheet', async () => {
    await saveFont('montserrat').expect(302);
    assert.equal(settings().branding.font, 'montserrat');

    const css = await request(app).get('/branding/theme.css').expect(200);
    assert.match(css.text, /--font: Montserrat, system-ui, sans-serif;/);
  });

  test('an unknown font is refused, and nothing changes', async () => {
    await saveFont('montserrat').expect(302);

    const refused = await saveFont('Comic Sans; } body { display: none').expect(400);
    assert.match(refused.text, /Choose one of the fonts listed/);
    assert.equal(settings().branding.font, 'montserrat', 'unchanged');
  });

  test('the font saves even when the stored colours would be refused', async () => {
    // Reported 15 Oct 2026: the font was a field of the colour form, so a
    // helpdesk whose stored text colour the policy now refuses could not
    // change its font either - the save checked everything and refused
    // everything. Written straight to settings, as an old row would be.
    await updateSettings({ branding: { inkColour: '#f2f2f2' } }, null);

    await saveFont('lato').expect(302);
    assert.equal(settings().branding.font, 'lato', 'the font is not held up by a colour');

    // The colour form still refuses it, which is the separate, correct rule.
    const colours = await saveColours({ inkColour: '#f2f2f2' }).expect(400);
    assert.match(colours.text, /too light/i);

    // ...and that refusal does not undo the font.
    assert.equal(settings().branding.font, 'lato');

    await updateSettings({ branding: { inkColour: '#101828' } }, null);
  });

  test('a colour save leaves the font alone', async () => {
    await saveFont('lato').expect(302);
    await saveColours({ brandColour: '#0ea5e9' }).expect(302);
    assert.equal(settings().branding.font, 'lato');
  });
});

describe('fonts this service desk may name', () => {
  test('allows the licensed families and the CSS generics', () => {
    assert.deepEqual(fontProblems('body { font-family: Inter, system-ui, sans-serif }'), []);
    assert.deepEqual(fontProblems('body { font-family: "IBM Plex Sans", system-ui, sans-serif }'), []);
    assert.deepEqual(fontProblems('body { color: red }'), []);
  });

  test('refuses a family nobody checked the licence of', () => {
    const problems = fontProblems('body { font-family: "Helvetica Neue", Arial, sans-serif }');
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /not available here/);
    assert.match(problems[0] ?? '', /Helvetica Neue/);
    assert.match(problems[0] ?? '', /Arial/);
  });

  test('refuses the two ways a font file gets in', () => {
    assert.match(
      fontProblems('@font-face { font-family: X; src: url(/x.woff2) }').join(' '),
      /@font-face is not allowed/,
    );
    assert.match(
      fontProblems('@import url("https://fonts.googleapis.com/css2?family=Lobster");').join(' '),
      /@import is not allowed/,
    );
  });

  test('reads the font shorthand too', () => {
    assert.match(fontProblems('p { font: italic bold 12px/1.4 Lobster }').join(' '), /Lobster/);
    assert.deepEqual(fontProblems('p { font: italic bold 12px/1.4 Inter }'), []);
  });

  test('the allowed list is the one the owner approved', () => {
    assert.deepEqual([...ALLOWED_FONTS], [
      'Inter',
      'DM Sans',
      'IBM Plex Sans',
      'Lato',
      'Montserrat',
      'Playfair Display',
    ]);
  });
});
