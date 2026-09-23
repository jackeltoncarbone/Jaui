/**
 * `?occlusion` ON GLASS-GRID — the frame two machines read, driven through the REAL walk.
 *
 * Lane occlusion folded a carve that never fired. Both machines read the identical census on every
 * frame — `Candidates 5, Coverers 5, Reads 20, Nodes 71, Carved 0, Pieces 0, Px 0, Refused ""` —
 * and a 0-px pixel gate cannot tell that apart from a lever that worked perfectly, so the fold was
 * quoted as a measurement for a whole phase. This file is that frame, reproduced before anything
 * was changed, and then the arithmetic that turns it into a carve.
 *
 * WHAT IS REAL HERE and what is not, because that distinction is the whole value of the file:
 *
 *   REAL — the walk (`_blurFirstNode`, which the pre-pass rides), the flex solver that divides the
 *   bed into six bands, `_composeTransform`, the clip stack, `_occlusionShapeRect`, the admission
 *   rule, `PlanOcclusion`, and the census `__jauiOcclusion()` publishes. One `RenderHeadless` is
 *   one real frame of the engine against a recording renderer.
 *
 *   TRANSCRIBED — the Angular templates. `Perf.GlassGrid.ts`'s tree and `App.ts`'s shell are built
 *   here as `Jiv`s, with every NUMBER read out of `Perf.jss`, `App.jss` and `Jwift.Glass.jss` so a
 *   re-spaced grid or a retuned screen radius moves this file instead of silently invalidating it.
 *
 *   NOT HERE — a rasteriser. Nothing below proves a texel; it proves which pixel sets the lever
 *   claims. The orchestrator's gate is the proof.
 */
import { describe, it, expect } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';
import {
  CoveredPixels, CoveredRegion, IntersectPixelRect, PixelRectEmpty, PixelRectArea,
  SubtractPixelRects, CornerReach, DEFAULT_OCCLUSION_LIMITS, type PixelRect,
} from '@jaui/Core/Occlusion';
import { readJaui, readPerfJss, readAppJss, readJwiftGlass, jssClass, jssValue, jssNumber } from './Scene.ReadAfterWrite.Source';

// ── The sheets, read rather than restated. ─────────────────────────────────────────────────────

const PERF = readPerfJss();
const PAGE = jssClass(PERF, 'PerfPage');
const BED = jssClass(PERF, 'PerfBed');
const GRID = jssClass(PERF, 'PerfGrid');
const CARD = jssClass(PERF, 'PerfCard');
const SCREEN = jssClass(readAppJss(), 'Screen');
/** `@JwiftScreenRadius: 52pt` — the app shell's corner, and therefore every node's clip corner. */
const SCREEN_RADIUS_PT = (() => {
  const m = /@JwiftScreenRadius:\s*([\d.]+)pt/.exec(readJwiftGlass());
  if (!m) throw new Error('no @JwiftScreenRadius in Jwift.Glass.jss');
  return parseFloat(m[1]);
})();

/** The harness pins 1280 x 800 CSS px at deviceScaleFactor 2. */
const VIEW_W = 1280;
const VIEW_H = 800;
const DPR = 2;
const CANVAS_W = VIEW_W * DPR;
const CANVAS_H = VIEW_H * DPR;
const CANVAS: PixelRect = { X0: 0, Y0: 0, X1: CANVAS_W, Y1: CANVAS_H };

// ── The scene. ─────────────────────────────────────────────────────────────────────────────────

const nullRenderer = (): Renderer =>
  new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) }) as unknown as Renderer;

const canvasOf = (search: string): Canvas => {
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => search };
  const c = new Canvas(new OffscreenCanvas(CANVAS_W, CANVAS_H) as unknown as HTMLCanvasElement, nullRenderer(), platform);
  c.SetSizePx(VIEW_W, VIEW_H);
  // `SetSizePx` pins dpr at 1 for the headless render-to-texture host. The harness runs at 2, and
  // the drawing buffer the pre-pass is handed is `round(width * dpr)` — this is the only way to
  // put a unit test on the 2560 x 1600 buffer the two machines read.
  (c as unknown as { _dpr: number })._dpr = DPR;
  return c;
};

