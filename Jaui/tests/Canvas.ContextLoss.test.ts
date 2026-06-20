import { describe, it, expect, vi } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer, GpuTextureHandle } from '@jaui/Core/Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Janvas } from '@jaui/Janvas/Janvas';

// Renderer stub. `Init` is the method we assert re-runs on restore (it re-acquires the
// GL context and rebuilds shaders/FBOs/textures in the real renderer); the rest exist so
// the Canvas constructor's TextCache/ImageCache are satisfied. All `vi.fn` for spying.
function makeRenderer(initImpl: () => Promise<void> = () => Promise.resolve()): Renderer & { Init: ReturnType<typeof vi.fn> } {
  return {
    Init: vi.fn(initImpl),
    Destroy: vi.fn(),
    Resize: vi.fn(),
    CreateTexture: vi.fn((): GpuTextureHandle => ({} as GpuTextureHandle)),
    UploadSubTexture: vi.fn(),
  } as unknown as Renderer & { Init: ReturnType<typeof vi.fn> };
}

// A real OffscreenCanvas is an EventTarget; the test fake (setup.ts) extends EventTarget,
// so the engine's webglcontextlost/restored listeners attach and we can dispatch them.
function makeCanvas(): HTMLCanvasElement {
  return new OffscreenCanvas(640, 480) as unknown as HTMLCanvasElement;
}

const lostEvent = (cancelable = true): Event => new Event('webglcontextlost', { cancelable });
const restoredEvent = (): Event => new Event('webglcontextrestored');

// Drain microtasks (the restore handler's async `Init().then(...)`) WITHOUT advancing the
// 16ms rAF — so the engine's render loop never actually fires against the stub.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Canvas — WebGL context-loss recovery', () => {
  it('webglcontextlost calls preventDefault (REQUIRED for the browser to ever restore), enters lost, fires the relay', () => {
    const el = makeCanvas();
    const c = new Canvas(el, makeRenderer(), BrowserPlatform);
    const onLost = vi.fn();
    c.ContextLostRelay = onLost;
    expect(c.ContextLost).toBe(false);

    const ev = lostEvent();
    el.dispatchEvent(ev);

    // Without preventDefault the context is gone for good → permanent black until reload.
    expect(ev.defaultPrevented).toBe(true);
    expect(c.ContextLost).toBe(true);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('webglcontextrestored re-inits the renderer against the canvas, exits lost, fires the restore relay', async () => {
    const el = makeCanvas();
    const r = makeRenderer();
    const c = new Canvas(el, r, BrowserPlatform);
    const onRestored = vi.fn();
    c.ContextRestoredRelay = onRestored;

    el.dispatchEvent(lostEvent());
    expect(c.ContextLost).toBe(true);
    r.Init.mockClear();

    el.dispatchEvent(restoredEvent());
    await flush();

    expect(r.Init).toHaveBeenCalledTimes(1);
    expect(r.Init).toHaveBeenCalledWith(el);
    expect(c.ContextLost).toBe(false);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it('a restore whose re-init REJECTS stays lost (so the main-thread watchdog reloads) and does NOT fire the restore relay', async () => {
    const el = makeCanvas();
    const r = makeRenderer(() => Promise.reject(new Error('context still gone')));
    const c = new Canvas(el, r, BrowserPlatform);
    const onRestored = vi.fn();
    c.ContextRestoredRelay = onRestored;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // swallow the expected log

    el.dispatchEvent(lostEvent());
    el.dispatchEvent(restoredEvent());
    await flush();

    expect(c.ContextLost).toBe(true);
    expect(onRestored).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a non-cancelable lost event still enters lost (preventDefault is a no-op, but we must still recover)', () => {
    const el = makeCanvas();
    const c = new Canvas(el, makeRenderer(), BrowserPlatform);
    expect(() => el.dispatchEvent(lostEvent(false))).not.toThrow();
    expect(c.ContextLost).toBe(true);
  });

  it('survives repeated lost → restored cycles, re-initing each time', async () => {
    const el = makeCanvas();
    const r = makeRenderer();
    const c = new Canvas(el, r, BrowserPlatform);

    for (let i = 0; i < 3; i++) {
      el.dispatchEvent(lostEvent());
      expect(c.ContextLost).toBe(true);
      r.Init.mockClear();
      el.dispatchEvent(restoredEvent());
      await flush();
      expect(r.Init).toHaveBeenCalledTimes(1);
      expect(c.ContextLost).toBe(false);
    }
  });

  it('a restore with no prior loss does not throw and leaves the context healthy', async () => {
    const el = makeCanvas();
    const r = makeRenderer();
    const c = new Canvas(el, r, BrowserPlatform);
    r.Init.mockClear();
    expect(() => el.dispatchEvent(restoredEvent())).not.toThrow();
    await flush();
    expect(c.ContextLost).toBe(false);
  });

  it('flags 3D <janvas> renderers for re-Init on restore (their GPU resources die too)', async () => {
    const el = makeCanvas();
    const c = new Canvas(el, makeRenderer(), BrowserPlatform);
    // A janvas that has already inited against the (now-lost) context.
    const janvas = new Janvas();
    c.Root.AddChild(janvas);
    janvas.MarkInited();
    expect(janvas.IsInited()).toBe(true);

    el.dispatchEvent(lostEvent());
    el.dispatchEvent(restoredEvent());
    await flush();

    // Reset → the render loop re-runs Renderer.Init(gl, …) against the restored context.
    expect(janvas.IsInited()).toBe(false);
    expect(c.ContextLost).toBe(false);
  });

  it('recovery works with NO relays set (the watchdog hooks are optional)', async () => {
    const el = makeCanvas();
    const r = makeRenderer();
    const c = new Canvas(el, r, BrowserPlatform);

    el.dispatchEvent(lostEvent());
    expect(c.ContextLost).toBe(true);
    r.Init.mockClear();
    el.dispatchEvent(restoredEvent());
    await flush();

    expect(c.ContextLost).toBe(false);
    expect(r.Init).toHaveBeenCalledTimes(1);
  });
});
