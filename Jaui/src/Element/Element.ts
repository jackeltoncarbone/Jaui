/**
 * Element — the base scene graph node.
 *
 * Owns the tree structure (parent, children), layout configuration (flex),
 * computed position, scroll state, intrinsic sizing, dirty tracking, and
 * text content. Has NO visual properties — no style, no material, no
 * rendering. Jiv extends Element to add material/glass/border/shadow.
 *
 * Analogy: Element is to Jiv as HTMLElement is to HTMLDivElement.
 * Future element types (TextElement, ImageElement) will extend Element
 * without carrying glass/material baggage.
 */

import type { LayoutConfig, ChildLayout, Overflow, Clip } from '../Layout/Layout.Types';
import { DefaultLayoutConfig, DefaultChildLayout } from '../Layout/Layout.Types';
import type { TextStyle, TextMeasurement } from '../Text/Text.Types';
import { DefaultTextStyle } from '../Text/Text.Types';
import type { ResolveContext } from '../Core/Length';
import { DirtyFlag, type DirtyFlags } from '../Core/Types';
import { Spring } from '../Animation/Spring';

/** Side-channel from Element to its owning Canvas (or any consumer that wants
 *  to react to dirty marks). Canvas implements this and registers itself on
 *  Root; `AddChild` propagates so the whole tree shares one tracker. Defined
 *  here (and not in `../Core/`) to avoid an Element → Canvas import cycle. */
export interface DirtyTracker {
  Notify(node: Element): void;
}

export type CursorStyle = 'Default' | 'Pointer' | 'Text' | 'Move' | 'None';

/** How an image fills its Element's box.
 *  - `Contain` (default) — image fits inside the box, centered, aspect preserved.
 *  - `Cover` — image fills the box, aspect preserved, excess cropped. */
export type FitMode = 'Contain' | 'Cover';

export interface ElementOptions {
  X?: number;
  Y?: number;
  Width?: number;
  Height?: number;
  SnapLayout?: boolean;
  Layout?: Partial<LayoutConfig>;
  ChildLayout?: Partial<ChildLayout>;
  Text?: string;
  TextStyle?: Partial<TextStyle>;
  /** Cascading base unit for the layout solver. Default '1pt'. */
  PointScale?: string;
  Visible?: boolean;
  Overflow?: Overflow;
  Clip?: Clip;
  Interactive?: boolean;
  PointerEvents?: 'Auto' | 'None';
  Cursor?: CursorStyle;
  UserSelect?: 'Auto' | 'None';
}

export class Element {
  // ── Computed layout position (set by layout solver or manually) ──
  //
  // These are the RENDER plane — JivAnimator's per-frame Tick writes the
  // spring's current value here, so renderers + hit tests see whatever the
  // element is visually at *right now*. During a spring animation they
  // diverge from the layout target, which is exactly what the eye expects.
  X: number = 0;
  Y: number = 0;
  Width: number = 0;
  Height: number = 0;

  // The LAYOUT plane — what the solver most recently computed. Jaui copies
  // every solve result into these fields before kicking the animator.
  // Subsequent layout passes (subtree seeds, text wrap budgets, attach
  // fallbacks, flex keyword fallbacks) read the *target* instead of the
  // mid-spring render value, so descendants of a mid-spring ancestor get
  // stable targets rather than transient ones that can land within the
  // spring deadband and stick. See `Jaui._solveAndAnimate` for the write
  // site and `Layout.Solver`/`Layout.Intrinsic` for the read sites.
  LayoutX: number = 0;
  LayoutY: number = 0;
  LayoutWidth: number = 0;
  LayoutHeight: number = 0;

  // ── Tree ──
  Parent: Element | null = null;
  Children: Element[] = [];

  // ── Layout ──

  /** Container config — how this element lays out its children. */
  Layout: LayoutConfig;

  /** Child config — how this element behaves as a child of its parent. */
  ChildLayout: ChildLayout;

  /** Cascading base unit. `1pt` anywhere in this element's subtree resolves
   *  to `N × PointScale`. The layout solver reads this during its top-down
   *  PointScale cascade. Default `'1pt'` — inherit parent. */
  PointScale: string;

