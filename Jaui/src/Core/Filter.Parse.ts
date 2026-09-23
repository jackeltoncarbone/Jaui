/**
 * Filter.Parse — the `Filter` / `BackdropFilter` / `TextFilter` value parser.
 *
 * One CSS-shaped, ordered function list per zone. Function names are CSS
 * filter names, PascalCased to match Jaui's other value-functions
 * (`LinearGradient(...)`):
 *
 *   Filter:              Brightness(1.08) Saturate(1.12)
 *   BackdropFilter:      Blur(16pt) Brightness(1.25) Saturate(1.25) Contrast(0.75)
 *   TextFilter:          Lift(30)
 *
 * Supported functions:
 *   Brightness(x)  Saturate(x)  Contrast(x)   — scalar grade multipliers
 *   Blur(len)                                 — a Length (the foreground blur, or the frost)
 *   Lift(n) / Lift(color, n)                  — Filter + BackdropFilter: an ADDITIVE COLOR, a color
 *                                               times a signed amount in 0-255 units. On the
 *                                               BACKDROP it lifts what is under the element; on the
 *                                               FOREGROUND the element's own ink adds instead of
 *                                               covering. `Lift(n)` is white times n. See Core/Lift.ts
 *   Lift(n)                                   — TextFilter: the element's INK adds, at |n|/255 of its
 *                                               own `Color`, and NOTHING else about the element
 *                                               changes. The one-argument form ONLY — see below.
 *
 * … with one exception, which REFUSES rather than accepts-and-ignores: the `text` zone takes Lift()
 * ONLY, and refuses the grade functions and every blur. See `_refuseInText`.
 *
 * ## WHY `Lift()`'s COLOR ARGUMENT IS NOT ACCEPTED IN EVERY ZONE
 *
 * A zone either brings its own color or it does not, and that decides the arity:
 *
 *   • `backdrop` / `foreground` paint an additive draw of the element's SHAPE. There is no source
 *     color there, so the lift supplies one: `Lift(<color>, <amount>)` and the color is ABSOLUTE.
 *   • `text` grades ink that ALREADY HAS a color — `Color`, on the TextStyle. A second color here
 *     could only be a per-channel MULTIPLIER on that ink, which is a different meaning for the same
 *     argument in the same grammar. So the two-argument form is REFUSED in the text zone by name and
 *     the message names `Color` as the property that owns the ink's color.
 *
 * The amount always means "how much", applied to whatever that zone paints: in the foreground zone
 * the amount belongs to the SHAPE draw and only its SIGN reaches the ink (which adds at its own full
 * color); in the text zone there is no shape draw, so the amount scales the ink itself.
 *
 * Semantics:
 *   • Identity = the function absent (Brightness/Saturate/Contrast → 1, Blur → none).
 *   • LAST occurrence of a function wins. This is what makes cross-state and
 *     cross-extends MERGE-BY-FUNCTION fall out of simple string CONCATENATION:
 *     `Blur(16pt) Brightness(1.25)` + ` Brightness(2)` parses to
 *     blur 16pt + brightness 2 (the base blur persists, brightness overridden).
 *   • `None` / empty string → all identity.
 *   • A grade argument may be a length expression over vars (`Contrast(0.6 * @Dark + 1 * @Light)`); the
 *     StyleResolver evaluates it to a number under the live context before this parse.
 *   • The grade APPLIES in one fixed physical order, not the authored one: Contrast, then Saturate,
 *     then Brightness (the shaders' applyGrading). Contrast compresses the range first (readability),
 *     so a Brightness below 1 then scales toward black instead of being pulled back toward grey.
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
  /** Foreground/backdrop brightness multiplier. Identity 1. */
  Brightness: number;
  /** Saturation multiplier. Identity 1. */
  Saturation: number;
  /** Contrast multiplier. Identity 1. */
  Contrast: number;
  /** `Lift()`'s amount as a fraction of full scale (n / 255), signed. Identity 0. The zone says which
   *  side of the element it touches (Core/Lift.ts). In the text zone the magnitude SCALES the ink; in
   *  the foreground zone only the sign reaches the ink and the magnitude belongs to the shape draw. */
  Lift: number;
  /** `Lift()`'s color as AUTHORED, still a string, because the resolver may need to resolve a var in
   *  it and the parse cache is keyed by string. `null` means the one-argument spelling, which is
   *  WHITE -- kept as null rather than a white Color so `Lift(18)` allocates nothing and stays
   *  byte-identical to what shipped. */
  LiftColor: string | null;
  /** Raw Length string for the backdrop's frost; null when no Blur() was authored. The
   *  resolver resolves this under the live context. */
  BlurRaw: string | null;
  /** Foreground progressive-blur spec (Filter zone only). Set when the author
   *  used `LinearProgressiveBlur()` / `EdgeProgressiveBlur()`, or `Blur()` is
   *  interpreted as a foreground blur. `null` = no foreground blur. */
  ForegroundBlur: ForegroundBlur | null;
}

