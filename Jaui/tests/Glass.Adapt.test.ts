import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EmptyGlassAdaptCensus, GlassAdaptCensusOf, GlassAdaptEligible, GlassAdaptGrade, GlassAdaptLine, GlassBodyLuma,
  type GlassAdaptDraw, type GlassGrade,
} from '../src/Core/Glass.Adapt';

/**
 * `?glass-adapt`: the CPU mirror in `Core/Glass.Adapt.ts` IS the GLSL in `Jiv.Panel.vert`, statement for
 * statement, and the wiring leaves the `off` arm the folded engine. The law's own numbers (and the 4.5:1 /
 * 7:1 floors against the live @Ink) are held by ShowStudio.App's GlassLaw.Conformance.spec.ts section G,
 * which resolves Jwift.Glass.jss; the grades below are only shapes.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...p: string[]): string => readFileSync(join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const VERT = read('Jiv', 'Shaders', 'Jiv.Panel.vert');
const PROBE = read('Jiv', 'Shaders', 'Jiv.ShadowBackdrop.frag');
const RENDERER = read('Core', 'WebGL2.Renderer.ts');
const WALK = read('Core', 'Jaui.ts');

const body = (src: string, header: RegExp): string => {
  const m = header.exec(src);
  if (!m) throw new Error(`no ${header}`);
  const open = src.indexOf('{', m.index);
  return src.slice(open + 1, src.indexOf('\n}', open));
};
const statements = (b: string): string[] =>
  b.replace(/\/\/[^\n]*/g, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** A dark control-shaped grade: tint toward black, range compressed, colour given back. */
const DARK: GlassGrade = { Brightness: 1, Saturation: 2.9412, Contrast: 0.6251, Tint: -0.4561 };
const OPEN = 258.9 / 255;

