import type { Color } from '../Core/Types';
import type { Transform } from '../Transform/Transform.Types';
import type { FitMode } from '../Element/Element';

export type CornerShape = 'Round' | 'Squircle' | 'Bevel' | 'Scoop' | 'Notch' | number;

/**
 * Resolved Background value — a tagged union covering every fill the
 * renderer can paint into a Jiv's silhouette. Background is always
 * present; the renderer branches on `Kind` to decide whether to paint
 * a flat tint, sample a texture, or evaluate a gradient.
 *
 * Every variant carries a `Color` channel: the solid tint for Color,
 * the load-time placeholder for Image, the "fallback" if the gradient
 * shader can't run (and during kind-change cross-fades). The style
 * animator springs the Color channel uniformly — interpolation
 * between *kinds* is handled by a separate Background interpolator
 * because a Color↔Image swap can't be a per-channel lerp.
 *
 * Gradient stops are normalized positions in [0, 1] with a parsed
 * Color. The CPU passes up to `MAX_GRADIENT_STOPS` per draw to the
 * shader as uniform arrays — beyond that, stops are evenly resampled
 * down to the cap.
 */
export interface GradientStop {
  Position: number;
  Color: Color;
}

export type BackgroundValue =
  | { Kind: 'Color',          Color: Color }
  | { Kind: 'Image',          Color: Color, Url: string, Fit: FitMode }
  | { Kind: 'LinearGradient', Color: Color, AngleRad: number, Stops: GradientStop[] }
  | { Kind: 'RadialGradient', Color: Color, CenterX: number, CenterY: number, Radius: number, Stops: GradientStop[] };

/** Maximum gradient stops shipped to the shader per draw. Stops beyond
 *  this are evenly resampled in the parser before being uploaded. */
export const MAX_GRADIENT_STOPS = 8;

/** A Jiv that emits light into the one shared scene. Open-ended; adding a kind is
 *  one switch arm in the resolver + renderer. */
export type LightKind = 'Directional' | 'Ambient' | 'Point' | 'Spot' | 'Area';

/** Resolved scene light, produced from the Light* JivStyle props when LightType is
 *  set. Position is filled from the node's solved layout + Space at collect time
 *  (not here). Color is linear rgb in 0..1; Intensity is a scalar multiplier. */
export interface ResolvedLight {
  Kind: LightKind;
  Color: Color;
  Intensity: number;
  /** Aim (unit-ish vector) for Directional / Spot. */
  Direction: [number, number, number];
  /** Falloff distance in device px for Point / Spot / Area. 0 = no limit. */
  Range: number;
  /** Spot cone half-angle in radians. */
  ConeAngle: number;
  /** Spot edge softness 0..1. */
  Penumbra: number;
  CastShadow: boolean;
}

/** Direction the blur ramps TO — i.e. the edge that's fully blurred. The
 *  opposite edge is fully clear (unblurred scene shows through). */
export type ProgressiveBlurDirection = 'ToTop' | 'ToBottom' | 'ToLeft' | 'ToRight';

export type BlendMode =
  | 'Normal' | 'Multiply' | 'Screen' | 'Overlay'
  | 'Darken' | 'Lighten' | 'ColorDodge' | 'ColorBurn'
  | 'SoftLight' | 'HardLight' | 'Difference' | 'Exclusion';

/**
 * Authorable style — every numeric / dimensional / color / transform field is
 * a CSS-style string (or a bare number as a convenience fast-path for simple
 * scalars). The StyleResolver service parses and resolves this into the
 * fully-numeric `JivRenderStyle` that the renderer consumes.
 *
 * String grammar:
 *   Scalars: `"0.5"`, `"1pt"`, `"50%"`, `"1pt + 4"`, `"(100vh - 64) / 3"`
 *   Tuples (Padding, BorderRadius, CornerShape): `"0"` (all), `"1 2"` (v h),
 *          `"1 2 3 4"` (T R B L)
 *   Colors (Background, BorderColor, ShadowColor): `"#rgb"`, `"#rrggbbaa"`,
 *          `"rgb(...)"`, `"rgba(...)"`, `"hsl(...)"`, `"hsla(...)"`,
 *          `"transparent"`
 *   Transform: `"translate(x, y) scale(s) rotate(deg)"` — function syntax,
 *              any order, any subset
 */
export interface JivStyle {
  /** Set this to turn the Jiv into a ProgressiveBlur feather — names the
   *  edge that ramps to fully blurred. `null` means "not a feather". */
  ProgressiveBlurDirection: ProgressiveBlurDirection | null;

  /** Length of the feather ramp (CSS px / pt). Measured from the clear edge
   *  toward the blurred edge — everything past this distance is fully
   *  blurred + fully tinted. `"0"` means "ramp spans the entire element"
   *  (the default, matches pre-feature behaviour). */
  ProgressiveBlurFeather: string;

