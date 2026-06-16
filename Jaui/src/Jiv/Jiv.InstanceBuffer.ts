import type { Jiv } from './Jiv';
import { type Mat2x3, MAT_IDENTITY, matApplyX, matApplyY, matScaleX, matScaleY, matCos, matSin } from '../Transform/Mat2x3';

// 3D (perspective) panels reuse this same instance layout via a SENTINEL, no
// extra attributes — exactly how `(cos,sin)=(1,0)` already means "no rotation".
// When `xformIndex >= 0` the panel is projective: a_Rect (loc 1) carries the
// panel's NATURAL box (not the device AABB), and a_PanelGeom (loc 2) carries
// (2.0, xformIndex, halfW, halfH) — the out-of-range cos=2.0 flags the vertex
// to fetch this panel's homography from the shared u_XformTex by index and
// project the natural corners. 2D panels are byte-identical to before.

// Per-instance floats (15 vec4 slots = 60 floats = 240 bytes):
//   loc  1: a_Rect         (x, y, w, h)  — the AABB of the (possibly rotated) panel
//   loc  2: a_PanelGeom    (cosθ, sinθ, halfW, halfH)
//          The panel CENTER (cx, cy) is recomputed in-shader as the AABB center
//          (a_Rect.xy + a_Rect.zw*0.5) — it's mathematically identical to the old
//          stored center (margins are symmetric), which freed these two lanes to
//          carry the rotation basis (cosθ, sinθ) WITHOUT a 17th vertex attribute
//          (WebGL2 caps at 16). Rotation 0 ⇒ (1, 0): the no-rotation identity.
//   loc  3: a_Radii        (tl, tr, br, bl)
//   loc  4: a_Tint         (R, G, B, A)        — Background color
//   loc  5: a_BorderColor  (R, G, B, A)
//   loc  6: a_ShadowColor  (R, G, B, A)
//   loc  7: a_ShadowParams (offsetX, offsetY, blur, borderWidth)
//   loc  8: a_StyleParams  (borderEdgeAa, smoothness, opacity, brightness)
//          .w was materialType (now a compile-time shader-variant const);
//          repurposed to the foreground Brightness multiplier.
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

/** Quantize a grade multiplier to an integer code. `scale` = codes per unit,
 *  `max` = the code ceiling (bit budget). Non-finite → identity (1). */
const _q = (v: number, scale: number, max: number): number => {
  const x = Number.isFinite(v) ? v : 1;
  const code = Math.round(x * scale);
  return code < 0 ? 0 : code > max ? max : code;
};

/** Bit-pack the foreground filter grade (brightness, saturation, contrast)
 *  into a single 24-bit-exact float for a_StyleParams.w. brightness: 10 bits
 *  over [0, 4) (×256, smooth for animation); saturation/contrast: 7 bits each
 *  over [0, 4) (×32). Layout: brightnessCode·16384 + saturationCode·128 +
 *  contrastCode. The panel frag reverses this. Identity (1,1,1) packs to
 *  256·16384 + 32·128 + 32. */
