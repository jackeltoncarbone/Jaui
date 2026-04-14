import type { ResolvedTextStyle, TextMeasurement } from './Text.Types';
import { MeasureText, ApplyTextStyle } from './Text.Measure';
import { HashTextKey } from './Text.Hash';

export interface TextCacheEntry {
  Texture: WebGLTexture;
  Width: number;       // texture dimensions in device pixels
  Height: number;
  CssWidth: number;    // logical size in CSS pixels
  CssHeight: number;
  Measurement: TextMeasurement;
  LastUsed: number;
}

export class TextCache {
  private _gl: WebGL2RenderingContext;
  private _cache = new Map<string, TextCacheEntry>();
  private _maxEntries: number;
  private _frameCounter: number = 0;
  private _rasterCanvas: HTMLCanvasElement | null = null;
  private _rasterCtx: CanvasRenderingContext2D | null = null;

  constructor(gl: WebGL2RenderingContext, maxEntries: number = 256) {
    this._gl = gl;
    this._maxEntries = maxEntries;
  }

  get Size(): number { return this._cache.size; }

  BeginFrame = (): void => {
    this._frameCounter++;
  };

  /**
   * Get or create a text texture.
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
    for (const entry of this._cache.values()) {
      this._gl.deleteTexture(entry.Texture);
    }
    this._cache.clear();
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

    // Upload to GPU
    const gl = this._gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('[Jwift] Failed to create text texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    return {
      Texture: texture,
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
    // Drop oldest 25% of entries
    const entries = Array.from(this._cache.entries());
    entries.sort((a, b) => a[1].LastUsed - b[1].LastUsed);
    const dropCount = Math.ceil(entries.length * 0.25);
    for (let i = 0; i < dropCount; i++) {
      const [key, entry] = entries[i];
      this._gl.deleteTexture(entry.Texture);
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
