/**
 * Pill SDF accuracy vs Show Studio Bezier — pixel-level.
 *
 * Rasterizes both shapes into a 960×120 mask, counts:
 *   - SS-only pixels (SS inside, SDF outside — we under-fill)
 *   - SDF-only pixels (SDF inside, SS outside — we over-fill)
 *   - matched pixels (both inside or both outside)
 *
 * Sweeps n over a range and finds the closed-form exponent that minimizes
 * total mismatch. The test is informational — it asserts a max mismatch
 * threshold so regressions in the pill shape trip a failure, but the real
 * value is running it to pick `n`.
 *
 * SS path is rendered with curveWidth = maxExtent (40.59 · endScale) so the
 * shape fills its bbox, matching our SDF convention. Without this adjustment
 * SS sits inset by ~2 px on each side and never matches.
 */

import { describe, it, expect } from 'vitest';

// ─── Point-in-polygon (for SS Bezier rasterization) ───
// Rasterize SS path by sampling the Bezier as a polygon, then point-in-poly test.
function ssBezierPolygon(W: number, H: number): Array<[number, number]> {
  const halfY = H / 2;
  const endScale = halfY / 25;
  const maxExtent = 40.59 * endScale;       // shape's actual horizontal reach
  // Use maxExtent as curveWidth so the shape FILLS the bbox:
  const curveWidth = maxExtent;
  const lc = curveWidth;
  const rc = W - curveWidth;
  const sY = H / 50;

  const y0 = 0, y1 = 9 * sY, y2 = 18 * sY, y3 = 32 * sY, y4 = 41 * sY, y5 = H;
  const L = { cp1: -15.3, cp2: -27.2, curve: -34.85, tip: -42.5 };
  const R = { cp1:  15.3, cp2:  27.2, curve:  34.85, tip:  42.5 };

  const samples = 64;   // per bezier — 6 beziers total = 384 points
  const pts: Array<[number, number]> = [];

  const bezier = (p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number]) => {
    for (let i = 0; i < samples; i++) {
      const t = i / samples;
      const u = 1 - t;
      const b0 = u*u*u, b1 = 3*u*u*t, b2 = 3*u*t*t, b3 = t*t*t;
      pts.push([b0*p0[0] + b1*p1[0] + b2*p2[0] + b3*p3[0], b0*p0[1] + b1*p1[1] + b2*p2[1] + b3*p3[1]]);
    }
  };

  pts.push([lc, y0]);
  bezier([lc, y0], [lc + L.cp1 * endScale, y0], [lc + L.cp2 * endScale, y0], [lc + L.curve * endScale, y1]);
  bezier([lc + L.curve * endScale, y1], [lc + L.tip * endScale, y2], [lc + L.tip * endScale, y3], [lc + L.curve * endScale, y4]);
  bezier([lc + L.curve * endScale, y4], [lc + L.cp2 * endScale, y5], [lc + L.cp1 * endScale, y5], [lc, y5]);
  pts.push([rc, y5]);
  bezier([rc, y5], [rc + R.cp1 * endScale, y5], [rc + R.cp2 * endScale, y5], [rc + R.curve * endScale, y4]);
  bezier([rc + R.curve * endScale, y4], [rc + R.tip * endScale, y3], [rc + R.tip * endScale, y2], [rc + R.curve * endScale, y1]);
  bezier([rc + R.curve * endScale, y1], [rc + R.cp2 * endScale, y0], [rc + R.cp1 * endScale, y0], [rc, y0]);

  return pts;
}

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersect = ((yi > y) !== (yj > y))
                   && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ─── Our SDF (mirror of Jiv.Panel.frag ShapeSDF_inner for pill mode) ───
function sdfPillInside(px: number, py: number, halfW: number, halfH: number,
                       rAx: number, rAy: number, n: number): boolean {
  const aX = Math.abs(px);
  const aY = Math.abs(py);
  const qx = aX - halfW + rAx;
  const qy = aY - halfH + rAy;

  if (qx <= 0 && qy <= 0) return aX <= halfW && aY <= halfH;

  const u = Math.max(qx, 0) / rAx;
  const v = Math.max(qy, 0) / rAy;
  const uE = Math.max(u, 1e-5);
  const vE = Math.max(v, 1e-5);
  const L = Math.pow(Math.pow(uE, n) + Math.pow(vE, n), 1 / n);
  return L <= 1;
}

// ─── Polyline SDF (mirror of Jiv.Panel.frag SS_PillSDF) ───
// Same constants as the shader's SS_PILL_CURVE; if the shader regenerates,
// regenerate this too via tests/Pill.PolylineGen.test.ts.
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

function polylineSdfPillInside(px: number, py: number, halfW: number, halfH: number): boolean {
  const horiz = halfW >= halfH;
  const qx = horiz ? Math.abs(px) : Math.abs(py);
  const qy = horiz ? Math.abs(py) : Math.abs(px);
  const halfX = horiz ? halfW : halfH;
  const halfY = horiz ? halfH : halfW;
  const maxExtent = SS_PILL_MAXEXTENT * halfY;
  const flatStart = halfX - maxExtent;

  if (qx <= flatStart) return qy <= halfY;

  const qLx = qx - flatStart;
  const qLy = qy;

  // Find boundary u_b at v = qLy/halfY via segment containing qLy
  let u_b = -1;
  for (let i = 0; i < SS_PILL_CURVE.length - 1; i++) {
    const [aU, aV] = SS_PILL_CURVE[i];
    const [bU, bV] = SS_PILL_CURVE[i + 1];
    const aY = aV * halfY, bY = bV * halfY;
    if (qLy <= aY && qLy >= bY) {
      const dv = aY - bY;
      const t = dv > 0.0001 ? (aY - qLy) / dv : 0;
      const aX = aU * maxExtent, bX = bU * maxExtent;
      u_b = aX + t * (bX - aX);
      break;
    }
  }
  return qLy <= halfY && u_b > 0 && qLx <= u_b;
}