/** Every node authors `Opacity: 1` for the reason `EmptyPanels.test.ts` does: an unauthored one
 *  starts a Presence spring, `EffectiveOpacity` is under 1 on the first frame, and the admission
 *  rule would refuse every fill on the page for a reason that has nothing to do with geometry. */
const OPAQUE = { Opacity: '1' } as const;
const CLEAR = 'rgba(0, 0, 0, 0)';

/** `App.ts`'s shell and `Perf.GlassGrid.ts`'s tree: `Screen > PerfPage > (PerfBed > 6 bands,
 *  PerfGrid > 20 cards > 2 labels)`, beside the root-level `Presentation` layer. */
const buildGlassGrid = (c: Canvas, bedDx = 0, bedDy = 0): Map<Jiv, string> => {
  const named = new Map<Jiv, string>();
  const name = (n: Jiv, s: string): Jiv => { named.set(n, s); return n; };

  const page = name(new Jiv({
    Overflow: 'Hidden',
    ChildLayout: { FlexGrow: jssNumber(PAGE, 'FlexGrow') },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { PointScale: '1', Background: jssValue(PAGE, 'Background'), ...OPAQUE },
  }), 'PerfPage');

  const bed = name(new Jiv({
    ChildLayout: {
      Position: 'Placed',
      Left: (jssNumber(BED, 'Left') + bedDx) + 'pt',
      Top: (jssNumber(BED, 'Top') + bedDy) + 'pt',
      Width: jssNumber(BED, 'Width') + 'pt',
      Height: jssNumber(BED, 'Height') + 'pt',
    },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { Layer: String(jssNumber(BED, 'Layer')), Background: CLEAR, ...OPAQUE },
  }), 'PerfBed');
  // The six seeded two-stop gradients. Their COLOURS do not matter to this lever — every stop is
  // opaque, which is the only thing the admission rule reads off a gradient — but the Kind does:
  // a gradient may COVER and may never be carved.
  for (let i = 0; i < 6; i++) {
    bed.AddChild(name(new Jiv({
      ChildLayout: { FlexGrow: jssNumber(jssClass(PERF, 'PerfBand'), 'FlexGrow') },
      Style: { Background: `LinearGradient(${i * 30}deg, rgb(${40 + i * 20}, 90, 120), rgb(20, 20, 20))`, ...OPAQUE },
    }), `PerfBand[${i}]`));
  }
  page.AddChild(bed);

  const grid = name(new Jiv({
    ChildLayout: {
      Position: 'Placed',
      Left: jssNumber(GRID, 'Left') + 'pt',
      Top: jssNumber(GRID, 'Top') + 'pt',
      Width: jssNumber(GRID, 'Width') + 'pt',
    },
    Layout: { Direction: 'Row', Wrap: 'Wrap', Gap: jssValue(GRID, 'Gap') },
    Style: { Layer: String(jssNumber(GRID, 'Layer')), Background: CLEAR, ...OPAQUE },
  }), 'PerfGrid');
  for (let i = 0; i < 20; i++) {
    // `PerfCard : JwiftGlass`. `Material` is INFERRED from `Thickness`, so the glass optics are
    // what makes these twenty nodes book a scene READ — the clause that decides which coverers a
    // fill before them is allowed to count.
    const card = name(new Jiv({
      ChildLayout: { Width: jssNumber(CARD, 'Width') + 'pt', Height: jssNumber(CARD, 'Height') + 'pt', FlexShrink: 0 },
      Layout: { Direction: 'Column', Justify: 'End', Align: 'Stretch', Gap: '4pt', Padding: jssValue(CARD, 'Padding') },
      Style: {
        Background: CLEAR,
        Thickness: '2.5', Refraction: '8', BezelWidth: '12', BezelScale: '0.25', Curvature: '0',
        BackdropFilter: 'Blur(4pt) Saturate(1.6) Contrast(0.6)', Tint: '0.45',
        BorderWidth: '0.45pt', BorderBlur: '0.3pt', BorderFade: '0.7pt',
        BorderColor: 'rgba(255, 255, 255, 0.35)',
        BorderRadius: jssValue(CARD, 'BorderRadius'), ...OPAQUE,
      },
    }), `PerfCard[${i}]`);
    card.AddChild(new Jiv({ Text: `Label ${i}`, Style: { Background: CLEAR, ...OPAQUE } }));
    card.AddChild(new Jiv({ Text: `Sub ${i}`, Style: { Background: CLEAR, ...OPAQUE } }));
    grid.AddChild(card);
  }
  page.AddChild(grid);

  const screen = name(new Jiv({
    Overflow: 'Hidden',
    ChildLayout: { FlexGrow: jssNumber(SCREEN, 'FlexGrow') },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { PointScale: '1', BorderRadius: SCREEN_RADIUS_PT + 'pt', Background: CLEAR, ...OPAQUE },
  }), 'Screen');
  screen.AddChild(page);
  c.Root.AddChild(screen);
  // `App.ts`'s sheet layer: a root-level sibling declared AFTER the Screen, full viewport, inert.
  c.Root.AddChild(name(new Jiv({
    ChildLayout: { Position: 'Fixed', Top: '0pt', Left: '0pt', Width: '100vw', Height: '100vh' },
    PointerEvents: 'None',
    Style: { PointScale: '1', Background: CLEAR, ...OPAQUE },
  }), 'Presentation'));
  return named;
};

