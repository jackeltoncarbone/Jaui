/**
 * Pipeline cache — caches GPURenderPipeline and GPUComputePipeline objects
 * by a string key. Pipeline creation involves shader compilation and is
 * expensive; caching ensures it happens once at init, not per-draw.
 */

import { WebGPUDevice } from './WebGPU.Device';

export class WebGPUPipelineCache {
  private _gpu: WebGPUDevice;
  private _renderPipelines = new Map<string, GPURenderPipeline>();
  private _computePipelines = new Map<string, GPUComputePipeline>();
  private _shaderModules = new Map<string, GPUShaderModule>();

  constructor(gpu: WebGPUDevice) {
    this._gpu = gpu;
  }

  /** Get or create a shader module from WGSL source. Cached by label. */
  GetShaderModule = (label: string, code: string): GPUShaderModule => {
    let mod = this._shaderModules.get(label);
    if (!mod) {
      mod = this._gpu.Device.createShaderModule({ label, code });
      this._shaderModules.set(label, mod);
    }
    return mod;
  };

  /** Get or create a render pipeline. */
  GetRenderPipeline = (
    key: string,
    descriptor: GPURenderPipelineDescriptor,
  ): GPURenderPipeline => {
    let pipeline = this._renderPipelines.get(key);
    if (!pipeline) {
      pipeline = this._gpu.Device.createRenderPipeline(descriptor);
      this._renderPipelines.set(key, pipeline);
    }
    return pipeline;
  };

  /** Get or create a compute pipeline. */
  GetComputePipeline = (
    key: string,
    descriptor: GPUComputePipelineDescriptor,
  ): GPUComputePipeline => {
    let pipeline = this._computePipelines.get(key);
    if (!pipeline) {
      pipeline = this._gpu.Device.createComputePipeline(descriptor);
      this._computePipelines.set(key, pipeline);
    }
    return pipeline;
  };

  Destroy = (): void => {
    this._renderPipelines.clear();
    this._computePipelines.clear();
    this._shaderModules.clear();
  };
}
