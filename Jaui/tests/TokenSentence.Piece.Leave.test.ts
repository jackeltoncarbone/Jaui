import { describe, expect, it } from 'vitest';
import { Jiv as JivCore } from '../src/Jiv/Jiv';
import { JivHandle } from '../src/Worker/Jiv.Handle';
import { JivRegistry } from '../src/Worker/Jiv.Registry';
import { PresenceManager } from '../src/Animation/Presence.Manager';
import type { MainBridge } from '../src/Worker/Bridge.Main';
import type { JivOp } from '../src/Worker/Bridge.Types';

/**
 * Drill Sentences blind-phone bug (56-after-drag-settle.png): dragging squad 9a on the field rewrites
 * that line's steps, which rewrites `<token-sentence>`'s own `Tokens()` input wholesale — a
 * DIFFERENT-LENGTH list of pieces, not an in-place edit. The list showed garbled, overlapping old-and-new
 * text that never cleared, even after reselecting the phrase — only a reload recovered it.
 *
 * `TokenSentence.ts` keys each rendered text piece by `TextPieceKeys` (Jwift.Angular's own
 * `TokenSentence.Layout.ts`): `${token.Key}:${row}#${ordinal among that token's own pieces}`. A piece
 * whose key no longer exists in the new list is torn down the ordinary Jiv way — Angular's `ngOnDestroy`
 * calls `Node.RequestLeave()`, a SOFT fade (`Element.RequestLeave`'s own doc comment: "the engine walks
 * the tree each frame and hard-removes the element from its parent once the spring settles"), never a
 * raw `RemoveChild`. This exercises exactly that path end to end, through a real `JivHandle` (main) wired
 * to a real `JivRegistry` (worker) via a fake bridge — the same technique `Jiv.Handle.Detach.test.ts` uses
 * for the sibling bug (a plain `detach`, not a presence fade) — plus a real `PresenceManager` to settle
 * the fade, so the assertion reaches the WORKER's own tree (`JivRegistry.Get(id).Children`), not just the
 * main-thread mirror a shallower test could be fooled by (the exact blind spot `Jiv.Handle.Detach.test.ts`
 * was written to close for `RemoveChild`; this is its `RequestLeave` counterpart).
 *
 * `pieceKeys`/`render` below reproduce `TextPieceKeys`'s own ordinal scheme and `@for`'s own three-way
 * keyed reconciliation (drop a key no longer present, create a key seen for the first time, leave a
 * shared key's own node untouched) rather than importing them — Jaui core never reaches INTO a consumer
 * package (this repo's own "dependencies flow inward only" rule, Jaui's CLAUDE.md), and `TextPieceKeys`
 * itself is already covered, in isolation, by `TokenSentence.Layout.spec.ts` (ShowStudio.App).
 */
function wireWorld(): { Registry: JivRegistry; Root: JivHandle; MakeNode: () => JivHandle } {
  const root = new JivCore({});
  const registry = new JivRegistry(root, () => {});
  let nextId = 1;
  const bridge = {
    Enqueue: (op: JivOp) => registry.ApplyOps({ T: 'jiv-ops', Ops: [op] }),
    SetHitHandlers: () => {},
    ClearHitHandlers: () => {},
  } as unknown as MainBridge;
  const Root = new JivHandle(bridge, 0);
  const MakeNode = (): JivHandle => {
    const id = nextId++;
    const node = new JivHandle(bridge, id);
    bridge.Enqueue({ K: 'create', Id: id, Opts: {} });
    return node;
  };
  return { Registry: registry, Root, MakeNode };
}

/** `TextPieceKeys`'s own scheme: an ordinal per token among its own pieces, one piece per token here (a
 *  real sentence can split one token into several — irrelevant to this test, which is about a token
 *  DISAPPEARING outright, not about how many pieces one token happens to produce). */
function pieceKeys(tokenKeys: readonly string[]): readonly string[] {
  const ordinal = new Map<string, number>();
  return tokenKeys.map((key) => {
    const n = ordinal.get(key) ?? 0;
    ordinal.set(key, n + 1);
    return `${key}:0#${n}`;
  });
}

/** One render pass of `<token-sentence>`'s own `@for (t of _textPieces(); track t.Key)`: a key no longer
 *  in `nextKeys` is `RequestLeave`d (Angular's own `ngOnDestroy`) and dropped from the mounted map; a key
 *  seen for the first time is created and attached; a key present in both is left exactly alone — the
 *  SAME view, same node, just its bindings updated (nothing this test needs to model, since identity is
 *  all it is asserting). */
