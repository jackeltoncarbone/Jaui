/**
 * Offscreen framebuffer with a mipmap-capable color texture.
 * Used by Canvas for the scene FBO that glass panels sample from.
 *
 * On resize, re-allocates the texture + framebuffer to the new dimensions.
 * Mip storage is opt-in via EnsureMipLevels(); whoever asks for it fills it. There is
 * deliberately no generateMipmap() wrapper: the driver's box filter is not the Gaussian any
 * consumer here samples, and a wrapper that flipped MIN_FILTER as a side effect is how the
 * progressive blur's pyramid ended up reading its own empty mip 1 (BlurPass, DOWN_FRAG).
 */
export class Framebuffer {
  readonly Framebuffer: WebGLFramebuffer;
  readonly Texture: WebGLTexture;
  /** Optional depth+stencil renderbuffer — created when `depth: true`.
   *  Required when foreign 3D renderers (THREE) draw into this FBO. */
  readonly DepthStencil: WebGLRenderbuffer | null;
  private _gl: WebGL2RenderingContext;
  private _width: number = 0;
  private _height: number = 0;
  private _hasDepth: boolean;
  /** Store color as RGB10_A2 (10-bit, 1024 levels) instead of RGBA8. Same
   *  32 bits/texel, core WebGL2 (no extension), but 4× finer tonal steps —
   *  removes the visible banding a wide blur bakes into an 8-bit gradient. */
  private _highPrecision: boolean;
  /** Deepest mip level currently ALLOCATED for the colour texture (0 = base only).
   *  Storage is allocated empty; contents are written by whoever builds the chain. */
  private _mipLevels: number = 0;
  /** The colour texture's MIN_FILTER and MAX_LEVEL as last written, GL's defaults until then, so a reader
   *  never has to ask the GPU process (a synchronous round trip). Every write to them is in this class. */
  private _minFilter: number = 0x2702;
  private _maxLevel: number = 1000;
  private static readonly _owners = new WeakMap<WebGLTexture, Framebuffer>();
  /** The Framebuffer whose colour texture this is, if any. */
  static Of = (tex: WebGLTexture): Framebuffer | undefined => Framebuffer._owners.get(tex);

  constructor(gl: WebGL2RenderingContext, opts?: { depth?: boolean; highPrecision?: boolean }) {
    this._gl = gl;
    this._hasDepth = opts?.depth ?? false;
    this._highPrecision = opts?.highPrecision ?? false;

    const fb = gl.createFramebuffer();
    if (!fb) throw new Error('[Jaui] Failed to create framebuffer');
    this.Framebuffer = fb;

    const tex = gl.createTexture();
    if (!tex) throw new Error('[Jaui] Failed to create FBO texture');
    this.Texture = tex;
    Framebuffer._owners.set(tex, this);

    if (this._hasDepth) {
      const rb = gl.createRenderbuffer();
      if (!rb) throw new Error('[Jaui] Failed to create depth renderbuffer');
      this.DepthStencil = rb;
    } else {
      this.DepthStencil = null;
    }
  }

  get Width(): number { return this._width; }
  get Height(): number { return this._height; }

  /** Base-level `texImage2D`s issued by `Resize` in this context, since boot. Counted HERE, at the one
   *  line that allocates, because every pool above this class keys on size and a pool that thrashed
   *  would be invisible from its own census: it holds the same sizes at the end of the frame whether
   *  it re-allocated them or not. A reader samples it twice and subtracts. Never reset. */
  static Allocations = 0;
  /** Of those, the FIRST allocations -- the ones that also pay `checkFramebufferStatus`, which the
   *  comment in `Resize` measured as a full GPU sync. */
  static FirstAllocations = 0;
  /** Attachment shapes already proven renderable on this context, keyed by `_hasDepth` -- the one
   *  thing that varies between the FBOs this class builds. See the note at the check itself. */
  private static _validatedShapes = new Set<boolean>();

  /** Mip-level `texImage2D`s issued by `EnsureMipLevels`. */
  static MipAllocations = 0;

