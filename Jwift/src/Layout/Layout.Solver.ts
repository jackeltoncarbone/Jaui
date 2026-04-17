import type { Element } from '../Element/Element';
import type { LayoutResult } from './Layout.Types';
import type { ResolveContext } from '../Core/Length';
import { Resolve } from '../Core/Length';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';
import { ResolveBound } from '../Core/Style.Resolver';
import { SolveFlex, type FlexContainer, type FlexChild } from './Layout.Flex';

/**
 * Solve layout for the entire tree rooted at `root`.
 * Top-down: parent solves first, children use parent's computed size.
 * Two-phase: (1) resolve Flow/Offset/Placed/Fixed/Sticky; (2) resolve Attach
 * against already-computed target rects, iterating until stable.
 *
 * Length handling: every Element carries a `ResolveCtx` computed top-down here.
 * Parent dims + cascading PointScale + viewport feed each child's context
 * so `pt`, `%`, `vw/vh` etc. resolve to the right pixel counts. The ctx is
 * stored on the Element so downstream consumers (style animator) can reuse it.
 */

export interface Viewport { Width: number; Height: number; }

/** Default PointScale used when the root Element's own PointScale is expressed
 *  as `1pt` (self-ref fallback) or when a non-root Element has no parent ctx. */
const DEFAULT_POINT_SCALE = 16;

const DEFAULT_VIEWPORT: Viewport = { Width: 0, Height: 0 };

export const SolveLayout = (root: Element, viewport: Viewport = DEFAULT_VIEWPORT): Map<Element, LayoutResult> => {
  const results = new Map<Element, LayoutResult>();

  // Root's ResolveCtx: no parent, so ParentWidth/Height = viewport,
  // ParentPointScale = DEFAULT_POINT_SCALE, RootPointScale = root's own
  // resolved PointScale (computed first, using parent-ref for self-ref safety).
  const rootSeedCtx: ResolveContext = {
    ParentWidth: viewport.Width,
    ParentHeight: viewport.Height,
    PointScale: DEFAULT_POINT_SCALE,
    ParentPointScale: DEFAULT_POINT_SCALE,
    RootPointScale: DEFAULT_POINT_SCALE,
    ViewportWidth: viewport.Width,
    ViewportHeight: viewport.Height,
  };
  const rootPointScale = Resolve(root.PointScale, rootSeedCtx, 'W', true);

  const rootCtx: ResolveContext = {
    ParentWidth: viewport.Width,
    ParentHeight: viewport.Height,
    PointScale: rootPointScale,
    ParentPointScale: DEFAULT_POINT_SCALE,
    RootPointScale: rootPointScale,
    ViewportWidth: viewport.Width,
    ViewportHeight: viewport.Height,
  };
  root.ResolveCtx = rootCtx;

  _solveNode(root, root.Width, root.Height, 0, 0, results, rootCtx, viewport, rootPointScale);
  _resolveAttachPass(root, results, viewport, rootPointScale);
  return results;
};

/** Build a child's ResolveContext from its parent's context. Child's
 *  PointScale is resolved against parent's PointScale (ptRefersToParent). */
const _buildChildCtx = (
  child: Element,
  containerWidth: number,
  containerHeight: number,
  parentPointScale: number,
  rootPointScale: number,
  viewport: Viewport,
): ResolveContext => {
  const seed: ResolveContext = {
    ParentWidth: containerWidth,
    ParentHeight: containerHeight,
    PointScale: parentPointScale,
    ParentPointScale: parentPointScale,
    RootPointScale: rootPointScale,
    ViewportWidth: viewport.Width,
    ViewportHeight: viewport.Height,
  };
  const pointScale = Resolve(child.PointScale, seed, 'W', true);
  return { ...seed, PointScale: pointScale };
};

/** Resolve a Length string to px. Axis controls what `%` references by default. */
const _r = (v: string, ctx: ResolveContext, axis: 'W' | 'H'): number =>
  Resolve(v, ctx, axis);

/** Post-pass: for every Element with Position:'Attach', derive its rect from its
 *  target's current result. Iterate until nothing changes (handles attach
 *  chains where target is itself attached). Capped at ATTACH_MAX_ITER to
 *  prevent infinite loops on cycles. */
