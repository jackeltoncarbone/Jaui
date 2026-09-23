/**
 * THE CONTINUOUS CORNER ON THE CPU: `Shaders/Corner.Continuous.glsl`'s `ContinuousCorner`, the same
 * construction and the same steps in doubles, for what has to reason about a shape's pixels without a
 * GPU (the `?glass-skip` census, the tests). The shader is the truth.
 */

const CORNER_EASE_STEPS = 8;

interface Ease { Alpha: number; A: number; B: number; Meet: [number, number] }

const cornerEase = (r: number, s: number, extent: number): Ease => {
  const alpha = (45 * s * Math.PI) / 180;
  const c = r * Math.tan(alpha * 0.5) * Math.cos(alpha);
  const d = r * (1 - Math.cos(alpha));
  const b = (extent - r * (1 - Math.sin(alpha)) - c) / 3;
  return { Alpha: alpha, A: 2 * b, B: b, Meet: [r * (1 - Math.sin(alpha)), d] };
};

const unit = (x: number, y: number): [number, number] => {
  const l = Math.sqrt(Math.max(x * x + y * y, 1e-18));
  return [x / l, y / l];
};

/** Signed distance (negative inside) from (px, py), taken from the shape's centre, to the
 *  continuous-cornered box of half size (halfW, halfH), per-corner radii (tl, tr, br, bl) and
 *  smoothing `smoothing`. With `out`, writes [distance, outward x, outward y] into it. */
export const ContinuousCorner = (
  px: number, py: number, halfW: number, halfH: number,
  radii: readonly number[], smoothing: number, out?: Float64Array,
): number => {
  const facingX = px < 0 ? -1 : 1, facingY = py < 0 ? -1 : 1;
  const done = (d: number, nx: number, ny: number): number => {
    if (out !== undefined) { out[0] = d; out[1] = nx * facingX; out[2] = ny * facingY; }
    return d;
  };
  const qx = Math.abs(px), qy = Math.abs(py);
  let r = px >= 0 ? (py <= 0 ? radii[1] : radii[2]) : (py <= 0 ? radii[0] : radii[3]);
  r = Math.min(Math.max(r, 0), Math.min(halfW, halfH));
  const wx = halfW - qx, wy = halfH - qy;
  if (r < 1e-3) {
    const ox = Math.max(-wx, 0), oy = Math.max(-wy, 0);
    const d = Math.hypot(ox, oy) + Math.min(Math.max(-wx, -wy), 0);
    if (d > 0 && ox + oy > 0) { const [ux, uy] = unit(ox, oy); return done(d, ux, uy); }
    return done(d, wx < wy ? 1 : 0, wx < wy ? 0 : 1);
  }
  const s = Math.min(Math.max(smoothing, 0), 1);
  const ex = Math.min((1 + s) * r, halfW), ey = Math.min((1 + s) * r, halfH);
  if (wx >= ex && wy >= ey) return done(-Math.min(wx, wy), wx < wy ? 1 : 0, wx < wy ? 0 : 1);
  const sx = Math.max(ex / r - 1, 0), sy = Math.max(ey / r - 1, 0);

  let best = 1e20;
  let bestPoint: [number, number] = [wx, wy];
  let bestInward: [number, number] = [0, 1];
  const nearest = (fx: number, fy: number, tx: number, ty: number, inward: [number, number]): void => {
    const sxv = tx - fx, syv = ty - fy;
    const t = Math.min(Math.max(((wx - fx) * sxv + (wy - fy) * syv) / Math.max(sxv * sxv + syv * syv, 1e-12), 0), 1);
    const ptx = fx + sxv * t, pty = fy + syv * t;
    const d2 = (wx - ptx) ** 2 + (wy - pty) ** 2;
    if (d2 < best) { best = d2; bestPoint = [ptx, pty]; bestInward = inward; }
  };
  nearest(ex, 0, ex + 1e5, 0, [0, 1]);
  nearest(0, ey, 0, ey + 1e5, [1, 0]);
  const X = cornerEase(r, sx, ex);
  const Y = cornerEase(r, sy, ey);
  const fcx = wx - r, fcy = wy - r;
  const reach = Math.hypot(fcx, fcy);
  const angle = Math.atan2(-fcx, -fcy);
  if (reach > 1e-5 && angle >= X.Alpha && angle <= Math.PI / 2 - Y.Alpha) {
    const ptx = r + (fcx / reach) * r, pty = r + (fcy / reach) * r;
    const d2 = (wx - ptx) ** 2 + (wy - pty) ** 2;
    if (d2 < best) { best = d2; bestPoint = [ptx, pty]; bestInward = [-fcx / reach, -fcy / reach]; }
  }
  const x0: [number, number] = [ex, 0], x1: [number, number] = [ex - X.A, 0], x2: [number, number] = [ex - X.A - X.B, 0];
  const x3 = X.Meet;
  const y0: [number, number] = [0, ey], y1: [number, number] = [0, ey - Y.A], y2: [number, number] = [0, ey - Y.A - Y.B];
  const y3: [number, number] = [Y.Meet[1], Y.Meet[0]];
  const bez = (p0: number[], p1: number[], p2: number[], p3: number[], t: number, k: number): number => {
    const u = 1 - t;
    return u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k];
  };
  let prevX: [number, number] = x0, prevY: [number, number] = y0;
  for (let i = 1; i <= CORNER_EASE_STEPS; i++) {
    const t = i / CORNER_EASE_STEPS;
    const nextX: [number, number] = [bez(x0, x1, x2, x3, t, 0), bez(x0, x1, x2, x3, t, 1)];
    const nextY: [number, number] = [bez(y0, y1, y2, y3, t, 0), bez(y0, y1, y2, y3, t, 1)];
    nearest(prevX[0], prevX[1], nextX[0], nextX[1], unit(nextX[1] - prevX[1], -(nextX[0] - prevX[0])));
    nearest(prevY[0], prevY[1], nextY[0], nextY[1], unit(-(nextY[1] - prevY[1]), nextY[0] - prevY[0]));
    prevX = nextX; prevY = nextY;
  }
  const d = Math.sqrt(best);
  const inside = (wx - bestPoint[0]) * bestInward[0] + (wy - bestPoint[1]) * bestInward[1] >= 0;
  return done(inside ? -d : d, bestInward[0], bestInward[1]);
};
