/**
 * Embed layer — the one place real DOM is allowed to live on a canvas app.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * Jaui owns layout, text, hit testing and materials, and paints everything to
 * one canvas. Some things cannot be painted: an `<iframe>` (Stripe's card
 * fields are one by law, since PCI means the card number never touches our
 * page), a `<video>` with the platform's own controls, a third-party map, a
 * Turnstile challenge. A DOM child dropped inside `<jaui>` sits UNDER the
 * canvas and paints nothing at all, which is why checkout, the plan wizard,
 * accepting a cash offer and the Stripe donate element are all blank today.
 *
 * `EmbedLayer` is one absolutely-positioned div that is a SIBLING of the canvas
 * and sits above it. Each embed gets two nested boxes inside it:
 *
 *   PORT   `overflow: hidden`, placed at the node's VISIBLE rect. This is the
 *          window, and it is what makes clipping real: an embed inside a list
 *          that scrolls away is progressively cut off, not switched off.
 *   STAGE  placed at the node's FULL rect, offset inside the port. The
 *          consumer's element lives here, so its own layout never learns that
 *          it is being clipped.
 *
 * Placement comes from `Embed.Geometry.MeasureEmbedBox`, which the worker runs
 * once a frame for every watched node and posts only when the box changes. All
 * values are canvas-local CSS pixels, and since the layer fills the same box as
 * the canvas they are written straight through with no conversion.
 *
 * ── EVENTS ──────────────────────────────────────────────────────────────────
 * The layer is `pointer-events: none` and each port is `pointer-events: auto`,
 * so a pointer over an embed never reaches the canvas and a pointer anywhere
 * else never reaches the layer. `Bridge.Main` captures pointer, wheel, touch
 * and contextmenu on the CANVAS element, so those are excluded by construction
 * — including the `preventDefault` it calls on wheel and touchstart, which is
 * why a scrollable embed scrolls normally.
 *
 * The two listeners `Bridge.Main` puts on `window` / `document` are handled
 * explicitly rather than by construction: its focus mirror and its clipboard
 * handler both treat "focus is inside an embed" as "a native text input is
 * focused", so Jaui's own selection shortcuts and copy mirror stand down while
 * a person is typing into one. See `IsInsideEmbed`.
 *
 * ── WHAT AN EMBED CANNOT DO ─────────────────────────────────────────────────
 * Be honest about this, because every one of these will be somebody's bug:
 *
 *  1. It CANNOT sit between two Jaui layers. There is one DOM layer, above the
 *     whole canvas, so an embed in a sheet at `Layer: 25` still paints over
 *     canvas content at `Layer: 44`. If something must cover an embed, the
 *     cover has to be DOM too, or the embed has to be unmounted.
 *  2. It does NOT composite with Jaui's glass. Glass reads the canvas
 *     backdrop; an embed is not in it. Blur, refraction and specular over an
 *     embed will show the canvas behind it, not the embed.
 *  3. Its corners are rounded only to the radii it is TOLD. The box carries the
 *     node's own resolved radii, so `<jembed>` over a rounded frame rounds
 *     correctly — but that is a plain `border-radius`, not Jaui's squircle, so
 *     a high `BorderRadiusSmoothness` will not match exactly, and an ancestor's
 *     rounded clip is applied as a rectangle.
 *  4. It is axis-aligned. A rotated, skewed or non-uniformly scaled ancestor
 *     moves the canvas content and not the embed. `MeasureEmbedBox` does not
 *     read transforms at all.
 *  5. It trails the canvas by up to one frame. The box is measured after the
 *     worker's frame, posted to the main thread and written as styles, so
 *     during a fast spring the embed lags what it sits on. Mount an embed once
 *     the surface it is in has SETTLED (a sheet's `entered` pose) rather than
 *     flying it in.
 *  6. It is real DOM in a real document, so it takes page-level CSS: `:root`
 *     custom properties still cascade into it, and anything scoped to its
 *     original declaration site does not, because the element is moved here.
 */

import { EmbedBoxesEqual, HIDDEN_EMBED_BOX, type EmbedBox } from './Embed.Geometry';

/** Marks every element the layer owns, so the bridge can ask "is focus inside
 *  an embed?" without knowing anything about the layer. */
export const EMBED_ATTRIBUTE = 'data-jaui-embed';

/** True when `el` (or an ancestor of it) belongs to an embed. A cross-origin
 *  iframe reports its own `<iframe>` element as `document.activeElement`, so
 *  this catches a focused Stripe field as well as a focused plain `<input>`. */
export function IsInsideEmbed(el: Element | null): boolean {
  if (!el) return false;
  return !!el.closest(`[${EMBED_ATTRIBUTE}]`);
}

/** One mounted embed. The consumer appends its element to `Stage` and the
 *  layer keeps the pair of boxes over the Jaui node. */
export class EmbedSlot {
  /** The clipping window, at the node's visible rect. */
  readonly Port: HTMLDivElement;
  /** The node-sized box the consumer's content lives in. */
  readonly Stage: HTMLDivElement;

  /** When true the stage's HEIGHT is left to the DOM and `Place` never writes
   *  it. For an embed whose content sizes itself (Stripe's Payment Element),
   *  the natural height is the thing being measured and fed back as the node's
   *  own height — writing the node's height onto the stage would be circular
   *  and would pin the content to whatever the last frame reserved. */
  SizeToContent = false;

  private _last: EmbedBox | undefined;
  private _released = false;
  private readonly _release: (slot: EmbedSlot) => void;

