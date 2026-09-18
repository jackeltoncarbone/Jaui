import { ShaderCompiler, type ShaderProgram } from './Shader.Compiler';
import { QuadGeometry } from './Geometry.Quad';
import { Framebuffer } from './Framebuffer';
import { BACKDROP_REGION_FULL, type BackdropRegion } from './Renderer';

/**
 * Dual Filter blur (Marius Bjørge, ARM, "Bandwidth-Efficient Rendering",
 * SIGGRAPH 2015 / Khronos Munich 2015). The de-facto standard for wide,
 * smooth, fast Gaussian-equivalent blur in shipping AAA engines.
 *
 * Shape of the algorithm:
 *   Source FBO ──► [Down × N] ──► [Up × N] ──► Output FBO (= region size)
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

// Every pass draws the same unit quad over its WHOLE destination. `u_SrcRect` says which
// part of the SOURCE that destination stands for: (x, y, w, h) in source UV, GL's
// bottom-origin y. (0, 0, 1, 1) is the whole source — and is exact, because `0.0 + a * 1.0`
// is `a` bit-for-bit in IEEE754, so a full-source pass interpolates the identical varying it
// always did. The mapping is done HERE and interpolated rather than recomputed per fragment
// so its float rounding has the same character as the varying it replaces.
const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_Position;
uniform vec4 u_SrcRect;
out vec2 v_Uv;
void main() {
    v_Uv = u_SrcRect.xy + a_Position * u_SrcRect.zw;
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

// 1-tap passthrough copy. Used to seed mip 0 with the RAW scene (σ=0) for the
// progressive-blur "true continuum" path: GenerateOutputMipmap then builds the
// Gaussian stack from a sharp root, so sampling a continuous LOD ramps clear →
// heavy with no sharp/blurred crossfade and no separate scene texture.
const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
out vec4 fragColor;
void main() {
    fragColor = vec4(texture(u_Tex, v_Uv).rgb, 1.0);
}
`;

// 9 levels: covers LOD 0..8 with dual-filter quality. Progressive blur
// samples up to LOD ~6 for heavy BackdropFrostBlur settings; extra headroom
// keeps the smooth mipmap chain populated deeper than we'll typically read.
const MAX_LEVELS = 9;

/** Keep ≥ this much σ in base space for the σ-adaptive downsample (k ≤ σ/4 ≪ σ/2 → invisible). */
const BASE_SIGMA = 4;
const K_MAX = 8;

/** The part of the input a pyramid is built over, in input texels. `YBottom` counts from the
 *  BOTTOM (GL's convention) because that is the axis every pass and every consumer works in. */
interface RegionRect {
  X: number;
  YBottom: number;
  W: number;
  H: number;
  /** True when the region is the whole input — the pyramid is canvas-sized and every source
   *  rect is the identity, so the passes are bit-for-bit what they always were. */
  Full: boolean;
}

export class BlurPass {
  private _gl: WebGL2RenderingContext;
  private _down: ShaderProgram;
  private _up: ShaderProgram;
  private _copy: ShaderProgram;
  private _quad: QuadGeometry;
  private _levels: Framebuffer[] = [];
  private _lastDepth: number = 0;
  /** Single FBO reused for the attach-mip-and-blit dance in
   *  GenerateOutputMipmap. Created lazily on first use. */
  private _mipBlitFbo: WebGLFramebuffer | null = null;
  /** Ping-pong scratch FBOs for the σ-adaptive base downsample (band-limit
   *  optimization). Created lazily the first time a large blur downsamples. */
  private _preA: Framebuffer | null = null;
  private _preB: Framebuffer | null = null;
  /** Where the last pyramid's texels sit on screen. Consumers read it off the returned
   *  texture handle and map their screen UV through it before sampling. */
  private _lastRegion: BackdropRegion = BACKDROP_REGION_FULL;
  get LastDepth(): number { return this._lastDepth; }
  get LastRegion(): BackdropRegion { return this._lastRegion; }

  private _downTexLoc: WebGLUniformLocation | null;
  private _downHpLoc: WebGLUniformLocation | null;
  private _downOffLoc: WebGLUniformLocation | null;
  private _downSrcLoc: WebGLUniformLocation | null;
  private _upTexLoc: WebGLUniformLocation | null;
  private _upHpLoc: WebGLUniformLocation | null;
  private _upOffLoc: WebGLUniformLocation | null;
  private _upSrcLoc: WebGLUniformLocation | null;
  private _copyTexLoc: WebGLUniformLocation | null;
  private _copySrcLoc: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this._down = ShaderCompiler.Compile(gl, VERT, DOWN_FRAG);
    this._up = ShaderCompiler.Compile(gl, VERT, UP_FRAG);
    this._copy = ShaderCompiler.Compile(gl, VERT, COPY_FRAG);
    this._quad = new QuadGeometry(gl);

