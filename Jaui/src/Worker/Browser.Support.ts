/**
 * Browser support gate — feature-detects everything Jaui needs to run
 * its rendering engine in a Web Worker. Apps call this at boot before
 * spinning up the Angular / DOM bootstrap; if it returns `false` they
 * should render a static "update your browser" page and skip the rest.
 *
 * What we require:
 *   • `OffscreenCanvas` — the canvas type we transfer to the worker.
 *   • `OffscreenCanvas.prototype.transferToImageBitmap` (a stand-in for
 *     "this is a real OffscreenCanvas, not a name collision") — and
 *     more importantly, the `transferControlToOffscreen` method on
 *     HTMLCanvasElement which is the actual transfer call.
 *   • `Worker` — the worker constructor.
 *   • `WebGL2RenderingContext` — the engine's render backend. We don't
 *     create one here (that would require a canvas), but the constructor
 *     existing tells us it's available; actual context creation can
 *     still fail later (driver issues), which is handled separately.
 *
 * Browsers that fail this in 2026:
 *   • iPhone 7 (iOS 15 max), iPhone 8 / X (iOS 16 max — pre-16.4 lacks
 *     OffscreenCanvas in workers).
 *   • Old Android WebView (<= Chrome 68 era, 2018 abandonware).
 *   • Embedded WebKits in apps that haven't updated since 2019.
 *
 * This is a hard gate — there is no main-thread fallback. Apps SHOULD
 * surface a clear "update your browser" experience for these users.
 */

export interface BrowserSupportResult {
  Supported: boolean;
  /** When unsupported, the human-readable reason (which feature is
   *  missing). Useful for telemetry and for the error page. */
  Reason?: string;
}

export const CheckBrowserSupport = (): BrowserSupportResult => {
  if (typeof OffscreenCanvas === 'undefined') {
    return { Supported: false, Reason: 'OffscreenCanvas is not available in this browser.' };
  }
  if (typeof Worker === 'undefined') {
    return { Supported: false, Reason: 'Web Worker is not available in this browser.' };
  }
  if (typeof HTMLCanvasElement === 'undefined' ||
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function') {
    return { Supported: false, Reason: 'HTMLCanvasElement.transferControlToOffscreen is not available.' };
  }
  if (typeof WebGL2RenderingContext === 'undefined') {
    return { Supported: false, Reason: 'WebGL2 is not available in this browser.' };
  }
  return { Supported: true };
};
