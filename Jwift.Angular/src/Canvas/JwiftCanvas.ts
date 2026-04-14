import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  inject,
  input,
  output,
} from '@angular/core';
import { Canvas, type Stylesheet } from 'jwift';
import { JssRegistry, JSS_REGISTRY } from '../Jss/Jss.Registry';

/**
 * `<jwift-canvas>` — the Jwift canvas at the app shell. Provides the
 * JssRegistry to descendants; children inject `JwiftCanvas` directly (via
 * `inject(JwiftCanvas, { optional: true })`) to reach the root Jiv.
 *
 * Init timing: the underlying Jwift Canvas is created in the constructor
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
  selector: 'jwift-canvas',
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
export class JwiftCanvas implements OnInit, OnDestroy {
  readonly stylesheet = input<Stylesheet | undefined>(undefined);
  readonly ready = output<Canvas>();

  /** The Jwift Canvas — created eagerly in the constructor so descendants
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
    // + ngAfterViewInit) means Jwift.Canvas is alive before children's
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
    this.Canvas = new Canvas(this._canvasEl);
  }

  ngOnInit(): void {
    const sheet = this.stylesheet();
    if (sheet) this._registry.Merge(sheet);

    // Wait for web fonts to finish loading before we start rasterizing
    // text into the canvas cache — otherwise the first render uses the
    // browser fallback font and the cached glyph atlas is stale until
    // something invalidates it.
    const start = () => {
      this.Canvas.Start();
      this.ready.emit(this.Canvas);
    };
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(start);
    } else {
      start();
    }
  }

  ngOnDestroy(): void {
    this._canvasEl.remove();
  }
}
