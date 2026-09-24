import { describe, it, expect, beforeEach } from 'vitest';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE } from '../src/Jiv/Jiv.InstanceBuffer';
import { Jiv } from '../src/Jiv/Jiv';
import {
  CarvePieceTransform, CoveredPixels, CoveredRegion, RasterPixels, PixelRectEmpty, PixelRectArea, CornerReach,
} from '../src/Core/Occlusion';
import { ContinuousCorner } from '../src/Jiv/Corner.Continuous';
import { MAT_IDENTITY, type Mat2x3 } from '../src/Transform/Mat2x3';

/**
 * THE INSTANCE, and THE SHADER'S OWN ALPHA.
 *
 * `Occlusion.test.ts` is the rectangle arithmetic. This file is the three claims that arithmetic
 * rests on and that a rectangle cannot make for itself:
 *
 *   1. the inset `max(CornerReach(radius, s), 0.5)` really does land on `alpha == 1` in the shape
 *      field — shown against the CPU transcription of the continuous corner;
 *   2. a carved piece comes out of the REAL `JivInstanceBuffer.Push` differing from the fill it
 *      replaces in its GEOMETRY lanes and in a named set of `avgScale`-scaled lanes that are exact
 *      no-ops at `BorderWidth == 0` on a non-glass fill — and in nothing else;
 *   3. the piece's own alpha, read back through the float32 the instance buffer really stores and
 *      recovered the way the vertex shader recovers it, is still exactly 1 at every pixel centre.
 *
 * What it cannot see: there is no rasteriser here. A CPU port agreeing with the GLSL it was
 * transcribed from is not the GPU agreeing with either.
 */

beforeEach(() => {
  global.document = {
    createElement: () => ({ getContext: () => null }),
  } as unknown as Document;
});

// The panel shader's shape field, at one radius on all four corners and smoothing `s`.
const Field = (px: number, py: number, halfW: number, halfH: number, r: number, s: number): number =>
  ContinuousCorner(px, py, halfW, halfH, [r, r, r, r], s);

/** The corner curves the sweeps run: 0 is Apple's circular corner, anything above 0 its continuous one. */
const SMOOTHINGS = [0, 0.3, 0.6, 0.8, 1];

/** `1 - smoothstep(-0.5, 0.5, dist)` — the panel shader's `fillAlpha`, verbatim. */
const FillAlpha = (dist: number): number => {
  const t = Math.min(1, Math.max(0, dist + 0.5));
  return 1 - t * t * (3 - 2 * t);
};

/** The same, stepped through float32 at every operation, as the GPU runs it. */
const FillAlpha32 = (dist: number): number => {
  const f = Math.fround;
  const t = f(Math.min(1, Math.max(0, f(dist + 0.5))));
  return f(1 - f(f(f(t * t)) * f(3 - f(2 * t))));
};

describe("Occlusion — the inset is the shader's, not a tolerance", () => {
  const Sweep = (x0: number, y0: number, w: number, h: number, radius: number, s: number): void => {
    const cover = CoveredPixels(x0, y0, x0 + w, y0 + h, CornerReach(radius, s));
    expect(PixelRectEmpty(cover)).toBe(false);
    const cx = x0 + w / 2, cy = y0 + h / 2;
    for (let j = cover.Y0; j < cover.Y1; j++) {
      for (let i = cover.X0; i < cover.X1; i++) {
        expect(FillAlpha(Field(i + 0.5 - cx, j + 0.5 - cy, w / 2, h / 2, radius, s))).toBe(1);
      }
    }
  };

  it('every claimed pixel of a square panel is alpha EXACTLY 1', () => {
    Sweep(0, 0, 120, 80, 0, 0.6);
  });

  it('...of a rounded panel, at every smoothing the corner can take', () => {
    for (const s of SMOOTHINGS) Sweep(0, 0, 200, 140, 12, s);
  });

  it('...at a fractional origin, which is where a seam actually lands', () => {
    Sweep(-400 + 433 + 1 / 3, 0.25, 360, 433 + 1 / 3, 0, 0.6);
  });

  it('...of a panel whose radius is a quarter of its side', () => {
    Sweep(0, 0, 100, 100, 25, 0.6);
  });

  it('the row just outside a square panel is NOT alpha 1 — the claim is not vacuous', () => {
    const cover = CoveredPixels(0, 0, 120, 80, 0);
    expect(FillAlpha(Field(0.5 - 60, cover.Y1 + 0.5 - 40, 60, 40, 0, 0.6))).toBeLessThan(1);
  });
});

