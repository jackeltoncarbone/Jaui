/**
 * WebGL2 implementation of the Renderer interface.
 *
 * Wraps the original WebGL2 rendering subsystems (ShaderCompiler, Framebuffer,
 * BlurPass, Blit, Geometry.Quad) into the Renderer interface so Jaui.ts can
 * use it as a drop-in alternative to WebGPURenderer. This is the default
 * backend — works on every browser, every GPU, every driver.
 */

import { BACKDROP_REGION_FULL, SHADOW_EASE_SECONDS, type BackdropRegion, type Renderer, type GpuTextureHandle, type ProgressiveBlurParams, type BgPaint, type ShadowBackdrop } from './Renderer';
import { ShaderBatch, type ShaderProgram } from './Shader.Compiler';
import { JTrace, JMs } from '../Diagnostics/Jaui.Trace';
import { Framebuffer } from './Framebuffer';
import { BlurPass } from './BlurPass';
import { PassTimers, type PassProfile } from './Pass.Timers';
import { QuadGeometry } from './Geometry.Quad';
import { PROGRESSIVE_BLUR_VERT, PROGRESSIVE_BLUR_FRAG } from '../ProgressiveBlur/ProgressiveBlur.Shader';
import { BLUR_EASE_SMOOTH } from '../Jiv/Jiv.Types';

import panelVertSrc from '../Jiv/Shaders/Jiv.Panel.vert.gen';
import panelFragSrc from '../Jiv/Shaders/Jiv.Panel.frag.gen';
import shadowBackdropFragSrc from '../Jiv/Shaders/Jiv.ShadowBackdrop.frag.gen';
import textVertSrc from '../Text/Shaders/Text.Quad.vert.gen';
import textFragSrc from '../Text/Shaders/Text.Quad.frag.gen';
import strokeVertSrc from '../Jline/Shaders/Jline.vert.gen';
import strokeFragSrc from '../Jline/Shaders/Jline.frag.gen';
import svgFillVertSrc from '../Svg/Shaders/Svg.Fill.vert.gen';
import svgFillFragSrc from '../Svg/Shaders/Svg.Fill.frag.gen';
import svgStrokeVertSrc from '../Svg/Shaders/Svg.Stroke.vert.gen';
import svgStrokeFragSrc from '../Svg/Shaders/Svg.Stroke.frag.gen';
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
  viewOffset:   WebGLUniformLocation | null;
  backdrop:     WebGLUniformLocation | null;
  backdropXf:   WebGLUniformLocation | null;
  scene:        WebGLUniformLocation | null;
  baseFrostLod: WebGLUniformLocation | null;
  specTilt:     WebGLUniformLocation | null;
  clipTex:      WebGLUniformLocation | null;
  xformTex:     WebGLUniformLocation | null;
  shadowState:    WebGLUniformLocation | null;
  shadowBackdrop: WebGLUniformLocation | null;
  // ── Background paint (Color | Image | LinearGradient | RadialGradient) ──
  bgMode:           WebGLUniformLocation | null;
  bgTexture:        WebGLUniformLocation | null;
  bgUv:             WebGLUniformLocation | null;
  bgImageAlpha:     WebGLUniformLocation | null;
  bgGradParams:     WebGLUniformLocation | null;
  bgGradStopCount:  WebGLUniformLocation | null;
  bgGradValue:      WebGLUniformLocation | null;
  bgGradTangent:    WebGLUniformLocation | null;
  bgGradPos:        WebGLUniformLocation | null;
}

const _extractPanelLocs = (gl: WebGL2RenderingContext, p: WebGLProgram): _PanelLocs => ({
  resolution:   gl.getUniformLocation(p, 'u_Resolution'),
  viewOffset:   gl.getUniformLocation(p, 'u_ViewOffset'),
  backdrop:     gl.getUniformLocation(p, 'u_Backdrop'),
  backdropXf:   gl.getUniformLocation(p, 'u_BackdropXf'),
  scene:        gl.getUniformLocation(p, 'u_Scene'),
  baseFrostLod: gl.getUniformLocation(p, 'u_BaseFrostLod'),
  specTilt:     gl.getUniformLocation(p, 'u_SpecularTilt'),
  clipTex:      gl.getUniformLocation(p, 'u_ClipTex'),
  xformTex:     gl.getUniformLocation(p, 'u_XformTex'),
  shadowState:    gl.getUniformLocation(p, 'u_ShadowState'),
  shadowBackdrop: gl.getUniformLocation(p, 'u_ShadowBackdrop'),
  bgMode:           gl.getUniformLocation(p, 'u_BgMode'),
  bgTexture:        gl.getUniformLocation(p, 'u_BgTexture'),
  bgUv:             gl.getUniformLocation(p, 'u_BgUv'),
  bgImageAlpha:     gl.getUniformLocation(p, 'u_BgImageAlpha'),
  bgGradParams:     gl.getUniformLocation(p, 'u_BgGradParams'),
  bgGradStopCount:  gl.getUniformLocation(p, 'u_BgGradStopCount'),
  // Uniform arrays: GLSL exposes one location for the whole array via the
  // base name; `uniform1fv`/`uniform4fv` updates all elements from a
  // contiguous Float32Array.
  bgGradValue:      gl.getUniformLocation(p, 'u_BgGradValue[0]'),
  bgGradTangent:    gl.getUniformLocation(p, 'u_BgGradTangent[0]'),
  bgGradPos:        gl.getUniformLocation(p, 'u_BgGradPos[0]'),
});

const _BG_UV_IDENTITY = [1, 1, 0, 0];

// ─── Opaque handle wrapping ─────────────────────────────────────────────────

interface WrappedGlTexture extends GpuTextureHandle {
  readonly _glTex: WebGLTexture;
}

