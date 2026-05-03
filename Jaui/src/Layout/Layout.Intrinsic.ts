import type { Element } from '../Element/Element';
import { Resolve, type ResolveContext } from '../Core/Length';
import { ResolveLengthTuple4 } from '../Core/Length.Tuple';
import type { Viewport } from './Layout.Solver';
import { MeasureText } from '../Text/Text.Measure';
import { ResolveTextStyle } from '../Text/Text.Types';

/**
 * Compute IntrinsicWidth / IntrinsicHeight for container Elements based on their children.
 * Runs bottom-up so children's intrinsics are known before computing the parent.
 *
 * Length handling: intrinsic runs BEFORE SolveLayout, so parent dims aren't
 * known yet — `%` units can't resolve here (they collapse to 0, which is the
 * right intrinsic behavior: a percentage-sized child contributes no intrinsic
 * width). `pt` / `rpt` / `px` / `vw` / `vh` all resolve normally because they
 * depend only on the PointScale cascade + viewport, both of which we can
 * establish before sizes are known. This function does a top-down PointScale
 * cascade first, stashing a seed `ResolveCtx` on each Element, then runs the
 * bottom-up intrinsic computation using those seed contexts.
 */

const DEFAULT_POINT_SCALE = 16;

const DEFAULT_VIEWPORT: Viewport = { Width: 0, Height: 0 };

export const ComputeIntrinsicSizes = (
  root: Element,
  viewport: Viewport = DEFAULT_VIEWPORT,
  vars?: ReadonlyMap<string, string>,
): void => {
  CascadePointScale(root, viewport, vars);
  _compute(root);
};

/** Top-down PointScale cascade. Each Element gets a seed ResolveCtx with
 *  ParentWidth/Height = 0 (unknown pre-solve) but real PointScale +
 *  viewport. Parent PointScale flows to child; child's PointScale expressed
 *  in `pt` resolves against parent's PointScale (ptRefersToParent=true).
 *  Idempotent — safe to call multiple times per frame. */
export const CascadePointScale = (
  root: Element,
  viewport: Viewport = DEFAULT_VIEWPORT,
  vars?: ReadonlyMap<string, string>,
): void => {
  _cascadePointScale(root, null, viewport, vars);
};

const _cascadePointScale = (
  node: Element,
  parentPointScale: number | null,
  viewport: Viewport,
  vars: ReadonlyMap<string, string> | undefined,
): void => {
  const parent = parentPointScale ?? DEFAULT_POINT_SCALE;
  const seed: ResolveContext = {
    ParentWidth: 0,
    ParentHeight: 0,
    PointScale: parent,         // unused when ptRefersToParent=true
    ParentPointScale: parent,
    RootPointScale: 0,          // patched below once root's is known
    ViewportWidth: viewport.Width,
    ViewportHeight: viewport.Height,
    Vars: vars,
  };
  const pointScale = Resolve(node.PointScale, seed, 'W', true);

  // RootPointScale: root uses its own; children inherit from parent ctx.
  const rootPointScale = node.Parent?.ResolveCtx?.RootPointScale ?? pointScale;

  node.ResolveCtx = {
    ParentWidth: 0,
    ParentHeight: 0,
    PointScale: pointScale,
    ParentPointScale: parent,
    RootPointScale: rootPointScale,
    ViewportWidth: viewport.Width,
    ViewportHeight: viewport.Height,
    Vars: vars,
  };

  for (const child of node.Children) _cascadePointScale(child, pointScale, viewport, vars);
};

