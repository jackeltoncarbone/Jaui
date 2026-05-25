/**
 * JivHandle — main-thread proxy for a worker-side JivCore.
 *
 * Worker-only architecture: the Angular `<jiv>` component holds one of
 * these in its `Node` slot. The handle preserves the ergonomic surface
 * of the engine `Jiv` so consumer code that does
 *
 *     this._foo()?.Node.ChildLayout.Width = '50%';
 *     this._foo()?.Node.MarkLayoutDirty();
 *     parent.AddChild(this.Node);
 *
 * keeps working. Property writes are intercepted (Style / Layout /
 * ChildLayout are Proxy objects) and buffered into a single `apply` op
 * that flushes once per microtask — so a flurry of writes in the same
 * tick produces one postMessage.
 *
 * Reads of geometry (X / Y / Width / Height / ScrollX / ScrollY) come
 * from the most recent W2M_RectSnapshot. Without an active `WatchRect`
 * subscription, those reads return 0. Code that walks the tree
 * (`<reality-view>` ancestor chain) calls `WatchRect(true)` on the
 * nodes whose rects it needs.
 *
 * Tree state (Parent / Children) is mirrored on main alongside the
 * worker tree, so consumers can walk it without bridge round-trips.
 */

import type { MainBridge, JivHitHandlers } from './Bridge.Main';
import type { JivApplyOpts, PointerPayload, WheelPayload } from './Bridge.Types';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { ChildLayout, LayoutConfig } from '../Layout/Layout.Types';
import type { TextStyle } from '../Text/Text.Types';

export class JivHandle {
  readonly Id: number;
  private _bridge: MainBridge;

  // ─── Tree (locally maintained mirror of the worker's tree) ─────────────
  Parent: JivHandle | null = null;
  Children: JivHandle[] = [];

  // ─── Geometry (populated by W2M_RectSnapshot when WatchRect(true)) ─────
  X = 0;
  Y = 0;
  Width = 0;
  Height = 0;
  ScrollX = 0;
  ScrollY = 0;
  ScrollTargetX = 0;
  ScrollTargetY = 0;
  ContentWidth = 0;
  ContentHeight = 0;

  // ─── Interaction state (mirrored from worker hover/active/focus events) ─
  /** True while the pointer is over this Jiv (or descendant). Worker pushes
   *  on hover-state change. Default false. */
  Hover = false;
  /** True while a pointer is held down on this Jiv. */
  Active = false;
  /** True while this Jiv has focus. */
  Focus = false;
  // `Disabled` lives below as a get/set pair on the _states mirror — it
  // drives compound predicate rules and the reserved-defaults setter on
  // the worker side, rather than being a passive field.

  // ─── Element-level props ───────────────────────────────────────────────
  private _visible = true;
  private _interactive = true;
  private _pointerEvents: 'Auto' | 'None' = 'Auto';
  private _cursor: 'Default' | 'Pointer' | 'Text' | 'Move' | 'None' = 'Default';
  private _userSelect: 'Auto' | 'None' = 'Auto';
  private _overflow: 'Visible' | 'Hidden' | 'Scroll' = 'Visible';
  private _pointScale = '';
  private _snapLayout = false;

  // ─── Style buckets — Proxy objects so imperative writes are captured ──
  private _styleState: Record<string, unknown> = {};
  private _layoutState: Record<string, unknown> = {};
  private _childLayoutState: Record<string, unknown> = {};
  /** Pseudo-selector rules from JSS — both tight `:Foo` and compound
   *  `:(expr)` forms compile to PredicateStyle entries during parse. */
  private _predicateStyles: ReadonlyArray<Record<string, unknown>> | null = null;
  /** User-driven state set mirror. Keys are PascalCase state names
   *  (Disabled, Loading, Recording, etc.); values are always `true` (entries
   *  are deleted when a state turns off). Pointer-driven states live on
   *  the worker, not here. */
  private _states: Record<string, boolean> = {};
  private _textStyleState: Record<string, unknown> = {};
  private _text: string | null = null;

