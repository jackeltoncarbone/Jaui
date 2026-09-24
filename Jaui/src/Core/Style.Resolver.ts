import type { JivStyle, JivRenderStyle, CornerShape, MaterialType, ProgressiveBlurDirection, BlurStop, GlassKind } from '../Jiv/Jiv.Types';
import { ParseProgressiveBlur } from '../ProgressiveBlur/ProgressiveBlur.Stops';
import type { ResolveContext } from './Length';
import { Resolve, ResolveTernary, ResolveVars } from './Length';
import { ResolveLengthTuple4 } from './Length.Tuple';
import { ParseColor } from './Color.Parse';
import { ParseBackground } from './Background.Parse';
import { ParseFilter, SplitTopLevelArgs } from './Filter.Parse';
import type { VibrancyDeclaration } from './Vibrancy';
import type { Color } from './Types';
import { ResolveTransform } from '../Transform/Transform.Parse';

/** The most frost `BackdropFilter: Blur(Auto)` draws, in CSS px. The field resolves to it, so every
 *  reader that sizes for the largest frost is right; the panel's own is `JivFrostCssPx`. */
export const AUTO_FROST_MAX = 8;

/**
 * StyleResolver — turns an authored JivStyle (all strings) into a fully
 * numeric JivRenderStyle, given a ResolveContext.
 *
 * Every string flows through the right parser:
 *   • scalar Lengths  → Resolve(str, ctx, axis)
 *   • tuple Lengths   → ResolveLengthTuple4(str, ctx, axes)   (BorderRadius, etc.)
 *   • color strings   → ParseColor(str)
 *   • transform       → ResolveTransform(str, ctx)
 *
 * Parse results are cached inside each parser so repeated resolutions (e.g.
 * animator Tick every frame) don't re-parse.
 *
 * The style animator drives this: each tick it asks the resolver for the
 * target JivRenderStyle, then springs each numeric channel of the Jiv's
 * current RenderStyle toward that target.
 */

/** Special-case CornerShape parsing — not a Length, just a space-separated
 *  list of CornerShape tokens with CSS-style 1/4 shorthand. */
const _parseCornerShape = (raw: string): [CornerShape, CornerShape, CornerShape, CornerShape] => {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
  const coerce = (s: string): CornerShape => {
    const lower = s.toLowerCase();
    if (lower === 'round') return 'Round';
    if (lower === 'squircle') return 'Squircle';
    if (lower === 'bevel') return 'Bevel';
    if (lower === 'scoop') return 'Scoop';
    if (lower === 'notch') return 'Notch';
    const n = parseFloat(s);
    if (!Number.isNaN(n)) return n;
    throw new Error(`[Jaui] Unknown CornerShape token "${s}"`);
  };
  switch (parts.length) {
    case 1: { const p = coerce(parts[0]); return [p, p, p, p]; }
    case 4: return [coerce(parts[0]), coerce(parts[1]), coerce(parts[2]), coerce(parts[3])];
    default: throw new Error(`[Jaui] CornerShape needs 1 or 4 tokens; got ${parts.length}: "${raw}"`);
  }
};

/** Parse a Visual* shorthand string into [X, Y] numbers.
 *  - `'v'`     → [v, v]   (uniform)
 *  - `'x y'`   → [x, y]   (per-axis)
 *  - empty/whitespace → [fallback, fallback]
 *  Each token is resolved as a Length under `ctx` so authors can use
 *  `pt`, `%`, `vw`, etc. — e.g. `VisualTranslate: '0pt 4pt'` lifts the
 *  Jiv 4pt vertically at render time. */
const _parseVisualPair = (
  raw: string,
  ctx: ResolveContext,
  fallback: number,
): [number, number] => {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return [fallback, fallback];
  if (parts.length === 1) {
    const v = Resolve(parts[0], ctx, 'W');
    return [v, v];
  }
  return [Resolve(parts[0], ctx, 'W'), Resolve(parts[1], ctx, 'H')];
};

/** Resolve `MaxWidth`/`MaxHeight` with CSS-style "none" → Infinity. */
const _resolveBound = (raw: string, ctx: ResolveContext, axis: 'W' | 'H'): number => {
  if (raw === 'none') return Infinity;
  return Resolve(raw, ctx, axis);
};
export { _resolveBound as ResolveBound };

/** Infer the render pipeline from what the author actually set. No explicit
 *  `Material:` field — Jiv decides based on which props carry non-default
 *  values. ProgressiveBlurDirection wins (it's unique to the feather); a
 *  positive Thickness routes the Jiv through the glass pipeline; everything
 *  else is a plain panel. */
