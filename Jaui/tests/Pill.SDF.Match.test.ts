/**
 * The shader's polyline pill must reproduce Apple's analytic endcap.
 *
 * This test used to assert the SDF matched Show Studio's 3-cubic-Bezier pill.
 * That reference is retired: the Bezier was itself a superellipse (L=1.540,
 * n=2.70) whose lead-in overshot Apple's measured 1.214, so every shape below
 * aspect 1.62 lost its straight side and rendered as an oval. The reference is
 * now the measured Apple cap, and the polyline is judged against it.
 */
import { describe, it, expect } from 'vitest';
import { readGlslCurve, appleCap, APPLE_LEAD_IN } from './Pill.Curve.Source';

const { maxExtent, points } = readGlslCurve();

/** Inside test for the shader's polyline pill, mirroring SS_PillSDF's geometry. */
function insidePolyline(px: number, py: number, halfX: number, halfY: number): boolean {
  const qx = Math.abs(px), qy = Math.abs(py);
  if (qy > halfY) return false;
  const flatStart = halfX - maxExtent * halfY;
  if (qx <= flatStart) return true;
  const lx = qx - flatStart;
  // the curve is single valued in v: find the u at this height and compare
  const t = qy / halfY;
  let u = 1;
  for (let i = 0; i < points.length - 1; i++) {
    const [u0, v0] = points[i], [u1, v1] = points[i + 1];
    if ((v0 >= t && t >= v1) || (v1 >= t && t >= v0)) {
      const f = Math.abs(v0 - v1) < 1e-9 ? 0 : (v0 - t) / (v0 - v1);
      u = u0 + f * (u1 - u0);
      break;
    }
  }
  return lx <= u * maxExtent * halfY;
}

function insideApple(px: number, py: number, halfX: number, halfY: number): boolean {
  const qx = Math.abs(px), qy = Math.abs(py);
  if (qy > halfY) return false;
  const flatStart = halfX - APPLE_LEAD_IN * halfY;
  if (qx <= flatStart) return true;
  const dx = appleCap(qy / halfY) * halfY;        // inward from the tip
  return qx <= halfX - dx;
}

function mismatch(W: number, H: number) {
  const halfX = W / 2, halfY = H / 2;
  let only = 0, both = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x - halfX + 0.5, py = y - halfY + 0.5;
      const a = insidePolyline(px, py, halfX, halfY);
      const b = insideApple(px, py, halfX, halfY);
      if (a && b) both++;
      else if (a || b) only++;
    }
  }
  return { only, both, pct: (only / (only + both)) * 100 };
}

describe('polyline pill reproduces Apple measured cap', () => {
  for (const [W, H] of [[440, 60], [348, 50], [90, 44], [69, 46], [63, 31]] as Array<[number, number]>) {
    it(`matches within 0.5% of shape area at ${W}x${H}`, () => {
      const r = mismatch(W, H);
      expect(r.pct).toBeLessThan(0.5);
    });
  }

  // The straight side does NOT come from the flat-zone branch: at a 1.54 lead-in that
  // branch is unreachable below aspect 1.54 by construction. It comes from the curve
  // hugging the edge, so assert that instead of asserting a flat zone exists.
  it('the cap hugs the edge rather than relying on a flat zone', () => {
    const mid = points.find((pt) => pt[0] >= 0.5)!;
    expect(mid[1]).toBeGreaterThan(0.88);
  });
});
