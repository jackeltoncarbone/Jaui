import { describe, it, expect } from 'vitest';
import {
  TickPace, ParseTickPace, TickPaceText, PACE_STALL_TICKS,
  type PaceGate, type PaceDecision, type TickPaceMode,
} from '../src/Core/Tick.Pace';

/**
 * `?tick-pace` — render at most once per presented frame.
 *
 * The flag exists to remove the SECOND render: the harness's `ticks` column says the engine renders
 * ~2.04 times per presented frame at baseline and 1.00 under `?blur-dummy`, and the Metal trace
 * agrees from the other side (full-canvas surface rewritten every 34.4 ms, frames presented every
 * 68.4 ms). Three things have to be true for a reading under it to mean anything, and all three are
 * pinned here — none of them needs a GPU, because none of them is about one:
 *
 *   1. IT LOSES NO RENDER. A skipped tick defers a render, it does not drop one. `Loop` below is
 *      the tick loop's own bookkeeping, and it asserts that the loop never parks holding an owed
 *      render and that every request is eventually drawn.
 *   2. THE STALL GUARD CANNOT SILENTLY BECOME THE MECHANISM. A fence that never signals must render
 *      anyway, on a bounded schedule, and must COUNT those renders separately — a cell whose forced
 *      column is non-zero is measuring the guard, not the flag.
 *   3. THE ARITHMETIC IS THE PREDICTION. With a 37 ms render and a 16.67 ms tick, fence pacing
 *      renders every third tick (~50 ms, three vsyncs) and never has two renders in flight. That is
 *      the number the ledger predicts the M4 will read, derived here rather than asserted there.
 */

// ── A fence stand-in: a GPU that takes `cost` ms and a clock the test drives. ──

class FakeGpu implements PaceGate {
  /** ms the GPU needs to finish a frame. */
  Cost: number;
  /** Now, in ms. The test moves it. */
  Now = 0;
  /** When the in-flight render completes, or null when the GPU is idle. */
  private _busyUntil: number | null = null;
  /** Every (start, end) pair, so "two renders in flight" is checkable and not assumed. */
  readonly Frames: Array<{ Start: number; End: number }> = [];

  constructor(cost: number) { this.Cost = cost; }

  /** `WebGL2Renderer.PaceReady`'s contract: never blocks, true when the previous frame is done. */
  PaceReady = (): boolean => {
    if (this._busyUntil === null) return true;
    if (this.Now >= this._busyUntil) { this._busyUntil = null; return true; }
    return false;
  };

  /** What `EndFrame` does: place a fence after the frame's last draw. */
  Render = (): void => {
    if (this._busyUntil !== null && this.Now < this._busyUntil) {
      throw new Error(`two renders in flight: started ${this.Now}, previous ends ${this._busyUntil}`);
    }
    this.Frames.push({ Start: this.Now, End: this.Now + this.Cost });
    this._busyUntil = this.Now + this.Cost;
  };
}

/** A fence that never signals — a driver that lost the sync, or a flush that never happened. */
const NEVER: PaceGate = { PaceReady: () => false };
/** A fence that is always signalled — a render cheaper than a tick. */
const ALWAYS: PaceGate = { PaceReady: () => true };

// ── `Jaui._tickInner`'s pace bookkeeping, and nothing else of the tick. ──

interface LoopTick {
  /** Did the render-on-demand gate fire on this tick (layout dirty / animating / RequestFrame)? */
  Active: boolean;
}

interface LoopResult {
  Decisions: PaceDecision[];
  /** Ticks on which `_render` ran. */
  RenderedAt: number[];
  /** Ticks on which the park predicate would have returned true. */
  ParkedAt: number[];
}

/**
 * The exact shape of the loop this flag edits: `_renderHold` is set to 3 by the render-on-demand
 * gate and decremented ONLY on a tick that actually rendered; `_paceOwed` carries a refused render
 * forward; the park predicate refuses both. Copied here as the smallest thing that can be asserted
 * about — not a second implementation of the pacing, which is `TickPace` itself and is the object
 * under test.
 */
const Loop = (
  pace: TickPace,
  gate: PaceGate | null,
  ticks: LoopTick[],
  hooks?: { OnTick?: (i: number) => void; OnRender?: (i: number) => void },
): LoopResult => {
  let hold = 0;
  let owed = false;
  const out: LoopResult = { Decisions: [], RenderedAt: [], ParkedAt: [] };
  for (let i = 0; i < ticks.length; i++) {
    hooks?.OnTick?.(i);
    if (ticks[i].Active) hold = 3;
    const wants = hold > 0 || owed;
    const decision = wants ? pace.Decide(gate) : 'skip';
    const render = wants && decision !== 'skip';
    if (wants) {
      out.Decisions.push(decision);
      owed = !render;
    }
    if (render) {
      hold--;
      out.RenderedAt.push(i);
      hooks?.OnRender?.(i);
    }
    if (!owed && hold === 0) out.ParkedAt.push(i);
  }
  return out;
};

