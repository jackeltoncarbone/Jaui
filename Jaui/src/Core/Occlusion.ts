/**
 * OCCLUSION — an opaque fill that later opaque fills completely cover is not drawn.
 *
 * Its own module for the reason `Scene.Ledger` and `Pass.Timers` are: it is arithmetic with no GL
 * in it, so every claim below is a unit test rather than a screenshot.
 *
 * ── THE PIXEL ARGUMENT, AND WHERE IT IS EXACT ──────────────────────────────────────────────────
 *
 * A panel's fill alpha is `1 - smoothstep(-0.5, 0.5, dist)` (`Jiv.Panel.frag`), with `dist` the
 * shape's signed distance in DEVICE px. `smoothstep` is exactly 0 at its lower edge and exactly 1
 * at its upper, so:
 *
 *     alpha is EXACTLY 1  <=>  dist <= -0.5        alpha is EXACTLY 0  <=>  dist >= +0.5
 *
 * The clip stack multiplies by `1 - smoothstep(-0.5, 0.5, clipD)` and takes the same rule. So a
 * fragment whose colour is written with alpha exactly 1 destroys whatever the destination held,
 * and an earlier fill under it contributed nothing to the final image. That is the whole lever.
 *
 * `dist` is not a rect distance — it is a superellipse field — so the inset that guarantees
 * `dist <= -0.5` is derived rather than assumed. `ShapeSDF_inner` has a FLAT branch:
 *
 *     q = |p| - halfSize + rAxis;  if (q.x <= 0 && q.y <= 0)
 *         return -min(halfSize.x - |p.x|, halfSize.y - |p.y|);
 *
 * with `rAxis = rCorner = min(PickRectRadius(p, radii), minHalf)`. Inset a point by `s` from every
 * side with `s >= maxRadius` and both components of `q` are <= 0, so the flat branch runs and
 * `dist = -(distance to the nearest edge) <= -s`. Take `s = max(maxRadius, 0.5)` and the alpha is
 * exactly 1 — with NO dependence on the superellipse exponent, the smoothness, or the corner
 * blend. That is why the inset is `max(radius, 0.5)` and not something fitted.
 *
 * The one leg that escapes it is the PILL (`pillW > 0` mixes in `SS_PillSDF`, a capsule whose
 * interior is much smaller than the box). `CornerParams` reaches it only when the AUTHORED radius
 * exceeds `minHalf - max(0.12 * minHalf, 1)` — i.e. 88% of the short half-axis — so a coverer
 * whose radius is over HALF the short half-axis is refused outright by `PILL_GUARD_FRACTION` and
 * the pill leg is unreachable rather than approximated. Clip shapes cannot reach it at all: they
 * carry a bare smoothness, so `authoredR` decodes to 0 and `sat` is 0 for every clip.
 *
 * ── WHY THE ARITHMETIC IS IN PIXEL INDICES ─────────────────────────────────────────────────────
 *
 * A continuous rect union is the WRONG model and it costs the lever its whole win. Six bands
 * tiling a bed share exact edges; inset each interior by half a pixel and the union has a hairline
 * gap at every seam, so the page fill under them is refused. But alpha is sampled at PIXEL CENTRES
 * (half-integers), and a seam on an integer device coordinate puts every centre at |dist| >= 0.5 —
 * the two bands cover it between them, exactly. So everything here works in whole pixel indices:
 * pixel `i` spans `[i, i+1)` and is shaded at `i + 0.5`. A seam on an integer coordinate leaves no
 * gap; a seam on a fractional one leaves exactly the one row the shader really does blend across,
 * and that row is the residual the carve below pays for.
 *
 * ── SKIP, AND CARVE ────────────────────────────────────────────────────────────────────────────
 *
 * If the covered union takes the whole of P, P's instance is withheld: `Skip`. If it takes all but
 * a few thin pieces, and P's fill is a FLAT COLOUR with square corners, P is re-emitted as those
 * pieces: `Carve`. A flat colour is reproducible at any sub-rect (`resolveBgFill` returns `v_Tint`
 * without reading `panelLocal`), and a piece's NEW edges are whole device coordinates, so every
 * pixel centre sits >= 0.5 from them and the piece's alpha is exactly 1 where P's was — while a
 * piece edge that lands on P's OWN edge keeps P's own fractional feather, unchanged. The alpha at
 * any pixel depends only on the NEAREST edge, and a new edge is never the nearest one inside the
 * piece, which is the whole proof.
 */