  // ── Intrinsic sizing ──
  /** Max-content width/height — natural size assuming no wrapping. This is
   *  what `Auto` resolves to when there's no other constraint. */
  IntrinsicWidth: number | null = null;
  IntrinsicHeight: number | null = null;
  /** Min-content width/height — the smallest size the element can take
   *  without its contents overflowing (longest word for text; max child
   *  MinContent on the cross axis for containers). */
  IntrinsicMinWidth: number | null = null;
  IntrinsicMinHeight: number | null = null;

  // ── Scroll state ──
  /** Current scroll offset (CSS px). Only meaningful when Overflow === 'Scroll'. */
  ScrollX: number = 0;
  ScrollY: number = 0;
  /** Target scroll offset — what the scroll spring is animating toward. */
  ScrollTargetX: number = 0;
  ScrollTargetY: number = 0;
  /** Content bounds, computed during render collection. */
  ContentWidth: number = 0;
  ContentHeight: number = 0;

  // ── Text content ──
  /** Optional text content. Drives intrinsic sizing. Will move to a dedicated
   *  TextElement in a future refactor. */
  Text: string | null = null;
  TextStyle: TextStyle;
  TextMeasurement: TextMeasurement | null = null;

  // ── Resolve context ──
  /** Populated top-down during layout. Holds this element's resolved PointScale
   *  + the parent dims/viewport needed to turn Length fields into pixels.
   *  Null until the first layout pass has run. */
  ResolveCtx: ResolveContext | null = null;

  /** When true, the layout solver snaps X/Y/Width/Height to the solver result
   *  instead of spring-chasing them. Used for elements whose position is driven
   *  imperatively on every frame (e.g. text-selection highlights following a
   *  drag). Default false: the framework's "everything animates" posture wins
   *  unless a feature opts out. */
  SnapLayout: boolean = false;

  /** Non-zero while this element is mid-TELEPORT (a live reparent — moved between
   *  parents while already mounted). Stamped monotonically by `AddChild`, cleared
   *  by `JivAnimator` when the rect springs settle. The render walk paints
   *  in-flight elements LAST within their nearest layered ancestor's scope (and
   *  clip-free of the containers between), so a surface flying home never drops
   *  behind its cousins or clips against the scroll container it's returning
   *  into; the most recent teleport paints topmost. */
  TeleportSeq: number = 0;

  /** Cumulative scroll-offset CHANGE across a live reparent (old ancestor chain − new ancestor chain),
   *  captured by `AddChild` and consumed once by the layout pass to re-base the rect spring's CURRENT
   *  value. Without it, a node that teleports into/out of a scrolled container snaps to its UNSCROLLED
   *  layout position and then animates — the drag "hop" that scales with scroll offset. Cleared after use. */
  TeleportScrollDeltaX: number = 0;
  TeleportScrollDeltaY: number = 0;

  // ── Appearance / Interaction ──
  /** Whether this element is visible. Hidden elements are skipped by rendering
   *  and hit testing but still participate in layout. */
  Visible: boolean = true;
  Overflow: Overflow = 'Visible';
  /** Clip override; `Auto` derives from Overflow. See `ClipsChildren`. */
  Clip: Clip = 'Auto';

  /** Single source of truth for "does this node clip its descendants" — every
   *  clip site (render clip-stack cascade, viewport cull, hit-test) reads this
   *  so clipping and scrolling stay decoupled. `Clip` overrides; `Auto` falls
   *  back to the Overflow-derived behavior. */
  get ClipsChildren(): boolean {
    return this.Clip === 'Hidden'  ? true
         : this.Clip === 'Visible' ? false
         : (this.Overflow === 'Hidden' || this.Overflow === 'Scroll');
  }

  Interactive: boolean = false;

  /** Render-time cascaded opacity: ancestors' product × own RenderStyle.Opacity.
   *  Computed once per frame before draw; all render paths (panel/text/image)
   *  read this instead of RenderStyle.Opacity so child opacity inherits parent
   *  dimming CSS-style. Stored here (not in RenderStyle) so the authored
   *  opacity isn't clobbered by the cascade between frames. */
  EffectiveOpacity: number = 1;

