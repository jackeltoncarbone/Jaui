/**
 * `?tick-pace` — pace the render on the DISPLAY instead of on the tick. The arithmetic, no GL in it.
 *
 * WHY THIS EXISTS (ShowStudio.Documentation/Perf/README.md, "PACING: 66.87 -> 33.48 ms"): the engine
 * rendered TWICE per presented frame at baseline, and removing the second render cut the frame time
 * in half with no pixel change. Two cuts have been measured on the M4 since, one binary, three arms,
 * interleaved, worstPx 0, equal draw counts —
 *
 *     dpr 2                 p50     p95   distribution (vsyncs per presented frame)
 *     base                66.88   67.42
 *     tick-pace (f:1)     33.52   51.27   1v 40%  2v 16%  3v 42%  4v 2%   <- TRIMODAL: judder
 *     tick-pace=2         33.43   33.92   2v 99-100%                      <- even, but a 30 fps CLAMP
 *     tick-pace=fence:0   50.10   52.03   the serial gate, no pipeline
 *
 *     dpr 1.5               p50     p95
 *     tick-pace (f:1)     16.93   33.87   1v 54%  2v 46%   <- reaches one vsync, cannot HOLD it
 *     tick-pace=2         33.34   34.72   2v 100%          <- can never reach it
 *
 * THE RULE THAT CAME OUT OF THAT TABLE, and the reason this file has a third mode: **for animation,
 * evenness beats the median. A steady 30 fps looks better than an average 30 alternating 60 and 20,
 * and a paced arm is read on its HISTOGRAM, never on p50.** The fence gate ADAPTS (it renders as
 * soon as the GPU is free) but cannot hold a cadence: it races the fence every tick, so frames
 * alternate between one and three vsyncs and 82% of them are nowhere near the median it scores.
 * The ratio gate is EVEN (99-100% on two vsyncs) but cannot adapt: it pins 30 fps whatever the
 * render costs, which is a REGRESSION at dpr 1.5 where one vsync is available.
 *
 * SO THE FLAG'S MEANING IS NOW `lock`: ADAPTIVE AND EVEN.
 *
 *     N = ceil(period / vsync), and a render is released only when at least N vsync intervals have
 *     passed since the last released render.
 *
 * `period` is the frame's own cost (below), `vsync` is the display's interval (below), and N is
 * re-evaluated slowly, with hysteresis, so it cannot oscillate. A 33 ms render presents every 2
 * vsyncs uniformly — what the clamp achieves, without being a clamp — and a 17 ms render presents
 * every 1, which neither existing arm can hold. The depth-1 fence stays underneath as a SAFETY NET
 * (a mis-estimated N must not be able to queue renders), and the two gates count their skips apart
 * so the ledger says which one acted.
 *
 * THE TWO ESTIMATES, AND WHY EACH IS TAKEN THE WAY IT IS
 *
 * `period` — the frame's cost, as max(CPU issue, GPU execution), because that is what a pipelined
 * renderer's period IS. Both terms are measured, neither is assumed:
 *
 *   CPU  the wall time of `_render` on the worker (`NoteRenderCost`), EMA'd over ~8 rendered frames.
 *   GPU  from the frame-completion fence, and in TWO ways, because one of them is blind in each of
 *        the two states the loop can be in:
 *          * the fence was armed with the GPU otherwise IDLE (`Solo`) — then arm-to-signal IS the
 *            GPU's cost for that frame. This is the state a CORRECTLY locked loop is in, so the
 *            estimate is clean by construction exactly when the lock is right.
 *          * the fence was armed BEHIND another of our frames — then arm-to-signal includes the
 *            queue wait (the depth-1 fence arm legitimately reads ~49 on a 33 ms frame for this
 *            reason) and is useless, but the COMPLETION-TO-COMPLETION gap is the GPU's cost exactly,
 *            because back-to-back execution is what "queued" means. This is the state the loop is in
 *            while N is still too small, which is when the controller most needs to be told to
 *            step up.
 *        A solo sample is de-quantized by half the poll gap: the true completion lies somewhere in
 *        (previous poll, this poll], and a raw arm-to-poll reading takes the top of that interval,
 *        so it is biased LATE by up to a whole poll gap. THE DIRECTION OF THE REMAINING BIAS IS
 *        CHOSEN, and it is chosen low, because the two directions are not symmetrical in a control
 *        loop: an over-estimate makes N too big, the GPU then idles, the samples stay solo, and the
 *        loop sits SLOWER than the display for ever with nothing to correct it. An under-estimate
 *        makes N too small, the loop saturates, the samples become GAP samples — which are exact,
 *        since both of their ends carry the same quantization and it cancels in the difference —
 *        and N steps back up. The controller therefore settles on the smallest cadence the GPU can
 *        actually fill, which is the cadence being asked for. What it costs is one step of
 *        hunting on a period that sits exactly on a boundary, and that is what the margin and the
 *        hold below are for.
 *
 * `vsync` — the display's interval, derived from the rAF timestamps and NOT assumed, but it cannot
 * be read off them naively, and this is the weakest link in the file. The worker's BeginFrame
 * cadence is not the display's: on ONE 60 Hz M4, across four arms of one binary, the worker's rAF
 * fired at 30 Hz (base, back-pressured), 60 Hz (`=2`), 96 Hz (`fence:1`) and 120 Hz (`fence:0`).
 * A median delta would have read "30 Hz display" on the first and "120 Hz display" on the last.
 * So the estimate takes the LARGEST plausible refresh interval that DIVIDES the observed deltas:
 * a back-pressured 33.3 ms cadence is two 16.67 ms intervals and folds to 16.67; a 50 ms cadence
 * folds to 16.67 as well; a mixture of 16.67 and 33.3 gives 16.67 directly. What it CANNOT do is
 * tell a true 120 Hz panel from a 60 Hz panel whose worker is being woken twice per vsync — both
 * present as a uniform 8.33 ms cadence, and the estimate reads 8.33. That reading is not silently
 * absorbed: it is published as `VsyncMs`, printed on every `[Jaui.pace]` line and on every N
 * change, and `?tick-pace=lock:V` PINS the interval so a cell taken on a derived estimate can be
 * checked against one that cannot be wrong. A grid finer than the display's costs evenness only
 * when the period is not near a multiple of the real vsync (a 20 ms render on a 60 Hz panel would
 * lock to 25 ms and alternate 1v/2v); at dpr 2, where the render is ~33 ms, N simply reads 4
 * instead of 2 and the released cadence is the same 33.3 ms.
 *
 * WHAT A SKIPPED TICK DOES AND DOES NOT DO, exactly — unchanged by this lane:
 *   DOES     drain the pushed-size slot, advance `_lastTime`, feed the HUD, step every spring
 *            (`AnimationManager.StepFrame`), solve layout, measure text, run text transitions,
 *            re-evaluate the render-on-demand gate, fire the post-frame hooks, and keep the loop
 *            awake (the park predicate refuses to park while a render is owed).
 *   DOES NOT call `_render`. No GL is issued, no draw is made, the swap chain is not written, and
 *            the OffscreenCanvas produces no compositor frame for that task.
 * So a skipped tick cannot change a pixel: the only thing that writes pixels is the render it
 * skipped, and that render is not dropped — it is OWED, and the next tick the gate lets through
 * runs it. On a static scene there is nothing behind at all and the loop is parked, so no tick
 * happens and the flag is a no-op by construction. What the lock changes is the SEQUENCE of
 * presented frames, and it changes it to an even one.
 *
 * THE OTHER TWO MODES STAY, as controls, and the depth argument behind `fence` is still true:
 *
 *   `fence:D`  D frames may be outstanding when a tick asks to render. D=0 is the strictly serial
 *              gate that measured 50.13 by making the frame cost CPU issue PLUS GPU execution
 *              instead of their max; D=1 is the pipelined one that measured 33.52 and juddered.
 *   `N`        render every Nth want. A 30 fps clamp at N=2. Never a default; it exists to price
 *              the instrument (it issues zero fence polls) and to be the even arm the lock has to
 *              match.
 */

