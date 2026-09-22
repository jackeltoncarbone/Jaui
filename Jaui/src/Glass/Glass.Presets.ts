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
  // BorderColor is a TINT applied over the border-zone backdrop, not an opaque
  // stroke. Low alpha = subtle white wash. Set to 0 for pure backdrop-tinted rim.
  BorderColor: 'rgba(255, 255, 255, 0.12)',
  BorderWidth: '1.4',
  BorderRadius: '32',
  // Border-zone backdrop refilter — brighter + more saturated than the panel
  // face so the rim catches color like a real glass bevel. Blur() here is the
  // extra LOD octave offset on top of the panel's own blur LOD (negative =
  // sharper rim, positive = softer).
  BorderFilter: 'Blur(-0.5) Brightness(1.35) Saturate(1.25)',

  // Ambient drop shadow — Apple shadows are SUBTLE; ~18% alpha, soft blur
  ShadowColor: 'rgba(0, 0, 0, 0.18)',
  ShadowBlur: '22',
  ShadowOffsetY: '6',

  // Backdrop grading — gentle, content stays readable
  BackdropFilter: 'Blur(3) Saturate(1.25) Contrast(0.75)',

  // Refraction / bezel — match Apple's dossier: the face reads FLAT, only the bezel bends.
  // Curvature is aave's lens (Jwift/Shared/Research/Aave.Glass.md): the height of the cap whose
  // slope shapes the bend across the bezel; the erf keeps it off the face, so it never fishbowls.
  Thickness: '2',
  Curvature: '40',
  BezelWidth: '7',
  BezelScale: '0.25',
  Refraction: '10',

  // Lighting
  LightAngle: '135',               // upper-left light (0=+x, 90=up)
  LightIntensity: '1',

  // The highlight is aave's: SpecularIntensity is the edge band at the outline, SpecularGlow the
  // wash toward the two lit corners. Their tuned playground values.
  SpecularIntensity: '0.25',
  SpecularGlow: '0.1',
  FresnelStrength: '0.55',

  // Chromatic aberration at rim — subtle
  ChromaticAberration: '0.3',

  // Rim ambient (top brighter, bottom dim)
  EdgeLightTop: '0.16',
  EdgeLightBottom: '0.03',

  // Variable border width (thicker on lit side)
  BorderVariance: '0.3',
  BorderAlphaVariance: '0.2',
  BorderFresnelStrength: '0.25',

  // Center slightly more blurred than rim (longer optical path)
  InnerBlur: '0.25',
};

/**
 * Near-transparent glass with strong specular. Apple requires a dimming scrim
 * underneath for legibility.
 */
export const ClearGlass: Partial<JivStyle> = {
  Background: 'rgba(255, 255, 255, 0)',
  BorderColor: 'rgba(255, 255, 255, 0.45)',
  BorderWidth: '1',
  BorderRadius: '32',

  BackdropFilter: 'Blur(1) Saturate(1.1)',

  Thickness: '1',
  Curvature: '40',
  BezelWidth: '1',
  BezelScale: '0.15',
  Refraction: '1',

  LightAngle: '135',
  LightIntensity: '1',
  // aave's component preset: a brighter glow and more dispersion on the clear lens.
  SpecularIntensity: '0.25',
  SpecularGlow: '0.15',
  FresnelStrength: '0.85',
  ChromaticAberration: '0.3',
  EdgeLightTop: '0.22',
  EdgeLightBottom: '0.05',
  BorderVariance: '0.4',
  BorderAlphaVariance: '0.05',
  BorderFresnelStrength: '0.45',
  InnerBlur: '0.1',
};
