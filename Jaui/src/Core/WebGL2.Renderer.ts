/**
 * WebGL2 implementation of the Renderer interface.
 *
 * Wraps the original WebGL2 rendering subsystems (ShaderCompiler, Framebuffer,
 * BlurPass, Blit, Geometry.Quad) into the Renderer interface so Jaui.ts can
 * use it as a drop-in alternative to WebGPURenderer. This is the default
 * backend — works on every browser, every GPU, every driver.
 */

import type { Renderer, GpuTextureHandle, ProgressiveBlurParams, BgPaint } from './Renderer';
import { ShaderCompiler, type ShaderProgram } from './Shader.Compiler';
import { Framebuffer } from './Framebuffer';
import { BlurPass } from './BlurPass';
import { QuadGeometry } from './Geometry.Quad';
import { PROGRESSIVE_BLUR_VERT, PROGRESSIVE_BLUR_FRAG } from '../ProgressiveBlur/ProgressiveBlur.Shader';

import panelVertSrc from '../Jiv/Shaders/Jiv.Panel.vert.gen';
import panelFragSrc from '../Jiv/Shaders/Jiv.Panel.frag.gen';
import textVertSrc from '../Text/Shaders/Text.Quad.vert.gen';
import textFragSrc from '../Text/Shaders/Text.Quad.frag.gen';
import strokeVertSrc from '../Jline/Shaders/Jline.vert.gen';
import strokeFragSrc from '../Jline/Shaders/Jline.frag.gen';
import type { StrokeStyle } from './Renderer';

// ─── Jline (stroke) uniform-location bundle ─────────────────────────────────
interface _StrokeLocs {
  resolution:  WebGLUniformLocation | null;
  progress:    WebGLUniformLocation | null;
  halfW:       WebGLUniformLocation | null;
  headR:       WebGLUniformLocation | null;
  blur:        WebGLUniformLocation | null;
  blurFloor:   WebGLUniformLocation | null;
  blurSharp:   WebGLUniformLocation | null;
  ahead:       WebGLUniformLocation | null;
  behind:      WebGLUniformLocation | null;
  windowUnit:  WebGLUniformLocation | null;
  headA:       WebGLUniformLocation | null;
  floorA:      WebGLUniformLocation | null;
  headFade:    WebGLUniformLocation | null;
  trailMinA:   WebGLUniformLocation | null;
  spread:      WebGLUniformLocation | null;
  showPrior:   WebGLUniformLocation | null;
  priorScale:  WebGLUniformLocation | null;
  fwdA:        WebGLUniformLocation | null;
  fwdB:        WebGLUniformLocation | null;
  prior:       WebGLUniformLocation | null;
  collision:   WebGLUniformLocation | null;
}

const _extractStrokeLocs = (gl: WebGL2RenderingContext, p: WebGLProgram): _StrokeLocs => ({
  resolution: gl.getUniformLocation(p, 'u_Resolution'),
  progress:   gl.getUniformLocation(p, 'u_Progress'),
  halfW:      gl.getUniformLocation(p, 'u_HalfW'),
  headR:      gl.getUniformLocation(p, 'u_HeadR'),
  blur:       gl.getUniformLocation(p, 'u_Blur'),
  blurFloor:  gl.getUniformLocation(p, 'u_BlurFloor'),
  blurSharp:  gl.getUniformLocation(p, 'u_BlurSharp'),
  ahead:      gl.getUniformLocation(p, 'u_Ahead'),
  behind:     gl.getUniformLocation(p, 'u_Behind'),
  windowUnit: gl.getUniformLocation(p, 'u_WindowUnit'),
  headA:      gl.getUniformLocation(p, 'u_HeadA'),
  floorA:     gl.getUniformLocation(p, 'u_FloorA'),
  headFade:   gl.getUniformLocation(p, 'u_HeadFade'),
  trailMinA:  gl.getUniformLocation(p, 'u_TrailMinA'),
  spread:     gl.getUniformLocation(p, 'u_Spread'),
  showPrior:  gl.getUniformLocation(p, 'u_ShowPrior'),
  priorScale: gl.getUniformLocation(p, 'u_PriorScale'),
  fwdA:       gl.getUniformLocation(p, 'u_FwdA'),
  fwdB:       gl.getUniformLocation(p, 'u_FwdB'),
  prior:      gl.getUniformLocation(p, 'u_Prior'),
  collision:  gl.getUniformLocation(p, 'u_CollisionColor'),
});

// ─── Panel-shader uniform-location bundle ───────────────────────────────────
// Holds the per-program uniform locations for the panel shader. We compile
// two variants (glass + non-glass), each produces its own set of locations
// even though the uniform names match. Bundling keeps the draw path's
// variant-swap a one-liner rather than a ladder of conditionals.
interface _PanelLocs {
  resolution:   WebGLUniformLocation | null;
  backdrop:     WebGLUniformLocation | null;
  scene:        WebGLUniformLocation | null;
  baseFrostLod: WebGLUniformLocation | null;
  specTilt:     WebGLUniformLocation | null;
  clipTex:      WebGLUniformLocation | null;
  xformTex:     WebGLUniformLocation | null;
  // ── Background paint (Color | Image | LinearGradient | RadialGradient) ──
  bgMode:           WebGLUniformLocation | null;
  bgTexture:        WebGLUniformLocation | null;
  bgUv:             WebGLUniformLocation | null;
  bgImageAlpha:     WebGLUniformLocation | null;
  bgGradParams:     WebGLUniformLocation | null;
  bgGradStopCount:  WebGLUniformLocation | null;
  bgGradColor:      WebGLUniformLocation | null;
  bgGradPos:        WebGLUniformLocation | null;
}

const _extractPanelLocs = (gl: WebGL2RenderingContext, p: WebGLProgram): _PanelLocs => ({
  resolution:   gl.getUniformLocation(p, 'u_Resolution'),
  backdrop:     gl.getUniformLocation(p, 'u_Backdrop'),
  scene:        gl.getUniformLocation(p, 'u_Scene'),
  baseFrostLod: gl.getUniformLocation(p, 'u_BaseFrostLod'),
  specTilt:     gl.getUniformLocation(p, 'u_SpecularTilt'),
  clipTex:      gl.getUniformLocation(p, 'u_ClipTex'),
  xformTex:     gl.getUniformLocation(p, 'u_XformTex'),
  bgMode:           gl.getUniformLocation(p, 'u_BgMode'),
  bgTexture:        gl.getUniformLocation(p, 'u_BgTexture'),
  bgUv:             gl.getUniformLocation(p, 'u_BgUv'),
  bgImageAlpha:     gl.getUniformLocation(p, 'u_BgImageAlpha'),
  bgGradParams:     gl.getUniformLocation(p, 'u_BgGradParams'),
  bgGradStopCount:  gl.getUniformLocation(p, 'u_BgGradStopCount'),
  // Uniform arrays: GLSL exposes one location for the whole array via the
  // base name; `uniform1fv`/`uniform4fv` updates all elements from a
  // contiguous Float32Array.
  bgGradColor:      gl.getUniformLocation(p, 'u_BgGradColor[0]'),
  bgGradPos:        gl.getUniformLocation(p, 'u_BgGradPos[0]'),
});

const _MAX_BG_GRAD_STOPS = 8;
const _BG_GRAD_COLOR_SCRATCH = new Float32Array(_MAX_BG_GRAD_STOPS * 4);
const _BG_GRAD_POS_SCRATCH   = new Float32Array(_MAX_BG_GRAD_STOPS);
const _BG_UV_IDENTITY = [1, 1, 0, 0];

