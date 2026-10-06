import { describe, expect, it, vi } from 'vitest';
import { Jiv as JivCore } from '../src/Jiv/Jiv';
import { JivRegistry } from '../src/Worker/Jiv.Registry';
import type { JivOp } from '../src/Worker/Bridge.Types';

/**
 * `Bridge.Main.ts`'s own `_flushOps` doc comment: "One postMessage per CD batch" — every op a single
 * Angular change-detection pass enqueues lands in ONE `jiv-ops` message, applied by `ApplyOps`'s plain
 * loop over `msg.Ops`. Before this fix that loop had no try/catch at all: one op throwing partway through
 * (any handler, any edge case its own per-handler `if (!core) { warn; return }` guards did not
 * anticipate) propagated out of `ApplyOps` and silently abandoned every op AFTER it in the SAME batch —
 * including a `leave` for a piece with no relation at all to whatever threw. A drastic re-render (many
 * `<token-sentence>` pieces created, updated and removed in one Angular change-detection pass —
 * `TokenSentence.Piece.Leave.test.ts`'s own motivating bug) is exactly the shape of batch where this
 * costs the most: one bad op anywhere in it could leave an unrelated stale piece's own `leave` op never
 * applied, so it never fades, never gets swept, and nothing short of a reload ever paints over it.
 *
 * This stubs the registry's own (private) per-op dispatch to throw for one specific op, standing in for
 * whatever future handler bug would throw instead of warning — the resilience under test does not care
 * WHY an op throws, only that one throwing must never cost its neighbours in the same batch.
 */
describe('JivRegistry.ApplyOps — one bad op in a batch never costs the rest of the batch', () => {
  it('SEES the fault it is named for: an op that threw used to silently drop every op after it in the same postMessage', () => {
    const root = new JivCore({});
    const registry = new JivRegistry(root, () => {});
    registry.ApplyOps({
      T: 'jiv-ops',
      Ops: [{ K: 'create', Id: 1, Opts: {} }, { K: 'attach', ChildId: 1, ParentId: 0 }],
    });
    const node1 = registry.Get(1)!;
    expect(node1.Parent, 'precondition: node 1 is attached under root').toBe(root);
    expect(node1.LeaveRequested, 'precondition: not yet asked to leave').toBe(false);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registryAny = registry as unknown as { _apply: (op: JivOp) => void };
    const realApply = registryAny._apply.bind(registry);
    registryAny._apply = (op: JivOp): void => {
      if (op.K === 'watch-rect') throw new Error('simulated handler bug');
      realApply(op);
    };

    // The throwing op is FIRST in the batch -- before the fix, this alone would have swallowed the
    // `leave` right after it, which has nothing to do with node 1's watch-rect subscription at all.
    registry.ApplyOps({
      T: 'jiv-ops',
      Ops: [{ K: 'watch-rect', Id: 1, Watch: true }, { K: 'leave', Id: 1 }],
    });

    expect(node1.LeaveRequested, 'the leave op after the throwing one still reached the worker tree').toBe(true);
    expect(errorSpy, 'the throw is logged, not silently eaten').toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('every op still applies in order when none of them throw (the ordinary, unaffected path)', () => {
    const root = new JivCore({});
    const registry = new JivRegistry(root, () => {});
    registry.ApplyOps({
      T: 'jiv-ops',
      Ops: [
        { K: 'create', Id: 1, Opts: {} },
        { K: 'create', Id: 2, Opts: {} },
        { K: 'attach', ChildId: 1, ParentId: 0 },
        { K: 'attach', ChildId: 2, ParentId: 0 },
        { K: 'leave', Id: 1 },
      ],
    });
    expect(registry.Get(1)!.LeaveRequested).toBe(true);
    expect(registry.Get(2)!.LeaveRequested).toBe(false);
    expect(root.Children).toContain(registry.Get(1)!);
    expect(root.Children).toContain(registry.Get(2)!);
  });
});
