/**
 * Apple's Liquid Glass, the CPU half: the size laws the instance packer, the blur plan and the shadow read.
 * The fragment half is `Jiv/Shaders/Glass.Pipeline.glsl`; the two state the same constants. Every value
 * and its source is in `Core/Glass.md`.
 */

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

/** The backdrop's scale in Apple's pipeline: a quarter for regular glass, a half for clear. */
export const GlassBackdropScale = (variant: GlassVariant): number => (variant === 'Clear' ? 0.5 : 0.25);

/** BlurRadius in points: 1.33 to 4 over `u` for regular glass, 1 for clear. */
export const GlassBlurRadius = (span: number, variant: GlassVariant): number =>
  variant === 'Clear' ? 1 : 1.3333 + 2.6667 * GlassSizeRamps(span).U;

/** A radius in points to Apple's LOD on its backdrop texture: `r` in backdrop texels, then log2. */
export const GlassAppleLod = (radiusPt: number, dpr: number, variant: GlassVariant): number => {
  const r = radiusPt * GlassBackdropScale(variant) * dpr * 1.6;
  return Math.max(0, r < 2 ? Math.log2(1 + 0.5 * r) : Math.log2(r));
};

/**
 * THE MAPPING TO OUR NATIVE PYRAMID. Apple samples a quarter (clear: half) resolution texture at a mip
 * LOD; we never render below native, so we sample our own native pyramid at the LOD with the same blur.
 * Apple's level L holds texels 2^L / backdropScale device px wide; a texel reads as a Gaussian of
 * a share of its width. Our LOD n is a Gaussian of 2^n device px, so n = L + log2(share / backdropScale). The
 * shares are fitted per backdrop scale to SwiftUI's own render of the same inputs (the detail left in the body:
 * 0.62 for the quarter-scale regular backdrop, 0.28 for clear's half scale), not read from Apple.
 */
export const GLASS_TEXEL_SIGMA_REGULAR = 0.62;
export const GLASS_TEXEL_SIGMA_CLEAR = 0.28;
export const GlassNativeLod = (appleLod: number, variant: GlassVariant): number =>
  appleLod + Math.log2((variant === 'Clear' ? GLASS_TEXEL_SIGMA_CLEAR : GLASS_TEXEL_SIGMA_REGULAR) / GlassBackdropScale(variant));

/** The body's LOD at blur scale `k` (0.5 at the edge ramp's floor, 1 in the body), on our pyramid. */
export const GlassBodyLod = (span: number, k: number, dpr: number, variant: GlassVariant): number =>
  GlassNativeLod(GlassAppleLod(GlassBlurRadius(span, variant) * k, dpr, variant), variant);

/** Edge bleed: opacity over `v` (0 below 64 pt), outward shift and blur, and its LOD. Off on clear glass. */
export const GlassBleedLod = (span: number, dpr: number, variant: GlassVariant): number =>
  GlassNativeLod(GlassAppleLod(0.7 * span * 0.5, dpr, variant), variant);

/** The drop shadow: offset (0, 8) pt, reaching 2 radii; its colored read blurs at 40 pt. The radius is 24 pt
 *  on large glass (Apple's), 10 pt at 48 pt, fitted to Apple's iPhone Edit button over white (23 levels deep at
 *  the edge, gone by 18 pt), ramping over u. */
export const GLASS_SHADOW_OFFSET_Y = 8;
export const GlassShadowRadius = (span: number): number => 10 + 14 * GlassSizeRamps(span).U;
export const GLASS_SHADOW_BLUR = 40;
export const GlassShadowLod = (dpr: number, variant: GlassVariant): number =>
  GlassNativeLod(GlassAppleLod(GLASS_SHADOW_BLUR, dpr, variant), variant);
/** How far the colored shadow's read reaches outward: min(0.625 S, 75) pt. */
export const GlassShadowAmount = (span: number): number => Math.min(0.625 * span, 75);

/** The active lens: a glass whose Lens is above 0 (Glass.Pipeline.glsl, GlassActiveLens). */
export const GlassIsLens = (lens: number): boolean => lens > 0;
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
 * The pyramid a glass surface needs, in our LOD units: built at its sharpest read (the outer sample at
 * half radius; an active lens's BackdropView, the backdrop layer's capture with no blur [C]) and deep enough
 * for its deepest (the body at full radius; the bleed and the colored shadow on large glass). `Reach` is how
 * far past the face, in points, any of its reads can land.
 */
export interface GlassBlurNeeds {
  BaseLod: number;
  MaxLod: number;
  ReachPt: number;
}

export const GlassBlurNeedsOf = (span: number, dpr: number, variant: GlassVariant, lens: boolean): GlassBlurNeeds => {
  const base = lens ? GlassNativeLod(0, variant) : GlassBodyLod(span, 0.5, dpr, variant);
  let top = GlassBodyLod(span, 1, dpr, variant);
  const sigmaPt = (lod: number): number => Math.pow(2, lod) / dpr;
  // The outer sample looks 0.2 S past the outline.
  let reach = 0.2 * span + 3 * sigmaPt(base);
  const { V } = GlassSizeRamps(span);
  if (V > 0 && variant === 'Regular') {
    const bleed = GlassBleedLod(span, dpr, variant);
    const shadow = GlassShadowLod(dpr, variant);
    top = Math.max(top, bleed, shadow);
    reach = Math.max(reach, 0.35 * span + 3 * sigmaPt(bleed),
      2 * GlassShadowRadius(span) + GLASS_SHADOW_OFFSET_Y + GlassShadowAmount(span) + 3 * sigmaPt(shadow));
  }
  return { BaseLod: base, MaxLod: Math.max(1, Math.ceil(top - base)), ReachPt: reach };
};
