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

import type {
  M2W,
  W2M,
  W2M_Cursor,
  W2M_PointerCapture,
  W2M_HitEvent,
  W2M_RectSnapshot,
  W2M_Ready,
  JivOp,
  PointerPayload,
  WheelPayload,
  KeyPayload,
} from './Bridge.Types';

const ROOT_ID = 0;

export interface BridgeOptions {
  /** Canvas DOM element that Angular created. The bridge transfers it
   *  to the worker (one-way) and keeps the element only as an event
   *  capture target. */
  Canvas: HTMLCanvasElement;
  /** Pre-spawned Worker (call `SpawnJauiWorker()`). The bridge does NOT
   *  spawn the worker itself because the static-URL `new Worker(...)` call
   *  has to live inside the Jaui package for the bundler to detect it.
   *  Consumers receive that helper from Jaui core. */
  Worker: Worker;
}

/** Hit-handler functions that Angular `<jiv>` registers per Jiv id. */
export interface JivHitHandlers {
  OnClick?: () => void;
  OnContextMenu?: (src: PointerPayload) => void;
  OnPointerDown?: (src: PointerPayload) => void;
  OnPointerMove?: (src: PointerPayload) => void;
  OnPointerUp?: (src: PointerPayload) => void;
  /** Called when the worker posts a fresh rect snapshot for this node.
   *  Set on Handles that have subscribed via `WatchRect(true)`. */
  OnRectSnapshot?: (rect: { X: number; Y: number; Width: number; Height: number }) => void;
}

export class MainBridge {
  readonly Canvas: HTMLCanvasElement;
  readonly Worker: Worker;

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

  constructor(opts: BridgeOptions) {
    this.Canvas = opts.Canvas;
    this.Worker = opts.Worker;

    console.log('[Jaui.MainBridge] constructed; canvas=', this.Canvas, 'worker=', this.Worker);

    this.Ready = new Promise<void>(r => { this._readyResolve = r; });

    this.Worker.addEventListener('message', (e: MessageEvent) => this._onMessage(e.data));
    this.Worker.addEventListener('error', (e: ErrorEvent) => {
      console.error('[Jaui.MainBridge] worker error:', e.message, e.error, 'filename:', e.filename, 'line:', e.lineno);
    });
    this.Worker.addEventListener('messageerror', (e: MessageEvent) => {
      console.error('[Jaui.MainBridge] worker messageerror:', e);
    });

    this._wireDomEvents();
    this._sendInit();
  }

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
  PostMessage = (msg: M2W, transfer?: Transferable[]): void => {
    if (!this._ready) {
      this._eventBacklog.push(msg);
      return;
    }
    if (transfer && transfer.length > 0) {
      this.Worker.postMessage(msg, transfer);
    } else {
      this.Worker.postMessage(msg);
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
    // Page-rect for initial size — saves the first ResizeObserver round-trip.
    const rect = this.Canvas.getBoundingClientRect();
    const offscreen = this.Canvas.transferControlToOffscreen();
    const dpr = window.devicePixelRatio || 1;
    const isCoarse = !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

    this.Worker.postMessage(
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
  };

  private _onMessage = (msg: unknown): void => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as W2M;
    // Worker-forwarded console lines — re-emit through main's console so
    // the on-screen overlay (?debug=console) catches them. Wrapped in a
    // guard because the W2M union doesn't list this T (it's an out-of-band
    // dev channel — production builds can strip it).
    if ((m as { T: string }).T === 'console') {
      const c = m as unknown as { Level: string; Args: unknown[] };
      const fn = (console as unknown as Record<string, (...args: unknown[]) => void>)[c.Level] || console.log;
      try { fn.call(console, '[worker]', ...c.Args); } catch { /* ignore */ }
      return;
    }
    switch (m.T) {
      case 'ready':         return this._onReady(m);
      case 'cursor':        return this._onCursor(m);
      case 'capture':       return this._onCapture(m);
      case 'hit':           return this._onHit(m);
      case 'rect':          return this._onRect(m);
      case 'hud':           return; // HUD relocation lands in P1g; no-op for now.
      case 'svg-rerasterize': return;
      case 'janvas-event':  return this._onJanvasEvent(m);
    }
  };

  /** Subscribers for `janvas-event` payloads. Keyed by JivId; a single
   *  consumer per Janvas matches the typical 1:1 main-side service pairing. */
  private _janvasEventHandlers = new Map<number, (channel: string, payload: unknown) => void>();

  /** Register a handler for events posted by the Janvas's worker-side
   *  renderer at `jivId`. Returns an unsubscriber. Called by show-studio
   *  Reality service to receive selection / loaded / etc. events. */
  OnJanvasEvent = (jivId: number, handler: (channel: string, payload: unknown) => void): () => void => {
    this._janvasEventHandlers.set(jivId, handler);
    return () => {
      if (this._janvasEventHandlers.get(jivId) === handler) {
        this._janvasEventHandlers.delete(jivId);
      }
    };
  };

  private _onJanvasEvent = (m: { JivId: number; Channel: string; Payload: unknown }): void => {
    const h = this._janvasEventHandlers.get(m.JivId);
    h?.(m.Channel, m.Payload);
  };

  private _onReady = (_m: W2M_Ready): void => {
    this._ready = true;
    if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; }
    // Drain any events that queued during boot.
    if (this._eventBacklog.length > 0) {
      const drain = this._eventBacklog;
      this._eventBacklog = [];
      for (const m of drain) this.Worker.postMessage(m);
    }
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
    }
  };

  private _onRect = (m: W2M_RectSnapshot): void => {
    const h = this._hitHandlers.get(m.JivId);
    if (!h?.OnRectSnapshot) return;
    h.OnRectSnapshot({ X: m.X, Y: m.Y, Width: m.Width, Height: m.Height });
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

    c.addEventListener('pointermove', fwdPointer('pointermove'));
    c.addEventListener('pointerdown', fwdPointer('pointerdown'));
    c.addEventListener('pointerup', fwdPointer('pointerup'));
    c.addEventListener('pointercancel', fwdPointer('pointercancel'));
    c.addEventListener('pointerleave', fwdPointer('pointerleave'));
    c.addEventListener('pointerenter', fwdPointer('pointerenter'));

    c.addEventListener('wheel', (e: WheelEvent) => {
      // preventDefault on main BEFORE forwarding — worker can't decide
      // synchronously and Chrome/Safari ignore async preventDefault.
      e.preventDefault();
      this.PostMessage({ T: 'wheel', Payload: this._wheelPayload(e) });
    }, { passive: false });

    c.addEventListener('touchstart', (e: TouchEvent) => {
      e.preventDefault();
      this.PostMessage({ T: 'touchstart' });
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
        console.log(`[FontScan] fetching CORS-locked sheet: ${url}`);
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
          console.log(`[FontScan] parsed ${url}: +${sentFamilies.size - beforeCount} font-face(s)`);
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
          if (corsBlocked) console.log(`[FontScan] CORS-blocked, fetching: ${sheet.href}`);
          fetchAndParse(sheet.href);
        }
      };

      const scan = (): void => {
        console.log(`[FontScan] scanning ${document.styleSheets.length} stylesheet(s)`);
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

    // Focus state — engine's selection-key suppression looks at this.
    const focusHandler = (): void => {
      const ae = document.activeElement;
      const focused = !!ae && (
        ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT'
        || (ae as HTMLElement).isContentEditable
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
