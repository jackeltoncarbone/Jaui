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
  /** Every texel is alpha 1: a JPEG (no alpha channel exists), or a one-time scan found no
   *  transparent pixel. `?occlusion` lets such an image stand as a COVERER -- what is fully under it
   *  is not drawn. Absent means unknown, which is never opaque. */
  Opaque?: boolean;
}

/** Largest image the load path will scan for alpha, in pixels. A scan is one `getImageData` on the
 *  worker, once per image; past this a non-JPEG is simply left unknown (not a coverer). */
const OPAQUE_SCAN_MAX_PX = 2_500_000;

const _HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const _FETCHABLE_SCHEME = /^(https?|data|blob|file):/i;
/** Is this source something the network can actually take? A relative path is; so is http/https/data/
 *  blob/file. `ss-logo:#f09dcc` is NOT — it is an image-cache KEY whose pixels are handed in under that
 *  key by LoadSvg / LoadBitmap / LoadCanvas, and fetching it can only ever fail. */
const _isFetchable = (url: string): boolean => !_HAS_SCHEME.test(url) || _FETCHABLE_SCHEME.test(url);

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
  /** Keys that are not URLs at all (see `_isFetchable`). Held so the per-frame auto-load tests each
   *  one once rather than re-parsing it every tick. */
  private _keyed = new Set<string>();
  private _svgSources = new Map<string, _SvgSource>();
  private _lastSvgDpr = new Map<string, number>();
  private _rasterCanvas: OffscreenCanvas | null = null;
  private _rasterCtx: OffscreenCanvasRenderingContext2D | null = null;

  private _onLoad: (() => void) | null = null;
  private _onLoadStart: ((url: string) => void) | null = null;
  private _onLoadFinish: ((url: string) => void) | null = null;
  private _onLoadFail: ((url: string) => void) | null = null;

  /** Concurrency cap on fetch+decode+upload. A homepage gallery of 30
   *  cards entering viewport at once would otherwise:
   *    1. Fire 30 simultaneous `fetch` requests (~6 in-flight max anyway
   *       per HTTP/2 host, so the rest queue at the network layer).
   *    2. Run 30 concurrent `createImageBitmap` decodes on Chrome's
   *       image-decoder pool — saturates CPU.
   *    3. Land 30 sequential `gl.texImage2D` calls on the worker's GL
   *       context, each stealing a frame's worth of budget — drops the
   *       worker to single-digit FPS until the queue digests.
   *  Capping to 6 keeps the worker GL queue moving at a sane pace while
   *  letting the network layer parallelize where it can. Queued URLs
   *  resume in FIFO order as slots free up. */
  private static readonly _CONCURRENCY_CAP = 6;
  private _inFlight = 0;
  private readonly _queue: Array<{ url: string; dpr: number }> = [];

  constructor(renderer: Renderer) {
    this._renderer = renderer;
  }

  /** Called when any image finishes loading. Canvas uses this to trigger
   *  a layout re-solve (image intrinsic sizes may have become available). */
  set OnLoad(callback: (() => void) | null) { this._onLoad = callback; }

  /** Called when a URL starts loading — fires when the network fetch
   *  actually kicks off (so a queued URL doesn't fire until a slot opens).
   *  Consumers use this to flip the Loading framework state on every Jiv
   *  whose ImageSrc matches. Idempotent on repeat-loads of an already-
   *  cached URL — the cache short-circuits before this fires. */
  set OnLoadStart(callback: ((url: string) => void) | null) { this._onLoadStart = callback; }

  /** Called when a URL has successfully bound to a GPU texture and the
   *  cache entry is Ready. Counterpart to OnLoadStart; toggles Loading
   *  off and Loaded on. */
  set OnLoadFinish(callback: ((url: string) => void) | null) { this._onLoadFinish = callback; }

  /** Called when a URL fails to fetch / decode. Stays in `_failed` so the
   *  per-frame auto-load doesn't retry. Consumers flip Failed state. */
  set OnLoadFail(callback: ((url: string) => void) | null) { this._onLoadFail = callback; }

  /** A key whose pixels just landed. Clears any Failed verdict left by an earlier fetch and fires
   *  OnLoadFinish on the TRANSITION only — video frames re-upload under the same key every frame and
   *  must not walk the tree each time. */
  private _settle = (key: string, wasReady: boolean): void => {
    this._failed.delete(key);
    this._keyed.delete(key);
    if (!wasReady) this._onLoadFinish?.(key);
  };

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
  LoadUrl = (url: string, dpr: number = 1): void => {
    if (this._cache.has(url)) return;
    if (this._loading.has(url)) return;
    if (this._failed.has(url)) return;
    if (this._keyed.has(url)) return;
    // An engine KEY, not a URL: its pixels arrive under the key from LoadSvg / LoadBitmap. Fetching it
    // spends a request and a console error per key, and leaves every Jiv bound to it stuck in Failed.
    if (!_isFetchable(url)) { this._keyed.add(url); return; }
    // Mark the URL as loading immediately so subsequent LoadUrl calls
    // for the same URL coalesce — even if the actual fetch is sitting
    // in the queue, repeat consumers shouldn't double-enqueue.
    this._loading.add(url);
    if (this._inFlight < ImageCache._CONCURRENCY_CAP) {
      this._startFetch(url, dpr);
    } else {
      this._queue.push({ url, dpr });
    }
  };

  /** Fetches running, and fetches waiting behind the concurrency cap. Read by the first-frame trace:
   *  decoding is fully async — a finished bitmap asks for a frame, nothing waits on one — and these
   *  two numbers are what turn that claim into a reading. */
  get InFlight(): number { return this._inFlight; }
  get Queued(): number { return this._queue.length; }

  /** Pull the next queued URL (FIFO) and start its fetch. Called whenever
   *  an in-flight load resolves (success OR failure). */
  private _drainQueue = (): void => {
    while (this._inFlight < ImageCache._CONCURRENCY_CAP && this._queue.length > 0) {
      const next = this._queue.shift()!;
      this._startFetch(next.url, next.dpr);
    }
  };

  private _startFetch = (url: string, _dpr: number): void => {
    this._inFlight++;
    // Fire the lifecycle start callback now — engine wants the Loading
    // state to flip when the fetch ACTUALLY kicks (not when the URL was
    // queued), so a card waiting behind a 5-slot backlog stays in its
    // unloaded styling until its turn comes up.
    this._onLoadStart?.(url);
    const isDataUrl = url.startsWith('data:');
    const init: RequestInit = isDataUrl ? {} : { mode: 'cors', credentials: 'omit' };
    fetch(url, init)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(b => createImageBitmap(b).then(bmp => ({ bmp, jpeg: b.type === 'image/jpeg' })))
      .then(({ bmp, jpeg }) => {
        this._loading.delete(url);
        const w = bmp.width;
        const h = bmp.height;
        const opaque = jpeg || this._scanOpaque(bmp);
        const tex = this._renderer.CreateTexture(w, h);
        this._renderer.UploadSubTexture(tex, 0, 0, bmp);
        bmp.close();
        this._cache.set(url, { Texture: tex, Width: w, Height: h, Ready: true, Opaque: opaque });
        this._inFlight--;
        this._onLoadFinish?.(url);
        this._onLoad?.();
        this._drainQueue();
      })
      .catch(err => {
        this._loading.delete(url);
        this._failed.add(url);
        this._inFlight--;
        console.warn(`[Jaui] Failed to load image: ${url.slice(0, 80)} (${(err as Error).message})`);
        this._onLoadFail?.(url);
        this._drainQueue();
      });
  };

  /** True only if every pixel of `bmp` has alpha 255. Exact, and once per image; an image past
   *  `OPAQUE_SCAN_MAX_PX` or a canvas that cannot be read answers false (unknown). */
  private _scanOpaque = (bmp: ImageBitmap): boolean => {
    const w = bmp.width, h = bmp.height;
    if (w * h > OPAQUE_SCAN_MAX_PX || w * h === 0) return false;
    try {
      const ctx = this._getRasterCtx();
      ctx.canvas.width = w;
      ctx.canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) return false;
      return true;
    } catch {
      return false;
    }
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
        this._settle(key, existing?.Ready === true);
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
    // Re-uploading the same key replaces the texture's pixels IN PLACE rather
    // than no-op'ing. This is what lets a keyed SVG (see SvgJiv) behave like a
    // normal SVG: when a bound attribute changes, the source re-rasterizes and
    // re-uploads under the SAME key, so the Jiv's Background URL never changes
    // — no new image load, no placeholder cross-fade, just updated pixels.
    const existing = this._cache.get(key);
    if (existing && existing.Width === bitmap.width && existing.Height === bitmap.height) {
      // Same dimensions — reuse the GPU texture so the handle (and the Jiv's
      // bound URL) stays identical; only the contents change.
      this._renderer.UploadSubTexture(existing.Texture, 0, 0, bitmap);
      const wasReady = existing.Ready;
      existing.Ready = true;
      bitmap.close?.();
      this._settle(key, wasReady);
      this._onLoad?.();
      return;
    }
    const tex = this._renderer.CreateTexture(bitmap.width, bitmap.height);
    this._renderer.UploadSubTexture(tex, 0, 0, bitmap);
    this._cache.set(key, { Texture: tex, Width: bitmap.width, Height: bitmap.height, Ready: true });
    bitmap.close?.();
    this._settle(key, false);
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
    this._settle(key, false);
  };

  /** Remove a cached entry. */
  Remove = (key: string): void => {
    this._cache.delete(key);
    this._svgSources.delete(key);
    this._lastSvgDpr.delete(key);
    this._failed.delete(key);
    this._keyed.delete(key);
  };

  /** Clear all cached entries. */
  Clear = (): void => {
    this._cache.clear();
    this._svgSources.clear();
    this._lastSvgDpr.clear();
    this._failed.clear();
    this._keyed.clear();
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
