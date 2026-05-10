/**
 * Worker.RendererRegistry — worker-side directory of `JanvasRenderer`
 * factories, keyed by string. Show-studio's worker entry registers
 * factories at boot; the bridge's `janvas-attach` handler looks up a
 * factory by key and constructs a renderer for the target Jiv.
 *
 * Why a registry instead of class names: factories close over worker-side
 * services (Reality, Drill, Cache) that exist as singletons in the worker
 * scope. The registration call binds those services into the factory once,
 * so subsequent attaches stay cheap and stateless.
 *
 * Lives in worker scope only — main-thread imports are inert (factories
 * never get registered there). Safe to import from either side.
 */

import type { JanvasRenderer, JanvasFactoryContext } from '../Janvas/Janvas.Renderer';

/** Constructor signature for a registered renderer. `Config` is whatever
 *  the consumer passed via `<janvas [config]="...">`; the factory decides
 *  how to interpret it (typically narrows from `unknown` to a typed shape
 *  it owns). `Ctx` is bridge-instance plumbing — most importantly
 *  `PostEvent`, which lets the renderer surface state changes back to its
 *  main-side counterpart. Returns the renderer instance Jaui will Init/Render. */
export type JanvasRendererFactory = (config: unknown, ctx: JanvasFactoryContext) => JanvasRenderer;

const _registry = new Map<string, JanvasRendererFactory>();

/** Register a renderer factory under `key`. Idempotent — re-registering
 *  the same key replaces the previous factory (handy for HMR). Called
 *  during worker boot, before any `janvas-attach` op can arrive. */
export const RegisterJanvasRenderer = (
  key: string,
  factory: JanvasRendererFactory,
): void => {
  _registry.set(key, factory);
};

/** Look up a previously-registered factory. Returns null if no factory
 *  matches — the caller logs and skips the attach so the rest of the
 *  scene still renders (a misconfigured Janvas shouldn't black out the
 *  whole UI). */
export const LookupJanvasRenderer = (
  key: string,
): JanvasRendererFactory | null => {
  return _registry.get(key) ?? null;
};

/** Test helper — clear all registrations. Production code shouldn't
 *  call this; included so unit tests can isolate registration state. */
export const _ResetJanvasRegistry = (): void => {
  _registry.clear();
};
