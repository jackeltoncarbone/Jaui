/**
 * `SS_PillSDF` vs `SS_PillEval`'s distance — the proof obligation lane `flatprogram2` was handed.
 *
 * ── WHY IT WAS ASKED ────────────────────────────────────────────────────────────────────────────
 * `NO_SHAPE_GRADIENT` replaces the main fragment's `ShapeEval` (→ `CornerEval`) with `CornerDist`.
 * On the superellipse leg those two return the same expression from the same function. On the PILL
 * leg they call different functions: `CornerDist` → `SS_PillSDF` (a scan that keeps only the
 * minimum), `CornerEval` → `SS_PillEval` (the same scan, also tracking the closest point for the
 * gradient). `tests/Pill.SDF.MergedLoop.test.ts` proves the MERGE was safe; it never compares
 * these two functions to each other.
 *
 * ── WHAT THIS FILE SETTLES, AND WHAT IT CANNOT ──────────────────────────────────────────────────
 * The only textual difference inside the loop is how the running minimum is kept:
 *
 *     SS_PillSDF   minDSq = min(minDSq, dot(d, d));
 *     SS_PillEval  if (dSq < minDSq) { minDSq = dSq; bestClosest = closest; }
 *
 * GLSL ES 3.00 defines `min(x, y)` as `y < x ? y : x`, which is the same selection, in the same
 * direction, on the same pair. Everything upstream of it — `a`, `b`, `ab`, `ap`, `t`, `closest`,
 * `d`, `dot(d, d)` — is written once, identically, in both. So the two distances can only differ
 * if the SELECTION differs, and that is a question about control flow, not about precision: a port
 * at any precision computes the same `dSq` in both arms and therefore answers it exactly. That is
 * what these ~890k comparisons are for, and they are done with `Object.is`, not a tolerance, so a
 * -0 / +0 split would fail them too.
 *
 * It does NOT settle the lane's real question, which is whether a GPU compiler emits the same
 * arithmetic for those shared lines in two functions with different register pressure — one of
 * them carries `bestClosest` live across all 32 iterations. `closest = a + t * ab` is exactly the
 * shape a Metal backend contracts into an FMA, contraction is a per-site decision no GLSL ES 3.00
 * qualifier can forbid (`precise` arrives in ES 3.20), and a contraction that fires on one side
 * and not the other moves the last ULP of `dist`. A CPU port cannot see that, so the lane does NOT
 * admit the pill leg: `_batchTakesBorderlessProgram` requires `pillW === 0` per instance, and the
 * borderless program only ever evaluates the superellipse leg. See `Perf/Borderless.Finding.md`.
 */

import { describe, it, expect } from 'vitest';
import { readGlslCurve } from './Pill.Curve.Source';

const _curve = readGlslCurve();
const SS_PILL_CURVE: Array<[number, number]> = _curve.points;
const SS_PILL_MAXEXTENT = _curve.maxExtent;

type Vec2 = [number, number];

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Both loops, sharing every line they share in the shader, differing only where the shader
 * differs. `round` is applied after each arithmetic step so the same body can be run in float64
 * (identity) or float32 (`Math.fround`) — the shader is `precision highp float`, and the point of
 * running both is that the selection question has the same answer at either width.
 */
type Round = (x: number) => number;

interface Scan { distMin: number; distBranch: number; minDSqMin: number; minDSqBranch: number }

