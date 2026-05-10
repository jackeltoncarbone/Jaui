/**
 * WorkerPlatform — Platform impl that runs inside the Jaui worker.
 *
 * The engine code (Canvas in Jaui.ts) calls Platform methods like
 * GetDevicePixelRatio() and AddKeydownListener() synchronously during a
 * tick. The worker has no direct access to `window`/`document`, so we
 * mirror the relevant state from main on every change and serve reads
 * from that cache.
 *
 * Construction:
 *   const platform = new WorkerPlatform({
 *     dpr: 2, isPointerCoarse: true, isTextInputFocused: false,
 *     urlSearch: '', urlHash: ''
 *   });
 *   bridge.OnMessage = (msg) => platform.IngestMessage(msg);
 *
 * The bridge runtime calls `platform.IngestMessage(...)` for every
 * inbound M2W payload that touches Platform state.
 */

import type { Platform } from '../Core/Platform';
import type {
  M2W,
  M2W_DprChange,
  M2W_CoarseChange,
  M2W_FocusChange,
  M2W_FontsLoadingDone,
  M2W_KeyDown,
} from './Bridge.Types';

export interface WorkerPlatformInit {
  Dpr: number;
  IsPointerCoarse: boolean;
  IsTextInputFocused: boolean;
  UrlSearch: string;
  UrlHash: string;
  /** Whether `document.fonts.ready` had already resolved on main when the
   *  worker started — lets the engine skip an initial atlas flush if no
   *  font load is pending. (Currently informational; the engine listens
   *  for `loadingdone` to invalidate, not for the ready promise.) */
  FontsAlreadyReady: boolean;
}

export class WorkerPlatform implements Platform {
  private _dpr: number;
  private _coarse: boolean;
  private _focused: boolean;
  private _urlSearch: string;
  private _urlHash: string;

  /** Subscribers from `ObserveDprChange`. matchMedia semantics: each fires
   *  once and is removed (one-shot). Engine re-arms after each fire. */
  private _dprListeners: (() => void)[] = [];

  /** Subscribers from `ObserveFontsLoadingDone`. NOT one-shot — engine
   *  re-uses the same handler across many font-load batches. */
  private _fontsListeners: (() => void)[] = [];

  /** Subscribers from `AddKeydownListener`. Not one-shot. */
  private _keydownListeners: { handler: (e: KeyboardEvent) => void; capture: boolean }[] = [];

  constructor(init: WorkerPlatformInit) {
    this._dpr = init.Dpr;
    this._coarse = init.IsPointerCoarse;
    this._focused = init.IsTextInputFocused;
    this._urlSearch = init.UrlSearch;
    this._urlHash = init.UrlHash;
  }

  // ─── Platform interface ───────────────────────────────────────────────

  GetDevicePixelRatio = (): number => this._dpr;

  IsPointerCoarse = (): boolean => this._coarse;

  ObserveDprChange = (_currentDpr: number, handler: () => void): (() => void) => {
    // matchMedia '(resolution: Ndppx)' is one-shot per arm; we mimic that
    // so engine code that re-arms after each fire keeps working unchanged.
    this._dprListeners.push(handler);
    return () => {
      const i = this._dprListeners.indexOf(handler);
      if (i >= 0) this._dprListeners.splice(i, 1);
    };
  };

  IsTextInputFocused = (): boolean => this._focused;

  AddKeydownListener = (
    handler: (e: KeyboardEvent) => void,
    options?: AddEventListenerOptions,
  ): (() => void) => {
    const capture = options?.capture === true;
    const entry = { handler, capture };
    this._keydownListeners.push(entry);
    return () => {
      const i = this._keydownListeners.indexOf(entry);
      if (i >= 0) this._keydownListeners.splice(i, 1);
    };
  };

  ObserveFontsLoadingDone = (handler: () => void): (() => void) => {
    this._fontsListeners.push(handler);
    return () => {
      const i = this._fontsListeners.indexOf(handler);
      if (i >= 0) this._fontsListeners.splice(i, 1);
    };
  };

  GetUrlSearch = (): string => this._urlSearch;

  GetUrlHash = (): string => this._urlHash;

  // ─── Bridge inbound — called by the worker bridge runtime ────────────

  /** Apply an inbound bridge message that affects Platform state. Returns
   *  true if the message was consumed (so the bridge runtime knows whether
   *  to also pass it to other handlers). */
  IngestMessage = (msg: M2W): boolean => {
    switch (msg.T) {
      case 'dpr': return this._onDpr(msg);
      case 'coarse': return this._onCoarse(msg);
      case 'focus': return this._onFocus(msg);
      case 'fonts-done': return this._onFontsDone(msg);
      case 'keydown': return this._onKeydown(msg);
      default: return false;
    }
  };

  private _onDpr = (msg: M2W_DprChange): true => {
    this._dpr = msg.DevicePixelRatio;
    // matchMedia 'change' fires once and is removed — drain to a snapshot
    // so listeners that re-arm via `ObserveDprChange` from inside the
    // handler don't get fired again on the same delta.
    const snapshot = this._dprListeners.slice();
    this._dprListeners.length = 0;
    for (const h of snapshot) {
      try { h(); } catch (e) { console.error('[WorkerPlatform] DPR handler threw', e); }
    }
    return true;
  };

  private _onCoarse = (msg: M2W_CoarseChange): true => {
    this._coarse = msg.IsPointerCoarse;
    return true;
  };

  private _onFocus = (msg: M2W_FocusChange): true => {
    this._focused = msg.IsTextInputFocused;
    return true;
  };

  private _onFontsDone = (_msg: M2W_FontsLoadingDone): true => {
    // Persistent listeners — copy the array so a handler that detaches
    // itself mid-fire doesn't shift indices on us.
    const snapshot = this._fontsListeners.slice();
    for (const h of snapshot) {
      try { h(); } catch (e) { console.error('[WorkerPlatform] Fonts handler threw', e); }
    }
    return true;
  };

  private _onKeydown = (msg: M2W_KeyDown): true => {
    // Synthesize a KeyboardEvent-shaped object. The engine's only consumer
    // (Canvas._listenForSelectionKeys) reads .key, .ctrlKey, .metaKey and
    // calls .preventDefault(). We provide all of those; preventDefault is
    // a no-op since the real event was on the main thread (the engine's
    // call site uses it only as a "yes, we handled it" signal, not as a
    // request to propagate state back to main).
    let prevented = false;
    const synth: Partial<KeyboardEvent> = {
      key: msg.Payload.Key,
      code: msg.Payload.Code,
      repeat: msg.Payload.Repeat,
      shiftKey: msg.Payload.Shift,
      ctrlKey: msg.Payload.Ctrl,
      altKey: msg.Payload.Alt,
      metaKey: msg.Payload.Meta,
      timeStamp: msg.Payload.TimeStamp,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
    };
    const snapshot = this._keydownListeners.slice();
    for (const entry of snapshot) {
      try { entry.handler(synth as KeyboardEvent); } catch (e) {
        console.error('[WorkerPlatform] keydown handler threw', e);
      }
    }
    // `prevented` isn't currently relayed back — selection keys we suppress
    // (Cmd+A) don't have a meaningful "browser did it instead" path: the
    // canvas isn't a text-edit context and main filters by activeElement
    // anyway. If a future use case needs preventDefault to round-trip,
    // emit a W2M_KeyHandled and have main call e.preventDefault() on the
    // *next* same-key event (one-frame lag, acceptable for hotkeys).
    void prevented;
    return true;
  };
}
