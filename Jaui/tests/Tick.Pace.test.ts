import { describe, it, expect } from 'vitest';
import {
  TickPace, ParseTickPace, TickPaceText, VsyncEstimator,
  PACE_STALL_TICKS, PACE_DEFAULT_DEPTH, PACE_MAX_DEPTH, PACE_FENCE_RING,
  LOCK_HOLD_FRAMES, LOCK_CHANGE_MS, LOCK_MAX_N, VSYNC_FALLBACK_MS, VSYNC_MIN_SAMPLES,
  type PaceGate, type PaceDecision, type TickPaceMode, type PaceFenceSample,
} from '../src/Core/Tick.Pace';

/**
 * `?tick-pace` — pace the render on the DISPLAY instead of on the tick.
 *
 * Three cuts of this flag have now been measured on the M4. The first removed the second render
 * with a strictly serial gate and cost 50.13 ms (no CPU/GPU pipeline). The second made the gate a
 * DEPTH and reached 33.52 — and was found to be TRIMODAL: 1v 40%, 2v 16%, 3v 42%, a 3x swing the
 * p50 scored as a success. The fixed-ratio control is even (2v 99-100%) and a 30 fps clamp. This
 * lane is the third: lock the released cadence to a whole number of vsyncs, N = ceil(period /
 * vsync), re-chosen slowly with hysteresis — adaptive AND even.
 *
 * What has to be true for a reading under it to mean anything, and all of it is pinned here —
 * none of it needs a GPU, because none of it is about one:
 *
 *   1. IT LOSES NO RENDER, in every mode including the lock. A skipped tick defers a render, it
 *      does not drop one.
 *   2. THE STALL GUARD CANNOT BECOME THE MECHANISM — and under the lock that now means it must
 *      count FENCE refusals only. A lock refusal is the gate working, there are three of them per
 *      render at a 120 Hz callback cadence, and a guard that counted them would fire constantly.
 *   3. THE VSYNC IS DERIVED, NOT ASSUMED, and it survives the back-pressured callback cadence that
 *      is the unflagged state (33.3 ms of BeginFrame is two vsyncs, not a 30 Hz display).
 *   4. N IS CHOSEN FROM MEASURED COST AND DOES NOT FLAP. A period sitting exactly on a vsync
 *      boundary — the M4's ~17 ms at dpr 1.5 — holds N=1 rather than oscillating.
 *   5. THE RELEASED SEQUENCE IS EVEN, which is the whole point, and the model says so as
 *      arithmetic: the release intervals in the steady state are one number, not three.
 */

// ── Fence stand-ins ──

const NoSample = (): PaceFenceSample | null => null;
/** A gate holding a fixed number of frames in flight. */
const Busy = (n: number): PaceGate => ({ PaceInFlight: () => n, PaceTakeFence: NoSample });
/** A fence that never signals — a driver that lost the sync, or a flush that never happened. */
const NEVER = Busy(PACE_MAX_DEPTH + 1);
/** A GPU that is always idle — a render cheaper than a tick. */
const ALWAYS = Busy(0);

/** 60 Hz, the grid the tick harness below runs on unless a test says otherwise. */
const V60 = 1000 / 60;

/**
 * A CPU and a GPU on one clock, pipelined the way a real one is: the CPU issues a frame during the
 * tick (`Cpu` ms, after which `EndFrame` polls and arms the fence), the frame is submitted then,
 * and the GPU executes submitted frames SERIALLY and IN ORDER (`Gpu` ms each). The poll retires
 * every frame the GPU has finished by the time it is asked and reports the rest, and it publishes
 * the same four-field sample `WebGL2Renderer` does — including `Solo`, which is read at ARM time
 * after a poll, exactly as `_armPaceFence` reads it.
 */
class Pipeline implements PaceGate {
  Now = 0;
  /** What the CPU costs right now, mutable for the same reason `Cost` is. */
  Cpu: number;
  readonly Gpu: number;
  /** What the GPU costs RIGHT NOW. Mutable, so one run can get more expensive halfway through —
   *  which is what makes the hysteresis assertable at all. */
  Cost: number;
  /** Frames the GPU has not finished, oldest first. */
  private _queue: Array<{ ArmedAt: number; End: number; Solo: boolean }> = [];
  /** When the GPU will be free of everything submitted so far. */
  private _gpuFreeAt = 0;
  private _sample: PaceFenceSample | null = null;
  private _lastPollAt = 0;
  private _lastRetiredAt = 0;
  /** Deepest the queue ever got — the model's own `MaxInFlight`. */
  Peak = 0;
  /** Every frame ever issued: when the CPU started it and when the GPU finished it. */
  readonly Frames: Array<{ Start: number; End: number }> = [];

  constructor(cpu: number, gpu: number) { this.Cpu = cpu; this.Gpu = gpu; this.Cost = gpu; }

  private _pollAt = (now: number): void => {
    const gap = this._lastPollAt === 0 ? 0 : now - this._lastPollAt;
    this._lastPollAt = now;
    while (this._queue.length > 0 && this._queue[0].End <= now) {
      const f = this._queue.shift();
      if (!f) break;
      this._sample = {
        Ms: now - f.ArmedAt,
        GapMs: this._lastRetiredAt === 0 ? 0 : now - this._lastRetiredAt,
        Solo: f.Solo,
        PollGapMs: gap,
      };
      this._lastRetiredAt = now;
    }
  };

