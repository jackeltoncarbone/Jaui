/**
 * WebGPU compute-shader blur pyramid.
 *
 * Port of BlurPass.ts (WebGL2 dual-filter blur with FBO ping-pong) to WebGPU
 * compute dispatches. The algorithm is identical — 5-tap downsample, 8-tap
 * tent upsample — but all pyramid levels are dispatched in a single command
 * encoder with no FBO bind/unbind between them. The GPU stays busy without
 * pipeline bubbles.
 *
 * Reference: Marius Bjørge, ARM, "Bandwidth-Efficient Rendering", SIGGRAPH 2015.
 */

import { WebGPUDevice } from './WebGPU.Device';
import blurDownSrc from './Shaders/Blur.Down.wgsl.gen';
import blurUpSrc from './Shaders/Blur.Up.wgsl.gen';
import mipmapSrc from './Shaders/Mipmap.Gen.wgsl.gen';

const MAX_LEVELS = 5;
const WORKGROUP_SIZE = 8;

/** Pure-math pyramid depth calculation. Shared logic with BlurPass.ts lines 126-137. */
export const ComputeBlurDepth = (radius: number, minDepth: number = 0): { Depth: number; TapOffset: number } => {
  const target = Math.max(1, radius);
  const depth = Math.max(Math.max(1, minDepth), Math.min(MAX_LEVELS - 1, Math.ceil(Math.log2(target / 3 + 1))));
  const baseSigma = 3 * Math.pow(2, depth);
  const tapOffset = Math.max(0.7, Math.min(1.3, target / baseSigma));
  return { Depth: depth, TapOffset: tapOffset };
};

export class WebGPUBlurPass {
  private _gpu: WebGPUDevice;
  private _downPipeline: GPUComputePipeline;
  private _upPipeline: GPUComputePipeline;
  private _mipmapPipeline: GPUComputePipeline;
  private _sampler: GPUSampler;
  private _uniformBuffer: GPUBuffer;

  /** Pyramid level textures. levels[0] is full-res output, levels[1..depth] are halved. */
  private _levels: (GPUTexture | null)[] = new Array(MAX_LEVELS).fill(null);
  private _levelWidths: number[] = new Array(MAX_LEVELS).fill(0);
  private _levelHeights: number[] = new Array(MAX_LEVELS).fill(0);

  /** The final output texture with mipmaps — what glass and progressive blur sample. */
  private _output: GPUTexture | null = null;
  private _outputWidth: number = 0;
  private _outputHeight: number = 0;

  private _lastDepth: number = 0;
  get LastDepth(): number { return this._lastDepth; }

  /** The output texture (level 0 of the pyramid, or the mipmapped output). */
  get OutputTexture(): GPUTexture | null { return this._output ?? this._levels[0]; }

  private _downBindGroupLayout: GPUBindGroupLayout;
  private _mipmapBindGroupLayout: GPUBindGroupLayout;

