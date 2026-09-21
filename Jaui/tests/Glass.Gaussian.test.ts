import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlurPass, GaussianKernelFor, PlanGaussian, PlanGaussianTemp, GaussianCost, PyramidDepth, PyramidFill,
  ResolveRegionRect, BaseDownsampleFactor, PresamplePlanFor,
  GAUSS_MAX_FETCHES, GAUSS_MATCH_SIGMA, GAUSS_MATCH_DEPTH, GAUSS_MATCH_TAP_OFFSET, GAUSS_PASSES,
  GAUSS_TEMPS_MAX, BLUR_PROGRAMS_GAUSSIAN, type BackdropRect,
} from '../src/Core/BlurPass';
import { PlanBorderDirect, BorderDirectTapOffset } from '../src/Core/Border.Direct';
import { AtlasAdmitsMember, PlanBackdropAtlas, ATLAS_LIMITS_WIRED } from '../src/Core/Blur.Atlas';
import { FakeGl } from './Blur.Chains.Source';
import { arrowBody } from './Scene.ReadAfterWrite.Source';
import { BedTile, BedWorstSeamStep } from './Presample.Kernel.Source';
import {
  ChainKernel1D, ChainArm, GaussArm, Pass1D, EdgeTile,
  Psnr, MaxDev, MeanDev, PredictDiffering,
} from './Gaussian.Kernel.Source';

/**
 * `?glass-gaussian` -- THE FOUR-HOP DUAL-FILTER CHAIN REPLACED BY TWO SEPARABLE PASSES.
 *
 * The lever, in one line: at the sigma a glass card actually authors, the whole field -- Skia,
 * Impeller, Strugar, Nehab -- builds no pyramid and runs a linear-sampled separable Gaussian, which
 * is ALSO the kernel the dual filter approximates. Half the passes, more taps. Four structural
 * levers on the pyramid have been removed and measured and the per-build sum did not follow any of
 * them, so this arm is a HYPOTHESIS TEST between the two live cost models rather than a promise.
 *
 * WHAT THIS FILE IS FOR, and it is three different things:
 *
 *   1. THE ARITHMETIC. The kernel, the fetch table, the exactness of the source->destination map
 *      (which linear sampling REQUIRES), the refusals, and the cost of both arms in the same
 *      currency the ledger already quotes.
 *   2. THE MEASUREMENT THE BRIEF ASKED FOR AND THE ANSWER IT DID NOT EXPECT. What sigma is
 *      today's chain actually delivering? Not the authored one: 2.80 device px against an
 *      authored 8, and by a kernel that is a four-step STAIRCASE, not a Gaussian. Section 3.
 *   3. THE PICTURE, as a number. A CPU port of both arms over the harness's own seeded bed,
 *      with the differing-pixel count predicted by the RULE the presample lane got wrong.
 */

const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');
const RENDERER = readFileSync(join(__dirname, '../src/Core/WebGL2.Renderer.ts'), 'utf8').replace(/\r\n/g, '\n');
const LEDGER = readFileSync(join(__dirname, '../src/Core/Scene.Ledger.ts'), 'utf8').replace(/\r\n/g, '\n');
const PASS = readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8').replace(/\r\n/g, '\n');

// -- glass-grid, pinned, on the geometry every other blur test in this suite uses. --
const CANVAS_W = 2560, CANVAS_H = 1600, DPR = 2;
/** `BackdropFilter Blur(4pt)` at dpr 2 -- what `max(1, BackdropFrostBlur) * dpr` produces. */
const RADIUS = 4 * DPR;
const FILL_MARGIN = 4 * DPR + (2.5 * DPR) * 8 + 0.25 * 3 + 8 * DPR;
const RIM_MARGIN = 4 * DPR + 8 * DPR;

const CardBox = (i: number): BackdropRect => {
  const col = i % 5, row = (i / 5) | 0;
  return { x: (60 + col * 236) * DPR, y: (70 + row * 170) * DPR, w: 216 * DPR, h: 150 * DPR };
};
const RegionFor = (b: BackdropRect, margin: number): BackdropRect => ({
  x: Math.max(0, Math.floor(b.x - margin)),
  y: Math.max(0, Math.floor(b.y - margin)),
  w: Math.min(CANVAS_W, Math.ceil(b.w + margin * 2)),
  h: Math.min(CANVAS_H, Math.ceil(b.h + margin * 2)),
});
const FILL = Array.from({ length: 20 }, (_, i) => RegionFor(CardBox(i), FILL_MARGIN));
const RIM = Array.from({ length: 20 }, (_, i) => RegionFor(CardBox(i), RIM_MARGIN));

const DEPTH = PyramidDepth(RADIUS, 0);
const PHASE = 1 << DEPTH;
const TAP = BorderDirectTapOffset(RADIUS, DEPTH);
const RECT0 = ResolveRegionRect(FILL[0], CANVAS_W, CANVAS_H, PHASE);

// ── 1. THE KERNEL ─────────────────────────────────────────────────────────────────────────────