/** Which zone a filter value grades. Each zone reads the SAME function list but
 *  accepts a different subset — `Blur()` means a foreground blur or a frost radius
 *  in the two that take it, and nothing at all in `text`. */
export type FilterZone = 'foreground' | 'backdrop' | 'text';

/** The author-facing filter properties. Used by the JSS merge layers
 *  to concatenate (merge-by-function) rather than replace these specific keys.
 *
 *  `TextFilter` is in this list and therefore on `JivStyle`, NOT on `TextStyle`, even though the ink's
 *  COLOR lives on `TextStyle`: merge-by-function only happens in the `'Style'` slot
 *  (`Jss.Parser._assignToSlot`). On `TextStyle` it would be plain last-wins, so a
 *  `:Hover { TextFilter: Lift(50) }` would clobber the base declaration instead of merging by
 *  function like its siblings. */
export const FILTER_PROPS = ['Filter', 'BackdropFilter', 'TextFilter'] as const;

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

const IDENTITY: ParsedFilter = { Brightness: 1, Saturation: 1, Contrast: 1, Lift: 0, LiftColor: null, BlurRaw: null, ForegroundBlur: null };

const _cacheBackdrop = new Map<string, ParsedFilter>();
const _cacheForeground = new Map<string, ParsedFilter>();
// The text zone accepts ONLY `Lift()`, so a string the foreground cached (where `Brightness()` is
// legal) must not answer for it.
const _cacheText = new Map<string, ParsedFilter>();
/** Split a function list into (name, argument) pairs, counting parentheses so a function may take
 *  ANOTHER function as an argument -- which `Lift(rgb(255, 220, 180), 18)` does. The regex this
 *  replaced was `/([A-Za-z]+)\s*\(([^)]*)\)/g`, and `[^)]*` stops at the FIRST `)`: it read that
 *  string as `Lift(rgb(255, 220, 180)` and then found no second function, so the amount vanished
 *  and the lift silently became 0. Nothing caught it, because a dropped argument is not a parse
 *  error. Returns null at the first malformed token rather than skipping it. */
export const SplitFilterFunctions = (raw: string): { Name: string; Arg: string }[] | null => {
  const out: { Name: string; Arg: string }[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && !/[A-Za-z]/.test(raw[i])) {
      // Only whitespace and commas separate functions; anything else is a malformed list.
      if (!/[\s,]/.test(raw[i])) return null;
      i++;
    }
    if (i >= n) break;
    const nameStart = i;
    while (i < n && /[A-Za-z]/.test(raw[i])) i++;
    const name = raw.slice(nameStart, i);
    while (i < n && /\s/.test(raw[i])) i++;
    if (i >= n || raw[i] !== '(') return null;
    i++; // past '('
    const argStart = i;
    let depth = 1;
    while (i < n && depth > 0) {
      if (raw[i] === '(') depth++;
      else if (raw[i] === ')') depth--;
      if (depth > 0) i++;
    }
    if (depth !== 0) return null; // unbalanced
    out.push({ Name: name, Arg: raw.slice(argStart, i) });
    i++; // past the matching ')'
  }
  return out;
};

/** Split a function's argument on its TOP-LEVEL commas, so `rgb(255, 220, 180), 18` is two arguments
 *  and not four. */