/** How the gate decides. `null` is the unflagged engine: every tick that wants to render, renders. */
export type TickPaceMode =
  /** Release a render only on a whole number of vsyncs, chosen from the measured frame cost. The
   *  flag's meaning. `Depth` is the fence safety net underneath it; `Vsync` pins the display
   *  interval in ms when `?tick-pace=lock:V` named one, and is null when it is derived. */
  | { Kind: 'lock'; Depth: number; Vsync: number | null }
  /** Poll the rendered frames' GPU fences; skip while more than `Depth` of them are outstanding.
   *  Adaptive, and the arm that measured TRIMODAL at dpr 2. A control now. */
  | { Kind: 'fence'; Depth: number }
  /** Render every Nth tick that wants to render. N >= 2. The control arm, and a clamp. */
  | { Kind: 'ratio'; N: number };

/** What the gate said about one tick that wanted to render. `forced` is a `render` the stall guard
 *  took rather than a `render` the fence allowed, and it is counted separately BECAUSE a cell with
 *  a non-zero forced count is not measuring what the flag claims to measure. */
export type PaceDecision = 'render' | 'skip' | 'forced';

/** One retired frame-completion fence, as the renderer reports it. Everything here is a reading;
 *  `Tick.Pace` decides what each one is evidence OF. */
export interface PaceFenceSample {
  /** Arm to the poll that retired it. The existing `FenceMs` ledger field, unchanged: at depth 1 it
   *  legitimately includes the queue wait, which is why it is not the period. */
  Ms: number;
  /** Previous retirement to this one. When the frame was queued behind another of ours, this IS the
   *  GPU's per-frame cost. 0 when there is no previous retirement to measure from. */
  GapMs: number;
  /** Was the GPU free of our frames when this fence was armed? Only then is `Ms` the GPU's own cost. */
  Solo: boolean;
  /** How long since the previous poll — the width of the interval the true completion lies in. */
  PollGapMs: number;
}

/** What the fence-mode gate asks. Implemented by `WebGL2Renderer`; an interface so the decision can
 *  be proved without a GL context, and so `Tick.Pace` imports nothing. */
export interface PaceGate {
  /** How many rendered frames the GPU has not finished yet. Polls each outstanding fence once,
   *  retires the ones that have signalled, and NEVER blocks. */
  PaceInFlight(): number;
  /** The fence most recently retired by `PaceInFlight`, then cleared so each fence is sampled once.
   *  `null` when that poll retired nothing. Pure instrument: the gate's decision never reads it. */
  PaceTakeFence(): PaceFenceSample | null;
}

