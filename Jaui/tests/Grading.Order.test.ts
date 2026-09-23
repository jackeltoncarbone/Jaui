/**
 * A darkened backdrop must land toward black with its hue kept, never on a grey floor.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────────
 * `BackdropFilter` parses to three scalars, and the shader applied them brightness, saturation,
 * contrast. Contrast below 1 pulls every value toward its 0.5 pivot, so running it LAST lifted
 * whatever brightness had just darkened back up toward mid grey: black glass read as a grey wash.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────────────────────────
 * Contrast first (the readability compression), saturation second (the vibrancy), brightness last,
 * so darkening scales the compressed result toward black. Then the glass body's Tint pulls toward the
 * theme's neutral, black or white, which is a mix and keeps the hue exactly.
 *
 * Everything below reads the REAL shader sources (Grading.Order.Source), so the order under test is
 * the order the shaders run.
 */
import { describe, it, expect } from 'vitest';
import {
  readGlsl, readProgressiveGlsl,
  glslGradeSteps, glslTintBody, TINT_BODY,
  grade, tint, display, hue, greyFloor, luma, STEPS_BEFORE_FIX,
  type Rgb, type Grade,
} from './Grading.Order.Source';

/** A deep blue, the colour of a dark hero behind a bar. */
const DEEP_BLUE: Rgb = [0.05, 0.08, 0.3];
/** Readability compression plus a strong darkening: the case the grey wash showed worst on. */
const DARKEN: Grade = { Contrast: 0.7, Saturation: 1, Brightness: 0.3 };
/** The colour-keeping thick material's own grade (JwiftGlassThickVivid before this change). */
const VIVID: Grade = { Contrast: 0.7, Saturation: 3.5, Brightness: 0.7 };

const AFTER = glslGradeSteps();

describe('the grade runs contrast, saturation, brightness', () => {
  it('GLSL applyGrading', () => {
    expect(glslGradeSteps()).toEqual(['Contrast', 'Saturation', 'Brightness']);
  });

  it('the progressive blur grades in the same order', () => {
    const src = readProgressiveGlsl();
    const c = src.search(/\(rgb\s*-\s*0\.5\)\s*\*\s*contrast\s*\+\s*0\.5/);
    const s = src.search(/mix\(vec3\(luma\),\s*rgb,\s*saturation\)/);
    const b = src.search(/rgb\s*\*=\s*brightness/);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(s);
    expect(s).toBeLessThan(b);
  });

  it('the tint is a mix toward black or white', () => {
    expect(glslTintBody()).toMatch(TINT_BODY);
  });

  it('the body, the flat backdrop and the rim are tinted; the foreground Filter grade is not', () => {
    const glsl = readGlsl();
    expect(glsl.match(/applyTint\(applyGrading\(/g)?.length).toBe(3);
    // Four grade calls (glass body, flat backdrop, rim, foreground) plus the definition.
    expect(glsl.match(/applyGrading\(/g)?.length).toBe(5);
    expect(glsl).toMatch(/result\.rgb = applyGrading\(result\.rgb, fgB/);
  });
});

describe('darkening a saturated colour lands near black, not on grey', () => {
  const before = display(grade(STEPS_BEFORE_FIX, DEEP_BLUE, DARKEN));
  const after = display(grade(AFTER, DEEP_BLUE, DARKEN));

  it('before the fix it sat on a grey floor (the control)', () => {
    // Every channel above 0.15: the 0.5 * (1 - contrast) lift contrast adds when it runs last.
    expect(greyFloor(before)).toBeGreaterThan(0.15);
    expect(luma(before)).toBeGreaterThan(0.15);
  });

  it('after the fix it is near black', () => {
    expect(greyFloor(after)).toBeLessThan(0.06);
    expect(luma(after)).toBeLessThan(0.08);
    expect(Math.max(...after)).toBeLessThan(0.12);
  });

  it('after the fix the hue is kept and the colour is more saturated than the grey version', () => {
    expect(Math.abs(hue(after) - hue(DEEP_BLUE))).toBeLessThan(2);
    const saturationOf = (c: Rgb): number => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    expect(saturationOf(after)).toBeGreaterThan(saturationOf(before) * 1.5);
  });

  it('black stays nearer black through the vivid grade', () => {
    const b = display(grade(STEPS_BEFORE_FIX, [0, 0, 0], VIVID));
    const a = display(grade(AFTER, [0, 0, 0], VIVID));
    expect(b[0]).toBeCloseTo(0.15, 3);
    expect(a[0]).toBeCloseTo(0.105, 3);
  });
});

describe('the body tint pulls toward the theme neutral, not toward grey', () => {
  const graded = display(grade(AFTER, DEEP_BLUE, { Contrast: 0.7, Saturation: 3.5, Brightness: 1 }));

  it('toward black (dark theme): value scales down, hue and saturation exactly kept', () => {
    const dark = tint(graded, -0.45);
    expect(hue(dark)).toBeCloseTo(hue(graded), 6);
    const saturationOf = (c: Rgb): number => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    expect(saturationOf(dark)).toBeCloseTo(saturationOf(graded), 6);
    expect(Math.max(...dark)).toBeCloseTo(Math.max(...graded) * 0.55, 6);
  });

  it('toward white (light theme): the floor rises toward white with the hue kept', () => {
    const light = tint(graded, 0.45);
    expect(hue(light)).toBeCloseTo(hue(graded), 6);
    expect(greyFloor(light)).toBeGreaterThan(0.45);
  });

  it('zero tint is the identity', () => {
    expect(tint(graded, 0)).toEqual(graded);
  });
});
