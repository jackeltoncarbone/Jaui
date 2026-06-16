/**
 * Jline geometry — turn a polyline into per-segment MITER-QUAD instance data for the stroke shader.
 *
 * Each segment becomes one instance (12 floats), consumed by `Renderer.StrokeAddInstance`:
 *   a_Seg   = (Ax, Ay, Bx, By)               — the true segment endpoints (the fragment's SDF distance)
 *   a_Miter = (miterA.xy, miterB.xy)          — the perpendicular offset vector at each end; the unit quad
 *                                               expands `endpoint ± miter`
 *   a_Arc   = (t0, t1, phase, 0)              — arc fraction at A / B, plus the per-line progress offset
 *
 * Miter vectors are computed PER PATH-VERTEX so a vertex shared by two segments gets the SAME offset in
 * both — the segment quads TILE exactly (no overlap → no alpha double-blend → no beading at joints), while
 * the per-fragment true-distance SDF keeps the edge smooth with no facets. Coordinates are in whatever px
 * space the caller renders in (Jaui device px, or the turf render-target px).
 */

export type StrokePoint = readonly [number, number];

/**
 * How the per-vertex arc parameter `t` (0..1, drives the shader's trail window + colour/blur tracks)
 * is assigned along the polyline:
 *  • `'arc'`   — cumulative-arc-length fraction. Use when the path is parameterized by distance (the
 *                window unit is metres). Default for the general primitive.
 *  • `'index'` — vertex-index fraction `i/(n-1)`. Use when points are sampled at uniform parameter
 *                steps (the comet: one point per beat → `t` is the TIME fraction, so the head at
 *                `t = progress` tracks the marcher even under non-uniform footwork speed).
 */
export type StrokeParam = 'arc' | 'index';

/** Floats per per-segment instance — must match the renderer's stroke instance layout. */
export const STROKE_FLOATS_PER_SEGMENT = 12;

/** Clamp on the miter-length denominator so a sharp turn can't produce an unbounded miter spike
 *  (≈ caps the extension at 1/0.3 ≈ 3.3× the half-extent; sharper turns bevel instead). */
const _MITER_MIN = 0.3;

export interface StrokeInstanceData {
  /** Interleaved instance floats — `SegmentCount * STROKE_FLOATS_PER_SEGMENT` of them are valid.
   *  May be longer than needed when a reused `out` buffer was passed. */
  Data: Float32Array;
  SegmentCount: number;
}

// ── Reusable per-line scratch (grown on demand) — keeps the hot path allocation-free across frames /
//    marchers. NOT re-entrant: WriteStrokeInstances is a synchronous, single-threaded fill. ──────────
let _dx = new Float64Array(0), _dy = new Float64Array(0);
let _nx = new Float64Array(0), _ny = new Float64Array(0);
let _cum = new Float64Array(0);
let _mx = new Float64Array(0), _my = new Float64Array(0);
const _ensureScratch = (n: number): void => {
  if (_cum.length >= n) return;
  const segCap = Math.max(n - 1, 1);
  _dx = new Float64Array(segCap); _dy = new Float64Array(segCap);
  _nx = new Float64Array(segCap); _ny = new Float64Array(segCap);
  _mx = new Float64Array(n); _my = new Float64Array(n);
  _cum = new Float64Array(n);
};

/**
 * Write one polyline's per-segment miter-quad instances DIRECTLY into `out` at `floatOffset` — no
 * allocation, no intermediate copy. The reality turf calls this once per marcher into a single reused
 * buffer (zero-copy: build straight into the array that gets `bufferData`'d to the GPU), then issues
 * one upload + one draw. Returns the new float offset (= where the next line should write).
 *
 * @throws RangeError if `out` can't hold this line's `(points-1) * stride` floats from `floatOffset`.
 *
 * `stride` (default {@link STROKE_FLOATS_PER_SEGMENT} = 12) is the per-segment float pitch in `out`. Pass a
 * LARGER stride when the consumer interleaves extra per-segment attributes after the 12 stroke floats (e.g.
 * the collision-fill buffer adds a 2-float `a_Fill` → stride 14); the 12 stroke floats are written into the
 * first 12 lanes of each `stride`-sized slot and the caller fills the remainder. Default keeps the comet's
 * tightly-packed 12-stride layout unchanged.
 */
