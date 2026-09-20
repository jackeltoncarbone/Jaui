/**
 * `?tick-pace` — pace the render on the GPU instead of on the tick. The arithmetic, with no GL in it.
 *
 * WHY THIS EXISTS (ShowStudio.Documentation/Perf/README.md, "PACING: 66.87 -> 33.48 ms"): the engine
 * rendered TWICE per presented frame at baseline, and removing the second render cut the frame time
 * in half with no pixel change. The M4 measured it, three arms x three, interleaved, dpr 2 —
 *
 *     arm            p50     p95   ticks  frames  renders/frame  gpu/frm  draws/tick
 *     base         66.87   67.38     180      99      1.82         60.49    152.41
 *     tick-pace    50.13   51.64     722     119      1.01         30.44     38.04
 *     tick-pace=2  33.48   35.06     360     178      1.01         33.29     76.59
 *
 * — total draws identical across arms (27,165-28,348) and worstPx 0 in all nine rounds. Same work,
 * different pacing. Renders per presented frame 1.82 -> 1.01 under BOTH flags, and the frame follows
 * the render.
 *
 * TWO THINGS WERE WRONG WITH THAT FIRST CUT, and this file is the second:
 *
 *   1. `?tick-pace=2` IS A 30 fps CLAMP. It reaches 33.48 at dpr 2 only because the natural render
 *      there happens to be ~33 ms. At dpr 1.5 the base arm is bimodal (21.07 / 21.09 / 41.58 / 41.69)
 *      and `=2` collapses it to 33.35 x4 — to the UPPER mode, not the lower: rendering every other
 *      callback pins the ceiling at 30 fps whatever the render costs. It is a REGRESSION on the best
 *      case, and it must never be the default. It stays as the control arm and nothing else.
 *
 *   2. THE FENCE GATE UNDER-RENDERED, and the reason was neither the poll nor the fence. The first
 *      cut allowed ZERO frames in flight: a tick could not render until the previous frame's GPU
 *      work had completed. That does not remove the second render, it removes the PIPELINE — the
 *      CPU's issuing and the GPU's execution stop overlapping and the period becomes their SUM
 *      instead of their MAX. The measured cell says exactly that: 50.13 ms = ~17 ms of CPU issuing
 *      + ~33 ms of GPU execution (`gpu/frm` 30.44 on a 50 ms frame is a GPU idle 40% of the time),
 *      against the ratio arm's 33.48 = max(17, 33). It is not the poll cadence: `ticks` reads 722 in
 *      6 s under the flag, ~120 Hz, an 8.3 ms polling grain — a poll-bound loop would have landed at
 *      33 + 8.3, not at 33 + 17.
 *
 * SO THE GATE IS A DEPTH, NOT A BOOLEAN. `Depth` is how many rendered frames may be outstanding on
 * the GPU when a tick asks to render. Depth 0 is the first cut (strictly serial, no pipeline, the
 * 50 ms cell). DEPTH 1 IS THE DEFAULT: one frame in flight, so the GPU never idles waiting for the
 * CPU's next tick, while the second render — the one the compositor threw away — is still refused,
 * because a third frame can never be issued while two are outstanding. The steady state is one
 * render per max(CPU issue, GPU execution) and the flag reaches the ratio arm's throughput WITHOUT
 * the ratio arm's clamp: at dpr 1.5, where the render fits one vsync, the fence is signalled by the
 * next tick and the gate is a no-op.
 *
 * WHAT A SKIPPED TICK DOES AND DOES NOT DO, exactly:
 *   DOES     drain the pushed-size slot, advance `_lastTime`, feed the HUD, step every spring
 *            (`AnimationManager.StepFrame`), solve layout, measure text, run text transitions,
 *            re-evaluate the render-on-demand gate, fire the post-frame hooks, and keep the loop
 *            awake (the park predicate refuses to park while a render is owed).
 *   DOES NOT call `_render`. No GL is issued, no draw is made, the swap chain is not written, and
 *            the OffscreenCanvas produces no compositor frame for that task.
 * So a skipped tick cannot change a pixel: the only thing that writes pixels is the render it
 * skipped, and that render is not dropped — it is OWED, and the next tick the gate lets through
 * runs it. On a static scene there is nothing behind at all and the loop is parked, so no tick
 * happens and the flag is a no-op by construction.
 *
 * WHICH SIGNAL. Three candidates, in the brief's order of preference:
 *
 *   1. A REAL PRESENTATION SIGNAL — not available on this platform, and that is a finding rather
 *      than a shortcut. `OffscreenCanvas.commit()` is not in Chromium (the placeholder-canvas model
 *      shipped as auto-commit at the end of the worker task, and the commit() promise the original
 *      spec had was never implemented); a dedicated worker gets no presentation-feedback callback
 *      and no `requestPostAnimationFrame`. That leaves the worker's own rAF cadence — and the
 *      measurement above is precisely what rules it out: rAF fires ~30 times a second at baseline
 *      against ~16 presented frames, and 120 times a second under the first cut of this flag. The
 *      BeginFrame subscription is throttled on frame SUBMISSION, not on presentation. It is the
 *      thing producing the two renders; it cannot also be the signal that one of them landed.
 *
 *   2. GPU COMPLETION AS THE PROXY — what this implements. A `fenceSync` after each frame's last
 *      draw, polled with `clientWaitSync(..., 0)` at the next tick and never blocking. "How many of
 *      my frames is the GPU still on" is then measured rather than assumed. See
 *      `WebGL2Renderer.PaceInFlight`.
 *
 *   3. A FIXED RATIO (`?tick-pace=N`) — the crude control, NOT the flag's meaning, and a clamp.
 *      See (1) above. It exists so a cell can show the difference between "skip while the GPU is
 *      behind" and "skip half", and because it issues zero fence polls it is also the only way to
 *      price the instrument itself.
 *
 * HOW THE READING IS TAKEN. `__jauiTickPace()` at each end of the window, subtracted. Besides the
 * three counters it now carries the two fields this lane added, and they are what say whether the
 * gate is working or merely armed:
 *
 *     WaitedTicks   ticks waited per render, bucketed 0 / 1 / 2 / 3+. Depth 1 on a 33 ms render at
 *                   a 60 Hz tick should sit in bucket 1. A pile in bucket 3+ is a loop waiting on
 *                   something that is not the GPU.
 *     FenceMs       how long, in ms, from arming a fence to the poll that found it signalled. This
 *                   is the fence's own latency, and it is the field that separates "the GPU is
 *                   busy" from "the fence tells us late": it should read ~`gpu/frm`, ~30 ms.
 *     MaxInFlight   the high-water mark of outstanding frames. It proves the depth is REACHED —
 *                   at depth 1 it must read 2, and a MaxInFlight of 1 says the gate never used the
 *                   headroom it was given and the cell is the depth-0 cell wearing a new name.
 */

