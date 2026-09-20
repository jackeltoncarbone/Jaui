/**
 * The card composite, and the `glass-grid` numbers it should produce.
 *
 * `ShowStudio.Documentation/Perf/SceneRaw.Finding.md` 4(c). The frame's cost is the number of times
 * the SCENE target's Metal render encoder ENDS while the bed is in it: switches 40 -> 20 -> 0 gave
 * 72.85 -> 34.32 -> 11.32 GPU ms on an M4 at dpr 2, two points through the origin. This path makes
 * the scene render pass the bed ONCE and touches it afterwards only with region blits.
 *
 * There is no GPU here and no claim about milliseconds. What these pin is the arithmetic the design
 * rests on -- the grid law that makes a region-sized SOURCE a crop rather than a resample, the
 * replay rule that makes a seeded target equal to what the scene held, and the switch count the
 * walk should now report -- derived from the real classes and the real grid, plus the wiring in the
 * renderer that has to be there for any of it to hold.
 *
 * `Scene.ReadAfterWrite.test.ts` is left byte-for-byte as it was: the M4 has measured numbers
 * against every table in it.
 *
 * **Everything in this file describes the walk UNDER `?cardcomposite`.** The design was measured
 * and refuted -- it does exactly what it claims and the frame is 6.6% slower for it at dpr 2, so
 * encoder ends are not the cost (Perf/README.md, "THE CANDIDATE REFUTES ENCODER ENDS") -- and the
 * gate therefore defaults to OFF. An unflagged run takes the pre-composite walk, whose numbers are
 * the `glass-grid` tables in `Scene.ReadAfterWrite.test.ts` (40 ends, all on `blur`), not these.
 * The last describe in this file is the gate itself: default off, `?cardcomposite` on,
 * `?no-cardcomposite` winning over both, and nothing allocated on the way past it.
 */
import { describe, it, expect } from 'vitest';
import { SceneReadLedger } from '@jaui/Core/Scene.Ledger';
import {
  readRenderer, readJaui, readJwiftGlass, readPerfJss,
  arrowBody, getterBody, jssClass, jssNumber, jssBlurPt,
} from './Scene.ReadAfterWrite.Source';

// ── The geometry, out of the real sheets ──────────────────────────────────────────────────────

const GLASS = jssClass(readJwiftGlass(), 'JwiftGlass');
const CARD = jssClass(readPerfJss(), 'PerfCard');
const GRID = jssClass(readPerfJss(), 'PerfGrid');

const FROST_PT = jssBlurPt(GLASS, 'BackdropFilter');
const THICKNESS = jssNumber(GLASS, 'Thickness');
const FILLET = jssNumber(GLASS, 'Fillet');
const REFRACTION = jssNumber(GLASS, 'Refraction');
const CA = jssNumber(GLASS, 'ChromaticAberration');
const SHADOW_BLUR_PT = jssNumber(GLASS, 'ShadowBlur');
const SHADOW_OFFSET_Y_PT = jssNumber(GLASS, 'ShadowOffsetY');
const CARD_W_PT = jssNumber(CARD, 'Width');
const CARD_H_PT = jssNumber(CARD, 'Height');
const GAP_PT = jssNumber(GRID, 'Gap');

const DPR = 2;
const CARDS = 20;
const CANVAS_W = 2560;
const CANVAS_H = 1600;

/** `Jaui.ts`'s glass FILL sample margin, mirrored. Unrotated, unscaled: `avgScale` is 1. */
const fillMarginDev = (dpr: number): number => {
  const thicknessDev = THICKNESS * 1 * dpr;
  const minHalf = Math.min(CARD_W_PT, CARD_H_PT) * dpr * 0.5;
  const bulgeMax = FILLET * minHalf * 0.25 * 0.7;
  return FROST_PT * dpr + (thicknessDev + bulgeMax) * REFRACTION + CA * 3 + 8 * dpr;
};
/** `Jaui.ts`'s `_subtreeMaxPaintMargin`, mirrored for a card: shadow blur plus the larger offset. */
const paintMarginDev = (dpr: number): number => (SHADOW_BLUR_PT + SHADOW_OFFSET_Y_PT) * dpr;

/** `BlurPass.PyramidDepth`, mirrored, at `minDepth` 0 -- which is what `ComputeBlur` passes. */
const pyramidDepth = (radius: number): number =>
  Math.max(1, Math.min(8, Math.ceil(Math.log2(Math.max(1, radius) / 3 + 1))));
/** `BlurPass.BaseDownsampleFactor`, mirrored, measured against the CANVAS. */
const baseFactor = (radius: number, regionArea: number): number => {
  if (radius <= 4) return 1;
  if (regionArea < 0.15 * CANVAS_W * CANVAS_H) return 1;
  return Math.min(8, 1 << Math.floor(Math.log2(radius / 4)));
};
/** `WebGL2Renderer.SetCardGrid`, mirrored. */
const cardGrid = (phase: number): number => Math.max(1, 1 << Math.ceil(Math.log2(Math.max(1, phase))));

/** `WebGL2.Renderer.CardReadGuard`, mirrored: one grid phase for the rect `ResolveRegionRect` can
 *  round out to, plus two texels for the first DOWN hop's tap and its bilinear footprint. */
const cardReadGuard = (phase: number): number => phase + 2;
/** The guard rounded UP to a whole number of phases, which is what the box actually grows by. */
const cardGuardBand = (P: number): number => Math.ceil(cardReadGuard(P) / P) * P;

/** `WebGL2Renderer.BeginCardComposite`'s region derivation, mirrored. Device px, y=0 at TOP. */
const cardRegion = (
  px: number, py: number, pw: number, ph: number, sampleMargin: number, paintMargin: number, P: number,
): { X: number; Y: number; W: number; H: number } => {
  const out = Math.max(sampleMargin, paintMargin) + cardGuardBand(P);
  const x0 = Math.max(0, Math.floor((px - out) / P) * P);
  const x1 = Math.min(CANVAS_W, Math.ceil((px + pw + out) / P) * P);
  const yb0 = Math.max(0, Math.floor((CANVAS_H - (py + ph + out)) / P) * P);
  const yb1 = Math.min(CANVAS_H, Math.ceil((CANVAS_H - (py - out)) / P) * P);
  return { X: x0, Y: CANVAS_H - yb1, W: x1 - x0, H: yb1 - yb0 };
};

