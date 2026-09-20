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
import { JTrace, JMs, JauiTracing } from '../Diagnostics/Jaui.Trace';
import { Framebuffer, FramebufferPool } from './Framebuffer';
import { BlurPass, PyramidDepth, type ChainLimits } from './BlurPass';
import { PassTimers, type PassProfile } from './Pass.Timers';
import { QuadGeometry } from './Geometry.Quad';
import { PROGRESSIVE_BLUR_VERT, PROGRESSIVE_BLUR_FRAG } from '../ProgressiveBlur/ProgressiveBlur.Shader';
import { BLUR_EASE_SMOOTH } from '../Jiv/Jiv.Types';
import { SceneReadLedger } from './Scene.Ledger';

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


/** How far OUTSIDE the region it was asked for a backdrop pyramid can actually read its source.
 *
 *  Two terms, both exact, and both on the SOURCE side where the card composite has to have truth.
 *
 *  1. `ResolveRegionRect` snaps the region's origin DOWN to the downsample grid and its extent UP
 *     to the same grid, and `Jaui.ts` has already floored the origin and ceiled the extent before
 *     that. So the rect the pyramid is built over can sit up to one grid `phase` past the region.
 *  2. The first DOWN hop taps its source at +/- `u_HalfPixel * u_Offset` around a destination texel
 *     whose centre is one source texel inside the rect, and each tap is bilinear. `u_Offset` is
 *     clamped to 1.3, so the reach is 1.3 * 0.5 + 0.5 = 1.15 texels, rounded up to 2. Every later
 *     hop reads a region-sized level and cannot leave it, and the UP chain never touches the input.
 *
 *  `BeginCardComposite` rounds this UP to a whole number of phases and grows the card's box by it;
 *  `ComputeBlur` passes it as the reach its source has to cover. Without it the two coincide
 *  exactly -- on `glass-grid` the region's origin and the box's left edge are both
 *  `floor((px - 64.75) / 4) * 4`, the same number -- and the build's first hop reads one texel of
 *  whatever the snapshot texture happened to hold there. */
const CardReadGuard = (phase: number): number => phase + 2;

/** One glass surface's composite target. `X/Y/W/H` is its region in device px with y=0 at the TOP
 *  (the frame every caller here speaks); `Paint*` is the strictly smaller rect the surface can
 *  actually put ink in -- box plus shadow outset -- which is what a later surface replays. */