interface Admitted {
  Name: string; Shape: PixelRect; Region: readonly PixelRect[]; Covers: boolean; Carvable: boolean;
  ClipRadius: number; ClipSmoothing: number;
}

interface Walked {
  Census: ReturnType<typeof occlusionCensus>;
  Admitted: Admitted[];
  Plan: Map<string, { Kind: string; Px: number; Pieces?: readonly PixelRect[] }>;
}

const occlusionCensus = (): {
  Armed: boolean; Candidates: number; Coverers: number; Reads: number; Nodes: number;
  Skipped: number; Carved: number; Pieces: number; Px: number; CoverersSeen: number;
  Missed: number; Vacuous: number; Refused: string;
  Notes: { NoCover: number; Capped: number; NotCarvable: number; TooMuchLeft: number; TooSmall: number };
} => (globalThis as unknown as { __jauiOcclusion: () => never }).__jauiOcclusion();

/** One real frame, with the pre-pass's own record site tapped so the admitted fills can be read
 *  back by NAME. The tap wraps the arrow-function property, so it observes the real call. */
const walk = (search: string, build: (c: Canvas) => Map<Jiv, string> = buildGlassGrid): Walked => {
  const c = canvasOf(search);
  const named = build(c);
  const admitted: Admitted[] = [];
  type Scan = { Fills: { Cover: readonly PixelRect[]; Covers: boolean; Carvable: boolean }[] };
  type Clip = {
    X: number; Y: number; W: number; H: number; RTL: number; RTR: number; RBR: number; RBL: number; Smoothness: number;
  };
  const priv = c as unknown as {
    _occlusionRecord: (s: Scan, n: Jiv, eff: number[], stack: readonly Clip[], effH: unknown) => void;
    _occlusionShapeRect: (n: Jiv, eff: number[]) => PixelRect;
    _occlusionPlan: Map<Jiv, { Kind: string; Px: number; Pieces?: readonly PixelRect[] }>;
  };
  const real = priv._occlusionRecord;
  priv._occlusionRecord = (scan: Scan, node: Jiv, eff: number[], stack: readonly Clip[], effH: unknown): void => {
    const before = scan.Fills.length;
    real(scan, node, eff, stack, effH);
    if (scan.Fills.length === before) return;
    const f = scan.Fills[before];
    let clipRadius = 0, clipSmoothing = 0;
    for (const s of stack) {
      const r = Math.max(s.RTL, s.RTR, s.RBR, s.RBL);
      if (r > clipRadius) { clipRadius = r; clipSmoothing = s.Smoothness; }
    }
    admitted.push({
      Name: named.get(node) ?? '?', Shape: priv._occlusionShapeRect(node, eff),
      Region: f.Cover, Covers: f.Covers, Carvable: f.Carvable,
      ClipRadius: clipRadius * DPR, ClipSmoothing: clipSmoothing,
    });
  };
  c.RenderHeadless(1000);
  const plan = new Map<string, { Kind: string; Px: number; Pieces?: readonly PixelRect[] }>();
  for (const [node, v] of priv._occlusionPlan) plan.set(named.get(node) ?? '?', v);
  return { Census: occlusionCensus(), Admitted: admitted, Plan: plan };
};