const ATTACH_MAX_ITER = 8;
const _resolveAttachPass = (
  root: Element,
  results: Map<Element, LayoutResult>,
  viewport: Viewport,
  rootPointScale: number,
): void => {
  const attached: Element[] = [];
  _collectAttached(root, attached);
  if (attached.length === 0) return;

  for (let iter = 0; iter < ATTACH_MAX_ITER; iter++) {
    let changed = false;
    for (const node of attached) {
      const target = node.ChildLayout.AttachTo as Element | null;
      if (!target) continue;
      const targetRect = results.get(target);
      if (!targetRect) continue;

      const rect = _computeAttachRect(node, targetRect);
      const prior = results.get(node);
      if (!prior
          || prior.X !== rect.X || prior.Y !== rect.Y
          || prior.Width !== rect.Width || prior.Height !== rect.Height) {
        results.set(node, rect);
        // Recurse into the attached subtree with a freshly-derived ctx — the
        // parent for ctx purposes is whatever ancestor the Element lives under,
        // not the attach target. Use the attached node's own ResolveCtx if
        // set (from main pass); otherwise synthesize from the parent chain.
        const parentCtx = node.Parent?.ResolveCtx ?? node.ResolveCtx;
        const parentPointScale = parentCtx?.PointScale ?? rootPointScale;
        const ctx = _buildChildCtx(node, rect.Width, rect.Height,
                                    parentPointScale, rootPointScale, viewport);
        node.ResolveCtx = ctx;
        _solveSubtree(node, rect.Width, rect.Height, rect.X, rect.Y, results, ctx, viewport, rootPointScale);
        changed = true;
      }
    }
    if (!changed) return;
  }
};

const _collectAttached = (node: Element, out: Element[]): void => {
  if (node.ChildLayout.Position === 'Attach') out.push(node);
  for (const c of node.Children) _collectAttached(c, out);
};

const _computeAttachRect = (node: Element, target: LayoutResult): LayoutResult => {
  const cl = node.ChildLayout;
  // Use parent's ctx (or own as fallback) to resolve attach offsets/insets.
  const ctx = node.Parent?.ResolveCtx ?? node.ResolveCtx;
  if (!ctx) {
    // Shouldn't happen — attach pass runs after main pass has set ctx
    // everywhere. Fall through with a degenerate rect.
    return { X: target.X, Y: target.Y, Width: target.Width, Height: target.Height };
  }

  if (cl.AttachMode === 'Fill') {
    const [it, ir, ib, il] = ResolveLengthTuple4(cl.AttachInset, ctx, ['H', 'W', 'H', 'W']);
    return {
      X: target.X + il,
      Y: target.Y + it,
      Width: Math.max(0, target.Width - il - ir),
      Height: Math.max(0, target.Height - it - ib),
    };
  }

  const w = _resolveAttachSize(cl.Width, target.Width, node.Width, ctx, 'W');
  const h = _resolveAttachSize(cl.Height, target.Height, node.Height, ctx, 'H');

  const targetAX = target.X + target.Width * cl.AttachTargetAnchor.X;
  const targetAY = target.Y + target.Height * cl.AttachTargetAnchor.Y;
  const selfAX = w * cl.AttachSelfAnchor.X;
  const selfAY = h * cl.AttachSelfAnchor.Y;

  return {
    X: targetAX - selfAX + _r(cl.AttachOffsetX, ctx, 'W'),
    Y: targetAY - selfAY + _r(cl.AttachOffsetY, ctx, 'H'),
    Width: w,
    Height: h,
  };
};

const _resolveAttachSize = (
  size: string | 'Auto' | 'MinContent' | 'MaxContent',
  _containerSize: number,
  fallback: number,
  ctx: ResolveContext,
  axis: 'W' | 'H',
): number => {
  if (size === 'Auto' || size === 'MinContent' || size === 'MaxContent') return fallback;
  return _r(size, ctx, axis);
};

const _solveSubtree = (
  node: Element, width: number, height: number, x: number, y: number,
  results: Map<Element, LayoutResult>,
  ctx: ResolveContext,
  viewport: Viewport,
  rootPointScale: number,
): void => {
  _solveNode(node, width, height, x, y, results, ctx, viewport, rootPointScale);
};