const _compute = (node: Element): void => {
  for (const child of node.Children) _compute(child);

  const ctx = node.ResolveCtx!;
  const [pt, pr, pb, pl] = ResolveLengthTuple4(node.Layout.Padding, ctx, ['H', 'W', 'H', 'W']);

  if (node.Text !== null && node.TextMeasurement !== null) {
    // Default: unbounded measurement (single-line) drives intrinsic.
    let mainHeight = node.TextMeasurement.Height + pt + pb;
    // If the text node has an explicit Width (e.g. a hero title with
    // `Width: 500pt`) OR the ancestor chain's effective budget is narrower
    // than the unbounded text, re-measure at that bound. Without this, the
    // parent column's intrinsic height comes up short — flex-shrink kicks
    // in at solve time and crushes the title back to single-line height.
    const explicitW = _intrinsicOf(node.ChildLayout.Width, ctx, 'W');
    // Use the nearest ancestor's bounded width (rail, page section, etc.)
    // when computing the wrap budget, not the raw viewport width — otherwise
    // text inside a flex-shrunk container measures as 1 line at viewport
    // width, the box gets sized to 1 line, and the actual rendering wraps
    // many lines past the box.
    const ancestorBudget = _textWrapBudget(node, true, ctx);
    const wrapBudget = Math.min(
      explicitW !== null ? explicitW : Infinity,
      ancestorBudget,
    );
    const unboundedW = node.TextMeasurement.Width + pl + pr;
    if (wrapBudget > 0 && wrapBudget < unboundedW) {
      const textMaxWidth = Math.max(0, wrapBudget - pl - pr);
      if (textMaxWidth > 0) {
        const resolvedStyle = ResolveTextStyle(node.TextStyle, ctx);
        const wrapped = MeasureText(node.Text, resolvedStyle, textMaxWidth);
        mainHeight = wrapped.Height + pt + pb;
        // Persist the wrapped measurement on the node so downstream code
        // (including the renderer's word layout pass) sees the correct
        // line count, not the unbounded single-line measurement.
        node.TextMeasurement = wrapped;
      }
    }
    node.IntrinsicWidth = node.TextMeasurement.Width + pl + pr;
    node.IntrinsicHeight = mainHeight;
    node.IntrinsicMinWidth = node.TextMeasurement.MinWidth + pl + pr;
    node.IntrinsicMinHeight = mainHeight;
    return;
  }

  if (node.Children.length === 0) return;

  const dir = node.Layout.Direction;
  const horiz = dir === 'Row' || dir === 'RowReverse';
  // Gap fallback: prefer the axis-specific gap; if it resolves to 0 (default),
  // fall back to the general Gap. Can't use JS `||` on raw fields because
  // `'0'` (string zero) is truthy and would shadow an explicit general Gap.
  const axis: 'W' | 'H' = horiz ? 'W' : 'H';
  const specific = Resolve(horiz ? node.Layout.ColumnGap : node.Layout.RowGap, ctx, axis);
  const general = Resolve(node.Layout.Gap, ctx, axis);
  const gap = specific || general;

  // Max-content: sum on main axis, max on cross axis.
  // Min-content: main axis = max of children's main-axis min (row) or sum
  // (column — vertical stacking doesn't collapse). Cross axis = max of
  // children's cross-axis min.
  let mainSum = 0;
  let crossMax = 0;
  let mainMin = 0;        // row: max(child.MinMain); column: sum(child.MinMain)
  let crossMin = 0;       // max of child min on cross axis
  let count = 0;

  for (const c of node.Children) {
    if (c.ChildLayout.Position === 'Placed' || c.ChildLayout.Position === 'Fixed') continue;
    // Leaving children don't contribute to intrinsic size either — the
    // parent collapses around them as if they were already removed.
    if (c.LeaveRequested) continue;

    // Explicit size participates in intrinsic sum only if it's purely
    // numeric (px) or resolvable without parent dims. Length that's `%`
    // can't be resolved pre-solve — skip to intrinsic in that case.
    const childCtx = c.ResolveCtx!;
    const w = c.ChildLayout.Width;
    const h = c.ChildLayout.Height;
    const explicitW = _intrinsicOf(w, childCtx, 'W');
    const explicitH = _intrinsicOf(h, childCtx, 'H');
    const effectiveW = explicitW ?? c.IntrinsicWidth ?? 0;
    const effectiveH = explicitH ?? c.IntrinsicHeight ?? 0;
    // For min-content: explicit sizes pin the child (an explicit 200px child
    // contributes 200px even to min-content); only auto/content-sized children
    // fall back to their IntrinsicMin.
    const effectiveMinW = explicitW ?? c.IntrinsicMinWidth ?? c.IntrinsicWidth ?? 0;
    const effectiveMinH = explicitH ?? c.IntrinsicMinHeight ?? c.IntrinsicHeight ?? 0;

    // Child's own margins participate in its intrinsic contribution —
    // otherwise a child with a big cross-axis margin makes the parent too
    // small to honor that margin, and the flex solver silently eats it.
    const [mt, mr, mb, ml] = ResolveLengthTuple4(c.ChildLayout.Margin, childCtx, ['H', 'W', 'H', 'W']);
    const mainMargin = horiz ? ml + mr : mt + mb;
    const crossMargin = horiz ? mt + mb : ml + mr;

    const childMain = (horiz ? effectiveW : effectiveH) + mainMargin;
    const childCross = (horiz ? effectiveH : effectiveW) + crossMargin;
    const childMinMain = (horiz ? effectiveMinW : effectiveMinH) + mainMargin;
    const childMinCross = (horiz ? effectiveMinH : effectiveMinW) + crossMargin;

    mainSum += childMain;
    if (childCross > crossMax) crossMax = childCross;

    if (horiz) {
      if (childMinMain > mainMin) mainMin = childMinMain;   // row: unbreakable widest
    } else {
      mainMin += childMinMain;                               // column: still stacks
    }
    if (childMinCross > crossMin) crossMin = childMinCross;

    count++;
  }

  const totalGaps = Math.max(0, count - 1) * gap;
  mainSum += totalGaps;
  if (!horiz) mainMin += totalGaps;

  const mainPadding = horiz ? pl + pr : pt + pb;
  const crossPadding = horiz ? pt + pb : pl + pr;
  mainSum += mainPadding;
  crossMax += crossPadding;
  mainMin += mainPadding;
  crossMin += crossPadding;

  // Wrap-aware cross size — if this container flex-wraps on the main axis,
  // its cross dimension grows with how many lines the children break into.
  // Without this, Intrinsic*H* for a wrap Row would equal a single line's
  // height, so the parent allocates too little space and wrapped lines
  // stack on top of each other. Uses ViewportWidth (minus our padding) as
  // the main-axis bound — parent dims aren't known pre-solve, but this is
  // a reasonable upper bound for any top-level flow.
  if (node.Layout.Wrap === 'Wrap' || node.Layout.Wrap === 'WrapReverse') {
    const crossGapSpec = Resolve(horiz ? node.Layout.RowGap : node.Layout.ColumnGap, ctx, horiz ? 'H' : 'W');
    const crossGap = crossGapSpec || Resolve(node.Layout.Gap, ctx, horiz ? 'H' : 'W');
    // Walk the perpendicular-direction ancestor chain to subtract their
    // main-axis paddings from the budget. Without this, a Row inside a
    // Section with `Padding: 0pt 24pt` simulates against the full
    // viewport — predicting fewer wrap lines than the solver will
    // actually produce — and Section's intrinsic-driven allocation comes
    // up short, so wrapped cards overflow into the next Section.
    const ancestorPad = _ancestorMainPadding(node, horiz, ctx);
    const mainBudget = Math.max(0, ctx.ViewportWidth - mainPadding - ancestorPad);
    const wrapCross = _simulateWrapCrossSize(node, horiz, gap, crossGap, mainBudget);
    if (horiz) crossMax = wrapCross + crossPadding;
    else crossMax = wrapCross + crossPadding;
  }

  if (horiz) {
    node.IntrinsicWidth = mainSum;
    node.IntrinsicHeight = crossMax;
    node.IntrinsicMinWidth = mainMin;
    node.IntrinsicMinHeight = crossMin;
  } else {
    node.IntrinsicHeight = mainSum;
    node.IntrinsicWidth = crossMax;
    node.IntrinsicMinHeight = mainMin;
    node.IntrinsicMinWidth = crossMin;
  }
};

