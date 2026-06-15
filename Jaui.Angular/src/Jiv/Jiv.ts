import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  forwardRef,
  inject,
  input,
} from '@angular/core';
import {
  JivHandle,
  type JivApplyOpts,
  type JivStyle,
  type LayoutConfig,
  type ChildLayout,
  type TextStyle,
  type SpringConfig,
  type PointerPayload,
  type WheelPayload,
} from 'jaui';
import { Jaui } from '../Jaui/Jaui';
import { JSS_REGISTRY } from '../Jss/Jss.Registry';
import { SemanticMirror, type MirrorEntry } from '../Seo/Semantic.Mirror';
import { ExtractBackgroundUrl, ResolveSemantics } from '../Seo/Seo.Resolve';
import { JAUI_NAVIGATE, type SemanticRole } from '../Seo/Seo.Types';
import { WireTeleportInputs } from '../Teleport/Teleport.Wiring';

/**
 * Maps each attached node's worker handle to the Angular host element that owns
 * it. `AddChild` appends, but a child created out of authored order — e.g. one
 * inside `@if`, whose embedded view mounts AFTER its static siblings once the
 * condition flips true on data load — would otherwise land at the END of the
 * parent's Children and paint below content authored after it. Recording the
 * host element lets a freshly-attached node reorder itself to its real DOM
 * position among current siblings (see `_reorderToDomPosition`). Both `<jiv>`
 * and `<janvas>` register here so mixed trees order correctly.
 */
export const JAUI_HOST_EL = new WeakMap<JivHandle, HTMLElement>();

/**
 * `<jiv>` — generic Jaui node.
 *
 * Worker-mode shape: each `<jiv>` allocates a worker-side ID at
 * construction, posts a `create` op to the bridge, an `attach` op on
 * init, and `apply` ops on input changes. The exposed `Node` is a
 * `JivHandle` — a stand-in for the engine `Jiv` whose property writes
 * (Style/Layout/ChildLayout via Proxy, scalar setters, AddChild, etc.)
 * forward through the bridge. Reads of geometry come from rect snapshots
 * the worker pushes back per frame for nodes that subscribe.
 */
