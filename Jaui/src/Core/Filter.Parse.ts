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

import type { ProgressiveBlurDirection } from '../Jiv/Jiv.Types';

/** Which edges an `EdgeProgressiveBlur` fades inward. This is "WHICH edges",
 *  not a direction — that's what keeps Edge conceptually distinct from the
 *  one-axis directional Linear. `All` = every edge; `Vertical` = Top+Bottom;
 *  `Horizontal` = Left+Right. */
export type EdgeMask = 'All' | 'Vertical' | 'Horizontal';

/** Foreground progressive-blur spec parsed out of the `Filter` property's
 *  `Blur()` / `LinearProgressiveBlur()` / `EdgeProgressiveBlur()` functions.
 *  This is the FOREGROUND analog of the backdrop pblur. Two distinct shapes:
 *
 *    • LINEAR (`Mode: 'linear'`) — a DIRECTIONAL one-axis ramp: sharp at one
 *      edge, ramping to blurred AT `Direction` over `FeatherRaw`. Owns a
 *      direction (Top/Bottom/Left/Right or an angle).
 *    • EDGE (`Mode: 'edge'`) — an ALL-AROUND symmetric vignette: the border
 *      band fades inward on every selected edge (`Edges`) while the center
 *      stays sharp. NO direction. Realized as a symmetric Stops profile
 *      (blurred at both ends of the axis, clear in the middle), so it's the
 *      multi-edge generalization of Linear over the SAME pblur machinery.
 *
 *  The resolver maps this onto the existing ProgressiveBlur* render fields so
 *  the whole pblur shader + pipeline is reused. `FeatherRaw` is a Length
 *  string (resolved under the live context); `null` = a default soft band.
 *  `Uniform` marks a flat `Blur()` (the entire element blurs evenly). */
export interface ForegroundBlur {
  Mode: 'uniform' | 'linear' | 'edge';
  Direction: ProgressiveBlurDirection;
  /** Edge mode only: which edges fade inward (the axis selector). */
  Edges: EdgeMask;
  FeatherRaw: string | null;
  Easing: number;
  Uniform: boolean;
  /** Raw frost radius Length for the heavy end of the ramp (the `Blur()` /
   *  progressive-blur arg). Drives BackdropFrostBlur on the pblur material. */
  RadiusRaw: string;
}

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
  /** Foreground progressive-blur spec (Filter zone only). Set when the author
   *  used `LinearProgressiveBlur()` / `EdgeProgressiveBlur()`, or `Blur()` is
   *  interpreted as a foreground blur. `null` = no foreground blur. */
  ForegroundBlur: ForegroundBlur | null;
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

const IDENTITY: ParsedFilter = { Brightness: 1, Saturation: 1, Contrast: 1, BlurRaw: null, ForegroundBlur: null };

const _cacheBackdrop = new Map<string, ParsedFilter>();
const _cacheForeground = new Map<string, ParsedFilter>();
const _FN = /([A-Za-z]+)\s*\(([^)]*)\)/g;

/** Map an edge keyword to the pblur direction (the edge that ramps to fully
 *  blurred). `EdgeProgressiveBlur(Top, …)` blurs AT the top, clear toward the
 *  bottom — what fades scroll content into a top inset. */
const _edgeToDirection = (raw: string): ProgressiveBlurDirection | null => {
  switch (raw.trim().toLowerCase()) {
    case 'top':    return 'ToTop';
    case 'bottom': return 'ToBottom';
    case 'left':   return 'ToLeft';
    case 'right':  return 'ToRight';
    default:       return null;
  }
};

/**
 * Parse a filter function-list string into its normalized components.
 *
 * `zone` distinguishes the FOREGROUND `Filter` (where `Blur()` and the two
 * progressive functions feather the element's OWN content) from the backdrop/
 * border zones (where `Blur()` is a frost radius / LOD offset, unchanged).
 *
 * Foreground-only functions (Filter zone):
 *   Blur(<radius>)
 *     — uniform foreground blur of the element's painted content.
 *   LinearProgressiveBlur(<direction>, <radius> [, <feather>] [, <easing>])
 *     — DIRECTIONAL one-axis ramp: sharp at one edge, ramping to blurred AT
 *       `direction` (Top|Bottom|Left|Right or an angle) over `feather`.
 *   EdgeProgressiveBlur(<radius> [, <feather>] [, <easing>] [, <edges>])
 *     — ALL-AROUND symmetric vignette: the border band fades inward on every
 *       selected edge (`edges` = All | Top+Bottom | Left+Right; default All)
 *       while the CENTER stays sharp. Takes NO direction — `edges` is "which
 *       edges fade", which is what keeps it distinct from Linear. `feather` is
 *       the band depth from each edge to the sharp center.
 */
export const ParseFilter = (raw: string, zone: 'foreground' | 'backdrop' = 'backdrop'): ParsedFilter => {
  const cache = zone === 'foreground' ? _cacheForeground : _cacheBackdrop;
  const cached = cache.get(raw);
  if (cached) return cached;

  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') {
    cache.set(raw, IDENTITY);
    return IDENTITY;
  }

  const out: ParsedFilter = { Brightness: 1, Saturation: 1, Contrast: 1, BlurRaw: null, ForegroundBlur: null };
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
      case 'blur':
        if (zone === 'foreground') {
          // Uniform foreground blur — the whole element blurs evenly.
          out.ForegroundBlur = { Mode: 'uniform', Direction: 'ToBottom', Edges: 'All', FeatherRaw: null, Easing: 1, Uniform: true, RadiusRaw: arg || '0' };
        } else {
          out.BlurRaw = arg;
        }
        break;
      case 'linearprogressiveblur':
        out.ForegroundBlur = _parseLinear(arg, raw);
        break;
      case 'edgeprogressiveblur':
        out.ForegroundBlur = _parseEdge(arg, raw);
        break;
      default:
        throw new Error(
          `[Jaui] Unknown filter function "${m[1]}" in "${raw}". Supported: Brightness, Saturate, Contrast, Blur` +
          (zone === 'foreground' ? ', LinearProgressiveBlur, EdgeProgressiveBlur.' : '.'),
        );
    }
  }
  if (!matched) {
    throw new Error(`[Jaui] Could not parse filter "${raw}" — expected a function list like "Brightness(1.1) Saturate(1.2)".`);
  }

  cache.set(raw, out);
  return out;
};

