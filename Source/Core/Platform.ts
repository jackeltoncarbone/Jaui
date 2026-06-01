/**
 * Platform — abstraction over the browser globals (`window`, `document`,
 * `navigator`) the engine depends on. In normal main-thread mode, the
 * `BrowserPlatform` impl resolves directly to those globals. In worker
 * mode (Phase 1+), a `WorkerPlatform` impl bridges via postMessage to the
 * main thread, where the real DOM lives.
 *
 * Anything the engine reads from globals goes through here:
 *
 *   • devicePixelRatio + (pointer: coarse) clamp
 *   • DPR-change subscription (browser zoom)
 *   • document.activeElement sentinel for selection-key suppression
 *   • document.fonts loadingdone subscription
 *   • window-level keydown listener (selection shortcuts: Cmd/Ctrl+A, Esc)
 *   • URL search / hash (debug flags)
 *
 * Things this DOES NOT cover:
 *   • Per-element listeners on the canvas (pointer/wheel/touch). Those
 *     are forwarded as event payloads in worker mode and registered
 *     directly on `this.Element` on main, so they don't need a shim.
 *   • DOM creation for the debug HUD overlay. That's quarantined and
 *     elided in worker mode.
 */

export interface Platform {
  // ── Display / DPR ──

  /** Current devicePixelRatio (≥1). */
  GetDevicePixelRatio(): number;

  /** True if the primary pointer is coarse (touch). Used to clamp DPR ≤ 2
   *  on phones, where 3× DPR is too expensive for our text shader budget. */
  IsPointerCoarse(): boolean;

  /** Subscribe to DPR changes (browser zoom in/out). The handler fires once
   *  per change, then re-arms itself — matching matchMedia's one-shot
   *  semantics for `(resolution: Ndppx)`. Returns a disposer. */
  ObserveDprChange(currentDpr: number, handler: () => void): () => void;

  // ── Focus / keyboard ──

  /** True if a real DOM input/textarea/contenteditable currently has focus.
   *  Used to suppress engine selection shortcuts (Cmd/Ctrl+A, Esc) when the
   *  user is typing into an actual form field outside our canvas. */
  IsTextInputFocused(): boolean;

  /** Register a window-level keydown listener for engine-global shortcuts.
   *  In worker mode, main-thread captures and forwards. Returns a disposer. */
  AddKeydownListener(handler: (e: KeyboardEvent) => void, options?: AddEventListenerOptions): () => void;

  // ── Fonts ──

  /** Subscribe to FontFaceSet 'loadingdone'. Engine flushes its glyph cache
   *  on this signal so newly-available fonts don't render with stale metrics. */
  ObserveFontsLoadingDone(handler: () => void): () => void;

  // ── URL flags ──

  /** `window.location.search`. Used at boot to read `?debug`, `?dpr=N`, etc. */
  GetUrlSearch(): string;

  /** `window.location.hash`. Same role as Search for `#debug` style flags. */
  GetUrlHash(): string;
}

/** Default Platform — direct DOM/global access. Used on main thread. */
export const BrowserPlatform: Platform = {
  GetDevicePixelRatio: (): number => {
    if (typeof window === 'undefined') return 1;
    return window.devicePixelRatio || 1;
  },

  IsPointerCoarse: (): boolean => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(pointer: coarse)').matches;
  },

  ObserveDprChange: (currentDpr: number, handler: () => void): (() => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mql = window.matchMedia(`(resolution: ${currentDpr}dppx)`);
    // Older Safari uses `addListener`/`removeListener`; modern engines use
    // addEventListener. Support both.
    const onChange = (): void => handler();
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange, { once: true } as AddEventListenerOptions);
      return () => mql.removeEventListener('change', onChange);
    }
    const legacy = mql as unknown as {
      addListener: (cb: () => void) => void;
      removeListener: (cb: () => void) => void;
    };
    legacy.addListener(onChange);
    return () => legacy.removeListener(onChange);
  },

  IsTextInputFocused: (): boolean => {
    if (typeof document === 'undefined') return false;
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if ((ae as HTMLElement).isContentEditable) return true;
    return false;
  },

  AddKeydownListener: (handler, options): (() => void) => {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('keydown', handler, options);
    return () => window.removeEventListener('keydown', handler, options);
  },

  ObserveFontsLoadingDone: (handler): (() => void) => {
    if (typeof document === 'undefined' || !document.fonts) return () => {};
    document.fonts.addEventListener('loadingdone', handler);
    return () => document.fonts.removeEventListener('loadingdone', handler);
  },

  GetUrlSearch: (): string => {
    if (typeof window === 'undefined' || !window.location) return '';
    return window.location.search;
  },

  GetUrlHash: (): string => {
    if (typeof window === 'undefined' || !window.location) return '';
    return window.location.hash;
  },
};
