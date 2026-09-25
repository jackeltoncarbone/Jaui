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

/** `u` ramps over S = 48..160 pt and `v` over 64..160 pt, S being the shape's minor dimension. */
export const GlassSizeRamps = (span: number): { U: number; V: number } => ({
  U: Math.max(0, Math.min(1, (span - 48) / 112)),
  V: Math.max(0, Math.min(1, (span - 64) / 96)),
});

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
  let top = GlassBodyLod(span, 1, dpr, variant, blur, frost);
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
