import type { GradientStop } from '../Jiv/Jiv.Types';
import { MAX_GRADIENT_STOPS } from '../Jiv/Jiv.Types';

/**
 * A colour gradient as the panel shader evaluates it: knots in premultiplied OKLab plus a tangent per
 * knot, read as a cubic Hermite spline.
 *
 * OKLab, because its L is perceived lightness: an even step in the curve is an even step to the eye, so
 * accent to black darkens steadily instead of holding and then dropping into black (linear light), and
 * light to white never greys or shifts hue. Premultiplied, so a transparent stop lends no colour.
 *
 * Tangents are monotone (Fritsch-Butland harmonic mean): the slope is continuous through every stop, so
 * there is no knee, and no channel overshoots its neighbours, so alpha never rings past a stop. The ends
 * are flat, matching the constant colour a gradient holds beyond them, so the ramp arrives with zero slope.
 *
 * A stop's `Easing` bends the segment to the next stop along u^e; it is laid down as extra knots before the
 * tangents are fitted, so an eased gradient keeps the same continuous slope.
 */
export interface GradientCurve {
  Count: number;
  Position: Float32Array;
  /** Premultiplied OKLab + alpha per knot: L*a, a*a, b*a, a. */
  Value: Float32Array;
  /** d(Value)/d(position) per knot. */
  Tangent: Float32Array;
}

/** Knots an eased segment is laid down with, between its two stops. */
const EASE_KNOTS = 3;

export const SrgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

export const LinearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** Straight sRGB (0..1) to OKLab. */
export const SrgbToOklab = (r: number, g: number, b: number): [number, number, number] => {
  const lr = SrgbToLinear(r), lg = SrgbToLinear(g), lb = SrgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
};

/** OKLab to straight sRGB (0..1), clamped into gamut. Mirrors `oklabToSrgb` in Jiv.Panel.frag. */
export const OklabToSrgb = (L: number, a: number, b: number): [number, number, number] => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const enc = (v: number) => LinearToSrgb(Math.min(1, Math.max(0, v)));
  return [
    enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    enc(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
};

interface Knot { P: number; V: [number, number, number, number] }

const _premul = (s: GradientStop): Knot['V'] => {
  const [L, a, b] = SrgbToOklab(s.Color.R, s.Color.G, s.Color.B);
  const A = s.Color.A;
  return [L * A, a * A, b * A, A];
};

// Monotone cubic tangents per channel: zero at the ends, at hard stops and at local extrema.
const _tangents = (knots: Knot[]): Knot['V'][] => {
  const n = knots.length;
  const out: Knot['V'][] = knots.map(() => [0, 0, 0, 0]);
  for (let k = 1; k < n - 1; k++) {
    const h0 = knots[k].P - knots[k - 1].P;
    const h1 = knots[k + 1].P - knots[k].P;
    if (h0 <= 0 || h1 <= 0) continue;
    for (let c = 0; c < 4; c++) {
      const d0 = (knots[k].V[c] - knots[k - 1].V[c]) / h0;
      const d1 = (knots[k + 1].V[c] - knots[k].V[c]) / h1;
      if (d0 * d1 <= 0) continue;
      out[k][c] = (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1);
    }
  }
  return out;
};

const _hermite = (p0: number, v0: number, m0: number, p1: number, v1: number, m1: number, t: number): number => {
  const h = p1 - p0;
  if (h <= 0) return v1;
  const u = (t - p0) / h;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * h * m1;
};

const _hermiteSlope = (p0: number, v0: number, m0: number, p1: number, v1: number, m1: number, t: number): number => {
  const h = p1 - p0;
  if (h <= 0) return 0;
  const u = (t - p0) / h;
  const u2 = u * u;
  return ((6 * u2 - 6 * u) * v0 + (3 * u2 - 4 * u + 1) * h * m0 + (-6 * u2 + 6 * u) * v1 + (3 * u2 - 2 * u) * h * m1) / h;
};

/** The knot list with eased segments laid down, within the stop cap. */
const _knots = (stops: GradientStop[]): Knot[] => {
  const eased = stops.slice(0, -1).filter((s) => (s.Easing ?? 1) !== 1).length;
  const room = eased > 0 ? Math.floor((MAX_GRADIENT_STOPS - stops.length) / eased) : 0;
  const perSegment = Math.max(0, Math.min(EASE_KNOTS, room));
  const knots: Knot[] = [];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const v = _premul(s);
    knots.push({ P: s.Position, V: v });
    const e = s.Easing ?? 1;
    const next = stops[i + 1];
    if (!next || e === 1 || perSegment === 0 || next.Position <= s.Position) continue;
    const w = _premul(next);
    for (let k = 1; k <= perSegment; k++) {
      const u = k / (perSegment + 1);
      const f = Math.pow(u, e);
      knots.push({
        P: s.Position + (next.Position - s.Position) * u,
        V: [v[0] + (w[0] - v[0]) * f, v[1] + (w[1] - v[1]) * f, v[2] + (w[2] - v[2]) * f, v[3] + (w[3] - v[3]) * f],
      });
    }
  }
  return knots;
};

