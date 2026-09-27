import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { SolveLayout } from '../src/Layout/Layout.Solver';

// A SUBTREE re-solve used to seed its root with the GLOBAL var table, so every var an ancestor had
// cascaded into that subtree vanished below the re-solved root until the next full solve. Home's
// stretchy header is what showed it: the scroller publishes `@OverscrollTop`, the hero reads it, and a
// subtree re-layout under the scroller dropped it -- the hero's VisualScale target read 1.000 on
// alternate ticks while dragging and stayed there once the finger held still (probe, 2026-09-27:
// a 209-entry var map with the scroll vars, then a 193-entry one without them).

const viewport = { Width: 400, Height: 800 };
const globals = new Map<string, string>([['Gap', '8']]);

const tree = () => {
  const root = new Jiv({ Width: 400, Height: 800 });
  const scroller = new Jiv({ ChildLayout: { Width: '100%', Height: '100%' }, Overflow: 'Scroll' } as never);
  const column = new Jiv({ ChildLayout: { Width: '100%', Height: 1200 } });
  const hero = new Jiv({ ChildLayout: { Width: '100%', Height: 600 } });
  root.AddChild(scroller);
  scroller.AddChild(column);
  column.AddChild(hero);
  scroller.SetVar('OverscrollTop', 234);
  return { root, scroller, column, hero };
};

describe('a subtree re-solve keeps the vars its ancestors cascade', () => {
  it('a full solve hands the scroller\'s published var to its descendants', () => {
    const { root, hero } = tree();
    SolveLayout(root, viewport, globals);
    expect(hero.ResolveCtx?.Vars?.get('OverscrollTop')).toBe('234');
    expect(hero.ResolveCtx?.Vars?.get('Gap')).toBe('8');
  });

  it('a subtree solve below the scroller still sees it', () => {
    const { root, column, hero } = tree();
    SolveLayout(root, viewport, globals);
    SolveLayout(column, viewport, globals);
    expect(column.ResolveCtx?.Vars?.get('OverscrollTop')).toBe('234');
    expect(hero.ResolveCtx?.Vars?.get('OverscrollTop')).toBe('234');
    expect(hero.ResolveCtx?.Vars?.get('Gap')).toBe('8');
  });

  it('a subtree root\'s own [vars] still override what it inherits', () => {
    const { root, column, hero } = tree();
    column.SetVar('OverscrollTop', 10);
    SolveLayout(root, viewport, globals);
    SolveLayout(column, viewport, globals);
    expect(hero.ResolveCtx?.Vars?.get('OverscrollTop')).toBe('10');
  });

  it('never writes into the global table', () => {
    const { root, column } = tree();
    SolveLayout(root, viewport, globals);
    SolveLayout(column, viewport, globals);
    expect(globals.has('OverscrollTop')).toBe(false);
  });
});
