/**
 * Bridge.Types — postMessage protocol between the Angular host (main thread)
 * and the Jaui worker. Both sides import these types so the protocol is
 * type-checked end-to-end.
 *
 * Direction:
 *   M2W = main → worker
 *   W2M = worker → main
 *
 * Wire shape: every message is `{ T: <kind>, ...payload }`. `T` keeps the
 * tag short on hot per-frame paths (pointermove can fire 1000/s on a
 * pen device).
 */

import type { SvgVectorPaint } from '../Svg/Svg.VectorPaint';

// ─── Main → Worker ────────────────────────────────────────────────────────

/** Canvas + initial Platform state. The OffscreenCanvas is transferred,
 *  so this message is one-shot — main loses access to that canvas's
 *  rendering context after the post. */
export interface M2W_Init {
  T: 'init';
  Canvas: OffscreenCanvas;
  /** Initial CSS-pixel size (pulled from a synchronous getBoundingClientRect
   *  on the host element before transfer). Avoids the worker rendering at
   *  zero size for the first frame while the ResizeObserver warms up. */
  Width: number;
  Height: number;
  /** Initial devicePixelRatio. Subsequent changes ride on M2W_DprChange. */
  DevicePixelRatio: number;
  /** Initial `(pointer: coarse)` match — used to clamp DPR ≤ 2 on touch
   *  primary devices so the engine doesn't oversize the backing store. */
  IsPointerCoarse: boolean;
  /** URL search/hash captured at boot (the worker can't read window.location
   *  directly, but the engine's debug flags live there). */
  UrlSearch: string;
  UrlHash: string;
  /** Snapshot of `document.fonts` ready state at boot. The worker still
   *  receives `M2W_FontsLoadingDone` on subsequent loads. */
  FontsAlreadyReady: boolean;
}

/** Normalized pointer event (covers pointermove/down/up/cancel/leave/enter). */
export interface PointerPayload {
  /** PointerEvent.pointerId. Stable across move/up for the same touch. */
  PointerId: number;
  /** 'mouse' | 'pen' | 'touch'. */
  PointerType: string;
  /** Canvas-local CSS pixel coords (clientX/Y minus canvas page-rect).
   *  Pre-translated on the main thread because the worker has no access
   *  to getBoundingClientRect. */
  X: number;
  Y: number;
  /** Original page-coord clientX/Y, kept for any logic that compares
   *  against a saved start coord across coordinate-system changes. */
  ClientX: number;
  ClientY: number;
  Buttons: number;
  Button: number;
  Shift: boolean;
  Ctrl: boolean;
  Alt: boolean;
  Meta: boolean;
  /** event.timeStamp in main-thread time — convertible via the
   *  performance.now skew (each thread has its own time origin). */
  TimeStamp: number;
}

/** Wheel event payload — adds delta + mode to the pointer fields. */
export interface WheelPayload extends PointerPayload {
  DeltaX: number;
  DeltaY: number;
  /** 0 = pixel, 1 = line, 2 = page. */
  DeltaMode: number;
}

/** Keyboard event payload — keydown / keyup. */
export interface KeyPayload {
  Key: string;
  Code: string;
  Repeat: boolean;
  Shift: boolean;
  Ctrl: boolean;
  Alt: boolean;
  Meta: boolean;
  TimeStamp: number;
}

/** A batched pointer-input message — one per main-thread event tick.
 *  `Coalesced` carries pointermove samples between successive events
 *  (PointerEvent.getCoalescedEvents()), so the worker's velocity tracker
 *  / ink renderer / scroller all see every sample even when rAF is slow. */
export interface M2W_PointerEvent {
  T: 'pointer';
  Kind: 'pointermove' | 'pointerdown' | 'pointerup' | 'pointercancel'
      | 'pointerleave' | 'pointerenter';
  Payload: PointerPayload;
  Coalesced?: PointerPayload[];
}

export interface M2W_WheelEvent {
  T: 'wheel';
  Payload: WheelPayload;
}

export interface M2W_TouchStart {
  T: 'touchstart';
  // touchstart's only role today is to call preventDefault() on Chrome
  // Android to suppress the long-press magnifier; the actual gesture
  // tracking comes from pointerdown. So the worker doesn't need
  // coordinates here — just a heads-up.
}

