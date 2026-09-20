/**
 * `?tick-pace` — pace the render on the DISPLAY instead of on the tick. The arithmetic, no GL in it.
 *
 * THE DEFAULT, AS OF JACK'S PACING RULING (2026-09-20 ~13:00; Perf/README.md, "THE PACING RULING"):
 * THE DEPTH-1 FENCE - wait for the last frame to finish before starting the next. No flag arms it,
 * and it estimates nothing. `TickPaceDefault()` is the mode an unflagged engine holds;
 * `?tick-pace=off` (also `=none`, `=0`) is the loop this engine ran before pacing existed and is
 * the CONTROL ARM every gate from here on is measured against.
 *
 * WHY THE FENCE AND NOT THE LOCK, in one place, so no fifth lane re-derives it. The lock is still
 * the better SHAPE - a whole number of vsyncs per frame is even as well as fast - and its mechanism
 * has been right since tickpace3: 100% of frames in one bucket at both resolutions, the pinned
 * vsync arm choosing the same N as the derived one. What has never been right is the PERIOD. Four
 * designs have now over-read it at dpr 1.5 by 20-40% each: tickpace3's solo-fence EMA, tickpace5's
 * saturated-run trials, tickpace6's ungated observation windows, and the waited-ticks histogram
 * that was refuted before it reached a lane. They failed on ONE gap, not on four bugs. The rule
 * that picks N needs the PRESENTED cadence - vsyncs per presented frame - and a worker cannot
 * observe it: rAF there is BeginFrame-on-SUBMISSION and `OffscreenCanvas.commit()` never shipped,
 * so there is no presentation signal in the engine at all. Every quantity that IS observable - a
 * fence latency, a completion gap, a queue depth, a callback cadence - is coupled to the present or
 * to the queue, and every one of them reads high.
 *
 * The fence needs none of them. It asks the GPU a question with a yes/no answer - is the last frame
 * still running? - so it is the only arm that ADAPTS WITHOUT ESTIMATING. The M4, one binary,
 * interleaved:
 *
 *     dpr 2     fence:1   32.56 p50 / 33.76 p95    1v 48%  2v 51%  3v 1%
 *               unpaced   49.65                                    3v 62%
 *     dpr 1.5   fence:1   16.67 / 17.21   1v 100%
 *               unpaced   16.66 / 17.25   1v 100%   <- INDISTINGUISHABLE: a fast page is untouched
 *
 * Never worse than unpaced at either resolution, pixel-identical, and its whole cost is the
 * 16.7/33.3 ALTERNATION on a page whose render falls between one and two vsyncs. A smarter rhythm
 * on top of it is a later lane and needs a presentation signal the platform does not provide.
 *
 * WHAT THE DEFAULT USES, AND WHAT IS INERT UNDER IT - asked plainly by the brief, because this file
 * grew around the lock and most of it now runs on a measurement flag only:
 *
 *   LIVE    `Decide`'s fence branch (poll, compare the count with `Depth`, refuse), the stall guard
 *           on its FLAT `PACE_STALL_MS` / `PACE_STALL_TICKS` floor, the `WaitedTicks` histogram,
 *           `MaxInFlight`, the two fence latency diagnostics, and the vsync estimator (published,
 *           never acted on - the fence quantizes to nothing).
 *   INERT   every observation window (`_scheduleWindow` is reached from the LOCK branch alone, so
 *           `Windows` stays 0 and `UngatedGapMs` stays 0), `NotePark` and `NoteSceneChange` (both
 *           return at their first line for a non-lock mode), the cadence-scaled stall floor (a lock
 *           term), the refusal-burst trigger, `lock:live`, and `LockN`, which stays 1 internally and
 *           publishes as 0. `WantsRenderCost` is false, so the default pays no `performance.now()`
 *           pair per rendered frame either.
 *
 * WHY THIS EXISTS (ShowStudio.Documentation/Perf/README.md, "PACING: 66.87 -> 33.48 ms"): the engine
 * rendered TWICE per presented frame at baseline, and removing the second render cut the frame time
 * in half with no pixel change. The flag's meaning is the VSYNC LOCK: release a render only on a
 * whole number of vsyncs, so the presented sequence is EVEN as well as fast.
 *
 *     N = ceil(period / vsync), and a render is released only when at least N vsync intervals have
 *     passed since the last released render.
 *
 * THE MECHANISM HAS BEEN MEASURED TWICE AND IT IS RIGHT. 100% of frames in ONE bucket at both
 * resolutions, and the PINNED vsync arm chooses the same N as the derived one. Every cut of this
 * flag has failed in the same place instead: the PERIOD.
 *
 * THE M4's tickpace5 CELL, which is what this file is now shaped by (Perf/README.md, "The M4's
 * tickpace5 cell"; one binary, interleaved, 3 per arm, read on the histogram):
 *
 *     dpr 2                  p50     p95   histogram                 gates
 *     base                 50.46   50.96   1v 3%   2v 11%  3v 86%
 *     tick-pace (lock)     33.37   50.16   1v 2%   2v 88%  3v 10%    PeriodMs 39.7 (true 25.0)
 *     tick-pace=fence      32.91   33.88   1v 46%  2v 52%  3v  2%
 *     tick-pace=2          33.35   34.61   2v 100%
 *     tick-pace=observe    50.47   50.91   = base   SoloMs 31.9  SatGapMs 54.9  RenderMs 0.6
 *
 *     dpr 1.5                p50     p95   histogram
 *     tick-pace (lock)     33.32   34.72   1v 4%   2v 95%           PeriodMs 27.1 (true 16.04)
 *     tick-pace=fence      16.66   17.04   1v 100%                  <- the best arm, 60 fps uniform
 *     tick-pace=observe                    SoloMs 30.9  SatGapMs 35.8  RenderMs 0.7
 *
 * EVERY NUMBER THE CONTROLLER HAS EVER FED ITSELF OVER-READS BY ~1.6x — 39.7 against 25.0, 27.1
 * against 16.04 — and the `observe` arm says why none of its three inputs can be the render period:
 *
 *   * `SoloMs` IS THE SAME AT BOTH RESOLUTIONS (31.9 and 30.9) though dpr 1.5 does 56% of the pixel
 *     work. An execution time cannot do that. A solo fence's arm-to-signal is the PRESENT'S LATENCY
 *     FLOOR, ~2 vsyncs on this pipeline. THE FENCE SEES THE SWAP, NOT THE RENDER — see
 *     `PaceFenceSample` for exactly where in ANGLE's Metal backend it sits and why no placement
 *     inside the frame gets out of it for free.
 *   * `SatGapMs` is a QUEUED completion gap with `MaxInFlight` 5 behind it, so it is the PRESENT
 *     cadence (54.9 against a 50.47 frame), not the execution period.
 *   * the tickpace5 "saturated run" release interval is TICK-QUANTISED: releases happen on
 *     callbacks, so a 25 ms render on a back-pressured 33 ms callback cadence releases at 33 and 66
 *     and averages 39.7. It cannot read 25 however it is filtered.
 *
 * THE ONE MEASURE THAT HAS EVER READ THE RENDER PERIOD IS THE UNGATED LOOP'S CALLBACK CADENCE —
 * the harness's `ticks/s`, 25.0 at dpr 2 and 16.04 at dpr 1.5. The worker's rAF is gated on
 * SUBMISSION: a callback fires when the compositor ACCEPTS the previous commit, which happens when
 * that frame's GPU work is done and NOT when it is presented. That is why the unpaced loop ticks at
 * 25 while presenting at 50, and it is the whole instrument this lane is built on.
 *
 * AND IT IS UNOBSERVABLE WHILE GATED, which is the control problem again with the right instrument:
 * under any gate a skipped tick submits nothing, so the compositor has nothing to accept and the
 * callback cadence falls back to the display's. So the lock OPENS THE GATE to read it.
 *
 *   WARM-UP WINDOW   The gate FULLY OPEN — no lock, no fence — for `WINDOW_TICKS` callbacks
 *                    (~300 ms at 25 ms). This is the unflagged loop, exactly. The period is the mean
 *                    callback interval over the window EXCLUDING the first `WINDOW_WARMUP_SKIP`
 *                    (the pipeline fills), and the seed is N = ceil((period - margin) / vsync).
 *   RE-OBSERVATION   The same window again, rarely: once per `_dwellMs`, base `WINDOW_DWELL_MS` and
 *                    DOUBLING to `WINDOW_DWELL_MAX_MS` for as long as the answer does not change.
 *                    Reset to the base by a window that MOVES N, by a canvas-size change, or by a
 *                    burst of fence refusals.
 *   THE PRICE, said plainly: during a window the page runs at the UNFLAGGED cadence — which is what
 *                    every unflagged page does today — for ~300 ms. At dpr 2 that is ~10 presented
 *                    frames at the base's 3v cadence instead of the lock's 2v. A rare window beats a
 *                    fence-judged TRIAL (tickpace5's mechanism, removed here) because a trial's
 *                    verdict comes from the fence, and the fence cannot tell a slow GPU from a slow
 *                    PRESENT — which is exactly how the dpr-1.5 arm ended up clamped at 33.3 where
 *                    the fence arm was doing 16.66 uniformly.
 *   THE LIVE PATH    `?tick-pace=lock:live`. Under the lock a RENDERED tick's next callback is still
 *                    gated on that submission's acceptance, so the interval from each rendered tick
 *                    to the next callback (`RenderedGapMs`) MIGHT be the live period with no window
 *                    needed. It is published on every arm so the M4 can decide, and the switch exists
 *                    so both paths ship in one binary. If `RenderedGapMs` reads the DISPLAY cadence
 *                    instead — which is what tickpace3's own cadence table hints at, since `=2`
 *                    released at 33.3 while its callbacks ran at 16.67 — the live path is refuted and
 *                    the windows stand.
 *   THE FENCE        Emergency depth cap ONLY. It is never an estimate and never a judge: `LockN`
 *                    does not move on it. A burst of refusals is allowed to say "something changed,
 *                    go and look", which OPENS A WINDOW — the window decides, both ways.
 *
 * `vsync` — the display's interval, derived from the rAF timestamps and NOT assumed, but it cannot
 * be read off them naively, and this is still the weakest link in the file. The worker's BeginFrame
 * cadence is not the display's: on ONE 60 Hz M4, across four arms of one binary, the worker's rAF
 * fired at 30 Hz (base, back-pressured), 60 Hz (`=2`), 96 Hz (`fence:1`) and 120 Hz (`fence:0`).
 * A median delta would have read "30 Hz display" on the first and "120 Hz display" on the last.
 * So the estimate takes the LARGEST plausible refresh interval that DIVIDES the observed deltas.
 * An OBSERVATION WINDOW is the hardest case it faces, because the ungated cadence is the one number
 * in this file that is NOT a whole multiple of the vsync: 25.0 ms is one-and-a-half of them. On the
 * machine the individual deltas are still vsync-quantised (25.0 is the MEAN of a 16.67/33.3 mixture,
 * which is the case the derivation handles correctly and is tested for), but if a platform ever
 * hands the worker un-snapped BeginFrame times a uniform 25 would fold to a 12.5 ms "80 Hz" grid.
 * That is named as a falsifier rather than guarded against, and `?tick-pace=lock:16.67` pins the
 * interval so the cell that has to be right can be taken.
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
 *              instead of their max; D=1 is the pipelined one — and at dpr 1.5, with the render
 *              under one vsync, it is the arm that measured 16.66 at 1v 100%.
 *   `N`        render every Nth want. A 30 fps clamp at N=2. Never a default; it exists to price
 *              the instrument (it issues zero fence polls) and to be the even arm the lock has to
 *              match.
 *   `observe`  the UNPACED arm with the instrument on: every want renders, exactly as unflagged,
 *              and every channel is booked. It is the arm that answers, per resolution, with four
 *              numbers on one line: `UngatedGapMs` (the ungated callback cadence — this must equal
 *              the harness's `ticks/s`), `RenderedGapMs` (the same quantity measured per rendered
 *              tick, which on THIS arm must agree with it, and that agreement is the instrument's
 *              self-check), `SoloMs` and `SatGapMs` (the two present-coupled fence readings the old
 *              estimators were built out of). It PERTURBS — one `clientWaitSync` per tick, with the
 *              flush bit — so it is a diagnostic, never a timing cell.
 */