describe('glass-gaussian > the linear-sampled kernel', () => {
  it('a card at dpr 2 is 49 discrete taps and 25 bilinear fetches per direction', () => {
    const k = GaussianKernelFor(RADIUS);
    expect(k.Radius).toBe(24);         // ceil(3 * 8)
    expect(k.Taps).toBe(49);
    expect(k.Fetches).toBe(25);        // 1 + 2 * ceil(24 / 2)
  });

  it('...and at dpr 1.5 it is 37 taps and 19 fetches -- the second discriminator', () => {
    const k = GaussianKernelFor(4 * 1.5);
    expect(k.Radius).toBe(18);
    expect(k.Taps).toBe(37);
    expect(k.Fetches).toBe(19);
  });

  it('the weights are a partition of the discrete Gaussian, so they sum to exactly 1', () => {
    for (const sigma of [1, 2.8, 4, 6, 8, 12, 20]) {
      const k = GaussianKernelFor(sigma);
      let s = 0;
      for (let i = 0; i < k.Fetches; i++) s += k.Weights[i];
      // Float32 storage, so the tolerance is the format's and not the arithmetic's.
      expect(s).toBeCloseTo(1, 6);
      // A convex combination cannot leave [0, 1], which is what makes an RGB10_A2 intermediate
      // between the two passes safe rather than merely untested.
      for (let i = 0; i < k.Fetches; i++) expect(k.Weights[i]).toBeGreaterThan(0);
    }
  });

  it('every fetch is RAKOS-EXACT: the bilinear pair returns the two taps` weighted sum', () => {
    // A bilinear fetch at `o` between texel centres `i` and `i+1` returns
    // `(1-a)*T[i] + a*T[i+1]` with `a = o - i`. The table's claim is that at its `o`, scaling
    // that by its weight reproduces `w_i*T[i] + w_{i+1}*T[i+1]` EXACTLY -- which is the whole of
    // why 49 taps cost 25 fetches and not 49.
    const sigma = RADIUS;
    const k = GaussianKernelFor(sigma);
    const w = (i: number): number => Math.exp(-(i * i) / (2 * sigma * sigma));
    let total = w(0);
    for (let i = 1; i <= k.Radius; i++) total += 2 * w(i);
    for (let f = 1; f < k.Fetches; f += 2) {
      const o = k.Offsets[f];
      const i = Math.floor(o);
      const a = o - i;
      const wi = w(i) / total, wj = i + 1 <= k.Radius ? w(i + 1) / total : 0;
      expect(k.Weights[f] * (1 - a)).toBeCloseTo(wi, 7);
      expect(k.Weights[f] * a).toBeCloseTo(wj, 7);
    }
  });

  it('the table is mirrored: every non-centre fetch has its negative beside it', () => {
    const k = GaussianKernelFor(RADIUS);
    expect(k.Offsets[0]).toBe(0);
    for (let f = 1; f < k.Fetches; f += 2) {
      expect(k.Offsets[f + 1]).toBe(-k.Offsets[f]);
      expect(k.Weights[f + 1]).toBe(k.Weights[f]);
    }
  });

  it('an ODD radius leaves the outermost texel unpaired, and it is fetched on its own centre', () => {
    // `ceil(3 * sigma)` is odd at, e.g., sigma 3 (R = 9). The last pair is (7,8) and texel 9 is
    // alone -- so its offset must be the integer 9, not a weighted mean with a texel that has no
    // weight. A fetch at a non-integer offset there would read texel 10, which the kernel says is
    // zero, and quietly drop mass.
    const k = GaussianKernelFor(3);
    expect(k.Radius).toBe(9);
    expect(k.Fetches).toBe(11);        // 1 + 2 * ceil(9/2)
    expect(k.Offsets[k.Fetches - 2]).toBe(9);
  });

  it('the tables are GAUSS_MAX_FETCHES long, and only the LIVE PREFIX is uploaded', () => {
    const k = GaussianKernelFor(2);
    expect(k.Offsets.length).toBe(GAUSS_MAX_FETCHES);
    expect(k.Weights.length).toBe(GAUSS_MAX_FETCHES);
    expect(k.Fetches).toBeLessThan(GAUSS_MAX_FETCHES);
    // A count at or under the array's ACTIVE size is legal under every reading of GL ES 3.0;
    // uploading all 64 would be legal only while the linker keeps the array at its declared
    // size. The loop runs `u_Fetches` times, so the tail is never read either way.
    const body = arrowBody(PASS, '_blurGaussian');
    expect(body).toContain('k.Offsets.subarray(0, k.Fetches)');
    expect(body).toContain('k.Weights.subarray(0, k.Fetches)');
  });

  it('a sigma whose kernel passes the table is REFUSED by name, never truncated', () => {
    // A clipped kernel is a different blur wearing this arm's number, so the ceiling is a
    // refusal and not a clamp. 64 fetches is `R <= 62`, i.e. sigma <= 20.67 -- `Blur(10.3pt)` at
    // dpr 2, past anything any glass class in this app authors.
    expect(GaussianKernelFor(20).Fetches).toBe(61);
    expect(PlanGaussian(20, 'on', 2, 0.7).Ok).toBe(true);
    expect(PlanGaussian(21, 'on', 2, 0.7).Ok).toBe(false);
    const over = PlanGaussian(64, 'on', 4, 1.0);
    expect(over.Ok).toBe(false);
    expect(over.Ok === false && over.Why).toContain(`over-${GAUSS_MAX_FETCHES}`);
  });
});

// ── 2. THE MAP, WHICH LINEAR SAMPLING REQUIRES TO BE EXACT ────────────────────────────────────

