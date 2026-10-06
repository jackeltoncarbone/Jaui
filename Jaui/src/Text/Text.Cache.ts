import type { ResolvedTextStyle, TextMeasurement } from './Text.Types';
import { MeasureText, ApplyTextStyle, ComposeFontFamily } from './Text.Measure';
import { HashTextKey } from './Text.Hash';
import { LayoutWords } from './Text.WordLayout';
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
  /** Index into `_shelves` of the shelf this raster sits on. Eviction needs it
   *  to hand the atlas space back — see `_release`. */
  Shelf: number;
  /** False once the cache has dropped it, so a remembered entry is never drawn from space handed back. */
  Resident: boolean;
}

/** What `GetFor` remembers on its holder: the inputs of the last fetch and the entry they gave. */
export interface TextCacheMemo {
  Entry: TextCacheEntry;
  Content: string;
  Style: ResolvedTextStyle;
  MaxWidth: number | null;
  Dpr: number;
}

/** Shelf in the shelf-packing atlas. */
interface AtlasShelf {
  Y: number;           // top pixel row
  Height: number;      // tallest word placed on this shelf
  Cursor: number;      // next free X position
  Live: number;        // entries still pointing into this shelf
}

const ATLAS_SIZE = 2048;
/** Clear device px kept around every raster, so a label drawn at a fractional position never filters in its
 *  atlas neighbour's edge (a stray stroke beside the text). */
const ATLAS_GUTTER = 1;

/** Default entry cap.
 *
 *  Entries are per WORD — `Core/Jaui.ts` `_emitTextFor` fetches one per glyph
 *  run it emits — so a screen of prose is several hundred of them and a dense
 *  page is well past a thousand. The old default of 256 was smaller than one
 *  screen of body text, and the access ORDER is identical every frame, which is
 *  the textbook worst case for LRU: a working set one entry over capacity
 *  cycles the whole cache and hits nothing. Every word then re-measured,
 *  re-rasterized into a resized canvas and re-uploaded to the GPU, every frame.
 *
 *  The ceiling is the atlas, not the counter: 2048² device px hold roughly 1,300
 *  word rasters at dpr 2 (a 17px word is about 60×50 device px) before shelf
 *  waste. The count cap is deliberately set BELOW that so LRU eviction — which
 *  hands shelf space back — is what governs, rather than `_allocate` running
 *  out and wiping the whole atlas mid-frame. */
const MAX_ENTRIES = 1024;

/** The font's own line box, CSS `normal`: about 1.2 em. */
const NORMAL_LINE_HEIGHT = 1.2;
/** How many of those one line of a raster may span before it is a caller's mistake, not a style. A
 *  generous `LineHeight: 2.5` passes; a line height handed over in points where a multiplier belongs
 *  (TokenSentence's 23, a 1,100 device px word at dpr 3) does not. */
const OVERSIZE_LINE_BOXES = 4;

declare const ngDevMode: unknown;
/** Development unless a production build says otherwise: Angular's optimizer defines `ngDevMode` false,
 *  and a host that never defines it (the demo, the tests) is a development host. */
const _isDevBuild = (): boolean => typeof ngDevMode === 'undefined' || !!ngDevMode;

// ─── Raster faces ───
//
// WebKit keeps a canvas's font registry apart from the FontFaceSet: a face can be loaded and added
// and still not be the face `fillText` resolves, until that canvas has referenced it once. The
// measurement contexts are primed for it (`PrimeFontInMeasureCtx`, `PrimeFontInSharedCtx`); the raster
// context the glyphs are actually drawn in is its own registry and needs the same. Every face that
// has finished loading is registered here, and each cache binds the ones it has not seen into its
// raster context before it draws again (`_primeRasterCtx`).

interface RasterFace {
  Family: string;
  Weight: string;
  Style: string;
}

const _rasterFaces: RasterFace[] = [];
const _rasterFaceKeys = new Set<string>();

/** Register a loaded face for every glyph raster context. True when it is new; the next
 *  `TextCache.BeginFrame` binds it and re-rasters whatever was drawn before it was bound. */
