/**
 * Pure layout math for `<jinput>`. Kept free of Angular + Jaui imports so
 * it can be unit-tested with mock measurement and re-used by any consumer
 * that needs wrap-aware text layout.
 *
 * Conventions:
 *  - Segments are runs of laid-out text. They carry their `[StartIndex,
 *    EndIndex)` slice into the original Text. Higher-level components split
 *    text into segments however they need (by token, span, or one segment
 *    for the whole string) and feed this layout the result.
 *  - Coordinates are in pixels relative to the containing wrap.
 *  - `measureWidth` is the only side-channel; tests inject a stub.
 */

export interface LayoutSegmentInput {
  /** Visible text of this segment (may include trailing whitespace). */
  Text: string;
  /** Start index into the original Text. */
  StartIndex: number;
  /** End index (exclusive) into the original Text. */
  EndIndex: number;
}

export interface LaidOutSegment {
  Seg: LayoutSegmentInput;
  /** Pixel X within the wrap, on its row. */
  X: number;
  /** Pixel width as measured. */
  Width: number;
  /** Row index, 0-based. */
  Row: number;
}

export interface CaretRect { x: number; y: number; height: number; }
export interface SelRect { x: number; y: number; width: number; height: number; }

export interface LayoutMetrics {
  /** Pixel width of one text row's bounding box (font size × line-height). */
  LineHeightPx: number;
  /** Vertical pitch between row N and row N+1 (LineHeightPx + RowGap). */
  RowPitchPx: number;
  /** Maximum content width before wrapping to the next row. */
  WrapWidth: number;
}

export type MeasureFn = (text: string) => number;

/**
 * Atom-based row wrap with hard newline support.
 *
 * Two-step algorithm:
 *  1. Split segments at `\n` boundaries — each `\n` forces a new row. Empty
 *     lines (consecutive newlines) emit a zero-width placeholder anchor at
 *     the line's index, so caret positioning works on empty rows.
 *  2. Within each line, group adjacent segments into "wrap atoms". Two
 *     segments belong to the same atom when the preceding one doesn't end
 *     in whitespace — this keeps a span and any trailing punctuation
 *     ("token" + ".") on the same row, avoiding orphan punctuation at the
 *     start of a line. Atom boundaries are the only soft-break points; a
 *     single atom wider than `WrapWidth` still gets its own row.
 */
export const LayoutSegments = (
  segs: readonly LayoutSegmentInput[],
  metrics: LayoutMetrics,
  measure: MeasureFn,
): LaidOutSegment[] => {
  if (segs.length === 0) return [];

  // Step 1: split into lines at \n. Each line tracks its own startIdx so an
  // empty line can still emit a placeholder anchor for caret positioning.
  interface Line { segs: LayoutSegmentInput[]; startIdx: number; }
  const lines: Line[] = [{ segs: [], startIdx: segs[0].StartIndex }];
  for (const seg of segs) {
    if (!seg.Text.includes('\n')) {
      lines[lines.length - 1].segs.push(seg);
      continue;
    }
    let cursor = seg.StartIndex;
    const parts = seg.Text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.length > 0) {
        lines[lines.length - 1].segs.push({
          Text: part,
          StartIndex: cursor,
          EndIndex: cursor + part.length,
        });
      }
      cursor += part.length;
      if (i < parts.length - 1) {
        cursor += 1; // consumed \n
        lines.push({ segs: [], startIdx: cursor });
      }
    }
  }

  // Step 2: atom-group + row-fit each line.
  interface Atom { segs: LayoutSegmentInput[]; widths: number[]; total: number; }
  const out: LaidOutSegment[] = [];
  let row = 0;
  for (const line of lines) {
    if (line.segs.length === 0) {
      // Empty row — anchor for caret positioning.
      out.push({
        Seg: { Text: '', StartIndex: line.startIdx, EndIndex: line.startIdx },
        X: 0,
        Width: 0,
        Row: row,
      });
      row++;
      continue;
    }
    const atoms: Atom[] = [];
    let current: Atom | null = null;
    for (const seg of line.segs) {
      const w = measure(seg.Text);
      const prevText = current ? current.segs[current.segs.length - 1].Text : '';
      const prevEndsWithSpace = prevText.length > 0 && /\s$/.test(prevText);
      if (!current || prevEndsWithSpace) {
        current = { segs: [seg], widths: [w], total: w };
        atoms.push(current);
      } else {
        current.segs.push(seg);
        current.widths.push(w);
        current.total += w;
      }
    }
    let x = 0;
    let lineRow = row;
    for (const atom of atoms) {
      if (x > 0 && x + atom.total > metrics.WrapWidth) {
        lineRow++;
        x = 0;
      }
      let segX = x;
      for (let i = 0; i < atom.segs.length; i++) {
        out.push({ Seg: atom.segs[i], X: segX, Width: atom.widths[i], Row: lineRow });
        segX += atom.widths[i];
      }
      x += atom.total;
    }
    row = lineRow + 1;
  }
  return out;
};