describe('glass-gaussian > the source-to-destination map is an identity plus an integer shift', () => {
  // Skia will not linear-sample under anything but an identity or an integer translation: a
  // FRACTIONAL one moves the pair's bilinear weight off the weight the table computed, and the
  // fetch stops returning the pair's weighted sum. `_blurGaussian`'s two `u_SrcRect`s are the
  // whole of that argument and this is it in arithmetic rather than in prose.
  const k = GaussianKernelFor(RADIUS);
  const y0 = Math.max(0, RECT0.YBottom - k.Radius);
  const y1 = Math.min(CANVAS_H, RECT0.YBottom + RECT0.H + k.Radius);
  const tempH = y1 - y0;
  const padBelow = RECT0.YBottom - y0;

  it('every term of both rects is an INTEGER device pixel', () => {
    for (const v of [RECT0.X, RECT0.YBottom, RECT0.W, RECT0.H, y0, y1, tempH, padBelow, k.Radius]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(padBelow).toBe(k.Radius);   // no canvas clamp on card 0
  });

  it('the H pass lands every destination pixel on a SOURCE TEXEL CENTRE, exactly', () => {
    // `v_Uv = u_SrcRect.xy + a_Position * u_SrcRect.zw` with the rect `_blurGaussian` sets.
    const sx = RECT0.X / CANVAS_W, sw = RECT0.W / CANVAS_W;
    const sy = y0 / CANVAS_H, sh = tempH / CANVAS_H;
    for (const i of [0, 1, 7, RECT0.W >> 1, RECT0.W - 1]) {
      const u = sx + ((i + 0.5) / RECT0.W) * sw;
      // The texel the coordinate names, and the fractional part of its position in it.
      const texel = u * CANVAS_W - 0.5;
      expect(texel).toBeCloseTo(RECT0.X + i, 9);
    }
    for (const j of [0, 1, tempH >> 1, tempH - 1]) {
      const v = sy + ((j + 0.5) / tempH) * sh;
      expect(v * CANVAS_H - 0.5).toBeCloseTo(y0 + j, 9);
    }
  });

  it('the V pass lands every destination pixel on a TEMP TEXEL CENTRE, offset by the padding', () => {
    for (const j of [0, 1, RECT0.H >> 1, RECT0.H - 1]) {
      const v = padBelow / tempH + ((j + 0.5) / RECT0.H) * (RECT0.H / tempH);
      expect(v * tempH - 0.5).toBeCloseTo(padBelow + j, 9);
    }
    for (const i of [0, 1, RECT0.W - 1]) {
      // x is the identity: the temp is the region's own width.
      const u = 0 + ((i + 0.5) / RECT0.W) * 1;
      expect(u * RECT0.W - 0.5).toBeCloseTo(i, 9);
    }
  });

  it('the temp is the region PADDED by the kernel radius -- at the canvas edge too (lane gaussian2)', () => {
    expect(tempH).toBe(RECT0.H + 2 * k.Radius);
    // A card at the very top of the canvas still gets its whole pad: the H pass addresses rows
    // above the canvas and the SCENE sampler's CLAMP_TO_EDGE replicates the edge row into them,
    // which is what the chain's region-sized levels do there. The clamp lives in the READ, so the
    // temp has no row the V pass can address and the H pass does not write. See
    // `Glass.Gaussian.Cover.test.ts`.
    const top = ResolveRegionRect({ x: 100, y: 0, w: 400, h: 300 }, CANVAS_W, CANVAS_H, PHASE);
    const t = PlanGaussianTemp(top, k);
    expect(t.Ok).toBe(true);
    if (!t.Ok) return;
    expect(t.Y0 + t.H).toBeGreaterThan(CANVAS_H);
    expect([t.H, t.PadBelow, t.Written]).toEqual([top.H + 2 * k.Radius, k.Radius, t.Readable]);
  });

  it('on glass-grid NO card is clamped: all twenty pad fully, both arms, both dprs', () => {
    for (const region of [...FILL, ...RIM]) {
      const rect = ResolveRegionRect(region, CANVAS_W, CANVAS_H, PHASE);
      expect(rect.YBottom - k.Radius).toBeGreaterThanOrEqual(0);
      expect(rect.YBottom + rect.H + k.Radius).toBeLessThanOrEqual(CANVAS_H);
    }
  });
});

// ── 3. WHAT TODAY'S CHAIN IS ACTUALLY DELIVERING ──────────────────────────────────────────────

describe('glass-gaussian > the chain`s own effective kernel, measured', () => {
  const fit = ChainKernel1D(TAP, 32);

  it('the measurement is sound before it is read: mass 1, mean 0, on all four phases', () => {
    // A kernel that does not sum to 1 does not preserve a constant, and one whose first moment is
    // not 0 shifts the image. Both would mean the recovery below is wrong rather than the chain.
    for (let p = 0; p < 4; p++) {
      expect(fit.MassPerPhase[p]).toBeCloseTo(1, 9);
      let mean = 0;
      for (let d = -fit.Reach; d <= fit.Reach; d++) mean += fit.Kernels[p][d + fit.Reach] * d;
      expect(mean).toBeCloseTo(0, 9);
    }
  });

  it('THE FINDING: the chain runs at sigma 2.80, against an AUTHORED 8', () => {
    expect(fit.SigmaEff).toBeCloseTo(2.798809, 5);
    expect(fit.SigmaEff / RADIUS).toBeCloseTo(0.3499, 3);
    // And the constant the `match` arm ships is this measurement, not a second derivation of it.
    expect(GAUSS_MATCH_SIGMA).toBeCloseTo(fit.SigmaEff, 8);
  });

  it('...and it is a function of (depth, tap offset) ALONE, which is why the constant is absolute', () => {
    // `radius` reaches the operator only through those two, and across the whole band
    // `3 < radius <= 8.4` both are pinned -- so a card at dpr 2 (radius 8) and one at dpr 1.5
    // (radius 6) get the IDENTICAL kernel. A ratio-of-radius calibration would have been wrong
    // at one of them.
    expect(PyramidDepth(8, 0)).toBe(GAUSS_MATCH_DEPTH);
    expect(PyramidDepth(6, 0)).toBe(GAUSS_MATCH_DEPTH);
    expect(BorderDirectTapOffset(8, 2)).toBe(GAUSS_MATCH_TAP_OFFSET);
    expect(BorderDirectTapOffset(6, 2)).toBe(GAUSS_MATCH_TAP_OFFSET);
    // The tap offset leaves its floor at radius > 8.4, and `match` refuses there by name rather
    // than running a calibration fitted to a chain it is not running.
    expect(BorderDirectTapOffset(8.5, 2)).toBeGreaterThan(GAUSS_MATCH_TAP_OFFSET);
    const refused = PlanGaussian(8.5, 'match', 2, BorderDirectTapOffset(8.5, 2));
    expect(refused.Ok).toBe(false);
    expect(refused.Ok === false && refused.Why).toContain('match-tap-offset');
    expect((PlanGaussian(20, 'match', 3, 0.7) as { Why: string }).Why).toBe('match-depth3');
  });

  it('THE SECOND FINDING: the kernel is a four-step STAIRCASE, not a Gaussian', () => {
    // Four treads of four device px each -- the `2^depth` grid -- then nothing: finite support
    // over nine texels. It is far closer to a box cascade than to the Gaussian the dual filter
    // is sold as approximating, which is the "more smoothly" half of Jack's question with a
    // number on it. And a single phase's kernel is ASYMMETRIC (its four treads do not straddle
    // zero evenly) even though its first moment is exactly 0; the phase-3 kernel is its mirror.
    const k = fit.Kernels[0], R = fit.Reach;
    const at = (d: number): number => k[d + R];
    for (const [lo, hi] of [[-7, -4], [-3, 0], [1, 4], [5, 8]]) {
      for (let d = lo; d <= hi; d++) expect(at(d)).toBeCloseTo(at(lo), 12);
    }
    expect(at(-4)).toBeCloseTo(0.016454, 5);
    expect(at(0)).toBeCloseTo(0.129023, 5);
    expect(at(4)).toBeCloseTo(0.098841, 5);
    expect(at(8)).toBeCloseTo(0.005681, 5);
    expect(at(9)).toBe(0);
    expect(at(-8)).toBe(0);
    // Phase 3 is phase 0 reflected: same four treads, opposite order.
    const m = fit.Kernels[3];
    for (let d = -R; d <= R; d++) expect(m[d + R]).toBeCloseTo(at(-d), 12);
    // Kurtosis under a Gaussian's 3: flatter core, shorter tails.
    let m2 = 0, m4 = 0;
    for (let d = -R; d <= R; d++) { const w = at(d); m2 += w * d * d; m4 += w * d * d * d * d; }
    expect(m4 / (m2 * m2)).toBeCloseTo(2.783, 2);
  });

  it('THE THIRD FINDING: the blur BEATS with a period of 4 device px across the card', () => {
    // All four phases share mass, mean and variance EXACTLY -- and differ in shape by 63% of
    // peak. So which blur a fragment receives depends on where it sits on the 2^depth grid, and
    // a separable Gaussian, being shift-invariant, removes that beat outright.
    let maxDelta = 0;
    for (let p = 1; p < 4; p++) {
      for (let i = 0; i < fit.Kernels[0].length; i++) {
        maxDelta = Math.max(maxDelta, Math.abs(fit.Kernels[p][i] - fit.Kernels[0][i]));
      }
      expect(fit.SigmaPerPhase[p]).toBeCloseTo(fit.SigmaPerPhase[0], 9);
    }
    expect(maxDelta).toBeCloseTo(0.09252, 4);
    const peak = Math.max(...fit.Kernels[1]);
    expect(maxDelta / peak).toBeGreaterThan(0.6);
  });

  it('the PSNR of the chain against the two Gaussians -- the picture change, split in two', () => {
    // A hard 0..255 vertical step, which is the worst case any kernel difference has.
    const W = 128, H = 128;
    const edge = EdgeTile(W, H, 64, 0, 255);
    const chain = ChainArm(edge, W, H, 0, 0, W, H, TAP);
    const crop = (a: Float64Array): Float64Array => {
      const out = new Float64Array(64 * 68);
      let n = 0;
      for (let j = 32; j < 96; j++) for (let i = 30; i < 98; i++) out[n++] = a[j * W + i];
      return out;
    };
    const ref = (s: number): Float64Array =>
      crop(Pass1D(edge, W, H, 0, 0, W, H, GaussianKernelFor(s), 'x').Data);
    const c = crop(chain);
    // SHAPE alone (the `match` arm): a real difference, and a measurable one.
    expect(MaxDev(c, ref(GAUSS_MATCH_SIGMA))).toBeGreaterThan(8);
    expect(MaxDev(c, ref(GAUSS_MATCH_SIGMA))).toBeLessThan(12);
    expect(Psnr(c, ref(GAUSS_MATCH_SIGMA))).toBeGreaterThan(35);
    // SHAPE plus WIDTH (the `on` arm): an order of magnitude larger, because `on` is ~2.9x the
    // blur that ships. This is the number that says `on` is NOT "today's picture".
    expect(MaxDev(c, ref(RADIUS))).toBeGreaterThan(60);
    expect(Psnr(c, ref(RADIUS))).toBeLessThan(22);
    expect(MaxDev(c, ref(RADIUS)) / MaxDev(c, ref(GAUSS_MATCH_SIGMA))).toBeGreaterThan(5);
  });
});

// ── 4. THE PICTURE, ON THE HARNESS'S OWN BED ──────────────────────────────────────────────────

describe('glass-gaussian > what a shot will see, predicted by the RULE', () => {
  // ONE card, both arms, all three channels, over the bed the harness actually draws -- rasterised
  // from `page-protocol.js`'s own seed and mulberry32, exactly as the presample lane did it.
  // Card 0's region crosses no band seam at this size, so the worst-case card is named separately
  // below rather than left to a reader to find.
  const rect = RECT0;
  const inCard = { x: 4 * DPR + 8 * DPR, y: 4 * DPR + 8 * DPR };   // inset from the region edge

  /** Both arms over one card's region, per channel, cropped to the CARD BOX -- which is where a
   *  shot's differing pixels are allowed to be and nowhere else. */
  const Arms = (region: BackdropRect): { Chain: Float64Array[]; On: Float64Array[]; Match: Float64Array[] } => {
    const r = ResolveRegionRect(region, CANVAS_W, CANVAS_H, PHASE);
    // The port works in image order (y from the TOP); the engine's rect counts from the bottom.
    const ryTop = CANVAS_H - (r.YBottom + r.H);
    // A source tall enough for the Gaussian's vertical reach on both sides.
    const pad = GaussianKernelFor(RADIUS).Radius;
    const sy = ryTop - pad, sh = r.H + 2 * pad;
    const chain: Float64Array[] = [], on: Float64Array[] = [], match: Float64Array[] = [];
    for (let ch = 0; ch < 3; ch++) {
      const src = BedTile(r.X - pad, sy, r.W + 2 * pad, sh, ch);
      const sw = r.W + 2 * pad;
      chain.push(ChainArm(src, sw, sh, pad, pad, r.W, r.H, TAP));
      on.push(GaussArm(src, sw, sh, pad, pad, r.W, r.H, RADIUS).Out);
      match.push(GaussArm(src, sw, sh, pad, pad, r.W, r.H, GAUSS_MATCH_SIGMA).Out);
    }
    // Crop every arm to the card box inside the region.
    const cw = r.W - 2 * inCard.x, chh = r.H - 2 * inCard.y;
    const cropAll = (a: Float64Array[]): Float64Array[] => a.map((p) => {
      const out = new Float64Array(cw * chh);
      let n = 0;
      for (let j = inCard.y; j < inCard.y + chh; j++) {
        for (let i = inCard.x; i < inCard.x + cw; i++) out[n++] = p[j * r.W + i];
      }
      return out;
    });
    return { Chain: cropAll(chain), On: cropAll(on), Match: cropAll(match) };
  };

  const a0 = Arms(FILL[0]);
  /** Worst channel delta over all three channels -- what a shot reports, not what one plane does. */
  const MaxCh = (a: Float64Array[], b: Float64Array[]): number =>
    Math.max(...a.map((p, i) => MaxDev(p, b[i])));
  const MeanCh = (a: Float64Array[], b: Float64Array[]): number =>
    a.reduce((t, p, i) => t + MeanDev(p, b[i]), 0) / a.length;

  it('the bed is the harness`s bed: the seam step the difference is proportional to', () => {
    expect(BedWorstSeamStep()).toBeGreaterThan(0);
  });

  it('`match` -- SHAPE ONLY -- 7.1k of card 0`s 202k box pixels, max channel delta 2.9', () => {
    // THE PREDICTION the orchestrator's shot is measured against, pinned so a later change to
    // the kernel or the map cannot move it silently. Card 0 is the least-contrasted of the
    // twenty; the sweep over all twenty is in `Perf/BlurGaussian.Finding.md` (133,187 of
    // 4,035,200 box px, 3.3%, worst card max 4.6).
    const p = PredictDiffering(a0.Chain, a0.Match);
    expect(p.Pixels).toBe(520 * 388);
    expect(p.Expected).toBeGreaterThan(6800);
    expect(p.Expected).toBeLessThan(7400);
    expect(MaxCh(a0.Chain, a0.Match)).toBeCloseTo(2.88, 1);
    expect(MeanCh(a0.Chain, a0.Match)).toBeLessThan(0.05);
    expect(Psnr(a0.Chain[0], a0.Match[0])).toBeGreaterThan(65);
    // And the old rule would have predicted 4,160 -- 1.7x low. That factor is the correction.
    expect(p.Expected / p.Floor).toBeGreaterThan(1.5);
  });

  it('`on` -- SHAPE AND WIDTH -- 20k pixels and max delta 28, because it is a 2.9x wider blur', () => {
    const on = PredictDiffering(a0.Chain, a0.On);
    const match = PredictDiffering(a0.Chain, a0.Match);
    expect(on.Expected).toBeGreaterThan(19000);
    expect(on.Expected).toBeLessThan(21000);
    expect(on.Expected / match.Expected).toBeGreaterThan(2.5);
    expect(MaxCh(a0.Chain, a0.On)).toBeCloseTo(27.8, 0);
    // An order of magnitude past `match`: this is the number that says `on` is NOT today's
    // picture and must not be shot as though it were a refinement of it.
    expect(MaxCh(a0.Chain, a0.On) / MaxCh(a0.Chain, a0.Match)).toBeGreaterThan(8);
  });

  it('the prediction RULE is the sub-level one, not the presample lane`s floor', () => {
    // A delta of 0.3 over a million pixels is three hundred thousand differing pixels, not zero:
    // the two arms' float values sit at an arbitrary phase against the rounding boundary. The
    // presample lane predicted 23k and read 239k by counting only deltas at or over one level.
    const a = [new Float64Array([10, 10, 10, 10])];
    const b = [new Float64Array([10.5, 10.5, 10.5, 10.5])];
    expect(PredictDiffering(a, b).Floor).toBe(0);
    expect(PredictDiffering(a, b).Expected).toBeCloseTo(2, 9);
    // Three independent channels at 0.5 each: 1 - 0.5^3.
    const c = [new Float64Array([10]), new Float64Array([10]), new Float64Array([10])];
    const d = [new Float64Array([10.5]), new Float64Array([10.5]), new Float64Array([10.5])];
    expect(PredictDiffering(c, d).Expected).toBeCloseTo(0.875, 9);
  });

  it('nothing OUTSIDE a card box can differ: both arms read the same scene, and pblur is untouched', () => {
    // The arm reaches exactly the per-surface glass builds. `?glass-gaussian` never reaches the
    // shared backdrop or the progressive blur (they are a different `BlurPass` and a different
    // call site), which is what makes `pblur-scrim@90` a 0-pixel prediction rather than a hope.
    expect(JAUI).toContain('private _mayGaussian = (plan: GlassBlurPlan): boolean =>');
    expect(JAUI.split('this._mayGaussian(plan)').length - 1).toBe(3);
    // `BuildSharedBackdrop` and the pblur path do not carry the argument at all.
    expect(RENDERER).toContain('BuildSharedBackdrop');
    const shared = arrowBody(RENDERER, 'BuildSharedBackdrop');
    expect(shared).not.toContain('gaussMode');
    expect(shared).not.toContain('DiagGlassGaussian');
  });
});

// ── 5. THE COST, IN THE LEDGER'S OWN CURRENCY ─────────────────────────────────────────────────

describe('glass-gaussian > what each arm writes and reads', () => {
  const chainFill = PyramidFill(RECT0.W, RECT0.H, 1, DEPTH);
  const chainReads = (() => {
    // From the constants, the same way `BlurAnatomy.Finding.md` section 7 counts them: 5 taps per
    // DOWN destination pixel, 8 per UP.
    let w = RECT0.W, h = RECT0.H;
    const lw = [w], lh = [h];
    for (let i = 1; i <= DEPTH; i++) { w = Math.floor(w / 2); h = Math.floor(h / 2); lw.push(w); lh.push(h); }
    let r = 0;
    for (let i = 1; i <= DEPTH; i++) r += lw[i] * lh[i] * 5;
    for (let i = DEPTH - 1; i >= 0; i--) r += lw[i] * lh[i] * 8;
    return r;
  })();

  it('today`s chain is the anatomy finding`s numbers, reproduced here rather than quoted', () => {
    expect(RECT0.W).toBe(568);
    expect(RECT0.H).toBe(436);
    expect(chainFill).toBe(386950);
    expect(chainReads).toBe(2863430);
  });

  it('`on` trades ~4.6x the FETCHES for HALF the passes -- which is why it discriminates', () => {
    const k = GaussianKernelFor(RADIUS);
    const cost = GaussianCost(RECT0.W, RECT0.H, RECT0.H + 2 * k.Radius, k.Fetches);
    expect(cost.Fill).toBe(568 * 484 + 568 * 436);          // 522,560
    expect(cost.Reads).toBe(cost.Fill * 25);                // 13,064,000
    expect(cost.Reads / chainReads).toBeGreaterThan(4.5);
    expect(cost.Reads / chainReads).toBeLessThan(4.7);
    expect(cost.Fill / chainFill).toBeGreaterThan(1.3);
    expect(GAUSS_PASSES * 2).toBe(4);                        // half of the chain's four
  });

  it('`match` trades only ~1.9x the fetches, because its kernel is a THIRD the radius', () => {
    const k = GaussianKernelFor(GAUSS_MATCH_SIGMA);
    expect(k.Radius).toBe(9);
    expect(k.Fetches).toBe(11);
    const cost = GaussianCost(RECT0.W, RECT0.H, RECT0.H + 2 * k.Radius, k.Fetches);
    expect(cost.Reads / chainReads).toBeGreaterThan(1.8);
    expect(cost.Reads / chainReads).toBeLessThan(2.0);
  });

  it('per 20 builds, against the frame the ledger already priced', () => {
    const k = GaussianKernelFor(RADIUS);
    const cost = GaussianCost(RECT0.W, RECT0.H, RECT0.H + 2 * k.Radius, k.Fetches);
    expect(cost.Fill * 20).toBe(10451200);
    expect(20 * GAUSS_PASSES).toBe(40);          // against the chain's 80
  });
});

// ── 6. THE REFUSALS, EACH NAMED ───────────────────────────────────────────────────────────────

describe('glass-gaussian > the three flags it refuses and the one it composes with', () => {
  const RIM_CAND = {
    Region: RIM[0], Radius: RADIUS, MaxLod: 0,
    Px: CardBox(0).x, Py: CardBox(0).y, Pw: CardBox(0).w, Ph: CardBox(0).h, TapReach: 24,
  };

  it('the ATLAS refuses a Gaussian member: it packs chain LEVELS and there are none', () => {
    expect(AtlasAdmitsMember(RIM_CAND, CANVAS_W, CANVAS_H, false, false)).toBe(true);
    expect(AtlasAdmitsMember(RIM_CAND, CANVAS_W, CANVAS_H, false, true)).toBe(false);
    const members = FILL.slice(0, 4).map((r) => ({ Region: r, Paint: r }));
    const opts = { IgnoreSeparation: true, Limits: ATLAS_LIMITS_WIRED, MaxLod: 0 };
    expect(PlanBackdropAtlas(members, CANVAS_W, CANVAS_H, RADIUS, opts)).not.toBeNull();
    expect(PlanBackdropAtlas(members, CANVAS_W, CANVAS_H, RADIUS, { ...opts, Gaussian: true }))
      .toBeNull();
  });

  it('BORDER-DIRECT refuses it: the gather reproduces the CHAIN`s four hops and nothing else', () => {
    expect(PlanBorderDirect(RIM[0], CANVAS_W, CANVAS_H, RADIUS, 0, false, false).Ok).toBe(true);
    const r = PlanBorderDirect(RIM[0], CANVAS_W, CANVAS_H, RADIUS, 0, false, true);
    expect(r.Ok).toBe(false);
    expect(r.Ok === false && r.Why).toContain('glass-gaussian');
  });

  it('GLASS-PRESAMPLE refuses it inside the pass: there is no chain to pre-downsample', () => {
    // The plan exists for a card, which is what makes the clause live rather than decorative.
    expect(PresamplePlanFor(RADIUS, CANVAS_W, CANVAS_H, FILL[0], 0)).not.toBeNull();
    const body = arrowBody(PASS, 'Blur');
    expect(body).toContain('pre !== null ? { Ok: false as const, Why: `presample-k${pre.K}` }');
    expect(body).toContain('k !== 1 ? { Ok: false as const, Why: `pre-downsample-k${k}` }');
  });

  it('...and the three are refused AT THE FLAG too, by name, so an arm is never vacuous', () => {
    for (const clause of [
      "this._glassPresample ? 'glass-presample-re-bases-a-chain-this-arm-does-not-build'",
      "this._borderDirect ? 'border-direct-gathers-the-chain-s-four-hops-and-refuses-a-gaussian-rim'",
      "this._pyramidAtlas ? 'pyramid-atlas-packs-chain-levels-and-a-gaussian-build-has-none'",
    ]) expect(JAUI).toContain(clause);
    expect(JAUI).toContain("JTrace(`jaui:glass-gaussian armed=off reason=${why}`)");
  });

  it('a k > 1 build -- a full-screen scrim -- keeps the chain, refused by name', () => {
    expect(BaseDownsampleFactor(32, CANVAS_W, CANVAS_H, undefined)).toBeGreaterThan(1);
    const body = arrowBody(PASS, 'Blur');
    expect(body).toContain('if (gaussian !== \'off\') {');
  });

  it('BORDER-SOURCE=FILL COMPOSES, and is deliberately NOT in the refusal chain', () => {
    // The rim reads the handle its own fill took; this arm changes what PRODUCED the texels
    // behind that handle and changes neither the handle, the region nor the map. So the rim
    // needs no clause, and `GaussianBuilds` reads 20 under `fill` and 40 under `scene`.
    const block = JAUI.slice(JAUI.indexOf("params.has('glass-gaussian')"), JAUI.indexOf('jaui:glass-gaussian armed=off'));
    expect(block).not.toContain('_borderSourceFill');
    expect(JAUI).toContain('reads 20 rather than 40. Under `?border-source=scene` every rim builds again');
  });
});

// ── 7. THE PASS, WIRED ────────────────────────────────────────────────────────────────────────

describe('glass-gaussian > the build BlurPass actually issues', () => {
  const Rig = (): { Gl: FakeGl; Pass: BlurPass; Src: object } => {
    const gl = new FakeGl();
    const pass = new BlurPass(gl.Gl as unknown as WebGL2RenderingContext, undefined, 1);
    pass.EnsureGaussianProgram();
    return { Gl: gl, Pass: pass, Src: gl.MakeSource(CANVAS_W, CANVAS_H, 'scene') };
  };
  const Build = (r: { Gl: FakeGl; Pass: BlurPass; Src: object }, mode: 'off' | 'on' | 'match'): {
    Texels: string[]; Draws: number; Region: string; Depth: number;
    Gauss: boolean; Sigma: number; Fetches: number; Refused: string;
  } => {
    r.Gl.Reset();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, RADIUS, 0, FILL[0], undefined, false, mode);
    return {
      Texels: r.Gl.Texels,
      Draws: r.Gl.Calls.filter((c) => c === 'drawElements').length,
      Region: JSON.stringify(r.Pass.LastRegion),
      Depth: r.Pass.LastDepth,
      Gauss: r.Pass.LastGaussian,
      Sigma: r.Pass.LastGaussianSigma,
      Fetches: r.Pass.LastGaussianFetches,
      Refused: r.Pass.LastGaussianRefusal,
    };
  };

  it('off: FOUR draws, depth 2, and the pass says it ran no Gaussian', () => {
    const b = Build(Rig(), 'off');
    expect(b.Draws).toBe(4);
    expect(b.Depth).toBe(2);
    expect(b.Gauss).toBe(false);
    expect(b.Refused).toBe('');
  });

  it('on: TWO draws, sigma 8, 25 fetches -- half the passes', () => {
    const b = Build(Rig(), 'on');
    expect(b.Draws).toBe(GAUSS_PASSES);
    expect(b.Gauss).toBe(true);
    expect(b.Sigma).toBe(RADIUS);
    expect(b.Fetches).toBe(25);
  });

  it('match: two draws at the CHAIN`s measured sigma, and 11 fetches', () => {
    const b = Build(Rig(), 'match');
    expect(b.Draws).toBe(2);
    expect(b.Sigma).toBe(GAUSS_MATCH_SIGMA);
    expect(b.Fetches).toBe(11);
  });

  it('the first write is the TALL TEMP and the second is LEVEL 0 at the rect`s own size', () => {
    const b = Build(Rig(), 'on');
    expect(b.Texels.length).toBe(2);
    expect(b.Texels[0]).toContain(`${RECT0.W}x${RECT0.H + 48}`);   // 568x484
    expect(b.Texels[1]).toContain(`${RECT0.W}x${RECT0.H}`);        // 568x436
  });

  it('LEVEL 0 IS THE SAME SIZE AND `LastRegion` THE SAME MAP AS THE CHAIN`S', () => {
    // The whole of why `Jiv.Panel.frag` is untouched by design: the consumer's `u_BackdropXf` is
    // built out of `LastRegion`, and it does not move between the arms by one bit.
    const off = Build(Rig(), 'off'), on = Build(Rig(), 'on');
    expect(on.Region).toBe(off.Region);
    expect(off.Texels[off.Texels.length - 1].split(' ')[1])
      .toBe(on.Texels[on.Texels.length - 1].split(' ')[1]);
  });

  it('depth comes back 0, so the caller`s GenerateBlurMipmap(0) takes DisableMipmap', () => {
    expect(Build(Rig(), 'on').Depth).toBe(0);
    expect(PASS).toContain('if (maxLod !== undefined && maxLod <= 0) {');
  });

  it('the two arms differ in the TEXELS, which is the point -- and say so', () => {
    const off = Build(Rig(), 'off'), on = Build(Rig(), 'on');
    const val = (t: string): string => t.split(' ').slice(2).join(' ');
    expect(val(on.Texels[1])).not.toBe(val(off.Texels[3]));
  });

  it('`on` and `match` differ from each other too: the kernel table reaches the draw', () => {
    // `FakeGl` composes a draw's value from its program's uniforms, and the two tables are
    // uploaded as uniforms -- so two sigmas that produced the same value here would mean the
    // kernel never reached the GPU.
    const on = Build(Rig(), 'on'), match = Build(Rig(), 'match');
    const val = (t: string): string => t.split(' ').slice(2).join(' ');
    expect(val(on.Texels[1])).not.toBe(val(match.Texels[1]));
  });

  it('the temp pool holds ONE entry for glass-grid, and is bounded', () => {
    const r = Rig();
    for (let i = 0; i < 20; i++) {
      r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, RADIUS, 0, FILL[i], undefined, false, 'on');
    }
    const c = r.Pass.GaussTempCensus;
    expect(c.Count).toBe(1);
    expect(c.Sizes).toBe(`${RECT0.W}x${RECT0.H + 48}`);
    expect(GAUSS_TEMPS_MAX).toBe(4);
  });

  it('the kernel is compiled by the ARM, never at boot, and never twice', () => {
    const gl = new FakeGl();
    const pass = new BlurPass(gl.Gl as unknown as WebGL2RenderingContext, undefined, 1);
    expect(pass.GaussianProgramCompiled).toBe(false);
    expect(pass.EnsureGaussianProgram()).toBe(BLUR_PROGRAMS_GAUSSIAN);
    expect(pass.GaussianProgramCompiled).toBe(true);
    expect(pass.EnsureGaussianProgram()).toBe(0);
  });

  it('a Gaussian build on a pass that never armed THROWS, naming what was not compiled', () => {
    const gl = new FakeGl();
    const pass = new BlurPass(gl.Gl as unknown as WebGL2RenderingContext, undefined, 1);
    const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    expect(() => pass.Blur(src as WebGLTexture, CANVAS_W, CANVAS_H, RADIUS, 0, FILL[0],
      undefined, false, 'on')).toThrow(/EnsureGaussianProgram/);
  });

  it('every pass invalidates its destination before drawing, exactly as the chain does', () => {
    const body = arrowBody(PASS, '_blurGaussian');
    expect(body).toContain("this._bindTarget(temp, 'gauss-h')");
    expect(body).toContain("this._bindTarget(this._levels[0], 'l0')");
    expect(arrowBody(PASS, '_bindTarget'))
      .toContain('gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0])');
  });

  it('both passes name their LOD, for the reason the DOWN kernel`s note gives', () => {
    // The V pass reads a temp the H pass just wrote into a destination of a DIFFERENT height, so
    // an implicit `texture()` would take its LOD from the derivative on a source that is not
    // mip-complete. That is the black fixed point the note above DOWN_FRAG describes.
    expect(PASS).toContain('sum += textureLod(u_Tex, v_Uv + u_Step * u_Off[i], 0.0).rgb * u_Wt[i];');
  });
});

