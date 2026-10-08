/**
 * THE BODY TONE: Core/Glass.Pipeline.ts's CPU mirror of the face, the edge bleed and the holding tone, held to the shader
 * it mirrors (Glass.Pipeline.glsl, Jiv.Panel.frag), and to Apple's decompiled faces on large glass (Drill Sentences lane
 * GL1; Jwift/Apple/LiquidGlass.md 3.3 [C]).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GLASS_BLEED_OPACITY, GLASS_FACE_APPLE_DARK, GLASS_FACE_APPLE_LIGHT, GLASS_FACE_FITTED_DARK, GLASS_FACE_FITTED_LIGHT,
  GLASS_FACE_LARGE_SPAN, GLASS_FACE_THIN_DARK, GLASS_FACE_THIN_LIGHT, GLASS_HOLDING_TONE, GlassBodyOf, GlassFaceOf,
  GlassFaceParamsOf, GlassLuma, type GlassFaceParams, type GlassRgb,
} from '@jaui/Core/Glass.Pipeline';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PIPELINE = read('../src/Jiv/Shaders/Glass.Pipeline.glsl');
const PANEL = read('../src/Jiv/Shaders/Jiv.Panel.frag');
const FACE = PIPELINE.slice(PIPELINE.indexOf('vec3 GlassFace('), PIPELINE.indexOf('\n}\n', PIPELINE.indexOf('vec3 GlassFace(')));
const nums = (s: string): number[] => s.split(',').map((x) => Number(x.trim()));
const vec4Of = (src: string, re: RegExp): number[] => {
  const m = re.exec(src);
  expect(m, String(re)).not.toBeNull();
  return nums(m![1]);
};
const grey = (y: number): GlassRgb => [y, y, y];

describe('the CPU face is the shader\'s, number for number', () => {
  it('Apple\'s two regular faces and the hand-off span', () => {
    expect(vec4Of(PIPELINE, /const vec4 GLASS_FACE_APPLE_LIGHT = vec4\(([^)]*)\);/)).toEqual([...GLASS_FACE_APPLE_LIGHT]);
    expect(vec4Of(PIPELINE, /const vec4 GLASS_FACE_APPLE_DARK = vec4\(([^)]*)\);/)).toEqual([...GLASS_FACE_APPLE_DARK]);
    expect(vec4Of(PIPELINE, /const vec2 GLASS_FACE_LARGE_SPAN = vec2\(([^)]*)\);/)).toEqual([...GLASS_FACE_LARGE_SPAN]);
    expect(FACE).toContain('l = mix(l, GLASS_FACE_APPLE_LIGHT, toApple);');
    expect(FACE).toContain('k = mix(k, GLASS_FACE_APPLE_DARK, toApple);');
  });

  it('the fitted faces it hands off from, and the thin faces', () => {
    expect(vec4Of(FACE, /vec4 l = vec4\(([^)]*)\);/)).toEqual([...GLASS_FACE_FITTED_LIGHT]);
    expect(vec4Of(FACE, /vec4 k = vec4\(([^)]*)\);/)).toEqual([...GLASS_FACE_FITTED_DARK]);
    expect(vec4Of(FACE, /k = vec4\(([^)]*)\);\n    \}/)).toEqual([...GLASS_FACE_THIN_DARK]);
    const thin = /l = mix\(vec4\(([^)]*)\), vec4\(([^)]*)\), clamp\(\(mean - 0\.45\) \/ 0\.5, 0\.0, 1\.0\)\);/.exec(FACE)!;
    expect([nums(thin[1]), nums(thin[2])]).toEqual(GLASS_FACE_THIN_LIGHT.map((f) => [...f]));
    // Filled white (light) and black (dark), premultiplied.
    expect(FACE).toContain('vec3 lit = GlassYcc(c, l.x, l.y, l.z) * (1.0 - l.w) + vec3(l.w);');
    expect(FACE).toContain('vec3 dim = GlassYcc(c, k.x, k.y, k.z) * (1.0 - k.w);');
  });

  it('the edge bleed\'s weight and opacity and the holding tone, as Jiv.Panel.frag runs them', () => {
    expect(PANEL).toContain('float weight = mix(1.0 - lum, lum, glassLight);');
    expect(PANEL).toContain('weight = weight * weight * clamp(1.0 - d, 0.0, 1.0);');
    expect(PANEL).toContain(`face = mix(face, bleed, clamp(weight * weight * ramps.y * mix(${GLASS_BLEED_OPACITY.Dark}, ${GLASS_BLEED_OPACITY.Light}, glassLight), 0.0, 1.0) * (1.0 - glassClear));`);
    expect(PANEL).toContain(`face = clamp(face * mix(1.0, ${GLASS_HOLDING_TONE}, clamp(-1.0 - d, 0.0, 1.0)), 0.0, 1.0);`);
    expect(PIPELINE).toContain('return mix(GlassYcc(c, 0.5, 0.0, 1.0), GlassYcc(c, 1.0, 0.9, 1.2), light);');
  });
});

describe('Apple\'s faces on large glass (LiquidGlass.md 3.3 [C])', () => {
  const asLine = (f: GlassFaceParams, light: boolean): { Slope: number; Offset: number; Chroma: number } => ({
    Slope: (f[0] - f[1]) * (1 - f[3]),
    Offset: f[1] * (1 - f[3]) + (light ? f[3] : 0),
    Chroma: f[2] * (1 - f[3]),
  });

  it('light is Y -> 0.318 Y + 0.70 and dark Y -> 0.24 Y + 0.12, chroma x 0.6 both, from 96 pt', () => {
    const l = asLine(GLASS_FACE_APPLE_LIGHT, true);
    const k = asLine(GLASS_FACE_APPLE_DARK, false);
    expect(l.Slope).toBeCloseTo(0.318, 9);
    expect(l.Offset).toBeCloseTo(0.70, 9);
    expect(k.Slope).toBeCloseTo(0.24, 9);
    expect(k.Offset).toBeCloseTo(0.12, 9);
    expect(l.Chroma).toBeCloseTo(0.6, 9);
    expect(k.Chroma).toBeCloseTo(0.6, 9);
    for (const s of [96, 160, 400, 1000]) expect(GlassFaceParamsOf(s)).toEqual({ Light: GLASS_FACE_APPLE_LIGHT, Dark: GLASS_FACE_APPLE_DARK });
  });

  it('the face hands off continuously over 64 to 96 pt, so a pill that grows into its menu never pops', () => {
    expect(GlassFaceParamsOf(64)).toEqual({ Light: GLASS_FACE_FITTED_LIGHT, Dark: GLASS_FACE_FITTED_DARK });
    for (const y of [0.05, 0.3, 0.7]) {
      for (const light of [0, 1]) {
        let prev = GlassLuma(GlassFaceOf(grey(y), 64, light));
        for (let s = 65; s <= 96; s++) {
          const now = GlassLuma(GlassFaceOf(grey(y), s, light));
          expect(Math.abs(now - prev)).toBeLessThan(0.02);
          prev = now;
        }
      }
    }
  });

  it('the face reads no position: not the pixel, not the depth inside the outline', () => {
    expect(FACE).not.toMatch(/v_PixelPos|gl_FragCoord|\bd\b/);
  });

  it('dark regular glass from 96 pt never lifts a backdrop brighter than the line\'s fixed point, 0.12 / 0.76', () => {
    for (let y = 0.16; y <= 1.0001; y += 0.01) {
      for (const s of [96, 200, 400]) expect(GlassLuma(GlassBodyOf(grey(y), s, 0))).toBeLessThanOrEqual(y + 1e-9);
    }
  });
});
