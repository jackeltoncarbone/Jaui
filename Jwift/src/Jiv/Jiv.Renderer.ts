import { ShaderCompiler, type ShaderProgram } from '../Core/Shader.Compiler';
import { QuadGeometry } from '../Core/Geometry.Quad';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE } from './Jiv.InstanceBuffer';
import type { Jiv } from './Jiv';
import vertSrc from './Shaders/Jiv.Panel.vert.gen';
import fragSrc from './Shaders/Jiv.Panel.frag.gen';

const BYTES_PER_VEC4 = 16;
const BYTES_PER_INSTANCE = JIV_FLOATS_PER_INSTANCE * 4;
const INSTANCE_ATTR_COUNT = 15; // locations 1..15

/**
 * Single unified Jiv panel renderer. Every Jiv flows through here regardless
 * of its Material — the shader branches on `materialType` to decide whether
 * to sample the backdrop, apply refraction/specular/etc., or draw a flat fill.
 *
 * Glass is just a styling preset (LiquidGlass, SolidGlass) that turns the
 * material parameters up. The renderer doesn't know about "Glass" as a thing.
 */
export class JivRenderer {
  private _gl: WebGL2RenderingContext;
  private _shader: ShaderProgram;
  private _quad: QuadGeometry;
  private _instanceBuffer: JivInstanceBuffer;
  private _dummyTex: WebGLTexture;
  private _resolutionLoc: WebGLUniformLocation | null;
  private _backdropLoc: WebGLUniformLocation | null;
  private _baseFrostLodLoc: WebGLUniformLocation | null;
  private _specTiltLoc: WebGLUniformLocation | null;
  /** Specular tilt offset — added to lightDir ONLY for the specular/rim-spec
   *  computations, not for ambient/edge-light/border directionality. Canvas
   *  sets this per-frame from pointer or gyroscope (simulates Apple's
   *  device-rotation-driven catchlight without moving the "sun" itself). */
  SpecularTiltX: number = 0;
  SpecularTiltY: number = 0;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this._shader = ShaderCompiler.Compile(gl, vertSrc, fragSrc);
    this._quad = new QuadGeometry(gl);
    this._instanceBuffer = new JivInstanceBuffer(gl);

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
    this._baseFrostLodLoc = gl.getUniformLocation(this._shader.Program, 'u_BaseFrostLod');
    this._specTiltLoc = gl.getUniformLocation(this._shader.Program, 'u_SpecularTilt');

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

  AddInstance = (jiv: Jiv, dpr: number, offsetX: number = 0, offsetY: number = 0): void => {
    this._instanceBuffer.Push(jiv, dpr, offsetX, offsetY);
  };

  get Count(): number { return this._instanceBuffer.Count; }

  /** Pass `null` for `backdrop` when rendering INTO the scene FBO (Pass 1) —
   *  the renderer binds a safe 1x1 placeholder instead, avoiding a GL feedback
   *  loop. Shader branches on Material so non-glass Jivs never read the sample.
   *
   *  `backdrop` is the dual-filter pyramid output (with mipmaps). `baseFrostLod`
   *  is log2 of the pyramid's base sigma (device px). Per-Jiv mipmap LOD =
   *  `frostLod - baseFrostLod`, giving one clean Gaussian sample per fragment. */
  DrawAll = (
    canvasWidth: number,
    canvasHeight: number,
    backdrop: WebGLTexture | null,
    baseFrostLod: number,
  ): void => {
    const count = this._instanceBuffer.Count;
    if (count === 0) return;

    const gl = this._gl;
    this._instanceBuffer.Upload();

    gl.useProgram(this._shader.Program);
    gl.uniform2f(this._resolutionLoc, canvasWidth, canvasHeight);
    gl.uniform1i(this._backdropLoc, 0);
    gl.uniform1f(this._baseFrostLodLoc, baseFrostLod);
    gl.uniform2f(this._specTiltLoc, this.SpecularTiltX, this.SpecularTiltY);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backdrop ?? this._dummyTex);

    gl.bindVertexArray(this._quad.Vao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
  };
}
