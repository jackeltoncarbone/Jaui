import type { ResolvedTextStyle, TextMeasurement } from './Text.Types';
import { MeasureText, ApplyTextStyle } from './Text.Measure';
import { HashTextKey } from './Text.Hash';
import { LayoutWords } from './Text.WordLayout';
import { ComputeSdf } from './Text.Sdf';
import type { Renderer, GpuTextureHandle } from '../Core/Renderer';

/** UV rect within the atlas texture (normalized 0→1). */
export interface AtlasUv {
  U: number;
  V: number;
  UWidth: number;
  UHeight: number;
}

export interface TextCacheEntry {
  Uv: AtlasUv;
  Width: number;       // texture dimensions in device pixels
  Height: number;
  CssWidth: number;    // logical size in CSS pixels
  CssHeight: number;
  Measurement: TextMeasurement;
  LastUsed: number;
  /** True when this entry's atlas alpha is a signed distance field (large text,
   *  scale-stable) vs. raw coverage raster (small text, crisp). The shader picks
   *  the matching edge reconstruction. */
  IsSdf: boolean;
}

/** Shelf in the shelf-packing atlas. */
interface AtlasShelf {
  Y: number;           // top pixel row
  Height: number;      // tallest word placed on this shelf
  Cursor: number;      // next free X position
}

const ATLAS_SIZE = 2048;

/**
 * Text atlas cache. Rasterizes text to an offscreen canvas, packs into a
 * shelf-packed GPU atlas texture. Backend-agnostic — uses the Renderer
 * interface for texture creation and upload.
 */
export class TextCache {
  private _renderer: Renderer;
  private _cache = new Map<string, TextCacheEntry>();
  private _maxEntries: number;
  private _frameCounter: number = 0;
  private _rasterCanvas: OffscreenCanvas | null = null;
  private _rasterCtx: OffscreenCanvasRenderingContext2D | null = null;

  // ─── Atlas ───
  private _atlas: GpuTextureHandle | null = null;
  private _atlasSize: number = ATLAS_SIZE;
  private _shelves: AtlasShelf[] = [];
  private _nextShelfY: number = 0;

  constructor(renderer: Renderer, maxEntries: number = 256) {
    this._renderer = renderer;
    this._maxEntries = maxEntries;
  }

  get Size(): number { return this._cache.size; }
  get Atlas(): GpuTextureHandle | null { return this._atlas; }

  BeginFrame = (): void => {
    this._frameCounter++;
  };

  Get = (content: string, style: ResolvedTextStyle, maxWidth: number | null, dpr: number): TextCacheEntry => {
    const key = HashTextKey(content, style, dpr) + '|' + (maxWidth ?? 'null');
    const existing = this._cache.get(key);
    if (existing) {
      existing.LastUsed = this._frameCounter;
      return existing;
    }

    const measurement = MeasureText(content, style, maxWidth);
    const entry = this._rasterize(content, style, measurement, maxWidth, dpr);
    this._cache.set(key, entry);

    if (this._cache.size > this._maxEntries) this._evict();
    return entry;
  };

  Dispose = (): void => {
    // GpuTextureHandle is opaque — the Renderer owns GPU lifecycle.
    // We just drop our reference.
    this._atlas = null;
    this._cache.clear();
    this._shelves.length = 0;
    this._nextShelfY = 0;
  };

  /** Flush all cached entries and reset the shelf packer. Call when
   *  something outside the cache invalidates existing measurements —
   *  notably, when web fonts finish loading after the first render
   *  (entries rasterized against the fallback font must be re-rasterized).
   *
   *  Keeps the existing GPU atlas texture: newly-allocated slots will be
   *  overwritten by subsequent `_rasterize` UploadSubTexture calls; any
   *  stale pixels in unreferenced regions are harmless because no UV
   *  points at them. Recreating the texture left every text/icon glyph
   *  sampling from an empty atlas for at least one render frame between
   *  the clear and the next rasterize pass — visible as a hard text+icon
   *  blink on font-load. */
  Clear = (): void => {
    this._cache.clear();
    this._shelves.length = 0;
    this._nextShelfY = 0;
  };

