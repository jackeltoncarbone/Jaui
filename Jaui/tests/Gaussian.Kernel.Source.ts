/**
 * A CPU PORT OF THE TWO GAUSSIAN PASSES, AND OF THE CHAIN THEY REPLACE, for two questions:
 * what sigma is today's chain actually delivering, and what does the swap do to the picture?
 *
 * The template is `Presample.Kernel.Source.ts` -- the presample lane's port of the same hops --
 * and this file IMPORTS its `Down` / `Up` / `Consume` / `Tap` rather than re-deriving them, so
 * "today's chain" here is the same model that lane measured against. What is new is the Gaussian
 * arm, and it models the SHIPPED table: `GaussianKernelFor` is imported from `Core/BlurPass.ts`,
 * not re-written, because a prediction for a kernel nobody ships is not a prediction.
 *
 * WHAT IT MODELS, exactly: the H pass over a tall rect of the source with a bilinear fetch per
 * table entry, and the V pass over the temp with the same table on the other axis, in float64.
 * The temp's vertical padding and the V pass's row offset are the ones `_blurGaussian` computes.
 *
 * WHAT IT DOES NOT MODEL, said plainly: fp32 rounding, the RGB10_A2 store between the two passes
 * (and between the chain's levels), and the GPU's own quantisation of the bilinear weight -- the
 * last of which is the one place a linear-sampled Gaussian differs from its own discrete kernel
 * in practice (Rakos names it; a GPU that interpolates at 8 bits of subtexel places the pair's
 * weight on a 1/256 grid). It answers what the two KERNELS are, which is the picture question.
 */

import { GaussianKernelFor, type GaussianKernel } from '../src/Core/BlurPass';
import { Tap, Down, Up, Consume, type KernelImage } from './Presample.Kernel.Source';

export { Tap, Down, Up, Consume };
export type { KernelImage };

/** ONE 1D pass of the shipped table along `axis`, into a destination the source's own size minus
 *  whatever the caller trims. `x0` / `y0` are where destination pixel (0,0) sits in the SOURCE, in
 *  texels -- integers, which is the whole of the exactness argument: the engine's `u_SrcRect`
 *  makes the source->destination map an identity plus an integer translation, so every fetch
 *  lands on `source texel centre + table offset` with no resample under it. */
export const Pass1D = (
  src: Float64Array, sw: number, sh: number,
  x0: number, y0: number, dw: number, dh: number,
  k: GaussianKernel, axis: 'x' | 'y',
): KernelImage => {
  const out = new Float64Array(dw * dh);
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      const cx = x0 + i + 0.5, cy = y0 + j + 0.5;
      let s = 0;
      for (let f = 0; f < k.Fetches; f++) {
        const o = k.Offsets[f];
        s += Tap(src, sw, sh, axis === 'x' ? cx + o : cx, axis === 'y' ? cy + o : cy) * k.Weights[f];
      }
      out[j * dw + i] = s;
    }
  }
  return { Data: out, W: dw, H: dh };
};

/** THE ARM: `_blurGaussian` on the CPU. `src` is the SCENE (`sw` x `sh`); the rect is the
 *  region the build is allocated to, with `ry` counted from the TOP here because the port works
 *  in image order -- the engine counts it from the bottom and the two are the same rect.
 *
 *  Returns level 0, which is what the consumer's single bilinear tap reads at 1:1. */
export const GaussArm = (
  src: Float64Array, sw: number, sh: number,
  rx: number, ry: number, rw: number, rh: number, sigma: number,
): { Out: Float64Array; Temp: KernelImage; Kernel: GaussianKernel } => {
  const k = GaussianKernelFor(sigma);
  const y0 = Math.max(0, ry - k.Radius);
  const y1 = Math.min(sh, ry + rh + k.Radius);
  const tempH = y1 - y0;
  const padTop = ry - y0;
  const temp = Pass1D(src, sw, sh, rx, y0, rw, tempH, k, 'x');
  const l0 = Pass1D(temp.Data, rw, tempH, 0, padTop, rw, rh, k, 'y');
  return { Out: l0.Data, Temp: temp, Kernel: k };
};