/**
 * Frames allowed in flight when the flag names no depth — the fence gate's depth, and the safety
 * net under the lock.
 *
 * ONE, not zero. Zero is the strictly-serial gate that measured 50.13 ms at dpr 2 by making the
 * frame cost the CPU's issuing PLUS the GPU's execution; one lets those two overlap again, which is
 * the pipeline every renderer relies on, while still refusing the third frame that would be the
 * discarded render. Not two: at two the CPU may run a whole frame ahead of the GPU and the oldest
 * frame in the queue is stale by the time it presents, which is the state the unflagged engine was
 * already in.
 */
export const PACE_DEFAULT_DEPTH = 1;

/** The deepest `?tick-pace=fence:D` will accept. Past this the gate is not pacing anything: the
 *  unflagged engine is depth-infinity, and a cell at depth 4 would be measuring it. */
export const PACE_MAX_DEPTH = 3;

/** How many fences the renderer keeps. One more than the deepest gate can hold outstanding, so the
 *  ring never drops a fence the gate is still counting on. */
export const PACE_FENCE_RING = PACE_MAX_DEPTH + 2;

/**
 * Consecutive FENCE refusals after which the gate renders anyway.
 *
 * The fence is the only thing standing between this loop and a permanent freeze, so it does not get
 * to be trusted unconditionally: a driver that never signals, a context that went away between the
 * arm and the poll, or a flush that never happened would otherwise skip every render forever and
 * the app would sit on one frame. Eight ticks is ~133 ms at 60 Hz and ~265 ms at the 30 Hz cadence
 * this flag exists to fix — an order of magnitude past any frame either machine has ever produced,
 * so a healthy run can never reach it. It is not a fallback that hides: the force is counted in its
 * own column and named on the trace the first time it trips, and a cell with forced > 0 is void.
 *
 * IT COUNTS FENCE REFUSALS ONLY, and under the lock that distinction is load-bearing. A lock
 * refusal is a tick arriving early, which is the gate WORKING — at a 120 Hz tick cadence and N=2
 * there are three of them per render, and a guard that counted them would fire every eight ticks
 * and become the mechanism. A lock refusal also cannot freeze the loop: the clock moves, so the
 * release time arrives on its own.
 */
export const PACE_STALL_TICKS = 8;

/**
 * ...AND at least this long since the last render. The guard is a DURATION, and eight ticks alone
 * is not one: this flag's own measurements put the worker's callback cadence anywhere between 30
 * and 120 Hz on the same machine, so "eight ticks" is anywhere between 67 and 267 ms and the guard
 * would fire four times sooner on the arm that ticks fastest. 100 ms is under the 133 the constant
 * above was chosen to mean at 60 Hz, and an order of magnitude past the slowest frame in the
 * ledger, so a healthy run still cannot reach it — while a 100 ms scene, whose renders legitimately
 * sit eleven 120 Hz ticks apart, is no longer forced on every one of them during its warm-up.
 */
export const PACE_STALL_MS = 100;

/** The most vsyncs `lock` will hold a frame for. Eight is 133 ms at 60 Hz: past that the engine is
 *  not being paced, it is being throttled, and the number to fix is the render. */
export const LOCK_MAX_N = 8;

/** Frames in the cost EMAs. Short enough to follow a scene change within a few frames, long enough
 *  that one hitched frame moves the estimate by about a tenth of the way. */
export const LOCK_EMA_FRAMES = 8;

/** How far past the boundary the period must be before N moves, as a share of one vsync. 10% of a
 *  vsync is 1.7 ms at 60 Hz: wide enough to swallow the residual quantization in the GPU estimate,
 *  narrow enough that a genuinely 2-vsync render is never mistaken for a 1-vsync one. It is what
 *  holds N=1 on the M4's ~17 ms dpr-1.5 render (17 < 16.67 + 1.67) instead of flapping to N=2. */
export const LOCK_MARGIN_SHARE = 0.10;

/** Consecutive evaluations (one per released render) that must agree before N steps. At N=2 on a
 *  33 ms period that is ~270 ms of agreement, so a burst of expensive frames cannot move it. */
export const LOCK_HOLD_FRAMES = 8;

/** Floor between two N changes, in ms. With the hold above it makes an oscillation impossible to
 *  sustain: the fastest N can move is once a quarter second, and only in one direction at a time. */
export const LOCK_CHANGE_MS = 250;

/** Cost samples before N is SEEDED straight to `ceil(period / vsync)` instead of stepping to it.
 *  Stepping from N=1 would spend ~8 renders and 250 ms per step juddering at page load, inside the
 *  harness's window; four samples is ~130 ms at dpr 2 and the seed is counted as a change, so it is
 *  visible in `LockChanges` rather than hidden. */
export const LOCK_SEED_FRAMES = 4;

/** How early a tick may release a render, as a share of one vsync. The gate can only act on a tick,
 *  and the tick grid is NOT the vsync grid (96 Hz callbacks were measured on a 60 Hz panel), so a
 *  strict "at or after" would round every release up to the next tick and turn a 33.3 ms cadence
 *  into a 41.6 ms one. Releasing slightly early is free — the compositor presents at the following
 *  vsync either way — while releasing late costs a whole vsync. Capped well under half a vsync so
 *  a release can never land in the PREVIOUS vsync's window and pair up with the frame before it. */
