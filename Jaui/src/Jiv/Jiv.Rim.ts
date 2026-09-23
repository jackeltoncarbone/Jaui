import { SS_PILL_CURVE, SS_PILL_SEGMENTS } from './Pill.Curve';

/**
 * THE RIM: the light a glass edge catches, drawn as a thin strip along the panel's outline and
 * lifted onto what is already there, a gain that keeps the color's hue and a little white
 * (Shaders/Jiv.Rim.frag). Apple's is a crisp core in device pixels whose width and brightness both
 * follow the angle to the light: widest at the lit lobes, about a pixel on the sides.
 *
 * `Jiv.Panel.frag` draws a panel's edge from a distance field (`CornerParams`, `ShapeSDF_inner`,
 * `SS_PillSDF`). This file is that field on the CPU, expression for expression, walked once per shape
 * so the rim follows the exact edge the fill antialiases. The renderer caches the strip by shape, so a
 * resting panel walks it once.
 */

/** A panel's shape in device px, as `JivInstanceBuffer.Push` packs it: half extents, per-corner drawn
 *  radii (tl, tr, br, bl) and the smoothness lane (smoothness fraction plus the authored radius in
 *  sixteenths of a device px above it). */
export interface JivShape {
  HalfWidth: number;
  HalfHeight: number;
  Radii: readonly [number, number, number, number];
  Smoothness: number;
}

/** The rim's width on the sides, as a share of its width at the lobes (`RimWidth`). */
export const RIM_SIDE_SHARE = 0.45;

/** One rim draw, in device px. `Shape` and the placement are the panel instance's own
 *  (`JivPanelShapeOf`); a projective panel carries its homography row and natural box instead. */
export interface RimDrawParams {
  Shape: JivShape;
  CenterX: number;
  CenterY: number;
  Cos: number;
  Sin: number;
  /** Row in the homography table, -1 for a 2D panel. */
  XformIndex: number;
  NaturalX: number;
  NaturalY: number;
  NaturalWidth: number;
  NaturalHeight: number;
  /** Core width where the rim faces the light, and 90 degrees off it. */
  LobeWidth: number;
  SideWidth: number;
  Strength: number;
  Opacity: number;
  /** Radians, the panel's LightAngle. */
  LightAngle: number;
  ClipOffset: number;
  ClipCount: number;
}

/** Floats per strip vertex: outline x, y (device px from the center), outward normal x, y, side
 *  (0 outer, 1 inner) and the outline's local radius of curvature. */
export const RIM_FLOATS_PER_VERTEX = 6;

const PILL_MAX_EXTENT = 1.54;
const CORNER_SAT_FRACTION = 0.12;
const CORNER_ASPECT_LOW = 1.02;
const CORNER_ASPECT_HIGH = 1.10;

