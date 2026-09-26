import { describe, expect, it } from 'vitest';
import {
  CharPosition, IndexAtPoint, LayoutSegments, RangeRects, SegmentsFromSpans,
  type LayoutMetrics, type LayoutSpan,
} from '../src/Jinput/Jinput.Layout';

// Every glyph is 10 px and a space is 5 px, so widths read straight off the text.
const measure = (text: string): number => {
  let w = 0;
  for (const ch of text) w += /\s/.test(ch) ? 5 : 10;
  return w;
};
const metrics = (wrap: number): LayoutMetrics => ({ LineHeightPx: 20, RowPitchPx: 24, WrapWidth: wrap });

// The drill sentence's spans: each token carries its trailing space, as ClauseSpans does.
const tokenSpans = (text: string, words: string[]): LayoutSpan[] => words.map((w) => {
  const start = text.indexOf(w);
  let end = start + w.length;
  while (text[end] === ' ') end++;
  return { Start: start, End: end, Color: '#f00' };
});

const lay = (text: string, words: string[], wrap: number) =>
  LayoutSegments(SegmentsFromSpans(text, tokenSpans(text, words)), metrics(wrap), measure);

describe('Jinput layout: tokens inline', () => {
  it('sits tokens inline with one space between neighbors when the line fits', () => {
    const text = 'Trumpets move 8 to the left';
    const laid = lay(text, ['Trumpets', 'move', '8'], 1000);
    expect(laid.every((s) => s.Row === 0)).toBe(true);
    expect(laid.map((s) => s.Seg.Text)).toEqual(['Trumpets ', 'move ', '8 ', 'to the left']);
    // Each segment starts exactly where the previous one's text (and its one space) ended.
    for (let i = 1; i < laid.length; i++) expect(laid[i].X).toBe(laid[i - 1].X + laid[i - 1].Width);
    expect(laid[0].Width).toBe(85);
    expect(laid[1].X).toBe(85);
  });

  it('measures a token at its own text plus its trailing space, never more', () => {
    const laid = lay('Band halt', ['Band'], 1000);
    expect(laid[0].Width).toBe(measure('Band '));
    expect(laid[1].X).toBe(measure('Band '));
    expect(laid[1].Width).toBe(measure('halt'));
  });

  it('places each rendered box past leading whitespace the renderer drops', () => {
    const laid = LayoutSegments(SegmentsFromSpans('  Band', []), metrics(1000), measure);
    expect(laid[0].X).toBe(0);
    expect(laid[0].InkX).toBe(10);
  });
});

