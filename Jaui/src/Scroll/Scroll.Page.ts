/** One flow child's extent along the scroll axis, in the container's
 *  un-scrolled content coordinates (0 = the container's own leading edge). */
export interface PageSpan {
  Start: number;
  End: number;
}

/** A span that ends within this of the window edge counts as fully shown, so
 *  sub-point layout dust never pages by a whole card. */
const EDGE_EPSILON = 0.5;

/**
 * Where a row lands after one page, the way Apple's content shelves step: the
 * card cut off at the trailing edge becomes the FIRST card, set on the row's
 * leading padding line, and going back the card cut off at the leading edge
 * becomes the LAST. So a page is a whole number of cards at any width and a
 * card is never skipped half-seen.
 *
 * `from` is the pending target, not the eased position, so presses made while
 * an ease is still running compose instead of re-stepping the same card.
 */
export const PageTarget = (
  spans: readonly PageSpan[],
  from: number,
  view: number,
  padStart: number,
  padEnd: number,
  max: number,
  direction: 1 | -1,
): number => {
  const window = Math.max(0, view - padStart - padEnd);
  let target: number;
  if (direction === 1) {
    const windowEnd = from + view - padEnd;
    const cut = spans.find((s) => s.End > windowEnd + EDGE_EPSILON);
    target = cut ? cut.Start - padStart : max;
    // A card wider than the window would pin the row where it is.
    if (target <= from + EDGE_EPSILON) target = from + window;
  } else {
    const windowStart = from + padStart;
    let cut: PageSpan | undefined;
    for (const s of spans) if (s.Start < windowStart - EDGE_EPSILON) cut = s;
    target = cut ? cut.End + padEnd - view : 0;
    if (target >= from - EDGE_EPSILON) target = from - window;
  }
  return Math.max(0, Math.min(max, target));
};
