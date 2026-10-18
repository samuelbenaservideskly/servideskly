/**
 * Colour handling for the customisable theme.
 *
 * Every value that reaches the generated stylesheet passes through
 * `parseHexColour` first and is re-serialised from its numeric components, so
 * nothing a user types can escape into CSS. A value that does not parse is
 * rejected outright rather than sanitised.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Accepts `#rgb`, `#rrggbb`, `rgb(r, g, b)` and bare `r, g, b`, and returns
 * the numeric components. Returns null for anything else.
 */
export function parseColour(input: string): Rgb | null {
  const value = input.trim().toLowerCase();

  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (shortHex) {
    return {
      r: parseInt((shortHex[1] as string).repeat(2), 16),
      g: parseInt((shortHex[2] as string).repeat(2), 16),
      b: parseInt((shortHex[3] as string).repeat(2), 16),
    };
  }

  const longHex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(value);
  if (longHex) {
    return {
      r: parseInt(longHex[1] as string, 16),
      g: parseInt(longHex[2] as string, 16),
      b: parseInt(longHex[3] as string, 16),
    };
  }

  // rgb(163, 24, 47) or 163, 24, 47 or 163 24 47
  const numeric = /^(?:rgb\s*\(\s*)?(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*\)?$/.exec(value);
  if (numeric) {
    const parts = [numeric[1], numeric[2], numeric[3]].map((n) => Number(n));
    if (parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return { r: parts[0] as number, g: parts[1] as number, b: parts[2] as number };
    }
  }

  return null;
}

const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toHex({ r, g, b }: Rgb): string {
  const hex = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

export function toRgbString({ r, g, b }: Rgb): string {
  return clampByte(r) + ', ' + clampByte(g) + ', ' + clampByte(b);
}

/** Relative luminance, per WCAG 2.1. */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (raw: number) => {
    const c = clampByte(raw) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Whichever of white or the given dark colour reads better on `background`. */
export function readableOn(background: Rgb, dark: Rgb): Rgb {
  return contrastRatio(background, WHITE) >= contrastRatio(background, dark) ? WHITE : dark;
}

// --- HSL, used to derive theme variants from one brand colour --------------

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function toHsl({ r, g, b }: Rgb): Hsl {
  const rn = clampByte(r) / 255;
  const gn = clampByte(g) / 255;
  const bn = clampByte(b) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / delta + 2) / 6;
    else h = ((rn - gn) / delta + 4) / 6;
  }
  return { h: h * 360, s, l };
}

export function fromHsl({ h, s, l }: Hsl): Rgb {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = Math.max(0, Math.min(1, s));
  const light = Math.max(0, Math.min(1, l));

  if (sat === 0) {
    const grey = light * 255;
    return { r: grey, g: grey, b: grey };
  }

  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  return {
    r: channel(hue + 1 / 3) * 255,
    g: channel(hue) * 255,
    b: channel(hue - 1 / 3) * 255,
  };
}

export function withLightness(colour: Rgb, lightness: number): Rgb {
  const hsl = toHsl(colour);
  return fromHsl({ h: hsl.h, s: hsl.s, l: lightness });
}

/** Blends towards a target, 0 = unchanged, 1 = fully the target. */
export function mix(colour: Rgb, target: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: colour.r + (target.r - colour.r) * t,
    g: colour.g + (target.g - colour.g) * t,
    b: colour.b + (target.b - colour.b) * t,
  };
}

/**
 * Raises a colour's lightness until it meets a contrast target against a
 * background, so a dark theme stays readable whatever brand colour is chosen.
 * Gives up at white rather than looping.
 */
export function lightenUntilReadable(colour: Rgb, background: Rgb, target = 4.5): Rgb {
  let candidate = colour;
  for (let step = 0; step < 40; step += 1) {
    if (contrastRatio(candidate, background) >= target) return candidate;
    const hsl = toHsl(candidate);
    if (hsl.l >= 0.98) break;
    candidate = fromHsl({ h: hsl.h, s: hsl.s, l: Math.min(0.98, hsl.l + 0.025) });
  }
  return candidate;
}

/** Lowers a colour's lightness until it is readable on a light background. */
export function darkenUntilReadable(colour: Rgb, background: Rgb, target = 4.5): Rgb {
  let candidate = colour;
  for (let step = 0; step < 40; step += 1) {
    if (contrastRatio(candidate, background) >= target) return candidate;
    const hsl = toHsl(candidate);
    if (hsl.l <= 0.02) break;
    candidate = fromHsl({ h: hsl.h, s: hsl.s, l: Math.max(0.02, hsl.l - 0.025) });
  }
  return candidate;
}
