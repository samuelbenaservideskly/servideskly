import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs } from './support/session.js';
import {
  contrastRatio,
  darkenUntilReadable,
  lightenUntilReadable,
  parseColour,
  readableOn,
  toHex,
  toRgbString,
} from '../src/lib/color.js';
import { hasTransparency, storeBrandingAsset, themeStylesheet } from '../src/services/branding.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { HttpError } from '../src/lib/errors.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';

let app: Express;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(48, 9),
]);
const CLEAN_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
);

const WHITE = { r: 255, g: 255, b: 255 };
const INK = { r: 29, g: 29, b: 27 };

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
});

describe('colour parsing', () => {
  test('accepts hex in both lengths', async () => {
    assert.deepEqual(parseColour('#a3182f'), { r: 163, g: 24, b: 47 });
    assert.deepEqual(parseColour('#A3182F'), { r: 163, g: 24, b: 47 });
    assert.deepEqual(parseColour('#fff'), { r: 255, g: 255, b: 255 });
  });

  test('accepts RGB in the forms a person would type', async () => {
    assert.deepEqual(parseColour('rgb(163, 24, 47)'), { r: 163, g: 24, b: 47 });
    assert.deepEqual(parseColour('163, 24, 47'), { r: 163, g: 24, b: 47 });
    assert.deepEqual(parseColour('163 24 47'), { r: 163, g: 24, b: 47 });
    assert.deepEqual(parseColour('  rgb( 0 , 0 , 0 ) '), { r: 0, g: 0, b: 0 });
  });

  test('rejects anything that is not a colour', async () => {
    for (const bad of [
      '',
      'red',
      '#12',
      '#1234567',
      '#gggggg',
      '300, 0, 0',
      'rgb(1,2)',
      'var(--brand)',
    ]) {
      assert.equal(parseColour(bad), null, 'expected ' + JSON.stringify(bad) + ' to be refused');
    }
  });

  test('refuses a value trying to break out into CSS', async () => {
    // The stylesheet is generated from parsed numbers, but the parser is the
    // first line of defence and must reject these outright.
    for (const attack of [
      '#fff; } body { background: url(//evil.test/x) } .x {',
      'red; content: "x"',
      '#a3182f}*{display:none',
      'expression(alert(1))',
      'url(javascript:alert(1))',
    ]) {
      assert.equal(parseColour(attack), null, 'expected ' + attack + ' to be refused');
    }
  });

  test('round-trips through hex and RGB', async () => {
    const parsed = parseColour('rgb(163, 24, 47)');
    assert.ok(parsed);
    assert.equal(toHex(parsed), '#a3182f');
    assert.equal(toRgbString(parsed), '163, 24, 47');
  });
});

describe('contrast derivation', () => {
  test('computes known WCAG ratios', async () => {
    assert.equal(contrastRatio(WHITE, { r: 0, g: 0, b: 0 }).toFixed(0), '21');
    assert.equal(contrastRatio(WHITE, WHITE).toFixed(0), '1');
  });

  test('picks white or ink for text on a brand colour', async () => {
    // Crimson needs white text; a pale yellow needs dark text.
    assert.deepEqual(readableOn({ r: 163, g: 24, b: 47 }, INK), WHITE);
    assert.deepEqual(readableOn({ r: 250, g: 240, b: 120 }, INK), INK);
  });

  test('lightens an accent until it is readable on a dark surface', async () => {
    const brand = { r: 163, g: 24, b: 47 };
    assert.ok(contrastRatio(brand, INK) < 4.5, 'the raw brand colour fails on ink');
    const adjusted = lightenUntilReadable(brand, INK, 4.5);
    assert.ok(
      contrastRatio(adjusted, INK) >= 4.5,
      'the adjusted accent must reach 4.5:1, got ' + contrastRatio(adjusted, INK).toFixed(2),
    );
  });

  test('darkens an accent until it is readable on white', async () => {
    // A bright colour that fails on white must be brought down.
    const bright = { r: 255, g: 214, b: 0 };
    assert.ok(contrastRatio(bright, WHITE) < 4.5);
    const adjusted = darkenUntilReadable(bright, WHITE, 4.5);
    assert.ok(contrastRatio(adjusted, WHITE) >= 4.5);
  });

  test('handles a colour that already passes, unchanged', async () => {
    const dark = { r: 20, g: 20, b: 20 };
    assert.deepEqual(darkenUntilReadable(dark, WHITE, 4.5), dark);
  });
});

