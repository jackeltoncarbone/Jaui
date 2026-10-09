/**
 * Apple's Liquid Glass, the CPU half: the size laws the instance packer, the blur plan and the shadow read.
 * The fragment half is `Jiv/Shaders/Glass.Pipeline.glsl`; the two state the same constants. Every value
 * and its source is in `Core/Glass.md`.
 */

import type { MaterialType } from '../Jiv/Jiv.Types';

export type GlassVariant = 'Regular' | 'Clear';

/** Glass this small tracks its backdrop's luma: its appearance and its face follow what is behind it. Apple's line is
 *  64 pt [C: Jwift/Apple/LiquidGlass.md]; this stays at 56 until the adaptive face's brightness drive is read from
 *  source, so glass between the two (the 62 pt tab bar) keeps its settled face. */
export const GLASS_TRACKS_LUMA_SPAN = 56;

/**
 * GLASS THAT ADAPTS TO WHAT IS UNDER IT (Drill Sentences lane WW1). Apple's regular material stays legible over busy
 * content: over high contrast or bright content it frosts and darkens until nothing behind reads as a shape, and over a
 * quiet one it stays clear. Ours reads the backdrop under each surface with its probe (Jiv.ShadowBackdrop.frag: G the
 * mean luma, R the luma's spread at the glass's own frost, scaled by `GLASS_ADAPT_SPREAD_SCALE`), and the vertex stage
 * turns that into one amount, 0 to 1 (`GlassAdaptOf`, mirrored in Jiv.Panel.vert): the spread past a quiet turf's,
 * handed off by size so the large sheet keeps its look (a menu still adapts), or, on thin glass alone (a toast, a chip,
 * the selection bar, a heading), a luma past the theme's comfortable band. Over an even backdrop a menu therefore reads
 * exactly as the sheet does (GlassStack.Render.spec.ts). The fragment stage
 * blurs up to `1 + GLASS_ADAPT_FROST` times its frost and moves a seeded glass's tint up to `GLASS_ADAPT_TINT_MAX`, never
 * past it, so the glass never goes a flat grey.
 */
export const GLASS_ADAPT_SPREAD_SCALE = 4;
/** The stored spread at which the glass starts to adapt and where it is fully adapted: a luma std dev of 0.0075 (a turf's
 *  mowing stripes under the frost) and of 0.0225 (its yard numbers and lines under the frost). */
export const GLASS_ADAPT_SPREAD = [0.03, 0.09] as const;
/** The mean luma band past which dark glass darkens (bright content) and light glass lightens (dim content). */
export const GLASS_ADAPT_LUMA_DARK = [0.45, 0.75] as const;
export const GLASS_ADAPT_LUMA_LIGHT = [0.25, 0.55] as const;
/** How much of the adaptation luma alone can ask for. */
export const GLASS_ADAPT_LUMA_SHARE = 0.6;
/** The span over which the busy backdrop's adaptation hands off to the large panel's own look, and the span over which
 *  the glare's hands off to a panel's (the regular glass's `v` ramp), pt. */
export const GLASS_ADAPT_SPAN = [200, 400] as const;
export const GLASS_ADAPT_GLARE_SPAN = [64, 160] as const;
/** At full adaptation the frost is this much more again, and a seeded tint reaches this alpha at most. */
export const GLASS_ADAPT_FROST = 1.5;
export const GLASS_ADAPT_TINT_MAX = 0.72;

const _smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** The adaptation amount for a glass `span` pt across over a backdrop of stored spread `spread` and mean luma `mean`.
 *  Glass presented over glass (`elevation` above 0, Core/Glass.Plate.ts `GlassReadsComposite`) takes no busy share: what
 *  is busy under it is the glass under it, whose own rows already read, and Apple's menu keeps its 4 pt law over a busy
 *  list (Jwift/Apple/LiquidGlass.md 3.2, Menus: sigma 3.6 pt over the Messages list), so a sheet's rows show through it as
 *  a soft blur rather than vanishing at twice that (Drill Sentences lane GL5). */
export const GlassAdaptOf = (spread: number, mean: number, span: number, dark: boolean, elevation: number = 0): number => {
  const busy = elevation > 0 ? 0 : _smooth(GLASS_ADAPT_SPREAD[0], GLASS_ADAPT_SPREAD[1], spread);
  const glare = dark ? _smooth(GLASS_ADAPT_LUMA_DARK[0], GLASS_ADAPT_LUMA_DARK[1], mean)
    : 1 - _smooth(GLASS_ADAPT_LUMA_LIGHT[0], GLASS_ADAPT_LUMA_LIGHT[1], mean);
  return Math.max(busy * (1 - _smooth(GLASS_ADAPT_SPAN[0], GLASS_ADAPT_SPAN[1], span)),
    GLASS_ADAPT_LUMA_SHARE * glare * (1 - _smooth(GLASS_ADAPT_GLARE_SPAN[0], GLASS_ADAPT_GLARE_SPAN[1], span)));
};

/** A seeded glass's tint alpha at adaptation `adapt` (never lowered, never past `GLASS_ADAPT_TINT_MAX`). */
export const GlassAdaptedTint = (alpha: number, adapt: number): number =>
  alpha + (Math.max(alpha, GLASS_ADAPT_TINT_MAX) - alpha) * adapt;

/** `u` ramps over S = 48..160 pt and `v` over 64..160 pt, S being the shape's minor dimension. */
export const GlassSizeRamps = (span: number): { U: number; V: number } => ({
  U: Math.max(0, Math.min(1, (span - 48) / 112)),
  V: Math.max(0, Math.min(1, (span - 64) / 96)),
});

/**
 * THE BODY TONE, the CPU mirror of Glass.Pipeline.glsl's `GlassYcc`, `GlassFace` and `GlassBleed` and of Jiv.Panel.frag's
 * edge-bleed weight and holding tone, so a spec can say what a glass body renders to without a GPU. Colors are sRGB
 * encoded, 0 to 1: Apple's recipe runs on encoded values (Jwift/Apple/Evidence.md 1.2), and so does Jiv.
 */