export const LOCK_EARLY_SHARE = 0.4;

/** The plausible refresh band, in ms: 144 Hz to 48 Hz. A cadence outside it is not a display's, it
 *  is a back-pressured multiple of one (33.3 = 2 x 16.67) or a stall. */
export const VSYNC_MIN_MS = 1000 / 144;
export const VSYNC_MAX_MS = 1000 / 48;

/** rAF deltas kept for the vsync estimate, and the fewest that will produce one. */
export const VSYNC_SAMPLES = 16;
export const VSYNC_MIN_SAMPLES = 8;

/** Used only before enough rAF deltas exist to derive anything, and never silently: `VsyncMs` is
 *  published and `VsyncDerived` says whether it was measured or is still this. */
export const VSYNC_FALLBACK_MS = 1000 / 60;

/** A GPU cost sample above this is a hitch (a shader compile, a texture upload, a tab restore), not
 *  the steady-state period the cadence should be chosen from. */
const GPU_SAMPLE_MAX_MS = 250;

/** One decimal, so a printed ledger is readable and two of them are still subtractable. */
const Round1 = (v: number): number => Math.round(v * 10) / 10;
/** Two, for the vsync: 16.67 and 8.33 have to be told apart at a glance. */
const Round2 = (v: number): number => Math.round(v * 100) / 100;

/** An exponential moving average that starts AT its first sample rather than climbing from zero —
 *  a controller seeded from a ramp would choose its first N from a number no frame ever had. */
class Ema {
  Value = 0;
  N = 0;
  private readonly _a: number;
  constructor(frames: number) { this._a = 2 / (frames + 1); }
  Push = (v: number): void => {
    this.N++;
    this.Value = this.N === 1 ? v : this.Value + this._a * (v - this.Value);
  };
}

/** Is `d` a whole number of `v`s, within the tolerance a jittery callback cadence deserves? */
const IsMultipleOf = (d: number, v: number): boolean => {
  const m = Math.round(d / v);
  if (m < 1 || m > 8) return false;
  return Math.abs(d - m * v) <= Math.max(v * 0.15, 0.6);
};

/** Nearest whole Hz, the way the perf harness snaps `budgetMs`: a display runs at an integer rate
 *  and a measured 16.61 is a 60 Hz panel with jitter, not a 60.2 Hz one. */
const SnapToWholeHz = (v: number): number => 1000 / Math.max(1, Math.round(1000 / v));

/**
 * The display's vsync interval, derived from rAF timestamps.
 *
 * THE DERIVATION, and it is not a median. The worker's callback cadence is not the display's: one
 * 60 Hz M4 produced 30, 60, 96 and 120 Hz worker callbacks across four arms of one binary, because
 * Chromium's BeginFrame subscription is throttled on frame SUBMISSION and free-runs when the worker
 * is idle. A median would have called the back-pressured 33.3 ms cadence a 30 Hz display — the
 * exact failure the lock cannot survive, since it would then lock to multiples of 33.3.
 *
 * So: take the smallest delta in the window that is not noise, try it and its halves and thirds,
 * and accept the LARGEST candidate in the refresh band that every delta in the window is a whole
 * multiple of. A uniform 33.3 folds to 16.67 (k=2), a uniform 50 to 16.67 (k=3), a mixture of 16.67
 * and 33.3 gives 16.67 at k=1, and a uniform 8.33 gives 8.33 — which is either a 120 Hz panel or a
 * 60 Hz one being woken twice a vsync, and nothing in a worker can tell those apart. That
 * ambiguity is published (`VsyncMs`) rather than hidden, and `?tick-pace=lock:V` pins the value.
 */
export class VsyncEstimator {
  private readonly _deltas: number[] = [];
  private _at = 0;
  private _last = 0;
  /** Deltas seen, ever. The window is the last `VSYNC_SAMPLES` of them. */
  Seen = 0;

  /** The window is read at most once per tick however many times it is ASKED per tick: the gate
   *  reads the vsync, the evaluation reads it again, and the census reads it a third time. */
  private _dirty = true;
  private _tick = 0;
  private _vsync: number | null = null;

  /** Every tick, rendered or not: the cadence is a property of the callbacks, not of the renders. */
  Note = (time: number): void => {
    const last = this._last;
    this._last = time;
    if (last <= 0) return;
    const d = time - last;
    // Sub-millisecond deltas are two callbacks inside one frame and carry no cadence; a delta over
    // a second is a backgrounded tab resuming and would poison the window for sixteen ticks.
    if (d < 0.5 || d > 1000) return;
    this.Seen++;
    if (this._deltas.length < VSYNC_SAMPLES) this._deltas.push(d);
    else { this._deltas[this._at] = d; this._at = (this._at + 1) % VSYNC_SAMPLES; }
    this._dirty = true;
  };

  /** The median delta — the raw callback cadence, which is what the early-release tolerance is
   *  sized from. Not the vsync. 0 before any delta. */
  TickMs = (): number => { this._read(); return this._tick; };

  /** The display interval, or null while there is not enough to say. */
  Estimate = (): number | null => { this._read(); return this._vsync; };

