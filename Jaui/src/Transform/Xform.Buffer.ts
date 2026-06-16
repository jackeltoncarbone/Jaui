import type { Mat3x3 } from './Mat3x3';

/**
 * Per-frame sparse table of 3D homographies, shared by every element type
 * (panel / text / jline). The render walk appends a node's perspective
 * homography and gets back an INDEX; the element's instance data stores that
 * index next to a sentinel (an out-of-range `cos`), so only projective
 * instances ever index this — 2D rendering is wholly untouched. Mirrors
 * `ClipStackBuffer`: built during the walk, uploaded to a 1-row RGBA32F
 * texture, fetched by `texelFetch` in the vertex shaders.
 *
 * One entry = the 3×3 row-major homography in 3 RGBA texels (12 floats; the
 * `.w` lanes are pad). `Add` bakes the device scale into the output rows so
 * the stored matrix maps a node's NATURAL coords → screen DEVICE px.
 */
export const XFORM_FLOATS_PER_ENTRY = 12;

export class XformBuffer {
  private _data: Float32Array;
  private _count = 0;

  constructor(initialEntries = 64) {
    this._data = new Float32Array(initialEntries * XFORM_FLOATS_PER_ENTRY);
  }

  /** Number of entries appended this frame. */
  get Count(): number { return this._count; }
  get Data(): Float32Array { return this._data; }
  /** Valid float length for upload. */
  get Floats(): number { return this._count * XFORM_FLOATS_PER_ENTRY; }

  Begin = (): void => { this._count = 0; };

  /** Append `effH` (natural → canvas) with its output rows scaled to device px
   *  (natural → device). Returns the entry index for the instance to store. */
  Add = (effH: Mat3x3, dpr: number): number => {
    if ((this._count + 1) * XFORM_FLOATS_PER_ENTRY > this._data.length) this._grow();
    const o = this._count * XFORM_FLOATS_PER_ENTRY;
    const d = this._data;
    d[o + 0] = effH[0] * dpr; d[o + 1] = effH[1] * dpr; d[o + 2] = effH[2] * dpr; d[o + 3] = 0;
    d[o + 4] = effH[3] * dpr; d[o + 5] = effH[4] * dpr; d[o + 6] = effH[5] * dpr; d[o + 7] = 0;
    d[o + 8] = effH[6];       d[o + 9] = effH[7];       d[o + 10] = effH[8];      d[o + 11] = 0;
    return this._count++;
  };

  private _grow = (): void => {
    const n = new Float32Array(this._data.length * 2);
    n.set(this._data);
    this._data = n;
  };
}
