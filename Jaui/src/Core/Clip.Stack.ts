/**
 * Clip stack — the data structures and per-frame accumulator that drive
 * Jaui's CSS-style overflow clipping.
 *
 * Each clipping ancestor (Overflow: Hidden|Scroll, or a child opting in via
 * ParentOverflow: Hidden) contributes a rounded-rect ClipShape onto the stack
 * its descendants see. Children whose ParentOverflow is Visible drop the
 * parent's contribution (escape one level). The fragment shader iterates the
 * stack and discards pixels outside any clip, so genuinely nested rounded
 * clipping (e.g. rounded Card inside rounded Screen) renders correctly —
 * not the usual "innermost only" approximation.
 *
 * All values are CSS pixels at the CPU layer; the renderers multiply by the
 * device pixel ratio when writing to GPU buffers.
 */

/** A single rounded-rect clip in CSS pixels. */
export interface ClipShape {
  X: number;
  Y: number;
  W: number;
  H: number;
  /** Per-corner radii: top-left, top-right, bottom-right, bottom-left. */
  RTL: number;
  RTR: number;
  RBR: number;
  RBL: number;
  /** BorderRadiusSmoothness of the clipping node (0 = pure circle corners,
   *  higher = squircle). Must match the panel's shape so the clip exactly
   *  traces the parent's painted rounded-rect edge. */
  Smoothness: number;
  /** Rotation basis of the clipping node (cosθ, sinθ). (1, 0) = unrotated.
   *  The clip SDF un-rotates the sample point about the clip's center by this
   *  basis before its axis-aligned rounded-rect test, so a rotated clip parent
   *  clips its children along the rotated edges. Optional: absent ⇒ (1, 0). */
  Cos?: number;
  Sin?: number;
  /** Canvas-space center of the clip box (well-defined under rotation, unlike
   *  the top-left). The SDF un-rotates about this. Optional: absent ⇒ X+W/2,Y+H/2. */
  CenterX?: number;
  CenterY?: number;
}

/** Stack of clips inherited at a particular tree position. The same array
 *  identity is passed down to siblings that share the same ancestor clipping
 *  state — `ClipStackBuffer` uses identity to dedupe serialization. */
export type ClipStack = readonly ClipShape[];

/** Empty stack singleton — passed as the root's clip stack and any subtree
 *  that escapes all ancestor clipping. */
export const EmptyClipStack: ClipStack = [];

/** Number of floats per clip entry in the flat buffer.
 *  3 × vec4 = 12 floats:
 *    [ rect.xyzw, radii.xyzw, (smoothness, _pad, _pad, _pad) ] */
export const CLIP_FLOATS_PER_ENTRY = 12;

/** Per-frame accumulator that flattens ClipStacks into a single Float32Array
 *  and hands back stable (offset, count) pairs that instance buffers reference.
 *
 *  Stack identity (===) drives dedup — a parent's stack passed unchanged to
 *  many children only serializes once. Each frame starts with `Begin()`. */
export class ClipStackBuffer {
  private _data: Float32Array;
  private _floats: number = 0;
  private _index = new Map<ClipStack, { Offset: number; Count: number }>();

  constructor(initialClipCapacity: number = 64) {
    this._data = new Float32Array(initialClipCapacity * CLIP_FLOATS_PER_ENTRY);
  }

  Begin = (): void => {
    this._floats = 0;
    this._index.clear();
  };

  /** Serialize a stack (or look up if already serialized this frame) and
   *  return its location in the flat buffer. Offset is in *clip entries*
   *  (each entry = CLIP_FLOATS_PER_ENTRY floats), not bytes — shaders index
   *  that way too. */
  Encode = (stack: ClipStack, dpr: number): { Offset: number; Count: number } => {
    if (stack.length === 0) return { Offset: 0, Count: 0 };
    const cached = this._index.get(stack);
    if (cached) return cached;

    const entryOffset = this._floats / CLIP_FLOATS_PER_ENTRY;
    const need = this._floats + stack.length * CLIP_FLOATS_PER_ENTRY;
    if (need > this._data.length) {
      let cap = this._data.length;
      while (cap < need) cap *= 2;
      const grown = new Float32Array(cap);
      grown.set(this._data);
      this._data = grown;
    }

    for (const c of stack) {
      this._data[this._floats + 0] = c.X * dpr;
      this._data[this._floats + 1] = c.Y * dpr;
      this._data[this._floats + 2] = c.W * dpr;
      this._data[this._floats + 3] = c.H * dpr;
      this._data[this._floats + 4] = c.RTL * dpr;
      this._data[this._floats + 5] = c.RTR * dpr;
      this._data[this._floats + 6] = c.RBR * dpr;
      this._data[this._floats + 7] = c.RBL * dpr;
      // Smoothness is unitless — don't multiply by dpr. Slots 9/10 carry the
      // rotation basis (cosθ, sinθ); (1, 0) when unrotated so the clip SDF's
      // un-rotation is identity and non-rotated clips are unchanged. The clip
      // center is recovered in-shader as (X+W/2, Y+H/2) — X was stored as
      // center−half, so this is exact under rotation. Slot 11 stays reserved.
      this._data[this._floats + 8] = c.Smoothness;
      this._data[this._floats + 9] = c.Cos ?? 1;
      this._data[this._floats + 10] = c.Sin ?? 0;
      this._data[this._floats + 11] = 0;
      this._floats += CLIP_FLOATS_PER_ENTRY;
    }

    const result = { Offset: entryOffset, Count: stack.length };
    this._index.set(stack, result);
    return result;
  };

  get Data(): Float32Array { return this._data; }
  get Floats(): number { return this._floats; }
  get ClipCount(): number { return this._floats / CLIP_FLOATS_PER_ENTRY; }
}
