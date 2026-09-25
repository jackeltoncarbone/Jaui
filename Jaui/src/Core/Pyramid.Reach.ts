// How far a pyramid texel reads the scene: every BlurPass pass taps bilinearly, so a tap `t` source texels
// out touches only centres under `t + 1` texels away, and a build's reach is the sum over its passes.
import type { BackdropRegion } from './Renderer';

/** One pass: its farthest tap in SOURCE texels, plus the bilinear footprint, in device px. */
export const HopReach = (tapTexels: number, srcTexelPx: number): number => (tapTexels + 1) * srcTexelPx;

/** `MIP_FRAG`'s taps: 0.75 source texel on each axis. */
export const MIP_TAP_TEXELS = 0.75;

/** Device px a bilinear or trilinear read at `lod` of a pyramid over `region` depends on, past the sample
 *  point; the ceiling level bounds both, and an unbuilt level clamps lower. Infinity when unknown. */
export const PyramidSampleReach = (region: BackdropRegion, lod: number, canvasW: number, canvasH: number): number => {
  if (!Number.isFinite(region.Reach) || region.TexelsX <= 0 || region.TexelsY <= 0) return Infinity;
  const rw = canvasW / region.ScaleX, rh = canvasH / region.ScaleY;
  const level = Math.ceil(Math.max(0, lod));
  let reach = region.Reach;
  let lw = region.TexelsX, lh = region.TexelsY;
  for (let i = 0; i < level; i++) {
    const nw = Math.max(1, Math.floor(lw / 2)), nh = Math.max(1, Math.floor(lh / 2));
    if (nw === lw && nh === lh) break;
    reach += HopReach(MIP_TAP_TEXELS, Math.max(rw / lw, rh / lh));
    lw = nw; lh = nh;
  }
  return reach + Math.max(rw / lw, rh / lh);
};