  // Strongly-typed proxies — matches the engine `Jiv` surface so consumer
  // code that does `Node.ChildLayout.Width = '50%'` compiles cleanly.
  // The Proxy is created over a Record-typed backing object; the public
  // type is the rich JivStyle / LayoutConfig / ChildLayout / TextStyle
  // so reads/writes pick up real field names.
  Style: JivStyle;
  Layout: LayoutConfig;
  ChildLayout: ChildLayout;
  TextStyle: TextStyle;
  /** Engine "RenderStyle" — read-only stub for consumer compat
   *  (`comp.Node.RenderStyle.Layer`). Sources from the Style bucket
   *  if a Layer was set there; otherwise 0. */
  get RenderStyle(): { Layer: number } {
    const layer = (this._styleState['Layer'] as number) ?? 0;
    return { Layer: typeof layer === 'number' ? layer : 0 };
  }

  // ─── Hit handlers (route through bridge.SetHitHandlers) ────────────────
  private _hit: JivHitHandlers = {};

  // ─── Dirty tracking for buffered apply ─────────────────────────────────
  private _dirty = false;
  private _watching = false;

  constructor(bridge: MainBridge, id: number) {
    this._bridge = bridge;
    this.Id = id;

    // Proxy each style bucket so imperative writes (e.g.
    // `node.ChildLayout.Width = '50%'`) update the local mirror AND
    // schedule a flush. The microtask flush coalesces a burst of
    // writes into one apply op.
    this.Style = this._makeProxy(this._styleState) as unknown as JivStyle;
    this.Layout = this._makeProxy(this._layoutState) as unknown as LayoutConfig;
    this.ChildLayout = this._makeProxy(this._childLayoutState) as unknown as ChildLayout;
    this.TextStyle = this._makeProxy(this._textStyleState) as unknown as TextStyle;

    // Wire the bridge to call our local hit handlers AND keep our cached
    // rect (X/Y/Width/Height/ScrollX/ScrollY) up to date when we're
    // subscribed. JivHitHandlers.OnRectSnapshot is mutual: the bridge
    // calls it and we update the cache.
    bridge.SetHitHandlers(id, {
      OnRectSnapshot: ({ X, Y, Width, Height }) => {
        this.X = X; this.Y = Y; this.Width = Width; this.Height = Height;
      },
    });
  }

  // ─── Element-level setters/getters (each posts an apply op) ────────────

  get Visible(): boolean { return this._visible; }
  set Visible(v: boolean) { if (this._visible !== v) { this._visible = v; this._markDirty(); } }

  get Interactive(): boolean { return this._interactive; }
  set Interactive(v: boolean) { if (this._interactive !== v) { this._interactive = v; this._markDirty(); } }

  get PointerEvents(): 'Auto' | 'None' { return this._pointerEvents; }
  set PointerEvents(v: 'Auto' | 'None') { if (this._pointerEvents !== v) { this._pointerEvents = v; this._markDirty(); } }

  get Cursor(): 'Default' | 'Pointer' | 'Text' | 'Move' | 'None' { return this._cursor; }
  set Cursor(v: 'Default' | 'Pointer' | 'Text' | 'Move' | 'None') { if (this._cursor !== v) { this._cursor = v; this._markDirty(); } }

  get UserSelect(): 'Auto' | 'None' { return this._userSelect; }
  set UserSelect(v: 'Auto' | 'None') { if (this._userSelect !== v) { this._userSelect = v; this._markDirty(); } }

  get Overflow(): 'Visible' | 'Hidden' | 'Scroll' { return this._overflow; }
  set Overflow(v: 'Visible' | 'Hidden' | 'Scroll') { if (this._overflow !== v) { this._overflow = v; this._markDirty(); } }

  get PointScale(): string { return this._pointScale; }
  set PointScale(v: string) { if (this._pointScale !== v) { this._pointScale = v; this._markDirty(); } }

  get SnapLayout(): boolean { return this._snapLayout; }
  set SnapLayout(v: boolean) { if (this._snapLayout !== v) { this._snapLayout = v; this._markDirty(); } }

  get Text(): string | null { return this._text; }
  set Text(v: string | null) { if (this._text !== v) { this._text = v; this._markDirty(); } }

