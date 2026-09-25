/**
 * HOW FAR A PYRAMID TEXEL READS THE SCENE, so a reader of a few texels of a wide pyramid can tell a
 * change that reaches them from one that cannot.
 *
 * Every pass in `BlurPass` reads its source through bilinear taps, and a tap `t` source texels from
 * the output texel's centre touches only source texel centres less than `t + 1` texels away. So a
 * texel's reach is the sum, over the passes that made it, of `(t + 1)` times that pass's source texel
 * in device px. Pure, no GL, so it is tested without the renderer.
 */
import type { BackdropRegion } from './Renderer';

/** One pass: its farthest tap in SOURCE texels, plus the bilinear footprint, in device px. */
export const HopReach = (tapTexels: number, srcTexelPx: number): number => (tapTexels + 1) * srcTexelPx;

/** `MIP_FRAG`'s taps: 0.75 source texel on each axis. */
export const MIP_TAP_TEXELS = 0.75;

/**
 * Device px past a sample position that a bilinear `textureLod` at `lod` of a pyramid over `region`
 * can depend on, through the mip hops `GenerateOutputMipmap` builds above level 0. A trilinear read
 * takes the level above `lod` too, and every level reaches at least as far as the one below it, so
 * the ceiling is the bound. A level the chain did not build clamps to one below it, which reaches
 * less. Infinity when the region does not say how level 0 was made.
 */
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