// ── 1. THE FRAME THE TWO MACHINES READ ─────────────────────────────────────────────────────────

describe('occlusion on glass-grid — the census the probe reads', () => {
  const w = walk('');

  it('admits FIVE candidates, all five coverers, past twenty scene reads on seventy-one nodes', () => {
    // The win32 probe and the M4's three frames, field for field:
    //   {Armed: true, Candidates: 5, Coverers: 5, Reads: 20, Nodes: 71, CoverersSeen: 5, Missed: 0}
    expect({
      Armed: w.Census.Armed, Candidates: w.Census.Candidates, Coverers: w.Census.Coverers,
      Reads: w.Census.Reads, Nodes: w.Census.Nodes, CoverersSeen: w.Census.CoverersSeen,
      Missed: w.Census.Missed, Refused: w.Census.Refused,
    }).toEqual({
      Armed: true, Candidates: 5, Coverers: 5, Reads: 20, Nodes: 71, CoverersSeen: 5,
      Missed: 0, Refused: '',
    });
  });

  it('the five, BY NAME — and the two the first lane predicted that are absent, with their reason', () => {
    expect(w.Admitted.map((a) => a.Name)).toEqual([
      'PerfPage', 'PerfBand[1]', 'PerfBand[2]', 'PerfBand[3]', 'PerfBand[4]',
    ]);
    // `PerfBand[0]` and `PerfBand[5]` are the missing two. The bed is Placed at Top -200pt and is
    // 1300pt tall, so band 0 spans device y -400 .. 33.33 (a 34-row raster on canvas) and band 5
    // spans 1766.67 .. 2200 (NONE). The area floor is 1/16 of the drawing buffer = 256,000 px, and
    // 34 x 2560 = 87,040 is under it. Neither is refused by any clause of the admission rule: they
    // are simply too small, and band 0 crosses back over the floor as the bed slides — which is
    // the `Candidates 5 -> 6 -> 5` the M4 saw across frames.
    expect(CANVAS_W * CANVAS_H / 16).toBe(256_000);
    expect(34 * CANVAS_W).toBeLessThan(256_000);
  });

  it('the five device rects, and the bed seams that put four of them on a fractional row', () => {
    const byName = new Map(w.Admitted.map((a) => [a.Name, a.Shape]));
    expect(byName.get('PerfPage')).toEqual({ X0: 0, Y0: 0, X1: CANVAS_W, Y1: CANVAS_H });
    const bedTop = jssNumber(BED, 'Top') * DPR;
    const bandH = jssNumber(BED, 'Height') * DPR / 6;
    const bedLeft = jssNumber(BED, 'Left') * DPR;
    const bedW = jssNumber(BED, 'Width') * DPR;
    for (const i of [1, 2, 3, 4]) {
      const r = byName.get(`PerfBand[${i}]`)!;
      expect(r.X0).toBeCloseTo(bedLeft, 6);
      expect(r.X1).toBeCloseTo(bedLeft + bedW, 6);
      expect(r.Y0).toBeCloseTo(bedTop + i * bandH, 6);
      expect(r.Y1).toBeCloseTo(bedTop + (i + 1) * bandH, 6);
    }
    // 1300pt / 6 = 216.667pt = 433.333 device px: only the seam at y 900 is a whole coordinate.
    const seams = [1, 2, 3, 4, 5].map((k) => bedTop + k * bandH);
    expect(seams.filter((s) => Number.isInteger(s))).toEqual([900]);
  });

  it('EVERY node in this app sits inside a 104-device-px continuous-cornered clip — the term the first lane missed', () => {
    // `App.jss`: `Screen { BorderRadius: @JwiftScreenRadius, Overflow: Hidden }`, and every page in
    // the app is inside it. 52pt is the corner's arc radius, 104 device px at dpr 2; its easing runs
    // (1 + 0.6) r = 166.4 px along each edge, and that clip is in the stack of all five coverers.
    expect(jssValue(SCREEN, 'BorderRadius')).toBe('@JwiftScreenRadius');
    expect(jssValue(SCREEN, 'Overflow')).toBe('Hidden');
    expect(SCREEN_RADIUS_PT).toBe(52);
    for (const a of w.Admitted) {
      expect(a.ClipRadius).toBe(104);
      expect(CornerReach(a.ClipRadius, a.ClipSmoothing)).toBeCloseTo(166.4, 9);
    }
  });
});