export const PrimeFontInRasterCtx = (family: string, weight: string = '400', style: string = 'normal'): boolean => {
  const name = family.trim().replace(/^["']|["']$/g, '');
  if (name === '') return false;
  // A variable face reports a range ("100 900") and an oblique one an angle; the spec takes one token.
  const w = weight.trim().split(/\s+/)[0] || '400';
  const s = style.trim().split(/\s+/)[0] || 'normal';
  const key = `${s} ${w} ${name}`;
  if (_rasterFaceKeys.has(key)) return false;
  _rasterFaceKeys.add(key);
  _rasterFaces.push({ Family: name, Weight: w, Style: s });
  return true;
};

/** Register every face of `fonts` that has finished loading. True when any was new. */
export const PrimeLoadedFontFaces = (fonts: FontFaceSet | null): boolean => {
  if (fonts === null || typeof fonts.forEach !== 'function') return false;
  let added = false;
  try {
    fonts.forEach((face) => {
      if (face.status === 'loaded' && PrimeFontInRasterCtx(face.family, face.weight, face.style)) added = true;
    });
  } catch { /* a set that cannot be walked registers nothing */ }
  return added;
};

/** The FontFaceSet this thread draws with: the document's on the main thread, the worker's own in a worker. */
export const AmbientFontSet = (): FontFaceSet | null => {
  const g = globalThis as { document?: { fonts?: FontFaceSet }; fonts?: FontFaceSet };
  return g.document?.fonts ?? g.fonts ?? null;
};

/** The 256-code-point blocks `content` touches ("0" for Latin-1 alone). A face split by
 *  `unicode-range` loads per block, so a word with "⇔" in it asks for a face "to" never did. */
const _codeBlocks = (content: string): string => {
  let blocks: Set<number> | null = null;
  for (let i = 0; i < content.length; i++) {
    const b = content.charCodeAt(i) >> 8;
    if (b !== 0) (blocks ??= new Set<number>([0])).add(b);
  }
  return blocks === null ? '0' : [...blocks].sort((a, b) => a - b).join(',');
};

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
  /** Atlases a mid-frame rebuild replaced. Draws issued earlier in that frame still sample them, so
   *  they are freed at the next `BeginFrame`, once that frame is behind us. */
  private _retired: GpuTextureHandle[] = [];
  /** Moves whenever rasters are dropped while the atlas texture is kept, so a new raster can land
   *  different pixels under a UV an unchanged glyph instance still carries. */
  private _rasterEpoch = 0;

  // ─── Fonts ───
  /** How many of the registered raster faces this cache's raster context has bound. */
  private _primedFaces = 0;
  /** Face + code-block keys a FontFaceSet load was already asked for, so each is asked once. */
  private _awaitedFonts = new Set<string>();
  private _oversizeLogged = false;

  /** Called right before a mid-frame rebuild replaces the atlas, while every UV handed out so far
   *  still indexes the current texture. The engine drains its pending glyph batch here, so every glyph
   *  already queued this frame draws from the atlas it was resolved against. */
  OnBeforeRebuild: (() => void) | null = null;
  /** A face this cache asked the FontFaceSet for has finished loading after text was already drawn
   *  without it. Its rasters re-raster at the next `BeginFrame`; the engine re-measures. */
  OnFontsReady: (() => void) | null = null;

  constructor(renderer: Renderer, maxEntries: number = MAX_ENTRIES) {
    this._renderer = renderer;
    this._maxEntries = maxEntries;
  }

  get Size(): number { return this._cache.size; }
  get Atlas(): GpuTextureHandle | null { return this._atlas; }
  get RasterEpoch(): number { return this._rasterEpoch; }

  // ── Raster meter ──
  // How many word rasters this cache has cut, and what they cost. The first frame's reading is the
  // glyph-atlas term of the boot gap: every word on screen is measured, drawn to a 2D canvas and
  // uploaded before anything paints, and until this existed that cost was indistinguishable from
  // layout's. Only a cache MISS is timed, so a settled page pays nothing.
  private _rasterCount = 0;
  private _rasterMs = 0;
  get RasterCount(): number { return this._rasterCount; }
  get RasterMs(): number { return this._rasterMs; }

  BeginFrame = (): void => {
    this._frameCounter++;
    this._freeRetired();
    // A face registered since the last frame: bind it into the raster context, then re-raster
    // everything drawn before it was bound, which WebKit drew in a fallback face. Here, at the frame
    // boundary, nothing queued can still be pointing at the space the re-rasters reuse.
    if (this._rasterCtx !== null && this._primedFaces < _rasterFaces.length) {
      this._primeRasterCtx(this._rasterCtx);
      if (this._cache.size > 0) this.Clear();
    }
  };

  Get = (content: string, style: ResolvedTextStyle, maxWidth: number | null, dpr: number): TextCacheEntry => {
    const key = HashTextKey(content, style, dpr, maxWidth);
    const existing = this._cache.get(key);
    if (existing) {
      existing.LastUsed = this._frameCounter;
      return existing;
    }

    const t0 = performance.now();
    const measurement = MeasureText(content, style, maxWidth);
    const entry = this._rasterize(content, style, measurement, maxWidth, dpr);
    this._rasterCount++;
    this._rasterMs += performance.now() - t0;
    this._cache.set(key, entry);

    if (this._cache.size > this._maxEntries) this._evict();
    return entry;
  };

  /** `Get`, remembered on `holder`: drawn again with the same inputs (the same style object), the entry is
   *  the one `Get` would return, without hashing the key. */
  GetFor = (
    holder: { TextCacheMemo?: TextCacheMemo }, content: string, style: ResolvedTextStyle, maxWidth: number | null, dpr: number,
  ): TextCacheEntry => {
    const m = holder.TextCacheMemo;
    if (m !== undefined && m.Entry.Resident && m.Style === style && m.Content === content
      && m.MaxWidth === maxWidth && m.Dpr === dpr) {
      m.Entry.LastUsed = this._frameCounter;
      return m.Entry;
    }
    const entry = this.Get(content, style, maxWidth, dpr);
    if (m === undefined) holder.TextCacheMemo = { Entry: entry, Content: content, Style: style, MaxWidth: maxWidth, Dpr: dpr };
    else { m.Entry = entry; m.Content = content; m.Style = style; m.MaxWidth = maxWidth; m.Dpr = dpr; }
    return entry;
  };

  Dispose = (): void => {
    // The Renderer frees the texture; one from before a lost context is already gone, and freeing it is a no-op.
    if (this._atlas !== null) this._renderer.DeleteTexture(this._atlas);
    this._freeRetired();
    this._atlas = null;
    this._dropAll();
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
    this._dropAll();
    this._shelves.length = 0;
    this._nextShelfY = 0;
  };

  private _dropAll = (): void => {
    for (const entry of this._cache.values()) entry.Resident = false;
    this._cache.clear();
    this._rasterEpoch++;
  };

  private _freeRetired = (): void => {
    if (this._retired.length === 0) return;
    for (const texture of this._retired) this._renderer.DeleteTexture(texture);
    this._retired.length = 0;
  };

  private _ensureAtlas = (): GpuTextureHandle => {
    if (this._atlas) return this._atlas;
    this._atlas = this._renderer.CreateTexture(this._atlasSize, this._atlasSize);
    return this._atlas;
  };

  private _allocate = (pxW: number, pxH: number): { X: number; Y: number; Shelf: number } => {
    const found = this._tryAllocate(pxW, pxH);
    if (found) return found;

    // Out of room. Before doing anything drastic, hand back the space held by
    // rasters nobody drew this frame — `_release` resets a shelf the moment its
    // last entry goes, so this recovers whole contiguous strips rather than
    // holes. Without it, eviction dropped Map entries and left the cursors
    // where they were: the pixels were gone for good and the atlas could only
    // ever fill up.
    this._reclaim();
    const afterReclaim = this._tryAllocate(pxW, pxH);
    if (afterReclaim) return afterReclaim;

    // Everything in the atlas was drawn THIS frame and it still doesn't fit —
    // one frame is asking for more glyph raster than 2048² device pixels hold.
    // Entries already handed out this frame keep UVs into the texture about to
    // be replaced, so the engine drains them first, against that texture, and
    // the texture outlives the frame (`_retired`). Still said out loud: a frame
    // that needs a whole atlas of words is usually a mis-scaled caller.
    console.warn(
      `[Jaui] Text atlas exhausted by a single frame (${this._cache.size} live rasters); rebuilding.`,
    );
    this.OnBeforeRebuild?.();
    this._rebuildAtlas();
    const shelf: AtlasShelf = { Y: 0, Height: pxH, Cursor: pxW, Live: 1 };
    this._shelves.push(shelf);
    this._nextShelfY = pxH;
    return { X: 0, Y: 0, Shelf: 0 };
  };

  private _tryAllocate = (pxW: number, pxH: number): { X: number; Y: number; Shelf: number } | null => {
    const size = this._atlasSize;

    for (let i = 0; i < this._shelves.length; i++) {
      const shelf = this._shelves[i];
      if (shelf.Cursor + pxW <= size && shelf.Height >= pxH) {
        const x = shelf.Cursor;
        shelf.Cursor += pxW;
        shelf.Live++;
        return { X: x, Y: shelf.Y, Shelf: i };
      }
    }

    if (this._nextShelfY + pxH <= size) {
      const shelf: AtlasShelf = { Y: this._nextShelfY, Height: pxH, Cursor: pxW, Live: 1 };
      this._shelves.push(shelf);
      const origin = { X: 0, Y: this._nextShelfY, Shelf: this._shelves.length - 1 };
      this._nextShelfY += pxH;
      return origin;
    }

    return null;
  };

  /** Drop the entry's claim on its shelf. A shelf with no live entries has no
   *  UV pointing into it, so its cursor rewinds and the strip is allocatable
   *  again — stale pixels there are overwritten by the next upload. */
  private _release = (entry: TextCacheEntry): void => {
    entry.Resident = false;
    const shelf = this._shelves[entry.Shelf];
    if (!shelf) return;
    shelf.Live--;
    if (shelf.Live <= 0) {
      shelf.Live = 0;
      shelf.Cursor = 0;
      this._trimTrailingShelves();
    }
  };

  /** Hand back the empty shelves at the bottom of the atlas as unclaimed rows. An emptied shelf keeps
   *  its height, so one tall raster (a mis-scaled word 1,100 px high) went on holding its whole strip
   *  for words that fit in a twentieth of it, and nothing taller than the strip could ever have it
   *  back. Popping is safe: no resident entry indexes an empty shelf. */
  private _trimTrailingShelves = (): void => {
    const shelves = this._shelves;
    while (shelves.length > 0 && shelves[shelves.length - 1].Live === 0) shelves.pop();
    const last = shelves[shelves.length - 1];
    this._nextShelfY = last ? last.Y + last.Height : 0;
  };

  /** Evict every entry that wasn't drawn this frame. Called only when the
   *  packer is out of room — the ordinary path is `_evict`'s LRU trim. */
  private _reclaim = (): void => {
    for (const [key, entry] of this._cache) {
      if (entry.LastUsed >= this._frameCounter) continue;
      this._release(entry);
      this._cache.delete(key);
    }
  };

  private _rebuildAtlas = (): void => {
    this._dropAll();
    this._shelves.length = 0;
    this._nextShelfY = 0;
    // Retired, not freed: draws issued earlier this frame still sample it. Dropping the reference
    // instead leaked the whole 2048² texture, 16 MiB of GPU memory, on every rebuild.
    if (this._atlas !== null) this._retired.push(this._atlas);
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
    this._checkOversize(content, style, measurement, dpr, pxW, pxH);
    this._awaitFonts(content, style);

    const ctx = this._getRasterCtx();
    const canvas = ctx.canvas;
    canvas.width = pxW + 2 * ATLAS_GUTTER;
    canvas.height = pxH + 2 * ATLAS_GUTTER;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(ATLAS_GUTTER, ATLAS_GUTTER);
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

    // Upload to atlas via Renderer. The texture is read AFTER the allocation: an allocation that
    // rebuilt the atlas placed this raster in the new texture, and uploading it to the one fetched
    // before left the word that tipped the rebuild drawing from an empty slot.
    const origin = this._allocate(canvas.width, canvas.height);
    this._renderer.UploadSubTexture(this._ensureAtlas(), origin.X, origin.Y, canvas);

    const size = this._atlasSize;
    return {
      Uv: {
        U: (origin.X + ATLAS_GUTTER) / size,
        V: (origin.Y + ATLAS_GUTTER) / size,
        UWidth: pxW / size,
        UHeight: pxH / size,
      },
      Width: pxW,
      Height: pxH,
      CssWidth: cssW,
      CssHeight: cssH,
      Measurement: measurement,
      LastUsed: this._frameCounter,
      Shelf: origin.Shelf,
      Resident: true,
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
    // Every face already loaded is bound before the first glyph is drawn.
    this._primeRasterCtx(ctx);
    return ctx;
  };

  /** Bind every registered face this context has not referenced yet: set it and draw with it once.
   *  The context is resized (and so cleared) before each raster, so the priming ink never lands. */
  private _primeRasterCtx = (ctx: OffscreenCanvasRenderingContext2D): void => {
    for (; this._primedFaces < _rasterFaces.length; this._primedFaces++) {
      const face = _rasterFaces[this._primedFaces];
      try {
        ctx.font = `${face.Style} ${face.Weight} 16px "${face.Family}"`;
        ctx.measureText('Mg');
        ctx.fillText('Mg', 0, 0);
      } catch { /* invalid spec — skip */ }
    }
  };

  /** Ask the thread's FontFaceSet for the faces `style` draws `content` with, once per face and code
   *  block. WebKit's canvas does not load a declared web face by itself, so without this a face nothing
   *  in the DOM used was never fetched at all. The raster goes ahead in whatever is loaded now; a face
   *  that arrives because of the ask is registered, which re-rasters at the next `BeginFrame`
   *  everything drawn before it, and `OnFontsReady` has the engine re-measure. */
  private _awaitFonts = (content: string, style: ResolvedTextStyle): void => {
    const fonts = AmbientFontSet();
    if (fonts === null || typeof fonts.load !== 'function') return;
    const italic = style.FontStyle === 'Italic' ? 'italic ' : '';
    const spec = `${italic}${style.FontWeight} 16px ${ComposeFontFamily(style.FontFamily)}`;
    const key = `${spec}|${_codeBlocks(content)}`;
    if (this._awaitedFonts.has(key)) return;
    this._awaitedFonts.add(key);
    let pending: Promise<FontFace[]>;
    try { pending = fonts.load(spec, content); } catch { return; }
    pending.then((faces) => {
      let added = false;
      for (const face of faces) {
        if (face.status === 'loaded' && PrimeFontInRasterCtx(face.family, face.weight, face.style)) added = true;
      }
      if (added) this.OnFontsReady?.();
    }, () => { /* a face that failed stays failed: the fallback it drew in is final */ });
  };

  /** One line of a raster spanning several of the font's own line boxes is a caller handing over a
   *  length where a multiplier belongs — said once, in development, with the word and its size. Such
   *  a raster fills the atlas in a few dozen words, and the rebuild that follows is what hid it. */
  private _checkOversize = (
    content: string, style: ResolvedTextStyle, measurement: TextMeasurement, dpr: number, pxW: number, pxH: number,
  ): void => {
    if (this._oversizeLogged || !(style.FontSize > 0)) return;
    const lineBox = NORMAL_LINE_HEIGHT * style.FontSize * dpr;
    const linePx = pxH / Math.max(1, measurement.Lines.length);
    if (linePx <= OVERSIZE_LINE_BOXES * lineBox || !_isDevBuild()) return;
    this._oversizeLogged = true;
    console.warn(
      `[Jaui] Glyph image for "${content}" is ${pxW}×${pxH} device px, ${(linePx / lineBox).toFixed(1)}× its font's `
      + `line box (FontSize ${style.FontSize}, LineHeight ${style.LineHeight}, dpr ${dpr}). LineHeight is a `
      + 'multiplier of FontSize, not a length.',
    );
  };

  private _evict = (): void => {
    const entries = Array.from(this._cache.entries());
    entries.sort((a, b) => a[1].LastUsed - b[1].LastUsed);
    const dropCount = Math.ceil(entries.length * 0.25);
    for (let i = 0; i < dropCount; i++) {
      const [key, entry] = entries[i];
      // Never a raster drawn this frame: a glyph already queued holds its UV, and the next upload
      // could land on the space its release hands back. A frame of more words than the cap simply
      // runs over it until the next frame's trim.
      if (entry.LastUsed >= this._frameCounter) break;
      this._release(entry);
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