  private _ensureAtlas = (): GpuTextureHandle => {
    if (this._atlas) return this._atlas;
    this._atlas = this._renderer.CreateTexture(this._atlasSize, this._atlasSize);
    return this._atlas;
  };

  private _allocate = (pxW: number, pxH: number): { X: number; Y: number } => {
    const size = this._atlasSize;

    for (const shelf of this._shelves) {
      if (shelf.Cursor + pxW <= size && shelf.Height >= pxH) {
        const x = shelf.Cursor;
        shelf.Cursor += pxW;
        return { X: x, Y: shelf.Y };
      }
    }

    if (this._nextShelfY + pxH <= size) {
      const shelf: AtlasShelf = { Y: this._nextShelfY, Height: pxH, Cursor: pxW };
      this._shelves.push(shelf);
      const origin = { X: 0, Y: this._nextShelfY };
      this._nextShelfY += pxH;
      return origin;
    }

    this._rebuildAtlas();
    const shelf: AtlasShelf = { Y: 0, Height: pxH, Cursor: pxW };
    this._shelves.push(shelf);
    this._nextShelfY = pxH;
    return { X: 0, Y: 0 };
  };

  private _rebuildAtlas = (): void => {
    this._cache.clear();
    this._shelves.length = 0;
    this._nextShelfY = 0;
    // Recreate the atlas texture (fresh, cleared to transparent).
    this._atlas = this._renderer.CreateTexture(this._atlasSize, this._atlasSize);
  };

  private _rasterize = (
    content: string,
    style: ResolvedTextStyle,
    measurement: TextMeasurement,
    maxWidth: number | null,
    dpr: number,
  ): TextCacheEntry => {
    // For Justify, the canvas needs to be at least as wide as the wrap
    // budget — otherwise justified words spill past the right edge of the
    // backing texture and clip. For all other alignments the natural max-
    // line width is sufficient.
    const naturalCssW = Math.max(1, Math.ceil(measurement.Width));
    const cssW = style.TextAlign === 'Justify' && maxWidth !== null
      ? Math.max(naturalCssW, Math.ceil(maxWidth))
      : naturalCssW;
    const cssH = Math.max(1, Math.ceil(measurement.Height));
    const pxW = Math.max(1, Math.ceil(cssW * dpr));
    const pxH = Math.max(1, Math.ceil(cssH * dpr));

    const ctx = this._getRasterCtx();
    const canvas = ctx.canvas;
    canvas.width = pxW;
    canvas.height = pxH;

    ctx.clearRect(0, 0, pxW, pxH);
    ApplyTextStyle(ctx, style, dpr);
    const lineHeightPx = style.FontSize * style.LineHeight * dpr;
    ctx.fillStyle = _colorToCss(style.Color);

    if (style.TextAlign === 'Justify' && maxWidth !== null) {
      // Justify needs per-word X distribution — use LayoutWords for the
      // gap math, then per-word fillText. Run LayoutWords with the cache
      // ctx so its measurement matches our raster ctx; reapply font after
      // because LayoutWords sets dpr=1 internally.
      const positions = LayoutWords(content, style, maxWidth, ctx);
      ApplyTextStyle(ctx, style, dpr);
      ctx.fillStyle = _colorToCss(style.Color);
      for (const w of positions) {
        ctx.fillText(w.Content, w.X * dpr, w.Y * dpr + lineHeightPx / 2);
      }
    } else {
      // Original per-line path. Cheap, well-tested; preserved verbatim
      // for non-Justify alignments to avoid regressing the hot path that
      // every <jext>/Token segment in the app travels through.
      for (let i = 0; i < measurement.Lines.length; i++) {
        const line = measurement.Lines[i];
        let x = 0;
        if (style.TextAlign === 'Center' || style.TextAlign === 'Right') {
          const lineWidth = ctx.measureText(line).width;
          if (style.TextAlign === 'Center') x = (pxW - lineWidth) / 2;
          else if (style.TextAlign === 'Right') x = pxW - lineWidth;
        }
        // textBaseline='middle' — draw y = line top + half line height so
        // the glyph centers on the midline of each line-height box.
        ctx.fillText(line, x, i * lineHeightPx + lineHeightPx / 2);
      }
    }

    // HYBRID raster/SDF text. The crisp anti-aliased RASTER is the DEFAULT for
    // ALL screen-space text — at 1:1 it is pixel-sharp at every size and every
    // dpr (matching the WebGL2 reference). An SDF round-trip through a discrete
    // grid always SOFTENS the edge slightly (the dpr-scaled spread makes large
    // headings visibly hazy at retina — the "blurry text" regression), so SDF is
    // reserved for the ONE case where raster genuinely fails: WORLD-space text
    // that gets scaled / Z-pushed in the 3D world, where a fixed-res raster atlas
    // would blur under magnification but an SDF stays sharp. So: gate SDF on
    // Space:World (and a sane min size), NOT on size alone. The atlas entry
    // records `IsSdf` so the shader picks the matching edge reconstruction.
    const SDF_MIN_FONT_PX = 18;   // below this even world text stays raster
    const fontPx = style.FontSize * dpr;
    let isSdf = false;
    if (style.Space === 'World' && fontPx >= SDF_MIN_FONT_PX) {
      const img = ctx.getImageData(0, 0, pxW, pxH);
      const alpha = new Uint8Array(pxW * pxH);
      for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3];
      const spread = Math.max(3, Math.min(12, Math.round(fontPx * 0.14)));
      const sdf = ComputeSdf(alpha, pxW, pxH, spread);
      // Preserve baked color (rgb); replace alpha with the SDF (128 = edge).
      for (let i = 0; i < sdf.length; i++) img.data[i * 4 + 3] = sdf[i];
      ctx.putImageData(img, 0, 0);
      isSdf = true;
    }