  // Compound-pseudo predicate list. Set as a whole-list replacement
  // (typically once per class application by JssRegistry). Each entry
  // is { Predicate, Style?, TextStyle? } as plain data — the worker
  // evaluates predicates against the live state set.
  get PredicateStyles(): ReadonlyArray<Record<string, unknown>> | null { return this._predicateStyles; }
  set PredicateStyles(v: ReadonlyArray<Record<string, unknown>> | null | undefined) {
    this._predicateStyles = v ?? null;
    this._markDirty();
  }

  // Live user-driven state set on the main thread. Predicate evaluation
  // happens on the worker, but the main side mirrors the latest values
  // so subsequent flushes ship the full set in one op. Pointer-driven
  // states (Hover/Active/Focus/GroupHover) don't ride this map — they
  // live entirely on the worker, driven by hit events.
  get Disabled(): boolean { return !!this._states['Disabled']; }
  set Disabled(v: boolean) { this.SetState('Disabled', v); }

  /** Toggle a user-driven state. Used by Angular `[disabled]` and any
   *  future `[loading]` / `[recording]` style inputs. Pointer-driven
   *  states (Hover/Active/Focus/GroupHover) should not be set through
   *  here — they're managed on the worker side. Idempotent: setting a
   *  state to its current value is a no-op (no flush). */
  SetState = (name: string, on: boolean): void => {
    const has = !!this._states[name];
    if (has === on) return;
    if (on) this._states[name] = true; else delete this._states[name];
    this._markDirty();
  };

  // ─── Hit-handler setters (each refreshes the bridge's hit map) ─────────

  set OnClick(cb: (() => void) | null | undefined) {
    this._hit.OnClick = cb ?? undefined;
    this._refreshHit();
  }
  set OnContextMenu(cb: ((src: PointerPayload) => void) | null | undefined) {
    this._hit.OnContextMenu = cb ?? undefined;
    this._refreshHit();
  }
  set OnPointerDown(cb: ((src: PointerPayload) => void) | null | undefined) {
    this._hit.OnPointerDown = cb ?? undefined;
    this._refreshHit();
  }
  set OnPointerMove(cb: ((src: PointerPayload) => void) | null | undefined) {
    this._hit.OnPointerMove = cb ?? undefined;
    this._refreshHit();
  }
  set OnPointerUp(cb: ((src: PointerPayload) => void) | null | undefined) {
    this._hit.OnPointerUp = cb ?? undefined;
    this._refreshHit();
  }
  set OnWheel(cb: ((src: WheelPayload) => void) | null | undefined) {
    this._hit.OnWheel = cb ?? undefined;
    this._refreshHit();
  }

  // ─── Tree methods ──────────────────────────────────────────────────────

  AddChild = (child: JivHandle): void => {
    if (child.Parent === this) return;
    if (child.Parent) child.Parent.RemoveChild(child);
    this.Children.push(child);
    child.Parent = this;
    this._bridge.Enqueue({ K: 'attach', ChildId: child.Id, ParentId: this.Id });
  };

  RemoveChild = (child: JivHandle): void => {
    const i = this.Children.indexOf(child);
    if (i < 0) return;
    this.Children.splice(i, 1);
    child.Parent = null;
    // Detach is conveyed via a hard `destroy` op when the child wants it.
    // Here we just keep the tree state consistent on main.
  };

  /** Reorder a child to a new position within this Jiv's Children. Updates
   *  the local mirror and posts a `move-child` op so the worker's tree
   *  matches. Used by Jwift Toolbar (compact slot to leading position),
   *  drag-reorder, and any consumer that previously mutated
   *  `Node.Children.unshift(...)` directly. */
  MoveChildToIndex = (child: JivHandle, newIndex: number): void => {
    const cur = this.Children.indexOf(child);
    if (cur < 0) return;
    this.Children.splice(cur, 1);
    const idx = Math.max(0, Math.min(this.Children.length, newIndex));
    this.Children.splice(idx, 0, child);
    this._bridge.Enqueue({
      K: 'move-child', ParentId: this.Id, ChildId: child.Id, NewIndex: idx,
    });
  };

