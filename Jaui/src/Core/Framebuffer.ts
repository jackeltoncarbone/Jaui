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
  private _gl: WebGL2RenderingContext;
  private _width: number = 0;
  private _height: number = 0;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;

    const fb = gl.createFramebuffer();
    if (!fb) throw new Error('[Jaui] Failed to create framebuffer');
    this.Framebuffer = fb;

    const tex = gl.createTexture();
    if (!tex) throw new Error('[Jaui] Failed to create FBO texture');
    this.Texture = tex;
  }

  get Width(): number { return this._width; }
  get Height(): number { return this._height; }

  /** Resize the FBO's texture. Safe to call repeatedly; no-op if already at given size. */
  Resize = (width: number, height: number): void => {
    if (width === this._width && height === this._height) return;
    this._width = Math.max(1, Math.floor(width));
    this._height = Math.max(1, Math.floor(height));

    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this.Texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // Start with plain LINEAR. Caller calls GenerateMipmap() to opt into mipmap filtering.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.Framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.Texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`[Jaui] Framebuffer incomplete: 0x${status.toString(16)}`);
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
  };
}
