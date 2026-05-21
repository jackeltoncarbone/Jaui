import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
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
} from 'jaui';
import { Jaui } from '../Jaui/Jaui';
import { JSS_REGISTRY } from '../Jss/Jss.Registry';

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
  readonly imageSrc = input<string | null | undefined>(undefined, { alias: 'image' });
  /** Toggle the reserved `Disabled` state. Triggers compound predicate
   *  rules that reference `:Disabled` / `:(... && !Disabled)`, and
   *  framework defaults Interactive:false + Cursor:Default kick in on
   *  the worker side (overridable by explicit `:Disabled { ... }` rules).
   *  Pointer-driven states (Hover/Active/Focus/GroupHover) come from
   *  pointer events on the worker and don't need an input. */
  readonly disabled = input<boolean | undefined>(undefined);

  /** Worker-side Jiv handle. Property writes buffer ops + flush per microtask. */
  readonly Node: JivHandle;

  private _parentJiv = inject<Jiv | null>(forwardRef(() => Jiv), {
    skipSelf: true,
    optional: true,
  });
  private _canvas = inject(Jaui, { optional: true });
  private _registry = inject(JSS_REGISTRY, { optional: true });
  private _host = inject(ElementRef<HTMLElement>);

  constructor() {
    if (!this._canvas) {
      throw new Error('[Jaui.Angular] <jiv> must be inside a <jaui>');
    }
    const bridge = this._canvas.Bridge;
    this.Node = new JivHandle(bridge, bridge.AllocateId());

    // Bridge engine-side hit handlers to bubbling DOM events on this
    // component's host element so Angular `(click)` / `(pointerdown)` etc.
    // bindings still fire — same shape as the pre-worker `<jiv>`.
    this.Node.SetHit({
      OnClick: () => {
        this._host.nativeElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
    });

    // Initial create — sends construction-time options. Attach fires
    // in ngOnInit once the parent chain is settled.
    bridge.Enqueue({ K: 'create', Id: this.Node.Id, Opts: this._buildOptions() });

    // Re-apply on input or registry-version change. The worker
    // auto-kicks its animation loop after applying ops.
    effect(() => {
      this._registry?.Version();
      this.Node.Apply(this._buildOptions());
    });
  }

  ngOnInit(): void {
    const parentNode = this._parentJiv ? this._parentJiv.Node : this._canvas!.Root;
    parentNode.AddChild(this.Node);
  }

  ngOnDestroy(): void {
    this.Node.RequestLeave();
    this.Node.Destroy();
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
    const img = this.imageSrc();

    const styleBag = { ...fromClass?.Style, ...this.style() } as Record<string, unknown>;
    const elementProps: JivApplyOpts['ElementProps'] = {};
    for (const key of [
      'Overflow', 'Visible', 'Interactive', 'PointerEvents',
      'Cursor', 'UserSelect', 'PointScale', 'FitMode',
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
      HoverStyle:          fromClass?.HoverStyle as Record<string, unknown> | undefined,
      ActiveStyle:         fromClass?.ActiveStyle as Record<string, unknown> | undefined,
      FocusStyle:          fromClass?.FocusStyle as Record<string, unknown> | undefined,
      DisabledStyle:       fromClass?.DisabledStyle as Record<string, unknown> | undefined,
      GroupHoverStyle:     fromClass?.GroupHoverStyle as Record<string, unknown> | undefined,
      HoverTextStyle:      fromClass?.HoverTextStyle as Record<string, unknown> | undefined,
      ActiveTextStyle:     fromClass?.ActiveTextStyle as Record<string, unknown> | undefined,
      FocusTextStyle:      fromClass?.FocusTextStyle as Record<string, unknown> | undefined,
      DisabledTextStyle:   fromClass?.DisabledTextStyle as Record<string, unknown> | undefined,
      GroupHoverTextStyle: fromClass?.GroupHoverTextStyle as Record<string, unknown> | undefined,
      GroupTriggerClasses: triggerClasses.length > 0 ? triggerClasses : undefined,
      // Compound `:(expr)` rules — resolved at JSS-parse time on main,
      // shipped to the worker as plain-data `PredicateStyle` entries.
      PredicateStyles:     fromClass?.PredicateStyles as ReadonlyArray<Record<string, unknown>> | undefined,
      Springs:           fromClass?.Springs as Record<string, Record<string, unknown>> | undefined,
      Animations:        fromClass?.Animations as Array<Record<string, unknown>> | undefined,
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
    if (img !== undefined) opts.ImageSrc = img;
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

export type { SpringConfig };