export function WriteStrokeInstances(
  points: ReadonlyArray<StrokePoint>,
  halfExtent: number,
  phase: number,
  out: Float32Array,
  floatOffset = 0,
  param: StrokeParam = 'arc',
  pointCount?: number,
  stride: number = STROKE_FLOATS_PER_SEGMENT,
): number {
  // `pointCount` lets callers pass a reused, OVERSIZED scratch array and read only its first N entries
  // (zero per-frame allocation — the turf converts field→px into a persistent scratch each frame).
  const n = pointCount ?? points.length;
  if (n < 2) return floatOffset;
  const segCount = n - 1;
  const end = floatOffset + segCount * stride;
  if (end > out.length) throw new RangeError('Jline.WriteStrokeInstances: out buffer too small');

  _ensureScratch(n);
  _cum[0] = 0;
  for (let k = 0; k < segCount; k++) {
    const ax = points[k][0], ay = points[k][1], bx = points[k + 1][0], by = points[k + 1][1];
    let dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    _dx[k] = dx; _dy[k] = dy;
    _nx[k] = -dy; _ny[k] = dx;
    _cum[k + 1] = _cum[k] + len;
  }
  // `t` parameter per vertex: cumulative-arc fraction, or uniform index fraction (time/beat-sampled paths).
  const byIndex = param === 'index';
  const total = _cum[segCount] || 1;
  const tAt = (i: number): number => (byIndex ? i / segCount : _cum[i] / total);

  // Per path-vertex miter offset vector — shared between adjacent segments → exact tiling, no beading.
  for (let i = 0; i < n; i++) {
    let mx: number, my: number, scale = 1;
    if (i === 0) { mx = _nx[0]; my = _ny[0]; }
    else if (i === n - 1) { mx = _nx[segCount - 1]; my = _ny[segCount - 1]; }
    else {
      let ax = _nx[i - 1] + _nx[i], ay = _ny[i - 1] + _ny[i];
      const al = Math.hypot(ax, ay) || 1;
      ax /= al; ay /= al;
      scale = 1 / Math.max(_MITER_MIN, ax * _nx[i] + ay * _ny[i]);
      mx = ax; my = ay;
    }
    _mx[i] = mx * halfExtent * scale;
    _my[i] = my * halfExtent * scale;
  }

  let o = floatOffset;
  for (let k = 0; k < segCount; k++) {
    out[o + 0] = points[k][0];
    out[o + 1] = points[k][1];
    out[o + 2] = points[k + 1][0];
    out[o + 3] = points[k + 1][1];
    out[o + 4] = _mx[k];
    out[o + 5] = _my[k];
    out[o + 6] = _mx[k + 1];
    out[o + 7] = _my[k + 1];
    out[o + 8] = tAt(k);
    out[o + 9] = tAt(k + 1);
    out[o + 10] = phase;
    out[o + 11] = 0;
    o += stride;
  }
  return end;
}

/**
 * Convenience wrapper for a single polyline — allocates (or reuses `out`) and fills from offset 0.
 * Multi-line callers (the turf) should use {@link WriteStrokeInstances} to fill ONE shared buffer.
 *
 * @param halfExtent perpendicular half-width of each quad — must be ≥ the widest the stroke ever covers
 *                   (≈ max(headRadius, lineHalfWidth + maxBlur)); fragments past the SDF coverage discard
 * @param phase      per-line progress offset (0..1), packed into a_Arc.z for the shader's trail window
 * @param out        optional buffer to fill (reused across frames); a new one is allocated if too small
 */
export function BuildStrokeInstances(
  points: ReadonlyArray<StrokePoint>,
  halfExtent: number,
  phase = 0,
  out?: Float32Array,
  param: StrokeParam = 'arc',
): StrokeInstanceData {
  const n = points.length;
  if (n < 2) return { Data: out ?? new Float32Array(0), SegmentCount: 0 };
  const segCount = n - 1;
  const need = segCount * STROKE_FLOATS_PER_SEGMENT;
  const data = out && out.length >= need ? out : new Float32Array(need);
  WriteStrokeInstances(points, halfExtent, phase, data, 0, param);
  return { Data: data, SegmentCount: segCount };
}
