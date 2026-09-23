/**
 * A border thinner than a device pixel must render faintly, never vanish.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────────
 * The border is point-sampled ONCE per fragment. An annulus narrower than a device pixel can fall
 * entirely between pixel centres, so nothing on that edge lights up at all. Peak alpha hides this
 * completely: at BorderBlur 0 a 0.45px stroke has peak alpha 1.0 and correct ink, and still draws
 * NOTHING for most sub-pixel phases. `worstPhaseAlpha` is the metric that sees it.
 *
 * BorderVariance makes it a visible asymmetry rather than a uniform dimming: `widthScale` bottoms out
 * at `1 - BorderVariance`, which is 0.5x for the Jwift glass rim and 0.4x for the toggle's held rim,
 * so the SAME shape renders its rim on the lit side and drops it on the thin sides.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────────────────────────
 * Never draw a stroke thinner than a device pixel. Draw it at the floor and carry the width it lost
 * as coverage, so a 0.7px stroke becomes a 1.0px stroke at 0.7 alpha: the same ink, over a footprint
 * the sample grid cannot miss.
 *
 * Everything below reads the REAL shader sources, so the shaders cannot drift away from this file.
 */
import { describe, it, expect } from 'vitest';
import {
  readGlsl, glslMinDevicePx,
  borderAlpha, borderAlphaBeforeFix, peakAlpha, inkAlpha, worstPhaseAlpha,
  type Rim,
} from './Border.Hairline.Source';

/** Widths in DEVICE pixels, spanning well under a pixel to comfortably over. */
const WIDTHS = [0.2, 0.3, 0.45, 0.6, 0.7, 0.8, 0.9, 1.0, 1.25, 1.6, 2.0, 2.4, 3.0];

/** The feathers our sheets actually author (BorderBlur, in device px at DPR 1/2/3), plus 0 — the
 *  case with no feather at all, which is where the old formula failed hardest. */
const FEATHERS = [0, 0.25, 0.5, 0.6, 0.9, 1.2];

const MIN = glslMinDevicePx();

describe('the hairline floor', () => {
  it('the floor is one device pixel', () => {
    expect(glslMinDevicePx()).toBe(1.0);
  });

  it('GLSL clamps the drawn width and carries the remainder as coverage', () => {
    const src = readGlsl();
    expect(src).toContain('float drawnBorderWidth = max(variedBorderWidth, BORDER_MIN_DEVICE_PX);');
    expect(src).toContain('float borderCoverage = variedBorderWidth / drawnBorderWidth;');
    // The clamp must sit AFTER the variance, or variance could still drive the drawn width to zero.
    expect(src.indexOf('float localBorderWidth = borderWidth * widthScale;'))
      .toBeLessThan(src.indexOf('float drawnBorderWidth'));
  });

  it('both border sites draw at the floor and scale by coverage', () => {
    const glsl = readGlsl();
    // The glass rim and the plain stroke are two separate sites; both must be fixed.
    expect(glsl.split('smoothstep(-drawnBorderWidth - fadeIn, -drawnBorderWidth + aa, dist)').length - 1).toBe(2);
    expect(glsl.split('* borderInner * borderCoverage;').length - 1).toBe(2);
  });

  it('the dead per-pixel feather scaling is gone', () => {
    // `localBorderEdgeAa` was computed and never used. Scaling the feather WITH the width is not the
    // fix and is actively worse: it shrinks the footprint exactly where it is already too small.
    expect(readGlsl()).not.toContain('localBorderEdgeAa');
  });
});