export type GlassRgb = readonly [number, number, number];
/** (white, black, saturation, fill alpha): QuartzCore's `set_ycc_composite` (LiquidGlass.md 3.3). Light glass is filled
 *  white and dark glass black, premultiplied. */
export type GlassFaceParams = readonly [number, number, number, number];

export const GLASS_BT709: GlassRgb = [0.2126, 0.7152, 0.0722];
export const GLASS_BLEED_LUMA: GlassRgb = [0.2125, 0.7154, 0.0721];
export const GlassLuma = (c: GlassRgb, weights: GlassRgb = GLASS_BT709): number =>
  c[0] * weights[0] + c[1] * weights[1] + c[2] * weights[2];

/** BT.709 luma remapped to (white - black) Y + black, chroma scaled by `saturation`. */
export const GlassYcc = (c: GlassRgb, white: number, black: number, saturation: number): GlassRgb => {
  const y = GlassLuma(c);
  const t = (white - black) * y + black;
  return [t + saturation * (c[0] - y), t + saturation * (c[1] - y), t + saturation * (c[2] - y)];
};

/**
 * APPLE'S DECOMPILED REGULAR FACES, ON LARGE GLASS (Drill Sentences lane GL1; LiquidGlass.md 3.3 [C]). Light: Y -> 0.318 Y
 * + 0.70; dark: Y -> 0.24 Y + 0.12; chroma x 0.6 both. Dark regular glass never lifts a backdrop brighter than 0.158
 * (0.12 / 0.76, the line's fixed point) and darkens everything above it.
 */
export const GLASS_FACE_APPLE_LIGHT: GlassFaceParams = [1.03, 0.5, 1.0, 0.4];
export const GLASS_FACE_APPLE_DARK: GlassFaceParams = [0.6, 0.2, 1.0, 0.4];

/**
 * GLASS PRESENTED OVER GLASS, IN DARK (Drill Sentences lanes GL3 and GL5). Apple's elevation trait changes no face in the
 * paths read (Jwift/Apple/LiquidGlass.md 8.1 [C]); Apple's menu over a dark sheet reads a step up because its backdrop
 * layer captures the sheet, and the dark face lifts anything below 0.158 [I]. Ours captures the sheet too
 * (Core/Glass.Plate.ts, `GlassReadsComposite`): the face below is applied once to the sheet's final pixels, its rows
 * included. Apple's dark face alone would pull a sheet over our field (0.18, which reads the field through its dim) DOWN
 * toward 0.158, -6 L*, the darker, greyer stack Jack rejected. So the presented face keeps Apple's slope (0.24: what
 * shows through, the sheet's rows, reads at Apple's contrast) and lifts the line to Y -> 0.24 Y + 0.222, its fixed
 * point 0.29, past every sheet the app draws over the field; and it holds the chroma of what it is presented over
 * (saturation 1.6667, 1 / 0.6, so x 1 where Apple's face takes 0.6 again). That lands a menu over the editor's bare sheet +4.5 L*
 * above it, about Apple's own measured menu over a sheet, 28 to 37 levels (+4.8 L*), and over a sheet gone near black at
 * the large detent about Apple's absolute 37 to 45 levels (+15 L* there, the sheet being darker than Apple's 28). GL3's
 * face (Y -> 0.24 Y + 0.21 over the field, which the menu read in place of the sheet) drew the opaque card of blind round
 * 30 over that dark sheet, +25 L*. Light glass keeps its face: its line lifts everything under it already.
 */
export const GLASS_FACE_APPLE_DARK_ELEVATED: GlassFaceParams = [0.77, 0.37, 1.6667, 0.4];
/** How much of a glass face must stand over earlier glass faces before it is elevated, as a share of its own area: none
 *  below the first, all from the second, smooth between. A sheet over the tab bar is never elevated; a menu wholly over
 *  a sheet always is; one hanging off the sheet's edge, partly. */
export const GLASS_ELEVATION_COVER = [0.5, 0.9] as const;
/** The elevation rides lane 42 above the scheme bit in steps of 1 / GLASS_ELEVATION_STEPS (Jiv.Panel.vert). */
export const GLASS_ELEVATION_STEPS = 31;
/** A glass face's elevation, 0 to 1, from the share of its area that stands over earlier glass faces. */
export const GlassElevationOf = (covered: number): number => _smooth(GLASS_ELEVATION_COVER[0], GLASS_ELEVATION_COVER[1], covered);
/**
 * The fitted faces (Core/Glass.md), held on glass 64 pt and under, where they were fitted: iOS's 62 pt bars and small
 * controls (dark) and SwiftUI's capsule (light). Apple's glass that size tracks its backdrop's luma, and the dark fit
 * (Y -> 0.40 Y + 0.176, chroma x 0.85) carries that adaptive lift; on a sheet it lifted a dark field by +11 L*.
 */
export const GLASS_FACE_FITTED_LIGHT: GlassFaceParams = [1.0054, 0.0829, 1.2246, 0.4];
export const GLASS_FACE_FITTED_DARK: GlassFaceParams = [0.9608, 0.2941, 1.4167, 0.4];
/** Glass 56 pt and under: the light face between Apple's observed settled values by the mean luma (0.45 to 0.95), and
 *  the dark face fitted to iOS's small controls. */
export const GLASS_FACE_THIN_LIGHT: readonly [GlassFaceParams, GlassFaceParams] = [[0.919, 0.319, 1.0, 0.516], [1.03, 0.819, 1.0, 0.266]];
export const GLASS_FACE_THIN_DARK: GlassFaceParams = [0.6879, 0.1412, 1.6, 0.25];
/** The span over which the fitted faces hand off to Apple's, pt: 64 is Apple's adaptive line, and from 96 every regular
 *  glass wears Apple's faces exactly. */
export const GLASS_FACE_LARGE_SPAN = [64, 96] as const;

const _mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const _mixFace = (a: GlassFaceParams, b: GlassFaceParams, t: number): GlassFaceParams =>
  [_mix(a[0], b[0], t), _mix(a[1], b[1], t), _mix(a[2], b[2], t), _mix(a[3], b[3], t)];

