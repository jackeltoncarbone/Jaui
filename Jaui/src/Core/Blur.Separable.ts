/**
 * THE PER-SURFACE GLASS BLUR AS THE FIELD BUILDS IT: downsample by SIGMA, then ONE separable
 * Gaussian pair. Pure arithmetic; `BlurPass._blurSeparable` issues the passes.
 *
 * Skia, Impeller and Apple converge on the same shape for a backdrop blur: pick a resolution from
 * the sigma (Impeller: `sigma <= 4 -> scale 1`, else `4 / sigma` rounded to a power of two; Apple
 * captures at quarter scale), then run a linear-sampled separable Gaussian at the RESIDUAL sigma.
 * The dual-filter chain this replaces pays `log2(k) + 2 * depth` passes for a kernel that is a
 * four-step staircase beating with period `2^depth` (`Perf/BlurGaussian.Finding.md`); this plan
 * pays `log2(k) + 2` for a Gaussian.
 *
 * THE SIGMA IT RUNS AT is today's DELIVERED sigma by default, not the authored radius. The chain
 * delivers 2.80 device px at an authored 8 (35%), and every picture Jack has ruled on is that
 * width; `?blur-sigma=authored` is the ~2.9x wider blur the sheet literally asks for. The delivered
 * sigma is MEASURED here from the chain's own operator (`ChainDeliveredSigma`), for every
 * `(k, depth, tapOffset)` the chain can take, not assumed from the one card the constant
 * `GAUSS_MATCH_SIGMA` was fitted at.
 *
 * k COMES FROM THE SIGMA ALONE, by Impeller's rule: 1 at sigma <= 4, else `4 / sigma` ROUNDED to a
 * power of two (`k = 2^round(log2(sigma / 4))`, clamped to `[1, 8]`), so the residual sigma on the
 * base is at least `2 sqrt 2` = 2.83 base texels. No area gate: the 15%-of-canvas clause is a cost
 * heuristic from before sampling was known to be the cost, and it is the reason a phone's
 * full-width bar started at full resolution.
 *
 * ROUND, NOT FLOOR, and the choice is measured (`tests/Blur.Separable.test.ts`). `floor` keeps the
 * residual at 4 or more: a beat of 5% at k = 2, PSNR 50 dB against the ideal Gaussian. `round` lets
 * it fall to 2.83: 11-18%, 40-47 dB. Today's chain is 63-74% and 27-37 dB, so both are several
 * times the quality that ships. What decides it is the texels: at dpr 3 a glass card's delivered
 * sigma is 5.74, which `floor` leaves at k = 1 with a 19-fetch pair over the whole region -- 3.2x
 * the chain's bilinear reads, on the machine where reads were measured to be the price (+0.57 ms
 * for 1.94x) -- while `round` takes it to k = 2 with 11 fetches on a quarter of the texels, fewer
 * reads than the chain. `?blur-k=floor` is the higher-quality arm, one flag away.
 */

/** Fetches ONE 1D Gaussian pass may issue, and therefore the size of the two uniform arrays.
 *
 *  64 fetches is `ceil(3 * sigma) <= 62`, i.e. sigma up to 20.67 SOURCE texels. A kernel that needs
 *  more is REFUSED by name and the build takes the chain, rather than silently running a truncated
 *  Gaussian: a clipped kernel is a different blur wearing this plan's number. */
export const GAUSS_MAX_FETCHES = 64;

/** A 1D Gaussian reduced to bilinear fetches. `Offsets` and `Weights` are `GAUSS_MAX_FETCHES`
 *  long whatever `Fetches` says, ZERO past `Fetches`, and uploaded WHOLE (`BlurPass`'s upload note
 *  says why), so no driver ever holds a tail it did not get from this table. */