// ── 2. THE ZERO, and the arithmetic that removes it ────────────────────────────────────────────

/** The five coverers' shape rects and the screen clip, taken from the walk above rather than
 *  restated — so the two models below are compared on the engine's own geometry. */
const geometry = (): { Page: PixelRect; Bands: PixelRect[]; Clip: PixelRect; ClipReach: number } => {
  const w = walk('');
  const byName = new Map(w.Admitted.map((a) => [a.Name, a.Shape]));
  return {
    Page: byName.get('PerfPage')!,
    Bands: [1, 2, 3, 4].map((i) => byName.get(`PerfBand[${i}]`)!),
    Clip: { X0: 0, Y0: 0, X1: CANVAS_W, Y1: CANVAS_H },
    ClipReach: CornerReach(w.Admitted[0].ClipRadius, w.Admitted[0].ClipSmoothing),
  };
};

describe('occlusion on glass-grid — WHY the carve emitted zero pieces', () => {
  const g = geometry();
  const page = IntersectPixelRect(g.Page, CANVAS);

  /** THE FIRST FOLD'S MODEL: one rect per coverer, inset by the clip's corner reach on all four sides. */
  const insetModel = (): PixelRect[] => g.Bands.map((b) =>
    IntersectPixelRect(
      IntersectPixelRect(CoveredPixels(b.X0, b.Y0, b.X1, b.Y1, 0), CANVAS),
      CoveredPixels(g.Clip.X0, g.Clip.Y0, g.Clip.X1, g.Clip.Y1, g.ClipReach),
    )).filter((r) => !PixelRectEmpty(r));

  /** THIS LANE'S: the face minus four corner BLOCKS, as a union of up to three rects. */
  const regionModel = (): PixelRect[] => {
    const clip = CoveredRegion(g.Clip.X0, g.Clip.Y0, g.Clip.X1, g.Clip.Y1, g.ClipReach);
    const out: PixelRect[] = [];
    for (const b of g.Bands) {
      for (const part of CoveredRegion(b.X0, b.Y0, b.X1, b.Y1, 0)) {
        for (const cp of clip) {
          const hit = IntersectPixelRect(IntersectPixelRect(part, cp), CANVAS);
          if (!PixelRectEmpty(hit)) out.push(hit);
        }
      }
    }
    return out;
  };

  it('the inset model throws away a 166 px FRAME of the canvas on every coverer', () => {
    // The first pixel column whose centre (166.5) is past the 166.4 px reach.
    for (const c of insetModel()) {
      expect(c.X0).toBe(166);
      expect(c.X1).toBe(CANVAS_W - 166);
    }
  });

  it('...which blows the piece cap, and would blow the residual guard even without it', () => {
    // The two refusals the M4's diagnostic ruled out by name. It was wrong on both, for the same
    // reason it could not see them: NEITHER wrote a reason on the census.
    expect(SubtractPixelRects(page, insetModel(), 8)).toBeNull();
    const uncapped = SubtractPixelRects(page, insetModel(), 1024)!;
    expect(uncapped.length).toBeGreaterThan(8);
    let left = 0;
    for (const r of uncapped) left += PixelRectArea(r);
    expect(left / PixelRectArea(page)).toBeGreaterThan(DEFAULT_OCCLUSION_LIMITS.MaxResidualFraction);
  });

  it('the region model keeps the frame, and the residual is the seams and the four CORNERS', () => {
    const residual = SubtractPixelRects(page, regionModel(), DEFAULT_OCCLUSION_LIMITS.MaxPieces);
    expect(residual).not.toBeNull();
    let left = 0;
    for (const r of residual!) left += PixelRectArea(r);
    expect(left / PixelRectArea(page)).toBeLessThan(DEFAULT_OCCLUSION_LIMITS.MaxResidualFraction);
    expect(PixelRectArea(page) - left).toBe(3_899_784);
  });
});

