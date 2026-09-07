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
import { SemanticMirror } from '../Seo/Semantic.Mirror';
import { TeleportRegistry, TELEPORT_REGISTRY } from '../Teleport/Teleport.Registry';

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
    SemanticMirror,
    TeleportRegistry,
    { provide: TELEPORT_REGISTRY, useExisting: TeleportRegistry },
  ],
})
export class Jaui implements OnInit, OnDestroy {
  readonly stylesheet = input<ParsedJss | Stylesheet | undefined>(undefined);
  /** Default for the semantic-mirror cascade — descendants without their own
   *  `seo` input inherit this. Subtrees flip themselves off with `[seo]="false"`. */
  readonly seo = input<boolean>(true);
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
  private _mirror = inject(SemanticMirror);
  private _canvasEl: HTMLCanvasElement;

  constructor() {
    // Optional fast-path: a host application can pre-construct MainBridge
    // in its main entry (before Angular bootstrap) and stash it on
    // `globalThis.__JAUI_PREBUILT_BRIDGE__`. Adopting it here means the
    // worker `init` message ships at boot — processed the instant the
    // worker bundle finishes parsing instead of waiting for Angular to
    // instantiate <jaui> deep in the component tree (5s+ on cold load).
    // Fallback path constructs the bridge here as before.
    const slot = globalThis as { __JAUI_PREBUILT_BRIDGE__?: MainBridge };
    const prebuilt = slot.__JAUI_PREBUILT_BRIDGE__;
    if (prebuilt) {
      this.Bridge = prebuilt;
      this._canvasEl = prebuilt.Canvas;
      slot.__JAUI_PREBUILT_BRIDGE__ = undefined;
    } else {
      this._canvasEl = document.createElement('canvas');
      this._canvasEl.style.display = 'block';
      this._canvasEl.style.width = '100%';
      this._canvasEl.style.height = '100%';
      const worker = inject(JAUI_WORKER);
      this.Bridge = new MainBridge({ Canvas: this._canvasEl, Worker: worker });
    }
    this._host.nativeElement.appendChild(this._canvasEl);
    // The semantic mirror sits under the canvas as the crawl + accessibility
    // tree only; it is visually hidden (see SemanticMirror.Attach), so the
    // canvas is the sole thing a sighted user sees. relative/z-index keeps the
    // canvas above the mirror in the stacking context.
    this._canvasEl.style.position = 'relative';
    this._canvasEl.style.zIndex = '1';
    this._mirror.Attach(this._host.nativeElement, this._canvasEl);
    this.Canvas = new CanvasProxy(this.Bridge);
    (window as { __jaui?: { canvas: CanvasProxy } }).__jaui = { canvas: this.Canvas };
    (window as { __jauiSemantics?: () => string }).__jauiSemantics = () => this._mirror.Serialize();

    // Push JSS var table to the worker on every registry version bump.
    effect(() => {
      this._registry.Version();
      this.Canvas.SetJssVars(this._registry.Vars);
    });

    // ENVIRONMENT INSET: `@KeyboardInset` is always defined — 0px until a real
    // soft keyboard occludes the viewport — so any stylesheet can put it in
    // its math unconditionally. It rides the ordinary var path above, which
    // means it lands as LAYOUT: a surface padded by it moves its hit rects
    // with it, where a visual translate once moved pixels the taps could not
    // follow. Sub-threshold viewport gaps are URL-bar and settle noise, not a
    // keyboard — treating them as one shoves bottom chrome off-screen — and a
    // real keyboard is always taller than 150px.
    this._registry.SetVar('KeyboardInset', '0px');
    this._registry.SetVar('KeyboardUp', '0');
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (vv) {
      const KEYBOARD_MIN_PX = 150;
      const publish = (): void => {
        const raw = window.innerHeight - vv.height - vv.offsetTop;
        const inset = raw >= KEYBOARD_MIN_PX ? Math.round(raw) : 0;
        this._registry.SetVar('KeyboardInset', `${inset}px`);
        // A 0/1 twin for MULTIPLICATIVE styling: lengths have no conditionals,
        // but `(1 - @KeyboardUp) * height` collapses a row exactly when the
        // keyboard stands, and animates through the ordinary layout path.
        this._registry.SetVar('KeyboardUp', inset > 0 ? '1' : '0');
      };
      vv.addEventListener('resize', publish);
      vv.addEventListener('scroll', publish);
      this._teardownKeyboardInset = () => {
        vv.removeEventListener('resize', publish);
        vv.removeEventListener('scroll', publish);
      };
    }
  }

  private _teardownKeyboardInset: (() => void) | null = null;

  ngOnInit(): void {
    const sheet = this.stylesheet();
    if (sheet) this._registry.Merge(sheet);
    this.Canvas.Start();
    this.ready.emit(this.Canvas);
  }

  ngOnDestroy(): void {
    this._teardownKeyboardInset?.();
    this.Canvas.Stop();
    this.Bridge.Worker.terminate();
    this._canvasEl.remove();
  }
}