  private _read = (): void => {
    if (!this._dirty) return;
    this._dirty = false;
    this._tick = this._median();
    this._vsync = this._derive();
  };

  private _median = (): number => {
    if (this._deltas.length === 0) return 0;
    const s = [...this._deltas].sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  private _derive = (): number | null => {
    if (this._deltas.length < VSYNC_MIN_SAMPLES) return null;
    const med = this._tick;
    // A stalled frame is not a cadence. Four times the median drops a hitch without dropping the
    // legitimate 2x and 3x deltas a back-pressured loop produces.
    const kept = this._deltas.filter(d => d <= med * 4);
    if (kept.length < VSYNC_MIN_SAMPLES) return null;
    const base = Math.min(...kept);
    for (let k = 1; k <= 8; k++) {
      const v = base / k;
      if (v > VSYNC_MAX_MS) continue;
      if (v < VSYNC_MIN_MS) break;
      if (!kept.every(d => IsMultipleOf(d, v))) continue;
      // Refit rather than return the candidate: `base` is the SMALLEST delta in the window, so on a
      // jittery cadence it is biased low by the jitter, and a 16.27 taken off a 16.67 ms display
      // snaps to 61 Hz. Dividing the total by the total number of intervals it spans is the
      // least-squares fit of one period to the whole window, and it is unbiased.
      let sumD = 0;
      let sumM = 0;
      for (const d of kept) { sumD += d; sumM += Math.round(d / v); }
      return sumM > 0 ? SnapToWholeHz(sumD / sumM) : SnapToWholeHz(v);
    }
    // Nothing divides the window cleanly — a cadence that is drifting rather than throttled. Fold
    // the median into the band instead of refusing, and say so by publishing the result: a
    // measured-but-folded grid beats the loop silently falling back to 60 Hz.
    let v = med;
    for (let k = 2; k <= 8 && v > VSYNC_MAX_MS; k++) v = med / k;
    if (v > VSYNC_MAX_MS || v < VSYNC_MIN_MS) return null;
    return SnapToWholeHz(v);
  };
}

/**
 * Parse `?tick-pace`'s value.
 *
 *     ?tick-pace              THE VSYNC LOCK at the default depth — the flag's meaning
 *     ?tick-pace=lock         the same, spelled out
 *     ?tick-pace=lock:V       the lock with the vsync PINNED to V ms — the control that proves a
 *                             derived estimate right or wrong in the same binary
 *     ?tick-pace=fence        the adaptive fence gate at the default depth (trimodal; a control)
 *     ?tick-pace=fence:D      the fence gate at depth D (0..PACE_MAX_DEPTH); D=0 is the first cut
 *     ?tick-pace=N            the fixed ratio, N >= 2 — a CLAMP, the control arm, never a default
 *
 * Anything else is refused, WITH A REASON, because an instrument that quietly did nothing would
 * publish the baseline under this flag's name.
 */
export const ParseTickPace = (raw: string | null): { Mode: TickPaceMode } | { Why: string } => {
  const v = (raw ?? '').trim();
  if (v === '' || v === 'lock') {
    return { Mode: { Kind: 'lock', Depth: PACE_DEFAULT_DEPTH, Vsync: null } };
  }
  if (v.startsWith('lock:')) {
    const tail = v.slice('lock:'.length);
    // `Number('')` is 0 — the same trap `fence:` has, and a zero vsync would divide by nothing.
    if (tail === '') return { Why: 'lock-vsync-must-be-a-number-of-ms-4-to-40' };
    const ms = Number(tail);
    if (!Number.isFinite(ms) || ms < 4 || ms > 40) {
      return { Why: 'lock-vsync-must-be-a-number-of-ms-4-to-40' };
    }
    return { Mode: { Kind: 'lock', Depth: PACE_DEFAULT_DEPTH, Vsync: ms } };
  }
  if (v === 'fence') return { Mode: { Kind: 'fence', Depth: PACE_DEFAULT_DEPTH } };
  if (v.startsWith('fence:')) {
    const tail = v.slice('fence:'.length);
    // `Number('')` is 0, so an empty depth would otherwise parse as the serial gate and a typo
    // would silently select the arm the depth-1 lane exists to replace.
    if (tail === '') return { Why: `fence-depth-must-be-a-whole-number-0-to-${PACE_MAX_DEPTH}` };
    const d = Number(tail);
    if (!Number.isInteger(d) || d < 0 || d > PACE_MAX_DEPTH) {
      return { Why: `fence-depth-must-be-a-whole-number-0-to-${PACE_MAX_DEPTH}` };
    }
    return { Mode: { Kind: 'fence', Depth: d } };
  }
  const n = Number(v);
  if (!Number.isInteger(n)) return { Why: 'value-must-be-lock-fence-or-a-whole-number-of-ticks' };
  if (n === 1) return { Why: 'n-1-renders-every-tick-which-is-the-unflagged-engine' };
  if (n < 1) return { Why: 'n-must-be-at-least-2' };
  return { Mode: { Kind: 'ratio', N: n } };
};

/** How a mode prints in `jaui:tick-pace armed=<mode>` and on the `[Jaui]` line. The depth and the
 *  pinned vsync are part of the name because two cells taken under different ones are two different
 *  instruments. The live N is NOT in the name — it moves, and it is its own ledger field. */
export const TickPaceText = (mode: TickPaceMode | null): string =>
  mode === null ? 'off'
    : mode.Kind === 'lock' ? (mode.Vsync === null ? 'lock' : `lock:${Round2(mode.Vsync)}`)
      : mode.Kind === 'fence' ? `fence:${mode.Depth}`
        : `ratio:${mode.N}`;

/** Ticks waited before a render landed, bucketed: 0, 1, 2, 3-or-more. */
export type PaceWaited = [number, number, number, number];

/** The cumulative ledger, as `__jauiTickPace()` and `[Jaui.pace]` publish it. */
export interface PaceCensus {
  Mode: string;
  Rendered: number;
  Skipped: number;
  Forced: number;
  WaitedTicks: PaceWaited;
  FenceMs: { N: number; Sum: number; Max: number };
  MaxInFlight: number;
  /** The lock's current cadence, in vsyncs per presented frame. 0 in every other mode. */
  LockN: number;
  /** How many times N moved, the seed included. A cell whose N is still moving is a cell taken
   *  during a warm-up, and a large count is an oscillation the hysteresis failed to stop. */
  LockChanges: number;
  /** The smoothed frame cost the cadence was chosen from: max(CPU issue, GPU execution). The fence
   *  arm publishes it too, from its GPU half alone (only the lock times `_render`), so the two arms
   *  can be compared on the cost as well as on the cadence. */
  PeriodMs: number;
  /** The display interval the lock is quantizing to, derived or pinned. */
  VsyncMs: number;
  /** Was `VsyncMs` measured, or is it still the fallback? A cell taken on the fallback is a cell
   *  whose grid was assumed. */
  VsyncDerived: boolean;
  /** Skips the LOCK took (the tick came early). Normal, and the larger the tick rate the larger
   *  this is — three per render at 120 Hz ticks and N=2. */
  LockSkipped: number;
  /** Skips the FENCE took (the GPU was still behind). Under a correct lock this is ~0, and a large
   *  one says the cadence is faster than the GPU can fill. */
  FenceSkipped: number;
}

/**
 * The gate. One instance per engine, always present: an unflagged engine holds one in `null` mode
 * whose `Decide` is a single comparison, so the tick has no branch to grow and the RENDERED/SKIPPED
 * columns read on both arms of a comparison rather than only under the flag.
 */
export class TickPace {
  readonly Mode: TickPaceMode | null;