import type { Mat2x3 } from '../Transform/Mat2x3';

/** A rectangle in whole DEVICE PIXEL INDICES, half-open: columns `[X0, X1)`, rows `[Y0, Y1)`. */
export interface PixelRect {
  X0: number;
  Y0: number;
  X1: number;
  Y1: number;
}

/** Half the shader's silhouette feather, in device px. `1 - smoothstep(-0.5, 0.5, dist)` is
 *  exactly 1 at `dist = -0.5` and exactly 0 at `+0.5`, so this number is the shader's, not a
 *  tolerance. */
export const OCCLUSION_AA_INSET = 0.5;

/** A coverer whose largest drawn radius exceeds this share of its SHORT half-axis is refused, so
 *  `CornerParams`'s pill leg (which needs an authored radius past 88% of it) is unreachable. */
export const PILL_GUARD_FRACTION = 0.5;

export const PixelRectArea = (r: PixelRect): number =>
  Math.max(0, r.X1 - r.X0) * Math.max(0, r.Y1 - r.Y0);

export const PixelRectEmpty = (r: PixelRect): boolean => r.X1 <= r.X0 || r.Y1 <= r.Y0;

export const IntersectPixelRect = (a: PixelRect, b: PixelRect): PixelRect => ({
  X0: Math.max(a.X0, b.X0),
  Y0: Math.max(a.Y0, b.Y0),
  X1: Math.min(a.X1, b.X1),
  Y1: Math.min(a.Y1, b.Y1),
});

/**
 * The pixels a rounded rect covers at alpha EXACTLY 1.
 *
 * `radius` is the largest DRAWN corner radius in device px. Rounding is outward-safe in both
 * directions — `ceil` on the low edge, `floor` on the high — so float dust can only ever shrink
 * the claimed cover.
 */
export const CoveredPixels = (
  x0: number, y0: number, x1: number, y1: number, radius: number,
): PixelRect => {
  const s = Math.max(radius, OCCLUSION_AA_INSET);
  return {
    X0: Math.ceil(x0 + s - 0.5),
    Y0: Math.ceil(y0 + s - 0.5),
    X1: Math.floor(x1 - s - 0.5) + 1,
    Y1: Math.floor(y1 - s - 0.5) + 1,
  };
};

/**
 * Every pixel a quad at this rect can rasterise — the bound on where a fill could have put ink.
 *
 * A pixel is shaded when its centre falls inside the quad, so `ceil(x0 - 0.5)` would be tight;
 * this takes one more pixel on each side, because a rect that claims too MUCH ink is refused a
 * skip it could have had, and one that claims too little skips a panel that was still showing.
 */
export const RasterPixels = (x0: number, y0: number, x1: number, y1: number): PixelRect => ({
  X0: Math.floor(x0 - 0.5),
  Y0: Math.floor(y0 - 0.5),
  X1: Math.ceil(x1 - 0.5) + 1,
  Y1: Math.ceil(y1 - 0.5) + 1,
});

/** `a \ b`, appended to `out` as up to four disjoint pieces. Exact: no bounding box anywhere. */
const SubtractInto = (a: PixelRect, b: PixelRect, out: PixelRect[]): void => {
  if (PixelRectEmpty(a)) return;
  const x0 = Math.max(a.X0, b.X0), x1 = Math.min(a.X1, b.X1);
  const y0 = Math.max(a.Y0, b.Y0), y1 = Math.min(a.Y1, b.Y1);
  if (x1 <= x0 || y1 <= y0) { out.push(a); return; }
  if (a.Y0 < y0) out.push({ X0: a.X0, Y0: a.Y0, X1: a.X1, Y1: y0 });
  if (y1 < a.Y1) out.push({ X0: a.X0, Y0: y1, X1: a.X1, Y1: a.Y1 });
  if (a.X0 < x0) out.push({ X0: a.X0, Y0: y0, X1: x0, Y1: y1 });
  if (x1 < a.X1) out.push({ X0: x1, Y0: y0, X1: a.X1, Y1: y1 });
};

