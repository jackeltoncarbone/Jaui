/**
 * `?tick-pace` — pace the render on the DISPLAY instead of on the tick. The arithmetic, no GL in it.
 *
 * WHY THIS EXISTS (ShowStudio.Documentation/Perf/README.md, "PACING: 66.87 -> 33.48 ms"): the engine
 * rendered TWICE per presented frame at baseline, and removing the second render cut the frame time
 * in half with no pixel change. The flag's meaning is the VSYNC LOCK: release a render only on a
 * whole number of vsyncs, so the presented sequence is EVEN as well as fast.
 *
 *     N = ceil(period / vsync), and a render is released only when at least N vsync intervals have
 *     passed since the last released render.
 *
 * THE M4 MEASURED THAT MECHANISM AND IT IS RIGHT. One binary, interleaved, 3 per arm, read on the
 * histogram (Perf/README.md, "The M4's tickpace3 cell"):
 *
 *     dpr 2                  p50     p95   histogram       gate
 *     base                 59.34   60.07   2v 23%  4v 77%
 *     tick-pace (lock)     50.10   52.00   3v 100%         LockN=3 PeriodMs=37.5 VsyncMs=16.67
 *     tick-pace=lock:16.67 50.00   51.55   2v 43%  3v 57%  LockN=3 PeriodMs=38.1  <- N moved MID-RUN
 *     tick-pace=fence      17.62   51.95   1v 50%  3v 50%
 *     tick-pace=2          33.31   35.21   2v 100%         <- uniform AND fastest
 *
 * 100% of frames in ONE bucket, at both resolutions, which neither the fence (50/50) nor the base
 * (23/77) reaches. The vsync derivation is right too: the PINNED arm chose the same N.
 *
 * AND ITS N SELECTION WAS WRONG, BY THE WHOLE 50-vs-33.3 GAP. The directly measured unpaced render
 * period on the same build and scene (ticks/s on an arm where every callback renders) is 29.41 ms
 * at dpr 2 and 18.40 at dpr 1.5. The old estimate — `max(CPU-issue EMA, solo-GPU-fence EMA)` — read
 * 37.5 and 24.2. By the step-down rule (period + margin <= (N-1) x vsync) the TRUE numbers step and
 * the ESTIMATES cannot step anywhere, so the lock sat a whole vsync slow.
 *
 * WHY A COST MODEL CANNOT PRODUCE THE NUMBER, which is this lane's whole finding:
 *
 *   * the SOLO fence latency is arm-to-signal, and arm-to-signal includes whatever the present
 *     couples to the frame's completion. It is a LATENCY, not a throughput period.
 *   * the CPU's issuing time overlaps the previous frame's GPU work, so it is not additive either,
 *     and `max()` of two terms that are each wrong in their own direction is not a period.
 *
 * ONLY OBSERVATION CAN. The render period that matters is the COMPLETION-TO-COMPLETION GAP of
 * consecutive rendered frames WHILE THE LOOP IS SATURATED — a render issued as soon as the previous
 * one completes. That reading needs no model at all: both of its ends are the same clock, the
 * quantization at each end is the same poll grain and cancels in a mean over a window, and a frame
 * whose fence was armed while another of ours was still in flight is saturated BY CONSTRUCTION
 * (`PaceFenceSample.Solo === false`) rather than by assumption.
 *
 * THE CONTROL PROBLEM, AND THE ANSWER: under a correct lock the loop is DELIBERATELY NOT saturated,
 * so the period cannot be observed while locked. So the lock CREATES OBSERVATION WINDOWS.
 *
 *   WARM-UP SATURATES.  Start at N=1. With N=1 and the depth-1 fence underneath, a render costing
 *                       more than one vsync saturates the loop by construction and every completion
 *                       gap IS the period. Seed N = ceil((period - margin) / vsync) from the mean of
 *                       `LOCK_OBSERVE_SAMPLES` saturated gaps. If the warm-up NEVER saturates within
 *                       `LOCK_WARMUP_MAX_RENDERS`, that is not a failure — it is the proof that N=1
 *                       is enough, because the loop was releasing on the one-vsync grid (or as fast
 *                       as its callbacks allowed) and the GPU kept up with every one of them. The
 *                       source is published as `unsaturated` so a reader is never told a number
 *                       nobody measured.
 *   TRIALS RE-OBSERVE.  At most once per DWELL, drop to N-1 for `LOCK_TRIAL_FRAMES` released
 *                       renders and watch. If the GPU keeps up (no fence refusal, no saturated gap
 *                       above the trial cadence, and the trial's own release gaps fit it), KEEP the
 *                       step down — and immediately try one more, so a scene that gets much cheaper
 *                       walks back down in one burst instead of one step per dwell. If it does not
 *                       keep up, return to N and RECORD the period from the trial's saturated gaps:
 *                       a failed trial is itself an observation.
 *   STEP-UPS ARE EVIDENCE.  A fence refusal while locked means the GPU fell behind the grid, and the
 *                       loop is saturated at that moment, so the gaps around it are the period
 *                       again. Step to N+1 on refusals AND a saturated reading that exceeds the
 *                       cadence — never on one alone.
 *
 * WHAT A FAILED TRIAL COSTS, priced rather than waved at: the loop runs at the faster cadence until
 * the queue backs up enough for the fence to refuse, which on a period P against a trial cadence C
 * takes about 1/(1 - C/P) releases — three at dpr 2 (29.41 against 16.67), eleven at dpr 1.5 (18.40
 * against 16.67). So a failed trial is ~3-11 judder frames, ~100-200 ms, once per dwell, and the
 * dwell DOUBLES after each failure up to `LOCK_DWELL_MAX_MS` (resetting on a success or a step-up).
 * In a 6 s measurement window at dpr 2 that is one trial: ~3 frames of 180, so the histogram still
 * reads ~98% in one bucket. THAT IS THE PRICE OF ADAPTIVITY AND IT IS NOT AVOIDABLE — the only
 * thing that can tell you a cheaper cadence works is running at it. A cost model used to SUPPRESS a
 * trial would be the old bug wearing a new hat: the over-reading estimate would forbid exactly the
 * experiment that disproves it.
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
 * checked against one that cannot be wrong. The M4's pinned and derived arms chose the same N.
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
 * happens and the flag is a no-op by construction. (A paced arm used to freeze a less-converged
 * adaptive shadow on park; lane tickpace4 fixed that in the RENDERER — converge, then park — so
 * every pacing arm now reads 0 px against unflagged on the same build.)
 *
 * THE CONTROLS STAY, all in one binary, and the depth argument behind `fence` is still true:
 *
 *   `fence:D`  D frames may be outstanding when a tick asks to render. D=0 is the strictly serial
 *              gate that measured 50.13 by making the frame cost CPU issue PLUS GPU execution
 *              instead of their max; D=1 is the pipelined one that measured 33.52 and juddered.
 *   `N`        render every Nth want. A 30 fps clamp at N=2. Never a default; it exists to price
 *              the instrument (it issues zero fence polls) and to be the even arm the lock has to
 *              match.
 *   `observe`  the UNPACED arm with the instrument on: every want renders, exactly as unflagged,
 *              and the fences are still polled and booked. It is how the report answers "by how
 *              much does the solo fence latency over-read the throughput period, and where does the
 *              difference come from" with a number: `SoloMs` (arm-to-signal, the old estimator's
 *              input), `SatGapMs` (completion-to-completion while saturated, the truth) and
 *              `RenderMs` (the CPU's own issuing time) for the same scene on the same build. It
 *              PERTURBS — one `clientWaitSync` per tick, with the flush bit — so it is a
 *              diagnostic, never a timing cell.
 */