/** How the gate decides. `null` is the unflagged engine: every tick that wants to render, renders. */
export type TickPaceMode =
  /** Poll the rendered frames' GPU fences; skip while more than `Depth` of them are outstanding. */
  | { Kind: 'fence'; Depth: number }
  /** Render every Nth tick that wants to render. N >= 2. The control arm, and a clamp. */
  | { Kind: 'ratio'; N: number };

/** What the gate said about one tick that wanted to render. `forced` is a `render` the stall guard
 *  took rather than a `render` the fence allowed, and it is counted separately BECAUSE a cell with
 *  a non-zero forced count is not measuring what the flag claims to measure. */
export type PaceDecision = 'render' | 'skip' | 'forced';

/** What the fence-mode gate asks. Implemented by `WebGL2Renderer`; an interface so the decision can
 *  be proved without a GL context, and so `Tick.Pace` imports nothing. */
export interface PaceGate {
  /** How many rendered frames the GPU has not finished yet. Polls each outstanding fence once,
   *  retires the ones that have signalled, and NEVER blocks. */
  PaceInFlight(): number;
  /** Milliseconds between arming the fence most recently retired by `PaceInFlight` and the poll
   *  that retired it — then cleared, so each fence is sampled once. `null` when that poll retired
   *  nothing. Pure instrument: the decision does not read it. */
  PaceTakeFenceMs(): number | null;
}

/**
 * Frames allowed in flight when the flag names no depth, and the whole point of this lane.
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
 * Consecutive skips after which the gate renders anyway.
 *
 * The fence is the only thing standing between this loop and a permanent freeze, so it does not get
 * to be trusted unconditionally: a driver that never signals, a context that went away between the
 * arm and the poll, or a flush that never happened would otherwise skip every render forever and
 * the app would sit on one frame. Eight ticks is ~133 ms at 60 Hz and ~265 ms at the 30 Hz cadence
 * this flag exists to fix — an order of magnitude past any frame either machine has ever produced,
 * so a healthy run can never reach it. It is not a fallback that hides: the force is counted in its
 * own column and named on the trace the first time it trips, and a cell with forced > 0 is void.
 */
export const PACE_STALL_TICKS = 8;

/**
 * Parse `?tick-pace`'s value.
 *
 *     ?tick-pace              the adaptive fence gate at the default depth
 *     ?tick-pace=fence        the same, spelled out
 *     ?tick-pace=fence:D      the fence gate at depth D (0..PACE_MAX_DEPTH) — the control that
 *                             reproduces the first cut's 50 ms cell in the same binary
 *     ?tick-pace=N            the fixed ratio, N >= 2 — a CLAMP, the control arm, never a default
 *
 * Anything else is refused, WITH A REASON, because an instrument that quietly did nothing would
 * publish the baseline under this flag's name.
 */
