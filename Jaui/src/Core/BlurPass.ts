import { ShaderBatch, type ShaderProgram } from './Shader.Compiler';
import { QuadGeometry } from './Geometry.Quad';
import { Framebuffer } from './Framebuffer';
import { BACKDROP_REGION_FULL, type BackdropRegion } from './Renderer';
import type { PassTimers } from './Pass.Timers';
import { JTrace } from '../Diagnostics/Jaui.Trace';

/**
 * Dual Filter blur (Marius Bjørge, ARM, "Bandwidth-Efficient Rendering",
 * SIGGRAPH 2015 / Khronos Munich 2015). The de-facto standard for wide,
 * smooth, fast Gaussian-equivalent blur in shipping AAA engines.
 *
 * Shape of the algorithm:
 *   Source FBO ──► [Down × N] ──► [Up × N] ──► Output FBO (= region size)
 * Each Down halves the resolution with a 5-tap kernel that approximates a
 * box average. Each Up doubles the resolution with an 8-tap kernel that
 * approximates a small Gaussian as it interpolates back up. Repeating the
 * pyramid N times widens the effective sigma exponentially while keeping
 * sample-spacing-to-sigma ratio constant — so there's none of the "oily
 * banding" you get when you just crank the radius on a single 5-tap pass.
 *
 *   N = 1: σ ≈ 5 px       (subtle frost)
 *   N = 2: σ ≈ 12 px      (regular liquid glass)
 *   N = 3: σ ≈ 28 px      (deep frost)
 *   N = 4: σ ≈ 60 px      (heavy backdrop)
 *
 * Reference: https://community.arm.com/cfs-file/__key/communityserver-blogs-components-weblogfiles/00-00-00-20-66/siggraph2015_2D00_mmg_2D00_marius_2D00_notes.pdf
 */

// Every pass draws the same unit quad over its WHOLE destination. `u_SrcRect` says which
// part of the SOURCE that destination stands for: (x, y, w, h) in source UV, GL's
// bottom-origin y. (0, 0, 1, 1) is the whole source — and is exact, because `0.0 + a * 1.0`
// is `a` bit-for-bit in IEEE754, so a full-source pass interpolates the identical varying it
// always did. The mapping is done HERE and interpolated rather than recomputed per fragment
// so its float rounding has the same character as the varying it replaces.
const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_Position;
uniform vec4 u_SrcRect;
out vec2 v_Uv;
void main() {
    v_Uv = u_SrcRect.xy + a_Position * u_SrcRect.zw;
    gl_Position = vec4(a_Position * 2.0 - 1.0, 0.0, 1.0);
}
`;

// EVERY PASS IN THIS FILE READS ITS SOURCE'S BASE LEVEL, and says so with `textureLod(..., 0.0)`
// instead of leaving it to the derivative and to whatever filter state the source happens to be in.
//
// This is not a stylistic preference, it is the progressive blur's black scrim. `texture()` takes
// its LOD from the derivative of the coordinate, and every pass here draws into a destination HALF
// its source's size -- so lambda is exactly 1.0 and the sampler reads the source's MIP 1. That is
// harmless while a source is not mip-complete, which every level FBO is not... except `_levels[0]`
// inside `GenerateOutputMipmap`, where `EnsureMipLevels` has just allocated mips 1..N as empty
// storage and flipped MIN_FILTER to LINEAR_MIPMAP_LINEAR before the DOWN chain reads that same
// texture. Level 1 was therefore built out of the output's own uninitialised mip 1 (zero-filled on
// ANGLE/D3D11), blitted back into it, and read again next frame: a black fixed point, and every
// level above it a downsample of black. Only the progressive blur sampled it -- a glass panel's
// pyramid is built AT its own frost sigma, so `_backdropMaxLod` returns 0 and it takes
// `DisableMipmap()` instead -- which is exactly the shape of the report: the glass is fine and the
// pblur is black past the clear edge of its ramp.
//
// An explicit LOD 0 is PIXEL-IDENTICAL at every call site that was already correct: those sources
// are not mip-filtered, so `texture()` was already resolving to a bilinear tap on level 0, and
// lambda <= 0 selects the magnification filter (LINEAR) on level 0 either way (GL ES 3.0, 3.8.10).
// The fix belongs here rather than in the ordering of `GenerateOutputMipmap`, because the level a
// pyramid pass reads must be a property of the pass, not of its source's current sampler state.

// Downsample: 5-tap (center + 4 corners at half-pixel offsets, all weighted)
// Reads the SOURCE half-pixel; halfpixel = (0.5/srcW, 0.5/srcH).
// This is run when rendering into a destination half the source's size.
const DOWN_FRAG = `#version 300 es
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
uniform vec2 u_HalfPixel;     // half-texel size of the SOURCE
uniform float u_Offset;       // tap distance scale (typically 1.0)
out vec4 fragColor;

void main() {
    vec2 hp = u_HalfPixel * u_Offset;
    vec3 sum = textureLod(u_Tex, v_Uv, 0.0).rgb * 4.0;
    sum += textureLod(u_Tex, v_Uv - hp, 0.0).rgb;
    sum += textureLod(u_Tex, v_Uv + hp, 0.0).rgb;
    sum += textureLod(u_Tex, v_Uv + vec2(hp.x, -hp.y), 0.0).rgb;
    sum += textureLod(u_Tex, v_Uv - vec2(hp.x, -hp.y), 0.0).rgb;
    fragColor = vec4(sum / 8.0, 1.0);
}
`;

// Upsample: 8-tap "tent" kernel
const UP_FRAG = `#version 300 es
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
uniform vec2 u_HalfPixel;     // half-texel size of the SOURCE (smaller image)
uniform float u_Offset;
out vec4 fragColor;

void main() {
    vec2 hp = u_HalfPixel * u_Offset;
    vec3 sum  = textureLod(u_Tex, v_Uv + vec2(-hp.x * 2.0, 0.0), 0.0).rgb;
    sum += textureLod(u_Tex, v_Uv + vec2(-hp.x,  hp.y), 0.0).rgb * 2.0;
    sum += textureLod(u_Tex, v_Uv + vec2( 0.0,  hp.y * 2.0), 0.0).rgb;
    sum += textureLod(u_Tex, v_Uv + vec2( hp.x,  hp.y), 0.0).rgb * 2.0;
    sum += textureLod(u_Tex, v_Uv + vec2( hp.x * 2.0, 0.0), 0.0).rgb;
    sum += textureLod(u_Tex, v_Uv + vec2( hp.x, -hp.y), 0.0).rgb * 2.0;
    sum += textureLod(u_Tex, v_Uv + vec2( 0.0, -hp.y * 2.0), 0.0).rgb;
    sum += textureLod(u_Tex, v_Uv + vec2(-hp.x, -hp.y), 0.0).rgb * 2.0;
    fragColor = vec4(sum / 12.0, 1.0);
}
`;

// 1-tap passthrough copy. Used to seed mip 0 with the RAW scene (σ=0) for the
// progressive-blur "true continuum" path: GenerateOutputMipmap then builds the
// Gaussian stack from a sharp root, so sampling a continuous LOD ramps clear →
// heavy with no sharp/blurred crossfade and no separate scene texture.
const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 v_Uv;
uniform sampler2D u_Tex;
out vec4 fragColor;
void main() {
    fragColor = vec4(textureLod(u_Tex, v_Uv, 0.0).rgb, 1.0);
}
`;

// 9 levels: covers LOD 0..8 with dual-filter quality. Progressive blur
// samples up to LOD ~6 for heavy BackdropFrostBlur settings; extra headroom
// keeps the smooth mipmap chain populated deeper than we'll typically read.
export const MAX_LEVELS = 9;