export interface M2W_ContextMenu {
  T: 'contextmenu';
  Payload: PointerPayload;
}

/** An interactive component on main (a text input's selection-handle drag)
 *  claims a pointer: the engine's scroll drag for that pointer must stop,
 *  momentum-free, and ignore its remaining moves. */
export interface M2W_GestureClaim {
  T: 'gestureclaim';
  PointerId: number;
}

export interface M2W_KeyDown {
  T: 'keydown';
  Payload: KeyPayload;
}

/** ResizeObserver delivered a new contentRect. Width/Height are CSS px. */
export interface M2W_Resize {
  T: 'resize';
  Width: number;
  Height: number;
}

/** matchMedia '(resolution: Ndppx)' fired — DPR changed. */
export interface M2W_DprChange {
  T: 'dpr';
  DevicePixelRatio: number;
}

/** matchMedia '(pointer: coarse)' state changed (rare — happens when a
 *  user docks a tablet or plugs in a mouse that flips the primary pointer). */
export interface M2W_CoarseChange {
  T: 'coarse';
  IsPointerCoarse: boolean;
}

/** document.activeElement focus state changed — main pushes whether a real
 *  text input/textarea/contenteditable currently has focus, so the worker's
 *  selection-key handler can suppress when typing into a DOM input. */
export interface M2W_FocusChange {
  T: 'focus';
  IsTextInputFocused: boolean;
}

/** document.fonts.loadingdone fired — flush glyph atlas. */
export interface M2W_FontsLoadingDone {
  T: 'fonts-done';
}

/** JssRegistry pushed an updated var table. */
export interface M2W_JssVars {
  T: 'jss-vars';
  /** Map serialized as key/value pairs (Map can't structured-clone in
   *  every TS lib version reliably; entries are universal). */
  Entries: [string, string][];
}

/** Lifecycle: Start = begin rAF, Stop = pause. */
export interface M2W_Control {
  T: 'control';
  Action: 'start' | 'stop';
}

// ─── Jiv tree ops ─────────────────────────────────────────────────────────
//
// The Angular `<jiv>` component on main holds a `JivHandle` — an opaque
// numeric id + a buffered command stream. Property writes don't construct
// or mutate a Jiv on main; they enqueue ops that flush once per Angular CD
// inside an `M2W_JivOps` message. The worker reconstructs the tree by
// applying ops to a `Map<id, JivCore>` registry. Id `0` is reserved for
// `Canvas.Root` (created automatically by the worker entry).

/** Subset of JivCore options that ride the bridge. The full JivStyle /
 *  LayoutConfig / ChildLayout / TextStyle / SpringConfig types from Jaui
 *  core all structured-clone — they're plain data — so we just pass them
 *  by shape, not by import. The `ElementProps` bucket carries Element-
 *  level props (Overflow, Visible, etc.) that JSS may have placed in
 *  Style; the Angular layer extracts them, and the worker re-applies
 *  them to the JivCore element rather than the Style bag. */