export interface GaussianKernel {
  /** The Gaussian's PARAMETER, in SOURCE texels. For a solved kernel this is not the kernel's own
   *  second moment -- see `SolveSeparableKernel`. */
  Sigma: number;
  /** The furthest texel the kernel reads, and the temp's padding. `ceil(3 * sigma)` unless a
   *  caller fixed it. */
  Radius: number;
  /** `2 * Radius + 1`: the DISCRETE taps a naive convolution would take. */
  Taps: number;
  /** `1 + 2 * ceil(Radius / 2)`: the bilinear fetches this kernel actually issues. */
  Fetches: number;
  Offsets: Float32Array;
  Weights: Float32Array;
}

/**
 * The linear-sampled Gaussian at parameter `sigma`, truncated at `radius` texels (Rakos, rastergrid
 * 2010). Texel 0 is fetched alone; texels are PAIRED outward `(1,2), (3,4), ...`, a pair being one
 * bilinear fetch at `o = (i*w_i + (i+1)*w_{i+1}) / (w_i + w_{i+1})` weighted `w_i + w_{i+1}`. An odd
 * `radius` leaves the outermost texel unpaired, fetched on its own centre. The weights are a
 * partition of the normalised discrete kernel, so they sum to 1 and each pass is a convex
 * combination -- which is what makes an RGB10_A2 intermediate safe.
 */
export const GaussianKernelWith = (sigma: number, radius: number): GaussianKernel => {
  if (!(sigma > 0)) throw new Error(`[Jaui] a Gaussian kernel needs sigma > 0, got ${sigma}`);
  if (!Number.isInteger(radius) || radius < 1) {
    throw new Error(`[Jaui] a Gaussian kernel needs an integer radius >= 1, got ${radius}`);
  }
  const R = radius;
  const w: number[] = [];
  let total = 0;
  for (let i = 0; i <= R; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    w.push(v);
    total += i === 0 ? v : 2 * v;
  }
  for (let i = 0; i <= R; i++) w[i] /= total;

  const offsets = new Float32Array(GAUSS_MAX_FETCHES);
  const weights = new Float32Array(GAUSS_MAX_FETCHES);
  let n = 0;
  offsets[n] = 0; weights[n] = w[0]; n++;
  for (let i = 1; i <= R; i += 2) {
    const pair = i + 1 <= R;
    const wt = pair ? w[i] + w[i + 1] : w[i];
    const off = pair ? (i * w[i] + (i + 1) * w[i + 1]) / wt : i;
    offsets[n] = off; weights[n] = wt; n++;
    offsets[n] = -off; weights[n] = wt; n++;
  }
  return { Sigma: sigma, Radius: R, Taps: 2 * R + 1, Fetches: n, Offsets: offsets, Weights: weights };
};

/** The fetches a kernel of `radius` issues. */
export const FetchesForRadius = (radius: number): number => 1 + 2 * Math.ceil(radius / 2);

/** `?blur-fetches=<n>`: the radius that makes a kernel issue EXACTLY `n` fetches. Odd `n` only
 *  (a centre fetch plus mirrored pairs), and inside the uniform table. Throws by name otherwise:
 *  an instrument that quietly rounded would price a count nobody asked for. */
export const RadiusForFetches = (n: number): number => {
  if (!Number.isInteger(n) || n < 3 || n > GAUSS_MAX_FETCHES - 1 || n % 2 === 0) {
    throw new Error(`[Jaui] ?blur-fetches takes an ODD integer in 3..${GAUSS_MAX_FETCHES - 1}, got ${n}`);
  }
  return n - 1;
};

// ── THE 1D OPERATOR PORTS ─────────────────────────────────────────────────────────────────────
//
// Both plans are measured by ONE instrument so "delivered" means the same thing on each side. The
// quantity is `ChainKernel1D`'s (`tests/Gaussian.Kernel.Source.ts`): the x-MARGINAL of the 2D
// operator (a y-constant input makes the output's x-profile exactly the marginal), and because the
// operator is shift-variant, the ROOT OF THE MEAN over one period of each output phase's second
// CENTRAL moment. The marginals of the two dual-filter kernels, read off `DOWN_FRAG` / `UP_FRAG`
// tap by tap (the diagonal taps' x offsets pair up):
//
//     DOWN   (4 L(x) + 2 L(x - h) + 2 L(x + h)) / 8                           h = 0.5 t source texels
//     UP     (L(x - 2h) + L(x + 2h) + 2 L(x) + 4 L(x - h) + 4 L(x + h)) / 12
//
// with `L` GL's bilinear under CLAMP_TO_EDGE. The consumer's read of a level 0 at `1/k` is the
// bilinear magnification `L(level0, (i + 0.5) / k)`, identity at k = 1.

