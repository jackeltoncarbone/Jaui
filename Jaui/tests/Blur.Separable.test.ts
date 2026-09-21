import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlurPass, PyramidDepth, ResolveRegionRect, BaseDownsampleFactor, GAUSS_MATCH_SIGMA,
  type BackdropRect,
} from '../src/Core/BlurPass';
import {
  ChainDeliveredSigma, SeparableDeliveredSigma, SolveSeparableKernel, SeparableKFor, PlanSeparable,
  PlanSeparableTargets, ChainCost, ChainOperator1D, SeparableOperator1D, OperatorSigma1D,
  GaussianKernelWith, RadiusForFetches, FetchesForRadius, GAUSS_MAX_FETCHES,
  type GaussianKernel, type SeparableRequest,
} from '../src/Core/Blur.Separable';
import { FakeGl } from './Blur.Chains.Source';
import { arrowBody } from './Scene.ReadAfterWrite.Source';
import { BedTile } from './Presample.Kernel.Source';
import { ChainKernel1D, ChainArm, Pass1D, PredictDiffering, MaxDev, MeanDev } from './Gaussian.Kernel.Source';

/**
 * LANE BLURFAST -- THE PER-SURFACE GLASS BLUR AS THE FIELD BUILDS IT, DEFAULT ON.
 *
 * Downsample by SIGMA, then ONE separable linear-sampled Gaussian pair at the residual, at the
 * width today's chain DELIVERS. What this file holds, in order:
 *
 *   1. The instrument: the chain's delivered sigma for every (k, depth, t), measured on the
 *      chain's own operator and cross-checked against the gaussian lane's impulse-response recovery.
 *   2. The plan: k from sigma alone (Impeller's rounding), the solved kernel that hits the target
 *      width exactly, and the passes per surface class.
 *   3. The quality, on the port: the new kernel against an ideal Gaussian and against the chain,
 *      and the beat (shift-variance) before and after.
 *   4. The passes `BlurPass` actually issues, on a recording GL: sizes, uniforms, the exact
 *      source-to-destination maps linear sampling requires, the pool, the upload.
 *   5. The flags, marks and gate (source).
 *   6. What a shot will see, by the sub-level rule.
 */

const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');
const RENDERER = readFileSync(join(__dirname, '../src/Core/WebGL2.Renderer.ts'), 'utf8').replace(/\r\n/g, '\n');
const PASS = readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8').replace(/\r\n/g, '\n');

const DELIVERED: SeparableRequest = { Sigma: 'delivered', Fetches: null };

/** The chain's own (k, depth, t) for a per-surface build of `radius` over a region that is small
 *  against the canvas (every glass card, every bar under 15%). */
const ChainShape = (radius: number, k = 1): { K: number; Depth: number; T: number } => {
  const depth = PyramidDepth(radius / k, 0);
  const t = Math.max(0.7, Math.min(1.3, Math.max(1, k > 1 ? radius / k : radius) / (3 * 2 ** depth)));
  return { K: k, Depth: depth, T: t };
};

// ── 1. THE INSTRUMENT ─────────────────────────────────────────────────────────────────────────

describe('blurfast > the delivered sigma, measured on the chain`s own operator', () => {
  it('reproduces GAUSS_MATCH_SIGMA at (k 1, depth 2, t 0.7) -- the gaussian lane`s 2.798809271', () => {
    expect(ChainDeliveredSigma(1, 2, 0.7)).toBeCloseTo(GAUSS_MATCH_SIGMA, 8);
  });

  it('agrees with the impulse-response recovery (`ChainKernel1D`) at every tap offset it can take', () => {
    for (const t of [0.7, 0.85, 1.0, 1.15, 1.3]) {
      expect(ChainDeliveredSigma(1, 2, t)).toBeCloseTo(ChainKernel1D(t).SigmaEff, 9);
    }
  });

  it('is the chain`s width at every depth, not a ratio of the radius: 2.80 / 5.74 / 11.54 / 23.11', () => {
    expect(ChainDeliveredSigma(1, 3, 0.7)).toBeCloseTo(5.735852160, 8);
    expect(ChainDeliveredSigma(1, 4, 0.7)).toBeCloseTo(11.539786249, 8);
    expect(ChainDeliveredSigma(1, 5, 0.7)).toBeCloseTo(23.113488, 5);
    // The delivered width over the authored radius wanders with the depth quantisation.
    for (const r of [8, 10, 24, 48, 96]) {
      const c = ChainShape(r);
      const ratio = ChainDeliveredSigma(1, c.Depth, c.T) / r;
      expect(ratio).toBeGreaterThan(0.24);
      expect(ratio).toBeLessThan(0.58);
    }
  });

  it('the line/parabola method equals a kernel`s own second moment on a plain table', () => {
    const k = GaussianKernelWith(3.1, 10);
    // The discrete kernel's variance, directly from the fetch table (Rakos pairs are exact in 1D).
    let m2 = 0;
    const w: number[] = [];
    for (let i = -10; i <= 10; i++) w.push(Math.exp(-(i * i) / (2 * 3.1 * 3.1)));
    const tot = w.reduce((a, b) => a + b, 0);
    for (let i = -10; i <= 10; i++) m2 += (w[i + 10] / tot) * i * i;
    // To the fp32 table's precision: the offsets and weights live in `Float32Array`s.
    expect(OperatorSigma1D((x) => SeparableOperator1D(x, 1, k), 1, 16)).toBeCloseTo(Math.sqrt(m2), 6);
  });

  it('a k > 1 chain (a full-canvas-sized region) is measured with its pre-downsample and the consumer`s bilinear', () => {
    // radius 96 over >= 15% of the canvas: k = 8, depth PyramidDepth(12) = 3.
    const s = ChainDeliveredSigma(8, 3, 0.7);
    expect(s).toBeGreaterThan(40);
    expect(s).toBeLessThan(50);
  });
});