/** How the gate decides. `null` is the unflagged engine: every tick that wants to render, renders. */
export type TickPaceMode =
  /** Release a render only on a whole number of vsyncs, chosen from OBSERVED render completions.
   *  The flag's meaning. `Depth` is the fence safety net underneath it; `Vsync` pins the display
   *  interval in ms when `?tick-pace=lock:V` named one, and is null when it is derived. */
  | { Kind: 'lock'; Depth: number; Vsync: number | null }
  /** Poll the rendered frames' GPU fences; skip while more than `Depth` of them are outstanding.
   *  Adaptive, and the arm that measured TRIMODAL at dpr 2. A control now. */
  | { Kind: 'fence'; Depth: number }
  /** Render every Nth tick that wants to render. N >= 2. The control arm, and a clamp. */
  | { Kind: 'ratio'; N: number }
  /** Gate nothing; poll and book everything. The unpaced arm with the instrument on. */
  | { Kind: 'observe' };

/** What the gate said about one tick that wanted to render. `forced` is a `render` the stall guard
 *  took rather than a `render` the fence allowed, and it is counted separately BECAUSE a cell with
 *  a non-zero forced count is not measuring what the flag claims to measure. */
export type PaceDecision = 'render' | 'skip' | 'forced';

/**
 * Where `PeriodMs` came from. A period without this field is a number a reader has to trust; with
 * it, a reader can tell a measurement from a default.
 *
 *   `none`         nothing has been observed yet.
 *   `warmup`       the saturated N=1 window at boot. The seed came from this.
 *   `trial`        a speculative step-down that saturated and therefore failed — which is the most
 *                  informative outcome a trial has, because a failed trial IS an observation.
 *   `stepup`       the loop fell behind its own cadence and the gaps around the refusals said by
 *                  how much.
 *   `unsaturated`  the warm-up never saturated at N=1, so there is no period to publish AND none is
 *                  needed: the GPU kept up with every release on the one-vsync grid. `PeriodMs` is
 *                  0 here and that zero is a statement, not a missing reading.
 *   `gap`          a non-lock polling arm (`fence`, `observe`) publishing the mean saturated
 *                  completion gap it happened to see. No controller reads it.
 */
export type PacePeriodSource = 'none' | 'warmup' | 'trial' | 'stepup' | 'unsaturated' | 'gap';

/** What happened to one speculative step-down, for the trace. */
export type PaceTrialOutcome = 'start' | 'kept' | 'failed';

/** One retired frame-completion fence, as the renderer reports it. Everything here is a reading;
 *  `Tick.Pace` decides what each one is evidence OF. */
