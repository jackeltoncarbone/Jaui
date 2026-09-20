import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plane, down, up, chain, directGather, directL2, type Plane } from './Border.Kernel.Source';
import {
  BORDER_DIRECT_DEPTH, BORDER_DIRECT_PHASE, BORDER_DIRECT_L1_WINDOW, BORDER_DIRECT_L2_WINDOW,
  BORDER_DIRECT_MAX_TAP_OFFSET, BorderDirectTapOffset,
} from '../src/Core/Border.Direct';
import { PyramidDepth } from '../src/Core/BlurPass';

/**
 * THE KERNEL THE GLASS BORDER ACTUALLY READS, derived rather than asserted.
 *
 * `Border.Kernel.Source.ts` is a CPU port of `BlurPass`'s four hops, transcribed from the GLSL.
 * This file pushes deltas and images through it and pins what comes out -- because the border's
 * direct path replaces four render passes with one convolution and the ONLY defensible way to
 * write that convolution is to know exactly what the four passes compute.
 *
 * Three claims, in the order they build on each other:
 *
 *   1. at a tap offset of 1 or less a DOWN hop is a BIT-EXACT 2x2 box, so level 2 is a bit-exact
 *      4x4 box of the source and can be gathered in four bilinear taps instead of reconstructed;
 *   2. the level-0 value one border fragment reads therefore has a 16x16 SOURCE footprint, a
 *      4-wide level-2 window and a 3-wide level-1 window -- which is what the shader declares;
 *   3. the direct gather reproduces the four-hop chain to float rounding, on a real image, at
 *      every phase and at both ends of the admitted tap-offset range.
 */

/** `JwiftGlass` authors `BackdropFilter: Blur(4pt)`; at dpr 2 that is `Radius = 8` device px. */
const RADIUS = 8;
const TAP = BorderDirectTapOffset(RADIUS, BORDER_DIRECT_DEPTH);

describe('Border kernel > the DOWN hop is an exact box', () => {
  it('a delta reaches exactly ONE level-2 cell, at weight 1/16, for every source phase', () => {
    const W = 64, H = 64;
    for (let sy = 28; sy < 32; sy++) {
      for (let sx = 28; sx < 32; sx++) {
        const src = plane(W, H);
        src.data[sy * W + sx] = 1;
        const { l2 } = chain(src, TAP);
        const hits: Array<[number, number, number]> = [];
        for (let j = 0; j < l2.h; j++) {
          for (let i = 0; i < l2.w; i++) {
            const v = l2.data[j * l2.w + i];
            if (Math.abs(v) > 1e-15) hits.push([i, j, v]);
          }
        }
        expect(hits.length, `source (${sx},${sy})`).toBe(1);
        expect(hits[0][0]).toBe(Math.floor(sx / 4));
        expect(hits[0][1]).toBe(Math.floor(sy / 4));
        // 1/16 in EXACT arithmetic: the centre tap's weight-4 at fraction 0.5 gives 1 per texel
        // and the four corner taps sum to (u+v) x (u+v) with u+v = (1,1), so each of the sixteen
        // source texels under a level-2 cell carries exactly 1/16. In FLOAT it is 1/16 to a ulp of
        // the accumulation order (this one lands on 0.06249999999999999 in float64), and that is
        // worth being exact about rather than rounding over: the identity is algebraic, the
        // residual is summation order, and at ~1.4e-17 it is thirteen orders under the 1/1023
        // quantum the pyramid stores each level at.
        expect(hits[0][2]).toBeCloseTo(1 / 16, 15);
        expect(Math.abs(hits[0][2] - 1 / 16)).toBeLessThan(4 * Number.EPSILON / 16);
      }
    }
  });

  it('holds across the WHOLE admitted tap-offset range, and breaks above 1.0', () => {
    const W = 32, H = 32;
    const exactBox = (t: number): boolean => {
      const src = plane(W, H);
      src.data[13 * W + 13] = 1;
      const d = down(src, t);
      let hits = 0, val = 0;
      for (const v of d.data) if (Math.abs(v) > 1e-15) { hits++; val = v; }
      return hits === 1 && Math.abs(val - 0.25) < 8 * Number.EPSILON;
    };
    for (const t of [0.7, 0.71, 0.72, 0.73, 0.74, 0.7499, BORDER_DIRECT_MAX_TAP_OFFSET, 0.9, 1.0]) {
      expect(exactBox(t), `t = ${t}`).toBe(true);
    }
    // Above 1 the corner taps cross out of the texel pair, `u + v` stops being `(1, 1)`, and the
    // hop spreads. This is what `BORDER_DIRECT_MAX_TAP_OFFSET` exists to keep out -- recorded here
    // so nobody raises the ceiling without seeing the thing it holds back.
    expect(exactBox(1.1)).toBe(false);
    expect(exactBox(1.3)).toBe(false);
  });

  it('the shader gathers a level-2 cell the same way the chain computes it', () => {
    const W = 32, H = 32;
    const src = plane(W, H);
    for (let i = 0; i < W * H; i++) src.data[i] = Math.sin(i * 0.37) * 0.5 + 0.5;
    const { l2 } = chain(src, TAP);
    for (let j = 0; j < l2.h; j++) {
      for (let i = 0; i < l2.w; i++) {
        expect(directL2(src, i, j)).toBeCloseTo(l2.data[j * l2.w + i], 12);
      }
    }
  });
});

