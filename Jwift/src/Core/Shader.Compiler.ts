export interface ShaderProgram {
  Program: WebGLProgram;
  Uniforms: Map<string, WebGLUniformLocation>;
  Attributes: Map<string, number>;
}

export class ShaderCompiler {

  static Compile = (gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): ShaderProgram => {
    const vert = ShaderCompiler._compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = ShaderCompiler._compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const program = ShaderCompiler._linkProgram(gl, vert, frag);

    // Clean up individual shaders — they're baked into the program now
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    const uniforms = ShaderCompiler._extractUniforms(gl, program);
    const attributes = ShaderCompiler._extractAttributes(gl, program);

    return { Program: program, Uniforms: uniforms, Attributes: attributes };
  };

  private static _compileShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('[Jwift] Failed to create shader');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || '';
      gl.deleteShader(shader);
      const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      throw new Error(`[Jwift] ${kind} shader compile error:\n${log}`);
    }

    return shader;
  };

  private static _linkProgram = (gl: WebGL2RenderingContext, vert: WebGLShader, frag: WebGLShader): WebGLProgram => {
    const program = gl.createProgram();
    if (!program) throw new Error('[Jwift] Failed to create program');

    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || '';
      gl.deleteProgram(program);
      throw new Error(`[Jwift] Shader link error:\n${log}`);
    }

    return program;
  };

  private static _extractUniforms = (gl: WebGL2RenderingContext, program: WebGLProgram): Map<string, WebGLUniformLocation> => {
    const map = new Map<string, WebGLUniformLocation>();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;

    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const loc = gl.getUniformLocation(program, info.name);
      if (loc) map.set(info.name, loc);
    }

    return map;
  };

  private static _extractAttributes = (gl: WebGL2RenderingContext, program: WebGLProgram): Map<string, number> => {
    const map = new Map<string, number>();
    const count = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;

    for (let i = 0; i < count; i++) {
      const info = gl.getActiveAttrib(program, i);
      if (!info) continue;
      map.set(info.name, gl.getAttribLocation(program, info.name));
    }

    return map;
  };
}