const Active = (n: number, at: number[]): LoopTick[] =>
  Array.from({ length: n }, (_, i) => ({ Active: at.includes(i) }));

// ── Parsing ──

describe('?tick-pace — the parse', () => {
  it('bare flag and =fence both mean the fence gate', () => {
    expect(ParseTickPace(null)).toEqual({ Mode: { Kind: 'fence' } });
    expect(ParseTickPace('')).toEqual({ Mode: { Kind: 'fence' } });
    expect(ParseTickPace('  ')).toEqual({ Mode: { Kind: 'fence' } });
    expect(ParseTickPace('fence')).toEqual({ Mode: { Kind: 'fence' } });
  });

  it('=N (N >= 2) is the ratio control', () => {
    expect(ParseTickPace('2')).toEqual({ Mode: { Kind: 'ratio', N: 2 } });
    expect(ParseTickPace('3')).toEqual({ Mode: { Kind: 'ratio', N: 3 } });
  });

  it('refuses with a reason rather than quietly running the baseline under the flag name', () => {
    // Every one of these would otherwise publish an unpaced number in a cell labelled ?tick-pace.
    for (const bad of ['1', '0', '-2', '1.5', 'x', 'true']) {
      const r = ParseTickPace(bad);
      expect(r, `"${bad}" must be refused`).toHaveProperty('Why');
    }
    // N=1 is refused for its own reason: it is not malformed, it is the unflagged engine.
    expect(ParseTickPace('1')).toEqual({ Why: 'n-1-renders-every-tick-which-is-the-unflagged-engine' });
  });

  it('names the mode the same way everywhere the reading is printed', () => {
    expect(TickPaceText(null)).toBe('off');
    expect(TickPaceText({ Kind: 'fence' })).toBe('fence');
    expect(TickPaceText({ Kind: 'ratio', N: 2 })).toBe('ratio:2');
  });
});

// ── The unflagged engine ──

describe('?tick-pace absent — the loop is the loop it was', () => {
  it('every tick that wants to render, renders; nothing is ever skipped or owed', () => {
    const pace = new TickPace(null);
    const r = Loop(pace, null, Active(30, [0, 7, 19]));
    expect(r.Decisions.every(d => d === 'render')).toBe(true);
    expect(pace.Skipped).toBe(0);
    expect(pace.Forced).toBe(0);
    // Three requests, each with its own three-frame settle tail, and no tail overlaps another.
    expect(r.RenderedAt).toEqual([0, 1, 2, 7, 8, 9, 19, 20, 21]);
    expect(pace.Rendered).toBe(9);
  });

  it('counts RENDERED on the unflagged arm too, so the ratio reads on both sides of a comparison', () => {
    const pace = new TickPace(null);
    Loop(pace, null, Active(10, [0]));
    expect(pace.Census()).toEqual({ Mode: 'off', Rendered: 3, Skipped: 0, Forced: 0 });
  });
});

// ── The ratio control ──

describe('?tick-pace=N — the crude control', () => {
  it('renders every Nth tick that WANTS to render, not every Nth tick', () => {
    // Ticks 0..2 want (the settle tail); 3..9 do not; 10..12 want again. Under =2 the wants
    // alternate ACROSS the idle gap — counting ticks instead of wants would resync at the gap and
    // the control would not be the control it claims to be.
    const pace = new TickPace({ Kind: 'ratio', N: 2 });
    const r = Loop(pace, null, Active(40, [0, 10]));
    expect(r.Decisions.slice(0, 6)).toEqual(['render', 'skip', 'render', 'skip', 'render', 'skip']);
  });

  it('skips exactly half at N=2 and two thirds at N=3', () => {
    for (const [n, share] of [[2, 1 / 2], [3, 2 / 3]] as const) {
      const pace = new TickPace({ Kind: 'ratio', N: n });
      // A permanently-animating scene: every tick wants to render.
      Loop(pace, null, Active(60, Array.from({ length: 60 }, (_, i) => i)));
      const wants = pace.Rendered + pace.Skipped;
      expect(Math.abs(pace.Skipped / wants - share)).toBeLessThan(0.02);
      expect(pace.Forced).toBe(0);
    }
  });

  it('never polls a fence — the control needs no GL and must run on any backend', () => {
    const pace = new TickPace({ Kind: 'ratio', N: 2 });
    let polls = 0;
    const counted: PaceGate = { PaceReady: () => { polls++; return true; } };
    Loop(pace, counted, Active(20, [0, 5, 10]));
    expect(polls).toBe(0);
  });
});