/** The light and dark face parameters regular glass `span` pt across wears (`mean` is the probe's luma, read only at
 *  56 pt and under; `elevation` 0 to 1, how far it stands over other glass, moves large dark glass to its elevated
 *  face and leaves the rest). */
export const GlassFaceParamsOf = (span: number, mean: number = 0.5, elevation: number = 0): { Light: GlassFaceParams; Dark: GlassFaceParams } => {
  let light = GLASS_FACE_FITTED_LIGHT;
  let dark = GLASS_FACE_FITTED_DARK;
  if (span <= 56) {
    light = _mixFace(GLASS_FACE_THIN_LIGHT[0], GLASS_FACE_THIN_LIGHT[1], Math.max(0, Math.min(1, (mean - 0.45) / 0.5)));
    dark = GLASS_FACE_THIN_DARK;
  }
  const large = Math.max(0, Math.min(1, (span - GLASS_FACE_LARGE_SPAN[0]) / (GLASS_FACE_LARGE_SPAN[1] - GLASS_FACE_LARGE_SPAN[0])));
  const appleDark = _mixFace(GLASS_FACE_APPLE_DARK, GLASS_FACE_APPLE_DARK_ELEVATED, Math.max(0, Math.min(1, elevation)));
  return { Light: _mixFace(light, GLASS_FACE_APPLE_LIGHT, large), Dark: _mixFace(dark, appleDark, large) };
};

/** Regular glass's face over the lensed read `c`, `light` its appearance 0 (dark) to 1 (light). */
export const GlassFaceOf = (c: GlassRgb, span: number, light: number, mean: number = 0.5, elevation: number = 0): GlassRgb => {
  const { Light, Dark } = GlassFaceParamsOf(span, mean, elevation);
  const lit = GlassYcc(c, Light[0], Light[1], Light[2]);
  const dim = GlassYcc(c, Dark[0], Dark[1], Dark[2]);
  const at = (i: number): number => _mix(dim[i] * (1 - Dark[3]), lit[i] * (1 - Light[3]) + Light[3], light);
  return [at(0), at(1), at(2)];
};

/** The edge bleed's own matrix: light (1, 0.9, 1.2), Y -> 0.9 + 0.1 Y; dark (0.5, 0, 1), Y -> 0.5 Y (LiquidGlass.md 3.4). */
export const GlassBleedOf = (c: GlassRgb, light: number): GlassRgb => {
  const dim = GlassYcc(c, 0.5, 0, 1);
  const lit = GlassYcc(c, 1, 0.9, 1.2);
  return [_mix(dim[0], lit[0], light), _mix(dim[1], lit[1], light), _mix(dim[2], lit[2], light)];
};
/** The bleed's opacity, iOS 26.1's recipe: 0.5 light, 0.8 dark, times `v`. */
export const GLASS_BLEED_OPACITY = { Light: 0.5, Dark: 0.8 } as const;
/** The holding tone: the interior at 97% (LiquidGlass.md 3.6). */
export const GLASS_HOLDING_TONE = 0.97;

/**
 * The body of regular glass over an even backdrop `c`, inside its bezel and its rim band: the face, the edge bleed (whose
 * read is that same backdrop: everywhere on a sheet, whose subvariant has no bleed reach, and deep inside any panel), and
 * the holding tone, clamped, in the order Jiv.Panel.frag runs them. Nothing in it depends on where in the body it is.
 * Over an uneven backdrop `c` is the body's own blurred read at the pixel, and `bleedRead` the bleed's far wider one (its
 * blur is 0.35 of the span, so over a menu's rows it reads their mean).
 */
export const GlassBodyOf = (c: GlassRgb, span: number, light: number, mean: number = 0.5, elevation: number = 0,
  bleedRead: GlassRgb = c): GlassRgb => {
  const face = GlassFaceOf(c, span, light, mean, elevation);
  const { V } = GlassSizeRamps(span);
  let out: GlassRgb = face;
  if (V > 0) {
    const bleed = GlassBleedOf(bleedRead, light);
    const lum = GlassLuma(face, GLASS_BLEED_LUMA);
    let weight = _mix(1 - lum, lum, light);
    weight = weight * weight;
    const amount = Math.max(0, Math.min(1, weight * weight * V * _mix(GLASS_BLEED_OPACITY.Dark, GLASS_BLEED_OPACITY.Light, light)));
    out = [_mix(face[0], bleed[0], amount), _mix(face[1], bleed[1], amount), _mix(face[2], bleed[2], amount)];
  }
  const hold = (x: number): number => Math.max(0, Math.min(1, x * GLASS_HOLDING_TONE));
  return [hold(out[0]), hold(out[1]), hold(out[2])];
};

/**
 * APPLE'S TINT, `.tint(color)` (Jwift/Apple/LiquidGlass.md 4 [C]; Drill Sentences lane GL6). The glass filter does not
 * change: a `CASDFGradientEffect` layer (alpha 1 everywhere inside the shape) carries a backdrop-aware vibrant matrix
 * whose rows are affine in the luma L of the glassed pixel under it, so `tint = mix(darkShade, seed, L)`: the seed
 * exactly at L = 1, its dark shade at L = 0. Apple's two decompiled rows (iOS 26, orange and blue) fix the shade for
 * those seeds; the general law here is fitted to both [I]: the seed's BT.709 luma x 0.58 and its chroma x 0.63
 * (`GlassYcc(seed, 0.58, 0, 0.63)`), within 8 levels of every decompiled channel (5.4 rms). It replaces the macOS 27
 * SwiftUI fit (luma x 0.35, chroma x 1.10), which put orange's dark green 38 levels under Apple's iOS row.
 * Glass.Pipeline.glsl's `GLASS_TINT_SHADE` and `GlassTint` state the same numbers.
 */
