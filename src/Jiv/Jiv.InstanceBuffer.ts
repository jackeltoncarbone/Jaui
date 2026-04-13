import type { Jiv } from './Jiv';

const FLOATS_PER_INSTANCE = 32;

export class JivInstanceBuffer {
  private _gl: WebGL2RenderingContext;
  private _buffer: WebGLBuffer;
  private _data: Float32Array;
  private _capacity: number;
  private _count: number = 0;

  constructor(gl: WebGL2RenderingContext, initialCapacity: number = 256) {
    this._gl = gl;
    this._capacity = initialCapacity;
    this._data = new Float32Array(initialCapacity * FLOATS_PER_INSTANCE);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jwift] Failed to create instance buffer');
    this._buffer = buf;
  }

  get Count(): number { return this._count; }
  get Buffer(): WebGLBuffer { return this._buffer; }

  Begin = (): void => {
    this._count = 0;
  };

  Push = (jiv: Jiv, dpr: number): void => {
    if (this._count >= this._capacity) this._grow();

    const style = jiv.Style;
    const d = dpr;
    const offset = this._count * FLOATS_PER_INSTANCE;

    // Scale CSS pixels to device pixels
    const x = jiv.X * d;
    const y = jiv.Y * d;
    const w = jiv.Width * d;
    const h = jiv.Height * d;
    const borderWidth = style.BorderWidth * d;
    const borderBlur = style.BorderBlur * d;
    const shadowBlur = style.ShadowBlur * d;
    const shadowOffX = style.ShadowOffsetX * d;
    const shadowOffY = style.ShadowOffsetY * d;
    const r0 = style.BorderRadius[0] * d;
    const r1 = style.BorderRadius[1] * d;
    const r2 = style.BorderRadius[2] * d;
    const r3 = style.BorderRadius[3] * d;

    // Expand draw rect for shadow/border bleed
    const shadowMarginX = shadowBlur + Math.abs(shadowOffX);
    const shadowMarginY = shadowBlur + Math.abs(shadowOffY);
    const borderMargin = borderWidth + borderBlur;
    const marginX = Math.max(shadowMarginX, borderMargin);
    const marginY = Math.max(shadowMarginY, borderMargin);

    const data = this._data;

    // a_Rect (location 1)
    data[offset + 0] = x - marginX;
    data[offset + 1] = y - marginY;
    data[offset + 2] = w + marginX * 2;
    data[offset + 3] = h + marginY * 2;

    // a_PanelGeom (location 2)
    data[offset + 4] = x + w / 2;
    data[offset + 5] = y + h / 2;
    data[offset + 6] = w / 2;
    data[offset + 7] = h / 2;

    // a_Radii (location 3)
    data[offset + 8] = r0;
    data[offset + 9] = r1;
    data[offset + 10] = r2;
    data[offset + 11] = r3;

    // a_Background (location 4)
    data[offset + 12] = style.Background.R;
    data[offset + 13] = style.Background.G;
    data[offset + 14] = style.Background.B;
    data[offset + 15] = style.Background.A;

    // a_BorderColor (location 5)
    data[offset + 16] = style.BorderColor.R;
    data[offset + 17] = style.BorderColor.G;
    data[offset + 18] = style.BorderColor.B;
    data[offset + 19] = style.BorderColor.A;

    // a_ShadowColor (location 6)
    data[offset + 20] = style.ShadowColor.R;
    data[offset + 21] = style.ShadowColor.G;
    data[offset + 22] = style.ShadowColor.B;
    data[offset + 23] = style.ShadowColor.A;

    // a_ShadowParams (location 7)
    data[offset + 24] = shadowOffX;
    data[offset + 25] = shadowOffY;
    data[offset + 26] = shadowBlur;
    data[offset + 27] = borderWidth;

    // a_StyleParams (location 8)
    data[offset + 28] = borderBlur;
    data[offset + 29] = style.Smoothness;
    data[offset + 30] = style.Opacity;
    data[offset + 31] = 0.0; // padding

    this._count++;
  };

  Upload = (): void => {
    if (this._count === 0) return;
    const gl = this._gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this._data.subarray(0, this._count * FLOATS_PER_INSTANCE),
      gl.DYNAMIC_DRAW,
    );
  };

  private _grow = (): void => {
    this._capacity *= 2;
    const newData = new Float32Array(this._capacity * FLOATS_PER_INSTANCE);
    newData.set(this._data);
    this._data = newData;
  };
}
