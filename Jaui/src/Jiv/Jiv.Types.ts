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

/** A progressive-blur spectrum stop. At `Position` (0..1 along the element's
 *  ramp axis — 0 = top for vertical, left for horizontal) the blur + tint reach
 *  `Value` (0 = clear/sharp, 1 = max blur). `Easing` is the exponent on the
 *  segment FROM this stop to the next (1 = linear, <1 = fast-in, >1 = slow-in).
 *  Lets the blur follow the same multi-stop spectrum as a color gradient
 *  instead of a single linear feather. */
export interface BlurStop {
  Position: number;
  Value: number;
  Easing: number;
}

/** Max progressive-blur spectrum stops shipped to the shader per draw. */
export const MAX_BLUR_STOPS = 12;

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

  /** Optional gradient-driven blur spectrum, authored with the same readable
   *  syntax as `Background` — `LinearGradient(angle, <stop>, …)` — except each
   *  stop carries a scalar BLUR amount instead of a color:
   *    `LinearGradient(180deg, 1 0%, 0 28% ease 1.6, 1 56%, 0 80%, 1 100%)`
   *  Each stop is `<amount 0..1> <position> [ease <e>]` (0 = clear, 1 = max
   *  blur; position accepts 0..1 or `%`). When set it overrides the single
   *  linear feather and drives blur + tint + grading together, so blur can
   *  cycle (frosted → clear reality → frosted) in lockstep with a color
   *  gradient. The angle picks the axis; it also implies the material, so
   *  `ProgressiveBlurDirection` need not be set. `null` = use the linear feather. */
  ProgressiveBlur: string | null;

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

  // ── Filters (CSS-shaped, ordered function lists) ──────────────────
  // One property per zone; each is a space-separated list of PascalCase
  // CSS-filter functions: Brightness(x) Saturate(x) Contrast(x) Blur(len).
  // `None` / empty = identity. Cross-state and cross-extends MERGE BY
  // FUNCTION (last occurrence of a function wins), so a `:Hover` can bump
  // one function without restating the rest.
  /** Foreground filter — grades the element's composited pixels (fill +
   *  image + text + border) AND cascades to descendants as a group (CSS
   *  `filter`). Stop the cascade into a subtree with `Isolate: true`.
   *  Animate the whole filter via `@Transition Filter`. */
  Filter: string;
  /** Backdrop filter — frost + grade on the glass/backdrop behind this box
   *  (CSS `backdrop-filter`). Per-box; never inherited. `Blur(len)` is the
   *  frost radius. */
  BackdropFilter: string;
  /** Border-zone backdrop filter — frost LOD offset + grade applied in the
   *  rim region only. Per-box. `Blur(len)` is the LOD octave offset vs the
   *  panel face (negative = sharper rim, positive = softer). */
  BorderFilter: string;
  /** Cascade barrier for the foreground `Filter`. `true` stops an ancestor's
   *  Filter grade from folding into this element + its subtree (CSS
   *  `isolation: isolate`). Default `false`. */
  Isolate: string;

  // Physical material — the Jiv is a slab with measurable properties
  Frost: string;
  Thickness: string;
  Fillet: string;
  Refraction: string;

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
   *  in this Jiv's local space. Default `'0'`. */
  VisualTranslate: string;
  /** Origin for VisualScale, in [0, 1] of the Jiv's box.
   *  `0.5` = center. Default `'0.5'`. */
  VisualOrigin: string;

  // 3D perspective — CSS `perspective` model. Set on a PARENT to establish a
  // viewing context; DESCENDANTS' Transform.RotateX/RotateY/TranslateZ project
  // through it toward the shared PerspectiveOrigin (so a fanned drum converges
  // on one vanishing point). Every Jiv is a flat quad, so a tilted quad under
  // perspective is a 2D homography — see Transform/Mat3x3.ts.
  /** Viewing distance in px established for descendants. `'0'`/none = no
   *  perspective (descendant 3D transforms project orthographically). */
  Perspective: string;
  /** Vanishing point for this node's Perspective, in [0,1] of its box.
   *  `'0.5'` = center. Shorthand: single value = both axes; `'x y'` = per-axis. */
  PerspectiveOrigin: string;

  // Border
  BorderColor: string;
  BorderWidth: string;
  /** Edge feather half-width in CSS px. Controls how soft the border
   *  stroke's silhouette edge is — larger = softer/glowier outline. At
   *  `0.5` the edge is antialiased over ~1 physical px (the old hardcoded
   *  default). At `0` the edge is a hard step (aliased). The border-zone
   *  backdrop blur + grade live on `BorderFilter` instead. */
  BorderBlur: string;
  BorderOffset: string;
  ContainBorder: boolean;

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
  /** Feather ramp length in device pixels. 0 = ramp spans whole element. */
  ProgressiveBlurFeather: number;
  /** Exponent applied to the smoothstep'd ramp. 1 = unchanged smoothstep
   *  (default). <1 = more blur, sharper falloff to clear. >1 = more clear,
   *  blur weighted toward the blurred edge. */
  ProgressiveBlurEasing: number;
  /** Parsed gradient-driven blur spectrum (overrides the linear feather when
   *  non-null). Stops are sorted ascending by Position, normalized to [0,1]. */
  ProgressiveBlurStops: BlurStop[] | null;
  PointScale: number;

  BorderRadius: [number, number, number, number];          // tl, tr, br, bl
  CornerShape: [CornerShape, CornerShape, CornerShape, CornerShape];
  BorderRadiusSmoothness: number;

  Background: BackgroundValue;
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

  // Visual transform — resolved per-axis. Applied at render time only.
  VisualScaleX: number;
  VisualScaleY: number;
  VisualTranslateX: number;
  VisualTranslateY: number;
  VisualOriginX: number;
  VisualOriginY: number;

  // Perspective context — px viewing distance + vanishing origin (fraction of
  // this node's box) established for descendants. 0 = no perspective.
  Perspective: number;
  PerspectiveOriginX: number;
  PerspectiveOriginY: number;

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

  /** Foreground grade — multiplies the element's FINAL composited rgb
   *  (fill + image + text + border). From the `Filter` property; cascades
   *  to descendants (folded into the Effective* values the renderer reads).
   *  Default 1 (no-op). */
  Brightness: number;
  Saturation: number;
  Contrast: number;
  /** Cascade barrier for the foreground filter grade. When true, an
   *  ancestor's Filter grade does not fold into this element / subtree. */
  Isolate: boolean;
  Opacity: number;

  Layer: number;
}