/**
 * `target` minus the union of `covers`, as disjoint pieces. `null` when the piece list would pass
 * `maxPieces` — a refusal, never an approximation: the caller draws the panel whole.
 *
 * Pieces that share a column range and touch are merged, so a bed's bands leave one row per seam
 * rather than one row per seam per subtraction order.
 */
export const SubtractPixelRects = (
  target: PixelRect, covers: readonly PixelRect[], maxPieces: number,
): PixelRect[] | null => {
  let pieces: PixelRect[] = PixelRectEmpty(target) ? [] : [target];
  for (const c of covers) {
    if (pieces.length === 0) break;
    const next: PixelRect[] = [];
    for (const p of pieces) SubtractInto(p, c, next);
    if (next.length > maxPieces) return null;
    pieces = next;
  }
  return MergePixelRects(pieces);
};

/** Merge pieces that share a column range and touch vertically. Order-insensitive enough for the
 *  row/column tilings this lever exists for; anything it misses costs one extra instance. */
export const MergePixelRects = (pieces: readonly PixelRect[]): PixelRect[] => {
  const sorted = [...pieces].sort((a, b) => (a.X0 - b.X0) || (a.X1 - b.X1) || (a.Y0 - b.Y0));
  const out: PixelRect[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && last.X0 === p.X0 && last.X1 === p.X1 && last.Y1 === p.Y0) {
      out[out.length - 1] = { X0: last.X0, Y0: last.Y0, X1: last.X1, Y1: p.Y1 };
      continue;
    }
    out.push(p);
  }
  return out;
};

/**
 * The scale-and-translate that makes `JivInstanceBuffer.Push` lay a node's panel down at `piece`
 * instead of at its own box — the whole mechanism of a carve, in one matrix.
 *
 * `Push` takes half-extents from `matScale*(m) * Width * dpr` and the centre from the node's local
 * centre mapped through `m`, so a pure diagonal scale with a translate reproduces any axis-aligned
 * device rect while leaving `cos`/`sin` at the unrotated identity. Every other lane of the instance
 * — colour, radii, opacity, grade, clip, border mode — is read from the style and is untouched,
 * which is why a carved piece is the SAME panel and not a new one.
 *
 * `piece` is in device px. The caller has already clamped it to the node's own shape rect, so an
 * edge here is either a whole device coordinate or the node's own edge.
 */
export const CarvePieceTransform = (
  piece: { X0: number; Y0: number; X1: number; Y1: number },
  localX: number, localY: number, localW: number, localH: number, dpr: number,
): Mat2x3 => {
  const sx = (piece.X1 - piece.X0) / (localW * dpr);
  const sy = (piece.Y1 - piece.Y0) / (localH * dpr);
  const cLX = localX + localW * 0.5;
  const cLY = localY + localH * 0.5;
  return [
    sx, 0, 0, sy,
    (piece.X0 + piece.X1) * 0.5 / dpr - sx * cLX,
    (piece.Y0 + piece.Y1) * 0.5 / dpr - sy * cLY,
  ];
};

/** One fill the walk is about to emit, resolved to device pixels. `Order` is the walk's own visit
 *  index — strictly increasing, and the ONLY thing that says which of two fills is later. */
export interface OcclusionFill {
  Order: number;
  /** Pixels this fill can put ink in. Canvas-clamped by the caller. */
  Raster: PixelRect;
  /** Pixels this fill writes at alpha exactly 1, already intersected with its clip. Empty unless
   *  `Covers`. */
  Cover: PixelRect;
  /** Opaque, unrotated, unfiltered, no border, no shadow — may stand as a coverer. */
  Covers: boolean;
  /** Withholding this fill is invisible if something covers it — see `OcclusionFillAdmits`. */
  Skippable: boolean;
  /** Flat `Color` fill with square corners: reproducible at any sub-rect, so it may be carved. */
  Carvable: boolean;
}

