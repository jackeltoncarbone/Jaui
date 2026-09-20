/**
 * Why the card composite's last 115 pixels exist, and what would make them zero.
 *
 * Lane `cardexact`. The card path draws a glass surface's subtree into a region-sized target under
 * an INTEGER translation of the window transform (`_cardViewport`): `gl.viewport(-card.X, -(H -
 * card.Y - card.H), W, H)`, with `u_Resolution` still the canvas and `u_ViewOffset` still 0. That is
 * bit-exact in real arithmetic and it is NOT bit-exact in float32, for one reason this file pins as
 * arithmetic rather than as prose:
 *
 *   OpenGL ES 3.0, 12.5.1:   x_w = (px / 2) * x_d + o_x,   o_x = x + px / 2
 *
 * `x_d` is identical in the two arms (same vertex shader, same inputs, same `u_Resolution`), `px` is
 * the canvas width in both, so the ONLY thing that differs is the addend `o_x` -- 1280 against the
 * scene, 1280 - card.X against the card. Both sums are rounded to float32 and then snapped to the
 * rasteriser's subpixel grid, and the two roundings are not the same rounding.
 *
 * Three results here, and the third is the one that decides what a fix could look like:
 *
 *   1. A rounding can never CROSS a subpixel snap boundary. Boundaries sit at multiples of 2^-9,
 *      which lie ON the float32 grid of both arms for any real canvas, and round-to-nearest cannot
 *      move a value past a grid point. So a disagreement requires one arm to land EXACTLY on a
 *      boundary while the other is strictly to one side -- a last-bit coincidence, not a near-miss.
 *   2. A vertex at a whole device pixel is immune: the arms' float coordinates differ by at most
 *      2^-14 there and the nearest round-to-nearest boundary is 2^-9 away, a 32x margin. Under
 *      TRUNCATION it would not be immune -- hundreds of integer positions would flip -- which is
 *      why the win32 gate's zero on every card edge, every rim and every first word is itself the
 *      proof that this rasteriser rounds to nearest.
 *   3. Therefore the only exposed vertices are the ones at FRACTIONAL device positions, and on the
 *      idle glass grid that is a short list: panel quads land on integers by construction (the
 *      arithmetic is rebuilt below out of `Jwift.Glass.jss` and `Perf.jss`), word RASTERS are an
 *      integer number of device px wide (`Math.ceil` in `Text.Cache`), and the first word of a
 *      block sits at the content origin. What is left is every word after the first.
 *
 * No GPU here and no claim about a millisecond. Nothing in this file changes a rendering default.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRenderer, readJaui, readJwiftGlass, readPerfJss, arrowBody, jssClass, jssNumber } from './Scene.ReadAfterWrite.Source';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (...p: string[]): string => readFileSync(join(HERE, '..', 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

// -- The float32 model, in the order the pipeline runs it --------------------------------------

const f = Math.fround;

/** `Text.Quad.vert` / `Jiv.Panel.vert`: ((pos - u_ViewOffset) / u_Resolution) * 2.0 - 1.0, with
 *  u_ViewOffset 0 on both arms. Every step float32. */
const clip = (pos: number, res: number): number => f(f(f(pos / res) * 2) - 1);

/** The GL viewport transform. `fused` is the one thing about the hardware this model cannot pin:
 *  whether the multiply-add is one rounding or two is not specified anywhere this lane can cite,
 *  and the two settings give different flip RATES (though the same structure). Both are exercised. */
const windowCoord = (pos: number, res: number, viewportOrigin: number, fused: boolean): number => {
  const xd = clip(pos, res);
  const half = res / 2;
  return fused
    ? f(xd * half + (viewportOrigin + half))
    : f(f(xd * f(half)) + f(viewportOrigin + half));
};

/** The rasteriser's fixed-point snap. 8 subpixel bits is D3D11's documented grid; the ROUNDING
 *  rule is not something this lane can cite, so all three candidates are here and `truncate` is
 *  kept as the negative control that the gate's own zero rules out. */