const _packFgGrade = (brightness: number, saturation: number, contrast: number): number => {
  const b = _q(brightness, 256, 1023);
  const s = _q(saturation, 32, 127);
  const c = _q(contrast, 32, 127);
  return b * 16384 + s * 128 + c;
};

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
  Push = (jiv: Jiv, dpr: number, m: Mat2x3 = MAT_IDENTITY,
          clipOffset: number = 0, clipCount: number = 0, xformIndex: number = -1): void => {
    if (this._count >= this._capacity) this._grow();

    const style = jiv.RenderStyle;
    const d = dpr;
    const offset = this._count * JIV_FLOATS_PER_INSTANCE;

    // Axis scales + rotation basis come FROM THE CASCADED MATRIX, so a panel
    // rotated by an ancestor (the parent's rotation accumulated into `m`)
    // rotates with it. cos/sin are the ACCUMULATED basis — NOT the node's own
    // Transform.Rotation (that was already folded into `m` by renderNode, so
    // reading it again here would double-count). At rotation 0 / no Visual*,
    // m = [cx,0,0,cy,ox,oy] → cx=|a|, cy=|d|, cos=1, sin=0: legacy values.
    const cx = matScaleX(m);
    const cy = matScaleY(m);
    const cos = matCos(m);
    const sin = matSin(m);
    const w = cx * jiv.Width * d;   // unrotated device size (SDF half-extents)
    const h = cy * jiv.Height * d;
    // Border / shadow widths scale with the rendered geometry so they
    // stay visually proportional under a Visual* cascade — matches CSS
    // where transform on an ancestor scales its painted output.
    // Average the axes so non-uniform scale doesn't pinch shadows.
    const avgScale = (cx + cy) * 0.5;
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

    // Panel center: map the node's LOCAL center through the full matrix so the
    // accumulated rotation+translation places it at its true rotated position.
    const centerLX = jiv.X + jiv.Width * 0.5;
    const centerLY = jiv.Y + jiv.Height * 0.5;
    const cxDev = matApplyX(m, centerLX, centerLY) * d;
    const cyDev = matApplyY(m, centerLX, centerLY) * d;

    const halfW = w / 2;
    const halfH = h / 2;
    // Expand the AABB so the rotated quad (plus border/shadow margins) stays
    // inside the rasterized rectangle: a rect of half-extents (a, b) rotated by
    // θ has axis-aligned half-extents (|cos|·a + |sin|·b, |sin|·a + |cos|·b).
    const aCos = Math.abs(cos);
    const aSin = Math.abs(sin);
    const rotHalfX = aCos * (halfW + marginX) + aSin * (halfH + marginY);
    const rotHalfY = aSin * (halfW + marginX) + aCos * (halfH + marginY);

    const data = this._data;

    data[offset + 0] = cxDev - rotHalfX;
    data[offset + 1] = cyDev - rotHalfY;
    data[offset + 2] = rotHalfX * 2;
    data[offset + 3] = rotHalfY * 2;

    data[offset + 4] = cos;
    data[offset + 5] = sin;
    data[offset + 6] = halfW;
    data[offset + 7] = halfH;

    // 3D (projective) override: a_Rect → the NATURAL box; a_PanelGeom.xy →
    // (2.0 sentinel, xformIndex). halfW/halfH stay for the SDF's undeformed
    // panel-local extent. The vertex fetches the homography by index and
    // projects the natural corners (with the perspective w-divide).
    if (xformIndex >= 0) {
      data[offset + 0] = jiv.X;
      data[offset + 1] = jiv.Y;
      data[offset + 2] = jiv.Width;
      data[offset + 3] = jiv.Height;
      data[offset + 4] = 2.0;
      data[offset + 5] = xformIndex;
    }

    data[offset + 8] = style.BorderRadius[0] * avgScale * d;
    data[offset + 9] = style.BorderRadius[1] * avgScale * d;
    data[offset + 10] = style.BorderRadius[2] * avgScale * d;
    data[offset + 11] = style.BorderRadius[3] * avgScale * d;

    data[offset + 12] = style.Background.Color.R;
    data[offset + 13] = style.Background.Color.G;
    data[offset + 14] = style.Background.Color.B;
    data[offset + 15] = style.Background.Color.A;

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
    // offset+31 (a_StyleParams.w) was the materialType flag, but in production
    // the shader picks the glass/non-glass variant at compile time, so this
    // lane is free. It now carries the foreground Filter GRADE — brightness,
    // saturation, AND contrast — bit-packed into this one UNIVERSAL lane so the
    // foreground filter renders identically on every material (glass + plain
    // panels alike), without spending one of WebGL2's full 16 vertex-attribute
    // slots. Values are the CASCADED Effective* (a parent's `Filter` folds into
    // descendants). brightness gets 10 bits (smooth animation), saturation /
    // contrast 7 each; all three are exact in a 24-bit float mantissa. The frag
    // unpacks and runs applyGrading. NaN-guarded so it can never black a panel.
    data[offset + 31] = _packFgGrade(jiv.EffectiveBrightness, jiv.EffectiveSaturation, jiv.EffectiveContrast);

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