/** How the gate decides. `null` is `?tick-pace=off` - the UNPACED CONTROL, every tick that wants to
 *  render renders, and it is no longer what an unflagged engine holds. See `TickPaceDefault`. */
export type TickPaceMode =
  /** Release a render only on a whole number of vsyncs, chosen from the OBSERVED ungated callback
   *  cadence. The flag's meaning. `Depth` is the fence safety net underneath it; `Vsync` pins the
   *  display interval in ms when `?tick-pace=lock:V` named one, and is null when it is derived;
   *  `Live` selects `RenderedGapMs` as the live period instead of re-observation windows. */
  | { Kind: 'lock'; Depth: number; Vsync: number | null; Live: boolean }
  /** Poll the rendered frames' GPU fences; skip while more than `Depth` of them are outstanding.
   *  THE DEFAULT at `Depth` 1 (`TickPaceDefault`), by Jack's ruling: adaptive without estimating
   *  anything, never worse than unpaced at either resolution, and pixel-identical. Trimodal at
   *  dpr 2 (the 16.7/33.3 alternation is its whole cost) and the outright best arm at dpr 1.5. */
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
 *   `warmup`       the FIRST observation window, at boot. The seed came from this.
 *   `window`       a later re-observation window.
 *   `live`         `?tick-pace=lock:live` only — the rendered-tick-to-next-callback interval, read
 *                  under the lock with no window at all.
 *   `unsaturated`  a window closed and its verdict was that the interval it measured was NOT
 *                  occupied — the loop was waiting on BeginFrame or on the display, not on work. N
 *                  is 1 and `PeriodMs` is 0, because the cadence that window measured is a callback
 *                  rate and not a render period. The measured number is still published, as
 *                  `UngatedGapMs`, so nothing is hidden. That is the phone, and it is also any scene
 *                  whose render fits inside one vsync.
 *   `gap`          a non-lock polling arm (`fence`, `observe`) publishing the mean saturated
 *                  completion gap it happened to see. PRESENT-COUPLED and no controller reads it;
 *                  it is in the ledger only so the over-read stays priced.
 */
export type PacePeriodSource = 'none' | 'warmup' | 'window' | 'live' | 'unsaturated' | 'gap';

/** Why an observation window opened, and what became of it. For the trace. */
export type PaceWindowReason = 'warmup' | 'dwell' | 'refusals' | 'scene';
export type PaceWindowPhase = 'open' | 'close' | 'abandoned';

/**
 * One retired frame-completion fence, as the renderer reports it.
 *
 * NOTHING HERE IS A RENDER PERIOD, and this lane is the one that says so from the pipeline rather
 * than from a correlation. `WebGL2Renderer._armPaceFence` places the fence in `EndFrame`, which runs
 * AFTER `PresentScene` has blitted the scene FBO into the default framebuffer. On ANGLE's Metal
 * backend `glFenceSync` appends a `MTLSharedEvent` signal to the CURRENT command buffer, and that
 * command buffer is the one the frame's drawable present rides: Chromium commits it at the end of
 * the worker task with the drawable attached, so the event signals when the command buffer
 * COMPLETES, and a command buffer carrying a `presentDrawable:` does not complete until the drawable
 * has been acquired and handed to the compositor. The drawable pool is finite, so the acquire is
 * display-quantised — which is the ~2-vsync floor `SoloMs` reads identically at both resolutions.
 *
 * CAN ANY PLACEMENT INSIDE THE FRAME AVOID IT? There IS an earlier point — `Jaui._render` calls
 * `r.PresentScene()` and only then `r.EndFrame()`, so a fence armed before the present would cover
 * the whole scene walk and not the final blit. It would still not help by itself: the fence and the
 * present would sit in the SAME command buffer, so the signal still lands after the present. It
 * would take an explicit `glFlush` between them to commit the scene's command buffer on its own,
 * and that buys a second submit per frame (the pyramidatlas lane priced an encoder at ~69 us) and
 * changes what the number means (scene work, present blit excluded). It is not worth it, because
 * the instrument this lane uses — the ungated callback cadence — reads the render period with no GL
 * at all. The fence stays what it is: a depth cap, and the two latency channels below stay in the
 * ledger only to keep the over-read priced.
 */
