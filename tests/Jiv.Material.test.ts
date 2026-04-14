import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { LiquidGlass, SolidGlass, ClearGlass } from '../src/Glass/Glass.Presets';
import { ParseColor } from '../src/Core/Color.Parse';

describe('Jiv Material', () => {
  it('defaults to None', () => {
    const j = new Jiv();
    expect(j.Style.Material).toBe('None');
  });

  it('constructor override accepts Material', () => {
    const j = new Jiv({ Style: { Material: 'LiquidGlass' } });
    expect(j.Style.Material).toBe('LiquidGlass');
  });

  it('LiquidGlass preset has transparent background', () => {
    expect(ParseColor(LiquidGlass.Background!)).toEqual({ R: 1, G: 1, B: 1, A: 0 });
    expect(LiquidGlass.Material).toBe('LiquidGlass');
    expect(parseFloat(LiquidGlass.BackdropFrostBlur as string)).toBeGreaterThan(0);
  });

  it('SolidGlass preset has subtle tint, no refraction', () => {
    expect(SolidGlass.Material).toBe('SolidGlass');
    expect(ParseColor(SolidGlass.Background!).A).toBeCloseTo(0.06);
  });

  it('ClearGlass preset has high specular, low blur', () => {
    expect(ClearGlass.Material).toBe('LiquidGlass');
    expect(parseFloat(ClearGlass.SpecularIntensity as string)).toBeGreaterThan(0.7);
    expect(parseFloat(ClearGlass.BackdropFrostBlur as string)).toBeLessThanOrEqual(1);
  });

  it('all new physical properties default to sensible values', () => {
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
    expect(j.Style.Material).toBe('LiquidGlass');
    expect(j.Style.BorderRadius).toBe('20');
    expect(parseFloat(j.Style.SpecularIntensity as string)).toBeGreaterThan(0);
    expect(j.Style.LightAngle).toBe('135');
  });

  it('Custom LightAngle overrides preset', () => {
    const j = new Jiv({ Style: { ...LiquidGlass, LightAngle: '90' } });
    expect(j.Style.LightAngle).toBe('90');
  });
});