  PaceInFlight = (): number => { this._pollAt(this.Now); return this._queue.length; };

  PaceTakeFence = (): PaceFenceSample | null => {
    const s = this._sample;
    this._sample = null;
    return s;
  };

  /** What a tick that renders does: issue for `Cpu` ms, poll, arm a fence, submit. Returns the
   *  clock reading at which the CPU is free again. */
  Render = (): number => {
    const armedAt = this.Now + this.Cpu;
    this._pollAt(armedAt);
    const solo = this._queue.length === 0;
    const end = Math.max(armedAt, this._gpuFreeAt) + this.Cost;
    this._gpuFreeAt = end;
    this._queue.push({ ArmedAt: armedAt, End: end, Solo: solo });
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
 * The exact shape of the loop this flag edits: `NoteTick` on every callback, `_renderHold` set to 3
 * by the render-on-demand gate and decremented ONLY on a tick that actually rendered, `_paceOwed`
 * carrying a refused render forward, and the park predicate refusing both. Copied here as the
 * smallest thing that can be asserted about — not a second implementation of the pacing, which is
 * `TickPace` itself and is the object under test.
 */
const Loop = (
  pace: TickPace,
  gate: PaceGate | null,
  ticks: LoopTick[],
  hooks?: { OnTick?: (i: number) => void; OnRender?: (i: number) => void },
  tickMs = V60,
): LoopResult => {
  let hold = 0;
  let owed = false;
  const out: LoopResult = { Decisions: [], RenderedAt: [], ParkedAt: [] };
  for (let i = 0; i < ticks.length; i++) {
    const time = i * tickMs;
    hooks?.OnTick?.(i);
    pace.NoteTick(time);
    if (ticks[i].Active) hold = 3;
    const wants = hold > 0 || owed;
    const decision = wants ? pace.Decide(gate, time) : 'skip';
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

const All = (n: number): LoopTick[] => Active(n, Array.from({ length: n }, (_, i) => i));

const Fence = (depth: number): TickPaceMode => ({ Kind: 'fence', Depth: depth });
const Lock = (vsync: number | null = null): TickPaceMode =>
  ({ Kind: 'lock', Depth: PACE_DEFAULT_DEPTH, Vsync: vsync });

// ── Parsing ──

describe('?tick-pace — the parse', () => {
  it('the bare flag is the VSYNC LOCK — adaptive and even — and =lock spells it out', () => {
    // The whole lane is in this assertion. The fence gate reached the right median at dpr 2 and was
    // trimodal getting there; the bare flag must no longer select it.
    expect(ParseTickPace(null)).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: null } });
    expect(ParseTickPace('')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: null } });
    expect(ParseTickPace('  ')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: null } });
    expect(ParseTickPace('lock')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: null } });
    // And the safety net under it is still one frame in flight, not zero.
    expect(PACE_DEFAULT_DEPTH).toBe(1);
  });

  it('=lock:V pins the vsync, so a derived grid can be checked against one that cannot be wrong', () => {
    expect(ParseTickPace('lock:16.67')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: 16.67 } });
    expect(ParseTickPace('lock:8.33')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: 8.33 } });
  });

  it('refuses a malformed pin — `lock:` above all, which Number() reads as 0', () => {
    // A zero vsync divides the cadence by nothing. Same trap as `fence:`, same guard.
    for (const bad of ['lock:', 'lock:x', 'lock:0', 'lock:-8', 'lock:3', 'lock:41']) {
      expect(ParseTickPace(bad), `"${bad}" must be refused`).toHaveProperty('Why');
    }
  });

  it('=fence and =fence:D stay, as the controls they now are', () => {
    expect(ParseTickPace('fence')).toEqual({ Mode: { Kind: 'fence', Depth: 1 } });
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
    for (const bad of ['fence:', 'fence:x', 'fence:-1', 'fence:1.5', `fence:${PACE_MAX_DEPTH + 1}`]) {
      expect(ParseTickPace(bad), `"${bad}" must be refused`).toHaveProperty('Why');
    }
  });

  it('names the mode the same way everywhere the reading is printed', () => {
    // Two cells taken under different depths or different grids are two different instruments and
    // must not share a label. The live N is NOT in the name: it moves.
    expect(TickPaceText(null)).toBe('off');
    expect(TickPaceText(Lock())).toBe('lock');
    expect(TickPaceText(Lock(16.67))).toBe('lock:16.67');
    expect(TickPaceText(Fence(1))).toBe('fence:1');
    expect(TickPaceText(Fence(0))).toBe('fence:0');
    expect(TickPaceText({ Kind: 'ratio', N: 2 })).toBe('ratio:2');
  });

  it('the renderer keeps more fences than the deepest gate can hold outstanding', () => {
    expect(PACE_FENCE_RING).toBeGreaterThan(PACE_MAX_DEPTH + 1);
  });
});

// ── The vsync, derived ──

