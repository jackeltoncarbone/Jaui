export interface ScrollConfig {
  ScrollX: number;
  ScrollY: number;
  Stiffness: number;
  Damping: number;
}

export const DefaultScrollConfig: ScrollConfig = {
  ScrollX: 0,
  ScrollY: 0,
  Stiffness: 120,
  Damping: 20,
};

/** How a scroll gets where it is going. `Smooth` rides the same exponential
 *  ease a mouse wheel does (~120ms for a wheel click); `Instant` lands this
 *  frame. PascalCase because every other consumer-facing enum in this engine
 *  is (Overflow, Cursor, Position) — the DOM's lowercase `ScrollBehavior` is
 *  a different vocabulary and a global type name besides. */
export type ScrollMotion = 'Smooth' | 'Instant';

/** Where an element lands inside its scroller's window. The window is the
 *  container inset by its own padding, so `Start` sets the element on the
 *  SAME leading padding line a paged card lands on (Scroll.Page.PageTarget).
 *
 *  `Nearest` is the web's `scrollIntoView({block:'nearest'})`: the minimum
 *  travel that makes the element whole, and nothing at all when it already is. */
export type ScrollAlign = 'Start' | 'Center' | 'End' | 'Nearest';

/** Which axes a scroll request may move. `Both` is right for almost every
 *  container, because an axis with no travel clamps to 0 and stays put; name
 *  an axis when a container scrolls in two and the request means only one. */
export type ScrollAxis = 'Both' | 'X' | 'Y';

/**
 * Where a `scroll-to` lands.
 *
 * AN ELEMENT TARGET IS AN ID, NOT A RECT, because the main thread does not
 * know where anything is. `JivHandle.X/Y` read 0 unless that exact node holds
 * a `WatchRect` lease, and a rail would have to lease every section it can
 * jump to, every frame, to compute a destination it needs once per press. The
 * worker owns the layout, so the worker resolves the rect; main sends the id.
 *
 * Absolute `X`/`Y` and `ElementId` are alternatives, not a blend: an element
 * target decides both axes through `Align`, and `X`/`Y` are ignored when one
 * is given. `OffsetX`/`OffsetY` adjust either, and are the way a caller says
 * "below the sticky head" without knowing the head's height at the call site.
 */
export interface ScrollToOptions {
  /** Absolute content offset, in the container's own content coordinates.
   *  Null or absent leaves that axis where it is. Ignored when `ElementId`
   *  names a target. */
  X?: number | null;
  Y?: number | null;
  /** A DESCENDANT of the scroll container to bring into view. The worker
   *  refuses a node that is not under the container rather than scrolling to
   *  a coordinate that means nothing. */
  ElementId?: number;
  /** Where the element lands in the window. Default `Start` — a jump names a
   *  place, and the place a named section belongs is the top of the view. */
  Align?: ScrollAlign;
  /** Which axes may move. Default `Both`. */
  Axis?: ScrollAxis;
  /** Added after alignment, before the content clamp. Negative pulls the
   *  landing back toward the start. */
  OffsetX?: number;
  OffsetY?: number;
  /** Default `Smooth` — a jump the reader asked for should be traversable, so
   *  they can see WHERE it went rather than being teleported. */
  Motion?: ScrollMotion;
}
