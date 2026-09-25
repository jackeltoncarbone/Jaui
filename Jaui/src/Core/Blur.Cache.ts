/**
 * `?blur-cache` -- A GLASS SURFACE WHOSE BACKDROP DID NOT CHANGE THIS FRAME DOES NOT REBUILD ITS BLUR.
 *
 * Pure bookkeeping, no GL, for the reason `Scene.Ledger` and `Occlusion` are their own modules: it
 * has to be unit-tested without `WebGL2.Renderer`, whose shader imports only resolve after a build.
 * The walk (`Core/Jaui.ts`) owns the one `PaintLedger` and every call into it; the renderer owns the
 * cached textures.
 *
 * ── WHAT "THE BACKDROP DID NOT CHANGE" MEANS, EXACTLY ─────────────────────────────────────────────
 *
 * The walk redraws the whole scene every rendered frame, so a surface's backdrop is a pure function
 * of the draws that landed in the scene BEFORE it in paint order. Nothing here polls pixels. Every
 * draw is a RECORD owned by the node that paints it, and a record's SIGNATURE is the bytes the GPU is
 * handed for it: the packed panel and glyph instances exactly as `JivInstanceBuffer.Push` and
 * `TextInstanceBuffer.Push` wrote them, the clip and homography entries they index, and, for the few
 * inputs that are not instance floats (a bound image, an SVG model matrix, a backdrop), an explicit
 * token. So every CPU-side producer of visible change -- layout, style, springs, scroll offsets, text,
 * opacity cascades, occlusion carves -- lands in a signature without being named, because it can only
 * reach the screen through those floats. The audit is therefore about the inputs that are NOT floats,
 * and `WorkerReports/build-blurcache.md` lists every one.
 *
 * A reader (a glass fill, a glass rim, a progressive blur) is CLEAN when, against the previous
 * rendered frame:
 *
 *   1. the same painted records precede it in the same order  -- the PREFIX signature;
 *   2. its build key (region, sigma, depth, arms) is the same   -- so it reads the same texels;
 *   3. no record that changed so far this frame has a footprint (old or new) that meets its sample
 *      rect -- the DAMAGE REGION.
 *
 * (1) is what makes vanishing, appearing and reordered content safe without waiting for the end of
 * the walk to find out what vanished; (3) is what lets a video advance under one card while five
 * others hit. Blending is per-pixel, so an unchanged translucent record over a changed one changes
 * only inside the changed one's footprint, which (3) already holds. The only NON-local readers are
 * the readers themselves, and a reader's own record carries its backdrop's content TOKEN: the same
 * token as last frame when it was clean, a fresh one when it was not. That is what makes glass over
 * glass compose.
 */
import { type PixelRect, PixelRectEmpty, SubtractPixelRects, RegionArea } from './Occlusion';

/** Most disjoint pieces the damage region holds before it gives up and calls the whole canvas dirty.
 *  Past this, "everything changed" is always correct and costs only this frame's hits. */
export const DAMAGE_MAX_PIECES = 32;

/** Resident bytes the cached pyramids may hold, beside `CHAIN_BUDGET_BYTES` (48 MB) for the live
 *  chain pool. A hit needs its texture resident from the frame it was stored until the next time the
 *  surface is drawn; nothing about a hit needs more than one copy per surface. */
export const BLUR_CACHE_BUDGET_BYTES = 48 * 1024 * 1024;

/**
 * HOW FAR PAST ITS RESOLVED RECT A BUILD READS THE SCENE, in device px.
 *
 * The first DOWN hop of the dual filter samples the source at `v_Uv +/- u_HalfPixel * u_Offset`
 * around each destination texel, unclamped, so it reaches one source texel plus the bilinear
 * footprint past the rect -- under 2 px at `u_Offset` 1 -- and every later hop reads the pyramid's
 * own levels, which CLAMP_TO_EDGE. 8 is that bound with room for an offset of 2 and for a
 * pre-downsample hop. `?glass-gaussian`'s pass H reads the live scene with a kernel this does NOT
 * bound, and `?blur-cache` refuses it by name for that reason. A rewrite of `BlurPass`'s first hop
 * (lane blurfast) must re-derive this number: the verify arm is what catches it if nobody does.
 */
export const BLUR_READ_GUARD_PX = 8;

// ── The signature ─────────────────────────────────────────────────────────────────────────────────

const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer);
const _f32 = new Float32Array(1);
const _f32u = new Uint32Array(_f32.buffer);

/** Two independent 32-bit lanes (a murmur3 round and an FNV-1a round over the same words), so a
 *  changed record that happens to collide in one lane still differs in the other. A collision in
 *  both is one stale surface for as long as the record stays equal; at 2^-64 it is not the risk. */
