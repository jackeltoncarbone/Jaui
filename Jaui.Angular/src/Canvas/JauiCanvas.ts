import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { Canvas, WebGL2Renderer, type ParsedJss, type Stylesheet } from 'jaui';
import { JssRegistry, JSS_REGISTRY } from '../Jss/Jss.Registry';

/**
 * `<jaui-canvas>` — the Jaui canvas at the app shell. Provides the
 * JssRegistry to descendants; children inject `JauiCanvas` directly (via
 * `inject(JauiCanvas, { optional: true })`) to reach the root Jiv.
 *
 * Init timing: the underlying Jaui Canvas is created in the constructor
 * so `Root` is available BEFORE any projected child runs its own
 * lifecycle hooks. No afterRender / afterNextRender hacks.
 *
 * Inputs:
 *   stylesheet — pre-parsed Stylesheet (e.g. from CompileJss('foo.jss'))
 *
 * Outputs:
 *   ready — emits the live Canvas instance once initialized
 */
@Component({
  selector: 'jaui-canvas',
  standalone: true,
  template: '<ng-content></ng-content>',
  styles: [`
    :host { display: block; width: 100%; height: 100%; position: relative; }
    canvas { width: 100%; height: 100%; display: block; }
  `],
  providers: [
    JssRegistry,
    { provide: JSS_REGISTRY, useExisting: JssRegistry },
  ],
})
export class JauiCanvas implements OnInit, OnDestroy {
  readonly stylesheet = input<ParsedJss | Stylesheet | undefined>(undefined);
  readonly ready = output<Canvas>();

  /** The Jaui Canvas — created eagerly in the constructor so descendants
   *  can read `.Root` immediately, without waiting for any Angular
   *  lifecycle hook to fire. */
  readonly Canvas: Canvas;

  /** Shortcut for `Canvas.Root` — what <jiv> uses as a fallback parent. */
  get Root() { return this.Canvas.Root; }

  private _host = inject(ElementRef<HTMLElement>);
  private _registry = inject(JssRegistry);
  private _canvasEl: HTMLCanvasElement;

  constructor() {
    // Build the <canvas> imperatively and attach it as our host element's
    // first child. Doing this in the constructor (instead of via ViewChild
    // + ngAfterViewInit) means Jaui.Canvas is alive before children's
    // hooks fire — eliminates the cross-lifecycle ordering problem.
    //
    // Inline styles bypass Angular's view encapsulation — scoped CSS rules
    // in this component's `styles` wouldn't match an element we created
    // via DOM APIs (no _ngcontent-xxx attribute).
    this._canvasEl = document.createElement('canvas');
    this._canvasEl.style.display = 'block';
    this._canvasEl.style.width = '100%';
    this._canvasEl.style.height = '100%';
    this._host.nativeElement.appendChild(this._canvasEl);
    // WebGL2 explicitly: projected <jiv> children read `.Root` synchronously
    // during their own ngOnInit, and WebGL2Renderer.Init is the only backend
    // init that's actually sync-in-practice (pure GL state calls). The
    // Promise return on Init is cosmetic; `void` fires and forgets.
    const renderer = new WebGL2Renderer();
    void renderer.Init(this._canvasEl);
    this.Canvas = new Canvas(this._canvasEl, renderer);
    (window as any).__jaui = { canvas: this.Canvas };

    // Push the active registry's var table into the Canvas whenever the
    // registry version bumps (a <jyle> merge, hot-edit, etc.). Layout +
    // intrinsic passes read it via ResolveContext.Vars to substitute
    // `@Name` refs in authored expressions. Initial push catches any
    // vars declared by the @Input() stylesheet before the first tick.
    effect(() => {
      this._registry.Version();
      this.Canvas.SetJssVars(this._registry.Vars);
    });
  }

  ngOnInit(): void {
    const sheet = this.stylesheet();
    if (sheet) this._registry.Merge(sheet);
    // Canvas.Start() kicks rAF immediately; text re-measures on
    // FontFaceSet.loadingdone via Canvas' own listener.
    this.Canvas.Start();
    this.ready.emit(this.Canvas);
  }

  ngOnDestroy(): void {
    this._canvasEl.remove();
  }
}
