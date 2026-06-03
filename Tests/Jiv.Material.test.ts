import { describe, it, expect } from 'vitest';
import { Jiv } from '@jaui/Jiv/Jiv';
import { LiquidGlass, ClearGlass } from '@jaui/Glass/Glass.Presets';
import { ParseColor } from '@jaui/Core/Color.Parse';

// A Jiv is ONE physical surface — there is NO glass/solid/translucent material
// taxonomy. These tests assert the attribute-derived render model instead:
//   • SamplesBackdrop — the surface reads the scene behind it (transmission):
//     true iff a backdrop filter / refraction / frost is set. NOT triggered by
//     thickness.
//   • Depth — unified physical depth (Thickness + Elevation). 0 = impossibly
//     thin (the shape, zero depth); never a mode switch.
//   • HasProgressiveBlur — a directional ramp sampler.
describe('Jiv physical surface (no material taxonomy)', () => {
  it('a plain Jiv does not sample the backdrop and has zero depth', () => {
    const j = new Jiv();
    expect(j.RenderStyle.SamplesBackdrop).toBe(false);
    expect(j.RenderStyle.HasProgressiveBlur).toBe(false);
    expect(j.RenderStyle.Depth).toBe(0);
  });

  it('Thickness gives DEPTH but does NOT make the surface sample the backdrop', () => {
    // The old model force-promoted Thickness>0 to "glass" (which sampled the
    // backdrop and rendered invisible over dark). Now thickness is just depth.
    const j = new Jiv({ Style: { Thickness: '2' } });
    expect(j.RenderStyle.Depth).toBe(2);
    expect(j.RenderStyle.SamplesBackdrop).toBe(false);
  });

  it('Thickness and Elevation both feed the one unified Depth (they sum)', () => {
    const j = new Jiv({ Style: { Thickness: '2', Elevation: '3' } });
    expect(j.RenderStyle.Depth).toBe(5);
  });

  it('a backdrop filter (frost) makes the surface sample the backdrop', () => {
    const j = new Jiv({ Style: { BackdropFrostBlur: '8' } });
    expect(j.RenderStyle.SamplesBackdrop).toBe(true);
  });

  it('refraction makes the surface sample the backdrop', () => {
    const j = new Jiv({ Style: { Refraction: '20' } });
    expect(j.RenderStyle.SamplesBackdrop).toBe(true);
  });

  it('HasProgressiveBlur when ProgressiveBlurDirection is set', () => {
    const j = new Jiv({ Style: { ProgressiveBlurDirection: 'ToBottom' } });
    expect(j.RenderStyle.HasProgressiveBlur).toBe(true);
  });

  it('LiquidGlass preset is a transparent, backdrop-sampling surface', () => {
    expect(ParseColor(LiquidGlass.Background!)).toEqual({ R: 1, G: 1, B: 1, A: 0 });
    expect(parseFloat(LiquidGlass.BackdropFrostBlur as string)).toBeGreaterThan(0);
    const j = new Jiv({ Style: { ...LiquidGlass } });
    expect(j.RenderStyle.SamplesBackdrop).toBe(true);
  });

  it('ClearGlass preset has high specular, low blur, and samples the backdrop', () => {
    expect(parseFloat(ClearGlass.SpecularIntensity as string)).toBeGreaterThan(0.7);
    expect(parseFloat(ClearGlass.BackdropFrostBlur as string)).toBeLessThanOrEqual(1);
    const j = new Jiv({ Style: { ...ClearGlass } });
    expect(j.RenderStyle.SamplesBackdrop).toBe(true);
  });

  it('all physical properties default to sensible values', () => {
    const j = new Jiv();
    expect(j.Style.BezelWidth).toBe('12');
    expect(j.Style.BezelScale).toBe('0.35');
    expect(j.Style.LightAngle).toBe('-45');
    expect(j.Style.LightIntensity).toBe('1');
    expect(j.Style.SpecularIntensity).toBe('0');
    expect(j.Style.SpecularSharpness).toBe('100');
    expect(j.Style.FresnelStrength).toBe('0');
    expect(j.Style.ChromaticAberration).toBe('0');
    expect(j.Style.EdgeLightTop).toBe('0');
    expect(j.Style.EdgeLightBottom).toBe('0');
    expect(j.Style.BorderVariance).toBe('0');
    expect(j.Style.InnerBlur).toBe('0');
  });

  it('not a light by default; emits no light', () => {
    const j = new Jiv();
    expect(j.Style.LightType).toBe('');
    expect(j.RenderStyle.Light).toBeNull();
  });

  it('LightType makes a Jiv a scene light (a Jiv role, not a separate type)', () => {
    const j = new Jiv({ Style: { LightType: 'Directional', LightIntensity_: '1.3' } });
    expect(j.RenderStyle.Light).not.toBeNull();
    expect(j.RenderStyle.Light!.Kind).toBe('Directional');
    expect(j.RenderStyle.Light!.Intensity).toBeCloseTo(1.3);
  });

  it('LiquidGlass preset enables all physical lighting properties', () => {
    expect(parseFloat(LiquidGlass.SpecularIntensity as string)).toBeGreaterThan(0);
    expect(parseFloat(LiquidGlass.FresnelStrength as string)).toBeGreaterThan(0);
    expect(parseFloat(LiquidGlass.ChromaticAberration as string)).toBeGreaterThan(0);
    expect(parseFloat(LiquidGlass.EdgeLightTop as string))
      .toBeGreaterThan(parseFloat((LiquidGlass.EdgeLightBottom as string) ?? '0'));
    expect(parseFloat(LiquidGlass.BorderVariance as string)).toBeGreaterThan(0);
  });

  it('Jiv with LiquidGlass preset merges defaults', () => {
    const j = new Jiv({ Style: { ...LiquidGlass, BorderRadius: '20' } });
    expect(j.RenderStyle.SamplesBackdrop).toBe(true);
    expect(j.Style.BorderRadius).toBe('20');
    expect(parseFloat(j.Style.SpecularIntensity as string)).toBeGreaterThan(0);
    expect(j.Style.LightAngle).toBe('135');
  });

  it('Custom LightAngle overrides preset', () => {
    const j = new Jiv({ Style: { ...LiquidGlass, LightAngle: '90' } });
    expect(j.Style.LightAngle).toBe('90');
  });
});
