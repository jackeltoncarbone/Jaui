import type { Color } from '../Core/Types';
import type { Transform } from '../Transform/Transform.Types';

export type CornerShape = 'Round' | 'Squircle' | 'Bevel' | 'Scoop' | 'Notch' | number;

/** Derived at resolve time from which props the author set. Not authorable —
 *  Jiv infers the render pipeline from what you're actually using:
 *    • Thickness > 0                   → 'LiquidGlass' (glass pipeline, refraction)
 *    • ProgressiveBlurDirection != null → 'ProgressiveBlur' (compositing overlay)
 *    • otherwise                       → 'None' (plain panel) */
export type MaterialType = 'None' | 'LiquidGlass' | 'ProgressiveBlur';

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
  Refraction: string;
  BackdropBrightness: string;
  BackdropSaturation: string;
  BackdropContrast: string;

  // Refraction band geometry
  BezelWidth: string;
  BezelScale: string;

  // Lighting
  LightAngle: string;        // degrees
  LightIntensity: string;

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

  // Transform — function-syntax string composing translate/scale/rotate/skew/origin
  Transform: string;

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
  Material: MaterialType;
  ProgressiveBlurDirection: ProgressiveBlurDirection;
  PointScale: number;

  BorderRadius: [number, number, number, number];          // tl, tr, br, bl
  CornerShape: [CornerShape, CornerShape, CornerShape, CornerShape];
  BorderRadiusSmoothness: number;

  Background: Color;
  BlendMode: BlendMode;

  Frost: number;
  BackdropFrostBlur: number;
  Thickness: number;
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

  Opacity: number;

  Layer: number;
}
