import { describe, it, expect } from 'vitest';
import { OperatorSigma1D, SolveSeparableKernel } from '../src/Core/Blur.Separable';
import { GlassPyramidLevel, GlassBlurNeedsOf } from '../src/Core/Glass.Pipeline';

/**
 * A glass read asks for a Gaussian of 2^lod device px and finds the level of its pyramid that delivers it.
 * The law is checked against the passes themselves in 1D: level 0 at `1/k` delivering sigma0 (the separable
 * build), the MIP hops (`MIP_FRAG`, taps at +-0.75 source texel) and the consumer's bilinear read.
 */
const L1 = (s: Float64Array, x: number): number => {
  const f = x - 0.5; const i0 = Math.floor(f); const a = f - i0; const n = s.length;
  const g0 = s[i0 < 0 ? 0 : i0 >= n ? n - 1 : i0]; const i1 = i0 + 1;
  return g0 * (1 - a) + s[i1 < 0 ? 0 : i1 >= n ? n - 1 : i1] * a;
};
const mip = (s: Float64Array): Float64Array => {
  const n = Math.max(1, Math.floor(s.length / 2)); const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = 0.5 * (L1(s, 2 * i + 1 - 0.75) + L1(s, 2 * i + 1 + 0.75));
  return o;
};
const read = (sigma0: number, k: number, level: number) => (s: Float64Array): Float64Array => {
  const kern = SolveSeparableKernel(sigma0, k, Math.ceil((3 * sigma0) / k));
  let cur = s;
  for (let q = k; q > 1; q >>= 1) {
    const n = Math.floor(cur.length / 2); const o = new Float64Array(n);
    for (let i = 0; i < n; i++) o[i] = 0.5 * (cur[2 * i] + cur[2 * i + 1]);
    cur = o;
  }
  const g = new Float64Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    let a = 0; for (let f = 0; f < kern.Fetches; f++) a += L1(cur, i + 0.5 + kern.Offsets[f]) * kern.Weights[f];
    g[i] = a;
  }
  cur = g;
  for (let i = 0; i < level; i++) cur = mip(cur);
  const o = new Float64Array(s.length); const sc = cur.length / s.length;
  for (let i = 0; i < s.length; i++) o[i] = L1(cur, (i + 0.5) * sc);
  return o;
};

describe('GlassPyramidLevel: the level that delivers a sigma', () => {
  for (const [sigma0, k] of [[2.8, 1], [5.74, 2], [11.5, 4]]) {
    it(`whole levels land their own sigma (level 0 ${sigma0} px at k ${k})`, () => {
      for (let level = 1; level <= 5; level++) {
        const period = k * (1 << level);
        const delivered = OperatorSigma1D(read(sigma0, k, level), period, period * 8 + 3 * sigma0 + 8 * k);
        expect(GlassPyramidLevel(delivered, k, sigma0)).toBeCloseTo(level, 1);
      }
    });
  }

  it('never reads sharper than level 0, and is monotone', () => {
    expect(GlassPyramidLevel(1, 1, 2.8)).toBe(0);
    let last = 0;
    for (let s = 3; s < 200; s *= 1.1) { const l = GlassPyramidLevel(s, 1, 2.8); expect(l).toBeGreaterThanOrEqual(last); last = l; }
  });

  it('builds a menu deep enough for its colored shadow, at a native level 0', () => {
    const needs = GlassBlurNeedsOf(250, 3, 'Regular', false);
    expect(needs.MaxLod).toBeGreaterThanOrEqual(Math.ceil(GlassPyramidLevel(0.62 / 0.25 * 48, 1, 0)));
  });
});