    // Upload to atlas via Renderer
    const atlas = this._ensureAtlas();
    const origin = this._allocate(pxW, pxH);
    this._renderer.UploadSubTexture(atlas, origin.X, origin.Y, canvas);

    const size = this._atlasSize;
    return {
      Uv: {
        U: origin.X / size,
        V: origin.Y / size,
        UWidth: pxW / size,
        UHeight: pxH / size,
      },
      Width: pxW,
      Height: pxH,
      CssWidth: cssW,
      CssHeight: cssH,
      Measurement: measurement,
      LastUsed: this._frameCounter,
      IsSdf: isSdf,
    };
  };

  private _getRasterCtx = (): OffscreenCanvasRenderingContext2D => {
    if (this._rasterCtx) return this._rasterCtx;
    // OffscreenCanvas: works on main thread + in workers, with the same
    // 2D drawing surface we previously got from a DOM <canvas>. Initial
    // size is 1×1; per-glyph rasterization resizes via .width/.height
    // assignment as before.
    this._rasterCanvas = new OffscreenCanvas(1, 1);
    const ctx = this._rasterCanvas.getContext('2d');
    if (!ctx) throw new Error('[Jaui] Failed to get 2D context for text rasterization');
    this._rasterCtx = ctx;
    return ctx;
  };

  private _evict = (): void => {
    const entries = Array.from(this._cache.entries());
    entries.sort((a, b) => a[1].LastUsed - b[1].LastUsed);
    const dropCount = Math.ceil(entries.length * 0.25);
    for (let i = 0; i < dropCount; i++) {
      const [key] = entries[i];
      this._cache.delete(key);
    }
  };
}

const _colorToCss = (c: { R: number; G: number; B: number; A: number }): string => {
  const r = Math.round(c.R * 255);
  const g = Math.round(c.G * 255);
  const b = Math.round(c.B * 255);
  return `rgba(${r},${g},${b},${c.A})`;
};
