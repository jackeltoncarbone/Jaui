/**
 * Bridge.Worker — message pump on the worker side. Receives M2W payloads
 * from main (via `self.onmessage`) and dispatches them: Platform-related
 * to `WorkerPlatform`, event-shaped to `Canvas.IngestEvent`, lifecycle
 * to `Canvas.Start/Stop`. Outbound (W2M) helpers post cursor / pointer-
 * capture / HUD updates back to main.
 *
 * Construction:
 *   const bridge = new WorkerBridge();
 *   bridge.OnInit = (msg) => { ... construct Canvas + WorkerPlatform ... };
 *   self.addEventListener('message', (e) => bridge.HandleMessage(e.data));
 */

import type { Canvas } from '../Core/Jaui';
import { WorkerPlatform, type WorkerPlatformInit } from './Worker.Platform';
import type { JivRegistry } from './Jiv.Registry';
import { PrimeFontInSharedCtx } from '../Text/Text.WordLayout';
import { PrimeFontInMeasureCtx } from '../Text/Text.Measure';
import {
  isMessage,
  type M2W,
  type M2W_Init,
  type M2W_Capture,
  type M2W_PointerEvent,
  type M2W_WheelEvent,
  type M2W_Resize,
  type M2W_DprChange,
  type M2W_JssVars,
  type M2W_Control,
  type M2W_ContextMenu,
  type M2W_JivOps,
  type M2W_ImageLoadUrl,
  type M2W_ImageLoadSvg,
  type M2W_ImageBitmap,
  type M2W_FontFace,
  type M2W_Kick,
  type M2W_Ping,
  type M2W_JanvasInput,
  type W2M,
  type PointerPayload,
  type WheelPayload,
} from './Bridge.Types';

/** A function that posts a W2M payload back to main. The worker entry
 *  wires this to `(self as DedicatedWorkerGlobalScope).postMessage`. The
 *  optional `transfer` list lets callers transfer ImageBitmaps / typed
 *  array buffers through the structured-clone fast path (zero-copy). */
export type PostFn = (msg: W2M, transfer?: Transferable[]) => void;

/** Synth event shape the engine handlers consume. The bridge constructs
 *  these from M2W payloads — they look enough like DOM events that the
 *  existing engine handlers (which read clientX/Y, pointerId, etc.)
 *  work without modification.
 *
 *  Pre-translation contract: `clientX`/`clientY` are CANVAS-LOCAL CSS
 *  pixels, not page coords. `Canvas._pageRect()` returns a (0, 0)-anchored
 *  rect, so the handlers' `clientX - rect.left` math collapses to
 *  `clientX - 0 = clientX` — already canvas-local. */
export interface SynthPointerEvent {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  timeStamp: number;
  preventDefault: () => void;
  stopPropagation: () => void;
  /** PointerEvent.getCoalescedEvents — main thread already collected the
   *  high-frequency samples and serialized them; we expose them here. */
  getCoalescedEvents: () => SynthPointerEvent[];
}

export interface SynthWheelEvent extends SynthPointerEvent {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

export class WorkerBridge {
  private _post: PostFn;
  private _platform: WorkerPlatform | null = null;
  private _canvas: Canvas | null = null;
  private _registry: JivRegistry | null = null;

  /** Set by the worker entry once it has constructed Canvas. The bridge
   *  forwards init / event / resize / control payloads here. */
  Canvas: Canvas | null = null;

  /** Hooked by the worker entry. Called when a M2W_Init message arrives.
   *  The init handler builds `WorkerPlatform` and `Canvas` and assigns
   *  them back to `bridge.Platform` and `bridge.Canvas`. */
  OnInit: ((msg: M2W_Init) => void) | null = null;

  constructor(post: PostFn) {
    this._post = post;
  }

  // ─── Wiring (called by worker entry once Canvas is constructed) ────────

