import { ShaderCompiler, type ShaderProgram } from '../Core/Shader.Compiler';
import { QuadGeometry } from '../Core/Geometry.Quad';
import { TextInstanceBuffer, type TextDrawCommand } from './Text.InstanceBuffer';
import vertSrc from './Shaders/Text.Quad.vert.gen';
import fragSrc from './Shaders/Text.Quad.frag.gen';

export class TextRenderer {
  private _gl: WebGL2RenderingContext;
  private _shader: ShaderProgram;
  private _quad: QuadGeometry;
  private _buffer: TextInstanceBuffer;

  private _resolutionLoc: WebGLUniformLocation | null;
  private _rectLoc: WebGLUniformLocation | null;
  private _textureLoc: WebGLUniformLocation | null;
  private _opacityLoc: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this._shader = ShaderCompiler.Compile(gl, vertSrc, fragSrc);
    // Own QuadGeometry — separate VAO (no per-instance attributes, unlike Jiv renderer)
    this._quad = new QuadGeometry(gl);
    this._buffer = new TextInstanceBuffer();

    this._resolutionLoc = gl.getUniformLocation(this._shader.Program, 'u_Resolution');
    this._rectLoc = gl.getUniformLocation(this._shader.Program, 'u_Rect');
    this._textureLoc = gl.getUniformLocation(this._shader.Program, 'u_Texture');
    this._opacityLoc = gl.getUniformLocation(this._shader.Program, 'u_Opacity');
  }

  BeginFrame = (): void => {
    this._buffer.Begin();
  };

  AddText = (cmd: TextDrawCommand): void => {
    this._buffer.Push(cmd);
  };

  DrawAll = (canvasWidth: number, canvasHeight: number): void => {
    const commands = this._buffer.Commands;
    if (commands.length === 0) return;

    const gl = this._gl;
    gl.useProgram(this._shader.Program);
    gl.uniform2f(this._resolutionLoc, canvasWidth, canvasHeight);
    gl.uniform1i(this._textureLoc, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this._quad.Vao);

    for (const cmd of commands) {
      gl.uniform4f(this._rectLoc, cmd.X, cmd.Y, cmd.Width, cmd.Height);
      gl.uniform1f(this._opacityLoc, cmd.Opacity);
      gl.bindTexture(gl.TEXTURE_2D, cmd.Texture);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };
}
