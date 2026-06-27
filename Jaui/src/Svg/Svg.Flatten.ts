/**
 * Curve flattening — turn cubic/quadratic Béziers and elliptical arcs into polylines
 * within a flatness tolerance (user units). The tolerance is chosen by the caller from
 * the element's expected device size so the screen-space error stays ~sub-pixel; see
 * Svg.Parse's tolerance bucketing. All functions ASSUME the start point is already the
 * last pair in `out` and append intermediate + end points.
 */

const MAX_DEPTH = 18;

/** Append a point to a flat x,y array unless it duplicates the previous one. */
function push(out: number[], x: number, y: number): void {
  const n = out.length;
  if (n >= 2 && out[n - 2] === x && out[n - 1] === y) return;
  out.push(x, y);
}

/**
 * Cubic Bézier via recursive de Casteljau. Subdivides until the control points lie within
 * `tol` of the chord (flat enough to draw as a line). `tol2` is tol² (caller passes squared).
 */
export function FlattenCubic(
  out: number[],
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  tol2: number, depth = 0,
): void {
  // Flatness test: max distance of the two control points to the baseline P0->P3.
  const dx = x3 - x0;
  const dy = y3 - y0;
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  if (depth >= MAX_DEPTH || (d1 + d2) * (d1 + d2) < tol2 * (dx * dx + dy * dy)) {
    push(out, x3, y3);
    return;
  }
  // Split at t = 0.5.
  const x01 = (x0 + x1) * 0.5, y01 = (y0 + y1) * 0.5;
  const x12 = (x1 + x2) * 0.5, y12 = (y1 + y2) * 0.5;
  const x23 = (x2 + x3) * 0.5, y23 = (y2 + y3) * 0.5;
  const xa = (x01 + x12) * 0.5, ya = (y01 + y12) * 0.5;
  const xb = (x12 + x23) * 0.5, yb = (y12 + y23) * 0.5;
  const xm = (xa + xb) * 0.5, ym = (ya + yb) * 0.5;
  FlattenCubic(out, x0, y0, x01, y01, xa, ya, xm, ym, tol2, depth + 1);
  FlattenCubic(out, xm, ym, xb, yb, x23, y23, x3, y3, tol2, depth + 1);
}

/** Quadratic Bézier — degree-elevate to cubic and reuse the cubic flattener. */
export function FlattenQuadratic(
  out: number[],
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
  tol2: number,
): void {
  const c1x = x0 + (2 / 3) * (x1 - x0), c1y = y0 + (2 / 3) * (y1 - y0);
  const c2x = x2 + (2 / 3) * (x1 - x2), c2y = y2 + (2 / 3) * (y1 - y2);
  FlattenCubic(out, x0, y0, c1x, c1y, c2x, c2y, x2, y2, tol2);
}

/**
 * Elliptical arc (SVG `A` command) via endpoint -> center parameterization (SVG spec F.6.5),
 * then sampled at an angular step that keeps the chord error under sqrt(tol2). Start point
 * (x0,y0) is already in `out`; appends to (x,y).
 */
export function FlattenArc(
  out: number[],
  x0: number, y0: number,
  rx: number, ry: number, xAxisRotDeg: number,
  largeArc: boolean, sweep: boolean,
  x: number, y: number,
  tol2: number,
): void {
  if (rx === 0 || ry === 0) { push(out, x, y); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (xAxisRotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);

  // Step 1: compute (x1', y1').
  const dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  // Correct out-of-range radii.
  let rx2 = rx * rx, ry2 = ry * ry;
  const lambda = (x1p * x1p) / rx2 + (y1p * y1p) / ry2;
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; rx2 = rx * rx; ry2 = ry * ry; }

  // Step 2: compute (cx', cy').
  let sign = largeArc === sweep ? -1 : 1;
  let num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  num = num < 0 ? 0 : num;
  const denom = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const co = sign * Math.sqrt(num / (denom || 1));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;

  // Step 3: compute (cx, cy) and the angles.
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  // Sample: pick step so the chord-sag of the larger radius stays under the tolerance.
  const rMax = Math.max(rx, ry);
  const tol = Math.sqrt(tol2);
  const maxStep = 2 * Math.acos(Math.max(0, 1 - tol / Math.max(rMax, tol)));
  const segs = Math.max(2, Math.ceil(Math.abs(dTheta) / Math.max(maxStep, 1e-3)));
  for (let i = 1; i <= segs; i++) {
    const t = theta1 + (dTheta * i) / segs;
    const cosT = Math.cos(t), sinT = Math.sin(t);
    const px = cosP * rx * cosT - sinP * ry * sinT + cx;
    const py = sinP * rx * cosT + cosP * ry * sinT + cy;
    push(out, px, py);
  }
}