  constructor(release: (slot: EmbedSlot) => void) {
    this._release = release;

    this.Port = document.createElement('div');
    this.Port.setAttribute(EMBED_ATTRIBUTE, '');
    const port = this.Port.style;
    port.position = 'absolute';
    port.overflow = 'hidden';
    port.margin = '0';
    port.padding = '0';
    // The layer is inert; each port opts itself back in. `touch-action` is set
    // explicitly because the canvas next door runs at `none` and an embed that
    // scrolls (a map, a tall payment form) must be allowed to.
    port.pointerEvents = 'auto';
    port.touchAction = 'auto';
    // Nothing is placed yet, so show nothing rather than a box at 0,0.
    port.visibility = 'hidden';

    this.Stage = document.createElement('div');
    const stage = this.Stage.style;
    stage.position = 'absolute';
    stage.margin = '0';
    stage.padding = '0';
    stage.boxSizing = 'border-box';
    this.Port.appendChild(this.Stage);

    this.Place(HIDDEN_EMBED_BOX);
  }

  /** Put the embed where the box says. Cheap to call every frame: a box that
   *  places identically writes no styles. */
  Place = (box: EmbedBox): void => {
    if (this._released) return;
    if (EmbedBoxesEqual(this._last, box)) return;
    this._last = box;

    const port = this.Port.style;
    if (box.Hidden) {
      // `visibility` rather than `display: none` on purpose. A hidden embed
      // keeps its box, so a widget that measures itself (Stripe's Payment
      // Element sizes to its own content) does not collapse to zero and
      // re-lay-out wrongly when it comes back. It is out of the hit test and
      // out of the a11y tree either way.
      port.visibility = 'hidden';
      port.pointerEvents = 'none';
      return;
    }
    port.visibility = 'visible';
    port.pointerEvents = 'auto';
    port.left = `${box.ClipX}px`;
    port.top = `${box.ClipY}px`;
    port.width = `${box.ClipWidth}px`;
    port.height = `${box.ClipHeight}px`;
    port.opacity = box.Opacity >= 1 ? '' : String(box.Opacity);

    const stage = this.Stage.style;
    // The stage keeps the node's full rect, offset by however much the port
    // cut off its leading edges — so the content never moves relative to the
    // node, only the window over it narrows.
    stage.left = `${box.X - box.ClipX}px`;
    stage.top = `${box.Y - box.ClipY}px`;
    stage.width = `${box.Width}px`;
    if (!this.SizeToContent) stage.height = `${box.Height}px`;
    // Radii come from the animated render style, so guard each one: a single
    // NaN makes the whole `border-radius` shorthand invalid and the browser
    // drops it, which would square off a corner mid-animation.
    const [tl, tr, br, bl] = box.Radius.map((r) => (Number.isFinite(r) ? Math.max(0, r) : 0));
    const rounded = tl > 0 || tr > 0 || br > 0 || bl > 0;
    stage.borderRadius = rounded ? `${tl}px ${tr}px ${br}px ${bl}px` : '';
    stage.overflow = rounded ? 'hidden' : '';
  };

  /** Remove the port and everything in it. Idempotent, so a double teardown
   *  (component destroy plus layer dispose) is safe. */
  Unmount = (): void => {
    if (this._released) return;
    this._released = true;
    this.Port.remove();
    this._release(this);
  };
}

/**
 * The layer itself, one per `<jaui>`. Created lazily: an app with no embeds
 * never puts an extra element in the page.
 */
export class EmbedLayer {
  private _element: HTMLDivElement | null = null;
  private _host: HTMLElement | null = null;
  private readonly _slots = new Set<EmbedSlot>();

  /** The layer's own element, or null while nothing has mounted. */
  get Element(): HTMLDivElement | null { return this._element; }
  /** How many embeds are mounted. Tests read this to prove nothing leaked. */
  get Count(): number { return this._slots.size; }

  /** Name the element the layer lives in — the `<jaui>` host, which is already
   *  `position: relative` with the canvas filling it at `z-index: 1`. Called
   *  once at `<jaui>` construction; calling it again re-homes an existing
   *  layer rather than orphaning it. */
  Attach = (host: HTMLElement): void => {
    if (this._host === host) return;
    this._host = host;
    if (this._element) host.appendChild(this._element);
  };

  /** Mount a new embed. The caller appends its element to `slot.Stage`. */
  Mount = (): EmbedSlot => {
    const slot = new EmbedSlot((s) => { this._slots.delete(s); });
    this._slots.add(slot);
    this._ensureElement().appendChild(slot.Port);
    return slot;
  };

  /** Tear the whole layer down with its host. */
  Dispose = (): void => {
    for (const slot of [...this._slots]) slot.Unmount();
    this._element?.remove();
    this._element = null;
    this._host = null;
  };

  private _ensureElement = (): HTMLDivElement => {
    if (this._element) return this._element;
    const el = document.createElement('div');
    el.setAttribute('data-jaui-embed-layer', '');
    const s = el.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.width = '100%';
    s.height = '100%';
    // Above the canvas (`z-index: 1`) and above the semantic mirror beneath it.
    s.zIndex = '2';
    // Clipped to the canvas, so an embed scrolled past the viewport edge does
    // not grow the page or paint over app chrome outside the canvas.
    s.overflow = 'hidden';
    // Inert by default; each port opts itself back in. Without this the layer
    // would swallow every pointer event the canvas needs.
    s.pointerEvents = 'none';
    this._element = el;
    (this._host ?? document.body).appendChild(el);
    return el;
  };
}
