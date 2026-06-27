/**
 * SvgVectorPaint — the cached, paint-ready geometry for one SVG, built once from a ParsedSvg.
 * Holds tessellated fill meshes and stroke instances per shape, each with its RAW color string
 * (resolved through the JSS var system + animated at paint time, never baked here). Rebuilt only
 * on a structural change; a color-only change just updates the resolved tint uniform.
 */

import { ParsedSvg } from './Svg.Types';
import { TessellateFill } from './Svg.Tessellate';
import { BuildStrokeGeometry } from './Svg.StrokeGeometry';

export interface SvgFillShape {
  Verts: Float32Array;      // interleaved [x, y, cov]
  VertCount: number;
  ColorRaw: string;         // e.g. "@Accent", "rgba(...)", "#rrggbbaa"
  Opacity: number;
}

export interface SvgStrokeShape {
  Data: Float32Array;       // per-segment miter instances
  SegmentCount: number;
  ColorRaw: string;
  HalfWidth: number;        // viewBox units (the SDF coverage edge; miter already includes feather)
  Opacity: number;
}

/** A text run routed to Jaui's glyph/text batch (not tessellated). Positions/transform are in
 *  viewBox units; the renderer maps them through the element's model matrix at paint time. */
export interface SvgTextRun {
  Text: string;
  X: number;
  Y: number;
  FontSize: number;
  Weight: number;
  Anchor: 'start' | 'middle' | 'end';
  /** Accumulated viewBox-space transform (incl. rotate(180) for the top numbers). */
  Transform: readonly [number, number, number, number, number, number];
  ColorRaw: string;
  Opacity: number;
}

export interface SvgVectorPaint {
  ViewBox: readonly [number, number, number, number];
  Fills: SvgFillShape[];
  Strokes: SvgStrokeShape[];
  Texts: SvgTextRun[];
}

/**
 * @param skirtOffset outward AA-skirt feather in viewBox units (~1 device px); 0 disables.
 * @param strokeFeather extra half-extent in viewBox units so stroke quads cover their AA band.
 */
export function BuildVectorPaint(parsed: ParsedSvg, skirtOffset: number, strokeFeather: number): SvgVectorPaint {
  const fills: SvgFillShape[] = [];
  const strokes: SvgStrokeShape[] = [];
  const texts: SvgTextRun[] = [];
  for (const node of parsed.Nodes) {
    if (node.Kind === 'text') {
      if (node.Text && node.FillRaw) {
        texts.push({
          Text: node.Text, X: node.X, Y: node.Y, FontSize: node.FontSize, Weight: node.Weight,
          Anchor: node.Anchor, Transform: node.Transform, ColorRaw: node.FillRaw, Opacity: node.Opacity,
        });
      }
      continue;
    }
    if (node.FillRaw) {
      const mesh = TessellateFill(node.Contours, skirtOffset);
      if (mesh.VertCount > 0) {
        fills.push({ Verts: mesh.Verts, VertCount: mesh.VertCount, ColorRaw: node.FillRaw, Opacity: node.Opacity });
      }
    }
    if (node.StrokeRaw && node.StrokeWidth > 0) {
      const halfWidth = node.StrokeWidth / 2;
      const mesh = BuildStrokeGeometry(node.Contours, halfWidth + strokeFeather);
      if (mesh.SegmentCount > 0) {
        strokes.push({ Data: mesh.Data, SegmentCount: mesh.SegmentCount, ColorRaw: node.StrokeRaw, HalfWidth: halfWidth, Opacity: node.Opacity });
      }
    }
  }
  return { ViewBox: parsed.ViewBox, Fills: fills, Strokes: strokes, Texts: texts };
}
