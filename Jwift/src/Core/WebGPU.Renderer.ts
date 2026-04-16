/**
 * WebGPU implementation of the Renderer interface.
 *
 * Phase 1: only Init, ComputeBlur, GenerateBlurMipmap, Destroy are wired.
 * Everything else throws — it will be implemented in Phase 2+3.
 */

import type { Renderer, GpuTextureHandle, ProgressiveBlurParams } from './Renderer';
import { WebGPUDevice } from './WebGPU.Device';
import { WebGPUBlurPass } from './WebGPU.BlurPass';

// ─── Opaque handle wrapping ─────────────────────────────────────────────────
// The Renderer interface uses branded opaque handles. Internally we wrap/unwrap
// GPUTexture. These helpers are NOT exported — callers never see GPUTexture.

interface WrappedTexture extends GpuTextureHandle {
  readonly _gpu: GPUTexture;
}

const _wrap = (tex: GPUTexture): GpuTextureHandle => ({ _brand: 'GpuTextureHandle', _gpu: tex } as unknown as GpuTextureHandle);
const _unwrap = (handle: GpuTextureHandle): GPUTexture => (handle as unknown as WrappedTexture)._gpu;

const _notImplemented = (name: string): never => {
  throw new Error(`[Jwift WebGPU] ${name} is not yet implemented (Phase 2+3)`);
};

// ─── WebGPU Renderer ────────────────────────────────────────────────────────

export class WebGPURenderer implements Renderer {
  private _gpu: WebGPUDevice | null = null;
  private _blur: WebGPUBlurPass | null = null;

  // ── Lifecycle ──

  Init = async (canvas: HTMLCanvasElement): Promise<void> => {
    this._gpu = await WebGPUDevice.Create(canvas);
    this._blur = new WebGPUBlurPass(this._gpu);
  };

  Destroy = (): void => {
    this._blur?.Destroy();
    this._blur = null;
    this._gpu?.Destroy();
    this._gpu = null;
  };

  Resize = (_width: number, _height: number, _dpr: number): void => {
    _notImplemented('Resize');
  };

  // ── Per-Frame ──

  BeginFrame = (): void => { _notImplemented('BeginFrame'); };
  EndFrame = (): void => { _notImplemented('EndFrame'); };

  // ── Render Targets ──

  get SceneTexture(): GpuTextureHandle { return _notImplemented('SceneTexture'); }
  get BlurPyramidTexture(): GpuTextureHandle {
    const tex = this._blur?.OutputTexture;
    if (!tex) throw new Error('[Jwift WebGPU] No blur output — call ComputeBlur first');
    return _wrap(tex);
  }

  // ── Scene Pass ──

  BeginScenePass = (_clearR: number, _clearG: number, _clearB: number): void => {
    _notImplemented('BeginScenePass');
  };
  EndScenePass = (): void => { _notImplemented('EndScenePass'); };

  // ── Panel Rendering ──

  PanelBeginBatch = (): void => { _notImplemented('PanelBeginBatch'); };
  PanelAddInstance = (_data: Float32Array, _offset: number, _count: number): void => {
    _notImplemented('PanelAddInstance');
  };
  PanelDrawBatch = (
    _canvasWidth: number, _canvasHeight: number,
    _backdrop: GpuTextureHandle | null, _baseFrostLod: number,
    _specTiltX: number, _specTiltY: number,
  ): void => {
    _notImplemented('PanelDrawBatch');
  };

  // ── Text Rendering ──

  TextBeginBatch = (): void => { _notImplemented('TextBeginBatch'); };
  TextAddInstance = (_data: Float32Array, _offset: number, _count: number): void => {
    _notImplemented('TextAddInstance');
  };
  TextDrawBatch = (_canvasWidth: number, _canvasHeight: number, _atlas: GpuTextureHandle): void => {
    _notImplemented('TextDrawBatch');
  };

  // ── Blur ── (IMPLEMENTED — Phase 1 deliverable)

  ComputeBlur = (
    input: GpuTextureHandle,
    width: number,
    height: number,
    radius: number,
    minDepth?: number,
  ): GpuTextureHandle => {
    if (!this._blur) throw new Error('[Jwift WebGPU] Not initialized');
    const result = this._blur.Blur(_unwrap(input), width, height, radius, minDepth);
    return _wrap(result);
  };

  GenerateBlurMipmap = (): void => {
    if (!this._blur) throw new Error('[Jwift WebGPU] Not initialized');
    this._blur.GenerateOutputMipmap();
  };

  get LastBlurDepth(): number {
    return this._blur?.LastDepth ?? 0;
  }

  // ── Progressive Blur ──

  DrawProgressiveBlur = (_params: ProgressiveBlurParams): void => {
    _notImplemented('DrawProgressiveBlur');
  };

  // ── Blit ──

  Blit = (_source: GpuTextureHandle): void => { _notImplemented('Blit'); };

  // ── Texture Management ──

  CreateTexture = (_width: number, _height: number): GpuTextureHandle => {
    return _notImplemented('CreateTexture');
  };

  UploadSubTexture = (
    _texture: GpuTextureHandle, _x: number, _y: number,
    _source: HTMLCanvasElement | ImageBitmap,
  ): void => {
    _notImplemented('UploadSubTexture');
  };

  // ── Render State ──

  EnableBlend = (): void => { _notImplemented('EnableBlend'); };
  DisableBlend = (): void => { _notImplemented('DisableBlend'); };
  BindDefaultTarget = (): void => { _notImplemented('BindDefaultTarget'); };
  SetViewport = (_x: number, _y: number, _width: number, _height: number): void => {
    _notImplemented('SetViewport');
  };
}
