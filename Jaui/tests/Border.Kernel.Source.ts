/**
 * A CPU PORT OF `BlurPass`'s FOUR HOPS, and of the border's DIRECT gather, so the two can be run
 * against each other on real images instead of against a number somebody wrote down.
 *
 * Every expression below is the GLSL's, transcribed: the bilinear sample is GL ES 3.0 3.8.9's
 * (`x * w - 0.5`, CLAMP_TO_EDGE on the integer coordinate), `down` is `DOWN_FRAG` and `up` is
 * `UP_FRAG` tap for tap and in tap ORDER, and the destination-to-source mapping is `VERT`'s
 * `u_SrcRect.xy + a * u_SrcRect.zw` evaluated at the destination pixel CENTRE.
 *
 * What it does NOT model, named because the lane's pixel prediction rests on it: the pyramid
 * stores every level in RGB10_A2, so the GPU rounds to 10 bits FOUR times (levels 1 and 2 on the
 * way down, levels 1 and 0 on the way up) where this rounds not at all. That is the whole reason
 * the direct path and the pyramid can differ, and it is the direction in which the direct path is
 * the more accurate of the two.
 */

export type Plane = { data: Float64Array; w: number; h: number };

export const plane = (w: number, h: number): Plane => ({ data: new Float64Array(w * h), w, h });

/** GL bilinear on a CLAMP_TO_EDGE texture, `uv` normalized. */
export const sample = (p: Plane, u: number, v: number): number => {
  const x = u * p.w - 0.5, y = v * p.h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const cx = (i: number): number => Math.min(p.w - 1, Math.max(0, i));
  const cy = (j: number): number => Math.min(p.h - 1, Math.max(0, j));
  const g = (i: number, j: number): number => p.data[cy(j) * p.w + cx(i)];
  return g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy)
       + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy;
};

/** `DOWN_FRAG`: centre x4 plus the four half-pixel corners, over 8. Destination is half the
 *  source, and the source rect is the identity (the region IS the source here). */
export const down = (src: Plane, t: number): Plane => {
  const dst = plane(Math.max(1, Math.floor(src.w / 2)), Math.max(1, Math.floor(src.h / 2)));
  const hx = 0.5 / src.w * t, hy = 0.5 / src.h * t;
  for (let n = 0; n < dst.h; n++) {
    for (let m = 0; m < dst.w; m++) {
      const u = (m + 0.5) / dst.w, v = (n + 0.5) / dst.h;
      let s = sample(src, u, v) * 4.0;
      s += sample(src, u - hx, v - hy);
      s += sample(src, u + hx, v + hy);
      s += sample(src, u + hx, v - hy);
      s += sample(src, u - hx, v + hy);
      dst.data[n * dst.w + m] = s / 8.0;
    }
  }
  return dst;
};

/** `UP_FRAG`: the eight-tap tent, over 12. Destination size is the next level UP's, which the
 *  chain already fixed -- never `src * 2`, because `floor` halvings are not reversible. */
export const up = (src: Plane, dw: number, dh: number, t: number): Plane => {
  const dst = plane(dw, dh);
  const hx = 0.5 / src.w * t, hy = 0.5 / src.h * t;
  for (let n = 0; n < dh; n++) {
    for (let m = 0; m < dw; m++) {
      const u = (m + 0.5) / dw, v = (n + 0.5) / dh;
      let s = sample(src, u - hx * 2, v);
      s += sample(src, u - hx, v + hy) * 2;
      s += sample(src, u, v + hy * 2);
      s += sample(src, u + hx, v + hy) * 2;
      s += sample(src, u + hx * 2, v);
      s += sample(src, u + hx, v - hy) * 2;
      s += sample(src, u, v - hy * 2);
      s += sample(src, u - hx, v - hy) * 2;
      dst.data[n * dw + m] = s / 12.0;
    }
  }
  return dst;
};

/** `Blur` at `k = 1, depth = 2` over a region-sized source: the four hops, in order. */
export const chain = (src: Plane, t: number): { l1: Plane; l2: Plane; u1: Plane; l0: Plane } => {
  const l1 = down(src, t);
  const l2 = down(l1, t);
  const u1 = up(l2, l1.w, l1.h, t);
  const l0 = up(u1, src.w, src.h, t);
  return { l1, l2, u1, l0 };
};

// ── THE DIRECT GATHER, as `Jiv.Panel.frag`'s `sampleBackdropDirect` runs it ───────────────────

const clampi = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** One level-2 cell as an exact 4x4 box of the source, gathered as four bilinear taps at the
 *  quadrant corners -- the shader's four `textureLod` calls, with its level-2 index clamp. */
