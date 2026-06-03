/**
 * Pre-refactor proof test.
 *
 * The shader's SS_PillSDF and SS_PillGrad each run TWO polyline loops (one for
 * min-distance, one for bracket). Main-shape fragments pay both. We want to
 * merge the two loops into one so each fragment scans the polyline once
 * instead of twice — same math, ~3× fewer iterations per pill fragment.
 *
 * This test verifies the merged-loop algorithm is BIT-IDENTICAL to the current
 * two-loop algorithm across a dense sample grid. If it passes, the shader
 * refactor is mechanically safe — same arithmetic, just reorganized control
 * flow. No accuracy change.
 *
 * If this test fails, the refactor changes behavior and should NOT ship.
 */

import { describe, it, expect } from 'vitest';

// ─── Shared polyline (mirror of SS_PILL_CURVE in Jiv.Panel.frag) ───
const SS_PILL_CURVE: Array<[number, number]> = [
  [0.000000, 1.000000], [0.071905, 0.999903], [0.141683, 0.999227],
  [0.209303, 0.997390], [0.274729, 0.993813], [0.337929, 0.987916],
  [0.398867, 0.979119], [0.457512, 0.966841], [0.513828, 0.950503],
  [0.567783, 0.929525], [0.619341, 0.903327], [0.668471, 0.871328],
  [0.715137, 0.832948], [0.759307, 0.787608], [0.800946, 0.734728],
  [0.840021, 0.673727], [0.874726, 0.607726], [0.889889, 0.574476],
  [0.904073, 0.540309], [0.917279, 0.505288], [0.929507, 0.469473],
  [0.940756, 0.432925], [0.951027, 0.395705], [0.960321, 0.357875],
  [0.968635, 0.319495], [0.975972, 0.280627], [0.982330, 0.241331],
  [0.987711, 0.201669], [0.992113, 0.161702], [0.995536, 0.121490],
  [0.997982, 0.081095], [0.999449, 0.040578], [0.999938, 0.000000],
];
const SS_PILL_MAXEXTENT = 1.6236;

type Vec2 = [number, number];
interface Eval { dist: number; grad: Vec2 }

const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// ─── CURRENT: two-loop SDF + two-loop Grad (mirror of shader) ───
function pillSDF_current(p: Vec2, halfSize: Vec2): number {
  const horiz = halfSize[0] >= halfSize[1];
  const qx = horiz ? Math.abs(p[0]) : Math.abs(p[1]);
  const qy = horiz ? Math.abs(p[1]) : Math.abs(p[0]);
  const halfX = horiz ? halfSize[0] : halfSize[1];
  const halfY = horiz ? halfSize[1] : halfSize[0];
  const maxExtent = SS_PILL_MAXEXTENT * halfY;
  const flatStart = halfX - maxExtent;

  if (qx <= flatStart) return qy - halfY;

  const qLx = qx - flatStart;
  const qLy = qy;

  // Loop 1: min unsigned distance
  let minDSq = 1e9;
  for (let i = 0; i < SS_PILL_CURVE.length - 1; i++) {
    const ax = SS_PILL_CURVE[i][0] * maxExtent, ay = SS_PILL_CURVE[i][1] * halfY;
    const bx = SS_PILL_CURVE[i + 1][0] * maxExtent, by = SS_PILL_CURVE[i + 1][1] * halfY;
    const abx = bx - ax, aby = by - ay;
    const apx = qLx - ax, apy = qLy - ay;
    const t = clamp((apx * abx + apy * aby) / (abx * abx + aby * aby), 0, 1);
    const cx = ax + t * abx, cy = ay + t * aby;
    const dx = qLx - cx, dy = qLy - cy;
    const dSq = dx * dx + dy * dy;
    if (dSq < minDSq) minDSq = dSq;
  }
  const udist = Math.sqrt(minDSq);

  // Loop 2: bracket for inside test
  let u_b = -1;
  for (let i = 0; i < SS_PILL_CURVE.length - 1; i++) {
    const ax = SS_PILL_CURVE[i][0] * maxExtent, ay = SS_PILL_CURVE[i][1] * halfY;
    const bx = SS_PILL_CURVE[i + 1][0] * maxExtent, by = SS_PILL_CURVE[i + 1][1] * halfY;
    if (qLy <= ay && qLy >= by) {
      const dv = ay - by;
      const t = dv > 0.0001 ? (ay - qLy) / dv : 0;
      u_b = mix(ax, bx, t);
      break;
    }
  }
  const inside = qLy <= halfY && u_b > 0 && qLx <= u_b;
  return inside ? -udist : udist;
}

