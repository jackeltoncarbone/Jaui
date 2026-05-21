import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef,
  OnDestroy, input, signal, viewChild,
} from '@angular/core';
import { Jiv } from '../Jiv/Jiv';

/**
 * `<svg-jiv>` — render an arbitrary SVG inside a Jaui Jiv with normal Angular
 * bindings on every child attribute.
 *
 * The wrapper hosts a hidden `<svg>` element in the DOM (display:none) that
 * Angular treats as a real SVG subtree — `[attr.fill]`, `[attr.d]`, struct-
 * directives, anything an Angular template can do. A MutationObserver
 * watches that subtree; on any change (attribute write from a binding,
 * structural change from `@if` / `@for`) it re-rasterizes the SVG to a
 * PNG data URL on the main thread and feeds that to a sibling
 * `<jiv [image]>` for GPU upload.
 *
 * Usage:
 *
 *   <svg-jiv class="ToolImage" viewBox="0 0 20 72" svgWidth="20" svgHeight="72">
 *     <rect x="6" y="14" width="8" height="44" rx="1.5" fill="rgba(255,255,255,0.88)"/>
 *     <rect x="6" y="44" width="8" height="3"  [attr.fill]="tipColor()" opacity="0.6"/>
 *     <path d="M10 0 L7 10 L13 10 Z" [attr.fill]="tipColor()"/>
 *   </svg-jiv>
 *
 * Inputs:
 *   class      — passed through to the rendered Jiv (size / radius / etc.)
 *   viewBox    — root <svg> viewBox attribute. Default '0 0 100 100'.
 *   svgWidth   — root <svg> width — drives the rasterized texture size
 *                AND the Jiv's intrinsic width (when no explicit Width on
 *                the wrapper class). Default 100.
 *   svgHeight  — root <svg> height. Same role as svgWidth. Default 100.
 *
 * Why PNG rather than feeding the SVG data URL straight through:
 * Chrome's `createImageBitmap` cannot decode SVG blobs (workers or main
 * thread). The Jaui worker's image pipeline uses createImageBitmap, so
 * SVG data URLs fail to decode. The browser CAN decode SVG into an
 * `<img>` element — we rasterize through that, then `toDataURL('image/png')`
 * yields a PNG the worker accepts.
 */
@Component({
  selector: 'svg-jiv',
  standalone: true,
  imports: [Jiv],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div style="display:none" aria-hidden="true">
      <svg #hidden xmlns="http://www.w3.org/2000/svg"
           [attr.viewBox]="viewBox()"
           [attr.width]="svgWidth()"
           [attr.height]="svgHeight()">
        <ng-content/>
      </svg>
    </div>
    <jiv [class]="className()" [image]="pngDataUrl()"/>
  `,
  styles: [':host { display: contents; }'],
})
export class SvgJiv implements AfterViewInit, OnDestroy {
  readonly className = input<string>('', { alias: 'class' });
  readonly viewBox   = input<string>('0 0 100 100');
  readonly svgWidth  = input<number | string>(100);
  readonly svgHeight = input<number | string>(100);

  private readonly _svgRef = viewChild.required<ElementRef<SVGSVGElement>>('hidden');
  readonly pngDataUrl = signal<string | undefined>(undefined);
  private _observer: MutationObserver | null = null;
  private _rasterGen = 0;
  private _destroyed = false;

  ngAfterViewInit(): void {
    const el = this._svgRef().nativeElement;
    const update = (): void => this._rasterize(new XMLSerializer().serializeToString(el));
    update();
    // Subtree + attributes + childList + characterData covers every
    // mutation Angular's binding system can produce inside the SVG —
    // attribute writes from [attr.x], element add/remove from @if/@for,
    // text changes from interpolation inside <text>.
    this._observer = new MutationObserver(update);
    this._observer.observe(el, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  ngOnDestroy(): void {
    this._destroyed = true;
    this._observer?.disconnect();
    this._observer = null;
  }

  private _rasterize(svg: string): void {
    const gen = ++this._rasterGen;
    const w = Math.max(1, Number(this.svgWidth()) || 0);
    const h = Math.max(1, Number(this.svgHeight()) || 0);
    const img = new Image();
    img.onload = (): void => {
      if (this._destroyed || gen !== this._rasterGen) return;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      this.pngDataUrl.set(canvas.toDataURL('image/png'));
    };
    img.onerror = (): void => {
      if (this._destroyed || gen !== this._rasterGen) return;
      console.warn('[SvgJiv] SVG failed to load for rasterization');
    };
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }
}