/** `ResolveRegionRect`, mirrored, over an input of `width` x `height`. */
const resolveRegionRect = (
  region: { x: number; y: number; w: number; h: number }, width: number, height: number, phase: number,
): { X: number; YBottom: number; W: number; H: number } => {
  const rx = Math.max(0, Math.min(width - 1, Math.floor(region.x)));
  const ry = Math.max(0, Math.min(height - 1, Math.floor(region.y)));
  const rw = Math.max(1, Math.min(width - rx, Math.ceil(region.w)));
  const rh = Math.max(1, Math.min(height - ry, Math.ceil(region.h)));
  const ryb = height - (ry + rh);
  const x0 = Math.floor(rx / phase) * phase;
  const y0 = Math.floor(ryb / phase) * phase;
  return {
    X: x0, YBottom: y0,
    W: Math.min(width - x0, Math.ceil((rx + rw - x0) / phase) * phase),
    H: Math.min(height - y0, Math.ceil((ryb + rh - y0) / phase) * phase),
  };
};

// `glass-grid`: five columns of four, 236pt pitch, laid out on the 2560x1600 canvas.
const PITCH_X = (CARD_W_PT + GAP_PT) * DPR;
const PITCH_Y = (CARD_H_PT + GAP_PT) * DPR;
const BOX_W = CARD_W_PT * DPR;
const BOX_H = CARD_H_PT * DPR;
const COLS = 5, ROWS = 4;
const ORIGIN_X = Math.floor((CANVAS_W - (COLS * PITCH_X - GAP_PT * DPR)) / 2);
const ORIGIN_Y = Math.floor((CANVAS_H - (ROWS * PITCH_Y - GAP_PT * DPR)) / 2);
const boxes = (): { x: number; y: number }[] => {
  const out: { x: number; y: number }[] = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    out.push({ x: ORIGIN_X + c * PITCH_X, y: ORIGIN_Y + r * PITCH_Y });
  }
  return out;
};

