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
  readonly Canvas: HTMLCanvasElement;

  private _onDeviceLost: (() => void) | null = null;

  private constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    canvas: HTMLCanvasElement,
  ) {
    this.Adapter = adapter;
    this.Device = device;
    this.Context = context;
    this.Format = format;
    this.Canvas = canvas;

    device.lost.then((info) => {
      console.warn(`[Jwift] WebGPU device lost: ${info.reason} — ${info.message}`);
      if (this._onDeviceLost) this._onDeviceLost();
    });
  }

  /** Async factory — adapter and device creation are both promises. */
  static Create = async (canvas: HTMLCanvasElement): Promise<WebGPUDevice> => {
    if (!navigator.gpu) {
      throw new Error('[Jwift] WebGPU not supported in this browser');
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      throw new Error('[Jwift] Failed to obtain WebGPU adapter');
    }

    const device = await adapter.requestDevice({
      // Request no optional features for now — compute shaders, storage
      // textures, and everything we need are in the base WebGPU spec.
      // We can add 'float32-filterable' etc. when needed.
    });

    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('[Jwift] Failed to obtain WebGPU canvas context');
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
