/**
 * JivRegistry — worker-side mirror of the Angular Jiv tree.
 *
 * Main posts batches of `JivOp`s (create / attach / apply / leave /
 * destroy / watch-rect) inside `M2W_JivOps` messages, each Angular CD.
 * The registry applies them to a `Map<id, JivCore>` and constructs the
 * actual Jiv tree under `Canvas.Root`.
 *
 * ID space:
 *   • `0` is reserved for `Canvas.Root` — registered automatically at
 *     construction so the first attach can target it.
 *   • Main allocates monotonically increasing positive integers; the
 *     bridge never re-uses ids.
 *
 * Hit-event roundtrip:
 *   • The Angular `<jiv>` component sets `OnClick / OnContextMenu /
 *     OnPointerDown/Move/Up` on its main-side handle, but those handlers
 *     can only fire from the engine's hit-test which runs in the worker.
 *     When the registry creates a JivCore, it wires those engine
 *     callbacks to `bridge.PostHitEvent(jivId, kind, source)` — main
 *     receives `W2M_HitEvent` and dispatches a synthetic DOM event on
 *     the matching `<jiv>` host element so Angular `(click)` etc. fire.
 */

import { Jiv as JivCore } from '../Jiv/Jiv';
import { Janvas as JanvasCore } from '../Janvas/Janvas';
import type { JanvasRenderer } from '../Janvas/Janvas.Renderer';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { TextStyle } from '../Text/Text.Types';
import type { LayoutConfig, ChildLayout } from '../Layout/Layout.Types';
import type { SpringConfig } from '../Animation/Animation.Types';
import type {
  JivApplyOpts,
  JivOp,
  M2W_JivOps,
  W2M,
  PointerPayload,
} from './Bridge.Types';
import { LookupJanvasRenderer } from './Worker.RendererRegistry';

const ROOT_ID = 0;

export class JivRegistry {
  private _nodes = new Map<number, JivCore>();
  private _watchedRects = new Set<number>();
  /** Keyed by JivId — only Janvas nodes carry an entry. The registry
   *  routes incoming `M2W_JanvasInput` through this map and disposes
   *  on destroy. */
  private _janvasRenderers = new Map<number, JanvasRenderer>();
  private _root: JivCore;
  private _post: (msg: W2M, transfer?: Transferable[]) => void;

  constructor(root: JivCore, post: (msg: W2M, transfer?: Transferable[]) => void) {
    this._root = root;
    this._post = post;
    this._nodes.set(ROOT_ID, root);
  }

  /** Apply a batch of ops in order. */
  ApplyOps = (msg: M2W_JivOps): void => {
    for (const op of msg.Ops) this._apply(op);
  };

  /** Return the JivCore matching an id, or undefined. Tests use this to
   *  inspect tree state after a sequence of ops. */
  Get = (id: number): JivCore | undefined => this._nodes.get(id);

  /** Per-frame hook: scan watched ids and post canvas-local rect
   *  snapshots whenever they change since the last broadcast.
   *
   *  Coordinates are CANVAS-LOCAL (top-left of the canvas = 0,0) — the
   *  worker walks the tree from each watched node up to the root,
   *  summing X/Y minus ancestor ScrollX/Y. Consumers (e.g.
   *  `<reality-view>`'s frame callback that pushes view bounds to the
   *  camera rig) then read X/Y/Width/Height directly without doing
   *  their own tree walk on main. */
  EmitRectSnapshots = (): void => {
    if (this._watchedRects.size === 0) return;
    for (const id of this._watchedRects) {
      const n = this._nodes.get(id);
      if (!n) continue;
      // After Jaui's layout solver runs (`Layout.Solver._solveNode`),
      // `node.X` / `node.Y` are CANVAS-LOCAL absolute coordinates — the
      // solver does `absX = offsetX + cl.Left` recursively, and the
      // animator commits the absolute target. So emitting raw X/Y is
      // already canvas-local; no ancestor walk needed.
      let x = n.X;
      let y = n.Y;
      // Subtract ancestor ScrollX/Y so consumers see the visible
      // canvas-local rect (a node nested inside a scrolled container
      // moves with the scroll). Own ScrollX/Y doesn't shift self,
      // only its children.
      for (let p: JivCore | null = n.Parent as JivCore | null; p; p = p.Parent as JivCore | null) {
        x -= p.ScrollX;
        y -= p.ScrollY;
      }
      const w = n.Width;
      const h = n.Height;
      const last = this._lastSnapshot.get(id);
      if (last && last.X === x && last.Y === y && last.W === w && last.H === h) continue;
      this._lastSnapshot.set(id, { X: x, Y: y, W: w, H: h });
      this._post({ T: 'rect', JivId: id, X: x, Y: y, Width: w, Height: h });
    }
  };

