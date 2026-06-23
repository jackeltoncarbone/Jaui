/**
 * Renderer — GPU backend abstraction.
 *
 * WebGPU.Renderer implements this. A hypothetical WebGL2.Renderer could too.
 * The render loop in Jaui.ts calls these methods instead of raw GPU API,
 * so the orchestration logic (pass ordering, tree traversal, frost-LOD math)
 * stays in one place and the GPU submission is swappable.
 *
 * The interface models semantic render operations — "draw a batch of panels",
 * "compute the blur pyramid" — not raw GPU state. This is intentional:
 * WebGL2 and WebGPU have fundamentally different execution models (state
 * machine vs command encoder). A low-level wrapper would just re-expose one
 * and force the other to emulate it.
 */

// ─── Opaque Handles ────────────────────────────────────────────────────────
// Callers never inspect these. The WebGPU implementation stores GPUTexture
// inside; a WebGL2 implementation would store WebGLTexture. Neither leaks.

export interface GpuTextureHandle {
  readonly _brand: 'GpuTextureHandle';
}

export interface GpuBufferHandle {
  readonly _brand: 'GpuBufferHandle';
}

// ─── Progressive Blur Params ───────────────────────────────────────────────

/**
 * Per-draw background paint selection for `PanelDrawBatch`. Tagged-union
 * shape mirrors `BackgroundValue` on the data side, but flattened to the
 * raw GPU inputs the renderer needs: a texture handle, a UV transform,
 * a gradient direction / center / radius, and a stop list.
 */
export type BgPaint =
  | { Mode: 'Color' }
  | { Mode: 'Image',          Texture: GpuTextureHandle, UvScaleX: number, UvScaleY: number, UvOffsetX: number, UvOffsetY: number, FadeAlpha: number }
  | { Mode: 'LinearGradient', DirX: number, DirY: number, Stops: ReadonlyArray<{ Position: number; R: number; G: number; B: number; A: number }> }
  | { Mode: 'RadialGradient', CenterX: number, CenterY: number, Radius: number, Stops: ReadonlyArray<{ Position: number; R: number; G: number; B: number; A: number }> };

/**
 * Shared per-draw style for a Jline (stroke) batch. The geometry (per-segment
 * miter-quad instances) carries position + arc-t; this carries the look that's
 * uniform across the batch (the comet case: all marcher paths share one
 * TransitionPaths.Style, differing only in geometry + the per-instance phase).
 * Lengths are in the same device-px space as the instance positions. Colours
 * are linear [r,g,b] 0..1.
 */
export interface StrokeStyle {
  Progress: number;     // head position along arc, 0..1
  HalfWidth: number;    // line half-width (device px)
  HeadRadius: number;   // head dot radius (device px)
  Blur: number;         // max edge-softness at the dissolved tail (device px)
  BlurFloor: number;    // min edge-softness at the sharp head (device px) — AA floor (shader: u_BlurFloor)
  BlurSharp: number;    // fraction (0..1) of the visible trail kept sharp before the blur ramps in
  Ahead: number;        // trail window ahead of head (window-units)
  Behind: number;       // trail window behind head (window-units)
  WindowUnit: number;   // window-unit -> arc-fraction scale
  HeadAlpha: number;
  FloorAlpha: number;
  HeadFade: number;     // head-lobe arc width (fraction)
  TrailMinAlpha: number; // floor opacity — the trail never fades below this (visible start→end; u_TrailMinA)
  Spread: number;       // 1 = apply per-line phase offset, 0 = synced
  ShowPrior: number;    // 1 = show prior (behind-head) ghost
  PriorScale: number;   // opacity multiplier for the behind (history) trail (u_PriorScale)
  ForwardA: readonly [number, number, number];
  ForwardB: readonly [number, number, number];
  Prior: readonly [number, number, number];
  CollisionColor: readonly [number, number, number]; // colour the line takes where a collision occurs (u_CollisionColor)
}

