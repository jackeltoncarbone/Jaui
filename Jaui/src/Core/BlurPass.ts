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

// 9 levels: covers LOD 0..8 with dual-filter quality. Progressive blur
// samples up to LOD ~6 for heavy BackdropFrostBlur settings; extra headroom
// keeps the smooth mipmap chain populated deeper than we'll typically read.
// Memory cost is negligible (each level halves the previous texel count —
// the entire mip chain at 1920×1080 is ~11MB, same as one full canvas).
const MAX_LEVELS = 9;

export class BlurPass {
  private _gl: WebGL2RenderingContext;
  private _down: ShaderProgram;
  private _up: ShaderProgram;
  private _quad: QuadGeometry;
  private _levels: Framebuffer[] = [];
  private _lastDepth: number = 0;
  /** Single FBO reused for the attach-mip-and-blit dance in
   *  GenerateOutputMipmap. Created lazily on first use. */
  private _mipBlitFbo: WebGLFramebuffer | null = null;
  get LastDepth(): number { return this._lastDepth; }

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
   *
   * `scissor` is optional: a rect in device pixels (relative to the input
   * texture's coordinate frame, y=0 at top) that limits which destination
   * pixels are written during each down/up pass. Callers that only sample
   * a small region of the final pyramid (e.g. a 500×80 glass panel on a
   * 1920×1080 canvas) can pass their sample rect here to cut fragment
   * fill rate by 10–50× for localized glass surfaces. The rect is scaled
   * to each mip level automatically. Source reads are unaffected — only
   * destination fills are limited. Pass `undefined` to fill the whole
   * pyramid (required for progressive blur's high-LOD sampling where the
   * effective sample region can span the whole canvas).
   */
  Blur = (
    input: WebGLTexture,
    width: number,
    height: number,
    radius: number,
    minDepth: number = 0,
    scissor?: { x: number; y: number; w: number; h: number },
  ): WebGLTexture => {
    const gl = this._gl;

    // Pick pyramid depth from desired sigma. Each Down/Up pair roughly
    // doubles the effective sigma, with a baseline of ~3 px per level.
    //   depth 1: σ ≈ 4   depth 2: σ ≈ 9   depth 3: σ ≈ 20   depth 4: σ ≈ 45
    // Cap at MAX_LEVELS-1 (need 1 level above input for the down chain).
    // minDepth allows callers (e.g. progressive blur) to ensure enough
    // mipmap levels exist for textureLod sampling.
    const target = Math.max(1, radius);
    const depth = Math.max(Math.max(1, minDepth), Math.min(MAX_LEVELS - 1, Math.ceil(Math.log2(target / 3 + 1))));
    this._lastDepth = depth;
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

    gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this._quad.Vao);

    // Scissor lets us only fill the destination pixels we care about. Rect
    // is in input-texture (full canvas) coordinates; clamp and halve for
    // each progressively-smaller mip level. Source reads still cover the
    // whole source texture — only destination writes are limited.
    // WebGL scissor uses y=0 at bottom; our callers pass y=0 at top (screen
    // convention), so we flip when applying.
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    const applyScissor = (dstW: number, dstH: number, levelScale: number): void => {
      if (!scissor) return;
      const sx = Math.max(0, Math.floor(scissor.x * levelScale));
      const sw = Math.min(dstW - sx, Math.ceil(scissor.w * levelScale));
      // y-flip: gl.scissor y=0 at bottom; scissor.y given as y=0 at top.
      const sy = Math.max(0, Math.floor((height * levelScale) - (scissor.y + scissor.h) * levelScale));
      const sh = Math.min(dstH - sy, Math.ceil(scissor.h * levelScale));
      gl.scissor(sx, sy, Math.max(1, sw), Math.max(1, sh));
    };

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
      applyScissor(dst.Width, dst.Height, dst.Width / width);
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
      applyScissor(dst.Width, dst.Height, dst.Width / width);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform2f(this._upHpLoc, 0.5 / srcW, 0.5 / srcH);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      srcTex = dst.Texture;
      srcW = dst.Width;
      srcH = dst.Height;
    }