describe('the grid law — a region-sized source is a CROP, not a resample', () => {
  const RADIUS = Math.max(1, FROST_PT) * DPR;
  const P = cardGrid(1 << pyramidDepth(RADIUS));

  it('glass-grid resolves to depth 2, phase 4, and k=1 measured against the CANVAS', () => {
    // `Jaui.ts` floors a surface's own sigma at 1pt, so radius = max(1, 4pt) * 2 = 8 device px.
    expect(RADIUS).toBe(8);
    expect(pyramidDepth(RADIUS)).toBe(2);
    expect(P).toBe(4);
    const region = cardRegion(ORIGIN_X, ORIGIN_Y, BOX_W, BOX_H, fillMarginDev(DPR), paintMarginDev(DPR), P);
    expect(baseFactor(RADIUS, region.W * region.H)).toBe(1);
  });

  it('a card-sized input would pick a COARSER factor, which is why the source is the canvas', () => {
    // One of the three corrections the card-sourced build needed, kept as the record of why the
    // source moved rather than of how the correction was written. `BaseDownsampleFactor` gates on
    // the region's share of its INPUT's area, and a card-sized input makes every region ~100% of
    // it -- so the gate that keeps a little glass card at full density against a 2560x1600 canvas
    // stops holding the moment the source shrinks to the card. Against the canvas it needs no
    // correction at all: it picks what it always picked.
    const region = cardRegion(ORIGIN_X, ORIGIN_Y, BOX_W, BOX_H, fillMarginDev(DPR), paintMarginDev(DPR), P);
    const againstCard = (): number => {
      if (RADIUS <= 4) return 1;
      if (region.W * region.H < 0.15 * region.W * region.H) return 1;
      return Math.min(8, 1 << Math.floor(Math.log2(RADIUS / 4)));
    };
    expect(againstCard()).toBe(2);
    expect(againstCard()).not.toBe(baseFactor(RADIUS, region.W * region.H));
  });

  it('the CORRECTIONS were the bug: a card-sized source rounds every uniform differently', () => {
    // 4,057 pixels at channel delta 1, all inside card boxes, with the seed, the replay and the
    // write-back bit-exact around them. `LastRegion.OffsetX` is the smallest example that can be
    // written down: against the canvas `BlurPass` computes -rect.X / rect.W in one division;
    // against a card it computes -rectLocal.X / rect.W and the consumer then subtracts
    // card.X * (card.W / rect.W) / card.W, which is the SAME REAL NUMBER by three more roundings.
    // They disagree in the last bit, and a bilinear weight one ulp off is a scattered 1 LSB.
    //
    // It does not disagree on every card, which is also what the gate measured: the pixels were
    // scattered, 32 to 430 per card, not a uniform wash. So the claim is scanned, not sampled.
    const margin = fillMarginDev(DPR);
    let same = 0, differ = 0;
    for (const b of boxes()) {
      const c = cardRegion(b.x, b.y, BOX_W, BOX_H, margin, paintMarginDev(DPR), P);
      const region = {
        x: Math.max(0, Math.floor(b.x - margin)), y: Math.max(0, Math.floor(b.y - margin)),
        w: Math.ceil(BOX_W + margin * 2), h: Math.ceil(BOX_H + margin * 2),
      };
      const r = resolveRegionRect(region, CANVAS_W, CANVAS_H, P);
      const direct = -r.X / r.W;
      const viaCard = -(r.X - c.X) / r.W - c.X * (c.W / r.W) / c.W;
      expect(viaCard).toBeCloseTo(direct, 12);    // the same real number, every time...
      if (Object.is(viaCard, direct)) same++; else differ++;
    }
    expect(differ).toBeGreaterThan(0);            // ...and not always the same float
    expect(same).toBeGreaterThan(0);              // ...and not always a different one either
  });

  it('every card origin is on the grid, on BOTH axes, measured from x=0 and from the BOTTOM', () => {
    // The whole identity argument: floor((rx - X) / phase) * phase == floor(rx / phase) * phase - X
    // exactly when phase divides X. `ResolveRegionRect` works in the input's texels and measures y
    // from the bottom, so the BOTTOM gap carries the same condition as the left edge.
    for (const b of boxes()) {
      const c = cardRegion(b.x, b.y, BOX_W, BOX_H, fillMarginDev(DPR), paintMarginDev(DPR), P);
      expect(c.X % P).toBe(0);
      expect((CANVAS_H - c.Y - c.H) % P).toBe(0);
    }
  });

  it('the pyramid resolves to the SAME absolute texels against the card as against the canvas', () => {
    const margin = fillMarginDev(DPR);
    for (const b of boxes()) {
      const c = cardRegion(b.x, b.y, BOX_W, BOX_H, margin, paintMarginDev(DPR), P);
      // The sample region `Jaui.ts` hands `ComputeBlur`, in screen device px.
      const region = {
        x: Math.max(0, Math.floor(b.x - margin)),
        y: Math.max(0, Math.floor(b.y - margin)),
        w: Math.min(CANVAS_W, Math.ceil(BOX_W + margin * 2)),
        h: Math.min(CANVAS_H, Math.ceil(BOX_H + margin * 2)),
      };
      const onCanvas = resolveRegionRect(region, CANVAS_W, CANVAS_H, P);
      const onCard = resolveRegionRect(
        { x: region.x - c.X, y: region.y - c.Y, w: region.w, h: region.h }, c.W, c.H, P,
      );
      // Same extent, and the same absolute origin once the card's own offsets are added back.
      expect(onCard.W).toBe(onCanvas.W);
      expect(onCard.H).toBe(onCanvas.H);
      expect(onCard.X + c.X).toBe(onCanvas.X);
      expect(onCard.YBottom + (CANVAS_H - c.Y - c.H)).toBe(onCanvas.YBottom);
    }
  });

  it('an UNALIGNED card origin moves the texels, which is what the grid law exists to stop', () => {
    // The negative control. Shift one card's origin off the grid by a single pixel and the same
    // region resolves to a different absolute rect -- different neighbours averaged at every level.
    const margin = fillMarginDev(DPR);
    const b = boxes()[6];
    const c = cardRegion(b.x, b.y, BOX_W, BOX_H, margin, paintMarginDev(DPR), P);
    const region = { x: Math.floor(b.x - margin), y: Math.floor(b.y - margin), w: Math.ceil(BOX_W + margin * 2), h: Math.ceil(BOX_H + margin * 2) };
    const onCanvas = resolveRegionRect(region, CANVAS_W, CANVAS_H, P);
    const skewed = { X: c.X + 1, Y: c.Y, W: c.W, H: c.H };
    const onSkewed = resolveRegionRect(
      { x: region.x - skewed.X, y: region.y - skewed.Y, w: region.w, h: region.h }, skewed.W, skewed.H, P,
    );
    expect(onSkewed.X + skewed.X).not.toBe(onCanvas.X);
  });

  it('the card target is 584 x 452 — the pyramid rect plus the read guard on every side', () => {
    // Still ONE size for twenty cards, so the pool keeps one bucket; and still not a new size for
    // the blur level chain, which is sized by the RESOLVED RECT (568x436, unmoved) and not by the
    // target the bytes came out of. The 8 px a side is `CardReadGuard(4)` rounded up to a phase.
    const sizes = new Set(boxes().map((b) => {
      const c = cardRegion(b.x, b.y, BOX_W, BOX_H, fillMarginDev(DPR), paintMarginDev(DPR), P);
      return `${c.W}x${c.H}`;
    }));
    expect(sizes.size).toBe(1);
    expect([...sizes][0]).toBe('584x452');
    expect(cardGuardBand(P)).toBe(8);
    // The rect the chain is allocated at, which is what the old size named.
    const margin = fillMarginDev(DPR);
    const b = boxes()[0];
    const rect = resolveRegionRect({
      x: Math.max(0, Math.floor(b.x - margin)), y: Math.max(0, Math.floor(b.y - margin)),
      w: Math.ceil(BOX_W + margin * 2), h: Math.ceil(BOX_H + margin * 2),
    }, CANVAS_W, CANVAS_H, P);
    expect(`${rect.W}x${rect.H}`).toBe('568x436');
  });

  it('the guard CONTAINS every texel a build can read, on all four edges, for all twenty cards', () => {
    // The property the whole read path now rests on. The build's source is a canvas-sized texture
    // that holds this card's bytes over its BOX and last frame's everywhere else, so a tap one
    // texel outside the box is a wrong pixel -- and the two edges coincide EXACTLY without the
    // guard, which the negative control below measures rather than asserts by eye.
    const reach = cardReadGuard(P);
    for (const b of boxes()) {
      const c = cardRegion(b.x, b.y, BOX_W, BOX_H, fillMarginDev(DPR), paintMarginDev(DPR), P);
      const cYBottom = CANVAS_H - c.Y - c.H;
      // Both builds under a composite: the fill's region, and the rim overlay's smaller one
      // (frost + 8 px, with no refraction footprint and no chromatic aberration in it).
      for (const m of [fillMarginDev(DPR), Math.max(1, FROST_PT) * DPR + 8 * DPR]) {
        const r = resolveRegionRect({
          x: Math.max(0, Math.floor(b.x - m)), y: Math.max(0, Math.floor(b.y - m)),
          w: Math.min(CANVAS_W, Math.ceil(BOX_W + m * 2)), h: Math.min(CANVAS_H, Math.ceil(BOX_H + m * 2)),
        }, CANVAS_W, CANVAS_H, P);
        expect(r.X - c.X).toBeGreaterThanOrEqual(reach);
        expect((c.X + c.W) - (r.X + r.W)).toBeGreaterThanOrEqual(reach);
        expect(r.YBottom - cYBottom).toBeGreaterThanOrEqual(reach);
        expect((cYBottom + c.H) - (r.YBottom + r.H)).toBeGreaterThanOrEqual(reach);
      }
    }
  });

  it('WITHOUT the guard the fill rect and the box share an edge exactly — zero slack', () => {
    // The negative control, and the reason the guard is not decoration. The paint margin (36) sits
    // far inside the sample margin (64.75) and contributes nothing, and both edges land on
    // floor((px - 64.75) / 4) * 4, the same number -- so the first DOWN hop's 1.15-texel tap reads
    // past the only pixels the composite has.
    const margin = fillMarginDev(DPR);
    const unguarded = (px: number, pw: number): number =>
      Math.max(0, Math.floor((px - Math.max(margin, paintMarginDev(DPR))) / P) * P);
    for (const b of boxes()) {
      const r = resolveRegionRect({
        x: Math.max(0, Math.floor(b.x - margin)), y: Math.max(0, Math.floor(b.y - margin)),
        w: Math.ceil(BOX_W + margin * 2), h: Math.ceil(BOX_H + margin * 2),
      }, CANVAS_W, CANVAS_H, P);
      expect(r.X - unguarded(b.x, BOX_W)).toBe(0);
    }
  });
});