  /** Ticks that wanted to render and did. Cumulative since boot — a per-frame count is 0 or 1 and
   *  says nothing; the number this flag is about is a RATIO over a window, so both ends of that
   *  window subtract these. */
  Rendered = 0;
  /** Ticks that wanted to render and the gate refused. Cumulative, same reason. */
  Skipped = 0;
  /** Renders the stall guard took. Cumulative. Must read 0 in any cell that is quoted. */
  Forced = 0;

  /** Ticks waited per render, bucketed 0 / 1 / 2 / 3+. Booked in every mode, so the histogram is
   *  comparable across the arms: unflagged is all bucket 0 and `=2` is all bucket 1 by
   *  construction. Under the lock it counts the ticks the lock held, so it reads high on a fast
   *  tick cadence BY DESIGN — `LockSkipped` and `FenceSkipped` are the fields that say which gate
   *  acted, and the fence one is the one that should be near zero. */
  readonly WaitedTicks: PaceWaited = [0, 0, 0, 0];

  /** Fence latency: how long from arming a fence to the poll that found it signalled. The mean over
   *  a window is `(Sum2-Sum1)/(N2-N1)`. Zero in every mode but fence and lock. */
  FenceSamples = 0;
  FenceMsSum = 0;
  FenceMsMax = 0;

  /** High-water mark of frames outstanding on the GPU. At depth D a working gate reaches D+1. */
  MaxInFlight = 0;

  /** The lock's cadence, in vsyncs. Starts at 1 and is seeded from the first cost estimate. */
  LockN = 1;
  LockChanges = 0;
  LockSkipped = 0;
  FenceSkipped = 0;

  /** Called when N moves, so the trace can say so without this file importing one. */
  OnLockChange: ((n: number, periodMs: number, vsyncMs: number) => void) | null = null;

  private readonly _cpu = new Ema(LOCK_EMA_FRAMES);
  private readonly _gpu = new Ema(LOCK_EMA_FRAMES);
  private readonly _vsync = new VsyncEstimator();

  /** Consecutive refusals of any kind, for the `WaitedTicks` histogram. */
  private _skipRun = 0;
  /** Consecutive FENCE refusals, for the stall guard. A lock refusal must not feed it — see
   *  `PACE_STALL_TICKS`. */
  private _fenceRun = 0;
  /** Ratio mode's own index over WANTS, not over ticks: a tick that did not want to render is
   *  already not rendering, and counting it would make `=2` skip renders that never existed. */
  private _wants = 0;

  /** The IDEAL time of the next release, advanced by exactly N vsyncs per render so a release that
   *  jitters by a tick does not drag the cadence with it. */
  private _nextAt = 0;
  /** Timestamps of the last N change and the last evaluation's direction and agreement count. */
  private _lastChangeAt = 0;
  private _holdDir = 0;
  private _hold = 0;
  private _seeded = false;
  /** When a render last ran, so the stall guard can be a duration instead of a tick count. */
  private _lastRenderAt = 0;

