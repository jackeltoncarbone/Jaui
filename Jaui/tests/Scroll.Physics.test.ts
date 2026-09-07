import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ScrollManager } from '../src/Scroll/Scroll.Manager';
import type { Jiv } from '../src/Jiv/Jiv';

// The scroll FEEL, pinned as numbers. These are the behaviors the audit found
// promised-but-dead (rubber-band), missing (ScrollTo), or mistuned (a fling
// that died in 0.6s). A fake jiv is enough: the manager only reads geometry.

const makeJiv = (over: Partial<Record<string, unknown>> = {}): Jiv => {
  const vars = new Map<string, string | number | boolean>();
  return {
    ScrollX: 0, ScrollY: 0, ScrollTargetX: 0, ScrollTargetY: 0,
    Width: 400, Height: 600, ContentWidth: 400, ContentHeight: 2000,
    Overflow: 'Scroll', Children: [], Parent: null, Visible: true,
    ChildLayout: { Position: 'Flow' },
    VarMap: vars,
    SetVar: (name: string, value: string | number | boolean) => { vars.set(name, value); },
    MarkLayoutDirty: () => {},
    ...over,
  } as unknown as Jiv;
};

const makeManager = (jiv: Jiv): ScrollManager => {
  const root = makeJiv({ Overflow: 'Visible', Children: [jiv], ContentHeight: 600 });
  (jiv as unknown as { Parent: Jiv }).Parent = root;
  return new ScrollManager(root);
};

/** Run the physics at a fixed 120Hz until it settles or the budget runs out.
 *  Returns the seconds it stayed active. */
beforeEach(() => { vi.useFakeTimers({ toFake: ['performance'] }); });
afterEach(() => { vi.useRealTimers(); });

/** A drag gesture with honest timing: samples spaced in (fake) real time so
 *  the release-window velocity means what it means on a device. */
const drag = (m: ScrollManager, jiv: Jiv, dyPerFrame: number, frames: number): void => {
  m.DragStart(jiv);
  for (let i = 0; i < frames; i++) {
    vi.advanceTimersByTime(8);
    m.DragMove(jiv, 0, dyPerFrame, 8 / 1000);
  }
  m.DragEnd(jiv);
};

const settle = (m: ScrollManager, maxSec = 10): number => {
  const dt = 1 / 120;
  for (let t = 0; t < maxSec; t += dt) {
    if (!m.Tick(dt)) return t;
  }
  return maxSec;
};

describe('rubber-band: the edge stretches and springs home', () => {
  it('dragging past the top overshoots, with resistance, not linearly', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.DragStart(jiv);
    vi.advanceTimersByTime(8);
    m.DragMove(jiv, 0, -100, 1 / 60); // pull DOWN past the top edge
    expect(jiv.ScrollY).toBeLessThan(0);          // it moved past the edge
    expect(jiv.ScrollY).toBeGreaterThan(-100);    // but the curve resisted
  });

  it('released from a stretch, it returns exactly home and stops', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    drag(m, jiv, -30, 4);
    const took = settle(m);
    expect(jiv.ScrollY).toBe(0);                  // home, not near-home
    expect(took).toBeLessThan(2);                 // one soft beat, not a wobble
  });

  it('a fling into the far wall bounces past and comes back to rest AT the wall', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    const maxY = 2000 - 600;
    // Park just shy of the end with a hot velocity, then let physics run.
    m.ScrollTo(jiv, null, maxY - 50, 'instant');
    m.Tick(1 / 120);
    // A fast downward drag: 12.5px per 8ms frame ≈ 1560 px/s.
    drag(m, jiv, 12.5, 4);
    let overshot = false;
    const dt = 1 / 120;
    for (let t = 0; t < 10; t += dt) {
      if (!m.Tick(dt)) break;
      if (jiv.ScrollY > maxY) overshot = true;
    }
    expect(overshot).toBe(true);                  // the bounce happened
    expect(jiv.ScrollY).toBe(maxY);               // and landed on the wall
  });
});

describe('the coast: a flick carries like UIScrollView, not a dead-stop', () => {
  it('a 1500px/s flick coasts well past a second', () => {
    const jiv = makeJiv({ ContentHeight: 100000 });
    const m = makeManager(jiv);
    drag(m, jiv, 12.5, 4); // ≈1560 px/s toward the (distant) end
    const took = settle(m);
    expect(took).toBeGreaterThan(1);              // the old tune died at ~0.6s
    expect(took).toBeLessThan(6);                 // but it does end
  });
});

describe('ScrollTo and ScrollRectIntoView: the public primitives', () => {
  it('instant lands this frame; smooth only moves the target', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.ScrollTo(jiv, null, 500, 'instant');
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(500);
    m.ScrollTo(jiv, null, 900, 'smooth');
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBeGreaterThan(500);     // easing toward…
    expect(jiv.ScrollY).toBeLessThan(900);        // …not teleported
    settle(m);
    expect(jiv.ScrollY).toBe(900);
  });

  it('IntoView scrolls the MINIMUM distance, and not at all when visible', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.ScrollRectIntoView(jiv, { x: 0, y: 300, width: 100, height: 40 }, 8, 'instant');
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(0);                  // already visible: no-op
    m.ScrollRectIntoView(jiv, { x: 0, y: 900, width: 100, height: 40 }, 8, 'instant');
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(900 + 40 + 8 - 600); // bottom edge + margin, no more
  });
});
