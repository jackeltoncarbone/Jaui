import { describe, expect, it } from 'vitest';
import { HopReach, MIP_TAP_TEXELS, PyramidSampleReach } from '../src/Core/Pyramid.Reach';
import { BACKDROP_REGION_FULL, type BackdropRegion } from '../src/Core/Renderer';
import { GaussianKernelWith } from '../src/Core/Blur.Separable';

/**
 * The reach bound, held to the passes it describes. One axis of each pass is simulated on the CPU the way
 * the GPU runs it (bilinear taps, texel centres at i + 0.5, CLAMP_TO_EDGE), and the scene pixels that can
 * move a sample are found by linearity: a unit impulse at each pixel, and a non-zero response is a pixel
 * the sample depends on. None of them may lie farther from the sample than the bound says.
 */

type Level = Float64Array;

/** A bilinear tap of `src` at `p`, in its own texels. */
const tap = (src: Level, p: number): number => {
  const x = p - 0.5;
  const i0 = Math.floor(x), f = x - i0;
  const at = (i: number): number => src[Math.min(src.length - 1, Math.max(0, i))];
  return (1 - f) * at(i0) + f * at(i0 + 1);
};

/** One pass: `dst` texels over the same span as `src`, each a weighted sum of taps at offsets in SOURCE texels. */
const pass = (src: Level, dstN: number, taps: readonly [number, number][]): Level => {
  const out = new Float64Array(dstN);
  const total = taps.reduce((s, t) => s + t[1], 0);
  for (let j = 0; j < dstN; j++) {
    const c = ((j + 0.5) / dstN) * src.length;
    let v = 0;
    for (const [o, w] of taps) v += tap(src, c + o) * w;
    out[j] = v / total;
  }
  return out;
};

// The one-axis projections of BlurPass's kernels.
const DOWN = (o: number): [number, number][] => [[0, 4], [-0.5 * o, 2], [0.5 * o, 2]];
const UP = (o: number): [number, number][] => [[-o, 1], [o, 1], [-0.5 * o, 4], [0.5 * o, 4], [0, 2]];
const MIP: [number, number][] = [[-MIP_TAP_TEXELS, 2], [MIP_TAP_TEXELS, 2]];

/** A dual-filter chain of `depth` over `n` device px at base factor `k`: the levels, and the reach the build books. */
const chain = (scene: Level, k: number, depth: number, o: number): { L0: Level; Reach: number } => {
  let src = scene, reach = 0;
  for (let s = 0; (1 << s) < k; s++) {
    reach += HopReach(0.5, s === 0 ? 1 : scene.length / src.length);
    src = pass(src, Math.floor(src.length / 2), DOWN(1));
  }
  const levels: Level[] = [src];
  for (let i = 1; i <= depth; i++) {
    reach += HopReach(0.5 * o, i === 1 && k === 1 ? 1 : scene.length / src.length);
    src = pass(src, Math.floor(src.length / 2), DOWN(o));
    levels.push(src);
  }
  for (let i = depth - 1; i >= 0; i--) {
    reach += HopReach(o, scene.length / src.length);
    src = pass(src, levels[i].length, UP(o));
  }
  return { L0: src, Reach: reach };
};

/** The mip level `lod` of a level 0, built as `GenerateOutputMipmap` builds it. */
const mip = (l0: Level, lod: number): Level => {
  let src = l0;
  for (let i = 0; i < lod && src.length > 1; i++) src = pass(src, Math.max(1, Math.floor(src.length / 2)), MIP);
  return src;
};

const regionOf = (n: number, texels: number, reach: number): BackdropRegion =>
  ({ ...BACKDROP_REGION_FULL, TexelsX: texels, TexelsY: texels, Texel: n / texels, Reach: reach });

/** The farthest scene pixel centre, from device position `p`, that moves a sample of `build` there. */
const farthest = (n: number, p: number, build: (scene: Level) => Level): number => {
  const base = build(new Float64Array(n));
  let far = 0;
  for (let i = 0; i < n; i++) {
    const s = new Float64Array(n);
    s[i] = 1;
    const out = build(s);
    const v = tap(out, (p / n) * out.length);
    if (Math.abs(v - tap(base, (p / n) * base.length)) > 1e-12) far = Math.max(far, Math.abs(i + 0.5 - p));
  }
  return far;
};

