import type { Color } from '../Core/Types';
// Type-only, so the Vibrancy <-> Jiv.Types cycle is erased at compile time.
import type { VibrancyDeclaration } from '../Core/Vibrancy';
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
 * Color and an optional `Easing` exponent on the segment to the next
 * stop. Gradient.Curve fits them to the shader's smooth curve.
 */
export interface GradientStop {
  Position: number;
  Color: Color;
  Easing?: number;
}

export type BackgroundValue =
  | { Kind: 'Color',          Color: Color }
  /** FocalX/FocalY are the [0,1] crop anchor used when Fit='Cover' (and for the
   *  inset side under 'Contain'). 0.5 = centered (CSS `object-position: center`).
   *  Shifts which part of the over-scaled image stays in frame at any aspect. */
  | { Kind: 'Image',          Color: Color, Url: string, Fit: FitMode, FocalX: number, FocalY: number }
  | { Kind: 'LinearGradient', Color: Color, AngleRad: number, Stops: GradientStop[] }
  | { Kind: 'RadialGradient', Color: Color, CenterX: number, CenterY: number, Radius: number, Stops: GradientStop[] };

/** Knots shipped to the shader per gradient draw; Gradient.Curve resamples a longer curve down to it. */
export const MAX_GRADIENT_STOPS = 16;

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

/** A blur stop's `Easing` for `ease smooth`: the segment follows smootherstep, flat at both of its stops. */
export const BLUR_EASE_SMOOTH = 0;

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

/** Which neutral a glass body's `Tint` pulls its backdrop toward.
 *    • Ground: the active theme's ground, black in dark and white in light. The material default.
 *    • Ink:    the opposite neutral, white in dark and black in light (a selection or highlight).
 *    • Dark / Light: always black / always white, whatever the theme (glass over video or a camera). */