  /** Resize the FBO's texture. Safe to call repeatedly; no-op if already at given size. */
  Resize = (width: number, height: number): void => {
    if (width === this._width && height === this._height) return;
    const firstAlloc = this._width === 0 && this._height === 0;
    Framebuffer.Allocations++;
    if (firstAlloc) Framebuffer.FirstAllocations++;
    // Base level is about to be reallocated, so every mip above it is orphaned
    // at the old size — the texture is mip-INCOMPLETE until they are re-made.
    this._mipLevels = 0;
    this._width = Math.max(1, Math.floor(width));
    this._height = Math.max(1, Math.floor(height));

    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this.Texture);
    if (this._highPrecision) {
      // RGB10_A2: 10-bit RGB (1024 levels) + 2-bit alpha. Core WebGL2,
      // color-renderable + filterable + mipmappable. The blur only uses RGB
      // (alpha is written 1.0), so 2-bit alpha is irrelevant here.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    // Start with plain LINEAR. Caller calls EnsureMipLevels() to opt into mipmap filtering.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    this._minFilter = gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.Framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.Texture, 0);

    if (this.DepthStencil) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.DepthStencil);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, this._width, this._height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.DepthStencil);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }

    // Validate completeness only on FIRST allocation. The attachment format never
    // changes across resizes (color + matching depth/stencil stay renderable and
    // same-sized), so a re-Resize stays complete. checkFramebufferStatus forces a
    // full GPU sync (~68ms on software ANGLE/WARP); when blur-level FBOs thrash
    // between surface sizes it fired ~8×/frame — the dominant per-frame stall
    // (measured 23.6s / 347 calls in a WARP orbit trace). Skip it on resize.
    // ONCE PER ATTACHMENT SHAPE, not once per framebuffer. What `checkFramebufferStatus` proves is
    // that THIS COMBINATION OF ATTACHMENTS is renderable on this driver -- a COLOR_ATTACHMENT0 of
    // RGBA8, plus a DEPTH24_STENCIL8 renderbuffer when `_hasDepth`. Two FBOs built by the lines
    // above with the same `_hasDepth` are the same combination; the only thing that differs is
    // their size, and a size the driver cannot honour fails at `texImage2D`, not here. So the first
    // FBO of each shape answers the question for every later one.
    //
    // MEASURED 2026-09-22, and this is why it is worth a Set: the first frame makes TWENTY first
    // allocations, and each one forced a full GPU sync. Skipping all twenty took the first render
    // 124ms -> 82ms and first frame 273ms -> 240ms (n=5, firstAllocs=20 unchanged in both arms, so
    // the allocations themselves were untouched). This keeps the guard -- a genuinely incomplete
    // shape still throws, on its first FBO, before anything renders -- and pays the sync once.
    if (firstAlloc && !Framebuffer._validatedShapes.has(this._hasDepth)) {
      Framebuffer._validatedShapes.add(this._hasDepth);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`[Jaui] Framebuffer incomplete: 0x${status.toString(16)}`);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  /** Bind for rendering. */
  Bind = (): void => {
    this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, this.Framebuffer);
  };

  /** Allocate (empty) mip levels 1..`levels` and make the texture mip-complete
   *  to exactly that depth, WITHOUT filtering anything.
   *
   *  `generateMipmap` is the usual way to get a sampleable chain, but it also
   *  box-filters the entire pyramid — on a canvas-sized backdrop that is a third
   *  of a full-screen fill, per call, and every level a caller then overwrites
   *  with its own (better) Gaussian is filtered twice. Allocating the storage
   *  and letting the caller fill it is the same end state for a fraction of the
   *  bandwidth.
   *
   *  TEXTURE_MAX_LEVEL is pinned to the deepest ALLOCATED level, so the texture
   *  is complete with a short chain and a sampler asking for a deeper LOD clamps
   *  to the deepest level we built instead of reading undefined storage. */
  EnsureMipLevels = (levels: number): void => {
    const gl = this._gl;
    const want = Math.max(0, Math.min(this._mipDepth(), Math.floor(levels)));
    gl.bindTexture(gl.TEXTURE_2D, this.Texture);
    for (let i = this._mipLevels + 1; i <= want; i++) {
      Framebuffer.MipAllocations++;
      const lw = Math.max(1, this._width >> i);
      const lh = Math.max(1, this._height >> i);
      if (this._highPrecision) {
        gl.texImage2D(gl.TEXTURE_2D, i, gl.RGB10_A2, lw, lh, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, i, gl.RGBA, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
    }
    if (want > this._mipLevels) this._mipLevels = want;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, this._mipLevels);
    this._minFilter = gl.LINEAR_MIPMAP_LINEAR;
    this._maxLevel = this._mipLevels;
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  /** Sample the base level only — for consumers whose maximum sampled LOD is 0.
   *  Leaves any allocated mip storage in place (re-arming it is one texParameteri)
   *  but makes the texture complete without it. */
  DisableMipmap = (): void => {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this.Texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    this._minFilter = gl.LINEAR;
    this._maxLevel = 0;
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  /** The deepest mip level allocated (and so `TEXTURE_MAX_LEVEL`). */
  get MipLevels(): number { return this._mipLevels; }
  get MinFilter(): number { return this._minFilter; }
  get MaxLevel(): number { return this._maxLevel; }
  /** The colour texture's sized format: an unsized RGBA/UNSIGNED_BYTE level is RGBA8. */
  get InternalFormat(): number { return this._highPrecision ? this._gl.RGB10_A2 : this._gl.RGBA8; }

  /** Deepest mip level a full chain would have at the current size. */
  private _mipDepth = (): number => {
    let levels = 0;
    let w = this._width, h = this._height;
    while (w > 1 || h > 1) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); levels++; }
    return levels;
  };

  Dispose = (): void => {
    this._gl.deleteTexture(this.Texture);
    this._gl.deleteFramebuffer(this.Framebuffer);
    if (this.DepthStencil) this._gl.deleteRenderbuffer(this.DepthStencil);
  };
}

