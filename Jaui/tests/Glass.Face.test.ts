/**
 * THE BODY TONE: Core/Glass.Pipeline.ts's CPU mirror of the face, the edge bleed and the holding tone, held to the shader
 * it mirrors (Glass.Pipeline.glsl, Jiv.Panel.frag), and to Apple's decompiled faces on large glass (Drill Sentences lane
 * GL1; Jwift/Apple/LiquidGlass.md 3.3 [C]).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GLASS_BLEED_OPACITY, GLASS_ELEVATION_COVER, GLASS_ELEVATION_STEPS, GLASS_FACE_APPLE_DARK, GLASS_FACE_APPLE_DARK_ELEVATED,
  GLASS_FACE_APPLE_LIGHT, GlassElevationOf, GLASS_FACE_FITTED_DARK, GLASS_FACE_FITTED_LIGHT,
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
    expect(FACE).toContain('k = mix(k, mix(GLASS_FACE_APPLE_DARK, GLASS_FACE_APPLE_DARK_ELEVATED, clamp(elevation, 0.0, 1.0)), toApple);');
    expect(vec4Of(PIPELINE, /const vec4 GLASS_FACE_APPLE_DARK_ELEVATED = vec4\(([^)]*)\);/)).toEqual([...GLASS_FACE_APPLE_DARK_ELEVATED]);
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

/** CIE L* of an sRGB-encoded colour (D65, Y from BT.709 primaries). */
const lstar = (c: GlassRgb): number => {
  const lin = c.map((s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return 116 * (y > 216 / 24389 ? Math.cbrt(y) : (24389 / 27 * y + 16) / 116) - 16;
};

describe('glass presented over glass: the elevated dark face (Drill Sentences lane GL3, LiquidGlass.md 8.1 [I])', () => {
  const asLine = (f: GlassFaceParams): { Slope: number; Offset: number; Chroma: number } => ({
    Slope: (f[0] - f[1]) * (1 - f[3]), Offset: f[1] * (1 - f[3]), Chroma: f[2] * (1 - f[3]),
  });

  it('is Apple\'s slope lifted: Y -> 0.24 Y + 0.222, fixed point 0.29, the chroma under it held (x 1) (lane GL5)', () => {
    const k = asLine(GLASS_FACE_APPLE_DARK_ELEVATED);
    expect(k.Slope).toBeCloseTo(0.24, 9);
    expect(k.Offset).toBeCloseTo(0.222, 9);
    expect(k.Offset / (1 - k.Slope)).toBeCloseTo(0.292, 3);
    expect(k.Chroma).toBeCloseTo(1, 4);
  });

  it('elevation 0 is the base face exactly, at every size; light glass never changes', () => {
    for (const s of [32, 56, 64, 80, 96, 250, 400]) {
      expect(GlassFaceParamsOf(s, 0.5, 0)).toEqual(GlassFaceParamsOf(s, 0.5));
      expect(GlassFaceParamsOf(s, 0.5, 1).Light).toEqual(GlassFaceParamsOf(s, 0.5).Light);
    }
    expect(GlassFaceParamsOf(250, 0.5, 1).Dark).toEqual(GLASS_FACE_APPLE_DARK_ELEVATED);
  });

  it('only large glass steps: none at 64 pt and under, the whole step from 96 pt, as the faces hand off', () => {
    for (const s of [32, 44, 56, 64]) expect(GlassFaceParamsOf(s, 0.5, 1).Dark).toEqual(GlassFaceParamsOf(s, 0.5, 0).Dark);
    for (const y of [0.05, 0.3]) {
      let prev = GlassLuma(GlassFaceOf(grey(y), 64, 0, 0.5, 1));
      for (let s = 65; s <= 96; s++) {
        const now = GlassLuma(GlassFaceOf(grey(y), s, 0, 0.5, 1));
        expect(Math.abs(now - prev)).toBeLessThan(0.02);
        prev = now;
      }
    }
  });

  it('read over the glass under it (lane GL5), a menu stands a step above any dark sheet the app draws, never below', () => {
    // The sheet: the base body over a dark ground, under its own face (Jwift Sheet.Geometry: black, 0 to 0.85 by height).
    // The menu reads that sheet's final pixels, once, and wears the presented face over them.
    for (const s of [160, 250, 400]) {
      for (let y = 0.0; y <= 0.35001; y += 0.05) {
        for (const faceAlpha of [0, 0.3, 0.6, 0.85]) {
          const sheet = GlassBodyOf(grey(y), 386, 0).map((x) => x * (1 - faceAlpha)) as unknown as GlassRgb;
          const step = lstar(GlassBodyOf(sheet, s, 0, 0.5, 1)) - lstar(sheet);
          const at = `S ${s}, ground ${y.toFixed(2)}, sheet face ${faceAlpha}`;
          expect(step, at).toBeGreaterThanOrEqual(3.5);
          expect(step, at).toBeLessThanOrEqual(15.5);
        }
      }
    }
  });

  it('grows with the share of the face over earlier glass: none to half, all from 0.9, smooth and rising between', () => {
    expect(GLASS_ELEVATION_COVER).toEqual([0.5, 0.9]);
    expect(GlassElevationOf(0)).toBe(0);
    expect(GlassElevationOf(0.08)).toBe(0); // a sheet over the tab bar
    expect(GlassElevationOf(0.5)).toBe(0);
    expect(GlassElevationOf(0.9)).toBe(1);
    expect(GlassElevationOf(1)).toBe(1); // a menu wholly over a sheet
    let prev = 0;
    for (let c = 0.5; c <= 0.9; c += 0.01) {
      const e = GlassElevationOf(c);
      expect(e).toBeGreaterThanOrEqual(prev);
      expect(e - prev).toBeLessThan(0.06);
      prev = e;
    }
  });

  it('rides lane 42 above the scheme bit in 31sts, which the vertex stage splits for the face', () => {
    expect(GLASS_ELEVATION_STEPS).toBe(31);
    const vert = read('../src/Jiv/Shaders/Jiv.Panel.vert');
    expect(vert).toContain('float schemeDark = mod(a_Lighting.z, 2.0);');
    expect(vert).toContain('v_Lighting.z = floor(a_Lighting.z / 2.0) / 31.0;');
    expect(vert).not.toContain('a_Lighting.z > 0.5');
    expect(PANEL).toContain('float glassElevation = v_Lighting.z;');
    expect(PANEL).toMatch(/face = GlassFace\(lensed, [^;]*v_RimEdge\.y,\s*glassElevation\);/);
    // Nothing else in the fragment stage reads the lane's old scheme bit.
    expect(PANEL.match(/v_Lighting\.z/g)!.length).toBe(1);
  });
});
