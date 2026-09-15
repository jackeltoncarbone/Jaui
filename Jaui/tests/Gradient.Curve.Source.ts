/**
 * Reads the gradient curve and its dither straight out of the SHADER SOURCE and the CPU mirror, so the
 * numbers under test are the ones the panel shader runs: the OKLab matrices, the Hermite basis, the noise
 * constants and the dither scale are taken from Jiv.Panel.frag and checked against Gradient.Curve.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf8').replace(/\r\n/g, '\n');

export const readPanelGlsl = (): string => read('Jiv', 'Shaders', 'Jiv.Panel.frag');
export const readCurveTs = (): string => read('Core', 'Gradient.Curve.ts');
export const readWebGl2Renderer = (): string => read('Core', 'WebGL2.Renderer.ts');
export const readProgressiveBlurShader = (): string => read('ProgressiveBlur', 'ProgressiveBlur.Shader.ts');

/** The body of the first function whose header matches, up to its closing brace at column 0. */
export const body = (source: string, header: RegExp): string => {
  const m = header.exec(source);
  if (!m) throw new Error(`could not find ${header}`);
  const open = source.indexOf('{', m.index);
  return source.slice(open + 1, source.indexOf('\n}', open));
};

/** Every decimal literal with four or more fraction digits, signed, in order: the matrix coefficients. */
export const coefficients = (fnBody: string): number[] =>
  [...fnBody.replace(/\s+/g, '').matchAll(/(-?)(\d+\.\d{4,})/g)].map((m) => Number(m[1] + m[2]));

export const glslOklabToSrgb = (): number[] => coefficients(body(readPanelGlsl(), /vec3\s+oklabToSrgb\s*\(/));
export const tsOklabToSrgb = (): number[] => coefficients(body(readCurveTs(), /export const OklabToSrgb\s*=/));

export const glslSampleGradient = (): string => body(readPanelGlsl(), /vec4\s+sampleBgGradient\s*\(/);
export const glslNoise = (): string => body(readPanelGlsl(), /float\s+gradientNoise\s*\(/);
export const tsNoise = (): string => body(readCurveTs(), /export const GradientNoise\s*=/);

/** The gradient dither branch of the panel's final composite. */
export const glslDitherBranch = (): string => {
  const src = readPanelGlsl();
  const at = src.indexOf('else if (u_BgMode >= 2)');
  if (at < 0) throw new Error('no gradient dither branch');
  return src.slice(at, src.indexOf('\n    }', at));
};

export const glslMaxStops = (): number => Number(/#define\s+MAX_BG_GRAD_STOPS\s+(\d+)/.exec(readPanelGlsl())![1]);
