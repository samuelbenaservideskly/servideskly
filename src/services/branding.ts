import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  contrastRatio,
  darkenUntilReadable,
  lightenUntilReadable,
  luminance,
  mix,
  parseColour,
  readableOn,
  toHex,
  toRgbString,
  withLightness,
  type Rgb,
} from '../lib/color.js';
import { settings, settingsDocument, updateSettings } from '../settings/index.js';
import { execute, queryOne } from '../db/index.js';
import { nowIso } from '../lib/util.js';

const log = logger.child({ module: 'branding' });

/** Uploaded logos and favicons live under UPLOAD_DIR, not in the web root. */
export const BRANDING_DIR = path.join(config.uploadDir, 'branding');

export interface BrandingAsset {
  file: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalName: string;
  uploadedAt: string;
  /**
   * Whether the artwork carries its own transparency.
   *
   * A logo sits on a white plate so a dark wordmark stays legible against a
   * dark topbar - but a logo made *for* a dark background arrives with a
   * transparent ground, and a white rectangle behind it is exactly what its
   * author avoided. Reported 16 Oct 2026 ("when transparent logo is added,
   * does it remove the white background? it should").
   *
   * Absent on an asset uploaded before this existed, which reads as false
   * and keeps the plate - the safe way round, since a dark logo without one
   * disappears.
   */
  transparent?: boolean;
}

interface AssetRule {
  contentType: string;
  extensions: string[];
  magic: readonly (readonly number[])[];
}

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const GIF = [0x47, 0x49, 0x46, 0x38];
const ICO = [0x00, 0x00, 0x01, 0x00];
const WEBP = [0x52, 0x49, 0x46, 0x46];

const LOGO_RULES: readonly AssetRule[] = [
  { contentType: 'image/svg+xml', extensions: ['.svg'], magic: [] },
  { contentType: 'image/png', extensions: ['.png'], magic: [PNG] },
  { contentType: 'image/jpeg', extensions: ['.jpg', '.jpeg'], magic: [JPEG] },
  { contentType: 'image/webp', extensions: ['.webp'], magic: [WEBP] },
];

const FAVICON_RULES: readonly AssetRule[] = [
  { contentType: 'image/svg+xml', extensions: ['.svg'], magic: [] },
  { contentType: 'image/png', extensions: ['.png'], magic: [PNG] },
  { contentType: 'image/x-icon', extensions: ['.ico'], magic: [ICO] },
  { contentType: 'image/gif', extensions: ['.gif'], magic: [GIF] },
];

export const LOGO_EXTENSIONS = LOGO_RULES.flatMap((r) => r.extensions);
export const FAVICON_EXTENSIONS = FAVICON_RULES.flatMap((r) => r.extensions);

/** 1 MB is generous for a logo and keeps the response small. */
export const MAX_BRANDING_BYTES = 1024 * 1024;

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, index) => buffer[index] === byte);
}

/**
 * SVG is the right format for a logo but is also a document format that can
 * carry script. Two independent defences are used, in this order of
 * importance:
 *
 *  1. the route serves it with `sandbox` in its Content-Security-Policy, so
 *     script cannot run even if this screen is incomplete - a pattern list
 *     over a markup language is never provably exhaustive;
 *  2. the markup is screened here, so an obviously hostile file is refused at
 *     upload with an explanation rather than stored and quietly neutered.
 */