function render(
  sentence: JivHandle, mounted: Map<string, JivHandle>, nextKeys: readonly string[], make: () => JivHandle,
  everCreated?: Map<string, JivHandle>,
): void {
  const next = new Set(nextKeys);
  for (const [key, node] of [...mounted]) {
    if (next.has(key)) continue;
    node.RequestLeave();
    mounted.delete(key);
  }
  for (const key of nextKeys) {
    if (mounted.has(key)) continue;
    const node = make();
    sentence.AddChild(node);
    mounted.set(key, node);
    everCreated?.set(key, node);
  }
}

describe('TokenSentence piece lifecycle: a token-list shape change leaves no stale piece behind', () => {
  it('a different-length token list settles to EXACTLY the new piece set — nothing old survives, in the WORKER\'s own tree', () => {
    const { Registry, Root, MakeNode } = wireWorld();
    const sentence = MakeNode();
    Root.AddChild(sentence);
    const mounted = new Map<string, JivHandle>();
    const everCreated = new Map<string, JivHandle>();
    const sentenceCore = Registry.Get(sentence.Id)!;

    // "9a <-> 9b: left face, then march forward 9 counts, then right flank 8 counts" -- a real multi-clause
    // follow sentence, many tokens, NONE of which survive the rewrite below (every one is Drag.Replan's
    // own "forward"/"9 counts"/etc, not structurally reused by the shorter sentence that replaces it).
    const before = pieceKeys([
      'who', 'sp0', 'lead', 'sp1', 'verb0', 'sp2', 'n0', 'sp3', 'then0', 'sp4', 'verb1', 'sp5', 'n1',
    ]);
    render(sentence, mounted, before, MakeNode, everCreated);
    expect(sentenceCore.Children.length, 'precondition: every old piece mounted').toBe(before.length);

    // Drag-with-reach rewrites the line's steps entirely: a SHORTER, different sentence -- "9a <-> 9b: mark
    // time 4 counts". `who` is the one key a real rewrite plausibly DOES keep (the leader token, same
    // squad) -- kept here too, so this also proves a SHARED key is reused in place, not duplicated.
    const after = pieceKeys(['who', 'verb2', 'sp6', 'n2']);
    render(sentence, mounted, after, MakeNode, everCreated);

    // Mid-fade, the instant after the swap: the leaving pieces are STILL attached (their presence spring
    // hasn't stepped toward 0 yet) -- a reload-only bug is exactly this frame, forever. `before.length - 1`
    // leave (every key but the shared `who`); `after.length - 1` are freshly created (every key but `who`).
    const leaving = before.length - 1;
    const created = after.length - 1;
    expect(sentenceCore.Children.length, 'mid-fade: old AND new pieces both present for one frame').toBe(before.length + created);
    expect(leaving, 'sanity: this scenario actually exercises leaving pieces').toBeGreaterThan(0);

    // One oversized step settles every spring (PresenceSpring(0, 220, 26) -- Spring.ts's own analytic
    // step is exact for any `dt`, so a single large one reaches full settle with no need to tick repeatedly).
    new PresenceManager(Registry.Get(0)!).Tick(10);

    expect(sentenceCore.Children.length, 'settled: the worker\'s own tree holds ONLY the new piece set').toBe(after.length);
    const survivingCores = new Set(sentenceCore.Children);
    for (const [key, node] of mounted) {
      expect(after.includes(key), `"${key}" is a surviving mount but not in the new piece set`).toBe(true);
      expect(survivingCores.has(Registry.Get(node.Id)!), `"${key}"'s own core is in the worker's tree`).toBe(true);
    }

    // And the inverse, the actual bug: no DROPPED key's own core lingers anywhere reachable from Root --
    // not under `sentence`, not orphaned-but-still-painting under some other parent. Walk the WHOLE tree
    // (not just `sentence`'s own direct Children) the same way `Jiv.Handle.Detach.test.ts`'s own
    // "unreachable from Root" case does.
    const reachable = new Set<unknown>();
    const stack = [Registry.Get(0)!];
    while (stack.length) {
      const n = stack.pop()!;
      if (reachable.has(n)) continue;
      reachable.add(n);
      for (const c of n.Children) stack.push(c);
    }
    for (const [key, node] of everCreated) {
      if (after.includes(key)) continue; // still current -- expected to be reachable, not what this checks.
      const core = Registry.Get(node.Id)!;
      expect(reachable.has(core), `"${key}" left the token list but its own core is still reachable from Root`).toBe(false);
      expect(core.Parent, `"${key}"'s own core still has a parent after settling`).toBeNull();
    }
  });
});