export interface JivApplyOpts {
  Style?: Record<string, unknown>;
  Layout?: Record<string, unknown>;
  ChildLayout?: Record<string, unknown>;
  TextStyle?: Record<string, unknown>;
  /** Compound pseudo-predicate rules — `Name:(expr) { ... }` from JSS.
   *  Each entry's Predicate is a JSON-safe boolean AST (State / Not /
   *  And / Or) the worker evaluates against the Jiv's live state set
   *  via EvaluatePredicate. Plain data — structured-clones unchanged.
   *  Pass `null` to clear the list (used on class-swap when the new
   *  class has no predicate rules). */
  PredicateStyles?: ReadonlyArray<Record<string, unknown>> | null;
  /** Boolean state toggles applied to the Jiv. Keys are PascalCase state
   *  names (Disabled, Loading, Recording, anything author-named); values
   *  are the desired on/off. Pointer-driven states (Hover/Active/Focus/
   *  GroupHover) ride their own typed setters on the engine side — they
   *  are NOT exposed through this map, because their value is derived
   *  from pointer events the worker already owns. */
  States?: Record<string, boolean>;
  /** Author style vars (`@Name`) applied to the Jiv — keys are var names, values are string/number/
   *  boolean. Read by `Var` predicates (`@If (@Open) { … }`, `@If (@Mode == 'x') { … }`). Distinct from
   *  States: these are author-driven conditional values, not interaction pseudo-states. */
  Vars?: Record<string, string | number | boolean>;
  /** Class names this Jiv carries (parsed from `class="A B C"`). Worker
   *  registers it under each entry that's a group-hover trigger so the
   *  hover dispatcher can fan `_groupHover` out to peers. */
  GroupTriggerClasses?: readonly string[];
  Springs?: Record<string, Record<string, unknown>>;
  /** `@Animation` applications declared on this Jiv's class. Each entry
   *  is either a `{ Kind: 'Named', Name }` reference resolved against
   *  `AnimationTable`, or a `{ Kind: 'Inline', Property, Definition }`
   *  inline anonymous animation. Both are plain data and survive
   *  structured-clone unchanged. */
  Animations?: Array<Record<string, unknown>>;
  /** Stylesheet-wide named animation definitions keyed by name. Sent on
   *  every apply for now (small table, deterministic); the worker just
   *  stashes a reference on the Jiv so its driver can resolve named
   *  applications. A future optimization could ship this once via a
   *  separate channel and reference by id. */
  AnimationTable?: Record<string, Record<string, unknown>>;
  Text?: string | null;
  ElementProps?: {
    Overflow?: 'Visible' | 'Hidden' | 'Scroll';
    Clip?: 'Auto' | 'Hidden' | 'Visible';
    Visible?: boolean;
    Interactive?: boolean;
    PointerEvents?: 'Auto' | 'None';
    Cursor?: 'Default' | 'Pointer' | 'Text' | 'Move' | 'None';
    UserSelect?: 'Auto' | 'None';
    PointScale?: string;
    /** When true, the next layout commit snaps to the resolved rect with no
     *  spring animation. Set on jinput text segments so paste / token-driven
     *  re-segmentation lands at the final X/Y instantly instead of drifting
     *  between rows from the previous slot. */
    SnapLayout?: boolean;
  };
}

/** One op in a JivOps batch. Discriminated by `K` (kind). */
export type JivOp =
  | { K: 'create'; Id: number; Opts: JivApplyOpts }
  | { K: 'attach'; ChildId: number; ParentId: number }
  | { K: 'apply'; Id: number; Opts: JivApplyOpts }
  | { K: 'leave'; Id: number }      // soft (Presence fade)
  | { K: 'destroy'; Id: number }    // hard (immediate remove)
  | { K: 'watch-rect'; Id: number; Watch: boolean }
  /** Reorder a child within its parent's Children array. Used by Jwift
   *  Toolbar (compact slot pushed to front), drag-reorder, etc. — any
   *  consumer that previously did `Node.Children.unshift(...)` directly. */
  | { K: 'move-child'; ParentId: number; ChildId: number; NewIndex: number }
  /** Promote an existing Jiv to a Janvas + bind a registered worker-side
   *  renderer factory to it. The factory is looked up in the worker's
   *  JanvasRendererRegistry (populated at worker boot by show-studio's
   *  custom worker entry). `Config` is structured-cloned and handed to
   *  the factory at construction time. Issued *after* `create`, *before*
   *  `attach`, so the engine first sees the node as a Janvas. */
  | { K: 'janvas-attach'; Id: number; Key: string; Config?: unknown }
  /** Attach cached vector-SVG geometry (tessellated fills/strokes) to a Jiv, so
   *  it renders as real GPU geometry instead of a rasterized background image.
   *  `Paint` is built on the main thread (DOM parse + tessellation) and the
   *  Float32Arrays are structured-cloned across to the worker. */
  | { K: 'svg-set'; Id: number; Paint: SvgVectorPaint }
  | { K: 'svg-clear'; Id: number };

/** Batched Jiv tree ops, flushed once per Angular CD on main. Ordering is
 *  significant: a `create` must precede the `attach` that places it. */
export interface M2W_JivOps {
  T: 'jiv-ops';
  Ops: JivOp[];
}

// ─── Image cache ops ─────────────────────────────────────────────────────
//
// Some main-side consumers (Navigation, NavAvatar) call `Canvas.Images.LoadSvg`
// directly to inject SVG content into the engine's image cache. The
// CanvasProxy on main forwards those calls as messages.

export interface M2W_ImageLoadUrl {
  T: 'image-url';
  Url: string;
  Dpr: number;
}