function screenSvg(bytes: Buffer): void {
  const text = bytes.toString('utf8');
  if (!/<svg[\s/>]/i.test(text)) {
    throw badRequest('That file is not an SVG image.', 'not_svg');
  }
  // Element names are matched up to a whitespace, '/' or '>' boundary. The
  // slash matters: `<script/>` and `<script xlink:href="evil.js"/>` are valid
  // self-closing XML, and a pattern allowing only [\s>] would miss them.
  const dangerous: [RegExp, string][] = [
    [/<script[\s/>]/i, 'a script element'],
    [/<foreignobject[\s/>]/i, 'a foreignObject element'],
    [/<iframe[\s/>]/i, 'an iframe element'],
    [/<embed[\s/>]/i, 'an embed element'],
    [/<object[\s/>]/i, 'an object element'],
    [/<handler[\s/>]/i, 'an SVG handler element'],
    [/<(?:set|animate)[\s/>]/i, 'an animation element, which can retarget attributes'],
    // Any reference out to another origin, however it is spelled.
    [/(?:xlink:)?href\s*=\s*["']?\s*(?:https?:)?\/\//i, 'an external reference'],
    [/\son[a-z]+\s*=/i, 'an event handler attribute'],
    [/javascript\s*:/i, 'a javascript: URL'],
    [/data\s*:\s*text\/html/i, 'an embedded HTML document'],
    [/<!entity/i, 'an XML entity declaration'],
    [/<!doctype/i, 'a DOCTYPE declaration'],
  ];
  for (const [pattern, what] of dangerous) {
    if (pattern.test(text)) {
      throw badRequest(
        'That SVG contains ' + what + ', which is not allowed in an uploaded image.',
        'unsafe_svg',
      );
    }
  }
}

export type BrandingKind = 'logo' | 'favicon';

/**
 * Whether these bytes carry an alpha channel.
 *
 * Read from the file's own header rather than guessed from the extension,
 * and deliberately conservative: anything not understood is opaque, which
 * keeps the white plate. Getting this wrong in that direction costs a
 * rectangle nobody wanted; the other way round loses the logo entirely.
 */
export function hasTransparency(bytes: Buffer, contentType: string): boolean {
  // Vector artwork has no background unless it draws one, and a logo drawn
  // for a web page almost never does.
  if (contentType === 'image/svg+xml') return true;

  if (contentType === 'image/png') {
    // IHDR is the first chunk: width, height, bit depth, then colour type.
    // 4 is grey with alpha, 6 is RGB with alpha.
    const colourType = bytes.length > 25 ? bytes[25] : 0;
    if (colourType === 4 || colourType === 6) return true;
    // A palette image says which entry is see-through in a tRNS chunk.
    return bytes.includes('tRNS', 0, 'ascii');
  }

  if (contentType === 'image/webp') {
    // RIFF....WEBP, then the first chunk. VP8X carries a flags byte whose
    // 0x10 bit is alpha; VP8L (lossless) keeps its own alpha bit.
    const chunk = bytes.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X') return ((bytes[20] ?? 0) & 0x10) !== 0;
    if (chunk === 'VP8L') return ((bytes[24] ?? 0) & 0x08) !== 0;
    return false;
  }

  // JPEG cannot be transparent; GIF can, but a logo in GIF is rare enough
  // that the plate is the better default.
  return false;
}

/** Verifies an upload and writes it to the branding directory. */
export function storeBrandingAsset(
  kind: BrandingKind,
  originalName: string,
  bytes: Buffer,
): BrandingAsset {
  if (bytes.length === 0) throw badRequest('That file is empty.', 'empty_file');
  if (bytes.length > MAX_BRANDING_BYTES) {
    throw badRequest('Images must be 1 MB or smaller.', 'too_large');
  }

  const rules = kind === 'logo' ? LOGO_RULES : FAVICON_RULES;
  const extension = path.extname(originalName).toLowerCase();
  const rule = rules.find((r) => r.extensions.includes(extension));
  if (!rule) {
    throw badRequest(
      'Accepted formats: ' + rules.flatMap((r) => r.extensions).join(', '),
      'type_not_allowed',
    );
  }

  if (rule.contentType === 'image/svg+xml') {
    screenSvg(bytes);
  } else if (!rule.magic.some((signature) => startsWith(bytes, signature))) {
    throw badRequest(
      'The contents of that file do not match its ' + extension + ' extension.',
      'type_mismatch',
    );
  }

  const file = crypto.randomBytes(16).toString('hex') + extension;
  fs.mkdirSync(BRANDING_DIR, { recursive: true });
  fs.writeFileSync(path.join(BRANDING_DIR, file), bytes, { mode: 0o600, flag: 'wx' });

  return {
    file,
    contentType: rule.contentType,
    byteSize: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    originalName: originalName.slice(0, 120),
    uploadedAt: new Date().toISOString(),
    transparent: hasTransparency(bytes, rule.contentType),
  };
}

export function brandingAssetPath(asset: BrandingAsset): string {
  return path.join(BRANDING_DIR, asset.file);
}

/** Removes the file from disk; a missing file is not an error. */
export async function removeBrandingAsset(asset: BrandingAsset): Promise<void> {
  try {
    await fsp.unlink(brandingAssetPath(asset));
  } catch (err) {
    log.warn({ err, file: asset.file }, 'could not remove branding file');
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

export interface ThemeColours {
  brandHex: string;
  brandRgb: string;
  inkHex: string;
  inkRgb: string;
}

/** The configured colours, normalised. */
export function themeColours(): ThemeColours {
  const branding = settings().branding;
  const brand = parseColour(branding.brandColour) ?? { r: 99, g: 91, b: 255 };
  const ink = parseColour(branding.inkColour) ?? { r: 16, g: 24, b: 40 };
  return {
    brandHex: toHex(brand),
    brandRgb: toRgbString(brand),
    inkHex: toHex(ink),
    inkRgb: toRgbString(ink),
  };
}

/**
 * Builds the stylesheet that overrides the palette tokens.
 *
 * Served as its own same-origin stylesheet rather than an inline `<style>`
 * block, because the Content-Security-Policy allows `style-src 'self'` and no
 * inline styles at all. Every value is re-serialised from parsed numeric
 * components, so a colour field cannot inject CSS.
 *
 * The light and dark variants are derived rather than configured: the accent
 * is darkened or lightened until it actually meets a 4.5:1 contrast ratio
 * against its background, so any brand colour stays readable in both themes.
 */
/**
 * The typefaces Appearance offers. Only fonts already on the reader's
 * computer: the policy allows fonts from this origin alone, and a web font
 * would be one more file to fetch on every page. Each is a stack, so a
 * machine without the first gets the closest it has - Helvetica on a Mac,
 * Arial (drawn to Helvetica's metrics) on Windows.
 */
/**
 * The only font families this application names, anywhere.
 *
 * **These six are served from `/assets/fonts`**, so a page looks the same on
 * every machine whether or not the reader has them installed. Six rather
 * than the fourteen first approved, because each is a file to download and
 * six already covers a neutral interface face, a geometric one, a technical
 * one, a warm one, a wide one and a serif. 480 KB in all, latin and
 * latin-ext only - latin-ext is what carries Czech.
 *
 * Every one is under the **SIL Open Font License 1.1**, which permits
 * commercial use, bundling and serving as long as the files are not sold on
 * their own and the notice travels with them. Each family's `OFL.txt` sits
 * beside its woff2 in `public/fonts/<family>/`, and `public/fonts/NOTICES.md`
 * records family, licence, source and checksum. `font-src` stays `'self'`:
 * nothing is fetched from anybody else, so no reader's address reaches a
 * third party either.
 *
 * **Nothing outside this list may be named anywhere** - not in app.css, not
 * in a notification, not in a requester portal's CSS (`fontProblems()`
 * refuses those on save). To add one: check its licence, download it with
 * `scripts/get-fonts.cjs`, add it here, and nowhere else.
 */
export const ALLOWED_FONTS = [
  'Inter',
  'DM Sans',
  'IBM Plex Sans',
  'Lato',
  'Montserrat',
  'Playfair Display',
] as const;

/**
 * Words a font stack may contain besides a family name: the CSS generics and
 * the system keywords. These name no font software at all - they ask the
 * browser for whatever it uses for that purpose.
 */
export const FONT_KEYWORDS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
  'fangsong', 'inherit', 'initial', 'unset', 'revert', 'revert-layer',
]);

/**
 * The font an administrator may choose under Appearance.
 *
 * Inter is the default: it is the face the 2026 design was drawn with, and
 * it degrades to the device's own interface font. A stack ends in a generic
 * so a device with none of them installed still reads properly.
 */
export const FONTS = [
  { key: 'system', label: 'Inter (default)', stack: 'Inter, system-ui, sans-serif' },
  { key: 'dm-sans', label: 'DM Sans', stack: '"DM Sans", system-ui, sans-serif' },
  { key: 'ibm-plex-sans', label: 'IBM Plex Sans', stack: '"IBM Plex Sans", system-ui, sans-serif' },
  { key: 'lato', label: 'Lato', stack: 'Lato, system-ui, sans-serif' },
  { key: 'montserrat', label: 'Montserrat', stack: 'Montserrat, system-ui, sans-serif' },
  { key: 'playfair-display', label: 'Playfair Display', stack: '"Playfair Display", serif' },
] as const;

/** A family named in a stack, lower-cased, or '' for a keyword. */
function familyNames(stack: string): string[] {
  return stack
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
    .filter((name) => !FONT_KEYWORDS.has(name.toLowerCase()))
    .filter((name) => !name.startsWith('var('));
}

/**
 * Why this CSS may not be saved, as far as fonts go, or [] when it may.
 *
 * Three things, each of which would otherwise put a font file in front of a
 * reader without anybody checking its licence:
 *
 * - `@font-face`, which loads one. It is blocked by `font-src 'self'` at
 *   runtime anyway, so it would be stored and then silently do nothing.
 * - `@import`, which is how a Google Fonts stylesheet gets in. Blocked by
 *   `style-src 'self'` for the same reason, and it would send every reader's
 *   address to a third party.
 * - naming a family that is not on the list above.
 */
export function fontProblems(css: string): string[] {
  const problems: string[] = [];

  if (/@font-face/i.test(css)) {
    problems.push(
      '@font-face is not allowed: a font must be one this service desk already ' +
        'licenses. Choose one under Settings - Customisation - Appearance.',
    );
  }
  if (/@import/i.test(css)) {
    problems.push(
      '@import is not allowed. It is how a font or stylesheet from another site ' +
        "gets in, and the page's security policy blocks it anyway.",
    );
  }

  const allowed = new Set(ALLOWED_FONTS.map((name) => name.toLowerCase()));
  const named = new Set<string>();
  for (const [, stack] of css.matchAll(/font-family\s*:\s*([^;}]*)/gi)) {
    for (const family of familyNames(stack ?? '')) {
      if (!allowed.has(family.toLowerCase())) named.add(family);
    }
  }
  // Also `font: bold 14px/1.2 Helvetica` - the shorthand ends in the family.
  for (const [, value] of css.matchAll(/(?:^|[;{])\s*font\s*:\s*([^;}]*)/gi)) {
    const tail = (value ?? '').trim().split(/\s+/).slice(-1)[0] ?? '';
    for (const family of familyNames(tail)) {
      if (!allowed.has(family.toLowerCase())) named.add(family);
    }
  }

  if (named.size > 0) {
    problems.push(
      'These fonts are not available here: ' +
        [...named].join(', ') +
        '. Allowed: ' +
        ALLOWED_FONTS.join(', ') +
        ', and the CSS generics (sans-serif, serif, monospace).',
    );
  }

  return problems;
}

/**
 * Start-up, once (seed marker `branding_2026`): the colours shipped before
 * the 2026 design were a red on near-black. A helpdesk still on exactly
 * those, untouched, moves to the new defaults (navy since 16 Oct 2026; it
 * was electric indigo); one whose colours somebody chose keeps them.
 */
export async function adoptNewDefaultColours(): Promise<void> {
  const b = settingsDocument().branding;
  if (!(await queryOne('SELECT key FROM seed_markers WHERE key = ?', ['branding_2026'])) && b.brandColour.toLowerCase() === '#a3182f' && b.inkColour.toLowerCase() === '#1d1d1b') {
    await updateSettings({ branding: { brandColour: '#101828', inkColour: '#101828' } }, null);
    log.info('the untouched default colours were moved to the new defaults');
  }
  await execute('INSERT INTO seed_markers (key, done_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', ['branding_2026', nowIso()]);
  // The font moved to Helvetica here once. It no longer does: nothing
  // proprietary is named anywhere (see ALLOWED_FONTS), and the default is
  // Inter. A helpdesk that stored 'helvetica' keeps the row; fontStack()
  // does not know the key any more and gives it the default.
  await execute('INSERT INTO seed_markers (key, done_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', ['branding_2026_font', nowIso()]);
  // Petrol (18 Oct 2026): a helpdesk still on the untouched navy, or the
  // indigo before it, moves once; colours somebody chose stay theirs.
  const now = settingsDocument().branding;
  const untouched = ['#101828', '#635bff'].includes(now.brandColour.toLowerCase()) && now.inkColour.toLowerCase() === '#101828';
  if (!(await queryOne('SELECT key FROM seed_markers WHERE key = ?', ['branding_2026_petrol'])) && untouched) {
    await updateSettings({ branding: { brandColour: '#1a5d74', inkColour: '#16181d' } }, null);
    log.info('the untouched default colours were moved to petrol');
  }
  await execute('INSERT INTO seed_markers (key, done_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', ['branding_2026_petrol', nowIso()]);
}

export function fontStack(key: string): string {
  return (FONTS.find((f) => f.key === key) ?? FONTS[0]).stack;
}

/** Text must read on white: below this contrast the ink is darkened. */
export const INK_MIN_CONTRAST = 7;

/** The ink as drawn: the chosen colour, darkened when it is too light to read. */
export function readableInk(ink: Rgb): Rgb {
  return contrastRatio(ink, WHITE) >= INK_MIN_CONTRAST ? ink : darkenUntilReadable(ink, WHITE, INK_MIN_CONTRAST);
}

export function themeStylesheet(): string {
  const branding = settings().branding;
  const brand = parseColour(branding.brandColour) ?? { r: 99, g: 91, b: 255 };
  // The ink is the text on white and the dark theme's surface, so it has to
  // be dark. One chosen too light (a pale grey, a white) would make every
  // word invisible - reported - so it is darkened until body text reads at
  // 7:1 on white, whatever was stored. The settings page refuses it too.
  const ink = readableInk(parseColour(branding.inkColour) ?? { r: 16, g: 24, b: 40 });

  const { lightSurface, lightText, lightBg, darkSurface, darkText, darkBg } = modePalettes();

  // Light theme: brand accent darkened if needed.
  const lightAccent = readableText(brand, lightSurface, 4.5);
  const lightAccentSoft = mix(brand, lightSurface, 0.9);
  const lightBorder = mix(lightText, lightSurface, 0.88);
  const lightBorderStrong = mix(lightText, lightSurface, 0.72);
  const lightMuted = readableText(mix(lightText, lightSurface, 0.55), lightSurface, 4.5);
  const lightSurface2 = mix(lightText, lightSurface, 0.97);

  // Dark theme: brand accent lightened if needed.
  const darkAccent = readableText(brand, darkSurface, 4.5);
  const darkAccentSoft = mix(brand, darkSurface, 0.75);
  const darkBorder = mix(darkSurface, darkText, 0.12);
  const darkBorderStrong = mix(darkSurface, darkText, 0.24);
  const darkMuted = readableText(mix(darkSurface, darkText, 0.62), darkSurface, 4.5);
  const darkSurface2 = mix(darkSurface, darkText, 0.06);

  const brandInk = readableOn(brand, ink);

  // Emitted under two selectors, so the reader can follow the system or
  // override it. See the comment in the generated stylesheet below.
  const darkDeclarations = [
    '  --brand: ' + toHex(brand) + ';',
    '  --brand-ink: ' + toHex(brandInk) + ';',
    '  --bg: ' + toHex(darkBg) + ';',
    '  --surface: ' + toHex(darkSurface) + ';',
    '  --surface-2: ' + toHex(darkSurface2) + ';',
    '  --border: ' + toHex(darkBorder) + ';',
    '  --border-strong: ' + toHex(darkBorderStrong) + ';',
    '  --text: ' + toHex(darkText) + ';',
    '  --text-muted: ' + toHex(darkMuted) + ';',
    '  --accent: ' + toHex(darkAccent) + ';',
    '  --accent-soft: ' + toHex(darkAccentSoft) + ';',
    '  --info-soft: ' + toHex(darkSurface2) + ';',
  ];

  const lines = [
    '/* Generated from the colours set under Admin -> Settings -> Customisation.',
    '   Brand ' + toHex(brand) + ' - contrast on white ' +
      contrastRatio(brand, WHITE).toFixed(2) + ':1,' +
      ' on ' + toHex(ink) + ' ' + contrastRatio(brand, ink).toFixed(2) + ':1.',
    '   The accent is adjusted per theme so text always reaches 4.5:1. */',
    ':root {',
    '  --brand: ' + toHex(brand) + ';',
    '  --brand-rgb: ' + toRgbString(brand) + ';',
    '  --brand-ink: ' + toHex(brandInk) + ';',
    '  --bg: ' + toHex(lightBg) + ';',
    '  --surface: ' + toHex(lightSurface) + ';',
    '  --surface-2: ' + toHex(lightSurface2) + ';',
    '  --border: ' + toHex(lightBorder) + ';',
    '  --border-strong: ' + toHex(lightBorderStrong) + ';',
    '  --text: ' + toHex(lightText) + ';',
    '  --text-muted: ' + toHex(lightMuted) + ';',
    '  --accent: ' + toHex(lightAccent) + ';',
    '  --accent-soft: ' + toHex(lightAccentSoft) + ';',
    '  --info-soft: ' + toHex(mix(lightText, lightSurface, 0.955)) + ';',
    // A constant from FONTS, never typed text: nothing stored reaches here.
    '  --font: ' + fontStack(branding.font ?? 'system') + ';',
    // The white ground behind an uploaded logo: there for a dark wordmark
    // that would vanish on the dark topbar, gone for artwork that brought
    // its own transparency. Two constants, never anything typed.
    '  --logo-plate: ' + (branding.logo?.transparent ? 'transparent' : '#ffffff') + ';',
    '  --logo-plate-pad: ' + (branding.logo?.transparent ? '0' : '0.2rem 0.45rem') + ';',
    '}',
    '',
    '/* The dark palette is emitted twice. Behind the media query it follows',
    '   the operating system, except for a reader who has explicitly chosen',
    '   light. Behind the attribute it applies whatever the system says, and',
    '   comes second so an explicit choice wins. app.css has the same shape. */',
    '@media (prefers-color-scheme: dark) {',
    "  :root:not([data-theme='light']) {",
    ...darkDeclarations.map((line) => '  ' + line),
    '  }',
    '}',
    '',
    ":root[data-theme='dark'] {",
    ...darkDeclarations,
    '}',
    '',
  ];
  return lines.join('\n');
}

/**
 * A colour moved until it reads on a surface: darkened on a light surface,
 * lightened on a dark one. Never moved further than needed.
 */
export function readableText(colour: Rgb, surface: Rgb, target = INK_MIN_CONTRAST): Rgb {
  if (contrastRatio(colour, surface) >= target) return colour;
  return luminance(surface) > 0.18 ? darkenUntilReadable(colour, surface, target) : lightenUntilReadable(colour, surface, target);
}

function toLightness(colour: Rgb): number {
  const max = Math.max(colour.r, colour.g, colour.b) / 255;
  const min = Math.min(colour.r, colour.g, colour.b) / 255;
  return (max + min) / 2;
}

/**
 * The fallback favicon: a plain rounded square in the brand colour, with no
 * lettering or invented mark. It exists only so browsers get something for
 * /favicon.ico until a real one is uploaded.
 */
export function defaultFaviconSvg(): string {
  const { brandHex } = themeColours();
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="12" fill="' +
    brandHex +
    '"/></svg>\n'
  );
}

