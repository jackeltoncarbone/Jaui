import { ShaderCompiler, type ShaderProgram } from '../Core/Shader.Compiler';
import { QuadGeometry } from '../Core/Geometry.Quad';
import { TextInstanceBuffer, TEXT_FLOATS_PER_INSTANCE, type TextDrawCommand } from './Text.InstanceBuffer';
import type { TextCache } from './Text.Cache';
import vertSrc from './Shaders/Text.Quad.vert.gen';
import fragSrc from './Shaders/Text.Quad.frag.gen';

const BYTES_PER_VEC4 = 16;
const BYTES_PER_INSTANCE = TEXT_FLOATS_PER_INSTANCE * 4;
/** Instance attribute locations: 1 (a_Rect), 2 (a_UvRect), 3 (a_OpacityPad). */
const INSTANCE_ATTR_COUNT = 3;

export class TextRenderer {
  private _gl: WebGL2RenderingContext;
  private _shader: ShaderProgram;
  private _quad: QuadGeometry;
  private _buffer: TextInstanceBuffer;

  private _resolutionLoc: WebGLUniformLocation | null;
  private _atlasLoc: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this._shader = ShaderCompiler.Compile(gl, vertSrc, fragSrc);
    this._quad = new QuadGeometry(gl);
    this._buffer = new TextInstanceBuffer(gl);

    this._resolutionLoc = gl.getUniformLocation(this._shader.Program, 'u_Resolution');
    this._atlasLoc = gl.getUniformLocation(this._shader.Program, 'u_Atlas');

    // Wire instance attributes onto the quad's VAO (same pattern as JivRenderer)
    gl.bindVertexArray(this._quad.Vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer.Buffer);
    for (let loc = 1; loc <= INSTANCE_ATTR_COUNT; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, (loc - 1) * BYTES_PER_VEC4);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  BeginFrame = (): void => {
    this._buffer.Begin();
  };

  AddText = (cmd: TextDrawCommand): void => {
    this._buffer.Push(cmd);
  };

  DrawAll = (canvasWidth: number, canvasHeight: number, textCache: TextCache): void => {
    const count = this._buffer.Count;
    if (count === 0) return;

    const atlas = textCache.Atlas;
    if (!atlas) return;

    const gl = this._gl;
    this._buffer.Upload();

    gl.useProgram(this._shader.Program);
    gl.uniform2f(this._resolutionLoc, canvasWidth, canvasHeight);
    gl.uniform1i(this._atlasLoc, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas);

    gl.bindVertexArray(this._quad.Vao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };
}
