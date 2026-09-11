import type { JivStyle, JivRenderStyle, CornerShape, MaterialType, ProgressiveBlurDirection, BlurStop } from '../Jiv/Jiv.Types';
import { ParseProgressiveBlur } from '../ProgressiveBlur/ProgressiveBlur.Stops';
import type { ResolveContext } from './Length';
import { Resolve, ResolveTernary, ResolveVars } from './Length';
import { ResolveLengthTuple4 } from './Length.Tuple';
import { ParseColor } from './Color.Parse';
import { ParseBackground } from './Background.Parse';
import { ParseFilter } from './Filter.Parse';
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

const _inferMaterial = (thickness: number, direction: ProgressiveBlurDirection | null): MaterialType => {
  if (direction !== null) return 'ProgressiveBlur';
  if (thickness > 0) return 'LiquidGlass';
  return 'None';
};

/** Resolve a full JivStyle into a JivRenderStyle under the given context. */
export const ResolveStyle = (s: JivStyle, ctx: ResolveContext): JivRenderStyle => {
  const rawRadius = ResolveLengthTuple4(s.BorderRadius, ctx, ['W', 'W', 'W', 'W']);
  const smoothness = Resolve(s.BorderRadiusSmoothness, ctx, 'W');
  // Superellipse compensation (jev's corner law, strength retuned for Jaui's
  // n = 2+3s superellipse): a squircle at nominal r hugs the square corner
  // TIGHTER than a circle, so the drawn radius
  // grows with smoothness and the APPARENT radius lands on the authored number --
  // Apple's continuous-corner flare. Saturated pills are untouched: the half-box
  // clamp and the fullyRounded circle collapse still apply downstream.
  const cornerScale = 1 + smoothness * 2.6;
  const borderRadius = rawRadius.map(r => r * cornerScale) as typeof rawRadius;
  const thickness = Resolve(s.Thickness, ctx, 'W');

  // Filters — each authored as a CSS-shaped function list, normalized into
  // the per-zone scalar render fields the shader already consumes. Blur()'s
  // arg stays a Length and resolves under ctx (frost px for BackdropFilter,
  // LOD octave offset for BorderFilter); a missing Blur() = 0.
  const fg = ParseFilter(ResolveTernary(s.Filter, ctx), 'foreground');
  const backdrop = ParseFilter(ResolveTernary(s.BackdropFilter, ctx));
  const border = ParseFilter(ResolveTernary(s.BorderFilter, ctx));
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
    CornerShape: _parseCornerShape(ResolveTernary(s.CornerShape, ctx)),
    BorderRadiusSmoothness: smoothness,

    Background: ParseBackground(ResolveVars(ResolveTernary(s.Background, ctx), ctx)),
    BlendMode: s.BlendMode,

    Frost: Resolve(s.Frost, ctx, 'W'),
    // Heavy-end frost sigma for the pblur material: the foreground Filter blur
    // radius drives it when present, else the backdrop frost. The pblur shader
    // reads this as the ramp's max blur.
    BackdropFrostBlur: fgBlur ? fgFrost : resolveBlur(backdrop.BlurRaw),
    Thickness: thickness,
    Fillet: Resolve(s.Fillet, ctx, 'W'),
    Refraction: Resolve(s.Refraction, ctx, 'W'),
    BackdropBrightness: backdrop.Brightness,
    BackdropSaturation: backdrop.Saturation,
    BackdropContrast: backdrop.Contrast,

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
    BorderFresnelBrightness: Resolve(s.BorderFresnelBrightness, ctx, 'W'),
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