export type OcclusionVerdict =
  | { Kind: 'Skip'; Px: number }
  | { Kind: 'Carve'; Px: number; Pieces: readonly PixelRect[] };

export interface OcclusionLimits {
  /** A fill smaller than this is neither a candidate nor a coverer. The win is in big fills, and
   *  the pair test below is quadratic in the candidate count. */
  MinAreaPx: number;
  /** Hard cap on the candidate list, so the pair test is bounded however big the tree is. */
  MaxCandidates: number;
  /** Most pieces a carve may emit. Each is one extra panel INSTANCE (not one extra draw). */
  MaxPieces: number;
  /** A carve must leave at most this share of the panel behind, or it is not worth the instances. */
  MaxResidualFraction: number;
}

export const DEFAULT_OCCLUSION_LIMITS: OcclusionLimits = {
  MinAreaPx: 0,
  MaxCandidates: 64,
  MaxPieces: 8,
  MaxResidualFraction: 0.25,
};

/**
 * THE PAIR TEST. For each skippable fill, subtract the covers of every LATER coverer that is still
 * ahead of the next scene READ, and rule on what is left.
 *
 * `sceneReads` is the ordered list of paint indices at which something samples the scene (a glass
 * fill, a progressive blur, a backdrop filter, a glass rim). A fill withheld before one of those
 * would change what it reads even though the final image is covered, so a coverer past the first
 * read after P is not allowed to count. That clause, not the geometry, is what makes this safe on
 * a page whose glass sits between the two.
 *
 * ── WHY EACH VERDICT IS INDEPENDENT OF THE OTHERS ─────────────────────────────────────────────
 *
 * Every candidate is ruled on against the covers of panels the plan may ALSO have withheld, which
 * looks circular and is not. If a coverer `C1` is itself skipped, it is because everything it
 * rasterised is taken by coverers LATER than it; and if `C1` counted for an earlier `P`, then no
 * scene read lies between `P` and `C1`, so `P`'s read limit and `C1`'s are the same index and
 * every coverer `C1` leaned on was available to `P` too. `C1.Cover` is a subset of `C1.Raster`, so
 * `P`'s cover survives `C1`'s removal intact. A CARVED `C1` is the same argument with its pieces
 * added back: a piece's new edges are whole device coordinates, so it writes alpha 1 at every
 * pixel centre it holds, and pieces plus the covered remainder are all of `C1.Raster`.
 */
export const PlanOcclusion = (
  fills: readonly OcclusionFill[],
  sceneReads: readonly number[],
  limits: OcclusionLimits = DEFAULT_OCCLUSION_LIMITS,
): Map<number, OcclusionVerdict> => {
  const out = new Map<number, OcclusionVerdict>();
  const covers: PixelRect[] = [];
  for (let i = 0; i < fills.length; i++) {
    const p = fills[i];
    if (!p.Skippable) continue;
    const area = PixelRectArea(p.Raster);
    if (area < limits.MinAreaPx) continue;
    let limit = Infinity;
    for (const r of sceneReads) { if (r > p.Order) { limit = r; break; } }
    covers.length = 0;
    for (let j = i + 1; j < fills.length; j++) {
      const c = fills[j];
      if (c.Order >= limit) break;
      if (!c.Covers) continue;
      const hit = IntersectPixelRect(c.Cover, p.Raster);
      if (!PixelRectEmpty(hit)) covers.push(hit);
    }
    if (covers.length === 0) continue;
    const residual = SubtractPixelRects(p.Raster, covers, limits.MaxPieces);
    if (residual === null) continue;
    if (residual.length === 0) { out.set(p.Order, { Kind: 'Skip', Px: area }); continue; }
    if (!p.Carvable) continue;
    let left = 0;
    for (const r of residual) left += PixelRectArea(r);
    if (left > area * limits.MaxResidualFraction) continue;
    const saved = area - left;
    if (saved < limits.MinAreaPx) continue;
    out.set(p.Order, { Kind: 'Carve', Px: saved, Pieces: residual });
  }
  return out;
};
