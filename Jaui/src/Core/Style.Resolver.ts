import type { JivStyle, JivRenderStyle, CornerShape, MaterialType, ProgressiveBlurDirection } from '../Jiv/Jiv.Types';
import type { ResolveContext } from './Length';
import { Resolve } from './Length';
import { ResolveLengthTuple4 } from './Length.Tuple';
import { ParseColor } from './Color.Parse';
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
const _inferMaterial = (thickness: number, direction: ProgressiveBlurDirection | null): MaterialType => {
  if (direction !== null) return 'ProgressiveBlur';
  if (thickness > 0) return 'LiquidGlass';
  return 'None';
};

/** Resolve a full JivStyle into a JivRenderStyle under the given context. */
export const ResolveStyle = (s: JivStyle, ctx: ResolveContext): JivRenderStyle => {
  const borderRadius = ResolveLengthTuple4(s.BorderRadius, ctx, ['W', 'W', 'W', 'W']);
  const thickness = Resolve(s.Thickness, ctx, 'W');

  return {
    Material: _inferMaterial(thickness, s.ProgressiveBlurDirection),
    ProgressiveBlurDirection: s.ProgressiveBlurDirection ?? 'ToTop',
    ProgressiveBlurFeather: Resolve(s.ProgressiveBlurFeather, ctx, 'H'),
    ProgressiveBlurEasing: Resolve(s.ProgressiveBlurEasing, ctx, 'W'),
    PointScale: Resolve(s.PointScale, ctx, 'W', true),

    BorderRadius: borderRadius,
    CornerShape: _parseCornerShape(s.CornerShape),
    BorderRadiusSmoothness: Resolve(s.BorderRadiusSmoothness, ctx, 'W'),

    Background: ParseColor(s.Background),
    BlendMode: s.BlendMode,

    Frost: Resolve(s.Frost, ctx, 'W'),
    BackdropFrostBlur: Resolve(s.BackdropFrostBlur, ctx, 'W'),
    Thickness: thickness,
    Fillet: Resolve(s.Fillet, ctx, 'W'),
    Refraction: Resolve(s.Refraction, ctx, 'W'),
    BackdropBrightness: Resolve(s.BackdropBrightness, ctx, 'W'),
    BackdropSaturation: Resolve(s.BackdropSaturation, ctx, 'W'),
    BackdropContrast: Resolve(s.BackdropContrast, ctx, 'W'),

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

    Transform: ResolveTransform(s.Transform, ctx),

    // Visual* — render-time scale/translate around an origin, applied
    // per-Jiv only (no descendant cascade). Each shorthand string is
    // split into [X, Y]; uniform values populate both axes.
    ...(() => {
      const [vsx, vsy] = _parseVisualPair(s.VisualScale, ctx, 1);
      const [vtx, vty] = _parseVisualPair(s.VisualTranslate, ctx, 0);
      const [vox, voy] = _parseVisualPair(s.VisualOrigin, ctx, 0.5);
      return {
        VisualScaleX: vsx, VisualScaleY: vsy,
        VisualTranslateX: vtx, VisualTranslateY: vty,
        VisualOriginX: vox, VisualOriginY: voy,
      };
    })(),

    BorderColor: ParseColor(s.BorderColor),
    BorderWidth: Resolve(s.BorderWidth, ctx, 'W'),
    BorderBlur: Resolve(s.BorderBlur, ctx, 'W'),
    BorderBackdropBlur: Resolve(s.BorderBackdropBlur, ctx, 'W'),
    BorderOffset: Resolve(s.BorderOffset, ctx, 'W'),
    ContainBorder: s.ContainBorder,

    BorderBrightness: Resolve(s.BorderBrightness, ctx, 'W'),
    BorderSaturation: Resolve(s.BorderSaturation, ctx, 'W'),
    BorderContrast: Resolve(s.BorderContrast, ctx, 'W'),

    ShadowColor: ParseColor(s.ShadowColor),
    ShadowBlur: Resolve(s.ShadowBlur, ctx, 'W'),
    ShadowOffsetX: Resolve(s.ShadowOffsetX, ctx, 'W'),
    ShadowOffsetY: Resolve(s.ShadowOffsetY, ctx, 'H'),
    InnerShadow: s.InnerShadow,

    Opacity: Resolve(s.Opacity, ctx, 'W'),

    Layer: Resolve(s.Layer, ctx, 'W'),
  };
};

/** Seed ResolveContext for contexts that haven't had layout run yet. Used
 *  by Jiv constructor to give RenderStyle a plausible initial state. */
export const SEED_CONTEXT: ResolveContext = {
  ParentWidth: 0, ParentHeight: 0,
  PointScale: 16, ParentPointScale: 16, RootPointScale: 16,
  ViewportWidth: 0, ViewportHeight: 0,
};