  /** Last-emitted snapshot per id — debounce for unchanged rects. */
  private _lastSnapshot = new Map<number, { X: number; Y: number; W: number; H: number }>();

  // ─── Op dispatch ────────────────────────────────────────────────────────

  private _apply = (op: JivOp): void => {
    switch (op.K) {
      case 'create':        return this._create(op.Id, op.Opts);
      case 'attach':        return this._attach(op.ChildId, op.ParentId);
      case 'apply':         return this._applyOpts(op.Id, op.Opts);
      case 'leave':         return this._leave(op.Id);
      case 'destroy':       return this._destroy(op.Id);
      case 'watch-rect':    return this._watchRect(op.Id, op.Watch);
      case 'move-child':    return this._moveChild(op.ParentId, op.ChildId, op.NewIndex);
      case 'janvas-attach': return this._janvasAttach(op.Id, op.Key, op.Config);
    }
  };

  private _janvasAttach = (id: number, key: string, config: unknown): void => {
    if (this._nodes.has(id)) {
      console.warn(`[JivRegistry] janvas-attach: id ${id} already exists; <janvas> should not pre-send 'create'`);
      return;
    }
    const factory = LookupJanvasRenderer(key);
    // Construct the Janvas Jiv even if no factory is registered — keeps
    // layout consistent so missing renderer doesn't collapse the rect.
    // Layer:-1 sits behind every panel painted on top so the Reality
    // (or whatever) shows through; Background stays transparent so the
    // foreign renderer's pixels are visible.
    const janvas = new JanvasCore({ Style: { Layer: '-1' } });
    this._wireHitHandlers(id, janvas);
    this._nodes.set(id, janvas);
    if (!factory) {
      console.warn(`[JivRegistry] janvas-attach: no factory registered for key '${key}'`);
      return;
    }
    const renderer = factory(config, {
      JivId: id,
      PostEvent: (channel, payload, transfer) => {
        this._post(
          { T: 'janvas-event', JivId: id, Channel: channel, Payload: payload },
          transfer,
        );
      },
    });
    janvas.Renderer = renderer;
    this._janvasRenderers.set(id, renderer);
  };

  /** Forward an `M2W_JanvasInput` to the renderer registered for `id`.
   *  Called by `WorkerBridge._onJanvasInput`. Silent if no Janvas exists
   *  at that id (the input may have raced an unmount). */
  RouteJanvasInput = (id: number, channel: string, payload: unknown): void => {
    const r = this._janvasRenderers.get(id);
    r?.Input?.(channel, payload);
  };

  private _moveChild = (parentId: number, childId: number, newIndex: number): void => {
    const parent = this._nodes.get(parentId);
    const child = this._nodes.get(childId);
    if (!parent || !child) return;
    const arr = parent.Children as JivCore[];
    const cur = arr.indexOf(child);
    if (cur < 0) return;
    arr.splice(cur, 1);
    arr.splice(Math.max(0, Math.min(arr.length, newIndex)), 0, child);
    parent.MarkLayoutDirty();
  };

  private _create = (id: number, opts: JivApplyOpts): void => {
    if (this._nodes.has(id)) {
      console.warn(`[JivRegistry] create: id ${id} already exists`);
      return;
    }
    const core = new JivCore(this._coreOptsFromApply(opts));
    this._wireHitHandlers(id, core);
    this._applyElementProps(core, opts);
    this._applyMaterialBits(core, opts);
    this._nodes.set(id, core);
  };

  private _attach = (childId: number, parentId: number): void => {
    const child = this._nodes.get(childId);
    const parent = this._nodes.get(parentId);
    if (!child || !parent) {
      console.warn(`[JivRegistry] attach: missing child=${childId} parent=${parentId}`);
      return;
    }
    parent.AddChild(child);
  };