  /** Exponent applied to the smoothstep'd blur ramp — `ramp = pow(smoothstep(t), Easing)`.
   *  Default `"1"` = unchanged smoothstep. Lower values (e.g. `"0.4"`) bias toward
   *  MORE blur: ramp climbs fast at the clear end so most of the feather strip
   *  reads as heavy blur with a tight falloff to clear. Higher values (e.g. `"2"`)
   *  bias toward MORE clear: ramp stays low through most of the strip and the
   *  blur only kicks in near the blurred edge. Affects blur LOD, backdrop
   *  grading, and background-tint mix together. */
  ProgressiveBlurEasing: string;

  /** Cascading base unit. `1pt` anywhere in this Jiv's subtree resolves to
   *  `N × PointScale`. When resolving PointScale itself, `pt` refers to
   *  PARENT's PointScale. Default `"1pt"` — inherit parent. */
  PointScale: string;

  // Shape
  /** Space-separated, CSS shorthand: "0" (all), "1 2" (tl/br, tr/bl),
   *  "1 2 3 4" (tl, tr, br, bl). Plain number shortcut: all corners same. */
  BorderRadius: string;
  /** Space-separated tokens; same 1/2/4 shorthand as BorderRadius. */
  CornerShape: string;
  /** Corner curvature smoothness — superellipse exponent interpolating
   *  between round (0) and squircle (1). */
  BorderRadiusSmoothness: string;
  // Fill
  Background: string;
  BlendMode: BlendMode;

  // Physical material — the Jiv is a slab with measurable properties
  Frost: string;
  BackdropFrostBlur: string;
  Thickness: string;
  Fillet: string;
  Elevation: string;
  Refraction: string;
  BackdropBrightness: string;
  BackdropSaturation: string;
  BackdropContrast: string;

  // Refraction band geometry
  BezelWidth: string;
  BezelScale: string;

  // Lighting — how this surface RECEIVES light (art-direction overrides on the
  // shared scene lighting). Distinct from the Light* SOURCE props below.
  LightAngle: string;        // degrees
  LightIntensity: string;

  // ── Light SOURCE (a Jiv as a scene light) ──────────────────────────────────
  // A Jiv with LightType set EMITS light into the one shared scene (lighting all
  // surfaces + meshes) instead of (or in addition to) painting. Empty LightType
  // (default) = not a light. Position/aim come from the normal layout + Space.
  // LightType is open-ended: Directional | Ambient | Point | Spot | Area.
  LightType: string;
  LightColor: string;        // emitted color (rgb)
  LightIntensity_: string;   // emitted intensity (scalar). (Trailing _ avoids
                             // colliding with the receive-side LightIntensity.)
  LightDirection: string;    // 'x y z' aim — Directional / Spot
  LightRange: string;        // falloff distance (length) — Point / Spot / Area
  LightConeAngle: string;    // degrees — Spot cone half-angle
  LightPenumbra: string;     // 0..1 — Spot edge softness
  LightCastShadow: boolean;  // opt-in shadow casting (cost)

  // Specular catchlight
  SpecularIntensity: string;
  SpecularSharpness: string;

  // Fresnel + chromatic
  FresnelStrength: string;
  ChromaticAberration: string;
  EdgeLightTop: string;
  EdgeLightBottom: string;

  // Shape-driven variables
  BorderVariance: string;
  BorderAlphaVariance: string;
  BorderFresnelBrightness: string;
  InnerBlur: string;

  // Transform — function-syntax string composing translate/scale/rotate/skew/origin.
  // Internal/legacy. Author-facing visual transform lives on the
  // dedicated Visual* props below — independent, animatable per axis,
  // no compound parsing.
  Transform: string;

  // Visual transform — pure render-time, applied per-element only (no
  // descendant cascade), no layout/hit-test impact. Shorthand syntax:
  // single value (`0.92`) is uniform; two values (`0.92 1.06`) are X Y.
  // Pure visual feedback — for press shrink, hover lift, etc.
  // Cascading layout-affecting scale belongs on PointScale instead.
  /** Scale around `VisualOrigin`. Default `'1'`. */
  VisualScale: string;
  /** Translation in CSS px (or any Length unit). Applied AFTER scale,
   *  in this Jiv's local space. A THIRD value is Z (depth):
   *  `'0 0 40'` translates 40 in Z. One value = uniform XY, Z=0;
   *  two values (`x y`) = X Y, Z=0; three values (`x y z`) = X Y Z.
   *  Default `'0'`. */
  VisualTranslate: string;
  /** Coordinate space. `'Screen'` (default) = element sits on the
   *  calibrated near-plane, world units = device px (2D behavior).
   *  `'World'` = positioned in the 3D world, subject to
   *  perspective/fog/lighting. Animatable between the two. */
  Space: 'Screen' | 'World';
  /** Origin for VisualScale, in [0, 1] of the Jiv's box.
   *  `0.5` = center. Default `'0.5'`. */
  VisualOrigin: string;