  /** No-op: the worker auto-marks layout dirty after applying any op.
   *  Kept for consumer-source compatibility with engine `Jiv` calls. */
  MarkLayoutDirty = (): void => {
    // Buffered apply-op already triggers a layout recompute on the worker.
    if (this._dirty) return;
    this._markDirty();
  };

  /** Soft-destroy: trigger the Presence fade-out on the worker. */
  RequestLeave = (): void => {
    this._bridge.Enqueue({ K: 'leave', Id: this.Id });
  };

  /** Hard-remove + drop registry entry. */
  Destroy = (): void => {
    this._bridge.Enqueue({ K: 'destroy', Id: this.Id });
    this._bridge.ClearHitHandlers(this.Id);
  };

  /** Subscribe / unsubscribe to per-frame rect snapshots. */
  WatchRect = (watch: boolean): void => {
    if (this._watching === watch) return;
    this._watching = watch;
    this._bridge.Enqueue({ K: 'watch-rect', Id: this.Id, Watch: watch });
  };

  /** Promote this id to a Janvas with the registered factory at `key`.
   *  Issued instead of `create` for `<janvas>` nodes. The worker registry
   *  constructs the Janvas + renderer on receipt. Subsequent `apply`,
   *  `attach` etc. ops act on the Janvas exactly like a normal Jiv. */
  EnqueueJanvasAttach = (key: string, config?: unknown): void => {
    this._bridge.Enqueue({ K: 'janvas-attach', Id: this.Id, Key: key, Config: config });
  };

  /** Push state to this Janvas's renderer by named channel. Bypasses the
   *  Angular CD-flushed jiv-ops batch, sent immediately as a top-level
   *  message so hot data (camera transform, marcher poses) doesn't wait
   *  for the next change-detection cycle. Optional `transfer` for
   *  zero-copy ImageBitmap / typed-array hand-offs. */
  PostJanvasInput = (channel: string, payload: unknown, transfer?: Transferable[]): void => {
    this._bridge.PostJanvasInput(this.Id, channel, payload, transfer);
  };

  /** Subscribe to events posted by this Janvas's worker-side renderer
   *  (`ctx.PostEvent(channel, payload)`). Returns an unsubscriber. One
   *  handler per Janvas, last-registration-wins (matches MainBridge's
   *  registry semantics). */
  OnJanvasEvent = (handler: (channel: string, payload: unknown) => void): () => void => {
    return this._bridge.OnJanvasEvent(this.Id, handler);
  };

  /** Convenience setter — engine `SetText(text, style?)` shape preserved
   *  for consumer source compatibility (Jwift `Icon` uses this). */
  SetText = (text: string | null, style?: Partial<TextStyle>): void => {
    this._text = text;
    if (style) Object.assign(this._textStyleState, style);
    this._markDirty();
  };

  /** Engine resolve-context stub. The real `ResolveContext` (font metrics,
   *  vars, Presence, viewport) lives in the worker; consumers on main that
   *  read `Node.ResolveCtx?.PointScale` get a synthesized snapshot derived
   *  from the cached PointScale + last-known geometry. Fields that consumers
   *  don't actually read carry zero defaults so the structural type matches
   *  the engine's `ResolveContext` interface. */
  get ResolveCtx(): {
    ParentWidth: number; ParentHeight: number;
    PointScale: number; ParentPointScale: number; RootPointScale: number;
    ViewportWidth: number; ViewportHeight: number;
    Vars?: ReadonlyMap<string, string>;
  } | null {
    const ps = this._pointScale ? Number(this._pointScale) : NaN;
    const pointScale = Number.isFinite(ps) && ps > 0 ? ps : 1;
    return {
      ParentWidth: this.Parent?.Width ?? 0,
      ParentHeight: this.Parent?.Height ?? 0,
      PointScale: pointScale,
      ParentPointScale: pointScale,
      RootPointScale: pointScale,
      ViewportWidth: 0,
      ViewportHeight: 0,
      Vars: new Map(),
    };
  }

