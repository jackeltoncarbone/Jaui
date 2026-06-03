import type { JivStyle, JivRenderStyle, CornerShape, ResolvedLight, LightKind } from '../Jiv/Jiv.Types';
import type { ResolveContext } from './Length';
import { Resolve, ResolveScalar } from './Length';
import { ResolveLengthTuple4 } from './Length.Tuple';
import { ParseColor } from './Color.Parse';
import { ParseBackground } from './Background.Parse';
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


/** VisualScale / VisualOrigin are dimensionless ratios, not lengths — a
 *  bare `'1'` means the literal scalar 1, NOT `1pt` (which the unitless→pt
 *  default would scale by PointScale, e.g. ×16, blowing up the cascaded
 *  transform). A plain number is taken verbatim; anything with units/`%`/an
 *  expression still routes through Resolve. */
const _parseScalarPair = (
  raw: string,
  ctx: ResolveContext,
  fallback: number,
): [number, number] => {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return [fallback, fallback];
  if (parts.length === 1) {
    const v = ResolveScalar(parts[0], ctx, 'W');
    return [v, v];
  }
  return [ResolveScalar(parts[0], ctx, 'W'), ResolveScalar(parts[1], ctx, 'H')];
};

/** Parse a Visual* shorthand string into [X, Y, Z] numbers.
 *  - `'v'`       → [v, v, 0]   (uniform XY, Z=0)
 *  - `'x y'`     → [x, y, 0]
 *  - `'x y z'`   → [x, y, z]
 *  - empty/whitespace → [fallback, fallback, 0]
 *  Each token is resolved as a Length under `ctx` like `_parseVisualPair`;
 *  Z resolves on the 'W' axis (same as X). */
const _parseVisualTriple = (
  raw: string,
  ctx: ResolveContext,
  fallback: number,
): [number, number, number] => {
  const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return [fallback, fallback, 0];
  if (parts.length === 1) {
    const v = Resolve(parts[0], ctx, 'W');
    return [v, v, 0];
  }
  if (parts.length === 2) {
    return [Resolve(parts[0], ctx, 'W'), Resolve(parts[1], ctx, 'H'), 0];
  }
  return [Resolve(parts[0], ctx, 'W'), Resolve(parts[1], ctx, 'H'), Resolve(parts[2], ctx, 'W')];
};

/** Resolve `MaxWidth`/`MaxHeight` with CSS-style "none" → Infinity. */
const _resolveBound = (raw: string, ctx: ResolveContext, axis: 'W' | 'H'): number => {
  if (raw === 'none') return Infinity;
  return Resolve(raw, ctx, axis);
};
export { _resolveBound as ResolveBound };

/** A Jiv is ONE physical surface — there is no glass/solid/translucent type.
 *  These two booleans are NOT a taxonomy; they are render-path selectors derived
 *  purely from the physical attributes the author set, used internally by the
 *  orchestrator + shader to pick how the backdrop is sampled. They never surface
 *  as an author-visible category and never gate visibility.
 *
 *  `SamplesBackdrop`: the surface reads the scene behind it (transmission) — true
 *  when any backdrop filter is non-identity or refraction is set. A surface that
 *  doesn't sample the backdrop simply paints its own fill; one that does refracts
 *  / frosts the scene. Continuous: every term scales from the same attributes.
 *  `HasProgressiveBlur`: a directional ramp (its own sampler over the pyramid). */
const _samplesBackdrop = (s: JivStyle): boolean =>
  s.BackdropFrostBlur !== '0' ||
  s.BackdropBrightness !== '1' || s.BackdropSaturation !== '1' || s.BackdropContrast !== '1' ||
  s.Refraction !== '0' || s.Frost !== '0';

const _LIGHT_KINDS: ReadonlySet<string> = new Set(['Directional', 'Ambient', 'Point', 'Spot', 'Area']);

/** Build a ResolvedLight from the Light* props when LightType is set, else null.
 *  A Jiv is a scene light iff it carries a valid LightType — purely additive, no
 *  effect on ordinary Jivs. Direction is a 3-vector; Range a length; intensity a
 *  scalar; cone angle deg->rad. Position is filled later from solved layout. */
const _resolveLight = (s: JivStyle, ctx: ResolveContext): ResolvedLight | null => {
  const kind = s.LightType.trim();
  if (kind === '' || !_LIGHT_KINDS.has(kind)) return null;
  const dir = s.LightDirection.trim().split(/\s+/).filter(Boolean);
  const dx = dir[0] !== undefined ? ResolveScalar(dir[0], ctx, 'W') : 0;
  const dy = dir[1] !== undefined ? ResolveScalar(dir[1], ctx, 'H') : 0;
  const dz = dir[2] !== undefined ? ResolveScalar(dir[2], ctx, 'W') : -1;
  return {
    Kind: kind as LightKind,
    Color: ParseColor(s.LightColor),
    Intensity: ResolveScalar(s.LightIntensity_, ctx, 'W'),
    Direction: [dx, dy, dz],
    Range: Resolve(s.LightRange, ctx, 'W'),
    ConeAngle: ResolveScalar(s.LightConeAngle, ctx, 'W') * (Math.PI / 180),
    Penumbra: ResolveScalar(s.LightPenumbra, ctx, 'W'),
    CastShadow: s.LightCastShadow,
  };
};

