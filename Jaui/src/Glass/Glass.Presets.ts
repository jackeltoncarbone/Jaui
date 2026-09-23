import type { JivStyle } from '../Jiv/Jiv.Types';

/**
 * Visual presets for Apple-style Liquid Glass. Values derived from Show Studio's
 * SCSS + Apple's WWDC25 Liquid Glass talk + shader-optics research.
 *
 * Every field is authored as a CSS-string — the StyleResolver parses it into
 * pixels at resolution time. Bare numbers (e.g. "1.4") are treated as px.
 */

export const LiquidGlass: Partial<JivStyle> = {
  // Material is inferred from `Thickness > 0` at resolve time — no explicit field.

  // Shape / alpha — fully transparent so only refracted backdrop + effects show
  Background: 'rgba(255, 255, 255, 0)',
  BorderRadius: '32',
  // The rim: Apple's hairline, lit toward LightAngle and its bounce.
  RimWidth: '0.95px',
  RimStrength: '0.24',

  // Ambient drop shadow — Apple shadows are SUBTLE; ~18% alpha, soft blur
  ShadowColor: 'rgba(0, 0, 0, 0.18)',
  ShadowBlur: '22',
  ShadowOffsetY: '6',

  // Backdrop grading — gentle, content stays readable
  BackdropFilter: 'Blur(3) Saturate(1.25) Contrast(0.75)',

  // Refraction — Apple's: the face reads FLAT, only the edge band bends.
  Thickness: '2',
  Refraction: '1',

  // Lighting
  LightAngle: '135',               // upper-left light (0=+x, 90=up)
  LightIntensity: '1',

  // The highlight is aave's: SpecularIntensity is the edge band at the outline, SpecularGlow the
  // wash toward the two lit corners. Their tuned playground values.
  SpecularIntensity: '0.25',
  SpecularGlow: '0.1',
  FresnelStrength: '0.55',

  // Chromatic aberration at rim — subtle
  ChromaticAberration: '0',

  // Rim ambient (top brighter, bottom dim)
  EdgeLightTop: '0.16',
  EdgeLightBottom: '0.03',
};

/**
 * Near-transparent glass with strong specular. Apple requires a dimming scrim
 * underneath for legibility.
 */
export const ClearGlass: Partial<JivStyle> = {
  Background: 'rgba(255, 255, 255, 0)',
  BorderRadius: '32',
  RimWidth: '0.95px',
  RimStrength: '0.35',

  BackdropFilter: 'Blur(1) Saturate(1.1)',

  Thickness: '1',
  Refraction: '1',

  LightAngle: '135',
  LightIntensity: '1',
  // aave's component preset: a brighter glow on the clear lens.
  SpecularIntensity: '0.25',
  SpecularGlow: '0.15',
  FresnelStrength: '0.85',
  ChromaticAberration: '0',
  EdgeLightTop: '0.22',
  EdgeLightBottom: '0.05',
};
