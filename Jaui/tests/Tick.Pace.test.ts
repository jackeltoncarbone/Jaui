import { describe, it, expect } from 'vitest';
import {
  TickPace, ParseTickPace, TickPaceText, PACE_STALL_TICKS, PACE_DEFAULT_DEPTH, PACE_MAX_DEPTH,
  PACE_FENCE_RING,
  type PaceGate, type PaceDecision, type TickPaceMode,
} from '../src/Core/Tick.Pace';

/**
 * `?tick-pace` — pace the render on the GPU instead of on the tick.
 *
 * The first cut of this flag removed the second render and measured 50.13 ms at dpr 2 where the
 * fixed-ratio control measured 33.48. The gap was not the poll and not the fence: the gate allowed
 * ZERO frames in flight, so the CPU's issuing and the GPU's execution stopped overlapping and the
 * frame cost their SUM (~17 + ~33) instead of their MAX. This lane makes the gate a DEPTH, defaults
 * it to one frame in flight, and adds the two ledger fields that say which of those two stories a
 * cell is telling.
 *
 * Four things have to be true for a reading under it to mean anything, and all four are pinned here
 * — none of them needs a GPU, because none of them is about one:
 *
 *   1. IT LOSES NO RENDER. A skipped tick defers a render, it does not drop one. `Loop` below is
 *      the tick loop's own bookkeeping, and it asserts that the loop never parks holding an owed
 *      render and that every request is eventually drawn, in every mode and at every depth.
 *   2. THE STALL GUARD CANNOT SILENTLY BECOME THE MECHANISM. A fence that never signals must render
 *      anyway, on a bounded schedule, and must COUNT those renders separately — a cell whose forced
 *      column is non-zero is measuring the guard, not the flag.
 *   3. THE DEPTH IS THE FIX, AS ARITHMETIC. `Pipeline` below is a CPU and a GPU on one clock. At
 *      depth 0 it settles at 50 ms on the M4's shape and at depth 1 it settles at 33.3 — the two
 *      numbers the M4 actually measured for the fence arm and the ratio arm, derived here rather
 *      than asserted there.
 *   4. DEPTH 1 IS NOT THE CLAMP. On a render that fits one vsync, the fence gate renders every tick
 *      and `?tick-pace=2` renders every other one. That is the sentence separating the fix from the
 *      control, and it is the dpr-1.5 prediction.
 */

// ── Fence stand-ins ──

/** A gate holding a fixed number of frames in flight. */
const Busy = (n: number): PaceGate => ({ PaceInFlight: () => n, PaceTakeFenceMs: () => null });
/** A fence that never signals — a driver that lost the sync, or a flush that never happened. */
const NEVER = Busy(PACE_MAX_DEPTH + 1);
/** A GPU that is always idle — a render cheaper than a tick. */
const ALWAYS = Busy(0);

/**
 * A CPU and a GPU on one clock, pipelined the way a real one is: the CPU issues a frame during the
 * tick (`Cpu` ms, after which `EndFrame` arms the fence), the frame is submitted then, and the GPU
 * executes submitted frames SERIALLY and IN ORDER (`Gpu` ms each). `PaceInFlight` retires every
 * frame the GPU has finished by `Now` and reports the rest, exactly as `WebGL2Renderer` does.
 */
class Pipeline implements PaceGate {
  Now = 0;
  readonly Cpu: number;
  readonly Gpu: number;
  /** Frames the GPU has not finished, oldest first. */
  private _queue: Array<{ ArmedAt: number; End: number }> = [];
  /** When the GPU will be free of everything submitted so far. */
  private _gpuFreeAt = 0;
  private _lastFenceMs: number | null = null;
  /** Deepest the queue ever got — the model's own `MaxInFlight`. */
  Peak = 0;
  /** Every frame ever issued: when the CPU started it and when the GPU finished it. */
  readonly Frames: Array<{ Start: number; End: number }> = [];

  constructor(cpu: number, gpu: number) { this.Cpu = cpu; this.Gpu = gpu; }

