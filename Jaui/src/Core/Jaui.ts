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
import { JTrace, JMs } from '../Diagnostics/Jaui.Trace';
import { BumpFontGeneration, MeasureText } from '../Text/Text.Measure';
import { TextAnimator } from '../Text/Text.Animator';
import { ResolveTextStyle, type ResolvedTextStyle } from '../Text/Text.Types';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE } from '../Jiv/Jiv.InstanceBuffer';
import { TextInstanceBuffer, TEXT_FLOATS_PER_INSTANCE } from '../Text/Text.InstanceBuffer';
import { ClipStackBuffer, EmptyClipStack, type ClipShape, type ClipStack } from './Clip.Stack';
import { type Mat2x3, MAT_IDENTITY, matMul, matApplyX, matApplyY, matScaleX, matScaleY, matCos, matSin } from '../Transform/Mat2x3';
import { ParseColor } from './Color.Parse';
import { type Mat3x3, mat3Mul, mat3FromAffine, mat3Project3D, mat3ApplyPoint } from '../Transform/Mat3x3';
import { XformBuffer } from '../Transform/Xform.Buffer';
import { SHADOW_EASE_SECONDS, SHADOW_SETTLE_TAUS, SHADOW_SETTLE_TAUS_UNSNAPPED, type Renderer, type GpuTextureHandle, type BgPaint, type ShadowBackdrop } from './Renderer';
// `?blur-first` names the pyramid pool's own chain key so the report can say how many chains
// forty builds actually resolve to. These three are the exact functions `BlurPass.Blur` uses to
// pick it, exported for exactly this reason (see `BaseDownsampleFactor`'s own note) — a second
// copy of the rule would be a count that can silently disagree with the pass it is counting.
import {
  BaseDownsampleFactor, PyramidDepth, ResolveRegionRect, MAX_CHAINS, CHAIN_BUDGET_BYTES,
  type AtlasBuildMember,
} from './BlurPass';
import { PlanBackdropAtlas, AtlasAdmitsMember, ATLAS_LIMITS_WIRED, ATLAS_BUDGET_BYTES } from './Blur.Atlas';
import { PassWindowOf, PassWindowText, type PassProfile } from './Pass.Timers';
import { TickPace, ParseTickPace, TickPaceText, PACE_STALL_TICKS, type PaceGate, type PaceCensus, type PaceWaited } from './Tick.Pace';
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

/** Headroom for the shader's fwidth-driven refraction-footprint LOD, which rises where a strong bend
 *  FOLDS the backdrop and the caustic has to dissolve into blur (Jiv.Panel.frag, `refractLod`). It has
 *  no closed form, so this is the bound the glass path has always assumed — it used to be the literal
 *  5 passed to GenerateBlurMipmap. It only counts when `frostReq` is non-zero. */
const REFRACT_FOLD_LOD = 5;

/** The frost LOD an INSTANCE carries. Mirror of Jiv.InstanceBuffer (`data[offset + 35]`). */
const _instanceFrostLod = (frostBlurPt: number, dpr: number): number =>
  Math.max(0, Math.min(10, Math.log2(Math.max(0.5, frostBlurPt * dpr))));

/** Below this instance frost LOD a panel may still take `sampleBackdrop`'s raw-scene branch, so it
 *  needs a snapshot bound. The shader's own threshold is 0.01; this sits WELL above it because the
 *  shader reads a float32 attribute and this side computes in float64, and a panel that fell through
 *  to the u_Scene sampler with no snapshot bound would paint the dummy texture. Every real class is
 *  either 0 frost or a whole point of it, so the widened band costs nothing. */
const SCENE_TAP_FROST_LOD = 0.05;

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
 *  much of a mip chain is worth building.
 *
 *  Mirror of Jiv.Panel.frag. `sampleBackdrop` reads `max(0, frostLod - u_BaseFrostLod) + extraLod`; the
 *  glass branch's extraLod is
 *      lodBoost = ((rimBoost * 1.5 + innerBlur) * glassiness + refractLod) * frostReq
 *      frostReq = clamp((frostLod - u_BaseFrostLod) * 4, 0, 1)
 *  with rimBoost <= 1 at the silhouette; the border zone then adds its own `BorderFilter: Blur(n)`
 *  offset as `bLod = max(0, lodBoost + lodOffset)`.
 *
 *  The per-surface glass path builds the pyramid AT the panel's own frost sigma, so frostLod equals
 *  u_BaseFrostLod, frostReq is exactly 0, and the whole boost collapses: the panel reads LOD 0 and
 *  nothing above it. That case returned 0 here is what lets the mip chain be skipped outright instead
 *  of built, blitted and never opened. */
const _backdropMaxLod = (
  frostLod: number,
  baseFrostLod: number,
  thicknessDev: number,
  innerBlur: number,
  borderLodOffset: number,
): number => {
  const frostReq = Math.max(0, Math.min(1, (frostLod - baseFrostLod) * 4));
  let lodBoost = 0;
  if (frostReq > 0) {
    const t = Math.max(0, Math.min(1, thicknessDev));
    const glassiness = t * t * (3 - 2 * t);   // smoothstep(0, 1, thickness)
    lodBoost = ((1.5 + innerBlur) * glassiness + REFRACT_FOLD_LOD) * frostReq;
  }
  const borderLod = Math.max(0, lodBoost + borderLodOffset);
  return Math.max(0, frostLod - baseFrostLod) + Math.max(lodBoost, borderLod);
};

/** True when a non-glass panel has any non-default backdrop filter set
 *  (BackdropBrightness / Saturation / Contrast ≠ 1, BackdropFrostBlur > 0).
 *  These flat panels need the blur pyramid bound and the scene flushed just
 *  like glass does, so the shader's backdrop sample reflects everything
 *  drawn behind the panel. */