describe('border alpha across sub-pixel widths', () => {
  it('never collapses to zero for a positive width', () => {
    for (const aa of FEATHERS) {
      for (const width of WIDTHS) {
        const rim: Rim = { Width: width, Aa: aa, Fade: 0, Scale: 1 };
        const peak = peakAlpha(borderAlpha(rim, MIN));
        expect(peak, `peak alpha at width ${width}px, feather ${aa}px`).toBeGreaterThan(0);
      }
    }
  });

  it('is monotonic in width — a wider stroke is never fainter', () => {
    for (const aa of FEATHERS) {
      let previous = -1;
      for (const width of WIDTHS) {
        const peak = peakAlpha(borderAlpha({ Width: width, Aa: aa, Fade: 0, Scale: 1 }, MIN));
        expect(peak, `peak alpha went DOWN at width ${width}px, feather ${aa}px`).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = peak;
      }
    }
  });

  it('lights up at least one pixel in EVERY sub-pixel phase', () => {
    // The actual regression. Zero here is the bug the user reported.
    for (const aa of FEATHERS) {
      for (const width of WIDTHS) {
        const worst = worstPhaseAlpha(borderAlpha({ Width: width, Aa: aa, Fade: 0, Scale: 1 }, MIN));
        expect(worst, `no pixel lights up at width ${width}px, feather ${aa}px`).toBeGreaterThan(0);
      }
    }
  });

  it('carries the ink of its true width, however wide it is drawn', () => {
    // Coverage is only honest if widening the stroke does not also brighten it.
    for (const width of WIDTHS) {
      const ink = inkAlpha(borderAlpha({ Width: width, Aa: 0, Fade: 0, Scale: 1 }, MIN));
      expect(ink, `ink at width ${width}px`).toBeCloseTo(width, 2);
    }
  });

  it('a zero width still draws nothing', () => {
    for (const aa of FEATHERS) {
      const peak = peakAlpha(borderAlpha({ Width: 0, Aa: aa, Fade: 0, Scale: 1 }, MIN));
      expect(peak, `feather ${aa}px`).toBe(0);
    }
  });
});

describe('BorderVariance thins the rim but can no longer delete it', () => {
  // The two rims our sheets actually author, in device px at DPR 2.
  const GLASS: Rim = { Width: 0.9, Aa: 0.6, Fade: 1.5, Scale: 1 };
  const TOGGLE: Rim = { Width: 1.6, Aa: 0.8, Fade: 1.0, Scale: 1 };

  it('the thin side of the circumference still renders', () => {
    for (const [name, rim, variance] of [
      ['Jwift glass rim', GLASS, 0.5],
      ['Toggle held rim', TOGGLE, 0.6],
    ] as const) {
      const thin = worstPhaseAlpha(borderAlpha({ ...rim, Scale: 1 - variance }, MIN));
      expect(thin, `${name}: thin side vanished`).toBeGreaterThan(0);
    }
  });

  it('the thin side is dimmer than the lit side, as the variance asks', () => {
    for (const [name, rim, variance] of [
      ['Jwift glass rim', GLASS, 0.5],
      ['Toggle held rim', TOGGLE, 0.6],
    ] as const) {
      const thin = peakAlpha(borderAlpha({ ...rim, Scale: 1 - variance }, MIN));
      const thick = peakAlpha(borderAlpha({ ...rim, Scale: 1 + variance }, MIN));
      expect(thin, `${name}: thinning stopped working`).toBeLessThan(thick);
    }
  });
});

describe('the defect this replaced was real', () => {
  // Control only. This is the formula as it stood BEFORE the floor; nothing ships it.
  it('the old formula drew NOTHING for a sub-pixel stroke with no feather', () => {
    for (const width of [0.2, 0.45, 0.7, 0.9]) {
      const worst = worstPhaseAlpha(borderAlphaBeforeFix({ Width: width, Aa: 0, Fade: 0, Scale: 1 }));
      expect(worst, `width ${width}px used to be visible`).toBe(0);
    }
  });

  it('the old formula dropped the glass rim on its thin side', () => {
    // Peak alpha looked survivable (~0.59); the pixel grid told the truth.
    const before = worstPhaseAlpha(borderAlphaBeforeFix({ Width: 0.9, Aa: 0.6, Fade: 1.5, Scale: 0.5 }));
    const after = worstPhaseAlpha(borderAlpha({ Width: 0.9, Aa: 0.6, Fade: 1.5, Scale: 0.5 }, MIN));
    expect(after).toBeGreaterThan(before);
  });
});
