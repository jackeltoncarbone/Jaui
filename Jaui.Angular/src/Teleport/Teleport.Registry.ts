import { Injectable, InjectionToken, type Signal, type WritableSignal, signal } from '@angular/core';
import type { JivHandle } from 'jaui';

/**
 * TeleportRegistry — the ID space for the teleport system, scoped per `<jaui>`
 * (provided alongside JssRegistry / SemanticMirror).
 *
 * The whole system is ID-driven on the base Jiv:
 *   • `[TeleportId]="'name'"` makes any jiv an OUTLET (a parking space — an
 *     ordinary container participating in normal layout).
 *   • `[TeleportTo]="'name'"` makes any jiv live AT that outlet: its Angular
 *     declaration site no longer determines its canvas parent — the node is
 *     parented to the outlet and MOVED between outlets as the input changes
 *     (the engine springs the rect across, so a move IS the flight).
 *     `null` re-parents it to its real (declaration-site) parent.
 *
 * Outlets are lazy: `Resolve(id)` returns a signal that fills in whenever the
 * outlet registers, so a jiv may declare `TeleportTo` before its outlet exists
 * and will fly/snap there reactively. Occupancy is tracked so hosts can derive
 * state from it (a modal host's "open" IS `OccupantCount(modalId) > 0`).
 */
@Injectable()
export class TeleportRegistry {
  private readonly _outlets = new Map<string, WritableSignal<JivHandle | null>>();
  private readonly _homes = new Map<JivHandle, string>();
  private readonly _occupants = new Map<string, WritableSignal<number>>();

  constructor() {
    // Dev probe (the __jauiSemantics precedent) — last canvas wins, dev-only use.
    (globalThis as { __jauiTeleports?: () => string[] }).__jauiTeleports =
      () => [...this._outlets.entries()].filter(([, s]) => s() !== null).map(([k]) => k);
  }

  /** Register `node` as the outlet for `id`. Last-wins; collisions warn (dev aid). */
  Register = (id: string, node: JivHandle): void => {
    const slot = this._slot(id);
    if (slot() !== null && slot() !== node) {
      console.warn(`[Jaui] TeleportId collision: '${id}' re-registered; last wins`);
    }
    slot.set(node);
  };

  /** Identity-guarded unregister — `@if` churn where a new outlet registers
   *  before the old one destroys must not tear down the new registration. */
  Unregister = (id: string, node: JivHandle): void => {
    const slot = this._outlets.get(id);
    if (slot && slot() === node) slot.set(null);
  };

  /** The outlet for `id`, as a lazy signal (null until it registers). */
  Resolve = (id: string): Signal<JivHandle | null> => this._slot(id).asReadonly();

  /** Record where a teleporting jiv currently lives (null = back at its
   *  declaration parent / destroyed). Drives `OccupantCount`. */
  NotifyHome = (node: JivHandle, id: string | null): void => {
    const prev = this._homes.get(node);
    if (prev === (id ?? undefined)) return;
    if (prev !== undefined) this._count(prev).update(n => Math.max(0, n - 1));
    if (id !== null) {
      this._homes.set(node, id);
      this._count(id).update(n => n + 1);
    } else {
      this._homes.delete(node);
    }
  };

  /** How many teleporting jivs currently live at outlet `id`. */
  OccupantCount = (id: string): Signal<number> => this._count(id).asReadonly();

  private _slot = (id: string): WritableSignal<JivHandle | null> => {
    let s = this._outlets.get(id);
    if (!s) { s = signal<JivHandle | null>(null); this._outlets.set(id, s); }
    return s;
  };

  private _count = (id: string): WritableSignal<number> => {
    let s = this._occupants.get(id);
    if (!s) { s = signal(0); this._occupants.set(id, s); }
    return s;
  };
}

export const TELEPORT_REGISTRY = new InjectionToken<TeleportRegistry>('TELEPORT_REGISTRY');
