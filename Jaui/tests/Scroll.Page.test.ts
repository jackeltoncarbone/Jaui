import { describe, it, expect } from 'vitest';
import { PageTarget, type PageSpan } from '../src/Scroll/Scroll.Page';
import { ScrollManager } from '../src/Scroll/Scroll.Manager';
import type { Jiv } from '../src/Jiv/Jiv';

// A shelf pages by whole cards: the card cut off at the edge it moves toward
// lands on the padding line. Rows are built the way the surface lays them out,
// cards of `card` at `gap`, starting on the leading padding.
const row = (count: number, card: number, gap: number, pad: number): PageSpan[] =>
  Array.from({ length: count }, (_, i) => ({ Start: pad + i * (card + gap), End: pad + i * (card + gap) + card }));

const maxOf = (spans: PageSpan[], view: number, pad: number): number =>
  Math.max(0, spans[spans.length - 1].End + pad - view);

describe('PageTarget: one page is a whole number of cards', () => {
  // A 1440 window over a 1180 column: three cards of (1140 - 32) / 3 across, the row bled 150 either side.
  const card = (1140 - 32) / 3, gap = 16, pad = 150, view = 1440;

  it('forward from the start lands the fourth card on the column line', () => {
    const spans = row(4, card, gap, pad);
    const max = maxOf(spans, view, pad);
    expect(PageTarget(spans, 0, view, pad, pad, max, 1)).toBeCloseTo(Math.min(max, 3 * (card + gap)), 5);
  });

  it('a row of four clamps at its end, so the last page is not empty', () => {
    const spans = row(4, card, gap, pad);
    const max = maxOf(spans, view, pad);
    expect(PageTarget(spans, 0, view, pad, pad, max, 1)).toBe(max);
    expect(max).toBeCloseTo(card + gap, 5);
  });

  it('seven cards page 3, then clamp to the last card on the trailing line', () => {
    const spans = row(7, card, gap, pad);
    const max = maxOf(spans, view, pad);
    const first = PageTarget(spans, 0, view, pad, pad, max, 1);
    expect(first).toBeCloseTo(3 * (card + gap), 5);
    const second = PageTarget(spans, first, view, pad, pad, max, 1);
    expect(second).toBe(max);
    expect(PageTarget(spans, second, view, pad, pad, max, 1)).toBe(max);
  });

  it('back is the inverse: the cut card becomes the last one shown, and back from the first page is 0', () => {
    const spans = row(7, card, gap, pad);
    const max = maxOf(spans, view, pad);
    const at = 3 * (card + gap);
    expect(PageTarget(spans, at, view, pad, pad, max, -1)).toBeCloseTo(0, 5);
    expect(PageTarget(spans, 0, view, pad, pad, max, -1)).toBe(0);
  });

  it('a phone rail of 78% cards pages one card at a time', () => {
    // 393 wide, 20pt gutters, 12pt gap, cards 78% of the 353pt column.
    const phoneCard = 353 * 0.78;
    const spans = row(5, phoneCard, 12, 20);
    const max = maxOf(spans, 393, 20);
    expect(PageTarget(spans, 0, 393, 20, 20, max, 1)).toBeCloseTo(phoneCard + 12, 5);
  });

  it('a card wider than the window still moves the row by a window', () => {
    const spans = row(3, 1200, 16, 20);
    const max = maxOf(spans, 800, 20);
    expect(PageTarget(spans, 0, 800, 20, 20, max, 1)).toBe(760);
  });

  it('half-point layout dust does not page past a card that is fully shown', () => {
    const spans = row(7, card, gap, pad).map((s, i) => (i === 2 ? { Start: s.Start, End: s.End + 0.3 } : s));
    const max = maxOf(spans, view, pad);
    expect(PageTarget(spans, 0, view, pad, pad, max, 1)).toBeCloseTo(3 * (card + gap), 5);
  });
});

describe('ScrollManager.PageX eases to the page target', () => {
  it('pages a row of five from its children and settles there', () => {
    const cardW = 300, gap = 16, pad = 20;
    const children = Array.from({ length: 5 }, (_, i) => ({
      X: pad + i * (cardW + gap), Width: cardW, ChildLayout: { Position: 'Flow' }, Children: [], Overflow: 'Visible',
    }));
    const vars = new Map<string, string | number | boolean>();
    const jiv = {
      ScrollX: 0, ScrollY: 0, ScrollTargetX: 0, ScrollTargetY: 0,
      X: 0, Y: 0, Width: 800, Height: 300, ContentWidth: pad + 5 * cardW + 4 * gap + pad, ContentHeight: 300,
      Overflow: 'Scroll', Children: children, Parent: null, Visible: true,
      ChildLayout: { Position: 'Flow' }, VarMap: vars,
      SetVar: (n: string, v: string | number | boolean) => { vars.set(n, v); },
      MarkLayoutDirty: () => {},
    } as unknown as Jiv;
    const root = { Overflow: 'Visible', Children: [jiv], Visible: true, ChildLayout: { Position: 'Flow' } } as unknown as Jiv;
    const m = new ScrollManager(root);
    m.PageX(jiv, 1, pad, pad);
    for (let i = 0; i < 600 && m.Tick(1 / 120); i++) { /* settle */ }
    // Cards 1 and 2 end at 336 and 652; the third ends at 968, past 780, so it leads the next page.
    expect(jiv.ScrollX).toBeCloseTo(2 * (cardW + gap), 3);
  });
});