describe('?tick-pace=lock — the vsync is DERIVED from the callbacks, and the callbacks lie', () => {
  const Feed = (deltas: number[]): VsyncEstimator => {
    const v = new VsyncEstimator();
    let t = 1000;
    v.Note(t);
    for (const d of deltas) { t += d; v.Note(t); }
    return v;
  };
  const Uniform = (d: number, n = 16): number[] => Array.from({ length: n }, () => d);

  it('says nothing until it has seen enough — an estimate from three callbacks is a guess', () => {
    expect(Feed(Uniform(V60, VSYNC_MIN_SAMPLES - 1)).Estimate()).toBeNull();
    expect(Feed(Uniform(V60, VSYNC_MIN_SAMPLES)).Estimate()).not.toBeNull();
  });

  it('reads 60 Hz off a 60 Hz cadence, jitter and all', () => {
    expect(Feed(Uniform(V60)).Estimate()).toBeCloseTo(V60, 3);
    // Jitter pulls the SMALLEST delta down, and taking the candidate straight off it would snap to
    // 61 Hz. The window is refitted, so it does not.
    const jitter = [16.4, 16.9, 16.3, 17.0, 16.7, 16.5, 16.8, 16.6, 16.9, 16.4, 16.7, 16.7];
    expect(Feed(jitter).Estimate()).toBeCloseTo(V60, 3);
  });

  it('DOES NOT CALL A BACK-PRESSURED CADENCE A DISPLAY — 33.3 is two vsyncs, not 30 Hz', () => {
    // This is the failure the lock cannot survive: a 30 Hz "display" would lock every cadence to
    // multiples of 33.3 and the flag would become the clamp it exists to replace. The unflagged
    // engine's own callback rate on the M4 was exactly this.
    expect(Feed(Uniform(2 * V60)).Estimate()).toBeCloseTo(V60, 3);
    // Three vsyncs of back-pressure folds the same way.
    expect(Feed(Uniform(3 * V60)).Estimate()).toBeCloseTo(V60, 3);
  });

  it('takes the GRID from a mixture, which is what a partly back-pressured loop produces', () => {
    const mixed = [V60, V60, 2 * V60, V60, 2 * V60, 2 * V60, V60, V60, 3 * V60, V60, V60, 2 * V60];
    expect(Feed(mixed).Estimate()).toBeCloseTo(V60, 3);
  });

  it('a single stalled callback does not move it', () => {
    const stalled = [...Uniform(V60, 11), 250, ...Uniform(V60, 4)];
    expect(Feed(stalled).Estimate()).toBeCloseTo(V60, 3);
  });

  it('reads 120 Hz off an 8.33 ms cadence — AND THAT IS THE AMBIGUITY, so it is published', () => {
    // A 60 Hz panel whose worker is woken twice per vsync presents identically to a 120 Hz panel,
    // and nothing inside a worker can tell them apart (the M4 produced 120 Hz worker callbacks on a
    // 60 Hz display under `fence:0`). The estimate takes it at face value; `?tick-pace=lock:V`
    // pins the grid for the cell that has to be right.
    expect(Feed(Uniform(1000 / 120)).Estimate()).toBeCloseTo(1000 / 120, 3);
    const pinned = new TickPace(Lock(V60));
    expect(pinned.VsyncMs).toBeCloseTo(V60, 3);
    expect(pinned.VsyncDerived).toBe(true);
  });

  it('a pin beats the derivation, whatever the callbacks say', () => {
    const pinned = new TickPace(Lock(1000 / 120));
    Loop(pinned, ALWAYS, All(40), undefined, 2 * V60);
    expect(pinned.Census().VsyncMs).toBeCloseTo(1000 / 120, 2);
  });

  it('falls back to 60 Hz before it has an estimate, and SAYS it is a fallback', () => {
    const fresh = new TickPace(Lock());
    expect(fresh.VsyncMs).toBeCloseTo(VSYNC_FALLBACK_MS, 3);
    expect(fresh.VsyncDerived).toBe(false);
    expect(fresh.Census().VsyncDerived).toBe(false);
  });

  it('the median tick is NOT the vsync, and the ledger keeps them apart', () => {
    // 33.3 ms of callbacks on a 16.67 ms display: the early-release tolerance is sized from the
    // first and the cadence from the second, and conflating them is how the fence arm ended up
    // rounding a 33 ms cadence up to 41.
    const v = Feed(Uniform(2 * V60));
    expect(v.TickMs()).toBeCloseTo(2 * V60, 2);
    expect(v.Estimate()).toBeCloseTo(V60, 3);
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
      // The lock's columns read zero rather than absent, so one parser reads every arm.
      LockN: 0, LockChanges: 0, PeriodMs: 0,
      VsyncMs: Math.round(VSYNC_FALLBACK_MS * 100) / 100, VsyncDerived: false,
      LockSkipped: 0, FenceSkipped: 0,
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
      Loop(pace, null, All(60));
      const wants = pace.Rendered + pace.Skipped;
      expect(Math.abs(pace.Skipped / wants - share)).toBeLessThan(0.02);
      expect(pace.Forced).toBe(0);
    }
  });

  it('never polls a fence — the control needs no GL and must run on any backend', () => {
    const pace = new TickPace({ Kind: 'ratio', N: 2 });
    let polls = 0;
    const counted: PaceGate = { PaceInFlight: () => { polls++; return 0; }, PaceTakeFence: NoSample };
    Loop(pace, counted, Active(20, [0, 5, 10]));
    expect(polls).toBe(0);
  });
});

