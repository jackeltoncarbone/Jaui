import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlurPass, BaseDownsampleFactor, PresamplePlanFor, PyramidDepth, PyramidFill,
  ResolveRegionRect, type BackdropRect,
} from '../src/Core/BlurPass';
import { PlanBorderDirect, BorderDirectTapOffset } from '../src/Core/Border.Direct';
import { AtlasAdmitsMember, PlanBackdropAtlas, ATLAS_LIMITS_WIRED } from '../src/Core/Blur.Atlas';
import { FakeGl } from './Blur.Chains.Source';
import { arrowBody } from './Scene.ReadAfterWrite.Source';
import {
  Down, ArmK1, ArmK2, Deviation, Stencil, BedTile, BedWorstSeamStep,
} from './Presample.Kernel.Source';

/**
 * `?glass-presample` -- THE AREA GATE LIFTED FOR A PER-SURFACE GLASS BUILD.
 *
 * The lever, in one line: the engine already re-bases a pyramid onto a source pre-downsampled by
 * `k ~ sigma / 4` before running it, and `BaseDownsampleFactor` gates that on the region being at
 * least 15% of the canvas -- so a glass card, at 6%, is pinned to k=1 while its own sigma earns
 * k=2. Three structural levers on the pyramid have now been removed and measured and the cost
 * did not follow any of them (the atlas's encoders, the instanced draws, the direct-gather
 * border), so the one that is left is FEWER TEXELS.
 *
 * WHAT THIS FILE IS FOR, and it is two different things:
 *
 *   1. THE ARITHMETIC. The phase, the rect, the tap offset and the depth, proved equal or proved
 *      different between the arms rather than asserted. The load-bearing one is the depth rule:
 *      `PyramidDepth(radius) - log2(k)`, NOT the shipped `PyramidDepth(radius / k)`, which at
 *      these sigmas returns the SAME depth for both arms and would run the chain on a grid twice
 *      as coarse for a blur twice as wide.
 *   2. THE PICTURE. A CPU port of the four hops and of the consumer's read
 *      (`Presample.Kernel.Source.ts`) that computes what the two arms differ BY, on a synthetic
 *      edge and on the harness's own seeded bed reproduced from its own seed. The lane does not
 *      decide the picture; it makes it a number.
 */

const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');
const RENDERER = readFileSync(join(__dirname, '../src/Core/WebGL2.Renderer.ts'), 'utf8').replace(/\r\n/g, '\n');
const LEDGER = readFileSync(join(__dirname, '../src/Core/Scene.Ledger.ts'), 'utf8').replace(/\r\n/g, '\n');

// -- glass-grid, pinned, on the geometry every other blur test in this suite uses. --
const CANVAS_W = 2560, CANVAS_H = 1600, DPR = 2;
/** `BackdropFilter Blur(4pt)` at dpr 2 -- what `max(1, BackdropFrostBlur) * dpr` produces. */
const RADIUS = 4 * DPR;
const FILL_MARGIN = 4 * DPR + (2.5 * DPR) * 8 * (1 + 0.2 * 0.25) + 8 * DPR;
const RIM_MARGIN = 4 * DPR + 8 * DPR;

const CardBox = (i: number): BackdropRect => {
  const col = i % 5, row = (i / 5) | 0;
  return { x: (60 + col * 236) * DPR, y: (70 + row * 170) * DPR, w: 216 * DPR, h: 150 * DPR };
};
const RegionFor = (b: BackdropRect, margin: number): BackdropRect => ({
  x: Math.max(0, Math.floor(b.x - margin)),
  y: Math.max(0, Math.floor(b.y - margin)),
  w: Math.min(CANVAS_W, Math.ceil(b.w + margin * 2)),
  h: Math.min(CANVAS_H, Math.ceil(b.h + margin * 2)),
});
const FILL = Array.from({ length: 20 }, (_, i) => RegionFor(CardBox(i), FILL_MARGIN));
const RIM = Array.from({ length: 20 }, (_, i) => RegionFor(CardBox(i), RIM_MARGIN));

/** `Blur`'s own tap offset, for a `(radius, depth)` -- the copy `Border.Direct` already keeps
 *  and already pins against the source of `BlurPass.Blur`, reused rather than re-written. */
const TapOffset = BorderDirectTapOffset;

// ── 1. WHAT THE AREA GATE IS DOING, AND WHAT IT IS REFUSING ───────────────────────────────────

