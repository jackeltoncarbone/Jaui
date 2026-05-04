import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef,
  OnDestroy, computed, input, signal, viewChild,
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
 * structural change from `@if` / `@for`) it serializes the SVG to a string,
 * wraps it as a `data:image/svg+xml;utf8,...` URL, and feeds it to a
 * sibling `<jiv [image]>` which renders it through Jaui's GPU image
 * pipeline.
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
 * Notes:
 * - Browser handles SVG-to-bitmap rasterization, Jaui uploads the bitmap
 *   to the GPU.
 * - Each unique data URL is cached by Jaui's ImageCache, so re-rasterization
 *   only fires when an attribute actually changes.
 * - For DPR-aware sharp rendering at higher zoom, swap to Jaui core's
 *   `LoadSvg(key, source, w, h)` API in a future revision — it stores the
 *   source string and re-rasterizes when `devicePixelRatio` changes.
 *   Data URLs are simpler and good enough for small icons.
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
    <jiv [class]="className()" [image]="dataUrl()"/>
  `,
  styles: [':host { display: contents; }'],
})
export class SvgJiv implements AfterViewInit, OnDestroy {
  readonly className = input<string>('', { alias: 'class' });
  readonly viewBox   = input<string>('0 0 100 100');
  readonly svgWidth  = input<number | string>(100);
  readonly svgHeight = input<number | string>(100);

  private readonly _svgRef = viewChild.required<ElementRef<SVGSVGElement>>('hidden');
  private readonly _serialized = signal<string | null>(null);
  private _observer: MutationObserver | null = null;

  readonly dataUrl = computed<string | undefined>(() => {
    const s = this._serialized();
    return s ? `data:image/svg+xml;utf8,${encodeURIComponent(s)}` : undefined;
  });

  ngAfterViewInit(): void {
    const el = this._svgRef().nativeElement;
    const update = (): void => {
      this._serialized.set(new XMLSerializer().serializeToString(el));
    };
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
    this._observer?.disconnect();
    this._observer = null;
  }
}
