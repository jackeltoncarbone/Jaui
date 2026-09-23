/**
 * Reads the pill curve straight out of the SHADER SOURCES.
 *
 * The pill tests used to keep their own copy of the polyline and the max-extent
 * constant. That made them pass while the shader said something entirely
 * different, so they guarded nothing. Everything here parses the real files, so
 * a change to the shape has to be reflected in the tests or they fail.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
export const GLSL_PATH = join(SRC, 'Jiv', 'Shaders', 'Jiv.Panel.frag');
export const WGSL_PATH = join(SRC, 'Core', 'Shaders', 'Panel.wgsl');
export const CURVE_PATH = join(SRC, 'Jiv', 'Pill.Curve.ts');

export interface PillCurve {
  maxExtent: number;
  points: Array<[number, number]>;
}

const numbers = (body: string): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  const re = /vec2f?\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push([Number(m[1]), Number(m[2])]);
  return out;
};

/** The curve the GLSL panel shader draws: its POINTS arrive as the `u_PillCurve` uniform from
 *  Jiv/Pill.Curve.ts (see that file for why it is not a shader constant), and its max extent is still
 *  the shader's own `SS_PILL_MAXEXTENT`. Both are read from the real files. */
export const readGlslCurve = (): PillCurve => {
  const src = readFileSync(GLSL_PATH, 'utf8');
  const ext = /const\s+float\s+SS_PILL_MAXEXTENT\s*=\s*([\d.]+)\s*;/.exec(src);
  const curveSrc = readFileSync(CURVE_PATH, 'utf8');
  const arr = /SS_PILL_CURVE\s*=\s*new Float32Array\(\[([\s\S]*?)\]\);/.exec(curveSrc);
  if (!ext || !arr) throw new Error('could not parse the pill curve out of Jiv.Panel.frag / Pill.Curve.ts');
  const flat = [...arr[1].matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
  const points: Array<[number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push([flat[i], flat[i + 1]]);
  return { maxExtent: Number(ext[1]), points };
};

export const readWgslCurve = (): PillCurve => {
  const src = readFileSync(WGSL_PATH, 'utf8');
  const ext = /const\s+SS_PILL_MAXEXTENT\s*:\s*f32\s*=\s*([\d.]+)\s*;/.exec(src);
  const arr = /SS_PILL_CURVE\s*:\s*array<vec2f,\s*\d+>\s*=\s*array<vec2f,\s*\d+>\(([\s\S]*?)\);/.exec(src);
  if (!ext || !arr) throw new Error('could not parse the pill curve out of Panel.wgsl');
  return { maxExtent: Number(ext[1]), points: numbers(arr[1]) };
};

/**
 * Apple's endcap, measured off their own artwork and calibrated against the iOS 18
 * switch beside it (known 51x31 track, 27 thumb). Chosen by minimising PIXEL MISMATCH of the rendered
 * silhouette against lossless Apple screenshots, jointly across two references at 150px and
 * 376px half-height. The parameters cross-validate: fitted on one they are near-optimal on
 * the other, and every one came back interior to its search range rather than pinned.
 * See Design/Apple.Measured.Spec.md.
 */
export const APPLE_LEAD_IN = 1.540;
/** Horizontal exponent. High, so the cap hugs the top edge for a long run before it turns:
 *  that long near-flat run is what reads as a proper straight side on a pill. */
export const APPLE_EXPONENT_X = 3.65;
/** Vertical exponent. Below 2, so the turn at the tip is softer than an ellipse's. */
export const APPLE_EXPONENT_Y = 1.80;

/**
 * Inward distance from the tip, in halfY units, at height t (0 = middle, 1 = tangent).
 *
 * The cap is an ASYMMETRIC superellipse. A symmetric one cannot do this: with a single
 * exponent the curve starts turning immediately and reads as an ellipse, which is why
 * every symmetric fit plateaued around 0.46-0.50% while this reaches 0.21-0.25%.
 */
export const appleCap = (
  t: number, L = APPLE_LEAD_IN, p = APPLE_EXPONENT_X, q = APPLE_EXPONENT_Y,
): number => {
  const inner = 1 - Math.pow(t, q);
  return inner <= 0 ? L : L * (1 - Math.pow(inner, 1 / p));
};
