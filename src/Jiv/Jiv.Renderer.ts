import { ShaderCompiler, type ShaderProgram } from '../Core/Shader.Compiler';
import { QuadGeometry } from '../Core/Geometry.Quad';
import { JivInstanceBuffer } from './Jiv.InstanceBuffer';
import type { Jiv } from './Jiv';
import vertSrc from './Shaders/Jiv.Panel.vert?raw';
import fragSrc from './Shaders/Jiv.Panel.frag?raw';

const BYTES_PER_VEC4 = 16;
const BYTES_PER_INSTANCE = 128; // 32 floats * 4 bytes
const INSTANCE_ATTR_COUNT = 8;  // locations 1-8

export class JivRenderer {
  private _gl: WebGL2RenderingContext;
  private _shader: ShaderProgram;
  private _quad: QuadGeometry;
  private _instanceBuffer: JivInstanceBuffer;
  private _resolutionLoc: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this._shader = ShaderCompiler.Compile(gl, vertSrc, fragSrc);
    this._quad = new QuadGeometry(gl);
    this._instanceBuffer = new JivInstanceBuffer(gl);

    // Look up the single remaining uniform
    this._resolutionLoc = gl.getUniformLocation(this._shader.Program, 'u_Resolution');

    // Extend the quad's VAO with per-instance attribute pointers
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

  DrawAll = (canvasWidth: number, canvasHeight: number): void => {
    const count = this._instanceBuffer.Count;
    if (count === 0) return;

    const gl = this._gl;

    this._instanceBuffer.Upload();

    gl.useProgram(this._shader.Program);
    gl.uniform2f(this._resolutionLoc, canvasWidth, canvasHeight);

    gl.bindVertexArray(this._quad.Vao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);
  };
}