  AttachPlatform = (platform: WorkerPlatform): void => { this._platform = platform; };
  AttachRegistry = (registry: JivRegistry): void => { this._registry = registry; };
  AttachCanvas = (canvas: Canvas): void => {
    this._canvas = canvas;
    this.Canvas = canvas;
    // Bidirectional wiring: cursor + capture writes from engine relay
    // back to main. Bridge owns the postMessage shape; engine doesn't
    // know about our wire format.
    canvas.OnCursorChange((cursor) => this._post({ T: 'cursor', Cursor: cursor }));
    canvas.OnPointerCaptureRequest((action, pointerId) =>
      this._post({ T: 'capture', Action: action, PointerId: pointerId }),
    );
    canvas.OnSelectionTextChange((text) => this._post({ T: 'selection-text', Text: text }));
  };

  // ─── Inbound (M2W) ─────────────────────────────────────────────────────

  HandleMessage = (msg: unknown): void => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as M2W;
    // Platform messages first — they're cheap and many of the bridge's
    // payloads (DPR, focus, fonts, key, coarse) are pure Platform deltas.
    if (this._platform && this._platform.IngestMessage(m)) return;

    if (isMessage<M2W_Init>(m, 'init')) { this.OnInit?.(m); return; }
    if (isMessage<M2W_PointerEvent>(m, 'pointer')) return this._onPointer(m);
    if (isMessage<M2W_WheelEvent>(m, 'wheel')) return this._onWheel(m);
    if (isMessage(m, 'touchstart')) return this._onTouchStart();
    if (isMessage<M2W_ContextMenu>(m, 'contextmenu')) return this._onContextMenu(m);
    if (isMessage<M2W_Resize>(m, 'resize')) return this._onResize(m);
    if (isMessage<M2W_DprChange>(m, 'dpr')) {
      // DPR change went through Platform above; the engine's _watchDpr
      // self-re-arms via Platform.ObserveDprChange so we don't need to
      // poke Canvas here.
      return;
    }
    if (isMessage<M2W_JssVars>(m, 'jss-vars')) return this._onJssVars(m);
    if (isMessage<M2W_Control>(m, 'control')) return this._onControl(m);
    if (isMessage<M2W_JivOps>(m, 'jiv-ops')) return this._onJivOps(m);
    if (isMessage<M2W_ImageLoadUrl>(m, 'image-url')) return this._onImageUrl(m);
    if (isMessage<M2W_JanvasInput>(m, 'janvas-input')) return this._onJanvasInput(m);
    if (isMessage<M2W_ImageLoadSvg>(m, 'image-svg')) return this._onImageSvg(m);
    if (isMessage<M2W_ImageBitmap>(m, 'image-bitmap')) return this._onImageBitmap(m);
    if (isMessage<M2W_FontFace>(m, 'font-face')) return this._onFontFace(m);
    if (isMessage<M2W_Kick>(m, 'kick')) return this._onKick();
    if (isMessage<M2W_Capture>(m, 'capture')) {
      void this._canvas?.CaptureFrame().then(blob => this._post({ T: 'capture-result', Blob: blob ?? null }));
      return;
    }
    // Liveness probe from the main-thread eviction watchdog — answer immediately so it
    // knows the worker is alive (a dead worker can't reply, which is the watchdog's cue).
    if (isMessage<M2W_Ping>(m, 'ping')) { this._post({ T: 'pong' }); return; }
  };

  private _onImageBitmap = (m: M2W_ImageBitmap): void => {
    this._canvas?.Images.LoadBitmap(m.Key, m.Bitmap);
  };