/** Build the SYMMETRIC stops profile for `EdgeProgressiveBlur`: fully blurred
 *  at both ends of the axis (every selected edge), clear across the central
 *  band, with a smooth ramp of depth `band` (a fraction 0..0.5 of the axis) at
 *  each end. `featherRaw` is read as a FRACTION (`0.2` or `20%`) — stop
 *  positions are normalized, so Edge's band is fraction-based (distinct from
 *  Linear's px feather). Omitted/invalid → 0.5 (ramps meet in the center).
 *  `easing` carries through as the per-segment exponent into the blur. */
const _edgeStops = (featherRaw: string | null, easing: number): BlurStop[] => {
  let band = 0.5;
  if (featherRaw !== null) {
    const t = featherRaw.trim();
    const v = t.endsWith('%') ? parseFloat(t.slice(0, -1)) / 100 : parseFloat(t);
    if (!Number.isNaN(v) && v > 0) band = Math.min(Math.max(v, 0.001), 0.5);
  }
  const e = Math.max(easing, 0.001);
  // 1 at each edge → 0 at the inner band boundary → 0 across center → mirror.
  return [
    { Position: 0,        Value: 1, Easing: e },
    { Position: band,     Value: 0, Easing: 1 },
    { Position: 1 - band, Value: 0, Easing: e },
    { Position: 1,        Value: 1, Easing: 1 },
  ];
};

/** The environment var the host publishes for the active theme: `1` in dark, `0` in light. Jaui.Angular's
 *  `<jaui>` keeps it always defined (with its `@Light` twin). Unpublished reads as dark, the app's ground. */
export const THEME_DARK_VAR = 'Dark';
/** The 0/1 twin of THEME_DARK_VAR, so a sheet can weight a light value without writing (1 - @Dark). */
export const THEME_LIGHT_VAR = 'Light';

// One optional nested level, because only `Vibrancy()`'s color argument nests; the rest are arithmetic
// expressions over vars.
const _GRADE_FN = /(Brightness|Saturate|Contrast|Vibrancy)\s*\(((?:[^()]|\([^()]*\))*)\)/gi;