describe('glass-presample > what the gate refuses', () => {
  it('a glass card is 6% of the canvas, and 15% is the only clause that refuses it', () => {
    const area = FILL[0].w * FILL[0].h, full = CANVAS_W * CANVAS_H;
    expect(area / full).toBeCloseTo(0.059, 3);
    expect(area).toBeLessThan(0.15 * full);
    // The sigma DOES clear the other clause: radius 8 is over BASE_SIGMA 4, so the only thing
    // between this card and a k of 2 is the area.
    expect(RADIUS).toBeGreaterThan(4);
    expect(BaseDownsampleFactor(RADIUS, CANVAS_W, CANVAS_H, FILL[0])).toBe(1);
    expect(BaseDownsampleFactor(RADIUS, CANVAS_W, CANVAS_H, undefined)).toBe(2);
  });

  it('the k the card would earn is 2, from the constants and nothing else', () => {
    // 2^floor(log2(radius / BASE_SIGMA)) = 2^floor(log2(8 / 4)) = 2^1.
    const p = PresamplePlanFor(RADIUS, CANVAS_W, CANVAS_H, FILL[0], 0);
    expect(p).not.toBeNull();
    expect(p!.K).toBe(2);
  });

  it('every one of the forty builds on glass-grid takes the same plan', () => {
    for (const r of [...FILL, ...RIM]) {
      const p = PresamplePlanFor(RADIUS, CANVAS_W, CANVAS_H, r, 0);
      expect(p).toEqual({ K: 2, Depth: 1 });
    }
  });

  it('refuses a full-canvas region: the gate already admits it and nothing is lifted', () => {
    expect(PresamplePlanFor(32, CANVAS_W, CANVAS_H, undefined, 0)).toBeNull();
  });

  it('refuses a region the gate ALREADY admits, so a scrim keeps the shipped rule', () => {
    const big: BackdropRect = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H * 0.5 };
    expect(BaseDownsampleFactor(32, CANVAS_W, CANVAS_H, big)).toBeGreaterThan(1);
    expect(PresamplePlanFor(32, CANVAS_W, CANVAS_H, big, 0)).toBeNull();
  });

  it('refuses every sigma under TWICE BASE_SIGMA -- the floor is 8, not 4', () => {
    // `2^floor(log2(r / 4))` is 1 for every r below 8, so the plan is null there even though
    // `r > BASE_SIGMA` admits it: there is no factor to take. A glass class authored at
    // `Blur(2pt)` would get nothing from this flag at dpr 2, and that is worth being explicit
    // about -- the lever's reach is a property of the sheet, not of the engine.
    for (const r of [0, 1, 4, 5, 7, 7.999]) {
      expect(PresamplePlanFor(r, CANVAS_W, CANVAS_H, FILL[0], 0)).toBeNull();
    }
    expect(PresamplePlanFor(8, CANVAS_W, CANVAS_H, FILL[0], 0)).toEqual({ K: 2, Depth: 1 });
  });

  it('the two guard clauses are BELTS, not live branches -- no reachable sigma fires either', () => {
    // `Depth < 1` and `radius / k < 1` would each break the identity rather than cost fill, so
    // they are in the plan. Swept over every sigma this engine can produce they never fire, and
    // saying so is what stops a later reader reasoning from a branch that cannot be taken.
    let fired = 0;
    for (let r = 4.25; r <= 4096; r += 0.25) {
      const p = PresamplePlanFor(r, CANVAS_W, CANVAS_H, FILL[0], 0);
      if (p === null) continue;
      expect(p.Depth).toBeGreaterThanOrEqual(1);
      expect(r / p.K).toBeGreaterThanOrEqual(1);
      const raw = Math.min(8, 1 << Math.floor(Math.log2(r / 4)));
      if (p.K !== raw) fired++;
    }
    expect(fired).toBe(0);
  });
});

// ── 2. THE DEPTH RULE, WHICH IS THE WHOLE OF THE ARITHMETIC ───────────────────────────────────

describe('glass-presample > depth is PyramidDepth(radius) - log2(k)', () => {
  it('the shipped rule would return the SAME depth for both arms -- the trap', () => {
    // `PyramidDepth(radius / k)` re-derives the depth from the coarse sigma, and depth 2 covers
    // the whole band 3 < sigma <= 9, so 8 and 4 land in the same bucket.
    expect(PyramidDepth(RADIUS, 0)).toBe(2);
    expect(PyramidDepth(RADIUS / 2, 0)).toBe(2);
    // Which would have run the same chain on a grid twice as coarse, for twice the blur -- and
    // the tap offset could not have absorbed it, because the 0.7 FLOOR binds at BOTH sigmas.
    expect(TapOffset(RADIUS, 2)).toBe(0.7);
    expect(TapOffset(RADIUS / 2, 2)).toBe(0.7);
    expect(RADIUS / (3 * 2 ** 2)).toBeLessThan(0.7);
    expect((RADIUS / 2) / (3 * 2 ** 2)).toBeLessThan(0.7);
  });

  it('the plan subtracts log2(k) instead, which the tap offset then matches BIT for bit', () => {
    for (let r = 4.25; r <= 512; r += 0.25) {
      const p = PresamplePlanFor(r, CANVAS_W, CANVAS_H, FILL[0], 0);
      if (p === null) continue;
      expect(p.Depth).toBe(PyramidDepth(r, 0) - Math.log2(p.K));
      // `Blur` divides the radius by k and reads the offset off the coarse depth. k is a power
      // of two, so scaling an IEEE754 numerator and denominator by it gives the same quotient.
      expect(Object.is(TapOffset(r / p.K, p.Depth), TapOffset(r, PyramidDepth(r, 0)))).toBe(true);
    }
  });

  it('the PHASE is the unflagged phase, so ResolveRegionRect returns the identical rect', () => {
    for (const region of [...FILL, ...RIM]) {
      const p = PresamplePlanFor(RADIUS, CANVAS_W, CANVAS_H, region, 0)!;
      const flagged = p.K * (1 << p.Depth);
      const shipped = 1 * (1 << PyramidDepth(RADIUS, 0));
      expect(flagged).toBe(shipped);
      expect(ResolveRegionRect(region, CANVAS_W, CANVAS_H, flagged))
        .toEqual(ResolveRegionRect(region, CANVAS_W, CANVAS_H, shipped));
    }
  });

  it('so the consumer map does not move: only the TEXELS behind it halve', () => {
    const rect = ResolveRegionRect(FILL[0], CANVAS_W, CANVAS_H, 4);
    expect({ W: rect.W, H: rect.H }).toEqual({ W: 568, H: 436 });
    // `LastRegion`'s Scale and Offset are ratios of the RECT, which is the same rect; `TexelsX`
    // is level 0's own size, which is the rect divided by k.
    expect(CANVAS_W / rect.W).toBe(CANVAS_W / rect.W);
    expect(Math.floor(rect.W / 2)).toBe(284);
    expect(Math.floor(rect.H / 2)).toBe(218);
  });
});

