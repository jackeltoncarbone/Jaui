import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  forwardRef,
  inject,
  input,
  output,
} from '@angular/core';
import {
  JivHandle,
  type LayoutConfig,
  type ChildLayout,
} from 'jaui';
import { Jiv } from '../Jiv/Jiv';
import { Jaui } from '../Jaui/Jaui';
import { JSS_REGISTRY } from '../Jss/Jss.Registry';

/**
 * `<janvas>` — a layout-participating element whose pixels are filled by a
 * worker-side renderer registered under `key`.
 *
 * Worker-only architecture: the renderer instance lives entirely in the
 * Jaui worker. `<janvas>` doesn't construct a renderer on main; it allocates
 * a worker-side Jiv id, posts a `janvas-attach` op containing `key` + a
 * structured-cloneable `config`, and the worker's `JanvasRendererRegistry`
 * looks up the registered factory and instantiates the renderer. Show-studio's
 * worker entry registers factories at boot (e.g. `'reality'`) before
 * `BootJauiWorker()` runs, so a janvas-attach op is never racy.
 *
 * State sync: callers push hot per-frame data (camera transform, marcher
 * poses) through `Node.PostJanvasInput(channel, payload)` — bypasses the
 * Angular CD jiv-ops batch, lands in the renderer's `Input(channel, payload)`
 * method on the next worker microtask.
 *
 * Inputs:
 *   key         — registered renderer key (e.g. `'reality'`)
 *   config      — structured-cloneable config blob (handed to the factory)
 *   class       — JSS class name; resolved against the local registry
 *   layout      — Partial<LayoutConfig> override
 *   childLayout — Partial<ChildLayout> override
 */
@Component({
  selector: 'janvas',
  standalone: true,
  template: '',
  styles: [':host { display: contents; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Janvas implements OnInit, OnDestroy {
  readonly key = input.required<string>();
  readonly config = input<unknown>(undefined);
  readonly className = input<string | undefined>(undefined, { alias: 'class' });
  readonly layout = input<Partial<LayoutConfig> | undefined>(undefined);
  readonly childLayout = input<Partial<ChildLayout> | undefined>(undefined);

  /** Worker-side Jiv handle. Use `Node.PostJanvasInput(channel, payload)`
   *  to push state into the renderer; `Node.OnJanvasEvent` (via the
   *  parent `<jaui>` Bridge) to subscribe to renderer events. */
  readonly Node: JivHandle;

  /** Fires once with the JivHandle after janvas-attach has been enqueued.
   *  Parent components use this to wire main-side state-sync services
   *  that need the JivId to PostJanvasInput against. */
  readonly ready = output<JivHandle>();

  private _parentJiv = inject<Jiv | null>(forwardRef(() => Jiv), {
    skipSelf: true,
    optional: true,
  });
  private _canvas = inject(Jaui, { optional: true });
  private _registry = inject(JSS_REGISTRY, { optional: true });

  constructor() {
    if (!this._canvas) {
      throw new Error('[Jaui.Angular] <janvas> must be inside a <jaui>');
    }
    const bridge = this._canvas.Bridge;
    this.Node = new JivHandle(bridge, bridge.AllocateId());
    // Note: we don't enqueue anything here — `key` and `config` may be
    // bound through Angular inputs that haven't resolved at constructor
    // time. ngOnInit fires the janvas-attach with the resolved values.
  }

  ngOnInit(): void {
    const fromClass = this._registry?.Resolve(this.className()) ?? null;
    const layoutBag = { ...fromClass?.Layout, ...this.layout() } as Record<string, unknown>;
    const clBag = { ...fromClass?.ChildLayout, ...this.childLayout() } as Record<string, unknown>;
    // Order matters: janvas-attach first (creates the Janvas in the
    // worker registry), then apply (loads layout/childLayout onto it),
    // then attach (parents into the tree).
    this.Node.EnqueueJanvasAttach(this.key(), this.config());
    if (Object.keys(layoutBag).length > 0 || Object.keys(clBag).length > 0) {
      this.Node.Apply({ Layout: layoutBag, ChildLayout: clBag });
    }
    const parentNode = this._parentJiv ? this._parentJiv.Node : this._canvas!.Root;
    parentNode.AddChild(this.Node);
    this.ready.emit(this.Node);
  }

  ngOnDestroy(): void {
    this.Node.RequestLeave();
    this.Node.Destroy();
  }
}