export interface ProgressiveBlurParams {
  /** Screen rect in device pixels. */
  Rect: { X: number; Y: number; W: number; H: number };
  /** Unblurred scene texture. */
  Scene: GpuTextureHandle;
  /** Mipmapped blur pyramid texture. */
  Pyramid: GpuTextureHandle;
  /** Highest mipmap LOD to sample (ramp = 1.0 maps here). */
  MaxLod: number;
  /** 0=ToTop, 1=ToBottom, 2=ToLeft, 3=ToRight. */
  Direction: number;
  /** Feather ramp length in device pixels. 0 = ramp spans whole element
   *  (original behaviour). Anything else remaps the ramp so only the first
   *  `Feather` pixels from the clear edge transition; the rest is solid. */
  Feather: number;
  /** Exponent applied to the smoothstep'd ramp. 1 = unchanged. <1 = blur
   *  dominates with sharp falloff to clear. >1 = clear dominates. */
  Easing: number;
  Opacity: number;
  Background: { R: number; G: number; B: number; A: number };
  Grading: { Brightness: number; Saturation: number; Contrast: number };
  /** Optional gradient-driven blur spectrum (overrides the linear Feather/Easing
   *  ramp when present, ≥2 stops). Each stop's Value drives blur LOD + tint mix +
   *  grading at its Position; Easing is the per-segment exponent to the next stop. */
  Stops?: ReadonlyArray<{ Position: number; Value: number; Easing: number }> | null;
  /** Index into the per-frame clip-stack buffer. Count=0 means no clipping. */
  ClipOffset: number;
  ClipCount: number;
  /** Rotation basis (cosθ, sinθ) + pivot (device px) so the blur region + its
   *  ramp/feather rotate with a rotated element. Omitted ⇒ (1, 0, 0, 0) = none. */
  Cos?: number;
  Sin?: number;
  PivotX?: number;
  PivotY?: number;
}

// ─── Renderer Interface ────────────────────────────────────────────────────

export interface Renderer {

  // ── Lifecycle ──

  /** Async — WebGPU adapter/device negotiation requires promises.
   *  Accepts both DOM canvases and OffscreenCanvas so the engine can run
   *  inside a Web Worker via transferControlToOffscreen. */
  Init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void>;
  Destroy(): void;

  /** Reconfigure surfaces and render targets for the new size. */
  Resize(width: number, height: number, dpr: number): void;

  // ── Per-Frame ──

  BeginFrame(): void;
  EndFrame(): void;

  /** Last-available per-frame GPU elapsed time in milliseconds, or null
   *  when unavailable (extension missing, query not yet resolved, or the
   *  timer result was flagged disjoint by the driver). Backends implement
   *  this with their native async timing primitives — for WebGL2 that's
   *  `EXT_disjoint_timer_query_webgl2`; for WebGPU it's timestamp queries.
   *  Callers MUST tolerate null and should average/smooth on their side;
   *  the raw per-frame value lags 2-3 frames because of the async resolve. */
  GetFrameGpuMs(): number | null;

  // ── Render Targets ──

  /** The scene FBO / texture that non-glass panels render into. */
  readonly SceneTexture: GpuTextureHandle;

  /** The mipmapped blur pyramid output. */
  readonly BlurPyramidTexture: GpuTextureHandle;

  // ── Scene Pass (renders into SceneTexture) ──

  /** Bind scene render target, clear to dark, set viewport. */
  BeginScenePass(clearR: number, clearG: number, clearB: number): void;
  EndScenePass(): void;

  // ── Panel Rendering (instanced) ──

