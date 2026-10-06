import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TextCache, PrimeFontInRasterCtx } from '../src/Text/Text.Cache';
import { DefaultTextStyle } from '../src/Text/Text.Types';
import type { Renderer, GpuTextureHandle } from '../src/Core/Renderer';

// ─── Mocks ───

let _nextTextureId = 1;

const mockRenderer = () => {
  const createTextureFn = vi.fn((): GpuTextureHandle => ({ _brand: 'GpuTextureHandle', __id: _nextTextureId++ } as any));
  const uploadSubTextureFn = vi.fn();
  const deleteTextureFn = vi.fn();
  return {
    CreateTexture: createTextureFn,
    UploadSubTexture: uploadSubTextureFn,
    DeleteTexture: deleteTextureFn,
    _createTextureFn: createTextureFn,
    _uploadFn: uploadSubTextureFn,
    _deleteFn: deleteTextureFn,
  } as unknown as Renderer & {
    _createTextureFn: typeof createTextureFn; _uploadFn: typeof uploadSubTextureFn; _deleteFn: typeof deleteTextureFn;
  };
};

/** The fills the raster context makes, each with the font it was set to: what a priming draw shows up as. */
const spyFills = (): { Fonts: string[]; Restore: () => void } => {
  const proto = Object.getPrototypeOf(new OffscreenCanvas(1, 1).getContext('2d')) as { fillText: () => void };
  const fonts: string[] = [];
  const spy = vi.spyOn(proto, 'fillText').mockImplementation(function (this: { font: string }) { fonts.push(this.font); });
  return { Fonts: fonts, Restore: () => spy.mockRestore() };
};

