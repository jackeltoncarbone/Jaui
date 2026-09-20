import { describe, it, expect } from 'vitest';
import {
  TickPace, ParseTickPace, TickPaceText, VsyncEstimator,
  PACE_STALL_TICKS, PACE_DEFAULT_DEPTH, PACE_MAX_DEPTH, PACE_FENCE_RING,
  LOCK_CHANGE_MS, LOCK_MAX_N, LOCK_MARGIN_SHARE, LOCK_LIVE_HOLD, LIVE_MIN_SAMPLES,
  WINDOW_TICKS, WINDOW_WARMUP_SKIP, WINDOW_DWELL_MS, WINDOW_DWELL_MAX_MS,
  WINDOW_MIN_SPACING_MS, WINDOW_BUSY_SHARE, WINDOW_MAX_MS,
  VSYNC_FALLBACK_MS, VSYNC_MIN_SAMPLES,
  type PaceGate, type PaceDecision, type TickPaceMode, type PaceFenceSample,
} from '../src/Core/Tick.Pace';

/**
 * `?tick-pace` — pace the render on the DISPLAY instead of on the tick.
 *
 * Five cuts of this flag have now been measured on the M4, and the MECHANISM has been right since
 * the third: 100% of frames in one bucket at both resolutions, the pinned vsync arm choosing the
 * same N as the derived one. Every failure has been the PERIOD, and each one over-read:
 *
 *     tickpace3  max(CPU-issue EMA, solo-fence EMA)      37.5 against a true 29.41  ->  50.10 ms
 *     tickpace5  mean release interval in a saturated run 39.7 against a true 25.0  ->  33.37, and
 *                                                         27.1 against a true 16.04 -> CLAMPED
 *
 * The `observe` arm of the tickpace5 cell said why none of those inputs can be a render period, and
 * the argument is `SoloMs`: 31.9 at dpr 2 and 30.9 at dpr 1.5, two resolutions that differ by 44%
 * of the pixel work. AN EXECUTION TIME CANNOT DO THAT. A solo fence's arm-to-signal is the
 * present's latency floor — THE FENCE SEES THE SWAP, NOT THE RENDER — and the queued gap and the
 * tick-quantised release interval are present-coupled for the same reason.
 *
 * THE ONE MEASURE THAT HAS EVER READ THE PERIOD is the UNGATED loop's callback cadence, because the
 * worker's rAF is gated on SUBMISSION: 25.0 ms at dpr 2 and 16.04 at dpr 1.5, against presented
 * frames of 50.46 and 16.66. This lane observes that, in windows where the lock takes its own gate
 * off, and what has to be true for a reading under it to mean anything is pinned here — none of it
 * needs a GPU, because none of it is about one:
 *
 *   1. IT LOSES NO RENDER, in every mode including the lock. A skipped tick defers a render, it
 *      does not drop one.
 *   2. THE STALL GUARD CANNOT BECOME THE MECHANISM — and under the lock that means it must count
 *      FENCE refusals only. A lock refusal is the gate working, there are three of them per render
 *      at a 120 Hz callback cadence, and a guard that counted them would fire constantly.
 *   3. THE VSYNC IS DERIVED, NOT ASSUMED, and it survives the back-pressured callback cadence that
 *      is the unflagged state (33.3 ms of BeginFrame is two vsyncs, not a 30 Hz display).
 *   4. THE PERIOD IS THE UNGATED CALLBACK CADENCE, and NOTHING a fence reports may reach a cadence.
 *      The two fence latency channels stay in the ledger to keep the over-read priced and a test
 *      below feeds the controller a lying fence to prove they cannot move N.
 *   5. A WINDOW IS PAID FOR AND BOUNDED: it runs the page at the unflagged cadence, it reads its
 *      period past the pipeline FILL TRANSIENT (the head of every window is the display grid), and
 *      it happens once per dwell with the dwell doubling while the answer holds.
 *   6. THE CLASSIFIER TELLS A SLOW GPU FROM A SLOW BeginFrame. The phone ticks at 111-127 ms and
 *      must read N=1; the M4 ticks at 25.0 and must read N=2. `ticks/frame` would separate them and
 *      a worker cannot compute it — there is no presentation signal there — so OCCUPANCY does.
 *   7. THE RELEASED SEQUENCE IS EVEN, which is the whole point, and the model says so as
 *      arithmetic: outside the windows, the release intervals are ONE number.
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
 * and the GPU executes submitted frames SERIALLY and IN ORDER (`Cost` ms each). The poll retires
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
 *
 * Its callbacks are on a FIXED grid, which makes it the right harness for the gate's arithmetic and
 * the wrong one for the period: the whole finding of this lane is that the callback grid is not
 * fixed. `RunSubmit` below is the harness for that.
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
const Lock = (vsync: number | null = null, live = false): TickPaceMode =>
  ({ Kind: 'lock', Depth: PACE_DEFAULT_DEPTH, Vsync: vsync, Live: live });

// ── Parsing ──

describe('?tick-pace — the parse', () => {
  it('the bare flag is the VSYNC LOCK — adaptive and even — and =lock spells it out', () => {
    expect(ParseTickPace(null)).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: null, Live: false } });
    expect(ParseTickPace('')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: null, Live: false } });
    expect(ParseTickPace('  ')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: null, Live: false } });
    expect(ParseTickPace('lock')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: null, Live: false } });
    // And the safety net under it is still one frame in flight, not zero.
    expect(PACE_DEFAULT_DEPTH).toBe(1);
  });

  it('=lock:V pins the vsync, so a derived grid can be checked against one that cannot be wrong', () => {
    expect(ParseTickPace('lock:16.67')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: 16.67, Live: false } });
    expect(ParseTickPace('lock:8.33')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: 8.33, Live: false } });
  });

  it('=lock:live selects the RenderedGapMs path, with or without a pin — one binary, two paths', () => {
    // The switch this lane exists to let the M4 decide. Both arms must ship in one binary or the
    // cell that settles it is two cells.
    expect(ParseTickPace('lock:live')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: null, Live: true } });
    expect(ParseTickPace('lock:live:16.67')).toEqual({ Mode: { Kind: 'lock', Depth: 1, Vsync: 16.67, Live: true } });
    expect(TickPaceText(Lock(null, true))).toBe('lock:live');
    expect(TickPaceText(Lock(V60, true))).toBe('lock:live:16.67');
  });

  it('refuses a malformed pin — `lock:` above all, which Number() reads as 0', () => {
    // A zero vsync divides the cadence by nothing. Same trap as `fence:`, same guard.
    for (const bad of ['lock:', 'lock:x', 'lock:0', 'lock:-8', 'lock:3', 'lock:41', 'lock:live:0', 'lock:live:x']) {
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

  it('SURVIVES AN OBSERVATION WINDOW — 25.0 ms arrives as a MIXTURE of 16.67 and 33.3, not as 25', () => {
    // THE HARDEST CASE THE DERIVATION FACES, and this lane created it. The ungated cadence is the
    // one number in the file that is not a whole multiple of the vsync: 25.0 is one-and-a-half of
    // them. On the machine the individual deltas are still vsync-snapped and alternate, which folds
    // to 16.67 correctly.
    const alternating = [V60, 2 * V60, V60, V60, 2 * V60, V60, 2 * V60, V60, V60, 2 * V60, V60, V60];
    expect(Feed(alternating).Estimate()).toBeCloseTo(V60, 3);
    const mean = alternating.reduce((a, b) => a + b, 0) / alternating.length;
    expect(mean).toBeGreaterThan(V60);
    expect(mean).toBeLessThan(2 * V60);

    // ...AND THE FALSIFIER, stated as arithmetic rather than hoped away: a platform that handed the
    // worker UN-SNAPPED BeginFrame times would present a uniform 25, and a uniform 25 folds to a
    // 12.5 ms "80 Hz" grid. `?tick-pace=lock:16.67` is the control that catches it.
    expect(Feed(Uniform(25)).Estimate()).toBeCloseTo(12.5, 2);
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
      LockN: 0, LockCommittedN: 0, LockChanges: 0, Windows: 0,
      // Nothing observed, and the source says WHICH nothing — the field that separates "no reading
      // yet" from "a reading of zero" and from "N=1 needs no reading".
      PeriodMs: 0, PeriodSource: 'none', PeriodObservedAt: -1,
      UngatedGapMs: 0, RenderedGapMs: 0,
      WindowBusyShare: 0, WindowCpuShare: 0, WindowRising: false,
      SoloMs: 0, SatGapMs: 0, RenderMs: 0,
      VsyncMs: Math.round(VSYNC_FALLBACK_MS * 100) / 100, VsyncDerived: false,
      LockSkipped: 0, FenceSkipped: 0,
    });
  });

  it('the unflagged arm pays NOTHING for the instrument — NoteTick returns before it measures', () => {
    // The instrument is two subtractions and a ring write per callback, and an engine with no flag
    // must not pay even that. `RenderedGapMs` staying 0 through a whole run is the assertion.
    const pace = new TickPace(null);
    Loop(pace, null, All(200));
    expect(pace.Census().RenderedGapMs).toBe(0);
    expect(pace.Census().UngatedGapMs).toBe(0);
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

  it('it guards the LOCK too — a dead fence under the lock still renders, ONCE THE WINDOW CLOSES', () => {
    // A window takes the fence OUT of the loop on purpose — a window is the unflagged engine — so a
    // dead fence cannot force anything while one is open, and must not: nothing is being refused.
    // The guard has to be there the moment the gate goes back on, and that is the assertion.
    const pace = new TickPace(Lock(V60));
    Loop(pace, NEVER, All(200));
    expect(pace.Forced).toBeGreaterThanOrEqual(2);
    expect(pace.Census().FenceSkipped).toBeGreaterThan(0);
    // ...and nothing was forced during the window itself.
    const early = new TickPace(Lock(V60));
    Loop(early, NEVER, All(WINDOW_TICKS - 2));
    expect(early.Forced).toBe(0);
    expect(early.Rendered).toBe(WINDOW_TICKS - 2);
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
    null, Lock(), Lock(V60), Lock(V60, true), Fence(0), Fence(1), Fence(2),
    { Kind: 'ratio', N: 2 }, { Kind: 'ratio', N: 5 }, { Kind: 'observe' },
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
    const r = Loop(pace, ALWAYS, Active(400, [0, 200, 300]));
    expect(r.RenderedAt.slice(0, 3)).toEqual([0, 1, 2]);
    expect(r.RenderedAt).toContain(200);
    expect(r.RenderedAt).toContain(300);
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

  it('A SOLO FENCE IS THE PRESENT S LATENCY FLOOR, and it is published as one and nothing else', () => {
    // THE WHOLE LANE IN ONE ASSERTION, now with the mechanism named. Arm-to-signal on an idle GPU
    // is the completion of a command buffer that carries the drawable present, so it is quantised
    // by the display and not by the pixel work: the M4 read 31.9 at dpr 2 and 30.9 at dpr 1.5. It
    // lands in `SoloMs`, de-quantized by half the poll gap, and NOTHING may decide on it.
    const pace = new TickPace(Fence(1));
    const gate: PaceGate = {
      PaceInFlight: () => 0,
      PaceTakeFence: () => ({ Ms: 36, GapMs: 0, Solo: true, PollGapMs: 8 }),
    };
    Loop(pace, gate, Active(6, [0]));
    expect(pace.Census().SoloMs).toBeCloseTo(32, 5);
    expect(pace.PeriodMs).toBe(0);
    expect(pace.Census().PeriodSource).toBe('none');
  });

  it('a QUEUED fence gap is the PRESENT cadence, which is why it is not the period either', () => {
    // The observe arm read `SatGapMs` 54.9 against a 50.47 ms frame with five frames in flight: a
    // queued completion gap is the rate frames are PRESENTED at, not the rate they are executed at.
    const pace = new TickPace(Fence(1));
    const gate: PaceGate = {
      PaceInFlight: () => 1,
      PaceTakeFence: () => ({ Ms: 49, GapMs: 33, Solo: false, PollGapMs: 8 }),
    };
    Loop(pace, gate, Active(6, [0]));
    expect(pace.Census().SatGapMs).toBeCloseTo(33, 5);
    // And the raw latency still lands in the ledger unmodified — three different questions.
    expect(pace.Census().FenceMs.Max).toBe(49);
    expect(pace.Census().SoloMs).toBe(0);
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

describe('?tick-pace — what the M4 should read, on a loop whose CALLBACKS are submission-gated', () => {
  /**
   * A CPU, a GPU and A COMPOSITOR on one clock — and the compositor is what the previous two lanes'
   * harnesses did not have.
   *
   * The finding this lane rests on is that the worker's rAF is not a free-running clock: Chromium
   * issues BeginFrame on the DISPLAY grid and stops while too many of our commits are unacked, and
   * a commit is acked when its GPU work completes. So:
   *
   *   * the next callback is the first point on the wake grid at or after the worker is free AND at
   *     which fewer than `Cap` of our frames are still running;
   *   * an UNGATED loop therefore ticks at the display rate until the queue fills (~`Cap` frames of
   *     transient) and then at the COMPLETION rate, which is the render period. That is the 25.0 ms
   *     the M4 reads as `ticks/s` at dpr 2 while presenting at 50.46;
   *   * a GATED loop submits nothing on a skipped tick, so the queue never fills and the callbacks
   *     free-run at the display rate. That is why the period is unobservable while gated, and it is
   *     what `?tick-pace=lock:live` is a bet against.
   */
  interface SubmitOpts {
    Mode: TickPaceMode | null;
    /** `_render`'s wall time on the worker. */
    Cpu: number;
    /** One frame's GPU execution — the render period when the pipe is full. */
    Gpu: number;
    /** The grid the worker is woken on. The display's, unless the platform is slower. */
    Wake?: number;
    /** Unacked commits Chromium allows before it stops issuing BeginFrame. The observe arm measured
     *  five in flight on the M4. */
    Cap?: number;
    Ms: number;
  }

  const RunSubmit = (o: SubmitOpts) => {
    const wake = o.Wake ?? V60;
    const cap = o.Cap ?? 5;
    const pipe = new Pipeline(o.Cpu, o.Gpu);
    const pace = new TickPace(o.Mode);
    const ticks: number[] = [];
    const renders: number[] = [];
    const changes: Array<{ N: number; At: number; Source: string }> = [];
    const windows: Array<{ Phase: string; Reason: string; Mean: number; At: number }> = [];
    const EPS = 1e-9;
    const nextWake = (x: number): number => Math.ceil((x + EPS) / wake) * wake;
    let t = 0;
    pace.OnLockChange = (n, _p, _v, source) => changes.push({ N: n, At: t, Source: source });
    pace.OnWindow = (phase, reason, mean) => windows.push({ Phase: phase, Reason: reason, Mean: mean, At: t });
    while (t < o.Ms) {
      ticks.push(t);
      pipe.Now = t;
      pace.NoteTick(t);
      const d = pace.Decide(pipe, t);
      if (d !== 'skip') { renders.push(t); pipe.Render(); pace.NoteRenderCost(o.Cpu); }
      // The worker is busy for `Cpu` ms after a render, so it cannot take a callback inside that.
      let c = nextWake(d !== 'skip' ? t + o.Cpu : t);
      let guard = 0;
      while (guard++ < 4096) {
        let unacked = 0;
        for (const f of pipe.Frames) if (f.End > c) unacked++;
        if (unacked < cap) break;
        c = nextWake(c);
      }
      t = c;
    }
    const tickGaps = ticks.slice(1).map((v, i) => v - ticks[i]);
    const gaps = renders.slice(1).map((v, i) => v - renders[i]);
    // The steady state, not the ramp: the second half of the run.
    const tail = gaps.slice(Math.floor(gaps.length / 2));
    // The released cadence is read on its HISTOGRAM, never on its mean — that is the rule the
    // trimodal cut produced and it is how the M4's cells are read.
    const hist = new Map<number, number>();
    for (const g of tail) { const k = Math.round(g * 10) / 10; hist.set(k, (hist.get(k) ?? 0) + 1); }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
    return {
      Pace: pace, Pipe: pipe, Ticks: ticks, Renders: renders, Changes: changes, Windows: windows,
      Tail: tail,
      /** The UNGATED callback cadence over the tail — the harness's `ticks/s`, which is the
       *  quantity the whole lane is about. */
      TickPeriod: tickGaps.slice(Math.floor(tickGaps.length / 2)).reduce((a, b) => a + b, 0)
        / Math.max(1, tickGaps.length - Math.floor(tickGaps.length / 2)),
      Period: tail.length === 0 ? 0 : tail.reduce((a, b) => a + b, 0) / tail.length,
      Bucket: top[0], Share: tail.length === 0 ? 0 : top[1] / tail.length,
    };
  };

  // The M4 at dpr 2 with the flatprogram2 engine: the directly measured render period is 25.0 ms
  // (ticks/s on the unpaced arm) and `RenderMs` is 0.6 — almost all of the frame is the GPU's.
  const M4 = { Cpu: 0.6, Gpu: 25.0, Ms: 6000 };
  // ...and at dpr 1.5, where flatprogram2 took the render UNDER one vsync. This is the cell that
  // decides the lane: the fence arm does 16.66 at 1v 100% there and the tickpace5 lock clamped it
  // to 33.3, which is twice as bad as doing nothing.
  const M4_15 = { Cpu: 0.7, Gpu: 16.04, Ms: 6000 };

  it('THE HARNESS ITSELF: an UNGATED loop ticks at the RENDER PERIOD, not at the display rate', () => {
    // Before any assertion about the controller, the model has to reproduce the one measurement
    // everything rests on. Unflagged at dpr 2: callbacks at 25.0 ms on a 16.67 ms display.
    const off = RunSubmit({ ...M4, Mode: null });
    expect(off.TickPeriod).toBeGreaterThan(V60 * 1.2);
    expect(off.TickPeriod).toBeLessThan(2 * V60);
    expect(Math.abs(off.TickPeriod - M4.Gpu)).toBeLessThan(2);
    // ...and at dpr 1.5, where the render fits inside a vsync, the DISPLAY binds instead and the
    // callbacks are one vsync apart. That asymmetry is the whole dpr-1.5 story.
    const off15 = RunSubmit({ ...M4_15, Mode: null });
    expect(off15.TickPeriod).toBeCloseTo(V60, 1);
  });

  it('THE CELL THE LANE EXISTS FOR: dpr 2 reads N=2 from a MEASURED 25 ms, not a modelled 39.7', () => {
    const r = RunSubmit({ ...M4, Mode: Lock(V60) });
    const c = r.Pace.Census();
    expect(c.LockCommittedN).toBe(2);
    expect(r.Bucket).toBeCloseTo(2 * V60, 1);
    expect(r.Share).toBeGreaterThan(0.9);
    // The number it chose from is the MEASURED period, within the grain the vsync grid quantizes
    // the callback cadence by — NOT the 39.7 the saturated-run estimator read.
    expect(c.PeriodSource).toBe('warmup');
    expect(Math.abs(c.PeriodMs - M4.Gpu)).toBeLessThan(V60 / 2);
    expect(c.UngatedGapMs).toBeCloseTo(c.PeriodMs, 1);
    // The GPU occupancy channel is what classified it, not the CPU one: `RenderMs` is 0.6.
    expect(c.WindowBusyShare).toBeGreaterThanOrEqual(WINDOW_BUSY_SHARE);
    expect(c.WindowCpuShare).toBeLessThan(0.1);
    expect(c.Forced).toBe(0);
  });

  it('THE CELL THAT DECIDES THE LANE: dpr 1.5 reads N=1 and 16.7 — the clamp is GONE', () => {
    // tickpace5 put N=2 here from a 27.1 ms estimate against a true 16.04, which is 33.3 where the
    // fence arm was doing 16.66 at 1v 100%. The measured cadence is one vsync, so N is one.
    const r = RunSubmit({ ...M4_15, Mode: Lock(V60) });
    const c = r.Pace.Census();
    expect(c.LockCommittedN).toBe(1);
    expect(r.Bucket).toBeCloseTo(V60, 1);
    expect(r.Share).toBeGreaterThan(0.95);
    expect(c.UngatedGapMs).toBeLessThan(V60 * (1 + LOCK_MARGIN_SHARE) + 0.1);
    expect(c.Forced).toBe(0);
    // ...and the clamp it is being compared against, on the same model.
    const clamp = RunSubmit({ ...M4_15, Mode: { Kind: 'ratio', N: 2 } });
    expect(clamp.Bucket).toBeCloseTo(2 * V60, 1);
    expect(r.Bucket).toBeLessThan(clamp.Bucket);
  });

  it('THE PIPELINE FILL TRANSIENT is real, and a SHORT window would have read the display grid', () => {
    // The head of every window is the queue filling, and during the fill the callbacks are still on
    // the display grid. This is the arithmetic behind `WINDOW_TICKS` and the mean-of-the-last-half:
    // the first twelve callbacks of an ungated dpr-2 loop average ~16.67, not 25.
    const off = RunSubmit({ ...M4, Mode: null, Ms: 400 });
    const early = off.Ticks.slice(1, 13).map((v, i) => v - off.Ticks[i]);
    const earlyMean = early.reduce((a, b) => a + b, 0) / early.length;
    // Still filling: nearer the display grid than the period, and well under it. A window that
    // stopped here would seed N=1 on a scene whose renders cost a vsync and a half.
    expect(earlyMean).toBeLessThan((V60 + M4.Gpu) / 2);
    expect(earlyMean).toBeGreaterThanOrEqual(V60);
    expect(Math.ceil((earlyMean - V60 * LOCK_MARGIN_SHARE) / V60)).toBe(1);
    // ...and the whole window, read over its last half, gets the period instead.
    const r = RunSubmit({ ...M4, Mode: Lock(V60) });
    expect(Math.abs(r.Pace.Census().UngatedGapMs - M4.Gpu)).toBeLessThan(V60 / 2);
    // The queue had settled by the time it closed, so the reading is not a lower bound.
    expect(r.Pace.Census().WindowRising).toBe(false);
  });

  it('a CPU-BOUND loop is classified by the CPU channel — the fence never sees it at all', () => {
    // 25 ms of issuing with a GPU that always wins. The queue is empty at every poll, so GPU
    // occupancy reads 0 — and the cadence IS the period, so it must still read as occupied or the
    // lock would hold N=1 and hand the page a 25-on-16.67 judder.
    const r = RunSubmit({ Mode: Lock(V60), Cpu: 25, Gpu: 2, Ms: 4000 });
    const c = r.Pace.Census();
    expect(c.WindowBusyShare).toBeLessThan(WINDOW_BUSY_SHARE);
    expect(c.WindowCpuShare).toBeGreaterThanOrEqual(WINDOW_BUSY_SHARE);
    expect(c.LockCommittedN).toBe(2);
    expect(r.Bucket).toBeCloseTo(2 * V60, 1);
  });

  it('THE PHONE: a slow BeginFrame is NOT a slow GPU, and the classifier is what tells them apart', () => {
    // 111-127 ms between callbacks because the platform wakes the worker slowly, with a render that
    // fits easily. `ticks/frame` would say so — one tick per frame, against the M4's two — and a
    // worker cannot compute it: it has NO presentation signal. Occupancy says it instead: nothing
    // in flight at any poll and a CPU share of an eighth.
    const phone = RunSubmit({ Mode: Lock(V60), Cpu: 15, Gpu: 20, Wake: 120, Ms: 8000 });
    const c = phone.Pace.Census();
    expect(c.WindowBusyShare).toBe(0);
    expect(c.WindowCpuShare).toBeLessThan(WINDOW_BUSY_SHARE);
    expect(c.PeriodSource).toBe('unsaturated');
    // The measurement is still published — `unsaturated` means "this is a callback rate", not
    // "nothing was measured".
    expect(c.PeriodMs).toBe(0);
    expect(c.UngatedGapMs).toBeCloseTo(120, 0);
    expect(c.LockCommittedN).toBe(1);
    expect(phone.Pace.Skipped).toBe(0);
    expect(phone.Pace.Forced).toBe(0);
  });

  it('a render that FITS one vsync holds N=1 — the lock is not the clamp', () => {
    const fast = RunSubmit({ Mode: Lock(V60), Cpu: 3, Gpu: 8, Ms: 3000 });
    expect(fast.Pace.LockCommittedN).toBe(1);
    expect(fast.Period).toBeCloseTo(V60, 1);
    expect(fast.Pace.Census().FenceSkipped).toBe(0);
  });

  it('N STEPS UP when the scene gets more expensive — through a WINDOW, never off a fence reading', () => {
    // The fence is allowed to say "something changed"; it is never allowed to say by how much. A
    // scene that doubles in cost starts refusing, a burst of refusals opens a window, and the
    // window measures the new period and moves N.
    const pace = new TickPace(Lock(V60));
    const pipe = new Pipeline(0.6, 25);
    let t = 0;
    const EPS = 1e-9;
    const nextWake = (x: number): number => Math.ceil((x + EPS) / V60) * V60;
    const step = (gpu: number, ms: number): void => {
      pipe.Cost = gpu;
      const until = t + ms;
      while (t < until) {
        pipe.Now = t;
        pace.NoteTick(t);
        const d = pace.Decide(pipe, t);
        if (d !== 'skip') { pipe.Render(); pace.NoteRenderCost(pipe.Cpu); }
        let c = nextWake(d !== 'skip' ? t + pipe.Cpu : t);
        let guard = 0;
        while (guard++ < 4096) {
          let unacked = 0;
          for (const f of pipe.Frames) if (f.End > c) unacked++;
          if (unacked < 5) break;
          c = nextWake(c);
        }
        t = c;
      }
    };
    step(25, 2000);
    expect(pace.LockCommittedN).toBe(2);
    const windowsBefore = pace.Windows;
    step(60, 4000);
    expect(pace.LockCommittedN).toBeGreaterThanOrEqual(4);
    // It went up through an observation window, which is the only path there is.
    expect(pace.Windows).toBeGreaterThan(windowsBefore);
    expect(pace.Census().PeriodSource).toMatch(/warmup|window/);
    expect(pace.Forced).toBe(0);
  });

  it('N COMES BACK DOWN, and a re-observation window is the only thing that can bring it down', () => {
    const pace = new TickPace(Lock(V60));
    const pipe = new Pipeline(0.6, 60);
    let t = 0;
    const EPS = 1e-9;
    const nextWake = (x: number): number => Math.ceil((x + EPS) / V60) * V60;
    const step = (gpu: number, ms: number): void => {
      pipe.Cost = gpu;
      const until = t + ms;
      while (t < until) {
        pipe.Now = t;
        pace.NoteTick(t);
        const d = pace.Decide(pipe, t);
        if (d !== 'skip') { pipe.Render(); pace.NoteRenderCost(pipe.Cpu); }
        let c = nextWake(d !== 'skip' ? t + pipe.Cpu : t);
        let guard = 0;
        while (guard++ < 4096) {
          let unacked = 0;
          for (const f of pipe.Frames) if (f.End > c) unacked++;
          if (unacked < 5) break;
          c = nextWake(c);
        }
        t = c;
      }
    };
    step(60, 2000);
    const high = pace.LockCommittedN;
    expect(high).toBeGreaterThanOrEqual(4);
    // Now it gets cheap. Nothing refuses any more, so nothing but the DWELL can find out — which is
    // the honest cost of the mechanism and why the dwell is seconds and not minutes at the base.
    step(8, WINDOW_DWELL_MS + 3000);
    expect(pace.LockCommittedN).toBe(1);
    expect(pace.Windows).toBeGreaterThanOrEqual(2);
  });

  it('THE DWELL DOUBLES while the answer holds, so a settled page stops being interrupted', () => {
    // A window is ~500-700 ms at the unflagged cadence. On a page that keeps giving the same answer
    // it has to become rare, or the mechanism costs more than it saves.
    const r = RunSubmit({ ...M4, Mode: Lock(V60), Ms: 40000 });
    // Doubling from 8 s: windows at ~0, 8, 24, 56... so four in forty seconds, not five.
    expect(r.Pace.Windows).toBeLessThanOrEqual(4);
    expect(r.Pace.Windows).toBeGreaterThanOrEqual(2);
    // ...and the cadence never moved after the seed, which is what "the answer held" means.
    expect(r.Pace.Census().LockChanges).toBe(1);
    expect(WINDOW_DWELL_MAX_MS / WINDOW_DWELL_MS).toBeGreaterThanOrEqual(8);
  });

  it('IN A SIX-SECOND HARNESS WINDOW a settled dpr-2 page opens at most two windows', () => {
    // The prediction the orchestrator reads. Windows is cumulative from boot: the warm-up plus at
    // most one re-observation inside six seconds at the base dwell.
    const r = RunSubmit({ ...M4, Mode: Lock(V60), Ms: 6000 });
    expect(r.Pace.Windows).toBeGreaterThanOrEqual(1);
    expect(r.Pace.Windows).toBeLessThanOrEqual(2);
    expect(r.Pace.Census().LockChanges).toBe(1);
  });

  it('A WINDOW IS THE UNFLAGGED LOOP, frame for frame — that is what makes it the instrument', () => {
    // If a window were anything other than the ungated engine, the number it reads would not be the
    // one the harness reads on an unflagged arm, and the whole instrument would be a new model.
    const off = RunSubmit({ ...M4, Mode: null, Ms: 500 });
    const lock = RunSubmit({ ...M4, Mode: Lock(V60), Ms: 500 });
    // The warm-up window is still open at 500 ms at this cadence, so every release must match.
    expect(lock.Renders.length).toBeGreaterThan(WINDOW_TICKS / 2);
    expect(lock.Renders.slice(0, WINDOW_TICKS - WINDOW_WARMUP_SKIP))
      .toEqual(off.Renders.slice(0, WINDOW_TICKS - WINDOW_WARMUP_SKIP));
    expect(lock.Pace.Census().FenceSkipped).toBe(0);
    expect(lock.Pace.Forced).toBe(0);
  });

  it('=observe GATES NOTHING, and its two cadence columns must AGREE — the instrument s self-check', () => {
    // The unpaced arm with the instrument on. `UngatedGapMs` and `RenderedGapMs` are the same
    // quantity measured two ways, and under an open gate they have to come out the same. If they
    // ever do not on a real machine, the instrument is wrong and every reading under it is void.
    const obs = RunSubmit({ ...M4, Mode: { Kind: 'observe' } });
    const c = obs.Pace.Census();
    expect(obs.Pace.Skipped).toBe(0);
    expect(obs.Pace.Forced).toBe(0);
    expect(c.LockN).toBe(0);
    expect(Math.abs(c.UngatedGapMs - c.RenderedGapMs)).toBeLessThan(2);
    expect(Math.abs(c.UngatedGapMs - M4.Gpu)).toBeLessThan(V60 / 2);
    // It is the unflagged loop frame for frame, which is what makes it a control.
    const off = RunSubmit({ ...M4, Mode: null });
    expect(obs.Renders).toEqual(off.Renders);
    // ...and it still books the two present-coupled fence channels, which is what it is FOR.
    expect(c.SatGapMs).toBeGreaterThan(0);
    expect(c.RenderMs).toBeCloseTo(M4.Cpu, 1);
    expect(c.PeriodSource).toBe('gap');
  });

  it('?tick-pace=lock:live: RenderedGapMs under a HOLDING lock reads the CADENCE, not the period', () => {
    // THE PREDICTION THIS SWITCH EXISTS TO TEST, written before the M4 measures. Under the lock a
    // skipped tick submits nothing, so the queue drains and the callbacks free-run on the display
    // grid; the callback after a rendered tick is therefore the first grid point at or after either
    // the completion or the next release, whichever binds. Once the lock is holding, the release
    // binds — so the live reading is the cadence in force and the path can confirm a cadence but
    // never disprove it. The model says so; the M4 says whether the model is right.
    const live = RunSubmit({ ...M4, Mode: Lock(V60, true) });
    const c = live.Pace.Census();
    const windowed = RunSubmit({ ...M4, Mode: Lock(V60) });
    // The warm-up window seeds both arms identically — it is a window, not the live path.
    expect(windowed.Pace.Census().LockCommittedN).toBe(2);
    // ...and then the live path THROWS THAT AWAY. Under the lock a skipped tick submits nothing,
    // the queue drains, and the callback after a rendered tick is the next DISPLAY grid point:
    // 16.67, against a measured period of 25.0. The live path reads one vsync, steps down to N=1,
    // and cannot get back up, because at N=1 the reading it would need is the one it just
    // destroyed. THE MODEL REFUTES THIS PATH; the switch ships so the M4 says whether the model is
    // right about Chromium's BeginFrame throttle.
    expect(c.RenderedGapMs).toBeLessThan(M4.Gpu - 2);
    expect(c.RenderedGapMs).toBeCloseTo(V60, 0);
    expect(c.LockCommittedN).toBe(1);
    expect(c.PeriodSource).toBe('live');
    // It opens no windows after the warm-up, which is the other half of what the switch selects.
    expect(live.Pace.Windows).toBe(1);
    expect(LOCK_LIVE_HOLD).toBeGreaterThan(1);
    expect(LIVE_MIN_SAMPLES).toBeGreaterThan(1);
  });

  it('NOTHING the controller reads comes out of a fence latency — the regression test for two lanes', () => {
    // The tickpace3 and tickpace5 failures, reproduced as a stimulus: a gate whose fences report an
    // enormous latency and an enormous queued gap, and which never refuses. Both old estimators
    // would have chosen N from those. The new one must publish them, hold N=1, and choose from the
    // callback cadence — which on this fixed-grid loop is one vsync.
    const pace = new TickPace(Lock(V60));
    const liar: PaceGate = {
      PaceInFlight: () => 0,
      PaceTakeFence: () => ({ Ms: 140, GapMs: 140, Solo: true, PollGapMs: 8 }),
    };
    Loop(pace, liar, All(400));
    const c = pace.Census();
    expect(c.SoloMs).toBeGreaterThan(100);
    expect(c.LockCommittedN).toBe(1);
    expect(c.LockChanges).toBe(0);
    // The window measured the loop's own cadence, one vsync, and classified it correctly: nothing
    // was ever in flight, and the CPU cost was never reported.
    expect(c.UngatedGapMs).toBeCloseTo(V60, 1);
    expect(c.PeriodSource).toBe('unsaturated');
    expect(c.PeriodMs).toBe(0);
  });

  it('THE STALL GUARD DOES NOT COUNT LOCK REFUSALS — the gate working is not a stall', () => {
    // A 70 ms render: the lock settles on N=5 (83.35 ms) and then refuses four ticks between every
    // pair of renders. A guard that counted those would force a render every eight ticks and BECOME
    // the pacing — the one failure mode that turns this flag into a clamp nobody chose.
    const r = RunSubmit({ Mode: Lock(V60), Cpu: 10, Gpu: 70, Ms: 6000 });
    expect(r.Pace.LockCommittedN).toBeGreaterThanOrEqual(4);
    expect(r.Pace.Census().LockSkipped).toBeGreaterThan(PACE_STALL_TICKS);
    expect(r.Pace.Census().LockSkipped).toBeGreaterThan(r.Pace.Census().FenceSkipped);
    expect(r.Pace.Forced).toBe(0);
  });

  it('N is bounded — a render nobody should ship is not silently throttled to 2 fps', () => {
    const r = RunSubmit({ Mode: Lock(V60), Cpu: 20, Gpu: 400, Ms: 12000 });
    expect(r.Pace.LockCommittedN).toBeLessThanOrEqual(LOCK_MAX_N);
  });

  it('the constants agree with each other: a window is short, a dwell is long, a floor is a floor', () => {
    // A window must be cheap against its dwell, or the mechanism costs more than the cadence saves.
    expect(WINDOW_TICKS * 2 * V60).toBeLessThan(WINDOW_DWELL_MS);
    expect(WINDOW_DWELL_MAX_MS).toBeGreaterThan(WINDOW_DWELL_MS);
    expect(WINDOW_MIN_SPACING_MS).toBeLessThan(WINDOW_DWELL_MS);
    expect(WINDOW_MIN_SPACING_MS).toBeGreaterThan(LOCK_CHANGE_MS);
    expect(WINDOW_MAX_MS).toBeGreaterThan(WINDOW_TICKS * 127);
    expect(WINDOW_WARMUP_SKIP).toBeGreaterThan(0);
    expect(WINDOW_WARMUP_SKIP * 4).toBeLessThan(WINDOW_TICKS);
    expect(LOCK_MARGIN_SHARE).toBeLessThan(0.5);
    expect(WINDOW_BUSY_SHARE).toBeGreaterThan(0);
    expect(WINDOW_BUSY_SHARE).toBeLessThan(1);
  });
});