/**
 * THE WINGS — the claim lane occlusion2 rests on, against the same CPU port.
 *
 * `CoveredPixels` insets a rounded rect by its corner REACH on every side, which is the flat branch's
 * own guarantee and nothing more. `CoveredRegion` also claims the two WING rows — the full-width
 * strip along the top edge and along the bottom, clear of the four corner blocks — where the flat
 * branch does NOT run and the nearest feature is the straight edge (the derivation is in
 * `Core/Occlusion.ts`). Every pixel of every claimed rect is swept here, at every smoothing.
 *
 * This is not a small correction. `Screen { BorderRadius: @JwiftScreenRadius }` draws a 183 device
 * px corner at dpr 2, and that clip is in EVERY node's stack in the app: the all-sides inset threw
 * away a 183 px frame of a 2560 x 1600 canvas on every coverer, which is what made the carve emit
 * zero pieces on both machines.
 */
describe('Occlusion — the wing rows a rounded rect really does write at alpha 1', () => {
  /** Every pixel centre the region claims, at the field's own value. `fieldRadius` is what the field
   *  picks in that quadrant, which need not be the max the region was built from. */
  const SweepRegion = (
    x0: number, y0: number, w: number, h: number, radius: number, s: number, fieldRadius = radius,
  ): number => {
    const region = CoveredRegion(x0, y0, x0 + w, y0 + h, CornerReach(radius, s));
    const cx = x0 + w / 2, cy = y0 + h / 2;
    let claimed = 0;
    for (const rect of region) {
      for (let j = rect.Y0; j < rect.Y1; j++) {
        for (let i = rect.X0; i < rect.X1; i++) {
          expect(FillAlpha(Field(i + 0.5 - cx, j + 0.5 - cy, w / 2, h / 2, fieldRadius, s))).toBe(1);
          claimed++;
        }
      }
    }
    return claimed;
  };

  it('every claimed pixel is alpha EXACTLY 1, at every smoothing', () => {
    for (const s of SMOOTHINGS) expect(SweepRegion(0, 0, 200, 140, 24, s)).toBeGreaterThan(0);
  });

  it('...at a fractional origin, which is where a seam actually lands', () => {
    SweepRegion(-400 + 433 + 1 / 3, 0.25, 360, 220, 31, 0.6);
  });

  it('...and at a radius a quarter of the side', () => {
    SweepRegion(0, 0, 160, 160, 40, 0.6);
  });

  it('...with the field on a SMALLER radius than the region was built from', () => {
    // `radius` is the MAX of the four drawn radii and the corner blocks are cut at that size, so a
    // quadrant whose own radius is smaller is strictly further inside. Both legs swept.
    SweepRegion(0, 0, 200, 140, 24, 0.6, 6);
    SweepRegion(0, 0, 200, 140, 24, 0.6, 0);
  });

  it('the wings are the whole point: the region claims far more than the inset rect does', () => {
    const region = CoveredRegion(0, 0, 2560, 1600, 183);
    const inset = CoveredPixels(0, 0, 2560, 1600, 183);
    let area = 0;
    for (const r of region) area += PixelRectArea(r);
    // 2560 x 1600 minus four 183 x 183 corner blocks, against the 2194 x 1234 the inset leaves.
    expect(area).toBe(4_096_000 - 4 * 183 * 183);
    expect(PixelRectArea(inset)).toBe(2194 * 1234);
    expect(area - PixelRectArea(inset)).toBe(1_254_648);
  });

  it('the region is DISJOINT and is a superset of the inset rect', () => {
    const region = CoveredRegion(10, 20, 410, 320, 37);
    for (let i = 0; i < region.length; i++) {
      for (let j = i + 1; j < region.length; j++) {
        const a = region[i], b = region[j];
        const hit = { X0: Math.max(a.X0, b.X0), Y0: Math.max(a.Y0, b.Y0), X1: Math.min(a.X1, b.X1), Y1: Math.min(a.Y1, b.Y1) };
        expect(PixelRectEmpty(hit)).toBe(true);
      }
    }
    const inset = CoveredPixels(10, 20, 410, 320, 37);
    expect(region.some((r) => r.X0 <= inset.X0 && r.Y0 <= inset.Y0 && r.X1 >= inset.X1 && r.Y1 >= inset.Y1)).toBe(true);
  });

  it('a corner block is NOT claimed, and is NOT alpha 1 — the claim is not vacuous', () => {
    const w = 200, h = 140, radius = 24;
    const region = CoveredRegion(0, 0, w, h, CornerReach(radius, 0.6));
    // The pixel just inside the top-left corner of the face, which the corner block excludes.
    const px = 0, py = 0;
    expect(region.some((r) => px >= r.X0 && px < r.X1 && py >= r.Y0 && py < r.Y1)).toBe(false);
    expect(FillAlpha(Field(px + 0.5 - w / 2, py + 0.5 - h / 2, w / 2, h / 2, radius, 0.6))).toBeLessThan(1);
  });

  it('a square rect gets the IDENTICAL set it always got — one rect, no wings', () => {
    expect(CoveredRegion(0, 0, 120, 80, 0)).toEqual([CoveredPixels(0, 0, 120, 80, 0)]);
    expect(CoveredRegion(0, 0, 120, 80, 0.5)).toEqual([CoveredPixels(0, 0, 120, 80, 0.5)]);
  });

  it('claims nothing from a rect thinner than its own radius, where the blocks would overlap', () => {
    expect(CoveredRegion(0, 0, 100, 12, 30)).toEqual([]);
  });
});