// ── 2. THE PLAN ───────────────────────────────────────────────────────────────────────────────

describe('blurfast > k from the sigma alone', () => {
  it('Impeller`s rule: 1 at sigma <= 4, else 4 / sigma rounded to a power of two, clamped to 8', () => {
    expect(SeparableKFor(2.8)).toBe(1);
    expect(SeparableKFor(4)).toBe(1);
    expect(SeparableKFor(5.6)).toBe(1);           // log2(1.40) = 0.49 -> 0
    expect(SeparableKFor(5.74)).toBe(2);          // log2(1.43) = 0.52 -> 1
    expect(SeparableKFor(11.2)).toBe(2);
    expect(SeparableKFor(11.54)).toBe(4);
    expect(SeparableKFor(23.1)).toBe(8);
    expect(SeparableKFor(200)).toBe(8);
  });

  it('`?blur-k=floor` keeps at least four base texels of sigma', () => {
    expect(SeparableKFor(5.74, 'floor')).toBe(1);
    expect(SeparableKFor(8, 'floor')).toBe(2);
    expect(SeparableKFor(11.54, 'floor')).toBe(2);
    expect(SeparableKFor(23.1, 'floor')).toBe(4);
    for (let s = 4.01; s < 64; s += 0.37) expect(s / SeparableKFor(s, 'floor')).toBeGreaterThanOrEqual(4);
    for (let s = 4.01; s < 64; s += 0.37) expect(s / SeparableKFor(s)).toBeGreaterThanOrEqual(2 * Math.SQRT2 - 1e-9);
  });

  it('NO area enters the rule: the 15%-of-canvas gate is gone for a per-surface build', () => {
    expect(SeparableKFor.length).toBeLessThanOrEqual(2);
    const body = arrowBody(PASS, '_blurSeparable');
    expect(body).not.toContain('BaseDownsampleFactor');
    // ...and the chain's own gate is untouched for every build that is not this plan's.
    expect(BaseDownsampleFactor(8, 2560, 1600, { x: 0, y: 0, w: 568, h: 436 })).toBe(1);
  });
});