// ── 3. THE KERNELS ────────────────────────────────────────────────────────────────────────────

describe('glass-presample > a DOWN hop is an exact 2x2 box at every admitted tap offset', () => {
  const W = 24, H = 24;
  const src = new Float64Array(W * H).map((_, i) => ((i * 2654435761) % 251) + (i % 7) * 0.37);

  it('holds for every t in (0, 1] -- not only at 1.0, where the pre-pass runs today', () => {
    let worst = 0;
    for (const t of [0.05, 0.25, 0.5, 0.7, 0.75, 0.9, 0.999, 1.0]) {
      const d = Down(src, W, H, t);
      for (let j = 0; j < d.H; j++) {
        for (let i = 0; i < d.W; i++) {
          const box = (src[2 * j * W + 2 * i] + src[2 * j * W + 2 * i + 1]
            + src[(2 * j + 1) * W + 2 * i] + src[(2 * j + 1) * W + 2 * i + 1]) / 4;
          worst = Math.max(worst, Math.abs(d.Data[j * d.W + i] - box));
        }
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('and BREAKS above 1, so the claim above is not vacuous', () => {
    let worst = 0;
    const d = Down(src, W, H, 1.3);
    for (let j = 0; j < d.H; j++) {
      for (let i = 0; i < d.W; i++) {
        const box = (src[2 * j * W + 2 * i] + src[2 * j * W + 2 * i + 1]
          + src[(2 * j + 1) * W + 2 * i] + src[(2 * j + 1) * W + 2 * i + 1]) / 4;
        worst = Math.max(worst, Math.abs(d.Data[j * d.W + i] - box));
      }
    }
    expect(worst).toBeGreaterThan(1);
  });
});

describe('glass-presample > the two arms share their first three hops exactly', () => {
  const T = 0.7, W = 64, H = 64;
  const src = new Float64Array(W * H).map((_, i) => ((i * 48271) % 256));

  it('the presampled level 0 IS the unflagged level-1 intermediate, to the last bit', () => {
    const a = ArmK1(src, W, H, T), b = ArmK2(src, W, H, T);
    expect(b.L0.W).toBe(a.Mid.W);
    expect(b.L0.H).toBe(a.Mid.H);
    for (let i = 0; i < b.L0.Data.length; i++) expect(b.L0.Data[i]).toBe(a.Mid.Data[i]);
  });

  it('which is only true because the pre-pass runs at the CHAIN OFFSET under the flag', () => {
    // The identity is in exact arithmetic either way (a DOWN hop is a box at any t <= 1), but
    // the GPU's fp32 rounding is not, and the rounding is what a 0-px gate reads. `Blur` issues
    // `u_Offset` as the chain's own `tapOffset` when the build is presampled, 1.0 otherwise.
    const body = arrowBody(readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8')
      .replace(/\r\n/g, '\n'), 'Blur');
    expect(body).toContain('gl.uniform1f(this._downOffLoc, pre !== null ? tapOffset : 1.0);');
    // ...and the offset has to be computed BEFORE the ping-pong for that to be possible.
    expect(body.indexOf('const tapOffset =')).toBeLessThan(body.indexOf('if (k > 1) {'));
  });
});

describe('glass-presample > the whole difference is the last 2x reconstruction', () => {
  const T = 0.7;

  it('is a 9-tap tent on one arm and a 4-tap bilinear on the other, both over +/-1, both DC', () => {
    for (const [pi, pj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const tent = Stencil('tent', T, pi, pj);
      const bi = Stencil('bilinear', T, pi, pj);
      expect(tent.length).toBe(9);
      expect(bi.length).toBe(4);
      expect(Math.max(...tent.map(([i, j]) => Math.max(Math.abs(i), Math.abs(j))))).toBe(1);
      expect(Math.max(...bi.map(([i, j]) => Math.max(Math.abs(i), Math.abs(j))))).toBe(1);
      expect(tent.reduce((s, [, , w]) => s + w, 0)).toBeCloseTo(1, 12);
      expect(bi.reduce((s, [, , w]) => s + w, 0)).toBeCloseTo(1, 12);
    }
  });

  it('the tent is the WIDER of the two -- the flagged arm is very slightly sharper, not softer', () => {
    // CENTRAL second moment: an output pixel of a 2x magnification sits a quarter of a texel
    // off the source grid on both arms, and that offset is common to them -- it is where the
    // pixel IS, not how wide its kernel is.
    const v = (ws: [number, number, number][]): number => {
      const cx = ws.reduce((s, [i, , w]) => s + i * w, 0);
      const cy = ws.reduce((s, [, j, w]) => s + j * w, 0);
      return ws.reduce((s, [i, j, w]) => s + w * ((i - cx) ** 2 + (j - cy) ** 2), 0) / 2;
    };
    const tent = v(Stencil('tent', T, 0, 0)), bi = v(Stencil('bilinear', T, 0, 0));
    expect(tent).toBeGreaterThan(bi);
    expect(tent).toBeCloseTo(0.32917, 4);
    expect(bi).toBeCloseTo(0.1875, 4);
    // In half-res texels squared; times 4 to read it in device px on a k=2 build.
    expect((tent - bi) * 4).toBeCloseTo(0.567, 2);
  });

  it('a ceiling of ~52 levels over ARBITRARY content, which blurred content cannot reach', () => {
    const tent = Stencil('tent', T, 0, 0), bi = Stencil('bilinear', T, 0, 0);
    const m = new Map<string, number>();
    for (const [i, j, w] of tent) m.set(`${i},${j}`, (m.get(`${i},${j}`) ?? 0) + w);
    for (const [i, j, w] of bi) m.set(`${i},${j}`, (m.get(`${i},${j}`) ?? 0) - w);
    let pos = 0;
    for (const w of m.values()) if (w > 0) pos += w;
    expect(pos * 255).toBeCloseTo(52.5, 0);
    // The bound is real and it is loose: the operator's INPUT is the pyramid's own level-1
    // intermediate, which is the source convolved by a 4x4 box and a tent. The measured
    // deviations below are two orders under it, and that gap is the whole reason this lane
    // reports a measurement and not an inequality.
  });

  it('kills a Nyquist pattern to ZERO on both arms -- the operators share their input', () => {
    const W = 64, H = 64;
    const s = new Float64Array(W * H).map((_, i) => (i % 2) * 255);
    const d = Deviation(ArmK1(s, W, H, T).Out, ArmK2(s, W, H, T).Out);
    expect(d.Max).toBeLessThan(1e-9);
  });

  it('scales with the LOCAL STEP CONTRAST at about 1.27% of it', () => {
    const W = 96, H = 96;
    const at = (c: number): number => {
      const s = new Float64Array(W * H);
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) s[j * W + i] = i < W / 2 ? 0 : c;
      return Deviation(ArmK1(s, W, H, T).Out, ArmK2(s, W, H, T).Out).Max;
    };
    const full = at(255);
    expect(full).toBeGreaterThan(3.0);
    expect(full).toBeLessThan(3.5);
    expect(full / 255).toBeCloseTo(0.0127, 3);
    expect(at(128) / at(255)).toBeCloseTo(0.5, 2);   // linear in the contrast, as an operator must be
  });
});

describe('glass-presample > on the harness`s own seeded bed', () => {
  const T = 0.7;

  it('reproduces the bed the shot will be taken of, seed for seed', () => {
    // Band 1 ends dark and band 2 starts on a vivid green: 215 of 255 on one channel, which is
    // the largest step anywhere in the bed and therefore where the deviation will be worst.
    expect(BedWorstSeamStep()).toBe(215);
  });

  it('EVERY card`s fill region contains a band seam -- a region is taller than a band', () => {
    // The bed is six bands over 1300 CSS px, so a band is 433.33 device px tall and a fill
    // region is 436. There is no seam-free fill region on this scene, which is why the
    // deviation below is the SEAM's deviation on all twenty and not on a worst case.
    const seams = [33.333, 466.667, 900, 1333.333];
    for (let c = 0; c < 20; c++) {
      const R = ResolveRegionRect(FILL[c], CANVAS_W, CANVAS_H, 4);
      const top = CANVAS_H - R.YBottom - R.H;
      expect(R.H).toBeGreaterThan((1300 / 6) * 2);
      expect(seams.some((y) => y > top && y < top + R.H)).toBe(true);
    }
  });

  it('stays UNDER two 8-bit levels on the worst card, and near nothing without a seam', () => {
    // Card 9 is the worst of the twenty: row 1, and its fill region spans the 466.667 seam
    // between bands 1 and 2, the 215-of-255 step. Two regions rather than forty because the
    // port is float64 over 568x436x3 and the whole set takes a minute; the report carries all
    // forty, measured the same way.
    const R = ResolveRegionRect(FILL[9], CANVAS_W, CANVAS_H, 4);
    const top = CANVAS_H - R.YBottom - R.H;
    let seam = 0;
    for (let ch = 0; ch < 3; ch++) {
      const s = BedTile(R.X, top, R.W, R.H, ch);
      seam = Math.max(seam, Deviation(ArmK1(s, R.W, R.H, T).Out, ArmK2(s, R.W, R.H, T).Out).Max);
    }
    expect(seam).toBeGreaterThan(0.5);               // non-vacuous: something IS different
    expect(seam).toBeLessThan(2);

    // A RIM region is 348 tall and fits inside a band, and row 0's clears both seams around it
    // (116..464 against 33.3 and 466.7) -- the smooth-gradient case, and the control on the
    // claim that the deviation is the SEAM's.
    const R2 = ResolveRegionRect(RIM[0], CANVAS_W, CANVAS_H, 4);
    const top2 = CANVAS_H - R2.YBottom - R2.H;
    expect(top2).toBeGreaterThan(33.333);
    expect(top2 + R2.H).toBeLessThan(466.667);
    let smooth = 0;
    for (let ch = 0; ch < 3; ch++) {
      const s = BedTile(R2.X, top2, R2.W, R2.H, ch);
      smooth = Math.max(smooth, Deviation(ArmK1(s, R2.W, R2.H, T).Out, ArmK2(s, R2.W, R2.H, T).Out).Max);
    }
    expect(smooth).toBeLessThan(0.05);
    expect(smooth * 10).toBeLessThan(seam);
  });
});

// ── 4. THE PRICE ──────────────────────────────────────────────────────────────────────────────

describe('glass-presample > what it costs and what it saves', () => {
  const FILL_RECT = ResolveRegionRect(FILL[0], CANVAS_W, CANVAS_H, 4);
  const RIM_RECT = ResolveRegionRect(RIM[0], CANVAS_W, CANVAS_H, 4);

  it('the fill pipeline is 568x436 and the rim 480x348 -- 386,950 and 261,000 destination px', () => {
    expect([FILL_RECT.W, FILL_RECT.H]).toEqual([568, 436]);
    expect([RIM_RECT.W, RIM_RECT.H]).toEqual([480, 348]);
    expect(PyramidFill(568, 436, 1, 2)).toBe(386950);
    expect(PyramidFill(480, 348, 1, 2)).toBe(261000);
  });

  it('a presampled build writes 36.0% of them', () => {
    expect(PyramidFill(568, 436, 2, 1)).toBe(139302);
    expect(PyramidFill(480, 348, 2, 1)).toBe(93960);
    expect(139302 / 386950).toBeCloseTo(0.36, 3);
    expect(93960 / 261000).toBeCloseTo(0.36, 3);
  });

  it('forty builds: 12.96 Mpx of destination becomes 4.67, a 64% cut', () => {
    const off = 20 * (PyramidFill(568, 436, 1, 2) + PyramidFill(480, 348, 1, 2));
    const on = 20 * (PyramidFill(568, 436, 2, 1) + PyramidFill(480, 348, 2, 1));
    expect(off).toBe(12959000);
    expect(on).toBe(4665240);
    expect(1 - on / off).toBeCloseTo(0.64, 2);
  });

  it('and 30.8% of the bilinear taps: 95.9 M becomes 29.5 M', () => {
    // DOWN is 5 taps per destination px, UP is 8. Counted per hop rather than off a total,
    // because the arms differ in WHICH hops they run and not only in how big they are.
    const taps = (w: number, h: number, k: 1 | 2): number => {
      if (k === 1) {
        const [w1, h1] = [w >> 1, h >> 1], [w2, h2] = [w1 >> 1, h1 >> 1];
        return w1 * h1 * 5 + w2 * h2 * 5 + w1 * h1 * 8 + w * h * 8;
      }
      const [w1, h1] = [w >> 1, h >> 1], [w2, h2] = [w1 >> 1, h1 >> 1];
      return w1 * h1 * 5 + w2 * h2 * 5 + w1 * h1 * 8;      // pre, DOWN, UP
    };
    const off = 20 * (taps(568, 436, 1) + taps(480, 348, 1));
    const on = 20 * (taps(568, 436, 2) + taps(480, 348, 2));
    expect(off).toBe(95896600);
    expect(on).toBe(29546520);
    expect(on / off).toBeCloseTo(0.308, 3);
  });

  it('passes go DOWN by one per build, not up: the pre-pass replaces a DOWN and an UP', () => {
    // The brief predicted `+1` per build. It is `-1`: the factor comes OUT of the depth, so the
    // chain loses a hop on each side and the pre-pass adds one.
    const passes = (depth: number, k: number): number => Math.log2(k) + depth * 2;
    expect(passes(2, 1)).toBe(4);
    expect(passes(1, 2)).toBe(3);
    expect(40 * passes(2, 1)).toBe(160);
    expect(40 * passes(1, 2)).toBe(120);
  });

  it('the phone at dpr 3 takes k=2 as well -- NOT 4 -- from depth 3 to depth 2', () => {
    const r = 4 * 3;                                  // Blur(4pt) at dpr 3
    const p = PresamplePlanFor(r, 1179, 2556, { x: 0, y: 0, w: 400, h: 300 }, 0)!;
    expect(p).toEqual({ K: 2, Depth: 2 });
    expect(PyramidDepth(r, 0)).toBe(3);
    // k=4 would need sigma >= 16, which is Blur(5.34pt) at dpr 3 and no class authors it.
    expect(PresamplePlanFor(16, 1179, 2556, { x: 0, y: 0, w: 400, h: 300 }, 0)!.K).toBe(4);
    // 61% of the texels, against 64% at dpr 2 -- the deeper chain keeps proportionally more.
    const on = PyramidFill(800, 600, 2, 2), off = PyramidFill(800, 600, 1, 3);
    expect(1 - on / off).toBeGreaterThan(0.6);
    expect(1 - on / off).toBeLessThan(0.62);
  });
});

// ── 5. THE REFUSALS ───────────────────────────────────────────────────────────────────────────

describe('glass-presample > the two planners that refuse k > 1 refuse this too', () => {
  const RIM_CAND = {
    Region: RIM[0], Radius: RADIUS, MaxLod: 0,
    Px: CardBox(0).x, Py: CardBox(0).y, Pw: CardBox(0).w, Ph: CardBox(0).h, TapReach: 24,
  };

  it('PlanBorderDirect admits the rim today and refuses it by name under the arm', () => {
    expect(PlanBorderDirect(RIM[0], CANVAS_W, CANVAS_H, RADIUS, 0).Ok).toBe(true);
    const refused = PlanBorderDirect(RIM[0], CANVAS_W, CANVAS_H, RADIUS, 0, true);
    expect(refused.Ok).toBe(false);
    expect((refused as { Why: string }).Why).toBe('presample-k2');
  });

  it('AtlasAdmitsMember admits the member today and refuses it under the arm', () => {
    expect(AtlasAdmitsMember(RIM_CAND, CANVAS_W, CANVAS_H)).toBe(true);
    expect(AtlasAdmitsMember(RIM_CAND, CANVAS_W, CANVAS_H, true)).toBe(false);
  });

  it('PlanBackdropAtlas refuses the whole CLASS, not one member at a time', () => {
    const members = FILL.map((r) => ({ Region: r, Paint: r }));
    const opts = { IgnoreSeparation: true, Limits: ATLAS_LIMITS_WIRED, MaxLod: 0 };
    expect(PlanBackdropAtlas(members, CANVAS_W, CANVAS_H, RADIUS, opts)).not.toBeNull();
    expect(PlanBackdropAtlas(members, CANVAS_W, CANVAS_H, RADIUS, { ...opts, Presample: true }))
      .toBeNull();
  });

  it('and all three are UNCHANGED at the default, which is how the off arm stays the engine', () => {
    expect(PlanBorderDirect(RIM[0], CANVAS_W, CANVAS_H, RADIUS, 0))
      .toEqual(PlanBorderDirect(RIM[0], CANVAS_W, CANVAS_H, RADIUS, 0, false));
    expect(AtlasAdmitsMember(RIM_CAND, CANVAS_W, CANVAS_H, false)).toBe(true);
  });

  it('the walk hands its own arm to both, rather than each keeping a copy of the flag', () => {
    // `?glass-gaussian` threaded its own arm through the same two call sites, so each pin now
    // carries both flags -- which is the point of the pin: ONE place hands the planners the
    // arms, and a second flag that kept a private copy would show up here as a missing argument.
    expect(JAUI).toContain(
      "AtlasAdmitsMember(c.Plan, w, h, this._glassPresample, this._glassGaussian !== 'off')");
    expect(JAUI).toContain('Presample: this._glassPresample');
    expect(RENDERER).toContain(
      'PlanBorderDirect(region, width, height, radius, maxLod, this.DiagGlassPresample,');
  });
});

// ── 6. THE PASS, WIRED ────────────────────────────────────────────────────────────────────────

describe('glass-presample > the build BlurPass actually issues', () => {
  const Rig = (): { Gl: FakeGl; Pass: BlurPass; Src: object } => {
    const gl = new FakeGl();
    const pass = new BlurPass(gl.Gl, undefined, 1);
    return { Gl: gl, Pass: pass, Src: gl.MakeSource(CANVAS_W, CANVAS_H, 'scene') };
  };
  const Build = (r: { Gl: FakeGl; Pass: BlurPass; Src: object }, on: boolean): {
    Texels: string[]; Draws: number; Region: string; Depth: number; Pre: boolean; K: number;
  } => {
    r.Gl.Reset();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, RADIUS, 0, FILL[0], undefined, on);
    return {
      Texels: r.Gl.Texels,
      Draws: r.Gl.Calls.filter((c) => c === 'drawElements').length,
      Region: JSON.stringify(r.Pass.LastRegion),
      Depth: r.Pass.LastDepth,
      Pre: r.Pass.LastPresampled,
      K: r.Pass.LastPresampleK,
    };
  };

  it('off: four draws, depth 2, level 0 at 568x436, and nothing presampled', () => {
    const b = Build(Rig(), false);
    expect(b.Draws).toBe(4);
    expect(b.Depth).toBe(2);
    expect(b.Pre).toBe(false);
    expect(b.K).toBe(1);
    expect(b.Texels[b.Texels.length - 1]).toContain('568x436');
  });

  it('on: THREE draws, depth 1, level 0 at 284x218, and the pass says it re-based', () => {
    const b = Build(Rig(), true);
    expect(b.Draws).toBe(3);
    expect(b.Depth).toBe(1);
    expect(b.Pre).toBe(true);
    expect(b.K).toBe(2);
    expect(b.Texels[b.Texels.length - 1]).toContain('284x218');
  });

  it('the first write is IDENTICAL on the two arms -- same size, same symbolic value', () => {
    // The pre-pass IS the unflagged arm's first DOWN hop: same program, same source rect, same
    // `u_HalfPixel`, and (under the flag) the same `u_Offset`. `FakeGl` composes each write's
    // value from its whole history, so an equal value here is an equal input to every hop after.
    const off = Build(Rig(), false), on = Build(Rig(), true);
    const val = (t: string): string => t.split(' ').slice(2).join(' ');
    expect(val(on.Texels[0])).toBe(val(off.Texels[0]));
  });

  it('...and the presampled LEVEL 0 is the unflagged build`s level-1 intermediate', () => {
    const off = Build(Rig(), false), on = Build(Rig(), true);
    const val = (t: string): string => t.split(' ').slice(2).join(' ');
    // off: [down l1, down l2, up l1, up l0]   on: [pre, down l1, up l0]
    expect(off.Texels.length).toBe(4);
    expect(on.Texels.length).toBe(3);
    expect(val(on.Texels[1])).toBe(val(off.Texels[1]));
    expect(val(on.Texels[2])).toBe(val(off.Texels[2]));
    // and the unflagged build has exactly ONE write the flagged one does not: the last hop.
    expect(val(off.Texels[3])).not.toBe(val(on.Texels[2]));
  });

  it('LastRegion keeps its Scale and Offset and only its texel count moves', () => {
    const off = JSON.parse(Build(Rig(), false).Region);
    const on = JSON.parse(Build(Rig(), true).Region);
    expect(on.ScaleX).toBe(off.ScaleX);
    expect(on.ScaleY).toBe(off.ScaleY);
    expect(on.OffsetX).toBe(off.OffsetX);
    expect(on.OffsetY).toBe(off.OffsetY);
    expect(on.TexelsX).toBe(off.TexelsX / 2);
    expect(on.TexelsY).toBe(off.TexelsY / 2);
  });

  it('an unflagged build is byte-for-byte the build before this lane touched the pass', () => {
    // Two builds in one pass, one asking and one not, so the comparison is inside one binary.
    const r = Rig();
    const a = Build(r, false), b = Build(r, false);
    expect(a.Texels).toEqual(b.Texels);
    expect(a.Depth).toBe(2);
    expect(a.Pre).toBe(false);
  });

  it('the pre-downsample keeps a pair PER SIZE, so alternating fills and rims do not thrash', () => {
    // On `glass-grid` the walk issues a fill at 568x436 and then that card's rim at 480x348,
    // twenty times. One shared ping-pong would `Resize` -- which reallocates the texture -- on
    // every one of the forty, and the flag's own arm would have paid for it. Warm the two sizes,
    // then assert the next four builds allocate NOTHING.
    const r = Rig();
    for (const region of [FILL[0], RIM[0]]) {
      r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, RADIUS, 0, region, undefined, true);
    }
    r.Gl.Reset();
    for (const region of [FILL[1], RIM[1], FILL[2], RIM[2]]) {
      r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, RADIUS, 0, region, undefined, true);
    }
    expect(r.Gl.Calls.filter((c) => c === 'texImage2D')).toEqual([]);
    expect(r.Gl.Calls.filter((c) => c === 'drawElements').length).toBe(12);
  });

  it('a pinned baseFactor refuses the arm: a pin and a lifted gate are two answers to one k', () => {
    const r = Rig();
    r.Gl.Reset();
    r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, RADIUS, 0, FILL[0], 1, true);
    expect(r.Pass.LastPresampled).toBe(false);
    expect(r.Pass.LastDepth).toBe(2);
  });
});