/** Keep ≥ this much σ in base space for the σ-adaptive downsample (k ≤ σ/4 ≪ σ/2 → invisible). */
const BASE_SIGMA = 4;
const K_MAX = 8;

/** -- WHY THERE IS NO SWITCH HERE ------------------------------------------------------------
 *  A pyramid is ALLOCATED to the caller's region. There used to be a `REGION_SIZED_PYRAMIDS`
 *  constant here, documented as restoring the pre-region model - allocate the whole input,
 *  scissor to the region - when flipped to `false`, "same pixels either way". It did not.
 *  Measured on `idle`, win32, one build, flipping only that constant: 639,299 of 4,096,000
 *  pixels differed, max channel delta 31, mean 3.61, over a bbox spanning most of the canvas.
 *  Region-ON against the genuine pre-region build measured 1,107 px at max delta 1. So ON was
 *  faithful and OFF was a THIRD rendering, and the lever someone reaches for in an emergency
 *  would have handed them a different picture while telling them they had reverted.
 *
 *  It could not have been faithful, and that is the part worth keeping. The two models differ
 *  in what lies OUTSIDE the region, not only in where it is stored: a region-sized level ends
 *  at the rect and CLAMP_TO_EDGE repeats its border texels, while a scissored canvas-sized
 *  level holds the neighbouring scene and, past the guard band, the PREVIOUS surface's
 *  pyramid. Every consumer clamps its reads in SCREEN UV - the frame its clip AABB is in, not
 *  the pyramid's - so that difference is reachable rather than theoretical. Making `false`
 *  bit-faithful means giving the scissored path the region's clamp, which is the region path.
 *
 *  What the constant recorded, and this keeps: on a tile-based deferred GPU (Apple Metal) a
 *  render pass loads and stores its WHOLE attachment - `MTLRenderPassDescriptor` has no
 *  partial render area - so a scissored draw into a canvas-sized level still moves 16.4 MB,
 *  and sizing the attachment down is the only way to stop paying for it (ARM,
 *  *Bandwidth-Efficient Rendering*, SIGGRAPH 2015). On an immediate-mode GPU behind D3D11
 *  there is no whole-attachment load/store to save, so region sizing buys nothing there and
 *  costs a few more render targets and binds: measured on win32 at +5.3% GPU process
 *  (1524.3 ms against a scissored 1447.5 ms) on the glass-grid scene, every other variable
 *  held. That is the open question, and it is a question about which model to SHIP. It gets
 *  answered by measuring on a Mac and changing this file, not by a runtime flag that has to
 *  keep a second rendering alive in order to be flipped. */

/** Ceiling on the level-FBO storage ONE BlurPass keeps resident across region sizes, and
 *  the most distinct sizes it will hold. See `_useChain` for why more than one is needed.
 *  At the sizes this app actually produces — a 216x150pt glass card at DPR 2 resolves to a
 *  568x436 level 0, about 1.65 MB of chain; a full-canvas 2560x1600 modal is 27.3 MB —
 *  48 MB holds a canvas-sized chain plus a dozen cards, or twenty-nine cards alone. */
export const CHAIN_BUDGET_BYTES = 48 * 1024 * 1024;
export const MAX_CHAINS = 6;

/** The two ceilings above, per PASS rather than per module, so a measurement flag can raise them
 *  for the pass it arms and nothing else in the process moves.
 *
 *  `?blur-phased` is the reason this exists. A phased frame builds every fill pyramid BEFORE it
 *  draws any fill, so twenty of them have to be alive at once — and `_useChain` keys a chain on
 *  its level-0 size, so twenty consecutive builds of one size share ONE chain unless the rotation
 *  hands out twenty. Twenty 568x436 fill chains at 1.65 MB plus twenty 480x348 rim chains at
 *  1.11 MB is 40 chains and 55.3 MB, against a shipped `MAX_CHAINS` of 6 and a 48 MB budget. The
 *  flag hands in its own pair and says so on the trace; every unflagged pass keeps the constants.
 *  Never mutated: an instance field cannot be forgotten on the way back out. */
export interface ChainLimits {
  /** Distinct resident chains this pass will hold before it evicts. */
  MaxChains: number;
  /** Total `ChainBytes` this pass will hold before it evicts. */
  BudgetBytes: number;
}

/** Upper bound on the storage ONE chain holds: the down chain sums to 4/3 of level 0 and its
 *  mip slots add another 1/3. Used only to bound residency, never to address memory. The
 *  admission check and the chain it admits have to agree on this number, so it is one function
 *  rather than the same expression written twice. */
export const ChainBytes = (w: number, h: number): number => Math.ceil(w * h * 4 * 5 / 3);

/** One resident pyramid: `Levels[0]` at some level-0 size, every level halving from it.
 *  Keyed by that size, because `Framebuffer.Resize` is a full `texImage2D` reallocation at
 *  any other one — and, when `ChainCount` is rotating the pool, by `Slot` as well. */
interface LevelChain {
  Levels: Framebuffer[];
  W: number;
  H: number;
  /** Which of the `ChainCount` chains of this level-0 size this one is. Always 0 unless
   *  `?blur-chains=N` is rotating the pool; see `_useChain`. */
  Slot: number;
  /** `ChainBytes(W, H)`, cached. */
  Bytes: number;
  /** `_tick` of the last Blur that selected it — the LRU key. */
  Used: number;
}

/** The part of the input a pyramid is built over, in input texels. `YBottom` counts from the
 *  BOTTOM (GL's convention) because that is the axis every pass and every consumer works in. */
export interface RegionRect {
  X: number;
  YBottom: number;
  W: number;
  H: number;
  /** True when the region is the whole input — the pyramid is canvas-sized and every source
   *  rect is the identity, so the passes are bit-for-bit what they always were. */
  Full: boolean;
}

/** A rect of the input in device px with y=0 at the TOP — the shape every backdrop consumer
 *  already speaks, and the shape the union planner takes its members in. */
export interface BackdropRect { x: number; y: number; w: number; h: number }

/** How far the σ-adaptive base downsample may shrink the backdrop before the pyramid runs.
 *  Unchanged in substance: only a blur over a BIG fraction of the canvas re-bases, because
 *  that is where the fill saving is real and the sample margins are ample. The area is
 *  still measured against the CANVAS — a region-sized pyramid must not read as "100% of the
 *  area" and start re-basing every little glass card, which would drop its device density.
 *
 *  Module scope, not a method, because `PlanBackdropUnion` has to predict the EXACT k a
 *  member's own `Blur` call will choose. A planner with its own copy of this rule is a planner
 *  that can silently disagree with the pass it is planning for, and the whole identity argument
 *  below rests on those two numbers being the same number. */
export const BaseDownsampleFactor = (
  radius: number, width: number, height: number, region?: BackdropRect,
): number => {
  if (radius <= BASE_SIGMA) return 1;
  const fullArea = width * height;
  const area = region ? region.w * region.h : fullArea;
  if (area < 0.15 * fullArea) return 1;
  return Math.min(K_MAX, 1 << Math.floor(Math.log2(radius / BASE_SIGMA)));
};

/** Pick pyramid depth from desired sigma. Each Down/Up pair roughly doubles the effective
 *  sigma, with a baseline of ~3 px per level:
 *    depth 1: σ ≈ 4   depth 2: σ ≈ 9   depth 3: σ ≈ 20   depth 4: σ ≈ 45
 *  Capped at MAX_LEVELS-1 (need 1 level above the input for the down chain). `minDepth`
 *  lets callers guarantee enough levels exist for textureLod sampling. */
