/**
 * Offscreen framebuffer with a mipmap-capable color texture.
 * Used by Canvas for the scene FBO that glass panels sample from.
 *
 * On resize, re-allocates the texture + framebuffer to the new dimensions.
 * Mipmap generation is on-demand via GenerateMipmap() — caller invokes after writes.
 */
export class Framebuffer {
  readonly Framebuffer: WebGLFramebuffer;
  readonly Texture: WebGLTexture;
  /** Optional depth+stencil renderbuffer — created when `depth: true`.
   *  Required when foreign 3D renderers (THREE) draw into this FBO. */
  readonly DepthStencil: WebGLRenderbuffer | null;
  private _gl: WebGL2RenderingContext;
  private _width: number = 0;
  private _height: number = 0;
  private _hasDepth: boolean;
  /** Store color as RGB10_A2 (10-bit, 1024 levels) instead of RGBA8. Same
   *  32 bits/texel, core WebGL2 (no extension), but 4× finer tonal steps —
   *  removes the visible banding a wide blur bakes into an 8-bit gradient. */
  private _highPrecision: boolean;

  constructor(gl: WebGL2RenderingContext, opts?: { depth?: boolean; highPrecision?: boolean }) {
    this._gl = gl;
    this._hasDepth = opts?.depth ?? false;
    this._highPrecision = opts?.highPrecision ?? false;

    const fb = gl.createFramebuffer();
    if (!fb) throw new Error('[Jaui] Failed to create framebuffer');
    this.Framebuffer = fb;

    const tex = gl.createTexture();
    if (!tex) throw new Error('[Jaui] Failed to create FBO texture');
    this.Texture = tex;

    if (this._hasDepth) {
      const rb = gl.createRenderbuffer();
      if (!rb) throw new Error('[Jaui] Failed to create depth renderbuffer');
      this.DepthStencil = rb;
    } else {
      this.DepthStencil = null;
    }
  }

  get Width(): number { return this._width; }
  get Height(): number { return this._height; }

  /** Resize the FBO's texture. Safe to call repeatedly; no-op if already at given size. */
  Resize = (width: number, height: number): void => {
    if (width === this._width && height === this._height) return;
    const firstAlloc = this._width === 0 && this._height === 0;
    this._width = Math.max(1, Math.floor(width));
    this._height = Math.max(1, Math.floor(height));

    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this.Texture);
    if (this._highPrecision) {
      // RGB10_A2: 10-bit RGB (1024 levels) + 2-bit alpha. Core WebGL2,
      // color-renderable + filterable + mipmappable. The blur only uses RGB
      // (alpha is written 1.0), so 2-bit alpha is irrelevant here.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    // Start with plain LINEAR. Caller calls GenerateMipmap() to opt into mipmap filtering.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.Framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.Texture, 0);

    if (this.DepthStencil) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.DepthStencil);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, this._width, this._height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.DepthStencil);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }

    // Validate completeness only on FIRST allocation. The attachment format never
    // changes across resizes (color + matching depth/stencil stay renderable and
    // same-sized), so a re-Resize stays complete. checkFramebufferStatus forces a
    // full GPU sync (~68ms on software ANGLE/WARP); when blur-level FBOs thrash
    // between surface sizes it fired ~8×/frame — the dominant per-frame stall
    // (measured 23.6s / 347 calls in a WARP orbit trace). Skip it on resize.
    if (firstAlloc) {
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`[Jaui] Framebuffer incomplete: 0x${status.toString(16)}`);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  /** Bind for rendering. */
  Bind = (): void => {
    this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, this.Framebuffer);
  };

  /** Generate mipmap chain for the color texture. Call after rendering into the FBO.
   *  Also flips filter to mipmap mode so subsequent samples can use textureLod. */
  GenerateMipmap = (): void => {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this.Texture);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  Dispose = (): void => {
    this._gl.deleteTexture(this.Texture);
    this._gl.deleteFramebuffer(this.Framebuffer);
    if (this.DepthStencil) this._gl.deleteRenderbuffer(this.DepthStencil);
  };
}