// ── 3. WHAT THE WALK NOW DOES ──────────────────────────────────────────────────────────────────

describe('occlusion on glass-grid — the carve fires', () => {
  const w = walk('');

  it('carves the page fill into eight pieces and withholds 3,899,784 device px', () => {
    expect({
      Skipped: w.Census.Skipped, Carved: w.Census.Carved,
      Pieces: w.Census.Pieces, Px: w.Census.Px, Vacuous: w.Census.Vacuous,
    }).toEqual({ Skipped: 0, Carved: 1, Pieces: 8, Px: 3_899_784, Vacuous: 0 });
    // 22,576 px more than the old 183 px corner blocks withheld: the four blocks shrink from
    // 183 x 149 (twice) and 183 x 183 (twice) to 166 x 132 and 166 x 166.
    expect(w.Plan.get('PerfPage')?.Kind).toBe('Carve');
  });

  it('the eight pieces are the four screen CORNERS, the top strip and the three seam rows', () => {
    const pieces = [...(w.Plan.get('PerfPage')?.Pieces ?? [])]
      .sort((a, b) => (a.Y0 - b.Y0) || (a.X0 - b.X0));
    expect(pieces).toEqual([
      // band 0 is under the area floor, so its 34 rows are drawn rather than covered
      { X0: 0, Y0: 0, X1: 2560, Y1: 34 },
      { X0: 0, Y0: 34, X1: 166, Y1: 166 },        // top-left screen corner
      { X0: 2394, Y0: 34, X1: 2560, Y1: 166 },    // top-right
      { X0: 0, Y0: 466, X1: 2560, Y1: 467 },      // seam at device y 466.67
      { X0: 0, Y0: 899, X1: 2560, Y1: 901 },      // the "whole" seam at 900, to float dust
      { X0: 0, Y0: 1333, X1: 2560, Y1: 1334 },    // seam at 1333.33
      { X0: 0, Y0: 1434, X1: 166, Y1: 1600 },     // bottom-left screen corner
      { X0: 2394, Y0: 1434, X1: 2560, Y1: 1600 }, // bottom-right
    ]);
  });

  it('every piece edge is a WHOLE device coordinate or the page fill\'s own edge', () => {
    // The carve's pixel-exactness rests on this and on nothing else: a whole-coordinate edge is at
    // least 0.5 from every pixel centre, so it is never the nearest edge inside the piece and
    // contributes alpha exactly 1, while an edge on the fill's own edge reproduces its feather.
    const shape = w.Admitted[0].Shape;
    for (const p of w.Plan.get('PerfPage')!.Pieces!) {
      for (const v of [p.X0, p.Y0, p.X1, p.Y1]) expect(Number.isInteger(v)).toBe(true);
      expect(p.X0).toBeGreaterThanOrEqual(shape.X0);
      expect(p.Y0).toBeGreaterThanOrEqual(shape.Y0);
      expect(p.X1).toBeLessThanOrEqual(shape.X1);
      expect(p.Y1).toBeLessThanOrEqual(shape.Y1);
    }
  });

  it('the four bands that cover nothing say so BY NAME, where the census used to say nothing', () => {
    // Three have no later coverer over them at all; `PerfBand[1]` is clipped by `PerfBand[2]`'s
    // first row and is a GRADIENT, which may cover and may never be carved.
    expect(w.Census.Notes).toEqual({ NoCover: 3, Capped: 0, NotCarvable: 1, TooMuchLeft: 0, TooSmall: 0 });
  });

  it('?occlusion=off is the previous engine: no plan, no verdict, no instance withheld', () => {
    const off = walk('?occlusion=off');
    expect(off.Census.Armed).toBe(false);
    expect(off.Census.Candidates).toBe(0);
    expect(off.Plan.size).toBe(0);
  });

  it('still carves as the bed slides, which is what the scene does for the whole window', () => {
    // `Perf.GlassGrid.ts` moves the bed 180 x 120 pt per frame off `PerfMotion().Bed(frame)`. The
    // seams move with it, so the piece COUNT breathes; the verdict must not.
    for (const dy of [-120, -60, -13.5, 17.25, 60, 120]) {
      const slid = walk('', (c) => buildGlassGrid(c, 0, dy));
      expect(slid.Census.Carved).toBe(1);
      expect(slid.Census.Vacuous).toBe(0);
      expect(slid.Census.Px).toBeGreaterThan(3_500_000);
    }
  });
});

