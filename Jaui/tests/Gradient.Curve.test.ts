/**
 * A colour gradient must ramp without a knee, mix where the eye mixes, and dither without crawling.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────────
 * The panel shader lerped straight sRGB between at most eight stops. Every stop was a slope break the
 * eye reads as an edge (Mach banding), a fade to black held its colour and then dropped, a colour to
 * transparent stop darkened on the way (straight alpha), and long ramps banded in 8 bits.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────────────────────────
 * Gradient.Curve fits a monotone cubic Hermite spline (Fritsch-Butland tangents, flat ends) through the
 * stops in premultiplied OKLab; the shader evaluates it and converts back to sRGB, and gradient fills add
 * half an 8-bit step of interleaved gradient noise tied to the framebuffer pixel.
 */
import { describe, it, expect } from 'vitest';
import {
  GradientCurveOf, SampleCurve, SampleCurvePremul, SampleCurveSlope, SrgbToOklab, SrgbToLinear, LinearToSrgb,
  GradientNoise, GRADIENT_DITHER_STEPS, GRADIENT_DITHER_ALPHA_FLOOR,
} from '../src/Core/Gradient.Curve';
import { ParseBackground } from '../src/Core/Background.Parse';
import { ParseProgressiveBlur } from '../src/ProgressiveBlur/ProgressiveBlur.Stops';
import { BLUR_EASE_SMOOTH, MAX_GRADIENT_STOPS, type GradientStop } from '../src/Jiv/Jiv.Types';
import {
  glslOklabToSrgb, tsOklabToSrgb, glslSampleGradient, glslNoise, tsNoise, glslDitherBranch, glslMaxStops,
  readWebGl2Renderer, readProgressiveBlurShader, coefficients,
} from './Gradient.Curve.Source';

type Rgba = [number, number, number, number];
const stop = (p: number, [r, g, b, a]: Rgba, easing = 1): GradientStop => ({ Position: p, Color: { R: r, G: g, B: b, A: a }, Easing: easing });

// The old dark hero foot: a deep teal accent walked to black, eight stops of alpha and share.
const TEAL: Rgba = [0.06, 0.28, 0.33, 1];
const mixTo = (c: Rgba, k: number, a: number): Rgba => [c[0] * (1 - k), c[1] * (1 - k), c[2] * (1 - k), a];
const HERO_FOOT = [
  stop(0.4, mixTo(TEAL, 0, 0)), stop(0.5, mixTo(TEAL, 0, 0.45)), stop(0.6, mixTo(TEAL, 0, 0.72)),
  stop(0.7, mixTo(TEAL, 0.08, 0.84)), stop(0.8, mixTo(TEAL, 0.2, 0.9)), stop(0.9, mixTo(TEAL, 0.4, 0.96)),
  stop(0.955, mixTo(TEAL, 0.65, 0.99)), stop(1, mixTo(TEAL, 1, 1)),
];

/** One-sided slopes of f just left and right of x. */
const slopes = (f: (t: number) => number, x: number, h = 1e-5): [number, number] =>
  [(f(x) - f(x - h)) / h, (f(x + h) - f(x)) / h];

/** Piecewise linear straight-sRGB alpha, the shader before the fix (the control). */
const linearAlpha = (stops: GradientStop[], t: number): number => {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].Position) {
      const a = stops[i - 1], b = stops[i];
      const u = (t - a.Position) / (b.Position - a.Position);
      return a.Color.A + (b.Color.A - a.Color.A) * u;
    }
  }
  return stops[stops.length - 1].Color.A;
};

const oklabL = (rgb: Rgba | [number, number, number]): number => SrgbToOklab(rgb[0], rgb[1], rgb[2])[0];