interface _CardTarget {
  Fbo: Framebuffer;
  X: number; Y: number; W: number; H: number;
  PaintX0: number; PaintY0: number; PaintX1: number; PaintY1: number;
  /** Has anything been DRAWN into it since it was seeded? While this is false the target still
   *  holds the frame snapshot's bytes verbatim, which is what lets the adaptive-shadow probe read
   *  the snapshot instead of paying a copy. A NESTED surface sees it true -- its parent's fill and
   *  children are already down -- and takes the copy, which is the only correct answer there. */
  Dirty: boolean;
}

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
    // The layer cache binds its own FBO from `Jaui.ts` and brackets the capture with this call, so
    // this is where the scene ledger learns that the draws in between are NOT scene writes. The
    // closing call passes (0, 0) and is followed immediately by `RebindSceneTarget`, which puts the
    // key back - so naming it 'cache' here is correct at both ends. Written STRAIGHT to the field,
    // not through `_tgt`: the pass timers never saw a target change here and a new one would move
    // a bracket's `Hard` flag, which would make this lane's counter edit a change to somebody
    // else's instrument. The SWITCH column is told by hand for the same reason: the capture's FBO
    // is a real non-scene target and its bind really does end the scene's encoder.
    this._boundTarget = 'cache';
    this._sceneLedger.NoteTargetBind('cache');
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
   *  real attachment change from an inherited target. The pass timer half is null-guarded (unarmed
   *  it costs one check); `_boundTarget` is set ALWAYS, because the scene read-after-write ledger
   *  ships and is not a diagnostic. */
  private _tgt = (key: string): void => {
    this._boundTarget = key;
    // Binding anything but the scene ENDS the scene's render encoder if the walk has drawn into it
    // since the last time it ended. That, not a read, is what a Metal driver stores and loads back
    // at `RebindSceneTarget`. The ledger decides which binds count; see `NoteTargetBind`.
    this._sceneLedger.NoteTargetBind(key);
    if (this._pass !== null) this._pass.SetTarget(key);
  };
  /** Which target this renderer's draw entry points are currently painting into. Every place that
   *  binds a framebuffer in THIS file calls `_tgt`; the two that bind one from outside it are the
   *  layer-cache capture (`SetCaptureViewOffset`, which brackets it) and BlurPass, whose own draws
   *  never come through this class's entry points. */
  private _boundTarget: string = 'default';
  private _sceneLedger = new SceneReadLedger();
  /** A draw is about to be issued: if it lands in the scene, the next scene read restarts the
   *  encoder. One string compare per draw CALL (not per instance - the panel and text paths are
   *  instanced, so this is a handful of compares a frame). */
  private _noteSceneDraw = (): void => {
    // A draw is about to land DIRECTLY in the scene, so every card target still waiting to be
    // written back has to land first or this draw would end up underneath a surface that paints
    // before it. The drain is blits, not draws, so it cannot recurse through here; see `_drainCards`.
    if (this._cardQueue.length !== 0 && this._boundTarget === 'scene') this._drainCards(true);
    // Ink is going down in the active card, so it no longer equals the snapshot over its region.
    if (this._boundTarget === 'card') { const c = this._activeCard; if (c !== null) c.Dirty = true; }
    if (this._boundTarget === 'scene') this._sceneLedger.NoteWrite();
  };
  /** Scene taps on the frame just walked, and the subset of them that followed a draw. Read by
   *  `Jaui.ts` into `_counts` the same way `GetFrameGpuMs` and `LastBlurDepth` are read. */
  get SceneReads(): number { return this._sceneLedger.Reads; }
  get SceneRestarts(): number { return this._sceneLedger.Restarts; }
  /** Encoder ENDS on the frame just walked - a non-scene target bound over a dirty scene. The column
   *  `?snap-once` did not move, and the one the surviving hypothesis multiplies. */
  get SceneSwitches(): number { return this._sceneLedger.Switches; }
  /** The same ends, named by the target that took them. An end prices by TARGET SIZE -- ~0.12 ms
   *  below the 6.4-9.2 MB cliff, 1.1-1.5 ms above it -- so a single scalar cannot say whether a
   *  design moved its ends onto small targets or merely counted fewer of them. Sums to
   *  `SceneSwitches`. */
  get SceneEndsByKey(): Record<string, number> { return this._sceneLedger.EndsByKey; }
  /** Cumulative totals for a windowed reader (the `?trace` gesture meter samples at both ends). */
  get SceneLedgerTotals(): { Reads: number; Restarts: number; Switches: number; Frames: number; EndsByKey: Record<string, number> } {
    const l = this._sceneLedger;
    return { Reads: l.TotalReads, Restarts: l.TotalRestarts, Switches: l.TotalSwitches, Frames: l.TotalFrames, EndsByKey: { ...l.TotalEndsByKey } };
  }
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
    this._blur = new BlurPass(gl, batch, this.DiagBlurChains ?? 1, this.DiagChainLimits ?? undefined);
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
    // The flag has to SAY it arrived. The M4 lost `?no-depth` once to an unquoted shell variable and
    // the reading looked perfectly reasonable; a reading taken with this mark absent is a reading of
    // the wrong build, and that is now checkable from the trace rather than from the command line.
    if (this.DiagSnapOnce) JTrace('jaui:snap-once armed=true pixels=WRONG');
    if (this.DiagBlurDummy) JTrace('jaui:blur-dummy armed=true pixels=WRONG');
    if (this.DiagBlurSrc !== null) JTrace(`jaui:blur-src armed=${this.DiagBlurSrc} pixels=WRONG`);
    if (this.DiagBlurFirst) JTrace('jaui:blur-first armed=true pixels=WRONG');
    // `pixels=DIFFERENT` and not `WRONG`: see `DiagBlurPhased`. The ceilings ride the same line,
    // because a phased arm read under the SHIPPED pool is twenty builds sharing one chain -- a
    // different experiment wearing this flag's name.
    if (this.DiagBlurPhased) {
      const lim = this.DiagChainLimits;
      JTrace('jaui:blur-phased armed=true pixels=DIFFERENT'
        + ` chains=${this.DiagBlurChains ?? 1}`
        + ` max=${lim === null ? 'default' : lim.MaxChains}`
        + ` budget=${lim === null ? 'default' : Math.round(lim.BudgetBytes / (1024 * 1024)) + 'MB'}`);
    }
    // No `pixels=WRONG` on this one, and the omission is the claim: the rotation is
    // pixel-identical by construction, so the two-arm `glassshot` diff must read exactly 0.
    if (this.DiagBlurChains !== null) JTrace(`jaui:blur-chains armed=${this.DiagBlurChains}`);
    // The card composite is OFF by default and `?cardcomposite` turns it on, so the mark carries
    // the same contract as the three above it: a reading of the composite walk WITHOUT this line is
    // a reading of the wrong build. No `pixels=WRONG` -- this one is pixel-identical by
    // construction (<= 115 single-LSB rasterisation ties on win32, byte-identical on Metal).
    if (this.CardCompositeEnabled) JTrace('jaui:cardcomposite armed=true');

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
    if (width !== this._width || height !== this._height) {
      // Every card target is keyed on a region of the OLD canvas and the frame snapshot is the old
      // canvas's whole surface. Both are re-made on demand at the new size.
      this._cardPool?.Dispose();
      this._cardQueue.length = 0;
      this._cardStack.length = 0;
      this._frameSnapValid = false;
      this._sceneDirectRects.length = 0;
    }
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
    // Ahead of the early return below, which skips the whole-frame query on a per-pass split frame:
    // the scene ledger is not a timer and must reset on EVERY frame or a split frame would report
    // the previous frame's restarts.
    this._sceneLedger.BeginFrame();
    this._snapOnceTaken = false;
    // Same reason the ledger resets here rather than below: a split frame returns early, and a card
    // target left over from the previous frame would be seeded from a snapshot of a frame that no
    // longer exists. Nothing should be pending -- the walk flushes at the end -- but a throw inside
    // the tree walk (`Jaui.ts` catches the first three) can leave one, so this is a reset and not an
    // assertion. The pool keeps the textures; only the bookkeeping is dropped.
    if (this._cardQueue.length !== 0) { for (const c of this._cardQueue) this._cardPool?.Release(c.Fbo); this._cardQueue.length = 0; }
    if (this._cardStack.length !== 0) { for (const c of this._cardStack) this._cardPool?.Release(c.Fbo); this._cardStack.length = 0; }
    this._frameSnapValid = false;
    this._sceneDirectRects.length = 0;
    this._cardComposites = 0;
    this._cardFallbacks = 0;
    this._cardBlitPixels = 0;
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

  /** `?blur-chains`'s gate, on the trace channel, printed when the SHAPE changes rather than every
   *  frame -- so a steady glass-grid prints one line. The line the reading depends on: `armed=2`
   *  with two chains resident is a rotation that never happened, and a cell taken under it would
   *  publish the baseline under the flag's name. Refusals print themselves, from the pass. */
  private _blurChainsGate = (): void => {
    let line = `jaui:blur-chains armed=${this.DiagBlurChains}`;
    line += this._blurChainsCensus('blur', this._blur);
    line += this._blurChainsCensus('root', this._rootBlur);
    line += this._blurChainsCensus('shared', this._sharedBlur);
    if (line === this._blurChainsLine) return;
    this._blurChainsLine = line;
    JTrace(line);
  };

  private _blurChainsCensus = (tag: string, pass: BlurPass | null | undefined): string => {
    if (pass === null || pass === undefined) return '';
    const c = pass.ChainCensus;
    const sizes = c.Sizes === '' ? 'none' : c.Sizes;
    const refused = c.Refused === null ? '' : ` ${tag}-refused=${c.Refused}`;
    // `max`/`mb` are what makes a RAISED ceiling checkable: a phased arm that quietly ran under
    // the shipped six would print `max=6` here and the cell would be void.
    return ` ${tag}=${c.Resident}@${c.Live}/${c.Max}:${sizes}:${c.ResidentMb}of${c.BudgetMb}MB${refused}`;
  };

  /** Close the per-pass frame and harvest. Also drains the whole-frame ring, because the reference
   *  half of the reading is those queries and nothing else polls them unless the HUD is on. */
  private _endPassFrame = (): void => {
    if ((this.DiagBlurChains !== null || this.DiagBlurPhased) && JauiTracing()) this._blurChainsGate();
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

  get SceneTexture(): GpuTextureHandle {
    // `?snap-once` (measurement only) swaps every backdrop read onto one full-canvas snapshot taken
    // at the frame's FIRST read. The pixels are wrong on purpose - a later surface no longer sees
    // the glass drawn under it - and the flag exists to be measured, never shown. See `DiagSnapOnce`.
    // `?blur-dummy` first: under it nothing may hand out the scene attachment, or the adaptive
    // shadow's sharp tap would be a scene READ and the cell would stop being about switches alone.
    if (this.DiagBlurDummy) return this._blurDummyTexture();
    if (this.DiagSnapOnce) return this._snapOnceTexture();
    // Inside a card composite the surface's backdrop IS the card target: it was seeded with the
    // frame snapshot's pixels for this region and replayed over with every earlier surface that
    // paints into it, so it holds exactly what the scene held here. See `BeginCardComposite`.
    const card = this._activeCard;
    if (card !== null) return _wrap(card.Fbo.Texture);
    // A surface that FELL BACK to the in-scene path is about to sample the attachment, and the
    // surfaces before it may still be sitting in card targets. Land them first or this one's
    // backdrop would be missing every card in the queue. See `_drainCards`.
    if (this._cardQueue.length !== 0) this._drainCards(true);
    return _wrap(this._sceneFbo.Texture);
  }
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
    this._noteSceneDraw();
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
    this._noteSceneDraw();
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
    this._noteSceneDraw();
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
    this._noteSceneDraw();
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
    this._noteSceneDraw();
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

  /** `?snap-once` (MEASUREMENT ONLY - WRONG PIXELS). Serve every backdrop read in the frame from ONE
   *  full-canvas snapshot taken at the frame's first read, instead of from `_sceneFbo` itself.
   *
   *  What it removes and nothing else: the scene encoder restarts. Every pyramid still builds, at its
   *  own region, sigma and depth; every panel, glass, rim, text and pblur draw still happens;
   *  `RebindSceneTarget` still runs; the draw count does not move (a snapshot is a `blitFramebuffer`,
   *  not a draw). So this is NOT `?no-blur` with a different name - the arithmetic and the fill are
   *  identical and only the read-after-write is gone, which is exactly the term the 2^3 factorial
   *  could not separate from the components it interacts with.
   *
   *  The picture under it is WRONG: a later surface no longer refracts the glass drawn beneath it,
   *  because its backdrop is the scene as of the first read. `SceneRestarts` reads 1 under this flag
   *  and that is the whole point of it. Never ship it, never screenshot it. */
  DiagSnapOnce = false;

  /** `?blur-dummy` (MEASUREMENT ONLY - WRONG PIXELS). Draw every card over the REAL bed with NO
   *  render-target switch between them.
   *
   *  `?snap-once` removed the scene READS and the frame did not get cheaper (72.85 -> 73.59 GPU ms on
   *  `glass-grid`), which killed read-after-write as the mechanism. What it did NOT remove is the
   *  encoder BOUNDARY: every pyramid build binds the blur FBOs between one card's draw and the next,
   *  so the scene's Metal encoder still ended and restarted ~40 times with the bed stored and loaded
   *  back each time. This flag removes the boundary instead of the read. `ComputeBlur` and
   *  `GenerateBlurMipmap` issue NO GL and hand back a 1x1 opaque mid-grey texture over the identity
   *  region; `SnapshotScreen` returns the same texture without blitting; `SceneTexture` returns it so
   *  the adaptive shadow's sharp tap reads it too.
   *
   *  What it KEEPS, and the reason it is not `?no-blur` under another name: EVERY DRAW STILL HAPPENS.
   *  The dummy is not the scene's own attachment, so no glass draw is a rendering feedback loop and
   *  none is refused - `rejectedDraws` must read 0 and the worker census 0, where `?no-blur` refuses
   *  all forty. The bed is real, six bands, busy. The panel/rim/text fill is unchanged; only the
   *  pyramid's own fill and its target binds are gone.
   *
   *  The picture is WRONG: every card's backdrop is flat grey. Never ship it, never screenshot it. */
  DiagBlurDummy = false;
  /** The 1x1 opaque mid-grey `?blur-dummy` hands to every backdrop consumer. Mid-grey so the glass
   *  shader's grade, rim and refraction still have something with a value in it to work on - a black
   *  texture would put the fill on a different arithmetic path in `applyGrading`. LINEAR min filter
   *  and no mip chain: with a non-mipmap min filter a `textureLod` at any LOD resolves to level 0,
   *  which is what makes one texel a legal answer to a frost LOD of 3. */
  private _blurDummyTex: WebGLTexture | null = null;
  /** Whether this frame's one snapshot has been taken yet. Reset in `BeginFrame`. */
  private _snapOnceTaken = false;

  /** The dummy, built on first ask. No region: like `?no-blur`'s passthrough handle it covers the
   *  whole canvas, so every consumer's backdrop transform is the identity. */
  private _blurDummyTexture = (): GpuTextureHandle => {
    if (this._blurDummyTex) return _wrap(this._blurDummyTex);
    const gl = this._gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('[Jaui] failed to create the ?blur-dummy texture');
    this._blurDummyTex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([128, 128, 128, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Built LAZILY so an unflagged run creates nothing, which costs one binding on whichever unit
    // happened to be active when the first card asked. Unbound rather than left dangling; every
    // consumer of a backdrop handle binds all six of its own units before it draws, and this runs
    // once per context on the first frame, far ahead of any measured window.
    gl.bindTexture(gl.TEXTURE_2D, null);
    return _wrap(tex);
  };

  /** The one snapshot `?snap-once` serves every read from. The first call in a frame takes a FULL
   *  canvas blit (no scissor - a later surface may sample anywhere); every call after it hands back
   *  the same texture with no GL work at all. */
  private _snapOnceTexture = (): GpuTextureHandle => {
    if (this._snapOnceTaken && this._snapshotTex) return _wrap(this._snapshotTex);
    this._snapOnceTaken = true;
    return this._snapshotBlit(undefined);
  };

  /** `?blur-src-static` / `?blur-src-clear` (MEASUREMENT ONLY - WRONG PIXELS). Change WHICH TEXTURE
   *  the backdrop pyramid's DOWN pass samples, and nothing else in the frame.
   *
   *  What the ledger narrowed to: a pyramid build over a source holding WRITTEN content costs
   *  ~0.9 ms (`glass-grid`, ~72 GPU ms whether the bed is busy, flat, snapshotted, or the ends are
   *  40 or 1), while 39 builds over a CLEARED scene cost 13.80 total and no builds at all cost
   *  34.32. Read-after-write, compressibility, residency and encoder ends are each dead by their own
   *  controlled experiment. Two mechanisms remain and nothing so far separates them:
   *
   *    H1  the READ itself. Sampling a region out of a 16 MB texture with the DOWN pass's bilinear
   *        taps costs bandwidth and cache misses; a cleared texture never touches memory. Predicts
   *        the cost follows the SOURCE's size, and a texture written once reads as expensively as
   *        one written this frame -> `static` stays at ~72.
   *    H2  a same-frame WRITE -> SAMPLE hazard: before a texture this frame's render pass or blit
   *        wrote is sampled, the driver services a sync, a layout conversion or a decompression, per
   *        transition rather than per texel -> `static` falls to ~35.
   *
   *  `static` is a canvas-sized RGB10_A2 texture - the scene target's own format, filtering and size
   *  - holding a blit of frame 1 and never written again. `clear` is the same texture cleared once
   *  to opaque black and never written, which reproduces the `?no-panels` cell WITHOUT removing the
   *  bed's draws (that cell removed work as well as content, which is the last gap in its reading).
   *
   *  The pixels are WRONG by design under both: a static backdrop shows frame 1 while the bed moves
   *  under it, a cleared one shows blurred black. Never ship, never screenshot.
   *
   *  Checked AFTER `?no-blur` and `?blur-dummy` at every site, because every table in the perf
   *  ledger is read under those two flags' current meaning and neither may shift by a line. */
  DiagBlurSrc: 'static' | 'clear' | null = null;

  /** `?blur-first` (MEASUREMENT ONLY - WRONG PIXELS). The ORDER test. Set by `Core/Jaui.ts`, which
   *  owns the flag, the pre-pass and every decision about whether the flag may arm at all; this
   *  renderer's only part in it is to SAY the flag arrived, in `Init`, beside the other three
   *  measurement marks. A reading taken with this mark absent is a reading of the wrong build.
   *
   *  Nothing in this file reads it. It is here rather than left on `Jaui` because the marks are
   *  emitted where the scene FBO is built, and a mark that lived somewhere else would be the one
   *  mark a reader had to go looking for. */
  DiagBlurFirst = false;

  /** `?blur-phased` (MEASUREMENT ONLY - DIFFERENT PIXELS). The COUNT test. Set by `Core/Jaui.ts`,
   *  which owns the flag, the phased walk and every refusal; this renderer's part is to SAY the
   *  flag arrived, in `Init`, beside the other measurement marks, and to hand the pool the raised
   *  ceilings a phased frame needs (`DiagChainLimits`).
   *
   *  `pixels=DIFFERENT`, not `WRONG`. Phasing the walk is a legitimate composition that every fill
   *  pyramid is built from the bed alone instead of from the bed plus its earlier neighbours'
   *  glass; the difference is confined to the sample-margin overlap along each card's inner edges
   *  and it is Jack's call whether it is acceptable. Under `?blur-src-clear` / `-static` the
   *  difference vanishes entirely (every build reads the same stand-in) and the arm is a pure
   *  count test. */
  DiagBlurPhased = false;

  /** Per-pass residency ceilings for the three `BlurPass` instances, or `null` for the shipped
   *  `MAX_CHAINS` / `CHAIN_BUDGET_BYTES`. Only `?blur-phased` sets it, and only because twenty
   *  fill pyramids have to be alive at once. Handed in at construction and never mutated, so
   *  there is nothing to restore when the flag is off -- an unflagged process never builds a pass
   *  that carries it. */
  DiagChainLimits: ChainLimits | null = null;

  /** `?blur-chains=N` (MEASUREMENT ONLY - PIXEL-IDENTICAL). How many chains each `BlurPass` keeps
   *  per level-0 size, handed out round-robin per build so consecutive builds of a size never
   *  share one. `null` is the flag ABSENT and 1 is the flag given as 1; both run the shipped pool,
   *  and the difference between them is only that the second says so on the trace. Set by
   *  `Core/Jaui.ts`, which owns the flag and every refusal; this renderer hands it to the three
   *  passes at construction and prints the census.
   *
   *  No `pixels=WRONG`. A chain's contents are per-build -- every level a consumer can reach is
   *  written by the build that hands the texture over -- so which chain a build lands on cannot
   *  change a texel. See `BlurPass._useChain` and `tests/Blur.Chains.test.ts`. */
  DiagBlurChains: number | null = null;
  private _blurChainsLine = '';
  private _blurSrcTex: WebGLTexture | null = null;
  private _blurSrcFbo: WebGLFramebuffer | null = null;
  private _blurSrcW = 0;
  private _blurSrcH = 0;
  private _blurSrcFilled = false;

  /** The stand-in texture, or null when there is nothing to stand in with yet and the caller must
   *  take the baseline path: the flag is off, the one-time fill has not run (frame 1, and the frame
   *  a resize lands on), or the canvas has since changed size. */
  private _blurSrcSubstitute = (): WebGLTexture | null => {
    if (this.DiagBlurSrc === null || !this._blurSrcFilled || this._blurSrcTex === null) return null;
    if (this._blurSrcW !== this._width || this._blurSrcH !== this._height) return null;
    return this._blurSrcTex;
  };

  /** The texture to sample in place of `src`. Substitutes only for the three CANVAS-SIZED textures
   *  that carry scene content - the scene attachment, the snapshot and the frame snapshot the card
   *  composite cuts its seeds from - so the stand-in is always the same size as what it replaces and
   *  every uniform the build and its consumer compute stays on the same floating-point values. A
   *  caller sampling anything else is measuring something else and is left alone. */
  private _blurSrcFor = (src: WebGLTexture): WebGLTexture => {
    const sub = this._blurSrcSubstitute();
    if (sub === null) return src;
    if (src !== this._sceneFbo.Texture && src !== this._snapshotTex && src !== this._frameSnapTex) return src;
    return sub;
  };

  /** Build and fill the stand-in, once per context and once per canvas size.
   *
   *  Called from `PresentScene` immediately after `NoteFrameEndDrain`, and that instant is the whole
   *  reason the fill lives there rather than at the first read. It is the one point in the frame
   *  where the scene ledger's switch flag is provably drained, so the framebuffer binds below book
   *  ZERO encoder ends - `EndsByKey`, `SceneSwitches` and `SceneRestarts` come out byte-identical to
   *  baseline on the fill frame as on every other, which is exactly what a measurement flag has to
   *  be able to claim. It also means the `static` arm holds a WHOLE frame (bed plus every card),
   *  which is the content a real backdrop read sees, rather than the bed alone that a fill at the
   *  first `ComputeBlur` would have caught.
   *
   *  The cost of that choice: frame 1 takes the baseline path, because the texture does not exist
   *  until the end of it. One frame of a multi-second window, far outside any steady-state reading.
   *
   *  Raw GL, no `_tgt`: `_tgt` is the ledger's booking call and booking this would be booking a
   *  frame the flag is not measuring. The binds are left where `PresentScene` is about to put them
   *  anyway, one line later. */
  private _fillBlurSrcOnce = (): void => {
    const gl = this._gl;
    const W = this._width, H = this._height;
    if (W <= 0 || H <= 0) return;
    if (this._blurSrcFilled && this._blurSrcTex !== null && this._blurSrcW === W && this._blurSrcH === H) return;
    if (this._blurSrcTex !== null) gl.deleteTexture(this._blurSrcTex);
    if (this._blurSrcFbo !== null) gl.deleteFramebuffer(this._blurSrcFbo);
    // RGB10_A2 with LINEAR/LINEAR and CLAMP_TO_EDGE: the scene target's format and the snapshot's,
    // to the letter. A different internal format or filter would change what the DOWN pass's taps
    // cost and the flag would be measuring its own texture rather than the read.
    const tex = gl.createTexture();
    if (!tex) throw new Error('[Jaui] failed to create the ?blur-src texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, W, H, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('[Jaui] failed to create the ?blur-src framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    // Both a clear and a blit are scissored, and the walk's scissor state at end of frame is not
    // this method's to assume. Saved and restored rather than forced, so the flag cannot change the
    // state the present inherits.
    const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissorOn) gl.disable(gl.SCISSOR_TEST);
    if (this.DiagBlurSrc === 'clear') {
      // Opaque black, and CLEARED rather than written: on a driver that keeps fast-clear metadata a
      // cleared attachment never touches memory, which is the state `?no-panels` was accidentally
      // measuring and the state this arm reproduces with the bed's draws left in.
      const prev = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.clearColor(prev[0], prev[1], prev[2], prev[3]);
    } else {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._sceneFbo.Framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    if (scissorOn) gl.enable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._blurSrcTex = tex;
    this._blurSrcFbo = fbo;
    this._blurSrcW = W;
    this._blurSrcH = H;
    this._blurSrcFilled = true;
    JTrace(`jaui:blur-src filled=${this.DiagBlurSrc} ${W}x${H} pixels=WRONG`);
  };

  ComputeBlur = (
    input: GpuTextureHandle, width: number, height: number,
    radius: number, minDepth?: number,
    region?: { x: number; y: number; w: number; h: number },
  ): GpuTextureHandle => {
    // The diagnostic hands back the canvas-sized scene, which screen UV addresses directly —
    // so it comes back with no region, and every consumer's transform is the identity.
    //
    // It does NOT count as a scene read, and the distinction is the whole of `?no-blur`'s meaning:
    // under the diagnostic this method issues no GL at all, so nothing is sampled here. What the
    // CALLER then does with the handle is a different question, and section 3 of
    // WorkerReports/build-sceneraw.md answers it - the glass draw binds this same texture as
    // `u_Backdrop` while rendering INTO it, which is a rendering feedback loop the WebGL spec
    // requires be rejected.
    if (this.DiagNoBlur) return input;
    // `?blur-dummy`: no GL, and NOT the input either. Returning the input is what makes `?no-blur`'s
    // glass draws a feedback loop; returning a foreign texture is what lets every draw land.
    if (this.DiagBlurDummy) return this._blurDummyTexture();
    if (_unwrap(input) === this._sceneFbo.Texture) this._sceneLedger.NoteRead();
    const pass = radius > 0
      ? this._blur
      : (this._rootBlur
        ?? (this._rootBlur = this._tagBlur(
          new BlurPass(this._gl, undefined, this.DiagBlurChains ?? 1, this.DiagChainLimits ?? undefined), 'root')));
    this._lastBlur = pass;
    // BlurPass binds its own level FBOs and draws into them, and it does it with raw GL that never
    // passes through `_tgt`. So the switch is noted HERE, once per build: the encoder ends at the
    // first level bind and the rest of the pyramid is on the far side of it. The ledger's own dirty
    // flag makes the repeat calls free, so this line is the build, not the binds.
    this._sceneLedger.NoteTargetBind('blur');
    // ── Card composite: the pyramid's source is the CANVAS-SIZED SNAPSHOT, never the card ──
    // A surface inside a composite reads its backdrop out of its own card target. The pyramid must
    // NOT be built from that target, and the reason is arithmetic rather than texels.
    //
    // Building it from the card was tried and MEASURED (Jaui 1971251, the pixel gate): the seed,
    // the neighbour replay and the write-back came back bit-exact, and 4,057 pixels at channel
    // delta 1 appeared inside the twenty card boxes and nowhere else. Every uniform the build and
    // its consumer use is computed from the INPUT's dimensions -- `u_SrcRect` is
    // `rect.X / srcW`, `u_HalfPixel` is `0.5 / srcW`, `LastRegion` is `width / rect.W` and
    // `-rect.X / rect.W`, and the panel shader taps through the `u_BackdropXf` built out of those.
    // A 568x436 source puts every one of them on different floating-point values than a 2560x1600
    // one. Same texels, one-ulp-apart bilinear weights, a scattered 1 LSB. The grid law and the
    // pinned `k` made the pyramid sample the right texels; nothing can make it round the same way
    // except giving it the same numbers.
    //
    // So the card's pixels are resolved to a CANVAS-SIZED texture at their SCREEN position first
    // (`_cardBackdropSource`), and what follows is the in-scene call with the in-scene arguments:
    // the canvas's width and height, the ORIGINAL screen region, no pinned base factor -- so
    // `BaseDownsampleFactor` measures against the canvas again and picks what it always picked --
    // and `pass.LastRegion` returned unmapped, because it is already in screen UV. Byte-for-byte
    // the same call on a texture holding the same texels.
    const blurCard = this._activeCard;
    if (blurCard !== null && _unwrap(input) === blurCard.Fbo.Texture) {
      if (region === undefined) {
        // A full-input pyramid reads the WHOLE canvas, and a composite has truth only over its own
        // box. Both callers that can reach here pass a region (the glass fill and the glass rim);
        // a third that does not is a wrong picture, and a wrong picture says so.
        throw new Error('[Jaui] a card composite cannot build a full-canvas pyramid: pass a region');
      }
      let src = this._cardBackdropSource(blurCard, region, CardReadGuard(this._cardGridPhase));
      // `?blur-src-*` swaps the SAMPLED texture and leaves the resolve above untouched: the copy,
      // its blit traffic and its encoder end all still happen, so the only thing that moves between
      // the two arms is the read. Reassigned rather than wrapped into the call, so the call below
      // stays the byte-for-byte baseline call the card composite's own gates pin.
      src = this._blurSrcFor(src);
      const result = pass.Blur(src, this._width, this._height, radius, minDepth, region);
      this._lastProgram = null;
      return _wrap(result, pass.LastRegion);
    }
    // `?blur-src-*`, after `?no-blur` and `?blur-dummy` and after the ledger has booked the read and
    // the build: the DOWN pass reads the stand-in instead of `input`. The HANDLE is swapped, not the
    // call, so the region rides across unchanged and `pass.Blur` below is the baseline line.
    if (this.DiagBlurSrc !== null) input = _wrap(this._blurSrcFor(_unwrap(input)), _regionOf(input));
    const result = pass.Blur(_unwrap(input), width, height, radius, minDepth, region);
    // BlurPass calls `gl.useProgram` internally with its own shaders,
    // bypassing our program cache. Invalidate so the next Panel/Text
    // draw re-binds its program correctly.
    this._lastProgram = null;
    return _wrap(result, pass.LastRegion);
  };

  GenerateBlurMipmap = (maxLod?: number): void => {
    if (this.DiagNoBlur) return;
    if (this.DiagBlurDummy) return;
    // Same reason as `ComputeBlur`: BlurPass binds mip targets this class never sees. In practice
    // this call always follows a `ComputeBlur` with no scene draw between them, so the flag is
    // already clear and it books nothing - which is the correct answer and the reason the column is
    // "encoder ends" and not "framebuffer binds".
    this._sceneLedger.NoteTargetBind('blur');
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
    const pass = this._sharedBlur
      ?? (this._sharedBlur = this._tagBlur(
        new BlurPass(this._gl, undefined, this.DiagBlurChains ?? 1, this.DiagChainLimits ?? undefined), 'shared'));
    // radius 0 → level 0 is the raw scene (1-tap copy, no dual-filter pre-blur);
    // GenerateOutputMipmap then builds the Gaussian stack from that sharp root.
    // Quarter-res build: blur is low-frequency, so a 1/4-res pyramid upsamples to
    // a visually identical result with ~16x less fragment fill. Consumers add +2
    // to their frost LOD (this pyramid's level 0 ≈ a full-res pyramid's LOD 2).
    const qw = Math.max(1, width >> 2), qh = Math.max(1, height >> 2);
    if (this._cardQueue.length !== 0) this._drainCards(true);
    this._sceneLedger.NoteRead();
    this._sceneLedger.NoteTargetBind('blur');
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

    // The probe samples `u_Scene` in SCREEN UV over a canvas-sized texture, strictly inside `rect`
    // (its taps are `u_Rect.xy + cell * u_Rect.zw`, cell in [0,1)). A card target is neither
    // canvas-sized nor screen-addressed, so it is resolved to one that is: the frame snapshot when
    // no earlier surface in this run painted into `rect` -- the whole of `glass-grid`, where a
    // 32 px shadow outset cannot cross a 40 px gutter -- and otherwise a copy of the card into its
    // screen position. Same pixels either way; the first is free. RESOLVED HERE, ahead of the
    // state-target bind below, because the copy path binds framebuffers of its own.
    const probeCard = this._activeCard;
    let sharp = _unwrap(scene);
    if (probeCard !== null && sharp === probeCard.Fbo.Texture) sharp = this._cardSharpTap(probeCard, rect);
    // `?blur-src-*`: the probe's sharp tap is a scene read too, and leaving it on the live
    // attachment would leave one path in the frame still sampling a this-frame-written texture -
    // which is the exact thing the two flags exist to remove. The resolve above and the ledger's
    // own note below both stay where they are; only the bound texture moves.
    sharp = this._blurSrcFor(sharp);

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
    // The sharp tap is the scene's own attachment whenever the surface took no snapshot (every
    // frosted class does exactly that), so this probe is a scene READ. It is rarely a RESTART: it
    // runs immediately after the surface's `ComputeBlur`, which already ended the encoder.
    if (_unwrap(scene) === this._sceneFbo.Texture) this._sceneLedger.NoteRead();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sharp);
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
    this._noteSceneDraw();
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
    // `?snap-once`: the frame's FIRST read takes one full-canvas blit and every read after it gets
    // that same texture, scissor ignored. Measurement only; see `DiagSnapOnce`.
    if (this.DiagBlurDummy) return this._blurDummyTexture();
    if (this.DiagSnapOnce) return this._snapOnceTexture();
    // Inside a card composite the live scene does not hold this surface's backdrop -- the card
    // target does -- so the sharp tap is copied out of the card, INTO ITS SCREEN POSITION in the
    // canvas-sized snapshot texture. Consumers (`u_Scene` on the panel and the progressive blur)
    // address that texture in screen UV and go on doing so. Everything outside the copied rect is
    // last frame's, exactly as it already was for a scissored snapshot.
    const snapCard = this._activeCard;
    const snapped = snapCard !== null ? this._cardIntoSnapshot(snapCard, scissor) : this._snapshotBlit(scissor);
    // `?blur-src-*` substitutes the RETURN, not the work: the blit above still runs, still reads the
    // scene, still books its `snapshot` end. Swapping the handle rather than skipping the copy is
    // what keeps `EndsByKey` and every other counter identical to baseline while no consumer -
    // pyramid source, `u_Scene` sharp tap or shadow probe - samples a texture this frame wrote.
    // Both flagged textures are canvas-sized with no region, exactly as the snapshot handle is.
    const sub = this._blurSrcSubstitute();
    return sub === null ? snapped : _wrap(sub);
  };

  /** Make `_snapshotTex` exist at the canvas's current size. Split out of `_snapshotBlit` because
   *  the card composite's own copy-out (`_cardIntoSnapshot`) writes into the same texture and must
   *  not carry a second, drifting copy of its lifecycle. RGB10_A2 to match the (now 10-bit) scene
   *  FBO -- a blit down to 8-bit here would re-band the progressive blur's input. Same 32 bpp. */
  private _ensureSnapshotTexture = (): WebGLTexture => {
    const gl = this._gl;
    if (this._snapshotTex && this._snapshotW === this._width && this._snapshotH === this._height) return this._snapshotTex;
    if (this._snapshotTex) gl.deleteTexture(this._snapshotTex);
    if (this._snapshotFbo) gl.deleteFramebuffer(this._snapshotFbo);
    this._snapshotTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this._snapshotTex);
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
    return this._snapshotTex;
  };

  /** The snapshot blit itself. Split out of `SnapshotScreen` so `?snap-once` can call it exactly
   *  once a frame with no scissor without duplicating the texture lifecycle. */
  private _snapshotBlit = (scissor?: { x: number; y: number; w: number; h: number }): GpuTextureHandle => {
    const gl = this._gl;
    // Same reason as `SceneTexture`: a pending card is not in the scene yet, and a snapshot taken
    // over it would hand a progressive blur a backdrop with the glass missing.
    if (this._cardQueue.length !== 0) this._drainCards(true);
    const snap = this._ensureSnapshotTexture();
    // Copy sceneFbo → snapshot texture via blit. The scene FBO is where the
    // tree walk renders now (via BeginScenePass); the default framebuffer
    // stays empty until the final Blit at end-of-frame. Reading from
    // sceneFbo avoids the feedback-loop issue for progressive blur's
    // `u_Scene` uniform — pblur needs a separate texture it can safely
    // sample while rendering into sceneFbo itself.
    this._sceneLedger.NoteRead();
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
    return _wrap(snap);
  };


  // -- Card composite with neighbour replay -----------------------------------------------------
  //
  // `ShowStudio.Documentation/Perf/SceneRaw.Finding.md` 4(c), and the mechanism the M4 resolved on
  // 2026-09-19: the frame's cost is the number of times the SCENE target's Metal render encoder
  // ENDS while the bed is in it. Forty ends were ~50-60 of a 73 ms frame at dpr 2 (switches
  // 40 -> 20 -> 0 gave 72.85 -> 34.32 -> 11.32 GPU ms, two points through the origin). Every end
  // stores 16 MB of tiles and loads them back at ~1.1-1.5 ms.
  //
  // What ends it at baseline is not a READ -- `?snap-once` took reads 40 -> 1 and the frame did not
  // move -- it is the BIND: each surface's `ComputeBlur` binds the first blur level FBO between one
  // card's draws and the next, twice per card (fill and rim overlay). So the scene render pass
  // becomes the bed, once, and after that the scene is only ever touched by region BLITS.
  //
  // Per glass surface, in walk order:
  //   1. SEED a region-sized target with the frame SNAPSHOT's pixels for that region -- one
  //      full-canvas snapshot per frame, taken at the first backdrop read, which is the frame's ONE
  //      scene-encoder end.
  //   2. REPLAY, in ascending walk order, the overlapping part of every EARLIER surface's own
  //      composite target whose PAINT rect reaches into this region. Later wins where two overlap,
  //      which is the order the scene composited them.
  //   3. Build the pyramid from a CANVAS-SIZED texture holding the seeded target's bytes at their
  //      screen position (`_cardBackdropSource`), with the screen region and the canvas's own
  //      dimensions -- the in-scene call, unchanged. Building it from the card target instead was
  //      tried, and its uniforms round differently: see the card branch of `ComputeBlur`.
  //   4. Draw the fill, the children and the rim overlay INTO the card target, under a retargeted
  //      projection (`SetCaptureViewOffset` + `u_Resolution`; `v_PixelPos` stays screen space, so
  //      the clip stack and the xform table are untouched -- the layer cache already proves it).
  //   5. Queue the WRITE-BACK. It is a blit, and it is deferred to the first thing that draws
  //      directly into the scene (`_noteSceneDraw`) or to the end of the frame, because performing
  //      it eagerly would re-dirty the scene and make the NEXT card's seed bind an encoder end.
  //
  // Identity: the scene is opaque (`BeginScenePass` clears alpha 1, the canvas fills its
  // background), so SRC_ALPHA / ONE_MINUS_SRC_ALPHA over a seed equal to the scene's stored bytes
  // gives exactly the bytes the scene would have held, the 2-bit alpha never quantises at
  // a = sa + 1*(1 - sa) = 1, and the write-back replaces exactly those bytes. Card i+1's backdrop
  // must equal background + cards 0..i inside its region: the background is in the snapshot and
  // each earlier card's target holds scene_as_of_j + card_j, which is what the scene held after
  // card j.
  //
  // EVERY BLIT HERE IS A COPY, NOT A RENDER, and that is the whole reason the count falls. ANGLE's
  // Metal backend turns `blitFramebuffer` into a MTLBlitCommandEncoder copy when the blit is
  // same-size, same-format, unflipped, unscaled, unmasked and unscissored, and into a draw into the
  // destination otherwise. Seed (snapshot -> card), replay (card -> card), the
  // backdrop resolve (card -> snapshot) and write-back (card -> scene) are all RGB10_A2 to
  // RGB10_A2 at 1:1 with integer-aligned rects, so all four take the copy path. A copy does not
  // open a render encoder on the scene and so does not load or store its tiles.
  //
  // THE HONEST LIMIT: anything drawn DIRECTLY into `_sceneFbo` between two glass surfaces -- a
  // plain panel, a line of text, an SVG, a stroke -- cannot be replayed from a card target. Those
  // draws push their footprint (`NoteSceneFootprint`), and a later surface whose region intersects
  // one re-takes the frame snapshot: one real encoder end, counted, and then the run is cheap
  // again. `glass-grid` is the good case (the bed is before the snapshot, every card's text is
  // inside its own target) and reads 1. A dense chrome page lands between 1 and the old number.

  /** The stack of targets currently being drawn into. More than one deep is refused today: a glass
   *  child inside a card reads its PARENT's card target instead, which is correct, region-sized,
   *  and whose encoder ends cost a 1 MB target rather than a 16 MB one. */
  private _cardStack: _CardTarget[] = [];
  /** Finished targets whose region has not been written back into the scene yet, ascending. */
  private _cardQueue: _CardTarget[] = [];
  private _cardPool: FramebufferPool | null = null;
  /** The frame snapshot every seed is cut from. Its own texture, NOT `_snapshotTex`: the sharp-tap
   *  path writes card pixels into that one, which would corrupt every later card's seed. */
  private _frameSnapTex: WebGLTexture | null = null;
  private _frameSnapFbo: WebGLFramebuffer | null = null;
  private _frameSnapW = 0;
  private _frameSnapH = 0;
  private _frameSnapValid = false;
  /** Footprints drawn directly into the scene since the snapshot was taken, device px, y down,
   *  flat [x0, y0, x1, y1, ...]. A card region that misses all of them can still be seeded. */
  private _sceneDirectRects: number[] = [];
  /** The pyramid grid phase card origins are aligned to. See `SetCardGrid`. */
  private _cardGridPhase = 1;
  private _cardComposites = 0;
  private _cardFallbacks = 0;
  private _cardBlitPixels = 0;

  /** The whole path's gate. **OFF by default** (`?cardcomposite` turns it on, `?no-cardcomposite`
   *  wins if both are given), because the design was measured and REFUTED: it does exactly what it
   *  claims -- scene-encoder ends 40 -> 1, pixels byte-identical on Metal -- and the frame is
   *  SLOWER for it (66.75 -> 71.49 GPU ms at dpr 2, +6.6% per tick, draws per tick held constant;
   *  Perf/README.md, "THE CANDIDATE REFUTES ENCODER ENDS"). Encoder ends are not the cost.
   *
   *  It stays because it is the ONLY experiment in the sequence that moves encoder ends and nothing
   *  else, and the rule that came out of that refutation -- an ablation that removes work cannot
   *  price a boundary -- means any future claim about ends has to be made on this instrument.
   *
   *  With it false, every entry point below returns before it touches GL: `BeginCardComposite`
   *  at its first line, so `_cardStack` and `_cardQueue` are never pushed to, `_cardPool` is never
   *  constructed, `_ensureFrameSnapshot` is never called and no frame-snapshot texture exists;
   *  `NoteSceneFootprint` at its own first line; `EndCardComposite` on an empty stack; and
   *  `FlushCardComposites` / `_drainCards` on an empty queue. Everything else in the renderer
   *  reaches the path through `_activeCard` (null) or `_cardQueue.length` (0), so the walk is the
   *  pre-composite walk. Not a mode: the two are the same picture by construction. */
  CardCompositeEnabled = false;

  private get _activeCard(): _CardTarget | null {
    const n = this._cardStack.length;
    return n === 0 ? null : this._cardStack[n - 1];
  }

  /** True while a surface's subtree is painting into its own target rather than into the scene. */
  get CardActive(): boolean { return this._cardStack.length !== 0; }
  /** Aim the CANVAS-sized clip volume at the card's sub-window.
   *
   *  The layer cache retargets by shrinking `u_Resolution` to the capture and offsetting the
   *  projection (`u_ViewOffset`). A GLASS surface cannot: `Jiv.Panel.frag` reads its backdrop at
   *  `baseUv = v_PixelPos / u_Resolution` -- a SCREEN uv, mapped into the pyramid by
   *  `u_BackdropXf` -- so a card-sized `u_Resolution` would rescale every refraction, rim and
   *  chromatic tap by canvas/card. `u_Resolution` therefore stays the canvas, and the sub-window
   *  is expressed where it costs nothing: the viewport's ORIGIN goes negative, so NDC still spans
   *  the whole canvas and screen pixel (sx, syb) lands at (sx - X, syb - Ybottom) in the card.
   *  Everything outside the attachment is clipped by the framebuffer, so no extra fragment is
   *  shaded. It also means every program projects correctly, including the SVG fill/stroke and
   *  Jline programs, which carry no view offset at all.
   *
   *  `u_ViewOffset` stays 0 for the same reason it is 0 outside a capture: nothing is being
   *  retargeted at the vertex, only rasterised somewhere else. */
  private _cardViewport = (card: _CardTarget): void => {
    this._gl.viewport(-card.X, -(this._height - card.Y - card.H), this._width, this._height);
  };
  /** Composites started this frame, surfaces that had to fall back, and the copy traffic in Mpx. */
  get CardComposites(): number { return this._cardComposites; }
  get CardFallbacks(): number { return this._cardFallbacks; }
  get CardBlitMpx(): number { return this._cardBlitPixels / 1e6; }
  get CardTargetsPeak(): number { return this._cardPool === null ? 0 : this._cardPool.Peak; }

  /** Align card origins to `phase` device px, measured from x=0 and from the BOTTOM of the canvas.
   *
   *  It STAYS, and what it is load-bearing FOR has changed. It used to be the one thing standing
   *  between a region-sized source and a different picture: `ResolveRegionRect` snaps a pyramid's
   *  origin DOWN to the downsample grid in the INPUT's coordinate space, so a card whose origin was
   *  not itself on the grid would snap to a DIFFERENT set of absolute texels than the same region
   *  would against the canvas. No pyramid is built against a card any more, and that argument is
   *  retired with the code that needed it.
   *
   *  Two things it still buys, for a cost of nothing:
   *    * The READ GUARD in `BeginCardComposite`, whose whole statement is that growing the box by a
   *      multiple of `phase` moves its edges by exactly that many device px -- floor((v - g) / P)
   *      * P equals floor(v / P) * P - g precisely when P divides g. The y axis is measured from
   *      the bottom (GL's convention, and the axis `ResolveRegionRect` works in), so the BOTTOM gap
   *      H - Y - H_card carries the same condition. Both hold by construction.
   *    * ONE card size for anything laid out on a regular pitch, so `glass-grid`'s twenty cards
   *      share a single `FramebufferPool` bucket and re-allocate nothing after the first frame.
   *
   *  The caller passes the deepest phase any pyramid in the frame can ask for: k * 2^depth, where
   *  k is 1 for every surface small enough to composite and depth follows the largest frost in the
   *  tree. Every shallower pyramid's phase is a power of two dividing it. */
  SetCardGrid = (phase: number): void => {
    this._cardGridPhase = Math.max(1, 1 << Math.ceil(Math.log2(Math.max(1, phase))));
  };

  /** The grid phase a surface at `radiusDevicePx` resolves to, for a caller that has to predict it
   *  before the pyramid runs. Mirrors BlurPass's own k * (1 << depth) with k pinned to 1. */
  CardGridPhaseFor = (radiusDevicePx: number): number => 1 << PyramidDepth(Math.max(1, radiusDevicePx), 0);

  /** A draw is about to land DIRECTLY in the scene over this rect (device px, y down). It cannot be
   *  replayed out of a card target, so any later surface reaching into it has to re-cut the frame
   *  snapshot. Cheap and conservative: a node's own painted AABB, unioned. */
  NoteSceneFootprint = (x0: number, y0: number, x1: number, y1: number): void => {
    if (!this.CardCompositeEnabled) return;
    if (!this._frameSnapValid) return;
    this._sceneDirectRects.push(x0, y0, x1, y1);
  };

  /** Open a composite for one glass surface. `px/py/pw/ph` is the surface's box in device px
   *  (y down); `sampleMargin` is how far its shader reaches outside that box, `paintMargin*` how far
   *  its shadow does. Returns false when the surface has to take the old in-scene path -- which is
   *  always legal, and is what a page with live content between its glass surfaces gets. */
  BeginCardComposite = (
    px: number, py: number, pw: number, ph: number,
    sampleMargin: number, paintMarginX: number, paintMarginY: number,
  ): boolean => {
    if (!this.CardCompositeEnabled) return false;
    if (this._width <= 0 || this._height <= 0) return false;
    // A surface nested inside a card already reads that card and draws into it: correct,
    // region-sized, and its encoder ends cost a 1 MB target rather than a 16 MB one. Nothing to
    // open, and opening one would need a seed cut from a target still being drawn into.
    if (this._cardStack.length !== 0) return false;

    const W = this._width, H = this._height;
    const P = this._cardGridPhase;
    // The box has to contain every texel this subtree's pyramids can READ, not merely the region
    // they ask for. Their source is now a canvas-sized texture that holds this card's bytes over
    // the BOX and last frame's everywhere else, so a tap one texel outside the box is a wrong
    // pixel -- and without a guard the two edges coincide EXACTLY: on `glass-grid` the region's
    // origin and the box's left edge are both `floor((px - 64.75) / 4) * 4`, the same number, with
    // the paint margin (36) far inside the sample margin (64.75) and contributing no slack.
    // `CardReadGuard` is the reach; rounding it UP to a whole number of grid phases is what keeps
    // `P | X` and `P | (H - Y - Hcard)` true, which is the condition `SetCardGrid` exists for.
    // 8 device px a side on `glass-grid`: 568x436 becomes 584x452, 6.6% more seed, replay and
    // write-back, and the containment becomes a property of the construction rather than of
    // whatever margins the app's glass class happens to author this week.
    const guard = Math.ceil(CardReadGuard(P) / P) * P;
    const outX = Math.max(sampleMargin, paintMarginX) + guard;
    const outY = Math.max(sampleMargin, paintMarginY) + guard;
    const x0 = Math.max(0, Math.floor((px - outX) / P) * P);
    const x1 = Math.min(W, Math.ceil((px + pw + outX) / P) * P);
    // y from the BOTTOM, because that is the axis the grid condition lives on.
    const yb0 = Math.max(0, Math.floor((H - (py + ph + outY)) / P) * P);
    const yb1 = Math.min(H, Math.ceil((H - (py - outY)) / P) * P);
    const rw = x1 - x0, rh = yb1 - yb0;
    if (rw <= 0 || rh <= 0) return false;
    // The area gate keeps a full-screen scrim -- which has nothing to gain here, its region IS the
    // canvas -- on the ordinary path, and it bounds the copy a dirty card pays to reach the
    // snapshot. It no longer has anything to do with `BaseDownsampleFactor`: the build sees the
    // canvas as its input again, so the factor it picks is the one the in-scene path picks, at any
    // area, with nothing pinned.
    if (rw * rh >= 0.15 * W * H) { this._cardFallbacks++; return false; }
    if (!this._ensureFrameSnapshot(x0, H - yb1, rw, rh)) { this._cardFallbacks++; return false; }

    const gl = this._gl;
    const pool = this._cardPool !== null ? this._cardPool : (this._cardPool = new FramebufferPool(gl));
    const fb = pool.Acquire(rw, rh);
    const card: _CardTarget = {
      Fbo: fb, X: x0, Y: H - yb1, W: rw, H: rh,
      PaintX0: px - paintMarginX, PaintY0: py - paintMarginY,
      PaintX1: px + pw + paintMarginX, PaintY1: py + ph + paintMarginY,
      Dirty: false,
    };

    const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissorOn) gl.disable(gl.SCISSOR_TEST);
    // -- 1. Seed from the frame snapshot, 1:1 and integer-aligned --
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._frameSnapFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb.Framebuffer);
    this._tgt('card');
    gl.blitFramebuffer(x0, yb0, x1, yb1, 0, 0, rw, rh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this._cardBlitPixels += rw * rh;
    // -- 2. Replay every earlier surface that paints into this region, ascending --
    for (let i = 0; i < this._cardQueue.length; i++) {
      const e = this._cardQueue[i];
      const ox0 = Math.max(e.PaintX0, card.X), ox1 = Math.min(e.PaintX1, card.X + rw);
      const oy0 = Math.max(e.PaintY0, card.Y), oy1 = Math.min(e.PaintY1, card.Y + rh);
      const sx0 = Math.max(Math.floor(ox0), e.X), sx1 = Math.min(Math.ceil(ox1), e.X + e.W);
      const sy0 = Math.max(Math.floor(oy0), e.Y), sy1 = Math.min(Math.ceil(oy1), e.Y + e.H);
      if (sx1 <= sx0 || sy1 <= sy0) continue;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, e.Fbo.Framebuffer);
      gl.blitFramebuffer(
        sx0 - e.X, e.H - (sy1 - e.Y), sx1 - e.X, e.H - (sy0 - e.Y),
        sx0 - card.X, rh - (sy1 - card.Y), sx1 - card.X, rh - (sy0 - card.Y),
        gl.COLOR_BUFFER_BIT, gl.NEAREST,
      );
      this._cardBlitPixels += (sx1 - sx0) * (sy1 - sy0);
    }
    if (scissorOn) gl.enable(gl.SCISSOR_TEST);

    // -- 3/4. Make it the target the walk paints into --
    this._cardStack.push(card);
    this._cardComposites++;
    this.RebindSceneTarget();
    return true;
  };

  /** Close the surface's composite and queue its region for write-back. The caller must have
   *  drained its own pending panel/text batches first -- anything still buffered would be flushed
   *  after this returns and land in the scene instead of in the card. */
  EndCardComposite = (): void => {
    const card = this._cardStack.pop();
    if (card === undefined) return;
    this._cardQueue.push(card);
    this.RebindSceneTarget();
  };

  /** Write back everything still pending. Called at the end of the frame (nothing reads the
   *  snapshot after that) and automatically ahead of any direct scene draw. */
  FlushCardComposites = (): void => { this._drainCards(false); };

  private _drainCards = (updateSnapshot: boolean): void => {
    if (this._cardQueue.length === 0) return;
    const gl = this._gl;
    const q = this._cardQueue;
    this._cardQueue = [];
    const H = this._height;
    const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissorOn) gl.disable(gl.SCISSOR_TEST);
    // Ascending, and each write is a REPLACE: where two regions overlap the later surface's target
    // wins, and it holds scene_as_of_j + card_j -- what the scene held after card j.
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      const dyb = H - (c.Y + c.H);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, c.Fbo.Framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._sceneFbo.Framebuffer);
      gl.blitFramebuffer(0, 0, c.W, c.H, c.X, dyb, c.X + c.W, dyb + c.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      this._cardBlitPixels += c.W * c.H;
      // Keep the frame snapshot equal to the scene, so a LATER surface whose region misses every
      // direct-draw footprint can still be seeded from it instead of forcing a fresh cut.
      if (updateSnapshot && this._frameSnapValid && this._frameSnapFbo !== null) {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._frameSnapFbo);
        gl.blitFramebuffer(0, 0, c.W, c.H, c.X, dyb, c.X + c.W, dyb + c.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        this._cardBlitPixels += c.W * c.H;
      }
      if (this._cardPool !== null) this._cardPool.Release(c.Fbo);
    }
    if (scissorOn) gl.enable(gl.SCISSOR_TEST);
    if (!updateSnapshot) this._frameSnapValid = false;
    // Hand the binding back to the scene. The two callers are `_noteSceneDraw`, mid-setup for a
    // draw that is about to land in the scene, and the end-of-frame flush, which rebinds anyway.
    // A blit touches no program, VAO, viewport or blend state, so nothing else needs restoring.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._sceneFbo.Framebuffer);
  };

  /** Cut the frame snapshot if there is not a usable one. The ONE scene-encoder end of a clean
   *  frame, and the only place this path reads the scene at all. */
  private _ensureFrameSnapshot = (rx: number, ry: number, rw: number, rh: number): boolean => {
    const gl = this._gl;
    if (this._frameSnapValid && !this._directRectHit(rx, ry, rx + rw, ry + rh)) return true;
    // A pending write-back is NOT in the scene yet, so a cut taken now would miss it. Land them
    // first; the drain is blits and adds no encoder end of its own.
    if (this._cardQueue.length !== 0) this._drainCards(false);
    if (!this._frameSnapTex || this._frameSnapW !== this._width || this._frameSnapH !== this._height) {
      if (this._frameSnapTex) gl.deleteTexture(this._frameSnapTex);
      if (this._frameSnapFbo) gl.deleteFramebuffer(this._frameSnapFbo);
      const tex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      if (!tex || !fbo) return false;
      this._frameSnapTex = tex;
      this._frameSnapFbo = fbo;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._tgt('default');
      this._frameSnapW = this._width;
      this._frameSnapH = this._height;
    }
    const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissorOn) gl.disable(gl.SCISSOR_TEST);
    this._sceneLedger.NoteRead();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._sceneFbo.Framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._frameSnapFbo);
    // The honest bind. If the bed has been drawn since the encoder last ended, THIS is the end the
    // ledger should count -- and on a clean frame it is the only one in the frame.
    this._tgt('snapshot');
    gl.blitFramebuffer(0, 0, this._width, this._height, 0, 0, this._width, this._height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this._cardBlitPixels += this._width * this._height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._tgt('default');
    if (scissorOn) gl.enable(gl.SCISSOR_TEST);
    this._frameSnapValid = true;
    this._sceneDirectRects.length = 0;
    return true;
  };

  private _directRectHit = (x0: number, y0: number, x1: number, y1: number): boolean => {
    const r = this._sceneDirectRects;
    for (let i = 0; i < r.length; i += 4) {
      if (x0 < r[i + 2] && x1 > r[i] && y0 < r[i + 3] && y1 > r[i + 1]) return true;
    }
    return false;
  };

  /** Copy a card target into its SCREEN position in the canvas-sized snapshot texture, so a
   *  consumer that addresses `u_Scene` in screen UV keeps working unchanged. Same size, same
   *  format, integer-aligned: a copy, not a render. */
  private _cardIntoSnapshotTex = (
    card: _CardTarget, scissor?: { x: number; y: number; w: number; h: number },
  ): WebGLTexture => {
    const gl = this._gl;
    const snap = this._ensureSnapshotTexture();
    const H = this._height;
    let sx0 = card.X, sy0 = card.Y, sx1 = card.X + card.W, sy1 = card.Y + card.H;
    if (scissor) {
      sx0 = Math.max(sx0, Math.floor(scissor.x));
      sy0 = Math.max(sy0, Math.floor(scissor.y));
      sx1 = Math.min(sx1, Math.ceil(scissor.x + scissor.w));
      sy1 = Math.min(sy1, Math.ceil(scissor.y + scissor.h));
    }
    if (sx1 <= sx0 || sy1 <= sy0) return snap;
    const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissorOn) gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, card.Fbo.Framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._snapshotFbo);
    this._tgt('snapshot');
    gl.blitFramebuffer(
      sx0 - card.X, card.H - (sy1 - card.Y), sx1 - card.X, card.H - (sy0 - card.Y),
      sx0, H - sy1, sx1, H - sy0,
      gl.COLOR_BUFFER_BIT, gl.NEAREST,
    );
    this._cardBlitPixels += (sx1 - sx0) * (sy1 - sy0);
    if (scissorOn) gl.enable(gl.SCISSOR_TEST);
    // The same binding `_snapshotBlit` leaves behind, for the same reason: every caller of a
    // snapshot follows it with a pyramid build and a `RebindSceneTarget`, and matching the two
    // paths' end state is what keeps the card path from needing its own call-site handling.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._tgt('default');
    return snap;
  };

  private _cardIntoSnapshot = (
    card: _CardTarget, scissor?: { x: number; y: number; w: number; h: number },
  ): GpuTextureHandle => _wrap(this._cardIntoSnapshotTex(card, scissor));

  /** The ONE resolver every backdrop read inside a composite goes through: a CANVAS-SIZED,
   *  screen-addressed texture holding what the scene held over `rect` grown by `guard`.
   *
   *  One source of truth, because a reader that addresses the canvas and a reader that addresses a
   *  568x436 card are not the same reader even when they want the same texels -- see the comment on
   *  the card branch of `ComputeBlur` for what that difference measured.
   *
   *  Which of the two canvas-sized textures answers is a COST question, not a correctness one.
   *  While the card still holds the frame snapshot's bytes verbatim -- nothing drawn into it, and
   *  no earlier surface in this run painting anywhere the read can reach -- the frame snapshot IS
   *  those bytes, canvas-wide, and the answer is free. Otherwise the card is copied into the
   *  snapshot texture at its screen position: same size, same format, integer-aligned, a
   *  blit-encoder region copy of exactly the class the twenty write-backs already are.
   *
   *  `card.Dirty` is the load-bearing half of the free path. A NESTED surface's backdrop is its
   *  parent's card with the parent's own fill and children already in it, and the snapshot holds
   *  none of that. The queue scan is the other half: a card's seed carries its earlier neighbours'
   *  ink and the frame snapshot does not, so a read that can reach a queued surface's paint rect
   *  has to take the copy. On `glass-grid` the shadow probe's rect clears every neighbour (the
   *  36 px paint outset cannot cross the 40 px gutter) and stays free, while a pyramid's rect is
   *  the whole card and reaches four of them, so it copies.
   *
   *  `guard` is how far past `rect` the consumer can read: 0 for the adaptive-shadow probe, which
   *  samples strictly inside its rect, and `CardReadGuard` for a pyramid, whose first DOWN hop
   *  reaches past the rect it resolves to. The copy is scissored to the same grown rect, so a rim
   *  overlay -- whose region is the frost margin alone, not the fill's refraction footprint -- pays
   *  for what it reads rather than for the whole card. */
  private _cardBackdropSource = (
    card: _CardTarget, rect: { x: number; y: number; w: number; h: number }, guard: number,
  ): WebGLTexture => {
    const x0 = rect.x - guard, y0 = rect.y - guard;
    const x1 = rect.x + rect.w + guard, y1 = rect.y + rect.h + guard;
    if (this._frameSnapTex !== null && this._frameSnapValid && !card.Dirty) {
      let painted = false;
      for (let i = 0; i < this._cardQueue.length; i++) {
        const e = this._cardQueue[i];
        if (x0 < e.PaintX1 && x1 > e.PaintX0 && y0 < e.PaintY1 && y1 > e.PaintY0) { painted = true; break; }
      }
      if (!painted) return this._frameSnapTex;
    }
    return this._cardIntoSnapshotTex(
      card, guard === 0 ? undefined : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    );
  };

  /** The canvas-sized, screen-addressed sharp tap the adaptive-shadow probe needs, for a surface
   *  whose backdrop lives in a card target. Guard 0: the probe samples strictly inside `rect`. */
  private _cardSharpTap = (
    card: _CardTarget, rect: { x: number; y: number; w: number; h: number },
  ): WebGLTexture => this._cardBackdropSource(card, rect, 0);

  // ── Blit ──

  Blit = (source: GpuTextureHandle): void => {
    const gl = this._gl;
    this._useProgram(this._blitShader.Program);
    gl.uniform1i(this._blitTexLoc, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(source));
    gl.bindVertexArray(this._quad.Vao);
    this._noteSceneDraw();
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
    // (x, y) is a SCREEN rect with GL's bottom-left origin. Under a card composite the bound
    // target is the card's sub-window, so the same rect has to be expressed in the card's frame --
    // the layer cache composites through here and would otherwise land at canvas origin.
    const card = this._activeCard;
    if (card !== null) gl.viewport(x - card.X, y - (this._height - card.Y - card.H), w, h);
    else gl.viewport(x, y, w, h);
    this._useProgram(this._blitShader.Program);
    gl.uniform1i(this._blitTexLoc, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindVertexArray(this._quad.Vao);
    this._noteSceneDraw();
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
    // "The scene" means whatever this walk is compositing INTO. Under a card composite that is the
    // card's own region-sized target, and the projection has to go back to the sub-window offset
    // the card set up -- the layer cache's closing `SetCaptureViewOffset(0, 0)` runs through here
    // too, and without this a nested capture would leave the card drawing at canvas origin.
    const card = this._activeCard;
    if (card !== null) {
      card.Fbo.Bind();
      this._tgt('card');
      this._cardViewport(card);
    } else {
      this._sceneFbo.Bind();
      this._tgt('scene');
      gl.viewport(0, 0, this._width, this._height);
    }
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
    // The present ends the scene's encoder, and so does the invalidate after it - once per frame, in
    // every configuration. Counting a constant would make `Switches` incomparable with `Restarts`,
    // which excludes the present for the same reason. Drain the flag rather than exempt each bind.
    this._sceneLedger.NoteFrameEndDrain();
    // `?blur-src-*` builds its stand-in HERE, on the far side of the drain, so the fill's binds book
    // no encoder end on the one frame it runs. See `_fillBlurSrcOnce`. Off by default: one field
    // test on a frame that is about to issue a full-canvas blit anyway.
    if (this.DiagBlurSrc !== null) this._fillBlurSrcOnce();
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
    this._noteSceneDraw();
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