  // Border
  BorderColor: string;
  BorderWidth: string;
  /** Edge feather half-width in CSS px. Controls how soft the border
   *  stroke's silhouette edge is — larger = softer/glowier outline. At
   *  `0.5` the edge is antialiased over ~1 physical px (the old hardcoded
   *  default). At `0` the edge is a hard step (aliased). */
  BorderBlur: string;
  /** Extra blur applied to the backdrop sample in the border-zone rim
   *  (mipmap LOD octave offset; positive = wider blur than the panel
   *  face, negative = sharper). 0 = border uses the same blur as the
   *  panel. Not edge antialiasing — see `BorderBlur` for that. */
  BorderBackdropBlur: string;
  BorderOffset: string;
  ContainBorder: boolean;

  // Border-zone backdrop filter
  BorderBrightness: string;
  BorderSaturation: string;
  BorderContrast: string;

  // Shadow
  ShadowColor: string;
  ShadowBlur: string;
  ShadowOffsetX: string;
  ShadowOffsetY: string;
  InnerShadow: boolean;

  // Appearance
  /** Foreground brightness — multiplies the element's FINAL composited rgb
   *  (fill, image, text, border — the whole element), unlike BackdropBrightness
   *  which only filters the glass backdrop behind it. Default `'1'` (no-op).
   *  Animatable via `@Transition Brightness`. */
  Brightness: string;
  Opacity: string;

  /** Sibling stacking order. Higher = paints on top. Default `0`.
   *  Ties break by tree order (later sibling wins), just like the no-Layer
   *  case. Layer is *sibling-local* — a child's Layer does not escape its
   *  parent, same as CSS z-index within a stacking context. */
  Layer: string;
}

/**
 * Fully resolved version of JivStyle — every authored string is parsed and
 * every Length resolved to pixels. This is what the renderer / InstanceBuffer
 * reads and what the style animator writes each tick.
 */
export interface JivRenderStyle {
  /** A Jiv is ONE physical surface — these are NOT a material taxonomy. They are
   *  render-path selectors derived purely from physical attributes (see
   *  Style.Resolver `_samplesBackdrop`), used internally to pick how the backdrop
   *  is sampled. Never author-visible, never gate visibility. */
  SamplesBackdrop: boolean;
  HasProgressiveBlur: boolean;
  /** Unified physical depth in device px (Thickness + Elevation summed). 0 = an
   *  impossibly thin sheet (the shape, zero depth); continuous up from there. */
  Depth: number;
  /** Non-null when this Jiv is a scene light (LightType set). The worker collects
   *  these into the shared light set; lights everything (surfaces + meshes). */
  Light: ResolvedLight | null;
  ProgressiveBlurDirection: ProgressiveBlurDirection;
  /** Feather ramp length in device pixels. 0 = ramp spans whole element. */
  ProgressiveBlurFeather: number;
  /** Exponent applied to the smoothstep'd ramp. 1 = unchanged smoothstep
   *  (default). <1 = more blur, sharper falloff to clear. >1 = more clear,
   *  blur weighted toward the blurred edge. */
  ProgressiveBlurEasing: number;
  PointScale: number;

  BorderRadius: [number, number, number, number];          // tl, tr, br, bl
  CornerShape: [CornerShape, CornerShape, CornerShape, CornerShape];
  BorderRadiusSmoothness: number;

  Background: BackgroundValue;
  BlendMode: BlendMode;

  Frost: number;
  BackdropFrostBlur: number;
  Fillet: number;
  Refraction: number;
  BackdropBrightness: number;
  BackdropSaturation: number;
  BackdropContrast: number;

  BezelWidth: number;
  BezelScale: number;

  LightAngle: number;
  LightIntensity: number;

  SpecularIntensity: number;
  SpecularSharpness: number;

  FresnelStrength: number;
  ChromaticAberration: number;
  EdgeLightTop: number;
  EdgeLightBottom: number;
  BorderVariance: number;
  BorderAlphaVariance: number;
  BorderFresnelBrightness: number;
  InnerBlur: number;

  Transform: Transform;

  // Visual transform — resolved per-axis. Applied at render time only.
  VisualScaleX: number;
  VisualScaleY: number;
  VisualTranslateX: number;
  VisualTranslateY: number;
  VisualTranslateZ: number;
  VisualOriginX: number;
  VisualOriginY: number;
  Space: 'Screen' | 'World';

  BorderColor: Color;
  BorderWidth: number;
  BorderBlur: number;
  BorderBackdropBlur: number;
  BorderOffset: number;
  ContainBorder: boolean;

  BorderBrightness: number;
  BorderSaturation: number;
  BorderContrast: number;

  ShadowColor: Color;
  ShadowBlur: number;
  ShadowOffsetX: number;
  ShadowOffsetY: number;
  InnerShadow: boolean;

  /** Foreground brightness multiplier on the final rgb. Default 1. */
  Brightness: number;
  Opacity: number;

  Layer: number;
}