// ── 7. THE WIRING ─────────────────────────────────────────────────────────────────────────────

describe('glass-presample > the flag, the counter and the gate', () => {
  it('is OFF by default and takes on|off by name, throwing on anything else', () => {
    expect(JAUI).toContain('private _glassPresample: boolean = false;');
    expect(JAUI).toContain("throw new Error(`[Jaui] ?glass-presample takes 'on' or 'off', got '${raw}'`)");
    expect(JAUI).toContain("this._glassPresample = raw !== 'off';");
    expect(RENDERER).toContain('DiagGlassPresample = false;');
  });

  it('names every flag it cannot run beside, on the trace, rather than disarming in silence', () => {
    const block = JAUI.slice(JAUI.indexOf("params.has('glass-presample')"));
    for (const clause of ['webgl2-only', 'no-blur-and-blur-dummy', 'blur-src', 'shared-backdrop',
      'card-composite', 'border-direct', 'pyramid-atlas', 'border-source', 'restart-probes']) {
      expect(block.slice(0, 2200)).toContain(clause);
    }
    expect(block.slice(0, 2600)).toContain('JTrace(`jaui:glass-presample armed=off reason=${why}`)');
  });

  it('marks on BOTH arms, with `default=` so a control shot can be told from an arm', () => {
    expect(JAUI).toContain("JTrace(`jaui:glass-presample armed=${this._glassPresample ? 'on' : 'off'}`");
    expect(JAUI).toContain("+ ` default=${params.has('glass-presample') ? 'false' : 'true'}`");
    expect(JAUI).toContain("+ (this._glassPresample ? ' pixels=DIFFERENT' : '')");
  });

  it('the gate line carries builds= and k=, and blur= as the control invariant', () => {
    const gate = JAUI.slice(JAUI.indexOf('jaui:glass-presample builds='));
    expect(gate.slice(0, 400)).toContain('builds=${gl2.PresampledBuilds} k=${gl2.LastPresampleK}');
    expect(gate.slice(0, 400)).toContain("blur=${gl2.SceneEndsByKey['blur'] ?? 0}");
    // Printed on a SHAPE change, like every other gate line in this file.
    expect(gate.slice(0, 700)).toContain('if (line !== this._glassPresampleLastLine)');
  });

  it('the ledger counter exists, resets every frame, and is booked off the PASS', () => {
    expect(LEDGER).toContain('PresampledBuilds = 0;');
    const begin = LEDGER.slice(LEDGER.indexOf('BeginFrame = ('), LEDGER.indexOf('NoteWrite'));
    expect(begin).toContain('this.PresampledBuilds = 0;');
    expect(LEDGER).toContain('NotePresampled = (): void => { this.PresampledBuilds++; };');
    // Off the pass, not off the flag: a plan that refused everything must read 0.
    const note = arrowBody(RENDERER, '_notePresampled');
    expect(note).toContain('if (!pass.LastPresampled) return;');
    expect(note).toContain('this._sceneLedger.NotePresampled();');
  });

  it('the renderer ANDs the caller`s request with its own arm, so a site can only under-arm', () => {
    const body = arrowBody(RENDERER, 'ComputeBlur');
    expect(body).toContain('const rebase = presample === true && this.DiagGlassPresample;');
    expect(body).toContain('pass.Blur(_unwrap(input), width, height, radius, minDepth, region, undefined,'
      + '\n      rebase, gaussMode, sepReq)');
    expect(body).toContain('pass.Blur(src, this._width, this._height, radius, minDepth, region, undefined,'
      + '\n        rebase, gaussMode, sepReq)');
  });

  it('all three per-surface glass build sites ask, and they ask the same question', () => {
    // Three build sites (the walk's fill, the walk's rim, the pre-pass) plus the pool key.
    expect(JAUI.split('this._mayPresample(plan)').length - 1).toBe(4);
    expect(JAUI).toContain('private _mayPresample = (plan: GlassBlurPlan): boolean =>');
    // MaxLod is the clause, and it is the caller's because `BlurPass` cannot see it.
    expect(JAUI).toContain('this._glassPresample && plan.MaxLod === 0;');
  });

  it('the pre-pass pool key follows the plan the build took, not the shipped rule', () => {
    const issue = arrowBody(JAUI, '_prepassIssue');
    expect(issue).toContain('PresamplePlanFor(plan.Radius, w, h, plan.Region, 0)');
    expect(issue).toContain('presampled !== null ? presampled.Depth : PyramidDepth(plan.Radius / k, 0)');
  });

  it('publishes a census a cell can read without the console', () => {
    expect(JAUI).toContain('__jauiGlassPresample?: () => GlassPresampleCensus');
    expect(JAUI).toContain('Builds: on ? r.PresampledBuilds : 0,');
    expect(JAUI).toContain('Refused: this._glassPresampleRefused,');
  });
});
