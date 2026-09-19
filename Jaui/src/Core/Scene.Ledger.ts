/**
 * The scene read-after-write ledger.
 *
 * Its own module for the same reason `Pass.Timers` is: it is pure bookkeeping with no GL in it, so
 * it can be unit-tested without pulling in `WebGL2.Renderer`, whose shader imports only resolve
 * after a build. `WebGL2.Renderer` owns the ONE instance and every call site.
 */

/**
 * How many times a frame READS the scene target after WRITING into it.
 *
 * The frame's largest measured term is not a component: `panels x blur` is 34.37 GPU ms of a 66.33 ms
 * frame at dpr 2 on an M4 (ShowStudio.Documentation/Perf/README.md, the 2^3 factorial), and it exists
 * only where both the flat panel draws and the backdrop pyramids are present. The shape that predicts a
 * term like that on a tile-based GPU is a rendering READ-AFTER-WRITE on `_sceneFbo`: the walk draws a
 * surface into it, the next surface's backdrop build samples its colour attachment, and the driver has
 * to END the scene's render encoder (store every tile) and START a new one (load every tile) to serve
 * the read. Each of those pairs costs the WHOLE canvas however tight the sampled region is - which is
 * why blur-own stays flat at 8-9 ms across a 2.56x pixel range while the interaction steps 4.9x.
 *
 * This ledger turns that shape into three numbers. `Restarts` is the count a READ multiplies by the
 * canvas; `Reads` is every scene tap whether or not a write intervened, so the two can be compared
 * and a fix that merely REORDERS reads is distinguishable from one that removes them.
 *
 * `Switches` is the third, and it exists because the first two were measured and the hypothesis they
 * were built for DIED. `?snap-once` took `Restarts` from 40 to 1 on `glass-grid` and the frame did
 * not move (72.85 -> 73.59 GPU ms; ShowStudio.Documentation/Perf/README.md). A READ of the scene
 * forcing a resolve is therefore not the mechanism. What a Metal render encoder actually ends on is
 * not a read at all: it ends whenever ANY other render target is bound and drawn into. Every pyramid
 * build binds the blur FBOs between one card's draw and the next, so under `?snap-once` the scene
 * encoder still ended ~40 times with the bed loaded back each time - only the READS were rerouted.
 * `Switches` counts exactly that event: a non-scene target bound while the scene holds tiles nothing
 * has resolved yet. Reads and switches coincide at baseline on `glass-grid` and DIVERGE under
 * `?snap-once`, which is the whole reason for a third column rather than a reinterpretation of the
 * second.
 *
 * It counts ENCODER ENDS, not GL calls. One `ComputeBlur` binds several blur level FBOs and
 * `GenerateBlurMipmap` binds several more, but the scene's encoder ended at the FIRST of them and
 * cannot end again until something has been drawn back into the scene - so the dirty flag is cleared
 * on the first switch and the rest of the build is free. Count builds, not binds.
 *
 * It counts DRAWS as writes, not clears: `BeginScenePass`'s `gl.clear` is a load-clear a tile-based
 * driver resolves for free, and a frame whose first act is a read of a cleared target has stored
 * nothing. It also cannot see a foreign renderer's draws - a <janvas> THREE pass writes into
 * `_sceneFbo` through raw GL with none of this renderer's entry points - so on a page with a janvas
 * the first surface's restart may be undercounted by one. Named where it is wrong rather than
 * defended: nothing in the perf harness's scenes has a janvas.
 */
export class SceneReadLedger {
  /** Scene taps this frame, restart or not. */
  Reads = 0;
  /** Scene taps this frame that FOLLOWED at least one draw into the scene - the encoder restarts. */
  Restarts = 0;
  /** Times this frame a NON-scene target was bound while the scene held tiles nothing had resolved
   *  yet - the encoder ENDS. Independent of `Restarts`: a switch is not a read, and `?snap-once`
   *  moves one without moving the other. */
  Switches = 0;
  /** Cumulative since boot, for a reader that samples at two instants and subtracts (the `?trace`
   *  gesture meter does exactly this with the pass profile). Never reset. */
  TotalReads = 0;
  TotalRestarts = 0;
  TotalSwitches = 0;
  TotalFrames = 0;
  private _written = false;
  /** The SWITCH column's own dirty flag. Separate from `_written` on purpose: a read and a switch
   *  are different events at the same instant (`ComputeBlur` notes a read and then BlurPass binds
   *  its FBO), and one flag would let whichever fired first swallow the other. Keeping them apart is
   *  what leaves the two older columns' semantics byte-for-byte what they were. */
  private _writtenSinceSwitch = false;

  BeginFrame = (): void => {
    this.Reads = 0;
    this.Restarts = 0;
    this.Switches = 0;
    this._written = false;
    this._writtenSinceSwitch = false;
    this.TotalFrames++;
  };

  /** A draw landed in the scene target. */
  NoteWrite = (): void => { this._written = true; this._writtenSinceSwitch = true; };

  /** The scene target's colour attachment was sampled or blitted from. Clears the write flag on
   *  every read, not only on a restart: once the encoder has ended, a SECOND read with no draw
   *  between them costs no further store, and counting it again would price a resolve twice. */
  NoteRead = (): void => {
    this.Reads++;
    this.TotalReads++;
    if (this._written) {
      this.Restarts++;
      this.TotalRestarts++;
      this._written = false;
    }
  };

  /** A framebuffer was bound. `key` is the renderer's own target key; `'scene'` is not a switch by
   *  definition, everything else is. Clears the dirty flag the way `NoteRead` clears its own, so the
   *  four blur-level binds inside one pyramid build count ONE encoder end and not four. */
  NoteTargetBind = (key: string): void => {
    if (key === 'scene') return;
    if (!this._writtenSinceSwitch) return;
    this.Switches++;
    this.TotalSwitches++;
    this._writtenSinceSwitch = false;
  };

  /** The frame is over and the scene is about to be presented. The present, and the invalidate that
   *  follows it, DO end the encoder - but they end it exactly once per frame in every configuration,
   *  so counting them would add a constant 1 to every cell and make `Switches` incomparable with
   *  `Restarts`, which excludes the present for the same reason (`PresentScene` notes no read). Drain
   *  the flag instead of counting it, so the end-of-frame binds are silent rather than special-cased
   *  one at a time. */
  NoteFrameEndDrain = (): void => { this._writtenSinceSwitch = false; };
}