export interface PaceFenceSample {
  /** Arm to the poll that retired it. The existing `FenceMs` ledger field, unchanged. */
  Ms: number;
  /** Previous retirement to this one. PRESENT-COUPLED when frames are queued (`MaxInFlight` 5 on
   *  the observe arm read 54.9 against a 50.47 frame), so it is the present cadence, not the
   *  execution period. 0 when there is no previous retirement to measure from. */
  GapMs: number;
  /** Was the GPU free of our frames when this fence was armed? Instrument only: it splits the two
   *  latency channels so `SoloMs` and `SatGapMs` stay separable. */
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
 * IT DOES NOT APPLY INSIDE AN OBSERVATION WINDOW. A window is the unflagged loop, and the unflagged
 * loop is depth-infinity — that is the whole point of it, and it is why the ungated cadence the
 * window measures is the same quantity the harness reads as `ticks/s` on an unflagged arm.
 */
export const PACE_DEFAULT_DEPTH = 1;

/**
 * THE MODE AN UNFLAGGED ENGINE HOLDS - the depth-1 fence, by the pacing ruling at the top of this
 * file. `?tick-pace` (bare) and `?tick-pace=fence` parse to exactly this, so the unflagged arm and
 * those two flagged ones are ONE instrument and a pixel gate between them is a gate on a console
 * line and nothing else.
 *
 * A FACTORY, not a frozen constant, for one reason: two engines can share a page and a mode object
 * that travelled between them would make `Mode === Mode` mean something, which is a comparison no
 * reader should be able to write. Read `Kind` and `Depth`.
 */
export const TickPaceDefault = (): TickPaceMode => ({ Kind: 'fence', Depth: PACE_DEFAULT_DEPTH });

/** The deepest `?tick-pace=fence:D` will accept. Past this the gate is not pacing anything: the
 *  unflagged engine is depth-infinity, and a cell at depth 4 would be measuring it. */
export const PACE_MAX_DEPTH = 3;

/** How many fences the renderer keeps. One more than the deepest gate can hold outstanding, so the
 *  ring never drops a fence the gate is still counting on. An observation window is ungated and can
 *  fill it (the observe arm measured `MaxInFlight` 5) — the renderer drops the OLDEST, which is the
 *  least interesting one, and the window reads occupancy off the count rather than off a sample. */
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
 * ledger, so a healthy run still cannot reach it.
 */
export const PACE_STALL_MS = 100;

/** The most vsyncs `lock` will hold a frame for. Eight is 133 ms at 60 Hz: past that the engine is
 *  not being paced, it is being throttled, and the number to fix is the render. */
export const LOCK_MAX_N = 8;

/**
 * Callbacks one OBSERVATION WINDOW runs for, with the gate fully open — and THE FILL TRANSIENT IS
 * WHY IT IS THIS LONG, which is the one number in this file a shorter brief would have got wrong.
 *
 * An ungated loop does not tick at the render period immediately. Chromium keeps issuing BeginFrame
 * on the display grid until enough of our commits are unacknowledged (the observe arm measured
 * `MaxInFlight` 5), and only then does the callback rate fall back to the ACK rate, which is the
 * completion rate, which is the render period. Opening the gate after a lock leaves the queue
 * empty, so a window starts on the DISPLAY grid and takes about `cap / (1/vsync - 1/period)`
 * milliseconds to reach the period — ~250 ms at the M4's dpr 2 (five frames at 0.02 frames/ms).
 * A twelve-callback window would have spent all of itself inside that transient and read 16.67,
 * which hands dpr 2 N=1 and the fence arm's judder: the exact opposite of tickpace5's failure and
 * just as wrong.
 *
 * So: twenty-four callbacks, the first `WINDOW_WARMUP_SKIP` intervals discarded, and the period
 * read as the mean of the LAST HALF of what is left. At dpr 2 that is ~500 ms of window of which
 * the last ~11 intervals are all in the steady state. THE PRICE, doubled and said plainly: the page
 * spends ~500-700 ms at the UNFLAGGED cadence per window — at dpr 2 ~20 presented frames at the
 * base's 3v instead of the lock's 2v — once per dwell, and the dwell doubles to a minute while the
 * answer holds.
 *
 * THE RESIDUAL, named rather than hidden: a render only a few percent over one vsync fills the
 * queue too slowly for ANY affordable window (18.40 against 16.67 is 0.006 frames/ms — five frames
 * takes ~875 ms and ~52 callbacks), so such a scene reads the display grid and holds N=1 with the
 * fence refusing occasionally. That is the STRADDLE behaviour already on the record and already
 * blessed — an occasional 2v frame beats a permanent 30 fps — but it is a limit of the instrument
 * and not a choice. `WindowRising` publishes when a window closed with the queue still filling, so
 * a reader can tell a settled reading from a lower bound.
 */
export const WINDOW_TICKS = 24;

/** Intervals discarded at the head of a window outright. Two: opening the gate after a lock leaves
 *  the queue empty, so the first release completes SOLO and its callback comes back on the display
 *  grid with nothing behind it at all. The fill transient proper is handled by reading the mean
 *  over the last half — see `WINDOW_TICKS` — not by this. */
export const WINDOW_WARMUP_SKIP = 2;

/** How long the cadence holds before the next re-observation window. Eight seconds: at ~300 ms a
 *  window that is ~4% of the time at the unflagged cadence, which is a price a steady page can pay
 *  and a harness window of six seconds will see at most one of. */
export const WINDOW_DWELL_MS = 8000;

/** ...DOUBLING while the answer does not change, to here. A page that has been giving the same N
 *  for a minute stops being asked. Reset to the base by a window that MOVES N, by a canvas-size
 *  change (`NoteSceneChange`) or by a burst of fence refusals — the three things that mean the
 *  answer might be different now. */
export const WINDOW_DWELL_MAX_MS = 64000;

/** A window that has not filled in this long is ABANDONED without a verdict: the page went quiet
 *  mid-window, or the loop is ticking so slowly that the reading would span seconds of unrelated
 *  regimes. Six is what twenty-four callbacks take on the phone's 111-127 ms cadence with room to
 *  spare — and on the phone those are seconds the page would have spent exactly this way anyway,
 *  because a window IS the unflagged loop. */
export const WINDOW_MAX_MS = 6000;

/** The closest two windows may ever be, whatever asks for one. The dwell governs the SCHEDULED
 *  window; this governs the ones EVIDENCE asks for — a refusal burst and a canvas resize — and it
 *  is what stops a resize drag, which changes the canvas size on every single frame, from running
 *  the page permanently ungated. One second against a ~300 ms window bounds the worst case at ~30%
 *  of a drag spent at the unflagged cadence, which is a drag's cadence anyway. */
export const WINDOW_MIN_SPACING_MS = 1000;

/**
 * The share of a window's ticks that must find WORK IN PROGRESS for the cadence it measured to be
 * read as a render period rather than as a callback rate.
 *
 * THIS IS THE DISCRIMINATOR THE PHONE NEEDS, and it exists because the obvious one is not
 * observable. The brief's `ticks/frame` — two renders per presented frame on the M4, one on the
 * phone — cannot be computed inside the worker: there is NO presentation signal there (rAF is
 * BeginFrame-on-submission, which is the finding this whole file rests on), so the engine cannot
 * count presented frames at all. What it can count is OCCUPANCY, and two channels of it:
 *
 *   GPU   the share of windowed ticks whose poll found at least one of our frames still in flight.
 *         The M4 at dpr 2 (a 25 ms render on a 25 ms cadence) reads ~1.0; the phone (a cheap render
 *         on a 120 ms cadence) reads 0, because every frame has long since retired.
 *   CPU   `_render`'s own wall time over the measured interval. A CPU-BOUND loop — 25 ms of issuing
 *         with a GPU that always wins — reads ~1.0 on this channel and 0 on the GPU one, and its
 *         cadence IS its period, so it must classify as occupied. The M4 at dpr 2 reads 0.02 here
 *         (`RenderMs` 0.6) and is caught by the GPU channel instead.
 *
 * Either channel over a half is enough. Both under it means the interval contained IDLE — the loop
 * was waiting for BeginFrame or for the display — and the measured cadence is not a render period.
 * Both shares are published (`WindowBusyShare`, `WindowCpuShare`) so a verdict can be re-judged
 * from the ledger instead of believed.
 *
 * THE RESIDUAL, named: the test is binary. A window that classifies as occupied has its WHOLE
 * cadence taken as the period, including whatever idle BeginFrame latency is inside it. A device
 * that is BOTH slow to wake and genuinely busy therefore over-reads, and the two shares are the
 * numbers that say by how much.
 */
export const WINDOW_BUSY_SHARE = 0.5;

/** Fence refusals inside `LOCK_STEPUP_WINDOW_MS` that mean SOMETHING CHANGED — the scene got more
 *  expensive than the cadence in force. NOT a step-up: the refusal opens an observation window and
 *  the window decides, in either direction. A rate, not a consecutive run: at 60 Hz callbacks a
 *  badly overrun cadence produces one refusal between releases and at 120 Hz it produces three, so
 *  a consecutive bar of three would fire on one machine and never on the other. That is the same
 *  trap `PACE_STALL_MS` was added to this file to close. */
export const LOCK_STEPUP_REFUSALS = 3;

/** ...and the window they must fall inside. Half a second: recent enough that a refusal from two
 *  scenes ago cannot help re-time this one, long enough to hold three at any callback cadence. */
export const LOCK_STEPUP_WINDOW_MS = 500;

/** How far under a vsync boundary an observed period must fall before N takes the lower step, as a
 *  share of one vsync. 10% of a vsync is 1.7 ms at 60 Hz: wide enough to swallow the residual
 *  quantisation in a mean over ten callbacks, narrow enough that a genuinely 2-vsync render is
 *  never mistaken for a 1-vsync one. It is what holds N=1 on a ~17 ms render (17 < 16.67 + 1.67)
 *  instead of flapping to N=2. */
export const LOCK_MARGIN_SHARE = 0.10;

/** Floor between two committed N changes, in ms. It governs the refusal-triggered window as well as
 *  the live path, so neither can ratchet the cadence eight times in eight frames. */
export const LOCK_CHANGE_MS = 250;

/** How early a tick may release a render, as a share of one vsync. The gate can only act on a tick,
 *  and the tick grid is NOT the vsync grid (96 Hz callbacks were measured on a 60 Hz panel), so a
 *  strict "at or after" would round every release up to the next tick and turn a 33.3 ms cadence
 *  into a 41.6 ms one. Releasing slightly early is free — the compositor presents at the following
 *  vsync either way — while releasing late costs a whole vsync. Capped well under half a vsync so
 *  a release can never land in the PREVIOUS vsync's window and pair up with the frame before it. */
export const LOCK_EARLY_SHARE = 0.4;

/** `?tick-pace=lock:live` only. The EMA weight on `RenderedGapMs`, and the fewest samples under the
 *  current cadence before it may move N. A fifth is ~14 intervals of memory, which at a 33.3 ms
 *  cadence is under half a second — fast enough to be a LIVE control and slow enough that one
 *  hitched callback does not move a cadence. */
export const LIVE_EMA_ALPHA = 0.2;
export const LIVE_MIN_SAMPLES = 8;

/** ...and how many consecutive evaluations must agree on a different N before the live path takes
 *  it. Eight releases is ~270 ms at a 33.3 cadence. Hysteresis, because a live reading has no
 *  window boundary to make it settle. */
export const LOCK_LIVE_HOLD = 8;

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

/** Readings kept for one observation window. One more than a window produces, so nothing a window
 *  measured can be pushed out of it by the window itself. */
const WINDOW_RING = WINDOW_TICKS + 4;

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
 * Not an EMA (outside the live path, which says so in its name). An EMA has a memory that outlives
 * the cadence it was taken under, and two lanes now exist because a smoothed number from the wrong
 * regime chose the cadence. Everything here is a bounded window of raw observations that gets
 * THROWN AWAY when the regime changes.
 *
 * `Mean` is what a period is read with — the ungated callback cadence is vsync-quantised, so a
 * 25.0 ms period arrives as a mixture of 16.67 and 33.3 in the proportion that averages to 25.0,
 * and a median would snap to whichever grid point happened to win. `Median` is for the published
 * CPU cost, where a single hitch should not move the number a human reads.
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

