import { ShaderCompiler, type ShaderProgram } from '../Core/Shader.Compiler';
import { QuadGeometry } from '../Core/Geometry.Quad';
import { GlassInstanceBuffer, GLASS_FLOATS_PER_INSTANCE } from './Glass.InstanceBuffer';
import type { Jiv } from '../Jiv/Jiv';
import vertSrc from './Shaders/Glass.Panel.vert?raw';
import fragSrc from './Shaders/Glass.Panel.frag?raw';

const BYTES_PER_VEC4 = 16;
const BYTES_PER_INSTANCE = GLASS_FLOATS_PER_INSTANCE * 4;
const INSTANCE_ATTR_COUNT = 13; // locations 1..13

export class GlassRenderer {
  private _gl: WebGL2RenderingContext;
  private _shader: ShaderProgram;
  private _quad: QuadGeometry;
  private _instanceBuffer: GlassInstanceBuffer;
  private _dummyTex: WebGLTexture;
  private _resolutionLoc: WebGLUniformLocation | null;
  private _backdropLoc: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this._shader = ShaderCompiler.Compile(gl, vertSrc, fragSrc);
    this._quad = new QuadGeometry(gl);
    this._instanceBuffer = new GlassInstanceBuffer(gl);

    // 1x1 black texture as placeholder — bound when no real backdrop is supplied
    // (e.g. during Pass 1, when we're rendering INTO the scene FBO and can't
    // also sample from it — that would be a GL feedback loop and cause undefined
    // rendering, including the flipped/missing-panel artifacts we saw).
    const dummy = gl.createTexture();
    if (!dummy) throw new Error('[Jwift] failed to create placeholder texture');
    this._dummyTex = dummy;
    gl.bindTexture(gl.TEXTURE_2D, this._dummyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._resolutionLoc = gl.getUniformLocation(this._shader.Program, 'u_Resolution');
    this._backdropLoc = gl.getUniformLocation(this._shader.Program, 'u_Backdrop');

    // Wire instance attributes onto the quad's VAO
    gl.bindVertexArray(this._quad.Vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer.Buffer);
    for (let loc = 1; loc <= INSTANCE_ATTR_COUNT; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, (loc - 1) * BYTES_PER_VEC4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  BeginFrame = (): void => {
    this._instanceBuffer.Begin();
  };

  AddInstance = (jiv: Jiv, dpr: number): void => {
    this._instanceBuffer.Push(jiv, dpr);
  };

  get Count(): number { return this._instanceBuffer.Count; }

  /** Pass `null` for `backdropTexture` when rendering INTO the scene FBO (Pass 1) —
   *  the renderer will bind a safe 1x1 placeholder instead, avoiding a GL feedback
   *  loop. Shader branches on Material so non-glass Jivs never read the sample anyway. */
  DrawAll = (canvasWidth: number, canvasHeight: number, backdropTexture: WebGLTexture | null): void => {
    const count = this._instanceBuffer.Count;
    if (count === 0) return;

    const gl = this._gl;
    this._instanceBuffer.Upload();

    gl.useProgram(this._shader.Program);
    gl.uniform2f(this._resolutionLoc, canvasWidth, canvasHeight);
    gl.uniform1i(this._backdropLoc, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backdropTexture ?? this._dummyTex);

    gl.bindVertexArray(this._quad.Vao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };
}