describe('the replay rule — a seeded target equals what the scene held', () => {
  const P = 4;
  const margin = fillMarginDev(DPR);
  const paint = paintMarginDev(DPR);

  it('a card PAINTS 36 px past its box and its region REACHES 68, which is why replay is needed', () => {
    // The paint rect is what a later surface replays; the region is what it needs filled. The gap
    // is 40 px, so paint stops 4 px short of the neighbour's box and the region lands 68 px in.
    expect(paint).toBe(36);
    expect(margin).toBeCloseTo(64.75, 6);
    const gap = GAP_PT * DPR;
    expect(gap).toBe(40);
    expect(paint).toBeLessThan(gap);              // no card's ink reaches its neighbour's BOX
    expect(margin).toBeGreaterThan(gap);          // but every card's region reaches its neighbour
  });

  it('an interior card replays exactly four earlier neighbours, and they total ~0.064 Mpx', () => {
    const all = boxes();
    const idx = 2 * COLS + 2;                     // row 2, column 2: interior on both axes
    const me = cardRegion(all[idx].x, all[idx].y, BOX_W, BOX_H, margin, paint, P);
    let n = 0, px = 0;
    for (let j = 0; j < idx; j++) {
      const e = all[j];
      const x0 = Math.max(e.x - paint, me.X), x1 = Math.min(e.x + BOX_W + paint, me.X + me.W);
      const y0 = Math.max(e.y - paint, me.Y), y1 = Math.min(e.y + BOX_H + paint, me.Y + me.H);
      if (x1 <= x0 || y1 <= y0) continue;
      n++;
      px += (x1 - x0) * (y1 - y0);
    }
    expect(n).toBe(4);                            // left, above, above-left, above-right
    expect(px / 1e6).toBeGreaterThan(0.05);
    expect(px / 1e6).toBeLessThan(0.08);
  });

  it('no earlier card PAINTS into a later card\'s own box, so every shadow probe is free', () => {
    // `MeasureShadowBackdrop` samples strictly inside the surface's box. When nothing earlier has
    // painted there the frame snapshot already holds those bytes, so the probe costs no copy.
    const all = boxes();
    for (let i = 0; i < all.length; i++) {
      for (let j = 0; j < i; j++) {
        const e = all[j], m = all[i];
        const hit = m.x < e.x + BOX_W + paint && m.x + BOX_W > e.x - paint
                 && m.y < e.y + BOX_H + paint && m.y + BOX_H > e.y - paint;
        expect(hit).toBe(false);
      }
    }
  });

  it('the copy traffic is ~24 Mpx a frame against 320 Mpx of store-and-load it replaces', () => {
    // Four kinds now, not three. The frame snapshot, the seeds, the replays and the write-backs are
    // what the folded lane paid (~15.0 Mpx, of which ~0.8 is the read guard's 6.6% bigger box); the
    // BACKDROP RESOLVES are what exactness costs (~8.4 Mpx). Both are priced here so the number the
    // orchestrator measures has something to be wrong against.
    const all = boxes();
    const reach = cardReadGuard(P);
    const rimMargin = Math.max(1, FROST_PT) * DPR + 8 * DPR;
    const regionOf = (px: number, py: number, m: number): { x: number; y: number; w: number; h: number } => ({
      x: Math.max(0, Math.floor(px - m)), y: Math.max(0, Math.floor(py - m)),
      w: Math.min(CANVAS_W, Math.ceil(BOX_W + m * 2)), h: Math.min(CANVAS_H, Math.ceil(BOX_H + m * 2)),
    });
    let blit = CANVAS_W * CANVAS_H;               // the one frame snapshot
    let resolves = 0, copies = 0, free = 0;
    for (let i = 0; i < all.length; i++) {
      const me = cardRegion(all[i].x, all[i].y, BOX_W, BOX_H, margin, paint, P);
      blit += me.W * me.H;                        // seed
      blit += me.W * me.H;                        // write-back
      for (let j = 0; j < i; j++) {
        const e = all[j];
        const x0 = Math.max(e.x - paint, me.X), x1 = Math.min(e.x + BOX_W + paint, me.X + me.W);
        const y0 = Math.max(e.y - paint, me.Y), y1 = Math.min(e.y + BOX_H + paint, me.Y + me.H);
        if (x1 > x0 && y1 > y0) blit += (x1 - x0) * (y1 - y0);
      }
      // The fill's build sees a CLEAN card, so it copies only when an earlier surface's paint can
      // reach what it reads. The rim's build always sees a dirty one and always copies.
      const clip = (r: { x: number; y: number; w: number; h: number }): number => {
        const x0 = Math.max(me.X, r.x - reach), y0 = Math.max(me.Y, r.y - reach);
        const x1 = Math.min(me.X + me.W, r.x + r.w + reach), y1 = Math.min(me.Y + me.H, r.y + r.h + reach);
        return (x1 - x0) * (y1 - y0);
      };
      const fill = regionOf(all[i].x, all[i].y, margin);
      let painted = false;
      for (let j = 0; j < i; j++) {
        const e = all[j];
        if (fill.x - reach < e.x + BOX_W + paint && fill.x + fill.w + reach > e.x - paint
            && fill.y - reach < e.y + BOX_H + paint && fill.y + fill.h + reach > e.y - paint) { painted = true; break; }
      }
      if (painted) { copies++; resolves += clip(fill); } else free++;
      copies++; resolves += clip(regionOf(all[i].x, all[i].y, rimMargin));
    }
    expect(free).toBe(1);                          // card 0 alone has nothing earlier to reach it
    expect(copies).toBe(39);                       // 19 fills + 20 rims
    expect(resolves / 1e6).toBeGreaterThan(8);
    expect(resolves / 1e6).toBeLessThan(9);
    const total = blit + resolves;
    const replaced = 39 * 2 * CANVAS_W * CANVAS_H; // 39 encoder ends, store + load, whole canvas
    expect(total / 1e6).toBeGreaterThan(23);
    expect(total / 1e6).toBeLessThan(26);
    expect(replaced / total).toBeGreaterThan(12);
  });

  it('twenty live targets is ~20 MB, one pool bucket, released at the drain', () => {
    const c = cardRegion(boxes()[0].x, boxes()[0].y, BOX_W, BOX_H, margin, paint, P);
    const mb = (c.W * c.H * 4 * CARDS) / (1024 * 1024);
    expect(mb).toBeGreaterThan(19);
    expect(mb).toBeLessThan(22);
  });
});