    // 10-bit pyramid levels: a wide blur produces a very smooth gradient
    // that 8-bit (256 levels) quantizes into visible bands BEFORE the
    // consumer shaders ever sample it. RGB10_A2 (1024 levels, same 32
    // bits/texel) stores the gradient finely enough that the bands vanish;
    // the consumers' output dither then handles the final 8-bit canvas write.
    for (let i = 0; i < MAX_LEVELS; i++) this._levels.push(new Framebuffer(gl, { highPrecision: true }));

    this._downTexLoc = gl.getUniformLocation(this._down.Program, 'u_Tex');
    this._downHpLoc = gl.getUniformLocation(this._down.Program, 'u_HalfPixel');
    this._downOffLoc = gl.getUniformLocation(this._down.Program, 'u_Offset');
    this._downSrcLoc = gl.getUniformLocation(this._down.Program, 'u_SrcRect');
    this._upTexLoc = gl.getUniformLocation(this._up.Program, 'u_Tex');
    this._upHpLoc = gl.getUniformLocation(this._up.Program, 'u_HalfPixel');
    this._upOffLoc = gl.getUniformLocation(this._up.Program, 'u_Offset');
    this._upSrcLoc = gl.getUniformLocation(this._up.Program, 'u_SrcRect');
    this._copyTexLoc = gl.getUniformLocation(this._copy.Program, 'u_Tex');
    this._copySrcLoc = gl.getUniformLocation(this._copy.Program, 'u_SrcRect');
  }

  /**
   * Blur `input` and return the resulting texture (level 0 of the pyramid).
   * `radius` is interpreted as approximate effective sigma in source pixels.
   * Internally it picks a pyramid depth + tap-offset that achieves it.
   *
   * `region` is optional: the rect of the input the caller will sample, in input-texture
   * device px with y=0 at TOP. The pyramid is ALLOCATED TO IT — level 0 comes back
   * `region`-sized, holding the same texels at the same device density, and `LastRegion`
   * carries the affine map from screen UV into it.
   *
   * That is the whole point of the parameter. A glass card is a 562x430 patch of a
   * 2560x1600 canvas; a canvas-sized level 0 is a 16.4MB attachment, and on a tile-based
   * GPU every render pass that touches it pays a full load AND store, because Metal has no
   * partial render area — a scissored draw still resolves the whole thing. Sizing the
   * attachment to the patch is the difference between ~84MB and ~37MB of attachment traffic
   * per glass surface, forty times a frame.
   *
   * Omit `region` for a pyramid over the whole input (the shared backdrop). Then every pass
   * is bit-for-bit what it always was.
   */
  Blur = (
    input: WebGLTexture,
    width: number,
    height: number,
    radius: number,
    minDepth: number = 0,
    region?: { x: number; y: number; w: number; h: number },
  ): WebGLTexture => {
    const gl = this._gl;

    // The σ-adaptive factor and the pyramid depth both have to be known BEFORE the region is
    // resolved: together they set the downsample grid the region's origin must land on.
    const k = this._baseDownsampleFactor(radius, width, height, region);
    const depth = radius > 0 ? this._pyramidDepth(radius / k, minDepth) : 0;
    const rect = this._resolveRegion(region, width, height, k * (1 << depth));
    // Computed from the ORIGINAL canvas units: Scale and Offset are ratios, so they survive
    // the σ-adaptive re-base below untouched — a coarser level 0 still covers the same rect.
    const scaleX = width / rect.W, scaleY = height / rect.H;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this._quad.Vao);

    // Sharp-root mode (radius ≤ 0): seed mip 0 with the RAW input (σ=0) via a
    // 1-tap copy, skipping the dual-filter pre-blur. The caller then builds the
    // Gaussian mip stack (GenerateOutputMipmap) from this sharp root, so the
    // progressive-blur shader's continuous LOD ramps from truly clear → heavy
    // with no sharp/blurred crossfade. Also cheaper than the dual filter: one pass.
    if (radius <= 0) {
      this._levels[0].Resize(rect.W, rect.H);
      this._bindTarget(this._levels[0]);
      gl.useProgram(this._copy.Program);
      gl.uniform1i(this._copyTexLoc, 0);
      this._setSrcRect(this._copySrcLoc, rect, width, height);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._lastDepth = 0;
      this._lastRegion = this._region(rect, scaleX, scaleY);
      return this._levels[0].Texture;
    }

    // ── σ-adaptive base downsample (band-limit optimization) ──────────────
    // A blur of σ pixels destroys every detail finer than ~σ px. So running
    // the whole pyramid on a backdrop pre-downsampled by k ≈ σ/4 throws away
    // ONLY information the blur was about to erase — pixel-faithful output —
    // while cutting fragment fill ~k×. This makes a heavy full-screen modal
    // blur cost roughly the same as a light one instead of scaling with σ.
    //
    // Guarded to LARGE-area blurs (full-screen modals/scrims); see
    // _baseDownsampleFactor for the gate and why it is measured against the canvas.
    let srcTex = input;
    let srcW = width, srcH = height;
    let srcRect: RegionRect = rect;
    if (k > 1) {
      if (!this._preA) this._preA = new Framebuffer(gl, { highPrecision: true });
      if (!this._preB) this._preB = new Framebuffer(gl, { highPrecision: true });
      const pp = [this._preA, this._preB];
      gl.useProgram(this._down.Program);
      gl.uniform1i(this._downTexLoc, 0);
      gl.uniform1f(this._downOffLoc, 1.0);
      let curW = rect.W, curH = rect.H;
      const passes = Math.round(Math.log2(k));
      for (let s = 0; s < passes; s++) {
        curW = Math.max(1, Math.floor(curW / 2));
        curH = Math.max(1, Math.floor(curH / 2));
        const fb = pp[s % 2];
        fb.Resize(curW, curH);
        this._bindTarget(fb);
        // Only the FIRST pre-pass reads the canvas-sized input, so only it carries the
        // region's source rect; from there the chain reads whole region-sized levels.
        this._setSrcRect(this._downSrcLoc, s === 0 ? rect : null, srcW, srcH);
        gl.uniform2f(this._downHpLoc, 0.5 / srcW, 0.5 / srcH);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        srcTex = fb.Texture; srcW = curW; srcH = curH;
      }
      // Re-base the pyramid onto the downsampled backdrop. The consumer samples level 0 +
      // its mips through `LastRegion`, which is a UV map — the lower resolution changes how
      // many texels back it, not which part of the screen they stand for.
      radius = radius / k;
      srcRect = { X: 0, YBottom: 0, W: srcW, H: srcH, Full: true };
    }

    this._lastDepth = depth;
    // Use the per-tap offset to fine-tune within the chosen depth.
    const baseSigma = 3 * Math.pow(2, depth);
    // Keep tap-offset near 1.0 — wider offsets create the visible "oil pastel"
    // striations (tap centers drift apart faster than the overlap can cover).
    const tapOffset = Math.max(0.7, Math.min(1.3, Math.max(1, radius) / baseSigma));

    // Allocate level FBOs at progressively halved sizes. levels[0] is the destination at
    // REGION size (where the upsample chain ends); levels[1..depth] are the smaller ones.
    let w = srcRect.W, h = srcRect.H;
    this._levels[0].Resize(w, h);
    for (let i = 1; i <= depth; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this._levels[i].Resize(w, h);
    }

    // ── Downsample chain: input → level 1 → level 2 → ... → level depth ──
    gl.useProgram(this._down.Program);
    gl.uniform1i(this._downTexLoc, 0);
    gl.uniform1f(this._downOffLoc, tapOffset);

    for (let i = 1; i <= depth; i++) {
      const dst = this._levels[i];
      this._bindTarget(dst);
      // Again: only the first hop reads the canvas-sized input through the region rect.
      this._setSrcRect(this._downSrcLoc, i === 1 ? srcRect : null, srcW, srcH);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      // The tap offset is HALF A SOURCE TEXEL either way — `u_HalfPixel` is normalized
      // against the source's own size, so it is the same half-texel it was when level 0
      // covered the canvas. The region changes the rect, never the kernel.
      gl.uniform2f(this._downHpLoc, 0.5 / srcW, 0.5 / srcH);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      srcTex = dst.Texture;
      srcW = dst.Width;
      srcH = dst.Height;
    }

    // ── Upsample chain: level depth → level depth-1 → ... → level 0 ──
    // Every hop reads a region-sized level, so the source rect is the identity throughout.
    gl.useProgram(this._up.Program);
    gl.uniform1i(this._upTexLoc, 0);
    gl.uniform1f(this._upOffLoc, tapOffset);
    this._setSrcRect(this._upSrcLoc, null, 1, 1);

    for (let i = depth - 1; i >= 0; i--) {
      const dst = this._levels[i];
      this._bindTarget(dst);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform2f(this._upHpLoc, 0.5 / srcW, 0.5 / srcH);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      srcTex = dst.Texture;
      srcW = dst.Width;
      srcH = dst.Height;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._lastRegion = this._region(rect, scaleX, scaleY);

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
   *  Cost: one DOWN pass per mip level on rapidly-shrinking images + matching
   *  blits. Every level is the REGION's, not the canvas's, so there is no rect to
   *  track and no guard band to erode — the whole level is valid because the whole
   *  level was written. A consumer whose deepest sample is LOD 0 (`maxLod <= 0`)
   *  gets no chain at all — see the first branch. */
  GenerateOutputMipmap = (maxLod?: number): void => {
    const gl = this._gl;
    const out = this._levels[0];

    // A consumer whose deepest sample is LOD 0 reads the base level and nothing
    // else. Building a chain for it is not a cheap chain, it is an entire chain
    // nobody opens: on the glass path the pyramid is built AT the panel's own
    // frost sigma, so `frostLod - u_BaseFrostLod` is 0 and the shader's whole
    // rim/refraction LOD boost is multiplied by a `frostReq` of 0
    // (Jiv.Panel.frag, `lodBoost`). Make the texture complete at the base level
    // and return — same pixels, none of the passes.
    if (maxLod !== undefined && maxLod <= 0) {
      out.DisableMipmap();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }

    // Cap the chain at the consumer's max sampled LOD. Trilinear
    // interpolation between adjacent levels needs both endpoints populated,
    // so we add 1 level of slack. Without a cap (legacy callers) we walk
    // all the way to 1×1 — that matches the prior behaviour but on a
    // software rasterizer it's pure waste; passing a real maxLod here
    // typically halves this routine's fragment work.
    const stopLevel = maxLod !== undefined
      ? Math.min(MAX_LEVELS - 1, Math.max(1, Math.ceil(maxLod) + 1))
      : MAX_LEVELS - 1;

    // Allocate the mip chain + flip MIN_FILTER to LINEAR_MIPMAP_LINEAR so
    // textureLod can sample. Storage ONLY: every level a consumer can reach is
    // written by the DOWN chain below, so `generateMipmap`'s box filter was a
    // canvas-third of fill thrown away on the next line, and TEXTURE_MAX_LEVEL
    // clamps a sampler that reaches past what we build (it used to land on the
    // box-filtered deep mips instead).
    out.EnsureMipLevels(stopLevel);

    // Iterative 5-tap DOWN starting from level 0. _levels[1..N] are
    // re-purposed as scratch FBOs — their previous contents (dual-filter
    // intermediates from the Blur() call) are no longer needed.
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this._down.Program);
    gl.uniform1i(this._downTexLoc, 0);
    gl.uniform1f(this._downOffLoc, 1.0);
    this._setSrcRect(this._downSrcLoc, null, 1, 1);
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
      this._bindTarget(dst);
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

  // ── Region plumbing ───────────────────────────────────────────────────────

  /** Bind a level and tell the driver its previous contents are dead.
   *
   *  Every pass now covers its WHOLE destination, which is the other half of why the region
   *  matters: a tile-based GPU has to LOAD an attachment it might only partly overwrite, and
   *  `invalidateFramebuffer` is how WebGL2 says "don't" (ANGLE turns it into Metal's
   *  LoadAction.DontCare). ARM's bandwidth guidance names this as the cheapest win available
   *  on a deferred renderer. Safe here precisely because the viewport is the full level and
   *  the quad covers all of it. */
  private _bindTarget = (fb: Framebuffer): void => {
    const gl = this._gl;
    fb.Bind();
    gl.viewport(0, 0, fb.Width, fb.Height);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
  };

  /** `null` rect = read the whole source. The identity (0,0,1,1) reproduces the varying the
   *  vertex shader used to interpolate exactly, so a full-source pass is unchanged. */
  private _setSrcRect = (
    loc: WebGLUniformLocation | null, rect: RegionRect | null, srcW: number, srcH: number,
  ): void => {
    if (rect === null || rect.Full) { this._gl.uniform4f(loc, 0, 0, 1, 1); return; }
    this._gl.uniform4f(loc, rect.X / srcW, rect.YBottom / srcH, rect.W / srcW, rect.H / srcH);
  };

  private _region = (rect: RegionRect, scaleX: number, scaleY: number): BackdropRegion => {
    const texels = this._levels[0];
    if (rect.Full) {
      return { ...BACKDROP_REGION_FULL, TexelsX: texels.Width, TexelsY: texels.Height };
    }
    return {
      ScaleX: scaleX,
      ScaleY: scaleY,
      OffsetX: -rect.X / rect.W,
      OffsetY: -rect.YBottom / rect.H,
      TexelsX: texels.Width,
      TexelsY: texels.Height,
    };
  };

  /** How far the σ-adaptive base downsample may shrink the backdrop before the pyramid runs.
   *  Unchanged in substance: only a blur over a BIG fraction of the canvas re-bases, because
   *  that is where the fill saving is real and the sample margins are ample. The area is
   *  still measured against the CANVAS — a region-sized pyramid must not read as "100% of the
   *  area" and start re-basing every little glass card, which would drop its device density. */
  private _baseDownsampleFactor = (
    radius: number, width: number, height: number,
    region?: { x: number; y: number; w: number; h: number },
  ): number => {
    if (radius <= BASE_SIGMA) return 1;
    const fullArea = width * height;
    const area = region ? region.w * region.h : fullArea;
    if (area < 0.15 * fullArea) return 1;
    return Math.min(K_MAX, 1 << Math.floor(Math.log2(radius / BASE_SIGMA)));
  };

  /** Pick pyramid depth from desired sigma. Each Down/Up pair roughly doubles the effective
   *  sigma, with a baseline of ~3 px per level:
   *    depth 1: σ ≈ 4   depth 2: σ ≈ 9   depth 3: σ ≈ 20   depth 4: σ ≈ 45
   *  Capped at MAX_LEVELS-1 (need 1 level above the input for the down chain). `minDepth`
   *  lets callers guarantee enough levels exist for textureLod sampling. */
  private _pyramidDepth = (radius: number, minDepth: number): number => {
    const target = Math.max(1, radius);
    return Math.max(Math.max(1, minDepth), Math.min(MAX_LEVELS - 1, Math.ceil(Math.log2(target / 3 + 1))));
  };

  /** Turn the caller's sample rect into the rect the pyramid is actually built over.
   *
   *  ORIGIN snaps DOWN to the downsample grid (`phase` = the σ-adaptive factor times 2^depth).
   *  Level i of the chain averages source texels [origin + j·2^i, …]; putting the origin on a
   *  multiple of 2^depth makes every level a texel-exact SUB-GRID of the canvas-sized pyramid
   *  this used to build. Same texels averaged together, same phase — a CROP, not a resample.
   *  An unaligned origin would pair different neighbours at every level and move real pixels.
   *
   *  EXTENT rounds UP to the same grid and clamps to the input, so the result always CONTAINS
   *  the caller's rect and every halving in the chain is exact.
   *
   *  Snapping to `phase` rather than to some coarser bucket is also what keeps the level FBOs
   *  from thrashing between surfaces: anything laid out on a regular pitch shares `x mod phase`,
   *  so a grid of equal cards resolves to ONE extent and re-allocates nothing after the first
   *  frame. (glass-grid's twenty cards sit on a 236pt pitch — 472 device px at DPR 2, a multiple
   *  of the depth-2 phase of 4 — so every one of them lands on exactly 568x436.) A page whose
   *  glass surfaces genuinely differ in size pays one `Resize` per distinct size per frame, which
   *  is a texture allocation against 47MB of attachment traffic saved. */
  private _resolveRegion = (
    region: { x: number; y: number; w: number; h: number } | undefined,
    width: number, height: number, phase: number,
  ): RegionRect => {
    if (!region) return { X: 0, YBottom: 0, W: width, H: height, Full: true };
    const rx = Math.max(0, Math.min(width - 1, Math.floor(region.x)));
    const ry = Math.max(0, Math.min(height - 1, Math.floor(region.y)));
    const rw = Math.max(1, Math.min(width - rx, Math.ceil(region.w)));
    const rh = Math.max(1, Math.min(height - ry, Math.ceil(region.h)));
    const ryb = height - (ry + rh);

    const x0 = Math.floor(rx / phase) * phase;
    const y0 = Math.floor(ryb / phase) * phase;
    const w = Math.min(width - x0, Math.ceil((rx + rw - x0) / phase) * phase);
    const h = Math.min(height - y0, Math.ceil((ryb + rh - y0) / phase) * phase);
    const full = x0 === 0 && y0 === 0 && w === width && h === height;
    return { X: x0, YBottom: y0, W: w, H: h, Full: full };
  };
}
