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
  THEME_DARK_VAR,
  THEME_LIGHT_VAR,
  type ParsedJss,
  type ProbeNode,
  type ProbeSnapshot,
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

declare const ngDevMode: unknown;

/** Binding elements that are not the component a jiv belongs to. */
const JAUI_TAGS = new Set(['jiv', 'jext', 'jimage', 'jinput', 'janvas', 'svg-jiv', 'jyle', 'jaui', 'ng-container']);

/** The safe-area edges, named as the host's latched `--Safe*` custom properties name them. */
const SAFE_EDGES = ['Top', 'Right', 'Bottom', 'Left'] as const;
/** When to re-read the host's latch after mount. It seeds zeros immediately and then measures across
 *  the first few frames as the initial layout settles, so one read at mount would catch only zeros. */
const SAFE_SETTLE_MS = [350, 800];
/** An orientation flip re-measures a few hundred ms after the layout flips, so read once more after a
 *  resize rather than trusting the value standing at the moment the event fires. */
const SAFE_REREAD_MS = 450;

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
  /** The active theme, fed by the host (Show Studio's ThemeMode). Published as the `@Dark` / `@Light`
   *  environment vars, which a glass `TintTone: Ground` reads. Defaults to dark until the host says. */
  readonly dark = input<boolean>(true);
  /** Host environment vars, published through the same SetVar path as the insets. A theme hands its colour
   *  tokens in here, so a sheet's `@Ink` re-resolves live when the theme flips. */
  readonly vars = input<Readonly<Record<string, string>>>({});
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
    // The DOM embed layer is a SIBLING of the canvas at z-index 2, so a
    // `<jembed>` (an iframe, a <video>, a map) paints above it. Naming the host
    // here rather than letting the layer find one keeps the layer out of the
    // "which element am I in" business; it stays unbuilt until an embed mounts.
    this.Bridge.Embeds.Attach(this._host.nativeElement);
    this.Canvas = new CanvasProxy(this.Bridge);
    (window as { __jaui?: { canvas: CanvasProxy } }).__jaui = { canvas: this.Canvas };
    (window as { __jauiSemantics?: () => string }).__jauiSemantics = () => this._mirror.Serialize();
    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      (window as { JauiProbe?: () => Promise<ProbeSnapshot | null> }).JauiProbe = this._probe;
    }

    // Push JSS var table to the worker on every registry version bump.
    effect(() => {
      this._registry.Version();
      this.Canvas.SetJssVars(this._registry.Vars);
    });

    // ENVIRONMENT THEME: `@Dark` and its `@Light` twin, published like the insets below and always defined
    // (dark until the host feeds its theme in), so a sheet can weight a value per theme unconditionally:
    // `0.45 * @Dark + 0.5 * @Light`. JSS has no conditionals, so the twin is what spares `(1 - @Dark)`.
    // The theme LOGIC stays with the host; this only carries it to the engine. `vars` rides the same path,
    // and both are runtime vars, so a sheet that mounts later can never put the other theme's value back.
    this._registry.SetVar(THEME_DARK_VAR, '1');
    this._registry.SetVar(THEME_LIGHT_VAR, '0');
    effect(() => {
      const dark = this.dark();
      this._registry.SetVar(THEME_DARK_VAR, dark ? '1' : '0');
      this._registry.SetVar(THEME_LIGHT_VAR, dark ? '0' : '1');
    });
    effect(() => {
      const vars = this.vars();
      for (const name of Object.keys(vars)) this._registry.SetVar(name, vars[name]);
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

    // ENVIRONMENT INSET: the device safe area, published exactly like `@KeyboardInset` above and
    // always defined — `0px` on every desktop browser — so a sheet can put `@SafeTop` in its math
    // unconditionally and nothing breaks where there is no inset.
    //
    // Each edge also gets a 0/1 twin (`@SafeTopUp`), the same MULTIPLICATIVE idiom `@KeyboardUp`
    // uses: JSS lengths have no conditionals and no max(), so "the real inset where there is one,
    // otherwise a fallback" is written as `@SafeTop + (1 - @SafeTopUp) * 20pt`. Per edge, not one
    // flag, because the edges genuinely differ: a phone held upright has a top and bottom inset and
    // no side ones, and the same phone turned on its side has the sides and neither of the others.
    //
    // The VALUES are read from the host's latched `--Safe*` custom properties and never from
    // `env(safe-area-inset-*)` here. WKWebView recomputes raw `env()` as the page's content height
    // changes, so anything pinned to it jumps on every route change and transiently collapses toward
    // zero; the host latches the maximum seen per orientation to stop exactly that. Mirroring the
    // latched vars keeps one source of truth and keeps this file out of the `env()` business.
    for (const edge of SAFE_EDGES) {
      this._registry.SetVar(`Safe${edge}`, '0px');
      this._registry.SetVar(`Safe${edge}Up`, '0');
    }
    if (typeof window !== 'undefined') {
      const readSafeArea = (): void => {
        const rootStyle = getComputedStyle(document.documentElement);
        for (const edge of SAFE_EDGES) {
          const px = Math.max(0, Math.round(parseFloat(rootStyle.getPropertyValue(`--Safe${edge}`)) || 0));
          this._registry.SetVar(`Safe${edge}`, `${px}px`);
          this._registry.SetVar(`Safe${edge}Up`, px > 0 ? '1' : '0');
        }
      };
      // The host's latch settles over the first few frames (and re-measures after an orientation
      // flip), so sample across that window rather than once. SetVar no-ops on an unchanged value,
      // so a sample that finds nothing new costs nothing.
      const timers = SAFE_SETTLE_MS.map((ms) => setTimeout(readSafeArea, ms));
      const frame = requestAnimationFrame(readSafeArea);
      const onSafeAreaChange = (): void => {
        readSafeArea();
        timers.push(setTimeout(readSafeArea, SAFE_REREAD_MS));
      };
      readSafeArea();
      window.addEventListener('resize', onSafeAreaChange, { passive: true });
      window.addEventListener('orientationchange', onSafeAreaChange, { passive: true });
      this._teardownSafeArea = () => {
        window.removeEventListener('resize', onSafeAreaChange);
        window.removeEventListener('orientationchange', onSafeAreaChange);
        for (const t of timers) clearTimeout(t);
        cancelAnimationFrame(frame);
      };
    }
  }

  /** Dev-only layout dump, annotated with each jiv's Angular host (the `data-jiv` attribute Jiv stamps in dev). */
  private _probe = async (): Promise<ProbeSnapshot | null> => {
    const snapshot = await this.Bridge.ProbeLayout();
    if (!snapshot) return null;
    const hosts = new Map<number, HTMLElement>();
    for (const el of (this._host.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('[data-jiv]')) hosts.set(Number(el.dataset['jiv']), el);
    const ng = (window as { ng?: { getListeners?: (el: Element) => { name: string }[] } }).ng;
    const annotate = (node: ProbeNode): void => {
      const el = hosts.get(node.Id);
      if (el) {
        node.Tag = el.localName;
        const authored = (el.dataset['jivClass'] ?? '').split(/\s+/).filter(Boolean);
        node.Classes = [...new Set([...authored, ...node.Classes])];
        let owner: HTMLElement | null = JAUI_TAGS.has(el.localName) ? el.parentElement : el;
        while (owner && JAUI_TAGS.has(owner.localName)) owner = owner.parentElement;
        if (owner) node.Host = owner.localName;
        const href = el.getAttribute('href') ?? el.getAttribute('ng-reflect-href');
        if (href) node.Href = href;
        try { node.Listeners = [...new Set((ng?.getListeners?.(el) ?? []).map(l => l.name))]; } catch { /* dev global absent */ }
      }
      for (const child of node.Children) annotate(child);
    };
    annotate(snapshot.Root);
    return snapshot;
  };

  private _teardownKeyboardInset: (() => void) | null = null;
  private _teardownSafeArea: (() => void) | null = null;

  ngOnInit(): void {
    const sheet = this.stylesheet();
    if (sheet) this._registry.Merge(sheet);
    this.Canvas.Start();
    this.ready.emit(this.Canvas);
  }

  ngOnDestroy(): void {
    this._teardownKeyboardInset?.();
    this._teardownSafeArea?.();
    this.Bridge.Embeds.Dispose();
    this.Canvas.Stop();
    this.Bridge.Worker.terminate();
    this._canvasEl.remove();
  }
}
