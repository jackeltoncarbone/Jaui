import { Spring } from '../Animation/Spring';
import type { Animatable } from '../Animation/Animation.Manager';
import type { Jiv } from './Jiv';
import type { JivRenderStyle } from './Jiv.Types';
import { ResolveStyle, SEED_CONTEXT } from '../Core/Style.Resolver';

/**
 * Springs every numeric channel of a Jiv's RenderStyle toward the
 * fully-resolved target produced by StyleResolver.ResolveStyle.
 *
 * Each tick:
 *   1. target = ResolveStyle(Jiv.EffectiveStyle(), Jiv.ResolveCtx)
 *   2. For every numeric binding, spring.Target = targetRender[field]
 *   3. spring.Step(dt); write spring.Value into renderStyle[field]
 *
 * Non-numeric fields (Material, Overflow, BlendMode, booleans) snap — they're
 * copied directly into RenderStyle from the target each tick. No spring.
 *
 * Colors, Transform.*, and BorderRadius[] are decomposed into their leaf
 * numeric channels so each channel is independently spring-animated (e.g.
 * R, G, B, A channels of Background each get their own spring).
 */

/** Getter/setter pair operating on the already-resolved JivRenderStyle. */
type RenderGetter = (s: JivRenderStyle) => number;
type RenderSetter = (s: JivRenderStyle, v: number) => void;

const BINDINGS: Array<[RenderGetter, RenderSetter]> = [
  // Shape
  [s => s.BorderRadiusSmoothness,       (s, v) => { s.BorderRadiusSmoothness = v; }],
  [s => s.BorderRadius[0],              (s, v) => { s.BorderRadius[0] = v; }],
  [s => s.BorderRadius[1],              (s, v) => { s.BorderRadius[1] = v; }],
  [s => s.BorderRadius[2],              (s, v) => { s.BorderRadius[2] = v; }],
  [s => s.BorderRadius[3],              (s, v) => { s.BorderRadius[3] = v; }],

  // Fill — Background color (per-channel)
  [s => s.Background.R,                 (s, v) => { s.Background.R = v; }],
  [s => s.Background.G,                 (s, v) => { s.Background.G = v; }],
  [s => s.Background.B,                 (s, v) => { s.Background.B = v; }],
  [s => s.Background.A,                 (s, v) => { s.Background.A = v; }],

  // Physical material
  [s => s.Frost,                        (s, v) => { s.Frost = v; }],
  [s => s.BackdropFrostBlur,            (s, v) => { s.BackdropFrostBlur = v; }],
  [s => s.Thickness,                    (s, v) => { s.Thickness = v; }],
  [s => s.Fillet,                       (s, v) => { s.Fillet = v; }],
  [s => s.Refraction,                   (s, v) => { s.Refraction = v; }],
  [s => s.BackdropBrightness,           (s, v) => { s.BackdropBrightness = v; }],
  [s => s.BackdropSaturation,           (s, v) => { s.BackdropSaturation = v; }],
  [s => s.BackdropContrast,             (s, v) => { s.BackdropContrast = v; }],

  // Refraction band geometry
  [s => s.BezelWidth,                   (s, v) => { s.BezelWidth = v; }],
  [s => s.BezelScale,                   (s, v) => { s.BezelScale = v; }],

  // Lighting
  [s => s.LightAngle,                   (s, v) => { s.LightAngle = v; }],
  [s => s.LightIntensity,               (s, v) => { s.LightIntensity = v; }],
  [s => s.SpecularIntensity,            (s, v) => { s.SpecularIntensity = v; }],
  [s => s.SpecularSharpness,            (s, v) => { s.SpecularSharpness = v; }],
  [s => s.FresnelStrength,              (s, v) => { s.FresnelStrength = v; }],
  [s => s.ChromaticAberration,          (s, v) => { s.ChromaticAberration = v; }],
  [s => s.EdgeLightTop,                 (s, v) => { s.EdgeLightTop = v; }],
  [s => s.EdgeLightBottom,              (s, v) => { s.EdgeLightBottom = v; }],
  [s => s.BorderVariance,               (s, v) => { s.BorderVariance = v; }],
  [s => s.BorderAlphaVariance,          (s, v) => { s.BorderAlphaVariance = v; }],
  [s => s.BorderFresnelBrightness,      (s, v) => { s.BorderFresnelBrightness = v; }],
  [s => s.InnerBlur,                    (s, v) => { s.InnerBlur = v; }],

  // Transform — per-channel
  [s => s.Transform.TranslateX,         (s, v) => { s.Transform.TranslateX = v; }],
  [s => s.Transform.TranslateY,         (s, v) => { s.Transform.TranslateY = v; }],
  [s => s.Transform.ScaleX,             (s, v) => { s.Transform.ScaleX = v; }],
  [s => s.Transform.ScaleY,             (s, v) => { s.Transform.ScaleY = v; }],
  [s => s.Transform.Rotation,           (s, v) => { s.Transform.Rotation = v; }],
  [s => s.Transform.SkewX,              (s, v) => { s.Transform.SkewX = v; }],
  [s => s.Transform.SkewY,              (s, v) => { s.Transform.SkewY = v; }],
  [s => s.Transform.OriginX,            (s, v) => { s.Transform.OriginX = v; }],
  [s => s.Transform.OriginY,            (s, v) => { s.Transform.OriginY = v; }],

  // Border — color + geometry
  [s => s.BorderColor.R,                (s, v) => { s.BorderColor.R = v; }],
  [s => s.BorderColor.G,                (s, v) => { s.BorderColor.G = v; }],
  [s => s.BorderColor.B,                (s, v) => { s.BorderColor.B = v; }],
  [s => s.BorderColor.A,                (s, v) => { s.BorderColor.A = v; }],
  [s => s.BorderWidth,                  (s, v) => { s.BorderWidth = v; }],
  [s => s.BorderBlur,                   (s, v) => { s.BorderBlur = v; }],
  [s => s.BorderOffset,                 (s, v) => { s.BorderOffset = v; }],
  [s => s.BorderBrightness,             (s, v) => { s.BorderBrightness = v; }],
  [s => s.BorderSaturation,             (s, v) => { s.BorderSaturation = v; }],
  [s => s.BorderContrast,               (s, v) => { s.BorderContrast = v; }],
  [s => s.BorderFrostLodOffset,         (s, v) => { s.BorderFrostLodOffset = v; }],

  // Shadow
  [s => s.ShadowColor.R,                (s, v) => { s.ShadowColor.R = v; }],
  [s => s.ShadowColor.G,                (s, v) => { s.ShadowColor.G = v; }],
  [s => s.ShadowColor.B,                (s, v) => { s.ShadowColor.B = v; }],
  [s => s.ShadowColor.A,                (s, v) => { s.ShadowColor.A = v; }],
  [s => s.ShadowBlur,                   (s, v) => { s.ShadowBlur = v; }],
  [s => s.ShadowOffsetX,                (s, v) => { s.ShadowOffsetX = v; }],
  [s => s.ShadowOffsetY,                (s, v) => { s.ShadowOffsetY = v; }],

  // Appearance
  [s => s.Opacity,                      (s, v) => { s.Opacity = v; }],

  // PointScale — cascades + animates with the rest
  [s => s.PointScale,                   (s, v) => { s.PointScale = v; }],
];

