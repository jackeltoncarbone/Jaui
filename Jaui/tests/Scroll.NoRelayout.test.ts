import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { JivStyleAnimator } from '../src/Jiv/Jiv.StyleAnimator';
import { ScrollManager } from '../src/Scroll/Scroll.Manager';
import { SolveLayout } from '../src/Layout/Layout.Solver';
import { DirtyFlag } from '../src/Core/Types';
import { Element } from '../src/Element/Element';

// `Element.AuthoredTracked` gates the render-only fast path (Scroll.Manager._publishVars): the
// worker registry flips it true in production (Jiv.Registry.ts). It defaults false, which makes
// every scroll frame take the safe MarkLayoutDirty fallback — correct, but not what this suite
// is pinning down — so these tests opt in, and restore the static flag after (it's process-wide).
const _priorAuthoredTracked = Element.AuthoredTracked;
beforeEach(() => { Element.AuthoredTracked = true; });
afterEach(() => { Element.AuthoredTracked = _priorAuthoredTracked; });

// THE PERFORMANCE RULE (the overscroll feature's whole reason for the render-only fast path):
// a scroll frame that only moves render-time properties (VisualScale/VisualTranslate/Opacity/
// Tint/colors) must NOT relayout or re-cascade the subtree — only the nodes that actually read
// the moved var re-resolve. This pins that down against DirtyFlag.Layout (what MarkLayoutDirty
// sets — Element.ts) rather than mocking the solver, so it holds regardless of how the host
// schedules its next solve.

const VIEWPORT = { Width: 400, Height: 600 };

/** A JwiftStretchyHeader-shaped tree: a Pin scroller with one child whose Style (only) reads
 *  `@OverscrollTop`/`@Height`. `sharedVars` stands in for the canvas's live global var table
 *  (Core/Jaui.ts `_jssVars`) — a real Map, so the identity check in
 *  `ScrollManager._publishVars` ("is the shared map still the bare global table") is meaningful. */
const makeStretchyHeaderTree = (): { root: Jiv; scroller: Jiv; header: Jiv; m: ScrollManager; headerAnimator: JivStyleAnimator } => {
  const sharedVars = new Map<string, string>();
  const header = new Jiv({
    ChildLayout: { Width: '100%', Height: '100%' },
    Style: { VisualOrigin: 'Bottom', VisualScale: '1 + @OverscrollTop / @Height' },
  });
  const scroller = new Jiv({
    ChildLayout: { Width: '100%', Height: '100%' },
    Overflow: 'Scroll',
    OverscrollTop: 'Pin',
  });
  scroller.AddChild(header);
  const root = new Jiv({ ChildLayout: { Width: '100%', Height: '100%' } });
  root.AddChild(scroller);

  const headerAnimator = new JivStyleAnimator(header);
  const m = new ScrollManager(scroller);
  m.GlobalVars = () => sharedVars;

  // Seed the scroller's OWN var map (as a real first publish already would have, on mount)
  // BEFORE the bootstrap solve, so that solve creates scroller's OWN dedicated vars map —
  // distinct from `sharedVars` — for `_buildChildCtx` to hand down to `header` by reference.
  scroller.SetVar('ScrollY', 0);
  SolveLayout(root, VIEWPORT, sharedVars);
  header.Width = 400; header.Height = 600;
  scroller.Width = 400; scroller.Height = 600;
  scroller.ContentWidth = 400; scroller.ContentHeight = 2000;

  // Clean dirty flags the bootstrap solve/construction may have left, so the assertions below
  // only see what the SCROLL FRAME itself does.
  root.Dirty = 0; scroller.Dirty = 0; header.Dirty = 0;

  return { root, scroller, header, m, headerAnimator };
};

describe('Performance: a Pin-mode scroll frame wakes render-only style, never layout', () => {
  it('never sets DirtyFlag.Layout on the scroller, the header, or the root, across an active drag', () => {
    const { root, scroller, header, m } = makeStretchyHeaderTree();

    m.DragStart(scroller);
    for (let i = 0; i < 5; i++) {
      m.DragMove(scroller, 0, -20, performance.now() + i * 8);
      expect(root.Dirty & DirtyFlag.Layout).toBe(0);
      expect(scroller.Dirty & DirtyFlag.Layout).toBe(0);
      expect(header.Dirty & DirtyFlag.Layout).toBe(0);
    }
    m.DragEnd(scroller, performance.now());
    for (let t = 0; t < 2; t += 1 / 120) {
      m.Tick(1 / 120);
      expect(header.Dirty & DirtyFlag.Layout).toBe(0);
    }
  });

  it('the render-only wake actually reaches the header: its resolved VisualScaleY tracks @OverscrollTop', () => {
    const { scroller, header, m, headerAnimator } = makeStretchyHeaderTree();
    headerAnimator.SnapToTargets();
    expect(header.RenderStyle.VisualScaleY).toBe(1); // at rest: no overscroll yet

    m.DragStart(scroller);
    m.DragMove(scroller, 0, -100, performance.now());
    const over = Number(scroller.VarMap.get('OverscrollTop'));
    expect(over).toBeGreaterThan(0);

    headerAnimator.SnapToTargets();
    expect(header.RenderStyle.VisualScaleY).toBeCloseTo(1 + over / 600, 5);
    // Layout still never ran to get this — the shared vars map was mutated in place.
    expect(header.Dirty & DirtyFlag.Layout).toBe(0);
  });
});

describe('Performance: the bootstrap case still falls back to a real solve (correctness over speed)', () => {
  it('MarkLayoutDirty fires the very first time a scroller publishes, before its own map is owned', () => {
    const sharedVars = new Map<string, string>();
    const header = new Jiv({ Style: { VisualScale: '1 + @OverscrollTop / @Height' } });
    const scroller = new Jiv({ Overflow: 'Scroll', OverscrollTop: 'Pin' });
    scroller.AddChild(header);
    const root = new Jiv({});
    root.AddChild(scroller);

    // NO prior SolveLayout, no prior SetVar: scroller.ResolveCtx is still null (never solved), so
    // `_publishVars` cannot own a merged map yet — it must MarkLayoutDirty to get one.
    const m = new ScrollManager(scroller);
    m.GlobalVars = () => sharedVars;
    scroller.Width = 400; scroller.Height = 600;
    scroller.ContentWidth = 400; scroller.ContentHeight = 2000;

    m.DragStart(scroller);
    m.DragMove(scroller, 0, -50, performance.now());
    expect(scroller.Dirty & DirtyFlag.Layout).not.toBe(0);
  });
});
