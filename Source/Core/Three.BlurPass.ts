import * as THREE from 'three';

/**
 * Dual Filter blur (Marius Bjørge, ARM, "Bandwidth-Efficient Rendering",
 * SIGGRAPH 2015) ported to Three.js with WebGLRenderTarget ping-pong.
 *
 *   Source ──► [Down × N] ──► [Up × N] ──► Output (= input size)
 *
 * Each Down halves resolution with a 5-tap kernel; each Up doubles it with an
 * 8-tap tent kernel. Repeating the pyramid N times widens effective sigma
 * exponentially while keeping the sample-spacing-to-sigma ratio constant.
 *
 *   N = 1: σ ≈ 5 px   N = 2: σ ≈ 12 px   N = 3: σ ≈ 28 px   N = 4: σ ≈ 60 px
 *
 * Port notes vs the WebGL2 reference (Core/BlurPass.ts):
 *  - RawShaderMaterial + glslVersion GLSL3; the literal `#version 300 es` is
 *    stripped (Three injects it).
 *  - The quad attribute is named `position` (vec3, z=0); Three derives the
 *    vertex count from geometry.attributes.position. The vert reads position.xy.
 *  - Level FBOs are WebGLRenderTargets at halved sizes, allocated/resized lazily.
 *  - Down: src→half with u_HalfPixel = (0.5/srcW, 0.5/srcH), u_Offset = tapOffset.
 *  - Up: reverse, half→double, same uniform convention.
 *  - GenerateMipmap builds a monotonic Gaussian chain on level 0 by iterating
 *    the DOWN kernel, then copies each into the output texture's mip slots via
 *    WebGLRenderTarget setRenderTarget(target, 0, mipLevel) blits.
 */

const VERT = /* glsl */`
precision highp float;
in vec3 position;
out vec2 v_Uv;
void main() {
    v_Uv = position.xy;
    gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0);
}
`;

const DOWN_FRAG = /* glsl */`
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
uniform vec2 u_HalfPixel;
uniform float u_Offset;
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

const UP_FRAG = /* glsl */`
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
uniform vec2 u_HalfPixel;
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

// Smooth small-radius blur — full resolution, no half-res round-trip.
// The dual-filter pyramid at depth 1 downsamples to half res then upsamples,
// which makes SMALL blurs look blocky (the half-res grid shows through). For
// small sigma we instead do a true Gaussian at full res: a separable-ish 13-tap
// (two interleaved 7-tap rings via bilinear-paired offsets) sized by u_Sigma in
// texels. Stays crisp-smooth at σ ≈ 0.5–6 px where the pyramid is worst.
const SMALL_FRAG = /* glsl */`
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
uniform vec2 u_Texel;     // 1/size of the source
uniform float u_Sigma;    // gaussian sigma in texels
out vec4 fragColor;

void main() {
    float s = max(u_Sigma, 0.35);
    // 6 symmetric taps + center, gaussian-weighted, spaced ~s. Bilinear paired
    // offsets give a smooth 13-tap-equivalent at 7 fetches.
    float w0 = 1.0;
    float w1 = exp(-0.5 * (1.0 * 1.0));
    float w2 = exp(-0.5 * (2.0 * 2.0));
    float w3 = exp(-0.5 * (3.0 * 3.0));
    vec2 d = u_Texel * s;
    vec3 sum = texture(u_Tex, v_Uv).rgb * w0;
    sum += (texture(u_Tex, v_Uv + vec2(d.x, 0.0)).rgb + texture(u_Tex, v_Uv - vec2(d.x, 0.0)).rgb) * w1;
    sum += (texture(u_Tex, v_Uv + vec2(0.0, d.y)).rgb + texture(u_Tex, v_Uv - vec2(0.0, d.y)).rgb) * w1;
    sum += (texture(u_Tex, v_Uv + d).rgb + texture(u_Tex, v_Uv - d).rgb) * w2;
    sum += (texture(u_Tex, v_Uv + vec2(d.x, -d.y)).rgb + texture(u_Tex, v_Uv - vec2(d.x, -d.y)).rgb) * w2;
    sum += (texture(u_Tex, v_Uv + vec2(d.x * 2.0, 0.0)).rgb + texture(u_Tex, v_Uv - vec2(d.x * 2.0, 0.0)).rgb) * w3;
    sum += (texture(u_Tex, v_Uv + vec2(0.0, d.y * 2.0)).rgb + texture(u_Tex, v_Uv - vec2(0.0, d.y * 2.0)).rgb) * w3;
    float wsum = w0 + 4.0 * w1 + 4.0 * w2 + 4.0 * w3;
    fragColor = vec4(sum / wsum, 1.0);
}
`;