    if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return this._levels[0].Texture;
  };

  /** Populate the output texture's mipmap chain with a proper Gaussian
   *  pyramid OF THE LEVEL-0 RESULT, instead of the driver's 2×2 box filter.
   *
   *  Why this matters: Blur() leaves `_levels[0]` holding a Gaussian-
   *  approximation blur at the requested σ (full resolution). The
   *  progressive-blur shader samples this texture with `textureLod` at
   *  fractional LODs, so every mip level needs to be a monotonically-
   *  wider Gaussian of the same scene. The driver's `generateMipmap`
   *  preserves high-contrast edges as discrete color blocks at mid/high
   *  LODs (visible as "stamps" in heavy progressive-blur regions), and
   *  the previous implementation here re-used the dual-filter algorithm
   *  intermediates (`_levels[1..depth]`) which are NOT proper Gaussian-
   *  pyramid levels — at depth=1 mip 1 ended up LESS blurred than mip 0
   *  (non-monotonic σ), which trilinear interpolation then visualised as
   *  the same stamps near the bottom of the ramp.
   *
   *  Algorithm: build mip levels 1..N by iterating the 5-tap DOWN kernel
   *  starting from level 0 itself. Each step is a small Gaussian
   *  downsample of the previous mip — σ adds in quadrature, so successive
   *  mips have monotonically increasing source-pixel σ. High-frequency
   *  content is already smoothed by the time we downsample, so blocks
   *  dissolve into a smooth gradient.
   *
   *  Cost: one DOWN pass per mip level (≤ 8 total) on rapidly-shrinking
   *  images + matching blits. Same order of work as the prior
   *  implementation, just with the chain rooted at level 0. */
  GenerateOutputMipmap = (maxLod?: number): void => {
    const gl = this._gl;
    const out = this._levels[0];

    // Allocate the mip chain + flip MIN_FILTER to LINEAR_MIPMAP_LINEAR so
    // textureLod can sample. We overwrite the levels we actually populate
    // below; the deepest few mips (≤ 4×4) keep the box-filter content but
    // progressive blur never samples them.
    out.GenerateMipmap();

    // Cap the chain at the consumer's max sampled LOD. Trilinear
    // interpolation between adjacent levels needs both endpoints populated,
    // so we add 1 level of slack. Without a cap (legacy callers) we walk
    // all the way to 1×1 — that matches the prior behaviour but on a
    // software rasterizer it's pure waste; passing a real maxLod here
    // typically halves this routine's fragment work.
    const stopLevel = maxLod !== undefined
      ? Math.min(MAX_LEVELS - 1, Math.max(1, Math.ceil(maxLod) + 1))
      : MAX_LEVELS - 1;

    // Iterative 5-tap DOWN starting from level 0. _levels[1..N] are
    // re-purposed as scratch FBOs — their previous contents (dual-filter
    // intermediates from the Blur() call) are no longer needed.
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this._down.Program);
    gl.uniform1i(this._downTexLoc, 0);
    gl.uniform1f(this._downOffLoc, 1.0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this._quad.Vao);

    let srcTex = out.Texture;
    let srcW = out.Width;
    let srcH = out.Height;
    let extendedDepth = 0;
    for (let i = 1; i <= stopLevel; i++) {
      const newW = Math.max(1, Math.floor(srcW / 2));
      const newH = Math.max(1, Math.floor(srcH / 2));
      if (newW === srcW && newH === srcH) break; // already at 1×1
      this._levels[i].Resize(newW, newH);
      const dst = this._levels[i];
      dst.Bind();
      gl.viewport(0, 0, newW, newH);
      gl.uniform2f(this._downHpLoc, 0.5 / srcW, 0.5 / srcH);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      srcTex = dst.Texture;
      srcW = newW;
      srcH = newH;
      extendedDepth = i;
    }

    if (extendedDepth === 0) return;

    // Blit each generated level into the corresponding mip slot of the
    // output texture.
    if (!this._mipBlitFbo) {
      const fbo = gl.createFramebuffer();
      if (!fbo) throw new Error('[Jaui] Failed to create mip-blit FBO');
      this._mipBlitFbo = fbo;
    }
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._mipBlitFbo);
    for (let i = 1; i <= extendedDepth; i++) {
      const src = this._levels[i];
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.Texture, i);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.Framebuffer);
      gl.blitFramebuffer(
        0, 0, src.Width, src.Height,
        0, 0, src.Width, src.Height,
        gl.COLOR_BUFFER_BIT, gl.NEAREST,
      );
    }
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
  };
}