describe('Jinput layout: wrap only at overflow', () => {
  it('keeps everything on one row when it fits exactly', () => {
    // "aaaa bbbb" = 40 + 5 + 40 = 85.
    const laid = lay('aaaa bbbb', ['aaaa'], 85);
    expect(new Set(laid.map((s) => s.Row))).toEqual(new Set([0]));
  });

  it('does not wrap a word whose only overflow is its trailing space', () => {
    // "aaaa bbbb " is 90 wide, but the glyphs end at 85.
    const laid = lay('aaaa bbbb cc', ['aaaa', 'bbbb'], 85);
    const rows = laid.map((s) => [s.Seg.Text, s.Row]);
    expect(rows).toEqual([['aaaa ', 0], ['bbbb ', 0], ['cc', 1]]);
  });

  it('wraps a token to the next row only when it does not fit', () => {
    const text = 'aaaa bbbb cccc';
    const laid = lay(text, ['cccc'], 100);
    const token = laid.find((s) => s.Seg.Text === 'cccc')!;
    expect(token.Row).toBe(1);
    expect(token.X).toBe(0);
    expect(token.Y).toBe(24);
    expect(laid.find((s) => s.Seg.Text.startsWith('aaaa'))!.Row).toBe(0);
  });

  it('never strands a token alone on a row when the next word would fit beside it', () => {
    const text = 'aaaaaaa bb cc';
    const laid = lay(text, ['bb'], 120);
    // 70 + 5 + 20 + 5 + 20 = 120: all three fit on one row.
    expect(laid.every((s) => s.Row === 0)).toBe(true);
  });

  it('keeps a token and punctuation after it together across a wrap', () => {
    // "cccc" alone would fit (ends at 130), but "cccc." would not (140): the pair wraps together.
    const text = 'aaaa bbbb cccc.';
    const spans: LayoutSpan[] = [{ Start: 10, End: 14, Color: '#f00' }];
    const laid = LayoutSegments(SegmentsFromSpans(text, spans), metrics(135), measure);
    const token = laid.find((s) => s.Seg.Text === 'cccc')!;
    const dot = laid.find((s) => s.Seg.Text === '.')!;
    expect(token.Row).toBe(1);
    expect(dot.Row).toBe(1);
    expect(dot.X).toBe(token.X + token.Width);
  });

  it('splits one long plain segment into a piece per row', () => {
    const laid = LayoutSegments(SegmentsFromSpans('aaaa bbbb cccc dddd', []), metrics(90), measure);
    expect(laid.map((s) => [s.Seg.Text, s.Row])).toEqual([['aaaa bbbb ', 0], ['cccc dddd', 1]]);
  });

  it('works at phone and desktop widths alike', () => {
    const text = 'Trumpets and flutes move 8 to the left on counts 1 to 16';
    const words = ['Trumpets', 'flutes', 'move', '8', 'left', '16'];
    for (const wrap of [300, 1200]) {
      const laid = lay(text, words, wrap);
      const rows = new Map<number, number>();
      for (const s of laid) rows.set(s.Row, Math.max(rows.get(s.Row) ?? 0, s.X + measure(s.Seg.Text.trimEnd())));
      for (const right of rows.values()) expect(right).toBeLessThanOrEqual(wrap);
      // Every row but the last was full: the first word of the next row would not have fit on it.
      const lastRow = Math.max(...rows.keys());
      for (let r = 0; r < lastRow; r++) {
        const next = laid.find((s) => s.Row === r + 1)!;
        const firstWord = /^\S+/.exec(next.Seg.Text)![0];
        const rowEnd = Math.max(...laid.filter((s) => s.Row === r).map((s) => s.X + s.Width));
        expect(rowEnd + measure(firstWord)).toBeGreaterThan(wrap);
      }
    }
  });
});

describe('Jinput layout: caret and selection line up with the pieces', () => {
  const text = 'aaaa bbbb cccc';
  const laid = lay(text, ['bbbb'], 100);

  it('puts the caret at the token start and on the wrapped row', () => {
    expect(CharPosition(laid, 5, metrics(100), measure)).toEqual({ x: 45, y: 0, height: 20 });
    expect(CharPosition(laid, 10, metrics(100), measure)).toEqual({ x: 0, y: 24, height: 20 });
  });

  it('hit-tests back to the same indices', () => {
    expect(IndexAtPoint(laid, 45, 10, metrics(100), measure)).toBe(5);
    expect(IndexAtPoint(laid, 1, 30, metrics(100), measure)).toBe(10);
  });

  it('draws one selection rect per row', () => {
    const rects = RangeRects(laid, 5, 12, metrics(100), measure);
    expect(rects).toEqual([
      { x: 45, y: 0, width: 45, height: 20 },
      { x: 0, y: 24, width: 20, height: 20 },
    ]);
  });
});

describe('SegmentsFromSpans', () => {
  it('never draws a character twice when spans overlap', () => {
    const segs = SegmentsFromSpans('abcdef', [{ Start: 0, End: 4 }, { Start: 2, End: 6 }]);
    expect(segs.map((s) => s.Text).join('')).toBe('abcdef');
    expect(segs.map((s) => [s.StartIndex, s.EndIndex])).toEqual([[0, 4], [4, 6]]);
  });

  it('clamps a stale span past the end of the text', () => {
    const segs = SegmentsFromSpans('abc', [{ Start: 1, End: 9 }]);
    expect(segs.map((s) => s.Text)).toEqual(['a', 'bc']);
  });

  it('keeps a hard newline split segment in its span color', () => {
    const laid = LayoutSegments(SegmentsFromSpans('ab\ncd', [{ Start: 0, End: 5, Color: '#0f0' }]), metrics(100), measure);
    expect(laid.map((s) => [s.Seg.Text, s.Seg.Color, s.Row])).toEqual([['ab', '#0f0', 0], ['cd', '#0f0', 1]]);
  });
});