describe('blurfast > the solved kernel delivers the target width EXACTLY', () => {
  it('for every class the app authors, at dpr 2 and dpr 3', () => {
    for (const pt of [4, 5, 12, 14, 18, 24, 32, 40, 48]) {
      for (const dpr of [2, 3]) {
        const r = pt * dpr;
        const c = ChainShape(r);
        const plan = PlanSeparable(r, c.K, c.Depth, c.T, DELIVERED);
        if (!plan.Ok) throw new Error(`refused ${pt}pt@${dpr}: ${plan.Why}`);
        expect(plan.SigmaTarget).toBe(ChainDeliveredSigma(c.K, c.Depth, c.T));
        const got = SeparableDeliveredSigma(plan.K, plan.Kernel);
        expect(Math.abs(got - plan.SigmaTarget) / plan.SigmaTarget).toBeLessThan(1e-6);
      }
    }
  });

  it('the parameter is ABOVE the target at k = 1, because a 3-sigma truncation narrows a Gaussian', () => {
    const k = SolveSeparableKernel(GAUSS_MATCH_SIGMA, 1, Math.ceil(3 * GAUSS_MATCH_SIGMA));
    expect(k.Sigma).toBeGreaterThan(GAUSS_MATCH_SIGMA);
    expect(k.Sigma).toBeLessThan(GAUSS_MATCH_SIGMA * 1.01);
    expect(k.Fetches).toBe(11);
  });

  it('`?blur-sigma=authored` runs the radius itself -- the ~2.9x wider blur, as a separate arm', () => {
    const plan = PlanSeparable(8, 1, 2, 0.7, { Sigma: 'authored', Fetches: null });
    if (!plan.Ok) throw new Error(plan.Why);
    expect(plan.SigmaTarget).toBe(8);
    expect(plan.K).toBe(2);
    expect(SeparableDeliveredSigma(plan.K, plan.Kernel)).toBeCloseTo(8, 5);
  });

  it('`?blur-fetches=<n>` moves the COUNT and holds the sigma', () => {
    for (const n of [11, 25]) {
      const plan = PlanSeparable(8, 1, 2, 0.7, { Sigma: 'delivered', Fetches: n });
      if (!plan.Ok) throw new Error(plan.Why);
      expect(plan.Kernel.Fetches).toBe(n);
      expect(SeparableDeliveredSigma(plan.K, plan.Kernel)).toBeCloseTo(GAUSS_MATCH_SIGMA, 6);
    }
    expect(() => RadiusForFetches(12)).toThrow(/ODD/);
    expect(() => RadiusForFetches(65)).toThrow(/ODD/);
    expect(FetchesForRadius(RadiusForFetches(25))).toBe(25);
  });

  it('a kernel past the uniform table is REFUSED by name and the build keeps the chain', () => {
    const plan = PlanSeparable(1000, 1, PyramidDepth(1000, 0), 1.3, { Sigma: 'authored', Fetches: null });
    expect(plan.Ok).toBe(false);
    if (!plan.Ok) expect(plan.Why).toMatch(/^kernel-\d+-fetches-over-64$/);
  });
});

describe('blurfast > passes per build, per surface class', () => {
  /** [class, dpr, chain passes, plan passes, k, fetches] */
  const Row = (pt: number, dpr: number): { Chain: number; Plan: number; K: number; F: number } => {
    const r = pt * dpr;
    const c = ChainShape(r);
    const plan = PlanSeparable(r, c.K, c.Depth, c.T, DELIVERED);
    if (!plan.Ok) throw new Error(plan.Why);
    return { Chain: 2 * c.Depth, Plan: plan.Passes, K: plan.K, F: plan.Kernel.Fetches };
  };

  it('glass-grid (JwiftGlass, Blur 4pt): dpr 2 is 4 -> 2 at k 1; dpr 3 is 6 -> 3 at k 2', () => {
    expect(Row(4, 2)).toEqual({ Chain: 4, Plan: 2, K: 1, F: 11 });
    expect(Row(4, 3)).toEqual({ Chain: 6, Plan: 3, K: 2, F: 11 });
  });

  it('the app`s heavier classes: 14pt sheet 8 -> 4, 24pt 10 -> 5, 48pt 12 -> 5 (dpr 2)', () => {
    expect(Row(14, 2)).toEqual({ Chain: 8, Plan: 4, K: 4, F: 11 });
    expect(Row(24, 2)).toEqual({ Chain: 10, Plan: 5, K: 8, F: 11 });
    expect(Row(48, 2)).toEqual({ Chain: 12, Plan: 5, K: 8, F: 19 });
  });

  it('a full-canvas-sized surface the chain already re-based keeps its delivered width', () => {
    // A phone scrim: 840x1426 device px, radius 48 (24pt), >= 15% of the canvas, so the chain
    // runs k 8 and PyramidDepth(6) = 2 -- 3 + 4 = 7 passes. The plan: 5.
    const r = 48, k = BaseDownsampleFactor(r, 840, 1426, { x: 0, y: 0, w: 840, h: 1426 });
    expect(k).toBe(8);
    const c = ChainShape(r, k);
    const plan = PlanSeparable(r, k, c.Depth, c.T, DELIVERED);
    if (!plan.Ok) throw new Error(plan.Why);
    expect(ChainCost(840, 1426, k, c.Depth).Passes).toBe(7);
    expect(plan.Passes).toBe(5);
  });
});

// ── 3. THE QUALITY, ON THE PORT ───────────────────────────────────────────────────────────────

