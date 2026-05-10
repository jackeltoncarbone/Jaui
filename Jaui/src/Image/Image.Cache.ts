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
  /** Keys that failed to load — prevents the renderer's per-frame auto-load
   *  from retrying a broken URL every tick (which otherwise spams the console
   *  with thousands of 404s over a few seconds). */
  private _failed = new Set<string>();
  private _svgSources = new Map<string, _SvgSource>();
  private _lastSvgDpr = new Map<string, number>();
  private _rasterCanvas: OffscreenCanvas | null = null;
  private _rasterCtx: OffscreenCanvasRenderingContext2D | null = null;

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
   *  becomes Ready when the image finishes loading. Failed loads are
   *  remembered so a subsequent call for the same URL is a no-op.
   *
   *  Worker-safe path: `fetch → blob → createImageBitmap` instead of
   *  `new Image()`. ImageBitmap is a TexImageSource the renderer uploads
   *  directly (no rasterCanvas round-trip), and it works in workers.
   *  `mode:'cors'` matches the previous `crossOrigin = 'anonymous'`. */
  LoadUrl = (url: string, _dpr: number = 1): void => {
    const isDataUrl = url.startsWith('data:');
    if (this._cache.has(url)) return;
    if (this._loading.has(url)) return;
    if (this._failed.has(url)) return;
    this._loading.add(url);

    const init: RequestInit = isDataUrl ? {} : { mode: 'cors', credentials: 'omit' };
    fetch(url, init)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(b => createImageBitmap(b))
      .then(bmp => {
        this._loading.delete(url);
        const w = bmp.width;
        const h = bmp.height;
        const tex = this._renderer.CreateTexture(w, h);
        this._renderer.UploadSubTexture(tex, 0, 0, bmp);
        bmp.close();
        this._cache.set(url, { Texture: tex, Width: w, Height: h, Ready: true });
        this._onLoad?.();
      })
      .catch(err => {
        this._loading.delete(url);
        this._failed.add(url);
        console.warn(`[Jaui] Failed to load image: ${url.slice(0, 80)} (${(err as Error).message})`);
      });
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
   *  was used last time. Called by Jaui when `devicePixelRatio` changes
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

    // Worker-safe: pass the SVG blob directly to createImageBitmap (no
    // Image() element, no object URL). The decoded ImageBitmap has the
    // SVG's intrinsic size; we still scale to (pxW, pxH) via drawImage
    // because `resizeWidth/resizeHeight` on createImageBitmap is not
    // universally honored for SVG sources.
    const blob = new Blob([src.SvgString], { type: 'image/svg+xml' });
    createImageBitmap(blob)
      .then(bmp => {
        this._loading.delete(key);

        const ctx = this._getRasterCtx();
        ctx.canvas.width = pxW;
        ctx.canvas.height = pxH;
        ctx.clearRect(0, 0, pxW, pxH);
        ctx.drawImage(bmp, 0, 0, pxW, pxH);
        bmp.close();

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
      })
      .catch(err => {
        this._loading.delete(key);
        console.warn(`[Jaui] Failed to rasterize SVG: ${key} (${(err as Error).message})`);
      });
  };

  /** Upload a pre-rasterized ImageBitmap as an image entry. Synchronous.
   *  Used by the worker bridge for SVGs decoded on the main thread (Chrome
   *  workers can't decode SVG via createImageBitmap). The bitmap is
   *  consumed and `.close()`d after upload. */
  LoadBitmap = (key: string, bitmap: ImageBitmap): void => {
    if (this._cache.has(key)) {
      bitmap.close?.();
      return;
    }
    const tex = this._renderer.CreateTexture(bitmap.width, bitmap.height);
    this._renderer.UploadSubTexture(tex, 0, 0, bitmap);
    this._cache.set(key, { Texture: tex, Width: bitmap.width, Height: bitmap.height, Ready: true });
    bitmap.close?.();
    this._onLoad?.();
  };

  /** Upload a pre-rendered canvas as an image entry. Synchronous.
   *  Accepts OffscreenCanvas as well so worker-side callers can pass the
   *  same kind of surface they rasterize into. */
  LoadCanvas = (key: string, canvas: HTMLCanvasElement | OffscreenCanvas): void => {
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
    this._failed.delete(key);
  };

  /** Clear all cached entries. */
  Clear = (): void => {
    this._cache.clear();
    this._svgSources.clear();
    this._lastSvgDpr.clear();
    this._failed.clear();
  };

  private _getRasterCtx = (): OffscreenCanvasRenderingContext2D => {
    if (this._rasterCtx) return this._rasterCtx;
    // OffscreenCanvas: works on main thread + in workers. Initial size is
    // 1×1; per-image rasterize calls resize via .width/.height before draw.
    this._rasterCanvas = new OffscreenCanvas(1, 1);
    // willReadFrequently signals the browser to back this canvas with a
    // CPU-side buffer instead of the GPU. Avatar / image rasterization
    // calls getImageData on every load — without this hint Chrome warns
    // and the GPU readback path is significantly slower.
    const ctx = this._rasterCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('[Jaui] Failed to get 2D context for image rasterization');
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