// ── The instance. ──────────────────────────────────────────────────────────────────────────────

const PAGE_STYLE = { Background: 'rgb(0, 0, 0)', BorderRadius: '0' } as const;

const PushOne = (jiv: Jiv, m: Mat2x3 = MAT_IDENTITY, clipOffset = 0, clipCount = 0): Float32Array => {
  const buf = new JivInstanceBuffer();
  buf.Begin();
  buf.Push(jiv, 2, m, clipOffset, clipCount);
  return buf.Data.slice(0, JIV_FLOATS_PER_INSTANCE);
};

/** The SHAPE, recovered exactly the way `Jiv.Panel.vert` recovers it: the panel centre is the
 *  `a_Rect` centre and the half-extents are `a_PanelGeom.zw`. `a_Rect` itself is the quad, which a
 *  border feather widens even at `BorderWidth == 0` — so it is NOT the shape. */
const ShapeOf = (d: Float32Array): { X0: number; Y0: number; X1: number; Y1: number } => {
  const f = Math.fround;
  const cx = f(d[0] + f(d[2] * 0.5));
  const cy = f(d[1] + f(d[3] * 0.5));
  return { X0: f(cx - d[6]), Y0: f(cy - d[7]), X1: f(cx + d[6]), Y1: f(cy + d[7]) };
};

describe('Occlusion — the quad is not the shape', () => {
  it("the default BorderBlur widens a borderless panel's quad by a device pixel a side", () => {
    const jiv = new Jiv({ X: 0, Y: 0, Width: 1280, Height: 800, Style: { ...PAGE_STYLE } });
    const d = PushOne(jiv);
    expect(jiv.RenderStyle.BorderWidth).toBe(0);
    expect(jiv.RenderStyle.BorderBlur).toBe(0.5);
    expect(d[0]).toBe(-1);
    expect(d[2]).toBe(2562);
    // ...and the SHAPE, which is what carries the ink, is the rect the pre-pass reasons about.
    expect(ShapeOf(d)).toEqual({ X0: 0, Y0: 0, X1: 2560, Y1: 1600 });
  });
});