/** The kernel at each output phase of a shift-variant 1D operator with period `P`. */
const PhaseKernels = (op: (s: Float64Array) => Float64Array, P: number, N = 2048): Map<number, number>[] => {
  const C = (N >> 1) - ((N >> 1) % P);
  const resp: Float64Array[] = [];
  for (let p = 0; p < P; p++) { const s = new Float64Array(N); s[C + p] = 1; resp.push(op(s)); }
  const R = (N >> 1) - 16;
  const out: Map<number, number>[] = [];
  for (let ph = 0; ph < P; ph++) {
    const q0 = C + ph;
    const k = new Map<number, number>();
    for (let d = -R; d <= R; d++) {
      const c = q0 - d;
      const p = (((c - C) % P) + P) % P;
      k.set(d, resp[p][q0 - (c - (C + p))] ?? 0);
    }
    out.push(k);
  }
  return out;
};

/** Beat = the largest difference between two phases' kernels, over the peak. Max / PSNR against
 *  the ideal (untruncated, continuous-parameter) Gaussian of the delivered sigma. */
const Quality = (ks: Map<number, number>[], sigma: number): { Beat: number; MaxRel: number; Psnr: number } => {
  let peak = 0, beat = 0;
  for (const a of ks) for (const [, w] of a) peak = Math.max(peak, w);
  for (const a of ks) for (const b of ks) for (const [d, w] of a) beat = Math.max(beat, Math.abs(w - (b.get(d) ?? 0)));
  let tot = 0;
  for (let d = -600; d <= 600; d++) tot += Math.exp(-(d * d) / (2 * sigma * sigma));
  let maxd = 0, se = 0, n = 0, gp = 0;
  for (const a of ks) {
    for (const [d, w] of a) {
      const g = Math.exp(-(d * d) / (2 * sigma * sigma)) / tot;
      gp = Math.max(gp, g);
      maxd = Math.max(maxd, Math.abs(w - g));
      se += (w - g) ** 2;
      n++;
    }
  }
  return { Beat: beat / peak, MaxRel: maxd / gp, Psnr: 10 * Math.log10((gp * gp) / (se / n)) };
};

describe('blurfast > quality: a Gaussian where the chain was a staircase, and the beat', () => {
  const Sep = (pt: number, dpr: number, rule: 'round' | 'floor' = 'round') => {
    const r = pt * dpr;
    const c = ChainShape(r);
    const plan = PlanSeparable(r, c.K, c.Depth, c.T, { ...DELIVERED, KRule: rule });
    if (!plan.Ok) throw new Error(plan.Why);
    const kern: GaussianKernel = plan.Kernel;
    return {
      Plan: plan,
      Sep: Quality(PhaseKernels((x) => SeparableOperator1D(x, plan.K, kern), plan.K), plan.SigmaTarget),
      Chain: Quality(PhaseKernels((x) => ChainOperator1D(x, 1, c.Depth, c.T), 1 << c.Depth), plan.SigmaTarget),
    };
  };

  it('glass-grid dpr 2 (k 1): the beat is ZERO -- one kernel everywhere -- where the chain`s is 63%', () => {
    const q = Sep(4, 2);
    expect(q.Sep.Beat).toBeLessThan(1e-12);
    expect(q.Chain.Beat).toBeCloseTo(0.629, 2);
    // Against the ideal Gaussian of the SAME width: 75 dB and a 0.4% worst tap, where the chain's
    // staircase is 37 dB and 34%.
    expect(q.Sep.Psnr).toBeGreaterThan(74);
    expect(q.Sep.MaxRel).toBeLessThan(0.005);
    expect(q.Chain.Psnr).toBeLessThan(38);
    expect(q.Chain.MaxRel).toBeGreaterThan(0.34);
  });

  it('k > 1 is NOT shift-invariant, and says by how much: 11% at dpr-3 glass-grid against the chain`s 69%', () => {
    const q = Sep(4, 3);
    expect(q.Plan.K).toBe(2);
    expect(q.Sep.Beat).toBeGreaterThan(0.09);
    expect(q.Sep.Beat).toBeLessThan(0.12);
    expect(q.Chain.Beat).toBeGreaterThan(0.68);
    expect(q.Sep.Psnr).toBeGreaterThan(q.Chain.Psnr + 12);
  });

  it('every class is a better Gaussian than the chain it replaces, by >= 10 dB and a quarter of the beat', () => {
    for (const [pt, dpr] of [[4, 2], [4, 3], [5, 2], [12, 2], [14, 2], [18, 2], [24, 2], [48, 2]]) {
      const q = Sep(pt, dpr);
      expect(q.Sep.Psnr).toBeGreaterThan(q.Chain.Psnr + 10);
      expect(q.Sep.Beat).toBeLessThan(q.Chain.Beat / 3.5);
    }
  });

  it('`?blur-k=floor` is the higher-quality arm: the beat halves where it changes k', () => {
    const round = Sep(14, 2, 'round'), floor = Sep(14, 2, 'floor');
    expect(floor.Plan.K).toBe(2);
    expect(round.Plan.K).toBe(4);
    expect(floor.Sep.Beat).toBeLessThan(round.Sep.Beat / 2);
    expect(floor.Sep.Psnr).toBeGreaterThan(round.Sep.Psnr);
  });
});

