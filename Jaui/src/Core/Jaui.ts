/**
 * Jaui — Canvas-based UI rendering engine.
 * Entry point. Creates a WebGL2 context and runs the render loop.
 */

import { JivAnimator } from '../Jiv/Jiv.Animator';
import { JivStyleAnimator } from '../Jiv/Jiv.StyleAnimator';
import { AnimationManager } from '../Animation/Animation.Manager';
import { SolveLayout } from '../Layout/Layout.Solver';
import { ComputeIntrinsicSizes, CascadePointScale } from '../Layout/Layout.Intrinsic';
import { TextCache } from '../Text/Text.Cache';
import { MeasureText } from '../Text/Text.Measure';
import { TextAnimator } from '../Text/Text.Animator';
import { ResolveTextStyle } from '../Text/Text.Types';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE } from '../Jiv/Jiv.InstanceBuffer';
import { TextInstanceBuffer, TEXT_FLOATS_PER_INSTANCE } from '../Text/Text.InstanceBuffer';
import { ClipStackBuffer, EmptyClipStack, type ClipShape, type ClipStack } from './Clip.Stack';
import { type Mat2x3, MAT_IDENTITY, matMul, matApplyX, matApplyY, matScaleX, matScaleY, matCos, matSin } from '../Transform/Mat2x3';
import type { Renderer, GpuTextureHandle, BgPaint } from './Renderer';
// Backend-agnostic — Canvas orchestrates rendering against the `Renderer`
// interface only. Concrete renderers (WebGL2, WebGPU) are built by
// `Renderer.Factory.ts` and handed in. Canvas has no opinion about
// which backend is running underneath it.
import { ImageCache } from '../Image/Image.Cache';
import { BrowserPlatform, type Platform } from './Platform';
import type { MaterialType } from '../Jiv/Jiv.Types';
import { SetPredicateViewport } from '../Jss/Jss.Predicate';

/** True for glass panel materials (LiquidGlass, SolidGlass). Other non-None
 *  materials like ProgressiveBlur are compositing overlays — they don't have
 *  a backdrop sample, border, or specular, and they render in their own pass. */
const _isGlass = (m: MaterialType): boolean => m === 'LiquidGlass';

/** True when a non-glass panel has any non-default backdrop filter set
 *  (BackdropBrightness / Saturation / Contrast ≠ 1, BackdropFrostBlur > 0).
 *  These flat panels need the blur pyramid bound and the scene flushed just
 *  like glass does, so the shader's backdrop sample reflects everything
 *  drawn behind the panel. */
const _hasBackdropFilter = (node: Jiv): boolean => {
  const s = node.RenderStyle;
  return Math.abs(s.BackdropBrightness - 1) > 0.001
    || Math.abs(s.BackdropSaturation - 1) > 0.001
    || Math.abs(s.BackdropContrast - 1) > 0.001
    || s.BackdropFrostBlur > 0.001;
};
import { DirtyFlag } from './Types';
import { Element as JauiElement, type DirtyTracker } from '../Element/Element';
import { Jiv } from '../Jiv/Jiv';
import { ScrollManager } from '../Scroll/Scroll.Manager';
import { PresenceManager } from '../Animation/Presence.Manager';
import { SelectionManager } from '../Selection/Selection.Manager';
import { WebGL2Renderer } from './WebGL2.Renderer';
import { Janvas } from '../Janvas/Janvas';

export class Canvas implements DirtyTracker {
  readonly Element: HTMLCanvasElement;
  readonly Root: Jiv;

  /** Set of leaf nodes that have called `MarkLayoutDirty` since the last
   *  layout pass. Populated via `Notify` from Element side. Used by `_tick`
   *  to scope re-solve to the smallest containing subtree (single dirty
   *  node => walk up to first ancestor with explicit Width+Height; fall
   *  back to root for multi-dirty or unbounded ancestors).
   *
   *  Cleared after every solve. Membership is by-reference; nodes that get
   *  removed from the tree mid-frame are simply ignored on next solve
   *  (their entry is dropped when the set is wiped, no-op until then). */
  private _dirtyNodes: Set<JauiElement> = new Set();

  private _renderer!: Renderer;
  private _platform!: Platform;
  private _width: number = 0;
  private _height: number = 0;
  private _dpr: number = 1;
  private _running: boolean = false;
  private _frameId: number = 0;
  private _lastTime: number = 0;
  private _panelBuffer = new JivInstanceBuffer();
  private _textBuffer = new TextInstanceBuffer();
  private _clipBuffer = new ClipStackBuffer();
  /** JSS `@Name: value` variables in scope. The Angular layer pushes the
   *  active registry's var table in via `SetJssVars`; layout / intrinsic
   *  passes thread it through `ResolveContext.Vars` so `Length.Resolve`
   *  can substitute `@Name` references in authored expressions. Empty
   *  map by default so non-Angular consumers that don't set it still
   *  resolve correctly (missing vars warn + fall back to 0). */
  private _jssVars: Map<string, string> = new Map();
  private _textCache!: TextCache;
  private _imageCache!: ImageCache;

  /** Public image cache — load images/SVGs here, reference them from Jivs. */
  get Images(): ImageCache { return this._imageCache; }
  /** Specular tilt offset — added to lightDir for specular computations only. */
  private _specTiltX: number = 0;
  private _specTiltY: number = 0;
  private _animationManager = new AnimationManager();
  private _animators = new Map<JauiElement, JivAnimator>();
  /** Nodes already warned about non-finite layout results (one warn per node). */
  private _nonFiniteWarned = new WeakSet<JauiElement>();
  private _styleAnimators = new Map<Jiv, JivStyleAnimator>();
  private _textAnimators = new Map<JauiElement, TextAnimator>();
  private _scrollManager!: ScrollManager;
  private _selectionManager!: SelectionManager;
  private _maxFrostBlur: number = 0;

  // ─── Debug HUD ───
  private _dprOverride: number | null = null;
  private _debugHud: HTMLDivElement | null = null;
  private _hudDeltas: Float32Array = new Float32Array(30);
  private _hudIdx: number = 0;
  private _hudCount: number = 0;
  private _hudLastWrite: number = 0;
  /** When true (set by `?wkr-jaui-prof` URL param), capture per-frame phase
   *  timings AND emit a per-second console summary. Decouples the
   *  instrumentation from the DOM HUD — that only mounts in main-thread
   *  Canvas instances; the same engine code runs in the Jaui worker where
   *  there's no DOM, but we still want phase data printed to console for
   *  optimization passes. */
  private _consoleProfilingEnabled: boolean = false;
  private _profLastDumpMs: number = 0;
  private _profSum = { Dirty: 0, Layout: 0, Text: 0, Render: 0, Total: 0 };
  private _profN = 0;

  // TEMP perf-isolation toggles (URL params, off by default — zero cost unless
  // set). Route a blur surface to the plain-panel branch so the worker-fps
  // delta is that surface's full-res blur cost. Remove after diagnosis.
  //   ?no-pblur       skip all progressive-blur surfaces (render flat)
  //   ?no-glass       skip all glass / backdrop-filter surfaces (render flat)
  //   ?no-pblur-draw  build the pblur pyramid but skip the DrawProgressiveBlur
  //                   pass — isolates build cost vs the bicubic draw shader
  private _diagNoPblur: boolean = false;
  private _diagNoGlass: boolean = false;
  private _diagNoPblurDraw: boolean = false;

  // Per-frame phase timings (ms) and GPU-work counts, rolling over the last
  // N frames so the HUD reports a stable average rather than jittery samples.
  // Only populated when the debug HUD is active so release builds pay
  // nothing — `_debugHud` null-check gates all instrumentation writes.
  private _phaseDirty:   Float32Array = new Float32Array(30);
  private _phaseLayout:  Float32Array = new Float32Array(30);
  private _phaseText:    Float32Array = new Float32Array(30);
  private _phaseRender:  Float32Array = new Float32Array(30);
  private _frameIdx:     number = 0;
  private _frameCount:   number = 0;
  private _counts = { Panels: 0, Glass: 0, Text: 0, Image: 0, PBlur: 0 };
  private _countsRolling = { Panels: 0, Glass: 0, Text: 0, Image: 0, PBlur: 0 };
  /** Frame counter for the one-shot per-surface dump (`?wkr-jaui-prof`). Logs
   *  each glass/pblur surface's rect + scissor fill once on a settled frame so
   *  we can see which surface dominates GPU fill. */
  private _surfFrame: number = 0;
  /** Deferred janvas clip-mask draws — populated during the janvas pre-pass,
   *  applied AFTER the panel pass (just before final present). Wiping the
   *  scene FBO immediately after the foreign render destroys data that
   *  in-tree consumers (pblur snapshots, glass blur pyramids) need to read.
   *  Deferring means the visual clip still applies to the presented frame
   *  while pblur/glass see the unclipped scene during their samples. */
  private _pendingJanvasMasks: Array<{
    drawX: number; drawY: number; drawW: number; drawH: number;
    clipX: number; clipY: number; clipW: number; clipH: number;
    radius: number; smoothness: number;
  }> = [];
  /** Rolling window of per-frame GPU ms from `Renderer.GetFrameGpuMs`. The
   *  reading is null when the backend doesn't support timer queries or no
   *  query has resolved yet. We skip nulls when averaging. */
  private _phaseGpu: Float32Array = new Float32Array(30);
  private _phaseGpuCount: number = 0;

  /** Canvas takes a pre-initialized renderer. No backend selection happens
   *  here — callers build a renderer via `Renderer.Factory` (or their own
   *  path) and hand it in. Keeps this class free of concrete-backend
   *  imports so new backends can land without touching Canvas. */
  constructor(canvas: HTMLCanvasElement, renderer: Renderer, platform: Platform = BrowserPlatform) {
    this.Element = canvas;
    this.Root = new Jiv();
    this.Root.Tracker = this;
    this._renderer = renderer;
    this._platform = platform;

    // touch-action:none on the canvas tells the browser "don't intercept
    // drags as scroll/zoom" — without it, pointermove during a touch
    // drag never reaches our handlers (Chrome Android browser-default
    // is `auto`). Only valid on HTMLCanvasElement; OffscreenCanvas has
    // no `.style`. In worker mode the proxy element on main owns the
    // listeners and sets this itself.
    if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
      canvas.style.touchAction = 'none';
    }
    this._initDebugFromUrl();

    this._textCache = new TextCache(renderer);
    this._imageCache = new ImageCache(renderer);
    this._imageCache.OnLoad = () => {
      // Walk tree and set IntrinsicWidth/Height on nodes whose Background
      // is an Image kind referencing a now-loaded cache entry. This must
      // happen BEFORE layout so the solver sees the intrinsics on the
      // next tick.
      const setIntrinsics = (node: JauiElement): void => {
        if (node instanceof Jiv && node.IntrinsicWidth === null) {
          const bg = node.RenderStyle.Background;
          if (bg.Kind === 'Image') {
            const entry = this._imageCache.Get(bg.Url);
            if (entry && entry.Ready) {
              const d = Math.max(1, this._dpr);
              node.IntrinsicWidth = entry.Width / d;
              node.IntrinsicHeight = entry.Height / d;
              node.MarkLayoutDirty();
            }
          }
        }
        for (const child of node.Children) setIntrinsics(child);
      };
      setIntrinsics(this.Root);
    };

    // Image-lifecycle → framework state plumbing.
    //
    // Three states flip on every Jiv whose Background is an Image kind
    // referencing the URL:
    //   - 'Loading' — fetch+decode has started (or is queued behind the
    //     concurrency cap; the cache only fires this when the fetch is
    //     actually in-flight, so styled placeholders stay clean for
    //     queued items).
    //   - 'Loaded'  — texture bound and Ready; Loading flips off, Loaded
    //     flips on. Author transitions like `@Transition Opacity` fire
    //     against this transition automatically.
    //   - 'Failed'  — fetch threw or HTTP non-2xx. Loading flips off.
    //
    // Same tree walk as setIntrinsics — a single pass per cache event.
    // Cheap enough for the kind of bursts a viewport scroll triggers.
    const _walkForUrl = (url: string, fn: (j: Jiv) => void): void => {
      const visit = (node: JauiElement): void => {
        if (node instanceof Jiv) {
          const bg = node.RenderStyle.Background;
          if (bg.Kind === 'Image' && bg.Url === url) fn(node);
        }
        for (const child of node.Children) visit(child);
      };
      visit(this.Root);
    };
    this._imageCache.OnLoadStart = (url) => _walkForUrl(url, (j) => {
      j.SetState('Loading', true);
      j.SetState('Loaded', false);
      j.SetState('Failed', false);
    });
    this._imageCache.OnLoadFinish = (url) => _walkForUrl(url, (j) => {
      j.SetState('Loading', false);
      j.SetState('Loaded', true);
    });
    this._imageCache.OnLoadFail = (url) => _walkForUrl(url, (j) => {
      j.SetState('Loading', false);
      j.SetState('Failed', true);
    });

    this._animationManager.OnFrame(() => this.RequestFrame());
    this._scrollManager = new ScrollManager(this.Root);
    this._animationManager.Register(this._scrollManager);
    this._animationManager.Register(new PresenceManager(this.Root));
    // Kick once so the very first newly-added Jiv (Presence 0 → 1) starts
    // animating even if nothing else is active. After this, the animation
    // loop self-sustains while any spring is unsettled.
    this._animationManager.Kick();
    this._selectionManager = new SelectionManager(Jiv, (jiv) => this._textAnimators.get(jiv), this._animationManager);
    this._selectionManager.OnSelectionTextChanged((text) => this._selectionTextRelay?.(text));

    // Defer the first _resize() to a rAF tick so layout is already settled
    // when clientWidth runs as a fallback. Direct construction-time reads
    // forced ~56ms of synchronous layout flush on cold load (flagged by
    // Chrome's ForcedReflow analyzer). The ResizeObserver below also pushes
    // contentRect into _pendingResize, so most boots will pick up the
    // measured size from RO instead of falling through to clientWidth.
    this._observeResize();
    requestAnimationFrame(() => this._resize());
    this._watchDpr();
    this._listenForScroll();
    this._listenForInteractionStates();
    this._listenForTextSelection();
    this._listenForSelectionKeys();
    this._listenForFontLoad();
    void this._listenForSpecularTilt;

