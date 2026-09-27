import { describe, it, expect } from 'vitest';
import { ScrollManager, WheelMayOverscroll } from '../src/Scroll/Scroll.Manager';
import type { Jiv } from '../src/Jiv/Jiv';

// A wheel or trackpad pull at a scroller's edge. The chain used to return a target only when a
// scroller could really move, so a pull past the top of a page found nothing and was dropped before
// the rubber band ran: `Pin`'s `@OverscrollTop` stayed 0 and Home's stretchy header never stretched
// (Chromium and Safari, 2026-09-27). The edge now falls back to the innermost scroller allowed to
// overscroll there, and only when nothing on the chain can move.

const jiv = (over: Partial<Record<string, unknown>>): Jiv => ({
  Overflow: 'Scroll', Width: 400, Height: 600, ContentWidth: 400, ContentHeight: 600,
  ScrollX: 0, ScrollY: 0, Children: [], Parent: null,
  OverscrollTop: 'Bounce', OverscrollBottom: 'Bounce', OverscrollLeft: 'Bounce', OverscrollRight: 'Bounce',
  OverscrollInput: 'Precise',
  ...over,
}) as unknown as Jiv;

const m = new ScrollManager(jiv({ Overflow: 'Visible' }));

describe('a wheel pull at an edge', () => {
  it('lands on a Pin page at its top for a trackpad delta', () => {
    const page = jiv({ ContentHeight: 3000, OverscrollTop: 'Pin' });
    expect(m.ScrollChainFrom(page, 0, -6, true).yTarget).toBe(page);
  });

  it('lands on a Bounce page too: Bounce is the engine default', () => {
    const page = jiv({ ContentHeight: 3000 });
    expect(m.ScrollChainFrom(page, 0, -6, true).yTarget).toBe(page);
  });

  it('is refused where the edge says None', () => {
    const page = jiv({ ContentHeight: 3000, OverscrollTop: 'None' });
    expect(m.ScrollChainFrom(page, 0, -6, true).yTarget).toBeNull();
  });

  it('is refused for a line-stepped wheel under the Precise default, allowed under All', () => {
    expect(m.ScrollChainFrom(jiv({ ContentHeight: 3000, OverscrollTop: 'Pin' }), 0, -100, false).yTarget).toBeNull();
    const all = jiv({ ContentHeight: 3000, OverscrollTop: 'Pin', OverscrollInput: 'All' });
    expect(m.ScrollChainFrom(all, 0, -100, false).yTarget).toBe(all);
  });

  it('is refused for every wheel when the scroller takes Touch only', () => {
    const page = jiv({ ContentHeight: 3000, OverscrollTop: 'Pin', OverscrollInput: 'Touch' });
    expect(m.ScrollChainFrom(page, 0, -6, true).yTarget).toBeNull();
  });

  it('is refused on an axis with no extent, where the rubber band cannot integrate', () => {
    expect(m.ScrollChainFrom(jiv({ OverscrollTop: 'Pin' }), 0, -6, true).yTarget).toBeNull();
  });

  it('goes to the innermost scroller allowed to overscroll when nothing can move', () => {
    const page = jiv({ ContentHeight: 3000, OverscrollTop: 'Pin' });
    const list = jiv({ Height: 300, ContentHeight: 900, Parent: page });
    expect(m.ScrollChainFrom(list, 0, -6, true).yTarget).toBe(list);
    const pinnedShut = jiv({ Height: 300, ContentHeight: 900, Parent: page, OverscrollTop: 'None' });
    expect(m.ScrollChainFrom(pinnedShut, 0, -6, true).yTarget).toBe(page);
  });
});

describe('chaining is unchanged whenever something can really move', () => {
  it('an inner list at its top chains a pull to a page that can still scroll up', () => {
    const page = jiv({ ContentHeight: 3000, ScrollY: 500, OverscrollTop: 'Pin' });
    const list = jiv({ Height: 300, ContentHeight: 900, Parent: page });
    expect(m.ScrollChainFrom(list, 0, -6, true).yTarget).toBe(page);
  });

  it('a scroller that can move keeps the delta, edge or no edge', () => {
    const page = jiv({ ContentHeight: 3000, ScrollY: 500, OverscrollTop: 'Pin' });
    expect(m.ScrollChainFrom(page, 0, -6, true).yTarget).toBe(page);
    expect(m.ScrollChainFrom(page, 0, 6, true).yTarget).toBe(page);
  });

  it('a horizontal carousel lets a vertical pull fall through to the page', () => {
    const page = jiv({ ContentHeight: 3000, OverscrollTop: 'Pin' });
    const carousel = jiv({ Height: 200, ContentWidth: 1600, ContentHeight: 200, Parent: page });
    const r = m.ScrollChainFrom(carousel, 0, -6, true);
    expect(r.yTarget).toBe(page);
    expect(r.xTarget).toBeNull();
  });
});

describe('WheelMayOverscroll', () => {
  it('reads the edge the delta points at', () => {
    const j = jiv({ ContentHeight: 3000, OverscrollTop: 'None', OverscrollBottom: 'Pin' });
    expect(WheelMayOverscroll(j, 'y', -6, true)).toBe(false);
    expect(WheelMayOverscroll(j, 'y', 6, true)).toBe(true);
    expect(WheelMayOverscroll(j, 'y', 0, true)).toBe(false);
  });
});