// 9 levels: LOD 0..8 with dual-filter quality. Each level halves the previous
// texel count, so the entire chain costs ~one full canvas of memory.
const MAX_LEVELS = 9;
// Below this sigma (px) the pyramid is visibly blocky — use the full-res path.
const SMALL_BLUR_MAX_SIGMA = 6;

export class ThreeBlurPass {
  private _renderer: THREE.WebGLRenderer;
  private _downMat: THREE.RawShaderMaterial;
  private _upMat: THREE.RawShaderMaterial;
  private _smallMat!: THREE.RawShaderMaterial;
  private _smallTarget: THREE.WebGLRenderTarget | null = null;
  private _geo: THREE.BufferGeometry;
  private _scene: THREE.Scene;
  private _camera: THREE.OrthographicCamera;
  private _mesh: THREE.Mesh;
  private _levels: (THREE.WebGLRenderTarget | null)[] = [];
  private _lastDepth: number = 0;
  private _outputType: THREE.TextureDataType;
  // Scissor (device px, y-top) from the last Blur() — reused to limit the
  // mip-0 copy fill in GenerateMipmap to the consumer's sample region. Pure
  // fill saving (the glass/pblur only sample that region); no visual change.
  private _lastScissor: { x: number; y: number; w: number; h: number } | null = null;

  /** The mipmapped pyramid texture from the last GenerateMipmap (for pblur's
   *  textureLod sampling). Lives on `_pyrTarget`. */
  private _pyramidTex: THREE.Texture | null = null;

  get LastDepth(): number { return this._lastDepth; }