  /** The mean of the LAST `k` pushes, in order. Valid only while the ring has not wrapped, which is
   *  what `WINDOW_RING` guarantees for the one caller that needs it: a window pushes strictly fewer
   *  readings than the ring holds, so `_v` is chronological for its whole life. It is how the
   *  period is read past the pipeline fill transient — see `WINDOW_TICKS`. */
  MeanTail = (k: number): number => {
    const n = Math.min(Math.max(Math.floor(k), 1), this._v.length);
    if (n === 0) return 0;
    let sum = 0;
    for (let i = this._v.length - n; i < this._v.length; i++) sum += this._v[i];
    return sum / n;
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
 *     (no flag)               THE DEPTH-1 FENCE — the shipping default, `TickPaceDefault()`
 *     ?tick-pace              the same gate, named: identical pacing, and in `Jaui.ts` it is what
 *                             turns the once-a-second `[Jaui.pace]` line on
 *     ?tick-pace=off          THE UNPACED LOOP — also `=none` and `=0`. No fence, no poll, no gate.
 *                             The engine's loop before pacing existed, and the control arm.
 *     ?tick-pace=fence        the default, spelled out
 *     ?tick-pace=fence:D      the fence gate at depth D (0..PACE_MAX_DEPTH)
 *     ?tick-pace=lock         THE VSYNC LOCK at the default depth — a MEASUREMENT flag now, kept
 *                             because its mechanism is right and only its period was ever wrong
 *     ?tick-pace=lock:V       the lock with the vsync PINNED to V ms — the control that proves a
 *                             derived estimate right or wrong in the same binary
 *     ?tick-pace=lock:live    the lock taking its period from `RenderedGapMs` instead of from
 *                             re-observation windows — refuted on the M4, kept as the refutation
 *     ?tick-pace=lock:live:V  ...with the vsync pinned as well
 *     ?tick-pace=observe      pace NOTHING, instrument everything — the arm that prices the ungated
 *                             callback cadence against the two present-coupled fence readings
 *     ?tick-pace=N            the fixed ratio, N >= 2 — a CLAMP and a measurement arm
 *
 * Anything else is refused, WITH A REASON, because an instrument that quietly did nothing would
 * publish some other arm's number under this flag's name. What a REFUSED value falls back to is
 * `Jaui.ts`'s decision and it is the DEFAULT, not `off`: a typo must not be able to move a page
 * onto the control arm silently.
 */
export const ParseTickPace = (raw: string | null): { Mode: TickPaceMode | null } | { Why: string } => {
  const v = (raw ?? '').trim();
  // No flag at all and the bare flag are THE SAME GATE. The bare spelling is not a synonym kept for
  // politeness: it is how an operator asks for the default's ledger on the console without changing
  // a single decision, which is what makes "unflagged vs `?tick-pace`" a zero-pixel gate.
  if (v === '') return { Mode: TickPaceDefault() };
  // THE CONTROL ARM, and it is the ABSENCE of a mode rather than a mode: `null` arms no fence,
  // polls nothing, gates nothing, and `NoteTick` returns before it measures. Three spellings because
  // this is the arm every future cell's "before" column is taken on and it has to be unmissable.
  if (v === 'off' || v === 'none' || v === '0') return { Mode: null };
  if (v === 'lock') {
    return { Mode: { Kind: 'lock', Depth: PACE_DEFAULT_DEPTH, Vsync: null, Live: false } };
  }
  if (v.startsWith('lock:')) {
    let tail = v.slice('lock:'.length);
    const live = tail === 'live' || tail.startsWith('live:');
    if (live) tail = tail.slice(tail === 'live' ? 'live'.length : 'live:'.length);
    if (tail === '') {
      // `lock:live` with no pin is the whole point of the switch; `lock:` with nothing at all is the
      // trap `Number('')` sets, and a zero vsync would divide the cadence by nothing.
      if (live) return { Mode: { Kind: 'lock', Depth: PACE_DEFAULT_DEPTH, Vsync: null, Live: true } };
      return { Why: 'lock-vsync-must-be-a-number-of-ms-4-to-40-or-live' };
    }
    const ms = Number(tail);
    if (!Number.isFinite(ms) || ms < 4 || ms > 40) {
      return { Why: 'lock-vsync-must-be-a-number-of-ms-4-to-40-or-live' };
    }
    return { Mode: { Kind: 'lock', Depth: PACE_DEFAULT_DEPTH, Vsync: ms, Live: live } };
  }
  if (v === 'observe') return { Mode: { Kind: 'observe' } };
  if (v === 'fence') return { Mode: { Kind: 'fence', Depth: PACE_DEFAULT_DEPTH } };
  if (v.startsWith('fence:')) {
    const tail = v.slice('fence:'.length);
    // `Number('')` is 0, so an empty depth would otherwise parse as the serial gate and a typo
    // would silently select a different instrument.
    if (tail === '') return { Why: `fence-depth-must-be-a-whole-number-0-to-${PACE_MAX_DEPTH}` };
    const d = Number(tail);
    if (!Number.isInteger(d) || d < 0 || d > PACE_MAX_DEPTH) {
      return { Why: `fence-depth-must-be-a-whole-number-0-to-${PACE_MAX_DEPTH}` };
    }
    return { Mode: { Kind: 'fence', Depth: d } };
  }
  const n = Number(v);
  if (!Number.isInteger(n)) return { Why: 'value-must-be-off-fence-lock-observe-or-a-whole-number-of-ticks' };
  // Not malformed - it is the control arm under another name, and it has one now.
  if (n === 1) return { Why: 'n-1-renders-every-tick-which-is-tick-pace-off' };
  if (n < 1) return { Why: 'n-must-be-at-least-2' };
  return { Mode: { Kind: 'ratio', N: n } };
};

/** How a mode prints in `jaui:tick-pace armed=<mode>` and on the `[Jaui]` line. The depth, the
 *  pinned vsync and the live switch are part of the name because two cells taken under different
 *  ones are two different instruments. The live N is NOT in the name — it moves, and it is its own
 *  ledger field. */
export const TickPaceText = (mode: TickPaceMode | null): string => {
  if (mode === null) return 'off';
  if (mode.Kind === 'lock') {
    const head = mode.Live ? 'lock:live' : 'lock';
    return mode.Vsync === null ? head : `${head}:${Round2(mode.Vsync)}`;
  }
  if (mode.Kind === 'observe') return 'observe';
  if (mode.Kind === 'fence') return `fence:${mode.Depth}`;
  return `ratio:${mode.N}`;
};

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
  /** The cadence the lock has COMMITTED to. It cannot differ from `LockN` any more — tickpace5's
   *  trials, the only thing that moved one without the other, are gone — and it is still published
   *  so a reader of two cells does not have to know that. */
  LockCommittedN: number;
  /** How many times the cadence moved, the seed included. A cell whose count is still rising is a
   *  cell taken while the page was still changing. */
  LockChanges: number;
  /** The OBSERVED render period the cadence was chosen from. `PeriodSource` says which window it
   *  came from. 0 means nothing has been observed OR the verdict was `unsaturated` — read
   *  `UngatedGapMs` for the number that window actually measured. NEVER a fence reading. */
  PeriodMs: number;
  /** Which observation `PeriodMs` came from. */
  PeriodSource: PacePeriodSource;
  /** How long ago that observation closed, in ms. -1 when there has never been one. An OLD number
   *  here is the design working on the window path (while the lock is holding there is nothing to
   *  observe) and a fresh one is the design working on `lock:live`. */
  PeriodObservedAt: number;
  /** Observation windows OPENED, the warm-up included. In a 6 s harness window at the base dwell a
   *  settled page opens at most one. */
  Windows: number;
  /** The last window's mean callback interval, with the gate fully open — THE INSTRUMENT. On the
   *  `observe` arm, where the gate is never closed, it is a rolling mean and must equal the
   *  harness's `ticks/s`. 0 before the first window closes. */
  UngatedGapMs: number;
  /** EMA of the interval from a RENDERED tick to the next callback, published on every arm and
   *  read by nothing unless `?tick-pace=lock:live` armed it. Under the lock this is the quantity
   *  that is either the live render period or the display cadence, and the M4 says which. */
  RenderedGapMs: number;
  /** The last window's two occupancy shares — the discriminator that stands in for the
   *  unobservable `ticks/frame`. See `WINDOW_BUSY_SHARE`. On the `observe` arm, whose window never
   *  closes, they are live. */
  WindowBusyShare: number;
  WindowCpuShare: number;
  /** Did the last window close with the queue STILL FILLING? Then `UngatedGapMs` is a lower bound
   *  on the period and not a reading of it — see `WINDOW_TICKS`. A settled cell reads false. */
  WindowRising: boolean;
  /** DIAGNOSTIC, never read by a decision. Mean SOLO fence latency, de-quantized by half the poll
   *  gap. PRESENT-COUPLED: it read 31.9 and 30.9 at two resolutions that differ by 44% of the pixel
   *  work, which is how this lane knows it is a latency floor and not an execution time. */
  SoloMs: number;
  /** DIAGNOSTIC. Mean queued completion-to-completion gap — the PRESENT cadence as the fence sees
   *  it (54.9 against a 50.47 frame on the observe arm), not the render period. */
  SatGapMs: number;
  /** Median wall time of `_render` on the worker: the CPU's issuing half. It is published as a
   *  diagnostic AND it is the CPU channel of the window classifier — the only evidence a CPU-bound
   *  loop leaves. It is never a period: the period is always the measured cadence. */
  RenderMs: number;
  /** The display interval the lock is quantizing to, derived or pinned. */
  VsyncMs: number;
  /** Was `VsyncMs` measured, or is it still the fallback? A cell taken on the fallback is a cell
   *  whose grid was assumed — and a window will not close with a verdict until it is measured. */
  VsyncDerived: boolean;
  /** Skips the LOCK took (the tick came early). Normal, and the larger the tick rate the larger
   *  this is — three per render at 120 Hz ticks and N=2. */
  LockSkipped: number;
  /** Skips the FENCE took. Under a correct lock this is ~0, and a burst of them OPENS A WINDOW
   *  rather than moving N — the fence is a depth cap and a trigger, never an estimate. */
  FenceSkipped: number;
}

/** One observation window in flight. Null when the gate is doing its job. */
interface PaceWindow {
  Reason: PaceWindowReason;
  OpenedAt: number;
  /** The `observe` arm's window, which never closes and never reaches a verdict: the gate there is
   *  open by definition, so the same ring that measures a lock's window measures its cadence for
   *  the whole run. A flag rather than a sentinel timestamp, because the first rAF timestamp of a
   *  test loop is legitimately 0. */
  Permanent: boolean;
  /** Frames outstanding at each windowed poll, in order. Bounded by `WINDOW_TICKS`. Two things are
   *  read off it: the GPU occupancy share, and whether the queue was STILL FILLING when the window
   *  closed (`WindowRising`), which is what separates a settled reading from a lower bound. */
  readonly InFlight: number[];
  /** `_render`'s wall time inside it, summed, for the CPU occupancy channel. */
  CpuMs: number;
  CpuN: number;
  /** Callback intervals after a rendered tick — the instrument. The first `WINDOW_WARMUP_SKIP` are
   *  counted and discarded. */
  Seen: number;
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
   *  tick cadence BY DESIGN — and an observation window contributes to bucket 0, because inside one
   *  the gate is open and no tick waits. */
  readonly WaitedTicks: PaceWaited = [0, 0, 0, 0];