  PanelBeginBatch(): void;
  /** Append raw instance data. `data` is a Float32Array; `offset` and `count`
   *  are in floats. The renderer copies the slice internally. */
  PanelAddInstance(data: Float32Array, offset: number, count: number): void;
  /** Issue the instanced draw. `backdrop` is null for flat-panel batches
   *  without backdrop sampling. When `useGlassShader` is false but a
   *  backdrop is still provided, the caller is drawing a flat panel with
   *  a backdrop filter — the shader variant is the non-glass one but the
   *  pyramid is bound for the `hasBackdropFilter` branch to sample.
   *  `scene` is the raw (unblurred) scene snapshot the shader falls back
   *  to when the effective LOD resolves to 0 — keeps plain-brightness
   *  filters sharp instead of picking up the pyramid's baked-in ~1px
   *  base Gaussian. Pass null for batched flat panels that don't sample
   *  the backdrop at all.
   *
   *  `bgPaint` selects the panel fill mode per-draw:
   *    • undefined / Color → solid v_Tint (every panel uses its instance tint)
   *    • Image            → bind `Texture` and sample with `Uv` transform
   *    • LinearGradient   → evaluate stops against `GradParams.xy` direction
   *    • RadialGradient   → evaluate stops against `GradParams.xy` center + .z radius
   *
   *  Image / gradient batches typically contain a SINGLE panel (one texture
   *  or one stop set per draw call); the renderer batches Color panels
   *  together as before. */
  PanelDrawBatch(
    canvasWidth: number,
    canvasHeight: number,
    backdrop: GpuTextureHandle | null,
    baseFrostLod: number,
    specTiltX: number,
    specTiltY: number,
    useGlassShader?: boolean,
    scene?: GpuTextureHandle | null,
    bgPaint?: BgPaint,
  ): void;

  // ── Text Rendering (instanced) ──

  TextBeginBatch(): void;
  TextAddInstance(data: Float32Array, offset: number, count: number): void;
  TextDrawBatch(
    canvasWidth: number,
    canvasHeight: number,
    atlas: GpuTextureHandle,
  ): void;

  // ── Jline / Stroke Rendering (instanced per segment) ──

  StrokeBeginBatch(): void;
  /** Append raw per-segment instance data (12 floats/instance: Seg.xyzw,
   *  Miter.xyzw, Arc=[t0,t1,phase,_]). The renderer copies the slice. */
  StrokeAddInstance(data: Float32Array, offset: number, count: number): void;
  /** Issue the instanced stroke draw with the batch-shared `style`. */
  StrokeDrawBatch(canvasWidth: number, canvasHeight: number, style: StrokeStyle): void;

  // ── Blur ──

  /** Run the dual-filter blur pyramid. Returns handle to the blurred output.
   *
   *  `scissor` (optional) restricts destination fills to a rect in input-
   *  texture coordinates. Callers that sample only a small region of the
   *  final pyramid (e.g. a glass panel far smaller than the canvas) pass
   *  their sample region here to save 10–50× fragment fill on each blur
   *  pass. Pblurs should omit it — they sample the pyramid across the
   *  whole canvas at high LOD. */
  ComputeBlur(
    input: GpuTextureHandle,
    width: number,
    height: number,
    radius: number,
    minDepth?: number,
    scissor?: { x: number; y: number; w: number; h: number },
  ): GpuTextureHandle;

  /** Generate mipmaps on the blur output so glass + progressive blur can
   *  sample at arbitrary LODs via textureSampleLevel / textureLod. Pass
   *  `maxLod` to cap the build at the consumer's actual sample range —
   *  levels past `maxLod` are never read, so building them is pure
   *  fragment-fill waste. Omit to build the full chain (legacy). */
  GenerateBlurMipmap(maxLod?: number): void;

  /** The pyramid depth from the last ComputeBlur call. */
  readonly LastBlurDepth: number;

  /** Build the shared backdrop pyramid (`?wkr-shared-backdrop`): a sharp-root
   *  (σ=0) blur of the current scene with a full Gaussian mip chain, in a
   *  DEDICATED pass that the per-surface pblur / glass-border blurs can't
   *  clobber. Many glass surfaces then sample it via textureLod at their own
   *  frost LOD — one build per frame, many cheap samples. `maxLod` sizes the
   *  chain to the heaviest frost (+ refraction headroom). Restores the scene
   *  render target before returning. */
  BuildSharedBackdrop(width: number, height: number, maxLod: number): GpuTextureHandle;

