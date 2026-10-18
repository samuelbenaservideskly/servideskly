import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { listCustomImages } from '../src/services/custom-images.js';
import { inlineImagesFor, previewHtml } from '../src/services/mail/inline-images.js';

const BASE = '/admin/settings/customization/images';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(48, 9),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
);

let app: Express;
let admin: TestSession;
let user: TestSession;

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

function upload(name: string, bytes: Buffer, filename: string) {
  return as(admin)
    .post(BASE)
    .field('_csrf', admin.csrfToken)
    .field('name', name)
    .attach('image', bytes, filename);
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('img.admin@example.com', 'admin');
  user = await signInAs('img.user@example.com', 'user');
});

describe('custom images', () => {
  test('a tab of Customisation, for administrators only', async () => {
    const page = await as(admin).get(BASE).expect(200);
    assert.match(page.text, /aria-current="page">Custom images/);
    await as(user).get(BASE).expect(403);
  });

  test('an upload is listed with a web snippet, an email snippet and its address', async () => {
    await upload('Header banner', PNG, 'banner.png').expect(302);
    const [image] = await listCustomImages();
    assert.ok(image);

    const page = await as(admin).get(BASE).expect(200);
    assert.match(page.text, new RegExp('&lt;img src="/images/' + image.id));
    assert.match(page.text, new RegExp('cid:image-' + image.id));
    assert.match(page.text, /\/images\//);
  });

  test('the image is served publicly, with its verified type and a sandbox', async () => {
    const [image] = await listCustomImages();
    const served = await request(app).get('/images/' + image!.id).expect(200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.match(String(served.headers['content-security-policy']), /sandbox/);
    await request(app).get('/images/not-a-real-id').expect(404);
  });

  test('a notification can carry it inline with cid:image-<id>', async () => {
    const [image] = await listCustomImages();
    const body = '<p>Hi</p><img src="cid:image-' + image!.id + '" alt="">';
    const inline = await inlineImagesFor(body);
    assert.equal(inline.length, 1);
    assert.equal(inline[0]?.cid, 'image-' + image!.id);
    assert.match(await previewHtml(body), /src="data:image\/png;base64,/);
  });

  test('an SVG works on a web page but is not offered for email', async () => {
    await upload('Vector mark', SVG, 'mark.svg').expect(302);
    const page = await as(admin).get(BASE).expect(200);
    assert.match(page.text, /Mail clients cannot show this type/);
    const svg = (await listCustomImages()).find((i) => i.name === 'Vector mark')!;
    assert.deepEqual(await inlineImagesFor('<img src="cid:image-' + svg.id + '">'), []);
  });

  test('a file that is not what it says is refused in the dialog', async () => {
    const refused = await upload('Fake', Buffer.from('<html>not a png</html>'), 'fake.png').expect(400);
    assert.match(refused.text, /dialog--open/);
    assert.match(refused.text, /do not match/);
  });

  test('a duplicate name is refused, and so is an upload with no token', async () => {
    const dup = await upload('header banner', PNG, 'again.png').expect(400);
    assert.match(dup.text, /already exists/);
    await as(admin).post(BASE).field('name', 'x').attach('image', PNG, 'x.png').expect(403);
  });

  test('removing one deletes it and its address stops working', async () => {
    const image = (await listCustomImages()).find((i) => i.name === 'Header banner')!;
    await as(admin)
      .post(BASE + '/' + image.id + '/delete')
      .type('form')
      .send({ _csrf: admin.csrfToken })
      .expect(302);
    await request(app).get('/images/' + image.id).expect(404);
  });
});

describe('a long list of images', () => {
  test('rows start closed, even the one just uploaded, which is highlighted instead', async () => {
    const created = await upload('Footer strip', PNG, 'footer.png').expect(302);
    const location = String(created.headers.location);
    assert.match(location, /^\/admin\/settings\/customization\/images#image-/);
    const page = await as(admin).get(BASE).expect(200);
    assert.doesNotMatch(page.text, /<details class="card image-row"[^>]* open>/);
    assert.match(page.text, /class="image-row__chevron"/);
  });

  test('searching by name narrows the list', async () => {
    const page = await as(admin).get(BASE + '?q=footer').expect(200);
    assert.match(page.text, /Footer strip/);
    assert.doesNotMatch(page.text, /Vector mark/);
  });
});

describe('copy buttons', () => {
  test('the images page may load its one script; neighbours may not', async () => {
    await upload('Copy me', PNG, 'copy.png').expect(302);
    const page = await as(admin).get(BASE).expect(200);
    const policy = String(page.headers['content-security-policy']);
    assert.match(policy, /script-src 'self'/);
    assert.doesNotMatch(policy, /unsafe-inline/);
    assert.match(page.text, /<script src="\/assets\/js\/copy\.js\?v=/);

    for (const other of ['/admin/settings/customization', '/admin/settings/customization/locale']) {
      const res = await as(admin).get(other).expect(200);
      assert.doesNotMatch(res.text, /copy\.js/, other);
      const scripts = res.text.match(/<script src="[^"]+"/g) ?? [];
      assert.ok(scripts.every((s) => s.includes('/assets/js/select-search.js')), other);
    }
  });

  test('buttons are hidden until the script reveals them, and carry what they copy', async () => {
    const page = await as(admin).get(BASE).expect(200);
    const image = (await listCustomImages()).find((i) => i.name === 'Copy me')!;
    assert.match(page.text, new RegExp('data-copy="&lt;img src=&#34;/images/' + image.id + '&#34;'));
    assert.match(page.text, /class="copy-btn"[^>]*hidden>/);
    assert.match(page.text, /<span class="copy-btn__tag">Web<\/span>/);
  });

  test('the script itself is served', async () => {
    const js = await request(app).get('/assets/js/copy.js').expect(200);
    assert.match(js.text, /navigator\.clipboard/);
  });
});

describe('the bin on a closed row', () => {
  test('sits in the row header and submits a form outside it', async () => {
    const image = (await listCustomImages()).find((i) => i.name === 'Copy me')!;
    const page = await as(admin).get(BASE).expect(200);
    const summary = page.text.slice(page.text.indexOf('id="image-' + image.id + '"'));
    const header = summary.slice(0, summary.indexOf('</summary>'));
    assert.match(header, new RegExp('form="delete-' + image.id + '"'));
    assert.match(page.text, new RegExp('<form id="delete-' + image.id + '" method="post"'));
  });
});

describe('a private image', () => {
  test('answers only a signed-in person, is never cached publicly, and still goes in emails', async () => {
    await as(admin)
      .post(BASE)
      .field('_csrf', admin.csrfToken)
      .field('name', 'Internal diagram')
      .field('isPrivate', 'on')
      .attach('image', PNG, 'diagram.png')
      .expect(302);
    const image = (await listCustomImages()).find((i) => i.name === 'Internal diagram')!;
    assert.equal(image.is_private, true);

    await request(app).get('/images/' + image.id).expect(404);
    const seen = await as(user).get('/images/' + image.id).expect(200);
    assert.match(String(seen.headers['cache-control']), /^private/);

    const mail = await inlineImagesFor('<img src="cid:image-' + image.id + '">');
    assert.equal(mail.length, 1, 'email carries it all the same');

    // Made public again: anybody can load it.
    await as(admin).post(BASE + '/' + image.id + '/private').type('form').send({ _csrf: admin.csrfToken }).expect(302);
    await request(app).get('/images/' + image.id).expect(200);
  });
});
