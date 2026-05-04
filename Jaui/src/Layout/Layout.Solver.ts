import type { Element } from '../Element/Element';
import type { LayoutResult } from './Layout.Types';
import type { ResolveContext } from '../Core/Length';
import { Resolve } from '../Core/Length';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';
import { ResolveBound } from '../Core/Style.Resolver';
import { SolveFlex, type FlexContainer, type FlexChild } from './Layout.Flex';
import { MeasureText } from '../Text/Text.Measure';
import { ResolveTextStyle } from '../Text/Text.Types';

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

export const SolveLayout = (
  root: Element,
  viewport: Viewport = DEFAULT_VIEWPORT,
  vars?: ReadonlyMap<string, string>,
): Map<Element, LayoutResult> => {
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
    Vars: vars,
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
    Vars: vars,
  };
  root.ResolveCtx = rootCtx;

  _solveNode(root, root.Width, root.Height, 0, 0, results, rootCtx, viewport, rootPointScale, vars);
  _resolveAttachPass(root, results, viewport, rootPointScale, vars);
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
  vars: ReadonlyMap<string, string> | undefined,
): ResolveContext => {
  const seed: ResolveContext = {
    ParentWidth: containerWidth,
    ParentHeight: containerHeight,
    PointScale: parentPointScale,
    ParentPointScale: parentPointScale,
    RootPointScale: rootPointScale,
    ViewportWidth: viewport.Width,
    ViewportHeight: viewport.Height,
    Vars: vars,
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
  vars: ReadonlyMap<string, string> | undefined,
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
                                    parentPointScale, rootPointScale, viewport, vars);
        node.ResolveCtx = ctx;
        _solveSubtree(node, rect.Width, rect.Height, rect.X, rect.Y, results, ctx, viewport, rootPointScale, vars);
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
  vars: ReadonlyMap<string, string> | undefined,
): void => {
  _solveNode(node, width, height, x, y, results, ctx, viewport, rootPointScale, vars);
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
  vars: ReadonlyMap<string, string> | undefined,
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
      const childCtx = _buildChildCtx(child, width, height, ctx.PointScale, rootPointScale, viewport, vars);
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

      // Fixed: cl.Left/Top are viewport-absolute. Placed/Sticky: relative
      // to the parent's box. Falling back to child.X/Y would feed the
      // animator's post-spring (absolute) value back into the solver and
      // double-add the parent offset each tick.
      const cl = child.ChildLayout;
      let absX: number;
      let absY: number;
      if (pos === 'Fixed') {
        if (cl.Left !== null)        absX = _r(cl.Left, childCtx, 'W');
        else if (cl.Right !== null)  absX = viewport.Width - w - _r(cl.Right, childCtx, 'W');
        else                         absX = child.X;
        if (cl.Top !== null)         absY = _r(cl.Top, childCtx, 'H');
        else if (cl.Bottom !== null) absY = viewport.Height - h - _r(cl.Bottom, childCtx, 'H');
        else                         absY = child.Y;
      } else {
        absX = offsetX + (
          cl.Left  !== null ? _r(cl.Left,  childCtx, 'W') :
          cl.Right !== null ? (width  - w - _r(cl.Right, childCtx, 'W')) :
          0
        );
        absY = offsetY + (
          cl.Top    !== null ? _r(cl.Top,    childCtx, 'H') :
          cl.Bottom !== null ? (height - h - _r(cl.Bottom, childCtx, 'H')) :
          0
        );
      }
      _solveNode(child, w, h, absX, absY, results, childCtx, viewport, rootPointScale, vars);
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

  // Children resolve `%` against the parent's content box, not padding box —
  // matches CSS and means a `Width: 100%` child shrinks by padding*2.
  const [cpt, cpr, cpb, cpl] = container.Padding;
  const contentWidth = Math.max(0, width - cpl - cpr);
  const contentHeight = Math.max(0, height - cpt - cpb);

  for (let i = 0; i < node.Children.length; i++) {
    const c = node.Children[i];
    const pos = c.ChildLayout.Position;
    if (c.LeaveRequested) continue;
    if (pos === 'Flow' || pos === 'Offset') {
      const childCtx = _buildChildCtx(c, contentWidth, contentHeight, ctx.PointScale, rootPointScale, viewport, vars);
      c.ResolveCtx = childCtx;

      const resolvedW = _resolveSize(c.ChildLayout.Width, contentWidth, childCtx, 'W');
      const resolvedH = _resolveSize(c.ChildLayout.Height, contentHeight, childCtx, 'H');

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

      // Margin: single string shorthand (or bare number for all-sides). No
      // per-component 'Auto' support for now — flex auto-margin was barely
      // used and can come back as a CSS token parse later if needed.
      const [mt, mr, mb, ml] = ResolveLengthTuple4(c.ChildLayout.Margin, childCtx, ['H', 'W', 'H', 'W']);

      // Wrap-aware height override — when a Row-direction wrap child is
      // stretched cross-axis by its parent, we know exactly how wide the
      // row will be (parent content width minus the row's cross margins)
      // before flex runs. Use that to simulate how many lines its children
      // will break into and set finalH accordingly. Without this the Row
      // gets its Height from intrinsic (which guessed against ViewportWidth
      // and always overestimated available space → lines overflowed and
      // cards stacked on top of each other).
      const childHoriz = c.Layout.Direction === 'Row' || c.Layout.Direction === 'RowReverse';
      const childWraps = c.Layout.Wrap === 'Wrap' || c.Layout.Wrap === 'WrapReverse';
      if (!horiz && crossStretches && childHoriz && childWraps && isKeyword(resolvedH)) {
        const parentPad = container.Padding;
        const contentCross = Math.max(0, width - parentPad[1] - parentPad[3]);
        const allocatedMain = Math.max(0, contentCross - ml - mr);
        const wrapH = _simulateWrapHeight(c, allocatedMain, childCtx);
        finalH = wrapH;
      }

      // Text wrap-aware sizing — text's intrinsic is measured unbounded (single
      // line) because pre-solve we don't know the allocated width. Once we know
      // the effective cross-axis width (the smaller of: the child's explicit
      // Width, or the parent's allocated budget), re-measure at that width so
      // the text's main-axis size reflects the wrapped line count. Without this,
      // the solver sizes the text box at 1-line height and `_processTextTransitions`
      // later wraps for rendering at the resolved width — text renders taller
      // than its layout box and overlaps siblings.
      // Local use only: don't persist to c.TextMeasurement / c.IntrinsicHeight
      // (those stay at the unbounded measurement so `ComputeIntrinsicSizes`
      // still reports max-content sizing, and the answer doesn't drift across
      // frames when container width animates past the wrap threshold).
      // Column-direction parents only for now — Row-parent wrap needs post-flex
      // shrink resolution which isn't available pre-solve.
      if (!horiz && c.Text !== null && c.TextMeasurement !== null) {
        const parentPad = container.Padding;
        const contentCross = Math.max(0, width - parentPad[1] - parentPad[3]);
        const crossBudget = Math.max(0, contentCross - ml - mr);
        // Effective wrap width: child's explicit Width caps the parent's
        // budget. A `Width: 500pt` title in a 1200pt-wide parent wraps at
        // 500pt, not 1200pt — match what the renderer actually does.
        const explicitW = typeof finalW === 'number' ? finalW : Infinity;
        const effectiveCross = Math.max(0, Math.min(explicitW, crossBudget));
        const [tpt, tpr, tpb, tpl] = ResolveLengthTuple4(c.Layout.Padding, childCtx, ['H', 'W', 'H', 'W']);
        const unboundedCross = c.TextMeasurement.Width + tpl + tpr;
        if (unboundedCross > effectiveCross && effectiveCross > 0) {
          const textMaxWidth = Math.max(0, effectiveCross - tpl - tpr);
          if (textMaxWidth > 0) {
            const resolvedStyle = ResolveTextStyle(c.EffectiveTextStyle(), childCtx);
            const wrapped = MeasureText(c.Text, resolvedStyle, textMaxWidth);
            const wrappedMain = wrapped.Height + tpt + tpb;
            if (isKeyword(resolvedH)) finalH = wrappedMain;
            if (isKeyword(resolvedW) && !crossStretches) finalW = effectiveCross;
          }
        }
      }

      const flexBasis: number | 'Auto' = c.ChildLayout.FlexBasis === 'Auto'
        ? 'Auto'
        : _r(c.ChildLayout.FlexBasis, childCtx, horiz ? 'W' : 'H');

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

    _solveNode(child, r.Width, r.Height, offsetX + rx, offsetY + ry, results, childCtx, viewport, rootPointScale, vars);
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

/** Simulate how a Row-direction wrap container's children bin-pack into
 *  lines at a known main-axis width. Returns the total cross-axis extent
 *  needed = sum(line max cross) + (lines-1) × crossGap + vertical padding.
 *  Used at solve time once we know the row's actual allocated width. */
const _simulateWrapHeight = (
  row: Element,
  mainAvailable: number,
  rowCtx: ResolveContext,
): number => {
  const [pt, pr, pb, pl] = ResolveLengthTuple4(row.Layout.Padding, rowCtx, ['H', 'W', 'H', 'W']);
  const innerMain = Math.max(0, mainAvailable - pl - pr);
  const mainGap = _r(row.Layout.ColumnGap, rowCtx, 'W') || _r(row.Layout.Gap, rowCtx, 'W');
  const crossGap = _r(row.Layout.RowGap, rowCtx, 'H') || _r(row.Layout.Gap, rowCtx, 'H');

  let lineMain = 0;
  let lineCross = 0;
  let total = 0;
  let lineCount = 0;
  for (const c of row.Children) {
    if (c.ChildLayout.Position === 'Placed' || c.ChildLayout.Position === 'Fixed') continue;
    if (c.LeaveRequested) continue;

    // ResolveCtx is normally seeded by `_solveNode` before that child's own
    // solve, but `_simulateWrapHeight` runs INSIDE the row's own solve (a
    // pre-flex sizing helper), so a freshly-mounted child whose first solve
    // hasn't happened yet has `ResolveCtx === null`. Fall back to the row's
    // ctx — the parent inherits PointScale + Vars, which is enough for the
    // simulate-wrap math (Length resolution). The child gets its real ctx
    // in the next solver pass.
    const childCtx = c.ResolveCtx ?? rowCtx;
    const rawW = c.ChildLayout.Width;
    const rawH = c.ChildLayout.Height;
    const explicitW = typeof rawW === 'number' ? rawW
      : (rawW === 'Auto' || rawW === 'MinContent' || rawW === 'MaxContent' || rawW.includes('%')) ? null
      : Resolve(rawW, childCtx, 'W');
    const explicitH = typeof rawH === 'number' ? rawH
      : (rawH === 'Auto' || rawH === 'MinContent' || rawH === 'MaxContent' || rawH.includes('%')) ? null
      : Resolve(rawH, childCtx, 'H');
    const [cmt, cmr, cmb, cml] = ResolveLengthTuple4(c.ChildLayout.Margin, childCtx, ['H', 'W', 'H', 'W']);

    const w = (explicitW ?? c.IntrinsicWidth ?? 0) + cml + cmr;
    const h = (explicitH ?? c.IntrinsicHeight ?? 0) + cmt + cmb;

    const addWithGap = lineMain === 0 ? w : lineMain + mainGap + w;
    if (lineMain > 0 && addWithGap > innerMain) {
      total += lineCross;
      lineCount++;
      lineMain = w;
      lineCross = h;
    } else {
      lineMain = addWithGap;
      if (h > lineCross) lineCross = h;
    }
  }
  if (lineMain > 0) {
    total += lineCross;
    lineCount++;
  }
  return total + Math.max(0, lineCount - 1) * crossGap + pt + pb;
};
