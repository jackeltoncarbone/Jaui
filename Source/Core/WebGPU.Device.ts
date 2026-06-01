/**
 * WebGPU device lifecycle — adapter negotiation, device creation, canvas
 * surface configuration. One instance per Canvas.
 *
 * All GPU objects flow from the Device this class holds. If the device is
 * lost (tab backgrounded on mobile, driver crash), the `OnDeviceLost`
 * callback fires so the Canvas can re-init.
 */

export class WebGPUDevice {
  readonly Device: GPUDevice;
  readonly Adapter: GPUAdapter;
  readonly Context: GPUCanvasContext;
  readonly Format: GPUTextureFormat;
  readonly Canvas: HTMLCanvasElement | OffscreenCanvas;

  private _onDeviceLost: (() => void) | null = null;

  private constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    canvas: HTMLCanvasElement | OffscreenCanvas,
  ) {
    this.Adapter = adapter;
    this.Device = device;
    this.Context = context;
    this.Format = format;
    this.Canvas = canvas;

    device.lost.then((info) => {
      console.warn(`[Jaui] WebGPU device lost: ${info.reason} — ${info.message}`);
      if (this._onDeviceLost) this._onDeviceLost();
    });
  }

  /** Async factory — adapter and device creation are both promises.
   *  Escalates adapter requests in order: high-performance → default →
   *  forceFallbackAdapter. The software fallback (SwiftShader / Dawn Swift)
   *  is slower than WebGL2 hardware but lets the WebGPU code path run end-
   *  to-end on machines where Chrome reports "WebGPU: Software only" in
   *  chrome://gpu. Useful for development/shader validation, not production
   *  performance. */
  static Create = async (canvas: HTMLCanvasElement | OffscreenCanvas): Promise<WebGPUDevice> => {
    if (!navigator.gpu) {
      throw new Error('[Jaui] WebGPU not supported in this browser');
    }

    let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    let adapterKind = 'high-performance';

    if (!adapter) {
      // No high-perf adapter — try default (low-power / integrated) before
      // giving up on hardware. Some Chrome + driver combos only expose the
      // integrated GPU here even when a discrete one exists.
      adapter = await navigator.gpu.requestAdapter();
      adapterKind = 'default';
    }

    if (!adapter) {
      // Last resort: software fallback. Chrome reports these in chrome://gpu
      // as "WebGPU: Software only, hardware acceleration unavailable." Opt
      // in explicitly — the spec says hardware adapters are preferred and
      // software is only returned when `forceFallbackAdapter: true`.
      adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
      adapterKind = 'software-fallback';
    }

    if (!adapter) {
      throw new Error('[Jaui] Failed to obtain WebGPU adapter (hardware and software fallback both failed)');
    }

    // `isFallbackAdapter` is the canonical flag for "this is software" but
    // isn't in every @webgpu/types version. Read via any-cast so we surface
    // it in the log when Chrome provides it.
    const isFallback = (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter;
    console.log(`[Jaui] WebGPU adapter acquired: ${adapterKind}${isFallback ? ' (isFallbackAdapter=true)' : ''}`);

    const device = await adapter.requestDevice({
      // Request no optional features for now — compute shaders, storage
      // textures, and everything we need are in the base WebGPU spec.
      // We can add 'float32-filterable' etc. when needed.
    });

    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('[Jaui] Failed to obtain WebGPU canvas context');
    }

    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
      device,
      format,
      alphaMode: 'opaque',
    });

    return new WebGPUDevice(adapter, device, context, format, canvas);
  };

  /** Set callback for device loss (tab backgrounded, driver crash). */
  set OnDeviceLost(callback: (() => void) | null) {
    this._onDeviceLost = callback;
  }

  /** Reconfigure the surface after canvas resize. */
  Configure = (_width: number, _height: number): void => {
    // The canvas element's width/height should already be set by the caller.
    // Re-configure the context so the swap chain texture matches.
    this.Context.configure({
      device: this.Device,
      format: this.Format,
      alphaMode: 'opaque',
    });
  };

  /** Get the current swap chain texture to render into. */
  GetCurrentTexture = (): GPUTexture => {
    return this.Context.getCurrentTexture();
  };

  Destroy = (): void => {
    this.Device.destroy();
  };
}