describe('PyramidSampleReach', () => {
  it('bounds every scene pixel a chain level can read, at every level and base factor', () => {
    const n = 192;
    const ps = [96, 97.3, 104.75];
    for (const [k, depth, o] of [[1, 1, 1], [1, 2, 0.7], [1, 3, 1.3], [2, 2, 1], [4, 1, 0.9]] as const) {
      const { L0, Reach } = chain(new Float64Array(n), k, depth, o);
      // far[level][p]: the farthest pixel an impulse at it moved the sample at p on that level.
      const far = [0, 1, 2, 3].map(() => ps.map(() => 0));
      for (let i = 0; i < n; i++) {
        const s = new Float64Array(n);
        s[i] = 1;
        let lv = chain(s, k, depth, o).L0;
        for (let level = 0; level <= 3; level++) {
          if (level > 0) lv = mip(lv, 1);
          ps.forEach((p, j) => {
            if (Math.abs(tap(lv, (p / n) * lv.length)) > 1e-12) far[level][j] = Math.max(far[level][j], Math.abs(i + 0.5 - p));
          });
        }
      }
      for (const lod of [0, 0.5, 1, 1.35, 2, 3]) {
        const bound = PyramidSampleReach(regionOf(n, L0.length, Reach), lod, n, n);
        ps.forEach((p, j) => {
          const reached = Math.max(far[Math.floor(lod)][j], far[Math.ceil(lod)][j]);
          expect(reached, `k=${k} depth=${depth} o=${o} lod=${lod} p=${p}`).toBeLessThanOrEqual(bound);
          expect(reached).toBeGreaterThan(0);
        });
      }
    }
  });

  it('bounds the separable plan: box hops, then the linear-sampled pair at the base', () => {
    const n = 192, p = 97.3;
    for (const [K, sigma, radius] of [[1, 4, 12], [2, 3.2, 10], [4, 2.5, 8]] as const) {
      const kern = GaussianKernelWith(sigma, radius);
      const taps: [number, number][] = [];
      let far = kern.Radius;
      for (let i = 0; i < kern.Fetches; i++) { taps.push([kern.Offsets[i], kern.Weights[i]]); far = Math.max(far, Math.abs(kern.Offsets[i])); }
      const build = (s: Level): Level => {
        let src = s;
        for (let h = 1; h < K; h *= 2) src = pass(src, Math.floor(src.length / 2), DOWN(1));
        return pass(src, src.length, taps);
      };
      let reach = 0;
      for (let h = 1, t = 1; h < K; h *= 2, t *= 2) reach += HopReach(0.5, t);
      reach += HopReach(far, K);
      const l0 = build(new Float64Array(n));
      for (const lod of [0, 1, 2]) {
        const bound = PyramidSampleReach(regionOf(n, l0.length, reach), lod, n, n);
        expect(farthest(n, p, (s) => mip(build(s), Math.ceil(lod))), `K=${K} lod=${lod}`).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('bounds a sharp root, which reads one pixel a texel', () => {
    const n = 128;
    for (const lod of [0, 1, 2.5, 3]) {
      const bound = PyramidSampleReach(regionOf(n, n, HopReach(0, 1)), lod, n, n);
      const far = farthest(n, 64.2, (s) => mip(pass(s, n, [[0, 1]]), Math.ceil(lod)));
      expect(far).toBeLessThanOrEqual(bound);
    }
  });

  it('says nothing for a region that does not say how its level 0 was made', () => {
    expect(PyramidSampleReach(BACKDROP_REGION_FULL, 0, 100, 100)).toBe(Infinity);
    expect(PyramidSampleReach({ ...regionOf(100, 100, 2), Reach: Infinity }, 1, 100, 100)).toBe(Infinity);
  });

  it('is far narrower than a wide pyramid: the tab bar strip at level 3', () => {
    // The phone's bottom scroll edge: a sharp root 805 x 313 over the canvas width, read at LOD 3.
    const region: BackdropRegion = { ...BACKDROP_REGION_FULL, ScaleY: 5.588, TexelsX: 805, TexelsY: 313, Texel: 1, Reach: 1 };
    const reach = PyramidSampleReach(region, 3, 805, 1749);
    expect(reach).toBeLessThan(30);
  });
});
