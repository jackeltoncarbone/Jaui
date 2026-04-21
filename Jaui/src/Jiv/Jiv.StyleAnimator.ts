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

/** Property name for per-property spring lookup. Sub-channels of composite
 *  values (Background.R, Transform.ScaleX, etc.) carry the AUTHOR-level
 *  property name, so `@Spring Background { ... }` springs all four RGBA
 *  channels with the same config. */
const BINDINGS: Array<[string, RenderGetter, RenderSetter]> = [
  // Shape
  ['BorderRadiusSmoothness', s => s.BorderRadiusSmoothness,       (s, v) => { s.BorderRadiusSmoothness = v; }],
  ['BorderRadius',           s => s.BorderRadius[0],              (s, v) => { s.BorderRadius[0] = v; }],
  ['BorderRadius',           s => s.BorderRadius[1],              (s, v) => { s.BorderRadius[1] = v; }],
  ['BorderRadius',           s => s.BorderRadius[2],              (s, v) => { s.BorderRadius[2] = v; }],
  ['BorderRadius',           s => s.BorderRadius[3],              (s, v) => { s.BorderRadius[3] = v; }],

  // Fill — Background color (per-channel)
  ['Background',             s => s.Background.R,                 (s, v) => { s.Background.R = v; }],
  ['Background',             s => s.Background.G,                 (s, v) => { s.Background.G = v; }],
  ['Background',             s => s.Background.B,                 (s, v) => { s.Background.B = v; }],
  ['Background',             s => s.Background.A,                 (s, v) => { s.Background.A = v; }],

  // Physical material
  ['Frost',                  s => s.Frost,                        (s, v) => { s.Frost = v; }],
  ['BackdropFrostBlur',      s => s.BackdropFrostBlur,            (s, v) => { s.BackdropFrostBlur = v; }],
  ['Thickness',              s => s.Thickness,                    (s, v) => { s.Thickness = v; }],
  ['Fillet',                 s => s.Fillet,                       (s, v) => { s.Fillet = v; }],
  ['Refraction',             s => s.Refraction,                   (s, v) => { s.Refraction = v; }],
  ['BackdropBrightness',     s => s.BackdropBrightness,           (s, v) => { s.BackdropBrightness = v; }],
  ['BackdropSaturation',     s => s.BackdropSaturation,           (s, v) => { s.BackdropSaturation = v; }],
  ['BackdropContrast',       s => s.BackdropContrast,             (s, v) => { s.BackdropContrast = v; }],

  // Refraction band geometry
  ['BezelWidth',             s => s.BezelWidth,                   (s, v) => { s.BezelWidth = v; }],
  ['BezelScale',             s => s.BezelScale,                   (s, v) => { s.BezelScale = v; }],

  // Lighting
  ['LightAngle',             s => s.LightAngle,                   (s, v) => { s.LightAngle = v; }],
  ['LightIntensity',         s => s.LightIntensity,               (s, v) => { s.LightIntensity = v; }],
  ['SpecularIntensity',      s => s.SpecularIntensity,            (s, v) => { s.SpecularIntensity = v; }],
  ['SpecularSharpness',      s => s.SpecularSharpness,            (s, v) => { s.SpecularSharpness = v; }],
  ['FresnelStrength',        s => s.FresnelStrength,              (s, v) => { s.FresnelStrength = v; }],
  ['ChromaticAberration',    s => s.ChromaticAberration,          (s, v) => { s.ChromaticAberration = v; }],
  ['EdgeLightTop',           s => s.EdgeLightTop,                 (s, v) => { s.EdgeLightTop = v; }],
  ['EdgeLightBottom',        s => s.EdgeLightBottom,              (s, v) => { s.EdgeLightBottom = v; }],
  ['BorderVariance',         s => s.BorderVariance,               (s, v) => { s.BorderVariance = v; }],
  ['BorderAlphaVariance',    s => s.BorderAlphaVariance,          (s, v) => { s.BorderAlphaVariance = v; }],
  ['BorderFresnelBrightness',s => s.BorderFresnelBrightness,      (s, v) => { s.BorderFresnelBrightness = v; }],
  ['InnerBlur',              s => s.InnerBlur,                    (s, v) => { s.InnerBlur = v; }],

  // Transform — per-channel
  ['Transform',              s => s.Transform.TranslateX,         (s, v) => { s.Transform.TranslateX = v; }],
  ['Transform',              s => s.Transform.TranslateY,         (s, v) => { s.Transform.TranslateY = v; }],
  ['Transform',              s => s.Transform.ScaleX,             (s, v) => { s.Transform.ScaleX = v; }],
  ['Transform',              s => s.Transform.ScaleY,             (s, v) => { s.Transform.ScaleY = v; }],
  ['Transform',              s => s.Transform.Rotation,           (s, v) => { s.Transform.Rotation = v; }],
  ['Transform',              s => s.Transform.SkewX,              (s, v) => { s.Transform.SkewX = v; }],
  ['Transform',              s => s.Transform.SkewY,              (s, v) => { s.Transform.SkewY = v; }],
  ['Transform',              s => s.Transform.OriginX,            (s, v) => { s.Transform.OriginX = v; }],
  ['Transform',              s => s.Transform.OriginY,            (s, v) => { s.Transform.OriginY = v; }],

  // Border — color + geometry
  ['BorderColor',            s => s.BorderColor.R,                (s, v) => { s.BorderColor.R = v; }],
  ['BorderColor',            s => s.BorderColor.G,                (s, v) => { s.BorderColor.G = v; }],
  ['BorderColor',            s => s.BorderColor.B,                (s, v) => { s.BorderColor.B = v; }],
  ['BorderColor',            s => s.BorderColor.A,                (s, v) => { s.BorderColor.A = v; }],
  ['BorderWidth',            s => s.BorderWidth,                  (s, v) => { s.BorderWidth = v; }],
  ['BorderBlur',             s => s.BorderBlur,                   (s, v) => { s.BorderBlur = v; }],
  ['BorderBackdropBlur',     s => s.BorderBackdropBlur,           (s, v) => { s.BorderBackdropBlur = v; }],
  ['BorderOffset',           s => s.BorderOffset,                 (s, v) => { s.BorderOffset = v; }],
  ['BorderBrightness',       s => s.BorderBrightness,             (s, v) => { s.BorderBrightness = v; }],
  ['BorderSaturation',       s => s.BorderSaturation,             (s, v) => { s.BorderSaturation = v; }],
  ['BorderContrast',         s => s.BorderContrast,               (s, v) => { s.BorderContrast = v; }],

  // Shadow
  ['ShadowColor',            s => s.ShadowColor.R,                (s, v) => { s.ShadowColor.R = v; }],
  ['ShadowColor',            s => s.ShadowColor.G,                (s, v) => { s.ShadowColor.G = v; }],
  ['ShadowColor',            s => s.ShadowColor.B,                (s, v) => { s.ShadowColor.B = v; }],
  ['ShadowColor',            s => s.ShadowColor.A,                (s, v) => { s.ShadowColor.A = v; }],
  ['ShadowBlur',             s => s.ShadowBlur,                   (s, v) => { s.ShadowBlur = v; }],
  ['ShadowOffsetX',          s => s.ShadowOffsetX,                (s, v) => { s.ShadowOffsetX = v; }],
  ['ShadowOffsetY',          s => s.ShadowOffsetY,                (s, v) => { s.ShadowOffsetY = v; }],

  // Appearance
  ['Opacity',                s => s.Opacity,                      (s, v) => { s.Opacity = v; }],

  // PointScale — cascades + animates with the rest
  ['PointScale',             s => s.PointScale,                   (s, v) => { s.PointScale = v; }],
];

