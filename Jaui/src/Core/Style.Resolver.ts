import type { JivStyle, JivRenderStyle, CornerShape, MaterialType, ProgressiveBlurDirection, BlurStop } from '../Jiv/Jiv.Types';
import { ParseProgressiveBlur } from '../ProgressiveBlur/ProgressiveBlur.Stops';
import type { ResolveContext } from './Length';
import { Resolve, ResolveTernary, ResolveVars } from './Length';
import { ResolveLengthTuple4 } from './Length.Tuple';
import { ParseColor } from './Color.Parse';
import { ParseBackground } from './Background.Parse';
import { ParseFilter, SplitTopLevelArgs } from './Filter.Parse';
import type { LiftDeclaration } from './Lift';
import type { Color } from './Types';
import { ResolveTransform } from '../Transform/Transform.Parse';

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

// `[^()]*` would stop at the first inner paren, so a two-argument `Lift(rgb(...), @Var)` matched
// nothing at all and its var was never resolved. One optional nested level is exactly what a color
// function needs, and it is bounded rather than a general balanced-paren scan, because a grade
// argument is an ARITHMETIC expression over vars and only its color argument nests.
const _GRADE_FN = /(Brightness|Saturate|Contrast|Lift)\s*\(((?:[^()]|\([^()]*\))*)\)/gi;

/** A grade argument may be a length expression over vars, so a material can state its per-theme grade in
 *  one line: `Contrast(0.6 * @Dark + 1 * @Light)`, and a wash its per-theme lift: `Lift(@JwiftWashLift)`.
 *  Those arguments are evaluated to numbers here, before the filter parse (which caches by string and
 *  reads plain numbers). Literal filters pass through untouched. */