const scan = (p: Vec2, halfSize: Vec2, r: Round): Scan => {
  const horiz = halfSize[0] >= halfSize[1];
  const qx = horiz ? Math.abs(p[0]) : Math.abs(p[1]);
  const qy = horiz ? Math.abs(p[1]) : Math.abs(p[0]);
  const halfX = horiz ? halfSize[0] : halfSize[1];
  const halfY = horiz ? halfSize[1] : halfSize[0];
  const maxExtent = r(SS_PILL_MAXEXTENT * halfY);
  const flatStart = r(halfX - maxExtent);

  // The flat-zone early return. `SS_PillSDF` writes `return q.y - halfY;`, `SS_PillEval` writes
  // `distOut = q.y - halfY;` then returns — the same expression, and it is in this file's grid.
  if (qx <= flatStart) {
    const d = r(qy - halfY);
    return { distMin: d, distBranch: d, minDSqMin: 0, minDSqBranch: 0 };
  }

  const qLx = r(qx - flatStart);
  const qLy = qy;

  let minDSqMin = 1e9;      // SS_PillSDF:   minDSq = min(minDSq, dot(d, d))
  let minDSqBranch = 1e9;   // SS_PillEval:  if (dSq < minDSq) { minDSq = dSq; ... }
  let u_b = -1;
  let bracketFound = false;

  for (let i = 0; i < SS_PILL_CURVE.length - 1; i++) {
    const ax = r(SS_PILL_CURVE[i][0] * maxExtent), ay = r(SS_PILL_CURVE[i][1] * halfY);
    const bx = r(SS_PILL_CURVE[i + 1][0] * maxExtent), by = r(SS_PILL_CURVE[i + 1][1] * halfY);
    const abx = r(bx - ax), aby = r(by - ay);
    const apx = r(qLx - ax), apy = r(qLy - ay);
    const t = clamp(r(r(r(apx * abx) + r(apy * aby)) / r(r(abx * abx) + r(aby * aby))), 0, 1);
    const cx = r(ax + r(t * abx)), cy = r(ay + r(t * aby));
    const dx = r(qLx - cx), dy = r(qLy - cy);
    const dSq = r(r(dx * dx) + r(dy * dy));

    // GLSL `min(x, y)` is specified as `y < x ? y : x`.
    minDSqMin = dSq < minDSqMin ? dSq : minDSqMin;
    if (dSq < minDSqBranch) minDSqBranch = dSq;

    if (!bracketFound && qLy <= ay && qLy >= by) {
      const dv = r(ay - by);
      const tb = dv > 0.0001 ? r(r(ay - qLy) / dv) : 0;
      u_b = r(mix(ax, bx, tb));
      bracketFound = true;
    }
  }

  const inside = qLy <= halfY && u_b > 0 && qLx <= u_b;
  const uMin = r(Math.sqrt(minDSqMin));
  const uBranch = r(Math.sqrt(minDSqBranch));
  return {
    distMin: inside ? -uMin : uMin,
    distBranch: inside ? -uBranch : uBranch,
    minDSqMin, minDSqBranch,
  };
};

const IDENTITY: Round = (x) => x;
const F32: Round = Math.fround;

const grid = (sizes: ReadonlyArray<Vec2>, r: Round): { samples: number; mismatches: number } => {
  let samples = 0;
  let mismatches = 0;
  for (const [W, H] of sizes) {
    const halfW = W / 2, halfH = H / 2;
    const step = Math.max(1, Math.floor(Math.min(W, H) / 60));
    for (let y = -halfH - 10; y <= halfH + 10; y += step) {
      for (let x = -halfW - 10; x <= halfW + 10; x += step) {
        const s = scan([x, y], [halfW, halfH], r);
        // Object.is, not ===: it separates -0 from +0, which is the one difference an
        // order-of-selection change could plausibly produce.
        if (!Object.is(s.distMin, s.distBranch)) mismatches++;
        if (!Object.is(s.minDSqMin, s.minDSqBranch)) mismatches++;
        samples++;
      }
    }
  }
  return { samples, mismatches };
};

const HORIZONTAL: ReadonlyArray<Vec2> = [[440, 60], [240, 40], [600, 80], [120, 30], [800, 100]];
const VERTICAL: ReadonlyArray<Vec2> = [[60, 440], [40, 240], [80, 600], [30, 120], [100, 800]];

