import { describe, expect, it } from 'vitest';
import { Jiv as JivCore } from '../src/Jiv/Jiv';
import { JivHandle } from '../src/Worker/Jiv.Handle';
import { JivRegistry } from '../src/Worker/Jiv.Registry';
import type { MainBridge } from '../src/Worker/Bridge.Main';
import type { JivOp } from '../src/Worker/Bridge.Types';

/**
 * SS-Support-FAQ-2: `RemoveChild` on the main-thread `JivHandle` mirror updated only its own `Children`/
 * `Parent` bookkeeping and told the WORKER nothing — there was no op for "unparent, don't destroy" at
 * all (`AddChild` sends `attach`, which the worker's own `AddChild` already reparents correctly FROM;
 * `leave`/`destroy` both end the node's life entirely). A caller that removes a child with no replacement
 * parent (disclosure-row's `SyncSlotParent`, syncing a closed body to "no box" so it isn't laid out) left
 * the WORKER's tree believing the old parent still owned it forever — every answer stayed visible,
 * attached wherever it first mounted, regardless of `open()`.
 *
 * This wires a real `JivHandle` (main) to a real `JivRegistry` (worker) through a fake bridge that feeds
 * every enqueued op straight into the registry — no postMessage, no Worker, same spirit as
 * `Jiv.Handle.Apply.test.ts`'s fake bridge and `Canvas.Teleport.test.ts`'s direct `JivRegistry` use — so
 * the test can assert on the WORKER's own tree (`JivRegistry.Get(id).Children`), not just the main-thread
 * mirror the old bug's blind spot was.
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
  // Id 0 is the registry's own root (set in its constructor, needs no `create` op) — a JivHandle mirror
  // for it lets a test attach under Root through the same handle-level API as everything else, so setup
  // never bypasses the main↔worker wiring under test by poking `JivCore`s directly.
  const Root = new JivHandle(bridge, 0);
  const MakeNode = (): JivHandle => {
    const id = nextId++;
    const node = new JivHandle(bridge, id);
    bridge.Enqueue({ K: 'create', Id: id, Opts: {} });
    return node;
  };
  return { Registry: registry, Root, MakeNode };
}

describe('JivHandle.RemoveChild — detaching reaches the worker, not just the main mirror', () => {
  it('SEES the fault it is named for: before the fix, the worker kept the child under its old parent forever', () => {
    const { Registry, MakeNode } = wireWorld();
    const list = MakeNode();      // stands in for the <list> a disclosure-row's content wrongly ambient-attached to
    const content = MakeNode();   // stands in for a closed FAQ answer
    list.AddChild(content);

    const listCore = Registry.Get(list.Id)!;
    const contentCore = Registry.Get(content.Id)!;
    expect(listCore.Children, 'precondition: attached').toContain(contentCore);

    list.RemoveChild(content); // SyncSlotParent's "no box" branch: detach, don't destroy

    // Main-thread mirror — this half always worked.
    expect(content.Parent, 'main mirror: no parent').toBeNull();
    expect(list.Children, 'main mirror: list no longer lists it').not.toContain(content);

    // The worker's OWN tree — this is the half that silently never happened before the `detach` op
    // existed. Without it, `listCore.Children` STILL contains `contentCore` here, which is exactly why
    // every closed FAQ answer kept rendering: the worker paints from ITS tree, not the main mirror.
    expect(listCore.Children, 'worker: detached, not left under the old parent').not.toContain(contentCore);
    expect(contentCore.Parent, 'worker: unparented').toBeNull();
  });

  it('a detached node is unreachable from Root — not laid out, not merely hidden', () => {
    const { Registry, Root, MakeNode } = wireWorld();
    const box = MakeNode();
    const content = MakeNode();
    Root.AddChild(box);
    box.AddChild(content);
    box.RemoveChild(content);

    const rootCore = Registry.Get(0)!;
    const contentCore = Registry.Get(content.Id)!;
    expect(contentCore.Parent).toBeNull();
    // Walk every node reachable from Root; a detached node must not appear anywhere in it.
    const reachable = new Set<unknown>();
    const stack = [rootCore];
    while (stack.length) {
      const n = stack.pop()!;
      if (reachable.has(n)) continue;
      reachable.add(n);
      for (const c of n.Children) stack.push(c);
    }
    expect(reachable.has(contentCore)).toBe(false);
  });

  it('reattaching after a detach works on the worker too — AddChild always reassigns cleanly', () => {
    const { Registry, MakeNode } = wireWorld();
    const list = MakeNode();
    const headBox = MakeNode();
    const content = MakeNode();
    list.AddChild(content);
    list.RemoveChild(content); // closed: detached

    headBox.AddChild(content); // opened: attach to the real box

    const headBoxCore = Registry.Get(headBox.Id)!;
    const listCore = Registry.Get(list.Id)!;
    const contentCore = Registry.Get(content.Id)!;
    expect(headBoxCore.Children, 'worker: now under the head/body box').toContain(contentCore);
    expect(listCore.Children, 'worker: no longer under the list').not.toContain(contentCore);
  });
});
