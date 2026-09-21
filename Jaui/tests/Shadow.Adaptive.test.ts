/**
 * A glass shadow is set by what lies behind the glass, as Apple's Liquid Glass shadow is.
 *
 * WWDC25 "Meet Liquid Glass": the element "increases the opacity of its shadow when it is over text" and
 * "lowers the opacity of its shadow when it is over a solid light background". So the shadow is not a
 * fixed per-theme value: `ShadowColor`'s alpha is the shadow over busy content, and `ShadowAdaptive` is
 * how much of it a flat light ground takes away.
 *
 * Everything below runs the REAL shader math (Shadow.Adaptive.Source parses it out of
 * `Jiv.ShadowBackdrop.frag` and `Jiv.Panel.vert`), over backdrops built as luminance fields.
 */
import { describe, it, expect } from 'vitest';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';
import type { JivStyle } from '@jaui/Jiv/Jiv.Types';
import {
  loadShadowModel, blurred, readMeasure, readPanelVert, readJwiftGlass, functionBody, uniformNames,
  type LumaField,
} from './Shadow.Adaptive.Source';

const model = loadShadowModel();

// A tab bar's footprint at 3x: 360 by 62 CSS px.
const WIDTH = 1080;
const HEIGHT = 186;
// JwiftGlass's 4pt frost at 3x: the local mean each sharp tap is compared against.
const LOCAL_RADIUS = 12;
// JwiftGlass's authored shadow.
const AUTHORED_ALPHA = 0.28;
const ADAPTIVE = 0.85;

const flat = (luma: number): LumaField => () => luma;

/** Lines of 17pt text at 22pt leading: 5 px stems every 20 px inside a 27 px x-height band. */
const text = (ink: number, ground: number, scroll = 0): LumaField => (x, y) => {
  const line = (((y + scroll) % 66) + 66) % 66;
  const inBand = line >= 24 && line < 51;
  const onStem = ((x % 20) + 20) % 20 < 5;
  return inBand && onStem ? ink : ground;
};

/** A photo-like mosaic: 40 px blocks of hashed luminance. */
const imagery: LumaField = (x, y) => {
  const bx = Math.floor(x / 40), by = Math.floor(y / 40);
  const h = Math.sin(bx * 12.9898 + by * 78.233) * 43758.5453;
  return h - Math.floor(h);
};

const factorOver = (field: LumaField): number =>
  model.Measure(field, blurred(field, LOCAL_RADIUS, 2), WIDTH, HEIGHT);

const alphaOver = (field: LumaField): number => model.Alpha(AUTHORED_ALPHA, factorOver(field), ADAPTIVE);

describe('the shadow follows the backdrop', () => {
  it('over a flat white ground it is near invisible', () => {
    expect(factorOver(flat(1))).toBe(0);
    expect(alphaOver(flat(1))).toBeCloseTo(AUTHORED_ALPHA * (1 - ADAPTIVE), 6);
    expect(alphaOver(flat(1))).toBeLessThan(0.05);
  });

  it('over text it is at full strength, whichever way round the ink is', () => {
    expect(factorOver(text(0, 1))).toBeGreaterThan(0.95);
    expect(factorOver(text(1, 0))).toBeGreaterThan(0.95);
    expect(alphaOver(text(0, 1))).toBeGreaterThan(AUTHORED_ALPHA * 0.95);
  });

  it('is lower over a flat light ground than over high detail', () => {
    for (const busy of [text(0, 1), text(0.1, 0.95), imagery]) {
      expect(alphaOver(flat(1))).toBeLessThan(alphaOver(busy));
      expect(alphaOver(flat(0.8))).toBeLessThan(alphaOver(busy));
    }
    expect(alphaOver(text(0, 1)) / alphaOver(flat(1))).toBeGreaterThan(5);
  });

  it('busy imagery counts as detail; smooth light art does not', () => {
    expect(factorOver(imagery)).toBeGreaterThan(0.9);
    const softArt: LumaField = (x, y) => 0.7 + 0.2 * Math.sin(x / 90) * Math.cos(y / 70);
    expect(factorOver(softArt)).toBeLessThan(0.2);
  });

  it('a flat ground gets lighter, the shadow gets fainter, monotonically', () => {
    let last = Infinity;
    for (let luma = 0; luma <= 1.0001; luma += 0.05) {
      const a = alphaOver(flat(luma));
      expect(a).toBeLessThanOrEqual(last + 1e-9);
      last = a;
    }
  });

  it('text scrolling under the glass does not flicker the reading', () => {
    const readings: number[] = [];
    for (let scroll = 0; scroll < 66; scroll += 3) readings.push(factorOver(text(0, 1, scroll)));
    expect(Math.max(...readings) - Math.min(...readings)).toBeLessThan(0.05);
  });

  it('ShadowAdaptive 0 is the fixed shadow of before, whatever is behind', () => {
    for (const field of [flat(1), flat(0), text(0, 1), imagery]) {
      expect(model.Alpha(AUTHORED_ALPHA, factorOver(field), 0)).toBeCloseTo(AUTHORED_ALPHA, 9);
    }
  });
});

