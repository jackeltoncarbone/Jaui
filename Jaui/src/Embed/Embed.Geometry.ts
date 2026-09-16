/**
 * Embed geometry — where a real DOM element has to sit so that it lands exactly
 * over one Jaui node, and the pure math that works it out.
 *
 * Jaui paints pixels to a canvas, so there are things it cannot draw: an
 * `<iframe>` (Stripe's card fields are one by law — PCI means the card number
 * never touches our page), a `<video>`, a map, a Turnstile widget. A DOM child
 * placed inside `<jaui>` sits UNDER the canvas and is invisible. A `Jembed` is
 * the answer: a jiv that participates in layout as usual, whose surface is a
 * real DOM element kept over it in its own layer above the canvas.
 *
 * This module holds only the measurement, so it is testable without a worker,
 * a canvas or a document. `Embed.Layer` does the DOM; `Jiv.Registry` calls
 * `MeasureEmbedBox` once per frame for each watched node and posts the result.
 *
 * COORDINATES. Everything here is CANVAS-LOCAL CSS PIXELS: the top-left of the
 * canvas element is (0, 0). Jaui lays out in pt where 1pt = 1 CSS px, and the
 * overlay layer is a sibling of the canvas filling the same box, so a box
 * measured here is written straight to `left`/`top`/`width`/`height` with no
 * scaling. That is also why a device-pixel-ratio change (a retina screen, a
 * browser zoom) needs no work at all: CSS pixels do not move under it.
 */

/** A node in the tree, reduced to what placing an embed over it needs.
 *  `Jiv.Registry` passes its `JivCore` through this shape with one cast. */
export interface EmbedTreeNode {
  /** Canvas-local absolute position, as the layout solver committed it — it does
   *  NOT account for any ancestor's scroll offset. */
  X: number;
  Y: number;
  Width: number;
  Height: number;
  /** This node's own scroll offset, which shifts its CHILDREN, never itself. */
  ScrollX: number;
  ScrollY: number;
  Visible: boolean;
  /** True for `Overflow: Hidden | Scroll` (or an explicit `Clip: Hidden`) — the
   *  nodes whose box bounds what their descendants may show. */
  readonly ClipsChildren: boolean;
  Parent: EmbedTreeNode | null;
}

/** Everything a DOM embed needs to place itself over one Jaui node. */
export interface EmbedBox {
  /** The node's own on-screen rect: where the embed's CONTENT belongs. */
  X: number;
  Y: number;
  Width: number;
  Height: number;
  /** The visible part of it, after every clipping ancestor has had its say. The
   *  DOM layer puts an `overflow: hidden` window here and offsets the content
   *  inside it, so a node half-scrolled out of a list is genuinely half-visible
   *  rather than all-or-nothing. */
  ClipX: number;
  ClipY: number;
  ClipWidth: number;
  ClipHeight: number;
  /** True when there is nothing to show: the node or an ancestor is not
   *  visible, the node has no area, or it has scrolled entirely out of a
   *  clipping ancestor. A fixed DOM box floating over unrelated content is
   *  worse than nothing, which is the whole reason this field exists. */
  Hidden: boolean;
  /** Product of the node's and its ancestors' animated opacity, so an embed
   *  fades WITH the sheet it is in instead of standing at full strength over a
   *  scrim that is still fading up. */
  Opacity: number;
  /** The node's own corner radii in CSS px: top-left, top-right, bottom-right,
   *  bottom-left. The DOM layer rounds the content box to these, so an embed
   *  inside a rounded frame is rounded the same amount. */
  Radius: readonly [number, number, number, number];
}

/** A box that shows nothing. Used as the placement for a node that has been
 *  destroyed or has never laid out. */
export const HIDDEN_EMBED_BOX: EmbedBox = Object.freeze({
  X: 0, Y: 0, Width: 0, Height: 0,
  ClipX: 0, ClipY: 0, ClipWidth: 0, ClipHeight: 0,
  Hidden: true,
  Opacity: 0,
  Radius: Object.freeze([0, 0, 0, 0]) as readonly [number, number, number, number],
});

/** Reads the animated opacity of a node. Supplied by the caller because opacity
 *  lives on the renderer's style, not on the tree. */
export type EmbedOpacityOf = (node: EmbedTreeNode) => number;
/** Reads the resolved corner radii (tl, tr, br, bl) in CSS px. */
export type EmbedRadiusOf = (node: EmbedTreeNode) => readonly [number, number, number, number];

/**
 * Measure where a DOM embed must sit to cover `node`.
 *
 * Two passes up the ancestor chain, because an ancestor's own on-screen
 * position depends on the scroll of everything ABOVE it, not below:
 *
 *   1. Sum every ancestor's scroll. The node's screen position is its
 *      committed absolute position minus that total.
 *   2. Walk up again accumulating the scroll seen so far, so at each ancestor
 *      `total - seen` is the scroll above it, which places that ancestor on
 *      screen. Each clipping ancestor then narrows the visible window.
 *
 * Rotation and non-uniform transforms are deliberately NOT handled: an embed is
 * an axis-aligned DOM box. See the limits in `Embed.Layer`.
 */
