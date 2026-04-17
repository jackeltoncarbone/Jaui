/**
 * WebGL2 implementation of the Renderer interface.
 *
 * Wraps the original WebGL2 rendering subsystems (ShaderCompiler, Framebuffer,
 * BlurPass, Blit, Geometry.Quad) into the Renderer interface so Jwift.ts can
 * use it as a drop-in alternative to WebGPURenderer. This is the default
 * backend — works on every browser, every GPU, every driver.
 */

import type { Renderer, GpuTextureHandle, ProgressiveBlurParams } from './Renderer';
import { ShaderCompiler, type ShaderProgram } from './Shader.Compiler';
import { Framebuffer } from './Framebuffer';
import { BlurPass } from './BlurPass';
import { QuadGeometry } from './Geometry.Quad';
import { PROGRESSIVE_BLUR_VERT, PROGRESSIVE_BLUR_FRAG } from '../ProgressiveBlur/ProgressiveBlur.Shader';

import panelVertSrc from '../Jiv/Shaders/Jiv.Panel.vert.gen';
import panelFragSrc from '../Jiv/Shaders/Jiv.Panel.frag.gen';
import textVertSrc from '../Text/Shaders/Text.Quad.vert.gen';
import textFragSrc from '../Text/Shaders/Text.Quad.frag.gen';

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

const TEXT_FLOATS_PER_INSTANCE = 12;
const TEXT_BYTES_PER_INSTANCE = TEXT_FLOATS_PER_INSTANCE * 4;
const TEXT_ATTR_COUNT = 3; // locations 1..3 — clip_meta is packed into a_OpacityClip.yz

/** Clip-stack texture: RGBA32F, one row. Each clip = 2 texels
 *  (rect.xyzw, radii.xyzw). Sized so at least 1024 clips fit initially. */
