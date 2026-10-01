import { describe, it, expect } from 'vitest';
import { ParseFilter } from '../src/Core/Filter.Parse';
import { Jiv } from '../src/Jiv/Jiv';

describe('FogProgressiveBlur grammar', () => {
  it('parses <radius>, <feather> [, <easing>] in the foreground zone', () => {
    const fb = ParseFilter('FogProgressiveBlur(9pt, 28pt, 1)', 'foreground').ForegroundBlur!;
    expect(fb.Mode).toBe('box');
    expect(fb.RadiusRaw).toBe('9pt');
    expect(fb.FeatherRaw).toBe('28pt');
    expect(fb.Easing).toBeCloseTo(1);
    expect(fb.Uniform).toBe(false);
  });

  it('easing defaults to 1 when omitted', () => {
    const fb = ParseFilter('FogProgressiveBlur(9pt, 28pt)', 'foreground').ForegroundBlur!;
    expect(fb.Easing).toBe(1);
  });

  it('feather is required — fewer than two args throws', () => {
    expect(() => ParseFilter('FogProgressiveBlur(9pt)', 'foreground')).toThrow();
  });

  it('is also accepted in the backdrop zone', () => {
    const fb = ParseFilter('FogProgressiveBlur(9pt, 28pt)').ForegroundBlur!;
    expect(fb.Mode).toBe('box');
    expect(fb.RadiusRaw).toBe('9pt');
  });

  it('is refused in the text zone', () => {
    expect(() => ParseFilter('FogProgressiveBlur(9pt, 28pt)', 'text')).toThrow();
  });

  it('composes with grade functions, last-occurrence-wins still holds', () => {
    const f = ParseFilter('FogProgressiveBlur(9pt, 28pt) Brightness(0.8) Brightness(1.2)', 'foreground');
    expect(f.ForegroundBlur!.Mode).toBe('box');
    expect(f.Brightness).toBeCloseTo(1.2);
  });

  it('None is identity', () => {
    expect(ParseFilter('None', 'foreground').ForegroundBlur).toBeNull();
  });
});

describe('FogProgressiveBlur resolver field', () => {
  it('resolves ProgressiveBlurBoxFeather in px, leaves ProgressiveBlurStops null', () => {
    const j = new Jiv({ Style: { Filter: 'FogProgressiveBlur(9pt, 28pt, 1)' } });
    // 1pt = 16px at the default root PointScale.
    expect(j.RenderStyle.ProgressiveBlurBoxFeather).toBeCloseTo(28 * 16);
    expect(j.RenderStyle.ProgressiveBlurStops).toBeNull();
  });

  it('forces the ProgressiveBlur material', () => {
    const j = new Jiv({ Style: { Filter: 'FogProgressiveBlur(9pt, 28pt)' } });
    expect(j.RenderStyle.Material).toBe('ProgressiveBlur');
  });

  it('a node with no Fog function leaves ProgressiveBlurBoxFeather at 0', () => {
    const j = new Jiv({ Style: {} });
    expect(j.RenderStyle.ProgressiveBlurBoxFeather).toBe(0);
  });

  it('BackdropFilter authoring resolves the same field', () => {
    const j = new Jiv({ Style: { BackdropFilter: 'FogProgressiveBlur(9pt, 28pt)' } });
    expect(j.RenderStyle.ProgressiveBlurBoxFeather).toBeCloseTo(28 * 16);
  });
});
