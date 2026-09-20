/**
 * `?tick-pace` — render at most ONCE per presented frame. The arithmetic, with no GL in it.
 *
 * WHY THIS EXISTS (ShowStudio.Documentation/Perf/README.md, "THE DIVISOR CORRECTION IS REVERSED"):
 * the harness's own `ticks` column says the engine renders TWICE per presented frame at baseline
 * and ONCE under `?blur-dummy` —
 *
 *     arm (M4, 6 s window)        ticks    p50      presented (6000/p50)    ticks per presented
 *     blur-src-clear (baseline)    182     67.46          89                     2.04
 *     no-blur                      280     43.71         137                     2.04
 *     blur-dummy                   176     34.32         175                     1.00
 *
 * — and the Metal System Trace, captured inside the canvas column's own window, agrees from the
 * other side: the full-canvas surface is rewritten every 34.4 ms while frames present every
 * 68.4 ms. Once a render exceeds the two-vsync budget the worker keeps ticking on its BeginFrame
 * subscription, each tick renders a whole frame, and the compositor presents every OTHER render.
 * A presented frame costs two renders and the GPU reads 100% busy because half its work is thrown
 * away. That is the "34 ms bed x cards interaction" ten pass-level ablations could not find: it is
 * not in a pass, it is the second render.
 *
 * So this flag removes the second render and nothing else. It is a MEASUREMENT flag and changes no
 * default — if the reading confirms, pacing becomes the default in a lane of its own.
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
 *      measurement above is precisely what rules it out: rAF fires ~30 times a second against ~15
 *      presented frames, so the BeginFrame subscription is throttled on frame SUBMISSION, not on
 *      presentation. It is the thing producing the two renders; it cannot also be the signal that
 *      one of them landed.
 *
 *   2. GPU COMPLETION AS THE PROXY — what this implements. A `fenceSync` after the frame's last
 *      draw, polled with `clientWaitSync(..., 0)` at the next tick and never blocking. "The GPU is
 *      still on the previous frame" is then measured rather than assumed, and the render is removed
 *      exactly when it would have been the discarded one. One non-blocking poll per tick. See
 *      `WebGL2Renderer.PaceReady`.
 *
 *   3. A FIXED RATIO (`?tick-pace=2`) — the crude control, NOT the flag's meaning. It skips half
 *      the renders whether or not the GPU is behind, so on a scene whose render fits a vsync it
 *      halves the frame rate for nothing. It exists so the M4 can run it against the real one and
 *      show the difference between "skip when behind" and "skip half".
 */

/** How the gate decides. `null` is the unflagged engine: every tick that wants to render, renders. */
export type TickPaceMode =
  /** Poll the previous frame's GPU fence; skip while it has not signalled. */
  | { Kind: 'fence' }
  /** Render every Nth tick that wants to render. N >= 2. The control arm. */
  | { Kind: 'ratio'; N: number };

/** What the gate said about one tick that wanted to render. `forced` is a `render` the stall guard
 *  took rather than a `render` the fence allowed, and it is counted separately BECAUSE a cell with
 *  a non-zero forced count is not measuring what the flag claims to measure. */
export type PaceDecision = 'render' | 'skip' | 'forced';

/** What the fence-mode gate asks. Implemented by `WebGL2Renderer`; an interface so the decision can
 *  be proved without a GL context, and so `Tick.Pace` imports nothing. */
export interface PaceGate {
  /** True when the previous render's GPU work has completed (or there is no previous render).
   *  Never blocks. */
  PaceReady(): boolean;
}

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

/** Parse `?tick-pace`'s value. `null` (bare flag) and `fence` mean the fence gate; a whole number
 *  >= 2 means the ratio control. Anything else is refused, WITH A REASON, because an instrument
 *  that quietly did nothing would publish the baseline under this flag's name. */
export const ParseTickPace = (raw: string | null): { Mode: TickPaceMode } | { Why: string } => {
  const v = (raw ?? '').trim();
  if (v === '' || v === 'fence') return { Mode: { Kind: 'fence' } };
  const n = Number(v);
  if (!Number.isInteger(n)) return { Why: 'value-must-be-fence-or-a-whole-number-of-ticks' };
  if (n === 1) return { Why: 'n-1-renders-every-tick-which-is-the-unflagged-engine' };
  if (n < 1) return { Why: 'n-must-be-at-least-2' };
  return { Mode: { Kind: 'ratio', N: n } };
};

/** How a mode prints in `jaui:tick-pace armed=<mode>` and on the `[Jaui]` line. */
export const TickPaceText = (mode: TickPaceMode | null): string =>
  mode === null ? 'off' : mode.Kind === 'fence' ? 'fence' : `ratio:${mode.N}`;

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

  private _skipRun = 0;
  /** Ratio mode's own index over WANTS, not over ticks: a tick that did not want to render is
   *  already not rendering, and counting it would make `=2` skip renders that never existed. */
  private _wants = 0;

  constructor(mode: TickPaceMode | null) { this.Mode = mode; }

  /** Call once per tick that WANTS to render — i.e. after the render-on-demand gate has said yes.
   *  Returns what to do and books it. */
  Decide = (gate: PaceGate | null): PaceDecision => {
    const mode = this.Mode;
    if (mode === null) { this.Rendered++; return 'render'; }

    if (mode.Kind === 'ratio') {
      const render = this._wants % mode.N === 0;
      this._wants++;
      if (render) { this.Rendered++; return 'render'; }
      this.Skipped++;
      return 'skip';
    }

    // Fence. A null gate cannot happen — the parse refuses the flag on a renderer that has no
    // fence to poll — but a gate that is not there must render rather than stall.
    if (gate === null || gate.PaceReady()) { this._skipRun = 0; this.Rendered++; return 'render'; }
    if (this._skipRun >= PACE_STALL_TICKS) {
      this._skipRun = 0;
      this.Forced++;
      this.Rendered++;
      return 'forced';
    }
    this._skipRun++;
    this.Skipped++;
    return 'skip';
  };

  /** The census, for the `[Jaui]` line, `jaui:render:end` and the `__jauiTickPace` global. */
  Census = (): { Mode: string; Rendered: number; Skipped: number; Forced: number } => ({
    Mode: TickPaceText(this.Mode),
    Rendered: this.Rendered,
    Skipped: this.Skipped,
    Forced: this.Forced,
  });
}
