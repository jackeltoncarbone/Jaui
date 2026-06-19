import { Spring } from '../Animation/Spring';
import type { Animatable } from '../Animation/Animation.Manager';
import { JivAnimationDriver } from '../Animation/Animation.Driver';
import type {
  SpringConfig,
  AnimationApplication,
  AnimationDefinition,
} from '../Animation/Animation.Types';
import type { Jiv } from './Jiv';
import type { JivStyle, JivRenderStyle } from './Jiv.Types';
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
  ['Background',             s => s.Background.Color.R,           (s, v) => { s.Background.Color.R = v; }],
  ['Background',             s => s.Background.Color.G,           (s, v) => { s.Background.Color.G = v; }],
  ['Background',             s => s.Background.Color.B,           (s, v) => { s.Background.Color.B = v; }],
  ['Background',             s => s.Background.Color.A,           (s, v) => { s.Background.Color.A = v; }],

  // Physical material
  ['Frost',                  s => s.Frost,                        (s, v) => { s.Frost = v; }],
  ['Thickness',              s => s.Thickness,                    (s, v) => { s.Thickness = v; }],
  ['Fillet',                 s => s.Fillet,                       (s, v) => { s.Fillet = v; }],
  ['Refraction',             s => s.Refraction,                   (s, v) => { s.Refraction = v; }],

  // Backdrop filter — every channel springs under the `BackdropFilter`
  // bucket, so `@Transition BackdropFilter { ... }` tunes them together.
  ['BackdropFilter',         s => s.BackdropFrostBlur,            (s, v) => { s.BackdropFrostBlur = v; }],
  ['BackdropFilter',         s => s.BackdropBrightness,           (s, v) => { s.BackdropBrightness = v; }],
  ['BackdropFilter',         s => s.BackdropSaturation,           (s, v) => { s.BackdropSaturation = v; }],
  ['BackdropFilter',         s => s.BackdropContrast,             (s, v) => { s.BackdropContrast = v; }],

  // Foreground filter grade (multiplies final rgb) — bucket `Filter`, so
  // `@Transition Filter { ... }` springs brightness/saturation/contrast.
  ['Filter',                 s => s.Brightness,                   (s, v) => { s.Brightness = v; }],
  ['Filter',                 s => s.Saturation,                   (s, v) => { s.Saturation = v; }],
  ['Filter',                 s => s.Contrast,                     (s, v) => { s.Contrast = v; }],

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

  // Transform — per-channel (legacy compound; superseded by Visual*).
  ['Transform',              s => s.Transform.TranslateX,         (s, v) => { s.Transform.TranslateX = v; }],
  ['Transform',              s => s.Transform.TranslateY,         (s, v) => { s.Transform.TranslateY = v; }],
  ['Transform',              s => s.Transform.TranslateZ,         (s, v) => { s.Transform.TranslateZ = v; }],
  ['Transform',              s => s.Transform.ScaleX,             (s, v) => { s.Transform.ScaleX = v; }],
  ['Transform',              s => s.Transform.ScaleY,             (s, v) => { s.Transform.ScaleY = v; }],
  ['Transform',              s => s.Transform.Rotation,           (s, v) => { s.Transform.Rotation = v; }],
  ['Transform',              s => s.Transform.RotateX,            (s, v) => { s.Transform.RotateX = v; }],
  ['Transform',              s => s.Transform.RotateY,            (s, v) => { s.Transform.RotateY = v; }],
  ['Transform',              s => s.Transform.SkewX,              (s, v) => { s.Transform.SkewX = v; }],
  ['Transform',              s => s.Transform.SkewY,              (s, v) => { s.Transform.SkewY = v; }],
  ['Transform',              s => s.Transform.OriginX,            (s, v) => { s.Transform.OriginX = v; }],
  ['Transform',              s => s.Transform.OriginY,            (s, v) => { s.Transform.OriginY = v; }],

  // Perspective context — viewing distance + vanishing origin, animatable so a
  // drum can spring its depth. Bucket `Perspective` / `PerspectiveOrigin`.
  ['Perspective',            s => s.Perspective,                  (s, v) => { s.Perspective = v; }],
  ['PerspectiveOrigin',      s => s.PerspectiveOriginX,           (s, v) => { s.PerspectiveOriginX = v; }],
  ['PerspectiveOrigin',      s => s.PerspectiveOriginY,           (s, v) => { s.PerspectiveOriginY = v; }],

  // Visual* — render-time scale/translate around an origin. Each axis
  // springs independently. Author groups via the JSS shorthand:
  // `@Transition VisualScale { Duration: 160ms }` springs both X and Y
  // with the same config; finer-grained tuning per axis isn't supported
  // (all four channels share the 'Visual*' bucket).
  ['VisualScale',            s => s.VisualScaleX,                 (s, v) => { s.VisualScaleX = v; }],
  ['VisualScale',            s => s.VisualScaleY,                 (s, v) => { s.VisualScaleY = v; }],
  ['VisualTranslate',        s => s.VisualTranslateX,             (s, v) => { s.VisualTranslateX = v; }],
  ['VisualTranslate',        s => s.VisualTranslateY,             (s, v) => { s.VisualTranslateY = v; }],
  ['VisualOrigin',           s => s.VisualOriginX,                (s, v) => { s.VisualOriginX = v; }],
  ['VisualOrigin',           s => s.VisualOriginY,                (s, v) => { s.VisualOriginY = v; }],

  // Border — color + geometry
  ['BorderColor',            s => s.BorderColor.R,                (s, v) => { s.BorderColor.R = v; }],
  ['BorderColor',            s => s.BorderColor.G,                (s, v) => { s.BorderColor.G = v; }],
  ['BorderColor',            s => s.BorderColor.B,                (s, v) => { s.BorderColor.B = v; }],
  ['BorderColor',            s => s.BorderColor.A,                (s, v) => { s.BorderColor.A = v; }],
  ['BorderWidth',            s => s.BorderWidth,                  (s, v) => { s.BorderWidth = v; }],
  ['BorderBlur',             s => s.BorderBlur,                   (s, v) => { s.BorderBlur = v; }],
  ['BorderOffset',           s => s.BorderOffset,                 (s, v) => { s.BorderOffset = v; }],
  // Border-zone backdrop filter — bucket `BorderFilter`.
  ['BorderFilter',           s => s.BorderBackdropBlur,           (s, v) => { s.BorderBackdropBlur = v; }],
  ['BorderFilter',           s => s.BorderBrightness,             (s, v) => { s.BorderBrightness = v; }],
  ['BorderFilter',           s => s.BorderSaturation,             (s, v) => { s.BorderSaturation = v; }],
  ['BorderFilter',           s => s.BorderContrast,               (s, v) => { s.BorderContrast = v; }],

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
 *  a spring: booleans, enums, and identity-shared nested structures.
 *
 *  Background is special: its Color channel (RGBA) is sprung per-binding, but
 *  the Kind / Url / Fit / gradient stops snap. We assign the whole target
 *  Background reference into render so the structural fields update — the
 *  springs in BINDINGS overwrite the Color channels in-place immediately
 *  after this call, so the final render.Background carries (target Kind/
 *  Url/Fit/Stops) + (spring-interpolated Color). The assignment is a
 *  reference share, but ResolveStyle returns a freshly-cloned BackgroundValue
 *  per call (ParseBackground._clone allocates a new Color object), so the
 *  cache stays clean and previous render.Background is GC'd.
 */
