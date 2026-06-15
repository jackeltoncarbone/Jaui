import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef,
  OnDestroy, inject, input, signal, viewChild,
} from '@angular/core';
import { Jiv } from '../Jiv/Jiv';
import { Jyle } from '../Jyle/Jyle';
import { Jaui } from '../Jaui/Jaui';
import SvgJivJss from './SvgJiv.jss';

/**
 * `<svg-jiv>` — render an arbitrary SVG inside a Jaui Jiv with normal Angular
 * bindings on every child attribute, and have it behave like a normal SVG:
 * change a bound attribute (e.g. `[attr.fill]`) and the picture transitions to
 * the new state — no element teardown, no image reload, no pop.
 *
 * The wrapper hosts a hidden `<svg>` (display:none) that Angular treats as a
 * real SVG subtree — `[attr.fill]`, struct-directives, anything. A
 * MutationObserver watches it; on any change the SVG is re-rasterized through
 * Jaui's native keyed image path (`Canvas.Images.LoadSvg`).
 *
 * Cross-fade: the re-rasterized SVG paints into one of TWO overlaid layers, and
 * the incoming layer fades in over the outgoing one via the engine's Opacity
 * animation (SvgJivLayer's @Transition in SvgJiv.jss). So an edit dissolves
 * between old and new — the SVG equivalent of a CSS transition. (Layers
 * ping-pong, each with its own stable texture key, so neither reload nor a URL
 * swap is involved.)
 *
 * Usage:
 *
 *   <svg-jiv class="ToolImage" viewBox="0 0 20 72" svgWidth="20" svgHeight="72">
 *     <rect x="6" y="44" width="8" height="3" [attr.fill]="tipColor()"/>
 *     <path d="M10 0 L7 10 L13 10 Z" [attr.fill]="tipColor()"/>
 *   </svg-jiv>
 *
 * Inputs:
 *   class      — passed through to the wrapper Jiv (size / radius / etc.)
 *   viewBox    — root <svg> viewBox attribute. Default '0 0 100 100'.
 *   svgWidth   — logical SVG width (drives raster aspect). Default 100.
 *   svgHeight  — logical SVG height. Default 100.
 */

let _svgJivSeq = 0;

// Rasterize this many times above device pixels so the texture stays crisp when
// the Jiv scales it up (tools render several times the SVG's nominal size).
const SUPERSAMPLE = 8;
// Must match @Transition Opacity Duration in SvgJiv.jss (+ a little slack).
const FADE_MS = 240;

// Jiv style values are JSS strings, not numbers (Opacity "0".."1", Layer "0"…).
interface LayerStyle {
  Background: string;
  Opacity: string;
  Layer: string;
}

@Component({
  selector: 'svg-jiv',
  standalone: true,
  imports: [Jiv, Jyle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <jyle [source]="JssSource" />
    <div style="display:none" aria-hidden="true">
      <svg #hidden xmlns="http://www.w3.org/2000/svg"
           [attr.viewBox]="viewBox()"
           [attr.width]="svgWidth()"
           [attr.height]="svgHeight()">
        <ng-content/>
      </svg>
    </div>
    <jiv [class]="className()">
      <jiv class="SvgJivLayer" [style]="layer0()" />
      <jiv class="SvgJivLayer" [style]="layer1()" />
    </jiv>
  `,
  styles: [':host { display: contents; }'],
})
export class SvgJiv implements AfterViewInit, OnDestroy {
  readonly JssSource = SvgJivJss;
  readonly className = input<string>('', { alias: 'class' });
  readonly viewBox   = input<string>('0 0 100 100');
  readonly svgWidth  = input<number | string>(100);
  readonly svgHeight = input<number | string>(100);

  private readonly _svgRef = viewChild.required<ElementRef<SVGSVGElement>>('hidden');
  private readonly _jaui = inject(Jaui);

  // Two stable texture keys — one per layer. Each re-raster targets the back
  // layer's key (replaced in place; ImageCache.LoadBitmap), so neither layer
  // ever changes its Background URL — only its Opacity animates.
  private readonly _id = _svgJivSeq++;
  private readonly _keys = [`svgjiv-${this._id}-0`, `svgjiv-${this._id}-1`];

  readonly layer0 = signal<LayerStyle>({ Background: 'transparent', Opacity: '0', Layer: '0' });
  readonly layer1 = signal<LayerStyle>({ Background: 'transparent', Opacity: '0', Layer: '0' });
  private readonly _layers = [this.layer0, this.layer1];

  private _front = 0;          // index of the layer currently showing
  private _initialized = false;
  private _observer: MutationObserver | null = null;
  private _fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private _raf = 0;

  ngAfterViewInit(): void {
    const el = this._svgRef().nativeElement;
    const update = (): void => this._onSvgChanged(el);
    update();
    // Subtree + attributes + childList + characterData covers every mutation
    // Angular's binding system can produce inside the SVG.
    this._observer = new MutationObserver(update);
    this._observer.observe(el, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  ngOnDestroy(): void {
    this._observer?.disconnect();
    this._observer = null;
    if (this._fadeTimer) clearTimeout(this._fadeTimer);
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  private _bg(idx: number): string {
    return `Url("${this._keys[idx]}", Contain)`;
  }

  private _rasterizeTo(idx: number, el: SVGSVGElement): void {
    const w = Math.max(1, Number(this.svgWidth()) || 0);
    const h = Math.max(1, Number(this.svgHeight()) || 0);
    const dpr = (this._jaui.Canvas.Dpr || 1) * SUPERSAMPLE;
    const svg = new XMLSerializer().serializeToString(el);
    this._jaui.Canvas.Images.LoadSvg(this._keys[idx], svg, w, h, dpr);
  }

  private _onSvgChanged(el: SVGSVGElement): void {
    if (!this._initialized) {
      this._initialized = true;
      this._rasterizeTo(0, el);
      this.layer0.set({ Background: this._bg(0), Opacity: '1', Layer: '1' });
      this.layer1.set({ Background: 'transparent', Opacity: '0', Layer: '0' });
      this._front = 0;
      return;
    }

    const back = 1 - this._front;
    this._rasterizeTo(back, el);

    // Place the incoming layer on top, fully transparent, then fade it in over
    // the outgoing one on the next frame so the engine animates Opacity 0→1.
    this._layers[back].set({ Background: this._bg(back), Opacity: '0', Layer: '2' });
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._layers[back].update(s => ({ ...s, Opacity: '1' }));
    });

    // After the fade, demote the outgoing layer and promote the incoming one.
    const outgoing = this._front;
    if (this._fadeTimer) clearTimeout(this._fadeTimer);
    this._fadeTimer = setTimeout(() => {
      this._fadeTimer = null;
      this._layers[outgoing].update(s => ({ ...s, Opacity: '0', Layer: '0' }));
      this._layers[back].update(s => ({ ...s, Layer: '1' }));
      this._front = back;
    }, FADE_MS + 40);
  }
}