describe('glass-grid — what the switch column should read now', () => {
  it('the composited walk ends the scene encoder ONCE', () => {
    // The bed draws; the first surface cuts the frame snapshot, which is the one non-scene bind
    // over a dirty scene in the whole frame; every card after it is seeded by a BLIT from that
    // snapshot, builds its pyramid from its own target and draws into it, so the scene is never
    // dirtied again until the write-backs land at the end.
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let band = 0; band < 6; band++) l.NoteWrite();  // the bed
    l.NoteRead(); l.NoteTargetBind('snapshot');           // the one full-canvas cut
    for (let card = 0; card < CARDS; card++) {
      l.NoteTargetBind('card');                           // the seed blit's target bind
      l.NoteTargetBind('blur');                           // fill build, from the CARD
      l.NoteTargetBind('shadow-state');                   // the adaptive probe
      l.NoteTargetBind('blur');                           // rim build, from the CARD
      l.NoteTargetBind('card');                           // rebind after each of the above
    }
    // The drain: twenty blits into the scene, then the present.
    l.NoteFrameEndDrain();
    expect(l.Switches).toBe(1);
    expect(l.Restarts).toBe(1);
    expect(l.Reads).toBe(1);
  });

  it('a card bind is not free by fiat — it costs a switch exactly when the scene IS dirty', () => {
    // The ledger is not special-cased for this path and must not be: a seed bind taken while the
    // bed is unresolved really is an encoder end, and that is the fallback's honest price.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteTargetBind('card');
    expect(l.Switches).toBe(1);
    l.NoteTargetBind('card');
    expect(l.Switches).toBe(1);
  });

  it('a page that draws into the scene between surfaces lands between 1 and the old 40', () => {
    // Three glass surfaces with a plain panel between each pair: every run of glass costs one cut.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();                                        // the page
    for (let run = 0; run < 3; run++) {
      l.NoteRead(); l.NoteTargetBind('snapshot');          // re-cut over the direct draw
      l.NoteTargetBind('card'); l.NoteTargetBind('blur'); l.NoteTargetBind('blur');
      l.NoteWrite();                                       // the drain, then the panel
    }
    l.NoteFrameEndDrain();
    expect(l.Switches).toBe(3);
    expect(l.Switches).toBeLessThan(40);
    expect(l.Switches).toBeGreaterThan(1);
  });
});