export class Sig {
  A = 0x9747b28c;
  B = 0x811c9dc5;

  Reset = (a: number, b: number): void => { this.A = a; this.B = b; };

  /** One 32-bit word. */
  Word = (x: number): void => {
    let k = Math.imul(x | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    let a = this.A ^ k;
    a = (a << 13) | (a >>> 19);
    this.A = (Math.imul(a, 5) + 0xe6546b64) | 0;
    this.B = Math.imul(this.B ^ (x | 0), 0x01000193) | 0;
  };

  /** Any JS number, by its exact 64-bit pattern: ids, counts, and the non-float inputs the walk
   *  computes in doubles (an SVG model matrix, a pblur's pivot). */
  Number = (v: number): void => {
    _f64[0] = v;
    this.Word(_u32[0]);
    this.Word(_u32[1]);
  };

  /** `data[start, end)`, by each float's exact 32-bit pattern: what the GPU is actually handed. */
  Floats = (data: Float32Array, start: number, end: number): void => {
    for (let i = start; i < end; i++) {
      _f32[0] = data[i];
      this.Word(_f32u[0]);
    }
  };
}

// ── The damage region ─────────────────────────────────────────────────────────────────────────────

/**
 * Device pixels that changed this frame, as disjoint `PixelRect`s built with the occlusion pre-pass's
 * own subtraction (`SubtractPixelRects`), so the rect arithmetic is the tested one and `Px` is an
 * exact area rather than a sum over overlaps. Past `maxPieces` it is `Full`, which is always correct.
 */
export class DamageRegion {
  Pieces: PixelRect[] = [];
  Full = false;
  private _w = 0;
  private _h = 0;
  private readonly _maxPieces: number;

  constructor(maxPieces: number = DAMAGE_MAX_PIECES) { this._maxPieces = maxPieces; }

  Reset = (w: number, h: number): void => {
    this.Pieces = [];
    this.Full = false;
    this._w = w;
    this._h = h;
  };

  SetFull = (): void => { this.Full = true; this.Pieces = []; };

  /** A footprint in fractional device px, rounded OUTWARD with one pixel to spare for the AA feather
   *  and clamped to the canvas. Claiming too much costs a hit; claiming too little is a stale pixel. */
  Add = (x0: number, y0: number, x1: number, y1: number): void => {
    if (this.Full) return;
    const r: PixelRect = {
      X0: Math.max(0, Math.floor(x0) - 1),
      Y0: Math.max(0, Math.floor(y0) - 1),
      X1: Math.min(this._w, Math.ceil(x1) + 1),
      Y1: Math.min(this._h, Math.ceil(y1) + 1),
    };
    if (PixelRectEmpty(r)) return;
    const fresh = SubtractPixelRects(r, this.Pieces, this._maxPieces);
    if (fresh === null || this.Pieces.length + fresh.length > this._maxPieces) { this.SetFull(); return; }
    for (const p of fresh) this.Pieces.push(p);
  };

  /** Does anything that changed meet `r`? */
  Hits = (r: PixelRect): boolean => {
    if (PixelRectEmpty(r)) return false;
    if (this.Full) return true;
    for (const p of this.Pieces) {
      if (p.X0 < r.X1 && r.X0 < p.X1 && p.Y0 < r.Y1 && r.Y0 < p.Y1) return true;
    }
    return false;
  };