  /** Fence latency: how long from arming a fence to the poll that found it signalled. The mean over
   *  a window is `(Sum2-Sum1)/(N2-N1)`. Zero in the ratio mode, which never polls. */
  FenceSamples = 0;
  FenceMsSum = 0;
  FenceMsMax = 0;

  /** High-water mark of frames outstanding on the GPU. At depth D a working gate reaches D+1; an
   *  observation window is ungated and can reach the renderer's whole ring. */
  MaxInFlight = 0;

  /** The cadence in vsyncs. Starts at 1, which is the state the warm-up window observes in — and
   *  N=1 plus the depth-1 fence is also the safe cadence if a window never produces a verdict. */
  LockN = 1;
  /** Kept as its own field so `lockN=2/2` stays readable across cells; nothing moves one without
   *  the other now that trials are gone. */
  LockCommittedN = 1;
  LockChanges = 0;
  LockSkipped = 0;
  FenceSkipped = 0;
  Windows = 0;

  /** Called when the cadence moves, so the trace can say so without this file importing one. The
   *  period and its source ride along: an N change whose source is `unsaturated` was chosen by a
   *  classification, not by a period, and a reader must be able to tell. */
  OnLockChange: ((n: number, periodMs: number, vsyncMs: number, source: PacePeriodSource) => void) | null = null;
  /** Called at each end of an observation window. A window deliberately runs the page at the
   *  unflagged cadence for ~300 ms, so it says so on the trace every time — a report that sees a
   *  slow patch in a window can tell a re-observation from a regression. */
  OnWindow: ((phase: PaceWindowPhase, reason: PaceWindowReason, meanMs: number, source: PacePeriodSource) => void) | null = null;