/** Debug/screenshot: request a PNG capture of the next rendered frame. */
export interface M2W_Capture {
  T: 'capture';
}

export interface M2W_ImageLoadSvg {
  T: 'image-svg';
  Key: string;
  Svg: string;
  Width: number;
  Height: number;
  Dpr: number;
}

/** Pre-rasterized image (typically an SVG decoded on main thread, since
 *  Chrome workers can't decode SVG via `createImageBitmap`). The worker
 *  uploads the bitmap straight to the image cache. */
export interface M2W_ImageBitmap {
  T: 'image-bitmap';
  Key: string;
  Bitmap: ImageBitmap;
}

/** Mirror a main-thread FontFace into the worker's `self.fonts` so text
 *  rendered on the worker side resolves the correct glyph metrics.
 *
 *  The font binary is fetched on main and shipped as a transferred
 *  ArrayBuffer. Single path, by design — WebKit workers can't fetch
 *  cross-origin fonts (Safari blocks `new FontFace(family, url).load()`
 *  for cross-origin URLs in DedicatedWorkerGlobalScope), so any URL-based
 *  fallback would diverge cross-browser. Going through main is the only
 *  consistent path. */
export interface M2W_FontFace {
  T: 'font-face';
  Family: string;
  /** Pre-fetched font binary — transferred zero-copy. Main loses access. */
  Buffer: ArrayBuffer;
  Descriptors?: {
    Weight?: string;
    Style?: string;
    Stretch?: string;
    Display?: string;
    UnicodeRange?: string;
  };
}

/** Wake the worker's animation manager — equivalent of the old
 *  `Canvas.Animations.Kick()` on main. The worker calls Kick locally after
 *  applying any state-changing op, so this message is mostly redundant;
 *  it exists for callers that want belt-and-suspenders. */
export interface M2W_Kick {
  T: 'kick';
}

/** Push state into a worker-side renderer by named channel. Top-level
 *  rather than a JivOp because hot data (camera transform, marcher
 *  poses) shouldn't wait for the Angular CD-flushed jiv-ops batch. The
 *  worker registry forwards `{Channel, Payload}` to the renderer's
 *  `Input` method. Reality services bypass `<jaui>`'s CD entirely and
 *  post these straight through `Canvas.Bridge`. */
export interface M2W_JanvasInput {
  T: 'janvas-input';
  JivId: number;
  Channel: string;
  Payload: unknown;
}

/** Main → worker liveness probe (the eviction watchdog). A live worker answers `pong`. */
export interface M2W_Ping {
  T: 'ping';
}

export type M2W =
  | M2W_Init
  | M2W_Ping
  | M2W_PointerEvent
  | M2W_WheelEvent
  | M2W_TouchStart
  | M2W_ContextMenu
  | M2W_GestureClaim
  | M2W_KeyDown
  | M2W_Resize
  | M2W_DprChange
  | M2W_CoarseChange
  | M2W_FocusChange
  | M2W_FontsLoadingDone
  | M2W_JssVars
  | M2W_Control
  | M2W_JivOps
  | M2W_ImageLoadUrl
  | M2W_ImageLoadSvg
  | M2W_ImageBitmap
  | M2W_FontFace
  | M2W_Kick
  | M2W_JanvasInput
  | M2W_Capture;

// ─── Worker → Main ────────────────────────────────────────────────────────

/** Worker has constructed Canvas and is ready to receive events. Main
 *  starts forwarding only after this fires (queued events would drop
 *  on the floor before init completes anyway). */
export interface W2M_Ready {
  T: 'ready';
}

/** Cursor relay — worker's hit-test resolved a cursor; main applies it
 *  to the proxy element's `style.cursor`. Empty string = reset. */
export interface W2M_Cursor {
  T: 'cursor';
  Cursor: string;
}

/** Worker requested setPointerCapture / releasePointerCapture on the
 *  proxy element. Main is the only side with a real DOM target for these. */
export interface W2M_PointerCapture {
  T: 'capture';
  Action: 'set' | 'release';
  PointerId: number;
}

/** Worker fired an OnClick / OnPointerDown / etc. callback that needs to
 *  surface to Angular's `(click)` / `(pointerdown)` event bindings on the
 *  main-side host element. Main rebuilds a synthetic DOM event and
 *  dispatches it on the right `<jiv>` host. */