// ── 4. THE SAFETY VALVE ────────────────────────────────────────────────────────────────────────

/** FIVE nested rounded clipping shells over a full-bleed fill and one opaque band. Each rounded
 *  clip adds two wing rects to the region, so the fifth takes the product past `MAX_COVER_RECTS`
 *  — the path where the coverer falls back to the single all-sides-inset rect (a SUBSET of the
 *  region, so always a legal answer) instead of being refused. */
const buildNestedRoundClips = (c: Canvas): Map<Jiv, string> => {
  const named = new Map<Jiv, string>();
  const shell = (left: number, top: number, w: number, h: number, r: number): Jiv => new Jiv({
    Overflow: 'Hidden',
    ChildLayout: { Position: 'Placed', Left: left + 'pt', Top: top + 'pt', Width: w + 'pt', Height: h + 'pt' },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { PointScale: '1', BorderRadius: r + 'pt', Background: CLEAR, ...OPAQUE },
  });
  const outer = new Jiv({
    Overflow: 'Hidden',
    ChildLayout: { FlexGrow: 1 },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { PointScale: '1', BorderRadius: '20pt', Background: CLEAR, ...OPAQUE },
  });
  const mid = shell(20, 13, 1230, 780, 14);
  const inner = shell(9, 7, 1215, 770, 9);
  const inner2 = shell(5, 3, 1208, 764, 7);
  const innermost = shell(4, 2, 1200, 760, 5);
  const page = new Jiv({
    ChildLayout: { Position: 'Placed', Left: '0pt', Top: '0pt', Width: '1200pt', Height: '760pt' },
    Style: { PointScale: '1', Background: 'rgb(0, 0, 0)', ...OPAQUE },
  });
  named.set(page, 'Page');
  const band = new Jiv({
    ChildLayout: { Position: 'Placed', Left: '0pt', Top: '0pt', Width: '1200pt', Height: '760pt' },
    Style: { Background: 'rgb(30, 30, 30)', ...OPAQUE },
  });
  named.set(band, 'Band');
  innermost.AddChild(page);
  innermost.AddChild(band);
  inner2.AddChild(innermost);
  inner.AddChild(inner2);
  mid.AddChild(inner);
  outer.AddChild(mid);
  c.Root.AddChild(outer);
  return named;
};