// ── The fence gate ──

describe('?tick-pace — the fence gate', () => {
  it('renders freely when the GPU keeps up', () => {
    const pace = new TickPace({ Kind: 'fence' });
    const r = Loop(pace, ALWAYS, Active(20, [0, 9]));
    expect(pace.Skipped).toBe(0);
    expect(r.RenderedAt).toEqual([0, 1, 2, 9, 10, 11]);
  });

  it('skips while the previous frame is still on the GPU, and renders the tick it lands', () => {
    const pace = new TickPace({ Kind: 'fence' });
    // Signal on the 4th poll.
    let polls = 0;
    const gate: PaceGate = { PaceReady: () => ++polls % 4 === 0 };
    const r = Loop(pace, gate, Active(12, [0]));
    expect(r.Decisions.slice(0, 8)).toEqual([
      'skip', 'skip', 'skip', 'render',
      'skip', 'skip', 'skip', 'render',
    ]);
  });

  it('a skip run resets on a render, so the stall guard measures CONSECUTIVE skips', () => {
    const pace = new TickPace({ Kind: 'fence' });
    // Two skips, a render, then never again: the guard must not trip early on the pooled count.
    let i = 0;
    const gate: PaceGate = { PaceReady: () => { i++; return i === 3; } };
    const r = Loop(pace, gate, Active(4 + PACE_STALL_TICKS, [0]));
    expect(r.Decisions[2]).toBe('render');
    // The first PACE_STALL_TICKS skips after that render are still skips, not forces.
    expect(r.Decisions.slice(3, 3 + PACE_STALL_TICKS).every(d => d === 'skip')).toBe(true);
  });
});

// ── The stall guard ──

describe('?tick-pace — the stall guard', () => {
  it('a fence that never signals still renders, on a bounded schedule, and says it is forced', () => {
    const pace = new TickPace({ Kind: 'fence' });
    const ticks = 4 * (PACE_STALL_TICKS + 1);
    const r = Loop(pace, NEVER, Active(ticks, Array.from({ length: ticks }, (_, i) => i)));
    // Exactly one forced render per PACE_STALL_TICKS skips — the loop can never freeze on a frame.
    expect(pace.Forced).toBe(4);
    expect(pace.Rendered).toBe(4);
    expect(pace.Skipped).toBe(ticks - 4);
    expect(r.Decisions.slice(0, PACE_STALL_TICKS + 1)).toEqual([
      ...Array<PaceDecision>(PACE_STALL_TICKS).fill('skip'), 'forced',
    ]);
  });

  it('a forced render is counted apart from a real one, so a void cell is visible in the report', () => {
    const pace = new TickPace({ Kind: 'fence' });
    Loop(pace, NEVER, Active(PACE_STALL_TICKS + 1, [0]));
    const c = pace.Census();
    expect(c.Forced).toBe(1);
    // Forced renders are Rendered too — the column is a subset, not a fourth outcome, so
    // Rendered stays "ticks on which _render ran" and the ratio arithmetic is unchanged.
    expect(c.Rendered).toBe(1);
    expect(c.Mode).toBe('fence');
  });

  it('trips at least an order of magnitude past any frame either machine produces', () => {
    // 8 ticks is ~133 ms at 60 Hz and ~265 ms at the 30 Hz cadence this flag exists to fix; the
    // slowest frame in the ledger is 73 ms. A guard inside that range would become the mechanism.
    expect(PACE_STALL_TICKS * 16.67).toBeGreaterThan(73 * 1.5);
  });
});

// ── It loses no render ──