describe('the renderer actually does what the arithmetic assumes', () => {
  const renderer = readRenderer();

  it('every card bind goes through `_tgt`, so the ledger sees it', () => {
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain("this._tgt('card');");
    expect(arrowBody(renderer, 'RebindSceneTarget')).toContain("this._tgt('card');");
  });

  it('the seed, the replay and the write-back are BLITS — the path adds no draw call', () => {
    const begin = arrowBody(renderer, 'BeginCardComposite');
    const drain = arrowBody(renderer, '_drainCards');
    expect(begin).toContain('gl.blitFramebuffer(');
    expect(drain).toContain('gl.blitFramebuffer(');
    // A draw into the scene is what re-opens its render encoder. If either of these ever became a
    // textured quad the count would go straight back to one end per surface.
    expect(begin).not.toMatch(/gl\.draw(Arrays|Elements)/);
    expect(drain).not.toMatch(/gl\.draw(Arrays|Elements)/);
    expect(arrowBody(renderer, '_cardIntoSnapshotTex')).not.toMatch(/gl\.draw(Arrays|Elements)/);
  });

  it('the seed comes from the FRAME snapshot, which is not the scissored `_snapshotTex`', () => {
    // They are different textures on purpose: the sharp-tap path writes CARD pixels into
    // `_snapshotTex`, and sharing one would corrupt every later card's seed.
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain('this._frameSnapFbo');
    expect(arrowBody(renderer, '_cardIntoSnapshotTex')).toContain('this._snapshotFbo');
    expect(renderer).toContain('private _frameSnapTex: WebGLTexture | null = null;');
  });

  it('the write-back is deferred, because doing it eagerly puts the encoder ends back', () => {
    // Eagerly writing card i back re-dirties the scene, so card i+1's seed bind ends the encoder
    // again -- twenty ends instead of one, which is the whole finding undone.
    expect(arrowBody(renderer, 'EndCardComposite')).toContain('this._cardQueue.push(card);');
    expect(arrowBody(renderer, 'EndCardComposite')).not.toContain('blitFramebuffer');
  });

  it('anything that draws directly into the scene drains the queue FIRST', () => {
    const body = arrowBody(renderer, '_noteSceneDraw');
    expect(body).toContain('this._drainCards(true)');
    expect(body.indexOf('_drainCards')).toBeLessThan(body.indexOf('NoteWrite'));
    // ...and the old semantics are byte-for-byte intact beside it.
    expect(body).toContain("if (this._boundTarget === 'scene') this._sceneLedger.NoteWrite();");
  });

  it('anything that READS the scene drains it first too', () => {
    // A surface that fell back is about to sample the attachment, and the surfaces before it may
    // still be in card targets. Without this its backdrop is missing every queued card.
    expect(getterBody(renderer, 'SceneTexture')).toContain('this._drainCards(true)');
    expect(arrowBody(renderer, '_snapshotBlit')).toContain('this._drainCards(true)');
    expect(arrowBody(renderer, 'BuildSharedBackdrop')).toContain('this._drainCards(true)');
  });

  it('the drain writes back in ASCENDING order, blend-disabled, one region each', () => {
    const body = arrowBody(renderer, '_drainCards');
    expect(body).toContain('for (let i = 0; i < q.length; i++)');
    expect(body).toContain('this._sceneFbo.Framebuffer');
    // blitFramebuffer is a replace: it is not affected by blend, which is what makes "the bytes the
    // scene would have held" an exact statement rather than an approximate one.
    expect(body).not.toContain('EnableBlend');
  });

  it('the card branch builds from the CANVAS, with the SCREEN region and no pinned factor', () => {
    // The whole of the fix. `pass.Blur` is handed `this._width, this._height` and the caller's own
    // `region` -- the identical arguments the in-scene branch two lines below passes -- so every
    // uniform downstream (`u_SrcRect`, `u_HalfPixel`, `LastRegion`, and the `u_BackdropXf` the
    // panel shader taps through) is computed from the same numbers and rounds the same way.
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body).toContain('pass.Blur(src, this._width, this._height, radius, minDepth, region)');
    // No card dimensions and no pinned base factor reach the pass any more.
    expect(body).not.toContain('blurCard.W, blurCard.H');
    expect(body).not.toContain('BaseDownsampleFactor(');
    // The map comes back in screen UV already, so nothing re-expresses it.
    expect(body).toContain('return _wrap(result, pass.LastRegion);');
    expect(body).not.toContain('_cardRegionToScreen');
    // ...and the old path, and its ledger note, are untouched ahead of it.
    expect(body).toContain('if (_unwrap(input) === this._sceneFbo.Texture) this._sceneLedger.NoteRead();');
    expect(body.indexOf("NoteTargetBind('blur')")).toBeLessThan(body.indexOf('blurCard'));
  });

  it('`_cardRegionToScreen` is GONE, not merely unused', () => {
    // It existed to correct a card-UV map into screen UV, and correcting it is exactly what could
    // not be made exact. A dead private that still compiles is an invitation to route through it.
    expect(renderer).not.toContain('_cardRegionToScreen');
  });

  it('the source is resolved to a canvas-sized texture BEFORE the build, with the read guard', () => {
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body).toContain('this._cardBackdropSource(blurCard, region, CardReadGuard(this._cardGridPhase))');
    expect(body.indexOf('_cardBackdropSource')).toBeLessThan(body.indexOf('pass.Blur(src'));
    // A full-input pyramid reads the whole canvas and a composite has truth only over its box.
    expect(body).toContain('throw new Error');
  });

  it('a dirty card is copied into the snapshot; a clean, unpainted one is not', () => {
    const body = arrowBody(renderer, '_cardBackdropSource');
    expect(body).toContain('!card.Dirty');
    expect(body).toContain('return this._frameSnapTex;');
    expect(body).toContain('return this._cardIntoSnapshotTex(');
    // The queue scan is the other half of the free path: a card's seed carries its earlier
    // neighbours' ink and the frame snapshot does not.
    expect(body).toContain('this._cardQueue[i]');
    // The guard widens BOTH the test and the copy's scissor -- a read that can reach a queued
    // surface's paint must not take the snapshot, and a copy must cover what the build reads.
    expect(body).toContain('const x0 = rect.x - guard, y0 = rect.y - guard;');
    expect(body).toContain('{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }');
  });

  it('the shadow probe keeps guard 0, so its free path is byte-for-byte what it was', () => {
    // It samples strictly inside its rect. Widening its test would make 20 free probes into
    // 20 copies for a reach it does not have.
    // Asserted against the file rather than `arrowBody`: the tap is now a one-expression arrow
    // with no braces for the matcher to walk.
    expect(renderer).toContain('): WebGLTexture => this._cardBackdropSource(card, rect, 0);');
  });

  it('the sub-window is the VIEWPORT, so `u_Resolution` stays the canvas', () => {
    // `Jiv.Panel.frag` reads its backdrop at `v_PixelPos / u_Resolution` -- a SCREEN uv. The layer
    // cache's retarget (shrink the resolution, offset the projection) would rescale every
    // refraction tap by canvas/card. A negative viewport origin moves the raster and nothing else.
    const body = arrowBody(renderer, '_cardViewport');
    expect(body).toContain('this._gl.viewport(-card.X, -(this._height - card.Y - card.H), this._width, this._height)');
    expect(arrowBody(renderer, 'RebindSceneTarget')).not.toContain('_captureViewOffset');
  });

  it('the grid phase is a power of two and is handed over once a frame', () => {
    expect(arrowBody(renderer, 'SetCardGrid'))
      .toContain('1 << Math.ceil(Math.log2(Math.max(1, phase)))');
    expect(readJaui()).toContain('this._renderer.SetCardGrid(this._renderer.CardGridPhaseFor(');
  });

  it('a nested surface reads its PARENT card rather than opening another', () => {
    // Correct and region-sized: its encoder ends cost a 1 MB target instead of a 16 MB one, and a
    // seed cut from a target that is still being drawn into would not be a seed.
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain('if (this._cardStack.length !== 0) return false;');
    expect(getterBody(renderer, 'SceneTexture')).toContain('if (card !== null) return _wrap(card.Fbo.Texture);');
  });

  it('the area gate keeps k at 1 and keeps a full-screen scrim on the old path', () => {
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain('0.15 * W * H');
  });

  it('the pool releases at the DRAIN, not when a surface finishes drawing', () => {
    // A later surface in the same run replays out of an earlier one's target, so the lifetime is
    // the run and not the surface.
    expect(arrowBody(renderer, '_drainCards')).toContain('Release(c.Fbo)');
    expect(arrowBody(renderer, 'EndCardComposite')).not.toContain('Release');
  });

  it('the whole path has a gate and a per-frame count', () => {
    const jaui = readJaui();
    expect(jaui).toContain("params.has('cardcomposite')");
    expect(jaui).toContain("params.has('no-cardcomposite')");
    expect(jaui).toContain('this._counts.CardComposites = this._renderer.CardComposites;');
    expect(jaui).toContain('cards=${c.CardComposites}');
  });

  it('BeginFrame resets the card state ahead of the split-frame early return', () => {
    const body = arrowBody(renderer, 'BeginFrame');
    expect(body.indexOf('this._frameSnapValid = false;')).toBeLessThan(body.indexOf('_beginPassFrame'));
  });

  it('a resize drops every retained target — they are the OLD canvas\'s regions', () => {
    expect(arrowBody(renderer, 'Resize')).toContain('this._cardPool?.Dispose();');
  });
});

