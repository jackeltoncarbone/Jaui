import type { Jiv } from './Jiv';
import { type Mat2x3, MAT_IDENTITY, matApplyX, matApplyY, matScaleX, matScaleY, matCos, matSin } from '../Transform/Mat2x3';
import { FoldVibrancy, VibrancyGraded } from '../Core/Vibrancy';
import type { VibrancyValue } from '../Core/Vibrancy';
import { AUTO_FROST_MAX } from '../Core/Style.Resolver';
import { GLASS_SHADOW_OFFSET_Y, GlassShadowRadius, GlassBlurNeedsOf, GlassShadowPeak, GlassSizeRamps, GlassIsLens } from '../Core/Glass.Pipeline';

// 3D (perspective) panels reuse this same instance layout via a SENTINEL, no
// extra attributes — exactly how `(cos,sin)=(1,0)` already means "no rotation".
// When `xformIndex >= 0` the panel is projective: a_Rect (loc 1) carries the
// panel's NATURAL box (not the device AABB), and a_PanelGeom (loc 2) carries
// (2.0, xformIndex, halfW, halfH) — the out-of-range cos=2.0 flags the vertex
// to fetch this panel's homography from the shared u_XformTex by index and
// project the natural corners. 2D panels are byte-identical to before.

// Per-instance floats (14 vec4 slots = 56 floats = 224 bytes):
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
//   loc 10: a_Refraction   (thickness, refraction band, free, refraction amount)
//   loc 11: a_Lighting     (lightAngle rad, bodyTint, lightIntensity, fresnelStrength)
//          The light rides as its ANGLE (the frag takes cos/sin) so the freed lane carries the
//          signed glass body Tint: negative toward black, positive toward white.
//   loc 12: a_Specular     (specularIntensity, specularGlow, chromaticAberration, borderFade in device px)
//   loc 13: a_RimEdge      (free, free, lens, lens ink)
//   loc 14: a_Outline      (dispersion amount + angle, height + inset (packed), clipOffset, clipCount)
//          clipOffset/clipCount index into the per-frame clip-stack buffer.
//          count=0 means no clipping — shader short-circuits.

export const JIV_FLOATS_PER_INSTANCE = 56;

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

const _FG_GRADE_IDENTITY = _packFgGrade(1, 1, 1);

/** A panel's shape in device px: half extents, per-corner drawn radii (tl, tr, br, bl) and the
 *  smoothness lane (the continuous corner's smoothing). */
export interface JivShape {
  HalfWidth: number;
  HalfHeight: number;
  Radii: readonly [number, number, number, number];
  Smoothness: number;
}

/** A panel's shape and placement in device px, as its instance packs them. */
export interface JivPanelShape extends JivShape {
  Radii: [number, number, number, number];
  CenterX: number;
  CenterY: number;
  Cos: number;
  Sin: number;
}

export const NewJivPanelShape = (): JivPanelShape => ({
  HalfWidth: 0, HalfHeight: 0, Radii: [0, 0, 0, 0], Smoothness: 0, CenterX: 0, CenterY: 0, Cos: 1, Sin: 0,
});

/** The shape lanes `JivInstanceBuffer.Push` packs, from the cascaded matrix `m`, written into `out`. */
export const JivPanelShapeOf = (jiv: Jiv, dpr: number, m: Mat2x3, out: JivPanelShape = NewJivPanelShape()): JivPanelShape => {
  const style = jiv.RenderStyle;
  const cx = matScaleX(m);
  const cy = matScaleY(m);
  const avgScale = (cx + cy) * 0.5;
  const halfWidth = cx * jiv.Width * dpr * 0.5;
  const halfHeight = cy * jiv.Height * dpr * 0.5;
  const centerLX = jiv.X + jiv.Width * 0.5;
  const centerLY = jiv.Y + jiv.Height * 0.5;
  const r = style.BorderRadius;
  out.HalfWidth = halfWidth;
  out.HalfHeight = halfHeight;
  out.Radii[0] = r[0] * avgScale * dpr;
  out.Radii[1] = r[1] * avgScale * dpr;
  out.Radii[2] = r[2] * avgScale * dpr;
  out.Radii[3] = r[3] * avgScale * dpr;
  out.Smoothness = Math.max(0, Math.min(1, style.BorderRadiusSmoothness));
  out.CenterX = matApplyX(m, centerLX, centerLY) * dpr;
  out.CenterY = matApplyY(m, centerLX, centerLY) * dpr;
  out.Cos = matCos(m);
  out.Sin = matSin(m);
  return out;
};