// ── The fence gate is a depth ──

describe('?tick-pace=fence — the fence gate is a DEPTH, not a boolean', () => {
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
    const through = new TickPace(Fence(1));
    Loop(through, Busy(1), Active(6, [0, 3]));
    expect(through.Skipped).toBe(0);
    expect(through.Rendered).toBe(6);

    const refused = new TickPace(Fence(1));
    Loop(refused, Busy(2), Active(PACE_STALL_TICKS, [0]));
    expect(refused.Rendered).toBe(0);
    expect(refused.Skipped).toBe(PACE_STALL_TICKS);
    // And every one of those skips is attributed to the fence, not to the lock.
    expect(refused.Census().FenceSkipped).toBe(PACE_STALL_TICKS);
    expect(refused.Census().LockSkipped).toBe(0);
  });

  it('skips while the GPU is behind and renders on the tick it catches up', () => {
    const pace = new TickPace(Fence(1));
    let polls = 0;
    const gate: PaceGate = { PaceInFlight: () => (++polls % 4 === 0 ? 1 : 2), PaceTakeFence: NoSample };
    const r = Loop(pace, gate, Active(12, [0]));
    expect(r.Decisions.slice(0, 8)).toEqual([
      'skip', 'skip', 'skip', 'render',
      'skip', 'skip', 'skip', 'render',
    ]);
  });

  it('a skip run resets on a render, so the stall guard measures CONSECUTIVE skips', () => {
    const pace = new TickPace(Fence(1));
    let i = 0;
    const gate: PaceGate = { PaceInFlight: () => (++i === 3 ? 0 : 2), PaceTakeFence: NoSample };
    const r = Loop(pace, gate, Active(4 + PACE_STALL_TICKS, [0]));
    expect(r.Decisions[2]).toBe('render');
    expect(r.Decisions.slice(3, 3 + PACE_STALL_TICKS).every(d => d === 'skip')).toBe(true);
  });
});

// ── The stall guard ──

describe('?tick-pace — the stall guard', () => {
  it('a fence that never signals still renders, on a bounded schedule, and says it is forced', () => {
    const pace = new TickPace(Fence(1));
    const ticks = 4 * (PACE_STALL_TICKS + 1);
    const r = Loop(pace, NEVER, All(ticks));
    expect(pace.Forced).toBe(4);
    expect(pace.Rendered).toBe(4);
    expect(pace.Skipped).toBe(ticks - 4);
    expect(r.Decisions.slice(0, PACE_STALL_TICKS + 1)).toEqual([
      ...Array<PaceDecision>(PACE_STALL_TICKS).fill('skip'), 'forced',
    ]);
  });

  it('it guards the LOCK too — a dead fence under the lock still renders', () => {
    // The lock passes a tick through to the fence and the fence refuses it; eight of those in a row
    // is the same freeze the fence arm can have, and the same guard has to break it.
    const pace = new TickPace(Lock());
    Loop(pace, NEVER, All(3 * (PACE_STALL_TICKS + 1)));
    expect(pace.Forced).toBeGreaterThanOrEqual(2);
    expect(pace.Census().FenceSkipped).toBeGreaterThan(0);
  });

  it('a forced render is counted apart from a real one, so a void cell is visible in the report', () => {
    const pace = new TickPace(Fence(1));
    Loop(pace, NEVER, Active(PACE_STALL_TICKS + 1, [0]));
    const c = pace.Census();
    expect(c.Forced).toBe(1);
    // Forced renders are Rendered too — the column is a subset, not a fourth outcome.
    expect(c.Rendered).toBe(1);
    expect(c.Mode).toBe('fence:1');
  });

  it('trips at least an order of magnitude past any frame either machine produces', () => {
    expect(PACE_STALL_TICKS * 16.67).toBeGreaterThan(73 * 1.5);
  });
});

// ── It loses no render ──

