import type { Jiv } from './Jiv';

// Per-instance floats (15 vec4 slots = 60 floats = 240 bytes):
//   loc  1: a_Rect         (x, y, w, h)
//   loc  2: a_PanelGeom    (cx, cy, halfW, halfH)
//   loc  3: a_Radii        (tl, tr, br, bl)
//   loc  4: a_Tint         (R, G, B, A)        — Background color
//   loc  5: a_BorderColor  (R, G, B, A)
//   loc  6: a_ShadowColor  (R, G, B, A)
//   loc  7: a_ShadowParams (offsetX, offsetY, blur, borderWidth)
//   loc  8: a_StyleParams  (borderBlur, smoothness, opacity, materialType)
//                          materialType: 1=LiquidGlass, 2=SolidGlass
//   loc  9: a_Grading      (brightness, saturation, contrast, frostLod)
//   loc 10: a_Refraction   (thickness, bezelWidth, refractionStrength, bezelScale)
//   loc 11: a_Lighting     (lightDirX, lightDirY, lightIntensity, fresnelStrength)
//   loc 12: a_Specular     (specularIntensity, specularSharpness, chromaticAberration, innerBlur)
//   loc 13: a_RimEdge      (edgeLightTop, edgeLightBottom, borderVariance, bulge)
//                          bulge = Fillet (surface-bulge magnitude, Show Studio analog)
//   loc 14: a_Outline      (borderAlphaVariance, borderFresnelBrightness, _pad, _pad)
//   loc 15: a_BorderFilter (brightnessMul, saturationMul, contrastMul, lodOffset)
//                          Backdrop filter applied IN the border zone — multipliers
//                          on top of the panel grading. lodOffset shifts mipmap LOD.

export const JIV_FLOATS_PER_INSTANCE = 60;
const BYTES_PER_INSTANCE = JIV_FLOATS_PER_INSTANCE * 4;

export class JivInstanceBuffer {
  private _gl: WebGL2RenderingContext;
  private _buffer: WebGLBuffer;
  private _data: Float32Array;
  private _capacity: number;
  private _count: number = 0;

  constructor(gl: WebGL2RenderingContext, initialCapacity: number = 64) {
    this._gl = gl;
    this._capacity = initialCapacity;
    this._data = new Float32Array(initialCapacity * JIV_FLOATS_PER_INSTANCE);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('[Jwift] Failed to create glass instance buffer');
    this._buffer = buf;
  }

  get Count(): number { return this._count; }
  get Buffer(): WebGLBuffer { return this._buffer; }
  get Data(): Float32Array { return this._data; }

  Begin = (): void => { this._count = 0; };

