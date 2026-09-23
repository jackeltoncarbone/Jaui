import { describe, it, expect } from 'vitest';
import { ScrollManager } from '../src/Scroll/Scroll.Manager';
import type { Jiv } from '../src/Jiv/Jiv';

// A touch that starts on a horizontal carousel inside a vertical page belongs to whichever of the
// two scrolls on the drag's DOMINANT axis. Jack on an iPhone, 2026-09-23: a vertical swipe begun on
// the carousel only ever moved the carousel, which is not what a browser does. The drag's owner is
// now decided by direction, not by which scroller happened to be under the finger first.

const jiv = (over: Partial<Record<string, unknown>>): Jiv => ({
  Overflow: 'Scroll', Width: 400, Height: 600, ContentWidth: 400, ContentHeight: 600,
  Children: [], Parent: null, ...over,
}) as unknown as Jiv;

const page = jiv({ ContentHeight: 3000 });
const carousel = jiv({ Width: 400, Height: 200, ContentWidth: 1600, ContentHeight: 200 });
const m = new ScrollManager(jiv({ Overflow: 'Visible' }));
const underFinger = [carousel, page];

describe('a drag across nested scrollers', () => {
  it('goes to the page when it is mostly vertical', () => {
    expect(m.PickDragTarget(underFinger, 3, 14)).toBe(page);
    expect(m.PickDragTarget(underFinger, -2, -30)).toBe(page);
  });

  it('goes to the carousel when it is mostly horizontal', () => {
    expect(m.PickDragTarget(underFinger, 14, 3)).toBe(carousel);
    expect(m.PickDragTarget(underFinger, -30, 5)).toBe(carousel);
  });

  it('goes to the innermost when nothing scrolls that way', () => {
    const short = jiv({ ContentHeight: 600 });
    expect(m.PickDragTarget([carousel, short], 0, 20)).toBe(carousel);
  });

  it('has no owner when nothing is under the finger', () => {
    expect(m.PickDragTarget([], 0, 20)).toBeNull();
  });
});
