// GlassShadow: Auto | Platter | None (Drill Sentences lane GL2). Auto is glassBackground's own drop shadow
// (Jwift/Apple/LiquidGlass.md 3.5); Platter adds UIKit's platter shadow under it [I]; None casts none.
import { describe, it, expect } from 'vitest';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';
import { Jiv } from '@jaui/Jiv/Jiv';
import { JivInstanceBuffer } from '@jaui/Jiv/Jiv.InstanceBuffer';
import {
  GLASS_PLATTER_SHADOW, GLASS_SHADOW_OFFSET_Y, GlassPlatterShadowOf, GlassShadowExtent, GlassShadowFall, GlassShadowRadius,
} from '@jaui/Core/Glass.Pipeline';

const push = (style: Record<string, string>, shadow: 'Included' | 'Excluded' | 'Only' | 'Platter', w = 250, h = 440, dpr = 2): Float32Array => {
  const node = new Jiv({ X: 100, Y: 100, Width: w, Height: h, Style: { Glass: 'Regular', ...style } });
  const buf = new JivInstanceBuffer();
  buf.Begin();
  buf.Push(node, dpr, undefined, 0, 0, -1, 'Normal', null, shadow);
  return buf.Data.slice(0, 64);
};

describe('GlassShadow resolves', () => {
  it('Auto by default, Platter and None by name, and throws on anything else', () => {
    expect(ResolveStyle({ ...DefaultJivStyle }, SEED_CONTEXT).GlassShadow).toBe('Auto');
    expect(ResolveStyle({ ...DefaultJivStyle, GlassShadow: 'Platter' }, SEED_CONTEXT).GlassShadow).toBe('Platter');
    expect(ResolveStyle({ ...DefaultJivStyle, GlassShadow: 'None' }, SEED_CONTEXT).GlassShadow).toBe('None');
    expect(() => ResolveStyle({ ...DefaultJivStyle, GlassShadow: 'Deep' }, SEED_CONTEXT)).toThrow(/GlassShadow/);
  });
});

describe('the platter draw', () => {
  it('is black, straight down, at the platter\'s reach and opacity, in the flat program with Apple\'s fall', () => {
    const d = push({ GlassShadow: 'Platter' }, 'Platter');
    const dark = ResolveStyle({ ...DefaultJivStyle }, SEED_CONTEXT).SchemeDark;
    const p = GlassPlatterShadowOf(250, dark);
    expect([d[20], d[21], d[22]]).toEqual([0, 0, 0]);
    expect(d[23]).toBeCloseTo(p.Opacity, 6);
    expect(d[24]).toBe(0); // never sideways: the same left and right
    expect(d[25]).toBeCloseTo(p.OffsetY * 2, 5);
    expect(d[26]).toBeCloseTo(p.Reach * 2, 5);
    expect(d[38]).toBe(1); // GlassShadowFall, black: the flat program
    expect(d[35]).toBe(0); // no backdrop read
    expect(d[15]).toBe(0); // no fill
    expect(d[44]).toBe(0); // no rim
    // The quad holds the whole fall: half extents grown by reach + offset on each side.
    expect(d[3]).toBeCloseTo(440 * 2 + 2 * (p.Reach + p.OffsetY) * 2, 3);
  });

  it('Apple\'s own draw keeps its law beside it: two radii, 8 pt down', () => {
    const d = push({ GlassShadow: 'Platter' }, 'Only');
    expect(d[25]).toBeCloseTo(GLASS_SHADOW_OFFSET_Y * 2, 5);
    expect(d[26]).toBeCloseTo(2 * GlassShadowRadius(250) * 2, 5);
  });

  it('casts none at None, either draw', () => {
    expect(push({ GlassShadow: 'None' }, 'Only')[23]).toBe(0);
    expect(push({ GlassShadow: 'None' }, 'Platter')[23]).toBe(0);
  });

  it('casts none on glass 64 pt and under, and none on clear glass', () => {
    expect(push({ GlassShadow: 'Platter' }, 'Platter', 300, 64)[23]).toBe(0);
    expect(push({ GlassShadow: 'Platter', Glass: 'Clear' }, 'Platter')[23]).toBe(0);
  });
});

describe('the platter shadow\'s law', () => {
  it('is the [I] values at 160 pt and up, half its sigma and offset and none of its opacity at 64', () => {
    const big = GlassPlatterShadowOf(250, true);
    expect(big.Sigma).toBe(GLASS_PLATTER_SHADOW.Sigma);
    expect(big.OffsetY).toBe(GLASS_PLATTER_SHADOW.OffsetY);
    expect(big.Opacity).toBe(GLASS_PLATTER_SHADOW.OpacityDark);
    expect(GlassPlatterShadowOf(250, false).Opacity).toBe(GLASS_PLATTER_SHADOW.OpacityLight);
    expect(GlassPlatterShadowOf(64, true).Opacity).toBe(0);
    expect(GlassPlatterShadowOf(64, true).Sigma).toBe(GLASS_PLATTER_SHADOW.Sigma / 2);
  });

  it('Apple\'s fall at reach 2 sqrt 2 sigma is a Gaussian edge of that sigma', () => {
    // 0.5 erfc(sd / (sigma sqrt 2)) at 1 and 2 sigma: 0.1587, 0.0228.
    const p = GlassPlatterShadowOf(250, true);
    expect(GlassShadowFall(0, p.Reach)).toBeCloseTo(0.5, 6);
    expect(GlassShadowFall(p.Sigma, p.Reach)).toBeCloseTo(0.1587, 2);
    expect(GlassShadowFall(2 * p.Sigma, p.Reach)).toBeCloseTo(0.0228, 2);
  });

  it('the extent a paint rect must hold: Apple\'s two radii and offset, the platter\'s reach and offset past that', () => {
    expect(GlassShadowExtent(250, 'None')).toBe(0);
    expect(GlassShadowExtent(250, 'Auto')).toBe(2 * 24 + 8);
    expect(GlassShadowExtent(250, 'Platter')).toBeCloseTo(2 * Math.SQRT2 * 30 + 10, 6);
    expect(GlassShadowExtent(44, 'Platter')).toBe(GlassShadowExtent(44, 'Auto'));
  });
});
