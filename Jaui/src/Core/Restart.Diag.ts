/**
 * `?scene-restarts=N` and `?small-restarts=N` — the arithmetic, with no GL in it.
 *
 * Its own module for the same reason `Scene.Ledger` and `Pass.Timers` are: `WebGL2.Renderer`'s
 * shader imports only resolve after a build, so anything that has to be PROVED rather than believed
 * cannot live in that file. Two things have to be proved here and both are pure:
 *
 *   1. The probe draw leaves every destination channel EXACTLY where it found it. Both flags are
 *      pixel-identical BY CONSTRUCTION and the two-arm `glassshot` diff has to read 0 — so the
 *      blend arithmetic is a function under test, not a comment. See `SrcOverChannel`.
 *   2. The frame emits exactly N extra restarts, spread evenly over the frame's insertion points,
 *      for any N and any number of points — including N larger than the point count, and including
 *      the first frame, when the point count is not yet known. See `RestartSpread`.
 *
 * WHY THIS EXISTS AT ALL (ShowStudio.Documentation/Perf/README.md, "THE JOIN"): every ordering
 * experiment is dead. `?snap-once` moved the reads and the frame did not move; the card composite
 * took ends 40 -> 1 and cost 6.6%; `?blur-first` reordered the forty builds ahead of the bed and
 * made the frame 6 ms SLOWER. What the Metal System Trace join says instead is that the frame is
 * MORE PASSES at unchanged per-pass cost (+2 bed-class and +44 mid-band passes/frame, each at the
 * same ~5.7 ms and ~300 us it costs without the bed) plus 8 ms of GPU idle in ~616 sub-0.1 ms
 * bubbles. H5, the one hypothesis left standing: cost ~ the sum over ENCODERS of (a fixed bubble +
 * the target's tile load/store), with a cleared target's load/store free.
 *
 * H5 can only be priced by a pair that changes encoder COUNT and nothing else — not order, not
 * work, not what is sampled. `?scene-restarts=N` adds N scene-encoder restarts (each one a 16 MB
 * store and a 16 MB load) plus N trivial encoders; `?small-restarts=N` adds the N trivial encoders
 * ALONE. At the same N, (scene - small) is the load/store term and `small` is the bubble term.
 *
 * WHAT THE THIRD LANE CHANGED, and why the second lane's numbers could not be quoted. The M4 read
 * `scene-restarts=40` at +1.79 ms and `=80` at +8.52 while the phased flag REMOVED 38 real encoder
 * ends for +0.28. Both cannot be a per-encoder price, and the probe was the odd one out: its
 * restart was a 1x1 DETOUR, not a build's end. So the scene arm's detour now lands in the blur
 * pass's OWN level-0 framebuffer - the target a build's last upsample hop draws into, and therefore
 * the target a build ends the scene on - and the third draw is gone. TWO draws a point:
 *
 *     (a) one transparent draw into the SCENE, which OPENS the scene's encoder (its tiles load);
 *     (b) one transparent draw into the blur pass's level 0, which ENDS it (its tiles store) and
 *         opens exactly the encoder a build's final hop opens; then `RebindSceneTarget()`.
 *
 * There is no (c). The old (c) drew back into the scene and left it DIRTY, so the adaptive-shadow
 * probe's 1x1 bind - which rides the build's end for free at baseline - ended a SECOND encoder
 * nobody had specified and its scene read became a second restart. That is the whole of the M4's
 * `switches=100 restarts=60 shadow-state:20`, and dropping (c) is the whole of the fix. The load
 * (c) used to pay is still paid, by the walk's own next scene draw, exactly where baseline pays it.
 */

/**
 * One channel of `glBlendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` under `FUNC_ADD`, in normalised
 * floats: `dst' = src * srcAlpha + dst * (1 - srcAlpha)`.
 *
 * The probe draws with `srcAlpha` 0, which collapses this to `dst' = dst` for every channel
 * including alpha — the non-separate blend func applies the same two factors to RGB and to A, so a
 * 2-bit alpha channel is as untouched as a 10-bit colour one. That identity is the whole pixel
 * claim of both flags, and `Scene.Restarts.test.ts` walks every RGB10_A2 code through it rather
 * than asserting the algebra back to itself.
 */
export const SrcOverChannel = (src: number, dst: number, srcAlpha: number): number =>
  src * srcAlpha + dst * (1 - srcAlpha);

/** A normalised channel stored back into an `n`-bit fixed-point attachment, the way a colour
 *  attachment quantises on write. RGB10_A2 is 10 bits of R, G and B and 2 of A. */