describe('occlusion — a coverer under more rounded clips than the region can carry', () => {
  const w = walk('', buildNestedRoundClips);

  it('falls back to the ONE inset rect rather than refusing the coverer', () => {
    // The valve fired: a region that had not capped would carry the mid row and six wings.
    for (const a of w.Admitted) expect(a.Region.length).toBe(1);
    expect(w.Census.Coverers).toBe(2);
    expect(w.Census.Vacuous).toBe(0);
    expect(w.Census.Skipped + w.Census.Carved).toBe(1);
  });

  it('...and the fallback is the CONSERVATIVE answer: it withholds less, never more', () => {
    // Every clip insets on all four sides, so what is left is the innermost inset box and the
    // piece list is a frame rather than four corners. Strictly inside the honest region's claim.
    expect(w.Census.Px).toBeGreaterThan(0);
    expect(w.Census.Px).toBeLessThan(PixelRectArea({ X0: 0, Y0: 0, X1: 1200 * DPR, Y1: 760 * DPR }));
  });
});

// ── 5. THE ALARM ───────────────────────────────────────────────────────────────────────────────

/** A fill, a scene read, and two opaque bands AFTER the read — so the coverers exist, are admitted
 *  and are counted, and not one of them may legally count for anything. Nothing is withheld, and
 *  the pixel gate reads 0 either way. */
const buildVacuous = (c: Canvas): Map<Jiv, string> => {
  const named = new Map<Jiv, string>();
  const page = new Jiv({
    ChildLayout: { FlexGrow: 1 },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { PointScale: '1', Background: 'rgb(0, 0, 0)', ...OPAQUE },
  });
  named.set(page, 'Page');
  // The read, FIRST: a glass slab over the whole page, before either band lands.
  page.AddChild(new Jiv({
    ChildLayout: { Position: 'Placed', Left: '0pt', Top: '0pt', Width: '1280pt', Height: '800pt' },
    Style: { Background: CLEAR, Thickness: '2.5', Refraction: '8', ...OPAQUE },
  }));
  for (let i = 0; i < 2; i++) {
    page.AddChild(new Jiv({
      ChildLayout: { Position: 'Placed', Left: '0pt', Top: (i * 400) + 'pt', Width: '1280pt', Height: '400pt' },
      Style: { Background: 'rgb(30, 30, 30)', ...OPAQUE },
    }));
  }
  c.Root.AddChild(page);
  return named;
};

describe('occlusion — the census says WHEN the pre-pass is dead', () => {
  it('a plan that had something to rule on and withheld nothing reads vacuous=1', () => {
    const v = walk('', buildVacuous);
    expect(v.Census.Candidates).toBeGreaterThanOrEqual(2);
    expect(v.Census.Coverers).toBeGreaterThanOrEqual(1);
    expect(v.Census.Skipped).toBe(0);
    expect(v.Census.Pieces).toBe(0);
    expect(v.Census.Vacuous).toBe(1);
    // ...and the alarm is never the only thing said: a reason is on the census beside it.
    expect(v.Census.Notes.NoCover).toBeGreaterThan(0);
  });

  it('the alarm is not stuck on: the frame that carves reads vacuous=0', () => {
    expect(walk('').Census.Vacuous).toBe(0);
  });

  it('the gate line and the [Jaui] census both carry it, so no fold can pass this silently again', () => {
    // Read out of the source rather than off a trace: `JTrace` prints the gate line on a SHAPE
    // change, and a test that drove one frame would assert on whether the line was NEW.
    const jaui = readJaui();
    expect(jaui).toContain('vacuous=${st.Vacuous}');
    expect(jaui).toContain('occludedVacuous=${this._occlusionStats.Vacuous}');
    expect(jaui).toContain('OcclusionNotesLine(st.Notes)');
  });
});