function pillGrad_current(p: Vec2, halfSize: Vec2): Vec2 {
  const horiz = halfSize[0] >= halfSize[1];
  const qx = horiz ? Math.abs(p[0]) : Math.abs(p[1]);
  const qy = horiz ? Math.abs(p[1]) : Math.abs(p[0]);
  const halfX = horiz ? halfSize[0] : halfSize[1];
  const halfY = horiz ? halfSize[1] : halfSize[0];
  const maxExtent = SS_PILL_MAXEXTENT * halfY;
  const flatStart = halfX - maxExtent;

  if (qx <= flatStart) {
    const g: Vec2 = [0, sign(p[1])];
    return horiz ? g : [g[1], g[0]];
  }

  const qLx = qx - flatStart;
  const qLy = qy;

  // Loop 1: min + closest point
  let minDSq = 1e9;
  let bestCx = qLx, bestCy = qLy;
  for (let i = 0; i < SS_PILL_CURVE.length - 1; i++) {
    const ax = SS_PILL_CURVE[i][0] * maxExtent, ay = SS_PILL_CURVE[i][1] * halfY;
    const bx = SS_PILL_CURVE[i + 1][0] * maxExtent, by = SS_PILL_CURVE[i + 1][1] * halfY;
    const abx = bx - ax, aby = by - ay;
    const apx = qLx - ax, apy = qLy - ay;
    const t = clamp((apx * abx + apy * aby) / (abx * abx + aby * aby), 0, 1);
    const cx = ax + t * abx, cy = ay + t * aby;
    const dx = qLx - cx, dy = qLy - cy;
    const dSq = dx * dx + dy * dy;
    if (dSq < minDSq) { minDSq = dSq; bestCx = cx; bestCy = cy; }
  }

  // Loop 2: bracket
  let u_b = -1;
  for (let i = 0; i < SS_PILL_CURVE.length - 1; i++) {
    const ax = SS_PILL_CURVE[i][0] * maxExtent, ay = SS_PILL_CURVE[i][1] * halfY;
    const bx = SS_PILL_CURVE[i + 1][0] * maxExtent, by = SS_PILL_CURVE[i + 1][1] * halfY;
    if (qLy <= ay && qLy >= by) {
      const dv = ay - by;
      const t = dv > 0.0001 ? (ay - qLy) / dv : 0;
      u_b = mix(ax, bx, t);
      break;
    }
  }
  const inside = qLy <= halfY && u_b > 0 && qLx <= u_b;

  const dx = qLx - bestCx, dy = qLy - bestCy;
  const L = Math.sqrt(dx * dx + dy * dy);
  let gx = L > 0.0001 ? dx / L : 1;
  let gy = L > 0.0001 ? dy / L : 0;
  if (inside) { gx = -gx; gy = -gy; }
  gx *= sign(p[0]);
  gy *= sign(p[1]);
  return horiz ? [gx, gy] : [gy, gx];
}

// ─── MERGED: single-loop that computes dist + grad in one pass ───
function pillEval_merged(p: Vec2, halfSize: Vec2): Eval {
  const horiz = halfSize[0] >= halfSize[1];
  const qx = horiz ? Math.abs(p[0]) : Math.abs(p[1]);
  const qy = horiz ? Math.abs(p[1]) : Math.abs(p[0]);
  const halfX = horiz ? halfSize[0] : halfSize[1];
  const halfY = horiz ? halfSize[1] : halfSize[0];
  const maxExtent = SS_PILL_MAXEXTENT * halfY;
  const flatStart = halfX - maxExtent;

  if (qx <= flatStart) {
    const g: Vec2 = [0, sign(p[1])];
    return { dist: qy - halfY, grad: horiz ? g : [g[1], g[0]] };
  }

  const qLx = qx - flatStart;
  const qLy = qy;

  // Single loop: distance + closest + bracket
  let minDSq = 1e9;
  let bestCx = qLx, bestCy = qLy;
  let u_b = -1;
  let bracketFound = false;

  for (let i = 0; i < SS_PILL_CURVE.length - 1; i++) {
    const ax = SS_PILL_CURVE[i][0] * maxExtent, ay = SS_PILL_CURVE[i][1] * halfY;
    const bx = SS_PILL_CURVE[i + 1][0] * maxExtent, by = SS_PILL_CURVE[i + 1][1] * halfY;
    const abx = bx - ax, aby = by - ay;
    const apx = qLx - ax, apy = qLy - ay;
    const t = clamp((apx * abx + apy * aby) / (abx * abx + aby * aby), 0, 1);
    const cx = ax + t * abx, cy = ay + t * aby;
    const dx = qLx - cx, dy = qLy - cy;
    const dSq = dx * dx + dy * dy;
    if (dSq < minDSq) { minDSq = dSq; bestCx = cx; bestCy = cy; }

    if (!bracketFound && qLy <= ay && qLy >= by) {
      const dv = ay - by;
      const tb = dv > 0.0001 ? (ay - qLy) / dv : 0;
      u_b = mix(ax, bx, tb);
      bracketFound = true;
    }
  }

  const udist = Math.sqrt(minDSq);
  const inside = qLy <= halfY && u_b > 0 && qLx <= u_b;
  const dist = inside ? -udist : udist;

  const dx = qLx - bestCx, dy = qLy - bestCy;
  const L = Math.sqrt(dx * dx + dy * dy);
  let gx = L > 0.0001 ? dx / L : 1;
  let gy = L > 0.0001 ? dy / L : 0;
  if (inside) { gx = -gx; gy = -gy; }
  gx *= sign(p[0]);
  gy *= sign(p[1]);
  return { dist, grad: horiz ? [gx, gy] : [gy, gx] };
}