describe('Occlusion — a carved piece is the same panel at a smaller rect', () => {
  const PIECES = [
    { X0: 0, Y0: 33, X1: 2560, Y1: 34 },
    { X0: 0, Y0: 466, X1: 2560, Y1: 467 },
    { X0: 0, Y0: 1333, X1: 2560, Y1: 1334 },
  ];

  it("lands on its rect, read back through the instance buffer's own float32", () => {
    const jiv = new Jiv({ X: 0, Y: 0, Width: 1280, Height: 800, Style: { ...PAGE_STYLE } });
    for (const piece of PIECES) {
      const d = PushOne(jiv, CarvePieceTransform(piece, jiv.X, jiv.Y, jiv.Width, jiv.Height, 2));
      const shape = ShapeOf(d);
      expect(shape.X0).toBeCloseTo(piece.X0, 3);
      expect(shape.X1).toBeCloseTo(piece.X1, 3);
      expect(shape.Y0).toBeCloseTo(piece.Y0, 3);
      expect(shape.Y1).toBeCloseTo(piece.Y1, 3);
      expect(d[4]).toBe(1);   // cos — unrotated
      expect(d[5]).toBe(0);   // sin
    }
  });

  it('...and off a node whose own box is neither at the origin nor the full canvas', () => {
    const jiv = new Jiv({ X: 37, Y: 91, Width: 613, Height: 217, Style: { ...PAGE_STYLE } });
    const piece = { X0: 200, Y0: 300, X1: 900, Y1: 340 };
    const shape = ShapeOf(PushOne(jiv, CarvePieceTransform(piece, jiv.X, jiv.Y, jiv.Width, jiv.Height, 2)));
    expect(shape.X0).toBeCloseTo(piece.X0, 3);
    expect(shape.X1).toBeCloseTo(piece.X1, 3);
    expect(shape.Y0).toBeCloseTo(piece.Y0, 3);
    expect(shape.Y1).toBeCloseTo(piece.Y1, 3);
  });

  it('is alpha EXACTLY 1 at every pixel centre it covers, in float32, off the stored instance', () => {
    const jiv = new Jiv({ X: 0, Y: 0, Width: 1280, Height: 800, Style: { ...PAGE_STYLE } });
    for (const piece of PIECES) {
      const d = PushOne(jiv, CarvePieceTransform(piece, jiv.X, jiv.Y, jiv.Width, jiv.Height, 2));
      const s = ShapeOf(d);
      const cx = (s.X0 + s.X1) / 2, cy = (s.Y0 + s.Y1) / 2;
      for (let j = piece.Y0; j < piece.Y1; j++) {
        for (const i of [piece.X0, piece.X0 + 1, 1279, 2558, piece.X1 - 1]) {
          const dist = Field(i + 0.5 - cx, j + 0.5 - cy, d[6], d[7], 0, 0.6);
          expect(FillAlpha32(dist)).toBe(1);
        }
      }
    }
  });

  it('differs from the fill it replaces in its GEOMETRY and in a NAMED set of dead lanes, nowhere else', () => {
    const jiv = new Jiv({ X: 0, Y: 0, Width: 1280, Height: 800, Style: { ...PAGE_STYLE } });
    const whole = PushOne(jiv, MAT_IDENTITY, 7, 2);
    const piece = PushOne(jiv, CarvePieceTransform(PIECES[0], 0, 0, 1280, 800, 2), 7, 2);
    const differs: number[] = [];
    for (let i = 0; i < JIV_FLOATS_PER_INSTANCE; i++) if (whole[i] !== piece[i]) differs.push(i);
    // 0..3  a_Rect, 7 a_PanelGeom.w -- the geometry, which is the whole point.
    // 28    borderEdgeAa = BorderBlur * avgScale * dpr. Read ONLY by the border smoothsteps, which
    //       are an exact float-0 no-op at BorderWidth == 0 -- the admission rule requires it.
    // 37    BezelWidth * avgScale * dpr. Read ONLY inside `materialType == 1.0 || hasBackdropFilter`,
    //       and a carvable fill is neither glass nor backdrop-filtered.
    expect(differs).toEqual([0, 1, 2, 3, 7, 28, 37]);
  });

  it('keeps colour, radii, opacity, grade and border mode byte for byte', () => {
    const jiv = new Jiv({ X: 0, Y: 0, Width: 1280, Height: 800, Style: { ...PAGE_STYLE } });
    const whole = PushOne(jiv, MAT_IDENTITY, 7, 2);
    const piece = PushOne(jiv, CarvePieceTransform(PIECES[0], 0, 0, 1280, 800, 2), 7, 2);
    for (const lane of [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 27, 29, 30, 31]) {
      expect([lane, piece[lane]]).toEqual([lane, whole[lane]]);
    }
  });

  it('carries the clip the fill carried, so the clip feather is the same feather', () => {
    const jiv = new Jiv({ X: 0, Y: 0, Width: 1280, Height: 800, Style: { ...PAGE_STYLE } });
    const piece = PushOne(jiv, CarvePieceTransform(PIECES[0], 0, 0, 1280, 800, 2), 7, 2);
    expect(piece[54]).toBe(7);
    expect(piece[55]).toBe(2);
  });
});

describe('Occlusion — a carve never claims ink outside the fill it replaces', () => {
  it('the raster rect reaches a pixel past the quad, and the clamp is what takes it back', () => {
    const shape = { X0: 0, Y0: 0, X1: 2560, Y1: 1600 };
    const raster = RasterPixels(shape.X0, shape.Y0, shape.X1, shape.Y1);
    expect(raster.X0).toBe(-1);
    expect(raster.X1).toBe(2561);
    const piece = { X0: raster.X0, Y0: raster.Y0, X1: raster.X0 + 4, Y1: raster.Y0 + 4 };
    expect(Math.max(shape.X0, piece.X0)).toBe(0);
    expect(Math.max(shape.Y0, piece.Y0)).toBe(0);
  });
});