  get Px(): number { return this.Full ? this._w * this._h : RegionArea(this.Pieces); }
  get Count(): number { return this.Full ? 1 : this.Pieces.length; }
}

// ── Records ───────────────────────────────────────────────────────────────────────────────────────

/** What a record paints. A node's own paint and its EDGE (a border re-emitted at its BorderLayer, and its
 *  rim) are separate records, because the edge paints among the node's children and not beside its fill. */
export const RECORD_NODE = 1;
export const RECORD_EDGE = 2;
export const RECORD_JANVAS = 3;

/** Why a record is dirty with no float to show for it: its pixels come from state the CPU cannot see.
 *  Each is a producer that does not declare, wired here as ALWAYS CHANGED over its own footprint. */
export type FreshCause = 'janvas' | 'shadow' | 'group' | 'edge';

interface PaintRecord {
  A: number;
  B: number;
  X0: number; Y0: number; X1: number; Y1: number;
  Painted: boolean;
}

/** Readers: the sites that build a blur from the scene. */
export const READER_FILL = 1;
/** An adaptive-shadow probe: the few texels of a pyramid it samples, and the scene they reach. */
export const READER_PROBE = 2;
export const READER_PBLUR = 3;

export interface ReaderState<Slot> {
  Key: string;
  PrefixA: number;
  PrefixB: number;
  /** The ledger frame this reader was last evaluated in. */
  Frame: number;
  /** Its backdrop's content token: unchanged while it stays clean. */
  Token: number;
  /** The rect its inputs were read from, guarded. Widened to the RESOLVED rect after a build. */
  Rect: PixelRect;
  /** The cached pyramid, owned by the renderer. */
  Slot: Slot | null;
}

export type ReaderWhy = 'clean' | 'first' | 'gap' | 'key' | 'prefix' | 'full' | 'damage';

export interface ReaderVerdict<Slot> {
  Why: ReaderWhy;
  Token: number;
  State: ReaderState<Slot>;
}

export interface PaintLedgerFrame {
  /** Records whose signature or footprint differs from last frame's record of the same owner. */
  Changed: number;
  /** Records with no counterpart last frame, and painted records last frame with none this frame. */
  New: number;
  Gone: number;
  /** ALWAYS-CHANGED records, by the producer that could not declare. */
  Fresh: Record<FreshCause, number>;
  /** Draws that reached a buffer with no record open: the walk has a paint site this ledger does not
   *  know. The frame is called entirely dirty, and the gate line prints it so it gets fixed. */
  Untracked: number;
  /** An owner opened twice under one kind in one frame -- the walk painted a node twice. */
  Duplicate: number;
  /** The frame's global inputs moved (canvas size, dpr, tilt, the glyph atlas, ...). */
  Seeded: boolean;
}

/**
 * The per-frame record of what was painted, and the damage it implies. See the file header.
 *
 * Generic over the cache slot so the renderer's texture type never has to be imported here.
 */
export class PaintLedger<Slot> {
  readonly Region: DamageRegion;
  /** Rendered frames seen. A reader is only ever compared against the frame immediately before. */
  Frame = 0;
  readonly Stats: PaintLedgerFrame = {
    Changed: 0, New: 0, Gone: 0, Fresh: { janvas: 0, shadow: 0, group: 0, edge: 0 }, Untracked: 0, Duplicate: 0, Seeded: false,
  };

  private readonly _ids = new WeakMap<object, number>();
  private _nextId = 1;
  private _prev: Map<number, PaintRecord>[] = [new Map(), new Map(), new Map(), new Map()];
  private _cur: Map<number, PaintRecord>[] = [new Map(), new Map(), new Map(), new Map()];
  private readonly _readers: Map<number, ReaderState<Slot>>[] = [new Map(), new Map(), new Map(), new Map()];
  private readonly _prefix = new Sig();
  private readonly _sig = new Sig();
  private readonly _seed = new Sig();
  private _seedA = 0;
  private _seedB = 0;
  private _w = 0;
  private _h = 0;
  private _tokenSeq = 0;

  // The open record. -1 when none is.
  private _openId = -1;
  private _openKind = 0;
  private _fresh = false;
  private _x0 = 0; private _y0 = 0; private _x1 = 0; private _y1 = 0;
  private _painted = false;

  constructor(maxPieces: number = DAMAGE_MAX_PIECES) { this.Region = new DamageRegion(maxPieces); }

  /** A stable number per owner object, for the prefix and for the maps. */
  Id = (o: object): number => {
    let id = this._ids.get(o);
    if (id === undefined) { id = this._nextId++; this._ids.set(o, id); }
    return id;
  };

  /** The frame seed, emptied, for the caller to fill before `BeginFrame`: everything every draw in the
   *  frame depends on that no instance carries. A seed that moved dirties the whole canvas. */
  NewSeed = (): Sig => {
    this._seed.Reset(0x2545f491, 0x9e3779b9);
    return this._seed;
  };

  BeginFrame = (w: number, h: number): void => {
    this.Frame++;
    this.Region.Reset(w, h);
    const s = this.Stats;
    s.Changed = 0; s.New = 0; s.Gone = 0; s.Untracked = 0; s.Duplicate = 0;
    s.Fresh.janvas = 0; s.Fresh.shadow = 0; s.Fresh.group = 0; s.Fresh.edge = 0;
    s.Seeded = this._seed.A !== this._seedA || this._seed.B !== this._seedB || w !== this._w || h !== this._h;
    this._seedA = this._seed.A;
    this._seedB = this._seed.B;
    this._w = w;
    this._h = h;
    if (s.Seeded) this.Region.SetFull();
    this._prefix.Reset(this._seedA, this._seedB);
    this._openId = -1;
  };

