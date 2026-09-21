export interface ShaderProgram {
  Program: WebGLProgram;
  Uniforms: Map<string, WebGLUniformLocation>;
  Attributes: Map<string, number>;
}

interface _Job {
  Program: WebGLProgram;
  Vert: WebGLShader;
  Frag: WebGLShader;
  Result: ShaderProgram;
}

/**
 * ShaderBatch — issue every compile and link first, ask how they went afterwards.
 *
 * WHY THIS EXISTS. `compileShader` and `linkProgram` are asynchronous in every modern driver;
 * `getShaderParameter(COMPILE_STATUS)` and `getProgramParameter(LINK_STATUS)` are the calls that
 * BLOCK until the work is finished. Compiling one program at a time — compile, ask, compile, ask,
 * link, ask — therefore runs the driver's compiler pool one program deep no matter how many cores
 * it has. Jaui builds EIGHTEEN programs before it can draw anything (seven panel variants, text,
 * stroke, two SVG, blit, clip mask, progressive blur, the adaptive-shadow probe, and the blur
 * pass's down/up/copy), so that serialisation is the whole cold-boot shader cost, in a line.
 *
 * EIGHTEEN IS THE UNFLAGGED SET, and that is the number this class is sized for. A program only a
 * `?...` arm binds is issued into a batch of its own at the moment that arm arms -- after the URL
 * is parsed and before the first tick -- so the cold-boot batch never carries a compile the page
 * was never going to use. See `WebGL2Renderer.ArmFlaggedPrograms`.
 *
 * Named source: KHR_parallel_shader_compile, which states that an implementation may compile and
 * link in parallel and that querying status forces completion — the extension exists precisely so
 * a caller can issue the whole set and only then collect. MDN's WebGL best practices give the same
 * rule as "compile shaders and link programs in parallel": do not check status until every
 * `compileShader` and `linkProgram` call has been made.
 *
 * Same programs, same sources, same defines — only the ORDER of the status queries changes. No
 * shader is simplified and nothing draws differently.
 */
export class ShaderBatch {
  private _gl: WebGL2RenderingContext;
  private _jobs: _Job[] = [];
  private _issueMs = 0;
  private _resolveMs = 0;
  private _resolved = false;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    // Requesting the extension is what tells ANGLE the caller intends to poll rather than block,
    // and is the documented signal to use the parallel compile path. We never read
    // COMPLETION_STATUS_KHR: we need all thirteen before the first frame either way, so a spin
    // that resolves them out of order buys nothing over one wait on the slowest.
    try { gl.getExtension('KHR_parallel_shader_compile'); } catch { /* core WebGL2 still works */ }
  }

  /** How many programs this batch carries. */
  get Count(): number { return this._jobs.length; }
  /** Wall time spent handing the driver the sources — the part that does not block. */
  get IssueMs(): number { return this._issueMs; }
  /** Wall time spent waiting for the driver, once, for the whole set. */
  get ResolveMs(): number { return this._resolveMs; }

  /**
   * Hand the driver a vertex/fragment pair and return the program shell. `Program` is a live
   * WebGLProgram immediately; `Uniforms` and `Attributes` stay EMPTY until `Resolve`, because
   * reading a location is one of the calls that blocks. Callers that need locations wire them
   * after `Resolve` — see `WebGL2Renderer._wire*Shader`.
   *
   * `defines` injects `#define NAME value` (or a bare `#define NAME` for `true`) after the GLSL
   * `#version` directive — the only legal place for them. Callers use this to cut variants from
   * one source (glass vs non-glass panel); GLSL dead-code elimination strips the other branch.
   */
  Add = (vertSrc: string, fragSrc: string, defines?: Record<string, string | number | boolean>): ShaderProgram => {
    if (this._resolved) throw new Error('[Jaui] ShaderBatch.Add after Resolve');
    const t0 = performance.now();
    const gl = this._gl;
    const vert = _createShader(gl, gl.VERTEX_SHADER, _inject(vertSrc, defines));
    const frag = _createShader(gl, gl.FRAGMENT_SHADER, _inject(fragSrc, defines));
    const program = gl.createProgram();
    if (!program) throw new Error('[Jaui] Failed to create program');
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    const result: ShaderProgram = { Program: program, Uniforms: new Map(), Attributes: new Map() };
    this._jobs.push({ Program: program, Vert: vert, Frag: frag, Result: result });
    this._issueMs += performance.now() - t0;
    return result;
  };

  /** Collect every program: check status, free the shader objects, fill the location maps. */
  Resolve = (): void => {
    if (this._resolved) return;
    this._resolved = true;
    const t0 = performance.now();
    const gl = this._gl;
    for (const job of this._jobs) {
      _assertCompiled(gl, job.Vert, 'vertex');
      _assertCompiled(gl, job.Frag, 'fragment');
      if (!gl.getProgramParameter(job.Program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(job.Program) || '';
        gl.deleteProgram(job.Program);
        throw new Error(`[Jaui] Shader link error:\n${log}`);
      }
      // The shaders are baked into the program now.
      gl.deleteShader(job.Vert);
      gl.deleteShader(job.Frag);
      _extractUniforms(gl, job.Program, job.Result.Uniforms);
      _extractAttributes(gl, job.Program, job.Result.Attributes);
    }
    this._resolveMs = performance.now() - t0;
  };
}