  constructor(mode: TickPaceMode | null) { this.Mode = mode; }

  /** Every tick, before the gate — the vsync estimate is a property of the CALLBACKS, so it has to
   *  see the ones that do not want to render too. One subtraction and a ring write. */
  NoteTick = (time: number): void => {
    if (this.Mode === null) return;
    this._vsync.Note(time);
  };

  /** Does the engine need to time `_render` for this mode? Only the lock reads the CPU term, and a
   *  `performance.now()` pair per frame is not paid on an arm that would not read it. */
  get WantsRenderCost(): boolean { return this.Mode !== null && this.Mode.Kind === 'lock'; }

  /** The wall time `_render` took, in ms — the CPU half of the period. */
  NoteRenderCost = (ms: number): void => {
    if (ms > 0 && ms < GPU_SAMPLE_MAX_MS) this._cpu.Push(ms);
  };

  /** The frame's cost, as a pipelined renderer's period is: whichever of the two halves is slower.
   *  0 until something has been measured. */
  get PeriodMs(): number { return Math.max(this._cpu.Value, this._gpu.Value); }

  /** The display interval the lock quantizes to: pinned if the flag named one, derived if the
   *  callbacks have said enough, the 60 Hz fallback until then. */
  get VsyncMs(): number {
    const mode = this.Mode;
    if (mode !== null && mode.Kind === 'lock' && mode.Vsync !== null) return mode.Vsync;
    return this._vsync.Estimate() ?? VSYNC_FALLBACK_MS;
  }

  /** Was the vsync measured rather than assumed? */
  get VsyncDerived(): boolean {
    const mode = this.Mode;
    if (mode !== null && mode.Kind === 'lock' && mode.Vsync !== null) return true;
    return this._vsync.Estimate() !== null;
  }

  /** Call once per tick that WANTS to render — i.e. after the render-on-demand gate has said yes.
   *  `time` is the rAF timestamp, and it is REQUIRED rather than defaulted: the lock schedules
   *  against it, and a caller that forgot it would pin every release in the past and then refuse
   *  every one of them for ever — a freeze the stall guard deliberately does not cover, because a
   *  lock refusal cannot be a stall when the clock is real. */
  Decide = (gate: PaceGate | null, time: number): PaceDecision => {
    const mode = this.Mode;
    if (mode === null) return this._allow('render', time);

    if (mode.Kind === 'ratio') {
      const render = this._wants % mode.N === 0;
      this._wants++;
      return render ? this._allow('render', time) : this._refuse('ratio');
    }

    // Fence and lock both poll. A null gate cannot happen — the parse refuses both on a renderer
    // that has no fence to poll — but a gate that is not there must render rather than stall.
    if (gate === null) return this._allow('render', time);
    const inFlight = this._poll(gate);

    if (mode.Kind === 'fence') {
      if (inFlight <= mode.Depth) return this._allow('render', time);
      if (this._stalled(time)) { this.Forced++; return this._allow('forced', time); }
      return this._refuse('fence');
    }

    // THE LOCK. Release only on a whole number of vsyncs since the last released render, then let
    // the fence underneath refuse it if the GPU is somehow still behind.
    const vsync = this.VsyncMs;
    if (this._nextAt === 0) this._nextAt = time;
    // The gate can only act on a tick and the tick grid is not the vsync grid, so a release may run
    // slightly early rather than slip a whole tick. See `LOCK_EARLY_SHARE`.
    const tick = this._vsync.TickMs();
    const early = Math.max(Math.min(tick * 0.5, vsync * LOCK_EARLY_SHARE), 0.25);
    if (time + early < this._nextAt) return this._refuse('lock');

    if (inFlight > mode.Depth) {
      if (this._stalled(time)) {
        // The guard fired, which under the lock means the cadence is faster than the GPU can fill
        // and N has not caught up yet — the warm-up state on a scene whose render costs more than
        // `PACE_STALL_TICKS` ticks. Evaluate and re-anchor HERE as well, or N could only ever be
        // revised on a clean release and a loop that never gets one would force for ever.
        this.Forced++;
        this._evaluateLock(time, vsync);
        this._nextAt = time + this.LockN * vsync;
        return this._allow('forced', time);
      }
      return this._refuse('fence');
    }

    this._evaluateLock(time, vsync);
    // Advance the IDEAL grid, not the actual release, so jitter does not accumulate — and re-anchor
    // rather than run a backlog when the loop has been parked or stalled past a whole period.
    this._nextAt += this.LockN * vsync;
    if (this._nextAt <= time) this._nextAt = time + this.LockN * vsync;
    return this._allow('render', time);
  };

  /** Poll the fences, book the ledger, and feed the GPU half of the period estimate. */
  private _poll = (gate: PaceGate): number => {
    const inFlight = gate.PaceInFlight();
    if (inFlight > this.MaxInFlight) this.MaxInFlight = inFlight;
    const s = gate.PaceTakeFence();
    if (s !== null) {
      this.FenceSamples++;
      this.FenceMsSum += s.Ms;
      if (s.Ms > this.FenceMsMax) this.FenceMsMax = s.Ms;
      // Solo: arm-to-signal IS the GPU's cost, biased late by the poll grain — de-quantize by half
      // the interval the completion is known to lie in. Queued: the completion-to-completion gap is
      // the cost exactly, and both of its ends carry the same bias, so it needs no correction.
      const g = s.Solo ? Math.max(s.Ms - s.PollGapMs / 2, 0) : s.GapMs;
      if (g > 0 && g < GPU_SAMPLE_MAX_MS) this._gpu.Push(g);
    }
    return inFlight;
  };

