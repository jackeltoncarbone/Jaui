import {
  Component,
  ElementRef,
  InjectionToken,
  OnDestroy,
  OnInit,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import {
  MainBridge,
  CanvasProxy,
  type ParsedJss,
  type Stylesheet,
} from 'jaui';
import { JssRegistry, JSS_REGISTRY } from '../Jss/Jss.Registry';

/** DI token for the `<jaui>`-hosted Worker. The consumer must provide a
 *  Worker instance — there's no sane default because the worker is
 *  responsible for registering Janvas renderer factories synchronously
 *  before `BootJauiWorker` runs. Provided at the consumer's host
 *  component (e.g. App.ts):
 *
 *      providers: [{ provide: JAUI_WORKER, useFactory: SpawnRealityWorker }]
 *
 *  DI is resolved at constructor time, so `<jaui>` reads the worker
 *  before any child `<jiv>` / `<janvas>` constructor runs. (Signal-based
 *  inputs throw `RequiredInputNotSetError` when read in the constructor,
 *  which is why this isn't an `input.required<Worker>`.) */
export const JAUI_WORKER = new InjectionToken<Worker>('JAUI_WORKER');

/**
 * `<jaui>` — host of the Jaui rendering canvas.
 *
 * Worker-only architecture: takes a consumer-built Worker (provided via
 * the `JAUI_WORKER` DI token), transfers an OffscreenCanvas to it, and
 * exposes a `CanvasProxy` (`Canvas`) that forwards calls via postMessage.
 * Children inject `Jaui` and read `Canvas` / `Root` exactly as before.
 *
 * Inputs:
 *   stylesheet — pre-parsed Stylesheet (e.g. from CompileJss('foo.jss'))
 *
 * Outputs:
 *   ready — emits the live CanvasProxy once initialized.
 */
@Component({
  selector: 'jaui',
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
export class Jaui implements OnInit, OnDestroy {
  readonly stylesheet = input<ParsedJss | Stylesheet | undefined>(undefined);
  readonly ready = output<CanvasProxy>();

  /** Main-thread proxy for the worker-side Canvas. Children inject this
   *  component and read `Canvas.Root` / `Canvas.Images.LoadSvg` etc. as
   *  before; the proxy forwards everything to the worker. */
  readonly Canvas: CanvasProxy;

  /** Shortcut for `Canvas.Root` — what `<jiv>` uses as a fallback parent. */
  get Root() { return this.Canvas.Root; }

  /** The MainBridge instance — exposed for `<jiv>` descendants that
   *  need to enqueue Jiv ops directly. */
  readonly Bridge: MainBridge;

  private _host = inject(ElementRef<HTMLElement>);
  private _registry = inject(JssRegistry);
  private _canvasEl: HTMLCanvasElement;

  constructor() {
    // Build the proxy <canvas>. This element captures DOM events and
    // hosts the OffscreenCanvas (transferred to the worker). Inline
    // styles bypass Angular's view encapsulation.
    this._canvasEl = document.createElement('canvas');
    this._canvasEl.style.display = 'block';
    this._canvasEl.style.width = '100%';
    this._canvasEl.style.height = '100%';
    this._host.nativeElement.appendChild(this._canvasEl);

    // Wire bridge to the consumer-supplied worker injected via JAUI_WORKER.
    // Required because the worker is responsible for registering Janvas
    // renderer factories synchronously before BootJauiWorker — no default
    // makes sense.
    const worker = inject(JAUI_WORKER);
    this.Bridge = new MainBridge({
      Canvas: this._canvasEl,
      Worker: worker,
    });
    this.Canvas = new CanvasProxy(this.Bridge);
    (window as { __jaui?: { canvas: CanvasProxy } }).__jaui = { canvas: this.Canvas };

    // Push JSS var table to the worker on every registry version bump.
    effect(() => {
      this._registry.Version();
      this.Canvas.SetJssVars(this._registry.Vars);
    });
  }

  ngOnInit(): void {
    const sheet = this.stylesheet();
    if (sheet) this._registry.Merge(sheet);
    this.Canvas.Start();
    this.ready.emit(this.Canvas);
  }

  ngOnDestroy(): void {
    this.Canvas.Stop();
    this.Bridge.Worker.terminate();
    this._canvasEl.remove();
  }
}
