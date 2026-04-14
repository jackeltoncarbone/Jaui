import type { JivStyle } from '../Jiv/Jiv.Types';

/**
 * Visual presets for Apple-style Liquid Glass. Values derived from Show Studio's
 * SCSS + Apple's WWDC25 Liquid Glass talk + shader-optics research.
 */

export const LiquidGlass: Partial<JivStyle> = {
  Material: 'LiquidGlass',

  // Shape / alpha — fully transparent so only refracted backdrop + effects show
  Background: { R: 1, G: 1, B: 1, A: 0 },
  // BorderColor is a TINT applied over the border-zone backdrop, not an opaque
  // stroke. Low alpha = subtle white wash. Set to 0 for pure backdrop-tinted rim.
  BorderColor: { R: 1, G: 1, B: 1, A: 0.12 },
  BorderWidth: 1.4,
  BorderBlur: 0.5,
  BorderRadius: [32, 32, 32, 32],
  // Border-zone backdrop refilter — brighter + more saturated + sharper than
  // the panel face, so the rim catches color like a real glass bevel. These
  // multiply the panel's grading.
  BorderBrightness: 1.25,
  BorderSaturation: 1.4,
  BorderContrast: 1.0,
  BorderFrostLodOffset: -0.5,

  // Ambient drop shadow — Apple shadows are SUBTLE; ~15% alpha, soft blur
  ShadowColor: { R: 0, G: 0, B: 0, A: 0.18 },
  ShadowBlur: 22,
  ShadowOffsetY: 6,

  // Backdrop grading — gentle, content stays readable
  FrostBlur: 6,
  Brightness: 0.97,
  Saturation: 1.12,
  Contrast: 0.96,

  // Refraction / bezel — match Apple's dossier. Bulge stays near-zero; the
  // Apple glass surface reads as FLAT, not fishbowl-domed. Thickness controls
  // perceived glass depth (and the rim-spec line width scales with it).
  Thickness: 4,          // was 8 — too aggressive, bubble-sheet feel
  Fillet: 0.25,          // was 2 — Apple is essentially flat-surfaced, not fishbowled
  BezelWidth: 11,
  BezelScale: 0.32,
  Refraction: 1,

  // Lighting
  LightAngle: 135,                 // upper-left light (0=+x, 90=up)
  LightIntensity: 1,

  // Specular: SpecularIntensity drives BOTH the Blinn-Phong bevel catchlight
  // AND the thin rim-specular highlight. Sharpness is for the bevel catchlight.
  SpecularIntensity: 0.55,
  SpecularSharpness: 140,
  FresnelStrength: 0.55,           // was 0.7 — softer, less heavy rim glow

  // Chromatic aberration at rim — subtle (~0.5 px per Apple dossier)
  ChromaticAberration: 0.3,

  // Rim ambient (top brighter, bottom dim)
  EdgeLightTop: 0.16,
  EdgeLightBottom: 0.03,

  // Variable border width (thicker on lit side)
  BorderVariance: 0.3,
  BorderAlphaVariance: 0.2,
  BorderFresnelBrightness: 0.25,

  // Center slightly more blurred than rim (longer optical path)
  InnerBlur: 0.25,
};

/** Opaque-tinted panel — no refraction, no specular. */
export const SolidGlass: Partial<JivStyle> = {
  Material: 'SolidGlass',
  Background: { R: 1, G: 1, B: 1, A: 0.06 },
  BorderColor: { R: 1, G: 1, B: 1, A: 0.12 },
  BorderWidth: 1,
  BorderBlur: 0.5,
  BorderRadius: [32, 32, 32, 32],
  Brightness: 1,
  Saturation: 1,
  Contrast: 1,
};

/**
 * Near-transparent glass with strong specular. Apple requires a dimming scrim
 * underneath for legibility.
 */
export const ClearGlass: Partial<JivStyle> = {
  Material: 'LiquidGlass',
  Background: { R: 1, G: 1, B: 1, A: 0 },
  BorderColor: { R: 1, G: 1, B: 1, A: 0.45 },
  BorderWidth: 1,
  BorderBlur: 0.5,
  BorderRadius: [32, 32, 32, 32],

  FrostBlur: 1,
  Brightness: 1,
  Saturation: 1.1,
  Contrast: 1,

  Thickness: 1,
  Fillet: 0.5,
  BezelWidth: 1,
  BezelScale: 0.15,
  Refraction: 1,

  LightAngle: 135,
  LightIntensity: 1,
  SpecularIntensity: 0.75,
  SpecularSharpness: 150,
  FresnelStrength: 0.85,
  ChromaticAberration: 0.45,
  EdgeLightTop: 0.22,
  EdgeLightBottom: 0.05,
  BorderVariance: 0.4,
  BorderAlphaVariance: 0.05,
  BorderFresnelBrightness: 0.45,
  InnerBlur: 0.1,
};