const DEFAULT_STIFFNESS = 260;
const DEFAULT_DAMPING = 32;
const DEFAULT_MASS = 1;

/** Copy all non-animated fields from target into render. These snap without
 *  a spring: booleans, enums, and identity-shared nested structures. */
const _copyNonAnimated = (render: JivRenderStyle, target: JivRenderStyle): void => {
  render.Material = target.Material;
  render.ProgressiveBlurDirection = target.ProgressiveBlurDirection;
  render.ProgressiveBlurFeather = target.ProgressiveBlurFeather;
  render.CornerShape = target.CornerShape;
  render.BlendMode = target.BlendMode;
  render.ContainBorder = target.ContainBorder;
  render.InnerShadow = target.InnerShadow;
  render.Layer = target.Layer;
};

export class JivStyleAnimator implements Animatable {
  private _springs: Spring[];

  constructor(private _jiv: Jiv) {
    // Resolve the initial target under the seed ctx (or the Jiv's ctx if
    // it has one already from a prior pass). Springs start settled at the
    // initial values so there's no entry animation.
    const target = ResolveStyle(_jiv.Style, this._ctx());
    const overrides = _jiv.Springs;
    this._springs = BINDINGS.map(([prop, get]) => {
      const cfg = overrides?.[prop];
      return new Spring(
        get(target),
        cfg?.Stiffness ?? DEFAULT_STIFFNESS,
        cfg?.Damping ?? DEFAULT_DAMPING,
        cfg?.Mass ?? DEFAULT_MASS,
      );
    });
  }