const L1 = (s: Float64Array, x: number): number => {
  const f = x - 0.5;
  const i0 = Math.floor(f);
  const a = f - i0;
  const n = s.length;
  const g0 = s[i0 < 0 ? 0 : i0 >= n ? n - 1 : i0];
  const i1 = i0 + 1;
  const g1 = s[i1 < 0 ? 0 : i1 >= n ? n - 1 : i1];
  return g0 * (1 - a) + g1 * a;
};

const Down1 = (s: Float64Array, t: number): Float64Array => {
  const n = Math.max(1, Math.floor(s.length / 2));
  const o = new Float64Array(n);
  const h = 0.5 * t;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * (s.length / n);
    o[i] = (4 * L1(s, x) + 2 * L1(s, x - h) + 2 * L1(s, x + h)) / 8;
  }
  return o;
};

const Up1 = (s: Float64Array, dn: number, t: number): Float64Array => {
  const o = new Float64Array(dn);
  const h = 0.5 * t;
  const W = s.length;
  for (let i = 0; i < dn; i++) {
    const x = ((i + 0.5) / dn) * W;
    o[i] = (L1(s, x - 2 * h) + L1(s, x + 2 * h) + 2 * L1(s, x) + 4 * L1(s, x - h) + 4 * L1(s, x + h)) / 12;
  }
  return o;
};

const Consume1 = (base: Float64Array, n: number): Float64Array => {
  if (base.length === n) return base;
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = L1(base, ((i + 0.5) / n) * base.length);
  return o;
};

/** Today's chain on a 1D signal, region-local, with the consumer's read: `log2(k)` pre-downsample
 *  hops at `u_Offset` 1.0 (what `Blur` issues outside `?glass-presample`), `depth` DOWN and `depth`
 *  UP hops at `t`, then the consumer's bilinear back to device px. */
export const ChainOperator1D = (s: Float64Array, k: number, depth: number, t: number): Float64Array => {
  let cur = s;
  for (let q = k; q > 1; q >>= 1) cur = Down1(cur, 1.0);
  const lens: number[] = [cur.length];
  for (let i = 1; i <= depth; i++) { cur = Down1(cur, t); lens.push(cur.length); }
  for (let i = depth - 1; i >= 0; i--) cur = Up1(cur, lens[i], t);
  return Consume1(cur, s.length);
};

/** This plan on a 1D signal: `log2(k)` exact 2x2-box hops, the fetch table (Rakos pairs are exact
 *  in 1D, so this IS the discrete kernel), then the consumer's bilinear back to device px. */
export const SeparableOperator1D = (s: Float64Array, k: number, kernel: GaussianKernel): Float64Array => {
  let cur = s;
  for (let q = k; q > 1; q >>= 1) cur = Down1(cur, 1.0);
  const g = new Float64Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    let a = 0;
    for (let f = 0; f < kernel.Fetches; f++) a += L1(cur, i + 0.5 + kernel.Offsets[f]) * kernel.Weights[f];
    g[i] = a;
  }
  return Consume1(g, s.length);
};

