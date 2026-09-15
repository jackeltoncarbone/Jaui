/** Dev-only layout dump. Loaded lazily by the worker bridge, so production never fetches it. */

import type { Canvas } from '../Core/Jaui';
import type { Element } from '../Element/Element';
import type { Jiv } from '../Jiv/Jiv';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';
import { ResolveTextStyle } from '../Text/Text.Types';
import { MeasureText } from '../Text/Text.Measure';
import type { ProbeNode, ProbeRect, ProbeSnapshot, ProbeText } from './Probe.Types';

const TEXT_PREVIEW = 60;
const MOVING_EPSILON = 0.5;
const UNBOUNDED = 1e7;

const _round = (v: number): number => Math.round(v * 100) / 100;

const _rect = (x: number, y: number, w: number, h: number): ProbeRect =>
  ({ X: _round(x), Y: _round(y), Width: _round(w), Height: _round(h) });

const _intersect = (a: ProbeRect | null, b: ProbeRect): ProbeRect | null => {
  if (a === null) return null;
  const x0 = Math.max(a.X, b.X), y0 = Math.max(a.Y, b.Y);
  const x1 = Math.min(a.X + a.Width, b.X + b.Width), y1 = Math.min(a.Y + a.Height, b.Y + b.Height);
  return x1 > x0 && y1 > y0 ? _rect(x0, y0, x1 - x0, y1 - y0) : null;
};

const _asJiv = (node: Element): Jiv | null =>
  'RenderStyle' in node ? node as Jiv : null;

const _tuple = (raw: string, node: Element): [number, number, number, number] => {
  if (!node.ResolveCtx) return [0, 0, 0, 0];
  try {
    const [t, r, b, l] = ResolveLengthTuple4(raw, node.ResolveCtx, ['H', 'W', 'H', 'W']);
    return [_round(t), _round(r), _round(b), _round(l)];
  } catch { return [0, 0, 0, 0]; }
};

const _text = (canvas: Canvas, node: Element, padding: [number, number, number, number]): ProbeText | null => {
  if (node.Text === null || node.TextMeasurement === null || !node.ResolveCtx) return null;
  const style = ResolveTextStyle(node.EffectiveTextStyle(), node.ResolveCtx);
  const contentWidth = Math.max(0, node.LayoutWidth - padding[1] - padding[3]);
  const wrapWidth = contentWidth > 0 ? contentWidth : null;
  const wrapped = MeasureText(node.Text, style, wrapWidth);
  const natural = style.MaxLines === null ? wrapped : MeasureText(node.Text, { ...style, MaxLines: null }, wrapWidth);
  const words = canvas.RenderedWords(node);
  return {
    Content: node.Text.slice(0, TEXT_PREVIEW),
    MaxContentWidth: _round(node.TextMeasurement.Width),
    MinContentWidth: _round(node.TextMeasurement.MinWidth),
    WrappedHeight: _round(wrapped.Height),
    WrappedLines: wrapped.Lines.length,
    NaturalLines: natural.Lines.length,
    LastRenderedWord: words.length ? words[words.length - 1] : null,
    FontSize: _round(style.FontSize),
    LineHeight: _round(style.LineHeight),
    TextOverflow: style.TextOverflow,
    MaxLines: style.MaxLines,
  };
};

