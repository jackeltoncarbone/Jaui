/**
 * Bridge.Main — main-thread side of the worker bridge.
 *
 * Responsibilities:
 *   • Spawn the Jaui worker.
 *   • `transferControlToOffscreen()` and post the init message.
 *   • Capture DOM events on the proxy canvas element and forward them.
 *   • Maintain the `JivHandle` registry and batch-flush ops once per
 *     microtask (Angular CD ends, microtask runs, ops post in one batch).
 *   • Apply W2M outputs: cursor + setPointerCapture on the proxy element,
 *     hit events to Angular Jiv host elements, rect snapshots to handles.
 *
 * This module is the only main-thread code that knows about postMessage.
 * Angular `<jaui>` / `<jiv>` components hold a JivHandle and read/write
 * its bridge-routed properties; they never see message types.
 */

import { JTrace } from '../Diagnostics/Jaui.Trace';
import type {
  M2W,
  W2M,
  W2M_Cursor,
  W2M_PointerCapture,
  W2M_HitEvent,
  W2M_RectSnapshot,
  ScrollExtent,
  W2M_Ready,
  JivOp,
  PointerPayload,
  WheelPayload,
  KeyPayload,
} from './Bridge.Types';
import { ContextWatchdog } from './Context.Watchdog';
import type { ProbeSnapshot } from '../Probe/Probe.Types';
import { EmbedLayer, IsInsideEmbed } from '../Embed/Embed.Layer';
import type { EmbedBox } from '../Embed/Embed.Geometry';

const ROOT_ID = 0;

const _DEBUG: boolean =
  typeof window !== 'undefined' &&
  typeof window.location !== 'undefined' &&
  /[?&](debug|jdebug)\b/.test(window.location.search);

/** True when the currently focused element is a real text input, so the
 *  native browser clipboard handlers should take precedence over Jaui's
 *  display-text mirror (e.g. Jinput's hidden `<textarea>`, plain `<input>` /
 *  `<textarea>` outside the canvas, contenteditable surfaces).
 *
 *  A DOM EMBED counts. An embed is real DOM the person is interacting with
 *  directly, and a cross-origin one (Stripe's card fields) reports its own
 *  `<iframe>` element as `activeElement` — a tag this test would otherwise
 *  miss, so Jaui would have kept hijacking Ctrl+C and firing its own
 *  selection shortcuts while someone typed a card number. */
const _isNativeTextInputFocused = (): boolean => {
  if (typeof document === 'undefined') return false;
  const ae = document.activeElement as HTMLElement | null;
  if (!ae) return false;
  const tag = ae.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (ae.isContentEditable) return true;
  return IsInsideEmbed(ae);
};

export interface BridgeOptions {
  /** Canvas DOM element that Angular created. The bridge transfers it
   *  to the worker (one-way) and keeps the element only as an event
   *  capture target. */
  Canvas: HTMLCanvasElement;
  /** Pre-spawned Worker. The bridge does NOT spawn the worker itself: the static-URL
   *  `new Worker(new URL(...), { type: 'module' })` call has to sit in the consumer's own source for
   *  its bundler to detect the entry and emit the chunk, and only the consumer knows which worker
   *  entry — which set of janvas renderers — it wants. Show Studio's is in `src/App.ts`.
   *
   *  It may have been spawned long before this bridge existed — from the document head, before the
   *  app bundle ran. See `_adoptEarlySpawn` for what that costs and how it is settled.
   *
   *  NULL under server rendering. There is no GPU to draw with and no
   *  OffscreenCanvas to transfer, so the bridge runs as a pure op SINK: it
   *  hands out ids and accepts everything `<jiv>` enqueues, and posts none of
   *  it. That is what lets the component tree — and therefore the semantic
   *  mirror the crawler reads — build exactly as it does in the browser. */
  Worker: Worker | null;
  /** Self-heal callback for the eviction watchdog — invoked when the worker is
   *  unrecoverable (iOS killed the whole background tab's worker, so it can't recover
   *  in place and will never post `context-restored`). Defaults to `location.reload()`. */
  Reload?: () => void;
}

/** Hit-handler functions that Angular `<jiv>` registers per Jiv id. */
export interface JivHitHandlers {
  OnClick?: () => void;
  OnContextMenu?: (src: PointerPayload) => void;
  OnPointerDown?: (src: PointerPayload) => void;
  OnPointerMove?: (src: PointerPayload) => void;
  OnPointerUp?: (src: PointerPayload) => void;
  /** Wheel over this Jiv when it's the topmost hit. Source carries the
   *  delta fields (WheelPayload) so main can rebuild a faithful WheelEvent. */
  OnWheel?: (src: WheelPayload) => void;
  /** Called when the worker posts a fresh rect snapshot for this node.
   *  Set on Handles that have subscribed via `WatchRect(true)`. The box
   *  carries the clipped-visible rect, accumulated opacity and corner radii
   *  as well, which is what `<jembed>` places its DOM element from. */
  OnRectSnapshot?: (rect: EmbedBox, scroll: ScrollExtent | null) => void;
}

export class MainBridge {
  readonly Canvas: HTMLCanvasElement;
  readonly Worker: Worker | null;

  /** Resolved when the worker posts {T:'ready'}. Components await this
   *  before relying on roundtrip results (rect snapshots, hit events). */
  readonly Ready: Promise<void>;

  private _readyResolve: (() => void) | null = null;