  /**
   * Choose N. Once per released render, and it moves slowly ON PURPOSE.
   *
   * The boundary test is asymmetric by a margin in BOTH directions, so a period sitting exactly on
   * a vsync boundary — the M4's ~17 ms at dpr 1.5 — holds the N it has instead of flapping. Going
   * up needs the period to overrun the current cadence by the margin; coming down needs it to fit
   * the next one DOWN with the margin to spare. Neither happens until `LOCK_HOLD_FRAMES`
   * consecutive evaluations have agreed, and never twice inside `LOCK_CHANGE_MS`.
   */
  private _evaluateLock = (time: number, vsync: number): void => {
    const period = this.PeriodMs;
    if (period <= 0) return;
    const margin = vsync * LOCK_MARGIN_SHARE;

    if (!this._seeded) {
      // Not before the estimates mean anything, and not on an assumed grid: a seed taken off the
      // fallback vsync would pin the cadence to a display nobody measured. The GPU term needs at
      // least one reading of its own — a seed off the CPU half alone would choose a cadence for a
      // frame whose expensive half has not reported yet, which on a GPU-bound scene is every
      // frame. Twice the sample count without one is a renderer that will never hand one over
      // (`fence=false`), and seeding on the CPU alone beats never seeding.
      const cost = Math.max(this._cpu.N, this._gpu.N);
      const ready = (this._gpu.N >= 1 && cost >= LOCK_SEED_FRAMES) || this._cpu.N >= 2 * LOCK_SEED_FRAMES;
      if (!ready || !this.VsyncDerived) return;
      this._seeded = true;
      const seed = this._clampN(Math.ceil((period - margin) / vsync));
      if (seed !== this.LockN) this._setN(seed, time, period, vsync);
      return;
    }

    let want = this.LockN;
    if (period > this.LockN * vsync + margin) want = this.LockN + 1;
    else if (this.LockN > 1 && period + margin <= (this.LockN - 1) * vsync) want = this.LockN - 1;
    want = this._clampN(want);

    if (want === this.LockN) { this._hold = 0; this._holdDir = 0; return; }
    const dir = want > this.LockN ? 1 : -1;
    if (dir !== this._holdDir) { this._holdDir = dir; this._hold = 0; }
    this._hold++;
    if (this._hold < LOCK_HOLD_FRAMES) return;
    if (this._lastChangeAt > 0 && time - this._lastChangeAt < LOCK_CHANGE_MS) return;
    this._setN(this._clampN(this.LockN + dir), time, period, vsync);
  };

  /** Has the fence refused for long enough, in BOTH ticks and milliseconds, to be a stall rather
   *  than a GPU doing its job? See `PACE_STALL_TICKS` and `PACE_STALL_MS`. */
  private _stalled = (time: number): boolean =>
    this._fenceRun >= PACE_STALL_TICKS && time - this._lastRenderAt >= PACE_STALL_MS;

  private _clampN = (n: number): number => Math.min(LOCK_MAX_N, Math.max(1, n));

  private _setN = (n: number, time: number, period: number, vsync: number): void => {
    this.LockN = n;
    this.LockChanges++;
    this._lastChangeAt = time;
    this._hold = 0;
    this._holdDir = 0;
    this.OnLockChange?.(n, period, vsync);
  };

  private _allow = (decision: PaceDecision, time: number): PaceDecision => {
    this._lastRenderAt = time;
    const waited = this._skipRun;
    this.WaitedTicks[waited < 3 ? waited : 3]++;
    this._skipRun = 0;
    this._fenceRun = 0;
    this.Rendered++;
    return decision;
  };

  private _refuse = (by: 'lock' | 'fence' | 'ratio'): PaceDecision => {
    this._skipRun++;
    if (by === 'fence') this._fenceRun++;
    if (by === 'lock') this.LockSkipped++;
    else if (by === 'fence') this.FenceSkipped++;
    this.Skipped++;
    return 'skip';
  };

  /** The census, for the `[Jaui]` line, `jaui:render:end` and the `__jauiTickPace` global. */
  Census = (): PaceCensus => ({
    Mode: TickPaceText(this.Mode),
    Rendered: this.Rendered,
    Skipped: this.Skipped,
    Forced: this.Forced,
    WaitedTicks: [...this.WaitedTicks] as PaceWaited,
    FenceMs: { N: this.FenceSamples, Sum: Round1(this.FenceMsSum), Max: Round1(this.FenceMsMax) },
    MaxInFlight: this.MaxInFlight,
    LockN: this.Mode !== null && this.Mode.Kind === 'lock' ? this.LockN : 0,
    LockChanges: this.LockChanges,
    PeriodMs: Round1(this.PeriodMs),
    VsyncMs: Round2(this.VsyncMs),
    VsyncDerived: this.VsyncDerived,
    LockSkipped: this.LockSkipped,
    FenceSkipped: this.FenceSkipped,
  });
}
