/**
 * The scene read-after-write ledger.
 *
 * Its own module for the same reason `Pass.Timers` is: it is pure bookkeeping with no GL in it, so
 * it can be unit-tested without pulling in `WebGL2.Renderer`, whose shader imports only resolve
 * after a build. `WebGL2.Renderer` owns the ONE instance and every call site.
 */
import { AddGlassFragCensus, EmptyGlassFragCensus, type GlassFragCensus } from './Glass.Skip';
import type { GlassProgramKind } from './Glass.Programs';

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
  /** THE BORDER-SOURCE CENSUS, per frame. `?border-source=fill` lets a glass rim sample the
   *  pyramid its own FILL already built and sampled, instead of building a second one over the
   *  same region out of the scene the fill has since drawn into.
   *
   *  Read `BordersRimBuilt` FIRST, for the reason the atlas census prints `solo` and the direct
   *  census prints `pyramid`: `BordersFromFill = 0, BordersRimBuilt = 20` under the flag is the
   *  unflagged engine wearing the flag's name - every rim refused by the admission rule, every
   *  build and every encoder still in the frame, and a timing comparison that would pass by having
   *  done nothing. On `glass-grid` at dpr 2 it must read `20 / 0`, with `EndsByKey.blur` at 20
   *  against the unflagged 40 beside it.
   *
   *  Both stay 0 on the `scene` arm (the default), which is what makes that arm the engine this
   *  lane inherited in its COUNTERS as well as in its pixels. */
  BordersFromFill = 0;
  BordersRimBuilt = 0;
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
  /** `?glass-presample`: builds this frame whose pyramid was re-based onto a pre-downsampled
   *  source because the flag lifted `BaseDownsampleFactor`'s 15%-of-canvas gate.
   *
   *  It counts builds that ACTUALLY re-based, booked off `BlurPass.LastPresampled` after the
   *  call rather than off the flag, so the vacuous shape -- the flag armed and every build
   *  refused by the plan -- reads 0 here instead of reading like a win. 0 unflagged by
   *  construction: the plan is not consulted at all unless the arm asked for it. On `glass-grid`
   *  at dpr 2 under `on` it is 40 (twenty fills and twenty rims: both build at the same
   *  `max(1, BackdropFrostBlur) * dpr` = 8 device px, both at `MaxLod` 0, and both regions --
   *  568x436 and 480x348 -- are far under the canvas's 15%). */
  PresampledBuilds = 0;
  /** `?glass-gaussian`: builds this frame whose backdrop was produced by the two-pass separable
   *  Gaussian instead of the four-hop dual-filter chain.
   *
   *  Booked off `BlurPass.LastGaussian` after the call rather than off the flag, for the reason
   *  `PresampledBuilds` is: an arm in which every build hit a refusal reads 0 here instead of
   *  reading like a win. 0 unflagged by construction -- the plan is not consulted unless the arm
   *  asked for it. On `glass-grid` at dpr 2 it is 20 under the shipped `?border-source=fill` (the
   *  twenty FILL builds; each rim reads its own fill's level 0 and builds nothing) and 40 under
   *  `?border-source=scene`, where every rim builds again. */
  GaussianBuilds = 0;
  /** RENDER PASSES those builds issued: `GAUSS_PASSES` each, so 40 where the twenty chains they
   *  replaced would have issued 80.
   *
   *  A column of its own because `EndsByKey.blur` CANNOT carry it. That counter books ONE encoder
   *  end per build by design -- `NoteTargetBind` is called once from `ComputeBlur` and the level
   *  binds inside a build never reach this ledger at all -- so it reads 20 on `glass-grid` under
   *  both arms and a pass-count prediction quoted against it would be reading a column this lever
   *  cannot move. This is the one that moves. */
  GaussianPasses = 0;
  /** THE BLUR PLAN, per rendered frame: every PER-SURFACE build (glass fills, rims, group unions),
   *  split by the plan that ran it, in one currency -- builds, render passes, destination px
   *  written and bilinear fetches issued. `Separable*` is the default plan; `SurfaceChain*` is the
   *  dual-filter chain, which is every build under `?blur-chain=on` and any build the separable
   *  plan refused. Booked off `BlurPass.LastBuild`, what the pass DID. `SeparablePasses +
   *  SurfaceChainPasses` is THE number the blurfast lane exists to move. */
  SeparableBuilds = 0;
  SeparablePasses = 0;
  SeparableFill = 0;
  SeparableReads = 0;
  SurfaceChainBuilds = 0;
  SurfaceChainPasses = 0;
  SurfaceChainFill = 0;
  SurfaceChainReads = 0;
  /** `?glass-group`: the container-scoped shared backdrop, per rendered frame.
   *
   *  `GroupBuilds` is pyramids built for a GROUP of glass siblings; `GroupMembers` is how many
   *  surfaces took one; `GroupFallbacks` is glass fills the grouping did not cover, which built
   *  exactly as they build today. Read them TOGETHER, because the vacuous shape this ledger keeps
   *  being bitten by is a flag armed with `builds=0 members=0 fallbacks=20` -- the engine it
   *  inherited, wearing the flag's name and priced as though it had grouped something.
   *
   *  On `glass-grid` at dpr 2 they must read 1 / 20 / 0: `Perf.GlassGrid.ts` puts all twenty cards
   *  under ONE `PerfGrid` parent, so the page is one group of twenty and not four bands of five.
   *  `EndsByKey.blur` falls from 20 to 1 beside them -- twenty fills become one group build, and
   *  `?border-source=fill` (the default since Jaui `f1834cf`) already put every rim on the fill's
   *  handle, which is now the group's. */
  GroupBuilds = 0;
  GroupMembers = 0;
  GroupFallbacks = 0;
  /** `?shadow-probe`: adaptive-shadow probes this frame, and the binds of the 1x1 state target they
   *  took. The walk arm binds once per probe (`binds == probes`); `group` binds once per group.
   *  Neither column is an encoder END - `EndsByKey['shadow-state']` is, and it moves only when a
   *  bind lands on a dirty scene - so the triple `probes / binds / ends` is what the gate prints:
   *  20 / 20 / 19 on glass-grid today, 20 / 1 / 0 under `group`. */
  ShadowProbes = 0;
  ShadowProbeBinds = 0;
  /** `?glass-skip`: GLASS DRAWS this frame (panel batches shaded by the glass program), and the
   *  fragment census of every instance they drew -- `frags=` and `taps=` on the gate line, the
   *  denominator the M4's per-fragment reading needs. Booked only while the flag is armed (`none`
   *  included), so the unflagged engine pays nothing for it.
   *
   *  `GlassDraws` is the control invariant: every stage arm must read the same number as `none`,
   *  because every arm draws the same draw. So must `Frags`; `Taps` is the column a stage moves. */
  GlassDraws = 0;
  GlassCensus: GlassFragCensus = EmptyGlassFragCensus();
  /** `?glass-programs`: glass batches routed to each variant this frame, and the ones an armed
   *  arm could NOT route (a predicate failed on some instance) that drew with the full program.
   *  `NoGlow` / `NoSpec` count batches shaded by a program compiled with that define. Always booked:
   *  four increments per glass batch, and the arm is on by default. */
  GlassBorderOnlyBatches = 0;
  GlassNoGlowBatches = 0;
  GlassNoSpecBatches = 0;
  GlassProgramFallbacks = 0;
  /** `?blur-cache`, per frame. `Hits` are builds a clean backdrop let the walk skip (under `verify`,
   *  builds it WOULD have skipped -- the build runs anyway and is compared). `Misses` are builds that
   *  ran, cold or dirty. `Stores` copied a clean-but-cold build into the cache, `Evictions` made room
   *  for one, `Refused` could not be made room for without evicting a slot this frame still binds.
   *  `Verified` / `Mismatches` are the verify arm's comparisons and the ones that differed: a
   *  mismatch is a producer of visible change the damage audit missed, never a picture question. */
  BlurCacheHits = 0;
  BlurCacheMisses = 0;
  BlurCacheStores = 0;
  BlurCacheEvictions = 0;
  BlurCacheRefused = 0;
  BlurCacheVerified = 0;
  BlurCacheMismatches = 0;
  /** The same since boot, because the verify arm's evidence is a LONG session reading
   *  `mismatches=0` with `hits>0`, not one frame. Never reset. */
  TotalBlurCacheHits = 0;
  TotalBlurCacheMisses = 0;
  TotalBlurCacheEvictions = 0;
  TotalBlurCacheVerified = 0;
  TotalBlurCacheMismatches = 0;
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
    this.BordersFromFill = 0;
    this.BordersRimBuilt = 0;
    this.BorderFragments = 0;
    this.BorderQuadFragments = 0;
    this.AtlasDraws = 0;
    this.PresampledBuilds = 0;
    this.GaussianBuilds = 0;
    this.GaussianPasses = 0;
    this.SeparableBuilds = 0;
    this.SeparablePasses = 0;
    this.SeparableFill = 0;
    this.SeparableReads = 0;
    this.SurfaceChainBuilds = 0;
    this.SurfaceChainPasses = 0;
    this.SurfaceChainFill = 0;
    this.SurfaceChainReads = 0;
    this.GroupBuilds = 0;
    this.GroupMembers = 0;
    this.GroupFallbacks = 0;
    this.ShadowProbes = 0;
    this.ShadowProbeBinds = 0;
    this.GlassDraws = 0;
    this.GlassCensus = EmptyGlassFragCensus();
    this.GlassBorderOnlyBatches = 0;
    this.GlassNoGlowBatches = 0;
    this.GlassNoSpecBatches = 0;
    this.GlassProgramFallbacks = 0;
    this.BlurCacheHits = 0;
    this.BlurCacheMisses = 0;
    this.BlurCacheStores = 0;
    this.BlurCacheEvictions = 0;
    this.BlurCacheRefused = 0;
    this.BlurCacheVerified = 0;
    this.BlurCacheMismatches = 0;
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

  /** One glass border took its own FILL's pyramid - no rim build, no copy, no second region. */
  NoteBorderFromFill = (): void => { this.BordersFromFill++; };

  /** One glass border built its own rim pyramid while `?border-source=fill` was armed: the
   *  admission rule refused it. Never counted on the `scene` arm, where every rim builds one by
   *  definition and a column reading 20 on both arms would say nothing. */
  NoteBorderRimBuilt = (): void => { this.BordersRimBuilt++; };

  /** One direct rim DREW: `band` fragments inside its annulus, `quad` in its rasterised rect. */
  NoteBorderFragments = (band: number, quad: number): void => {
    this.BorderFragments += band;
    this.BorderQuadFragments += quad;
  };
  /** `n` draws one atlas build issued -- `2 x depth` instanced, or `2 x depth x members`. */
  NoteAtlasDraws = (n: number): void => { this.AtlasDraws += n; };

  /** One build re-based onto a pre-downsampled source under `?glass-presample`. */
  NotePresampled = (): void => { this.PresampledBuilds++; };

  /** One build produced its backdrop as a separable Gaussian, in `passes` render passes. */
  NoteGaussian = (passes: number): void => {
    this.GaussianBuilds++;
    this.GaussianPasses += passes;
  };
  /** One per-surface build, on the side of the plan that ran it. A `?glass-gaussian` build is
   *  `NoteGaussian`'s and is not booked here. */
  NoteSurfaceBuild = (separable: boolean, passes: number, fill: number, reads: number): void => {
    if (separable) {
      this.SeparableBuilds++;
      this.SeparablePasses += passes;
      this.SeparableFill += fill;
      this.SeparableReads += reads;
      return;
    }
    this.SurfaceChainBuilds++;
    this.SurfaceChainPasses += passes;
    this.SurfaceChainFill += fill;
    this.SurfaceChainReads += reads;
  };
  /** One pyramid built for a group of glass siblings under `?glass-group`. */
  NoteGroupBuild = (): void => { this.GroupBuilds++; };

  /** One surface TOOK a group's pyramid. Counted per take rather than added in a lump off the
   *  plan's member count, so `GroupMembers` names surfaces that actually sampled a shared backdrop
   *  and not surfaces a planner hoped would -- a member the walk culls after the plan scan saw it
   *  is the difference, and it is exactly the kind of gap a lump count hides. */
  NoteGroupMember = (): void => { this.GroupMembers++; };

  /** `n` glass fills no group covered, which built one at a time exactly as they do today. */
  NoteGroupFallback = (n: number): void => { this.GroupFallbacks += n; };

  /** One adaptive-shadow probe drew into its slot of the state row. */
  NoteShadowProbe = (): void => { this.ShadowProbes++; };

  /** The 1x1 state target was bound for one or more probes. */
  NoteShadowProbeBind = (): void => { this.ShadowProbeBinds++; };

  /** One glass batch drew; `census` is its instances' fragment census under the armed mask. */
  NoteGlassDraw = (census: GlassFragCensus): void => {
    this.GlassDraws++;
    AddGlassFragCensus(this.GlassCensus, census);
  };

  /** `?blur-cache`: a build skipped (or, under verify, that would have been). */
  NoteBlurCacheHit = (): void => { this.BlurCacheHits++; this.TotalBlurCacheHits++; };
  /** `?blur-cache`: a build that ran because its backdrop changed or nothing was cached. */
  NoteBlurCacheMiss = (): void => { this.BlurCacheMisses++; this.TotalBlurCacheMisses++; };
  NoteBlurCacheStore = (): void => { this.BlurCacheStores++; };
  NoteBlurCacheEviction = (): void => { this.BlurCacheEvictions++; this.TotalBlurCacheEvictions++; };
  NoteBlurCacheRefused = (): void => { this.BlurCacheRefused++; };
  /** `?blur-cache=verify`: one hit's cached pyramid compared against a fresh build of it. */
  NoteBlurCacheVerify = (mismatch: boolean): void => {
    this.BlurCacheVerified++;
    this.TotalBlurCacheVerified++;
    if (mismatch) { this.BlurCacheMismatches++; this.TotalBlurCacheMismatches++; }
  };

  /** One glass batch took `kind` under an armed `?glass-programs`. */
  NoteGlassProgram = (kind: GlassProgramKind): void => {
    if (kind === 'borderOnly') this.GlassBorderOnlyBatches++;
    else if (kind === 'noLight') { this.GlassNoGlowBatches++; this.GlassNoSpecBatches++; }
    else this.GlassProgramFallbacks++;
  };
}
