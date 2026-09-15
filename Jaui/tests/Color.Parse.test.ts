/**
 * rgb() channels are CSS numbers: 0 to 255, or a percentage.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────────
 * The parser guessed the scale: when no channel was above 1 it read the channels as 0 to 1. A ramp
 * into black rounds to near-black stops such as rgba(1, 0, 0, 1), which it read as pure red, so the
 * hero foot's fade to black drew a full-width band of bright red or blue at that stop.
 */
import { describe, it, expect } from 'vitest';
import { ParseColor } from '../src/Core/Color.Parse';
import { ParseBackground } from '../src/Core/Background.Parse';
import { GradientCurveOf, SampleCurve, SrgbToOklab } from '../src/Core/Gradient.Curve';

describe('rgb() channels are 0 to 255', () => {
  it('a near-black channel of 1 is one 8-bit step, not full', () => {
    expect(ParseColor('rgba(1, 0, 0, 1)')).toEqual({ R: 1 / 255, G: 0, B: 0, A: 1 });
    expect(ParseColor('rgb(0, 0, 1)')).toEqual({ R: 0, G: 0, B: 1 / 255, A: 1 });
    expect(ParseColor('rgba(1, 1, 1, 0.5)')).toEqual({ R: 1 / 255, G: 1 / 255, B: 1 / 255, A: 0.5 });
  });

  it('reads percentages, space separators and a slash alpha as CSS does', () => {
    expect(ParseColor('rgb(100% 50% 0%)')).toEqual({ R: 1, G: 0.5, B: 0, A: 1 });
    expect(ParseColor('rgb(255 128 0 / 50%)')).toEqual({ R: 1, G: 128 / 255, B: 0, A: 0.5 });
    expect(ParseColor('rgba(255, 255, 255, 0)')).toEqual({ R: 1, G: 1, B: 1, A: 0 });
  });

  it('clamps channels and alpha into range', () => {
    expect(ParseColor('rgba(300, -4, 128, 1.5)')).toEqual({ R: 1, G: 0, B: 128 / 255, A: 1 });
  });
});

describe('a fade to black never brightens', () => {
  // The dark hero foot on the "Right Now" slide (#3b82f6): its knots round to rgba(0, 0, 1, 1) near the end.
  const FOOT = 'LinearGradient(180deg, rgba(28, 61, 116, 0) 30.0%, rgba(28, 61, 116, 0.156) 34.7%, rgba(28, 61, 116, 0.401) 39.3%, '
    + 'rgba(28, 61, 116, 0.625) 44.0%, rgba(28, 61, 115, 0.789) 48.7%, rgba(27, 60, 113, 0.892) 53.3%, rgba(26, 56, 107, 0.949) 58.0%, '
    + 'rgba(23, 50, 95, 0.978) 62.7%, rgba(19, 42, 80, 0.991) 67.3%, rgba(15, 32, 61, 0.997) 72.0%, rgba(10, 23, 43, 0.999) 76.7%, '
    + 'rgba(6, 14, 26, 1) 81.3%, rgba(3, 7, 13, 1) 86.0%, rgba(1, 2, 4, 1) 90.7%, rgba(0, 0, 1, 1) 95.3%, rgba(0, 0, 0, 1) 100.0%)';

  it('lightness only falls across the opaque tail', () => {
    const bg = ParseBackground(FOOT);
    if (bg.Kind !== 'LinearGradient') throw new Error('expected a linear gradient');
    const curve = GradientCurveOf(bg.Stops);
    let previous = Infinity;
    for (let i = 0; i <= 400; i++) {
      const t = 0.8 + (0.2 * i) / 400;
      const [r, g, b] = SampleCurve(curve, t);
      const L = SrgbToOklab(r, g, b)[0];
      expect(L).toBeLessThanOrEqual(previous + 1e-4);
      expect(Math.max(r, g, b)).toBeLessThan(0.12);
      previous = L;
    }
  });
});
