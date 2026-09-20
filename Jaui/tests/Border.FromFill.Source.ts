/**
 * Lane borderfromfill: WHAT THE BORDER BAND SHOWS ON EACH ARM, computed rather than eyeballed.
 *
 * `?border-source=fill` is a PICTURE flag, and the one thing a lane that cannot run a browser owes
 * the person who rules on the images is a number they can check the screenshot against. This file
 * is the CPU port of the one path a border-only fragment takes in `Jiv.Panel.frag` -- the border
 * zone, from `bSample` to the `borderRgb` that reaches the frame -- so the two arms can be
 * evaluated over `glass-grid`'s real bed and the delta stated before anyone shoots it.
 *
 * It is a port of the SHADER and nothing else: `applyGrading` and `applyTint` are transcribed from
 * `Jiv.Panel.frag` (727-739), the Fresnel chain from its border zone (1690-1716), and the numbers
 * are `Jwift.Glass.jss`'s `JwiftGlass` under `@Dark` -- which is what `PerfCard` extends and what
 * every screenshot in this ledger is taken in (headless Playwright defaults to LIGHT; the harness
 * pins dark).
 *
 * WHAT IT DOES NOT MODEL, named rather than buried: the bezel's refracted displacement. Today's rim
 * gathers a blur of the card's own REFRACTED face, and the fill's pyramid holds the bed undisplaced.
 * At the outline that displacement is at its largest (`Thickness x Refraction` = 40 device px of
 * reach at dpr 2) and it moves WHICH bed texel the face showed, not how it was graded. So the grade
 * chain below is the SYSTEMATIC term and the displacement is a per-pixel scatter on top of it; the
 * lane predicts the first and says plainly that it cannot predict the second.
 */

export interface Rgb { R: number; G: number; B: number }

const LUMA = { R: 0.2126, G: 0.7152, B: 0.0722 };
const _dot = (c: Rgb): number => c.R * LUMA.R + c.G * LUMA.G + c.B * LUMA.B;
const _clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const _map = (c: Rgb, f: (v: number) => number): Rgb => ({ R: f(c.R), G: f(c.G), B: f(c.B) });
const _mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  ({ R: a.R + (b.R - a.R) * t, G: a.G + (b.G - a.G) * t, B: a.B + (b.B - a.B) * t });
const WHITE: Rgb = { R: 1, G: 1, B: 1 };

/** `Jiv.Panel.frag:727` -- contrast about 0.5, saturation about luma, then brightness. */
export const ApplyGrading = (
  c: Rgb, brightness: number, saturation: number, contrast: number,
): Rgb => {
  const k = _map(c, (v) => (v - 0.5) * contrast + 0.5);
  const luma = _dot(k);
  const s: Rgb = {
    R: luma + (k.R - luma) * saturation,
    G: luma + (k.G - luma) * saturation,
    B: luma + (k.B - luma) * saturation,
  };
  return _map(s, (v) => v * brightness);
};

/** `Jiv.Panel.frag:737` -- a mix toward black (tint < 0) or white (tint > 0) by |tint|. */
export const ApplyTint = (c: Rgb, tint: number): Rgb => {
  const target = tint >= 0 ? 1 : 0;
  return _map(c, (v) => v + (target - v) * Math.abs(tint));
};

/** `page-protocol.js:44` -- the bed's own HSL to RGB, so the colours here are the colours shot. */
export const Hsl = (h: number, s: number, l: number): Rgb => {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = L - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; } else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  // `page-protocol.js` rounds to 8 bits here and Jaui parses that byte back, so the port rounds too.
  const q = (v: number): number => Math.round((v + m) * 255) / 255;
  return { R: q(r), G: q(g), B: q(b) };
};

/** `page-protocol.js:101` and its band loop: six bands, each a two-stop gradient. */
export const HUES = [4, 28, 52, 96, 140, 172, 200, 226, 258, 292, 318, 344];
export const BED_BANDS = 6;

/** Every endpoint colour the `glass-grid` bed is built from, in band order. */
export const BedStops = (): Rgb[] => {
  const out: Rgb[] = [];
  for (let i = 0; i < BED_BANDS; i++) {
    out.push(Hsl(HUES[(i * 2 + 1) % HUES.length], 92, 52));
    out.push(Hsl(HUES[(i * 2 + 5) % HUES.length], 88, 22));
  }
  return out;
};