const DEFAULT_STIFFNESS = 260;
const DEFAULT_DAMPING = 32;
const DEFAULT_MASS = 1;

/** Copy all non-animated fields from target into render. These snap without
 *  a spring: booleans, enums, and identity-shared nested structures. */
const _copyNonAnimated = (render: JivRenderStyle, target: JivRenderStyle): void => {
  render.Material = target.Material;
  render.ProgressiveBlurDirection = target.ProgressiveBlurDirection;
  render.CornerShape = target.CornerShape;
  render.Overflow = target.Overflow;
  render.BlendMode = target.BlendMode;
  render.ContainBorder = target.ContainBorder;
  render.InnerShadow = target.InnerShadow;
  render.Visible = target.Visible;
  render.Cursor = target.Cursor;
  render.Interactive = target.Interactive;
  render.PointerEvents = target.PointerEvents;
  render.UserSelect = target.UserSelect;
};

export class JivStyleAnimator implements Animatable {
  private _springs: Spring[];

  constructor(private _jiv: Jiv) {
    // Resolve the initial target under the seed ctx (or the Jiv's ctx if
    // it has one already from a prior pass). Springs start settled at the
    // initial values so there's no entry animation.
    const ctx = _jiv.ResolveCtx ?? SEED_CONTEXT;
    const target = ResolveStyle(_jiv.Style, ctx);
    this._springs = BINDINGS.map(([get]) =>
      new Spring(get(target), DEFAULT_STIFFNESS, DEFAULT_DAMPING, DEFAULT_MASS));
  }

  /** Force all springs to their current targets (zero velocity) and mirror
   *  back onto RenderStyle. Used on first layout so newly-created Jivs
   *  render at the target without a frame of catch-up animation. */
  SnapToTargets = (): void => {
    const ctx = this._jiv.ResolveCtx ?? SEED_CONTEXT;
    const target = ResolveStyle(this._jiv.EffectiveStyle(), ctx);
    _copyNonAnimated(this._jiv.RenderStyle, target);
    for (let i = 0; i < BINDINGS.length; i++) {
      const [get, set] = BINDINGS[i];
      const s = this._springs[i];
      s.Target = get(target);
      s.Snap();
      set(this._jiv.RenderStyle, s.Value);
    }
  };

  Tick = (dt: number): boolean => {
    const ctx = this._jiv.ResolveCtx ?? SEED_CONTEXT;
    const target = ResolveStyle(this._jiv.EffectiveStyle(), ctx);
    const render = this._jiv.RenderStyle;
    _copyNonAnimated(render, target);
    let active = false;
    for (let i = 0; i < BINDINGS.length; i++) {
      const [get, set] = BINDINGS[i];
      const s = this._springs[i];
      s.Target = get(target);
      if (s.Step(dt)) active = true;
      set(render, s.Value);
    }
    return active;
  };
}