  PaceInFlight = (): number => {
    while (this._queue.length > 0 && this._queue[0].End <= this.Now) {
      const f = this._queue.shift();
      if (f) this._lastFenceMs = this.Now - f.ArmedAt;
    }
    return this._queue.length;
  };

  PaceTakeFenceMs = (): number | null => {
    const ms = this._lastFenceMs;
    this._lastFenceMs = null;
    return ms;
  };

  /** What a tick that renders does: issue for `Cpu` ms, arm a fence, submit. Returns the clock
   *  reading at which the CPU is free again. */
  Render = (): number => {
    const armedAt = this.Now + this.Cpu;
    const end = Math.max(armedAt, this._gpuFreeAt) + this.Gpu;
    this._gpuFreeAt = end;
    this._queue.push({ ArmedAt: armedAt, End: end });
    if (this._queue.length > this.Peak) this.Peak = this._queue.length;
    this.Frames.push({ Start: this.Now, End: end });
    return armedAt;
  };
}

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

const Fence = (depth: number): TickPaceMode => ({ Kind: 'fence', Depth: depth });

// ── Parsing ──

describe('?tick-pace — the parse', () => {
  it('bare flag and =fence both mean the fence gate at the DEFAULT depth, which is one', () => {
    // The whole lane is in this assertion. Depth 0 is the gate that measured 50 ms by serialising
    // the CPU and the GPU; a bare ?tick-pace must not select it.
    expect(PACE_DEFAULT_DEPTH).toBe(1);
    expect(ParseTickPace(null)).toEqual({ Mode: { Kind: 'fence', Depth: 1 } });
    expect(ParseTickPace('')).toEqual({ Mode: { Kind: 'fence', Depth: 1 } });
    expect(ParseTickPace('  ')).toEqual({ Mode: { Kind: 'fence', Depth: 1 } });
    expect(ParseTickPace('fence')).toEqual({ Mode: { Kind: 'fence', Depth: 1 } });
  });

  it('=fence:D names the depth, so the first cut is reproducible in the same binary', () => {
    for (let d = 0; d <= PACE_MAX_DEPTH; d++) {
      expect(ParseTickPace(`fence:${d}`)).toEqual({ Mode: { Kind: 'fence', Depth: d } });
    }
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

  it('refuses a malformed depth — and `fence:` in particular, which Number() reads as 0', () => {
    // `Number('')` is 0, so without its own guard a trailing colon would silently select the
    // strictly-serial gate: the one arm this lane exists to stop being the default.
    for (const bad of ['fence:', 'fence:x', 'fence:-1', 'fence:1.5', `fence:${PACE_MAX_DEPTH + 1}`]) {
      const r = ParseTickPace(bad);
      expect(r, `"${bad}" must be refused`).toHaveProperty('Why');
    }
  });

  it('names the mode the same way everywhere the reading is printed, depth included', () => {
    // Two cells at two depths are two different instruments and must not share a label.
    expect(TickPaceText(null)).toBe('off');
    expect(TickPaceText(Fence(1))).toBe('fence:1');
    expect(TickPaceText(Fence(0))).toBe('fence:0');
    expect(TickPaceText({ Kind: 'ratio', N: 2 })).toBe('ratio:2');
  });

  it('the renderer keeps more fences than the deepest gate can hold outstanding', () => {
    expect(PACE_FENCE_RING).toBeGreaterThan(PACE_MAX_DEPTH + 1);
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
    expect(pace.Census()).toEqual({
      Mode: 'off', Rendered: 3, Skipped: 0, Forced: 0,
      // Unflagged, every render waited nothing — the histogram's own baseline.
      WaitedTicks: [3, 0, 0, 0],
      FenceMs: { N: 0, Sum: 0, Max: 0 },
      MaxInFlight: 0,
    });
  });
});

// ── The ratio control ──

describe('?tick-pace=N — the crude control, and a clamp', () => {
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
    const counted: PaceGate = { PaceInFlight: () => { polls++; return 0; }, PaceTakeFenceMs: () => null };
    Loop(pace, counted, Active(20, [0, 5, 10]));
    expect(polls).toBe(0);
  });
});