/** `JwiftGlass` under `@Dark`, as `PerfCard` inherits it. Every number is from `Jwift.Glass.jss`. */
export const JWIFT_GLASS_DARK = {
  /** `BackdropFilter: Blur(4pt) Saturate(@JwiftControlSaturate) Contrast(@JwiftControlContrast)`. */
  Brightness: 1,
  Saturation: 1.6,
  Contrast: 0.6,
  /** `Tint: @JwiftControlTint` = 0.45 with `TintTone: Ground`, which under `@Dark` resolves
   *  NEGATIVE (`Style.Resolver._resolveTint`): a pull toward black by 0.45. */
  BodyTint: -0.45,
  /** `BorderFilter: Blur(-0.5pt) Brightness(1.4)` -- no `Saturate()`, so the multiplier is 1. */
  BorderBrightness: 1.4,
  BorderSaturation: 1,
  BorderContrast: 1,
  /** `BorderColor: rgba(255, 255, 255, 0.35)`. */
  BorderColor: WHITE,
  BorderColorAlpha: 0.35,
  BorderAlphaVariance: 0.75,
  /** `BorderFresnelStrength: @JwiftRimCarry` = 1. */
  BorderFresnelStrength: 1,
  /** `BorderFresnelFilter` is unset on this class, so `Jiv.Defaults`' `Brightness(1) Saturate(1.6)`. */
  BorderFresnelBrightness: 1,
  BorderFresnelSaturation: 1.6,
};

export type Glass = typeof JWIFT_GLASS_DARK;

/** The glass FILL's own output over a backdrop sample: grade, then tint. `Jiv.Panel.frag:1273`. */
export const FillFace = (backdrop: Rgb, g: Glass): Rgb =>
  ApplyTint(ApplyGrading(backdrop, g.Brightness, g.Saturation, g.Contrast), g.BodyTint);

const _smoothstep = (e0: number, e1: number, x: number): number => {
  const t = _clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * The border zone's output, from the backdrop sample it was handed.
 *
 * `lightFacing` is `max(alignment, 0)`: 1 at the point of the rim facing `LightAngle`, 0 over the
 * far half. Both ends are evaluated, because the Fresnel rides `pow(lightFacing, 3)` and two arms
 * can only be compared where the same fragment is compared.
 */
export const BorderRgb = (bSample: Rgb, lightFacing: number, g: Glass): Rgb => {
  const borderBackdrop = ApplyTint(ApplyGrading(
    bSample,
    g.Brightness * g.BorderBrightness,
    g.Saturation * g.BorderSaturation,
    g.Contrast * g.BorderContrast,
  ), g.BodyTint);
  const gather = _map(borderBackdrop, _clamp01);
  const gatherHi = Math.max(gather.R, gather.G, gather.B);
  const gatherLo = Math.min(gather.R, gather.G, gather.B);
  let hued = _map(gather, (v) => v / Math.max(gatherHi, 0.001));
  hued = _map(_mix(WHITE, hued, g.BorderFresnelSaturation), _clamp01);
  const rimCarry = _smoothstep(0, 0.18, gatherHi - gatherLo) * _smoothstep(0.015, 0.09, gatherHi);
  const fresnelTarget = _map(
    _map(_mix(WHITE, hued, rimCarry), (v) => v * g.BorderFresnelBrightness), _clamp01);
  const strokeTint = _mix(g.BorderColor, fresnelTarget,
    Math.pow(lightFacing, 3) * g.BorderFresnelStrength);
  const alphaFloor = 1 - g.BorderAlphaVariance;
  const strokeBrightness = alphaFloor + (1 - alphaFloor) * Math.pow(lightFacing, 2);
  return _mix(borderBackdrop, strokeTint, g.BorderColorAlpha * strokeBrightness);
};

/**
 * WHAT EACH ARM HANDS THE BORDER ZONE as `bSample`, at a fragment ON the outline.
 *
 * `fill`: the fill's own pyramid, i.e. the blurred BED. Exactly that, no model in it.
 *
 * `scene`: a blur of the scene AFTER the fill drew. The tap is the fragment's own screen UV
 * (`solidness` is 0 for `Refraction: 8`, so `bUv == straightUv`), and the kernel at the outline
 * straddles it: `outsideShare` of it lands on raw bed and the rest on the card's graded face. That
 * share is 0.5 at the outline by symmetry of a kernel centred on it, and 0 for a tap far enough
 * inside to see only the face. Both are evaluated; the truth is between them, and the lane says so
 * rather than picking one and calling it the answer.
 */
export const BSample = (
  bed: Rgb, arm: 'fill' | 'scene', outsideShare: number, g: Glass,
): Rgb => (arm === 'fill' ? bed : _mix(FillFace(bed, g), bed, outsideShare));

/** Largest 8-bit channel distance, which is what a pixel diff counts. */
export const Delta8 = (a: Rgb, b: Rgb): number => Math.max(
  Math.abs(Math.round(a.R * 255) - Math.round(b.R * 255)),
  Math.abs(Math.round(a.G * 255) - Math.round(b.G * 255)),
  Math.abs(Math.round(a.B * 255) - Math.round(b.B * 255)));

/** Signed 8-bit luma change, `fill` minus `scene`: negative means the band reads DARKER. */
export const LumaDelta8 = (a: Rgb, b: Rgb): number => (_dot(a) - _dot(b)) * 255;

/** The mean and max of a list, so a test and a report quote the same two numbers. */
export const Stats = (xs: readonly number[]): { Mean: number; Max: number; Min: number } => ({
  Mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  Max: Math.max(...xs),
  Min: Math.min(...xs),
});