describe('CornerDist vs CornerEval on the pill leg: the distance is the SAME float', () => {
  it('horizontal pills, float64 — both zones, ~222k points x 2 comparisons', () => {
    const { samples, mismatches } = grid(HORIZONTAL, IDENTITY);
    expect(samples).toBeGreaterThan(200_000);
    expect(mismatches).toBe(0);
  });

  it('vertical pills, float64 — the `horiz` swap is on the other branch', () => {
    const { mismatches, samples } = grid(VERTICAL, IDENTITY);
    expect(samples).toBeGreaterThan(200_000);
    expect(mismatches).toBe(0);
  });

  it('the same grids at float32, the width the shader actually runs at', () => {
    expect(grid(HORIZONTAL, F32).mismatches).toBe(0);
    expect(grid(VERTICAL, F32).mismatches).toBe(0);
  });

  it('the flat-zone early return, explicitly — the one path that never enters the loop', () => {
    // `q.x <= flatStart`: the straight-edge column, where both functions return `q.y - halfY`
    // without scanning. Walk the whole flat column of a long pill.
    const halfW = 400, halfH = 30;
    const flatStart = halfW - SS_PILL_MAXEXTENT * halfH;
    let taken = 0;
    for (let x = -flatStart; x <= flatStart; x += 0.5) {
      for (let y = -halfH - 5; y <= halfH + 5; y += 0.25) {
        const s = scan([x, y], [halfW, halfH], IDENTITY);
        expect(Object.is(s.distMin, s.distBranch)).toBe(true);
        taken++;
      }
    }
    // Non-vacuity: the early return really is the path being walked.
    expect(taken).toBeGreaterThan(100_000);
    // ~200k scans with two `expect`s each: ~3 s alone and 4.8 s inside the parallel suite at Jaui
    // d97b405, against the 5 s default - it failed one whole-suite run in two there. The work is
    // the point of the case, so the budget is stated rather than the grid thinned.
  }, 20_000);

  it('polyline vertices ±0.001 px — where the winning segment changes', () => {
    const halfX = 220, halfY = 30;
    const maxExtent = SS_PILL_MAXEXTENT * halfY;
    const flatStart = halfX - maxExtent;
    let checked = 0;
    for (const [u, v] of SS_PILL_CURVE) {
      for (const dx of [-0.001, 0, 0.001]) {
        for (const dy of [-0.001, 0, 0.001]) {
          const s = scan([flatStart + u * maxExtent + dx, v * halfY + dy], [halfX, halfY], IDENTITY);
          expect(Object.is(s.distMin, s.distBranch)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBe(SS_PILL_CURVE.length * 9);
  });

  it('a TIE keeps the incumbent in both forms, so the bracket order cannot diverge', () => {
    // The only way `min(a, b)` and `b < a ? b : a` could part company is on a pair they order
    // differently — which is NaN or ±0. `min(x, NaN)`: `NaN < x` is false, so x survives; the
    // branch form skips for the same reason. `min(-0, +0)`: they compare equal, so `<` is false
    // and BOTH forms keep the incumbent. Asserted directly rather than hoped for.
    const minGlsl = (x: number, y: number): number => (y < x ? y : x);
    const minBranch = (x: number, y: number): number => { let m = x; if (y < m) m = y; return m; };
    const pairs: Array<[number, number]> = [
      [0, -0], [-0, 0], [0, 0], [-0, -0],
      [1, NaN], [NaN, 1], [NaN, NaN],
      [1e9, 1e9], [1, 1], [Infinity, 1], [1, Infinity],
    ];
    for (const [x, y] of pairs) {
      expect(Object.is(minGlsl(x, y), minBranch(x, y)), `min(${x}, ${y})`).toBe(true);
    }
  });

  it('a degenerate segment NaNs both forms identically, and `minDSq` is never -0', () => {
    // `dot(ab, ab) === 0` would make `t = clamp(0/0, 0, 1)` a NaN, and GLSL's `clamp` (min of a
    // max) propagates it. Force it: a zero-height pill collapses every segment to (0, 0).
    const s = scan([5, 0], [10, 0], IDENTITY);
    expect(Object.is(s.distMin, s.distBranch)).toBe(true);
    expect(Object.is(s.minDSqMin, s.minDSqBranch)).toBe(true);
    // `dSq = dx*dx + dy*dy` is a sum of squares, so it is never -0 and `sqrt(minDSq)` has no
    // signed-zero question to answer. `(-0)*(-0)` is +0 and `(+0)+(+0)` is +0.
    expect(Object.is((-0) * (-0) + (-0) * (-0), 0)).toBe(true);
  });
});

describe('the shader source these two ports are read off', () => {
  it('still keeps the minimum the two ways this file compares', async () => {
    // A rewrite of either loop invalidates every number above. Pin both lines to the source.
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const frag = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'Jiv', 'Shaders', 'Jiv.Panel.frag'),
      'utf8',
    );
    expect(frag).toContain('minDSq = min(minDSq, dot(d, d));');
    expect(frag).toContain('if (dSq < minDSq) {');
    expect(frag).toContain('float t = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);');
  });
});