const _resolveGradeArgs = (raw: string, ctx: ResolveContext): string => {
  if (raw.indexOf('@') < 0) return raw;
  return raw.replace(_GRADE_FN, (whole, fn: string, arg: string) => {
    if (arg.indexOf('@') < 0) return whole;
    // `Lift(<color>, <amount>)`: the AMOUNT is the length expression and the COLOR is not. Resolving
    // the color here would hand `rgb(255, 220, 180)` to the arithmetic evaluator. The color's own
    // vars are resolved by `ResolveVars` at the point the color is parsed -- there is NO color
    // arithmetic in the resolver, and this shape does not need any.
    const parts = SplitTopLevelArgs(arg);
    if (parts.length === 2) {
      const amount = parts[1].indexOf('@') < 0 ? parts[1] : String(Resolve(parts[1], ctx, 'W'));
      return `${fn}(${parts[0]}, ${amount})`;
    }
    return `${fn}(${Resolve(arg.trim(), ctx, 'W')})`;
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

/** `Lift: <color> <amount>` -- the INHERITED additive color (Core/Lift.ts). `None` is the reset,
 *  `Inherit` (the initial value) takes the ancestor's. The pair is the same one `Lift()` takes, and
 *  the amount is in 0-255 units in every spelling, so a wash var reads identically in all three
 *  places it can appear.
 *
 *  The color is resolved through `ResolveVars` + `ParseColor` -- the same two steps `Background` and
 *  `BorderColor` take -- and the amount through the length evaluator, which is where the theme flip
 *  lives (`18 * @Dark - 12 * @Light`). There is no color arithmetic here. */
const _resolveLiftProperty = (raw: string, ctx: ResolveContext): LiftDeclaration => {
  const t = raw.trim();
  if (t === '' || t.toLowerCase() === 'inherit') return 'Inherit';
  if (t.toLowerCase() === 'none') return 'None';
  // The amount is the LAST whitespace-separated token at paren depth 0, so a color function's own
  // spaces (`rgb(255 220 180)`, CSS4) do not split the value.
  const split = _splitColorAndAmount(t);
  if (split === null) {
    throw new Error(
      `[Jaui] Lift: "${raw}" — expected "<color> <amount>", "None" or "Inherit". The amount is signed, ` +
      'in 0-255 units, and it is what flips with the theme (Lift: rgb(255,255,255) @JwiftWashLift).',
    );
  }
  const color = ParseColor(ResolveVars(split.Color, ctx));
  const n = Resolve(split.Amount, ctx, 'W');
  if (!Number.isFinite(n)) throw new Error(`[Jaui] Lift: "${raw}" — the amount did not resolve to a number.`);
  if (Math.abs(n) > 255) throw new Error(`[Jaui] Lift: "${raw}" — the amount is signed and at most 255, got ${n}.`);
  return { R: color.R, G: color.G, B: color.B, Amount: n / 255 };
};

/** Split `<color> <amount>` at the last depth-0 whitespace run. Returns null when there is only one
 *  token, because an additive color without an amount has no direction and no theme flip -- that is
 *  the author's omission and it is named rather than defaulted. */
const _splitColorAndAmount = (t: string): { Color: string; Amount: string } | null => {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\s/.test(ch)) cut = i;
  }
  if (cut <= 0) return null;
  const color = t.slice(0, cut).trim();
  const amount = t.slice(cut + 1).trim();
  if (color === '' || amount === '') return null;
  return { Color: color, Amount: amount };
};

/** A `Lift()` function's color argument, as the render style's `Color`. `null` -- the one-argument
 *  spelling -- is WHITE, which is what keeps `Lift(18)` byte-identical. The alpha is 1 and unused: an
 *  additive color has nothing to be transparent over.
 *
 *  A FRESH object every call, which is `ParseColor`'s own documented rule -- a shared color object
 *  handed to every element would be written through by anything that springs a channel. */
const _resolveLiftColor = (raw: string | null, ctx: ResolveContext): Color => {
  if (raw === null) return { R: 1, G: 1, B: 1, A: 1 };
  const c = ParseColor(ResolveVars(raw, ctx));
  return { R: c.R, G: c.G, B: c.B, A: 1 };
};

const _inferMaterial = (thickness: number, direction: ProgressiveBlurDirection | null): MaterialType => {
  if (direction !== null) return 'ProgressiveBlur';
  if (thickness > 0) return 'LiquidGlass';
  return 'None';
};

/** Resolve a full JivStyle into a JivRenderStyle under the given context. */
export const ResolveStyle = (s: JivStyle, ctx: ResolveContext): JivRenderStyle => {
  const rawRadius = ResolveLengthTuple4(s.BorderRadius, ctx, ['W', 'W', 'W', 'W']);
  const smoothness = Resolve(s.BorderRadiusSmoothness, ctx, 'W');
  // Superellipse compensation, solved rather than fitted, so an authored radius reads as the CIRCLE of
  // that radius at every smoothness. The shader draws the corner as a superellipse of exponent
  // n = SmoothnessToExponent(s) = 2 + 6s, which hugs the square corner tighter than a circle of the same
  // radius. Both curves are symmetric about the corner diagonal, so they agree exactly when they reach
  // equally far along it: a circle of radius r comes within r(sqrt2 - 1) of the corner point, a
  // superellipse of radius R within sqrt2 * R * (1 - 2^(-1/n)). Equating the two and solving for R/r:
  //
  //     cornerScale(n) = (1 - 2^(-1/2)) / (1 - 2^(-1/n))
  //
  // which is exactly 1 at n = 2 (no compensation for a true circle) and grows with smoothness. The old
  // 1 + 2.6s was a straight-line fit through the same curve, 0.7% to 2.0% wide across the range, and it
  // never landed concentric. Saturated pills are untouched: the half-box clamp and the fullyRounded
  // circle collapse still apply downstream, and saturation is keyed to the AUTHORED radius (see
  // Jiv.InstanceBuffer) so this flare can never promote a rounded rectangle into a capsule.
  const cornerExponent = 2 + 6 * Math.max(0, Math.min(1, smoothness));
  const cornerScale = (1 - Math.SQRT1_2) / (1 - Math.pow(2, -1 / cornerExponent));
  const borderRadius = rawRadius.map(r => r * cornerScale) as typeof rawRadius;
  const thickness = Resolve(s.Thickness, ctx, 'W');

  // Filters — each authored as a CSS-shaped function list, normalized into
  // the per-zone scalar render fields the shader already consumes. Blur()'s
  // arg stays a Length and resolves under ctx (frost px for BackdropFilter,
  // LOD octave offset for BorderFilter); a missing Blur() = 0.
  const fg = ParseFilter(_resolveGradeArgs(ResolveTernary(s.Filter, ctx), ctx), 'foreground');
  const backdrop = ParseFilter(_resolveGradeArgs(ResolveTernary(s.BackdropFilter, ctx), ctx));
  const border = ParseFilter(_resolveGradeArgs(ResolveTernary(s.BorderFilter, ctx), ctx));
  // The rim's Fresnel highlight grades separately from the rim's gather: the gather is
  // the backdrop seen THROUGH the bevel, the highlight is what the lit face throws back.
  // Brightness + Saturate only; the 'fresnel' zone throws on Blur()/Contrast().
  const fresnel = ParseFilter(_resolveGradeArgs(ResolveTernary(s.BorderFresnelFilter, ctx), ctx), 'fresnel');
  const resolveBlur = (raw: string | null): number => (raw !== null ? Resolve(raw, ctx, 'W') : 0);
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
    Material: _inferMaterial(thickness, effDirection),
    ProgressiveBlurDirection: effDirection ?? 'ToTop',
    ProgressiveBlurFeather: fgFeather !== null ? fgFeather : Resolve(s.ProgressiveBlurFeather, ctx, 'H'),
    ProgressiveBlurEasing: fgBlur && !fgBlur.Uniform ? fgBlur.Easing : Resolve(s.ProgressiveBlurEasing, ctx, 'W'),
    ProgressiveBlurStops: blurSpec?.Stops ?? fgStops,
    PointScale: Resolve(s.PointScale, ctx, 'W', true),

    BorderRadius: borderRadius,
    BorderRadiusRaw: rawRadius,
    CornerShape: _parseCornerShape(ResolveTernary(s.CornerShape, ctx)),
    BorderRadiusSmoothness: smoothness,

    Background: ParseBackground(ResolveVars(ResolveTernary(s.Background, ctx), ctx)),

    LiftDeclaration: _resolveLiftProperty(ResolveTernary(s.Lift, ctx), ctx),
    ForegroundLift: fg.Lift,
    ForegroundLiftColor: _resolveLiftColor(fg.LiftColor, ctx),
    BackdropLiftColor: _resolveLiftColor(backdrop.LiftColor, ctx),

    Frost: Resolve(s.Frost, ctx, 'W'),
    // Heavy-end frost sigma for the pblur material: the foreground Filter blur
    // radius drives it when present, else the backdrop frost. The pblur shader
    // reads this as the ramp's max blur.
    BackdropFrostBlur: fgBlur ? fgFrost : resolveBlur(backdrop.BlurRaw),
    Thickness: thickness,
    Fillet: Resolve(s.Fillet, ctx, 'W'),
    Refraction: Resolve(s.Refraction, ctx, 'W'),
    Tint: _resolveTint(s, ctx),
    AdaptiveFar: Math.max(0, Math.min(2, Resolve(ResolveTernary(s.AdaptiveFar, ctx), ctx, 'W'))),
    BackdropBrightness: backdrop.Brightness,
    BackdropSaturation: backdrop.Saturation,
    BackdropContrast: backdrop.Contrast,
    BackdropLift: backdrop.Lift,

    // Foreground filter grade — multiplies the element's final rgb at paint
    // time and cascades to descendants (folded into Effective* downstream).
    Brightness: fg.Brightness,
    Saturation: fg.Saturation,
    Contrast: fg.Contrast,
    Isolate: s.Isolate === 'true' || (s.Isolate as unknown) === true,

    BezelWidth: Resolve(s.BezelWidth, ctx, 'W'),
    BezelScale: Resolve(s.BezelScale, ctx, 'W'),

    LightAngle: Resolve(s.LightAngle, ctx, 'W'),
    LightIntensity: Resolve(s.LightIntensity, ctx, 'W'),

    SpecularIntensity: Resolve(s.SpecularIntensity, ctx, 'W'),
    SpecularSharpness: Resolve(s.SpecularSharpness, ctx, 'W'),
    FresnelStrength: Resolve(s.FresnelStrength, ctx, 'W'),
    ChromaticAberration: Resolve(s.ChromaticAberration, ctx, 'W'),
    EdgeLightTop: Resolve(s.EdgeLightTop, ctx, 'W'),
    EdgeLightBottom: Resolve(s.EdgeLightBottom, ctx, 'W'),
    BorderVariance: Resolve(s.BorderVariance, ctx, 'W'),
    BorderAlphaVariance: Resolve(s.BorderAlphaVariance, ctx, 'W'),
    BorderFresnelStrength: Resolve(s.BorderFresnelStrength, ctx, 'W'),
    InnerBlur: Resolve(s.InnerBlur, ctx, 'W'),

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
    BorderBackdropBlur: resolveBlur(border.BlurRaw),
    BorderOffset: Resolve(s.BorderOffset, ctx, 'W'),
    ContainBorder: s.ContainBorder,
    BorderLayer: Resolve(s.BorderLayer, ctx, 'W'),

    BorderBrightness: border.Brightness,
    BorderSaturation: border.Saturation,
    BorderContrast: border.Contrast,

    BorderFresnelBrightness: fresnel.Brightness,
    BorderFresnelSaturation: fresnel.Saturation,

    ShadowColor: ParseColor(ResolveVars(ResolveTernary(s.ShadowColor, ctx), ctx)),
    ShadowBlur: Resolve(s.ShadowBlur, ctx, 'W'),
    ShadowOffsetX: Resolve(s.ShadowOffsetX, ctx, 'W'),
    ShadowOffsetY: Resolve(s.ShadowOffsetY, ctx, 'H'),
    ShadowAdaptive: Math.max(0, Math.min(1, Resolve(ResolveTernary(s.ShadowAdaptive, ctx), ctx, 'W'))),
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
