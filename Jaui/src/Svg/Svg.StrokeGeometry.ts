/**
 * SVG stroke geometry — flattened contours into per-segment miter-quad instances for the
 * SVG stroke batch. This mirrors the Jline miter-vertex math (shared vertex offset → exact
 * tiling, no beading; per-fragment perpendicular-distance SDF for smooth AA), but with its
 * OWN buffer layout (no arc/phase/collide lanes — those are comet-specific). Strokes are a
 * separate concept from the `Jline` editor primitive; only the geometry idea is borrowed.
 *
 * Per-segment instance (8 floats), consumed by Renderer.SvgStrokeAddInstance:
 *   a_Seg   = (Ax, Ay, Bx, By)        — true endpoints (fragment SDF distance)
 *   a_Miter = (mAx, mAy, mBx, mBy)     — perpendicular offset at each end (scaled by halfExtent)
 * Half-width + feather come from a per-draw uniform; halfExtent (= halfWidth + feather) is
 * baked into the miter so the quad covers the AA band.
 */

import { SvgContour } from './Svg.Types';

export const SVG_STROKE_FLOATS_PER_SEGMENT = 8;

const _MITER_MIN = 0.3;
let _nx = new Float64Array(0), _ny = new Float64Array(0);
let _mx = new Float64Array(0), _my = new Float64Array(0);
function ensure(n: number): void {
  if (_mx.length >= n) return;
  _nx = new Float64Array(Math.max(n - 1, 1)); _ny = new Float64Array(Math.max(n - 1, 1));
  _mx = new Float64Array(n); _my = new Float64Array(n);
}

/** Count segments a contour contributes (closed adds the wrap-around edge). */
function segCount(c: SvgContour): number {
  const n = c.Points.length / 2;
  if (n < 2) return 0;
  return c.Closed ? n : n - 1;
}

export interface SvgStrokeMesh {
  Data: Float32Array;
  SegmentCount: number;
}

/** Build stroke instances for all contours of one shape (shared width). halfExtent in viewBox units. */
export function BuildStrokeGeometry(contours: SvgContour[], halfExtent: number): SvgStrokeMesh {
  let total = 0;
  for (const c of contours) total += segCount(c);
  const data = new Float32Array(total * SVG_STROKE_FLOATS_PER_SEGMENT);
  let o = 0;
  for (const c of contours) {
    const segs = segCount(c);
    if (segs === 0) continue;
    const n = c.Points.length / 2;
    const wrap = c.Closed;
    const vCount = wrap ? n + 1 : n; // virtual vertex list (closed repeats v0)
    const at = (i: number): number => (i % n);
    ensure(vCount);
    // Edge unit normals.
    for (let k = 0; k < segs; k++) {
      const a = at(k) * 2, b = at(k + 1) * 2;
      let dx = c.Points[b] - c.Points[a], dy = c.Points[b + 1] - c.Points[a + 1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      _nx[k] = -dy; _ny[k] = dx;
    }
    // Per-vertex miter offset.
    for (let i = 0; i < vCount; i++) {
      let mx: number, my: number, scale = 1;
      const prevSeg = i - 1, curSeg = i;
      const hasPrev = wrap ? true : i > 0;
      const hasCur = wrap ? true : i < segs;
      const pSeg = (prevSeg + segs) % segs, cSeg = (curSeg + segs) % segs;
      if (!hasPrev) { mx = _nx[cSeg]; my = _ny[cSeg]; }
      else if (!hasCur) { mx = _nx[pSeg]; my = _ny[pSeg]; }
      else {
        let ax = _nx[pSeg] + _nx[cSeg], ay = _ny[pSeg] + _ny[cSeg];
        const al = Math.hypot(ax, ay) || 1;
        ax /= al; ay /= al;
        scale = 1 / Math.max(_MITER_MIN, ax * _nx[cSeg] + ay * _ny[cSeg]);
        mx = ax; my = ay;
      }
      _mx[i] = mx * halfExtent * scale;
      _my[i] = my * halfExtent * scale;
    }
    for (let k = 0; k < segs; k++) {
      const a = at(k) * 2, b = at(k + 1) * 2;
      data[o + 0] = c.Points[a]; data[o + 1] = c.Points[a + 1];
      data[o + 2] = c.Points[b]; data[o + 3] = c.Points[b + 1];
      data[o + 4] = _mx[k]; data[o + 5] = _my[k];
      data[o + 6] = _mx[k + 1]; data[o + 7] = _my[k + 1];
      o += SVG_STROKE_FLOATS_PER_SEGMENT;
    }
  }
  return { Data: data, SegmentCount: total };
}
