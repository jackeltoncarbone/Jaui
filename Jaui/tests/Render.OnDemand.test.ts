import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer, GpuTextureHandle } from '@jaui/Core/Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';

// Drill Sentences lane P1, finding 1: Apple apps draw only when something changes; an idle screen costs ~0 GPU. The
// engine's loop parks when nothing is dirty and nothing is in flight, and `FrameStats` is the number that proves it: at
// rest after the page settles, `Rendered` does not move over a window and `Parked` reads true. Reading the stats, like
// any other message that changes nothing, never draws a frame.

/** Every renderer method a tick may reach answers 0: the loop under test never touches a GPU. */
const renderer = (): Renderer => {
  const known: Record<string, unknown> = {
    Init: vi.fn(() => Promise.resolve()),
    CreateTexture: vi.fn((): GpuTextureHandle => ({} as GpuTextureHandle)),
  };
  return new Proxy(known, {
    get: (t, prop: string) => (prop in t ? t[prop] : prop === 'then' ? undefined : () => 0),
  }) as unknown as Renderer;
};

/** The engine's own rAF, pumped by hand: one call is one display frame. */
let queue: FrameRequestCallback[] = [];
let now = 0;
const frame = (): void => {
  now += 1000 / 60;
  const due = queue;
  queue = [];
  for (const cb of due) cb(now);
};
const frames = (n: number): void => { for (let i = 0; i < n; i++) frame(); };

beforeEach(() => {
  queue = [];
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => { queue.push(cb); return queue.length; });
  vi.stubGlobal('cancelAnimationFrame', (): void => {});
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A booted engine whose render walk is a counter: the loop, the gate and the park are the real ones. */
const boot = (): Canvas => {
  const c = new Canvas(new OffscreenCanvas(640, 480) as unknown as HTMLCanvasElement, renderer(), BrowserPlatform);
  const engine = c as unknown as { _render: (dt: number) => void; _framesRendered: number };
  engine._render = () => { engine._framesRendered++; };
  c.ResizeFromBridge(640, 480);
  c.Start();
  return c;
};

/** Boots, then lets the root's own entry (its presence spring, about 0.8 s) finish: the page at rest. */
const atRest = (): Canvas => {
  const c = boot();
  frames(120);
  return c;
};

describe('render on demand', () => {
  it('draws its entry, then parks: zero frames over a second at rest', () => {
    const c = atRest();
    const settled = c.FrameStats();
    expect(settled.Rendered).toBeGreaterThan(0);
    expect(settled.Parked).toBe(true);
    frames(60);
    const later = c.FrameStats();
    expect(later.Rendered).toBe(settled.Rendered);
    // Parked means NO callbacks at all, not callbacks that skip: the loop asked for none.
    expect(later.Ticks).toBe(settled.Ticks);
    expect(queue.length).toBe(0);
  });

  it('a speculative wake (any message from main) costs one tick and no frame, and parks again', () => {
    const c = atRest();
    const at = c.FrameStats();
    c.Wake();
    frames(10);
    const after = c.FrameStats();
    expect(after.Rendered).toBe(at.Rendered);
    expect(after.Ticks).toBe(at.Ticks + 1);
    expect(after.Parked).toBe(true);
  });

  it('a real change (RequestFrame) draws, with its settle tail, and parks again', () => {
    const c = atRest();
    const at = c.FrameStats();
    c.RequestFrame();
    frames(30);
    const after = c.FrameStats();
    expect(after.Rendered).toBeGreaterThan(at.Rendered);
    expect(after.Rendered - at.Rendered).toBeLessThanOrEqual(4);
    expect(after.Parked).toBe(true);
    frames(60);
    expect(c.FrameStats().Rendered).toBe(after.Rendered);
  });

  it('a layout change wakes the parked loop by itself and draws', () => {
    const c = atRest();
    const at = c.FrameStats();
    c.Root.MarkLayoutDirty();
    frames(30);
    expect(c.FrameStats().Rendered).toBeGreaterThan(at.Rendered);
    expect(c.FrameStats().Parked).toBe(true);
  });

  it('the counter is the render walk\'s own first line, so a resize\'s inline render counts too', () => {
    const src = readFileSync(resolve(__dirname, '../src/Core/Jaui.ts'), 'utf8');
    expect(src).toMatch(/private _render = \(dt: number\): void => \{\r?\n\s+this\._framesRendered\+\+;/);
  });

  it('the worker answers a stats read BEFORE waking the loop, so measuring idle never costs it a tick', () => {
    const src = readFileSync(resolve(__dirname, '../src/Worker/Bridge.Worker.ts'), 'utf8');
    const read = src.indexOf("isMessage<M2W_FrameStats>(m, 'frame-stats')");
    const wake = src.indexOf('this._canvas?.Wake();');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(wake);
  });
});