describe('generated stylesheet', () => {
  test('carries the configured brand colour and nothing else', async () => {
    await updateSettings({ branding: { brandColour: '#1f6f4a', inkColour: '#101010' } }, null);
    const css = themeStylesheet();

    assert.match(css, /--brand: #1f6f4a;/);
    assert.match(css, /:root \{/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    // Only hex values and custom properties: no urls, no imports, no braces
    // from user input.
    assert.doesNotMatch(css, /url\(/i);
    assert.doesNotMatch(css, /@import/i);
    assert.doesNotMatch(css, /expression\(/i);
  });

  test('produces an accent that meets 4.5:1 in both themes', async () => {
    // Deliberately awkward: a mid-tone that fails on both white and near-black.
    await updateSettings({ branding: { brandColour: '#7a6f00', inkColour: '#1d1d1b' } }, null);
    const css = themeStylesheet();

    const light = /:root \{[\s\S]*?--accent: (#[0-9a-f]{6});/.exec(css);
    const dark = /prefers-color-scheme: dark\)[\s\S]*?--accent: (#[0-9a-f]{6});/.exec(css);
    assert.ok(light && dark, 'both accents should be emitted');

    const lightAccent = parseColour(light[1] as string);
    const darkAccent = parseColour(dark[1] as string);
    assert.ok(lightAccent && darkAccent);

    assert.ok(
      contrastRatio(lightAccent, WHITE) >= 4.4,
      'light accent contrast ' + contrastRatio(lightAccent, WHITE).toFixed(2),
    );
    assert.ok(
      contrastRatio(darkAccent, { r: 29, g: 29, b: 27 }) >= 4.4,
      'dark accent contrast ' + contrastRatio(darkAccent, INK).toFixed(2),
    );
  });

  test('falls back to a sane palette when a stored value is unusable', async () => {
    // The route validates input, so this can only happen if the row is edited
    // by hand. It must not produce broken CSS.
    await updateSettings({ branding: { brandColour: 'not-a-colour' } }, null);
    const css = themeStylesheet();
    assert.match(css, /--brand: #[0-9a-f]{6};/);
  });
});

describe('branding asset verification', () => {
  test('accepts a real PNG and a clean SVG', async () => {
    const png = storeBrandingAsset('logo', 'logo.png', PNG);
    assert.equal(png.contentType, 'image/png');
    // Never named after the upload.
    assert.doesNotMatch(png.file, /logo/);

    const svg = storeBrandingAsset('logo', 'mark.svg', CLEAN_SVG);
    assert.equal(svg.contentType, 'image/svg+xml');
  });

  test('refuses an SVG carrying script or handlers', async () => {
    const cases: [string, RegExp][] = [
      ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', /script element/],
      ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', /event handler/],
      ['<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>', /javascript/],
      ['<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>', /foreignObject/],
      ['<svg xmlns="http://www.w3.org/2000/svg"><iframe/></svg>', /iframe/],
    ];
    for (const [markup, expected] of cases) {
      assert.throws(
        () => storeBrandingAsset('logo', 'evil.svg', Buffer.from(markup)),
        (err: unknown) =>
          err instanceof HttpError && err.status === 400 && expected.test(err.message),
        'expected refusal for ' + markup.slice(0, 40),
      );
    }
  });

  test('refuses a file whose bytes contradict its extension', async () => {
    assert.throws(
      () => storeBrandingAsset('logo', 'fake.png', Buffer.from('<html>not a png</html>')),
      (err: unknown) => err instanceof HttpError && err.code === 'type_mismatch',
    );
  });

  test('refuses formats that are not images', async () => {
    for (const name of ['payload.html', 'sheet.css', 'tool.exe', 'doc.pdf']) {
      assert.throws(
        () => storeBrandingAsset('logo', name, PNG),
        (err: unknown) => err instanceof HttpError && err.code === 'type_not_allowed',
        'expected ' + name + ' to be refused',
      );
    }
  });

  test('refuses an empty file', async () => {
    assert.throws(
      () => storeBrandingAsset('logo', 'empty.png', Buffer.alloc(0)),
      (err: unknown) => err instanceof HttpError && err.code === 'empty_file',
    );
  });
});

describe('branding over HTTP', () => {
  test('the theme stylesheet is public and correctly typed', async () => {
    const response = await request(app).get('/branding/theme.css').expect(200);
    assert.match(response.headers['content-type'] ?? '', /text\/css/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.text, /--brand:/);
  });

  test('a default favicon is served before one is uploaded', async () => {
    await updateSettings({ branding: { favicon: null } }, null);
    const response = await request(app).get('/branding/favicon').expect(200);
    assert.match(response.headers['content-type'] ?? '', /image\/svg\+xml/);
    // supertest hands back a Buffer for an image content type.
    const svg = Buffer.from(response.body).toString('utf8');
    // A plain square in the brand colour: no lettering, no invented mark.
    assert.match(svg, /<rect/);
    assert.doesNotMatch(svg, /<text/);
    assert.match(response.headers['content-security-policy'] ?? '', /sandbox/);
  });

  test('/favicon.ico is answered too', async () => {
    await request(app).get('/favicon.ico').expect(200);
  });

  test('no logo is served until one is uploaded', async () => {
    await updateSettings({ branding: { logo: null } }, null);
    await request(app).get('/branding/logo').expect(404);
  });

  test('an uploaded logo is served back, sandboxed', async () => {
    const session = await signInAs('brand.admin@example.com', 'admin');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    await agent
      .post('/admin/settings/customization/logo/upload')
      .field('_csrf', session.csrfToken)
      .attach('image', PNG, { filename: 'company.png', contentType: 'image/png' })
      .expect(302);

    const logo = await agent.get('/branding/logo').expect(200);
    assert.equal(logo.headers['content-type'], 'image/png');
    assert.equal(logo.headers['x-content-type-options'], 'nosniff');
    assert.match(logo.headers['content-security-policy'] ?? '', /sandbox/);
    assert.ok(Buffer.from(logo.body).equals(PNG));

    // And it appears in the page chrome.
    const page = await agent.get('/tickets').expect(200);
    assert.match(page.text, /\/branding\/logo\?v=/);
  });

  test('an upload without a CSRF token is refused', async () => {
    const session = await signInAs('brand.nocsrf@example.com', 'admin');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    await agent
      .post('/admin/settings/customization/logo/upload')
      .attach('image', PNG, { filename: 'x.png', contentType: 'image/png' })
      .expect(403);
  });

  test('a non-admin cannot change branding', async () => {
    const session = await signInAs('brand.user@example.com', 'user');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    await agent.get('/admin/settings/customization').expect(403);
    await agent
      .post('/admin/settings/customization')
      .type('form')
      .send({ _csrf: session.csrfToken, appName: 'Hijacked', brandColour: '#000000', inkColour: '#ffffff' })
      .expect(403);
  });

  test('the colour form accepts a typed RGB value and normalises it', async () => {
    const session = await signInAs('brand.colour@example.com', 'admin');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    await agent
      .post('/admin/settings/customization')
      .type('form')
      .send({
        _csrf: session.csrfToken,
        appName: 'Renamed Desk',
        brandColour: '#000000',
        brandColourTyped: 'rgb(31, 111, 74)',
        inkColour: '#1d1d1b',
      })
      .expect(302);

    // The typed value wins over the picker, and is stored as normalised hex.
    assert.equal(settings().branding.brandColour, '#1f6f4a');
    assert.equal(settings().branding.appName, 'Renamed Desk');
    const css = await request(app).get('/branding/theme.css').expect(200);
    assert.match(css.text, /--brand: #1f6f4a;/);
  });

  test('an invalid colour is refused with an explanation', async () => {
    const session = await signInAs('brand.bad@example.com', 'admin');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    const before = settings().branding.brandColour;
    const response = await agent
      .post('/admin/settings/customization')
      .type('form')
      .send({
        _csrf: session.csrfToken,
        appName: 'Desk',
        brandColour: '#000000',
        brandColourTyped: '#fff; } body { display: none } .x {',
        inkColour: '#1d1d1b',
      })
      .expect(400);

    assert.match(response.text, /not a valid hex or RGB value/i);
    assert.equal(settings().branding.brandColour, before, 'nothing may be stored');
  });
});

describe('a transparent logo needs no white plate', () => {
  test('alpha is read from the file, and anything unknown keeps the plate', () => {
    // A PNG header: signature, length, 'IHDR', 4+4 bytes of size, bit
    // depth, then the colour type - 6 is RGB with alpha, 2 is RGB without.
    const png = (colourType: number) => {
      const bytes = Buffer.alloc(40);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
      Buffer.from('IHDR', 'ascii').copy(bytes, 12);
      bytes[24] = 8;
      bytes[25] = colourType;
      return bytes;
    };

    assert.equal(hasTransparency(png(6), 'image/png'), true, 'RGBA');
    assert.equal(hasTransparency(png(4), 'image/png'), true, 'grey with alpha');
    assert.equal(hasTransparency(png(2), 'image/png'), false, 'RGB');

    // A palette image says which entry is see-through in a tRNS chunk.
    const paletted = Buffer.concat([png(3), Buffer.from('tRNS', 'ascii')]);
    assert.equal(hasTransparency(paletted, 'image/png'), true);

    // Vector artwork is transparent unless it draws a background; a
    // photograph never is.
    assert.equal(hasTransparency(Buffer.from('<svg/>'), 'image/svg+xml'), true);
    assert.equal(hasTransparency(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'), false);
  });

  test('the stylesheet says which, and an old asset keeps its plate', () => {
    const css = themeStylesheet();
    assert.match(css, /--logo-plate:/);
  });
});