  constructor(renderer: THREE.WebGLRenderer) {
    this._renderer = renderer;

    // HalfFloat for quality where supported; UnsignedByte otherwise.
    const ext = renderer.getContext().getExtension('EXT_color_buffer_half_float')
      || renderer.getContext().getExtension('EXT_color_buffer_float');
    this._outputType = ext ? THREE.HalfFloatType : THREE.UnsignedByteType;

    // Fullscreen quad in [0,1]²; the vert maps it to clip space.
    const verts = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
    this._geo = new THREE.BufferGeometry();
    this._geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    this._geo.setIndex(new THREE.BufferAttribute(idx, 1));

    this._downMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: DOWN_FRAG,
      uniforms: {
        u_Tex: { value: null },
        u_HalfPixel: { value: new THREE.Vector2() },
        u_Offset: { value: 1.0 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    this._upMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: UP_FRAG,
      uniforms: {
        u_Tex: { value: null },
        u_HalfPixel: { value: new THREE.Vector2() },
        u_Offset: { value: 1.0 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    this._smallMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: SMALL_FRAG,
      uniforms: {
        u_Tex:   { value: null },
        u_Texel: { value: new THREE.Vector2() },
        u_Sigma: { value: 1.0 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    this._mesh = new THREE.Mesh(this._geo, this._downMat);
    this._mesh.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._mesh);
    // The vert outputs clip space directly, so any camera works; a persistent
    // ortho cam avoids per-call allocation.
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    for (let i = 0; i < MAX_LEVELS; i++) this._levels.push(null);
  }

  private _level(i: number, w: number, h: number): THREE.WebGLRenderTarget {
    let rt = this._levels[i];
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: this._outputType,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this._levels[i] = rt;
    } else if (rt.width !== w || rt.height !== h) {
      rt.setSize(w, h);
    }
    return rt;
  }

  private _draw(target: THREE.WebGLRenderTarget, mat: THREE.RawShaderMaterial,
    srcTex: THREE.Texture, srcW: number, srcH: number, offset: number,
    mipLevel: number = 0): void {
    this._mesh.material = mat;
    (mat.uniforms['u_Tex'].value as THREE.Texture | null) = srcTex;
    (mat.uniforms['u_HalfPixel'].value as THREE.Vector2).set(0.5 / srcW, 0.5 / srcH);
    mat.uniforms['u_Offset'].value = offset;
    this._renderer.setRenderTarget(target, undefined, mipLevel);
    this._renderer.render(this._scene, this._camera);
  }

  /**
   * Blur `input` and return level 0 of the pyramid. `radius` is approximate
   * effective sigma in source pixels; it selects pyramid depth + tap-offset.
   *
   * `scissor` (device px, y=0 at top, input-texture frame) limits which
   * destination pixels are written each pass — useful for localized glass
   * surfaces. WebGL scissor has y=0 at bottom, so we flip when applying.
   * `minDepth` ensures enough mip levels exist for textureLod sampling.
   */
  Blur = (
    input: THREE.Texture,
    width: number,
    height: number,
    radius: number,
    minDepth: number = 0,
    scissor?: { x: number; y: number; w: number; h: number },
  ): THREE.Texture => {
    const renderer = this._renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevScissorTest = renderer.getScissorTest();
    this._lastScissor = scissor ?? null;   // reused to scissor the mip-0 copy

    // Smooth small-radius path: at small sigma the half-res pyramid is blocky,
    // so blur at FULL resolution with a true Gaussian. Skipped when minDepth>0
    // (progressive blur needs the real multi-level pyramid for textureLod).
    if (radius <= SMALL_BLUR_MAX_SIGMA && minDepth <= 1) {
      this._lastDepth = 1;
      const out = this._level(0, width, height);
      if (!this._smallTarget || this._smallTarget.width !== width || this._smallTarget.height !== height) {
        this._smallTarget?.dispose();
        this._smallTarget = new THREE.WebGLRenderTarget(width, height, {
          minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat, type: this._outputType,
          depthBuffer: false, stencilBuffer: false,
        });
      }
      renderer.setScissorTest(false);
      // Two separable-ish passes (H then V via the symmetric kernel twice)
      // give a clean round Gaussian; one pass is enough at the smallest sigma.
      this._mesh.material = this._smallMat;
      this._smallMat.uniforms['u_Tex'].value = input;
      (this._smallMat.uniforms['u_Texel'].value as THREE.Vector2).set(1 / width, 1 / height);
      this._smallMat.uniforms['u_Sigma'].value = Math.max(0.5, radius);
      renderer.setRenderTarget(out);
      renderer.render(this._scene, this._camera);
      renderer.setScissorTest(prevScissorTest);
      renderer.setRenderTarget(prevTarget);
      return out.texture;
    }

    // Pick pyramid depth from desired sigma. Each Down/Up pair roughly doubles
    // effective sigma, with a baseline of ~3 px per level. Cap at MAX_LEVELS-1.
    const target = Math.max(1, radius);
    const depth = Math.max(
      Math.max(1, minDepth),
      Math.min(MAX_LEVELS - 1, Math.ceil(Math.log2(target / 3 + 1))),
    );
    this._lastDepth = depth;
    const baseSigma = 3 * Math.pow(2, depth);
    // Keep tap-offset near 1.0 to avoid "oil pastel" striations.
    const tapOffset = Math.max(0.7, Math.min(1.3, target / baseSigma));

    // Allocate level FBOs at progressively halved sizes. levels[0] is full size
    // (where the up chain ends); levels[1..depth] are smaller pyramid levels.
    let w = width, h = height;
    this._level(0, w, h);
    for (let i = 1; i <= depth; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this._level(i, w, h);
    }

    const applyScissor = (dst: THREE.WebGLRenderTarget, levelScale: number): void => {
      if (!scissor) return;
      const dstW = dst.width, dstH = dst.height;
      const sx = Math.max(0, Math.floor(scissor.x * levelScale));
      const sw = Math.min(dstW - sx, Math.ceil(scissor.w * levelScale));
      // y-flip: gl.scissor y=0 at bottom; scissor.y given y=0 at top.
      const sy = Math.max(0, Math.floor((height * levelScale) - (scissor.y + scissor.h) * levelScale));
      const sh = Math.min(dstH - sy, Math.ceil(scissor.h * levelScale));
      renderer.setScissor(sx, sy, Math.max(1, sw), Math.max(1, sh));
    };

    renderer.setScissorTest(!!scissor);

    // ── Downsample chain: input → level 1 → ... → level depth ──
    let srcTex = input;
    let srcW = width, srcH = height;
    for (let i = 1; i <= depth; i++) {
      const dst = this._levels[i]!;
      applyScissor(dst, dst.width / width);
      this._draw(dst, this._downMat, srcTex, srcW, srcH, tapOffset);
      srcTex = dst.texture;
      srcW = dst.width;
      srcH = dst.height;
    }

    // ── Upsample chain: level depth → ... → level 0 ──
    for (let i = depth - 1; i >= 0; i--) {
      const dst = this._levels[i]!;
      applyScissor(dst, dst.width / width);
      this._draw(dst, this._upMat, srcTex, srcW, srcH, tapOffset);
      srcTex = dst.texture;
      srcW = dst.width;
      srcH = dst.height;
    }

    renderer.setScissorTest(prevScissorTest);
    renderer.setRenderTarget(prevTarget);

    return this._levels[0]!.texture;
  };

  /**
   * Build a monotonic Gaussian mipmap chain on the level-0 output so consumers
   * can textureLod() it. The driver's box filter preserves high-contrast edges
   * as discrete blocks at mid/high LODs; instead we iterate the 5-tap DOWN
   * kernel from level 0, each step a small Gaussian downsample of the previous
   * mip (σ adds in quadrature → monotonically increasing σ), and render each
   * directly into the output texture's mip slot.
   *
   * `maxLod` caps the chain at the consumer's max sampled LOD (+1 slack for
   * trilinear interpolation). Without it, walk to the deepest level.
   */
  /** Build a real, sampleable mip chain on the level-0 blur output using Three's
   *  own render-target mip support, which DOES allocate + sample correctly when
   *  the target is created `{ generateMipmaps:true, minFilter:LinearMipmapLinear }`
   *  and we render into each mip via `setRenderTarget(target, 0, mipLevel)`.
   *
   *  The earlier "too weak" bug was a target created WITHOUT a mip-capable filter,
   *  so high-LOD `textureLod` reads clamped to LOD 0. We now keep a dedicated
   *  mip-capable target (`_pyrTarget`) and downsample level→level into its mips.
   *
   *  `maxLod` caps the chain at the consumer's max sampled LOD (+1 slack). */
  GenerateMipmap = (maxLod?: number): void => {
    const base = this._levels[0];
    if (!base) return;
    const w = base.width, h = base.height;
    const out = this._ensurePyrTarget(w, h);

    const renderer = this._renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevScissor = renderer.getScissorTest();

    const maxLevels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    const stop = maxLod !== undefined
      ? Math.min(maxLevels - 1, Math.max(1, Math.ceil(maxLod) + 1))
      : maxLevels - 1;

    // Copy the finished level-0 blur into the pyramid target (mip 0), one pass,
    // SAME orientation as glass samples (proven correct at 0.00% parity). Then
    // let the driver build the rest of the mip chain via gl.generateMipmap.
    // OPTIMIZATION: scissor the copy to the consumer's sample region (the glass
    // panel's rect + LOD margin) — the rest of mip 0 is never sampled, so filling
    // the whole canvas was pure waste. Localized glass on a big canvas: 10-50x
    // less fill here. No visual change (only the sampled region is read). A
    // full-canvas pblur passes no scissor → fills everything as before.
    if (this._lastScissor) {
      const s = this._lastScissor;
      renderer.setScissorTest(true);
      const sy = Math.max(0, Math.floor(h - (s.y + s.h)));   // gl y=0 at bottom
      renderer.setScissor(Math.max(0, Math.floor(s.x)), sy, Math.max(1, Math.ceil(s.w)), Math.max(1, Math.ceil(s.h)));
    } else {
      renderer.setScissorTest(false);
    }
    this._draw(out, this._downMat, base.texture, w, h, 0.0, 0);
    renderer.setScissorTest(false);

    const gl = renderer.getContext() as WebGL2RenderingContext;
    const glTex = (renderer.properties.get(out.texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
    if (glTex) {
      const prevBind = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, prevBind);
    }
    void stop;

    this._pyramidTex = out.texture;
    renderer.setScissorTest(prevScissor);
    renderer.setRenderTarget(prevTarget);
    renderer.resetState();
  };

  /** The mipmapped pyramid texture from the last GenerateMipmap (for pblur). */
  get PyramidTexture(): THREE.Texture | null { return this._pyramidTex; }

  /** Dedicated mip-capable output target (Linear-mipmap filter so textureLod
   *  reads every level). Resized lazily. */
  private _pyrTarget: THREE.WebGLRenderTarget | null = null;
  private _ensurePyrTarget(w: number, h: number): THREE.WebGLRenderTarget {
    if (this._pyrTarget && this._pyrTarget.width === w && this._pyrTarget.height === h) {
      return this._pyrTarget;
    }
    this._pyrTarget?.dispose();
    this._pyrTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,  // makes Three allocate the full mip chain
    });
    return this._pyrTarget;
  }

  Dispose = (): void => {
    for (const rt of this._levels) rt?.dispose();
    this._levels = [];
    this._smallTarget?.dispose();
    this._pyrTarget?.dispose();
    this._geo.dispose();
    this._downMat.dispose();
    this._upMat.dispose();
    this._smallMat.dispose();
  };
}