describe('Jaui only composites what it can reproduce exactly', () => {
  const jaui = readJaui();

  it('a gradient fill anywhere in the subtree keeps the surface on the in-scene path', () => {
    // The one fragment whose output depends on WHERE it rasterises: the gradient dither hashes
    // `gl_FragCoord`, which is framebuffer space. Sub-LSB, invisible, and not zero -- and the
    // density rule for this lane is zero differing pixels.
    const body = arrowBody(jaui, '_subtreeHasUnretargetable');
    expect(body).toContain("_bgk === 'LinearGradient' || _bgk === 'RadialGradient'");
    expect(jaui).toContain('&& !this._subtreeHasUnretargetable(node)');
  });

  it('the glass branch opens the composite BEFORE the snapshot, the pyramid and the draw', () => {
    const body = arrowBody(jaui, '_render');
    const open = body.indexOf('r2.BeginCardComposite(');
    expect(open).toBeGreaterThan(-1);
    // The FILL's build, which is the one after the open -- the rim overlay's identical call sits
    // earlier in the file, inside `descendChildren`.
    expect(body.indexOf('lastBackdrop = r.ComputeBlur(r.SceneTexture', open)).toBeGreaterThan(open);
    expect(body.indexOf('r.PanelDrawBatch(w, h, lastBackdrop', open)).toBeGreaterThan(open);
  });

  it('the bracket closes AFTER the children, because the rim paints among them', () => {
    const body = arrowBody(jaui, '_render');
    const walk = body.lastIndexOf('descendChildren(node, eff, stack, scope, effH, childPersp);');
    const close = body.indexOf('(r2 as WebGL2Renderer).EndCardComposite();');
    expect(walk).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(walk);
  });

  it('the pending batches drain into the CARD before it closes', () => {
    // Anything still buffered belongs to this subtree; flushed after the close it would land in the
    // scene, on top of the write-back instead of inside it.
    const body = arrowBody(jaui, '_render');
    const close = body.indexOf('(r2 as WebGL2Renderer).EndCardComposite();');
    const flush = body.lastIndexOf('flushText();', close);
    expect(flush).toBeGreaterThan(-1);
    expect(flush).toBeLessThan(close);
  });

  it('only a node that can put INK down pushes a direct-scene footprint', () => {
    // A container with a transparent background covers the page. Pushing its AABB would make every
    // surface on that page re-cut the snapshot for nothing.
    const body = arrowBody(jaui, '_render');
    expect(body).toContain('r2.NoteSceneFootprint(');
    expect(body).toContain('const _inked = node.EffectiveOpacity > 0.001 && (');
    expect(body).toContain('!r2.CardActive');
  });

  it('every pending write-back lands before the frame is presented', () => {
    const body = arrowBody(jaui, '_render');
    expect(body).toContain('this._renderer.FlushCardComposites();');
    expect(body.indexOf('FlushCardComposites')).toBeLessThan(body.indexOf('r.PresentScene()'));
  });
});

describe('nesting — a glass child reads its parent card, and nothing pretends otherwise', () => {
  const renderer = readRenderer();

  it('the sharp tap falls back to a COPY the moment the card has ink in it', () => {
    // The snapshot shortcut is only sound while the target still equals the snapshot over its
    // region. A nested surface's backdrop is its parent's card WITH the parent's fill and children
    // already down, and the snapshot holds none of that -- so `Dirty` gates it, not just the
    // earlier-cards test, which sees nothing because the parent is on the stack and not the queue.
    const body = arrowBody(renderer, '_cardBackdropSource');
    expect(body).toContain('!card.Dirty');
    expect(arrowBody(renderer, '_noteSceneDraw')).toContain("if (this._boundTarget === 'card')");
  });

  it('a card is born clean, so the TOP-LEVEL probe still pays nothing', () => {
    // The probe runs between the fill's pyramid build and the fill's draw, so the card it reads has
    // had nothing drawn into it yet: on `glass-grid` all twenty take the free path.
    expect(arrowBody(renderer, 'BeginCardComposite')).toContain('Dirty: false,');
  });
});