  // ── Progressive Blur ──

  DrawProgressiveBlur(params: ProgressiveBlurParams): void;

  // ── Blit ──

  /** Full-screen textured-quad copy to the current render target. */
  Blit(source: GpuTextureHandle): void;

  /** Copy the scene to an offscreen texture for use as a glass/pblur backdrop.
   *  Optional `scissor` (device px, y=0 at top) restricts the copy to a
   *  sub-rect — the surface footprint plus blur/refraction margin — so the
   *  blit cost scales with the surface, not the whole canvas. Returns a handle
   *  to the snapshot. */
  SnapshotScreen(scissor?: { x: number; y: number; w: number; h: number }): GpuTextureHandle;

  // ── Texture Management ──

  /** Create a 2D texture (e.g. for the text atlas). `srgb` allocates an SRGB8_ALPHA8 texture so the GPU
   *  decodes sRGB→linear on sample — use for colour images that will be lit/composited in linear space. */
  CreateTexture(width: number, height: number, srgb?: boolean): GpuTextureHandle;

  /** Upload a sub-region of a texture from a canvas, ImageBitmap, or ImageData.
   *  OffscreenCanvas is included so worker-side text/image rasterization can
   *  upload without round-tripping through the main thread. */
  UploadSubTexture(
    texture: GpuTextureHandle,
    x: number,
    y: number,
    source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap | ImageData,
  ): void;

  // ── Clip Stack ──

  /** Upload the per-frame clip-stack buffer. Each clip occupies 8 floats
   *  (rect.xyzw + radii.xyzw, device pixels). Instances and progressive-blur
   *  params reference clips by (offset, count) indices into this buffer.
   *  Called before each draw that depends on the current clip set. The
   *  implementation should avoid re-uploading when `floatCount` hasn't grown. */
  SetClipBuffer(data: Float32Array, floatCount: number): void;
  /** Upload the per-frame 3D-homography table (shared by panel + text draws).
   *  Instances reference an entry by index; only projective instances do. */
  SetXformBuffer(data: Float32Array, floatCount: number): void;

  // ── Render State ──

  /** Enable standard alpha blending (srcAlpha, oneMinusSrcAlpha). */
  EnableBlend(): void;
  DisableBlend(): void;

  /** Bind the default framebuffer / swap chain texture. Pass a clear color
   *  to clear the bound target to that color before returning; omit to keep
   *  whatever was already there (e.g. content drawn earlier in the frame). */
  BindDefaultTarget(clear?: { R: number; G: number; B: number }): void;

  /** Re-bind the scene FBO without clearing it. Used after a blur pass
   *  temporarily took over the GL state — lets us return to scene rendering
   *  without losing what's already been drawn. Paired with `BeginScenePass`
   *  which does the initial bind+clear at frame start. */
  RebindSceneTarget(): void;

  /** Signal end-of-frame to the driver for tile-based GPUs: invalidate any
   *  framebuffer attachments whose contents won't be read again. On mobile
   *  (iPad, Android GPUs) this lets the tile memory skip writing back to
   *  main memory — a meaningful bandwidth saving. No-op on desktop. */
  InvalidateFrameTransients(): void;

  /** Composite the scene FBO onto the default framebuffer (swap chain)
   *  using the backend's fastest available path. WebGL2 uses
   *  `blitFramebuffer` (hardware color-buffer copy — no shader pass, no
   *  sampler). WebGPU uses a native copyTextureToTexture or equivalent.
   *  Replaces the old shader-based `Blit(SceneTexture)` for end-of-frame
   *  composite: 2–3× faster on integrated GPUs, can fuse with tile-memory
   *  invalidation on mobile so the scene never round-trips to main memory. */
  PresentScene(): void;

  SetViewport(x: number, y: number, width: number, height: number): void;
}