    // Main-thread mode: bind real DOM listeners on the canvas that
    // translate to `IngestEvent` calls. The engine's `_listenForX`
    // methods register internal handlers via `_on(...)` — without this
    // bridge, those internal handlers never fire because the DOM events
    // have nowhere to land. In worker mode (canvas is OffscreenCanvas),
    // the main-thread MainBridge owns this responsibility on the proxy
    // canvas element instead — skip the bind here.
    if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
      this._bindMainThreadDomEvents(canvas);
    }
  }

  /** Bridge real DOM events on the canvas to `IngestEvent`. Used in
   *  main-thread mode (no worker). Mirrors what `MainBridge._wireDomEvents`
   *  does on the proxy canvas in worker mode — translate clientX/Y to
   *  canvas-local CSS pixels, forward as a synth event payload, and
   *  `preventDefault()` on touchstart/wheel synchronously so the browser
   *  doesn't intercept gestures as scroll/zoom. */
  private _bindMainThreadDomEvents = (el: HTMLCanvasElement): void => {
    const dispatch = (kind: string, e: PointerEvent | WheelEvent | MouseEvent | TouchEvent | KeyboardEvent | Event): void => {
      this.IngestEvent(kind, e);
    };
    el.addEventListener('pointermove', (e) => dispatch('pointermove', e));
    el.addEventListener('pointerdown', (e) => dispatch('pointerdown', e));
    el.addEventListener('pointerup', (e) => dispatch('pointerup', e));
    el.addEventListener('pointercancel', (e) => dispatch('pointercancel', e));
    el.addEventListener('pointerleave', (e) => dispatch('pointerleave', e));
    el.addEventListener('pointerenter', (e) => dispatch('pointerenter', e));
    el.addEventListener('contextmenu', (e) => dispatch('contextmenu', e));
    // touchstart needs preventDefault on Chrome Android to suppress the
    // long-press magnifier / native text selection. `{passive:false}` so
    // the browser honors the call.
    el.addEventListener('touchstart', (e) => { e.preventDefault(); dispatch('touchstart', e); }, { passive: false });
    // wheel needs preventDefault synchronously; the engine handler can't
    // do it asynchronously. Browser zoom (Ctrl + wheel, plus Chrome's
    // synthetic pinch-zoom-as-wheel+ctrlKey) is a browser-owned gesture —
    // bail before preventDefault so the page can zoom.
    el.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      dispatch('wheel', e);
    }, { passive: false });

    // Native clipboard for display-text selection (main-thread mode). The
    // worker-mode equivalent lives in Bridge.Main — there the snapshot is
    // mirrored across postMessage because user-gesture activation doesn't
    // ride the bridge. Here we read the selection synchronously off the
    // engine. Bail when a real DOM text input is focused so plain `<input>`
    // / Jinput-style hidden textareas keep their native copy behavior.
    const onClipboardCopy = (e: ClipboardEvent): void => {
      if (typeof document !== 'undefined') {
        const ae = document.activeElement as HTMLElement | null;
        if (ae) {
          const tag = ae.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          if (ae.isContentEditable) return;
        }
      }
      const text = this._selectionManager.GetSelectedText(this.Root);
      if (!text) return;
      e.clipboardData?.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', onClipboardCopy, { capture: true });
    document.addEventListener('cut', onClipboardCopy, { capture: true });
  };

  /** The internal AnimationManager — exposed for external use (e.g. manual animators). */
  get Animations(): AnimationManager { return this._animationManager; }

  /** Post-frame hook list — invoked at the end of every render tick.
   *  Used by the worker's JivRegistry to broadcast rect snapshots once
   *  per frame to subscribed nodes. */
  private _postFrameSubs: (() => void)[] = [];
  RegisterPostFrame = (cb: () => void): (() => void) => {
    this._postFrameSubs.push(cb);
    return () => {
      const i = this._postFrameSubs.indexOf(cb);
      if (i >= 0) this._postFrameSubs.splice(i, 1);
    };
  };
  /** Internal — fired by the render loop after a frame's paint completes. */
  private _firePostFrame = (): void => {
    for (let i = 0; i < this._postFrameSubs.length; i++) {
      try { this._postFrameSubs[i](); } catch (e) { console.error('[Jaui] post-frame sub threw', e); }
    }
  };

  /** Replace the active JSS var table. The Angular layer calls this when
   *  the nearest `JssRegistry` picks up new declarations (e.g. a `<jyle>`
   *  hot-edit). Layout + intrinsic passes read the fresh table on the
   *  next tick; we mark the tree dirty here so stale resolved values get
   *  recomputed even if no other state changed.
   *
   *  Accepts a plain Record<string, string> for convenience from non-Map
   *  callers; internally stored as a Map. */
  SetJssVars = (vars: Map<string, string> | Record<string, string>): void => {
    this._jssVars = vars instanceof Map
      ? new Map(vars)
      : new Map(Object.entries(vars));
    this.Root.MarkLayoutDirty();
    this._animationManager.Kick();
  };

  Start = (): void => {
    if (this._running) return;
    this._running = true;
    this._lastTime = 0;
    // Start rendering immediately — don't block on web fonts. The browser
    // does the same thing with `font-display: swap`: render with fallback
    // metrics, re-measure when the real font lands. `_listenForFontLoad`
    // fires `_invalidateAllText()` on every `FontFaceSet.loadingdone`, so
    // late-registered @font-face rules (Google Fonts batches) get picked
    // up automatically. First paint is instant; text reflows once as fonts
    // settle, animated by the existing wrap cross-fade.
    this._frameId = requestAnimationFrame(this._tick);
  };

  Stop = (): void => {
    this._running = false;
    if (this._frameId) {
      cancelAnimationFrame(this._frameId);
      this._frameId = 0;
    }
  };

  get Width(): number { return this._width; }
  get Height(): number { return this._height; }

  // ─── Event ingestion (worker mode) ──────────────────────────────────────
  // The engine no longer binds DOM listeners on its canvas — `this.Element`
  // is an OffscreenCanvas and isn't an EventTarget for pointer/wheel/key
  // events anyway. Instead, the main-thread bridge captures real DOM events
  // on a sibling proxy element (the `<canvas>` Angular mounted) and forwards
  // them via postMessage. The bridge calls `IngestEvent(kind, e)` for each;
  // we dispatch to handlers registered through `_on`.
  //
  // Synth event payload contract:
  //   • clientX / clientY are CANVAS-LOCAL CSS pixels (already translated by
  //     the bridge), so `clientX - getBoundingClientRect().left` still
  //     produces the right number — the rect we serve is anchored at (0,0).
  //   • All other fields (pointerId, pointerType, button, modifiers, delta*,
  //     getCoalescedEvents) match the corresponding DOM event.
  //   • preventDefault / stopPropagation are no-ops; main has already
  //     decided whether to preventDefault on touchstart/wheel.

  /** Map of event kind → handler list. Engine internals register here via
   *  `_on()`; bridge-driven `IngestEvent` dispatches to all listeners.
   *
   *  Handler param type is `any` (not `unknown`) because the original
   *  per-element listeners were strongly typed (e.g. `(e: PointerEvent)`)
   *  and TS's contravariance rule forbids assigning those to
   *  `(e: unknown) => void`. Engine handlers know the shape they expect;
   *  the bridge guarantees the synth payload supplies those fields. */
  private _eventListeners = new Map<string, ((e: any) => void)[]>();

  /** Bridge callbacks. Set by the worker entry once Canvas is constructed. */
  private _cursorRelay: ((cursor: string) => void) | null = null;
  private _captureRelay: ((action: 'set' | 'release', pointerId: number) => void) | null = null;
  private _selectionTextRelay: ((text: string) => void) | null = null;

  /** Pointers we hold capture for. Mirrors what the proxy element on main
   *  has setPointerCapture'd, so `_hasCapture` answers synchronously. */
  private _capturedPointers = new Set<number>();

  /** Bridge installs these once. Worker entry → Canvas wires them up. */
  OnCursorChange = (cb: ((cursor: string) => void) | null): void => { this._cursorRelay = cb; };
  OnPointerCaptureRequest = (cb: ((action: 'set' | 'release', pointerId: number) => void) | null): void => {
    this._captureRelay = cb;
  };
  /** Bridge subscriber for plaintext-only selection mirrors. Main caches
   *  the latest string so the native `copy` event can synthesize
   *  `clipboardData` synchronously while the user gesture is still active —
   *  `navigator.clipboard.writeText` from inside the worker silently fails
   *  because transient activation doesn't survive postMessage. */
  OnSelectionTextChange = (cb: ((text: string) => void) | null): void => {
    this._selectionTextRelay = cb;
  };

  /** Bridge inbound: dispatch a normalized event to engine handlers.
   *  Unknown kinds are silently dropped (the bridge may forward kinds the
   *  engine doesn't currently listen for, e.g. pointerenter). */
  IngestEvent = (kind: string, e: unknown): void => {
    const list = this._eventListeners.get(kind);
    if (!list) return;
    // Iterate a snapshot so a handler that adds/removes during dispatch
    // doesn't shift indices on us.
    const snapshot = list.slice();
    for (const h of snapshot) {
      try { h(e as never); } catch (err) { console.error(`[Jaui] handler for "${kind}" threw`, err); }
    }
  };

  /** Bridge inbound: pointer-capture was actually granted on main. Track
   *  the id so subsequent `_hasCapture(id)` checks are correct. */
  IngestPointerCaptureGranted = (pointerId: number): void => { this._capturedPointers.add(pointerId); };
  IngestPointerCaptureReleased = (pointerId: number): void => { this._capturedPointers.delete(pointerId); };

  /** Bridge inbound: ResizeObserver delivered a new contentRect on main.
   *  Re-uses the same `_pendingResize` slot the original (now-removed)
   *  in-engine ResizeObserver filled, so the existing _resize() pipeline
   *  picks it up on its next tick. */
  ResizeFromBridge = (cssWidth: number, cssHeight: number): void => {
    this._pendingResize = { width: cssWidth, height: cssHeight };
    requestAnimationFrame(() => this._resize());
  };

  /** Walk the tree re-materializing each Jiv's `@If` layout overrides for the
   *  current viewport. A cheap no-op for every node without layout-bearing
   *  predicates; called from `_resize` before the solve. */
  private _recomputeResponsiveLayout = (node: JauiElement): void => {
    (node as Jiv).RecomputeResponsiveLayout?.();
    const kids = node.Children;
    for (let i = 0; i < kids.length; i++) this._recomputeResponsiveLayout(kids[i]);
  };

  /** Internal — register an engine handler for `kind`. Returns disposer.
   *  `_options` is accepted (and ignored) for source-compatibility with
   *  the prior `addEventListener(kind, h, { passive: false })` calls;
   *  passive/capture flags only matter at the DOM-listener layer, which
   *  lives on main now. */
  private _on = (kind: string, handler: (e: any) => void, _options?: AddEventListenerOptions | boolean): (() => void) => {
    let list = this._eventListeners.get(kind);
    if (!list) { list = []; this._eventListeners.set(kind, list); }
    list.push(handler);
    return () => {
      const cur = this._eventListeners.get(kind);
      if (!cur) return;
      const i = cur.indexOf(handler);
      if (i >= 0) cur.splice(i, 1);
    };
  };

  /** Internal — substitute for `Element.getBoundingClientRect()`.
   *
   *  Main-thread mode (canvas is HTMLCanvasElement): defer to the real
   *  `getBoundingClientRect()` so engine handlers translating
   *  `clientX - rect.left` produce correct canvas-local coords.
   *
   *  Worker mode (canvas is OffscreenCanvas): there is no bounding
   *  rect — the bridge has already pre-translated `clientX/Y` to
   *  canvas-local CSS pixels before posting, so we return a (0, 0)-
   *  anchored rect. The same `clientX - rect.left` math then
   *  collapses to `clientX - 0 = clientX` (already canvas-local). */
  private _pageRect = (): { left: number; top: number; width: number; height: number; right: number; bottom: number; x: number; y: number } => {
    const el = this.Element as unknown as { getBoundingClientRect?: () => DOMRect };
    if (typeof el.getBoundingClientRect === 'function') {
      return el.getBoundingClientRect();
    }
    return {
      left: 0, top: 0,
      width: this._width, height: this._height,
      right: this._width, bottom: this._height,
      x: 0, y: 0,
    };
  };

  /** Internal — substitute for `Element.setPointerCapture(id)`.
   *  Main-thread mode: call the real DOM API so the browser keeps
   *  routing pointermove to us even when the finger drifts off the
   *  canvas (essential for drag/scroll). Worker mode: forward via the
   *  bridge's relay; main calls the real API on the proxy element. */
  private _capturePointer = (pointerId: number): void => {
    this._capturedPointers.add(pointerId);
    if (this._captureRelay) {
      this._captureRelay('set', pointerId);
      return;
    }
    const el = this.Element as unknown as { setPointerCapture?: (id: number) => void };
    try { el.setPointerCapture?.(pointerId); } catch { /* pointer not active */ }
  };

  private _releasePointer = (pointerId: number): void => {
    this._capturedPointers.delete(pointerId);
    if (this._captureRelay) {
      this._captureRelay('release', pointerId);
      return;
    }
    const el = this.Element as unknown as {
      hasPointerCapture?: (id: number) => boolean;
      releasePointerCapture?: (id: number) => void;
    };
    try {
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture?.(pointerId);
    } catch { /* idempotent */ }
  };

  private _hasCapture = (pointerId: number): boolean => this._capturedPointers.has(pointerId);

  /** Internal — substitute for `Element.style.cursor = X`. Worker mode
   *  relays to main; main-thread mode writes directly. */
  private _setCursor = (cursor: string): void => {
    if (this._cursorRelay) { this._cursorRelay(cursor); return; }
    const el = this.Element as unknown as { style?: CSSStyleDeclaration };
    if (el.style) el.style.cursor = cursor;
  };


  /** Viewport passed to layout passes for Length resolution — `vw`/`vh`
   *  resolve against these dims, and `%` on root-level placed children
   *  falls back here when there's no parent rect. */
  private _viewport = (): { Width: number; Height: number } => ({
    Width: this._width,
    Height: this._height,
  });
  get Dpr(): number { return this._dpr; }

  /** Request a re-render. When the loop is running, _tick already renders
   *  every frame — no extra render needed. */
  RequestFrame = (): void => {
  };

  private _tickErrorCount = 0;
  private _tick = (time: number): void => {
    if (!this._running) return;
    this._frameId = requestAnimationFrame(this._tick);
    try {
      this._tickInner(time);
    } catch (err) {
      // One bad frame shouldn't take down the engine. Log the first few
      // occurrences (so we see the bug) and then go quiet to keep the
      // console / postMessage channel from melting under millions of
      // identical errors per second.
      if (this._tickErrorCount < 3) {
        console.error('[Jaui] tick threw', err);
      } else if (this._tickErrorCount === 3) {
        console.error('[Jaui] tick still throwing — suppressing further duplicates');
      }
      this._tickErrorCount++;
    }
  };

  private _tickInner = (time: number): void => {
    // Boot-time zero-size gate. Until the worker bridge has delivered a
    // real resize (ResizeFromBridge → _pendingResize → _resize sets
    // _width/_height), the OffscreenCanvas backing store is 0×0 and any
    // GL op that touches the default framebuffer fails with
    // GL_INVALID_FRAMEBUFFER_OPERATION (error 1286). That used to spam
    // the console for ~30ms during boot, with both glClear/glBlit AND
    // texSubImage2D (whose upload path implicitly checks the current
    // framebuffer's completeness). Skip the entire frame at zero size —
    // the next rAF after the first resize delivery picks up cleanly.
    if (this._width === 0 || this._height === 0) return;

    // Feed the HUD BEFORE we overwrite _lastTime — the HUD uses it to derive
    // the rAF-to-rAF delta (which, on iOS, includes time the main thread spent
    // blocked — a better signal than render-only dt for "is the browser
    // actually waking us at 60Hz?").
    this._updateHud(time);

    const dt = this._lastTime === 0 ? 0.016 : Math.min((time - this._lastTime) / 1000, 0.033);
    this._lastTime = time;

    // Advance all springs SYNCHRONOUSLY, in THIS frame, before the render walk
    // below reads their values. JivStyleAnimator springs (Transform.Rotation,
    // Opacity, Visual*, …) used to advance in the AnimationManager's OWN rAF
    // callback — a separate frame from this render — so the render read a
    // one-frame-stale value (the rotating-panel blur lagging its edge). Stepping
    // here couples spring-write → render-read in one frame. The manager's loop
    // is now schedule-only; this does NOT change any rAF kick or the boot path.
    this._animationManager.StepFrame(dt);

    // Phase timing — active when the debug HUD is on OR `?wkr-jaui-prof` was
    // set. Gate reads at each boundary rather than branching inside hot loops;
    // performance.now() is cheap but we skip it entirely in release.
    const hud = this._debugHud !== null || this._consoleProfilingEnabled;
    let t0 = 0, tDirtyEnd = 0, tLayoutEnd = 0, tTextEnd = 0;
    if (hud) t0 = performance.now();

    // Single O(1) root-flag check. `MarkLayoutDirty` bubbles the Layout
    // flag from any descendant to the root, so root.Dirty & Layout answers
    // "any node in the tree dirty?" without walking. Text-only mutations
    // also call MarkLayoutDirty (text changes always invalidate intrinsic
    // sizing), so a separate Text walk is no longer needed.
    const layoutDirty = (this.Root.Dirty & (DirtyFlag.Layout | DirtyFlag.Text)) !== 0;
    if (hud) tDirtyEnd = performance.now();
    if (layoutDirty) {
      // Choose the smallest containing subtree we can re-solve in isolation.
      // Returns Root for multi-dirty / unbounded-ancestor cases, equivalent
      // to today's behavior. Returns a deeper element when the dirty change
      // is contained inside a fixed-box ancestor — saves an O(N) full-tree
      // pass on common cases (drawer resize, single-card hover, scrubber).
      const scopedRoot = this._chooseScopedRoot();
      // Cascade PointScale first so _measureDirtyText can resolve FontSize
      // against each Jiv's ResolveCtx before layout sizes are known. The
      // tree is all-Jivs (Root is a Jiv, AddChild only mounts Jivs), so the
      // Element-typed path back from Parent walks safely casts to Jiv at
      // these consumers.
      CascadePointScale(scopedRoot, this._viewport(), this._jssVars);
      this._measureDirtyText(scopedRoot as Jiv);
      ComputeIntrinsicSizes(scopedRoot, this._viewport(), this._jssVars);
      this._solveAndAnimate(scopedRoot);
      this._clearDirty(scopedRoot as Jiv);
      // The Layout flag was bubbled to the root by MarkLayoutDirty so the
      // O(1) gate above could see it. After a scoped solve, the bubble path
      // (subtree-root.Parent → ... → Root) still holds Layout flags it
      // didn't deserve — clear them so next frame's gate is honest. Walks
      // O(depth), bounded shallow.
      if (scopedRoot !== this.Root) {
        let p = scopedRoot.Parent;
        while (p) { p.Dirty &= ~DirtyFlag.Layout; p = p.Parent; }
      }
      this._dirtyNodes.clear();
    }
    if (hud) tLayoutEnd = performance.now();

    // Wrap-change detection only runs when something could have moved a wrap
    // threshold this frame: a fresh layout solve (widths just updated) or any
    // active animator (spring-animated width can cross wrap thresholds
    // continuously). On steady-idle frames neither holds, so the full-tree
    // walk is skipped entirely. AnimationManager.IsRunning covers springs,
    // ScrollManager easings, and PresenceManager — all registered with it.
    if (layoutDirty || this._animationManager.IsRunning) {
      this._processTextTransitions(this.Root);
    }
    if (hud) tTextEnd = performance.now();

    // Reset per-frame counters; _render increments them as it walks.
    if (hud) {
      this._counts.Panels = 0;
      this._counts.Glass = 0;
      this._counts.Text = 0;
      this._counts.Image = 0;
      this._counts.PBlur = 0;
    }

    this._render(dt);
    this._firePostFrame();

    // Debug layout overlay — rainbow 1px outlines on every Jiv. Enabled by
    // `?debug-layout`; no cost when disabled.
    if (this._debugLayout) this._drawDebugLayout();

    if (hud) {
      const tEnd = performance.now();
      const i = this._frameIdx;
      const phaseDirty  = tDirtyEnd  - t0;
      const phaseLayout = tLayoutEnd - tDirtyEnd;
      const phaseText   = tTextEnd   - tLayoutEnd;
      const phaseRender = tEnd       - tTextEnd;
      this._phaseDirty[i]  = phaseDirty;
      this._phaseLayout[i] = phaseLayout;
      this._phaseText[i]   = phaseText;
      this._phaseRender[i] = phaseRender;
      this._countsRolling.Panels = this._counts.Panels;
      this._countsRolling.Glass  = this._counts.Glass;
      this._countsRolling.Text   = this._counts.Text;
      this._countsRolling.Image  = this._counts.Image;
      this._countsRolling.PBlur  = this._counts.PBlur;
      // Poll whatever GPU timer result is now available. The reading lags
      // 2-3 frames behind what we just submitted — writing it into the same
      // rolling window is still useful because we're averaging, not trying
      // to align one frame's CPU and GPU numbers.
      const gpuMs = this._renderer.GetFrameGpuMs();
      if (gpuMs !== null) {
        this._phaseGpu[this._phaseGpuCount % this._phaseGpu.length] = gpuMs;
        this._phaseGpuCount++;
      }
      this._frameIdx = (i + 1) % this._phaseDirty.length;
      if (this._frameCount < this._phaseDirty.length) this._frameCount++;
      if (this._consoleProfilingEnabled) this._surfFrame++;

      // Per-second console summary — only when `?wkr-jaui-prof` is set.
      // Independent of HUD rendering so it works in the worker (no DOM).
      if (this._consoleProfilingEnabled) {
        this._profSum.Dirty  += phaseDirty;
        this._profSum.Layout += phaseLayout;
        this._profSum.Text   += phaseText;
        this._profSum.Render += phaseRender;
        this._profSum.Total  += tEnd - t0;
        this._profN++;
        if (this._profLastDumpMs === 0) this._profLastDumpMs = tEnd;
        if (tEnd - this._profLastDumpMs >= 1000 && this._profN > 0) {
          const n = this._profN;
          const avg = (v: number) => (v / n).toFixed(1);
          // Average the resolved GPU-timer samples in the rolling ring. The
          // reading lags 2-3 frames behind submission, so we average rather
          // than align; nulls were already skipped on write. `gpu n/a` when
          // no query has resolved (Safari / ANGLE without timer queries).
          const gpuFilled = Math.min(this._phaseGpuCount, this._phaseGpu.length);
          let gpuSum = 0;
          for (let g = 0; g < gpuFilled; g++) gpuSum += this._phaseGpu[g];
          const gpuStr = gpuFilled > 0 ? `${(gpuSum / gpuFilled).toFixed(2)}ms` : 'n/a';
          // eslint-disable-next-line no-console
          console.log(
            `[Jaui] ${n}f over ${(tEnd - this._profLastDumpMs).toFixed(0)}ms — avg total ${avg(this._profSum.Total)}ms;` +
            ` Dirty ${avg(this._profSum.Dirty)} Layout ${avg(this._profSum.Layout)}` +
            ` Text ${avg(this._profSum.Text)} Render ${avg(this._profSum.Render)} | gpu ${gpuStr}` +
            ` | P${this._counts.Panels} G${this._counts.Glass} T${this._counts.Text} I${this._counts.Image} Pb${this._counts.PBlur}`
          );
          this._profSum.Dirty = this._profSum.Layout = this._profSum.Text = 0;
          this._profSum.Render = this._profSum.Total = 0;
          this._profN = 0;
          this._profLastDumpMs = tEnd;
        }
      }
    }
  };

  private _render = (_dt: number): void => {
    const r = this._renderer;
    const w = Math.round(this._width * this._dpr);
    const h = Math.round(this._height * this._dpr);

    // Cascade opacity: multiply each Jiv's RenderStyle.Opacity by its
    // ancestors' so children inherit parent dimming (CSS-like). The style
    // animator rewrites Opacity each frame from its spring, so this
    // multiplied value only lives for the current render pass.
    this._cascadeOpacity(this.Root, 1);

    // Cascade the foreground filter grade (CSS `filter` on a subtree).
    // brightness/saturation/contrast are pointwise, so folding the parent's
    // grade into each descendant is identical to grading the composited
    // subtree as a group — but free (no offscreen pass). `Isolate` starts a
    // fresh grade for the subtree.
    this._cascadeFilterGrade(this.Root, 1, 1, 1);

    r.Resize(w, h, this._dpr);
    r.BeginFrame();
    this._textCache.BeginFrame();

    // Render the scene into the off-screen `_sceneFbo` instead of drawing
    // directly to the swap chain. This lets glass/pblur surfaces sample
    // the scene texture as their backdrop with zero per-surface blits —
    // the FBO IS the "snapshot" at all times, always current.
    //
    // End-of-frame, we do a single Blit of the scene FBO into the default
    // framebuffer (see the block after the tree walk). Total full-canvas
    // blits per frame: 1 (final present), down from 1+N (one per
    // glass/pblur that used to call SnapshotScreen).
    r.DisableBlend();
    r.BeginScenePass(0, 0, 0);

    // ── Janvas pre-pass ──
    // Foreign WebGL2 renderers (a THREE.js scene, a custom shader app, etc.)
    // attached to <janvas> elements draw into the just-bound scene FBO at
    // their layout rect. Subsequent panels render over the top; glass
    // surfaces sample the result as their backdrop. Only WebGL2 backends
    // expose a raw GL handle — on WebGPU this loop is a no-op.
    if (this._renderer instanceof WebGL2Renderer) {
      const gl = this._renderer.GetGL();
      if (gl) {
        this._pendingJanvasMasks.length = 0;
        this._renderJanvases(gl, this.Root, 0, 0, w, h, _dt, null);
        // Restore the state Jaui's panel pass expects after the foreign
        // renderer ran. Jaui's draws assume: scene FBO bound, canvas-sized
        // viewport, no scissor, no depth/cull/stencil, no bound program /
        // VAO / array buffers, texture unit 0 active. THREE in particular
        // leaves all of these in arbitrary states. ALSO drop our own state
        // cache (`_lastProgram` etc.) so the next Jaui draw doesn't trust
        // stale caches against THREE's bindings.
        // Full reset of every GL state THREE may have touched. THREE
        // mutates 30+ pieces of state during a render and Jaui's draws
        // assume specific defaults; partial reset = subtle bugs (inverted
        // text from leftover blend equation, missing text from leftover
        // depth/colour mask, etc.).
        //
        // NOTE: a previous attempt trimmed the texture-unit unbind loop
        // and the null program/VAO/buffer binds. CPU-submit time dropped
        // by ~120ms/frame on software ANGLE, but wall-time *rose* by
        // ~200ms/frame — the rasterizer was apparently doing extra work
        // when we left bindings in their post-THREE state. Keep the
        // full reset.
        this._renderer.RebindSceneTarget();
        gl.viewport(0, 0, w, h);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        gl.disable(gl.RASTERIZER_DISCARD);
        gl.depthMask(true);
        gl.colorMask(true, true, true, true);
        gl.stencilMask(0xFF);
        gl.frontFace(gl.CCW);
        gl.cullFace(gl.BACK);
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.blendColor(0, 0, 0, 0);
        gl.useProgram(null);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        for (let unit = 0; unit < 8; unit++) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
          gl.bindTexture(gl.TEXTURE_3D, null);
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
        this._renderer.InvalidateStateCache();
      }
    }

    // Track whether we've built a blur for the current snapshot
    let lastBackdrop: GpuTextureHandle | null = null;
    let lastBaseFrostLod: number = 0;
    // NOTE: no more `backdropDirty` cache flag. The video-backdrop app
    // contract means the scene is different every frame; caching snapshots
    // across surfaces was already unsafe. Each glass/pblur now scissors
    // its own blur pass to just its sample region, so recomputing per
    // surface is cheap. If a future optimization needs to skip recompute
    // (e.g. fullscreen chrome pblurs with matching radius), add a local
    // cache scoped to the scissor rect + radius rather than a global flag.
    //
    // Within-frame pyramid sharing was attempted (track dirty rect, reuse
    // pyramid when next surface's read region doesn't overlap) but
    // regressed perf 2× on a software-rasterized device:
    //   - Most blur surfaces' read regions overlap the accumulating
    //     dirty rect (full-width pblurs + page text), so reuse rarely fires.
    //   - Each ComputeBlur is scissored to its OWN read region — a cached
    //     pyramid is only valid inside that scissor; reuse for a different
    //     scissor reads stale pixels.
    // To revisit this: build pyramids un-scissored (fills full canvas
    // every time, costlier per build) or with the union scissor of all
    // consumers (requires upfront scan of pblur/glass surfaces). Both
    // change the calculus and need their own measurement pass.

    // Pending non-glass panel batch. The tree walk pushes every non-glass
    // panel into `_panelBuffer` instead of drawing it immediately; when we
    // hit something that would violate z-order (glass, pblur, image, text,
    // or the end of the walk), we flush the whole buffer as ONE instanced
    // draw call.
    //
    // Why this is safe: all non-glass panels share the same shader program,
    // uniforms, vertex array, and backdrop (null). They differ only in
    // per-instance data (rect, color, shadow, clip offset), which is
    // already passed per-instance via the instance buffer. Transparent,
    // solid, or partial-alpha backgrounds all composite correctly because
    // the blend state is constant within the batch and instances draw in
    // tree order (preserved by push order).
    //
    // Win: on Home the 30-100 separate panel draw calls collapse to ~3-5
    // per frame (one batch per segment between glass/image/text boundaries).
    // Major CPU-submit savings on mobile / iPad.
    const flushPanels = (): void => {
      if (this._panelBuffer.Count === 0) return;
      r.EnableBlend();
      r.PanelBeginBatch();
      r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
      r.PanelAddInstance(this._panelBuffer.Data, 0, this._panelBuffer.Count * JIV_FLOATS_PER_INSTANCE);
      r.PanelDrawBatch(w, h, null, 0, this._specTiltX, this._specTiltY);
      this._counts.Panels += this._panelBuffer.Count;
      this._panelBuffer.Begin(); // reset count for the next batch
    };

    // Pending text batch — same pattern as flushPanels. Text is emitted
    // per-node via `_emitTextFor`, which pushes glyph instances into
    // `_textBuffer`. Previously each node with text did its own draw call.
    // Now we accumulate across sibling text nodes and drain together when
    // we hit a category boundary (panel push, glass/pblur, image, or end
    // of the walk).
    //
    // Z-order: panel and text buffers are mutually-exclusive in the sense
    // that adding to one forces a flush of the other — so at any instant
    // only ONE of them holds pending work, and flushing drains in tree
    // order.
    const flushText = (): void => {
      if (this._textBuffer.Count === 0) return;
      const atlas = this._textCache.Atlas;
      if (!atlas) { this._textBuffer.Begin(); return; }
      r.TextBeginBatch();
      r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
      r.TextAddInstance(this._textBuffer.Data, 0, this._textBuffer.Count * TEXT_FLOATS_PER_INSTANCE);
      r.TextDrawBatch(w, h, atlas);
      this._counts.Text += 1; // one flushed batch = one draw call
      this._textBuffer.Begin();
    };

    // Order children by Layer (stable — tree order breaks ties). Fast-path
    // when every child has Layer 0 (the common case): return the original
    // array so we don't allocate or sort. Sort is only triggered when an
    // author actually used Layer.
    const orderedChildren = (node: Jiv): Jiv[] => {
      const children = node.Children as Jiv[];
      let needsSort = false;
      for (let i = 0; i < children.length; i++) {
        if (children[i].RenderStyle.Layer !== 0) { needsSort = true; break; }
      }
      if (!needsSort) return children;
      return [...children].sort((a, b) => a.RenderStyle.Layer - b.RenderStyle.Layer);
    };

    // ── Teleport elevation ──
    // A subtree mid-teleport (Element.TeleportSeq != 0 — live-reparented, rect
    // springs still flying) is DEFERRED: painted after everything else inside
    // its nearest LAYERED ancestor's scope (most recent teleport last = topmost),
    // with the clip stack captured ABOVE that ancestor — so a card flying home
    // into a scrolled rail paints over its cousins and is not clipped by the
    // scroll container it is returning into, while still staying under
    // higher-Layer chrome (the scope replays before the next layered sibling
    // paints). Zero-cost when nothing is in flight (one int check per child).
    interface TeleportScope { Deferred: { N: Jiv; M: Mat2x3 }[]; Stack: ClipStack }

    const replayScope = (scope: TeleportScope): void => {
      while (scope.Deferred.length > 0) {
        const items = scope.Deferred.sort((a, b) => a.N.TeleportSeq - b.N.TeleportSeq);
        scope.Deferred = [];
        for (const d of items) renderNode(d.N, d.M, scope.Stack, scope);
      }
    };

    const descendChildren = (node: Jiv, eff: Mat2x3, stack: ClipStack, scope: TeleportScope): void => {
      const boxClip = this._boxClip(node, eff);
      const childM = this._descendOffset(node, eff);
      for (const child of orderedChildren(node)) {
        const clip = this._childClip(node, stack, boxClip, child);
        if (child.TeleportSeq !== 0) {
          scope.Deferred.push({ N: child, M: childM });
          continue;
        }
        if (child.RenderStyle.Layer !== 0) {
          const childScope: TeleportScope = { Deferred: [], Stack: clip };
          renderNode(child, childM, clip, childScope);
          replayScope(childScope);
          continue;
        }
        renderNode(child, childM, clip, scope);
      }
    };

    // Single tree walk — renders everything in z-order. The (cx, cy,
    // ox, oy) tuple is the affine map from this Jiv's natural
    // (post-layout, pre-Visual-transform) coords to canvas px:
    //   canvasX = ox + cx * jiv.X
    //   canvasW = cx * jiv.Width
    // Identity (cx=cy=1, ox=oy=0) at the root is the no-transform path.
    // VisualScale on an ancestor composes into the effective tuple so
    // descendants ride along, just like CSS transform on a parent.
    const renderNode = (node: Jiv, m: Mat2x3, stack: ClipStack, scope: TeleportScope): void => {
      // Compose own's transform onto the inherited matrix. Order: rotation
      // (outermost, about Transform.Origin) then VisualScale/Translate (about
      // VisualOrigin). Both ride the inherited matrix so they CASCADE to
      // descendants — rotation now flows to children exactly like scale/translate.
      // Pivots are in NATURAL coords (jiv.X/Y as the layout solver assigned).
      let eff: Mat2x3 = m;
      // STEP A — rotation about Transform.Origin (the new cascading behavior).
      const rotDeg = node.RenderStyle.Transform.Rotation;
      if (rotDeg !== 0) {
        const th = rotDeg * (Math.PI / 180);
        const rc = Math.cos(th), rs = Math.sin(th);
        const rpx = node.X + node.Width * node.RenderStyle.Transform.OriginX;
        const rpy = node.Y + node.Height * node.RenderStyle.Transform.OriginY;
        eff = matMul(eff, [rc, rs, -rs, rc, rpx * (1 - rc) + rpy * rs, rpy * (1 - rc) - rpx * rs]);
      }
      // STEP B — VisualScale/Translate about VisualOrigin (matches the legacy
      // formula exactly when rotation is absent; now stacks onto rotation).
      const sx = node.RenderStyle.VisualScaleX;
      const sy = node.RenderStyle.VisualScaleY;
      const tx = node.RenderStyle.VisualTranslateX;
      const ty = node.RenderStyle.VisualTranslateY;
      if (sx !== 1 || sy !== 1 || tx !== 0 || ty !== 0) {
        const pivotX = node.X + node.Width * node.RenderStyle.VisualOriginX;
        const pivotY = node.Y + node.Height * node.RenderStyle.VisualOriginY;
        eff = matMul(eff, [sx, 0, 0, sy, pivotX * (1 - sx) + tx, pivotY * (1 - sy) + ty]);
      }
      if (!this._isInsideClipStack(node, eff, stack)) {
        // This node's OWN box is outside the clip. If it CLIPS its children
        // (Overflow: Hidden/Scroll), they're bounded by that box and can't be
        // visible either — skip the whole subtree (the cheap, common case).
        // But an Overflow: Visible node can have children that OVERFLOW its
        // box and remain on-screen after the box itself scrolls off — e.g. a
        // flex-wrap container whose intrinsic height is one row while its
        // children wrap to several rows. Dropping the subtree there made the
        // overflowing rows vanish the instant the (one-row) box passed the
        // viewport edge. So recurse — each child self-culls by its OWN AABB —
        // and just skip drawing this node's own panel/text (it's off-screen).
        if (node.Overflow === 'Hidden' || node.Overflow === 'Scroll') return;
        descendChildren(node, eff, stack, scope);
        return;
      }
      // Set image intrinsic sizes even for zero-size nodes — this breaks the
      // chicken-and-egg: Height:Auto needs IntrinsicHeight, which comes from
      // the loaded image. Without this, the node stays at 0 height forever.
      // The image URL is sourced from the Background tagged union (Image kind);
      // ImageSrc no longer exists as a separate property.
      const bg = node.RenderStyle.Background;
      const bgImageUrl = bg.Kind === 'Image' ? bg.Url : null;
      if (bgImageUrl && node.IntrinsicWidth === null) {
        const imgEntry = this._imageCache.Get(bgImageUrl);
        if (imgEntry && imgEntry.Ready) {
          node.IntrinsicWidth = imgEntry.Width / this._dpr;
          node.IntrinsicHeight = imgEntry.Height / this._dpr;
          node.MarkLayoutDirty();
        }
      }

      if (node.Width <= 0 || node.Height <= 0 || !node.Visible) {
        descendChildren(node, eff, stack, scope);
        return;
      }

      // Encode the current clip stack into the per-frame buffer so this Jiv's
      // panel/text instances reference it by (offset, count).
      const clipMeta = this._clipBuffer.Encode(stack, this._dpr);

      const material = node.RenderStyle.Material;

      if (material === 'ProgressiveBlur' && !this._diagNoPblur) {
        // Flush both pending batches: the pblur snapshots the scene and
        // samples it — so the scene must contain everything drawn so
        // far. Deferred panels AND text in the buffers haven't hit the
        // FBO yet.
        flushPanels();
        flushText();
        // Progressive blur samples two textures: `u_Scene` (unblurred, the
        // ramp's clear end) and `u_Pyramid` (blurred, the ramp's heavy end).
        // `u_Scene` cannot be sceneFbo.Texture directly because the pblur
        // draws INTO sceneFbo — feedback loop. So we use SnapshotScreen to
        // copy sceneFbo → _snapshotTex and feed that as `u_Scene`.
        // `u_Pyramid` is the BlurPass output (a separate texture), no
        // feedback risk.
        const d = this._dpr;
        const maxFeatherSigma = node.RenderStyle.BackdropFrostBlur;
        // Keep level 0 lightly blurred (σ ≈ 1px) so the ramp climbs the full
        // clear→heavy range smoothly. Raising the base σ to floor the heavy
        // end's resolution compresses the gradient into a near-uniform "mask"
        // (most of the element reads as already-blurred) — not worth it. The
        // heavy end's low-res mip is kept smooth instead by the output dither.
        const baseSigmaDevice = this._dpr;
        const targetSigmaDevice = maxFeatherSigma * this._dpr;
        const maxLod = Math.max(1, Math.log2(Math.max(1, targetSigmaDevice / baseSigmaDevice)));
        // Scissor the blur passes to this pblur's rect + LOD-scaled margin.
        // Each mipmap LOD doubles the canvas-space footprint of one texel,
        // so a bilinear sample at max LOD reaches ±2^(maxLod+1) canvas px
        // from the pblur's own rect. Fullscreen pblurs (TopBlur/ContentBlur
        // covering 100vw×100vh) get clamped to the full canvas — no
        // savings, no harm. Localized pblurs (card footers ~260×60) see
        // big fill-rate reductions: e.g. 516×316 vs 1920×1080 = ~13× per
        // blur pass, 4 passes per blur = ~50× cumulative fragment work
        // saved per localized pblur per frame.
        const lodMargin = Math.ceil(Math.pow(2, maxLod + 1));
        // AABB of the (possibly rotated) node in canvas px — scissor is an
        // axis-aligned GPU cull, so use the rotated rect's bounding box.
        const _ab = this._nodeAabb(node, eff);
        const px = _ab.minX * d;
        const py = _ab.minY * d;
        const pw = (_ab.maxX - _ab.minX) * d;
        const ph = (_ab.maxY - _ab.minY) * d;
        // When a feather is set AND the background is fully opaque, the
        // solid post-feather region collapses to just u_Background — no
        // pyramid samples read past the feather zone (the shader early-outs
        // there). Tighten the blur scissor to only the feather strip + LOD
        // margin — for a tall content-area pblur with a 120pt feather,
        // that's ~15× less blur fill per frame.
        const bgOpaque = node.RenderStyle.Background.Color.A >= 0.999;
        const dir = node.RenderStyle.ProgressiveBlurDirection;
        // Feather ceilings at the element's OWN device axis length — height for
        // ToTop/ToBottom, width for ToLeft/ToRight. A feather longer than the
        // axis can never complete the ramp, leaving the whole element a partial
        // gradient that never reaches full blur. 0 keeps "span the whole axis".
        const axisLenDev = (dir === 'ToTop' || dir === 'ToBottom')
          ? matScaleY(eff) * node.Height * d
          : matScaleX(eff) * node.Width * d;
        const featherRaw = node.RenderStyle.ProgressiveBlurFeather * d;
        const feather = featherRaw > 0 ? Math.min(featherRaw, axisLenDev) : 0;
        // The feather-strip tightening slices one edge off the AXIS-ALIGNED
        // AABB. Under rotation the AABB is larger than (and offset from) the
        // rotated panel, so a tightened strip clips the rotated blur's edge
        // ("edge miss on the outside"). When rotated, fall back to the full
        // AABB scissor — the shader's ramp/feather still runs correctly in the
        // rotated frame; only this CPU-side fill optimization is skipped.
        const _rotated = matSin(eff) !== 0;
        let fx = px, fy = py, fw = pw, fh = ph;
        if (feather > 0 && bgOpaque && !_rotated) {
          if (dir === 'ToBottom')      { fh = feather; }
          else if (dir === 'ToTop')    { fy = py + ph - feather; fh = feather; }
          else if (dir === 'ToRight')  { fw = feather; }
          else if (dir === 'ToLeft')   { fx = px + pw - feather; fw = feather; }
        }
        const scissor = {
          x: Math.max(0, Math.floor(fx - lodMargin)),
          y: Math.max(0, Math.floor(fy - lodMargin)),
          w: Math.min(w, Math.ceil(fw + lodMargin * 2)),
          h: Math.min(h, Math.ceil(fh + lodMargin * 2)),
        };
        if (this._consoleProfilingEnabled && this._surfFrame === 90) {
          // eslint-disable-next-line no-console
          console.log(`[Jaui.surf] PBLUR rect=${Math.round(pw)}x${Math.round(ph)} scissor=${scissor.w}x${scissor.h} (${(scissor.w * scissor.h / 1e6).toFixed(2)}Mpx) frost=${maxFeatherSigma}pt dir=${dir} maxLod=${maxLod.toFixed(1)} bgOpaque=${bgOpaque}`);
        }
        // Snapshot only this pblur's footprint + blur margin (same scissor the
        // blur uses) instead of the whole canvas — the shader samples the pyramid
        // only within the panel, so the rest of the snapshot is never read.
        const sceneSnap = r.SnapshotScreen(scissor);
        // Sharp-root pyramid: radius 0 makes BlurPass seed mip 0 with the RAW
        // scene (a 1-tap copy, no dual-filter pre-blur), then GenerateBlurMipmap
        // builds the Gaussian stack from it. The shader samples ONE continuous
        // LOD from mip 0 (truly clear, σ=0) up to u_MaxLod (heavy) — true
        // progression with no sharp/blurred crossfade, and one fewer pass than
        // the dual filter.
        lastBackdrop = r.ComputeBlur(sceneSnap, w, h, 0, undefined, scissor);
        lastBaseFrostLod = 0;
        // Cap mip build at this pblur's max sampled LOD — the shader does
        // textureLod(u_Pyramid, uv, ramp²·maxLod), so it never reads past
        // maxLod. Building deeper levels is pure fragment-fill waste on
        // a software rasterizer.
        r.GenerateBlurMipmap(maxLod);
        r.RebindSceneTarget();
        r.EnableBlend();
        r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        // The shader builds a UNROTATED quad from `Rect` and rotates it about
        // the pivot, so its ramp/feather run along the element's own (rotated)
        // axes. Rect = the element's unrotated device rect (centered on the
        // mapped center); Cos/Sin/Pivot carry the accumulated rotation. At
        // rotation 0 the unrotated rect equals the legacy AABB and (1,0) is a
        // no-op, so non-rotated pblur is unchanged.
        const _pbCx = matScaleX(eff), _pbCy = matScaleY(eff);
        const _pbPivotX = matApplyX(eff, node.X + node.Width * 0.5, node.Y + node.Height * 0.5) * d;
        const _pbPivotY = matApplyY(eff, node.X + node.Width * 0.5, node.Y + node.Height * 0.5) * d;
        // The element's OWN unrotated device half-extents. The pblur vertex
        // shader builds the quad from this Rect and ROTATES it about the pivot,
        // so an element-sized quad already covers the rotated element exactly —
        // do NOT expand to the rotated AABB (the panel does that because its
        // quad is an un-rotated screen-space cover; the pblur's quad is not).
        // Expanding here would make v_Local / axisLen track the AABB, so the
        // feather distance and ramp "height" would breathe with the rotation
        // angle. Element-sized keeps the ramp on the element's true axes; the
        // clip SDF (ClipOffset/ClipCount) bounds the silhouette. At rotation 0
        // this is byte-identical to the previous AABB form.
        const _pbHalfW = _pbCx * node.Width * 0.5 * d;
        const _pbHalfH = _pbCy * node.Height * 0.5 * d;
        if (!this._diagNoPblurDraw) r.DrawProgressiveBlur({
          Rect: { X: _pbPivotX - _pbHalfW, Y: _pbPivotY - _pbHalfH, W: _pbHalfW * 2, H: _pbHalfH * 2 },
          Cos: matCos(eff), Sin: matSin(eff), PivotX: _pbPivotX, PivotY: _pbPivotY,
          Scene: sceneSnap, // reuse the snapshot we took for ComputeBlur
          Pyramid: lastBackdrop,
          MaxLod: maxLod,
          Direction: { ToTop: 0, ToBottom: 1, ToLeft: 2, ToRight: 3 }[node.RenderStyle.ProgressiveBlurDirection] ?? 0,
          Feather: feather,
          Easing: Math.max(0.001, node.RenderStyle.ProgressiveBlurEasing),
          Opacity: node.EffectiveOpacity,
          Background: node.RenderStyle.Background.Color,
          Grading: {
            Brightness: node.RenderStyle.BackdropBrightness,
            Saturation: node.RenderStyle.BackdropSaturation,
            Contrast: node.RenderStyle.BackdropContrast,
          },
          ClipOffset: clipMeta.Offset,
          ClipCount: clipMeta.Count,
        });
        this._counts.PBlur++;

      } else if ((_isGlass(material) || _hasBackdropFilter(node)) && material !== 'ProgressiveBlur' && !this._diagNoGlass) {
        // Flush pending batches: same reason as pblur — backdrop-filter
        // panels (glass or flat) read the scene (indirectly via the blur
        // pyramid), so the scene must be current. Flat panels with
        // non-default BackdropBrightness/Saturation/Contrast/FrostBlur go
        // through this same path — the shader branches on materialType
        // to skip refraction/CA/bezel for them, but they still need the
        // pyramid bound to sample.
        flushPanels();
        flushText();
        // Glass samples only `u_Backdrop` (the blur pyramid), never the raw
        // scene — so there's no feedback loop and we can feed ComputeBlur
        // the scene FBO's texture directly, zero blits.
        //
        // Scissor the blur to just the panel's sample region (panel rect
        // plus a generous margin for refraction + rim + bezel). Fragment
        // fill on each blur pass drops from full-canvas to panel-sized —
        // 20-50× less for localized glass like TabBar/ToolbarDropdown. For
        // a ~500×80 TabBar on a 1920×1080 canvas, scissor saves ~98% of
        // the blur's fragment writes with zero visual change (glass only
        // samples inside this rect anyway).
        const d = this._dpr;
        // Build the backdrop blur at THIS panel's actual frost sigma so the
        // panel can sample LOD 0 (full resolution). Previously level 0 held
        // only a ~1px Gaussian and a panel reached its real frost by sampling
        // a high mip LOD (8pt frost -> LOD 3 -> 1/8 res), which made frosted
        // backdrops read as a low-res texture upscaled. The dual filter still
        // downsamples internally for speed then upsamples back to full res,
        // and we scissor to the panel rect below, so cost stays bounded.
        const frostCssPx = Math.max(1, node.RenderStyle.BackdropFrostBlur);
        // Margin must cover the FULL reach of the glass shader's backdrop
        // sampling (Jiv.Panel.frag), or a displaced sample lands past the
        // blurred region and reads unblurred/stale scene — the "no blur on the
        // outer refraction" rim. The shader displaces by, at worst:
        //   edge refraction: Thickness·avgScale·d · Refraction   (hump ≤ 1)
        //   surface bulge:   Fillet · minHalf · 0.25·0.7 · Refraction  (domeProfile ≤ 0.7)
        //   chromatic aberr: ChromaticAberration · 3
        // plus the frost blur's own spatial spread. Compute the exact bound so
        // the blur is built everywhere the panel can sample — keeps the full
        // refraction look (no displacement clamp) while guaranteeing it reads
        // blurred pixels. The scissor is still canvas-clamped below, so a heavy
        // panel just falls back toward a full-canvas blur (correct, bounded).
        const _gsx = matScaleX(eff), _gsy = matScaleY(eff);
        const _gAvgScale = (_gsx + _gsy) * 0.5;
        const _gMinHalf = Math.min(node.Width * _gsx, node.Height * _gsy) * d * 0.5;
        const _gThicknessDev = node.RenderStyle.Thickness * _gAvgScale * d;
        const _gBulgeMax = node.RenderStyle.Fillet * _gMinHalf * 0.25 * 0.7;
        const _gRefractMax = (_gThicknessDev + _gBulgeMax) * node.RenderStyle.Refraction;
        const _gCaMax = node.RenderStyle.ChromaticAberration * 3.0;
        const margin = frostCssPx * d + _gRefractMax + _gCaMax + 8 * d;
        const _ab = this._nodeAabb(node, eff);
        const px = _ab.minX * d;
        const py = _ab.minY * d;
        const pw = (_ab.maxX - _ab.minX) * d;
        const ph = (_ab.maxY - _ab.minY) * d;
        const scissor = {
          x: Math.max(0, Math.floor(px - margin)),
          y: Math.max(0, Math.floor(py - margin)),
          w: Math.min(w, Math.ceil(pw + margin * 2)),
          h: Math.min(h, Math.ceil(ph + margin * 2)),
        };
        if (this._consoleProfilingEnabled && this._surfFrame === 90) {
          // eslint-disable-next-line no-console
          console.log(`[Jaui.surf] GLASS rect=${Math.round(pw)}x${Math.round(ph)} scissor=${scissor.w}x${scissor.h} (${(scissor.w * scissor.h / 1e6).toFixed(2)}Mpx) frost=${frostCssPx}pt margin=${Math.round(margin)}`);
        }
        // Snapshot the raw scene BEFORE the pyramid overwrites anything.
        // The shader's sampleBackdrop falls back to this raw texture when
        // the effective LOD is 0 (no-frost flat panel, or the center of
        // a glass panel with frost=0) — avoids picking up the pyramid's
        // baked-in 1px base Gaussian. SnapshotScreen reuses an internal
        // texture so there's no per-frame allocation. Scissor the blit to this
        // glass panel's footprint + margin (same rect the blur uses) — the
        // shader only samples the snapshot within the panel, so a full-canvas
        // copy was pure wasted bandwidth scaling with screen size.
        const sceneSnap = r.SnapshotScreen(scissor);
        lastBackdrop = r.ComputeBlur(r.SceneTexture, w, h, frostCssPx * d, undefined, scissor);
        // Pyramid is built AT this panel's frost sigma, so set the base LOD to
        // the panel's frostLod: the shader's main sample (lod = frostLod -
        // u_BaseFrostLod) lands on LOD 0 (full res). Only the subtle glass
        // rim/inner boost (≲ 2 LODs) climbs into the now full-sigma mip chain.
        lastBaseFrostLod = Math.log2(Math.max(1, frostCssPx * d));
        // Headroom for the panel shader's refraction-footprint LOD: strong
        // refraction folds the backdrop and the shader raises the sampled LOD to
        // blur the caustic away (see Jiv.Panel.frag refractLod). That can reach
        // ~4-5; cap mip generation high enough that it ramps smoothly instead of
        // clamping to a too-shallow deepest mip mid-fold.
        const glassMaxLod = 5;
        r.GenerateBlurMipmap(glassMaxLod);
        r.RebindSceneTarget();

        r.EnableBlend();
        this._panelBuffer.Begin();
        this._panelBuffer.Push(node, this._dpr, eff, clipMeta.Offset, clipMeta.Count);
        r.PanelBeginBatch();
        r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
        // Always use the MATERIAL_GLASS variant for any standalone panel
        // that needs the pyramid path. Material is *inferred* from Thickness
        // (Thickness > 0 → 'LiquidGlass', else 'None'), so during a press →
        // resting transition the inferred Material flips the moment Thickness
        // crosses zero — and every effect gated by `materialType == 1.0`
        // (rim glow, hemispherical light, catchlight, rim spec) vanishes in
        // one frame. Using GLASS unconditionally keeps the variant fixed
        // across the transition; the rim/inner effects fade smoothly via
        // their own physical drivers (FresnelStrength, EdgeLight*, glassiness
        // = smoothstep(thickness)) so MATERIAL_GLASS at Thickness=0 produces
        // the same output MATERIAL_NONE would have. The cost of this on
        // flat-with-filter panels is one extra cheap branch in the shader.
        // Use MATERIAL_GLASS only for real glass. Plain-Jiv panels with just a
        // backdrop filter (BackdropFrostBlur / Brightness / Saturation / Contrast)
        // need MATERIAL_NONE so the shader's `else if (hasBackdropFilter)` fill
        // branch runs — that branch composites the Jiv's Background tint over
        // the filtered backdrop. The MATERIAL_GLASS variant constant-folds
        // materialType=1.0 and always takes `fillRgb = backdrop`, silently
        // discarding the tint. (The Thickness=0 stability argument above only
        // applies to elements whose Material flips between LiquidGlass and None;
        // for plain Jivs the material is statically 'None', no flip to protect.)
        // Glass panels with a non-Color Background (Image / Gradient) flow
        // through the same single-instance draw — the panel shader's fill
        // composite reads from the bound texture / gradient stops instead
        // of v_Tint when u_BgMode != 0. Border, refraction, frost, rim
        // spec all keep working.
        const glassBgPaint = this._computeBgPaint(node);
        r.PanelDrawBatch(w, h, lastBackdrop, lastBaseFrostLod, this._specTiltX, this._specTiltY, _isGlass(material), sceneSnap, glassBgPaint);
        if (_isGlass(material)) this._counts.Glass++;
        else this._counts.Panels++;
        if (glassBgPaint && glassBgPaint.Mode === 'Image') this._counts.Image++;
        // Reset the shared panel buffer so this glass instance isn't picked
        // up by the next flushPanels() and drawn AGAIN as a non-glass panel
        // (null backdrop → dummy black texture → glass goes solid gray).
        // The glass path shares `_panelBuffer` with non-glass batching for
        // code simplicity; we just have to return it to count=0.
        this._panelBuffer.Begin();

      } else {
        // Non-glass panel. Background.Kind decides batching:
        //   • Color   → accumulate into the shared batch with everyone else
        //                (one draw call per coherent run of Color panels).
        //   • Image / Gradient → flush the current Color batch, draw THIS
        //                panel as a single-instance batch with bgPaint
        //                bound, then keep accumulating. The panel shader
        //                still does border/shadow/clip — image is just
        //                another fill mode, not a separate draw pipeline.
        flushText();
        const flatBgPaint = this._computeBgPaint(node);
        if (flatBgPaint !== undefined) {
          flushPanels();
          this._panelBuffer.Begin();
          this._panelBuffer.Push(node, this._dpr, eff, clipMeta.Offset, clipMeta.Count);
          r.EnableBlend();
          r.PanelBeginBatch();
          r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
          r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
          r.PanelDrawBatch(w, h, null, 0, this._specTiltX, this._specTiltY, false, null, flatBgPaint);
          this._counts.Panels++;
          if (flatBgPaint.Mode === 'Image') this._counts.Image++;
          this._panelBuffer.Begin();
        } else {
          this._panelBuffer.Push(node, this._dpr, eff, clipMeta.Offset, clipMeta.Count);
        }
      }

      // Emit this node's text into the shared text batch. We do NOT flush
      // here — the buffer stays alive across siblings so contiguous text
      // nodes coalesce into one draw call. A subsequent category change
      // (panel push, glass, pblur, image, or end of walk) calls
      // `flushText()` which drains whatever's accumulated.
      //
      // Z-order: before accumulating text, flush any pending panels so
      // panels earlier in tree order end up BEHIND this text.
      const anim = this._textAnimators.get(node);
      if (anim && anim.Words.length > 0 && node.Visible && node.Width > 0 && node.Height > 0) {
        flushPanels();
        this._emitTextFor(node, eff, clipMeta.Offset, clipMeta.Count);
      }

      // Walk children in Layer order (ties break by tree order)
      descendChildren(node, eff, stack, scope);
    };

    this._textBuffer.Begin();
    this._clipBuffer.Begin();
    this._panelBuffer.Begin();
    // Populate _maxFrostBlur from the live tree before the render walk. It
    // sizes the Gaussian mip chain GenerateBlurMipmap builds (Jaui.ts ~1020
    // `glassMaxLod = log2(_maxFrostBlur) + 2`). If left at 0, glassMaxLod
    // caps at 2 and only mips 1..3 get the proper Dual-Filter Gaussian —
    // any sample at deeper LOD falls through to the GL driver's box-filter
    // mipmap, which collapses high-frequency content (UI chrome layered into
    // the scene FBO) to a flat mean. That's why plain-Jiv BackdropFrostBlur
    // panels at high Layer values rendered as a uniform color regardless of
    // the authored blur radius.
    this._maxFrostBlur = 0;
    this._scanFrostBlur(this.Root);
    const rootScope: TeleportScope = { Deferred: [], Stack: EmptyClipStack };
    renderNode(this.Root, MAT_IDENTITY, EmptyClipStack, rootScope);
    // In-flight teleports with no layered ancestor paint last at root level.
    replayScope(rootScope);
    // Trailing flushes — catch anything deferred since the last category
    // boundary. Order: panels first (they were pushed earlier in tree
    // order than the trailing text, if any).
    flushPanels();
    flushText();

    // Apply deferred janvas clip masks. Wiping scene FBO pixels outside the
    // nearest Overflow:Hidden ancestor's rounded rect — done now, after
    // every in-tree consumer has read the scene, so pblur/glass blur
    // pyramids see foreign content (not zeroed corners) while the
    // presented frame still respects the visual clip.
    if (this._pendingJanvasMasks.length > 0 && this._renderer instanceof WebGL2Renderer) {
      const gl = this._renderer.GetGL();
      if (gl) {
        const gl2r = this._renderer;
        gl2r.RebindSceneTarget();
        gl.viewport(0, 0, w, h);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.STENCIL_TEST);
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
        gl.disable(gl.BLEND);
        for (const m of this._pendingJanvasMasks) {
          gl2r.DrawClipMask(m.drawX, m.drawY, m.drawW, m.drawH, m.clipX, m.clipY, m.clipW, m.clipH, m.radius, m.smoothness);
        }
        gl2r.InvalidateStateCache();
      }
    }

    // Final composite: the whole frame lives in sceneFbo. `PresentScene`
    // does a hardware `blitFramebuffer` from sceneFbo into the swap chain —
    // 2-3× faster than the old shader-based Blit(SceneTexture) path on
    // integrated GPUs, and can fuse with InvalidateFrameTransients on
    // tile-based mobile renderers (scene never leaves tile memory).
    r.PresentScene();

    // Tell the driver we don't need the default framebuffer's depth or the
    // scene FBO's color for the rest of this frame. On tile-based mobile
    // GPUs this discards the tile memory instead of writing it back to
    // main memory — real bandwidth win on iPad / Android.
    r.InvalidateFrameTransients();

    r.EndFrame();
  };

  private _cascadeOpacity = (node: Jiv, parentOp: number): void => {
    // Root is a framework-managed container — its RenderStyle resolves
    // Opacity: 'Presence' to 0 (no Presence in seed context, never
    // spring-animated). Treat it as fully opaque so descendants aren't
    // multiplied by 0.
    const eff = node === this.Root ? 1 : parentOp * node.RenderStyle.Opacity;
    node.EffectiveOpacity = eff;
    for (const child of node.Children) this._cascadeOpacity(child as Jiv, eff);
  };

  private _cascadeFilterGrade = (
    node: Jiv,
    parentB: number,
    parentS: number,
    parentC: number,
  ): void => {
    const rs = node.RenderStyle;
    // Isolate (or the Root) ignores the ancestor grade and starts fresh, so
    // an isolated subtree is graded only by its own + its own descendants'
    // Filter — the ancestor's grade does not bleed in.
    const base = node === this.Root || rs.Isolate;
    const b = (base ? 1 : parentB) * rs.Brightness;
    const s = (base ? 1 : parentS) * rs.Saturation;
    const c = (base ? 1 : parentC) * rs.Contrast;
    node.EffectiveBrightness = b;
    node.EffectiveSaturation = s;
    node.EffectiveContrast = c;
    for (const child of node.Children) this._cascadeFilterGrade(child as Jiv, b, s, c);
  };

  /** Resolve a Jiv's Background to a BgPaint the renderer can consume.
   *  Returns `undefined` for Color kinds (the default path — the instance
   *  buffer's per-panel tint carries the color). Returns a non-undefined
   *  BgPaint for Image (texture handle + Cover/Contain UV transform) and
   *  for LinearGradient / RadialGradient (direction / center + stops).
   *
   *  Side effects: kicks `ImageCache.LoadUrl` for Image kinds whose
   *  texture isn't yet in cache. While the bitmap is in flight this
   *  returns `undefined`, so the panel renders with v_Tint
   *  (Background.Color = the placeholder baked into the `Url(...)`
   *  expression) — frame paints solid placeholder, no missing-texture
   *  artifact. When the cache fires `OnLoadFinish` the engine kicks a
   *  relayout / re-render and this helper returns the Image BgPaint. */
  /** Cross-fade duration when an Image-Background texture first becomes
   *  Ready, or when a Jiv's image URL swaps to a new Ready texture. The
   *  panel paints `mix(placeholderColor, sampledImage, alpha)` where alpha
   *  ramps linearly from 0 to 1 over this many milliseconds. */
  private static readonly _BG_IMAGE_FADE_MS = 260;

  private _computeBgPaint = (node: Jiv): BgPaint | undefined => {
    const bg = node.RenderStyle.Background;
    if (bg.Kind === 'Color') return undefined;
    if (bg.Kind === 'Image') {
      let entry = this._imageCache.Get(bg.Url);
      if (!entry) {
        this._imageCache.LoadUrl(bg.Url, this._dpr);
        entry = this._imageCache.Get(bg.Url);
      }
      if (!entry || !entry.Ready) {
        // Texture in flight (or never queued, or failed). Reset the
        // fade-in tracker so the next Ready transition starts a fresh
        // cross-fade from the placeholder color.
        node.BgImageFadeUrl = null;
        return undefined;
      }
      // Cover/Contain UV transform — panelLocal [0..1] × scale + offset → image UV.
      // Cover scales so the image fully covers the panel (excess cropped);
      // Contain scales so the image fits inside (excess panel shows v_Tint).
      const panelAspect = node.Width / Math.max(node.Height, 0.0001);
      const imgAspect = entry.Width / Math.max(entry.Height, 1);
      let scaleX = 1, scaleY = 1;
      if (bg.Fit === 'Cover') {
        if (imgAspect > panelAspect) scaleX = panelAspect / imgAspect;
        else                          scaleY = imgAspect / panelAspect;
      } else {
        if (imgAspect > panelAspect) scaleY = imgAspect / panelAspect;
        else                          scaleX = panelAspect / imgAspect;
      }
      // Cross-fade alpha. First sight of a Ready entry for this URL kicks
      // off a fresh fade window; subsequent frames ramp `alpha` toward 1
      // and request another frame if the fade hasn't settled. URL swap
      // (Card `[image]` change) resets the fade start so the new image
      // also fades in over the previous one's placeholder color.
      const now = performance.now();
      if (node.BgImageFadeUrl !== bg.Url) {
        node.BgImageFadeUrl = bg.Url;
        node.BgImageFadeStartMs = now;
      }
      const elapsed = now - node.BgImageFadeStartMs;
      const alpha = Math.min(1, elapsed / Canvas._BG_IMAGE_FADE_MS);
      if (alpha < 1) this.RequestFrame();
      return {
        Mode: 'Image',
        Texture: entry.Texture,
        UvScaleX: scaleX,
        UvScaleY: scaleY,
        UvOffsetX: (1 - scaleX) * 0.5,
        UvOffsetY: (1 - scaleY) * 0.5,
        FadeAlpha: alpha,
      };
    }
    // Gradient — flatten the resolved stops into the renderer's plain shape.
    const stops = bg.Stops.map((s) => ({
      Position: s.Position,
      R: s.Color.R, G: s.Color.G, B: s.Color.B, A: s.Color.A,
    }));
    if (bg.Kind === 'LinearGradient') {
      return { Mode: 'LinearGradient', DirX: Math.cos(bg.AngleRad), DirY: Math.sin(bg.AngleRad), Stops: stops };
    }
    return { Mode: 'RadialGradient', CenterX: bg.CenterX, CenterY: bg.CenterY, Radius: bg.Radius, Stops: stops };
  };

  /** Compute the offset descendants see when descending past a scroll container. */
  /** Returns the (Ox, Oy) for descendants. ScrollX/Y is in this node's
   *  natural coords, so its contribution to the children's effective
   *  offset is `Cx * ScrollX` (subtracted) — the scroll moves content
   *  in the cascade-scaled space. Cx/Cy are unchanged on descent;
   *  this jiv's own VisualScale is composed in renderNode before this. */
  private _descendOffset = (node: Jiv, m: Mat2x3): Mat2x3 => {
    if (node.Overflow !== 'Scroll') return m;
    // Scroll is a translation in the node's LOCAL (natural) frame, so compose
    // it INTO the matrix as a local translate (right-multiply). A rotated
    // scroll container then scrolls along its own rotated axes. At rotation 0
    // this reduces to the legacy [ox - cx*ScrollX, oy - cy*ScrollY].
    return matMul(m, [1, 0, 0, 1, -node.ScrollX, -node.ScrollY]);
  };

  /** Canvas-space AABB of `node`'s (possibly rotated) rect under matrix `m` —
   *  the min/max of its four mapped corners. Used for axis-aligned scissor/cull
   *  rects. At rotation 0 this is exactly the node's mapped rect. */
  private _nodeAabb = (node: Jiv, m: Mat2x3): { minX: number; minY: number; maxX: number; maxY: number } => {
    const x0 = node.X, y0 = node.Y, x1 = node.X + node.Width, y1 = node.Y + node.Height;
    const ax = matApplyX(m, x0, y0), ay = matApplyY(m, x0, y0);
    const bx = matApplyX(m, x1, y0), by = matApplyY(m, x1, y0);
    const cx2 = matApplyX(m, x1, y1), cy2 = matApplyY(m, x1, y1);
    const dx = matApplyX(m, x0, y1), dy = matApplyY(m, x0, y1);
    return {
      minX: Math.min(ax, bx, cx2, dx), minY: Math.min(ay, by, cy2, dy),
      maxX: Math.max(ax, bx, cx2, dx), maxY: Math.max(ay, by, cy2, dy),
    };
  };

  /** AABB cull against the inherited clip stack. Returns true if the node's
   *  bounding box intersects every clip in the stack — false (skip) only if
   *  the node lies completely outside any single clip. Per-pixel rounded-rect
   *  clipping happens in the shader; this is just the cheap CPU-side cull.
   *  Uses the cascade-scaled rect so a transformed Jiv's clip cull respects
   *  its actually-rendered bbox. */
  private _isInsideClipStack = (
    node: Jiv, m: Mat2x3, stack: ClipStack,
  ): boolean => {
    if (stack.length === 0) return true;
    // AABB of the (possibly rotated) node — conservative cull (never rejects a
    // visible pixel). At rotation 0 this is exactly the node's mapped rect.
    const { minX: nx, minY: ny, maxX: nx2, maxY: ny2 } = this._nodeAabb(node, m);
    for (const c of stack) {
      if (nx2 <= c.X || nx >= c.X + c.W) return false;
      if (ny2 <= c.Y || ny >= c.Y + c.H) return false;
    }
    return true;
  };

  /** Build the rounded-rect ClipShape for `node` — its box plus its
   *  per-corner BorderRadius. Used both when a node clips its descendants
   *  (Overflow: Hidden|Scroll) and when a child opts in (ParentOverflow:
   *  Hidden). All values stay in CSS px; the buffer multiplies by dpr. */
  private _boxClip = (
    node: Jiv, m: Mat2x3,
  ): ClipShape => {
    const radii = node.RenderStyle.BorderRadius;
    // Axis scales + rotation basis from the cascaded matrix. At rotation 0,
    // cx=|a|, cy=|d|, cos=1, sin=0 — identical to the legacy scalar path.
    const cx = matScaleX(m);
    const cy = matScaleY(m);
    // Clamp to half-dimension (CSS border-radius rule). Without this, a
    // pill-style `BorderRadius: 999pt` on a small box produces an SDF whose
    // "inside" region is empty — the clip rejects everything including the
    // center, so the node's image/content draws are fully clipped away.
    const w = cx * node.Width;
    const h = cy * node.Height;
    const avgScale = (cx + cy) * 0.5;
    const maxR = Math.min(w, h) / 2;
    const rtl = Math.min(radii[0] * avgScale, maxR);
    const rtr = Math.min(radii[1] * avgScale, maxR);
    const rbr = Math.min(radii[2] * avgScale, maxR);
    const rbl = Math.min(radii[3] * avgScale, maxR);
    // If every corner is fully rounded (radii saturate at half-dim), the
    // shape is a circle/pill. Force smoothness=0 so the clip's superellipse
    // collapses to n=2 — otherwise the default 0.3 paints a squircle that
    // bulges into the diagonals, clipping a rounded square instead of a
    // circle. Mirrors ShapeMode's circle-mode classification in the panel
    // shader, which the clip path doesn't run.
    const fullyRounded = rtl >= maxR && rtr >= maxR && rbr >= maxR && rbl >= maxR;
    // The clip rect is the node's box in canvas space; under rotation its
    // top-left would be ambiguous, so store the CENTER (always well-defined)
    // and let the clip SDF rebuild corners from center ± half-extents in the
    // un-rotated frame. Cos/Sin let the per-pixel clip SDF un-rotate the sample.
    const cxLocal = node.X + node.Width * 0.5;
    const cyLocal = node.Y + node.Height * 0.5;
    return {
      // X/Y are the top-left of the UNROTATED box at this scale (center − half).
      // The clip SDF re-derives them after un-rotating about CenterX/Y.
      X: matApplyX(m, cxLocal, cyLocal) - w * 0.5,
      Y: matApplyY(m, cxLocal, cyLocal) - h * 0.5,
      W: w,
      H: h,
      RTL: rtl,
      RTR: rtr,
      RBR: rbr,
      RBL: rbl,
      Smoothness: fullyRounded ? 0 : node.RenderStyle.BorderRadiusSmoothness,
      Cos: matCos(m),
      Sin: matSin(m),
      CenterX: matApplyX(m, cxLocal, cyLocal),
      CenterY: matApplyY(m, cxLocal, cyLocal),
    };
  };

  /** Stack passed down to a child, factoring its `ParentOverflow`:
   *  - `Visible` → escape one level (parent's contribution dropped if any).
   *  - `Hidden`  → append parent's box clip even if parent is `Visible`.
   *  - `Inherit` → append parent's box clip iff parent is Hidden/Scroll. */
  private _childClip = (
    parent: Jiv,
    parentIncomingStack: ClipStack,
    parentBoxClip: ClipShape,
    child: Jiv,
  ): ClipStack => {
    const po = child.ChildLayout.ParentOverflow;
    if (po === 'Visible') return parentIncomingStack;
    if (po === 'Hidden') return [...parentIncomingStack, parentBoxClip];
    return parent.Overflow === 'Visible'
      ? parentIncomingStack
      : [...parentIncomingStack, parentBoxClip];
  };

  /** Walk the tree before the blur pass to find the largest FrostBlur (CSS px).
   *  Reads from RenderStyle (resolved px), not Style (authorable string) so the
   *  blur pass picks the actually-rendered value. */
  private _scanFrostBlur = (node: Jiv): void => {
    // Any panel with BackdropFrostBlur needs the blur pyramid sized for it —
    // flat panels now sample backdrop too, so their frost blur counts here.
    if (node.Width > 0 && node.Height > 0 && node.Visible
        && node.RenderStyle.BackdropFrostBlur > this._maxFrostBlur) {
      this._maxFrostBlur = node.RenderStyle.BackdropFrostBlur;
    }
    for (const child of node.Children as Jiv[]) this._scanFrostBlur(child);
  };

  private _emitTextFor = (node: Jiv, m: Mat2x3, clipOffset: number, clipCount: number): void => {
    if (node.Width <= 0 || node.Height <= 0 || !node.Visible) return;
    const anim = this._textAnimators.get(node);
    if (!anim || anim.Words.length === 0) return;

    // Padding is a Length — resolve against this Jiv's ctx (populated by
    // the layout pass). ctx always exists post-layout; fall back to the
    // root's ctx if something went sideways to avoid NaN in the render.
    const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
    const [padT, , padB, padL] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    // Axis scales from the cascaded matrix (cx=cy=1 unscaled). Word ANCHORS go
    // through the full matrix so rotated text flows along the rotated baseline;
    // glyph quads ALSO tilt by the matrix rotation (cos/sin below) about the
    // node's center, so a rotated panel's text rotates with it as one unit.
    const cx = matScaleX(m);
    const cy = matScaleY(m);
    const tCos = matCos(m);
    const tSin = matSin(m);
    // Shared glyph pivot = the text node's center mapped to device px, so every
    // glyph rotates about the same point (the panel center) and stays cohesive.
    // centerLocal* is that center in LOCAL coords (used to build each glyph's
    // UNROTATED anchor; the shader applies the rotation about the pivot).
    const centerLocalX = node.X + node.Width * 0.5;
    const centerLocalY = node.Y + node.Height * 0.5;
    const pivotX = matApplyX(m, centerLocalX, centerLocalY) * this._dpr;
    const pivotY = matApplyY(m, centerLocalX, centerLocalY) * this._dpr;
    const cyForFold = cy > 1e-6 ? cy : 1; // guard the yOffset fold-into-local divide
    // Content origin + height in LOCAL (natural) coords; mapped per-word below.
    const contentLX = node.X + padL;
    const contentLY = node.Y + padT;
    const contentH = cy * (node.Height - padT - padB);

    let totalTextHeight = 0;
    for (const w of anim.Words) {
      const bottom = w.TargetY + w.Height;
      if (bottom > totalTextHeight) totalTextHeight = bottom;
    }
    const yOffset = (contentH - cy * totalTextHeight) / 2;

    // Pull the animator's effective FontWeight once (snapped to 25 in
    // Text.Animator). All words in a block transition together, so we
    // build the override style once outside the per-word loop. Loose
    // equality on style weight handles the case where some legacy code
    // path lets a string-typed weight reach this far.
    const effectiveWeight = anim.EffectiveWeight;
    const styleNeedsWeightOverride = effectiveWeight !== Number(anim.Style.FontWeight);
    for (const w of anim.Words) {
      const opacity = node.EffectiveOpacity * w.Opacity.Value;
      if (opacity <= 0.001) continue;
      // During a `:GroupHover` / `:Hover` weight transition, the cache
      // fetch uses the snapped current weight so the rasterized atlas
      // entry width agrees with the per-tick re-measured layout. After
      // the spring settles, `effectiveWeight === w.Style.FontWeight` and
      // we fall back to the original style identity (cheap path).
      const styleForCache = styleNeedsWeightOverride
        ? { ...w.Style, FontWeight: effectiveWeight }
        : w.Style;
      const entry = this._textCache.Get(w.Content, styleForCache, null, this._dpr);
      // Word anchor in LOCAL coords, then mapped through the full matrix. yOffset
      // is a canvas-space (cy-scaled) centering term; fold it back to local
      // (÷cy) so the matrix re-applies it correctly under rotation.
      const wlx = contentLX + w.SpringX.Value;
      const wly = contentLY + (yOffset / cyForFold) + w.SpringY.Value;
      // Glyph anchor in the UNROTATED (scale+translate-only) frame: the mapped
      // node center plus the scaled offset from the node center, with rotation
      // STRIPPED. The shader then rotates the quad about the same pivot, so the
      // final glyph is rotated exactly once. (Mapping through the full matrix
      // here AND rotating in the shader would double-rotate — the first-span
      // drift.) cx,cy,centerLocal*,pivot* are hoisted above the loop.
      const wx = pivotX / this._dpr + cx * (wlx - centerLocalX);
      const wy = pivotY / this._dpr + cy * (wly - centerLocalY);
      // Word-level Scale — used during a FontSize-only transition to make
      // the NEW-size raster look OLD-sized on frame 0 and spring to 1.0.
      // Scale around each word's center to keep layout anchored.
      const wordScale = w.Scale.Value;
      // Cascade the visual scale into the rendered glyph dimensions.
      const drawW = entry.Width * wordScale * cx;
      const drawH = entry.Height * wordScale * cy;
      const dxCenter = (entry.Width * cx - drawW) / 2 / this._dpr;
      const dyCenter = (entry.Height * cy - drawH) / 2 / this._dpr;
      this._textBuffer.Push({
        X: wx * this._dpr + dxCenter * this._dpr,
        Y: wy * this._dpr + dyCenter * this._dpr,
        Width: drawW,
        Height: drawH,
        Uv: entry.Uv,
        Opacity: opacity,
        ClipOffset: clipOffset,
        ClipCount: clipCount,
        TintR: w.TintR.Value,
        TintG: w.TintG.Value,
        TintB: w.TintB.Value,
        TintA: w.TintA.Value,
        Cos: tCos,
        Sin: tSin,
        PivotX: pivotX,
        PivotY: pivotY,
      });
    }
  };

  private _processTextTransitions = (node: Jiv): void => {
    const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
    const [, padR, , padL] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    // LayoutWidth is the solver's last-computed target. node.Width is the
    // animator's mid-spring value, which would re-trigger text wrap every
    // frame as it animates. Reading the layout plane pins the wrap budget
    // to the final dimension so word positions are stable from the first
    // frame after content/layout changes.
    const contentW = node.LayoutWidth - padL - padR;
    const maxWidth = contentW > 0 ? contentW : null;
    const resolvedStyle = ResolveTextStyle(node.EffectiveTextStyle(), ctx);

    if (node.Text !== null) {
      let anim = this._textAnimators.get(node);
      if (!anim) {
        anim = new TextAnimator(resolvedStyle);
        this._textAnimators.set(node, anim);
        this._animationManager.Register(anim);
      }
      if (anim.Update(node.Text, resolvedStyle, maxWidth)) {
        this._animationManager.Kick();
      }
    } else {
      const anim = this._textAnimators.get(node);
      if (anim && anim.Content !== '') {
        if (anim.Update('', resolvedStyle, maxWidth)) {
          this._animationManager.Kick();
        }
      }
    }
    for (const child of node.Children as Jiv[]) this._processTextTransitions(child);
  };

  private _measureDirtyText = (node: Jiv): void => {
    if (node.Text !== null && (node.Dirty & DirtyFlag.Text || node.TextMeasurement === null)) {
      // Unbounded measurement — intrinsic sizing with padding is handled by ComputeIntrinsicSizes.
      // TextStyle holds Length fields (FontSize, LetterSpacing) — resolve against this Jiv's ctx.
      const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
      const resolved = ResolveTextStyle(node.EffectiveTextStyle(), ctx);
      // Measure at the target weight (resolved style). A previous version
      // measured at the animator's live spring weight so surrounding boxes
      // reflowed smoothly with the transition — visually nicer in isolation,
      // but in flex-wrap containers (tokenized input rows) the per-frame
      // width deltas crossed the wrap threshold mid-spring, popping rows up
      // and down repeatedly. Snapping to target width on frame 0 means
      // wrap is decided once and stays stable; the glyph weight then morphs
      // smoothly within the already-sized box (Text.Animator re-measures
      // internal word positions per tick at the raw weight, so word slots
      // inside the box still slide continuously).
      node.TextMeasurement = MeasureText(node.Text, resolved, null);
    } else if (node.Text === null) {
      node.TextMeasurement = null;
      // Only clear intrinsics if they weren't set by an image background.
      const bg = node.RenderStyle.Background;
      if (bg.Kind !== 'Image') {
        node.IntrinsicWidth = null;
        node.IntrinsicHeight = null;
      }
    }
    for (const child of node.Children as Jiv[]) this._measureDirtyText(child);
  };

  // ─── Layout Integration ───

  /** DirtyTracker.Notify — called from Element.MarkLayoutDirty for every
   *  node in this Canvas's tree. Cheap O(1) Set add; LCA / scope-root
   *  decision happens in `_chooseScopedRoot` at solve time, not here, to
   *  keep the dirty path branchless. Cleared after every solve. */
  Notify = (node: JauiElement): void => {
    this._dirtyNodes.add(node);
  };

  /** Pick the smallest subtree we can re-solve in isolation this frame, or
   *  fall back to Root for the whole tree.
   *
   *  v1 heuristic: scope only when exactly one node is dirty AND we can
   *  walk up to an ancestor with explicit non-keyword Width AND Height in
   *  its ChildLayout (i.e., a fixed box whose size doesn't depend on its
   *  children's intrinsics). For multi-dirty cases, computing the LCA +
   *  intrinsic-escalation logic is more involved and isn't worth it until
   *  the scoped path is proven; full-tree solve falls through. */
  private _chooseScopedRoot = (): JauiElement => {
    if (this._dirtyNodes.size !== 1) return this.Root;
    let node: JauiElement | null = null;
    for (const n of this._dirtyNodes) { node = n; break; }
    if (!node || node === this.Root) return this.Root;

    // Walk up to the first ANCESTOR whose layout box doesn't depend on
    // child intrinsics. Width/Height as 'Auto' / 'MinContent' / 'MaxContent'
    // means parent size depends on the dirty subtree's own intrinsic — a
    // change there could propagate beyond the scope, so we keep climbing.
    // Anything else (numeric pt/px/vw/vh, percent, arithmetic) is a fixed
    // box from this subtree's perspective: parent isn't dirty, so its size
    // hasn't changed, and our re-solve is contained.
    //
    // Start at node.Parent, NOT node itself: subtree mode in SolveLayout
    // freezes the scope-root's Width/Height to the prior frame's values
    // (Layout.Solver.ts uses `root.Width` as the seed box), and
    // _solveAndAnimate explicitly skips the subtreeRoot from animator
    // updates. So if the dirty node is picked as its own scope, its newly-
    // mutated ChildLayout (e.g. a per-frame `Width: '12%'` on a scrub fill
    // driven from a playback RAF) is silently dropped — the percent never
    // gets re-resolved against the parent's actual width. Picking the
    // parent guarantees the dirty node appears as a child of the solve.
    let cur: JauiElement | null = node.Parent;
    while (cur !== null && cur !== this.Root) {
      const cl = cur.ChildLayout;
      const wFixed = cl.Width !== 'Auto' && cl.Width !== 'MinContent' && cl.Width !== 'MaxContent';
      const hFixed = cl.Height !== 'Auto' && cl.Height !== 'MinContent' && cl.Height !== 'MaxContent';
      if (wFixed && hFixed) {
        // Scope is only safe when the candidate's RESOLVED rect is stable.
        // `cur.ChildLayout.Width/Height` being a "fixed token" (`100%`, `100vh`,
        // a length expression) doesn't imply the resolved `cur.Width/Height`
        // is settled — `JivAnimator.Tick` writes `_element.Width = Springs.Width.Value`
        // every frame, so a candidate whose animator is mid-spring exposes a
        // transient value as its rect. `SolveLayout` in subtree mode seeds
        // `boxWidth = root.Width / boxHeight = root.Height`, then `_solveAndAnimate`
        // calls `animator.SetTargets(...)` on every descendant against that
        // mid-spring box. If a descendant's new target lands within `Spring.Set`'s
        // 0.1px deadband, the kick is skipped and the corrupted target sticks —
        // the trap that turned a Chrome page-zoom into a permanently-shifted
        // Drill editor panel that no subsequent zoom could recover.
        //
        // Skip candidates with an in-flight animator; keep climbing so the
        // scope-root is always a settled box. Falls back to Root when nothing
        // up the chain is stable, which yields the full-tree solve that
        // `_resize` already runs — i.e. the worst case is "no perf win for
        // a few frames during a resize-driven cascade," not "wrong layout."
        const anim = this._animators.get(cur);
        if (!anim
            || (anim.Springs.X.IsSettled
                && anim.Springs.Y.IsSettled
                && anim.Springs.Width.IsSettled
                && anim.Springs.Height.IsSettled)) {
          return cur;
        }
      }
      cur = cur.Parent;
    }
    return this.Root;
  };

  private _solveAndAnimate = (subtreeRoot: JauiElement = this.Root): void => {
    if (subtreeRoot === this.Root) {
      // Root fills the canvas (only meaningful on full-tree solves; in
      // subtree mode the box is fixed by the prior frame's solve and
      // SolveLayout reads it from root.LayoutWidth/Height directly).
      this.Root.Width = this._width;
      this.Root.Height = this._height;
      this.Root.LayoutWidth = this._width;
      this.Root.LayoutHeight = this._height;
    }

    // SolveLayout itself stamps the layout plane (LayoutX/Y/Width/Height)
    // on every solved node before returning — see Layout.Solver.ts. The
    // animator updates below still drive the render plane (node.X/Y/
    // Width/Height) so visuals continue to spring as before.
    const results = SolveLayout(subtreeRoot, this._viewport(), this._jssVars);

    for (const [node, result] of results) {
      // Skip the root — it doesn't animate to its own position. (When in
      // subtree mode `subtreeRoot !== this.Root`, but we still don't
      // animate the subtree-root either: its box was already fixed by the
      // prior solve and SolveLayout just reflected that into `results`.)
      if (node === this.Root || node === subtreeRoot) continue;

      // Non-finite tripwire. A NaN layout result means a degenerate solve
      // input (unresolvable Length, missing @var, NaN intrinsic) — Spring.Set
      // refuses the value so the node holds its last good rect, but the
      // PRODUCER is a real bug: name the node once so it gets fixed.
      if (!Number.isFinite(result.X) || !Number.isFinite(result.Y)
          || !Number.isFinite(result.Width) || !Number.isFinite(result.Height)) {
        if (!this._nonFiniteWarned.has(node)) {
          this._nonFiniteWarned.add(node);
          const classes = node instanceof Jiv ? node.Classes.join(' ') : '(element)';
          // eslint-disable-next-line no-console
          console.warn(`[Jaui] non-finite layout result for [${classes}]:`,
            { X: result.X, Y: result.Y, Width: result.Width, Height: result.Height });
        }
      }

      let animator = this._animators.get(node);
      if (!animator) {
        const springs = node instanceof Jiv ? node.Springs : null;
        animator = new JivAnimator(node, springs);
        animator.SetTargets({
          X: result.X, Y: result.Y, Width: result.Width, Height: result.Height,
        });
        animator.SnapToTargets();
        this._animators.set(node, animator);
        this._animationManager.Register(animator);

        // Style animator is Jiv-specific, it springs every animatable
        // JivStyle field toward EffectiveStyle. Only created for Jivs.
        if (node instanceof Jiv) {
          const styleAnim = new JivStyleAnimator(node);
          styleAnim.SnapToTargets();
          this._styleAnimators.set(node, styleAnim);
          this._animationManager.Register(styleAnim);
          // Kick the rAF loop if the Jiv carries @Animation declarations
          // so the driver starts ticking immediately. Without this the
          // loop stays parked until something else (layout / hover / etc)
          // wakes it.
          if (node.Animations && node.Animations.length > 0) {
            this._animationManager.Kick();
          }
        }
      } else {
        const needsKick = animator.SetTargets({
          X: result.X, Y: result.Y, Width: result.Width, Height: result.Height,
        });
        if (node.SnapLayout) {
          animator.SnapToTargets();
        } else if (needsKick) {
          this._animationManager.Kick();
        }
      }
    }

    // Clean up animators for removed nodes
    // Gate on actual tree removal, not layout-results membership —
    // LeaveRequested nodes are skipped by the solver but still need
    // their style animator running so Opacity tracks Presence to 0.
    for (const [node, animator] of this._animators) {
      if (node.Parent === null) {
        this._animationManager.Unregister(animator);
        this._animators.delete(node);
      }
    }
    for (const [node, sAnim] of this._styleAnimators) {
      if (node.Parent === null) {
        this._animationManager.Unregister(sAnim);
        this._styleAnimators.delete(node);
      }
    }
    for (const [node, tAnim] of this._textAnimators) {
      if (node.Parent === null) {
        this._animationManager.Unregister(tAnim);
        this._textAnimators.delete(node);
      }
    }

  };

  private _clearDirty = (node: Jiv): void => {
    node.Dirty &= ~(DirtyFlag.Layout | DirtyFlag.Children | DirtyFlag.Text);
    for (const child of node.Children as Jiv[]) this._clearDirty(child);
  };

  private _resize = (): void => {
    // Browser-zoom can push DPR above native (e.g. 125% on a 1.5x display = DPR 1.875).
    // Text cache naturally invalidates — its hash includes DPR — so higher DPR costs
    // memory/fill but keeps strokes crisp on desktop.
    //
    // Touch-primary devices (iPad, iPhone) are usually fragment-bound: an iPad Pro
    // at DPR 2 pushes ~5.6MP/frame, which the dual-filter blur chain can't sustain
    // at 60Hz. Clamp to 2 on those devices to preserve framerate — most iPad users
    // report native DPR 2 anyway, so this is a no-op today but protects against
    // future DPR 3 devices and 125% Safari zoom on DPR 2 displays.
    //
    // `?dpr=N` in the URL overrides both paths, so the user can A/B on device
    // without rebuilding. NaN/≤0 is ignored.
    const raw = this._platform.GetDevicePixelRatio();
    const override = this._dprOverride;
    const prevDpr = this._dpr;
    if (override !== null) {
      this._dpr = override;
    } else {
      const isTouchPrimary = this._platform.IsPointerCoarse();
      this._dpr = isTouchPrimary ? Math.min(raw, 2) : raw;
    }
    // Size always comes from ResizeObserver (or main-thread proxy in worker
    // mode) via _pendingResize. We never read clientWidth/Height on the
    // canvas itself: (a) it forces a synchronous layout flush on cold load
    // (~56ms reflow per Chrome's Performance analyzer), and (b) OffscreenCanvas
    // has no clientWidth/Height — the engine has to be size-pushed regardless.
    if (this._pendingResize) {
      this._width = this._pendingResize.width;
      this._height = this._pendingResize.height;
      this._pendingResize = null;
    } else if (this._width === 0 || this._height === 0) {
      // First call before ResizeObserver has delivered an entry. Skip;
      // observer's own callback will rAF a follow-up _resize() once the
      // first entry lands.
      return;
    }
    // Otherwise, keep the cached size and just re-apply DPR (this path is
    // taken by the matchMedia DPR change handler).
    this.Element.width = Math.round(this._width * this._dpr);
    this.Element.height = Math.round(this._height * this._dpr);

    // Responsive `@If`: publish the live viewport so style/text predicates
    // (which read the shared module viewport) see it, then re-materialize any
    // layout-bearing `@If` overrides before the solve below picks them up.
    SetPredicateViewport(this._width, this._height);
    this._recomputeResponsiveLayout(this.Root);

    // Re-rasterize cached SVGs if we just zoomed in — texture resolution is
    // baked at rasterization time, so without this logos stay pixelated at
    // the old DPR even after the browser hands us more device pixels.
    if (this._dpr > prevDpr) this._imageCache.RerasterizeSvgs(this._dpr);

    // Mark root dirty so layout re-solves with new dimensions
    this.Root.Dirty |= DirtyFlag.Layout;

    // Re-render inline so the canvas backing store doesn't sit blank
    // between the synchronous Element.width/height write above (which
    // clears the WebGL framebuffer) and the next rAF tick. On user-
    // driven resize that gap is visible as a flicker; keeping the inline
    // render bridges it. The cold-load forced-reflow cost lives upstream
    // of this — the clientWidth reads — and should be addressed by
    // deferring size reads on first call, not by skipping the render.
    if (this._running) {
      if ((this.Root.Dirty & (DirtyFlag.Layout | DirtyFlag.Text)) !== 0) {
        CascadePointScale(this.Root, this._viewport(), this._jssVars);
        this._measureDirtyText(this.Root);
        ComputeIntrinsicSizes(this.Root, this._viewport(), this._jssVars);
        this._solveAndAnimate();
        this._clearDirty(this.Root);
        // Resize forces a full-tree solve, so any pre-resize dirty marks
        // are now stale. Clear so the next tick's `_chooseScopedRoot`
        // doesn't see a phantom single-dirty node and scope incorrectly.
        this._dirtyNodes.clear();
      }
      this._processTextTransitions(this.Root);
      this._render(0);
    }
  };

  /** Size pushed in by the most recent ResizeObserver callback. _resize()
   *  consumes this when set, avoiding a clientWidth read that would force
   *  the browser to flush pending layout. */
  private _pendingResize: { width: number; height: number } | null = null;

  private _observeResize = (): void => {
    // Worker mode: ResizeObserver doesn't exist in DedicatedWorkerGlobalScope
    // (it's a DOM API). The MainBridge owns its own ResizeObserver on the
    // proxy canvas element and pushes contentRect deltas via `M2W_Resize`,
    // which calls `ResizeFromBridge` here — same pipeline, different
    // source. Skip the engine-side observer entirely when RO isn't
    // available (= we're in a worker).
    //
    // Main-thread mode: defer _resize() to the next animation frame so
    // the RO callback returns synchronously. Running layout changes
    // in-line causes the browser to emit "ResizeObserver loop completed
    // with undelivered notifications" (benign but noisy).
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        this._pendingResize = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        };
      }
      requestAnimationFrame(() => this._resize());
    });
    observer.observe(this.Element as unknown as Element);
  };

  /** Pointer tracking → specular tilt. Simulates Apple's gyro-driven catchlight:
   *  as the user moves the cursor, the specular highlight slides across the
   *  rim. `SpecularTilt` is only applied to specular math (Blinn-Phong catchlight
   *  + rim-spec highlight) — not to ambient, edge light, or border directionality,
   *  which stay anchored to the stylesheet-set `LightAngle`. */
  // Retained for future mobile gyro wiring; see constructor note. The
  // `void` reference at the end of the constructor keeps TS happy without
  // a suppression comment until we actually wire it up.
  private _listenForSpecularTilt = (): void => {
    const updateFromEvent = (clientX: number, clientY: number): void => {
      const r = this._pageRect();
      // Map pointer to [-1, +1] relative to canvas center, then scale to a
      // modest tilt magnitude (Apple's gyro tilt rarely exceeds ~30°, which
      // in light-direction space is about 0.5 unit). Clamp to ±0.5.
      const tx = ((clientX - r.left) / Math.max(r.width, 1) - 0.5) * 2;
      const ty = ((clientY - r.top) / Math.max(r.height, 1) - 0.5) * 2;
      this._specTiltX = Math.max(-0.5, Math.min(0.5, tx * 0.5));
      // Y note: screen Y grows downward, but LightAngle's y convention has
      // "up" as negative in screen space (matches the instance buffer's
      // `lightY = -sin(rad)`). So mouse moving DOWN should shift the
      // specular origin DOWN in the light source, i.e. tilt.y positive.
      this._specTiltY = Math.max(-0.5, Math.min(0.5, ty * 0.5));
      this.RequestFrame();
    };

    this._on('pointermove', (e: PointerEvent) => {
      updateFromEvent(e.clientX, e.clientY);
    }, { passive: true });

    this._on('pointerleave', () => {
      this._specTiltX = 0;
      this._specTiltY = 0;
      this.RequestFrame();
    }, { passive: true });
  };

  /** Pointer → interaction states (Hover / Active). The topmost hit Jiv
   *  becomes Hover:true; everyone else clears. Pointer down/up toggles
   *  Active on the hit target. Focus is keyboard-driven and sits on a
   *  separate system (added with the input focus chain). Disabled is set
   *  declaratively by the caller — we never touch it here.
   *
   *  State changes trigger a re-render via RequestFrame. State mutations
   *  are O(1) per frame per pointer (two pointers = two state flips max). */
  private _hoveredJiv: Jiv | null = null;
  private _activeJiv: Jiv | null = null;
  /** Set by worker boot — resolves a Jiv to all other Jivs sharing one of
   *  its group-trigger classes. Used to fan `_groupHover` out on every
   *  hover-target change. Null in test/headless contexts that don't wire
   *  a JivRegistry; group-hover is a no-op there. */
  private _resolveGroupPeers: ((jiv: Jiv) => Set<Jiv>) | null = null;

  RegisterGroupPeersResolver = (fn: (jiv: Jiv) => Set<Jiv>): void => {
    this._resolveGroupPeers = fn;
  };

  /** Z-ordered topmost-hit at a client point. Shared by interaction-state
   *  tracking (hover/active), the pointer-hit dispatch, and the wheel handler
   *  so `(wheel)` consumers receive the event only when actually on top. */
  private _topmostAt = (clientX: number, clientY: number): Jiv | null => {
    const rect = this._pageRect();
    return this._scrollManager.HitTopmost(clientX - rect.left, clientY - rect.top);
  };

  private _listenForInteractionStates = (): void => {
    const topmostAt = this._topmostAt;

    // CSS-like Hover/Active: the flag propagates up the ancestor chain so
    // hovering/pressing a child also counts as hovering/pressing the parent.
    // Authors only define HoverStyle/ActiveStyle on the elements they want to
    // visually react; ancestors with no override don't change appearance.
    const setStateChain = (
      newTopmost: Jiv | null,
      oldTopmost: Jiv | null,
      flag: 'Hover' | 'Active',
    ): void => {
      const newPath = new Set<Jiv>();
      for (let n = newTopmost; n; n = n.Parent as Jiv | null) newPath.add(n);
      for (let n = oldTopmost; n; n = n.Parent as Jiv | null) {
        if (!newPath.has(n)) n[flag] = false;
      }
      newPath.forEach(n => { n[flag] = true; });
    };

    const fanOutGroupHover = (newJiv: Jiv | null, oldJiv: Jiv | null): void => {
      if (!this._resolveGroupPeers) return;
      const newPeers = newJiv ? this._resolveGroupPeers(newJiv) : new Set<Jiv>();
      const oldPeers = oldJiv ? this._resolveGroupPeers(oldJiv) : null;
      if (oldPeers) oldPeers.forEach(p => { if (!newPeers.has(p)) p.GroupHover = false; });
      newPeers.forEach(p => { p.GroupHover = true; });
    };

    this._on('pointermove', (e: PointerEvent) => {
      const hit = topmostAt(e.clientX, e.clientY);
      if (hit !== this._hoveredJiv) {
        setStateChain(hit, this._hoveredJiv, 'Hover');
        fanOutGroupHover(hit, this._hoveredJiv);
        this._hoveredJiv = hit;
        this._setCursor(_resolveCursor(hit));
        this._animationManager.Kick();
      }
      if (hit?.OnPointerMove) hit.OnPointerMove(e);
    });

    this._on('pointerleave', () => {
      if (this._hoveredJiv) {
        setStateChain(null, this._hoveredJiv, 'Hover');
        fanOutGroupHover(null, this._hoveredJiv);
        this._hoveredJiv = null;
        this._setCursor('');
        this._animationManager.Kick();
      }
    });

    // Click gesture — remember the down-hit Jiv and fire OnClick on
    // pointerup only when the release lands on the SAME Jiv AND the
    // pointer hasn't traveled past TAP_SLOP since pointerdown. The slop
    // check is what stops a scroll-drag from firing a phantom click: on
    // mobile the user's finger always moves a little, and content under
    // the lift-off point is often still the same card, so identity alone
    // is not enough. 10 px matches Chromium's mobile tap slop.
    let _clickDownJiv: Jiv | null = null;
    let _clickDownX = 0;
    let _clickDownY = 0;
    const TAP_SLOP = 10;

    // Touch: kill the browser's own long-press detector (haptic + OS
    // selection callout / context menu) at the actual source. On Chrome
    // Android the long-press timer arms on `touchstart`, which fires
    // BEFORE the matching `pointerdown` — so preventDefault on the
    // pointer event is too late. Touch events are passive by default;
    // `{ passive: false }` is required for preventDefault to register.
    // The canvas already has `touch-action: none`, so we're not breaking
    // any scroll/zoom default — we're just opting out of the long-press
    // gesture in the same swing.
    this._on('touchstart', (e: TouchEvent) => {
      e.preventDefault();
    }, { passive: false });

    this._on('pointerdown', (e: PointerEvent) => {
      const hit = topmostAt(e.clientX, e.clientY);
      _clickDownJiv = hit;
      _clickDownX = e.clientX;
      _clickDownY = e.clientY;
      if (!hit) return;
      setStateChain(hit, this._activeJiv, 'Active');
      this._activeJiv = hit;
      this._animationManager.Kick();
      if (hit.OnPointerDown) hit.OnPointerDown(e);
    });

    const clearActive = (): void => {
      if (this._activeJiv) {
        setStateChain(null, this._activeJiv, 'Active');
        this._activeJiv = null;
        this._animationManager.Kick();
      }
    };

    // Promote press → drag once travel exceeds slop: drop the pending
    // click and release the Active visual so the user doesn't see a
    // stuck press state while scrolling.
    this._on('pointermove', (e: PointerEvent) => {
      if (!_clickDownJiv) return;
      const dx = e.clientX - _clickDownX;
      const dy = e.clientY - _clickDownY;
      if (dx * dx + dy * dy > TAP_SLOP * TAP_SLOP) {
        _clickDownJiv = null;
        clearActive();
      }
    });

    this._on('pointerup', (e: PointerEvent) => {
      const upHit = topmostAt(e.clientX, e.clientY);
      if (upHit && _clickDownJiv === upHit && upHit.OnClick) {
        upHit.OnClick();
      }
      if (upHit?.OnPointerUp) upHit.OnPointerUp(e);
      _clickDownJiv = null;
      clearActive();
    });
    // Contextmenu (right-click / long-press) — hit-test the click point
    // like click does, fire OnContextMenu on the deepest interactive hit,
    // and unconditionally preventDefault on the real event so the browser's
    // own menu (Save image, etc.) never appears over the canvas. Apps that
    // care about right-click should bind (contextmenu) on a Jaui jiv via
    // the Angular bridge.
    this._on('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      const hit = topmostAt(e.clientX, e.clientY);
      if (hit?.OnContextMenu) hit.OnContextMenu(e);
    });

    this._on('pointercancel', () => {
      _clickDownJiv = null;
      clearActive();
    });
  };

  /** Mouse-driven text selection. Match web behavior:
   *    • Single mousedown — arms an anchor; a bare click without drag leaves
   *      NO visible selection (collapses any prior selection). Selection
   *      only materializes once the pointer crosses DRAG_SLOP.
   *    • Drag past slop — extends selection to the nearest word of the
   *      anchor Jiv at the current pointer position (past-bounds points
   *      clamp to the nearest line/word, same as browser selection).
   *    • Double-click — selects the word at the click point (immediate).
   *    • Triple-click — selects the whole line (immediate).
   *  Mobile (touch): long-press to start selection with handle UI is a
   *  deliberate follow-up — touch is currently reserved for scroll.
   *
   *  Click-count uses a 400 ms window with a < 5 px travel threshold,
   *  matching Chromium's heuristics. The active text Jiv is remembered
   *  across the burst so a triple-click always lands on the same Jiv. */
  private _listenForTextSelection = (): void => {
    let anchorJiv: Jiv | null = null;
    let anchorChar: number = -1;
    /** Granularity of the current drag: 'char' (word-by-word), 'word'
     *  (double-click — extend by whole words), 'line' (triple-click). */
    let granularity: 'char' | 'word' | 'line' = 'char';
    /** Active click-burst state for double/triple detection. */
    let lastClickAt = 0;
    let lastClickX = 0, lastClickY = 0;
    let clickCount = 0;
    /** Armed (pointerdown recorded, no visible range yet) vs dragging
     *  (range is live). Single-click stays armed until the pointer moves
     *  past DRAG_SLOP — matches native: bare click = no visible highlight. */
    let armed = false;
    let dragging = false;
    let armedX = 0, armedY = 0;
    const DRAG_SLOP = 3;

    const selMgr = this._selectionManager;

    this._on('pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (e.button !== 0) return;

      const rect = this._pageRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const hit = this._scrollManager.HitTopmost(cssX, cssY);
      const textJiv = selMgr.NearestTextJiv(this.Root, hit, cssX, cssY);

      if (!textJiv || !selMgr.IsSelectable(textJiv)) {
        selMgr.Set(null, this.Root);
        this._animationManager.Kick();
        return;
      }

      const charIdx = selMgr.CharIndexAt(textJiv, cssX, cssY);
      if (charIdx === null) return;

      const now = performance.now();
      const burstAlive = (now - lastClickAt) < 400
        && Math.hypot(cssX - lastClickX, cssY - lastClickY) < 5;
      clickCount = burstAlive ? clickCount + 1 : 1;
      lastClickAt = now;
      lastClickX = cssX;
      lastClickY = cssY;

      anchorJiv = textJiv;
      anchorChar = charIdx;

      if (clickCount >= 3) {
        granularity = 'line';
        armed = false;
        dragging = true;
        const [s, eIdx] = selMgr.LineCharRangeAt(textJiv, charIdx);
        selMgr.Set({
          AnchorJiv: textJiv, AnchorChar: s,
          ExtentJiv: textJiv, ExtentChar: eIdx,
        }, this.Root);
        this._animationManager.Kick();
      } else if (clickCount === 2) {
        granularity = 'word';
        armed = false;
        dragging = true;
        const [ws, we] = selMgr.WordCharRangeAt(textJiv, charIdx);
        selMgr.Set({
          AnchorJiv: textJiv, AnchorChar: ws,
          ExtentJiv: textJiv, ExtentChar: we,
        }, this.Root);
        this._animationManager.Kick();
      } else {
        granularity = 'char';
        armed = true;
        dragging = false;
        armedX = cssX;
        armedY = cssY;
        if (selMgr.Current) {
          selMgr.Set(null, this.Root);
          this._animationManager.Kick();
        }
      }

      this._capturePointer(e.pointerId);
      e.preventDefault();
    });

    this._on('pointermove', (e: PointerEvent) => {
      if (!anchorJiv) return;
      const rect = this._pageRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;

      // Promote armed → dragging once the pointer travels past slop. This is
      // the point where a bare click becomes a drag-select.
      if (armed && !dragging) {
        if (Math.hypot(cssX - armedX, cssY - armedY) < DRAG_SLOP) return;
        armed = false;
        dragging = true;
      }
      if (!dragging) return;

      // Re-resolve which text Jiv the cursor is over on every tick — selection
      // flows across Jiv boundaries like web selection. When the pointer is
      // off-canvas or over an unselectable region, NearestTextJiv falls back
      // to the closest text Jiv by rect distance.
      const hit = this._scrollManager.HitTopmost(cssX, cssY);
      const extentJiv = selMgr.NearestTextJiv(this.Root, hit, cssX, cssY) ?? anchorJiv;
      const extentChar = selMgr.CharIndexAt(extentJiv, cssX, cssY);
      if (extentChar === null) return;

      let aJiv = anchorJiv, aChar = anchorChar;
      let eJiv = extentJiv, eChar = extentChar;

      if (granularity === 'line') {
        const [as, ae] = selMgr.LineCharRangeAt(anchorJiv, anchorChar);
        const [es, ee] = selMgr.LineCharRangeAt(extentJiv, extentChar);
        if (aJiv === eJiv) {
          aChar = Math.min(as, es);
          eChar = Math.max(ae, ee);
        } else {
          const cmp = selMgr.DocOrder(anchorJiv, extentJiv, this.Root);
          if (cmp <= 0) { aChar = as; eChar = ee; }
          else { aChar = ae; eChar = es; }
        }
      } else if (granularity === 'word') {
        // Snap each endpoint outward to its word's char range so the
        // double-click-and-drag never collapses below one full word.
        const [aws, awe] = selMgr.WordCharRangeAt(anchorJiv, anchorChar);
        const [ews, ewe] = selMgr.WordCharRangeAt(extentJiv, extentChar);
        if (aJiv === eJiv) {
          aChar = Math.min(aws, ews);
          eChar = Math.max(awe, ewe);
        } else {
          const cmp = selMgr.DocOrder(anchorJiv, extentJiv, this.Root);
          if (cmp <= 0) { aChar = aws; eChar = ewe; }
          else { aChar = awe; eChar = ews; }
        }
      }
      // 'char' granularity forwards raw char endpoints.

      selMgr.Set({
        AnchorJiv: aJiv, AnchorChar: aChar,
        ExtentJiv: eJiv, ExtentChar: eChar,
      }, this.Root);
      this._animationManager.Kick();
    });

    const end = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse') return;
      dragging = false;
      armed = false;
      anchorJiv = null;
      if (this._hasCapture(e.pointerId)) {
        this._releasePointer(e.pointerId);
      }
    };
    this._on('pointerup', end);
    this._on('pointercancel', end);
  };

  /** Keyboard shortcuts on the active selection — Cmd/Ctrl+A select-all
   *  within the current text Jiv, Escape clears.
   *
   *  Listens on `window` (canvas isn't focusable by default). We only act
   *  when the active element is the body / canvas — so typing Cmd+A inside
   *  a real <input> on the page still does the native thing. */
  private _listenForSelectionKeys = (): void => {
    const selMgr = this._selectionManager;
    this._platform.AddKeydownListener((e: KeyboardEvent) => {
      if (this._platform.IsTextInputFocused()) return;

      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === 'a' || e.key === 'A')) {
        const first = selMgr.FirstTextJiv(this.Root);
        const last = selMgr.LastTextJiv(this.Root);
        if (first && last) {
          const [, lastChar] = selMgr.FullRange(last);
          selMgr.Set({
            AnchorJiv: first, AnchorChar: 0,
            ExtentJiv: last, ExtentChar: lastChar,
          }, this.Root);
          this._animationManager.Kick();
          e.preventDefault();
        }
      // Cmd/Ctrl+C is handled on the main thread via the native `copy`
      // event (see MainBridge), where the user-gesture activation is still
      // alive. Calling `navigator.clipboard.writeText` from inside the worker
      // silently fails because transient activation doesn't ride across
      // postMessage. The worker mirrors selection text to main on every
      // selection change via the `selection-text` W2M message instead.
      } else if (e.key === 'Escape') {
        if (selMgr.Current) {
          selMgr.Set(null, this.Root);
          this._animationManager.Kick();
          e.preventDefault();
        }
      }
    }, { capture: true });
  };

  /** Wheel + touch/pointer drag — both route through ScrollManager which
   *  handles physics (momentum, rubber-band for drag). Wheel clamps; drag
   *  rubber-bands past bounds. */
  private _listenForScroll = (): void => {
    // ─── Wheel ───
    this._on('wheel', (e: WheelEvent) => {
      // Browser zoom (Ctrl/Cmd + wheel, or pinch-zoom which Chrome delivers
      // as wheel + ctrlKey) is a browser-owned gesture — we must NOT consume
      // it as scroll. Let it bubble to the browser's zoom handler.
      if (e.ctrlKey) return;

      // Route to the topmost Jiv's OnWheel first (z-ordered) so a consumer
      // that binds `(wheel)` — e.g. the drill field — only gets the wheel
      // when it's genuinely on top, never through an overlay/chrome above it.
      // Independent of scroll: scroll containers below still handle their own
      // wheel via ResolveScrollTarget, and non-scroll consumers use OnWheel.
      const wheelHit = this._topmostAt(e.clientX, e.clientY);
      if (wheelHit?.OnWheel) wheelHit.OnWheel(e);

      this._measureScrollContents(this.Root);

      const rect = this._pageRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;

      let dx = e.deltaX, dy = e.deltaY;
      if (e.deltaMode === 1) { dx *= 16; dy *= 16; }

      // Per-axis scroll chaining: a horizontal row (no vertical extent) lets a
      // vertical wheel fall through to the page scroll behind it, and a maxed-
      // out inner list chains to its parent — browser/Apple behavior, instead
      // of the innermost Scroll swallowing the wheel.
      const { xTarget, yTarget } = this._scrollManager.ResolveScrollChain(cssX, cssY, dx, dy);
      if (!xTarget && !yTarget) return;

      if (e.deltaMode === 2) {
        if (xTarget) dx *= xTarget.Width;
        if (yTarget) dy *= yTarget.Height;
      }

      if (xTarget && xTarget === yTarget) {
        this._scrollManager.ApplyDelta(xTarget, dx, dy);
      } else {
        if (xTarget) this._scrollManager.ApplyDelta(xTarget, dx, 0);
        if (yTarget) this._scrollManager.ApplyDelta(yTarget, 0, dy);
      }
      this._animationManager.Kick();
      e.preventDefault();
    }, { passive: false });

    // ─── Pointer drag (touch + trackpad + mouse) ───
    // Only consume drag for touch/pen; mouse drag stays available for selection
    // once we have selection. Track per pointer id so multi-touch doesn't collide.
    interface DragCtx { target: Jiv; lastX: number; lastY: number; lastT: number; }
    const drags = new Map<number, DragCtx>();

    this._on('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return; // reserve mouse-drag for future selection

      this._measureScrollContents(this.Root);
      const rect = this._pageRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const target = this._scrollManager.ResolveScrollTarget(cssX, cssY);
      if (!target) return;

      this._capturePointer(e.pointerId);
      this._scrollManager.DragStart(target);
      drags.set(e.pointerId, { target, lastX: e.clientX, lastY: e.clientY, lastT: performance.now() });
    });

    this._on('pointermove', (e: PointerEvent) => {
      const ctx = drags.get(e.pointerId);
      if (!ctx) return;

      // iOS batches pointermove to ~20Hz during touch — renders run at 60Hz
      // but scroll offset was only updating 3x/frame with the raw event.
      // getCoalescedEvents() recovers the missed samples; we feed each one
      // through DragMove so scroll offset tracks the finger at native rate.
      // Fall back to the single event if the browser doesn't support it.
      const samples: readonly PointerEvent[] =
        typeof e.getCoalescedEvents === 'function'
          ? (e.getCoalescedEvents() as PointerEvent[]) : [];
      const events: readonly PointerEvent[] = samples.length > 0 ? samples : [e];

      for (const sample of events) {
        const now = performance.now();
        const dt = Math.max(1e-3, (now - ctx.lastT) / 1000);
        // Dragging pulls content the opposite direction of finger motion (finger
        // moves up → content scrolls down, same as native).
        const dx = -(sample.clientX - ctx.lastX);
        const dy = -(sample.clientY - ctx.lastY);
        this._scrollManager.DragMove(ctx.target, dx, dy, dt);
        ctx.lastX = sample.clientX;
        ctx.lastY = sample.clientY;
        ctx.lastT = now;
      }
      this._animationManager.Kick();
      // No preventDefault — listener is passive. `touch-action: none` on the
      // canvas (set in the constructor) keeps the browser's native scroll
      // from competing, so we don't need to block it imperatively.
    }, { passive: true });

    const finish = (e: PointerEvent): void => {
      const ctx = drags.get(e.pointerId);
      if (!ctx) return;
      this._scrollManager.DragEnd(ctx.target);
      this._animationManager.Kick();
      drags.delete(e.pointerId);
      if (this._hasCapture(e.pointerId)) {
        this._releasePointer(e.pointerId);
      }
    };
    this._on('pointerup', finish);
    this._on('pointercancel', finish);
  };

  /** Walk the tree, compute ContentWidth/Height for each Overflow:Scroll Jiv from
   *  the bounding box of its children. Cheap; needed for clamping scroll target. */
  private _measureScrollContents = (node: Jiv): void => {
    if (node.Overflow === 'Scroll') {
      let maxRight = 0;
      let maxBottom = 0;
      for (const c of node.Children) {
        // Only Flow children contribute to scroll content size.
        // Placed/Fixed/Sticky are out-of-flow and don't extend the scroll bounds.
        if (c.ChildLayout.Position !== 'Flow' && c.ChildLayout.Position !== 'Offset') continue;
        const right = (c.X - node.X) + c.Width;
        const bottom = (c.Y - node.Y) + c.Height;
        if (right > maxRight) maxRight = right;
        if (bottom > maxBottom) maxBottom = bottom;
      }
      // Add bottom padding so last item doesn't sit flush against the edge
      const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
      const [, padR, padB] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
      node.ContentWidth = maxRight + padR;
      node.ContentHeight = maxBottom + padB;
    }
    for (const c of node.Children as Jiv[]) this._measureScrollContents(c);
  };

  /** Re-rasterize every text node against the current font set. Called
   *  when fonts finish loading after the engine has already rendered —
   *  cached glyph rasters captured with the fallback font are now stale.
   *
   *  A font load is a *re-rasterization* event, not a content/presence
   *  event: the words are the same words, the user already sees them,
   *  only the glyph pixels and metrics need refreshing. So:
   *   - drop cache entries (atlas slots are keyed against the old font)
   *     but keep the atlas texture itself — Text.Cache.Clear no longer
   *     reallocates it, so reads are never serviced from an empty
   *     texture between the wipe and the next rasterize
   *   - keep TextAnimators alive: each word's Opacity spring stays at
   *     its current settled 1.0, no fade-in pop. Resync runs _reflow
   *     against the new metrics so widths/positions catch up
   *   - invalidate node measurements so _measureDirtyText re-runs
   *     (intrinsic widths may shift)
   *   - mark layout dirty so reflow propagates */
  private _invalidateAllText = (): void => {
    this._textCache.Clear();
    let needsKick = false;
    for (const anim of this._textAnimators.values()) {
      if (anim.Resync()) needsKick = true;
    }
    const invalidate = (node: JauiElement): void => {
      node.InvalidateText();
      for (const child of node.Children) invalidate(child);
    };
    invalidate(this.Root);
    this.Root.Dirty |= DirtyFlag.Layout;
    if (needsKick) this._animationManager.Kick();
  };

  /** Listen for fonts that arrive AFTER the first tick — e.g. a lazy
   *  @font-face registered later, or a network-slow Google Font that
   *  resolved fonts.ready optimistically on a different family.
   *  FontFaceSet.loadingdone fires once per batch; that's our cue to
   *  flush stale atlas entries. */
  private _listenForFontLoad = (): void => {
    this._platform.ObserveFontsLoadingDone(() => {
      this._invalidateAllText();
    });
  };

  private _watchDpr = (): void => {
    // matchMedia only fires when the specified dpr condition changes (e.g.
    // on browser zoom). One-shot — when it fires, re-arm at the new dpr.
    this._platform.ObserveDprChange(this._dpr, () => {
      this._resize();
      this._watchDpr();
    });
  };

  /** Parse `?debug` / `#debug` and `?dpr=N` from the URL. Calling this early
   *  in the constructor lets `_resize()` pick up the DPR override on its
   *  first run, and attaches the HUD once the canvas is in the DOM. */
  private _initDebugFromUrl = (): void => {
    const search = this._platform.GetUrlSearch();
    const hash = this._platform.GetUrlHash();
    const params = new URLSearchParams(search);
    const debug = params.has('debug') || hash.includes('debug');

    // `?dpr=N` — explicit user override (clamped to a sane range so a typo
    // doesn't lock the browser with a 50MP backbuffer). null = auto.
    const dprStr = params.get('dpr');
    if (dprStr !== null) {
      const n = Number(dprStr);
      if (Number.isFinite(n) && n > 0 && n <= 4) this._dprOverride = n;
    }

    if (debug) this._enableDebugHud();
    if (params.has('debug-layout') || hash.includes('debug-layout')) this._enableDebugLayout();
    // Console-only frame-phase profiling. `?wkr-jaui-prof` works in the
    // worker (where there's no DOM HUD) and in main-thread Canvas alike;
    // the per-second log dumps Dirty/Layout/Text/Render averages.
    if (params.has('wkr-jaui-prof') || hash.includes('wkr-jaui-prof')) {
      this._consoleProfilingEnabled = true;
    }
    // TEMP perf-isolation toggles (exact-key query params). See field decls.
    if (params.has('no-pblur')) this._diagNoPblur = true;
    if (params.has('no-glass')) this._diagNoGlass = true;
    if (params.has('no-pblur-draw')) this._diagNoPblurDraw = true;
  };

  // ── Debug Layout Overlay ───────────────────────────────────────────────────
  // `?debug-layout` draws a 1px rainbow stroke around every Jiv each frame.
  // Useful for eyeballing layout issues (wrong size, missing padding, etc).
  // Rendered into a 2D canvas layered on top of Jaui's canvas — lets the
  // main render path stay untouched.

  private _debugLayout: boolean = false;
  private _debugLayoutCanvas: HTMLCanvasElement | null = null;
  private _debugLayoutCtx: CanvasRenderingContext2D | null = null;

  private _enableDebugLayout = (): void => {
    if (this._debugLayout || typeof document === 'undefined') return;
    this._debugLayout = true;
    const overlay = document.createElement('canvas');
    overlay.style.cssText = [
      'position:absolute',
      'top:0', 'left:0',
      'width:100%', 'height:100%',
      'pointer-events:none',
      'z-index:2147483646',
    ].join(';');
    const host = this.Element.parentElement;
    if (host) {
      const cs = getComputedStyle(host);
      if (cs.position === 'static') host.style.position = 'relative';
      host.appendChild(overlay);
    }
    this._debugLayoutCanvas = overlay;
    this._debugLayoutCtx = overlay.getContext('2d');
  };

  private _drawDebugLayout = (): void => {
    const canvas = this._debugLayoutCanvas;
    const ctx = this._debugLayoutCtx;
    if (!canvas || !ctx) return;
    const dpr = this._dpr;
    const rect = this._pageRect();
    const pw = Math.max(1, Math.round(rect.width * dpr));
    const ph = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineWidth = 1;

    // Collect every Jiv + absolute position in a single tree walk.
    const hits: Array<{ x: number; y: number; w: number; h: number }> = [];
    // node.X / node.Y are ABSOLUTE post-layout (JivAnimator writes result.X/Y
    // directly). Only thing accumulated down the tree is scroll-offset
    // corrections from ancestors with Overflow: Scroll — matches the
    // render walk's `offsetX` semantics.
    const walk = (node: Jiv, sx: number, sy: number): void => {
      if (!node.Visible) return;
      const vx = node.X + sx;
      const vy = node.Y + sy;
      hits.push({ x: vx, y: vy, w: node.Width, h: node.Height });
      const childSx = node.Overflow === 'Scroll' ? sx - node.ScrollX : sx;
      const childSy = node.Overflow === 'Scroll' ? sy - node.ScrollY : sy;
      for (const c of node.Children) walk(c as Jiv, childSx, childSy);
    };
    walk(this.Root, 0, 0);

    const total = Math.max(1, hits.length);
    for (let i = 0; i < hits.length; i++) {
      const { x, y, w, h } = hits[i];
      const hue = Math.round((i * 360) / total);
      ctx.strokeStyle = `hsl(${hue}, 100%, 60%)`;
      // Zero-sized nodes (text jivs before their first measurement, or
      // collapsed containers) still draw a tiny crosshair so you can see
      // they exist in the tree.
      if (w < 1 || h < 1) {
        ctx.beginPath();
        ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y);
        ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
        ctx.stroke();
      } else {
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      }
    }
  };

  // GL call counting removed — WebGPU uses timestamp queries for profiling.

  /** Build the HUD overlay. Fixed-position, monospace, semi-transparent; pointer-
   *  events disabled so it never intercepts scroll/hover. Appended to body so
   *  it survives canvas re-parenting and doesn't need special CSS from hosts. */
  private _enableDebugHud = (): void => {
    if (this._debugHud || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:2147483647',
      'padding:4px 8px',
      'background:rgba(0,0,0,0.6)',
      'color:#0f0',
      'font:12px/1.3 ui-monospace,Menlo,Consolas,monospace',
      'pointer-events:none',
      'white-space:pre',
      'border-radius:4px',
    ].join(';');
    el.textContent = 'FPS --';
    const attach = (): void => { document.body.appendChild(el); };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
    this._debugHud = el;
  };

  /** Called from `_tick` with the current rAF timestamp. Writes the delta into
   *  the rolling buffer, then (throttled) updates the HUD textContent. Keeps
   *  the hot path allocation-free — the template literal produces one string
   *  per DOM write, not per frame. */
  private _updateHud = (time: number): void => {
    if (!this._debugHud) return;

    // _lastTime is 0 on the very first frame (set by Start); skip it so we
    // don't feed a huge bogus delta into the window.
    if (this._lastTime === 0) return;
    const dtMs = time - this._lastTime;

    const buf = this._hudDeltas;
    buf[this._hudIdx] = dtMs;
    this._hudIdx = (this._hudIdx + 1) % buf.length;
    if (this._hudCount < buf.length) this._hudCount++;

    // Throttle DOM writes to ~10Hz. Every frame would make the HUD itself
    // a measurable cost on low-power devices.
    if (time - this._hudLastWrite < 100) return;
    this._hudLastWrite = time;

    let sum = 0, min = Infinity, max = 0;
    for (let i = 0; i < this._hudCount; i++) {
      const v = buf[i];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const avg = sum / Math.max(1, this._hudCount);
    const fps = avg > 0 ? 1000 / avg : 0;
    const w = this._width;
    const h = this._height;

    const avgPhase = (arr: Float32Array): number => {
      if (this._frameCount === 0) return 0;
      let s = 0;
      for (let i = 0; i < this._frameCount; i++) s += arr[i];
      return s / this._frameCount;
    };
    const pDirty  = avgPhase(this._phaseDirty);
    const pLayout = avgPhase(this._phaseLayout);
    const pText   = avgPhase(this._phaseText);
    const pRender = avgPhase(this._phaseRender);
    const c = this._countsRolling;

    // GPU time — averaged over whatever readings we have. Null when the
    // backend doesn't implement it (WebGPU today) or the extension isn't
    // available on this driver — show "—" so the HUD doesn't lie with 0.
    let gpuDisplay = '—';
    if (this._phaseGpuCount > 0) {
      const n = Math.min(this._phaseGpuCount, this._phaseGpu.length);
      let gs = 0;
      for (let i = 0; i < n; i++) gs += this._phaseGpu[i];
      gpuDisplay = (gs / n).toFixed(2);
    }

    const hudText =
      `FPS ${fps.toFixed(1)} | ms ${avg.toFixed(1)} (min ${min === Infinity ? 0 : min.toFixed(1)} max ${max.toFixed(1)}) | dpr ${this._dpr} | ${w}x${h}\n` +
      `cpu: dirty ${pDirty.toFixed(2)}  layout ${pLayout.toFixed(2)}  text ${pText.toFixed(2)}  render ${pRender.toFixed(2)} | gpu ${gpuDisplay} ms\n` +
      `draws — panels ${c.Panels}  glass ${c.Glass}  text ${c.Text}  img ${c.Image}  pblur ${c.PBlur}`;
    this._debugHud.textContent = hudText;
    this._debugLatest = hudText;

    // Console mirror disabled while diagnosing cold-load — the per-second
    // dump drowns out BootProfiler / instrumentation lines. The on-screen
    // HUD still updates 10×/s; `__jaui.canvas.DebugText` getter is the
    // copy-paste escape hatch.
    void this._debugLogLast;
  };

  /** Current HUD text as a single string. Set when `?debug` is active and
   *  the HUD updates (~10Hz). Safe to read anytime from the console. */
  get DebugText(): string | null { return this._debugLatest; }
  private _debugLatest: string | null = null;
  private _debugLogLast: number = 0;

  /** Walks the tree, runs each Janvas's foreign renderer at its layout rect.
   *  Called once per frame, between BeginScenePass and the panel pass, so
   *  foreign content lands in the scene FBO and gets composited under any
   *  panels Jaui draws on top.
   *
   *  WebGL viewport coordinates are bottom-left origin; Element coords are
   *  top-left. We flip Y here so the foreign renderer can think in normal
   *  screen-space without learning Jaui's quirks. */
  private _renderJanvases(
    gl: WebGL2RenderingContext,
    node: JauiElement,
    offsetX: number,
    offsetY: number,
    canvasW: number,
    canvasH: number,
    dt: number,
    /** Active rounded clip (device px, top-left). When set, the foreign
     *  renderer's writes are stencil-clipped to this shape — letting the
     *  janvas honour its ancestor's `Overflow:Hidden` + `BorderRadius`,
     *  same as Jaui's own panel pass already does for jivs. */
    clip: { x: number; y: number; w: number; h: number; radius: number; smoothness: number } | null,
  ): void {
    if (node instanceof Janvas) {
      const renderer = node.Renderer;
      if (renderer && node.Width > 0 && node.Height > 0 && node.Visible) {
        if (!node.IsInited()) {
          renderer.Init(gl, node.MarkDirty);
          node.MarkInited();
        }
        const d = this._dpr;
        const px = Math.round((node.X + offsetX) * d);
        const py = Math.round((node.Y + offsetY) * d);
        const pw = Math.round(node.Width * d);
        const ph = Math.round(node.Height * d);
        const yFromBottom = canvasH - py - ph;
        gl.viewport(px, yFromBottom, pw, ph);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(px, yFromBottom, pw, ph);

        const r = this._renderer as WebGL2Renderer;
        const fbo = r.GetSceneFramebuffer();
        renderer.Render(gl, fbo, { X: px, Y: yFromBottom, Width: pw, Height: ph }, dt);
        node.ClearDirty();

        // Defer the visual clip mask to the end of the frame. Wiping scene
        // FBO pixels here destroys data that in-tree consumers need: a
        // descendant pblur (e.g. HeroLeftBlur over a fullscreen Reality
        // janvas) snapshots the scene to build its blur pyramid; if the
        // wipe ran first, the rounded-corner regions sample as transparent
        // black, smearing darkness into the blur. We queue (drawRect,
        // clipRect, radius) and apply them after the panel pass — visual
        // clipping for the presented frame, intact source for sampling.
        if (clip) {
          this._pendingJanvasMasks.push({
            drawX: px, drawY: py, drawW: pw, drawH: ph,
            clipX: clip.x, clipY: clip.y, clipW: clip.w, clipH: clip.h,
            radius: clip.radius, smoothness: clip.smoothness,
          });
        }
      }
    }

    // Update active clip for descendants if this node is a clipping container.
    let childClip = clip;
    if (node instanceof Jiv) {
      const overflow = node.Overflow;
      if ((overflow === 'Hidden' || overflow === 'Scroll') && node.Width > 0 && node.Height > 0) {
        const d = this._dpr;
        const px = Math.round((node.X + offsetX) * d);
        const py = Math.round((node.Y + offsetY) * d);
        const pw = Math.round(node.Width * d);
        const ph = Math.round(node.Height * d);
        const radii = node.RenderStyle?.BorderRadius;
        const r0 = radii ? radii[0] : 0;
        const smoothness = node.RenderStyle?.BorderRadiusSmoothness ?? 0;
        childClip = { x: px, y: py, w: pw, h: ph, radius: r0 * d, smoothness };
      }
    }

    for (const child of node.Children) {
      this._renderJanvases(gl, child, node.X + offsetX, node.Y + offsetY, canvasW, canvasH, dt, childClip);
    }
  }
}