  private readonly _vsync = new VsyncEstimator();

  /** The window's callback intervals — the ONE measurement a cadence is ever chosen from. */
  private readonly _window = new Samples(WINDOW_RING);
  /** Fence refusals, timestamped, for the "something changed" trigger. */
  private readonly _refusals = new Samples(WINDOW_RING);

  /** The published diagnostics. `_cpuDiag` is also the classifier's CPU channel; the two fence
   *  channels are read by nothing at all. */
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
  /** When a render last ran, so the stall guard can be a duration instead of a tick count. */
  private _lastRenderAt = 0;
  /** The latest clock reading this object has seen, so `Census` can age the period without every
   *  caller of it having to hold a timestamp. */
  private _now = 0;

  /** THE INSTRUMENT, per tick. `NoteTick` fires on every callback; `_allow` sets the flag; the next
   *  `NoteTick` turns the pair into one interval. Both quantities in this file — the window's
   *  ungated cadence and `RenderedGapMs` — are that same interval, measured with the gate open and
   *  with it closed. */
  private _tickAt = 0;
  private _tickRendered = false;
  private _renderedGap = 0;
  private _renderedGapN = 0;

  /** The observation the cadence rests on. */
  private _periodMs = 0;
  private _periodAt = 0;
  private _periodSource: PacePeriodSource = 'none';

  /** Window state. `_open` is null whenever the gate is doing its job. */
  private _open: PaceWindow | null = null;
  private _lastWindowAt = 0;
  private _dwellMs = WINDOW_DWELL_MS;
  private _seeded = false;
  private _lastMeanMs = 0;
  private _lastBusyShare = 0;
  private _lastCpuShare = 0;
  private _lastRising = false;
  /** The canvas resized since the last window. See `NoteSceneChange`. */
  private _sceneDirty = false;

  /** One windowed poll: the queue depth it saw. A ROLLING window of the last `WINDOW_TICKS`, so the
   *  `observe` arm — whose window never closes — keeps a live occupancy share, and so a lock window
   *  that runs a little long compares its own late polls against its own early ones. */
  private _noteWindowPoll = (open: PaceWindow, inFlight: number): void => {
    open.InFlight.push(inFlight);
    if (open.InFlight.length > WINDOW_TICKS) open.InFlight.shift();
  };

  /** The share of a poll population that found work in flight. */
  private static _BusyShare = (flight: readonly number[]): number => {
    if (flight.length === 0) return 0;
    let busy = 0;
    for (const f of flight) if (f > 0) busy++;
    return busy / flight.length;
  };

  /** The last window's shares — or, on the `observe` arm whose window never closes, the open one's,
   *  so the diagnostic arm publishes the same two numbers a verdict is read from. */
  private _busyShare = (): number =>
    this._open !== null && this._open.Permanent
      ? TickPace._BusyShare(this._open.InFlight)
      : this._lastBusyShare;

  private _cpuShare = (): number => {
    const open = this._open;
    if (open === null || !open.Permanent) return this._lastCpuShare;
    const mean = this._window.Mean();
    return mean > 0 && open.CpuN > 0 ? (open.CpuMs / open.CpuN) / mean : 0;
  };

  /** `lock:live` hysteresis: consecutive evaluations that agreed on a cadence other than the one in
   *  force. */
  private _liveHold = 0;
  private _liveWant = 0;

  private _lastChangeAt = 0;

  constructor(mode: TickPaceMode | null) {
    this.Mode = mode;
    // The `observe` arm is an observation window that never closes: the gate is open by definition,
    // so the same ring that measures a lock's window measures its cadence continuously. That is
    // what makes `UngatedGapMs` on that arm directly comparable with the harness's `ticks/s`, and
    // what makes its agreement with `RenderedGapMs` the instrument's self-check.
    if (mode !== null && mode.Kind === 'observe') {
      this._open = {
        Reason: 'warmup', OpenedAt: 0, Permanent: true, InFlight: [], CpuMs: 0, CpuN: 0, Seen: 0,
      };
    }
  }

  /** Every tick, before the gate — the vsync estimate is a property of the CALLBACKS, so it has to
   *  see the ones that do not want to render too, and so does the instrument: the interval this
   *  closes starts at the PREVIOUS tick, whatever this one goes on to do. */
  NoteTick = (time: number): void => {
    if (this.Mode === null) return;
    this._now = time;
    this._vsync.Note(time);
    const prevAt = this._tickAt;
    const prevRendered = this._tickRendered;
    this._tickAt = time;
    this._tickRendered = false;
    if (!prevRendered || prevAt <= 0) return;
    const gap = time - prevAt;
    // A gap past the hitch bound is a stall, a tab restore or a park the caller failed to declare,
    // and none of those is a cadence.
    if (!(gap > 0 && gap < GPU_SAMPLE_MAX_MS)) return;
    this._renderedGap = this._renderedGapN === 0
      ? gap
      : this._renderedGap + LIVE_EMA_ALPHA * (gap - this._renderedGap);
    this._renderedGapN++;
    const open = this._open;
    if (open === null) return;
    open.Seen++;
    // The head of a window is thrown away: with the queue empty the first release completes SOLO,
    // so its callback comes back on the display grid instead of on the submission and would read
    // the vsync rather than the period.
    if (open.Seen > WINDOW_WARMUP_SKIP) this._window.Push(gap, time);
  };

  /** Does the engine need to time `_render` for this mode? The lock reads it as the classifier's
   *  CPU channel and the observe arm publishes it; a `performance.now()` pair per frame is not paid
   *  on an arm that would not read it. */
  get WantsRenderCost(): boolean {
    const m = this.Mode;
    return m !== null && (m.Kind === 'lock' || m.Kind === 'observe');
  }

  /** The wall time `_render` took, in ms. Diagnostic, and the CPU occupancy channel of an open
   *  window — see `WINDOW_BUSY_SHARE`. */
  NoteRenderCost = (ms: number): void => {
    if (!(ms > 0 && ms < GPU_SAMPLE_MAX_MS)) return;
    this._cpuDiag.Push(ms, this._now);
    const open = this._open;
    if (open !== null) { open.CpuMs += ms; open.CpuN++; }
  };

  /**
   * The loop PARKED, so the callback that closes the interval after the last render is a WAKE and
   * not a cadence. Declared by the caller rather than inferred, because nothing inside this file
   * can tell a 300 ms idle gap from a 300 ms frame. An open window is abandoned: the page stopped
   * doing the work the window was measuring, so there is no verdict to be had.
   */
  NotePark = (): void => {
    const mode = this.Mode;
    this._tickRendered = false;
    if (mode === null || mode.Kind !== 'lock' || this._open === null) return;
    this._abandonWindow(this._now);
  };

  /**
   * The canvas changed size — the one scene-change signal this engine actually has.
   *
   * SAID PLAINLY, because the brief asked: there is NO reliable per-frame scene-population signal to
   * hook. `Jaui._counts.Panels/Glass/Text/Image` look like one and are not — they are reset only
   * when the debug HUD or the console profiler is on, so under a plain pacing arm they accumulate
   * across the whole run and say nothing about this frame. A canvas resize is exact and free
   * (`_applySize` already runs on the tick), so that is what resets the dwell. The OTHER kind of
   * scene change — the same canvas drawing more — reaches the controller through the fence: a
   * cadence that has become too fast starts refusing, and a burst of refusals opens a window.
   */
  NoteSceneChange = (): void => {
    const mode = this.Mode;
    if (mode === null || mode.Kind !== 'lock') return;
    this._dwellMs = WINDOW_DWELL_MS;
    this._sceneDirty = true;
  };

  /** The OBSERVED render period. 0 when nothing has been observed or the last window classified the
   *  cadence it measured as a callback rate rather than a render period — `UngatedGapMs` carries
   *  the measurement either way. On a non-lock polling arm this is the fence's present-coupled gap,
   *  which no controller reads. */
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