/**
 * Compute the caret rect for character index `idx` in a laid-out segment list.
 *
 * Boundary semantics:
 *  - When `idx` is at a boundary between two adjacent segments (idx ==
 *    prev.EndIndex == next.StartIndex), the *next* segment wins so the caret
 *    snaps to x=0 of the new row after a wrap.
 *  - When the next segment is non-adjacent (gap, e.g. `\n` was consumed),
 *    pin to the right edge of `prev` instead.
 *  - An empty placeholder (s == e) acts as a row anchor: when idx == s == e
 *    the caret sits at that placeholder's row + x.
 *
 * Returns a rect even when `idx` is past the end of all text — pinned to the
 * right edge of the last segment.
 */
export const CharPosition = (
  laid: readonly LaidOutSegment[],
  idx: number,
  metrics: LayoutMetrics,
  measure: MeasureFn,
): CaretRect => {
  if (laid.length === 0) {
    return { x: 0, y: 0, height: metrics.LineHeightPx };
  }
  for (let k = 0; k < laid.length; k++) {
    const item = laid[k];
    const s = item.Seg.StartIndex;
    const e = item.Seg.EndIndex;
    if (s === e && idx === s) {
      return {
        x: item.X,
        y: item.Row * metrics.RowPitchPx,
        height: metrics.LineHeightPx,
      };
    }
    if (idx >= s && idx < e) {
      const within = item.Seg.Text.substring(0, idx - s);
      return {
        x: item.X + measure(within),
        y: item.Row * metrics.RowPitchPx,
        height: metrics.LineHeightPx,
      };
    }
    if (idx === e) {
      // Boundary at end of this segment. If the next segment is adjacent
      // (starts at e), defer — the next iter places caret at its left edge.
      // Otherwise (gap from \n or end of list) pin to right edge of this.
      const next = laid[k + 1];
      if (next && next.Seg.StartIndex === e) continue;
      return {
        x: item.X + item.Width,
        y: item.Row * metrics.RowPitchPx,
        height: metrics.LineHeightPx,
      };
    }
  }
  // idx past everything — pin to last segment's right edge.
  const last = laid[laid.length - 1];
  return {
    x: last.X + last.Width,
    y: last.Row * metrics.RowPitchPx,
    height: metrics.LineHeightPx,
  };
};

/**
 * Reverse of CharPosition: given a point (x, y) in TokenWrap-local pixels,
 * find the character index closest to that point. Used for click-to-place
 * caret and drag-to-select.
 *
 *  - Above row 0 collapses to row 0; below the last row collapses to it.
 *  - On a row with no segments (empty input), returns 0.
 *  - Inside a segment, picks the boundary edge (left or right of a glyph)
 *    nearest to x — matches DOM <input> click semantics.
 *  - x past the right edge of the rightmost segment on a row pins to that
 *    segment's EndIndex (caret at end of row).
 *  - x left of the leftmost segment pins to that segment's StartIndex
 *    (caret at start of row).
 */