// The blur pyramid is sized to the SURFACE, so a backdrop texture no longer covers the screen —
// and every consumer has to know which part of the screen it does cover. That travels ON THE
// HANDLE rather than as renderer state: a handle cannot go stale, and the shared-backdrop path
// (which reuses a pyramid built several surfaces ago) would read a stale field every time.
const _wrap = (tex: WebGLTexture, region?: BackdropRegion): GpuTextureHandle =>
  ({ _brand: 'GpuTextureHandle', _glTex: tex, Region: region } as unknown as GpuTextureHandle);
const _unwrap = (handle: GpuTextureHandle): WebGLTexture =>
  (handle as unknown as WrappedGlTexture)._glTex;
/** The screen-UV → pyramid-UV map a backdrop texture carries, or the identity for a texture
 *  that covers the whole canvas (the raw scene, the shared backdrop, the ?no-blur passthrough). */
const _regionOf = (handle: GpuTextureHandle | null | undefined): BackdropRegion =>
  handle?.Region ?? BACKDROP_REGION_FULL;

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
        float n = 2.0 + 3.0 * clamp(u_Smoothness, 0.0, 1.0);
        float L = pow(cornerP.x / r, n) + pow(cornerP.y / r, n);
        sd = r * (pow(max(L, 0.0), 1.0 / n) - 1.0);
    }
    if (sd <= 0.0) discard;
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
}
`;

/** Surfaces whose adaptive shadow can be measured at once; past this a surface keeps its authored shadow. */
const SHADOW_STATE_SLOTS = 64;

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
  /** Glass and backdrop-filter surfaces (`radius > 0` — a real frost sigma). */
  private _blur!: BlurPass;
  /** The sharp-root pyramid (`radius <= 0`), which today means the progressive blur.
   *
   *  A separate instance because every level FBO is now sized from the surface REGION, and
   *  these two consumers ask for very different ones: a progressive blur's region is usually a
   *  whole edge of the canvas, a glass card's is the card. Sharing one set would re-allocate
   *  the entire chain twice a frame on any page that has both — a toolbar over a grid, which is
   *  most of this app. Lazily created on first use. */
  private _rootBlur: BlurPass | null = null;
  /** The pass the last ComputeBlur ran on; GenerateBlurMipmap and LastBlurDepth follow it. */
  private _lastBlur: BlurPass | null = null;
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
  // Retained-mode capture view-offset (device px). (0,0) for the normal pass;
  // compositeOrCapture sets it to the subtree AABB origin so panel/text draws
  // project into the capture FBO while v_PixelPos stays screen-space (clips
  // match without remapping). Applied in PanelDrawBatch/TextDrawBatch.
  private _captureViewOffsetX = 0;
  private _captureViewOffsetY = 0;
  SetCaptureViewOffset = (x: number, y: number): void => {
    this._captureViewOffsetX = x;
    this._captureViewOffsetY = y;
  };
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
  private _textViewOffsetLoc!: WebGLUniformLocation | null;
  private _textAtlasLoc!: WebGLUniformLocation | null;

  // Jline (stroke) shader — instanced per segment
  private _strokeShader!: ShaderProgram;
  private _strokeLocs!: _StrokeLocs;
  private _strokeVao!: WebGLVertexArrayObject;
  private _strokeInstanceBuffer!: WebGLBuffer;
  private _strokeInstanceData = new Float32Array(0);
  private _strokeInstanceCount = 0;

  // SVG vector fill shader — non-instanced triangle soup [x, y, cov]
  private _svgFillShader!: ShaderProgram;
  private _svgFillVao!: WebGLVertexArrayObject;
  private _svgFillVertBuffer!: WebGLBuffer;
  private _svgFillLocs!: {
    resolution: WebGLUniformLocation | null;
    model0: WebGLUniformLocation | null;
    model1: WebGLUniformLocation | null;
    tint: WebGLUniformLocation | null;
  };
  // SVG vector stroke shader — instanced miter-quad segments (2 vec4/instance)
  private _svgStrokeShader!: ShaderProgram;
  private _svgStrokeVao!: WebGLVertexArrayObject;
  private _svgStrokeInstanceBuffer!: WebGLBuffer;
  private _svgStrokeLocs!: {
    resolution: WebGLUniformLocation | null;
    model0: WebGLUniformLocation | null;
    model1: WebGLUniformLocation | null;
    tint: WebGLUniformLocation | null;
    halfWidth: WebGLUniformLocation | null;
  };

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
    pyramidXf: WebGLUniformLocation | null;
    pyramidSize: WebGLUniformLocation | null;
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

  // ── Per-PASS GPU timing (diagnostic, off unless armed) ──
  // The frame timer above says how much and never what. `Pass.Timers` splits the frame by pass
  // type — read its header before reading any table it produces, because on a tile-based GPU a
  // query boundary and a render-pass boundary are not the same thing.
  //
  // ARMED, NOT SHIPPED. `_passArmed` is set only by `?wkr-jaui-prof` or `?trace`. Unarmed, the
  // whole mechanism is one null check per pass entry point and the frame path below is exactly
  // what it was: one query per frame, opened in BeginFrame, closed in EndFrame.
  private _passArmed: boolean = false;
  private _pass: PassTimers<WebGLQuery> | null = null;
  /** Key of the framebuffer currently bound, mirrored into `_pass.Target` so a bracket can tell a
   *  real attachment change from an inherited target. Null-guarded: unarmed it costs one check. */
  private _tgt = (key: string): void => { if (this._pass !== null) this._pass.SetTarget(key); };
  /** Name a lazily-built blur chain so its level FBOs get target keys distinct from the other
   *  chains', and hand it the timer if one is already running. */
  private _tagBlur = (pass: BlurPass, tag: string): BlurPass => {
    pass.TimerTag = tag;
    pass.Timers = this._pass;
    return pass;
  };

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
      // NOTE: do NOT set `desynchronized: true`. With render-on-demand + double
      // buffering it presents an unsynced buffer flip, so the canvas visibly
      // alternates between the previous and the new frame every tick (the
      // app-wide jitter). The speculative latency win wasn't worth the tearing.
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('[Jaui] WebGL2 not supported');
    this._gl = gl;
    // A restored context re-runs Init: the adaptive shadow state belonged to the lost one. The
    // batch below rebuilds the program; these clear what the dead context owned.
    this._pendingShaders = null;
    this._shadowShader = null;
    this._shadowLocs = null;
    this._shadowStateTex = null;
    this._shadowStateFbo = null;
    this._shadowSlots.clear();
    this._shadowFreeSlots.length = 0;
    // Same reason, for the GPU timers: every query object belongs to the context that is gone, and
    // polling one of them after a restore asks a dead handle for a result. The rings are dropped
    // and both timers rebuild themselves on the next frame -- `_passArmed` survives, so a restore
    // does not silently disarm the instrument.
    this._timerQueries.length = 0;
    this._timerActive = null;
    this._lastGpuMs = null;
    this._pass = null;

    // ── One compile batch for every program the engine can draw with ──
    // Thirteen programs stand between a cold tab and its first pixel. Compiled one at a time —
    // compile, ask, link, ask — they run the driver's compiler pool one deep and the waits add up
    // in a line; issued together they overlap, and the whole set costs about what its slowest
    // member costs. See `ShaderBatch` for the named source (KHR_parallel_shader_compile). Nothing
    // about WHAT is compiled changes: same sources, same defines, same programs.
    //
    // ISSUED HERE, COLLECTED AT THE FIRST FRAME. Init does not wait: see `_ensureShaders`. The
    // caller posts `ready` the moment Init returns, so everything downstream of ready that does not
    // touch GL — the whole backlogged jiv tree, its text measure, its layout solve — runs beside the
    // compile instead of behind it.
    //
    // FIRST THING AFTER THE CONTEXT, AND AHEAD OF EVERY ALLOCATION. On a first-EVER visit the driver
    // spends ~700ms optimising these; the quad, the scene FBO and the placeholder/clip textures below
    // need nothing from them and cost real milliseconds, so every one of those spent before the batch
    // is issued is a millisecond the compiler pool sat idle at the front of the longest job in the
    // boot. Only the context and the state reset above have to come first.
    const batch = new ShaderBatch(gl);
    this._blur = new BlurPass(gl, batch);
    this._compilePanelShader(batch);
    this._compileTextShader(batch);
    this._compileStrokeShader(batch);
    this._compileSvgFillShader(batch);
    this._compileSvgStrokeShader(batch);
    this._compileBlitShader(batch);
    this._compileClipMaskShader(batch);
    this._compileProgBlurShader(batch);
    this._compileShadowBackdropShader(batch);
    this._pendingShaders = batch;
    JTrace(`jaui:shaders:issued n=${batch.Count} ${JMs(batch.IssueMs)}ms`);

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
    this._sceneFbo = new Framebuffer(gl, { depth: !this.DiagNoDepth, highPrecision: true });
    JTrace(`jaui:scene-fbo depth=${!this.DiagNoDepth} highPrecision=true`);

    // Probe for GPU timer-query support. The extension object exposes the
    // two enums we need; if it's missing, _timerExt stays null and
    // GetFrameGpuMs permanently returns null on this device.
    const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (timerExt) {
      this._timerExt = timerExt;
    }

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

  // ── Shader collection ─────────────────────────────────────────────────────
  // Programs `Init` handed the driver and has not collected. Init returns WITHOUT waiting for them,
  // which is the point: the worker posts `ready` immediately, main drains the whole backlogged jiv
  // tree, and the tree build, the text measure and the layout solve — none of which touch GL —
  // all run while the driver's compiler pool works. They used to run AFTER it, in series, for no
  // reason other than that Init happened to wait.
  //
  // This is the one wait, taken at the top of the first frame: the first moment a program is
  // genuinely needed. `BeginFrame` is the choke point because every draw in the engine is inside a
  // frame and every frame starts there.
  private _pendingShaders: ShaderBatch | null = null;

  private _ensureShaders = (): void => {
    const batch = this._pendingShaders;
    if (!batch) return;
    this._pendingShaders = null;
    batch.Resolve();
    // A wait near zero means the compile finished behind the tree build and cost the frame nothing.
    JTrace(`jaui:shaders:linked n=${batch.Count} wait=${JMs(batch.ResolveMs)}ms`);
    const gl = this._gl;
    this._blur.WireLocations();
    this._wirePanelShader(gl);
    this._wireTextShader(gl);
    this._wireStrokeShader(gl);
    this._wireSvgFillShader(gl);
    this._wireSvgStrokeShader(gl);
    this._wireBlitShader(gl);
    this._wireClipMaskShader(gl);
    this._wireProgBlurShader(gl);
    this._wireShadowBackdrop(gl);
  };

  // ── Per-Frame ──

  BeginFrame = (): void => {
    // Before the GPU timer starts: collecting the boot batch is CPU spent waiting on the driver,
    // and folding it into the frame's GPU reading would make the first frame lie about itself.
    this._ensureShaders();
    this._clipLastFloatsUploaded = 0;
    // Start a fresh GPU timer query for this frame. If the extension
    // isn't available or query creation fails silently, _timerActive stays
    // null and EndFrame / GetFrameGpuMs become no-ops.
    const ext = this._timerExt;
    if (ext) {
      // Armed, every OTHER frame belongs to the per-pass split instead, and must not open a
      // whole-frame query: only one TIME_ELAPSED query may be active at a time, so the two
      // readings cannot share a frame. The frames this skips are exactly the split ones.
      if (this._passArmed && this._beginPassFrame(ext)) return;
      const gl = this._gl;
      const q = gl.createQuery();
      if (q) {
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        this._timerActive = q;
      }
    }
  };

  /** Build the per-pass timer on first use (Init may not have run when the flag was parsed) and
   *  open its frame. True when this frame is a SPLIT frame and the caller must skip its own
   *  whole-frame query. */
  private _beginPassFrame = (ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }): boolean => {
    let pass = this._pass;
    if (pass === null) {
      pass = new PassTimers<WebGLQuery>(this._gl, ext);
      this._pass = pass;
      JTrace(`jaui:passtimers:armed counterBits=${pass.CounterBits}`);
    }
    // Re-handed every frame rather than once: `Init` rebuilds `_blur` on a context restore, and
    // the two lazy chains below are created the first time a surface asks for them.
    this._blur.Timers = pass;
    if (this._rootBlur !== null) this._rootBlur.Timers = pass;
    if (this._sharedBlur !== null) this._sharedBlur.Timers = pass;
    return pass.BeginFrame();
  };

  EndFrame = (): void => {
    const ext = this._timerExt;
    const q = this._timerActive;
    if (!ext || !q) { this._endPassFrame(); return; }
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
    this._endPassFrame();
  };

  /** Close the per-pass frame and harvest. Also drains the whole-frame ring, because the reference
   *  half of the reading is those queries and nothing else polls them unless the HUD is on. */
  private _endPassFrame = (): void => {
    const pass = this._pass;
    if (pass === null) return;
    this.GetFrameGpuMs();
    pass.EndFrame();
  };

  /** Arm per-pass GPU timing. Diagnostic only — `?wkr-jaui-prof` or `?trace`. Takes effect at the
   *  next frame; the timer itself is built there, since Init may not have run yet. */
  ArmPassTimers = (): void => { this._passArmed = true; };

  /** The cumulative per-pass reading, or null on a device with no timer query (Safari, so every
   *  iPhone) or before anything was armed. Two snapshots subtract into a window — see
   *  `PassWindowOf`. NEVER a table of zeros: absence and free must not print alike. */
  GetPassProfile = (): PassProfile | null => (this._pass === null ? null : this._pass.Snapshot());

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
        // While armed these queries only exist on REFERENCE frames — the ones carrying no per-pass
        // queries at all — so each is a clean whole-frame cost to check the pass table against.
        if (this._pass !== null) this._pass.AddRefSample(this._lastGpuMs);
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

  BeginScenePass = (clearR: number, clearG: number, clearB: number, persist = false): void => {
    const gl = this._gl;
    this._sceneFbo.Bind();
    this._tgt('scene');
    gl.viewport(0, 0, this._width, this._height);
    // Damage-region: when persisting, skip the clear so last frame's pixels
    // survive; only the dirty rect is re-rendered over them this frame.
    if (!persist) {
      gl.clearColor(clearR, clearG, clearB, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
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
    shadowBackdrop?: ShadowBackdrop,
  ): void => {
    if (this._panelInstanceCount === 0) return;
    const gl = this._gl;
    // SOFT wherever a panel batch follows another draw into the same scene FBO, which is the
    // common case: see the bracket note in `Pass.Timers`.
    const timed = this._pass !== null && this._pass.Begin('panel');

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
    gl.uniform2f(locs.viewOffset, this._captureViewOffsetX, this._captureViewOffsetY);
    gl.uniform1i(locs.backdrop, 0);
    // The pyramid is sized to this surface, so `sampleBackdrop` maps screen UV through this
    // before it reads. Identity for a full-canvas backdrop — and for a null one, where the
    // shader never reaches the sampler at all.
    const backdropRegion = _regionOf(backdrop);
    gl.uniform4f(locs.backdropXf,
      backdropRegion.ScaleX, backdropRegion.ScaleY, backdropRegion.OffsetX, backdropRegion.OffsetY);
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

    // Adaptive shadow state (unit 5), read in the vertex. Slot -1 leaves the authored shadow untouched.
    const shadowSlot = shadowBackdrop && this._shadowStateTex ? shadowBackdrop.Slot : -1;
    gl.uniform1i(locs.shadowState, 5);
    gl.uniform2f(locs.shadowBackdrop, shadowSlot, shadowSlot >= 0 ? shadowBackdrop!.Adaptive : 0);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this._shadowStateTex ?? this._dummyTex);

    gl.bindVertexArray(this._panelVao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this._panelInstanceCount);
    if (timed) this._pass!.End();
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
    // Gradient path — the curve arrives packed at the shader's array size.
    const curve = bgPaint.Curve;
    gl.uniform1i(locs.bgGradStopCount, curve.Count);
    gl.uniform4fv(locs.bgGradValue, curve.Value);
    gl.uniform4fv(locs.bgGradTangent, curve.Tangent);
    gl.uniform1fv(locs.bgGradPos, curve.Position);
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
    const timed = this._pass !== null && this._pass.Begin('text');

    gl.bindBuffer(gl.ARRAY_BUFFER, this._textInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
      this._textInstanceData.subarray(0, this._textInstanceCount * TEXT_FLOATS_PER_INSTANCE),
      gl.DYNAMIC_DRAW);

    this._useProgram(this._textShader.Program);
    gl.uniform2f(this._textResolutionLoc, canvasWidth, canvasHeight);
    gl.uniform2f(this._textViewOffsetLoc, this._captureViewOffsetX, this._captureViewOffsetY);
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
    if (timed) this._pass!.End();
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
    const timed = this._pass !== null && this._pass.Begin('stroke');

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
    if (timed) this._pass!.End();
  };

  /** Read the current default-framebuffer pixels into a PNG blob. Call IMMEDIATELY after a
   *  render (preserveDrawingBuffer is false, so the back buffer is valid only until the next
   *  draw). Rows are flipped (GL is bottom-up) into a 2D OffscreenCanvas, then encoded. */
  CapturePng = async (): Promise<Blob | null> => {
    const gl = this._gl;
    const w = this._width, h = this._height;
    if (w === 0 || h === 0) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = new OffscreenCanvas(w, h);
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * row;
      img.data.set(px.subarray(src, src + row), y * row);
    }
    ctx.putImageData(img, 0, 0);
    return out.convertToBlob({ type: 'image/png' });
  };

  // ── SVG vector rendering ──

  SvgFillDraw = (
    verts: Float32Array, vertCount: number,
    model0: readonly [number, number, number], model1: readonly [number, number, number],
    tint: readonly [number, number, number, number],
    canvasWidth: number, canvasHeight: number,
  ): void => {
    if (vertCount === 0) return;
    const gl = this._gl;
    const timed = this._pass !== null && this._pass.Begin('svg');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._svgFillVertBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, vertCount * 3), gl.DYNAMIC_DRAW);
    const l = this._svgFillLocs;
    this._useProgram(this._svgFillShader.Program);
    gl.uniform2f(l.resolution, canvasWidth, canvasHeight);
    gl.uniform3f(l.model0, model0[0], model0[1], model0[2]);
    gl.uniform3f(l.model1, model1[0], model1[1], model1[2]);
    gl.uniform4f(l.tint, tint[0], tint[1], tint[2], tint[3]);
    gl.bindVertexArray(this._svgFillVao);
    gl.drawArrays(gl.TRIANGLES, 0, vertCount);
    if (timed) this._pass!.End();
  };

  SvgStrokeDraw = (
    data: Float32Array, segCount: number,
    model0: readonly [number, number, number], model1: readonly [number, number, number],
    tint: readonly [number, number, number, number],
    halfWidthDev: number, canvasWidth: number, canvasHeight: number,
  ): void => {
    if (segCount === 0) return;
    const gl = this._gl;
    const timed = this._pass !== null && this._pass.Begin('svg');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._svgStrokeInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, segCount * 8), gl.DYNAMIC_DRAW);
    const l = this._svgStrokeLocs;
    this._useProgram(this._svgStrokeShader.Program);
    gl.uniform2f(l.resolution, canvasWidth, canvasHeight);
    gl.uniform3f(l.model0, model0[0], model0[1], model0[2]);
    gl.uniform3f(l.model1, model1[0], model1[1], model1[2]);
    gl.uniform4f(l.tint, tint[0], tint[1], tint[2], tint[3]);
    gl.uniform1f(l.halfWidth, Math.max(0.5, halfWidthDev));
    gl.bindVertexArray(this._svgStrokeVao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, segCount);
    if (timed) this._pass!.End();
  };

  // ── Blur ──

  /** [diag ?no-blur] When true, ComputeBlur + GenerateBlurMipmap no-op so the
   *  per-surface backdrop blur fill is removed — measures the blur's GPU cost. */
  DiagNoBlur = false;
  /** `?no-depth` (measurement only). Build the scene FBO WITHOUT its depth+stencil renderbuffer.
   *  Nothing in the UI renderer tests depth or stencil - every DEPTH_TEST/STENCIL_TEST call in the
   *  engine disables one - so on a surface with no <janvas> the attachment is never read and never
   *  written, and whether the driver still pays a load/store for it at each encoder boundary cannot
   *  be known from source. The M4 measured the empty-frame floor at 2.33 GPU ms (14% of budget) on
   *  2026-09-18; this flag is how that floor gets a depth term instead of an inference. A <janvas>
   *  surface under this flag WILL render wrong (the 3D field needs depth) - it is an ablation, not a
   *  mode, and the trace mark below says which FBO was built so the reading cannot be misfiled. */
  DiagNoDepth = false;

  ComputeBlur = (
    input: GpuTextureHandle, width: number, height: number,
    radius: number, minDepth?: number,
    region?: { x: number; y: number; w: number; h: number },
  ): GpuTextureHandle => {
    // The diagnostic hands back the canvas-sized scene, which screen UV addresses directly —
    // so it comes back with no region, and every consumer's transform is the identity.
    if (this.DiagNoBlur) return input;
    const pass = radius > 0
      ? this._blur
      : (this._rootBlur ?? (this._rootBlur = this._tagBlur(new BlurPass(this._gl), 'root')));
    this._lastBlur = pass;
    const result = pass.Blur(_unwrap(input), width, height, radius, minDepth, region);
    // BlurPass calls `gl.useProgram` internally with its own shaders,
    // bypassing our program cache. Invalidate so the next Panel/Text
    // draw re-binds its program correctly.
    this._lastProgram = null;
    return _wrap(result, pass.LastRegion);
  };

  GenerateBlurMipmap = (maxLod?: number): void => {
    if (this.DiagNoBlur) return;
    (this._lastBlur ?? this._blur).GenerateOutputMipmap(maxLod);
    // The blit-to-mip path in BlurPass.GenerateOutputMipmap doesn't touch
    // shader programs, but keep the invalidation paired with ComputeBlur
    // for consistency. Cheap to do.
    this._lastProgram = null;
  };

  get LastBlurDepth(): number { return (this._lastBlur ?? this._blur).LastDepth; }

  /** Build the shared backdrop: a sharp-root (σ=0) blur of the current scene
   *  with a full Gaussian mip chain, into a DEDICATED pass so the per-surface
   *  pblur / glass-border blurs (which reuse `_blur`'s buffers) can't overwrite
   *  it mid-frame. Glass surfaces then sample the result via textureLod at their
   *  own frost LOD — one build per frame, many cheap samples ("fire once, sample
   *  many"). Level 0 is the raw scene, so the same texture doubles as the
   *  no-frost LOD-0 fallback. Restores the scene FBO before returning. */
  BuildSharedBackdrop = (width: number, height: number, maxLod: number): GpuTextureHandle => {
    const pass = this._sharedBlur ?? (this._sharedBlur = this._tagBlur(new BlurPass(this._gl), 'shared'));
    // radius 0 → level 0 is the raw scene (1-tap copy, no dual-filter pre-blur);
    // GenerateOutputMipmap then builds the Gaussian stack from that sharp root.
    // Quarter-res build: blur is low-frequency, so a 1/4-res pyramid upsamples to
    // a visually identical result with ~16x less fragment fill. Consumers add +2
    // to their frost LOD (this pyramid's level 0 ≈ a full-res pyramid's LOD 2).
    const qw = Math.max(1, width >> 2), qh = Math.max(1, height >> 2);
    const tex = pass.Blur(this._sceneFbo.Texture, qw, qh, 0, undefined, undefined);
    pass.GenerateOutputMipmap(Math.max(1, maxLod - 2));
    // It covers the WHOLE canvas (at quarter resolution), so screen UV addresses it unchanged.
    const region = pass.LastRegion;
    // BlurPass bound its own programs; invalidate the cache like ComputeBlur does.
    this._lastProgram = null;
    // Restore the scene FBO so the subsequent glass draws target it.
    this.RebindSceneTarget();
    return _wrap(tex, region);
  };

  // ── Adaptive shadow ──

  private _shadowShader: ShaderProgram | null = null;
  private _shadowLocs: {
    scene: WebGLUniformLocation | null;
    backdrop: WebGLUniformLocation | null;
    resolution: WebGLUniformLocation | null;
    rect: WebGLUniformLocation | null;
    detailLod: WebGLUniformLocation | null;
    backdropXf: WebGLUniformLocation | null;
  } | null = null;
  private _shadowStateTex: WebGLTexture | null = null;
  private _shadowStateFbo: WebGLFramebuffer | null = null;
  /** Surface → its texel in the state row, and the frame it was last measured in. */
  private _shadowSlots = new Map<object, { Slot: number; Frame: number }>();
  private _shadowFreeSlots: number[] = [];
  private _shadowFrame = 0;

  MeasureShadowBackdrop = (
    key: object,
    rect: { x: number; y: number; w: number; h: number },
    detailLod: number,
    backdrop: GpuTextureHandle,
    scene: GpuTextureHandle,
    dtSeconds: number,
  ): number => {
    const gl = this._gl;
    let entry = this._shadowSlots.get(key);
    const fresh = entry === undefined;
    if (!entry) {
      const slot = this._shadowFreeSlots.pop();
      if (slot === undefined) return -1;
      entry = { Slot: slot, Frame: this._shadowFrame };
      this._shadowSlots.set(key, entry);
    }
    entry.Frame = this._shadowFrame;

    const program = this._shadowShader!;
    const locs = this._shadowLocs!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._shadowStateFbo);
    this._tgt('shadow-state');
    const timed = this._pass !== null && this._pass.Begin('shadow');
    gl.viewport(entry.Slot, 0, 1, 1);
    gl.disable(gl.SCISSOR_TEST);
    // A new surface takes its first reading whole; after that each frame moves a time-based share toward
    // the new reading, so a scroll eases the shadow rather than stepping it.
    const ease = fresh ? 1 : 1 - Math.exp(-Math.max(0, dtSeconds) / SHADOW_EASE_SECONDS);
    if (ease >= 1) {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      gl.blendColor(0, 0, 0, ease);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    }
    this._useProgram(program.Program);
    gl.uniform1i(locs.scene, 0);
    gl.uniform1i(locs.backdrop, 1);
    gl.uniform2f(locs.resolution, this._width, this._height);
    gl.uniform4f(locs.rect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform1f(locs.detailLod, Math.max(0, detailLod));
    // `scene` is the canvas-sized sharp tap; `backdrop` is this surface's own pyramid, so only
    // the second needs the region map.
    const bxf = _regionOf(backdrop);
    gl.uniform4f(locs.backdropXf, bxf.ScaleX, bxf.ScaleY, bxf.OffsetX, bxf.OffsetY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(scene));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(backdrop));
    gl.bindVertexArray(this._quad.Vao);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.blendColor(0, 0, 0, 0);
    this.RebindSceneTarget();
    if (timed) this._pass!.End();
    return entry.Slot;
  };

  EndShadowBackdropFrame = (): void => {
    for (const [key, entry] of this._shadowSlots) {
      if (entry.Frame !== this._shadowFrame) {
        this._shadowSlots.delete(key);
        this._shadowFreeSlots.push(entry.Slot);
      }
    }
    this._shadowFrame++;
  };

  /** The adaptive-shadow probe used to compile on its first draw — which is the FIRST FRAME on
   *  any page with a shadowed surface, so a cold tab paid a full synchronous compile-and-link
   *  after everything else was already waiting on it. It joins the boot batch instead, where it
   *  overlaps the other twelve and costs the first frame nothing. A page that never measures a
   *  shadow now carries one more linked program it does not draw with, which is a few hundred
   *  kilobytes of driver state, not time. */
  private _compileShadowBackdropShader = (batch: ShaderBatch): void => {
    this._shadowShader = batch.Add(BLIT_VERT, shadowBackdropFragSrc);
  };

  private _wireShadowBackdrop = (gl: WebGL2RenderingContext): void => {
    const program = this._shadowShader;
    if (!program) return;
    this._shadowLocs = {
      scene: gl.getUniformLocation(program.Program, 'u_Scene'),
      backdrop: gl.getUniformLocation(program.Program, 'u_Backdrop'),
      resolution: gl.getUniformLocation(program.Program, 'u_Resolution'),
      rect: gl.getUniformLocation(program.Program, 'u_Rect'),
      detailLod: gl.getUniformLocation(program.Program, 'u_DetailLod'),
      backdropXf: gl.getUniformLocation(program.Program, 'u_BackdropXf'),
    };
    // 10-bit so a small per-frame ease still moves the stored value instead of rounding back to it.
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, SHADOW_STATE_SLOTS, 1, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._shadowStateTex = tex;
    this._shadowStateFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._shadowStateFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    // Hand the binding back. The lazy path this replaced ran mid-draw, where the very next line
    // rebound the scene target; at Init nothing follows it, and leaving a non-default framebuffer
    // bound out of boot is how a first frame ends up rendering into the wrong attachment.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let slot = SHADOW_STATE_SLOTS - 1; slot >= 0; slot--) this._shadowFreeSlots.push(slot);
  };

  // ── Progressive Blur ──

  DrawProgressiveBlur = (params: ProgressiveBlurParams): void => {
    const gl = this._gl;
    const p = this._progBlurShader.Program;
    // HARD in practice: the pyramid build that precedes it ends on a blur level or the default
    // framebuffer, so the bind back to the scene is a genuine attachment change.
    const timed = this._pass !== null && this._pass.Begin('pblur');

    this._useProgram(p);
    gl.uniform2f(this._progBlurLocs.resolution, this._width, this._height);
    gl.uniform4f(this._progBlurLocs.rect, params.Rect.X, params.Rect.Y, params.Rect.W, params.Rect.H);
    gl.uniform4f(this._progBlurLocs.rot,
      params.Cos ?? 1, params.Sin ?? 0, params.PivotX ?? 0, params.PivotY ?? 0);
    gl.uniform1i(this._progBlurLocs.scene, 0);
    gl.uniform1i(this._progBlurLocs.pyramid, 1);
    // The pyramid holds a REGION of the screen. The ramp, the feather and the clip all still
    // run in screen UV — only the two fetches map through this, and the cubic reconstruction
    // needs the pyramid's own texel grid rather than the canvas's.
    const pxf = _regionOf(params.Pyramid);
    gl.uniform4f(this._progBlurLocs.pyramidXf, pxf.ScaleX, pxf.ScaleY, pxf.OffsetX, pxf.OffsetY);
    gl.uniform2f(this._progBlurLocs.pyramidSize,
      pxf.TexelsX || this._width, pxf.TexelsY || this._height);
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
        ease[i] = stops[i].Easing <= BLUR_EASE_SMOOTH ? BLUR_EASE_SMOOTH : Math.max(0.001, stops[i].Easing);
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
    if (timed) this._pass!.End();
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
      this._tgt('default');
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
    this._tgt('snapshot');
    const timed = this._pass !== null && this._pass.Begin('snapshot');
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
    this._tgt('default');
    if (timed) this._pass!.End();
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

  /** Composite a raw FBO colour texture over the CURRENTLY-BOUND target at a
   *  device-px region (GL bottom-left origin), using the same textured-quad
   *  blit as `Blit`. The caller owns blend state (call `EnableBlend()` first)
   *  and restores the viewport afterwards. Used by the retained-mode layer
   *  cache to draw a captured static subtree over the live scene FBO without
   *  re-shading it. */
  BlitTextureRegion = (tex: WebGLTexture, x: number, y: number, w: number, h: number): void => {
    const gl = this._gl;
    gl.viewport(x, y, w, h);
    this._useProgram(this._blitShader.Program);
    gl.uniform1i(this._blitTexLoc, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
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
    // NB: do NOT call gl.getError() here — it forces a synchronous GPU pipeline
    // flush (~30ms on software ANGLE/WARP) on EVERY glyph upload. On a GPU-less
    // host that turns text-atlas population into multi-second stalls (~65 runs ×
    // ~30ms ≈ 2s, the dominant per-change hitch). texSubImage2D into a
    // shelf-packed atlas with pre-validated coords doesn't fail in practice.
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  // ── Render State ──

  EnableBlend = (): void => {
    const gl = this._gl;
    gl.enable(gl.BLEND);
    // RGB: straight source-over (visible result identical to before). Alpha:
    // accumulate COVERAGE (ONE, 1−SRC_ALPHA) instead of SRC_ALPHA·SRC_ALPHA. The
    // presented frame ignores scene-FBO alpha, so on screen this is byte-
    // identical — but it makes the retained-mode layer cache's captured-over-
    // transparent FBO hold correct premultiplied colour + coverage alpha, so the
    // premultiplied composite has no edge fringe at rounded corners.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  };

  DisableBlend = (): void => {
    this._gl.disable(this._gl.BLEND);
  };

  BindDefaultTarget = (clear?: { R: number; G: number; B: number }): void => {
    const gl = this._gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._tgt('default');
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
    this._tgt('scene');
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
    this._tgt('default');
    const timed = this._pass !== null && this._pass.Begin('present');
    gl.blitFramebuffer(
      0, 0, this._width, this._height,
      0, 0, this._width, this._height,
      gl.COLOR_BUFFER_BIT, gl.NEAREST, // NEAREST: 1:1 same-size copy, no filter cost
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (timed) this._pass!.End();
  };

  InvalidateFrameTransients = (persistScene = false): void => {
    const gl = this._gl;
    // Default framebuffer: we never touch depth for the final blit — tell
    // the driver not to bother preserving it. On tile-based mobile GPUs
    // (iPad, most Android) this prevents the depth tile memory from being
    // written out to main memory, a real bandwidth saving.
    // Note: default FB attachment names differ from FBO attachment names —
    // use DEPTH / STENCIL / COLOR, not DEPTH_ATTACHMENT / etc.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._tgt('default');
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH, gl.STENCIL]);
    // Scene FBO: we just blit it out; its contents won't be read again this
    // frame and the next BeginScenePass will clear it. Drop the tile.
    // Damage-region: when persisting, KEEP the scene colour so next frame can
    // composite the dirty rect over it instead of re-rendering everything.
    if (!persistScene) {
      this._sceneFbo.Bind();
      gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._tgt('default');
    }
  };

  SetViewport = (x: number, y: number, width: number, height: number): void => {
    this._gl.viewport(x, y, width, height);
  };

  // ── Shader Initialization ─────────────────────────────────────────────────

  private _compilePanelShader = (batch: ShaderBatch): void => {
    // Two compiled variants from one source. The `materialType` local in
    // Jiv.Panel.frag is a compile-time constant when either define is set,
    // so the GLSL dead-code-elimination strips every `if (materialType ==
    // 1.0)` branch in whichever direction doesn't match the variant. Non-
    // glass panels (~60% of screen pixels on Home) now run a shader with
    // no backdrop sampling, no refraction, no rim, no specular — just
    // fill + shadow + border.
    this._panelShaderGlass = batch.Add(panelVertSrc, panelFragSrc, { MATERIAL_GLASS: true });
    this._panelShaderNone  = batch.Add(panelVertSrc, panelFragSrc, { MATERIAL_NONE:  true });
  };

  private _wirePanelShader = (gl: WebGL2RenderingContext): void => {
    this._panelLocsGlass = _extractPanelLocs(gl, this._panelShaderGlass.Program);
    this._panelLocsNone  = _extractPanelLocs(gl, this._panelShaderNone.Program);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jaui] Failed to create panel instance buffer');
    this._panelInstanceBuffer = buf;

    // Dedicated VAO for panel rendering (separate from text)
    this._panelVao = this._createInstancedVao(gl, this._panelInstanceBuffer, PANEL_ATTR_COUNT, PANEL_BYTES_PER_INSTANCE);
  };

  private _compileTextShader = (batch: ShaderBatch): void => {
    this._textShader = batch.Add(textVertSrc, textFragSrc);
  };

  private _wireTextShader = (gl: WebGL2RenderingContext): void => {
    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jaui] Failed to create text instance buffer');
    this._textInstanceBuffer = buf;

    this._textResolutionLoc = gl.getUniformLocation(this._textShader.Program, 'u_Resolution');
    this._textViewOffsetLoc = gl.getUniformLocation(this._textShader.Program, 'u_ViewOffset');
    this._textAtlasLoc = gl.getUniformLocation(this._textShader.Program, 'u_Atlas');
    this._textClipTexLoc = gl.getUniformLocation(this._textShader.Program, 'u_ClipTex');
    this._textXformTexLoc = gl.getUniformLocation(this._textShader.Program, 'u_XformTex');

    // Dedicated VAO for text rendering (separate from panel)
    this._textVao = this._createInstancedVao(gl, this._textInstanceBuffer, TEXT_ATTR_COUNT, TEXT_BYTES_PER_INSTANCE);
  };

  private _compileStrokeShader = (batch: ShaderBatch): void => {
    this._strokeShader = batch.Add(strokeVertSrc, strokeFragSrc);
  };

  private _wireStrokeShader = (gl: WebGL2RenderingContext): void => {
    this._strokeLocs = _extractStrokeLocs(gl, this._strokeShader.Program);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jaui] Failed to create stroke instance buffer');
    this._strokeInstanceBuffer = buf;

    // Dedicated VAO (unit quad at loc 0 + 3 per-instance vec4 at locs 1..3)
    this._strokeVao = this._createInstancedVao(gl, this._strokeInstanceBuffer, STROKE_ATTR_COUNT, STROKE_BYTES_PER_INSTANCE);
  };

  private _compileSvgFillShader = (batch: ShaderBatch): void => {
    this._svgFillShader = batch.Add(svgFillVertSrc, svgFillFragSrc);
  };

  private _wireSvgFillShader = (gl: WebGL2RenderingContext): void => {
    const p = this._svgFillShader.Program;
    this._svgFillLocs = {
      resolution: gl.getUniformLocation(p, 'u_Resolution'),
      model0: gl.getUniformLocation(p, 'u_Model0'),
      model1: gl.getUniformLocation(p, 'u_Model1'),
      tint: gl.getUniformLocation(p, 'u_Tint'),
    };
    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jaui] Failed to create SVG fill vertex buffer');
    this._svgFillVertBuffer = buf;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('[Jaui] Failed to create SVG fill VAO');
    this._svgFillVao = vao;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // a_Vert = vec3(x, y, coverage) at location 0, tightly packed.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  };

  private _compileSvgStrokeShader = (batch: ShaderBatch): void => {
    this._svgStrokeShader = batch.Add(svgStrokeVertSrc, svgStrokeFragSrc);
  };

  private _wireSvgStrokeShader = (gl: WebGL2RenderingContext): void => {
    const p = this._svgStrokeShader.Program;
    this._svgStrokeLocs = {
      resolution: gl.getUniformLocation(p, 'u_Resolution'),
      model0: gl.getUniformLocation(p, 'u_Model0'),
      model1: gl.getUniformLocation(p, 'u_Model1'),
      tint: gl.getUniformLocation(p, 'u_Tint'),
      halfWidth: gl.getUniformLocation(p, 'u_HalfWidthDev'),
    };
    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jaui] Failed to create SVG stroke instance buffer');
    this._svgStrokeInstanceBuffer = buf;
    // Unit quad at loc 0 + 2 per-instance vec4 (a_Seg, a_Miter) at locs 1..2; stride 8 floats.
    this._svgStrokeVao = this._createInstancedVao(gl, this._svgStrokeInstanceBuffer, 2, 8 * 4);
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

  private _compileBlitShader = (batch: ShaderBatch): void => {
    this._blitShader = batch.Add(BLIT_VERT, BLIT_FRAG);
  };

  private _wireBlitShader = (gl: WebGL2RenderingContext): void => {
    this._blitTexLoc = gl.getUniformLocation(this._blitShader.Program, 'u_Tex');
  };

  private _clipMaskShader!: ShaderProgram;
  private _clipMaskDrawRectLoc!: WebGLUniformLocation | null;
  private _clipMaskClipRectLoc!: WebGLUniformLocation | null;
  private _clipMaskRadiusLoc!: WebGLUniformLocation | null;
  private _clipMaskSmoothnessLoc!: WebGLUniformLocation | null;
  private _clipMaskResLoc!: WebGLUniformLocation | null;
  private _compileClipMaskShader = (batch: ShaderBatch): void => {
    this._clipMaskShader = batch.Add(CLIP_MASK_VERT, CLIP_MASK_FRAG);
  };

  private _wireClipMaskShader = (gl: WebGL2RenderingContext): void => {
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

  private _compileProgBlurShader = (batch: ShaderBatch): void => {
    this._progBlurShader = batch.Add(PROGRESSIVE_BLUR_VERT, PROGRESSIVE_BLUR_FRAG);
  };

  private _wireProgBlurShader = (gl: WebGL2RenderingContext): void => {
    const p = this._progBlurShader.Program;
    this._progBlurLocs = {
      resolution: gl.getUniformLocation(p, 'u_Resolution'),
      rect: gl.getUniformLocation(p, 'u_Rect'),
      rot: gl.getUniformLocation(p, 'u_Rot'),
      scene: gl.getUniformLocation(p, 'u_Scene'),
      pyramid: gl.getUniformLocation(p, 'u_Pyramid'),
      pyramidXf: gl.getUniformLocation(p, 'u_PyramidXf'),
      pyramidSize: gl.getUniformLocation(p, 'u_PyramidSize'),
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
