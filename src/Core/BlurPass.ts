import { ShaderCompiler, type ShaderProgram } from './Shader.Compiler';
import { QuadGeometry } from './Geometry.Quad';
import { Framebuffer } from './Framebuffer';

/**
 * Dual Filter blur (Marius Bjørge, ARM, "Bandwidth-Efficient Rendering",
 * SIGGRAPH 2015 / Khronos Munich 2015). The de-facto standard for wide,
 * smooth, fast Gaussian-equivalent blur in shipping AAA engines.
 *
 * Shape of the algorithm:
 *   Source FBO ──► [Down × N] ──► [Up × N] ──► Output FBO (= input size)
 * Each Down halves the resolution with a 5-tap kernel that approximates a
 * box average. Each Up doubles the resolution with an 8-tap kernel that
 * approximates a small Gaussian as it interpolates back up. Repeating the
 * pyramid N times widens the effective sigma exponentially while keeping
 * sample-spacing-to-sigma ratio constant — so there's none of the "oily
 * banding" you get when you just crank the radius on a single 5-tap pass.
 *
 *   N = 1: σ ≈ 5 px       (subtle frost)
 *   N = 2: σ ≈ 12 px      (regular liquid glass)
 *   N = 3: σ ≈ 28 px      (deep frost)
 *   N = 4: σ ≈ 60 px      (heavy backdrop)
 *
 * Reference: https://community.arm.com/cfs-file/__key/communityserver-blogs-components-weblogfiles/00-00-00-20-66/siggraph2015_2D00_mmg_2D00_marius_2D00_notes.pdf
 */

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_Position;
out vec2 v_Uv;
void main() {
    v_Uv = a_Position;
    gl_Position = vec4(a_Position * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Downsample: 5-tap (center + 4 corners at half-pixel offsets, all weighted)
// Reads the SOURCE half-pixel; halfpixel = (0.5/srcW, 0.5/srcH).
// This is run when rendering into a destination half the source's size.
const DOWN_FRAG = `#version 300 es
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
uniform vec2 u_HalfPixel;     // half-texel size of the SOURCE
uniform float u_Offset;       // tap distance scale (typically 1.0)
out vec4 fragColor;

void main() {
    vec2 hp = u_HalfPixel * u_Offset;
    vec3 sum = texture(u_Tex, v_Uv).rgb * 4.0;
    sum += texture(u_Tex, v_Uv - hp).rgb;
    sum += texture(u_Tex, v_Uv + hp).rgb;
    sum += texture(u_Tex, v_Uv + vec2(hp.x, -hp.y)).rgb;
    sum += texture(u_Tex, v_Uv - vec2(hp.x, -hp.y)).rgb;
    fragColor = vec4(sum / 8.0, 1.0);
}
`;

// Upsample: 8-tap "tent" kernel
const UP_FRAG = `#version 300 es
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
uniform vec2 u_HalfPixel;     // half-texel size of the SOURCE (smaller image)
uniform float u_Offset;
out vec4 fragColor;

void main() {
    vec2 hp = u_HalfPixel * u_Offset;
    vec3 sum  = texture(u_Tex, v_Uv + vec2(-hp.x * 2.0, 0.0)).rgb;
    sum += texture(u_Tex, v_Uv + vec2(-hp.x,  hp.y)).rgb * 2.0;
    sum += texture(u_Tex, v_Uv + vec2( 0.0,  hp.y * 2.0)).rgb;
    sum += texture(u_Tex, v_Uv + vec2( hp.x,  hp.y)).rgb * 2.0;
    sum += texture(u_Tex, v_Uv + vec2( hp.x * 2.0, 0.0)).rgb;
    sum += texture(u_Tex, v_Uv + vec2( hp.x, -hp.y)).rgb * 2.0;
    sum += texture(u_Tex, v_Uv + vec2( 0.0, -hp.y * 2.0)).rgb;
    sum += texture(u_Tex, v_Uv + vec2(-hp.x, -hp.y)).rgb * 2.0;
    fragColor = vec4(sum / 12.0, 1.0);
}
`;

const MAX_LEVELS = 5;

export class BlurPass {
  private _gl: WebGL2RenderingContext;
  private _down: ShaderProgram;
  private _up: ShaderProgram;
  private _quad: QuadGeometry;
  private _levels: Framebuffer[] = [];

  private _downTexLoc: WebGLUniformLocation | null;
  private _downHpLoc: WebGLUniformLocation | null;
  private _downOffLoc: WebGLUniformLocation | null;
  private _upTexLoc: WebGLUniformLocation | null;
  private _upHpLoc: WebGLUniformLocation | null;
  private _upOffLoc: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this._down = ShaderCompiler.Compile(gl, VERT, DOWN_FRAG);
    this._up = ShaderCompiler.Compile(gl, VERT, UP_FRAG);
    this._quad = new QuadGeometry(gl);

    for (let i = 0; i < MAX_LEVELS; i++) this._levels.push(new Framebuffer(gl));

    this._downTexLoc = gl.getUniformLocation(this._down.Program, 'u_Tex');
    this._downHpLoc = gl.getUniformLocation(this._down.Program, 'u_HalfPixel');
    this._downOffLoc = gl.getUniformLocation(this._down.Program, 'u_Offset');
    this._upTexLoc = gl.getUniformLocation(this._up.Program, 'u_Tex');
    this._upHpLoc = gl.getUniformLocation(this._up.Program, 'u_HalfPixel');
    this._upOffLoc = gl.getUniformLocation(this._up.Program, 'u_Offset');
  }

  /**
   * Blur `input` and return the resulting texture (level 0 of the pyramid).
   * `radius` is interpreted as approximate effective sigma in source pixels.
   * Internally it picks a pyramid depth + tap-offset that achieves it.
   */
  Blur = (input: WebGLTexture, width: number, height: number, radius: number): WebGLTexture => {
    const gl = this._gl;

    // Pick pyramid depth from desired sigma. Each Down/Up pair roughly
    // doubles the effective sigma, with a baseline of ~3 px per level.
    //   depth 1: σ ≈ 4   depth 2: σ ≈ 9   depth 3: σ ≈ 20   depth 4: σ ≈ 45
    // Cap at MAX_LEVELS-1 (need 1 level above input for the down chain).
    const target = Math.max(1, radius);
    let depth = Math.max(1, Math.min(MAX_LEVELS - 1, Math.ceil(Math.log2(target / 3 + 1))));
    // Use the per-tap offset to fine-tune within the chosen depth.
    const baseSigma = 3 * Math.pow(2, depth);
    // Keep tap-offset near 1.0 — wider offsets create the visible "oil pastel"
    // striations (tap centers drift apart faster than the overlap can cover).
    const tapOffset = Math.max(0.7, Math.min(1.3, target / baseSigma));

    // Allocate level FBOs at progressively halved sizes.
    // levels[0] is the destination at full size (where the upsample chain ends).
    // levels[1..depth] are the smaller pyramid levels.
    let w = width, h = height;
    this._levels[0].Resize(w, h);
    for (let i = 1; i <= depth; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this._levels[i].Resize(w, h);
    }

    const wasBlend = gl.isEnabled(gl.BLEND);
    if (wasBlend) gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this._quad.Vao);

    // ── Downsample chain: input → level 1 → level 2 → ... → level depth ──
    gl.useProgram(this._down.Program);
    gl.uniform1i(this._downTexLoc, 0);
    gl.uniform1f(this._downOffLoc, tapOffset);

    let srcTex = input;
    let srcW = width, srcH = height;
    for (let i = 1; i <= depth; i++) {
      const dst = this._levels[i];
      dst.Bind();
      gl.viewport(0, 0, dst.Width, dst.Height);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform2f(this._downHpLoc, 0.5 / srcW, 0.5 / srcH);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      srcTex = dst.Texture;
      srcW = dst.Width;
      srcH = dst.Height;
    }

    // ── Upsample chain: level depth → level depth-1 → ... → level 0 ──
    gl.useProgram(this._up.Program);
    gl.uniform1i(this._upTexLoc, 0);
    gl.uniform1f(this._upOffLoc, tapOffset);

    for (let i = depth - 1; i >= 0; i--) {
      const dst = this._levels[i];
      dst.Bind();
      gl.viewport(0, 0, dst.Width, dst.Height);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform2f(this._upHpLoc, 0.5 / srcW, 0.5 / srcH);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      srcTex = dst.Texture;
      srcW = dst.Width;
      srcH = dst.Height;
    }

    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (wasBlend) gl.enable(gl.BLEND);

    return this._levels[0].Texture;
  };
}