@Component({
  selector: 'jiv',
  standalone: true,
  template: '<ng-content></ng-content>',
  styles: [':host { display: contents; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Jiv implements OnInit, OnDestroy {
  readonly className = input<string | undefined>(undefined, { alias: 'class' });
  readonly style = input<Partial<JivStyle> | undefined>(undefined);
  readonly layout = input<Partial<LayoutConfig> | undefined>(undefined);
  readonly childLayout = input<Partial<ChildLayout> | undefined>(undefined);
  readonly text = input<string | null | undefined>(undefined);
  readonly textStyle = input<Partial<TextStyle> | undefined>(undefined);
  /** Convenience: when set, this Jiv paints with `Background: Url(value, Cover)`
   *  — the engine resolves the URL through ImageCache, kicks LoadUrl, and
   *  flips :Loading/:Loaded states as the texture moves through fetch + decode.
   *  Equivalent to writing `Background: Url("...")` in JSS; consumer-side
   *  sugar for the common image-fill case. Explicit Background in `[style]`
   *  takes precedence — `[image]` only writes if Background isn't already set. */
  readonly image = input<string | null | undefined>(undefined);
  /** Toggle the reserved `Disabled` state. Triggers compound predicate
   *  rules that reference `:Disabled` / `:(... && !Disabled)`, and
   *  framework defaults Interactive:false + Cursor:Default kick in on
   *  the worker side (overridable by explicit `:Disabled { ... }` rules).
   *  Pointer-driven states (Hover/Active/Focus/GroupHover) come from
   *  pointer events on the worker and don't need an input. */
  readonly disabled = input<boolean | undefined>(undefined);

  // ── Semantic mirror inputs (SEO / accessibility projection) ──
  /** Explicit semantic role — overrides the JSS `Semantics:` declaration. */
  readonly semantics = input<SemanticRole | undefined>(undefined);
  /** Heading level (1–6) when the role resolves to Heading. Default 2. */
  readonly level = input<number | undefined>(undefined);
  /** Real navigation target. Projects an `<a href>` into the mirror AND
   *  navigates on canvas tap (via JAUI_NAVIGATE) unless a `(click)` handler
   *  called preventDefault. One declaration: behavior + crawl graph. */
  readonly href = input<string | null | undefined>(undefined);
  /** Alt text — with an image background, projects an `<img alt>`. */
  readonly alt = input<string | null | undefined>(undefined);
  /** aria-label for the projected element. */
  readonly label = input<string | null | undefined>(undefined);
  /** Cascading projection switch. Unset inherits the parent Jiv (root
   *  default comes from `<jaui [seo]>`); `false` prunes this subtree. */
  readonly seo = input<boolean | undefined>(undefined);

  // ── Teleport (every jiv is a container — outlet/teleport is base capability) ──
  /** Makes this jiv a named OUTLET (a parking space) in the canvas-scoped
   *  TeleportRegistry. Other jivs `[TeleportTo]` it. */
  readonly TeleportId = input<string | undefined>(undefined);
  /** Live AT the named outlet: the declaration site stops determining this
   *  jiv's canvas parent — the node is parented to the outlet, and MOVED
   *  between outlets as this changes (the engine springs the rect across, so
   *  a move IS the flight; the in-flight subtree paints elevated until it
   *  settles). `null` re-parents to the real (declaration-site) parent. */
  readonly TeleportTo = input<string | null | undefined>(undefined);

  /** Worker-side Jiv handle. Property writes buffer ops + flush per microtask. */
  readonly Node: JivHandle;

  /** Effective projection state — own `seo` ?? parent chain ?? canvas default.
   *  Duck-typed: Jwift components provide the Jiv token without subclassing
   *  Jiv (Toolbar, TabBar, Card...), so the parent may lack the cascade. */
  readonly SeoEnabled: () => boolean = computed(() => {
    const own = this.seo();
    if (own !== undefined) return own;
    const parent = this._parentJiv as { SeoEnabled?: () => boolean } | null;
    if (parent && typeof parent.SeoEnabled === 'function') return parent.SeoEnabled();
    return this._canvas?.seo() ?? true;
  });

  private _parentJiv = inject<Jiv | null>(forwardRef(() => Jiv), {
    skipSelf: true,
    optional: true,
  });
  private _canvas = inject(Jaui, { optional: true });
  private _registry = inject(JSS_REGISTRY, { optional: true });
  private _host = inject(ElementRef<HTMLElement>);
  private _mirror = inject(SemanticMirror, { optional: true });
  private _navigate = inject(JAUI_NAVIGATE, { optional: true })
    ?? ((url: string) => location.assign(url));
  private _mirrorEntry: MirrorEntry | null = null;
  private _styleRole: string | undefined;
  private _backgroundUrl: string | null = null;

  constructor() {
    if (!this._canvas) {
      throw new Error('[Jaui.Angular] <jiv> must be inside a <jaui>');
    }
    const bridge = this._canvas.Bridge;
    this.Node = new JivHandle(bridge, bridge.AllocateId());
    JAUI_HOST_EL.set(this.Node, this._host.nativeElement);

    // Bridge engine-side hit handlers to bubbling DOM events on this
    // component's host element so Angular `(click)` / `(pointerdown)` etc.
    // bindings still fire — same shape as the pre-worker `<jiv>`.
    this._mirrorEntry = this._mirror?.Register(
      this._host.nativeElement,
      this._parentJiv?._mirrorEntry ?? null,
    ) ?? null;

    this.Node.SetHit({
      OnClick: () => {
        const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
        this._host.nativeElement.dispatchEvent(evt);
        const href = this.href();
        if (href && !evt.defaultPrevented) this._navigate(href);
      },
      OnContextMenu: (src) => {
        this._host.nativeElement.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: src.ClientX, clientY: src.ClientY, button: src.Button,
        }));
      },
      OnPointerDown: (src) => this._host.nativeElement.dispatchEvent(_clonePointerEvent('pointerdown', src)),
      OnPointerMove: (src) => this._host.nativeElement.dispatchEvent(_clonePointerEvent('pointermove', src)),
      OnPointerUp: (src) => this._host.nativeElement.dispatchEvent(_clonePointerEvent('pointerup', src)),
      OnWheel: (src) => this._host.nativeElement.dispatchEvent(_cloneWheelEvent(src)),
    });

    // Initial create — sends construction-time options. Attach fires
    // in ngOnInit once the parent chain is settled.
    bridge.Enqueue({ K: 'create', Id: this.Node.Id, Opts: this._buildOptions() });

    // Re-apply on input or registry-version change. The worker
    // auto-kicks its animation loop after applying ops.
    effect(() => {
      this._registry?.Version();
      this.Node.Apply(this._buildOptions());
      this._applyMirror();
    });

    WireTeleportInputs({
      Node: this.Node,
      TeleportId: this.TeleportId,
      TeleportTo: this.TeleportTo,
      NaturalParent: () => this._parentJiv ? this._parentJiv.Node : this._canvas?.Root ?? null,
    });
  }

  ngOnInit(): void {
    const parentNode = this._parentJiv ? this._parentJiv.Node : this._canvas!.Root;
    parentNode.AddChild(this.Node);
    // AddChild appends. If this node mounted out of authored order (e.g. it sits
    // in an @if that flipped true after its static siblings already attached),
    // move it to its real DOM position so paint/layout order matches the
    // template instead of attach order.
    this._reorderToDomPosition(parentNode);
  }

  /** Reorder this node within its parent's Children to match DOM document order.
   *  The target index is the count of current siblings whose host element
   *  precedes ours in the DOM; a no-op when already in order (the common case),
   *  so statically-ordered children never post a move op. */
  private _reorderToDomPosition(parentNode: JivHandle): void {
    const myEl = this._host.nativeElement;
    const siblings = parentNode.Children;
    let target = 0;
    for (const sib of siblings) {
      if (sib === this.Node) continue;
      const sibEl = JAUI_HOST_EL.get(sib);
      // Only order against siblings still in the DOM; a leaving node's element
      // may be detached and would compare as disconnected.
      if (!sibEl || !sibEl.isConnected) continue;
      if (myEl.compareDocumentPosition(sibEl) & Node.DOCUMENT_POSITION_PRECEDING) {
        target++;
      }
    }
    const current = siblings.indexOf(this.Node);
    if (current !== -1 && current !== target) {
      parentNode.MoveChildToIndex(this.Node, target);
    }
  }

  ngOnDestroy(): void {
    // Per Presence.md framework-binding contract: ngOnDestroy ONLY calls
    // RequestLeave. The engine's PresenceManager hard-removes the node
    // automatically once the spring settles at 0 — calling Destroy()
    // here too (as we used to) enqueued a follow-on 'destroy' op that
    // the worker processed before the spring could fire, defeating the
    // entire fade. The cost of not calling Destroy is that the worker
    // keeps the registry entry alive for ~400ms (one spring settle)
    // after Angular tears the component down; PresenceManager cleans
    // up bridge hit handlers + registry slots on its settle callback.
    if (this._mirrorEntry) this._mirror?.Unregister(this._mirrorEntry);
    this.Node.RequestLeave();
  }

  /** Project (or prune) this Jiv's semantic mirror node. Runs inside the
   *  apply effect, so role/href/alt/level/seo inputs and JSS changes all
   *  retarget reactively. */
  private _applyMirror(): void {
    if (!this._mirror || !this._mirrorEntry) return;
    const resolved = this.SeoEnabled()
      ? ResolveSemantics({
          Role: this.semantics(),
          Level: this.level(),
          StyleRole: this._styleRole,
          Href: this.href(),
          Alt: this.alt(),
          Label: this.label(),
          Text: this.text() ?? null,
          BackgroundUrl: this._backgroundUrl,
        })
      : null;
    this._mirror.Apply(this._mirrorEntry, resolved, this._navigate);
  }

  private _buildOptions(): JivApplyOpts {
    // className signal isn't populated at constructor time; fall back to
    // the static host attribute so initial Springs see the right value.
    const name = this.className() ?? this._host.nativeElement.getAttribute('class') ?? undefined;
    const fromClass = this._registry?.Resolve(name) ?? null;
    // Group-hover triggers: only classes that author a GroupHoverStyle/
    // GroupHoverTextStyle rule are passed to the worker, so the hover
    // dispatcher only fans `_groupHover` out for those (a shared base
    // class with no GroupHover rule doesn't pull peers in).
    const triggerClasses: string[] = [];
    if (name && this._registry) {
      for (const c of name.split(/\s+/).filter(Boolean)) {
        if (this._registry.IsGroupTrigger(c)) triggerClasses.push(c);
      }
    }
    const text = this.text();

    const styleBag = { ...fromClass?.Style, ...this.style() } as Record<string, unknown>;
    // `[image]` sugar — when set and Background wasn't authored explicitly,
    // write a `Url(...)` Background value. The engine's Style.Resolver +
    // ImageCache handle fetch / decode / texture binding on the worker side.
    const img = this.image();
    if (img !== undefined && styleBag['Background'] === undefined) {
      styleBag['Background'] = img ? `Url("${img}", Cover)` : 'transparent';
    }
    // Semantics is mirror-only data — the render engine must never see it.
    const styleRole = styleBag['Semantics'];
    this._styleRole = typeof styleRole === 'string' ? styleRole : undefined;
    delete styleBag['Semantics'];
    this._backgroundUrl = ExtractBackgroundUrl(styleBag['Background']);
    const elementProps: JivApplyOpts['ElementProps'] = {};
    for (const key of [
      'Overflow', 'Visible', 'Interactive', 'PointerEvents',
      'Cursor', 'UserSelect', 'PointScale',
    ]) {
      if (key in styleBag) {
        const v = styleBag[key];
        if (key === 'Visible' || key === 'Interactive') {
          (elementProps as Record<string, unknown>)[key] = (v === true || v === 'true');
        } else {
          (elementProps as Record<string, unknown>)[key] = v;
        }
        delete styleBag[key];
      }
    }

    const childLayoutBag = { ...fromClass?.ChildLayout, ...this.childLayout() } as Record<string, unknown>;
    // ChildLayout.AttachTo crosses the worker boundary. On main it's a
    // JivHandle (structurally compatible with AttachTarget); on the wire
    // it must be the target's numeric Id so the worker can resolve to its
    // local JivCore. JivHandle has a back-ref to MainBridge → Canvas (an
    // HTMLCanvasElement), which structured-clone refuses, so the message
    // gets DataCloneError and the entire batch is dropped.
    const at = childLayoutBag['AttachTo'];
    if (at && typeof at === 'object' && typeof (at as { Id?: unknown }).Id === 'number') {
      childLayoutBag['AttachTo'] = (at as { Id: number }).Id;
    }

    const opts: JivApplyOpts = {
      Style:         styleBag,
      Layout:        { ...fromClass?.Layout,        ...this.layout() } as Record<string, unknown>,
      ChildLayout:   childLayoutBag,
      TextStyle:     { ...fromClass?.TextStyle,     ...this.textStyle() } as Record<string, unknown>,
      GroupTriggerClasses: triggerClasses.length > 0 ? triggerClasses : undefined,
      // Pseudo-selector rules — both `:Foo` and `:(expr)` — resolved at
      // JSS-parse time on main, shipped to the worker as plain-data
      // PredicateStyle entries.
      PredicateStyles:     fromClass?.PredicateStyles as ReadonlyArray<Record<string, unknown>> | undefined,
      Springs:           fromClass?.Springs as Record<string, Record<string, unknown>> | undefined,
      // Always emit a concrete array (never undefined): a class with no
      // @Animation must CLEAR any animation a previous class left running.
      // The worker only resets core.Animations when this is defined, so
      // sending undefined on a class swap (animated → plain) left the old
      // loop running forever — the "still wiggling after exiting edit mode" bug.
      Animations:        (fromClass?.Animations ?? []) as Array<Record<string, unknown>>,
      AnimationTable:    this._registry
        ? Object.fromEntries(this._registry.Animations) as unknown as Record<string, Record<string, unknown>>
        : undefined,
      ElementProps:      Object.keys(elementProps).length > 0 ? elementProps : undefined,
    };
    // User-driven boolean state inputs map to the States bag. Only
    // Disabled is plumbed today; future state inputs (Loading, Recording,
    // etc.) follow the same pattern.
    const disabled = this.disabled();
    if (disabled !== undefined) opts.States = { Disabled: !!disabled };
    if (text !== undefined) opts.Text = text;
    return opts;
  }
}

