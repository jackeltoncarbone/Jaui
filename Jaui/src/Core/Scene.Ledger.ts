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
 * This ledger turns that shape into two numbers. `Restarts` is the count that multiplies the canvas;
 * `Reads` is every scene tap whether or not a write intervened, so the two can be compared and a fix
 * that merely REORDERS reads is distinguishable from one that removes them.
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
  /** Cumulative since boot, for a reader that samples at two instants and subtracts (the `?trace`
   *  gesture meter does exactly this with the pass profile). Never reset. */
  TotalReads = 0;
  TotalRestarts = 0;
  TotalFrames = 0;
  private _written = false;

  BeginFrame = (): void => {
    this.Reads = 0;
    this.Restarts = 0;
    this._written = false;
    this.TotalFrames++;
  };

  /** A draw landed in the scene target. */
  NoteWrite = (): void => { this._written = true; };

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
}