/** Walk the live tree into a plain snapshot. `ids` maps registry nodes back to their bridge id. */
export const ProbeLayout = (canvas: Canvas, ids: ReadonlyMap<Element, number>): ProbeSnapshot => {
  let settled = !canvas.IsAnimating;

  // Screen position mirrors the render walk: absolute X/Y plus the scroll of every scrolling ancestor,
  // except a Pinned child, which rides its scroll container's frame.
  const walk = (
    node: Element, parent: Element | null, parentBox: ProbeRect | null, sx: number, sy: number,
    inheritedClip: ProbeRect | null, parentOwnClip: ProbeRect | null, ancestorsVisible: boolean,
  ): ProbeNode => {
    const jiv = _asJiv(node);
    const rs = jiv?.RenderStyle;
    const screen = _rect(node.X + sx, node.Y + sy, node.Width, node.Height);
    const moving = Math.abs(node.X - node.LayoutX) > MOVING_EPSILON || Math.abs(node.Y - node.LayoutY) > MOVING_EPSILON
      || Math.abs(node.Width - node.LayoutWidth) > MOVING_EPSILON || Math.abs(node.Height - node.LayoutHeight) > MOVING_EPSILON;
    if (moving && !node.LeaveRequested) settled = false;

    const parentOverflow = node.ChildLayout.ParentOverflow;
    // The clip this node paints under: its parent's clip for children, unless it escapes or opts in.
    let clip = inheritedClip;
    if (parentOverflow === 'Visible') clip = parentOwnClip;
    else if (parentOverflow === 'Hidden' && parentBox) clip = _intersect(inheritedClip, parentBox);

    const opacity = node === canvas.Root ? 1 : jiv ? jiv.EffectiveOpacity : 1;
    const visible = ancestorsVisible && node.Visible && opacity > 0.01;
    const padding = _tuple(node.Layout.Padding, node);
    const background = rs?.Background;
    const hasPaint = !!rs && (
      (background !== undefined && (background.Kind !== 'Color' || background.Color.A > 0.001))
      || (rs.BorderWidth > 0 && rs.BorderColor.A > 0.001)
      || rs.Material !== 'None' || (rs.ShadowBlur > 0 && rs.ShadowColor.A > 0.001)
      || node.SvgVector !== null);

    const scrolls = node.Overflow === 'Scroll';
    const childSx = scrolls ? sx - node.ScrollX : sx;
    const childSy = scrolls ? sy - node.ScrollY : sy;
    const childClip = node.ClipsChildren ? _intersect(clip, screen) : clip;

    const children: ProbeNode[] = [];
    for (const c of node.Children) {
      const pinned = c.ChildLayout.Position === 'Pinned' && scrolls;
      children.push(walk(c, node, screen, pinned ? sx : childSx, pinned ? sy : childSy, childClip, clip, visible));
    }

    const radii = rs?.BorderRadius ?? [0, 0, 0, 0];
    return {
      Id: node === canvas.Root ? 0 : ids.get(node) ?? -1,
      Classes: jiv ? [...jiv.Classes] : [],
      Rect: screen,
      Local: _rect(node.X - (parent?.X ?? 0), node.Y - (parent?.Y ?? 0), node.Width, node.Height),
      VisibleRect: _intersect(clip, screen),
      Moving: moving,
      Padding: padding,
      Margin: _tuple(node.ChildLayout.Margin, node),
      Layout: {
        Mode: node.Layout.Mode, Direction: node.Layout.Direction, Wrap: node.Layout.Wrap, Align: node.Layout.Align,
        AlignContent: node.Layout.AlignContent, Justify: node.Layout.Justify, Gap: _tuple(node.Layout.Gap, node)[0],
      },
      AlignSelf: node.ChildLayout.AlignSelf,
      Width: String(node.ChildLayout.Width),
      Height: String(node.ChildLayout.Height),
      Position: node.ChildLayout.Position,
      Overflow: node.Overflow,
      Clip: node.Clip,
      ClipsChildren: node.ClipsChildren,
      ParentOverflow: parentOverflow,
      Scroll: scrolls ? { X: _round(node.ScrollX), Y: _round(node.ScrollY), ContentWidth: _round(node.ContentWidth), ContentHeight: _round(node.ContentHeight) } : null,
      Layer: rs?.Layer ?? 0,
      ZIndex: node.ChildLayout.ZIndex,
      Radius: _round(Math.max(...radii)),
      RadiusAuthored: _round(Math.min(...(rs?.BorderRadiusRaw ?? [0, 0, 0, 0]))),
      HasPaint: hasPaint,
      Background: background?.Kind ?? null,
      Opacity: _round(opacity),
      Presence: _round(node.Presence),
      Visible: visible,
      Interactive: node.Interactive,
      Cursor: node.Cursor,
      PointerEvents: node.PointerEvents,
      Leaving: node.LeaveRequested,
      Text: _text(canvas, node, padding),
      Children: children,
    };
  };

  // Unbounded at the root: VisibleRect reports ancestor clipping only, so off-canvas content stays measurable.
  const unbounded: ProbeRect = { X: -UNBOUNDED, Y: -UNBOUNDED, Width: 2 * UNBOUNDED, Height: 2 * UNBOUNDED };
  const root = walk(canvas.Root, null, null, 0, 0, unbounded, unbounded, true);
  return { Viewport: { Width: canvas.Width, Height: canvas.Height, Dpr: canvas.Dpr }, Settled: settled, Root: root };
};
