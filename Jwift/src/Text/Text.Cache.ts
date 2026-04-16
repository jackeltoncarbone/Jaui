import type { ResolvedTextStyle, TextMeasurement } from './Text.Types';
import { MeasureText, ApplyTextStyle } from './Text.Measure';
import { HashTextKey } from './Text.Hash';

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
}

/** Shelf in the shelf-packing atlas. */
interface AtlasShelf {
  Y: number;           // top pixel row
  Height: number;      // tallest word placed on this shelf
  Cursor: number;      // next free X position
}

const ATLAS_SIZE = 2048;

export class TextCache {
  private _gl: WebGL2RenderingContext;
  private _cache = new Map<string, TextCacheEntry>();
  private _maxEntries: number;
  private _frameCounter: number = 0;
  private _rasterCanvas: HTMLCanvasElement | null = null;
  private _rasterCtx: CanvasRenderingContext2D | null = null;

  // ─── Atlas ───
  private _atlas: WebGLTexture | null = null;
  private _atlasSize: number = ATLAS_SIZE;
  private _shelves: AtlasShelf[] = [];
  /** Next Y position for a new shelf. */
  private _nextShelfY: number = 0;

  constructor(gl: WebGL2RenderingContext, maxEntries: number = 256) {
    this._gl = gl;
    this._maxEntries = maxEntries;
  }

  get Size(): number { return this._cache.size; }
  /** The single atlas texture — bind this in the text draw pass. */
  get Atlas(): WebGLTexture | null { return this._atlas; }

  BeginFrame = (): void => {
    this._frameCounter++;
  };

  /**
   * Get or create a text entry in the atlas.
   * @param maxWidth — wrap boundary in CSS pixels (null = no wrap)
   */
  Get = (content: string, style: ResolvedTextStyle, maxWidth: number | null, dpr: number): TextCacheEntry => {
    const key = HashTextKey(content, style, dpr) + '|' + (maxWidth ?? 'null');
    const existing = this._cache.get(key);
    if (existing) {
      existing.LastUsed = this._frameCounter;
      return existing;
    }

    const measurement = MeasureText(content, style, maxWidth);
    const entry = this._rasterize(content, style, measurement, dpr);
    this._cache.set(key, entry);

    if (this._cache.size > this._maxEntries) this._evict();
    return entry;
  };

  Dispose = (): void => {
    if (this._atlas) {
      this._gl.deleteTexture(this._atlas);
      this._atlas = null;
    }
    this._cache.clear();
    this._shelves.length = 0;
    this._nextShelfY = 0;
  };

  private _ensureAtlas = (): WebGLTexture => {
    if (this._atlas) return this._atlas;
    const gl = this._gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('[Jwift] Failed to create text atlas texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      this._atlasSize, this._atlasSize, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._atlas = tex;
    return tex;
  };

  /** Find space in the shelf-pack for a word of size pxW×pxH. Returns the
   *  pixel origin {X, Y} in the atlas. If the atlas is full, rebuilds it. */
  private _allocate = (pxW: number, pxH: number): { X: number; Y: number } => {
    const size = this._atlasSize;

    // Try existing shelves
    for (const shelf of this._shelves) {
      if (shelf.Cursor + pxW <= size && shelf.Height >= pxH) {
        const x = shelf.Cursor;
        shelf.Cursor += pxW;
        return { X: x, Y: shelf.Y };
      }
    }

    // Create a new shelf
    if (this._nextShelfY + pxH <= size) {
      const shelf: AtlasShelf = { Y: this._nextShelfY, Height: pxH, Cursor: pxW };
      this._shelves.push(shelf);
      const origin = { X: 0, Y: this._nextShelfY };
      this._nextShelfY += pxH;
      return origin;
    }

    // Atlas full — rebuild. Clear everything; all cached words will be
    // re-rasterized on the next Get() call.
    this._rebuildAtlas();
    // After rebuild, shelves are empty. Allocate on a fresh shelf.
    const shelf: AtlasShelf = { Y: 0, Height: pxH, Cursor: pxW };
    this._shelves.push(shelf);
    this._nextShelfY = pxH;
    return { X: 0, Y: 0 };
  };

  /** Wipe the atlas and all cached entries. Next frame re-rasterizes on demand. */
  private _rebuildAtlas = (): void => {
    this._cache.clear();
    this._shelves.length = 0;
    this._nextShelfY = 0;
    // Re-create the atlas texture (clear to transparent)
    if (this._atlas) {
      const gl = this._gl;
      gl.bindTexture(gl.TEXTURE_2D, this._atlas);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA,
        this._atlasSize, this._atlasSize, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null,
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  };

  private _rasterize = (
    _content: string,
    style: ResolvedTextStyle,
    measurement: TextMeasurement,
    dpr: number,
  ): TextCacheEntry => {
    const cssW = Math.max(1, Math.ceil(measurement.Width));
    const cssH = Math.max(1, Math.ceil(measurement.Height));
    const pxW = Math.max(1, Math.ceil(cssW * dpr));
    const pxH = Math.max(1, Math.ceil(cssH * dpr));

    const ctx = this._getRasterCtx();
    const canvas = ctx.canvas;
    canvas.width = pxW;
    canvas.height = pxH;

    // Clear (transparent)
    ctx.clearRect(0, 0, pxW, pxH);

    // Draw text at DPR-scaled font size
    ApplyTextStyle(ctx, style, dpr);
    const lineHeightPx = style.FontSize * style.LineHeight * dpr;
    ctx.fillStyle = _colorToCss(style.Color);

    for (let i = 0; i < measurement.Lines.length; i++) {
      const line = measurement.Lines[i];
      let x = 0;
      if (style.TextAlign === 'Center' || style.TextAlign === 'Right') {
        const lineWidth = ctx.measureText(line).width;
        if (style.TextAlign === 'Center') x = (pxW - lineWidth) / 2;
        else if (style.TextAlign === 'Right') x = pxW - lineWidth;
      }
      ctx.fillText(line, x, i * lineHeightPx);
    }

    // Upload to atlas via texSubImage2D
    const atlas = this._ensureAtlas();
    const origin = this._allocate(pxW, pxH);
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0,
      origin.X, origin.Y,
      gl.RGBA, gl.UNSIGNED_BYTE,
      canvas,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

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
    };
  };

  private _getRasterCtx = (): CanvasRenderingContext2D => {
    if (this._rasterCtx) return this._rasterCtx;
    this._rasterCanvas = document.createElement('canvas');
    const ctx = this._rasterCanvas.getContext('2d');
    if (!ctx) throw new Error('[Jwift] Failed to get 2D context for text rasterization');
    this._rasterCtx = ctx;
    return ctx;
  };

  private _evict = (): void => {
    // Drop oldest 25% of entries — mark atlas regions as "leaked" (simple:
    // they stay until the atlas fills up and triggers a full rebuild).
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