/**
 * Jaui — top-level app instance. Thin facade over `Canvas` that owns the
 * renderer creation and exposes the user-facing surface as a single
 * cohesive thing: `new Jaui(el)` instead of `new Canvas(el, new WebGL2Renderer())`.
 *
 * Use this for app-level concerns (start/stop, JSS vars, image loads).
 * For low-level primitives (instance buffers, scroll manager, dirty flags)
 * reach the underlying `Canvas` via `.Canvas`.
 */
export class Jaui {
  /** The underlying canvas — exposed for low-level access. */
  readonly Canvas: Canvas;

  /** Shortcut for `Canvas.Root` — what `<jiv>` uses as a fallback parent. */
  get Root(): Jiv { return this.Canvas.Root; }

  /** Image cache — load images/SVGs here, reference them from Jivs. */
  get Images(): ImageCache { return this.Canvas.Images; }

  /**
   * @param canvasEl  HTMLCanvasElement to render into.
   * @param opts.renderer  Optional renderer override; defaults to a fresh
   *                       WebGL2Renderer (sync init, safe for descendants
   *                       that read `Root` in their own ngOnInit).
   */
  constructor(canvasEl: HTMLCanvasElement, opts?: { renderer?: Renderer; platform?: Platform }) {
    const r = opts?.renderer ?? new WebGL2Renderer();
    void r.Init(canvasEl);
    this.Canvas = new Canvas(canvasEl, r, opts?.platform ?? BrowserPlatform);
  }