export function MeasureEmbedBox(
  node: EmbedTreeNode,
  opacityOf: EmbedOpacityOf,
  radiusOf: EmbedRadiusOf,
): EmbedBox {
  let totalScrollX = 0;
  let totalScrollY = 0;
  for (let p = node.Parent; p; p = p.Parent) {
    totalScrollX += p.ScrollX;
    totalScrollY += p.ScrollY;
  }

  const x = node.X - totalScrollX;
  const y = node.Y - totalScrollY;
  const width = node.Width;
  const height = node.Height;

  let left = x;
  let top = y;
  let right = x + width;
  let bottom = y + height;
  let visible = node.Visible;
  let opacity = opacityOf(node);
  /** Set when a clipping ancestor has no usable rect, so the visible window
   *  cannot be computed at all. */
  let unclippable = false;

  let seenScrollX = 0;
  let seenScrollY = 0;
  for (let p = node.Parent; p; p = p.Parent) {
    seenScrollX += p.ScrollX;
    seenScrollY += p.ScrollY;
    if (!p.Visible) visible = false;
    opacity *= opacityOf(p);
    if (!p.ClipsChildren) continue;
    // The scroll ABOVE this ancestor is what moves the ancestor itself.
    const px = p.X - (totalScrollX - seenScrollX);
    const py = p.Y - (totalScrollY - seenScrollY);
    // A CLIPPING ancestor with no rect of its own is not "no clip", it is an
    // unknown clip, and the comparisons below would quietly skip it (`NaN >
    // left` is false) and let the embed paint outside a window we cannot
    // place. Not knowing where the window is means showing nothing.
    if (!Number.isFinite(px) || !Number.isFinite(py)
      || !Number.isFinite(p.Width) || !Number.isFinite(p.Height)) {
      unclippable = true;
      continue;
    }
    if (px > left) left = px;
    if (py > top) top = py;
    if (px + p.Width < right) right = px + p.Width;
    if (py + p.Height < bottom) bottom = py + p.Height;
  }

  const clipWidth = right - left;
  const clipHeight = bottom - top;
  // A NODE WITH NO RECT SHOWS NOTHING. The layout solve does not always produce
  // one: a length the parser refuses throws out through `SolveLayout` and
  // leaves the tree unsolved, and a node that has never laid out is zero. Zero
  // falls out of the `<= 0` tests, but NaN and Infinity do NOT — `NaN <= 0` is
  // false — and an unguarded NaN would be written to the DOM as `left: NaNpx`,
  // which a browser drops silently, stranding the embed at its last good
  // position over whatever is there now. Non-finite is hidden, explicitly.
  const finite = Number.isFinite(x) && Number.isFinite(y)
    && Number.isFinite(width) && Number.isFinite(height)
    && Number.isFinite(left) && Number.isFinite(top)
    && Number.isFinite(clipWidth) && Number.isFinite(clipHeight);
  const hidden = !finite || !visible || unclippable
    || width <= 0 || height <= 0 || clipWidth <= 0 || clipHeight <= 0;

  return {
    X: x, Y: y, Width: width, Height: height,
    ClipX: left, ClipY: top,
    ClipWidth: hidden ? 0 : clipWidth,
    ClipHeight: hidden ? 0 : clipHeight,
    Hidden: hidden,
    // Opacity rides the same rule: a non-finite or out-of-range product would
    // reach the DOM as an invalid `opacity` and be ignored, showing the embed
    // at full strength over something that is fading.
    Opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0,
    Radius: radiusOf(node),
  };
}

/** Sub-pixel tolerance for "the box did not move". A spring settles by
 *  ever-smaller decrements, and re-posting a box that moved a thousandth of a
 *  pixel is a message and a style write for nothing. */
const EPSILON = 0.01;

const near = (a: number, b: number): boolean => (a > b ? a - b : b - a) < EPSILON;

/** True when two boxes would place a DOM element identically. Drives the
 *  worker's per-frame change check, so a static embed costs one comparison a
 *  frame and no traffic at all. */
export function EmbedBoxesEqual(a: EmbedBox | undefined, b: EmbedBox): boolean {
  if (!a) return false;
  // A hidden box shows nothing, so nothing else about it can matter.
  if (a.Hidden && b.Hidden) return true;
  return a.Hidden === b.Hidden
    && near(a.X, b.X) && near(a.Y, b.Y)
    && near(a.Width, b.Width) && near(a.Height, b.Height)
    && near(a.ClipX, b.ClipX) && near(a.ClipY, b.ClipY)
    && near(a.ClipWidth, b.ClipWidth) && near(a.ClipHeight, b.ClipHeight)
    && near(a.Opacity, b.Opacity)
    && near(a.Radius[0], b.Radius[0]) && near(a.Radius[1], b.Radius[1])
    && near(a.Radius[2], b.Radius[2]) && near(a.Radius[3], b.Radius[3]);
}