describe('Border kernel > the footprint, and the windows the shader declares', () => {
  it('one source texel spreads over exactly 16x16 level-0 texels, summing to 1', () => {
    const W = 64, H = 64;
    const src = plane(W, H);
    src.data[30 * W + 29] = 1;
    const { l0 } = chain(src, TAP);
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, sum = 0;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const v = l0.data[j * W + i];
        if (Math.abs(v) > 1e-15) {
          minx = Math.min(minx, i); maxx = Math.max(maxx, i);
          miny = Math.min(miny, j); maxy = Math.max(maxy, j);
          sum += v;
        }
      }
    }
    expect(maxx - minx + 1).toBe(BORDER_DIRECT_L2_WINDOW * BORDER_DIRECT_PHASE);
    expect(maxy - miny + 1).toBe(BORDER_DIRECT_L2_WINDOW * BORDER_DIRECT_PHASE);
    // Partition of unity: the chain is an average, so a delta's response sums to exactly 1.
    expect(sum).toBeCloseTo(1, 12);
  });

  it('the level-2 kernel per phase is 4x4, sums to 1, and is NOT separable', () => {
    // Reconstructed by running single level-2 impulses through the two UP hops, which is the
    // operator the shader evaluates analytically. Pinned because it is the one part of the design
    // a reader cannot check by eye, and because a change to `UP_FRAG` must fail here loudly.
    const L2 = 16, L1 = 32, L0 = 64;
    const respAt = (qx: number, qy: number, px: number, py: number): number => {
      const im: Plane = plane(L2, L2);
      im.data[qy * L2 + qx] = 1;
      const a = up(im, L1, L1, TAP);
      const b = up(a, L0, L0, TAP);
      return b.data[py * L0 + px];
    };
    for (const [phx, phy] of [[0, 0], [1, 1], [2, 3], [3, 2]] as const) {
      const px = 32 + phx, py = 32 + phy;
      const q0x = phx < 2 ? 6 : 7, q0y = phy < 2 ? 6 : 7;
      const M: number[][] = [];
      let sum = 0;
      for (let j = 0; j < BORDER_DIRECT_L2_WINDOW; j++) {
        const row: number[] = [];
        for (let i = 0; i < BORDER_DIRECT_L2_WINDOW; i++) {
          const v = respAt(q0x + i, q0y + j, px, py);
          row.push(v); sum += v;
        }
        M.push(row);
      }
      expect(sum, `phase (${phx},${phy})`).toBeCloseTo(1, 12);
      // Not a product of two 1D kernels: the UP tent is a SUM of three separable terms, so a
      // "just do it separably" simplification would be a different picture, not a cheaper one.
      const d = M[1][1] * M[0][0] - M[1][0] * M[0][1];
      expect(Math.abs(d)).toBeGreaterThan(1e-9);
    }
    // The centre phase, pinned to the digit. Any edit to DOWN_FRAG, UP_FRAG or the tap offset
    // moves these and has to be looked at rather than absorbed.
    const centre = [
      [0.000165972, 0.008902040, 0.012945833, 0.000711849],
      [0.008902040, 0.156404774, 0.204110634, 0.025947135],
      [0.012945833, 0.204110634, 0.262570139, 0.036467144],
      [0.000711849, 0.025947135, 0.036467144, 0.002689844],
    ];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        expect(respAt(6 + i, 6 + j, 32, 32)).toBeCloseTo(centre[j][i], 9);
      }
    }
  });

  it('never reads outside the 3-wide level-1 and 4-wide level-2 windows, at any phase or edge', () => {
    const W = 48, H = 48;
    const src = plane(W, H);
    for (let i = 0; i < W * H; i++) src.data[i] = (i * 2654435761 % 1000) / 1000;
    for (const t of [0.7, 0.72, 0.7499]) {
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const { windows } = directGather(src, px, py, t);
          for (const k of windows.L1Touched) {
            expect(k, `L1 window at (${px},${py}) t=${t}`).toBeGreaterThanOrEqual(0);
            expect(k).toBeLessThan(BORDER_DIRECT_L1_WINDOW);
          }
          for (const k of windows.L2Touched) {
            expect(k, `L2 window at (${px},${py}) t=${t}`).toBeGreaterThanOrEqual(0);
            expect(k).toBeLessThan(BORDER_DIRECT_L2_WINDOW);
          }
        }
      }
    }
  });
});

