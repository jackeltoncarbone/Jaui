import type { Color } from '../Core/Types';
import type { Transform } from '../Transform/Transform.Types';
import type { Overflow } from '../Layout/Layout.Types';

export type CornerShape = 'Round' | 'Squircle' | 'Bevel' | 'Scoop' | 'Notch' | number;

export type MaterialType = 'None' | 'LiquidGlass' | 'SolidGlass';

export type BlendMode =
  | 'Normal' | 'Multiply' | 'Screen' | 'Overlay'
  | 'Darken' | 'Lighten' | 'ColorDodge' | 'ColorBurn'
  | 'SoftLight' | 'HardLight' | 'Difference' | 'Exclusion';

export interface JivStyle {
  // Material — 'None' uses the default panel shader; 'LiquidGlass'/'SolidGlass'
  // route through the glass pipeline (backdrop sampling, grading)
  Material: MaterialType;

  // Shape
  BorderRadius: [number, number, number, number]; // tl, tr, br, bl
  CornerShape: [CornerShape, CornerShape, CornerShape, CornerShape];
  Smoothness: number;
  Overflow: Overflow;

  // Fill
  Background: Color;
  BlendMode: BlendMode;

  // Physical material — the Jiv is a slab with measurable properties
  Frost: number;               // backdrop blur intensity (0 = clear, 1 = full frost)
  BackdropFrostBlur: number;           // blur radius in px when Frost > 0
  Thickness: number;           // bezel refraction magnitude in px (displacement at hump peak)
  Fillet: number;              // reserved — multiplies InnerBlur (softens interior)
  Refraction: number;          // overall refraction multiplier (0..1)
  BackdropBrightness: number;          // backdrop brightness multiplier
  BackdropSaturation: number;          // backdrop saturation
  BackdropContrast: number;            // backdrop contrast

  // Refraction band geometry
  BezelWidth: number;          // refraction band width in CSS px (how far inward the rim effect reaches)
  BezelScale: number;          // where the displacement hump peaks within the bezel (0..1, default ~0.35)

  // Lighting (the slab has a virtual directional light)
  LightAngle: number;          // degrees (0 = +x, 90 = up). Default -45 = upper-left
  LightIntensity: number;      // overall lighting multiplier (0..∞, default 1)

  // Specular catchlight (Blinn-Phong on the bevel)
  SpecularIntensity: number;   // 0..1 — how bright the catchlight is
  SpecularSharpness: number;   // Blinn exponent (20..300) — tighter = smaller crescent

  // Fresnel rim (grazing-angle reflection on the bevel)
  FresnelStrength: number;     // 0..1 — multiplies Fresnel contribution

  // Chromatic aberration at the rim
  ChromaticAberration: number; // 0..1 — RGB channel split in the refraction

  // Hemispherical rim ambient (top vs bottom rim brightness — directional environment)
  EdgeLightTop: number;        // 0..1 — rim ambient on the lit side
  EdgeLightBottom: number;     // 0..1 — rim ambient on the unlit side

  // Shape-driven variables
  BorderVariance: number;      // 0..1 — how much border width varies around perimeter (thicker on lit side)
  BorderAlphaVariance: number; // 0..1 — how much border alpha fades on the unlit side (0 = uniform hairline)
  BorderFresnelBrightness: number; // 0..1 — strength of white Fresnel tint on the lit side of the stroke
  InnerBlur: number;           // 0..1 — extra blur in the interior vs the rim (longer optical path)

  // Transform
  Transform: Transform;

  // Border
  BorderColor: Color;
  BorderWidth: number;
  BorderBlur: number;          // soft glow border
  BorderOffset: number;        // inward/outward shift from edge
  ContainBorder: boolean;      // clip border glow to shape interior

  // Border-zone backdrop filter — like Frost/Brightness/Saturation/Contrast for
  // the panel interior, but applied ONLY in the border annulus. Apple's glass
  // rim acts like a separate optical zone that can pick up brighter / more
  // saturated light than the panel face. Multipliers ON TOP of the panel
  // grading: 1.0 = inherit panel value, >1 = boost in border zone.
  BorderBrightness: number;    // multiplier for backdrop brightness in border zone
  BorderSaturation: number;    // multiplier for backdrop saturation in border zone
  BorderContrast: number;      // multiplier for backdrop contrast in border zone
  BorderFrostLodOffset: number; // additional LOD on backdrop sample in border zone (negative = sharper, positive = blurrier)

  // Shadow
  ShadowColor: Color;
  ShadowBlur: number;
  ShadowOffsetX: number;
  ShadowOffsetY: number;
  InnerShadow: boolean;

  // Appearance
  Opacity: number;
  Visible: boolean;            // false = hidden but still takes layout space

  // Interaction
  Cursor: 'Default' | 'Pointer' | 'Text' | 'Move' | 'None';
  Interactive: boolean;
  PointerEvents: 'Auto' | 'None';
}