export const PyramidDepth = (radius: number, minDepth: number): number => {
  const target = Math.max(1, radius);
  return Math.max(Math.max(1, minDepth), Math.min(MAX_LEVELS - 1, Math.ceil(Math.log2(target / 3 + 1))));
};

/** Turn the caller's sample rect into the rect the pyramid is actually built over.
 *
 *  ORIGIN snaps DOWN to the downsample grid (`phase` = the σ-adaptive factor times 2^depth).
 *  Level i of the chain averages source texels [origin + j·2^i, …]; putting the origin on a
 *  multiple of 2^depth makes every level a texel-exact SUB-GRID of the canvas-sized pyramid
 *  this used to build. Same texels averaged together, same phase — a CROP, not a resample.
 *  An unaligned origin would pair different neighbours at every level and move real pixels.
 *
 *  EXTENT rounds UP to the same grid and clamps to the input, so the result always CONTAINS
 *  the caller's rect and every halving in the chain is exact.
 *
 *  Snapping to `phase` rather than to some coarser bucket is also what keeps the level FBOs
 *  from thrashing between surfaces: anything laid out on a regular pitch shares `x mod phase`,
 *  so a grid of equal cards resolves to ONE extent and re-allocates nothing after the first
 *  frame. (glass-grid's twenty cards sit on a 236pt pitch — 472 device px at DPR 2, a multiple
 *  of the depth-2 phase of 4 — so every one of them lands on exactly 568x436.) A page whose
 *  glass surfaces genuinely differ in size pays one `Resize` per distinct size per frame, which
 *  is a texture allocation against 47MB of attachment traffic saved. */
export const ResolveRegionRect = (
  region: BackdropRect | undefined, width: number, height: number, phase: number,
): RegionRect => {
  if (!region) return { X: 0, YBottom: 0, W: width, H: height, Full: true };
  const rx = Math.max(0, Math.min(width - 1, Math.floor(region.x)));
  const ry = Math.max(0, Math.min(height - 1, Math.floor(region.y)));
  const rw = Math.max(1, Math.min(width - rx, Math.ceil(region.w)));
  const rh = Math.max(1, Math.min(height - ry, Math.ceil(region.h)));
  const ryb = height - (ry + rh);

  const x0 = Math.floor(rx / phase) * phase;
  const y0 = Math.floor(ryb / phase) * phase;
  const w = Math.min(width - x0, Math.ceil((rx + rw - x0) / phase) * phase);
  const h = Math.min(height - y0, Math.ceil((ryb + rh - y0) / phase) * phase);
  const full = x0 === 0 && y0 === 0 && w === width && h === height;
  return { X: x0, YBottom: y0, W: w, H: h, Full: full };
};

/** Destination pixels one `Blur` writes for a resolved rect at (k, depth) — the pre-downsample
 *  chain, the DOWN chain and the UP chain, counted with the SAME Math.floor halvings the loops
 *  use rather than a 4/3 closed form. This is the only currency the union decision is allowed to
 *  trade in: blur fill is what the phone is short of, and a closed form that is 2% off at depth 2
 *  is 2% of the number the whole decision turns on. */
export const PyramidFill = (rectW: number, rectH: number, k: number, depth: number): number => {
  let w = rectW, h = rectH, fill = 0;
  for (let s = k; s > 1; s >>= 1) {
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
    fill += w * h;
  }
  const lw: number[] = [w], lh: number[] = [h];
  for (let i = 1; i <= depth; i++) {
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
    lw.push(w); lh.push(h);
  }
  for (let i = 1; i <= depth; i++) fill += lw[i] * lh[i];          // DOWN chain
  for (let i = depth - 1; i >= 0; i--) fill += lw[i] * lh[i];      // UP chain
  return fill;
};

/** One pyramid serving a whole (σ, k) CLASS of surfaces, instead of one per surface. */
export interface BackdropUnionPlan {
  /** The rect to build over, already snapped — pass it straight to `Blur` as the region. */
  Region: BackdropRect;
  /** The factor the union MUST be pinned to. Not the one it would pick for itself: the union is
   *  bigger than its members, and `BaseDownsampleFactor`'s 15%-of-canvas gate is exactly where a
   *  union of small cards crosses into k=2 while each card stays at k=1. */
  K: number;
  Depth: number;
  Phase: number;
  /** Destination pixels the union writes once. */
  Fill: number;
  /** Destination pixels the members write between them today. */
  MemberFill: number;
}

/**
 * Plan ONE pyramid over the union of `members`, or return null when no such pyramid is both
 * texel-identical to what each member builds for itself and cheaper than all of them together.
 *
 * WHY THIS CAN BE IDENTICAL AT ALL, in one line: `depth` is a function of `radius / k` alone, so
 * equal σ plus equal k gives equal depth, gives equal phase, and two rects snapped down to the
 * same phase differ by a multiple of it — which is precisely the condition under which every
 * level of the union chain averages the same source texels, in the same groups, that the
 * member's own chain does. A CROP, not a resample; `ResolveRegionRect` above argues the same
 * thing for one surface against the canvas-sized pyramid this all used to be.
 *
 * The conditions, each of which is a way that argument can fail and each of which is checked:
 *
 *  1. TWO OR MORE MEMBERS. A class of one has a union equal to its own region, so it would pay
 *     a build to save nothing. It must come out of here as null and take the path it takes
 *     today, untouched.
 *  2. ONE k ACROSS THE CLASS. k depends on the REGION as well as σ, so two surfaces at the same
 *     frost can genuinely land on different factors (a small card at 1, a near-full-screen panel
 *     at 4). Those are different classes; mixing them is a resample.
 *  3. EXACT HALVINGS, for the union AND for every member. `ResolveRegionRect` rounds the extent
 *     UP to phase and then CLAMPS it to the input — and at the canvas edge that clamp can hand
 *     back an extent that is not a multiple of phase. Then floor(W/2) stops being W/2, the
 *     level-i grid drifts by a sub-texel that grows with depth, and the crop argument is gone.
 *     A clamped rect on EITHER side disqualifies the class.
 *  4. CONTAINMENT. The union has to hold every member's resolved rect, not merely its requested
 *     one. Snapping the bounding box is monotone in both directions, so this holds by
 *     construction — it is checked rather than assumed because it is cheap and load bearing.
 *  5. THE ARITHMETIC. Fill < MemberFill, strictly, with no fudge factor in either direction.
 *     Two chips at opposite corners union to most of the screen and lose here; twenty chips on
 *     one toolbar row win by about 5x. It is the same test either way, which is why this needs
 *     no separate "are they close enough to each other" heuristic bolted on beside it.
 *
 * What it deliberately does NOT decide: whether the members may share a pyramid in the first
 * place. That is a question about DRAW ORDER — a surface's backdrop contains everything drawn
 * before it, including earlier glass — and only the render walk knows the walk.
 *
 * NOTHING IN src CALLS THIS, AND THAT IS THE FINDING RATHER THAN AN OMISSION. Wired to the walk
 * it is correct and it is nearly worthless, because the two conditions a union must satisfy pull
 * against each other. It saves in proportion to how much the member regions OVERLAP, so it wants
 * a pitch below a region's own width; it is only legal where an earlier surface's paint stays out
 * of a later one's sample margin, so it needs a pitch above the box plus one margin plus that
 * paint's outset. Those two bounds are `margin - outset` apart — about 16pt of pitch for
 * JwiftGlass — and the saving has decayed to nothing by the time the pitch clears the lower one.
 * `tests/Blur.Union.test.ts` sweeps it: on glass-grid's own cards the union becomes legal at a
 * 52pt gap and has stopped paying by 68pt, and is worth at most 1.12x in between. glass-grid ships
 * a 20pt gap, where it is worth 1.385x and is not available.
 *
 * It is kept, with its test, because the question gets asked about once a quarter and the answer
 * is arithmetic that takes a day to re-derive and five minutes to run. It becomes live code the
 * day someone decides glass should stop refracting the glass BESIDE it — which is a change to the
 * picture, so it is not a decision this file gets to make.
 */
