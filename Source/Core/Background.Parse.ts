import type { BackgroundValue, GradientStop } from '../Jiv/Jiv.Types';
import { MAX_GRADIENT_STOPS } from '../Jiv/Jiv.Types';
import type { FitMode } from '../Element/Element';
import { ParseColor } from './Color.Parse';

const _cache = new Map<string, BackgroundValue>();

/**
 * Parser for Background authored strings. Background is a tagged union of
 * Color, Image, and Gradient — the parser routes based on the leading
 * PascalCase value constructor:
 *
 *   Background: rgba(0, 0, 0, 0.5)         → { Kind: 'Color', Color: {...} }
 *   Background: Url("/path/to/cover.jpg")  → { Kind: 'Image', Url, Fit, Color }
 *   Background: Url("/img", Contain)       → { Kind: 'Image', Fit: 'Contain' }
 *   Background: Url("/img", Cover, rgba(0, 0, 0, 0.55))
 *                                          → with explicit placeholder color
 *
 *   Background: LinearGradient(45deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 100%)
 *                                          → linear gradient with two stops
 *   Background: LinearGradient(180deg, #ff00ff, #00ffff)
 *                                          → stops with implicit even spacing
 *   Background: RadialGradient(rgba(255,255,255,0.4), rgba(0,0,0,0))
 *                                          → radial gradient centered (0.5,0.5)
 *   Background: RadialGradient(at 25% 75% radius 80%, <stops>)
 *                                          → with explicit center + radius
 *
 * Caches parsed results keyed by the raw input string so animator ticks
 * don't re-parse on every frame.
 */
export const ParseBackground = (raw: string): BackgroundValue => {
  const cached = _cache.get(raw);
  if (cached !== undefined) return _clone(cached);
  const parsed = _parse(raw.trim());
  _cache.set(raw, parsed);
  return _clone(parsed);
};

const _cloneColor = (c: { R: number; G: number; B: number; A: number }) =>
  ({ R: c.R, G: c.G, B: c.B, A: c.A });

const _cloneStops = (stops: GradientStop[]): GradientStop[] =>
  stops.map((s) => ({ Position: s.Position, Color: _cloneColor(s.Color) }));

const _clone = (b: BackgroundValue): BackgroundValue => {
  const colorCopy = _cloneColor(b.Color);
  switch (b.Kind) {
    case 'Color':          return { Kind: 'Color', Color: colorCopy };
    case 'Image':          return { Kind: 'Image', Color: colorCopy, Url: b.Url, Fit: b.Fit };
    case 'LinearGradient': return {
      Kind: 'LinearGradient', Color: colorCopy,
      AngleRad: b.AngleRad, Stops: _cloneStops(b.Stops),
    };
    case 'RadialGradient': return {
      Kind: 'RadialGradient', Color: colorCopy,
      CenterX: b.CenterX, CenterY: b.CenterY, Radius: b.Radius,
      Stops: _cloneStops(b.Stops),
    };
  }
};

const _parse = (s: string): BackgroundValue => {
  // PascalCase value constructors. `Url(...)` for images; `LinearGradient(...)`
  // and `RadialGradient(...)` for gradients; anything else falls through to
  // the color parser (preserves backwards-compat with every existing
  // rgba/hex/named-color background string).
  if (_startsWithCtor(s, 'Url')) return _parseUrl(s);
  if (_startsWithCtor(s, 'LinearGradient')) return _parseLinearGradient(s);
  if (_startsWithCtor(s, 'RadialGradient')) return _parseRadialGradient(s);
  return { Kind: 'Color', Color: ParseColor(s) };
};

const _startsWithCtor = (s: string, name: string): boolean => {
  // Match `Name(` with optional whitespace after `Name`. Case-insensitive on
  // the constructor name so `url(...)` and `linear-gradient` style typos
  // surface as recognized constructors (the canonical form is PascalCase).
  const lower = s.toLowerCase();
  const ctor = name.toLowerCase();
  if (!lower.startsWith(ctor)) return false;
  let i = ctor.length;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s[i] === '(';
};

const _parseUrl = (s: string): BackgroundValue => {
  const args = _innerArgs(s);
  if (args.length < 1 || args[0].length === 0) {
    throw new Error(`[Jaui] Url() needs at least a path argument: "${s}"`);
  }
  const url = _stripQuotes(args[0]);
  const fit: FitMode = args.length >= 2 ? _parseFit(args[1]) : 'Cover';
  const placeholder = args.length >= 3
    ? ParseColor(args[2])
    : { R: 0, G: 0, B: 0, A: 0 };
  return { Kind: 'Image', Color: placeholder, Url: url, Fit: fit };
};