const _hasBackdropFilter = (node: Jiv): boolean => {
  const s = node.RenderStyle;
  return Math.abs(s.BackdropBrightness - 1) > 0.001
    || Math.abs(s.BackdropSaturation - 1) > 0.001
    || Math.abs(s.BackdropContrast - 1) > 0.001
    || s.BackdropFrostBlur > 0.001
    || Math.abs(s.Tint) > 0.001;
};
import { DirtyFlag } from './Types';
import { Element as JauiElement, type DirtyTracker } from '../Element/Element';
import { Jiv } from '../Jiv/Jiv';
import { ScrollManager } from '../Scroll/Scroll.Manager';
import type { ScrollToOptions } from '../Scroll/Scroll.Types';
import { PresenceManager } from '../Animation/Presence.Manager';
import { SelectionManager } from '../Selection/Selection.Manager';
import { WebGL2Renderer, PANEL_PROGRAM_COUNT } from './WebGL2.Renderer';
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
   *  Two reaches, and the bound is their max rather than their sum, because they are reached from
   *  different fragments. The DRAW QUAD is the node's box expanded by
   *  `max(ShadowBlur + |ShadowOffset|, BorderWidth + BorderBlur)` (`Jiv.InstanceBuffer`), and
   *  `sampleBackdrop` runs on every fragment of it including the shadow skirt -- where the
   *  refraction hump has decayed to under 2e-4 and the displacement is nil. The REFRACTION and
   *  chromatic-aberration displacement is reached from fragments at the shape's own edge, which
   *  is inside the box. A border-only pass reads 0: its one tap is the border zone's, which
   *  offsets INWARD along the normal.
   *
   *  Not clamped to the canvas here: the admission test does that, because a fragment outside the
   *  canvas is never rasterized and a reach that leaves it is therefore not a reach at all. */
  TapReach: number;
  /** Whether the adaptive-shadow probe will run for this surface (it deepens `MaxLod`). */
  AdaptiveShadow: boolean;
  /** `BackdropFrostBlur` floored at 1pt — what the margin and the radius are built from. */
  FrostCssPx: number;
}

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
  private _specTiltX: number = 0;
  private _specTiltY: number = 0;
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
  /** Pre-built pyramid handle per glass surface, one map per SITE — a node's fill pyramid and its
   *  rim pyramid are different regions at different sizes and must not collide in one map. */
  private _blurFirstFill = new Map<Jiv, GpuTextureHandle>();
  private _blurFirstRim = new Map<Jiv, GpuTextureHandle>();
  /** Which of the two build sites the pre-pass traversal issues a build at. `'both'` is
   *  `?blur-first`, which moves every pyramid in the frame ahead of the bed in one pass.
   *  `?blur-phased` runs the SAME traversal twice with `'fill'` and then `'rim'`, because its
   *  whole point is that the rim pyramids are built from a scene the fills have already been
   *  drawn into. Nothing else about the traversal changes, which is what keeps one answer to
   *  "which surfaces build" rather than two. */
  private _prepassSites: 'both' | 'fill' | 'rim' = 'both';
  /** The flag's own gate, reported once per shape change on the trace channel.
   *
   *  `Used` + `Missed` must equal `Fill` + `Rim`, and `Missed` must be 0: a MISS is the walk
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
  private _blurFirstStats = { Fill: 0, Rim: 0, Used: 0, Missed: 0, Dup: 0, Coarse: 0, Chains: 0, Keys: '' };
  private _blurFirstKeys = new Set<string>();
  private _blurFirstLastLine: string = '';

  // ── `?blur-phased` — MEASUREMENT ONLY, DIFFERENT PIXELS ──────────────────────────
  /** The frame in THREE scene encoders instead of forty-odd.
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
   *  Today's walk restarts the scene encoder twice per card: fill build, fill draw, rim build, rim
   *  draw. Phased, the frame runs in five passes over the same tree and three scene encoders:
   *
   *    1. the bed, and every node ahead of the FIRST surface that builds a pyramid   — encoder A
   *    2. ALL the fill pyramids, from the scene as of (1)      — the first read ends A, rest free
   *    3. ALL the fills and their children, in walk order                            — encoder B
   *    4. ALL the rim pyramids, from the scene as of (3)       — the first read ends B, rest free
   *    5. ALL the glass rim overlays, in walk order                                  — encoder C
   *
   *  Same forty builds (same regions, sigma, depth, `k`, same DOWN/UP passes), same draws, same
   *  draws per tick. The ledger counts an END, and the frame's last encoder ends at the present,
   *  which `NoteFrameEndDrain` deliberately does not count — so three encoders read as
   *  `SceneSwitches` **2**, not 3.
   *
   *  THE PIXEL CHANGE, STATED. Today fill N's pyramid is built from the scene AFTER fills 0..N-1
   *  were drawn, so its refraction taps (fill margin 64.75 px at dpr 2, against a 40 px gutter)
   *  reach ~25 px into an earlier neighbour's box and see that neighbour's GLASS. Phased, every
   *  fill pyramid sees the bed only. Rims change in the same direction: today rim N sees fills
   *  0..N, phased it sees fills 0..19 — a superset, and on a grid whose cards do not overlap, a
   *  superset of nothing. So the difference is confined to the sample-margin overlap between
   *  adjacent surfaces. `pixels=DIFFERENT`, not WRONG: it is a legitimate composition and whether
   *  it is acceptable is Jack's call, with pictures. Under `?blur-src-clear` / `-static` every
   *  build reads the same stand-in and the difference vanishes, which makes that pairing the
   *  cleanest H5 cell of all — a pure count test whose two-arm diff must read exactly 0. */
  private _blurPhased: boolean = false;
  /** Which pass of the phased walk is running. 0 is every unflagged frame, and every predicate
   *  below answers the walk's own answer at 0, so an unflagged frame takes the branches it always
   *  did. 1 = the bed; 2 = the fills and their children; 3 = the glass rim overlays. */
  private _phasedPass: 0 | 1 | 2 | 3 = 0;
  /** Pass 1 has reached the first surface that builds a pyramid, and paints nothing further. */
  private _phasedStop: boolean = false;
  /** Pass 2 has reached that same surface, and paints from there on. The two flags flip at the
   *  SAME node in the same walk order, which is what makes passes 1 and 2 a PARTITION of the walk
   *  rather than two overlapping subsets: no node paints twice and none is dropped, so z-order is
   *  the walk's exactly — the glass rim overlays, which move to pass 3, are the one exception and
   *  the one the flag is about. */
  private _phasedStarted: boolean = false;
  /** The adaptive-shadow probe, measured in phase 2 beside its own fill build rather than in the
   *  walk. It has to move: in pass 3 the scene target is bound and a draw has landed since the
   *  last end, so the probe's `shadow-state` bind would END the scene encoder once per card and
   *  take the count from 2 back to 21. Beside the build it rides the end the build already paid,
   *  exactly as it does at baseline. It is also PIXEL-NEUTRAL on `glass-grid`: the probe samples
   *  strictly inside the surface's OWN box (its taps are `u_Rect.xy + cell * u_Rect.zw`), nothing
   *  else has painted there in either arm, so it reads the same bed. On a page whose surfaces
   *  overlap it changes by the same rule the fill does. */
  private _phasedShadow = new Map<Jiv, ShadowBackdrop>();
  /** What a build phase built, in build order, so the probe pass can run over it without a third
   *  walk. A rim plan carries `AdaptiveShadow: false`, so the probe pass skips rims without
   *  asking. */
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

  // -- `?pyramid-atlas` -- THE DEFAULT COMPOSITION, AND THE ATLAS THAT PAYS FOR IT -------------
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
   *  the engine this lane inherited, and it is the "before" every gate reads against. */
  private _pyramidAtlas: boolean = true;
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
  private _counts = { Panels: 0, Glass: 0, Text: 0, Image: 0, PBlur: 0, SharedBuilds: 0, CacheCap: 0, CacheComp: 0, SceneReads: 0, SceneRestarts: 0, SceneSwitches: 0, SceneEndsByKey: {} as Record<string, number>, CardComposites: 0, CardFallbacks: 0, TicksRendered: 0, TicksSkipped: 0, TicksForced: 0 };
  private _cacheDiag = { reached: 0, effH: 0, teleport: 0, opacity: 0, rot: 0, xform: 0, visual: 0, persp: 0, samples: 0, ok: 0 };
  private _countsRolling = { Panels: 0, Glass: 0, Text: 0, Image: 0, PBlur: 0, SceneReads: 0, SceneRestarts: 0, SceneSwitches: 0, CardComposites: 0, CardFallbacks: 0 };
  /** `?scene-restarts=N` / `?small-restarts=N` - the renderer, already narrowed, or null when
   *  neither flag armed. The two insertion points sit inside the pyramid-build branch of the
   *  hottest walk in the engine, so an unarmed frame pays one null check per build and not an
   *  `instanceof`. Set by `_initDebugFromUrl` only after both flags have passed their gates, which
   *  is why a REFUSED flag leaves it null and the walk untouched. */
  private _restartRenderer: WebGL2Renderer | null = null;
  /** `?tick-pace` — the gate between a tick that wants to render and the render. Always present; in
   *  `null` mode (no flag) `Decide` is one comparison and every tick renders, which is what keeps
   *  the RENDERED/SKIPPED columns readable on BOTH arms of a comparison. See `Core/Tick.Pace.ts`. */
  private _tickPace = new TickPace(null);
  /** The fence the gate polls, already narrowed, or null in every mode that does not poll one. */
  private _paceGate: PaceGate | null = null;
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
  // 1. The shared path pins u_BaseFrostLod to a CONSTANT 2, and the shader's
  //    frost gate added by the same commit that turned this off reads
  //    frostReq = clamp((frostLod - u_BaseFrostLod) * 4, 0, 1). The per-surface
  //    path builds at the panel's own sigma, so frostLod == u_BaseFrostLod and
  //    frostReq is identically 0 — no rim boost, no caustic-hiding refraction
  //    LOD, on any surface. Under shared, a 4pt-frost panel at DPR 2 gets
  //    frostReq 1 and a rim lodBoost around 1.7 on top. Same shader, a rim
  //    roughly 3x blurrier. The shared path has NEVER run against a shader that
  //    contains frostReq. hasBackdropFilter's `frostLod > u_BaseFrostLod` test
  //    inverts the same way: a flat backdrop-filter panel under 2pt of frost at
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
  private _sharedPyramid: GpuTextureHandle | null = null;
  private _sharedPyramidValid: boolean = false;
  /** Footprints (device px, flat [x0,y0,x1,y1,…]) drawn into the scene FBO since
   *  the shared pyramid was last built. A glass surface reuses the pyramid iff
   *  its sample rect intersects NONE of these (else it'd be missing fresh content
   *  in its backdrop). A single union AABB was too coarse — once surfaces spread
   *  across the canvas it covered everything and forced a full-canvas rebuild per
   *  surface (slower than the old scissored per-surface blur). */
  private _sceneDirtyRects: number[] = [];
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
    void this._listenForSpecularTilt;

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
    this.Wake();
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
  private _layerCache = new Map<Jiv, { Fbo: Framebuffer; Valid: boolean; DX: number; DY: number; DW: number; DH: number }>();
  /** Per-render memo of "subtree samples the live scene → uncacheable". Cleared
   *  at the top of every _render; real structural/material changes happen under
   *  !_uiStatic (which drops the whole cache), so it can't go stale mid-static. */
  private _subtreeDynamicMemo = new Map<Jiv, boolean>();
  /** True when no UI animation/relayout is pending, so the static caches are
   *  safe to build + reuse. The everplaying field keeps the loop alive via
   *  _needsRender (NOT IsRunning), so this stays true in steady state. */
  private _uiStatic = false;
  /** Guards the cache hook from re-entering while capturing a subtree. */
  private _capturing = false;

  /** True if `node`'s subtree contains anything that must re-render every frame
   *  because it samples the live (everplaying) scene: the 3D field (Janvas), a
   *  glass or progressive-blur surface, or a backdrop/border filter. Memoized. */
  private _subtreeSamplesLiveScene = (node: Jiv): boolean => {
    const memo = this._subtreeDynamicMemo.get(node);
    if (memo !== undefined) return memo;
    const s = node.RenderStyle;
    let dyn = node instanceof Janvas
      || _isGlass(s.Material) || s.Material === 'ProgressiveBlur'
      || _hasBackdropFilter(node)
      || Math.abs(s.BorderBrightness - 1) > 0.001 || Math.abs(s.BorderSaturation - 1) > 0.001
      || Math.abs(s.BorderContrast - 1) > 0.001 || s.BorderBackdropBlur > 0.001;
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
    if (park) { this._parked = true; return; }
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
      + ` trials=${c.Trials}/${c.TrialsFailed}failed vsync=${c.VsyncMs}`
      + ` derived=${c.VsyncDerived} lskip=${c.LockSkipped} fskip=${c.FenceSkipped}`
      // The three diagnostics, and NOTHING decides on them. `solo` is arm-to-signal with the GPU
      // idle - what the old estimator believed the period was; `satgap` is the observed
      // completion-to-completion period; `render` is the CPU's own issuing half. `solo` well above
      // `satgap` with `render` below both is present coupling; `render` at or above `solo` is the
      // CPU term that used to win a `max()`.
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
    if (this._pendingResize !== null) this._applySize();

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
    this._animationManager.StepFrame(dt);

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
    if (hud) {
      this._counts.Panels = 0;
      this._counts.Glass = 0;
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
    if (renderActive) {
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
      const tRender = ff || wantsCost ? performance.now() : 0;
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
        this._counts.CardComposites = this._renderer.CardComposites;
        this._counts.CardFallbacks = this._renderer.CardFallbacks;
      }
      if (ff && this._ffPresented) {
        // `_render` sets the latch at the present, beside the first-frame hook — `_resize` renders
        // inline as well, so the tick is not the only way pixels can arrive. This mark lands just
        // after that present and carries what the walk actually drew.
        const c = this._counts;
        const glyphs = this._textCache.RasterCount;
        JTrace(`jaui:render:end ${JMs(performance.now() - tRender)}ms`
          + ` panels=${c.Panels} glass=${c.Glass} text=${c.Text} images=${c.Image} pblur=${c.PBlur}`
          + ` sceneReads=${c.SceneReads} sceneRestarts=${c.SceneRestarts} sceneSwitches=${c.SceneSwitches}`
          + ` endsByKey=${_endsByKey(c.SceneEndsByKey)}`
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

    // `?tick-pace`'s ledger on the plain console, once a second, ONLY when the flag is armed.
    // Deliberately not folded into the `[Jaui]` line below it: that line needs `?wkr-jaui-prof`,
    // which also arms the per-pass GPU timers and makes every other frame a split frame — perturbing
    // the exact quantity this flag was built to measure. The worker's console is captured by the
    // perf harness (`instrument.mjs` wraps `console.*`; the page's CDP Log domain carries the same
    // lines), so this puts renders-per-window in the report with no harness change and no split
    // frame. Six lines in a 6 s window, each different, well inside the harness's 60-line cap.
    if (this._tickPace.Mode !== null) this._paceCensus(time);

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
            ` | shadowSnap=${this._shadowSnapped} armed=${this._shadowSnapArmed ? 1 : 0}`
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
      r.PanelDrawBatch(flushW, flushH, null, 0, this._specTiltX, this._specTiltY);
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

      // ── BorderLayer overlay ──
      // When this node's border was SUPPRESSED on its fused panel (BorderLayer
      // non-zero + a visible border), draw it here as a standalone stroke
      // interleaved among the children at the node's BorderLayer position: it
      // paints AFTER every child whose Layer is strictly below BorderLayer and
      // BEFORE the rest, so negative BorderLayer lands behind content and a
      // value past every child's Layer lands on top. Painted in the node's OWN
      // transform/clip (`eff`, `stack`) — the border belongs to the node, not
      // the child offset frame. Zero work for the default (no suppressed border).
      //
      // UNCONDITIONAL, deliberately. A previous lane made this a per-frame predicate
      // ("nothing a descendant paints touches the annulus, so let the fill pass draw the
      // rim"). It was rejected, and the reason belongs here rather than in a commit
      // message: the overlay rim and a fused rim are DIFFERENT PICTURES. The overlay's
      // border zone gathers a pyramid built AFTER this surface's own fill reached the
      // scene FBO, so it re-applies the body's grade and the body's Tint to the card's
      // own face; a fused rim gathers the raw backdrop and is graded once, which is why
      // it comes out 1.6-1.9x brighter (Jiv.Panel.frag, `borderBackdrop`). Choosing
      // between those with a cheap predicate chooses a different picture and calls it
      // the same one. The rim always gathers the true scene beneath it.
      const borderSuppressed = this._rimEmits(node, eff, stack, effH, ownPanelCulled);
      const borderLayer = node.RenderStyle.BorderLayer;
      let borderEmitted = !borderSuppressed;
      const emitBorderOverlay = (): void => {
        if (borderEmitted) return;
        const overlayGlass = _isGlass(node.RenderStyle.Material);
        // `?blur-phased`: a GLASS rim builds a pyramid and moves to pass 3 with every other rim in
        // the frame; a FLAT one builds nothing and stays in the pass its node painted in. Asked
        // BEFORE the flushes and the buffer encodes, so a refused emit issues no GL and touches no
        // buffer -- and `borderEmitted` stays false, so the pass that DOES own this overlay still
        // finds it pending at its BorderLayer slot.
        if (!this._phasedEmitsRim(overlayGlass)) return;
        borderEmitted = true;
        flushPanels();
        flushText();
        const ownClip = this._clipBuffer.Encode(stack, this._dpr);
        const ownXform = effH !== null ? this._xformBuffer.Add(effH, this._dpr) : -1;
        r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);

        if (overlayGlass) {
          // ── Glass border overlay ──
          // Re-emit the node's FULL glass rim ON TOP of its children. We can't
          // reuse the flat 'BorderOnly' stroke (a faint glass rim is invisible
          // as a solid color), so snapshot the scene exactly as a standalone
          // glass panel does (SnapshotScreen + ComputeBlur + mipmap, then
          // RebindSceneTarget), and draw a glass instance with the BORDER-ONLY
          // flag: the shader skips fill/shadow but still runs the glass border
          // zone, so the rim samples the REAL backdrop (the children at the
          // edge) with its BorderFilter grading. Mirror of the glass panel
          // draw at ~Jaui.ts:1466-1489 — self-contained at the overlay point.
          // ── What a BORDER-ONLY pass can actually reach ──
          // This margin used to be the glass FILL path's, copied whole: frost + the
          // refraction footprint (|Thickness x Refraction|, plus the Fillet bulge) +
          // chromatic aberration. None of those three exist here. A border-only fragment
          // makes exactly ONE backdrop tap — the border zone's `bUv`, which offsets
          // INWARD along the normal and is scaled by `solidness`, so it never leaves the
          // panel — because Jiv.Panel.frag now skips the fill's refracted and CA taps on
          // `borderOnly` (they only fed a fill this pass throws away). So the reach is the
          // frost blur's own spatial spread plus a pixel pad. On a JwiftGlass card at dpr 2
          // that is 24 px instead of 65, and the blur + snapshot shrink with it.
          //
          // Same three economies as the glass FILL path: the pyramid is built at the size of
          // the region (so its attachments are the card's, not the canvas's, and the handle
          // carries the screen-UV map the shader needs), the raw-scene snapshot is only read
          // where the panel authored no frost (sampleBackdrop's u_Scene fallback), and the mip
          // chain is only built as deep as this rim can sample — `BorderFilter: Blur(n)` is the
          // one thing that takes a border-only pass off LOD 0. All of it is resolved by
          // `_glassRimBlurPlan`, which `?blur-first`'s pre-pass calls too.
          const plan = this._glassRimBlurPlan(node, eff, effH, w, h);
          const region = plan.Region;
          const lastBaseFrostLod = plan.BaseFrostLod;
          const sceneSnap = plan.InstFrostLod < SCENE_TAP_FROST_LOD ? r.SnapshotScreen(region) : null;
          // A snapshot is a scene READ, so it stays where the walk puts it -- which under
          // `?blur-phased` means it is taken from a DIFFERENT scene state than this rim's own
          // pyramid, and it ends the scene encoder where the baseline's build had already ended
          // it. Counted rather than moved or refused: `glass-grid` and `idle` never take one
          // (every glass class there authors frost), and an arm where this is non-zero is not
          // comparable and should be discarded.
          if (sceneSnap !== null && this._phasedWalk) this._phasedStrays.Snaps++;
          // `?blur-first`: this surface's rim pyramid was built before the bed's first draw, so
          // the build is a lookup. Nothing else about the pass moves — the snapshot above still
          // runs where it ran, and the draw below is the baseline draw. A MISS builds here, which
          // is how a pre-pass that failed to reach this node reports itself instead of hiding.
          const preRim = this._blurFirst || this._phasedWalk ? this._blurFirstRim.get(node) : undefined;
          let lastBackdrop: GpuTextureHandle | null;
          if (preRim !== undefined) {
            lastBackdrop = preRim;
            this._blurFirstStats.Used++;
          } else {
            if (this._blurFirst || this._phasedWalk) this._blurFirstStats.Missed++;
            lastBackdrop = r.ComputeBlur(r.SceneTexture, w, h, plan.Radius, undefined, region);
            r.GenerateBlurMipmap(plan.MaxLod);
            r.RebindSceneTarget();
            // `?scene-restarts` / `?small-restarts`: the RIM build's insertion point, taken HERE
            // and not after the draw below. The build has just bound and drawn into the blur FBOs,
            // so the scene's encoder has provably ended and nothing has been drawn into the scene
            // since -- which is the instant `?small-restarts` needs for its claim to add a trivial
            // encoder and NO scene restart. It stays on this line where the FILL build's moved
            // past the adaptive-shadow measure, because nothing READS the scene between here and
            // the rim draw: the scene arm's opening draw has nothing free to make expensive.
            if (this._restartRenderer !== null) this._restartRenderer.DiagRestartPoint();
          }

          this._panelBuffer.Begin();
          this._panelBuffer.Push(node, this._dpr, eff, ownClip.Offset, ownClip.Count, ownXform, 'GlassBorderOnly');
          r.EnableBlend();
          r.PanelBeginBatch();
          r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
          r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
          r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
          const glassBgPaint = this._computeBgPaint(node);
          r.PanelDrawBatch(w, h, lastBackdrop, lastBaseFrostLod, this._specTiltX, this._specTiltY, true, sceneSnap, glassBgPaint);
          this._counts.Glass++;
          this._panelBuffer.Begin();
        } else {
          this._panelBuffer.Begin();
          this._panelBuffer.Push(node, this._dpr, eff, ownClip.Offset, ownClip.Count, ownXform, 'BorderOnly');
          r.EnableBlend();
          r.PanelBeginBatch();
          r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
          r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
          r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
          r.PanelDrawBatch(w, h, null, 0, this._specTiltX, this._specTiltY, false, null);
          this._counts.Panels++;
          this._panelBuffer.Begin();
        }
      };

      for (const child of this._orderedChildren(node)) {
        // Drop the border in at its layer slot, just before the first child
        // that sits at or above BorderLayer (children are Layer-sorted asc).
        if (!borderEmitted && child.RenderStyle.Layer >= borderLayer) emitBorderOverlay();
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
      // BorderLayer sits above every child (or there were no children) — paint
      // the stroke on top, after all content.
      if (!borderEmitted) emitBorderOverlay();
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

      // Encode the current clip stack into the per-frame buffer so this Jiv's
      // panel/text instances reference it by (offset, count).
      const clipMeta = this._clipBuffer.Encode(stack, this._dpr);
      // Projective node? Append its homography to the shared table once and pass
      // the index to whatever this node paints (panel and/or text). -1 = 2D.
      const xformIndex = effH !== null ? this._xformBuffer.Add(effH, this._dpr) : -1;

      const material = node.RenderStyle.Material;
      // The card-composite bracket. Opened in the glass FILL branch below and closed after this
      // node's children have walked, because the rim overlay paints among them (`descendChildren`)
      // and has to land in the same target the fill did.
      let cardOpen = false;

      // BorderLayer: when this Jiv asks for its border to paint at a non-zero
      // position in its children's Layer space, suppress the border on the
      // fused panel here and re-emit it as a standalone BorderOnly instance
      // interleaved among the children (see descendChildren). Default
      // (BorderLayer 0, or no visible border) keeps the border fused — today's
      // paint order, zero cost. Nothing else suppresses it: the rim's gather is the
      // reason the second pass exists (see descendChildren), not just paint order.
      const ownBorderMode: 'Normal' | 'Suppress' =
        (node.RenderStyle.BorderLayer !== 0 && this._hasPaintedBorder(node)) ? 'Suppress' : 'Normal';

      // `?blur-phased`: does this node paint its OWN content in the pass that is running? Asked
      // exactly once per node and only under the flag, because the ANSWER is also what detects the
      // pass-1/pass-2 boundary -- see `_phasedPaints`. Its children are walked either way.
      const phasedPaints = this._phasedPass === 0 || this._phasedPaints(node);

      if (!phasedPaints) {
        // This node's panel, text and vector belong to another pass. Nothing here, deliberately:
        // the counters, the buffers and the ledger must see exactly one paint of this node per
        // frame, in exactly one of the three passes.
      } else if (material === 'ProgressiveBlur' && !this._diagNoPblur) {
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
        lastBackdrop = r.ComputeBlur(sceneSnap, w, h, 0, undefined, region);
        lastBaseFrostLod = 0;
        // Cap mip build at this pblur's max sampled LOD — the shader does
        // textureLod(u_Pyramid, uv, ramp²·maxLod), so it never reads past
        // maxLod. Building deeper levels is pure fragment-fill waste on
        // a software rasterizer.
        r.GenerateBlurMipmap(maxLod);
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
        if (!this._diagNoPblurDraw) r.DrawProgressiveBlur({
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
          Grading: {
            Brightness: node.RenderStyle.BackdropBrightness,
            Saturation: node.RenderStyle.BackdropSaturation,
            Contrast: node.RenderStyle.BackdropContrast,
          },
          ClipOffset: clipMeta.Offset,
          ClipCount: clipMeta.Count,
        });
        this._counts.PBlur++;

      } else if (((_isGlass(material) && node.RenderStyle.Refraction !== 0) || _hasBackdropFilter(node)) && material !== 'ProgressiveBlur' && !this._diagNoGlass) {
        // ── Glass FILL vs glass BORDER are decoupled ──
        // A glass slab (Thickness > 0 → Material LiquidGlass) only takes the glass FILL
        // pipeline (refraction + backdrop sampling) when it actually has a glass-fill
        // effect to show: a non-zero Refraction, or a backdrop frost/grade. A slab with
        // Refraction 0 and no backdrop has nothing to refract or frost, so its FILL renders
        // as a plain (solid) panel here — while its beveled, fresnel-lit glass BORDER still
        // renders via the BorderLayer overlay (gated on _isGlass(Material), see ~Jaui.ts:1075).
        // That's what lets ANY jiv carry a glass OUTLINE without its fill becoming glass.
        // Flush pending batches: same reason as pblur — backdrop-filter
        // panels (glass or flat) read the scene (indirectly via the blur
        // pyramid), so the scene must be current. Flat panels with
        // non-default BackdropBrightness/Saturation/Contrast/FrostBlur go
        // through this same path — the shader branches on materialType
        // to skip refraction/CA/bezel for them, but they still need the
        // pyramid bound to sample.
        flushPanels();
        flushText();
        // Glass samples only `u_Backdrop` (the blur pyramid), never the raw
        // scene — so there's no feedback loop and we can feed ComputeBlur
        // the scene FBO's texture directly, zero blits.
        //
        // Build the pyramid OVER just the panel's sample region (panel rect plus a generous
        // margin for refraction + rim + bezel), and AT that size: level 0 comes back
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
        //
        // Margin must cover the FULL reach of the glass shader's backdrop
        // sampling (Jiv.Panel.frag), or a displaced sample lands past the
        // blurred region and reads unblurred/stale scene — the "no blur on the
        // outer refraction" rim. The shader displaces by, at worst:
        //   edge refraction: Thickness·avgScale·d · Refraction   (hump ≤ 1)
        //   surface bulge:   Fillet · minHalf · 0.25·0.7 · Refraction  (domeProfile ≤ 0.7)
        //   chromatic aberr: ChromaticAberration · 3
        // plus the frost blur's own spatial spread. Compute the exact bound so
        // the blur is built everywhere the panel can sample — keeps the full
        // refraction look (no displacement clamp) while guaranteeing it reads
        // blurred pixels. The region is still canvas-clamped below, so a heavy
        // panel just falls back toward a full-canvas pyramid (correct, bounded) — and a
        // full-canvas region resolves to the identity map, i.e. exactly the old behaviour.
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
        // children, the rim overlay -- paints into a region-sized target seeded with the frame
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
        // `?scene-restarts` / `?small-restarts`: whether THIS surface built a fill pyramid on this
        // line rather than taking a pre-built one. The insertion point below needs to know, and
        // the build sits inside a branch whose locals do not survive it.
        let fillBuilt = false;
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
            // clobber it). Depth covers the heaviest frost expressed as a LOD
            // plus the shader's refraction-footprint boost (~5); `_maxFrostBlur`
            // is the largest BackdropFrostBlur in the tree, scanned pre-walk,
            // and BuildSharedBackdrop self-clamps to the pyramid's level count.
            const _tShared = performance.now();
            this._sharedPyramid = r.BuildSharedBackdrop(w, h, Math.log2(Math.max(1, this._maxFrostBlur * d)) + 5);
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
          sceneSnap = instFrostLod < SCENE_TAP_FROST_LOD ? r.SnapshotScreen(region) : null;
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
          if (preFill !== undefined) {
            lastBackdrop = preFill;
            this._blurFirstStats.Used++;
          } else {
            if (this._blurFirst || this._phasedWalk) this._blurFirstStats.Missed++;
            const _tBlur = performance.now();
            lastBackdrop = r.ComputeBlur(r.SceneTexture, w, h, plan.Radius, undefined, region);
            const _tMip = performance.now();
            this._opMs.Blur += _tMip - _tBlur;
            r.GenerateBlurMipmap(plan.MaxLod);
            this._opMs.Mip += performance.now() - _tMip;
            r.RebindSceneTarget();
            // `?scene-restarts` / `?small-restarts`: this build's insertion point is taken BELOW,
            // after the adaptive-shadow measure, and this flag is how it knows a build happened
            // here. See the call site for why it is not taken on this line.
            fillBuilt = true;
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
        if (preShadow !== undefined) {
          // `?blur-phased`: measured in phase 2, beside this surface's own build, where the probe's
          // `shadow-state` bind rides the end the build already paid. Here, in pass 3, the scene is
          // bound and a draw has landed since the last end, so probing would END the scene encoder
          // once per card -- the exact count the flag exists to remove. Same rect, same detail LOD,
          // same pyramid, same sharp tap; see `_phasedShadow` for why that is pixel-neutral here.
          shadowBackdrop = preShadow;
          this._adaptiveShadowsDrawn = true;
        } else if (_rsAdaptiveShadow && lastBackdrop) {
          const detailLod = Math.log2(Math.max(frostCssPx, SHADOW_DETAIL_MIN_PT) * d) - lastBaseFrostLod;
          const slot = r.MeasureShadowBackdrop(node, { x: px, y: py, w: pw, h: ph }, detailLod, lastBackdrop, _shadowScene, dt);
          if (slot >= 0) {
            shadowBackdrop = { Slot: slot, Adaptive: _rs.ShadowAdaptive };
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
        // The rim build's point stays on its own `RebindSceneTarget()`, because nothing reads the
        // scene between it and the rim draw.
        if (fillBuilt && this._restartRenderer !== null) this._restartRenderer.DiagRestartPoint();

        r.EnableBlend();
        this._panelBuffer.Begin();
        this._panelBuffer.Push(node, this._dpr, eff, clipMeta.Offset, clipMeta.Count, xformIndex, ownBorderMode);
        r.PanelBeginBatch();
        r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
        r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
        // Always use the MATERIAL_GLASS variant for any standalone panel
        // that needs the pyramid path. Material is *inferred* from Thickness
        // (Thickness > 0 → 'LiquidGlass', else 'None'), so during a press →
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
        const _tDraw = performance.now();
        if (!(this._diagNoGlassDraw && _isGlass(material))) {
          r.PanelDrawBatch(w, h, lastBackdrop, lastBaseFrostLod, this._specTiltX, this._specTiltY, _isGlass(material), sceneSnap, glassBgPaint, shadowBackdrop);
        }
        this._opMs.Draw += performance.now() - _tDraw;
        if (_isGlass(material)) this._counts.Glass++;
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
        if (!this._diagNoPanels) {
        const flatBgPaint = this._computeBgPaint(node);
        if (flatBgPaint !== undefined) {
          flushPanels();
          this._panelBuffer.Begin();
          this._panelBuffer.Push(node, this._dpr, eff, clipMeta.Offset, clipMeta.Count, xformIndex, ownBorderMode);
          r.EnableBlend();
          r.PanelBeginBatch();
          r.SetClipBuffer(this._clipBuffer.Data, this._clipBuffer.Floats);
        r.SetXformBuffer(this._xformBuffer.Data, this._xformBuffer.Floats);
          r.PanelAddInstance(this._panelBuffer.Data, 0, JIV_FLOATS_PER_INSTANCE);
          r.PanelDrawBatch(w, h, null, 0, this._specTiltX, this._specTiltY, false, null, flatBgPaint);
          this._counts.Panels++;
          if (flatBgPaint.Mode === 'Image') this._counts.Image++;
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
        this._emitTextFor(node, eff, clipMeta.Offset, clipMeta.Count, xformIndex);
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

      // Walk children in Layer order (ties break by tree order)
      descendChildren(node, eff, stack, scope, effH, childPersp);

      // Close the card composite. The pending batches drain FIRST: anything still buffered belongs
      // to this subtree and would otherwise be flushed into the scene by the next category
      // boundary, landing on top of the write-back instead of inside it.
      if (cardOpen) {
        flushPanels();
        flushText();
        (r2 as WebGL2Renderer).EndCardComposite();
      }
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
      //   pass 2        fills + children draw
      //   build rims    read 1 ENDS encoder B    -> reads 2..20 free
      //   rebind                                                                      -> encoder C
      //   pass 3        the glass rim overlays draw
      //   present       ends C, and `NoteFrameEndDrain` does not count it
      //
      // So `SceneSwitches` reads 2 with `EndsByKey { blur: 2 }`, against 40 and { blur: 40 } at
      // baseline, while `Reads` stays at 60 and the forty builds all still happen.
      this._blurFirstFill.clear();
      this._blurFirstRim.clear();
      this._blurFirstKeys.clear();
      this._phasedShadow.clear();
      this._phasedStrays.Snaps = 0;
      this._phasedStrays.Pblur = 0;
      const ast = this._atlasStats;
      ast.Atlases = 0; ast.Members = 0; ast.Solo = 0; ast.Refused = 0; ast.Bytes = 0; ast.Sizes = '';
      this._atlasSizes.clear();
      const pst = this._blurFirstStats;
      pst.Fill = 0; pst.Rim = 0; pst.Used = 0; pst.Missed = 0; pst.Dup = 0; pst.Coarse = 0;
      const phase = (pass: 1 | 2 | 3): void => {
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
      this._blurPhasedBuild('fill', w, h);
      this._phasedShadowProbes(dt);
      r.RebindSceneTarget();
      phase(2);
      this._blurPhasedBuild('rim', w, h);
      r.RebindSceneTarget();
      phase(3);
      this._phasedPass = 0;
    } else if (!this._diagNoUi) renderNode(this.Root, MAT_IDENTITY, EmptyClipStack, rootScope);
    // In-flight teleports with no layered ancestor paint last at root level.
    replayScope(rootScope);
    // Trailing flushes — catch anything deferred since the last category
    // boundary. Order: panels first (they were pushed earlier in tree
    // order than the trailing text, if any).
    flushPanels();
    flushText();

    // `?blur-first`'s gate, on the trace channel. Printed when the SHAPE changes rather than every
    // frame: a line per frame would drown the channel, and a line only on the first frame would
    // miss a walk that starts disagreeing with the pre-pass once something animates. `missed` is
    // the one that must read 0 — see `_blurFirstStats`.
    if (this._blurFirst) {
      const st = this._blurFirstStats;
      const line = `jaui:blur-first prebuilt=${st.Fill + st.Rim} fill=${st.Fill} rim=${st.Rim}`
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
      const line = `jaui:blur-phased built=${st.Fill + st.Rim} fill=${st.Fill} rim=${st.Rim}`
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
    if (this._pyramidAtlas && !this._diagNoUi) {
      const st = this._blurFirstStats;
      const a = this._atlasStats;
      const sw = this._renderer instanceof WebGL2Renderer ? this._renderer.SceneSwitches : -1;
      const line = `jaui:pyramid-atlas built=${st.Fill + st.Rim} fill=${st.Fill} rim=${st.Rim}`
        + ` used=${st.Used} missed=${st.Missed}`
        + ` atlases=${a.Atlases} members=${a.Members} solo=${a.Solo} refused=${a.Refused}`
        + ` bytes=${Math.round(a.Bytes / (1024 * 1024) * 10) / 10}MB sizes=${a.Sizes === '' ? 'none' : a.Sizes}`
        + ` shadows=${this._phasedShadow.size} snaps=${this._phasedStrays.Snaps}`
        + ` pblur=${this._phasedStrays.Pblur}`
        + ` switches=${sw} pixels=DIFFERENT`;
      if (line !== this._atlasLastLine) { this._atlasLastLine = line; JTrace(line); }
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
      // Cross-fade alpha. First sight of a Ready entry for this URL kicks
      // off a fresh fade window; subsequent frames ramp `alpha` toward 1
      // and request another frame if the fade hasn't settled. URL swap
      // (Card `[image]` change) resets the fade start so the new image
      // also fades in over the previous one's placeholder color.
      const now = performance.now();
      if (node.BgImageFadeUrl !== bg.Url) {
        node.BgImageFadeUrl = bg.Url;
        node.BgImageFadeStartMs = now;
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

  /** True when this node's rim STROKE — its box plus the reach the stroke has past it —
   *  lies wholly outside the clip stack, or outside the damage rect being repainted. The
   *  AABB culls in `renderNode` test the BOX and then skip the node's own panel; the
   *  stroke is wider than the box, so its overlay pass is only safe to drop once the
   *  wider shape is out too. */
  private _rimOutsidePaintedArea = (
    node: Jiv, eff: Mat2x3, stack: ClipStack, effH: Mat3x3 | null,
  ): boolean => {
    const s = node.RenderStyle;
    const scale = Math.max(matScaleX(eff), matScaleY(eff));
    const m = (s.BorderWidth * (1 + Math.max(s.BorderVariance, 0)) + s.BorderBlur) * scale;
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
    // The clip draws the panel's corner verbatim — the compensated radius, clamped to half the box. It
    // needs no saturation rule of its own: fullyRounded below flattens smoothness to 0 for genuinely
    // round shapes, and the superellipse at n = 2 is then an exact circle or stadium.
    const corner = (i: number): number => Math.min(radii[i] * avgScale, maxR);
    const rtl = corner(0);
    const rtr = corner(1);
    const rbr = corner(2);
    const rbl = corner(3);
    // A circle or pill clips at smoothness 0 (n = 2), else the default squircle bulges into the diagonals.
    // Keyed to the AUTHORED radius as the panel shader's saturation is: the compensated one passes half a
    // small box long before the author asked for a circle, and turned a 48pt rounded tile's art into a disc.
    const raw = node.RenderStyle.BorderRadiusRaw;
    const fullyRounded = Math.min(raw[0], raw[1], raw[2], raw[3]) * avgScale >= maxR;
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
      Smoothness: fullyRounded ? 0 : node.RenderStyle.BorderRadiusSmoothness,
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

  /** True when this node re-emits its border as a standalone overlay among its children — a
   *  non-zero BorderLayer on a node that actually paints a border and actually paints at all.
   *
   *  The second clause: the node's own panel was culled (off-screen, or outside the damage rect)
   *  and never drew, so its rim is not a rim floating over children, it is a pass that paints
   *  nothing. A glass one still cost a full SnapshotScreen + ComputeBlur + mipmap + draw. Drop it
   *  once even the stroke's reach past the box is out. */
  private _rimEmits = (
    node: Jiv, eff: Mat2x3, stack: ClipStack, effH: Mat3x3 | null, ownPanelCulled: boolean,
  ): boolean => {
    if (!(node.RenderStyle.BorderLayer !== 0 && this._hasPaintedBorder(node)
          && node.Visible && node.Width > 0 && node.Height > 0)) return false;
    return !(ownPanelCulled && this._rimOutsidePaintedArea(node, eff, stack, effH));
  };

  /** True when this node takes the glass FILL pipeline — the branch that builds a pyramid.
   *
   *  A glass slab (Thickness > 0 → Material LiquidGlass) only takes it when it actually has a
   *  glass-fill effect to show: a non-zero Refraction, or a backdrop frost/grade. A slab with
   *  Refraction 0 and no backdrop has nothing to refract or frost, so its FILL renders as a plain
   *  panel — while its beveled, fresnel-lit glass BORDER still renders via the BorderLayer
   *  overlay. That is what lets ANY jiv carry a glass OUTLINE without its fill becoming glass. */
  private _glassFillTakesPyramid = (node: Jiv): boolean => {
    const material = node.RenderStyle.Material;
    return ((_isGlass(material) && node.RenderStyle.Refraction !== 0) || _hasBackdropFilter(node))
      && material !== 'ProgressiveBlur' && !this._diagNoGlass;
  };

  /** The glass FILL pyramid's plan: the region it is built over, the sigma it is built at, and how
   *  deep a chain the surface can read.
   *
   *  The margin covers the FULL reach of the glass shader's backdrop sampling (Jiv.Panel.frag), or
   *  a displaced sample lands past the blurred region and reads unblurred/stale scene — the "no
   *  blur on the outer refraction" rim. The shader displaces by, at worst:
   *    edge refraction: Thickness·avgScale·d · Refraction   (hump ≤ 1)
   *    surface bulge:   Fillet · minHalf · 0.25·0.7 · Refraction  (domeProfile ≤ 0.7)
   *    chromatic aberr: ChromaticAberration · 3
   *  plus the frost blur's own spatial spread. The region is canvas-clamped, so a heavy panel just
   *  falls back toward a full-canvas pyramid (correct, bounded) — and a full-canvas region resolves
   *  to the identity map, i.e. exactly the old behaviour. */
  private _glassFillBlurPlan = (
    node: Jiv, eff: Mat2x3, effH: Mat3x3 | null, w: number, h: number,
  ): GlassBlurPlan => {
    const d = this._dpr;
    const rs = node.RenderStyle;
    const frostCssPx = Math.max(1, rs.BackdropFrostBlur);
    const gsx = matScaleX(eff), gsy = matScaleY(eff);
    const avgScale = (gsx + gsy) * 0.5;
    const minHalf = Math.min(node.Width * gsx, node.Height * gsy) * d * 0.5;
    const thicknessDev = rs.Thickness * avgScale * d;
    const bulgeMax = rs.Fillet * minHalf * 0.25 * 0.7;
    const refractMax = (thicknessDev + bulgeMax) * rs.Refraction;
    const caMax = rs.ChromaticAberration * 3.0;
    const margin = frostCssPx * d + refractMax + caMax + 8 * d;
    // The draw quad's own reach, from `Jiv.InstanceBuffer`'s expressions rather than from a
    // second reading of them: a bound computed off a different rule is a bound that can drift
    // away from the quad it is supposed to contain. `DiagNoShadow` zeroes the shadow there, so it
    // zeroes it here.
    const noShadow = JivInstanceBuffer.DiagNoShadow;
    const shadowReach = noShadow ? 0 : (rs.ShadowBlur * avgScale * d
      + Math.max(Math.abs(rs.ShadowOffsetX), Math.abs(rs.ShadowOffsetY)) * avgScale * d);
    const borderReach = (rs.BorderWidth + rs.BorderBlur) * avgScale * d;
    const tapReach = Math.max(shadowReach, borderReach, refractMax + caMax);
    const ab = this._nodeAabb(node, eff, effH);
    const px = ab.minX * d, py = ab.minY * d;
    const pw = (ab.maxX - ab.minX) * d, ph = (ab.maxY - ab.minY) * d;
    const adaptiveShadow = rs.ShadowAdaptive > 0 && rs.ShadowColor.A > 0.001
      && !JivInstanceBuffer.DiagNoShadow;
    const instFrostLod = _instanceFrostLod(rs.BackdropFrostBlur, d);
    const baseFrostLod = Math.log2(Math.max(1, frostCssPx * d));
    return {
      Region: {
        x: Math.max(0, Math.floor(px - margin)),
        y: Math.max(0, Math.floor(py - margin)),
        w: Math.min(w, Math.ceil(pw + margin * 2)),
        h: Math.min(h, Math.ceil(ph + margin * 2)),
      },
      Radius: frostCssPx * d,
      // How deep a chain this panel can actually read. It used to be a flat 5 — headroom for the
      // refraction-footprint LOD — but that boost is gated by `frostReq`, which is identically 0
      // whenever the pyramid is built at the panel's own frost sigma, which is what `Radius` above
      // does. So a frosted glass panel samples LOD 0 and nothing else, and the six DOWN passes, six
      // mip blits and the driver's own full-chain generateMipmap were building, at CANVAS size, a
      // pyramid no fragment ever opened. `_backdropMaxLod` is the shader's own formula; when a class
      // does ask for a deeper read (`BorderFilter: Blur(n)`, or any future non-zero frostReq) the
      // chain comes back on its own. The adaptive shadow reads the pyramid at its own detail LOD,
      // so it floors the depth.
      MaxLod: Math.max(
        _backdropMaxLod(instFrostLod, baseFrostLod, thicknessDev, rs.InnerBlur, rs.BorderBackdropBlur),
        adaptiveShadow ? Math.log2(Math.max(frostCssPx, SHADOW_DETAIL_MIN_PT) * d) - baseFrostLod : 0,
      ),
      BaseFrostLod: baseFrostLod,
      InstFrostLod: instFrostLod,
      Px: px, Py: py, Pw: pw, Ph: ph, Margin: margin, TapReach: tapReach,
      AdaptiveShadow: adaptiveShadow,
      FrostCssPx: frostCssPx,
    };
  };

  /** The glass RIM overlay's pyramid plan. Same shape as the fill's and a strictly smaller margin:
   *  a border-only fragment makes exactly ONE backdrop tap — the border zone's `bUv`, which offsets
   *  INWARD along the normal — so the reach is the frost blur's own spatial spread plus a pixel
   *  pad. `AdaptiveShadow` is always false here: a border-only pass draws no shadow. */
  private _glassRimBlurPlan = (
    node: Jiv, eff: Mat2x3, effH: Mat3x3 | null, w: number, h: number,
  ): GlassBlurPlan => {
    const d = this._dpr;
    const rs = node.RenderStyle;
    const frostCssPx = Math.max(1, rs.BackdropFrostBlur);
    const avgScale = (matScaleX(eff) + matScaleY(eff)) * 0.5;
    const thicknessDev = rs.Thickness * avgScale * d;
    const margin = frostCssPx * d + 8 * d;
    const ab = this._nodeAabb(node, eff, effH);
    const px = ab.minX * d, py = ab.minY * d;
    const pw = (ab.maxX - ab.minX) * d, ph = (ab.maxY - ab.minY) * d;
    const instFrostLod = _instanceFrostLod(rs.BackdropFrostBlur, d);
    const baseFrostLod = Math.log2(Math.max(1, frostCssPx * d));
    return {
      Region: {
        x: Math.max(0, Math.floor(px - margin)),
        y: Math.max(0, Math.floor(py - margin)),
        w: Math.min(w, Math.ceil(pw + margin * 2)),
        h: Math.min(h, Math.ceil(ph + margin * 2)),
      },
      Radius: frostCssPx * d,
      MaxLod: _backdropMaxLod(instFrostLod, baseFrostLod, thicknessDev, rs.InnerBlur, rs.BorderBackdropBlur),
      BaseFrostLod: baseFrostLod,
      InstFrostLod: instFrostLod,
      Px: px, Py: py, Pw: pw, Ph: ph, Margin: margin,
      // A border-only pass makes exactly ONE backdrop tap and it offsets INWARD along the normal
      // (`Jiv.Panel.frag`'s `bUv`, scaled by `solidness`), and the fill's refracted and CA taps
      // are skipped wholesale on `borderOnly`. So a rim never reads outside its own box, let
      // alone outside its region, and it is admissible to an atlas unconditionally.
      TapReach: 0,
      AdaptiveShadow: false,
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

  /** A node the phased walk has to hold back: one that BUILDS A PYRAMID at either site. Pass 1
   *  stops at the first of them and pass 2 starts there, so every pyramid in the frame is built in
   *  one of the two build phases and the bed is the only thing under the first of them.
   *
   *  It asks the style, not the cull: `_rimEmits`'s extra clause can only make this FALSE, and
   *  stopping pass 1 earlier than strictly necessary is safe (pass 2 picks the node up, in order)
   *  while stopping later is not. A ProgressiveBlur surface is not one of these -- its pyramid is
   *  seeded from a snapshot at its own point in the walk, so it is neither pre-built nor moved, and
   *  `_phasedStrays.Pblur` counts it. */
  private _phasedHoldsBack = (node: Jiv): boolean => {
    if (node.Width <= 0 || node.Height <= 0 || !node.Visible) return false;
    if (node.RenderStyle.Material === 'ProgressiveBlur' && !this._diagNoPblur) return false;
    if (this._glassFillTakesPyramid(node)) return true;
    return node.RenderStyle.BorderLayer !== 0 && this._hasPaintedBorder(node)
      && _isGlass(node.RenderStyle.Material);
  };

  /** Does this node paint its OWN panel, text and vector in the pass that is running? Called once
   *  per node, at the point `renderNode` has finished culling and is about to choose a material
   *  branch -- which is also where the pass-1/pass-2 boundary is DETECTED, because the boundary IS
   *  the first node that would build a pyramid.
   *
   *  Pass 3 paints no node's own content at all: it exists to carry the glass rim overlays, which
   *  are emitted from `descendChildren` and gated by `_phasedEmitsRim` instead. */
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
      case 3:
        return false;
      default:
        return true;
    }
  };

  /** Does a BorderLayer overlay emit in the pass that is running?
   *
   *  A GLASS rim builds a pyramid, so it moves to pass 3 with every other rim in the frame. A FLAT
   *  one is a solid stroke that builds nothing, so moving it would change z-order for no reading:
   *  it emits in whichever pass its node's own content was painted in, which is exactly what the
   *  live `_phasedStop` / `_phasedStarted` state says at the moment the overlay reaches its
   *  BorderLayer slot. That is why this reads the flags rather than taking the answer from the
   *  node: a container's flat rim whose BorderLayer sits ABOVE its first glass child belongs in
   *  pass 2, one that sits below belongs in pass 1, and the slot is where that is known. */
  private _phasedEmitsRim = (overlayGlass: boolean): boolean => {
    switch (this._phasedPass) {
      case 1: return !overlayGlass && !this._phasedStop;
      case 2: return !overlayGlass && this._phasedStarted;
      case 3: return overlayGlass;
      default: return true;
    }
  };

  /** One build phase: every pyramid at ONE of the two sites, from the scene as it stands, in the
   *  walk's own order. It reuses `?blur-first`'s pre-pass traversal wholesale -- same functions,
   *  same culls, same ordering, same two plan resolvers -- with `_prepassSites` choosing which of
   *  the two sites issues a build. A second copy of that traversal would be a second answer to
   *  "which surfaces build", and the whole claim of this flag is that the answer did not move.
   *
   *  No `RebindSceneTarget` here: the caller decides when the scene comes back, because a rebind
   *  between the builds and the probe pass would put a scene bind where the baseline has none. */
  private _blurPhasedBuild = (site: 'fill' | 'rim', w: number, h: number): void => {
    this._phasedBuilt.length = 0;
    this._prepassSites = site;
    // With the atlas on, the traversal RECORDS rather than builds: a slot layout cannot be
    // computed one member at a time, and issuing the builds as it walked would be the per-card
    // composition again. The traversal itself is byte for byte the one `?blur-phased` runs, which
    // is what keeps ONE answer to "which surfaces build" across both arms.
    if (this._pyramidAtlas) this._atlasCollect = [];
    const scope: TeleportScope = { Deferred: [], Stack: EmptyClipStack };
    this._blurFirstNode(this.Root, MAT_IDENTITY, EmptyClipStack, scope, null, null, w, h);
    this._blurFirstReplay(scope, w, h);
    this._prepassSites = 'both';
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
      if (!AtlasAdmitsMember(c.Plan, w, h)) { a.Refused++; solo.push(c); continue; }
      const cls = byRadius.get(c.Plan.Radius);
      if (cls === undefined) byRadius.set(c.Plan.Radius, [c]); else cls.push(c);
    }
    for (const [radius, cls] of byRadius) {
      const plan = cls.length < 2 ? null : PlanBackdropAtlas(
        cls.map((c) => ({ Region: c.Plan.Region, Paint: c.Plan.Region })), w, h, radius,
        { IgnoreSeparation: true, Limits: ATLAS_LIMITS_WIRED, MaxLod: 0 },
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
      this._phasedShadow.set(b.Node, { Slot: slot, Adaptive: b.Node.RenderStyle.ShadowAdaptive });
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

  /** Build every pyramid the coming walk would build, in the order it would build them. */
  private _blurFirstPrepass = (w: number, h: number): void => {
    this._blurFirstFill.clear();
    this._blurFirstRim.clear();
    this._blurFirstKeys.clear();
    const st = this._blurFirstStats;
    st.Fill = 0; st.Rim = 0; st.Used = 0; st.Missed = 0; st.Dup = 0; st.Coarse = 0;
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
      for (const d of items) this._blurFirstNode(d.N, d.M, scope.Stack, scope, d.MH, d.P, w, h);
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
      this._blurFirstDescend(node, eff, stack, scope, effH, childPersp, true, w, h);
      return;
    }
    if (this._damageCulls(node, eff, effH)) {
      if (node.ClipsChildren) return;
      this._blurFirstDescend(node, eff, stack, scope, effH, childPersp, true, w, h);
      return;
    }
    if (node.Width <= 0 || node.Height <= 0 || !node.Visible) {
      this._blurFirstDescend(node, eff, stack, scope, effH, childPersp, false, w, h);
      return;
    }
    // The pblur branch is tested FIRST in the walk and wins, so a ProgressiveBlur surface never
    // reaches the glass fill. Its own pyramid is NOT pre-built: it is seeded from a snapshot of
    // the scene-so-far, so moving it in front of the bed would change what it samples rather than
    // only when it is built. Those stay in the walk and the report says how many did.
    const isPblur = node.RenderStyle.Material === 'ProgressiveBlur' && !this._diagNoPblur;
    // Counted on the FILL phase only: `?blur-phased` runs this traversal twice a frame, once per
    // site, and a surface counted in both would report double the number of surfaces the flag
    // could not move.
    if (isPblur && this._phasedWalk && this._prepassSites === 'fill') this._phasedStrays.Pblur++;
    if (!isPblur && this._prepassSites !== 'rim' && this._glassFillTakesPyramid(node)
        && this._blurFirstBuild(this._blurFirstFill, node, this._glassFillBlurPlan(node, eff, effH, w, h), w, h)) {
      this._blurFirstStats.Fill++;
    }
    this._blurFirstDescend(node, eff, stack, scope, effH, childPersp, false, w, h);
  };

  private _blurFirstDescend = (
    node: Jiv, eff: Mat2x3, stack: ClipStack, scope: TeleportScope,
    effH: Mat3x3 | null, persp: PerspCtx | null, ownPanelCulled: boolean, w: number, h: number,
  ): void => {
    const boxClip = this._boxClip(node, eff);
    const childM = this._descendOffset(node, eff);
    let childMH = effH;
    if (effH !== null && node.Overflow === 'Scroll') {
      childMH = mat3Mul(effH, mat3FromAffine([1, 0, 0, 1, -node.ScrollX, -node.ScrollY]));
    }
    let rimPending = this._rimEmits(node, eff, stack, effH, ownPanelCulled);
    const borderLayer = node.RenderStyle.BorderLayer;
    const emitRim = (): void => {
      if (!rimPending) return;
      rimPending = false;
      // Only a GLASS rim builds a pyramid; a flat one is a solid stroke.
      if (!_isGlass(node.RenderStyle.Material)) return;
      if (this._prepassSites === 'fill') return;
      if (this._blurFirstBuild(this._blurFirstRim, node, this._glassRimBlurPlan(node, eff, effH, w, h), w, h)) {
        this._blurFirstStats.Rim++;
      }
    };
    for (const child of this._orderedChildren(node)) {
      if (rimPending && child.RenderStyle.Layer >= borderLayer) emitRim();
      const clip = this._childClip(node, stack, boxClip, child);
      const pin = child.ChildLayout.Position === 'Pinned' && node.Overflow === 'Scroll';
      const cM = pin ? eff : childM;
      const cMH = pin ? effH : childMH;
      if (child.TeleportSeq !== 0) {
        scope.Deferred.push({ N: child, M: cM, MH: cMH, P: persp });
        continue;
      }
      if (child.RenderStyle.Layer !== 0) {
        const childScope: TeleportScope = { Deferred: [], Stack: clip };
        this._blurFirstNode(child, cM, clip, childScope, cMH, persp, w, h);
        this._blurFirstReplay(childScope, w, h);
        continue;
      }
      this._blurFirstNode(child, cM, clip, scope, cMH, persp, w, h);
    }
    emitRim();
  };

  /** One pre-pass build: the walk's two calls, and the pool bookkeeping that says what the pool
   *  actually did with them. False when the build was refused, so the caller's count stays a count
   *  of pyramids the walk can actually collect. */
  private _blurFirstBuild = (
    into: Map<Jiv, GpuTextureHandle>, node: Jiv, plan: GlassBlurPlan, w: number, h: number,
  ): boolean => {
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

  /** Issue ONE per-surface build: the walk's two calls, and the pool bookkeeping. This is the
   *  path `?blur-first`, `?blur-phased` and every atlas REFUSAL take, and it is the engine as it
   *  ships -- which is why a refusal is safe rather than a degradation. */
  private _prepassIssue = (
    into: Map<Jiv, GpuTextureHandle>, node: Jiv, plan: GlassBlurPlan, w: number, h: number,
  ): boolean => {
    const r = this._renderer;
    const st = this._blurFirstStats;
    const t0 = performance.now();
    const handle = r.ComputeBlur(r.SceneTexture, w, h, plan.Radius, undefined, plan.Region);
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
    const k = BaseDownsampleFactor(plan.Radius, w, h, plan.Region);
    if (k > 1) st.Coarse++;
    const depth = plan.Radius > 0 ? PyramidDepth(plan.Radius / k, 0) : 0;
    const rect = ResolveRegionRect(plan.Region, w, h, k * (1 << depth));
    this._blurFirstKeys.add(`${rect.W}x${rect.H}`);
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
    this._renderer.EnableBlend();
    for (const fill of svg.Fills) {
      const c = this._resolveSvgColor(fill.ColorRaw);
      const a = c.A * fill.Opacity * nodeOp;
      if (a <= 0.001 || fill.VertCount === 0) continue;
      this._renderer.SvgFillDraw(fill.Verts, fill.VertCount, model0, model1, [c.R, c.G, c.B, a], w, h);
    }
    if (svg.Strokes.length > 0) {
      // viewBox→device scale (geometric mean of the affine's axis scales) → device-px half-width.
      const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
      for (const st of svg.Strokes) {
        const c = this._resolveSvgColor(st.ColorRaw);
        const a = c.A * st.Opacity * nodeOp;
        if (a <= 0.001 || st.SegmentCount === 0) continue;
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

  private _emitTextFor = (node: Jiv, m: Mat2x3, clipOffset: number, clipCount: number, xformIndex: number = -1): void => {
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
        cmd3.TintR = w.TintR.Value;
        cmd3.TintG = w.TintG.Value;
        cmd3.TintB = w.TintB.Value;
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
      cmd.TintR = w.TintR.Value;
      cmd.TintG = w.TintG.Value;
      cmd.TintB = w.TintB.Value;
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

  /** Pointer tracking → specular tilt. Simulates Apple's gyro-driven catchlight:
   *  as the user moves the cursor, the specular highlight slides across the
   *  rim. `SpecularTilt` is only applied to specular math (Blinn-Phong catchlight
   *  + rim-spec highlight) — not to ambient, edge light, or border directionality,
   *  which stay anchored to the stylesheet-set `LightAngle`. */
  // Retained for future mobile gyro wiring; see constructor note. The
  // `void` reference at the end of the constructor keeps TS happy without
  // a suppression comment until we actually wire it up.
  private _listenForSpecularTilt = (): void => {
    const updateFromEvent = (clientX: number, clientY: number): void => {
      const r = this._pageRect();
      // Map pointer to [-1, +1] relative to canvas center, then scale to a
      // modest tilt magnitude (Apple's gyro tilt rarely exceeds ~30°, which
      // in light-direction space is about 0.5 unit). Clamp to ±0.5.
      const tx = ((clientX - r.left) / Math.max(r.width, 1) - 0.5) * 2;
      const ty = ((clientY - r.top) / Math.max(r.height, 1) - 0.5) * 2;
      this._specTiltX = Math.max(-0.5, Math.min(0.5, tx * 0.5));
      // Y note: screen Y grows downward, but LightAngle's y convention has
      // "up" as negative in screen space (matches the instance buffer's
      // `lightY = -sin(rad)`). So mouse moving DOWN should shift the
      // specular origin DOWN in the light source, i.e. tilt.y positive.
      this._specTiltY = Math.max(-0.5, Math.min(0.5, ty * 0.5));
      this.RequestFrame();
    };

    this._on('pointermove', (e: PointerEvent) => {
      updateFromEvent(e.clientX, e.clientY);
    }, { passive: true });

    this._on('pointerleave', () => {
      this._specTiltX = 0;
      this._specTiltY = 0;
      this.RequestFrame();
    }, { passive: true });
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
    interface DragCtx { target: Jiv; lastX: number; lastY: number; }
    const drags = new Map<number, DragCtx>();

    this._on('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return; // reserve mouse-drag for future selection

      this._measureScrollContents(this.Root);
      const rect = this._pageRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const target = this._scrollManager.ResolveScrollTarget(cssX, cssY);
      if (!target) return;

      this._capturePointer(e.pointerId);
      this._scrollManager.DragStart(target);
      drags.set(e.pointerId, { target, lastX: e.clientX, lastY: e.clientY });
    });

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
        // Dragging pulls content the opposite direction of finger motion (finger
        // moves up → content scrolls down, same as native).
        const dx = -(sample.clientX - ctx.lastX);
        const dy = -(sample.clientY - ctx.lastY);
        this._scrollManager.DragMove(ctx.target, dx, dy, sample.timeStamp);
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
      this._scrollManager.DragCancel(ctx.target);
      drags.delete(e.pointerId);
    });

    const finish = (e: PointerEvent): void => {
      const ctx = drags.get(e.pointerId);
      if (!ctx) return;
      // The lift carries a position, and the finger really was travelling
      // between the last pointermove and here — typically most of a frame. Feed
      // it as the drag's final sample so that distance lands on the content AND
      // so the release window's last interval is measured rather than read as
      // the finger having stopped. Without it a flick is systematically slow by
      // the fraction of the window that gap occupies.
      const dx = -(e.clientX - ctx.lastX);
      const dy = -(e.clientY - ctx.lastY);
      if (dx !== 0 || dy !== 0) this._scrollManager.DragMove(ctx.target, dx, dy, e.timeStamp);
      this._scrollManager.DragEnd(ctx.target, e.timeStamp);
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
    // `?tick-pace` / `=lock:V` / `=observe` / `=fence` / `=fence:D` / `=N` - MEASUREMENT ONLY,
    // PIXEL-IDENTICAL BY CONSTRUCTION. The flag's meaning is the VSYNC LOCK: release a render only
    // on a whole number of vsyncs, N = ceil(period / vsync) - adaptive AND even, where the fence
    // gate was adaptive and trimodal and the ratio clamp even and fixed.
    //
    // `period` is now an OBSERVED completion-to-completion gap taken in a window the lock makes
    // saturated on purpose (the N=1 warm-up, a speculative trial, the frames around a fence
    // refusal), never a cost model: the M4 chose 50 ms where 33.3 was available because
    // max(CPU EMA, solo fence EMA) read 37.5 against a true 29.41. The whole argument, what each
    // observation window is, what a trial costs and what a skipped tick does is in
    // `Core/Tick.Pace.ts`; what belongs here is the gate and its refusals.
    //
    // NOT PARSED IN `Worker.Boot` the way `?no-depth` is, and that is a reading rather than an
    // oversight: `?no-depth` had to land ahead of `Init` because `Init` BUILDS the scene FBO it
    // configures. Nothing this flag touches is built by `Init` - the fence is placed per frame in
    // `EndFrame` and the gate is consulted per tick, both of which happen long after the Canvas (and
    // so this parse) exists. `_platform.GetUrlSearch()` is the PAGE's search in worker mode, handed
    // over on the init message, so the flag and its mark arrive on both this path and main-thread
    // mode. The renderer says separately whether the driver actually gave it a fence.
    if (params.has('tick-pace')) {
      const parsed = ParseTickPace(params.get('tick-pace'));
      const r = this._renderer;
      const why =
        'Why' in parsed ? parsed.Why
        // The lock and the fence gate both poll `PaceInFlight`, which is WebGL2's `clientWaitSync`
        // - the lock reads the GPU's cost off the same fences it guards itself with. The ratio
        // control needs no GL at all, so it is allowed on any backend.
        : parsed.Mode.Kind !== 'ratio' && !(r instanceof WebGL2Renderer) ? 'fence-mode-needs-webgl2-clientwaitsync'
        : null;
      if (why !== null) {
        JTrace(`jaui:tick-pace armed=false reason=${why}`);
      } else if (!('Why' in parsed)) {
        this._tickPace = new TickPace(parsed.Mode);
        if (parsed.Mode.Kind !== 'ratio') {
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
        // `source=` is the field this lane added and the one to read first: a cadence chosen from
        // `warmup`/`trial`/`stepup` was chosen from an OBSERVED completion period, and one chosen
        // from `unsaturated` was chosen by a proof that N=1 is enough. Neither is a cost model, and
        // the 50-vs-33.3 cell exists because the old one was.
        this._tickPace.OnLockChange = (n, periodMs, vsyncMs, source) => JTrace(
          `jaui:tick-pace lock N=${n} period=${ms1(periodMs)} source=${source} vsync=${ms1(vsyncMs)}`);
        // A trial deliberately makes frames worse for a handful of renders, so it never happens
        // silently: a report that sees judder in a window can tell a trial from a regression.
        this._tickPace.OnTrial = (n, outcome) => JTrace(`jaui:tick-pace trial N=${n} ${outcome}`);
        JTrace(`jaui:tick-pace armed=${TickPaceText(parsed.Mode)}`);
        // The cumulative ledger, out to a reader that must not reach into the engine - the same
        // channel `__jauiPassProfile` and `__jauiSceneLedger` use, and for the same reason. The
        // effect field this lane exists to publish is RENDERS per presented frame, and the harness's
        // `ticks` column counts rAF CALLBACKS (`instrument.mjs` wraps `self.requestAnimationFrame`
        // and increments on every one), not renders - so under this flag `ticks` and renders part
        // company and the ratio is only readable if the engine says how many of its ticks drew.
        // One evaluate at each end of the window, subtract, divide by the presented frame count.
        const g = globalThis as unknown as { __jauiTickPace?: () => PaceCensus };
        g.__jauiTickPace = () => this._tickPace.Census();
      }
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
    // `?pyramid-atlas` -- THE DEFAULT. Parsed before `?blur-phased` so that flag can refuse a
    // combined arm by name: both run the phased composition, and an arm running the atlas AND the
    // measurement flag would be reading the atlas under the measurement flag's pool.
    //
    // The VALUE is `off` and nothing else. A flag whose value was ignored would let
    // `?pyramid-atlas=0`, `=false`, `=no` all arm the default while reading as if they had turned
    // it off, which is the failure mode a measurement instrument exists to avoid.
    if (params.has('pyramid-atlas')) {
      const raw = (params.get('pyramid-atlas') ?? '').trim();
      if (raw !== '' && raw !== 'off' && raw !== 'on') {
        throw new Error(`[Jaui] ?pyramid-atlas takes 'on' or 'off', got '${raw}'`);
      }
      if (raw === 'off') this._pyramidAtlas = false;
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
        // chains would otherwise be one. `MaxChains` is 8 for the two atlases plus the solo builds
        // a refusal can put beside them.
        gl2.DiagChainLimits = { MaxChains: 8, BudgetBytes: ATLAS_BUDGET_BYTES };
      }
    }
    // THE MARK, on both arms, from the line that decides. It does not live in the renderer's
    // `Init` beside the other measurement marks for the reason lane restarts2 wrote down: in
    // worker mode `Init` is awaited BEFORE the URL is parsed at all, so a mark taken there would
    // print `off` on every arm however the URL read. A reading taken without this line is a
    // reading of a build that predates the lever.
    JTrace(`jaui:pyramid-atlas armed=${this._pyramidAtlas ? 'on' : 'off'}`
      + ` budget=${Math.round(ATLAS_BUDGET_BYTES / (1024 * 1024))}MB`
      + (this._pyramidAtlas ? ' pixels=DIFFERENT' : ''));
    this._phasedWalk = this._pyramidAtlas;
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
// Renderers are exported directly — callers pick the one they want and
// hand it to `new Canvas(el, renderer)`. No auto-pick factory: the choice
// between WebGL2 (sync) and WebGPU (async) is the caller's to make.
export { WebGL2Renderer } from './WebGL2.Renderer';
export { WebGPURenderer } from './WebGPU.Renderer';

// Jiv
export type { JivStyle, CornerShape, BlendMode, MaterialType, ProgressiveBlurDirection, BackgroundValue, GradientStop } from '../Jiv/Jiv.Types';
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