export interface W2M_HitEvent {
  T: 'hit';
  /** Worker-side Jiv id whose handler fired. Maps to the Angular Jiv
   *  component's host element. */
  JivId: number;
  Kind: 'click' | 'contextmenu' | 'pointerdown' | 'pointermove' | 'pointerup' | 'wheel';
  /** Original event payload so the synthetic event carries faithful
   *  clientX/Y/buttons/etc. for downstream listeners. For `wheel` kind this
   *  is a `WheelPayload` (carries DeltaX/Y/Mode) — main narrows on Kind. */
  Source: PointerPayload;
}

/** Per-frame Jiv geometry snapshot for nodes the main side has subscribed
 *  to (e.g. `<jinput>` reading wrap.Width). Posted only when subscribed
 *  rect changes, not every frame. */
export interface W2M_RectSnapshot {
  T: 'rect';
  JivId: number;
  X: number;
  Y: number;
  Width: number;
  Height: number;
}

/** HUD stats stream (debug-only). Worker emits when ?debug enabled. */
export interface W2M_HudStats {
  T: 'hud';
  Lines: string[];
}

/** Worker requested re-rasterization of an SVG image at higher DPR
 *  (browser zoom changed). Main side may need to coordinate a Jss var
 *  refresh; usually a no-op acknowledgement. */
export interface W2M_SvgRerasterize {
  T: 'svg-rerasterize';
  Dpr: number;
}

/** Worker-side renderer (or the service it routes through) wants to push
 *  state back to its main-side counterpart — picked picked-up dot, recording
 *  finished, scene loaded, etc. JivId identifies which Janvas's renderer
 *  fired; Channel namespaces by intent (e.g. 'reality:loaded',
 *  'reality:selection'); Payload is whatever the renderer chose to send. */
export interface W2M_JanvasEvent {
  T: 'janvas-event';
  JivId: number;
  Channel: string;
  Payload: unknown;
}

/** Worker-side rAF cadence sample. Posted once every ~250ms so main can
 *  surface a reliable worker-FPS readout without flooding the bridge.
 *  Avg/Min are computed over the last 1-second window of frame stamps. */
export interface W2M_FpsSample {
  T: 'fps';
  Avg: number;
  Min: number;
  /** Frame index since boot — handy for diagnosing dropped reports. */
  Frame: number;
}

/** Plain-text mirror of the worker's current text selection. Posted whenever
 *  the SelectionManager's range changes (including cleared). Main caches the
 *  string so the native `copy` event handler can write it to clipboardData
 *  synchronously — `navigator.clipboard.writeText` from inside the worker
 *  silently fails because transient activation doesn't survive postMessage. */
export interface W2M_SelectionText {
  T: 'selection-text';
  /** Concatenated plaintext across all selected text Jivs, joined with
   *  newlines across Jiv boundaries. Empty string when selection is cleared. */
  Text: string;
}

/** Worker → main: reply to a `ping` — proves the worker is alive (not evicted). */
export interface W2M_Pong {
  T: 'pong';
}

/** Worker → main: the WebGL context was lost. The watchdog starts its restore clock. */
export interface W2M_ContextLost {
  T: 'context-lost';
}

/** Worker → main: the WebGL context was restored IN PLACE — in-worker recovery succeeded. */
export interface W2M_ContextRestored {
  T: 'context-restored';
}

export type W2M =
  | W2M_Ready
  | W2M_Cursor
  | W2M_PointerCapture
  | W2M_HitEvent
  | W2M_RectSnapshot
  | W2M_HudStats
  | W2M_SvgRerasterize
  | W2M_JanvasEvent
  | W2M_FpsSample
  | W2M_SelectionText
  | W2M_Pong
  | W2M_ContextLost
  | W2M_ContextRestored
  | W2M_CaptureResult;

/** Debug/screenshot: the captured PNG (null on failure). */
export interface W2M_CaptureResult {
  T: 'capture-result';
  Blob: Blob | null;
}

// ─── Helpers shared by both sides ─────────────────────────────────────────

/** Type narrower for incoming messages on either side. */
export const isMessage = <T extends { T: string }>(
  msg: unknown, tag: T['T'],
): msg is T => {
  return typeof msg === 'object' && msg !== null && (msg as { T: unknown }).T === tag;
};
