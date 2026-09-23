/**
 * Reads the backdrop grade and the glass body tint straight out of the SHADER SOURCES.
 *
 * Same discipline as Border.Hairline.Source: the ORDER the grade runs in is taken from the real
 * `.frag` function bodies, statement by statement, and the numbers are computed in that
 * order. Reorder the shader and these numbers move with it; there is no copy of the order kept here.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf8').replace(/\r\n/g, '\n');

export const readGlsl = (): string => read('Jiv', 'Shaders', 'Jiv.Panel.frag');
export const readProgressiveGlsl = (): string => read('ProgressiveBlur', 'ProgressiveBlur.Shader.ts');
export const readProgressiveWgsl = (): string => read('Core', 'Shaders', 'ProgressiveBlur.wgsl');

export type Rgb = [number, number, number];
export type GradeStep = 'Contrast' | 'Saturation' | 'Brightness';

/** Rec. 709 luma, as both panel shaders declare `LUMA`. */
const LUMA: Rgb = [0.2126, 0.7152, 0.0722];

const body = (source: string, header: RegExp, name: string): string => {
  const m = header.exec(source);
  if (!m) throw new Error(`could not find ${name}`);
  const open = source.indexOf('{', m.index);
  const close = source.indexOf('\n}', open);
  return source.slice(open + 1, close);
};

/** The grade steps of a shader function body, in the order its statements run. Every statement that
 *  touches the colour must be one of the three steps or the luma it feeds, or this throws: a step this
 *  reader does not recognise would otherwise drop silently out of the numbers. */
export const gradeSteps = (fnBody: string): GradeStep[] => {
  const steps: GradeStep[] = [];
  const statements = fnBody.replace(/\/\/[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) {
    const found: GradeStep[] = [];
    if (/-\s*0\.5\s*\)\s*\*\s*contrast\s*\+\s*0\.5/.test(statement)) found.push('Contrast');
    if (/mix\(\s*vec3f?\(\s*luma\s*\)\s*,\s*color\s*,\s*saturation\s*\)/.test(statement)) found.push('Saturation');
    if (/\*=?\s*brightness\b/.test(statement)) found.push('Brightness');
    if (found.length === 0) {
      if (/luma\s*=\s*dot\(\s*color\s*,\s*LUMA\s*\)/.test(statement) || /^return\s+color$/.test(statement)) continue;
      throw new Error(`unrecognised grade statement: "${statement}"`);
    }
    steps.push(...found);
  }
  return steps;
};

export const glslGradeSteps = (): GradeStep[] =>
  gradeSteps(body(readGlsl(), /vec3\s+applyGrading\s*\(/, 'applyGrading in Jiv.Panel.frag'));


export const glslTintBody = (): string => body(readGlsl(), /vec3\s+applyTint\s*\(/, 'applyTint in Jiv.Panel.frag');

/** The tint as both shaders write it: `mix(color, vec3(step(0, tint)), abs(tint))`. `tintMatchesSource`
 *  asserts that really is the body. */
export const TINT_BODY = /return\s+mix\(\s*color\s*,\s*vec3f?\(\s*step\(\s*0\.0\s*,\s*tint\s*\)\s*\)\s*,\s*abs\(\s*tint\s*\)\s*\)/;

export interface Grade { Brightness: number; Saturation: number; Contrast: number; }

/** Run a grade in the given step order. Pass a shader's steps to get what that shader computes. */
export const grade = (steps: GradeStep[], rgb: Rgb, g: Grade): Rgb => {
  let c = [...rgb] as Rgb;
  for (const step of steps) {
    if (step === 'Contrast') c = c.map((v) => (v - 0.5) * g.Contrast + 0.5) as Rgb;
    else if (step === 'Brightness') c = c.map((v) => v * g.Brightness) as Rgb;
    else {
      const luma = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
      c = c.map((v) => luma + (v - luma) * g.Saturation) as Rgb;
    }
  }
  return c;
};

/** The order the grade ran in BEFORE the fix. Kept ONLY as the control that proves the grey was real:
 *  brightness first, contrast last, pulling a darkened backdrop back up toward its 0.5 pivot. */
export const STEPS_BEFORE_FIX: GradeStep[] = ['Brightness', 'Saturation', 'Contrast'];

export const tint = (rgb: Rgb, t: number): Rgb => {
  const target = t >= 0 ? 1 : 0;
  return rgb.map((v) => v + (target - v) * Math.abs(t)) as Rgb;
};

/** What the framebuffer keeps: RGBA8 clamps to [0, 1]. */
export const display = (rgb: Rgb): Rgb => rgb.map((v) => Math.min(1, Math.max(0, v))) as Rgb;

/** HSV hue in degrees; NaN for a neutral. */
export const hue = ([r, g, b]: Rgb): number => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 1e-9) return NaN;
  const h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  return (h * 60 + 360) % 360;
};

/** The achromatic floor: how much plain grey sits under the colour. */
export const greyFloor = (rgb: Rgb): number => Math.min(...rgb);

export const luma = (rgb: Rgb): number => rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
