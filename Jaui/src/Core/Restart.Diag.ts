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

/**
 * How many extra restarts each insertion point owes, so a frame emits exactly `n` of them spread
 * evenly over however many points the frame turns out to have.
 *
 * The point count is not known until the frame is over, so the denominator is the PREVIOUS frame's
 * count and `FrameEnd` pays whatever the frame still owes. On a steady scene (glass-grid idle is
 * forty builds a frame, every frame) the remainder is zero from frame two onwards and every point
 * emits the same `n / 40`; on frame one, and on any frame whose point count fell, the whole balance
 * lands at the frame's end. Either way the COUNT — the only thing H5 is priced on — is exactly `n`.
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

  /** The frame is over: how many restarts it still owes. Rolls the denominator forward. */
  FrameEnd = (n: number): number => {
    const owed = Math.max(0, n - this._emitted);
    this._lastPoints = this._points;
    this._points = 0;
    this._emitted += owed;
    return owed;
  };

  /** Clear the frame's running totals. Called by the renderer at `BeginFrame`, after the trace has
   *  read `Emitted` — keeping the reset off `FrameEnd` is what lets the gate line report the count
   *  the frame actually emitted instead of a zero. */
  BeginFrame = (): void => { this._emitted = 0; };
}
