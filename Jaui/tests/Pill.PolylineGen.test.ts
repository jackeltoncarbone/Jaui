/**
 * Generates the SS pill curve polyline as a GLSL const array.
 *
 * Run this test to print the array; copy-paste into Jiv.Panel.frag.
 * Sampling parameters here determine the precision of the pill SDF.
 *
 * The curve is the UPPER-RIGHT endcap quarter, in normalized (u, v) coords
 * where u = horizontal distance from flat-zone-end / maxExtent (0..1)
 *        v = vertical distance from horizontal-middle / halfY (0..1)
 *
 * Curve traversal:
 *   t=0    : (u, v) = (0, 1)        — top tangent (where flat top ends)
 *   t=0.5  : (u, v) ≈ (0.859, 0.64) — junction of Bezier 1 / Bezier 2
 *   t=1    : (u, v) = (1, 0)        — rightmost point at vertical middle
 *
 * t < 0.5 is on Bezier 1 (top shoulder, parameterized linearly).
 * t > 0.5 is on first half of Bezier 2 (parameterized to t' = (t-0.5)).
 */

import { describe, it } from 'vitest';

const SS_MAXEXTENT_RATIO = 40.59 / 25;     // 1.6236
const SS_CP_INNER = 15.3 / 25;             // 0.612 — Bezier 1 CP1 horiz
const SS_CP_MIDDLE = 27.2 / 25;            // 1.088 — Bezier 1 CP2 horiz
const SS_CURVE_X = 34.85 / 25;             // 1.394 — Bezier 1/2 join horiz (in halfY units)
const SS_TIP_X = 42.5 / 25;                // 1.700 — Bezier 2 CPs horiz (in halfY units)
const SS_Y1 = 9 / 25;                      // 0.36  — Bezier 1 join vertical (from top)
const SS_Y2 = 18 / 25;                     // 0.72
const SS_Y4 = 41 / 25;                     // 1.64

// In normalized endcap coords (origin at flat-top-end, u inward, v upward):
//   Bezier 1: P0=(0, 1) → P3=(curve_u, 1 - y1_v), where curve_u = SS_CURVE_X / MAXEXT, y1_v = SS_Y1
//   But: y is measured from TOP in SS, v measures from MIDDLE, so v = 1 - SS_Yi
//   curve_u = SS_CURVE_X / SS_MAXEXTENT_RATIO = 34.85/40.59 = 0.859
//   tip_u   = SS_TIP_X / SS_MAXEXTENT_RATIO = 42.5/40.59 = 1.047 (CP can be outside the curve)

const MAX_EXT = SS_MAXEXTENT_RATIO; // shorthand

interface UV { u: number; v: number }

function bezier1(t: number): UV {
  // P0 = (0, 1)
  // P1 = (SS_CP_INNER / MAX_EXT, 1)
  // P2 = (SS_CP_MIDDLE / MAX_EXT, 1)
  // P3 = (SS_CURVE_X / MAX_EXT, 1 - SS_Y1)
  const P0 = { u: 0, v: 1 };
  const P1 = { u: SS_CP_INNER / MAX_EXT, v: 1 };
  const P2 = { u: SS_CP_MIDDLE / MAX_EXT, v: 1 };
  const P3 = { u: SS_CURVE_X / MAX_EXT, v: 1 - SS_Y1 };
  const omt = 1 - t, b0 = omt*omt*omt, b1 = 3*omt*omt*t, b2 = 3*omt*t*t, b3 = t*t*t;
  return {
    u: b0*P0.u + b1*P1.u + b2*P2.u + b3*P3.u,
    v: b0*P0.v + b1*P1.v + b2*P2.v + b3*P3.v,
  };
}

function bezier2FirstHalf(t: number): UV {
  // Bezier 2 full: P0 = (curve, 1-y1), P1 = (tip, 1-y2), P2 = (tip, 1-y3=v3), P3 = (curve, 1-y4)
  // First half = re-evaluate full Bezier at t/2, which by De Casteljau is itself a cubic.
  const P0 = { u: SS_CURVE_X / MAX_EXT, v: 1 - SS_Y1 };
  const P1 = { u: SS_TIP_X / MAX_EXT, v: 1 - SS_Y2 };
  const P2 = { u: SS_TIP_X / MAX_EXT, v: 1 - (32/25) }; // v3 = 1 - y3/25 — but y3=32, so v=1-32/25=-0.28
  const P3 = { u: SS_CURVE_X / MAX_EXT, v: 1 - SS_Y4 };  // v = 1 - 41/25 = -0.64
  // Evaluate at full Bezier param tFull = t/2 to get first-half points
  const tFull = t / 2;
  const omt = 1 - tFull, b0 = omt*omt*omt, b1 = 3*omt*omt*tFull, b2 = 3*omt*tFull*tFull, b3 = tFull*tFull*tFull;
  return {
    u: b0*P0.u + b1*P1.u + b2*P2.u + b3*P3.u,
    v: b0*P0.v + b1*P1.v + b2*P2.v + b3*P3.v,
  };
}

function samplePillCurve(N: number): UV[] {
  // Half the points on Bezier 1, half on Bezier 2 first-half. Skip duplicate at join.
  const pts: UV[] = [];
  const halfN = Math.floor(N / 2);
  for (let i = 0; i < halfN; i++) {
    pts.push(bezier1(i / (halfN - 0.5))); // last sample at t=halfN/(halfN-0.5) ≈ 1.0
  }
  // Bezier 2 first half — t' from 0 (already added by Bezier 1 endpoint) to 1 (the rightmost)
  for (let i = 1; i <= N - halfN; i++) {
    pts.push(bezier2FirstHalf(i / (N - halfN)));
  }
  return pts;
}

describe('Generate SS pill polyline for shader', () => {
  it('emits a vec2[N] GLSL const for the SS pill upper-right endcap quarter', () => {
    const N = 33; // 33 points = 32 segments — sub-pixel accuracy on a 60-tall pill
    const pts = samplePillCurve(N);

    console.log(`\nconst int SS_PILL_POINT_COUNT = ${pts.length};`);
    console.log(`const vec2 SS_PILL_CURVE[${pts.length}] = vec2[](`);
    for (let i = 0; i < pts.length; i++) {
      const sep = i === pts.length - 1 ? '' : ',';
      console.log(`  vec2(${pts[i].u.toFixed(6)}, ${pts[i].v.toFixed(6)})${sep}`);
    }
    console.log(`);`);
    console.log(`\n// Sanity:`);
    console.log(`//   first point: (${pts[0].u.toFixed(4)}, ${pts[0].v.toFixed(4)}) — should be ~(0, 1)`);
    console.log(`//   last point:  (${pts[pts.length-1].u.toFixed(4)}, ${pts[pts.length-1].v.toFixed(4)}) — should be ~(1, 0)`);
  });
});