  constructor(gpu: WebGPUDevice) {
    this._gpu = gpu;
    const device = gpu.Device;

    // Shared bind group layout for both down and up compute shaders:
    // binding 0: source texture
    // binding 1: sampler
    // binding 2: destination storage texture
    // binding 3: uniform buffer (half_pixel, tap_offset)
    this._downBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    const blurPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this._downBindGroupLayout],
    });

    this._downPipeline = device.createComputePipeline({
      layout: blurPipelineLayout,
      compute: {
        module: device.createShaderModule({ code: blurDownSrc }),
        entryPoint: 'main',
      },
    });

    this._upPipeline = device.createComputePipeline({
      layout: blurPipelineLayout,
      compute: {
        module: device.createShaderModule({ code: blurUpSrc }),
        entryPoint: 'main',
      },
    });

    // Mipmap bind group layout: src texture, sampler, dst storage texture (no uniform)
    this._mipmapBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      ],
    });

    this._mipmapPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._mipmapBindGroupLayout] }),
      compute: {
        module: device.createShaderModule({ code: mipmapSrc }),
        entryPoint: 'main',
      },
    });

    this._sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Uniform buffer for BlurParams: half_pixel (vec2f) + tap_offset (f32) + pad (f32) = 16 bytes
    this._uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Run the dual-filter blur pyramid. Returns the output GPUTexture (level 0).
   * The caller should NOT destroy the returned texture — it's owned by this class.
   */
  Blur = (input: GPUTexture, width: number, height: number, radius: number, minDepth: number = 0): GPUTexture => {
    const device = this._gpu.Device;
    const { Depth: depth, TapOffset: tapOffset } = ComputeBlurDepth(radius, minDepth);
    this._lastDepth = depth;

    // Ensure pyramid level textures exist at the right sizes.
    this._ensureLevel(0, width, height);
    let w = width, h = height;
    for (let i = 1; i <= depth; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this._ensureLevel(i, w, h);
    }

    const encoder = device.createCommandEncoder();

    // ── Downsample chain: input → level 1 → level 2 → ... → level depth ──
    let srcTexture = input;
    let srcW = width, srcH = height;

    for (let i = 1; i <= depth; i++) {
      const dstTexture = this._levels[i]!;
      const dstW = this._levelWidths[i];
      const dstH = this._levelHeights[i];

      // Write uniform: half_pixel of SOURCE, tap_offset
      device.queue.writeBuffer(this._uniformBuffer, 0, new Float32Array([
        0.5 / srcW, 0.5 / srcH, tapOffset, 0,
      ]));

      const bindGroup = device.createBindGroup({
        layout: this._downBindGroupLayout,
        entries: [
          { binding: 0, resource: srcTexture.createView() },
          { binding: 1, resource: this._sampler },
          { binding: 2, resource: dstTexture.createView() },
          { binding: 3, resource: { buffer: this._uniformBuffer } },
        ],
      });

      const pass = encoder.beginComputePass();
      pass.setPipeline(this._downPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(dstW / WORKGROUP_SIZE),
        Math.ceil(dstH / WORKGROUP_SIZE),
      );
      pass.end();

      srcTexture = dstTexture;
      srcW = dstW;
      srcH = dstH;
    }

    // ── Upsample chain: level depth → level depth-1 → ... → level 0 ──
    for (let i = depth - 1; i >= 0; i--) {
      const dstTexture = this._levels[i]!;
      const dstW = this._levelWidths[i];
      const dstH = this._levelHeights[i];

      device.queue.writeBuffer(this._uniformBuffer, 0, new Float32Array([
        0.5 / srcW, 0.5 / srcH, tapOffset, 0,
      ]));

      const bindGroup = device.createBindGroup({
        layout: this._downBindGroupLayout,
        entries: [
          { binding: 0, resource: srcTexture.createView() },
          { binding: 1, resource: this._sampler },
          { binding: 2, resource: dstTexture.createView() },
          { binding: 3, resource: { buffer: this._uniformBuffer } },
        ],
      });

      const pass = encoder.beginComputePass();
      pass.setPipeline(this._upPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(dstW / WORKGROUP_SIZE),
        Math.ceil(dstH / WORKGROUP_SIZE),
      );
      pass.end();

      srcTexture = dstTexture;
      srcW = dstW;
      srcH = dstH;
    }

    device.queue.submit([encoder.finish()]);

    return this._levels[0]!;
  };

  /**
   * Generate mipmaps on the output texture. Needed by the glass shader
   * (textureSampleLevel for per-Jiv frost LOD) and the progressive blur
   * shader (textureSampleLevel across the gradient).
   *
   * Creates a new mipmapped texture, copies level 0 into mip 0, then
   * dispatches the mipmap compute shader for each subsequent level.
   */
  GenerateOutputMipmap = (): void => {
    const level0 = this._levels[0];
    if (!level0) return;

    const device = this._gpu.Device;
    const w = this._levelWidths[0];
    const h = this._levelHeights[0];
    const mipCount = Math.floor(Math.log2(Math.max(w, h))) + 1;

    // Create / re-create the mipmapped output texture if size changed.
    if (!this._output || this._outputWidth !== w || this._outputHeight !== h) {
      if (this._output) this._output.destroy();
      this._output = device.createTexture({
        size: { width: w, height: h },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
             | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        mipLevelCount: mipCount,
      });
      this._outputWidth = w;
      this._outputHeight = h;
    }

    const encoder = device.createCommandEncoder();

    // Copy level 0 (blur output) into mip 0 of the output texture.
    encoder.copyTextureToTexture(
      { texture: level0 },
      { texture: this._output, mipLevel: 0 },
      { width: w, height: h },
    );

    // Generate each subsequent mip level via compute shader.
    let mipW = w, mipH = h;
    for (let mip = 1; mip < mipCount; mip++) {
      mipW = Math.max(1, Math.floor(mipW / 2));
      mipH = Math.max(1, Math.floor(mipH / 2));

      const bindGroup = device.createBindGroup({
        layout: this._mipmapBindGroupLayout,
        entries: [
          { binding: 0, resource: this._output.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this._sampler },
          { binding: 2, resource: this._output.createView({ baseMipLevel: mip, mipLevelCount: 1 }) },
        ],
      });

      const pass = encoder.beginComputePass();
      pass.setPipeline(this._mipmapPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(mipW / WORKGROUP_SIZE),
        Math.ceil(mipH / WORKGROUP_SIZE),
      );
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
  };

  Destroy = (): void => {
    for (const tex of this._levels) tex?.destroy();
    this._levels.fill(null);
    this._output?.destroy();
    this._output = null;
    this._uniformBuffer.destroy();
  };

  /** Ensure a pyramid level texture exists at the given size. */
  private _ensureLevel = (index: number, width: number, height: number): void => {
    if (this._levelWidths[index] === width && this._levelHeights[index] === height && this._levels[index]) {
      return;
    }

    this._levels[index]?.destroy();
    this._levels[index] = this._gpu.Device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
           | GPUTextureUsage.COPY_SRC,
    });
    this._levelWidths[index] = width;
    this._levelHeights[index] = height;
  };
}