  /** Render-time cascaded foreground filter grade: ancestors' product × own
   *  RenderStyle grade, unless this element sets `Isolate` (which starts a
   *  fresh grade for its subtree). Mirrors EffectiveOpacity — computed once
   *  per frame before draw; the panel path reads these so a parent's `Filter`
   *  grade folds into descendants CSS-style. Stored here (not RenderStyle) so
   *  the authored grade isn't clobbered by the cascade between frames. */
  EffectiveBrightness: number = 1;
  EffectiveSaturation: number = 1;
  EffectiveContrast: number = 1;

  /** Click handler — fired on pointerup when the release hits the same
   *  Jiv that pointerdown hit (standard click semantics). null = no
   *  handler (the common case). Angular binding bridges this to a DOM
   *  click event on the component's host element so `(click)` bindings
   *  in templates Just Work. */
  OnClick: (() => void) | null = null;

  /** Contextmenu (right-click / long-press) handler. Jaui's canvas-level
   *  listener hit-tests the click point and fires this on the topmost
   *  hit Jiv; the bridge in Angular dispatches a synthetic `contextmenu`
   *  event on the host element so `(contextmenu)` template bindings
   *  work. The browser's default menu is suppressed unconditionally on
   *  the canvas — apps that want it back should preventDefault their own
   *  way (uncommon).  Deepest-Jiv-wins by default; ancestors still
   *  receive the bubbled event and can override unless the deeper
   *  handler called `stopPropagation`. */
  OnContextMenu: ((e: MouseEvent) => void) | null = null;

  /** Pointer-down handler — fired on the topmost-hit Jiv when a pointer
   *  press lands on it. Move/up after a press route to `document` (the
   *  browser keeps firing pointermove/up even when the pointer leaves
   *  the canvas), so consumers wire those listeners themselves inside
   *  this callback. Angular binding bridges this to a DOM `pointerdown`
   *  event on the host element. */
  OnPointerDown: ((e: PointerEvent) => void) | null = null;

  /** Pointer-move handler — fires while a pointer is over this Jiv,
   *  whether or not a button is pressed. For drag interactions, prefer
   *  attaching a `document`-level move listener inside `OnPointerDown`
   *  so the drag continues even when the pointer leaves the Jiv. */
  OnPointerMove: ((e: PointerEvent) => void) | null = null;

  /** Pointer-up handler — fires on the topmost-hit Jiv at release. Note
   *  the up-Jiv may differ from the down-Jiv if the pointer moved during
   *  the press; for the standard click semantics use OnClick instead. */
  OnPointerUp: ((e: PointerEvent) => void) | null = null;

  /** Wheel handler — fired on the topmost-hit Jiv at the wheel point, BEFORE
   *  scroll-container resolution, so consumers can bind `(wheel)` and receive
   *  it only when this Jiv is genuinely on top (z-ordered, like pointer hits).
   *  Scroll containers still handle the wheel independently; a non-scrolling
   *  consumer (e.g. the drill field) uses this to drive its own zoom. Angular
   *  binding bridges it to a DOM `wheel` event on the host element. */
  OnWheel: ((e: WheelEvent) => void) | null = null;
  PointerEvents: 'Auto' | 'None' = 'Auto';
  Cursor: CursorStyle = 'Default';
  UserSelect: 'Auto' | 'None' = 'Auto';

  // ── Presence ──
  /** Spring-driven existence value in [0, 1]. Rises 0→1 on mount, falls 1→0
   *  on `RequestLeave`. The renderer multiplies this into the final opacity,
   *  so every Jiv fades in and out by default. See Presence.md for the full
   *  contract — implicit-opacity fallback, settle-then-remove, etc. */
  PresenceSpring: Spring = new Spring(0, 220, 26);
  /** True once `RequestLeave` has been called — further calls are no-ops,
   *  and the engine will hard-remove this element from its parent once the
   *  spring settles at 0. */
  LeaveRequested: boolean = false;

  // ── Dirty tracking ──
  Dirty: DirtyFlags = DirtyFlag.Layout;

  /** Per-tree dirty-tracker hook. Canvas implements `DirtyTracker` and stamps
   *  itself onto Root at construction; `AddChild` / `RemoveChild` propagate the
   *  reference so every node in the tree shares it. `MarkLayoutDirty` notifies
   *  the tracker so Canvas can decide whether to scope re-solve to a subtree
   *  vs. the whole tree on the next tick. Stays null for orphan elements
   *  (e.g. test fixtures that don't run inside a Canvas). */
  Tracker: DirtyTracker | null = null;

