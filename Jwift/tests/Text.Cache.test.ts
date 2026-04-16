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
    texSubImage2D: vi.fn(),
    texParameteri: vi.fn(),
    deleteTexture: vi.fn((tex: object) => { deleted.add(tex); }),
    activeTexture: vi.fn(),
    createBuffer: vi.fn(() => ({ __id: 1 })),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    TEXTURE_2D: 0x0DE1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812F,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88E8,
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
  describe('atlas creation', () => {
    it('creates atlas texture on first Get', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      expect(cache.Atlas).toBeNull();
      cache.Get('hello', DefaultTextStyle, null, 1);
      expect(cache.Atlas).not.toBeNull();
      // One atlas texture created (not per-word)
      expect(gl.createTexture).toHaveBeenCalledTimes(1);
    });

    it('reuses same atlas texture across multiple words', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.Get('hello', DefaultTextStyle, null, 1);
      cache.Get('world', DefaultTextStyle, null, 1);
      cache.Get('foo', DefaultTextStyle, null, 1);
      // Still only one atlas texture
      expect(gl.createTexture).toHaveBeenCalledTimes(1);
    });
  });

  describe('caching behavior', () => {
    it('returns same entry for identical text+style', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      const a = cache.Get('hello', DefaultTextStyle, null, 1);
      const b = cache.Get('hello', DefaultTextStyle, null, 1);
      expect(a).toBe(b);
      // Only one texSubImage2D call (one rasterization)
      expect(gl.texSubImage2D).toHaveBeenCalledTimes(1);
    });

    it('creates new entry for different content', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.Get('a', DefaultTextStyle, null, 1);
      cache.Get('b', DefaultTextStyle, null, 1);
      expect(gl.texSubImage2D).toHaveBeenCalledTimes(2);
    });

    it('creates new entry for different style', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.Get('x', DefaultTextStyle, null, 1);
      cache.Get('x', { ...DefaultTextStyle, FontSize: 24 }, null, 1);
      expect(gl.texSubImage2D).toHaveBeenCalledTimes(2);
    });

    it('creates new entry for different dpr', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.Get('x', DefaultTextStyle, null, 1);
      cache.Get('x', DefaultTextStyle, null, 2);
      expect(gl.texSubImage2D).toHaveBeenCalledTimes(2);
    });

    it('stores measurement result in entry', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      const entry = cache.Get('hi', DefaultTextStyle, null, 1);
      expect(entry.Measurement.Lines).toEqual(['hi']);
      expect(entry.CssWidth).toBeGreaterThan(0);
      expect(entry.CssHeight).toBeGreaterThan(0);
    });

    it('stores UV coordinates in entry', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      const entry = cache.Get('hi', DefaultTextStyle, null, 1);
      expect(entry.Uv).toBeDefined();
      expect(entry.Uv.U).toBeGreaterThanOrEqual(0);
      expect(entry.Uv.V).toBeGreaterThanOrEqual(0);
      expect(entry.Uv.UWidth).toBeGreaterThan(0);
      expect(entry.Uv.UHeight).toBeGreaterThan(0);
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
      const before = gl.texSubImage2D.mock.calls.length;
      cache.Get('a', DefaultTextStyle, null, 1);
      const after = gl.texSubImage2D.mock.calls.length;
      expect(after).toBe(before); // no new sub-upload → 'a' still cached
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
    it('deletes the atlas texture and clears entries', () => {
      const gl = mockGl();
      const cache = new TextCache(gl);
      cache.Get('a', DefaultTextStyle, null, 1);
      cache.Get('b', DefaultTextStyle, null, 1);
      cache.Dispose();
      // One atlas texture deleted (not per-word)
      expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
      expect(cache.Size).toBe(0);
      expect(cache.Atlas).toBeNull();
    });
  });
});
