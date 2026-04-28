import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  forwardRef,
  inject,
  input,
} from '@angular/core';
import {
  Janvas as JanvasCore,
  type JanvasRenderer,
  type LayoutConfig,
  type ChildLayout,
} from 'jaui';
import { Jiv } from '../Jiv/Jiv';
import { Jaui } from '../Jaui/Jaui';
import { JSS_REGISTRY } from '../Jss/Jss.Registry';

/**
 * `<janvas>` — a layout-participating element whose pixels are filled by a
 * foreign WebGL2 renderer sharing Jaui's GL context. The foreign renderer
 * (THREE.js scene, custom shader app, etc.) implements `JanvasRenderer`
 * and gets the GL handle on `Init`; from then on Jaui calls `Render` once
 * per dirty frame with viewport set to the janvas's screen rect.
 *
 * Inputs:
 *   renderer    — JanvasRenderer instance to drive
 *   class       — JSS class name; resolved against the local registry for
 *                 Layout/ChildLayout (Style is meaningless on a janvas —
 *                 there's no Jiv panel underneath)
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
  readonly renderer = input<JanvasRenderer | null>(null);
  readonly className = input<string | undefined>(undefined, { alias: 'class' });
  readonly layout = input<Partial<LayoutConfig> | undefined>(undefined);
  readonly childLayout = input<Partial<ChildLayout> | undefined>(undefined);

  /** The underlying Janvas core node, created in the constructor. */
  readonly Node: JanvasCore;

  // forwardRef because a parent <jiv> would import this lazily.
  private _parentJiv = inject<Jiv | null>(forwardRef(() => Jiv), {
    skipSelf: true,
    optional: true,
  });
  private _canvas = inject(Jaui, { optional: true });
  private _registry = inject(JSS_REGISTRY, { optional: true });

  constructor() {
    // Construct an empty Janvas now so it's available for DI / ref access;
    // layout + renderer resolution happens in ngOnInit, after Angular has
    // populated the input signals (the constructor runs BEFORE input
    // bindings flush for non-static template values).
    //
    // Default Layer -1 so the foreign renderer always sits behind sibling
    // UI in both paint AND hit-test order. Without this, a deferred-mount
    // janvas (App.ts schedules Reality via requestIdleCallback so Three.js
    // doesn't bloat first paint) is appended to its parent's Children
    // AFTER the page's Scroll jiv has already mounted — and the hit-test
    // tie-break on Layer-0 prefers the latest insertion, so janvas would
    // win middle-of-screen pointers and ResolveScrollTarget would return
    // null, leaving the page unscrollable until a navigation rebuilds the
    // tree with janvas already present.
    this.Node = new JanvasCore({ Style: { Layer: '-1' } });
  }

  ngOnInit(): void {
    const fromClass = this._registry?.Resolve(this.className()) ?? null;
    if (fromClass?.Layout || this.layout()) {
      Object.assign(this.Node.Layout, { ...fromClass?.Layout, ...this.layout() });
      this.Node.MarkLayoutDirty();
    }
    if (fromClass?.ChildLayout || this.childLayout()) {
      Object.assign(this.Node.ChildLayout, { ...fromClass?.ChildLayout, ...this.childLayout() });
      this.Node.MarkLayoutDirty();
    }
    this.Node.Renderer = this.renderer();
    this._parent().AddChild(this.Node);
    this._canvas?.Canvas.Animations.Kick();
  }

  ngOnDestroy(): void {
    this.Node.Renderer?.Dispose?.();
    this.Node.Renderer = null;
    const parent = this.Node.Parent;
    if (parent) parent.RemoveChild(this.Node);
  }

  private _parent() {
    if (this._parentJiv) return this._parentJiv.Node;
    if (this._canvas) return this._canvas.Root;
    throw new Error('[Jaui.Angular] <janvas> must be inside a <jaui>');
  }
}
