/**
 * A CPU PORT OF THE FOUR HOPS AND OF THE CONSUMER'S READ, for one question:
 * what does `?glass-presample` do to the picture?
 *
 * The claim it exists to settle is narrow. `PresamplePlanFor` argues, from the phase
 * and the tap offset alone, that a presampled build's first three hops ARE the unflagged build's
 * first three hops; if that is right then the only thing left to compare is the LAST 2x
 * reconstruction, which is the pyramid's 8-tap tent hop on one arm and the consumer's hardware
 * bilinear on the other. This file lets that be computed rather than asserted.
 *
 * WHAT IT MODELS, exactly: `DOWN_FRAG` and `UP_FRAG` transcribed tap for tap and weight for
 * weight from `Core/BlurPass.ts`, over a GL bilinear fetch with CLAMP_TO_EDGE, in float64.
 * `u_SrcRect` is the identity here, which is what it is for every hop but the first -- and the
 * first hop's rect maps the destination's unit quad onto the region, so working REGION-LOCAL is
 * that same map with the region as the whole source.
 *
 * WHAT IT DOES NOT MODEL, said plainly: fp32 rounding, the RGB10_A2 store between levels, and
 * the GPU's own bilinear weight quantisation. It answers what the two KERNELS are, which is the
 * picture question; it does not predict the last bit of a shot. The arms' shared prefix is
 * proved here in exact arithmetic and is bit-identical on the GPU for a separate reason -- same
 * program, same uniforms, same source -- which `Glass.Presample.test.ts` pins against the source.
 */

const clampi = (i: number, n: number): number => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);

/** GL bilinear with CLAMP_TO_EDGE. `x`/`y` in texel units: texel `i`'s centre is `i + 0.5`. */
export const Tap = (img: Float64Array, W: number, H: number, x: number, y: number): number => {
  const fx = x - 0.5, fy = y - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const ax = fx - i0, ay = fy - j0;
  const g = (i: number, j: number): number => img[clampi(j, H) * W + clampi(i, W)];
  return g(i0, j0) * (1 - ax) * (1 - ay) + g(i0 + 1, j0) * ax * (1 - ay)
    + g(i0, j0 + 1) * (1 - ax) * ay + g(i0 + 1, j0 + 1) * ax * ay;
};

export interface KernelImage { Data: Float64Array; W: number; H: number }

/** `DOWN_FRAG` at `u_Offset = t`, into a destination half the source's size. */
export const Down = (src: Float64Array, W: number, H: number, t: number): KernelImage => {
  const dw = Math.max(1, Math.floor(W / 2)), dh = Math.max(1, Math.floor(H / 2));
  const out = new Float64Array(dw * dh);
  const h = 0.5 * t;                                   // u_HalfPixel * u_Offset, in SOURCE texels
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      const x = ((i + 0.5) / dw) * W, y = ((j + 0.5) / dh) * H;
      let s = Tap(src, W, H, x, y) * 4;
      s += Tap(src, W, H, x - h, y - h);
      s += Tap(src, W, H, x + h, y + h);
      s += Tap(src, W, H, x + h, y - h);
      s += Tap(src, W, H, x - h, y + h);
      out[j * dw + i] = s / 8;
    }
  }
  return { Data: out, W: dw, H: dh };
};

/** `UP_FRAG` at `u_Offset = t`, into a destination of the caller's size. */
export const Up = (
  src: Float64Array, W: number, H: number, dw: number, dh: number, t: number,
): KernelImage => {
  const out = new Float64Array(dw * dh);
  const h = 0.5 * t;
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      const x = ((i + 0.5) / dw) * W, y = ((j + 0.5) / dh) * H;
      let s = Tap(src, W, H, x - h * 2, y);
      s += Tap(src, W, H, x - h, y + h) * 2;
      s += Tap(src, W, H, x, y + h * 2);
      s += Tap(src, W, H, x + h, y + h) * 2;
      s += Tap(src, W, H, x + h * 2, y);
      s += Tap(src, W, H, x + h, y - h) * 2;
      s += Tap(src, W, H, x, y - h * 2);
      s += Tap(src, W, H, x - h, y - h) * 2;
      out[j * dw + i] = s / 12;
    }
  }
  return { Data: out, W: dw, H: dh };
};

/** THE CONSUMER'S READ. A glass fragment at device pixel centre `p` maps through `LastRegion`
 *  to region UV `(p - rect.X + 0.5) / rect.W`, so on a level 0 of `W x H` standing for a rect of
 *  `dw x dh` device px the texel coordinate is `(i + 0.5) * W / dw` -- one hardware bilinear. At
 *  `W === dw` (today's arm) every tap lands exactly on a texel centre and this is the identity. */
export const Consume = (
  src: Float64Array, W: number, H: number, dw: number, dh: number,
): KernelImage => {
  const out = new Float64Array(dw * dh);
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      out[j * dw + i] = Tap(src, W, H, ((i + 0.5) / dw) * W, ((j + 0.5) / dh) * H);
    }
  }
  return { Data: out, W: dw, H: dh };
};

/** TODAY: `k = 1, depth = 2`. Four hops, level 0 at the region's own device density. */
export const ArmK1 = (src: Float64Array, W: number, H: number, t: number): {
  Out: Float64Array; Mid: KernelImage;
} => {
  const l1 = Down(src, W, H, t);
  const l2 = Down(l1.Data, l1.W, l1.H, t);
  const mid = Up(l2.Data, l2.W, l2.H, l1.W, l1.H, t);     // the level-1 intermediate
  const l0 = Up(mid.Data, mid.W, mid.H, W, H, t);
  return { Out: Consume(l0.Data, W, H, W, H).Data, Mid: mid };
};

