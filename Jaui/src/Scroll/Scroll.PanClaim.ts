import type { PanClaim } from '../Element/Element';

/**
 * Decide which of a drag's claimants takes a pan, from a finger's travel since press.
 *
 * `claims` is the chain of ancestor `PanClaim`s under the finger, NEAREST FIRST (the same order a hit
 * walk produces), so the first entry that matches wins over an outer one that would also match. Pure:
 * no Jiv, no DOM. The caller resolves `verticalAtTop` from whatever vertical scroller sits among the
 * drag's candidates, exactly as the non-claim scroll path already does.
 *
 *   - `Horizontal` claims a pan whose sideways travel dominates (`|tx| > |ty|`).
 *   - `Down` claims a pan whose vertical travel dominates, moving down (`ty > 0`), and only when the
 *     vertical scroller under the finger has nothing above its own top to give up.
 *   - `Vertical` claims the same pan as `Down`, in either vertical direction.
 *   - `VerticalAlways` claims any pan whose vertical travel dominates, in either direction, whatever the
 *     scroller under the finger is doing: a sheet below its top detent moves rather than scrolls.
 *   - `Hold` never claims: it exists only to be taken by `Jiv.ClaimPan` once a separate gesture (a
 *     long press) decides to lift, so the scroller underneath it stays live until that happens.
 *
 * Returns the winning claimant's index into `claims`, or -1 when none of them claims this pan.
 */
export function PickClaimant(
  claims: readonly PanClaim[],
  tx: number,
  ty: number,
  verticalAtTop: boolean,
): number {
  const horizontal = Math.abs(tx) > Math.abs(ty);
  for (let i = 0; i < claims.length; i++) {
    switch (claims[i]) {
      case 'Horizontal':
        if (horizontal) return i;
        break;
      case 'Down':
        if (!horizontal && ty > 0 && verticalAtTop) return i;
        break;
      case 'Vertical':
        if (!horizontal && verticalAtTop) return i;
        break;
      case 'VerticalAlways':
        if (!horizontal) return i;
        break;
      // 'Hold' and 'None' never claim.
    }
  }
  return -1;
}
