import { describe, it, expect, vi } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { JivRegistry } from '../src/Worker/Jiv.Registry';
import { RegisterJanvasRenderer } from '../src/Worker/Worker.RendererRegistry';
import type { Janvas } from '../src/Janvas/Janvas';
import type { JanvasRenderer } from '../src/Janvas/Janvas.Renderer';
import type { M2W_JivOps } from '../src/Worker/Bridge.Types';

// AN ASYNC JANVAS FACTORY (a consumer `import()`s a heavy renderer so three.js stays out of the render
// worker's bundle). The window between attach and resolve is the state an unregistered key already
// has -- a rect with no renderer -- and the one thing that is new is what happens if the node goes
// away while the import is in flight. The Mac lane that added this guarded it by reasoning; these pin
// it, including the renderer that resolves for a node nobody will ever render or dispose again.

const apply = (reg: JivRegistry, ops: M2W_JivOps['Ops']): void => reg.ApplyOps({ T: 'jiv-ops', Ops: ops });

const fakeRenderer = (): JanvasRenderer & { Dispose: ReturnType<typeof vi.fn> } =>
  ({ Init: vi.fn(), Render: vi.fn(), Dispose: vi.fn() }) as unknown as JanvasRenderer & { Dispose: ReturnType<typeof vi.fn> };

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('Janvas — an async factory', () => {
  it('wires the renderer when the import resolves, and not before', async () => {
    const pending = deferred<JanvasRenderer>();
    RegisterJanvasRenderer('test-async-wire', () => pending.promise);
    const reg = new JivRegistry(new Jiv({ Width: 400, Height: 300 }), () => {});
    apply(reg, [{ K: 'janvas-attach', Id: 7, Key: 'test-async-wire' }]);
    const janvas = reg.Get(7) as Janvas;
    expect(janvas).toBeDefined();
    expect(janvas.Renderer).toBeNull();

    const r = fakeRenderer();
    pending.resolve(r);
    await flush();
    expect(janvas.Renderer).toBe(r);
    expect(r.Dispose).not.toHaveBeenCalled();
  });

  it('a node destroyed mid-import never gets the renderer, and the renderer is disposed', async () => {
    const pending = deferred<JanvasRenderer>();
    RegisterJanvasRenderer('test-async-unmount', () => pending.promise);
    const reg = new JivRegistry(new Jiv({ Width: 400, Height: 300 }), () => {});
    apply(reg, [{ K: 'janvas-attach', Id: 8, Key: 'test-async-unmount' }]);
    const janvas = reg.Get(8) as Janvas;
    apply(reg, [{ K: 'destroy', Id: 8 }]);
    expect(reg.Get(8)).toBeUndefined();

    const r = fakeRenderer();
    pending.resolve(r);
    await flush();
    expect(janvas.Renderer).toBeNull();
    expect(r.Dispose).toHaveBeenCalledTimes(1);
  });

  it('a synchronous factory still wires on the spot', () => {
    const r = fakeRenderer();
    RegisterJanvasRenderer('test-sync', () => r);
    const reg = new JivRegistry(new Jiv({ Width: 400, Height: 300 }), () => {});
    apply(reg, [{ K: 'janvas-attach', Id: 9, Key: 'test-sync' }]);
    expect((reg.Get(9) as Janvas).Renderer).toBe(r);
  });
});
