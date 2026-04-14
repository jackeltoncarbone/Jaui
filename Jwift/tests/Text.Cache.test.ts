import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TextCache } from '../src/Text/Text.Cache';
import { DefaultTextStyle } from '../src/Text/Text.Types';

// ─── Mocks ───

let _nextTextureId = 1;

const mockGl = () => {
  const deleted = new Set<object>();
  const gl = {
    createTexture: vi.fn(() => ({ __id: _nextTextureId++ })),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    deleteTexture: vi.fn((tex: object) => { deleted.add(tex); }),
    activeTexture: vi.fn(),
    TEXTURE_2D: 0x0DE1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812F,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    _deleted: deleted,
  };
  return gl as unknown as WebGL2RenderingContext & { _deleted: Set<object> };
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
  // Stub document.createElement('canvas') to return the mock
  global.document = {
    createElement: vi.fn(() => {
      const c = mockCanvas();
      return c.canvas as unknown as HTMLCanvasElement;
    }),
  } as unknown as Document;
});

describe('TextCache', () => {
  describe('caching behavior', () => {
    it('returns same entry for identical text+style', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      const a = cache.Get('hello', DefaultTextStyle, null, 1);
      const b = cache.Get('hello', DefaultTextStyle, null, 1);
      expect(a).toBe(b);
      expect(gl.createTexture).toHaveBeenCalledTimes(1);
    });

    it('creates new entry for different content', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.Get('a', DefaultTextStyle, null, 1);
      cache.Get('b', DefaultTextStyle, null, 1);
      expect(gl.createTexture).toHaveBeenCalledTimes(2);
    });

    it('creates new entry for different style', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.Get('x', DefaultTextStyle, null, 1);
      cache.Get('x', { ...DefaultTextStyle, FontSize: 24 }, null, 1);
      expect(gl.createTexture).toHaveBeenCalledTimes(2);
    });

    it('creates new entry for different dpr', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.Get('x', DefaultTextStyle, null, 1);
      cache.Get('x', DefaultTextStyle, null, 2);
      expect(gl.createTexture).toHaveBeenCalledTimes(2);
    });

    it('stores measurement result in entry', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      const entry = cache.Get('hi', DefaultTextStyle, null, 1);
      expect(entry.Measurement.Lines).toEqual(['hi']);
      expect(entry.CssWidth).toBeGreaterThan(0);
      expect(entry.CssHeight).toBeGreaterThan(0);
    });

    it('size reflects number of cached entries', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      expect(cache.Size).toBe(0);
      cache.Get('a', DefaultTextStyle, null, 1);
      expect(cache.Size).toBe(1);
      cache.Get('b', DefaultTextStyle, null, 1);
      expect(cache.Size).toBe(2);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entries when over capacity', () => {
      const gl = mockGl();
      const cache = new TextCache(gl, 4); // small cap
      cache.BeginFrame();
      cache.Get('a', DefaultTextStyle, null, 1);
      cache.BeginFrame();
      cache.Get('b', DefaultTextStyle, null, 1);
      cache.BeginFrame();
      cache.Get('c', DefaultTextStyle, null, 1);
      cache.BeginFrame();
      cache.Get('d', DefaultTextStyle, null, 1);
      expect(cache.Size).toBe(4);
      // One more triggers eviction
      cache.BeginFrame();
      cache.Get('e', DefaultTextStyle, null, 1);
      expect(cache.Size).toBeLessThan(5);
      expect(gl.deleteTexture).toHaveBeenCalled();
    });

    it('keeps recently used entries', () => {
      const gl = mockGl();
      const cache = new TextCache(gl, 4);
      cache.BeginFrame(); cache.Get('a', DefaultTextStyle, null, 1);
      cache.BeginFrame(); cache.Get('b', DefaultTextStyle, null, 1);
      cache.BeginFrame(); cache.Get('c', DefaultTextStyle, null, 1);
      cache.BeginFrame(); cache.Get('d', DefaultTextStyle, null, 1);
      // Re-access 'a' to bump its LastUsed
      cache.BeginFrame(); cache.Get('a', DefaultTextStyle, null, 1);
      // Now trigger eviction
      cache.BeginFrame(); cache.Get('e', DefaultTextStyle, null, 1);
      cache.BeginFrame();
      // 'a' was recently used, 'b' was oldest — 'a' should still be there
      const before = gl.createTexture.mock.calls.length;
      cache.Get('a', DefaultTextStyle, null, 1);
      const after = gl.createTexture.mock.calls.length;
      expect(after).toBe(before); // no new texture → 'a' still cached
    });

    it('updates LastUsed on cache hit', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.BeginFrame();
      const entry = cache.Get('x', DefaultTextStyle, null, 1);
      const initialUsed = entry.LastUsed;
      cache.BeginFrame();
      cache.BeginFrame();
      const entry2 = cache.Get('x', DefaultTextStyle, null, 1);
      expect(entry2.LastUsed).toBeGreaterThan(initialUsed);
    });
  });

  describe('Dispose', () => {
    it('deletes all textures', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.Get('a', DefaultTextStyle, null, 1);
      cache.Get('b', DefaultTextStyle, null, 1);
      cache.Dispose();
      expect(gl.deleteTexture).toHaveBeenCalledTimes(2);
      expect(cache.Size).toBe(0);
    });
  });
});
