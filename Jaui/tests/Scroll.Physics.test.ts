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
    X: 0, Y: 0, ClipsChildren: true, PointerEvents: 'Auto',
    RenderStyle: { Transform: { Rotation: 0, OriginX: 0.5, OriginY: 0.5 }, Layer: 0 },
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

/** A drag gesture with honest timing: samples carry the EVENT time the finger
 *  was at each position, which is what the release window measures. The fake
 *  clock is advanced alongside so the two agree. */
const drag = (m: ScrollManager, jiv: Jiv, dyPerFrame: number, frames: number): void => {
  m.DragStart(jiv);
  let t = performance.now();
  for (let i = 0; i < frames; i++) {
    vi.advanceTimersByTime(8);
    t += 8;
    m.DragMove(jiv, 0, dyPerFrame, t);
  }
  m.DragEnd(jiv, t);
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
    m.DragMove(jiv, 0, -100, performance.now()); // pull DOWN past the top edge
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
    m.ScrollTo(jiv, null, maxY - 50, 'Instant');
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
    m.ScrollTo(jiv, null, 500, 'Instant');
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(500);
    m.ScrollTo(jiv, null, 900, 'Smooth');
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBeGreaterThan(500);     // easing toward…
    expect(jiv.ScrollY).toBeLessThan(900);        // …not teleported
    settle(m);
    expect(jiv.ScrollY).toBe(900);
  });

  it('IntoView scrolls the MINIMUM distance, and not at all when visible', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.ScrollRectIntoView(jiv, { x: 0, y: 300, width: 100, height: 40 }, 8, 'Instant');
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(0);                  // already visible: no-op
    m.ScrollRectIntoView(jiv, { x: 0, y: 900, width: 100, height: 40 }, 8, 'Instant');
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(900 + 40 + 8 - 600); // bottom edge + margin, no more
  });
});

describe('no overflow, no scroll — the drill-sentence bug', () => {
  it('a container whose content fits is not a scroll target', () => {
    const jiv = makeJiv({ ContentHeight: 600, ContentWidth: 400 }); // == viewport
    const m = makeManager(jiv);
    expect(m.ResolveScrollTarget(200, 300)).toBeNull();
  });

  it('dragging a non-overflowing container moves nothing — no rubber-band', () => {
    const jiv = makeJiv({ ContentHeight: 600, ContentWidth: 400 });
    const m = makeManager(jiv);
    m.DragStart(jiv);
    m.DragMove(jiv, 0, -80, performance.now()); // pull hard; there is nowhere to go
    expect(jiv.ScrollY).toBe(0);
  });

  it('an axis with no room stays put while the other scrolls', () => {
    const jiv = makeJiv({ ContentHeight: 2000, ContentWidth: 400 }); // Y scrolls, X does not
    const m = makeManager(jiv);
    m.DragStart(jiv);
    m.DragMove(jiv, -50, 50, performance.now()); // pull content up = scroll down
    expect(jiv.ScrollX).toBe(0);            // X pinned (no room)
    expect(jiv.ScrollY).toBeGreaterThan(0); // Y moved
  });
});

describe('OverscrollMode: Pin holds the content at the line, tracks the overshoot', () => {
  it('a drag past the top never moves ScrollY, but @OverscrollTop grows with the same resistance', () => {
    const jiv = makeJiv({ OverscrollTop: 'Pin' });
    const m = makeManager(jiv);
    m.DragStart(jiv);
    vi.advanceTimersByTime(8);
    m.DragMove(jiv, 0, -100, performance.now());
    expect(jiv.ScrollY).toBe(0); // content held at the line
    const over = Number(jiv.VarMap.get('OverscrollTop'));
    expect(over).toBeGreaterThan(0);   // but the overshoot is tracked...
    expect(over).toBeLessThan(100);    // ...through the same resistance curve as Bounce
  });

  it('released, the tracked overshoot springs back to 0 (the same release spring as Bounce)', () => {
    const jiv = makeJiv({ OverscrollTop: 'Pin' });
    const m = makeManager(jiv);
    drag(m, jiv, -30, 4);
    expect(Number(jiv.VarMap.get('OverscrollTop'))).toBeGreaterThan(0);
    const took = settle(m);
    expect(Number(jiv.VarMap.get('OverscrollTop'))).toBe(0);
    expect(jiv.ScrollY).toBe(0);
    expect(took).toBeLessThan(2); // one soft beat, exactly like Bounce's release
  });

  it('Pin on Bottom only: dragging past the TOP still bounces (each edge is independent)', () => {
    const jiv = makeJiv({ OverscrollBottom: 'Pin' }); // Top left at its Bounce default
    const m = makeManager(jiv);
    m.DragStart(jiv);
    vi.advanceTimersByTime(8);
    m.DragMove(jiv, 0, -100, performance.now());
    expect(jiv.ScrollY).toBeLessThan(0); // Top is still Bounce — content itself moves
  });
});

