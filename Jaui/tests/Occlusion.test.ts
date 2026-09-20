import { describe, it, expect } from 'vitest';
import {
  CoveredPixels, CoveredRegion, IntersectRegions, MAX_COVER_RECTS,
  RasterPixels, IntersectPixelRect, PixelRectArea, PixelRectEmpty,
  SubtractPixelRects, MergePixelRects, PlanOcclusion, CarvePieceTransform,
  DEFAULT_OCCLUSION_LIMITS, OCCLUSION_AA_INSET, PILL_GUARD_FRACTION,
  type PixelRect, type OcclusionFill,
} from '../src/Core/Occlusion';

/**
 * THE ARITHMETIC. `Occlusion.Wired.test.ts` is the routing; this file is the numbers, and the one
 * number it exists for is the BED's.
 *
 * What it cannot see, said plainly: there is no rasteriser here, so nothing below proves a texel.
 * It proves that the pixel sets this lever withholds are the ones its own argument admits — which
 * is what decides whether the pixels are right, and is not a demonstration that they are. That is
 * the orchestrator's gate.
 */

// -- glass-grid, dpr 2, pinned from `Perf.jss` and `Perf.GlassGrid.ts`.
const CANVAS_W = 2560;
const CANVAS_H = 1600;
const DPR = 2;
const CANVAS: PixelRect = { X0: 0, Y0: 0, X1: CANVAS_W, Y1: CANVAS_H };

/** `PerfBed`: Placed at (-240, -200), 1800 x 1300 pt, six `FlexGrow: 1` bands down its column. */
const BED_LEFT = -240 * DPR;
const BED_TOP = -200 * DPR;
const BED_W = 1800 * DPR;
const BED_H = 1300 * DPR;
const BAND_H = BED_H / 6;
const BandRect = (i: number): [number, number, number, number] =>
  [BED_LEFT, BED_TOP + i * BAND_H, BED_LEFT + BED_W, BED_TOP + (i + 1) * BAND_H];

describe('Occlusion — the alpha-1 interior', () => {
  it('takes the shader edge AA as the half-pixel it is, not as a tolerance', () => {
    expect(OCCLUSION_AA_INSET).toBe(0.5);
  });

  it('claims every pixel centre at least half a pixel inside a square rect', () => {
    // 0..10: centres 0.5 .. 9.5, all exactly >= 0.5 from both edges.
    expect(CoveredPixels(0, 0, 10, 10, 0)).toEqual({ X0: 0, Y0: 0, X1: 10, Y1: 10 });
  });

  it('gives up the corner band of a rounded rect, so the flat branch of the SDF is what it reads', () => {
    // radius 8 -> inset 8 a side: the returned box is where ShapeSDF_inner's `q <= 0` holds.
    expect(CoveredPixels(0, 0, 100, 100, 8)).toEqual({ X0: 8, Y0: 8, X1: 92, Y1: 92 });
  });

  it('rounds INWARD on both edges, so float dust can only shrink a claim', () => {
    const exact = CoveredPixels(10, 10, 20, 20, 0);
    expect(CoveredPixels(10.0000001, 10, 20, 19.9999999, 0).X0).toBeGreaterThanOrEqual(exact.X0);
    expect(CoveredPixels(10.0000001, 10, 20, 19.9999999, 0).Y1).toBeLessThanOrEqual(exact.Y1);
  });

  it('claims nothing from a rect thinner than its own feather', () => {
    expect(PixelRectEmpty(CoveredPixels(0, 0, 100, 0.6, 0))).toBe(true);
  });
});

describe('Occlusion — two panels that abut', () => {
  it('leaves NO gap when the shared edge lands on a whole device pixel', () => {
    const top = CoveredPixels(0, 0, 100, 40, 0);
    const bottom = CoveredPixels(0, 40, 100, 80, 0);
    expect(top.Y1).toBe(40);
    expect(bottom.Y0).toBe(40);
    const left = SubtractPixelRects({ X0: 0, Y0: 0, X1: 100, Y1: 80 }, [top, bottom], 8);
    expect(left).toEqual([]);
  });

  it('leaves EXACTLY ONE ROW when the shared edge is fractional — the row the shader blends across', () => {
    // Centre 40.5 sits 0.167 below the seam at 40.333: the top band's alpha there is ~0.26 and the
    // bottom's ~0.74, so ~19% of whatever is underneath survives. That row is not covered, and a
    // continuous rect union would have said it was.
    const top = CoveredPixels(0, 0, 100, 40 + 1 / 3, 0);
    const bottom = CoveredPixels(0, 40 + 1 / 3, 100, 80, 0);
    expect(top.Y1).toBe(40);
    expect(bottom.Y0).toBe(41);
    const left = SubtractPixelRects({ X0: 0, Y0: 0, X1: 100, Y1: 80 }, [top, bottom], 8);
    expect(left).toEqual([{ X0: 0, Y0: 40, X1: 100, Y1: 41 }]);
  });
});