export type TintTone = 'Ground' | 'Ink' | 'Dark' | 'Light';

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
  /** The continuous corner's smoothing, 0..1 (Jiv/Shaders/Corner.Continuous.glsl): how far the corner
   *  eases into its edges, (1 + s) x the radius. 0 is a plain circular arc; 0.6, the default, is iOS. */
  BorderRadiusSmoothness: string;
  // Fill
  Background: string;

  /** VIBRANCY as an INHERITED property, the one that cascades like `color` (Core/Vibrancy.ts):
   *
   *      Vibrancy: rgb(255, 255, 255) @JwiftVibrancySecondaryFill   // color, signed amount [, cover]
   *      Vibrancy: None                                             // the reset, node AND subtree
   *      Vibrancy: Inherit                                          // the initial value
   *
   *  On a container, the container's shape draw treats its backdrop and every descendant's own paint
   *  is vibrant. `Isolate: true` is the subtree barrier. */
  Vibrancy: string;

  // ── Filters (CSS-shaped, ordered function lists) ──────────────────
  // One property per zone; each is a space-separated list of PascalCase
  // CSS-filter functions: Brightness(x) Saturate(x) Contrast(x) Blur(len).
  // `None` / empty = identity. Cross-state and cross-extends MERGE BY
  // FUNCTION (last occurrence of a function wins), so a `:Hover` can bump
  // one function without restating the rest.
  /** Foreground filter — grades the element's composited pixels (fill +
   *  image + text + border) AND cascades to descendants as a group (CSS
   *  `filter`). Stop the cascade into a subtree with `Isolate: true`.
   *  Animate the whole filter via `@Transition Filter`.
   *
   *  Also accepts foreground BLUR functions — the foreground analog of the
   *  backdrop progressive blur, composable with the grade functions:
   *    Blur(<radius>)
   *      — uniform foreground blur of this element's content.
   *    LinearProgressiveBlur(<edge|angle>, <radius> [, <feather>] [, <easing>])
   *    EdgeProgressiveBlur(<edge>,         <radius> [, <feather>] [, <easing>])
   *      — blur that ramps to <radius> toward <edge> (Top/Bottom/Left/Right)
   *        over <feather>, clear at the opposite edge. Drives the same
   *        ProgressiveBlur material/shader as the standalone ProgressiveBlur*
   *        props (which still win if both are set). See
   *        ProgressiveBlur/ForegroundFilter.Design.md. */
  Filter: string;
  /** Backdrop filter — frost + grade on the glass/backdrop behind this box
   *  (CSS `backdrop-filter`). Per-box; never inherited. `Blur(len)` is the
   *  frost radius. `Vibrancy([color,] amount [, cover])` treats the backdrop
   *  inside this box's shape and never this element's own ink
   *  (Core/Vibrancy.ts). */
  BackdropFilter: string;
  /** THE INK ZONE: only the element's TEXT, nothing else (Core/Vibrancy.ts):
   *
   *      TextFilter: Vibrancy(255, @JwiftVibrancyLabel)   // Apple's label vibrancy
   *      TextFilter: Vibrancy(60)                        // a glow: the ink adds at 60/255 of Color
   *      TextFilter: None                                // the default: the ink covers
   *
   *  It takes `Vibrancy(amount [, cover])` and nothing else; the ink's color is `Color`. The text is
   *  its own batch, so this works on glass, where `Filter: Vibrancy()` is refused. */
  TextFilter: string;
  /** Cascade barrier for the foreground `Filter`. `true` stops an ancestor's
   *  Filter grade from folding into this element + its subtree (CSS
   *  `isolation: isolate`). Default `false`. */
  Isolate: string;

  // Physical material — the Jiv is a slab with measurable properties
  Frost: string;
  Thickness: string;
  /** How far the glass bends what is behind it, as a multiple of Apple's: 1 is the full circle map
   *  across the edge band (Jiv.Panel.frag), which folds a thin mirrored arc at the outline; 0 is a
   *  flat pane. */
  Refraction: string;
  /** The body's neutral pigment, 0..1: how far the graded backdrop is pulled toward the `TintTone`
   *  neutral. Applied after the BackdropFilter grade and before the Background fill, so it is the
   *  dimming (or lightening) layer of the material, not a colour. A length expression, so
   *  `0.3 * @Dark + 0.4 * @Light` gives a material its own strength per theme. Default 0. A
   *  control with its own colour (an accent CTA) sets `Tint: 0` and paints its Background. */
  Tint: string;
  /** Which neutral `Tint` pulls toward. Default `Ground` (black in dark, white in light). */
  TintTone: TintTone;
  /** A luma, 0..2: the far end of the greyscale ramp (the body over white) this glass OPENS to when
   *  what is behind it leaves the ink room, as Apple's does ("the amount of tint and the dynamic range
   *  shift"). Read per surface from the adaptive-shadow probe's backdrop luma; never past the far end
   *  the authored grade already reaches over white, so the ink is never less legible than the static
   *  grade made it. Only a body tinted toward black opens. Default 0, the authored grade. */
  AdaptiveFar: string;


  // Lighting
  LightAngle: string;        // degrees
  LightIntensity: string;

  // Specular catchlight
  SpecularIntensity: string;
  SpecularGlow: string;

  // Fresnel + chromatic
  FresnelStrength: string;
  ChromaticAberration: string;
  EdgeLightTop: string;
  EdgeLightBottom: string;


  /** THE RIM: the light the edge catches, a hairline lifted onto whatever is already drawn there
   *  (the panel program's RIM_ONLY variant). `RimWidth` is its core where it faces the light, a length in `px`: a HAIRLINE,
   *  so it never scales with PointScale or a Visual transform. Away from the lit points it narrows to
   *  0.45 of that, never drawn under one device pixel. Apple's is about 0.95px. Default 0, no rim. */
  RimWidth: string;
  /** The rim's peak GAIN, 0..1, at the two points where the outline faces `LightAngle` and its bounce,
   *  dying with distance from them. What is under the rim is multiplied by 1 + this, then screened
   *  toward white by 0.96 of it, so it keeps its hue and still stands clear of a dark, busy body: over
   *  teal it reads as a lighter, still-saturated teal. Apple's is about 0.24. Default 0. */
  RimStrength: string;

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
   *  `0.5` the edge is antialiased over ~1 physical px. At `0` the edge is
   *  a hard step (aliased). */
  BorderBlur: string;
  /** How far the stroke fades INWARD past its width, a length. The outer edge stays as sharp as
   *  BorderBlur makes it; the inner edge eases from full stroke to nothing over this distance, so a
   *  rim can be a crisp line at the outline that dissolves into the body. 0 = the inner edge feathers
   *  by BorderBlur alone. */
  BorderFade: string;
  BorderOffset: string;
  ContainBorder: boolean;
  /** Where the border stroke paints in this Jiv's own paint stack, RELATIVE
   *  to its children's `Layer` space. A NUMBER in the same units children
   *  sort by: negative paints the border BEHIND content/children, positive
   *  IN FRONT — the border interleaves as if it were a child at this layer.
   *  Default `'0'`: the border sits with the panel itself, below all
   *  zero-Layer children — today's behavior. */
  BorderLayer: string;

  // Shadow
  ShadowColor: string;
  ShadowBlur: string;
  ShadowOffsetX: string;
  ShadowOffsetY: string;
  /** 0..1: how much the backdrop decides the shadow's opacity, as Apple's Liquid Glass does. ShadowColor's
   *  alpha is the opacity over text and busy content; over a flat light ground it falls to
   *  `alpha * (1 - ShadowAdaptive)`. Read from the backdrop a glass or backdrop-filter surface already
   *  samples, never from the theme. Default 0, a fixed shadow. */
  ShadowAdaptive: string;
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

  /** `Vibrancy:`'s resolved declaration for THIS node, before the cascade. The walk turns it into
   *  `Element.EffectiveVibrancy`. */
  VibrancyDeclaration: VibrancyDeclaration;
  /** `Filter: Vibrancy()`'s amount, a signed fraction of full scale, and its cover. */
  ForegroundVibrancy: number;
  ForegroundVibrancyCover: number;
  /** `TextFilter: Vibrancy()`'s amount (scales the ink) and cover. */
  TextVibrancy: number;
  TextVibrancyCover: number;
  /** `Filter: Vibrancy()`'s color, 0..1 per channel; white when none was given. */
  ForegroundVibrancyColor: Color;
  /** `BackdropFilter: Vibrancy()`'s color, 0..1 per channel; white when none was given. */
  BackdropVibrancyColor: Color;

  Frost: number;
  BackdropFrostBlur: number;
  /** `BackdropFilter: Blur(Auto)`: the frost follows the panel's size (`JivFrostCssPx`). */
  BackdropFrostAuto: boolean;
  Thickness: number;
  Refraction: number;
  /** Signed body tint: negative pulls toward black, positive toward white, magnitude = strength.
   *  Signed so a theme flip springs through clear glass rather than through grey. */
  Tint: number;
  /** The resolved `AdaptiveFar`, 0 when the grade stays as authored. */
  AdaptiveFar: number;
  BackdropBrightness: number;
  BackdropSaturation: number;
  BackdropContrast: number;
  /** `BackdropFilter: Vibrancy()`'s amount (n / 255, signed) and cover. Whether it is drawn under the
   *  element or folded into the grade above is decided at draw time (Core/Vibrancy.ts). */
  BackdropVibrancy: number;
  BackdropVibrancyCover: number;


  LightAngle: number;
  LightIntensity: number;

  SpecularIntensity: number;
  SpecularGlow: number;

  FresnelStrength: number;
  ChromaticAberration: number;
  EdgeLightTop: number;
  EdgeLightBottom: number;

  /** Resolved `RimWidth`, CSS px (the walk multiplies by the device pixel ratio). */
  RimWidth: number;
  RimStrength: number;

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
  BorderFade: number;
  BorderOffset: number;
  ContainBorder: boolean;
  /** Resolved border paint position in the child-`Layer` space. Default 0:
   *  border draws with the panel, below all zero-Layer children. A value
   *  greater than a child's Layer paints the border in front of that child;
   *  lower paints it behind. See JivStyle.BorderLayer. */
  BorderLayer: number;

  ShadowColor: Color;
  ShadowBlur: number;
  ShadowOffsetX: number;
  ShadowOffsetY: number;
  ShadowAdaptive: number;
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