const SNAP = {
  halfUp: (x: number): number => Math.floor(x * 256 + 0.5),
  halfEven: (x: number): number => {
    const t = x * 256, r = Math.round(t);
    return Math.abs(t % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  },
  truncate: (x: number): number => Math.floor(x * 256),
};

/** Do the two arms put this vertex on a different subpixel? */
const disagrees = (
  pos: number, res: number, cardOrigin: number,
  fused: boolean, snap: (x: number) => number,
): boolean =>
  snap(windowCoord(pos, res, 0, fused)) !== snap(windowCoord(pos, res, -cardOrigin, fused)) + cardOrigin * 256;

/** A fixed LCG, so a rate printed here is the same rate next run. */
const sweep = (n: number, lo: number, hi: number, fn: (x: number) => void): void => {
  let s = 20260919;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) % 2147483648; fn(f(lo + (s / 2147483648) * (hi - lo))); }
};

// -- The real geometry, out of the real sheets --------------------------------------------------

const GLASS = jssClass(readJwiftGlass(), 'JwiftGlass');
const CARD = jssClass(readPerfJss(), 'PerfCard');
const GRID = jssClass(readPerfJss(), 'PerfGrid');
const DPR = 2, W = 2560, H = 1600, PHASE = 4;
const CARD_W = jssNumber(CARD, 'Width'), CARD_H = jssNumber(CARD, 'Height'), GAP = jssNumber(GRID, 'Gap');
const GRID_L = jssNumber(GRID, 'Left'), GRID_T = jssNumber(GRID, 'Top');
const PAD = /Padding:\s*([\d.]+)pt\s+([\d.]+)pt/.exec(CARD)!;
const PAD_T = Number(PAD[1]), PAD_L = Number(PAD[2]);
/** `BeginCardComposite`'s outset: max(sampleMargin, paintMargin) + the read guard, 72.75 on this
 *  grid -- the value that makes the region 584x452, which `Scene.CardComposite.test.ts` pins. */
const OUTSET = 72.75;

const cardBox = (i: number) => ({
  X: (GRID_L + (i % 5) * (CARD_W + GAP)) * DPR, Y: (GRID_T + Math.floor(i / 5) * (CARD_H + GAP)) * DPR,
  W: CARD_W * DPR, H: CARD_H * DPR,
});
const cardRegion = (i: number) => {
  const b = cardBox(i);
  const x0 = Math.max(0, Math.floor((b.X - OUTSET) / PHASE) * PHASE);
  const x1 = Math.min(W, Math.ceil((b.X + b.W + OUTSET) / PHASE) * PHASE);
  const yb0 = Math.max(0, Math.floor((H - (b.Y + b.H + OUTSET)) / PHASE) * PHASE);
  const yb1 = Math.min(H, Math.ceil((H - (b.Y - OUTSET)) / PHASE) * PHASE);
  return { X: x0, Ytop: H - yb1, W: x1 - x0, H: yb1 - yb0 };
};

