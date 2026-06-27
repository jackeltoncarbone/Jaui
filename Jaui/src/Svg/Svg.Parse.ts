/**
 * SVG parser — a live DOM `<svg>` subtree (or a serialized string) into the flattened
 * node model in Svg.Types. Transforms are baked into absolute viewBox coordinates as we
 * descend, so flattening runs in a single uniform space; colors are kept RAW (resolved
 * through the JSS var system at paint time). Surface: svg, g, rect[rx/ry], line, polyline,
 * polygon, path (M/L/H/V/C/S/Q/T/A/Z), text. No gradients/patterns/masks (unused here).
 */

import {
  ParsedSvg, SvgNode, SvgContour, SvgFillRule, SvgMatrix,
  SVG_IDENTITY, MatMul, MatApplyX, MatApplyY, MatScale,
} from './Svg.Types';
import { FlattenCubic, FlattenQuadratic, FlattenArc } from './Svg.Flatten';

interface InheritedPaint {
  Fill: string | null;
  Stroke: string | null;
  StrokeWidth: number;
  FillRule: SvgFillRule;
  Opacity: number;
  FontSize: number;
  Weight: number;
  Anchor: 'start' | 'middle' | 'end';
}

const ROOT_PAINT: InheritedPaint = {
  Fill: 'black', Stroke: null, StrokeWidth: 1, FillRule: 'nonzero',
  Opacity: 1, FontSize: 16, Weight: 400, Anchor: 'start',
};

/** Parse a transform attribute (translate/scale/rotate/skewX/skewY/matrix) into one matrix. */
export function ParseTransform(str: string | null): SvgMatrix {
  if (!str) return SVG_IDENTITY;
  let m: SvgMatrix = SVG_IDENTITY;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(str))) {
    const fn = mt[1];
    const a = mt[2].split(/[\s,]+/).map(Number).filter(n => !Number.isNaN(n));
    let t: SvgMatrix = SVG_IDENTITY;
    switch (fn) {
      case 'translate': t = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const r = ((a[0] || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        if (a.length >= 3) {
          const cx = a[1], cy = a[2];
          t = MatMul([1, 0, 0, 1, cx, cy], MatMul([c, s, -s, c, 0, 0], [1, 0, 0, 1, -cx, -cy]));
        } else t = [c, s, -s, c, 0, 0];
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
      case 'matrix': if (a.length >= 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
    }
    m = MatMul(m, t);
  }
  return m;
}

/** Parse a path `d` string into flattened, transformed contours appended to `out`. */
export function ParsePathData(d: string, m: SvgMatrix, tol2: number, out: SvgContour[]): void {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!toks) return;
  let i = 0;
  const num = (): number => parseFloat(toks[i++]);
  const flag = (): boolean => toks[i++] === '1'; // arc large/sweep flags are single digits

  // Pen state in USER units (pre-transform); transform is applied when emitting points.
  let cx = 0, cy = 0;        // current point
  let sx = 0, sy = 0;        // subpath start
  let px = 0, py = 0;        // previous control (for S/T smoothing)
  let prevCmd = '';
  let open = false;
  const ax = (x: number, y: number): number => MatApplyX(m, x, y);
  const ay = (x: number, y: number): number => MatApplyY(m, x, y);
  const tip = (): SvgContour => out[out.length - 1];
  const moveTo = (x: number, y: number): void => {
    out.push({ Points: [ax(x, y), ay(x, y)], Closed: false });
    open = true;
    sx = x; sy = y; cx = x; cy = y;
  };
  const lineTo = (x: number, y: number): void => {
    if (!open) moveTo(cx, cy);
    tip().Points.push(ax(x, y), ay(x, y));
    cx = x; cy = y;
  };

  while (i < toks.length) {
    let cmd = toks[i];
    if (/[a-zA-Z]/.test(cmd)) i++;
    else cmd = prevCmd === 'M' ? 'L' : prevCmd === 'm' ? 'l' : prevCmd; // implicit repeat
    const rel = cmd >= 'a';
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case 'M': moveTo(num() + ox, num() + oy); break;
      case 'L': lineTo(num() + ox, num() + oy); break;
      case 'H': lineTo(num() + ox, cy); break;
      case 'V': lineTo(cx, num() + oy); break;
      case 'Z': if (open) { tip().Closed = true; cx = sx; cy = sy; open = false; } break;
      case 'C': {
        const c1x = num() + ox, c1y = num() + oy, c2x = num() + ox, c2y = num() + oy;
        const ex = num() + ox, ey = num() + oy;
        if (!open) moveTo(cx, cy);
        FlattenCubic(tip().Points, ax(cx, cy), ay(cx, cy), ax(c1x, c1y), ay(c1x, c1y),
          ax(c2x, c2y), ay(c2x, c2y), ax(ex, ey), ay(ex, ey), tol2);
        px = c2x; py = c2y; cx = ex; cy = ey;
        break;
      }
      case 'S': {
        const c1x = /[CS]/.test(prevCmd.toUpperCase()) ? 2 * cx - px : cx;
        const c1y = /[CS]/.test(prevCmd.toUpperCase()) ? 2 * cy - py : cy;
        const c2x = num() + ox, c2y = num() + oy, ex = num() + ox, ey = num() + oy;
        if (!open) moveTo(cx, cy);
        FlattenCubic(tip().Points, ax(cx, cy), ay(cx, cy), ax(c1x, c1y), ay(c1x, c1y),
          ax(c2x, c2y), ay(c2x, c2y), ax(ex, ey), ay(ex, ey), tol2);
        px = c2x; py = c2y; cx = ex; cy = ey;
        break;
      }
      case 'Q': {
        const c1x = num() + ox, c1y = num() + oy, ex = num() + ox, ey = num() + oy;
        if (!open) moveTo(cx, cy);
        FlattenQuadratic(tip().Points, ax(cx, cy), ay(cx, cy), ax(c1x, c1y), ay(c1x, c1y),
          ax(ex, ey), ay(ex, ey), tol2);
        px = c1x; py = c1y; cx = ex; cy = ey;
        break;
      }
      case 'T': {
        const c1x = /[QT]/.test(prevCmd.toUpperCase()) ? 2 * cx - px : cx;
        const c1y = /[QT]/.test(prevCmd.toUpperCase()) ? 2 * cy - py : cy;
        const ex = num() + ox, ey = num() + oy;
        if (!open) moveTo(cx, cy);
        FlattenQuadratic(tip().Points, ax(cx, cy), ay(cx, cy), ax(c1x, c1y), ay(c1x, c1y),
          ax(ex, ey), ay(ex, ey), tol2);
        px = c1x; py = c1y; cx = ex; cy = ey;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
        const ex = num() + ox, ey = num() + oy;
        if (!open) moveTo(cx, cy);
        // Flatten the arc in USER space, then transform each emitted point. Simplest correct
        // path: sample in user space into a temp, map through m. Reuse FlattenArc by mapping after.
        const tmp: number[] = [cx, cy];
        FlattenArc(tmp, cx, cy, rx, ry, rot, large, sweep, ex, ey, tol2);
        for (let k = 2; k < tmp.length; k += 2) tip().Points.push(ax(tmp[k], tmp[k + 1]), ay(tmp[k], tmp[k + 1]));
        cx = ex; cy = ey;
        break;
      }
    }
    prevCmd = cmd;
  }
}

