import type { Jiv } from './Jiv';

// Per-instance floats (15 vec4 slots = 60 floats = 240 bytes):
//   loc  1: a_Rect         (x, y, w, h)
//   loc  2: a_PanelGeom    (cx, cy, halfW, halfH)
//   loc  3: a_Radii        (tl, tr, br, bl)
//   loc  4: a_Tint         (R, G, B, A)        — Background color
//   loc  5: a_BorderColor  (R, G, B, A)
//   loc  6: a_ShadowColor  (R, G, B, A)
//   loc  7: a_ShadowParams (offsetX, offsetY, blur, borderWidth)
//   loc  8: a_StyleParams  (borderEdgeAa, smoothness, opacity, materialType)
//   loc  9: a_Grading      (brightness, saturation, contrast, frostLod)
//   loc 10: a_Refraction   (thickness, bezelWidth, refractionStrength, bezelScale)
//   loc 11: a_Lighting     (lightDirX, lightDirY, lightIntensity, fresnelStrength)
//   loc 12: a_Specular     (specularIntensity, specularSharpness, chromaticAberration, innerBlur)
//   loc 13: a_RimEdge      (edgeLightTop, edgeLightBottom, borderVariance, bulge)
//   loc 14: a_Outline      (borderAlphaVariance, borderFresnelBrightness, clipOffset, clipCount)
//          clipOffset/clipCount index into the per-frame clip-stack buffer.
//          count=0 means no clipping — shader short-circuits.
//   loc 15: a_BorderFilter (brightnessMul, saturationMul, contrastMul, lodOffset)
//
// WebGL2 guarantees only 16 vertex attribute slots (locations 0..15), so we
// pack clip_meta into `a_Outline`'s padding rather than adding a 17th slot.

export const JIV_FLOATS_PER_INSTANCE = 60;

/**
 * CPU-side instance data packer for Jiv panels. Reads from Jiv.RenderStyle
 * and packs 60 floats per instance into a Float32Array. Backend-agnostic —
 * the Renderer consumes the raw data via PanelAddInstance().
 */
export class JivInstanceBuffer {
  private _data: Float32Array;
  private _capacity: number;
  private _count: number = 0;

  constructor(initialCapacity: number = 64) {
    this._capacity = initialCapacity;
    this._data = new Float32Array(initialCapacity * JIV_FLOATS_PER_INSTANCE);
  }

  get Count(): number { return this._count; }
  get Data(): Float32Array { return this._data; }

  Begin = (): void => { this._count = 0; };

