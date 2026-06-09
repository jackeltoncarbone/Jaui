/**
 * A 2x3 affine transform, the render walk's local→canvas map. Replaces the old
 * scale+translate-only `(cx, cy, ox, oy)` tuple so ROTATION composes through the
 * tree (a parent's rotation cascades to its children, exactly like scale/translate
 * already did). Column-major `[a, b, c, d, e, f]` matching the canvas2d/CSS
 * `matrix(a,b,c,d,e,f)` convention:
 *
 *   canvasX = a*localX + c*localY + e
 *   canvasY = b*localX + d*localY + f
 *
 * The OLD tuple maps exactly: `(cx, cy, ox, oy) ≡ [cx, 0, 0, cy, ox, oy]` — so at
 * rotation 0 with no Visual* the matrix path reduces to the legacy scalar path and
 * non-rotated rendering is unchanged. Stored as a fixed-length readonly tuple (not
 * an object) to avoid per-frame allocation in the hot render walk.
 */
export type Mat2x3 = readonly [number, number, number, number, number, number];

/** Identity: maps local→canvas unchanged. */
export const MAT_IDENTITY: Mat2x3 = [1, 0, 0, 1, 0, 0];

/** Map a local point's X to canvas. */
export const matApplyX = (m: Mat2x3, x: number, y: number): number => m[0] * x + m[2] * y + m[4];
/** Map a local point's Y to canvas. */
export const matApplyY = (m: Mat2x3, x: number, y: number): number => m[1] * x + m[3] * y + m[5];

/** x-axis scale = |first column|. At a diagonal matrix this is the old `cx`. */
export const matScaleX = (m: Mat2x3): number => Math.hypot(m[0], m[1]);
/** y-axis scale = |second column|. At a diagonal matrix this is the old `cy`. */
export const matScaleY = (m: Mat2x3): number => Math.hypot(m[2], m[3]);

/** cosθ of the first column's rotation. 1 when unrotated (`s===0` guard → identity). */
export const matCos = (m: Mat2x3): number => { const s = Math.hypot(m[0], m[1]); return s === 0 ? 1 : m[0] / s; };
/** sinθ of the first column's rotation. 0 when unrotated. */
export const matSin = (m: Mat2x3): number => { const s = Math.hypot(m[0], m[1]); return s === 0 ? 0 : m[1] / s; };

/**
 * Compose: apply the local affine `L` first, then `M` (M ∘ L). Used to fold a
 * node's own rotation / scale / translate / scroll onto the inherited matrix.
 * `matMul(M, IDENTITY) === M` structurally.
 */
export const matMul = (m: Mat2x3, l: Mat2x3): Mat2x3 => {
  const [a, b, c, d, e, f] = m;
  const [la, lb, lc, ld, le, lf] = l;
  return [
    a * la + c * lb, b * la + d * lb,
    a * lc + c * ld, b * lc + d * ld,
    a * le + c * lf + e, b * le + d * lf + f,
  ];
};

/**
 * Invert the map and apply it to a canvas point → local point. Used by hit-testing
 * to bring the pointer into a (possibly rotated) node's local frame. Returns the
 * input unchanged-as-local if the matrix is singular (det≈0, a collapsed node).
 */
export const matInvApply = (m: Mat2x3, px: number, py: number): [number, number] => {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) return [px - e, py - f];
  const inv = 1 / det;
  const dx = px - e;
  const dy = py - f;
  return [(d * dx - c * dy) * inv, (-b * dx + a * dy) * inv];
};