/** Cache-busting token so a changed asset or colour is picked up at once. */
export function brandingVersion(): string {
  const branding = settings().branding;
  const parts = [
    // The generated stylesheet itself, not just the colours it was built
    // from: a change to the generator must also invalidate the cached copy,
    // or browsers keep serving CSS produced by the previous version.
    themeStylesheet(),
    branding.logo?.sha256 ?? 'none',
    branding.favicon?.sha256 ?? 'none',
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 12);
}

/**
 * Each colour mode's background, surface and text as drawn now - its own
 * colours where set, worked out otherwise. For the pickers on Appearance.
 */
export function modeColours(): Record<'light' | 'dark', { own: boolean; background: string; surface: string; text: string }> {
  const branding = settings().branding;
  const light = branding.light ?? { background: '', surface: '', text: '' };
  const dark = branding.dark ?? { background: '', surface: '', text: '' };
  const p = modePalettes();
  return {
    light: { own: Boolean(light.background || light.surface || light.text), background: toHex(p.lightBg), surface: toHex(p.lightSurface), text: toHex(p.lightText) },
    dark: { own: Boolean(dark.background || dark.surface || dark.text), background: toHex(p.darkBg), surface: toHex(p.darkSurface), text: toHex(p.darkText) },
  };
}

/** The near-black a dark mode is tinted from (#171D20, the design's card). */
const NEAR_BLACK: Rgb = { r: 23, g: 29, b: 32 };
/** The light page: linen, #FCF8F2. */
const LINEN: Rgb = { r: 252, g: 248, b: 242 };

