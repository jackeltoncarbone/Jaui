/**
 * THE CONTINUOUS CORNER ON THE CPU: `Shaders/Corner.Continuous.glsl`'s `ContinuousCorner`, the same
 * construction and the same steps in doubles, for what has to reason about a shape's pixels without a
 * GPU (the `?glass-skip` census, the tests). The shader is the truth; Apple's construction is in
 * `Jwift/Apple/LiquidGlass.md` 10.
 */

const CORNER_EASE_STEPS = 12;
const LEAD_BASE = [1.0, 0.96, 0.82];
const LEAD_ROOM = [0.528665, 0.12849003, 0.048407];
const MID: [number, number][] = [[0.631493986, 0.0749114007], [0.372824013, 0.169060007], [0.169060007, 0.372824013], [0.0749114007, 0.631493986]];

const unit = (x: number, y: number): [number, number] => {
  const l = Math.sqrt(Math.max(x * x + y * y, 1e-18));
  return [x / l, y / l];
};

/** One edge's room for the continuous lead-in: 0 at a capsule, 1 with the full 1.528665 r. */
const room = (side: number, rSum: number): number =>
  rSum > 1e-3 ? Math.min(Math.max((side - rSum) / (rSum * 0.52866), 0), 1) : 1;

/** The corner curve as a style: 0 is Apple's circular corner, 1 its continuous corner, and between the two fields
 *  blend. Signed distance (negative inside) from (px, py), taken from the shape's centre, to the box of half size
 *  (halfW, halfH) and per-corner radii (tl, tr, br, bl). With `out`, writes [distance, outward x, outward y]. */
export const ContinuousCorner = (
  px: number, py: number, halfW: number, halfH: number,
  radii: readonly number[], smoothing: number, out?: Float64Array,
): number => {
  const s = Math.min(Math.max(smoothing, 0), 1);
  if (s >= 1) return appleCorner(px, py, halfW, halfH, radii, false, out);
  if (s <= 0) return appleCorner(px, py, halfW, halfH, radii, true, out);
  const a = new Float64Array(3), b = new Float64Array(3);
  const dc = appleCorner(px, py, halfW, halfH, radii, true, a);
  const dk = appleCorner(px, py, halfW, halfH, radii, false, b);
  const d = dc + (dk - dc) * s;
  if (out !== undefined) {
    const [ux, uy] = unit(a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s);
    out[0] = d; out[1] = ux; out[2] = uy;
  }
  return d;
};

const appleCorner = (
  px: number, py: number, halfW: number, halfH: number,
  radii: readonly number[], circular: boolean, out?: Float64Array,
): number => {
  const facingX = px < 0 ? -1 : 1, facingY = py < 0 ? -1 : 1;
  const done = (d: number, nx: number, ny: number): number => {
    if (out !== undefined) { out[0] = d; out[1] = nx * facingX; out[2] = ny * facingY; }
    return d;
  };
  const cap = Math.min(halfW, halfH);
  const rad = radii.map((v) => Math.min(Math.max(v, 0), cap));
  const qx = Math.abs(px), qy = Math.abs(py);
  const r = px >= 0 ? (py <= 0 ? rad[1] : rad[2]) : (py <= 0 ? rad[0] : rad[3]);
  const rAcross = px >= 0 ? (py <= 0 ? rad[0] : rad[3]) : (py <= 0 ? rad[1] : rad[2]);
  const rDown = px >= 0 ? (py <= 0 ? rad[2] : rad[1]) : (py <= 0 ? rad[3] : rad[0]);
  const wx = halfW - qx, wy = halfH - qy;
  if (r < 1e-3 || circular) {
    const vx = r - wx, vy = r - wy;
    const ox = Math.max(vx, 0), oy = Math.max(vy, 0);
    const d = Math.hypot(ox, oy) + Math.min(Math.max(vx, vy), 0) - r;
    if (ox + oy > 0) { const [ux, uy] = unit(ox, oy); return done(d, ux, uy); }
    return done(d, wx < wy ? 1 : 0, wx < wy ? 0 : 1);
  }
  const tTop = room(2 * halfW, r + rAcross), tSide = room(2 * halfH, r + rDown);
  const top = LEAD_BASE.map((b, i) => b + LEAD_ROOM[i] * tTop);
  const side = LEAD_BASE.map((b, i) => b + LEAD_ROOM[i] * tSide);
  const ex = top[0] * r, ey = side[0] * r;
  if (wx >= ex && wy >= ey) return done(-Math.min(wx, wy), wx < wy ? 1 : 0, wx < wy ? 0 : 1);

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
  const cubic = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]): void => {
    let prev = a;
    for (let i = 1; i <= CORNER_EASE_STEPS; i++) {
      const t = i / CORNER_EASE_STEPS, u = 1 - t;
      const next: [number, number] = [
        u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
        u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]];
      nearest(prev[0], prev[1], next[0], next[1], unit(next[1] - prev[1], -(next[0] - prev[0])));
      prev = next;
    }
  };
  nearest(ex, 0, ex + 1e5, 0, [0, 1]);
  nearest(0, ey, 0, ey + 1e5, [1, 0]);
  const m = MID.map(([x, y]) => [x * r, y * r] as [number, number]);
  cubic([ex, 0], [top[1] * r, 0], [top[2] * r, 0], m[0]);
  cubic(m[0], m[1], m[2], m[3]);
  cubic(m[3], [0, side[2] * r], [0, side[1] * r], [0, ey]);
  const d = Math.sqrt(best);
  const inside = (wx - bestPoint[0]) * bestInward[0] + (wy - bestPoint[1]) * bestInward[1] >= 0;
  return done(inside ? -d : d, bestInward[0], bestInward[1]);
};
