import { Spring } from '../Animation/Spring';
import type { Animatable } from '../Animation/Animation.Manager';
import type { Jiv } from './Jiv';
import type { JivStyle } from './Jiv.Types';

/**
 * Springs every animatable field on JivStyle between the declarative target
 * (jiv.EffectiveStyle() — base + active state overrides) and the current
 * display value (jiv.RenderStyle — what the renderer actually reads).
 *
 * Why this exists: state transitions (hover / active / focus) should animate
 * smoothly by DEFAULT. The spec's @spring * shorthand applies to every
 * animatable property, so we treat every numeric field on JivStyle as
 * spring-animatable unless it makes no physical sense to interpolate
 * (enums, bool flags — those SNAP on any change).
 *
 * One spring per numeric channel (colors get R/G/B/A = 4 springs each, etc).
 * Initialized to the base Style so no entry animation. Each tick reads the
 * current EffectiveStyle as targets and steps every spring.
 */

type StyleGetter = (s: JivStyle) => number;
type StyleSetter = (s: JivStyle, v: number) => void;

/** Declarative list of every animatable numeric path on JivStyle. Adding a
 *  new animatable field = add one entry here. Non-numeric fields (Material,
 *  BlendMode, Overflow, Visible, etc.) snap instantly. */
const STYLE_BINDINGS: Array<[StyleGetter, StyleSetter]> = [
  // Shape
  [s => s.Smoothness, (s, v) => { s.Smoothness = v; }],
  [s => s.BorderRadius[0], (s, v) => { s.BorderRadius[0] = v; }],
  [s => s.BorderRadius[1], (s, v) => { s.BorderRadius[1] = v; }],
  [s => s.BorderRadius[2], (s, v) => { s.BorderRadius[2] = v; }],
  [s => s.BorderRadius[3], (s, v) => { s.BorderRadius[3] = v; }],

  // Fill — Background color
  [s => s.Background.R, (s, v) => { s.Background.R = v; }],
  [s => s.Background.G, (s, v) => { s.Background.G = v; }],
  [s => s.Background.B, (s, v) => { s.Background.B = v; }],
  [s => s.Background.A, (s, v) => { s.Background.A = v; }],

  // Physical material
  [s => s.Frost, (s, v) => { s.Frost = v; }],
  [s => s.BackdropFrostBlur, (s, v) => { s.BackdropFrostBlur = v; }],
  [s => s.Thickness, (s, v) => { s.Thickness = v; }],
  [s => s.Fillet, (s, v) => { s.Fillet = v; }],
  [s => s.Refraction, (s, v) => { s.Refraction = v; }],
  [s => s.BackdropBrightness, (s, v) => { s.BackdropBrightness = v; }],
  [s => s.BackdropSaturation, (s, v) => { s.BackdropSaturation = v; }],
  [s => s.BackdropContrast, (s, v) => { s.BackdropContrast = v; }],

  // Refraction band geometry
  [s => s.BezelWidth, (s, v) => { s.BezelWidth = v; }],
  [s => s.BezelScale, (s, v) => { s.BezelScale = v; }],

  // Lighting
  [s => s.LightAngle, (s, v) => { s.LightAngle = v; }],
  [s => s.LightIntensity, (s, v) => { s.LightIntensity = v; }],
  [s => s.SpecularIntensity, (s, v) => { s.SpecularIntensity = v; }],
  [s => s.SpecularSharpness, (s, v) => { s.SpecularSharpness = v; }],
  [s => s.FresnelStrength, (s, v) => { s.FresnelStrength = v; }],
  [s => s.ChromaticAberration, (s, v) => { s.ChromaticAberration = v; }],
  [s => s.EdgeLightTop, (s, v) => { s.EdgeLightTop = v; }],
  [s => s.EdgeLightBottom, (s, v) => { s.EdgeLightBottom = v; }],
  [s => s.BorderVariance, (s, v) => { s.BorderVariance = v; }],
  [s => s.BorderAlphaVariance, (s, v) => { s.BorderAlphaVariance = v; }],
  [s => s.BorderFresnelBrightness, (s, v) => { s.BorderFresnelBrightness = v; }],
  [s => s.InnerBlur, (s, v) => { s.InnerBlur = v; }],

  // Transform
  [s => s.Transform.TranslateX, (s, v) => { s.Transform.TranslateX = v; }],
  [s => s.Transform.TranslateY, (s, v) => { s.Transform.TranslateY = v; }],
  [s => s.Transform.ScaleX, (s, v) => { s.Transform.ScaleX = v; }],
  [s => s.Transform.ScaleY, (s, v) => { s.Transform.ScaleY = v; }],
  [s => s.Transform.Rotation, (s, v) => { s.Transform.Rotation = v; }],
  [s => s.Transform.SkewX, (s, v) => { s.Transform.SkewX = v; }],
  [s => s.Transform.SkewY, (s, v) => { s.Transform.SkewY = v; }],
  [s => s.Transform.OriginX, (s, v) => { s.Transform.OriginX = v; }],
  [s => s.Transform.OriginY, (s, v) => { s.Transform.OriginY = v; }],

  // Border — color + geometry
  [s => s.BorderColor.R, (s, v) => { s.BorderColor.R = v; }],
  [s => s.BorderColor.G, (s, v) => { s.BorderColor.G = v; }],
  [s => s.BorderColor.B, (s, v) => { s.BorderColor.B = v; }],
  [s => s.BorderColor.A, (s, v) => { s.BorderColor.A = v; }],
  [s => s.BorderWidth, (s, v) => { s.BorderWidth = v; }],
  [s => s.BorderBlur, (s, v) => { s.BorderBlur = v; }],
  [s => s.BorderOffset, (s, v) => { s.BorderOffset = v; }],
  [s => s.BorderBrightness, (s, v) => { s.BorderBrightness = v; }],
  [s => s.BorderSaturation, (s, v) => { s.BorderSaturation = v; }],
  [s => s.BorderContrast, (s, v) => { s.BorderContrast = v; }],
  [s => s.BorderFrostLodOffset, (s, v) => { s.BorderFrostLodOffset = v; }],

  // Shadow
  [s => s.ShadowColor.R, (s, v) => { s.ShadowColor.R = v; }],
  [s => s.ShadowColor.G, (s, v) => { s.ShadowColor.G = v; }],
  [s => s.ShadowColor.B, (s, v) => { s.ShadowColor.B = v; }],
  [s => s.ShadowColor.A, (s, v) => { s.ShadowColor.A = v; }],
  [s => s.ShadowBlur, (s, v) => { s.ShadowBlur = v; }],
  [s => s.ShadowOffsetX, (s, v) => { s.ShadowOffsetX = v; }],
  [s => s.ShadowOffsetY, (s, v) => { s.ShadowOffsetY = v; }],

  // Appearance
  [s => s.Opacity, (s, v) => { s.Opacity = v; }],
];