/** `Blur(Auto)`'s frost: a share of the short half side, clamped to [MIN, AUTO_FROST_MAX] CSS px, so a
 *  small control stays clear and a sheet frosts. */
const AUTO_FROST_SHARE = 0.03;
const AUTO_FROST_MIN = 0.5;

/** The backdrop frost a panel draws with, in CSS px: its authored `Blur()`, or the size rule under `Blur(Auto)`. */
export const JivFrostCssPx = (jiv: Jiv, dpr: number = 1): number => {
  const style = jiv.RenderStyle;
  // Glass's pyramid is built at its sharpest read (Core/Glass.Pipeline.ts): the frost is Apple's, not authored.
  if (style.Material === 'LiquidGlass') {
    return Math.pow(2, GlassBlurNeedsOf(JivGlassSpan(jiv), dpr, style.GlassVariant, GlassIsLens(style.Lens)).BaseLod) / dpr;
  }
  if (!style.BackdropFrostAuto) return style.BackdropFrostBlur;
  const minHalf = Math.min(jiv.Width, jiv.Height) * 0.5;
  return Math.max(AUTO_FROST_MIN, Math.min(AUTO_FROST_MAX, AUTO_FROST_SHARE * minHalf));
};

/** A glass surface's span, Apple's S: its minor dimension in points. */
export const JivGlassSpan = (jiv: Jiv): number => Math.max(1, Math.min(jiv.Width, jiv.Height));

/**
 * CPU-side instance data packer for Jiv panels. Reads from Jiv.RenderStyle
 * and packs 56 floats per instance into a Float32Array. Backend-agnostic —
 * the Renderer consumes the raw data via PanelAddInstance().
 */