// ── The fence gate is a depth ──

describe('?tick-pace — the fence gate is a DEPTH, not a boolean', () => {
  it('renders freely when the GPU is idle, at any depth', () => {
    for (let d = 0; d <= PACE_MAX_DEPTH; d++) {
      const pace = new TickPace(Fence(d));
      const r = Loop(pace, ALWAYS, Active(20, [0, 9]));
      expect(pace.Skipped, `depth ${d}`).toBe(0);
      expect(r.RenderedAt, `depth ${d}`).toEqual([0, 1, 2, 9, 10, 11]);
    }
  });

  it('depth 0 refuses a render while ONE frame is outstanding — the first cut, reproducible', () => {
    const pace = new TickPace(Fence(0));
    Loop(pace, Busy(1), Active(PACE_STALL_TICKS, [0]));
    expect(pace.Rendered).toBe(0);
    expect(pace.Skipped).toBe(PACE_STALL_TICKS);
  });

  it('depth 1 renders THROUGH one outstanding frame and refuses the third', () => {
    // This is the fix in one assertion: one frame in flight keeps the pipeline, two means the next
    // render would be the one the compositor throws away.
    const through = new TickPace(Fence(1));
    Loop(through, Busy(1), Active(6, [0, 3]));
    expect(through.Skipped).toBe(0);
    expect(through.Rendered).toBe(6);

    const refused = new TickPace(Fence(1));
    Loop(refused, Busy(2), Active(PACE_STALL_TICKS, [0]));
    expect(refused.Rendered).toBe(0);
    expect(refused.Skipped).toBe(PACE_STALL_TICKS);
  });

  it('skips while the GPU is behind and renders on the tick it catches up', () => {
    const pace = new TickPace(Fence(1));
    // Two frames in flight for three polls, then one.
    let polls = 0;
    const gate: PaceGate = { PaceInFlight: () => (++polls % 4 === 0 ? 1 : 2), PaceTakeFenceMs: () => null };
    const r = Loop(pace, gate, Active(12, [0]));
    expect(r.Decisions.slice(0, 8)).toEqual([
      'skip', 'skip', 'skip', 'render',
      'skip', 'skip', 'skip', 'render',
    ]);
  });

  it('a skip run resets on a render, so the stall guard measures CONSECUTIVE skips', () => {
    const pace = new TickPace(Fence(1));
    // Two skips, a render, then never again: the guard must not trip early on the pooled count.
    let i = 0;
    const gate: PaceGate = { PaceInFlight: () => (++i === 3 ? 0 : 2), PaceTakeFenceMs: () => null };
    const r = Loop(pace, gate, Active(4 + PACE_STALL_TICKS, [0]));
    expect(r.Decisions[2]).toBe('render');
    // The first PACE_STALL_TICKS skips after that render are still skips, not forces.
    expect(r.Decisions.slice(3, 3 + PACE_STALL_TICKS).every(d => d === 'skip')).toBe(true);
  });
});

// ── The stall guard ──

describe('?tick-pace — the stall guard', () => {
  it('a fence that never signals still renders, on a bounded schedule, and says it is forced', () => {
    const pace = new TickPace(Fence(1));
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
    const pace = new TickPace(Fence(1));
    Loop(pace, NEVER, Active(PACE_STALL_TICKS + 1, [0]));
    const c = pace.Census();
    expect(c.Forced).toBe(1);
    // Forced renders are Rendered too — the column is a subset, not a fourth outcome, so
    // Rendered stays "ticks on which _render ran" and the ratio arithmetic is unchanged.
    expect(c.Rendered).toBe(1);
    expect(c.Mode).toBe('fence:1');
  });

  it('trips at least an order of magnitude past any frame either machine produces', () => {
    // 8 ticks is ~133 ms at 60 Hz and ~265 ms at the 30 Hz cadence this flag exists to fix; the
    // slowest frame in the ledger is 73 ms. A guard inside that range would become the mechanism.
    expect(PACE_STALL_TICKS * 16.67).toBeGreaterThan(73 * 1.5);
  });
});