describe('Occlusion — rectangle difference', () => {
  it('is exact, never a bounding box: a hole in the middle leaves four sides', () => {
    const left = SubtractPixelRects({ X0: 0, Y0: 0, X1: 10, Y1: 10 }, [{ X0: 3, Y0: 3, X1: 7, Y1: 7 }], 8);
    expect(left).not.toBeNull();
    let area = 0;
    for (const r of left!) area += PixelRectArea(r);
    expect(area).toBe(100 - 16);
  });

  it('returns disjoint pieces', () => {
    const left = SubtractPixelRects({ X0: 0, Y0: 0, X1: 10, Y1: 10 }, [{ X0: 3, Y0: 3, X1: 7, Y1: 7 }], 8)!;
    for (let i = 0; i < left.length; i++) {
      for (let j = i + 1; j < left.length; j++) {
        expect(PixelRectEmpty(IntersectPixelRect(left[i], left[j]))).toBe(true);
      }
    }
  });

  it('REFUSES rather than approximates when the piece list would pass the cap', () => {
    const target: PixelRect = { X0: 0, Y0: 0, X1: 100, Y1: 100 };
    const holes: PixelRect[] = [];
    for (let i = 0; i < 12; i++) holes.push({ X0: 10 + i * 6, Y0: 40, X1: 13 + i * 6, Y1: 60 });
    expect(SubtractPixelRects(target, holes, 4)).toBeNull();
  });

  it('merges pieces that share a column range and touch', () => {
    expect(MergePixelRects([
      { X0: 0, Y0: 10, X1: 8, Y1: 12 },
      { X0: 0, Y0: 12, X1: 8, Y1: 20 },
    ])).toEqual([{ X0: 0, Y0: 10, X1: 8, Y1: 20 }]);
  });
});

describe("Occlusion — glass-grid's bed, the number this lever exists for", () => {
  const PageFill: PixelRect = IntersectPixelRect(RasterPixels(0, 0, CANVAS_W, CANVAS_H), CANVAS);
  const Bands = (): PixelRect[] => {
    const out: PixelRect[] = [];
    for (let i = 0; i < 6; i++) {
      const [x0, y0, x1, y1] = BandRect(i);
      const hit = IntersectPixelRect(CoveredPixels(x0, y0, x1, y1, 0), PageFill);
      if (!PixelRectEmpty(hit)) out.push(hit);
    }
    return out;
  };

  it('the page fill rasterises exactly the drawing buffer', () => {
    expect(PageFill).toEqual(CANVAS);
    expect(PixelRectArea(PageFill)).toBe(4_096_000);
  });

  it('the six bands span the whole canvas in x', () => {
    for (const b of Bands()) { expect(b.X0).toBe(0); expect(b.X1).toBe(CANVAS_W); }
  });

  it('DISPROVES the premise: the bands do NOT cover the page fill — three seam rows are left', () => {
    const left = SubtractPixelRects(PageFill, Bands(), DEFAULT_OCCLUSION_LIMITS.MaxPieces);
    expect(left).not.toBeNull();
    expect(left).toEqual([
      { X0: 0, Y0: 33, X1: 2560, Y1: 34 },
      { X0: 0, Y0: 466, X1: 2560, Y1: 467 },
      { X0: 0, Y0: 1333, X1: 2560, Y1: 1334 },
    ]);
  });

  it('the seam at a whole device coordinate leaves nothing, and there is exactly one of those', () => {
    // 1300pt / 6 = 216.667pt = 433.333 device px, so only the third seam (device y 900) is whole.
    const seams = [1, 2, 3, 4, 5].map((k) => BED_TOP + k * BAND_H);
    expect(seams.filter((s) => Number.isInteger(s))).toEqual([900]);
    const left = SubtractPixelRects(PageFill, Bands(), 8)!;
    expect(left.some((r) => r.Y0 <= 900 && r.Y1 > 900)).toBe(false);
  });

  it('carves the page fill to three rows: 4,088,320 device px withheld of 4,096,000', () => {
    const fills: OcclusionFill[] = [
      { Order: 0, Raster: PageFill, Cover: [PageFill], Covers: true, Skippable: true, Carvable: true },
      ...Bands().map((b, i) => ({
        Order: i + 2, Raster: b, Cover: [b], Covers: true, Skippable: false, Carvable: false,
      })),
    ];
    const plan = PlanOcclusion(fills, [20], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: CANVAS_W * CANVAS_H / 16 });
    const v = plan.get(0);
    expect(v?.Kind).toBe('Carve');
    expect(v?.Px).toBe(4_096_000 - 3 * 2560);
    expect(v?.Px).toBe(4_088_320);
    expect(v?.Kind === 'Carve' ? v.Pieces.length : 0).toBe(3);
  });

  it('withholds NOTHING when a glass card reads the scene before the bands land', () => {
    const fills: OcclusionFill[] = [
      { Order: 0, Raster: PageFill, Cover: [PageFill], Covers: true, Skippable: true, Carvable: true },
      ...Bands().map((b, i) => ({
        Order: i + 2, Raster: b, Cover: [b], Covers: true, Skippable: false, Carvable: false,
      })),
    ];
    // A read at order 1 — before every band — is the clause that makes this safe on a page whose
    // glass sits between a fill and the thing that covers it.
    const plan = PlanOcclusion(fills, [1], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 });
    expect(plan.size).toBe(0);
  });
});