/** Bin-pack children onto wrap lines using `mainBudget` as the line-break
 *  threshold. Returns total cross size = sum(line max-cross) + (N-1) * gap.
 *  Used to compute a wrap container's intrinsic cross size, which is
 *  otherwise wrong (single-line max) for `Wrap: Wrap` containers. */
const _simulateWrapCrossSize = (
  node: Element,
  horiz: boolean,
  mainGap: number,
  crossGap: number,
  mainBudget: number,
): number => {
  let lineMain = 0;
  let lineCross = 0;
  let total = 0;
  let lineCount = 0;
  for (const c of node.Children) {
    if (c.ChildLayout.Position === 'Placed' || c.ChildLayout.Position === 'Fixed') continue;
    if (c.LeaveRequested) continue;
    const childCtx = c.ResolveCtx!;
    const explicitW = _intrinsicOf(c.ChildLayout.Width, childCtx, 'W');
    const explicitH = _intrinsicOf(c.ChildLayout.Height, childCtx, 'H');
    const effW = explicitW ?? c.IntrinsicWidth ?? 0;
    const effH = explicitH ?? c.IntrinsicHeight ?? 0;
    const childMain = horiz ? effW : effH;
    const childCross = horiz ? effH : effW;
    const addWithGap = lineMain === 0 ? childMain : lineMain + mainGap + childMain;
    if (lineMain > 0 && addWithGap > mainBudget) {
      total += lineCross;
      lineCount++;
      lineMain = childMain;
      lineCross = childCross;
    } else {
      lineMain = addWithGap;
      if (childCross > lineCross) lineCross = childCross;
    }
  }
  if (lineMain > 0) {
    total += lineCross;
    lineCount++;
  }
  return total + Math.max(0, lineCount - 1) * crossGap;
};