// ─── Equivalence test ───
describe('Pill SDF merged-loop refactor: mathematical equivalence', () => {

  it('matches two-loop implementation bit-exactly across dense grid, horizontal pills', () => {
    const sizes: Array<[number, number]> = [[440, 60], [240, 40], [600, 80], [120, 30], [800, 100]];
    let distMaxDiff = 0;
    let gradMaxDiff = 0;
    let samples = 0;
    let mismatches = 0;

    for (const [W, H] of sizes) {
      const halfW = W / 2, halfH = H / 2;
      const step = Math.max(1, Math.floor(Math.min(W, H) / 60));
      // Sample bbox + 10px margin (covers shadow + outside region)
      for (let y = -halfH - 10; y <= halfH + 10; y += step) {
        for (let x = -halfW - 10; x <= halfW + 10; x += step) {
          const p: Vec2 = [x, y];
          const hs: Vec2 = [halfW, halfH];
          const distCurrent = pillSDF_current(p, hs);
          const gradCurrent = pillGrad_current(p, hs);
          const merged = pillEval_merged(p, hs);

          const dd = Math.abs(merged.dist - distCurrent);
          const dgx = Math.abs(merged.grad[0] - gradCurrent[0]);
          const dgy = Math.abs(merged.grad[1] - gradCurrent[1]);

          if (dd > distMaxDiff) distMaxDiff = dd;
          if (Math.max(dgx, dgy) > gradMaxDiff) gradMaxDiff = Math.max(dgx, dgy);
          if (dd > 1e-9 || dgx > 1e-9 || dgy > 1e-9) mismatches++;
          samples++;
        }
      }
    }

    console.log(`  samples: ${samples}, mismatches: ${mismatches}, max dist diff: ${distMaxDiff}, max grad diff: ${gradMaxDiff}`);
    expect(mismatches).toBe(0);
    expect(distMaxDiff).toBe(0);
    expect(gradMaxDiff).toBe(0);
  });

  it('matches bit-exactly for vertical pills', () => {
    const sizes: Array<[number, number]> = [[60, 440], [40, 240], [80, 600]];
    let mismatches = 0;
    let samples = 0;

    for (const [W, H] of sizes) {
      const halfW = W / 2, halfH = H / 2;
      const step = Math.max(1, Math.floor(Math.min(W, H) / 60));
      for (let y = -halfH - 10; y <= halfH + 10; y += step) {
        for (let x = -halfW - 10; x <= halfW + 10; x += step) {
          const p: Vec2 = [x, y];
          const hs: Vec2 = [halfW, halfH];
          const distCurrent = pillSDF_current(p, hs);
          const gradCurrent = pillGrad_current(p, hs);
          const merged = pillEval_merged(p, hs);
          if (merged.dist !== distCurrent) mismatches++;
          if (merged.grad[0] !== gradCurrent[0] || merged.grad[1] !== gradCurrent[1]) mismatches++;
          samples++;
        }
      }
    }

    console.log(`  vertical: samples: ${samples}, mismatches: ${mismatches}`);
    expect(mismatches).toBe(0);
  });

  it('matches at polyline vertex coordinates (highest-risk edge cases)', () => {
    // Polyline vertices are where the closest-point segment can change
    // discontinuously. Any divergence between algorithms would likely appear
    // here first.
    const W = 440, H = 60;
    const halfX = W / 2, halfY = H / 2;
    const maxExtent = SS_PILL_MAXEXTENT * halfY;
    const flatStart = halfX - maxExtent;

    let mismatches = 0;
    for (const [u, v] of SS_PILL_CURVE) {
      // Vertex in physical coords, upper-right endcap
      const px = flatStart + u * maxExtent;
      const py = v * halfY;
      // Test the vertex itself, and points just inside/outside by 0.001 px
      for (const dx of [-0.001, 0, 0.001]) {
        for (const dy of [-0.001, 0, 0.001]) {
          const p: Vec2 = [px + dx, py + dy];
          const hs: Vec2 = [halfX, halfY];
          const distCurrent = pillSDF_current(p, hs);
          const gradCurrent = pillGrad_current(p, hs);
          const merged = pillEval_merged(p, hs);
          if (merged.dist !== distCurrent) mismatches++;
          if (merged.grad[0] !== gradCurrent[0] || merged.grad[1] !== gradCurrent[1]) mismatches++;
        }
      }
    }

    expect(mismatches).toBe(0);
  });

  it('merged SDF preserves Pill.SDF.Match pixel-accuracy (99.9844% at 440×60)', () => {
    // Replicate the match test's inside/outside check using the merged eval.
    const W = 440, H = 60;
    const halfW = W / 2, halfH = H / 2;
    let distOnlyMismatch = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p: Vec2 = [x + 0.5 - halfW, y + 0.5 - halfH];
        const hs: Vec2 = [halfW, halfH];
        const currentInside = pillSDF_current(p, hs) < 0;
        const mergedInside = pillEval_merged(p, hs).dist < 0;
        if (currentInside !== mergedInside) distOnlyMismatch++;
      }
    }
    expect(distOnlyMismatch).toBe(0);
  });
});