describe('Occlusion — the plan', () => {
  const Full: PixelRect = { X0: 0, Y0: 0, X1: 1000, Y1: 1000 };
  const Fill = (o: number, p: Partial<OcclusionFill> = {}): OcclusionFill => ({
    Order: o, Raster: Full, Cover: [Full], Covers: true, Skippable: true, Carvable: false, ...p,
  });

  it('SKIPS a fill one later coverer takes whole', () => {
    const plan = PlanOcclusion([Fill(0), Fill(1)], [], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 });
    expect(plan.get(0)).toEqual({ Kind: 'Skip', Px: 1_000_000 });
  });

  it('never lets an EARLIER panel cover a later one', () => {
    const plan = PlanOcclusion([Fill(0), Fill(1)], [], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 });
    expect(plan.has(1)).toBe(false);
  });

  it('refuses a coverer that is not opaque', () => {
    const plan = PlanOcclusion([Fill(0), Fill(1, { Covers: false })], [], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 });
    expect(plan.size).toBe(0);
  });

  it('refuses a carve on a fill that is not a flat colour, however small the residual', () => {
    const p: OcclusionFill = Fill(0, { Carvable: false });
    const c: OcclusionFill = Fill(1, { Cover: [{ X0: 0, Y0: 1, X1: 1000, Y1: 1000 }] });
    const plan = PlanOcclusion([p, c], [], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 });
    expect(plan.size).toBe(0);
  });

  it('refuses a carve whose residual is a big share of the panel — the instances would not pay', () => {
    const p = Fill(0, { Carvable: true });
    const c = Fill(1, { Cover: [{ X0: 0, Y0: 0, X1: 1000, Y1: 500 }] });
    const plan = PlanOcclusion([p, c], [], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 });
    expect(plan.size).toBe(0);
  });

  it('only admits fills above the minimum area, at BOTH ends', () => {
    const small: PixelRect = { X0: 0, Y0: 0, X1: 10, Y1: 10 };
    const plan = PlanOcclusion(
      [Fill(0, { Raster: small, Cover: [small] }), Fill(1, { Raster: small, Cover: [small] })],
      [], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 1000 },
    );
    expect(plan.size).toBe(0);
  });

  it('counts only the pixels it really withheld', () => {
    const p = Fill(0, { Carvable: true });
    const c = Fill(1, { Cover: [{ X0: 0, Y0: 0, X1: 1000, Y1: 900 }] });
    const plan = PlanOcclusion([p, c], [], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 });
    expect(plan.get(0)).toEqual({
      Kind: 'Carve', Px: 900_000,
      Pieces: [{ X0: 0, Y0: 900, X1: 1000, Y1: 1000 }],
    });
  });

  it('a coverer the plan ALSO withheld cannot lie between a fill and a read', () => {
    // The closure argument, as a run: if C1 is skipped it is because later coverers take all of
    // it, and a read between P and C1 would already have stopped C1 from counting for P. So the
    // three verdicts here are consistent however they are applied.
    const p = Fill(0);
    const c1 = Fill(1);
    const c2 = Fill(2);
    const plan = PlanOcclusion([p, c1, c2], [3], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 });
    expect(plan.get(0)?.Kind).toBe('Skip');
    expect(plan.get(1)?.Kind).toBe('Skip');
    expect(plan.has(2)).toBe(false);
  });

  it('stops counting coverers at the first scene read after the fill', () => {
    const p = Fill(0);
    const half = Fill(1, { Cover: [{ X0: 0, Y0: 0, X1: 1000, Y1: 500 }] });
    const rest = Fill(3, { Cover: [{ X0: 0, Y0: 500, X1: 1000, Y1: 1000 }] });
    expect(PlanOcclusion([p, half, rest], [], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 }).size).toBe(1);
    expect(PlanOcclusion([p, half, rest], [2], { ...DEFAULT_OCCLUSION_LIMITS, MinAreaPx: 0 }).size).toBe(0);
  });
});