export const SplitTopLevelArgs = (arg: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(arg.slice(start, i)); start = i + 1; }
  }
  out.push(arg.slice(start));
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
};

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
 * progressive functions feather the element's OWN content) from the backdrop
 * zone (where `Blur()` is the frost radius).
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
export const ParseFilter = (raw: string, zone: FilterZone = 'backdrop'): ParsedFilter => {
  const cache = zone === 'foreground' ? _cacheForeground : zone === 'text' ? _cacheText : _cacheBackdrop;
  const cached = cache.get(raw);
  if (cached) return cached;

  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') {
    cache.set(raw, IDENTITY);
    return IDENTITY;
  }

  const out: ParsedFilter = { Brightness: 1, Saturation: 1, Contrast: 1, Lift: 0, LiftColor: null, BlurRaw: null, ForegroundBlur: null };
  // `null` is a MALFORMED list (an unbalanced paren, a bare token, a name with no call). It has to
  // throw rather than fall through as "nothing matched", because a filter string the author wrote and
  // the engine silently dropped is the exact failure the old regex had.
  const fns = SplitFilterFunctions(trimmed);
  if (fns === null) {
    throw new Error(
      `[Jaui] Could not parse filter "${raw}" — expected a function list like "Brightness(1.1) Saturate(1.2)". ` +
      'Check for an unbalanced parenthesis or a value outside a function.',
    );
  }
  const matched = fns.length > 0;
  for (const f of fns) {
    const fn = f.Name.toLowerCase();
    const arg = f.Arg.trim();
    switch (fn) {
      case 'brightness':
        if (zone === 'text') throw new Error(_refuseInText('Brightness', raw));
        out.Brightness = _num(arg, 'Brightness', raw);
        break;
      case 'saturate':
        if (zone === 'text') throw new Error(_refuseInText('Saturate', raw));
        out.Saturation = _num(arg, 'Saturate', raw);
        break;
      case 'contrast':
        if (zone === 'text') throw new Error(_refuseInText('Contrast', raw));
        out.Contrast = _num(arg, 'Contrast', raw);
        break;
      case 'lift': {
        // The BACKDROP zone lifts what is under the element; the FOREGROUND zone makes the element's
        // own ink add instead of cover; the TEXT zone makes ONLY the ink add and leaves the fill,
        // border and shadow alone.
        const parts = SplitTopLevelArgs(arg);
        if (parts.length > 2) {
          throw new Error(
            `[Jaui] Lift() takes <amount> or <color>, <amount>; got ${parts.length} arguments in "${raw}".`,
          );
        }
        // The ink already HAS a color, so a second one here would be a per-channel multiplier on it
        // rather than the absolute color it is in the other two zones -- one word, two meanings. The
        // one-argument form only, and the message names the property that owns the ink's color.
        if (zone === 'text' && parts.length === 2) {
          throw new Error(
            `[Jaui] TextFilter: Lift() takes <amount> only; got a color argument in "${raw}". The ink ` +
            'already has a color -- `Color`, on the text style -- and the amount says how much of it ' +
            'ADDS: Lift(255) adds the ink at its own full color, Lift(128) at half, a negative amount ' +
            'subtracts. A color here could only multiply the ink channel by channel, which is not what ' +
            'the same argument means on BackdropFilter or Filter (there it IS the color, because an ' +
            'additive draw of the shape has no other source). Set the ink with Color and the strength ' +
            'with the amount.',
          );
        }
        // One argument is the amount against WHITE. Two is a color and an amount. `LiftColor: null`
        // IS white -- the one-argument form must stay byte-identical, so it allocates no color and
        // takes no different code path downstream.
        const amountRaw = parts.length === 2 ? parts[1] : parts[0];
        const n = _num(amountRaw, 'Lift', raw);
        if (Math.abs(n) > 255) throw new Error(`[Jaui] Lift() takes a signed amount of 255, got ${n} in "${raw}".`);
        out.Lift = n / 255;
        out.LiftColor = parts.length === 2 ? parts[0] : null;
        break;
      }
      case 'blur':
        if (zone === 'text') throw new Error(_refuseInText('Blur', raw));
        if (zone === 'foreground') {
          // Uniform foreground blur — the whole element blurs evenly.
          out.ForegroundBlur = { Mode: 'uniform', Direction: 'ToBottom', Edges: 'All', FeatherRaw: null, Easing: 1, Uniform: true, RadiusRaw: arg || '0' };
        } else {
          out.BlurRaw = arg;
        }
        break;
      case 'linearprogressiveblur':
        if (zone === 'text') throw new Error(_refuseInText('LinearProgressiveBlur', raw));
        out.ForegroundBlur = _parseLinear(arg, raw);
        break;
      case 'edgeprogressiveblur':
        if (zone === 'text') throw new Error(_refuseInText('EdgeProgressiveBlur', raw));
        out.ForegroundBlur = _parseEdge(arg, raw);
        break;
      default:
        throw new Error(
          zone === 'text'
            ? `[Jaui] Unknown TextFilter function "${f.Name}" in "${raw}". TextFilter takes Lift() only.`
            : `[Jaui] Unknown filter function "${f.Name}" in "${raw}". Supported: Brightness, Saturate, Contrast, Blur` +
              (zone === 'foreground' ? ', Lift, LinearProgressiveBlur, EdgeProgressiveBlur.' : ', Lift.'),
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

/** The text zone takes `Lift()` and nothing else. Each refusal names the property that DOES own the
 *  thing asked for, so the author's next move is obvious.
 *
 *  The grade functions are refused rather than folded into the ink color, even though grading a KNOWN
 *  color is pure arithmetic and would need no shader change: `Filter` already grades the element's
 *  composited pixels INCLUDING its text, so an ink-only grade is a second way to spell something that
 *  exists, and it would silently disagree with `Filter` about whether the fill is graded too. The
 *  blurs are refused because a text-only blur is not built at all -- there is no ink-only blur pass. */
const _refuseInText = (fn: string, raw: string): string =>
  `[Jaui] TextFilter takes Lift() only; got ${fn}() in "${raw}". ` +
  (fn === 'Brightness' || fn === 'Saturate' || fn === 'Contrast'
    ? 'The foreground `Filter` already grades this element\'s composited pixels, its own text included, '
      + 'so an ink-only grade would be a second spelling for something that exists. Author the grade on '
      + 'Filter, or set the ink\'s color directly with Color.'
    : 'There is no ink-only blur pass. `Filter: Blur()` blurs the element\'s content, text included; '
      + 'author it there.');

const _num = (arg: string, fn: string, raw: string): number => {
  const n = parseFloat(arg);
  if (Number.isNaN(n)) {
    throw new Error(`[Jaui] ${fn}() needs a number in "${raw}", got "${arg}".`);
  }
  return n;
};
