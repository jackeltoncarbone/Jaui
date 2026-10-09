/**
 * APPLE'S TINT, `.tint(color)` (Jwift/Apple/LiquidGlass.md 4; Drill Sentences lane GL6): the CPU mirror in
 * Core/Glass.Pipeline.ts held to the shader it mirrors, to Apple's two decompiled rows, and the `GlassTint` property held
 * to its contract (a seed on glass, nothing at all on anything else).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GLASS_PANEL_FACE_SPAN, GLASS_TINT_INK_SWITCH, GLASS_TINT_SHADE, GlassBodyOf, GlassLuma, GlassRelativeLuminance,
  GlassTintedBodyOf, GlassTintInkOf, GlassTintOf, GlassTintShadeOf, type GlassRgb,
} from '@jaui/Core/Glass.Pipeline';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PIPELINE = read('../src/Jiv/Shaders/Glass.Pipeline.glsl');
const PANEL = read('../src/Jiv/Shaders/Jiv.Panel.frag');
const TEXT = read('../src/Text/Shaders/Text.Quad.frag');
const JAUI = read('../src/Core/Jaui.ts');
const level = (x: number): number => Math.round(x * 255);
const grey = (y: number): GlassRgb => [y, y, y];

describe('the CPU tint is the shader\'s, number for number', () => {
  it('the dark shade law', () => {
    const m = /const vec2 GLASS_TINT_SHADE = vec2\(([\d.]+), ([\d.]+)\);/.exec(PIPELINE);
    expect(m).not.toBeNull();
    expect([Number(m![1]), Number(m![2])]).toEqual([...GLASS_TINT_SHADE]);
    expect(PIPELINE).toContain('return mix(GlassYcc(seed, GLASS_TINT_SHADE.x, 0.0, GLASS_TINT_SHADE.y), seed, clamp(dot(face, GLASS_BT709), 0.0, 1.0));');
    expect(PIPELINE).toContain(`const float GLASS_PANEL_FACE_SPAN = ${GLASS_PANEL_FACE_SPAN}.0;`);
  });

  it('the tint lies over the finished glassBackground: the holding tone first, then the tint, then the rim', () => {
    const hold = PANEL.indexOf('face = clamp(face * mix(1.0, 0.97, clamp(-1.0 - d, 0.0, 1.0)), 0.0, 1.0);');
    const tint = PANEL.indexOf('if (v_Tint.a > 0.001) face = clamp(mix(face, GlassTint(face, v_Tint.rgb), GlassAdaptedTint(v_Tint.a, v_Adapt)), 0.0, 1.0);');
    const rim = PANEL.indexOf('vec4 rim = GlassRim(shown, d, normal, key, v_Specular.x, v_Specular.y, glassClear, glassLight);');
    expect(hold).toBeGreaterThan(0);
    expect(tint).toBeGreaterThan(hold);
    expect(rim).toBeGreaterThan(tint);
  });
});

describe('Apple\'s decompiled rows (LiquidGlass.md 4 [C]) and the general law fitted to them [I]', () => {
  // Rows affine in L: R = a L + b, ... The seed is the row at L = 1, the dark shade the row at L = 0.
  const ROWS = {
    Orange: { Seed: [0.4 + 0.6, 0.263 + 0.321, 0] as GlassRgb, Shade: [0.6, 0.321, 0] as GlassRgb },
    Blue: { Seed: [0.046 - 0.007, 0.244 + 0.274, 0.370 + 0.630] as GlassRgb, Shade: [-0.007, 0.274, 0.630] as GlassRgb },
  };

  for (const [name, row] of Object.entries(ROWS)) {
    it(`${name}: the law's shade is within 8 levels of Apple's on every channel`, () => {
      const shade = GlassTintShadeOf(row.Seed);
      for (let i = 0; i < 3; i++) expect(Math.abs(level(shade[i]) - level(row.Shade[i]))).toBeLessThanOrEqual(8);
    });

    it(`${name}: the seed exactly at L = 1, the shade at L = 0, a straight line between`, () => {
      expect(GlassTintOf([1, 1, 1], row.Seed)).toEqual(row.Seed.map((v) => v));
      const shade = GlassTintShadeOf(row.Seed);
      const at0 = GlassTintOf([0, 0, 0], row.Seed);
      for (let i = 0; i < 3; i++) expect(at0[i]).toBeCloseTo(shade[i], 12);
      const half = GlassTintOf(grey(0.5), row.Seed);
      for (let i = 0; i < 3; i++) expect(half[i]).toBeCloseTo((shade[i] + row.Seed[i]) / 2, 12);
    });
  }
});

describe('a tinted glass body (`.glassProminent`)', () => {
  const GOLD: GlassRgb = [185 / 255, 130 / 255, 28 / 255];

  it('replaces the glass\'s colour and keeps its lightness: a darker backdrop, a darker body, the same hue', () => {
    for (const light of [0, 1]) {
      const bodies = [0, 0.32, 1].map((y) => GlassTintedBodyOf(grey(y), 48, light, GOLD));
      const lumas = bodies.map((b) => GlassLuma(b));
      expect(lumas[0]).toBeLessThan(lumas[1]);
      expect(lumas[1]).toBeLessThan(lumas[2]);
      for (const b of bodies) {
        // A gold: red over green over blue, never a grey glass.
        expect(b[0]).toBeGreaterThan(b[1]);
        expect(b[1]).toBeGreaterThan(b[2]);
      }
    }
  });

  it('is the law over the body the shader tints: the panel-span face, the holding tone, then the seed line', () => {
    const c = grey(0.32);
    const under = GlassBodyOf(c, GLASS_PANEL_FACE_SPAN, 0);
    const expected = GlassTintOf(under, GOLD).map((v) => Math.max(0, Math.min(1, v)));
    expect(GlassTintedBodyOf(c, 48, 0, GOLD)).toEqual(expected);
  });

  it('a transparent seed leaves the glass as it was', () => {
    const c = grey(0.32);
    expect(GlassTintedBodyOf(c, 48, 0, GOLD, 0)).toEqual(GlassBodyOf(c, GLASS_PANEL_FACE_SPAN, 0));
  });
});

describe('`GlassTint: None | <color>`', () => {
  it('on glass, it is the seed in the Background channel', () => {
    const rs = ResolveStyle({ ...DefaultJivStyle, Glass: 'Regular', Background: 'rgba(0, 0, 0, 0)', GlassTint: 'rgb(185, 130, 28)' }, SEED_CONTEXT);
    expect(rs.Background.Color.A).toBe(1);
    expect([rs.Background.Color.R, rs.Background.Color.G, rs.Background.Color.B].map(level)).toEqual([185, 130, 28]);
  });

  it('None leaves the Background as the seed, as it has always been on glass', () => {
    const rs = ResolveStyle({ ...DefaultJivStyle, Glass: 'Regular', Background: 'rgb(10, 20, 30)' }, SEED_CONTEXT);
    expect([rs.Background.Color.R, rs.Background.Color.G, rs.Background.Color.B].map(level)).toEqual([10, 20, 30]);
  });

  it('on anything that is not glass it is ignored, so a tint never becomes a flat fill', () => {
    const rs = ResolveStyle({ ...DefaultJivStyle, Background: 'rgba(0, 0, 0, 0)', GlassTint: 'rgb(185, 130, 28)' }, SEED_CONTEXT);
    expect(rs.Background.Color.A).toBe(0);
  });
});

describe('the ink on a tinted glass (Drill Sentences lane GL6b)', () => {
  const GOLD: GlassRgb = [200 / 255, 141 / 255, 30 / 255];
  const contrast = (body: GlassRgb, ink: 'White' | 'Black'): number => {
    const y = GlassRelativeLuminance(body);
    return ink === 'White' ? 1.05 / (y + 0.05) : (y + 0.05) / 0.05;
  };

  it("the switch is WCAG's crossover of white and black, the same number in the shader", () => {
    expect(GLASS_TINT_INK_SWITCH).toBeCloseTo(Math.sqrt(0.05 * 1.05) - 0.05, 4);
    expect(PIPELINE).toContain(`const float GLASS_TINT_INK_SWITCH = ${GLASS_TINT_INK_SWITCH};`);
    expect(PIPELINE).toContain('return GlassRelativeLuminance(body) <= GLASS_TINT_INK_SWITCH ? 1.0 : 0.0;');
  });

  it("the shader's even-backdrop body is the CPU's: the panel-span face, the bleed, the holding tone, the tint", () => {
    expect(PIPELINE).toContain('vec3 face = GlassFace(c, max(span, GLASS_PANEL_FACE_SPAN), 0.0, light, 0.5, 0.0);');
    expect(PIPELINE).toContain('face = mix(face, GlassBleed(c, light), clamp(weight * weight * v * mix(0.8, 0.5, light), 0.0, 1.0));');
    expect(PIPELINE).toContain('face = clamp(face * 0.97, 0.0, 1.0);');
    expect(PIPELINE).toContain('return clamp(GlassTint(face, seed), 0.0, 1.0);');
  });

  it("the text shader takes it at the glass's probed mean, for a fully tinted glass only", () => {
    expect(TEXT).toContain('#include "../../Jiv/Shaders/Glass.Pipeline.glsl"');
    expect(TEXT).toContain('float white = GlassTintInkWhite(GlassTintedBody(vec3(mean), u_GlassTintInk.w, u_GlassInk.y, u_GlassTintInk.rgb));');
    expect(JAUI).toContain('_seed.A >= GLASS_TINT_INK_ALPHA');
  });

  it('every body over every grey, light and dark, at every size, reads 4.58:1 or better with its ink', () => {
    for (const light of [0, 1]) {
      for (const span of [28, 48, 64, 120]) {
        for (let i = 0; i <= 100; i++) {
          const body = GlassTintedBodyOf(grey(i / 100), span, light, GOLD);
          expect(contrast(body, GlassTintInkOf(body))).toBeGreaterThanOrEqual(4.58);
        }
      }
    }
  });

  it('white on the dark shade, black on the light gold', () => {
    expect(GlassTintInkOf(GlassTintedBodyOf(grey(0.08), 48, 0, GOLD))).toBe('White');
    expect(GlassTintInkOf(GlassTintedBodyOf(grey(0.92), 48, 1, GOLD))).toBe('Black');
    expect(GlassTintInkOf(GOLD)).toBe('Black');
  });
});