const _solveNode = (
  node: Element,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  results: Map<Element, LayoutResult>,
  ctx: ResolveContext,
  viewport: Viewport,
  rootPointScale: number,
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
      const childCtx = _buildChildCtx(child, width, height, ctx.PointScale, rootPointScale, viewport);
      child.ResolveCtx = childCtx;
      const declW = _resolveSize(child.ChildLayout.Width, width, childCtx, 'W');
      const declH = _resolveSize(child.ChildLayout.Height, height, childCtx, 'H');
      const resolveKeyword = (
        v: number | 'Auto' | 'MinContent' | 'MaxContent',
        intrinsic: number | null,
        intrinsicMin: number | null,
        fallback: number,
      ): number => {
        if (typeof v === 'number') return v;
        if (v === 'MinContent') return intrinsicMin ?? intrinsic ?? fallback;
        return intrinsic ?? fallback;   // Auto + MaxContent → max-content intrinsic
      };
      const w = resolveKeyword(declW, child.IntrinsicWidth, child.IntrinsicMinWidth, child.Width);
      const h = resolveKeyword(declH, child.IntrinsicHeight, child.IntrinsicMinHeight, child.Height);

      // Fixed: CSS-style viewport anchors via Top/Bottom/Left/Right beat
      // the imperative child.X / child.Y. Left wins over Right if both set
      // (same for Top/Bottom). Placed/Sticky still use child.X/Y for now.
      let absX: number;
      let absY: number;
      if (pos === 'Fixed') {
        const cl = child.ChildLayout;
        if (cl.Left !== null)        absX = _r(cl.Left, childCtx, 'W');
        else if (cl.Right !== null)  absX = viewport.Width - w - _r(cl.Right, childCtx, 'W');
        else                         absX = child.X;
        if (cl.Top !== null)         absY = _r(cl.Top, childCtx, 'H');
        else if (cl.Bottom !== null) absY = viewport.Height - h - _r(cl.Bottom, childCtx, 'H');
        else                         absY = child.Y;
      } else {
        absX = offsetX + child.X;
        absY = offsetY + child.Y;
      }
      _solveNode(child, w, h, absX, absY, results, childCtx, viewport, rootPointScale);
    }
  }

  if (node.Layout.Mode !== 'Flex') return;

  // Scroll containers give children unlimited space on the scroll axis —
  // content overflows and scrolls instead of shrinking.
  const isScroll = node.Overflow === 'Scroll';
  const horiz = node.Layout.Direction === 'Row' || node.Layout.Direction === 'RowReverse';
  const scrollW = isScroll && horiz ? 1e6 : width;
  const scrollH = isScroll && !horiz ? 1e6 : height;

  const container: FlexContainer = {
    Width: scrollW,
    Height: scrollH,
    Direction: node.Layout.Direction,
    Wrap: node.Layout.Wrap,
    Justify: node.Layout.Justify,
    Align: node.Layout.Align,
    AlignContent: node.Layout.AlignContent,
    Gap: _r(node.Layout.Gap, ctx, 'W'),
    RowGap: _r(node.Layout.RowGap, ctx, 'H'),
    ColumnGap: _r(node.Layout.ColumnGap, ctx, 'W'),
    Padding: ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']),
  };

  const flowIndices: number[] = [];
  const flexChildren: FlexChild[] = [];

  for (let i = 0; i < node.Children.length; i++) {
    const c = node.Children[i];
    const pos = c.ChildLayout.Position;
    if (pos === 'Flow' || pos === 'Offset') {
      // Give each flow child a ctx now so intrinsic fields/margins resolve
      // against its own parent dims + PointScale. The ctx is re-set once
      // more below after flex solves, using the actual resolved size — but
      // PointScale and parent dims don't change, so we can just reuse.
      const childCtx = _buildChildCtx(c, width, height, ctx.PointScale, rootPointScale, viewport);
      c.ResolveCtx = childCtx;

      const resolvedW = _resolveSize(c.ChildLayout.Width, width, childCtx, 'W');
      const resolvedH = _resolveSize(c.ChildLayout.Height, height, childCtx, 'H');

      const effectiveAlign = c.ChildLayout.AlignSelf === 'Auto'
        ? node.Layout.Align
        : c.ChildLayout.AlignSelf;
      const crossStretches = effectiveAlign === 'Stretch';

      // MinContent / MaxContent resolve to the corresponding intrinsic.
      // Auto: max-content on the main axis; cross axis behaves the same
      // unless the child stretches (then cross defers to the flex solver).
      const autoW = c.IntrinsicWidth;
      const autoH = c.IntrinsicHeight;
      const minW = c.IntrinsicMinWidth ?? autoW;
      const minH = c.IntrinsicMinHeight ?? autoH;

      const pickW = (keyword: 'Auto' | 'MinContent' | 'MaxContent'): number | 'Auto' => {
        if (keyword === 'MinContent') return minW ?? 'Auto';
        return autoW ?? 'Auto';   // Auto + MaxContent → max-content intrinsic
      };
      const pickH = (keyword: 'Auto' | 'MinContent' | 'MaxContent'): number | 'Auto' => {
        if (keyword === 'MinContent') return minH ?? 'Auto';
        return autoH ?? 'Auto';
      };
      const isKeyword = (v: unknown): v is 'Auto' | 'MinContent' | 'MaxContent' =>
        v === 'Auto' || v === 'MinContent' || v === 'MaxContent';

      let finalW: number | 'Auto';
      let finalH: number | 'Auto';
      if (horiz) {
        finalW = isKeyword(resolvedW) ? pickW(resolvedW) : resolvedW;
        if (isKeyword(resolvedH) && !crossStretches) finalH = pickH(resolvedH);
        else if (isKeyword(resolvedH)) finalH = 'Auto';
        else finalH = resolvedH;
      } else {
        finalH = isKeyword(resolvedH) ? pickH(resolvedH) : resolvedH;
        if (isKeyword(resolvedW) && !crossStretches) finalW = pickW(resolvedW);
        else if (isKeyword(resolvedW)) finalW = 'Auto';
        else finalW = resolvedW;
      }

      const flexBasis: number | 'Auto' = c.ChildLayout.FlexBasis === 'Auto'
        ? 'Auto'
        : _r(c.ChildLayout.FlexBasis, childCtx, horiz ? 'W' : 'H');

      // Margin: single string shorthand (or bare number for all-sides). No
      // per-component 'Auto' support for now — flex auto-margin was barely
      // used and can come back as a CSS token parse later if needed.
      const [mt, mr, mb, ml] = ResolveLengthTuple4(c.ChildLayout.Margin, childCtx, ['H', 'W', 'H', 'W']);

      flexChildren.push({
        Index: flowIndices.length,
        Order: c.ChildLayout.Order,
        FlexGrow: c.ChildLayout.FlexGrow,
        FlexShrink: c.ChildLayout.FlexShrink,
        FlexBasis: flexBasis,
        AlignSelf: c.ChildLayout.AlignSelf,
        Margin: [mt, mr, mb, ml],
        Width: finalW,
        Height: finalH,
        MinWidth: _r(c.ChildLayout.MinWidth, childCtx, 'W'),
        MaxWidth: ResolveBound(c.ChildLayout.MaxWidth, childCtx, 'W'),
        MinHeight: _r(c.ChildLayout.MinHeight, childCtx, 'H'),
        MaxHeight: ResolveBound(c.ChildLayout.MaxHeight, childCtx, 'H'),
      });
      flowIndices.push(i);
    }
  }

  if (flexChildren.length === 0) return;

  const childResults = SolveFlex(container, flexChildren);

  for (let i = 0; i < flowIndices.length; i++) {
    const child = node.Children[flowIndices[i]];
    const r = childResults[i];
    const childCtx = child.ResolveCtx!;   // set above

    let rx = r.X;
    let ry = r.Y;
    if (child.ChildLayout.Position === 'Offset') {
      rx += _r(child.ChildLayout.OffsetX, childCtx, 'W');
      ry += _r(child.ChildLayout.OffsetY, childCtx, 'H');
    }

    _solveNode(child, r.Width, r.Height, offsetX + rx, offsetY + ry, results, childCtx, viewport, rootPointScale);
  }
};

const _resolveSize = (
  size: string | 'Auto' | 'MinContent' | 'MaxContent',
  _containerSize: number,
  ctx: ResolveContext,
  axis: 'W' | 'H',
): number | 'Auto' | 'MinContent' | 'MaxContent' => {
  // Keyword match is case-insensitive so authors can write any casing
  // (`Auto`, `auto`, `MinContent`, `mincontent`, …).
  const lower = typeof size === 'string' ? size.toLowerCase() : '';
  if (lower === 'auto') return 'Auto';
  if (lower === 'mincontent') return 'MinContent';
  if (lower === 'maxcontent') return 'MaxContent';
  return _r(size, ctx, axis);
};