  private _onFontFace = (m: M2W_FontFace): void => {
    // Construct a FontFace from the pre-fetched binary main shipped over.
    // We don't pass URLs to FontFace in workers because WebKit/Safari
    // workers reject cross-origin font fetches with a generic "Network
    // error" — main does the fetch (where it works) and transfers the
    // bytes here zero-copy. Single code path, consistent across browsers.
    if (typeof FontFace === 'undefined') return;
    const desc: FontFaceDescriptors = {};
    if (m.Descriptors) {
      if (m.Descriptors.Weight) desc.weight = m.Descriptors.Weight;
      if (m.Descriptors.Style) desc.style = m.Descriptors.Style;
      if (m.Descriptors.Stretch) desc.stretch = m.Descriptors.Stretch;
      if (m.Descriptors.Display) (desc as { display?: string }).display = m.Descriptors.Display;
      if (m.Descriptors.UnicodeRange) desc.unicodeRange = m.Descriptors.UnicodeRange;
    }
    const ff = new FontFace(m.Family, m.Buffer, desc);
    ff.load().then(async () => {
      const fontSet = (self as unknown as { fonts?: FontFaceSet }).fonts;
      fontSet?.add(ff);
      // WebKit (iPad / iOS Safari) workaround: `self.fonts.add(ff)` alone
      // doesn't reliably register the font with the OffscreenCanvas 2D
      // measureText/fillText pipeline — the font set and the canvas's
      // font registry are separate caches in WebKit. Two-step force:
      //
      //   1. `fonts.load(<spec>)` — pulls the FontFace into the cached
      //      registry the canvas reads from.
      //   2. Prime via a throwaway OffscreenCanvas that *uses* the font
      //      (set ctx.font, call measureText). WebKit lazily binds the
      //      font to a canvas's font registry on first reference; doing
      //      it now means the engine's main canvas inherits the binding
      //      via the shared FontFaceSet.
      const weight = m.Descriptors?.Weight ?? '400';
      const style = m.Descriptors?.Style ?? 'normal';
      const spec = `${style} ${weight} 16px "${m.Family}"`;
      try { await fontSet?.load(spec); } catch { /* WebKit may reject some shorthands; the add() above is still effective on Chromium */ }
      // Prime the engine's *actual* shared measurement contexts so iOS
      // Safari binds the new face to the canvas font registries the
      // engine reads from. Each module holds its own context — a generic
      // throwaway OffscreenCanvas wouldn't cover them.
      PrimeFontInSharedCtx(m.Family, weight, style);
      PrimeFontInMeasureCtx(m.Family, weight, style);
      // Per-font-face load log used to print here on every webfont arrival —
      // 25+ lines per cold load. Removed unconditionally; if a font fails
      // to load, the canvas falls back to the next family in the stack and
      // the visual difference is what users would notice, not a console
      // line. Re-add behind a guard if a real diagnostic need shows up.
      // Trigger the engine's font-load handler — flushes the glyph atlas
      // and marks all text dirty so layout re-measures with the newly
      // available font metrics. Without this, text was sized against
      // the fallback font (narrower) at first paint, then the real font
      // rasterized wider into the same box → clipping on the right edge.
      this._platform?.IngestMessage({ T: 'fonts-done' });
      this._canvas?.Animations.Kick();
    }).catch((err) => {
      console.warn(`[Jaui.Worker] FontFace load FAILED: ${m.Family}`, err);
    });
  };

  private _onJivOps = (m: M2W_JivOps): void => {
    if (!this._registry) return;
    this._registry.ApplyOps(m);
    // After any tree op, wake the animation tick so the new state actually
    // animates — without this, idle Spring targets sit unrealized until
    // some external event happens to ping the loop.
    this._canvas?.Animations.Kick();
  };

  private _onImageUrl = (m: M2W_ImageLoadUrl): void => {
    this._canvas?.Images.LoadUrl(m.Url, m.Dpr);
  };
  private _onImageSvg = (m: M2W_ImageLoadSvg): void => {
    this._canvas?.Images.LoadSvg(m.Key, m.Svg, m.Width, m.Height, m.Dpr);
  };
  private _onKick = (): void => {
    this._canvas?.Animations.Kick();
  };

  private _onJanvasInput = (m: M2W_JanvasInput): void => {
    if (!this._registry) return;
    this._registry.RouteJanvasInput(m.JivId, m.Channel, m.Payload);
    // Hot per-frame inputs (camera, marchers) imply a dirty scene; the
    // engine's Janvas dirty flag is what triggers Render. Renderers can
    // also call markDirty() themselves inside `Input`, but kicking here
    // covers renderers that just stash the payload for the next frame.
    this._canvas?.Animations.Kick();
  };

