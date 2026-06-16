import type { AtlasUv } from './Text.Cache';

/** Per-instance data for instanced text rendering.
 *  5 × vec4 = 20 floats per instance:
 *    a_Rect        (x, y, w, h)                           — device pixels [loc 1]
 *    a_UvRect      (u, v, uW, uH)                         — atlas UV     [loc 2]
 *    a_OpacityClip (opacity, clipOffset, clipCount, _pad) — clip meta     [loc 3]
 *    a_Tint        (R, G, B, A)                           — RGBA multiplier [loc 4]
 *    a_Rot         (cosθ, sinθ, pivotX, pivotY)           — rotation [loc 5]
 *  clipOffset/clipCount index into the per-frame clip-stack buffer.
 *  count=0 means no clipping — shader short-circuits.
 *  tint=(1,1,1,1) is passthrough — used for static text and image quads.
 *  Animated color uses tint = oldColor/newColor at frame 0 → (1,1,1,1) over time
 *  while the glyph atlas raster snaps to the new color (see Text.Animator).
 *  a_Rot rotates the glyph quad about its pivot (device px); (1,0) = unrotated,
 *  so a glyph under a rotated ancestor tilts with the panel instead of resisting.
 *
 *  3D perspective reuses this SAME layout via a sentinel — identical to panels,
 *  no extra attributes. When `XformIndex >= 0` the glyph is projective: a_Rect
 *  carries the glyph rect in NODE-NATURAL coords and a_Rot = (2.0, XformIndex,
 *  _, _) — the out-of-range cos=2.0 tells the vertex to fetch the homography
 *  from the shared u_XformTex by index and project the natural corners.
 */
export const TEXT_FLOATS_PER_INSTANCE = 20;

export interface TextDrawCommand {
  X: number;         // device pixels
  Y: number;
  Width: number;
  Height: number;
  Uv: AtlasUv;
  Opacity: number;
  ClipOffset: number;
  ClipCount: number;
  /** RGBA tint multiplier. (1,1,1,1) = passthrough. */
  TintR: number;
  TintG: number;
  TintB: number;
  TintA: number;
  /** Rotation basis (cosθ, sinθ) + pivot (device px). Defaults (1,0,0,0) = none. */
  Cos?: number;
  Sin?: number;
  PivotX?: number;
  PivotY?: number;
  /** Index into the shared u_XformTex when this glyph is perspective-projected
   *  (its X/Y/Width/Height are then NODE-NATURAL coords). Absent/-1 = 2D. */
  XformIndex?: number;
}

/**
 * CPU-side instance data packer for text quads. Backend-agnostic —
 * the Renderer consumes the raw data via TextAddInstance().
 */
export class TextInstanceBuffer {
  private _data: Float32Array;
  private _capacity: number;
  private _count: number = 0;

  constructor(initialCapacity: number = 128) {
    this._capacity = initialCapacity;
    this._data = new Float32Array(initialCapacity * TEXT_FLOATS_PER_INSTANCE);
  }

  get Count(): number { return this._count; }
  get Data(): Float32Array { return this._data; }

  Begin = (): void => { this._count = 0; };

  Push = (cmd: TextDrawCommand): void => {
    if (this._count >= this._capacity) this._grow();

    const offset = this._count * TEXT_FLOATS_PER_INSTANCE;
    const data = this._data;

    data[offset + 0] = cmd.X;
    data[offset + 1] = cmd.Y;
    data[offset + 2] = cmd.Width;
    data[offset + 3] = cmd.Height;

    data[offset + 4] = cmd.Uv.U;
    data[offset + 5] = cmd.Uv.V;
    data[offset + 6] = cmd.Uv.UWidth;
    data[offset + 7] = cmd.Uv.UHeight;

    data[offset + 8] = cmd.Opacity;
    data[offset + 9] = cmd.ClipOffset;
    data[offset + 10] = cmd.ClipCount;
    data[offset + 11] = 0;

    data[offset + 12] = cmd.TintR;
    data[offset + 13] = cmd.TintG;
    data[offset + 14] = cmd.TintB;
    data[offset + 15] = cmd.TintA;

    // a_Rot — (cos, sin, pivot) for 2D; (2.0 sentinel, xformIndex, _, _) for 3D.
    const xi = cmd.XformIndex ?? -1;
    if (xi >= 0) {
      data[offset + 16] = 2.0;
      data[offset + 17] = xi;
      data[offset + 18] = 0;
      data[offset + 19] = 0;
    } else {
      data[offset + 16] = cmd.Cos ?? 1;
      data[offset + 17] = cmd.Sin ?? 0;
      data[offset + 18] = cmd.PivotX ?? 0;
      data[offset + 19] = cmd.PivotY ?? 0;
    }

    this._count++;
  };

  private _grow = (): void => {
    this._capacity *= 2;
    const newData = new Float32Array(this._capacity * TEXT_FLOATS_PER_INSTANCE);
    newData.set(this._data);
    this._data = newData;
  };
}
