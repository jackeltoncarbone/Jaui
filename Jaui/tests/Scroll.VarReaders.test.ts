import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { SubtreeReadsScrollVars, AnalyzeScrollVarUsage, SCROLL_VARS } from '../src/Scroll/Scroll.VarReaders';

// A scroller re-solves its subtree when it moves only when something under it can read what it publishes.

const scroller = (...children: Jiv[]): Jiv => {
  const s = new Jiv({ ChildLayout: { Width: '100%', Height: '100%' }, Style: { Opacity: '1' } });
  for (const c of children) s.AddChild(c);
  return s;
};
const none = new Map<string, string>();

describe('SubtreeReadsScrollVars', () => {
  it('is false for a subtree that references no scroll var', () => {
    const s = scroller(new Jiv({ ChildLayout: { Width: '20pt', Height: '@Row' }, Layout: { Padding: '@Gap' } }));
    expect(SubtreeReadsScrollVars(s, new Map([['Row', '44pt'], ['Gap', '8pt']]))).toBe(false);
  });

  it('sees a scroll var in a length, a style and a predicate', () => {
    expect(SubtreeReadsScrollVars(scroller(new Jiv({ ChildLayout: { Top: '@ScrollFracY * 10pt' } })), none)).toBe(true);
    expect(SubtreeReadsScrollVars(scroller(new Jiv({ Style: { Opacity: '@ScrollActive' } })), none)).toBe(true);
    const p = new Jiv({});
    p.SetPredicateStyles([{ Predicate: { Kind: 'Var', Name: 'ScrollActive' }, Style: { Opacity: '1' } }]);
    expect(SubtreeReadsScrollVars(scroller(p), none)).toBe(true);
  });

  it('follows a var whose definition reaches a scroll var, globally or on an element', () => {
    const reader = (): Jiv => new Jiv({ ChildLayout: { Top: '@Thumb' } });
    expect(SubtreeReadsScrollVars(scroller(reader()), new Map([['Thumb', '@Half * 2'], ['Half', '@ScrollY / 2']]))).toBe(true);
    expect(SubtreeReadsScrollVars(scroller(reader()), new Map([['Thumb', '4pt']]))).toBe(false);
    const s = scroller(reader());
    s.SetVar('Thumb', '@ScrollY');
    expect(SubtreeReadsScrollVars(s, new Map([['Thumb', '4pt']]))).toBe(true);
  });

  it('treats a var it cannot see the definition of as reaching', () => {
    expect(SubtreeReadsScrollVars(scroller(new Jiv({ ChildLayout: { Top: '@Nowhere' } })), none)).toBe(true);
  });

  it('reads again after an authored write bumps the version', () => {
    const child = new Jiv({ ChildLayout: { Top: '4pt' } });
    const s = scroller(child);
    expect(SubtreeReadsScrollVars(s, none)).toBe(false);
    child.ChildLayout.Top = '@ScrollY';
    child.AuthoredVersion++;
    expect(SubtreeReadsScrollVars(s, none)).toBe(true);
  });
});

describe('AnalyzeScrollVarUsage', () => {
  const changed = new Set(['OverscrollTop']);

  it('classifies a Style-only reference as render-only, no layout needed', () => {
    const header = new Jiv({ Style: { VisualScale: '1 + @OverscrollTop / @Height' } });
    const usage = AnalyzeScrollVarUsage(scroller(header), changed, none);
    expect(usage.NeedsLayout).toBe(false);
    expect(usage.RenderOnly).toEqual([header]);
  });

  it('forces NeedsLayout when a Layout/ChildLayout bag reaches the same var', () => {
    const stickyChild = new Jiv({ ChildLayout: { Top: '@OverscrollTop' } });
    const usage = AnalyzeScrollVarUsage(scroller(stickyChild), changed, none);
    expect(usage.NeedsLayout).toBe(true);
    expect(usage.RenderOnly).toEqual([]);
  });

  it('ignores @Height/@Width — the node\'s own box, never scroll state', () => {
    const header = new Jiv({ Style: { VisualScale: '1 + @Height / 100' } });
    const usage = AnalyzeScrollVarUsage(scroller(header), changed, none);
    expect(usage.NeedsLayout).toBe(false);
    expect(usage.RenderOnly).toEqual([]);
  });

  it('follows an indirect var chain into a Style bag', () => {
    const header = new Jiv({ Style: { VisualScale: '1 + @HeaderPull' } });
    const usage = AnalyzeScrollVarUsage(scroller(header), changed, new Map([['HeaderPull', '@OverscrollTop / 100']]));
    expect(usage.NeedsLayout).toBe(false);
    expect(usage.RenderOnly).toEqual([header]);
  });

  it('a node reaching neither bag is left out of both', () => {
    const plain = new Jiv({ Style: { Opacity: '0.5' } });
    const usage = AnalyzeScrollVarUsage(scroller(plain), changed, none);
    expect(usage.NeedsLayout).toBe(false);
    expect(usage.RenderOnly).toEqual([]);
  });

  it('publishes ScrollProgress and the four Overscroll* vars', () => {
    for (const name of ['ScrollProgress', 'OverscrollTop', 'OverscrollBottom', 'OverscrollLeft', 'OverscrollRight']) {
      expect(SCROLL_VARS.has(name)).toBe(true);
    }
  });
});
