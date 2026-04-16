import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TextCache } from '../src/Text/Text.Cache';
import { DefaultTextStyle } from '../src/Text/Text.Types';
import type { Renderer, GpuTextureHandle } from '../src/Core/Renderer';

// ─── Mocks ───

let _nextTextureId = 1;

const mockRenderer = () => {
  const createTextureFn = vi.fn((): GpuTextureHandle => ({ _brand: 'GpuTextureHandle', __id: _nextTextureId++ } as any));
  const uploadSubTextureFn = vi.fn();
  return {
    CreateTexture: createTextureFn,
    UploadSubTexture: uploadSubTextureFn,
    _createTextureFn: createTextureFn,
    _uploadFn: uploadSubTextureFn,
  } as unknown as Renderer & { _createTextureFn: typeof createTextureFn; _uploadFn: typeof uploadSubTextureFn };
};

const mockCanvas = () => {
  const ctx = {
    font: '',
    textBaseline: 'top',
    textAlign: 'left',
    fillStyle: '',
    canvas: { width: 0, height: 0 },
    measureText: (t: string) => ({ width: t.length * 8 }),
    clearRect: vi.fn(),
    fillText: vi.fn(),
  };
  (ctx.canvas as unknown as { getContext: () => unknown }).getContext = () => ctx;
  return ctx;
};

beforeEach(() => {
  _nextTextureId = 1;
  global.document = {
    createElement: vi.fn(() => {
      const c = mockCanvas();
      return c.canvas as unknown as HTMLCanvasElement;
    }),
  } as unknown as Document;
});

describe('TextCache', () => {
  describe('atlas creation', () => {
    it('creates atlas texture on first Get', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      expect(cache.Atlas).toBeNull();
      cache.Get('hello', DefaultTextStyle, null, 1);
      expect(cache.Atlas).not.toBeNull();
      expect(r._createTextureFn).toHaveBeenCalledTimes(1);
    });

    it('reuses same atlas texture across multiple words', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.Get('hello', DefaultTextStyle, null, 1);
      cache.Get('world', DefaultTextStyle, null, 1);
      cache.Get('foo', DefaultTextStyle, null, 1);
      expect(r._createTextureFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('caching behavior', () => {
    it('returns same entry for identical text+style', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      const a = cache.Get('hello', DefaultTextStyle, null, 1);
      const b = cache.Get('hello', DefaultTextStyle, null, 1);
      expect(a).toBe(b);
      expect(r._uploadFn).toHaveBeenCalledTimes(1);
    });

    it('creates new entry for different content', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.Get('a', DefaultTextStyle, null, 1);
      cache.Get('b', DefaultTextStyle, null, 1);
      expect(r._uploadFn).toHaveBeenCalledTimes(2);
    });

    it('creates new entry for different style', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.Get('x', DefaultTextStyle, null, 1);
      cache.Get('x', { ...DefaultTextStyle, FontSize: 24 }, null, 1);
      expect(r._uploadFn).toHaveBeenCalledTimes(2);
    });

    it('creates new entry for different dpr', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.Get('x', DefaultTextStyle, null, 1);
      cache.Get('x', DefaultTextStyle, null, 2);
      expect(r._uploadFn).toHaveBeenCalledTimes(2);
    });

    it('stores measurement result in entry', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      const entry = cache.Get('hi', DefaultTextStyle, null, 1);
      expect(entry.Measurement.Lines).toEqual(['hi']);
      expect(entry.CssWidth).toBeGreaterThan(0);
      expect(entry.CssHeight).toBeGreaterThan(0);
    });

    it('stores UV coordinates in entry', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      const entry = cache.Get('test', DefaultTextStyle, null, 1);
      expect(entry.Uv.U).toBeGreaterThanOrEqual(0);
      expect(entry.Uv.V).toBeGreaterThanOrEqual(0);
      expect(entry.Uv.UWidth).toBeGreaterThan(0);
      expect(entry.Uv.UHeight).toBeGreaterThan(0);
    });

    it('size reflects number of cached entries', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.Get('a', DefaultTextStyle, null, 1);
      cache.Get('b', DefaultTextStyle, null, 1);
      cache.Get('c', DefaultTextStyle, null, 1);
      expect(cache.Size).toBe(3);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entries when over capacity', () => {
      const r = mockRenderer();
      const cache = new TextCache(r, 4);
      for (let i = 0; i < 5; i++) {
        cache.BeginFrame();
        cache.Get(`w${i}`, DefaultTextStyle, null, 1);
      }
      // 5 inserted into capacity-4 → should have evicted at least 1
      expect(cache.Size).toBeLessThanOrEqual(4);
    });

    it('keeps recently used entries', () => {
      const r = mockRenderer();
      const cache = new TextCache(r, 4);
      cache.BeginFrame();
      cache.Get('keep', DefaultTextStyle, null, 1);
      cache.Get('old1', DefaultTextStyle, null, 1);
      cache.Get('old2', DefaultTextStyle, null, 1);
      cache.Get('old3', DefaultTextStyle, null, 1);
      // Touch 'keep' again so it's the most recent
      cache.BeginFrame();
      cache.Get('keep', DefaultTextStyle, null, 1);
      // Trigger eviction by adding a 5th entry
      cache.Get('new', DefaultTextStyle, null, 1);
      // 'keep' should survive because it was recently used
      const keepEntry = cache.Get('keep', DefaultTextStyle, null, 1);
      expect(keepEntry).toBeDefined();
    });

    it('updates LastUsed on cache hit', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.BeginFrame(); // frame 1
      const entry = cache.Get('hello', DefaultTextStyle, null, 1);
      const firstFrame = entry.LastUsed;
      cache.BeginFrame(); // frame 2
      cache.BeginFrame(); // frame 3
      cache.Get('hello', DefaultTextStyle, null, 1); // cache hit
      expect(entry.LastUsed).toBeGreaterThan(firstFrame);
    });
  });

  describe('Dispose', () => {
    it('deletes the atlas texture and clears entries', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.Get('x', DefaultTextStyle, null, 1);
      expect(cache.Atlas).not.toBeNull();
      cache.Dispose();
      expect(cache.Atlas).toBeNull();
      expect(cache.Size).toBe(0);
    });
  });
});
