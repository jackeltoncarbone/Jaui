import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ScrollDelta, ScrollManager } from '../src/Scroll/Scroll.Manager';
import type { Jiv } from '../src/Jiv/Jiv';

// Drill Sentences lane P1, finding 2: a single synthetic wheel of -10000 over the drill editor's phrase list (what a fast
// trackpad fling can deliver) corrupted the scene. Whatever the delta -- huge either way, NaN, an infinity -- the list
// scrolls to its edge (stretching at most one viewport past it where the edge rubber-bands), every number the scroller
// publishes stays finite, and the call returns at once.

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

const settle = (m: ScrollManager, maxSec = 10): void => {
  for (let t = 0; t < maxSec; t += 1 / 120) if (!m.Tick(1 / 120)) return;
};

const vars = (jiv: Jiv): Map<string, string | number | boolean> => (jiv as unknown as { VarMap: Map<string, string | number | boolean> }).VarMap;
const allFinite = (jiv: Jiv): boolean => {
  if (!Number.isFinite(jiv.ScrollX) || !Number.isFinite(jiv.ScrollY)) return false;
  for (const v of vars(jiv).values()) if (typeof v === 'number' && !Number.isFinite(v)) return false;
  return true;
};

const MAX_Y = 2000 - 600;

beforeEach(() => { vi.useFakeTimers({ toFake: ['performance'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('ScrollDelta', () => {
  it('passes finite deltas through, drops NaN, and turns an infinity into the farthest finite pull', () => {
    expect(ScrollDelta(-10000)).toBe(-10000);
    expect(ScrollDelta(0.25)).toBe(0.25);
    expect(ScrollDelta(NaN)).toBe(0);
    expect(ScrollDelta(Infinity)).toBe(Number.MAX_SAFE_INTEGER);
    expect(ScrollDelta(-Infinity)).toBe(-Number.MAX_SAFE_INTEGER);
  });
});

describe('a mouse wheel (the eased, hard-clamped path) of any size scrolls to the edge', () => {
  for (const [name, dy, end] of [
    ['-10000 from the middle', -10000, 0],
    ['+10000 from the middle', 10000, MAX_Y],
    ['-Infinity', -Infinity, 0],
    ['+Infinity', Infinity, MAX_Y],
    ['1e300', 1e300, MAX_Y],
  ] as const) {
    it(name, () => {
      const jiv = makeJiv();
      const m = makeManager(jiv);
      m.ApplyDeltaInstant(jiv, 0, 700);
      m.Tick(1 / 120);
      m.ApplyDelta(jiv, 0, dy);
      settle(m);
      expect(jiv.ScrollY).toBe(end);
      expect(allFinite(jiv)).toBe(true);
    });
  }

  it('NaN moves nothing', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.ApplyDeltaInstant(jiv, 0, 700);
    m.Tick(1 / 120);
    m.ApplyDelta(jiv, NaN, NaN);
    settle(m);
    expect(jiv.ScrollY).toBe(700);
    expect(jiv.ScrollX).toBe(0);
    expect(allFinite(jiv)).toBe(true);
  });
});

describe('a trackpad fling (the instant, rubber-banding path) stretches at most one viewport past the edge', () => {
  for (const [name, dy, edge] of [
    ['-10000 at the top', -10000, 0],
    ['+10000 at the bottom', 10000, MAX_Y],
    ['-Infinity', -Infinity, 0],
    ['+Infinity', Infinity, MAX_Y],
  ] as const) {
    it(name, () => {
      const jiv = makeJiv();
      const m = makeManager(jiv);
      const t0 = Date.now();
      m.ApplyDeltaInstant(jiv, 0, dy, true);
      // Returns at once: an infinite pull used to spin `_integrateRubber`'s four-pixel loop forever.
      expect(Date.now() - t0).toBeLessThan(250);
      m.Tick(1 / 120);
      const over = dy < 0 ? -jiv.ScrollY : jiv.ScrollY - MAX_Y;
      expect(over).toBeGreaterThan(0);
      // The same stretch a one-viewport finger pull past the edge shows, never the thousands a 10000 px pull used to.
      expect(over).toBeLessThan(600);
      expect(allFinite(jiv)).toBe(true);
      settle(m);
      expect(jiv.ScrollY).toBe(edge);
      expect(allFinite(jiv)).toBe(true);
    });
  }

  it('NaN moves nothing and poisons nothing', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.ApplyDeltaInstant(jiv, 0, 300);
    m.ApplyDeltaInstant(jiv, NaN, NaN, true);
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(300);
    expect(allFinite(jiv)).toBe(true);
  });

  it('a list a million pixels long still takes a whole-length fling in one call, landing exactly', () => {
    const jiv = makeJiv({ ContentHeight: 1_000_600 });
    const m = makeManager(jiv);
    m.ApplyDeltaInstant(jiv, 0, 999_000, true);
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(999_000);
  });

  it('an ordinary drag past the edge stretches exactly as before (the cap never touches it)', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.DragStart(jiv);
    m.DragMove(jiv, 0, -100, performance.now());
    // 1/(1+over/1400), integrated in four-pixel steps: 100 px of finger shows a little under 100 px of stretch.
    expect(-jiv.ScrollY).toBeGreaterThan(90);
    expect(-jiv.ScrollY).toBeLessThan(100);
  });
});

describe('a scroller poisoned upstream heals on the next tick', () => {
  it('a NaN programmatic target never reaches ScrollY', () => {
    const jiv = makeJiv();
    const m = makeManager(jiv);
    m.ScrollTo(jiv, null, NaN, 'Smooth');
    settle(m);
    expect(jiv.ScrollY).toBe(0);
    expect(allFinite(jiv)).toBe(true);
    m.ScrollTo(jiv, null, Infinity, 'Instant');
    m.Tick(1 / 120);
    expect(jiv.ScrollY).toBe(MAX_Y);
  });
});