export const IndexAtPoint = (
  laid: readonly LaidOutSegment[],
  x: number,
  y: number,
  metrics: LayoutMetrics,
  measure: MeasureFn,
): number => {
  if (laid.length === 0) return 0;

  // Clamp row to the [0, lastRow] range.
  const lastRow = laid[laid.length - 1].Row;
  let row = Math.floor(y / metrics.RowPitchPx);
  if (row < 0) row = 0;
  if (row > lastRow) row = lastRow;

  const onRow = laid.filter(s => s.Row === row);
  if (onRow.length === 0) return 0;

  // Left of the row's first segment → start of that segment.
  const first = onRow[0];
  if (x <= first.X) return first.Seg.StartIndex;

  // Right of the row's last segment → end of that segment.
  const last = onRow[onRow.length - 1];
  if (x >= last.X + last.Width) return last.Seg.EndIndex;

  // Inside a segment: locate the segment, then walk its glyphs.
  let target = onRow[0];
  for (const s of onRow) {
    if (x >= s.X && x <= s.X + s.Width) { target = s; break; }
    if (x >= s.X) target = s; // also handle gaps between adjacent segs
  }
  const localX = x - target.X;
  const text = target.Seg.Text;
  // Walk character offsets, snapping to whichever side of the glyph is closer.
  let prevW = 0;
  for (let i = 1; i <= text.length; i++) {
    const w = measure(text.substring(0, i));
    if (w >= localX) {
      const pickRight = (w - localX) <= (localX - prevW);
      return target.Seg.StartIndex + (pickRight ? i : i - 1);
    }
    prevW = w;
  }
  return target.Seg.EndIndex;
};

/**
 * Word range containing or adjacent to `idx`. Word = `\w+` runs. If `idx`
 * lands on a non-word character, returns the single-character range
 * `[idx, idx+1]` (or empty when `idx` is at the end of the text).
 *
 * Matches browser double-click semantics: clicking inside a word selects
 * the whole word; clicking on whitespace / punctuation selects just that
 * character (so triple-click can extend to the line / all).
 */
export const WordRangeAt = (text: string, idx: number): { start: number; end: number } => {
  if (text.length === 0) return { start: 0, end: 0 };
  if (idx >= text.length) idx = text.length - 1;
  if (idx < 0) idx = 0;
  const isWord = (ch: string): boolean => /\w/.test(ch);
  if (!isWord(text[idx])) return { start: idx, end: idx + 1 };
  let start = idx;
  while (start > 0 && isWord(text[start - 1])) start--;
  let end = idx + 1;
  while (end < text.length && isWord(text[end])) end++;
  return { start, end };
};

/**
 * Compute one or more selection rects covering `[a, b)`. Splits across rows
 * — one rect per affected row — so wrapped selections render as separate
 * highlight bars.
 */
export const RangeRects = (
  laid: readonly LaidOutSegment[],
  a: number,
  b: number,
  metrics: LayoutMetrics,
  measure: MeasureFn,
): SelRect[] => {
  if (laid.length === 0 || a >= b) return [];
  const perRow = new Map<number, { minX: number; maxX: number }>();
  for (const item of laid) {
    const s = item.Seg.StartIndex;
    const e = item.Seg.EndIndex;
    const segA = Math.max(a, s);
    const segB = Math.min(b, e);
    if (segB <= segA) continue;
    const text = item.Seg.Text;
    const startX = item.X + measure(text.substring(0, segA - s));
    const endX = item.X + measure(text.substring(0, segB - s));
    const cur = perRow.get(item.Row);
    if (!cur) {
      perRow.set(item.Row, { minX: startX, maxX: endX });
    } else {
      cur.minX = Math.min(cur.minX, startX);
      cur.maxX = Math.max(cur.maxX, endX);
    }
  }
  const out: SelRect[] = [];
  for (const [row, { minX, maxX }] of perRow) {
    out.push({
      x: minX,
      y: row * metrics.RowPitchPx,
      width: Math.max(1, maxX - minX),
      height: metrics.LineHeightPx,
    });
  }
  return out;
};
