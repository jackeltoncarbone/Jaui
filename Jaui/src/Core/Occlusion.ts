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
 * `dist` is not a rect distance — it is the continuous corner's field (Jiv/Shaders/Corner.Continuous.glsl)
 * — so the inset that guarantees `dist <= -0.5` is derived rather than assumed. Its corner reaches
 * `CornerReach(r, s) = (1 + s) r` along each edge, and past that on both axes it returns the FLAT
 * branch, `-min(inward from the side, inward from the top)`. Inset a point by `max(reach, 0.5)` from
 * every side and the flat branch runs, so `dist = -(distance to the nearest edge) <= -0.5` and the
 * alpha is exactly 1, whatever the smoothing or the aspect. A shape shorter than twice its reach — a
 * capsule, a disc — has no such point on some axis, and claims no cover.
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

/** How far a continuous corner of radius `radius` and smoothing `smoothing` reaches along each edge from
 *  the corner (Jiv/Shaders/Corner.Continuous.glsl): its easing starts (1 + s) r out. Past it on both
 *  axes the shape's distance is the nearer straight edge's. */
export const CornerReach = (radius: number, smoothing: number): number =>
  (1 + Math.max(0, Math.min(1, smoothing))) * radius;

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
 * THE SAME SET, WITHOUT THROWING THE EDGES AWAY — a rounded rect's alpha-1 pixels as up to three
 * disjoint rows of rects, rather than as the one rect `CoveredPixels` insets by `radius` on every
 * side.
 *
 * ── WHY THIS EXISTS, and it is the whole of lane occlusion2 ───────────────────────────────────
 *
 * A rounded rect is NOT missing a `radius`-wide frame. It is missing four `radius x radius`
 * CORNER blocks, and `CoveredPixels`'s all-sides inset pays for all four of them on every edge.
 * At a small radius that is the "conservative by up to 0.7r a side" the first lane named and
 * priced. At the App's own screen clip — `Screen { BorderRadius: @JwiftScreenRadius }`, which is
 * 183 DEVICE px of drawn radius at dpr 2 under the corner of the time (the continuous corner's
 * reach is 166.4 px now) — it discards that frame of a 2560 x 1600 canvas:
 * over 1.5 Mpx of cover that is genuinely alpha 1, on EVERY coverer in the app, because that clip is
 * in every node's stack. That is what made the carve emit zero pieces on both machines.
 *
 * ── WHY THE TWO WING ROWS ARE ALPHA 1, WHICH THE FLAT BRANCH DOES NOT SAY ─────────────────────
 *
 * The continuous corner's flat branch runs wherever a point is past the corner's reach on BOTH axes;
 * the top and bottom wing rows are past it on x but not on y. There the nearest feature is the
 * straight top or bottom edge (the corner's features all lie within `reach` of the side on x), so
 * `dist = |p.y| - halfH`: a pixel centre at least 0.5 inside that edge and clear of both corner blocks
 * has alpha exactly 1. `Occlusion.Wired.test.ts` sweeps the claim against the corner field.
 *
 * `radius` is the LARGEST of the four drawn radii, so cutting that block from all four corners is
 * conservative whichever corner carries which radius — the field selects per quadrant and
 * the derivation above does not depend on which it picked.
 *
 * The three rects are disjoint and their union is exactly `CoveredPixels(..., 0.5)` minus the four
 * corner blocks. At `radius <= 0.5` the wings are empty and the mid row IS `CoveredPixels`, so
 * this is the identical set for every square coverer — the only nodes it changes are rounded ones.
 */
export const CoveredRegion = (
  x0: number, y0: number, x1: number, y1: number, radius: number,
): PixelRect[] => {
  const face = CoveredPixels(x0, y0, x1, y1, OCCLUSION_AA_INSET);
  const core = CoveredPixels(x0, y0, x1, y1, radius);
  // A rect shorter than twice its corner reach (a capsule, a disc) has corner blocks that would
  // OVERLAP, and then the three rows are not a partition of anything: it claims no cover.
  if (PixelRectEmpty(core) || PixelRectEmpty(face)) return [];
  const out: PixelRect[] = [{ X0: face.X0, Y0: core.Y0, X1: face.X1, Y1: core.Y1 }];
  if (core.Y0 > face.Y0) out.push({ X0: core.X0, Y0: face.Y0, X1: core.X1, Y1: core.Y0 });
  if (face.Y1 > core.Y1) out.push({ X0: core.X0, Y0: core.Y1, X1: core.X1, Y1: face.Y1 });
  return out.filter((r) => !PixelRectEmpty(r));
};

/** Most rects a coverer's region may carry. A clip stack intersects region against region, so the
 *  count is 3^(depth+1) in the worst case and has to be bounded; past this the caller falls back
 *  to the single all-sides-inset rect, which is a SUBSET of the region and therefore always safe. */
export const MAX_COVER_RECTS = 8;

/** `a ∩ b`, both unions of disjoint rects. `null` when the result would pass `MAX_COVER_RECTS`. */
export const IntersectRegions = (a: readonly PixelRect[], b: readonly PixelRect[]): PixelRect[] | null => {
  const out: PixelRect[] = [];
  for (const p of a) {
    for (const q of b) {
      const hit = IntersectPixelRect(p, q);
      if (PixelRectEmpty(hit)) continue;
      if (out.length === MAX_COVER_RECTS) return null;
      out.push(hit);
    }
  }
  return out;
};

export const RegionArea = (region: readonly PixelRect[]): number => {
  let a = 0;
  for (const r of region) a += PixelRectArea(r);
  return a;
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
  /** Pixels this fill writes at alpha exactly 1, already intersected with its clip — a union of
   *  disjoint rects, because a rounded rect is its face minus four CORNER blocks and flattening
   *  that to one rect is what killed the lever (`CoveredRegion`). Empty unless `Covers`. */
  Cover: readonly PixelRect[];
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
  /** Most pieces a carve may emit. Each is one extra panel INSTANCE (not one extra draw): they all
   *  land in the same instanced Color batch, so the cost of a piece is an instance's 60 floats and
   *  its own pixels — and the PIXELS are bounded by `MaxResidualFraction`, which is the guard that
   *  actually prices this. The cap is here to bound `SubtractPixelRects`'s intermediate list, not
   *  to price the carve; at 8 it refused every real page, because a rounded clip's four corners
   *  open two side columns per seam and the intermediate list runs ahead of the merged one. */
  MaxPieces: number;
  /** A carve must leave at most this share of the panel behind, or it is not worth the instances. */
  MaxResidualFraction: number;
}

export const DEFAULT_OCCLUSION_LIMITS: OcclusionLimits = {
  MinAreaPx: 0,
  MaxCandidates: 64,
  MaxPieces: 24,
  MaxResidualFraction: 0.25,
};

/**
 * Why each candidate that got no verdict got none. Every `continue` in the pair test increments
 * exactly one of these.
 *
 * THIS IS THE LANE'S OWN LESSON, made structural. The first fold's census reported `Refused ""`
 * on every frame while the plan withheld nothing, and two machines read that as "no admission
 * clause fired" — when in fact `SubtractPixelRects` was returning `null` on the piece cap and the
 * pair test was dropping the candidate without a word. A refusal nobody can name is a refusal
 * nobody can measure.
 */
export interface OcclusionNotes {
  /** Skippable, but no later coverer touched it at all. */
  NoCover: number;
  /** The subtraction's intermediate list passed `MaxPieces`. */
  Capped: number;
  /** Uncovered, and not a flat square Color fill, so it cannot be carved. */
  NotCarvable: number;
  /** Carvable, but the residual is over `MaxResidualFraction` — not worth the instances. */
  TooMuchLeft: number;
  /** Carvable and cheap, but the saving is under `MinAreaPx`. */
  TooSmall: number;
}

export const NewOcclusionNotes = (): OcclusionNotes =>
  ({ NoCover: 0, Capped: 0, NotCarvable: 0, TooMuchLeft: 0, TooSmall: 0 });

/** The notes, as a gate-line fragment. Empty when nothing was refused. */
export const OcclusionNotesLine = (n: OcclusionNotes): string =>
  (Object.entries(n) as [string, number][])
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k.toLowerCase()}=${v}`)
    .join(' ');

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
  notes: OcclusionNotes = NewOcclusionNotes(),
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
      for (const part of c.Cover) {
        const hit = IntersectPixelRect(part, p.Raster);
        if (!PixelRectEmpty(hit)) covers.push(hit);
      }
    }
    if (covers.length === 0) { notes.NoCover++; continue; }
    const residual = SubtractPixelRects(p.Raster, covers, limits.MaxPieces);
    if (residual === null) { notes.Capped++; continue; }
    if (residual.length === 0) { out.set(p.Order, { Kind: 'Skip', Px: area }); continue; }
    if (!p.Carvable) { notes.NotCarvable++; continue; }
    let left = 0;
    for (const r of residual) left += PixelRectArea(r);
    if (left > area * limits.MaxResidualFraction) { notes.TooMuchLeft++; continue; }
    const saved = area - left;
    if (saved < limits.MinAreaPx) { notes.TooSmall++; continue; }
    out.set(p.Order, { Kind: 'Carve', Px: saved, Pieces: residual });
  }
  return out;
};
