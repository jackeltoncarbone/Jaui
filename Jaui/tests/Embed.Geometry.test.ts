import { describe, expect, it } from 'vitest';
import {
  EmbedBoxesEqual, MeasureEmbedBox,
  type EmbedTreeNode,
} from '@jaui/Embed/Embed.Geometry';

/**
 * The placement math behind `<jembed>`. These are the cases a DOM embed gets
 * WRONG if the walk is wrong, and each one is a visible defect: a Stripe
 * iframe left floating over unrelated content after a list scrolled, or one
 * standing at full strength over a sheet that is still fading up.
 */

interface FakeNode extends EmbedTreeNode {
  Opacity: number;
  Radius: readonly [number, number, number, number];
  Parent: FakeNode | null;
}

const node = (p: Partial<FakeNode> = {}): FakeNode => ({
  X: 0, Y: 0, Width: 100, Height: 40,
  ScrollX: 0, ScrollY: 0,
  Visible: true,
  ClipsChildren: false,
  Parent: null,
  Opacity: 1,
  Radius: [0, 0, 0, 0],
  ...p,
});

const opacityOf = (n: EmbedTreeNode): number => (n as FakeNode).Opacity;
const radiusOf = (n: EmbedTreeNode): readonly [number, number, number, number] =>
  (n as FakeNode).Radius;
const measure = (n: FakeNode) => MeasureEmbedBox(n, opacityOf, radiusOf);

describe('MeasureEmbedBox — placement', () => {
  it('a top-level node places at its own committed rect', () => {
    const box = measure(node({ X: 20, Y: 30, Width: 200, Height: 80 }));
    expect(box).toMatchObject({ X: 20, Y: 30, Width: 200, Height: 80, Hidden: false });
    // Nothing clips it, so the visible rect is the whole rect.
    expect(box.ClipX).toBe(20);
    expect(box.ClipY).toBe(30);
    expect(box.ClipWidth).toBe(200);
    expect(box.ClipHeight).toBe(80);
  });

  it('subtracts every ancestor scroll offset', () => {
    const grandparent = node({ X: 0, Y: 0, Width: 400, Height: 400, ScrollY: 100 });
    const parent = node({ X: 0, Y: 0, Width: 400, Height: 400, ScrollY: 25, Parent: grandparent });
    const child = node({ X: 10, Y: 300, Parent: parent });
    const box = measure(child);
    expect(box.Y).toBe(300 - 125);
  });

  it("a node's OWN scroll does not move itself", () => {
    const self = node({ X: 0, Y: 0, ScrollX: 50, ScrollY: 50 });
    expect(measure(self)).toMatchObject({ X: 0, Y: 0 });
  });
});

describe('MeasureEmbedBox — clipping', () => {
  // A 200x100 viewport scrolled down 60, holding a 200x100 row at y=0.
  const scrolled = (scrollY: number): FakeNode => {
    const viewport = node({
      X: 0, Y: 0, Width: 200, Height: 100,
      ScrollY: scrollY, ClipsChildren: true,
    });
    return node({ X: 0, Y: 0, Width: 200, Height: 100, Parent: viewport });
  };

  it('narrows the visible rect to a clipping ancestor', () => {
    const box = measure(scrolled(60));
    // The row is at -60; only its bottom 40pt are inside the viewport.
    expect(box.Y).toBe(-60);
    expect(box.ClipY).toBe(0);
    expect(box.ClipHeight).toBe(40);
    expect(box.Hidden).toBe(false);
  });

  it('hides a node scrolled entirely out of its clipping ancestor', () => {
    const box = measure(scrolled(140));
    expect(box.Hidden).toBe(true);
    expect(box.ClipWidth).toBe(0);
    expect(box.ClipHeight).toBe(0);
  });

  it('intersects MULTIPLE clipping ancestors', () => {
    const outer = node({ X: 0, Y: 0, Width: 200, Height: 200, ClipsChildren: true });
    const inner = node({ X: 50, Y: 50, Width: 200, Height: 200, ClipsChildren: true, Parent: outer });
    const child = node({ X: 50, Y: 50, Width: 200, Height: 200, Parent: inner });
    const box = measure(child);
    // Outer stops at 200; inner starts at 50. Visible band is 50..200.
    expect(box.ClipX).toBe(50);
    expect(box.ClipY).toBe(50);
    expect(box.ClipWidth).toBe(150);
    expect(box.ClipHeight).toBe(150);
  });

  it('places a clipping ancestor by the scroll ABOVE it, not below', () => {
    // The page scrolls; the list inside it clips but does not scroll. The
    // list's own clip window has to move with the page.
    const page = node({ X: 0, Y: 0, Width: 300, Height: 300, ScrollY: 40 });
    const list = node({ X: 0, Y: 100, Width: 300, Height: 100, ClipsChildren: true, Parent: page });
    const row = node({ X: 0, Y: 100, Width: 300, Height: 100, Parent: list });
    const box = measure(row);
    // Row screen Y = 100 - 40 = 60; the list's window is also at 60.
    expect(box.Y).toBe(60);
    expect(box.ClipY).toBe(60);
    expect(box.ClipHeight).toBe(100);
    expect(box.Hidden).toBe(false);
  });

  it('a non-clipping ancestor never narrows anything', () => {
    const parent = node({ X: 0, Y: 0, Width: 10, Height: 10, ClipsChildren: false });
    const child = node({ X: 0, Y: 0, Width: 200, Height: 200, Parent: parent });
    expect(measure(child).ClipWidth).toBe(200);
  });
});