  /** Start the render loop (rAF). */
  Start(): void { this.Canvas.Start(); }

  /** Push the active JSS var table into the canvas — called by the Angular
   *  layer whenever the JssRegistry version bumps. */
  SetJssVars(vars: Map<string, string>): void { this.Canvas.SetJssVars(vars); }
}

// Walks the hit ancestor chain. Disabled stops the walk and forces default
// (so a disabled button kills its own pointer cursor); otherwise the first
// non-Default Cursor wins, mimicking CSS cursor inheritance so children of
// a button automatically pick up the button's pointer.
//
// Fallback: if no explicit Cursor is set anywhere in the chain AND the hit
// Jiv carries text, return the I-beam — text content reads as selectable by
// default. Any ancestor with an explicit Cursor (e.g. Pointer on a link)
// still wins via the loop above.
const _resolveCursor = (hit: Jiv | null): string => {
  for (let n: Jiv | null = hit; n; n = n.Parent as Jiv | null) {
    if (n.Disabled) return '';
    if (n.Cursor !== 'Default') return _CURSOR_CSS[n.Cursor];
  }
  if (hit && hit.Text !== null) return _CURSOR_CSS.Text;
  return '';
};

const _CURSOR_CSS: Record<'Default' | 'Pointer' | 'Text' | 'Move' | 'None', string> = {
  Default: '',
  Pointer: 'pointer',
  Text: 'text',
  Move: 'move',
  None: 'none',
};

