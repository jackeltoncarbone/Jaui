/**
 * Image cache — loads images (URL, SVG string, or pre-rendered canvas),
 * rasterizes them to a 2D canvas, and uploads as GPU textures via the
 * Renderer. Caches by source key to avoid re-uploading.
 *
 * SVG support: pass an SVG string as the source. It's rasterized via the
 * browser's native SVG renderer (Image element + data URL). Color
 * substitution can be done on the SVG string before passing it in.
 */

import type { Renderer, GpuTextureHandle } from '../Core/Renderer';

export interface ImageEntry {
  Texture: GpuTextureHandle;
  Width: number;       // natural width in pixels
  Height: number;      // natural height in pixels
  Ready: boolean;      // false while loading async
}

/** Internal — tracks an SVG source so it can be re-rasterized at a new DPR
 *  when the browser zoom / DPR changes. Without this the first rasterization
 *  fixes the texture resolution forever and zoomed-in logos go blurry. */
interface _SvgSource {
  SvgString: string;
  CssWidth: number;
  CssHeight: number;
}

export class ImageCache {
  private _renderer: Renderer;
  private _cache = new Map<string, ImageEntry>();
  private _loading = new Set<string>();
  private _svgSources = new Map<string, _SvgSource>();
  private _lastSvgDpr = new Map<string, number>();
  private _rasterCanvas: HTMLCanvasElement | null = null;
  private _rasterCtx: CanvasRenderingContext2D | null = null;

  private _onLoad: (() => void) | null = null;

  constructor(renderer: Renderer) {
    this._renderer = renderer;
  }

  /** Called when any image finishes loading. Canvas uses this to trigger
   *  a layout re-solve (image intrinsic sizes may have become available). */
  set OnLoad(callback: (() => void) | null) { this._onLoad = callback; }

  /** Get a cached image entry. Returns null if not cached yet.
   *  Call `Load()` first to trigger async loading. */
  Get = (key: string): ImageEntry | null => {
    return this._cache.get(key) ?? null;
  };

  /** Load an image from a URL. Async — returns immediately; the entry
   *  becomes Ready when the image finishes loading. */
  LoadUrl = (url: string, _dpr: number = 1): void => {
    if (this._cache.has(url) || this._loading.has(url)) return;
    this._loading.add(url);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this._loading.delete(url);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const tex = this._renderer.CreateTexture(w, h);
      this._renderer.UploadSubTexture(tex, 0, 0, img as unknown as ImageBitmap);
      this._cache.set(url, { Texture: tex, Width: w, Height: h, Ready: true });
      this._onLoad?.();
    };
    img.onerror = () => {
      this._loading.delete(url);
      console.warn(`[Jwift] Failed to load image: ${url}`);
    };
    img.src = url;
  };

  /** Load an SVG from a string. Rasterizes at `width*dpr × height*dpr` so
   *  retina / zoomed-in displays get a sharp texture. The SVG source is
   *  kept so callers can re-rasterize at higher DPR later — see
   *  `RerasterizeSvgs()`. */
  LoadSvg = (key: string, svgString: string, width: number, height: number, dpr: number = 1): void => {
    if (this._cache.has(key) || this._loading.has(key)) return;
    this._svgSources.set(key, { SvgString: svgString, CssWidth: width, CssHeight: height });
    this._rasterizeSvg(key, dpr);
  };

  /** Re-rasterize every cached SVG at the new DPR if it's higher than what
   *  was used last time. Called by Jwift when `devicePixelRatio` changes
   *  (e.g. the user Ctrl+Scrolls to zoom in the browser) so logos and other
   *  SVG content stay sharp at the new scale. */
  RerasterizeSvgs = (dpr: number): void => {
    for (const key of this._svgSources.keys()) {
      const last = this._lastSvgDpr.get(key) ?? 0;
      if (dpr > last) this._rasterizeSvg(key, dpr);
    }
  };

  private _rasterizeSvg = (key: string, dpr: number): void => {
    const src = this._svgSources.get(key);
    if (!src) return;
    this._loading.add(key);

    const pxW = Math.max(1, Math.ceil(src.CssWidth * dpr));
    const pxH = Math.max(1, Math.ceil(src.CssHeight * dpr));

    const blob = new Blob([src.SvgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    const img = new Image();
    img.onload = () => {
      this._loading.delete(key);
      URL.revokeObjectURL(url);

      const ctx = this._getRasterCtx();
      ctx.canvas.width = pxW;
      ctx.canvas.height = pxH;
      ctx.clearRect(0, 0, pxW, pxH);
      ctx.drawImage(img, 0, 0, pxW, pxH);

      const existing = this._cache.get(key);
      const tex = existing?.Texture ?? this._renderer.CreateTexture(pxW, pxH);
      // If the texture size changed we need a fresh texture — the renderer
      // doesn't support resizing a GPU texture in place.
      const sizeChanged = existing !== undefined && (existing.Width !== pxW || existing.Height !== pxH);
      const finalTex = sizeChanged ? this._renderer.CreateTexture(pxW, pxH) : tex;
      this._renderer.UploadSubTexture(finalTex, 0, 0, ctx.canvas);
      this._cache.set(key, { Texture: finalTex, Width: pxW, Height: pxH, Ready: true });
      this._lastSvgDpr.set(key, dpr);
      this._onLoad?.();
    };
    img.onerror = () => {
      this._loading.delete(key);
      URL.revokeObjectURL(url);
      console.warn(`[Jwift] Failed to rasterize SVG: ${key}`);
    };
    img.src = url;
  };

  /** Upload a pre-rendered canvas as an image entry. Synchronous. */
  LoadCanvas = (key: string, canvas: HTMLCanvasElement): void => {
    if (this._cache.has(key)) return;
    const tex = this._renderer.CreateTexture(canvas.width, canvas.height);
    this._renderer.UploadSubTexture(tex, 0, 0, canvas);
    this._cache.set(key, { Texture: tex, Width: canvas.width, Height: canvas.height, Ready: true });
  };

  /** Remove a cached entry. */
  Remove = (key: string): void => {
    this._cache.delete(key);
    this._svgSources.delete(key);
    this._lastSvgDpr.delete(key);
  };

  /** Clear all cached entries. */
  Clear = (): void => {
    this._cache.clear();
    this._svgSources.clear();
    this._lastSvgDpr.clear();
  };

  private _getRasterCtx = (): CanvasRenderingContext2D => {
    if (this._rasterCtx) return this._rasterCtx;
    this._rasterCanvas = document.createElement('canvas');
    const ctx = this._rasterCanvas.getContext('2d');
    if (!ctx) throw new Error('[Jwift] Failed to get 2D context for image rasterization');
    this._rasterCtx = ctx;
    return ctx;
  };
}

/** Helper: replace fill colors in an SVG string. Useful for the logo
 *  coloring component — change specific path fills before rasterizing.
 *  @param svg The SVG markup string
 *  @param replacements Map of old fill color → new fill color (CSS color strings)
 */
export const RecolorSvg = (svg: string, replacements: Record<string, string>): string => {
  let result = svg;
  for (const [from, to] of Object.entries(replacements)) {
    result = result.replaceAll(from, to);
  }
  return result;
};