function computeMismatch(W: number, H: number, rAxRatio: number, n: number): { mismatch: number; ssOnly: number; sdfOnly: number; both: number; total: number } {
  const halfW = W / 2, halfH = H / 2;
  const rAx = rAxRatio * halfH;
  const rAy = halfH;
  const poly = ssBezierPolygon(W, H);

  let ssOnly = 0, sdfOnly = 0, both = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ssHit = pointInPolygon(x + 0.5, y + 0.5, poly);
      const sdfHit = sdfPillInside(x + 0.5 - halfW, y + 0.5 - halfH, halfW, halfH, rAx, rAy, n);
      if (ssHit && sdfHit) both++;
      else if (ssHit) ssOnly++;
      else if (sdfHit) sdfOnly++;
    }
  }
  const total = ssOnly + sdfOnly + both;
  return { mismatch: ssOnly + sdfOnly, ssOnly, sdfOnly, both, total };
}

function computeMismatchPolyline(W: number, H: number): { mismatch: number; ssOnly: number; sdfOnly: number; both: number; total: number } {
  const halfW = W / 2, halfH = H / 2;
  const poly = ssBezierPolygon(W, H);

  let ssOnly = 0, sdfOnly = 0, both = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ssHit = pointInPolygon(x + 0.5, y + 0.5, poly);
      const sdfHit = polylineSdfPillInside(x + 0.5 - halfW, y + 0.5 - halfH, halfW, halfH);
      if (ssHit && sdfHit) both++;
      else if (ssHit) ssOnly++;
      else if (sdfHit) sdfOnly++;
    }
  }
  const total = ssOnly + sdfOnly + both;
  return { mismatch: ssOnly + sdfOnly, ssOnly, sdfOnly, both, total };
}

describe('Pill SDF vs Show Studio Bezier', () => {

  it('sweeps n and reports best fit at rx=1.6236·halfY (diagnostic)', () => {
    const W = 440, H = 60;
    const rAxRatio = 1.6236; // SS maxExtent / halfY

    console.log(`\n  pill ${W}×${H}, rx/halfY = ${rAxRatio}`);
    console.log('    n      ssOnly  sdfOnly  mismatch   of shape');

    let bestN = 0, bestMismatch = Infinity;
    const nValues = [2.5, 2.6, 2.65, 2.7, 2.75, 2.8, 2.85, 2.9, 3.0];
    for (const n of nValues) {
      const r = computeMismatch(W, H, rAxRatio, n);
      const pct = (r.mismatch / r.total * 100).toFixed(3);
      console.log(`    n=${n.toFixed(2).padEnd(4)}  ${r.ssOnly.toString().padStart(6)}   ${r.sdfOnly.toString().padStart(6)}   ${r.mismatch.toString().padStart(5)}   ${pct}%`);
      if (r.mismatch < bestMismatch) { bestMismatch = r.mismatch; bestN = n; }
    }
    console.log(`    best n: ${bestN} with ${bestMismatch} mismatched px`);

    expect(bestMismatch).toBeLessThan(W * H * 0.02);
  });

  it('2D sweep (rx, n) — find global minimum', { timeout: 30000 }, () => {
    const W = 440, H = 60;
    console.log('\n  2D sweep over (rx/halfY, n):');
    console.log('               n=2.60   n=2.70   n=2.75   n=2.80   n=2.85   n=2.90   n=3.00');

    const ratios = [1.58, 1.60, 1.6236, 1.64, 1.66, 1.68, 1.70];
    const nValues = [2.60, 2.70, 2.75, 2.80, 2.85, 2.90, 3.00];

    let best = { r: 0, n: 0, mm: Infinity };
    for (const ratio of ratios) {
      let line = `  rx=${ratio.toFixed(4).padEnd(6)}`;
      for (const n of nValues) {
        const r = computeMismatch(W, H, ratio, n);
        line += `   ${r.mismatch.toString().padStart(5)}`;
        if (r.mismatch < best.mm) best = { r: ratio, n, mm: r.mismatch };
      }
      console.log(line);
    }
    console.log(`    best combo: rx/halfY=${best.r}, n=${best.n} → ${best.mm} mismatched px\n`);

    expect(best.mm).toBeLessThan(W * H * 0.01);
  });

  it('best closed-form fit (n=2.7) matches SS within 1% of shape area', () => {
    const r = computeMismatch(440, 60, 1.6236, 2.7);
    const pct = r.mismatch / r.total * 100;
    expect(pct).toBeLessThan(1);
  });

  it('POLYLINE pill SDF matches SS within 0.1% (99.9%+ pixel-accurate)', () => {
    const r = computeMismatchPolyline(440, 60);
    const pct = r.mismatch / r.total * 100;
    console.log(`\n  POLYLINE 440×60: ssOnly=${r.ssOnly}, sdfOnly=${r.sdfOnly}, total=${r.total}, mismatch=${pct.toFixed(4)}%`);
    expect(pct).toBeLessThan(0.1);
  });

  it('POLYLINE pill SDF matches SS at multiple sizes', () => {
    const sizes: Array<[number, number]> = [[240, 40], [600, 80], [120, 30], [800, 100]];
    for (const [W, H] of sizes) {
      const r = computeMismatchPolyline(W, H);
      const pct = r.mismatch / r.total * 100;
      console.log(`  POLYLINE ${W}×${H}: mismatch ${r.mismatch} px (${pct.toFixed(4)}%)`);
      expect(pct).toBeLessThan(0.2);
    }
  });
});