  /** Apply a full options bundle (the Angular `<jiv>` effect calls this
   *  once per CD pass). Bypasses the per-write Proxy flush to deliver
   *  the full options in one op. */
  Apply = (opts: JivApplyOpts): void => {
    if (opts.Style) Object.assign(this._styleState, opts.Style);
    if (opts.Layout) Object.assign(this._layoutState, opts.Layout);
    if (opts.ChildLayout) Object.assign(this._childLayoutState, opts.ChildLayout);
    if (opts.TextStyle) Object.assign(this._textStyleState, opts.TextStyle);
    if (opts.PredicateStyles !== undefined) this._predicateStyles = opts.PredicateStyles ?? null;
    if (opts.States !== undefined) {
      // Replace-style apply: merge each entry into our mirror. Keys absent
      // from the incoming map are left as-is (not cleared) — class-swap
      // applies don't reset user-driven states.
      for (const name of Object.keys(opts.States)) {
        const on = !!opts.States[name];
        if (on) this._states[name] = true; else delete this._states[name];
      }
    }
    if (opts.Text !== undefined) this._text = opts.Text ?? null;
    if (opts.ElementProps) {
      const ep = opts.ElementProps;
      if (ep.Visible !== undefined) this._visible = ep.Visible;
      if (ep.Interactive !== undefined) this._interactive = ep.Interactive;
      if (ep.PointerEvents !== undefined) this._pointerEvents = ep.PointerEvents;
      if (ep.Cursor !== undefined) this._cursor = ep.Cursor;
      if (ep.UserSelect !== undefined) this._userSelect = ep.UserSelect;
      if (ep.Overflow !== undefined) this._overflow = ep.Overflow;
      if (ep.PointScale !== undefined) this._pointScale = ep.PointScale;
    }
    this._bridge.Enqueue({ K: 'apply', Id: this.Id, Opts: opts });
  };

  /** Set hit handlers in bulk (Angular `<jiv>` uses this to wire the
   *  DOM-event re-dispatch). */
  SetHit = (handlers: JivHitHandlers): void => {
    this._hit = { ...this._hit, ...handlers };
    this._refreshHit();
  };

  // ─── Internals ─────────────────────────────────────────────────────────

  private _makeProxy = (target: Record<string, unknown>): Record<string, unknown> => {
    return new Proxy(target, {
      set: (obj, key, value) => {
        if (typeof key !== 'string') return false;
        if (obj[key] === value) return true;
        obj[key] = value;
        this._markDirty();
        return true;
      },
    });
  };

  private _markDirty = (): void => {
    if (this._dirty) return;
    this._dirty = true;
    queueMicrotask(() => this._flush());
  };

  private _flush = (): void => {
    this._dirty = false;
    // ElementProps: omit defaults / empty values. Empty `PointScale` ('')
    // would be parsed as a length expression on the worker and throw
    // "Unexpected end of length expression" every frame.
    const ep: Partial<NonNullable<JivApplyOpts['ElementProps']>> = {
      Visible: this._visible,
      Interactive: this._interactive,
      PointerEvents: this._pointerEvents,
      Cursor: this._cursor,
      UserSelect: this._userSelect,
      Overflow: this._overflow,
      SnapLayout: this._snapLayout,
    };
    if (this._pointScale) ep.PointScale = this._pointScale;
    const opts: JivApplyOpts = {
      Style: { ...this._styleState },
      Layout: { ...this._layoutState },
      ChildLayout: { ...this._childLayoutState },
      TextStyle: { ...this._textStyleState },
      PredicateStyles: this._predicateStyles,
      States: { ...this._states },
      Text: this._text,
      ElementProps: ep,
    };
    this._bridge.Enqueue({ K: 'apply', Id: this.Id, Opts: opts });
  };

  private _refreshHit = (): void => {
    // Keep our per-frame rect-snapshot listener intact even as the
    // user-level handlers come and go.
    const merged: JivHitHandlers = {
      ...this._hit,
      OnRectSnapshot: ({ X, Y, Width, Height }) => {
        this.X = X; this.Y = Y; this.Width = Width; this.Height = Height;
        this._hit.OnRectSnapshot?.({ X, Y, Width, Height });
      },
    };
    this._bridge.SetHitHandlers(this.Id, merged);
  };
}