// ── It loses no render ──

describe('?tick-pace — a skipped tick defers a render, it does not drop one', () => {
  const MODES: Array<TickPaceMode | null> = [
    null, Fence(0), Fence(1), Fence(2), { Kind: 'ratio', N: 2 }, { Kind: 'ratio', N: 5 },
  ];

  it('delivers each request its full three-render tail whatever the gate does', () => {
    for (const mode of MODES) {
      const pace = new TickPace(mode);
      let i = 0;
      // A hostile fence: idle only every fifth poll, over-depth otherwise. Four requests, spaced
      // far enough apart that no tail can run into the next one however much the gate delays it
      // (worst case 5 ticks per render under this gate, 5 under ratio:5 — 15 ticks against a
      // 20-tick spacing).
      const gate: PaceGate = {
        PaceInFlight: () => (++i % 5 === 0 ? 0 : PACE_MAX_DEPTH + 1),
        PaceTakeFenceMs: () => null,
      };
      const r = Loop(pace, gate, Active(120, [0, 20, 40, 60]));
      // Four requests x a three-frame settle tail, all delivered, in EVERY mode and at every depth.
      // A pace that lost a render rather than deferring it would land under twelve here, and that
      // is the whole pixel claim: the draw is postponed, never dropped.
      expect(pace.Rendered, TickPaceText(mode)).toBe(12);
      // And the loop is quiet at the end rather than stuck owing one.
      expect(r.ParkedAt.at(-1), TickPaceText(mode)).toBe(119);
    }
  });

  it('every want is accounted for exactly once', () => {
    for (const mode of MODES) {
      const pace = new TickPace(mode);
      let i = 0;
      const gate: PaceGate = {
        PaceInFlight: () => (++i % 3 === 0 ? PACE_MAX_DEPTH + 1 : 0),
        PaceTakeFenceMs: () => null,
      };
      const r = Loop(pace, gate, Active(120, [0, 11, 12, 50, 99]));
      expect(pace.Rendered + pace.Skipped, TickPaceText(mode)).toBe(r.Decisions.length);
      expect(pace.Forced, TickPaceText(mode)).toBeLessThanOrEqual(pace.Rendered);
      // The histogram counts renders and only renders.
      const binned = pace.Census().WaitedTicks.reduce((a, b) => a + b, 0);
      expect(binned, TickPaceText(mode)).toBe(pace.Rendered);
    }
  });

  it('a tick that does not want to render is not a skip — the columns count wants, not ticks', () => {
    const pace = new TickPace(Fence(1));
    // Eighty ticks, one request. The engine is parked-equivalent for seventy-odd of them.
    Loop(pace, ALWAYS, Active(80, [0]));
    expect(pace.Rendered).toBe(3);
    expect(pace.Skipped).toBe(0);
  });
});

// ── The ledger this lane added ──