export const PlanBackdropUnion = (
  members: readonly BackdropRect[], width: number, height: number, radius: number,
): BackdropUnionPlan | null => {
  if (members.length < 2) return null;                                        // (1)
  if (radius <= 0) return null;

  const k = BaseDownsampleFactor(radius, width, height, members[0]);
  for (let i = 1; i < members.length; i++) {                                  // (2)
    if (BaseDownsampleFactor(radius, width, height, members[i]) !== k) return null;
  }
  const depth = PyramidDepth(radius / k, 0);
  const phase = k * (1 << depth);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let memberFill = 0;
  const resolved: RegionRect[] = [];
  for (const m of members) {
    const rr = ResolveRegionRect(m, width, height, phase);
    if (rr.W % phase !== 0 || rr.H % phase !== 0) return null;                 // (3)
    resolved.push(rr);
    memberFill += PyramidFill(rr.W, rr.H, k, depth);
    if (m.x < x0) x0 = m.x;
    if (m.y < y0) y0 = m.y;
    if (m.x + m.w > x1) x1 = m.x + m.w;
    if (m.y + m.h > y1) y1 = m.y + m.h;
  }

  const region: BackdropRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const u = ResolveRegionRect(region, width, height, phase);
  if (u.W % phase !== 0 || u.H % phase !== 0) return null;                     // (3)
  for (const rr of resolved) {                                                // (4)
    if (rr.X < u.X || rr.YBottom < u.YBottom
        || rr.X + rr.W > u.X + u.W || rr.YBottom + rr.H > u.YBottom + u.H) return null;
  }

  const fill = PyramidFill(u.W, u.H, k, depth);
  if (fill >= memberFill) return null;                                        // (5)

  return { Region: region, K: k, Depth: depth, Phase: phase, Fill: fill, MemberFill: memberFill };
};

export class BlurPass {
  private _gl: WebGL2RenderingContext;
  private _down: ShaderProgram;
  private _up: ShaderProgram;
  private _copy: ShaderProgram;
  private _quad: QuadGeometry;
  /** The ACTIVE chain's levels. Rebound by `_useChain` at the top of every Blur and read by
   *  `GenerateOutputMipmap`, which always runs against the chain the last Blur selected. */
  private _levels: Framebuffer[] = [];
  private _chains: LevelChain[] = [];
  private _tick: number = 0;
  /** How many chains the pool keeps PER level-0 size. 1 is the shipped pool. See `_useChain`. */
  private readonly _chainCount: number;
  /** Effective count, which starts at `_chainCount` and drops to 1 the moment rotating would
   *  cost an eviction. Separate from `_chainCount` so the census can say what was ASKED for
   *  next to what actually ran. */
  private _chainsLive: number;
  /** Builds so far per level-0 size, keyed `WxH`. The round-robin phase; only written when
   *  rotating. */
  private _chainSeq = new Map<string, number>();
  /** This pass's residency ceilings. `MAX_CHAINS` / `CHAIN_BUDGET_BYTES` unless a caller handed in
   *  `ChainLimits` — which today is `?blur-phased` and nothing else. Read everywhere the two module
   *  constants used to be read, so raising them raises the admission check and the eviction loop
   *  together and the two cannot disagree. */
  private readonly _maxChains: number;
  private readonly _budgetBytes: number;
  /** Why the rotation stopped, or null. Set once, traced once. */
  private _chainRefusal: string | null = null;
  private _lastDepth: number = 0;
  /** Single FBO reused for the attach-mip-and-blit dance in
   *  GenerateOutputMipmap. Created lazily on first use. */
  private _mipBlitFbo: WebGLFramebuffer | null = null;
  /** Ping-pong scratch FBOs for the σ-adaptive base downsample (band-limit
   *  optimization). Created lazily the first time a large blur downsamples. */
  private _preA: Framebuffer | null = null;
  private _preB: Framebuffer | null = null;
  /** Where the last pyramid's texels sit on screen. Consumers read it off the returned
   *  texture handle and map their screen UV through it before sampling. */
  private _lastRegion: BackdropRegion = BACKDROP_REGION_FULL;
  get LastDepth(): number { return this._lastDepth; }
  get LastRegion(): BackdropRegion { return this._lastRegion; }

  // Filled by `WireLocations`, not the constructor: reading a uniform location blocks until the
  // program has linked, which is exactly what a batched compile is avoiding.
  private _downTexLoc: WebGLUniformLocation | null = null;
  private _downHpLoc: WebGLUniformLocation | null = null;
  private _downOffLoc: WebGLUniformLocation | null = null;
  private _downSrcLoc: WebGLUniformLocation | null = null;
  private _upTexLoc: WebGLUniformLocation | null = null;
  private _upHpLoc: WebGLUniformLocation | null = null;
  private _upOffLoc: WebGLUniformLocation | null = null;
  private _upSrcLoc: WebGLUniformLocation | null = null;
  private _copyTexLoc: WebGLUniformLocation | null = null;
  private _copySrcLoc: WebGLUniformLocation | null = null;

  /**
   * `batch` joins the blur's three programs to a caller's compile batch so all of them reach the
   * driver's compiler pool before anyone asks how they went — the renderer passes its Init batch,
   * which is what keeps these three off the serial cold-boot chain. Without one the pass compiles
   * and wires itself, exactly as before. Same sources, same programs either way.
   */
  /** Per-pass GPU timing, or null (the shipping case). Set by the renderer when `?wkr-jaui-prof`
   *  or `?trace` arms it; see `Pass.Timers`. Every bind site below reports its target through it
   *  so a bracket can tell a real attachment change from an inherited one. */
  Timers: PassTimers<WebGLQuery> | null = null;
  /** Which BlurPass this is, so its level FBOs get distinct target keys. Three coexist per
   *  renderer -- the per-surface chain, the sharp-root chain and the shared backdrop's. */
  TimerTag: string = 'blur';

  /** `?scene-restarts=N` ONLY: the active chain's level-0 framebuffer, or `null` before any build.
   *
   *  It is the target the pyramid's LAST upsample hop draws into (`Blur`'s `i = 0` iteration, and
   *  the sharp-root branch's single copy), so it is the target a build ENDS the scene on -- which
   *  is the whole reason the flag wants it. `?scene-restarts`'s probe binds it and draws one
   *  transparent pixel so that its extra encoder end is a REAL build's end rather than a detour
   *  through a 1x1 target, after the second lane's +8.5 ms could not be reconciled with
   *  `?blur-phased` removing 38 real ends for +0.28 (Perf/README.md, "H4 REFUTED ON A LIVE FLAG").
   *
   *  A GETTER AND NOTHING ELSE: no arithmetic, no bind, no resize, no state of its own. The caller
   *  binds with `Framebuffer.Bind()` and must NOT invalidate -- `_bindTarget` invalidates because
   *  it is about to overwrite the level, and the probe is not. */
  get DiagLevel0(): Framebuffer | null {
    return this._levels.length > 0 ? this._levels[0] : null;
  }