function _clonePointerEvent(type: string, src: PointerPayload): PointerEvent {
  const evt = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: src.ClientX,
    clientY: src.ClientY,
    pointerId: src.PointerId,
    pointerType: src.PointerType,
    button: src.Button,
    buttons: src.Buttons,
    shiftKey: src.Shift,
    ctrlKey: src.Ctrl,
    altKey: src.Alt,
    metaKey: src.Meta,
  });
  (evt as PointerEvent & { __jauiBridged?: boolean }).__jauiBridged = true;
  return evt;
}

/** Rebuild a bubbling DOM `wheel` event from the worker's hit payload so
 *  consumer `(wheel)` bindings on a `<jiv>` (e.g. the drill field's
 *  `<reality-view>`) fire — and only when this Jiv was the topmost hit. */
function _cloneWheelEvent(src: WheelPayload): WheelEvent {
  const evt = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: src.ClientX,
    clientY: src.ClientY,
    deltaX: src.DeltaX,
    deltaY: src.DeltaY,
    deltaMode: src.DeltaMode,
    shiftKey: src.Shift,
    ctrlKey: src.Ctrl,
    altKey: src.Alt,
    metaKey: src.Meta,
  });
  (evt as WheelEvent & { __jauiBridged?: boolean }).__jauiBridged = true;
  return evt;
}

export type { SpringConfig };