describe('the card composite is bit-exact in real arithmetic and not in float32', () => {
  it('the only thing that differs between the two arms is the viewport ADDEND', () => {
    const body = arrowBody(readRenderer(), '_cardViewport').replace(/\s+/g, ' ');
    expect(body).toContain('viewport(-card.X, -(this._height - card.Y - card.H), this._width, this._height)');
    // u_Resolution stays the canvas -- the last argument pair above -- and u_ViewOffset is not
    // touched anywhere on this path. Both vertex shaders read the screen position into v_PixelPos
    // BEFORE subtracting u_ViewOffset, which is why option (b) in the finding keeps the glass
    // backdrop's screen uv intact: v_PixelPos / u_Resolution is still the true screen uv.
    for (const shader of [src('Jiv', 'Shaders', 'Jiv.Panel.vert'), src('Text', 'Shaders', 'Text.Quad.vert')]) {
      const twoD = shader.slice(shader.lastIndexOf('vec2 pos = a_Rect.xy'));
      expect(twoD.indexOf('v_PixelPos')).toBeLessThan(twoD.indexOf('u_ViewOffset'));
      expect(twoD).toContain('(pos - u_ViewOffset) / u_Resolution');
    }
  });

  it('a rounding can never CROSS a snap boundary, only land exactly on one', () => {
    // Boundaries live at multiples of 2^-9 (half-subpixels under round-to-nearest, whole ones under
    // truncation). Those are multiples of the float32 grid at any canvas coordinate below 2^15, so
    // a round-to-nearest cannot step over one.
    let crossed = 0, landed = 0, n = 0;
    for (const fused of [false, true]) {
      sweep(80000, 2052, 2396, (pos) => {
        const xd = clip(pos, W);
        const exact = fused ? xd * 1280 + 1280 : f(xd * 1280) + 1280;   // before the last rounding
        const got = windowCoord(pos, W, 0, fused);
        const lattice = Math.round(exact * 512) / 512;
        n++;
        if ((exact - lattice) * (got - lattice) < 0) crossed++;
        if (got === lattice && exact !== lattice) landed++;
      });
    }
    expect(crossed).toBe(0);
    expect(landed / n).toBeGreaterThan(0.04);   // ~6.9%: the disagreement's whole opportunity
    expect(landed / n).toBeLessThan(0.10);
  });

  it('a vertex at a whole device pixel is immune -- and would NOT be under truncation', () => {
    const integers = (snap: (x: number) => number, fused: boolean): number => {
      let n = 0;
      for (let c = 0; c < 5; c++) {
        const origin = cardRegion(c).X, b = cardBox(c);
        for (let p = b.X + PAD_L * DPR; p <= b.X + (CARD_W - PAD_L) * DPR; p++) if (disagrees(p, W, origin, fused, snap)) n++;
      }
      return n;
    };
    for (const fused of [false, true]) {
      expect(integers(SNAP.halfUp, fused)).toBe(0);
      expect(integers(SNAP.halfEven, fused)).toBe(0);
      // The negative control. Truncation would have lit up every card edge, every rim and every
      // first word; the gate measured zero on all of them, so this rasteriser rounds to nearest.
      expect(integers(SNAP.truncate, fused)).toBeGreaterThan(200);
    }
  });

  it('the residual is the SCENE arm rounding: the card arm addition is exact', () => {
    // t + (1280 - card.X) lands in a LOWER binade than t + 1280, so it keeps every bit t had.
    const inexact = (addend: number, lo: number, hi: number): number => {
      let n = 0, m = 0;
      sweep(40000, lo, hi, (pos) => { const t = f(clip(pos, W) * 1280); m++; if (f(t + addend) !== t + addend) n++; });
      return n / m;
    };
    for (const c of [0, 1, 3, 4]) {
      const origin = cardRegion(c).X, b = cardBox(c);
      expect(inexact(1280 - origin, b.X + 44, b.X + 388)).toBe(0);
    }
    // ...while the scene arm's own addition rounds on the right of the page and not on the left.
    const b4 = cardBox(4);
    expect(inexact(1280, b4.X + 44, b4.X + 388)).toBeGreaterThan(0.2);
    const b0 = cardBox(0);
    expect(inexact(1280, b0.X + 44, b0.X + 388)).toBe(0);
  });

  it('the flip rate per FRACTIONAL vertex, by column: column 0 is immune, and it grows with the binade', () => {
    const rate = (c: number, fused: boolean): number => {
      const origin = cardRegion(c).X, b = cardBox(c);
      let n = 0, m = 0;
      sweep(200000, b.X + PAD_L * DPR, b.X + (CARD_W - PAD_L) * DPR, (pos) => { m++; if (disagrees(pos, W, origin, fused, SNAP.halfUp)) n++; });
      return n / m;
    };
    const fused = [0, 1, 2, 3, 4].map((c) => rate(c, true));
    const split = [0, 1, 2, 3, 4].map((c) => rate(c, false));
    // Column 0's x is small enough that 1280 - x lands in a HIGHER binade than x: the scene arm's
    // addition is exact and there is nothing to disagree about.
    expect(fused[0]).toBeLessThan(0.0005);
    expect(split[0]).toBe(0);
    // Under ONE rounding (fused) the rate is ulp(x_w) / 2^-9 / 2 -- 1/32 in the rightmost column,
    // halving per binade leftward. That is the model in which the rightmost column is the most
    // exposed, and it is the model the observation matches: both differing cards are in column 4.
    expect(fused[4]).toBeGreaterThan(0.02);
    expect(fused[4]).toBeLessThan(0.04);
    expect(fused[4]).toBeGreaterThan(fused[3]);
    expect(fused[3]).toBeGreaterThan(fused[2]);
    expect(fused[2]).toBeGreaterThan(fused[1]);
    // Under TWO roundings the product's own grid is coarse and column 4 is not the peak -- which is
    // how the observation discriminates between the two hardware models.
    expect(split[4]).toBeLessThan(split[2]);
  });
});