describe('MeasureEmbedBox — visibility, opacity and radii', () => {
  it('hides when the node itself is not visible', () => {
    expect(measure(node({ Visible: false })).Hidden).toBe(true);
  });

  it('hides when any ANCESTOR is not visible', () => {
    const parent = node({ Visible: false });
    expect(measure(node({ Parent: parent })).Hidden).toBe(true);
  });

  it('hides a zero-area node', () => {
    expect(measure(node({ Width: 0 })).Hidden).toBe(true);
    expect(measure(node({ Height: 0 })).Hidden).toBe(true);
  });

  // A NODE WITH NO RECT. The layout solve does not always produce one: a length
  // the parser refuses throws out through SolveLayout and leaves the whole tree
  // unsolved. Zero is caught by the area test above, but NaN is not (`NaN <= 0`
  // is false) and would reach the DOM as `left: NaNpx` — silently dropped,
  // stranding the embed at its last good position over unrelated content.
  it('hides a node whose rect is not a number', () => {
    expect(measure(node({ Width: Number.NaN })).Hidden).toBe(true);
    expect(measure(node({ X: Number.NaN })).Hidden).toBe(true);
    expect(measure(node({ Y: Number.POSITIVE_INFINITY })).Hidden).toBe(true);
    expect(measure(node({ Height: Number.NEGATIVE_INFINITY })).Hidden).toBe(true);
  });

  it('hides a node under an ancestor whose rect is not a number', () => {
    const broken = node({ X: Number.NaN, Width: 100, Height: 100, ClipsChildren: true });
    expect(measure(node({ Parent: broken })).Hidden).toBe(true);
  });

  it('never emits an opacity the DOM would reject', () => {
    expect(measure(node({ Opacity: Number.NaN })).Opacity).toBe(0);
    expect(measure(node({ Opacity: 1.4 })).Opacity).toBe(1);
    expect(measure(node({ Opacity: -0.2 })).Opacity).toBe(0);
  });

  it('multiplies opacity up the chain so an embed fades with its sheet', () => {
    const sheet = node({ Opacity: 0.5 });
    const frame = node({ Opacity: 0.5, Parent: sheet });
    expect(measure(node({ Opacity: 1, Parent: frame })).Opacity).toBeCloseTo(0.25);
  });

  it("carries the node's own resolved corner radii", () => {
    expect(measure(node({ Radius: [12, 12, 4, 4] })).Radius).toEqual([12, 12, 4, 4]);
  });
});

describe('EmbedBoxesEqual', () => {
  const box = measure(node());

  it('has no previous box to match on the first measurement', () => {
    expect(EmbedBoxesEqual(undefined, box)).toBe(false);
  });

  it('matches an unchanged box, so a static embed posts nothing', () => {
    expect(EmbedBoxesEqual(box, measure(node()))).toBe(true);
  });

  it('treats two hidden boxes as the same however they differ', () => {
    const a = measure(node({ Visible: false, X: 0 }));
    const b = measure(node({ Visible: false, X: 900 }));
    expect(EmbedBoxesEqual(a, b)).toBe(true);
  });

  it('ignores sub-hundredth drift, so a settling spring stops posting', () => {
    expect(EmbedBoxesEqual(box, measure(node({ X: 0.004 })))).toBe(true);
    expect(EmbedBoxesEqual(box, measure(node({ X: 0.5 })))).toBe(false);
  });

  it('notices a change in clip, opacity or radius alone', () => {
    const clipped = node({ Parent: node({ X: 0, Y: 0, Width: 50, Height: 40, ClipsChildren: true }) });
    expect(EmbedBoxesEqual(box, measure(clipped))).toBe(false);
    expect(EmbedBoxesEqual(box, measure(node({ Opacity: 0.4 })))).toBe(false);
    expect(EmbedBoxesEqual(box, measure(node({ Radius: [8, 8, 8, 8] })))).toBe(false);
  });
});