describe('?tick-pace — a skipped tick defers a render, it does not drop one', () => {
  const MODES: Array<TickPaceMode | null> = [null, { Kind: 'fence' }, { Kind: 'ratio', N: 2 }, { Kind: 'ratio', N: 5 }];

  it('delivers each request its full three-render tail whatever the gate does', () => {
    for (const mode of MODES) {
      const pace = new TickPace(mode);
      let i = 0;
      // A hostile fence: ready only every fifth poll. Four requests, spaced far enough apart that
      // no tail can run into the next one however much the gate delays it (worst case 5 ticks per
      // render under this gate, 5 under ratio:5 — 15 ticks against a 20-tick spacing).
      const gate: PaceGate = { PaceReady: () => ++i % 5 === 0 };
      const r = Loop(pace, gate, Active(120, [0, 20, 40, 60]));
      // Four requests x a three-frame settle tail, all delivered, in EVERY mode. A pace that lost
      // a render rather than deferring it would land under twelve here, and that is the whole
      // pixel claim: the draw is postponed, never dropped.
      expect(pace.Rendered, TickPaceText(mode)).toBe(12);
      // And the loop is quiet at the end rather than stuck owing one.
      expect(r.ParkedAt.at(-1), TickPaceText(mode)).toBe(119);
    }
  });

  it('every want is accounted for exactly once', () => {
    for (const mode of MODES) {
      const pace = new TickPace(mode);
      let i = 0;
      const gate: PaceGate = { PaceReady: () => ++i % 3 !== 0 };
      const r = Loop(pace, gate, Active(120, [0, 11, 12, 50, 99]));
      expect(pace.Rendered + pace.Skipped, TickPaceText(mode)).toBe(r.Decisions.length);
      expect(pace.Forced, TickPaceText(mode)).toBeLessThanOrEqual(pace.Rendered);
    }
  });

  it('a tick that does not want to render is not a skip — the columns count wants, not ticks', () => {
    const pace = new TickPace({ Kind: 'fence' });
    // Eighty ticks, one request. The engine is parked-equivalent for seventy-odd of them.
    Loop(pace, ALWAYS, Active(80, [0]));
    expect(pace.Rendered).toBe(3);
    expect(pace.Skipped).toBe(0);
  });
});

// ── The prediction, as arithmetic ──

describe('?tick-pace — what the M4 should read', () => {
  const TICK = 1000 / 60;
  const AllActive = (n: number): LoopTick[] => Active(n, Array.from({ length: n }, (_, i) => i));

  /** Drive the gate and the GPU off one clock: tick i happens at i*TICK, and a render placed on
   *  tick i occupies the GPU for `cost` ms from that instant. */
  const Drive = (cost: number, ticks: number): { Pace: TickPace; Gpu: FakeGpu; Result: LoopResult } => {
    const gpu = new FakeGpu(cost);
    const pace = new TickPace({ Kind: 'fence' });
    const result = Loop(pace, gpu, AllActive(ticks), {
      OnTick: i => { gpu.Now = i * TICK; },
      OnRender: () => gpu.Render(),
    });
    return { Pace: pace, Gpu: gpu, Result: result };
  };

  it('a 37 ms render on a 16.67 ms tick settles at one render every three ticks (~50 ms)', () => {
    const { Pace, Gpu, Result } = Drive(37, 60);
    // `FakeGpu.Render` throws if a render starts while one is in flight, so reaching here at all is
    // the claim the flag is named for: never two renders per presented frame.
    expect(Gpu.Frames.length).toBe(Result.RenderedAt.length);
    for (let i = 1; i < Gpu.Frames.length; i++) {
      expect(Gpu.Frames[i].Start).toBeGreaterThanOrEqual(Gpu.Frames[i - 1].End);
    }
    const gaps = Result.RenderedAt.slice(1).map((v, i) => v - Result.RenderedAt[i]);
    expect(new Set(gaps)).toEqual(new Set([3]));
    // Three vsyncs: 50.0 ms, against the 67.5 ms the unpaced arm reads on the same render.
    expect(Math.round(gaps[0] * TICK * 10) / 10).toBe(50);
    // ~20 renders a second, against ~15 presented frames a second unpaced — and each of those 15
    // costs two renders, so the GPU does 30 frames of work for 15 and this does 20 for 20.
    expect(Math.round(Result.RenderedAt.length / (60 * TICK / 1000))).toBe(20);
    expect(Pace.Skipped).toBe(40);
    expect(Pace.Forced).toBe(0);
  });

  it('a 13 ms render (the no-panels shape) is never paced at all', () => {
    const { Pace } = Drive(13, 60);
    // A render that fits one vsync is always finished by the next tick, so the flag costs it
    // nothing. Same reason the phone reads unchanged: its engine tick is 111-127 ms against 135
    // page frames a window, so it has FEWER ticks than frames and never renders twice into one.
    expect(Pace.Skipped).toBe(0);
    expect(Pace.Rendered).toBe(60);
  });

  it('a 33 ms render (the blur-dummy shape) is already one render per presented frame', () => {
    const { Pace, Result } = Drive(33, 60);
    // blur-dummy reads ticks/presented 1.00 unflagged, so pacing must find almost nothing to skip:
    // a 33 ms render is done by the third tick, which is when the unpaced arm renders anyway.
    const gaps = Result.RenderedAt.slice(1).map((v, i) => v - Result.RenderedAt[i]);
    expect(new Set(gaps)).toEqual(new Set([2]));
    expect(Pace.Forced).toBe(0);
  });
});