  /** Outbound helper for worker-side renderers (or services they route
   *  through) that need to surface state back to main. Renderers don't
   *  hold a PostFn directly — the registry hands them a closure that
   *  forwards through this method, so the wire shape stays internal. */
  PostJanvasEvent = (jivId: number, channel: string, payload: unknown,
                     transfer?: Transferable[]): void => {
    this._post({ T: 'janvas-event', JivId: jivId, Channel: channel, Payload: payload }, transfer);
  };

  // ─── Inbound dispatchers ───────────────────────────────────────────────

  private _onPointer = (m: M2W_PointerEvent): void => {
    if (!this._canvas) return;
    const synth = this._toSynthPointer(m.Payload, m.Coalesced);
    this._canvas.IngestEvent(m.Kind, synth);
  };

  private _onWheel = (m: M2W_WheelEvent): void => {
    if (!this._canvas) return;
    const synth = this._toSynthWheel(m.Payload);
    this._canvas.IngestEvent('wheel', synth);
  };

  private _onTouchStart = (): void => {
    if (!this._canvas) return;
    // touchstart's only role is `preventDefault()` on Chrome Android
    // (long-press magnifier suppression). Main has already preventDefault'd
    // on its end before forwarding. Engine handlers just want to know
    // it happened.
    this._canvas.IngestEvent('touchstart', {
      preventDefault: () => {}, stopPropagation: () => {},
    });
  };

  private _onContextMenu = (m: M2W_ContextMenu): void => {
    if (!this._canvas) return;
    const synth = this._toSynthPointer(m.Payload);
    // contextmenu's preventDefault matters — main already called it,
    // so we expose a no-op to handlers.
    this._canvas.IngestEvent('contextmenu', synth);
  };

  private _onResize = (m: M2W_Resize): void => {
    if (!this._canvas) return;
    // Re-use Canvas's existing resize plumbing: write into the same
    // _pendingResize slot the ResizeObserver path filled. The engine's
    // public Resize entry isn't typed for this; we use the bridge-friendly
    // public ResizeFromBridge helper added on Canvas.
    this._canvas.ResizeFromBridge(m.Width, m.Height);
  };

  private _onJssVars = (m: M2W_JssVars): void => {
    if (!this._canvas) return;
    this._canvas.SetJssVars(new Map(m.Entries));
  };

  private _onControl = (m: M2W_Control): void => {
    if (!this._canvas) return;
    if (m.Action === 'start') this._canvas.Start();
    else this._canvas.Stop();
  };

  // ─── Synth event construction ─────────────────────────────────────────

  private _toSynthPointer = (
    p: PointerPayload,
    coalesced?: PointerPayload[],
  ): SynthPointerEvent => {
    const synth: SynthPointerEvent = {
      pointerId: p.PointerId,
      pointerType: p.PointerType,
      clientX: p.X, // already canvas-local (bridge pre-translated)
      clientY: p.Y,
      button: p.Button,
      buttons: p.Buttons,
      shiftKey: p.Shift,
      ctrlKey: p.Ctrl,
      altKey: p.Alt,
      metaKey: p.Meta,
      timeStamp: p.TimeStamp,
      preventDefault: () => {}, // main already decided
      stopPropagation: () => {},
      getCoalescedEvents: () => coalesced
        ? coalesced.map(c => this._toSynthPointer(c))
        : [],
    };
    return synth;
  };

  private _toSynthWheel = (p: WheelPayload): SynthWheelEvent => {
    const base = this._toSynthPointer(p);
    return {
      ...base,
      deltaX: p.DeltaX,
      deltaY: p.DeltaY,
      deltaMode: p.DeltaMode,
    };
  };
}

/** Build a `WorkerPlatformInit` from an init message. Helper for the
 *  worker entry so it doesn't have to remember the field mapping. */
export const PlatformInitFromMessage = (m: M2W_Init): WorkerPlatformInit => ({
  Dpr: m.DevicePixelRatio,
  IsPointerCoarse: m.IsPointerCoarse,
  IsTextInputFocused: false, // main pushes a focus update separately
  UrlSearch: m.UrlSearch,
  UrlHash: m.UrlHash,
  FontsAlreadyReady: m.FontsAlreadyReady,
});