  /** The last window's mean ungated callback interval. On the `observe` arm the window never
   *  closes, so this is the rolling mean and it is the number that must equal `ticks/s`. */
  get UngatedGapMs(): number {
    const m = this.Mode;
    if (m !== null && m.Kind === 'observe') return this._window.Mean();
    return this._lastMeanMs;
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
    if (mode.Kind === 'observe') {
      const open = this._open;
      if (open !== null) this._noteWindowPoll(open, this._inFlight);
      return this._allow('render', time);
    }

    const inFlight = this._inFlight;
    // THE DEFAULT, at `Depth` 1: wait for the last frame to finish before starting the next. Three
    // lines, no estimate, and nothing below this branch runs on an unflagged page.
    if (mode.Kind === 'fence') {
      if (inFlight <= mode.Depth) return this._allow('render', time);
      if (this._stalled(time)) { this.Forced++; return this._allow('forced', time); }
      return this._refuse('fence');
    }

    // THE LOCK.
    const vsync = this.VsyncMs;

    // Is a window DUE? Asked on every wanting tick and not only on a released render, and the boot
    // case is why: a scene whose very first frames back the pipeline up gets fence-refused before
    // it has ever released anything, so a schedule that ran only after a release would let the
    // warm-up open THREE REFUSALS LATE — and the warm-up is the one window that must be first.
    if (this._open === null) this._scheduleWindow(time);

    // AN OBSERVATION WINDOW: the gate is FULLY OPEN — no lock test, no fence test, no stall guard,
    // because there is nothing to stall on. This is the unflagged loop for `WINDOW_TICKS` callbacks,
    // and it is the only state in which the callback cadence is the render period.
    const open = this._open;
    if (open !== null) {
      this._noteWindowPoll(open, inFlight);
      this._fillWindow(time, vsync);
      return this._allow('render', time);
    }

    if (this._nextAt === 0) this._nextAt = time;
    // The gate can only act on a tick and the tick grid is not the vsync grid, so a release may run
    // slightly early rather than slip a whole tick. See `LOCK_EARLY_SHARE`.
    const tick = this._vsync.TickMs();
    const early = Math.max(Math.min(tick * 0.5, vsync * LOCK_EARLY_SHARE), 0.25);
    if (time + early < this._nextAt) return this._refuse('lock');

    if (inFlight > mode.Depth) {
      if (this._stalled(time)) {
        // The guard fired, which under the lock means the cadence is faster than the GPU can fill
        // and N has not caught up. Re-anchor and open a window HERE as well, or a loop that never
        // gets a clean release could only ever force.
        this.Forced++;
        this._maybeWindow(time, 'refusals');
        this._nextAt = time + this.LockN * vsync;
        return this._allow('forced', time);
      }
      const decision = this._refuse('fence');
      this._noteFenceRefusal(time);
      return decision;
    }

    // `lock:live` is the only thing that decides on a RELEASE; the window path decided when its
    // window closed and is holding the answer.
    if (mode.Live && this._seeded) this._judgeLive(time, vsync);
    // Advance the IDEAL grid, not the actual release, so jitter does not accumulate — and re-anchor
    // rather than run a backlog when the loop has been parked or stalled past a whole period.
    this._nextAt += this.LockN * vsync;
    if (this._nextAt <= time) this._nextAt = time + this.LockN * vsync;
    return this._allow('render', time);
  };

  /**
   * Poll the fences and book the ledger. PURE INSTRUMENT, and after this lane that is true in the
   * strongest sense: no number produced here reaches a cadence. The fence answers STOP or GO and
   * counts frames in flight, and that count is the window classifier's GPU occupancy channel — a
   * COUNT, not a latency, which is the distinction the whole `SoloMs` finding turns on.
   *
   * The two latency channels are kept apart because the 1.6x over-read is the difference between
   * them and the ledger has to keep pricing it. Both are coupled to the PRESENT (see
   * `PaceFenceSample`); `SoloMs` reading the same 31 ms at two resolutions that differ by 44% of
   * the pixel work is the proof, and it is on the observe arm of every cell from here on.
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
   * Is a window due? Three schedules, in order of what they mean.
   *
   *   nothing measured yet  DUE NOW. An abandoned warm-up retries on the change floor rather than
   *                         on the dwell, because N=1 with no observation behind it is the one
   *                         state that must not be allowed to persist.
   *   the canvas resized    due at the spacing floor — see `NoteSceneChange` and
   *                         `WINDOW_MIN_SPACING_MS`.
   *   otherwise             the dwell, which doubles while the answer holds.
   *
   * `?tick-pace=lock:live` takes its period from `RenderedGapMs` and opens nothing after the
   * warm-up, which is the whole of what that switch selects.
   */
  private _scheduleWindow = (time: number): void => {
    const mode = this.Mode;
    if (this._seeded && mode !== null && mode.Kind === 'lock' && mode.Live) return;
    const since = this._lastWindowAt === 0 ? Infinity : time - this._lastWindowAt;
    const due = !this._seeded ? LOCK_CHANGE_MS
      : this._sceneDirty ? WINDOW_MIN_SPACING_MS
        : this._dwellMs;
    if (since < due) return;
    const reason: PaceWindowReason = !this._seeded ? 'warmup' : this._sceneDirty ? 'scene' : 'dwell';
    this._sceneDirty = false;
    this._openWindow(time, reason);
  };

  /** Open the gate. Nothing else changes: the ideal grid is re-anchored when the window closes, so
   *  a window cannot leave a backlog behind it. */
  private _openWindow = (time: number, reason: PaceWindowReason): void => {
    this._open = {
      Reason: reason, OpenedAt: time, Permanent: false, InFlight: [], CpuMs: 0, CpuN: 0, Seen: 0,
    };
    this._window.Clear();
    this.Windows++;
    this.OnWindow?.('open', reason, 0, this._periodSource);
  };

  /** ...subject to the change floor, so a refusal burst or a resize storm cannot open one per
   *  frame. */
  private _maybeWindow = (time: number, reason: PaceWindowReason): void => {
    if (this._open !== null) return;
    const mode = this.Mode;
    // `lock:live` opens NO window after the warm-up, not even this one. It is an experimental arm
    // and the cell it exists for is an A/B: an arm that quietly fell back to windows when its own
    // instrument failed would hide exactly the failure the cell is there to find.
    if (this._seeded && mode !== null && mode.Kind === 'lock' && mode.Live) return;
    if (this._lastChangeAt > 0 && time - this._lastChangeAt < LOCK_CHANGE_MS) return;
    if (this._lastWindowAt > 0 && time - this._lastWindowAt < WINDOW_MIN_SPACING_MS) return;
    this._dwellMs = WINDOW_DWELL_MS;
    this._openWindow(time, reason);
  };

  /** Is the window full? Called once per release inside one. A verdict also needs a MEASURED vsync
   *  — a cadence quantized to a grid nobody measured is a cadence chosen on the 60 Hz fallback. */
  private _fillWindow = (time: number, vsync: number): void => {
    const open = this._open;
    if (open === null) return;
    if (this._window.Count() >= WINDOW_TICKS - WINDOW_WARMUP_SKIP && this.VsyncDerived) {
      this._closeWindow(time, vsync);
      return;
    }
    if (time - open.OpenedAt >= WINDOW_MAX_MS) this._abandonWindow(time);
  };