describe('?tick-pace — a skipped tick defers a render, it does not drop one', () => {
  const MODES: Array<TickPaceMode | null> = [
    null, Lock(), Lock(V60), Fence(0), Fence(1), Fence(2),
    { Kind: 'ratio', N: 2 }, { Kind: 'ratio', N: 5 },
  ];

  it('delivers each request its full three-render tail whatever the gate does', () => {
    for (const mode of MODES) {
      const pace = new TickPace(mode);
      let i = 0;
      // A hostile fence: idle only every fifth poll, over-depth otherwise. Four requests, spaced
      // far enough apart that no tail can run into the next one however much the gate delays it.
      const gate: PaceGate = {
        PaceInFlight: () => (++i % 5 === 0 ? 0 : PACE_MAX_DEPTH + 1),
        PaceTakeFence: NoSample,
      };
      const r = Loop(pace, gate, Active(120, [0, 20, 40, 60]));
      // Four requests x a three-frame settle tail, all delivered, in EVERY mode. A pace that lost a
      // render rather than deferring it would land under twelve, and that is the whole pixel claim.
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
        PaceTakeFence: NoSample,
      };
      const r = Loop(pace, gate, Active(120, [0, 11, 12, 50, 99]));
      expect(pace.Rendered + pace.Skipped, TickPaceText(mode)).toBe(r.Decisions.length);
      expect(pace.Forced, TickPaceText(mode)).toBeLessThanOrEqual(pace.Rendered);
      // The histogram counts renders and only renders.
      const binned = pace.Census().WaitedTicks.reduce((a, b) => a + b, 0);
      expect(binned, TickPaceText(mode)).toBe(pace.Rendered);
      // And every skip is attributed to exactly one gate in the modes that have two.
      const c = pace.Census();
      if (mode !== null && (mode.Kind === 'lock' || mode.Kind === 'fence')) {
        expect(c.LockSkipped + c.FenceSkipped, TickPaceText(mode)).toBe(c.Skipped);
      }
    }
  });

  it('a tick that does not want to render is not a skip — the columns count wants, not ticks', () => {
    const pace = new TickPace(Fence(1));
    Loop(pace, ALWAYS, Active(80, [0]));
    expect(pace.Rendered).toBe(3);
    expect(pace.Skipped).toBe(0);
  });

  it('the lock renders IMMEDIATELY after an idle gap — it does not owe the cadence a backlog', () => {
    // A cadence anchored in the past would spend the frames after a park catching up, which is a
    // burst exactly where an interaction wants latency. The anchor re-bases instead.
    const pace = new TickPace(Lock(V60));
    const r = Loop(pace, ALWAYS, Active(120, [0, 60]));
    expect(r.RenderedAt).toEqual([0, 1, 2, 60, 61, 62]);
    expect(pace.Skipped).toBe(0);
  });
});

// ── The ledger ──

describe('?tick-pace — WaitedTicks, FenceMs, MaxInFlight and the skip split', () => {
  it('buckets ticks waited per render at 0 / 1 / 2 / 3+, and saturates the last bucket', () => {
    const two = new TickPace(Fence(1));
    let i = 0;
    Loop(two, { PaceInFlight: () => (++i % 3 === 0 ? 0 : 2), PaceTakeFence: NoSample }, All(30));
    expect(two.Census().WaitedTicks[2]).toBe(two.Rendered);

    const many = new TickPace(Fence(1));
    let j = 0;
    Loop(many, { PaceInFlight: () => (++j % 5 === 0 ? 0 : 2), PaceTakeFence: NoSample }, All(40));
    expect(many.Census().WaitedTicks).toEqual([0, 0, 0, many.Rendered]);
  });

  it('reads on the control arms too, so the histogram is comparable across a comparison', () => {
    const ratio = new TickPace({ Kind: 'ratio', N: 2 });
    Loop(ratio, null, All(40));
    expect(ratio.Census().WaitedTicks).toEqual([1, ratio.Rendered - 1, 0, 0]);
  });

  it('samples the fence latency the gate hands it, once per retired fence', () => {
    const pace = new TickPace(Fence(1));
    const latencies = [30, 34, 31];
    let k = 0;
    const gate: PaceGate = {
      PaceInFlight: () => 0,
      PaceTakeFence: () => (k < latencies.length
        ? { Ms: latencies[k++], GapMs: 0, Solo: true, PollGapMs: 0 }
        : null),
    };
    Loop(pace, gate, Active(10, [0]));
    const c = pace.Census();
    expect(c.FenceMs).toEqual({ N: 3, Sum: 95, Max: 34 });
    expect(c.FenceMs.Sum / c.FenceMs.N).toBeCloseTo(31.67, 1);
  });

  it('a SOLO fence is a GPU cost reading, de-quantized by half the poll gap', () => {
    // Arm-to-poll is biased LATE by up to a whole poll interval, and on the 8.3 ms polling grain
    // this flag produces that is a quarter of a vsync — enough to push N up one.
    const pace = new TickPace(Fence(1));
    const gate: PaceGate = {
      PaceInFlight: () => 0,
      PaceTakeFence: () => ({ Ms: 36, GapMs: 0, Solo: true, PollGapMs: 8 }),
    };
    Loop(pace, gate, Active(6, [0]));
    expect(pace.PeriodMs).toBeCloseTo(32, 5);
  });

  it('a QUEUED fence is read on its completion GAP, because arm-to-signal includes the queue', () => {
    // This is why the depth-1 arm's FenceMs reads ~49 on a 33 ms frame and must never be the
    // period. The gap between two completions of back-to-back frames IS the GPU's cost.
    const pace = new TickPace(Fence(1));
    const gate: PaceGate = {
      PaceInFlight: () => 1,
      PaceTakeFence: () => ({ Ms: 49, GapMs: 33, Solo: false, PollGapMs: 8 }),
    };
    Loop(pace, gate, Active(6, [0]));
    expect(pace.PeriodMs).toBeCloseTo(33, 5);
    // And the raw latency still lands in the ledger unmodified — two different questions.
    expect(pace.Census().FenceMs.Max).toBe(49);
  });

  it('MaxInFlight proves the depth was REACHED — a cell at depth 1 that never saw 2 is depth 0', () => {
    const used = new TickPace(Fence(1));
    Loop(used, Busy(2), Active(4, [0]));
    expect(used.Census().MaxInFlight).toBe(2);

    const unused = new TickPace(Fence(1));
    Loop(unused, ALWAYS, Active(4, [0]));
    expect(unused.Census().MaxInFlight).toBe(0);
  });

  it('THE STALL GUARD DOES NOT COUNT LOCK REFUSALS — the gate working is not a stall', () => {
    // A 70 ms render at a 120 Hz callback cadence: the lock settles on N=5 (83.35 ms) and then
    // refuses nine or ten ticks between every pair of renders. A guard that counted those would
    // force a render every eight ticks and BECOME the pacing — the one failure mode that turns this
    // flag into a clamp nobody chose. It must be silent here, and it is: lock refusals do not feed
    // it, and the duration floor keeps it quiet through the warm-up as well.
    const pace = new TickPace(Lock(V60));
    const pipe = new Pipeline(20, 70);
    let t = 0;
    let forcedAtOneSecond = -1;
    while (t < 3000) {
      pipe.Now = t;
      pace.NoteTick(t);
      const d = pace.Decide(pipe, t);
      let next = t + 1000 / 120;
      if (d !== 'skip') { const free = pipe.Render(); pace.NoteRenderCost(20); next = free; }
      if (forcedAtOneSecond < 0 && t >= 1000) forcedAtOneSecond = pace.Forced;
      t = next;
    }
    // The cadence found the render: five vsyncs is 83.35 ms, the first multiple over 70.
    expect(pace.LockN).toBe(5);
    expect(pace.Census().LockSkipped).toBeGreaterThan(PACE_STALL_TICKS * 3);
    // And the lock, not the fence, is what is holding the ticks back.
    expect(pace.Census().LockSkipped).toBeGreaterThan(pace.Census().FenceSkipped * 3);
    // Nothing forced at all, warm-up included.
    expect(pace.Forced).toBe(0);
    expect(forcedAtOneSecond).toBe(0);
  });
});

