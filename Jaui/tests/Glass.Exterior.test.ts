// GlassOuterRefraction and GlassBleed: DesignLibrary's Layers 0x10 and 0x40, which a sheet at a partial detent drops
// (Jwift/Apple/Sheets.md). Auto is Apple's reach; None rides lane 46 above the dispersion and the authored blur.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';
import { Jiv } from '@jaui/Jiv/Jiv';
import { JivInstanceBuffer } from '@jaui/Jiv/Jiv.InstanceBuffer';

const lane46 = (style: Record<string, string>): number => {
  const node = new Jiv({ X: 0, Y: 0, Width: 200, Height: 120, Style: { Glass: 'Regular', ...style } });
  const buf = new JivInstanceBuffer();
  buf.Begin();
  buf.Push(node, 1);
  return buf.Data[46];
};

describe('the exterior switches', () => {
  it('default to Auto, and resolve None', () => {
    const auto = ResolveStyle({ ...DefaultJivStyle }, SEED_CONTEXT);
    expect(auto.GlassOuterRefraction).toBe(true);
    expect(auto.GlassBleed).toBe(true);
    const none = ResolveStyle({ ...DefaultJivStyle, GlassOuterRefraction: 'None', GlassBleed: 'None' }, SEED_CONTEXT);
    expect(none.GlassOuterRefraction).toBe(false);
    expect(none.GlassBleed).toBe(false);
  });

  it('throw on anything else, by name', () => {
    expect(() => ResolveStyle({ ...DefaultJivStyle, GlassBleed: 'Off' }, SEED_CONTEXT)).toThrow(/GlassBleed/);
  });

  it('leave lane 46 unchanged at Auto, and add 16384 x (1 outer + 2 bleed) at None', () => {
    const base = lane46({});
    expect(base).toBeLessThan(16384);
    expect(lane46({ GlassOuterRefraction: 'None' })).toBe(base + 16384);
    expect(lane46({ GlassBleed: 'None' })).toBe(base + 2 * 16384);
    const blurred = lane46({ GlassBlur: '10pt' });
    expect(blurred).toBeGreaterThan(base);
    expect(lane46({ GlassOuterRefraction: 'None', GlassBleed: 'None', GlassBlur: '10pt' })).toBe(blurred + 3 * 16384);
  });

  it('the shader zeroes each reach from the lane, and keeps the blur decode below it', () => {
    const glsl = readFileSync(resolve(__dirname, '../src/Jiv/Shaders/Glass.Pipeline.glsl'), 'utf8');
    const frag = readFileSync(resolve(__dirname, '../src/Jiv/Shaders/Jiv.Panel.frag'), 'utf8');
    expect(glsl).toContain('float GlassLaneBlur(float lane) { return floor(mod(lane, 16384.0) / 4.0) / 16.0; }');
    expect(glsl).toContain('float GlassLaneExterior(float lane) { return floor(lane / 16384.0); }');
    expect(frag).toContain('float outerShift = glassOuterOff ? 0.0 : GlassShift(d, 0.2 * glassSpan, 0.125 * glassSpan) * lens;');
    expect(frag).toContain('float bleedShift = glassBleedOff ? 0.0 : GlassShift(d, 0.35 * glassSpan, 0.35 * glassSpan);');
  });
});
