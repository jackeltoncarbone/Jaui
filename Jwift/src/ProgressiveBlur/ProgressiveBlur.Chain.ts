import { Framebuffer } from '../Core/Framebuffer';
import type { BlurPass } from '../Core/BlurPass';
import type { BlitRenderer } from '../Core/Blit';

/**
 * A stack of Gaussian blurs at geometrically-spaced sigmas. The shader
 * picks any point along the blur axis by lerping adjacent levels —
 * continuous, genuinely progressive, and every sample is a real Gaussian
 * (not a box-filter mip downsample). GPU equivalent of Show Studio's
 * 7-layer stacked-backdrop-filter technique.
 *
 * Design notes:
 *   • Each level is a SEPARATE FBO. Mipmap chains would compress higher
 *     sigmas into tiny textures and reintroduce the pixelated look we're
 *     trying to avoid.
 *   • Levels are rendered at HALF scene resolution. Every level is
 *     already Gaussian-blurred so the high-frequency information that
 *     half-res would discard was going to be erased anyway — the shader's
 *     bilinear sample upscales with no visible quality loss. Cuts chain
 *     fill-rate ~4×, a meaningful share of the per-frame budget.
 *   • Sigmas double per step. A 4-level chain at base σ = 4 CSS px covers
 *     σ ∈ {4, 16, 64, 256} — plenty of range for any feather the eye can
 *     distinguish. Per-pixel lerp in the shader keeps everything smooth.
 *   • Rebuilt from the same sceneFbo every frame. Skip the rebuild when
 *     no consumer needs it — the Canvas call site is responsible for that.
 */

const DEFAULT_LEVELS = 4;
/** Fraction of scene resolution at which chain FBOs are built. See the
 *  header note — halving is essentially free quality-wise on pre-blurred
 *  content and cuts cost meaningfully. */
const CHAIN_SCALE = 0.5;

export class ProgressiveBlurChain {
  private _gl: WebGL2RenderingContext;
  private _levels: Framebuffer[] = [];

  constructor(gl: WebGL2RenderingContext, levels: number = DEFAULT_LEVELS) {
    this._gl = gl;
    for (let i = 0; i < levels; i++) {
      this._levels.push(new Framebuffer(gl));
    }
  }

  /** Texture for level `i`. Level 0 is the least blurred, last is the most. */
  Texture = (i: number): WebGLTexture => this._levels[i].Texture;

  get Count(): number { return this._levels.length; }

  /** Recompute every level from `sceneTex` at the given scene resolution.
   *  `maxSigmaCssPx` is the sigma held in the last (fully-blurred) level;
   *  earlier levels step down by ×½ so the 4-level chain covers
   *  [max/8, max/4, max/2, max]. `dpr` converts the CSS-px sigma into the
   *  BlurPass's device-px radius argument. BlurPass internally overwrites
   *  its output FBO on each call, so we blit after each run to copy the
   *  result into our own level-local FBO before the next Blur() call
   *  clobbers it. */
  Rebuild = (
    sceneTex: WebGLTexture,
    width: number,
    height: number,
    dpr: number,
    blur: BlurPass,
    blit: BlitRenderer,
    maxSigmaCssPx: number,
  ): void => {
    const gl = this._gl;
    const lw = Math.max(1, Math.floor(width * CHAIN_SCALE));
    const lh = Math.max(1, Math.floor(height * CHAIN_SCALE));

    // BlurPass runs at the chain's internal (half-scene) resolution —
    // quality is already Gaussian-limited, so working at lower res is free
    // visually and saves the bulk of the per-frame chain cost.
    const lastIdx = this._levels.length - 1;
    for (let i = 0; i < this._levels.length; i++) {
      const fbo = this._levels[i];
      fbo.Resize(lw, lh);

      // Scale the target sigma to match — CHAIN_SCALE shrinks the working
      // image, so the effective CSS-px sigma also scales by the same factor
      // when we pass a pixel radius. Keeping the ratio fixed preserves the
      // desired perceptual sigma.
      const sigmaCssPx = maxSigmaCssPx * Math.pow(2, i - lastIdx);
      const sigmaDevicePx = sigmaCssPx * dpr * CHAIN_SCALE;
      const blurred = blur.Blur(sceneTex, lw, lh, sigmaDevicePx);

      fbo.Bind();
      gl.viewport(0, 0, fbo.Width, fbo.Height);
      blit.Draw(blurred);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
}