  /** Buffered Jiv ops, flushed via queueMicrotask after the first enqueue
   *  of a CD pass. One postMessage per CD batch. */
  private _opQueue: JivOp[] = [];
  private _flushScheduled = false;

  /** Per-Jiv hit handlers — populated by Angular `<jiv>` components. */
  private _hitHandlers = new Map<number, JivHitHandlers>();

  /** Monotonic id allocator. ID 0 is reserved for the worker-side
   *  Canvas.Root; allocations start at 1. */
  private _nextId = 1;

  /** True after worker posts {T:'ready'}. Until then, events queue locally
   *  and flush after ready (avoid dropping a fast first-click). */
  private _ready = false;
  private _eventBacklog: M2W[] = [];

  /** Main-thread eviction self-heal — see Context.Watchdog. */
  private readonly _watchdog: ContextWatchdog;

  /** The DOM overlay above the canvas — the one place real DOM (an iframe, a
   *  `<video>`, a map) can live on a canvas app. Created lazily, so an app
   *  with no `<jembed>` never adds an element to the page. `<jaui>` calls
   *  `Embeds.Attach(host)` so the layer lands beside the canvas. */
  readonly Embeds = new EmbedLayer();

  constructor(opts: BridgeOptions) {
    this.Canvas = opts.Canvas;
    this.Worker = opts.Worker;

    // ── Eviction self-heal ── The worker recovers a lost GL context in place; this only
    // fires the reload when the worker itself is gone (it can't ping back / never restores).
    // TEMPORARILY DISABLED: auto-reload masks a real crash we're debugging. Flip back to true.
    const _WatchdogEnabled = false;
    this._watchdog = new ContextWatchdog({
      PostPing: () => this.PostMessage({ T: 'ping' }),
      Reload: opts.Reload ?? (() => {
        if (!_WatchdogEnabled) { console.warn('[Jaui.MainBridge] watchdog reload suppressed (disabled for debugging)'); return; }
        if (typeof location !== 'undefined') location.reload();
      }),
    });
    const onVisible = (): void => {
      if (!_WatchdogEnabled) return;
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this._watchdog.OnVisible();
    };
    if (_WatchdogEnabled && typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    if (_WatchdogEnabled && typeof window !== 'undefined') window.addEventListener('pageshow', onVisible);

    if (_DEBUG) console.log('[Jaui.MainBridge] constructed; canvas=', this.Canvas, 'worker=', this.Worker);

    this.Ready = new Promise<void>(r => { this._readyResolve = r; });

    // Workerless (server) bridge: nothing to listen to, no canvas to transfer, and no window
    // to wire pointer events from. Construction ends here, with the id allocator and the op
    // queue live — which is the entire surface `<jiv>` touches at construction time.
    if (!this.Worker) return;

    this.Worker.addEventListener('message', (e: MessageEvent) => this._onMessage(e.data));
    this.Worker.addEventListener('error', (e: ErrorEvent) => {
      console.error('[Jaui.MainBridge] worker error:', e.message, e.error, 'filename:', e.filename, 'line:', e.lineno);
    });
    this.Worker.addEventListener('messageerror', (e: MessageEvent) => {
      console.error('[Jaui.MainBridge] worker messageerror:', e);
    });

    // Immediately after the listener above and before anything can yield — see `_adoptEarlySpawn`.
    this._adoptEarlySpawn();

    this._wireDomEvents();
    this._sendInit();
  }

  /**
   * Take over from whoever was listening to the worker before this bridge existed.
   *
   * A host may start the render worker from the document head rather than from its component tree —
   * Show Studio does, in `public/early-boot.js`, so the worker's module parse, GL context and shader
   * batch all overlap Angular's bootstrap instead of queueing behind it. That leaves a window of
   * ~200ms in which the worker is live and this class is not, and a worker's `postMessage` does NOT
   * queue on the main side for a listener that has not been added yet: it is dispatched to whoever is
   * listening and otherwise gone. The render worker says nothing before `init`, but "nothing" includes
   * its console relay and its `error` event — which is precisely how a worker whose module failed to
   * parse would have failed invisibly, with no bridge, no `ready` and nothing in the console.
   *
   * So the early spawner holds its own listeners and hands over what it heard. This replays the
   * messages through the ordinary path, reports the errors, and takes those listeners off so they do
   * not sit on the hot message path for the life of the page.
   *
   * There is no task boundary between the `addEventListener` in the constructor and this call, so no
   * message can land in the seam and be delivered twice.
   */
  private _adoptEarlySpawn = (): void => {
    const worker = this.Worker as (Worker & { __JauiEarlyDrain?: (() => { Messages: unknown[]; Errors: string[] }) | undefined });
    const drain = worker.__JauiEarlyDrain;
    if (!drain) return;
    worker.__JauiEarlyDrain = undefined;
    const heard = drain();
    for (const error of heard.Errors) {
      console.error('[Jaui.MainBridge] worker error before the bridge existed:', error);
    }
    if (heard.Messages.length > 0) JTrace(`worker:early-messages n=${heard.Messages.length}`);
    for (const message of heard.Messages) this._onMessage(message);
  };

  /** Allocate a fresh worker-side id. The Angular Jiv component calls this
   *  once at construction and stashes the id on its handle. */
  AllocateId = (): number => this._nextId++;

  /** Register / unregister hit handlers for a Jiv. The bridge looks them
   *  up when a W2M_HitEvent arrives. */
  SetHitHandlers = (id: number, handlers: JivHitHandlers): void => {
    this._hitHandlers.set(id, handlers);
  };
  ClearHitHandlers = (id: number): void => {
    this._hitHandlers.delete(id);
  };

  /** Buffer a Jiv op. The first call this microtask schedules the flush. */
  Enqueue = (op: JivOp): void => {
    this._opQueue.push(op);
    if (!this._flushScheduled) {
      this._flushScheduled = true;
      queueMicrotask(() => this._flushOps());
    }
  };

  /** Post a non-Jiv message immediately (events, resize, JSS vars, etc.).
   *  Backlogs until the worker posts ready. Optional `transfer` hands
   *  Transferables (ImageBitmap, ArrayBuffer) to the worker zero-copy. */
  private _pendingCapture: ((b: Blob | null) => void) | null = null;
  /** Debug/screenshot: request a PNG capture of the next worker-rendered frame. */
  Capture = (): Promise<Blob | null> => {
    return new Promise(resolve => {
      this._pendingCapture = resolve;
      this.PostMessage({ T: 'capture' });
    });
  };

  private _probeNonce = 0;
  private _pendingProbes = new Map<number, (snapshot: ProbeSnapshot | null) => void>();
  /** Dev-only: the worker's laid-out tree. Callers gate on their own dev flag. */
  ProbeLayout = (): Promise<ProbeSnapshot | null> => new Promise(resolve => {
    const nonce = ++this._probeNonce;
    this._pendingProbes.set(nonce, resolve);
    this.PostMessage({ T: 'probe-layout', Nonce: nonce });
  });

  PostMessage = (msg: M2W, transfer?: Transferable[]): void => {
    // Workerless (server) bridge: DROP, don't backlog. The backlog exists to replay into a
    // worker that is still booting; with no worker ever arriving it would instead accumulate
    // every op every Jiv enqueues for the whole render and free none of it.
    const worker = this.Worker;
    if (!worker) return;
    if (!this._ready) {
      this._eventBacklog.push(msg);
      return;
    }
    try {
      if (transfer && transfer.length > 0) {
        worker.postMessage(msg, transfer);
      } else {
        worker.postMessage(msg);
      }
    } catch (err) {
      const t = (msg as { T: string }).T;
      const shape = _describeShape(msg);
      console.error(`[Jaui.MainBridge] postMessage FAILED for T=${t}\n${JSON.stringify(shape, null, 2)}`, { msg, err });
    }
  };

  /** Push state to a Janvas's worker-side renderer by named channel. Goes
   *  out as a top-level `M2W_JanvasInput` so hot data doesn't wait for
   *  the next jiv-ops flush. Used by show-studio Reality services. */
  PostJanvasInput = (jivId: number, channel: string, payload: unknown,
                     transfer?: Transferable[]): void => {
    this.PostMessage(
      { T: 'janvas-input', JivId: jivId, Channel: channel, Payload: payload },
      transfer,
    );
  };

  // ─── Internals ─────────────────────────────────────────────────────────

  private _flushOps = (): void => {
    this._flushScheduled = false;
    if (this._opQueue.length === 0) return;
    const ops = this._opQueue;
    this._opQueue = [];
    this.PostMessage({ T: 'jiv-ops', Ops: ops });
  };

  private _sendInit = (): void => {
    // Only reached with a worker — the constructor returns before wiring when there is none.
    const worker = this.Worker;
    if (!worker) return;
    // Page-rect for initial size — saves the first ResizeObserver round-trip.
    const rect = this.Canvas.getBoundingClientRect();
    const offscreen = this.Canvas.transferControlToOffscreen();
    const dpr = window.devicePixelRatio || 1;
    const isCoarse = !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

    this._lastPostedSize = { W: Math.round(rect.width), H: Math.round(rect.height) };
    JTrace(`worker:init-posted ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    worker.postMessage(
      {
        T: 'init',
        Canvas: offscreen,
        Width: rect.width, Height: rect.height,
        DevicePixelRatio: dpr,
        IsPointerCoarse: isCoarse,
        UrlSearch: window.location.search,
        UrlHash: window.location.hash,
        FontsAlreadyReady: !!(document.fonts && (document.fonts as { status?: string }).status === 'loaded'),
      },
      [offscreen as unknown as Transferable],
    );
    // Start looking for the real size NOW, not after ready: the poll's settle frames run while the
    // worker compiles shaders instead of after it.
    this._settleSize();
  };

  private _onMessage = (msg: unknown): void => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as W2M;
    // Worker-forwarded console lines — re-emit through main's console so
    // the on-screen overlay (?debug=console) catches them. Wrapped in a
    // guard because the W2M union doesn't list this T (it's an out-of-band
    // dev channel — production builds can strip it).
    if ((m as { T: string }).T === 'console') {
      if (!_DEBUG) return;
      const c = m as unknown as { Level: string; Args: unknown[] };
      const fn = (console as unknown as Record<string, (...args: unknown[]) => void>)[c.Level] || console.log;
      try { fn.call(console, '[worker]', ...c.Args); } catch { /* ignore */ }
      return;
    }
    switch (m.T) {
      case 'ready':         return this._onReady(m);
      case 'cursor':        return this._onCursor(m);
      case 'capture':       return this._onCapture(m);
      case 'capture-result': this._pendingCapture?.(m.Blob); this._pendingCapture = null; return;
      case 'probe-layout-result': this._pendingProbes.get(m.Nonce)?.(m.Snapshot); this._pendingProbes.delete(m.Nonce); return;
      case 'hit':           return this._onHit(m);
      case 'rect':          return this._onRect(m);
      case 'hud':           return; // HUD relocation lands in P1g; no-op for now.
      case 'svg-rerasterize': return;
      case 'janvas-event':  return this._onJanvasEvent(m);
      case 'fps':           return this._onFps(m);
      case 'selection-text': this._selectedText = m.Text; return;
      case 'pong':              return this._watchdog.OnPong();
      case 'context-lost':      return this._watchdog.OnContextLost();
      case 'context-restored':  return this._watchdog.OnContextRestored();
    }
  };

  /** Latest plaintext mirror of the worker's selection. Updated whenever
   *  the worker posts a `selection-text` message. Read synchronously inside
   *  the native `copy`/`cut` handlers so the clipboard write rides the
   *  user-gesture activation that doesn't survive a postMessage round-trip. */
  private _selectedText: string = '';

  /** Subscribers for worker-side FPS samples. Powers the `?fps` overlay's
   *  worker-FPS line — main rAF can run at the display refresh rate even
   *  when the worker stalls, so the overlay needs the worker number to
   *  reflect perceived smoothness. */
  private _fpsHandlers = new Set<(avg: number, min: number) => void>();

  /** Register a callback fired each time the worker emits a FPS sample
   *  (~4× per second). Returns an unsubscriber. */
  OnWorkerFps = (handler: (avg: number, min: number) => void): () => void => {
    this._fpsHandlers.add(handler);
    return () => { this._fpsHandlers.delete(handler); };
  };

  private _onFps = (m: { Avg: number; Min: number }): void => {
    for (const h of this._fpsHandlers) h(m.Avg, m.Min);
    // Out-of-band channel for the standalone `?fps` overlay (which runs
    // before Angular boot and doesn't hold a Jaui handle). Listeners
    // wire up with `window.addEventListener('jaui-worker-fps', ...)`.
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      try {
        window.dispatchEvent(new CustomEvent('jaui-worker-fps', {
          detail: { avg: m.Avg, min: m.Min },
        }));
      } catch { /* ignore */ }
    }
  };

  /** Subscribers for `janvas-event` payloads. Keyed by JivId; a single
   *  consumer per Janvas matches the typical 1:1 main-side service pairing. */
  // MULTIPLE handlers per jiv. A Map<jivId, single handler> silently clobbered
  // one listener with the next (a drill page's drill-status handler lost to a
  // later registration, freezing its DurationSec at 0:00). Each registration
  // is now additive and its unsubscriber removes only itself.
  private _janvasEventHandlers = new Map<number, Set<(channel: string, payload: unknown) => void>>();

  /** Register a handler for events posted by the Janvas's worker-side
   *  renderer at `jivId`. Returns an unsubscriber. Called by show-studio
   *  Reality service to receive selection / loaded / etc. events. */
  OnJanvasEvent = (jivId: number, handler: (channel: string, payload: unknown) => void): () => void => {
    let set = this._janvasEventHandlers.get(jivId);
    if (!set) { set = new Set(); this._janvasEventHandlers.set(jivId, set); }
    set.add(handler);
    return () => {
      const cur = this._janvasEventHandlers.get(jivId);
      if (!cur) return;
      cur.delete(handler);
      if (cur.size === 0) this._janvasEventHandlers.delete(jivId);
    };
  };

  private _onJanvasEvent = (m: { JivId: number; Channel: string; Payload: unknown }): void => {
    const set = this._janvasEventHandlers.get(m.JivId);
    if (!set) return;
    // Snapshot: a handler may unsubscribe (or subscribe) during dispatch.
    for (const h of [...set]) h(m.Channel, m.Payload);
  };

  private _onReady = (_m: W2M_Ready): void => {
    this._ready = true;
    if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; }
    // Drain any events that queued during boot.
    if (this._eventBacklog.length > 0) {
      const drain = this._eventBacklog;
      this._eventBacklog = [];
      if (_DEBUG) console.log(`[Jaui.MainBridge] draining ${drain.length} backlogged message(s):`,
        drain.map(m => (m as { T: string }).T));
      for (const m of drain) {
        try {
          // A worker exists: `_ready` only flips when one posts back.
          this.Worker!.postMessage(m);
        } catch (err) {
          const t = (m as { T: string }).T;
          const shape = _describeShape(m);
          console.error(`[Jaui.MainBridge] backlog drain FAILED for T=${t}\n${JSON.stringify(shape, null, 2)}`, { msg: m, err });
        }
      }
    }
    // Defensive rebase against the canvas's actually-rendered size. The first settle ran from
    // `_sendInit` and its answer is already in the backlog drained above; this second pass catches
    // a layout that only finished while the worker was booting, and dedupes to nothing when the
    // first pass already had it right. See `_settleSize` for why both passes exist.
    this._settleSize();
  };

  /** The last size the worker has been told about — the init rect, then whatever a settle posted.
   *  A repost of the same size is not free on the far side: `Canvas._resize` re-solves the whole
   *  tree and renders inline, so an identical resize buys a full redundant frame. */
  private _lastPostedSize: { W: number; H: number } | null = null;

  /**
   * Post the canvas's real CSS size, once it has one.
   *
   * `_sendInit` snapshots `getBoundingClientRect()` in the constructor — while Angular is still in
   * its first CD pass — so the rect can be 0 or stale, and the canvas's CSS size may then settle
   * WITHOUT ever changing, so the ResizeObserver never fires to correct it. The worker at a size of
   * 0 skips EVERY frame (`Canvas._tickInner`'s zero-size gate), so until this lands there are no
   * pixels at all.
   *
   * Run from construction as well as from ready. The poll needs the live rect to hold still across
   * two frames, and doing that only after `ready` put those two frames in SERIES behind the whole
   * worker boot — shaders, context, registry — when they could have run alongside it. Posting from
   * construction backlogs the size (`PostMessage` holds messages until ready), so the worker's very
   * first frame after ready already has a size to draw at. Both passes dedupe against
   * `_lastPostedSize`, so the common case where the init rect was already right costs one message
   * and no redundant solve.
   */
  private _settleSize = (): void => {
    if (typeof requestAnimationFrame !== 'function') return;
    let lastW = 0, lastH = 0, tries = 0;
    const post = (rect: DOMRect): void => {
      const w = Math.round(rect.width), h = Math.round(rect.height);
      if (this._lastPostedSize && this._lastPostedSize.W === w && this._lastPostedSize.H === h) return;
      this._lastPostedSize = { W: w, H: h };
      JTrace(`worker:size-settled ${w}x${h}`);
      this.PostMessage({ T: 'resize', Width: rect.width, Height: rect.height });
    };
    const step = (): void => {
      const rect = this.Canvas.getBoundingClientRect();
      const w = Math.round(rect.width), h = Math.round(rect.height);
      if (w > 0 && h > 0 && w === lastW && h === lastH) { post(rect); return; }
      lastW = w; lastH = h;
      if (tries++ < 20) requestAnimationFrame(step);
      else if (w > 0 && h > 0) post(rect);
    };
    requestAnimationFrame(step);
  };

  private _onCursor = (m: W2M_Cursor): void => {
    this.Canvas.style.cursor = m.Cursor;
  };

  private _onCapture = (m: W2M_PointerCapture): void => {
    if (m.Action === 'set') {
      try { this.Canvas.setPointerCapture(m.PointerId); } catch { /* pointer not active */ }
    } else {
      try {
        if (this.Canvas.hasPointerCapture(m.PointerId)) {
          this.Canvas.releasePointerCapture(m.PointerId);
        }
      } catch { /* idempotent */ }
    }
  };

  private _onHit = (m: W2M_HitEvent): void => {
    const h = this._hitHandlers.get(m.JivId);
    if (!h) return;
    switch (m.Kind) {
      case 'click':         h.OnClick?.(); break;
      case 'contextmenu':   h.OnContextMenu?.(m.Source); break;
      case 'pointerdown':   h.OnPointerDown?.(m.Source); break;
      case 'pointermove':   h.OnPointerMove?.(m.Source); break;
      case 'pointerup':     h.OnPointerUp?.(m.Source); break;
      case 'wheel':         h.OnWheel?.(m.Source as WheelPayload); break;
    }
  };

  private _onRect = (m: W2M_RectSnapshot): void => {
    const h = this._hitHandlers.get(m.JivId);
    if (!h?.OnRectSnapshot) return;
    h.OnRectSnapshot(m.Box, m.Scroll ?? null);
  };

  // ─── DOM event capture ─────────────────────────────────────────────────

  private _pageRect: DOMRect | null = null;
  private _refreshPageRect = (): void => {
    this._pageRect = this.Canvas.getBoundingClientRect();
  };

  private _toCanvasLocal = (clientX: number, clientY: number): { X: number; Y: number } => {
    if (!this._pageRect) this._refreshPageRect();
    return {
      X: clientX - (this._pageRect?.left ?? 0),
      Y: clientY - (this._pageRect?.top ?? 0),
    };
  };

  private _ptrPayload = (e: PointerEvent): PointerPayload => {
    const local = this._toCanvasLocal(e.clientX, e.clientY);
    return {
      PointerId: e.pointerId,
      PointerType: e.pointerType,
      X: local.X, Y: local.Y,
      ClientX: e.clientX, ClientY: e.clientY,
      Buttons: e.buttons, Button: e.button,
      Shift: e.shiftKey, Ctrl: e.ctrlKey, Alt: e.altKey, Meta: e.metaKey,
      TimeStamp: e.timeStamp,
    };
  };

  private _wheelPayload = (e: WheelEvent): WheelPayload => {
    const local = this._toCanvasLocal(e.clientX, e.clientY);
    return {
      PointerId: -1,
      PointerType: 'mouse',
      X: local.X, Y: local.Y,
      ClientX: e.clientX, ClientY: e.clientY,
      Buttons: e.buttons, Button: e.button,
      Shift: e.shiftKey, Ctrl: e.ctrlKey, Alt: e.altKey, Meta: e.metaKey,
      TimeStamp: e.timeStamp,
      DeltaX: e.deltaX, DeltaY: e.deltaY, DeltaMode: e.deltaMode,
    };
  };

  private _keyPayload = (e: KeyboardEvent): KeyPayload => ({
    Key: e.key, Code: e.code, Repeat: e.repeat,
    Shift: e.shiftKey, Ctrl: e.ctrlKey, Alt: e.altKey, Meta: e.metaKey,
    TimeStamp: e.timeStamp,
  });

  private _wireDomEvents = (): void => {
    const c = this.Canvas;
    c.style.touchAction = 'none';
    c.tabIndex = 0; // keyboard focusable

    // Cache page rect on resize / scroll so coordinate translation is
    // correct even when the canvas isn't anchored at (0,0).
    window.addEventListener('resize', this._refreshPageRect);
    window.addEventListener('scroll', this._refreshPageRect, true);

    const fwdPointer = (kind: 'pointermove' | 'pointerdown' | 'pointerup' | 'pointercancel' | 'pointerleave' | 'pointerenter') =>
      (e: PointerEvent): void => {
        const payload = this._ptrPayload(e);
        const coalesced = kind === 'pointermove' && typeof e.getCoalescedEvents === 'function'
          ? e.getCoalescedEvents().map(c => this._ptrPayload(c))
          : undefined;
        this.PostMessage({ T: 'pointer', Kind: kind, Payload: payload, Coalesced: coalesced });
      };

    // For touch input, forward via the explicit touch-event path below
    // instead of the PointerEvent path. iOS Safari only synthesizes
    // PointerEvents for the PRIMARY finger in a multi-touch gesture, so
    // relying on pointer events alone makes pinch impossible. The touch
    // path below walks `changedTouches` and emits one synthetic pointer
    // message per finger.
    const fwdNonTouchPointer = (kind: Parameters<typeof fwdPointer>[0]) =>
      (e: PointerEvent): void => {
        if (e.pointerType === 'touch') return;
        fwdPointer(kind)(e);
      };

    c.addEventListener('pointermove', fwdNonTouchPointer('pointermove'));
    c.addEventListener('pointerdown', fwdNonTouchPointer('pointerdown'));
    c.addEventListener('pointerup', fwdNonTouchPointer('pointerup'));
    c.addEventListener('pointercancel', fwdNonTouchPointer('pointercancel'));
    c.addEventListener('pointerleave', fwdNonTouchPointer('pointerleave'));
    c.addEventListener('pointerenter', fwdNonTouchPointer('pointerenter'));

    // Multi-touch path — synthesize a PointerPayload per touch and forward
    // through the same worker pipeline. The browser delivers all fingers
    // here on every touch event (touches / changedTouches), so multi-touch
    // is reliable regardless of WebKit's PointerEvent synthesis quirks.
    const touchPayload = (t: Touch, timeStamp: number): PointerPayload => {
      const local = this._toCanvasLocal(t.clientX, t.clientY);
      return {
        // Offset identifier so it can't collide with mouse pointerId=1.
        PointerId: t.identifier + 2,
        PointerType: 'touch',
        X: local.X, Y: local.Y,
        ClientX: t.clientX, ClientY: t.clientY,
        Buttons: 1, Button: 0,
        Shift: false, Ctrl: false, Alt: false, Meta: false,
        TimeStamp: timeStamp,
      };
    };
    const fwdTouches = (kind: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel') =>
      (e: TouchEvent): void => {
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          this.PostMessage({ T: 'pointer', Kind: kind, Payload: touchPayload(t, e.timeStamp) });
        }
      };
    c.addEventListener('touchmove',   fwdTouches('pointermove'),   { passive: false });
    c.addEventListener('touchend',    fwdTouches('pointerup'),     { passive: false });
    c.addEventListener('touchcancel', fwdTouches('pointercancel'), { passive: false });

    c.addEventListener('wheel', (e: WheelEvent) => {
      // Browser zoom (Ctrl + wheel, or pinch-zoom which Chrome delivers as
      // wheel + ctrlKey) is a browser-owned gesture — bail before
      // preventDefault so the page can zoom. Worker can't decide this
      // synchronously, so the call has to happen here on main.
      if (e.ctrlKey) return;
      // preventDefault on main BEFORE forwarding — worker can't decide
      // synchronously and Chrome/Safari ignore async preventDefault.
      e.preventDefault();
      this.PostMessage({ T: 'wheel', Payload: this._wheelPayload(e) });
    }, { passive: false });

    c.addEventListener('touchstart', (e: TouchEvent) => {
      // Always preventDefault — `touch-action: none` should already kill
      // browser scroll/zoom but redundant guard doesn't hurt, and we're
      // taking over the gesture lifecycle entirely. We forward each finger
      // through the touch-derived pointer pipeline below, so the worker
      // sees correct multi-touch regardless of WebKit's PointerEvent
      // synthesis quirks (the original preventDefault was suppressing
      // synthesis of pointer events for fingers 2+ on iOS Safari).
      e.preventDefault();
      this.PostMessage({ T: 'touchstart' });
      // Synthesize pointerdown for every new touch in this event.
      fwdTouches('pointerdown')(e);
    }, { passive: false });

    c.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      const local = this._toCanvasLocal(e.clientX, e.clientY);
      this.PostMessage({
        T: 'contextmenu',
        Payload: {
          PointerId: -1, PointerType: 'mouse',
          X: local.X, Y: local.Y,
          ClientX: e.clientX, ClientY: e.clientY,
          Buttons: e.buttons, Button: e.button,
          Shift: e.shiftKey, Ctrl: e.ctrlKey, Alt: e.altKey, Meta: e.metaKey,
          TimeStamp: e.timeStamp,
        },
      });
    });

    // window-level keydown for selection shortcuts (Cmd/Ctrl+A, Esc).
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      this.PostMessage({ T: 'keydown', Payload: this._keyPayload(e) });
    }, { capture: true });

    // Native clipboard for display-text selection. The worker mirrors the
    // current selected plaintext on every selection change via the
    // `selection-text` W2M message; here we hand that string to the
    // browser's `copy` event while the user-gesture activation is still
    // alive. Listen at document-capture so a Ctrl+C / right-click → Copy
    // works regardless of which element has focus (canvas, body, or a
    // Jiv host). Bail when a real DOM text input is focused so we don't
    // shadow Jinput's hidden textarea or any plain `<input>` on the page.
    const onClipboardCopy = (e: ClipboardEvent): void => {
      if (_isNativeTextInputFocused()) return;
      const text = this._selectedText;
      if (!text) return;
      e.clipboardData?.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', onClipboardCopy, { capture: true });
    // Cut on display-text is copy-only — display text isn't editable, but
    // suppressing the native default-behaviour avoids the browser silently
    // dropping the selection without writing it to the clipboard.
    document.addEventListener('cut', onClipboardCopy, { capture: true });

    // ResizeObserver pushes contentRect to the worker.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this._pageRect = null; // invalidate cached rect; refreshed lazily.
      this.PostMessage({
        T: 'resize',
        Width: entry.contentRect.width,
        Height: entry.contentRect.height,
      });
    });
    ro.observe(c);

    // The RO only delivers during rendering steps, which a hidden tab never
    // runs — a window resized while its tab was backgrounded came back with
    // a stale layout. Window resize + visibility return both re-post the
    // live rect; the worker side is idempotent on same-size messages.
    const postLiveSize = (): void => {
      const rect = c.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this.PostMessage({ T: 'resize', Width: rect.width, Height: rect.height });
      }
    };
    window.addEventListener('resize', postLiveSize);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) postLiveSize();
    });

    // DPR change watcher — matchMedia '(resolution: Ndppx)' is one-shot;
    // re-arm after each fire, just like the engine used to do directly.
    const watchDpr = (): void => {
      if (!window.matchMedia) return;
      const dpr = window.devicePixelRatio || 1;
      const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
      const handler = (): void => {
        this.PostMessage({ T: 'dpr', DevicePixelRatio: window.devicePixelRatio || 1 });
        watchDpr();
      };
      if (mql.addEventListener) {
        mql.addEventListener('change', handler, { once: true } as AddEventListenerOptions);
      }
    };
    watchDpr();

    // Coarse-pointer change (rare — e.g. a tablet docks/undocks).
    if (window.matchMedia) {
      const mq = window.matchMedia('(pointer: coarse)');
      const handler = (e: MediaQueryListEvent): void => {
        this.PostMessage({ T: 'coarse', IsPointerCoarse: e.matches });
      };
      if (mq.addEventListener) mq.addEventListener('change', handler);
    }

    // FontFaceSet — mirror every loaded FontFace into the worker's
    // `self.fonts` so text the engine rasterizes server-side resolves
    // the right glyph.
    //
    // The `FontFace` object doesn't expose its source URL, but @font-face
    // CSS rules in `document.styleSheets` do. Walk those rules, extract
    // `font-family` + the first `url(...)` from `src`, and post to the
    // worker. The browser font cache dedupes the actual buffer fetch.
    // For FontFaces created imperatively (no @font-face rule, e.g. via
    // `new FontFace(family, ArrayBuffer)`), fall back to `local(family)`
    // — works for system fonts but not for webfonts.
    if (document.fonts) {
      const sentFamilies = new Set<string>();

      const post = (
        family: string, srcRaw: string, baseUrl: string,
        weight?: string, style?: string, stretch?: string,
        unicodeRange?: string, display?: string,
      ): void => {
        const cleanFamily = family.replace(/['"]/g, '').trim();
        if (!cleanFamily) return;
        // Extract the first url(...) — that's the binary we'll fetch.
        // `format(...)` clauses and additional sources are ignored; if
        // the first URL fails the FontFace simply isn't installed.
        const urlMatch = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(srcRaw);
        if (!urlMatch) return;
        let resolved: string;
        try { resolved = new URL(urlMatch[2], baseUrl).href; } catch { return; }
        const key = `${cleanFamily}|${weight ?? ''}|${style ?? ''}|${stretch ?? ''}|${unicodeRange ?? ''}`;
        if (sentFamilies.has(key)) return;
        sentFamilies.add(key);
        // Fetch the binary on main (where cross-origin font fetches
        // aren't blocked) and ship as a transferred ArrayBuffer. Worker
        // constructs `new FontFace(family, buffer)` which works
        // identically across Chromium and WebKit. `crossorigin` headers
        // for Google Fonts allow this — they emit `access-control-allow-origin: *`.
        fetch(resolved).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        }).then((buf) => {
          this.PostMessage({
            T: 'font-face',
            Family: cleanFamily,
            Buffer: buf,
            Descriptors: { Weight: weight, Style: style, Stretch: stretch, UnicodeRange: unicodeRange, Display: display },
          }, [buf]);
        }).catch((err) => {
          console.warn(`[FontScan] failed to fetch ${resolved}:`, err?.message ?? err);
        });
      };

      const sendFromCssRule = (rule: CSSFontFaceRule): void => {
        post(
          rule.style.getPropertyValue('font-family'),
          rule.style.getPropertyValue('src'),
          (rule.parentStyleSheet as CSSStyleSheet | null)?.href || window.location.href,
          rule.style.getPropertyValue('font-weight') || undefined,
          rule.style.getPropertyValue('font-style') || undefined,
          rule.style.getPropertyValue('font-stretch') || undefined,
          rule.style.getPropertyValue('unicode-range') || undefined,
          rule.style.getPropertyValue('font-display') || undefined,
        );
      };

      // Parse @font-face blocks from raw CSS text — used for CORS-locked
      // stylesheets where `cssRules` throws but we can still `fetch()` the
      // URL (Google Fonts sends permissive CORS on the CSS endpoint).
      const parseFontFacesFromText = (cssText: string, baseUrl: string): void => {
        const blockRe = /@font-face\s*\{([^}]+)\}/g;
        let m: RegExpExecArray | null;
        while ((m = blockRe.exec(cssText)) !== null) {
          const body = m[1];
          const get = (prop: string): string | undefined => {
            const r = new RegExp(`${prop}\\s*:\\s*([^;]+);?`, 'i').exec(body);
            return r ? r[1].trim() : undefined;
          };
          const family = get('font-family');
          const src = get('src');
          if (!family || !src) continue;
          post(
            family, src, baseUrl,
            get('font-weight'), get('font-style'), get('font-stretch'),
            get('unicode-range'), get('font-display'),
          );
        }
      };

      const fetchedSheets = new Set<string>();
      const fetchAndParse = (url: string): void => {
        if (fetchedSheets.has(url)) return;
        fetchedSheets.add(url);
        if (_DEBUG) console.log(`[FontScan] fetching CORS-locked sheet: ${url}`);
        fetch(url).then((r) => {
          if (!r.ok) {
            console.warn(`[FontScan] fetch ${url} failed: HTTP ${r.status}`);
            return '';
          }
          return r.text();
        }).then((txt) => {
          if (!txt) return;
          const beforeCount = sentFamilies.size;
          parseFontFacesFromText(txt, url);
          if (_DEBUG) console.log(`[FontScan] parsed ${url}: +${sentFamilies.size - beforeCount} font-face(s)`);
        }).catch((err) => {
          console.warn(`[FontScan] fetch ${url} threw:`, err?.message ?? err);
        });
      };

      const walk = (sheet: CSSStyleSheet): void => {
        let rules: CSSRuleList | null = null;
        let corsBlocked = false;
        try { rules = sheet.cssRules; } catch { corsBlocked = true; }
        if (rules) {
          for (let i = 0; i < rules.length; i++) {
            const r = rules[i];
            if (r instanceof CSSFontFaceRule) {
              sendFromCssRule(r);
            } else if (r instanceof CSSImportRule) {
              if (r.styleSheet) walk(r.styleSheet);
              else if (r.href) fetchAndParse(new URL(r.href, sheet.href || window.location.href).href);
            }
          }
        } else if (sheet.href) {
          // Log gated by the dedup state so re-scans of an already-fetched
          // CORS sheet don't print a misleading "fetching" line — the
          // actual fetch ran once on the first scan. fetchAndParse's
          // own no-op short-circuit on cache hit keeps the network cost
          // at one request per sheet across the lifetime of the page.
          if (corsBlocked && _DEBUG && !fetchedSheets.has(sheet.href)) {
            console.log(`[FontScan] CORS-blocked, fetching: ${sheet.href}`);
          }
          fetchAndParse(sheet.href);
        }
      };

      const scan = (): void => {
        if (_DEBUG) console.log(`[FontScan] scanning ${document.styleSheets.length} stylesheet(s)`);
        for (let i = 0; i < document.styleSheets.length; i++) walk(document.styleSheets[i]);
      };

      // Initial scan after a microtask so first-paint stylesheets are
      // attached. Re-scan on `loadingdone` to catch lazy @font-face rules.
      queueMicrotask(scan);
      if (document.fonts.addEventListener) {
        document.fonts.addEventListener('loadingdone', () => {
          scan();
          this.PostMessage({ T: 'fonts-done' });
        });
      }
    }

    // Focus state — engine's selection-key suppression looks at this. A
    // focused DOM embed counts: while someone is typing into one, the keys
    // belong to it and Jaui's own selection shortcuts must stand down.
    const focusHandler = (): void => {
      const ae = document.activeElement;
      const focused = !!ae && (
        ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT'
        || (ae as HTMLElement).isContentEditable
        || IsInsideEmbed(ae)
      );
      this.PostMessage({ T: 'focus', IsTextInputFocused: focused });
    };
    document.addEventListener('focusin', focusHandler);
    document.addEventListener('focusout', focusHandler);
  };
}

/** Convenience: id of the Canvas root in the worker. Use this as the
 *  parent in attach ops for top-level Jivs. */
export const RootId = ROOT_ID;

// Diagnostic — describes shape of an unclonable message so the console
// points at the offending field. Recurses deeply (depth 8) and fully
// expands arrays so jiv-ops batches surface the bad Op + field.
function _describeShape(v: unknown, depth = 0): unknown {
  if (depth > 8) return '<…>';
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t !== 'object') {
    if (t === 'string') return (v as string).length > 60 ? `string(${(v as string).length})` : v;
    return t;
  }
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
  if (ArrayBuffer.isView(v)) {
    const c = (v.constructor && v.constructor.name) || 'TypedArray';
    return `${c}(${(v as ArrayBufferView).byteLength})`;
  }
  if (typeof Blob !== 'undefined' && v instanceof Blob) return `Blob(${v.size})`;
  if (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) return 'ImageBitmap';
  if (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas) return 'OffscreenCanvas';
  if (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) return '🚨HTMLCanvasElement🚨';
  if (typeof HTMLImageElement !== 'undefined' && v instanceof HTMLImageElement) return '🚨HTMLImageElement🚨';
  if (typeof HTMLElement !== 'undefined' && v instanceof HTMLElement) return `🚨HTMLElement<${(v as HTMLElement).tagName}>🚨`;
  if (Array.isArray(v)) return v.map(x => _describeShape(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object)) out[k] = _describeShape((v as Record<string, unknown>)[k], depth + 1);
  return out;
}