// ── 4. THE PASSES BlurPass ISSUES ─────────────────────────────────────────────────────────────

const CANVAS_W = 2560, CANVAS_H = 1600;

interface Draw { W: number; H: number; Tag: string; U: Map<string, string> }

/** A FakeGl that also keeps, per draw, the destination size and the program's uniforms. */
const Rig = (): { Gl: FakeGl; Pass: BlurPass; Src: object; Draws: Draw[] } => {
  const gl = new FakeGl();
  const draws: Draw[] = [];
  const inner = gl.drawElements;
  const priv = gl as unknown as {
    _draw: { Attachment: { Tex: { Levels: Map<number, { W: number; H: number }> }; Level: number } } | null;
    _program: { Tag: string; Uniforms: Map<string, string> } | null;
  };
  (gl as unknown as { drawElements: () => void }).drawElements = () => {
    const a = priv._draw!.Attachment;
    const lv = a.Tex.Levels.get(a.Level)!;
    draws.push({ W: lv.W, H: lv.H, Tag: priv._program!.Tag, U: new Map(priv._program!.Uniforms) });
    inner();
  };
  const pass = new BlurPass(gl.Gl, undefined, 1);
  pass.EnsureGaussianProgram(undefined, 'boot');
  return { Gl: gl, Pass: pass, Src: gl.MakeSource(CANVAS_W, CANVAS_H, 'scene'), Draws: draws };
};

const nums = (s: string | undefined): number[] => (s ?? '').split(',').map(Number);

afterEach(() => {
  BlurPass.ForceFetches = null;
  BlurPass.GaussUploadPrefix = false;
});

