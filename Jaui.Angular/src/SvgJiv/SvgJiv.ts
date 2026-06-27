import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef,
  OnDestroy, inject, input, viewChild,
} from '@angular/core';
import { ParseSvgElement, FlatnessTol2, BuildVectorPaint } from 'jaui';
import { Jiv } from '../Jiv/Jiv';
import { Jaui } from '../Jaui/Jaui';

/**
 * `<svg-jiv>` — render an arbitrary SVG inside a Jaui Jiv as TRUE VECTOR geometry
 * (tessellated fills, GPU-drawn), not a rasterized image. Authoring is unchanged:
 * a hidden DOM `<svg>` hosts the markup so Angular drives every child attribute
 * (`[attr.fill]`, struct-directives, …) normally; a MutationObserver re-parses on
 * change. Previously this rasterized through `Canvas.Images.LoadSvg` at 8× and
 * cross-faded two image layers — now the SVG is parsed + tessellated on the main
 * thread and the geometry is shipped to the worker via `JivHandle.SetSvgVector`,
 * so it's crisp at any size, has no decode/bitmap cost, and a color change is a
 * cheap re-tessellation (icons are tiny) rather than a re-raster.
 *
 * Usage:
 *
 *   <svg-jiv class="ToolImage" viewBox="0 0 20 72" svgWidth="20" svgHeight="72">
 *     <rect x="6" y="44" width="8" height="3" [attr.fill]="tipColor()"/>
 *     <path d="M10 0 L7 10 L13 10 Z" [attr.fill]="tipColor()"/>
 *   </svg-jiv>
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
    <jiv #vec [class]="className()" />
  `,
  styles: [':host { display: contents; }'],
})
export class SvgJiv implements AfterViewInit, OnDestroy {
  readonly className = input<string>('', { alias: 'class' });
  readonly viewBox   = input<string>('0 0 100 100');
  readonly svgWidth  = input<number | string>(100);
  readonly svgHeight = input<number | string>(100);

  private readonly _svgRef = viewChild.required<ElementRef<SVGSVGElement>>('hidden');
  private readonly _vec = viewChild.required(Jiv);
  private readonly _jaui = inject(Jaui);

  private _observer: MutationObserver | null = null;

  ngAfterViewInit(): void {
    const el = this._svgRef().nativeElement;
    this._rebuild(el);
    this._observer = new MutationObserver(() => this._rebuild(el));
    this._observer.observe(el, { attributes: true, childList: true, subtree: true, characterData: true });
  }

  ngOnDestroy(): void {
    this._observer?.disconnect();
    this._observer = null;
    this._vec().Node.ClearSvgVector();
  }

  /** Parse the live DOM SVG, tessellate, and ship the geometry to the worker. Sized so
   *  curve flattening + the AA skirt land ~1 device px at the icon's nominal scale. */
  private _rebuild(el: SVGSVGElement): void {
    const dpr = this._jaui.Canvas.Dpr || 1;
    const sw = Math.max(1, Number(this.svgWidth()) || 0);
    const sh = Math.max(1, Number(this.svgHeight()) || 0);
    const devW = sw * dpr, devH = sh * dpr;
    const tol2 = FlatnessTol2(sw, sh, devW, devH);
    const parsed = ParseSvgElement(el, tol2);
    const vw = parsed.ViewBox[2] || sw;
    const vh = parsed.ViewBox[3] || sh;
    const upx = Math.max(vw / Math.max(devW, 1), vh / Math.max(devH, 1)); // ~1 device px in viewBox units
    const paint = BuildVectorPaint(parsed, upx, upx);
    this._vec().Node.SetSvgVector(paint);
  }
}