const _copyNonAnimated = (render: JivRenderStyle, target: JivRenderStyle): void => {
  render.Material = target.Material;
  render.ProgressiveBlurDirection = target.ProgressiveBlurDirection;
  render.ProgressiveBlurFeather = target.ProgressiveBlurFeather;
  render.ProgressiveBlurEasing = target.ProgressiveBlurEasing;
  render.ProgressiveBlurStops = target.ProgressiveBlurStops;
  render.CornerShape = target.CornerShape;
  render.BlendMode = target.BlendMode;
  render.ContainBorder = target.ContainBorder;
  render.InnerShadow = target.InnerShadow;
  render.Isolate = target.Isolate;
  render.Layer = target.Layer;
  render.BorderLayer = target.BorderLayer;
  render.Background = target.Background;
};

export class JivStyleAnimator implements Animatable {
  private _springs: Spring[];
  /** Per-binding spring config snapshot captured at construction or after
   *  a RetuneSprings() call. Tick() restores from here whenever no active
   *  @Animation is imposing an Ease override on the property. Same shape
   *  as Spring's mutable fields so a Linear / Spring(...) Ease can stomp
   *  in-place and Tick can restore on the next frame. */
  private _baseConfigs: Array<{ Stiffness: number; Damping: number; Mass: number }>;
  private _animDriver = new JivAnimationDriver();