/** Default spring params for all style animations. Per spec, `@spring *`
 *  applies to everything; per-property overrides are a future stylesheet
 *  feature. Near-critical damping, moderate stiffness — snappy without
 *  overshoot on 0→1 alpha swaps (which would look like a flicker). */
const DEFAULT_STIFFNESS = 260;
const DEFAULT_DAMPING = 32;
const DEFAULT_MASS = 1;

export class JivStyleAnimator implements Animatable {
  private _springs: Spring[];

  constructor(private _jiv: Jiv) {
    // Init each spring at the CURRENT style value so there's no entry
    // animation (no color swoop from 0 on first mount).
    const base = _jiv.Style;
    this._springs = STYLE_BINDINGS.map(([get]) =>
      new Spring(get(base), DEFAULT_STIFFNESS, DEFAULT_DAMPING, DEFAULT_MASS));
  }

  /** Force all springs to their current targets (zero velocity) and mirror
   *  back onto RenderStyle. Used on first layout so newly-created Jivs
   *  render at EffectiveStyle without a frame of catch-up animation. */
  SnapToTargets = (): void => {
    const target = this._jiv.EffectiveStyle();
    for (let i = 0; i < STYLE_BINDINGS.length; i++) {
      const [get, set] = STYLE_BINDINGS[i];
      const s = this._springs[i];
      s.Target = get(target);
      s.Snap();
      set(this._jiv.RenderStyle, s.Value);
    }
  };

  Tick = (dt: number): boolean => {
    const target = this._jiv.EffectiveStyle();
    const render = this._jiv.RenderStyle;
    let active = false;
    for (let i = 0; i < STYLE_BINDINGS.length; i++) {
      const [get, set] = STYLE_BINDINGS[i];
      const s = this._springs[i];
      s.Target = get(target);
      if (s.Step(dt)) active = true;
      set(render, s.Value);
    }
    return active;
  };
}