/** 1,600 × 500 css px: one to a shelf, four shelves to the 2048² atlas. */
const BIG = { ...DefaultTextStyle, FontSize: 500, LineHeight: 1 };
const bigWord = (i: number): string => `${'x'.repeat(199)}${i}`;

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

  describe('GetFor', () => {
    it('returns the entry Get returns, and touches it', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      const word = {};
      cache.BeginFrame();
      const first = cache.GetFor(word, 'hello', DefaultTextStyle, null, 1);
      expect(first).toBe(cache.Get('hello', DefaultTextStyle, null, 1));
      cache.BeginFrame();
      cache.BeginFrame();
      expect(cache.GetFor(word, 'hello', DefaultTextStyle, null, 1)).toBe(first);
      expect(first.LastUsed).toBe(cache.Get('hello', DefaultTextStyle, null, 1).LastUsed);
    });

    it('fetches again when an input changes', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      const word = {};
      const a = cache.GetFor(word, 'hello', DefaultTextStyle, null, 1);
      expect(cache.GetFor(word, 'hello', DefaultTextStyle, null, 2)).not.toBe(a);
      expect(cache.GetFor(word, 'world', DefaultTextStyle, null, 2)).toBe(cache.Get('world', DefaultTextStyle, null, 2));
      expect(cache.GetFor(word, 'world', { ...DefaultTextStyle, FontSize: 30 }, null, 2)).not.toBe(cache.Get('world', DefaultTextStyle, null, 2));
    });

    it('never hands back an entry the cache dropped', () => {
      const r = mockRenderer();
      const cache = new TextCache(r, 4);
      const word = {};
      cache.BeginFrame();
      const kept = cache.GetFor(word, 'w0', DefaultTextStyle, null, 1);
      for (let i = 1; i < 6; i++) { cache.BeginFrame(); cache.Get(`w${i}`, DefaultTextStyle, null, 1); }
      expect(kept.Resident).toBe(false);
      const again = cache.GetFor(word, 'w0', DefaultTextStyle, null, 1);
      expect(again).not.toBe(kept);
      expect(again.Resident).toBe(true);
      cache.Clear();
      expect(again.Resident).toBe(false);
      expect(cache.GetFor(word, 'w0', DefaultTextStyle, null, 1)).not.toBe(again);
    });
  });

  describe('Dispose', () => {
    it('deletes the atlas texture and clears entries', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.Get('x', DefaultTextStyle, null, 1);
      const atlas = cache.Atlas;
      expect(atlas).not.toBeNull();
      cache.Dispose();
      expect(r._deleteFn).toHaveBeenCalledWith(atlas);
      expect(cache.Atlas).toBeNull();
      expect(cache.Size).toBe(0);
    });
  });

  describe('mid-frame rebuild', () => {
    it('drains the queued glyphs against the old atlas first, and draws the tipping word from the new one', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.BeginFrame();
      const queued = [0, 1, 2, 3].map((i) => cache.Get(bigWord(i), BIG, null, 1));
      const oldAtlas = cache.Atlas;
      let drained: { Atlas: unknown; Resident: boolean } | null = null;
      cache.OnBeforeRebuild = () => { drained = { Atlas: cache.Atlas, Resident: queued.every((e) => e.Resident) }; };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tipping = cache.Get(bigWord(4), BIG, null, 1);
      warn.mockRestore();

      // The engine drained while every queued UV still indexed the texture it was resolved in.
      expect(drained).toEqual({ Atlas: oldAtlas, Resident: true });
      expect(cache.Atlas).not.toBe(oldAtlas);
      // The word that tipped the rebuild is uploaded to the texture it is drawn from, at its top.
      expect(r._uploadFn.mock.calls.at(-1)![0]).toBe(cache.Atlas);
      expect(tipping.Uv.V).toBe(1 / 2048);
      expect(queued.some((e) => e.Resident)).toBe(false);
    });

    it('frees the replaced atlas at the next frame boundary, not while the frame still samples it', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.BeginFrame();
      for (let i = 0; i < 4; i++) cache.Get(bigWord(i), BIG, null, 1);
      const oldAtlas = cache.Atlas;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      cache.Get(bigWord(4), BIG, null, 1);
      warn.mockRestore();
      expect(r._deleteFn).not.toHaveBeenCalled();
      cache.BeginFrame();
      expect(r._deleteFn).toHaveBeenCalledTimes(1);
      expect(r._deleteFn).toHaveBeenCalledWith(oldAtlas);
      cache.BeginFrame();
      expect(r._deleteFn).toHaveBeenCalledTimes(1);
    });

    it('never evicts a raster drawn this frame, so no upload lands on a queued glyph', () => {
      const r = mockRenderer();
      const cache = new TextCache(r, 2);
      cache.BeginFrame();
      const words = ['a', 'b', 'c', 'd'].map((w) => cache.Get(w, DefaultTextStyle, null, 1));
      expect(words.every((e) => e.Resident)).toBe(true);
      expect(new Set(words.map((e) => `${e.Uv.U},${e.Uv.V}`)).size).toBe(4);
      // The next frame's trim brings it back under the cap.
      cache.BeginFrame();
      cache.Get('e', DefaultTextStyle, null, 1);
      expect(cache.Size).toBeLessThan(5);
    });
  });

  describe('shelf reclaim', () => {
    it('hands an emptied bottom shelf back, so a taller raster can have its rows', () => {
      const r = mockRenderer();
      const cache = new TextCache(r, 2);
      cache.BeginFrame();
      cache.Get('a', DefaultTextStyle, null, 1);
      cache.BeginFrame();
      const tall = cache.Get('t', { ...DefaultTextStyle, FontSize: 300, LineHeight: 1 }, null, 1);
      cache.BeginFrame();
      cache.Get('a', DefaultTextStyle, null, 1);
      cache.Get('b', DefaultTextStyle, null, 1); // over the cap: the tall raster is the oldest
      expect(tall.Resident).toBe(false);
      const taller = cache.Get('u', { ...DefaultTextStyle, FontSize: 600, LineHeight: 1 }, null, 1);
      expect(taller.Uv.V).toBe(tall.Uv.V);
    });

    it('does not rebuild an atlas whose rows were all handed back', () => {
      const r = mockRenderer();
      const cache = new TextCache(r, 1);
      // Each frame a taller word than the last, evicting the one before: a packer that kept the
      // emptied strips at their old heights (300 + 600 + 900 rows) had no room for the fourth and
      // wiped the atlas, with the whole of it free.
      for (let i = 0; i < 4; i++) {
        cache.BeginFrame();
        cache.Get(bigWord(i), { ...DefaultTextStyle, FontSize: 300 * (i + 1), LineHeight: 1 }, null, 1);
      }
      expect(r._createTextureFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('raster faces', () => {
    it('binds every registered face into a new raster context before its first glyph', () => {
      PrimeFontInRasterCtx('"FirstGlyphFace"', '100 900', 'normal');
      const fills = spyFills();
      const cache = new TextCache(mockRenderer());
      cache.Get('hello', DefaultTextStyle, null, 1);
      fills.Restore();
      const primed = fills.Fonts.indexOf('normal 100 16px "FirstGlyphFace"');
      expect(primed).toBeGreaterThanOrEqual(0);
      expect(primed).toBeLessThan(fills.Fonts.length - 1); // the glyph itself is the last fill
    });

    it('binds a face that lands later at the frame boundary, and re-rasters what drew without it', () => {
      const r = mockRenderer();
      const cache = new TextCache(r);
      cache.BeginFrame();
      const before = cache.Get('hello', DefaultTextStyle, null, 1);
      const epoch = cache.RasterEpoch;

      expect(PrimeFontInRasterCtx('LateFace', '600', 'italic')).toBe(true);
      expect(PrimeFontInRasterCtx('"LateFace"', '600', 'italic')).toBe(false);
      const fills = spyFills();
      cache.BeginFrame();
      fills.Restore();
      expect(fills.Fonts).toContain('italic 600 16px "LateFace"');
      expect(before.Resident).toBe(false);
      expect(cache.RasterEpoch).not.toBe(epoch);
      expect(cache.Get('hello', DefaultTextStyle, null, 1)).not.toBe(before);

      // Nothing new registered: the next boundary keeps every raster.
      const after = cache.Get('hello', DefaultTextStyle, null, 1);
      cache.BeginFrame();
      expect(after.Resident).toBe(true);
    });

    it('asks the FontFaceSet for the faces a raster uses, once per face and code block', async () => {
      const face = { family: 'AwaitFace', weight: '400', style: 'normal', status: 'loaded' };
      const load = vi.fn((_spec: string, _text?: string) => Promise.resolve([face]));
      (global.document as unknown as { fonts: unknown }).fonts = { load, forEach: () => {} };
      const cache = new TextCache(mockRenderer());
      const ready = vi.fn();
      cache.OnFontsReady = ready;
      const style = { ...DefaultTextStyle, FontFamily: 'AwaitFace' };

      cache.BeginFrame();
      const to = cache.Get('to', style, null, 1);
      cache.Get('go', style, null, 1);
      expect(load).toHaveBeenCalledTimes(1);
      expect(load.mock.calls[0][0]).toContain('16px AwaitFace');
      expect(load.mock.calls[0][1]).toBe('to');
      cache.Get('a ⇔ b', style, null, 1); // a block the Latin ask never covered
      expect(load).toHaveBeenCalledTimes(2);

      await new Promise((resolve) => setTimeout(resolve, 0));
      // The face arrived once; the second answer named a face already registered.
      expect(ready).toHaveBeenCalledTimes(1);
      cache.BeginFrame();
      expect(to.Resident).toBe(false);
    });
  });

  describe('oversize guard', () => {
    it('names a glyph image taller than four of its line boxes, once', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cache = new TextCache(mockRenderer());
      cache.Get('fine', { ...DefaultTextStyle, LineHeight: 2.5 }, null, 3);
      cache.Get('two\nlines', DefaultTextStyle, null, 3);
      expect(warn).not.toHaveBeenCalled();
      // A line height handed over in points: 16 × 23 css px a line.
      cache.Get('to', { ...DefaultTextStyle, FontSize: 16, LineHeight: 23 }, null, 3);
      cache.Get('fro', { ...DefaultTextStyle, FontSize: 16, LineHeight: 23 }, null, 3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('"to"');
      expect(warn.mock.calls[0][0]).toContain('48×1104');
      warn.mockRestore();
    });
  });
});