  /** Extend the Jiv's layout context with current Presence spring state so
   *  style expressions like `OffsetY: -20 * (1 - Presence)` resolve against
   *  the live spring position each tick. Layout-pass contexts don't carry
   *  these (layout doesn't run per-frame), so builtins fall back to 0
   *  there — which is what we want for sizing-affecting expressions. */
  private _ctx = () => {
    const base = this._jiv.ResolveCtx ?? SEED_CONTEXT;
    const spring = this._jiv.PresenceSpring;
    const p = spring.Value;
    return {
      ...base,
      Presence: p,
      Entering: (spring.Target === 1 && p < 1) ? 1 : 0,
      Exiting:  (spring.Target === 0 && p > 0) ? 1 : 0,
    };
  };

  /** Force all springs to their current targets (zero velocity) and mirror
   *  back onto RenderStyle. Used on first layout so newly-created Jivs
   *  render at the target without a frame of catch-up animation. */
  SnapToTargets = (): void => {
    const target = ResolveStyle(this._jiv.EffectiveStyle(), this._ctx());
    _copyNonAnimated(this._jiv.RenderStyle, target);
    for (let i = 0; i < BINDINGS.length; i++) {
      const [, get, set] = BINDINGS[i];
      const s = this._springs[i];
      s.Target = get(target);
      s.Snap();
      set(this._jiv.RenderStyle, s.Value);
    }
  };

  Tick = (dt: number): boolean => {
    const target = ResolveStyle(this._jiv.EffectiveStyle(), this._ctx());
    const render = this._jiv.RenderStyle;
    _copyNonAnimated(render, target);
    let active = false;
    for (let i = 0; i < BINDINGS.length; i++) {
      const [, get, set] = BINDINGS[i];
      const s = this._springs[i];
      s.Target = get(target);
      if (s.Step(dt)) active = true;
      set(render, s.Value);
    }

    // Material is gated by Thickness > 0 in Style.Resolver._inferMaterial,
    // which reads the TARGET (author) thickness. That flips to 0 the
    // instant a press releases, so _copyNonAnimated snaps render.Material
    // to 'None' on frame 1 — and the glass pipeline stops running.
    // Refraction / Bezel / Specular / ChromaticAberration all disappear
    // before the Thickness spring has a chance to decay, looking like an
    // instant reset even though the spring is still physically animating.
    // Re-infer from MAX(render, target) so the glass shader keeps rendering
    // until the spring settles, and kicks in immediately on press-down.
    // Gate on target.Material, not render.ProgressiveBlurDirection — the
    // latter falls back to 'ToTop' in the resolver even when no pblur is
    // active, so checking == null never matched (the whole override was
    // silently dead code).
    if (target.Material !== 'ProgressiveBlur') {
      const t = Math.max(render.Thickness, target.Thickness);
      render.Material = t > 0.01 ? 'LiquidGlass' : 'None';
    }

    return active;
  };
}