export const GLASS_TINT_SHADE = [0.58, 0.63] as const;
/** The seed's dark shade, the tint at L = 0. */
export const GlassTintShadeOf = (seed: GlassRgb): GlassRgb => GlassYcc(seed, GLASS_TINT_SHADE[0], 0, GLASS_TINT_SHADE[1]);
/** The tint over a glassed pixel `face` (its own luma is L), unclamped as the shader's `GlassTint` is. */
export const GlassTintOf = (face: GlassRgb, seed: GlassRgb): GlassRgb => {
  const l = Math.max(0, Math.min(1, GlassLuma(face)));
  const shade = GlassTintShadeOf(seed);
  return [_mix(shade[0], seed[0], l), _mix(shade[1], seed[1], l), _mix(shade[2], seed[2], l)];
};
/** A seeded glass wears the regular face at any span past the thin control's fit (Glass.Pipeline.glsl's
 *  `GLASS_PANEL_FACE_SPAN`; Jiv.Panel.vert keeps it off the probe, so its appearance is its theme's). */
export const GLASS_PANEL_FACE_SPAN = 57;

/**
 * The body of a TINTED regular glass over an even backdrop `c` (a prominent button, Apple's `.glassProminent`), in the
 * order Jiv.Panel.frag runs it: the face at the panel span (`GLASS_PANEL_FACE_SPAN`), the edge bleed at the glass's own
 * span, the holding tone, then the tint layer over that finished pixel at `alpha` (the seed's alpha, adapted), clamped.
 * The rim and the press glow lie over this, as they do over any glass.
 */
export const GlassTintedBodyOf = (c: GlassRgb, span: number, light: number, seed: GlassRgb, alpha: number = 1,
  adapt: number = 0, elevation: number = 0): GlassRgb => {
  // The bleed's reach `v` is 0 under 64 pt, so taking the body at the panel span changes only the face: the shader's
  // max(span, GLASS_PANEL_FACE_SPAN) face with the glass's own bleed, exactly.
  const face = GlassBodyOf(c, Math.max(span, GLASS_PANEL_FACE_SPAN), light, 0.5, elevation, c);
  const tint = GlassTintOf(face, seed);
  const a = GlassAdaptedTint(alpha, adapt);
  const at = (i: number): number => Math.max(0, Math.min(1, _mix(face[i], tint[i], a)));
  return [at(0), at(1), at(2)];
};

/**
 * THE INK ON A TINTED GLASS (Drill Sentences lane GL6b). A fully tinted glass is the seed over light content and its dark
 * shade over dark content, so its label takes white where the tinted body is dark and black where it is light, decided
 * on the body itself (Glass.Pipeline.glsl's `GlassTintedBody` and `GlassTintInkWhite`, which the text shader runs at
 * the glass's probed mean luma). The switch is WCAG's crossover of the two inks, sqrt(0.05 x 1.05) - 0.05, where both
 * read 4.58:1, so whichever is chosen reads at least that. Black, not a warm near-black: any ink brighter than relative
 * luminance 0.0018 leaves a band of bodies on which neither ink reaches 4.5:1. Apple's light-glass label is black
 * (Jwift/Apple/LiquidGlass.md 6).
 */
export const GLASS_TINT_INK_SWITCH = 0.1791;
/** A glass is fully tinted, and its labels take the tint's ink, from this seed alpha (a part-tinted panel keeps its
 *  theme's ink). */