// ─── Re-exports by slice ───

export { Janvas } from '../Janvas/Janvas';
export type { JanvasRenderer, JanvasRect } from '../Janvas/Janvas.Renderer';

export { Jath } from './Jath';
export { Jiv } from '../Jiv/Jiv';

// Core
export type { Vec2, Vec4, Rect, Color, DeviceTier, DirtyFlags } from './Types';
export { DirtyFlag } from './Types';
export type { Renderer } from './Renderer';
// Renderers are exported directly — callers pick the one they want and
// hand it to `new Canvas(el, renderer)`. No auto-pick factory: the choice
// between WebGL2 (sync) and WebGPU (async) is the caller's to make.
export { WebGL2Renderer } from './WebGL2.Renderer';
export { WebGPURenderer } from './WebGPU.Renderer';

// Jiv
export type { JivStyle, CornerShape, BlendMode, MaterialType, ProgressiveBlurDirection, BackgroundValue, GradientStop } from '../Jiv/Jiv.Types';
export type { FitMode } from '../Element/Element';
export { DefaultJivStyle } from '../Jiv/Jiv.Defaults';

// Glass presets
export { LiquidGlass, ClearGlass } from '../Glass/Glass.Presets';

// Layout
export type {
  LayoutMode, FlexDirection, FlexWrap, JustifyContent, AlignItems, AlignContent,
  PositionMode, Overflow, LayoutConfig, ChildLayout, LayoutResult,
  GridConfig, GridTrack,
} from '../Layout/Layout.Types';
export { DefaultLayoutConfig, DefaultChildLayout } from '../Layout/Layout.Types';
export { SolveFlex, type FlexContainer, type FlexChild } from '../Layout/Layout.Flex';
export { ResolveLengthTuple4 } from '../Core/Length.Tuple';
export { SolveLayout } from '../Layout/Layout.Solver';
export { ComputeIntrinsicSizes } from '../Layout/Layout.Intrinsic';