  constructor(options?: ElementOptions) {
    this.X = options?.X ?? 0;
    this.Y = options?.Y ?? 0;
    this.Width = options?.Width ?? 0;
    this.Height = options?.Height ?? 0;
    // Seed the layout plane to match the render plane at construction —
    // explicit options are stating the element's *target* geometry, which
    // is what callers like tests (and ad-hoc SolveLayout users) rely on
    // before any solve has actually run.
    this.LayoutX = this.X;
    this.LayoutY = this.Y;
    this.LayoutWidth = this.Width;
    this.LayoutHeight = this.Height;
    this.SnapLayout = options?.SnapLayout ?? false;
    this.PointScale = options?.PointScale ?? '1pt';

    this.Visible = options?.Visible ?? true;
    this.Overflow = options?.Overflow ?? 'Visible';
    this.Clip = options?.Clip ?? 'Auto';
    this.Interactive = options?.Interactive ?? false;
    this.PointerEvents = options?.PointerEvents ?? 'Auto';
    this.Cursor = options?.Cursor ?? 'Default';
    this.UserSelect = options?.UserSelect ?? 'Auto';

    this.Layout = { ...DefaultLayoutConfig, ...options?.Layout };

    this.ChildLayout = { ...DefaultChildLayout, ...options?.ChildLayout };
    this.ChildLayout.AttachTargetAnchor = { ...(options?.ChildLayout?.AttachTargetAnchor ?? DefaultChildLayout.AttachTargetAnchor) };
    this.ChildLayout.AttachSelfAnchor = { ...(options?.ChildLayout?.AttachSelfAnchor ?? DefaultChildLayout.AttachSelfAnchor) };

    this.TextStyle = { ...DefaultTextStyle, ...options?.TextStyle };
    if (options?.Text !== undefined) {
      this.Text = options.Text;
      this.Dirty |= DirtyFlag.Text;
    }

    // Start off-screen of the Presence range so mount springs us in. The
    // settle-then-remove logic in the engine uses Target=0 to decide when
    // to hard-remove; Target=1 is "be here".
    this.PresenceSpring.Target = 1;
  }

  /** Current Presence value (spring's current position). */
  get Presence(): number { return this.PresenceSpring.Value; }

  /** Schedule this element for animated removal. Flips the Presence spring's
   *  target to 0; the engine walks the tree each frame and hard-removes
   *  the element from its parent once the spring settles. Idempotent.
   *
   *  Layout is the instant truth — siblings reflow immediately on this call
   *  as if the element were already gone (see layout solver's LeaveRequested
   *  check). The leaving element keeps its last animated X/Y and fades in
   *  place via the opacity multiply on Presence. */
  RequestLeave = (): void => {
    if (this.LeaveRequested) return;
    this.LeaveRequested = true;
    this.PresenceSpring.Target = 0;
    this.MarkLayoutDirty();
  };

  AddChild = (child: Element): void => {
    // A LIVE reparent (already mounted elsewhere) is a teleport: stamp the
    // recency seq so the render walk elevates the in-flight subtree until its
    // rect springs settle. Same-parent re-adds (reorders) don't stamp.
    const teleporting = child.Parent !== null && child.Parent !== this;
    // Capture how much cumulative scroll the node is leaving vs entering, BEFORE the reparent (so the old
    // ancestor chain is still intact). The layout pass re-bases the rect spring by this so the flight
    // starts from where the node visually IS, not its unscrolled layout position.
    if (teleporting) {
      let oldX = 0, oldY = 0;
      for (let p: Element | null = child.Parent; p; p = p.Parent) { oldX += p.ScrollX; oldY += p.ScrollY; }
      let newX = 0, newY = 0;
      for (let p: Element | null = this; p; p = p.Parent) { newX += p.ScrollX; newY += p.ScrollY; }
      // The render subtracts cumulative scroll, so to keep the visual position fixed the spring's value
      // must shift by (newScroll − oldScroll): leaving a scrolled list (old>0, new=0) subtracts it back.
      // Rect springs are positioned in root-absolute space, so EVERY node in the teleported subtree needs
      // the same re-base — re-basing only the reparented node moves its frame but leaves its content
      // (the card face) flying in from the unscrolled spot.
      const dX = newX - oldX, dY = newY - oldY;
      const stack: Element[] = [child];
      while (stack.length > 0) {
        const n = stack.pop()!;
        n.TeleportScrollDeltaX = dX;
        n.TeleportScrollDeltaY = dY;
        for (const c of n.Children) stack.push(c);
      }
    }
    if (child.Parent) child.Parent.RemoveChild(child);
    child.Parent = this;
    this.Children.push(child);
    this.Dirty |= DirtyFlag.Children;
    // Inherit the parent's tracker so the freshly-mounted subtree starts
    // notifying Canvas the moment it's part of the live tree. Pre-existing
    // descendants under `child` get the tracker via `_propagateTracker`.
    if (child.Tracker !== this.Tracker) child._propagateTracker(this.Tracker);
    if (teleporting) child.TeleportSeq = ++Element._teleportSeqCounter;
    this.MarkLayoutDirty();
  };