export const GLASS_TINT_INK_ALPHA = 0.999;
/** WCAG relative luminance of an encoded colour, 0 to 1. */
export const GlassRelativeLuminance = (c: GlassRgb): number => {
  const lin = (v: number): number => (v < 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return GLASS_BT709[0] * lin(c[0]) + GLASS_BT709[1] * lin(c[1]) + GLASS_BT709[2] * lin(c[2]);
};
export type GlassTintInkColor = 'White' | 'Black';
/** The ink a label takes on the tinted body `body`. */
export const GlassTintInkOf = (body: GlassRgb): GlassTintInkColor =>
  GlassRelativeLuminance(body) <= GLASS_TINT_INK_SWITCH ? 'White' : 'Black';

/**
 * `GlassFrost`, DesignLibrary's `GlassMaterialProvider.Frost` (Jwift/Apple/LiquidGlass.md 3.2): the regular recipe's blur
 * class. 0 Automatic: BlurRadius 1.33 to 4 pt on a quarter-scale backdrop. 1 Reduced: 0.667 pt on a half-scale one.
 * 2 None: no blur, the quarter-scale capture alone. UIKit sets it from the scroll pocket a glass sits in. Clear glass
 * keeps its own recipe.
 */
export type GlassFrost = 0 | 1 | 2;
export const GLASS_FROST_AUTOMATIC = 0;
export const GLASS_FROST_REDUCED = 1;
export const GLASS_FROST_NONE = 2;

/** The backdrop's scale in Apple's pipeline: a quarter for regular glass (a half at Reduced frost), a half for clear. */
export const GlassBackdropScale = (variant: GlassVariant, frost: number = GLASS_FROST_AUTOMATIC): number =>
  variant === 'Clear' || frost === GLASS_FROST_REDUCED ? 0.5 : 0.25;

/** BlurRadius in points: 1.33 to 4 over `u` for regular glass (0.667 Reduced, 0 None), 1 for clear; an authored
 *  `GlassBlur` (above 0) instead. */
export const GlassBlurRadius = (span: number, variant: GlassVariant, authored: number = 0, frost: number = GLASS_FROST_AUTOMATIC): number =>
  authored > 0 ? authored : variant === 'Clear' ? 1
    : frost === GLASS_FROST_REDUCED ? 0.66666667 : frost === GLASS_FROST_NONE ? 0 : 1.3333 + 2.6667 * GlassSizeRamps(span).U;

/** A radius in points to Apple's LOD on its backdrop texture: `r` in backdrop texels, then log2. */
export const GlassAppleLod = (radiusPt: number, dpr: number, variant: GlassVariant, frost: number = GLASS_FROST_AUTOMATIC): number => {
  const r = radiusPt * GlassBackdropScale(variant, frost) * dpr * 1.6;
  return Math.max(0, r < 2 ? Math.log2(1 + 0.5 * r) : Math.log2(r));
};

/**
 * THE BLUR APPLE'S LOD DELIVERS. Apple samples a quarter (clear: half) resolution texture at a mip LOD; we
 * never render below native, so we read our own pyramid at the Gaussian that LOD delivers. Apple's level L
 * holds texels 2^L / backdropScale device px wide; a texel reads as a Gaussian of a share of its width. Our
 * LOD n names a Gaussian of 2^n device px, so n = L + log2(share / backdropScale), and GlassPyramidLevel finds
 * the level of the pyramid at hand that delivers it. The shares are fitted per backdrop scale to SwiftUI's own
 * render of the same inputs (0.62 for the quarter-scale regular backdrop, 0.28 for clear's half scale); the
 * regular one is Apple's own x1.6 read back (1 / 1.6 = 0.625), which makes BlurRadius the sigma in points.
 */
export const GLASS_TEXEL_SIGMA_REGULAR = 0.62;
export const GLASS_TEXEL_SIGMA_CLEAR = 0.28;
/** The shares follow the backdrop's scale, so Reduced frost's half-scale backdrop reads with clear's. */
export const GlassNativeLod = (appleLod: number, variant: GlassVariant, frost: number = GLASS_FROST_AUTOMATIC): number => {
  const scale = GlassBackdropScale(variant, frost);
  return appleLod + Math.log2((scale > 0.25 ? GLASS_TEXEL_SIGMA_CLEAR : GLASS_TEXEL_SIGMA_REGULAR) / scale);
};

/**
 * The level of a pyramid that delivers a Gaussian of `sigma` device px, fractional as trilinear reads it. Level 0
 * has `texel` device px and delivers `sigma0`; each MIP hop, a [1 3 3 1] binomial, adds 3/4 of its source texel
 * squared and the bilinear read 1/6 of its own, so level L reads as variance sigma0^2 + (5/12) texel^2 (4^L - 1)
 * (exact to 0.05 px against the passes' own 1D operators). Glass.Pipeline.glsl states the same.
 */
export const GlassPyramidLevel = (sigma: number, texel: number, sigma0: number): number => {
  const q = (sigma * sigma - sigma0 * sigma0) / ((5 / 12) * texel * texel) + 1;
  if (q <= 1) return 0;
  const whole = Math.floor(0.5 * Math.log2(q));
  const p = Math.pow(4, whole);
  return whole + (q - p) / (3 * p);
};

/** The body's LOD at blur scale `k` (0.5 at the edge ramp's floor, 1 in the body), on our pyramid. */
export const GlassBodyLod = (span: number, k: number, dpr: number, variant: GlassVariant, authored: number = 0,
  frost: number = GLASS_FROST_AUTOMATIC): number =>
  GlassNativeLod(GlassAppleLod(GlassBlurRadius(span, variant, authored, frost) * k, dpr, variant, frost), variant, frost);

/** Edge bleed: opacity over `v` (0 below 64 pt), outward shift and blur, and its LOD. Off on clear glass. */
export const GlassBleedLod = (span: number, dpr: number, variant: GlassVariant, frost: number = GLASS_FROST_AUTOMATIC): number =>
  GlassNativeLod(GlassAppleLod(0.7 * span * 0.5, dpr, variant, frost), variant, frost);

/** The drop shadow: offset (0, 8) pt, reaching 2 radii; its colored read blurs at 40 pt. The radius is 24 pt
 *  on large glass (Apple's), 10 pt at 48 pt, fitted to Apple's iPhone Edit button over white (23 levels deep at
 *  the edge, gone by 18 pt), ramping over u. */
export const GLASS_SHADOW_OFFSET_Y = 8;
export const GlassShadowRadius = (span: number): number => 10 + 14 * GlassSizeRamps(span).U;
export const GLASS_SHADOW_BLUR = 40;
export const GlassShadowLod = (dpr: number, variant: GlassVariant, frost: number = GLASS_FROST_AUTOMATIC): number =>
  GlassNativeLod(GlassAppleLod(GLASS_SHADOW_BLUR, dpr, variant, frost), variant, frost);
/** How far the colored shadow's read reaches outward: min(0.625 S, 75) pt. */
export const GlassShadowAmount = (span: number): number => Math.min(0.625 * span, 75);

/** Glass.Pipeline.glsl's `GlassShadowFall`, Apple's polynomial (LiquidGlass.md 3.5), on the CPU: 1 at `reach` inside
 *  the shifted outline to 0 at `reach` outside it, 0.5 on it. `sd` and `reach` in one unit; `reach` is two shadow radii.
 *  It reads as a Gaussian edge of sigma reach / (2 sqrt 2): x = 2 sd / reach and the polynomial is 0.5 erfc(x) to 0.002. */
export const GlassShadowFall = (sd: number, reach: number): number => {
  const x = 4 * Math.min(1, Math.max(0, sd / (2 * Math.max(reach, 1e-4)) + 0.5)) - 2;
  const x2 = x * x;
  return 0.5 + x * (-0.560547 + x2 * (0.168213 + x2 * (-0.034454 + 0.002954 * x2)));
};

/**
 * `GlassShadow: Auto | Platter | None` (Core/Glass.Jss.md). Auto is glassBackground's own drop shadow (LiquidGlass.md
 * 3.5) and nothing else; None casts none; Platter is that shadow and, under it, the platter's: menus, popovers, sheets
 * and dialogs only.
 *
 * WHY A PLATTER SHADOW (Drill Sentences lane GL2). The decompiled law, worked through for a 250 pt menu over an even
 * backdrop of luma 0.3: peak alpha 0.25 (opacity 0.5 - 0.25u at u = 1, the colored read at v = 1), a fall of sigma
 * 24 / sqrt 2 = 17 pt offset 8 pt down, and a color of M_shadow times the backdrop: dark Y -> 0.5 Y, light Y -> Y. So
 * dark large glass darkens what is below it 7.4% at 4 pt, 5.1% at 12, 2.1% at 24, 0.4% at 40; light large glass darkens
 * nothing at all (it saturates). Ours draws exactly that (measured live in dark: 3% at 14 to 20 pt, gone by 40), and
 * a blind tester twice read it as "no visible shadow". iOS 26's menus and popovers stand on a soft, wide shadow that the
 * law does not make, so it is UIKit's platter's own, drawn beside glassBackground [I]: the context menu platter's and
 * the sheet's drop shadow views. Its values are [I], not read: a black shadow of CA radius 30 pt (read as sigma), 10 pt
 * down, opacity 0.18 light and 0.35 dark, ramped over Apple's thick-glass ramp `v` (64 to 160 pt), so glass 64 pt and
 * under casts none of it (Jwift/Apple/LiquidGlass.md 3.5, the [I] note).
 */
export type GlassShadowKind = 'Auto' | 'Platter' | 'Lift' | 'None';
export const GLASS_PLATTER_SHADOW = { Sigma: 30, OffsetY: 10, OpacityLight: 0.18, OpacityDark: 0.35 } as const;

export interface GlassPlatterShadow {
  /** The Gaussian's sigma, pt. */
  Sigma: number;
  /** Down, pt. */
  OffsetY: number;
  /** The black's alpha under the face. */
  Opacity: number;
  /** `GlassShadowFall`'s reach for that sigma (2 sqrt 2 sigma), pt. */
  Reach: number;
}

/** The platter shadow of glass `span` pt across in its theme: half its sigma and offset at 64 pt growing to the full ones
 *  at 160, its opacity over `v` (0 at 64 pt and under).
 *
 *  `Lift` (`GlassShadow: Lift`, Drill Sentences lane SH2): a row lifted out of its list to be carried, the platter UIKit
 *  lifts a dragged item onto (`_UIPlatterView`) [I]. Its sigma and offset follow the same size law, and its opacity is the
 *  platter's whole at any size: a lifted row is a platter however thin, and the size ramp left a 68 pt row with none, so
 *  the owner read it as "no shadow". */
export const GlassPlatterShadowOf = (span: number, dark: boolean, kind: GlassShadowKind = 'Platter'): GlassPlatterShadow => {
  const { V } = GlassSizeRamps(span);
  const sigma = GLASS_PLATTER_SHADOW.Sigma * (0.5 + 0.5 * V);
  const share = kind === 'Lift' ? 1 : V;
  return {
    Sigma: sigma,
    OffsetY: GLASS_PLATTER_SHADOW.OffsetY * (0.5 + 0.5 * V),
    Opacity: share * (dark ? GLASS_PLATTER_SHADOW.OpacityDark : GLASS_PLATTER_SHADOW.OpacityLight),
    Reach: 2 * Math.SQRT2 * sigma,
  };
};

/** Whether `kind` casts the platter's shadow under the glass's own: a menu's, a popover's, a sheet's (`Platter`), or a
 *  carried row's (`Lift`). */
export const GlassCastsPlatter = (kind: GlassShadowKind | string): boolean => kind === 'Platter' || kind === 'Lift';

/** How far past the outline glass `span` pt across can put shadow, pt: two radii plus the offset for Apple's, and the
 *  platter's reach plus its offset when it casts one. What a draw rect, a card's paint rect and a cached layer must hold.
 *  A glass with an arrow (`GlassArrow`) paints the arrow's height further, its face and its shadows alike. */
export const GlassShadowExtent = (span: number, kind: GlassShadowKind, arrow: GlassArrowSide | string = 'None'): number => {
  const tip = GlassArrowReach(arrow);
  if (kind === 'None') return tip;
  const own = 2 * GlassShadowRadius(span) + GLASS_SHADOW_OFFSET_Y;
  if (!GlassCastsPlatter(kind) || (kind === 'Platter' && GlassSizeRamps(span).V <= 0)) return own + tip;
  const p = GlassPlatterShadowOf(span, true, kind);
  return Math.max(own, p.Reach + p.OffsetY) + tip;
};

/**
 * THE SHADOW OVER AN EVEN BACKDROP, the CPU mirror of the two draws (Jiv.Panel.frag's flat shadow and its colored one,
 * Glass.Pipeline.glsl `GlassShadowFall`), so a spec can say what a glass surface does to the backdrop beside it. `luma`
 * is the backdrop's (sRGB encoded, 0 to 1, grey); `dx` and `dy` are the point's signed distances past the face's side
 * and bottom edges, pt, negative inside (a point straight below the middle of a 250 pt menu has dx -125). Returns the
 * luma there with the glass's shadows drawn, square corners. Under the face (both negative) the glass covers it: `luma`.
 * `read` is the luma the colored shadow reads, the glass's own backdrop: the ground itself, unless the ground is other
 * glass (a menu over a sheet), which no glass samples (Core/Glass.Plate.ts), so it reads the content under that glass.
 */
export const GlassShadowedLuma = (luma: number, span: number, dx: number, dy: number, dark: boolean,
  kind: GlassShadowKind, clear: number = 0, read: number = luma): number => {
  if (kind === 'None' || (dx < 0 && dy < 0)) return luma;
  // The signed distance to the outline shifted down by `offset`.
  const sdAt = (offset: number): number => {
    const oy = dy - offset;
    return dx > 0 && oy > 0 ? Math.hypot(dx, oy) : Math.max(dx, oy);
  };
  const { V } = GlassSizeRamps(span);
  // Apple's: black at its fill under v, the colored read (M_shadow of this same even backdrop) over v.
  const a = GlassShadowFall(sdAt(GLASS_SHADOW_OFFSET_Y), 2 * GlassShadowRadius(span)) * GlassShadowPeak(span, clear);
  const fill = 0.12 + 0.08 + 0.16 * GlassSizeRamps(span).U;
  const layer = fill + (1 - fill) * V;
  const colored = Math.min(1, (dark ? 0.5 * read : read) * V / Math.max(layer, 1e-3));
  let out = luma * (1 - a) + colored * a;
  if (GlassCastsPlatter(kind) && (kind === 'Lift' || V > 0)) {
    const p = GlassPlatterShadowOf(span, dark, kind);
    out *= 1 - GlassShadowFall(sdAt(p.OffsetY), p.Reach) * p.Opacity * (1 - Math.min(Math.max(clear, 0), 1));
  }
  return out;
};

/**
 * THE POPOVER ARROW (Drill Sentences lane GL4; Jwift/Apple/Sizing.md 13, [C] from `_UIPopoverShapePathProviderIOS` and
 * the iOS 26.1 dyld cache). A popover's glass is ONE outline: the rounded body and an arrow on one of its edges, and the
 * glass, its rim, lens, edge bleed and both shadows follow it. `GlassArrow: None | Top | Bottom | Leading | Trailing`
 * names the edge, `GlassArrowOffset` the arrow's centre from that edge's centre (UIKit's `arrowOffset`), in points.
 *
 * Apple's arrow is 13 pt tall on a 26 pt base. Its flanks stop 2 pt either side of the peak and 1 pt back, joined by one
 * cubic whose control points are both the peak; each flank leaves the edge through a concave fillet that starts 5.5 pt
 * past the base corner (half the flank's run) and reaches the flank's midpoint by a cubic with both control points on
 * the base corner. So the arrow meets the edge over 37 pt, tangent to it. Ours never pins into a corner as UIKit's can:
 * the offset is clamped so those 37 pt stay clear of the edge's corner radius.
 *
 * In (u, w) points, u along the edge from the arrow's centre and w outward from the edge, the right half of the outline
 * (the left mirrors it): the tip cubic's second half from (0, 12.75) to (2, 12), a line to (7.5, 6), the fillet to
 * (18.5, 0). Glass.Pipeline.glsl's `GlassArrowField` walks the same polyline.
 */
export type GlassArrowSide = 'None' | 'Top' | 'Bottom' | 'Leading' | 'Trailing';
export const GLASS_ARROW = { Height: 13, Base: 26, HalfFootprint: 18.5 } as const;
/** The lane code of each side (lane 38, `GlassArrowLane`); Leading is the left edge and Trailing the right. */
const GLASS_ARROW_SIDE_CODE: Record<GlassArrowSide, number> = { None: 0, Top: 1, Bottom: 2, Leading: 3, Trailing: 4 };
/** The shadow draw's mode rides lane 38's low two bits; the arrow above it in 4s: its side, and in 8s above that its
 *  offset in quarter device px biased by 32768 (every value exact in a float's 24 bits). */
export const GLASS_ARROW_OFFSET_BIAS = 32768;
export const GlassArrowLane = (mode: number, side: GlassArrowSide, offsetPx: number): number => {
  const code = GLASS_ARROW_SIDE_CODE[side];
  if (code === 0) return mode;
  const q = Math.max(0, Math.min(65535, Math.round(offsetPx * 4) + GLASS_ARROW_OFFSET_BIAS));
  return mode + 4 * (code + 8 * q);
};
/** Lane 38's shadow mode alone (Jiv.Panel.frag, `GlassLaneShadowMode`). */
export const GlassLaneShadowMode = (lane: number): number => lane % 4;
/** How far past the box an arrow on `side` reaches, pt: its height, or 0. */
export const GlassArrowReach = (side: GlassArrowSide | string): number => side === 'None' || !side ? 0 : GLASS_ARROW.Height;

const _cubic = (a: number, b: number, c: number, d: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};
/** The right half of the arrow's outline as the shader walks it, in (u, w) points: the tip cubic over t 0.5 to 1 in four
 *  steps, the straight flank, the fillet in eight steps. */
export const GLASS_ARROW_POLYLINE: readonly (readonly [number, number])[] = (() => {
  const pts: [number, number][] = [[0, 12.75]];
  for (let i = 1; i <= 4; i++) {
    const t = 0.5 + 0.125 * i;
    pts.push([_cubic(-2, 0, 0, 2, t), _cubic(12, 13, 13, 12, t)]);
  }
  pts.push([7.5, 6]);
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    pts.push([_cubic(7.5, 13, 13, 18.5, t), _cubic(6, 0, 0, 0, t)]);
  }
  return pts;
})();

