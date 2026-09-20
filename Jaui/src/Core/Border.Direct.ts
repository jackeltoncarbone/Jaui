import {
  BaseDownsampleFactor, PyramidDepth, ResolveRegionRect,
  type BackdropRect, type RegionRect,
} from './BlurPass';

/**
 * THE GLASS BORDER'S BACKDROP, WITHOUT A PYRAMID.
 *
 * A glass card draws in two parts: the FILL (the frosted body) and the BORDER — the thin bright
 * edge where the Fresnel highlight lives, which `Jaui.ts` calls the rim and which draws as its own
 * `'GlassBorderOnly'` instance after the card's children. The border blurs what is behind it
 * exactly as the fill does, and because it draws AFTER the fill it needs its own build: today that
 * is a whole `k=1, depth=2, maxLod=0` backdrop pyramid per card, `Down 2 + Up 2` = four render
 * passes, ~69 us of encoder each on the M4. Twenty cards are eighty passes and ~5.2 ms per render
 * at dpr 2 — and the border READS a band a few device px wide.
 *
 * The area was never the cost; the passes were. So the border computes its blurred backdrop
 * DIRECTLY, in its own fragment shader, from one blit of the scene — with the pyramid's exact
 * effective kernel, which this file's admission rule is what pins down.
 *
 * ── WHY THE KERNEL IS CHEAP ENOUGH TO EVALUATE PER FRAGMENT ────────────────────────────────────
 *
 * `BlurPass`'s DOWN hop is `4*centre + the four half-pixel corners, / 8`, each tap bilinear. Write
 * the two bilinear weight pairs a corner tap lands on as `u = (0.5 - 0.5t, 0.5 + 0.5t)` and
 * `v = (0.5 + 0.5t, 0.5 - 0.5t)` for a tap offset `t`. The four corners are `u⊗u + v⊗v + v⊗u + u⊗v
 * = (u+v)⊗(u+v)`, and `u + v = (1, 1)` for every `t <= 1` — so the corners contribute exactly 1 per
 * texel, the centre (weight 4 at fraction exactly 0.5) contributes exactly 1, and the hop is a
 * 2x2 BOX. Two of them make level 2 a 4x4 box of the source, which a shader can gather in four
 * bilinear taps instead of reconstructing.
 *
 * Said exactly, because "exact" is a word this ledger has had to take back before: the identity is
 * ALGEBRAIC, and in floating point it holds to a ulp of the accumulation order (`1/16` comes out
 * `0.06249999999999999` in float64). That residual is ~1e-17 against the 1/1023 quantum each
 * pyramid level is STORED at, so it cannot survive to a texel; the pyramid's four 10-bit roundings
 * can, and do, which is the whole of the `<= 1/255` the direct path is measured under.
 *
 * That leaves the two UP hops, which are `textureLod` reconstructions on the level-2 and level-1
 * grids and are evaluated in the shader with the same expressions `BlurPass.UP_FRAG` uses. For
 * `t < 0.75` the support of one level-0 texel is 3 level-1 texels and 4 level-2 texels per axis —
 * a 4x4 level-2 window, 16 boxes, **64 bilinear taps**, against the 261,000 destination pixels the
 * pyramid shades to serve the same band. `tests/Border.Kernel.test.ts` derives all of this
 * numerically from a CPU port of the four hops and pins it.
 *
 * ── WHAT THE ADMISSION RULE IS FOR ─────────────────────────────────────────────────────────────
 *
 * Every clause below is a way that argument fails, and a refusal costs exactly today's path: the
 * rim builds its pyramid and draws as it always has. Nothing here degrades a picture; it either
 * computes the same kernel or it declines to.
 */

/** The only pyramid shape the direct path reproduces. `PyramidDepth(radius, 0) === 2` holds for
 *  `3 < radius <= 9` device px, which is where every glass class in the app lands (`JwiftGlass`
 *  authors `Blur(4pt)` — 8 device px at dpr 2, 6 at dpr 1.5, 4 at dpr 1). */
export const BORDER_DIRECT_DEPTH = 2;

/** `k * 2^depth` for the admitted shape — the grid `ResolveRegionRect` snaps the region to, and
 *  the size of one level-2 texel in source texels. */
export const BORDER_DIRECT_PHASE = 4;

