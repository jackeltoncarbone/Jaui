/**
 * WHY A GLASS FILL DID NOT JOIN A GROUP, by name.
 *
 * `jaui:glass-group ... solo=6` says six fills built alone and nothing about why, and the fix for each
 * reason is a different change: a surface that is the only glass in its container can only be grouped
 * by an authored container (the `GlassGroup:` hatch `_planGlassGroups` documents), a radius split is a
 * material question, and a broken run is a tree-shape question. So the census names the reason per
 * surface and the gate prints the tally.
 *
 * Pure, and deliberately a SECOND reading of the scan rather than a side channel out of the planner's
 * run loop: it sees the whole scan, which a run-length pass does not, and that is what separates
 * "alone in its container" from "its container has another glass at another radius".
 */

/** The reason a scanned fill built its own pyramid. */
export type GlassSoloReason =
  /** Replayed out of its own scope (a teleport) or the Root: no parent, groups with nothing. */
  | 'no-parent'
  /** `MaxLod > 0`: a mip consumer never joins a group (`_planGlassGroups`). */
  | 'mip-consumer'
  /** The only `MaxLod == 0` glass fill under its parent. */
  | 'only-glass-in-parent'
  /** Its parent holds other glass fills, but none at its sigma. */
  | 'radius-differs'
  /** Same parent and sigma exist, but not adjacent in walk order: a run broke between them. */
  | 'run-broken'
  /** A real run of two or more that `PlanBackdropUnion` refused (k, edge clamp, containment, fill). */
  | 'planner-refused';

/** One scanned fill, as `_planGlassGroups` sees it. `Parent` is compared by identity. */
export interface GlassScanEntry { Parent: unknown; Radius: number; MaxLod: number }

/** The reason for the fill at `index`, which the planner left as a run of one. */
export const GlassSoloReasonAt = (scan: readonly GlassScanEntry[], index: number): GlassSoloReason => {
  const c = scan[index];
  if (c.Parent === null) return 'no-parent';
  if (c.MaxLod > 0) return 'mip-consumer';
  let sameParent = false;
  for (let i = 0; i < scan.length; i++) {
    const o = scan[i];
    if (i === index || o.Parent !== c.Parent || o.MaxLod > 0) continue;
    sameParent = true;
    if (o.Radius === c.Radius) return 'run-broken';
  }
  return sameParent ? 'radius-differs' : 'only-glass-in-parent';
};

/** `reason:n,...` sorted, or `none`. */
export const GlassSoloTally = (reasons: readonly GlassSoloReason[]): string => {
  const m = new Map<string, number>();
  for (const r of reasons) m.set(r, (m.get(r) ?? 0) + 1);
  return m.size === 0 ? 'none' : [...m].sort().map(([k, n]) => `${k}:${n}`).join(',');
};