  Push = (jiv: Jiv, dpr: number, offsetX: number = 0, offsetY: number = 0): void => {
    if (this._count >= this._capacity) this._grow();

    // Read the spring-animated RenderStyle (JivStyleAnimator writes here each
    // frame, chasing jiv.EffectiveStyle() — the base-plus-state target).
    // State transitions animate automatically: hover changes styles flow
    // through the springs before reaching the renderer.
    const style = jiv.RenderStyle;
    const d = dpr;
    const offset = this._count * JIV_FLOATS_PER_INSTANCE;

    const x = (jiv.X + offsetX) * d;
    const y = (jiv.Y + offsetY) * d;
    const w = jiv.Width * d;
    const h = jiv.Height * d;
    const borderWidth = style.BorderWidth * d;
    const borderBlur = style.BorderBlur * d;
    const shadowBlur = style.ShadowBlur * d;
    const shadowOffX = style.ShadowOffsetX * d;
    const shadowOffY = style.ShadowOffsetY * d;

    // Expand draw rect for shadow/border bleed
    const shadowMarginX = shadowBlur + Math.abs(shadowOffX);
    const shadowMarginY = shadowBlur + Math.abs(shadowOffY);
    const borderMargin = borderWidth + borderBlur;
    const marginX = Math.max(shadowMarginX, borderMargin);
    const marginY = Math.max(shadowMarginY, borderMargin);

    const data = this._data;

    // loc 1 — a_Rect
    data[offset + 0] = x - marginX;
    data[offset + 1] = y - marginY;
    data[offset + 2] = w + marginX * 2;
    data[offset + 3] = h + marginY * 2;

    // loc 2 — a_PanelGeom
    data[offset + 4] = x + w / 2;
    data[offset + 5] = y + h / 2;
    data[offset + 6] = w / 2;
    data[offset + 7] = h / 2;

    // loc 3 — a_Radii (resolved to px by the style animator)
    data[offset + 8] = style.BorderRadius[0] * d;
    data[offset + 9] = style.BorderRadius[1] * d;
    data[offset + 10] = style.BorderRadius[2] * d;
    data[offset + 11] = style.BorderRadius[3] * d;

    // loc 4 — a_Tint
    data[offset + 12] = style.Background.R;
    data[offset + 13] = style.Background.G;
    data[offset + 14] = style.Background.B;
    data[offset + 15] = style.Background.A;

    // loc 5 — a_BorderColor
    data[offset + 16] = style.BorderColor.R;
    data[offset + 17] = style.BorderColor.G;
    data[offset + 18] = style.BorderColor.B;
    data[offset + 19] = style.BorderColor.A;

    // loc 6 — a_ShadowColor
    data[offset + 20] = style.ShadowColor.R;
    data[offset + 21] = style.ShadowColor.G;
    data[offset + 22] = style.ShadowColor.B;
    data[offset + 23] = style.ShadowColor.A;

    // loc 7 — a_ShadowParams
    data[offset + 24] = shadowOffX;
    data[offset + 25] = shadowOffY;
    data[offset + 26] = shadowBlur;
    data[offset + 27] = borderWidth;

    // loc 8 — a_StyleParams
    data[offset + 28] = borderBlur;
    data[offset + 29] = style.BorderRadiusSmoothness;
    data[offset + 30] = style.Opacity;
    data[offset + 31] = style.Material === 'LiquidGlass' ? 1 : style.Material === 'SolidGlass' ? 2 : 0;

    // loc 9 — a_Grading (frostLod derived from FrostBlur)
    data[offset + 32] = style.BackdropBrightness;
    data[offset + 33] = style.BackdropSaturation;
    data[offset + 34] = style.BackdropContrast;
    const blurPx = Math.max(0.5, style.BackdropFrostBlur * d);
    data[offset + 35] = Math.max(0, Math.min(10, Math.log2(blurPx)));

    // loc 10 — a_Refraction (all px values scaled by dpr)
    data[offset + 36] = style.Thickness * d;
    data[offset + 37] = style.BezelWidth * d;
    data[offset + 38] = style.Refraction;
    data[offset + 39] = style.BezelScale;

    // loc 11 — a_Lighting. Convert LightAngle (degrees, 0=+x, 90=up) to a 2D dir.
    // Screen Y is down, so "up" maps to -Y. We store the screen-space light direction.
    const rad = style.LightAngle * (Math.PI / 180);
    const lightX = Math.cos(rad);
    const lightY = -Math.sin(rad);
    data[offset + 40] = lightX;
    data[offset + 41] = lightY;
    data[offset + 42] = style.LightIntensity;
    data[offset + 43] = style.FresnelStrength;

    // loc 12 — a_Specular
    data[offset + 44] = style.SpecularIntensity;
    data[offset + 45] = style.SpecularSharpness;
    data[offset + 46] = style.ChromaticAberration;
    data[offset + 47] = style.InnerBlur;

    // loc 13 — a_RimEdge (bulge = Fillet, Show Studio's --surface-bulge analog)
    data[offset + 48] = style.EdgeLightTop;
    data[offset + 49] = style.EdgeLightBottom;
    data[offset + 50] = style.BorderVariance;
    data[offset + 51] = style.Fillet;

    // loc 14 — a_Outline
    data[offset + 52] = style.BorderAlphaVariance;
    data[offset + 53] = style.BorderFresnelBrightness;
    data[offset + 54] = 0;
    data[offset + 55] = 0;

    // loc 15 — a_BorderFilter (border-zone backdrop grading multipliers)
    data[offset + 56] = style.BorderBrightness;
    data[offset + 57] = style.BorderSaturation;
    data[offset + 58] = style.BorderContrast;
    data[offset + 59] = style.BorderFrostLodOffset;

    this._count++;
  };

  Upload = (): void => {
    if (this._count === 0) return;
    const gl = this._gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this._data.subarray(0, this._count * JIV_FLOATS_PER_INSTANCE),
      gl.DYNAMIC_DRAW,
    );
  };

  static get BytesPerInstance(): number { return BYTES_PER_INSTANCE; }

  private _grow = (): void => {
    this._capacity *= 2;
    const newData = new Float32Array(this._capacity * JIV_FLOATS_PER_INSTANCE);
    newData.set(this._data);
    this._data = newData;
  };
}