/** Parse `<direction>, <radius> [, <feather>] [, <easing>]` into a directional
 *  (one-axis ramp) ForegroundBlur. `direction` is Top/Bottom/Left/Right or an
 *  angle in deg, mapped to the nearest axis edge. */
const _parseLinear = (arg: string, raw: string): ForegroundBlur => {
  const parts = arg.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) {
    throw new Error(`[Jaui] LinearProgressiveBlur() needs at least <direction>, <radius> in "${raw}".`);
  }
  let direction = _edgeToDirection(parts[0]);
  if (direction === null) {
    // Angle fallback: 0/180 → vertical, 90/270 → horizontal; sign picks the edge.
    const ang = parseFloat(parts[0]);
    if (Number.isNaN(ang)) {
      throw new Error(`[Jaui] LinearProgressiveBlur() first arg must be Top/Bottom/Left/Right or an angle; got "${parts[0]}" in "${raw}".`);
    }
    const d = ((ang % 360) + 360) % 360;
    direction = (d >= 45 && d < 135) ? 'ToRight'
      : (d >= 135 && d < 225) ? 'ToTop'
      : (d >= 225 && d < 315) ? 'ToLeft'
      : 'ToBottom';
  }
  const radius = parts[1];
  const feather = parts.length >= 3 ? parts[2] : null;
  const easing = parts.length >= 4 ? _num(parts[3], 'LinearProgressiveBlur easing', raw) : 1;
  return { Mode: 'linear', Direction: direction, Edges: 'All', FeatherRaw: feather, Easing: easing, Uniform: false, RadiusRaw: radius };
};

/** Map an `edges` mask token to its normalized EdgeMask. Accepts `All`,
 *  `Top+Bottom`/`Bottom+Top`/`Vertical`, `Left+Right`/`Right+Left`/`Horizontal`. */
const _parseEdgeMask = (raw: string): EdgeMask | null => {
  const norm = raw.trim().toLowerCase().replace(/\s+/g, '');
  switch (norm) {
    case 'all':                        return 'All';
    case 'vertical':
    case 'top+bottom':
    case 'bottom+top':                 return 'Vertical';
    case 'horizontal':
    case 'left+right':
    case 'right+left':                 return 'Horizontal';
    default:                           return null;
  }
};

/** Parse `<radius> [, <feather>] [, <easing>] [, <edges>]` into an all-around
 *  symmetric (edge-vignette) ForegroundBlur. Takes NO direction — the optional
 *  trailing `edges` mask selects WHICH edges fade (default All). The resolver
 *  realizes this as a symmetric Stops profile over the existing pblur. */
const _parseEdge = (arg: string, raw: string): ForegroundBlur => {
  const parts = arg.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 1) {
    throw new Error(`[Jaui] EdgeProgressiveBlur() needs at least <radius> in "${raw}".`);
  }
  // Guard the legacy/ambiguous spelling: a leading direction word here is the
  // old EdgeProgressiveBlur(<edge>, …) — that's now Linear's job. Steer the
  // author rather than silently mis-parsing it as a radius.
  if (_edgeToDirection(parts[0]) !== null) {
    throw new Error(
      `[Jaui] EdgeProgressiveBlur() is the all-around vignette and takes NO direction; ` +
      `got "${parts[0]}" in "${raw}". Use LinearProgressiveBlur(${parts[0]}, …) for a single-edge ramp, ` +
      `or EdgeProgressiveBlur(<radius> [, feather] [, easing] [, edges]).`,
    );
  }
  // The last arg MAY be an edges mask (non-numeric). Peel it off if so.
  let edges: EdgeMask = 'All';
  let tail = parts.length;
  if (parts.length >= 2) {
    const maybeMask = _parseEdgeMask(parts[parts.length - 1]);
    if (maybeMask !== null) {
      edges = maybeMask;
      tail -= 1;
    } else if (Number.isNaN(parseFloat(parts[parts.length - 1]))) {
      throw new Error(`[Jaui] EdgeProgressiveBlur() edges must be All/Top+Bottom/Left+Right; got "${parts[parts.length - 1]}" in "${raw}".`);
    }
  }
  const radius = parts[0];
  const feather = tail >= 2 ? parts[1] : null;
  const easing = tail >= 3 ? _num(parts[2], 'EdgeProgressiveBlur easing', raw) : 1;
  return { Mode: 'edge', Direction: 'ToTop', Edges: edges, FeatherRaw: feather, Easing: easing, Uniform: false, RadiusRaw: radius };
};

const _num = (arg: string, fn: string, raw: string): number => {
  const n = parseFloat(arg);
  if (Number.isNaN(n)) {
    throw new Error(`[Jaui] ${fn}() needs a number in "${raw}", got "${arg}".`);
  }
  return n;
};
