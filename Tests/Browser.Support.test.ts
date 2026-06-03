import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CheckBrowserSupport } from '@jaui/Worker/Browser.Support';

// We toggle globals to simulate unsupported environments. Each test
// snapshots and restores the relevant globals so they don't leak.

const _save = (key: string): { restore: () => void } => {
  const had = key in (globalThis as Record<string, unknown>);
  const original = (globalThis as Record<string, unknown>)[key];
  return {
    restore: () => {
      if (had) (globalThis as Record<string, unknown>)[key] = original;
      else delete (globalThis as Record<string, unknown>)[key];
    },
  };
};

describe('CheckBrowserSupport', () => {
  it('returns Supported=true when all features are present', () => {
    // Setup: provide the canvas + transferControlToOffscreen the gate looks for.
    const canvasSave = _save('HTMLCanvasElement');
    const wglSave = _save('WebGL2RenderingContext');
    const workerSave = _save('Worker');
    try {
      class FakeHTMLCanvasElement {}
      (FakeHTMLCanvasElement.prototype as unknown as { transferControlToOffscreen: () => unknown })
        .transferControlToOffscreen = () => ({});
      (globalThis as Record<string, unknown>).HTMLCanvasElement = FakeHTMLCanvasElement;
      (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
      (globalThis as Record<string, unknown>).Worker = class {};
      // OffscreenCanvas is provided by tests/setup.ts polyfill.
      const r = CheckBrowserSupport();
      expect(r.Supported).toBe(true);
    } finally {
      canvasSave.restore();
      wglSave.restore();
      workerSave.restore();
    }
  });

  it('reports OffscreenCanvas missing when polyfill is gone', () => {
    const ocSave = _save('OffscreenCanvas');
    try {
      delete (globalThis as Record<string, unknown>).OffscreenCanvas;
      const r = CheckBrowserSupport();
      expect(r.Supported).toBe(false);
      expect(r.Reason).toContain('OffscreenCanvas');
    } finally {
      ocSave.restore();
    }
  });

  it('reports Worker missing when undefined', () => {
    const workerSave = _save('Worker');
    const canvasSave = _save('HTMLCanvasElement');
    const wglSave = _save('WebGL2RenderingContext');
    try {
      class FakeHTMLCanvasElement {}
      (FakeHTMLCanvasElement.prototype as unknown as { transferControlToOffscreen: () => unknown })
        .transferControlToOffscreen = () => ({});
      (globalThis as Record<string, unknown>).HTMLCanvasElement = FakeHTMLCanvasElement;
      (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
      delete (globalThis as Record<string, unknown>).Worker;
      const r = CheckBrowserSupport();
      expect(r.Supported).toBe(false);
      expect(r.Reason).toContain('Worker');
    } finally {
      workerSave.restore();
      canvasSave.restore();
      wglSave.restore();
    }
  });

  it('reports transferControlToOffscreen missing on HTMLCanvasElement', () => {
    const canvasSave = _save('HTMLCanvasElement');
    const wglSave = _save('WebGL2RenderingContext');
    const workerSave = _save('Worker');
    try {
      // HTMLCanvasElement exists but lacks transferControlToOffscreen.
      class FakeOldCanvas {}
      (globalThis as Record<string, unknown>).HTMLCanvasElement = FakeOldCanvas;
      (globalThis as Record<string, unknown>).WebGL2RenderingContext = class {};
      (globalThis as Record<string, unknown>).Worker = class {};
      const r = CheckBrowserSupport();
      expect(r.Supported).toBe(false);
      expect(r.Reason).toContain('transferControlToOffscreen');
    } finally {
      canvasSave.restore();
      wglSave.restore();
      workerSave.restore();
    }
  });

  it('reports WebGL2 missing when undefined', () => {
    const canvasSave = _save('HTMLCanvasElement');
    const wglSave = _save('WebGL2RenderingContext');
    const workerSave = _save('Worker');
    try {
      class FakeHTMLCanvasElement {}
      (FakeHTMLCanvasElement.prototype as unknown as { transferControlToOffscreen: () => unknown })
        .transferControlToOffscreen = () => ({});
      (globalThis as Record<string, unknown>).HTMLCanvasElement = FakeHTMLCanvasElement;
      delete (globalThis as Record<string, unknown>).WebGL2RenderingContext;
      (globalThis as Record<string, unknown>).Worker = class {};
      const r = CheckBrowserSupport();
      expect(r.Supported).toBe(false);
      expect(r.Reason).toContain('WebGL2');
    } finally {
      canvasSave.restore();
      wglSave.restore();
      workerSave.restore();
    }
  });
});