/**
 * The delivered sigma of a 1D operator with period `period`, in device px, WITHOUT impulse
 * responses: two runs of the operator on a centred LINE and a centred PARABOLA give every output's
 * kernel mean and second moment at once, because the kernel at output `n` is `K_n(d) = M[n, n - d]`
 * and, with mass 1,
 *
 *     y1[n] = sum_d K_n(d) (n - d)      = n - mu_n
 *     y2[n] = sum_d K_n(d) (n - d)^2    = n^2 - 2 n mu_n + s_n
 *
 * so `var_n = s_n - mu_n^2`, averaged over one period in the middle of a window wide enough that no
 * kernel there reaches the clamped ends. `reach` is that support bound, in device px.
 */
export const OperatorSigma1D = (
  op: (s: Float64Array) => Float64Array, period: number, reach: number,
): number => {
  const margin = Math.ceil((reach + 8) / period) * period * 2;
  const N = margin * 2 + period;
  const c = margin;
  const lin = new Float64Array(N), par = new Float64Array(N);
  for (let m = 0; m < N; m++) { const x = m - c; lin[m] = x; par[m] = x * x; }
  const y1 = op(lin), y2 = op(par);
  let v = 0;
  for (let n = c; n < c + period; n++) {
    const x = n - c;
    const mu = x - y1[n];
    const s2 = y2[n] - x * x + 2 * x * mu;
    v += s2 - mu * mu;
  }
  return Math.sqrt(v / period);
};

const _chainSigmaCache = new Map<string, number>();

/**
 * THE SIGMA TODAY'S CHAIN DELIVERS, in device px, for a build at `(k, depth, tapOffset)`. Measured
 * on the chain's own operator, memoised per shape (a page has a handful). `(1, 2, 0.7)` is
 * `GAUSS_MATCH_SIGMA`, 2.798809271, and the tests pin the two against each other and against
 * `ChainKernel1D`'s impulse-response recovery.
 */
export const ChainDeliveredSigma = (k: number, depth: number, tapOffset: number): number => {
  const key = `${k}/${depth}/${tapOffset}`;
  const hit = _chainSigmaCache.get(key);
  if (hit !== undefined) return hit;
  const period = k * (1 << depth);
  // The chain's support is bounded by its coarsest level's taps: ~2 texels of level `depth` each
  // way on the down side and again on the up side, in device px.
  const reach = 4 * period + 16;
  const s = OperatorSigma1D((x) => ChainOperator1D(x, k, depth, tapOffset), period, reach);
  _chainSigmaCache.set(key, s);
  return s;
};

/** The sigma this plan's build delivers, in device px, measured by the SAME instrument. */
export const SeparableDeliveredSigma = (k: number, kernel: GaussianKernel): number =>
  OperatorSigma1D((x) => SeparableOperator1D(x, k, kernel), k, k * (kernel.Radius + 2) + 2 * k);

/** The sigma a base texel stands for, `Blur`'s `BASE_SIGMA`; the whole scale rule is in its units. */
export const SEPARABLE_BASE_SIGMA = 4;
export const SEPARABLE_K_MAX = 8;

/** `?blur-k`: how `log2(sigma / 4)` becomes a power of two. `round` is Impeller's and the default. */
export type SeparableKRule = 'round' | 'floor';

/** k from the sigma ALONE: 1 at sigma <= 4, else `clamp(2^rule(log2(sigma / 4)), 1, 8)`. */
export const SeparableKFor = (sigma: number, rule: SeparableKRule = 'round'): number => {
  if (!(sigma > SEPARABLE_BASE_SIGMA)) return 1;
  const e = Math.log2(sigma / SEPARABLE_BASE_SIGMA);
  const n = rule === 'round' ? Math.round(e) : Math.floor(e);
  return Math.max(1, Math.min(SEPARABLE_K_MAX, 1 << Math.max(0, n)));
};

const _solveCache = new Map<string, GaussianKernel>();

/**
 * The kernel whose WHOLE build -- `log2(k)` box hops, this table, the consumer's bilinear --
 * delivers exactly `target` device px, at a fixed `radius` on the base.
 *
 * Why solved rather than written `GaussianKernelFor(target / k)`: a Gaussian truncated at 3 sigma
 * and renormalised has a SMALLER second moment than its parameter (2.787 for a 2.799 parameter),
 * and at k > 1 the box hops and the consumer's bilinear ADD variance. Either way the build would
 * deliver a different width than the one it was asked to match. The delivered sigma is monotone in
 * the parameter, so bisection on it converges; memoised per `(target, k, radius)`.
 */