  /** Forget everything: the next frame compares against nothing and every reader is `first`. For a
   *  frame rendered without the ledger (a refused arm), and for a lost context. */
  Reset = (): void => {
    for (const m of this._prev) m.clear();
    for (const m of this._cur) m.clear();
    for (const m of this._readers) m.clear();
    this._w = 0;
    this._h = 0;
    this._openId = -1;
  };

  get IsOpen(): boolean { return this._openId >= 0; }

  Open = (owner: object, kind: number): void => {
    if (this._openId >= 0) throw new Error('[Jaui] blur-cache: a paint record opened inside another');
    this._openId = this.Id(owner);
    this._openKind = kind;
    this._sig.Reset(0x6a09e667, 0xbb67ae85);
    this._fresh = false;
    this._painted = false;
    this._x0 = Infinity; this._y0 = Infinity; this._x1 = -Infinity; this._y1 = -Infinity;
  };

  /** The open record's signature, for the caller to feed. */
  get Sig(): Sig { return this._sig; }

  /** Ink went down over this rect, in device px. Part of the signature too, so a footprint that
   *  moved with identical floats (it cannot today) still reads as a change. */
  Extend = (x0: number, y0: number, x1: number, y1: number): void => {
    this._painted = true;
    if (x0 < this._x0) this._x0 = x0;
    if (y0 < this._y0) this._y0 = y0;
    if (x1 > this._x1) this._x1 = x1;
    if (y1 > this._y1) this._y1 = y1;
  };

  /** Ink went down somewhere this ledger does not bound (a projected instance, an SVG): the whole
   *  canvas. Free while the record stays equal -- a footprint only costs on the frame it changes. */
  ExtendAll = (): void => { this.Extend(0, 0, this._w, this._h); };

  /** This record's pixels depend on state the CPU cannot see. */
  Fresh = (cause: FreshCause): void => {
    this._fresh = true;
    this.Stats.Fresh[cause]++;
  };

  /** A draw reached a buffer with no record open. */
  NoteUntracked = (): void => {
    this.Stats.Untracked++;
    this.Region.SetFull();
  };

  Close = (): void => {
    if (this._openId < 0) throw new Error('[Jaui] blur-cache: a paint record closed while none was open');
    const id = this._openId;
    const kind = this._openKind;
    this._openId = -1;
    const cur = this._cur[kind];
    if (cur.has(id)) { this.Stats.Duplicate++; this.Region.SetFull(); }
    const sig = this._sig;
    if (this._painted) {
      sig.Number(this._x0); sig.Number(this._y0); sig.Number(this._x1); sig.Number(this._y1);
    }
    const rec: PaintRecord = {
      A: sig.A, B: sig.B, X0: this._x0, Y0: this._y0, X1: this._x1, Y1: this._y1, Painted: this._painted,
    };
    cur.set(id, rec);
    const prev = this._prev[kind].get(id);
    if (prev === undefined) {
      if (rec.Painted) { this.Stats.New++; this.Region.Add(rec.X0, rec.Y0, rec.X1, rec.Y1); }
    } else if (this._fresh || prev.A !== rec.A || prev.B !== rec.B || prev.Painted !== rec.Painted) {
      if (!this._fresh) this.Stats.Changed++;
      if (prev.Painted) this.Region.Add(prev.X0, prev.Y0, prev.X1, prev.Y1);
      if (rec.Painted) this.Region.Add(rec.X0, rec.Y0, rec.X1, rec.Y1);
    }
    if (rec.Painted) { this._prefix.Word(id); this._prefix.Word(kind); }
  };

  /** A record whose whole content is foreign (a `<janvas>`): opened, always changed, closed. */
  Declare = (owner: object, kind: number, cause: FreshCause, x0: number, y0: number, x1: number, y1: number): void => {
    this.Open(owner, kind);
    this.Fresh(cause);
    this.Extend(x0, y0, x1, y1);
    this.Close();
  };

