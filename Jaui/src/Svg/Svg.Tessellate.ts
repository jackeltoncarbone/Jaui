/**
 * Fill tessellation — flattened contours into a triangle soup for the fill batch, plus a
 * ~1px outward coverage "skirt" along each boundary for feathered anti-aliasing (the Jline
 * perpendicular-distance idea generalized to fills: each fragment's alpha = tint.a * coverage,
 * coverage = 1 inside, ramping to 0 across the skirt). Each vertex is [x, y, coverage].
 *
 * Phase 1: simple polygons via ear clipping (handles convex + concave, NO holes — the icon
 * rounded-rects and triangles). Holes / even-odd (the field logo counters) come in Phase 2,
 * either by hole-bridging here or vendoring full earcut.
 */

import { SvgContour } from './Svg.Types';
import { Earcut } from './Svg.Earcut';

export const SVG_FILL_FLOATS_PER_VERTEX = 3; // x, y, coverage

export interface SvgFillMesh {
  /** Interleaved [x, y, cov] triangle-soup vertices (3 verts per triangle). */
  Verts: Float32Array;
  VertCount: number;
}

function signedArea(p: number[]): number {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

/** Point-in-polygon (even-odd ray cast) — classifies which contours are holes of which outer. */
function pointInPoly(px: number, py: number, p: number[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length / 2 - 1, n = p.length / 2; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Outward-offset skirt: a feather band around the ring, cov 1 (on the boundary) -> 0 (outer). */
function buildSkirt(pts: number[], offset: number, out: number[]): void {
  const n = pts.length / 2;
  if (n < 3 || offset <= 0) return;
  // Ensure CCW so the outward normal is consistently to the right of travel.
  let ring = pts;
  if (signedArea(pts) < 0) {
    ring = [];
    for (let i = n - 1; i >= 0; i--) ring.push(pts[i * 2], pts[i * 2 + 1]);
  }
  // Per-vertex outward miter offset (mirror of Jline's miter math, pointing OUT of the fill).
  const ox = new Float64Array(n), oy = new Float64Array(n);
  const nx = new Float64Array(n), ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ax = ring[i * 2], ay = ring[i * 2 + 1];
    const bx = ring[((i + 1) % n) * 2], by = ring[((i + 1) % n) * 2 + 1];
    let dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    nx[i] = dy; ny[i] = -dx; // outward for CCW
  }
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n;
    let mx = nx[p] + nx[i], my = ny[p] + ny[i];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const scale = 1 / Math.max(0.3, mx * nx[i] + my * ny[i]);
    ox[i] = mx * offset * scale;
    oy[i] = my * offset * scale;
  }
  // Two triangles per edge: inner edge (cov 1) -> outer offset edge (cov 0).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const aix = ring[i * 2], aiy = ring[i * 2 + 1];
    const ajx = ring[j * 2], ajy = ring[j * 2 + 1];
    const aox = aix + ox[i], aoy = aiy + oy[i];
    const box = ajx + ox[j], boy = ajy + oy[j];
    out.push(aix, aiy, 1, ajx, ajy, 1, aox, aoy, 0);
    out.push(ajx, ajy, 1, box, boy, 0, aox, aoy, 0);
  }
}

/**
 * Tessellate one fill shape (its contours share a color) into a coverage-AA mesh via Earcut.
 * A contour fully inside a larger one (a letter counter) is treated as a HOLE and punched out;
 * disjoint contours each tessellate as their own outer.
 * @param skirtOffset outward feather width in viewBox units (~1 device px); 0 disables.
 */
export function TessellateFill(contours: SvgContour[], skirtOffset: number): SvgFillMesh {
  const verts: number[] = [];
  const pts = contours.map(c => c.Points).filter(p => p.length >= 6);
  if (pts.length === 0) return { Verts: new Float32Array(0), VertCount: 0 };

  // Classify each contour: a hole of the smallest larger contour that contains it.
  const areas = pts.map(p => Math.abs(signedArea(p)));
  const holeOf: number[] = pts.map(() => -1);
  for (let i = 0; i < pts.length; i++) {
    let bestArea = Infinity, best = -1;
    for (let j = 0; j < pts.length; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      if (areas[j] < bestArea && pointInPoly(pts[i][0], pts[i][1], pts[j])) { bestArea = areas[j]; best = j; }
    }
    holeOf[i] = best;
  }

  for (let i = 0; i < pts.length; i++) {
    if (holeOf[i] !== -1) continue; // a hole — emitted with its outer
    const outer = pts[i];
    const data = outer.slice();
    const holeIndices: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      if (holeOf[k] !== i) continue;
      holeIndices.push(data.length / 2);
      for (let n = 0; n < pts[k].length; n++) data.push(pts[k][n]);
    }
    const tris = Earcut(data, holeIndices);
    for (let t = 0; t < tris.length; t += 3) {
      for (let s = 0; s < 3; s++) { const v = tris[t + s]; verts.push(data[v * 2], data[v * 2 + 1], 1); }
    }
    buildSkirt(outer, skirtOffset, verts);
  }
  return { Verts: new Float32Array(verts), VertCount: verts.length / SVG_FILL_FLOATS_PER_VERTEX };
}
