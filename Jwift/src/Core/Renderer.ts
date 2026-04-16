/**
 * Renderer — GPU backend abstraction.
 *
 * WebGPU.Renderer implements this. A hypothetical WebGL2.Renderer could too.
 * The render loop in Jwift.ts calls these methods instead of raw GPU API,
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
  Opacity: number;
  Background: { R: number; G: number; B: number; A: number };
  Grading: { Brightness: number; Saturation: number; Contrast: number };
  /** Index into the per-frame clip-stack buffer. Count=0 means no clipping. */
  ClipOffset: number;
  ClipCount: number;
}

// ─── Renderer Interface ────────────────────────────────────────────────────

export interface Renderer {

  // ── Lifecycle ──

  /** Async — WebGPU adapter/device negotiation requires promises. */
  Init(canvas: HTMLCanvasElement): Promise<void>;
  Destroy(): void;

  /** Reconfigure surfaces and render targets for the new size. */
  Resize(width: number, height: number, dpr: number): void;

  // ── Per-Frame ──

  BeginFrame(): void;
  EndFrame(): void;

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
  /** Issue the instanced draw. `backdrop` is null for Pass 1 (non-glass). */
  PanelDrawBatch(
    canvasWidth: number,
    canvasHeight: number,
    backdrop: GpuTextureHandle | null,
    baseFrostLod: number,
    specTiltX: number,
    specTiltY: number,
  ): void;

  // ── Text Rendering (instanced) ──

  TextBeginBatch(): void;
  TextAddInstance(data: Float32Array, offset: number, count: number): void;
  TextDrawBatch(
    canvasWidth: number,
    canvasHeight: number,
    atlas: GpuTextureHandle,
  ): void;

  // ── Blur ──

  /** Run the dual-filter blur pyramid. Returns handle to the blurred output. */
  ComputeBlur(
    input: GpuTextureHandle,
    width: number,
    height: number,
    radius: number,
    minDepth?: number,
  ): GpuTextureHandle;

  /** Generate mipmaps on the blur output so glass + progressive blur can
   *  sample at arbitrary LODs via textureSampleLevel / textureLod. */
  GenerateBlurMipmap(): void;

  /** The pyramid depth from the last ComputeBlur call. */
  readonly LastBlurDepth: number;

  // ── Progressive Blur ──

  DrawProgressiveBlur(params: ProgressiveBlurParams): void;

  // ── Blit ──

  /** Full-screen textured-quad copy to the current render target. */
  Blit(source: GpuTextureHandle): void;

  /** Copy the current screen (default framebuffer) to an offscreen texture
   *  for use as a glass backdrop. Returns a handle to the snapshot. */
  SnapshotScreen(): GpuTextureHandle;

  // ── Texture Management ──

  /** Create a 2D texture (e.g. for the text atlas). */
  CreateTexture(width: number, height: number): GpuTextureHandle;

  /** Upload a sub-region of a texture from a canvas or ImageBitmap. */
  UploadSubTexture(
    texture: GpuTextureHandle,
    x: number,
    y: number,
    source: HTMLCanvasElement | ImageBitmap,
  ): void;

  // ── Clip Stack ──

  /** Upload the per-frame clip-stack buffer. Each clip occupies 8 floats
   *  (rect.xyzw + radii.xyzw, device pixels). Instances and progressive-blur
   *  params reference clips by (offset, count) indices into this buffer.
   *  Called before each draw that depends on the current clip set. The
   *  implementation should avoid re-uploading when `floatCount` hasn't grown. */
  SetClipBuffer(data: Float32Array, floatCount: number): void;

  // ── Render State ──

  /** Enable standard alpha blending (srcAlpha, oneMinusSrcAlpha). */
  EnableBlend(): void;
  DisableBlend(): void;

  /** Bind the default framebuffer / swap chain texture. Pass a clear color
   *  to clear the bound target to that color before returning; omit to keep
   *  whatever was already there (e.g. content drawn earlier in the frame). */
  BindDefaultTarget(clear?: { R: number; G: number; B: number }): void;

  SetViewport(x: number, y: number, width: number, height: number): void;
}