  /**
   * THE VERDICT, and it is the only place in this file that chooses a cadence.
   *
   *   mean          the window's ungated callback interval — the render period, IF the interval was
   *                 occupied. The M4 reads 25.0 at dpr 2 and 16.04 at dpr 1.5 here.
   *   occupancy     `WINDOW_BUSY_SHARE`: was the loop waiting on work, or on a callback? The phone
   *                 is the case this exists for — 111-127 ms between callbacks because BeginFrame is
   *                 slow, not because the GPU is.
   *   N             ceil((mean - margin) / vsync), clamped. At dpr 2: ceil(23.33/16.67) = 2 -> a
   *                 33.3 ms cadence. At dpr 1.5: ceil(14.37/16.67) = 1 -> 16.7, which is the fence
   *                 arm's 16.66 at 1v 100% reproduced BY THE LOCK and is the cell that decides this
   *                 lane. The "is it within a margin of the vsync" test the brief names is the same
   *                 test: a mean at or under vsync + margin gives ceil(<= 1) = 1 by construction.
   */
  private _closeWindow = (time: number, vsync: number): void => {
    const open = this._open;
    if (open === null) return;
    // THE LAST HALF, not the whole window: the head of every window is the pipeline filling, and
    // during the fill the callbacks are still on the display grid. See `WINDOW_TICKS`.
    const kept = this._window.Count();
    const mean = this._window.MeanTail(Math.ceil(kept / 2));
    const flight = open.InFlight;
    const half = flight.length >> 1;
    const busyShare = TickPace._BusyShare(flight);
    const cpuShare = mean > 0 && open.CpuN > 0 ? (open.CpuMs / open.CpuN) / mean : 0;
    const occupied = busyShare >= WINDOW_BUSY_SHARE || cpuShare >= WINDOW_BUSY_SHARE;
    // Was the queue still growing when the window closed? Then the callback rate had not yet fallen
    // back to the ack rate and `mean` is a LOWER BOUND on the period, not a reading of it.
    const rising = flight.length >= 4
      && Math.max(...flight.slice(half)) > Math.max(...flight.slice(0, half));
    const margin = vsync * LOCK_MARGIN_SHARE;
    const n = occupied ? this._clampN(Math.ceil((mean - margin) / vsync)) : 1;
    const source: PacePeriodSource = !occupied ? 'unsaturated' : this._seeded ? 'window' : 'warmup';

    this._open = null;
    this._lastMeanMs = mean;
    this._lastBusyShare = busyShare;
    this._lastCpuShare = cpuShare;
    this._lastRising = rising;
    this._lastWindowAt = time;
    // `unsaturated` publishes a ZERO period on purpose: the number the window measured is a callback
    // rate, and handing it over as `PeriodMs` would be the modelling this lane exists to stop. It is
    // published in full as `UngatedGapMs`.
    this._periodMs = occupied ? mean : 0;
    this._periodAt = time;
    this._periodSource = source;

    const same = this._seeded && n === this.LockCommittedN;
    this._seeded = true;
    // A window that confirms the answer earns a longer rest; one that moves N starts the dwell over,
    // because a page whose cadence has just changed is a page that may change again.
    this._dwellMs = same ? Math.min(this._dwellMs * 2, WINDOW_DWELL_MAX_MS) : WINDOW_DWELL_MS;
    this._commitN(n, time, vsync);
    // Re-anchor the ideal grid on the window's last release, so the first locked release after a
    // window is one cadence away and not a backlog of them.
    this._nextAt = time + this.LockN * vsync;
    this._liveHold = 0;
    this._renderedGapN = 0;
    this.OnWindow?.('close', open.Reason, mean, source);
  };

  /** The page stopped doing the work the window was measuring. No verdict, no N change, and the
   *  dwell starts over so the next attempt is soon rather than in a minute. */
  private _abandonWindow = (time: number): void => {
    const open = this._open;
    if (open === null) return;
    this._open = null;
    this._window.Clear();
    this._lastWindowAt = time;
    this._dwellMs = WINDOW_DWELL_MS;
    this._nextAt = time + this.LockN * this.VsyncMs;
    this.OnWindow?.('abandoned', open.Reason, 0, this._periodSource);
  };

  /**
   * `?tick-pace=lock:live`. No windows after the warm-up: N comes from `RenderedGapMs`, the interval
   * from a rendered tick to the next callback, which under the lock is still gated on that
   * submission's acceptance — IF the worker's BeginFrame really is submission-gated under a gate
   * that skips ticks. That is the open question this switch exists to settle, and the falsifier is
   * exact: if this path reads ~one vsync at dpr 2 where the window path reads 25.0, the callback
   * after a rendered tick came from the DISPLAY and not from the submission, and this path is dead.
   */
  private _judgeLive = (time: number, vsync: number): void => {
    if (this._renderedGapN < LIVE_MIN_SAMPLES) return;
    const live = this._renderedGap;
    const margin = vsync * LOCK_MARGIN_SHARE;
    const want = this._clampN(Math.ceil((live - margin) / vsync));
    if (want === this.LockCommittedN) { this._liveHold = 0; return; }
    if (want !== this._liveWant) { this._liveWant = want; this._liveHold = 1; return; }
    if (++this._liveHold < LOCK_LIVE_HOLD) return;
    if (this._lastChangeAt > 0 && time - this._lastChangeAt < LOCK_CHANGE_MS) return;
    this._liveHold = 0;
    this._periodMs = live;
    this._periodAt = time;
    this._periodSource = 'live';
    this._commitN(want, time, vsync);
    this._nextAt = time + this.LockN * vsync;
  };

  /**
   * A fence refusal under the lock. It is EVIDENCE THAT SOMETHING CHANGED and nothing else: the
   * cadence in force is faster than the pipeline can fill, which can mean the scene got more
   * expensive OR that the present got slower, and the fence cannot tell those apart — that is the
   * finding this lane is built on. So a burst of them opens an observation window, which can move N
   * in EITHER direction, and `LockN` never moves on a fence reading again.
   */
  private _noteFenceRefusal = (time: number): void => {
    this._refusals.Push(1, time);
    if (this._refusals.Count(time - LOCK_STEPUP_WINDOW_MS) < LOCK_STEPUP_REFUSALS) return;
    this._refusals.Clear();
    this._maybeWindow(time, 'refusals');
  };

  /**
   * Has the fence refused for long enough, in BOTH ticks and milliseconds, to be a stall rather
   * than a GPU doing its job? See `PACE_STALL_TICKS` and `PACE_STALL_MS`.
   *
   * UNDER THE LOCK THE DURATION SCALES WITH THE CADENCE, and this lane is what made that necessary.
   * A locked loop's renders are N vsyncs apart BY DESIGN, so at N=5 an absolute 100 ms is barely
   * one release and means nothing. It matters here because an observation window is UNGATED and
   * leaves the queue as deep as the browser allows: the first locked release after one sits behind
   * that queue while it drains, the fence refuses on every tick until it has, and a guard measured
   * in absolute milliseconds fires on a pipeline that is doing exactly what it was asked to. Eight
   * cadences is the same "an order of magnitude past any real frame" the constant was chosen to
   * mean, expressed in the units the lock actually runs in. The other modes keep the flat floor,
   * because they have no cadence.
   */
  private _stalled = (time: number): boolean => {
    if (this._fenceRun < PACE_STALL_TICKS) return false;
    const mode = this.Mode;
    const floor = mode !== null && mode.Kind === 'lock'
      ? Math.max(PACE_STALL_MS, PACE_STALL_TICKS * this.LockN * this.VsyncMs)
      : PACE_STALL_MS;
    return time - this._lastRenderAt >= floor;
  };

  private _clampN = (n: number): number =>
    Math.min(LOCK_MAX_N, Math.max(1, Number.isFinite(n) ? n : 1));

  /** Commit a cadence. Everything observed under the previous one is thrown away here, because that
   *  is what makes the next reading a reading rather than a blend of two regimes. */
  private _commitN = (n: number, time: number, vsync: number): void => {
    const moved = n !== this.LockCommittedN;
    this.LockCommittedN = n;
    this.LockN = n;
    this._lastChangeAt = time;
    this._refusals.Clear();
    this._renderedGapN = 0;
    if (moved) {
      this.LockChanges++;
      this.OnLockChange?.(n, this._periodMs, vsync, this._periodSource);
    }
  };

  private _allow = (decision: PaceDecision, time: number): PaceDecision => {
    this._lastRenderAt = time;
    this._tickRendered = true;
    const waited = this._skipRun;
    this.WaitedTicks[waited < 3 ? waited : 3]++;
    this._skipRun = 0;
    this._fenceRun = 0;
    this.Rendered++;
    return decision;
  };

  private _refuse = (by: 'lock' | 'fence' | 'ratio'): PaceDecision => {
    this._skipRun++;
    if (by === 'fence') { this._fenceRun++; this.FenceSkipped++; }
    else if (by === 'lock') this.LockSkipped++;
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
      Windows: this.Windows,
      UngatedGapMs: Round1(this.UngatedGapMs),
      RenderedGapMs: Round1(this._renderedGap),
      WindowBusyShare: Math.round(this._busyShare() * 100) / 100,
      WindowCpuShare: Math.round(this._cpuShare() * 100) / 100,
      WindowRising: this._lastRising,
      // MEANS for the two fence readings and a MEDIAN for the CPU one: both fence numbers are
      // timestamped by the POLL that found the fence signalled, so both are quantized to the poll
      // grain and only a mean is unbiased. `_render`'s wall time is read directly and is not
      // quantized, so there a median is the better statistic.
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