  private _applyOpts = (id: number, opts: JivApplyOpts): void => {
    const core = this._nodes.get(id);
    if (!core) {
      console.warn(`[JivRegistry] apply: missing id=${id}`);
      return;
    }
    this._applyElementProps(core, opts);
    if (opts.Style)        Object.assign(core.Style, opts.Style as Partial<JivStyle>);
    if (opts.Layout)       Object.assign(core.Layout, opts.Layout as Partial<LayoutConfig>);
    if (opts.ChildLayout)  Object.assign(core.ChildLayout, opts.ChildLayout as Partial<ChildLayout>);
    // State-style buckets: assigning the whole object is safe; engine
    // mixes the active state into EffectiveStyle on every read.
    if (opts.HoverStyle !== undefined)        core.HoverStyle        = (opts.HoverStyle ?? null) as Partial<JivStyle> | null;
    if (opts.ActiveStyle !== undefined)       core.ActiveStyle       = (opts.ActiveStyle ?? null) as Partial<JivStyle> | null;
    if (opts.FocusStyle !== undefined)        core.FocusStyle        = (opts.FocusStyle ?? null) as Partial<JivStyle> | null;
    if (opts.DisabledStyle !== undefined)     core.DisabledStyle     = (opts.DisabledStyle ?? null) as Partial<JivStyle> | null;
    if (opts.HoverTextStyle !== undefined)    core.HoverTextStyle    = (opts.HoverTextStyle ?? null) as Partial<TextStyle> | null;
    if (opts.ActiveTextStyle !== undefined)   core.ActiveTextStyle   = (opts.ActiveTextStyle ?? null) as Partial<TextStyle> | null;
    if (opts.FocusTextStyle !== undefined)    core.FocusTextStyle    = (opts.FocusTextStyle ?? null) as Partial<TextStyle> | null;
    if (opts.DisabledTextStyle !== undefined) core.DisabledTextStyle = (opts.DisabledTextStyle ?? null) as Partial<TextStyle> | null;
    if ('Text' in opts || opts.TextStyle) {
      const nextText = 'Text' in opts ? (opts.Text ?? null) : core.Text;
      core.SetText(nextText, opts.TextStyle as Partial<TextStyle> | undefined);
    }
    if (opts.ImageSrc !== undefined) core.ImageSrc = opts.ImageSrc;
    core.MarkLayoutDirty();
  };

  private _leave = (id: number): void => {
    const core = this._nodes.get(id);
    if (!core) return;
    // Soft-destroy: trigger Presence fade. PresenceManager hard-removes
    // when the spring settles. We keep the registry entry until the
    // hard-remove (so late `apply` ops on a leaving node don't crash);
    // an explicit `destroy` op cleans it up.
    core.RequestLeave();
  };

  private _destroy = (id: number): void => {
    if (id === ROOT_ID) {
      console.warn('[JivRegistry] cannot destroy root');
      return;
    }
    const core = this._nodes.get(id);
    if (!core) return;
    const renderer = this._janvasRenderers.get(id);
    if (renderer) {
      renderer.Dispose?.();
      this._janvasRenderers.delete(id);
    }
    if (core.Parent) (core.Parent as JivCore).RemoveChild(core);
    this._nodes.delete(id);
    this._watchedRects.delete(id);
  };

  private _watchRect = (id: number, watch: boolean): void => {
    if (watch) this._watchedRects.add(id);
    else this._watchedRects.delete(id);
  };

  // ─── Helpers ────────────────────────────────────────────────────────────

  private _coreOptsFromApply = (opts: JivApplyOpts): {
    Style?: Partial<JivStyle>;
    Layout?: Partial<LayoutConfig>;
    ChildLayout?: Partial<ChildLayout>;
    TextStyle?: Partial<TextStyle>;
    HoverStyle?: Partial<JivStyle>;
    ActiveStyle?: Partial<JivStyle>;
    FocusStyle?: Partial<JivStyle>;
    DisabledStyle?: Partial<JivStyle>;
    HoverTextStyle?: Partial<TextStyle>;
    ActiveTextStyle?: Partial<TextStyle>;
    FocusTextStyle?: Partial<TextStyle>;
    DisabledTextStyle?: Partial<TextStyle>;
    Springs?: Record<string, Partial<SpringConfig>>;
    Text?: string;
  } => ({
    Style: opts.Style as Partial<JivStyle> | undefined,
    Layout: opts.Layout as Partial<LayoutConfig> | undefined,
    ChildLayout: opts.ChildLayout as Partial<ChildLayout> | undefined,
    TextStyle: opts.TextStyle as Partial<TextStyle> | undefined,
    HoverStyle: opts.HoverStyle as Partial<JivStyle> | undefined ?? undefined,
    ActiveStyle: opts.ActiveStyle as Partial<JivStyle> | undefined ?? undefined,
    FocusStyle: opts.FocusStyle as Partial<JivStyle> | undefined ?? undefined,
    DisabledStyle: opts.DisabledStyle as Partial<JivStyle> | undefined ?? undefined,
    HoverTextStyle: opts.HoverTextStyle as Partial<TextStyle> | undefined ?? undefined,
    ActiveTextStyle: opts.ActiveTextStyle as Partial<TextStyle> | undefined ?? undefined,
    FocusTextStyle: opts.FocusTextStyle as Partial<TextStyle> | undefined ?? undefined,
    DisabledTextStyle: opts.DisabledTextStyle as Partial<TextStyle> | undefined ?? undefined,
    Springs: opts.Springs as Record<string, Partial<SpringConfig>> | undefined,
    Text: opts.Text ?? undefined,
  });