// Transform
export type { Transform } from '../Transform/Transform.Types';

// Text
export type { TextStyle, TextAlign, TextOverflow, FontStyle, TextMeasurement, TextConfig } from '../Text/Text.Types';
export { DefaultTextStyle } from '../Text/Text.Types';
export { MeasureText } from '../Text/Text.Measure';
export { HashTextKey } from '../Text/Text.Hash';
export { TextCache } from '../Text/Text.Cache';

// Image
export type { ImageStyle, ObjectFit } from '../Image/Image.Types';
export { ImageCache, RecolorSvg, type ImageEntry } from '../Image/Image.Cache';

// Scroll
export type { ScrollConfig } from '../Scroll/Scroll.Types';

// Animation
export type {
  SpringConfig,
  TransitionConfig,
  AnimationDefinition,
  AnimationApplication,
  AnimationStop,
  LoopMode,
} from '../Animation/Animation.Types';
export { AnimationManager } from '../Animation/Animation.Manager';
export { JivAnimator } from '../Jiv/Jiv.Animator';
export { Spring } from '../Animation/Spring';
export { JivAnimationDriver } from '../Animation/Animation.Driver';

// Accessibility
export type { AccessibilityConfig } from '../Accessibility/Accessibility.Types';

// JSS
export { ParseJss } from '../Jss/Jss.Parser';
export type { Stylesheet, Ruleset, ParsedJss, VarTable, AnimationTable, PredicateExpr, PredicateStyle } from '../Jss/Jss.Parser';
export { EvaluatePredicate } from '../Jss/Jss.Predicate';
export { SlotFor, type Slot } from '../Jss/Jss.Routes';

// Worker boot — apps call CheckBrowserSupport() before mounting Angular.
export { CheckBrowserSupport, type BrowserSupportResult } from '../Worker/Browser.Support';
export { MainBridge, RootId, type BridgeOptions, type JivHitHandlers } from '../Worker/Bridge.Main';
export { JivHandle } from '../Worker/Jiv.Handle';
export { CanvasProxy } from '../Worker/Canvas.Proxy';
export { SpawnJauiWorker } from '../Worker/Worker.Spawn';
export { BootJauiWorker } from '../Worker/Worker.Boot';
export {
  RegisterJanvasRenderer,
  LookupJanvasRenderer,
  type JanvasRendererFactory,
} from '../Worker/Worker.RendererRegistry';
export type { JanvasFactoryContext } from '../Janvas/Janvas.Renderer';
export type { JivApplyOpts, JivOp, M2W, W2M, PointerPayload, WheelPayload } from '../Worker/Bridge.Types';