// ── 8. THE COUNTERS, THE MARK AND THE GATE ────────────────────────────────────────────────────

describe('glass-gaussian > the instrument', () => {
  it('the counter is booked off the PASS, not off the flag', () => {
    const note = arrowBody(RENDERER, '_noteGaussian');
    expect(note).toContain('if (!pass.LastGaussian) {');
    expect(note).toContain('this._sceneLedger.NoteGaussian(GAUSS_PASSES);');
    expect(LEDGER).toContain('GaussianBuilds = 0;');
    expect(LEDGER).toContain('this.GaussianBuilds = 0;');       // reset every frame
    expect(LEDGER).toContain('NoteGaussian = (passes: number): void => {');
  });

  it('PASSES is a column of its own, because EndsByKey.blur counts BUILDS and cannot carry it', () => {
    // `NoteTargetBind` is called ONCE per build from `ComputeBlur` and the level binds inside a
    // build never reach the ledger, so `blur=` reads 20 on both arms by design. A pass-count
    // prediction quoted against it would be reading a column this lever cannot move.
    expect(LEDGER).toContain('GaussianPasses = 0;');
    expect(LEDGER).toContain('this.GaussianPasses += passes;');
    const bind = arrowBody(LEDGER, 'NoteTargetBind');
    expect(bind).toContain('if (!this._writtenSinceSwitch) return;');
    // ONE call, in `ComputeBlur`'s own body, taken before the pass is asked to build anything --
    // so it books the BUILD. The other three in the file are the atlas, the mip chain and the
    // border copy, which are different builds and not this one's passes.
    const cb = arrowBody(RENDERER, 'ComputeBlur');
    expect(cb.split("this._sceneLedger.NoteTargetBind('blur');").length - 1).toBe(1);
  });

  it('the renderer ANDs the caller`s request with its own arm, so a site can only under-arm', () => {
    const body = arrowBody(RENDERER, 'ComputeBlur');
    expect(body).toContain(
      "const gaussMode: GaussianMode = gaussian === true ? this.DiagGlassGaussian : 'off';");
    expect(body).toContain('rebase, gaussMode)');
  });

  it('the boot mark prints the arm, the default and whether the pixels move', () => {
    expect(JAUI).toContain('JTrace(`jaui:glass-gaussian armed=${this._glassGaussian}`');
    expect(JAUI).toContain("+ ` default=${!params.has('glass-gaussian')}`");
    expect(JAUI).toContain("+ (this._glassGaussian === 'off' ? ' pixels=SAME' : ' pixels=DIFFERENT')");
  });

  it('the gate line carries builds, sigma, fetches, passes and the plan`s refusal', () => {
    expect(JAUI).toContain('` builds=${gl2.GaussianBuilds} passes=${GAUSS_PASSES}`');
    expect(JAUI).toContain('` totalPasses=${gl2.GaussianPasses}`');
    expect(JAUI).toContain('` sigma=${gl2.LastGaussianSigma} fetches=${gl2.LastGaussianFetches}`');
    expect(JAUI).toContain('planRefused=');
    // The control invariant beside it: the arm removes no BUILD.
    expect(JAUI).toContain("` blur=${gl2.SceneEndsByKey['blur'] ?? 0} switches=${gl2.SceneSwitches}`");
  });

  it('the flag takes three values by NAME and throws on anything else', () => {
    expect(JAUI).toContain(
      "if (raw !== '' && raw !== 'on' && raw !== 'off' && raw !== 'match') {");
    expect(JAUI).toContain(
      "this._glassGaussian = raw === 'off' ? 'off' : raw === 'match' ? 'match' : 'on';");
  });

  it('the default is OFF in BOTH places, or the worker path would arm on every page', () => {
    expect(JAUI).toContain("private _glassGaussian: GaussianMode = 'off';");
    expect(RENDERER).toContain("DiagGlassGaussian: GaussianMode = 'off';");
  });

  it('the census is registered and reads the engine, not the flag', () => {
    expect(JAUI).toContain('g.__jauiGlassGaussian = () => {');
    expect(JAUI).toContain('Builds: on ? r.GaussianBuilds : 0,');
    expect(JAUI).toContain('TotalPasses: on ? r.GaussianPasses : 0,');
  });
});