/** Fit the shader's curve to sorted, normalized stops. */
export const GradientCurveOf = (stops: GradientStop[]): GradientCurve => {
  let knots = _knots(stops);
  let tangents = _tangents(knots);
  if (knots.length > MAX_GRADIENT_STOPS) {
    // Too many authored stops: resample the fitted curve, keeping its value and slope at each new knot.
    const full = { Count: knots.length, Position: new Float32Array(knots.map((k) => k.P)),
      Value: new Float32Array(knots.flatMap((k) => k.V)), Tangent: new Float32Array(tangents.flat()) };
    const p0 = knots[0].P, p1 = knots[knots.length - 1].P;
    knots = [];
    tangents = [];
    for (let i = 0; i < MAX_GRADIENT_STOPS; i++) {
      const t = p0 + ((p1 - p0) * i) / (MAX_GRADIENT_STOPS - 1);
      knots.push({ P: t, V: SampleCurvePremul(full, t) });
      tangents.push(SampleCurveSlope(full, t));
    }
  }
  const count = knots.length;
  const curve: GradientCurve = {
    Count: count,
    Position: new Float32Array(MAX_GRADIENT_STOPS),
    Value: new Float32Array(MAX_GRADIENT_STOPS * 4),
    Tangent: new Float32Array(MAX_GRADIENT_STOPS * 4),
  };
  for (let i = 0; i < count; i++) {
    curve.Position[i] = knots[i].P;
    for (let c = 0; c < 4; c++) {
      curve.Value[i * 4 + c] = knots[i].V[c];
      curve.Tangent[i * 4 + c] = tangents[i][c];
    }
  }
  return curve;
};

const _segment = (curve: GradientCurve, t: number): number => {
  for (let i = 1; i < curve.Count; i++) if (t <= curve.Position[i]) return i;
  return -1;
};

/** Premultiplied OKLab + alpha at t. Mirrors `sampleBgGradient` in Jiv.Panel.frag. */
export const SampleCurvePremul = (curve: GradientCurve, t: number): [number, number, number, number] => {
  const V = curve.Value, M = curve.Tangent, P = curve.Position;
  const at = (i: number): [number, number, number, number] => [V[i * 4], V[i * 4 + 1], V[i * 4 + 2], V[i * 4 + 3]];
  if (curve.Count === 0) return [0, 0, 0, 0];
  if (curve.Count === 1 || t <= P[0]) return at(0);
  const i = _segment(curve, t);
  if (i < 0) return at(curve.Count - 1);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    out[c] = _hermite(P[i - 1], V[(i - 1) * 4 + c], M[(i - 1) * 4 + c], P[i], V[i * 4 + c], M[i * 4 + c], t);
  }
  return out;
};

/** d(premultiplied value)/dt at t. */
export const SampleCurveSlope = (curve: GradientCurve, t: number): [number, number, number, number] => {
  const V = curve.Value, M = curve.Tangent, P = curve.Position;
  if (curve.Count < 2 || t <= P[0]) return [0, 0, 0, 0];
  const i = _segment(curve, t);
  if (i < 0) return [0, 0, 0, 0];
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    out[c] = _hermiteSlope(P[i - 1], V[(i - 1) * 4 + c], M[(i - 1) * 4 + c], P[i], V[i * 4 + c], M[i * 4 + c], t);
  }
  return out;
};

/** Straight sRGB + alpha at t, as the panel paints it before dither. */
export const SampleCurve = (curve: GradientCurve, t: number): [number, number, number, number] => {
  const [pl, pa, pb, A] = SampleCurvePremul(curve, t);
  const alpha = Math.min(1, Math.max(0, A));
  if (alpha < 1e-4) return [0, 0, 0, 0];
  const [r, g, b] = OklabToSrgb(pl / alpha, pa / alpha, pb / alpha);
  return [r, g, b, alpha];
};

/** Dither on a gradient fill, in 8-bit steps on screen: the noise spans ±half a step. */
export const GRADIENT_DITHER_STEPS = 0.5;
/** The fill alpha the dither's premultiplied compensation stops dividing by. */
export const GRADIENT_DITHER_ALPHA_FLOOR = 0.25;

/** Interleaved gradient noise at an integer screen pixel, in [0, 1). Mirrors `gradientNoise` in the shader. */
export const GradientNoise = (x: number, y: number): number => {
  const f = (v: number) => v - Math.floor(v);
  return f(52.9829189 * f(x * 0.06711056 + y * 0.00583715));
};
