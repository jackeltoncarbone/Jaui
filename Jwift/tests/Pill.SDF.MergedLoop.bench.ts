/**
 * Pill SDF refactor — bulk accuracy + speed benchmark.
 *
 * Simulates per-pill fragment work at multiple pill sizes, comparing the
 * current two-loop shader algorithm against the proposed merged single-loop.
 * Produces a combined accuracy + speedup table.
 *
 * Two fragment scenarios:
 *   1. MAIN shape — shader calls SDF then Grad at the same p (main panel).
 *      Current: 2 polyline passes (SDF) + 2 polyline passes (Grad) = 4 passes
 *      Merged: 1 Eval call (1 pass) → 4× fewer iterations for this scenario.
 *
 *   2. SHADOW — shader calls SDF only at p - shadowOffset.
 *      Current: 2 polyline passes inside SDF.
 *      Merged: 1 pass inside SDF → 2× fewer iterations.
 */

import { describe, it, expect } from 'vitest';

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
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// ─── CURRENT: two-loop SDF + two-loop Grad ───
function pillSDF_current(p: Vec2, halfSize: Vec2): number {
  const horiz = halfSize[0] >= halfSize[1];
  const qx = horiz ? Math.abs(p[0]) : Math.abs(p[1]);
  const qy = horiz ? Math.abs(p[1]) : Math.abs(p[0]);
  const halfX = horiz ? halfSize[0] : halfSize[1];
  const halfY = horiz ? halfSize[1] : halfSize[0];
  const maxExtent = SS_PILL_MAXEXTENT * halfY;
  const flatStart = halfX - maxExtent;
  if (qx <= flatStart) return qy - halfY;
  const qLx = qx - flatStart, qLy = qy;

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
  const qLx = qx - flatStart, qLy = qy;

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

// ─── MERGED: single-loop eval (dist + grad) ───
interface EvalResult { dist: number; gx: number; gy: number }
function pillEval_merged(p: Vec2, halfSize: Vec2, out: EvalResult): void {
  const horiz = halfSize[0] >= halfSize[1];
  const qx = horiz ? Math.abs(p[0]) : Math.abs(p[1]);
  const qy = horiz ? Math.abs(p[1]) : Math.abs(p[0]);
  const halfX = horiz ? halfSize[0] : halfSize[1];
  const halfY = horiz ? halfSize[1] : halfSize[0];
  const maxExtent = SS_PILL_MAXEXTENT * halfY;
  const flatStart = halfX - maxExtent;
  if (qx <= flatStart) {
    out.dist = qy - halfY;
    const gxF = 0, gyF = sign(p[1]);
    out.gx = horiz ? gxF : gyF;
    out.gy = horiz ? gyF : gxF;
    return;
  }
  const qLx = qx - flatStart, qLy = qy;

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
  out.dist = inside ? -udist : udist;

  const dx = qLx - bestCx, dy = qLy - bestCy;
  const L = Math.sqrt(dx * dx + dy * dy);
  let gx = L > 0.0001 ? dx / L : 1;
  let gy = L > 0.0001 ? dy / L : 0;
  if (inside) { gx = -gx; gy = -gy; }
  gx *= sign(p[0]);
  gy *= sign(p[1]);
  out.gx = horiz ? gx : gy;
  out.gy = horiz ? gy : gx;
}

// Merged single-loop SDF-only (shadow path — no grad needed)
function pillSDF_merged(p: Vec2, halfSize: Vec2): number {
  const horiz = halfSize[0] >= halfSize[1];
  const qx = horiz ? Math.abs(p[0]) : Math.abs(p[1]);
  const qy = horiz ? Math.abs(p[1]) : Math.abs(p[0]);
  const halfX = horiz ? halfSize[0] : halfSize[1];
  const halfY = horiz ? halfSize[1] : halfSize[0];
  const maxExtent = SS_PILL_MAXEXTENT * halfY;
  const flatStart = halfX - maxExtent;
  if (qx <= flatStart) return qy - halfY;
  const qLx = qx - flatStart, qLy = qy;

  let minDSq = 1e9;
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
    if (dSq < minDSq) minDSq = dSq;
    if (!bracketFound && qLy <= ay && qLy >= by) {
      const dv = ay - by;
      const tb = dv > 0.0001 ? (ay - qLy) / dv : 0;
      u_b = mix(ax, bx, tb);
      bracketFound = true;
    }
  }
  const udist = Math.sqrt(minDSq);
  const inside = qLy <= halfY && u_b > 0 && qLx <= u_b;
  return inside ? -udist : udist;
}

// ─── Helpers ───
function buildFragmentGrid(W: number, H: number): Vec2[] {
  const halfW = W / 2, halfH = H / 2;
  const pts: Vec2[] = [];
  // Expand ±4 px margin for shadow region (match real fragment footprint)
  const mX = 4, mY = 4;
  for (let y = 0; y < H + 2 * mY; y++) {
    for (let x = 0; x < W + 2 * mX; x++) {
      pts.push([x + 0.5 - halfW - mX, y + 0.5 - halfH - mY]);
    }
  }
  return pts;
}

