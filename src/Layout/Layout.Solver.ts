import type { Jiv } from '../Jiv/Jiv';
import type { LayoutResult } from './Layout.Types';
import { SolveFlex, type FlexContainer, type FlexChild } from './Layout.Flex';

/**
 * Solve layout for the entire tree rooted at `root`.
 * Top-down: parent solves first, children use parent's computed size.
 * Two-phase: (1) resolve Flow/Offset/Placed/Fixed/Sticky; (2) resolve Attach
 * against already-computed target rects, iterating until stable.
 */
export const SolveLayout = (root: Jiv): Map<Jiv, LayoutResult> => {
  const results = new Map<Jiv, LayoutResult>();
  _solveNode(root, root.Width, root.Height, 0, 0, results);
  _resolveAttachPass(root, results);
  return results;
};

/** Post-pass: for every Jiv with Position:'Attach', derive its rect from its
 *  target's current result. Iterate until nothing changes (handles attach
 *  chains where target is itself attached). Capped at ATTACH_MAX_ITER to
 *  prevent infinite loops on cycles. */
const ATTACH_MAX_ITER = 8;
const _resolveAttachPass = (root: Jiv, results: Map<Jiv, LayoutResult>): void => {
  const attached: Jiv[] = [];
  _collectAttached(root, attached);
  if (attached.length === 0) return;

  for (let iter = 0; iter < ATTACH_MAX_ITER; iter++) {
    let changed = false;
    for (const node of attached) {
      const target = node.ChildLayout.AttachTo as Jiv | null;
      if (!target) continue;
      const targetRect = results.get(target);
      if (!targetRect) continue;

      const rect = _computeAttachRect(node, targetRect);
      const prior = results.get(node);
      if (!prior
          || prior.X !== rect.X || prior.Y !== rect.Y
          || prior.Width !== rect.Width || prior.Height !== rect.Height) {
        results.set(node, rect);
        _solveSubtree(node, rect.Width, rect.Height, rect.X, rect.Y, results);
        changed = true;
      }
    }
    if (!changed) return;
  }
};

const _collectAttached = (node: Jiv, out: Jiv[]): void => {
  if (node.ChildLayout.Position === 'Attach') out.push(node);
  for (const c of node.Children) _collectAttached(c, out);
};

const _computeAttachRect = (node: Jiv, target: LayoutResult): LayoutResult => {
  const cl = node.ChildLayout;

  if (cl.AttachMode === 'Fill') {
    // Target rect minus inset (top, right, bottom, left)
    const [it, ir, ib, il] = cl.AttachInset;
    return {
      X: target.X + il,
      Y: target.Y + it,
      Width: Math.max(0, target.Width - il - ir),
      Height: Math.max(0, target.Height - it - ib),
    };
  }

  // Anchor mode: self's declared size positioned so selfAnchor maps to targetAnchor
  const w = _resolveAttachSize(cl.Width, target.Width, node.Width);
  const h = _resolveAttachSize(cl.Height, target.Height, node.Height);

  const targetAX = target.X + target.Width * cl.AttachTargetAnchor.X;
  const targetAY = target.Y + target.Height * cl.AttachTargetAnchor.Y;
  const selfAX = w * cl.AttachSelfAnchor.X;
  const selfAY = h * cl.AttachSelfAnchor.Y;

  return {
    X: targetAX - selfAX + cl.AttachOffsetX,
    Y: targetAY - selfAY + cl.AttachOffsetY,
    Width: w,
    Height: h,
  };
};

const _resolveAttachSize = (size: number | 'Auto' | string, containerSize: number, fallback: number): number => {
  if (size === 'Auto') return fallback;
  if (typeof size === 'number') return size;
  if (typeof size === 'string' && size.endsWith('%')) {
    return (parseFloat(size) / 100) * containerSize;
  }
  return fallback;
};

/** Like _solveNode but only recurses without re-emitting its own result (already set). */
const _solveSubtree = (
  node: Jiv, width: number, height: number, x: number, y: number,
  results: Map<Jiv, LayoutResult>,
): void => {
  // Save and re-invoke the main solver on this node's subtree.
  // _solveNode overwrites results.set(node, ...) with fresh X/Y/W/H; that's
  // fine because we just computed them. Re-running gives us the children.
  _solveNode(node, width, height, x, y, results);
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

  // Placed / Sticky children are positioned RELATIVE TO PARENT (like CSS
  // position: absolute inside a positioned ancestor). child.X / child.Y are
  // offsets from parent's origin, so the child moves automatically when the
  // parent moves — no external sync required.
  //
  // Fixed is positioned relative to the CANVAS VIEWPORT (CSS position:
  // fixed), so it uses child.X / child.Y directly, ignoring the accumulated
  // parent offset.
  for (const child of node.Children) {
    const pos = child.ChildLayout.Position;
    if (pos === 'Placed' || pos === 'Fixed' || pos === 'Sticky') {
      // Resolve child's declared size; fall back to its manually-set Width/Height
      const declW = _resolveSize(child.ChildLayout.Width, width);
      const declH = _resolveSize(child.ChildLayout.Height, height);
      const w = declW === 'Auto' ? child.Width : declW;
      const h = declH === 'Auto' ? child.Height : declH;
      const absX = pos === 'Fixed' ? child.X : offsetX + child.X;
      const absY = pos === 'Fixed' ? child.Y : offsetY + child.Y;
      _solveNode(child, w, h, absX, absY, results);
    }
  }

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