export interface PaceFenceSample {
  /** Arm to the poll that retired it. The existing `FenceMs` ledger field, unchanged: at depth 1 it
   *  legitimately includes the queue wait, and even SOLO it includes the present coupling, which is
   *  why it is a latency and never the period. */
  Ms: number;
  /** Previous retirement to this one. When the frame was QUEUED behind another of ours (`Solo`
   *  false), this IS the throughput period. 0 when there is no previous retirement to measure from. */
  GapMs: number;
  /** Was the GPU free of our frames when this fence was armed? `false` is the saturation proof: the
   *  gap that ends at this completion contains no idle time, because the GPU had work the whole way. */
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
 *
 * It is ALSO what makes the warm-up observation possible: at N=1 and depth 1, a render longer than
 * a vsync keeps exactly one frame queued behind the running one, which is the saturated steady
 * state the period is defined in.
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

/**
 * Saturated completion gaps that make one period OBSERVATION.
 *
 * Eight, taken as a MEAN and not a median, and the reason is the clock: a completion is timestamped
 * by the POLL that found the fence signalled, so both ends of a gap are quantized to the poll grain
 * (8.33 ms at a 120 Hz callback cadence). A 29.41 ms period read on that grain produces gaps of 25
 * and 33.3 in the proportion that averages to 29.41 — the mean is unbiased and the median snaps to
 * whichever grid point happens to win. Eight of them is ~240 ms of saturated rendering at dpr 2,
 * which is inside the harness's settle slack and short enough that the seed is not a warm-up cell.
 */
export const LOCK_OBSERVE_SAMPLES = 8;

/** Released renders at N=1 with the fence NEVER having refused, after which the warm-up stops
 *  waiting and declares N=1 sufficient. It is not a timeout on a measurement, it is the OTHER
 *  outcome: two dozen releases on the one-vsync grid that the pipeline kept up with IS the proof.
 *  Two dozen is ~400 ms at 60 Hz and ~3 s on a phone whose callbacks are 120 ms apart — and on the
 *  phone N=1 is the answer anyway, so the wait costs nothing. */
export const LOCK_WARMUP_QUIET_RENDERS = 24;

/** ...and the bound for a warm-up that HAS started saturating but has not yet produced
 *  `LOCK_OBSERVE_SAMPLES` clean gaps. A render barely over one vsync (the M4's 18.40 at dpr 1.5
 *  against a 16.67 grid) backs the depth-1 queue up only ~1.7 ms per frame, so the first refusal is
 *  eleven renders in and the eighth clean gap another ten after that. Sixty-four renders is ~1 s at
 *  that cadence — and cutting it short would hand exactly that case the wrong answer, which is the
 *  cell the lane was asked to fix. */
export const LOCK_WARMUP_MAX_RENDERS = 64;

/**
 * Released renders one speculative step-down runs for before it is KEPT.
 *
 * A trial that is going to fail fails early and cheaply — the queue backs up until the fence
 * refuses, ~1/(1 - cadence/period) releases — so the budget does not price failure, it sets the
 * RESOLUTION of success: surviving F frames means the cadence overran the period by less than
 * about 1/F of itself. Twenty-four resolves ~4%, which separates the M4's dpr-1.5 case (18.40 ms
 * against a 16.67 grid, 10.4% over, refuses at ~frame 11) from a genuine one-vsync render. A larger
 * budget costs nothing when the trial succeeds — those are good frames at the better cadence.
 */
export const LOCK_TRIAL_FRAMES = 24;

/** How long the cadence holds before the next trial is allowed. Two seconds is ~60 locked frames at
 *  dpr 2, so a failed trial's handful of judder frames is a few percent of a window and the
 *  histogram still reads in one bucket. */
export const LOCK_DWELL_MS = 2000;

/** ...doubling after every failed trial, to here. A scene whose cadence is settled stops being
 *  poked at; one that has just changed (a step-up, or a trial that was KEPT) resets to the base. */
export const LOCK_DWELL_MAX_MS = 16000;

/** Consecutive untroubled releases that CLOSE a saturated run. Three, because one clean release
 *  proves nothing on a loop that is only just over the grid — at 18.40 ms against 16.67 the fence
 *  refuses every second or third frame and the frames between them are part of the same saturated
 *  run, not a return to idle. Closing on one would keep only the slow half of the pattern and read
 *  the period 36% high. */
export const LOCK_SATURATION_EXIT = 3;

/** Fence refusals inside `LOCK_STEPUP_WINDOW_MS` that make a step-up worth considering. NOT a
 *  CONSECUTIVE run: a consecutive count is a measure of the TICK cadence, not of the GPU — at 60 Hz
 *  callbacks a badly overrun cadence produces one refusal between releases and at 120 Hz it
 *  produces three, so a consecutive bar of three would fire on one machine and never on the other.
 *  That is the same trap `PACE_STALL_MS` was added to this file to close. */
export const LOCK_STEPUP_REFUSALS = 3;

/** ...and the window they must fall inside. Half a second: recent enough that a refusal from two
 *  scenes ago cannot help re-time this one, long enough to hold three at any callback cadence. */
export const LOCK_STEPUP_WINDOW_MS = 500;

/** How far past the boundary an OBSERVED period must be before N moves up, and how much room a
 *  trial's readings must leave before a step down is kept, as a share of one vsync. 10% of a vsync
 *  is 1.7 ms at 60 Hz: wide enough to swallow the residual poll quantization in a gap reading,
 *  narrow enough that a genuinely 2-vsync render is never mistaken for a 1-vsync one. It is what
 *  holds N=1 on the M4's ~17 ms dpr-1.5 render (17 < 16.67 + 1.67) instead of flapping to N=2. */
export const LOCK_MARGIN_SHARE = 0.10;

/** Floor between two committed N changes, in ms. The dwell governs trials; this governs step-ups,
 *  which are evidence-driven and must not have to wait a dwell to correct a cadence the GPU is
 *  visibly failing — but must not ratchet up eight times in eight frames either. */
export const LOCK_CHANGE_MS = 250;

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

/** Readings kept for one decision window (the warm-up's, a trial's, a step-up's). Cleared whenever
 *  the released cadence changes, because a gap that spans two cadences belongs to neither. */
const DECIDE_RING = 16;

/** Readings kept for the published diagnostics. Never cleared: the whole point of them is to be
 *  comparable across a run and across arms. */
const DIAG_RING = 32;

/** A GPU cost sample above this is a hitch (a shader compile, a texture upload, a tab restore), not
 *  the steady-state period the cadence should be chosen from. */
const GPU_SAMPLE_MAX_MS = 250;

/** One decimal, so a printed ledger is readable and two of them are still subtractable. */
const Round1 = (v: number): number => Math.round(v * 10) / 10;
/** Two, for the vsync: 16.67 and 8.33 have to be told apart at a glance. */
const Round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * A small ring of timestamped readings, with a MEAN and a MEDIAN over a window.
 *
 * Not an EMA. An EMA has a memory that outlives the cadence it was taken under, and this lane
 * exists because a smoothed cost from the wrong regime chose the cadence. Everything here is a
 * bounded window of raw observations that gets THROWN AWAY when the regime changes.
 *
 * `Mean` is what the period is read with (poll quantization cancels in it, see
 * `LOCK_OBSERVE_SAMPLES`); `Median` is what the published diagnostics use, where a single hitch
 * should not move the number a human reads.
 */
class Samples {
  private readonly _v: number[] = [];
  private readonly _t: number[] = [];
  private _at = 0;
  /** Pushes ever, across clears. */
  Total = 0;

