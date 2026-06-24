/**
 * CanvasProxy — main-thread stand-in for the Jaui `Canvas` instance that
 * now lives in the worker.
 *
 * The Angular `<jaui>` component used to expose `Canvas: Canvas` and
 * children read `Canvas.Images.LoadSvg(...)`, `Canvas.Dpr`, etc. directly.
 * With the engine in a worker, those reads can't reach the live engine
 * synchronously. This proxy preserves the API surface — calls forward
 * to the worker via the bridge; reads return locally-cached values.
 *
 * What's covered:
 *   • `Images.LoadUrl(url, dpr?)`, `Images.LoadSvg(key, svg, w, h, dpr)`
 *     — forward to worker.
 *   • `Dpr` — local `window.devicePixelRatio` (mirrors what the worker
 *     would compute via WorkerPlatform).
 *   • `SetJssVars(map)` — forward.
 *   • `Animations.Kick()` — forward (mostly redundant; worker auto-kicks
 *     after each op, but consumers calling Kick directly still work).
 *   • `Element` — the proxy DOM canvas. NOT the OffscreenCanvas (that's
 *     transferred and lives in the worker now).
 *   • `Root` — a `JivHandle` for the worker-side root (id 0).
 *   • `Start() / Stop()` — lifecycle messages.
 *
 * What's NOT covered (deferred):
 *   • Reading geometry (Width / Height / Dpr-derived measurements) for
 *     anything but the canvas root. Read it through a `JivHandle` with
 *     `WatchRect(true)` instead.
 *   • Direct JivCore tree traversal (`Canvas.Root.Children`, etc.).
 *   • Canvas-level frame callbacks (`Canvas.OnFrame(...)`); replace with
 *     worker-side hooks via custom messages if needed.
 */

import type { MainBridge } from './Bridge.Main';
import { JivHandle } from './Jiv.Handle';
import { RootId } from './Bridge.Main';

class CanvasImagesProxy {
  private _bridge: MainBridge;
  constructor(bridge: MainBridge) { this._bridge = bridge; }

  LoadUrl = (url: string, dpr: number = 1): void => {
    this._bridge.PostMessage({ T: 'image-url', Url: url, Dpr: dpr });
  };
  LoadSvg = (key: string, svg: string, width: number, height: number, dpr: number = 1): void => {
    // SVG decoding via `createImageBitmap` doesn't work in Chrome workers
    // (DOM-only). Rasterize here on the main thread using a real <img> +
    // canvas, then transfer the resulting ImageBitmap to the worker for
    // upload. The browser caches the SVG blob URL, so subsequent draws
    // of the same SVG (e.g. the same logo at multiple DPRs) are cheap.
    const pxW = Math.max(1, Math.ceil(width * dpr));
    const pxH = Math.max(1, Math.ceil(height * dpr));
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    const img = new Image();
    img.onload = (): void => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = pxW;
        canvas.height = pxH;
        const ctx = canvas.getContext('2d');
        if (!ctx) { URL.revokeObjectURL(url); return; }
        ctx.clearRect(0, 0, pxW, pxH);
        ctx.drawImage(img, 0, 0, pxW, pxH);
        URL.revokeObjectURL(url);
        // createImageBitmap from a canvas works in Chrome — only SVG blobs
        // are problematic. The resulting bitmap is transferable.
        createImageBitmap(canvas).then((bitmap) => {
          this._bridge.PostMessage({ T: 'image-bitmap', Key: key, Bitmap: bitmap });
        }).catch((err) => {
          console.warn(`[Jaui.CanvasProxy] createImageBitmap from canvas failed for ${key}:`, err);
        });
      } catch (err) {
        URL.revokeObjectURL(url);
        console.warn(`[Jaui.CanvasProxy] SVG rasterize failed for ${key}:`, err);
      }
    };
    img.onerror = (): void => {
      URL.revokeObjectURL(url);
      console.warn(`[Jaui.CanvasProxy] SVG image load failed for ${key}`);
    };
    img.src = url;
  };
}

class CanvasAnimationsProxy {
  private _bridge: MainBridge;
  constructor(bridge: MainBridge) { this._bridge = bridge; }
  Kick = (): void => {
    this._bridge.PostMessage({ T: 'kick' });
  };
}

export class CanvasProxy {
  readonly Element: HTMLCanvasElement;
  readonly Root: JivHandle;
  readonly Images: CanvasImagesProxy;
  readonly Animations: CanvasAnimationsProxy;

  private _bridge: MainBridge;

  constructor(bridge: MainBridge) {
    this._bridge = bridge;
    this.Element = bridge.Canvas;
    this.Root = new JivHandle(bridge, RootId);
    this.Images = new CanvasImagesProxy(bridge);
    this.Animations = new CanvasAnimationsProxy(bridge);
  }

  /** Local mirror of `window.devicePixelRatio` — matches what
   *  WorkerPlatform.GetDevicePixelRatio() returns inside the worker. */
  get Dpr(): number { return window.devicePixelRatio || 1; }

  /**
   * Convert a DOM client-space pointer (a PointerEvent's `clientX`/`clientY`) into the canvas NODE
   * coordinate space — the DEVICE-pixel space that laid-out `Jiv` rects (`node.X/Y/Width/Height`) live in.
   *
   * THE single source of truth for main-thread components that attach their own pointer listeners to the
   * canvas `Element` and hit-test against node rects (tab bars, the selection indicator, any future drag
   * tracker). Node rects are CSS × `Dpr`, but `clientX`/`getBoundingClientRect` are CSS px — so a raw
   * `clientX - rect.left` mis-hits on ≥2× (retina) displays (items past the visual midpoint become
   * unclickable). This applies the canvas origin AND the device scale once, correctly, everywhere.
   *
   * (Fraction-based controls — slider/wheel that divide the pointer by their OWN element rect to get a
   * 0..1 value — are dpr-independent and do NOT need this.)
   */
  /** Map a viewport client point into Jaui NODE space. Node coordinates are CSS px (the layout solver
   *  works in CSS px; paint scales by DPR at draw time, and the worker's own pointer pipeline —
   *  `MainBridge._toCanvasLocal` — hit-tests in CSS px too). So this is purely a canvas-origin offset,
   *  NOT a DPR scale: multiplying by DPR returned device px, which mis-hit every node rect on any HiDPI
   *  display (DPR ≠ 1) — e.g. it made every `<tab-bar>` unclickable at 125% scale. */
  ClientToNodePoint(clientX: number, clientY: number): [number, number] {
    const rect = this.Element.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }

  SetJssVars = (vars: Map<string, string>): void => {
    this._bridge.PostMessage({ T: 'jss-vars', Entries: Array.from(vars.entries()) });
  };

  Start = (): void => {
    this._bridge.PostMessage({ T: 'control', Action: 'start' });
  };
  Stop = (): void => {
    this._bridge.PostMessage({ T: 'control', Action: 'stop' });
  };
}
