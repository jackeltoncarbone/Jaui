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

/** The adaptation amount for a glass `span` pt across over a backdrop of stored spread `spread` and mean luma `mean`. */
export const GlassAdaptOf = (spread: number, mean: number, span: number, dark: boolean): number => {
  const busy = _smooth(GLASS_ADAPT_SPREAD[0], GLASS_ADAPT_SPREAD[1], spread);
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
 *  56 pt and under). */
export const GlassFaceParamsOf = (span: number, mean: number = 0.5): { Light: GlassFaceParams; Dark: GlassFaceParams } => {
  let light = GLASS_FACE_FITTED_LIGHT;
  let dark = GLASS_FACE_FITTED_DARK;
  if (span <= 56) {
    light = _mixFace(GLASS_FACE_THIN_LIGHT[0], GLASS_FACE_THIN_LIGHT[1], Math.max(0, Math.min(1, (mean - 0.45) / 0.5)));
    dark = GLASS_FACE_THIN_DARK;
  }
  const large = Math.max(0, Math.min(1, (span - GLASS_FACE_LARGE_SPAN[0]) / (GLASS_FACE_LARGE_SPAN[1] - GLASS_FACE_LARGE_SPAN[0])));
  return { Light: _mixFace(light, GLASS_FACE_APPLE_LIGHT, large), Dark: _mixFace(dark, GLASS_FACE_APPLE_DARK, large) };
};

/** Regular glass's face over the lensed read `c`, `light` its appearance 0 (dark) to 1 (light). */
export const GlassFaceOf = (c: GlassRgb, span: number, light: number, mean: number = 0.5): GlassRgb => {
  const { Light, Dark } = GlassFaceParamsOf(span, mean);
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
 */
export const GlassBodyOf = (c: GlassRgb, span: number, light: number, mean: number = 0.5): GlassRgb => {
  const face = GlassFaceOf(c, span, light, mean);
  const { V } = GlassSizeRamps(span);
  let out: GlassRgb = face;
  if (V > 0) {
    const bleed = GlassBleedOf(c, light);
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