/** The arrow's own field at (u, w) points: the distance to its outline, the outward normal there, and whether the point
 *  is inside the arrow (between the edge and the outline). Glass.Pipeline.glsl's `GlassArrowField`. */
export const GlassArrowField = (u: number, w: number): { Distance: number; Normal: [number, number]; Inside: boolean } => {
  const qx = Math.abs(u);
  let best = Infinity, bx = qx, by = w, nx = 0, ny = 1, graph = -1;
  for (let i = 1; i < GLASS_ARROW_POLYLINE.length; i++) {
    const [ax, ay] = GLASS_ARROW_POLYLINE[i - 1];
    const [cx, cy] = GLASS_ARROW_POLYLINE[i];
    const sx = cx - ax, sy = cy - ay;
    const t = Math.max(0, Math.min(1, ((qx - ax) * sx + (w - ay) * sy) / Math.max(sx * sx + sy * sy, 1e-12)));
    const px = ax + sx * t, py = ay + sy * t;
    const d2 = (qx - px) ** 2 + (w - py) ** 2;
    if (d2 < best) {
      best = d2; bx = px; by = py;
      const l = Math.hypot(sx, sy) || 1;
      nx = -sy / l; ny = sx / l;
    }
    if (qx >= ax && qx <= cx && cx > ax) graph = ay + (cy - ay) * (qx - ax) / (cx - ax);
  }
  const inside = w > 0 && w < graph;
  const d = Math.sqrt(best);
  if (d > 1e-4) {
    nx = (inside ? bx - qx : qx - bx) / d;
    ny = (inside ? by - w : w - by) / d;
  }
  return { Distance: d, Normal: [u < 0 ? -nx : nx, ny], Inside: inside };
};

