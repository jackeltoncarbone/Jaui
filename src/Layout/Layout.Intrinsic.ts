import type { Jiv } from '../Jiv/Jiv';

/**
 * Compute IntrinsicWidth / IntrinsicHeight for container Jivs based on their children.
 * Runs bottom-up so children's intrinsics are known before computing the parent.
 *
 * Rules:
 * - Text nodes have intrinsic from MeasureText (already set by Canvas._measureDirtyText).
 * - Container nodes (no text, with children) get intrinsic from summing their children
 *   along the container's main axis + max across cross axis, plus gap + padding.
 * - Leaf nodes without text have no intrinsic (remain null).
 * - Explicit Width/Height on a child is used instead of its intrinsic when computing parent.
 */
export const ComputeIntrinsicSizes = (root: Jiv): void => {
  _compute(root);
};

const _compute = (node: Jiv): void => {
  // Bottom-up: children first
  for (const child of node.Children) _compute(child);

  const [pt, pr, pb, pl] = node.Layout.Padding;

  // Text nodes — intrinsic = text measurement + this node's own padding
  if (node.Text !== null && node.TextMeasurement !== null) {
    node.IntrinsicWidth = node.TextMeasurement.Width + pl + pr;
    node.IntrinsicHeight = node.TextMeasurement.Height + pt + pb;
    return;
  }

  // No children → no intrinsic to derive
  if (node.Children.length === 0) return;

  const dir = node.Layout.Direction;
  const horiz = dir === 'Row' || dir === 'RowReverse';
  const gap = horiz
    ? (node.Layout.ColumnGap || node.Layout.Gap)
    : (node.Layout.RowGap || node.Layout.Gap);

  let mainSum = 0;
  let crossMax = 0;
  let count = 0;

  for (const c of node.Children) {
    if (c.ChildLayout.Position === 'Placed' || c.ChildLayout.Position === 'Fixed') continue;

    const explicitW = typeof c.ChildLayout.Width === 'number' ? c.ChildLayout.Width : null;
    const explicitH = typeof c.ChildLayout.Height === 'number' ? c.ChildLayout.Height : null;
    const effectiveW = explicitW ?? c.IntrinsicWidth ?? 0;
    const effectiveH = explicitH ?? c.IntrinsicHeight ?? 0;

    const childMain = horiz ? effectiveW : effectiveH;
    const childCross = horiz ? effectiveH : effectiveW;

    mainSum += childMain;
    if (childCross > crossMax) crossMax = childCross;
    count++;
  }

  const totalGaps = Math.max(0, count - 1) * gap;
  mainSum += totalGaps;

  const mainPadding = horiz ? pl + pr : pt + pb;
  const crossPadding = horiz ? pt + pb : pl + pr;
  mainSum += mainPadding;
  crossMax += crossPadding;

  if (horiz) {
    node.IntrinsicWidth = mainSum;
    node.IntrinsicHeight = crossMax;
  } else {
    node.IntrinsicHeight = mainSum;
    node.IntrinsicWidth = crossMax;
  }
};