  constructor(private readonly _cap: number) {}

  Push = (v: number, t: number): void => {
    this.Total++;
    if (this._v.length < this._cap) { this._v.push(v); this._t.push(t); return; }
    this._v[this._at] = v;
    this._t[this._at] = t;
    this._at = (this._at + 1) % this._cap;
  };

  Clear = (): void => {
    this._v.length = 0;
    this._t.length = 0;
    this._at = 0;
  };

  /** Readings at or after `since`. `since` 0 is the whole window. */
  Count = (since = 0): number => {
    let n = 0;
    for (let i = 0; i < this._v.length; i++) if (this._t[i] >= since) n++;
    return n;
  };

  /** 0 when nothing in the window qualifies — and 0 is never a legal period, so a caller that
   *  forgets to check `Count` cannot silently act on an empty ring. */
  Mean = (since = 0): number => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this._v.length; i++) if (this._t[i] >= since) { sum += this._v[i]; n++; }
    return n === 0 ? 0 : sum / n;
  };

  Median = (since = 0): number => {
    const kept: number[] = [];
    for (let i = 0; i < this._v.length; i++) if (this._t[i] >= since) kept.push(this._v[i]);
    if (kept.length === 0) return 0;
    kept.sort((a, b) => a - b);
    return kept[kept.length >> 1];
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
 *     ?tick-pace=observe      pace NOTHING, instrument everything — the arm that prices the solo
 *                             fence latency against the observed throughput period
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
  if (v === 'observe') return { Mode: { Kind: 'observe' } };
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
  if (!Number.isInteger(n)) return { Why: 'value-must-be-lock-observe-fence-or-a-whole-number-of-ticks' };
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
      : mode.Kind === 'observe' ? 'observe'
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
  /** The lock's current cadence, in vsyncs per presented frame — the one IN FORCE, so during a
   *  trial it is the trial's. 0 in every other mode. */
  LockN: number;
  /** The cadence the lock has COMMITTED to. A trial shows up as `LockN !== LockCommittedN`. */
  LockCommittedN: number;
  /** How many times the COMMITTED cadence moved, the seed included. A failed trial is not a change
   *  — it is a `Trials`/`TrialsFailed` entry — so this counts decisions, not experiments. A cell
   *  whose count is still rising is a cell taken during a warm-up. */
  LockChanges: number;
  /** The OBSERVED render period the cadence was chosen from: the mean completion-to-completion gap
   *  of the last saturated window. Never a cost model, never an EMA of one. 0 means nothing has
   *  been observed — read `PeriodSource` to find out which kind of nothing. */
  PeriodMs: number;
  /** Which observation window `PeriodMs` came from. */
  PeriodSource: PacePeriodSource;
  /** How long ago that window closed, in ms. -1 when there has never been one. A FRESH period is
   *  not the goal and cannot be: while the lock is holding, the loop is not saturated and there is
   *  nothing to observe. An old number here is the design working; a number with no age is a model. */
  PeriodObservedAt: number;
  /** Speculative step-downs started, and how many of them the GPU could not hold. */
  Trials: number;
  TrialsFailed: number;
  /** DIAGNOSTIC, never read by a decision. Mean SOLO fence latency, de-quantized by half the poll
   *  gap — arm-to-signal with the GPU otherwise idle, which is what the OLD estimator believed was
   *  the period. Compare it against `SatGapMs` to price the over-read. */
  SoloMs: number;
  /** DIAGNOSTIC. Mean queued completion-to-completion gap seen anywhere in the run — the throughput
   *  period as the FENCE sees it, which is the number `SoloMs` has to be compared against. */
  SatGapMs: number;
  /** DIAGNOSTIC. Median wall time of `_render` on the worker: the CPU's issuing half, which
   *  overlaps the previous frame's GPU work and is therefore not additive with it. Between these
   *  three numbers a report can say whether the solo latency over-reads because of PRESENT COUPLING
   *  (`SoloMs` >> `SatGapMs` >= `RenderMs`) or because the CPU term dominated a `max()`
   *  (`RenderMs` >= `SoloMs`). */
  RenderMs: number;
  /** The display interval the lock is quantizing to, derived or pinned. */
  VsyncMs: number;
  /** Was `VsyncMs` measured, or is it still the fallback? A cell taken on the fallback is a cell
   *  whose grid was assumed. */
  VsyncDerived: boolean;
  /** Skips the LOCK took (the tick came early). Normal, and the larger the tick rate the larger
   *  this is — three per render at 120 Hz ticks and N=2. */
  LockSkipped: number;
  /** Skips the FENCE took (the GPU was still behind). Under a correct lock this is ~0 outside
   *  trials, and a large one says the cadence is faster than the GPU can fill. */
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
   *  a window is `(Sum2-Sum1)/(N2-N1)`. Zero in the ratio mode, which never polls. */
  FenceSamples = 0;
  FenceMsSum = 0;
  FenceMsMax = 0;

  /** High-water mark of frames outstanding on the GPU. At depth D a working gate reaches D+1. */
  MaxInFlight = 0;

  /** The cadence IN FORCE, in vsyncs. Starts at 1 — which is not a guess, it is the saturating
   *  warm-up the period is observed in — and during a trial it is one below the committed one. */
  LockN = 1;
  /** The cadence the lock has committed to. */
  LockCommittedN = 1;
  LockChanges = 0;
  LockSkipped = 0;
  FenceSkipped = 0;
  Trials = 0;
  TrialsFailed = 0;

  /** Called when the COMMITTED cadence moves, so the trace can say so without this file importing
   *  one. The period and its source ride along: an N change whose period is `unsaturated` was
   *  chosen by a proof, not by a reading, and a reader must be able to tell. */
  OnLockChange: ((n: number, periodMs: number, vsyncMs: number, source: PacePeriodSource) => void) | null = null;
  /** Called at each end of a speculative step-down. A trial is the only thing in this file that
   *  deliberately makes frames worse, so it says so on the trace every time. */
  OnTrial: ((n: number, outcome: PaceTrialOutcome) => void) | null = null;

  private readonly _vsync = new VsyncEstimator();

  /** Release intervals taken inside a saturated run — the OBSERVED period, for the CURRENT
   *  decision window. Cleared whenever the released cadence changes, because an interval that spans
   *  two cadences measures neither. */
  private readonly _sat = new Samples(DECIDE_RING);
  /** Every release interval inside a trial that the run kept: the trial's own cadence while the
   *  pipeline is keeping up, and the period once it is not. */
  private readonly _trialIntervals = new Samples(DECIDE_RING);
  /** Fence refusals, timestamped, for the step-up's rate test. */
  private readonly _refusals = new Samples(DECIDE_RING);

  /** The three published diagnostics. Nothing decides on any of them — that is the lane. */
  private readonly _soloDiag = new Samples(DIAG_RING);
  private readonly _satDiag = new Samples(DIAG_RING);
  private readonly _cpuDiag = new Samples(DIAG_RING);

  /** Frames outstanding as of the last poll, so `Decide` reads one number rather than polling
   *  twice. */
  private _inFlight = 0;

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
  /** When a render last ran, so the stall guard can be a duration instead of a tick count — and so
   *  the release INTERVAL, which is what says whether the loop was flat out, is measurable. */
  private _lastRenderAt = 0;
  /** Is the loop inside a saturated run? See `_noteRelease`. */
  private _satRun = false;
  /** Consecutive releases inside a run that the pipeline had no trouble with. */
  private _clean = 0;
  /** The latest clock reading this object has seen, so `Census` can age the period without every
   *  caller of it having to hold a timestamp. */
  private _now = 0;

  /** The observation the cadence rests on. */
  private _periodMs = 0;
  private _periodAt = 0;
  private _periodSource: PacePeriodSource = 'none';

  /** Warm-up state: renders taken at N=1 while waiting for the loop to saturate. */
  private _seeded = false;
  private _warmRenders = 0;

  /** Trial state. */
  private _trial = false;
  private _trialRenders = 0;
  private _lastTrialAt = 0;
  private _dwellMs = LOCK_DWELL_MS;
  /** Set by a KEPT trial: try the next step down immediately rather than after a dwell, so a scene
   *  that got much cheaper walks back down in one burst. */
  private _trialNow = false;

  private _lastChangeAt = 0;
  /** The first completion gap after a cadence change spans the change and measures neither side. */
  private _skipGap = false;

  constructor(mode: TickPaceMode | null) { this.Mode = mode; }

  /** Every tick, before the gate — the vsync estimate is a property of the CALLBACKS, so it has to
   *  see the ones that do not want to render too. One subtraction and a ring write. */
  NoteTick = (time: number): void => {
    if (this.Mode === null) return;
    this._now = time;
    this._vsync.Note(time);
  };

  /** Does the engine need to time `_render` for this mode? The lock and the observe arm publish it
   *  as a diagnostic; nothing decides on it, and a `performance.now()` pair per frame is not paid
   *  on an arm that would not read it. */
  get WantsRenderCost(): boolean {
    const m = this.Mode;
    return m !== null && (m.Kind === 'lock' || m.Kind === 'observe');
  }

  /** The wall time `_render` took, in ms. DIAGNOSTIC ONLY. */
  NoteRenderCost = (ms: number): void => {
    if (ms > 0 && ms < GPU_SAMPLE_MAX_MS) this._cpuDiag.Push(ms, this._now);
  };

  /** The OBSERVED render period — the mean completion-to-completion gap of the last saturated
   *  window. 0 when nothing has been observed; `PeriodSource` says which kind of nothing. On a
   *  non-lock polling arm it is whatever saturated gaps that arm happened to produce. */
  get PeriodMs(): number {
    const m = this.Mode;
    if (m !== null && m.Kind === 'lock') return this._periodMs;
    return this._satDiag.Count() > 0 ? this._satDiag.Mean() : 0;
  }

  get PeriodSource(): PacePeriodSource {
    const m = this.Mode;
    if (m !== null && m.Kind === 'lock') return this._periodSource;
    return this._satDiag.Count() > 0 ? 'gap' : 'none';
  }

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
    this._now = time;
    if (mode === null) return this._allow('render', time);

    if (mode.Kind === 'ratio') {
      const render = this._wants % mode.N === 0;
      this._wants++;
      return render ? this._allow('render', time) : this._refuse('ratio');
    }

    // Every other mode polls. A null gate cannot happen — the parse refuses them on a renderer that
    // has no fence to poll — but a gate that is not there must render rather than stall.
    if (gate === null) return this._allow('render', time);
    this._poll(gate);

    // The unpaced arm with the instrument on: the poll above is the whole of it.
    if (mode.Kind === 'observe') return this._allow('render', time);

    const inFlight = this._inFlight;
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
      const decision = this._refuse('fence');
      this._noteFenceRefusal(time, vsync);
      return decision;
    }

    this._evaluateLock(time, vsync);
    // Advance the IDEAL grid, not the actual release, so jitter does not accumulate — and re-anchor
    // rather than run a backlog when the loop has been parked or stalled past a whole period.
    this._nextAt += this.LockN * vsync;
    if (this._nextAt <= time) this._nextAt = time + this.LockN * vsync;
    return this._allow('render', time);
  };

  /**
   * Poll the fences and book the ledger. PURE INSTRUMENT — nothing the controller reads comes out
   * of here, and that is the shape of the fix: the fence says only STOP or GO, and the period is
   * observed off the loop's own release cadence (`_noteRelease`).
   *
   * The two latency channels are kept apart because the whole 50-vs-33.3 cell is the difference
   * between them. A SOLO sample's arm-to-signal is a LATENCY: the GPU was idle when the fence was
   * armed, so it contains that frame's execution AND whatever the present couples to its
   * completion, and it is what the old estimator believed was the period. A QUEUED sample's
   * completion-to-completion gap has no idle time in it at either end. `SoloMs` over `SatGapMs` on
   * one arm of one binary is the over-read, priced.
   */
  private _poll = (gate: PaceGate): void => {
    const inFlight = gate.PaceInFlight();
    this._inFlight = inFlight;
    if (inFlight > this.MaxInFlight) this.MaxInFlight = inFlight;
    const s = gate.PaceTakeFence();
    if (s === null) return;
    this.FenceSamples++;
    this.FenceMsSum += s.Ms;
    if (s.Ms > this.FenceMsMax) this.FenceMsMax = s.Ms;
    const now = this._now;
    if (s.Solo) {
      // De-quantized by half the poll gap: the true completion lies in (previous poll, this poll].
      const solo = Math.max(s.Ms - s.PollGapMs / 2, 0);
      if (solo > 0 && solo < GPU_SAMPLE_MAX_MS) this._soloDiag.Push(solo, now);
      return;
    }
    const gap = s.GapMs;
    if (gap > 0 && gap < GPU_SAMPLE_MAX_MS) this._satDiag.Push(gap, now);
  };

  /**
   * Book one released render's interval, and decide whether the loop is in a SATURATED RUN.
   *
   * Saturation is a STATE, not a per-frame flag, and that distinction is load-bearing. A loop
   * running flat out at 18.40 ms against a 16.67 ms grid releases at 16.67 and 25 alternately —
   * only the 25s follow a fence refusal, so a per-interval test would keep the 25s, drop the 16.7s
   * and read the period as 25. The run keeps BOTH: it opens on the first fence refusal and closes
   * only after `LOCK_SATURATION_EXIT` consecutive releases the pipeline had no trouble with, so
   * what it averages is the loop's actual throughput — which is precisely `ticks/s` on an unpaced
   * arm, the number the M4 measured as 29.41 and 18.40 and the one the old estimate missed.
   *
   * On the `observe` arm there is no gate to refuse anything and every want renders, so the loop is
   * flat out by construction and the run is always open.
   */
  private _noteRelease = (time: number): void => {
    const mode = this.Mode;
    if (mode === null || mode.Kind === 'ratio') return;
    const prev = this._lastRenderAt;
    if (mode.Kind === 'observe') this._satRun = true;
    else if (this._fenceRun > 0) { this._satRun = true; this._clean = 0; }
    else if (this._satRun && ++this._clean >= LOCK_SATURATION_EXIT) this._satRun = false;
    if (!this._satRun || prev <= 0) return;
    const interval = time - prev;
    if (!(interval > 0 && interval < GPU_SAMPLE_MAX_MS)) return;
    if (this._trial) this._trialIntervals.Push(interval, time);
    // The first interval after a cadence change spans the change and measures neither side of it.
    if (this._skipGap) { this._skipGap = false; return; }
    this._sat.Push(interval, time);
  };

  /**
   * The lock's controller. Once per released render. It has exactly three states, and NONE of them
   * derives a cadence from a cost model.
   */
  private _evaluateLock = (time: number, vsync: number): void => {
    if (!this._seeded) { this._warmUp(time, vsync); return; }
    if (this._trial) { this._judgeTrial(time, vsync); return; }
    this._maybeTrial(time);
  };

  /**
   * WARM-UP. N=1 and the depth-1 fence, which saturates the loop whenever a render costs more than
   * one release interval — and that is the only state in which a completion gap is a period.
   *
   * Two outcomes, both of them conclusions:
   *   saturated    `LOCK_OBSERVE_SAMPLES` gaps arrived. Their mean is the period; seed from it.
   *   unsaturated  two dozen renders went by with the GPU free at every arm. N=1 is PROVED
   *                sufficient — the loop was releasing as fast as its callbacks and grid allowed
   *                and the GPU kept up with all of it — so there is nothing to seed and no number
   *                to publish. That is the phone, and it is also any scene under one vsync.
   */
  private _warmUp = (time: number, vsync: number): void => {
    this._warmRenders++;
    // A seed on an assumed grid is a seed nobody measured, so wait for the callbacks to say.
    if (!this.VsyncDerived) return;
    if (this._sat.Count() >= LOCK_OBSERVE_SAMPLES) {
      this._observe(this._sat.Mean(), time, 'warmup');
      this._seeded = true;
      this._commitN(this._clampN(Math.ceil((this._periodMs - vsync * LOCK_MARGIN_SHARE) / vsync)), time, vsync);
      return;
    }
    const bound = this._sat.Total === 0 ? LOCK_WARMUP_QUIET_RENDERS : LOCK_WARMUP_MAX_RENDERS;
    if (this._warmRenders >= bound) {
      this._seeded = true;
      this._periodSource = 'unsaturated';
      this._periodAt = time;
      this._lastTrialAt = time;
    }
  };

  /** A step down is only ever taken by RUNNING at it. Once per dwell — or immediately after one
   *  that was kept, so a scene that got much cheaper does not take a dwell per vsync to find out. */
  private _maybeTrial = (time: number): void => {
    if (this.LockCommittedN <= 1) return;
    if (!this._trialNow && time - this._lastTrialAt < this._dwellMs) return;
    this._trialNow = false;
    this.Trials++;
    this._trial = true;
    this._trialRenders = 0;
    this._trialIntervals.Clear();
    this._sat.Clear();
    this._skipGap = true;
    // `_nextAt` is NOT touched here: `Decide` advances the ideal grid by the cadence in force
    // immediately after this returns, and that cadence is now the trial's.
    this.LockN = this.LockCommittedN - 1;
    this.OnTrial?.(this.LockN, 'start');
  };

  /**
   * Judge the trial in flight. Called once per released render inside it; a fence refusal judges it
   * from `_noteFenceRefusal` instead, and sooner.
   *
   * Two failure tests, and they are different evidence. SATURATED gaps above the trial cadence are
   * the period itself saying the cadence cannot be filled — two of them end the trial at once. The
   * trial's WHOLE gap population is the weaker, slower test at the end of the budget: when the GPU
   * is keeping up those gaps are the release cadence, so a median above it means the releases
   * themselves were not landing on the grid.
   */
  private _judgeTrial = (time: number, vsync: number): void => {
    this._trialRenders++;
    const margin = vsync * LOCK_MARGIN_SHARE;
    const cadence = this.LockN * vsync;
    if (this._sat.Count() >= 2 && this._sat.Mean() > cadence + margin) {
      this._observe(this._sat.Mean(), time, 'trial');
      this._failTrial(time);
      return;
    }
    if (this._trialRenders < LOCK_TRIAL_FRAMES) return;
    const gaps = this._trialIntervals.Mean();
    if (gaps > 0 && gaps > cadence + margin) { this._failTrial(time); return; }
    this._trial = false;
    const kept = this.LockN;
    this._commitN(kept, time, vsync);
    this._trialNow = true;
    this.OnTrial?.(kept, 'kept');
  };

  private _failTrial = (time: number): void => {
    this._trial = false;
    this.TrialsFailed++;
    this.LockN = this.LockCommittedN;
    this._dwellMs = Math.min(this._dwellMs * 2, LOCK_DWELL_MAX_MS);
    this._lastTrialAt = time;
    this._trialNow = false;
    this._trialIntervals.Clear();
    this._sat.Clear();
    this._skipGap = true;
    this._fenceRun = 0;
    this._refusals.Clear();
    this.OnTrial?.(this.LockN, 'failed');
  };

  /**
   * A fence refusal under the lock. Inside a trial it is the verdict; outside one it is the only
   * evidence a step-up ever gets — and it is not enough on its own. The loop is saturated at that
   * moment, so the gaps around it ARE the period, and the step-up asks BOTH questions: is this
   * happening often (a rate, inside a window, not a consecutive run — see `LOCK_STEPUP_REFUSALS`),
   * and does the measured period actually exceed the cadence?
   */
  private _noteFenceRefusal = (time: number, vsync: number): void => {
    if (!this._seeded) return;   // the warm-up saturates ON PURPOSE; refusals there are the point
    if (this._trial) {
      if (this._sat.Count() >= 2) this._observe(this._sat.Mean(), time, 'trial');
      this._failTrial(time);
      return;
    }
    this._refusals.Push(1, time);
    if (this.LockN >= LOCK_MAX_N) return;
    if (this._lastChangeAt > 0 && time - this._lastChangeAt < LOCK_CHANGE_MS) return;
    const since = time - LOCK_STEPUP_WINDOW_MS;
    if (this._refusals.Count(since) < LOCK_STEPUP_REFUSALS) return;
    if (this._sat.Count(since) < 2) return;
    const seen = this._sat.Mean(since);
    if (seen <= this.LockN * vsync + vsync * LOCK_MARGIN_SHARE) return;
    this._observe(seen, time, 'stepup');
    this._commitN(this._clampN(this.LockN + 1), time, vsync);
  };

  private _observe = (ms: number, time: number, source: PacePeriodSource): void => {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    this._periodMs = ms;
    this._periodAt = time;
    this._periodSource = source;
  };

  /** Has the fence refused for long enough, in BOTH ticks and milliseconds, to be a stall rather
   *  than a GPU doing its job? See `PACE_STALL_TICKS` and `PACE_STALL_MS`. */
  private _stalled = (time: number): boolean =>
    this._fenceRun >= PACE_STALL_TICKS && time - this._lastRenderAt >= PACE_STALL_MS;

  private _clampN = (n: number): number => Math.min(LOCK_MAX_N, Math.max(1, n));

  /** Commit a cadence: the released grid AND the decision of record. Everything observed under the
   *  previous cadence is thrown away here, because that is what makes the next reading a reading. */
  private _commitN = (n: number, time: number, vsync: number): void => {
    const moved = n !== this.LockCommittedN;
    this.LockCommittedN = n;
    this.LockN = n;
    this._lastChangeAt = time;
    this._lastTrialAt = time;
    this._dwellMs = LOCK_DWELL_MS;
    this._sat.Clear();
    this._refusals.Clear();
    this._skipGap = true;
    if (moved) {
      this.LockChanges++;
      this.OnLockChange?.(n, this._periodMs, vsync, this._periodSource);
    }
  };

  private _allow = (decision: PaceDecision, time: number): PaceDecision => {
    this._noteRelease(time);
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
  Census = (): PaceCensus => {
    const lock = this.Mode !== null && this.Mode.Kind === 'lock';
    return {
      Mode: TickPaceText(this.Mode),
      Rendered: this.Rendered,
      Skipped: this.Skipped,
      Forced: this.Forced,
      WaitedTicks: [...this.WaitedTicks] as PaceWaited,
      FenceMs: { N: this.FenceSamples, Sum: Round1(this.FenceMsSum), Max: Round1(this.FenceMsMax) },
      MaxInFlight: this.MaxInFlight,
      LockN: lock ? this.LockN : 0,
      LockCommittedN: lock ? this.LockCommittedN : 0,
      LockChanges: this.LockChanges,
      PeriodMs: Round1(this.PeriodMs),
      PeriodSource: this.PeriodSource,
      PeriodObservedAt: lock ? (this._periodAt === 0 ? -1 : Round1(this._now - this._periodAt))
        : (this._satDiag.Count() > 0 ? 0 : -1),
      Trials: this.Trials,
      TrialsFailed: this.TrialsFailed,
      // MEANS for the two fence readings and a MEDIAN for the CPU one, for the reason in
      // `LOCK_OBSERVE_SAMPLES`: both fence numbers are timestamped by the POLL that found the fence
      // signalled, so both are quantized to the poll grain and only a mean is unbiased. `_render`'s
      // wall time is read directly and is not quantized, so there a median is the better statistic.
      SoloMs: Round1(this._soloDiag.Mean()),
      SatGapMs: Round1(this._satDiag.Mean()),
      RenderMs: Round1(this._cpuDiag.Median()),
      VsyncMs: Round2(this.VsyncMs),
      VsyncDerived: this.VsyncDerived,
      LockSkipped: this.LockSkipped,
      FenceSkipped: this.FenceSkipped,
    };
  };
}
