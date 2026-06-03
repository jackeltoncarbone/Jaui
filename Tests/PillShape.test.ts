import { describe, it, expect } from 'vitest';

/**
 * Ports Show Studio's `GeneratePillPath` Bezier control points to TS so we can
 * verify our shader's analytical pill SDF matches SS's Bezier shape numerically.
 *
 * From `show-studio/.../Jiv/Jiv.ts` line 1352+:
 *   curveWidth = 42.5 * endScale            (radius / 25 = endScale)
 *   y0..y5     = 0, 9, 18, 32, 41, 50 * (height/50)
 *   L.cp1 = -15.3, L.cp2 = -27.2, L.curve = -34.85, L.tip = -42.5
 */

const SS_CP1 = 15.3;
const SS_CP2 = 27.2;
const SS_CURVE = 34.85;
const SS_TIP = 42.5;

/** Evaluate cubic Bezier at parameter t. */
const cubicBezier = (t: number, p0: number, p1: number, p2: number, p3: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/**
 * Sample SS's pill left-cap outline at parameter y, returning the x-offset
 * inward from `lc` (positive = inward). Normalized for height=50, endScale=1.
 *
 * Left cap = 3 consecutive Bezier segments joining (lc, 0) → (lc, 50):
 *   seg 1: (lc,0) → (lc-34.85, 9)   via cp (lc-15.3,0), (lc-27.2,0)
 *   seg 2: (lc-34.85,9) → (lc-34.85,41)   via cp (lc-42.5,18), (lc-42.5,32)
 *   seg 3: (lc-34.85,41) → (lc,50)   via cp (lc-27.2,50), (lc-15.3,50)
 */
const ssCapOffset = (y: number): number => {
  // Find which segment y belongs to and the t that achieves it.
  if (y <= 9) {
    // Segment 1: y(t) = 9*t^3
    const t = Math.cbrt(y / 9);
    const x = cubicBezier(t, 0, SS_CP1, SS_CP2, SS_CURVE);
    return x;
  } else if (y <= 41) {
    // Segment 2 — cubic in y. Solve y(t) = (1-t)^3*9 + 3(1-t)^2 t*18 + 3(1-t)t^2*32 + t^3*41
    // Numerical solve via bisection.
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      const u = 1 - m;
      const yT = u * u * u * 9 + 3 * u * u * m * 18 + 3 * u * m * m * 32 + m * m * m * 41;
      if (yT < y) lo = m; else hi = m;
    }
    const t = (lo + hi) / 2;
    const x = cubicBezier(t, SS_CURVE, SS_TIP, SS_TIP, SS_CURVE);
    return x;
  } else {
    // Segment 3 — symmetric to segment 1 around y=50-9=41..50
    // y(t) = (1-t)^3*41 + 3(1-t)^2 t*50 + 3(1-t) t^2*50 + t^3*50
    // Simplify: at t=0, y=41. At t=1, y=50.
    // y(t) = 41(1-t)^3 + 50(1 - (1-t)^3) = 50 - 9(1-t)^3. So (1-t)^3 = (50-y)/9 → t = 1 - ((50-y)/9)^(1/3)
    const t = 1 - Math.cbrt((50 - y) / 9);
    const x = cubicBezier(t, SS_CURVE, SS_CP2, SS_CP1, 0);
    return x;
  }
};

/**
 * Our analytical approximation of SS's cap: extent(u) = maxExt * (1-u^2)^0.284
 * where u = |y − 25| / 25, maxExt = 40.59 (for endScale=1).
 */
const jauiCapExtent = (y: number): number => {
  const u = Math.abs(y - 25) / 25;
  const oneMinus = Math.max(1 - u * u, 0);
  return 40.59 * Math.pow(oneMinus, 0.284);
};

describe('Apple squircle-pill shape fidelity', () => {
  // Sanity: SS endpoints.
  it('SS cap starts at 0 offset at y=0', () => {
    expect(ssCapOffset(0)).toBeCloseTo(0, 1);
  });

  it('SS cap ends at 0 offset at y=50', () => {
    expect(ssCapOffset(50)).toBeCloseTo(0, 1);
  });

  it('SS cap reaches max bulge at y=25', () => {
    const x = ssCapOffset(25);
    expect(x).toBeGreaterThan(40);
    expect(x).toBeLessThan(42.5); // never hits the tip control point
  });

  it('SS cap at y=9 is the curve endpoint exactly 34.85', () => {
    expect(ssCapOffset(9)).toBeCloseTo(34.85, 2);
  });

  it('SS cap at y=41 is 34.85 (mirror)', () => {
    expect(ssCapOffset(41)).toBeCloseTo(34.85, 2);
  });

  // Fidelity checks: our analytical formula vs SS's Bezier at several y values.
  const tolerance = 1.5; // px tolerance for 50-tall pill

  it('jaui approx matches SS at y=0 (top tip)', () => {
    expect(jauiCapExtent(0)).toBeCloseTo(ssCapOffset(0), 1);
  });

  it('jaui approx matches SS at y=5', () => {
    expect(Math.abs(jauiCapExtent(5) - ssCapOffset(5))).toBeLessThan(tolerance);
  });

  it('jaui approx matches SS at y=9 (curve endpoint)', () => {
    expect(Math.abs(jauiCapExtent(9) - ssCapOffset(9))).toBeLessThan(tolerance);
  });

  it('jaui approx matches SS at y=18 (CP y-value)', () => {
    expect(Math.abs(jauiCapExtent(18) - ssCapOffset(18))).toBeLessThan(tolerance);
  });

  it('jaui approx matches SS at y=25 (middle max)', () => {
    expect(Math.abs(jauiCapExtent(25) - ssCapOffset(25))).toBeLessThan(tolerance);
  });

  it('jaui approx matches SS across the full profile within 1.5px', () => {
    let maxErr = 0;
    for (let y = 0; y <= 50; y += 0.5) {
      const err = Math.abs(jauiCapExtent(y) - ssCapOffset(y));
      if (err > maxErr) maxErr = err;
    }
    expect(maxErr).toBeLessThan(tolerance);
  });

  it('SS cap is wider in the middle than at the ends (non-uniform radius)', () => {
    // This is the key property: not a uniform capsule.
    expect(ssCapOffset(25)).toBeGreaterThan(ssCapOffset(9) * 1.05); // 5 %+ wider
  });

  it('jaui approx preserves non-uniform curvature', () => {
    expect(jauiCapExtent(25)).toBeGreaterThan(jauiCapExtent(9) * 1.05);
  });
});