describe('blurfast > what BlurPass issues', () => {
  const CARD: BackdropRect = { x: 95, y: 115, w: 562, h: 430 };

  it('k 1 (glass-grid dpr 2): TWO draws, temp then level 0, at the chain`s own resolved rect', () => {
    const r = Rig();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD, undefined, false, 'off', DELIVERED);
    expect(r.Draws.length).toBe(2);
    const rect = ResolveRegionRect(CARD, CANVAS_W, CANVAS_H, 4);
    expect([r.Draws[0].W, r.Draws[0].H]).toEqual([rect.W, rect.H + 18]);
    expect([r.Draws[1].W, r.Draws[1].H]).toEqual([rect.W, rect.H]);
    expect(nums(r.Draws[0].U.get('u_Fetches'))).toEqual([11]);
    const b = r.Pass.LastBuild;
    expect(b.Plan).toBe('separable');
    expect(b.Passes).toBe(2);
    expect(b.K).toBe(1);
    expect(b.SigmaTarget).toBeCloseTo(GAUSS_MATCH_SIGMA, 9);
    expect(r.Pass.LastDepth).toBe(0);
    // The consumer's map is the CHAIN's map: same rect, level 0 the rect's own size.
    const chain = Rig();
    chain.Pass.Blur(chain.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD, undefined, false, 'off', null);
    expect(JSON.stringify(r.Pass.LastRegion)).toBe(JSON.stringify(chain.Pass.LastRegion));
  });

  it('`separable = null` IS the chain: four draws, the byte-for-byte call stream of a call without it', () => {
    const a = Rig(), b = Rig();
    a.Pass.Blur(a.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD, undefined, false, 'off', null);
    b.Pass.Blur(b.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD);
    expect(a.Draws.length).toBe(4);
    expect(a.Gl.Calls).toEqual(b.Gl.Calls);
    expect(a.Gl.Texels).toEqual(b.Gl.Texels);
    expect(a.Pass.LastBuild.Plan).toBe('chain');
    expect(a.Pass.LastBuild.Passes).toBe(4);
  });

  it('k 2 (glass-grid dpr 3, radius 12): a box hop, then H and V on the padded base -- THREE draws', () => {
    const r = Rig();
    const card: BackdropRect = { x: 140, y: 170, w: 840, h: 640 };
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 12, 0, card, undefined, false, 'off', DELIVERED);
    expect(r.Draws.length).toBe(3);
    const b = r.Pass.LastBuild;
    expect(b.K).toBe(2);
    const R = 9;                                                      // ceil(3 * 5.736 / 2)
    const rect = ResolveRegionRect(card, CANVAS_W, CANVAS_H, 8);      // the chain's phase: 2^3
    const bw = Math.ceil(rect.W / 2), bh = Math.ceil(rect.H / 2);
    expect([r.Draws[0].W, r.Draws[0].H]).toEqual([bw + 2 * R, bh + 2 * R]);   // the base
    expect([r.Draws[1].W, r.Draws[1].H]).toEqual([bw, bh + 2 * R]);           // the temp
    expect([r.Draws[2].W, r.Draws[2].H]).toEqual([bw, bh]);                   // level 0
    // LastRegion maps the chain's screen rect onto level 0: same offsets, TexelsX the base's.
    const reg = r.Pass.LastRegion;
    expect(reg.ScaleX).toBe(CANVAS_W / (bw * 2));
    expect(reg.OffsetX).toBe(-rect.X / (bw * 2));
    expect(reg.TexelsX).toBe(bw);
    expect(reg.TexelsY).toBe(bh);
  });

  it('every map is an identity plus an INTEGER shift, which linear sampling requires', () => {
    const r = Rig();
    const card: BackdropRect = { x: 140, y: 170, w: 840, h: 640 };
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 12, 0, card, undefined, false, 'off', DELIVERED);
    const rect = ResolveRegionRect(card, CANVAS_W, CANVAS_H, 8);
    const R = 9, K = 2;
    const bw = Math.ceil(rect.W / K), bh = Math.ceil(rect.H / K);
    // Hop 1: destination texel i reads scene coordinate X0 + 2i + 1 -- a texel CORNER (the 2x2 box).
    const [sx, sy, sw, sh] = nums(r.Draws[0].U.get('u_SrcRect'));
    const W0 = r.Draws[0].W, H0 = r.Draws[0].H;
    for (const i of [0, 1, 17, W0 - 1]) {
      const u = (sx + ((i + 0.5) / W0) * sw) * CANVAS_W;
      expect(u).toBeCloseTo(rect.X - R * K + 2 * i + 1, 6);
    }
    for (const j of [0, H0 - 1]) {
      const v = (sy + ((j + 0.5) / H0) * sh) * CANVAS_H;
      expect(v).toBeCloseTo(rect.YBottom - R * K + 2 * j + 1, 6);
    }
    expect(nums(r.Draws[0].U.get('u_Offset'))).toEqual([1]);
    // H: temp column i reads base texel centre R + i.
    const [hx, , hw] = nums(r.Draws[1].U.get('u_SrcRect'));
    for (const i of [0, bw - 1]) expect((hx + ((i + 0.5) / bw) * hw) * W0).toBeCloseTo(R + i + 0.5, 6);
    // V: level-0 row j reads temp texel centre R + j.
    const [, vy, , vh] = nums(r.Draws[2].U.get('u_SrcRect'));
    for (const j of [0, bh - 1]) expect((vy + ((j + 0.5) / bh) * vh) * (bh + 2 * R)).toBeCloseTo(R + j + 0.5, 6);
  });

  it('the table goes up WHOLE -- 64 entries, zero past u_Fetches -- and prefix-only under ?gauss-upload=prefix', () => {
    const r = Rig();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD, undefined, false, 'off', DELIVERED);
    const off = nums(r.Draws[0].U.get('u_Off[0]'));
    expect(off.length).toBe(GAUSS_MAX_FETCHES);
    expect(off.slice(11).every((v) => v === 0)).toBe(true);
    BlurPass.GaussUploadPrefix = true;
    const p = Rig();
    p.Pass.Blur(p.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD, undefined, false, 'off', DELIVERED);
    expect(nums(p.Draws[0].U.get('u_Off[0]')).length).toBe(11);
  });

  it('?blur-fetches forces the count on BOTH separable paths', () => {
    BlurPass.ForceFetches = 25;
    const r = Rig();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD, undefined, false, 'off', DELIVERED);
    expect(nums(r.Draws[0].U.get('u_Fetches'))).toEqual([25]);
    const g = Rig();
    g.Pass.Blur(g.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD, undefined, false, 'match');
    expect(nums(g.Draws[0].U.get('u_Fetches'))).toEqual([25]);
    expect(g.Pass.LastGaussianSigma).toBe(GAUSS_MATCH_SIGMA);
  });

  it('the target pool allocates once: a second identical build reallocates NOTHING', () => {
    const r = Rig();
    const card: BackdropRect = { x: 140, y: 170, w: 840, h: 640 };
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 24, 0, card, undefined, false, 'off', DELIVERED);
    r.Gl.Reset();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 24, 0, card, undefined, false, 'off', DELIVERED);
    expect(r.Gl.Calls.filter((c) => c === 'texImage2D').length).toBe(0);
    expect(r.Pass.SeparableTargetCensus).toMatch(/^3:/);   // k 4: two hops + the temp
  });

  it('the plan refuses by name where it must, and the build is the chain', () => {
    const r = Rig();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, undefined, undefined, false, 'off', DELIVERED);
    expect(r.Pass.LastSeparableRefusal).toBe('full-canvas');
    expect(r.Pass.LastBuild.Plan).toBe('chain');
  });

  it('every separable target is written WHOLE before anything reads it', () => {
    const r = Rig();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 24, 0, { x: 140, y: 170, w: 840, h: 640 },
      undefined, false, 'off', DELIVERED);
    const c = r.Pass.LastGaussianCover;
    expect(c.Written).toBe(c.Readable);
    expect(c.Written).toBeGreaterThan(0);
  });

  it('the draw counter counts every draw, whichever plan', () => {
    const r = Rig();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD, undefined, false, 'off', DELIVERED);
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, 8, 0, CARD, undefined, false, 'off', null);
    expect(r.Pass.Draws).toBe(6);
  });
});