export const SolveSeparableKernel = (target: number, k: number, radius: number): GaussianKernel => {
  const key = `${target}/${k}/${radius}`;
  const hit = _solveCache.get(key);
  if (hit !== undefined) return hit;
  const res = target / k;
  let lo = res * 0.5, hi = res * 2;
  let best = GaussianKernelWith(res, radius);
  for (let it = 0; it < 48; it++) {
    const mid = (lo + hi) / 2;
    const kern = GaussianKernelWith(mid, radius);
    const d = SeparableDeliveredSigma(k, kern);
    best = kern;
    if (d < target) lo = mid; else hi = mid;
    if (hi - lo < 1e-9 * res) break;
  }
  _solveCache.set(key, best);
  return best;
};

/** `?blur-sigma`: which width the plan runs at. */
export type SeparableSigma = 'delivered' | 'authored';

/** What the walk asks of ONE per-surface build. */
export interface SeparableRequest {
  Sigma: SeparableSigma;
  /** `?blur-fetches=<n>`, or null for the kernel's own `ceil(3 sigma)` radius. */
  Fetches: number | null;
  /** `?blur-k=round|floor`; absent is `round`. */
  KRule?: SeparableKRule;
}

export interface SeparablePlan {
  Ok: true;
  K: number;
  /** The authored radius, device px -- what the sheet asked for. */
  SigmaAuthored: number;
  /** The chain's delivered sigma at this build's `(k, depth, t)`, device px. */
  SigmaDelivered: number;
  /** What this build runs at: `SigmaDelivered` or, under `authored`, `SigmaAuthored`. */
  SigmaTarget: number;
  /** `SigmaTarget / k`: the sigma the pair runs at on the base, in BASE texels. */
  SigmaResidual: number;
  Kernel: GaussianKernel;
  /** `log2(k) + 2`. */
  Passes: number;
}
export interface SeparableRefusal { Ok: false; Why: string }

/**
 * May THIS per-surface build run as a separable pair, and at what k and kernel? `kChain`, `depth`
 * and `tapOffset` are what the chain would have run, because the delivered sigma is the chain's.
 * Every refusal is NAMED and the build takes the chain -- the control picture.
 */
export const PlanSeparable = (
  radius: number, kChain: number, depth: number, tapOffset: number, req: SeparableRequest,
): SeparablePlan | SeparableRefusal => {
  if (!(radius > 0)) return { Ok: false, Why: 'sharp-root' };
  const delivered = ChainDeliveredSigma(kChain, depth, tapOffset);
  const target = req.Sigma === 'authored' ? radius : delivered;
  const k = SeparableKFor(target, req.KRule ?? 'round');
  const residual = target / k;
  const R = req.Fetches !== null ? RadiusForFetches(req.Fetches) : Math.ceil(3 * residual);
  if (FetchesForRadius(R) > GAUSS_MAX_FETCHES) {
    return { Ok: false, Why: `kernel-${FetchesForRadius(R)}-fetches-over-${GAUSS_MAX_FETCHES}` };
  }
  const kernel = SolveSeparableKernel(target, k, R);
  return {
    Ok: true, K: k, SigmaAuthored: radius, SigmaDelivered: delivered, SigmaTarget: target,
    SigmaResidual: residual, Kernel: kernel, Passes: Math.round(Math.log2(k)) + 2,
  };
};

