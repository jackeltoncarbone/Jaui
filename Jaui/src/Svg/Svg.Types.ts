/**
 * Shared data model for Jaui's native vector SVG renderer.
 *
 * The pipeline is: parse (DOM/string -> Nodes) -> flatten (curves -> polylines,
 * transforms baked) -> tessellate (fills -> triangles + AA skirt) / stroke geometry
 * (strokes -> miter quads) -> SvgVectorPaint (cached geometry + raw paint slots).
 * Colors stay as RAW strings here so they resolve through the JSS var system (and
 * animate via springs) at paint time — never pre-resolved at parse time.
 */

/** A 2x3 affine transform [a, b, c, d, e, f] mapping (x,y) -> (a*x+c*y+e, b*x+d*y+f). */
export type SvgMatrix = readonly [number, number, number, number, number, number];

export const SVG_IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0];

export type SvgFillRule = 'nonzero' | 'evenodd';

/** A flattened contour — a run of absolute [x, y] points in viewBox user units. */
export interface SvgContour {
  /** Flat x,y pairs (length is even). */
  Points: number[];
  /** True if the subpath was explicitly closed (Z) — fills always treat contours as closed. */
  Closed: boolean;
}

/** A filled and/or stroked shape: one or more contours sharing a paint. */
export interface SvgPathNode {
  Kind: 'path';
  Contours: SvgContour[];
  /** Raw fill color string (e.g. "@Accent", "#rrggbbaa", "rgba(...)") or null for fill="none". */
  FillRaw: string | null;
  FillRule: SvgFillRule;
  /** Raw stroke color string or null for no stroke. */
  StrokeRaw: string | null;
  /** Stroke width in viewBox user units (already transform-scaled). */
  StrokeWidth: number;
  /** Element-level opacity multiplier [0,1] (fill-opacity/opacity folded in). */
  Opacity: number;
}

/** A text run routed to Jaui's existing glyph/text batch (not tessellated). */
export interface SvgTextNode {
  Kind: 'text';
  Text: string;
  X: number;
  Y: number;
  FontSize: number;
  Anchor: 'start' | 'middle' | 'end';
  Weight: number;
  /** Accumulated transform (incl. rotate(180) for the field numbers) in viewBox space. */
  Transform: SvgMatrix;
  FillRaw: string | null;
  Opacity: number;
}

export type SvgNode = SvgPathNode | SvgTextNode;

/** A fully parsed SVG: the viewBox and the flattened node list, ready to tessellate. */
export interface ParsedSvg {
  /** viewBox [minX, minY, width, height] in user units. */
  ViewBox: readonly [number, number, number, number];
  Nodes: SvgNode[];
}

// ── Matrix helpers (parse-time transform baking; kept local + tiny) ──────────

/** Compose two affine transforms: result applies `b` THEN `a` (a ∘ b). */
export function MatMul(a: SvgMatrix, b: SvgMatrix): SvgMatrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function MatApplyX(m: SvgMatrix, x: number, y: number): number {
  return m[0] * x + m[2] * y + m[4];
}

export function MatApplyY(m: SvgMatrix, x: number, y: number): number {
  return m[1] * x + m[3] * y + m[5];
}

/** Uniform scale factor of an affine transform (geometric mean of axis scales) — used to
 *  convert stroke-width and curve-flattening tolerance from user units through a group transform. */
export function MatScale(m: SvgMatrix): number {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  return Math.sqrt(sx * sy) || 1;
}