  constructor(private _jiv: Jiv) {
    // Resolve the initial target under the seed ctx (or the Jiv's ctx if
    // it has one already from a prior pass). Springs start settled at the
    // initial values so there's no entry animation.
    const target = ResolveStyle(_jiv.Style, this._ctx());
    const overrides = _jiv.Springs;
    this._baseConfigs = [];
    this._springs = BINDINGS.map(([prop, get]) => {
      const cfg = _resolveSpringConfig(overrides, prop);
      this._baseConfigs.push(cfg);
      return new Spring(get(target), cfg.Stiffness, cfg.Damping, cfg.Mass);
    });
    // Wire any @Animation declared on the Jiv into the driver. The Jiv
    // carries both the applications and the stylesheet-wide animation
    // table (named applications resolve against it).
    if (_jiv.Animations && _jiv.Animations.length > 0) {
      this._animDriver.Apply(_jiv.Animations, _jiv.AnimationTable ?? {});
    }
    // Back-ref so the worker registry can reach this animator on re-apply
    // without going through Canvas. Set late so the Jiv carries its own
    // StyleAnimator reference for class-swap path (`_applyOpts`).
    _jiv.StyleAnimator = this;
  }

  /** Re-tune the per-channel springs from a new `Springs` map (e.g. after
   *  the Jiv's class list changed and the registry re-emitted the resolved
   *  spring overrides). Updates `_baseConfigs` AND the live spring values
   *  so a stale @Animation Ease override is not preserved across the swap.
   *  Spec: per-class @Spring/@Transition wins over Animation default. */
  RetuneSprings = (overrides: Record<string, Partial<SpringConfig>> | null): void => {
    for (let i = 0; i < BINDINGS.length; i++) {
      const prop = BINDINGS[i][0];
      const cfg = _resolveSpringConfig(overrides, prop);
      this._baseConfigs[i] = cfg;
      const s = this._springs[i];
      s.Stiffness = cfg.Stiffness;
      s.Damping = cfg.Damping;
      s.Mass = cfg.Mass;
    }
  };

  /** Re-apply the animation set for this Jiv. Called by the worker
   *  registry when a class swap brings in new `@Animation` declarations
   *  (or removes existing ones). Phase resets to 0 for every animation so
   *  newly-applied loops start from the beginning rather than picking up
   *  a stale offset. */
  ReapplyAnimations = (
    apps: AnimationApplication[] | null,
    table: Record<string, AnimationDefinition> | null,
  ): void => {
    this._animDriver.Apply(apps ?? [], table ?? {});
  };