/**
 * THE BODY AND ITS ARROW AS ONE OUTLINE: the signed distance (negative inside) and outward normal of their union at `p`,
 * taken from the body's centre, given the body's own `bodyDist` and `bodyNormal` there. Lengths in one unit (device px in
 * the shader); `pt` is that unit per point. Glass.Pipeline.glsl's `GlassArrowUnion` states the same.
 *
 * Outside both, the union's distance is the nearer of the two. Inside the arrow it is the distance to the arrow's outline.
 * Inside the body, under the arrow's 37 pt footprint, the body's own edge is no longer an edge: the nearest is the arrow's
 * outline or one of the body's other three sides, so no rim, lens or holding tone runs along the seam.
 */
export const GlassArrowUnion = (p: readonly [number, number], halfW: number, halfH: number,
  radii: readonly [number, number, number, number], side: GlassArrowSide, offset: number, pt: number,
  bodyDist: number, bodyNormal: readonly [number, number]): { Distance: number; Normal: [number, number] } => {
  const code = GLASS_ARROW_SIDE_CODE[side];
  if (code === 0) return { Distance: bodyDist, Normal: [bodyNormal[0], bodyNormal[1]] };
  const across = code > 2;
  const along = across ? halfH : halfW;
  const perp = across ? halfW : halfH;
  const cap = Math.min(halfW, halfH);
  const r = radii.map((x) => Math.max(0, Math.min(cap, x)));
  const corner = code === 1 ? Math.max(r[0], r[1]) : code === 2 ? Math.max(r[2], r[3]) : code === 3 ? Math.max(r[0], r[3]) : Math.max(r[1], r[2]);
  const room = Math.max(0, along - corner - GLASS_ARROW.HalfFootprint * pt);
  const off = Math.max(-room, Math.min(room, offset));
  const sgn = code === 1 || code === 3 ? -1 : 1;
  const u = (across ? p[1] : p[0]) - off;
  const w = sgn * (across ? p[0] : p[1]) - perp;
  const f = GlassArrowField(u / pt, w / pt);
  const dArrow = f.Distance * pt;
  const toShape = (nu: number, nw: number): [number, number] => across ? [sgn * nw, nu] : [nu, sgn * nw];
  if (f.Inside) return { Distance: -dArrow, Normal: toShape(f.Normal[0], f.Normal[1]) };
  if (bodyDist >= 0) {
    return dArrow < bodyDist ? { Distance: dArrow, Normal: toShape(f.Normal[0], f.Normal[1]) } : { Distance: bodyDist, Normal: [bodyNormal[0], bodyNormal[1]] };
  }
  if (Math.abs(u) < GLASS_ARROW.HalfFootprint * pt) {
    const toSides = along - Math.abs(u + off);
    const toFar = 2 * perp + w;
    const other = Math.min(toSides, toFar);
    if (dArrow < other) return { Distance: -dArrow, Normal: toShape(f.Normal[0], f.Normal[1]) };
    return { Distance: -other, Normal: toSides < toFar ? toShape(u + off < 0 ? -1 : 1, 0) : toShape(0, -1) };
  }
  return { Distance: bodyDist, Normal: [bodyNormal[0], bodyNormal[1]] };
};

