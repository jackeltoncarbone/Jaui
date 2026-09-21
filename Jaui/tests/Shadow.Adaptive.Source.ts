/**
 * Reads the adaptive glass shadow straight out of the SHADER SOURCES.
 *
 * Same discipline as Grading.Order.Source: the constants are parsed from `Jiv.ShadowBackdrop.frag`, the
 * statements that combine them are matched against the real function bodies, and the numbers below are
 * computed from what was parsed. Retune a constant in the shader and these numbers move with it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

export const readMeasure = (): string => read(join(SRC, 'Jiv', 'Shaders', 'Jiv.ShadowBackdrop.frag'));
export const readPanelVert = (): string => read(join(SRC, 'Jiv', 'Shaders', 'Jiv.Panel.vert'));
export const readJwiftGlass = (): string =>
  read(join(HERE, '..', '..', '..', 'Jwift', 'Jwift.Angular', 'src', 'Glass', 'Jwift.Glass.jss'));

const stripComments = (source: string): string => source.replace(/\/\/[^\n]*/g, '');

export const functionBody = (source: string, header: RegExp, name: string): string => {
  const m = header.exec(source);
  if (!m) throw new Error(`could not find ${name}`);
  const open = source.indexOf('{', m.index);
  const close = source.indexOf('\n}', open);
  return stripComments(source.slice(open + 1, close));
};

/** Every `const int|float NAME = value;` in a shader. */
export const shaderConstants = (source: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const m of stripComments(source).matchAll(/const\s+(?:int|float)\s+(\w+)\s*=\s*(-?[\d.]+)\s*;/g)) {
    out[m[1]] = parseFloat(m[2]);
  }
  return out;
};

/** `uniform <type> <name>;` names in a shader. */
export const uniformNames = (source: string): string[] =>
  [...stripComments(source).matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]);

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export interface ShadowModel {
  Constants: Record<string, number>;
  /** ShadowBackdropFactor, with the shader's constants. */
  Factor: (meanLuma: number, detail: number) => number;
  /** AdaptiveShadowAlpha from the panel vertex. */
  Alpha: (authoredAlpha: number, factor: number, adaptive: number) => number;
  /** The measurement pass's main(): taps a footprint of two luminance fields and returns the factor. */
  Measure: (sharp: LumaField, local: LumaField, width: number, height: number) => number;
}

/** A backdrop's luminance at a device pixel of the footprint. */
export type LumaField = (x: number, y: number) => number;

/** Builds the model from the real sources, asserting every statement it relies on is really there. */
export const loadShadowModel = (): ShadowModel => {
  const measure = readMeasure();
  const c = shaderConstants(measure);
  const r2m = /const\s+vec2\s+SHADOW_R2\s*=\s*vec2\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)\s*;/.exec(measure);
  if (!r2m) throw new Error('shader no longer declares SHADOW_R2');
  const r2 = [parseFloat(r2m[1]), parseFloat(r2m[2])];

  const factorBody = functionBody(measure, /float\s+ShadowBackdropFactor\s*\(/, 'ShadowBackdropFactor');
  const need = (body: string, pattern: RegExp, what: string): void => {
    if (!pattern.test(body)) throw new Error(`shader no longer contains ${what}`);
  };
  need(factorBody, /busy\s*=\s*smoothstep\(\s*SHADOW_DETAIL_LOW\s*,\s*SHADOW_DETAIL_HIGH\s*,\s*detail\s*\)/, 'the busy smoothstep');
  need(factorBody, /light\s*=\s*smoothstep\(\s*SHADOW_LIGHT_LOW\s*,\s*SHADOW_LIGHT_HIGH\s*,\s*meanLuma\s*\)/, 'the light smoothstep');
  need(factorBody, /return\s+max\(\s*busy\s*,\s*\(\s*1\.0\s*-\s*light\s*\)\s*\*\s*SHADOW_FLAT_DARK\s*\)/, 'the factor combine');
  if (factorBody.split(';').map((s) => s.trim()).filter(Boolean).length !== 3) {
    throw new Error('ShadowBackdropFactor gained a statement this model does not know');
  }

  const mainBody = functionBody(measure, /void\s+main\s*\(/, 'main');
  need(mainBody, /sharp\s*=\s*dot\(\s*textureLod\(\s*u_Scene\s*,\s*uv\s*,\s*0\.0\s*\)\.rgb\s*,\s*LUMA\s*\)/, 'the sharp tap');
  // The pyramid is sized to the surface, so the screen UV goes through its region map first.
  need(mainBody, /local\s*=\s*dot\(\s*textureLod\(\s*u_Backdrop\s*,\s*uv\s*\*\s*u_BackdropXf\.xy\s*\+\s*u_BackdropXf\.zw\s*,\s*u_DetailLod\s*\)\.rgb\s*,\s*LUMA\s*\)/, 'the local tap');
  need(mainBody, /detail\s*\+=\s*abs\(\s*sharp\s*-\s*local\s*\)/, 'the detail sum');
  need(mainBody, /cell\s*=\s*fract\(\s*0\.5\s*\+\s*float\(\s*k\s*\+\s*1\s*\)\s*\*\s*SHADOW_R2\s*\)/, 'the R2 tap sequence');
  need(mainBody, /pixel\s*=\s*u_Rect\.xy\s*\+\s*cell\s*\*\s*u_Rect\.zw/, 'the tap placement');
  need(mainBody, /ShadowBackdropFactor\(\s*sum\s*\/\s*count\s*,\s*detail\s*\/\s*count\s*\)/, 'the factor call');

  const alphaBody = functionBody(readPanelVert(), /float\s+AdaptiveShadowAlpha\s*\(/, 'AdaptiveShadowAlpha');
  need(alphaBody, /^\s*return\s+authoredAlpha\s*\*\s*mix\(\s*1\.0\s*,\s*backdropFactor\s*,\s*adaptive\s*\)\s*;\s*$/, 'the adaptive alpha');

  const Factor = (meanLuma: number, detail: number): number => {
    const busy = smoothstep(c.SHADOW_DETAIL_LOW, c.SHADOW_DETAIL_HIGH, detail);
    const light = smoothstep(c.SHADOW_LIGHT_LOW, c.SHADOW_LIGHT_HIGH, meanLuma);
    return Math.max(busy, (1 - light) * c.SHADOW_FLAT_DARK);
  };
  const Alpha = (authoredAlpha: number, factor: number, adaptive: number): number =>
    authoredAlpha * (1 + (factor - 1) * adaptive);
  const Measure = (sharp: LumaField, local: LumaField, width: number, height: number): number => {
    const count = c.SHADOW_TAPS;
    const fract = (v: number): number => v - Math.floor(v);
    let sum = 0, detail = 0;
    for (let k = 0; k < count; k++) {
      const x = fract(0.5 + (k + 1) * r2[0]) * width;
      const y = fract(0.5 + (k + 1) * r2[1]) * height;
      const s = sharp(x, y), l = local(x, y);
      sum += l;
      detail += Math.abs(s - l);
    }
    return Factor(sum / count, detail / count);
  };
  return { Constants: c, Factor, Alpha, Measure };
};

/** A box blur of a field, standing in for the pyramid level the measurement compares against. */
export const blurred = (field: LumaField, radius: number, step = 1): LumaField => (x, y) => {
  let sum = 0, n = 0;
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) { sum += field(x + dx, y + dy); n++; }
  }
  return sum / n;
};