describe('the shader runs the curve Gradient.Curve fits', () => {
  it('OKLab to sRGB uses the same coefficients in GLSL and on the CPU', () => {
    const glsl = glslOklabToSrgb();
    expect(glsl.length).toBe(15);
    expect(glsl).toEqual(tsOklabToSrgb());
  });

  it('samples a cubic Hermite through value and tangent knots, premultiplied', () => {
    const src = glslSampleGradient().replace(/\s+/g, '');
    expect(src).toContain('(2.0*u3-3.0*u2+1.0)*u_BgGradValue[i-1]');
    expect(src).toContain('(u3-2.0*u2+u)*h*u_BgGradTangent[i-1]');
    expect(src).toContain('(-2.0*u3+3.0*u2)*u_BgGradValue[i]');
    expect(src).toContain('(u3-u2)*h*u_BgGradTangent[i]');
    expect(src).toContain('oklabToSrgb(v.rgb/a)');
    expect(src).not.toMatch(/mix\(/);
  });

  it('uploads the fitted knots, tangents and positions, and the shader cap matches the CPU cap', () => {
    const r = readWebGl2Renderer();
    expect(r).toMatch(/uniform4fv\(locs\.bgGradValue, curve\.Value\)/);
    expect(r).toMatch(/uniform4fv\(locs\.bgGradTangent, curve\.Tangent\)/);
    expect(glslMaxStops()).toBe(MAX_GRADIENT_STOPS);
    expect(MAX_GRADIENT_STOPS).toBeGreaterThanOrEqual(16);
  });
});

describe('the slope is continuous through every stop', () => {
  const curve = GradientCurveOf(HERO_FOOT.map((s) => ({ ...s })));
  const alpha = (t: number) => SampleCurvePremul(curve, t)[3];

  it('before: the linear lerp breaks slope at the stops (the control)', () => {
    const jumps = HERO_FOOT.slice(1, -1).map((s) => {
      const [l, r] = slopes((t) => linearAlpha(HERO_FOOT, t), s.Position);
      return Math.abs(l - r);
    });
    expect(Math.max(...jumps)).toBeGreaterThan(1.5);
  });

  it('after: left and right slopes agree at every interior stop, in alpha and in lightness', () => {
    for (const s of HERO_FOOT.slice(1, -1)) {
      const left = SampleCurveSlope(curve, s.Position - 1e-6);
      const right = SampleCurveSlope(curve, s.Position + 1e-6);
      for (const c of [3, 0]) expect(Math.abs(left[c] - right[c])).toBeLessThan(1e-3);
    }
  });

  it('the ramp starts and arrives flat, so it has no visible end', () => {
    expect(Math.abs(SampleCurveSlope(curve, 0.4 + 1e-6)[3])).toBeLessThan(1e-3);
    expect(Math.abs(SampleCurveSlope(curve, 1 - 1e-6)[3])).toBeLessThan(1e-3);
  });

  it('never overshoots: a rising alpha stays inside its stops', () => {
    for (let i = 0; i <= 600; i++) {
      const t = 0.4 + (0.6 * i) / 600;
      const a = alpha(t);
      expect(a).toBeGreaterThanOrEqual(-1e-6);
      expect(a).toBeLessThanOrEqual(1 + 1e-6);
      if (i > 0) expect(a).toBeGreaterThanOrEqual(alpha(t - 0.001) - 1e-6);
    }
  });

  it('an eased stop keeps the slope continuous and bends its segment along u^e', () => {
    const parsed = ParseBackground('LinearGradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 50% ease 2.4, rgba(0,0,0,0.2) 100%)');
    if (parsed.Kind !== 'LinearGradient') throw new Error('expected a linear gradient');
    expect(parsed.Stops.map((s) => s.Easing)).toEqual([1, 2.4, 1]);
    const eased = GradientCurveOf(parsed.Stops);
    expect(eased.Count).toBe(3 + 3);
    const a = (t: number) => SampleCurvePremul(eased, t)[3];
    for (let i = 1; i < eased.Count - 1; i++) {
      const p = eased.Position[i];
      expect(Math.abs(SampleCurveSlope(eased, p - 1e-6)[3] - SampleCurveSlope(eased, p + 1e-6)[3])).toBeLessThan(1e-3);
    }
    // Halfway down the eased segment the power curve has covered 0.5^2.4 of the drop.
    expect(a(0.75)).toBeCloseTo(1 - 0.8 * Math.pow(0.5, 2.4), 2);
  });
});

describe('colour mixes in OKLab, premultiplied', () => {
  const run = (from: Rgba, to: Rgba) => GradientCurveOf([stop(0, from), stop(1, to)]);

  it('accent to black: the midpoint is half the lightness, not crushed and not held', () => {
    const accent: Rgba = [0.2, 0.55, 0.62, 1];
    const mid = SampleCurve(run(accent, [0, 0, 0, 1]), 0.5);
    const ratio = oklabL(mid) / oklabL(accent);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
    // Linear light holds the colour to 79% lightness at the midpoint, then drops it into black (the control).
    const lin = accent.slice(0, 3).map((c) => LinearToSrgb(SrgbToLinear(c) * 0.5)) as [number, number, number];
    expect(oklabL(lin) / oklabL(accent)).toBeGreaterThan(0.75);
  });

  it('accent to black: the last tenth of the run carries a small, even share of the darkening', () => {
    const accent: Rgba = [0.2, 0.55, 0.62, 1];
    const curve = run(accent, [0, 0, 0, 1]);
    const share = oklabL(SampleCurve(curve, 0.9)) / oklabL(accent);
    expect(share).toBeLessThan(0.05);
  });

  it('accent to white keeps its hue and never greys below either end', () => {
    const accent: Rgba = [0.85, 0.62, 0.1, 1];
    const curve = run(accent, [1, 1, 1, 1]);
    const [, a0, b0] = SrgbToOklab(accent[0], accent[1], accent[2]);
    const hue0 = Math.atan2(b0, a0);
    for (const t of [0.25, 0.5, 0.75]) {
      const [r, g, b] = SampleCurve(curve, t);
      const [L, a, bb] = SrgbToOklab(r, g, b);
      expect(Math.abs(Math.atan2(bb, a) - hue0)).toBeLessThan(0.02);
      expect(L).toBeGreaterThanOrEqual(oklabL(accent) - 1e-3);
    }
  });

  it('a colour fading to transparent keeps its colour instead of darkening', () => {
    const accent: Rgba = [0.9, 0.5, 0.2, 1];
    const [r, g, b, a] = SampleCurve(run(accent, [0, 0, 0, 0]), 0.5);
    expect(a).toBeCloseTo(0.5, 5);
    expect(r).toBeCloseTo(accent[0], 3);
    expect(g).toBeCloseTo(accent[1], 3);
    expect(b).toBeCloseTo(accent[2], 3);
  });

  it('more stops than the cap resample to the cap', () => {
    const many = Array.from({ length: 30 }, (_, i) => stop(i / 29, [i / 29, 0, 0, 1]));
    expect(GradientCurveOf(many).Count).toBe(MAX_GRADIENT_STOPS);
  });
});

describe('gradient dither is bounded and stable', () => {
  const branch = glslDitherBranch().replace(/\s+/g, '');

  it('noise constants agree between GLSL and the CPU mirror', () => {
    expect(coefficients(glslNoise())).toEqual(coefficients(tsNoise()));
  });

  it('is tied to the framebuffer pixel only: no time, no animated input', () => {
    expect(branch).toContain('gradientNoise(floor(gl_FragCoord.xy))');
    expect(branch).not.toMatch(/u_Time|v_PixelPos|u_Frame/);
  });

  it('the shader scale is the declared half step and alpha floor', () => {
    expect(branch).toContain(`-${GRADIENT_DITHER_STEPS})/255.0`);
    expect(branch).toContain(`max(result.a,${GRADIENT_DITHER_ALPHA_FLOOR})`);
  });

  it('on screen it never exceeds half an 8-bit step, averages to zero and fills the range', () => {
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const noise = (GradientNoise(x, y) - GRADIENT_DITHER_STEPS) / 255;
        for (const alpha of [0.02, 0.25, 0.6, 1]) {
          const onScreen = alpha * (noise / Math.max(alpha, GRADIENT_DITHER_ALPHA_FLOOR));
          min = Math.min(min, onScreen);
          max = Math.max(max, onScreen);
        }
        sum += noise;
        n++;
      }
    }
    expect(max).toBeLessThanOrEqual(0.5 / 255);
    expect(min).toBeGreaterThanOrEqual(-0.5 / 255);
    expect(max * 255).toBeGreaterThan(0.45);
    expect(Math.abs(sum / n) * 255).toBeLessThan(0.01);
    // The same pixel reads the same noise every frame.
    expect(GradientNoise(137, 911)).toBe(GradientNoise(137, 911));
  });
});

describe('a progressive blur segment can ease smooth', () => {
  it('parses `ease smooth` to the smooth sentinel, the shader runs smootherstep on it and the upload keeps it', () => {
    const spec = ParseProgressiveBlur('LinearGradient(180deg, 0 0%, 0 50% ease smooth, 1 84%, 1 100%)');
    expect(spec?.Stops.map((s) => s.Easing)).toEqual([1, BLUR_EASE_SMOOTH, 1, 1]);
    const shader = readProgressiveBlurShader().replace(/\s+/g, '');
    expect(shader).toContain('u_StopEase[i]<=0.0?seg*seg*seg*(seg*(seg*6.0-15.0)+10.0):pow(seg,u_StopEase[i])');
    expect(readWebGl2Renderer()).toMatch(/Easing <= BLUR_EASE_SMOOTH \? BLUR_EASE_SMOOTH/);
  });

  it('smootherstep leaves and arrives flat', () => {
    const s = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
    expect((s(1e-4) - s(0)) / 1e-4).toBeLessThan(1e-6);
    expect((s(1) - s(1 - 1e-4)) / 1e-4).toBeLessThan(1e-6);
  });
});