/** TODAY: the dual-filter chain over the same rect, region-local (which is what `u_SrcRect`
 *  makes the first DOWN hop, exactly as `Presample.Kernel.Source.ArmK1` argues). Region-local
 *  means the chain's taps CLAMP at the rect's border, which is the one place the two arms differ
 *  structurally rather than in kernel: the Gaussian's H pass reads the live scene past the rect. */
export const ChainArm = (
  src: Float64Array, sw: number, sh: number,
  rx: number, ry: number, rw: number, rh: number, t: number,
): Float64Array => {
  const region = new Float64Array(rw * rh);
  for (let j = 0; j < rh; j++) {
    for (let i = 0; i < rw; i++) {
      region[j * rw + i] = Tap(src, sw, sh, rx + i + 0.5, ry + j + 0.5);
    }
  }
  const l1 = Down(region, rw, rh, t);
  const l2 = Down(l1.Data, l1.W, l1.H, t);
  const mid = Up(l2.Data, l2.W, l2.H, l1.W, l1.H, t);
  const l0 = Up(mid.Data, mid.W, mid.H, rw, rh, t);
  return Consume(l0.Data, rw, rh, rw, rh).Data;
};

// ── WHAT SIGMA THE CHAIN IS ACTUALLY RUNNING AT ───────────────────────────────────────────────
//
// The dual filter is not calibrated in sigma. `PyramidDepth` picks a depth off `3 * (2^d - 1)`
// and the tap offset trims inside it -- and at a card's radius the offset is PINNED by its own
// 0.7 floor, so the chain runs at whatever four hops at t = 0.7 and depth 2 produce. Measuring
// that is a question about the operator's impulse response, and the operator is SHIFT-VARIANT:
// every DOWN halves, so the whole chain is periodic with period `2^depth = 4` and there are four
// distinct 1D kernels, one per output phase.
//
// The method, and why it is a 1D reading of a 2D kernel. The DOWN stencil is `4*delta (x) delta
// + Kx (x) Ky` -- a SUM of two separable terms, so the chain's 2D kernel is not separable and
// cannot be read off one row. But the quantity being fitted is the sigma of a SEPARABLE Gaussian,
// and a separable kernel's behaviour against a vertical edge is exactly its x-MARGINAL. So the
// input is a delta COLUMN (constant in y), which makes the output's x-profile the x-marginal of
// the 2D kernel by construction, integrated over y with no approximation.
//
// Shift-variance is then handled by linearity rather than by averaging over it: `spread_c(q)` is
// the response at output column q to a delta column at input c, i.e. `M[q, c]`. The KERNEL at
// output q is `kernel_q(d) = M[q, q - d]`, so it is assembled from the four spreads at
// `c = (q - d) mod 4`. Four runs, exact, no fit inside the measurement.

/** `M[q, c]` for `c = 0..3` (mod 4) -- the four spread functions, as full output rows. */
const ChainSpreads1D = (W: number, H: number, t: number, centre: number): Float64Array[] => {
  const out: Float64Array[] = [];
  for (let phase = 0; phase < 4; phase++) {
    const img = new Float64Array(W * H);
    const c = centre + phase;
    for (let j = 0; j < H; j++) img[j * W + c] = 1;
    const l1 = Down(img, W, H, t);
    const l2 = Down(l1.Data, l1.W, l1.H, t);
    const mid = Up(l2.Data, l2.W, l2.H, l1.W, l1.H, t);
    const l0 = Up(mid.Data, mid.W, mid.H, W, H, t);
    const row = new Float64Array(W);
    const j = H >> 1;
    for (let i = 0; i < W; i++) row[i] = l0.Data[j * W + i];
    out.push(row);
  }
  return out;
};

export interface ChainKernelFit {
  /** One kernel per output phase, as `[offset, weight]` pairs over `-reach..reach`. */
  Kernels: Float64Array[];
  /** `sqrt(second central moment)` of each phase's kernel. */
  SigmaPerPhase: number[];
  /** The sigma a single Gaussian fits: the root of the MEAN second moment. */
  SigmaEff: number;
  /** Sum of each phase's kernel -- 1 if the chain preserves a constant, which it must. */
  MassPerPhase: number[];
  Reach: number;
}

