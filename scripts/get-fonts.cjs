/**
 * Downloads the six licensed fonts and their licence texts.
 *
 * Source: the Google Fonts CSS API (fonts.gstatic.com), which is the official
 * distribution, plus OFL.txt from the google/fonts repository, which is the
 * canonical licence text for each family. Only the `latin` and `latin-ext`
 * subsets are kept: latin-ext is what carries Czech, Polish and the rest of
 * central European text, and the other subsets would triple the size.
 *
 * Writes:
 *   public/fonts/<slug>/*.woff2
 *   public/fonts/<slug>/OFL.txt   (or LICENSE.txt)
 *   public/css/fonts.css          (@font-face, pointing at /assets/fonts/...)
 *   public/fonts/NOTICES.md       (family, licence, source, sha256)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FAMILIES = [
  { name: 'Inter', slug: 'inter', dir: 'ofl/inter', weights: '400;500;600;700' },
  { name: 'DM Sans', slug: 'dm-sans', dir: 'ofl/dmsans', weights: '400;500;600;700' },
  { name: 'IBM Plex Sans', slug: 'ibm-plex-sans', dir: 'ofl/ibmplexsans', weights: '400;500;600;700' },
  { name: 'Lato', slug: 'lato', dir: 'ofl/lato', weights: '400;700' },
  { name: 'Montserrat', slug: 'montserrat', dir: 'ofl/montserrat', weights: '400;500;600;700' },
  { name: 'Playfair Display', slug: 'playfair-display', dir: 'ofl/playfairdisplay', weights: '400;500;600;700' },
];

const KEEP = ['latin', 'latin-ext'];

async function text(url, label) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(label + ': ' + res.status + ' ' + url);
  return res.text();
}

async function bytes(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error('font file: ' + res.status + ' ' + url);
  return Buffer.from(await res.arrayBuffer());
}

/** Splits the API's CSS into blocks, each tagged with its subset comment. */
function blocks(css) {
  const out = [];
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/gi;
  let m;
  while ((m = re.exec(css))) out.push({ subset: m[1], rule: m[2] });
  return out;
}

async function main() {
  const root = 'C:/Temp/Ticketing system';
  const fontsDir = path.join(root, 'public/fonts');
  fs.mkdirSync(fontsDir, { recursive: true });

  const cssParts = [
    '/* Fonts served by this application.',
    ' *',
    ' * Downloaded from the Google Fonts API (fonts.gstatic.com) on ' +
      new Date().toISOString().slice(0, 10) +
      '. Every family here is licensed under the SIL Open Font License 1.1,',
    ' * which permits commercial use, bundling and serving, provided the licence',
    ' * travels with the files: each family\'s OFL.txt sits beside its woff2 in',
    ' * public/fonts/<family>/, and public/fonts/NOTICES.md records the lot.',
    ' *',
    ' * Only the latin and latin-ext subsets are shipped. latin-ext is what',
    ' * carries Czech and the rest of central Europe; the other subsets would',
    ' * cost several times the size for text this service desk does not show.',
    ' *',
    ' * GENERATED - re-run scripts/get-fonts.cjs rather than editing by hand.',
    ' */',
    '',
  ];

  const notices = [
    '# Fonts shipped with this application',
    '',
    'Downloaded ' + new Date().toISOString().slice(0, 10) + ' from the Google Fonts',
    'API (`fonts.gstatic.com`), the official distribution. Each licence text comes',
    'from the canonical `google/fonts` repository and sits beside its font files.',
    '',
    '**All six are licensed under the SIL Open Font License, Version 1.1**, which',
    'permits use, study, modification and redistribution, including as part of',
    'commercial software, provided the font files are not sold on their own and',
    'the licence notice travels with them. Nothing here is modified.',
    '',
    '| Family | Licence | Files | Source |',
    '| --- | --- | --- | --- |',
  ];

  const sums = [];

  for (const family of FAMILIES) {
    const slug = family.slug;
    const dir = path.join(fontsDir, slug);
    fs.mkdirSync(dir, { recursive: true });

    const api =
      'https://fonts.googleapis.com/css2?family=' +
      encodeURIComponent(family.name).replace(/%20/g, '+') +
      ':wght@' +
      family.weights +
      '&display=swap';

    const css = await text(api, family.name + ' css');
    const wanted = blocks(css).filter((b) => KEEP.includes(b.subset));
    if (wanted.length === 0) throw new Error(family.name + ': no latin blocks in the CSS');

    let files = 0;
    const rules = [];

    for (const block of wanted) {
      let rule = block.rule;
      const urls = [...rule.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)];
      for (const [, url] of urls) {
        const name = decodeURIComponent(url.split('/').pop());
        const target = path.join(dir, name);
        if (!fs.existsSync(target)) {
          const data = await bytes(url);
          fs.writeFileSync(target, data);
          sums.push({
            family: family.name,
            file: 'public/fonts/' + slug + '/' + name,
            bytes: data.length,
            sha256: crypto.createHash('sha256').update(data).digest('hex').slice(0, 16),
          });
          files++;
        }
        rule = rule.replace(url, '/assets/fonts/' + slug + '/' + name);
      }
      rules.push('/* ' + family.name + ' - ' + block.subset + ' */\n' + rule);
    }

    cssParts.push(rules.join('\n'), '');

    // The licence text, from the family's own folder in google/fonts.
    let licence = '';
    for (const file of ['OFL.txt', 'LICENSE.txt']) {
      try {
        licence = await text(
          'https://raw.githubusercontent.com/google/fonts/main/' + family.dir + '/' + file,
          family.name + ' licence',
        );
        fs.writeFileSync(path.join(dir, file), licence);
        family.licenceFile = file;
        break;
      } catch {
        /* try the next name */
      }
    }
    if (!licence) throw new Error(family.name + ': no licence text found');

    notices.push(
      '| ' +
        family.name +
        ' | SIL OFL 1.1 (`' +
        slug +
        '/' +
        family.licenceFile +
        '`) | ' +
        files +
        ' | https://fonts.google.com/specimen/' +
        family.name.replace(/ /g, '+') +
        ' |',
    );

    console.log(family.name + ': ' + files + ' file(s), licence ' + family.licenceFile);
  }

  notices.push('', '## Files', '', '| File | Bytes | sha256 (first 16) |', '| --- | --- | --- |');
  for (const s of sums) notices.push('| `' + s.file + '` | ' + s.bytes.toLocaleString('en') + ' | `' + s.sha256 + '` |');
  notices.push('');

  // optional, not swap: see the note in the generated file.
  fs.writeFileSync(path.join(root, 'public/css/fonts.css'), cssParts.join('\n').replace(/font-display: swap;/g, 'font-display: optional;'));
  fs.writeFileSync(path.join(fontsDir, 'NOTICES.md'), notices.join('\n'));

  const total = sums.reduce((n, s) => n + s.bytes, 0);
  console.log('\ntotal: ' + sums.length + ' files, ' + Math.round(total / 1024) + ' KB');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