export class JivInstanceBuffer {
  /** TEMP `?no-shadow` diag: zero every panel's drop-shadow (blur+offset+alpha)
   *  so the draw quad isn't expanded by the shadow margin — measures the
   *  shadow's fill/overdraw share. Set from Jaui's URL-flag parse. */
  static DiagNoShadow = false;
  private _data: Float32Array;
  private _capacity: number;
  private _count: number = 0;
  private readonly _shape: JivPanelShape = NewJivPanelShape();

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
  /** `borderMode` controls how this instance treats its border stroke, used
   *  by the `BorderLayer` paint-ordering feature:
   *    • 'Normal'      — border painted with the panel (default).
   *    • 'Suppress'    — panel drawn with NO border and no highlight; the border is
   *                      emitted separately as a 'BorderOnly' instance, the rim as a
   *                      'RimOnly' one, among children at the node's BorderLayer position.
   *    • 'BorderOnly'  — only the border stroke paints: background, shadow,
   *                      and fill are zeroed so the instance is a
   *                      transparent quad carrying just the stroke.
   *    • 'VibrancyOnly' — the vibrancy shape draw (Core/Vibrancy.ts): the element's SHAPE (radii,
   *                      smoothness, clip stack, opacity) filled with |amount| x color at alpha 1,
   *                      and nothing else: no border, no shadow, no grade, no glass. The walk draws
   *                      it alone, under the element, under the vibrancy blend, so the fragment's
   *                      alpha is exactly the coverage the element's own fill would have had.
   *    • 'RimOnly'     — the RIM, for the RIM_ONLY program at the
   *                      BorderLayer slot: the shape, the clip, the opacity and the rim's height and
   *                      amount. Its quad is the face and a pixel past it.
   *
   *  `shadow` splits a glass fill from its drop shadow. 'Only' is the shadow alone: for glass it is
   *  Apple's (Core/Glass.md), black from the flat program, or colored from the glass program on
   *  glass 64 pt and up. 'Excluded' is the panel without it, its quad shrunk to the face and a pixel
   *  of antialiasing, so the glass program shades only the fragments it can light. */
  Push = (jiv: Jiv, dpr: number, m: Mat2x3 = MAT_IDENTITY,
          clipOffset: number = 0, clipCount: number = 0, xformIndex: number = -1,
          borderMode: 'Normal' | 'Suppress' | 'BorderOnly' | 'VibrancyOnly' | 'RimOnly' = 'Normal',
          /** `'VibrancyOnly'` only: the value to fill with when it is NOT the backdrop zone's (the
           *  foreground zone's, or the cascaded property's). */
          vibrancyOverride: VibrancyValue | null = null,
          shadow: 'Included' | 'Excluded' | 'Only' = 'Included'): void => {
    if (this._count >= this._capacity) this._grow();

    const style = jiv.RenderStyle;
    const d = dpr;
    const offset = this._count * JIV_FLOATS_PER_INSTANCE;
    const shape = JivPanelShapeOf(jiv, d, m, this._shape);

    // Border / shadow widths scale with the rendered geometry so they
    // stay visually proportional under a Visual* cascade — matches CSS
    // where transform on an ancestor scales its painted output.
    // Average the axes so non-uniform scale doesn't pinch shadows.
    const avgScale = (matScaleX(m) + matScaleY(m)) * 0.5;
    const borderWidth = style.BorderWidth * avgScale * d;
    const borderEdgeAa = style.BorderBlur * avgScale * d;
    const rimOnly = borderMode === 'RimOnly';
    const glass = style.Material === 'LiquidGlass';
    const span = JivGlassSpan(jiv) * avgScale;
    const _ns = JivInstanceBuffer.DiagNoShadow || shadow === 'Excluded' || rimOnly;
    // Glass casts Apple's shadow: offset (0, 8) pt, reaching two radii (Glass.Pipeline), its alpha by size.
    const lens = GlassIsLens(style.Lens);
    const glassShadowPeak = glass ? GlassShadowPeak(span, style.GlassClear, lens) : 0;
    // The lens's shadow is a plain one, drawn by the flat program.
    const glassColoredShadow = glass && !lens && shadow === 'Only' && GlassSizeRamps(span).V > 0 && glassShadowPeak > 0;
    const shadowBlur = _ns ? 0 : glass ? 2 * GlassShadowRadius(span) * avgScale * d : style.ShadowBlur * avgScale * d;
    const shadowOffX = _ns || glass ? 0 : style.ShadowOffsetX * avgScale * d;
    const shadowOffY = _ns ? 0 : glass ? GLASS_SHADOW_OFFSET_Y * avgScale * d : style.ShadowOffsetY * avgScale * d;

    const shadowMarginX = shadowBlur + Math.abs(shadowOffX);
    const shadowMarginY = shadowBlur + Math.abs(shadowOffY);
    const borderMargin = rimOnly ? 1 : borderWidth + borderEdgeAa + (shadow === 'Excluded' ? 1 : 0);
    const marginX = Math.max(shadowMarginX, borderMargin);
    const marginY = Math.max(shadowMarginY, borderMargin);

    const halfW = shape.HalfWidth;
    const halfH = shape.HalfHeight;
    // Expand the AABB so the rotated quad (plus border/shadow margins) stays
    // inside the rasterized rectangle: a rect of half-extents (a, b) rotated by
    // θ has axis-aligned half-extents (|cos|·a + |sin|·b, |sin|·a + |cos|·b).
    const aCos = Math.abs(shape.Cos);
    const aSin = Math.abs(shape.Sin);
    const rotHalfX = aCos * (halfW + marginX) + aSin * (halfH + marginY);
    const rotHalfY = aSin * (halfW + marginX) + aCos * (halfH + marginY);

    const data = this._data;

    data[offset + 0] = shape.CenterX - rotHalfX;
    data[offset + 1] = shape.CenterY - rotHalfY;
    data[offset + 2] = rotHalfX * 2;
    data[offset + 3] = rotHalfY * 2;

    data[offset + 4] = shape.Cos;
    data[offset + 5] = shape.Sin;
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

    data[offset + 8] = shape.Radii[0];
    data[offset + 9] = shape.Radii[1];
    data[offset + 10] = shape.Radii[2];
    data[offset + 11] = shape.Radii[3];

    data[offset + 12] = style.Background.Color.R;
    data[offset + 13] = style.Background.Color.G;
    data[offset + 14] = style.Background.Color.B;
    data[offset + 15] = style.Background.Color.A;

    data[offset + 16] = style.BorderColor.R;
    data[offset + 17] = style.BorderColor.G;
    data[offset + 18] = style.BorderColor.B;
    data[offset + 19] = style.BorderColor.A;

    data[offset + 20] = glass ? 0 : style.ShadowColor.R;
    data[offset + 21] = glass ? 0 : style.ShadowColor.G;
    data[offset + 22] = glass ? 0 : style.ShadowColor.B;
    data[offset + 23] = _ns ? 0 : glass ? glassShadowPeak : style.ShadowColor.A;

    data[offset + 24] = shadowOffX;
    data[offset + 25] = shadowOffY;
    data[offset + 26] = shadowBlur;
    data[offset + 27] = borderWidth;

    data[offset + 28] = borderEdgeAa;
    data[offset + 29] = shape.Smoothness;
    // Implicit Presence fade now lives in the default `Opacity: Presence`
    // (Jiv.Defaults) — RenderStyle.Opacity already carries the current
    // spring value. Authors override via `Opacity: 1` for no fade or
    // `Opacity: <expr>` for a custom curve.
    data[offset + 30] = jiv.EffectiveOpacity;
    // The foreground Filter GRADE -- brightness, saturation AND contrast -- bit-packed into one lane so
    // it renders identically on every material. Values are the CASCADED Effective* (a parent's
    // `Filter` folds into descendants). brightness gets 10 bits (smooth animation), saturation /
    // contrast 7 each; all three are exact in a 24-bit float mantissa. NaN-guarded so it can never
    // black a panel.
    data[offset + 31] = _packFgGrade(jiv.EffectiveBrightness, jiv.EffectiveSaturation, jiv.EffectiveContrast);

    // A vibrancy that could not be drawn under the element rides in the grade it already runs.
    const grade = FoldVibrancy(style.BackdropBrightness, style.BackdropContrast, VibrancyGraded(jiv));
    data[offset + 32] = grade.Brightness;
    data[offset + 33] = style.BackdropSaturation;
    data[offset + 34] = grade.Contrast;
    const blurPx = Math.max(0.5, JivFrostCssPx(jiv, d) * d);
    data[offset + 35] = Math.max(0, Math.min(10, Math.log2(blurPx)));

    // Apple's glass (Jiv.Panel.frag, Glass.Pipeline.glsl): its span in points, the shadow draw's mode (1 black,
    // 2 colored), the lens multiplier, the device px per point, the theme, the variant.
    data[offset + 36] = style.Thickness * avgScale * d;
    data[offset + 37] = span;
    data[offset + 38] = glass && shadow === 'Only' ? (glassColoredShadow ? 2 : 1) : 0;
    data[offset + 39] = style.Refraction;

    data[offset + 40] = d * avgScale;
    data[offset + 41] = style.Tint;
    data[offset + 42] = style.SchemeDark ? 1 : 0;
    data[offset + 43] = style.GlassClear;

    // The highlight: each light's amount and the band's depth in points.
    data[offset + 44] = style.RimStrength;
    data[offset + 45] = style.RimWidth;
    data[offset + 46] = style.ChromaticAberration;
    data[offset + 47] = style.BorderFade * avgScale * d;

    data[offset + 48] = 0;
    data[offset + 49] = 0;
    // The active lens (0 is none, 1 the pressed lens).
    data[offset + 50] = style.Lens;
    // The lens's ink colour, packed 8 bits a channel and offset by one so 0 means none (exact in a float).
    const ink = style.LensInk;
    data[offset + 51] = ink.A > 0.001
      ? 1 + Math.round(ink.R * 255) * 65536 + Math.round(ink.G * 255) * 256 + Math.round(ink.B * 255) : 0;

    // The content lensing's dispersion, two values a lane, each exact in a float's 24 bits: amount (pt, 1/64 steps over
    // -64..64) and angle (whole degrees, 0..359); height and inset (pt, 1/32 steps over 0..64 and -32..32).
    const q = (v: number, step: number, lo: number, hi: number): number => Math.round((Math.min(Math.max(v, lo), hi) - lo) / step);
    data[offset + 52] = q(style.GlassDispersionAmount, 1 / 64, -64, 64) + 8192 * q(((style.GlassDispersionAngle % 360) + 360) % 360, 1, 0, 359);
    data[offset + 53] = q(style.GlassDispersionHeight, 1 / 32, 0, 64) + 4096 * q(style.GlassDispersionInset, 1 / 32, -32, 32);
    data[offset + 54] = clipOffset;
    data[offset + 55] = clipCount;

    // ── BorderLayer paint-ordering overrides ──
    // 'Suppress' draws the panel WITHOUT its border (the border re-appears as a
    // separate 'BorderOnly' instance interleaved among children). 'BorderOnly'
    // strips everything BUT the stroke: transparent background + no shadow, and
    // Thickness=0 so the frag takes the plain stroke composite regardless of
    // the host material.
    if (shadow === 'Only') {
      data[offset + 15] = 0;  // Background alpha → no fill
      data[offset + 16] = 0; data[offset + 17] = 0; data[offset + 18] = 0; data[offset + 19] = 0; // BorderColor
      data[offset + 27] = 0;  // borderWidth
      data[offset + 32] = 1; data[offset + 33] = 1; data[offset + 34] = 1; // no grade
      data[offset + 41] = 0;  // body Tint
      data[offset + 44] = 0;  // no highlight
      // The flat program, unless the shadow reads the backdrop: then the glass program, at the surface's frost.
      if (!glassColoredShadow) { data[offset + 35] = 0; data[offset + 36] = 0; }
    }

    if (borderMode === 'Suppress') {
      data[offset + 44] = 0;  // the rim rides the pass at the BorderLayer slot
      data[offset + 27] = 0;  // borderWidth
      data[offset + 16] = 0; data[offset + 17] = 0; data[offset + 18] = 0; data[offset + 19] = 0; // BorderColor
    } else if (borderMode === 'BorderOnly') {
      data[offset + 15] = 0;  // Background alpha → no fill
      data[offset + 23] = 0;  // ShadowColor alpha → no shadow
      data[offset + 36] = 0;  // Thickness → non-glass stroke path
      // Neutralize the backdrop filter too: a host with a BackdropFilter would keep
      // hasBackdropFilter true on the stroke-only quad, which draws with no backdrop bound
      // (the dummy BLACK texture) and would fill the WHOLE interior with graded black.
      data[offset + 32] = 1;  // BackdropBrightness → identity
      data[offset + 33] = 1;  // BackdropSaturation → identity
      data[offset + 34] = 1;  // BackdropContrast → identity
      data[offset + 35] = 0;  // frost LOD → no backdrop sample
      data[offset + 41] = 0;  // body Tint → the stroke quad tints nothing
    } else if (borderMode === 'VibrancyOnly') {
      // The shape draw's fill: |amount| times the color at alpha 1. The premultiplied vibrancy output
      // then multiplies it by the element's own coverage, so a half-covered edge pixel brings half.
      const amount = vibrancyOverride === null ? style.BackdropVibrancy : vibrancyOverride.Amount;
      const c = vibrancyOverride === null ? style.BackdropVibrancyColor : vibrancyOverride;
      const l = Math.abs(amount);
      data[offset + 12] = l * c.R; data[offset + 13] = l * c.G; data[offset + 14] = l * c.B; data[offset + 15] = 1;
      data[offset + 16] = 0; data[offset + 17] = 0; data[offset + 18] = 0; data[offset + 19] = 0;
      data[offset + 20] = 0; data[offset + 21] = 0; data[offset + 22] = 0; data[offset + 23] = 0;
      data[offset + 24] = 0; data[offset + 25] = 0; data[offset + 26] = 0; data[offset + 27] = 0;
      data[offset + 31] = _FG_GRADE_IDENTITY;
      data[offset + 32] = 1; data[offset + 33] = 1; data[offset + 34] = 1; data[offset + 35] = 0;
      data[offset + 36] = 0; data[offset + 41] = 0;
      data[offset + 44] = 0; data[offset + 46] = 0; data[offset + 47] = 0;
    }

    this._count++;
  };

  private _grow = (): void => {
    this._capacity *= 2;
    const newData = new Float32Array(this._capacity * JIV_FLOATS_PER_INSTANCE);
    newData.set(this._data);
    this._data = newData;
  };
}