  /**
   * The (cx, ox, cy, oy) tuple is the affine map from this Jiv's
   * natural (post-layout, pre-Visual-transform) coords to canvas
   * pixels:
   *
   *   worldX = (ox + cx * naturalX) * dpr
   *   worldY = (oy + cy * naturalY) * dpr
   *
   * The render walk composes parent's effective transform with own's
   * VisualScale around own's pivot before calling Push, so the values
   * passed in already reflect the *cascaded* transform — the tree
   * walker is the source of truth, and Push just consumes. Identity
   * (cx=cy=1, ox=oy=0) reduces to the legacy `node.X` placement.
   */
  Push = (jiv: Jiv, dpr: number,
          cx: number = 1, cy: number = 1,
          ox: number = 0, oy: number = 0,
          clipOffset: number = 0, clipCount: number = 0): void => {
    if (this._count >= this._capacity) this._grow();

    const style = jiv.RenderStyle;
    const d = dpr;
    const offset = this._count * JIV_FLOATS_PER_INSTANCE;

    const x = (ox + cx * jiv.X) * d;
    const y = (oy + cy * jiv.Y) * d;
    const w = cx * jiv.Width * d;
    const h = cy * jiv.Height * d;
    // Border / shadow widths scale with the rendered geometry so they
    // stay visually proportional under a Visual* cascade — matches CSS
    // where transform on an ancestor scales its painted output.
    // Average the axes so non-uniform scale doesn't pinch shadows.
    const avgScale = (Math.abs(cx) + Math.abs(cy)) * 0.5;
    const borderWidth = style.BorderWidth * avgScale * d;
    const borderEdgeAa = style.BorderBlur * avgScale * d;
    const shadowBlur = style.ShadowBlur * avgScale * d;
    const shadowOffX = style.ShadowOffsetX * avgScale * d;
    const shadowOffY = style.ShadowOffsetY * avgScale * d;

    const shadowMarginX = shadowBlur + Math.abs(shadowOffX);
    const shadowMarginY = shadowBlur + Math.abs(shadowOffY);
    const borderMargin = borderWidth + borderEdgeAa;
    const marginX = Math.max(shadowMarginX, borderMargin);
    const marginY = Math.max(shadowMarginY, borderMargin);

    const data = this._data;

    data[offset + 0] = x - marginX;
    data[offset + 1] = y - marginY;
    data[offset + 2] = w + marginX * 2;
    data[offset + 3] = h + marginY * 2;

    data[offset + 4] = x + w / 2;
    data[offset + 5] = y + h / 2;
    data[offset + 6] = w / 2;
    data[offset + 7] = h / 2;

    data[offset + 8] = style.BorderRadius[0] * avgScale * d;
    data[offset + 9] = style.BorderRadius[1] * avgScale * d;
    data[offset + 10] = style.BorderRadius[2] * avgScale * d;
    data[offset + 11] = style.BorderRadius[3] * avgScale * d;

    data[offset + 12] = style.Background.R;
    data[offset + 13] = style.Background.G;
    data[offset + 14] = style.Background.B;
    data[offset + 15] = style.Background.A;

    data[offset + 16] = style.BorderColor.R;
    data[offset + 17] = style.BorderColor.G;
    data[offset + 18] = style.BorderColor.B;
    data[offset + 19] = style.BorderColor.A;

    data[offset + 20] = style.ShadowColor.R;
    data[offset + 21] = style.ShadowColor.G;
    data[offset + 22] = style.ShadowColor.B;
    data[offset + 23] = style.ShadowColor.A;

    data[offset + 24] = shadowOffX;
    data[offset + 25] = shadowOffY;
    data[offset + 26] = shadowBlur;
    data[offset + 27] = borderWidth;

    data[offset + 28] = borderEdgeAa;
    data[offset + 29] = style.BorderRadiusSmoothness;
    // Implicit Presence fade now lives in the default `Opacity: Presence`
    // (Jiv.Defaults) — RenderStyle.Opacity already carries the current
    // spring value. Authors override via `Opacity: 1` for no fade or
    // `Opacity: <expr>` for a custom curve.
    data[offset + 30] = jiv.EffectiveOpacity;
    data[offset + 31] = style.Material === 'LiquidGlass' ? 1 : 0;

    data[offset + 32] = style.BackdropBrightness;
    data[offset + 33] = style.BackdropSaturation;
    data[offset + 34] = style.BackdropContrast;
    const blurPx = Math.max(0.5, style.BackdropFrostBlur * d);
    data[offset + 35] = Math.max(0, Math.min(10, Math.log2(blurPx)));

    data[offset + 36] = style.Thickness * avgScale * d;
    data[offset + 37] = style.BezelWidth * avgScale * d;
    data[offset + 38] = style.Refraction;
    data[offset + 39] = style.BezelScale;

    const rad = style.LightAngle * (Math.PI / 180);
    data[offset + 40] = Math.cos(rad);
    data[offset + 41] = -Math.sin(rad);
    data[offset + 42] = style.LightIntensity;
    data[offset + 43] = style.FresnelStrength;

    data[offset + 44] = style.SpecularIntensity;
    data[offset + 45] = style.SpecularSharpness;
    data[offset + 46] = style.ChromaticAberration;
    data[offset + 47] = style.InnerBlur;

    data[offset + 48] = style.EdgeLightTop;
    data[offset + 49] = style.EdgeLightBottom;
    data[offset + 50] = style.BorderVariance;
    data[offset + 51] = style.Fillet;

    data[offset + 52] = style.BorderAlphaVariance;
    data[offset + 53] = style.BorderFresnelBrightness;
    data[offset + 54] = clipOffset;
    data[offset + 55] = clipCount;

    data[offset + 56] = style.BorderBrightness;
    data[offset + 57] = style.BorderSaturation;
    data[offset + 58] = style.BorderContrast;
    data[offset + 59] = style.BorderBackdropBlur;

    this._count++;
  };

  private _grow = (): void => {
    this._capacity *= 2;
    const newData = new Float32Array(this._capacity * JIV_FLOATS_PER_INSTANCE);
    newData.set(this._data);
    this._data = newData;
  };
}