describe('OverscrollMode: None hard-stops, nothing tracked or published', () => {
  it('a drag past the top moves nothing, and @OverscrollTop stays 0', () => {
    const jiv = makeJiv({ OverscrollTop: 'None' });
    const m = makeManager(jiv);
    m.DragStart(jiv);
    vi.advanceTimersByTime(8);
    m.DragMove(jiv, 0, -100, performance.now());
    expect(jiv.ScrollY).toBe(0);
    expect(Number(jiv.VarMap.get('OverscrollTop') ?? 0)).toBe(0);
  });

  it('a fling into a None wall stops dead, no bounce beat past it', () => {
    const jiv = makeJiv({ OverscrollBottom: 'None', ContentHeight: 700 }); // maxY = 100
    const m = makeManager(jiv);
    const maxY = 700 - 600;
    m.ScrollTo(jiv, null, maxY - 20, 'Instant');
    m.Tick(1 / 120);
    drag(m, jiv, 12.5, 4); // fast fling toward the bottom wall
    let overshot = false;
    const dt = 1 / 120;
    for (let t = 0; t < 10; t += dt) {
      if (!m.Tick(dt)) break;
      if (jiv.ScrollY > maxY) overshot = true;
    }
    expect(overshot).toBe(false);
    expect(jiv.ScrollY).toBe(maxY);
  });
});

describe('OverscrollResistance: a configured number scales the same curve', () => {
  it('a softer (larger) resistance stretches further for the identical drag', () => {
    const auto = makeJiv();
    const soft = makeJiv({ OverscrollResistance: '4' });
    const mAuto = makeManager(auto);
    const mSoft = makeManager(soft);
    for (const [m, jiv] of [[mAuto, auto], [mSoft, soft]] as const) {
      m.DragStart(jiv);
      vi.advanceTimersByTime(8);
      m.DragMove(jiv, 0, -100, performance.now());
    }
    expect(soft.ScrollY).toBeLessThan(auto.ScrollY); // more negative = stretched further
  });
});

describe('OverscrollInput: gates which input kinds may overscroll (wheel/trackpad)', () => {
  it('ApplyDeltaInstant hard-clamps by default (allowOverscroll defaults false)', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.ApplyDeltaInstant(jiv, 0, -50);
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(0);
  });

  it('ApplyDeltaInstant rubber-bands (and gets the release spring) when allowed', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.ApplyDeltaInstant(jiv, 0, -50, true);
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBeLessThan(0);
    expect(jiv.ScrollY).toBeGreaterThan(-50);
    const took = settle(m);
    expect(jiv.ScrollY).toBe(0); // springs home exactly like a touch release
    expect(took).toBeLessThan(2);
  });

  it("ApplyDelta only overscrolls a line-stepped wheel under OverscrollInput: 'All'", () => {
    const jiv = makeJiv({ OverscrollInput: 'Precise' });
    const m = makeManager(jiv);
    m.ApplyDelta(jiv, 0, -50);
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(0); // Precise never lets ApplyDelta's own (line-wheel) path overscroll

    const jivAll = makeJiv({ OverscrollInput: 'All' });
    const mAll = makeManager(jivAll);
    mAll.ApplyDelta(jivAll, 0, -50);
    mAll.Tick(1 / 120);
    expect(jivAll.ScrollY).toBeLessThan(0);
    expect(jivAll.ScrollY).toBeGreaterThan(-50);
  });
});

describe('ScrollProgress: the fraction along whichever axis actually scrolls', () => {
  it('tracks the vertical fraction for a vertically-scrolling container', () => {
    const jiv = makeJiv(); // maxY = 2000 - 600 = 1400
    const m = makeManager(jiv);
    m.ScrollTo(jiv, null, 700, 'Instant'); // halfway
    m.Tick(1 / 120);
    expect(Number(jiv.VarMap.get('ScrollProgress'))).toBeCloseTo(0.5, 2);
  });

  it('is 0 at the top and 1 at the bottom', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.Tick(1 / 120);
    expect(Number(jiv.VarMap.get('ScrollProgress'))).toBe(0);
    m.ScrollTo(jiv, null, 1400, 'Instant');
    m.Tick(1 / 120);
    expect(Number(jiv.VarMap.get('ScrollProgress'))).toBe(1);
  });
});