describe('blurfast > the arithmetic the census prints', () => {
  it('glass-grid`s union at dpr 2: separable writes and reads more than the chain -- k 1, 11 fetches', () => {
    const rect = { X: 52, YBottom: 72, W: 2456, H: 1456 };
    const plan = PlanSeparable(8, 1, 2, 0.7, DELIVERED);
    if (!plan.Ok) throw new Error(plan.Why);
    const t = PlanSeparableTargets(rect, plan.K, plan.Kernel);
    const c = ChainCost(rect.W, rect.H, 1, 2);
    expect(c.Fill).toBe(5587400);
    expect(t.Fill).toBe(2456 * (1456 + 18) + 2456 * 1456);
    expect(t.Reads / c.Reads).toBeGreaterThan(1.9);
    expect(t.Reads / c.Reads).toBeLessThan(2.0);
  });

  it('...and at dpr 3 k 2 reads FEWER texels than the chain, which is why the rule rounds', () => {
    const rect = { X: 78, YBottom: 108, W: 3688, H: 2184 };
    const plan = PlanSeparable(12, 1, 3, 0.7, DELIVERED);
    if (!plan.Ok) throw new Error(plan.Why);
    expect(plan.K).toBe(2);
    const t = PlanSeparableTargets(rect, plan.K, plan.Kernel);
    const c = ChainCost(rect.W, rect.H, 1, 3);
    expect(t.Reads).toBeLessThan(c.Reads);
    const floor = PlanSeparable(12, 1, 3, 0.7, { ...DELIVERED, KRule: 'floor' });
    if (!floor.Ok) throw new Error(floor.Why);
    const tf = PlanSeparableTargets(rect, floor.K, floor.Kernel);
    expect(tf.Reads / c.Reads).toBeGreaterThan(3);
  });
});

// ── 5. FLAGS, MARKS, GATE ─────────────────────────────────────────────────────────────────────

describe('blurfast > the flag, the control arm and the census (source)', () => {
  it('the plan is the DEFAULT in both places, or the worker path would compile for one and run the other', () => {
    expect(JAUI).toContain('private _blurSeparable = true;');
    expect(RENDERER).toContain('DiagBlurSeparable = true;');
    expect(RENDERER).toContain("this._blur.EnsureGaussianProgram(batch, 'boot');");
  });

  it('`?blur-chain=on` (or bare) is the chain; anything else throws by name', () => {
    expect(JAUI).toContain("this._blurSeparable = raw === 'off';");
    expect(JAUI).toContain("throw new Error(`[Jaui] ?blur-chain takes 'on' or 'off', got '${raw}'`);");
    expect(JAUI).toContain("throw new Error(`[Jaui] ?blur-sigma takes 'delivered' or 'authored', got '${raw}'`);");
    expect(JAUI).toContain("throw new Error(`[Jaui] ?blur-k takes 'round' or 'floor', got '${raw}'`);");
    expect(JAUI).toContain("throw new Error(`[Jaui] ?gauss-upload takes 'full' or 'prefix', got '${raw}'`);");
  });

  it('the four arms it supersedes are refused BY NAME; glass-group and shadow-probe compose', () => {
    for (const why of [
      'pyramid-atlas-packs-chain-levels-and-is-superseded-by-the-separable-plan',
      'border-direct-gathers-the-chain-s-hops-and-is-superseded-by-the-separable-plan',
      'glass-presample-re-bases-a-chain-and-is-superseded-by-the-separable-plan',
      'glass-gaussian-is-the-separable-arm-this-plan-supersedes',
    ]) expect(JAUI).toContain(why);
    const start = JAUI.indexOf('if (this._blurSeparable) {');
    const block = JAUI.slice(start, JAUI.indexOf('this._renderer.DiagBlurSeparable', start));
    expect(block).not.toContain('glass-group');
    expect(block).not.toContain('shadow-probe');
  });

  it('the group`s union takes the plan; the shared backdrop and pblur never see it', () => {
    const group = arrowBody(RENDERER, 'ComputeBlurGroup');
    expect(group).toContain("'off', sepReq);");
    const shared = arrowBody(RENDERER, 'BuildSharedBackdrop');
    expect(shared).not.toContain('sepReq');
    expect(JAUI.split('this._maySeparable(plan)').length - 1).toBe(3);
  });

  it('the mark and the gate carry every column the brief names, both sides', () => {
    expect(JAUI).toContain('JTrace(`jaui:blur-plan armed=${this._blurSeparable ? \'separable\' : \'chain\'}`');
    for (const col of ['passesPerFrame=', 'builds=', 'passes=', 'passesPerBuild=', 'texelsRead=', 'fill=',
      'chainBuilds=', 'chainPasses=', 'chainTexelsRead=', 'chainFill=', 'classes=', 'blurDraws=',
      'targets=', 'tempCover=', 'planRefused=']) {
      expect(JAUI).toContain(col);
    }
    // k, sigmaAuthored, sigmaResidual and fetches ride in each class key.
    expect(RENDERER).toContain('`sep:a${_r2(b.SigmaAuthored)}>t${_r2(b.SigmaTarget)}@k${b.K}r${_r2(b.SigmaResidual)}f${b.Fetches}`');
    expect(JAUI).toContain('__jauiBlurPlan');
  });
});