export const QuantiseToBits = (v: number, bits: number): number => {
  const max = (1 << bits) - 1;
  return Math.round(Math.min(1, Math.max(0, v)) * max);
};

/** The source alpha the probe draw writes. Named rather than inlined so the renderer's shader
 *  constant and the test's argument are the same number. */
export const PROBE_SRC_ALPHA = 0;

/** Draws one scene-arm restart issues: (a) into the scene, (b) into the blur pass's level 0.
 *  There is no third. Shared with `Scene.Restarts.test.ts` and with the renderer's gate line so
 *  the predicted draw count, the counted one and the asserted one are one number. */
export const SCENE_PROBE_DRAWS = 2;
/** Draws one small-arm restart issues: the 1x1 probe draw alone. */
export const SMALL_PROBE_DRAWS = 1;

/** The draws a frame's probes issued, from the two probe counts. The number the harness's
 *  `drawCalls` delta has to equal PER ENGINE FRAME - which is not per engine TICK, and the gate
 *  line prints both so the two instruments cannot disagree in silence. */
export const ProbeDraws = (sceneProbes: number, smallProbes: number): number =>
  sceneProbes * SCENE_PROBE_DRAWS + smallProbes * SMALL_PROBE_DRAWS;

/** `a / b` to two decimals, or `null` when `b` is not a denominator. The census line's only
 *  arithmetic, kept here so the ratio the M4 reads is the ratio this suite asserts. */
export const Per = (a: number, b: number): number | null =>
  b > 0 ? Math.round((a / b) * 100) / 100 : null;

/**
 * How many extra restarts each insertion point owes, so a frame emits exactly `n` of them spread
 * evenly over however many points the frame turns out to have.
 *
 * The point count is not known until the frame is over, so the denominator is the PREVIOUS frame's
 * count. On a steady scene (glass-grid idle is forty builds a frame, every frame) every point emits
 * the same `n / 40` from frame two onwards and the frame ends owing nothing.
 *
 * `FrameEnd` DOES NOT EMIT, and that is lane restarts3's fix rather than an omission. It used to pay
 * the balance just before `PresentScene`, where the walk has been drawing into the scene all frame -
 * so the balance probe's bind ENDED a live scene encoder and booked a switch under `restart-probe`
 * at an instant that is not an insertion point. That is the M4's one-frame
 * `switches=41 endsByKey=blur:40,restart-probe:1`, the small arm's own void condition, arriving
 * from inside the instrument. Now `FrameEnd` only rolls the denominator and RETURNS the shortfall,
 * which the gate prints: frame one owes its whole `n` (the point count was not known yet) and every
 * steady frame owes zero, so a non-zero `shortfall` on a steady frame is a fault with a name
 * instead of a second shape in the ledger.
 *
 * `n` above the point count is not an error and does not need more points: a point emits as many
 * restarts as it owes. `?scene-restarts=80` on forty builds is two per build, which is the second
 * point on the line through the origin that a linear H5 predicts.
 */
export class RestartSpread {
  /** Points seen so far THIS frame. */
  private _points = 0;
  /** Points the last complete frame had — the denominator. Zero before the first `FrameEnd`. */
  private _lastPoints = 0;
  /** Restarts already emitted this frame. */
  private _emitted = 0;

  /** Points the last complete frame had. Reported on the trace so a reading whose spread collapsed
   *  onto the frame-end balance is visible rather than inferred. */
  get Points(): number { return this._lastPoints; }
  /** Restarts emitted so far this frame. Reads `n` at `FrameEnd` in every configuration. */
  get Emitted(): number { return this._emitted; }

  /** Arrive at an insertion point: how many restarts to emit here. */
  At = (n: number): number => {
    const i = this._points++;
    const points = this._lastPoints;
    if (points <= 0) return 0;
    const want = Math.min(n, Math.floor(((i + 1) * n) / points));
    const owed = want - this._emitted;
    if (owed <= 0) return 0;
    this._emitted += owed;
    return owed;
  };

  /** The frame is over. Rolls the denominator forward and returns the SHORTFALL - what the frame
   *  wanted and did not emit - for the gate to print. Emits nothing; see the class comment. */
  FrameEnd = (n: number): number => {
    const short = Math.max(0, n - this._emitted);
    this._lastPoints = this._points;
    this._points = 0;
    return short;
  };

  /** Clear the frame's running totals. Called by the renderer at `BeginFrame`, after the trace has
   *  read `Emitted` — keeping the reset off `FrameEnd` is what lets the gate line report the count
   *  the frame actually emitted instead of a zero. */
  BeginFrame = (): void => { this._emitted = 0; };
}
