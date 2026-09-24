/**
 * Jaui — Canvas-based UI rendering engine.
 * Entry point. Creates a WebGL2 context and runs the render loop.
 */

import { JivAnimator } from '../Jiv/Jiv.Animator';
import { JivStyleAnimator } from '../Jiv/Jiv.StyleAnimator';
import { AnimationManager } from '../Animation/Animation.Manager';
import { SolveLayout } from '../Layout/Layout.Solver';
import { ComputeIntrinsicSizes, CascadePointScale } from '../Layout/Layout.Intrinsic';
import { TextCache } from '../Text/Text.Cache';
import { JTrace, JMs, JauiTracing } from '../Diagnostics/Jaui.Trace';
import { BumpFontGeneration, MeasureText } from '../Text/Text.Measure';
import { TextAnimator } from '../Text/Text.Animator';
import { ResolveTextStyle, type ResolvedTextStyle } from '../Text/Text.Types';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';
import { JivInstanceBuffer, JivPanelShapeOf, JivFrostCssPx, JivGlassSpanOf, JIV_FLOATS_PER_INSTANCE } from '../Jiv/Jiv.InstanceBuffer';
import { GLASS_TRACKS_LUMA_SPAN, GlassBlurNeedsOf, GlassShadowPeak, GlassIsLens } from './Glass.Pipeline';
import {
  BackdropVibrancy, CascadedVibrancy, CascadeVibrancy, FoldVibrancy, ForegroundVibrancy, TextVibrancy,
  Vibrancy, VibrancyBlendOf, VibrancyGateLine, VibrancyGraded, VibrancyInkScale, VibrancyIsActive,
  VibrancyRefusalOf, VibrancySamplesBackdrop, VibrancyTouchesInk,
  type VibrancyBlend, type VibrancyCensus, type VibrancyMode, type VibrancyValue,
} from './Vibrancy';
import { TextInstanceBuffer, TEXT_FLOATS_PER_INSTANCE } from '../Text/Text.InstanceBuffer';
import { ClipStackBuffer, EmptyClipStack, CLIP_FLOATS_PER_ENTRY, type ClipShape, type ClipStack } from './Clip.Stack';
import { type Mat2x3, MAT_IDENTITY, matMul, matApplyX, matApplyY, matScaleX, matScaleY, matCos, matSin } from '../Transform/Mat2x3';
import { ParseColor } from './Color.Parse';
import { type Mat3x3, mat3Mul, mat3FromAffine, mat3Project3D, mat3ApplyPoint } from '../Transform/Mat3x3';
import { XformBuffer, XFORM_FLOATS_PER_ENTRY } from '../Transform/Xform.Buffer';
import { SHADOW_EASE_SECONDS, SHADOW_SETTLE_TAUS, SHADOW_SETTLE_TAUS_UNSNAPPED, type Renderer, type GpuTextureHandle, type BgPaint, type ShadowBackdrop, type ProgressiveBlurParams } from './Renderer';
// `?blur-first` names the pyramid pool's own chain key so the report can say how many chains
// forty builds actually resolve to. These three are the exact functions `BlurPass.Blur` uses to
// pick it, exported for exactly this reason (see `BaseDownsampleFactor`'s own note) — a second
// copy of the rule would be a count that can silently disagree with the pass it is counting.
import {
  BlurPass, BaseDownsampleFactor, PresamplePlanFor, PyramidDepth, ResolveRegionRect, PlanBackdropUnion,
  RegionExtentSnap,
  MAX_CHAINS, CHAIN_BUDGET_BYTES,
  GAUSS_PASSES, GAUSS_MATCH_SIGMA, type GaussianMode,
  type AtlasBuildMember, type BackdropUnionPlan,
} from './BlurPass';
import { RadiusForFetches, type SeparableKRule, type SeparableSigma } from './Blur.Separable';
import { EmptyGlassFragCensus, GlassSkipNames, ParseGlassSkip, type GlassFragCensus } from './Glass.Skip';
import { GlassSoloReasonAt, GlassSoloTally, type GlassSoloReason } from './Glass.Group.Why';
import { PlanBackdropAtlas, AtlasAdmitsMember, ATLAS_LIMITS_WIRED, ATLAS_BUDGET_BYTES } from './Blur.Atlas';
import {
  PlanOcclusion, CoveredPixels, CoveredRegion, IntersectRegions, RasterPixels, IntersectPixelRect,
  PixelRectEmpty, PixelRectArea, CarvePieceTransform, CornerReach,
  DEFAULT_OCCLUSION_LIMITS, NewOcclusionNotes, OcclusionNotesLine,
  type PixelRect, type OcclusionFill, type OcclusionVerdict, type OcclusionNotes,
} from './Occlusion';
import { PassWindowOf, PassWindowText, type PassProfile } from './Pass.Timers';
import {
  PaintLedger, GuardedRect, UnionRect, BLUR_READ_GUARD_PX, BLUR_CACHE_BUDGET_BYTES, DAMAGE_MAX_PIECES,
  RECORD_NODE, RECORD_EDGE, RECORD_JANVAS, READER_FILL, READER_PBLUR, type ReaderWhy,
} from './Blur.Cache';
import { TickPace, ParseTickPace, TickPaceDefault, TickPaceText, PACE_STALL_TICKS, type PaceGate, type PaceCensus, type PaceWaited, type TickPaceMode } from './Tick.Pace';
// Backend-agnostic — Canvas orchestrates rendering against the `Renderer`
// interface only. Concrete renderers (WebGL2, WebGPU) are built by
// `Renderer.Factory.ts` and handed in. Canvas has no opinion about
// which backend is running underneath it.
import { ImageCache } from '../Image/Image.Cache';
import { BrowserPlatform, type Platform } from './Platform';
import type { MaterialType } from '../Jiv/Jiv.Types';
import { SetPredicateViewport } from '../Jss/Jss.Predicate';

/** True for glass panel materials (LiquidGlass, SolidGlass). Other non-None
 *  materials like ProgressiveBlur are compositing overlays — they don't have
 *  a backdrop sample, border, or specular, and they render in their own pass. */
const _isGlass = (m: MaterialType): boolean => m === 'LiquidGlass';
/** The finest blur (pt) an adaptive shadow compares the sharp backdrop against, so clear glass still sees
 *  its text as detail. */
const SHADOW_DETAIL_MIN_PT = 4;
/** `?ablate`: the arms it knows, the rendered frames each holds for, and the render-to-render gap
 *  past which the page was idle rather than slow. */
const ABLATE_ARMS = ['control', 'no-blur', 'no-pblur', 'no-panels', 'no-glass-draw', 'no-shadow', 'no-occlusion', 'no-ui',
  'snap64', 'snap256', 'no-pblur-draw', 'no-pblur-deep', 'no-pblur-shallow', 'mip-mrt'];
/** `no-pblur-deep` / `no-pblur-shallow`: which progressive blurs they drop, by the pyramid depth the
 *  walk would build (`maxLod`). Home's hero carries a deep one (Blur(160pt) on a phone, 7.3 levels over
 *  the whole canvas) and a shallow one (the 2pt saturation wash, 1 level, also the whole canvas); the
 *  top and bottom edges sit between at 4. Every other surface is unaffected. */
const ABLATE_PBLUR_DEEP_LOD = 6;
const ABLATE_PBLUR_SHALLOW_LOD = 1;
/** The `snapN` arms: the blur extent unit each one sets (see `RegionExtentSnap`). A surface whose
 *  clipped size changes every scrolled frame allocates a new target every frame at unit 1; at unit N
 *  it allocates once per N px of change. The hero's trace: 14-24 allocations a frame, below it 2-4. */
const ABLATE_SNAP: Record<string, number> = { snap64: 64, snap256: 256 };
const ABLATE_FRAMES = 12;
const ABLATE_IDLE_MS = 250;
/** `?blur-mips=separable`: the deepest LOD a mip consumer may read and still take the separable plan.
 *  One LOD, because past it a re-based (`k > 1`) level 0 moves the picture rather than the rounding --
 *  see `_maySeparable`. */
const SEPARABLE_MIP_MAX_LOD = 1;

/** The frost LOD an INSTANCE carries, from `JivFrostCssPx`. Mirror of Jiv.InstanceBuffer (`data[offset + 35]`). */
const _instanceFrostLod = (frostCssPx: number, dpr: number): number =>
  Math.max(0, Math.min(10, Math.log2(Math.max(0.5, frostCssPx * dpr))));

/** Below this instance frost LOD a panel may still take `sampleBackdrop`'s raw-scene branch, so it
 *  needs a snapshot bound. The shader's own threshold is 0.01; this sits WELL above it because the
 *  shader reads a float32 attribute and this side computes in float64, and a panel that fell through
 *  to the u_Scene sampler with no snapshot bound would paint the dummy texture. Every real class is
 *  either 0 frost or a whole point of it, so the widened band costs nothing. */
const SCENE_TAP_FROST_LOD = 0.05;
/** How far past its parent's box an active lens's backdrop copy reaches (pt): the lens stands up to 12 pt past the
 *  resting pill and its backdrop warp reads further out still (Glass.Pipeline.glsl, GLASS_LENS_BACKDROP_WARP). */
const LENS_BELOW_REACH_PT = 32;

/** How many pyramid chains per level-0 size `?blur-phased` asks the pool to rotate through.
 *
 *  A phased frame builds every fill pyramid BEFORE it draws any fill, so every one of them has to
 *  be alive at once -- and `BlurPass._useChain` keys a chain on its level-0 size, so without a
 *  rotation twenty same-sized builds share one set of level textures and nineteen of them are gone
 *  by the time their card draws. Twenty is the `glass-grid` / `idle` grid, which is what this
 *  instrument is pointed at; `?blur-chains=N` given alongside overrides it, so a bigger scene is
 *  measured by SAYING it is bigger rather than by reading a quietly wrong picture.
 *
 *  It is not a ceiling on surfaces, only on how many of one SIZE can be in flight. A page of
 *  twenty differently-sized surfaces needs one chain each and gets them from the size key. */
const PHASED_CHAINS = 20;

/** The deepest mip LOD a panel can read out of the pyramid built for it — the number that decides how
 *  much of a mip chain is worth building. Mirror of Jiv.Panel.frag's `sampleBackdrop`, which reads
 *  `max(0, frostLod - u_BaseFrostLod)` and nothing else. The per-surface glass path builds the pyramid
 *  AT the panel's own frost sigma, so this is 0 there and the mip chain is skipped outright. */
const _backdropMaxLod = (frostLod: number, baseFrostLod: number): number => Math.max(0, frostLod - baseFrostLod);

/** A CHROMATIC vibrancy on an element that must take the graded fold: an author error, and the reason
 *  is a hard engine limit, so it is stated with the number. */
const _refuseChromaticGraded = (v: VibrancyValue): string =>
  `[Jaui] Vibrancy(rgb(${Math.round(v.R * 255)}, ${Math.round(v.G * 255)}, ${Math.round(v.B * 255)}), ` +
  `${Math.round(v.Amount * 255)}) is CHROMATIC, and this element samples its backdrop, so the vibrancy has ` +
  'to fold into the grade that fragment already runs -- and that grade is three SCALARS (Brightness, ' +
  'Saturation, Contrast) applied to all three channels. A per-channel offset needs three more instance ' +
  "floats, and the stride is already 60 = exactly 15 vec4 attributes of WebGL2's guaranteed 16. Use a " +
  'GRAY vibrancy on this element (the amount still carries the theme flip), or put the color in the ' +
  "element's own paint.";

/** True when a non-glass panel has any non-default backdrop filter set
 *  (BackdropBrightness / Saturation / Contrast ≠ 1, BackdropFrostBlur > 0).
 *  These flat panels need the blur pyramid bound and the scene flushed just
 *  like glass does, so the shader's backdrop sample reflects everything
 *  drawn behind the panel.
 *
 *  A vibrancy counts only when it is folded into the grade (Core/Vibrancy.ts): that is the one case in
 *  which the packer writes a non-identity Brightness / Contrast the fragment will sample with. One drawn
 *  UNDER the element reads nothing and is its own draw. */
const _hasBackdropFilter = (node: Jiv): boolean => {
  const s = node.RenderStyle;
  return Math.abs(s.BackdropBrightness - 1) > 0.001
    || Math.abs(s.BackdropSaturation - 1) > 0.001
    || Math.abs(s.BackdropContrast - 1) > 0.001
    || s.BackdropFrostBlur > 0.001
    || Math.abs(s.Tint) > 0.001
    || _isFolded(node);
};

/** True when this node's backdrop vibrancy folds into its grade. */
const _isFolded = (node: Jiv): boolean => {
  const g = VibrancyGraded(node);
  return g.Amount !== 0 || g.Cover !== 0;
};

/** The vibrancy zones ONE node takes this frame, resolved once per node by `_vibrancyZonesOf`.
 *
 *  `Shape` is the shape draw of the element's own silhouette (null = none). `Ink` is the blend the
 *  element's PANEL takes, and `TextInk` the blend its TEXT batch takes: two fields because they are two
 *  draws, and `TextFilter: Vibrancy()` moves only the second. `TextScale` multiplies the glyph
 *  instance's tint lane so the ink brings `|amount|` of its own color; 1 whenever it is not scaled. */
interface VibrancyZones {
  Shape: VibrancyValue | null;
  Ink: VibrancyBlend | null;
  TextInk: VibrancyBlend | null;
  TextScale: number;
}

/** What the occlusion pre-pass accumulates as it walks. `Order` is the node visit index, which is
 *  the paint order for everything this lever reasons about; `Reads` is the subset of those indices
 *  at which a surface SAMPLES the scene, and a fill withheld before one of those would change what
 *  it read however well the final image is covered. */
interface OcclusionScan {
  Order: number;
  Fills: OcclusionFill[];
  Nodes: Jiv[];
  Reads: number[];
  Canvas: PixelRect;
  /** `Canvas` as a one-rect region, allocated once rather than per node: every coverer intersects
   *  its region against it and the pre-pass runs over the whole tree on every rendered frame. */
  CanvasRegion: PixelRect[];
  MinAreaPx: number;
}

/** A fill smaller than this share of the drawing buffer is neither a candidate nor a coverer. The
 *  win is in full-bleed surfaces, and the pair test is quadratic in the admitted count -- a page of
 *  chips must not pay for a lever that could never fire on one. */
const OCCLUSION_MIN_AREA_FRACTION = 1 / 16;

/** The one cover list every non-coverer shares, so a fill that cannot cover allocates nothing. */
const EMPTY_COVER: readonly PixelRect[] = [];

/** One rendered frame of `?blur-cache`, exactly: what `__jauiBlurCache()` publishes as `Frame`. */
export interface BlurCacheFrame {
  Surfaces: number;
  Hits: number;
  Misses: number;
  /** Misses whose backdrop WAS clean -- first sight of a surface, or a slot evicted or refused. */
  Cold: number;
  Stored: number;
  /** Glass-group members: they take the group's pyramid, which this cache does not key. */
  Grouped: number;
  Dirty: Record<'first' | 'gap' | 'key' | 'prefix' | 'full' | 'damage', number>;
  /** -1 when the region gave up and called the whole canvas dirty. */
  DirtyPieces: number;
  DirtyPx: number;
  Changed: number;
  New: number;
  Gone: number;
  Fresh: Record<'janvas' | 'shadow' | 'group' | 'edge', number>;
  Untracked: number;
  Duplicate: number;
  Seeded: boolean;
  Resting: boolean;
  Vacuous: boolean;
}

/** What `__jauiBlurCache()` publishes. `Session` is the verify arm's evidence: a long run reading
 *  `TotalVerified > 0` with `TotalMismatches == 0`. */
export interface BlurCacheCensus {
  Armed: 'off' | 'on' | 'verify';
  Refused: string;
  Frame: BlurCacheFrame | null;
  Session: { Frames: number; Resting: number; Vacuous: number };
  Bytes: number;
  Slots: number;
  BudgetBytes: number;
  Renderer: WebGL2Renderer['BlurCacheCensus'] | null;
}

/** What `__jauiOcclusion()` publishes. The census a reader outside the engine has no other way to
 *  ask for: what the pre-pass admitted, what it withheld, and -- the one that has to hold -- how
 *  many of the coverers it reasoned about the walk actually painted. */
export interface OcclusionCensus {
  Armed: boolean;
  /** Fills the pre-pass admitted as candidate or coverer (both roles, one list). */
  Candidates: number;
  /** ...of which could stand as a coverer. */
  Coverers: number;
  /** Paint indices at which something samples the scene. A fill withheld before one of these would
   *  change what it read, so no coverer past the first of them may count. */
  Reads: number;
  /** Nodes the pre-pass visited at their paint point. Its own cost, in one number. */
  Nodes: number;
  Skipped: number;
  Carved: number;
  /** Instances the carves emitted in place of the fills they replaced. */
  Pieces: number;
  /** Device pixels withheld this frame. THE effect field. */
  Px: number;
  /** Coverers the WALK painted, against `Coverers` the pre-pass planned on. These must agree. */
  CoverersSeen: number;
  /** Verdicts the walk never reached -- the same disagreement from the other end. */
  Missed: number;
  /** The pre-pass's own wall time, so the lever can be shown to cost less than it saves. */
  Ms: number;
  /** WHY the candidates that got no verdict got none -- one counter per `continue` in the pair
   *  test. A refusal nobody can name is a refusal nobody can measure, and the first fold's census
   *  reported `Refused ""` on every frame of a plan that withheld nothing. */
  Notes: OcclusionNotes;
  /** THE DEAD-PRE-PASS ALARM. 1 on a frame where the pre-pass admitted two or more candidates and
   *  at least one coverer and then withheld NOTHING -- the exact shape a pixel gate cannot tell
   *  apart from a no-op, because a no-op also reads 0 px. It is on the gate line so no fold can
   *  pass this lever silently again. */
  Vacuous: number;
  /** Empty unless a flag refused the lever outright, in which case it names which. */
  Refused: string;
}

/** `?emptypanels`, per rendered frame. Two numbers and no pre-pass: the decision is per instance,
 *  taken at the emission site from style the walk has already resolved. */
export interface EmptyPanelCensus {
  Armed: boolean;
  /** Panel instances withheld this frame because they would have shaded a quad to alpha exactly 0. */
  Panels: number;
  /** Device pixels of those quads, clipped to the drawing buffer. THE effect field. */
  Px: number;
  /** Empty unless a flag refused the lever outright, in which case it names which. */
  Refused: string;
}

/** `?glass-gaussian`, per rendered frame. Read `Builds` first, then `PlanRefused` -- 0 under the
 *  flag is the unflagged engine wearing the flag's name, and the clause that produced it is the
 *  difference between "this scene has no glass" and "every build was turned down". */
export interface GlassGaussianCensus {
  Armed: GaussianMode;
  /** Builds this frame produced by the two separable passes. THE effect field. */
  Builds: number;
  /** `GAUSS_PASSES` -- the passes ONE such build issues, against the chain's four. */
  Passes: number;
  /** `Builds * Passes`: the frame's Gaussian render passes, against the 80 that twenty chains
   *  issue. The column `EndsByKey.blur` cannot carry -- see `Scene.Ledger.GaussianPasses`. */
  TotalPasses: number;
  /** The sigma and the bilinear fetches per direction of the last such build. */
  Sigma: number;
  Fetches: number;
  /** `EndsByKey.blur` beside it -- the control invariant. The arm removes no BUILD, so this must
   *  read exactly what the off arm reads; a number that moved means something else moved too. */
  Blur: number;
  /** Megabytes of horizontal-pass temp the arm holds. Storage the arm added, on the gate. */
  TempMb: number;
  /** The last build's temp texels WRITTEN by the H pass and ADDRESSABLE by the V pass
   *  (`PlanGaussianTemp`). Must be equal: a texel read and never written is DontCare garbage. */
  TempCoverWritten: number;
  TempCoverReadable: number;
  /** `?gauss-debug` armed: the targets are cleared to magenta, and the pixels are a diagnostic. */
  Debug: boolean;
  /** The last clause inside `PlanGaussian` that turned a build down, or empty. */
  PlanRefused: string;
  /** Empty unless a FLAG refused the arm outright, in which case it names which. */
  Refused: string;
}

/** THE BLUR PLAN, per rendered frame: every per-surface glass build on the side of the plan that
 *  ran it. Read `SepBuilds` and `ChainBuilds` together -- under the default a `ChainBuilds` above 0
 *  is a build the separable plan refused, and `PlanRefused` says why. `SepPasses + ChainPasses` is
 *  the frame's per-surface blur passes, the number the blurfast lane exists to move. */
export interface BlurPlanCensus {
  /** `separable` (the default) or `chain` (`?blur-chain=on`, or a flag refused the plan). */
  Armed: 'separable' | 'chain';
  Sigma: SeparableSigma;
  KRule: SeparableKRule;
  /** `?blur-fetches=<n>`, or null. */
  Fetches: number | null;
  Upload: 'full' | 'prefix';
  SepBuilds: number;
  SepPasses: number;
  SepFill: number;
  SepReads: number;
  ChainBuilds: number;
  ChainPasses: number;
  ChainFill: number;
  ChainReads: number;
  /** Every build shape this frame, `<shape>x<count>`: `sep:a<authored>>t<target>@k<k>r<residual>f<fetches>`
   *  or `chain:a<authored>@k<k>d<depth>t<tap>>s<delivered sigma>`. */
  Classes: string;
  /** Blur draws this frame per BlurPass (`blur` per-surface + group, `root` pblur seeds and mips,
   *  `shared` the shared backdrop), and their total. */
  Draws: string;
  DrawsTotal: number;
  /** The separable target pool, `count:sizes:MB`. */
  Targets: string;
  /** Where the separable kernel compiled: `boot#<i>`, `pool#<i>` or `arm#<i>`. */
  Compile: string;
  /** `?blur-temp=clear`: magenta clears issued this frame. THE effect field for that arm - zero
   *  under the flag means it never reached a bound target, so its pixel reading says nothing. */
  TempClears: number;
  /** Clauses inside the plan that sent a separable request to the chain, `<why>x<count>`. */
  PlanRefused: string;
  /** Empty unless a FLAG refused the plan outright, in which case it names which. */
  Refused: string;
}

/** `?glass-presample`, per rendered frame. Read `Builds` first: the arm can only be judged on
 *  whether the plan actually admitted anything, and 0 under the flag is the unflagged engine. */
export interface GlassPresampleCensus {
  Armed: boolean;
  /** Builds this frame that re-based onto a pre-downsampled source. THE effect field. */
  Builds: number;
  /** The `k` the last of them took. 1 when nothing re-based. */
  K: number;
  /** `EndsByKey.blur` beside it -- the control invariant. The arm removes no BUILD, so this must
   *  read exactly what the off arm reads; a number that moved means something else moved too. */
  Blur: number;
  /** Empty unless a flag refused the lever outright, in which case it names which. */
  Refused: string;
}

/** `?glass-group`, per rendered frame. Read `Builds` and `Fallbacks` TOGETHER: an arm reading
 *  `Groups 0, Members 0, Fallbacks 20` is the engine this lane inherited wearing the flag's name,
 *  and a timing cell quoting it would pass by having done nothing. */
export interface GlassGroupCensus {
  Armed: boolean;
  /** Groups the frame planned, and the pyramids they built. Equal unless a member was culled out
   *  of the walk after the plan scan saw it, in which case the group never gets entered. */
  Groups: number;
  Builds: number;
  /** Surfaces that took a group's pyramid. THE effect field. */
  Members: number;
  /** Glass fills no group covered, which built one at a time exactly as they do today. */
  Fallbacks: number;
  /** `EndsByKey.blur` beside them -- 1 on `glass-grid` against 20 off. */
  Blur: number;
  /** One `WxH@k/depth` per group, in walk order. */
  Rects: string;
  /** Empty unless a flag refused the lever outright, in which case it names which. */
  Refused: string;
}

/** `?shadow-probe`, per rendered frame. `Probes` / `Batches` / `Ends` read 20 / 20 / 19 walked and
 *  20 / 1 / 0 grouped on glass-grid; `Moved` must read 0 and `Grouped` the members probed at capture. */
export interface ShadowProbeCensus {
  Mode: 'walk' | 'group';
  Probes: number;
  Batches: number;
  Ends: number;
  Grouped: number;
  Moved: number;
  Refused: string;
}

/** `?glass-skip`, per rendered frame. `Draws` and `Census.Frags` must read the same on every arm
 *  as on `none` -- the arms change what a glass fragment DOES, never which draws run or how big
 *  they are -- and `Census.Taps` against `Census.TapsFull` is what a stage removed. */
export interface GlassSkipCensus {
  Armed: boolean;
  /** The `u_GlassSkip` value every glass draw uploads: 0 on `none` and unflagged. */
  Mask: number;
  Stages: string[];
  /** Glass batches drawn this frame. */
  Draws: number;
  Census: GlassFragCensus;
  /** Empty unless a flag refused the arm outright, in which case it names which. */
  Refused: string;
}
import { DirtyFlag } from './Types';
import { Element as JauiElement, type DirtyTracker } from '../Element/Element';
import { Jiv } from '../Jiv/Jiv';
import { ScrollManager } from '../Scroll/Scroll.Manager';
import type { ScrollToOptions } from '../Scroll/Scroll.Types';
import { PresenceManager } from '../Animation/Presence.Manager';
import { SelectionManager } from '../Selection/Selection.Manager';
import { WebGL2Renderer, PANEL_PROGRAM_COUNT } from './WebGL2.Renderer';
import type { ShadowProbe, BlurCacheSlot } from './WebGL2.Renderer';
import { Framebuffer } from './Framebuffer';
import { GradientCurveOf, type GradientCurve } from './Gradient.Curve';
import { Janvas } from '../Janvas/Janvas';
import { FocusManager } from './Focus/FocusManager';
import { InputRouter } from './Input/InputRouter';

/** A perspective viewing context established by an ancestor (CSS `perspective`).
 *  D = viewing distance, (Ox, Oy) = vanishing point — both in CANVAS px (the same frame as the
 *  affine `eff`); the GPU stage scales by dpr. Null = no perspective in scope (the 2D fast path).
 *
 *  Module scope rather than local to `_render` because `?blur-first`'s pre-pass walks the same tree
 *  with the same transforms and has to speak the same types. */
interface PerspCtx { D: number; Ox: number; Oy: number }
/** A subtree deferred by a live teleport, with the frame it was deferred FROM. */
interface TeleportDefer { N: Jiv; M: Mat2x3; MH: Mat3x3 | null; P: PerspCtx | null }
interface TeleportScope { Deferred: TeleportDefer[]; Stack: ClipStack }

/** Everything one glass surface's pyramid build needs, resolved from the node's world transform
 *  and the clip stack. The two sites that build one (the glass FILL and the glass rim OVERLAY)
 *  each have a resolver below, and `?blur-first`'s pre-pass calls the SAME resolver — a pre-pass
 *  with its own copy of the region arithmetic is a pre-pass that can silently build a different
 *  pyramid and hand it over as if it were the same one. */
interface GlassBlurPlan {
  /** The sample region in device px, y=0 at the top — `ComputeBlur`'s `region`. */
  Region: { x: number; y: number; w: number; h: number };
  /** `ComputeBlur`'s `radius`: this surface's frost sigma in device px. */
  Radius: number;
  /** `GenerateBlurMipmap`'s argument: how deep a chain this surface can actually read. */
  MaxLod: number;
  /** The base the shader subtracts from its frost LOD, i.e. the walk's `lastBaseFrostLod`. */
  BaseFrostLod: number;
  /** This instance's own frost expressed as a LOD — the gate on the raw-scene snapshot. */
  InstFrostLod: number;
  /** The node's device-px AABB, and the margin the region added around it. */
  Px: number; Py: number; Pw: number; Ph: number; Margin: number;
  /** HOW FAR PAST ITS OWN AABB THIS SURFACE'S DRAW CAN TAP THE PYRAMID, in device px.
   *
   *  It exists for the atlas and for nothing else. A standalone pyramid is its own texture, so a
   *  tap that leaves the region is answered by CLAMP_TO_EDGE replicating the region's border
   *  texel. A SLOT of an atlas has no border: the same tap reads whatever the packer put beside
   *  it. `Jiv.Panel.frag` is not this lane's to change, so the region has to CONTAIN every tap
   *  instead, and a member whose region does not is refused and built alone.
   *
   *  The DRAW QUAD is the node's box expanded by `BorderWidth + BorderBlur` and a pixel of
   *  antialiasing (`Jiv.InstanceBuffer`, shadow excluded: the shadow is its own draw), and
   *  `sampleBackdrop` runs on every fragment of it. The REFRACTION and chromatic-aberration
   *  displacement points INWARD along the normal, so it never leaves the box.
   *
   *  Not clamped to the canvas here: the admission test does that, because a fragment outside the
   *  canvas is never rasterized and a reach that leaves it is therefore not a reach at all. */
  TapReach: number;
  /** Whether the backdrop probe runs for this surface: an adaptive shadow or adaptive glass reads it
   *  (it deepens `MaxLod`). */
  AdaptiveShadow: boolean;
  /** `JivFrostCssPx` floored at one device pixel — what the margin and the radius are built from. */
  FrostCssPx: number;
}

/** A scroll edge's pyramid (`ProgressiveBlurKind: ScrollEdge`), handed to the glass in its subtree: the handle,
 *  the region it covers and the deepest level built. A surface in it reads the content at its own frost, undimmed. */
interface EdgeBackdrop {
  Handle: GpuTextureHandle;
  Region: { x: number; y: number; w: number; h: number };
  MaxLod: number;
}

/** ONE GLASS GROUP: a run of glass siblings under one parent that share a blur class, and the
 *  single pyramid they all sample.
 *
 *  `Members` is in WALK ORDER, so `Members[0]` is the surface whose arrival is the capture point.
 *  The walk does not read it that way -- it builds on the FIRST member it actually reaches, which
 *  is `Members[0]` unless a cull removed it -- because "the scene as of group entry" is a fact
 *  about the walk and not about the plan. */
interface GlassGroup {
  Members: Jiv[];
  /** Each member's own fill plan, in member order: what `?shadow-probe=group` probes with. */
  Plans: GlassBlurPlan[];
  /** The sigma every member shares, in device px. `PlanBackdropUnion`'s `radius`. */
  Radius: number;
  Plan: BackdropUnionPlan;
}

/** How many nodes the rim pass decision looks at under one glass before it takes the pass. */
const RIM_REACH_SCAN_BUDGET = 256;

/** Is the box inside `glass`'s shape shrunk by `inset`, in the glass's own frame? The shape is convex, so the four
 *  corners decide; each rounded corner is taken as a circle of 1.53 radii, which a continuous corner lies outside of. */
const _insideInsetShape = (x0: number, y0: number, x1: number, y1: number, glass: Jiv, inset: number): boolean => {
  const bx = glass.X, by = glass.Y, bw = glass.Width, bh = glass.Height;
  if (x0 < bx + inset || y0 < by + inset || x1 > bx + bw - inset || y1 > by + bh - inset) return false;
  const radii = glass.RenderStyle.BorderRadius;
  const half = Math.min(bw, bh) * 0.5;
  for (let i = 0; i < 4; i++) {
    const r = Math.min(1.53 * radii[i], half);
    if (r <= inset) continue;
    const left = i === 0 || i === 3, top = i < 2;
    const cx = left ? bx + r : bx + bw - r, cy = top ? by + r : by + bh - r;
    const px = left ? x0 : x1, py = top ? y0 : y1;
    if ((left ? px < cx : px > cx) && (top ? py < cy : py > cy) && Math.hypot(px - cx, py - cy) > r - inset) return false;
  }
  return true;
};

/** Does `outer` contain `inner`? Both are device-px screen rects with y down, as
 *  `GlassBlurPlan.Region` is. Closed on both edges: a region is a texel span, and an inner rect
 *  whose right edge is the outer's right edge is fully inside it. */
const _regionContains = (
  outer: { x: number; y: number; w: number; h: number },
  inner: { x: number; y: number; w: number; h: number },
): boolean =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w
  && inner.y + inner.h <= outer.y + outer.h;

/** `EndsByKey` as one readable token: `snapshot:1,blur:2`, or `none` on a frame that ended no
 *  encoder at all. Sorted, so two frames' lines can be diffed by eye, and `none` rather than an
 *  empty string, because an absence and a zero must not print the same. */
const _endsByKey = (m: Record<string, number>): string => {
  const keys = Object.keys(m).sort();
  return keys.length === 0 ? 'none' : keys.map((k) => `${k}:${m[k]}`).join(',');
};

export class Canvas implements DirtyTracker {
  readonly Element: HTMLCanvasElement;
  readonly Root: Jiv;

  /** Set of leaf nodes that have called `MarkLayoutDirty` since the last
   *  layout pass. Populated via `Notify` from Element side. Used by `_tick`
   *  to scope re-solve to the smallest containing subtree (single dirty
   *  node => walk up to first ancestor with explicit Width+Height; fall
   *  back to root for multi-dirty or unbounded ancestors).
   *
   *  Cleared after every solve. Membership is by-reference; nodes that get
   *  removed from the tree mid-frame are simply ignored on next solve
   *  (their entry is dropped when the set is wiped, no-op until then). */
  private _dirtyNodes: Set<JauiElement> = new Set();

  private _renderer!: Renderer;
  private _platform!: Platform;
  private _width: number = 0;
  private _height: number = 0;
  private _dpr: number = 1;
  private _running: boolean = false;
  private _frameId: number = 0;
  private _lastTime: number = 0;
  /** Headless render-to-texture mode: no ResizeObserver / DPR watch / DOM-event binds, no swap-chain
   *  `PresentScene`. The scene renders into the renderer's `_sceneFbo` and the caller samples it (e.g. the
   *  reality worker binds it as the grass FieldColor). Size is set manually via `SetSizePx`; frames are driven
   *  manually via `RenderHeadless`. Default false → normal on-screen Canvas, unchanged. */
  private _headless: boolean = false;
  private _panelBuffer = new JivInstanceBuffer();
  private _textBuffer = new TextInstanceBuffer();
  private _clipBuffer = new ClipStackBuffer();
  // Per-frame sparse table of 3D homographies (shared by panel/text/jline).
  private _xformBuffer = new XformBuffer();
  /** JSS `@Name: value` variables in scope. The Angular layer pushes the
   *  active registry's var table in via `SetJssVars`; layout / intrinsic
   *  passes thread it through `ResolveContext.Vars` so `Length.Resolve`
   *  can substitute `@Name` references in authored expressions. Empty
   *  map by default so non-Angular consumers that don't set it still
   *  resolve correctly (missing vars warn + fall back to 0). */
  private _jssVars: Map<string, string> = new Map();
  private _textCache!: TextCache;
  private _imageCache!: ImageCache;

  // ── First-frame ledger ──
  // Written once each on the way to the first present and read by the marks in `_tickInner`.
  // `_ffPresented` is the latch: it flips at the present, which is also where the first-frame hook
  // fires, so it is true for the same instant the app's `jaui:first-frame` mark names.
  private _ffPresented = false;
  private _ffTicked = false;
  /** Ticks that bailed on a 0x0 canvas before the bridge delivered a real size. A non-zero count
   *  here means the first frame was waiting on a `resize` message, not on the engine. */
  private _ffZeroSizeTicks = 0;

  /** Public image cache — load images/SVGs here, reference them from Jivs. */
  get Images(): ImageCache { return this._imageCache; }
  /** Focus and keyboard-modality state — consumers can set FocusedScroller
   *  to override which scroll container receives keyboard scroll keys. */
  get Focus(): FocusManager { return this._focusManager; }
  /** Specular tilt offset — added to lightDir for specular computations only. */
  private _animationManager = new AnimationManager();
  private _animators = new Map<JauiElement, JivAnimator>();
  /** Nodes already warned about non-finite layout results (one warn per node). */
  private _nonFiniteWarned = new WeakSet<JauiElement>();
  private _styleAnimators = new Map<Jiv, JivStyleAnimator>();
  /** Set by SetJssVars. The next layout hands every node a context carrying the new var table, and only
   *  THEN are the style animators woken: a colour or tint that reads a var (a theme flip) moves only when
   *  its animator resolves again, and a settled animator sleeps. Waking before that layout would spend the
   *  wake resolving against the old table, and the animator would sleep through the flip. */
  private _varsChangedSinceLayout = false;
  private _textAnimators = new Map<JauiElement, TextAnimator>();
  // Vector-SVG paint lives on the node (Element.SvgVector), set by the SvgJiv
  // binding's svg-set op. This is the cache of resolved fill colors by raw string.
  private _svgColorCache = new Map<string, ReturnType<typeof ParseColor>>();
  private _scrollManager!: ScrollManager;
  private _selectionManager!: SelectionManager;
  private _focusManager!: FocusManager;
  private _inputRouter!: InputRouter;
  private _maxFrostBlur: number = 0;

  // ─── Debug HUD ───
  private _dprOverride: number | null = null;
  private _debugHud: HTMLDivElement | null = null;
  private _hudDeltas: Float32Array = new Float32Array(30);
  private _hudIdx: number = 0;
  private _hudCount: number = 0;
  private _hudLastWrite: number = 0;
  /** When true (set by `?wkr-jaui-prof` URL param), capture per-frame phase
   *  timings AND emit a per-second console summary. Decouples the
   *  instrumentation from the DOM HUD — that only mounts in main-thread
   *  Canvas instances; the same engine code runs in the Jaui worker where
   *  there's no DOM, but we still want phase data printed to console for
   *  optimization passes. */
  private _consoleProfilingEnabled: boolean = false;
  private _profLastDumpMs: number = 0;
  private _profSum = { Dirty: 0, Layout: 0, Text: 0, Render: 0, Total: 0 };
  private _profN = 0;

  // TEMP perf-isolation toggles (URL params, off by default — zero cost unless
  // set). Route a blur surface to the plain-panel branch so the worker-fps
  // delta is that surface's full-res blur cost. Remove after diagnosis.
  //   ?no-pblur       skip all progressive-blur surfaces (render flat)
  //   ?no-glass       skip all glass / backdrop-filter surfaces (render flat)
  //   ?no-pblur-draw  build the pblur pyramid but skip the DrawProgressiveBlur
  //                   pass — isolates build cost vs the bicubic draw shader
  private _diagNoPblur: boolean = false;
  private _diagNoGlass: boolean = false;
  private _diagNoPblurDraw: boolean = false;
  private _diagNoReality: boolean = false; // [diag ?no-reality] skip the janvas/field pre-pass → UI-only cost
  private _diagNoUi: boolean = false;       // [diag ?no-ui] skip the Jaui UI tree walk → field-only cost
  /** `?ablate` (with `?trace`): the phone's own ablation, in ONE session. Every `Frames` rendered
   *  frames it switches to the next arm, and it books each render-to-render interval to the arm that
   *  rendered it, so a hero scroll on the device prices every arm against the same content, the same
   *  thermals and the same finger. Null when unarmed. */
  private _ablate: {
    Arms: string[]; I: number; Count: number; Last: number; Skip: boolean; Cycle: number;
    Samples: Map<string, number[]>;
  } | null = null;
  private _diagNoBlur: boolean = false;     // [diag ?no-blur] no-op the backdrop blur build → blur fill cost
  private _diagNoPanels: boolean = false;   // [diag ?no-panels] skip non-glass panel fill (SDF+shadow+border) → panel share
  private _diagNoShadow: boolean = false;   // [diag ?no-shadow] zero panel drop-shadow → shadow overdraw share
  private _diagNoGlassDraw: boolean = false; // [diag ?no-glass-draw] skip glass refraction draw (keep blur) → glass-draw share

  /** `?blur-first` — MEASUREMENT ONLY, WRONG PIXELS. Every pyramid the walk would build is built
   *  BEFORE the bed's first draw, in the order the walk would have built them; the walk then takes
   *  the recorded handle instead of building. Same builds, same regions, same radii, same depths,
   *  same source — different ORDER.
   *
   *  It is the one-line test of H3. `?blur-src-clear` and `?blur-src-static` both read the baseline
   *  to within 1%, which kills the read's own bandwidth (H1) and a write→sample hazard (H2) at
   *  once, and `gpuMs` is top-level task time in the GPU PROCESS rather than hardware time — so
   *  what is left is a CPU↔GPU synchronisation stall inside the pyramid path whose wait lasts as
   *  long as the GPU's backlog, and the backlog is large only when the bed's fill is queued ahead
   *  of it. Move every wait point in FRONT of the bed and H3 says the interaction term goes with
   *  it; a per-pass cost story says nothing moves. See ShowStudio.Documentation/Perf/README.md,
   *  "blur-src: BOTH HYPOTHESES DIE TOGETHER".
   *
   *  Armed only alongside `?blur-src-clear` / `?blur-src-static`: without one, the pyramids would
   *  sample a scene nothing has drawn into yet, which is a DIFFERENT experiment (the
   *  `?no-panels`-shaped one) wearing this flag's name. */
  private _blurFirst: boolean = false;
  /** Pre-built pyramid handle per glass surface. */
  private _blurFirstFill = new Map<Jiv, GpuTextureHandle>();
  /** The flag's own gate, reported once per shape change on the trace channel.
   *
   *  `Used` + `Missed` must equal `Fill`, and `Missed` must be 0: a MISS is the walk
   *  reaching a build site the pre-pass never reached, i.e. the pre-pass and the walk disagreeing
   *  about which surfaces build. A lane that reported a number without this line would be
   *  reporting "the builds moved" when some of them had not.
   *
   *  `Chains` is the count of DISTINCT pyramid-pool chain keys the pre-pass's builds resolve to,
   *  computed with BlurPass's own `ResolveRegionRect` rather than a second copy of the rule. The
   *  pool holds one chain per LEVEL-0 SIZE, not one per build, so N builds of equal-sized surfaces
   *  share one set of level textures and each overwrites the last — which is why this flag's pixels
   *  are wrong, and the number that says by how much. `Coarse` counts builds whose σ-adaptive base
   *  factor k > 1, where the chain key is the pre-downsampled size and this count is a lower bound. */
  private _blurFirstStats = { Fill: 0, Used: 0, Missed: 0, Dup: 0, Coarse: 0, Chains: 0, Keys: '' };
  private _blurFirstKeys = new Set<string>();
  private _blurFirstLastLine: string = '';

  // ── `?blur-phased` — MEASUREMENT ONLY, DIFFERENT PIXELS ──────────────────────────
  /** The frame in TWO scene encoders instead of one per build.
   *
   *  The join (`Perf/XcTrace.Finding.md`) priced `baseline - blur-dummy` on `glass-grid` at
   *  33.45 ms per frame = 25.47 ms more GPU WORK + 7.98 ms GPU IDLE, and the work is COUNT, not
   *  per-pass cost: +2 full-canvas-class fragment passes at an unchanged ~5.7 ms each, and +38-44
   *  mid-band (~300 us) fragment intervals that are NOT pyramid passes — the same forty builds are
   *  present under `?no-panels` at 34.9 mid-band intervals per frame. H5: every scene-encoder
   *  restart with real content in the target costs its tile load+store (~300 us for 16 MB) plus a
   *  fixed bubble, and a CLEARED target's load/store is free. Its test is any change that removes
   *  ENCODERS with pixels held constant, which is this.
   *
   *  Today's walk restarts the scene encoder once per card: fill build, fill draw. Phased, the frame
   *  runs in three passes over the same tree and two scene encoders:
   *
   *    1. the bed, and every node ahead of the FIRST surface that builds a pyramid   — encoder A
   *    2. ALL the fill pyramids, from the scene as of (1)      — the first read ends A, rest free
   *    3. ALL the fills, their children and their rims, in walk order                — encoder B
   *
   *  Same builds (same regions, sigma, depth, `k`, same DOWN/UP passes), same draws, same draws per
   *  tick. The ledger counts an END, and the frame's last encoder ends at the present, which
   *  `NoteFrameEndDrain` deliberately does not count — so two encoders read as `SceneSwitches` **1**.
   *
   *  THE PIXEL CHANGE, STATED. Today fill N's pyramid is built from the scene AFTER fills 0..N-1
   *  were drawn, so its refraction taps (fill margin 64.75 px at dpr 2, against a 40 px gutter)
   *  reach ~25 px into an earlier neighbour's box and see that neighbour's GLASS. Phased, every
   *  fill pyramid sees the bed only. So the difference is confined to the sample-margin overlap between
   *  adjacent surfaces. `pixels=DIFFERENT`, not WRONG: it is a legitimate composition and whether
   *  it is acceptable is Jack's call, with pictures. Under `?blur-src-clear` / `-static` every
   *  build reads the same stand-in and the difference vanishes, which makes that pairing the
   *  cleanest H5 cell of all — a pure count test whose two-arm diff must read exactly 0. */
  private _blurPhased: boolean = false;
  /** Which pass of the phased walk is running. 0 is every unflagged frame, and every predicate
   *  below answers the walk's own answer at 0, so an unflagged frame takes the branches it always
   *  did. 1 = the bed; 2 = the fills and their children. */
  private _phasedPass: 0 | 1 | 2 = 0;
  /** Pass 1 has reached the first surface that builds a pyramid, and paints nothing further. */
  private _phasedStop: boolean = false;
  /** Pass 2 has reached that same surface, and paints from there on. The two flags flip at the
   *  SAME node in the same walk order, which is what makes passes 1 and 2 a PARTITION of the walk
   *  rather than two overlapping subsets: no node paints twice and none is dropped, so z-order is
   *  the walk's exactly. */
  private _phasedStarted: boolean = false;
  /** The adaptive-shadow probe, measured in the build phase beside its own fill build rather than in
   *  the walk. It has to move: in pass 2 the scene target is bound and a draw has landed since the
   *  last end, so the probe's `shadow-state` bind would END the scene encoder once per card. Beside the build it rides the end the build already paid,
   *  exactly as it does at baseline. It is also PIXEL-NEUTRAL on `glass-grid`: the probe samples
   *  strictly inside the surface's OWN box (its taps are `u_Rect.xy + cell * u_Rect.zw`), nothing
   *  else has painted there in either arm, so it reads the same bed. On a page whose surfaces
   *  overlap it changes by the same rule the fill does. */
  private _phasedShadow = new Map<Jiv, ShadowBackdrop>();
  /** What the build phase built, in build order, so the probe pass can run over it without another
   *  walk. */
  private _phasedBuilt: { Node: Jiv; Plan: GlassBlurPlan; Handle: GpuTextureHandle }[] = [];
  /** The two things a phased arm is NOT comparable across. `Snaps` counts surfaces that took a raw
   *  scene snapshot: the snapshot stays where the walk puts it (a scene READ is not a build), so
   *  each one is an extra encoder end AND is taken from a different scene state than its own
   *  pyramid. `Pblur` counts ProgressiveBlur surfaces, which seed from a snapshot at their own
   *  point in the walk and are neither pre-built nor moved. Both read 0 on `glass-grid` and on
   *  `idle` — every glass class there authors frost, so `instFrostLod` never falls under the
   *  scene-tap threshold and no snapshot is taken — and a reading with either non-zero should be
   *  discarded rather than reported. */
  private _phasedStrays = { Snaps: 0, Pblur: 0 };
  private _phasedLastLine: string = '';

  // -- `?pyramid-atlas` -- A COMPOSITION CHANGE, AND THE ATLAS THAT PAYS FOR IT (ARMS, NOT THE
  //    DEFAULT: see the ruling under `_pyramidAtlas`) ------------------------------------------
  /** Every glass card's backdrop pyramid built from the scene BEFORE any card is drawn, and the
   *  whole phase's builds issued as ONE atlas.
   *
   *  THE RULING. Jack approved this on 2026-09-20, with the two decision images: a card no longer
   *  refracts its earlier-drawn neighbours' glass, which is 34,830 px (0.85% of the page) at max
   *  12/255, mean 2, confined to the edge bands facing earlier-drawn neighbours. That measurement
   *  is `?blur-phased`'s, on `?blur-phased`'s composition -- which is why this flag REUSES the
   *  phased traversal wholesale instead of inventing a fourth ordering. The two arms then differ
   *  in the atlas and in nothing else, so `?pyramid-atlas` against `?blur-phased` on one build is
   *  a test of the ATLAS alone and the ruling's number is the only pixel change the default makes.
   *
   *  WHAT IT BUYS. A pyramid pass is a destination bind and therefore its own render command
   *  encoder, ~69 us on the M4 (`Perf/PyramidAtlas.Finding.md` section 2). `glass-grid`'s forty
   *  builds are 160 of them; two atlases are 8. 152 encoders is ~-10.5 ms per render at dpr 2.
   *
   *  WHAT IT COSTS. ~55 MB of GPU texture against a 2.64 MB rotating pool, which is why the pass
   *  runs under `ATLAS_LIMITS_WIRED` rather than the shipped 48 MB chain budget, and why the
   *  planner SPLITS a run it cannot fit instead of evicting mid-frame.
   *
   *  `?pyramid-atlas=off` restores the per-card, per-draw composition in the same binary. That is
   *  the engine this lane inherited, and it is the "before" every gate reads against.
   *
   *  IT IS NO LONGER THE DEFAULT, and what changed is a measurement, not a mind. JACK'S FOURTH
   *  RULING (2026-09-20 ~14:20, told what the arm had actually bought): "Back to today's picture."
   *  The M4's three-arm cell read `all` -1.69 ms and `fills` -0.78 ms per render at dpr 2 against
   *  a predicted -10.5 and -5.2, and no frame-rate change at either resolution -- and under Jack's
   *  own standard (physically right, or MORE accurate) the change is not more accurate: a real
   *  glass edge DOES refract its neighbour. So an absent flag is `off`, today's composition; bare
   *  `?pyramid-atlas` is still `fills`; `fills` and `all` stay as measurement arms. The whole
   *  machinery below is unchanged -- what moved is one initialiser and which arm has to be asked
   *  for by name. */
  private _pyramidAtlas: boolean = false;
  /** `?occlusion` -- AN OPAQUE FILL THAT LATER OPAQUE FILLS COVER IS NOT DRAWN. Default ON.
   *
   *  `Core/Occlusion.ts` carries the pixel argument and the arithmetic; this field is only whether
   *  the walk consults it. `?occlusion=off` restores the previous engine's emission byte for byte
   *  in the same binary -- no pre-pass runs, no verdict is looked up, no instance is withheld. */
  private _occlusion: boolean = true;
  /** The frame's verdicts, keyed by the node whose fill they rule on. Built by the pre-pass before
   *  the walk, because a coverer is by definition LATER than what it covers and the walk cannot
   *  know it at the moment it would emit P. Empty when the flag is off or nothing was admitted. */
  private _occlusionPlan = new Map<Jiv, OcclusionVerdict>();
  /** Every node the pre-pass counted as a COVERER, and the count the walk actually painted. The
   *  two traversals are the same functions, so these must agree; if they ever do not, a verdict
   *  was taken on a tree the walk did not paint, and that is a pixel bug rather than a slow frame.
   *  The gate line prints both. */
  private _occlusionCoverers = new Set<Jiv>();
  /** Non-null only while the pre-pass traversal is running. `_blurFirstNode` is shared with it --
   *  deliberately, so there is ONE answer to "which nodes paint, in what order" -- and this is how
   *  that traversal knows to record instead of to build. */
  private _occlusionScan: OcclusionScan | null = null;
  private _occlusionStats = {
    Candidates: 0, Coverers: 0, Reads: 0, Nodes: 0, Skipped: 0, Carved: 0, Pieces: 0,
    Px: 0, CoverersSeen: 0, Missed: 0, Ms: 0, Notes: NewOcclusionNotes(), Vacuous: 0, Refused: '',
  };
  /** The last `jaui:occlusion` gate line, printed on a SHAPE change rather than per frame. */
  private _occlusionLastLine = '';
  /** `?glass-presample` -- THE PER-SURFACE PYRAMID BUILT FROM A HALF-RESOLUTION BASE.
   *
   *  The engine already pre-downsamples a backdrop by `k ~ sigma / BASE_SIGMA` before running
   *  the pyramid on it -- the band-limit argument: a Gaussian of sigma is band-limited far below
   *  the Nyquist of a `sigma/4` grid, so the pre-downsample discards nothing the blur would have
   *  kept -- but `BaseDownsampleFactor` gates it on the region being at least 15% of the canvas.
   *  A `glass-grid` card's fill region is 568x436 of 2560x1600, 6%, so it is pinned to k=1 while
   *  its own sigma (8 device px at dpr 2, against `BASE_SIGMA` 4) earns k=2.
   *
   *  Under `on` the gate is lifted for per-surface glass builds with `MaxLod == 0` -- the fills
   *  and the rims; the shared backdrop and pblur pass the gate already and are untouched -- and
   *  each pyramid runs over a QUARTER of the texels from a base the pre-pass halves. It is the
   *  only lever the phase has left on the pyramids: passes, encoders and draws have each been
   *  removed and measured and the cost did not follow any of them (the atlas, the instanced
   *  draws, the direct-gather border), so what is left is the SAMPLING WORK, and the way to
   *  spend less of it is fewer texels.
   *
   *  DEFAULT OFF, and the reason is a picture: see `PresamplePlanFor` in `Core/BlurPass.ts`. The
   *  arm's first three hops are the unflagged arm's own first three hops -- same program, same
   *  rect, same tap offset, bit for bit -- and the whole difference is that level 0 comes back at
   *  half resolution, so the final 2x reconstruction is the consumer's hardware bilinear instead
   *  of the pyramid's 8-tap tent hop. The lane does not decide that; Jack does, with images. */
  private _glassPresample: boolean = false;
  /** `?glass-gaussian=on|off|match` -- THE PER-SURFACE GLASS BUILD AS TWO SEPARABLE PASSES.
   *
   *  `on` runs a true Gaussian at the AUTHORED sigma. `match` runs it at `GAUSS_MATCH_SIGMA`, the
   *  sigma today's chain is measured to actually deliver, so the KERNEL SHAPE difference can be
   *  shot with the width held -- the two halves of the picture change, separated, because they
   *  turned out to be very different sizes. `off` is the engine as it ships, byte for byte.
   *
   *  DEFAULT OFF, and a bigger picture change than the brief anticipated: see `GAUSS_MATCH_SIGMA`
   *  in `Core/BlurPass.ts`. Jack has not seen either arm. */
  private _glassGaussian: GaussianMode = 'off';
  /** The last `jaui:glass-gaussian` gate line, printed on a SHAPE change rather than per frame. */
  private _glassGaussianLastLine = '';
  /** Empty unless a flag refused the arm outright, in which case it names which. */
  private _glassGaussianRefused = '';
  /** `?gauss-debug` beside an armed separable path (the default plan or `?glass-gaussian`): every
   *  separable target is CLEARED to magenta instead of invalidated, so a texel a pass leaves
   *  unwritten is visible in one shot. */
  private _gaussDebug = false;
  /** THE PER-SURFACE GLASS BUILD'S PLAN. DEFAULT the separable plan (`Core/Blur.Separable.ts`):
   *  downsample by sigma, one linear-sampled Gaussian pair at the residual, at today's DELIVERED
   *  width. `?blur-chain=on` is the control: the dual-filter chain byte for byte. */
  private _blurSeparable = true;
  private _blurSeparableRefused = '';
  /** `?blur-mips=separable|chain`: may a SHALLOW mip consumer (`0 < MaxLod <= SEPARABLE_MIP_MAX_LOD`)
   *  take the separable plan? DEFAULT separable; `=chain` is the dual-filter chain for those surfaces,
   *  byte for byte. See `_maySeparable`. */
  private _blurSeparableMips = true;
  /** `?blur-sigma=delivered|authored`. */
  private _blurSigma: SeparableSigma = 'delivered';
  /** `?blur-fetches=<n>`: every separable build runs exactly `n` fetches at its own sigma. */
  private _blurFetches: number | null = null;
  /** `?blur-k=round|floor`: `floor` keeps 4 base texels of sigma (the higher-quality arm). */
  private _blurKRule: SeparableKRule = 'round';
  /** `?gauss-upload=prefix`: the pre-lane uniform upload, as a control for the Metal fix. */
  private _gaussUploadPrefix = false;
  /** `?blur-temp=discard|clear|keep`: what a bound blur target is told about its previous contents.
   *  `BlurPass.TempLoad` carries the argument; the short version is that the M4's seam is one stale
   *  texel in a temp twenty builds share, and `discard` (the shipped `invalidateFramebuffer`) is
   *  what makes an uncovered texel undefined rather than merely old. */
  /** `?frame-trace` — emit ONE compact line per rendered frame. `jaui:render:end` is deliberately a
   *  FIRST-FRAME diagnostic (it is latched on `ff && _ffPresented`, beside `glyphs:first` and
   *  `images:at-first-frame`), so before this flag existed there was no per-frame series at all:
   *  steady-state work could only be read as a pass-class TOTAL, which sums overlapping timer
   *  queries and is not a frame time. Unarmed this costs one boolean test per frame. */
  private _frameTrace = false;
  /** Frames emitted so far under `?frame-trace`, so a long run cannot fill the mark buffer. */
  private _frameTraceCount = 0;
  private _frameTraceCap = 600;

  private _blurTemp: 'discard' | 'clear' | 'keep' = 'discard';
  /** The last `jaui:blur-plan` gate line, printed on a SHAPE change rather than per frame. */
  private _blurPlanLastLine = '';
  /** The last `jaui:glass-presample` gate line, printed on a SHAPE change rather than per frame. */
  private _glassPresampleLastLine = '';
  /** Empty unless a flag refused the arm outright, in which case it names which -- so a control
   *  shot can be told from an arm that quietly disarmed. Published on the census. */
  private _glassPresampleRefused = '';
  /** `?glass-group` -- THE CONTAINER-SCOPED SHARED BACKDROP. One pyramid per GROUP of glass
   *  siblings, captured when the walk ENTERS the group, sampled by every member of it.
   *
   *  THE LAW, which is Jack's ruling of 2026-09-20 and Apple's rule before it (WWDC25: "glass can
   *  not sample other glass ... a glass container allows these elements to share their sampling
   *  region"; "always avoid glass on glass"):
   *
   *    A glass GROUP is a run of glass siblings under one parent. Its backdrop is the scene AS OF
   *    THE WALK'S ENTRY to the group -- captured once, before any member paints -- and every
   *    member samples it. Nothing painted inside the group (a member's glass, rim, shadow or
   *    text, or a non-glass sibling between two members) is ever sampled by another member. A
   *    group entered LATER in the walk captures the scene with earlier groups' glass in it.
   *
   *  That second sentence is why this is not `?wkr-shared-backdrop`, and why it needs no
   *  dirty-rect machinery: a layer above still blurs everything below it, glass included, because
   *  it captures later. `Perf/PyramidUnion.Finding.md` built the planner this calls and reverted
   *  it under the law this repeals; `PlanBackdropUnion` carries the whole argument.
   *
   *  DEFAULT OFF in this lane. Jack has ruled the PICTURE -- the change is the one already shot as
   *  "phased" on `glass-grid`: 34,830 px (0.85%), max 12, mean 2.1, a card no longer refracting
   *  its earlier neighbour's glass in the gap band -- but the gate still has to see it on seven
   *  shots before the default moves. */
  private _glassGroup: boolean = true;
  /** The last `jaui:glass-group` gate line, printed on a SHAPE change rather than per frame. */
  private _glassGroupLastLine = '';
  /** Empty unless a flag refused the arm outright, in which case it names which. */
  private _glassGroupRefused = '';
  /** Every planned group, indexed by EVERY member so the walk's lookup is one map hit at the fill
   *  site rather than a scan. Rebuilt by `_glassGroupPrepass` each frame it is armed. */
  private _glassGroups = new Map<Jiv, GlassGroup>();
  /** The pyramid each member samples, filled when the walk first ENTERS the group. A member finds
   *  it already here, which is what makes "the scene as of group entry" true by construction
   *  rather than by a timestamp. */
  private _glassGroupHandles = new Map<Jiv, GpuTextureHandle>();
  /** Set for the duration of the plan scan: the traversal RECORDS the glass fills it would build
   *  instead of building them, because a group is a property of a RUN and not of a member. Null
   *  on every other path. */
  private _glassGroupScan: { Node: Jiv; Parent: Jiv | null; Plan: GlassBlurPlan }[] | null = null;
  /** The parent of the node `_blurFirstNode` is about to visit, set by `_blurFirstDescend` for
   *  the scan alone. Null for the Root and for a teleported node replayed out of its own scope,
   *  and a null parent never groups with anything -- a node whose container the walk has left is
   *  not a sibling of anything in it. */
  private _glassGroupParent: Jiv | null = null;
  /** The frame's group census, for the gate line. `Fallbacks` is the one to read beside `Members`:
   *  a plan that grouped nothing and fell back on everything is the unflagged engine. */
  private _glassGroupStats = {
    Groups: 0, Builds: 0, Members: 0, Fallbacks: 0, Solo: 0, MaxLod: 0, Unplanned: 0, Rects: '', Why: 'none',
  };
  /** `?shadow-probe=walk|group` -- WHERE A GROUP MEMBER'S ADAPTIVE-SHADOW PROBE RUNS.
   *
   *  `walk` (the default while measured) is today: each member probes just before its own draw.
   *  Under `?glass-group` the builds no longer end the scene's encoder per card, so that probe's
   *  1x1 `shadow-state` bind does instead -- `EndsByKey` `{blur:1, shadow-state:19}` on glass-grid,
   *  twenty scene segments either way. `group` probes EVERY member at the group's capture, beside
   *  its one build, in one bind (`MeasureShadowBackdrops`), where the build has already ended the
   *  encoder: the group's members then draw in ONE scene segment.
   *
   *  PIXEL-NEUTRAL wherever nothing painted between group entry and member N's draw lands inside
   *  member N's probe footprint, which is member N's own box plus the half-texel of a linear tap.
   *  The pyramid half of the reading is the group's handle in both arms; only the sharp scene tap
   *  moves in time, and it reads the same texels. On glass-grid the nearest foreign paint is a
   *  neighbour's shadow quad, 32 px (sideways) / 36 px (vertically) outside its face, against a
   *  40 px gap: 8 / 4 px clear. `Shadow.Probe.test.ts` pins it on the real walk's own draws. On a
   *  page whose members overlap, the capture reads the bed where the walk read the neighbour --
   *  the rule the group already applies to the fill, and the one Jack ruled.
   *
   *  The ease is unchanged: same slot, same dt, same snap, one probe per member per frame. */
  private _shadowProbe: 'walk' | 'group' = 'group';
  private _shadowProbeRefused = '';
  private _shadowProbeLastLine = '';
  /** The slot each member's probe wrote at the group's capture, with the rect it probed so the walk
   *  can check the member it draws is the one that was measured. */
  private _groupShadow = new Map<Jiv, { Slot: number; Rect: { x: number; y: number; w: number; h: number } }>();
  /** `Grouped`: members whose draw took a capture-time reading. `Moved`: members probed at the
   *  capture whose walk rect differed, or who fell back off the group after it was probed -- it
   *  must read 0; a non-zero reading voids the cell. */
  private _shadowProbeStats = { Grouped: 0, Moved: 0 };
  /** `?blur-cache`'s last FILL verdict, for the probe that follows it: a clean fill is a probe whose
   *  pyramid and sharp tap are last frame's (`Shadow.Texel`). And each surface's last probe rect. */
  private _bcFillClean: Jiv | null = null;
  private _probeLast = new WeakMap<Jiv, { x: number; y: number; w: number; h: number; Lod: number }>();
  /** `?glass-skip` -- THE GLASS DRAW'S STAGE ABLATIONS. `null` is unarmed (today's engine, no
   *  census); a number is the `u_GlassSkip` mask every glass draw uploads, 0 for `none`, the control
   *  that prints the census at no GPU cost. Picture-DIFFERENT instruments by design; default off.
   *  See `Glass.Skip.ts` for the stages and `Jiv.Panel.frag` for what each one removes. */
  private _glassSkip: number | null = null;
  private _glassSkipRefused = '';
  /** The last `jaui:glass-skip` gate line, printed on a SHAPE change like every gate above it. */
  private _glassSkipLastLine = '';
  /** `?emptypanels` -- A PANEL THAT PAINTS NOTHING IS NOT PUSHED. Default ON.
   *
   *  A fully transparent background with no painted border and no shadow shades its whole quad to
   *  `result.a` exactly 0, and source-over at source alpha 0 leaves the destination bit-identical
   *  on every channel. So the instance is withheld. `?emptypanels=off` restores the previous
   *  engine's emission byte for byte in the same binary. `_isEmptyPanel` carries the rule. */
  private _emptyPanelCull: boolean = true;
  private _emptyPanelStats = { Panels: 0, Px: 0, Refused: '' };
  /** VIBRANCY, per rendered frame (Core/Vibrancy.ts). ONE instrument: `__jauiVibrancy()` and the
   *  `jaui:vibrancy` gate line are both built from this object by `_vibrancyCensus()`.
   *
   *    Authored / Inherited   where each applied vibrancy came from. An AUTHORED one emits the shape
   *                           draw; an INHERITED one only makes the node's own paint vibrant.
   *    IgnoredSampling        inherited vibrancy a node DROPPED because it samples its backdrop.
   *    Under / Graded         the two implementations of the shape draw.
   *    Refused                why each graded shape draw could not go under, by name.
   *    Builds                 every pyramid build an UNDER-drawn element's own paint caused. MUST BE 0.
   *    CascadeVisited         nodes the cascade walked; CascadeCarried, how many carried a value.
   *    PanelBatches           the shared Color-batch draws: a shape draw mid-run splits one in two. */
  private _vibrancyStats = {
    Authored: 0, Inherited: 0, IgnoredSampling: 0, TextInk: 0,
    Under: 0, Graded: 0, Builds: 0,
    CascadeVisited: 0, CascadeCarried: 0,
    PanelBatches: 0, Refused: {} as Record<string, number>,
  };
  /** The last `jaui:vibrancy` gate line, printed on a SHAPE change rather than per frame. */
  private _vibrancyLastLine = '';
  /** The last `jaui:emptypanels` gate line, printed on a SHAPE change rather than per frame. */
  private _emptyPanelLastLine = '';
  /** `?atlas-instanced` -- ONE INSTANCED DRAW PER ATLAS LEVEL, and the question it asks.
   *
   *  The atlas collapsed 160 encoder-opening binds to 4 and 160 render passes to 8 and recovered
   *  1.69 ms of the 11.06 ms that forty pyramid builds cost per render at dpr 2. The one counter
   *  it left UNCHANGED BY DESIGN is the draw count: each level is drawn as one slot draw per
   *  member, so 4 levels x 20 slots is exactly the 20 builds x 4 passes it replaced. The
   *  surviving ~85% therefore tracks DRAWS -- not passes, not encoders -- and the hypothesis is
   *  per-draw cost in Chrome's GPU process, where ANGLE translates each GL draw into Metal on the
   *  CPU side and on the critical path (the Metal trace's 616 sub-0.1 ms GPU-idle bubbles a frame
   *  are what a starved GPU looks like).
   *
   *  So: same texels, same kernels, same destination pixels, 160 draws -> 8. `=off` restores the
   *  per-slot path in the same binary. Default ON and INERT under `?pyramid-atlas=off`, which is
   *  now the unflagged engine -- there is no atlas to instance, so the flag changes nothing and
   *  says so on its mark rather than looking armed.
   *
   *  THE PREDICTION IS A HYPOTHESIS TEST WITH BOTH OUTCOMES NAMED, because three of the last four
   *  predictions from the per-encoder model missed by ~6x and no lane carries "69 us per anything"
   *  any more. Under the per-draw hypothesis the ~9.4 ms that survived the atlas is ~60 us a draw
   *  and this arm takes most of it; under the null it moves by ~0 and the pyramid lever is spent.
   *  `Scene.Ledger`'s `AtlasDraws` is the effect field either way -- the harness's `drawCalls`
   *  counts scene draws and cannot see a pyramid pass. */
  private _atlasInstanced: boolean = true;
  /** `_blurPhased || _pyramidAtlas` -- does the WALK run in phases this frame?
   *
   *  One field rather than two tests at six sites, and read by every site that used to read
   *  `_blurPhased`, because those sites are about the phased WALK (a pre-built handle is waiting;
   *  a snapshot is now taken from a different scene state; the shadow probe already ran) and not
   *  about which of the two arms asked for it. */
  private _phasedWalk: boolean = false;
  /** Set for the duration of a build phase when the atlas is on: the traversal RECORDS what it
   *  would have built instead of building it, because an atlas has to see the whole phase before
   *  it can lay out a single slot. Null on every other path, including `?blur-phased`'s. */
  private _atlasCollect: { Into: Map<Jiv, GpuTextureHandle>; Node: Jiv; Plan: GlassBlurPlan }[] | null = null;
  /** The frame's atlas census, for the gate line. `Solo` is the one to read first: a plan that
   *  atlases nothing and solos everything is the unflagged engine wearing this flag's name. */
  private _atlasStats = { Atlases: 0, Members: 0, Solo: 0, Refused: 0, Bytes: 0, Sizes: '' };
  private _atlasLastLine: string = '';
  private _atlasSizes = new Set<string>();

  // Per-frame phase timings (ms) and GPU-work counts, rolling over the last
  // N frames so the HUD reports a stable average rather than jittery samples.
  // Only populated when the debug HUD is active so release builds pay
  // nothing — `_debugHud` null-check gates all instrumentation writes.
  private _phaseDirty:   Float32Array = new Float32Array(30);
  private _phaseLayout:  Float32Array = new Float32Array(30);
  private _phaseText:    Float32Array = new Float32Array(30);
  private _phaseRender:  Float32Array = new Float32Array(30);
  private _frameIdx:     number = 0;
  private _frameCount:   number = 0;
  // `SceneReads` / `SceneRestarts` / `SceneSwitches` come from the renderer's ledger rather than from
  // the walk: the one place that knows whether the scene FBO has been DRAWN INTO since it was last
  // sampled or last unbound is `WebGL2.Renderer`, and a walk-side count would have to re-derive that
  // and could disagree with it. `SceneRestarts` is the count the read-after-write hypothesis
  // multiplied by the canvas - and `?snap-once` took it from 40 to 1 on `glass-grid` without moving
  // the frame, which refuted it. `SceneSwitches` is what survived: encoder ENDS, a non-scene target
  // bound over a dirty scene, which a pyramid build does between every pair of card draws whether or
  // not the read was rerouted. See `SceneReadLedger` in `Core/Scene.Ledger.ts`.
  // `TicksRendered` / `TicksSkipped` / `TicksForced` are the odd three out here and deliberately so:
  // every other field in this object is PER FRAME and is reset at the top of the tick, and these are
  // CUMULATIVE since boot. A per-frame tick count is 0 or 1 and says nothing. The number `?tick-pace`
  // is about is a ratio over a WINDOW -- renders per presented frame -- so the two ends of that
  // window subtract these, exactly as they already do the scene ledger. They are mirrors of
  // `_tickPace`'s own totals, kept here so the `[Jaui]` line and `jaui:render:end` read one object.
  private _counts = { Panels: 0, Glass: 0, Rims: 0, Text: 0, Image: 0, PBlur: 0, SharedBuilds: 0, CacheCap: 0, CacheComp: 0, SceneReads: 0, SceneRestarts: 0, SceneSwitches: 0, SceneEndsByKey: {} as Record<string, number>, AtlasDraws: 0, CardComposites: 0, CardFallbacks: 0, TicksRendered: 0, TicksSkipped: 0, TicksForced: 0 };
  private _cacheDiag = { reached: 0, effH: 0, teleport: 0, opacity: 0, rot: 0, xform: 0, visual: 0, persp: 0, samples: 0, ok: 0 };
  private _countsRolling = { Panels: 0, Glass: 0, Text: 0, Image: 0, PBlur: 0, SceneReads: 0, SceneRestarts: 0, SceneSwitches: 0, CardComposites: 0, CardFallbacks: 0 };
  /** `?scene-restarts=N` / `?small-restarts=N` - the renderer, already narrowed, or null when
   *  neither flag armed. The two insertion points sit inside the pyramid-build branch of the
   *  hottest walk in the engine, so an unarmed frame pays one null check per build and not an
   *  `instanceof`. Set by `_initDebugFromUrl` only after both flags have passed their gates, which
   *  is why a REFUSED flag leaves it null and the walk untouched. */
  private _restartRenderer: WebGL2Renderer | null = null;
  /** `?tick-pace` — the gate between a tick that wants to render and the render. Always present,
   *  and as of Jack's pacing ruling it is ARMED BY DEFAULT with the depth-1 fence: `_initDebugFromUrl`
   *  replaces this instance on the next line of the constructor, and `?tick-pace=off` is what puts
   *  the engine back on the unpaced loop. The `null` here is the state before that runs, which is
   *  before a tick can happen. `Decide` in `null` mode is one comparison and every tick renders,
   *  which is what keeps the RENDERED/SKIPPED columns readable on BOTH arms of a comparison.
   *  See `Core/Tick.Pace.ts`. */
  private _tickPace = new TickPace(null);
  /** The fence the gate polls, already narrowed, or null in every mode that does not poll one. */
  private _paceGate: PaceGate | null = null;
  /** Is the once-a-second `[Jaui.pace]` console line armed? THE FLAG BEING NAMED, not the gate being
   *  armed - the gate is now armed on every page, and an unconditional `console.log` plus its string
   *  build, once a second, on every Jaui page forever is not a default. `?tick-pace` bare selects the
   *  default's exact pacing and turns this on; `__jauiTickPace()` carries the same ledger with no
   *  flag at all, and that is what a reader of an unflagged page uses. */
  private _paceCensusOn = false;
  /** A render the gate refused and the engine still owes. Read by the render-on-demand gate (so the
   *  next tick wants the render again) and by the park predicate (so the loop cannot go to sleep
   *  holding it). This is the whole reason a skipped tick loses no pixels: the render is deferred,
   *  never dropped. */
  private _paceOwed = false;
  /** The stall guard says itself once, not once per forced frame. */
  private _paceForcedSaid = false;
  /** Per-op CPU time (ms) inside the glass/pblur backdrop pipeline, summed
   *  per frame. A call that forces a CPU↔GPU sync shows its GPU cost here as
   *  inflated CPU time — so the dominant op points at the bottleneck. */
  private _opMs = { Snap: 0, Blur: 0, Mip: 0, Draw: 0 };
  /** `?wkr-shared-backdrop` — build ONE sharp-root backdrop pyramid per frame
   *  (game-style: fire once, sample many) and let every glass surface sample it
   *  at its frost LOD, instead of rebuilding a per-panel blur 50× (the ~759ms).
   *  Frame-scoped; rebuilt only when the scene changed under a pending surface. */
  // Default OFF: the shared pyramid is built at QUARTER res (BuildSharedBackdrop:
  // width>>2) AND aliases u_Scene to its level 0, so EVERY glass surface — even
  // clear / light-frost (e.g. the tab bar over text) — sampled a 1/16-area
  // backdrop → visibly low-res content through the glass. NOT pixel-identical as
  // once claimed. Off restores full-res per-panel scissored blur (clear glass
  // reads the full-res scene; light blur stays crisp). Re-enable only once the
  // shared pyramid keeps a full-res level 0. `?wkr-shared-backdrop` forces on.
  //
  // Two things have changed since that was written, and both widen the gap:
  //
  // 1. The shared path pins u_BaseFrostLod to a CONSTANT 2. hasBackdropFilter's
  //    `frostLod > u_BaseFrostLod` test then inverts: a flat backdrop-filter panel under 2pt of frost at
  //    DPR 2 would lose its backdrop sample entirely (latent today — nothing
  //    authors under 4pt).
  // 2. The fill win is mostly the quarter-res cheat, not the sharing. At the
  //    harness size (2560x1600) a glass-grid card's pyramid writes ~0.39Mpx, so
  //    20 cards cost ~7.7Mpx; a FULL-RES canvas-wide shared pyramid costs
  //    ~5.5Mpx. Break-even is ~14 cards, and on a phone viewport (786x1704) it
  //    is ~26 chips — i.e. at equal fidelity, sharing over the whole canvas
  //    LOSES for realistic chrome. A per-(sigma, depth) UNION pyramid is the
  //    shape that wins; see WorkerReports/build-sharedbackdrop.md for the
  //    condition under which the union is still a texel-exact crop
  //    (k_union must equal k_member — BlurPass._baseDownsampleFactor).
  private _sharedBackdrop: boolean = false;
  /** `?lens-trace`: log, when it changes, whether an active lens's lifted twins were drawn and why not. */
  private _lensTrace = false;
  private _lensTraceLast = '';
  private _lensTraceCount = 0;
  private _sharedPyramid: GpuTextureHandle | null = null;
  private _sharedPyramidValid: boolean = false;
  /** Footprints (device px, flat [x0,y0,x1,y1,…]) drawn into the scene FBO since
   *  the shared pyramid was last built. A glass surface reuses the pyramid iff
   *  its sample rect intersects NONE of these (else it'd be missing fresh content
   *  in its backdrop). A single union AABB was too coarse — once surfaces spread
   *  across the canvas it covered everything and forced a full-canvas rebuild per
   *  surface (slower than the old scissored per-surface blur). */
  private _sceneDirtyRects: number[] = [];
  /** `?blur-cache=off|on|verify` -- A SURFACE WHOSE BACKDROP DID NOT CHANGE DOES NOT REBUILD ITS BLUR.
   *
   *  DEFAULT OFF, and it stays off until a long `verify` session reads `hits>0 mismatches=0`: the
   *  cache is exactly as correct as the audit of what can change a pixel, and verify is the only
   *  evidence the audit is complete. `on` skips the build on a clean backdrop and binds the copy it
   *  kept; `verify` builds anyway, compares the two on every hit, and binds the fresh one, so its
   *  pixels are the `off` arm's whatever it finds. All three arms are the same picture BY
   *  CONSTRUCTION -- a non-zero pixel between them is a producer the audit missed, not a look.
   *
   *  `_sceneDirtyRects` above is NOT this lane's damage, though the name invites it: it is filled
   *  only under `?wkr-shared-backdrop`, only with glass footprints, and only within one frame --
   *  "drawn since the shared build", which on a page that repaints everything every frame is never
   *  empty. A region built from it would read `hits=0` forever. See `Core/Blur.Cache.ts`. */
  //  ON BY DEFAULT since 2026-09-23. Verify sessions at phone size over home, market, library,
  //  explore, changelog and profile (scrolling and the hero autoplay): 8,000+ verified hits, and the
  //  only mismatches were a handful of texels under the tab bar and one pill, max 2/1023 in rgb10a2,
  //  the adaptive shadow's ease rounding one step differently from its declaration. That is below one
  //  8-bit display step, so no screen can show it. On the M4 at phone size the cache measured
  //  35.3 -> 25.7 ms per frame. `?blur-cache=off` is the control; `?blur-cache=verify` still audits.
  private _blurCache: 'off' | 'on' | 'verify' = 'on';
  private _blurCacheRefused = '';
  private readonly _bc = new PaintLedger<BlurCacheSlot>();
  /** True for the length of one ledgered walk; every hook is one boolean when it is false. */
  private _bcOn = false;
  /** Bumped by every image upload the cache cannot attribute to one texture, and per texture by the
   *  ones it can (a video frame re-uploaded in place under its key). */
  private _bcImageEpoch = 0;
  private readonly _bcTexEpochs = new WeakMap<object, number>();
  private _bcUploadTex: object | null = null;
  /** Bumped when the glyph atlas is flushed: a re-raster can land a different word under the SAME
   *  UVs an unchanged instance carries, which no float would show. */
  private _bcTextEpoch = 0;
  private readonly _bcStats = {
    Surfaces: 0, Hits: 0, Misses: 0, Cold: 0, Stored: 0, Grouped: 0,
    Why: { first: 0, gap: 0, key: 0, prefix: 0, full: 0, damage: 0 } as Record<Exclude<ReaderWhy, 'clean'>, number>,
  };
  /** Session tallies for the census: frames the ledger ran, frames with nothing changed, and the
   *  vacuous shape -- a frame with nothing changed, surfaces to read, and still no hit. */
  private readonly _bcSession = { Frames: 0, Resting: 0, Vacuous: 0 };
  private _bcLastLine = '';
  /** Frame counter for the one-shot per-surface dump (`?wkr-jaui-prof`). Logs
   *  each glass/pblur surface's rect + region fill once on a settled frame so
   *  we can see which surface dominates GPU fill. */
  private _surfFrame: number = 0;
  /** Deferred janvas clip-mask draws — populated during the janvas pre-pass,
   *  applied AFTER the panel pass (just before final present). Wiping the
   *  scene FBO immediately after the foreign render destroys data that
   *  in-tree consumers (pblur snapshots, glass blur pyramids) need to read.
   *  Deferring means the visual clip still applies to the presented frame
   *  while pblur/glass see the unclipped scene during their samples. */
  private _pendingJanvasMasks: Array<{
    drawX: number; drawY: number; drawW: number; drawH: number;
    clipX: number; clipY: number; clipW: number; clipH: number;
    radius: number; smoothness: number;
  }> = [];
  /** Rolling window of per-frame GPU ms from `Renderer.GetFrameGpuMs`. The
   *  reading is null when the backend doesn't support timer queries or no
   *  query has resolved yet. We skip nulls when averaging. */
  private _phaseGpu: Float32Array = new Float32Array(30);
  private _phaseGpuCount: number = 0;
  /** The per-pass profile as it stood at the last console dump, so each line reports ITS second
   *  rather than everything since the flag was parsed. Null until the first dump. */
  private _passProfileMark: PassProfile | null = null;

  /** Canvas takes a pre-initialized renderer. No backend selection happens
   *  here — callers build a renderer via `Renderer.Factory` (or their own
   *  path) and hand it in. Keeps this class free of concrete-backend
   *  imports so new backends can land without touching Canvas. */
  constructor(canvas: HTMLCanvasElement, renderer: Renderer, platform: Platform = BrowserPlatform, opts?: { Headless?: boolean }) {
    this.Element = canvas;
    this.Root = new Jiv();
    this.Root.Tracker = this;
    this._renderer = renderer;
    this._platform = platform;
    this._headless = !!opts?.Headless;

    // touch-action:none on the canvas tells the browser "don't intercept
    // drags as scroll/zoom" — without it, pointermove during a touch
    // drag never reaches our handlers (Chrome Android browser-default
    // is `auto`). Only valid on HTMLCanvasElement; OffscreenCanvas has
    // no `.style`. In worker mode the proxy element on main owns the
    // listeners and sets this itself.
    if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
      canvas.style.touchAction = 'none';
    }
    this._initDebugFromUrl();

    this._textCache = new TextCache(renderer);
    this._imageCache = new ImageCache(renderer);
    this._imageCache.OnLoad = () => {
      // `?blur-cache`: every write into an image texture ends here, so this is where its pixels
      // declare. A write the LoadBitmap hook attributed to one texture dirties only that texture's
      // panels; any other dirties every image panel, which is always correct.
      if (this._bcUploadTex !== null) this._bcTexEpochs.set(this._bcUploadTex, (this._bcTexEpochs.get(this._bcUploadTex) ?? 0) + 1);
      else this._bcImageEpoch++;
      // Walk tree and set IntrinsicWidth/Height on nodes whose Background
      // is an Image kind referencing a now-loaded cache entry. This must
      // happen BEFORE layout so the solver sees the intrinsics on the
      // next tick.
      const setIntrinsics = (node: JauiElement): void => {
        if (node instanceof Jiv && node.IntrinsicWidth === null) {
          const bg = node.RenderStyle.Background;
          if (bg.Kind === 'Image') {
            const entry = this._imageCache.Get(bg.Url);
            if (entry && entry.Ready) {
              const d = Math.max(1, this._dpr);
              node.IntrinsicWidth = entry.Width / d;
              node.IntrinsicHeight = entry.Height / d;
              node.MarkLayoutDirty();
            }
          }
        }
        for (const child of node.Children) setIntrinsics(child);
      };
      setIntrinsics(this.Root);
    };

    // Image-lifecycle → framework state plumbing.
    //
    // Three states flip on every Jiv whose Background is an Image kind
    // referencing the URL:
    //   - 'Loading' — fetch+decode has started (or is queued behind the
    //     concurrency cap; the cache only fires this when the fetch is
    //     actually in-flight, so styled placeholders stay clean for
    //     queued items).
    //   - 'Loaded'  — texture bound and Ready; Loading flips off, Loaded
    //     flips on. Author transitions like `@Transition Opacity` fire
    //     against this transition automatically.
    //   - 'Failed'  — fetch threw or HTTP non-2xx. Loading flips off.
    //
    // Same tree walk as setIntrinsics — a single pass per cache event.
    // Cheap enough for the kind of bursts a viewport scroll triggers.
    const _walkForUrl = (url: string, fn: (j: Jiv) => void): void => {
      const visit = (node: JauiElement): void => {
        if (node instanceof Jiv) {
          const bg = node.RenderStyle.Background;
          if (bg.Kind === 'Image' && bg.Url === url) fn(node);
        }
        for (const child of node.Children) visit(child);
      };
      visit(this.Root);
    };
    this._imageCache.OnLoadStart = (url) => _walkForUrl(url, (j) => {
      j.SetState('Loading', true);
      j.SetState('Loaded', false);
      j.SetState('Failed', false);
    });
    this._imageCache.OnLoadFinish = (url) => _walkForUrl(url, (j) => {
      j.SetState('Loading', false);
      j.SetState('Loaded', true);
    });
    this._imageCache.OnLoadFail = (url) => _walkForUrl(url, (j) => {
      j.SetState('Loading', false);
      j.SetState('Failed', true);
    });
    // The URL was parsed at the top of the constructor, so an unarmed canvas never wraps anything and
    // its instance funnels are the ones it shipped with.
    if (this._blurCache !== 'off') this._bcInstallHooks();

    this._animationManager.OnFrame(() => this.RequestFrame());
    // The animation half of the park's wake contract: anything that Kicks the manager -- a spring
    // retargeted, a class swap, a scroll easing, a presence mount -- restarts this loop first.
    this._animationManager.OnWake(this.Wake);
    this._scrollManager = new ScrollManager(this.Root);
    this._animationManager.Register(this._scrollManager);
    // TEMPORARY: `?autoscroll[=NN]` turns on demo auto-scroll — every scroll
    // box slowly scrolls to its end, pauses, and restarts, forever. Used to
    // record smooth-scrolling product footage. NN = CSS px/sec (default 60).
    // Auto-scroll fires no wheel/drag events, so the content extents are never
    // measured by the input handlers — measure them every frame while it runs.
    if (!this._headless) {
      const m = /[?&]autoscroll(?:=([\d.]+))?\b/.exec(this._platform.GetUrlSearch());
      if (m) {
        const speed = m[1] ? parseFloat(m[1]) : 60;
        if (speed > 0) {
          this._scrollManager.AutoScrollSpeed = speed;
          this.RegisterPostFrame(() => this._measureScrollContents(this.Root));
        }
      }
    }
    this._animationManager.Register(new PresenceManager(this.Root));
    // Kick once so the very first newly-added Jiv (Presence 0 → 1) starts
    // animating even if nothing else is active. After this, the animation
    // loop self-sustains while any spring is unsettled.
    this._animationManager.Kick();
    this._selectionManager = new SelectionManager(Jiv, (jiv) => this._textAnimators.get(jiv), this._animationManager);
    this._selectionManager.OnSelectionTextChanged((text) => this._selectionTextRelay?.(text));
    this._focusManager = new FocusManager();
    this._inputRouter = new InputRouter(
      this._platform,
      this._scrollManager,
      this._focusManager,
      this._selectionManager,
      this._animationManager,
      () => this.Root,
    );

    // Defer the first _resize() to a rAF tick so layout is already settled
    // when clientWidth runs as a fallback. Direct construction-time reads
    // forced ~56ms of synchronous layout flush on cold load (flagged by
    // Chrome's ForcedReflow analyzer). The ResizeObserver below also pushes
    // contentRect into _pendingResize, so most boots will pick up the
    // measured size from RO instead of falling through to clientWidth.
    //
    // This one keeps the painting `_resize`, not the bare apply: it is a rAF callback of its own,
    // not a tick, so nothing is guaranteed to be about to paint for it. In practice the loop has
    // usually drained the slot by the time it runs, and `_applySize` returns false without touching
    // the framebuffer -- which is the point of that early-out.
    // Headless render-to-texture instances size themselves manually (SetSizePx) and are driven manually
    // (RenderHeadless) — skip the auto-resize / ResizeObserver / DPR watch entirely so they neither read DOM
    // geometry (the canvas is an offscreen shared with a foreign renderer) nor fight the caller's sizing.
    if (!this._headless) {
      this._observeResize();
      requestAnimationFrame(() => this._resize());
      this._watchDpr();
    }
    this._listenForScroll();
    this._listenForInteractionStates();
    this._listenForTextSelection();
    this._inputRouter.Listen();
    this._listenForFontLoad();

    // ── WebGL context-loss recovery ──
    // iOS (and any platform under GPU memory pressure) kills a backgrounded tab's
    // WebGL context — the browser fires `webglcontextlost`. Without `preventDefault()`
    // it is NEVER restored, so the canvas is black until a manual reload. We pause the
    // loop on loss and, on restore, rebuild EVERY GPU resource (renderer + text atlas +
    // image textures) and re-render. The canvas is both an HTMLCanvasElement and an
    // OffscreenCanvas EventTarget, so this works in main-thread AND worker mode.
    this.Element.addEventListener('webglcontextlost', this._onContextLost as EventListener, false);
    this.Element.addEventListener('webglcontextrestored', this._onContextRestored as EventListener, false);

    // Main-thread mode: bind real DOM listeners on the canvas that
    // translate to `IngestEvent` calls. The engine's `_listenForX`
    // methods register internal handlers via `_on(...)` — without this
    // bridge, those internal handlers never fire because the DOM events
    // have nowhere to land. In worker mode (canvas is OffscreenCanvas),
    // the main-thread MainBridge owns this responsibility on the proxy
    // canvas element instead — skip the bind here.
    if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
      this._bindMainThreadDomEvents(canvas);
    }
  }

  /** Bridge real DOM events on the canvas to `IngestEvent`. Used in
   *  main-thread mode (no worker). Mirrors what `MainBridge._wireDomEvents`
   *  does on the proxy canvas in worker mode — translate clientX/Y to
   *  canvas-local CSS pixels, forward as a synth event payload, and
   *  `preventDefault()` on touchstart/wheel synchronously so the browser
   *  doesn't intercept gestures as scroll/zoom. */
  private _bindMainThreadDomEvents = (el: HTMLCanvasElement): void => {
    const dispatch = (kind: string, e: PointerEvent | WheelEvent | MouseEvent | TouchEvent | KeyboardEvent | Event): void => {
      this.IngestEvent(kind, e);
    };
    el.addEventListener('pointermove', (e) => dispatch('pointermove', e));
    el.addEventListener('pointerdown', (e) => dispatch('pointerdown', e));
    el.addEventListener('pointerup', (e) => dispatch('pointerup', e));
    el.addEventListener('pointercancel', (e) => dispatch('pointercancel', e));
    el.addEventListener('pointerleave', (e) => dispatch('pointerleave', e));
    el.addEventListener('pointerenter', (e) => dispatch('pointerenter', e));
    el.addEventListener('contextmenu', (e) => dispatch('contextmenu', e));
    // touchstart needs preventDefault on Chrome Android to suppress the
    // long-press magnifier / native text selection. `{passive:false}` so
    // the browser honors the call.
    el.addEventListener('touchstart', (e) => { e.preventDefault(); dispatch('touchstart', e); }, { passive: false });
    // wheel needs preventDefault synchronously; the engine handler can't
    // do it asynchronously. Browser zoom (Ctrl + wheel, plus Chrome's
    // synthetic pinch-zoom-as-wheel+ctrlKey) is a browser-owned gesture —
    // bail before preventDefault so the page can zoom.
    el.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      dispatch('wheel', e);
    }, { passive: false });

    // Native clipboard for display-text selection (main-thread mode). The
    // worker-mode equivalent lives in Bridge.Main — there the snapshot is
    // mirrored across postMessage because user-gesture activation doesn't
    // ride the bridge. Here we read the selection synchronously off the
    // engine. Bail when a real DOM text input is focused so plain `<input>`
    // / Jinput-style hidden textareas keep their native copy behavior.
    const onClipboardCopy = (e: ClipboardEvent): void => {
      if (typeof document !== 'undefined') {
        const ae = document.activeElement as HTMLElement | null;
        if (ae) {
          const tag = ae.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          if (ae.isContentEditable) return;
        }
      }
      const text = this._selectionManager.GetSelectedText(this.Root);
      if (!text) return;
      e.clipboardData?.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', onClipboardCopy, { capture: true });
    document.addEventListener('cut', onClipboardCopy, { capture: true });
  };

  /** The internal AnimationManager — exposed for external use (e.g. manual animators). */
  get Animations(): AnimationManager { return this._animationManager; }

  /** Post-frame hook list — invoked at the end of every render tick.
   *  Used by the worker's JivRegistry to broadcast rect snapshots once
   *  per frame to subscribed nodes. */
  private _postFrameSubs: (() => void)[] = [];
  RegisterPostFrame = (cb: () => void): (() => void) => {
    this._postFrameSubs.push(cb);
    return () => {
      const i = this._postFrameSubs.indexOf(cb);
      if (i >= 0) this._postFrameSubs.splice(i, 1);
    };
  };
  /** Internal — fired by the render loop after a frame's paint completes. */
  private _firePostFrame = (): void => {
    for (let i = 0; i < this._postFrameSubs.length; i++) {
      try { this._postFrameSubs[i](); } catch (e) { console.error('[Jaui] post-frame sub threw', e); }
    }
  };

  /** Replace the active JSS var table. The Angular layer calls this when
   *  the nearest `JssRegistry` picks up new declarations (e.g. a `<jyle>`
   *  hot-edit). Layout + intrinsic passes read the fresh table on the
   *  next tick; we mark the tree dirty here so stale resolved values get
   *  recomputed even if no other state changed.
   *
   *  Accepts a plain Record<string, string> for convenience from non-Map
   *  callers; internally stored as a Map. */
  SetJssVars = (vars: Map<string, string> | Record<string, string>): void => {
    this._jssVars = vars instanceof Map
      ? new Map(vars)
      : new Map(Object.entries(vars));
    this.Root.MarkLayoutDirty();
    this._varsChangedSinceLayout = true;
    this._animationManager.Kick();
  };

  Start = (): void => {
    if (this._running) return;
    this._running = true;
    this._parked = false;
    this._lastTime = 0;
    // Start rendering immediately — don't block on web fonts. The browser
    // does the same thing with `font-display: swap`: render with fallback
    // metrics, re-measure when the real font lands. `_listenForFontLoad`
    // fires `_invalidateAllText()` on every `FontFaceSet.loadingdone`, so
    // late-registered @font-face rules (Google Fonts batches) get picked
    // up automatically. First paint is instant; text reflows once as fonts
    // settle, animated by the existing wrap cross-fade.
    this._frameId = requestAnimationFrame(this._tick);
  };

  Stop = (): void => {
    this._running = false;
    if (this._frameId) {
      cancelAnimationFrame(this._frameId);
      this._frameId = 0;
    }
  };

  // ─── Headless render-to-texture (no swap chain) ─────────────────────────
  // For a Canvas constructed with { Headless: true }: the host owns sizing + the frame clock and samples the
  // scene FBO directly. Used by the reality worker to render the turf as a real Jaui scene into the grass
  // FieldColor texture, on the shared GL context, with no on-screen present.

  /** Set the render size directly (device px; dpr fixed at 1). The scene FBO resizes to width×height on the
   *  next RenderHeadless. Replaces the ResizeObserver path that headless mode skips. */
  SetSizePx = (width: number, height: number): void => {
    this._width = Math.max(0, Math.floor(width));
    this._height = Math.max(0, Math.floor(height));
    this._dpr = 1;
  };

  /** Render one frame synchronously into the scene FBO (no present). Drive from the host's frame loop;
   *  `timeMs` is a monotonic clock (e.g. performance.now()) used for spring/animation dt. */
  RenderHeadless = (timeMs: number): void => {
    this._tickInner(timeMs);
  };

  /** The raw scene-FBO WebGLTexture — bind into a foreign pipeline on the same GL context (THREE
   *  `ExternalTexture`). Only valid after a RenderHeadless has produced a frame. */
  get SceneGLTexture(): WebGLTexture { return (this._renderer as WebGL2Renderer).SceneGLTexture; }

  get Width(): number { return this._width; }
  get Height(): number { return this._height; }

  /** True while any spring/animation was still active as of the last frame (the value `StepFrame` last
   *  computed). A headless host driving `RenderHeadless` reads this to decide whether to keep its own
   *  composite loop alive until the engine's animations settle. */
  get IsAnimating(): boolean { return this._animationManager.IsRunning; }

  /** The words a text node paints, after MaxLines and ellipsis; empty before its first text pass. */
  RenderedWords = (node: JauiElement): string[] =>
    (this._textAnimators.get(node)?.Words ?? []).filter((w) => !w.Dying).map((w) => w.Content);

  // ─── Event ingestion (worker mode) ──────────────────────────────────────
  // The engine no longer binds DOM listeners on its canvas — `this.Element`
  // is an OffscreenCanvas and isn't an EventTarget for pointer/wheel/key
  // events anyway. Instead, the main-thread bridge captures real DOM events
  // on a sibling proxy element (the `<canvas>` Angular mounted) and forwards
  // them via postMessage. The bridge calls `IngestEvent(kind, e)` for each;
  // we dispatch to handlers registered through `_on`.
  //
  // Synth event payload contract:
  //   • clientX / clientY are CANVAS-LOCAL CSS pixels (already translated by
  //     the bridge), so `clientX - getBoundingClientRect().left` still
  //     produces the right number — the rect we serve is anchored at (0,0).
  //   • All other fields (pointerId, pointerType, button, modifiers, delta*,
  //     getCoalescedEvents) match the corresponding DOM event.
  //   • preventDefault / stopPropagation are no-ops; main has already
  //     decided whether to preventDefault on touchstart/wheel.

  /** Map of event kind → handler list. Engine internals register here via
   *  `_on()`; bridge-driven `IngestEvent` dispatches to all listeners.
   *
   *  Handler param type is `any` (not `unknown`) because the original
   *  per-element listeners were strongly typed (e.g. `(e: PointerEvent)`)
   *  and TS's contravariance rule forbids assigning those to
   *  `(e: unknown) => void`. Engine handlers know the shape they expect;
   *  the bridge guarantees the synth payload supplies those fields. */
  private _eventListeners = new Map<string, ((e: any) => void)[]>();

  /** Bridge callbacks. Set by the worker entry once Canvas is constructed. */
  private _cursorRelay: ((cursor: string) => void) | null = null;
  private _captureRelay: ((action: 'set' | 'release', pointerId: number) => void) | null = null;
  private _selectionTextRelay: ((text: string) => void) | null = null;

  /** Pointers we hold capture for. Mirrors what the proxy element on main
   *  has setPointerCapture'd, so `_hasCapture` answers synchronously. */
  private _capturedPointers = new Set<number>();

  /** Bridge installs these once. Worker entry → Canvas wires them up. */
  OnCursorChange = (cb: ((cursor: string) => void) | null): void => { this._cursorRelay = cb; };
  OnPointerCaptureRequest = (cb: ((action: 'set' | 'release', pointerId: number) => void) | null): void => {
    this._captureRelay = cb;
  };
  /** Bridge subscriber for plaintext-only selection mirrors. Main caches
   *  the latest string so the native `copy` event can synthesize
   *  `clipboardData` synchronously while the user gesture is still active —
   *  `navigator.clipboard.writeText` from inside the worker silently fails
   *  because transient activation doesn't survive postMessage. */
  OnSelectionTextChange = (cb: ((text: string) => void) | null): void => {
    this._selectionTextRelay = cb;
  };

  /** Bridge inbound: dispatch a normalized event to engine handlers.
   *  Unknown kinds are silently dropped (the bridge may forward kinds the
   *  engine doesn't currently listen for, e.g. pointerenter). */
  IngestEvent = (kind: string, e: unknown): void => {
    const list = this._eventListeners.get(kind);
    if (!list) return;
    // Iterate a snapshot so a handler that adds/removes during dispatch
    // doesn't shift indices on us.
    const snapshot = list.slice();
    for (const h of snapshot) {
      try { h(e as never); } catch (err) { console.error(`[Jaui] handler for "${kind}" threw`, err); }
    }
  };

  /** Bridge inbound: pointer-capture was actually granted on main. Track
   *  the id so subsequent `_hasCapture(id)` checks are correct. */
  IngestPointerCaptureGranted = (pointerId: number): void => { this._capturedPointers.add(pointerId); };
  IngestPointerCaptureReleased = (pointerId: number): void => { this._capturedPointers.delete(pointerId); };

  /** Bridge inbound: ResizeObserver delivered a new contentRect on main.
   *
   *  Writes the size slot and wakes the loop. That is the whole job -- the frame loop drains the
   *  slot at the top of `_tickInner` and the solve+render it was already going to run is the
   *  resize's paint.
   *
   *  This used to apply the size synchronously AND schedule a second apply on the next frame, so a
   *  drag -- which main delivers at one message per rendered frame -- bought TWO full-tree
   *  solve+renders per message on a thread that can afford about one. The port queued, the drag
   *  went quiet, and the backlog landed in bursts. The slot has always been a single last-write-wins
   *  cell and the park predicate already refuses to park while it is full; the synchronous call was
   *  bypassing the coalescing that was sitting right here.
   *
   *  A resize that arrives while the tab is HIDDEN still lands correctly, twice over: the slot holds
   *  the newest size and keeps the loop off the park gate, so the first frame after the tab comes
   *  back drains it before anything is drawn; and `Bridge.Main`'s `postLiveSize` re-posts the live
   *  rect on `visibilitychange` anyway. Neither needs work on the hidden thread. */
  ResizeFromBridge = (cssWidth: number, cssHeight: number): void => {
    this._pendingResize = { width: cssWidth, height: cssHeight };
    this.Wake();
  };

  /** Walk the tree re-materializing everything an `@If` can gate against the
   *  viewport that just changed: layout, text, and STYLE. Called from `_resize`
   *  before the solve.
   *
   *  The style mark is unconditional because a Jiv can carry a paint-only
   *  responsive rule and nothing else — `Itm_HeroBackdropFrost` in
   *  `ShowStudio.App/src/Item/Item.jss` is `@If (Width < 1000) { Opacity: 0 }`,
   *  with no layout-bearing or text-bearing predicate for the two calls above to
   *  catch. `RenderStyle` is only rewritten by a marked `JivStyleAnimator.Tick`,
   *  so before this line that hero backdrop crossed the 1000px threshold and kept
   *  its old opacity until the animator's 60-frame backstop happened to re-resolve
   *  it. */
  private _recomputeResponsiveLayout = (node: JauiElement): void => {
    (node as Jiv).RecomputeResponsiveLayout?.();
    (node as Jiv).RecomputeResponsiveText?.();
    (node as Jiv).MarkStyleDirty?.();
    const kids = node.Children;
    for (let i = 0; i < kids.length; i++) this._recomputeResponsiveLayout(kids[i]);
  };

  /** Internal — register an engine handler for `kind`. Returns disposer.
   *  `_options` is accepted (and ignored) for source-compatibility with
   *  the prior `addEventListener(kind, h, { passive: false })` calls;
   *  passive/capture flags only matter at the DOM-listener layer, which
   *  lives on main now. */
  private _on = (kind: string, handler: (e: any) => void, _options?: AddEventListenerOptions | boolean): (() => void) => {
    let list = this._eventListeners.get(kind);
    if (!list) { list = []; this._eventListeners.set(kind, list); }
    list.push(handler);
    return () => {
      const cur = this._eventListeners.get(kind);
      if (!cur) return;
      const i = cur.indexOf(handler);
      if (i >= 0) cur.splice(i, 1);
    };
  };

  /** Internal — substitute for `Element.getBoundingClientRect()`.
   *
   *  Main-thread mode (canvas is HTMLCanvasElement): defer to the real
   *  `getBoundingClientRect()` so engine handlers translating
   *  `clientX - rect.left` produce correct canvas-local coords.
   *
   *  Worker mode (canvas is OffscreenCanvas): there is no bounding
   *  rect — the bridge has already pre-translated `clientX/Y` to
   *  canvas-local CSS pixels before posting, so we return a (0, 0)-
   *  anchored rect. The same `clientX - rect.left` math then
   *  collapses to `clientX - 0 = clientX` (already canvas-local). */
  private _pageRect = (): { left: number; top: number; width: number; height: number; right: number; bottom: number; x: number; y: number } => {
    const el = this.Element as unknown as { getBoundingClientRect?: () => DOMRect };
    if (typeof el.getBoundingClientRect === 'function') {
      return el.getBoundingClientRect();
    }
    return {
      left: 0, top: 0,
      width: this._width, height: this._height,
      right: this._width, bottom: this._height,
      x: 0, y: 0,
    };
  };

  /** Internal — substitute for `Element.setPointerCapture(id)`.
   *  Main-thread mode: call the real DOM API so the browser keeps
   *  routing pointermove to us even when the finger drifts off the
   *  canvas (essential for drag/scroll). Worker mode: forward via the
   *  bridge's relay; main calls the real API on the proxy element. */
  private _capturePointer = (pointerId: number): void => {
    this._capturedPointers.add(pointerId);
    if (this._captureRelay) {
      this._captureRelay('set', pointerId);
      return;
    }
    const el = this.Element as unknown as { setPointerCapture?: (id: number) => void };
    try { el.setPointerCapture?.(pointerId); } catch { /* pointer not active */ }
  };

  private _releasePointer = (pointerId: number): void => {
    this._capturedPointers.delete(pointerId);
    if (this._captureRelay) {
      this._captureRelay('release', pointerId);
      return;
    }
    const el = this.Element as unknown as {
      hasPointerCapture?: (id: number) => boolean;
      releasePointerCapture?: (id: number) => void;
    };
    try {
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture?.(pointerId);
    } catch { /* idempotent */ }
  };

  private _hasCapture = (pointerId: number): boolean => this._capturedPointers.has(pointerId);

  /** Internal — substitute for `Element.style.cursor = X`. Worker mode
   *  relays to main; main-thread mode writes directly. */
  private _setCursor = (cursor: string): void => {
    if (this._cursorRelay) { this._cursorRelay(cursor); return; }
    const el = this.Element as unknown as { style?: CSSStyleDeclaration };
    if (el.style) el.style.cursor = cursor;
  };


  /** Viewport passed to layout passes for Length resolution — `vw`/`vh`
   *  resolve against these dims, and `%` on root-level placed children
   *  falls back here when there's no parent rect. */
  private _viewport = (): { Width: number; Height: number } => ({
    Width: this._width,
    Height: this._height,
  });
  get Dpr(): number { return this._dpr; }

  /** Re-render gate for render-on-demand. The rAF loop keeps ticking (cheap), but the
   *  expensive `_render` walk is skipped on frames where nothing changed. Starts true so
   *  the first frames always paint; `RequestFrame` / dirty / animation / janvas-wake re-arm it. */
  private _needsRender: boolean = true;
  /** Frames still owed after the last activity — renders a short tail so late-settling
   *  spring/layout values land before the loop idles. */
  private _renderHold: number = 0;
  /** Whether the last render measured an adaptive shadow, and the clock time its ease has landed by. The
   *  ease lives on the GPU, so the loop keeps rendering until then after activity stops. */
  private _adaptiveShadowsDrawn = false;
  private _shadowSettleUntil = 0;
  /** CONVERGE, THEN PARK. The ease is a weighted average of a reading and the state before it, so what
   *  it leaves behind at the end of the settle window depends on how many frames were RENDERED inside
   *  that window -- and the tick cadence is not a constant of the page: `?tick-pace` halves it by
   *  design, and Chromium's own BeginFrame back-pressure moves it between 30 and 120 Hz without being
   *  asked. Measured, that is 23-48k pixels of the card row moving by one 8-bit level between a paced
   *  arm and the unflagged one, on a scene where nothing moved (`Perf/TickPace3.Finding.md`).
   *
   *  So the loop does not park on a clock alone. When the window has elapsed it renders ONE more frame
   *  with the ease OFF -- every probe writes its whole reading -- and parks on that frame. The parked
   *  picture is then the converged reading and nothing else, identical across cadences, across pacing
   *  modes, and across however many frames the settle took. `?shadow-snap=off` restores the old park.
   *
   *  Pending from the moment a settle window opens until a snap render clears it; the park predicate
   *  reads it, so the loop cannot sleep owing one. Only ever set when the snap is armed. */
  private _shadowSnapPending = false;
  private _shadowSnapArmed = true;
  /** Surfaces the last snap render wrote whole. Read on `[Jaui]` and by `__jauiShadowSnap`. */
  private _shadowSnapped = 0;

  /** True while the rAF loop is stopped because every source of change has said it is still.
   *  See the park block at the end of `_tickInner` for the whole argument. */
  private _parked = false;

  /**
   * Restart the frame loop. Schedules a TICK, not a render.
   *
   * That distinction is the point: the tick re-evaluates the render-on-demand gate and parks again
   * immediately if nothing actually changed, so waking speculatively -- which the worker bridge
   * does on every inbound message -- costs one gate evaluation and never a frame. A speculative
   * `RequestFrame` would have cost a full render walk instead.
   *
   * Idempotent and free when the loop is already running, which is the overwhelmingly common
   * case -- `Notify` calls this once per dirty node, so the first line has to be the cheap one.
   *
   * WHY THIS EXISTS AT ALL, in one sentence: parking means there is no longer a tick already on
   * its way to notice what just changed, so whatever changed has to say so. The four funnels that
   * do the saying are named in the park block at the end of `_tickInner`.
   */
  Wake = (): void => {
    if (!this._parked) return;
    this._parked = false;
    if (!this._running || this._contextLost) return;
    if (this._frameId === 0) this._frameId = requestAnimationFrame(this._tick);
  };

  /** Request a re-render on the next loop tick (render-on-demand wake). Cheap + idempotent;
   *  called by async producers (image decode, janvas/foreign-renderer change, scroll). */
  RequestFrame = (): void => {
    this._needsRender = true;
    if (JauiTracing()) {
      // The caller, one frame up: what asked for a render. Only under ?trace.
      const line = (new Error().stack ?? '').split('\n')[2]?.trim().replace(/^at /, '').replace(/\s*\(.*$/, '') ?? '?';
      this._awake.Need.set(line, (this._awake.Need.get(line) ?? 0) + 1);
    }
    this.Wake();
  };

  /** `?trace` only: WHY this loop drew, accumulated for a second and printed as `jaui:awake`.
   *  A still page should print nothing at all; a page that never parks prints the animation, the
   *  dirty node or the RequestFrame caller keeping it awake, by name. */
  private _awake = {
    Since: 0, Renders: 0, Layout: 0, Anim: new Map<string, number>(),
    Dirty: new Map<string, number>(), Need: new Map<string, number>(), Miss: new Map<string, number>(),
    Occ: new Map<string, number>(),
  };

  /** Set the diagnostics for ONE `?ablate` arm and clear the rest. Every field it touches is read per
   *  frame, which is what lets the arm change between two renders of one session. */
  private _ablateApply = (arm: string): void => {
    this._diagNoBlur = arm === 'no-blur';
    this._diagNoPblur = arm === 'no-pblur';
    this._diagNoPblurDraw = arm === 'no-pblur-draw';
    this._ablatePblur = arm === 'no-pblur-deep' ? 'deep' : arm === 'no-pblur-shallow' ? 'shallow' : null;
    this._diagNoPanels = arm === 'no-panels';
    this._diagNoGlassDraw = arm === 'no-glass-draw';
    this._diagNoShadow = arm === 'no-shadow';
    JivInstanceBuffer.DiagNoShadow = arm === 'no-shadow';
    this._occlusion = arm !== 'no-occlusion';
    this._diagNoUi = arm === 'no-ui';
    RegionExtentSnap.Unit = ABLATE_SNAP[arm] ?? this._ablateSnapBase;
    BlurPass.MipMrt = arm === 'mip-mrt' ? true : this._ablateMipMrtBase;
  };
  /** The `?mip-mrt` state the URL asked for, which every arm but `mip-mrt` runs at. */
  private _ablateMipMrtBase = false;
  /** `?ablate`'s depth-selective progressive-blur arms; null draws every one. */
  private _ablatePblur: 'deep' | 'shallow' | null = null;
  /** Does this ProgressiveBlur node take the progressive-blur path this frame? `?no-pblur` says no to
   *  all of them; the ablate depth arms say no to one class, with the SAME depth the walk computes
   *  (`maxLod = max(1, log2(frost))`, the dpr cancels). A refused node paints exactly as `?no-pblur`
   *  paints it, so each arm is `?no-pblur` restricted to its surfaces. */
  private _pblurOn = (node: Jiv): boolean => {
    if (this._diagNoPblur) return false;
    if (this._ablatePblur === null) return true;
    const lod = Math.max(1, Math.log2(Math.max(1, node.RenderStyle.BackdropFrostBlur)));
    return this._ablatePblur === 'deep' ? lod < ABLATE_PBLUR_DEEP_LOD : lod > ABLATE_PBLUR_SHALLOW_LOD;
  };
  /** The extent unit the URL asked for, which every arm but a `snapN` one runs at. */
  private _ablateSnapBase = 1;

  /** Book this render's interval to the arm that drew it, and move on every `ABLATE_FRAMES`. The
   *  first interval after a switch is dropped (its start belongs to the other arm), and so is any
   *  gap long enough to be idle rather than frame time. A full cycle prints every arm's median. */
  private _ablateTick = (now: number): void => {
    const a = this._ablate!;
    const arm = a.Arms[a.I];
    const dt = now - a.Last;
    a.Last = now;
    if (!a.Skip && dt > 0 && dt < ABLATE_IDLE_MS) {
      let list = a.Samples.get(arm);
      if (list === undefined) { list = []; a.Samples.set(arm, list); }
      list.push(dt);
    }
    a.Skip = false;
    if (++a.Count < ABLATE_FRAMES) return;
    a.Count = 0;
    a.Skip = true;
    a.I = (a.I + 1) % a.Arms.length;
    this._ablateApply(a.Arms[a.I]);
    if (a.I !== 0) return;
    a.Cycle++;
    const q = (xs: number[], f: number): number => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))];
    const base = a.Samples.get('control');
    const baseMed = base !== undefined && base.length > 0 ? q([...base].sort((x, y) => x - y), 0.5) : NaN;
    for (const name of new Set(a.Arms)) {
      const xs = [...(a.Samples.get(name) ?? [])].sort((x, y) => x - y);
      if (xs.length === 0) { JTrace(`jaui:ablate cycle=${a.Cycle} arm=${name} n=0`); continue; }
      const med = q(xs, 0.5);
      JTrace(`jaui:ablate cycle=${a.Cycle} arm=${name} n=${xs.length} med=${med.toFixed(1)}`
        + ` p25=${q(xs, 0.25).toFixed(1)} p75=${q(xs, 0.75).toFixed(1)}`
        + (name === 'control' || !(baseMed > 0) ? '' : ` vsControl=${(med - baseMed).toFixed(1)}`));
    }
  };

  private _flushAwake = (now: number, rendered: boolean, layoutDirty: boolean): void => {
    const a = this._awake;
    if (a.Since === 0) a.Since = now;
    if (rendered) a.Renders++;
    if (layoutDirty) a.Layout++;
    if (now - a.Since < 1000) return;
    if (a.Renders > 0) {
      const top = (m: Map<string, number>): string => m.size === 0 ? 'none'
        : [...m].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, n]) => `${k}:${n}`).join(',');
      JTrace(`jaui:awake renders=${a.Renders} layout=${a.Layout} anim=${top(a.Anim)}`
        + ` dirty=${top(a.Dirty)} need=${top(a.Need)} blurMiss=${top(a.Miss)} occ=${top(a.Occ)}`);
    }
    a.Since = now; a.Renders = 0; a.Layout = 0; a.Anim.clear(); a.Dirty.clear(); a.Need.clear(); a.Miss.clear(); a.Occ.clear();
  };

  private _pendingCapture: ((b: Blob | null) => void) | null = null;
  /** Force a render and capture the resulting frame as a PNG blob (debug/screenshot). */
  CaptureFrame = (): Promise<Blob | null> => {
    return new Promise(resolve => {
      this._pendingCapture = resolve;
      this.RequestFrame();
    });
  };

  // ── Retained-mode layer cache (Phase 3) ──
  // A stable, static subtree that doesn't sample the live scene renders ONCE
  // into its own FBO, then composites each frame over the everplaying field —
  // so the heavy static UI (the measured ~8.5s/frame bulk on a GPU-less host)
  // is reused instead of re-shaded, while the field + glass stay live.
  /** DISABLED: the capture/composite mis-renders when it actually fires (faint/
   *  missing panels under force-on — an alpha or capture-bounds bug; the FBO is
   *  sized to the box, clipping shadow/overflow, and the premultiplied composite
   *  needs verifying). Pinpoint stands (PERF.jaui-frame-cost.md); fix before
   *  re-enabling. Gated so it can't break a real static-UI (playback) frame. */
  private _layerCacheEnabled = false;
  /** TEMP `?cache-force`: ignore the global _uiStatic gate so static subtrees
   *  cache even while an unrelated animation (e.g. the reality pulse) runs.
   *  Measurement-only — cached subtrees that DO change go stale; used to size
   *  the win that proper per-subtree invalidation would unlock. */
  private _cacheForce = false;
  private _damageTest = false; // [damage] Phase A: gated ?damage-test — cull nodes outside a hardcoded dirty rect to prove the mechanism
  private _damageRectCss: { x: number; y: number; w: number; h: number } | null = null;
  /** An active lens's lifted content, the bar's items drawn again (liftLensItems in the walk). */
  private _lensItems: Framebuffer | null = null;
  private _layerCache = new Map<Jiv, { Fbo: Framebuffer; Valid: boolean; DX: number; DY: number; DW: number; DH: number }>();
  /** Per-render memo of "subtree samples the live scene → uncacheable". Cleared
   *  at the top of every _render; real structural/material changes happen under
   *  !_uiStatic (which drops the whole cache), so it can't go stale mid-static. */
  private _subtreeDynamicMemo = new Map<Jiv, boolean>();
  /** Per-render memo of `_glassRimInPass`: the fill and the edge slot must give the same answer. */
  private _rimPassMemo = new Map<Jiv, boolean>();
  /** True when no UI animation/relayout is pending, so the static caches are
   *  safe to build + reuse. The everplaying field keeps the loop alive via
   *  _needsRender (NOT IsRunning), so this stays true in steady state. */
  private _uiStatic = false;
  /** Guards the cache hook from re-entering while capturing a subtree. */
  private _capturing = false;

  /** True if `node`'s subtree contains anything that must re-render every frame
   *  because it samples the live (everplaying) scene: the 3D field (Janvas), a
   *  glass or progressive-blur surface, a backdrop filter, or a rim lifted over
   *  a background that does not hide the scene behind it. Memoized. */
  private _subtreeSamplesLiveScene = (node: Jiv): boolean => {
    const memo = this._subtreeDynamicMemo.get(node);
    if (memo !== undefined) return memo;
    const s = node.RenderStyle;
    // VIBRANCY reads the destination through the blend unit, and a capture's destination is a CLEARED
    // layer, not the scene. `node.EffectiveVibrancy`, not the node's own style, because an INHERITED
    // value is not in `RenderStyle`; the cascade runs at frame start, before this is asked.
    let dyn = node instanceof Janvas
      || _isGlass(s.Material) || s.Material === 'ProgressiveBlur'
      || _hasBackdropFilter(node)
      || VibrancyIsActive(s.BackdropVibrancy, s.BackdropVibrancyCover) || VibrancyTouchesInk(s, node.EffectiveVibrancy)
      || (s.RimStrength > 0 && s.RimWidth > 0 && s.Background.Color.A < 0.999);
    if (!dyn) {
      const kids = node.Children as Jiv[];
      for (let i = 0; i < kids.length; i++) {
        if (this._subtreeSamplesLiveScene(kids[i])) { dyn = true; break; }
      }
    }
    this._subtreeDynamicMemo.set(node, dyn);
    return dyn;
  };

  /** Layer-cache eligibility for a subtree root: bounded, opaque, no OWN
   *  transform (so capturing at the FBO origin is an exact translate of the
   *  inherited matrix), axis-aligned, not teleporting, and nothing inside
   *  samples the live scene. The hook also requires _uiStatic, an empty clip
   *  stack, and null 3D homography/perspective. Conservative by design: a node
   *  that fails any check renders normally — never wrong, only un-cached. */
  private _isLayerCacheRoot = (node: Jiv, eff: Mat2x3): boolean => {
    if (node === this.Root) return false;
    if (!node.Visible || node.Width <= 0 || node.Height <= 0) return false;
    if (node.TeleportSeq !== 0) return false;
    if (node.EffectiveOpacity < 0.999) return false;
    if (Math.abs(eff[1]) > 1e-6 || Math.abs(eff[2]) > 1e-6) return false; // rotation/skew
    const t = node.RenderStyle.Transform;
    if (t.Rotation !== 0 || t.RotateX !== 0 || t.RotateY !== 0 || t.TranslateZ !== 0) return false;
    const rs = node.RenderStyle;
    if (rs.VisualScaleX !== 1 || rs.VisualScaleY !== 1 || rs.VisualTranslateX !== 0 || rs.VisualTranslateY !== 0) return false;
    if (rs.Perspective > 0) return false;
    return !this._subtreeSamplesLiveScene(node);
  };

  // ── WebGL context-loss / restore ──
  private _contextLost = false;
  /** True while the GL context is lost (paused). Consumers can read it. */
  get ContextLost(): boolean { return this._contextLost; }
  /** Optional relays so the worker bridge can forward context-loss/restore to the
   *  main thread (for an eviction watchdog: if the worker is killed entirely, only a
   *  reload recovers — these never fire in that case, which is the watchdog's cue). */
  ContextLostRelay: (() => void) | null = null;
  ContextRestoredRelay: (() => void) | null = null;

  private _onContextLost = (e: Event): void => {
    // REQUIRED: tells the browser we will restore — without it the context is gone for
    // good and the canvas stays black. Pause the loop; _tick bails on _contextLost.
    e.preventDefault();
    this._contextLost = true;
    this._running = false;
    if (this._frameId) { cancelAnimationFrame(this._frameId); this._frameId = 0; }
    this.ContextLostRelay?.();
  };

  private _onContextRestored = (): void => {
    // Every GPU resource died with the old context. Re-create the renderer's own
    // (Init re-runs context + shaders + FBOs + clip/xform textures), then drop the
    // external caches so the next FULL render re-creates them against the restored
    // context: the text atlas (Dispose → re-allocated + re-rasterized) and image
    // textures (Clear → re-uploaded). The render walk re-emits the whole tree each
    // frame, so one frame repopulates everything.
    // Init is on the Renderer interface — WebGL2 re-acquires the context and rebuilds its
    // shaders / FBOs / clip+xform textures (WebGPU re-acquires its device the same way).
    void Promise.resolve(this._renderer.Init(this.Element)).then(() => {
      this._textCache.Dispose();
      this._imageCache.Clear();
      // The layer-cache FBOs died with the context; drop them so the next
      // static frame recaptures into fresh FBOs.
      this._layerCache.clear();
      // `?blur-cache`: the slots died with it too, and every record describes a scene that is gone.
      this._bcTextEpoch++;
      this._bc.Reset();
      if (this._renderer instanceof WebGL2Renderer) this._renderer.BlurCacheClear();
      // Foreign 3D <janvas> renderers (e.g. the home hero field) lost their GPU
      // resources too — flag every one for re-Init so the next render re-runs
      // `Renderer.Init(gl, …)` against the restored context.
      this._resetJanvasesForRestore(this.Root);
      this._contextLost = false;
      this.ContextRestoredRelay?.();
      if (!this._running) {
        this._running = true;
        this._parked = false;
        this._frameId = requestAnimationFrame(this._tick);
      }
    }).catch((err: unknown) => {
      // Re-init failed (e.g. the context didn't truly come back) — leave it paused;
      // the main-thread watchdog reloads as the last resort.
      console.error('[Jaui] WebGL context restore failed:', err);
    });
  };

  /** Walk the tree and flag every Janvas for re-Init (post context-restore). */
  private _resetJanvasesForRestore = (node: JauiElement): void => {
    if (node instanceof Janvas) node.MarkUninited();
    for (const child of node.Children) this._resetJanvasesForRestore(child);
  };

  private _tickErrorCount = 0;
  private _tick = (time: number): void => {
    this._frameId = 0;
    if (!this._running || this._contextLost) return;
    // `park` can only become true by _tickInner RETURNING it. A throw leaves it false and the loop
    // re-arms below, which is the same robustness the old unconditional re-arm bought: one bad
    // frame must not take the engine down, and it must not be able to park it either.
    let park = false;
    try {
      park = this._tickInner(time);
    } catch (err) {
      // One bad frame shouldn't take down the engine. Log the first few
      // occurrences (so we see the bug) and then go quiet to keep the
      // console / postMessage channel from melting under millions of
      // identical errors per second.
      if (this._tickErrorCount < 3) {
        console.error('[Jaui] tick threw', err);
      } else if (this._tickErrorCount === 3) {
        console.error('[Jaui] tick still throwing — suppressing further duplicates');
      }
      this._tickErrorCount++;
      park = false;
    }
    // `?tick-pace`'s instrument is the interval from a RENDERED tick to the NEXT callback, and a
    // park breaks it: the callback that eventually arrives is a WAKE, not a cadence. Declared here
    // rather than inferred, because nothing inside `Tick.Pace` can tell a 300 ms idle from a 300 ms
    // frame. It also abandons an observation window — the page stopped doing the work the window
    // was there to measure, so there is no verdict to be had.
    if (park) { this._tickPace.NotePark(); this._parked = true; return; }
    this._frameId = requestAnimationFrame(this._tick);
  };

  /** rAF timestamp of the last `[Jaui.pace]` line, and the totals it printed. */
  private _paceCensusAt = 0;
  private _paceCensusMark = {
    Rendered: 0, Skipped: 0, Forced: 0, Waited: [0, 0, 0, 0] as PaceWaited, FenceN: 0, FenceSum: 0,
  };

  /** One line a second while `?tick-pace` is armed: the cumulative ledger and the last second's
   *  delta. The delta is what a reader wants (the window's ratio) and the cumulative is what makes
   *  two lines subtractable across a window that does not start on a second boundary.
   *
   *  `waited` is the histogram this lane added — ticks a render waited, bucketed 0/1/2/3+ — and it
   *  is how a report says whether the gate is pacing on the GPU or waiting on something else.
   *  `fenceMs` beside it is the fence's own signal latency, mean over the window and max over the
   *  run, which is what separates "the GPU was busy" from "the fence told us late". */
  private _paceCensus = (time: number): void => {
    if (this._paceCensusAt === 0) { this._paceCensusAt = time; return; }
    const span = time - this._paceCensusAt;
    if (span < 1000) return;
    const c = this._tickPace.Census();
    const m = this._paceCensusMark;
    const dWaited = c.WaitedTicks.map((v, i) => v - m.Waited[i]).join('/');
    const dFenceN = c.FenceMs.N - m.FenceN;
    const dFenceMs = dFenceN > 0 ? Math.round(((c.FenceMs.Sum - m.FenceSum) / dFenceN) * 10) / 10 : 0;
    const allFenceMs = c.FenceMs.N > 0 ? Math.round((c.FenceMs.Sum / c.FenceMs.N) * 10) / 10 : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[Jaui.pace] ${c.Mode} rendered=${c.Rendered} skipped=${c.Skipped} forced=${c.Forced}`
      + ` waited=${c.WaitedTicks.join('/')} fenceMs=${allFenceMs}avg/${c.FenceMs.Max}max`
      + ` inflight<=${c.MaxInFlight}`
      // The lock's own block, printed in every mode so one parser reads every arm: `lockN` is the
      // cadence in vsyncs, `changes` says whether it is still settling, `period`/`vsync` are the two
      // estimates it was chosen from (and `derived` says whether that vsync was measured or is
      // still the 60 Hz fallback), and the two skip columns say WHICH gate refused. Under a lock
      // that fits, `fskip` is ~0 and `lskip` is however many ticks the callback cadence brings early.
      + ` lockN=${c.LockN}/${c.LockCommittedN} changes=${c.LockChanges}`
      + ` period=${c.PeriodMs}(${c.PeriodSource},${c.PeriodObservedAt}ms ago)`
      + ` windows=${c.Windows} vsync=${c.VsyncMs}`
      + ` derived=${c.VsyncDerived} lskip=${c.LockSkipped} fskip=${c.FenceSkipped}`
      // THE INSTRUMENT, and the two numbers to read first. `ungated` is the last observation
      // window's mean callback interval with the gate fully open - the render period, and the only
      // quantity in this file that has ever equalled the harness's `ticks/s`. `rgap` is the same
      // interval measured per RENDERED tick under whatever gate is in force; on the `observe` arm
      // the two must agree (that is the self-check), and under the lock whether `rgap` tracks the
      // period or falls back to the display cadence is what decides `?tick-pace=lock:live`.
      // `busy`/`cpu` are the last window's two occupancy shares - the discriminator that stands in
      // for `ticks/frame`, which a worker cannot compute because it has no presentation signal.
      + ` | ungated=${c.UngatedGapMs} rgap=${c.RenderedGapMs}`
      + ` busy=${c.WindowBusyShare} cpu=${c.WindowCpuShare} rising=${c.WindowRising}`
      // The two fence diagnostics, and NOTHING decides on them - they are in the ledger only to
      // keep the 1.6x over-read priced. Both are coupled to the PRESENT: `solo` read the same ~31
      // ms at two resolutions that differ by 44% of the pixel work, which is an argument that it is
      // a latency floor and not an execution time, and `satgap` is a queued completion gap ~ the
      // frame time. `render` is the CPU's own issuing half, and it is also the classifier's CPU
      // channel - the only evidence a CPU-bound loop leaves.
      + ` | solo=${c.SoloMs} satgap=${c.SatGapMs} render=${c.RenderMs}`
      + ` | last ${Math.round(span)}ms +${c.Rendered - m.Rendered} rendered`
      + ` +${c.Skipped - m.Skipped} skipped +${c.Forced - m.Forced} forced`
      + ` waited +${dWaited} fenceMs ${dFenceMs}avg`,
    );
    m.Rendered = c.Rendered; m.Skipped = c.Skipped; m.Forced = c.Forced;
    m.Waited = c.WaitedTicks; m.FenceN = c.FenceMs.N; m.FenceSum = c.FenceMs.Sum;
    this._paceCensusAt = time;
  };

  private _tickInner = (time: number): boolean => {
    // ── Drain the pushed-size slot ──────────────────────────────────────────
    // `ResizeFromBridge` writes the slot and wakes; THIS is where a resize is applied while the
    // loop runs. One apply per frame at the newest size, however many messages arrived since the
    // last frame -- a drag that outruns the thread now drops the sizes nobody would ever have seen
    // instead of queueing them. No paint here on purpose: the solve+render below IS this resize's
    // paint, and the clear it bridges happens in the same turn as the frame that repairs it.
    //
    // Order matters. This has to run BEFORE the zero-size gate: at boot the slot is the only thing
    // that gives the canvas a size, so draining after the gate would let the first frame that
    // finally had a size in hand bail out on the size it was carrying.
    if (this._pendingResize !== null) { this._applySize(); this._tickPace.NoteSceneChange(); }

    // Boot-time zero-size gate. Until the worker bridge has delivered a
    // real resize (ResizeFromBridge → _pendingResize → the drain above sets
    // _width/_height), the OffscreenCanvas backing store is 0×0 and any
    // GL op that touches the default framebuffer fails with
    // GL_INVALID_FRAMEBUFFER_OPERATION (error 1286). That used to spam
    // the console for ~30ms during boot, with both glClear/glBlit AND
    // texSubImage2D (whose upload path implicitly checks the current
    // framebuffer's completeness). Skip the entire frame at zero size —
    // the next rAF after the first resize delivery picks up cleanly.
    if (this._width === 0 || this._height === 0) {
      if (!this._ffPresented) this._ffZeroSizeTicks++;
      return false;
    }

    // ── First-frame ledger ──────────────────────────────────────────────────
    // Nobody could see inside the boot gap: the app's tracer went straight from
    // `jaui:worker-ready` to `jaui:first-frame` with two seconds of nothing between them, so the
    // term that owned those two seconds was a guess. `ff` is true for exactly the ticks up to and
    // including the first present, and it turns on the phase timers the HUD already owns — so the
    // marks below cost a released build nothing and report the same numbers `?wkr-jaui-prof` does.
    const ff = !this._ffPresented;
    if (ff && !this._ffTicked) {
      this._ffTicked = true;
      JTrace(`jaui:tick:first zero-size-ticks=${this._ffZeroSizeTicks}`);
    }

    // Feed the HUD BEFORE we overwrite _lastTime — the HUD uses it to derive
    // the rAF-to-rAF delta (which, on iOS, includes time the main thread spent
    // blocked — a better signal than render-only dt for "is the browser
    // actually waking us at 60Hz?").
    this._updateHud(time);

    const dt = this._lastTime === 0 ? 0.016 : Math.min((time - this._lastTime) / 1000, 0.033);
    this._lastTime = time;

    // `?tick-pace=lock` derives the display's vsync from the CALLBACK cadence, so it has to see
    // every tick and not only the ones that want to render — a gate fed only on wants would be
    // sampling its own output. One subtraction and a ring write, and it returns immediately when
    // the flag is not armed.
    this._tickPace.NoteTick(time);

    // Advance all springs SYNCHRONOUSLY, in THIS frame, before the render walk
    // below reads their values. JivStyleAnimator springs (Transform.Rotation,
    // Opacity, Visual*, …) used to advance in the AnimationManager's OWN rAF
    // callback — a separate frame from this render — so the render read a
    // one-frame-stale value (the rotating-panel blur lagging its edge). Stepping
    // here couples spring-write → render-read in one frame. The manager's loop
    // is now schedule-only; this does NOT change any rAF kick or the boot path.
    const awake = JauiTracing() ? this._awake : null;
    if (awake !== null) this._animationManager.ActiveNames = [];
    this._animationManager.StepFrame(dt);
    if (awake !== null) {
      for (const n of this._animationManager.ActiveNames ?? []) awake.Anim.set(n, (awake.Anim.get(n) ?? 0) + 1);
      this._animationManager.ActiveNames = null;
    }

    // Phase timing — active when the debug HUD is on OR `?wkr-jaui-prof` was
    // set. Gate reads at each boundary rather than branching inside hot loops;
    // performance.now() is cheap but we skip it entirely in release.
    const hud = this._debugHud !== null || this._consoleProfilingEnabled || ff;
    let t0 = 0, tDirtyEnd = 0, tLayoutEnd = 0, tTextEnd = 0;
    if (hud) t0 = performance.now();

    // Single O(1) root-flag check. `MarkLayoutDirty` bubbles the Layout
    // flag from any descendant to the root, so root.Dirty & Layout answers
    // "any node in the tree dirty?" without walking. Text-only mutations
    // also call MarkLayoutDirty (text changes always invalidate intrinsic
    // sizing), so a separate Text walk is no longer needed.
    const layoutDirty = (this.Root.Dirty & (DirtyFlag.Layout | DirtyFlag.Text)) !== 0;
    if (hud) tDirtyEnd = performance.now();
    if (layoutDirty) {
      // Choose the smallest containing subtree we can re-solve in isolation.
      // Returns Root for multi-dirty / unbounded-ancestor cases, equivalent
      // to today's behavior. Returns a deeper element when the dirty change
      // is contained inside a fixed-box ancestor — saves an O(N) full-tree
      // pass on common cases (drawer resize, single-card hover, scrubber).
      const scopedRoot = this._chooseScopedRoot();
      // Cascade PointScale first so _measureDirtyText can resolve FontSize
      // against each Jiv's ResolveCtx before layout sizes are known. The
      // tree is all-Jivs (Root is a Jiv, AddChild only mounts Jivs), so the
      // Element-typed path back from Parent walks safely casts to Jiv at
      // these consumers.
      if (ff) JTrace(`jaui:layout:start nodes=${_countNodes(scopedRoot)}`);
      const tCascade = ff ? performance.now() : 0;
      CascadePointScale(scopedRoot, this._viewport(), this._jssVars);
      const tScale = ff ? performance.now() : 0;
      this._measureDirtyText(scopedRoot as Jiv);
      const tMeasure = ff ? performance.now() : 0;
      ComputeIntrinsicSizes(scopedRoot, this._viewport(), this._jssVars);
      const tIntrinsic = ff ? performance.now() : 0;
      this._solveAndAnimate(scopedRoot);
      if (ff) {
        const tSolve = performance.now();
        JTrace(`jaui:layout:end scale=${JMs(tScale - tCascade)} measure=${JMs(tMeasure - tScale)}`
          + ` intrinsic=${JMs(tIntrinsic - tMeasure)} solve=${JMs(tSolve - tIntrinsic)} ms`);
      }
      this._clearDirty(scopedRoot as Jiv);
      // The Layout flag was bubbled to the root by MarkLayoutDirty so the
      // O(1) gate above could see it. After a scoped solve, the bubble path
      // (subtree-root.Parent → ... → Root) still holds Layout flags it
      // didn't deserve — clear them so next frame's gate is honest. Walks
      // O(depth), bounded shallow.
      if (scopedRoot !== this.Root) {
        let p = scopedRoot.Parent;
        while (p) { p.Dirty &= ~DirtyFlag.Layout; p = p.Parent; }
      }
      this._dirtyNodes.clear();
    }
    if (this._varsChangedSinceLayout && layoutDirty) {
      this._varsChangedSinceLayout = false;
      for (const styleAnimator of this._styleAnimators.values()) styleAnimator.Wake();
      this._animationManager.Kick();
    }
    if (hud) tLayoutEnd = performance.now();

    // Wrap-change detection only runs when something could have moved a wrap
    // threshold this frame: a fresh layout solve (widths just updated) or any
    // active animator (spring-animated width can cross wrap thresholds
    // continuously). On steady-idle frames neither holds, so the full-tree
    // walk is skipped entirely. AnimationManager.IsRunning covers springs,
    // ScrollManager easings, and PresenceManager — all registered with it.
    if (layoutDirty || this._animationManager.IsRunning) {
      this._processTextTransitions(this.Root);
    }
    if (hud) tTextEnd = performance.now();

    // Reset per-frame counters; _render increments them as it walks.
    // `_frameTrace` joins `hud` here because without the reset these counters are CUMULATIVE, and a
    // per-frame line reading `panels=4983` is not wrong-looking enough to be caught — it reads like
    // a busy frame. Measured before the fix: 593 "frames" every one of which claimed to be over
    // budget, with counts climbing monotonically.
    if (hud || this._frameTrace) {
      this._counts.Panels = 0;
      this._counts.Glass = 0;
      this._counts.Rims = 0;
      this._counts.Text = 0;
      this._counts.Image = 0;
      this._counts.PBlur = 0;
      this._counts.SharedBuilds = 0;
      this._counts.CacheCap = 0;
      this._counts.CacheComp = 0;
      this._counts.SceneReads = 0;
      this._counts.SceneRestarts = 0;
      this._counts.SceneSwitches = 0;
      this._counts.SceneEndsByKey = {};
      this._counts.AtlasDraws = 0;
      this._counts.CardComposites = 0;
      this._counts.CardFallbacks = 0;
      { const d = this._cacheDiag; d.reached = d.effH = d.teleport = d.opacity = d.rot = d.xform = d.visual = d.persp = d.samples = d.ok = 0; }
      this._opMs.Snap = this._opMs.Blur = this._opMs.Mip = this._opMs.Draw = 0;
    }

    // ── Render-on-demand gate ──────────────────────────────────────────────
    // The expensive _render tree-walk (glass/blur fill + janvas field) runs ONLY when
    // something changed this frame; an idle screen costs ~nothing instead of a full
    // re-render. Signals: layout/text dirty, any running animation (springs/scroll/
    // presence via AnimationManager.IsRunning), or an explicit RequestFrame (async image
    // decode, janvas/foreign-renderer change). A short render-tail (_renderHold) lets
    // late-settling spring/layout values paint before the loop idles. The rAF loop keeps
    // ticking (springs StepFrame above run every frame) so the next change repaints with
    // zero latency. This is what lets Jaui match the DOM on unaccelerated GPUs: a static
    // page does not repaint, so software-GL cost collapses from full-frame to ~nothing.
    //
    // Layer-cache gate: caches are valid to build/reuse only when no UI animation or
    // relayout is pending (the field still plays via _needsRender). When something
    // animates, drop every cache — they recapture once it settles (v1 whole-cache
    // invalidation; per-subtree dirty-bubbling is a refinement).
    const uiStatic = !layoutDirty && !this._animationManager.IsRunning;
    if (!uiStatic && !this._cacheForce) { for (const e of this._layerCache.values()) e.Valid = false; }
    this._uiStatic = uiStatic;

    const renderActive = layoutDirty || this._animationManager.IsRunning || this._needsRender;
    this._needsRender = false;
    if (JauiTracing()) this._flushAwake(performance.now(), renderActive, layoutDirty);
    if (renderActive) {
      if (this._ablate !== null) this._ablateTick(performance.now());
      this._renderHold = 3; // render this frame + a 2-frame settle tail
      if (this._adaptiveShadowsDrawn) {
        // Five taus armed, three unarmed: the number does NOT decide the parked pixels (the snap
        // writes the converged reading whatever the state held) -- it decides how big the step AT
        // the snap is. See `SHADOW_SETTLE_TAUS`.
        const taus = this._shadowSnapArmed ? SHADOW_SETTLE_TAUS : SHADOW_SETTLE_TAUS_UNSNAPPED;
        this._shadowSettleUntil = time + SHADOW_EASE_SECONDS * taus * 1000;
        if (this._shadowSnapArmed) this._shadowSnapPending = true;
      }
    }
    // ── The pace gate ──────────────────────────────────────────────────────
    // `wantsRender` is the gate above, unchanged, plus a render the pace refused on an earlier tick
    // and therefore still owes. `?tick-pace` then decides whether THIS tick is the one that runs it.
    //
    // Everything above this line has already happened on a skipped tick: the resize drained, the
    // springs stepped, layout solved, text transitioned, the caches were invalidated and the
    // render-on-demand signals were consumed. A skip removes the DRAW and nothing else — so it
    // cannot move a pixel, and the pixels it would have drawn are not lost, because `_paceOwed`
    // carries the want forward and the park predicate refuses to sleep while it is set. Unflagged,
    // `_paceOwed` is never set and `Decide` always says render, so this is the same loop it was.
    //
    // THE SNAP is the last of the four wants, and it is the one that survives the clock: the settle
    // window has elapsed, adaptive shadows were measured inside it, and this render is the one that
    // takes every reading whole before the loop sleeps. It is a want like the others, so the pace
    // gate may refuse it -- and then `_paceOwed` carries it exactly as it carries any other refused
    // render, `_shadowSnapPending` stays set, and BOTH terms keep the park predicate awake until a
    // tick actually runs it. A skipped snap is deferred, never lost.
    //
    // It also waits for the render TAIL, and that is an exactness condition rather than tidiness: an
    // eased render landing on top of a snapped state re-blends `reading` with `reading`, which is the
    // same value in real arithmetic and a 10-bit rounding away from it in the state texture. The snap
    // must be the LAST render of the window, so it takes the tick after the tail has run out. The
    // tail is three frames and the window is 450 ms, so this costs nothing at any real tick rate; it
    // is here for the rate that is not real.
    const settled = time >= this._shadowSettleUntil;
    const wantsSnap = this._shadowSnapPending && settled && this._renderHold === 0;
    const wantsRender = this._renderHold > 0 || !settled || this._paceOwed || wantsSnap;
    const decision = wantsRender ? this._tickPace.Decide(this._paceGate, time) : 'skip';
    const shouldRender = wantsRender && decision !== 'skip';
    if (wantsRender) {
      this._paceOwed = !shouldRender;
      this._counts.TicksRendered = this._tickPace.Rendered;
      this._counts.TicksSkipped = this._tickPace.Skipped;
      this._counts.TicksForced = this._tickPace.Forced;
      if (decision === 'forced' && !this._paceForcedSaid) {
        this._paceForcedSaid = true;
        // Said once, loudly: the fence did not signal for eight consecutive ticks, so this render is
        // the stall guard's and not the flag's. Any cell whose forced column is non-zero is void.
        JTrace(`jaui:tick-pace forced=1 after=${PACE_STALL_TICKS}-skipped-ticks`);
      }
    }
    if (shouldRender) {
      if (this._renderHold > 0) this._renderHold--;
      if (ff) JTrace('jaui:render:start');
      // Timed for the first-frame marks, and — under `?tick-pace=lock` — for the CPU half of the
      // period the cadence is chosen from. Two `performance.now()` per RENDERED frame, paid only on
      // the arm that reads them.
      const wantsCost = this._tickPace.WantsRenderCost;
      // `_frameTrace` must be here too: otherwise tRender stays 0 and the mark prints
      // `performance.now() - 0`, i.e. absolute page age, which looked like a 6,925 ms frame.
      const tRender = ff || wantsCost || this._frameTrace ? performance.now() : 0;
      // THE SNAP, armed around this one call and nowhere else. `_resize` renders inline too and must
      // never take a whole reading off the ease -- a resize is motion, and the ease is the ease while
      // the page moves. The flag is a renderer field rather than an argument for the reason
      // `DiagNoBlur` is: the walk hands `MeasureShadowBackdrop` its arguments at two call sites and
      // neither of them is the one that knows the loop is about to park.
      //
      // Both probe paths are covered because the snap is a MODE OF THE RENDER rather than a pass
      // after it. The walk probes each adaptive-shadow surface immediately before its own draw;
      // `?blur-phased` hoists those probes into `_phasedShadowProbes`, which runs over `_phasedBuilt`
      // -- the FILL builds of that frame, which is every adaptive-shadow surface in it, because a rim
      // plan carries `AdaptiveShadow: false` and draws no shadow. Either way the set a snap frame
      // writes is the set that frame draws with, so no surface can keep a residual into the park.
      const snapNow = wantsSnap;
      const gl2 = this._renderer instanceof WebGL2Renderer ? this._renderer : null;
      if (snapNow) {
        this._shadowSnapPending = false;
        if (gl2 !== null) { gl2.ShadowSnapped = 0; gl2.ShadowSnap = true; }
      }
      this._render(dt);
      if (snapNow && gl2 !== null) { gl2.ShadowSnap = false; this._shadowSnapped = gl2.ShadowSnapped; }
      if (wantsCost) this._tickPace.NoteRenderCost(performance.now() - tRender);
      // The renderer's ledger reset in `BeginFrame` and has just been filled by the walk. Read it
      // here rather than in the HUD block so a parked frame keeps reporting 0 alongside the other
      // counts instead of the last rendered frame's.
      if (this._renderer instanceof WebGL2Renderer) {
        this._counts.SceneReads = this._renderer.SceneReads;
        this._counts.SceneRestarts = this._renderer.SceneRestarts;
        this._counts.SceneSwitches = this._renderer.SceneSwitches;
        // The switch column priced by TARGET, because an encoder end costs what its attachment
        // costs: ~0.12 ms below the 6.4-9.2 MB cliff and 1.1-1.5 ms above it. Three columns each
        // reading low while the frame stayed slow is the failure mode this phase has already paid
        // for once, so the number that matters -- ends on targets ABOVE the cliff -- is readable
        // rather than inferred.
        this._counts.SceneEndsByKey = this._renderer.SceneEndsByKey;
        // The atlas's own DRAWS. It belongs beside the switch columns and not in the atlas gate
        // line alone, because `?atlas-instanced`'s whole cell is this number against a frame time
        // -- and the harness's `drawCalls` does not count a pyramid draw at all.
        this._counts.AtlasDraws = this._renderer.SceneAtlasDraws;
        this._counts.CardComposites = this._renderer.CardComposites;
        this._counts.CardFallbacks = this._renderer.CardFallbacks;
      }
      // PER-FRAME, under `?frame-trace`. Placed beside the first-frame mark because both want the
      // same `tRender` and the same `_counts`, and deliberately NOT folded into it: that one is
      // latched to the first frame and several tools parse it as such.
      if (this._frameTrace && this._frameTraceCount < this._frameTraceCap) {
        this._frameTraceCount++;
        const c = this._counts;
        // `cpuMs`, NAMED SO IT CANNOT BE MISREAD. This is the time to WALK THE TREE AND ISSUE the
        // draws, not the time the GPU takes to execute them. On the home page it reads 1.1ms median
        // against a 16.67ms budget while the page sustains only 41fps with 31% of ticks skipped —
        // because the fence waits ~33ms for the GPU. A reader who sees "1.1ms" and concludes the
        // frame is cheap will optimise the wrong side of the handoff.
        JTrace(`jaui:frame n=${this._frameTraceCount} cpu=${JMs(performance.now() - tRender)}ms`
          + ` panels=${c.Panels} glass=${c.Glass} rims=${c.Rims} text=${c.Text} images=${c.Image} pblur=${c.PBlur}`
          + ` switches=${c.SceneSwitches} atlasDraws=${c.AtlasDraws}`
          + ` rendered=${c.TicksRendered} skipped=${c.TicksSkipped}`);
      }
      if (ff && this._ffPresented) {
        // `_render` sets the latch at the present, beside the first-frame hook — `_resize` renders
        // inline as well, so the tick is not the only way pixels can arrive. This mark lands just
        // after that present and carries what the walk actually drew.
        const c = this._counts;
        const glyphs = this._textCache.RasterCount;
        JTrace(`jaui:render:end ${JMs(performance.now() - tRender)}ms`
          + ` panels=${c.Panels} glass=${c.Glass} rims=${c.Rims} text=${c.Text} images=${c.Image} pblur=${c.PBlur}`
          + ` sceneReads=${c.SceneReads} sceneRestarts=${c.SceneRestarts} sceneSwitches=${c.SceneSwitches}`
          + ` endsByKey=${_endsByKey(c.SceneEndsByKey)} atlasDraws=${c.AtlasDraws}`
          + ` cards=${c.CardComposites} cardFallbacks=${c.CardFallbacks}`
          // Cumulative, so at the first frame this reads 1/0/0 whatever the mode. It is here because
          // it is the earliest proof the columns are wired at all - a `?tick-pace` run whose
          // `jaui:render:end` says `paceRendered=0` never reached the gate.
          + ` pace=${TickPaceText(this._tickPace.Mode)} paceRendered=${c.TicksRendered}`
          + ` paceSkipped=${c.TicksSkipped} paceForced=${c.TicksForced}`);
        JTrace(`jaui:glyphs:first n=${glyphs} ${JMs(this._textCache.RasterMs)}ms`);
        // Images never gate a frame — a decode that finishes asks for the next one. These say how
        // many were still out when the first frame painted, so that stays a reading, not a claim.
        JTrace(`jaui:images:at-first-frame inflight=${this._imageCache.InFlight} queued=${this._imageCache.Queued}`);
      }
      // Debug layout overlay — rainbow 1px outlines on every Jiv. Enabled by
      // `?debug-layout`; no cost when disabled.
      if (this._debugLayout) this._drawDebugLayout();
    }
    // Fire every tick so frame-wait callbacks are never starved on idle frames.
    this._firePostFrame();

    // `?tick-pace`'s ledger on the plain console, once a second, ONLY when the flag was NAMED.
    // Deliberately not folded into the `[Jaui]` line below it: that line needs `?wkr-jaui-prof`,
    // which also arms the per-pass GPU timers and makes every other frame a split frame — perturbing
    // the exact quantity this flag was built to measure. The worker's console is captured by the
    // perf harness (`instrument.mjs` wraps `console.*`; the page's CDP Log domain carries the same
    // lines), so this puts renders-per-window in the report with no harness change and no split
    // frame. Six lines in a 6 s window, each different, well inside the harness's 60-line cap.
    if (this._paceCensusOn) this._paceCensus(time);

    if (hud) {
      const tEnd = performance.now();
      const i = this._frameIdx;
      const phaseDirty  = tDirtyEnd  - t0;
      const phaseLayout = tLayoutEnd - tDirtyEnd;
      const phaseText   = tTextEnd   - tLayoutEnd;
      const phaseRender = tEnd       - tTextEnd;
      this._phaseDirty[i]  = phaseDirty;
      this._phaseLayout[i] = phaseLayout;
      this._phaseText[i]   = phaseText;
      this._phaseRender[i] = phaseRender;
      this._countsRolling.Panels = this._counts.Panels;
      this._countsRolling.Glass  = this._counts.Glass;
      this._countsRolling.Text   = this._counts.Text;
      this._countsRolling.Image  = this._counts.Image;
      this._countsRolling.PBlur  = this._counts.PBlur;
      this._countsRolling.SceneReads    = this._counts.SceneReads;
      this._countsRolling.SceneRestarts = this._counts.SceneRestarts;
      this._countsRolling.SceneSwitches = this._counts.SceneSwitches;
      this._countsRolling.CardComposites = this._counts.CardComposites;
      this._countsRolling.CardFallbacks = this._counts.CardFallbacks;
      // Poll whatever GPU timer result is now available. The reading lags
      // 2-3 frames behind what we just submitted — writing it into the same
      // rolling window is still useful because we're averaging, not trying
      // to align one frame's CPU and GPU numbers.
      const gpuMs = this._renderer.GetFrameGpuMs();
      if (gpuMs !== null) {
        this._phaseGpu[this._phaseGpuCount % this._phaseGpu.length] = gpuMs;
        this._phaseGpuCount++;
      }
      this._frameIdx = (i + 1) % this._phaseDirty.length;
      if (this._frameCount < this._phaseDirty.length) this._frameCount++;
      if (this._consoleProfilingEnabled) this._surfFrame++;

      // Per-second console summary — only when `?wkr-jaui-prof` is set.
      // Independent of HUD rendering so it works in the worker (no DOM).
      if (this._consoleProfilingEnabled) {
        this._profSum.Dirty  += phaseDirty;
        this._profSum.Layout += phaseLayout;
        this._profSum.Text   += phaseText;
        this._profSum.Render += phaseRender;
        this._profSum.Total  += tEnd - t0;
        this._profN++;
        if (this._profLastDumpMs === 0) this._profLastDumpMs = tEnd;
        if (tEnd - this._profLastDumpMs >= 1000 && this._profN > 0) {
          const n = this._profN;
          const avg = (v: number) => (v / n).toFixed(1);
          // Average the resolved GPU-timer samples in the rolling ring. The
          // reading lags 2-3 frames behind submission, so we average rather
          // than align; nulls were already skipped on write. `gpu n/a` when
          // no query has resolved (Safari / ANGLE without timer queries).
          const gpuFilled = Math.min(this._phaseGpuCount, this._phaseGpu.length);
          let gpuSum = 0;
          for (let g = 0; g < gpuFilled; g++) gpuSum += this._phaseGpu[g];
          const gpuStr = gpuFilled > 0 ? `${(gpuSum / gpuFilled).toFixed(2)}ms` : 'n/a';
          // The same second's frame, split by pass. `_passProfileMark` is the profile as it stood
          // at the last dump, so this line is the window between two dumps and not since boot.
          const passNow = this._renderer.GetPassProfile();
          const passLine = PassWindowText(PassWindowOf(this._passProfileMark, passNow));
          this._passProfileMark = passNow;
          // eslint-disable-next-line no-console
          console.log(
            `[Jaui] ${n}f over ${(tEnd - this._profLastDumpMs).toFixed(0)}ms — avg total ${avg(this._profSum.Total)}ms;` +
            ` Dirty ${avg(this._profSum.Dirty)} Layout ${avg(this._profSum.Layout)}` +
            ` Text ${avg(this._profSum.Text)} Render ${avg(this._profSum.Render)} | gpu ${gpuStr}` +
            `
       ${passLine}` +
            ` | P${this._counts.Panels} G${this._counts.Glass} T${this._counts.Text} I${this._counts.Image} Pb${this._counts.PBlur} SB${this._counts.SharedBuilds} cap${this._counts.CacheCap} comp${this._counts.CacheComp}` +
            // `restart/read/switch`: scene taps that followed a draw into the scene, over all scene
            // taps, over encoder ENDS - a non-scene target bound over a dirty scene. The first was
            // the read-after-write hypothesis's lever and `?snap-once` refuted it; the third is what
            // survived. On `glass-grid` the first and third read alike at baseline and part company
            // under the flag, which is the comparison this line exists to make readable at a glance.
            ` | scene ${this._counts.SceneRestarts}/${this._counts.SceneReads}/${this._counts.SceneSwitches}` +
            // ...and the ends named by the target that took them, because an end on the 16 MB scene
            // and an end on a 1 MB card are the same 1 in that column and ~1.4 ms apart on the clock.
            ` [${_endsByKey(this._counts.SceneEndsByKey)}]` +
            // The draws the frame's ATLAS builds issued -- 0 with no atlas armed, 8 under
            // `?pyramid-atlas=all`, 160 under `all&atlas-instanced=off`. Not a subset of
            // `drawCalls`: that column is scene draws and has never counted a pyramid pass.
            ` atlasDraws ${this._counts.AtlasDraws}` +
            ` | lce${this._layerCacheEnabled ? 1 : 0} cf${this._cacheForce ? 1 : 0} us${this._uiStatic ? 1 : 0} ld${layoutDirty ? 1 : 0} ir${this._animationManager.IsRunning ? 1 : 0} | diag reached${this._cacheDiag.reached} effH${this._cacheDiag.effH} tel${this._cacheDiag.teleport} op${this._cacheDiag.opacity} rot${this._cacheDiag.rot} xf${this._cacheDiag.xform} vis${this._cacheDiag.visual} psp${this._cacheDiag.persp} samp${this._cacheDiag.samples} ok${this._cacheDiag.ok}` +
            ` | snap ${this._opMs.Snap.toFixed(1)} blur ${this._opMs.Blur.toFixed(1)} mip ${this._opMs.Mip.toFixed(1)} draw ${this._opMs.Draw.toFixed(1)}` +
            // `?tick-pace`, cumulative. `r` is renders, `s` refused renders, `f` the stall guard's.
            // Read `r` against the window's PRESENTED frame count, not against `n` above and not
            // against the harness's `ticks`: `n` is ticks the profiler saw and `ticks` is rAF
            // callbacks, and this flag's entire purpose is to make those three different numbers.
            ` | pace ${TickPaceText(this._tickPace.Mode)} r${this._counts.TicksRendered} s${this._counts.TicksSkipped} f${this._counts.TicksForced}` +
            // The snap, cumulative-free: surfaces written WHOLE at the last park, so a window that
            // ends parked reads the number of glass surfaces on screen and a window that never
            // settled reads 0. Named `shadowSnap` rather than `snap` because `snap` three columns
            // left is the snapshot pass's milliseconds. `armed` distinguishes "did not park" from
            // "`?shadow-snap=off`".
            ` | shadowSnap=${this._shadowSnapped} armed=${this._shadowSnapArmed ? 1 : 0}` +
            // `?occlusion`, per frame and exact (the gate line quantises `px` so it can key on a
            // shape; this does not). `occludedPx` is the fill this frame did not shade. `prepassMs`
            // beside it is what the decision cost, so the lever can be shown to save more than it
            // spends rather than assumed to.
            ` | occluded=${this._occlusionStats.Skipped + this._occlusionStats.Carved}` +
            ` occludedVacuous=${this._occlusionStats.Vacuous}` +
            ` occludedPx=${this._occlusionStats.Px}` +
            ` prepassMs=${this._occlusionStats.Ms.toFixed(2)}` +
            ` armed=${this._occlusion ? 1 : 0}` +
            // `?emptypanels`, per frame and exact. `emptyPx` is the quad this frame did not shade
            // for ink that was provably absent -- a different quantity from `occludedPx` beside
            // it, which is ink that WAS painted and then covered. No milliseconds column: this
            // lever costs a few comparisons at a site the walk was already standing on.
            ` | empty=${this._emptyPanelStats.Panels}` +
            ` emptyPx=${Math.round(this._emptyPanelStats.Px)}` +
            ` armed=${this._emptyPanelCull ? 1 : 0}`
          );
          this._profSum.Dirty = this._profSum.Layout = this._profSum.Text = 0;
          this._profSum.Render = this._profSum.Total = 0;
          this._profN = 0;
          this._profLastDumpMs = tEnd;
        }
      }
    }

    // ── The park ───────────────────────────────────────────────────────────────
    // Return true and the rAF loop STOPS. `Wake` is what starts it again.
    //
    // This is not "assume nothing moved". Every signal below is one the render-on-demand gate
    // thirty lines up ALREADY decides on; they are read again here, after the render rather than
    // before it, so the loop parks exactly on the frames that gate was already skipping. A park
    // can therefore only be wrong somewhere that gate was already wrong, and that gate has
    // shipped and been measured. Nothing new is assumed about the scene: a surface that changes
    // without our tree changing -- a Janvas whose foreign renderer drew, an image that finished
    // decoding, a spring nobody kicked -- does not become invisible here, because every one of
    // those already had to say so to get PAST the gate and be drawn at all.
    //
    // What parking does change is who pays for the saying. Until now each of those signals was
    // consumed by a tick that was going to happen regardless, so a signal that forgot to schedule
    // a frame still got one; the loop was covering for it. Parked, there is no next tick, so the
    // signal has to ask. That is four funnels, and every writer of the four goes through one:
    //
    //   layout / text dirty   Element.MarkLayoutDirty -> DirtyTracker.Notify -> `Wake`.
    //                         `_resize` writes Root.Dirty directly and wakes itself.
    //   animation active      AnimationManager.Kick -> OnWake -> `Wake`, fired BEFORE Kick's own
    //                         early-out. Plus JivStyleAnimator.Wake, which makes an already
    //                         REGISTERED animatable live without any Kick at all -- which is what
    //                         a visual-only `:Hover` does, and it marks nothing dirty.
    //   explicit request      RequestFrame -> `Wake`. Janvas.MarkDirty, the image cache's decode
    //                         completion and the background-image cross-fade all land here.
    //   anything from main    WorkerBridge.HandleMessage wakes on EVERY inbound message, before it
    //                         is even dispatched. A message from main is by definition a potential
    //                         change and the belt costs one boolean.
    //
    // The render tail, the GPU-side shadow ease and an unconsumed resize or capture are read
    // directly rather than through a funnel, because this loop is the only thing that writes them.
    //
    // `_needsRender` is read HERE and not reused from the top of the tick on purpose: `_render`
    // re-requests a frame for its own reasons (a background image still fading in, at :2456), and
    // parking on the value it held before the render would drop those frames on the floor.
    //
    // `_paceOwed` is read here for the same reason `_renderHold` is: it is a render this loop has
    // decided to do and has not done. Parking on it would be the one way `?tick-pace` could lose a
    // frame rather than defer one — the loop would sleep holding the render, and nothing would wake
    // it, because the signal that asked for it was consumed on the tick that skipped.
    //
    // `_shadowSnapPending` is the same kind of term and is the one that makes the parked frame
    // cadence-independent. The clock alone says the ease has had long enough; it does not say how
    // many frames were RENDERED inside that time, and the ease only steps on rendered frames. So the
    // loop parks on the SNAP having happened, not on the window having elapsed: while this is set the
    // loop is holding a render whose whole purpose is to be the last one, and sleeping on it would
    // freeze exactly the residual this lane exists to remove. It is only ever set when the snap is
    // armed, so `?shadow-snap=off` leaves this line reading false and the park is the old park.
    return (this.Root.Dirty & (DirtyFlag.Layout | DirtyFlag.Text)) === 0
      && this._dirtyNodes.size === 0
      && !this._animationManager.IsRunning
      && !this._needsRender
      && !this._paceOwed
      && !this._shadowSnapPending
      && this._renderHold === 0
      && time >= this._shadowSettleUntil
      && this._pendingResize === null
      && this._pendingCapture === null;
  };

  private _render = (dt: number): void => {
    const r = this._renderer;
    this._adaptiveShadowsDrawn = false;
    this._bcFillClean = null;
    const w = Math.round(this._width * this._dpr);
    const h = Math.round(this._height * this._dpr);
    // Retained-mode layer cache: the capture path redirects the panel/text
    // flush into a stable subtree's own FBO by overriding the projection
    // resolution (and the bound target). Defaults to the canvas dims, so the
    // normal full-frame path stays byte-identical.
    let flushW = w, flushH = h;
    // Per-frame: reset the dynamic-subtree memo; gate the layer cache on a live
    // WebGL2 context (the capture binds FBOs + needs GetGL()).
    this._subtreeDynamicMemo.clear();
    this._subtreeUnretargetableMemo.clear();
    this._rimPassMemo.clear();
    // [damage] Phase A proof: a small field-only dirty rect; everything outside is culled.
    this._damageRectCss = this._damageTest
      ? { x: this._width * 0.10, y: this._height * 0.40, w: this._width * 0.30, h: this._height * 0.25 }
      : null;
    const cacheCapable = this._renderer instanceof WebGL2Renderer && this._renderer.GetGL() !== null;
    if (this._renderer instanceof WebGL2Renderer) this._renderer.DiagNoBlur = this._diagNoBlur;

    // Cascade opacity: multiply each Jiv's RenderStyle.Opacity by its
    // ancestors' so children inherit parent dimming (CSS-like). The style
    // animator rewrites Opacity each frame from its spring, so this
    // multiplied value only lives for the current render pass.
    this._cascadeOpacity(this.Root, 1);

    // Cascade the foreground filter grade (CSS `filter` on a subtree).
    // brightness/saturation/contrast are pointwise, so folding the parent's
    // grade into each descendant is identical to grading the composited
    // subtree as a group — but free (no offscreen pass). `Isolate` starts a
    // fresh grade for the subtree.
    this._cascadeFilterGrade(this.Root, 1, 1, 1);

    // Cascade VIBRANCY (Core/Vibrancy.ts): one more VALUE on the same kind of walk, like `color`. No new
    // pass, no render target. `Isolate` is the barrier.
    this._vibrancyStats.CascadeVisited = 0;
    this._vibrancyStats.CascadeCarried = 0;
    this._cascadeVibrancy(this.Root, null);

    r.Resize(w, h, this._dpr);
    r.BeginFrame();
    this._textCache.BeginFrame();

    // Render the scene into the off-screen `_sceneFbo` instead of drawing
    // directly to the swap chain. This lets glass/pblur surfaces sample
    // the scene texture as their backdrop with zero per-surface blits —
    // the FBO IS the "snapshot" at all times, always current.
    //
    // End-of-frame, we do a single Blit of the scene FBO into the default
    // framebuffer (see the block after the tree walk). Total full-canvas
    // blits per frame: 1 (final present), down from 1+N (one per
    // glass/pblur that used to call SnapshotScreen).
    r.DisableBlend();
    r.BeginScenePass(0, 0, 0);
    // `?blur-cache`: the paint ledger opens beside the scene it describes, before the first draw
    // into it (the janvas pre-pass below).
    this._bcBeginFrame(w, h);

    // Shared backdrop is rebuilt fresh each frame (no cross-frame caching — the
    // video-backdrop contract changes the scene every frame). Invalidate now;
    // the first glass/pblur surface lazily builds it from the scene-so-far.
    this._sharedPyramidValid = false;
    this._sceneDirtyRects.length = 0;

    // ── Janvas pre-pass ──
    // Foreign WebGL2 renderers (a THREE.js scene, a custom shader app, etc.)
    // attached to <janvas> elements draw into the just-bound scene FBO at
    // their layout rect. Subsequent panels render over the top; glass
    // surfaces sample the result as their backdrop. Only WebGL2 backends
    // expose a raw GL handle — on WebGPU this loop is a no-op.
    if (this._renderer instanceof WebGL2Renderer) {
      const gl = this._renderer.GetGL();
      if (gl) {
        this._pendingJanvasMasks.length = 0;
        if (!this._diagNoReality) this._renderJanvases(gl, this.Root, 0, 0, w, h, dt, null);
        // Restore the state Jaui's panel pass expects after the foreign
        // renderer ran. Jaui's draws assume: scene FBO bound, canvas-sized
        // viewport, no scissor, no depth/cull/stencil, no bound program /
        // VAO / array buffers, texture unit 0 active. THREE in particular
        // leaves all of these in arbitrary states. ALSO drop our own state
        // cache (`_lastProgram` etc.) so the next Jaui draw doesn't trust
        // stale caches against THREE's bindings.
        // Full reset of every GL state THREE may have touched. THREE
        // mutates 30+ pieces of state during a render and Jaui's draws
        // assume specific defaults; partial reset = subtle bugs (inverted
        // text from leftover blend equation, missing text from leftover
        // depth/colour mask, etc.).
        //
        // NOTE: a previous attempt trimmed the texture-unit unbind loop
        // and the null program/VAO/buffer binds. CPU-submit time dropped
        // by ~120ms/frame on software ANGLE, but wall-time *rose* by
        // ~200ms/frame — the rasterizer was apparently doing extra work
        // when we left bindings in their post-THREE state. Keep the
        // full reset.
        this._renderer.RebindSceneTarget();
        gl.viewport(0, 0, w, h);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        gl.disable(gl.RASTERIZER_DISCARD);
        gl.depthMask(true);
        gl.colorMask(true, true, true, true);
        gl.stencilMask(0xFF);
        gl.frontFace(gl.CCW);
        gl.cullFace(gl.BACK);
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.blendColor(0, 0, 0, 0);
        gl.useProgram(null);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        for (let unit = 0; unit < 8; unit++) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
          gl.bindTexture(gl.TEXTURE_3D, null);
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
        this._renderer.InvalidateStateCache();
      }
    }

    // Track whether we've built a blur for the current snapshot
    let lastBackdrop: GpuTextureHandle | null = null;
    let lastBaseFrostLod: number = 0;
    // THE SCROLL EDGE'S BACKDROP, for the glass inside it. A scroll edge strip (`ProgressiveBlurKind:
    // ScrollEdge`) builds a sharp-rooted pyramid of the scene as it was BEFORE the strip dims and blurs it,
    // and a bar floating in the strip samples that pyramid at its own frost instead of building one from
    // the dimmed scene. So the bar reads brighter than the dimmed surround, as Apple's does, and costs no
    // build of its own. A `Surface` blur is the surface's own material: glass in it builds from the scene
    // as drawn, blur included. Scoped to the strip's subtree; null everywhere else.
    let edgeBackdrop: EdgeBackdrop | null = null;
    // AN ACTIVE LENS'S BACKDROP (Jwift/Apple/LiquidGlass.md 7.1): Apple's lens is a BackdropView over everything
    // under the bar's lifted content (the bar's glass and, past its edges, the page), the real items erased under
    // it, and a lifted copy of those items above its glass. So its parent takes a copy of the scene just before the
    // first child of the lifted content draws (Layer 1 and up: a lens's resting pill is Layer 0), and the lens
    // warps that copy and lifts the items from the scene as drawn over it.
    let lensBelow: { Lens: Jiv; Handle: GpuTextureHandle; Items: GpuTextureHandle | null } | null = null;
    // The glass whose labels the text drawn now sits on (`SetGlassInk`): its probe slot and theme, or -1.
    let glassInk = { Slot: -1, Dark: false };
    // The probe slot of the glass whose children are being walked, for its rim pass's appearance; -1 elsewhere.
    let rimSlot = -1;
    // NOTE: no more `backdropDirty` cache flag. The video-backdrop app
    // contract means the scene is different every frame; caching snapshots
    // across surfaces was already unsafe. Each glass/pblur now builds its
    // own pyramid AT the size of its sample region, so recomputing per
    // surface is cheap. If a future optimization needs to skip recompute
    // (e.g. fullscreen chrome pblurs with matching radius), add a local
    // cache scoped to the region rect + radius rather than a global flag.
    //
    // Within-frame pyramid sharing was attempted (track dirty rect, reuse
    // pyramid when next surface's read region doesn't overlap) but
    // regressed perf 2× on a software-rasterized device:
    //   - Most blur surfaces' read regions overlap the accumulating
    //     dirty rect (full-width pblurs + page text), so reuse rarely fires.
    //   - Each ComputeBlur is SIZED to its OWN read region — a cached
    //     pyramid holds only that rect; reuse for a different region reads
    //     the wrong part of the screen, not merely stale pixels.
    // To revisit this: build pyramids over the full canvas (costlier per
    // build, and the attachment cost this lane removed) or over the union region of all
    // consumers (requires upfront scan of pblur/glass surfaces). Both
    // change the calculus and need their own measurement pass.

    // Pending non-glass panel batch. The tree walk pushes every non-glass
    // panel into `_panelBuffer` instead of drawing it immediately; when we
    // hit something that would violate z-order (glass, pblur, image, text,
    // or the end of the walk), we flush the whole buffer as ONE instanced
    // draw call.
    //
    // Why this is safe: all non-glass panels share the same shader program,
    // uniforms, vertex array, and backdrop (null). They differ only in
    // per-instance data (rect, color, shadow, clip offset), which is
    // already passed per-instance via the instance buffer. Transparent,
    // solid, or partial-alpha backgrounds all composite correctly because
    // the blend state is constant within the batch and instances draw in
    // tree order (preserved by push order).
    //
    // Win: on Home the 30-100 separate panel draw calls collapse to ~3-5
    // per frame (one batch per segment between glass/image/text boundaries).
    // Major CPU-submit savings on mobile / iPad.
    const flushPanels = (): void => {
      if (this._panelBuffer.Count === 0) return;
      r.EnableBlend();
      r.PanelBeginBatch();
      r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
      r.PanelAddInstance(this._panelBuffer.Data, 0, this._panelBuffer.Count * JIV_FLOATS_PER_INSTANCE);
      r.PanelDrawBatch(flushW, flushH, null, 0);
      this._vibrancyStats.PanelBatches++;
      this._counts.Panels += this._panelBuffer.Count;
      this._panelBuffer.Begin(); // reset count for the next batch
    };

    // Pending text batch — same pattern as flushPanels. Text is emitted
    // per-node via `_emitTextFor`, which pushes glyph instances into
    // `_textBuffer`. Previously each node with text did its own draw call.
    // Now we accumulate across sibling text nodes and drain together when
    // we hit a category boundary (panel push, glass/pblur, image, or end
    // of the walk).
    //
    // Z-order: panel and text buffers are mutually-exclusive in the sense
    // that adding to one forces a flush of the other — so at any instant
    // only ONE of them holds pending work, and flushing drains in tree
    // order.
    const flushText = (): void => {
      if (this._textBuffer.Count === 0) return;
      const atlas = this._textCache.Atlas;
      if (!atlas) { this._textBuffer.Begin(); return; }
      r.TextBeginBatch();
      r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
      r.TextAddInstance(this._textBuffer.Data, 0, this._textBuffer.Count * TEXT_FLOATS_PER_INSTANCE);
      r.TextDrawBatch(flushW, flushH, atlas);
      this._counts.Text += 1; // one flushed batch = one draw call
      this._textBuffer.Begin();
    };

    // The vibrancy shape draw (Core/Vibrancy.ts). One instance of the element's own shape, `Push`ed as
    // 'VibrancyOnly', so the radii, smoothness, clip stack, 3D homography and opacity are the ones its
    // fill would have used, filled with |amount| x color under the vibrancy blend. No snapshot, no
    // sampler, no pyramid. Both batches flush first: the blend reads everything beneath the element.
    const emitVibrancyUnder = (node: Jiv, value: VibrancyValue, eff: Mat2x3, clipOffset: number, clipCount: number, xformIndex: number, override: VibrancyValue | null): void => {
      flushPanels();
      flushText();
      this._panelBuffer.Begin();
      this._panelBuffer.Push(node, this._dpr, eff, clipOffset, clipCount, xformIndex, 'VibrancyOnly', override);
      r2.SetVibrancyBlend(VibrancyBlendOf('Shape', value.Amount, value.Cover));
      r.PanelBeginBatch();
      r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
      r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
      r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
      r.PanelDrawBatch(flushW, flushH, null, 0, false, null);
      r2.RestoreBlend();
      r2.NoteShapeDraw();
      this._counts.Panels++;
      this._panelBuffer.Begin();
    };

    // ── Teleport elevation ──
    // A subtree mid-teleport (Element.TeleportSeq != 0 — live-reparented, rect
    // springs still flying) is DEFERRED: painted after everything else inside
    // its nearest LAYERED ancestor's scope (most recent teleport last = topmost),
    // with the clip stack captured ABOVE that ancestor — so a card flying home
    // into a scrolled rail paints over its cousins and is not clipped by the
    // scroll container it is returning into, while still staying under
    // higher-Layer chrome (the scope replays before the next layered sibling
    // paints). Zero-cost when nothing is in flight (one int check per child).
    // `PerspCtx` and `TeleportScope` are module scope now — `?blur-first`'s pre-pass walks the
    // same tree and has to speak the same types.

    const replayScope = (scope: TeleportScope): void => {
      while (scope.Deferred.length > 0) {
        const items = scope.Deferred.sort((a, b) => a.N.TeleportSeq - b.N.TeleportSeq);
        scope.Deferred = [];
        for (const d of items) renderNode(d.N, d.M, scope.Stack, scope, d.MH, d.P);
      }
    };

    // `ownPanelCulled` — the caller skipped this node's OWN paint (its box failed the
    // clip or damage cull) and is only here to let overflowing children self-cull.
    const descendChildren = (node: Jiv, eff: Mat2x3, stack: ClipStack, scope: TeleportScope, effH: Mat3x3 | null, persp: PerspCtx | null, ownPanelCulled: boolean = false): void => {
      const boxClip = this._boxClip(node, eff);
      const childM = this._descendOffset(node, eff);
      // Mirror the scroll translate onto the homography so descendants of a
      // 3D-tilted scroll container scroll along the tilted plane.
      let childMH = effH;
      if (effH !== null && node.Overflow === 'Scroll') {
        childMH = mat3Mul(effH, mat3FromAffine([1, 0, 0, 1, -node.ScrollX, -node.ScrollY]));
      }

      // ── The node's EDGE, at its BorderLayer slot ──
      // Two things paint there, and both belong to the node rather than to the child offset frame, so
      // they draw in the node's OWN transform and clip (`eff`, `stack`): a border SUPPRESSED on the
      // fused panel (BorderLayer non-zero and a visible stroke), and the RIM, which always rides the
      // slot. The slot is after every child whose Layer is strictly below BorderLayer and before the
      // rest, so a negative BorderLayer lands behind content and one past every child lands on top.
      const borderSuppressed = this._borderEmits(node, eff, stack, effH, ownPanelCulled);
      const rimEmits = this._rimEmits(node, eff, stack, effH, ownPanelCulled);
      const borderLayer = node.RenderStyle.BorderLayer;
      let edgeEmitted = !(borderSuppressed || rimEmits);
      const emitEdge = (): void => {
        if (edgeEmitted) return;
        // `?blur-phased`: the edge builds nothing, so it paints in whichever pass its node's own
        // content painted in, which the live pass state says at the moment the slot is reached.
        if (!this._phasedEmitsEdge()) return;
        edgeEmitted = true;
        flushPanels();
        flushText();
        // `?blur-cache`: the edge paints among the children, not beside the fill, so it is a record of
        // its own. Opened after the flushes -- those drain the CHILDREN's instances, already recorded.
        if (this._bcOn) this._bc.Open(node, RECORD_EDGE);
        const ownClip = this._clipBuffer.Encode(stack, this._dpr);
        const ownXform = effH !== null ? this._xformBuffer.Add(effH, this._dpr) : -1;
        r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
        if (borderSuppressed) {
          this._panelBuffer.Begin();
          this._panelBuffer.Push(node, this._dpr, eff, ownClip.Offset, ownClip.Count, ownXform, 'BorderOnly');
          r.EnableBlend();
          r.PanelBeginBatch();
          r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
          r.PanelDrawBatch(w, h, null, 0, false, null);
          this._counts.Panels++;
          this._panelBuffer.Begin();
        }
        if (rimEmits && r2 instanceof WebGL2Renderer) {
          this._panelBuffer.Begin();
          this._panelBuffer.Push(node, this._dpr, eff, ownClip.Offset, ownClip.Count, ownXform, 'RimOnly');
          if (this._bcOn) this._bcNotePanel(ownClip.Offset, ownClip.Count, ownXform);
          // Apple's highlight recolors what is under the band by a matrix of that pixel, so it reads a
          // snapshot of the scene under the node's box.
          const box = this._nodeAabb(node, eff, effH);
          const under = r2.SnapshotScreen({
            x: Math.max(0, Math.floor(box.minX * this._dpr) - 1), y: Math.max(0, Math.floor(box.minY * this._dpr) - 1),
            w: Math.ceil((box.maxX - box.minX) * this._dpr) + 2, h: Math.ceil((box.maxY - box.minY) * this._dpr) + 2,
          });
          r2.RebindSceneTarget();
          r2.PanelBeginBatch();
          r2.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
          r2.PanelRimDraw(flushW, flushH, under, rimSlot);
          this._panelBuffer.Begin();
          this._counts.Rims++;
        }
        if (this._bcOn) this._bc.Close();
      };

      const lens = this._activeLensChild(node);
      for (const child of this._orderedChildren(node)) {
        // The edge drops in at its layer slot, just before the first child at or above BorderLayer
        // (children are Layer-sorted ascending).
        if (!edgeEmitted && child.RenderStyle.Layer >= borderLayer) emitEdge();
        if (lens !== null && child.RenderStyle.Layer >= 1 && lensBelow?.Lens !== lens) {
          flushPanels();
          flushText();
          const box = this._nodeAabb(node, eff, effH);
          const d = this._dpr, reach = LENS_BELOW_REACH_PT * d;
          const handle = r.SnapshotBelow({
            x: Math.max(0, Math.floor(box.minX * d - reach)), y: Math.max(0, Math.floor(box.minY * d - reach)),
            w: Math.ceil((box.maxX - box.minX) * d + 2 * reach), h: Math.ceil((box.maxY - box.minY) * d + 2 * reach),
          });
          r.RebindSceneTarget();
          lensBelow = { Lens: lens, Handle: handle, Items: liftLensItems(node, lens, stack, boxClip, childM, childMH, persp) };
        }
        const clip = this._childClip(node, stack, boxClip, child);
        // A Pinned child belongs to the scroller's FRAME, not its content:
        // it renders in the un-scrolled matrix, which is what a scrollbar, a
        // floating header, or any scroll-driven overlay is.
        const pin = child.ChildLayout.Position === 'Pinned' && node.Overflow === 'Scroll';
        const cM = pin ? eff : childM;
        const cMH = pin ? effH : childMH;
        if (child.TeleportSeq !== 0) {
          scope.Deferred.push({ N: child, M: cM, MH: cMH, P: persp });
          continue;
        }
        if (child.RenderStyle.Layer !== 0) {
          const childScope: TeleportScope = { Deferred: [], Stack: clip };
          // A teleported descendant deferred into THIS layered scope is painted with
          // `childScope.Stack` — the clip ABOVE this node — so a card flying home stays
          // WHOLE during the flight: it is not sheared by the box it is flying INTO, even a
          // Clip:Hidden glass panel like the library drawer. It clips to the destination only
          // once it SETTLES (TeleportSeq clears → normal render under the parent's own clip),
          // i.e. after it has reached its target position — never while it slides in from
          // outside. (Clipping mid-flight cut the card off against the panel edge as it flew.)
          renderNode(child, cM, clip, childScope, cMH, persp);
          replayScope(childScope);
          continue;
        }
        renderNode(child, cM, clip, scope, cMH, persp);
      }
      // BorderLayer sits above every child (or there were no children): the edge paints on top.
      if (!edgeEmitted) emitEdge();
    };

    // Single tree walk — renders everything in z-order. The (cx, cy,
    // ox, oy) tuple is the affine map from this Jiv's natural
    // (post-layout, pre-Visual-transform) coords to canvas px:
    //   canvasX = ox + cx * jiv.X
    //   canvasW = cx * jiv.Width
    // Identity (cx=cy=1, ox=oy=0) at the root is the no-transform path.
    // VisualScale on an ancestor composes into the effective tuple so
    // descendants ride along, just like CSS transform on a parent.
    const renderNode = (node: Jiv, m: Mat2x3, stack: ClipStack, scope: TeleportScope, mH: Mat3x3 | null = null, persp: PerspCtx | null = null): void => {
      // `?blur-phased` pass 1 paints the bed and stops at the FIRST surface that would build a
      // pyramid. Once it has, nothing further in the tree paints in this pass -- the stop is here,
      // at the top, rather than at the paint site, because the stopping node's own children have
      // to be held back too and `descendChildren` is already running by then.
      if (this._phasedPass === 1 && this._phasedStop) return;
      // Compose own's transform onto the inherited matrix. `_composeTransform` returns the affine
      // and leaves the homography and the descendants' perspective context in `_xfH` / `_xfPersp`,
      // which is why they are read on the very next two lines and nowhere else.
      const eff: Mat2x3 = this._composeTransform(node, m, mH, persp);
      const effH: Mat3x3 | null = this._xfH;
      const childPersp: PerspCtx | null = this._xfPersp;
      if (!this._isInsideClipStack(node, eff, stack, effH)) {
        // This node's OWN box is outside the clip. If it CLIPS its children
        // (Overflow: Hidden/Scroll), they're bounded by that box and can't be
        // visible either — skip the whole subtree (the cheap, common case).
        // But an Overflow: Visible node can have children that OVERFLOW its
        // box and remain on-screen after the box itself scrolls off — e.g. a
        // flex-wrap container whose intrinsic height is one row while its
        // children wrap to several rows. Dropping the subtree there made the
        // overflowing rows vanish the instant the (one-row) box passed the
        // viewport edge. So recurse — each child self-culls by its OWN AABB —
        // and just skip drawing this node's own panel/text (it's off-screen).
        // A clipping box that's off-screen clips its children too → skip the
        // subtree. A non-clipping box (e.g. Scroll with Clip:Visible) can have
        // children that overflow its box and remain on-screen, so recurse.
        if (node.ClipsChildren) return;
        descendChildren(node, eff, stack, scope, effH, childPersp, true);
        return;
      }

      // ── Damage-region cull (Phase A, gated ?damage-test) ──
      // Skip any node whose AABB doesn't intersect the dirty rect — its
      // panel/glass/blur draw never runs, so the GPU fill it would have cost
      // is saved. Mirrors the clip-cull above (clipping subtree → skip whole;
      // overflow-visible → recurse so overflowing children self-cull).
      if (this._damageCulls(node, eff, effH)) {
        if (node.ClipsChildren) return;
        descendChildren(node, eff, stack, scope, effH, childPersp, true);
        return;
      }

      // ── Retained-mode layer cache hook ──
      // A stable, static, axis-aligned subtree that doesn't sample the live
      // scene composites from its cached FBO instead of re-shading. Clipped
      // subtrees ARE cached: the capture keeps screen-space coords (projecting
      // through u_ViewOffset) and renders with the real ancestor clip stack, so
      // the screen-space clip masks match verbatim. _capturing guards re-entry.
      if (this._layerCacheEnabled && (this._uiStatic || this._cacheForce) && !this._capturing
          && node !== this.Root && node.Visible && node.Width > 0 && node.Height > 0) {
        // [cache-diag] tally why the hook rejects sizable nodes
        const d = this._cacheDiag; d.reached++;
        const rs = node.RenderStyle, tf = rs.Transform;
        if (effH !== null || persp !== null) d.effH++;
        else if (node.TeleportSeq !== 0) d.teleport++;
        else if (node.EffectiveOpacity < 0.999) d.opacity++;
        else if (Math.abs(eff[1]) > 1e-6 || Math.abs(eff[2]) > 1e-6) d.rot++;
        else if (tf.Rotation !== 0 || tf.RotateX !== 0 || tf.RotateY !== 0 || tf.TranslateZ !== 0) d.xform++;
        else if (rs.VisualScaleX !== 1 || rs.VisualScaleY !== 1 || rs.VisualTranslateX !== 0 || rs.VisualTranslateY !== 0) d.visual++;
        else if (rs.Perspective > 0) d.persp++;
        else if (this._subtreeSamplesLiveScene(node)) d.samples++;
        else d.ok++;
      }
      if (this._layerCacheEnabled && cacheCapable && (this._uiStatic || this._cacheForce) && !this._capturing
          && effH === null && persp === null
          && this._isLayerCacheRoot(node, eff)) {
        compositeOrCapture(node, eff, stack);
        return;
      }

      // Set image intrinsic sizes even for zero-size nodes — this breaks the
      // chicken-and-egg: Height:Auto needs IntrinsicHeight, which comes from
      // the loaded image. Without this, the node stays at 0 height forever.
      // The image URL is sourced from the Background tagged union (Image kind);
      // ImageSrc no longer exists as a separate property.
      const bg = node.RenderStyle.Background;
      const bgImageUrl = bg.Kind === 'Image' ? bg.Url : null;
      if (bgImageUrl && node.IntrinsicWidth === null) {
        const imgEntry = this._imageCache.Get(bgImageUrl);
        if (imgEntry && imgEntry.Ready) {
          node.IntrinsicWidth = imgEntry.Width / this._dpr;
          node.IntrinsicHeight = imgEntry.Height / this._dpr;
          node.MarkLayoutDirty();
        }
      }

      if (node.Width <= 0 || node.Height <= 0 || !node.Visible) {
        descendChildren(node, eff, stack, scope, effH, childPersp);
        return;
      }

      // `?blur-cache`: everything this node paints from here to its children is ONE record. Opened
      // before the clip encode so the clip entries its instances index are this frame's.
      if (this._bcOn) this._bc.Open(node, RECORD_NODE);

      // Encode the current clip stack into the per-frame buffer so this Jiv's
      // panel/text instances reference it by (offset, count).
      const clipMeta = this._clipBuffer.Encode(stack, this._dpr);
      // Projective node? Append its homography to the shared table once and pass
      // the index to whatever this node paints (panel and/or text). -1 = 2D.
      const xformIndex = effH !== null ? this._xformBuffer.Add(effH, this._dpr) : -1;

      const material = node.RenderStyle.Material;
      // The card-composite bracket. Opened in the glass FILL branch below and closed after this
      // node's children have walked, because the node's edge paints among them (`descendChildren`)
      // and has to land in the same target the fill did.
      let cardOpen = false;
      // Set by this node's progressive blur, if it draws one: the pyramid its subtree's glass samples.
      let edgeHere: typeof edgeBackdrop = null;
      // A surface that sampled its backdrop and drew over it: glass inside it sees it as drawn, not the edge's content.
      let closesEdge = false;
      // A probed glass surface this node draws: its subtree's labels follow its appearance.
      let glassInkHere = -1;
      let rimSlotHere = -1;

      // BorderLayer: when this Jiv asks for its border to paint at a non-zero
      // position in its children's Layer space, suppress the border on the
      // fused panel here and re-emit it as a standalone BorderOnly instance
      // interleaved among the children (see descendChildren). Default
      // (BorderLayer 0, or no visible border) keeps the border fused — today's
      // paint order, zero cost. Nothing else suppresses it: the rim's gather is the
      // reason the second pass exists (see descendChildren), not just paint order.
      // A glass rim that rides the pass (its content reaches the band) leaves the face the same way.
      const ownBorderMode: 'Normal' | 'Suppress' =
        (node.RenderStyle.BorderLayer !== 0 && (this._hasPaintedBorder(node) || this._glassRimInPass(node))) ? 'Suppress' : 'Normal';

      // `?blur-phased`: does this node paint its OWN content in the pass that is running? Asked
      // exactly once per node and only under the flag, because the ANSWER is also what detects the
      // pass-1/pass-2 boundary -- see `_phasedPaints`. Its children are walked either way.
      const phasedPaints = this._phasedPass === 0 || this._phasedPaints(node);

      // VIBRANCY (Core/Vibrancy.ts). Two independent switches on one element:
      //
      //   `BackdropFilter: Vibrancy()` owns the SHAPE DRAW, with two implementations: UNDER when
      //      nothing beside it samples, folded into the grade when something does.
      //   `Filter: Vibrancy()` / the inherited `Vibrancy:` property make the element's own paint
      //      vibrant. Where authored they also emit the shape draw, unless the backdrop zone already
      //      does, since two would double it. Their shape draw never folds: the fold makes the fill
      //      opaque over the backdrop, which is exactly the destination vibrant paint is drawn against.
      //
      // Emitted HERE, before anything of this node's own, which is the whole guarantee that the shape
      // draw never reaches the element's ink. `shapeBuilds0` brackets the node's own paint: an
      // under-drawn element that still caused a pyramid build is this lane failing.
      let shapeBuilds0 = -1;
      const zones: VibrancyZones = phasedPaints
        ? this._vibrancyZonesOf(node)
        : { Shape: null, Ink: null, TextInk: null, TextScale: 1 };
      const blend = zones.Ink;
      if (phasedPaints) {
        const backdrop = BackdropVibrancy(node.RenderStyle);
        const backdropActive = VibrancyIsActive(backdrop.Amount, backdrop.Cover);
        if (backdropActive) {
          this._vibrancyStats.Authored++;
          const bc = node.RenderStyle.BackdropVibrancyColor;
          const shape: VibrancyValue = { R: bc.R, G: bc.G, B: bc.B, Amount: backdrop.Amount, Cover: backdrop.Cover };
          const refusal = VibrancyRefusalOf(node, shape);
          if (refusal === 'ChromaticGraded') {
            // The ONE refusal that is an author error rather than a choice of implementation.
            this._vibrancyStats.Refused[refusal] = (this._vibrancyStats.Refused[refusal] ?? 0) + 1;
            throw new Error(_refuseChromaticGraded(shape));
          }
          if (refusal === null) {
            shapeBuilds0 = r2.PyramidBuilds;
            // `override` is null, so the packer reads exactly the style lanes it always read.
            if (!this._diagNoPanels) emitVibrancyUnder(node, shape, eff, clipMeta.Offset, clipMeta.Count, xformIndex, null);
            this._vibrancyStats.Under++;
          } else {
            this._vibrancyStats.Graded++;
            this._vibrancyStats.Refused[refusal] = (this._vibrancyStats.Refused[refusal] ?? 0) + 1;
          }
        } else if (zones.Shape !== null) {
          this._vibrancyStats.Authored++;
          shapeBuilds0 = r2.PyramidBuilds;
          if (!this._diagNoPanels) emitVibrancyUnder(node, zones.Shape, eff, clipMeta.Offset, clipMeta.Count, xformIndex, zones.Shape);
          this._vibrancyStats.Under++;
        }
        // An INHERITED vibrancy emits no shape draw and still makes this node's paint vibrant.
        if (zones.Ink !== null && zones.Shape === null && !backdropActive) this._vibrancyStats.Inherited++;
      }

      if (!phasedPaints) {
        // This node's panel, text and vector belong to another pass. Nothing here, deliberately:
        // the counters, the buffers and the ledger must see exactly one paint of this node per
        // frame, in exactly one of the three passes.
      } else if (material === 'ProgressiveBlur' && this._pblurOn(node)) {
        // Flush both pending batches: the pblur snapshots the scene and
        // samples it — so the scene must contain everything drawn so
        // far. Deferred panels AND text in the buffers haven't hit the
        // FBO yet.
        flushPanels();
        flushText();
        // Progressive blur samples two textures: `u_Scene` (unblurred, the
        // ramp's clear end) and `u_Pyramid` (blurred, the ramp's heavy end).
        // `u_Scene` cannot be sceneFbo.Texture directly because the pblur
        // draws INTO sceneFbo — feedback loop. So we use SnapshotScreen to
        // copy sceneFbo → _snapshotTex and feed that as `u_Scene`.
        // `u_Pyramid` is the BlurPass output (a separate texture), no
        // feedback risk.
        const d = this._dpr;
        const maxFeatherSigma = node.RenderStyle.BackdropFrostBlur;
        // Keep level 0 lightly blurred (σ ≈ 1px) so the ramp climbs the full
        // clear→heavy range smoothly. Raising the base σ to floor the heavy
        // end's resolution compresses the gradient into a near-uniform "mask"
        // (most of the element reads as already-blurred) — not worth it. The
        // heavy end's low-res mip is kept smooth instead by the output dither.
        const baseSigmaDevice = this._dpr;
        const targetSigmaDevice = maxFeatherSigma * this._dpr;
        const maxLod = Math.max(1, Math.log2(Math.max(1, targetSigmaDevice / baseSigmaDevice)));
        // Size the pyramid to this pblur's rect + LOD-scaled margin. Each mipmap LOD doubles
        // the canvas-space footprint of one texel, so a bilinear sample at max LOD reaches
        // ±2^(maxLod+1) canvas px from the pblur's own rect. Fullscreen pblurs
        // (TopBlur/ContentBlur covering 100vw×100vh) resolve to the whole canvas — identity
        // map, no savings, no harm. Localized pblurs (card footers ~260×60) see big
        // reductions: e.g. 516×316 vs 1920×1080 = ~13× less fill per blur pass and, more
        // valuably on a tile-based GPU, attachments 13× smaller to load and store.
        const lodMargin = Math.ceil(Math.pow(2, maxLod + 1));
        // AABB of the (possibly rotated) node in canvas px — the region is an
        // axis-aligned rect, so use the rotated rect's bounding box.
        const _ab = this._nodeAabb(node, eff, effH);
        const px = _ab.minX * d;
        const py = _ab.minY * d;
        const pw = (_ab.maxX - _ab.minX) * d;
        const ph = (_ab.maxY - _ab.minY) * d;
        // When a feather is set AND the background is fully opaque, the
        // solid post-feather region collapses to just u_Background — no
        // pyramid samples read past the feather zone (the shader early-outs
        // there). Tighten the blur region to only the feather strip + LOD
        // margin — for a tall content-area pblur with a 120pt feather,
        // that's ~15× less blur fill per frame.
        const bgOpaque = node.RenderStyle.Background.Color.A >= 0.999;
        const dir = node.RenderStyle.ProgressiveBlurDirection;
        // Feather ceilings at the element's OWN device axis length — height for
        // ToTop/ToBottom, width for ToLeft/ToRight. A feather longer than the
        // axis can never complete the ramp, leaving the whole element a partial
        // gradient that never reaches full blur. 0 keeps "span the whole axis".
        const axisLenDev = (dir === 'ToTop' || dir === 'ToBottom')
          ? matScaleY(eff) * node.Height * d
          : matScaleX(eff) * node.Width * d;
        const featherRaw = node.RenderStyle.ProgressiveBlurFeather * d;
        const feather = featherRaw > 0 ? Math.min(featherRaw, axisLenDev) : 0;
        // The feather-strip tightening slices one edge off the AXIS-ALIGNED
        // AABB. Under rotation the AABB is larger than (and offset from) the
        // rotated panel, so a tightened strip clips the rotated blur's edge
        // ("edge miss on the outside"). When rotated, fall back to the full
        // AABB region — the shader's ramp/feather still runs correctly in the
        // rotated frame; only this CPU-side fill optimization is skipped.
        const _rotated = matSin(eff) !== 0;
        let fx = px, fy = py, fw = pw, fh = ph;
        if (feather > 0 && bgOpaque && !_rotated) {
          if (dir === 'ToBottom')      { fh = feather; }
          else if (dir === 'ToTop')    { fy = py + ph - feather; fh = feather; }
          else if (dir === 'ToRight')  { fw = feather; }
          else if (dir === 'ToLeft')   { fx = px + pw - feather; fw = feather; }
        }
        const region = {
          x: Math.max(0, Math.floor(fx - lodMargin)),
          y: Math.max(0, Math.floor(fy - lodMargin)),
          w: Math.min(w, Math.ceil(fw + lodMargin * 2)),
          h: Math.min(h, Math.ceil(fh + lodMargin * 2)),
        };
        if (this._consoleProfilingEnabled && this._surfFrame === 90) {
          // eslint-disable-next-line no-console
          console.log(`[Jaui.surf] PBLUR rect=${Math.round(pw)}x${Math.round(ph)} region=${region.w}x${region.h} (${(region.w * region.h / 1e6).toFixed(2)}Mpx) frost=${maxFeatherSigma}pt dir=${dir} maxLod=${maxLod.toFixed(1)} bgOpaque=${bgOpaque}`);
        }
        // Snapshot only this pblur's footprint + blur margin (same region the pyramid is built
        // over) instead of the whole canvas — the shader samples the pyramid only within the
        // panel, so the rest of the snapshot is never read. The pyramid is built FROM this
        // snapshot, so the region it is given must not reach past what was copied: at radius 0
        // the grid phase is 1 and BlurPass grows it by nothing, which is what makes that safe.
        const sceneSnap = r.SnapshotScreen(region);
        // Sharp-root pyramid: radius 0 makes BlurPass seed mip 0 with the RAW
        // scene (a 1-tap copy, no dual-filter pre-blur), then GenerateBlurMipmap
        // builds the Gaussian stack from it. The shader samples ONE continuous
        // LOD from mip 0 (truly clear, σ=0) up to u_MaxLod (heavy) — true
        // progression with no sharp/blurred crossfade, and one fewer pass than
        // the dual filter.
        //
        // Cap mip build at this pblur's max sampled LOD — the shader does
        // textureLod(u_Pyramid, uv, ramp²·maxLod), so it never reads past
        // maxLod. Building deeper levels is pure fragment-fill waste on
        // a software rasterizer.
        //
        // `?blur-cache`: the pyramid is the whole mip chain of the region, so a clean region skips all
        // of it. The snapshot above still runs -- the draw below reads it as `u_Scene` -- and it is the
        // same scene state the reader was judged on.
        lastBackdrop = this._bcBuild(node, READER_PBLUR, region, 0, maxLod, false, false, w, h, () => {
          const built = r.ComputeBlur(sceneSnap, w, h, 0, undefined, region);
          r.GenerateBlurMipmap(maxLod);
          return built;
        });
        lastBaseFrostLod = 0;
        // Handed to the subtree's glass only by a scroll edge, and only for a plain ramp along its own unrotated axis.
        if (lastBackdrop !== null && node.RenderStyle.ProgressiveBlurKind === 'ScrollEdge'
            && node.RenderStyle.ProgressiveBlurStops === null && !_rotated) {
          edgeHere = { Handle: lastBackdrop, Region: region, MaxLod: maxLod };
        }
        r.RebindSceneTarget();
        r.EnableBlend();
        r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
        // The shader builds a UNROTATED quad from `Rect` and rotates it about
        // the pivot, so its ramp/feather run along the element's own (rotated)
        // axes. Rect = the element's unrotated device rect (centered on the
        // mapped center); Cos/Sin/Pivot carry the accumulated rotation. At
        // rotation 0 the unrotated rect equals the legacy AABB and (1,0) is a
        // no-op, so non-rotated pblur is unchanged.
        const _pbCx = matScaleX(eff), _pbCy = matScaleY(eff);
        const _pbPivotX = matApplyX(eff, node.X + node.Width * 0.5, node.Y + node.Height * 0.5) * d;
        const _pbPivotY = matApplyY(eff, node.X + node.Width * 0.5, node.Y + node.Height * 0.5) * d;
        // The element's OWN unrotated device half-extents. The pblur vertex
        // shader builds the quad from this Rect and ROTATES it about the pivot,
        // so an element-sized quad already covers the rotated element exactly —
        // do NOT expand to the rotated AABB (the panel does that because its
        // quad is an un-rotated screen-space cover; the pblur's quad is not).
        // Expanding here would make v_Local / axisLen track the AABB, so the
        // feather distance and ramp "height" would breathe with the rotation
        // angle. Element-sized keeps the ramp on the element's true axes; the
        // clip SDF (ClipOffset/ClipCount) bounds the silhouette. At rotation 0
        // this is byte-identical to the previous AABB form.
        const _pbHalfW = _pbCx * node.Width * 0.5 * d;
        const _pbHalfH = _pbCy * node.Height * 0.5 * d;
        const pblur: ProgressiveBlurParams = {
          Rect: { X: _pbPivotX - _pbHalfW, Y: _pbPivotY - _pbHalfH, W: _pbHalfW * 2, H: _pbHalfH * 2 },
          Cos: matCos(eff), Sin: matSin(eff), PivotX: _pbPivotX, PivotY: _pbPivotY,
          Scene: sceneSnap, // reuse the snapshot we took for ComputeBlur
          Pyramid: lastBackdrop,
          MaxLod: maxLod,
          Direction: { ToTop: 0, ToBottom: 1, ToLeft: 2, ToRight: 3 }[node.RenderStyle.ProgressiveBlurDirection] ?? 0,
          Feather: feather,
          Easing: Math.max(0.001, node.RenderStyle.ProgressiveBlurEasing),
          Stops: node.RenderStyle.ProgressiveBlurStops,
          Opacity: node.EffectiveOpacity,
          Background: node.RenderStyle.Background.Color,
          // A progressive blur samples anyway, so a vibrancy on one always folds (Core/Vibrancy.ts).
          Grading: {
            ...FoldVibrancy(node.RenderStyle.BackdropBrightness, node.RenderStyle.BackdropContrast, VibrancyGraded(node)),
            Saturation: node.RenderStyle.BackdropSaturation,
          },
          ClipOffset: clipMeta.Offset,
          ClipCount: clipMeta.Count,
        };
        if (this._bcOn) this._bcNotePblur(pblur);
        if (!this._diagNoPblurDraw) r.DrawProgressiveBlur(pblur);
        this._counts.PBlur++;

      } else if (((_isGlass(material) && node.RenderStyle.Refraction !== 0) || _hasBackdropFilter(node)) && material !== 'ProgressiveBlur' && !this._diagNoGlass) {
        // ── The glass FILL ──
        // A glass slab (Glass set, Thickness > 0 → Material LiquidGlass) only takes the glass FILL
        // pipeline (refraction + backdrop sampling) when it actually has a glass-fill
        // effect to show: a non-zero Refraction, or a backdrop frost/grade. A slab with
        // Refraction 0 and no backdrop has nothing to refract or frost, so its FILL renders
        // as a plain (solid) panel here. The rim is its own draw either way.
        // Flush pending batches: same reason as pblur — backdrop-filter
        // panels (glass or flat) read the scene (indirectly via the blur
        // pyramid), so the scene must be current. Flat panels with
        // non-default BackdropBrightness/Saturation/Contrast/FrostBlur go
        // through this same path — the shader branches on materialType
        // to skip refraction/CA for them, but they still need the
        // pyramid bound to sample.
        flushPanels();
        flushText();
        // Glass samples only `u_Backdrop` (the blur pyramid), never the raw
        // scene — so there's no feedback loop and we can feed ComputeBlur
        // the scene FBO's texture directly, zero blits.
        //
        // Build the pyramid OVER just the panel's sample region (panel rect plus the frost's own
        // spread), and AT that size: level 0 comes back
        // region-sized and the handle carries the map from screen UV into it.
        //
        // Two costs come off together. Fragment fill drops from full-canvas to panel-sized
        // (20-50× for localized glass like TabBar/ToolbarDropdown), which a scissor already
        // bought. The attachment does NOT come off with a scissor: a tile-based GPU has no
        // partial render area, so every pass on a canvas-sized level 0 pays a full 16.4MB load
        // and store however tight the scissor is. Sizing the attachment to the region is what
        // takes that away — and it is the larger half. Same texels, same device density.
        const d = this._dpr;
        // Everything this surface's pyramid needs — region, radius, depth, base LOD — comes from
        // ONE resolver, because `?blur-first`'s pre-pass builds the same pyramid from the same
        // numbers and a second copy of them is a second pyramid wearing this one's name.
        //
        // Build the backdrop blur at THIS panel's actual frost sigma so the
        // panel can sample LOD 0 (full resolution). Previously level 0 held
        // only a ~1px Gaussian and a panel reached its real frost by sampling
        // a high mip LOD (8pt frost -> LOD 3 -> 1/8 res), which made frosted
        // backdrops read as a low-res texture upscaled. The dual filter still
        // downsamples internally for speed then upsamples back to full res,
        // and the pyramid is only as large as the panel's region, so cost stays bounded.
        // The margin is `_glassFillBlurPlan`'s: the refraction bends inward, so only the frost's
        // spread reaches past the box.
        const plan = this._glassFillBlurPlan(node, eff, effH, w, h);
        const frostCssPx = plan.FrostCssPx;
        const margin = plan.Margin;
        const px = plan.Px, py = plan.Py, pw = plan.Pw, ph = plan.Ph;
        const region = plan.Region;
        if (this._consoleProfilingEnabled && this._surfFrame === 90) {
          // eslint-disable-next-line no-console
          console.log(`[Jaui.surf] GLASS rect=${Math.round(pw)}x${Math.round(ph)} region=${region.w}x${region.h} (${(region.w * region.h / 1e6).toFixed(2)}Mpx) frost=${frostCssPx}pt margin=${Math.round(margin)}`);
        }
        // The mip depth has to know whether the adaptive shadow will read the pyramid at its own
        // detail LOD, and the measure pass runs after the pyramid is built — so the plan resolves it.
        const _rsAdaptiveShadow = plan.AdaptiveShadow;
        // ── Card composite (Perf/SceneRaw.Finding.md 4(c)) ──
        // Everything from here to the end of this node's subtree -- the pyramid, the fill, the
        // children, the edge -- paints into a region-sized target seeded with the frame
        // snapshot and replayed over with the earlier surfaces that reach into it, instead of into
        // the scene. The scene's render encoder therefore ends ONCE a frame (at the snapshot)
        // rather than twice per glass surface, and every later touch of it is a blit.
        //
        // The region has to contain everything the subtree paints, not just this node's box: the
        // same `_subtreeMaxPaintMargin` the layer cache uses, which is the same bound and the same
        // limitation (a child positioned wholly OUTSIDE the parent's box is not covered by either).
        if (!this._sharedBackdrop && !this._capturing && r2 instanceof WebGL2Renderer
            && !this._subtreeHasUnretargetable(node)) {
          const _cardPaint = this._subtreeMaxPaintMargin(node) * d;
          cardOpen = r2.BeginCardComposite(px, py, pw, ph, margin, _cardPaint, _cardPaint);
        }
        // Snapshot the raw scene BEFORE the pyramid overwrites anything.
        // The shader's sampleBackdrop falls back to this raw texture when
        // the effective LOD is 0 (no-frost flat panel, or the center of
        // a glass panel with frost=0) — avoids picking up the pyramid's
        // baked-in 1px base Gaussian. SnapshotScreen reuses an internal
        // texture so there's no per-frame allocation. Scissor the blit to this
        // glass panel's footprint + margin (same rect the blur uses) — the
        // shader only samples the snapshot within the panel, so a full-canvas
        // copy was pure wasted bandwidth scaling with screen size. A panel that
        // DID author frost never reaches that fallback at all, so it takes no
        // snapshot — see the else branch.
        let sceneSnap: GpuTextureHandle | null;
        // The deepest level the backdrop this surface reads was built to; unbounded for its own.
        let backdropLodCap = Infinity;
        // `?scene-restarts` / `?small-restarts`: whether THIS surface built a fill pyramid on this
        // line rather than taking a pre-built one. The insertion point below needs to know, and
        // the build sits inside a branch whose locals do not survive it.
        let fillBuilt = false;
        // An active lens builds from the scene under the lifted content its parent copied, never a shared one.
        const below = lensBelow !== null && lensBelow.Lens === node ? lensBelow.Handle : null;
        const lensItems = lensBelow !== null && lensBelow.Lens === node ? lensBelow.Items : null;
        if (this._sharedBackdrop) {
          // ── Shared backdrop (fire once, sample many) ──
          // Build ONE sharp-root pyramid per frame and let every glass surface
          // sample it at its own frost LOD (frost-as-LOD — exactly how the pblur
          // path already runs). Rebuild only when the scene changed under THIS
          // surface's footprint since the last build (fresh content / glass over
          // glass); otherwise reuse — no per-surface snapshot, blur, or mipmap.
          let needRebuild = !this._sharedPyramidValid;
          if (!needRebuild) {
            // Reuse unless this surface's sample rect overlaps something drawn
            // into the scene since the pyramid was built (fresh content / glass
            // over glass). Per-rect test — a coarse union AABB over-triggered.
            const sx1 = region.x + region.w, sy1 = region.y + region.h;
            const dr = this._sceneDirtyRects;
            for (let i = 0; i < dr.length; i += 4) {
              if (region.x < dr[i + 2] && sx1 > dr[i] && region.y < dr[i + 3] && sy1 > dr[i + 1]) { needRebuild = true; break; }
            }
          }
          if (needRebuild) {
            // One sharp-root pyramid into a DEDICATED pass (pblur/border can't
            // clobber it). Depth covers the heaviest frost expressed as a LOD;
            // `_maxFrostBlur` is the largest BackdropFrostBlur in the tree, scanned
            // pre-walk, and BuildSharedBackdrop self-clamps to the pyramid's level count.
            const _tShared = performance.now();
            this._sharedPyramid = r.BuildSharedBackdrop(w, h, Math.log2(Math.max(1, this._maxFrostBlur * d)));
            this._opMs.Blur += performance.now() - _tShared;  // shared build folds snap+blur+mip into one number
            this._counts.SharedBuilds++;
            this._sharedPyramidValid = true;
            this._sceneDirtyRects.length = 0;  // snapshot captured the scene-so-far; start fresh
          }
          lastBackdrop = this._sharedPyramid;
          sceneSnap = this._sharedPyramid;  // level 0 doubles as the low-frost fallback (u_Scene)
          lastBaseFrostLod = 2;             // quarter-res shared pyramid: its level 0 ≈ a full-res pyramid's LOD 2
        } else {
          // ── The raw-scene snapshot, only when the shader can actually read it ──
          // `sampleBackdrop` falls back to u_Scene ONLY where `frostLod < 0.01 &&
          // extraLod < 0.01` — a panel that authored no frost at all. Any frosted
          // panel (every glass class in the app) never touches that sampler, so the
          // blit was a region-sized copy of the scene made for nobody. The adaptive
          // shadow DOES need a sharp read, but it runs with its own 1x1 target bound,
          // so it can sample the live scene texture directly — same pixels, no copy.
          const instFrostLod = plan.InstFrostLod;
          const _tSnap = performance.now();
          // The active lens reads the scene as it stood under its lifted items (`below`), unblurred, at its
          // BackdropView's capture scale (Jiv.Panel.frag, lensCapture).
          sceneSnap = below !== null ? below : instFrostLod < SCENE_TAP_FROST_LOD ? r.SnapshotScreen(region) : null;
          this._opMs.Snap += performance.now() - _tSnap;
          // See the rim site: a snapshot is a scene READ and stays in the walk, so under
          // `?blur-phased` it is an extra encoder end AND a different scene state than this
          // surface's own pyramid. 0 on `glass-grid` and `idle`; non-zero voids the arm.
          if (sceneSnap !== null && this._phasedWalk) this._phasedStrays.Snaps++;
          // Pyramid is built AT this panel's frost sigma, so the base LOD is the panel's own
          // frostLod: the shader's main sample (lod = frostLod - u_BaseFrostLod) lands on LOD 0
          // (full res). Only the subtle glass rim/inner boost (≲ 2 LODs) climbs into the now
          // full-sigma mip chain. `plan.MaxLod` is how deep a chain this panel can actually read
          // — `_backdropMaxLod`, floored by the adaptive shadow's own detail LOD.
          lastBaseFrostLod = plan.BaseFrostLod;
          // `?blur-first`: this surface's fill pyramid was built before the bed's first draw, so
          // the build is a lookup and the scene target was never unbound here — which is why the
          // `RebindSceneTarget` below stays inside the branch that actually left it.
          const preFill = this._blurFirst || this._phasedWalk ? this._blurFirstFill.get(node) : undefined;
          // Inside a scroll edge: the strip's own pyramid, when this surface's sample region lies within
          // it. The strip's level n is a Gaussian about 2^n device px wide over a raw level 0, and the
          // surface reads it at its OWN frost, undimmed: Apple's bar keeps the content under it as sharp
          // as its frost (0.4 to 0.9pt), whatever the strip around it blurs to. A frost-0 surface reads
          // the raw scene snapshot, which the strip has since dimmed, so it builds its own.
          const edgeFill = below === null && edgeBackdrop !== null && plan.InstFrostLod >= SCENE_TAP_FROST_LOD
            && _regionContains(edgeBackdrop.Region, region) ? edgeBackdrop : null;
          // `?glass-group`: THE GROUP'S BACKDROP, AND THE POINT IT IS CAPTURED AT.
          //
          // This line is the whole of the law in the walk. The FIRST member of a group to reach it
          // builds one pyramid over the union of the group's regions, from the live scene, before
          // any member has painted; every later member finds the handle already there and paints
          // its body, rim and shadow in exactly the order it does today. So nothing painted inside
          // the group is ever in the group's backdrop, and a group the walk enters LATER captures
          // a scene that already holds the earlier group's glass -- which is the half of the old
          // separation law the ruling kept, obtained for free from the walk's own ordering rather
          // than from a check.
          //
          // It is asked BEFORE `preFill` rather than after, and the flag parse refuses
          // `?blur-first` and `?blur-phased` by name, so the two can never both answer.
          const groupFill = below === null && this._glassGroup ? this._glassGroupTake(node, region, w, h, dt) : null;
          if (groupFill !== null) {
            lastBackdrop = groupFill;
            // `?blur-cache`: a group's pyramid is built over the union of its members at the first
            // one, and this cache does not key it. Its members' pixels are therefore called changed
            // every frame -- correct, and printed as `grouped=` so a page that groups is not read as
            // a page the cache failed on.
            if (this._bcOn) { this._bc.Fresh('group'); this._bcStats.Grouped++; }
          } else if (edgeFill !== null) {
            lastBackdrop = edgeFill.Handle;
            const level = Math.min(edgeFill.MaxLod, Math.log2(Math.max(1, frostCssPx * d)));
            // The shader reads `frostLod - u_BaseFrostLod`, so the base is what lands it on `level`.
            lastBaseFrostLod = plan.InstFrostLod - level;
            backdropLodCap = edgeFill.MaxLod;
            // `?blur-cache`: the strip's pyramid is keyed to the strip, not to this surface, so this
            // surface's pixels are called changed every frame, as a glass group's members are.
            if (this._bcOn) this._bc.Fresh('edge');
          } else if (below === null && preFill !== undefined) {
            lastBackdrop = preFill;
            this._blurFirstStats.Used++;
          } else {
            if (this._blurFirst || this._phasedWalk) this._blurFirstStats.Missed++;
            const presample = this._mayPresample(plan);
            const separable = this._maySeparable(plan);
            lastBackdrop = this._bcBuild(node, READER_FILL, region, plan.Radius, plan.MaxLod, presample, separable, w, h, () => {
              const _tBlur = performance.now();
              const built = r.ComputeBlur(below ?? r.SceneTexture, w, h, plan.Radius, undefined, region, presample, separable);
              const _tMip = performance.now();
              this._opMs.Blur += _tMip - _tBlur;
              r.GenerateBlurMipmap(plan.MaxLod);
              this._opMs.Mip += performance.now() - _tMip;
              // `?scene-restarts` / `?small-restarts`: this build's insertion point is taken BELOW,
              // after the adaptive-shadow measure, and this flag is how it knows a build happened
              // here. See the call site for why it is not taken on this line. A `?blur-cache` hit
              // builds nothing and takes no point.
              fillBuilt = true;
              return built;
            });
            r.RebindSceneTarget();
          }
        }

        // Adaptive shadow: read the backdrop this surface just sampled, under its own footprint.
        // The sharp tap comes from the snapshot when one was taken, and otherwise straight from the
        // scene texture — this pass renders into its own 1x1 state target, so the scene FBO is not
        // bound and there is no feedback loop to dodge.
        let shadowBackdrop: ShadowBackdrop | undefined;
        const _rs = node.RenderStyle;
        const _shadowScene = sceneSnap ?? r.SceneTexture;
        const preShadow = this._phasedWalk ? this._phasedShadow.get(node) : undefined;
        // `?shadow-probe=group`: measured at the group's capture, beside its one build. See
        // `_shadowProbe` for why that reads the same texels the probe below would read here.
        const groupShadow = this._shadowProbe === 'group' ? this._groupShadow.get(node) : undefined;
        if (groupShadow !== undefined) {
          const gr = groupShadow.Rect;
          if (gr.x !== px || gr.y !== py || gr.w !== pw || gr.h !== ph) this._shadowProbeStats.Moved++;
          shadowBackdrop = { Slot: groupShadow.Slot };
          this._shadowProbeStats.Grouped++;
          this._adaptiveShadowsDrawn = true;
        } else if (preShadow !== undefined) {
          // `?blur-phased`: measured in the build phase, beside this surface's own build, where the probe's
          // `shadow-state` bind rides the end the build already paid. Here, in pass 2, the scene is
          // bound and a draw has landed since the last end, so probing would END the scene encoder
          // once per card -- the exact count the flag exists to remove. Same rect, same detail LOD,
          // same pyramid, same sharp tap; see `_phasedShadow` for why that is pixel-neutral here.
          shadowBackdrop = preShadow;
          this._adaptiveShadowsDrawn = true;
        } else if (_rsAdaptiveShadow && lastBackdrop) {
          const detailLod = Math.min(backdropLodCap, Math.log2(Math.max(frostCssPx, SHADOW_DETAIL_MIN_PT) * d) - lastBaseFrostLod);
          // The reading is provably last frame's only when the blur cache just called this surface's
          // fill clean AND the probe reads the same rect at the same level; otherwise it is unknown.
          const last = this._probeLast.get(node);
          const sameRect = last !== undefined && last.x === px && last.y === py && last.w === pw && last.h === ph && last.Lod === detailLod;
          this._probeLast.set(node, { x: px, y: py, w: pw, h: ph, Lod: detailLod });
          const inputsSame = this._bcOn && this._bcFillClean === node && sameRect;
          const slot = r.MeasureShadowBackdrop(node, { x: px, y: py, w: pw, h: ph }, detailLod, lastBackdrop, _shadowScene, dt, inputsSame);
          if (slot >= 0) {
            shadowBackdrop = { Slot: slot };
            this._adaptiveShadowsDrawn = true;
          }
        }

        // `?scene-restarts` / `?small-restarts`: THE FILL BUILD'S INSERTION POINT, and it is here
        // rather than on the `RebindSceneTarget()` above because of what stands between the two.
        //
        // The instant is the same one in every respect that matters: a build has handed the scene
        // target back, the scene's encoder has ended, and NOTHING has been drawn into the scene
        // since -- the adaptive-shadow probe draws into its own 1x1 state target, not the scene.
        // What changes is what comes NEXT. Taken above, the scene arm's opening draw leaves the
        // scene dirty at `MeasureShadowBackdrop`, whose 1x1 bind rides the build's end for free at
        // baseline: every point then bought a SECOND encoder end (`shadow-state`) and turned the
        // probe's read into a SECOND restart. That is exactly the M4's `switches=100 restarts=60
        // endsByKey=...,shadow-state:20` against a spec of 80 / 40 / no new key. Taken here, the
        // shadow measure has already read and already bound, the added end is the only change, and
        // the counters come out 40+N / 40 / 60 with `shadow-state` absent as at baseline.
        //
        if (fillBuilt && this._restartRenderer !== null) this._restartRenderer.DiagRestartPoint();

        // THE SHADOW IS ITS OWN DRAW, in the flat program, and the surface's quad stops at its face.
        // Drawn after the pyramid was built, so the backdrop never holds the surface's own shadow, and
        // before the surface, which covers the shadow under its face exactly as the one-draw composite
        // did. The expensive program then shades only the fragments it can light.
        r.EnableBlend();
        r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
        // Glass casts Apple's shadow whatever it authored (Core/Glass.md): black from the flat program, or,
        // from 64 pt, the backdrop past its outline, read from its own pyramid by the glass program.
        const glassShadow = _isGlass(material) ? this._glassShadowPeak(node, eff) : 0;
        if ((_isGlass(material) ? glassShadow > 0 : _rs.ShadowColor.A > 0.001) && !JivInstanceBuffer.DiagNoShadow) {
          this._panelBuffer.Begin();
          this._panelBuffer.Push(node, this._dpr, eff, clipMeta.Offset, clipMeta.Count, xformIndex, 'Normal', null, 'Only');
          const colored = this._panelBuffer.Data[38] > 1.5;
          r.PanelBeginBatch();
          r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
          if (colored) r.PanelDrawBatch(w, h, lastBackdrop, lastBaseFrostLod, true, sceneSnap, undefined, shadowBackdrop);
          else r.PanelDrawBatch(w, h, null, 0, false, null);
          this._counts.Panels++;
        }
        this._panelBuffer.Begin();
        this._panelBuffer.Push(node, this._dpr, eff, clipMeta.Offset, clipMeta.Count, xformIndex, ownBorderMode, null, 'Excluded');
        r.PanelBeginBatch();
        r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
        // Always use the MATERIAL_GLASS variant for any standalone panel
        // that needs the pyramid path. Material is *inferred* from Thickness
        // (Glass set and Thickness > 0 → 'LiquidGlass', else 'None'), so during a press →
        // resting transition the inferred Material flips the moment Thickness
        // crosses zero — and every effect gated by `materialType == 1.0`
        // (rim glow, hemispherical light, catchlight, rim spec) vanishes in
        // one frame. Using GLASS unconditionally keeps the variant fixed
        // across the transition; the rim/inner effects fade smoothly via
        // their own physical drivers (FresnelStrength, EdgeLight*, glassiness
        // = smoothstep(thickness)) so MATERIAL_GLASS at Thickness=0 produces
        // the same output MATERIAL_NONE would have. The cost of this on
        // flat-with-filter panels is one extra cheap branch in the shader.
        // Use MATERIAL_GLASS only for real glass. Plain-Jiv panels with just a
        // backdrop filter (BackdropFrostBlur / Brightness / Saturation / Contrast)
        // need MATERIAL_NONE so the shader's `else if (hasBackdropFilter)` fill
        // branch runs — that branch composites the Jiv's Background tint over
        // the filtered backdrop. The MATERIAL_GLASS variant constant-folds
        // materialType=1.0 and always takes `fillRgb = backdrop`, silently
        // discarding the tint. (The Thickness=0 stability argument above only
        // applies to elements whose Material flips between LiquidGlass and None;
        // for plain Jivs the material is statically 'None', no flip to protect.)
        // Glass panels with a non-Color Background (Image / Gradient) flow
        // through the same single-instance draw — the panel shader's fill
        // composite reads from the bound texture / gradient stops instead
        // of v_Tint when u_BgMode != 0. Border, refraction, frost, rim
        // spec all keep working.
        const glassBgPaint = this._computeBgPaint(node);
        // `?blur-cache`: the draw's inputs that are not instance floats. The adaptive shadow is the one
        // the CPU cannot see: its state texel eases toward a GPU-side reading every rendered frame, and
        // nothing reports whether it moved. So a surface that draws one is called changed every frame
        // over its own quad -- a local refusal, narrower than disarming the cache.
        if (this._bcOn) {
          this._bcNoteBgPaint(glassBgPaint);
          const sig = this._bc.Sig;
          sig.Number(lastBaseFrostLod);
          sig.Word(sceneSnap !== null ? 1 : 0);
          sig.Word(_isGlass(material) ? 1 : 0);
          // The probe DECLARES whether its texel moved (`Shadow.Texel`): fresh, snapped, or an ease step
          // that can reach half an LSB. Only a moved texel makes the record fresh; a still one is the
          // same input as last frame, and the slot in the signature carries the rest.
          if (shadowBackdrop !== undefined) {
            sig.Number(shadowBackdrop.Slot);
            if (!(r instanceof WebGL2Renderer) || r.ShadowTexelMoved(node)) this._bc.Fresh('shadow');
          }
        }
        const _tDraw = performance.now();
        if (!(this._diagNoGlassDraw && _isGlass(material))) {
          r.PanelDrawBatch(w, h, lastBackdrop, lastBaseFrostLod, _isGlass(material), sceneSnap, glassBgPaint, shadowBackdrop, lensItems);
        }
        this._opMs.Draw += performance.now() - _tDraw;
        if (_isGlass(material)) this._counts.Glass++;
        if (_isGlass(material) && shadowBackdrop !== undefined) rimSlotHere = shadowBackdrop.Slot;
        closesEdge = true;
        // Only glass that tracks its backdrop can take an appearance its theme does not have.
        if (_isGlass(material) && shadowBackdrop !== undefined
            && JivGlassSpanOf(node, eff) <= GLASS_TRACKS_LUMA_SPAN) glassInkHere = shadowBackdrop.Slot;
        else this._counts.Panels++;
        if (glassBgPaint && glassBgPaint.Mode === 'Image') this._counts.Image++;
        // Reset the shared panel buffer so this glass instance isn't picked
        // up by the next flushPanels() and drawn AGAIN as a non-glass panel
        // (null backdrop → dummy black texture → glass goes solid gray).
        // The glass path shares `_panelBuffer` with non-glass batching for
        // code simplicity; we just have to return it to count=0.
        this._panelBuffer.Begin();

      } else {
        // Non-glass panel. Background.Kind decides batching:
        //   • Color   → accumulate into the shared batch with everyone else
        //                (one draw call per coherent run of Color panels).
        //   • Image / Gradient → flush the current Color batch, draw THIS
        //                panel as a single-instance batch with bgPaint
        //                bound, then keep accumulating. The panel shader
        //                still does border/shadow/clip — image is just
        //                another fill mode, not a separate draw pipeline.
        flushText();
        // `?occlusion`: the pre-pass ruled on this fill before the walk started. A `Skip` emits
        // nothing at all; a `Carve` emits the pieces the cover left behind, into the same batch,
        // in the same z-slot, from the same style. Two `size` checks so an unarmed frame pays two
        // integer compares per panel and no hash lookup.
        const occPlan = this._occlusionPlan;
        const occ = occPlan.size === 0 ? undefined : occPlan.get(node);
        if (this._occlusionCoverers.size !== 0 && this._occlusionCoverers.has(node)) {
          this._occlusionStats.CoverersSeen++;
        }
        if (occ !== undefined) {
          this._occlusionStats.Missed--;
          // A withheld IMAGE still keeps its load and its cross-fade clock: the hero swaps the
          // hidden photo's URL while the other covers it, and a fade that only started when it was
          // revealed would flash the placeholder. `_computeBgPaint` is where both live.
          if (occ.Kind === 'Skip' && node.RenderStyle.Background.Kind === 'Image') this._computeBgPaint(node);
          if (occ.Kind === 'Carve') {
            if (node.RenderStyle.Background.Kind === 'Image') {
              flushPanels();
              this._emitCarvedImage(node, eff, occ.Pieces, clipMeta.Offset, clipMeta.Count, ownBorderMode, w, h);
            } else {
              this._emitCarvedFill(node, eff, occ.Pieces, clipMeta.Offset, clipMeta.Count, ownBorderMode);
            }
          }
        } else if (!this._diagNoPanels) {
        // `?emptypanels`: a panel with a fully transparent background, no painted border and no
        // shadow shades every fragment of its quad to `result.a` exactly 0, and the blend leaves
        // the destination bit-identical. The instance is withheld and NOTHING ELSE is: layout, hit
        // testing, this node's CLIP contribution (the clip stack is encoded above, into a separate
        // buffer, and travels with its CHILDREN's instances), its children, its text, its SVG, the
        // shared-backdrop dirty tracking and the scene-footprint note all run exactly as before.
        // The walk's order does not move -- a withheld instance takes an instanced draw's count
        // from n to n-1 and never reorders the n-1 that remain.
        //
        // `ownBorderMode` cannot be 'Suppress' here: that mode is gated on `_hasPaintedBorder`,
        // which needs a non-zero BorderWidth, which this rule refuses.
        //
        // Per node this is a handful of comparisons on style the walk has already resolved -- no
        // pre-pass, no second traversal, no allocation, and the flag's own boolean short-circuits
        // it before any of them on the `off` arm.
        const empty = this._emptyPanelCull && this._isEmptyPanel(node);
        if (empty) {
          this._emptyPanelStats.Panels++;
          this._emptyPanelStats.Px += this._emptyPanelQuadPx(node, eff, effH, flushW, flushH);
          // A gradient fill would have taken the single-instance path below, and that path opens
          // with `flushPanels()`. Keep that batch BOUNDARY and drop only the draw: this lever is
          // allowed to remove an instance, not to merge two batches that were separate.
          if (node.RenderStyle.Background.Kind !== 'Color') flushPanels();
        } else {
        const flatBgPaint = this._computeBgPaint(node);
        if (flatBgPaint !== undefined || blend !== null) {
          // A gradient or image fill draws alone because its paint is a batch uniform; an element
          // an element whose ink ADDS draws alone because its blend state is. One path for both.
          if (flatBgPaint !== undefined) this._bcNoteBgPaint(flatBgPaint);
          flushPanels();
          this._panelBuffer.Begin();
          this._panelBuffer.Push(node, this._dpr, eff, clipMeta.Offset, clipMeta.Count, xformIndex, ownBorderMode);
          r.EnableBlend();
          if (blend !== null) r2.SetVibrancyBlend(blend);
          r.PanelBeginBatch();
          r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
          r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
          r.PanelDrawBatch(w, h, null, 0, false, null, flatBgPaint);
          if (blend !== null) { r2.RestoreBlend(); r2.NoteBlendDraw(); }
          this._counts.Panels++;
          if (flatBgPaint !== undefined && flatBgPaint.Mode === 'Image') this._counts.Image++;
          this._panelBuffer.Begin();
        } else {
          // `ownBorderMode` travels with the BATCHED instance too. It was omitted here, so
          // a Color-background node with a non-zero BorderLayer kept its border on the
          // fused panel AND got the overlay — the rim composited twice. Border mode is
          // per-instance data, so it costs the batch nothing.
          this._panelBuffer.Push(node, this._dpr, eff, clipMeta.Offset, clipMeta.Count, xformIndex, ownBorderMode);
        }
        }
        }
      }

      // Emit this node's text into the shared text batch. We do NOT flush
      // here — the buffer stays alive across siblings so contiguous text
      // nodes coalesce into one draw call. A subsequent category change
      // (panel push, glass, pblur, image, or end of walk) calls
      // `flushText()` which drains whatever's accumulated.
      //
      // Z-order: before accumulating text, flush any pending panels so
      // panels earlier in tree order end up BEHIND this text.
      const anim = this._textAnimators.get(node);
      if (phasedPaints && anim && anim.Words.length > 0 && node.Visible && node.Width > 0 && node.Height > 0) {
        flushPanels();
        // The INK's blend, which is NOT the panel's: `TextFilter: Vibrancy()` moves this one and leaves
        // `zones.Ink` null, so the fill keeps covering.
        const inkBlend = zones.TextInk;
        if (inkBlend === null) {
          this._emitTextFor(node, eff, clipMeta.Offset, clipMeta.Count, xformIndex, 1);
        } else {
          // Its own batch, because the blend state is per draw; `flushText()` first drains other nodes'
          // glyphs under the ordinary blend, so the vibrancy state cannot leak onto a sibling's text.
          flushText();
          this._emitTextFor(node, eff, clipMeta.Offset, clipMeta.Count, xformIndex, zones.TextScale);
          r2.SetVibrancyBlend(inkBlend);
          flushText();
          r2.RestoreBlend();
          r2.NoteBlendDraw();
          // Counted where the ink was drawn, and only when the TEXT zone supplied the blend.
          const t = TextVibrancy(node.RenderStyle);
          if (VibrancyIsActive(t.Amount, t.Cover)) this._vibrancyStats.TextInk++;
        }
      }

      // Emit this node's vector SVG (tessellated fills) as immediate draws. Like
      // glass/image, it flushes the pending panel + text batches first so z-order
      // stays coherent (prior siblings behind, later siblings in front).
      const svgVec = node.SvgVector;
      if (phasedPaints && svgVec && (svgVec.Fills.length > 0 || svgVec.Strokes.length > 0)
          && node.Visible && node.Width > 0 && node.Height > 0 && node.EffectiveOpacity > 0.001) {
        flushPanels();
        flushText();
        this._emitSvgFor(node, eff, flushW, flushH);
        flushText(); // drain SVG <text> glyphs the emit pushed, on top of its fills/strokes
      }

      // Shared-backdrop dirty tracking: this node has now committed to the
      // scene FBO, so fold its footprint into the since-build dirty union — a
      // later glass surface that overlaps it must rebuild rather than reuse a
      // pyramid taken before this drew. Runs after the material branch above,
      // so a glass surface never sees its OWN footprint when it checks reuse.
      // Only a glass/pblur/backdrop-filter surface's OUTPUT is fresh content a
      // LATER glass surface must rebuild for (genuine glass-over-glass). Opaque
      // panels, text, and the field are baked into the pyramid at build time
      // (the build snapshots the scene-so-far), so pushing THEIR footprints
      // forced a near-per-surface rebuild for nothing — the documented dirty
      // bug. Push only the surfaces whose result lands after the build.
      if (phasedPaints && this._sharedBackdrop
          && (_isGlass(material) || material === 'ProgressiveBlur' || _hasBackdropFilter(node))) {
        const dab = this._nodeAabb(node, eff, effH);
        const dpr = this._dpr;
        this._sceneDirtyRects.push(dab.minX * dpr, dab.minY * dpr, dab.maxX * dpr, dab.maxY * dpr);
      }

      // ── What this node committed DIRECTLY to the scene ──
      // The card composite can replay an earlier SURFACE out of its own target; it cannot replay a
      // plain panel, a line of text, a stroke or an SVG, because those went straight into the scene
      // and nothing else holds them. A later surface whose region reaches into one of these has to
      // re-cut the frame snapshot, which is one real encoder end -- so the push has to be honest
      // and it has to be tight. The shared-backdrop push above is deliberately NOT this: it skips
      // opaque content on purpose, which is exactly wrong here.
      //
      // Tight, because a container with a transparent background covers the page and would make
      // every surface on it fall back for nothing: only a node that can actually put ink down
      // counts -- a visible background, a painted border, or a shadow.
      if (phasedPaints && !this._capturing && r2 instanceof WebGL2Renderer && !r2.CardActive) {
        const _fs = node.RenderStyle;
        const _fbg = _fs.Background;
        const _inked = node.EffectiveOpacity > 0.001 && (
          (_fbg.Kind !== 'Color' || _fbg.Color.A > 0.001)
          || shapeBuilds0 >= 0
          || _fs.ShadowColor.A > 0.001
          || this._hasPaintedBorder(node)
          || (this._textAnimators.get(node)?.Words.length ?? 0) > 0
          || !!node.SvgVector
        );
        if (_inked) {
          const _fab = this._nodeAabb(node, eff, effH);
          const _fm = this._subtreeMaxPaintMargin(node);
          const _fd = this._dpr;
          r2.NoteSceneFootprint(
            (_fab.minX - _fm) * _fd, (_fab.minY - _fm) * _fd,
            (_fab.maxX + _fm) * _fd, (_fab.maxY + _fm) * _fd,
          );
        }
      }

      if (shapeBuilds0 >= 0) this._vibrancyStats.Builds += r2.PyramidBuilds - shapeBuilds0;

      if (this._bcOn) this._bc.Close();

      // Walk children in Layer order (ties break by tree order). A scroll edge hands its pyramid
      // to its subtree's glass for the length of the subtree.
      const outerEdge = edgeBackdrop;
      if (edgeHere !== null) edgeBackdrop = edgeHere;
      else if (closesEdge) edgeBackdrop = null;
      const outerInk = glassInk;
      const outerRimSlot = rimSlot;
      rimSlot = rimSlotHere;
      if (glassInkHere >= 0) {
        flushText();
        glassInk = { Slot: glassInkHere, Dark: node.RenderStyle.SchemeDark };
        r2.SetGlassInk(glassInk.Slot, glassInk.Dark);
      }
      descendChildren(node, eff, stack, scope, effH, childPersp);
      if (glassInkHere >= 0) {
        flushText();
        glassInk = outerInk;
        r2.SetGlassInk(outerInk.Slot, outerInk.Dark);
      }
      edgeBackdrop = outerEdge;
      rimSlot = outerRimSlot;

      // Close the card composite. The pending batches drain FIRST: anything still buffered belongs
      // to this subtree and would otherwise be flushed into the scene by the next category
      // boundary, landing on top of the write-back instead of inside it.
      if (cardOpen) {
        flushPanels();
        flushText();
        (r2 as WebGL2Renderer).EndCardComposite();
      }
    };

    // THE LENS'S LIFTED CONTENT (Jwift/Apple/LiquidGlass.md 7.1): UIKit's liftedContentPortalView, a portal of the
    // bar's items -- the same layers drawn a second time, where they lie (matches position and transform), into the
    // lens's glass. Here the items (the lens's siblings from Layer 1 up to the lens's own) are drawn into their own
    // canvas-sized layer, transparent elsewhere, which the lens reads through its SDF warp. The originals still draw
    // in the bar; the lens covers them, as Apple's DestOutView erases them.
    const liftLensItems = (bar: Jiv, lens: Jiv, stack: ClipStack, boxClip: ClipShape, m: Mat2x3, mh: Mat3x3 | null, persp: PerspCtx | null): GpuTextureHandle | null => {
      // Logged when the line changes, and every 30th pass regardless, so silence means the pass did not run.
      const trace = (line: string): void => {
        if (!this._lensTrace) return;
        this._lensTraceCount++;
        if (line === this._lensTraceLast && this._lensTraceCount % 30 !== 0) return;
        this._lensTraceLast = line;
        console.info(`[lens-trace] #${this._lensTraceCount} ` + line);
      };
      if (this._capturing) { trace('no twins: inside a layer-cache capture'); return null; }
      if (!(this._renderer instanceof WebGL2Renderer)) { trace('no twins: renderer is not WebGL2'); return null; }
      const cgl = this._renderer.GetGL();
      if (!cgl) { trace('no twins: no GL context'); return null; }
      flushPanels();
      flushText();
      const fbo = this._lensItems ??= new Framebuffer(cgl);
      fbo.Resize(w, h);
      fbo.Bind();
      cgl.viewport(0, 0, w, h);
      cgl.clearColor(0, 0, 0, 0);
      cgl.clear(cgl.COLOR_BUFFER_BIT);
      const savedW = flushW, savedH = flushH;
      flushW = w; flushH = h;
      const scope: TeleportScope = { Deferred: [], Stack: stack };
      this._capturing = true;
      // Each item scaled about its own centre as the lens lifts (UIKit's selected twins, LensLiftedScale). The twins
      // are the lens's portal, which takes the bar's model transform and not its flex swell (a presentation
      // modifier), so the bar's own VisualScale is taken back out of their matrix.
      const scale = 1 + (lens.RenderStyle.LensLiftedScale - 1) * lens.RenderStyle.Lens;
      const bs = bar.RenderStyle;
      const sx = bs.VisualScaleX, sy = bs.VisualScaleY;
      const px = bar.X + bar.Width * bs.VisualOriginX, py = bar.Y + bar.Height * bs.VisualOriginY;
      const unswell: Mat2x3 = [1 / sx, 0, 0, 1 / sy, -(px * (1 - sx) + bs.VisualTranslateX) / sx, -(py * (1 - sy) + bs.VisualTranslateY) / sy];
      const mTwin = matMul(m, unswell);
      const mhTwin = mh !== null ? mat3Mul(mh, mat3FromAffine(unswell)) : null;
      let drawn = 0;
      const skipped: string[] = [];
      for (const item of this._orderedChildren(bar)) {
        const layer = item.RenderStyle.Layer;
        if (item === lens) continue;
        if (layer < 1 || layer >= lens.RenderStyle.Layer || item.TeleportSeq !== 0) {
          if (this._lensTrace) skipped.push(`layer ${layer}${item.TeleportSeq !== 0 ? ' teleported' : ''}`);
          continue;
        }
        drawn++;
        const cx = item.X + item.Width * 0.5, cy = item.Y + item.Height * 0.5;
        const lift: Mat2x3 = [scale, 0, 0, scale, cx * (1 - scale), cy * (1 - scale)];
        renderNode(item, matMul(mTwin, lift), this._childClip(bar, stack, boxClip, item), scope,
          mhTwin !== null ? mat3Mul(mhTwin, mat3FromAffine(lift)) : null, persp);
      }
      replayScope(scope);
      flushPanels();
      flushText();
      this._capturing = false;
      trace(`twins: ${drawn} drawn at scale ${scale.toFixed(3)} under lens layer ${lens.RenderStyle.Layer}, swell ${sx.toFixed(3)} x ${sy.toFixed(3)}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`);
      flushW = savedW; flushH = savedH;
      this._renderer.RebindSceneTarget();
      return this._renderer.WrapTexture(fbo.Texture);
    };

    // Retained-mode layer cache. Capture a stable subtree into its own FBO once,
    // then composite that texture over the live field each frame. Defined after
    // renderNode so it can drive a nested capture walk; the hook inside
    // renderNode calls it. Both only run from the root call below, so the mutual
    // reference resolves at call time.
    const r2 = this._renderer as WebGL2Renderer;
    const compositeOrCapture = (cnode: Jiv, ceff: Mat2x3, cstack: ClipStack): void => {
      const cgl = r2.GetGL();
      if (!cgl) return;
      const dpr = this._dpr;
      // Painted AABB (device px): the subtree's box union expanded by the
      // subtree's max shadow/border overhang so nothing is clipped at the box
      // edge. We DON'T translate the captured geometry — instead the panel/text
      // shaders project through u_ViewOffset = AABB origin, so v_PixelPos stays
      // true screen space and the screen-space clip stack matches verbatim.
      const box = this._nodeAabb(cnode, ceff, null);
      const margin = this._subtreeMaxPaintMargin(cnode);
      const aabbLpx = (box.minX - margin) * dpr;
      const aabbTpx = (box.minY - margin) * dpr;
      const adx = Math.floor(aabbLpx);
      const ady = Math.floor(aabbTpx);
      const adw = Math.max(1, Math.ceil((box.maxX + margin) * dpr) - adx);
      const adh = Math.max(1, Math.ceil((box.maxY + margin) * dpr) - ady);

      // Drain pending main-walk batches first so z-order holds (earlier siblings
      // land behind this composite).
      flushPanels();
      flushText();

      let entry = this._layerCache.get(cnode);
      if (!entry) { entry = { Fbo: new Framebuffer(cgl), Valid: false, DX: adx, DY: ady, DW: adw, DH: adh }; this._layerCache.set(cnode, entry); }

      this._counts.CacheComp++;
      if (!entry.Valid || entry.DW !== adw || entry.DH !== adh || entry.DX !== adx || entry.DY !== ady) {
        this._counts.CacheCap++;
        // ── Capture: render the subtree into its FBO at screen coords, with the
        // projection retargeted to the AABB sub-window via u_ViewOffset. ──
        entry.Fbo.Resize(adw, adh);
        entry.Fbo.Bind();
        cgl.viewport(0, 0, adw, adh);
        cgl.clearColor(0, 0, 0, 0);
        cgl.clear(cgl.COLOR_BUFFER_BIT);
        r2.SetCaptureViewOffset(adx, ady);
        const savedW = flushW, savedH = flushH;
        flushW = adw; flushH = adh;
        const capScope: TeleportScope = { Deferred: [], Stack: cstack };
        this._capturing = true;
        renderNode(cnode, ceff, cstack, capScope, null, null);
        replayScope(capScope);
        flushPanels();
        flushText();
        this._capturing = false;
        flushW = savedW; flushH = savedH;
        r2.SetCaptureViewOffset(0, 0);
        // Restores the target AND its viewport -- the canvas's, or the card sub-window's when a
        // composite is open around this subtree. The explicit `viewport(0, 0, w, h)` that used to
        // follow was the canvas's unconditionally, which is the one case that is now wrong.
        r2.RebindSceneTarget();
        entry.Valid = true; entry.DX = adx; entry.DY = ady; entry.DW = adw; entry.DH = adh;
      }

      // ── Composite: the cached texture over the scene FBO at its screen AABB.
      // The captured FBO holds PREMULTIPLIED colour (rendered over transparent
      // with EnableBlend's coverage-alpha), so composite with premultiplied over
      // (ONE, 1−SRC_ALPHA) — exact, no edge fringe. GL viewport is bottom-left
      // origin; ady is from the top, so flip it.
      cgl.enable(cgl.BLEND);
      cgl.blendFunc(cgl.ONE, cgl.ONE_MINUS_SRC_ALPHA);
      r2.BlitTextureRegion(entry.Fbo.Texture, adx, h - ady - adh, adw, adh);
      r2.RebindSceneTarget();
      this._counts.Panels++;
    };

    this._textBuffer.Begin();
    this._clipBuffer.Begin();
    this._xformBuffer.Begin();
    this._panelBuffer.Begin();
    // Populate _maxFrostBlur from the live tree before the render walk. It
    // sizes the Gaussian mip chain GenerateBlurMipmap builds (Jaui.ts ~1020
    // `glassMaxLod = log2(_maxFrostBlur) + 2`). If left at 0, glassMaxLod
    // caps at 2 and only mips 1..3 get the proper Dual-Filter Gaussian —
    // any sample at deeper LOD falls through to the GL driver's box-filter
    // mipmap, which collapses high-frequency content (UI chrome layered into
    // the scene FBO) to a flat mean. That's why plain-Jiv BackdropFrostBlur
    // panels at high Layer values rendered as a uniform color regardless of
    // the authored blur radius.
    this._maxFrostBlur = 0;
    this._scanFrostBlur(this.Root);
    // The card composite builds each surface's pyramid from a REGION-SIZED source, and
    // `ResolveRegionRect` snaps a pyramid's origin to the downsample grid in its INPUT's coordinate
    // space. Aligning every card's origin to the deepest grid any pyramid in this frame can ask for
    // is what makes that snap land on the same absolute texels it would against the canvas -- the
    // difference between a crop and a resample. `_maxFrostBlur` is the largest BackdropFrostBlur in
    // the tree, already scanned above, and `Jaui.ts` floors a surface's own sigma at 1pt.
    if (this._renderer instanceof WebGL2Renderer) {
      this._renderer.SetCardGrid(this._renderer.CardGridPhaseFor(Math.max(1, this._maxFrostBlur) * this._dpr));
    }
    // `?blur-first` (MEASUREMENT ONLY - WRONG PIXELS). Every pyramid the walk below would build,
    // built HERE instead: the last point in the frame that is still ahead of every panel draw.
    // Ahead of the janvas pre-pass would be ahead of a foreign renderer's draws too, but a janvas
    // draws into the scene through raw GL that this ledger cannot see, so the honest place is
    // after it — and no scene in the perf harness has one.
    if (this._blurFirst && !this._diagNoUi) this._blurFirstPrepass(w, h);
    // `?glass-group` (DEFAULT OFF, DIFFERENT PIXELS). Which glass surfaces are SIBLINGS in one
    // container, and what one pyramid over each such run would be. It builds nothing here -- the
    // capture is at the group's first member, inside the walk -- so this is arithmetic over a
    // traversal and no GL at all. Inert and skipped entirely when the flag is off.
    if (this._glassGroup && !this._diagNoUi) this._glassGroupPrepass(w, h);
    // `?occlusion` (DEFAULT ON, SAME PIXELS). Which opaque fills the walk below is about to emit
    // for nothing, decided here because a coverer is later in paint order than what it covers and
    // the walk cannot know it at the moment it would push P. Inert and ~free when the flag is off.
    this._occlusionPrepass(w, h);
    // `?emptypanels` (DEFAULT ON, SAME PIXELS). Reset beside the occlusion pre-pass and not in
    // one, because this lever HAS no pre-pass: a panel that paints nothing is a property of that
    // panel alone, with no dependency on any other node, so the decision is taken at the emission
    // site from style the walk has already resolved.
    this._emptyPanelStats.Panels = 0;
    this._emptyPanelStats.Px = 0;
    this._vibrancyStats.Authored = 0;
    this._vibrancyStats.Inherited = 0;
    this._vibrancyStats.IgnoredSampling = 0;
    this._vibrancyStats.TextInk = 0;
    this._vibrancyStats.Under = 0;
    this._vibrancyStats.Graded = 0;
    this._vibrancyStats.Builds = 0;
    // NOT CascadeVisited / CascadeCarried: the vibrancy cascade runs EARLIER in this same frame (beside
    // _cascadeFilterGrade), so it resets its own two counters at its call site. Zeroing them here
    // would erase the reading before anything printed it.
    this._vibrancyStats.PanelBatches = 0;
    this._vibrancyStats.Refused = {};
    const rootScope: TeleportScope = { Deferred: [], Stack: EmptyClipStack };
    if (this._phasedWalk && !this._diagNoUi) {
      // THE PHASED COMPOSITION, run for `?blur-phased` and for the DEFAULT `?pyramid-atlas` alike
      // -- one traversal shape, so the two arms differ in the atlas and in nothing else and the
      // atlas's pixels can be gated against the phased arm's on the same build.
      //
      // `?blur-phased` (MEASUREMENT ONLY - DIFFERENT PIXELS). The same tree, five passes, THREE
      // scene encoders instead of one per build and one per draw. See `_blurPhased` for the shape
      // and for the pixel change it makes; the encoder arithmetic, on the ledger's own rules:
      //
      //   pass 1        the bed draws            -> the scene holds tiles nothing has resolved
      //   build fills   read 1 ENDS encoder A    -> reads 2..20 find the flag already clear: free
      //   probes        `shadow-state` binds     -> free, the build's end is still uncleared
      //   rebind        `'scene'` is not a switch by definition                       -> encoder B
      //   pass 2        fills, their children and their rims draw
      //   present       ends B, and `NoteFrameEndDrain` does not count it
      //
      // So `SceneSwitches` reads 1 with `EndsByKey { blur: 1 }` against one per build at baseline,
      // while every build still happens.
      this._blurFirstFill.clear();
      this._blurFirstKeys.clear();
      this._phasedShadow.clear();
      this._phasedStrays.Snaps = 0;
      this._phasedStrays.Pblur = 0;
      const ast = this._atlasStats;
      ast.Atlases = 0; ast.Members = 0; ast.Solo = 0; ast.Refused = 0; ast.Bytes = 0; ast.Sizes = '';
      this._atlasSizes.clear();
      const pst = this._blurFirstStats;
      pst.Fill = 0; pst.Used = 0; pst.Missed = 0; pst.Dup = 0; pst.Coarse = 0;
      const phase = (pass: 1 | 2): void => {
        this._phasedPass = pass;
        rootScope.Deferred = [];
        renderNode(this.Root, MAT_IDENTITY, EmptyClipStack, rootScope);
        replayScope(rootScope);
        // Drain before the next phase: a batch still pending when the next phase starts drawing
        // would land in that phase's z-order instead of this one's.
        flushPanels();
        flushText();
      };
      this._phasedStop = false;
      this._phasedStarted = false;
      phase(1);
      this._blurPhasedBuild(w, h);
      this._phasedShadowProbes(dt);
      r.RebindSceneTarget();
      phase(2);
      this._phasedPass = 0;
    } else if (!this._diagNoUi) renderNode(this.Root, MAT_IDENTITY, EmptyClipStack, rootScope);
    // In-flight teleports with no layered ancestor paint last at root level.
    replayScope(rootScope);
    // Trailing flushes — catch anything deferred since the last category
    // boundary. Order: panels first (they were pushed earlier in tree
    // order than the trailing text, if any).
    flushPanels();
    flushText();
    // Every draw that can land in a later surface's backdrop has been recorded: the card write-backs
    // below are blits of what the walk already drew, and the janvas masks run after every reader.
    this._bcEndFrame();

    // `?blur-first`'s gate, on the trace channel. Printed when the SHAPE changes rather than every
    // frame: a line per frame would drown the channel, and a line only on the first frame would
    // miss a walk that starts disagreeing with the pre-pass once something animates. `missed` is
    // the one that must read 0 — see `_blurFirstStats`.
    if (this._blurFirst) {
      const st = this._blurFirstStats;
      const line = `jaui:blur-first prebuilt=${st.Fill}`
        + ` used=${st.Used} missed=${st.Missed} dup=${st.Dup}`
        + ` chains=${st.Chains} sizes=${st.Keys} coarse=${st.Coarse} pixels=WRONG`;
      if (line !== this._blurFirstLastLine) { this._blurFirstLastLine = line; JTrace(line); }
    }

    // `?blur-phased`'s gate, on the same terms as `?blur-first`'s: printed on a SHAPE CHANGE, and
    // `missed` is the one that must read 0. `switches` is read HERE rather than taken on faith,
    // because it is the whole claim of the flag and it is available before the present that would
    // otherwise be the frame's last word on it. `snaps` and `pblur` are the two things that make an
    // arm incomparable -- both 0 on `glass-grid` and `idle` -- and a non-zero one is an instruction
    // to discard the cell, not a warning to weigh.
    if (this._blurPhased) {
      const st = this._blurFirstStats;
      // The ledger lives on the WebGL2 renderer, not on the `Renderer` interface, and it is read
      // HERE rather than after the present because the present ends the frame's last encoder and
      // this line is about the ones the WALK ended.
      const sw = this._renderer instanceof WebGL2Renderer ? this._renderer.SceneSwitches : -1;
      // The pool, on the gate line rather than only on the `?trace`-gated census. Twenty fill
      // pyramids have to be ALIVE when their cards draw in pass 2, so this flag's pixels depend on
      // the rotation the way nothing before it did: at `1/1/1` nineteen fills were overwritten
      // before they were sampled and every card drew the last build's pyramid through its own
      // region map -- which is exactly the arm `Perf/BlurPhased.Finding.md` marked WRONG. Must
      // read `20/20/40`; anything else is an instruction to discard the cell.
      const pool = this._renderer instanceof WebGL2Renderer ? this._renderer.BlurPoolCensus : 'none';
      const line = `jaui:blur-phased built=${st.Fill}`
        + ` used=${st.Used} missed=${st.Missed} dup=${st.Dup}`
        + ` chains=${st.Chains} sizes=${st.Keys} coarse=${st.Coarse}`
        + ` shadows=${this._phasedShadow.size} snaps=${this._phasedStrays.Snaps}`
        + ` pblur=${this._phasedStrays.Pblur}`
        + ` pool=${pool} switches=${sw} pixels=DIFFERENT`;
      if (line !== this._phasedLastLine) { this._phasedLastLine = line; JTrace(line); }
    }

    // `?pyramid-atlas`'s gate, on the same terms as the two above: a SHAPE change, not a frame.
    //
    // `solo` and `refused` are what make this line worth printing. A plan that atlased nothing
    // would read `atlases=0 members=0 solo=40` and pass every timing comparison by having done
    // nothing -- the vacuous-success shape this ledger has been bitten by before -- so the counts
    // are printed together and `members + solo` must equal `built`. `refused` is the subset of
    // `solo` the ADMISSION test turned away (a mip consumer, a k > 1 surface, or a region that
    // does not contain its own draw's taps) as against members a full atlas could not take.
    //
    // `missed` must read 0.
    if (this._pyramidAtlas && !this._diagNoUi) {
      const st = this._blurFirstStats;
      const a = this._atlasStats;
      const sw = this._renderer instanceof WebGL2Renderer ? this._renderer.SceneSwitches : -1;
      const dr = this._renderer instanceof WebGL2Renderer ? this._renderer.SceneAtlasDraws : -1;
      const line = `jaui:pyramid-atlas built=${st.Fill}`
        + ` used=${st.Used} missed=${st.Missed}`
        + ` atlases=${a.Atlases} members=${a.Members} solo=${a.Solo} refused=${a.Refused}`
        // `draws` is the ENGINE's count of the draws the atlas builds issued, and it is on this
        // line because the harness's `drawCalls` cannot see one. Under `inst=on` it must read
        // `2 x depth` per atlas and under `inst=off` `2 x depth x members`.
        + ` draws=${dr} inst=${this._atlasInstanced ? 'on' : 'off'}`
        + ` bytes=${Math.round(a.Bytes / (1024 * 1024) * 10) / 10}MB sizes=${a.Sizes === '' ? 'none' : a.Sizes}`
        + ` shadows=${this._phasedShadow.size} snaps=${this._phasedStrays.Snaps}`
        + ` pblur=${this._phasedStrays.Pblur}`
        + ` switches=${sw} pixels=DIFFERENT`;
      if (line !== this._atlasLastLine) { this._atlasLastLine = line; JTrace(line); }
    }

    // `?glass-group`'s gate, on the same terms as the three above: a SHAPE change, not a frame.
    //
    // ONE LINE PER GROUP, then the census, because the per-group line is the only place the shape
    // of the grouping is visible: `members=20 rect=2456x1456 k=1 depth=2 fill=5587400` is a page
    // whose twenty cards are one container, and twenty lines reading `members=1` would be the same
    // page with a tree nobody expected. `fallbacks` beside `members` is the vacuous-success guard
    // this ledger keeps needing: an arm reading `groups=0 members=0 fallbacks=20` is the engine
    // this lane inherited wearing the flag's name, and a timing cell quoting it measured nothing.
    // `blur` is the control invariant -- `EndsByKey.blur` must fall from 20 to `groups` on
    // `glass-grid`, with `drawCalls` unmoved.
    if (this._glassGroup && !this._diagNoUi) {
      const st = this._glassGroupStats;
      const gl2 = this._renderer instanceof WebGL2Renderer ? this._renderer : null;
      if (gl2 !== null) gl2.NoteGroupFallback(st.Fallbacks);
      const seen = new Set<GlassGroup>();
      const lines: string[] = [];
      for (const g of this._glassGroups.values()) {
        if (seen.has(g)) continue;
        seen.add(g);
        lines.push(`jaui:glass-group members=${g.Members.length}`
          + ` rect=${g.Plan.RectW}x${g.Plan.RectH} k=${g.Plan.K} depth=${g.Plan.Depth}`
          + ` fill=${g.Plan.Fill} memberFill=${g.Plan.MemberFill}`);
      }
      lines.push(`jaui:glass-group groups=${st.Groups} builds=${st.Builds} members=${st.Members}`
        + ` fallbacks=${st.Fallbacks} solo=${st.Solo} maxLod=${st.MaxLod} unplanned=${st.Unplanned}`
        + ` rects=${st.Rects} why=${st.Why}`
        + ` blur=${gl2 === null ? -1 : (gl2.SceneEndsByKey['blur'] ?? 0)}`
        + ` switches=${gl2 === null ? -1 : gl2.SceneSwitches} pixels=DIFFERENT`);
      const line = lines.join('\n');
      if (line !== this._glassGroupLastLine) {
        this._glassGroupLastLine = line;
        for (const l of lines) JTrace(l);
      }
    }

    // `?shadow-probe`'s gate, on both arms and on a SHAPE change. `probes` against `batches` is the
    // move itself (20 / 20 walked, 20 / 1 grouped on glass-grid); `ends` is the column it exists to
    // move, `EndsByKey['shadow-state']` (19 walked, 0 grouped: the batch's bind lands on the scene
    // the build already ended); `switches` is the frame's scene segments less one. `moved` must read
    // 0, and `grouped` must equal the group's members, or the arm measured something else.
    if (this._glassGroup && !this._diagNoUi && this._renderer instanceof WebGL2Renderer) {
      const gl2 = this._renderer;
      const sp = this._shadowProbeStats;
      const line = `jaui:shadow-probe mode=${this._shadowProbe} probes=${gl2.ShadowProbes}`
        + ` batches=${gl2.ShadowProbeBinds} ends=${gl2.SceneEndsByKey['shadow-state'] ?? 0}`
        + ` grouped=${sp.Grouped} moved=${sp.Moved}`
        + ` blur=${gl2.SceneEndsByKey['blur'] ?? 0} switches=${gl2.SceneSwitches}`;
      if (line !== this._shadowProbeLastLine) {
        this._shadowProbeLastLine = line;
        JTrace(line);
      }
    }

    // `?glass-skip`'s gate, on the same terms as the ones above: a SHAPE change, not a frame (a
    // static page prints it once; a line per frame would read the same numbers sixty times).
    //
    // `draws` and `frags` are the control invariant -- the same on every arm as on `none`, because
    // every arm draws the same draws over the same quads. `taps` is the armed count and `full` the
    // same frame's count with nothing skipped, so a stage that removed its taps reads below `full`
    // and one that removed nothing (a gate no fragment reaches) reads equal to it. `face`, `band`,
    // `border`, `skirt` and `cut` are the regions the stages live in, for the per-fragment reading.
    if (this._glassSkip !== null && this._renderer instanceof WebGL2Renderer) {
      const c = this._renderer.GlassCensus;
      const mask = this._glassSkip;
      const names = GlassSkipNames(mask);
      const line = `jaui:glass-skip mask=${mask} stages=${names.length === 0 ? 'none' : names.join(',')}`
        + ` draws=${this._renderer.GlassDraws} instances=${c.Instances}`
        + ` frags=${c.Frags} face=${c.Face} band=${c.Band}`
        + ` skirt=${c.Skirt} cut=${c.Cut} ca3=${c.Ca3}`
        + ` taps=${c.Taps} full=${c.TapsFull} clipFetches=${c.ClipFetches}`
        + ` projective=${c.Projective}`
        + ` pixels=${mask === 0 ? 'SAME' : 'DIFFERENT'}`;
      if (line !== this._glassSkipLastLine) { this._glassSkipLastLine = line; JTrace(line); }
    }

    // `?occlusion`'s gate, on the same terms: a SHAPE change, not a frame.
    //
    // `coverers=<planned>/<seen>` and `missed=` are the two that must hold, and they are printed
    // rather than inferred because they are the only way the pre-pass and the walk can be caught
    // disagreeing about which nodes paint. `planned != seen`, or `missed != 0`, means a verdict was
    // taken on a tree the walk did not paint -- a pixel bug, not a slow frame. `px=` is the effect
    // field: device pixels of fill withheld this frame, which on a bed of a page fill under six
    // opaque bands is the page fill minus the rows its bands feather across.
    if (this._occlusion && !this._diagNoUi) {
      const st = this._occlusionStats;
      const notes = OcclusionNotesLine(st.Notes);
      // `px` is quantised to a tenth of a megapixel HERE and nowhere else. A bed that slides moves
      // its seams a fraction of a pixel a frame, so the exact count breathes and a line keyed on
      // it would print every frame instead of on a change of shape. The exact number is on the
      // `[Jaui]` census and on `__jauiOcclusion()`, which is where a cell should read it.
      const line = `jaui:occlusion panels=${st.Skipped + st.Carved} px=${(st.Px / 1e6).toFixed(1)}M`
        + ` skipped=${st.Skipped} carved=${st.Carved} pieces=${st.Pieces}`
        + ` candidates=${st.Candidates} coverers=${st.Coverers}/${st.CoverersSeen}`
        + ` missed=${st.Missed} reads=${st.Reads} nodes=${st.Nodes}`
        // `vacuous=1` says the pre-pass had something to rule on and withheld nothing, and the
        // notes say which clause did it. Both are printed on EVERY line, zeros included, for the
        // reason the restart probes print `skipped*=0`: a 0-px pixel gate reads the same on a
        // lever that fired perfectly and on one that never fired at all, and this lane exists
        // because a whole measurement phase could not tell those apart.
        + ` vacuous=${st.Vacuous}`
        + (notes !== '' ? ' ' + notes : '');
      if (line !== this._occlusionLastLine) { this._occlusionLastLine = line; JTrace(line); }
    }
    // `?emptypanels`'s gate, on the same terms: a SHAPE change, not a frame. `px` is quantised to
    // a tenth of a megapixel for exactly the reason the occlusion line's is -- a bed that slides a
    // fraction of a pixel a frame moves the exact count and a line keyed on it would print every
    // frame. The exact number is on the `[Jaui]` census and on `__jauiEmptyPanels()`.
    if (this._emptyPanelCull && !this._diagNoUi) {
      const line = `jaui:emptypanels panels=${this._emptyPanelStats.Panels}`
        + ` px=${(this._emptyPanelStats.Px / 1e6).toFixed(1)}M`;
      if (line !== this._emptyPanelLastLine) { this._emptyPanelLastLine = line; JTrace(line); }
    }

    // VIBRANCY's gate, on a SHAPE change. `builds=` is the claim: an under-drawn shape draw costs one
    // draw and two blend switches and NO build. `refused=` names every graded reason.
    if (!this._diagNoUi && this._renderer instanceof WebGL2Renderer) {
      const line = VibrancyGateLine(this._vibrancyCensus());
      if (line !== this._vibrancyLastLine) { this._vibrancyLastLine = line; JTrace(line); }
    }

    // `?glass-presample`'s gate, on the same terms: a SHAPE change, not a frame.
    //
    // `builds=` FIRST, and `k=` beside it. `builds=0` under the flag is the unflagged engine
    // wearing the flag's name -- the plan refused every surface -- and it is the reading that a
    // timing cell would otherwise pass by having done nothing. `blur=` is the control invariant:
    // the arm removes no BUILD, so it must read exactly what the off arm reads (40 on
    // `glass-grid`); a number that moved means this arm is measuring something else as well.
    if (this._glassPresample && !this._diagNoUi && this._renderer instanceof WebGL2Renderer) {
      const gl2 = this._renderer;
      const line = `jaui:glass-presample builds=${gl2.PresampledBuilds} k=${gl2.LastPresampleK}`
        + ` blur=${gl2.SceneEndsByKey['blur'] ?? 0} switches=${gl2.SceneSwitches}`
        + ` reads=${gl2.SceneReads} restarts=${gl2.SceneRestarts}`
        + ' pixels=DIFFERENT';
      if (line !== this._glassPresampleLastLine) { this._glassPresampleLastLine = line; JTrace(line); }
    }

    // `?glass-gaussian`'s gate, on the same terms: a SHAPE change, not a frame.
    //
    // `builds=` FIRST, for the reason the presample gate prints it first: `builds=0` under the
    // flag is the unflagged engine wearing the flag's name, and `planRefused=` beside it names
    // WHICH of `PlanGaussian`'s clauses produced that. `totalPasses=` is the effect field the
    // whole hypothesis test is read against -- 40 on `glass-grid` where the twenty chains it
    // replaced issued 80 -- and it is a column of its own because `blur=` (`EndsByKey.blur`)
    // books one encoder end per BUILD, not per pass, so it reads 20 on BOTH arms by design and a
    // pass prediction quoted against it would be reading a column this lever cannot move.
    if (this._glassGaussian !== 'off' && !this._diagNoUi && this._renderer instanceof WebGL2Renderer) {
      const gl2 = this._renderer;
      const tmp = gl2.GaussTempCensus;
      const line = `jaui:glass-gaussian armed=${this._glassGaussian}`
        + ` builds=${gl2.GaussianBuilds} passes=${GAUSS_PASSES}`
        + ` totalPasses=${gl2.GaussianPasses}`
        + ` sigma=${gl2.LastGaussianSigma} fetches=${gl2.LastGaussianFetches}`
        + ` blur=${gl2.SceneEndsByKey['blur'] ?? 0} switches=${gl2.SceneSwitches}`
        + ` reads=${gl2.SceneReads} restarts=${gl2.SceneRestarts}`
        + ` temps=${tmp.Count}:${tmp.Sizes}:${tmp.Mb}MB`
        + ` tempCover=${tmp.CoverWritten}/${tmp.CoverReadable}`
        + (this._gaussDebug ? ` debugClears=${tmp.DebugClears}` : '')
        + ` planRefused=${gl2.LastGaussianRefusal === '' ? 'none' : gl2.LastGaussianRefusal}`
        + ' pixels=DIFFERENT';
      if (line !== this._glassGaussianLastLine) { this._glassGaussianLastLine = line; JTrace(line); }
    }

    // THE BLUR PLAN'S GATE, on a SHAPE change. Both sides on one line, so a cell reads the default
    // and its `?blur-chain=on` control in the same columns: builds, passes (per frame, and per
    // build), destination px (`fill=`) and bilinear fetches (`texelsRead=`), then every class's
    // shape (k, authored and target sigma, residual, fetches), the refusals, the target pool and
    // WHERE the frame's blur draws went. `passesPerFrame=` is the number this lane moves.
    if (!this._diagNoUi && this._renderer instanceof WebGL2Renderer) {
      const c = this._renderer.BlurPlanCensus;
      const per = (p: number, b: number): string => (b === 0 ? '0' : (Math.round(p / b * 100) / 100).toString());
      const line = `jaui:blur-plan armed=${this._blurSeparable ? 'separable' : 'chain'}`
        + ` passesPerFrame=${c.SepPasses + c.ChainPasses}`
        + ` builds=${c.SepBuilds} passes=${c.SepPasses} passesPerBuild=${per(c.SepPasses, c.SepBuilds)}`
        + ` texelsRead=${c.SepReads} fill=${c.SepFill}`
        + ` chainBuilds=${c.ChainBuilds} chainPasses=${c.ChainPasses}`
        + ` chainPassesPerBuild=${per(c.ChainPasses, c.ChainBuilds)}`
        + ` chainTexelsRead=${c.ChainReads} chainFill=${c.ChainFill}`
        + ` classes=${c.Classes}`
        + ` blurDraws=${c.DrawsTotal}(${c.Draws})`
        + ` targets=${c.Targets} tempCover=${this._renderer.GaussTempCensus.CoverWritten}/${this._renderer.GaussTempCensus.CoverReadable}`
        // `?blur-temp`'s effect field, on the line that prints while rendering rather than on the
        // arm-time mark where a counter would read 0 for ever. `clears=0` under `=clear` means the
        // arm never reached a bound target, so its pixel reading says nothing.
        + ` temp=${this._blurTemp}${this._blurTemp === 'clear' ? ` clears=${c.TempClears}` : ''}`
        + ` planRefused=${c.Refused}`
        // THE EXTENT CENSUS. `distinctExtents=` is level-0 sizes (chains the pass must hold, against
        // `chainPool=` resident/max); `extentAllocs=` is what the builds themselves allocated, and
        // `resizes=` / `firstAllocs=` / `mipAllocs=` every texture allocation in the frame so far. A
        // distinct size costs a re-allocation only if these move: on a steady frame whose sizes fit
        // the pools they read 0 whatever `distinctExtents=` says.
        + ` distinctExtents=${c.DistinctExtents} extents=${c.Extents} extentAllocs=${c.ExtentAllocs}`
        + ` resizes=${c.Resizes} firstAllocs=${c.FirstAllocs} mipAllocs=${c.MipAllocs}`
        + ` chainPool=${c.ChainPool} extentSnap=${RegionExtentSnap.Unit} surfaces=${c.Surfaces}`;
      if (line !== this._blurPlanLastLine) { this._blurPlanLastLine = line; JTrace(line); }
    }

    // Every card target still holding a region of the frame lands in the scene now. The drain is
    // blits, in walk order, each a blend-disabled replace of exactly the bytes the scene would have
    // held -- see the card-composite section in `WebGL2.Renderer`. Anything that draws directly
    // into the scene before this point has already triggered it through `_noteSceneDraw`.
    if (this._renderer instanceof WebGL2Renderer) {
      this._renderer.FlushCardComposites();
      this._renderer.RebindSceneTarget();
    }

    // Apply deferred janvas clip masks. Wiping scene FBO pixels outside the
    // nearest Overflow:Hidden ancestor's rounded rect — done now, after
    // every in-tree consumer has read the scene, so pblur/glass blur
    // pyramids see foreign content (not zeroed corners) while the
    // presented frame still respects the visual clip.
    if (this._pendingJanvasMasks.length > 0 && this._renderer instanceof WebGL2Renderer) {
      const gl = this._renderer.GetGL();
      if (gl) {
        const gl2r = this._renderer;
        gl2r.RebindSceneTarget();
        gl.viewport(0, 0, w, h);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.STENCIL_TEST);
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
        gl.disable(gl.BLEND);
        for (const m of this._pendingJanvasMasks) {
          gl2r.DrawClipMask(m.drawX, m.drawY, m.drawW, m.drawH, m.clipX, m.clipY, m.clipW, m.clipH, m.radius, m.smoothness);
        }
        gl2r.InvalidateStateCache();
      }
    }

    // Final composite: the whole frame lives in sceneFbo. `PresentScene`
    // does a hardware `blitFramebuffer` from sceneFbo into the swap chain —
    // 2-3× faster than the old shader-based Blit(SceneTexture) path on
    // integrated GPUs, and can fuse with InvalidateFrameTransients on
    // tile-based mobile renderers (scene never leaves tile memory).
    // Headless: there is no swap chain — the scene stays in `_sceneFbo` for the caller to sample
    // (SceneGLTexture). Skip present + the transient discard (the caller reads the scene texture this frame).
    // `?scene-restarts` / `?small-restarts`: close the frame. It EMITS NOTHING here -- it rolls the
    // spread's denominator, reports the frame's shortfall on the gate and counts the frame for the
    // census. It used to pay the balance on this line, where the walk has been drawing into the
    // scene all frame, so the balance probe ENDED a live encoder and booked `restart-probe:1` at an
    // instant that is not an insertion point. See `WebGL2Renderer.DiagRestartFrameEnd`.
    if (this._restartRenderer !== null) this._restartRenderer.DiagRestartFrameEnd();
    if (!this._headless) {
      r.PresentScene();
      this._ffPresented = true;
      if (_firstFrameHook) { const hook = _firstFrameHook; _firstFrameHook = null; hook(); }
      // Screenshot capture: read the freshly-presented swap chain BEFORE the
      // transient discard below (the back buffer isn't preserved between frames).
      if (this._pendingCapture) {
        const cb = this._pendingCapture;
        this._pendingCapture = null;
        void r.CapturePng().then(cb);
      }
      // Tell the driver we don't need the default framebuffer's depth or the
      // scene FBO's color for the rest of this frame. On tile-based mobile
      // GPUs this discards the tile memory instead of writing it back to
      // main memory — real bandwidth win on iPad / Android.
      r.InvalidateFrameTransients();
    }

    r.EndShadowBackdropFrame();
    r.EndFrame();
  };

  private _cascadeOpacity = (node: Jiv, parentOp: number): void => {
    // Root is a framework-managed container — its RenderStyle resolves
    // Opacity: 'Presence' to 0 (no Presence in seed context, never
    // spring-animated). Treat it as fully opaque so descendants aren't
    // multiplied by 0.
    const eff = node === this.Root ? 1 : parentOp * node.RenderStyle.Opacity;
    node.EffectiveOpacity = eff;
    for (const child of node.Children) this._cascadeOpacity(child as Jiv, eff);
  };

  /** VIBRANCY's cascade. `CascadeVibrancy` holds the algebra; this is the walk. Writes
   *  `EffectiveVibrancy` and `EffectiveVibrancyAuthored` (only an authored one emits a shape draw). */
  private _cascadeVibrancy = (node: Jiv, parent: VibrancyValue | null): void => {
    const rs = node.RenderStyle;
    const r = CascadeVibrancy(rs.VibrancyDeclaration, parent, node === this.Root, rs.Isolate);
    node.EffectiveVibrancy = r.Self;
    node.EffectiveVibrancyAuthored = r.Authored;
    this._vibrancyStats.CascadeVisited++;
    if (r.Self !== null) this._vibrancyStats.CascadeCarried++;
    for (const child of node.Children) this._cascadeVibrancy(child as Jiv, r.ToChildren);
  };

  private _cascadeFilterGrade = (
    node: Jiv,
    parentB: number,
    parentS: number,
    parentC: number,
  ): void => {
    const rs = node.RenderStyle;
    // Isolate (or the Root) ignores the ancestor grade and starts fresh, so
    // an isolated subtree is graded only by its own + its own descendants'
    // Filter — the ancestor's grade does not bleed in.
    const base = node === this.Root || rs.Isolate;
    const b = (base ? 1 : parentB) * rs.Brightness;
    const s = (base ? 1 : parentS) * rs.Saturation;
    const c = (base ? 1 : parentC) * rs.Contrast;
    node.EffectiveBrightness = b;
    node.EffectiveSaturation = s;
    node.EffectiveContrast = c;
    for (const child of node.Children) this._cascadeFilterGrade(child as Jiv, b, s, c);
  };

  /** Resolve a Jiv's Background to a BgPaint the renderer can consume.
   *  Returns `undefined` for Color kinds (the default path — the instance
   *  buffer's per-panel tint carries the color). Returns a non-undefined
   *  BgPaint for Image (texture handle + Cover/Contain UV transform) and
   *  for LinearGradient / RadialGradient (direction / center + stops).
   *
   *  Side effects: kicks `ImageCache.LoadUrl` for Image kinds whose
   *  texture isn't yet in cache. While the bitmap is in flight this
   *  returns `undefined`, so the panel renders with v_Tint
   *  (Background.Color = the placeholder baked into the `Url(...)`
   *  expression) — frame paints solid placeholder, no missing-texture
   *  artifact. When the cache fires `OnLoadFinish` the engine kicks a
   *  relayout / re-render and this helper returns the Image BgPaint. */
  /** Cross-fade duration when an Image-Background texture first becomes
   *  Ready, or when a Jiv's image URL swaps to a new Ready texture. The
   *  panel paints `mix(placeholderColor, sampledImage, alpha)` where alpha
   *  ramps linearly from 0 to 1 over this many milliseconds. */
  private static readonly _BG_IMAGE_FADE_MS = 260;
  private readonly _gradientCurves = new WeakMap<object, GradientCurve>();

  private _computeBgPaint = (node: Jiv): BgPaint | undefined => {
    const bg = node.RenderStyle.Background;
    if (bg.Kind === 'Color') return undefined;
    if (bg.Kind === 'Image') {
      let entry = this._imageCache.Get(bg.Url);
      if (!entry) {
        this._imageCache.LoadUrl(bg.Url, this._dpr);
        entry = this._imageCache.Get(bg.Url);
      }
      if (!entry || !entry.Ready) {
        // Texture in flight (or never queued, or failed). Reset the
        // fade-in tracker so the next Ready transition starts a fresh
        // cross-fade from the placeholder color.
        node.BgImageFadeUrl = null;
        node.BgImageWaitUrl = bg.Url;
        return undefined;
      }
      // Cover/Contain UV transform — panelLocal [0..1] × scale + offset → image UV.
      // Cover scales so the image fully covers the panel (excess cropped);
      // Contain scales so the image fits inside (excess panel shows v_Tint).
      const panelAspect = node.Width / Math.max(node.Height, 0.0001);
      const imgAspect = entry.Width / Math.max(entry.Height, 1);
      let scaleX = 1, scaleY = 1;
      if (bg.Fit === 'Cover') {
        if (imgAspect > panelAspect) scaleX = panelAspect / imgAspect;
        else                          scaleY = imgAspect / panelAspect;
      } else {
        if (imgAspect > panelAspect) scaleY = imgAspect / panelAspect;
        else                          scaleX = panelAspect / imgAspect;
      }
      // Fade-in alpha. First sight of a Ready entry for this URL kicks off a fresh fade window ONLY
      // when this node painted the placeholder while it waited; subsequent frames ramp `alpha`
      // toward 1 and request another frame if the fade hasn't settled.
      //
      // A texture that was ALREADY resident shows at alpha 1 on the frame it is asked for. The fade
      // is there to hide a network wait, and a node that never waited never showed a placeholder:
      // fading it in anyway takes whatever was on screen to the flat placeholder color in one frame
      // and climbs back over 260ms. That was the home hero's "doesn't crossfade" on the phone -- a
      // dissolve revealing a layer whose picture had just been handed to it measured 101 -> 0.3 luma
      // in one frame -- and every card that swaps `[image]` to a cached picture flashed the same way.
      const now = performance.now();
      if (node.BgImageFadeUrl !== bg.Url) {
        node.BgImageFadeUrl = bg.Url;
        node.BgImageFadeStartMs = node.BgImageWaitUrl === bg.Url ? now : now - Canvas._BG_IMAGE_FADE_MS;
        node.BgImageWaitUrl = null;
      }
      const elapsed = now - node.BgImageFadeStartMs;
      const alpha = Math.min(1, elapsed / Canvas._BG_IMAGE_FADE_MS);
      if (alpha < 1) this.RequestFrame();
      // Focal crop anchor (CSS object-position). The cropped axis (scale < 1)
      // slides the visible window so the focal point stays framed; offset
      // spans [0, 1-scale], so 0.5 reproduces the legacy centered crop and
      // the extremes still fully cover the panel (no tint bars under Cover).
      return {
        Mode: 'Image',
        Texture: entry.Texture,
        UvScaleX: scaleX,
        UvScaleY: scaleY,
        UvOffsetX: (1 - scaleX) * bg.FocalX,
        UvOffsetY: (1 - scaleY) * bg.FocalY,
        FadeAlpha: alpha,
      };
    }
    // Gradient — fit the smooth curve once per resolved stop list.
    let curve = this._gradientCurves.get(bg.Stops);
    if (!curve) {
      curve = GradientCurveOf(bg.Stops);
      this._gradientCurves.set(bg.Stops, curve);
    }
    if (bg.Kind === 'LinearGradient') {
      // CSS angles: 0deg runs to the top, 90deg to the right, 180deg to the bottom (panel y runs down).
      return { Mode: 'LinearGradient', DirX: Math.sin(bg.AngleRad), DirY: -Math.cos(bg.AngleRad), Curve: curve };
    }
    return { Mode: 'RadialGradient', CenterX: bg.CenterX, CenterY: bg.CenterY, Radius: bg.Radius, Curve: curve };
  };

  // ── `?blur-cache`: the paint records and the decision ─────────────────────────────────────────
  //
  // The mechanism is `Core/Blur.Cache.ts`'s; what lives here is WHERE the walk feeds it. Three kinds
  // of call, and every one is a single boolean when the arm is off:
  //
  //   - a RECORD brackets what one node paints (its own fill, text and SVG; its edge is a second
  //     record), opened after the node's cull and closed before its children walk;
  //   - the two instance FUNNELS (`_bcInstallHooks`) hash every push into the open record, so the
  //     signature is the bytes the GPU is handed and no style property has to be named;
  //   - each BUILD SITE asks `_bcBuild`, which is the only place a pyramid is skipped.

  /** Wrap the two instance funnels and the image cache's in-place upload, once, at construction. A
   *  push with no record open is a paint site the ledger does not know: it calls the whole frame
   *  dirty from that point rather than slipping past, and the gate line prints `untracked=`. */
  private _bcInstallHooks = (): void => {
    const panel = this._panelBuffer;
    const panelPush = panel.Push;
    panel.Push = (jiv, dpr, m, clipOffset = 0, clipCount = 0, xformIndex = -1, borderMode, vibrancyOverride, shadow) => {
      panelPush(jiv, dpr, m, clipOffset, clipCount, xformIndex, borderMode, vibrancyOverride, shadow);
      if (this._bcOn) this._bcNotePanel(clipOffset, clipCount, xformIndex);
    };
    const text = this._textBuffer;
    const textPush = text.Push;
    text.Push = (cmd) => {
      textPush(cmd);
      if (this._bcOn) this._bcNoteText(cmd.ClipOffset, cmd.ClipCount, cmd.XformIndex ?? -1, cmd.Sin ?? 0);
    };
    // A video frame re-uploads under its own key, in place, every frame. Naming the texture here is
    // what lets the card over it rebuild while the image panels beside it do not; the OnLoad hook
    // reads it.
    const images = this._imageCache;
    const loadBitmap = images.LoadBitmap;
    images.LoadBitmap = (key, bitmap) => {
      this._bcUploadTex = images.Get(key)?.Texture ?? null;
      try { loadBitmap(key, bitmap); } finally { this._bcUploadTex = null; }
    };
  };

  /** The clip entries and the homography an instance indexes: the offsets are floats in the instance,
   *  but what they point at is rewritten every frame and is what the fragment actually reads. */
  private _bcNoteClipXform = (clipOffset: number, clipCount: number, xformIndex: number): void => {
    const sig = this._bc.Sig;
    if (clipCount > 0) {
      sig.Floats(this._clipBuffer.Data, clipOffset * CLIP_FLOATS_PER_ENTRY, (clipOffset + clipCount) * CLIP_FLOATS_PER_ENTRY);
    }
    if (xformIndex >= 0) {
      sig.Floats(this._xformBuffer.Data, xformIndex * XFORM_FLOATS_PER_ENTRY, (xformIndex + 1) * XFORM_FLOATS_PER_ENTRY);
    }
  };

  /** A panel instance was pushed. Its quad (`a_Rect`, floats 0..3) is the device AABB it can
   *  rasterize, shadow and border margins included; a projected instance carries its NATURAL box
   *  there instead, and is bounded by the whole canvas. */
  private _bcNotePanel = (clipOffset: number, clipCount: number, xformIndex: number): void => {
    const bc = this._bc;
    if (!bc.IsOpen) { bc.NoteUntracked(); return; }
    const data = this._panelBuffer.Data;
    const at = (this._panelBuffer.Count - 1) * JIV_FLOATS_PER_INSTANCE;
    bc.Sig.Floats(data, at, at + JIV_FLOATS_PER_INSTANCE);
    this._bcNoteClipXform(clipOffset, clipCount, xformIndex);
    if (xformIndex >= 0) bc.ExtendAll();
    else bc.Extend(data[at], data[at + 1], data[at] + data[at + 2], data[at + 1] + data[at + 3]);
  };

  /** A glyph instance was pushed. X/Y/W/H are its device quad; a glyph ROTATED about its pivot, or a
   *  projected one, is bounded by the whole canvas rather than by arithmetic that has to agree with
   *  the text vertex shader's sign convention. */
  private _bcNoteText = (clipOffset: number, clipCount: number, xformIndex: number, sin: number): void => {
    const bc = this._bc;
    if (!bc.IsOpen) { bc.NoteUntracked(); return; }
    const data = this._textBuffer.Data;
    const at = (this._textBuffer.Count - 1) * TEXT_FLOATS_PER_INSTANCE;
    bc.Sig.Floats(data, at, at + TEXT_FLOATS_PER_INSTANCE);
    this._bcNoteClipXform(clipOffset, clipCount, xformIndex);
    if (xformIndex >= 0 || sin !== 0) bc.ExtendAll();
    else bc.Extend(data[at], data[at + 1], data[at] + data[at + 2], data[at + 1] + data[at + 3]);
  };

  /** A draw input that is not an instance float: the image or gradient a panel's fill samples. The
   *  image is named by its texture and by the epochs its uploads bump -- a texture rewritten in place
   *  keeps its identity, so the identity alone would miss a video frame. */
  private _bcNoteBgPaint = (p: BgPaint | undefined): void => {
    if (!this._bcOn) return;
    const bc = this._bc;
    const sig = bc.Sig;
    if (p === undefined) { sig.Word(0); return; }
    if (p.Mode === 'Image') {
      sig.Word(1);
      sig.Number(bc.Id(p.Texture));
      sig.Number(this._bcTexEpochs.get(p.Texture) ?? 0);
      sig.Number(this._bcImageEpoch);
      sig.Number(p.UvScaleX); sig.Number(p.UvScaleY); sig.Number(p.UvOffsetX); sig.Number(p.UvOffsetY);
      sig.Number(p.FadeAlpha);
    } else if (p.Mode === 'LinearGradient') {
      sig.Word(2); sig.Number(p.DirX); sig.Number(p.DirY); sig.Number(bc.Id(p.Curve));
    } else if (p.Mode === 'RadialGradient') {
      sig.Word(3); sig.Number(p.CenterX); sig.Number(p.CenterY); sig.Number(p.Radius); sig.Number(bc.Id(p.Curve));
    } else {
      sig.Word(4);
    }
  };

  /** A progressive blur's draw: every number it hands its shader, and its quad. `Scene` and
   *  `Pyramid` are not hashed -- the reader token `_bcBuild` mixed in already stands for both. */
  private _bcNotePblur = (p: ProgressiveBlurParams): void => {
    const bc = this._bc;
    const sig = bc.Sig;
    const rc = p.Rect;
    sig.Number(rc.X); sig.Number(rc.Y); sig.Number(rc.W); sig.Number(rc.H);
    sig.Number(p.Cos ?? 1); sig.Number(p.Sin ?? 0); sig.Number(p.PivotX ?? 0); sig.Number(p.PivotY ?? 0);
    sig.Number(p.MaxLod); sig.Number(p.Direction); sig.Number(p.Feather); sig.Number(p.Easing);
    sig.Number(p.Opacity);
    sig.Number(p.Background.R); sig.Number(p.Background.G); sig.Number(p.Background.B); sig.Number(p.Background.A);
    sig.Number(p.Grading.Brightness); sig.Number(p.Grading.Saturation); sig.Number(p.Grading.Contrast);
    const stops = p.Stops ?? null;
    sig.Number(stops === null ? -1 : stops.length);
    if (stops !== null) for (const st of stops) { sig.Number(st.Position); sig.Number(st.Value); sig.Number(st.Easing); }
    this._bcNoteClipXform(p.ClipOffset, p.ClipCount, -1);
    if ((p.Sin ?? 0) !== 0) bc.ExtendAll();
    else bc.Extend(rc.X, rc.Y, rc.X + rc.W, rc.Y + rc.H);
  };

  /** An SVG's immediate draws: the element's model matrix and opacity, and each fill's and stroke's
   *  geometry (by identity -- a tessellation is replaced, never rewritten in place), colour and width.
   *  Bounded by the whole canvas: a path can leave its viewBox, and a canvas-wide footprint costs
   *  nothing on the frames the SVG does not change. */
  private _bcNoteSvgDraw = (geometry: object, count: number, rgba: readonly number[], width: number): void => {
    const bc = this._bc;
    if (!bc.IsOpen) { bc.NoteUntracked(); return; }
    const sig = bc.Sig;
    sig.Number(bc.Id(geometry)); sig.Number(count); sig.Number(width);
    for (const v of rgba) sig.Number(v);
    bc.ExtendAll();
  };

  /**
   * THE DECISION, at the one instant a surface would build its pyramid.
   *
   * The reader is evaluated first and its token goes into the open record whatever happens next, so
   * a changed backdrop reaches the damage region for every surface after this one even on the arm
   * that builds anyway. Then exactly one of:
   *
   *   HIT   -- clean, and the slot is still resident: no build. Under `verify` the build runs anyway,
   *            the two level-0s are compared texel for texel, and the FRESH one is bound, so a
   *            mismatch is counted and repaired rather than shown.
   *   COLD  -- clean, nothing cached: build, then copy it into a slot for the next frame.
   *   DIRTY -- build, and the slot (if any) goes invalid without being refilled: a backdrop that
   *            changed this frame is the best predictor that it changes next frame too, and copying
   *            a pyramid every frame of a scroll would make the null this lane cannot win a loss.
   *
   * `build` is the site's own `ComputeBlur` + `GenerateBlurMipmap`, unchanged; the copy rides the
   * encoder end it already paid, and the site's `RebindSceneTarget` follows on every branch.
   */
  private _bcBuild = (
    owner: Jiv, kind: number, region: { x: number; y: number; w: number; h: number },
    radius: number, maxLod: number, presample: boolean, gaussian: boolean, w: number, h: number,
    build: () => GpuTextureHandle,
  ): GpuTextureHandle => {
    if (!this._bcOn) return build();
    const r = this._renderer as WebGL2Renderer;
    const bc = this._bc;
    const key = `build|${region.x},${region.y},${region.w},${region.h}|${radius}|${maxLod}`
      + `|${presample ? 1 : 0}${gaussian ? 1 : 0}|${w}x${h}`;
    const v = bc.Reader(owner, kind, key, GuardedRect(region.x, region.y, region.w, region.h, BLUR_READ_GUARD_PX));
    bc.Sig.Number(v.Token);
    if (kind === READER_FILL) this._bcFillClean = v.Why === 'clean' ? owner : null;
    const st = v.State;
    const stats = this._bcStats;
    stats.Surfaces++;
    const slot = st.Slot !== null && st.Slot.Valid ? st.Slot : null;
    if (v.Why === 'clean' && slot !== null && slot.Handle !== null) {
      stats.Hits++;
      r.NoteBlurCacheHit();
      slot.LastUse = bc.Frame;
      if (this._blurCache !== 'verify') return slot.Handle;
      const fresh = build();
      const texels = r.BlurCacheCompare(slot.Handle, fresh);
      r.NoteBlurCacheVerify(texels !== 0);
      if (texels !== 0) {
        JTrace(`jaui:blur-cache mismatch kind=${kind === READER_FILL ? 'fill' : 'pblur'}`
          + ` node=${bc.Id(owner)} classes=${owner.Classes.length > 0 ? owner.Classes.join('.') : '-'}`
          + ` region=${region.x},${region.y},${region.w}x${region.h} texels=${texels} maxDelta=${r.BlurCacheLastMaxDelta} frame=${bc.Frame}`
          + ` read=${r.BlurCacheReadKind}`);
        st.Slot = r.BlurCacheStore(fresh, slot, bc.Frame);
      }
      return fresh;
    }
    stats.Misses++;
    r.NoteBlurCacheMiss();
    if (JauiTracing()) {
      const k = `${owner.Classes.length > 0 ? owner.Classes.join('.') : '-'}/${v.Why}`;
      this._awake.Miss.set(k, (this._awake.Miss.get(k) ?? 0) + 1);
    }
    if (v.Why === 'clean') stats.Cold++;
    else stats.Why[v.Why]++;
    if (slot !== null) slot.Valid = false;
    const handle = build();
    // Test next frame against what was READ, not what was asked: the build snapped the region out to
    // its downsample grid, and the handle's map is the snapped rect.
    const rr = handle.Region;
    const full = GuardedRect(0, 0, w, h, BLUR_READ_GUARD_PX);
    if (rr !== undefined && rr.ScaleX > 0 && rr.ScaleY > 0 && (rr.ScaleX !== 1 || rr.ScaleY !== 1 || rr.OffsetX !== 0 || rr.OffsetY !== 0)) {
      const rw = w / rr.ScaleX, rh = h / rr.ScaleY;
      const rx = -rr.OffsetX * rw, ry = h - (-rr.OffsetY * rh) - rh;
      st.Rect = UnionRect(st.Rect, GuardedRect(rx, ry, rw, rh, BLUR_READ_GUARD_PX));
    } else {
      st.Rect = full;
    }
    if (v.Why === 'clean') {
      st.Slot = r.BlurCacheStore(handle, st.Slot, bc.Frame);
      if (st.Slot !== null) stats.Stored++;
    }
    return handle;
  };

  /** Open the frame: the seed is everything every draw depends on that no instance carries. */
  private _bcBeginFrame = (w: number, h: number): void => {
    this._bcOn = this._blurCache !== 'off';
    if (!this._bcOn) return;
    const bc = this._bc;
    const seed = bc.NewSeed();
    seed.Number(w); seed.Number(h); seed.Number(this._dpr);
    // The glyph atlas every text instance's UVs index, and its flush epoch.
    const atlas = this._textCache.Atlas;
    seed.Number(atlas ? bc.Id(atlas) : 0);
    seed.Number(this._bcTextEpoch);
    bc.BeginFrame(w, h);
    const s = this._bcStats;
    s.Surfaces = 0; s.Hits = 0; s.Misses = 0; s.Cold = 0; s.Stored = 0; s.Grouped = 0;
    s.Why.first = 0; s.Why.gap = 0; s.Why.key = 0; s.Why.prefix = 0; s.Why.full = 0; s.Why.damage = 0;
  };

  /** Close the frame and print the gate line on a SHAPE change, like every gate in this file. */
  private _bcEndFrame = (): void => {
    if (!this._bcOn) return;
    this._bcOn = false;
    const r = this._renderer as WebGL2Renderer;
    const bc = this._bc;
    bc.EndFrame((slot) => r.BlurCacheRelease(slot));
    const s = this._bcStats;
    const st = bc.Stats;
    const reg = bc.Region;
    const ses = this._bcSession;
    ses.Frames++;
    // RESTING: nothing painted differently from the frame before. A resting frame with surfaces to
    // read, none of them first-seen or cold, and still no hit, is a cache that is dead code wearing
    // a flag -- named, never averaged away.
    const resting = !reg.Full && reg.Count === 0;
    if (resting) ses.Resting++;
    const vacuous = resting && s.Surfaces > 0 && s.Hits === 0 && s.Cold === 0
      && s.Why.first === 0 && s.Why.gap === 0;
    if (vacuous) ses.Vacuous++;
    const c = r.BlurCacheCensus;
    const why = s.Why;
    const line = `jaui:blur-cache arm=${this._blurCache} surfaces=${s.Surfaces} hits=${s.Hits} misses=${s.Misses}`
      + ` cold=${s.Cold} dirty=first:${why.first},gap:${why.gap},key:${why.key},prefix:${why.prefix},full:${why.full},damage:${why.damage}`
      + ` grouped=${s.Grouped} stored=${s.Stored} evictions=${c.Evictions} refused=${c.Refused}`
      + ` bytes=${(r.BlurCacheBytes / (1024 * 1024)).toFixed(1)}MB slots=${r.BlurCacheSlots}`
      + ` dirtyPieces=${reg.Full ? 'full' : reg.Count} dirtyPx=${(reg.Px / 1e6).toFixed(1)}M`
      + ` changed=${st.Changed} new=${st.New} gone=${st.Gone}`
      + ` fresh=janvas:${st.Fresh.janvas},shadow:${st.Fresh.shadow},group:${st.Fresh.group},edge:${st.Fresh.edge}`
      + ` shadowStill=${r.ShadowStill}`
      + ` untracked=${st.Untracked} dup=${st.Duplicate} seeded=${st.Seeded ? 1 : 0}`
      + ` resting=${resting ? 1 : 0} vacuous=${vacuous ? 1 : 0}`
      + (this._blurCache === 'verify' ? ` verified=${c.Verified} mismatches=${c.Mismatches} read=${r.BlurCacheReadKind}` : '')
      + ' pixels=SAME';
    this._bcLastFrame = {
      Surfaces: s.Surfaces, Hits: s.Hits, Misses: s.Misses, Cold: s.Cold, Stored: s.Stored, Grouped: s.Grouped,
      Dirty: { ...why }, DirtyPieces: reg.Full ? -1 : reg.Count, DirtyPx: reg.Px,
      Changed: st.Changed, New: st.New, Gone: st.Gone, Fresh: { ...st.Fresh },
      Untracked: st.Untracked, Duplicate: st.Duplicate, Seeded: st.Seeded, Resting: resting, Vacuous: vacuous,
    };
    if (line !== this._bcLastLine) { this._bcLastLine = line; JTrace(line); }
  };
  private _bcLastFrame: BlurCacheFrame | null = null;

  /** Compute the offset descendants see when descending past a scroll container. */
  /** Returns the (Ox, Oy) for descendants. ScrollX/Y is in this node's
   *  natural coords, so its contribution to the children's effective
   *  offset is `Cx * ScrollX` (subtracted) — the scroll moves content
   *  in the cascade-scaled space. Cx/Cy are unchanged on descent;
   *  this jiv's own VisualScale is composed in renderNode before this. */
  private _descendOffset = (node: Jiv, m: Mat2x3): Mat2x3 => {
    if (node.Overflow !== 'Scroll') return m;
    // Scroll is a translation in the node's LOCAL (natural) frame, so compose
    // it INTO the matrix as a local translate (right-multiply). A rotated
    // scroll container then scrolls along its own rotated axes. At rotation 0
    // this reduces to the legacy [ox - cx*ScrollX, oy - cy*ScrollY].
    return matMul(m, [1, 0, 0, 1, -node.ScrollX, -node.ScrollY]);
  };

  /** Canvas-space AABB of `node`'s (possibly rotated) rect under matrix `m` —
   *  the min/max of its four mapped corners. Used for axis-aligned region/cull
   *  rects. At rotation 0 this is exactly the node's mapped rect. */
  /** Max painted overhang (CSS px) beyond a node's box anywhere in a subtree:
   *  drop-shadow reach (blur + |offset|) and border width. Used to size the
   *  layer-cache FBO so shadows/borders aren't clipped at the box edge. A
   *  clipping cache root bounds its descendants, so scanning the root's own
   *  margin plus its children's covers every painted pixel conservatively. */
  /** Does this subtree hold anything whose PIXELS depend on where it is rasterised?
   *
   *  The card composite rasterises a subtree into a sub-window by offsetting the viewport, which
   *  leaves every screen-space quantity (`v_PixelPos`, `u_Resolution`, the clip stack) exactly as
   *  it was -- with one exception. `Jiv.Panel.frag`'s GRADIENT dither hashes `gl_FragCoord`, which
   *  is in FRAMEBUFFER space, so a gradient-filled panel would take a different dither pattern
   *  inside a card: sub-LSB, invisible, and not zero. The density rule for this lane is zero
   *  differing pixels, so a surface wrapping a gradient fill stays on the in-scene path and pays
   *  the encoder end it always paid. (The glass/backdrop branch dithers on `v_PixelPos` and is
   *  unaffected, which is why a card of glass over glass is still free.)
   *
   *  Memoised per frame beside `_subtreeDynamicMemo`: the walk asks once per glass surface, and a
   *  card's subtree is small, but a page whose glass wraps a deep tree should not re-scan it. */
  private _subtreeHasUnretargetable = (node: Jiv): boolean => {
    const memo = this._subtreeUnretargetableMemo.get(node);
    if (memo !== undefined) return memo;
    const _bgk = node.RenderStyle.Background.Kind;
    let hit = _bgk === 'LinearGradient' || _bgk === 'RadialGradient';
    if (!hit) {
      const kids = node.Children as Jiv[];
      for (let i = 0; i < kids.length; i++) {
        if (this._subtreeHasUnretargetable(kids[i])) { hit = true; break; }
      }
    }
    this._subtreeUnretargetableMemo.set(node, hit);
    return hit;
  };
  private _subtreeUnretargetableMemo = new Map<Jiv, boolean>();

  private _subtreeMaxPaintMargin = (node: Jiv): number => {
    const s = node.RenderStyle;
    let m = 0;
    if (s.ShadowColor.A > 0.001) {
      m = s.ShadowBlur + Math.max(Math.abs(s.ShadowOffsetX), Math.abs(s.ShadowOffsetY));
    }
    m = Math.max(m, s.BorderWidth);
    const kids = node.Children as Jiv[];
    for (let i = 0; i < kids.length; i++) m = Math.max(m, this._subtreeMaxPaintMargin(kids[i]));
    return m;
  };

  private _nodeAabb = (node: Jiv, m: Mat2x3, effH: Mat3x3 | null = null): { minX: number; minY: number; maxX: number; maxY: number } => {
    const x0 = node.X, y0 = node.Y, x1 = node.X + node.Width, y1 = node.Y + node.Height;
    // Under perspective, the box maps through the homography — project the four
    // corners (with the divide) and bound them. At no perspective `m` is used.
    if (effH !== null) {
      const p0 = mat3ApplyPoint(effH, x0, y0), p1 = mat3ApplyPoint(effH, x1, y0);
      const p2 = mat3ApplyPoint(effH, x1, y1), p3 = mat3ApplyPoint(effH, x0, y1);
      return {
        minX: Math.min(p0[0], p1[0], p2[0], p3[0]), minY: Math.min(p0[1], p1[1], p2[1], p3[1]),
        maxX: Math.max(p0[0], p1[0], p2[0], p3[0]), maxY: Math.max(p0[1], p1[1], p2[1], p3[1]),
      };
    }
    const ax = matApplyX(m, x0, y0), ay = matApplyY(m, x0, y0);
    const bx = matApplyX(m, x1, y0), by = matApplyY(m, x1, y0);
    const cx2 = matApplyX(m, x1, y1), cy2 = matApplyY(m, x1, y1);
    const dx = matApplyX(m, x0, y1), dy = matApplyY(m, x0, y1);
    return {
      minX: Math.min(ax, bx, cx2, dx), minY: Math.min(ay, by, cy2, dy),
      maxX: Math.max(ax, bx, cx2, dx), maxY: Math.max(ay, by, cy2, dy),
    };
  };

  /** AABB cull against the inherited clip stack. Returns true if the node's
   *  bounding box intersects every clip in the stack — false (skip) only if
   *  the node lies completely outside any single clip. Per-pixel rounded-rect
   *  clipping happens in the shader; this is just the cheap CPU-side cull.
   *  Uses the cascade-scaled rect so a transformed Jiv's clip cull respects
   *  its actually-rendered bbox. */
  private _isInsideClipStack = (
    node: Jiv, m: Mat2x3, stack: ClipStack, effH: Mat3x3 | null = null,
  ): boolean => {
    if (stack.length === 0) return true;
    // AABB of the (possibly rotated / perspective-projected) node — conservative
    // cull (never rejects a visible pixel). At no transform this is the mapped rect.
    const { minX: nx, minY: ny, maxX: nx2, maxY: ny2 } = this._nodeAabb(node, m, effH);
    for (const c of stack) {
      if (nx2 <= c.X || nx >= c.X + c.W) return false;
      if (ny2 <= c.Y || ny >= c.Y + c.H) return false;
    }
    return true;
  };

  /** True when `node` actually paints a visible border stroke (non-zero width
   *  AND a non-transparent BorderColor). Gates the BorderLayer reordering —
   *  there's nothing to interleave for a borderless Jiv. */
  private _hasPaintedBorder = (node: Jiv): boolean => {
    const s = node.RenderStyle;
    return s.BorderWidth > 0 && s.BorderColor.A > 0.001;
  };

  /** `?emptypanels`: would this node's panel instance shade its whole quad to `result.a` EXACTLY 0?
   *
   *  Only ever asked of a node the walk has already routed to the NON-GLASS panel branch, so
   *  `materialType` is the compile-time 0.0 of MATERIAL_NONE / MATERIAL_FLAT /
   *  BORDERLESS, and `u_ShadowBackdrop.x` is -1 (the flat paths pass no shadow backdrop). Under
   *  those, `Jiv.Panel.frag` reduces to, term for term:
   *
   *    fillSrc   = v_Tint (u_BgMode 0), or `sampleBgGradient`'s early `vec4(0.0)` at a < 1e-4
   *    fillA     = fillAlpha * fillSrc.a                    -> x * 0     = 0, for finite fillAlpha
   *    shadowAlpha = 0.0                                    -> the `v_ShadowColor.a > 1e-4` guard
   *                                                            is not taken; and even if it were,
   *                                                            `AdaptiveShadowAlpha` MULTIPLIES the
   *                                                            authored alpha, so 0 stays 0
   *    outA      = 0 + 0 * (1 - 0)                          = 0
   *    outRGB    = vec3(0.0)                                -> `outA > 1e-5` is false
   *    borderCoverage = variedBorderWidth / drawnBorderWidth = 0 / 1 = 0 at BorderWidth 0 exactly,
   *                                                            WHATEVER BorderBlur is: BorderBlur
   *                                                            is `aa` inside the two smoothsteps
   *                                                            and never a factor of the coverage.
   *                                                            So a zero-width border with a
   *                                                            non-zero blur CANNOT paint, and
   *                                                            `result.a = a*(1-0) + 0` is exact.
   *    result.a *= opacity * clipAlpha                      -> 0 * anything = 0 (which is why
   *                                                            EffectiveOpacity is not a clause)
   *
   *  The foreground grade and both dithers that follow write `result.rgb` only; they cannot raise
   *  an alpha of 0. And `EnableBlend` / `BeginScenePass` set FUNC_ADD with
   *  `(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` for RGB and `(ONE, ONE_MINUS_SRC_ALPHA)` for alpha, so
   *  `dst.rgb = src.rgb*0 + dst.rgb*1` and `dst.a = 0*1 + dst.a*(1-0)` -- the destination is
   *  bit-identical on every channel of every format, whatever the fragment's rgb came out as.
   *
   *  Every clause below is EXACT rather than an epsilon, because a 0.0005 that survived would
   *  multiply the destination by 0.9995 and that is not the same picture. */
  /** VIBRANCY's zones for one element (Core/Vibrancy.ts), resolved at DRAW time because they depend
   *  on the cascade:
   *
   *    Shape  the shape draw's value, or null. Only where AUTHORED: `Filter: Vibrancy()` or the
   *           `Vibrancy:` property declared on this node (the backdrop zone emits its own).
   *    Ink    the blend this element's own paint takes, or null for source-over. `Filter: Vibrancy()`
   *           and the `Vibrancy:` property (authored OR inherited) set it; the backdrop zone never does.
   *
   *  The zone function wins over the property on the node that authors both: a default loses to a
   *  statement.
   *
   *  An element that SAMPLES its backdrop cannot have vibrant paint: its fill is drawn by the glass or
   *  progressive-blur branch. An INHERITED value there is ignored (`IgnoredSampling`); an AUTHORED one
   *  throws by name. An SVG and a border re-emitted among children refuse the same way. The ink zone
   *  is exempt from all of this: the text is its own batch, after the material has committed. */
  /** VIBRANCY's effect field, per rendered frame: `__jauiVibrancy()` returns it and the gate line is
   *  formatted from it. The blend counters live on the RENDERER, counted at the draw call. */
  private _vibrancyCensus = (): VibrancyCensus => {
    const gl2 = this._renderer instanceof WebGL2Renderer ? this._renderer : null;
    const st = this._vibrancyStats;
    return {
      Armed: Vibrancy.Mode,
      Authored: st.Authored,
      Inherited: st.Inherited,
      IgnoredSampling: st.IgnoredSampling,
      TextInk: st.TextInk,
      Under: st.Under,
      Graded: st.Graded,
      Builds: st.Builds,
      CascadeVisited: st.CascadeVisited,
      CascadeCarried: st.CascadeCarried,
      PanelBatches: st.PanelBatches,
      ShapeDraws: gl2 === null ? 0 : gl2.ShapeDraws,
      Blends: gl2 === null ? 0 : gl2.BlendDraws,
      BlendSwitches: gl2 === null ? 0 : gl2.BlendSwitches,
      Refused: { ...st.Refused },
    };
  };

  private _vibrancyZonesOf = (node: Jiv): VibrancyZones => {
    const s = node.RenderStyle;
    const eff = node.EffectiveVibrancy;
    const fg = ForegroundVibrancy(s);
    const prop = CascadedVibrancy(eff);

    // THE INK ZONE, resolved first and independently: it emits no shape draw and is exempt from the
    // sampling refusals below.
    const text = TextVibrancy(s);
    const textActive = VibrancyIsActive(text.Amount, text.Cover);
    const textInk = textActive ? VibrancyBlendOf('Ink', text.Amount, text.Cover) : null;
    const textScale = textActive ? VibrancyInkScale(text.Amount) : 1;

    // The paint's level: the `Filter` zone's if authored, else the cascaded property's.
    const fgActive = VibrancyIsActive(fg.Amount, fg.Cover);
    const level = fgActive ? fg : prop;
    if (!VibrancyIsActive(level.Amount, level.Cover)) return { Shape: null, Ink: null, TextInk: textInk, TextScale: textScale };
    const color = fgActive ? s.ForegroundVibrancyColor : (eff ?? { R: 1, G: 1, B: 1 });

    // Authored HERE means this node named it, in either spelling: only then does it emit the shape draw.
    const authoredHere = fgActive || node.EffectiveVibrancyAuthored;

    const why = s.Material !== 'None' ? `its material is ${s.Material}`
      : VibrancySamplesBackdrop(s) ? 'it samples its backdrop (BackdropFilter / Tint)'
      : node.SvgVector ? 'it paints an SVG'
      : s.BorderLayer !== 0 && this._hasPaintedBorder(node) ? 'its border is re-emitted among its children (BorderLayer)'
      : '';
    if (why !== '') {
      if (!authoredHere) {
        this._vibrancyStats.IgnoredSampling++;
        return { Shape: null, Ink: null, TextInk: textInk, TextScale: textScale };
      }
      throw new Error(
        `[Jaui] Filter: Vibrancy() makes this element's own paint vibrant, and this element's paint cannot be ` +
        `reached whole: ${why}. Author it on BackdropFilter (what is under the element is treated, and its ` +
        'own paint still covers), or set Isolate: true to stop the cascade before it reaches this node.',
      );
    }
    const ink = VibrancyBlendOf('Ink', level.Amount, level.Cover);
    return {
      Shape: authoredHere ? { R: color.R, G: color.G, B: color.B, Amount: level.Amount, Cover: level.Cover } : null,
      Ink: ink,
      // `TextFilter` is the more specific zone, so it wins for the text when both are authored.
      TextInk: textInk ?? ink,
      TextScale: textScale,
    };
  };

  private _isEmptyPanel = (node: Jiv): boolean => {
    const s = node.RenderStyle;
    // A border of any width has coverage, and a border of any alpha inks it. Both exactly zero is
    // the only pair that composites `x * 1 + c * 0`. `_hasPaintedBorder` is the weaker predicate
    // (it tolerates 0.001 of alpha) so it is not the one to route on here.
    if (s.BorderWidth !== 0 || s.BorderColor.A !== 0) return false;
    // The shadow paints UNDER and AROUND the fill, and it is a separate SDF.
    if (s.ShadowColor.A !== 0 && !JivInstanceBuffer.DiagNoShadow) return false;
    // Glass and progressive blur are other branches of the walk entirely; a node can only reach
    // this one as LiquidGlass when its Refraction is 0, and that instance still takes the glass
    // rim's own reasoning. Refuse the material outright rather than reason about which of its legs
    // the compile-time variant folded away.
    if (s.Material !== 'None') return false;
    // THE CLAUSE THAT IS NOT OBVIOUS. `hasBackdropFilter` makes the fragment take
    // `fillA = fillAlpha` -- NOT `fillAlpha * fillSrc.a` -- so a transparent background over a
    // filtered backdrop paints at full alpha. `_hasBackdropFilter` is the same five numbers the
    // shader tests (brightness, saturation, contrast, frost LOD, body Tint), which is also why a
    // withheld instance can never flip a batch's MATERIAL_FLAT routing: an instance this admits
    // was never the one holding that routing back.
    if (_hasBackdropFilter(node)) return false;
    // Nothing that reads the destination. THE ADDITIVE COLOR does: an element whose own ink ADDS is
    // not compositing `x * 1 + c * 0`, and withholding its quad is not provably a no-op. This clause
    // was inert while `BlendMode` reached no draw call; it is live now, and it reads the CASCADE
    // result because an inherited vibrancy is not in this node's own style.
    if (VibrancyTouchesInk(s, node.EffectiveVibrancy)) return false;
    const bg = s.Background;
    // An image's alpha lives in the texture and the CPU cannot read it.
    if (bg.Kind === 'Image') return false;
    if (bg.Kind === 'Color') return bg.Color.A === 0;
    // A gradient every one of whose STOPS is fully transparent: `sampleBgGradient` clamps the
    // interpolated alpha and returns `vec4(0.0)` outright below 1e-4, so the fill source is the
    // exact zero vector on every knot and every span between them. A gradient with NO stops would
    // also return `vec4(0.0)` (the `u_BgGradStopCount <= 0` line), but its curve fit is not this
    // lane's to reason about, so it is refused rather than admitted for free.
    return bg.Stops.length > 0 && bg.Stops.every((p) => p.Color.A === 0);
  };

  /** Device pixels the withheld quad would have shaded, clipped to the drawing buffer.
   *
   *  `Jiv.InstanceBuffer.Push`'s `a_Rect`, term for term, so the number is the quad the walk did
   *  not submit rather than the node's box: an empty panel still carries the default
   *  `BorderBlur: 0.5`, which at dpr 2 is a 1 device px margin on every side. Border width is 0 by
   *  the rule; the shadow MARGIN is not, because a shadow at alpha 0 can still carry a blur and an
   *  offset, and that margin is real quad. The clip stack is deliberately NOT intersected: a clip
   *  is evaluated in the fragment, so a clipped-away fragment still ran. The viewport is, because
   *  that one is hardware. */
  private _emptyPanelQuadPx = (
    node: Jiv, eff: Mat2x3, effH: Mat3x3 | null, w: number, h: number,
  ): number => {
    const s = node.RenderStyle;
    const d = this._dpr;
    const avgScale = (matScaleX(eff) + matScaleY(eff)) * 0.5;
    const ns = JivInstanceBuffer.DiagNoShadow;
    const shadowBlur = ns ? 0 : s.ShadowBlur * avgScale * d;
    const shadowOffX = ns ? 0 : s.ShadowOffsetX * avgScale * d;
    const shadowOffY = ns ? 0 : s.ShadowOffsetY * avgScale * d;
    const borderMargin = s.BorderWidth * avgScale * d + s.BorderBlur * avgScale * d;
    const marginX = Math.max(shadowBlur + Math.abs(shadowOffX), borderMargin);
    const marginY = Math.max(shadowBlur + Math.abs(shadowOffY), borderMargin);
    let x0: number, y0: number, x1: number, y1: number;
    if (effH !== null) {
      // Projective: `a_Rect` is the NATURAL box and the vertex projects its corners, so the
      // rasterized extent is the projected AABB. `_nodeAabb` runs the same homography.
      const ab = this._nodeAabb(node, eff, effH);
      x0 = ab.minX * d - marginX; y0 = ab.minY * d - marginY;
      x1 = ab.maxX * d + marginX; y1 = ab.maxY * d + marginY;
    } else {
      const halfW = matScaleX(eff) * node.Width * d * 0.5;
      const halfH = matScaleY(eff) * node.Height * d * 0.5;
      const aCos = Math.abs(matCos(eff)), aSin = Math.abs(matSin(eff));
      const rotHalfX = aCos * (halfW + marginX) + aSin * (halfH + marginY);
      const rotHalfY = aSin * (halfW + marginX) + aCos * (halfH + marginY);
      const cxDev = matApplyX(eff, node.X + node.Width * 0.5, node.Y + node.Height * 0.5) * d;
      const cyDev = matApplyY(eff, node.X + node.Width * 0.5, node.Y + node.Height * 0.5) * d;
      x0 = cxDev - rotHalfX; y0 = cyDev - rotHalfY;
      x1 = cxDev + rotHalfX; y1 = cyDev + rotHalfY;
    }
    const cw = Math.min(x1, w) - Math.max(x0, 0);
    const ch = Math.min(y1, h) - Math.max(y0, 0);
    return cw > 0 && ch > 0 ? cw * ch : 0;
  };

  /** True when this node's edge -- its box plus the reach a border stroke has past it -- lies
   *  wholly outside the clip stack, or outside the damage rect being repainted. The AABB culls in
   *  `renderNode` test the BOX and then skip the node's own panel; a stroke is wider than the box,
   *  so its overlay is only safe to drop once the wider shape is out too. A rim never leaves the box. */
  private _edgeOutsidePaintedArea = (
    node: Jiv, eff: Mat2x3, stack: ClipStack, effH: Mat3x3 | null,
  ): boolean => {
    const s = node.RenderStyle;
    const scale = Math.max(matScaleX(eff), matScaleY(eff));
    const m = (s.BorderWidth + s.BorderBlur) * scale;
    const ab = this._nodeAabb(node, eff, effH);
    const nx = ab.minX - m, ny = ab.minY - m, nx2 = ab.maxX + m, ny2 = ab.maxY + m;
    for (const c of stack) {
      if (nx2 <= c.X || nx >= c.X + c.W) return true;
      if (ny2 <= c.Y || ny >= c.Y + c.H) return true;
    }
    const dr = this._damageRectCss;
    return dr !== null
      && (nx2 <= dr.x || nx >= dr.x + dr.w || ny2 <= dr.y || ny >= dr.y + dr.h);
  };

  /** Build the rounded-rect ClipShape for `node` — its box plus its
   *  per-corner BorderRadius. Used both when a node clips its descendants
   *  (Overflow: Hidden|Scroll) and when a child opts in (ParentOverflow:
   *  Hidden). All values stay in CSS px; the buffer multiplies by dpr. */
  private _boxClip = (
    node: Jiv, m: Mat2x3,
  ): ClipShape => {
    const radii = node.RenderStyle.BorderRadius;
    // Axis scales + rotation basis from the cascaded matrix. At rotation 0,
    // cx=|a|, cy=|d|, cos=1, sin=0 — identical to the legacy scalar path.
    const cx = matScaleX(m);
    const cy = matScaleY(m);
    // Clamp to half-dimension (CSS border-radius rule). Without this, a
    // pill-style `BorderRadius: 999pt` on a small box produces an SDF whose
    // "inside" region is empty — the clip rejects everything including the
    // center, so the node's image/content draws are fully clipped away.
    const w = cx * node.Width;
    const h = cy * node.Height;
    const avgScale = (cx + cy) * 0.5;
    const maxR = Math.min(w, h) / 2;
    // The clip draws the panel's corner verbatim: the same continuous corner, its radius clamped to half
    // the box, so a capsule clips as the capsule it draws.
    const corner = (i: number): number => Math.min(radii[i] * avgScale, maxR);
    const rtl = corner(0);
    const rtr = corner(1);
    const rbr = corner(2);
    const rbl = corner(3);
    // The clip rect is the node's box in canvas space; under rotation its
    // top-left would be ambiguous, so store the CENTER (always well-defined)
    // and let the clip SDF rebuild corners from center ± half-extents in the
    // un-rotated frame. Cos/Sin let the per-pixel clip SDF un-rotate the sample.
    const cxLocal = node.X + node.Width * 0.5;
    const cyLocal = node.Y + node.Height * 0.5;
    return {
      // X/Y are the top-left of the UNROTATED box at this scale (center − half).
      // The clip SDF re-derives them after un-rotating about CenterX/Y.
      X: matApplyX(m, cxLocal, cyLocal) - w * 0.5,
      Y: matApplyY(m, cxLocal, cyLocal) - h * 0.5,
      W: w,
      H: h,
      RTL: rtl,
      RTR: rtr,
      RBR: rbr,
      RBL: rbl,
      Smoothness: node.RenderStyle.BorderRadiusSmoothness,
      Cos: matCos(m),
      Sin: matSin(m),
      CenterX: matApplyX(m, cxLocal, cyLocal),
      CenterY: matApplyY(m, cxLocal, cyLocal),
    };
  };

  /** Stack passed down to a child, factoring its `ParentOverflow`:
   *  - `Visible` → escape one level (parent's contribution dropped if any).
   *  - `Hidden`  → append parent's box clip even if parent is `Visible`.
   *  - `Inherit` → append parent's box clip iff parent is Hidden/Scroll. */
  private _childClip = (
    parent: Jiv,
    parentIncomingStack: ClipStack,
    parentBoxClip: ClipShape,
    child: Jiv,
  ): ClipStack => {
    const po = child.ChildLayout.ParentOverflow;
    if (po === 'Visible') return parentIncomingStack;
    if (po === 'Hidden') return [...parentIncomingStack, parentBoxClip];
    return parent.ClipsChildren
      ? [...parentIncomingStack, parentBoxClip]
      : parentIncomingStack;
  };

  // ── The walk's own arithmetic, named so a second walk can reuse it ─────────────────────────
  // Everything from here to `_glassRimBlurPlan` was inline in `renderNode` / `descendChildren`
  // and still runs there and only there on an unflagged build. It is out here because
  // `?blur-first` walks the same tree to build the same pyramids ahead of the bed, and a pre-pass
  // that re-derives a transform, a cull or a sample region is a pre-pass that can silently build a
  // DIFFERENT pyramid and hand it over as if it were the same one. Reuse, do not copy.

  /** The homography `_composeTransform` produced, and the perspective context it established for
   *  the node's DESCENDANTS. Fields rather than a returned tuple because that function runs for
   *  every node in the tree every frame and an object per node is an allocation the walk does not
   *  make today. Both are read on the line after the call and nowhere else. */
  private _xfH: Mat3x3 | null = null;
  private _xfPersp: PerspCtx | null = null;

  /** Compose a node's own transform onto the inherited matrix, and return the affine.
   *
   *  Order: rotation (outermost, about Transform.Origin) then VisualScale/Translate (about
   *  VisualOrigin). Both ride the inherited matrix so they CASCADE to descendants — rotation flows
   *  to children exactly like scale/translate. Pivots are in NATURAL coords (jiv.X/Y as the layout
   *  solver assigned).
   *
   *  `_xfH` is the parallel 3D homography — null on the 2D fast path (then this is byte-identical
   *  to the affine-only path). Once an ancestor (or this node) introduces perspective, the affine
   *  deltas mirror onto it so the tilted plane keeps cascading; STEP C folds in the actual tilt. */
  private _composeTransform = (
    node: Jiv, m: Mat2x3, mH: Mat3x3 | null, persp: PerspCtx | null,
  ): Mat2x3 => {
    let eff: Mat2x3 = m;
    let effH: Mat3x3 | null = mH;
    // STEP A — rotation about Transform.Origin (the cascading behavior).
    const rotDeg = node.RenderStyle.Transform.Rotation;
    if (rotDeg !== 0) {
      const th = rotDeg * (Math.PI / 180);
      const rc = Math.cos(th), rs = Math.sin(th);
      const rpx = node.X + node.Width * node.RenderStyle.Transform.OriginX;
      const rpy = node.Y + node.Height * node.RenderStyle.Transform.OriginY;
      const rMat: Mat2x3 = [rc, rs, -rs, rc, rpx * (1 - rc) + rpy * rs, rpy * (1 - rc) - rpx * rs];
      eff = matMul(eff, rMat);
      if (effH !== null) effH = mat3Mul(effH, mat3FromAffine(rMat));
    }
    // STEP B — VisualScale/Translate about VisualOrigin (matches the legacy formula exactly when
    // rotation is absent; stacks onto rotation when it is not).
    const sx = node.RenderStyle.VisualScaleX;
    const sy = node.RenderStyle.VisualScaleY;
    const tx = node.RenderStyle.VisualTranslateX;
    const ty = node.RenderStyle.VisualTranslateY;
    if (sx !== 1 || sy !== 1 || tx !== 0 || ty !== 0) {
      const pivotX = node.X + node.Width * node.RenderStyle.VisualOriginX;
      const pivotY = node.Y + node.Height * node.RenderStyle.VisualOriginY;
      const vMat: Mat2x3 = [sx, 0, 0, sy, pivotX * (1 - sx) + tx, pivotY * (1 - sy) + ty];
      eff = matMul(eff, vMat);
      if (effH !== null) effH = mat3Mul(effH, mat3FromAffine(vMat));
    }
    // STEP C — 3D: fold this node's RotateX/RotateY/TranslateZ into a homography (projecting
    // toward the inherited perspective's vanishing point), and establish a perspective context for
    // THIS node's descendants if it sets `Perspective`. Pure no-op on the 2D fast path (no 3D
    // transform, no ancestor/own perspective → effH stays null, childPersp stays persp).
    let childPersp: PerspCtx | null = persp;
    const tf = node.RenderStyle.Transform;
    if ((tf.RotateX !== 0 || tf.RotateY !== 0 || tf.TranslateZ !== 0) && persp !== null) {
      const o3x = node.X + node.Width * tf.OriginX;
      const o3y = node.Y + node.Height * tf.OriginY;
      const base: Mat3x3 = effH ?? mat3FromAffine(eff);
      const tilt = mat3Project3D({
        RotateXDeg: tf.RotateX, RotateYDeg: tf.RotateY, TranslateZ: tf.TranslateZ,
        PivotX: matApplyX(eff, o3x, o3y), PivotY: matApplyY(eff, o3x, o3y),
        Perspective: persp.D, OriginX: persp.Ox, OriginY: persp.Oy,
      });
      effH = mat3Mul(tilt, base);
    }
    const pv = node.RenderStyle.Perspective;
    if (pv > 0) {
      const pgx = node.X + node.Width * node.RenderStyle.PerspectiveOriginX;
      const pgy = node.Y + node.Height * node.RenderStyle.PerspectiveOriginY;
      childPersp = { D: pv, Ox: matApplyX(eff, pgx, pgy), Oy: matApplyY(eff, pgx, pgy) };
    }
    this._xfH = effH;
    this._xfPersp = childPersp;
    return eff;
  };

  /** Order children by Layer (stable — tree order breaks ties). Fast-path when every child has
   *  Layer 0 (the common case): return the original array so we don't allocate or sort. Sort is
   *  only triggered when an author actually used Layer. */
  private _orderedChildren = (node: Jiv): Jiv[] => {
    const children = node.Children as Jiv[];
    let needsSort = false;
    for (let i = 0; i < children.length; i++) {
      if (children[i].RenderStyle.Layer !== 0) { needsSort = true; break; }
    }
    if (!needsSort) return children;
    return [...children].sort((a, b) => a.RenderStyle.Layer - b.RenderStyle.Layer);
  };

  /** [damage] Phase A: this node's AABB doesn't intersect the dirty rect, so its panel/glass/blur
   *  draw never runs and the GPU fill it would have cost is saved. Always false when no damage
   *  rect is armed, which is every unflagged frame. */
  private _damageCulls = (node: Jiv, eff: Mat2x3, effH: Mat3x3 | null): boolean => {
    const dr = this._damageRectCss;
    if (dr === null) return false;
    const ab = this._nodeAabb(node, eff, effH);
    return ab.maxX <= dr.x || ab.minX >= dr.x + dr.w || ab.maxY <= dr.y || ab.minY >= dr.y + dr.h;
  };

  /** True when this node re-emits its border as a standalone stroke among its children: a non-zero
   *  BorderLayer on a node that actually paints a border and actually paints at all -- and whose
   *  stroke is still on screen when its own panel was culled. */
  private _borderEmits = (
    node: Jiv, eff: Mat2x3, stack: ClipStack, effH: Mat3x3 | null, ownPanelCulled: boolean,
  ): boolean => {
    if (!(node.RenderStyle.BorderLayer !== 0 && this._hasPaintedBorder(node)
          && node.Visible && node.Width > 0 && node.Height > 0)) return false;
    return !(ownPanelCulled && this._edgeOutsidePaintedArea(node, eff, stack, effH));
  };

  /** True when this node draws a rim: it authored one, it is visible, and its own panel either drew
   *  or was culled with an edge that is still on screen. */
  private _rimEmits = (
    node: Jiv, eff: Mat2x3, stack: ClipStack, effH: Mat3x3 | null, ownPanelCulled: boolean,
  ): boolean => {
    const s = node.RenderStyle;
    if (!(s.RimWidth > 0 && s.RimStrength > 0 && node.EffectiveOpacity > 0.001
          && node.Visible && node.Width > 0 && node.Height > 0)) return false;
    // Glass lights its band in its own fragment unless content drawn before its BorderLayer slot reaches it.
    if (_isGlass(s.Material) && this._glassFillTakesPyramid(node) && !this._glassRimInPass(node)) return false;
    return !(ownPanelCulled && this._edgeOutsidePaintedArea(node, eff, stack, effH));
  };

  /** Does this glass's highlight ride the rim pass? Only when its BorderLayer puts the rim over content and some of
   *  that content (descendants below the slot) reaches the band: a photo, a pill or a glyph at the edge. Otherwise the
   *  fragment lights the band over the face, the same pixels without the pass's scene snapshot. */
  private _glassRimInPass = (node: Jiv): boolean => {
    const memo = this._rimPassMemo.get(node);
    if (memo !== undefined) return memo;
    const s = node.RenderStyle;
    let inPass = false;
    if (s.BorderLayer !== 0 && s.RimWidth > 0 && s.RimStrength > 0 && _isGlass(s.Material) && this._glassFillTakesPyramid(node)) {
      const inset = s.RimWidth + 1;
      const budget = { Left: RIM_REACH_SCAN_BUDGET };
      const start: Mat2x3 = node.Overflow === 'Scroll' ? [1, 0, 0, 1, -node.ScrollX, -node.ScrollY] : MAT_IDENTITY;
      for (const child of node.Children as Jiv[]) {
        if (child.RenderStyle.Layer >= s.BorderLayer || child.TeleportSeq !== 0) continue;
        const m = child.ChildLayout.Position === 'Pinned' && node.Overflow === 'Scroll' ? MAT_IDENTITY : start;
        if (this._reachesRimBand(node, child, m, inset, budget)) { inPass = true; break; }
      }
    }
    this._rimPassMemo.set(node, inPass);
    return inPass;
  };

  /** Whether `n` or anything under it paints over `glass`'s band, `inset` deep: its painted box, in the glass's own
   *  frame through `m` and each node's own transform, leaves the glass's shape shrunk by the inset. The corner is
   *  taken as a circle of 1.53 radii, which a continuous corner lies outside of. Past the budget, or under 3D, it
   *  answers yes: the pass is always right, only dearer. */
  private _reachesRimBand = (glass: Jiv, n: Jiv, m: Mat2x3, inset: number, budget: { Left: number }): boolean => {
    if (!n.Visible || n.EffectiveOpacity <= 0.001) return false;
    if (--budget.Left < 0) return true;
    const rs = n.RenderStyle;
    if (rs.Transform.RotateX !== 0 || rs.Transform.RotateY !== 0 || rs.Transform.TranslateZ !== 0) return true;
    const own = this._composeTransform(n, m, null, null);
    const bg = rs.Background;
    const paints = n.Width > 0 && n.Height > 0 && ((bg.Kind !== 'Color' || bg.Color.A > 0.001)
      || rs.ShadowColor.A > 0.001 || this._hasPaintedBorder(n) || rs.Material !== 'None' || _hasBackdropFilter(n)
      || (n.Text !== null && n.Text !== '') || !!n.SvgVector);
    const b = this._nodeAabb(n, own);
    const inside = _insideInsetShape(b.minX, b.minY, b.maxX, b.maxY, glass, inset);
    if (paints) {
      const pad = Math.max(rs.ShadowColor.A > 0.001 ? rs.ShadowBlur + Math.max(Math.abs(rs.ShadowOffsetX), Math.abs(rs.ShadowOffsetY)) : 0, rs.BorderWidth);
      if (!(pad === 0 ? inside : _insideInsetShape(b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad, glass, inset))) return true;
    }
    // A clipping box clear of the band keeps its whole subtree clear of it too.
    if (n.Overflow !== 'Visible' && inside) return false;
    const childM = this._descendOffset(n, own);
    for (const c of n.Children as Jiv[]) {
      if (c.TeleportSeq !== 0) continue;
      const cm = c.ChildLayout.Position === 'Pinned' && n.Overflow === 'Scroll' ? own : childM;
      if (this._reachesRimBand(glass, c, cm, inset, budget)) return true;
    }
    return false;
  };

  /** True when this node takes the glass FILL pipeline — the branch that builds a pyramid.
   *
   *  A glass slab (Glass set, Thickness > 0 → Material LiquidGlass) only takes it when it actually has a
   *  glass-fill effect to show: a non-zero Refraction, or a backdrop frost/grade. A slab with
   *  Refraction 0 and no backdrop has nothing to refract or frost, so its FILL renders as a plain
   *  panel. The rim is its own draw either way. */
  private _glassFillTakesPyramid = (node: Jiv): boolean => {
    const material = node.RenderStyle.Material;
    return ((_isGlass(material) && node.RenderStyle.Refraction !== 0) || _hasBackdropFilter(node))
      && material !== 'ProgressiveBlur' && !this._diagNoGlass;
  };

  /** A glass surface's shadow peak at its rendered size (Core/Glass.Pipeline.ts); 0 on clear glass. */
  private _glassShadowPeak = (node: Jiv, eff: Mat2x3): number =>
    GlassShadowPeak(JivGlassSpanOf(node, eff), node.RenderStyle.GlassClear, GlassIsLens(node.RenderStyle.Lens));

  /** The glass FILL pyramid's plan: the region it is built over, the sigma it is built at, and how
   *  deep a chain the surface can read.
   *
   *  The margin is the frost blur's own spatial spread and a pad. The refraction bends every sample
   *  INWARD along the normal (Jiv.Panel.frag, the refraction band), chromatic spread included, so no
   *  tap ever leaves the panel's own box. The region is canvas-clamped, so a heavy panel just falls
   *  back toward a full-canvas pyramid, which resolves to the identity map. */
  /** The child of `node` that is an active lens (Jwift/Apple/LiquidGlass.md 7), or null. */
  private _activeLensChild = (node: Jiv): Jiv | null => {
    for (const child of node.Children as Jiv[]) {
      const rs = child.RenderStyle;
      if (child.Visible && GlassIsLens(rs.Lens) && _isGlass(rs.Material)) return child;
    }
    return null;
  };

  private _glassFillBlurPlan = (
    node: Jiv, eff: Mat2x3, effH: Mat3x3 | null, w: number, h: number,
  ): GlassBlurPlan => {
    const d = this._dpr;
    const rs = node.RenderStyle;
    const frost = JivFrostCssPx(node, d);
    const frostCssPx = Math.max(1 / d, frost);
    const gsx = matScaleX(eff), gsy = matScaleY(eff);
    const avgScale = (gsx + gsy) * 0.5;
    // Glass reads past its face (the outer lens sample, and on large glass the edge bleed and the colored
    // shadow) and deeper than its base (the body at full radius): Core/Glass.Pipeline.ts says how far.
    const glass = _isGlass(rs.Material)
      ? GlassBlurNeedsOf(JivGlassSpanOf(node, eff), d, rs.GlassVariant, GlassIsLens(rs.Lens)) : null;
    const margin = Math.max(frostCssPx * d + 8 * d, glass !== null ? glass.ReachPt * avgScale * d : 0);
    // The draw quad's own reach, from `Jiv.InstanceBuffer`'s expressions rather than from a
    // second reading of them: the surface draws with its shadow excluded, so its quad is the face,
    // the border and a pixel of antialiasing. The shadow is its own draw and never samples.
    const tapReach = (rs.BorderWidth + rs.BorderBlur) * avgScale * d + 1;
    const ab = this._nodeAabb(node, eff, effH);
    const px = ab.minX * d, py = ab.minY * d;
    const pw = (ab.maxX - ab.minX) * d, ph = (ab.maxY - ab.minY) * d;
    // Every glass surface is probed: its appearance is its backdrop's (Core/Glass.md).
    const adaptiveShadow = glass !== null;
    const instFrostLod = _instanceFrostLod(frost, d);
    const baseFrostLod = Math.log2(Math.max(1, frostCssPx * d));
    return {
      Region: {
        x: Math.max(0, Math.floor(px - margin)),
        y: Math.max(0, Math.floor(py - margin)),
        w: Math.min(w, Math.ceil(pw + margin * 2)),
        h: Math.min(h, Math.ceil(ph + margin * 2)),
      },
      Radius: frostCssPx * d,
      // How deep a chain this panel can actually read: `_backdropMaxLod`, the shader's own formula,
      // which is 0 at the panel's own frost sigma. The adaptive shadow reads the pyramid at its own
      // detail LOD, so it floors the depth.
      MaxLod: Math.max(
        _backdropMaxLod(instFrostLod, baseFrostLod),
        glass !== null ? glass.MaxLod : 0,
        adaptiveShadow ? Math.log2(Math.max(frostCssPx, SHADOW_DETAIL_MIN_PT) * d) - baseFrostLod : 0,
      ),
      BaseFrostLod: baseFrostLod,
      InstFrostLod: instFrostLod,
      Px: px, Py: py, Pw: pw, Ph: ph, Margin: margin, TapReach: tapReach,
      AdaptiveShadow: adaptiveShadow,
      FrostCssPx: frostCssPx,
    };
  };

  // ── `?blur-phased`: the predicates the walk asks, and the two build phases ──────
  //
  // Everything the phased walk does to `renderNode` / `descendChildren` goes through the three
  // predicates below, and every one of them answers the walk's own answer when `_phasedPass` is 0.
  // That is deliberate: an unflagged frame must take the branches it took before this lane, and a
  // reader has three functions to check rather than a scatter of `if (this._blurPhased)` through a
  // 770-line walk.

  /** A node the phased walk has to hold back: one that BUILDS A PYRAMID. Pass 1 stops at the first
   *  of them and pass 2 starts there, so every pyramid in the frame is built in the build phase and
   *  the bed is the only thing under the first of them.
   *
   *  It asks the style, not the cull: stopping pass 1 earlier than strictly necessary is safe (pass 2
   *  picks the node up, in order) while stopping later is not. A ProgressiveBlur surface is not one of these -- its pyramid is
   *  seeded from a snapshot at its own point in the walk, so it is neither pre-built nor moved, and
   *  `_phasedStrays.Pblur` counts it. */
  private _phasedHoldsBack = (node: Jiv): boolean => {
    if (node.Width <= 0 || node.Height <= 0 || !node.Visible) return false;
    if (node.RenderStyle.Material === 'ProgressiveBlur' && this._pblurOn(node)) return false;
    return this._glassFillTakesPyramid(node);
  };

  /** Does this node paint its OWN panel, text and vector in the pass that is running? Called once
   *  per node, at the point `renderNode` has finished culling and is about to choose a material
   *  branch -- which is also where the pass-1/pass-2 boundary is DETECTED, because the boundary IS
   *  the first node that would build a pyramid. A node's edge is emitted from `descendChildren` and
   *  gated by `_phasedEmitsEdge` instead. */
  private _phasedPaints = (node: Jiv): boolean => {
    switch (this._phasedPass) {
      case 1:
        if (this._phasedStop) return false;
        if (!this._phasedHoldsBack(node)) return true;
        this._phasedStop = true;
        return false;
      case 2:
        if (!this._phasedStarted && this._phasedHoldsBack(node)) this._phasedStarted = true;
        return this._phasedStarted;
      default:
        return true;
    }
  };

  /** Does a node's edge (a border re-emitted at its BorderLayer, and its rim) paint in the pass that
   *  is running? It builds nothing, so it paints in whichever pass its node's own content painted
   *  in, which is exactly what the live `_phasedStop` / `_phasedStarted` state says at the moment
   *  the edge reaches its BorderLayer slot. */
  private _phasedEmitsEdge = (): boolean => {
    switch (this._phasedPass) {
      case 1: return !this._phasedStop;
      case 2: return this._phasedStarted;
      default: return true;
    }
  };

  /** The build phase: every fill pyramid, from the scene as it stands, in the walk's own order. It
   *  reuses `?blur-first`'s pre-pass traversal wholesale -- same functions, same culls, same
   *  ordering, same plan resolver. A second copy of that traversal would be a second answer to
   *  "which surfaces build", and the whole claim of this flag is that the answer did not move.
   *
   *  No `RebindSceneTarget` here: the caller decides when the scene comes back, because a rebind
   *  between the builds and the probe pass would put a scene bind where the baseline has none. */
  private _blurPhasedBuild = (w: number, h: number): void => {
    this._phasedBuilt.length = 0;
    // With the atlas on, the traversal RECORDS rather than builds: a slot layout cannot be
    // computed one member at a time, and issuing the builds as it walked would be the per-card
    // composition again. The traversal itself is byte for byte the one `?blur-phased` runs, which
    // is what keeps ONE answer to "which surfaces build" across both arms.
    if (this._pyramidAtlas) this._atlasCollect = [];
    const scope: TeleportScope = { Deferred: [], Stack: EmptyClipStack };
    this._blurFirstNode(this.Root, MAT_IDENTITY, EmptyClipStack, scope, null, null, w, h);
    this._blurFirstReplay(scope, w, h);
    const collected = this._atlasCollect;
    this._atlasCollect = null;
    if (collected !== null) this._atlasPhase(collected, w, h);
    const st = this._blurFirstStats;
    st.Chains = this._blurFirstKeys.size;
    st.Keys = [...this._blurFirstKeys].join('+');
  };

  /** ONE BUILD PHASE AS ATLASES: the whole phase's plans in, every handle out.
   *
   *  The order is a plan, a build per atlas, and then the refused members built exactly as they
   *  are built today. Nothing here decides the COMPOSITION -- the phase already hoisted every
   *  build ahead of every draw -- so what this chooses is only how the passes are issued.
   *
   *  ONE ATLAS PER (RADIUS) CLASS, because `k`, `depth` and the phase grid all come off the
   *  radius, and mixing two of them in one target would be a resample rather than a crop. Members
   *  of a class need not be adjacent in the walk: under the hoisted composition every build sees
   *  the SAME scene state, so build order inside a phase carries no information and
   *  `IgnoreSeparation` is the whole of what the planner is asked. */
  private _atlasPhase = (
    collected: { Into: Map<Jiv, GpuTextureHandle>; Node: Jiv; Plan: GlassBlurPlan }[],
    w: number, h: number,
  ): void => {
    const r = this._renderer;
    const a = this._atlasStats;
    // The atlas is a WebGL2 path: `ComputeBlurAtlas` lives on that renderer and nowhere else. The
    // flag refuses to arm on any other backend, so this is the belt on that brace rather than a
    // silent degradation -- and a solo build is today's engine, which is the only fallback this
    // lane is willing to have.
    if (!(r instanceof WebGL2Renderer)) {
      for (const c of collected) this._prepassIssue(c.Into, c.Node, c.Plan, w, h);
      a.Solo += collected.length;
      return;
    }
    const solo: typeof collected = [];
    const byRadius = new Map<number, typeof collected>();
    for (const c of collected) {
      // The admission rule is the PLANNER's, not a private copy here: a walk with its own idea
      // of what an atlas can hold is a walk that can hand over a member the atlas cannot build.
      if (!AtlasAdmitsMember(c.Plan, w, h, this._glassPresample, this._glassGaussian !== 'off')) {
        a.Refused++; solo.push(c); continue;
      }
      const cls = byRadius.get(c.Plan.Radius);
      if (cls === undefined) byRadius.set(c.Plan.Radius, [c]); else cls.push(c);
    }
    for (const [radius, cls] of byRadius) {
      const plan = cls.length < 2 ? null : PlanBackdropAtlas(
        cls.map((c) => ({ Region: c.Plan.Region, Paint: c.Plan.Region })), w, h, radius,
        {
          IgnoreSeparation: true, Limits: ATLAS_LIMITS_WIRED, MaxLod: 0,
          Presample: this._glassPresample, Gaussian: this._glassGaussian !== 'off',
        },
      );
      // `K !== 1` is the pre-downsample ping-pong, which is NOT slotted and which this lane did
      // not design. Refused loudly and wholesale rather than slotting only the pyramid, which
      // would put the pre-passes' output in one place and the slot's level 0 in another.
      if (plan === null || plan.K !== 1) { for (const c of cls) solo.push(c); continue; }
      const taken = new Set<number>();
      for (const g of plan.Groups) {
        const build: AtlasBuildMember[] = [];
        for (let i = 0; i < g.Members.length; i++) {
          const c = cls[g.Members[i]];
          taken.add(g.Members[i]);
          build.push({ Rect: ResolveRegionRect(c.Plan.Region, w, h, plan.Phase), Slot: g.Slots[i] });
        }
        const handles = r.ComputeBlurAtlas(r.SceneTexture, w, h, radius, build, g.AtlasW, g.AtlasH);
        for (let i = 0; i < g.Members.length; i++) {
          this._atlasRecord(cls[g.Members[i]], handles[i]);
        }
        a.Atlases++;
        a.Members += g.Members.length;
        a.Bytes += g.Bytes;
        this._atlasSizes.add(`${g.AtlasW}x${g.AtlasH}`);
      }
      for (let i = 0; i < cls.length; i++) if (!taken.has(i)) solo.push(cls[i]);
    }
    for (const c of solo) this._prepassIssue(c.Into, c.Node, c.Plan, w, h);
    a.Solo += solo.length;
    a.Sizes = [...this._atlasSizes].join('+');
    r.NoteAtlasSolo(solo.length);
  };

  /** Hand one atlas slot's handle to the walk, on the same terms `_prepassIssue` hands over a
   *  solo build's: the map the site reads, and the probe list the shadow pass runs over. */
  private _atlasRecord = (
    c: { Into: Map<Jiv, GpuTextureHandle>; Node: Jiv; Plan: GlassBlurPlan }, handle: GpuTextureHandle,
  ): void => {
    c.Into.set(c.Node, handle);
    this._phasedBuilt.push({ Node: c.Node, Plan: c.Plan, Handle: handle });
  };

  /** The adaptive-shadow probes for the fills just built, in build order.
   *
   *  It runs HERE and not in the walk for one reason, and it is a counting reason rather than a
   *  pixel one: see `_phasedShadow`. Its arguments are the walk's, taken from the same
   *  `GlassBlurPlan` the fill site reads, so the probe measures the rect, the LOD and the pyramid
   *  the walk would have handed it. The sharp tap is the live scene texture, which is what the
   *  walk hands it on every frosted class (those take no snapshot), and `?blur-src-*` substitutes
   *  it inside `MeasureShadowBackdrop` exactly as it does in the walk. */
  private _phasedShadowProbes = (dt: number): void => {
    const r = this._renderer;
    const d = this._dpr;
    for (const b of this._phasedBuilt) {
      if (!b.Plan.AdaptiveShadow) continue;
      const detailLod = Math.log2(Math.max(b.Plan.FrostCssPx, SHADOW_DETAIL_MIN_PT) * d) - b.Plan.BaseFrostLod;
      const slot = r.MeasureShadowBackdrop(
        b.Node, { x: b.Plan.Px, y: b.Plan.Py, w: b.Plan.Pw, h: b.Plan.Ph },
        detailLod, b.Handle, r.SceneTexture, dt,
      );
      if (slot < 0) continue;
      this._phasedShadow.set(b.Node, { Slot: slot });
      this._adaptiveShadowsDrawn = true;
    }
  };

  // ── `?blur-first`: the pre-pass ───────────────────────────────────────────────────────────
  // A second walk of the same tree that issues, for every glass surface the normal walk would
  // build a pyramid for, exactly the `ComputeBlur` + `GenerateBlurMipmap` pair it would issue —
  // same region, same radius, same depth — and nothing else. No snapshot (that is not a build),
  // no shadow probe, no draw, no buffer encode, no counter. It runs immediately before the walk
  // and therefore before the bed's first draw.
  //
  // It descends through the SAME functions the walk descends through, so its build SET and its
  // build ORDER are the walk's by construction rather than by resemblance: `_composeTransform`,
  // `_isInsideClipStack`, `_damageCulls`, `_orderedChildren`, `_boxClip`, `_childClip`,
  // `_descendOffset`, `_rimEmits`, `_glassFillTakesPyramid`, `_glassFillBlurPlan`,
  // `_glassRimBlurPlan`. Where it CAN still disagree — a node the walk reaches and it did not —
  // the walk counts a MISS and builds, so the disagreement is a number in the report rather than
  // a silently different experiment.

  /** The SHAPE rect a panel instance rasterises its fill into, in device px.
   *
   *  It is the instance's own numbers: `JivInstanceBuffer.Push` centres the panel on the mapped
   *  local centre and gives it half-extents `cx * Width * d / 2`, and (at cos 1 / sin 0, which is
   *  the only case this lever admits) `a_Rect` is that box grown by the border/shadow margin. The
   *  margin carries no ink when both are absent, so the SHAPE is the rect to reason about and the
   *  quad is not. `tests/Occlusion.Wired.test.ts` pins this against a real `Push`. */
  private _occlusionShapeRect = (node: Jiv, eff: Mat2x3): { X0: number; Y0: number; X1: number; Y1: number } => {
    const d = this._dpr;
    const wDev = matScaleX(eff) * node.Width * d;
    const hDev = matScaleY(eff) * node.Height * d;
    const cxDev = matApplyX(eff, node.X + node.Width * 0.5, node.Y + node.Height * 0.5) * d;
    const cyDev = matApplyY(eff, node.X + node.Width * 0.5, node.Y + node.Height * 0.5) * d;
    return { X0: cxDev - wDev / 2, Y0: cyDev - hDev / 2, X1: cxDev + wDev / 2, Y1: cyDev + hDev / 2 };
  };

  /** One node, at its paint point, as the occlusion pre-pass sees it.
   *
   *  Three outcomes and no fourth: it SAMPLES the scene (its order joins `Reads` and nothing after
   *  it may count as a coverer for a fill before it), it is a fill worth reasoning about, or it is
   *  neither and only advances the paint order. */
  private _occlusionRecord = (
    scan: OcclusionScan, node: Jiv, eff: Mat2x3, stack: ClipStack, effH: Mat3x3 | null,
  ): void => {
    const order = scan.Order++;
    const rs = node.RenderStyle;
    const material = rs.Material;
    // Conservative on purpose, and wider than the glass FILL predicate: a glass slab with no
    // refraction takes the plain panel branch, but it is still glass. Marking the read at the node's
    // own order can only refuse a coverer that would have been legal.
    if (material === 'ProgressiveBlur' || _isGlass(material) || _hasBackdropFilter(node)) {
      scan.Reads.push(order);
      return;
    }
    if (scan.Fills.length >= DEFAULT_OCCLUSION_LIMITS.MaxCandidates) return;
    // 3D and rotation are out: a projective or rotated panel's ink is not the axis-aligned rect
    // this arithmetic is written in, and its AABB would claim cover it does not have.
    if (effH !== null || eff[1] !== 0 || eff[2] !== 0 || eff[0] <= 0 || eff[3] <= 0) return;
    // An element whose own ink ADDS instead of covering is not a coverer at all, however opaque its
    // fill: it does not hide what is beneath it, it brightens it. Reads the CASCADE result, because
    // an inherited vibrancy is not in this node's own style.
    if (VibrancyTouchesInk(rs, node.EffectiveVibrancy)) return;

    const d = this._dpr;
    const r = this._occlusionShapeRect(node, eff);
    const raster = IntersectPixelRect(RasterPixels(r.X0, r.Y0, r.X1, r.Y1), scan.Canvas);
    if (PixelRectArea(raster) < scan.MinAreaPx) return;

    const bg = rs.Background;
    const flat = bg.Kind === 'Color';
    // An IMAGE fill's alpha is the texture's, which the CPU cannot read, so it is neither opaque
    // nor reproducible at a sub-rect. A gradient is opaque when every STOP is -- the shader's
    // Hermite over a constant alpha returns that constant to a float ulp (see the report).
    //
    // AN IMAGE IS OPAQUE WHEN THE CACHE PROVED IT (a JPEG, or a load-time scan found no alpha < 1),
    // it is fitted with Cover (so no Contain bar shows the placeholder), and its cross-fade from the
    // placeholder has finished (the walk's own `_computeBgPaint` will compute the same alpha 1 later
    // this frame). The hero's two full-screen photos are the reason: the covered one, and the page
    // under both, were a whole screen of panel fill per frame each.
    const opaqueBg = flat ? bg.Color.A >= 1
      : bg.Kind === 'Image' ? this._imageFillOpaque(node)
      : bg.Stops.every((s) => s.Color.A >= 1);
    // `_hasPaintedBorder` rather than a second border predicate: it is the one the re-emitted stroke
    // routes on, and a fill this admitted while that refused would be a fill with a stroke outside
    // it. The shadow is the same clause from the other side -- it paints UNDER and AROUND the fill.
    const paintsOutsideTheFill = this._hasPaintedBorder(node)
      || (rs.ShadowColor.A > 0.001 && !JivInstanceBuffer.DiagNoShadow);
    const opaque = opaqueBg && node.EffectiveOpacity >= 1 && !paintsOutsideTheFill;

    const avgScale = (matScaleX(eff) + matScaleY(eff)) * 0.5;
    let radius = 0;
    for (let i = 0; i < 4; i++) radius = Math.max(radius, rs.BorderRadius[i] * avgScale * d);
    // How far the corner reaches along each edge: Apple's continuous corner, 1.528665 r at most.
    const reach = CornerReach(radius, rs.BorderRadiusSmoothness);

    let cover: readonly PixelRect[] = EMPTY_COVER;
    let covers = opaque;
    if (covers) {
      // TWO CHAINS, and the second is the fallback for the first. `region` is the honest set — a
      // rounded rect's face minus its four CORNER blocks (`CoveredRegion`), which is what the App's
      // own 183-device-px screen clip made the difference between a live lever and dead code.
      // `plain` is the one all-sides-inset rect the first fold used, kept because it is a SUBSET of
      // the region and therefore always a legal answer: if the region's rect count runs past
      // `MAX_COVER_RECTS` (3^depth on a deep stack of rounded clips) the coverer falls back to it
      // rather than being refused, and one clip per node's stack is one extra rect intersect.
      let region: PixelRect[] | null =
        IntersectRegions(CoveredRegion(r.X0, r.Y0, r.X1, r.Y1, reach), scan.CanvasRegion);
      let plain = IntersectPixelRect(CoveredPixels(r.X0, r.Y0, r.X1, r.Y1, reach), scan.Canvas);
      // A clip only ever SHRINKS what a coverer writes at alpha 1, and a rotated clip, whose shape this
      // arithmetic cannot bound, makes the coverer unusable rather than merely smaller.
      for (const c of stack) {
        if ((c.Cos ?? 1) !== 1 || (c.Sin ?? 0) !== 0) { covers = false; break; }
        const cw = c.W * d, ch = c.H * d;
        const cr = CornerReach(Math.max(c.RTL, c.RTR, c.RBR, c.RBL) * d, c.Smoothness);
        const cx0 = c.X * d, cy0 = c.Y * d;
        if (region !== null) region = IntersectRegions(region, CoveredRegion(cx0, cy0, cx0 + cw, cy0 + ch, cr));
        plain = IntersectPixelRect(plain, CoveredPixels(cx0, cy0, cx0 + cw, cy0 + ch, cr));
      }
      if (covers) {
        cover = region ?? (PixelRectEmpty(plain) ? EMPTY_COVER : [plain]);
        if (cover.length === 0) covers = false;
      }
    }
    // A fill is withheld only when it is itself opaque and reads nothing: the pixel argument would
    // survive a translucent P (it is overwritten either way), but a translucent fill is not what
    // this lever is for and a glass one would take a read out of the frame.
    const skippable = opaque;
    // A carve re-emits P at a sub-rect, so its fill must not depend on where that sub-rect is
    // (`resolveBgFill` reads `panelLocal` for every mode but `Color`) and its silhouette must be
    // the rect itself (a rounded P would be carved into square pieces).
    //
    // `BorderWidth === 0` is the STRICTER clause, and it is here rather than in `opaque` because
    // of what a piece's own transform does: `Push` scales `BorderBlur`, `BezelWidth`, `BorderFade`,
    // `Thickness` and the shadow terms by `avgScale`, which a thin piece necessarily changes. Every
    // one of those lanes is an EXACT no-op at `BorderWidth == 0` on a non-glass fill with no shadow
    // (`tests/Borderless.Program.test.ts` is the line-set proof for the border chain), so the
    // difference the transform makes cannot reach a pixel. At a non-zero border width it could.
    // An opaque IMAGE carves too: each piece is drawn alone with its UV window re-cut to the piece
    // (`_emitCarvedImage`), so the pixels are the ones the whole quad would have put there.
    const carvable = (flat || bg.Kind === 'Image') && skippable && radius === 0
      && rs.BorderWidth === 0 && rs.Thickness === 0;
    if (!covers && !skippable) return;
    scan.Fills.push({ Order: order, Raster: raster, Cover: cover, Covers: covers, Skippable: skippable, Carvable: carvable });
    scan.Nodes.push(node);
  };

  /** See `_occlusionRecord`: an image fill whose every pixel is alpha 1 this frame. */
  private _imageFillOpaque = (node: Jiv): boolean => {
    const bg = node.RenderStyle.Background;
    if (bg.Kind !== 'Image' || bg.Fit !== 'Cover') return false;
    const e = this._imageCache.Get(bg.Url);
    if (e == null || !e.Ready || e.Opaque !== true) return false;
    if (node.BgImageFadeUrl !== bg.Url) return false;
    return performance.now() - node.BgImageFadeStartMs >= Canvas._BG_IMAGE_FADE_MS;
  };

  /** THE OCCLUSION PRE-PASS. Every fill the coming walk would emit, in the order it would emit
   *  them, ruled on before the first of them is pushed.
   *
   *  It is a PRE-pass and not a walk-time test because it cannot be one: a coverer is by definition
   *  later in paint order than what it covers, so at the instant the walk would emit P the thing
   *  that makes P invisible has not been reached. What it does NOT do is answer "which nodes paint,
   *  in what order" for itself -- it runs `_blurFirstNode`, the traversal `?blur-first` and
   *  `?blur-phased` already share, so there is one answer and `coverers=<planned>/<seen>` on the
   *  gate line is what says the walk agreed. */
  private _occlusionPrepass = (w: number, h: number): void => {
    const st = this._occlusionStats;
    this._occlusionPlan.clear();
    this._occlusionCoverers.clear();
    st.Candidates = 0; st.Coverers = 0; st.Reads = 0; st.Nodes = 0;
    st.Skipped = 0; st.Carved = 0; st.Pieces = 0; st.Px = 0;
    st.CoverersSeen = 0; st.Missed = 0; st.Ms = 0; st.Vacuous = 0;
    st.Notes = NewOcclusionNotes();
    if (!this._occlusion || this._diagNoUi) return;
    const t0 = performance.now();
    const scan: OcclusionScan = {
      Order: 0, Fills: [], Nodes: [], Reads: [],
      Canvas: { X0: 0, Y0: 0, X1: w, Y1: h },
      CanvasRegion: [{ X0: 0, Y0: 0, X1: w, Y1: h }],
      MinAreaPx: w * h * OCCLUSION_MIN_AREA_FRACTION,
    };
    this._occlusionScan = scan;
    const scope: TeleportScope = { Deferred: [], Stack: EmptyClipStack };
    this._blurFirstNode(this.Root, MAT_IDENTITY, EmptyClipStack, scope, null, null, w, h);
    this._blurFirstReplay(scope, w, h);
    this._occlusionScan = null;
    st.Nodes = scan.Order;
    st.Reads = scan.Reads.length;
    st.Candidates = scan.Fills.length;
    const plan = PlanOcclusion(
      scan.Fills, scan.Reads, { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: scan.MinAreaPx }, st.Notes);
    // A node the traversal reached TWICE (a teleport replayed into a layered scope) has two paint
    // points and one entry in a map keyed by the node, so its verdict is dropped rather than
    // applied to whichever of the two the walk hits first.
    const twice = new Set<Jiv>();
    const once = new Set<Jiv>();
    for (const n of scan.Nodes) { if (once.has(n)) twice.add(n); else once.add(n); }
    for (let i = 0; i < scan.Fills.length; i++) {
      const node = scan.Nodes[i];
      if (twice.has(node)) continue;
      if (scan.Fills[i].Covers) { st.Coverers++; this._occlusionCoverers.add(node); }
      const v = plan.get(scan.Fills[i].Order);
      if (JauiTracing()) {
        const f = scan.Fills[i];
        const k = `${node.Classes.join('.') || '-'}:${v === undefined ? 'draw' : v.Kind}${f.Covers ? '+covers' : ''}${f.Carvable ? '+carvable' : ''}`;
        this._awake.Occ.set(k, (this._awake.Occ.get(k) ?? 0) + 1);
      }
      if (v === undefined) continue;
      this._occlusionPlan.set(node, v);
      st.Px += v.Px;
      if (v.Kind === 'Skip') st.Skipped++;
      else { st.Carved++; st.Pieces += v.Pieces.length; }
    }
    st.Missed = this._occlusionPlan.size;
    // THE DEAD-PRE-PASS ALARM. Two candidates and a coverer is a frame where this lever had
    // something to rule on; nothing withheld on such a frame is the shape a 0-px pixel gate cannot
    // tell from a no-op, and it is exactly what both machines read for a whole phase while the fold
    // was quoted as a measurement. `st.Notes` says WHICH clause refused; this says THAT one did.
    st.Vacuous = st.Candidates >= 2 && st.Coverers >= 1 && st.Pieces === 0 && st.Skipped === 0 ? 1 : 0;
    st.Ms = performance.now() - t0;
  };

  /** Re-emit a carved fill as the pieces the cover left behind.
   *
   *  Through `Push` with a synthetic scale-and-translate, never by writing instance floats: the
   *  instance that comes out differs from the one P would have pushed in `a_Rect` and
   *  `a_PanelGeom` alone, and every other lane -- colour, radii, opacity, grade, clip, border mode
   *  -- is the same expression on the same style. A piece's new edges are whole device
   *  coordinates, so no pixel centre lies within half a pixel of one and its alpha is exactly the
   *  1 P had there; an edge clamped back onto P's OWN edge keeps P's own feather unchanged. */
  private _emitCarvedFill = (
    node: Jiv, eff: Mat2x3, pieces: readonly PixelRect[],
    clipOffset: number, clipCount: number, borderMode: 'Normal' | 'Suppress',
  ): void => {
    const d = this._dpr;
    const r = this._occlusionShapeRect(node, eff);
    for (const p of pieces) {
      const clamped = {
        X0: Math.max(r.X0, p.X0), Y0: Math.max(r.Y0, p.Y0),
        X1: Math.min(r.X1, p.X1), Y1: Math.min(r.Y1, p.Y1),
      };
      if (clamped.X1 <= clamped.X0 || clamped.Y1 <= clamped.Y0) continue;
      const m = CarvePieceTransform(clamped, node.X, node.Y, node.Width, node.Height, d);
      this._panelBuffer.Push(node, d, m, clipOffset, clipCount, -1, borderMode);
    }
  };

  /** `_emitCarvedFill` for an opaque IMAGE fill. The image's UV window is a batch uniform and a
   *  piece's panelLocal runs 0..1 over the PIECE, so each piece draws alone with the window re-cut
   *  to the piece's share of the whole rect -- the same texel lands on the same device pixel. */
  private _emitCarvedImage = (
    node: Jiv, eff: Mat2x3, pieces: readonly PixelRect[],
    clipOffset: number, clipCount: number, borderMode: 'Normal' | 'Suppress', w: number, h: number,
  ): void => {
    const base = this._computeBgPaint(node);
    if (base === undefined || base.Mode !== 'Image') return;
    const r = this._renderer;
    const d = this._dpr;
    const full = this._occlusionShapeRect(node, eff);
    const fw = full.X1 - full.X0, fh = full.Y1 - full.Y0;
    if (fw <= 0 || fh <= 0) return;
    for (const p of pieces) {
      const c = {
        X0: Math.max(full.X0, p.X0), Y0: Math.max(full.Y0, p.Y0),
        X1: Math.min(full.X1, p.X1), Y1: Math.min(full.Y1, p.Y1),
      };
      if (c.X1 <= c.X0 || c.Y1 <= c.Y0) continue;
      const sx = (c.X1 - c.X0) / fw, sy = (c.Y1 - c.Y0) / fh;
      const ox = (c.X0 - full.X0) / fw, oy = (c.Y0 - full.Y0) / fh;
      const paint: BgPaint = {
        ...base,
        UvScaleX: base.UvScaleX * sx, UvScaleY: base.UvScaleY * sy,
        UvOffsetX: base.UvOffsetX + base.UvScaleX * ox, UvOffsetY: base.UvOffsetY + base.UvScaleY * oy,
      };
      this._bcNoteBgPaint(paint);
      const m = CarvePieceTransform(c, node.X, node.Y, node.Width, node.Height, d);
      this._panelBuffer.Begin();
      this._panelBuffer.Push(node, d, m, clipOffset, clipCount, -1, borderMode);
      r.EnableBlend();
      r.PanelBeginBatch();
      r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
      r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
      r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
      r.PanelDrawBatch(w, h, null, 0, false, null, paint);
      this._counts.Panels++;
      this._counts.Image++;
      this._panelBuffer.Begin();
    }
  };

  /** Build every pyramid the coming walk would build, in the order it would build them. */
  private _blurFirstPrepass = (w: number, h: number): void => {
    this._blurFirstFill.clear();
    this._blurFirstKeys.clear();
    const st = this._blurFirstStats;
    st.Fill = 0; st.Used = 0; st.Missed = 0; st.Dup = 0; st.Coarse = 0;
    const scope: TeleportScope = { Deferred: [], Stack: EmptyClipStack };
    this._blurFirstNode(this.Root, MAT_IDENTITY, EmptyClipStack, scope, null, null, w, h);
    this._blurFirstReplay(scope, w, h);
    st.Chains = this._blurFirstKeys.size;
    st.Keys = [...this._blurFirstKeys].join('+');
    // BlurPass leaves its own level FBO bound; the walk's first draw expects the scene. `'scene'`
    // is not an encoder end by definition, so this bind is silent in the ledger.
    this._renderer.RebindSceneTarget();
  };

  private _blurFirstReplay = (scope: TeleportScope, w: number, h: number): void => {
    while (scope.Deferred.length > 0) {
      const items = scope.Deferred.sort((a, b) => a.N.TeleportSeq - b.N.TeleportSeq);
      scope.Deferred = [];
      for (const d of items) {
        // A teleported node is painted out of its own container's slot in the order, so it is not
        // a sibling of anything the walk is inside. `null` never matches a real parent, which is
        // what keeps it out of every group rather than putting it in the wrong one.
        if (this._glassGroupScan !== null) this._glassGroupParent = null;
        this._blurFirstNode(d.N, d.M, scope.Stack, scope, d.MH, d.P, w, h);
      }
    }
  };

  private _blurFirstNode = (
    node: Jiv, m: Mat2x3, stack: ClipStack, scope: TeleportScope,
    mH: Mat3x3 | null, persp: PerspCtx | null, w: number, h: number,
  ): void => {
    const eff = this._composeTransform(node, m, mH, persp);
    const effH = this._xfH;
    const childPersp = this._xfPersp;
    if (!this._isInsideClipStack(node, eff, stack, effH)) {
      if (node.ClipsChildren) return;
      this._blurFirstDescend(node, eff, stack, scope, effH, childPersp, w, h);
      return;
    }
    if (this._damageCulls(node, eff, effH)) {
      if (node.ClipsChildren) return;
      this._blurFirstDescend(node, eff, stack, scope, effH, childPersp, w, h);
      return;
    }
    if (node.Width <= 0 || node.Height <= 0 || !node.Visible) {
      this._blurFirstDescend(node, eff, stack, scope, effH, childPersp, w, h);
      return;
    }
    // THE OCCLUSION PRE-PASS rides this traversal rather than copying it. It builds nothing, so it
    // returns before the build site. This is the node's paint point, which is what makes
    // `scan.Order` the paint order.
    const scan = this._occlusionScan;
    if (scan !== null) {
      this._occlusionRecord(scan, node, eff, stack, effH);
      this._blurFirstDescend(node, eff, stack, scope, effH, childPersp, w, h);
      return;
    }
    // The pblur branch is tested FIRST in the walk and wins, so a ProgressiveBlur surface never
    // reaches the glass fill. Its own pyramid is NOT pre-built: it is seeded from a snapshot of
    // the scene-so-far, so moving it in front of the bed would change what it samples rather than
    // only when it is built. Those stay in the walk and the report says how many did.
    const isPblur = node.RenderStyle.Material === 'ProgressiveBlur' && this._pblurOn(node);
    if (isPblur && this._phasedWalk) this._phasedStrays.Pblur++;
    if (!isPblur && this._glassFillTakesPyramid(node)
        && this._blurFirstBuild(this._blurFirstFill, node, this._glassFillBlurPlan(node, eff, effH, w, h), w, h)) {
      this._blurFirstStats.Fill++;
    }
    this._blurFirstDescend(node, eff, stack, scope, effH, childPersp, w, h);
  };

  private _blurFirstDescend = (
    node: Jiv, eff: Mat2x3, stack: ClipStack, scope: TeleportScope,
    effH: Mat3x3 | null, persp: PerspCtx | null, w: number, h: number,
  ): void => {
    const boxClip = this._boxClip(node, eff);
    const childM = this._descendOffset(node, eff);
    let childMH = effH;
    if (effH !== null && node.Overflow === 'Scroll') {
      childMH = mat3Mul(effH, mat3FromAffine([1, 0, 0, 1, -node.ScrollX, -node.ScrollY]));
    }
    for (const child of this._orderedChildren(node)) {
      const clip = this._childClip(node, stack, boxClip, child);
      const pin = child.ChildLayout.Position === 'Pinned' && node.Overflow === 'Scroll';
      const cM = pin ? eff : childM;
      const cMH = pin ? effH : childMH;
      if (child.TeleportSeq !== 0) {
        scope.Deferred.push({ N: child, M: cM, MH: cMH, P: persp });
        continue;
      }
      // `?glass-group`: WHOSE CHILD IS ABOUT TO BE VISITED. Re-set before every child rather
      // than once before the loop, because the recursive descent inside the previous child
      // overwrote it. Only the scan reads it, so an unflagged pre-pass does not carry the write.
      if (this._glassGroupScan !== null) this._glassGroupParent = node;
      if (child.RenderStyle.Layer !== 0) {
        const childScope: TeleportScope = { Deferred: [], Stack: clip };
        this._blurFirstNode(child, cM, clip, childScope, cMH, persp, w, h);
        this._blurFirstReplay(childScope, w, h);
        continue;
      }
      this._blurFirstNode(child, cM, clip, scope, cMH, persp, w, h);
    }
  };

  /** One pre-pass build: the walk's two calls, and the pool bookkeeping that says what the pool
   *  actually did with them. False when the build was refused, so the caller's count stays a count
   *  of pyramids the walk can actually collect. */
  private _blurFirstBuild = (
    into: Map<Jiv, GpuTextureHandle>, node: Jiv, plan: GlassBlurPlan, w: number, h: number,
  ): boolean => {
    // `?glass-group`: RECORD it, and build nothing. A group is a property of a RUN of siblings, so
    // it cannot be decided one member at a time -- and unlike the atlas, the build is not deferred
    // to the end of a phase either: it happens in the REAL walk, at whichever member of the group
    // the walk reaches first, because the law this flag implements is about WHEN the backdrop is
    // captured. This branch is first in the method so an unflagged pre-pass does not carry it, and
    // it hangs off `_blurFirstBuild` rather than off the traversal so the plan it records is the
    // one `_glassFillBlurPlan` already resolved for this node -- one resolver, two call sites, and
    // no way for the scan to disagree with the walk about which surfaces build or over what rect.
    const gscan = this._glassGroupScan;
    if (gscan !== null) {
      gscan.push({ Node: node, Parent: this._glassGroupParent, Plan: plan });
      return true;
    }
    const st = this._blurFirstStats;
    // One instance per node per site. A second build for the same key would overwrite the handle
    // and leave the first consumer reading someone else's map, so it is refused and counted.
    if (into.has(node)) { st.Dup++; return false; }
    // `?pyramid-atlas`: RECORD it. The build happens once the whole phase is known, because a
    // slot layout is a property of the phase and not of a member. It still counts here, and the
    // walk still collects its handle from `into`, so the gate's `built`/`used`/`missed` mean
    // exactly what they mean on the per-card path.
    const collect = this._atlasCollect;
    if (collect !== null) {
      if (collect.some((c) => c.Into === into && c.Node === node)) { st.Dup++; return false; }
      collect.push({ Into: into, Node: node, Plan: plan });
      return true;
    }
    return this._prepassIssue(into, node, plan, w, h);
  };

  /** `?glass-presample`: may THIS surface's build re-base onto a pre-downsampled source?
   *
   *  One clause, and it is the one `BlurPass` cannot ask for itself. A re-based build returns a
   *  level 0 at `1/k` of device resolution, so every mip `GenerateBlurMipmap` then builds on it
   *  stands for a LOD one step deeper than the consumer's `baseFrostLod` subtraction assumes --
   *  a real change of picture for a mip consumer, not the sub-level reconstruction difference
   *  the flag is about. `MaxLod == 0` is the case where `GenerateBlurMipmap` only ever calls
   *  `DisableMipmap` and the consumer's `textureLod` resolves to level 0 whatever LOD it works
   *  out, which is the same clause `PlanBorderDirect` and `AtlasAdmitsMember` open with.
   *
   *  Everything else -- the sigma, the region, the depth's room for the factor -- is
   *  `PresamplePlanFor`'s, asked inside the pass so there is one answer and not two. */
  private _mayPresample = (plan: GlassBlurPlan): boolean =>
    this._glassPresample && plan.MaxLod === 0;

  /** May THIS surface's backdrop be produced by a separable path -- the default plan, or the
   *  `?glass-gaussian` arm?
   *
   *  ONE clause, and it is the same one `_mayPresample` carries and for a stronger reason: a
   *  Gaussian build writes LEVEL 0 and nothing above it, so a consumer that samples a mip would
   *  read whatever the chain left in the level FBOs on some earlier frame. At `MaxLod == 0`
   *  `GenerateBlurMipmap` only ever calls `DisableMipmap` and `Jiv.Panel.frag`'s `textureLod`
   *  resolves to level 0 whatever LOD it works out -- which is every glass surface in this app.
   *
   *  Everything else -- the sigma, the kernel's size, the `match` arm's calibration, the k --
   *  is `PlanGaussian`'s, asked inside the pass so there is one answer and not two.
   *
   *  SHALLOW MIP CONSUMERS TAKE THE SEPARABLE PLAN TOO (`?blur-mips`). The "stale level" reason above
   *  is the Gaussian arm's and not the separable plan's: `_blurSeparable` writes `_levels[0]` of the
   *  chain `_useChain` selected for its base, and `GenerateOutputMipmap` then builds mips 1..N by
   *  halving FROM that level -- the same stack the chain would have built on its own level 0. What
   *  does change is the scale of one LOD step when the plan re-bases (`k > 1`): level 0 is at `1/k`
   *  of device resolution, so each further level adds a hop `k` times wider than the chain's. On a
   *  pyramid built at the panel's own frost that hop is small beside the frost itself -- the hero
   *  pill reads LOD 0.5 over sigma 12.7 device px, a rim band a few percent wider -- and the cap of
   *  one LOD keeps it that way. This is the phone's hero: the pill's `BorderFilter: Blur(0.5pt)`
   *  made it a mip consumer, and its fill and rim each paid the 8-pass chain every scrolled frame. */
  private _maySeparable = (plan: GlassBlurPlan): boolean =>
    plan.MaxLod === 0
      ? this._glassGaussian !== 'off' || this._blurSeparable
      : this._blurSeparable && this._glassGaussian === 'off' && this._blurSeparableMips
        && plan.MaxLod <= SEPARABLE_MIP_MAX_LOD;

  /** Issue ONE per-surface build: the walk's two calls, and the pool bookkeeping. This is the
   *  path `?blur-first`, `?blur-phased` and every atlas REFUSAL take, and it is the engine as it
   *  ships -- which is why a refusal is safe rather than a degradation. */
  private _prepassIssue = (
    into: Map<Jiv, GpuTextureHandle>, node: Jiv, plan: GlassBlurPlan, w: number, h: number,
  ): boolean => {
    const r = this._renderer;
    const st = this._blurFirstStats;
    const t0 = performance.now();
    const handle = r.ComputeBlur(r.SceneTexture, w, h, plan.Radius, undefined, plan.Region,
      this._mayPresample(plan), this._maySeparable(plan));
    const t1 = performance.now();
    r.GenerateBlurMipmap(plan.MaxLod);
    this._opMs.Blur += t1 - t0;
    this._opMs.Mip += performance.now() - t1;
    into.set(node, handle);
    // `?blur-phased` runs the adaptive-shadow probes over this list after the phase, so the probe
    // rides the end the build already paid. Recorded here rather than re-derived, because the
    // probe's rect and detail LOD come out of the SAME plan this build was issued from.
    if (this._phasedWalk) this._phasedBuilt.push({ Node: node, Plan: plan, Handle: handle });
    // The pool's own chain key, from the pool's own functions. `_useChain` keys on the resolved
    // level-0 size, so this is the number that says how many sets of level textures forty builds
    // resolve to — and therefore how many of them can be held at once.
    // `?glass-presample` re-bases this build, so the pool's key is the PRE-DOWNSAMPLED size and
    // this arithmetic has to take the same branch `Blur` took or `_blurFirstKeys` names chains
    // that were never asked for. The phase is the same either way -- `k * 2^(D - log2 k)` is
    // `2^D` -- so only the rect's DIVISOR moves, which is exactly what the pool keys on.
    const presampled = this._mayPresample(plan)
      ? PresamplePlanFor(plan.Radius, w, h, plan.Region, 0) : null;
    const k = presampled !== null
      ? presampled.K : BaseDownsampleFactor(plan.Radius, w, h, plan.Region);
    if (k > 1) st.Coarse++;
    const depth = plan.Radius > 0
      ? (presampled !== null ? presampled.Depth : PyramidDepth(plan.Radius / k, 0)) : 0;
    const rect = ResolveRegionRect(plan.Region, w, h, k * (1 << depth));
    this._blurFirstKeys.add(`${rect.W}x${rect.H}`);
    return true;
  };

  /** `?glass-group`: PLAN THE FRAME'S GROUPS, before the walk and without building anything.
   *
   *  Two steps, and they are separate because they answer different questions. The SCAN rides
   *  `_blurFirstNode` -- the same traversal, the same culls, the same `_glassFillBlurPlan` the
   *  walk's fill site calls -- so there is one answer to "which surfaces build and over what
   *  region" and not two. The PARTITION is a run-length pass over what it recorded.
   *
   *  It issues no GL. The pyramids are built in the REAL walk, each at its own group's first
   *  member, which is the entire content of the law this flag implements: a backdrop is a time,
   *  and the time is the walk's arrival at the container. A pre-pass that built them all here
   *  would be `?blur-phased` with extra arithmetic -- every group captured at the same instant,
   *  which is exactly the composition the ruling did NOT make.
   */
  private _glassGroupPrepass = (w: number, h: number): void => {
    this._glassGroups.clear();
    this._glassGroupHandles.clear();
    this._groupShadow.clear();
    this._shadowProbeStats.Grouped = 0;
    this._shadowProbeStats.Moved = 0;
    const st = this._glassGroupStats;
    st.Groups = 0; st.Builds = 0; st.Members = 0; st.Fallbacks = 0;
    st.Solo = 0; st.MaxLod = 0; st.Unplanned = 0; st.Rects = ''; st.Why = 'none';
    const scan: { Node: Jiv; Parent: Jiv | null; Plan: GlassBlurPlan }[] = [];
    this._glassGroupScan = scan;
    this._glassGroupParent = null;
    const scope: TeleportScope = { Deferred: [], Stack: EmptyClipStack };
    this._blurFirstNode(this.Root, MAT_IDENTITY, EmptyClipStack, scope, null, null, w, h);
    this._blurFirstReplay(scope, w, h);
    this._glassGroupScan = null;
    this._glassGroupParent = null;
    this._planGlassGroups(scan, w, h);
  };

  /** Cut the scanned fills into GROUPS and plan a union pyramid for each.
   *
   *  A run ends on any of three things, and each is the law rather than a heuristic:
   *
   *   - A DIFFERENT PARENT. The group IS the container, so a sibling of someone else starts one.
   *     A glass surface nested inside an intervening sibling has a different parent and therefore
   *     ends the run: it is a different container, it paints between two members, and Apple's own
   *     rule is that glass in a different container is exactly the case that does NOT share a
   *     sampling region. Ending the run keeps "a group entered later sees the earlier group's
   *     glass" true in both directions.
   *   - A DIFFERENT SIGMA. `k`, `depth` and the phase grid all come off the radius, so mixing two
   *     radii in one pyramid is a resample and not a crop.
   *   - THE PLANNER. `PlanBackdropUnion` refuses a class whose members disagree on `k`, a rect the
   *     canvas edge clamped off the phase grid, a member the union does not contain, or a union
   *     that costs more fill than its members do. Every refusal falls back to TODAY'S ENGINE,
   *     which is the only degradation this lane is willing to have.
   *
   *  A MIP CONSUMER (`MaxLod > 0`) can never JOIN a group and does not END one either. A union's
   *  identity only ever covers level 0: `GenerateOutputMipmap` halves from level 0's own origin,
   *  so two regions that agree on the level-0 grid stop agreeing as soon as the chain goes deeper
   *  than the phase they were snapped to. It is refused on its own terms, its neighbours' run
   *  continues around it, and it builds its own pyramid in the walk from the scene as it stands
   *  there. Today every `JwiftGlass` fill is exactly 0 here, which is what makes a group
   *  thinkable at all; it is the same clause `AtlasAdmitsMember` and `PlanBorderDirect` open with.
   *
   *  A NON-GLASS sibling between two members does not split anything, and that is deliberate: the
   *  scan never saw it, and by the law its paint is inside the group and therefore not sampled.
   *
   *  A run of ONE is not a group. Its union would be its own region, so it would pay a build to
   *  save nothing -- `PlanBackdropUnion`'s first condition -- and it takes the path it takes
   *  today, byte for byte.
   *
   *  -- THE ESCAPE HATCH, DESIGNED AND DELIBERATELY NOT BUILT --------------------------------
   *
   *  Apple's `GlassEffectContainer` is an AUTHORED container, not a structural one: two glass
   *  elements in different parts of a view tree can be put in one container and share a sampling
   *  region. The tree-shaped rule above is the right DEFAULT -- it needs no authoring, it is what
   *  a designer already means by "these cards", and it cannot silently merge two things that only
   *  look adjacent -- but it cannot express a toolbar whose chips are wrapped in per-chip layout
   *  boxes, which is the shape that will ask for this first.
   *
   *  The hatch, when someone needs it, is ONE style property and no new machinery:
   *
   *      GlassGroup: <name>          // a string on the glass surface itself, inherited by nobody
   *
   *  and one line in the partition: the run key becomes `node.RenderStyle.GlassGroup || parent`
   *  instead of `parent`. Everything downstream is unchanged, because everything downstream
   *  already works on a run of members and a radius -- `PlanBackdropUnion` never asked who the
   *  parent was.
   *
   *  Three things it must NOT do, and they are why it is a design note rather than a patch:
   *  a named group may not span a LAYER boundary or a teleport (the walk paints those elsewhere,
   *  so "the scene as of group entry" would name two different instants); it may not span a clip
   *  stack, or the union's rect would cover texels no member may read; and it must still end the
   *  run on a radius change, because the whole identity argument is one sigma per pyramid. None
   *  of those is hard and all of them need a test each, which is a lane and not a line.
   */
  private _planGlassGroups = (
    scan: readonly { Node: Jiv; Parent: Jiv | null; Plan: GlassBlurPlan }[], w: number, h: number,
  ): void => {
    const st = this._glassGroupStats;
    const rects: string[] = [];
    // Every fallback's reason, by name: see `Glass.Group.Why.ts`.
    const why: GlassSoloReason[] = [];
    const entries = scan.map((c) => ({ Parent: c.Parent, Radius: c.Plan.Radius, MaxLod: c.Plan.MaxLod }));
    const at = new Map(scan.map((c, i) => [c, i]));
    let run: { Node: Jiv; Parent: Jiv | null; Plan: GlassBlurPlan }[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const members = run;
      run = [];
      if (members.length < 2) {
        st.Solo += members.length; st.Fallbacks += members.length;
        why.push(GlassSoloReasonAt(entries, at.get(members[0])!));
        return;
      }
      const radius = members[0].Plan.Radius;
      const plan = PlanBackdropUnion(members.map((m) => m.Plan.Region), w, h, radius);
      if (plan === null) {
        st.Unplanned += members.length; st.Fallbacks += members.length;
        for (let i = 0; i < members.length; i++) why.push('planner-refused');
        return;
      }
      const group: GlassGroup = {
        Members: members.map((m) => m.Node), Plans: members.map((m) => m.Plan), Radius: radius, Plan: plan,
      };
      for (const m of members) this._glassGroups.set(m.Node, group);
      st.Groups++;
      rects.push(`${plan.RectW}x${plan.RectH}@k${plan.K}/d${plan.Depth}x${members.length}`);
    };
    for (const c of scan) {
      if (c.Plan.MaxLod > 0) { st.MaxLod++; st.Fallbacks++; why.push('mip-consumer'); continue; }
      const head = run.length === 0 ? null : run[0];
      if (head !== null
          && (c.Parent === null || c.Parent !== head.Parent || c.Plan.Radius !== head.Plan.Radius)) {
        flush();
      }
      if (c.Parent === null) { st.Solo++; st.Fallbacks++; why.push('no-parent'); continue; }
      run.push(c);
    }
    flush();
    st.Rects = rects.length === 0 ? 'none' : rects.join('+');
    st.Why = GlassSoloTally(why);
  };

  /** `?glass-group`: THE CAPTURE, and the handle every member of the group takes from it.
   *
   *  Null when this surface is in no group, which is every surface on an unflagged frame and
   *  every surface the planner refused. Non-null means the group's pyramid is now built, and the
   *  FIRST call for a group is the one that builds it -- from the live scene, at this point in
   *  the walk, before any member has painted. That is the law, and it is the walk's own ordering
   *  that enforces it rather than a recorded timestamp.
   *
   *  ONE HANDLE SERVES EVERY MEMBER, with no per-member crop, and that is not a shortcut. A
   *  `BackdropRegion` is a map from SCREEN UV into the pyramid -- `screenUv * width/rect.W` minus
   *  `rect.X/rect.W` -- so it is a function of the built RECT alone and says nothing about who is
   *  sampling. `Jiv.Panel.frag`'s two mads land each member's own fragments on its own part of the
   *  union, texel exact, because `PlanBackdropUnion` snapped the union to the same phase grid
   *  every member's own rect was snapped to. The atlas needed a region per member only because
   *  its members live in different SLOTS of one texture.
   *
   *  `region` is the member's LIVE region, re-derived by the walk from the same plan function the
   *  scan called. It is CHECKED against the union the scan planned rather than assumed equal:
   *  nothing runs between the scan and the walk, so they cannot differ today, but a member that
   *  reached outside its own group's pyramid would sample a clamped edge texel and read as a
   *  smear rather than as a crash. It falls back to its own build and says so on the gate.
   */
  private _glassGroupTake = (
    node: Jiv, region: { x: number; y: number; w: number; h: number }, w: number, h: number, dt: number,
  ): GpuTextureHandle | null => {
    const g = this._glassGroups.get(node);
    if (g === undefined) return null;
    const r = this._renderer;
    if (!(r instanceof WebGL2Renderer) || !_regionContains(g.Plan.Region, region)) {
      this._glassGroups.delete(node);
      this._glassGroupStats.Fallbacks++;
      // Probed at the capture against a pyramid it will not now sample: the walk probes it again
      // against its own, and the gate's `moved=` says the cell is void.
      if (this._groupShadow.delete(node)) this._shadowProbeStats.Moved++;
      return null;
    }
    const have = this._glassGroupHandles.get(node);
    if (have !== undefined) {
      this._glassGroupStats.Members++;
      r.NoteGroupMember();
      return have;
    }
    const t0 = performance.now();
    const handle = r.ComputeBlurGroup(
      r.SceneTexture, w, h, g.Radius, g.Plan.Region, g.Plan.K, g.Members.length,
    );
    const t1 = performance.now();
    // Every member is a `MaxLod == 0` consumer -- `_planGlassGroups` refuses the rest -- so this
    // is `GenerateOutputMipmap`'s first branch: make the texture complete at the base level and
    // stop. Called anyway, once per group instead of once per member, because that branch is
    // where the sampler state is set and a level 0 left mip-incomplete samples black.
    r.GenerateBlurMipmap(0);
    this._opMs.Blur += t1 - t0;
    this._opMs.Mip += performance.now() - t1;
    // `?shadow-probe=group`: every member's probe, here, where the build has just ended the scene's
    // encoder and before any member paints. The batch rebinds the scene itself.
    if (this._shadowProbe !== 'group' || !this._glassGroupProbe(r, g, handle, dt)) r.RebindSceneTarget();
    for (const m of g.Members) this._glassGroupHandles.set(m, handle);
    const st = this._glassGroupStats;
    st.Builds++;
    st.Members++;
    r.NoteGroupMember();
    return handle;
  };

  /** `?shadow-probe=group`: THE GROUP'S ADAPTIVE-SHADOW PROBES, taken at its capture.
   *
   *  The walk's own arguments, from the plan the scan recorded for each member -- the rect, the
   *  detail LOD off the member's frost and base LOD, the group's handle as the pyramid, the live
   *  scene as the sharp tap -- exactly as `_phasedShadowProbes` takes them from `_phasedBuilt`.
   *  A member that takes a raw-scene SNAPSHOT is left to the walk: its sharp tap is that snapshot,
   *  taken at its own point in the walk, and there is no snapshot here to hand it. None does on
   *  glass-grid (every class there authors frost).
   *
   *  False when no member qualified, so the caller still owes the scene its rebind. */
  private _glassGroupProbe = (r: WebGL2Renderer, g: GlassGroup, handle: GpuTextureHandle, dt: number): boolean => {
    const d = this._dpr;
    const probes: ShadowProbe[] = [];
    const nodes: Jiv[] = [];
    for (let i = 0; i < g.Members.length; i++) {
      const plan = g.Plans[i];
      if (!plan.AdaptiveShadow || plan.InstFrostLod < SCENE_TAP_FROST_LOD) continue;
      probes.push({
        Key: g.Members[i],
        Rect: { x: plan.Px, y: plan.Py, w: plan.Pw, h: plan.Ph },
        DetailLod: Math.log2(Math.max(plan.FrostCssPx, SHADOW_DETAIL_MIN_PT) * d) - plan.BaseFrostLod,
      });
      nodes.push(g.Members[i]);
    }
    if (probes.length === 0) return false;
    const slots = r.MeasureShadowBackdrops(probes, handle, r.SceneTexture, dt);
    for (let i = 0; i < nodes.length; i++) {
      if (slots[i] < 0) continue;
      this._groupShadow.set(nodes[i], { Slot: slots[i], Rect: probes[i].Rect });
    }
    return true;
  };

  /** Walk the tree before the blur pass to find the largest FrostBlur (CSS px).
   *  Reads from RenderStyle (resolved px), not Style (authorable string) so the
   *  blur pass picks the actually-rendered value. */
  private _scanFrostBlur = (node: Jiv): void => {
    // Any panel with BackdropFrostBlur needs the blur pyramid sized for it —
    // flat panels now sample backdrop too, so their frost blur counts here.
    if (node.Width > 0 && node.Height > 0 && node.Visible
        && node.RenderStyle.BackdropFrostBlur > this._maxFrostBlur) {
      this._maxFrostBlur = node.RenderStyle.BackdropFrostBlur;
    }
    for (const child of node.Children as Jiv[]) this._scanFrostBlur(child);
  };

  /** Resolve an SVG paint string to rgba, cached. Literal colors (rgba/#hex/named)
   *  cover every current consumer; a JSS-`@var` path can substitute here later. */
  private _resolveSvgColor = (raw: string): ReturnType<typeof ParseColor> => {
    let c = this._svgColorCache.get(raw);
    if (!c) { c = ParseColor(raw); this._svgColorCache.set(raw, c); }
    return c;
  };

  /** Draw a node's cached vector-SVG fills. Model = dpr · eff · (viewBox→nodeBox);
   *  each fill is one immediate triangle-soup draw with its resolved+opacity-folded tint. */
  private _emitSvgFor = (node: Jiv, eff: Mat2x3, w: number, h: number): void => {
    const svg = node.SvgVector;
    if (!svg || (svg.Fills.length === 0 && svg.Strokes.length === 0)) return;
    const [vx, vy, vw, vh] = svg.ViewBox;
    if (vw <= 0 || vh <= 0) return;
    const sx = node.Width / vw, sy = node.Height / vh;
    const local: Mat2x3 = [sx, 0, 0, sy, -vx * sx, -vy * sy];
    const dpr = this._dpr;
    const deff: Mat2x3 = [eff[0] * dpr, eff[1] * dpr, eff[2] * dpr, eff[3] * dpr, eff[4] * dpr, eff[5] * dpr];
    const m = matMul(deff, local);
    const model0: [number, number, number] = [m[0], m[2], m[4]];
    const model1: [number, number, number] = [m[1], m[3], m[5]];
    const nodeOp = node.EffectiveOpacity;
    if (this._bcOn) this._bcNoteSvgDraw(svg, 0, [...model0, ...model1], 0);
    this._renderer.EnableBlend();
    for (const fill of svg.Fills) {
      const c = this._resolveSvgColor(fill.ColorRaw);
      const a = c.A * fill.Opacity * nodeOp;
      if (a <= 0.001 || fill.VertCount === 0) continue;
      if (this._bcOn) this._bcNoteSvgDraw(fill.Verts, fill.VertCount, [c.R, c.G, c.B, a], 0);
      this._renderer.SvgFillDraw(fill.Verts, fill.VertCount, model0, model1, [c.R, c.G, c.B, a], w, h);
    }
    if (svg.Strokes.length > 0) {
      // viewBox→device scale (geometric mean of the affine's axis scales) → device-px half-width.
      const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
      for (const st of svg.Strokes) {
        const c = this._resolveSvgColor(st.ColorRaw);
        const a = c.A * st.Opacity * nodeOp;
        if (a <= 0.001 || st.SegmentCount === 0) continue;
        if (this._bcOn) this._bcNoteSvgDraw(st.Data, st.SegmentCount, [c.R, c.G, c.B, a], st.HalfWidth * scale);
        this._renderer.SvgStrokeDraw(st.Data, st.SegmentCount, model0, model1, [c.R, c.G, c.B, a], st.HalfWidth * scale, w, h);
      }
    }
    // SVG <text> runs → rasterized via the glyph cache + pushed to the shared text batch (drained
    // by the next flushText). Positions/rotation map through the run's transform folded with the
    // element model; SVG y is the baseline, anchor centers/ends the run.
    for (const run of svg.Texts) {
      if (!run.Text) continue;
      const c = this._resolveSvgColor(run.ColorRaw);
      const a = c.A * run.Opacity * nodeOp;
      if (a <= 0.001) continue;
      const ft = matMul(m, run.Transform as Mat2x3);
      const fScale = Math.sqrt(Math.abs(ft[0] * ft[3] - ft[1] * ft[2])) || 1;
      const sizeDev = run.FontSize * fScale;
      const style: ResolvedTextStyle = {
        FontFamily: 'Inter', FontSize: sizeDev / this._dpr, FontWeight: run.Weight, FontStyle: 'Normal',
        Color: c, LineHeight: 1.2, LetterSpacing: 0, // LineHeight is a multiplier, not px
        TextAlign: 'Left', TextAlignLast: 'Auto', TextOverflow: 'Clip', MaxLines: null,
      };
      const entry = this._textCache.Get(run.Text, style, null, this._dpr);
      const ax = matApplyX(ft, run.X, run.Y), ay = matApplyY(ft, run.X, run.Y);
      const shift = run.Anchor === 'middle' ? entry.Width / 2 : run.Anchor === 'end' ? entry.Width : 0;
      const cmd = this._textBuffer.Command();
      cmd.X = ax - shift; cmd.Y = ay - sizeDev * 0.8; // SVG y is baseline; ascent ≈ 0.8·size
      cmd.Width = entry.Width; cmd.Height = entry.Height;
      cmd.Uv = entry.Uv; cmd.Opacity = a;
      cmd.ClipOffset = 0; cmd.ClipCount = 0;
      cmd.TintR = c.R; cmd.TintG = c.G; cmd.TintB = c.B; cmd.TintA = 1;
      cmd.Cos = matCos(ft); cmd.Sin = matSin(ft); cmd.PivotX = ax; cmd.PivotY = ay;
      this._textBuffer.Push(cmd);
    }
  };

  /** `inkScale` is `TextFilter: Vibrancy()`'s |amount|, multiplied into the glyph instance's TINT lane
   *  (already an RGBA multiplier on the raster), so vibrant ink costs no attribute and no second atlas
   *  entry. RGB only: the premultiplied output multiplies by coverage once, and scaling the alpha too
   *  would square it and thin every antialiased edge. 1 is unscaled. */
  private _emitTextFor = (node: Jiv, m: Mat2x3, clipOffset: number, clipCount: number, xformIndex: number = -1, inkScale: number = 1): void => {
    if (node.Width <= 0 || node.Height <= 0 || !node.Visible) return;
    const anim = this._textAnimators.get(node);
    if (!anim || anim.Words.length === 0) return;

    // 3D path: this node is under a perspective tilt. Its homography already
    // lives in the shared table at `xformIndex`; each glyph is emitted in
    // NATURAL coords + that index, and the text vertex fetches + projects it
    // (perspective divide) just like a 3D panel. -1 = the ordinary 2D path.
    const dpr = this._dpr;
    const is3D = xformIndex >= 0;

    // Padding is a Length — resolve against this Jiv's ctx (populated by
    // the layout pass). ctx always exists post-layout; fall back to the
    // root's ctx if something went sideways to avoid NaN in the render.
    const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
    const [padT, , padB, padL] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    // Axis scales from the cascaded matrix (cx=cy=1 unscaled). Word ANCHORS go
    // through the full matrix so rotated text flows along the rotated baseline;
    // glyph quads ALSO tilt by the matrix rotation (cos/sin below) about the
    // node's center, so a rotated panel's text rotates with it as one unit.
    const cx = matScaleX(m);
    const cy = matScaleY(m);
    const tCos = matCos(m);
    const tSin = matSin(m);
    // Shared glyph pivot = the text node's center mapped to device px, so every
    // glyph rotates about the same point (the panel center) and stays cohesive.
    // centerLocal* is that center in LOCAL coords (used to build each glyph's
    // UNROTATED anchor; the shader applies the rotation about the pivot).
    const centerLocalX = node.X + node.Width * 0.5;
    const centerLocalY = node.Y + node.Height * 0.5;
    const pivotX = matApplyX(m, centerLocalX, centerLocalY) * this._dpr;
    const pivotY = matApplyY(m, centerLocalX, centerLocalY) * this._dpr;
    const cyForFold = cy > 1e-6 ? cy : 1; // guard the yOffset fold-into-local divide
    // Content origin + height in LOCAL (natural) coords; mapped per-word below.
    const contentLX = node.X + padL;
    const contentLY = node.Y + padT;
    const contentH = cy * (node.Height - padT - padB);

    let totalTextHeight = 0;
    for (const w of anim.Words) {
      const bottom = w.TargetY + w.Height;
      if (bottom > totalTextHeight) totalTextHeight = bottom;
    }
    const yOffset = (contentH - cy * totalTextHeight) / 2;

    // Pull the animator's effective FontWeight once (snapped to 25 in
    // Text.Animator). All words in a block transition together, so we
    // build the override style once outside the per-word loop. Loose
    // equality on style weight handles the case where some legacy code
    // path lets a string-typed weight reach this far.
    const effectiveWeight = anim.EffectiveWeight;
    const styleNeedsWeightOverride = effectiveWeight !== Number(anim.Style.FontWeight);
    for (const w of anim.Words) {
      const opacity = node.EffectiveOpacity * w.Opacity.Value;
      if (opacity <= 0.001) continue;
      // During a `:GroupHover` / `:Hover` weight transition, the cache
      // fetch uses the snapped current weight so the rasterized atlas
      // entry width agrees with the per-tick re-measured layout. After
      // the spring settles, `effectiveWeight === w.Style.FontWeight` and
      // we fall back to the original style identity (cheap path).
      const styleForCache = styleNeedsWeightOverride
        ? { ...w.Style, FontWeight: effectiveWeight }
        : w.Style;
      const entry = this._textCache.Get(w.Content, styleForCache, null, this._dpr);
      // Word anchor in LOCAL coords, then mapped through the full matrix. yOffset
      // is a canvas-space (cy-scaled) centering term; fold it back to local
      // (÷cy) so the matrix re-applies it correctly under rotation.
      const wlx = contentLX + w.SpringX.Value;
      const wly = contentLY + (yOffset / cyForFold) + w.SpringY.Value;
      // Glyph anchor in the UNROTATED (scale+translate-only) frame: the mapped
      // node center plus the scaled offset from the node center, with rotation
      // STRIPPED. The shader then rotates the quad about the same pivot, so the
      // final glyph is rotated exactly once. (Mapping through the full matrix
      // here AND rotating in the shader would double-rotate — the first-span
      // drift.) cx,cy,centerLocal*,pivot* are hoisted above the loop.
      const wx = pivotX / this._dpr + cx * (wlx - centerLocalX);
      const wy = pivotY / this._dpr + cy * (wly - centerLocalY);
      // Word-level Scale — used during a FontSize-only transition to make
      // the NEW-size raster look OLD-sized on frame 0 and spring to 1.0.
      // Scale around each word's center to keep layout anchored.
      const wordScale = w.Scale.Value;
      // Cascade the visual scale into the rendered glyph dimensions.
      const drawW = entry.Width * wordScale * cx;
      const drawH = entry.Height * wordScale * cy;
      const dxCenter = (entry.Width * cx - drawW) / 2 / this._dpr;
      const dyCenter = (entry.Height * cy - drawH) / 2 / this._dpr;
      if (is3D) {
        // Glyph rect in NODE-NATURAL coords; the shared homography + vertex
        // divide place + foreshorten it on the tilted plane. (entry.* are device.)
        const natW = (entry.Width / dpr) * wordScale;
        const natH = (entry.Height / dpr) * wordScale;
        const natX = wlx + (entry.Width / dpr - natW) / 2;
        const natY = wly + (entry.Height / dpr - natH) / 2;
        const cmd3 = this._textBuffer.Command();
        cmd3.X = natX; cmd3.Y = natY; cmd3.Width = natW; cmd3.Height = natH;
        cmd3.Uv = entry.Uv;
        cmd3.Opacity = opacity;
        cmd3.ClipOffset = clipOffset;
        cmd3.ClipCount = clipCount;
        // MULTIPLIED into the tint, not assigned over it: this lane already carries the
        // color-transition ratio (`oldColor/newColor`, decaying to 1), so an additive ink must
        // compose with a color change in flight rather than cancel it.
        cmd3.TintR = w.TintR.Value * inkScale;
        cmd3.TintG = w.TintG.Value * inkScale;
        cmd3.TintB = w.TintB.Value * inkScale;
        cmd3.TintA = w.TintA.Value;
        cmd3.XformIndex = xformIndex;
        this._textBuffer.Push(cmd3);
        continue;
      }
      const cmd = this._textBuffer.Command();
      cmd.X = wx * this._dpr + dxCenter * this._dpr;
      cmd.Y = wy * this._dpr + dyCenter * this._dpr;
      cmd.Width = drawW;
      cmd.Height = drawH;
      cmd.Uv = entry.Uv;
      cmd.Opacity = opacity;
      cmd.ClipOffset = clipOffset;
      cmd.ClipCount = clipCount;
      // See the 3D path above: multiplied, never assigned, and RGB only.
      cmd.TintR = w.TintR.Value * inkScale;
      cmd.TintG = w.TintG.Value * inkScale;
      cmd.TintB = w.TintB.Value * inkScale;
      cmd.TintA = w.TintA.Value;
      cmd.Cos = tCos;
      cmd.Sin = tSin;
      cmd.PivotX = pivotX;
      cmd.PivotY = pivotY;
      this._textBuffer.Push(cmd);
    }
  };

  private _processTextTransitions = (node: Jiv): void => {
    const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
    const [, padR, , padL] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    // LayoutWidth is the solver's last-computed target. node.Width is the
    // animator's mid-spring value, which would re-trigger text wrap every
    // frame as it animates. Reading the layout plane pins the wrap budget
    // to the final dimension so word positions are stable from the first
    // frame after content/layout changes.
    const contentW = node.LayoutWidth - padL - padR;
    const maxWidth = contentW > 0 ? contentW : null;
    const resolvedStyle = ResolveTextStyle(node.EffectiveTextStyle(), ctx);

    if (node.Text !== null) {
      let anim = this._textAnimators.get(node);
      if (!anim) {
        anim = new TextAnimator(resolvedStyle);
        this._textAnimators.set(node, anim);
        this._animationManager.Register(anim);
      }
      if (anim.Update(node.Text, resolvedStyle, maxWidth)) {
        this._animationManager.Kick();
      }
    } else {
      const anim = this._textAnimators.get(node);
      if (anim && anim.Content !== '') {
        if (anim.Update('', resolvedStyle, maxWidth)) {
          this._animationManager.Kick();
        }
      }
    }
    for (const child of node.Children as Jiv[]) this._processTextTransitions(child);
  };

  private _measureDirtyText = (node: Jiv): void => {
    if (node.Text !== null && (node.Dirty & DirtyFlag.Text || node.TextMeasurement === null)) {
      // Unbounded measurement — intrinsic sizing with padding is handled by ComputeIntrinsicSizes.
      // TextStyle holds Length fields (FontSize, LetterSpacing) — resolve against this Jiv's ctx.
      const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
      const resolved = ResolveTextStyle(node.EffectiveTextStyle(), ctx);
      // Measure at the target weight (resolved style). A previous version
      // measured at the animator's live spring weight so surrounding boxes
      // reflowed smoothly with the transition — visually nicer in isolation,
      // but in flex-wrap containers (tokenized input rows) the per-frame
      // width deltas crossed the wrap threshold mid-spring, popping rows up
      // and down repeatedly. Snapping to target width on frame 0 means
      // wrap is decided once and stays stable; the glyph weight then morphs
      // smoothly within the already-sized box (Text.Animator re-measures
      // internal word positions per tick at the raw weight, so word slots
      // inside the box still slide continuously).
      node.TextMeasurement = MeasureText(node.Text, resolved, null);
    } else if (node.Text === null) {
      node.TextMeasurement = null;
      // Only clear intrinsics if they weren't set by an image background.
      const bg = node.RenderStyle.Background;
      if (bg.Kind !== 'Image') {
        node.IntrinsicWidth = null;
        node.IntrinsicHeight = null;
      }
    }
    for (const child of node.Children as Jiv[]) this._measureDirtyText(child);
  };

  // ─── Layout Integration ───

  /** DirtyTracker.Notify — called from Element.MarkLayoutDirty for every
   *  node in this Canvas's tree. Cheap O(1) Set add; LCA / scope-root
   *  decision happens in `_chooseScopedRoot` at solve time, not here, to
   *  keep the dirty path branchless. Cleared after every solve. */
  Notify = (node: JauiElement): void => {
    this._dirtyNodes.add(node);
    if (JauiTracing()) {
      const cls = (node as unknown as { Classes?: readonly string[] }).Classes;
      const key = cls !== undefined && cls.length > 0 ? cls.join('.') : node.constructor?.name ?? '?';
      this._awake.Dirty.set(key, (this._awake.Dirty.get(key) ?? 0) + 1);
    }
    // The whole tree's dirty marks funnel through here -- `MarkLayoutDirty` is the only writer of
    // the Layout flag and it ends in this call -- which makes this the one place a parked loop can
    // learn that layout or text changed. Guarded on `_parked` inside `Wake`, so the ordinary case
    // is a single boolean test on a path that runs per dirty node.
    this.Wake();
  };

  /** Pick the smallest subtree we can re-solve in isolation this frame, or
   *  fall back to Root for the whole tree.
   *
   *  v1 heuristic: scope only when exactly one node is dirty AND we can
   *  walk up to an ancestor with explicit non-keyword Width AND Height in
   *  its ChildLayout (i.e., a fixed box whose size doesn't depend on its
   *  children's intrinsics). For multi-dirty cases, computing the LCA +
   *  intrinsic-escalation logic is more involved and isn't worth it until
   *  the scoped path is proven; full-tree solve falls through. */
  private _chooseScopedRoot = (): JauiElement => {
    if (this._dirtyNodes.size !== 1) return this.Root;
    let node: JauiElement | null = null;
    for (const n of this._dirtyNodes) { node = n; break; }
    if (!node || node === this.Root) return this.Root;

    // Walk up to the first ANCESTOR whose layout box doesn't depend on
    // child intrinsics. Width/Height as 'Auto' / 'MinContent' / 'MaxContent'
    // means parent size depends on the dirty subtree's own intrinsic — a
    // change there could propagate beyond the scope, so we keep climbing.
    // Anything else (numeric pt/px/vw/vh, percent, arithmetic) is a fixed
    // box from this subtree's perspective: parent isn't dirty, so its size
    // hasn't changed, and our re-solve is contained.
    //
    // Start at node.Parent, NOT node itself: subtree mode in SolveLayout
    // freezes the scope-root's Width/Height to the prior frame's values
    // (Layout.Solver.ts uses `root.Width` as the seed box), and
    // _solveAndAnimate explicitly skips the subtreeRoot from animator
    // updates. So if the dirty node is picked as its own scope, its newly-
    // mutated ChildLayout (e.g. a per-frame `Width: '12%'` on a scrub fill
    // driven from a playback RAF) is silently dropped — the percent never
    // gets re-resolved against the parent's actual width. Picking the
    // parent guarantees the dirty node appears as a child of the solve.
    let cur: JauiElement | null = node.Parent;
    while (cur !== null && cur !== this.Root) {
      const cl = cur.ChildLayout;
      const wFixed = cl.Width !== 'Auto' && cl.Width !== 'MinContent' && cl.Width !== 'MaxContent';
      const hFixed = cl.Height !== 'Auto' && cl.Height !== 'MinContent' && cl.Height !== 'MaxContent';
      if (wFixed && hFixed) {
        // Scope is only safe when the candidate's RESOLVED rect is stable.
        // `cur.ChildLayout.Width/Height` being a "fixed token" (`100%`, `100vh`,
        // a length expression) doesn't imply the resolved `cur.Width/Height`
        // is settled — `JivAnimator.Tick` writes `_element.Width = Springs.Width.Value`
        // every frame, so a candidate whose animator is mid-spring exposes a
        // transient value as its rect. `SolveLayout` in subtree mode seeds
        // `boxWidth = root.Width / boxHeight = root.Height`, then `_solveAndAnimate`
        // calls `animator.SetTargets(...)` on every descendant against that
        // mid-spring box. If a descendant's new target lands within `Spring.Set`'s
        // 0.1px deadband, the kick is skipped and the corrupted target sticks —
        // the trap that turned a Chrome page-zoom into a permanently-shifted
        // Drill editor panel that no subsequent zoom could recover.
        //
        // Skip candidates with an in-flight animator; keep climbing so the
        // scope-root is always a settled box. Falls back to Root when nothing
        // up the chain is stable, which yields the full-tree solve that
        // `_resize` already runs — i.e. the worst case is "no perf win for
        // a few frames during a resize-driven cascade," not "wrong layout."
        const anim = this._animators.get(cur);
        if (!anim
            || (anim.Springs.X.IsSettled
                && anim.Springs.Y.IsSettled
                && anim.Springs.Width.IsSettled
                && anim.Springs.Height.IsSettled)) {
          return cur;
        }
      }
      cur = cur.Parent;
    }
    return this.Root;
  };

  private _solveAndAnimate = (subtreeRoot: JauiElement = this.Root): void => {
    if (subtreeRoot === this.Root) {
      // Root fills the canvas (only meaningful on full-tree solves; in
      // subtree mode the box is fixed by the prior frame's solve and
      // SolveLayout reads it from root.LayoutWidth/Height directly).
      this.Root.Width = this._width;
      this.Root.Height = this._height;
      this.Root.LayoutWidth = this._width;
      this.Root.LayoutHeight = this._height;
    }

    // SolveLayout itself stamps the layout plane (LayoutX/Y/Width/Height)
    // on every solved node before returning — see Layout.Solver.ts. The
    // animator updates below still drive the render plane (node.X/Y/
    // Width/Height) so visuals continue to spring as before.
    const results = SolveLayout(subtreeRoot, this._viewport(), this._jssVars);

    for (const [node, result] of results) {
      // Skip the root — it doesn't animate to its own position. (When in
      // subtree mode `subtreeRoot !== this.Root`, but we still don't
      // animate the subtree-root either: its box was already fixed by the
      // prior solve and SolveLayout just reflected that into `results`.)
      if (node === this.Root || node === subtreeRoot) continue;

      // Non-finite tripwire. A NaN layout result means a degenerate solve
      // input (unresolvable Length, missing @var, NaN intrinsic) — Spring.Set
      // refuses the value so the node holds its last good rect, but the
      // PRODUCER is a real bug: name the node once so it gets fixed.
      if (!Number.isFinite(result.X) || !Number.isFinite(result.Y)
          || !Number.isFinite(result.Width) || !Number.isFinite(result.Height)) {
        if (!this._nonFiniteWarned.has(node)) {
          this._nonFiniteWarned.add(node);
          const classes = node instanceof Jiv ? node.Classes.join(' ') : '(element)';
          // eslint-disable-next-line no-console
          console.warn(`[Jaui] non-finite layout result for [${classes}]:`,
            { X: result.X, Y: result.Y, Width: result.Width, Height: result.Height });
        }
      }

      let animator = this._animators.get(node);
      if (!animator) {
        const springs = node instanceof Jiv ? node.Springs : null;
        animator = new JivAnimator(node, springs);
        animator.SetTargets({
          X: result.X, Y: result.Y, Width: result.Width, Height: result.Height,
        });
        animator.SnapToTargets();
        this._animators.set(node, animator);
        this._animationManager.Register(animator);

        // Style animator is Jiv-specific, it springs every animatable
        // JivStyle field toward EffectiveStyle. Only created for Jivs.
        if (node instanceof Jiv) {
          const styleAnim = new JivStyleAnimator(node);
          styleAnim.SnapToTargets();
          // A visual-only state flip (`:Hover` changing a Background, nothing metric) marks
          // nothing dirty and Kicks nothing -- Jiv._syncState only wakes the animator. Registered
          // animatables are stepped by StepFrame every tick, so before the park that was enough.
          // Parked there is no tick to be stepped by, so the wake has to travel with the flag.
          styleAnim.OnWake = this.Wake;
          this._styleAnimators.set(node, styleAnim);
          this._animationManager.Register(styleAnim);
          // Kick the rAF loop if the Jiv carries @Animation declarations
          // so the driver starts ticking immediately. Without this the
          // loop stays parked until something else (layout / hover / etc)
          // wakes it.
          if (node.Animations && node.Animations.length > 0) {
            this._animationManager.Kick();
          }
        }
      } else {
        // Teleport across a scroll-frame change: re-base the rect spring's CURRENT value by the cumulative
        // scroll delta captured at reparent, so the flight starts from where the node visually sits (not
        // its unscrolled layout position). Consumed once. Fixes the drag pickup/drop "hop" that scales
        // with the library's scroll offset.
        if (node.TeleportScrollDeltaX !== 0 || node.TeleportScrollDeltaY !== 0) {
          animator.Springs.X.Value += node.TeleportScrollDeltaX;
          animator.Springs.Y.Value += node.TeleportScrollDeltaY;
          // Also commit to the Element's rendered position THIS pass — the render reads node.X/Y, and the
          // animator's Tick (which normally writes them) runs after layout. Without this, the teleport
          // frame paints once at the old unscrolled position before the spring catches up: a 1-frame hop.
          node.X = animator.Springs.X.Value;
          node.Y = animator.Springs.Y.Value;
          node.TeleportScrollDeltaX = 0;
          node.TeleportScrollDeltaY = 0;
        }
        const needsKick = animator.SetTargets({
          X: result.X, Y: result.Y, Width: result.Width, Height: result.Height,
        });
        // A scoped predicate (`:(Self.Width > 600)`, `Ancestor(Card)`) makes this
        // Jiv's resolved style a function of the rect the solve just produced. The
        // box moved, not a state, so none of the existing marks fire — and
        // `RenderStyle` is only rewritten by a MARKED animator, so the style used
        // to catch up to the box one backstop re-resolve at a time. Both gates are
        // cheap flags: a node that never reads its own box, or whose box did not
        // move, pays nothing.
        if (needsKick && node instanceof Jiv && node.HasScopedPredicates) node.MarkStyleDirty();
        if (node.SnapLayout) {
          animator.SnapToTargets();
        } else if (needsKick) {
          this._animationManager.Kick();
        } else if (node.TeleportSeq !== 0) {
          // A node mid-teleport renders clip-free + elevated until JivAnimator.Tick
          // sees its rect spring settle and clears TeleportSeq. But when the home
          // target lands within Spring.Set's deadband, needsKick is false: no Kick,
          // so the loop never wakes, Tick never runs, and the elevation never drops —
          // the card stays unclipped forever. There's nothing to animate (it's already
          // home), so retire the elevation now.
          node.TeleportSeq = 0;
        }
      }
    }

    // Clean up animators for removed nodes
    // Gate on actual tree removal, not layout-results membership —
    // LeaveRequested nodes are skipped by the solver but still need
    // their style animator running so Opacity tracks Presence to 0.
    for (const [node, animator] of this._animators) {
      if (node.Parent === null) {
        this._animationManager.Unregister(animator);
        this._animators.delete(node);
      }
    }
    for (const [node, sAnim] of this._styleAnimators) {
      if (node.Parent === null) {
        this._animationManager.Unregister(sAnim);
        this._styleAnimators.delete(node);
      }
    }
    for (const [node, tAnim] of this._textAnimators) {
      if (node.Parent === null) {
        this._animationManager.Unregister(tAnim);
        this._textAnimators.delete(node);
      }
    }

  };

  private _clearDirty = (node: Jiv): void => {
    node.Dirty &= ~(DirtyFlag.Layout | DirtyFlag.Children | DirtyFlag.Text);
    for (const child of node.Children as Jiv[]) this._clearDirty(child);
  };

  /** Apply the newest pushed size + the live DPR to the canvas, the predicate viewport and the
   *  tree, and mark the tree for a solve. Returns true when something actually changed.
   *
   *  Split out of `_resize` because the two halves of a resize have different correct rates:
   *  APPLYING has to happen once per distinct size, PAINTING once per frame. The frame loop calls
   *  this one directly and lets its own solve+render -- a few lines further down the same tick --
   *  be the paint. Callers that are not already inside a frame call `_resize`, which adds the
   *  inline paint that bridges the framebuffer clear the `Element.width` write below performs. */
  private _applySize = (): boolean => {
    // Browser-zoom can push DPR above native (e.g. 125% on a 1.5x display = DPR 1.875).
    // Text cache naturally invalidates — its hash includes DPR — so higher DPR costs
    // memory/fill but keeps strokes crisp on desktop.
    //
    // Touch-primary devices (iPad, iPhone) are usually fragment-bound: an iPad Pro
    // at DPR 2 pushes ~5.6MP/frame, which the dual-filter blur chain can't sustain
    // at 60Hz. Clamp to 2 on those devices to preserve framerate — most iPad users
    // report native DPR 2 anyway, so this is a no-op today but protects against
    // future DPR 3 devices and 125% Safari zoom on DPR 2 displays.
    //
    // `?dpr=N` in the URL overrides both paths, so the user can A/B on device
    // without rebuilding. NaN/≤0 is ignored.
    const raw = this._platform.GetDevicePixelRatio();
    const override = this._dprOverride;
    const prevDpr = this._dpr;
    if (override !== null) {
      this._dpr = override;
    } else {
      const isTouchPrimary = this._platform.IsPointerCoarse();
      this._dpr = isTouchPrimary ? Math.min(raw, 2) : raw;
    }
    // Size always comes from ResizeObserver (or main-thread proxy in worker
    // mode) via _pendingResize. We never read clientWidth/Height on the
    // canvas itself: (a) it forces a synchronous layout flush on cold load
    // (~56ms reflow per Chrome's Performance analyzer), and (b) OffscreenCanvas
    // has no clientWidth/Height — the engine has to be size-pushed regardless.
    if (this._pendingResize) {
      const next = this._pendingResize;
      this._pendingResize = null;
      // An identical size is not a resize. Main re-posts the live rect on window-resize and on
      // visibility return, and `_settleSize` polls it at boot, so same-size messages are routine --
      // and each one used to buy a framebuffer clear and a full-tree solve+render for no change.
      if (next.width === this._width && next.height === this._height && this._dpr === prevDpr) return false;
      this._width = next.width;
      this._height = next.height;
    } else if (this._width === 0 || this._height === 0) {
      // Called before any size has been pushed. Nothing to apply; the first delivery into the slot
      // is what gives this canvas a size, and the tick drains that.
      return false;
    } else if (this._dpr === prevDpr) {
      // No new size and no DPR change. Two callers land here and both mean "nothing to do": the
      // matchMedia watcher re-arming on a DPR that didn't move, and a deferred `_resize()` (boot,
      // or the main-thread observer) that lost the race to the tick which already drained the slot.
      // Returning early is what keeps that loser from re-clearing the framebuffer and repainting a
      // frame the tick just painted.
      return false;
    }
    // Otherwise, keep the cached size and just re-apply DPR (this path is
    // taken by the matchMedia DPR change handler).
    this.Element.width = Math.round(this._width * this._dpr);
    this.Element.height = Math.round(this._height * this._dpr);

    // Responsive `@If`: publish the live viewport so style/text predicates
    // (which read the shared module viewport) see it, then re-materialize any
    // layout-bearing `@If` overrides before the solve below picks them up.
    SetPredicateViewport(this._width, this._height);
    this._recomputeResponsiveLayout(this.Root);

    // Re-rasterize cached SVGs if we just zoomed in — texture resolution is
    // baked at rasterization time, so without this logos stay pixelated at
    // the old DPR even after the browser hands us more device pixels.
    if (this._dpr > prevDpr) this._imageCache.RerasterizeSvgs(this._dpr);

    // Mark root dirty so layout re-solves with new dimensions. Written STRAIGHT onto Root rather
    // than through MarkLayoutDirty, so it never reaches `Notify` and cannot wake a parked loop on
    // its own -- hence the explicit wake. The wake is what schedules the frame that solves and
    // paints at the new size; `_resize` adds an inline one on top for callers with no frame to
    // wait for.
    this.Root.Dirty |= DirtyFlag.Layout;
    // A resize forces a FULL-tree solve, so any per-node dirty marks standing from before it are
    // stale. Clearing them here (rather than after the solve, where this used to live) also makes
    // the tick's `_chooseScopedRoot` see an empty set and therefore return Root -- a resize must
    // never be solved scoped. Runs after `_recomputeResponsiveLayout`, which marks nodes of its own.
    this._dirtyNodes.clear();
    this.Wake();
    return true;
  };

  /** Apply a pushed size AND paint it in the same turn. For callers that are NOT inside a frame:
   *  the `Element.width` write in `_applySize` clears the WebGL framebuffer, and with no tick of
   *  their own to bridge to they would leave the canvas blank until something else woke the loop.
   *  Anything running inside the frame loop calls `_applySize` and lets the tick paint. */
  private _resize = (): void => {
    if (!this._applySize()) return;
    if (this._running) {
      // This can still be what paints FIRST -- a DPR change on a parked loop resolves here before
      // the frame it wakes. Name it, or that frame appears to arrive from nowhere.
      const ff = !this._ffPresented;
      const tResize = ff ? performance.now() : 0;
      if (ff) JTrace(`jaui:resize:render ${Math.round(this._width)}x${Math.round(this._height)}`);
      if ((this.Root.Dirty & (DirtyFlag.Layout | DirtyFlag.Text)) !== 0) {
        CascadePointScale(this.Root, this._viewport(), this._jssVars);
        this._measureDirtyText(this.Root);
        ComputeIntrinsicSizes(this.Root, this._viewport(), this._jssVars);
        this._solveAndAnimate();
        this._clearDirty(this.Root);
      }
      this._processTextTransitions(this.Root);
      this._render(0);
      if (ff && this._ffPresented) {
        const c = this._counts;
        JTrace(`jaui:resize:painted ${JMs(performance.now() - tResize)}ms`
          + ` panels=${c.Panels} glass=${c.Glass} text=${c.Text} glyphs=${this._textCache.RasterCount}`
          + ` rasterms=${JMs(this._textCache.RasterMs)}`);
      }
    }
  };

  /** Size pushed in by the most recent ResizeObserver callback -- a single last-write-wins cell, so
   *  a burst of them costs one apply at the newest size. `_applySize` consumes it, avoiding a
   *  clientWidth read that would force the browser to flush pending layout. The park predicate
   *  refuses to park while it is full, which is what guarantees a frame comes to drain it. */
  private _pendingResize: { width: number; height: number } | null = null;

  private _observeResize = (): void => {
    // Worker mode: ResizeObserver doesn't exist in DedicatedWorkerGlobalScope
    // (it's a DOM API). The MainBridge owns its own ResizeObserver on the
    // proxy canvas element and pushes contentRect deltas via `M2W_Resize`,
    // which calls `ResizeFromBridge` here — same pipeline, different
    // source. Skip the engine-side observer entirely when RO isn't
    // available (= we're in a worker).
    //
    // Main-thread mode: write the slot and wake, exactly as the bridge does. The tick drains it.
    // This is also what keeps the RO callback returning synchronously -- running layout inline from
    // one makes the browser emit "ResizeObserver loop completed with undelivered notifications"
    // (benign but noisy). It used to rAF a `_resize()` per callback, which is one full-tree
    // solve+render per observed frame with no coalescing between them.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this._pendingResize = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      this.Wake();
    });
    observer.observe(this.Element as unknown as Element);
  };

  /** Pointer → interaction states (Hover / Active). The topmost hit Jiv
   *  becomes Hover:true; everyone else clears. Pointer down/up toggles
   *  Active on the hit target. Focus is keyboard-driven and sits on a
   *  separate system (added with the input focus chain). Disabled is set
   *  declaratively by the caller — we never touch it here.
   *
   *  State changes trigger a re-render via RequestFrame. State mutations
   *  are O(1) per frame per pointer (two pointers = two state flips max). */
  private _hoveredJiv: Jiv | null = null;
  private _activeJiv: Jiv | null = null;
  /** Set by worker boot — resolves a Jiv to all other Jivs sharing one of
   *  its group-trigger classes. Used to fan `_groupHover` out on every
   *  hover-target change. Null in test/headless contexts that don't wire
   *  a JivRegistry; group-hover is a no-op there. */
  private _resolveGroupPeers: ((jiv: Jiv) => Set<Jiv>) | null = null;

  RegisterGroupPeersResolver = (fn: (jiv: Jiv) => Set<Jiv>): void => {
    this._resolveGroupPeers = fn;
  };

  /** Z-ordered topmost-hit at a client point. Shared by interaction-state
   *  tracking (hover/active), the pointer-hit dispatch, and the wheel handler
   *  so `(wheel)` consumers receive the event only when actually on top. */
  private _topmostAt = (clientX: number, clientY: number): Jiv | null => {
    const rect = this._pageRect();
    return this._scrollManager.HitTopmost(clientX - rect.left, clientY - rect.top);
  };

  private _listenForInteractionStates = (): void => {
    const topmostAt = this._topmostAt;

    // CSS-like Hover/Active: the flag propagates up the ancestor chain so
    // hovering/pressing a child also counts as hovering/pressing the parent.
    // Authors only define HoverStyle/ActiveStyle on the elements they want to
    // visually react; ancestors with no override don't change appearance.
    const setStateChain = (
      newTopmost: Jiv | null,
      oldTopmost: Jiv | null,
      flag: 'Hover' | 'Active',
    ): void => {
      const newPath = new Set<Jiv>();
      for (let n = newTopmost; n; n = n.Parent as Jiv | null) newPath.add(n);
      for (let n = oldTopmost; n; n = n.Parent as Jiv | null) {
        if (!newPath.has(n)) n[flag] = false;
      }
      newPath.forEach(n => { n[flag] = true; });
    };

    const fanOutGroupHover = (newJiv: Jiv | null, oldJiv: Jiv | null): void => {
      if (!this._resolveGroupPeers) return;
      const newPeers = newJiv ? this._resolveGroupPeers(newJiv) : new Set<Jiv>();
      const oldPeers = oldJiv ? this._resolveGroupPeers(oldJiv) : null;
      if (oldPeers) oldPeers.forEach(p => { if (!newPeers.has(p)) p.GroupHover = false; });
      newPeers.forEach(p => { p.GroupHover = true; });
    };

    this._on('pointermove', (e: PointerEvent) => {
      const hit = topmostAt(e.clientX, e.clientY);
      if (hit !== this._hoveredJiv) {
        setStateChain(hit, this._hoveredJiv, 'Hover');
        fanOutGroupHover(hit, this._hoveredJiv);
        this._hoveredJiv = hit;
        this._setCursor(_resolveCursor(hit));
        this._animationManager.Kick();
      }
      if (hit?.OnPointerMove) hit.OnPointerMove(e);
    });

    this._on('pointerleave', () => {
      if (this._hoveredJiv) {
        setStateChain(null, this._hoveredJiv, 'Hover');
        fanOutGroupHover(null, this._hoveredJiv);
        this._hoveredJiv = null;
        this._setCursor('');
        this._animationManager.Kick();
      }
    });

    // Click gesture — remember the down-hit Jiv and fire OnClick on
    // pointerup only when the release lands on the SAME Jiv AND the
    // pointer hasn't traveled past TAP_SLOP since pointerdown. The slop
    // check is what stops a scroll-drag from firing a phantom click: on
    // mobile the user's finger always moves a little, and content under
    // the lift-off point is often still the same card, so identity alone
    // is not enough. 10 px matches Chromium's mobile tap slop.
    let _clickDownJiv: Jiv | null = null;
    let _clickDownX = 0;
    let _clickDownY = 0;
    const TAP_SLOP = 10;

    // Touch: kill the browser's own long-press detector (haptic + OS
    // selection callout / context menu) at the actual source. On Chrome
    // Android the long-press timer arms on `touchstart`, which fires
    // BEFORE the matching `pointerdown` — so preventDefault on the
    // pointer event is too late. Touch events are passive by default;
    // `{ passive: false }` is required for preventDefault to register.
    // The canvas already has `touch-action: none`, so we're not breaking
    // any scroll/zoom default — we're just opting out of the long-press
    // gesture in the same swing.
    this._on('touchstart', (e: TouchEvent) => {
      e.preventDefault();
    }, { passive: false });

    this._on('pointerdown', (e: PointerEvent) => {
      const hit = topmostAt(e.clientX, e.clientY);
      _clickDownJiv = hit;
      _clickDownX = e.clientX;
      _clickDownY = e.clientY;
      // The web's focused-scroller rule: a press inside a scroll container
      // makes it the target of the scroll keys. The old DOM app bought this
      // with tabindex="0" on every scroll box; the canvas has to say it.
      {
        const rect = this._pageRect();
        const scroller = this._scrollManager.ResolveScrollTarget(e.clientX - rect.left, e.clientY - rect.top);
        if (scroller) this._focusManager.SetFocusedScroller(scroller);
        this._focusManager.SetModality('pointer');
      }
      if (!hit) return;
      setStateChain(hit, this._activeJiv, 'Active');
      this._activeJiv = hit;
      this._animationManager.Kick();
      if (hit.OnPointerDown) hit.OnPointerDown(e);
    });

    const clearActive = (): void => {
      if (this._activeJiv) {
        setStateChain(null, this._activeJiv, 'Active');
        this._activeJiv = null;
        this._animationManager.Kick();
      }
    };

    // Promote press → drag once travel exceeds slop: drop the pending
    // click and release the Active visual so the user doesn't see a
    // stuck press state while scrolling.
    this._on('pointermove', (e: PointerEvent) => {
      if (!_clickDownJiv) return;
      const dx = e.clientX - _clickDownX;
      const dy = e.clientY - _clickDownY;
      if (dx * dx + dy * dy > TAP_SLOP * TAP_SLOP) {
        _clickDownJiv = null;
        clearActive();
      }
    });

    this._on('pointerup', (e: PointerEvent) => {
      const upHit = topmostAt(e.clientX, e.clientY);
      if (upHit && _clickDownJiv === upHit && upHit.OnClick) {
        upHit.OnClick();
      }
      if (upHit?.OnPointerUp) upHit.OnPointerUp(e);
      _clickDownJiv = null;
      clearActive();
    });
    // Contextmenu (right-click / long-press) — hit-test the click point
    // like click does, fire OnContextMenu on the deepest interactive hit,
    // and unconditionally preventDefault on the real event so the browser's
    // own menu (Save image, etc.) never appears over the canvas. Apps that
    // care about right-click should bind (contextmenu) on a Jaui jiv via
    // the Angular bridge.
    this._on('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      const hit = topmostAt(e.clientX, e.clientY);
      if (hit?.OnContextMenu) hit.OnContextMenu(e);
    });

    this._on('pointercancel', () => {
      _clickDownJiv = null;
      clearActive();
    });
  };

  /** Mouse-driven text selection. Match web behavior:
   *    • Single mousedown — arms an anchor; a bare click without drag leaves
   *      NO visible selection (collapses any prior selection). Selection
   *      only materializes once the pointer crosses DRAG_SLOP.
   *    • Drag past slop — extends selection to the nearest word of the
   *      anchor Jiv at the current pointer position (past-bounds points
   *      clamp to the nearest line/word, same as browser selection).
   *    • Double-click — selects the word at the click point (immediate).
   *    • Triple-click — selects the whole line (immediate).
   *  Mobile (touch): long-press to start selection with handle UI is a
   *  deliberate follow-up — touch is currently reserved for scroll.
   *
   *  Click-count uses a 400 ms window with a < 5 px travel threshold,
   *  matching Chromium's heuristics. The active text Jiv is remembered
   *  across the burst so a triple-click always lands on the same Jiv. */
  private _listenForTextSelection = (): void => {
    let anchorJiv: Jiv | null = null;
    let anchorChar: number = -1;
    /** Granularity of the current drag: 'char' (word-by-word), 'word'
     *  (double-click — extend by whole words), 'line' (triple-click). */
    let granularity: 'char' | 'word' | 'line' = 'char';
    /** Active click-burst state for double/triple detection. */
    let lastClickAt = 0;
    let lastClickX = 0, lastClickY = 0;
    let clickCount = 0;
    /** Armed (pointerdown recorded, no visible range yet) vs dragging
     *  (range is live). Single-click stays armed until the pointer moves
     *  past DRAG_SLOP — matches native: bare click = no visible highlight. */
    let armed = false;
    let dragging = false;
    let armedX = 0, armedY = 0;
    const DRAG_SLOP = 3;

    const selMgr = this._selectionManager;

    this._on('pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (e.button !== 0) return;

      const rect = this._pageRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const hit = this._scrollManager.HitTopmost(cssX, cssY);
      // Web semantics: a drag STARTED inside a UserSelect:None cascade selects
      // nothing at all — without this gate the nearest-text fallback lets a
      // drag on an unselectable overlay arm selection in unrelated text.
      if (hit && !selMgr.IsSelectable(hit)) {
        selMgr.Set(null, this.Root);
        this._animationManager.Kick();
        return;
      }
      const textJiv = selMgr.NearestTextJiv(this.Root, hit, cssX, cssY);

      if (!textJiv || !selMgr.IsSelectable(textJiv)) {
        selMgr.Set(null, this.Root);
        this._animationManager.Kick();
        return;
      }

      const charIdx = selMgr.CharIndexAt(textJiv, cssX, cssY);
      if (charIdx === null) return;

      const now = performance.now();
      const burstAlive = (now - lastClickAt) < 400
        && Math.hypot(cssX - lastClickX, cssY - lastClickY) < 5;
      clickCount = burstAlive ? clickCount + 1 : 1;
      lastClickAt = now;
      lastClickX = cssX;
      lastClickY = cssY;

      anchorJiv = textJiv;
      anchorChar = charIdx;

      if (clickCount >= 3) {
        granularity = 'line';
        armed = false;
        dragging = true;
        const [s, eIdx] = selMgr.LineCharRangeAt(textJiv, charIdx);
        selMgr.Set({
          AnchorJiv: textJiv, AnchorChar: s,
          ExtentJiv: textJiv, ExtentChar: eIdx,
        }, this.Root);
        this._animationManager.Kick();
      } else if (clickCount === 2) {
        granularity = 'word';
        armed = false;
        dragging = true;
        const [ws, we] = selMgr.WordCharRangeAt(textJiv, charIdx);
        selMgr.Set({
          AnchorJiv: textJiv, AnchorChar: ws,
          ExtentJiv: textJiv, ExtentChar: we,
        }, this.Root);
        this._animationManager.Kick();
      } else {
        granularity = 'char';
        armed = true;
        dragging = false;
        armedX = cssX;
        armedY = cssY;
        if (selMgr.Current) {
          selMgr.Set(null, this.Root);
          this._animationManager.Kick();
        }
      }

      this._capturePointer(e.pointerId);
      e.preventDefault();
    });

    this._on('pointermove', (e: PointerEvent) => {
      if (!anchorJiv) return;
      const rect = this._pageRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;

      // Promote armed → dragging once the pointer travels past slop. This is
      // the point where a bare click becomes a drag-select.
      if (armed && !dragging) {
        if (Math.hypot(cssX - armedX, cssY - armedY) < DRAG_SLOP) return;
        armed = false;
        dragging = true;
      }
      if (!dragging) return;

      // Re-resolve which text Jiv the cursor is over on every tick — selection
      // flows across Jiv boundaries like web selection. When the pointer is
      // off-canvas or over an unselectable region, NearestTextJiv falls back
      // to the closest text Jiv by rect distance.
      const hit = this._scrollManager.HitTopmost(cssX, cssY);
      const extentJiv = selMgr.NearestTextJiv(this.Root, hit, cssX, cssY) ?? anchorJiv;
      const extentChar = selMgr.CharIndexAt(extentJiv, cssX, cssY);
      if (extentChar === null) return;

      let aJiv = anchorJiv, aChar = anchorChar;
      let eJiv = extentJiv, eChar = extentChar;

      if (granularity === 'line') {
        const [as, ae] = selMgr.LineCharRangeAt(anchorJiv, anchorChar);
        const [es, ee] = selMgr.LineCharRangeAt(extentJiv, extentChar);
        if (aJiv === eJiv) {
          aChar = Math.min(as, es);
          eChar = Math.max(ae, ee);
        } else {
          const cmp = selMgr.DocOrder(anchorJiv, extentJiv, this.Root);
          if (cmp <= 0) { aChar = as; eChar = ee; }
          else { aChar = ae; eChar = es; }
        }
      } else if (granularity === 'word') {
        // Snap each endpoint outward to its word's char range so the
        // double-click-and-drag never collapses below one full word.
        const [aws, awe] = selMgr.WordCharRangeAt(anchorJiv, anchorChar);
        const [ews, ewe] = selMgr.WordCharRangeAt(extentJiv, extentChar);
        if (aJiv === eJiv) {
          aChar = Math.min(aws, ews);
          eChar = Math.max(awe, ewe);
        } else {
          const cmp = selMgr.DocOrder(anchorJiv, extentJiv, this.Root);
          if (cmp <= 0) { aChar = aws; eChar = ewe; }
          else { aChar = awe; eChar = ews; }
        }
      }
      // 'char' granularity forwards raw char endpoints.

      selMgr.Set({
        AnchorJiv: aJiv, AnchorChar: aChar,
        ExtentJiv: eJiv, ExtentChar: eChar,
      }, this.Root);
      this._animationManager.Kick();
    });

    const end = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse') return;
      dragging = false;
      armed = false;
      anchorJiv = null;
      if (this._hasCapture(e.pointerId)) {
        this._releasePointer(e.pointerId);
      }
    };
    this._on('pointerup', end);
    this._on('pointercancel', end);
  };


  /** Wheel + touch/pointer drag — both route through ScrollManager which
   *  handles physics (momentum, rubber-band for drag). Wheel clamps; drag
   *  rubber-bands past bounds. */
  private _listenForScroll = (): void => {
    // ─── Wheel ───
    this._on('wheel', (e: WheelEvent) => {
      // Browser zoom (Ctrl/Cmd + wheel, or pinch-zoom which Chrome delivers
      // as wheel + ctrlKey) is a browser-owned gesture — we must NOT consume
      // it as scroll. Let it bubble to the browser's zoom handler.
      if (e.ctrlKey) return;

      // Route to the topmost Jiv's OnWheel (z-ordered) so a consumer that binds
      // `(wheel)` — e.g. the drill field — only gets the wheel when it's genuinely
      // on top, never through an overlay/chrome above it.
      const wheelHit = this._topmostAt(e.clientX, e.clientY);
      if (wheelHit?.OnWheel) wheelHit.OnWheel(e);

      this._measureScrollContents(this.Root);

      const rect = this._pageRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;

      let dx = e.deltaX, dy = e.deltaY;
      if (e.deltaMode === 1) { dx *= 16; dy *= 16; }

      // Per-axis scroll chaining: a horizontal row (no vertical extent) lets a
      // vertical wheel fall through to the page scroll behind it, and a maxed-
      // out inner list chains to its parent — browser/Apple behavior, instead
      // of the innermost Scroll swallowing the wheel.
      const { xTarget, yTarget } = this._scrollManager.ResolveScrollChain(cssX, cssY, dx, dy);
      if (!xTarget && !yTarget) return;

      if (e.deltaMode === 2) {
        if (xTarget) dx *= xTarget.Width;
        if (yTarget) dy *= yTarget.Height;
      }

      // Input-type routing for a browser-native feel:
      //   • Trackpad / precise pointer — pixel-mode deltas that are small or
      //     fractional. The OS already streams smoothed momentum, so apply 1:1
      //     INSTANT (no ease) — maximally responsive.
      //   • Mouse wheel — line-mode, or large integer pixel steps (~100+ on
      //     Chrome/Mac). Smooth the discrete jump so it animates instead of
      //     teleporting. Bias is intentional: large+integer ⇒ never mistaken
      //     for trackpad, so wheel always smooths and trackpad stays instant.
      const ad = Math.max(Math.abs(e.deltaX), Math.abs(e.deltaY));
      const precise = e.deltaMode === 0
        && (ad < 40 || (e.deltaY % 1 !== 0) || (e.deltaX % 1 !== 0));
      const apply = precise
        ? this._scrollManager.ApplyDeltaInstant
        : this._scrollManager.ApplyDelta;
      if (xTarget && xTarget === yTarget) {
        apply(xTarget, dx, dy);
      } else {
        if (xTarget) apply(xTarget, dx, 0);
        if (yTarget) apply(yTarget, 0, dy);
      }
      this._animationManager.Kick();
      e.preventDefault();
    }, { passive: false });

    // ─── Pointer drag (touch + trackpad + mouse) ───
    // Only consume drag for touch/pen; mouse drag stays available for selection
    // once we have selection. Track per pointer id so multi-touch doesn't collide.
    //
    // NESTED SCROLLERS. A finger that lands on a horizontal carousel inside a
    // vertical page does not yet say which one it means. Every scroller under
    // it is caught (a fling stops the moment a finger touches it, as on iOS),
    // and the drag goes to ONE of them only once the finger has travelled
    // DRAG_SLOP_CSS_PX, chosen by its dominant axis (`PickDragTarget`). The
    // travel before that is delivered on the first real move, so the content
    // catches up to the finger instead of trailing it by the slop. A lone
    // scroller has no choice to make and starts on the spot, as before.
    const DRAG_SLOP_CSS_PX = 10;
    interface DragCtx {
      candidates: Jiv[]; target: Jiv | null;
      startX: number; startY: number; lastX: number; lastY: number;
    }
    const drags = new Map<number, DragCtx>();

    this._on('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return; // reserve mouse-drag for future selection

      this._measureScrollContents(this.Root);
      const rect = this._pageRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const candidates = this._scrollManager.ResolveScrollCandidates(cssX, cssY);
      if (candidates.length === 0) return;

      this._capturePointer(e.pointerId);
      for (const c of candidates) this._scrollManager.DragStart(c);
      drags.set(e.pointerId, {
        candidates, target: candidates.length === 1 ? candidates[0] : null,
        startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
      });
    });

    /** Hand an undecided drag to one scroller once it has a direction. The
     *  others are let go with no momentum: they were only ever caught. */
    const decide = (ctx: DragCtx, clientX: number, clientY: number): boolean => {
      if (ctx.target !== null) return true;
      const tx = clientX - ctx.startX;
      const ty = clientY - ctx.startY;
      if (tx * tx + ty * ty < DRAG_SLOP_CSS_PX * DRAG_SLOP_CSS_PX) return false;
      ctx.target = this._scrollManager.PickDragTarget(ctx.candidates, -tx, -ty);
      for (const c of ctx.candidates) if (c !== ctx.target) this._scrollManager.DragCancel(c);
      ctx.lastX = ctx.startX;
      ctx.lastY = ctx.startY;
      return ctx.target !== null;
    };

    this._on('pointermove', (e: PointerEvent) => {
      const ctx = drags.get(e.pointerId);
      if (!ctx) return;

      // iOS batches pointermove to ~20Hz during touch — renders run at 60Hz
      // but scroll offset was only updating 3x/frame with the raw event.
      // getCoalescedEvents() recovers the missed samples; we feed each one
      // through DragMove so scroll offset tracks the finger at native rate.
      // Fall back to the single event if the browser doesn't support it.
      const samples: readonly PointerEvent[] =
        typeof e.getCoalescedEvents === 'function'
          ? (e.getCoalescedEvents() as PointerEvent[]) : [];
      const events: readonly PointerEvent[] = samples.length > 0 ? samples : [e];

      // Each sample is timed by its OWN event timeStamp, never by the moment it
      // reached us. A coalesced batch arrives all at once: reading the clock in
      // this loop stamps every sample in it with the same instant, which reports
      // a batch's worth of finger travel as having taken no time at all, and
      // DragEnd then divides real distance by near-zero. Bridge latency and
      // worker-thread jitter would be measured as finger speed the same way.
      // timeStamp comes from the main thread (Bridge carries it per sample, and
      // per coalesced sample); the manager only ever takes differences, so the
      // two threads' differing time origins never enter the arithmetic.
      for (const sample of events) {
        if (!decide(ctx, sample.clientX, sample.clientY)) continue;
        // Dragging pulls content the opposite direction of finger motion (finger
        // moves up → content scrolls down, same as native).
        const dx = -(sample.clientX - ctx.lastX);
        const dy = -(sample.clientY - ctx.lastY);
        this._scrollManager.DragMove(ctx.target!, dx, dy, sample.timeStamp);
        ctx.lastX = sample.clientX;
        ctx.lastY = sample.clientY;
      }
      this._animationManager.Kick();
      // No preventDefault — listener is passive. `touch-action: none` on the
      // canvas (set in the constructor) keeps the browser's native scroll
      // from competing, so we don't need to block it imperatively.
    }, { passive: true });

    // A main-thread interaction (a selection-handle drag) claimed this
    // pointer: freeze the scroll where it is and stop following the finger.
    this._on('gestureclaim', (e: { pointerId: number }) => {
      const ctx = drags.get(e.pointerId);
      if (!ctx) return;
      for (const c of ctx.candidates) this._scrollManager.DragCancel(c);
      drags.delete(e.pointerId);
    });

    const finish = (e: PointerEvent): void => {
      const ctx = drags.get(e.pointerId);
      if (!ctx) return;
      if (decide(ctx, e.clientX, e.clientY)) {
        // The lift carries a position, and the finger really was travelling
        // between the last pointermove and here — typically most of a frame. Feed
        // it as the drag's final sample so that distance lands on the content AND
        // so the release window's last interval is measured rather than read as
        // the finger having stopped. Without it a flick is systematically slow by
        // the fraction of the window that gap occupies.
        const dx = -(e.clientX - ctx.lastX);
        const dy = -(e.clientY - ctx.lastY);
        if (dx !== 0 || dy !== 0) this._scrollManager.DragMove(ctx.target!, dx, dy, e.timeStamp);
        this._scrollManager.DragEnd(ctx.target!, e.timeStamp);
      } else {
        // A tap: the finger never moved far enough to scroll anything, and what it caught stays caught.
        for (const c of ctx.candidates) this._scrollManager.DragCancel(c);
      }
      this._animationManager.Kick();
      drags.delete(e.pointerId);
      if (this._hasCapture(e.pointerId)) {
        this._releasePointer(e.pointerId);
      }
    };
    this._on('pointerup', finish);
    this._on('pointercancel', finish);
  };

  /** Walk the tree, compute ContentWidth/Height for each Overflow:Scroll Jiv from
   *  the bounding box of its children. Cheap; needed for clamping scroll target. */
  private _measureScrollContents = (node: Jiv): void => {
    this.MeasureScrollContent(node);
    for (const c of node.Children as Jiv[]) this._measureScrollContents(c);
  };

  /** One scroll container's content extent, from its flow children as they
   *  are drawn. A no-op on anything that does not scroll. Input measures the
   *  whole tree lazily; a consumer that needs one row's extent now (a paging
   *  control, a rect watcher) measures just that node. */
  MeasureScrollContent = (node: Jiv): void => {
    if (node.Overflow !== 'Scroll') return;
    let maxRight = 0;
    let maxBottom = 0;
    for (const c of node.Children) {
      // Only Flow children contribute to scroll content size.
      // Placed/Fixed/Sticky are out-of-flow and don't extend the scroll bounds.
      if (c.ChildLayout.Position !== 'Flow' && c.ChildLayout.Position !== 'Offset') continue;
      const right = (c.X - node.X) + c.Width;
      const bottom = (c.Y - node.Y) + c.Height;
      if (right > maxRight) maxRight = right;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    // Add bottom padding so last item doesn't sit flush against the edge
    const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
    const [, padR, padB] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    node.ContentWidth = maxRight + padR;
    node.ContentHeight = maxBottom + padB;
  };

  /** Page a horizontal scroll row one screen of whole cards, eased like a
   *  wheel: the card cut off at the edge it moves toward lands on the row's
   *  padding line. This is what a shelf's arrows press. */
  ScrollPageX = (node: Jiv, direction: 1 | -1): void => {
    if (node.Overflow !== 'Scroll') return;
    this.MeasureScrollContent(node);
    const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
    const [, padR, , padL] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
    this._scrollManager.PageX(node, direction, padL, padR);
    this._animationManager.Kick();
  };

  /**
   * Send a scroll container somewhere: an absolute offset, or an element's box.
   * The main-thread half of this is `JivHandle.ScrollTo`; the bridge carries the
   * request as a `scroll-to` op and `JivRegistry` resolves the ids to nodes.
   *
   * THE REQUEST WAITS FOR LAYOUT WHEN LAYOUT IS DIRTY. An element target is
   * read out of `X`/`Y`, and those are last frame's numbers until the solve
   * runs. A rail pressed in the same tick that its sections mounted would
   * otherwise scroll to where nothing is yet — silently, which is the worst
   * kind. So a dirty tree defers the whole resolve to one post-frame callback
   * and lands on real geometry. Exactly one retry: if a frame's solve did not
   * settle the numbers, a loop waiting for it is a scroll that never happens.
   */
  ScrollTo = (node: Jiv, target: Jiv | null, to: ScrollToOptions): void => {
    if (node.Overflow !== 'Scroll') {
      console.warn('[Jaui] ScrollTo: container does not scroll (Overflow is not Scroll)');
      return;
    }
    if (target && (this.Root.Dirty & (DirtyFlag.Layout | DirtyFlag.Text)) !== 0) {
      const off = this.RegisterPostFrame(() => { off(); this._scrollToNow(node, target, to); });
      this._animationManager.Kick();
      return;
    }
    this._scrollToNow(node, target, to);
  };

  private _scrollToNow = (node: Jiv, target: Jiv | null, to: ScrollToOptions): void => {
    this.MeasureScrollContent(node);
    const motion = to.Motion ?? 'Smooth';
    const axis = to.Axis ?? 'Both';
    const offset = { X: to.OffsetX ?? 0, Y: to.OffsetY ?? 0 };
    if (target) {
      const ctx = node.ResolveCtx ?? this.Root.ResolveCtx!;
      const [padT, padR, padB, padL] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);
      // Layout positions are un-scrolled, so the difference IS the element's
      // place in the container's content coordinates however deep it sits.
      const rect = { x: target.X - node.X, y: target.Y - node.Y, width: target.Width, height: target.Height };
      const pad = { Left: padL, Right: padR, Top: padT, Bottom: padB };
      this._scrollManager.AlignInto(node, rect, pad, to.Align ?? 'Start', axis, offset, motion);
    } else {
      const x = axis === 'Y' || to.X === undefined || to.X === null ? null : to.X + offset.X;
      const y = axis === 'X' || to.Y === undefined || to.Y === null ? null : to.Y + offset.Y;
      this._scrollManager.ScrollTo(node, x, y, motion);
    }
    this._animationManager.Kick();
  };

  /** Re-rasterize every text node against the current font set. Called
   *  when fonts finish loading after the engine has already rendered —
   *  cached glyph rasters captured with the fallback font are now stale.
   *
   *  A font load is a *re-rasterization* event, not a content/presence
   *  event: the words are the same words, the user already sees them,
   *  only the glyph pixels and metrics need refreshing. So:
   *   - drop cache entries (atlas slots are keyed against the old font)
   *     but keep the atlas texture itself — Text.Cache.Clear no longer
   *     reallocates it, so reads are never serviced from an empty
   *     texture between the wipe and the next rasterize
   *   - keep TextAnimators alive: each word's Opacity spring stays at
   *     its current settled 1.0, no fade-in pop. Resync runs _reflow
   *     against the new metrics so widths/positions catch up
   *   - invalidate node measurements so _measureDirtyText re-runs
   *     (intrinsic widths may shift)
   *   - mark layout dirty so reflow propagates */
  private _invalidateAllText = (): void => {
    BumpFontGeneration();
    this._textCache.Clear();
    // `?blur-cache`: the atlas keeps its texture across a Clear, so a re-raster can land a new face
    // under the very UVs an unchanged glyph instance carries. The frame seed moves instead.
    this._bcTextEpoch++;
    let needsKick = false;
    for (const anim of this._textAnimators.values()) {
      if (anim.Resync()) needsKick = true;
    }
    const invalidate = (node: JauiElement): void => {
      node.InvalidateText();
      for (const child of node.Children) invalidate(child);
    };
    invalidate(this.Root);
    this.Root.Dirty |= DirtyFlag.Layout;
    if (needsKick) this._animationManager.Kick();
  };

  /** Public: drop cached glyph rasters so text re-rasterizes with a newly-registered font. Call
   *  after a font is registered post-init (the headless turf canvas gets Inter from the reality
   *  bridge). Light — just clears the text atlas cache; the caller re-renders next frame. Does NOT
   *  re-layout (the turf's SnapLayout base must not be reset to 0). */
  RefreshFonts = (): void => {
    // Bump first: the generation rides in the canvas font string, so it is what
    // makes Chromium re-resolve a face it had already bound to a fallback — and
    // it drops the shared measurement cache, whose entries were shaped against
    // that fallback. Clearing only the glyph atlas would re-rasterize with the
    // new font at the OLD advance widths.
    BumpFontGeneration();
    this._textCache.Clear();
    // `?blur-cache`: the atlas keeps its texture across a Clear, so a re-raster can land a new face
    // under the very UVs an unchanged glyph instance carries. The frame seed moves instead.
    this._bcTextEpoch++;
    this.RequestFrame();
  };

  /** Listen for fonts that arrive AFTER the first tick — e.g. a lazy
   *  @font-face registered later, or a network-slow Google Font that
   *  resolved fonts.ready optimistically on a different family.
   *  FontFaceSet.loadingdone fires once per batch; that's our cue to
   *  flush stale atlas entries. */
  private _listenForFontLoad = (): void => {
    this._platform.ObserveFontsLoadingDone(() => {
      this._invalidateAllText();
    });
  };

  private _watchDpr = (): void => {
    // matchMedia only fires when the specified dpr condition changes (e.g.
    // on browser zoom). One-shot — when it fires, re-arm at the new dpr.
    // The painting `_resize`, deliberately: this fires outside any frame, and it is the one caller
    // that changes the backing-store size with NO new CSS size behind it -- `_applySize` rewrites
    // Element.width/height at the new DPR, clearing the framebuffer, and only the inline paint
    // bridges to the frame the wake schedules. An rAF-only DPR change flashes the canvas blank.
    this._platform.ObserveDprChange(this._dpr, () => {
      this._resize();
      this._watchDpr();
    });
  };

  /** Parse `?debug` / `#debug` and `?dpr=N` from the URL. Calling this early
   *  in the constructor lets `_resize()` pick up the DPR override on its
   *  first run, and attaches the HUD once the canvas is in the DOM. */
  private _initDebugFromUrl = (): void => {
    const search = this._platform.GetUrlSearch();
    const hash = this._platform.GetUrlHash();
    const params = new URLSearchParams(search);
    const debug = params.has('debug') || hash.includes('debug');

    // `?dpr=N` — explicit user override (clamped to a sane range so a typo
    // doesn't lock the browser with a 50MP backbuffer). null = auto.
    const dprStr = params.get('dpr');
    if (dprStr !== null) {
      const n = Number(dprStr);
      if (Number.isFinite(n) && n > 0 && n <= 4) this._dprOverride = n;
    }

    if (debug) this._enableDebugHud();
    if (params.has('debug-layout') || hash.includes('debug-layout')) this._enableDebugLayout();
    // Console-only frame-phase profiling. `?wkr-jaui-prof` works in the
    // worker (where there's no DOM HUD) and in main-thread Canvas alike;
    // the per-second log dumps Dirty/Layout/Text/Render averages.
    if (params.has('wkr-jaui-prof') || hash.includes('wkr-jaui-prof')) {
      this._consoleProfilingEnabled = true;
    }
    // Per-PASS GPU timing. Armed by the profiling flag OR by `?trace`, whose gesture meter is the
    // only instrument a phone has -- and which needs this reading from the Mac to interpret what
    // it sees. Not a mode: armed, the frame ALTERNATES between the existing whole-frame query and
    // a per-pass split, and nothing about what is drawn changes. See `Core/Pass.Timers.ts`.
    if (this._consoleProfilingEnabled || params.has('trace') || hash.includes('trace')) {
      this._renderer.ArmPassTimers();
      // The reading has to cross out of the engine to two readers that must not reach into it: the
      // gesture meter, which lives in the app and runs inside this same worker, and the perf
      // harness, which evaluates in the worker over CDP. A named global is the whole channel --
      // no bridge message, no protocol, and nothing at all when the flag is absent.
      const g = globalThis as unknown as {
        __jauiPassProfile?: () => PassProfile | null;
        __jauiPassWindow?: (mark: PassProfile | null) => unknown;
      };
      g.__jauiPassProfile = () => this._renderer.GetPassProfile();
      // The window is reduced HERE rather than by the reader, so the perf harness (which cannot
      // import TypeScript) and the gesture meter and the console dump all run the same arithmetic.
      g.__jauiPassWindow = (mark) => PassWindowOf(mark, this._renderer.GetPassProfile());
      // The scene ledger travels the same way, and CUMULATIVELY: a gesture reads it at both ends and
      // subtracts, exactly as it does the pass profile. Per-frame restarts are `(Restarts_end -
      // Restarts_start) / (Frames_end - Frames_start)`, and per-frame SWITCHES the same over
      // `Switches`. Null on a non-WebGL2 backend, never a zero - an absence and "no restarts" are
      // opposite findings and must not print the same.
      //
      // The reader for this global is the gesture meter in `ShowStudio.App/src/Diagnostics/Trace.ts`,
      // which this lane does not own and has NOT been given the line. Until it is, the numbers reach a
      // human through the `[Jaui]` per-second console line, the debug HUD and `jaui:render:end`.
      const s = globalThis as unknown as {
        // Written as an intersection rather than one flat literal so the three-column shape the
        // existing readers were built against stays literally intact, and the breakdown reads as
        // what it is: an addition to it, not a replacement of it.
        __jauiSceneLedger?: () => ({ Reads: number; Restarts: number; Switches: number; Frames: number }
          & { EndsByKey: Record<string, number> }) | null;
      };
      s.__jauiSceneLedger = () =>
        (this._renderer instanceof WebGL2Renderer ? this._renderer.SceneLedgerTotals : null);
    }
    // TEMP perf-isolation toggles (exact-key query params). See field decls.
    if (params.has('no-pblur')) this._diagNoPblur = true;
    if (params.has('no-glass')) this._diagNoGlass = true;
    if (params.has('no-pblur-draw')) this._diagNoPblurDraw = true;
    if (params.has('no-reality')) this._diagNoReality = true;
    if (params.has('no-ui')) this._diagNoUi = true;
    if (params.has('no-blur')) this._diagNoBlur = true;
    // Renderer exists (assigned before _initDebugFromUrl) and Init has not run yet (it runs at Start),
    // so the field is read when the scene FBO is actually built. See WebGL2.Renderer.DiagNoDepth.
    if (params.has('no-depth') && this._renderer instanceof WebGL2Renderer) this._renderer.DiagNoDepth = true;
    // `?cardcomposite` — take the COMPOSITE walk on this build. The default is OFF: the design was
    // measured and refuted (ends 40 -> 1, frame +6.6%; see `CardCompositeEnabled`), so the engine
    // an unflagged run gets is the pre-composite one and the composite is an instrument you ask
    // for. Not a rendering: it is pixel-identical by construction, so this puts the two cost models
    // on one binary for a measurement, and for a bisect.
    //
    // `?no-cardcomposite` is kept and is assigned SECOND, so it wins when both are present: the
    // disabling flag is the one that names the shipped default, and a command line that asks for
    // both should land on the default rather than silently on the instrument.
    if (params.has('cardcomposite') && this._renderer instanceof WebGL2Renderer) this._renderer.CardCompositeEnabled = true;
    if (params.has('no-cardcomposite') && this._renderer instanceof WebGL2Renderer) this._renderer.CardCompositeEnabled = false;
    // `?snap-once` — MEASUREMENT ONLY, WRONG PIXELS. Serve every backdrop read from one full-canvas
    // snapshot so the frame does the same fill and the same arithmetic with the scene read-after-write
    // removed. Assigned at parse time like `?no-depth` rather than per-frame like `?no-blur`, because
    // Init has to be able to say the flag arrived (`jaui:snap-once` in the trace).
    if (params.has('snap-once') && this._renderer instanceof WebGL2Renderer) this._renderer.DiagSnapOnce = true;
    // `?blur-dummy` — MEASUREMENT ONLY, WRONG PIXELS. Draw every card over the REAL bed with no
    // render-target switch between them: `ComputeBlur` / `GenerateBlurMipmap` / `SnapshotScreen` all
    // issue no GL and hand back a 1x1 grey. `?snap-once` removed the READS and the frame did not
    // move; this removes the encoder BOUNDARY instead, which is what a pyramid build actually puts
    // between one card's draw and the next. Parsed at parse time like `?snap-once` so Init can say
    // the flag arrived. NOT `?no-blur`: every draw still lands, because the dummy is not the scene's
    // own attachment and so no glass draw is a feedback loop.
    if (params.has('blur-dummy') && this._renderer instanceof WebGL2Renderer) this._renderer.DiagBlurDummy = true;
    // `?blur-src-static` / `?blur-src-clear` — MEASUREMENT ONLY, WRONG PIXELS. Leave every draw,
    // every pyramid, every encoder end and every counter exactly as baseline and change ONE thing:
    // which texture the pyramid's DOWN pass samples. `static` points it at a canvas-sized texture
    // holding frame 1 forever; `clear` at one cleared once and never written. They separate the two
    // mechanisms left in the build-over-written-content cell — the READ's own bandwidth (H1, which
    // predicts `static` stays at the baseline number) from a same-frame write→sample hazard the
    // driver services per transition (H2, which predicts `static` falls to the no-panels number).
    // Parsed here like `?snap-once` so Init can say the flag arrived (`jaui:blur-src` in the trace).
    // Both given: `clear` wins, because it is the stronger ablation and a run that meant to ask for
    // one and typed both should read as the cheaper arm rather than silently as the other.
    if (params.has('blur-src-static') && this._renderer instanceof WebGL2Renderer) this._renderer.DiagBlurSrc = 'static';
    if (params.has('blur-src-clear') && this._renderer instanceof WebGL2Renderer) this._renderer.DiagBlurSrc = 'clear';
    // `?blur-chains=N` - MEASUREMENT ONLY, PIXEL-IDENTICAL. The frame-time test of H4.
    //
    // `BlurPass._useChain` keys a level chain on its LEVEL-0 SIZE. Twenty glass-grid cards share a
    // 472 px pitch, so every fill build resolves to 568x436 and every rim build to 480x348: TWO
    // chains for forty builds a frame, each build overwriting the level textures the previous
    // card's draw has just sampled. On a tile-based deferred GPU the preceding scene segment's
    // fragment work and its tile store have to complete before the chain can be rewritten, which
    // is a write-after-read hazard forty deep on two textures - and it explains every survivor the
    // ledger has left: indifference to source content and source size, indifference to encoder
    // ends, and the requirement for a bed long enough to make the hazard bite.
    //
    // Under N > 1 the pool keeps N chains per size and rotates them per build, so no two
    // CONSECUTIVE builds of a size share a chain. Nothing else moves: same region, sigma, depth,
    // `k`, passes, mip blits, `LastRegion`, and the same counters (SceneSwitches 40, EndsByKey
    // { blur: 40 }, restarts 40, reads 60, builds 40). If any of those moves, the flag did more
    // than choose a chain and the cell is void.
    //
    // No `pixels=WRONG`: a chain's contents are per-build, so which chain a build lands on cannot
    // change a texel, and the two-arm `glassshot` diff has to read exactly 0. Bounded by the pool's
    // own `MAX_CHAINS`, because a rotation wider than the pool would EVICT rather than rotate and
    // publish reallocation thrash under this flag's name; the pass refuses the rest at runtime,
    // naming itself on the trace, for the same reason.
    const blurChains = params.get('blur-chains');
    if (blurChains !== null) {
      const n = Number(blurChains);
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : !Number.isInteger(n) || n < 1 ? 'n-must-be-a-whole-number-of-chains-at-least-1'
        : n > MAX_CHAINS ? `n-above-the-pool-cap-${MAX_CHAINS}-and-a-wider-pool-evicts-instead-of-rotating`
        : this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-build-no-pyramid-to-rotate'
        : null;
      if (why !== null) JTrace(`jaui:blur-chains armed=false reason=${why}`);
      else (r as WebGL2Renderer).DiagBlurChains = n;
    }
    // `?tick-pace` - THE PACING GATE, AND IT IS ON BY DEFAULT (Jack's ruling, 2026-09-20 ~13:00;
    // Perf/README.md, "THE PACING RULING"). With no flag the engine paces with the DEPTH-1 FENCE:
    // wait for the last frame to finish before starting the next. Pixel-identical by construction,
    // never worse than unpaced at either resolution on the M4 (dpr 2 32.56/33.76 against an unpaced
    // 49.65; dpr 1.5 16.67 against 16.66 - indistinguishable), and it estimates NOTHING, which is
    // the whole reason it is the one that shipped.
    //
    // `?tick-pace=off` (`=none`, `=0`) is the UNPACED LOOP, byte for byte the loop before pacing
    // existed, and it is the control arm every gate from here on is measured against. The lock
    // (`=lock`, `=lock:V`, `=lock:live`), the clamp (`=N`) and `=observe` stay as MEASUREMENT flags:
    // the lock's mechanism was always right and only its period was wrong, and four designs failed
    // on the same gap - the rule that picks N needs the PRESENTED cadence and a worker has no
    // presentation signal at all. The whole argument, what a window costs, what the occupancy
    // classifier is for, what a skipped tick does and which parts of that file are INERT under the
    // default is in `Core/Tick.Pace.ts`; what belongs here is the gate, its refusals, and the two
    // signals `Tick.Pace` cannot see for itself - a PARK (`NotePark`, which breaks the interval the
    // instrument measures) and a canvas RESIZE (`NoteSceneChange`). Both are lock-only and inert
    // under the default; they stay wired because the lock still ships as a flag.
    //
    // NOT PARSED IN `Worker.Boot` the way `?no-depth` is, and with a DEFAULT to arm that reading
    // matters more than it did: `?no-depth` had to land ahead of `Init` because `Init` BUILDS the
    // scene FBO it configures. Nothing this gate touches is built by `Init` - the fence is placed
    // per frame in `EndFrame` and the gate is consulted per tick, both of which happen long after
    // the Canvas constructor (and so this parse) has run. So the default is alive on the harness and
    // worker path where `renderer.Init()` runs FIRST, and the proof is the effect field rather than
    // the ordering: `jaui:tick-pace fence=true` from the renderer's first `EndFrame`, a non-zero
    // `TicksSkipped`, and `__jauiTickPace().Mode` reading `fence:1`.
    // `_platform.GetUrlSearch()` is the PAGE's search in worker mode, handed over on the init
    // message, so the flag and its mark arrive on both this path and main-thread mode.
    {
      // NAMED, not armed: the gate is armed on every page now, and this is only what decides
      // whether the once-a-second `[Jaui.pace]` line prints.
      const named = params.has('tick-pace');
      const raw = params.get('tick-pace');
      const parsed = ParseTickPace(raw);
      const r = this._renderer;
      // A value this parse cannot read does NOT fall through to the unpaced loop. `off` is a real
      // arm now, so a typo that landed there would move the page onto the CONTROL silently and
      // publish it as the shipping engine. It falls to the default - what the page would have done
      // with no flag - and the refusal is named on its own line first.
      if ('Why' in parsed) JTrace(`jaui:tick-pace armed=false reason=${parsed.Why}`);
      const wanted: TickPaceMode | null = 'Why' in parsed ? TickPaceDefault() : parsed.Mode;
      // The fence, the lock and the observe arm all poll `PaceInFlight`, which is WebGL2's
      // `clientWaitSync`; the ratio clamp needs no GL at all and runs on any backend. A backend with
      // no fence to poll cannot pace, so it runs UNPACED - and says so, because a page quietly on a
      // different arm from every other page is the one thing worse than no pacing.
      const gateless = wanted !== null && wanted.Kind !== 'ratio' && !(r instanceof WebGL2Renderer);
      const mode: TickPaceMode | null = gateless ? null : wanted;
      this._tickPace = new TickPace(mode);
      if (mode !== null && mode.Kind !== 'ratio') {
        const gl2 = r as WebGL2Renderer;
        gl2.DiagTickPace = true;
        this._paceGate = gl2;
      }
      // Every N change, named on the trace with the two estimates that moved it - so an
      // oscillation is READABLE rather than something a report has to infer from a frame
      // histogram. A healthy run prints one of these (the seed) and then goes quiet.
      // One decimal, not `JMs`: that rounds anything over 10 ms to a whole number and would print
      // a 16.67 ms vsync as "17", which is the one digit that says whether the grid was read as
      // the display's or as half of it.
      const ms1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
      // `source=` is the field to read first: `warmup`/`window` is a cadence chosen from the
      // measured UNGATED callback interval, `live` from `RenderedGapMs`, and `unsaturated` from
      // the classification that the interval the window measured was a callback rate and not a
      // render period. None of them is a fence reading, and the 50-vs-33.3 and the still-clamped
      // dpr-1.5 cells exist because the previous two were.
      this._tickPace.OnLockChange = (n, periodMs, vsyncMs, source) => JTrace(
        `jaui:tick-pace lock N=${n} period=${ms1(periodMs)} source=${source} vsync=${ms1(vsyncMs)}`);
      // An observation window runs the page at the UNFLAGGED cadence for ~300 ms, so it never
      // happens silently: a report that sees a slow patch inside a measured window can tell a
      // re-observation from a regression, and can tell WHY it opened.
      this._tickPace.OnWindow = (phase, reason, meanMs, source) => JTrace(
        `jaui:tick-pace window ${phase} reason=${reason} mean=${ms1(meanMs)} source=${source}`);
      // WHICH ARM, and WHY it is that arm - four shapes, because "armed=fence:1" alone cannot tell
      // the default from a page that asked for it, and an operator reading a report has to know
      // whether the flag they typed was honoured.
      //
      //   armed=fence:1 default=true    no flag at all. The shipping engine.
      //   armed=fence:1 reason=default  `?tick-pace` bare: the same gate, plus the console line.
      //   armed=off reason=control      `?tick-pace=off`: the unpaced loop, deliberately.
      //   armed=off reason=fence-mode-needs-webgl2-clientwaitsync   no fence on this backend.
      //   armed=<mode>                  a measurement flag, honoured as typed.
      const how = gateless ? ' reason=fence-mode-needs-webgl2-clientwaitsync'
        : mode === null ? ' reason=control'
        : !named ? ' default=true'
        : (raw ?? '').trim() === '' ? ' reason=default'
        : '';
      JTrace(`jaui:tick-pace armed=${TickPaceText(mode)}${how}`);
      // The cumulative ledger, out to a reader that must not reach into the engine - the same
      // channel `__jauiPassProfile` and `__jauiSceneLedger` use, and for the same reason.
      // INSTALLED UNCONDITIONALLY now that the gate is the default: an unflagged page is the arm
      // a report most needs to read, and this is the only way to read it without the console line.
      // The effect field is RENDERS per presented frame, and the harness's `ticks` column counts
      // rAF CALLBACKS (`instrument.mjs` wraps `self.requestAnimationFrame` and increments on every
      // one), not renders - so under the gate `ticks` and renders part company and the ratio is
      // only readable if the engine says how many of its ticks drew. One evaluate at each end of
      // the window, subtract, divide by the presented frame count.
      const g = globalThis as unknown as { __jauiTickPace?: () => PaceCensus };
      g.__jauiTickPace = () => this._tickPace.Census();
      // The console line is armed by the flag being NAMED, including `=off` - a control arm that
      // printed nothing would be the one arm with no ledger on the console. See `_paceCensusOn`.
      this._paceCensusOn = named;
    }
    // `?flat-program=off` — PIXEL-IDENTICAL BY CONSTRUCTION, and DEFAULT ON.
    //
    // The specialised fragment program for non-glass fills (`MATERIAL_FLAT`, see
    // `WebGL2Renderer._panelShaderFlat`) is compiled in BOTH arms; this flag only decides whether
    // a flat batch is routed to it. That is deliberate: the arms then differ by a program bind and
    // nothing else, so an interleaved two-arm run is not also measuring a different boot.
    //
    // The mark prints on every page, armed or not, because a reader has to be able to tell the ON
    // arm from a build that has not got the lane. `programs=` is the count of panel variants the
    // binary compiles, read from the renderer's own exported constant rather than written out
    // here, so the line cannot claim a program the boot does not build.
    {
      const flatProgram = params.get('flat-program');
      const r = this._renderer;
      const webgl2 = r instanceof WebGL2Renderer;
      // A value that is neither `on` nor `off` does NOT quietly pick one: the default stands and
      // the mark names the value it refused, so an operator who typed `=of` reads that the arm
      // they thought they selected is not the arm that ran.
      const bad = flatProgram !== null && flatProgram !== '' && flatProgram !== 'on' && flatProgram !== 'off';
      const armed = webgl2 && (bad || flatProgram !== 'off');
      if (webgl2) (r as WebGL2Renderer).DiagFlatProgram = armed;
      const why = !webgl2 ? ' reason=webgl2-only' : bad ? ` reason=only-on-and-off-are-values-got-${flatProgram}` : '';
      JTrace(`jaui:flat-program armed=${armed ? 'on' : 'off'} programs=${webgl2 ? PANEL_PROGRAM_COUNT : 0}${why}`);

      // `?borderless-program=off` — PIXEL-IDENTICAL BY CONSTRUCTION, and DEFAULT ON.
      //
      // The fourth panel variant (MATERIAL_FLAT + NO_SHAPE_GRADIENT) drops the SDF gradient and
      // the border chain that is its only consumer on a flat panel. `=off` sends borderless
      // batches back to MATERIAL_FLAT — flatprogram's routing — so both arms live in one binary
      // and differ by a program bind.
      //
      // `?flat-program=off` IMPLIES this one off, and says so in the mark rather than printing
      // `armed=on` for a program no batch can reach: with the flat routing gone there is no flat
      // batch to narrow. Read the two lines together; the second never claims more than the first.
      const borderless = params.get('borderless-program');
      const blBad = borderless !== null && borderless !== '' && borderless !== 'on' && borderless !== 'off';
      const blArmed = armed && (blBad || borderless !== 'off');
      if (webgl2) (r as WebGL2Renderer).DiagBorderlessProgram = blArmed;
      const blWhy = !webgl2 ? ' reason=webgl2-only'
        : !armed ? ' reason=flat-program-off'
        : blBad ? ` reason=only-on-and-off-are-values-got-${borderless}` : '';
      JTrace(`jaui:borderless-program armed=${blArmed ? 'on' : 'off'} programs=${webgl2 ? PANEL_PROGRAM_COUNT : 0}${blWhy}`);

      // `?two-stop-gradient=off` - PIXEL-IDENTICAL BY CONSTRUCTION, and DEFAULT ON.
      //
      // The fifth panel variant (MATERIAL_FLAT + NO_SHAPE_GRADIENT + TWO_STOP_GRADIENT) binds
      // `sampleBgGradient`'s knot loop to 2 instead of 16, so a two-stop band's spline is one
      // straight-line evaluation with constant uniform indices. `=off` sends those batches back to
      // the borderless program - flatprogram2's routing - so both arms live in one binary and
      // differ by a program bind.
      //
      // BOTH of the flags above imply this one off, and the mark names WHICH: the variant is cut
      // on top of their two defines, so with either routing gone there is no batch that can reach
      // it. Read the three lines together; each never claims more than the one above it.
      const twoStop = params.get('two-stop-gradient');
      const tsBad = twoStop !== null && twoStop !== '' && twoStop !== 'on' && twoStop !== 'off';
      const tsArmed = blArmed && (tsBad || twoStop !== 'off');
      if (webgl2) (r as WebGL2Renderer).DiagTwoStopGradient = tsArmed;
      const tsWhy = !webgl2 ? ' reason=webgl2-only'
        : !armed ? ' reason=flat-program-off'
        : !blArmed ? ' reason=borderless-program-off'
        : tsBad ? ` reason=only-on-and-off-are-values-got-${twoStop}` : '';
      JTrace(`jaui:two-stop-gradient armed=${tsArmed ? 'on' : 'off'} programs=${webgl2 ? PANEL_PROGRAM_COUNT : 0}${tsWhy}`);
    }
    // `?shadow-snap=off` — THE DIAGNOSTIC ARM, and the fix is DEFAULT ON.
    //
    // Off restores the loop as it parked before this lane: three taus of settle window and no final
    // whole reading, so the parked frame keeps the ~5% residual the ease had not yet spent and is
    // deterministic only because the tick cadence is. Both arms are in one binary so the two-arm
    // glassshot is one build, and the mark prints on every page, armed or not, because a reader has
    // to be able to tell the ON arm from a build that has not got the lane.
    //
    // Parsed HERE and applied to a field the TICK reads, not to anything `Init` builds: in worker
    // mode `_platform.GetUrlSearch()` is the page's search handed over on the init message, and the
    // snap is decided per tick in `_tickInner`, so the flag reaches the worker and its effect is
    // readable on the census rather than only on the boot trace.
    {
      const shadowSnap = params.get('shadow-snap');
      const bad = shadowSnap !== null && shadowSnap !== '' && shadowSnap !== 'on' && shadowSnap !== 'off';
      this._shadowSnapArmed = bad || shadowSnap !== 'off';
      const why = bad ? ` reason=only-on-and-off-are-values-got-${shadowSnap}` : '';
      const taus = this._shadowSnapArmed ? SHADOW_SETTLE_TAUS : SHADOW_SETTLE_TAUS_UNSNAPPED;
      JTrace(`jaui:shadow-snap armed=${this._shadowSnapArmed ? 'on' : 'off'} settleTaus=${taus}${why}`);
      // The census, on the same channel `__jauiTickPace` uses and for the same reason: the effect
      // this lane publishes is a property of the PARKED frame, and a reader outside the engine has
      // no other way to ask whether the snap ran. `Snapped` is the surfaces the last snap render
      // wrote whole — zero on a page with no adaptive shadow, zero under `=off`, and the count of
      // glass surfaces on screen otherwise. `Pending` says a snap is owed right now.
      const g = globalThis as unknown as {
        __jauiShadowSnap?: () => { Armed: boolean; SettleTaus: number; Snapped: number; Pending: boolean };
      };
      g.__jauiShadowSnap = () => ({
        Armed: this._shadowSnapArmed,
        SettleTaus: taus,
        Snapped: this._shadowSnapped,
        Pending: this._shadowSnapPending,
      });
    }
    if (params.has('no-panels')) this._diagNoPanels = true;
    if (params.has('no-shadow')) { this._diagNoShadow = true; JivInstanceBuffer.DiagNoShadow = true; }
    if (params.has('no-glass-draw')) this._diagNoGlassDraw = true;
    if (params.has('wkr-shared-backdrop') || hash.includes('wkr-shared-backdrop')) this._sharedBackdrop = true;
    if (params.has('lens-trace') || hash.includes('lens-trace')) this._lensTrace = true;
    if (params.has('no-shared-backdrop') || hash.includes('no-shared-backdrop')) this._sharedBackdrop = false;
    if (params.has('layer-cache') || hash.includes('layer-cache')) this._layerCacheEnabled = true;
    if (params.has('cache-force') || hash.includes('cache-force')) { this._layerCacheEnabled = true; this._cacheForce = true; }
    if (params.has('damage-test') || hash.includes('damage-test')) this._damageTest = true;
    // `?blur-first` — MEASUREMENT ONLY, WRONG PIXELS. See `_blurFirst`. Parsed LAST of the toggles
    // rather than beside `?blur-src-*`, because arming it is a decision about the OTHER flags: it
    // needs a blur source that does not depend on the scene, and it needs every other path that
    // changes which pyramids get built to be off. Each refusal names itself on the trace channel;
    // an instrument that quietly did nothing would publish the baseline under the flag's name.
    if (params.has('blur-first')) {
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : r.DiagBlurSrc === null ? 'needs-blur-src-clear-or-blur-src-static'
        : this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-build-nothing'
        : r.CardCompositeEnabled ? 'card-composite-builds-from-the-card-target'
        : this._sharedBackdrop ? 'shared-backdrop-builds-one-pyramid-lazily'
        : this._layerCacheEnabled ? 'layer-cache-skips-subtrees-the-prepass-would-walk'
        : null;
      if (why !== null) {
        JTrace(`jaui:blur-first armed=false reason=${why}`);
      } else {
        this._blurFirst = true;
        (r as WebGL2Renderer).DiagBlurFirst = true;
        // `?blur-src-static` fills its stand-in from the scene on FIRST USE, and under this flag
        // the first use is now the pre-pass — i.e. before anything has been drawn. The static
        // texture therefore captures a cleared scene and the two source arms collapse into one.
        // Said out loud rather than refused: the two arms already measure within 1% of each other
        // and of the baseline, so the collapse costs the experiment nothing and a reader who sees
        // `static` in the URL must not be left thinking it still held frame 1.
        if ((r as WebGL2Renderer).DiagBlurSrc === 'static') {
          JTrace('jaui:blur-first note=static-source-fills-from-an-undrawn-scene-so-it-reads-as-clear');
        }
      }
    }
    // `?scene-restarts=N` / `?small-restarts=N` - MEASUREMENT ONLY, PIXEL-IDENTICAL. The pair that
    // prices H5, the one hypothesis the xctrace join left standing: cost ~ the sum over ENCODERS of
    // (a fixed bubble + the target's tile load/store). Read `Core/Restart.Diag.ts` for the shape and
    // `WebGL2Renderer.DiagSceneRestarts` for the construction; what belongs here is only the gate.
    //
    // Every ordering experiment is dead - `?snap-once` moved the reads and the frame did not move,
    // the card composite took ends 40 -> 1 and cost 6.6%, and `?blur-first` reordered the builds
    // ahead of the bed and made the frame 6 ms SLOWER. So H5 has to be priced by a pair that moves
    // encoder COUNT and NOTHING else, and that is what these two are: same order, same builds, same
    // sources, same uniforms, +3N (scene) or +N (small) 1-px transparent draws.
    //
    // Both refuse rather than degrade, each refusal named on the trace, because an instrument that
    // quietly did something else would publish a number under the wrong flag's name:
    //   - `?cardcomposite` puts the walk's draws in a CARD target, where a probe draw would mark the
    //     card dirty and change which source a later backdrop read takes. That is a PIXEL change,
    //     and these two flags' whole contract is that the two-arm diff reads exactly 0.
    //   - `?blur-first` builds every pyramid ahead of the bed, so the insertion point is no longer
    //     the instant after a build handed the scene back - the scene may be mid-encoder there, and
    //     `?small-restarts`'s claim to add no scene restart would not hold. (It is WRONG PIXELS
    //     anyway, which is the other half of the reason.)
    //   - `?no-blur` and `?blur-dummy` break the SAME precondition from the other direction: the
    //     build issues no GL, so nothing unbound the scene and the encoder is still live at the
    //     insertion point. The small arm would then end it and the two arms would collapse into one.
    for (const flag of ['scene-restarts', 'small-restarts'] as const) {
      const raw = params.get(flag);
      if (raw === null) continue;
      const n = Number(raw);
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : raw.trim() === '' || !Number.isInteger(n) || n < 1 ? 'n-must-be-a-whole-number-of-restarts-at-least-1'
        : r.CardCompositeEnabled ? 'card-composite-draws-into-a-card-target-and-a-probe-draw-would-dirty-it'
        : this._blurFirst ? 'blur-first-moves-every-build-off-the-insertion-point'
        // `?blur-phased` is parsed BELOW this block, so its field cannot be read here -- the URL
        // can. Same defect as `?blur-first` and for the same reason: it pre-builds the pyramids in
        // an earlier phase, so the insertion point is no longer the instant after a build handed
        // the scene back, and the scene arm has no level 0 of this build's to end on. The two were
        // left un-refused at the blurphased fold and a combined cell was forbidden by hand; this
        // is that ban in code.
        : params.has('blur-phased') ? 'blur-phased-moves-every-build-off-the-insertion-point'
        : this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-leave-the-scene-encoder-live-at-the-insertion-point'
        : null;
      if (why !== null) { JTrace(`jaui:${flag} armed=false reason=${why}`); continue; }
      if (flag === 'scene-restarts') (r as WebGL2Renderer).DiagSceneRestarts = n;
      else (r as WebGL2Renderer).DiagSmallRestarts = n;
      // One cached narrowing so the two insertion points in the walk cost a null check when the
      // flags are off, instead of an `instanceof` per pyramid build.
      this._restartRenderer = r as WebGL2Renderer;
    }
    // `?pyramid-atlas` -- MEASUREMENT ARMS since Jack's fourth ruling. Parsed before
    // `?blur-phased` so that flag can refuse a combined arm by name: both run the phased
    // composition, and an arm running the atlas AND the measurement flag would be reading the
    // atlas under the measurement flag's pool.
    //
    // TWO ARMS IN ONE BINARY, and the bare flag is `fills`. AN ABSENT FLAG IS `off`:
    //
    //   fills  what the bare flag selects: the fills' atlas. Z-order is the baseline's, and the only
    //          change left in the frame is the one Jack approved.
    //   off    today's per-card, per-draw composition, byte for byte. THE UNFLAGGED ENGINE, and
    //          the "before" for every gate.
    //
    // The VALUE is one of those two and nothing else. A flag whose value was ignored would let
    // `?pyramid-atlas=0`, `=false`, `=no` all arm `fills` while reading as if they had turned it
    // off, which is the failure mode a measurement instrument exists to avoid.
    if (params.has('pyramid-atlas')) {
      const raw = (params.get('pyramid-atlas') ?? '').trim();
      if (raw !== '' && raw !== 'fills' && raw !== 'off') {
        throw new Error(`[Jaui] ?pyramid-atlas takes 'fills' or 'off', got '${raw}'`);
      }
      // The bare flag is `fills`; since Jack's fourth ruling an ABSENT flag is `off`, so the arm is
      // armed here and only here.
      this._pyramidAtlas = raw !== 'off';
    }
    // Everything the atlas cannot run beside, named one at a time and refused on the trace rather
    // than silently disarmed. Each of these owns the same machinery from the other end: the two
    // measurement flags move builds themselves, the card composite builds from a card target, the
    // shared backdrop is one canvas-sized pyramid rather than per-surface builds, and the layer
    // cache skips subtrees the phased walk would paint.
    if (this._pyramidAtlas) {
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-build-nothing-to-atlas'
        : this._blurFirst ? 'blur-first-already-moved-every-build-ahead-of-the-bed'
        : params.has('blur-phased') ? 'blur-phased-is-the-gate-arm-and-runs-the-builds-per-card'
        : r.CardCompositeEnabled ? 'card-composite-builds-from-the-card-target'
        : this._sharedBackdrop ? 'shared-backdrop-builds-one-pyramid-lazily'
        : this._layerCacheEnabled ? 'layer-cache-skips-subtrees-the-phased-walk-would-paint'
        : params.has('scene-restarts') || params.has('small-restarts')
          ? 'restart-probes-need-a-per-card-build-to-insert-after'
        : null;
      if (why !== null) {
        this._pyramidAtlas = false;
        JTrace(`jaui:pyramid-atlas armed=false reason=${why}`);
      } else {
        const gl2 = r as WebGL2Renderer;
        gl2.DiagPyramidAtlas = true;
        // TWO ATLASES HAVE TO BE RESIDENT AT ONCE and they are 55.37 MB on `glass-grid` at dpr 2,
        // past the shipped 48 MB chain budget which admits exactly one of them. So the pass runs
        // under the atlas's own ceiling -- `ATLAS_BUDGET_BYTES` -- and the planner refuses (splits
        // the run) rather than letting the pool evict, because an evicting pool reallocates whole
        // textures mid-frame and that thrash would be read as the atlas's own cost.
        //
        // No chain ROTATION: an atlas is one chain per phase, keyed by its own size, and the
        // twenty-way rotation `?blur-phased` needs exists only because twenty same-sized per-card
        // chains would otherwise be one. `MaxChains` is 8: at dpr 3 the planner returns several
        // groups of different sizes, which is several chains, plus the solo builds a refusal can
        // put beside them.
        gl2.DiagChainLimits = { MaxChains: 8, BudgetBytes: ATLAS_BUDGET_BYTES };
      }
    }
    // THE MARK, on both arms, from the line that decides. It does not live in the renderer's
    // `Init` beside the other measurement marks for the reason lane restarts2 wrote down: in
    // worker mode `Init` is awaited BEFORE the URL is parsed at all, so a mark taken there would
    // print `off` on every arm however the URL read. A reading taken without this line is a
    // reading of a build that predates the lever.
    JTrace(`jaui:pyramid-atlas armed=${this._pyramidAtlas ? 'fills' : 'off'}`
      // `default=true` means NOBODY ASKED: the arm on the line is the unflagged engine's. Since
      // Jack's fourth ruling that is `off`, and a reading that cannot tell "off by default" from
      // "off because the URL said so" cannot tell a control shot from an arm.
      + ` default=${!params.has('pyramid-atlas')}`
      + ` budget=${Math.round(ATLAS_BUDGET_BYTES / (1024 * 1024))}MB`
      + (this._pyramidAtlas ? ' pixels=DIFFERENT' : ''));
    this._phasedWalk = this._pyramidAtlas;
    // `?glass-presample=on|off` -- LIFT THE AREA GATE FOR A PER-SURFACE GLASS BUILD.
    //
    // DEFAULT OFF. Every other flag in this block that changes a picture defaults to the engine
    // it inherited, and this one changes a picture: the last 2x reconstruction moves from the
    // pyramid's 8-tap tent hop to the consumer's hardware bilinear. Jack has not seen it.
    //
    // Parsed after `?pyramid-atlas` because it interacts with it at the same build sites, and
    // refused beside it by NAME rather than left to the per-member clause in `AtlasAdmitsMember`.
    // That clause exists and is tested -- it stops a future caller combining the two in code -- but
    // a flag arm in which every member of the other flag's plan refuses is the vacuous shape this
    // ledger keeps being bitten by: an atlas with `members=0` wearing the atlas's name.
    if (params.has('glass-presample')) {
      const raw = (params.get('glass-presample') ?? '').trim();
      if (raw !== '' && raw !== 'on' && raw !== 'off') {
        throw new Error(`[Jaui] ?glass-presample takes 'on' or 'off', got '${raw}'`);
      }
      this._glassPresample = raw !== 'off';
    }
    if (this._glassPresample) {
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-build-no-pyramid-to-re-base'
        : r.DiagBlurSrc !== null ? 'blur-src-swaps-the-sampled-texture-under-both-arms'
        : this._sharedBackdrop ? 'shared-backdrop-builds-one-full-canvas-pyramid-the-gate-already-admits'
        : r.CardCompositeEnabled ? 'card-composite-pins-the-build-to-the-canvas-sized-snapshot-s-own-k'
        : this._pyramidAtlas ? 'pyramid-atlas-cannot-slot-the-pre-downsample-ping-pong'
        : params.has('scene-restarts') || params.has('small-restarts')
          ? 'restart-probes-insert-at-a-build-whose-pass-count-this-arm-moves'
        : null;
      if (why !== null) {
        this._glassPresample = false;
        this._glassPresampleRefused = why;
        JTrace(`jaui:glass-presample armed=off reason=${why}`);
      }
    }
    if (this._renderer instanceof WebGL2Renderer) {
      this._renderer.DiagGlassPresample = this._glassPresample;
    }
    // THE MARK, on both arms, from the line that decides -- never from the renderer's `Init`,
    // for the reason lane restarts2 wrote down: in worker mode `Init` is awaited BEFORE the URL
    // is parsed, so a mark taken there would print `off` on every arm however the URL read.
    JTrace(`jaui:glass-presample armed=${this._glassPresample ? 'on' : 'off'}`
      + ` default=${params.has('glass-presample') ? 'false' : 'true'}`
      + (this._glassPresample ? ' pixels=DIFFERENT' : '')
      + (this._glassPresampleRefused !== '' ? ` reason=${this._glassPresampleRefused}` : ''));

    // `?glass-gaussian=on|off|match` -- THE CHAIN REPLACED BY TWO SEPARABLE PASSES.
    //
    // DEFAULT OFF, and it is a picture change on BOTH live arms. Parsed LAST of the blur arms
    // because it interacts with every one of them at the same build sites, and refused beside
    // each of them by NAME rather than left to the per-member clauses in `PlanBorderDirect` /
    // `AtlasAdmitsMember`. Those clauses exist and are tested -- they are what stops a future
    // caller combining the two in code -- but a flag arm in which every member of the other
    // flag's plan refuses is the vacuous shape this ledger keeps being bitten by.
    //
    if (params.has('glass-gaussian')) {
      const raw = (params.get('glass-gaussian') ?? '').trim();
      if (raw !== '' && raw !== 'on' && raw !== 'off' && raw !== 'match') {
        throw new Error(`[Jaui] ?glass-gaussian takes 'on', 'off' or 'match', got '${raw}'`);
      }
      this._glassGaussian = raw === 'off' ? 'off' : raw === 'match' ? 'match' : 'on';
    }
    if (this._glassGaussian !== 'off') {
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-build-no-backdrop-to-replace'
        : r.DiagBlurSrc !== null ? 'blur-src-swaps-the-sampled-texture-under-both-arms'
        : this._sharedBackdrop ? 'shared-backdrop-is-one-full-canvas-mip-consumer-not-a-per-surface-build'
        : r.CardCompositeEnabled ? 'card-composite-pins-the-build-to-the-canvas-sized-snapshot'
        : this._glassPresample ? 'glass-presample-re-bases-a-chain-this-arm-does-not-build'
        : this._pyramidAtlas ? 'pyramid-atlas-packs-chain-levels-and-a-gaussian-build-has-none'
        : (params.has('glass-group') && (params.get('glass-group') ?? '').trim() !== 'off')
          ? 'glass-group-builds-one-shared-pyramid-per-group-and-this-arm-builds-per-surface'
        : params.has('scene-restarts') || params.has('small-restarts')
          ? 'restart-probes-insert-at-a-build-whose-pass-count-this-arm-moves'
        : null;
      if (why !== null) {
        this._glassGaussian = 'off';
        this._glassGaussianRefused = why;
        JTrace(`jaui:glass-gaussian armed=off reason=${why}`);
      }
    }
    if (this._renderer instanceof WebGL2Renderer) {
      this._renderer.DiagGlassGaussian = this._glassGaussian;
    }

    // `?blur-chain=on|off` -- THE PER-SURFACE GLASS BUILD'S PLAN.
    //
    // DEFAULT OFF, i.e. the SEPARABLE PLAN is the engine (`Core/Blur.Separable.ts`): k from the
    // sigma, one linear-sampled Gaussian pair at the residual, at the width today's chain DELIVERS
    // -- a true Gaussian in place of a four-step staircase that beats with period `2^depth`, in
    // `log2(k) + 2` passes where the chain paid `log2(k) + 2 * depth`. `?blur-chain=on` (or the
    // bare flag) is the control arm: the dual-filter chain byte for byte, so every earlier chain
    // cell stays reproducible in the new binary.
    //
    // Parsed after every blur arm it has to read. REFUSED BY NAME beside the three arms it
    // SUPERSEDES -- `?pyramid-atlas`, `?glass-presample`, `?glass-gaussian` are each an earlier
    // attempt at this lever on the chain, and a cell under one of them measures
    // that arm against the chain it was built on, so they keep the chain rather than compose --
    // and beside the diagnostics calibrated on the chain's pass count (`?blur-phased`,
    // `?blur-first`, the restart probes). `?glass-group` and `?shadow-probe` COMPOSE: a group's
    // union is a per-surface build of every member at once and takes the plan; the probe reads
    // the handle, whatever built it.
    if (params.has('blur-chain')) {
      const raw = (params.get('blur-chain') ?? '').trim();
      if (raw !== '' && raw !== 'on' && raw !== 'off') {
        throw new Error(`[Jaui] ?blur-chain takes 'on' or 'off', got '${raw}'`);
      }
      this._blurSeparable = raw === 'off';
    }
    if (params.has('blur-mips')) {
      const raw = (params.get('blur-mips') ?? '').trim();
      if (raw !== 'separable' && raw !== 'chain') {
        throw new Error(`[Jaui] ?blur-mips takes 'separable' or 'chain', got '${raw}'`);
      }
      this._blurSeparableMips = raw === 'separable';
    }
    if (params.has('blur-sigma')) {
      const raw = (params.get('blur-sigma') ?? '').trim();
      if (raw !== 'delivered' && raw !== 'authored') {
        throw new Error(`[Jaui] ?blur-sigma takes 'delivered' or 'authored', got '${raw}'`);
      }
      this._blurSigma = raw;
    }
    if (params.has('blur-k')) {
      const raw = (params.get('blur-k') ?? '').trim();
      if (raw !== 'round' && raw !== 'floor') {
        throw new Error(`[Jaui] ?blur-k takes 'round' or 'floor', got '${raw}'`);
      }
      this._blurKRule = raw;
    }
    if (params.has('blur-fetches')) {
      const raw = (params.get('blur-fetches') ?? '').trim();
      const n = Number(raw);
      RadiusForFetches(n);
      this._blurFetches = n;
    }
    if (params.has('gauss-upload')) {
      const raw = (params.get('gauss-upload') ?? '').trim();
      if (raw !== 'full' && raw !== 'prefix') {
        throw new Error(`[Jaui] ?gauss-upload takes 'full' or 'prefix', got '${raw}'`);
      }
      this._gaussUploadPrefix = raw === 'prefix';
    }
    // `?frame-trace[=N]` — a per-frame line, default cap 600 frames (~15s at 40fps). The cap is
    // the point: the trace report holds a bounded buffer and an uncapped per-frame mark would push
    // the boot marks out of it, which is exactly the timeline a frame investigation still needs.
    if (params.has('frame-trace')) {
      const raw = (params.get('frame-trace') ?? '').trim();
      const cap = raw === '' ? 600 : Number(raw);
      if (!Number.isFinite(cap) || cap <= 0) {
        throw new Error(`[Jaui] ?frame-trace takes a positive frame count, got '${raw}'`);
      }
      this._frameTrace = true;
      this._frameTraceCap = cap;
    }
    if (params.has('blur-temp')) {
      const raw = (params.get('blur-temp') ?? '').trim();
      if (raw !== 'discard' && raw !== 'clear' && raw !== 'keep') {
        throw new Error(`[Jaui] ?blur-temp takes 'discard', 'clear' or 'keep', got '${raw}'`);
      }
      this._blurTemp = raw;
    }
    BlurPass.TempLoad = this._blurTemp;
    // `?mip-mrt=on|off`: levels 2+ of an output mip chain written to scratch AND their slot in one
    // two-target draw, instead of a draw and then a blit. See `BlurPass.MipMrt`.
    if (params.has('mip-mrt')) {
      const raw = (params.get('mip-mrt') ?? '').trim();
      if (raw !== 'on' && raw !== 'off') throw new Error(`[Jaui] ?mip-mrt takes 'on' or 'off', got '${raw}'`);
      BlurPass.MipMrt = raw === 'on';
    }
    JTrace(`jaui:mip-mrt armed=${BlurPass.MipMrt ? 'on' : 'off'} pixels=SAME`);
    // `?extent-snap=N`: every blur extent rounds up to a multiple of N (a power of two), so surfaces
    // of nearly-equal size share one level-0 size. Holds the builds and `k`; moves only the page's
    // count of distinct extents (`distinctExtents=` on the plan's gate line). Absent is 1, the engine.
    if (params.has('extent-snap')) {
      const raw = (params.get('extent-snap') ?? '').trim();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 256 || (n & (n - 1)) !== 0) {
        throw new Error(`[Jaui] ?extent-snap takes a power of two in 1..256, got '${raw}'`);
      }
      RegionExtentSnap.Unit = n;
    }
    if (this._blurSeparable) {
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : this._pyramidAtlas ? 'pyramid-atlas-packs-chain-levels-and-is-superseded-by-the-separable-plan'
        : this._glassPresample ? 'glass-presample-re-bases-a-chain-and-is-superseded-by-the-separable-plan'
        : this._glassGaussian !== 'off' ? 'glass-gaussian-is-the-separable-arm-this-plan-supersedes'
        : params.has('blur-phased') ? 'blur-phased-was-calibrated-on-the-chain-s-pass-count'
        : params.has('blur-first') ? 'blur-first-was-calibrated-on-the-chain-s-pass-count'
        : params.has('scene-restarts') || params.has('small-restarts')
          ? 'restart-probes-insert-at-a-build-whose-pass-count-this-plan-moves'
        : null;
      if (why !== null) {
        this._blurSeparable = false;
        this._blurSeparableRefused = why;
      }
    }
    if (this._renderer instanceof WebGL2Renderer) {
      this._renderer.DiagBlurSeparable = this._blurSeparable;
      this._renderer.DiagBlurSigma = this._blurSigma;
      this._renderer.DiagBlurFetches = this._blurFetches;
      this._renderer.DiagBlurKRule = this._blurKRule;
    }
    BlurPass.ForceFetches = this._blurFetches;
    BlurPass.GaussUploadPrefix = this._gaussUploadPrefix;

    // `?gauss-debug` rides a separable path and means nothing without one: asked where neither is
    // armed it is refused by name rather than silently doing nothing ("no magenta, clean").
    if (params.has('gauss-debug')) {
      this._gaussDebug = this._glassGaussian !== 'off' || this._blurSeparable;
      if (!this._gaussDebug) JTrace('jaui:gauss-debug armed=off reason=no-separable-path-is-armed');
    }
    BlurPass.GaussDebugMagenta = this._gaussDebug;
    // THE MARK, on both arms, from the line that decides -- never from the renderer's `Init`, for
    // the reason lane restarts2 wrote down: in worker mode `Init` is awaited BEFORE the URL is
    // parsed, so a mark taken there would print `off` on every arm however the URL read.
    JTrace(`jaui:glass-gaussian armed=${this._glassGaussian}`
      + ` default=${!params.has('glass-gaussian')}`
      + (this._glassGaussian === 'off' ? ' pixels=SAME' : ' pixels=DIFFERENT')
      + (this._glassGaussian === 'match' ? ` sigma=${GAUSS_MATCH_SIGMA}` : '')
      + (this._gaussDebug ? ' debug=magenta' : '')
      + (this._glassGaussianRefused !== '' ? ` reason=${this._glassGaussianRefused}` : ''));
    // THE MARK, on both arms, from the line that decides. `compile=` is where the separable kernel
    // sat in its batch (`boot#<i>` on every worker page): the per-load compile ORDER stamp the
    // Metal defect's third candidate asked for. `none` in main-thread mode, where `Init` has not run.
    JTrace(`jaui:blur-plan armed=${this._blurSeparable ? 'separable' : 'chain'}`
      + ` default=${!params.has('blur-chain')}`
      + ` mips=${this._blurSeparable && this._blurSeparableMips ? 'separable' : 'chain'}`
      + ` sigma=${this._blurSigma} k=${this._blurKRule} fetches=${this._blurFetches ?? 'auto'}`
      + ` upload=${this._gaussUploadPrefix ? 'prefix' : 'full'}`
      // The mark fires once at arm time, BEFORE any frame has rendered, so a counter here would read
      // 0 for ever and be worse than absent. `clears=` is on the GATE LINE instead, which prints on a
      // shape change while rendering. Said here because the Mac had to reach the worker-side census
      // through playwright to verify this arm at all, and that gap was mine.
      + ` temp=${this._blurTemp}`
      + ` compile=${this._renderer instanceof WebGL2Renderer ? this._renderer.BlurPlanCensus.Compile : 'none'}`
      + (this._gaussDebug ? ' debug=magenta' : '')
      + (this._blurSeparable ? ' pixels=DIFFERENT' : ' pixels=SAME')
      + (this._blurSeparableRefused !== '' ? ` reason=${this._blurSeparableRefused}` : ''));
    {
      const g = globalThis as unknown as { __jauiBlurPlan?: () => BlurPlanCensus };
      g.__jauiBlurPlan = () => {
        const r = this._renderer;
        const on = r instanceof WebGL2Renderer;
        const c = on ? r.BlurPlanCensus : null;
        return {
          Armed: this._blurSeparable ? 'separable' : 'chain',
          Sigma: this._blurSigma,
          KRule: this._blurKRule,
          Fetches: this._blurFetches,
          Upload: this._gaussUploadPrefix ? 'prefix' : 'full',
          SepBuilds: c?.SepBuilds ?? 0,
          SepPasses: c?.SepPasses ?? 0,
          SepFill: c?.SepFill ?? 0,
          SepReads: c?.SepReads ?? 0,
          ChainBuilds: c?.ChainBuilds ?? 0,
          ChainPasses: c?.ChainPasses ?? 0,
          ChainFill: c?.ChainFill ?? 0,
          ChainReads: c?.ChainReads ?? 0,
          Classes: c?.Classes ?? 'none',
          Draws: c?.Draws ?? '',
          DrawsTotal: c?.DrawsTotal ?? 0,
          Targets: c?.Targets ?? '',
          Compile: c?.Compile ?? 'none',
          TempClears: c?.TempClears ?? 0,
          PlanRefused: c?.Refused ?? 'none',
          Refused: this._blurSeparableRefused,
        };
      };
    }
    // `?glass-group=on|off` -- THE CONTAINER-SCOPED SHARED BACKDROP.
    //
    // DEFAULT ON since 2026-09-20 (Jack: "Adopt Apple's rule"; the seven-shot gate saw the phased
    // picture on fb52642: 30,102 px, max 12, mean 2.25). `=off` is yesterday's per-card picture. The change
    // is the one already shot as "phased" on `glass-grid` (34,830 px, 0.85%, max 12, mean 2.1 --
    // a card no longer refracting its earlier neighbour's glass in the 24 px gap band), and the
    // default moves when seven shots match it. See `_glassGroup` for the law.
    //
    // Parsed LAST of the blur arms, after `?pyramid-atlas` and `?glass-presample`, because it interacts with all of them at the same build site and is
    // refused beside each BY NAME. The per-member clauses in `_planGlassGroups` would refuse most
    // of these too, and they are tested -- they are what stops a future caller combining the two
    // in code -- but a flag arm in which every member refuses is the vacuous shape this ledger
    // keeps being bitten by: `groups=0 members=0 fallbacks=20` wearing the group's name, priced
    // as though it had grouped something.
    if (params.has('glass-group')) {
      const raw = (params.get('glass-group') ?? '').trim();
      if (raw !== '' && raw !== 'on' && raw !== 'off') {
        throw new Error(`[Jaui] ?glass-group takes 'on' or 'off', got '${raw}'`);
      }
      this._glassGroup = raw !== 'off';
    }
    if (this._glassGroup) {
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-build-no-pyramid-to-share'
        : r.DiagBlurSrc !== null ? 'blur-src-swaps-the-sampled-texture-under-both-arms'
        // THE FOUR THE BRIEF NAMES, each for its own reason and each stated rather than inherited.
        //
        // `?wkr-shared-backdrop` is the one worth saying out loud, because it is the lever this
        // looks most like and is not. That arm builds ONE canvas-wide QUARTER-RESOLUTION sharp-root
        // pyramid per frame, hands every surface in the tree the same texture whatever its
        // container, and makes each of them climb a mip chain from a base LOD of 2 to find its own
        // sigma. This arm builds a FULL-RESOLUTION level 0 at the MEMBERS' OWN sigma, over the
        // union of ONE container's members, with no LOD constant anywhere -- every member still
        // samples level 0 at lod 0 through `u_BackdropXf` exactly as it does today. Different
        // resolution, different sigma, different scope, different sampling. The two cannot be
        // armed together because the shared arm has already answered `lastBackdrop` for every
        // surface before this site is reached.
        : this._sharedBackdrop ? 'wkr-shared-backdrop-is-one-global-quarter-res-pyramid-at-a-lod-constant'
        : this._pyramidAtlas ? 'pyramid-atlas-packs-a-chain-per-member-into-slots-of-one-texture'
        : this._glassPresample ? 'glass-presample-re-bases-a-build-onto-a-k-the-union-pin-contradicts'
        : this._glassGaussian !== 'off' ? 'glass-gaussian-replaces-the-per-surface-chain-this-arm-shares-one-of'
        // And the coherence refusals: anything that has already answered "where does this
        // surface's pyramid come from" before the group site is reached, or that moves the
        // capture point this flag's whole law is about.
        : r.CardCompositeEnabled ? 'card-composite-builds-from-the-card-target-not-the-scene'
        // `params.has`, not the fields: `?blur-phased` is parsed AFTER this block (it has to see
        // every flag it interrogates) and `?blur-first` self-refuses without `?blur-src-*`, so a
        // field read here would let either of them arm beside a group that thought it was alone.
        : params.has('blur-first') ? 'blur-first-already-built-every-pyramid-ahead-of-the-walk'
        : params.has('blur-phased') ? 'blur-phased-captures-every-build-at-one-instant-not-at-group-entry'
        : params.has('scene-restarts') || params.has('small-restarts')
          ? 'restart-probes-insert-at-a-build-whose-count-this-arm-moves'
        : this._diagNoGlass || this._diagNoUi ? 'a-no-star-diagnostic-removes-the-surfaces-this-groups'
        : null;
      if (why !== null) {
        this._glassGroup = false;
        this._glassGroupRefused = why;
        JTrace(`jaui:glass-group armed=off reason=${why}`);
      }
    }
    // THE MARK, on both arms, from the line that decides -- never from the renderer's `Init`, for
    // the reason lane restarts2 wrote down: in worker mode `Init` is awaited BEFORE the URL is
    // parsed, so a mark taken there would print `off` on every arm however the URL read.
    JTrace(`jaui:glass-group armed=${this._glassGroup ? 'on' : 'off'}`
      + ` default=${!params.has('glass-group')}`
      + (this._glassGroup ? ' pixels=SAME' : ' pixels=DIFFERENT')
      + (this._glassGroupRefused !== '' ? ` reason=${this._glassGroupRefused}` : ''));
    {
      const g = globalThis as unknown as { __jauiGlassGroup?: () => GlassGroupCensus };
      g.__jauiGlassGroup = () => {
        const r = this._renderer;
        const on = r instanceof WebGL2Renderer;
        const st = this._glassGroupStats;
        return {
          Armed: this._glassGroup,
          Groups: st.Groups,
          Builds: on ? r.GroupBuilds : 0,
          Members: on ? r.GroupMembers : 0,
          Fallbacks: on ? r.GroupFallbacks : 0,
          Blur: on ? (r.SceneEndsByKey['blur'] ?? 0) : 0,
          Rects: st.Rects,
          Refused: this._glassGroupRefused,
        };
      };
    }

    // `?shadow-probe=walk|group` -- WHERE A GROUP MEMBER'S ADAPTIVE-SHADOW PROBE RUNS.
    //
    // DEFAULT `walk`, today's engine byte for byte, while the M4 prices `group`; see `_shadowProbe`.
    // Parsed after `?glass-group`'s refusals, because `group` probes AT that arm's capture and
    // there is nothing to probe at without one. Refused BY NAME, most specific first, so a refused
    // cell says which flag did it rather than only that the group was off:
    //   `?blur-phased`      runs its own probe pass (`_phasedShadowProbes`) beside its own builds;
    //   `?scene-restarts` / `?small-restarts`  insert their point AFTER the walk's probe and price
    //                       a segment count this arm moves;
    //   `?shadow-snap=off`  a measured arm of the probe's ease, held to the probe it was measured on;
    //   `?glass-group=off`  (or refused) no group, no capture to probe at.
    if (params.has('shadow-probe')) {
      const raw = (params.get('shadow-probe') ?? '').trim();
      if (raw !== 'walk' && raw !== 'group') {
        throw new Error(`[Jaui] ?shadow-probe takes 'walk' or 'group', got '${raw}'`);
      }
      this._shadowProbe = raw;
    }
    if (this._shadowProbe === 'group') {
      const why =
        params.has('blur-phased') ? 'blur-phased-probes-in-its-own-pass-beside-its-own-builds'
        : params.has('scene-restarts') || params.has('small-restarts')
          ? 'restart-probes-insert-after-the-walk-probe-and-price-the-segments-this-arm-moves'
        : !this._shadowSnapArmed ? 'shadow-snap-off-is-an-arm-of-the-probe-ease-held-to-the-walk-probe'
        : !this._glassGroup ? 'glass-group-off-no-group-no-capture-to-probe-at'
        : null;
      if (why !== null) {
        this._shadowProbe = 'walk';
        this._shadowProbeRefused = why;
      }
    }
    JTrace(`jaui:shadow-probe armed=${this._shadowProbe} default=${!params.has('shadow-probe')} pixels=SAME`
      + (this._shadowProbeRefused !== '' ? ` reason=${this._shadowProbeRefused}` : ''));
    {
      const g = globalThis as unknown as { __jauiShadowProbe?: () => ShadowProbeCensus };
      g.__jauiShadowProbe = () => {
        const r = this._renderer;
        const on = r instanceof WebGL2Renderer;
        return {
          Mode: this._shadowProbe,
          Probes: on ? r.ShadowProbes : 0,
          Batches: on ? r.ShadowProbeBinds : 0,
          Ends: on ? (r.SceneEndsByKey['shadow-state'] ?? 0) : 0,
          Grouped: this._shadowProbeStats.Grouped,
          Moved: this._shadowProbeStats.Moved,
          Refused: this._shadowProbeRefused,
        };
      };
    }

    // `?glass-skip=<stage>[,<stage>...] | all | none | off` -- THE GLASS DRAW, STAGE BY STAGE.
    //
    // DEFAULT OFF, picture-DIFFERENT on every non-zero mask by design: each stage bit removes one
    // stage of the glass fragment (`Glass.Skip.GLASS_SKIP_STAGES`) through ONE uniform, in the same
    // program, with the same draws, extents and blend. `none` arms it at mask 0 -- the control, the
    // unflagged pixels, the census on. Parsed after every blur arm so the refusals can read them.
    //
    // Refusals BY NAME keep a cell one-variable. `?glass-gaussian` changes the SOURCE of the
    // sample, not the draw. And `?no-glass-draw` / `?no-glass` / `?no-ui` remove the draws this arm
    // is about: every stage would price nothing.
    //
    // `?glass-group` (the default) COMPOSES: it changes how the backdrop is BUILT and hands every
    // member the same draw with a different pyramid handle, so the draws this arm gates are the ones
    // it would gate without it. `tests/Glass.Skip.test.ts` walks both and asserts it.
    if (params.has('glass-skip')) {
      this._glassSkip = ParseGlassSkip(params.get('glass-skip') ?? '');
    }
    if (this._glassSkip !== null) {
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : this._glassGaussian !== 'off' ? 'glass-gaussian-changes-the-source-of-the-sample-not-the-draw'
        : this._diagNoGlassDraw || this._diagNoGlass || this._diagNoUi
          ? 'a-no-star-diagnostic-removes-the-glass-draws-this-arm-prices'
        : null;
      if (why !== null) {
        this._glassSkip = null;
        this._glassSkipRefused = why;
        JTrace(`jaui:glass-skip armed=off reason=${why}`);
      }
    }
    if (this._renderer instanceof WebGL2Renderer) {
      this._renderer.DiagGlassSkip = this._glassSkip ?? 0;
      this._renderer.DiagGlassSkipCensus = this._glassSkip !== null;
    }
    // THE MARK, on both arms, from the line that decides -- never from the renderer's `Init`, for
    // the reason lane restarts2 wrote down: in worker mode `Init` is awaited BEFORE the URL is
    // parsed, so a mark taken there would print `off` on every arm however the URL read.
    {
      const mask = this._glassSkip ?? 0;
      const names = GlassSkipNames(mask);
      JTrace(`jaui:glass-skip armed=${this._glassSkip === null ? 'off' : names.length === 0 ? 'none' : names.join(',')}`
        + ` mask=${mask} default=${!params.has('glass-skip')}`
        + ` pixels=${mask === 0 ? 'SAME' : 'DIFFERENT'}`
        + (this._glassSkipRefused !== '' ? ` reason=${this._glassSkipRefused}` : ''));
      const g = globalThis as unknown as { __jauiGlassSkip?: () => GlassSkipCensus };
      g.__jauiGlassSkip = () => {
        const rr = this._renderer;
        const on = rr instanceof WebGL2Renderer;
        const m = this._glassSkip ?? 0;
        return {
          Armed: this._glassSkip !== null,
          Mask: m,
          Stages: GlassSkipNames(m),
          Draws: on ? rr.GlassDraws : 0,
          Census: on ? { ...rr.GlassCensus } : EmptyGlassFragCensus(),
          Refused: this._glassSkipRefused,
        };
      };
    }

    // `?atlas-instanced` -- how the atlas's hops are ISSUED, and nothing else. Parsed after the
    // atlas and its refusals so the mark can say whether there is an atlas to instance at all: it
    // is inert under `off`, which since Jack's fourth ruling is the unflagged engine. On/off by
    // name only, for the reason every flag in this block is: a value that was ignored would let
    // `=0` and `=no` arm the default while reading as if they had turned it off.
    if (params.has('atlas-instanced')) {
      const raw = (params.get('atlas-instanced') ?? '').trim();
      if (raw !== '' && raw !== 'on' && raw !== 'off') {
        throw new Error(`[Jaui] ?atlas-instanced takes 'on' or 'off', got '${raw}'`);
      }
      this._atlasInstanced = raw !== 'off';
    }
    if (this._renderer instanceof WebGL2Renderer) this._renderer.DiagAtlasInstanced = this._atlasInstanced;
    // `pixels=SAME`, unlike every other flag in this block -- an instanced slot quad and a
    // viewport-clipped one land on the same window-space rectangle with integer corners, and the
    // rasterizer's subpixel snap cannot tell them apart. See `VERT_INST` in `Core/BlurPass.ts`.
    JTrace(`jaui:atlas-instanced armed=${this._atlasInstanced ? 'on' : 'off'}`
      + ` atlas=${this._pyramidAtlas ? 'fills' : 'off'}`
      + ` inert=${!this._pyramidAtlas} pixels=SAME`);
    // `?blur-phased` -- MEASUREMENT ONLY, DIFFERENT PIXELS. See `_blurPhased`. Parsed LAST, after
    // `?blur-first`, because it has to see every flag it interrogates AND because the two are
    // mutually exclusive: both move pyramid builds, and an arm running both would be measuring
    // neither. Each refusal names itself on the trace channel; an instrument that quietly did
    // nothing would publish the baseline under the flag's name.
    if (params.has('blur-phased')) {
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-build-nothing-to-phase'
        : this._blurFirst ? 'blur-first-already-moved-every-build-ahead-of-the-bed'
        : r.CardCompositeEnabled ? 'card-composite-builds-from-the-card-target'
        : this._sharedBackdrop ? 'shared-backdrop-builds-one-pyramid-lazily'
        : this._layerCacheEnabled ? 'layer-cache-skips-subtrees-the-phased-walk-would-paint'
        : null;
      if (why !== null) {
        JTrace(`jaui:blur-phased armed=false reason=${why}`);
      } else {
        this._blurPhased = true;
        this._phasedWalk = true;
        const gl2 = r as WebGL2Renderer;
        gl2.DiagBlurPhased = true;
        // THE POOL, WHICH IS THE ONE THING THIS FLAG CANNOT LEAVE ALONE.
        //
        // `BlurPass._useChain` keys a chain on its LEVEL-0 SIZE, so twenty consecutive fill builds
        // of a twenty-card grid land on ONE chain and each overwrites the level textures the
        // previous build wrote. At baseline that is harmless, because each card's DRAW happens
        // between its build and the next; phase 2 draws nothing, so it is not. The fix is the
        // rotation `?blur-chains=N` already folded: N chains per size handed out round-robin per
        // build, so twenty consecutive builds of a size get twenty distinct chains.
        //
        // N defaults to PHASED_CHAINS and an explicit `?blur-chains=N` alongside wins, so a scene
        // with more than twenty surfaces of one size can be measured by saying so rather than by
        // reading a quietly wrong picture. If a scene DOES exceed N, builds N apart share a chain
        // and the gate's `chains`/`sizes` and the pool's own census are where that shows.
        //
        // The ceilings have to come up with it, and by how much is arithmetic rather than taste:
        // twenty 568x436 fill chains at 1.65 MB plus twenty 480x348 rim chains at 1.11 MB is 40
        // chains and 55.3 MB, against a shipped MAX_CHAINS of 6 and a 48 MB budget. So the flag
        // hands the pool `MAX_CHAINS * PHASED_CHAINS` chains and twice the budget -- 120 and
        // 96 MB, comfortably over the 55.3 MB the arm actually holds, so an eviction under this
        // flag means the SCENE is bigger than the flag was sized for and the pool's refusal line
        // says so rather than thrashing quietly. Handed in at construction and never mutated:
        // there is nothing to restore when the flag is off, because an unflagged process never
        // builds a pass that carries them. The `jaui:blur-phased armed=true` mark prints both.
        if (gl2.DiagBlurChains === null) gl2.DiagBlurChains = PHASED_CHAINS;
        gl2.DiagChainLimits = {
          MaxChains: MAX_CHAINS * PHASED_CHAINS,
          BudgetBytes: CHAIN_BUDGET_BYTES * 2,
        };
        // Under `?blur-src-clear` / `-static` every build reads the same stand-in, so the pixel
        // change this flag makes -- a fill pyramid seeing the bed instead of its earlier
        // neighbours' glass -- cannot exist. That pairing is a PURE COUNT test and its two-arm
        // diff against `?blur-src-*` alone must read exactly 0. Said out loud, because the mark
        // still prints `pixels=DIFFERENT` and a reader is entitled to know when it does not.
        if (gl2.DiagBlurSrc !== null) {
          JTrace('jaui:blur-phased note=blur-src-holds-the-source-constant-so-this-arm-is-a-pure-count-test');
        }
      }
    }
    // `?occlusion` -- AN OPAQUE FILL LATER OPAQUE FILLS COVER IS NOT DRAWN. Default ON, and parsed
    // here, after every flag it interrogates, because every one of its refusals is a flag that
    // moves either WHICH nodes paint or the ORDER they paint in -- and the pre-pass's whole claim
    // is that it answers those two questions the same way the walk does.
    //
    // `?occlusion=off` is the previous engine in the same binary: no pre-pass, no verdict, no
    // instance withheld. On/off by name only, for the reason every flag in this block is -- a value
    // that was ignored would let `=0` and `=no` arm the default while reading as if they had not.
    if (params.has('occlusion')) {
      const raw = (params.get('occlusion') ?? '').trim();
      if (raw !== '' && raw !== 'on' && raw !== 'off') {
        throw new Error(`[Jaui] ?occlusion takes 'on' or 'off', got '${raw}'`);
      }
      this._occlusion = raw !== 'off';
    }
    // Each refusal names the thing it cannot stand beside, and each is a property of the URL rather
    // than of a frame, so the decision is taken once here and the walk pays one boolean. The layer
    // cache composites a subtree from a cached FBO and the pre-pass does not model it; the phased
    // and pre-pass blur arms REORDER the paint and pre-build pyramids the walk would build later,
    // so "later than P" stops meaning what it means here; the card composite draws into a target
    // that is not the scene; and the `no-*` diagnostics remove the very draws this reasons about.
    if (this._occlusion) {
      const r = this._renderer;
      const why =
        this._layerCacheEnabled ? 'layer-cache-composites-a-subtree-the-pre-pass-does-not-model'
        : this._phasedWalk || this._blurPhased ? 'phased-walk-repaints-the-tree-in-three-passes'
        : this._blurFirst ? 'blur-first-builds-every-pyramid-ahead-of-the-fills-it-would-withhold'
        : this._diagNoPanels || this._diagNoUi || this._diagNoGlass || this._diagNoPblur
          ? 'a-no-star-diagnostic-already-removes-the-draws-this-reasons-about'
        : r instanceof WebGL2Renderer && r.CardCompositeEnabled
          ? 'card-composite-draws-into-a-target-that-is-not-the-scene'
        : null;
      if (why !== null) {
        this._occlusion = false;
        this._occlusionStats.Refused = why;
      }
    }
    // THE MARK, on both arms, from the line that decides -- never from the renderer's `Init`, for
    // the reason lane restarts2 wrote down: in worker mode `Init` is awaited BEFORE the URL is
    // parsed, so a mark taken there would print `off` on every arm however the URL read.
    // `default=true` means nobody asked, so a reader can tell a control shot from an arm.
    JTrace(`jaui:occlusion armed=${this._occlusion ? 'on' : 'off'}`
      + ` default=${!params.has('occlusion')}`
      + ` minArea=1/${Math.round(1 / OCCLUSION_MIN_AREA_FRACTION)}`
      + ` maxPieces=${DEFAULT_OCCLUSION_LIMITS.MaxPieces} pixels=SAME`
      + (this._occlusionStats.Refused !== '' ? ` reason=${this._occlusionStats.Refused}` : ''));
    {
      const g = globalThis as unknown as { __jauiOcclusion?: () => OcclusionCensus };
      g.__jauiOcclusion = () => ({ Armed: this._occlusion, ...this._occlusionStats });
    }
    // `?emptypanels` -- A PANEL THAT PAINTS NOTHING IS NOT PUSHED. Default ON.
    //
    // `?emptypanels=off` is the previous engine in the same binary: the predicate is not asked and
    // no instance is withheld. On/off by name only, as every flag in this block is.
    if (params.has('emptypanels')) {
      const raw = (params.get('emptypanels') ?? '').trim();
      if (raw !== '' && raw !== 'on' && raw !== 'off') {
        throw new Error(`[Jaui] ?emptypanels takes 'on' or 'off', got '${raw}'`);
      }
      this._emptyPanelCull = raw !== 'off';
    }
    // ONE refusal, and it is not a correctness one: `?no-panels` and `?no-ui` already remove the
    // draws this reasons about, so an arm that kept the counters would report a saving nobody
    // paid for. Every other flag in this file is INDIFFERENT to this lever and deliberately not
    // refused: the decision is per instance with no cross-node dependency, so nothing that
    // reorders the walk (`?blur-phased`, `?pyramid-atlas`, `?blur-first`), caches a subtree
    // (`?layer-cache`) or retargets a draw (the card composite) can change the answer -- a panel
    // that paints nothing paints nothing in whatever order, into whatever target, from whatever
    // cache. Those passes count instances only to BATCH them, never to decide anything.
    if (this._emptyPanelCull && (this._diagNoPanels || this._diagNoUi)) {
      this._emptyPanelCull = false;
      this._emptyPanelStats.Refused = 'a-no-star-diagnostic-already-removes-the-draws-this-reasons-about';
    }
    JTrace(`jaui:emptypanels armed=${this._emptyPanelCull ? 'on' : 'off'}`
      + ` default=${!params.has('emptypanels')}`
      + ' pixels=SAME'
      + (this._emptyPanelStats.Refused !== '' ? ` reason=${this._emptyPanelStats.Refused}` : ''));
    {
      const g = globalThis as unknown as { __jauiEmptyPanels?: () => EmptyPanelCensus };
      g.__jauiEmptyPanels = () => ({ Armed: this._emptyPanelCull, ...this._emptyPanelStats });
    }
    // `?vibrancy=` -- the shape draw's two implementations (Core/Vibrancy.ts). Default `on`: under the
    // element when nothing else there samples, folded into the grade when something does. `graded`
    // sends EVERY shape draw through the fold, the equivalence arm; `off` draws none, the null arm.
    if (params.has('vibrancy')) {
      const raw = (params.get('vibrancy') ?? '').trim();
      if (raw !== 'on' && raw !== 'graded' && raw !== 'off') {
        throw new Error(`[Jaui] ?vibrancy takes 'on', 'graded' or 'off', got '${raw}'`);
      }
      Vibrancy.Mode = raw as VibrancyMode;
    }
    JTrace(`jaui:vibrancy armed=${Vibrancy.Mode} default=${!params.has('vibrancy')}`
      + (Vibrancy.Mode === 'on' ? '' : ' pixels=DIFFERENT'));
    {
      const g = globalThis as unknown as { __jauiVibrancy?: () => unknown };
      // The blend counters live on the RENDERER, counted at the draw call.
      g.__jauiVibrancy = () => this._vibrancyCensus();
    }
    // `?blur-cache=on|off|verify` -- A CLEAN BACKDROP DOES NOT REBUILD ITS BLUR. Default ON.
    //
    // Parsed after every flag it interrogates, and each refusal names the thing it cannot stand
    // beside. They are all one of two shapes: an arm that answers "where does this surface's pyramid
    // come from" before the build site is reached (so there is no build to skip, or a stand-in with
    // no backdrop to key), or an arm that moves WHICH draws land in the scene or the ORDER they land
    // in outside the paint records the cache reasons from. `?glass-group` (default on) is NOT
    // refused: its groups take their own pyramid and are counted `grouped=`, and its fallbacks --
    // every surface on the phone's home page -- are ordinary builds the cache keys.
    if (params.has('blur-cache')) {
      const raw = (params.get('blur-cache') ?? '').trim();
      if (raw !== '' && raw !== 'on' && raw !== 'off' && raw !== 'verify') {
        throw new Error(`[Jaui] ?blur-cache takes 'on', 'off' or 'verify', got '${raw}'`);
      }
      this._blurCache = raw === 'off' ? 'off' : raw === 'verify' ? 'verify' : 'on';
    }
    if (this._blurCache !== 'off') {
      const r = this._renderer;
      const why =
        !(r instanceof WebGL2Renderer) ? 'webgl2-only'
        : this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-build-no-pyramid-to-keep'
        : r.DiagBlurSrc !== null ? 'blur-src-builds-from-a-stand-in-not-the-backdrop'
        : this._sharedBackdrop ? 'shared-backdrop-builds-one-canvas-pyramid-this-cache-does-not-key'
        : this._layerCacheEnabled ? 'layer-cache-composites-subtrees-outside-the-paint-records'
        : this._damageTest ? 'damage-test-culls-draws-with-a-hardcoded-rect'
        : this._blurFirst ? 'blur-first-pre-builds-every-pyramid-ahead-of-the-walk'
        : this._phasedWalk || this._blurPhased ? 'phased-walk-paints-the-tree-in-three-passes'
        : r.CardCompositeEnabled ? 'card-composite-retargets-the-walk-into-card-targets'
        : this._glassGaussian !== 'off' ? 'glass-gaussian-reads-the-scene-past-the-read-guard'
        : params.has('scene-restarts') || params.has('small-restarts')
          ? 'restart-probes-insert-at-builds-a-hit-does-not-make'
        : params.has('ablate') ? 'ablate-switches-arms-mid-run-and-a-kept-pyramid-would-cross-arms'
        : null;
      if (why !== null) {
        this._blurCache = 'off';
        this._blurCacheRefused = why;
      }
    }
    // THE MARK, on every arm, from the line that decides -- never from the renderer's `Init`, for the
    // reason lane restarts2 wrote down: in worker mode `Init` is awaited BEFORE the URL is parsed.
    JTrace(`jaui:blur-cache armed=${this._blurCache} default=${!params.has('blur-cache')}`
      + ` budget=${Math.round(BLUR_CACHE_BUDGET_BYTES / (1024 * 1024))}MB guard=${BLUR_READ_GUARD_PX}px`
      + ` maxPieces=${DAMAGE_MAX_PIECES} pixels=SAME`
      + (this._blurCacheRefused !== '' ? ` reason=${this._blurCacheRefused}` : ''));
    // `?ablate[=a,b,...]` -- THE PHONE PRICES ITS OWN ARMS. See `_ablate`. Needs `?trace` to report.
    if (params.has('ablate')) {
      const raw = (params.get('ablate') ?? '').trim();
      const known = ABLATE_ARMS;
      const arms = raw === '' ? [...known] : raw.split(',').map((a) => a.trim());
      for (const a of arms) {
        if (!known.includes(a)) throw new Error(`[Jaui] ?ablate arm '${a}' is not one of ${known.join(',')}`);
      }
      // CONTROL BETWEEN EVERY ARM. Arms run in sequence while the page scrolls, so an arm late in the
      // cycle meets a different stretch of page than one early in it: the first phone trace had
      // no-shadow and no-occlusion 8-21 ms SLOWER than control, which is the scroll, not the arm.
      // Interleaving puts a control slot beside every arm, and the pooled control spans the cycle.
      const tested = arms.filter((a) => a !== 'control');
      arms.length = 0;
      for (const a of tested) arms.push('control', a);
      if (arms.length === 0) arms.push('control');
      this._ablateSnapBase = RegionExtentSnap.Unit;
      this._ablateMipMrtBase = BlurPass.MipMrt;
      this._ablate = { Arms: arms, I: 0, Count: 0, Last: 0, Skip: true, Cycle: 0, Samples: new Map() };
      this._ablateApply('control');
      JTrace(`jaui:ablate armed arms=${arms.join(',')} frames=${ABLATE_FRAMES} cache=off`);
    }
    {
      const g = globalThis as unknown as { __jauiBlurCache?: () => BlurCacheCensus };
      g.__jauiBlurCache = (): BlurCacheCensus => {
        const r = this._renderer;
        const gl2 = r instanceof WebGL2Renderer ? r : null;
        return {
          Armed: this._blurCache,
          Refused: this._blurCacheRefused,
          Frame: this._bcLastFrame,
          Session: { ...this._bcSession },
          Bytes: gl2 !== null ? gl2.BlurCacheBytes : 0,
          Slots: gl2 !== null ? gl2.BlurCacheSlots : 0,
          BudgetBytes: gl2 !== null ? gl2.BlurCacheBudgetBytes : BLUR_CACHE_BUDGET_BYTES,
          Renderer: gl2 !== null ? gl2.BlurCacheCensus : null,
        };
      };
    }
    {
      const g = globalThis as unknown as { __jauiGlassGaussian?: () => GlassGaussianCensus };
      g.__jauiGlassGaussian = () => {
        const r = this._renderer;
        const on = r instanceof WebGL2Renderer;
        return {
          Armed: this._glassGaussian,
          Builds: on ? r.GaussianBuilds : 0,
          Passes: GAUSS_PASSES,
          TotalPasses: on ? r.GaussianPasses : 0,
          Sigma: on ? r.LastGaussianSigma : 0,
          Fetches: on ? r.LastGaussianFetches : 0,
          Blur: on ? (r.SceneEndsByKey['blur'] ?? 0) : 0,
          TempMb: on ? r.GaussTempCensus.Mb : 0,
          TempCoverWritten: on ? r.GaussTempCensus.CoverWritten : 0,
          TempCoverReadable: on ? r.GaussTempCensus.CoverReadable : 0,
          Debug: this._gaussDebug,
          PlanRefused: on ? r.LastGaussianRefusal : '',
          Refused: this._glassGaussianRefused,
        };
      };
    }
    {
      const g = globalThis as unknown as { __jauiGlassPresample?: () => GlassPresampleCensus };
      g.__jauiGlassPresample = () => {
        const r = this._renderer;
        const on = r instanceof WebGL2Renderer;
        return {
          Armed: this._glassPresample,
          Builds: on ? r.PresampledBuilds : 0,
          K: on ? r.LastPresampleK : 1,
          Blur: on ? (r.SceneEndsByKey['blur'] ?? 0) : 0,
          Refused: this._glassPresampleRefused,
        };
      };
    }
    // ── THE PROGRAMS THE ARMS ABOVE NEED, COMPILED HERE ──────────────────────────────────────
    // LAST in this method, after every flag has been read and every refusal taken, because what a
    // page compiles is decided by the arms that actually survived -- a `?pyramid-atlas` refused for
    // `card-composite-builds-from-the-card-target` must not leave five atlas kernels behind it.
    //
    // And HERE rather than in `Init`, for the ordering lane restarts2 wrote down: on the worker
    // path Init is awaited BEFORE this method exists to run, so a flag-gated compile there would be
    // dead on every arm. This line is the far side of that trap and still ahead of the first tick
    // (`Start` runs after this constructor returns), so a program an arm needs is compiled off the
    // frame and a program no arm needs is never compiled at all.
    if (this._renderer instanceof WebGL2Renderer) this._renderer.ArmFlaggedPrograms();
  };

  // ── Debug Layout Overlay ───────────────────────────────────────────────────
  // `?debug-layout` draws a 1px rainbow stroke around every Jiv each frame.
  // Useful for eyeballing layout issues (wrong size, missing padding, etc).
  // Rendered into a 2D canvas layered on top of Jaui's canvas — lets the
  // main render path stay untouched.

  private _debugLayout: boolean = false;
  private _debugLayoutCanvas: HTMLCanvasElement | null = null;
  private _debugLayoutCtx: CanvasRenderingContext2D | null = null;

  private _enableDebugLayout = (): void => {
    if (this._debugLayout || typeof document === 'undefined') return;
    this._debugLayout = true;
    const overlay = document.createElement('canvas');
    overlay.style.cssText = [
      'position:absolute',
      'top:0', 'left:0',
      'width:100%', 'height:100%',
      'pointer-events:none',
      'z-index:2147483646',
    ].join(';');
    const host = this.Element.parentElement;
    if (host) {
      const cs = getComputedStyle(host);
      if (cs.position === 'static') host.style.position = 'relative';
      host.appendChild(overlay);
    }
    this._debugLayoutCanvas = overlay;
    this._debugLayoutCtx = overlay.getContext('2d');
  };

  private _drawDebugLayout = (): void => {
    const canvas = this._debugLayoutCanvas;
    const ctx = this._debugLayoutCtx;
    if (!canvas || !ctx) return;
    const dpr = this._dpr;
    const rect = this._pageRect();
    const pw = Math.max(1, Math.round(rect.width * dpr));
    const ph = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineWidth = 1;

    // Collect every Jiv + absolute position in a single tree walk.
    const hits: Array<{ x: number; y: number; w: number; h: number }> = [];
    // node.X / node.Y are ABSOLUTE post-layout (JivAnimator writes result.X/Y
    // directly). Only thing accumulated down the tree is scroll-offset
    // corrections from ancestors with Overflow: Scroll — matches the
    // render walk's `offsetX` semantics.
    const walk = (node: Jiv, sx: number, sy: number): void => {
      if (!node.Visible) return;
      const vx = node.X + sx;
      const vy = node.Y + sy;
      hits.push({ x: vx, y: vy, w: node.Width, h: node.Height });
      const childSx = node.Overflow === 'Scroll' ? sx - node.ScrollX : sx;
      const childSy = node.Overflow === 'Scroll' ? sy - node.ScrollY : sy;
      for (const c of node.Children) {
        const pin = (c as Jiv).ChildLayout.Position === 'Pinned' && node.Overflow === 'Scroll';
        walk(c as Jiv, pin ? sx : childSx, pin ? sy : childSy);
      }
    };
    walk(this.Root, 0, 0);

    const total = Math.max(1, hits.length);
    for (let i = 0; i < hits.length; i++) {
      const { x, y, w, h } = hits[i];
      const hue = Math.round((i * 360) / total);
      ctx.strokeStyle = `hsl(${hue}, 100%, 60%)`;
      // Zero-sized nodes (text jivs before their first measurement, or
      // collapsed containers) still draw a tiny crosshair so you can see
      // they exist in the tree.
      if (w < 1 || h < 1) {
        ctx.beginPath();
        ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y);
        ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
        ctx.stroke();
      } else {
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      }
    }
  };

  // GL call counting removed — WebGPU uses timestamp queries for profiling.

  /** Build the HUD overlay. Fixed-position, monospace, semi-transparent; pointer-
   *  events disabled so it never intercepts scroll/hover. Appended to body so
   *  it survives canvas re-parenting and doesn't need special CSS from hosts. */
  private _enableDebugHud = (): void => {
    if (this._debugHud || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:2147483647',
      'padding:4px 8px',
      'background:rgba(0,0,0,0.6)',
      'color:#0f0',
      'font:12px/1.3 ui-monospace,Menlo,Consolas,monospace',
      'pointer-events:none',
      'white-space:pre',
      'border-radius:4px',
    ].join(';');
    el.textContent = 'FPS --';
    const attach = (): void => { document.body.appendChild(el); };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
    this._debugHud = el;
  };

  /** Called from `_tick` with the current rAF timestamp. Writes the delta into
   *  the rolling buffer, then (throttled) updates the HUD textContent. Keeps
   *  the hot path allocation-free — the template literal produces one string
   *  per DOM write, not per frame. */
  private _updateHud = (time: number): void => {
    if (!this._debugHud) return;

    // _lastTime is 0 on the very first frame (set by Start); skip it so we
    // don't feed a huge bogus delta into the window.
    if (this._lastTime === 0) return;
    const dtMs = time - this._lastTime;

    const buf = this._hudDeltas;
    buf[this._hudIdx] = dtMs;
    this._hudIdx = (this._hudIdx + 1) % buf.length;
    if (this._hudCount < buf.length) this._hudCount++;

    // Throttle DOM writes to ~10Hz. Every frame would make the HUD itself
    // a measurable cost on low-power devices.
    if (time - this._hudLastWrite < 100) return;
    this._hudLastWrite = time;

    let sum = 0, min = Infinity, max = 0;
    for (let i = 0; i < this._hudCount; i++) {
      const v = buf[i];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const avg = sum / Math.max(1, this._hudCount);
    const fps = avg > 0 ? 1000 / avg : 0;
    const w = this._width;
    const h = this._height;

    const avgPhase = (arr: Float32Array): number => {
      if (this._frameCount === 0) return 0;
      let s = 0;
      for (let i = 0; i < this._frameCount; i++) s += arr[i];
      return s / this._frameCount;
    };
    const pDirty  = avgPhase(this._phaseDirty);
    const pLayout = avgPhase(this._phaseLayout);
    const pText   = avgPhase(this._phaseText);
    const pRender = avgPhase(this._phaseRender);
    const c = this._countsRolling;

    // GPU time — averaged over whatever readings we have. Null when the
    // backend doesn't implement it (WebGPU today) or the extension isn't
    // available on this driver — show "—" so the HUD doesn't lie with 0.
    let gpuDisplay = '—';
    if (this._phaseGpuCount > 0) {
      const n = Math.min(this._phaseGpuCount, this._phaseGpu.length);
      let gs = 0;
      for (let i = 0; i < n; i++) gs += this._phaseGpu[i];
      gpuDisplay = (gs / n).toFixed(2);
    }

    const hudText =
      `FPS ${fps.toFixed(1)} | ms ${avg.toFixed(1)} (min ${min === Infinity ? 0 : min.toFixed(1)} max ${max.toFixed(1)}) | dpr ${this._dpr} | ${w}x${h}\n` +
      `cpu: dirty ${pDirty.toFixed(2)}  layout ${pLayout.toFixed(2)}  text ${pText.toFixed(2)}  render ${pRender.toFixed(2)} | gpu ${gpuDisplay} ms\n` +
      `draws — panels ${c.Panels}  glass ${c.Glass}  text ${c.Text}  img ${c.Image}  pblur ${c.PBlur}\n` +
      `scene — restarts ${c.SceneRestarts}  reads ${c.SceneReads}  switches ${c.SceneSwitches}`
      + `  |  cards ${c.CardComposites} (fallback ${c.CardFallbacks})`;
    this._debugHud.textContent = hudText;
    this._debugLatest = hudText;

    // Console mirror disabled while diagnosing cold-load — the per-second
    // dump drowns out BootProfiler / instrumentation lines. The on-screen
    // HUD still updates 10×/s; `__jaui.canvas.DebugText` getter is the
    // copy-paste escape hatch.
    void this._debugLogLast;
  };

  /** Current HUD text as a single string. Set when `?debug` is active and
   *  the HUD updates (~10Hz). Safe to read anytime from the console. */
  get DebugText(): string | null { return this._debugLatest; }
  private _debugLatest: string | null = null;
  private _debugLogLast: number = 0;

  /** Walks the tree, runs each Janvas's foreign renderer at its layout rect.
   *  Called once per frame, between BeginScenePass and the panel pass, so
   *  foreign content lands in the scene FBO and gets composited under any
   *  panels Jaui draws on top.
   *
   *  WebGL viewport coordinates are bottom-left origin; Element coords are
   *  top-left. We flip Y here so the foreign renderer can think in normal
   *  screen-space without learning Jaui's quirks. */
  private _renderJanvases(
    gl: WebGL2RenderingContext,
    node: JauiElement,
    offsetX: number,
    offsetY: number,
    canvasW: number,
    canvasH: number,
    dt: number,
    /** Active rounded clip (device px, top-left). When set, the foreign
     *  renderer's writes are stencil-clipped to this shape — letting the
     *  janvas honour its ancestor's `Overflow:Hidden` + `BorderRadius`,
     *  same as Jaui's own panel pass already does for jivs. */
    clip: { x: number; y: number; w: number; h: number; radius: number; smoothness: number } | null,
  ): void {
    if (node instanceof Janvas) {
      const renderer = node.Renderer;
      if (renderer && node.Width > 0 && node.Height > 0 && node.Visible) {
        if (!node.IsInited()) {
          // Route the foreign renderer's dirty signal through both the janvas
          // (its own per-field skip) AND RequestFrame, so new 3D content wakes
          // the render-on-demand loop. Without the RequestFrame, a janvas that
          // changed while the UI was idle would not repaint.
          renderer.Init(gl, () => { node.MarkDirty(); this.RequestFrame(); });
          // Also wake the loop on any external Invalidate() of this janvas (the
          // foreign-renderer change path that doesn't go through Init's callback).
          node.Invalidate = this.RequestFrame;
          node.MarkInited();
        }
        const d = this._dpr;
        const px = Math.round((node.X + offsetX) * d);
        const py = Math.round((node.Y + offsetY) * d);
        const pw = Math.round(node.Width * d);
        const ph = Math.round(node.Height * d);
        const yFromBottom = canvasH - py - ph;
        gl.viewport(px, yFromBottom, pw, ph);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(px, yFromBottom, pw, ph);

        const r = this._renderer as WebGL2Renderer;
        const fbo = r.GetSceneFramebuffer();
        renderer.Render(gl, fbo, { X: px, Y: yFromBottom, Width: pw, Height: ph }, dt);
        node.ClearDirty();
        // `?blur-cache`: a foreign renderer's pixels are opaque to the ledger, and `MarkDirty` is not
        // a complete declaration of them (`Invalidate` wakes the loop without it, and `Render` gets a
        // `dt` to animate by). So a janvas that rendered is ALWAYS changed over its viewport.
        if (this._bcOn) this._bc.Declare(node, RECORD_JANVAS, 'janvas', px, py, px + pw, py + ph);

        // Defer the visual clip mask to the end of the frame. Wiping scene
        // FBO pixels here destroys data that in-tree consumers need: a
        // descendant pblur (e.g. HeroLeftBlur over a fullscreen Reality
        // janvas) snapshots the scene to build its blur pyramid; if the
        // wipe ran first, the rounded-corner regions sample as transparent
        // black, smearing darkness into the blur. We queue (drawRect,
        // clipRect, radius) and apply them after the panel pass — visual
        // clipping for the presented frame, intact source for sampling.
        if (clip) {
          this._pendingJanvasMasks.push({
            drawX: px, drawY: py, drawW: pw, drawH: ph,
            clipX: clip.x, clipY: clip.y, clipW: clip.w, clipH: clip.h,
            radius: clip.radius, smoothness: clip.smoothness,
          });
        }
      }
    }

    // Update active clip for descendants if this node is a clipping container.
    let childClip = clip;
    if (node instanceof Jiv) {
      if (node.ClipsChildren && node.Width > 0 && node.Height > 0) {
        const d = this._dpr;
        const px = Math.round((node.X + offsetX) * d);
        const py = Math.round((node.Y + offsetY) * d);
        const pw = Math.round(node.Width * d);
        const ph = Math.round(node.Height * d);
        const radii = node.RenderStyle?.BorderRadius;
        const r0 = radii ? radii[0] : 0;
        const smoothness = node.RenderStyle?.BorderRadiusSmoothness ?? 0;
        childClip = { x: px, y: py, w: pw, h: ph, radius: r0 * d, smoothness };
      }
    }

    for (const child of node.Children) {
      this._renderJanvases(gl, child, node.X + offsetX, node.Y + offsetY, canvasW, canvasH, dt, childClip);
    }
  }
}

/** Nodes in a subtree. First-frame instrumentation only — it says how big the tree the first
 *  layout solved actually was, which is the difference between "layout is slow" and "the page is
 *  big". Never called on a steady-state frame. */
const _countNodes = (node: JauiElement): number => {
  let n = 1;
  for (const child of node.Children) n += _countNodes(child);
  return n;
};

/**
 * Jaui — top-level app instance. Thin facade over `Canvas` that owns the
 * renderer creation and exposes the user-facing surface as a single
 * cohesive thing: `new Jaui(el)` instead of `new Canvas(el, new WebGL2Renderer())`.
 *
 * Use this for app-level concerns (start/stop, JSS vars, image loads).
 * For low-level primitives (instance buffers, scroll manager, dirty flags)
 * reach the underlying `Canvas` via `.Canvas`.
 */
/** Runs once, right after the first frame is presented: a trace mark for the first paint. */
let _firstFrameHook: (() => void) | null = null;
export const OnFirstFrame = (hook: () => void): void => { _firstFrameHook = hook; };

export class Jaui {
  /** The underlying canvas — exposed for low-level access. */
  readonly Canvas: Canvas;

  /** Shortcut for `Canvas.Root` — what `<jiv>` uses as a fallback parent. */
  get Root(): Jiv { return this.Canvas.Root; }

  /** Image cache — load images/SVGs here, reference them from Jivs. */
  get Images(): ImageCache { return this.Canvas.Images; }

  /**
   * @param canvasEl  HTMLCanvasElement to render into.
   * @param opts.renderer  Optional renderer override; defaults to a fresh
   *                       WebGL2Renderer (sync init, safe for descendants
   *                       that read `Root` in their own ngOnInit).
   */
  constructor(canvasEl: HTMLCanvasElement, opts?: { renderer?: Renderer; platform?: Platform }) {
    const r = opts?.renderer ?? new WebGL2Renderer();
    void r.Init(canvasEl);
    this.Canvas = new Canvas(canvasEl, r, opts?.platform ?? BrowserPlatform);
  }

  /** Start the render loop (rAF). */
  Start(): void { this.Canvas.Start(); }

  /** Push the active JSS var table into the canvas — called by the Angular
   *  layer whenever the JssRegistry version bumps. */
  SetJssVars(vars: Map<string, string>): void { this.Canvas.SetJssVars(vars); }
}

// Walks the hit ancestor chain. Disabled stops the walk and forces default
// (so a disabled button kills its own pointer cursor); otherwise the first
// non-Default Cursor wins, mimicking CSS cursor inheritance so children of
// a button automatically pick up the button's pointer.
//
// Fallback: if no explicit Cursor is set anywhere in the chain AND the hit
// Jiv carries text, return the I-beam — text content reads as selectable by
// default. Any ancestor with an explicit Cursor (e.g. Pointer on a link)
// still wins via the loop above.
const _resolveCursor = (hit: Jiv | null): string => {
  for (let n: Jiv | null = hit; n; n = n.Parent as Jiv | null) {
    if (n.Disabled) return '';
    if (n.Cursor !== 'Default') return _CURSOR_CSS[n.Cursor];
  }
  if (hit && hit.Text !== null) return _CURSOR_CSS.Text;
  return '';
};

const _CURSOR_CSS: Record<'Default' | 'Pointer' | 'Text' | 'Move' | 'None', string> = {
  Default: '',
  Pointer: 'pointer',
  Text: 'text',
  Move: 'move',
  None: 'none',
};

// ─── Re-exports by slice ───

export { Janvas } from '../Janvas/Janvas';
export type { JanvasRenderer, JanvasRect } from '../Janvas/Janvas.Renderer';

export { Jath } from './Jath';
export { Jiv } from '../Jiv/Jiv';

// Core
export type { Vec2, Vec4, Rect, Color, DeviceTier, DirtyFlags } from './Types';
export { DirtyFlag } from './Types';
export type { Renderer } from './Renderer';
// The renderer is exported directly; the caller constructs it and hands it to `new Canvas(el, renderer)`.
export { WebGL2Renderer } from './WebGL2.Renderer';

// Jiv
export type { JivStyle, CornerShape, MaterialType, ProgressiveBlurDirection, BackgroundValue, GradientStop } from '../Jiv/Jiv.Types';
export type { FitMode } from '../Element/Element';
export { DefaultJivStyle } from '../Jiv/Jiv.Defaults';

// Glass presets
export { LiquidGlass, ClearGlass } from '../Glass/Glass.Presets';

// Layout
export type {
  LayoutMode, FlexDirection, FlexWrap, JustifyContent, AlignItems, AlignContent,
  PositionMode, Overflow, LayoutConfig, ChildLayout, LayoutResult,
  GridConfig, GridTrack,
} from '../Layout/Layout.Types';
export { DefaultLayoutConfig, DefaultChildLayout } from '../Layout/Layout.Types';
export { SolveFlex, type FlexContainer, type FlexChild } from '../Layout/Layout.Flex';
export { ResolveLengthTuple4 } from '../Core/Length.Tuple';
export { SolveLayout } from '../Layout/Layout.Solver';
export { ComputeIntrinsicSizes } from '../Layout/Layout.Intrinsic';

// Transform
export type { Transform } from '../Transform/Transform.Types';

// Text
export type { TextStyle, TextAlign, TextOverflow, FontStyle, TextMeasurement, TextConfig } from '../Text/Text.Types';
export { DefaultTextStyle } from '../Text/Text.Types';
export { MeasureText } from '../Text/Text.Measure';
export { HashTextKey } from '../Text/Text.Hash';
export { TextCache } from '../Text/Text.Cache';

// Image
export type { ImageStyle, ObjectFit } from '../Image/Image.Types';
export { ImageCache, RecolorSvg, type ImageEntry } from '../Image/Image.Cache';

// Scroll
export type { ScrollConfig, ScrollAlign, ScrollAxis, ScrollMotion, ScrollToOptions } from '../Scroll/Scroll.Types';

// Animation
export type {
  SpringConfig,
  TransitionConfig,
  AnimationDefinition,
  AnimationApplication,
  AnimationStop,
  LoopMode,
} from '../Animation/Animation.Types';
export { AnimationManager } from '../Animation/Animation.Manager';
export { JivAnimator } from '../Jiv/Jiv.Animator';
export { Spring } from '../Animation/Spring';
export { JivAnimationDriver } from '../Animation/Animation.Driver';

// Accessibility
export type { AccessibilityConfig } from '../Accessibility/Accessibility.Types';

// JSS
export { ParseJss, MergeRulesets } from '../Jss/Jss.Parser';
export type { Stylesheet, Ruleset, ParsedJss, VarTable, AnimationTable, PredicateExpr, PredicateStyle } from '../Jss/Jss.Parser';
export { EvaluatePredicate } from '../Jss/Jss.Predicate';
export { SlotFor, type Slot } from '../Jss/Jss.Routes';
export { THEME_DARK_VAR, THEME_LIGHT_VAR } from './Style.Resolver';

// SVG vector renderer — the SvgJiv binding parses a DOM <svg> + tessellates on the
// main thread, then ships the geometry to the worker via JivHandle.SetSvgVector.
export { ParseSvgElement, ParseSvgString, FlatnessTol2 } from '../Svg/Svg.Parse';
export { BuildVectorPaint, type SvgVectorPaint, type SvgFillShape, type SvgStrokeShape, type SvgTextRun } from '../Svg/Svg.VectorPaint';
export type { ParsedSvg, SvgNode, SvgPathNode, SvgTextNode, SvgContour, SvgFillRule } from '../Svg/Svg.Types';

// Boot tracing — the host installs a sink and every engine mark lands on its timeline.
export { OnJauiTrace, JauiTracing, type JauiTraceSink } from '../Diagnostics/Jaui.Trace';

// Worker boot — apps call CheckBrowserSupport() before mounting Angular.
export { CheckBrowserSupport, type BrowserSupportResult } from '../Worker/Browser.Support';
export { MainBridge, RootId, type BridgeOptions, type JivHitHandlers } from '../Worker/Bridge.Main';
export { JivHandle, type ScrollTarget } from '../Worker/Jiv.Handle';
export { CanvasProxy } from '../Worker/Canvas.Proxy';
// NO SPAWN HELPER, deliberately. `SpawnJauiWorker()` used to live here over a `new Worker(new
// URL('./Jaui.Worker.ts', import.meta.url))` pointing at a default entry that registered no janvas
// renderers, and nothing had called it since show-studio started shipping its own worker entry. It
// was not merely dead: a bundler resolves that static URL whether or not the function is reachable,
// so every build emitted a whole third `worker-<hash>.js` nobody could ever run — and made the
// remaining two impossible to tell apart by name, which is what the early-boot hint has to do. A
// consumer writes the `new Worker` in its own source, because only its own source knows which
// renderers the worker must register before `BootJauiWorker`.
export { BootJauiWorker } from '../Worker/Worker.Boot';
export {
  RegisterJanvasRenderer,
  LookupJanvasRenderer,
  type JanvasRendererFactory,
} from '../Worker/Worker.RendererRegistry';
export type { JanvasFactoryContext } from '../Janvas/Janvas.Renderer';
export type { JivApplyOpts, JivOp, M2W, W2M, PointerPayload, WheelPayload } from '../Worker/Bridge.Types';
export type { ProbeNode, ProbeRect, ProbeSnapshot, ProbeText } from '../Probe/Probe.Types';

// DOM embeds — the only way real DOM (an iframe, a <video>, a map) lives on a
// canvas app. `<jembed>` in Jaui.Angular is the consumer-facing form.
export {
  EmbedLayer, EmbedSlot, IsInsideEmbed, EMBED_ATTRIBUTE,
} from '../Embed/Embed.Layer';
export {
  MeasureEmbedBox, EmbedBoxesEqual, HIDDEN_EMBED_BOX,
  type EmbedBox, type EmbedTreeNode,
} from '../Embed/Embed.Geometry';
