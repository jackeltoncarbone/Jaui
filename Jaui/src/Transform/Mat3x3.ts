import type { Mat2x3 } from './Mat2x3';

/**
 * A 3x3 projective transform (homography) — the render walk's local→canvas map
 * once perspective enters. Every Jiv is a FLAT quad, so a quad under
 * `rotateX`/`rotateY`/`translateZ` + a `perspective` divide projects to a 2D
 * homography; this generalizes `Mat2x3` (the affine subset is the bottom row
 * `[0,0,1]`) so compose / invert / clip / hit-test all keep working in 3D.
 *
 * Row-major `[m00,m01,m02, m10,m11,m12, m20,m21,m22]`, applied to `[x, y, 1]`:
 *
 *   Xh = m00*x + m01*y + m02
 *   Yh = m10*x + m11*y + m12
 *   Wh = m20*x + m21*y + m22
 *   canvas = (Xh/Wh, Yh/Wh)        ← the perspective divide
 *
 * An affine `Mat2x3` maps in exactly (`mat3FromAffine`), and at no perspective
 * (Wh ≡ 1) every op reduces to the affine path — so non-3D rendering is
 * unchanged. Stored as a fixed-length readonly tuple to avoid per-frame churn.
 */
export type Mat3x3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

/** Identity: maps local→canvas unchanged. */
export const MAT3_IDENTITY: Mat3x3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Lift a 2x3 affine into a homography. `Mat2x3` is `[a,b,c,d,e,f]` with
 * `canvasX = a*x + c*y + e`, `canvasY = b*x + d*y + f` — so the rows are
 * `[a,c,e]`, `[b,d,f]`, `[0,0,1]`.
 */
export const mat3FromAffine = (m: Mat2x3): Mat3x3 => {
  const [a, b, c, d, e, f] = m;
  return [a, c, e, b, d, f, 0, 0, 1];
};

/** Compose: `M ∘ L` — apply L first, then M (same convention as `matMul`). */
export const mat3Mul = (m: Mat3x3, l: Mat3x3): Mat3x3 => {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = m;
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8] = l;
  return [
    a0 * b0 + a1 * b3 + a2 * b6, a0 * b1 + a1 * b4 + a2 * b7, a0 * b2 + a1 * b5 + a2 * b8,
    a3 * b0 + a4 * b3 + a5 * b6, a3 * b1 + a4 * b4 + a5 * b7, a3 * b2 + a4 * b5 + a5 * b8,
    a6 * b0 + a7 * b3 + a8 * b6, a6 * b1 + a7 * b4 + a8 * b7, a6 * b2 + a7 * b5 + a8 * b8,
  ];
};

/** Map a local point to canvas, with the perspective divide. Falls back to the
 *  un-divided point if `Wh` collapses (element edge-on / behind the camera). */
export const mat3ApplyPoint = (m: Mat3x3, x: number, y: number): [number, number] => {
  const xh = m[0] * x + m[1] * y + m[2];
  const yh = m[3] * x + m[4] * y + m[5];
  const wh = m[6] * x + m[7] * y + m[8];
  if (Math.abs(wh) < 1e-9) return [xh, yh];
  const iw = 1 / wh;
  return [xh * iw, yh * iw];
};

/** Inverse homography (adjugate / det). Returns identity if singular. */
export const mat3Inverse = (m: Mat3x3): Mat3x3 => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return MAT3_IDENTITY;
  const id = 1 / det;
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ];
};

/** Bring a canvas point into a (possibly perspective) node's local frame —
 *  used by hit-testing. Exact under perspective (3x3 inverse + divide). */
export const mat3InvApplyPoint = (m: Mat3x3, px: number, py: number): [number, number] =>
  mat3ApplyPoint(mat3Inverse(m), px, py);

/** Project a node's four box corners to canvas (for scissor / AABB). Order:
 *  TL, TR, BR, BL. */
export const mat3ProjectCorners = (
  m: Mat3x3, x: number, y: number, w: number, h: number,
): [[number, number], [number, number], [number, number], [number, number]] => [
  mat3ApplyPoint(m, x, y),
  mat3ApplyPoint(m, x + w, y),
  mat3ApplyPoint(m, x + w, y + h),
  mat3ApplyPoint(m, x, y + h),
];

/** True when the map is a pure affine (no perspective divide) — lets callers
 *  keep the cheaper `Mat2x3` path. */
export const mat3IsAffine = (m: Mat3x3): boolean =>
  m[6] === 0 && m[7] === 0 && m[8] === 1;

export interface Project3DParams {
  /** Pitch about the horizontal axis, degrees (Transform.RotateX). */
  RotateXDeg: number;
  /** Yaw about the vertical axis, degrees (Transform.RotateY). */
  RotateYDeg: number;
  /** Depth along Z before rotation, px (Transform.TranslateZ). */
  TranslateZ: number;
  /** Rotation pivot in the shared frame (the element's transform origin). */
  PivotX: number;
  PivotY: number;
  /** Viewing distance, px. `<= 0` ⇒ orthographic (no divide). */
  Perspective: number;
  /** Vanishing point in the shared frame (the perspective ancestor's origin). */
  OriginX: number;
  OriginY: number;
}

/**
 * Build the homography for a flat quad's 3D transform (translateZ → rotateX →
 * rotateY about `Pivot`) viewed under a perspective whose vanishing point is
 * `Origin`, all in ONE shared 2D frame (the perspective ancestor's space). The
 * caller sandwiches this between the element's natural→frame affine and the
 * frame→canvas affine.
 *
 * Each of `Xh`, `Yh`, `Wh` is affine in `(x, y)` (the 3D lift is linear in the
 * in-plane offset and the divide is the homogeneous W), so we recover the 9
 * coefficients exactly by sampling the pre-divide map at three points.
 */
export const mat3Project3D = (p: Project3DParams): Mat3x3 => {
  const th = (p.RotateXDeg * Math.PI) / 180;
  const ph = (p.RotateYDeg * Math.PI) / 180;
  const cth = Math.cos(th), sth = Math.sin(th);
  const cph = Math.cos(ph), sph = Math.sin(ph);
  const d = p.Perspective;
  const persp = d > 0;

  // Pre-divide map: frame point (x, y) → homogeneous (Xh, Yh, Wh).
  const pre = (x: number, y: number): [number, number, number] => {
    const u = x - p.PivotX;
    const v = y - p.PivotY;
    // translateZ → rotateX → rotateY about the pivot.
    const x0 = u, y0 = v, z0 = p.TranslateZ;
    const y1 = y0 * cth - z0 * sth;
    const z1 = y0 * sth + z0 * cth;
    const x2 = x0 * cph + z1 * sph;
    const z2 = -x0 * sph + z1 * cph;
    const y2 = y1;
    const rx = (p.PivotX + x2) - p.OriginX;
    const ry = (p.PivotY + y2) - p.OriginY;
    if (!persp) return [p.OriginX + rx, p.OriginY + ry, 1];
    const w = (d - z2) / d;          // 1/w = d/(d - z2) = magnification
    return [p.OriginX * w + rx, p.OriginY * w + ry, w];
  };

  const [x00, y00, w00] = pre(0, 0);
  const [x10, y10, w10] = pre(1, 0);
  const [x01, y01, w01] = pre(0, 1);
  return [
    x10 - x00, x01 - x00, x00,
    y10 - y00, y01 - y00, y00,
    w10 - w00, w01 - w00, w00,
  ];
};