/** The targets ONE separable build draws, in the order it draws them, with what each writes and
 *  reads. The rect is the CHAIN's resolved rect (so the consumer's map is the chain's), extended
 *  up to a multiple of k so the base grid is exact, and padded by the kernel radius on the base.
 *
 *    k = 1   H  scene -> temp  W x (H + 2R)       V  temp -> level 0  W x H
 *    k > 1   hop s  (Pw / 2^s) x (Ph / 2^s)  for s = 1..log2 k, the first reading the scene
 *            H  base -> temp  bw x (bh + 2R)      V  temp -> level 0  bw x bh
 *
 *  `Pw = (bw + 2R) k`: the padded region in SCENE px, so every horizontal tap of H and vertical tap
 *  of V lands on a real downsampled scene texel rather than on a clamped edge. */
export interface SeparableTargets {
  /** Level 0's size: `bw x bh`, which is `ceil(W/k) x ceil(H/k)`. */
  Bw: number;
  Bh: number;
  /** The screen rect level 0 stands for: the chain's rect grown to `bw * k x bh * k`. */
  Wk: number;
  Hk: number;
  /** Where the padded region starts in the scene, bottom-origin; may be negative (the sampler
   *  clamps), exactly `PlanGaussianTemp`'s edge law. */
  X0: number;
  Y0: number;
  /** Down-hop destination sizes, first to last (empty at k = 1). */
  Hops: { W: number; H: number }[];
  TempW: number;
  TempH: number;
  /** Destination px written and bilinear fetches issued by the whole build. */
  Fill: number;
  Reads: number;
}

/** DOWN_FRAG's five bilinear taps. */
const DOWN_TAPS = 5;

export const PlanSeparableTargets = (
  rect: { X: number; YBottom: number; W: number; H: number }, k: number, kernel: GaussianKernel,
): SeparableTargets => {
  const R = kernel.Radius;
  const bw = Math.ceil(rect.W / k), bh = Math.ceil(rect.H / k);
  const hops: { W: number; H: number }[] = [];
  let fill = 0, reads = 0;
  if (k > 1) {
    let w = (bw + 2 * R) * k, h = (bh + 2 * R) * k;
    for (let q = k; q > 1; q >>= 1) {
      w /= 2; h /= 2;
      hops.push({ W: w, H: h });
      fill += w * h;
      reads += w * h * DOWN_TAPS;
    }
  }
  const tempW = bw, tempH = bh + 2 * R;
  fill += tempW * tempH + bw * bh;
  reads += (tempW * tempH + bw * bh) * kernel.Fetches;
  return {
    Bw: bw, Bh: bh, Wk: bw * k, Hk: bh * k,
    X0: rect.X - (k > 1 ? R * k : 0),
    Y0: rect.YBottom - R * k,
    Hops: hops, TempW: tempW, TempH: tempH, Fill: fill, Reads: reads,
  };
};

/** The chain's own passes, fill and reads for a build at `(k, depth)` over `w x h`: the same
 *  `Math.floor` halvings `Blur` allocates, 5 taps per DOWN, 8 per UP. The control arm's side of the
 *  census, in the same currency. */
export const ChainCost = (w: number, h: number, k: number, depth: number): {
  Passes: number; Fill: number; Reads: number;
} => {
  let cw = w, ch = h, fill = 0, reads = 0, passes = 0;
  for (let s = k; s > 1; s >>= 1) {
    cw = Math.max(1, Math.floor(cw / 2)); ch = Math.max(1, Math.floor(ch / 2));
    fill += cw * ch; reads += cw * ch * DOWN_TAPS; passes++;
  }
  const lw: number[] = [cw], lh: number[] = [ch];
  for (let i = 1; i <= depth; i++) {
    cw = Math.max(1, Math.floor(cw / 2)); ch = Math.max(1, Math.floor(ch / 2));
    lw.push(cw); lh.push(ch);
  }
  for (let i = 1; i <= depth; i++) { fill += lw[i] * lh[i]; reads += lw[i] * lh[i] * DOWN_TAPS; passes++; }
  for (let i = depth - 1; i >= 0; i--) { fill += lw[i] * lh[i]; reads += lw[i] * lh[i] * 8; passes++; }
  return { Passes: passes, Fill: fill, Reads: reads };
};