function timeIt(fn: () => void, iters: number): number {
  // Warmup
  for (let i = 0; i < Math.min(iters, 2); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

interface Row {
  scenario: string;
  size: string;
  currentMs: number;
  mergedMs: number;
  speedup: number;
  mismatches: number;
}

describe('Pill SDF refactor — bulk accuracy + speed benchmark', () => {
  it('measures and reports full table', { timeout: 60000 }, () => {
    const sizes: Array<[number, number]> = [[440, 60], [600, 80], [120, 30], [800, 100], [240, 40]];
    const iters = 5;
    const rows: Row[] = [];
    const shadowOffset: Vec2 = [2, 3];

    for (const [W, H] of sizes) {
      const halfSize: Vec2 = [W / 2, H / 2];
      const pts = buildFragmentGrid(W, H);
      const sizeStr = `${W}×${H}`;

      // ── Accuracy: scan all fragment points, compare dist + grad + sign ──
      let mainMismatch = 0;
      let shadowMismatch = 0;
      const tmp: EvalResult = { dist: 0, gx: 0, gy: 0 };
      for (const p of pts) {
        const distC = pillSDF_current(p, halfSize);
        const gradC = pillGrad_current(p, halfSize);
        pillEval_merged(p, halfSize, tmp);
        if (tmp.dist !== distC || tmp.gx !== gradC[0] || tmp.gy !== gradC[1]) mainMismatch++;

        const sp: Vec2 = [p[0] - shadowOffset[0], p[1] - shadowOffset[1]];
        const shadowC = pillSDF_current(sp, halfSize);
        const shadowM = pillSDF_merged(sp, halfSize);
        if (shadowC !== shadowM) shadowMismatch++;
      }

      // ── Speed: MAIN scenario (SDF + Grad vs Eval) ──
      const mainCurrent = timeIt(() => {
        let acc = 0;
        for (const p of pts) {
          acc += pillSDF_current(p, halfSize);
          const g = pillGrad_current(p, halfSize);
          acc += g[0];
        }
        if (acc === 12345.6789) console.log(acc); // prevent DCE
      }, iters);
      const mainMerged = timeIt(() => {
        let acc = 0;
        const t: EvalResult = { dist: 0, gx: 0, gy: 0 };
        for (const p of pts) {
          pillEval_merged(p, halfSize, t);
          acc += t.dist + t.gx;
        }
        if (acc === 12345.6789) console.log(acc);
      }, iters);

      // ── Speed: SHADOW scenario (SDF only) ──
      const shadowCurrent = timeIt(() => {
        let acc = 0;
        for (const p of pts) {
          const sp: Vec2 = [p[0] - shadowOffset[0], p[1] - shadowOffset[1]];
          acc += pillSDF_current(sp, halfSize);
        }
        if (acc === 12345.6789) console.log(acc);
      }, iters);
      const shadowMerged = timeIt(() => {
        let acc = 0;
        for (const p of pts) {
          const sp: Vec2 = [p[0] - shadowOffset[0], p[1] - shadowOffset[1]];
          acc += pillSDF_merged(sp, halfSize);
        }
        if (acc === 12345.6789) console.log(acc);
      }, iters);

      rows.push({
        scenario: 'MAIN (SDF+Grad)',
        size: sizeStr,
        currentMs: mainCurrent,
        mergedMs: mainMerged,
        speedup: mainCurrent / mainMerged,
        mismatches: mainMismatch,
      });
      rows.push({
        scenario: 'SHADOW (SDF)   ',
        size: sizeStr,
        currentMs: shadowCurrent,
        mergedMs: shadowMerged,
        speedup: shadowCurrent / shadowMerged,
        mismatches: shadowMismatch,
      });
    }

    // ── Print table ──
    console.log('\n┌──────────────────────┬───────────┬───────────┬───────────┬──────────┬────────────┐');
    console.log('│ Scenario             │ Size      │ Current   │ Merged    │ Speedup  │ Mismatches │');
    console.log('│                      │           │ (ms/pass) │ (ms/pass) │          │ (bit-exact)│');
    console.log('├──────────────────────┼───────────┼───────────┼───────────┼──────────┼────────────┤');
    for (const r of rows) {
      const s = r.scenario.padEnd(20);
      const sz = r.size.padEnd(9);
      const c = r.currentMs.toFixed(2).padStart(9);
      const m = r.mergedMs.toFixed(2).padStart(9);
      const sp = r.speedup.toFixed(2) + '×';
      const spPad = sp.padStart(8);
      const mm = r.mismatches.toString().padStart(10);
      console.log(`│ ${s} │ ${sz} │ ${c} │ ${m} │ ${spPad} │ ${mm} │`);
    }
    console.log('└──────────────────────┴───────────┴───────────┴───────────┴──────────┴────────────┘');

    // Aggregate summary
    const mainRows = rows.filter(r => r.scenario.startsWith('MAIN'));
    const shadowRows = rows.filter(r => r.scenario.startsWith('SHADOW'));
    const avgMain = mainRows.reduce((a, r) => a + r.speedup, 0) / mainRows.length;
    const avgShadow = shadowRows.reduce((a, r) => a + r.speedup, 0) / shadowRows.length;
    const totalFragments = rows.reduce((a, r) => {
      const [W, H] = r.size.split('×').map(Number);
      return a + (W + 8) * (H + 8);
    }, 0);
    const totalMismatches = rows.reduce((a, r) => a + r.mismatches, 0);

    console.log(`\n  Average MAIN-shape speedup:   ${avgMain.toFixed(2)}×`);
    console.log(`  Average SHADOW speedup:       ${avgShadow.toFixed(2)}×`);
    console.log(`  Total fragment samples:       ${totalFragments.toLocaleString()}`);
    console.log(`  Total bit-exact mismatches:   ${totalMismatches}\n`);

    // Hard assertions
    expect(totalMismatches).toBe(0);
    for (const r of rows) {
      expect(r.mismatches).toBe(0);
      expect(r.speedup).toBeGreaterThan(1.3);  // Guard against perf regression
    }
  });
});