export const ParseTickPace = (raw: string | null): { Mode: TickPaceMode } | { Why: string } => {
  const v = (raw ?? '').trim();
  if (v === '' || v === 'fence') return { Mode: { Kind: 'fence', Depth: PACE_DEFAULT_DEPTH } };
  if (v.startsWith('fence:')) {
    const tail = v.slice('fence:'.length);
    // `Number('')` is 0, so an empty depth would otherwise parse as the serial gate and a typo
    // would silently select the arm this lane exists to replace.
    if (tail === '') return { Why: `fence-depth-must-be-a-whole-number-0-to-${PACE_MAX_DEPTH}` };
    const d = Number(tail);
    if (!Number.isInteger(d) || d < 0 || d > PACE_MAX_DEPTH) {
      return { Why: `fence-depth-must-be-a-whole-number-0-to-${PACE_MAX_DEPTH}` };
    }
    return { Mode: { Kind: 'fence', Depth: d } };
  }
  const n = Number(v);
  if (!Number.isInteger(n)) return { Why: 'value-must-be-fence-fence-colon-depth-or-a-whole-number-of-ticks' };
  if (n === 1) return { Why: 'n-1-renders-every-tick-which-is-the-unflagged-engine' };
  if (n < 1) return { Why: 'n-must-be-at-least-2' };
  return { Mode: { Kind: 'ratio', N: n } };
};

/** How a mode prints in `jaui:tick-pace armed=<mode>` and on the `[Jaui]` line. The depth is part of
 *  the name because two cells taken at two depths are two different instruments. */
export const TickPaceText = (mode: TickPaceMode | null): string =>
  mode === null ? 'off' : mode.Kind === 'fence' ? `fence:${mode.Depth}` : `ratio:${mode.N}`;

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
}

/** One decimal, so a printed ledger is readable and two of them are still subtractable. */
const Round1 = (v: number): number => Math.round(v * 10) / 10;

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
   *  comparable across the arms: unflagged is all bucket 0, `=2` is all bucket 1 by construction,
   *  and the fence gate's distribution is the thing being read. */
  readonly WaitedTicks: PaceWaited = [0, 0, 0, 0];

  /** Fence latency: how long from arming a fence to the poll that found it signalled. The mean over
   *  a window is `(Sum2-Sum1)/(N2-N1)`. Zero in every mode but fence — nothing else places a fence. */
  FenceSamples = 0;
  FenceMsSum = 0;
  FenceMsMax = 0;

  /** High-water mark of frames outstanding on the GPU. At depth D a working gate reaches D+1. */
  MaxInFlight = 0;

  private _skipRun = 0;
  /** Ratio mode's own index over WANTS, not over ticks: a tick that did not want to render is
   *  already not rendering, and counting it would make `=2` skip renders that never existed. */
  private _wants = 0;

  constructor(mode: TickPaceMode | null) { this.Mode = mode; }

  /** Call once per tick that WANTS to render — i.e. after the render-on-demand gate has said yes.
   *  Returns what to do and books it. */
  Decide = (gate: PaceGate | null): PaceDecision => {
    const mode = this.Mode;
    if (mode === null) return this._allow('render');

    if (mode.Kind === 'ratio') {
      const render = this._wants % mode.N === 0;
      this._wants++;
      return render ? this._allow('render') : this._refuse();
    }

    // Fence. A null gate cannot happen — the parse refuses the flag on a renderer that has no
    // fence to poll — but a gate that is not there must render rather than stall.
    if (gate === null) return this._allow('render');

    const inFlight = gate.PaceInFlight();
    if (inFlight > this.MaxInFlight) this.MaxInFlight = inFlight;
    const fenceMs = gate.PaceTakeFenceMs();
    if (fenceMs !== null) {
      this.FenceSamples++;
      this.FenceMsSum += fenceMs;
      if (fenceMs > this.FenceMsMax) this.FenceMsMax = fenceMs;
    }

    // THE GATE, in one line: render while the GPU is no more than `Depth` frames behind. At depth 1
    // the render that would have been the discarded one is still refused (two outstanding means a
    // third is not issued) while the pipeline the depth-0 gate broke is back.
    if (inFlight <= mode.Depth) return this._allow('render');
    if (this._skipRun >= PACE_STALL_TICKS) { this.Forced++; return this._allow('forced'); }
    return this._refuse();
  };

  private _allow = (decision: PaceDecision): PaceDecision => {
    const waited = this._skipRun;
    this.WaitedTicks[waited < 3 ? waited : 3]++;
    this._skipRun = 0;
    this.Rendered++;
    return decision;
  };

  private _refuse = (): PaceDecision => {
    this._skipRun++;
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
  });
}
