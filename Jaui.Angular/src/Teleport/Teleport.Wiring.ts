import { DestroyRef, effect, inject } from '@angular/core';
import type { JivHandle } from 'jaui';
import { TELEPORT_REGISTRY } from './Teleport.Registry';

/**
 * Wires the two base-Jiv teleport inputs (`TeleportId`, `TeleportTo`) for a
 * component that owns a `JivHandle` — shared by `<jiv>` and Jwift's JivHost so
 * EVERY jiv is outlet-able / teleport-able. Must run in an injection context
 * (the owning component's constructor).
 *
 * Semantics:
 *  • `TeleportId` registers/unregisters the node as a named outlet.
 *  • `TeleportTo` re-parents the node: outlet present → `outlet.AddChild(node)`
 *    (a LIVE move — the engine stamps the recency elevation and the rect
 *    springs fly it); `null` → back to the natural (declaration-site) parent;
 *    outlet named but not yet registered → stays where it is and moves the
 *    moment the outlet appears (lazy slot signal).
 *  • `undefined` (input never used) issues no ops at all — plain jivs are
 *    completely unaffected.
 */
export function WireTeleportInputs(cfg: {
  Node: JivHandle;
  TeleportId: () => string | undefined;
  TeleportTo: () => string | null | undefined;
  /** The declaration-site parent (resolved lazily — it settles at ngOnInit). */
  NaturalParent: () => JivHandle | null;
}): void {
  const registry = inject(TELEPORT_REGISTRY, { optional: true });
  if (!registry) return;
  const destroyRef = inject(DestroyRef);

  // ── Outlet registration ──
  let registeredId: string | undefined;
  effect(() => {
    const id = cfg.TeleportId();
    if (id === registeredId) return;
    if (registeredId !== undefined) registry.Unregister(registeredId, cfg.Node);
    if (id !== undefined) registry.Register(id, cfg.Node);
    registeredId = id;
  });

  // ── Residency ──
  effect(() => {
    const to = cfg.TeleportTo();
    if (to === undefined) return;
    const outlet = to === null ? null : registry.Resolve(to)();
    const parent = outlet ?? cfg.NaturalParent();
    if (!parent || parent === cfg.Node.Parent) {
      registry.NotifyHome(cfg.Node, outlet ? to : null);
      return;
    }
    parent.AddChild(cfg.Node);
    registry.NotifyHome(cfg.Node, outlet ? to : null);
  });

  destroyRef.onDestroy(() => {
    if (registeredId !== undefined) registry.Unregister(registeredId, cfg.Node);
    registry.NotifyHome(cfg.Node, null);
  });
}