/** Fit today's chain's effective 1D kernel at `(depth 2, t)`. `reach` bounds the window the
 *  kernel is read over; the mass check is what says the window was wide enough. */
export const ChainKernel1D = (t: number, reach = 24, W = 256, H = 16): ChainKernelFit => {
  const centre = W >> 1;
  const spreads = ChainSpreads1D(W, H, t, centre);
  const kernels: Float64Array[] = [];
  const sigmas: number[] = [];
  const mass: number[] = [];
  for (let phase = 0; phase < 4; phase++) {
    // `spreads[p][q]` is `M[q, centre + p]`, and the kernel at output `q0 = centre + phase`
    // wants `M[q0, q0 - d]`. The chain is 4-periodic -- `M[q + 4, c + 4] == M[q, c]` -- so with
    // `c = q0 - d` and `p = c mod 4`:
    //
    //     M[q0, c] == M[q0 - (c - centre - p), centre + p] == spreads[p][centre + p + d]
    //
    // `centre` is a multiple of 4, so `p == (phase - d) mod 4`. One array read per offset, no fit
    // and no average inside the measurement.
    const k = new Float64Array(2 * reach + 1);
    let m = 0, m2 = 0;
    for (let d = -reach; d <= reach; d++) {
      const p = (((phase - d) % 4) + 4) % 4;
      const idx = centre + p + d;
      const w = idx >= 0 && idx < W ? spreads[p][idx] : 0;
      k[d + reach] = w;
      m += w;
      m2 += w * d * d;
    }
    kernels.push(k);
    mass.push(m);
    sigmas.push(Math.sqrt(m2 / m));
  }
  const meanVar = sigmas.reduce((a, s) => a + s * s, 0) / sigmas.length;
  return {
    Kernels: kernels, SigmaPerPhase: sigmas, SigmaEff: Math.sqrt(meanVar),
    MassPerPhase: mass, Reach: reach,
  };
};

// ── DEVIATION, PSNR, AND THE DIFFERING-PIXEL RULE ─────────────────────────────────────────────

export const Psnr = (a: Float64Array, b: Float64Array): number => {
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  const mse = se / a.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
};

export const MaxDev = (a: Float64Array, b: Float64Array): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

export const MeanDev = (a: Float64Array, b: Float64Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

/**
 * HOW MANY PIXELS A SHOT WILL SEE DIFFER, from sub-level deltas -- THE RULE THE PRESAMPLE LANE
 * GOT WRONG.
 *
 * That lane predicted 23k and read 239k by counting "pixels whose delta is at least one level"
 * and treating everything under it as identical. It is not: the two arms' float values sit at an
 * arbitrary phase against the 8-bit rounding boundary, so a pixel whose channels differ by `d < 1`
 * still ROUNDS differently with probability `d` -- uniform phase, one boundary per unit. A
 * delta of 0.3 over a million pixels is three hundred thousand differing pixels, not zero.
 *
 * So the expectation is `sum over pixels of P(any channel crosses)`, and the channels are taken as
 * independent because the bed's three channels are three different gradients:
 *
 *     P(pixel differs) = 1 - prod over channels of (1 - min(1, d_c))
 *
 * `Floor` is the count the old rule would have produced (pixels with a channel at or over one
 * level), kept beside it so the two are readable together and the correction is visible rather
 * than asserted.
 */
export const PredictDiffering = (
  a: Float64Array[], b: Float64Array[],
): { Expected: number; Floor: number; Pixels: number } => {
  const n = a[0].length;
  let expected = 0, floor = 0;
  for (let i = 0; i < n; i++) {
    let same = 1, over = false;
    for (let c = 0; c < a.length; c++) {
      const d = Math.abs(a[c][i] - b[c][i]);
      same *= 1 - Math.min(1, d);
      if (d >= 1) over = true;
    }
    expected += 1 - same;
    if (over) floor++;
  }
  return { Expected: expected, Floor: floor, Pixels: n };
};

/** A synthetic vertical step edge: the worst case any reconstruction difference has, and the one
 *  a kernel comparison is read on before the bed is brought in. */
export const EdgeTile = (w: number, h: number, at: number, lo = 16, hi = 235): Float64Array => {
  const out = new Float64Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out[j * w + i] = i < at ? lo : hi;
  return out;
};
