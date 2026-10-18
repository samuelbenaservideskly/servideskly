import './env.js';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { adoptInitialBranding } from '../src/services/branding.js';
import { loadSettings, settings, updateSettings } from '../src/settings/index.js';
import { execute } from '../src/db/index.js';

/**
 * The logo a provisioned helpdesk starts with (asked for 16 Oct 2026).
 *
 * The customer portal sets INITIAL_LOGO_URL on the new web app and this
 * reads it once. What is worth testing is the "once", and that it never
 * reaches over a logo somebody has already uploaded.
 */

/** A one-pixel PNG, so the store's checks have real bytes to look at. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let server: http.Server;
let origin = '';
let served = 0;

before(async () => {
  await bootstrapTestDatabase();
  server = http.createServer((req, res) => {
    served += 1;
    if (req.url === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
  delete process.env.INITIAL_LOGO_URL;
  delete process.env.INITIAL_FAVICON_URL;
});

describe('the branding a new helpdesk starts with', () => {
  test('does nothing at all when the provisioner named none', async () => {
    delete process.env.INITIAL_LOGO_URL;
    await adoptInitialBranding();
    assert.equal(settings().branding.logo, null);
  });

  test('installs the logo the provisioner named, once', async () => {
    process.env.INITIAL_LOGO_URL = origin + '/logo.png';
    await adoptInitialBranding();
    await loadSettings();

    const logo = settings().branding.logo;
    assert.ok(logo, 'a logo was installed');
    assert.equal(logo.contentType, 'image/png');
    assert.equal(logo.byteSize, PNG.length);
    const fetched = served;

    // A restart must not put it back over whatever the customer did next.
    await updateSettings({ branding: { logo: null } }, null);
    await adoptInitialBranding();
    await loadSettings();
    assert.equal(settings().branding.logo, null, 'it is not installed twice');
    assert.equal(served, fetched, 'and not even fetched again');
  });

  test('never over a logo somebody uploaded, and never fatal', async () => {
    await execute('DELETE FROM seed_markers WHERE key = ?', ['initial_branding']);
    const own = {
      file: 'theirs.png', contentType: 'image/png', byteSize: 10,
      sha256: 'x', originalName: 'theirs.png', uploadedAt: new Date().toISOString(),
    };
    await updateSettings({ branding: { logo: own } }, null);
    await loadSettings();

    await adoptInitialBranding();
    await loadSettings();
    assert.equal(settings().branding.logo?.file, 'theirs.png');

    // A portal that is down is not a reason for a service desk not to start.
    await execute('DELETE FROM seed_markers WHERE key = ?', ['initial_branding']);
    await updateSettings({ branding: { logo: null } }, null);
    await loadSettings();
    process.env.INITIAL_LOGO_URL = origin + '/gone.png';
    await adoptInitialBranding();
    await loadSettings();
    assert.equal(settings().branding.logo, null, 'no logo, and no exception');
  });
});