/** UNDER THE FLAG: `k = 2, depth = 1`. A pre-pass at the chain's OWN tap offset, then two hops,
 *  and level 0 comes back at half resolution for the consumer's bilinear to magnify. */
export const ArmK2 = (src: Float64Array, W: number, H: number, t: number): {
  Out: Float64Array; L0: KernelImage;
} => {
  const pre = Down(src, W, H, t);
  const l1 = Down(pre.Data, pre.W, pre.H, t);
  const l0 = Up(l1.Data, l1.W, l1.H, pre.W, pre.H, t);
  return { Out: Consume(l0.Data, l0.W, l0.H, W, H).Data, L0: l0 };
};

/** Max, mean and the count at or over one 8-bit level, over two images of equal length. */
export const Deviation = (a: Float64Array, b: Float64Array): {
  Max: number; Mean: number; Over1: number;
} => {
  let max = 0, sum = 0, over = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    sum += d;
    if (d >= 1) over++;
  }
  return { Max: max, Mean: sum / a.length, Over1: over };
};

/** The stencil ONE output pixel of an operator reads, as `[di, dj, weight]` over the source. The
 *  two reconstructions are periodic in 2x2, so the parity of the output pixel is a parameter. */
export const Stencil = (
  op: 'tent' | 'bilinear', t: number, phaseI: number, phaseJ: number, reach = 4,
): [number, number, number][] => {
  const W = 33, H = 33, C = 16;
  const out: [number, number, number][] = [];
  for (let dj = -reach; dj <= reach; dj++) {
    for (let di = -reach; di <= reach; di++) {
      const d = new Float64Array(W * H);
      d[(C + dj) * W + (C + di)] = 1;
      const o = op === 'tent'
        ? Up(d, W, H, W * 2, H * 2, t).Data
        : Consume(d, W, H, W * 2, H * 2).Data;
      const w = o[(C * 2 + phaseJ) * (W * 2) + (C * 2 + phaseI)];
      if (Math.abs(w) > 1e-15) out.push([di, dj, w]);
    }
  }
  return out;
};

// -- THE SEEDED BED, rastered where the harness puts it ---------------------------------------
// `page-protocol.js`'s `GlassGrid()` bands, reproduced from the same seed and the same mulberry32,
// because "the deviation on the seeded bed" has to be the bed the shot will be taken of and not a
// stand-in. Six bands of 1300/6 CSS px over an 1800x1300 bed at (-240, -200), dpr 2, each a CSS
// `linear-gradient(Adeg, From, To)` interpolated in sRGB -- the legacy interpolation both columns
// use. What is NOT reproduced: Jaui's grading and its gradient dither, which move a code by at
// most one and are applied to BOTH arms identically.

const SEED = 0x5f3759df;
const Rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const Hsl = (h: number, s: number, l: number): number[] => {
  const S = s / 100, L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = L - c / 2;
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  return [r, g, b].map((v) => Math.round((v + m) * 255));
};
const HUES = [4, 28, 52, 96, 140, 172, 200, 226, 258, 292, 318, 344];

export const BED_BANDS = ((): { Angle: number; From: number[]; To: number[] }[] => {
  const r = Rng(SEED ^ 0x11);
  for (let i = 0; i < 20; i++) r();               // the twenty cards' `Tone` draws come first
  return Array.from({ length: 6 }, (_, i) => ({
    Angle: 120 + Math.round(r() * 120),
    From: Hsl(HUES[(i * 2 + 1) % 12], 92, 52),
    To: Hsl(HUES[(i * 2 + 5) % 12], 88, 22),
  }));
})();

const DPR = 2;
const BED_W = 1800 * DPR, BAND_H = (1300 / 6) * DPR, BED_X = -240 * DPR, BED_Y = -200 * DPR;

/** One channel of the bed over a device-px rect of the SCREEN, y from the TOP. */
export const BedTile = (
  x0: number, y0: number, w: number, h: number, ch: number,
): Float64Array => {
  const out = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = x0 + i + 0.5 - BED_X, v = y0 + j + 0.5 - BED_Y;
      if (u < 0 || u >= BED_W || v < 0 || v >= BAND_H * 6) continue;
      const k = Math.min(5, Math.floor(v / BAND_H));
      const b = BED_BANDS[k], vb = v - k * BAND_H;
      const a = (b.Angle * Math.PI) / 180;
      const dx = Math.sin(a), dy = -Math.cos(a);          // CSS: 0deg is "to top", clockwise
      const len = Math.abs(BED_W * dx) + Math.abs(BAND_H * dy);
      let t = ((u - BED_W / 2) * dx + (vb - BAND_H / 2) * dy) / len + 0.5;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      out[j * w + i] = b.From[ch] + (b.To[ch] - b.From[ch]) * t;
    }
  }
  return out;
};

/** The worst per-channel step across any of the bed's five band seams -- the contrast the
 *  reconstruction difference is proportional to, and the reason the worst card is the one a seam
 *  crosses rather than the one nearest the middle. */
export const BedWorstSeamStep = (): number => {
  let m = 0;
  for (let i = 0; i < 5; i++) {
    for (let k = 0; k < 3; k++) {
      m = Math.max(m, Math.abs(BED_BANDS[i].To[k] - BED_BANDS[i + 1].From[k]));
    }
  }
  return m;
};