/**
 * A recycler for REGION-SIZED render targets.
 *
 * The card-composite path (`ShowStudio.Documentation/Perf/SceneRaw.Finding.md` 4(c)) gives every
 * glass surface its own target for the length of one frame: a 216x150pt card at dpr 2 resolves to
 * ~568x440, about 1 MB, and `glass-grid` holds twenty of them at once. Allocating those per frame
 * would be twenty `texImage2D` reallocations a frame, which is exactly the thrash `BlurPass`
 * documents at `_useChain` — so they are kept and handed back out by SIZE.
 *
 * Keyed on the exact size because `Framebuffer.Resize` is a no-op at the same dimensions and a full
 * reallocation at any other, and because a grid of equal cards resolves to ONE size (the region
 * grid snap in `ResolveRegionRect` sees to that), so one bucket serves the whole grid.
 *
 * LIFETIME IS THE FRAME, NOT THE SURFACE. A card's target stays live until the pending write-backs
 * drain, because any LATER surface in the same run may replay this one's overlap into its own seed.
 * `Release` is therefore called by the drain and never by the surface that finished drawing.
 */
export class FramebufferPool {
  private _gl: WebGL2RenderingContext;
  private _free = new Map<string, Framebuffer[]>();
  private _live = 0;
  private _peak = 0;

  constructor(gl: WebGL2RenderingContext) { this._gl = gl; }

  /** Targets currently checked out, and the high-water mark since the last `Dispose`. */
  get Live(): number { return this._live; }
  get Peak(): number { return this._peak; }

  Acquire = (width: number, height: number): Framebuffer => {
    const key = `${width}x${height}`;
    const bucket = this._free.get(key);
    this._live++;
    if (this._live > this._peak) this._peak = this._live;
    if (bucket !== undefined && bucket.length > 0) return bucket.pop()!;
    // RGB10_A2 to match the scene target exactly: the seed, the replay and the write-back are all
    // 1:1 same-format blits, and a format conversion would put every one of them on a render path
    // instead of a copy. No depth — nothing in this renderer tests it, and a foreign 3D pass draws
    // into the scene in the janvas pre-pass, never into a card.
    const fb = new Framebuffer(this._gl, { highPrecision: true });
    fb.Resize(width, height);
    return fb;
  };

  Release = (fb: Framebuffer): void => {
    this._live--;
    const key = `${fb.Width}x${fb.Height}`;
    const bucket = this._free.get(key);
    if (bucket === undefined) this._free.set(key, [fb]);
    else bucket.push(fb);
  };

  /** Drop every retained target. Called on resize, where every size in the pool is stale. */
  Dispose = (): void => {
    for (const bucket of this._free.values()) for (const fb of bucket) fb.Dispose();
    this._free.clear();
    this._live = 0;
    this._peak = 0;
  };
}