describe('the GLSL and its mirror are one function', () => {
  it('GlassAdaptGrade in the vertex stage is exactly these statements', () => {
    expect(statements(body(VERT, /vec4\s+GlassAdaptGrade\s*\(/))).toEqual([
      'float t = -bodyTint',
      'float contrast = grading.z',
      'float ground = (1.0 - t) * (1.0 - contrast) * 0.5',
      'float far = (1.0 - t) * (1.0 + contrast) * 0.5',
      'float opened = min(openFar, ground + (far - ground) / max(peak, 1.0 / 1023.0))',
      'if (!(opened > far)) return vec4(grading.xyz, bodyTint)',
      'float range = opened - ground',
      'float keep = ground + opened',
      'float carry = contrast * grading.y * (1.0 - t)',
      'return vec4(max(keep, 1.0), carry / range, range / keep, -max(1.0 - keep, 0.0))',
    ]);
  });

  it('the GLSL body, EVALUATED, agrees with the mirror over a grid of grades, peaks and far ends', () => {
    // A mechanical transliteration: float -> let, vec4 -> an array, min/max -> Math. No hand port.
    const js = body(VERT, /vec4\s+GlassAdaptGrade\s*\(/)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\bfloat\s+/g, 'let ')
      .replace(/\bvec4\(grading\.xyz,\s*bodyTint\)/g, '[grading[0], grading[1], grading[2], bodyTint]')
      .replace(/\bvec4\((max\(keep, 1\.0\).*)\)\s*;/, '[$1];')
      .replace(/grading\.([xyz])/g, (_m, c: string) => `grading[${'xyz'.indexOf(c)}]`);
    const glsl = new Function('grading', 'bodyTint', 'peak', 'openFar', 'min', 'max',
      js) as (g: number[], t: number, p: number, o: number, min: typeof Math.min, max: typeof Math.max) => number[];
    let compared = 0;
    for (const c of [0.525, 0.6251, 0.742]) {
      for (const t of [-0.3, -0.4561, -0.571]) {
        for (let p = 0; p <= 20; p++) {
          for (const o of [0.5, OPEN, 1.2]) {
            const g: GlassGrade = { Brightness: 1, Saturation: 1 / c, Contrast: c, Tint: t };
            const out = glsl([1, g.Saturation, c, 0], t, p / 20, o, Math.min, Math.max);
            const m = GlassAdaptGrade(g, p / 20, o);
            expect(out[0]).toBeCloseTo(m.Brightness, 12);
            expect(out[1]).toBeCloseTo(m.Saturation, 12);
            expect(out[2]).toBeCloseTo(m.Contrast, 12);
            expect(out[3]).toBeCloseTo(m.Tint, 12);
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(567);
  });

  it('the vertex stage opens only an eligible instance, reading the probe texel\'s B, and writes only the grade', () => {
    const main = body(VERT, /void\s+main\s*\(/);
    const at = main.indexOf('if (u_GlassAdapt.x >= 0.0');
    expect(at).toBeGreaterThan(0);
    const block = main.slice(at, main.indexOf('\n    }\n', at));
    expect(block).toContain('u_GlassAdapt.y > 0.0 && a_Lighting.y < 0.0 && a_Grading.x == 1.0');
    expect(block).toContain('texelFetch(u_ShadowState, ivec2(int(u_GlassAdapt.x), 0), 0).b');
    expect(block).toContain('v_Grading.xyz = adapted.xyz');
    expect(block).toContain('v_Lighting.y = adapted.w');
    // After every plain varying copy, so the copies cannot overwrite it.
    expect(at).toBeGreaterThan(main.indexOf('v_BorderFilter = a_BorderFilter'));
  });

  it('the fragment shader is untouched: the grade reaches it through the varyings it already reads', () => {
    expect(read('Jiv', 'Shaders', 'Jiv.Panel.frag')).not.toMatch(/GlassAdapt/);
  });

  it('eligibility mirrors the vertex guard', () => {
    expect(GlassAdaptEligible(DARK, OPEN)).toBe(true);
    expect(GlassAdaptEligible(DARK, 0)).toBe(false);
    expect(GlassAdaptEligible({ ...DARK, Tint: 0.467 }, OPEN)).toBe(false);
    expect(GlassAdaptEligible({ ...DARK, Tint: 0 }, OPEN)).toBe(false);
    expect(GlassAdaptEligible({ ...DARK, Brightness: 0.72 }, OPEN)).toBe(false);
  });
});

describe('the rule', () => {
  const ground = GlassBodyLuma(DARK, 0);
  const far = GlassBodyLuma(DARK, 1);

  it('over white the grade is returned as authored, the same object', () => {
    expect(GlassAdaptGrade(DARK, 1, OPEN)).toBe(DARK);
  });

  it('over black the body is the ground end, whatever it opened to', () => {
    const a = GlassAdaptGrade(DARK, 0, OPEN);
    expect(a).not.toBe(DARK);
    expect(GlassBodyLuma(a, 0)).toBeCloseTo(ground, 12);
    expect(GlassBodyLuma(a, 1)).toBeCloseTo(OPEN, 12);
  });

  it('the body at the peak lands on the authored far end exactly while the ink binds', () => {
    for (const peak of [0.5, 0.6, 0.8, 0.95]) {
      const a = GlassAdaptGrade(DARK, peak, OPEN);
      expect(GlassBodyLuma(a, peak)).toBeCloseTo(far, 12);
    }
  });

  it('never lighter than the authored far end anywhere at or below the peak', () => {
    for (let p = 0; p <= 100; p++) {
      const a = GlassAdaptGrade(DARK, p / 100, OPEN);
      for (let y = 0; y <= p; y++) expect(GlassBodyLuma(a, y / 100)).toBeLessThanOrEqual(far + 1e-12);
    }
  });

  it('past a tint of zero the lift is a brightness, and the carry is unchanged throughout', () => {
    const carry = DARK.Contrast * DARK.Saturation * (1 + DARK.Tint);
    let lifted = 0;
    for (let p = 0; p <= 100; p++) {
      const a = GlassAdaptGrade(DARK, p / 100, OPEN);
      if (a.Brightness > 1) { lifted++; expect(a.Tint).toBe(-0); }
      expect(a.Contrast * a.Saturation * a.Brightness * (1 - Math.abs(a.Tint))).toBeCloseTo(carry, 12);
    }
    expect(lifted).toBeGreaterThan(0);
  });
});

describe('the census names what it saw, and names a vacuous arm', () => {
  const draw = (slot: number, grade: GlassGrade = DARK, open = OPEN): GlassAdaptDraw => ({ Slot: slot, OpenFar: open, Grade: grade });
  const row = (texels: [number, number][]): Uint8Array => {
    const r = new Uint8Array(64 * 4);
    texels.forEach(([mean, peak], i) => { r[i * 4 + 1] = mean; r[i * 4 + 2] = peak; });
    return r;
  };

  it('counts lifted, capped, open and static per surface', () => {
    const c = EmptyGlassAdaptCensus('on', '');
    // slot 0 over a mid-tone (capped by the ink), slot 1 over near-black (fully open), slot 2 over white.
    GlassAdaptCensusOf(c, [draw(0), draw(1), draw(2), draw(3, { ...DARK, Tint: 0.467 })], 2, row([[110, 140], [10, 20], [255, 255], [100, 100]]));
    expect(c.Surfaces).toBe(3);
    expect(c.Ineligible).toBe(1);
    expect(c.Unprobed).toBe(2);
    expect(c.Lifted).toBe(2);
    expect(c.Capped).toBe(1);
    expect(c.Open).toBe(1);
    expect(c.Static).toBe(1);
    expect(c.Vacuous).toBe('');
    expect(c.MeanMin * 255).toBeCloseTo(10, 9);
    expect(c.MeanMax * 255).toBeCloseTo(255, 9);
    const line = GlassAdaptLine(c);
    expect(line).toContain('lifted=2 capped=1 open=1 static=1 flipped=0 ink=cap');
    expect(line).toContain('pixels=DIFFERENT');
  });

  it('a run where every surface resolved to the static law says so rather than reading as a pass', () => {
    const c = EmptyGlassAdaptCensus('on', '');
    GlassAdaptCensusOf(c, [draw(0), draw(1)], 0, row([[255, 255], [250, 255]]));
    expect(c.Lifted).toBe(0);
    expect(c.Vacuous).toBe('every-surface-resolved-to-the-static-law');
    expect(GlassAdaptLine(c)).toContain('vacuous=every-surface-resolved-to-the-static-law');
    expect(GlassAdaptLine(c)).toContain('pixels=SAME');
  });

  it('no probed surface is vacuous too, and says why', () => {
    const c = EmptyGlassAdaptCensus('on', '');
    GlassAdaptCensusOf(c, [], 3, row([]));
    expect(c.Vacuous).toBe('no-adaptive-surface-was-probed');
    GlassAdaptCensusOf(c, [], 0, row([]));
    expect(c.Vacuous).toBe('no-adaptive-surface-drawn');
  });
});

describe('the wiring', () => {
  it('the probe writes the mean and the brightest local luma into G and B, and R is still the factor', () => {
    const main = body(PROBE, /void\s+main\s*\(/);
    expect(main).toMatch(/peak\s*=\s*max\(\s*peak\s*,\s*local\s*\)/);
    expect(main).toMatch(/fragColor\s*=\s*vec4\(\s*ShadowBackdropFactor\(\s*sum\s*\/\s*count\s*,\s*detail\s*\/\s*count\s*\)\s*,\s*sum\s*\/\s*count\s*,\s*peak\s*,\s*1\.0\s*\)/);
  });

  it('every panel batch uploads the adapt uniform, -1 unless a slot and a far end came with it', () => {
    const draw = RENDERER.slice(RENDERER.indexOf('  PanelDrawBatch = ('), RENDERER.indexOf('gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this._panelInstanceCount)'));
    expect(draw.match(/gl\.uniform2f\(locs\.glassAdapt,/g)?.length).toBe(1);
    expect(draw).toMatch(/glassAdapt\.Slot >= 0 && glassAdapt\.OpenFar > 0 \? glassAdapt\.Slot : -1/);
  });

  it('`off` hands no draw an adapt, and refuses by name where there is no texel', () => {
    const helper = body(WALK, /private _glassAdaptFor = \(/);
    expect(helper).toMatch(/if \(this\._glassAdapt !== 'on'\) return undefined/);
    expect(WALK).toContain("'no-shadow-removes-the-probe-the-grade-reads'");
    expect(WALK).toContain("'no-probe-state-off-webgl2'");
  });

  it('the census reads back only on `on`', () => {
    expect(body(WALK, /private _glassAdaptEndFrame = \(/)).toMatch(/^\s*if \(this\._glassAdapt !== 'on'\) return;/);
  });
});
