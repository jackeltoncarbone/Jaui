export interface ShaderProgram {
  Program: WebGLProgram;
  Uniforms: Map<string, WebGLUniformLocation>;
  Attributes: Map<string, number>;
}

export class ShaderCompiler {

  /** Compile a vertex/fragment pair into a linked program. Optional
   *  `defines` map injects `#define NAME value` (or bare `#define NAME`
   *  when the value is `true`) after the GLSL `#version` directive — the
   *  only legal place to put them. Callers use this to generate shader
   *  variants (e.g. glass vs non-glass panel shader) from a single source
   *  file; GLSL dead-code elimination then strips the unused branches. */
  static Compile = (
    gl: WebGL2RenderingContext,
    vertSrc: string,
    fragSrc: string,
    defines?: Record<string, string | number | boolean>,
  ): ShaderProgram => {
    const injectedVert = ShaderCompiler._inject(vertSrc, defines);
    const injectedFrag = ShaderCompiler._inject(fragSrc, defines);
    const vert = ShaderCompiler._compileShader(gl, gl.VERTEX_SHADER, injectedVert);
    const frag = ShaderCompiler._compileShader(gl, gl.FRAGMENT_SHADER, injectedFrag);
    const program = ShaderCompiler._linkProgram(gl, vert, frag);

    // Clean up individual shaders — they're baked into the program now
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    const uniforms = ShaderCompiler._extractUniforms(gl, program);
    const attributes = ShaderCompiler._extractAttributes(gl, program);

    return { Program: program, Uniforms: uniforms, Attributes: attributes };
  };

  /** Insert `#define` lines right after the `#version` directive (which
   *  GLSL requires to be on the first non-blank line). Returns source
   *  unchanged when there are no defines. */
  private static _inject = (source: string, defines?: Record<string, string | number | boolean>): string => {
    if (!defines) return source;
    const lines: string[] = [];
    for (const [k, v] of Object.entries(defines)) {
      if (v === false) continue; // skip falsy flags entirely
      if (v === true) lines.push(`#define ${k}`);
      else lines.push(`#define ${k} ${v}`);
    }
    if (lines.length === 0) return source;
    // Find the end of the first `#version` line (if present) and inject after.
    const versionMatch = /^\s*#version[^\n]*\n/.exec(source);
    if (versionMatch) {
      const idx = versionMatch.index + versionMatch[0].length;
      return source.slice(0, idx) + lines.join('\n') + '\n' + source.slice(idx);
    }
    return lines.join('\n') + '\n' + source;
  };

  private static _compileShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('[Jaui] Failed to create shader');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || '';
      gl.deleteShader(shader);
      const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      throw new Error(`[Jaui] ${kind} shader compile error:\n${log}`);
    }

    return shader;
  };

  private static _linkProgram = (gl: WebGL2RenderingContext, vert: WebGLShader, frag: WebGLShader): WebGLProgram => {
    const program = gl.createProgram();
    if (!program) throw new Error('[Jaui] Failed to create program');

    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || '';
      gl.deleteProgram(program);
      throw new Error(`[Jaui] Shader link error:\n${log}`);
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
