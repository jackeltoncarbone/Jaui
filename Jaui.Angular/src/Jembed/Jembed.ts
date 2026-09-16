import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  forwardRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { EmbedBox, EmbedSlot } from 'jaui';
import { Jaui } from '../Jaui/Jaui';
import { Jiv } from '../Jiv/Jiv';

/**
 * `<jembed>` — a jiv whose surface is real DOM.
 *
 * Jaui paints to a canvas, so a DOM child inside `<jaui>` sits UNDER it and is
 * invisible. Some things can only be DOM: an `<iframe>` (Stripe's card fields
 * are one by law, since PCI means the card number never touches our page), a
 * `<video>` with the platform's own controls, a third-party map, a Turnstile
 * challenge. `<jembed>` is how those live here.
 *
 * It IS a jiv. It takes a JSS class, it lays out with its siblings, it can
 * teleport, it can paint a background and a border of its own. What is
 * different is that its projected content is lifted into the `EmbedLayer` above
 * the canvas and kept exactly over the node's screen rect, in CSS pixels,
 * through layout, scroll, spring animation, resize and device-pixel-ratio
 * changes. When the node is clipped by a scroll container the DOM is clipped
 * with it, and when it scrolls out of view the DOM goes with it.
 *
 *     <jembed class="Chk_PayFrame" [childLayout]="{ Height: h() + 'pt' }"
 *             [SizeToContent]="true" (ContentSize)="h.set($event.Height)">
 *       <div #mount></div>
 *     </jembed>
 *
 * Content is projected, so an existing `<div #mount>` keeps working unchanged
 * and a `viewChild('mount')` still resolves. `(Ready)` hands over the stage
 * element for the imperative case (a widget SDK that wants a container).
 *
 * THE HOST ELEMENT DOES NOT MOVE — only the content wrapper inside it does.
 * That matters: `<jiv>` orders a freshly-attached node among its siblings by
 * comparing HOST-element document positions, so a `<jembed>` whose host had
 * been lifted into the overlay would compare as following every sibling and
 * sort itself last on the canvas. Leaving the host where the template put it
 * keeps paint order honest, and re-parenting one wrapper is the smallest move
 * that does the job.
 *
 * THE LIMITS ARE REAL, and `Embed.Layer` documents them at length. The five
 * that bite first:
 *   • There is ONE DOM layer, above the whole canvas. An embed cannot sit
 *     between two Jaui layers, so canvas content at a higher `Layer` will NOT
 *     cover it. Unmount the embed instead.
 *   • It does not composite with Jaui's glass. Glass reads the canvas
 *     backdrop, and an embed is not in it.
 *   • Corners are a plain `border-radius` taken from the node's resolved
 *     radii, not Jaui's squircle, so a high `BorderRadiusSmoothness` will not
 *     match exactly and an ancestor's rounded clip is applied as a rectangle.
 *   • It is axis-aligned: a rotated or skewed ancestor moves the canvas
 *     content and not the embed.
 *   • The DOM trails the canvas by up to a frame, because the box is measured
 *     after the worker's frame and then written as styles. Mount an embed once
 *     the surface it sits in has SETTLED rather than flying it in.
 */
@Component({
  selector: 'jembed',
  standalone: true,
  // The wrapper is what gets lifted into the layer; the host stays put. Styles
  // are set imperatively on it rather than here, because a component's own
  // styles are scoped to its original tree position and this element leaves it.
  template: '<div #wrap><ng-content></ng-content></div>',
  styles: [':host { display: contents; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: Jiv, useExisting: forwardRef(() => Jembed) }],
})
export class Jembed extends Jiv {
  /**
   * Let the DOM decide the height. An embedded widget that sizes ITSELF —
   * Stripe's Payment Element grows and shrinks as a person picks a wallet or a
   * card — has a natural height the canvas cannot see, so the jiv would
   * reserve the wrong space and the sheet around it would be the wrong size.
   *
   * With this on, the stage runs at `height: auto`, a ResizeObserver watches
   * it, and `(ContentSize)` reports the natural box. The consumer feeds that
   * back as the jiv's own `[childLayout]="{ Height: … }"`, which is what
   * actually reserves the space — one honest round trip rather than the engine
   * guessing. Off (the default) the content fills the node, which is what a
   * `<video>` or a map wants.
   */
  readonly SizeToContent = input<boolean>(false);

  /** The stage element the embed's content lives in. Emitted once it is in the
   *  layer, which is at init — the element is in the document by then. */
  readonly Ready = output<HTMLElement>();

  /** The DOM content's natural size in CSS pixels, when `SizeToContent` is on.
   *  1pt = 1 CSS px in Jaui, so the number goes straight into a JSS length. */
  readonly ContentSize = output<{ Width: number; Height: number }>();

  private readonly _canvasRef = inject(Jaui);
  private readonly _wrap = viewChild.required<ElementRef<HTMLDivElement>>('wrap');
  private readonly _slot: EmbedSlot;
  private _observer: ResizeObserver | null = null;
  private _lastWidth = -1;
  private _lastHeight = -1;

  constructor() {
    super();
    this._slot = this._canvasRef.Bridge.Embeds.Mount();
  }

  /**
   * The wrapper is moved in `ngAfterViewInit`, NOT `ngOnInit`: this component's
   * own view (and so `#wrap`) does not exist yet at init, and reading a
   * required view query there throws. `<jiv>`'s attach and sibling ordering
   * still happen at init, which is what they need — the host element is in its
   * authored position then and nothing has been re-parented.
   */
  ngAfterViewInit(): void {
    const sizeToContent = this.SizeToContent();
    const wrap = this._wrap().nativeElement;
    wrap.style.display = 'block';
    wrap.style.margin = '0';
    wrap.style.width = '100%';
    wrap.style.height = sizeToContent ? 'auto' : '100%';
    this._slot.Stage.appendChild(wrap);

    // Subscribe to per-frame boxes. Without this the DOM never moves — the
    // worker only measures the nodes that ask.
    this.Node.SetHit({ OnRectSnapshot: (box: EmbedBox) => this._slot.Place(box) });
    this.Node.WatchRect(true);

    if (sizeToContent) this._observeContent();
    this.Ready.emit(this._slot.Stage);
  }

  override ngOnDestroy(): void {
    // Unmount the DOM FIRST and unconditionally. `<jiv>`'s destroy only calls
    // RequestLeave so the Presence spring can fade the node out, and the
    // worker keeps the registry entry for a settle; leaving a live iframe
    // hanging over the canvas for that window (or forever, if the spring never
    // settles) is exactly the leak this primitive must not have.
    this._observer?.disconnect();
    this._observer = null;
    this.Node.WatchRect(false);
    this._slot.Unmount();
    super.ngOnDestroy();
  }

  private _observeContent(): void {
    if (typeof ResizeObserver === 'undefined') return;
    const stage = this._slot.Stage;
    // Hand the height back to the DOM, and tell the slot to stop writing it.
    // The port still clips to the node's rect, so content taller than the space
    // the jiv reserved is hidden rather than spilling — for the one frame
    // before the consumer feeds the measured height back.
    this._slot.SizeToContent = true;
    stage.style.height = 'auto';
    stage.style.minHeight = '0';
    this._observer = new ResizeObserver(() => {
      const rect = stage.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      // Rounded to whole pixels and deduped: a widget that settles by
      // fractions must not drive a layout pass per fraction.
      if (w === this._lastWidth && h === this._lastHeight) return;
      this._lastWidth = w;
      this._lastHeight = h;
      this.ContentSize.emit({ Width: w, Height: h });
    });
    this._observer.observe(stage);
  }
}
