/**
 * Where a freshly-attached canvas node belongs among its current siblings, so paint/layout order follows
 * the template instead of attach order. `AddChild` always appends; a child that mounted out of authored
 * order — e.g. one sitting in an `@if` that flipped true after its static siblings already attached — would
 * otherwise stay at the END of the parent's Children and paint below content authored after it. Pulled out
 * of `Jiv.ts` (a plain function, no Angular import) so the DOM-order math is testable with real jsdom
 * elements and no Angular compiler/TestBed in the loop — the same split `Jiv.Link.ts` makes for `LinkTarget`.
 *
 * Returns the index this node should move to, or `null` when nothing should move: either it is already in
 * the right place, or — the case this function exists to get right — there is no real document order to
 * chase yet.
 *
 * SS-Support-FAQ: a node projected into a slot that is not rendered yet (`<ng-content>` inside
 * `disclosure-row`'s `@if (open())`, for a closed FAQ answer) is CONSTRUCTED regardless — Angular builds
 * projected content whether or not the outlet that would show it is live; `Avatar.Slot.spec.ts` measures
 * the identical construct-before-render fact for the avatar's own fallback template — but its host element
 * is not CONNECTED to the document until the outlet actually renders. Every word of a multi-word answer
 * mounts this way in the same tick, each one disconnected the same as every sibling that mounted just
 * before it. The old version of this function kept counting PRECEDING CONNECTED siblings regardless of
 * whether `myEl` itself was connected, found zero every time (every candidate was disconnected too, so the
 * `isConnected` filter below excluded all of them) and read that as "I am first" — moving every word to
 * index 0 as it mounted. That reverses the whole run: word 2 jumps ahead of word 1, word 3 jumps ahead of
 * both word 1 and word 2, and so on, so by the last word the answer reads back to front. The fix is the
 * `myEl.isConnected` guard: `compareDocumentPosition` is only meaningful between nodes actually in the live
 * tree, so while this node itself is not in it there is no document order to measure, and `AddChild`'s
 * plain append — construction order, which for a normal (non-permuted) template IS authored order — is
 * already correct. Nothing needs fixing again once the outlet renders: this function runs once, in
 * `ngOnInit`, and by then the array was never wrong.
 */
export function DomReorderTarget(
  myEl: Element,
  /** Every OTHER sibling's host element, in the parent's current Children order (this node's own entry
   *  left out — the caller already knows where it sits via `currentIndex`). `undefined` for a sibling with
   *  no recorded host (shouldn't happen for a live `<jiv>`/`<jext>`, kept optional defensively). */
  otherSiblingHosts: readonly (Element | undefined)[],
  /** This node's own index among ALL siblings (itself included) in the parent's current Children order —
   *  what `Children.indexOf(thisNode)` reads right after `AddChild` appended it. */
  currentIndex: number,
): number | null {
  if (!myEl.isConnected) return null;
  let target = 0;
  for (const sibEl of otherSiblingHosts) {
    // Only order against siblings still in the DOM; a leaving node's element may be detached and would
    // compare as disconnected (and, before this node connected, every sibling mounted alongside it is
    // "disconnected" too — the case this whole function exists for).
    if (!sibEl || !sibEl.isConnected) continue;
    if (myEl.compareDocumentPosition(sibEl) & Node.DOCUMENT_POSITION_PRECEDING) target++;
  }
  return target !== currentIndex ? target : null;
}
