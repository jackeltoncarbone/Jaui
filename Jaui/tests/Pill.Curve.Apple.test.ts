/**
 * The pill curve must BE Apple's, and both shaders must agree on it.
 *
 * This replaces the old premise, which asserted the SDF reproduced Show Studio's
 * 3-cubic-Bezier pill. That Bezier turned out to be a superellipse in disguise
 * (L=1.540, n=2.70) whose lead-in ran well past Apple's, so any shape below
 * aspect 1.62 had no straight side at all and rendered as an oval.
 */
import { describe, it, expect } from 'vitest';
import {
  readGlslCurve, readWgslCurve, appleCap,
  APPLE_LEAD_IN, APPLE_EXPONENT_X, APPLE_EXPONENT_Y,
} from './Pill.Curve.Source';

describe('pill curve tracks Apple', () => {
  it('GLSL and WGSL carry the same curve', () => {
    const a = readGlslCurve(), b = readWgslCurve();
    expect(b.maxExtent).toBeCloseTo(a.maxExtent, 6);
    expect(b.points.length).toBe(a.points.length);
    for (let i = 0; i < a.points.length; i++) {
      expect(b.points[i][0]).toBeCloseTo(a.points[i][0], 5);
      expect(b.points[i][1]).toBeCloseTo(a.points[i][1], 5);
    }
  });

  it('the lead-in is Apple measured value', () => {
    expect(readGlslCurve().maxExtent).toBeCloseTo(APPLE_LEAD_IN, 4);
  });

  it('every point lies on the measured superellipse', () => {
    const { maxExtent, points } = readGlslCurve();
    let worst = 0;
    for (const [u, v] of points) {
      const dxActual = (1 - u) * maxExtent;        // inward from the tip, halfY units
      const dxIdeal = appleCap(v);
      worst = Math.max(worst, Math.abs(dxActual - dxIdeal));
    }
    // 1e-3 halfY is 0.023pt on the held thumb: far below a device pixel.
    expect(worst).toBeLessThan(1e-3);
  });

  it('starts at the tangent point and ends at the tip', () => {
    const { points } = readGlslCurve();
    expect(points[0][0]).toBeCloseTo(0, 6);
    expect(points[0][1]).toBeCloseTo(1, 6);
    expect(points[points.length - 1][0]).toBeCloseTo(1, 6);
    expect(points[points.length - 1][1]).toBeCloseTo(0, 6);
  });

  it('is sampled by arc length, so no chord is long enough to facet', () => {
    const { maxExtent, points } = readGlslCurve();
    const chords: number[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const dx = (points[i + 1][0] - points[i][0]) * maxExtent;
      const dy = points[i + 1][1] - points[i][1];
      chords.push(Math.hypot(dx, dy));
    }
    const ratio = Math.max(...chords) / Math.min(...chords);
    // uniform-v sampling gave a first chord ~6x the last, right at the tangent
    expect(ratio).toBeLessThan(1.2);
  });

  // The straight side on this curve is NOT the flat-zone branch: at a lead-in of 1.54 that
  // branch is unreachable below aspect 1.54. The near-flat run comes from the high horizontal
  // exponent, so assert the CURVE is flat near the tangent rather than that a flat zone exists.
  it('the cap runs near-flat before it turns', () => {
    // Read the SHIPPED table: halfway along the cap the edge should still sit high,
    // which is the long near-flat run that reads as a straight side. A symmetric
    // exponent near 2 drops away immediately and reads as an ellipse instead.
    const { points } = readGlslCurve();
    const mid = points.find((pt) => pt[0] >= 0.5)!;
    expect(mid[1]).toBeGreaterThan(0.88);
    const quarter = points.find((pt) => pt[0] >= 0.25)!;
    expect(quarter[1]).toBeGreaterThan(0.97);
  });

  // A deliberate tripwire: the curve can be regenerated from (L, n), so both are pinned here.
  // Changing the shape means changing these on purpose, which is exactly what should fail a run.
  it('the curve parameters are pinned', () => {
    expect(APPLE_LEAD_IN).toBeCloseTo(1.540, 4);
    expect(APPLE_EXPONENT_X).toBeCloseTo(3.65, 4);
    expect(APPLE_EXPONENT_Y).toBeCloseTo(1.80, 4);
  });
});