const _parseLinearGradient = (s: string): BackgroundValue => {
  const args = _innerArgs(s);
  if (args.length < 2) {
    throw new Error(`[Jaui] LinearGradient needs at least angle + 1 stop, got: "${s}"`);
  }
  // First arg may be an angle (`45deg`, `180deg`, `0.5turn`, `1.2rad`); if it
  // parses as a color we treat angle as default 180deg (top→bottom).
  let angleRad: number;
  let stopArgs: string[];
  const a0 = args[0];
  const angleParse = _tryParseAngleRad(a0);
  if (angleParse !== null) {
    angleRad = angleParse;
    stopArgs = args.slice(1);
  } else {
    angleRad = Math.PI; // 180deg → top to bottom
    stopArgs = args;
  }
  const stops = _normalizeStops(stopArgs.map(_parseStop));
  return {
    Kind: 'LinearGradient',
    Color: { R: 0, G: 0, B: 0, A: 0 },
    AngleRad: angleRad,
    Stops: stops,
  };
};

const _parseRadialGradient = (s: string): BackgroundValue => {
  let args = _innerArgs(s);
  // Defaults: center (0.5, 0.5), radius = 0.5 (radius is in [0, 1] of the box).
  let centerX = 0.5;
  let centerY = 0.5;
  let radius = 0.5;
  // Optional leading `at X% Y%` and/or `radius R%` clauses (whitespace-separated).
  if (args.length > 0 && /^(at|radius)\b/i.test(args[0])) {
    const tokens = args[0].split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].toLowerCase();
      if (t === 'at' && i + 2 < tokens.length) {
        centerX = _parsePercent(tokens[i + 1], 0.5);
        centerY = _parsePercent(tokens[i + 2], 0.5);
        i += 2;
      } else if (t === 'radius' && i + 1 < tokens.length) {
        radius = _parsePercent(tokens[i + 1], 0.5);
        i += 1;
      }
    }
    args = args.slice(1);
  }
  if (args.length < 1) {
    throw new Error(`[Jaui] RadialGradient needs at least 1 stop, got: "${s}"`);
  }
  const stops = _normalizeStops(args.map(_parseStop));
  return {
    Kind: 'RadialGradient',
    Color: { R: 0, G: 0, B: 0, A: 0 },
    CenterX: centerX, CenterY: centerY, Radius: radius,
    Stops: stops,
  };
};

const _innerArgs = (s: string): string[] => {
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) {
    throw new Error(`[Jaui] Malformed constructor in Background: "${s}"`);
  }
  return _splitArgs(s.slice(open + 1, close));
};

const _parseFit = (raw: string): FitMode => {
  const t = raw.trim();
  if (t === 'Cover' || t === 'cover') return 'Cover';
  if (t === 'Contain' || t === 'contain') return 'Contain';
  throw new Error(`[Jaui] Unknown FitMode in Url(): "${raw}" (expected Cover or Contain)`);
};

const _stripQuotes = (raw: string): string => {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
};

/** Try to parse an angle token (e.g. `45deg`, `1.2rad`, `0.5turn`). Returns
 *  the angle in radians, or null if the token isn't an angle. */
const _tryParseAngleRad = (raw: string): number | null => {
  const t = raw.trim().toLowerCase();
  const m = /^(-?\d+(?:\.\d+)?)(deg|rad|turn)?$/.exec(t);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (Number.isNaN(v)) return null;
  const unit = m[2] ?? 'deg';
  if (unit === 'rad') return v;
  if (unit === 'turn') return v * Math.PI * 2;
  return v * Math.PI / 180;
};

/** Parse `"50%"` or `"0.5"` → number in [0, 1] (or whatever the token resolves
 *  to). Used for gradient stop positions, radial center, and radius. */
const _parsePercent = (raw: string, fallback: number): number => {
  const t = raw.trim();
  if (t.endsWith('%')) {
    const v = parseFloat(t.slice(0, -1));
    return Number.isNaN(v) ? fallback : v / 100;
  }
  const v = parseFloat(t);
  return Number.isNaN(v) ? fallback : v;
};

/** Parse a single gradient stop: `"rgba(0,0,0,0.5) 50%"` or `"#fff"` (position
 *  inferred). Returns the stop with `Position: NaN` when no explicit position
 *  is set — `_normalizeStops` resolves NaN positions by evenly spreading them
 *  between bracketing explicit stops. */