/** Resolve a full JivStyle into a JivRenderStyle under the given context. */
export const ResolveStyle = (s: JivStyle, ctx: ResolveContext): JivRenderStyle => {
  const borderRadius = ResolveLengthTuple4(s.BorderRadius, ctx, ['W', 'W', 'W', 'W']);
  // Unified physical depth: Thickness and Elevation are both real depth
  // contributions on the one surface — they sum. 0 = an impossibly thin sheet
  // (the shape, zero depth), continuous up from there. No promotion, no mode.
  const depth = ResolveScalar(s.Thickness, ctx, 'W') + ResolveScalar(s.Elevation, ctx, 'W');

  return {
    SamplesBackdrop: _samplesBackdrop(s),
    HasProgressiveBlur: s.ProgressiveBlurDirection !== null,
    Depth: depth,
    Light: _resolveLight(s, ctx),
    ProgressiveBlurDirection: s.ProgressiveBlurDirection ?? 'ToTop',
    ProgressiveBlurFeather: Resolve(s.ProgressiveBlurFeather, ctx, 'H'),
    ProgressiveBlurEasing: ResolveScalar(s.ProgressiveBlurEasing, ctx, 'W'),
    PointScale: Resolve(s.PointScale, ctx, 'W', true),

    BorderRadius: borderRadius,
    CornerShape: _parseCornerShape(s.CornerShape),
    BorderRadiusSmoothness: ResolveScalar(s.BorderRadiusSmoothness, ctx, 'W'),

    Background: ParseBackground(s.Background),
    BlendMode: s.BlendMode,
    Space: s.Space ?? 'Screen',

    Frost: Resolve(s.Frost, ctx, 'W'),
    BackdropFrostBlur: Resolve(s.BackdropFrostBlur, ctx, 'W'),
    // Depth/Fillet/BezelWidth are device-px slab measures consumed raw by the
    // InstanceBuffer (it applies dpr itself) — NOT pt lengths, never
    // ×PointScale'd. ResolveScalar keeps bare numbers literal (%/@var still
    // resolve). `Depth` (above) is the single unified physical depth.
    Fillet: ResolveScalar(s.Fillet, ctx, 'W'),
    Refraction: ResolveScalar(s.Refraction, ctx, 'W'),
    BackdropBrightness: ResolveScalar(s.BackdropBrightness, ctx, 'W'),
    BackdropSaturation: ResolveScalar(s.BackdropSaturation, ctx, 'W'),
    BackdropContrast: ResolveScalar(s.BackdropContrast, ctx, 'W'),

    // Foreground brightness — multiplies the element's final rgb at paint time.
    Brightness: ResolveScalar(s.Brightness, ctx, 'W'),

    BezelWidth: ResolveScalar(s.BezelWidth, ctx, 'W'),
    BezelScale: ResolveScalar(s.BezelScale, ctx, 'W'),

    LightAngle: ResolveScalar(s.LightAngle, ctx, 'W'),
    LightIntensity: ResolveScalar(s.LightIntensity, ctx, 'W'),

    SpecularIntensity: ResolveScalar(s.SpecularIntensity, ctx, 'W'),
    SpecularSharpness: ResolveScalar(s.SpecularSharpness, ctx, 'W'),
    FresnelStrength: ResolveScalar(s.FresnelStrength, ctx, 'W'),
    ChromaticAberration: ResolveScalar(s.ChromaticAberration, ctx, 'W'),
    EdgeLightTop: ResolveScalar(s.EdgeLightTop, ctx, 'W'),
    EdgeLightBottom: ResolveScalar(s.EdgeLightBottom, ctx, 'W'),
    BorderVariance: ResolveScalar(s.BorderVariance, ctx, 'W'),
    BorderAlphaVariance: ResolveScalar(s.BorderAlphaVariance, ctx, 'W'),
    BorderFresnelBrightness: ResolveScalar(s.BorderFresnelBrightness, ctx, 'W'),
    InnerBlur: ResolveScalar(s.InnerBlur, ctx, 'W'),

    Transform: ResolveTransform(s.Transform, ctx),

    // Visual* — render-time scale/translate around an origin, applied
    // per-Jiv only (no descendant cascade). Each shorthand string is
    // split into [X, Y]; uniform values populate both axes.
    ...(() => {
      const [vsx, vsy] = _parseScalarPair(s.VisualScale, ctx, 1);
      const [vtx, vty, vtz] = _parseVisualTriple(s.VisualTranslate, ctx, 0);
      const [vox, voy] = _parseScalarPair(s.VisualOrigin, ctx, 0.5);
      return {
        VisualScaleX: vsx, VisualScaleY: vsy,
        VisualTranslateX: vtx, VisualTranslateY: vty, VisualTranslateZ: vtz,
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
