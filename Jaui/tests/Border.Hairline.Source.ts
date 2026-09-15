/**
 * Reads the border's hairline handling straight out of the SHADER SOURCES.
 *
 * Same discipline as Pill.Curve.Source: the numbers and the expressions come from the real
 * `.frag` / `.wgsl` files, never from a copy kept here, so changing the shader without changing
 * the test fails the test instead of quietly invalidating it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
export const GLSL_PATH = join(SRC, 'Jiv', 'Shaders', 'Jiv.Panel.frag');
export const WGSL_PATH = join(SRC, 'Core', 'Shaders', 'Panel.wgsl');

export const readGlsl = (): string => readFileSync(GLSL_PATH, 'utf8');
export const readWgsl = (): string => readFileSync(WGSL_PATH, 'utf8');

/** The hairline floor in device pixels, as each backend declares it. */
export const glslMinDevicePx = (): number => {
  const m = /const\s+float\s+BORDER_MIN_DEVICE_PX\s*=\s*([\d.]+)\s*;/.exec(readGlsl());
  if (!m) throw new Error('could not find BORDER_MIN_DEVICE_PX in Jiv.Panel.frag');
  return Number(m[1]);
};

export const wgslMinDevicePx = (): number => {
  const m = /const\s+BORDER_MIN_DEVICE_PX\s*:\s*f32\s*=\s*([\d.]+)\s*;/.exec(readWgsl());
  if (!m) throw new Error('could not find BORDER_MIN_DEVICE_PX in Panel.wgsl');
  return Number(m[1]);
};

/** `smoothstep` as GLSL and WGSL both define it. */
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Rim {
  /** Authored BorderWidth in device px, BEFORE BorderVariance. */
  Width: number;
  /** BorderBlur in device px — this is the shader's `aa`, not a fixed half pixel. */
  Aa: number;
  /** BorderFade in device px. */
  Fade: number;
  /** widthScale, which spans 1-BorderVariance .. 1+BorderVariance around the circumference. */
  Scale: number;
}

/**
 * The border alpha (`borderBase`) the CURRENT shader computes, at signed distance `dist`.
 *
 * Mirrors Jiv.Panel.frag verbatim:
 *   aa          = max(borderEdgeAa, 1e-4)
 *   varied      = max(borderWidth * widthScale, 0)
 *   drawn       = max(varied, BORDER_MIN_DEVICE_PX)
 *   coverage    = varied / drawn
 *   fadeIn      = max(borderFade * widthScale, aa)
 *   borderOuter = smoothstep(-aa, aa, dist)
 *   borderInner = smoothstep(-drawn - fadeIn, -drawn + aa, dist)
 *   borderBase  = (1 - borderOuter) * borderInner * coverage
 *
 * `structureMatchesGlsl` below asserts that this really is what the file says.
 */
export const borderAlpha = (rim: Rim, minDevicePx: number) => {
  const aa = Math.max(rim.Aa, 1e-4);
  const varied = Math.max(rim.Width * rim.Scale, 0);
  const drawn = Math.max(varied, minDevicePx);
  const coverage = varied / drawn;
  const fadeIn = Math.max(rim.Fade * rim.Scale, aa);
  return (dist: number): number =>
    (1 - smoothstep(-aa, aa, dist)) * smoothstep(-drawn - fadeIn, -drawn + aa, dist) * coverage;
};

/** The formula as it stood BEFORE the hairline floor. Kept ONLY as the control that proves the
 *  defect was real — it is what made a sub-pixel rim vanish. Nothing ships this. */
export const borderAlphaBeforeFix = (rim: Rim) => {
  const aa = Math.max(rim.Aa, 1e-4);
  const local = rim.Width * rim.Scale;
  const fadeIn = Math.max(rim.Fade * rim.Scale, aa);
  return (dist: number): number =>
    (1 - smoothstep(-aa, aa, dist)) * smoothstep(-local - fadeIn, -local + aa, dist);
};

const LO = -8;
const HI = 4;
const STEPS = 60000;

/** Highest alpha the stroke reaches anywhere across its cross-section. */
export const peakAlpha = (f: (d: number) => number): number => {
  let peak = 0;
  for (let i = 0; i <= STEPS; i++) {
    const v = f(LO + (i * (HI - LO)) / STEPS);
    if (v > peak) peak = v;
  }
  return peak;
};

/** Total ink: the integral of alpha across the stroke. A correct hairline carries the ink of its
 *  true width however wide it is actually drawn. */
export const inkAlpha = (f: (d: number) => number): number => {
  const step = (HI - LO) / STEPS;
  let sum = 0;
  for (let i = 0; i <= STEPS; i++) sum += f(LO + i * step) * step;
  return sum;
};

/**
 * The brightest pixel this edge lights up, in the WORST sub-pixel phase.
 *
 * This is the metric that matters and the one peak alpha hides. The fragment shader samples once
 * per pixel centre, and a curved rim crosses every sub-pixel phase as it goes round, so if some
 * phase yields nothing the rim is broken or absent along that stretch. Zero here means "flat out
 * does not show", however healthy the peak looks.
 */
export const worstPhaseAlpha = (f: (d: number) => number): number => {
  let worst = 1;
  for (let p = 0; p < 100; p++) {
    const phase = p / 100;
    let best = 0;
    for (let k = -10; k <= 6; k++) {
      const v = f(k + phase);
      if (v > best) best = v;
    }
    if (best < worst) worst = best;
  }
  return worst;
};