  /** Monotonic teleport recency counter — see `TeleportSeq`. */
  private static _teleportSeqCounter = 0;

  RemoveChild = (child: Element): void => {
    const idx = this.Children.indexOf(child);
    if (idx >= 0) {
      this.Children.splice(idx, 1);
      child.Parent = null;
      // Detach the subtree's tracker — orphan nodes shouldn't push dirty
      // notifications to a Canvas that no longer owns them.
      child._propagateTracker(null);
      this.Dirty |= DirtyFlag.Children;
      this.MarkLayoutDirty();
    }
  };

  /** Recursively set this node and its descendants' Tracker. Called by
   *  AddChild/RemoveChild so the tracker invariant ("every reachable node
   *  shares Root's tracker") holds across mount/unmount. */
  _propagateTracker = (tracker: DirtyTracker | null): void => {
    this.Tracker = tracker;
    for (const c of this.Children) c._propagateTracker(tracker);
  };

  // Bubbles the Layout flag all the way to the root so the per-frame dirty
  // check is O(1) — `(root.Dirty & Layout) !== 0` answers "anyone in the
  // tree dirty?" without walking. Bubble cost is O(depth), early-out when
  // we hit an ancestor that's already marked. The previous one-hop bubble
  // forced an O(N) tree walk every frame to find dirty descendants.
  //
  // Notifies the Canvas-side tracker (if registered) so re-solve can be
  // scoped to the smallest containing subtree instead of replaying from
  // the root. The bubble itself is still useful even with the tracker —
  // it gives `_tick` an O(1) "anything dirty?" gate at root.Dirty.
  MarkLayoutDirty = (): void => {
    this.Dirty |= DirtyFlag.Layout;
    let p = this.Parent;
    while (p && (p.Dirty & DirtyFlag.Layout) === 0) {
      p.Dirty |= DirtyFlag.Layout;
      p = p.Parent;
    }
    this.Tracker?.Notify(this);
  };

  SetText = (text: string | null, style?: Partial<TextStyle>): void => {
    let changed = text !== this.Text;
    this.Text = text;
    if (style) {
      const current = this.TextStyle as unknown as Record<string, unknown>;
      const next = style as unknown as Record<string, unknown>;
      for (const key in next) {
        const v = next[key];
        if (v !== undefined && current[key] !== v) {
          current[key] = v;
          changed = true;
        }
      }
    }
    if (!changed) return;
    this.Dirty |= DirtyFlag.Text;
    this.MarkLayoutDirty();
  };

  /** Hook for subclasses (Jiv) to layer state-dependent text overrides on
   *  top of the base TextStyle. The default returns the base unchanged.
   *  Layout / render code calls this — never reads `.TextStyle` directly —
   *  so `:Hover { Color: ... }` JSS rules apply uniformly across the
   *  pipeline without each call site needing to do its own merge. */
  EffectiveTextStyle = (): TextStyle => this.TextStyle;

  /** Force text re-measurement on next tick. Call after something outside
   *  the node changes (e.g. fonts finished loading) that could invalidate
   *  the cached TextMeasurement. */
  InvalidateText = (): void => {
    if (this.Text === null) return;
    this.TextMeasurement = null;
    this.Dirty |= DirtyFlag.Text;
    this.MarkLayoutDirty();
  };
}