// ── The gate ──────────────────────────────────────────────────────────────────────────────────
//
// The composite is an INSTRUMENT, not a fix. It is the only experiment in the sequence that moves
// scene-encoder ends and nothing else -- ends 40 -> 1 with draws per tick held constant at ~152 --
// and what it measured is that the frame gets 6.6% SLOWER (66.75 -> 71.49 GPU ms at dpr 2). So the
// code stays and the default goes off: an unflagged build must be the engine it was before any of
// this landed, or every anchor in the ledger was taken against a different renderer than the one
// the next reading comes off.

describe('the gate — default OFF, `?cardcomposite` on, `?no-cardcomposite` over both', () => {
  const renderer = readRenderer();
  const jaui = readJaui();

  it('the field defaults to false, so an unflagged build takes the pre-composite walk', () => {
    expect(renderer).toMatch(/\n\s*CardCompositeEnabled = false;/);
    expect(renderer).not.toContain('CardCompositeEnabled = true');
  });

  it('`?cardcomposite` sets it and `?no-cardcomposite` is assigned SECOND, so it wins', () => {
    // Both flags on one command line is a mistake, and the mistake should land on the shipped
    // default rather than silently on the instrument. Last write wins, so the order IS the rule.
    const on = jaui.indexOf("params.has('cardcomposite') && this._renderer instanceof WebGL2Renderer) this._renderer.CardCompositeEnabled = true;");
    const off = jaui.indexOf("params.has('no-cardcomposite') && this._renderer instanceof WebGL2Renderer) this._renderer.CardCompositeEnabled = false;");
    expect(on).toBeGreaterThan(-1);
    expect(off).toBeGreaterThan(on);
  });

  it('Init says the flag arrived, beside the other three measurement marks', () => {
    // Same contract as `?snap-once`, `?blur-dummy` and `?blur-src`: a reading of the composite walk
    // without this line in the trace is a reading of the wrong build. No `pixels=WRONG` -- this one
    // is pixel-identical by construction (<= 115 single-LSB ties on win32, 0 on Metal).
    expect(renderer).toContain("if (this.CardCompositeEnabled) JTrace('jaui:cardcomposite armed=true');");
    const dummy = renderer.indexOf("JTrace('jaui:blur-dummy armed=true pixels=WRONG');");
    const mark = renderer.indexOf("JTrace('jaui:cardcomposite armed=true');");
    expect(dummy).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(dummy);
  });

  it('with the gate shut every entry point returns before it touches GL', () => {
    // `BeginCardComposite` is the only door in: its check is the FIRST statement, ahead of the size
    // test, the region arithmetic, the snapshot and the pool. The other three cannot do anything
    // without it, and each says so itself rather than by inheritance.
    const begin = arrowBody(renderer, 'BeginCardComposite');
    expect(begin.indexOf('if (!this.CardCompositeEnabled) return false;')).toBe(begin.indexOf('if ('));
    expect(arrowBody(renderer, 'NoteSceneFootprint')).toContain('if (!this.CardCompositeEnabled) return;');
    expect(arrowBody(renderer, 'EndCardComposite')).toContain('if (card === undefined) return;');
    expect(arrowBody(renderer, '_drainCards')).toContain('if (this._cardQueue.length === 0) return;');
  });

  it('no composite texture, pool bucket or snapshot is created without it', () => {
    // Every allocation the path makes is DOWNSTREAM of the gate, in `BeginCardComposite`'s own
    // body: the pool is constructed there and nowhere else, the frame snapshot is cut from there
    // and nowhere else, and the two lists are only ever pushed to from the bracket. With the gate
    // shut the stack and the queue stay empty, so every other card branch in the renderer -- they
    // all test `_activeCard` or `_cardQueue.length` -- takes its null arm.
    const begin = arrowBody(renderer, 'BeginCardComposite');
    expect(begin).toContain('new FramebufferPool(gl)');
    expect(renderer.split('new FramebufferPool(').length - 1).toBe(1);
    expect(begin).toContain('this._ensureFrameSnapshot(');
    expect(renderer.split('this._ensureFrameSnapshot(').length - 1).toBe(1);
    expect(begin).toContain('this._cardStack.push(card);');
    expect(renderer.split('this._cardStack.push(').length - 1).toBe(1);
    expect(arrowBody(renderer, 'EndCardComposite')).toContain('this._cardQueue.push(card);');
    expect(renderer.split('this._cardQueue.push(').length - 1).toBe(1);
  });

  it('an unflagged frame reads cards 0 and cardFallbacks 0, not 0 and 20', () => {
    // A gate placed after the area test would count twenty fallbacks a frame and read as though the
    // path had been tried and refused. Both counters are incremented strictly after the gate.
    const begin = arrowBody(renderer, 'BeginCardComposite');
    const gate = begin.indexOf('if (!this.CardCompositeEnabled) return false;');
    expect(gate).toBeGreaterThan(-1);
    expect(begin.indexOf('this._cardFallbacks++')).toBeGreaterThan(gate);
    expect(begin.indexOf('this._cardComposites++')).toBeGreaterThan(gate);
  });

  it('the ledger keeps its columns with the gate shut — they are read, not conditioned', () => {
    // `cards=` / `cardFallbacks=` / `EndsByKey` stay on the per-second line, on `jaui:render:end`
    // and on `__jauiSceneLedger()` whatever the flag says. On unflagged `glass-grid` they read
    // 0 / 0 / {blur: 40}: a zero that is measured, which is the only kind worth printing.
    expect(jaui).toContain('this._counts.CardFallbacks = this._renderer.CardFallbacks;');
    expect(jaui).toContain('cardFallbacks=${c.CardFallbacks}');
    expect(jaui).toContain('endsByKey=${_endsByKey(c.SceneEndsByKey)}');
    expect(jaui).toContain('_endsByKey(this._counts.SceneEndsByKey)');
    expect(jaui).toContain('& { EndsByKey: Record<string, number> }');
    expect(jaui).toContain('cards ${c.CardComposites} (fallback ${c.CardFallbacks})');
  });
});