describe('Border kernel > the direct gather IS the four-hop chain', () => {
  const runImage = (W: number, H: number, t: number, seed: number): void => {
    const src = plane(W, H);
    for (let i = 0; i < W * H; i++) {
      src.data[i] = 0.5 + 0.5 * Math.sin(i * 0.113 + seed) * Math.cos((i % W) * 0.37 - seed);
    }
    const { l0 } = chain(src, t);
    let worst = 0;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const { value } = directGather(src, px, py, t);
        worst = Math.max(worst, Math.abs(value - l0.data[py * W + px]));
      }
    }
    // 1e-12 is float64 noise from a different summation order, not a different kernel. On the GPU
    // the arithmetic is float32 and the tap ORDER is preserved by construction -- the shader's
    // eight UP taps are written in `UP_FRAG`'s order -- so the residual there is the two
    // formulations' own last-bit difference, and it is far under the 10-bit quantisation the
    // pyramid is doing four times and the direct path is not doing at all.
    expect(worst).toBeLessThan(1e-12);
  };

  it('matches on the INTERIOR and at the CLAMPED edges, at the bottom of the tap range', () => {
    runImage(32, 32, 0.7, 1.1);
  });

  it('matches at the top of the admitted tap range', () => {
    runImage(32, 32, 0.7499, 2.3);
  });

  it('matches on a non-square region whose extent is a multiple of the phase', () => {
    runImage(40, 24, TAP, 0.7);
  });
});

describe('Border kernel > the routing bound, read off the shipped expressions', () => {
  it('depth 2 and a tap offset under the ceiling is exactly radius in (3, 9)', () => {
    for (const r of [3.01, 4, 6, 8, 8.99]) {
      expect(PyramidDepth(r, 0), `radius ${r}`).toBe(BORDER_DIRECT_DEPTH);
      expect(BorderDirectTapOffset(r, BORDER_DIRECT_DEPTH)).toBeLessThan(BORDER_DIRECT_MAX_TAP_OFFSET);
    }
    // radius 9 is still depth 2 but lands EXACTLY on the ceiling, where the level-1 window would
    // widen to 4. Refused, deliberately: 4.5pt of frost at dpr 2.
    expect(PyramidDepth(9, 0)).toBe(BORDER_DIRECT_DEPTH);
    expect(BorderDirectTapOffset(9, BORDER_DIRECT_DEPTH)).toBe(BORDER_DIRECT_MAX_TAP_OFFSET);
    // Below and above the depth band the pyramid is a different shape and the gather does not
    // reproduce it. `JwiftGlass` at dpr 3 is radius 12, which is depth 3 -- named, not hidden.
    expect(PyramidDepth(3, 0)).toBe(1);
    expect(PyramidDepth(12, 0)).toBe(3);
  });

  it('the tap-offset expression is `BlurPass.Blur`s, not a second copy of the rule', () => {
    const src = readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('const baseSigma = 3 * Math.pow(2, depth);');
    expect(src).toContain('const tapOffset = Math.max(0.7, Math.min(1.3, Math.max(1, radius) / baseSigma));');
    const plan = readFileSync(join(__dirname, '../src/Core/Border.Direct.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(plan).toContain('const baseSigma = 3 * Math.pow(2, depth);');
    expect(plan).toContain('return Math.max(0.7, Math.min(1.3, Math.max(1, radius) / baseSigma));');
  });
});