/**
 * Each mode's background, card and text colours: the mode's own where set
 * (Customisation - Light and dark mode), otherwise worked out from the
 * brand - so every brand colour, each quick colour included, gets a light
 * and a dark mode of its own. Dark mode used to be the text colour turned
 * into the background, which made every scheme's dark mode the same navy
 * (reported). Text is always kept at 7:1 on its card.
 *
 * - Light: white cards; the page a faint wash of the brand; the text colour.
 * - Dark: cards a near-black carrying a little of the brand's hue; the page
 *   a shade darker; near-white text.
 */
export function modePalettes(): { lightSurface: Rgb; lightText: Rgb; lightBg: Rgb; darkSurface: Rgb; darkText: Rgb; darkBg: Rgb } {
  const branding = settings().branding;
  const brand = parseColour(branding.brandColour) ?? { r: 99, g: 91, b: 255 };
  const ink = readableInk(parseColour(branding.inkColour) ?? { r: 16, g: 24, b: 40 });
  const own = (value: string | undefined) => (value ? parseColour(value) : null);
  const light = branding.light ?? { background: '', surface: '', text: '' };
  const dark = branding.dark ?? { background: '', surface: '', text: '' };

  const lightSurface = own(light.surface) ?? WHITE;
  const lightText = readableText(own(light.text) ?? ink, lightSurface);
  const lightBg = own(light.background) ?? mix(brand, LINEN, 0.985);

  const darkSurface = own(dark.surface) ?? mix(brand, NEAR_BLACK, 0.94);
  const darkText = readableText(own(dark.text) ?? { r: 236, g: 231, b: 223 }, darkSurface);
  const darkBg = own(dark.background) ?? withLightness(darkSurface, Math.max(0.03, toLightness(darkSurface) - 0.035));
  return { lightSurface, lightText, lightBg, darkSurface, darkText, darkBg };
}