const _parseStop = (raw: string): GradientStop => {
  const t = raw.trim();
  // A stop is a color followed by an optional position. The color portion may
  // itself contain spaces (`rgb(255 255 255)`), so we look for a trailing
  // "<num>%" token after the last `)` (or whole string if no parens).
  const lastClose = t.lastIndexOf(')');
  const tail = lastClose >= 0 ? t.slice(lastClose + 1).trim() : '';
  let position = NaN;
  let colorRaw = t;
  if (tail.length > 0 && /%?\s*$/.test(tail) && /\d/.test(tail)) {
    position = _parsePercent(tail, NaN);
    colorRaw = t.slice(0, lastClose + 1).trim();
  } else if (lastClose < 0) {
    // No parens — the stop is a single token like `#fff 50%` or `red`. Split
    // on the last space; if the trailing token parses as a percent, use it.
    const sp = t.lastIndexOf(' ');
    if (sp > 0) {
      const candidate = t.slice(sp + 1);
      const p = _parsePercent(candidate, NaN);
      if (!Number.isNaN(p)) {
        position = p;
        colorRaw = t.slice(0, sp).trim();
      }
    }
  }
  return { Position: position, Color: ParseColor(colorRaw) };
};

/** Fill in NaN positions by evenly spreading between explicit bracketing
 *  positions (CSS-style stop normalization), clamp to [0, 1], and sort
 *  ascending. If the result has more than MAX_GRADIENT_STOPS, evenly
 *  resample down to the cap. */
const _normalizeStops = (stops: GradientStop[]): GradientStop[] => {
  if (stops.length === 0) return [];
  if (stops.length === 1) {
    return [{ Position: 0, Color: _cloneColor(stops[0].Color) },
            { Position: 1, Color: _cloneColor(stops[0].Color) }];
  }
  // Initial seed: first NaN → 0, last NaN → 1.
  if (Number.isNaN(stops[0].Position)) stops[0].Position = 0;
  if (Number.isNaN(stops[stops.length - 1].Position)) stops[stops.length - 1].Position = 1;
  // Fill spans of NaN between explicit positions by even spacing.
  let i = 0;
  while (i < stops.length) {
    if (!Number.isNaN(stops[i].Position)) { i++; continue; }
    let j = i;
    while (j < stops.length && Number.isNaN(stops[j].Position)) j++;
    const before = stops[i - 1].Position;
    const after  = stops[j].Position;
    const span = j - i + 1;
    for (let k = 0; k < j - i; k++) {
      stops[i + k].Position = before + ((k + 1) / span) * (after - before);
    }
    i = j;
  }
  // Clamp + sort.
  for (const s of stops) {
    if (s.Position < 0) s.Position = 0;
    else if (s.Position > 1) s.Position = 1;
  }
  stops.sort((a, b) => a.Position - b.Position);
  // Cap.
  if (stops.length > MAX_GRADIENT_STOPS) {
    const resampled: GradientStop[] = [];
    for (let k = 0; k < MAX_GRADIENT_STOPS; k++) {
      const t = k / (MAX_GRADIENT_STOPS - 1);
      resampled.push(_sampleStops(stops, t));
    }
    return resampled;
  }
  return stops;
};

const _sampleStops = (stops: GradientStop[], t: number): GradientStop => {
  if (t <= stops[0].Position) return { Position: t, Color: _cloneColor(stops[0].Color) };
  if (t >= stops[stops.length - 1].Position) {
    return { Position: t, Color: _cloneColor(stops[stops.length - 1].Color) };
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t >= a.Position && t <= b.Position) {
      const span = b.Position - a.Position;
      const u = span > 0 ? (t - a.Position) / span : 0;
      return {
        Position: t,
        Color: {
          R: a.Color.R + (b.Color.R - a.Color.R) * u,
          G: a.Color.G + (b.Color.G - a.Color.G) * u,
          B: a.Color.B + (b.Color.B - a.Color.B) * u,
          A: a.Color.A + (b.Color.A - a.Color.A) * u,
        },
      };
    }
  }
  return { Position: t, Color: _cloneColor(stops[stops.length - 1].Color) };
};

/** Split top-level comma-separated arguments. Respects nested parens (so
 *  `Url("x", Cover, rgba(0, 0, 0, 0.55))` splits to three args, not five),
 *  and respects quoted strings. */
const _splitArgs = (raw: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = raw.slice(start).trim();
  if (last.length > 0 || out.length > 0) out.push(last);
  return out;
};