/** Rounded-rect (or sharp) as a single closed contour. */
function rectContour(x: number, y: number, w: number, h: number, rx: number, ry: number, m: SvgMatrix, tol2: number): SvgContour {
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
  const pts: number[] = [];
  if (rx <= 0 || ry <= 0) {
    for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as const) pts.push(MatApplyX(m, px, py), MatApplyY(m, px, py));
    return { Points: pts, Closed: true };
  }
  // Build via a path with 4 corner arcs, transform-baked.
  const c: SvgContour = { Points: [], Closed: true };
  const d = `M ${x + rx} ${y} L ${x + w - rx} ${y} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry}`
    + ` L ${x + w} ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}`
    + ` L ${x + rx} ${y + h} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry}`
    + ` L ${x} ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
  const tmp: SvgContour[] = [];
  ParsePathData(d, m, tol2, tmp);
  return tmp[0] ?? c;
}

function attrNum(el: Element, name: string, def = 0): number {
  const v = el.getAttribute(name);
  if (v === null || v === '') return def;
  const n = parseFloat(v);
  return Number.isNaN(n) ? def : n;
}

function resolvePaint(el: Element, parent: InheritedPaint): InheritedPaint {
  const fill = el.getAttribute('fill');
  const stroke = el.getAttribute('stroke');
  const sw = el.getAttribute('stroke-width');
  const fr = el.getAttribute('fill-rule');
  const op = el.getAttribute('opacity');
  const fs = el.getAttribute('font-size');
  const fw = el.getAttribute('font-weight');
  const ta = el.getAttribute('text-anchor');
  const noneToNull = (s: string | null, fallback: string | null): string | null =>
    s === null ? fallback : s === 'none' ? null : s;
  return {
    Fill: noneToNull(fill, parent.Fill),
    Stroke: noneToNull(stroke, parent.Stroke),
    StrokeWidth: sw !== null ? parseFloat(sw) : parent.StrokeWidth,
    FillRule: (fr as SvgFillRule) || parent.FillRule,
    Opacity: parent.Opacity * (op !== null ? parseFloat(op) : 1),
    FontSize: fs !== null ? parseFloat(fs) : parent.FontSize,
    Weight: fw !== null ? (parseFloat(fw) || parent.Weight) : parent.Weight,
    Anchor: (ta as 'start' | 'middle' | 'end') || parent.Anchor,
  };
}

function walk(el: Element, m: SvgMatrix, paint: InheritedPaint, tol2: number, out: SvgNode[]): void {
  const tm = MatMul(m, ParseTransform(el.getAttribute('transform')));
  const p = resolvePaint(el, paint);
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  const scale = MatScale(tm);
  const emitShape = (contours: SvgContour[]): void => {
    if (!contours.length) return;
    out.push({
      Kind: 'path', Contours: contours,
      FillRaw: p.Fill, FillRule: p.FillRule,
      StrokeRaw: p.Stroke, StrokeWidth: p.StrokeWidth * scale,
      Opacity: p.Opacity,
    });
  };

  switch (tag) {
    case 'g': case 'svg': case 'a':
      for (const child of Array.from(el.children)) walk(child, tm, p, tol2, out);
      return;
    case 'rect': {
      const x = attrNum(el, 'x'), y = attrNum(el, 'y'), w = attrNum(el, 'width'), h = attrNum(el, 'height');
      let rx = el.hasAttribute('rx') ? attrNum(el, 'rx') : NaN;
      let ry = el.hasAttribute('ry') ? attrNum(el, 'ry') : NaN;
      if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
      if (Number.isNaN(ry)) ry = rx;
      if (w > 0 && h > 0) emitShape([rectContour(x, y, w, h, rx, ry, tm, tol2)]);
      return;
    }
    case 'line': {
      const x1 = attrNum(el, 'x1'), y1 = attrNum(el, 'y1'), x2 = attrNum(el, 'x2'), y2 = attrNum(el, 'y2');
      emitShape([{ Points: [MatApplyX(tm, x1, y1), MatApplyY(tm, x1, y1), MatApplyX(tm, x2, y2), MatApplyY(tm, x2, y2)], Closed: false }]);
      return;
    }
    case 'polyline': case 'polygon': {
      const raw = (el.getAttribute('points') || '').match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) || [];
      const pts: number[] = [];
      for (let k = 0; k + 1 < raw.length; k += 2) pts.push(MatApplyX(tm, raw[k], raw[k + 1]), MatApplyY(tm, raw[k], raw[k + 1]));
      emitShape([{ Points: pts, Closed: tag === 'polygon' }]);
      return;
    }
    case 'path': {
      const contours: SvgContour[] = [];
      ParsePathData(el.getAttribute('d') || '', tm, tol2, contours);
      emitShape(contours);
      return;
    }
    case 'text': {
      const x = attrNum(el, 'x'), y = attrNum(el, 'y');
      out.push({
        Kind: 'text', Text: (el.textContent || '').trim(),
        X: x, Y: y, FontSize: p.FontSize * scale, Anchor: p.Anchor, Weight: p.Weight,
        Transform: tm, FillRaw: p.Fill, Opacity: p.Opacity,
      });
      return;
    }
    case 'defs': case 'style': case 'title': case 'desc': return;
    default:
      for (const child of Array.from(el.children)) walk(child, tm, p, tol2, out);
  }
}

/** Compute a flattening tolerance (user units, squared) so curves stay sub-pixel at the
 *  expected device size: deviceTolerancePx / (viewBoxUnits-per-device-px). */
export function FlatnessTol2(viewBoxW: number, viewBoxH: number, expectedDeviceW: number, expectedDeviceH: number): number {
  const upx = Math.max(viewBoxW / Math.max(expectedDeviceW, 1), viewBoxH / Math.max(expectedDeviceH, 1));
  const tol = 0.3 * upx; // ~0.3 device px error
  return Math.max(tol * tol, 1e-9);
}

/** Parse a live DOM `<svg>` element. `tol2` from {@link FlatnessTol2}. */
export function ParseSvgElement(svg: SVGSVGElement, tol2: number): ParsedSvg {
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const viewBox: [number, number, number, number] = vb.length === 4 && vb.every(n => !Number.isNaN(n))
    ? [vb[0], vb[1], vb[2], vb[3]]
    : [0, 0, attrNum(svg, 'width', 100), attrNum(svg, 'height', 100)];
  const nodes: SvgNode[] = [];
  for (const child of Array.from(svg.children)) walk(child, SVG_IDENTITY, ROOT_PAINT, tol2, nodes);
  return { ViewBox: viewBox, Nodes: nodes };
}

/** Parse a serialized SVG string (e.g. FieldDecal output) via DOMParser. */
export function ParseSvgString(svg: string, tol2: number): ParsedSvg {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement as unknown as SVGSVGElement;
  return ParseSvgElement(root, tol2);
}