export class ShaderCompiler {

  /** Compile one vertex/fragment pair into a linked program, start to finish. The one-off form —
   *  a caller building a whole set at once should use `ShaderBatch` so the driver's compiler pool
   *  sees all of them before anyone asks how they went. */
  static Compile = (
    gl: WebGL2RenderingContext,
    vertSrc: string,
    fragSrc: string,
    defines?: Record<string, string | number | boolean>,
  ): ShaderProgram => {
    const batch = new ShaderBatch(gl);
    const program = batch.Add(vertSrc, fragSrc, defines);
    batch.Resolve();
    return program;
  };
}

/** Insert `#define` lines right after the `#version` directive (which GLSL requires to be on the
 *  first non-blank line). Returns the source unchanged when there are no defines. */
const _inject = (source: string, defines?: Record<string, string | number | boolean>): string => {
  if (!defines) return source;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(defines)) {
    if (v === false) continue; // skip falsy flags entirely
    if (v === true) lines.push(`#define ${k}`);
    else lines.push(`#define ${k} ${v}`);
  }
  if (lines.length === 0) return source;
  const versionMatch = /^\s*#version[^\n]*\n/.exec(source);
  if (versionMatch) {
    const idx = versionMatch.index + versionMatch[0].length;
    return source.slice(0, idx) + lines.join('\n') + '\n' + source.slice(idx);
  }
  return lines.join('\n') + '\n' + source;
};

/** Hand the driver a source and return. Deliberately does NOT read COMPILE_STATUS — that is the
 *  call that blocks, and `ShaderBatch.Resolve` makes it once the whole set is in flight. */
const _createShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('[Jaui] Failed to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
};

const _assertCompiled = (gl: WebGL2RenderingContext, shader: WebGLShader, kind: string): void => {
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return;
  const log = gl.getShaderInfoLog(shader) || '';
  gl.deleteShader(shader);
  throw new Error(`[Jaui] ${kind} shader compile error:\n${log}`);
};

const _extractUniforms = (gl: WebGL2RenderingContext, program: WebGLProgram, into: Map<string, WebGLUniformLocation>): void => {
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const loc = gl.getUniformLocation(program, info.name);
    if (loc) into.set(info.name, loc);
  }
};

const _extractAttributes = (gl: WebGL2RenderingContext, program: WebGLProgram, into: Map<string, number>): void => {
  const count = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveAttrib(program, i);
    if (!info) continue;
    into.set(info.name, gl.getAttribLocation(program, info.name));
  }
};
