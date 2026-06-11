/**
 * Filter.Parse — the `Filter` / `BackdropFilter` / `BorderFilter` value parser.
 *
 * One CSS-shaped, ordered function list per zone. Function names are CSS
 * filter names, PascalCased to match Jaui's other value-functions
 * (`LinearGradient(...)`):
 *
 *   Filter:         Brightness(1.08) Saturate(1.12)
 *   BackdropFilter: Blur(16pt) Brightness(1.25) Saturate(1.25) Contrast(0.75)
 *   BorderFilter:   Blur(3pt) Brightness(2) Saturate(4)
 *
 * Supported functions:
 *   Brightness(x)  Saturate(x)  Contrast(x)   — scalar grade multipliers
 *   Blur(len)                                 — a Length (frost / LOD octave)
 *
 * Semantics:
 *   • Identity = the function absent (Brightness/Saturate/Contrast → 1, Blur → none).
 *   • LAST occurrence of a function wins. This is what makes cross-state and
 *     cross-extends MERGE-BY-FUNCTION fall out of simple string CONCATENATION:
 *     `Blur(16pt) Brightness(1.25)` + ` Brightness(2)` parses to
 *     blur 16pt + brightness 2 (the base blur persists, brightness overridden).
 *   • `None` / empty string → all identity.
 *
 * The grade args are parsed to numbers here; `Blur`'s arg is kept as a raw
 * Length string (`BlurRaw`) so the StyleResolver can resolve it under the
 * live ResolveContext (pt → px, vars, etc.) like every other Length.
 *
 * Parse results are cached by raw string so the per-frame animator resolve
 * doesn't re-parse.
 */

export interface ParsedFilter {
  /** Foreground/backdrop/border brightness multiplier. Identity 1. */
  Brightness: number;
  /** Saturation multiplier. Identity 1. */
  Saturation: number;
  /** Contrast multiplier. Identity 1. */
  Contrast: number;
  /** Raw Length string for the zone's blur (frost px for BackdropFilter, LOD
   *  octave offset for BorderFilter); null when no Blur() was authored. The
   *  resolver resolves this under the live context. */
  BlurRaw: string | null;
}

/** The three author-facing filter properties. Used by the JSS merge layers
 *  to concatenate (merge-by-function) rather than replace these specific keys. */
export const FILTER_PROPS = ['Filter', 'BackdropFilter', 'BorderFilter'] as const;

const _FILTER_KEYS: ReadonlySet<string> = new Set(FILTER_PROPS);

/** True when a filter string is absent / empty / `None` (the identity). */
const _isNone = (v: string | undefined): boolean => {
  if (v === undefined) return true;
  const t = v.trim();
  return t === '' || t.toLowerCase() === 'none';
};

/** Merge two filter values for the SAME property by CONCATENATION — the
 *  resolver's last-occurrence-wins parse turns this into merge-by-function
 *  (overlay's functions override base's same-named functions; base's others
 *  persist). `None`/empty on either side collapses to the other. */
export const MergeFilterValue = (base: string | undefined, overlay: string): string => {
  if (_isNone(base)) return overlay;
  if (_isNone(overlay)) return base as string;
  return `${base} ${overlay}`;
};

/** Object.assign for a style overlay, except the three filter properties
 *  merge-by-function (concatenate) instead of replacing. Mutates `base`.
 *  Shared by EffectiveStyle (state layering) and the parser's extends
 *  flatten so both honor merge-by-function. */
export const AssignStyleWithFilterMerge = (
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): void => {
  for (const k in overlay) {
    const v = overlay[k];
    if (_FILTER_KEYS.has(k) && typeof v === 'string') {
      base[k] = MergeFilterValue(base[k] as string | undefined, v);
    } else {
      base[k] = v;
    }
  }
};

const IDENTITY: ParsedFilter = { Brightness: 1, Saturation: 1, Contrast: 1, BlurRaw: null };

const _cache = new Map<string, ParsedFilter>();
const _FN = /([A-Za-z]+)\s*\(([^)]*)\)/g;

/** Parse a filter function-list string into its normalized components. */
export const ParseFilter = (raw: string): ParsedFilter => {
  const cached = _cache.get(raw);
  if (cached) return cached;

  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') {
    _cache.set(raw, IDENTITY);
    return IDENTITY;
  }

  const out: ParsedFilter = { Brightness: 1, Saturation: 1, Contrast: 1, BlurRaw: null };
  _FN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = _FN.exec(trimmed)) !== null) {
    matched = true;
    const fn = m[1].toLowerCase();
    const arg = m[2].trim();
    switch (fn) {
      case 'brightness': out.Brightness = _num(arg, 'Brightness', raw); break;
      case 'saturate':   out.Saturation = _num(arg, 'Saturate', raw); break;
      case 'contrast':   out.Contrast = _num(arg, 'Contrast', raw); break;
      case 'blur':       out.BlurRaw = arg; break;
      default:
        throw new Error(
          `[Jaui] Unknown filter function "${m[1]}" in "${raw}". Supported: Brightness, Saturate, Contrast, Blur.`,
        );
    }
  }
  if (!matched) {
    throw new Error(`[Jaui] Could not parse filter "${raw}" — expected a function list like "Brightness(1.1) Saturate(1.2)".`);
  }

  _cache.set(raw, out);
  return out;
};

const _num = (arg: string, fn: string, raw: string): number => {
  const n = parseFloat(arg);
  if (Number.isNaN(n)) {
    throw new Error(`[Jaui] ${fn}() needs a number in "${raw}", got "${arg}".`);
  }
  return n;
};
