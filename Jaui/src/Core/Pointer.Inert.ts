import type { Jiv } from '../Jiv/Jiv';

/** The hit a press is dispatched to: null when it or any ancestor is Disabled (UIKit's isEnabled = false
 *  reaches the control's whole subtree), so a disabled button's own label cannot click through to it. */
export const InertUnderDisabled = (hit: Jiv | null): Jiv | null => {
  for (let n: Jiv | null = hit; n; n = n.Parent as Jiv | null) {
    if (n.Disabled) return null;
  }
  return hit;
};