  /** What the pool holds per level-0 size, what it actually ran at, and why those differ.
   *  Read by the renderer's trace line; the flag's whole claim is that this stays honest. */
  get ChainCensus(): {
    Asked: number; Live: number; Resident: number; Sizes: string; Refused: string | null;
    Max: number; BudgetMb: number; ResidentMb: number;
  } {
    const sizes = new Map<string, number>();
    let bytes = 0;
    for (const c of this._chains) {
      sizes.set(`${c.W}x${c.H}`, (sizes.get(`${c.W}x${c.H}`) ?? 0) + 1);
      bytes += c.Bytes;
    }
    return {
      Asked: this._chainCount,
      Live: this._chainsLive,
      Resident: this._chains.length,
      Sizes: [...sizes].map(([k, n]) => `${k}#${n}`).join('+'),
      Refused: this._chainRefusal,
      // The ceilings this pass actually ran under, and what it actually holds. A raised ceiling
      // that nobody can read from the trace is a raised ceiling nobody can check.
      Max: this._maxChains,
      BudgetMb: Math.round(this._budgetBytes / (1024 * 1024)),
      ResidentMb: Math.round(bytes / (1024 * 1024) * 10) / 10,
    };
  }

  /** `chains` is `?blur-chains=N` — how many chains the pool keeps per level-0 size, handed out
   *  round-robin per build so consecutive builds of one size never share one. 1 (the default, and
   *  every shipping path) is the pool exactly as it was. Out of range is a throw rather than a
   *  clamp: a measurement flag that quietly measured something else is the failure mode the whole
   *  instrument exists to avoid. */
  constructor(gl: WebGL2RenderingContext, batch?: ShaderBatch, chains: number = 1, limits?: ChainLimits) {
    const maxChains = limits?.MaxChains ?? MAX_CHAINS;
    if (!Number.isInteger(chains) || chains < 1 || chains > maxChains) {
      throw new Error(`[Jaui] BlurPass chains must be an integer in 1..${maxChains}, got ${chains}`);
    }
    this._maxChains = maxChains;
    this._budgetBytes = limits?.BudgetBytes ?? CHAIN_BUDGET_BYTES;
    this._chainCount = chains;
    this._chainsLive = chains;
    this._gl = gl;
    const b = batch ?? new ShaderBatch(gl);
    this._down = b.Add(VERT, DOWN_FRAG);
    this._up = b.Add(VERT, UP_FRAG);
    this._copy = b.Add(VERT, COPY_FRAG);
    this._quad = new QuadGeometry(gl);

    // Level chains are built on demand by `_useChain` — which size to build is not known
    // until a caller asks for one. 10-bit levels: a wide blur produces a very smooth
    // gradient that 8-bit (256 levels) quantizes into visible bands BEFORE the consumer
    // shaders ever sample it. RGB10_A2 (1024 levels, same 32 bits/texel) stores the
    // gradient finely enough that the bands vanish; the consumers' output dither then
    // handles the final 8-bit canvas write.

    if (!batch) { b.Resolve(); this.WireLocations(); }
  }

  /** Read the uniform locations. The owner of a shared batch calls this after `Resolve`. */
  WireLocations = (): void => {
    const gl = this._gl;
    this._downTexLoc = gl.getUniformLocation(this._down.Program, 'u_Tex');
    this._downHpLoc = gl.getUniformLocation(this._down.Program, 'u_HalfPixel');
    this._downOffLoc = gl.getUniformLocation(this._down.Program, 'u_Offset');
    this._downSrcLoc = gl.getUniformLocation(this._down.Program, 'u_SrcRect');
    this._upTexLoc = gl.getUniformLocation(this._up.Program, 'u_Tex');
    this._upHpLoc = gl.getUniformLocation(this._up.Program, 'u_HalfPixel');
    this._upOffLoc = gl.getUniformLocation(this._up.Program, 'u_Offset');
    this._upSrcLoc = gl.getUniformLocation(this._up.Program, 'u_SrcRect');
    this._copyTexLoc = gl.getUniformLocation(this._copy.Program, 'u_Tex');
    this._copySrcLoc = gl.getUniformLocation(this._copy.Program, 'u_SrcRect');
  };

  /**
   * Blur `input` and return the resulting texture (level 0 of the pyramid).
   * `radius` is interpreted as approximate effective sigma in source pixels.
   * Internally it picks a pyramid depth + tap-offset that achieves it.
   *
   * `region` is optional: the rect of the input the caller will sample, in input-texture
   * device px with y=0 at TOP. The pyramid is ALLOCATED TO IT — level 0 comes back
   * `region`-sized, holding the same texels at the same device density, and `LastRegion`
   * carries the affine map from screen UV into it.
   *
   * That is the whole point of the parameter. A glass card is a 562x430 patch of a
   * 2560x1600 canvas; a canvas-sized level 0 is a 16.4MB attachment, and on a tile-based
   * GPU every render pass that touches it pays a full load AND store, because Metal has no
   * partial render area — a scissored draw still resolves the whole thing. Sizing the
   * attachment to the patch is the difference between ~84MB and ~37MB of attachment traffic
   * per glass surface, forty times a frame.
   *
   * Omit `region` for a pyramid over the whole input (the shared backdrop). Then every pass
   * is bit-for-bit what it always was.
   *
   * `baseFactor` PINS the sigma-adaptive downsample instead of deriving it from the region.
   * Only one caller needs it and only for one reason: a union pyramid is bigger than the
   * surfaces it serves, so it can cross the 15%-of-canvas gate that each of them sits below and
   * pick a coarser factor than they did. Different factor, different phase, different texels —
   * and the crop argument that makes a union identical is gone. Lowering it is never a fidelity
   * loss (see the re-base note below: it discards only what the blur was about to erase), it
   * costs fill and buys correctness. A value that is not a power of two is a caller bug and
   * throws rather than quietly rounding into a third rendering. No caller passes it today; see
   * `PlanBackdropUnion` for the one that would, and for why it does not exist yet.
   */
  Blur = (
    input: WebGLTexture,
    width: number,
    height: number,
    radius: number,
    minDepth: number = 0,
    region?: BackdropRect,
    baseFactor?: number,
  ): WebGLTexture => {
    const gl = this._gl;

    // The σ-adaptive factor and the pyramid depth both have to be known BEFORE the region is
    // resolved: together they set the downsample grid the region's origin must land on.
    const k = baseFactor ?? BaseDownsampleFactor(radius, width, height, region);
    if (baseFactor !== undefined && (k < 1 || (k & (k - 1)) !== 0)) {
      throw new Error(`[Jaui] Blur baseFactor must be a power of two, got ${k}`);
    }
    const depth = radius > 0 ? PyramidDepth(radius / k, minDepth) : 0;
    const rect = ResolveRegionRect(region, width, height, k * (1 << depth));
    // Computed from the ORIGINAL canvas units: Scale and Offset are ratios, so they survive
    // the σ-adaptive re-base below untouched — a coarser level 0 still covers the same rect.
    const scaleX = width / rect.W, scaleY = height / rect.H;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this._quad.Vao);

