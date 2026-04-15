import { ShaderCompiler, type ShaderProgram } from '../Core/Shader.Compiler';
import { QuadGeometry } from '../Core/Geometry.Quad';
import type { Jiv } from '../Jiv/Jiv';
import type { ProgressiveBlurChain } from './ProgressiveBlur.Chain';
import { PROGRESSIVE_BLUR_VERT, PROGRESSIVE_BLUR_FRAG } from './ProgressiveBlur.Shader';

/**
 * ProgressiveBlurRenderer — draws a ProgressiveBlur Jiv as a quad over the
 * composited scene. The fragment shader reads from the unblurred scene plus
 * the 4 Gaussian levels of a ProgressiveBlurChain and blends them smoothly
 * per-pixel based on position along the gradient direction.
 *
 * Not batched — usually one of these on screen. If that ever changes, fold
 * per-instance data into an instance buffer like JivRenderer.
 *
 * Expected draw order: AFTER the unblurred scene blit (Pass 3) and BEFORE
 * any glass panels (Pass 4). Glass draws on top, so a floating TabBar above
 * the feather still refracts cleanly.
 */

const DIRECTION_INDEX: Record<string, number> = {
  ToTop: 0,
  ToBottom: 1,
  ToLeft: 2,
  ToRight: 3,
};

export class ProgressiveBlurRenderer {
  private _gl: WebGL2RenderingContext;
  private _shader: ShaderProgram;
  private _quad: QuadGeometry;

  private _resolutionLoc: WebGLUniformLocation | null;
  private _rectLoc: WebGLUniformLocation | null;
  private _sceneLoc: WebGLUniformLocation | null;
  private _blurLocs: (WebGLUniformLocation | null)[] = [];
  private _directionLoc: WebGLUniformLocation | null;
  private _opacityLoc: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this._shader = ShaderCompiler.Compile(gl, PROGRESSIVE_BLUR_VERT, PROGRESSIVE_BLUR_FRAG);
    this._quad = new QuadGeometry(gl);

    const p = this._shader.Program;
    this._resolutionLoc = gl.getUniformLocation(p, 'u_Resolution');
    this._rectLoc = gl.getUniformLocation(p, 'u_Rect');
    this._sceneLoc = gl.getUniformLocation(p, 'u_Scene');
    for (let i = 0; i < 4; i++) {
      this._blurLocs.push(gl.getUniformLocation(p, `u_Blur${i}`));
    }
    this._directionLoc = gl.getUniformLocation(p, 'u_Direction');
    this._opacityLoc = gl.getUniformLocation(p, 'u_Opacity');
  }

  /** Draw one ProgressiveBlur Jiv.
   *  @param jiv          the ProgressiveBlur Jiv; rect comes from layout
   *  @param offsetX/Y    accumulated scroll offset from any scroll ancestor
   *  @param canvasWidth  device-px canvas width
   *  @param canvasHeight device-px canvas height
   *  @param dpr          device pixel ratio (Jiv dims are CSS px)
   *  @param scene        unblurred sceneFbo texture
   *  @param chain        precomputed Gaussian-blur stack (same scene, 4 sigmas)
   */
  Draw = (
    jiv: Jiv,
    offsetX: number,
    offsetY: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
    scene: WebGLTexture,
    chain: ProgressiveBlurChain,
  ): void => {
    if (jiv.Width <= 0 || jiv.Height <= 0 || !jiv.Style.Visible) return;

    const gl = this._gl;

    // Screen rect in device px, top-anchored.
    const rx = (jiv.X + offsetX) * dpr;
    const ry = (jiv.Y + offsetY) * dpr;
    const rw = jiv.Width * dpr;
    const rh = jiv.Height * dpr;

    const direction = DIRECTION_INDEX[jiv.RenderStyle.ProgressiveBlurDirection] ?? 0;

    gl.useProgram(this._shader.Program);
    gl.uniform2f(this._resolutionLoc, canvasWidth, canvasHeight);
    gl.uniform4f(this._rectLoc, rx, ry, rw, rh);
    gl.uniform1i(this._sceneLoc, 0);
    for (let i = 0; i < 4; i++) gl.uniform1i(this._blurLocs[i], i + 1);
    gl.uniform1i(this._directionLoc, direction);
    gl.uniform1f(this._opacityLoc, jiv.RenderStyle.Opacity);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene);
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i + 1);
      gl.bindTexture(gl.TEXTURE_2D, chain.Texture(i));
    }

    gl.bindVertexArray(this._quad.Vao);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);

    for (let i = 0; i <= 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  };
}