/** The tap-offset ceiling, and it is a HARD bound rather than a taste.
 *
 *  Two things break above it. At `t > 1` the DOWN hop stops being an exact 2x2 box (the corner
 *  taps cross out of the texel pair, so `u + v` is no longer `(1, 1)`). And at `t >= 0.75` the
 *  UP hop from level 1 reaches a FOURTH level-1 texel — `floor(x1 + t - 0.5) + 1` steps past
 *  `base + 2` on an odd destination — which widens the level-2 window from 4 to 5 and the gather
 *  from 64 taps to 100. `t` is `max(0.7, radius / 12)` at depth 2, so this admits `radius < 9`. */
export const BORDER_DIRECT_MAX_TAP_OFFSET = 0.75;

/** The level-1 window one level-0 texel reads, per axis. Pinned by `tests/Border.Kernel.test.ts`. */
export const BORDER_DIRECT_L1_WINDOW = 3;

/** The level-2 window one level-0 texel reads, per axis. Pinned by the same test. */
export const BORDER_DIRECT_L2_WINDOW = 4;

/** `BlurPass.Blur`'s own tap offset, for the admitted `(radius, depth)`. Exported and duplicated
 *  from nowhere: it is the same expression, and a copy that could disagree with the pass it is
 *  planning for is exactly the bug `BaseDownsampleFactor`'s module-scope comment warns about — so
 *  the test asserts this against the source of `BlurPass.Blur`. */
export const BorderDirectTapOffset = (radius: number, depth: number): number => {
  const baseSigma = 3 * Math.pow(2, depth);
  return Math.max(0.7, Math.min(1.3, Math.max(1, radius) / baseSigma));
};

/** An admitted border: the rect the scene is copied over, and the tap offset its kernel runs at. */
export interface BorderDirectPlan {
  Ok: true;
  /** What `ResolveRegionRect` returns for this border's own region — the SAME function, with the
   *  same phase, that `Blur` would have called. The copy holds exactly these texels and clamps at
   *  exactly this rect's border, which is what the pyramid's CLAMP_TO_EDGE gave it. */
  Rect: RegionRect;
  TapOffset: number;
}

export interface BorderDirectRefusal { Ok: false; Why: string }

/**
 * Can this border's backdrop be computed directly, on the same kernel?
 *
 * `maxLod` is the rim's own `GlassBlurPlan.MaxLod`. At 0 the pyramid calls `DisableMipmap`, so
 * `textureLod(u_Backdrop, uv, anyLod)` resolves to level 0 whatever the fragment's `bLod` works out
 * to — which is what lets the direct path ignore the LOD entirely. Above 0 the border samples a
 * mip and there is nothing to reproduce.
 */
export const PlanBorderDirect = (
  region: BackdropRect | undefined, width: number, height: number, radius: number, maxLod: number,
): BorderDirectPlan | BorderDirectRefusal => {
  if (region === undefined) return { Ok: false, Why: 'full-canvas' };
  if (!(radius > 0)) return { Ok: false, Why: 'sharp-root' };
  if (maxLod > 0) return { Ok: false, Why: 'mip-consumer' };
  const k = BaseDownsampleFactor(radius, width, height, region);
  if (k !== 1) return { Ok: false, Why: `pre-downsample-k${k}` };
  const depth = PyramidDepth(radius, 0);
  if (depth !== BORDER_DIRECT_DEPTH) return { Ok: false, Why: `depth${depth}` };
  const tapOffset = BorderDirectTapOffset(radius, depth);
  if (!(tapOffset < BORDER_DIRECT_MAX_TAP_OFFSET)) {
    return { Ok: false, Why: `tap-offset-${tapOffset}` };
  }
  const rect = ResolveRegionRect(region, width, height, BORDER_DIRECT_PHASE);
  // The extent rounds UP to the phase and then CLAMPS to the canvas, and at the canvas edge that
  // clamp can hand back an extent that is not a multiple of 4. Then `floor(W/2)` stops being `W/2`,
  // the level grids drift by a sub-texel the gather has no way to follow, and the crop argument is
  // gone — the same clause `PlanBackdropUnion` refuses on, for the same reason.
  if (rect.W % BORDER_DIRECT_PHASE !== 0 || rect.H % BORDER_DIRECT_PHASE !== 0) {
    return { Ok: false, Why: `clamped-rect-${rect.W}x${rect.H}` };
  }
  // A full-canvas rect is the shared backdrop's shape, not a border's, and its `BackdropRegion`
  // is the identity rather than the map the gather inverts.
  if (rect.Full) return { Ok: false, Why: 'full-rect' };
  return { Ok: true, Rect: rect, TapOffset: tapOffset };
};