    // Sharp-root mode (radius ≤ 0): seed mip 0 with the RAW input (σ=0) via a
    // 1-tap copy, skipping the dual-filter pre-blur. The caller then builds the
    // Gaussian mip stack (GenerateOutputMipmap) from this sharp root, so the
    // progressive-blur shader's continuous LOD ramps from truly clear → heavy
    // with no sharp/blurred crossfade. Also cheaper than the dual filter: one pass.
    if (radius <= 0) {
      this._useChain(rect.W, rect.H);
      this._levels[0].Resize(rect.W, rect.H);
      this._bindTarget(this._levels[0], 'l0');
      // The 1-tap copy that seeds level 0 is the down side of the chain -- it is how the source
      // gets into the pyramid -- so it is billed to `blur-down` rather than opening a fourth row
      // for a single pass nothing can remove independently.
      const timedCopy = this.Timers !== null && this.Timers.Begin('blur-down');
      gl.useProgram(this._copy.Program);
      gl.uniform1i(this._copyTexLoc, 0);
      this._setSrcRect(this._copySrcLoc, rect, width, height);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._target('default');
      if (timedCopy) this.Timers!.End();
      this._lastDepth = 0;
      this._lastRegion = this._region(rect, scaleX, scaleY);
      return this._levels[0].Texture;
    }

    // ── σ-adaptive base downsample (band-limit optimization) ──────────────
    // A blur of σ pixels destroys every detail finer than ~σ px. So running
    // the whole pyramid on a backdrop pre-downsampled by k ≈ σ/4 throws away
    // ONLY information the blur was about to erase — pixel-faithful output —
    // while cutting fragment fill ~k×. This makes a heavy full-screen modal
    // blur cost roughly the same as a light one instead of scaling with σ.
    //
    // Guarded to LARGE-area blurs (full-screen modals/scrims); see
    // _baseDownsampleFactor for the gate and why it is measured against the canvas.
    let srcTex = input;
    let srcW = width, srcH = height;
    let srcRect: RegionRect = rect;
    // One bracket spans the pre-downsample AND the pyramid's down hops: they are one chain, and
    // splitting them would put a query boundary in the middle of a ping-pong whose tile work
    // resolves at the far end of it.
    let timedDown = false;
    if (k > 1) {
      if (!this._preA) this._preA = new Framebuffer(gl, { highPrecision: true });
      if (!this._preB) this._preB = new Framebuffer(gl, { highPrecision: true });
      const pp = [this._preA, this._preB];
      // The sigma-adaptive pre-downsample is the first half of the down side; it shares the
      // `blur-down` bucket with the pyramid's own hops rather than splitting a chain in two.
      timedDown = this.Timers !== null && this.Timers.Begin('blur-down');
      gl.useProgram(this._down.Program);
      gl.uniform1i(this._downTexLoc, 0);
      gl.uniform1f(this._downOffLoc, 1.0);
      let curW = rect.W, curH = rect.H;
      const passes = Math.round(Math.log2(k));
      for (let s = 0; s < passes; s++) {
        curW = Math.max(1, Math.floor(curW / 2));
        curH = Math.max(1, Math.floor(curH / 2));
        const fb = pp[s % 2];
        fb.Resize(curW, curH);
        this._bindTarget(fb, `pre${s % 2}`);
        // Only the FIRST pre-pass reads the canvas-sized input, so only it carries the
        // region's source rect; from there the chain reads whole region-sized levels.
        this._setSrcRect(this._downSrcLoc, s === 0 ? rect : null, srcW, srcH);
        gl.uniform2f(this._downHpLoc, 0.5 / srcW, 0.5 / srcH);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        srcTex = fb.Texture; srcW = curW; srcH = curH;
      }
      // Re-base the pyramid onto the downsampled backdrop. The consumer samples level 0 +
      // its mips through `LastRegion`, which is a UV map — the lower resolution changes how
      // many texels back it, not which part of the screen they stand for.
      radius = radius / k;
      srcRect = { X: 0, YBottom: 0, W: srcW, H: srcH, Full: true };
    }

    this._lastDepth = depth;
    // Use the per-tap offset to fine-tune within the chosen depth.
    const baseSigma = 3 * Math.pow(2, depth);
    // Keep tap-offset near 1.0 — wider offsets create the visible "oil pastel"
    // striations (tap centers drift apart faster than the overlap can cover).
    const tapOffset = Math.max(0.7, Math.min(1.3, Math.max(1, radius) / baseSigma));

    // Allocate level FBOs at progressively halved sizes. levels[0] is the destination at
    // REGION size (where the upsample chain ends); levels[1..depth] are the smaller ones.
    let w = srcRect.W, h = srcRect.H;
    this._useChain(w, h);
    this._levels[0].Resize(w, h);
    for (let i = 1; i <= depth; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this._levels[i].Resize(w, h);
    }

    // ── Downsample chain: input → level 1 → level 2 → ... → level depth ──
    // `depth` can legitimately be 0 -- a small sigma on a large canvas -- and then neither chain
    // below draws anything. An empty bracket is two GL calls, a near-zero row and a target
    // boundary the next pass would be judged against, so it is not opened at all.
    if (!timedDown && depth >= 1) timedDown = this.Timers !== null && this.Timers.Begin('blur-down');
    gl.useProgram(this._down.Program);
    gl.uniform1i(this._downTexLoc, 0);
    gl.uniform1f(this._downOffLoc, tapOffset);

    for (let i = 1; i <= depth; i++) {
      const dst = this._levels[i];
      this._bindTarget(dst, `l${i}`);
      // Again: only the first hop reads the canvas-sized input through the region rect.
      this._setSrcRect(this._downSrcLoc, i === 1 ? srcRect : null, srcW, srcH);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      // The tap offset is HALF A SOURCE TEXEL either way — `u_HalfPixel` is normalized
      // against the source's own size, so it is the same half-texel it was when level 0
      // covered the canvas. The region changes the rect, never the kernel.
      gl.uniform2f(this._downHpLoc, 0.5 / srcW, 0.5 / srcH);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      srcTex = dst.Texture;
      srcW = dst.Width;
      srcH = dst.Height;
    }

    // ── Upsample chain: level depth → level depth-1 → ... → level 0 ──
    // Every hop reads a region-sized level, so the source rect is the identity throughout.
    // The down chain closes HERE and the up chain opens: the first up hop binds level depth-1
    // while the last down hop wrote level depth, so this boundary is a real attachment change.
    if (timedDown) this.Timers!.End();
    const timedUp = depth >= 1 && this.Timers !== null && this.Timers.Begin('blur-up');
    gl.useProgram(this._up.Program);
    gl.uniform1i(this._upTexLoc, 0);
    gl.uniform1f(this._upOffLoc, tapOffset);
    this._setSrcRect(this._upSrcLoc, null, 1, 1);

    for (let i = depth - 1; i >= 0; i--) {
      const dst = this._levels[i];
      this._bindTarget(dst, `l${i}`);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform2f(this._upHpLoc, 0.5 / srcW, 0.5 / srcH);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      srcTex = dst.Texture;
      srcW = dst.Width;
      srcH = dst.Height;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._target('default');
    if (timedUp) this.Timers!.End();
    this._lastRegion = this._region(rect, scaleX, scaleY);

    return this._levels[0].Texture;
  };