describe('nothing but the backdrop decides: no theme input anywhere on the path', () => {
  const THEME_WORDS = /\b(Dark|Light|Theme|Tint|TintTone|Ground|Ink)\b/;

  it('the measurement reads only the backdrop, the footprint and the blur level', () => {
    expect(uniformNames(readMeasure()).sort()).toEqual(['u_Backdrop', 'u_BackdropXf', 'u_DetailLod', 'u_Rect', 'u_Resolution', 'u_Scene']);
    const code = readMeasure().replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(THEME_WORDS);
  });

  it('the panel applies the reading with no theme term', () => {
    const vert = readPanelVert();
    expect(functionBody(vert, /float\s+AdaptiveShadowAlpha\s*\(/, 'AdaptiveShadowAlpha')).not.toMatch(THEME_WORDS);
    const block = vert.slice(vert.indexOf('if (u_ShadowBackdrop.x >= 0.0)'), vert.indexOf('v_StyleParams = a_StyleParams'));
    expect(block).not.toMatch(THEME_WORDS);
  });

  it('the Jwift glass shadow resolves identically in dark and light', () => {
    const sheet = readJwiftGlass();
    const glass = sheet.slice(sheet.indexOf('\nJwiftGlass {'), sheet.indexOf('\n}', sheet.indexOf('\nJwiftGlass {')));
    const value = (name: string): string => {
      const m = new RegExp(`\\n\\s*${name}:\\s*([^\\n]+)`).exec(glass);
      if (!m) throw new Error(`JwiftGlass has no ${name}`);
      return m[1].trim();
    };
    const style = {
      ShadowColor: value('ShadowColor'), ShadowBlur: value('ShadowBlur'),
      ShadowOffsetY: value('ShadowOffsetY'), ShadowAdaptive: value('ShadowAdaptive'),
    };
    for (const v of Object.values(style)) expect(v).not.toContain('@');
    const resolve = (vars: Record<string, string>) => ResolveStyle(
      { ...DefaultJivStyle, ...style } as JivStyle,
      { ...SEED_CONTEXT, Vars: new Map(Object.entries(vars)) },
    );
    const dark = resolve({ Dark: '1', Light: '0' });
    const light = resolve({ Dark: '0', Light: '1' });
    expect(dark.ShadowAdaptive).toBeGreaterThan(0);
    expect(light.ShadowAdaptive).toBe(dark.ShadowAdaptive);
    expect(light.ShadowColor).toEqual(dark.ShadowColor);
    expect(light.ShadowBlur).toBe(dark.ShadowBlur);
    expect(light.ShadowOffsetY).toBe(dark.ShadowOffsetY);
  });

  it('ShadowAdaptive clamps to 0..1', () => {
    const adaptive = (raw: string): number =>
      ResolveStyle({ ...DefaultJivStyle, ShadowAdaptive: raw } as JivStyle, SEED_CONTEXT).ShadowAdaptive;
    expect(adaptive('0')).toBe(0);
    expect(adaptive('0.85')).toBeCloseTo(0.85, 9);
    expect(adaptive('3')).toBe(1);
    expect(adaptive('-1')).toBe(0);
  });
});
