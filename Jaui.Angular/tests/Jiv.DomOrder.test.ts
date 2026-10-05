import { describe, expect, it } from 'vitest';
import { DomReorderTarget } from '../src/Jiv/Jiv.DomOrder';

/**
 * SS-Support-FAQ: expanding "Which browsers are supported?" on /support read its answer with every word in
 * reverse order ("versions. older on simpler look may and support browser..." instead of "Recent versions
 * of Chrome..."). The FAQ answer renders through `ProseBlock`, which gives each WORD its own `<jext>` inside
 * a flex-wrap row (`Surface/Blocks/ProseBlock.ts`), and that row is projected into `disclosure-row`'s body —
 * a slot gated behind `@if (open())` (`Jwift.Angular/src/DisclosureRow/DisclosureRow.ts`). Angular
 * constructs projected content whether or not the outlet that would show it is live (the same fact
 * `Avatar.Slot.spec.ts` pins for the avatar's own fallback template), so every word's `<jiv>`/`<jext>`
 * mounts — and calls `_reorderToDomPosition` — while the FAQ is still closed and its whole answer subtree is
 * disconnected from the document. `DomReorderTarget` is the pure math `_reorderToDomPosition` delegates to;
 * these are jsdom elements wired up exactly the way `Jiv.ts` feeds it (`Jiv.ts:259`), with no Angular
 * runtime needed — `Jiv.Link.test.ts` tests `Jiv.Link.ts` the same way, for the same reason.
 */
describe('DomReorderTarget', () => {
  /** Mounts `words.length` elements one at a time under `parent` (or leaves `parent` null to mount them
   *  detached — the FAQ-answer-behind-a-closed-disclosure case), driving them through the exact protocol
   *  `Jiv.ngOnInit` → `_reorderToDomPosition` follows: `AddChild` (plain append) first, then ask
   *  `DomReorderTarget` where this one belongs, then splice it there if it said to move. Returns the final
   *  order as an array of labels. */
  const mountSequentially = (words: readonly string[], parent: HTMLElement | null): string[] => {
    const host = parent ?? document.createElement('div'); // a DETACHED parent when `parent` is null
    const children: HTMLElement[] = [];
    for (const word of words) {
      const el = document.createElement('jext');
      el.textContent = word;
      host.appendChild(el); // Angular inserts the real DOM node as part of creating the view
      children.push(el); // AddChild: plain push
      const current = children.indexOf(el);
      const otherHosts = children.filter((c) => c !== el);
      const target = DomReorderTarget(el, otherHosts, current);
      if (target !== null) {
        children.splice(current, 1);
        children.splice(target, 0, el);
      }
    }
    return children.map((c) => c.textContent!);
  };

  const WORDS = ['Recent', 'versions', 'of', 'Chrome,', 'Edge,', 'Safari,', 'and', 'Firefox.'];

  it('leaves a normal, connected, sequential mount in template order (the common case: a no-op)', () => {
    const live = document.body.appendChild(document.createElement('div'));
    expect(mountSequentially(WORDS, live)).toEqual(WORDS);
  });

  it('SEES the fault it is named for: mounting disconnected (a closed disclosure\'s projected answer) used to reverse the whole run', () => {
    // `parent: null` → every element mounts under a DETACHED container, exactly as every word of
    // `ProseBlock`'s answer does while `disclosure-row`'s `@if (open())` is still false. Before the
    // `myEl.isConnected` guard, `DomReorderTarget` (then inline in `_reorderToDomPosition`) found zero
    // CONNECTED preceding siblings for every word — because every sibling mounted alongside it was ALSO
    // disconnected — read that as "I am first", and moved each one to index 0 as it mounted. This asserts
    // the fix holds: the answer reads front to back, not back to front.
    expect(mountSequentially(WORDS, null)).toEqual(WORDS);
  });

  it('is robust to the mount order being shuffled, not just forward — DOM order is still the ground truth once connected', () => {
    const live = document.body.appendChild(document.createElement('div'));
    const els = WORDS.map((w) => {
      const el = document.createElement('jext');
      el.textContent = w;
      live.appendChild(el); // real DOM order is authored order, regardless of reorder-check timing
      return el;
    });
    let children: HTMLElement[] = [];
    const shuffled = [...els].sort(() => Math.random() - 0.5);
    for (const el of shuffled) {
      children.push(el);
      const current = children.indexOf(el);
      const otherHosts = children.filter((c) => c !== el);
      const target = DomReorderTarget(el, otherHosts, current);
      if (target !== null) {
        children.splice(current, 1);
        children.splice(target, 0, el);
      }
    }
    expect(children.map((c) => c.textContent)).toEqual(WORDS);
  });

  it('still catches the documented case: a node that mounts late, after connected static siblings, moves to its real DOM slot', () => {
    const parent = document.body.appendChild(document.createElement('div'));
    const a = document.createElement('jext'); a.textContent = 'a'; parent.appendChild(a);
    const c = document.createElement('jext'); c.textContent = 'c'; parent.appendChild(c);
    // `b` sits between `a` and `c` in the DOM (an `@if` that just flipped true), but mounts (AddChild
    // appends) AFTER both of them attached — the scenario `_reorderToDomPosition` was written for.
    const b = document.createElement('jext'); b.textContent = 'b';
    parent.insertBefore(b, c);

    const children = [a, c, b]; // AddChild's append order: a, then c, then b (arrival order)
    const current = children.indexOf(b);
    const target = DomReorderTarget(b, [a, c], current);
    expect(target, 'b has one connected preceding sibling (a), so it belongs at index 1').toBe(1);
    children.splice(current, 1);
    children.splice(target!, 0, b);
    expect(children.map((c2) => c2.textContent)).toEqual(['a', 'b', 'c']);
  });

  it('returns null (no move) when already at the right index, so a statically-ordered child never posts a move op', () => {
    const parent = document.body.appendChild(document.createElement('div'));
    const a = document.createElement('jext'); parent.appendChild(a);
    const b = document.createElement('jext'); parent.appendChild(b);
    expect(DomReorderTarget(b, [a], 1)).toBeNull();
  });

  it('ignores a disconnected sibling (one that is leaving) when counting preceding nodes', () => {
    const parent = document.body.appendChild(document.createElement('div'));
    const leaving = document.createElement('jext'); // detached — e.g. mid fade-out, element already removed
    const a = document.createElement('jext'); parent.appendChild(a);
    const b = document.createElement('jext'); parent.appendChild(b);
    // `leaving` is first in the Children array (it mounted first) but its element is gone from the DOM.
    expect(DomReorderTarget(b, [leaving, a], 2)).toBe(1);
  });
});