  /** Populate the output texture's mipmap chain with a proper Gaussian
   *  pyramid OF THE LEVEL-0 RESULT, instead of the driver's 2×2 box filter.
   *
   *  Why this matters: Blur() leaves `_levels[0]` holding a Gaussian-
   *  approximation blur at the requested σ (full resolution). The
   *  progressive-blur shader samples this texture with `textureLod` at
   *  fractional LODs, so every mip level needs to be a monotonically-
   *  wider Gaussian of the same scene. The driver's `generateMipmap`
   *  preserves high-contrast edges as discrete color blocks at mid/high
   *  LODs (visible as "stamps" in heavy progressive-blur regions), and
   *  the previous implementation here re-used the dual-filter algorithm
   *  intermediates (`_levels[1..depth]`) which are NOT proper Gaussian-
   *  pyramid levels — at depth=1 mip 1 ended up LESS blurred than mip 0
   *  (non-monotonic σ), which trilinear interpolation then visualised as
   *  the same stamps near the bottom of the ramp.
   *
   *  Algorithm: build mip levels 1..N by iterating the 5-tap DOWN kernel
   *  starting from level 0 itself. Each step is a small Gaussian
   *  downsample of the previous mip — σ adds in quadrature, so successive
   *  mips have monotonically increasing source-pixel σ. High-frequency
   *  content is already smoothed by the time we downsample, so blocks
   *  dissolve into a smooth gradient.
   *
   *  Cost: one DOWN pass per mip level on rapidly-shrinking images + matching
   *  blits. Every level is the REGION's, not the canvas's, so there is no rect to
   *  track and no guard band to erode — the whole level is valid because the whole
   *  level was written. A consumer whose deepest sample is LOD 0 (`maxLod <= 0`)
   *  gets no chain at all — see the first branch.
   *
   *  ORDER MATTERS AND IT IS NOT THE ORDER IT LOOKS LIKE. `EnsureMipLevels` below makes `out`
   *  mip-COMPLETE and mip-FILTERED before the DOWN chain reads that same texture as its source.
   *  That is safe only because every pass in this file names its LOD explicitly (see the note
   *  above DOWN_FRAG); under an implicit `texture()` the first hop's 2:1 minification resolves
   *  to the output's own mip 1, which has just been allocated empty. */
  GenerateOutputMipmap = (maxLod?: number): void => {
    const timed = this.Timers !== null && this.Timers.Begin('blur-mip');
    this._generateOutputMipmap(maxLod);
    if (timed) this.Timers!.End();
  };

  /** The chain itself. Separate from the bracket above so the timer wraps every exit of it --
   *  there are three -- without a `finally` on a path that runs sixty times a second. */
  private _generateOutputMipmap = (maxLod?: number): void => {
    const gl = this._gl;
    const out = this._levels[0];
    // Level chains are built by Blur, so there is nothing to build a mip chain OF until one
    // has run. Reaching here first is a caller ordering bug, not a state to tolerate.
    if (out === undefined) throw new Error('[Jaui] GenerateOutputMipmap before any Blur');

    // A consumer whose deepest sample is LOD 0 reads the base level and nothing
    // else. Building a chain for it is not a cheap chain, it is an entire chain
    // nobody opens: on the glass path the pyramid is built AT the panel's own
    // frost sigma, so `frostLod - u_BaseFrostLod` is 0 and the shader's whole
    // rim/refraction LOD boost is multiplied by a `frostReq` of 0
    // (Jiv.Panel.frag, `lodBoost`). Make the texture complete at the base level
    // and return — same pixels, none of the passes.
    if (maxLod !== undefined && maxLod <= 0) {
      out.DisableMipmap();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._target('default');
      return;
    }

    // Cap the chain at the consumer's max sampled LOD. Trilinear
    // interpolation between adjacent levels needs both endpoints populated,
    // so we add 1 level of slack. Without a cap (legacy callers) we walk
    // all the way to 1×1 — that matches the prior behaviour but on a
    // software rasterizer it's pure waste; passing a real maxLod here
    // typically halves this routine's fragment work.
    const stopLevel = maxLod !== undefined
      ? Math.min(MAX_LEVELS - 1, Math.max(1, Math.ceil(maxLod) + 1))
      : MAX_LEVELS - 1;

    // Allocate the mip chain + flip MIN_FILTER to LINEAR_MIPMAP_LINEAR so
    // textureLod can sample. Storage ONLY: every level a consumer can reach is
    // written by the DOWN chain below, so `generateMipmap`'s box filter was a
    // canvas-third of fill thrown away on the next line, and TEXTURE_MAX_LEVEL
    // clamps a sampler that reaches past what we build (it used to land on the
    // box-filtered deep mips instead).
    out.EnsureMipLevels(stopLevel);

    // Iterative 5-tap DOWN starting from level 0. _levels[1..N] are
    // re-purposed as scratch FBOs — their previous contents (dual-filter
    // intermediates from the Blur() call) are no longer needed.
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this._down.Program);
    gl.uniform1i(this._downTexLoc, 0);
    gl.uniform1f(this._downOffLoc, 1.0);
    this._setSrcRect(this._downSrcLoc, null, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this._quad.Vao);

    let srcTex = out.Texture;
    let srcW = out.Width;
    let srcH = out.Height;
    let extendedDepth = 0;
    for (let i = 1; i <= stopLevel; i++) {
      const newW = Math.max(1, Math.floor(srcW / 2));
      const newH = Math.max(1, Math.floor(srcH / 2));
      if (newW === srcW && newH === srcH) break; // already at 1×1
      this._levels[i].Resize(newW, newH);
      const dst = this._levels[i];
      this._bindTarget(dst, `mip${i}`);
      gl.uniform2f(this._downHpLoc, 0.5 / srcW, 0.5 / srcH);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      srcTex = dst.Texture;
      srcW = newW;
      srcH = newH;
      extendedDepth = i;
    }

    if (extendedDepth === 0) return;

