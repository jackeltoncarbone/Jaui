import type { JivStyle } from '../Jiv/Jiv.Types';

/**
 * Visual presets for Apple-style Liquid Glass. Values derived from Show Studio's
 * SCSS + Apple's WWDC25 Liquid Glass talk + shader-optics research.
 */

export const LiquidGlass: Partial<JivStyle> = {
  Material: 'LiquidGlass',

  // Shape / alpha — fully transparent so only refracted backdrop + effects show
  Background: { R: 1, G: 1, B: 1, A: 0 },
  BorderColor: { R: 1, G: 1, B: 1, A: 0.35 },
  BorderWidth: 1,
  BorderBlur: 0.5,
  BorderRadius: [32, 32, 32, 32],

  // Backdrop grading — gentle, content stays readable
  FrostBlur: 4,
  Brightness: 0.95,
  Saturation: 1.15,
  Contrast: 0.95,

  // Refraction / bezel
  Thickness: 8,
  Fillet: 2,              // surface bulge magnitude (Show Studio's --surface-bulge)
  BezelWidth: 12,
  BezelScale: 0.35,
  Refraction: 1,

  // Lighting
  LightAngle: 135,                 // upper-left light (0=+x, 90=up)
  LightIntensity: 1,

  // Specular catchlight — the #1 glass tell
  SpecularIntensity: 0.55,
  SpecularSharpness: 120,
  FresnelStrength: 0.7,

  // Chromatic aberration at rim
  ChromaticAberration: 0.35,

  // Rim ambient (top brighter, bottom dim)
  EdgeLightTop: 0.18,
  EdgeLightBottom: 0.04,

  // Variable border width (thicker on lit side)
  BorderVariance: 0.35,

  // Center slightly more blurred than rim (longer optical path)
  InnerBlur: 0.35,
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

  Thickness: 10,
  Fillet: 1.5,
  BezelWidth: 14,
  BezelScale: 0.35,
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
  InnerBlur: 0.1,
};
