import { ShaderCompiler, type ShaderProgram } from './Shader.Compiler';
import { QuadGeometry } from './Geometry.Quad';

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_Position;
out vec2 v_Uv;
void main() {
    // The scene FBO was rendered with panel/text shaders that already flip Y
    // (clip.y = -clip.y) to convert device-Y=top-of-screen into clip-Y=+1.
    // That places top-of-scene at the texture's high-UV.y end. Pass UV through
    // as-is so top-of-scene → top-of-display.
    v_Uv = a_Position;
    vec2 clip = a_Position * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
out vec4 fragColor;
void main() {
    fragColor = texture(u_Tex, v_Uv);
}
`;

/**
 * Full-screen textured-quad blit. Renders a source texture onto the current framebuffer.
 * Used to copy the scene FBO to the default framebuffer.
 */
export class BlitRenderer {
  private _gl: WebGL2RenderingContext;
  private _shader: ShaderProgram;
  private _quad: QuadGeometry;
  private _texLoc: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this._shader = ShaderCompiler.Compile(gl, VERT, FRAG);
    this._quad = new QuadGeometry(gl);
    this._texLoc = gl.getUniformLocation(this._shader.Program, 'u_Tex');
  }

  Draw = (texture: WebGLTexture): void => {
    const gl = this._gl;
    gl.useProgram(this._shader.Program);
    gl.uniform1i(this._texLoc, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Disable blending for the blit (fully replace destination)
    const wasBlend = gl.isEnabled(gl.BLEND);
    if (wasBlend) gl.disable(gl.BLEND);

    gl.bindVertexArray(this._quad.Vao);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (wasBlend) gl.enable(gl.BLEND);
  };
}