// ── 6. WHAT A SHOT WILL SEE ───────────────────────────────────────────────────────────────────

describe('blurfast > what a shot will see, by the sub-level rule (card 0 of glass-grid, dpr 2)', () => {
  // Both arms over card 0's region on the harness's own seeded bed, three channels, cropped to
  // the card box -- the gaussian lane's geometry, with this plan's SOLVED table in place of
  // `GaussianKernelFor(GAUSS_MATCH_SIGMA)`.
  const DPR = 2, FILL_MARGIN = 4 * DPR + (2.5 * DPR) * 8 + 0.25 * 3 + 8 * DPR;
  const box = { x: 60 * DPR, y: 70 * DPR, w: 216 * DPR, h: 150 * DPR };
  const region: BackdropRect = {
    x: Math.floor(box.x - FILL_MARGIN), y: Math.floor(box.y - FILL_MARGIN),
    w: Math.ceil(box.w + 2 * FILL_MARGIN), h: Math.ceil(box.h + 2 * FILL_MARGIN),
  };
  const r = ResolveRegionRect(region, CANVAS_W, CANVAS_H, 4);
  const ryTop = CANVAS_H - (r.YBottom + r.H);
  const plan = PlanSeparable(8, 1, 2, 0.7, DELIVERED);
  if (!plan.Ok) throw new Error(plan.Why);
  const kern = plan.Kernel;
  const pad = kern.Radius;
  const sw = r.W + 2 * pad, sh = r.H + 2 * pad;
  const ins = 12 * DPR;
  const crop = (p: Float64Array): Float64Array => {
    const cw = r.W - 2 * ins, chh = r.H - 2 * ins;
    const out = new Float64Array(cw * chh);
    let n = 0;
    for (let j = ins; j < ins + chh; j++) for (let i = ins; i < ins + cw; i++) out[n++] = p[j * r.W + i];
    return out;
  };
  const chain: Float64Array[] = [], sep: Float64Array[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const src = BedTile(r.X - pad, ryTop - pad, sw, sh, ch);
    chain.push(crop(ChainArm(src, sw, sh, pad, pad, r.W, r.H, 0.7)));
    const temp = Pass1D(src, sw, sh, pad, 0, r.W, sh, kern, 'x');
    sep.push(crop(Pass1D(temp.Data, r.W, sh, 0, pad, r.W, r.H, kern, 'y').Data));
  }

  it('differs inside the card by at most a few levels, and the rule counts the sub-level crossings', () => {
    const p = PredictDiffering(chain, sep);
    const max = Math.max(...chain.map((c, i) => MaxDev(c, sep[i])));
    const mean = chain.reduce((t, c, i) => t + MeanDev(c, sep[i]), 0) / 3;
    // Pinned so the report's prediction cannot drift from the kernel it describes.
    expect(p.Pixels).toBeGreaterThan(190000);
    expect(p.Expected).toBeGreaterThan(4000);
    expect(p.Expected).toBeLessThan(12000);
    expect(max).toBeLessThan(6);
    expect(mean).toBeLessThan(0.1);
  });
});
