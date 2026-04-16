/**
 * WebGPU implementation of the Renderer interface.
 *
 * Wires the WGSL shaders (Panel, Text, Blit, ProgressiveBlur, Blur compute)
 * into a full render pipeline matching the 6-pass structure in Jwift.ts.
 */

import type { Renderer, GpuTextureHandle, ProgressiveBlurParams } from './Renderer';
import { WebGPUDevice } from './WebGPU.Device';
import { WebGPUBlurPass } from './WebGPU.BlurPass';
import { WebGPUPipelineCache } from './WebGPU.Pipeline.Cache';

import panelSrc from './Shaders/Panel.wgsl.gen';
import textSrc from './Shaders/Text.wgsl.gen';
import blitSrc from './Shaders/Blit.wgsl.gen';
import progressiveBlurSrc from './Shaders/ProgressiveBlur.wgsl.gen';

// ─── Opaque handle wrapping ─────────────────────────────────────────────────

interface WrappedTexture extends GpuTextureHandle {
  readonly _gpu: GPUTexture;
}

const _wrap = (tex: GPUTexture): GpuTextureHandle =>
  ({ _brand: 'GpuTextureHandle', _gpu: tex } as unknown as GpuTextureHandle);
const _unwrap = (handle: GpuTextureHandle): GPUTexture =>
  (handle as unknown as WrappedTexture)._gpu;

// ─── Quad geometry ──────────────────────────────────────────────────────────
// Unit quad [0,1] × [0,1], two triangles, same as Geometry.Quad.ts.

const QUAD_VERTICES = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

// ─── Instance buffer constants ──────────────────────────────────────────────

const PANEL_FLOATS_PER_INSTANCE = 60;  // 15 × vec4
const TEXT_FLOATS_PER_INSTANCE = 12;   // 3 × vec4

// ─── WebGPU Renderer ────────────────────────────────────────────────────────

export class WebGPURenderer implements Renderer {
  private _gpu: WebGPUDevice | null = null;
  private _cache: WebGPUPipelineCache | null = null;
  private _blur: WebGPUBlurPass | null = null;

  // Geometry
  private _quadVB: GPUBuffer | null = null;
  private _quadIB: GPUBuffer | null = null;

  // Render targets
  private _sceneTex: GPUTexture | null = null;
  private _sceneView: GPUTextureView | null = null;
  private _width: number = 0;
  private _height: number = 0;

  // Per-frame state
  private _encoder: GPUCommandEncoder | null = null;

  // ── Panel pipeline ──
  private _panelPipeline: GPURenderPipeline | null = null;
  private _panelBindGroupLayout0: GPUBindGroupLayout | null = null;
  private _panelBindGroupLayout1: GPUBindGroupLayout | null = null;
  private _panelUniformBuffer: GPUBuffer | null = null;
  private _panelInstanceBuffer: GPUBuffer | null = null;
  private _panelInstanceData: Float32Array = new Float32Array(0);
  private _panelInstanceCount: number = 0;
  private _panelInstanceCapacity: number = 0;
  private _dummyTex: GPUTexture | null = null;

  // ── Text pipeline ──
  private _textPipeline: GPURenderPipeline | null = null;
  private _textBindGroupLayout0: GPUBindGroupLayout | null = null;
  private _textBindGroupLayout1: GPUBindGroupLayout | null = null;
  private _textUniformBuffer: GPUBuffer | null = null;
  private _textInstanceBuffer: GPUBuffer | null = null;
  private _textInstanceData: Float32Array = new Float32Array(0);
  private _textInstanceCount: number = 0;
  private _textInstanceCapacity: number = 0;

  // ── Blit pipeline ──
  private _blitPipeline: GPURenderPipeline | null = null;
  private _blitBindGroupLayout: GPUBindGroupLayout | null = null;
  private _linearSampler: GPUSampler | null = null;

  // ── Progressive blur pipeline ──
  private _progressiveBlurPipeline: GPURenderPipeline | null = null;
  private _progressiveBlurBindGroupLayout: GPUBindGroupLayout | null = null;
  private _progressiveBlurUniformBuffer: GPUBuffer | null = null;

  // ── Lifecycle ──

  Init = async (canvas: HTMLCanvasElement): Promise<void> => {
    this._gpu = await WebGPUDevice.Create(canvas);
    const device = this._gpu.Device;
    this._cache = new WebGPUPipelineCache(this._gpu);
    this._blur = new WebGPUBlurPass(this._gpu);

    // Quad geometry
    this._quadVB = device.createBuffer({
      size: QUAD_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._quadVB, 0, QUAD_VERTICES);

    this._quadIB = device.createBuffer({
      size: QUAD_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._quadIB, 0, QUAD_INDICES);

    // Sampler
    this._linearSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });

    // Dummy 1×1 black texture (placeholder when no backdrop is supplied)
    this._dummyTex = device.createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this._dummyTex },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    // dummyTex view created on demand via createView()

