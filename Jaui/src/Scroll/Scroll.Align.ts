import type { ScrollAlign } from './Scroll.Types';

/** One element's extent along the scroll axis, in the container's un-scrolled
 *  content coordinates — the same coordinates `PageSpan` is in, because they
 *  come from the same subtraction (`child.X - container.X`). Layout positions
 *  in this engine are un-scrolled; scroll is applied at paint and hit time. */
export interface AlignSpan {
  Start: number;
  Size: number;
}

/** A span within this of a window edge counts as fully shown, so sub-point
 *  layout dust never buys a scroll nobody asked for. Matches Scroll.Page. */
const EDGE_EPSILON = 0.5;

/**
 * Where a container lands so that `span` sits at `align` inside its window.
 *
 * THE WINDOW IS THE CONTAINER INSET BY ITS OWN PADDING, not its border box.
 * That is the line a paged card already lands on ("the card cut off at the
 * trailing edge becomes the FIRST card, set on the row's leading padding
 * line" — Scroll.Page.PageTarget), and a jump that ignored padding would set
 * a section flush against an edge the rest of the page never touches.
 *
 * `from` is the container's PENDING target rather than its eased position, so
 * `Nearest` judges against where the scroll is going. Two jumps in flight
 * compose instead of the second re-deciding against a stale middle.
 *
 * The result is clamped into [0, max]: asking for a section below the last
 * screenful lands at the bottom, which is the only place it can be.
 */
export const AlignTarget = (
  span: AlignSpan,
  from: number,
  view: number,
  padStart: number,
  padEnd: number,
  max: number,
  align: ScrollAlign,
): number => {
  const window = Math.max(0, view - padStart - padEnd);
  const start = span.Start - padStart;
  const end = span.Start + span.Size + padEnd - view;
  const clamp = (v: number): number => Math.max(0, Math.min(max, v));

  switch (align) {
    case 'Start':
      return clamp(start);
    case 'End':
      return clamp(end);
    case 'Center':
      return clamp(span.Start + span.Size / 2 - (padStart + window / 2));
    case 'Nearest': {
      // An element taller than the window can never be whole, so there is no
      // "minimum travel that reveals it" — show it from its start, which is
      // what the web does with an oversized target too.
      if (span.Size > window) return clamp(start);
      const viewStart = from + padStart;
      const viewEnd = from + view - padEnd;
      if (span.Start < viewStart - EDGE_EPSILON) return clamp(start);
      if (span.Start + span.Size > viewEnd + EDGE_EPSILON) return clamp(end);
      return clamp(from);
    }
  }
};