const CLIP_TEX_MIN_WIDTH = 2048;  // 512 clips × 2 texels

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

  // Geometry
  private _quad!: QuadGeometry;

  // Render targets
  private _sceneFbo!: Framebuffer;
  private _blur!: BlurPass;

  // Panel shader
  private _panelShader!: ShaderProgram;
  private _panelVao!: WebGLVertexArrayObject;
  private _panelInstanceBuffer!: WebGLBuffer;
  private _panelInstanceData = new Float32Array(0);
  private _panelInstanceCount = 0;
  private _panelResolutionLoc!: WebGLUniformLocation | null;
  private _panelBackdropLoc!: WebGLUniformLocation | null;
  private _panelBaseFrostLodLoc!: WebGLUniformLocation | null;
  private _panelSpecTiltLoc!: WebGLUniformLocation | null;
  private _dummyTex!: WebGLTexture;

  // Text shader
  private _textShader!: ShaderProgram;
  private _textVao!: WebGLVertexArrayObject;
  private _textInstanceBuffer!: WebGLBuffer;
  private _textInstanceData = new Float32Array(0);
  private _textInstanceCount = 0;
  private _textResolutionLoc!: WebGLUniformLocation | null;
  private _textAtlasLoc!: WebGLUniformLocation | null;

  // Blit shader
  private _blitShader!: ShaderProgram;
  private _blitTexLoc!: WebGLUniformLocation | null;

  // Progressive blur shader
  private _progBlurShader!: ShaderProgram;
  private _progBlurLocs!: {
    resolution: WebGLUniformLocation | null;
    rect: WebGLUniformLocation | null;
    scene: WebGLUniformLocation | null;
    pyramid: WebGLUniformLocation | null;
    maxLod: WebGLUniformLocation | null;
    direction: WebGLUniformLocation | null;
    opacity: WebGLUniformLocation | null;
    background: WebGLUniformLocation | null;
    grading: WebGLUniformLocation | null;
    clipTex: WebGLUniformLocation | null;
    clipMeta: WebGLUniformLocation | null;
  };

  // Clip-stack texture (RGBA32F row buffer indexed by texelFetch)
  private _clipTex!: WebGLTexture;
  private _clipTexWidth: number = CLIP_TEX_MIN_WIDTH;
  private _clipLastFloatsUploaded: number = 0;
  private _panelClipTexLoc!: WebGLUniformLocation | null;
  private _textClipTexLoc!: WebGLUniformLocation | null;

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

  // ── Lifecycle ──

  Init = async (canvas: HTMLCanvasElement): Promise<void> => {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('[Jwift] WebGL2 not supported');
    this._gl = gl;

    this._quad = new QuadGeometry(gl);
    this._sceneFbo = new Framebuffer(gl);
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
    this._initBlitShader(gl);
    this._initProgBlurShader(gl);

    // 1x1 black placeholder texture
    const dummy = gl.createTexture();
    if (!dummy) throw new Error('[Jwift] failed to create placeholder texture');
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
    if (!clipTex) throw new Error('[Jwift] failed to create clip texture');
    this._clipTex = clipTex;
    gl.bindTexture(gl.TEXTURE_2D, clipTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this._clipTexWidth, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
  get BlurPyramidTexture(): GpuTextureHandle {
    // BlurPass stores its output internally — the last Blur() call's result
    // is in levels[0].Texture. We don't expose it directly; it's accessed
    // via the return value of ComputeBlur.
    throw new Error('[Jwift WebGL2] Access blur output via ComputeBlur return value');
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
  ): void => {
    if (this._panelInstanceCount === 0) return;
    const gl = this._gl;

    // Upload instance data
    gl.bindBuffer(gl.ARRAY_BUFFER, this._panelInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,
      this._panelInstanceData.subarray(0, this._panelInstanceCount * PANEL_FLOATS_PER_INSTANCE),
      gl.DYNAMIC_DRAW);

    gl.useProgram(this._panelShader.Program);
    gl.uniform2f(this._panelResolutionLoc, canvasWidth, canvasHeight);
    gl.uniform1i(this._panelBackdropLoc, 0);
    gl.uniform1i(this._panelClipTexLoc, 1);
    gl.uniform1f(this._panelBaseFrostLodLoc, baseFrostLod);
    gl.uniform2f(this._panelSpecTiltLoc, specTiltX, specTiltY);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backdrop ? _unwrap(backdrop) : this._dummyTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._clipTex);

    gl.bindVertexArray(this._panelVao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this._panelInstanceCount);
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

    gl.useProgram(this._textShader.Program);
    gl.uniform2f(this._textResolutionLoc, canvasWidth, canvasHeight);
    gl.uniform1i(this._textAtlasLoc, 0);
    gl.uniform1i(this._textClipTexLoc, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(atlas));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._clipTex);

    gl.bindVertexArray(this._textVao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this._textInstanceCount);
  };

  // ── Blur ──

  ComputeBlur = (
    input: GpuTextureHandle, width: number, height: number,
    radius: number, minDepth?: number,
  ): GpuTextureHandle => {
    const result = this._blur.Blur(_unwrap(input), width, height, radius, minDepth);
    return _wrap(result);
  };

  GenerateBlurMipmap = (): void => {
    this._blur.GenerateOutputMipmap();
  };

  get LastBlurDepth(): number { return this._blur.LastDepth; }

  // ── Progressive Blur ──

  DrawProgressiveBlur = (params: ProgressiveBlurParams): void => {
    const gl = this._gl;
    const p = this._progBlurShader.Program;

    gl.useProgram(p);
    gl.uniform2f(this._progBlurLocs.resolution, this._width, this._height);
    gl.uniform4f(this._progBlurLocs.rect, params.Rect.X, params.Rect.Y, params.Rect.W, params.Rect.H);
    gl.uniform1i(this._progBlurLocs.scene, 0);
    gl.uniform1i(this._progBlurLocs.pyramid, 1);
    gl.uniform1i(this._progBlurLocs.clipTex, 2);
    gl.uniform2i(this._progBlurLocs.clipMeta, params.ClipOffset, params.ClipCount);
    gl.uniform1f(this._progBlurLocs.maxLod, params.MaxLod);
    gl.uniform1i(this._progBlurLocs.direction, params.Direction);
    gl.uniform1f(this._progBlurLocs.opacity, params.Opacity);
    gl.uniform4f(this._progBlurLocs.background,
      params.Background.R, params.Background.G, params.Background.B, params.Background.A);
    gl.uniform3f(this._progBlurLocs.grading,
      params.Grading.Brightness, params.Grading.Saturation, params.Grading.Contrast);

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

  SnapshotScreen = (): GpuTextureHandle => {
    const gl = this._gl;
    // Ensure snapshot texture exists at current size
    if (!this._snapshotTex || this._snapshotW !== this._width || this._snapshotH !== this._height) {
      if (this._snapshotTex) gl.deleteTexture(this._snapshotTex);
      if (this._snapshotFbo) gl.deleteFramebuffer(this._snapshotFbo);
      this._snapshotTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this._snapshotTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
    // Copy default framebuffer → snapshot texture via blit
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._snapshotFbo);
    gl.blitFramebuffer(0, 0, this._width, this._height, 0, 0, this._width, this._height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return _wrap(this._snapshotTex);
  };

  // ── Blit ──

  Blit = (source: GpuTextureHandle): void => {
    const gl = this._gl;
    gl.useProgram(this._blitShader.Program);
    gl.uniform1i(this._blitTexLoc, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(source));
    gl.bindVertexArray(this._quad.Vao);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  // ── Texture Management ──

  CreateTexture = (width: number, height: number): GpuTextureHandle => {
    const gl = this._gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('[Jwift] Failed to create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return _wrap(tex);
  };

  UploadSubTexture = (
    texture: GpuTextureHandle, x: number, y: number,
    source: HTMLCanvasElement | ImageBitmap,
  ): void => {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, _unwrap(texture));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, source);
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

  SetViewport = (x: number, y: number, width: number, height: number): void => {
    this._gl.viewport(x, y, width, height);
  };

  // ── Shader Initialization ─────────────────────────────────────────────────

  private _initPanelShader = (gl: WebGL2RenderingContext): void => {
    this._panelShader = ShaderCompiler.Compile(gl, panelVertSrc, panelFragSrc);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jwift] Failed to create panel instance buffer');
    this._panelInstanceBuffer = buf;

    this._panelResolutionLoc = gl.getUniformLocation(this._panelShader.Program, 'u_Resolution');
    this._panelBackdropLoc = gl.getUniformLocation(this._panelShader.Program, 'u_Backdrop');
    this._panelBaseFrostLodLoc = gl.getUniformLocation(this._panelShader.Program, 'u_BaseFrostLod');
    this._panelSpecTiltLoc = gl.getUniformLocation(this._panelShader.Program, 'u_SpecularTilt');
    this._panelClipTexLoc = gl.getUniformLocation(this._panelShader.Program, 'u_ClipTex');

    // Dedicated VAO for panel rendering (separate from text)
    this._panelVao = this._createInstancedVao(gl, this._panelInstanceBuffer, PANEL_ATTR_COUNT, PANEL_BYTES_PER_INSTANCE);
  };

  private _initTextShader = (gl: WebGL2RenderingContext): void => {
    this._textShader = ShaderCompiler.Compile(gl, textVertSrc, textFragSrc);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jwift] Failed to create text instance buffer');
    this._textInstanceBuffer = buf;

    this._textResolutionLoc = gl.getUniformLocation(this._textShader.Program, 'u_Resolution');
    this._textAtlasLoc = gl.getUniformLocation(this._textShader.Program, 'u_Atlas');
    this._textClipTexLoc = gl.getUniformLocation(this._textShader.Program, 'u_ClipTex');

    // Dedicated VAO for text rendering (separate from panel)
    this._textVao = this._createInstancedVao(gl, this._textInstanceBuffer, TEXT_ATTR_COUNT, TEXT_BYTES_PER_INSTANCE);
  };

  /** Create a VAO with the unit quad at location 0 + instance attributes at locations 1..N. */
  private _createInstancedVao = (
    gl: WebGL2RenderingContext,
    instanceBuffer: WebGLBuffer,
    attrCount: number,
    bytesPerInstance: number,
  ): WebGLVertexArrayObject => {
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('[Jwift] Failed to create VAO');
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

  private _initProgBlurShader = (gl: WebGL2RenderingContext): void => {
    this._progBlurShader = ShaderCompiler.Compile(gl, PROGRESSIVE_BLUR_VERT, PROGRESSIVE_BLUR_FRAG);
    const p = this._progBlurShader.Program;
    this._progBlurLocs = {
      resolution: gl.getUniformLocation(p, 'u_Resolution'),
      rect: gl.getUniformLocation(p, 'u_Rect'),
      scene: gl.getUniformLocation(p, 'u_Scene'),
      pyramid: gl.getUniformLocation(p, 'u_Pyramid'),
      maxLod: gl.getUniformLocation(p, 'u_MaxLod'),
      direction: gl.getUniformLocation(p, 'u_Direction'),
      opacity: gl.getUniformLocation(p, 'u_Opacity'),
      background: gl.getUniformLocation(p, 'u_Background'),
      grading: gl.getUniformLocation(p, 'u_Grading'),
      clipTex: gl.getUniformLocation(p, 'u_ClipTex'),
      clipMeta: gl.getUniformLocation(p, 'u_ClipMeta'),
    };
  };
}
