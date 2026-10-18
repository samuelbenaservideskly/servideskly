import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { settings } from '../src/settings/index.js';
import { themeStylesheet } from '../src/services/branding.js';

/** Appearance - Light and dark mode: which are offered, and each one's own colours. */

let app: Express;
let admin: TestSession;
const URL = '/admin/settings/customization';

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
const save = (form: Record<string, string>) =>
  as(admin).post(URL).type('form').send({ _csrf: admin.csrfToken, appName: 'Service Desk', brandColour: '#635bff', inkColour: '#101828', font: 'helvetica', ...form });

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('modes.admin@example.com', 'admin');
});

describe('light and dark mode', () => {
  test('both behind their own chevrons; worked out until given colours', async () => {
    const page = await as(admin).get(URL).expect(200);
    assert.match(page.text, /<details class="mode-panel mode-panel--light">/);
    assert.match(page.text, /<details class="mode-panel mode-panel--dark">/);
    assert.match(page.text, /name="colourModes" value="both" checked/);
  });

  test("a mode's own colours are used as chosen", async () => {
    await save({ colourModes: 'both', darkOwn: 'on', darkBackground: '#0b1020', darkSurface: '#141a2e', darkText: '#e8ecf5' }).expect(302);
    assert.deepEqual(settings().branding.dark, { background: '#0b1020', surface: '#141a2e', text: '#e8ecf5' });
    assert.deepEqual(settings().branding.light, { background: '', surface: '', text: '' });
    const css = themeStylesheet();
    assert.match(css, /:root\[data-theme='dark'\] \{[^}]*--surface: #141a2e;[^}]*--text: #e8ecf5;/s);
    assert.match(css, /^:root \{[^}]*--surface: #ffffff;/m, 'light mode unchanged');
  });

  test('text that would not stand out from its cards is refused', async () => {
    const res = await save({ colourModes: 'both', lightOwn: 'on', lightBackground: '#ffffff', lightSurface: '#ffffff', lightText: '#f2f2f2' }).expect(400);
    assert.match(res.text, /does not stand out from the card colour/);
  });

  test('without colours of its own, each mode follows the brand - every quick colour gets its own dark mode', async () => {
    const { modePalettes } = await import('../src/services/branding.js');
    const { updateSettings } = await import('../src/settings/index.js');
    const { contrastRatio } = await import('../src/lib/color.js');
    const surfaces: string[] = [];
    for (const brand of ['#635bff', '#0ea5e9', '#12b76a', '#f04438']) {
      await updateSettings({ branding: { brandColour: brand, light: { background: '', surface: '', text: '' }, dark: { background: '', surface: '', text: '' } } } as never, null);
      const p = modePalettes();
      surfaces.push(JSON.stringify(p.darkSurface));
      assert.ok(contrastRatio(p.darkText, p.darkSurface) >= 7, brand + ': dark text reads');
      assert.ok(contrastRatio(p.lightText, p.lightSurface) >= 7, brand + ': light text reads');
      assert.ok(Math.max(p.darkSurface.r, p.darkSurface.g, p.darkSurface.b) < 60, brand + ': dark is dark');
    }
    assert.equal(new Set(surfaces).size, 4, 'four brands, four dark modes - not one navy');
    const green = (await (async () => {
      await updateSettings({ branding: { brandColour: '#12b76a' } } as never, null);
      return modePalettes().darkSurface;
    })());
    assert.ok(green.g > green.r, 'green leans green');
  });

  test('one mode only: everybody gets it, and the switch is not drawn', async () => {
    await save({ colourModes: 'dark' }).expect(302);
    const page = await as(admin).get('/tickets').expect(200);
    assert.match(page.text, /<html lang="en" data-theme="dark"/);
    assert.doesNotMatch(page.text, /class="colour-mode/);
    await save({ colourModes: 'both' }).expect(302);
    assert.match((await as(admin).get('/tickets').expect(200)).text, /class="colour-mode/);
  });
});