  /**
   * Is this reader's backdrop the same as last frame's? Called at the instant it would read the
   * scene, with the open record being the one its draw belongs to. The token it returns goes into
   * that record's signature (the caller mixes it), which is what carries a changed backdrop into
   * the damage region for every reader after it.
   *
   * `rect` is what the caller knows it will read (the plan region, guarded). When the key matches,
   * the stored rect -- widened to the RESOLVED rect after last frame's build -- is the one tested,
   * because an equal key reads exactly what it read then.
   */
  Reader = (owner: object, kind: number, key: string, rect: PixelRect): ReaderVerdict<Slot> => {
    const id = this.Id(owner);
    const map = this._readers[kind];
    let st = map.get(id);
    let why: ReaderWhy;
    if (st === undefined) why = 'first';
    else if (st.Frame !== this.Frame - 1) why = 'gap';
    else if (st.Key !== key) why = 'key';
    else if (st.PrefixA !== this._prefix.A || st.PrefixB !== this._prefix.B) why = 'prefix';
    else if (this.Region.Full) why = 'full';
    else if (this.Region.Hits(st.Rect)) why = 'damage';
    else why = 'clean';
    const token = why === 'clean' ? st!.Token : ++this._tokenSeq;
    if (st === undefined) {
      st = { Key: key, PrefixA: 0, PrefixB: 0, Frame: 0, Token: 0, Rect: rect, Slot: null };
      map.set(id, st);
    }
    if (why !== 'clean') st.Rect = rect;
    st.Key = key;
    st.PrefixA = this._prefix.A;
    st.PrefixB = this._prefix.B;
    st.Frame = this.Frame;
    st.Token = token;
    return { Why: why, Token: token, State: st };
  };

  /** The token a reader holds THIS frame, or a fresh one if it was not evaluated this frame. A rim
   *  that binds its fill's pyramid carries the fill's token. */
  TokenOf = (owner: object, kind: number): number => {
    const st = this._readers[kind].get(this.Id(owner));
    return st !== undefined && st.Frame === this.Frame ? st.Token : ++this._tokenSeq;
  };

  /**
   * Close the frame. Painted records that did not come back are damage too -- nothing reads it this
   * frame (the prefix already made every reader after them miss), but `dirtyPx` should say so.
   * Readers not evaluated this frame can never be clean again, so their slots go back to the caller.
   */
  EndFrame = (release: (slot: Slot) => void): void => {
    if (this._openId >= 0) throw new Error('[Jaui] blur-cache: the frame ended with a paint record open');
    for (let k = 0; k < this._prev.length; k++) {
      const cur = this._cur[k];
      for (const [id, rec] of this._prev[k]) {
        if (!cur.has(id) && rec.Painted) { this.Stats.Gone++; this.Region.Add(rec.X0, rec.Y0, rec.X1, rec.Y1); }
      }
      const done = this._prev[k];
      done.clear();
      this._prev[k] = cur;
      this._cur[k] = done;
    }
    for (const map of this._readers) {
      for (const [id, st] of map) {
        if (st.Frame === this.Frame) continue;
        if (st.Slot !== null) release(st.Slot);
        map.delete(id);
      }
    }
  };
}

// ── Residency ─────────────────────────────────────────────────────────────────────────────────────

export interface Resident {
  Bytes: number;
  /** The last frame the slot was stored or bound. */
  LastUse: number;
}

/**
 * Which resident slots to evict so `need` more bytes fit under `budget`: least recently used first,
 * and NEVER one used this frame -- its texture may already be bound to a draw that has not been
 * submitted. `null` when even evicting every candidate would not make room: the caller refuses the
 * store and counts it, rather than evicting a live slot.
 */
export const PickEvictions = <T extends Resident>(
  slots: Iterable<T>, resident: number, need: number, budget: number, frame: number,
): T[] | null => {
  if (resident + need <= budget) return [];
  const candidates = [...slots].filter((s) => s.LastUse < frame).sort((a, b) => a.LastUse - b.LastUse);
  const out: T[] = [];
  let bytes = resident;
  for (const s of candidates) {
    if (bytes + need <= budget) break;
    out.push(s);
    bytes -= s.Bytes;
  }
  return bytes + need <= budget ? out : null;
};

/** Bytes a mip chain of `levels` levels over a `w` x `h` base holds, at `bpp` bytes a texel, with the
 *  same `>> i` halving `Framebuffer.EnsureMipLevels` allocates. */
export const ChainBytesFor = (w: number, h: number, levels: number, bpp: number): number => {
  let bytes = 0;
  for (let i = 0; i < levels; i++) bytes += Math.max(1, w >> i) * Math.max(1, h >> i) * bpp;
  return bytes;
};

export const UnionRect = (a: PixelRect, b: PixelRect): PixelRect => ({
  X0: Math.min(a.X0, b.X0), Y0: Math.min(a.Y0, b.Y0), X1: Math.max(a.X1, b.X1), Y1: Math.max(a.Y1, b.Y1),
});

/** A reader's sample rect: the y-down device rect `r`, grown by `guard` on every side. */
export const GuardedRect = (x: number, y: number, w: number, h: number, guard: number): PixelRect => ({
  X0: Math.floor(x) - guard,
  Y0: Math.floor(y) - guard,
  X1: Math.ceil(x + w) + guard,
  Y1: Math.ceil(y + h) + guard,
});