  private _applyElementProps = (core: JivCore, opts: JivApplyOpts): void => {
    const ep = opts.ElementProps;
    if (!ep) return;
    if (ep.Overflow !== undefined) core.Overflow = ep.Overflow;
    if (ep.Visible !== undefined) core.Visible = ep.Visible;
    if (ep.Interactive !== undefined) core.Interactive = ep.Interactive;
    if (ep.PointerEvents !== undefined) core.PointerEvents = ep.PointerEvents;
    if (ep.Cursor !== undefined) core.Cursor = ep.Cursor;
    if (ep.UserSelect !== undefined) core.UserSelect = ep.UserSelect;
    // Empty string for PointScale would parse as an empty length expression
    // and throw on every frame in the layout solver. Treat empty as absent.
    if (ep.PointScale !== undefined && ep.PointScale !== '' && core.PointScale !== ep.PointScale) {
      core.PointScale = ep.PointScale;
      core.MarkLayoutDirty();
    }
    if (ep.FitMode !== undefined) core.FitMode = ep.FitMode;
  };

  private _applyMaterialBits = (_core: JivCore, _opts: JivApplyOpts): void => {
    // Reserved for material/glass/blur fields if/when those move into
    // `JivApplyOpts`. Today the JivCore constructor handles them via the
    // Style bag; nothing extra needed here.
  };

  private _wireHitHandlers = (id: number, core: JivCore): void => {
    // Engine-side hit handlers — fire the W2M_HitEvent so main can dispatch
    // a synthetic DOM event on the matching `<jiv>` host element.
    core.OnClick = () => this._postHit(id, 'click', _emptyPayload);
    core.OnContextMenu = (src) => this._postHit(id, 'contextmenu', _payloadFromMouseEvent(src));
    core.OnPointerDown = (e) => this._postHit(id, 'pointerdown', _payloadFromPointerEvent(e));
    core.OnPointerMove = (e) => this._postHit(id, 'pointermove', _payloadFromPointerEvent(e));
    core.OnPointerUp = (e) => this._postHit(id, 'pointerup', _payloadFromPointerEvent(e));
  };

  private _postHit = (
    jivId: number,
    kind: 'click' | 'contextmenu' | 'pointerdown' | 'pointermove' | 'pointerup',
    source: PointerPayload,
  ): void => {
    this._post({ T: 'hit', JivId: jivId, Kind: kind, Source: source });
  };
}

// ─── Payload coercion helpers ─────────────────────────────────────────────

const _emptyPayload: PointerPayload = {
  PointerId: -1, PointerType: 'mouse',
  X: 0, Y: 0, ClientX: 0, ClientY: 0,
  Buttons: 0, Button: 0,
  Shift: false, Ctrl: false, Alt: false, Meta: false,
  TimeStamp: 0,
};

const _payloadFromPointerEvent = (e: {
  pointerId?: number; pointerType?: string;
  clientX?: number; clientY?: number;
  button?: number; buttons?: number;
  shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean;
  timeStamp?: number;
}): PointerPayload => ({
  PointerId: e.pointerId ?? 0,
  PointerType: e.pointerType ?? 'mouse',
  X: e.clientX ?? 0, Y: e.clientY ?? 0,
  ClientX: e.clientX ?? 0, ClientY: e.clientY ?? 0,
  Buttons: e.buttons ?? 0, Button: e.button ?? 0,
  Shift: e.shiftKey ?? false, Ctrl: e.ctrlKey ?? false,
  Alt: e.altKey ?? false, Meta: e.metaKey ?? false,
  TimeStamp: e.timeStamp ?? 0,
});

const _payloadFromMouseEvent = (e: {
  clientX?: number; clientY?: number; button?: number;
}): PointerPayload => ({
  PointerId: -1, PointerType: 'mouse',
  X: e.clientX ?? 0, Y: e.clientY ?? 0,
  ClientX: e.clientX ?? 0, ClientY: e.clientY ?? 0,
  Buttons: 0, Button: e.button ?? 0,
  Shift: false, Ctrl: false, Alt: false, Meta: false,
  TimeStamp: 0,
});