// ── The two signals Tick.Pace cannot see for itself ──

describe('?tick-pace — the park and the resize, which the engine has to declare', () => {
  it('A PARK BREAKS THE INTERVAL, and the wake that follows it is not a cadence', () => {
    // The instrument is "the callback after a rendered tick". If the loop parks, that callback is a
    // WAKE and the gap is idle time. Nothing inside `Tick.Pace` can tell those apart, so the loop
    // declares it — and an open window is abandoned, because the page stopped doing the work the
    // window was measuring.
    const pace = new TickPace(Lock(V60));
    const gapped = new TickPace(Lock(V60));
    Loop(pace, ALWAYS, All(10));
    // The same ten ticks, but the engine parked after each one.
    Loop(gapped, ALWAYS, All(10), { OnRender: () => gapped.NotePark() });
    expect(pace.Census().RenderedGapMs).toBeCloseTo(V60, 1);
    expect(gapped.Census().RenderedGapMs).toBe(0);
  });

  it('a park abandons the open window without a verdict — and the next one comes soon, not late', () => {
    const pace = new TickPace(Lock(V60));
    const marks: string[] = [];
    pace.OnWindow = phase => marks.push(phase);
    Loop(pace, ALWAYS, All(6), { OnRender: i => { if (i === 3) pace.NotePark(); } });
    expect(marks).toContain('open');
    expect(marks).toContain('abandoned');
    expect(marks).not.toContain('close');
    // Nothing was committed off a window nobody finished.
    expect(pace.Census().LockChanges).toBe(0);
    expect(pace.Census().PeriodSource).toBe('none');
  });

  it('A RESIZE is the one scene-change signal there is, and it resets the dwell', () => {
    // The walk s draw counts look like a second one and are not: `Jaui._counts` is reset only under
    // the debug HUD, so outside it those numbers accumulate across the whole run. A canvas resize
    // is exact and free. The other kind of scene change — the same canvas drawing more — reaches
    // the controller through the fence instead.
    const pace = new TickPace(Lock(V60));
    Loop(pace, ALWAYS, All(WINDOW_TICKS + 8));
    const settled = pace.Windows;
    expect(settled).toBeGreaterThanOrEqual(1);
    pace.NoteSceneChange();
    Loop(pace, ALWAYS, All(WINDOW_TICKS + 8));
    // A resize cannot open a window inside the spacing floor, and this second Loop restarts the
    // clock at 0, so the assertion is that the signal is ACCEPTED rather than that it fires now.
    expect(pace.Windows).toBeGreaterThanOrEqual(settled);
    // And on an unflagged engine both signals are no-ops rather than errors.
    const off = new TickPace(null);
    off.NotePark();
    off.NoteSceneChange();
    expect(off.Census().Windows).toBe(0);
  });
});