export const directL2 = (src: Plane, qx: number, qy: number): number => {
  const l2w = Math.floor(src.w / 4), l2h = Math.floor(src.h / 4);
  const cx = clampi(qx, 0, l2w - 1), cy = clampi(qy, 0, l2h - 1);
  const bx = cx * 4, by = cy * 4;
  let s = sample(src, (bx + 1) / src.w, (by + 1) / src.h);
  s += sample(src, (bx + 3) / src.w, (by + 1) / src.h);
  s += sample(src, (bx + 1) / src.w, (by + 3) / src.h);
  s += sample(src, (bx + 3) / src.w, (by + 3) / src.h);
  return s * 0.25;
};

/** What the direct gather reads, per axis, and what it therefore has to hold in its windows. */
export interface DirectWindows {
  M0x: number; M0y: number; Q0x: number; Q0y: number;
  /** Every level-1 window index the two UP hops actually touched, and every level-2 one. */
  L1Touched: Set<number>; L2Touched: Set<number>;
}

/** `sampleBackdropDirect` for ONE level-0 texel `(px, py)`, with the window indices it touched
 *  recorded so a test can assert they never leave the 3-wide and 4-wide windows the shader
 *  declares. Returns the value and the census. */
export const directGather = (
  src: Plane, px: number, py: number, t: number,
): { value: number; windows: DirectWindows } => {
  const h = 0.5 * t;
  const l1n = { x: Math.floor(src.w / 2), y: Math.floor(src.h / 2) };
  const x1x = (px + 0.5) * 0.5, x1y = (py + 0.5) * 0.5;
  const m0x = Math.floor(x1x - t - 0.5), m0y = Math.floor(x1y - t - 0.5);
  const x2x = (m0x + 0.5) * 0.5, x2y = (m0y + 0.5) * 0.5;
  const q0x = Math.floor(x2x - t - 0.5), q0y = Math.floor(x2y - t - 0.5);

  const L1Touched = new Set<number>();
  const L2Touched = new Set<number>();

  const l2: number[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) l2.push(directL2(src, q0x + i, q0y + j));

  const tapL2 = (ux: number, uy: number): number => {
    const cx = ux - 0.5, cy = uy - 0.5;
    const f0x = Math.floor(cx), f0y = Math.floor(cy);
    const frx = cx - f0x, fry = cy - f0y;
    const i0 = f0x - q0x, j0 = f0y - q0y;
    L2Touched.add(i0); L2Touched.add(i0 + 1);
    L2Touched.add(j0); L2Touched.add(j0 + 1);
    const a = l2[j0 * 4 + i0] * (1 - frx) + l2[j0 * 4 + i0 + 1] * frx;
    const b = l2[(j0 + 1) * 4 + i0] * (1 - frx) + l2[(j0 + 1) * 4 + i0 + 1] * frx;
    return a * (1 - fry) + b * fry;
  };

  const upTaps = (tap: (x: number, y: number) => number, x: number, y: number): number => {
    let s = tap(x - h * 2, y);
    s += tap(x - h, y + h) * 2;
    s += tap(x, y + h * 2);
    s += tap(x + h, y + h) * 2;
    s += tap(x + h * 2, y);
    s += tap(x + h, y - h) * 2;
    s += tap(x, y - h * 2);
    s += tap(x - h, y - h) * 2;
    return s / 12.0;
  };

  const l1: number[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const mx = clampi(m0x + i, 0, l1n.x - 1), my = clampi(m0y + j, 0, l1n.y - 1);
      l1.push(upTaps(tapL2, (mx + 0.5) * 0.5, (my + 0.5) * 0.5));
    }
  }

  const tapL1 = (ux: number, uy: number): number => {
    const cx = ux - 0.5, cy = uy - 0.5;
    const f0x = Math.floor(cx), f0y = Math.floor(cy);
    const frx = cx - f0x, fry = cy - f0y;
    const i0 = f0x - m0x, j0 = f0y - m0y;
    L1Touched.add(i0); L1Touched.add(i0 + 1);
    L1Touched.add(j0); L1Touched.add(j0 + 1);
    const a = l1[j0 * 3 + i0] * (1 - frx) + l1[j0 * 3 + i0 + 1] * frx;
    const b = l1[(j0 + 1) * 3 + i0] * (1 - frx) + l1[(j0 + 1) * 3 + i0 + 1] * frx;
    return a * (1 - fry) + b * fry;
  };

  const value = upTaps(tapL1, x1x, x1y);
  return { value, windows: { M0x: m0x, M0y: m0y, Q0x: q0x, Q0y: q0y, L1Touched, L2Touched } };
};