/**
 * The logo and favicon a freshly provisioned helpdesk starts with.
 *
 * Asked for 16 Oct 2026: a customer who orders a service desk from the
 * portal should not have to upload the provider's own mark before it looks
 * like anything. The portal's provisioner sets `INITIAL_LOGO_URL` and
 * `INITIAL_FAVICON_URL` on the new web app, pointing at the images it
 * already serves; this reads them once, at the first start-up.
 *
 * Four things it is careful about, because it runs before anybody has
 * looked at the installation:
 *
 * - **Once ever** (seed marker `initial_branding`), so a restart never
 *   puts the provider's logo back over the customer's own.
 * - **Never over a logo that exists.** An installation that already has one
 *   is one somebody has set up.
 * - **The same store as an upload**, so the file is checked by its bytes,
 *   capped at 1 MB and given the same transparency treatment. A URL is not
 *   more trusted than a person with a file picker.
 * - **It never stops start-up.** A portal that is down, a 404, a timeout:
 *   the service desk comes up unbranded, which is what it did before.
 */
export async function adoptInitialBranding(): Promise<void> {
  const logoUrl = process.env.INITIAL_LOGO_URL ?? '';
  const faviconUrl = process.env.INITIAL_FAVICON_URL ?? '';
  if (!logoUrl && !faviconUrl) return;
  if (await queryOne('SELECT key FROM seed_markers WHERE key = ?', ['initial_branding'])) return;

  const current = settingsDocument().branding;
  const take = async (kind: BrandingKind, url: string): Promise<BrandingAsset | null> => {
    if (!url || current[kind]) return null;
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('answered ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      // The name only carries the extension the store keys its rules on.
      const name = new URL(url).pathname.split('/').pop() || kind + '.png';
      return storeBrandingAsset(kind, name, bytes);
    } catch (err) {
      log.warn({ err, url, kind }, 'the starting ' + kind + ' could not be fetched; carrying on without it');
      return null;
    }
  };

  const logo = await take('logo', logoUrl);
  const favicon = await take('favicon', faviconUrl);
  if (logo || favicon) {
    await updateSettings(
      { branding: { ...(logo ? { logo } : {}), ...(favicon ? { favicon } : {}) } },
      null,
    );
    log.info({ logo: !!logo, favicon: !!favicon }, 'the starting branding was installed');
  }

  await execute(
    'INSERT INTO seed_markers (key, done_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
    ['initial_branding', nowIso()],
  );
}