/** A color argument after var substitution: a hex, a color function or a named color. */
const _COLOR_ARG = /^\s*(#|rgba?\(|hsla?\(|[a-z]+\s*$)/i;

/** A grade argument may be a length expression over vars, so a material can state its per-theme grade in
 *  one line: `Contrast(0.6 * @Dark + 1 * @Light)`, and a wash its per-theme level:
 *  `Vibrancy(@JwiftVibrancySecondaryFill)`. Those arguments are evaluated to numbers here, before the
 *  filter parse (which caches by string and reads plain numbers). `Vibrancy()`'s color argument is not
 *  arithmetic: its vars are resolved where the color is parsed. Literal filters pass through untouched. */
const _resolveGradeArgs = (raw: string, ctx: ResolveContext): string => {
  if (raw.indexOf('@') < 0) return raw;
  return raw.replace(_GRADE_FN, (whole, fn: string, arg: string) => {
    if (arg.indexOf('@') < 0) return whole;
    const parts = SplitTopLevelArgs(arg);
    const colorFirst = parts.length >= 2 && _COLOR_ARG.test(ResolveVars(parts[0], ctx));
    const resolved = parts.map((part, i) =>
      (colorFirst && i === 0) || part.indexOf('@') < 0 ? part.trim() : String(Resolve(part.trim(), ctx, 'W')));
    return `${fn}(${resolved.join(', ')})`;
  });
};

/** `Tint` + `TintTone` → the signed tint the shader reads: negative toward black, positive toward white. */
const _resolveTint = (s: JivStyle, ctx: ResolveContext): number => {
  const strength = Math.max(0, Math.min(1, Resolve(ResolveTernary(s.Tint, ctx), ctx, 'W')));
  if (strength === 0) return 0;
  const dark = parseFloat(ctx.Vars?.get(THEME_DARK_VAR) ?? '1') >= 0.5;
  switch (ResolveTernary(s.TintTone, ctx)) {
    case 'Dark':  return -strength;
    case 'Light': return strength;
    case 'Ink':   return dark ? strength : -strength;
    default:      return dark ? -strength : strength;
  }
};

/** `Vibrancy: <color> <amount> [<cover>]`, the INHERITED vibrancy (Core/Vibrancy.ts). `None` is the reset,
 *  `Inherit` (the initial value) takes the ancestor's. The color resolves through `ResolveVars` +
 *  `ParseColor`, the amount and cover through the length evaluator, where the theme flip lives. */
const _resolveVibrancyProperty = (raw: string, ctx: ResolveContext): VibrancyDeclaration => {
  const t = raw.trim();
  if (t === '' || t.toLowerCase() === 'inherit') return 'Inherit';
  if (t.toLowerCase() === 'none') return 'None';
  const tokens = _splitTopLevelWords(t);
  if (tokens.length < 2 || tokens.length > 3) {
    throw new Error(
      `[Jaui] Vibrancy: "${raw}" — expected "<color> <amount> [<cover>]", "None" or "Inherit". The amount is ` +
      'signed, in 0-255 units, and the cover is 0..1 (Vibrancy: rgb(255, 255, 255) @JwiftVibrancySecondaryFill).',
    );
  }
  const color = ParseColor(ResolveVars(tokens[0], ctx));
  const n = Resolve(tokens[1], ctx, 'W');
  const cover = tokens.length === 3 ? Resolve(tokens[2], ctx, 'W') : 0;
  if (!Number.isFinite(n)) throw new Error(`[Jaui] Vibrancy: "${raw}" — the amount did not resolve to a number.`);
  if (Math.abs(n) > 255) throw new Error(`[Jaui] Vibrancy: "${raw}" — the amount is signed and at most 255, got ${n}.`);
  if (!(cover >= 0 && cover <= 1)) throw new Error(`[Jaui] Vibrancy: "${raw}" — the cover is 0..1, got ${cover}.`);
  return { R: color.R, G: color.G, B: color.B, Amount: n / 255, Cover: cover };
};

/** Split at depth-0 whitespace, so a color function's own spaces (`rgb(255 220 180)`) stay whole. */
const _splitTopLevelWords = (t: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= t.length; i++) {
    const ch = t[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (i === t.length || (depth === 0 && /\s/.test(ch))) {
      if (i > start) out.push(t.slice(start, i));
      start = i + 1;
    }
  }
  return out;
};

/** A `Vibrancy()` function's color argument; `null` is white. A FRESH object every call, which is
 *  `ParseColor`'s own rule: a shared color would be written through by anything that springs a channel. */
const _resolveVibrancyColor = (raw: string | null, ctx: ResolveContext): Color => {
  if (raw === null) return { R: 1, G: 1, B: 1, A: 1 };
  const c = ParseColor(ResolveVars(raw, ctx));
  return { R: c.R, G: c.G, B: c.B, A: 1 };
};

const _inferMaterial = (glass: GlassKind, thickness: number, direction: ProgressiveBlurDirection | null): MaterialType => {
  if (direction !== null) return 'ProgressiveBlur';
  if (glass !== 'None' && thickness > 0) return 'LiquidGlass';
  return 'None';
};

/** Resolve a full JivStyle into a JivRenderStyle under the given context. */
export const ResolveStyle = (s: JivStyle, ctx: ResolveContext): JivRenderStyle => {
  const rawRadius = ResolveLengthTuple4(s.BorderRadius, ctx, ['W', 'W', 'W', 'W']);
  const smoothness = Resolve(s.BorderRadiusSmoothness, ctx, 'W');
  // The authored radius is the continuous corner's own radius (Jiv/Shaders/Corner.Continuous.glsl),
  // as it is Apple's: no compensation, and a child's radius is its parent's less the inset.
  const borderRadius = rawRadius;
  const glassRaw = ResolveTernary(s.Glass, ctx);
  const glass: GlassKind = glassRaw === 'Regular' || glassRaw === 'Clear' ? glassRaw : 'None';
  // Auto: a glass is fully in, anything else has no glass to fade.
  const thickness = s.Thickness === 'Auto' ? (glass === 'None' ? 0 : 1) : Resolve(s.Thickness, ctx, 'W');

  // Filters — each authored as a CSS-shaped function list, normalized into
  // the per-zone scalar render fields the shader already consumes. Blur()'s
  // arg stays a Length and resolves under ctx (the frost px for BackdropFilter);
  // a missing Blur() = 0.
  const fg = ParseFilter(_resolveGradeArgs(ResolveTernary(s.Filter, ctx), ctx), 'foreground');
  const backdrop = ParseFilter(_resolveGradeArgs(ResolveTernary(s.BackdropFilter, ctx), ctx));
  // The INK zone. Takes `Vibrancy()` only, through the same arg resolution as its siblings.
  const ink = ParseFilter(_resolveGradeArgs(ResolveTernary(s.TextFilter, ctx), ctx), 'text');
  const frostAuto = backdrop.BlurRaw !== null && backdrop.BlurRaw.trim().toLowerCase() === 'auto';
  const resolveBlur = (raw: string | null): number =>
    (frostAuto ? AUTO_FROST_MAX : raw !== null ? Resolve(raw, ctx, 'W') : 0);
  // A gradient-driven blur spectrum implies the ProgressiveBlur material and the
  // ramp axis on its own, so the author doesn't also need ProgressiveBlurDirection.
  const blurSpec = s.ProgressiveBlur ? ParseProgressiveBlur(s.ProgressiveBlur) : null;

  // Foreground `Filter: Blur()/LinearProgressiveBlur()/EdgeProgressiveBlur()` —
  // the foreground analog of the backdrop pblur. It drives the SAME resolved
  // ProgressiveBlur* render fields (and forces the ProgressiveBlur material), so
  // the entire pblur shader + orchestration is reused. A uniform `Blur()` becomes
  // a flat 2-stop ramp (full blur everywhere); the progressive variants ramp
  // toward their edge over the feather. Explicit ProgressiveBlur* props still win.
  const fgBlur = fg.ForegroundBlur;
  // Edge mode is the all-around generalization: a SYMMETRIC stops profile
  // (blurred at both ends of the axis, clear in the middle band) realized over
  // the existing pblur Stops machinery. `Edges` selects the axis: Vertical →
  // ToBottom (y), Horizontal → ToRight (x), All → vertical (one axis per node;
  // both-axis vignette = nest a Vertical veil inside a Horizontal one).
  const fgDir: ProgressiveBlurDirection | null =
    fgBlur === null ? null
      : fgBlur.Mode === 'edge' ? (fgBlur.Edges === 'Horizontal' ? 'ToRight' : 'ToBottom')
        : fgBlur.Direction;
  const fgFeather = fgBlur && fgBlur.Mode !== 'edge' && fgBlur.FeatherRaw !== null
    ? Resolve(fgBlur.FeatherRaw, ctx, 'H')
    : null;
  const fgFrost = fgBlur ? Resolve(fgBlur.RadiusRaw, ctx, 'W') : 0;
  const fgStops = fgBlur
    ? (fgBlur.Uniform
        ? [{ Position: 0, Value: 1, Easing: 1 }, { Position: 1, Value: 1, Easing: 1 }]
        : fgBlur.Mode === 'edge'
          ? _edgeStops(fgBlur.FeatherRaw, fgBlur.Easing)
          : null)
    : null;

  const effDirection = blurSpec?.Direction ?? s.ProgressiveBlurDirection ?? fgDir ?? null;

  return {
    Material: _inferMaterial(glass, thickness, effDirection),
    ProgressiveBlurDirection: effDirection ?? 'ToTop',
    ProgressiveBlurFeather: fgFeather !== null ? fgFeather : Resolve(s.ProgressiveBlurFeather, ctx, 'H'),
    ProgressiveBlurEasing: fgBlur && !fgBlur.Uniform ? fgBlur.Easing : Resolve(s.ProgressiveBlurEasing, ctx, 'W'),
    ProgressiveBlurStops: blurSpec?.Stops ?? fgStops,
    ProgressiveBlurKind: ResolveTernary(s.ProgressiveBlurKind, ctx) === 'ScrollEdge' ? 'ScrollEdge' : 'Surface',
    PointScale: Resolve(s.PointScale, ctx, 'W', true),

    BorderRadius: borderRadius,
    CornerShape: _parseCornerShape(ResolveTernary(s.CornerShape, ctx)),
    BorderRadiusSmoothness: smoothness,

    Background: ParseBackground(ResolveVars(ResolveTernary(s.Background, ctx), ctx)),

    VibrancyDeclaration: _resolveVibrancyProperty(ResolveTernary(s.Vibrancy, ctx), ctx),
    ForegroundVibrancy: fg.Vibrancy,
    ForegroundVibrancyCover: fg.VibrancyCover,
    TextVibrancy: ink.Vibrancy,
    TextVibrancyCover: ink.VibrancyCover,
    ForegroundVibrancyColor: _resolveVibrancyColor(fg.VibrancyColor, ctx),
    BackdropVibrancyColor: _resolveVibrancyColor(backdrop.VibrancyColor, ctx),

    Frost: Resolve(s.Frost, ctx, 'W'),
    // Heavy-end frost sigma for the pblur material: the foreground Filter blur
    // radius drives it when present, else the backdrop frost. The pblur shader
    // reads this as the ramp's max blur.
    BackdropFrostBlur: fgBlur ? fgFrost : resolveBlur(backdrop.BlurRaw),
    BackdropFrostAuto: !fgBlur && frostAuto,
    Thickness: thickness,
    Refraction: Resolve(s.Refraction, ctx, 'W'),
    Glass: glass,
    GlassVariant: glass === 'Clear' ? 'Clear' : 'Regular',
    SchemeDark: parseFloat(ctx.Vars?.get(THEME_DARK_VAR) ?? '1') >= 0.5,
    Tint: _resolveTint(s, ctx),
    BackdropBrightness: backdrop.Brightness,
    BackdropSaturation: backdrop.Saturation,
    BackdropContrast: backdrop.Contrast,
    BackdropVibrancy: backdrop.Vibrancy,
    BackdropVibrancyCover: backdrop.VibrancyCover,

    // Foreground filter grade — multiplies the element's final rgb at paint
    // time and cascades to descendants (folded into Effective* downstream).
    Brightness: fg.Brightness,
    Saturation: fg.Saturation,
    Contrast: fg.Contrast,
    Isolate: s.Isolate === 'true' || (s.Isolate as unknown) === true,



    ChromaticAberration: Resolve(s.ChromaticAberration, ctx, 'W'),
    Magnification: Resolve(s.Magnification, ctx, 'W'),
    LensInk: ParseColor(ResolveVars(ResolveTernary(s.LensInk, ctx), ctx)),
    RimWidth: Math.max(0, Resolve(ResolveTernary(s.RimWidth, ctx), ctx, 'W')),
    RimStrength: Math.max(0, Math.min(2, Resolve(ResolveTernary(s.RimStrength, ctx), ctx, 'W'))),

    Transform: ResolveTransform(ResolveTernary(s.Transform, ctx), ctx),

    // Visual* — render-time scale/translate around an origin, applied
    // per-Jiv only (no descendant cascade). Each shorthand string is
    // split into [X, Y]; uniform values populate both axes.
    ...(() => {
      const [vsx, vsy] = _parseVisualPair(ResolveTernary(s.VisualScale, ctx), ctx, 1);
      const [vtx, vty] = _parseVisualPair(ResolveTernary(s.VisualTranslate, ctx), ctx, 0);
      const [vox, voy] = _parseVisualPair(ResolveTernary(s.VisualOrigin, ctx), ctx, 0.5);
      const [pox, poy] = _parseVisualPair(ResolveTernary(s.PerspectiveOrigin, ctx), ctx, 0.5);
      return {
        VisualScaleX: vsx, VisualScaleY: vsy,
        VisualTranslateX: vtx, VisualTranslateY: vty,
        VisualOriginX: vox, VisualOriginY: voy,
        Perspective: Resolve(ResolveTernary(s.Perspective, ctx), ctx, 'W'),
        PerspectiveOriginX: pox, PerspectiveOriginY: poy,
      };
    })(),

    BorderColor: ParseColor(ResolveVars(ResolveTernary(s.BorderColor, ctx), ctx)),
    BorderWidth: Resolve(s.BorderWidth, ctx, 'W'),
    BorderBlur: Resolve(s.BorderBlur, ctx, 'W'),
    BorderFade: Resolve(s.BorderFade, ctx, 'W'),
    BorderOffset: Resolve(s.BorderOffset, ctx, 'W'),
    ContainBorder: s.ContainBorder,
    BorderLayer: Resolve(s.BorderLayer, ctx, 'W'),

    ShadowColor: ParseColor(ResolveVars(ResolveTernary(s.ShadowColor, ctx), ctx)),
    ShadowBlur: Resolve(s.ShadowBlur, ctx, 'W'),
    ShadowOffsetX: Resolve(s.ShadowOffsetX, ctx, 'W'),
    ShadowOffsetY: Resolve(s.ShadowOffsetY, ctx, 'H'),
    InnerShadow: s.InnerShadow,

    Opacity: Resolve(s.Opacity, ctx, 'W'),

    Layer: Resolve(s.Layer, ctx, 'W'),
  };
};

/** Seed ResolveContext for contexts that haven't had layout run yet. Used
 *  by Jiv constructor to give RenderStyle a plausible initial state.
 *
 *  Vars is intentionally an empty Map (rather than omitted): an authored
 *  style that references a var (e.g. `BorderRadius: @CellR`) hits this
 *  context first at construction, before the StyleAnimator ever ticks
 *  and re-resolves with the live registry's var table. Omitting Vars
 *  here would trip Length.Resolve's "no var table in context" warning
 *  on every Jiv whose author used a var — even though the next animator
 *  tick resolves them correctly. The seed value falls back to 0; the
 *  real value lands one frame later. */
export const SEED_CONTEXT: ResolveContext = {
  ParentWidth: 0, ParentHeight: 0,
  PointScale: 16, ParentPointScale: 16, RootPointScale: 16,
  ViewportWidth: 0, ViewportHeight: 0,
  Vars: new Map(),
  IsSeed: true,
};
