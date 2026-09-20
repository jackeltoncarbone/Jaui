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
  /** `Switches`, broken down by the target key that took each end. Sums to `Switches` exactly -
   *  it is incremented in the same branch, not counted separately.
   *
   *  The column exists because `Switches` alone cannot answer the question the M4 actually asks.
   *  An encoder end prices by TARGET SIZE: ~0.12 ms below the 6.4-9.2 MB cliff and 1.1-1.5 ms above
   *  it (Perf/README.md, the per-end cost floors). A frame with four ends on 1 MB card targets and
   *  a frame with four ends on the 16 MB scene read the SAME in this column and differ by ~5 ms. So
   *  the breakdown names the target, and a design that claims to have moved its ends onto small
   *  targets can be checked rather than believed. Keys today: `scene` (never counted, by
   *  definition), `snapshot`, `blur`, `card`, `cache`, `shadow-state`, `default`. */
  EndsByKey: Record<string, number> = {};
  /** THE ATLAS CENSUS, per frame. `?pyramid-atlas` collapses a frame's per-card pyramid builds
   *  into one build per PHASE, so the columns that say whether it actually did are: how many
   *  atlases were built, how many members they carried, how many surfaces the plan REFUSED and
   *  built alone, and how many bytes of level chain the atlases hold.
   *
   *  `Solo` is the one to read first. A plan that atlases nothing and solos everything reads
   *  `atlases=0 members=0 solo=40` and is the unflagged engine wearing the flag's name -- the
   *  vacuous-success shape this ledger has been bitten by before. On `glass-grid` it must read
   *  `atlases=2 members=40 solo=0`, and `EndsByKey.blur` must read 2 beside it. */
  Atlases = 0;
  AtlasMembers = 0;
  AtlasSolo = 0;
  AtlasBytes = 0;
  /** THE BORDER CENSUS, per frame. `?border-direct` replaces a glass rim's four-pass backdrop
   *  pyramid with one blit and a gather in the border's own shader, and the only way to tell an
   *  armed frame from an unarmed one is which branch each rim took.
   *
   *  Read them TOGETHER, and `BordersPyramid` first. `BordersDirect = 0, BordersPyramid = 20` under
   *  the flag is the unflagged engine wearing the flag's name - every rim refused by the admission
   *  rule, every encoder still there, and a timing comparison that would pass by having done
   *  nothing. On `glass-grid` at dpr 2 it must read `20 / 0`, with `EndsByKey['border-copy']` at 20
   *  and `EndsByKey.blur` down to the fills' atlas beside it. */
  BordersDirect = 0;
  BordersPyramid = 0;
  /** THE FRAGMENT COUNTS, estimated from the rim instances the direct program actually drew.
   *
   *  The M4's cell made eighty render passes and eighty draws leave the frame and the frame got
   *  2.59 ms SLOWER, and the first hypothesis for that was that the 64-tap gather runs on the whole
   *  rim QUAD rather than on the band. It does not (`Jiv.Panel.frag` calls it inside
   *  `if (borderBase > 0.001)`), but the two numbers are what makes that statement checkable from
   *  a run instead of from a reading of the source: `BorderFragments` is where the gather runs and
   *  `BorderQuadFragments` is where the PROGRAM runs, and the ratio between them is the thing any
   *  argument about occupancy has to start from. Both are estimates off the packed instance -- see
   *  `Border.Direct.EstimateBorderFragments`, which is where the arithmetic lives and is tested. */
  BorderFragments = 0;
  BorderQuadFragments = 0;
  /** DRAWS the atlas builds issued this frame, and the reason it is a column of its own: the
   *  harness's `drawCalls` counts SCENE draws and does not see a pyramid pass at all. It read
   *  153 / 153 / 154 across `?pyramid-atlas` off / fills / all -- three arms that differ by 160
   *  pyramid draws and by 1.69 ms -- and 74.00 for both `?blur-dummy` and `?no-blur`, which
   *  differ by every build in the frame. So a cell about DRAWS has to read the engine's own count
   *  or it is reading a column its lever cannot move.
   *
   *  `?atlas-instanced` (the default) issues ONE instanced draw per atlas level: 8 on
   *  `glass-grid` under `all` and 4 under `fills`, against 160 and 80 with `=off`. It counts the
   *  ATLAS's draws only -- a member the plan refused builds through `ComputeBlur` and its four
   *  passes are not in here, and neither are the twenty per-card rim builds the `fills` arm runs
   *  in the walk. */
  AtlasDraws = 0;
  /** Cumulative since boot, for a reader that samples at two instants and subtracts (the `?trace`
   *  gesture meter does exactly this with the pass profile). Never reset. */
  TotalReads = 0;
  TotalRestarts = 0;
  TotalSwitches = 0;
  TotalFrames = 0;
  /** `EndsByKey` since boot, for the same two-instant reader. Never reset. */
  TotalEndsByKey: Record<string, number> = {};
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
    this.EndsByKey = {};
    this.Atlases = 0;
    this.AtlasMembers = 0;
    this.AtlasSolo = 0;
    this.AtlasBytes = 0;
    this.BordersDirect = 0;
    this.BordersPyramid = 0;
    this.BorderFragments = 0;
    this.BorderQuadFragments = 0;
    this.AtlasDraws = 0;
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
    this.EndsByKey[key] = (this.EndsByKey[key] ?? 0) + 1;
    this.TotalEndsByKey[key] = (this.TotalEndsByKey[key] ?? 0) + 1;
    this._writtenSinceSwitch = false;
  };

  /** The frame is over and the scene is about to be presented. The present, and the invalidate that
   *  follows it, DO end the encoder - but they end it exactly once per frame in every configuration,
   *  so counting them would add a constant 1 to every cell and make `Switches` incomparable with
   *  `Restarts`, which excludes the present for the same reason (`PresentScene` notes no read). Drain
   *  the flag instead of counting it, so the end-of-frame binds are silent rather than special-cased
   *  one at a time. */
  NoteFrameEndDrain = (): void => { this._writtenSinceSwitch = false; };

  /** One atlas was built, carrying `members` slots and holding `bytes` of level chain. */
  NoteAtlas = (members: number, bytes: number): void => {
    this.Atlases++;
    this.AtlasMembers += members;
    this.AtlasBytes += bytes;
  };

  /** `n` surfaces the atlas plan could not take, and which built exactly as they do today. */
  NoteAtlasSolo = (n: number): void => { this.AtlasSolo += n; };

  /** One glass border computed its backdrop directly - one blit, no pyramid. */
  NoteBorderDirect = (): void => { this.BordersDirect++; };

  /** One glass border built a pyramid: the flag is off, or the admission rule refused this build. */
  NoteBorderPyramid = (): void => { this.BordersPyramid++; };

  /** One direct rim DREW: `band` fragments inside its annulus, `quad` in its rasterised rect. */
  NoteBorderFragments = (band: number, quad: number): void => {
    this.BorderFragments += band;
    this.BorderQuadFragments += quad;
  };
  /** `n` draws one atlas build issued -- `2 x depth` instanced, or `2 x depth x members`. */
  NoteAtlasDraws = (n: number): void => { this.AtlasDraws += n; };
}

