import type { Jiv } from '../Jiv/Jiv';
import type { LayoutResult } from './Layout.Types';
import { SolveFlex, type FlexContainer, type FlexChild } from './Layout.Flex';

/**
 * Solve layout for the entire tree rooted at `root`.
 * Top-down: parent solves first, children use parent's computed size.
 */
export const SolveLayout = (root: Jiv): Map<Jiv, LayoutResult> => {
  const results = new Map<Jiv, LayoutResult>();
  _solveNode(root, root.Width, root.Height, 0, 0, results);
  return results;
};

const _solveNode = (
  node: Jiv,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  results: Map<Jiv, LayoutResult>,
): void => {
  results.set(node, { X: offsetX, Y: offsetY, Width: width, Height: height });

  if (node.Children.length === 0) return;
  if (node.Layout.Mode !== 'Flex') return;

  const container: FlexContainer = {
    Width: width,
    Height: height,
    Direction: node.Layout.Direction,
    Wrap: node.Layout.Wrap,
    Justify: node.Layout.Justify,
    Align: node.Layout.Align,
    AlignContent: node.Layout.AlignContent,
    Gap: node.Layout.Gap,
    RowGap: node.Layout.RowGap,
    ColumnGap: node.Layout.ColumnGap,
    Padding: node.Layout.Padding,
  };

  // Collect flow children (Flow + Offset participate in flex)
  const flowIndices: number[] = [];
  const flexChildren: FlexChild[] = [];

  const horiz = node.Layout.Direction === 'Row' || node.Layout.Direction === 'RowReverse';

  for (let i = 0; i < node.Children.length; i++) {
    const c = node.Children[i];
    const pos = c.ChildLayout.Position;
    if (pos === 'Flow' || pos === 'Offset') {
      const resolvedW = _resolveSize(c.ChildLayout.Width, width);
      const resolvedH = _resolveSize(c.ChildLayout.Height, height);

      // Intrinsic applies to MAIN axis always; on CROSS axis only when child is NOT stretching.
      const effectiveAlign = c.ChildLayout.AlignSelf === 'Auto'
        ? node.Layout.Align
        : c.ChildLayout.AlignSelf;
      const crossStretches = effectiveAlign === 'Stretch';

      let finalW: number | 'Auto';
      let finalH: number | 'Auto';
      if (horiz) {
        // Row: main = Width, cross = Height
        finalW = resolvedW === 'Auto' && c.IntrinsicWidth !== null ? c.IntrinsicWidth : resolvedW;
        finalH = resolvedH === 'Auto' && c.IntrinsicHeight !== null && !crossStretches
          ? c.IntrinsicHeight
          : resolvedH;
      } else {
        // Column: main = Height, cross = Width
        finalH = resolvedH === 'Auto' && c.IntrinsicHeight !== null ? c.IntrinsicHeight : resolvedH;
        finalW = resolvedW === 'Auto' && c.IntrinsicWidth !== null && !crossStretches
          ? c.IntrinsicWidth
          : resolvedW;
      }

      flexChildren.push({
        Index: flowIndices.length,
        Order: c.ChildLayout.Order,
        FlexGrow: c.ChildLayout.FlexGrow,
        FlexShrink: c.ChildLayout.FlexShrink,
        FlexBasis: c.ChildLayout.FlexBasis,
        AlignSelf: c.ChildLayout.AlignSelf,
        Margin: c.ChildLayout.Margin,
        Width: finalW,
        Height: finalH,
        MinWidth: c.ChildLayout.MinWidth,
        MaxWidth: c.ChildLayout.MaxWidth,
        MinHeight: c.ChildLayout.MinHeight,
        MaxHeight: c.ChildLayout.MaxHeight,
      });
      flowIndices.push(i);
    }
  }

  if (flexChildren.length === 0) return;

  const childResults = SolveFlex(container, flexChildren);

  for (let i = 0; i < flowIndices.length; i++) {
    const child = node.Children[flowIndices[i]];
    const r = childResults[i];

    // Offset children get shifted post-solve
    let rx = r.X;
    let ry = r.Y;
    if (child.ChildLayout.Position === 'Offset') {
      rx += child.ChildLayout.OffsetX;
      ry += child.ChildLayout.OffsetY;
    }

    _solveNode(child, r.Width, r.Height, offsetX + rx, offsetY + ry, results);
  }
};

const _resolveSize = (
  size: number | 'Auto' | string,
  containerSize: number,
): number | 'Auto' => {
  if (size === 'Auto') return 'Auto';
  if (typeof size === 'number') return size;
  if (typeof size === 'string' && size.endsWith('%')) {
    return (parseFloat(size) / 100) * containerSize;
  }
  return 0;
};