/** Sum of horizontal-padding contributions from perpendicular-direction
 *  ancestors that constrain this node's main-axis budget. For a Row (horiz),
 *  we walk up Column-direction ancestors and add their left+right padding.
 *  Stops at the first ancestor with an explicit non-percent main-axis size
 *  (then we know the budget already; ancestors beyond don't shrink it
 *  further) or at the root. Conservative — only Column-direction ancestors
 *  contribute on a horizontal axis (Row-direction ancestors fan out via the
 *  flex solver, can't be bottom-up estimated reliably). */
const _ancestorMainPadding = (
  node: Element,
  horiz: boolean,
  _ctx: ResolveContext,
): number => {
  let total = 0;
  let cur: Element | null = node.Parent ?? null;
  while (cur) {
    const ancestorHoriz = cur.Layout.Direction === 'Row' || cur.Layout.Direction === 'RowReverse';
    // Only perpendicular-direction ancestors meaningfully constrain main:
    // a Column ancestor's width applies fully to a Row child.
    if (ancestorHoriz === horiz) break;
    const childCtx = cur.ResolveCtx ?? _ctx;
    const [_pt, pr, _pb, pl] = ResolveLengthTuple4(cur.Layout.Padding, childCtx, ['H', 'W', 'H', 'W']);
    total += horiz ? (pl + pr) : (_pt + _pb);
    // If this ancestor has an explicit non-percent main-axis size set on
    // its own ChildLayout, the budget is now bounded — don't keep walking.
    const ownMain = horiz ? cur.ChildLayout.Width : cur.ChildLayout.Height;
    if (ownMain !== 'Auto' && ownMain !== 'MinContent' && ownMain !== 'MaxContent'
        && typeof ownMain === 'string' && !ownMain.includes('%')) {
      break;
    }
    if (typeof ownMain === 'number') break;
    cur = cur.Parent ?? null;
  }
  return total;
};