/** The active lens: a glass whose Lens is above 0 (Glass.Pipeline.glsl, GlassActiveLens). */
export const GlassIsLens = (lens: number): boolean => lens > 0;
/** A lens the walk draws as one, lifted items and all: its Lens above 0 while it is still glass. */
export const GlassIsActiveLens = (lens: number, material: MaterialType): boolean => GlassIsLens(lens) && material === 'LiquidGlass';
/** The active lens's shadow peak: Apple's pressed tab darkens what is below it 10% at the edge (MacStories light). */
export const GLASS_LENS_SHADOW_PEAK = 0.1;
/** The shadow's peak alpha: opacity (0.5 - 0.25u) times its fill (black 0.12 plus SDR 0.08 + 0.16u), or
 *  times 1 where the colored read takes over (v). Clear glass casts none. */
export const GlassShadowPeak = (span: number, clear: number, lens: boolean = false): number => {
  if (lens) return GLASS_LENS_SHADOW_PEAK;
  const { U, V } = GlassSizeRamps(span);
  const fill = 0.12 + 0.08 + 0.16 * U;
  // Clear glass casts none; a glass changing kind blends.
  return (1 - Math.min(Math.max(clear, 0), 1)) * (0.5 - 0.25 * U) * (fill + (1 - fill) * V);
};

/**
 * The pyramid a glass surface needs: built at its sharpest read (the outer sample at half radius; an active lens's
 * BackdropView, the backdrop layer's capture with no blur [C]), `BaseLod` in our LOD units, and `MaxLod` levels deep
 * for its deepest (the body at full radius; the bleed and the colored shadow on large glass), taken at a native
 * level 0 with no blur of its own, the deepest any build needs. `Reach` is how far past the face, in points, any of
 * its reads can land.
 */
export interface GlassBlurNeeds {
  BaseLod: number;
  MaxLod: number;
  ReachPt: number;
}

export const GlassBlurNeedsOf = (span: number, dpr: number, variant: GlassVariant, lens: boolean, blur: number = 0,
  frost: number = GLASS_FROST_AUTOMATIC): GlassBlurNeeds => {
  const base = lens ? GlassNativeLod(0, variant) : GlassBodyLod(span, 0.5, dpr, variant, blur, frost);
  // Glass that can adapt (`GlassAdaptOf`) reads up to `1 + GLASS_ADAPT_FROST` times its body blur.
  const adapts = !lens && span < GLASS_ADAPT_SPAN[1];
  let top = GlassBodyLod(span, adapts ? 1 + GLASS_ADAPT_FROST : 1, dpr, variant, blur, frost);
  const sigmaPt = (lod: number): number => Math.pow(2, lod) / dpr;
  // The outer sample looks 0.2 S past the outline.
  let reach = 0.2 * span + 3 * sigmaPt(base);
  const { V } = GlassSizeRamps(span);
  if (V > 0 && variant === 'Regular') {
    const bleed = GlassBleedLod(span, dpr, variant, frost);
    const shadow = GlassShadowLod(dpr, variant, frost);
    top = Math.max(top, bleed, shadow);
    reach = Math.max(reach, 0.35 * span + 3 * sigmaPt(bleed),
      2 * GlassShadowRadius(span) + GLASS_SHADOW_OFFSET_Y + GlassShadowAmount(span) + 3 * sigmaPt(shadow));
  }
  return { BaseLod: base, MaxLod: Math.max(1, Math.ceil(GlassPyramidLevel(Math.pow(2, top), 1, 0))), ReachPt: reach };
};