describe('?tick-pace — WaitedTicks, FenceMs and MaxInFlight', () => {
  it('buckets ticks waited per render at 0 / 1 / 2 / 3+, and saturates the last bucket', () => {
    // Ready every third poll: two skips then a render, forever — every render in bucket 2.
    const two = new TickPace(Fence(1));
    let i = 0;
    Loop(two, { PaceInFlight: () => (++i % 3 === 0 ? 0 : 2), PaceTakeFenceMs: () => null },
      Active(30, Array.from({ length: 30 }, (_, k) => k)));
    expect(two.Census().WaitedTicks[2]).toBe(two.Rendered);

    // Ready every fifth poll: four skips per render — all in the 3+ bucket, not a fifth bucket.
    const many = new TickPace(Fence(1));
    let j = 0;
    Loop(many, { PaceInFlight: () => (++j % 5 === 0 ? 0 : 2), PaceTakeFenceMs: () => null },
      Active(40, Array.from({ length: 40 }, (_, k) => k)));
    expect(many.Census().WaitedTicks).toEqual([0, 0, 0, many.Rendered]);
  });

  it('reads on the control arms too, so the histogram is comparable across a comparison', () => {
    // ?tick-pace=2 waits exactly one tick per render BY CONSTRUCTION — which is the point: at dpr
    // 1.5 the fence gate should read bucket 0 on the same scene where =2 still reads bucket 1.
    const ratio = new TickPace({ Kind: 'ratio', N: 2 });
    Loop(ratio, null, Active(40, Array.from({ length: 40 }, (_, i) => i)));
    expect(ratio.Census().WaitedTicks).toEqual([1, ratio.Rendered - 1, 0, 0]);
  });

  it('samples the fence latency the gate hands it, once per retired fence', () => {
    const pace = new TickPace(Fence(1));
    const latencies = [30, 34, 31];
    let k = 0;
    const gate: PaceGate = {
      PaceInFlight: () => 0,
      PaceTakeFenceMs: () => (k < latencies.length ? latencies[k++] : null),
    };
    Loop(pace, gate, Active(10, [0]));
    const c = pace.Census();
    expect(c.FenceMs).toEqual({ N: 3, Sum: 95, Max: 34 });
    // The mean over a window is what a report quotes, and it is subtractable across two censuses.
    expect(c.FenceMs.Sum / c.FenceMs.N).toBeCloseTo(31.67, 1);
  });

  it('MaxInFlight proves the depth was REACHED — a cell at depth 1 that never saw 2 is depth 0', () => {
    const used = new TickPace(Fence(1));
    Loop(used, Busy(2), Active(4, [0]));
    expect(used.Census().MaxInFlight).toBe(2);

    const unused = new TickPace(Fence(1));
    Loop(unused, ALWAYS, Active(4, [0]));
    expect(unused.Census().MaxInFlight).toBe(0);
  });
});

// ── The prediction, as arithmetic ──