// ─── Opaque handle wrapping ─────────────────────────────────────────────────

interface WrappedGlTexture extends GpuTextureHandle {
  readonly _glTex: WebGLTexture;
}

const _wrap = (tex: WebGLTexture): GpuTextureHandle =>
  ({ _brand: 'GpuTextureHandle', _glTex: tex } as unknown as GpuTextureHandle);
const _unwrap = (handle: GpuTextureHandle): WebGLTexture =>
  (handle as unknown as WrappedGlTexture)._glTex;

// ─── Constants ──────────────────────────────────────────────────────────────

const PANEL_FLOATS_PER_INSTANCE = 60;
const PANEL_BYTES_PER_INSTANCE = PANEL_FLOATS_PER_INSTANCE * 4;
const PANEL_ATTR_COUNT = 15; // locations 1..15 — clip_meta is packed into a_Outline.zw
const BYTES_PER_VEC4 = 16;

const TEXT_FLOATS_PER_INSTANCE = 20;
const TEXT_BYTES_PER_INSTANCE = TEXT_FLOATS_PER_INSTANCE * 4;
const TEXT_ATTR_COUNT = 5; // locations 1..5 — Rect / UvRect / OpacityClip / Tint / Rot

const STROKE_FLOATS_PER_INSTANCE = 12;            // a_Seg(4) + a_Miter(4) + a_Arc(4)
const STROKE_BYTES_PER_INSTANCE = STROKE_FLOATS_PER_INSTANCE * 4;
const STROKE_ATTR_COUNT = 3; // locations 1..3 — Seg / Miter / Arc

/** Clip-stack texture: RGBA32F, one row. Each clip = 2 texels
 *  (rect.xyzw, radii.xyzw). Sized so at least 1024 clips fit initially. */
const CLIP_TEX_MIN_WIDTH = 2048;  // 512 clips × 2 texels

