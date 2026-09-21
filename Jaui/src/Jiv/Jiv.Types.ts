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

/** How this element's OWN paint (fill, border, shadow, its own text) composes onto everything already
 *  painted beneath it: CSS `mix-blend-mode`, PascalCased.
 *    • Normal       source-over.
 *    • PlusLighter  additive: `dst + src * coverage` per channel, clipping at white (CSS `plus-lighter`,
 *                   Canvas 2D `lighter`). For LIGHT: a glow, a specular, an emissive sprite.
 *    • Screen       `1 - (1 - dst)(1 - src)` at coverage: lightens like an add but rolls off into white
 *                   instead of clipping. Refused on an element that paints text (the text program has
 *                   no premultiplied output, and screen cannot be coverage-correct without one).
 *  Not a group: descendants paint Normal unless they say otherwise, and the element's own layers blend
 *  one draw at a time. No other CSS mode is admitted, because a value that reached no draw call would
 *  be a silent no-op. Distinct from `BackdropFilter: Lift(n)`, which adds a constant UNDER the element
 *  and never touches its ink. */
export type BlendMode = 'Normal' | 'PlusLighter' | 'Screen';

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
   *  frost radius. `Lift(n)` adds a signed constant `n` (of 255) to every
   *  channel of the backdrop inside this box's shape, carrying its colour at 1
   *  and never touching this element's own ink; see `Core/Lift.ts` for the
   *  two implementations the engine picks between. */
  BackdropFilter: string;
  /** Border-zone backdrop filter — frost LOD offset + grade applied in the
   *  rim region only. Per-box. `Blur(len)` is the LOD octave offset vs the
   *  panel face (negative = sharper rim, positive = softer). */
  BorderFilter: string;
  /** Grade on the border's FRESNEL HIGHLIGHT — the lit-side flare the rim throws
   *  where it faces `LightAngle`. A filter, like its three siblings, but over the
   *  highlight's color rather than the zone's gather:
   *
   *    BorderFresnelFilter: Brightness(1.1) Saturate(1.6)
   *
   *  • `Saturate(x)` — chroma gain ABOUT WHITE. The highlight's hue is the border
   *    gather's own, driven to full value; `x` is how far past that hue it pushes.
   *    1 = the gather's hue exactly, 0 = plain white, >1 = more saturated than the
   *    thing it reflects (what a real bevel does). Engine default 1.6.
   *  • `Brightness(x)` — a final multiplier on the highlight's value. 1 = pinned to
   *    full value (the default); below 1 dims the flare, above 1 burns it toward
   *    white. Identity 1.
   *
   *  `Blur()` and `Contrast()` are REFUSED here and throw — see Filter.Parse's
   *  `'fresnel'` zone for why neither has a meaning on a normalized highlight.
   *  HOW MUCH of the highlight there is at all is `BorderFresnelStrength`; this
   *  property only says what color it is, exactly as `BorderColor.a` and
   *  `BorderFilter` already split amount from grade for the rim itself. */
  BorderFresnelFilter: string;
  /** Cascade barrier for the foreground `Filter`. `true` stops an ancestor's
   *  Filter grade from folding into this element + its subtree (CSS
   *  `isolation: isolate`). Default `false`. */
  Isolate: string;

  // Physical material — the Jiv is a slab with measurable properties
  Frost: string;
  Thickness: string;
  Fillet: string;
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
  /** How much Fresnel highlight the border carries on its lit side, 0..1. 0 = the
   *  stroke is its `BorderColor` all the way round; 1 = the lit side reaches the
   *  full highlight. Falls off as `pow(lightFacing, 3)` away from `LightAngle`, so
   *  even at 1 only the facing arc burns. Default 0, which is what keeps a plain
   *  border a plain uniform stroke. The highlight's COLOR is `BorderFresnelFilter`.
   *
   *  This was spelled `BorderFresnelBrightness` until the Fresnel got a filter, and
   *  that name was the bug: it is an amount, never a brightness, and a request to
   *  saturate the rim kept being answered with it. */
  BorderFresnelStrength: string;
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
  /** The radii as authored, before the smoothness compensation: what decides whether a corner saturates. */
  BorderRadiusRaw: [number, number, number, number];
  CornerShape: [CornerShape, CornerShape, CornerShape, CornerShape];
  BorderRadiusSmoothness: number;

  Background: BackgroundValue;
  BlendMode: BlendMode;

  Frost: number;
  BackdropFrostBlur: number;
  Thickness: number;
  Fillet: number;
  Refraction: number;
  /** Signed body tint: negative pulls toward black, positive toward white, magnitude = strength.
   *  Signed so a theme flip springs through clear glass rather than through grey. */
  Tint: number;
  /** The resolved `AdaptiveFar`, 0 when the grade stays as authored. */
  AdaptiveFar: number;
  BackdropBrightness: number;
  BackdropSaturation: number;
  BackdropContrast: number;
  /** `BackdropFilter: Lift(n)`, as a fraction of full scale (n / 255), signed. The grade above is the
   *  AUTHORED one; whether the lift is drawn under the element or folded into that grade is decided at
   *  draw time (`Core/Lift.ts`), because it depends on the cascaded foreground grade. */
  BackdropLift: number;

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
  /** Resolved `BorderFresnelStrength` — the 0..1 amount of the border's Fresnel. */
  BorderFresnelStrength: number;
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
  BorderFade: number;
  BorderBackdropBlur: number;
  BorderOffset: number;
  ContainBorder: boolean;
  /** Resolved border paint position in the child-`Layer` space. Default 0:
   *  border draws with the panel, below all zero-Layer children. A value
   *  greater than a child's Layer paints the border in front of that child;
   *  lower paints it behind. See JivStyle.BorderLayer. */
  BorderLayer: number;

  BorderBrightness: number;
  BorderSaturation: number;
  BorderContrast: number;

  /** Resolved `BorderFresnelFilter` grade over the rim's Fresnel highlight.
   *  Brightness is a final value multiplier (identity 1); Saturation is the
   *  highlight's chroma gain about white (engine default 1.6). */
  BorderFresnelBrightness: number;
  BorderFresnelSaturation: number;

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
