/**
 * Vitest setup — polyfills `OffscreenCanvas` for the Node environment.
 *
 * Phase 0 of the worker migration switched the engine from
 * `document.createElement('canvas')` to `new OffscreenCanvas(w, h)`.
 * Vitest runs in Node by default, where neither exists. Tests that
 * exercise text/image cache code paths now hit `new OffscreenCanvas`
 * and need a usable polyfill.
 *
 * The polyfill emulates only what the engine reads:
 *   • `measureText(t).width` returns `t.length * 8` (matches the legacy
 *     mock-ctx convention shared by Text.Animator.test, Text.Cache.test,
 *     etc., so test expectations stay valid).
 *   • `fillText`, `clearRect`, `drawImage`, etc. are no-ops; tests that
 *     spy on call counts via `vi.fn` should override the ctx via
 *     `OffscreenCanvas.prototype.getContext = vi.fn(() => mockCtx)` or
 *     similar in a beforeEach.
 *   • `getImageData` returns a zero-buffer ImageData-shaped object.
 *
 * If a future test needs a real raster (e.g. snapshot diff), swap to
 * `happy-dom` or `jsdom` env in vitest.config — they provide a more
 * faithful Canvas2D shim. The fake here is intentionally small and fast.
 */

// `self` polyfill — `@jaui/Core/Jaui` re-exports worker entry points (BootJauiWorker
// from Worker.Boot) whose module top-level reads `self` (the worker/browser global).
// Node has no `self`, so importing the engine for a Canvas test throws
// `ReferenceError: self is not defined` before any test runs. Alias it to globalThis.
if (typeof (globalThis as { self?: unknown }).self === 'undefined') {
  (globalThis as { self?: unknown }).self = globalThis;
}

class FakeOffscreenCanvasRenderingContext2D {
  public canvas: FakeOffscreenCanvas;
  public font = '';
  public fillStyle: string | CanvasGradient | CanvasPattern = '';
  public strokeStyle: string | CanvasGradient | CanvasPattern = '';
  public textAlign = '';
  public textBaseline = '';
  public letterSpacing = '';
  public lineWidth = 1;
  public globalAlpha = 1;

  constructor(canvas: FakeOffscreenCanvas) { this.canvas = canvas; }

  measureText(text: string): { width: number } {
    // 8 px per char — matches every legacy mock ctx in the test suite,
    // so existing measurement-based assertions keep their numbers.
    return { width: text.length * 8 };
  }

  fillText(): void {}
  strokeText(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  clearRect(): void {}
  drawImage(): void {}
  beginPath(): void {}
  closePath(): void {}
  fill(): void {}
  stroke(): void {}
  save(): void {}
  restore(): void {}
  scale(): void {}
  translate(): void {}
  rotate(): void {}
  setTransform(): void {}
  resetTransform(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  quadraticCurveTo(): void {}
  bezierCurveTo(): void {}
  rect(): void {}
  clip(): void {}

  getImageData(): { data: Uint8ClampedArray; width: number; height: number; colorSpace: string } {
    return { data: new Uint8ClampedArray(0), width: 0, height: 0, colorSpace: 'srgb' };
  }
  putImageData(): void {}
  createImageData(): { data: Uint8ClampedArray; width: number; height: number; colorSpace: string } {
    return { data: new Uint8ClampedArray(0), width: 0, height: 0, colorSpace: 'srgb' };
  }
}

// Extends EventTarget so the engine's WebGL context-loss listeners
// (`webglcontextlost` / `webglcontextrestored`) can be added and tests can
// `dispatchEvent` them — a real OffscreenCanvas is an EventTarget too.
class FakeOffscreenCanvas extends EventTarget {
  public width: number;
  public height: number;
  private _ctx: FakeOffscreenCanvasRenderingContext2D | null = null;

  constructor(width: number, height: number) {
    super();
    this.width = width;
    this.height = height;
  }

  getContext(type: string, _options?: unknown): unknown {
    if (type !== '2d') return null;
    if (!this._ctx) this._ctx = new FakeOffscreenCanvasRenderingContext2D(this);
    return this._ctx;
  }

  convertToBlob(_options?: { type?: string; quality?: number }): Promise<Blob> {
    return Promise.resolve(new Blob([], { type: 'image/png' }));
  }

  transferToImageBitmap(): unknown {
    return { width: this.width, height: this.height, close: () => {} };
  }
}

if (typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas === 'undefined') {
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeOffscreenCanvas;
}

// `createImageBitmap` polyfill — Image.Cache uses it to decode fetched
// blobs. For tests that don't actually fetch, we provide a stub so the
// type checks line up; tests that exercise image-load code paths should
// mock `fetch` themselves.
if (typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap === 'undefined') {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = (_blob: Blob) =>
    Promise.resolve({ width: 1, height: 1, close: () => {} });
}

// `requestAnimationFrame` polyfill — Canvas.AnimationManager.Kick uses it
// to drive the render loop. In Node, schedule via setTimeout so test
// flows that need a tick can `await new Promise(setImmediate)` (or just
// not depend on a frame firing — most tests don't).
if (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === 'undefined') {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame =
    (cb: (t: number) => void): number => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number;
    };
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame =
    (id: number): void => clearTimeout(id);
}

// `ResizeObserver` polyfill — Canvas wires one to its element on construct.
// The stub never fires; tests that need a resize push it directly via the
// engine's _pendingResize / _resize() API instead of through the observer.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