describe('Occlusion — the carve transform', () => {
  it('reproduces the piece rect exactly through the scale it hands Push', () => {
    // The node is its own box; `Push` recomputes half-extents and centre from this matrix.
    const m = CarvePieceTransform({ X0: 0, Y0: 33, X1: 2560, Y1: 34 }, 0, 0, 1280, 800, 2);
    const halfW = m[0] * 1280 * 2 / 2;
    const halfH = m[3] * 800 * 2 / 2;
    const cx = (m[0] * (0 + 1280 * 0.5) + m[4]) * 2;
    const cy = (m[3] * (0 + 800 * 0.5) + m[5]) * 2;
    expect(cx - halfW).toBeCloseTo(0, 9);
    expect(cx + halfW).toBeCloseTo(2560, 9);
    expect(cy - halfH).toBeCloseTo(33, 9);
    expect(cy + halfH).toBeCloseTo(34, 9);
  });

  it('leaves the rotation basis at the unrotated identity', () => {
    const m = CarvePieceTransform({ X0: 10, Y0: 20, X1: 30, Y1: 40 }, 5, 5, 100, 100, 2);
    expect(m[1]).toBe(0);
    expect(m[2]).toBe(0);
    expect(m[0]).toBeGreaterThan(0);
    expect(m[3]).toBeGreaterThan(0);
  });

  it('survives an offset node box', () => {
    const m = CarvePieceTransform({ X0: 100, Y0: 200, X1: 300, Y1: 260 }, 17, 29, 640, 480, 2);
    const cx = (m[0] * (17 + 320) + m[4]) * 2;
    const halfW = m[0] * 640 * 2 / 2;
    expect(cx - halfW).toBeCloseTo(100, 9);
    expect(cx + halfW).toBeCloseTo(300, 9);
  });
});

describe('Occlusion — the region, and the cap that keeps it bounded', () => {
  it('a rounded rect is its face minus four CORNER blocks, not its face inset by the radius', () => {
    const region = CoveredRegion(0, 0, 200, 100, 20);
    let area = 0;
    for (const r of region) area += PixelRectArea(r);
    expect(area).toBe(200 * 100 - 4 * 20 * 20);
    expect(PixelRectArea(CoveredPixels(0, 0, 200, 100, 20))).toBe(160 * 60);
  });

  it('intersects two regions exactly, and the rects stay disjoint', () => {
    const a = CoveredRegion(0, 0, 200, 100, 20);
    const b = [{ X0: 50, Y0: 0, X1: 150, Y1: 100 }];
    const hit = IntersectRegions(a, b)!;
    let area = 0;
    for (const r of hit) area += PixelRectArea(r);
    expect(area).toBe(100 * 100);
  });

  it('REFUSES rather than approximates when the rect count would pass the cap', () => {
    // Every rect of `a` crosses every rect of `b`: the product is the count, and past
    // MAX_COVER_RECTS the caller falls back to the all-sides-inset rect, which is a SUBSET.
    const a: PixelRect[] = [];
    const b: PixelRect[] = [];
    for (let i = 0; i < 3; i++) a.push({ X0: i * 10, Y0: 0, X1: i * 10 + 5, Y1: 100 });
    for (let j = 0; j < 4; j++) b.push({ X0: 0, Y0: j * 10, X1: 100, Y1: j * 10 + 5 });
    expect(IntersectRegions(a, b)).toBeNull();
    expect(MAX_COVER_RECTS).toBe(8);
  });

  it('the fallback is always legal: the inset rect is inside the region', () => {
    const region = CoveredRegion(7, 11, 407, 311, 41);
    const inset = CoveredPixels(7, 11, 407, 311, 41);
    let covered = 0;
    for (const r of region) covered += PixelRectArea(IntersectPixelRect(r, inset));
    expect(covered).toBe(PixelRectArea(inset));
  });
});

describe('Occlusion — the pill guard', () => {
  it('sits at half the short half-axis, well under the 0.88 the pill leg needs', () => {
    // `CornerParams`: sat = smoothstep(minHalf - max(0.12*minHalf, 1), minHalf - 1, authoredR), so
    // the pill leg is unreachable below 0.88 * minHalf. The guard is 0.5.
    expect(PILL_GUARD_FRACTION).toBe(0.5);
    const minHalf = 100;
    const satLowerEdge = minHalf - Math.max(minHalf * 0.12, 1);
    expect(PILL_GUARD_FRACTION * minHalf).toBeLessThan(satLowerEdge);
  });
});