const _clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const _mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const _smoothstep = (e0: number, e1: number, x: number): number => {
  const t = _clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const _superellipseDistance = (px: number, py: number, hw: number, hh: number, radius: number, n: number): number => {
  const r = Math.max(radius, 1e-3);
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  if (qx <= 0 && qy <= 0) return -Math.min(hw - Math.abs(px), hh - Math.abs(py));
  const ux = Math.max(Math.max(qx, 0) / r, 1e-5);
  const uy = Math.max(Math.max(qy, 0) / r, 1e-5);
  const l = Math.pow(Math.pow(ux, n) + Math.pow(uy, n), 1 / n);
  const gx = Math.pow(ux, n - 1) / r;
  const gy = Math.pow(uy, n - 1) / r;
  const gradient = Math.pow(l, 1 - n) * Math.sqrt(gx * gx + gy * gy);
  return (l - 1) / Math.max(gradient, 1e-5);
};

const _pillDistance = (px: number, py: number, hw: number, hh: number): number => {
  const horizontal = hw >= hh;
  const qx = horizontal ? Math.abs(px) : Math.abs(py);
  const qy = horizontal ? Math.abs(py) : Math.abs(px);
  const halfX = horizontal ? hw : hh;
  const halfY = horizontal ? hh : hw;
  const maxExtent = PILL_MAX_EXTENT * halfY;
  const flatStart = halfX - maxExtent;
  if (qx <= flatStart) return qy - halfY;
  const lx = qx - flatStart;
  let minSquared = 1e9;
  let bracketU = -1;
  let bracketFound = false;
  for (let i = 0; i < SS_PILL_SEGMENTS; i++) {
    const ax = SS_PILL_CURVE[i * 2] * maxExtent, ay = SS_PILL_CURVE[i * 2 + 1] * halfY;
    const bx = SS_PILL_CURVE[i * 2 + 2] * maxExtent, by = SS_PILL_CURVE[i * 2 + 3] * halfY;
    const abx = bx - ax, aby = by - ay;
    const t = _clamp(((lx - ax) * abx + (qy - ay) * aby) / (abx * abx + aby * aby), 0, 1);
    const dx = lx - (ax + t * abx), dy = qy - (ay + t * aby);
    minSquared = Math.min(minSquared, dx * dx + dy * dy);
    if (!bracketFound && qy <= ay && qy >= by) {
      const dv = ay - by;
      bracketU = _mix(ax, bx, dv > 0.0001 ? (ay - qy) / dv : 0);
      bracketFound = true;
    }
  }
  const distance = Math.sqrt(minSquared);
  return qy <= halfY && bracketU > 0 && lx <= bracketU ? -distance : distance;
};

interface _CornerField { PillWeight: number; Exponent: number; Radius: number }

const _cornerField = (px: number, py: number, s: JivShape, out: _CornerField): void => {
  const minHalf = Math.min(s.HalfWidth, s.HalfHeight);
  const aspect = Math.max(s.HalfWidth, s.HalfHeight) / Math.max(minHalf, 0.0001);
  const authoredRadius = Math.floor(s.Smoothness * 0.5) / 16;
  const smoothness = s.Smoothness - 2 * Math.floor(s.Smoothness * 0.5);
  const band = Math.max(minHalf * CORNER_SAT_FRACTION, 1);
  const saturation = _smoothstep(minHalf - band, minHalf - 1, authoredRadius);
  const elongation = _smoothstep(CORNER_ASPECT_LOW, CORNER_ASPECT_HIGH, aspect);
  const picked = px >= 0 ? (py <= 0 ? s.Radii[1] : s.Radii[2]) : (py <= 0 ? s.Radii[0] : s.Radii[3]);
  out.Radius = Math.min(picked, minHalf);
  out.Exponent = _mix(2 + 6 * _clamp(smoothness, 0, 1), 2, saturation * (1 - elongation));
  out.PillWeight = saturation * elongation;
};

const _field: _CornerField = { PillWeight: 0, Exponent: 2, Radius: 0 };

/** The shader's `CornerDist`: signed distance to the panel edge, negative inside, device px. */
export const JivShapeDistance = (px: number, py: number, s: JivShape): number => {
  _cornerField(px, py, s, _field);
  if (_field.PillWeight >= 1) return _pillDistance(px, py, s.HalfWidth, s.HalfHeight);
  const superellipse = _superellipseDistance(px, py, s.HalfWidth, s.HalfHeight, _field.Radius, _field.Exponent);
  if (_field.PillWeight <= 0) return superellipse;
  return _mix(superellipse, _pillDistance(px, py, s.HalfWidth, s.HalfHeight), _field.PillWeight);
};

/** Where a ray from (ox, oy) along (dx, dy) crosses the edge: Illinois false position on the field,
 *  which is near-Euclidean at the edge, so it converges in a handful of steps. */
const _crossing = (ox: number, oy: number, dx: number, dy: number, reach: number, s: JivShape): number => {
  let lo = 0, hi = reach;
  let flo = JivShapeDistance(ox, oy, s);
  let fhi = JivShapeDistance(ox + dx * hi, oy + dy * hi, s);
  if (flo >= 0) return 0;
  if (fhi <= 0) return hi;
  let side = 0;
  for (let i = 0; i < 48; i++) {
    const t = (lo * fhi - hi * flo) / (fhi - flo);
    const f = JivShapeDistance(ox + dx * t, oy + dy * t, s);
    if (Math.abs(f) < 1e-4 || hi - lo < 1e-5) return t;
    if (f < 0) {
      lo = t; flo = f;
      if (side === -1) fhi *= 0.5;
      side = -1;
    } else {
      hi = t; fhi = f;
      if (side === 1) flo *= 0.5;
      side = 1;
    }
  }
  return (lo + hi) * 0.5;
};

/**
 * The closed outline as a triangle strip: for each point, an outer and an inner vertex at the same
 * position, so the vertex shader can push them apart along the normal by widths that depend on the
 * device and the light, not on the shape.
 *
 * Each quadrant is walked by rays from the inner corner of its corner box (the superellipse's, the
 * pill cap's, or the larger of the two while a corner morphs between them), so the samples fall
 * along the curve rather than across the straight edges between corners. Normals are the field's
 * own gradient at the edge.
 */
export const BuildJivOutline = (s: JivShape): Float32Array => {
  const hw = s.HalfWidth, hh = s.HalfHeight;
  const minHalf = Math.min(hw, hh);
  const points: number[] = [];
  const quadrants: ReadonlyArray<readonly [number, number, number, boolean]> = [
    [1, 1, 2, false], [-1, 1, 3, true], [-1, -1, 0, false], [1, -1, 1, true],
  ];
  const pillExtentX = hw >= hh ? Math.min(hw, PILL_MAX_EXTENT * hh) : hw;
  const pillExtentY = hw >= hh ? hh : Math.min(hh, PILL_MAX_EXTENT * hw);
  for (const [sx, sy, corner, reversed] of quadrants) {
    _cornerField(sx * hw * 0.5, sy * hh * 0.5, s, _field);
    const radius = Math.min(s.Radii[corner], minHalf);
    let extentX = _field.PillWeight < 1 ? radius : 0;
    let extentY = extentX;
    if (_field.PillWeight > 0) {
      extentX = Math.max(extentX, pillExtentX);
      extentY = Math.max(extentY, pillExtentY);
    }
    const ox = Math.max(0, hw - extentX), oy = Math.max(0, hh - extentY);
    const reach = Math.hypot(hw - ox, hh - oy) + 2;
    const steps = Math.round(_clamp(Math.ceil(2.5 * Math.sqrt(Math.max(extentX, extentY, 1))), 3, 40));
    for (let k = 0; k <= steps; k++) {
      const i = reversed ? steps - k : k;
      const angle = (Math.PI * 0.5 * i) / steps;
      const dx = Math.cos(angle) * sx, dy = Math.sin(angle) * sy;
      const t = _crossing(ox * sx, oy * sy, dx, dy, reach, s);
      const x = ox * sx + dx * t, y = oy * sy + dy * t;
      const n = points.length;
      if (n >= 2 && Math.abs(points[n - 2] - x) < 1e-3 && Math.abs(points[n - 1] - y) < 1e-3) continue;
      points.push(x, y);
    }
  }
  if (points.length >= 4 && Math.abs(points[0] - points[points.length - 2]) < 1e-3
      && Math.abs(points[1] - points[points.length - 1]) < 1e-3) points.length -= 2;

  const count = points.length / 2;
  const normals = new Float64Array(count * 2);
  const h = 0.05;
  for (let i = 0; i < count; i++) {
    const x = points[i * 2], y = points[i * 2 + 1];
    const gx = JivShapeDistance(x + h, y, s) - JivShapeDistance(x - h, y, s);
    const gy = JivShapeDistance(x, y + h, s) - JivShapeDistance(x, y - h, s);
    const g = Math.hypot(gx, gy) || 1;
    normals[i * 2] = gx / g;
    normals[i * 2 + 1] = gy / g;
  }

  const out = new Float32Array((count + 1) * 2 * RIM_FLOATS_PER_VERTEX);
  for (let k = 0; k <= count; k++) {
    const i = k % count;
    const prev = (i + count - 1) % count, next = (i + 1) % count;
    const turn = Math.acos(_clamp(normals[prev * 2] * normals[next * 2] + normals[prev * 2 + 1] * normals[next * 2 + 1], -1, 1));
    const arc = Math.hypot(points[next * 2] - points[prev * 2], points[next * 2 + 1] - points[prev * 2 + 1]);
    const curvatureRadius = turn > 1e-6 ? arc / turn : 1e6;
    for (let side = 0; side < 2; side++) {
      const o = (k * 2 + side) * RIM_FLOATS_PER_VERTEX;
      out[o] = points[i * 2];
      out[o + 1] = points[i * 2 + 1];
      out[o + 2] = normals[i * 2];
      out[o + 3] = normals[i * 2 + 1];
      out[o + 4] = side;
      out[o + 5] = curvatureRadius;
    }
  }
  return out;
};