  /** True iff this animator currently has active @Animation declarations.
   *  Used by the registry to decide whether a kick is needed after a
   *  re-apply (the Animation.Manager only ticks when something requests
   *  it; turning animations on at runtime needs a manual nudge). */
  get HasAnimations(): boolean { return this._animDriver.HasAnimations; }

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
      s.Set(get(target));   // Set (not raw Target write) — refuses non-finite values
      s.Snap();
      set(this._jiv.RenderStyle, s.Value);
    }
  };

  Tick = (dt: number): boolean => {
    // Advance any @Animation drivers first so the patched style flows
    // through ResolveStyle alongside the static base. The driver's patch
    // is a Record<string, string> of source-level property values that
    // shadow the matching keys on EffectiveStyle; springs then chase the
    // moving target as usual.
    let driverActive = false;
    let patched = this._jiv.EffectiveStyle();
    const hasAnims = this._animDriver.HasAnimations;
    if (hasAnims) {
      driverActive = this._animDriver.Tick(dt);
      const patch = this._animDriver.Patch();
      patched = _applyStylePatch(patched, patch);
    }
    const target = ResolveStyle(patched, this._ctx());
    const render = this._jiv.RenderStyle;
    _copyNonAnimated(render, target);
    let springActive = false;
    for (let i = 0; i < BINDINGS.length; i++) {
      const [prop, get, set] = BINDINGS[i];
      const s = this._springs[i];
      // Ease override: an active @Animation driving this property can
      // dictate its own interpolation style — Linear snaps each tick
      // (true metronome), a Spring(...) config retunes this channel for
      // the animation's lifetime, and null falls back to the class's
      // per-property @Spring / @Transition tuning captured in _baseConfigs.
      const ease = hasAnims ? this._animDriver.EaseFor(prop) : null;
      s.Set(get(target));   // Set (not raw Target write) — refuses non-finite values
      if (ease === 'Linear') {
        s.Snap();
      } else {
        const base = this._baseConfigs[i];
        if (ease) {
          s.Stiffness = ease.Stiffness;
          s.Damping = ease.Damping;
          s.Mass = ease.Mass;
        } else if (s.Stiffness !== base.Stiffness || s.Damping !== base.Damping || s.Mass !== base.Mass) {
          // Restore the class-declared tuning once the animation imposing
          // a Spring(...) Ease clears (or moves Done — EaseFor returns
          // null for Done). The equality guard avoids touching the spring
          // when nothing changed, the common case.
          s.Stiffness = base.Stiffness;
          s.Damping = base.Damping;
          s.Mass = base.Mass;
        }
        if (s.Step(dt)) springActive = true;
      }
      set(render, s.Value);
    }

    // Keep glass pipeline running while the Thickness spring decays past
    // author target=0 (otherwise refraction/bezel/specular snap off).
    if (target.Material !== 'ProgressiveBlur') {
      const t = Math.max(render.Thickness, target.Thickness);
      render.Material = t > 0.01 ? 'LiquidGlass' : 'None';
    }

    return springActive || driverActive;
  };
}

/** Resolve a per-property spring config against the overrides map. Falls
 *  back to `@Spring *` (universal default) before the global defaults so
 *  authors can write one universal block instead of declaring every
 *  property explicitly. Spec: every animatable property gets the same
 *  config unless a per-property `@Spring`/`@Transition` overrides it. */
const _resolveSpringConfig = (
  overrides: Record<string, Partial<SpringConfig>> | null | undefined,
  prop: string,
): { Stiffness: number; Damping: number; Mass: number } => {
  const own = overrides?.[prop];
  const universal = overrides?.['*'];
  return {
    Stiffness: own?.Stiffness ?? universal?.Stiffness ?? DEFAULT_STIFFNESS,
    Damping: own?.Damping ?? universal?.Damping ?? DEFAULT_DAMPING,
    Mass: own?.Mass ?? universal?.Mass ?? DEFAULT_MASS,
  };
};

/** Layer a `Record<string, string>` patch from an active @Animation on
 *  top of a JivStyle. The patch's keys are source-level property names;
 *  we shallow-merge into a new style object so the driver doesn't mutate
 *  the Jiv's authored Style. Properties that don't live in the Style
 *  slot (Layout / TextStyle / ChildLayout) are silently dropped at this
 *  layer; the v1 driver targets Style-slot animations only. */
const _applyStylePatch = (base: JivStyle, patch: Record<string, string>): JivStyle => {
  let merged: JivStyle | null = null;
  for (const k of Object.keys(patch)) {
    // Only fields that exist in JivStyle are merged. Unknown keys are
    // ignored rather than throwing so future cross-slot animation
    // support can land additively.
    if (!(k in base)) continue;
    if (merged === null) merged = { ...base };
    (merged as unknown as Record<string, unknown>)[k] = patch[k];
  }
  return merged ?? base;
};