    // Uniform buffers
    this._panelUniformBuffer = device.createBuffer({
      size: 32, // PanelUniforms: 2f + 1f + pad + 2f + pad = 8 floats = 32 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._textUniformBuffer = device.createBuffer({
      size: 16, // TextUniforms: 2f + 2f pad = 16 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._progressiveBlurUniformBuffer = device.createBuffer({
      size: 80, // ProgressiveBlurUniforms: see struct
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._initPanelPipeline(device);
    this._initTextPipeline(device);
    this._initBlitPipeline(device);
    this._initProgressiveBlurPipeline(device);
  };

  Destroy = (): void => {
    this._blur?.Destroy();
    this._cache?.Destroy();
    this._sceneTex?.destroy();
    this._dummyTex?.destroy();
    this._quadVB?.destroy();
    this._quadIB?.destroy();
    this._panelUniformBuffer?.destroy();
    this._panelInstanceBuffer?.destroy();
    this._textUniformBuffer?.destroy();
    this._textInstanceBuffer?.destroy();
    this._progressiveBlurUniformBuffer?.destroy();
    this._gpu?.Destroy();
    this._gpu = null;
  };

  Resize = (width: number, height: number, _dpr: number): void => {
    if (width === this._width && height === this._height) return;
    this._width = width;
    this._height = height;

    const device = this._gpu!.Device;
    this._sceneTex?.destroy();
    this._sceneTex = device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
           | GPUTextureUsage.COPY_SRC,
    });
    this._sceneView = this._sceneTex.createView();
  };

  // ── Per-Frame ──

  BeginFrame = (): void => {
    this._encoder = this._gpu!.Device.createCommandEncoder();
  };

  EndFrame = (): void => {
    if (this._encoder) {
      this._gpu!.Device.queue.submit([this._encoder.finish()]);
      this._encoder = null;
    }
  };

  // ── Render Targets ──

  get SceneTexture(): GpuTextureHandle {
    return _wrap(this._sceneTex!);
  }

  get BlurPyramidTexture(): GpuTextureHandle {
    const tex = this._blur?.OutputTexture;
    if (!tex) throw new Error('[Jwift WebGPU] No blur output — call ComputeBlur first');
    return _wrap(tex);
  }

  // ── Scene Pass ──

  BeginScenePass = (clearR: number, clearG: number, clearB: number): void => {
    const pass = this._encoder!.beginRenderPass({
      colorAttachments: [{
        view: this._sceneView!,
        clearValue: { r: clearR, g: clearG, b: clearB, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    // Store the pass on the encoder — callers will issue draws into it
    (this._encoder as any)._currentPass = pass;
  };

  EndScenePass = (): void => {
    const pass = (this._encoder as any)?._currentPass as GPURenderPassEncoder | undefined;
    pass?.end();
    (this._encoder as any)._currentPass = undefined;
  };

  // ── Panel Rendering ──

  PanelBeginBatch = (): void => {
    this._panelInstanceCount = 0;
  };

  PanelAddInstance = (data: Float32Array, offset: number, count: number): void => {
    const floatsNeeded = this._panelInstanceCount * PANEL_FLOATS_PER_INSTANCE + count;
    if (floatsNeeded > this._panelInstanceData.length) {
      const newCap = Math.max(floatsNeeded, this._panelInstanceData.length * 2, 64 * PANEL_FLOATS_PER_INSTANCE);
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
    const device = this._gpu!.Device;
    const pass = (this._encoder as any)?._currentPass as GPURenderPassEncoder;
    if (!pass) return;

    // Upload uniforms
    device.queue.writeBuffer(this._panelUniformBuffer!, 0, new Float32Array([
      canvasWidth, canvasHeight, baseFrostLod, 0,
      specTiltX, specTiltY, 0, 0,
    ]));

    // Upload instance data
    const byteSize = this._panelInstanceCount * PANEL_FLOATS_PER_INSTANCE * 4;
    this._ensurePanelInstanceBuffer(byteSize);
    device.queue.writeBuffer(this._panelInstanceBuffer!, 0,
      this._panelInstanceData.buffer, 0, this._panelInstanceCount * PANEL_FLOATS_PER_INSTANCE * 4);

    // Bind groups
    const backdropTex = backdrop ? _unwrap(backdrop) : this._dummyTex!;
    const bg0 = device.createBindGroup({
      layout: this._panelBindGroupLayout0!,
      entries: [
        { binding: 0, resource: { buffer: this._panelUniformBuffer! } },
        { binding: 1, resource: backdropTex.createView() },
        { binding: 2, resource: this._linearSampler! },
      ],
    });
    const bg1 = device.createBindGroup({
      layout: this._panelBindGroupLayout1!,
      entries: [
        { binding: 0, resource: { buffer: this._panelInstanceBuffer! } },
      ],
    });

    pass.setPipeline(this._panelPipeline!);
    pass.setBindGroup(0, bg0);
    pass.setBindGroup(1, bg1);
    pass.setVertexBuffer(0, this._quadVB!);
    pass.setIndexBuffer(this._quadIB!, 'uint16');
    pass.drawIndexed(6, this._panelInstanceCount);
  };

  // ── Text Rendering ──

  TextBeginBatch = (): void => {
    this._textInstanceCount = 0;
  };

  TextAddInstance = (data: Float32Array, offset: number, count: number): void => {
    const floatsNeeded = this._textInstanceCount * TEXT_FLOATS_PER_INSTANCE + count;
    if (floatsNeeded > this._textInstanceData.length) {
      const newCap = Math.max(floatsNeeded, this._textInstanceData.length * 2, 128 * TEXT_FLOATS_PER_INSTANCE);
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
    const device = this._gpu!.Device;
    const pass = (this._encoder as any)?._currentPass as GPURenderPassEncoder;
    if (!pass) return;

    device.queue.writeBuffer(this._textUniformBuffer!, 0, new Float32Array([
      canvasWidth, canvasHeight, 0, 0,
    ]));

    const byteSize = this._textInstanceCount * TEXT_FLOATS_PER_INSTANCE * 4;
    this._ensureTextInstanceBuffer(byteSize);
    device.queue.writeBuffer(this._textInstanceBuffer!, 0,
      this._textInstanceData.buffer, 0, this._textInstanceCount * TEXT_FLOATS_PER_INSTANCE * 4);

    const atlasTex = _unwrap(atlas);
    const bg0 = device.createBindGroup({
      layout: this._textBindGroupLayout0!,
      entries: [
        { binding: 0, resource: { buffer: this._textUniformBuffer! } },
        { binding: 1, resource: atlasTex.createView() },
        { binding: 2, resource: this._linearSampler! },
      ],
    });
    const bg1 = device.createBindGroup({
      layout: this._textBindGroupLayout1!,
      entries: [
        { binding: 0, resource: { buffer: this._textInstanceBuffer! } },
      ],
    });

    pass.setPipeline(this._textPipeline!);
    pass.setBindGroup(0, bg0);
    pass.setBindGroup(1, bg1);
    pass.setVertexBuffer(0, this._quadVB!);
    pass.setIndexBuffer(this._quadIB!, 'uint16');
    pass.drawIndexed(6, this._textInstanceCount);
  };

  // ── Blur ──

  ComputeBlur = (
    input: GpuTextureHandle, width: number, height: number,
    radius: number, minDepth?: number,
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

  DrawProgressiveBlur = (params: ProgressiveBlurParams): void => {
    const device = this._gpu!.Device;
    const pass = (this._encoder as any)?._currentPass as GPURenderPassEncoder;
    if (!pass) return;

    device.queue.writeBuffer(this._progressiveBlurUniformBuffer!, 0, new Float32Array([
      this._width, this._height,              // resolution
      params.Rect.X, params.Rect.Y, params.Rect.W, params.Rect.H,  // rect
      params.MaxLod,                          // max_lod
      params.Direction,                       // direction (as f32, cast to i32 in shader)
      params.Opacity,                         // opacity
      0,                                      // _pad0
      params.Background.R, params.Background.G, params.Background.B, params.Background.A, // background
      params.Grading.Brightness, params.Grading.Saturation, params.Grading.Contrast, 0, // grading + pad
    ]));

    const bg = device.createBindGroup({
      layout: this._progressiveBlurBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._progressiveBlurUniformBuffer! } },
        { binding: 1, resource: _unwrap(params.Scene).createView() },
        { binding: 2, resource: this._linearSampler! },
        { binding: 3, resource: _unwrap(params.Pyramid).createView() },
        { binding: 4, resource: this._linearSampler! },
      ],
    });

    pass.setPipeline(this._progressiveBlurPipeline!);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._quadVB!);
    pass.setIndexBuffer(this._quadIB!, 'uint16');
    pass.drawIndexed(6);
  };

  // ── Blit ──

  Blit = (source: GpuTextureHandle): void => {
    const device = this._gpu!.Device;
    const pass = (this._encoder as any)?._currentPass as GPURenderPassEncoder;
    if (!pass) return;

    const bg = device.createBindGroup({
      layout: this._blitBindGroupLayout!,
      entries: [
        { binding: 0, resource: _unwrap(source).createView() },
        { binding: 1, resource: this._linearSampler! },
      ],
    });

    pass.setPipeline(this._blitPipeline!);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this._quadVB!);
    pass.setIndexBuffer(this._quadIB!, 'uint16');
    pass.drawIndexed(6);
  };

  // ── Texture Management ──

  CreateTexture = (width: number, height: number): GpuTextureHandle => {
    const tex = this._gpu!.Device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
           | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return _wrap(tex);
  };

  UploadSubTexture = (
    texture: GpuTextureHandle, x: number, y: number,
    source: HTMLCanvasElement | ImageBitmap,
  ): void => {
    this._gpu!.Device.queue.copyExternalImageToTexture(
      { source },
      { texture: _unwrap(texture), origin: { x, y } },
      { width: source.width, height: source.height },
    );
  };

  // ── Render State ──

  EnableBlend = (): void => {
    // Blend state is baked into pipelines in WebGPU. The panel/text pipelines
    // are created with alpha blending enabled. This is a no-op — the method
    // exists for Renderer interface compat with the WebGL2 state machine model.
  };

  DisableBlend = (): void => {
    // Same — blend state is per-pipeline in WebGPU. The blit pipeline has
    // no blending. Callers switch pipelines rather than toggling GL state.
  };

  BindDefaultTarget = (): void => {
    // Begin a new render pass targeting the swap chain texture.
    const swapChainView = this._gpu!.GetCurrentTexture().createView();
    const pass = this._encoder!.beginRenderPass({
      colorAttachments: [{
        view: swapChainView,
        loadOp: 'load',
        storeOp: 'store',
      }],
    });
    (this._encoder as any)._currentPass = pass;
  };

  SetViewport = (_x: number, _y: number, _width: number, _height: number): void => {
    // In WebGPU, viewport is set on the render pass encoder. Since we create
    // new passes for each target, the viewport is implicitly fullscreen.
    // Explicit sub-viewport support can be added when needed.
  };

  // ── Pipeline Initialization ───────────────────────────────────────────────

  private _initPanelPipeline = (device: GPUDevice): void => {
    const module = this._cache!.GetShaderModule('panel', panelSrc);

    this._panelBindGroupLayout0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this._panelBindGroupLayout1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });

    this._panelPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._panelBindGroupLayout0, this._panelBindGroupLayout1],
      }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 8, // vec2f = 2 × f32
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{
          format: 'rgba8unorm',
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  };

  private _initTextPipeline = (device: GPUDevice): void => {
    const module = this._cache!.GetShaderModule('text', textSrc);

    this._textBindGroupLayout0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this._textBindGroupLayout1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    this._textPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._textBindGroupLayout0, this._textBindGroupLayout1],
      }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{
          format: 'rgba8unorm',
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  };

  private _initBlitPipeline = (device: GPUDevice): void => {
    const module = this._cache!.GetShaderModule('blit', blitSrc);

    this._blitBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    this._blitPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._blitBindGroupLayout],
      }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: this._gpu!.Format }], // swap chain format, no blending
      },
      primitive: { topology: 'triangle-list' },
    });
  };

  private _initProgressiveBlurPipeline = (device: GPUDevice): void => {
    const module = this._cache!.GetShaderModule('progressiveBlur', progressiveBlurSrc);

    this._progressiveBlurBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    this._progressiveBlurPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._progressiveBlurBindGroupLayout],
      }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{
          format: 'rgba8unorm',
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  };

  // ── Buffer management ─────────────────────────────────────────────────────

  private _ensurePanelInstanceBuffer = (byteSize: number): void => {
    if (this._panelInstanceBuffer && this._panelInstanceCapacity >= byteSize) return;
    this._panelInstanceBuffer?.destroy();
    const cap = Math.max(byteSize, 64 * PANEL_FLOATS_PER_INSTANCE * 4);
    this._panelInstanceBuffer = this._gpu!.Device.createBuffer({
      size: cap,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._panelInstanceCapacity = cap;
  };

  private _ensureTextInstanceBuffer = (byteSize: number): void => {
    if (this._textInstanceBuffer && this._textInstanceCapacity >= byteSize) return;
    this._textInstanceBuffer?.destroy();
    const cap = Math.max(byteSize, 128 * TEXT_FLOATS_PER_INSTANCE * 4);
    this._textInstanceBuffer = this._gpu!.Device.createBuffer({
      size: cap,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._textInstanceCapacity = cap;
  };
}