describe('?tick-pace — what the M4 should read, derived from a CPU and a GPU on one clock', () => {
  /**
   * Drive the loop on a tick grid with a real pipeline behind it. A tick that renders occupies the
   * worker for `Cpu` ms, so the next BeginFrame lands on the first grid point at or after the tick
   * plus that cost — which is what makes the depth-0 arm's period the SUM of the two costs.
   */
  const Run = (o: { Mode: TickPaceMode | null; Cpu: number; Gpu: number; Tick: number; Ms: number }) => {
    const pipe = new Pipeline(o.Cpu, o.Gpu);
    const pace = new TickPace(o.Mode);
    const renders: number[] = [];
    let t = 0;
    let owed = false;
    while (t < o.Ms) {
      pipe.Now = t;
      // A permanently-animating scene: every tick wants to render.
      const decision = pace.Decide(pipe);
      let next = t + o.Tick;
      if (decision === 'skip') {
        owed = true;
      } else {
        owed = false;
        renders.push(t);
        const cpuFreeAt = pipe.Render();
        next = Math.ceil((cpuFreeAt + 1e-9) / o.Tick) * o.Tick;
      }
      t = next;
    }
    const gaps = renders.slice(1).map((v, i) => v - renders[i]);
    // The steady state, not the ramp: the second half of the run.
    const tail = gaps.slice(Math.floor(gaps.length / 2));
    return {
      Pace: pace, Pipe: pipe, Renders: renders, Owed: owed,
      Period: tail.reduce((a, b) => a + b, 0) / tail.length,
    };
  };

  // The M4's shape at dpr 2: ~17 ms of CPU issuing, ~33 ms of GPU execution (gpu/frm 30.44 on the
  // fence arm, 33.29 on the ratio arm), polled on the 120 Hz tick cadence the flag itself produces.
  const M4 = { Cpu: 17, Gpu: 33, Tick: 1000 / 120, Ms: 6000 };

  it('DEPTH 0 SETTLES AT 50 ms — the CPU and the GPU stop overlapping and the frame costs their SUM', () => {
    const r = Run({ ...M4, Mode: Fence(0) });
    // 50.13 is what the M4 measured for the fence arm. The model says why: 17 + 33.
    expect(r.Period).toBeGreaterThan(48);
    expect(r.Period).toBeLessThan(52);
    // Never more than one frame outstanding, which is the definition of depth 0 — and of no pipeline.
    expect(r.Pipe.Peak).toBe(1);
    expect(r.Pace.Forced).toBe(0);
    // Not the poll: the grain here is 8.33 ms, so a poll-bound loop would have landed near 41.7.
    expect(r.Period - (M4.Cpu + M4.Gpu)).toBeLessThan(M4.Tick);
  });

  it('DEPTH 1 SETTLES AT 33.3 ms — the ratio arm s throughput, reached adaptively', () => {
    const r = Run({ ...M4, Mode: Fence(1) });
    // 33.48 is what the M4 measured for ?tick-pace=2. Same number, no clamp.
    expect(r.Period).toBeGreaterThan(32);
    expect(r.Period).toBeLessThan(35);
    // max(17, 33), not 17 + 33: the pipeline is back and the GPU is the only bottleneck left.
    expect(Math.abs(r.Period - M4.Gpu)).toBeLessThan(M4.Tick);
    expect(r.Pace.Forced).toBe(0);
  });

  it('depth 1 never lets a THIRD frame into the queue — the discarded render stays removed', () => {
    const r = Run({ ...M4, Mode: Fence(1) });
    // Two outstanding is the headroom the depth buys; three would be the unflagged engine running
    // ahead of the compositor, which is the thing this flag exists to stop.
    expect(r.Pipe.Peak).toBe(2);
    expect(r.Pace.Census().MaxInFlight).toBe(2);
  });

  it('depth 1 waits ONE tick per render in the steady state — the histogram the report should read', () => {
    const r = Run({ ...M4, Mode: Fence(1) });
    const w = r.Pace.Census().WaitedTicks;
    // A 33 ms render on this grid is two ticks: one skip, one render. The bucket that dominates is
    // the field that says the gate is pacing on the GPU and not on something slower.
    expect(w[1]).toBeGreaterThan(w[0] + w[2] + w[3]);
  });

  it('depth 1 is NOT the clamp: on a render that fits one vsync it renders EVERY tick', () => {
    // dpr 1.5's fast mode — the 21 ms mode of the bimodal base arm. This is the sentence that
    // separates the fix from the control, and the dpr-1.5 prediction in one pair of cells.
    const fast = { Cpu: 8, Gpu: 13, Tick: 1000 / 60, Ms: 3000 };
    const fence = Run({ ...fast, Mode: Fence(1) });
    expect(fence.Period).toBeCloseTo(fast.Tick, 5);
    expect(fence.Pace.Skipped).toBe(0);

    const ratio = Run({ ...fast, Mode: { Kind: 'ratio', N: 2 } });
    // The control halves it for nothing — 33.3 ms where the fence gate reads 16.67.
    expect(ratio.Period).toBeCloseTo(fast.Tick * 2, 5);
    expect(ratio.Period / fence.Period).toBeCloseTo(2, 5);
  });

  it('the phone reads nothing: fewer ticks than frames means there is no second render to remove', () => {
    // Its engine tick is 111-127 ms against 135 page frames a window. Nothing to pace.
    const phone = Run({ Mode: Fence(1), Cpu: 40, Gpu: 60, Tick: 120, Ms: 6000 });
    expect(phone.Pace.Skipped).toBe(0);
    expect(phone.Pace.Forced).toBe(0);
  });

  it('the fence latency the ledger samples IS the GPU s work, which is how a report tells them apart', () => {
    const r = Run({ ...M4, Mode: Fence(1) });
    const c = r.Pace.Census();
    // Armed at the end of the CPU's issuing, signalled when the GPU finishes: one GPU frame, plus
    // however long the frame ahead of it still had to run. A reading near zero with ticks still
    // waiting would mean the loss is the poll and not the work — that is the discrimination.
    expect(c.FenceMs.N).toBeGreaterThan(100);
    expect(c.FenceMs.Sum / c.FenceMs.N).toBeGreaterThan(M4.Gpu * 0.8);
  });
});