/** Wrap budget for a text node, taking flex-shrunk ancestors into account.
 *  Walks up the entire ancestor chain accumulating paddings; when it hits
 *  the first ancestor with an explicit non-percent width, returns that
 *  width minus accumulated paddings. Without this, a label inside a 280pt
 *  rail would measure against the 1200pt viewport, get a 1-line height,
 *  and visually overflow when the solver shrinks it to 280pt.
 *
 *  Percentage widths (e.g. `Width: 40%`) accumulate as a multiplier — the
 *  walk continues until it reaches the first explicit-pt or pixel-resolved
 *  ancestor and multiplies the resulting budget by the running percentage.
 *
 *  Falls back to viewport width minus accumulated paddings if no bounded
 *  ancestor is found. */
const _textWrapBudget = (
  node: Element,
  horiz: boolean,
  ctx: ResolveContext,
): number => {
  // Fast path: if the immediate parent has been solved (i.e. has a
  // non-zero Width from a previous frame), its content area is the
  // authoritative budget for any text living inside it. This already
  // accounts for every flex/percentage/padding decision the solver made
  // upstream, so we don't need to re-derive it from the spec.
  const parent = node.Parent ?? null;
  if (parent) {
    const parentSolved = horiz ? parent.Width : parent.Height;
    if (parentSolved > 0) {
      const childCtx = parent.ResolveCtx ?? ctx;
      const [pPt, pPr, pPb, pPl] = ResolveLengthTuple4(parent.Layout.Padding, childCtx, ['H', 'W', 'H', 'W']);
      const pad = horiz ? (pPl + pPr) : (pPt + pPb);
      return Math.max(0, parentSolved - pad);
    }
  }

  // Spec-derived fallback for the first frame (no solved width yet).
  // Walks ancestors accumulating paddings; pins the budget on the first
  // explicit non-percent width, with any % ancestors descended through
  // applied as a multiplier; falls back to viewport otherwise.
  let totalPad = 0;
  let multiplier = 1;
  let cur: Element | null = parent;
  while (cur) {
    const childCtx = cur.ResolveCtx ?? ctx;
    const [_pt, pr, _pb, pl] = ResolveLengthTuple4(cur.Layout.Padding, childCtx, ['H', 'W', 'H', 'W']);
    totalPad += horiz ? (pl + pr) : (_pt + _pb);
    const ownMain = horiz ? cur.ChildLayout.Width : cur.ChildLayout.Height;
    const explicit = _intrinsicOf(ownMain, childCtx, horiz ? 'W' : 'H');
    if (explicit !== null) {
      return Math.max(0, explicit * multiplier - totalPad);
    }
    if (typeof ownMain === 'string' && ownMain.includes('%')) {
      const pctMatch = /^\s*([\d.]+)\s*%\s*$/.exec(ownMain);
      if (pctMatch) multiplier *= Number(pctMatch[1]) / 100;
    }
    cur = cur.Parent ?? null;
  }
  const vp = horiz ? ctx.ViewportWidth : ctx.ViewportHeight;
  return Math.max(0, vp * multiplier - totalPad);
};

/** Return a pixel value if the dimension is "known" without parent dims.
 *  Returns null for `Auto`, legacy ChildLayout "string" overrides, or any
 *  Length whose string contains `%` (parent-dim-relative, can't resolve
 *  pre-layout). Plain numbers, `pt`, `rpt`, `vw`, `vh`, and arithmetic
 *  over those all resolve — they don't need parent dims. */
const _intrinsicOf = (
  size: string | 'Auto' | 'MinContent' | 'MaxContent',
  ctx: ResolveContext,
  axis: 'W' | 'H',
): number | null => {
  if (size === 'Auto' || size === 'MinContent' || size === 'MaxContent') return null;
  if (typeof size === 'number') return size;
  if (size.includes('%')) return null;   // parent-relative — skip
  return Resolve(size, ctx, axis);
};