// ── The prediction, as arithmetic ──

describe('?tick-pace — what the M4 should read, derived from a CPU and a GPU on one clock', () => {
  /**
   * Drive the loop on a tick grid with a real pipeline behind it. A tick that renders occupies the
   * worker for `Cpu` ms, so the next BeginFrame lands on the first grid point at or after the tick
   * plus that cost — which is what makes the depth-0 arm's period the SUM of the two costs. The
   * loop feeds `NoteTick` on every callback and `NoteRenderCost` on every render, exactly as
   * `_tickInner` does, so the lock's two estimates are derived here and not injected.
   */
  const Run = (o: { Mode: TickPaceMode | null; Cpu: number; Gpu: number; Tick: number; Ms: number }) => {
    const pipe = new Pipeline(o.Cpu, o.Gpu);
    const pace = new TickPace(o.Mode);
    const renders: number[] = [];
    let t = 0;
    while (t < o.Ms) {
      pipe.Now = t;
      pace.NoteTick(t);
      // A permanently-animating scene: every tick wants to render.
      const decision = pace.Decide(pipe, t);
      let next = t + o.Tick;
      if (decision !== 'skip') {
        renders.push(t);
        const cpuFreeAt = pipe.Render();
        pace.NoteRenderCost(o.Cpu);
        next = Math.ceil((cpuFreeAt + 1e-9) / o.Tick) * o.Tick;
      }
      t = next;
    }
    const gaps = renders.slice(1).map((v, i) => v - renders[i]);
    // The steady state, not the ramp: the second half of the run.
    const tail = gaps.slice(Math.floor(gaps.length / 2));
    return {
      Pace: pace, Pipe: pipe, Renders: renders, Gaps: gaps, Tail: tail,
      Period: tail.reduce((a, b) => a + b, 0) / tail.length,
      Spread: Math.max(...tail) - Math.min(...tail),
    };
  };

  // The M4's shape at dpr 2: ~17 ms of CPU issuing, ~33 ms of GPU execution (gpu/frm 30.44 on the
  // fence arm, 33.29 on the ratio arm), on the 120 Hz callback cadence the flag itself produces.
  const M4 = { Cpu: 17, Gpu: 33, Tick: 1000 / 120, Ms: 6000 };

  it('DEPTH 0 SETTLES AT 50 ms — the CPU and the GPU stop overlapping and the frame costs their SUM', () => {
    const r = Run({ ...M4, Mode: Fence(0) });
    expect(r.Period).toBeGreaterThan(48);
    expect(r.Period).toBeLessThan(52);
    expect(r.Pipe.Peak).toBe(1);
    expect(r.Pace.Forced).toBe(0);
    // Not the poll: the grain here is 8.33 ms, so a poll-bound loop would have landed near 41.7.
    expect(r.Period - (M4.Cpu + M4.Gpu)).toBeLessThan(M4.Tick);
  });

  it('DEPTH 1 SETTLES AT 33.3 ms — the ratio arm s throughput, reached adaptively', () => {
    const r = Run({ ...M4, Mode: Fence(1) });
    expect(r.Period).toBeGreaterThan(32);
    expect(r.Period).toBeLessThan(35);
    expect(Math.abs(r.Period - M4.Gpu)).toBeLessThan(M4.Tick);
    expect(r.Pace.Forced).toBe(0);
  });

  it('depth 1 never lets a THIRD frame into the queue — the discarded render stays removed', () => {
    const r = Run({ ...M4, Mode: Fence(1) });
    expect(r.Pipe.Peak).toBe(2);
    expect(r.Pace.Census().MaxInFlight).toBe(2);
  });

  it('THE LOCK REACHES THE SAME 33.3 AND RELEASES IT EVENLY — one interval, not three', () => {
    // The fence arm reached this median on the M4 and spent 82% of its frames at 16.7 or 50 ms
    // getting there. Evenness is the claim, so evenness is the assertion: in the steady state the
    // released intervals are ONE number. (The presented sequence is the compositor's and only the
    // machine can say; what the engine controls is when it releases, and this is that.)
    const r = Run({ ...M4, Mode: Lock() });
    expect(r.Period).toBeGreaterThan(32);
    expect(r.Period).toBeLessThan(35);
    expect(r.Spread).toBeLessThan(0.01);
    expect(r.Pace.Forced).toBe(0);
    // Every release is a whole number of the derived grid.
    const v = r.Pace.VsyncMs;
    expect(Math.abs(r.Period / v - Math.round(r.Period / v))).toBeLessThan(0.02);
  });

  it('the lock on a PINNED 60 Hz grid reads N=2 and settles within a few frames', () => {
    const r = Run({ ...M4, Mode: Lock(V60) });
    expect(r.Pace.LockN).toBe(2);
    expect(r.Period).toBeCloseTo(2 * V60, 1);
    expect(r.Spread).toBeLessThan(0.01);
    // The seed, and then nothing: a cadence that is still moving is a cadence that is oscillating.
    expect(r.Pace.LockChanges).toBe(1);
  });

  it('a grid read FINER than the display still releases on the display s grid at dpr 2', () => {
    // The 8.33 ms callback cadence is either a 120 Hz panel or a 60 Hz one woken twice a vsync, and
    // the derivation cannot tell. At dpr 2 it does not matter: N reads 4 instead of 2 and the
    // released cadence is the same 33.3 ms, which is a whole number of vsyncs on EITHER display.
    const derived = Run({ ...M4, Mode: Lock() });
    const pinned = Run({ ...M4, Mode: Lock(V60) });
    expect(derived.Pace.VsyncMs).toBeCloseTo(M4.Tick, 1);
    expect(derived.Pace.LockN).toBe(2 * pinned.Pace.LockN);
    expect(derived.Period).toBeCloseTo(pinned.Period, 1);
  });

  it('depth 1 waits ONE tick per render in the steady state — the histogram the report should read', () => {
    const r = Run({ ...M4, Mode: Fence(1) });
    const w = r.Pace.Census().WaitedTicks;
    expect(w[1]).toBeGreaterThan(w[0] + w[2] + w[3]);
  });

  it('THE STRADDLE: a 17 ms render on a 16.67 ms vsync HOLDS N=1 instead of flapping to 2', () => {
    // dpr 1.5 on the M4: the fence arm reached 16.93 on 54% of frames and could not hold it, and
    // the clamp could never reach it. The margin is what makes the lock hold it — and holding it
    // means the fence underneath occasionally refuses, which is the right failure: an occasional
    // 2v frame, not a permanent 30 fps.
    const straddle = { Cpu: 8, Gpu: 17, Tick: V60, Ms: 4000 };
    const r = Run({ ...straddle, Mode: Lock() });
    expect(r.Pace.VsyncMs).toBeCloseTo(V60, 2);
    expect(r.Pace.LockN).toBe(1);
    expect(r.Pace.LockChanges).toBe(0);
    expect(r.Pace.Census().FenceSkipped).toBeGreaterThan(0);
    expect(r.Period).toBeLessThan(2 * V60);
  });

  it('the lock is NOT the clamp: on a render that fits one vsync it renders EVERY tick', () => {
    // dpr 1.5's fast mode — the 21 ms mode of the bimodal base arm. This is the sentence that
    // separates the fix from the control, and the dpr-1.5 prediction in one trio of cells.
    const fast = { Cpu: 8, Gpu: 13, Tick: V60, Ms: 3000 };
    const lock = Run({ ...fast, Mode: Lock() });
    expect(lock.Period).toBeCloseTo(fast.Tick, 5);
    expect(lock.Pace.LockN).toBe(1);
    expect(lock.Pace.Census().FenceSkipped).toBe(0);

    const fence = Run({ ...fast, Mode: Fence(1) });
    expect(fence.Period).toBeCloseTo(fast.Tick, 5);

    const ratio = Run({ ...fast, Mode: { Kind: 'ratio', N: 2 } });
    // The control halves it for nothing — 33.3 ms where the lock reads 16.67.
    expect(ratio.Period).toBeCloseTo(fast.Tick * 2, 5);
    expect(ratio.Period / lock.Period).toBeCloseTo(2, 5);
  });

  it('N STEPS UP when the render gets more expensive, and not before it has to', () => {
    // Half a run at 33 ms and half at 66: the cadence must follow, once, in each direction, and
    // never inside the rate limit.
    const pace = new TickPace(Lock(V60));
    const changes: Array<{ N: number; At: number }> = [];
    let t = 0;
    const pipe = new Pipeline(17, 33);
    pace.OnLockChange = n => changes.push({ N: n, At: t });
    const step = (cpu: number, gpu: number, ms: number): void => {
      pipe.Cpu = cpu;
      pipe.Cost = gpu;
      const until = t + ms;
      while (t < until) {
        pipe.Now = t;
        pace.NoteTick(t);
        const d = pace.Decide(pipe, t);
        let next = t + M4.Tick;
        if (d !== 'skip') { const free = pipe.Render(); pace.NoteRenderCost(cpu); next = Math.ceil(free / M4.Tick) * M4.Tick; }
        t = next;
      }
    };
    step(17, 33, 2000);
    expect(pace.LockN).toBe(2);
    step(30, 66, 3000);
    expect(pace.LockN).toBe(4);
    step(17, 33, 4000);
    expect(pace.LockN).toBe(2);
    // Up once, down once, plus the seed — and never twice inside the rate limit.
    expect(changes.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i].At - changes[i - 1].At).toBeGreaterThanOrEqual(LOCK_CHANGE_MS);
    }
  });

  it('N NEVER OSCILLATES on a period sitting exactly on the boundary', () => {
    // A cost that alternates either side of 2 vsyncs every frame: the margin and the hold together
    // have to hold the cadence still. A flapping N is worse than either fixed value.
    const pace = new TickPace(Lock(V60));
    const pipe = new Pipeline(17, 33);
    let t = 0;
    let flip = false;
    while (t < 6000) {
      pipe.Now = t;
      pace.NoteTick(t);
      const d = pace.Decide(pipe, t);
      let next = t + M4.Tick;
      if (d !== 'skip') {
        flip = !flip;
        pipe.Cost = flip ? 30 : 36;
        const free = pipe.Render();
        pace.NoteRenderCost(17);
        next = Math.ceil(free / M4.Tick) * M4.Tick;
      }
      t = next;
    }
    expect(pace.LockN).toBe(2);
    expect(pace.LockChanges).toBeLessThanOrEqual(1);
  });

  it('N is bounded — a render nobody should ship is not silently throttled to 2 fps', () => {
    const r = Run({ Mode: Lock(V60), Cpu: 100, Gpu: 400, Tick: V60, Ms: 8000 });
    expect(r.Pace.LockN).toBeLessThanOrEqual(LOCK_MAX_N);
  });

  it('the hold is long enough that a burst of expensive frames cannot move the cadence', () => {
    // LOCK_HOLD_FRAMES consecutive agreeing evaluations at ~33 ms is a quarter of a second of
    // agreement — a scroll that spikes three frames does not get to re-time the engine.
    expect(LOCK_HOLD_FRAMES * 33).toBeGreaterThan(LOCK_CHANGE_MS);
  });

  it('the phone reads nothing: fewer ticks than frames means there is no second render to remove', () => {
    // Its engine tick is 111-127 ms against 135 page frames a window. Nothing to pace — and the
    // lock must not invent something to do. (Its derived grid is meaningless at that cadence, and
    // harmless for the same reason: the tick rate binds long before the cadence does.)
    for (const mode of [Fence(1), Lock(), Lock(V60)]) {
      const phone = Run({ Mode: mode, Cpu: 40, Gpu: 60, Tick: 120, Ms: 6000 });
      expect(phone.Pace.Skipped, TickPaceText(mode)).toBe(0);
      expect(phone.Pace.Forced, TickPaceText(mode)).toBe(0);
    }
  });

  it('the fence latency the ledger samples IS the GPU s work, which is how a report tells them apart', () => {
    const r = Run({ ...M4, Mode: Fence(1) });
    const c = r.Pace.Census();
    expect(c.FenceMs.N).toBeGreaterThan(100);
    expect(c.FenceMs.Sum / c.FenceMs.N).toBeGreaterThan(M4.Gpu * 0.8);
  });

  it('THE PERIOD IS MEASURED, and it reads the frame s cost on both the lock and the fence arm', () => {
    // max(CPU issue, GPU execution) — the pipelined period, not the fence's latency, which at depth
    // 1 legitimately reads ~49 on this shape. If this number is wrong, N is wrong.
    const lock = Run({ ...M4, Mode: Lock(V60) });
    // Within one poll interval BELOW the truth, and never above it. The bias is deliberate and its
    // direction is the design: an over-read parks the loop at a slower cadence with nothing to
    // correct it, while an under-read saturates the GPU, turns the samples into exact completion
    // GAPS, and steps back up. It must therefore never read high.
    expect(lock.Pace.PeriodMs).toBeGreaterThan(M4.Gpu - M4.Tick);
    expect(lock.Pace.PeriodMs).toBeLessThan(M4.Gpu * 1.05);
    // And the cadence it chose from that reading is the right one, which is the only thing the
    // estimate has to get right.
    expect(lock.Pace.LockN).toBe(2);

    const cpuBound = Run({ Mode: Lock(V60), Cpu: 40, Gpu: 10, Tick: V60, Ms: 3000 });
    // CPU-bound: the GPU half says 10 and the period must not believe it.
    expect(cpuBound.Pace.PeriodMs).toBeGreaterThan(35);
  });
});