describe('what is exposed on the idle glass grid, and what is not', () => {
  it('the card regions are the ones the composite already pins, and cards 9 and 19 share a column', () => {
    for (const i of [4, 9, 14, 19]) expect(cardRegion(i).X).toBe(1932);
    for (const i of [0, 5, 10, 15]) expect(cardRegion(i).X).toBe(44);
    for (const i of [0, 9, 19]) expect([cardRegion(i).W, cardRegion(i).H]).toEqual([584, 452]);
    // Card 9 is row 1, card 19 is row 3. A tie in Y is shared by all five cards of a row -- the
    // label's y is the same number in each -- so a Y flip cannot produce a single differing card,
    // and it certainly cannot produce one in row 1 and one in row 3. The mechanism is in X.
    expect([Math.floor(9 / 5), Math.floor(19 / 5)]).toEqual([1, 3]);
  });

  it('every panel quad corner on this page is a whole device pixel', () => {
    // `Jiv.InstanceBuffer.Push`: a_Rect = (centre - (half + margin), 2 * (half + margin)), with
    // margin = max(shadowBlur + |offset|, borderWidth + borderBlur), all at dpr.
    const shadowBlur = jssNumber(GLASS, 'ShadowBlur') * DPR;
    const offY = jssNumber(GLASS, 'ShadowOffsetY') * DPR;
    const borderMargin = (jssNumber(GLASS, 'BorderWidth') + jssNumber(GLASS, 'BorderBlur')) * DPR;
    const marginX = Math.max(shadowBlur, borderMargin);
    const marginY = Math.max(shadowBlur + Math.abs(offY), borderMargin);
    for (let i = 0; i < 20; i++) {
      const b = cardBox(i);
      const x0 = b.X + b.W / 2 - (b.W / 2 + marginX), y0 = b.Y + b.H / 2 - (b.H / 2 + marginY);
      for (const v of [x0, y0, 2 * (b.W / 2 + marginX), 2 * (b.H / 2 + marginY)]) expect(Number.isInteger(v)).toBe(true);
    }
    // And therefore immune, by the integer result above. The reason is NOT that the panel's
    // coverage is analytic: the SDF is evaluated at v_PixelPos, which is INTERPOLATED from the
    // snapped vertices, so a panel whose quad landed off the integer grid would carry the identical
    // <= 1 LSB difference along its anti-aliased edge and its rim.
    expect(src('Jiv', 'Shaders', 'Jiv.Panel.frag')).toContain('v_PixelPos');
  });

  it('a word raster is an integer number of device px wide, so a quad two x vertices share a fraction', () => {
    const cache = src('Text', 'Text.Cache.ts');
    expect(cache).toContain('const pxW = Math.max(1, Math.ceil(cssW * dpr));');
    expect(cache).toContain('Width: pxW,');
    // 1 device px per atlas texel: the quad is exactly as wide as its raster, so at an integer x
    // the bilinear sample lands on texel centres, and a 1/256 shift of the quad moves the sample by
    // 1/256 of a texel -- at most 1/256 of the atlas's local step, which is 1 LSB at 8 bits and is
    // exactly the "max channel delta 1, mean 1.00" the gate measured.
    expect(cache).toContain('UWidth: pxW / size,');
  });

  it('the FIRST word of a block sits at the content origin; every later word does not', () => {
    const layout = src('Text', 'Text.WordLayout.ts');
    expect(layout).toContain('let currentX = 0;');
    expect(layout).toMatch(/X: currentX,/);
    expect(layout).toContain('currentX += w + spaceWidth;');   // `w` is measureText's float advance
    // And nothing rounds it on the way to the GPU.
    const emit = arrowBody(readJaui(), '_emitTextFor').replace(/\s+/g, ' ');
    expect(emit).toContain('cmd.X = wx * this._dpr + dxCenter * this._dpr;');
    expect(emit).not.toMatch(/cmd\.X = Math\.(round|floor|trunc)/);
    // The node origin the first word inherits IS an integer here: the grid, the gap and the card
    // padding are all whole CSS px at dpr 2.
    for (let i = 0; i < 20; i++) expect(Number.isInteger(cardBox(i).X + PAD_L * DPR)).toBe(true);
    expect(Number.isInteger(PAD_T * DPR)).toBe(true);
  });
});
