import type { Color } from './Types';

/**
 * Parser for CSS-style color strings. Produces a {R, G, B, A} with each
 * channel in [0, 1] — what the renderer consumes.
 *
 * Supported forms:
 *   "#rgb"              → expand to #rrggbb, A=1
 *   "#rgba"             → expand to #rrggbbaa
 *   "#rrggbb"           → A=1
 *   "#rrggbbaa"
 *   "rgb(255, 128, 0)"       → channels in 0-255, A=1
 *   "rgb(255 128 0)"         → CSS4 space-separated form
 *   "rgba(255, 128, 0, 0.5)" → 4th arg is 0-1 alpha
 *   "hsl(200, 50%, 40%)"     → H in 0-360, S/L in 0-100%
 *   "hsla(200, 50%, 40%, 0.5)"
 *   "transparent"        → {0, 0, 0, 0}
 *
 * Parsed results are cached — same string parsed once per process.
 *
 * Named colors deliberately not in v1 — they add a 140-entry lookup table
 * for marginal convenience. Add when a concrete case demands them.
 */

const _cache = new Map<string, Color>();

/** Parse a color string into a Color. Returns a FRESH copy every call so
 *  callers may safely mutate (the style animator writes spring values into
 *  RenderStyle.Background.R etc., and those writes must not reach back into
 *  the parse cache). The cache stores only the canonical parsed form. */
export const ParseColor = (raw: string): Color => {
  let canonical = _cache.get(raw);
  if (canonical === undefined) {
    canonical = _parse(raw.trim().toLowerCase());
    _cache.set(raw, canonical);
  }
  // Fresh copy — caller owns the returned object.
  return { R: canonical.R, G: canonical.G, B: canonical.B, A: canonical.A };
};

const _parse = (s: string): Color => {
  if (s === 'transparent') return { R: 0, G: 0, B: 0, A: 0 };
  if (s.startsWith('#')) return _parseHex(s);
  if (s.startsWith('rgba(') || s.startsWith('rgb(')) return _parseRgb(s);
  if (s.startsWith('hsla(') || s.startsWith('hsl(')) return _parseHsl(s);
  throw new Error(`[Jaui] Unrecognized color: "${s}"`);
};

const _parseHex = (s: string): Color => {
  let hex = s.slice(1);
  if (hex.length === 3) {
    // #rgb → #rrggbb
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  } else if (hex.length === 4) {
    // #rgba → #rrggbbaa
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  if (hex.length !== 6 && hex.length !== 8) {
    throw new Error(`[Jaui] Malformed hex color: "${s}" (expected #rgb, #rgba, #rrggbb, or #rrggbbaa)`);
  }
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  if ([r, g, b, a].some(Number.isNaN)) {
    throw new Error(`[Jaui] Invalid hex digits in color: "${s}"`);
  }
  return { R: r, G: g, B: b, A: a };
};

const _parseHsl = (s: string): Color => {
  const open = s.indexOf('(');
  const close = s.indexOf(')');
  if (open < 0 || close < 0) {
    throw new Error(`[Jaui] Malformed hsl/hsla: "${s}"`);
  }
  const parts = s.slice(open + 1, close).split(/[\s,]+/).filter((p) => p.length > 0);
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(`[Jaui] hsl/hsla needs 3 or 4 components: "${s}"`);
  }
  // Hue: 0-360 (CSS supports deg, rad, turn suffixes — accept number for v1).
  // Saturation / lightness: 0-100 via "%" (canonical) or plain 0-1 (tolerated).
  const h = ((parseFloat(parts[0]) % 360) + 360) % 360;
  const sat = _normalizeHslPct(parts[1]);
  const lit = _normalizeHslPct(parts[2]);
  const alpha = parts.length === 4
    ? (parts[3].endsWith('%') ? parseFloat(parts[3].slice(0, -1)) / 100 : parseFloat(parts[3]))
    : 1;

  // HSL → RGB (standard conversion)
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lit - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)        { r = c; g = x; b = 0; }
  else if (h < 120)  { r = x; g = c; b = 0; }
  else if (h < 180)  { r = 0; g = c; b = x; }
  else if (h < 240)  { r = 0; g = x; b = c; }
  else if (h < 300)  { r = x; g = 0; b = c; }
  else               { r = c; g = 0; b = x; }

  return { R: r + m, G: g + m, B: b + m, A: alpha };
};

/** Normalize HSL saturation/lightness component. `"50%"` → 0.5.
 *  A bare number > 1 is treated as a percentage for forgiveness; `"0.5"`
 *  is already 0-1. */
const _normalizeHslPct = (p: string): number => {
  if (p.endsWith('%')) return parseFloat(p.slice(0, -1)) / 100;
  const v = parseFloat(p);
  return v > 1 ? v / 100 : v;
};

const _parseRgb = (s: string): Color => {
  const open = s.indexOf('(');
  const close = s.indexOf(')');
  if (open < 0 || close < 0) {
    throw new Error(`[Jaui] Malformed rgb/rgba: "${s}"`);
  }
  const inner = s.slice(open + 1, close);
  // Accept comma or whitespace separators (CSS4)
  const parts = inner.split(/[\s,]+/).filter((p) => p.length > 0);
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(`[Jaui] rgb/rgba needs 3 or 4 components: "${s}"`);
  }
  // RGB channels: accept 0-255 int or 0-1 float. Heuristic: if any of r/g/b
  // is > 1, treat as 0-255 and divide; otherwise assume already 0-1. This
  // matches how designers authentically mix authoring styles.
  const raw = parts.map((p) => {
    // Trailing '%' — percentage form: "50%" → 0.5
    if (p.endsWith('%')) return parseFloat(p.slice(0, -1)) / 100;
    return parseFloat(p);
  });
  if (raw.some(Number.isNaN)) {
    throw new Error(`[Jaui] Invalid numeric component in color: "${s}"`);
  }
  const [r, g, b, a] = raw;
  const anyLarge = r > 1 || g > 1 || b > 1;
  const scale = anyLarge ? 255 : 1;
  return {
    R: r / scale,
    G: g / scale,
    B: b / scale,
    A: raw.length === 4 ? a : 1,
  };
};