// ── Janvas clip-mask shader ─────────────────────────────────────────────────
// Post-pass clip for a janvas. The unit quad is stretched to the full janvas
// rect (u_DrawRect) — every pixel the foreign renderer could have written —
// and the fragment uses a rounded-rect SDF against the parent's clip shape
// (u_ClipRect + u_Radius) to discard pixels INSIDE the clip and paint
// transparent pixels OUTSIDE. This clips both rounded corners AND any janvas
// content that extends past the clipping ancestor's rect.
const CLIP_MASK_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_Position;
uniform vec4 u_DrawRect;      // quad extent — the janvas rect, device px
uniform vec2 u_Resolution;    // canvas size in device px
void main() {
    vec2 px = u_DrawRect.xy + a_Position * u_DrawRect.zw;
    vec2 clip = (px / u_Resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const CLIP_MASK_FRAG = `#version 300 es
precision highp float;
uniform vec4 u_ClipRect;      // clip shape — parent's rect, device px
uniform float u_Radius;       // device px (uniform across corners)
uniform float u_Smoothness;   // 0 = circle corners, 1 = sharp squircle
uniform vec2 u_Resolution;    // canvas size in device px
out vec4 fragColor;
void main() {
    vec2 p = vec2(gl_FragCoord.x, u_Resolution.y - gl_FragCoord.y);
    vec2 center = u_ClipRect.xy + 0.5 * u_ClipRect.zw;
    vec2 halfSize = 0.5 * u_ClipRect.zw;
    float r = min(u_Radius, min(halfSize.x, halfSize.y));
    vec2 qAbs = abs(p - center);
    vec2 cornerP = qAbs - (halfSize - vec2(r));
    float sd;
    // Superellipse-corner SDF — mirrors clipShapeDistance in Jiv.Panel.frag
    // so the visual mask matches the in-shader clip stack (Apple-style
    // squircle when smoothness > 0, pure circle at smoothness 0).
    if (r <= 0.0 || cornerP.x <= 0.0 || cornerP.y <= 0.0) {
        sd = max(qAbs.x - halfSize.x, qAbs.y - halfSize.y);
    } else {
        float n = 2.0 + 6.0 * clamp(u_Smoothness, 0.0, 1.0);
        float L = pow(cornerP.x / r, n) + pow(cornerP.y / r, n);
        sd = r * (pow(max(L, 0.0), 1.0 / n) - 1.0);
    }
    if (sd <= 0.0) discard;
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
}
`;

const BLIT_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_Position;
out vec2 v_Uv;
void main() {
    v_Uv = a_Position;
    vec2 clip = a_Position * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
out vec4 fragColor;
void main() {
    fragColor = texture(u_Tex, v_Uv);
}
`;

// ─── WebGL2 Renderer ────────────────────────────────────────────────────────

export class WebGL2Renderer implements Renderer {
  private _gl!: WebGL2RenderingContext;

  /** Raw WebGL2 context — exposed so foreign renderers (e.g., a Janvas-backed
   *  THREE.js scene) can share Jaui's GL device. Returns null until Init has
   *  resolved a context. WebGL2-only escape hatch; the abstract `Renderer`
   *  interface intentionally hides this so non-WebGL backends don't have to
   *  implement it. */
  GetGL = (): WebGL2RenderingContext | null => this._gl ?? null;

  /** Raw scene FBO handle — exposed so <janvas> can hand it to a foreign
   *  renderer that needs to draw into Jaui's offscreen target (e.g. THREE
   *  via WebGLRenderTarget with __webglFramebuffer override). */
  GetSceneFramebuffer = (): WebGLFramebuffer | null => this._sceneFbo?.Framebuffer ?? null;

  /** Drop the cached GL state Jaui tracks to skip redundant calls
   *  (`_lastProgram` etc.). Called after a foreign renderer (Janvas) ran
   *  in our context — its `useProgram`/etc. invalidated our cache so the
   *  next Jaui draw must re-issue every state set. */
  InvalidateStateCache = (): void => {
    this._lastProgram = null;
  };

  // Geometry
  private _quad!: QuadGeometry;

  // Render targets
  private _sceneFbo!: Framebuffer;
  private _blur!: BlurPass;
  /** Dedicated blur pass for the shared backdrop pyramid (`?wkr-shared-backdrop`).
   *  Separate buffers from `_blur` so the per-surface pblur / glass-border blurs
   *  can't clobber the once-per-frame shared pyramid that many glass surfaces
   *  sample. Lazily created on first use. */
  private _sharedBlur: BlurPass | null = null;

  // Panel shader
  // Two compiled variants of the panel shader. `MATERIAL_GLASS` constant-
  // folds in the glass program → DCE strips the `else` branches for ~60%
  // of non-glass fragments on Home, the `MATERIAL_NONE` variant strips
  // the glass branches for the batched non-glass panel draws. Uniform
  // layout is identical, so a single `_panelUniformLocs` dict works when
  // populated with locations from whichever program is currently bound.
  private _panelShaderGlass!: ShaderProgram;
  private _panelShaderNone!: ShaderProgram;
  // Uniform location bundles per variant — each program has its own
  // location IDs even when the uniform names match.
  private _panelLocsGlass!: _PanelLocs;
  private _panelLocsNone!: _PanelLocs;
  private _panelVao!: WebGLVertexArrayObject;
  private _panelInstanceBuffer!: WebGLBuffer;
  private _panelInstanceData = new Float32Array(0);
  private _panelInstanceCount = 0;
  // (moved to _panelLocsGlass / _panelLocsNone bundles)
  private _dummyTex!: WebGLTexture;

  // Text shader
  private _textShader!: ShaderProgram;
  private _textVao!: WebGLVertexArrayObject;
  private _textInstanceBuffer!: WebGLBuffer;
  private _textInstanceData = new Float32Array(0);
  private _textInstanceCount = 0;
  private _textResolutionLoc!: WebGLUniformLocation | null;
  private _textAtlasLoc!: WebGLUniformLocation | null;

  // Jline (stroke) shader — instanced per segment
  private _strokeShader!: ShaderProgram;
  private _strokeLocs!: _StrokeLocs;
  private _strokeVao!: WebGLVertexArrayObject;
  private _strokeInstanceBuffer!: WebGLBuffer;
  private _strokeInstanceData = new Float32Array(0);
  private _strokeInstanceCount = 0;

  // Blit shader
  private _blitShader!: ShaderProgram;
  private _blitTexLoc!: WebGLUniformLocation | null;

  // Progressive blur shader
  private _progBlurShader!: ShaderProgram;
  private _progBlurLocs!: {
    resolution: WebGLUniformLocation | null;
    rect: WebGLUniformLocation | null;
    rot: WebGLUniformLocation | null;
    scene: WebGLUniformLocation | null;
    pyramid: WebGLUniformLocation | null;
    maxLod: WebGLUniformLocation | null;
    direction: WebGLUniformLocation | null;
    feather: WebGLUniformLocation | null;
    easing: WebGLUniformLocation | null;
    opacity: WebGLUniformLocation | null;
    background: WebGLUniformLocation | null;
    grading: WebGLUniformLocation | null;
    clipTex: WebGLUniformLocation | null;
    clipMeta: WebGLUniformLocation | null;
    hasStops: WebGLUniformLocation | null;
    stopCount: WebGLUniformLocation | null;
    stopPos: WebGLUniformLocation | null;
    stopVal: WebGLUniformLocation | null;
    stopEase: WebGLUniformLocation | null;
  };

  // Clip-stack texture (RGBA32F row buffer indexed by texelFetch)
  private _clipTex!: WebGLTexture;
  private _clipTexWidth: number = CLIP_TEX_MIN_WIDTH;
  private _clipLastFloatsUploaded: number = 0;
  // (panel clip-tex loc moved into _panelLocsGlass / _panelLocsNone)
  private _textClipTexLoc!: WebGLUniformLocation | null;
  private _textXformTexLoc!: WebGLUniformLocation | null;

  // Shared 3D-transform texture (RGBA32F row; 3 texels per homography entry,
  // indexed by texelFetch in the panel/text vertex shaders).
  private _xformTex!: WebGLTexture;
  private _xformTexWidth: number = 64;

  private _width: number = 0;
  private _height: number = 0;

  // ── GPU timer-query state ──
  // EXT_disjoint_timer_query_webgl2 surfaces per-draw/per-frame elapsed
  // nanoseconds from the GPU itself. Results resolve async — typically
  // 2-3 frames later — so we keep a ring of in-flight queries and pick
  // the most recent resolved one. Null `_timerExt` means the extension
  // isn't available (Safari, some ANGLE drivers) and GetFrameGpuMs()
  // returns null forever on that device.
  private _timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private _timerQueries: (WebGLQuery | null)[] = [];
  private _timerFrameIdx: number = 0;
  private _timerActive: WebGLQuery | null = null;
  private _lastGpuMs: number | null = null;

  // ── GL state cache (C4) ──
  // Skip the JS→GL crossing when the requested state equals the last state
  // we set. Driver-side this is already a no-op for identical values, but
  // the JS call still has fixed overhead (argument marshaling, validation).
  // Caching here shaves ~5-15 GL calls per frame on Home.
  private _lastProgram: WebGLProgram | null = null;

  // ── Lifecycle ──

  Init = async (canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> => {
    // Cast the result: with the union canvas type, TS widens getContext's
    // return to the disjunction of every possible context type. The
    // 'webgl2' string literal selects WebGL2RenderingContext at runtime
    // — assert that here so downstream calls type-check cleanly.
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('[Jaui] WebGL2 not supported');
    this._gl = gl;

    this._quad = new QuadGeometry(gl);
    // depth: true so foreign 3D renderers (THREE) can z-test against it
    // when they draw into Jaui's scene FBO via <janvas>.
    // highPrecision (RGB10_A2): the blur samples this FBO as its INPUT, so an
    // 8-bit scene pre-bands gentle gradients (the 3D field behind the hero)
    // BEFORE blurring — and a wide blur can't dissolve plateaus wider than
    // its kernel, so the contours survive no matter the output precision.
    // 10-bit RGB (1024 levels, same 32 bpp) feeds the blur a band-free
    // gradient. NOTE: this trades alpha to 2-bit — fine for an opaque scene
    // (the canvas fills its background); revisit if alpha precision matters.
    this._sceneFbo = new Framebuffer(gl, { depth: true, highPrecision: true });
    this._blur = new BlurPass(gl);

    // Probe for GPU timer-query support. The extension object exposes the
    // two enums we need; if it's missing, _timerExt stays null and
    // GetFrameGpuMs permanently returns null on this device.
    const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (timerExt) {
      this._timerExt = timerExt;
    }

    this._initPanelShader(gl);
    this._initTextShader(gl);
    this._initStrokeShader(gl);
    this._initBlitShader(gl);
    this._initClipMaskShader(gl);
    this._initProgBlurShader(gl);

    // 1x1 black placeholder texture
    const dummy = gl.createTexture();
    if (!dummy) throw new Error('[Jaui] failed to create placeholder texture');
    this._dummyTex = dummy;
    gl.bindTexture(gl.TEXTURE_2D, dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Clip-stack texture — RGBA32F, one row. Each clip occupies 2 texels
    // (rect, radii). Sampled via texelFetch in the fragment shaders.
    // EXT_color_buffer_float is only required for rendering TO float textures;
    // sampling from them is core WebGL2.
    const clipTex = gl.createTexture();
    if (!clipTex) throw new Error('[Jaui] failed to create clip texture');
    this._clipTex = clipTex;
    gl.bindTexture(gl.TEXTURE_2D, clipTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this._clipTexWidth, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Shared 3D-transform texture — RGBA32F, one row, 3 texels per homography.
    const xformTex = gl.createTexture();
    if (!xformTex) throw new Error('[Jaui] failed to create xform texture');
    this._xformTex = xformTex;
    gl.bindTexture(gl.TEXTURE_2D, xformTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this._xformTexWidth, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  /** Upload the 3D-homography table (shared by panel + text draws). The table
   *  holds only projective instances, so it's tiny — we re-upload the whole
   *  thing each call (no cross-frame staleness, entries are 12 floats = 3 whole
   *  texels). A 2D-only frame uploads nothing. */
  SetXformBuffer = (data: Float32Array, floatCount: number): void => {
    if (floatCount === 0) return;
    const gl = this._gl;
    const texels = Math.ceil(floatCount / 4);
    if (texels > this._xformTexWidth) {
      let w = this._xformTexWidth * 2;
      while (w < texels) w *= 2;
      this._xformTexWidth = w;
      gl.bindTexture(gl.TEXTURE_2D, this._xformTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, 1, 0, gl.RGBA, gl.FLOAT, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, this._xformTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, texels, 1, gl.RGBA, gl.FLOAT, data.subarray(0, texels * 4));
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  SetClipBuffer = (data: Float32Array, floatCount: number): void => {
    const gl = this._gl;
    // Grow texture if the incoming data needs more texels than we have.
    const texelsNeeded = Math.ceil(floatCount / 4);
    if (texelsNeeded > this._clipTexWidth) {
      let w = this._clipTexWidth * 2;
      while (w < texelsNeeded) w *= 2;
      this._clipTexWidth = w;
      gl.bindTexture(gl.TEXTURE_2D, this._clipTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, 1, 0, gl.RGBA, gl.FLOAT, null);
      this._clipLastFloatsUploaded = 0;
    }
    // Skip upload when no growth since the last call (same frame, re-issued).
    if (floatCount <= this._clipLastFloatsUploaded) return;

    // Upload the grown tail only — pad the sub-upload to a whole texel so
    // texSubImage2D gets aligned RGBA data.
    const startTexel = Math.floor(this._clipLastFloatsUploaded / 4);
    const endTexel = Math.ceil(floatCount / 4);
    const subWidth = endTexel - startTexel;
    const subBuf = new Float32Array(subWidth * 4);
    const srcStart = startTexel * 4;
    for (let i = 0; i < subWidth * 4 && srcStart + i < floatCount; i++) {
      subBuf[i] = data[srcStart + i];
    }
    gl.bindTexture(gl.TEXTURE_2D, this._clipTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, startTexel, 0, subWidth, 1, gl.RGBA, gl.FLOAT, subBuf);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._clipLastFloatsUploaded = floatCount;
  };

  Destroy = (): void => {
    // WebGL context is garbage-collected with the canvas
  };

  Resize = (width: number, height: number, _dpr: number): void => {
    this._width = width;
    this._height = height;
    this._sceneFbo.Resize(width, height);
  };

  // ── Per-Frame ──

  BeginFrame = (): void => {
    this._clipLastFloatsUploaded = 0;
    // Start a fresh GPU timer query for this frame. If the extension
    // isn't available or query creation fails silently, _timerActive stays
    // null and EndFrame / GetFrameGpuMs become no-ops.
    const ext = this._timerExt;
    if (ext) {
      const gl = this._gl;
      const q = gl.createQuery();
      if (q) {
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        this._timerActive = q;
      }
    }
  };
  EndFrame = (): void => {
    const ext = this._timerExt;
    const q = this._timerActive;
    if (!ext || !q) return;
    const gl = this._gl;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    // Park this query in a ring slot for GetFrameGpuMs to poll later.
    // Delete any stale query still sitting in this slot (its result would
    // now be 3+ frames old — discard rather than let it accumulate).
    const slot = this._timerFrameIdx;
    const prev = this._timerQueries[slot];
    if (prev) gl.deleteQuery(prev);
    this._timerQueries[slot] = q;
    this._timerFrameIdx = (slot + 1) % 4; // 4 in-flight is plenty
    this._timerActive = null;
  };

  GetFrameGpuMs = (): number | null => {
    const ext = this._timerExt;
    if (!ext) return null;
    const gl = this._gl;
    // Poll all parked queries. Harvest the most-recent resolved one as the
    // "current" reading; delete resolved queries so the slot can be reused.
    // A disjoint event (power-state change, GPU reset) invalidates every
    // in-flight query — drop `_lastGpuMs` to null so the HUD shows "—".
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      for (let i = 0; i < this._timerQueries.length; i++) {
        const q = this._timerQueries[i];
        if (q) { gl.deleteQuery(q); this._timerQueries[i] = null; }
      }
      this._lastGpuMs = null;
      return null;
    }
    for (let i = 0; i < this._timerQueries.length; i++) {
      const q = this._timerQueries[i];
      if (!q) continue;
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        this._lastGpuMs = ns / 1_000_000;
        gl.deleteQuery(q);
        this._timerQueries[i] = null;
      }
    }
    return this._lastGpuMs;
  };

  // ── Render Targets ──

  get SceneTexture(): GpuTextureHandle { return _wrap(this._sceneFbo.Texture); }
  /** The raw scene-FBO `WebGLTexture`. For headless render-to-texture consumers that bind the scene output
   *  into a foreign pipeline on the SAME GL context (e.g. THREE sampling it as a material map via
   *  `ExternalTexture`) — they need the underlying GL handle, not the wrapped `GpuTextureHandle`. */
  get SceneGLTexture(): WebGLTexture { return this._sceneFbo.Texture; }
  /** The raw scene-FBO `WebGLFramebuffer`. Lets a headless host composite foreign passes (THREE, another
   *  Jaui renderer) ON TOP of this Canvas's rendered scene, into the same target, before sampling
   *  `SceneGLTexture`. Used during the turf migration to layer the not-yet-ported dynamic content. */
  get SceneFramebuffer(): WebGLFramebuffer { return this._sceneFbo.Framebuffer; }
  get BlurPyramidTexture(): GpuTextureHandle {
    // BlurPass stores its output internally — the last Blur() call's result
    // is in levels[0].Texture. We don't expose it directly; it's accessed
    // via the return value of ComputeBlur.
    throw new Error('[Jaui WebGL2] Access blur output via ComputeBlur return value');
  }

  // ── Scene Pass ──

  BeginScenePass = (clearR: number, clearG: number, clearB: number): void => {
    const gl = this._gl;
    this._sceneFbo.Bind();
    gl.viewport(0, 0, this._width, this._height);
    gl.clearColor(clearR, clearG, clearB, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  };

  EndScenePass = (): void => {
    // No explicit end needed — next FBO bind or bindFramebuffer(null) handles it
  };

  // ── Panel Rendering ──

  PanelBeginBatch = (): void => { this._panelInstanceCount = 0; };

  PanelAddInstance = (data: Float32Array, offset: number, count: number): void => {
    const needed = this._panelInstanceCount * PANEL_FLOATS_PER_INSTANCE + count;
    if (needed > this._panelInstanceData.length) {
      const newCap = Math.max(needed, this._panelInstanceData.length * 2, 64 * PANEL_FLOATS_PER_INSTANCE);
      const newData = new Float32Array(newCap);
      newData.set(this._panelInstanceData);
      this._panelInstanceData = newData;
    }
    this._panelInstanceData.set(
      data.subarray(offset, offset + count),
      this._panelInstanceCount * PANEL_FLOATS_PER_INSTANCE,
    );
    this._panelInstanceCount += count / PANEL_FLOATS_PER_INSTANCE;
  };

  PanelDrawBatch = (
    canvasWidth: number, canvasHeight: number,
    backdrop: GpuTextureHandle | null, baseFrostLod: number,
    specTiltX: number, specTiltY: number,
    useGlassShader: boolean = backdrop !== null,
    scene: GpuTextureHandle | null = null,
    bgPaint?: BgPaint,
  ): void => {
    if (this._panelInstanceCount === 0) return;
    const gl = this._gl;

    // Upload instance data
    gl.bindBuffer(gl.ARRAY_BUFFER, this._panelInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
      this._panelInstanceData.subarray(0, this._panelInstanceCount * PANEL_FLOATS_PER_INSTANCE),
      gl.DYNAMIC_DRAW);

    // Pick the shader variant. Glass panels constant-fold materialType=1.
    // Flat panels — batched OR drawn standalone with a backdrop filter
    // (BackdropBrightness/Saturation/Contrast/FrostBlur) — both use the
    // MATERIAL_NONE variant. Its shader still includes the `hasBackdropFilter`
    // branch, which samples the bound pyramid when any filter is active and
    // falls through to plain tint-fill otherwise.
    const isGlass = useGlassShader;
    const program = isGlass ? this._panelShaderGlass : this._panelShaderNone;
    const locs    = isGlass ? this._panelLocsGlass   : this._panelLocsNone;

    this._useProgram(program.Program);
    gl.uniform2f(locs.resolution, canvasWidth, canvasHeight);
    gl.uniform1i(locs.backdrop, 0);
    gl.uniform1i(locs.clipTex, 1);
    gl.uniform1i(locs.scene, 2);
    gl.uniform1f(locs.baseFrostLod, baseFrostLod);
    gl.uniform2f(locs.specTilt, specTiltX, specTiltY);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backdrop ? _unwrap(backdrop) : this._dummyTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._clipTex);
    gl.activeTexture(gl.TEXTURE2);
    // Raw scene snapshot — used by the shader's sampleBackdrop() when the
    // effective LOD is 0 (no-frost, no rim boost), so we don't pick up the
    // pyramid's baked-in 1px base Gaussian on plain-brightness filters.
    gl.bindTexture(gl.TEXTURE_2D, scene ? _unwrap(scene) : this._dummyTex);

    // ── Background paint (Color | Image | LinearGradient | RadialGradient) ──
    // Tex unit 3 is reserved for the background image texture; bound to a
    // dummy when bgPaint is undefined or non-Image so the sampler is always
    // a valid 2D texture (sampling an unbound unit is undefined in WebGL2).
    gl.uniform1i(locs.bgTexture, 3);
    gl.activeTexture(gl.TEXTURE3);
    this._bindBgPaint(locs, bgPaint);

    // Shared 3D-transform texture (unit 4) — fetched in the vertex for the rare
    // projective instance; 2D instances never sample it (cos != 2.0 sentinel).
    gl.uniform1i(locs.xformTex, 4);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this._xformTex);

    gl.bindVertexArray(this._panelVao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this._panelInstanceCount);
  };

  private _bindBgPaint = (locs: _PanelLocs, bgPaint: BgPaint | undefined): void => {
    const gl = this._gl;
    if (!bgPaint || bgPaint.Mode === 'Color') {
      gl.uniform1i(locs.bgMode, 0);
      gl.bindTexture(gl.TEXTURE_2D, this._dummyTex);
      // Reset gradient stop count so a stale prior gradient doesn't
      // leak into a subsequent Color batch.
      gl.uniform1i(locs.bgGradStopCount, 0);
      return;
    }
    if (bgPaint.Mode === 'Image') {
      gl.uniform1i(locs.bgMode, 1);
      gl.uniform4f(locs.bgUv, bgPaint.UvScaleX, bgPaint.UvScaleY, bgPaint.UvOffsetX, bgPaint.UvOffsetY);
      gl.uniform1f(locs.bgImageAlpha, bgPaint.FadeAlpha);
      gl.bindTexture(gl.TEXTURE_2D, _unwrap(bgPaint.Texture));
      gl.uniform1i(locs.bgGradStopCount, 0);
      return;
    }
    // Gradient path — pack stops into the scratch arrays then upload.
    const stops = bgPaint.Stops;
    const n = Math.min(stops.length, _MAX_BG_GRAD_STOPS);
    for (let i = 0; i < n; i++) {
      const s = stops[i];
      _BG_GRAD_COLOR_SCRATCH[i * 4 + 0] = s.R;
      _BG_GRAD_COLOR_SCRATCH[i * 4 + 1] = s.G;
      _BG_GRAD_COLOR_SCRATCH[i * 4 + 2] = s.B;
      _BG_GRAD_COLOR_SCRATCH[i * 4 + 3] = s.A;
      _BG_GRAD_POS_SCRATCH[i] = s.Position;
    }
    gl.uniform1i(locs.bgGradStopCount, n);
    gl.uniform4fv(locs.bgGradColor, _BG_GRAD_COLOR_SCRATCH);
    gl.uniform1fv(locs.bgGradPos, _BG_GRAD_POS_SCRATCH);
    if (bgPaint.Mode === 'LinearGradient') {
      gl.uniform1i(locs.bgMode, 2);
      gl.uniform4f(locs.bgGradParams, bgPaint.DirX, bgPaint.DirY, 0, 0);
    } else {
      gl.uniform1i(locs.bgMode, 3);
      gl.uniform4f(locs.bgGradParams, bgPaint.CenterX, bgPaint.CenterY, bgPaint.Radius, 0);
    }
    // Bind dummy for image sampler so the slot is always a valid 2D texture.
    gl.bindTexture(gl.TEXTURE_2D, this._dummyTex);
  };

  // ── Text Rendering ──

  TextBeginBatch = (): void => { this._textInstanceCount = 0; };

  TextAddInstance = (data: Float32Array, offset: number, count: number): void => {
    const needed = this._textInstanceCount * TEXT_FLOATS_PER_INSTANCE + count;
    if (needed > this._textInstanceData.length) {
      const newCap = Math.max(needed, this._textInstanceData.length * 2, 128 * TEXT_FLOATS_PER_INSTANCE);
      const newData = new Float32Array(newCap);
      newData.set(this._textInstanceData);
      this._textInstanceData = newData;
    }
    this._textInstanceData.set(
      data.subarray(offset, offset + count),
      this._textInstanceCount * TEXT_FLOATS_PER_INSTANCE,
    );
    this._textInstanceCount += count / TEXT_FLOATS_PER_INSTANCE;
  };

  TextDrawBatch = (canvasWidth: number, canvasHeight: number, atlas: GpuTextureHandle): void => {
    if (this._textInstanceCount === 0) return;
    const gl = this._gl;

    gl.bindBuffer(gl.ARRAY_BUFFER, this._textInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
      this._textInstanceData.subarray(0, this._textInstanceCount * TEXT_FLOATS_PER_INSTANCE),
      gl.DYNAMIC_DRAW);

    this._useProgram(this._textShader.Program);
    gl.uniform2f(this._textResolutionLoc, canvasWidth, canvasHeight);
    gl.uniform1i(this._textAtlasLoc, 0);
    gl.uniform1i(this._textClipTexLoc, 1);
    gl.uniform1i(this._textXformTexLoc, 2);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(atlas));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._clipTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._xformTex);

    gl.bindVertexArray(this._textVao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this._textInstanceCount);
  };

  // ── Jline (stroke) Rendering — instanced per segment ──

  StrokeBeginBatch = (): void => { this._strokeInstanceCount = 0; };

  StrokeAddInstance = (data: Float32Array, offset: number, count: number): void => {
    const needed = this._strokeInstanceCount * STROKE_FLOATS_PER_INSTANCE + count;
    if (needed > this._strokeInstanceData.length) {
      const newCap = Math.max(needed, this._strokeInstanceData.length * 2, 256 * STROKE_FLOATS_PER_INSTANCE);
      const newData = new Float32Array(newCap);
      newData.set(this._strokeInstanceData);
      this._strokeInstanceData = newData;
    }
    this._strokeInstanceData.set(
      data.subarray(offset, offset + count),
      this._strokeInstanceCount * STROKE_FLOATS_PER_INSTANCE,
    );
    this._strokeInstanceCount += count / STROKE_FLOATS_PER_INSTANCE;
  };

  StrokeDrawBatch = (canvasWidth: number, canvasHeight: number, style: StrokeStyle): void => {
    if (this._strokeInstanceCount === 0) return;
    const gl = this._gl;

    gl.bindBuffer(gl.ARRAY_BUFFER, this._strokeInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
      this._strokeInstanceData.subarray(0, this._strokeInstanceCount * STROKE_FLOATS_PER_INSTANCE),
      gl.DYNAMIC_DRAW);

    const l = this._strokeLocs;
    this._useProgram(this._strokeShader.Program);
    gl.uniform2f(l.resolution, canvasWidth, canvasHeight);
    gl.uniform1f(l.progress, style.Progress);
    gl.uniform1f(l.halfW, style.HalfWidth);
    gl.uniform1f(l.headR, style.HeadRadius);
    gl.uniform1f(l.blur, style.Blur);
    gl.uniform1f(l.blurFloor, style.BlurFloor);
    gl.uniform1f(l.blurSharp, style.BlurSharp);
    gl.uniform1f(l.ahead, style.Ahead);
    gl.uniform1f(l.behind, style.Behind);
    gl.uniform1f(l.windowUnit, style.WindowUnit);
    gl.uniform1f(l.headA, style.HeadAlpha);
    gl.uniform1f(l.floorA, style.FloorAlpha);
    gl.uniform1f(l.headFade, style.HeadFade);
    gl.uniform1f(l.trailMinA, style.TrailMinAlpha);
    gl.uniform1f(l.spread, style.Spread);
    gl.uniform1f(l.showPrior, style.ShowPrior);
    gl.uniform1f(l.priorScale, style.PriorScale);
    gl.uniform3f(l.fwdA, style.ForwardA[0], style.ForwardA[1], style.ForwardA[2]);
    gl.uniform3f(l.fwdB, style.ForwardB[0], style.ForwardB[1], style.ForwardB[2]);
    gl.uniform3f(l.prior, style.Prior[0], style.Prior[1], style.Prior[2]);
    gl.uniform3f(l.collision, style.CollisionColor[0], style.CollisionColor[1], style.CollisionColor[2]);

    gl.bindVertexArray(this._strokeVao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this._strokeInstanceCount);
  };

  // ── Blur ──

  ComputeBlur = (
    input: GpuTextureHandle, width: number, height: number,
    radius: number, minDepth?: number,
    scissor?: { x: number; y: number; w: number; h: number },
  ): GpuTextureHandle => {
    const result = this._blur.Blur(_unwrap(input), width, height, radius, minDepth, scissor);
    // BlurPass calls `gl.useProgram` internally with its own shaders,
    // bypassing our program cache. Invalidate so the next Panel/Text
    // draw re-binds its program correctly.
    this._lastProgram = null;
    return _wrap(result);
  };

  GenerateBlurMipmap = (maxLod?: number): void => {
    this._blur.GenerateOutputMipmap(maxLod);
    // The blit-to-mip path in BlurPass.GenerateOutputMipmap doesn't touch
    // shader programs, but keep the invalidation paired with ComputeBlur
    // for consistency. Cheap to do.
    this._lastProgram = null;
  };

  get LastBlurDepth(): number { return this._blur.LastDepth; }

  /** Build the shared backdrop: a sharp-root (σ=0) blur of the current scene
   *  with a full Gaussian mip chain, into a DEDICATED pass so the per-surface
   *  pblur / glass-border blurs (which reuse `_blur`'s buffers) can't overwrite
   *  it mid-frame. Glass surfaces then sample the result via textureLod at their
   *  own frost LOD — one build per frame, many cheap samples ("fire once, sample
   *  many"). Level 0 is the raw scene, so the same texture doubles as the
   *  no-frost LOD-0 fallback. Restores the scene FBO before returning. */
  BuildSharedBackdrop = (width: number, height: number, maxLod: number): GpuTextureHandle => {
    const pass = this._sharedBlur ?? (this._sharedBlur = new BlurPass(this._gl));
    // radius 0 → level 0 is the raw scene (1-tap copy, no dual-filter pre-blur);
    // GenerateOutputMipmap then builds the Gaussian stack from that sharp root.
    const tex = pass.Blur(this._sceneFbo.Texture, width, height, 0, undefined, undefined);
    pass.GenerateOutputMipmap(maxLod);
    // BlurPass bound its own programs; invalidate the cache like ComputeBlur does.
    this._lastProgram = null;
    // Restore the scene FBO so the subsequent glass draws target it.
    this.RebindSceneTarget();
    return _wrap(tex);
  };

  // ── Progressive Blur ──

  DrawProgressiveBlur = (params: ProgressiveBlurParams): void => {
    const gl = this._gl;
    const p = this._progBlurShader.Program;

    this._useProgram(p);
    gl.uniform2f(this._progBlurLocs.resolution, this._width, this._height);
    gl.uniform4f(this._progBlurLocs.rect, params.Rect.X, params.Rect.Y, params.Rect.W, params.Rect.H);
    gl.uniform4f(this._progBlurLocs.rot,
      params.Cos ?? 1, params.Sin ?? 0, params.PivotX ?? 0, params.PivotY ?? 0);
    gl.uniform1i(this._progBlurLocs.scene, 0);
    gl.uniform1i(this._progBlurLocs.pyramid, 1);
    gl.uniform1i(this._progBlurLocs.clipTex, 2);
    gl.uniform2i(this._progBlurLocs.clipMeta, params.ClipOffset, params.ClipCount);
    gl.uniform1f(this._progBlurLocs.maxLod, params.MaxLod);
    gl.uniform1i(this._progBlurLocs.direction, params.Direction);
    gl.uniform1f(this._progBlurLocs.feather, params.Feather);
    gl.uniform1f(this._progBlurLocs.easing, params.Easing);
    gl.uniform1f(this._progBlurLocs.opacity, params.Opacity);
    gl.uniform4f(this._progBlurLocs.background,
      params.Background.R, params.Background.G, params.Background.B, params.Background.A);
    gl.uniform3f(this._progBlurLocs.grading,
      params.Grading.Brightness, params.Grading.Saturation, params.Grading.Contrast);

    // Gradient-driven blur spectrum (overrides the linear feather). Pad the
    // stop arrays to the fixed shader size; u_StopCount bounds the read.
    const stops = params.Stops;
    if (stops && stops.length >= 2) {
      const n = Math.min(stops.length, 12);
      const pos = new Float32Array(12);
      const val = new Float32Array(12);
      const ease = new Float32Array(12);
      for (let i = 0; i < n; i++) {
        pos[i] = stops[i].Position;
        val[i] = stops[i].Value;
        ease[i] = Math.max(0.001, stops[i].Easing);
      }
      gl.uniform1i(this._progBlurLocs.hasStops, 1);
      gl.uniform1i(this._progBlurLocs.stopCount, n);
      gl.uniform1fv(this._progBlurLocs.stopPos, pos);
      gl.uniform1fv(this._progBlurLocs.stopVal, val);
      gl.uniform1fv(this._progBlurLocs.stopEase, ease);
    } else {
      gl.uniform1i(this._progBlurLocs.hasStops, 0);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(params.Scene));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(params.Pyramid));
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._clipTex);

    gl.bindVertexArray(this._quad.Vao);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  // ── Snapshot ──

  private _snapshotFbo: WebGLFramebuffer | null = null;
  private _snapshotTex: WebGLTexture | null = null;
  private _snapshotW: number = 0;
  private _snapshotH: number = 0;

  /** Copy the scene FBO into the snapshot texture so glass/pblur can sample
   *  it while drawing back into the scene FBO (avoids the read==write feedback
   *  loop). `scissor` (device px, y=0 at TOP — same convention BlurPass uses)
   *  restricts the blit to the surface's footprint + blur margin. The rest of
   *  the snapshot texture keeps last frame's contents, but the panel shader
   *  only samples within its own footprint (well inside the scissor's margin),
   *  so the stale ring is never read. Full-canvas blit when omitted. This is
   *  the dominant per-surface fill cost — full-canvas snapshots scale with
   *  total canvas area × (glass + pblur count); scissoring makes each snapshot
   *  proportional to the surface, not the screen. */
  SnapshotScreen = (scissor?: { x: number; y: number; w: number; h: number }): GpuTextureHandle => {
    const gl = this._gl;
    // Ensure snapshot texture exists at current size
    if (!this._snapshotTex || this._snapshotW !== this._width || this._snapshotH !== this._height) {
      if (this._snapshotTex) gl.deleteTexture(this._snapshotTex);
      if (this._snapshotFbo) gl.deleteFramebuffer(this._snapshotFbo);
      this._snapshotTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this._snapshotTex);
      // RGB10_A2 to match the (now 10-bit) scene FBO — a blit down to 8-bit
      // here would re-band the progressive blur's input. Same 32 bpp.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._snapshotFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._snapshotFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._snapshotTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._snapshotW = this._width;
      this._snapshotH = this._height;
    }
    // Copy sceneFbo → snapshot texture via blit. The scene FBO is where the
    // tree walk renders now (via BeginScenePass); the default framebuffer
    // stays empty until the final Blit at end-of-frame. Reading from
    // sceneFbo avoids the feedback-loop issue for progressive blur's
    // `u_Scene` uniform — pblur needs a separate texture it can safely
    // sample while rendering into sceneFbo itself.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._sceneFbo.Framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._snapshotFbo);
    if (scissor) {
      // Flip y=0-top → GL y=0-bottom, matching BlurPass. src and dst use the
      // same rect, so every copied texel stays at its framebuffer position;
      // NEAREST is exact for a 1:1 same-size copy and skips filter cost.
      const W = this._width, H = this._height;
      const x0 = Math.max(0, Math.floor(scissor.x));
      const x1 = Math.min(W, Math.ceil(scissor.x + scissor.w));
      const y0 = Math.max(0, Math.floor(H - (scissor.y + scissor.h)));
      const y1 = Math.min(H, Math.ceil(H - scissor.y));
      if (x1 > x0 && y1 > y0) {
        gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
    } else {
      gl.blitFramebuffer(0, 0, this._width, this._height, 0, 0, this._width, this._height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return _wrap(this._snapshotTex);
  };

  // ── Blit ──

  Blit = (source: GpuTextureHandle): void => {
    const gl = this._gl;
    this._useProgram(this._blitShader.Program);
    gl.uniform1i(this._blitTexLoc, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(source));
    gl.bindVertexArray(this._quad.Vao);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  // ── Texture Management ──

  CreateTexture = (width: number, height: number, srgb = false): GpuTextureHandle => {
    const gl = this._gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('[Jaui] Failed to create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // SRGB8_ALPHA8 → the GPU decodes sRGB→linear on every sample, so colour images blit/composite in linear
    // space (correct for lighting). Plain RGBA8 keeps raw bytes (for masks / already-linear data).
    const internalFormat = srgb ? gl.SRGB8_ALPHA8 : gl.RGBA;
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return _wrap(tex);
  };

  UploadSubTexture = (
    texture: GpuTextureHandle, x: number, y: number,
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap | ImageData,
  ): void => {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(texture));
    if ('data' in source && ArrayBuffer.isView(source.data)) {
      // Convert to Uint8Array (same buffer, no copy) — WebGL2 doesn't
      // accept Uint8ClampedArray for RGBA/UNSIGNED_BYTE on all browsers.
      const d = source.data;
      const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, source.width, source.height,
        gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    }
    const err = gl.getError();
    if (err !== gl.NO_ERROR) console.warn('[gl] texSubImage2D error:', err);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  // ── Render State ──

  EnableBlend = (): void => {
    const gl = this._gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  };

  DisableBlend = (): void => {
    this._gl.disable(this._gl.BLEND);
  };

  BindDefaultTarget = (clear?: { R: number; G: number; B: number }): void => {
    const gl = this._gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._width, this._height);
    if (clear) {
      // Disable blend so the clear color fully overwrites — otherwise a
      // previously-enabled blend state could premultiply and leave a tint.
      gl.disable(gl.BLEND);
      gl.clearColor(clear.R, clear.G, clear.B, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  };

  /** Bind the scene FBO as the current draw target without clearing. Used
   *  after blur passes (which transiently bound their own FBOs) to resume
   *  drawing into the scene. BlurPass disables blend on its own path, so
   *  re-enable standard alpha blending here so subsequent panel/text draws
   *  composite correctly over what's already in the scene FBO. */
  RebindSceneTarget = (): void => {
    const gl = this._gl;
    this._sceneFbo.Bind();
    gl.viewport(0, 0, this._width, this._height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  };

  /** Cache-aware program switch. Skip the gl.useProgram call when we're
   *  already bound to `program` — driver no-ops identical switches, but
   *  the JS-to-GL crossing has fixed cost (~5µs × 4 draw-batch calls × 60
   *  fps = ~1.2ms/sec saved on Home). */
  private _useProgram = (program: WebGLProgram): void => {
    if (this._lastProgram === program) return;
    this._gl.useProgram(program);
    this._lastProgram = program;
  };

  /** Hardware color-buffer copy from sceneFbo → default framebuffer.
   *  Faster than `Blit(SceneTexture)` (which runs a shader pass) because
   *  the GPU uses a dedicated copy path — no fragment shader invocation,
   *  no sampler setup, often a DMA operation on integrated parts. On
   *  tile-based renderers this can avoid rendering the scene back out
   *  from tile memory at all. */
  PresentScene = (): void => {
    const gl = this._gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._sceneFbo.Framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(
      0, 0, this._width, this._height,
      0, 0, this._width, this._height,
      gl.COLOR_BUFFER_BIT, gl.NEAREST, // NEAREST: 1:1 same-size copy, no filter cost
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  InvalidateFrameTransients = (): void => {
    const gl = this._gl;
    // Default framebuffer: we never touch depth for the final blit — tell
    // the driver not to bother preserving it. On tile-based mobile GPUs
    // (iPad, most Android) this prevents the depth tile memory from being
    // written out to main memory, a real bandwidth saving.
    // Note: default FB attachment names differ from FBO attachment names —
    // use DEPTH / STENCIL / COLOR, not DEPTH_ATTACHMENT / etc.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH, gl.STENCIL]);
    // Scene FBO: we just blit it out; its contents won't be read again this
    // frame and the next BeginScenePass will clear it. Drop the tile.
    this._sceneFbo.Bind();
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  SetViewport = (x: number, y: number, width: number, height: number): void => {
    this._gl.viewport(x, y, width, height);
  };

  // ── Shader Initialization ─────────────────────────────────────────────────

  private _initPanelShader = (gl: WebGL2RenderingContext): void => {
    // Two compiled variants from one source. The `materialType` local in
    // Jiv.Panel.frag is a compile-time constant when either define is set,
    // so the GLSL dead-code-elimination strips every `if (materialType ==
    // 1.0)` branch in whichever direction doesn't match the variant. Non-
    // glass panels (~60% of screen pixels on Home) now run a shader with
    // no backdrop sampling, no refraction, no rim, no specular — just
    // fill + shadow + border.
    this._panelShaderGlass = ShaderCompiler.Compile(gl, panelVertSrc, panelFragSrc, { MATERIAL_GLASS: true });
    this._panelShaderNone  = ShaderCompiler.Compile(gl, panelVertSrc, panelFragSrc, { MATERIAL_NONE:  true });

    this._panelLocsGlass = _extractPanelLocs(gl, this._panelShaderGlass.Program);
    this._panelLocsNone  = _extractPanelLocs(gl, this._panelShaderNone.Program);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jaui] Failed to create panel instance buffer');
    this._panelInstanceBuffer = buf;

    // Dedicated VAO for panel rendering (separate from text)
    this._panelVao = this._createInstancedVao(gl, this._panelInstanceBuffer, PANEL_ATTR_COUNT, PANEL_BYTES_PER_INSTANCE);
  };

  private _initTextShader = (gl: WebGL2RenderingContext): void => {
    this._textShader = ShaderCompiler.Compile(gl, textVertSrc, textFragSrc);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jaui] Failed to create text instance buffer');
    this._textInstanceBuffer = buf;

    this._textResolutionLoc = gl.getUniformLocation(this._textShader.Program, 'u_Resolution');
    this._textAtlasLoc = gl.getUniformLocation(this._textShader.Program, 'u_Atlas');
    this._textClipTexLoc = gl.getUniformLocation(this._textShader.Program, 'u_ClipTex');
    this._textXformTexLoc = gl.getUniformLocation(this._textShader.Program, 'u_XformTex');

    // Dedicated VAO for text rendering (separate from panel)
    this._textVao = this._createInstancedVao(gl, this._textInstanceBuffer, TEXT_ATTR_COUNT, TEXT_BYTES_PER_INSTANCE);
  };

  private _initStrokeShader = (gl: WebGL2RenderingContext): void => {
    this._strokeShader = ShaderCompiler.Compile(gl, strokeVertSrc, strokeFragSrc);
    this._strokeLocs = _extractStrokeLocs(gl, this._strokeShader.Program);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jaui] Failed to create stroke instance buffer');
    this._strokeInstanceBuffer = buf;

    // Dedicated VAO (unit quad at loc 0 + 3 per-instance vec4 at locs 1..3)
    this._strokeVao = this._createInstancedVao(gl, this._strokeInstanceBuffer, STROKE_ATTR_COUNT, STROKE_BYTES_PER_INSTANCE);
  };

  /** Create a VAO with the unit quad at location 0 + instance attributes at locations 1..N. */
  private _createInstancedVao = (
    gl: WebGL2RenderingContext,
    instanceBuffer: WebGLBuffer,
    attrCount: number,
    bytesPerInstance: number,
  ): WebGLVertexArrayObject => {
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('[Jaui] Failed to create VAO');
    gl.bindVertexArray(vao);

    // Quad position at location 0 (shared geometry data from _quad)
    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Index buffer
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2, 2,1,3]), gl.STATIC_DRAW);

    // Instance attributes at locations 1..attrCount
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    for (let loc = 1; loc <= attrCount; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, bytesPerInstance, (loc - 1) * BYTES_PER_VEC4);
      gl.vertexAttribDivisor(loc, 1);
    }

    gl.bindVertexArray(null);
    return vao;
  };

  private _initBlitShader = (gl: WebGL2RenderingContext): void => {
    this._blitShader = ShaderCompiler.Compile(gl, BLIT_VERT, BLIT_FRAG);
    this._blitTexLoc = gl.getUniformLocation(this._blitShader.Program, 'u_Tex');
  };

  private _clipMaskShader!: ShaderProgram;
  private _clipMaskDrawRectLoc!: WebGLUniformLocation | null;
  private _clipMaskClipRectLoc!: WebGLUniformLocation | null;
  private _clipMaskRadiusLoc!: WebGLUniformLocation | null;
  private _clipMaskSmoothnessLoc!: WebGLUniformLocation | null;
  private _clipMaskResLoc!: WebGLUniformLocation | null;
  private _initClipMaskShader = (gl: WebGL2RenderingContext): void => {
    this._clipMaskShader = ShaderCompiler.Compile(gl, CLIP_MASK_VERT, CLIP_MASK_FRAG);
    const p = this._clipMaskShader.Program;
    this._clipMaskDrawRectLoc = gl.getUniformLocation(p, 'u_DrawRect');
    this._clipMaskClipRectLoc = gl.getUniformLocation(p, 'u_ClipRect');
    this._clipMaskRadiusLoc = gl.getUniformLocation(p, 'u_Radius');
    this._clipMaskSmoothnessLoc = gl.getUniformLocation(p, 'u_Smoothness');
    this._clipMaskResLoc = gl.getUniformLocation(p, 'u_Resolution');
  };

  /** Janvas post-pass clipper. Rasterises a quad covering the janvas's
   *  screen rect (drawRect) and paints transparent pixels wherever the
   *  fragment falls OUTSIDE the parent's rounded clip shape (clipRect +
   *  radius + smoothness). All rects in device px, top-left origin.
   *  Smoothness 0 = pure circle corners; >0 = squircle (Apple-style). */
  DrawClipMask = (
    drawX: number, drawY: number, drawW: number, drawH: number,
    clipX: number, clipY: number, clipW: number, clipH: number,
    radius: number,
    smoothness: number,
  ): void => {
    const gl = this._gl;
    this._useProgram(this._clipMaskShader.Program);
    gl.uniform4f(this._clipMaskDrawRectLoc, drawX, drawY, drawW, drawH);
    gl.uniform4f(this._clipMaskClipRectLoc, clipX, clipY, clipW, clipH);
    gl.uniform1f(this._clipMaskRadiusLoc, radius);
    gl.uniform1f(this._clipMaskSmoothnessLoc, smoothness);
    gl.uniform2f(this._clipMaskResLoc, this._width, this._height);
    gl.bindVertexArray(this._quad.Vao);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  private _initProgBlurShader = (gl: WebGL2RenderingContext): void => {
    this._progBlurShader = ShaderCompiler.Compile(gl, PROGRESSIVE_BLUR_VERT, PROGRESSIVE_BLUR_FRAG);
    const p = this._progBlurShader.Program;
    this._progBlurLocs = {
      resolution: gl.getUniformLocation(p, 'u_Resolution'),
      rect: gl.getUniformLocation(p, 'u_Rect'),
      rot: gl.getUniformLocation(p, 'u_Rot'),
      scene: gl.getUniformLocation(p, 'u_Scene'),
      pyramid: gl.getUniformLocation(p, 'u_Pyramid'),
      maxLod: gl.getUniformLocation(p, 'u_MaxLod'),
      direction: gl.getUniformLocation(p, 'u_Direction'),
      feather: gl.getUniformLocation(p, 'u_Feather'),
      easing: gl.getUniformLocation(p, 'u_Easing'),
      opacity: gl.getUniformLocation(p, 'u_Opacity'),
      background: gl.getUniformLocation(p, 'u_Background'),
      grading: gl.getUniformLocation(p, 'u_Grading'),
      clipTex: gl.getUniformLocation(p, 'u_ClipTex'),
      clipMeta: gl.getUniformLocation(p, 'u_ClipMeta'),
      hasStops: gl.getUniformLocation(p, 'u_HasStops'),
      stopCount: gl.getUniformLocation(p, 'u_StopCount'),
      stopPos: gl.getUniformLocation(p, 'u_StopPos'),
      stopVal: gl.getUniformLocation(p, 'u_StopVal'),
      stopEase: gl.getUniformLocation(p, 'u_StopEase'),
    };
  };
}