    // Blit each generated level into the corresponding mip slot of the
    // output texture.
    if (!this._mipBlitFbo) {
      const fbo = gl.createFramebuffer();
      if (!fbo) throw new Error('[Jaui] Failed to create mip-blit FBO');
      this._mipBlitFbo = fbo;
    }
    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    // The key is saved beside the binding it names, so the restore below restores BOTH and the
    // next pass is judged against what is really bound rather than against the last mip level.
    const prevKey = this.Timers === null ? '' : this.Timers.Target;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._mipBlitFbo);
    if (this.Timers !== null) this.Timers.SetTarget(`${this.TimerTag}:mipblit`);
    for (let i = 1; i <= extendedDepth; i++) {
      const src = this._levels[i];
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.Texture, i);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.Framebuffer);
      gl.blitFramebuffer(
        0, 0, src.Width, src.Height,
        0, 0, src.Width, src.Height,
        gl.COLOR_BUFFER_BIT, gl.NEAREST,
      );
    }
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
    if (this.Timers !== null) this.Timers.SetTarget(prevKey);
  };

  // ── Region plumbing ───────────────────────────────────────────────────────

  /** The resident level chain whose level 0 is `w` x `h`, made active.
   *
   *  This exists because `Framebuffer.Resize` is a no-op at the same size and a full
   *  `texImage2D` reallocation at any other one — which also zeroes `_mipLevels` and orphans
   *  every mip above the base. One `_levels` array therefore assumes every caller of one
   *  BlurPass asks for the same level-0 size, and that assumption broke the moment the
   *  border-only overlay got a margin of its own: a glass card's FILL pipeline resolves to
   *  568x436 and its BORDER pipeline to 480x348, so a twenty-card grid alternated the two
   *  sizes forty times a frame, three levels each — 120 whole-texture reallocations per
   *  frame, measured at 2.45x the GPU-process time on win32 (3533 ms against 1447 ms) with
   *  the renderer thread flat, which is where driver and submission work shows up and fill
   *  work does not. `Framebuffer.Resize`'s own comment already records this thrash biting
   *  once before, through `checkFramebufferStatus`.
   *
   *  So sizes get a chain each, and nothing reallocates after the frame that introduced it.
   *  Bounded by LRU over `MAX_CHAINS` and `CHAIN_BUDGET_BYTES` — the chain just selected is
   *  never a candidate. The wrong fix is making the two margins equal again: the border-only
   *  margin is 24 px because a border-only fragment's only backdrop tap is the border zone's
   *  own inward `bUv`, and that saving is real. The chain has to tolerate more than one size.
   *
   *  KEYING ON THE SIZE IS ALSO WHY `?blur-chains=N` EXISTS. Twenty glass-grid cards share a
   *  472 px pitch, so every fill build resolves to 568x436 and every rim build to 480x348: two
   *  chains for forty builds a frame, each build overwriting the level textures the previous
   *  card's draw has just sampled. Under N > 1 the pool keeps N chains per size and hands them
   *  out ROUND-ROBIN per build, so build k of a size lands on slot k mod N and no two
   *  consecutive builds of that size share a chain. Nothing else about a build changes — same
   *  region, same sigma, same depth, same `k`, same passes, same `LastRegion` — and a chain's
   *  contents are per-build (every level a consumer can reach is written by the build that
   *  hands it over), so which chain a build lands on cannot change a texel.
   */
  private _useChain = (w: number, h: number): void => {
    const tick = ++this._tick;
    let slot = this._chainsLive === 1 ? 0 : this._nextSlot(w, h);
    let chain = this._findChain(w, h, slot);
    // Rotating asks for chains the pool never needed. If the next one cannot be resident
    // ALONGSIDE the ones already rotating, stop rotating and say so: an evicting pool
    // reallocates whole textures mid-frame, which is the thrash this function exists to
    // prevent and which would be read as this flag's own cost.
    if (chain === null && slot !== 0 && !this._chainFits(w, h)) {
      this._refuseChains(`no-room-for-${w}x${h}-slot-${slot}`);
      slot = 0;
      chain = this._findChain(w, h, slot);
    }
    if (chain !== null) {
      chain.Used = tick;
      this._levels = chain.Levels;
      return;
    }
    const levels: Framebuffer[] = [];
    for (let i = 0; i < MAX_LEVELS; i++) levels.push(new Framebuffer(this._gl, { highPrecision: true }));
    const fresh: LevelChain = { Levels: levels, W: w, H: h, Slot: slot, Bytes: ChainBytes(w, h), Used: tick };
    this._chains.push(fresh);
    this._levels = levels;
    this._evictChains(fresh);
  };

  private _findChain = (w: number, h: number, slot: number): LevelChain | null => {
    for (let i = 0; i < this._chains.length; i++) {
      const c = this._chains[i];
      if (c.W === w && c.H === h && c.Slot === slot) return c;
    }
    return null;
  };

  /** The round-robin phase for one level-0 size, advanced once per build. Cleared wholesale
   *  rather than pruned if a scene ever produces many times more distinct sizes than the pool
   *  could hold — restarting the phase costs a reading nothing, and an unbounded map on a
   *  resizing canvas would outlive the flag. */
  private _nextSlot = (w: number, h: number): number => {
    if (this._chainSeq.size > this._maxChains * 16) this._chainSeq.clear();
    const key = `${w}x${h}`;
    const seq = this._chainSeq.get(key) ?? 0;
    this._chainSeq.set(key, seq + 1);
    return seq % this._chainsLive;
  };

  /** Would one more chain of this size fit inside BOTH ceilings? Asked only of the extra
   *  chains a rotation introduces; slot 0 is the shipped pool and still evicts as it always
   *  did, because a pass with no chain at all cannot draw. */
  private _chainFits = (w: number, h: number): boolean => {
    if (this._chains.length + 1 > this._maxChains) return false;
    let total = ChainBytes(w, h);
    for (const c of this._chains) total += c.Bytes;
    return total <= this._budgetBytes;
  };

  /** Stop rotating, and name it on the trace. A reading taken under a refused N is a reading of
   *  a DIFFERENT pool than the URL asked for, so this line is the instruction to discard that
   *  cell — the alternative, evicting quietly, publishes reallocation thrash under this flag's
   *  name. Once per pass: the first refusal is the one that explains the rest. */
  private _refuseChains = (why: string): void => {
    if (this._chainRefusal !== null) return;
    this._chainRefusal = why;
    const running = this._chainsLive;
    this._chainsLive = 1;
    JTrace(`jaui:blur-chains tag=${this.TimerTag} armed=${this._chainCount} running=${running}`
      + ` effective=1 refused=${why} resident=${this._chains.length} max=${this._maxChains}`);
  };

  /** Drop least-recently-used chains until residency is back inside its ceiling. Never drops
   *  `keep` (the one about to be drawn into) and never drops the last chain standing. */
  private _evictChains = (keep: LevelChain): void => {
    let total = 0;
    for (const c of this._chains) total += c.Bytes;
    while (this._chains.length > 1
           && (this._chains.length > this._maxChains || total > this._budgetBytes)) {
      let lru: LevelChain | null = null;
      for (const c of this._chains) {
        if (c === keep) continue;
        if (lru === null || c.Used < lru.Used) lru = c;
      }
      if (lru === null) return;
      // The backstop for `_chainFits`: slot 0 can still evict, and under a rotation the chain
      // it takes may be one a later build of another size was about to land on. Any eviction
      // at all while rotating ends the rotation, for the same reason as above. A no-op when
      // nothing is rotating, which is every shipping path.
      if (this._chainsLive > 1) this._refuseChains(`evicted-${lru.W}x${lru.H}-slot-${lru.Slot}`);
      for (const fb of lru.Levels) fb.Dispose();
      total -= lru.Bytes;
      this._chains.splice(this._chains.indexOf(lru), 1);
    }
  };

  /** Bind a level and tell the driver its previous contents are dead.
   *
   *  Every pass covers its WHOLE destination, which is the other half of why the region matters:
   *  a tile-based GPU has to LOAD an attachment it might only partly overwrite, and
   *  `invalidateFramebuffer` is how WebGL2 says "don't" (ANGLE turns it into Metal's
   *  LoadAction.DontCare). ARM's bandwidth guidance names this as the cheapest win available on
   *  a deferred renderer. Safe precisely because the viewport is the full level and the quad
   *  covers all of it. */
  private _bindTarget = (fb: Framebuffer, key: string): void => {
    const gl = this._gl;
    fb.Bind();
    if (this.Timers !== null) this.Timers.SetTarget(`${this.TimerTag}:${key}`);
    gl.viewport(0, 0, fb.Width, fb.Height);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
  };

  /** Report the bound framebuffer to the pass timer. `default` is the unbound (swap chain) state,
   *  which every chain here leaves behind and which makes the next pass's boundary a hard one. */
  private _target = (key: string): void => {
    if (this.Timers !== null) this.Timers.SetTarget(key === 'default' ? 'default' : `${this.TimerTag}:${key}`);
  };

  /** `null` rect = read the whole source. The identity (0,0,1,1) reproduces the varying the
   *  vertex shader used to interpolate exactly, so a full-source pass is unchanged. */
  private _setSrcRect = (
    loc: WebGLUniformLocation | null, rect: RegionRect | null, srcW: number, srcH: number,
  ): void => {
    if (rect === null || rect.Full) { this._gl.uniform4f(loc, 0, 0, 1, 1); return; }
    this._gl.uniform4f(loc, rect.X / srcW, rect.YBottom / srcH, rect.W / srcW, rect.H / srcH);
  };

  private _region = (rect: RegionRect, scaleX: number, scaleY: number): BackdropRegion => {
    const texels = this._levels[0];
    if (rect.Full) {
      return { ...BACKDROP_REGION_FULL, TexelsX: texels.Width, TexelsY: texels.Height };
    }
    return {
      ScaleX: scaleX,
      ScaleY: scaleY,
      OffsetX: -rect.X / rect.W,
      OffsetY: -rect.YBottom / rect.H,
      TexelsX: texels.Width,
      TexelsY: texels.Height,
    };
  };

}
