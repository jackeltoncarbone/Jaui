import type { AtlasUv } from './Text.Cache';

/** Per-instance data for instanced text rendering.
 *  9 floats per instance:
 *    a_Rect   (x, y, w, h)  — screen rect in device pixels  [loc 1, vec4]
 *    a_UvRect (u, v, uW, uH) — atlas UV rect                [loc 2, vec4]
 *    a_Opacity (opacity)     — per-word opacity               [loc 3, float]
 *  Padded to 12 floats (3 × vec4) for alignment.
 */
export const TEXT_FLOATS_PER_INSTANCE = 12;

export interface TextDrawCommand {
  X: number;         // device pixels
  Y: number;
  Width: number;
  Height: number;
  Uv: AtlasUv;
  Opacity: number;
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
    data[offset + 9] = 0;
    data[offset + 10] = 0;
    data[offset + 11] = 0;

    this._count++;
  };

  private _grow = (): void => {
    this._capacity *= 2;
    const newData = new Float32Array(this._capacity * TEXT_FLOATS_PER_INSTANCE);
    newData.set(this._data);
    this._data = newData;
  };
}
