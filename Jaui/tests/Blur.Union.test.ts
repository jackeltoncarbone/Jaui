import { describe, it, expect } from 'vitest';
import {
  BaseDownsampleFactor, PyramidDepth, ResolveRegionRect, PyramidFill, PlanBackdropUnion,
  type BackdropRect,
} from '../src/Core/BlurPass';

/**
 * The union backdrop pyramid: one blur per (sigma, k) class instead of one per surface.
 *
 * Everything here is arithmetic over the SAME functions the pass runs, which is the point of
 * their being at module scope. A planner with its own copy of `BaseDownsampleFactor` can agree
 * with the pass on a whiteboard and disagree with it on a phone, and the entire pixel-identity
 * argument is the claim that those two numbers are one number.
 */

// The harness's geometry, pinned: 1280x800 CSS at deviceScaleFactor 2.
const CANVAS_W = 2560;
const CANVAS_H = 1600;
const DPR = 2;

/** JwiftGlass: BackdropFilter Blur(4pt), Thickness 2.5, Fillet 0, Refraction 8, CA 0.25.
 *  Jaui.ts: margin = frostCssPx*d + (thicknessDev + bulge)*Refraction + CA*3 + 8*d. */
const GLASS_MARGIN = 4 * DPR + (2.5 * DPR) * 8 + 0.25 * 3 + 8 * DPR;   // 64.75
/** JwiftGlass: ShadowBlur 16pt, ShadowOffsetY 2pt, so its fragments reach this far past the box. */
const GLASS_PAINT_OUTSET_Y = (16 + 2) * DPR;                            // 36
const GLASS_PAINT_OUTSET_X = 16 * DPR;                                  // 32
/** BackdropFilter: Blur(4pt) at DPR 2. */
const GLASS_RADIUS = 4 * DPR;

/** Jaui.ts's region, for a box already in device px. */
const RegionFor = (x: number, y: number, w: number, h: number, margin = GLASS_MARGIN): BackdropRect => ({
  x: Math.max(0, Math.floor(x - margin)),
  y: Math.max(0, Math.floor(y - margin)),
  w: Math.min(CANVAS_W, Math.ceil(w + margin * 2)),
  h: Math.min(CANVAS_H, Math.ceil(h + margin * 2)),
});

const Intersects = (a: BackdropRect, b: BackdropRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** glass-grid / idle / video-glass: PerfGrid at 60pt,70pt; 216x150pt cards, 20pt gap, 5 across. */
const GlassGridCards = (gapPt = 20): { Box: BackdropRect; Region: BackdropRect }[] => {
  const out: { Box: BackdropRect; Region: BackdropRect }[] = [];
  for (let i = 0; i < 20; i++) {
    const col = i % 5, row = (i / 5) | 0;
    const Box = {
      x: (60 + col * (216 + gapPt)) * DPR,
      y: (70 + row * (150 + gapPt)) * DPR,
      w: 216 * DPR,
      h: 150 * DPR,
    };
    out.push({ Box, Region: RegionFor(Box.x, Box.y, Box.w, Box.h) });
  }
  return out;
};

describe('the grid the whole identity rests on', () => {
  it('resolves a glass-grid card to the 568x436 the region comment documents', () => {
    const card = GlassGridCards()[0];
    const k = BaseDownsampleFactor(GLASS_RADIUS, CANVAS_W, CANVAS_H, card.Region);
    const depth = PyramidDepth(GLASS_RADIUS / k, 0);
    expect(k).toBe(1);
    expect(depth).toBe(2);
    const r = ResolveRegionRect(card.Region, CANVAS_W, CANVAS_H, k * (1 << depth));
    expect([r.W, r.H]).toEqual([568, 436]);
  });

  it('counts a card pyramid at the 0.387Mpx the finding derives, and twenty at 7.74Mpx', () => {
    expect(PyramidFill(568, 436, 1, 2)).toBe(386950);
    expect(20 * PyramidFill(568, 436, 1, 2)).toBe(7739000);
  });

  it('every card lands on the same extent, which is what stops the level FBOs thrashing', () => {
    const sizes = new Set(GlassGridCards().map((c) => {
      const r = ResolveRegionRect(c.Region, CANVAS_W, CANVAS_H, 4);
      return `${r.W}x${r.H}`;
    }));
    expect([...sizes]).toEqual(['568x436']);
  });
});

describe('PlanBackdropUnion', () => {
  it('refuses a class of one, so a surface with no sibling costs exactly what it costs today', () => {
    const one = GlassGridCards()[0].Region;
    expect(PlanBackdropUnion([one], CANVAS_W, CANVAS_H, GLASS_RADIUS)).toBeNull();
  });

  it('refuses two surfaces at opposite corners: the union is most of the screen', () => {
    const a = RegionFor(40, 40, 200, 120);
    const b = RegionFor(CANVAS_W - 260, CANVAS_H - 180, 200, 120);
    expect(PlanBackdropUnion([a, b], CANVAS_W, CANVAS_H, GLASS_RADIUS)).toBeNull();
  });

  it('takes a toolbar row and wins, at a ratio worth the machinery', () => {
    // A phone viewport, which is the machine the lane exists for: 393x852 CSS at DPR 2. Six 38pt
    // chips on a 44pt pitch is what fits: a chip's 206px region is nearly three times its 76px
    // box, so only about seven of them fit across the screen before one runs into the right edge
    // and the clamp below disqualifies the class. The brief's twenty-chip row does not exist on
    // this viewport, and its ~5.3x is the number for a row that would have to be 1520px wide.
    const W = 786, H = 1704;
    const chips: BackdropRect[] = [];
    for (let i = 0; i < 6; i++) {
      const x = 72 + i * 88, y = 120;
      chips.push({
        x: Math.max(0, Math.floor(x - GLASS_MARGIN)),
        y: Math.max(0, Math.floor(y - GLASS_MARGIN)),
        w: Math.min(W, Math.ceil(38 * DPR + GLASS_MARGIN * 2)),
        h: Math.min(H, Math.ceil(38 * DPR + GLASS_MARGIN * 2)),
      });
    }
    const plan = PlanBackdropUnion(chips, W, H, GLASS_RADIUS);
    expect(plan).not.toBeNull();
    expect(plan!.K).toBe(1);
    // 1.95x, not the 5.3x the brief projects for a twenty-chip row that does not fit here.
    expect(plan!.MemberFill / plan!.Fill).toBeCloseTo(1.95, 2);
  });

  it('refuses the same row when one chip reaches the right edge of a 786px viewport', () => {
    // 786 is not a multiple of the depth-2 phase of 4, so the extent clamp hands back a width
    // floor(W/2) cannot halve exactly. One member is enough to disqualify the class.
    const W = 786, H = 1704;
    const chips: BackdropRect[] = [];
    for (let i = 0; i < 9; i++) {
      const x = 72 + i * 88;
      chips.push({
        x: Math.max(0, Math.floor(x - GLASS_MARGIN)),
        y: Math.max(0, Math.floor(120 - GLASS_MARGIN)),
        w: Math.min(W, Math.ceil(38 * DPR + GLASS_MARGIN * 2)),
        h: Math.min(H, Math.ceil(38 * DPR + GLASS_MARGIN * 2)),
      });
    }
    expect(PlanBackdropUnion(chips, W, H, GLASS_RADIUS)).toBeNull();
  });

  it('PINS k to the members: a union over the 15% gate would otherwise pick 2 and resample', () => {
    // Four cards whose regions are each under 15% of the canvas and whose union is over it.
    const boxes = [
      RegionFor(200, 200, 400, 300),
      RegionFor(1400, 200, 400, 300),
      RegionFor(200, 900, 400, 300),
      RegionFor(1400, 900, 400, 300),
    ];
    const full = CANVAS_W * CANVAS_H;
    for (const b of boxes) expect(b.w * b.h).toBeLessThan(0.15 * full);
    const unionRaw = {
      x: Math.min(...boxes.map((b) => b.x)),
      y: Math.min(...boxes.map((b) => b.y)),
      w: Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x)),
      h: Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y)),
    };
    expect(unionRaw.w * unionRaw.h).toBeGreaterThan(0.15 * full);
    // Left to itself the union would take 2. That is the resample the pin exists to stop.
    expect(BaseDownsampleFactor(GLASS_RADIUS, CANVAS_W, CANVAS_H, unionRaw)).toBe(2);

    const plan = PlanBackdropUnion(boxes, CANVAS_W, CANVAS_H, GLASS_RADIUS);
    if (plan !== null) expect(plan.K).toBe(1);
  });

  it('refuses a class whose members do not agree on k', () => {
    const small = RegionFor(100, 100, 300, 200);
    const huge = { x: 0, y: 0, w: 2000, h: 1400 };                  // over 15% of the canvas
    expect(BaseDownsampleFactor(32, CANVAS_W, CANVAS_H, small)).toBe(1);
    expect(BaseDownsampleFactor(32, CANVAS_W, CANVAS_H, huge)).toBe(8);
    expect(PlanBackdropUnion([small, huge], CANVAS_W, CANVAS_H, 32)).toBeNull();
  });

  it('refuses when the canvas edge clamps an extent off the phase grid', () => {
    // 1234 is not a multiple of the depth-2 phase of 4, so a rect against the right edge comes
    // back with an extent that floor(W/2) no longer halves exactly, and level 2 drifts.
    const W = 1234, H = 800;
    const a: BackdropRect = { x: 40, y: 40, w: 300, h: 200 };
    const b: BackdropRect = { x: W - 300, y: 40, w: 300, h: 200 };
    const phase = 4;
    const rb = ResolveRegionRect(b, W, H, phase);
    expect(rb.W % phase).not.toBe(0);
    expect(PlanBackdropUnion([a, b], W, H, GLASS_RADIUS)).toBeNull();
  });

  it('keeps every member inside the union it plans', () => {
    const members = GlassGridCards(56).map((c) => c.Region);
    const plan = PlanBackdropUnion(members, CANVAS_W, CANVAS_H, GLASS_RADIUS);
    expect(plan).not.toBeNull();
    const u = ResolveRegionRect(plan!.Region, CANVAS_W, CANVAS_H, plan!.Phase);
    for (const m of members) {
      const r = ResolveRegionRect(m, CANVAS_W, CANVAS_H, plan!.Phase);
      expect(r.X).toBeGreaterThanOrEqual(u.X);
      expect(r.YBottom).toBeGreaterThanOrEqual(u.YBottom);
      expect(r.X + r.W).toBeLessThanOrEqual(u.X + u.W);
      expect(r.YBottom + r.H).toBeLessThanOrEqual(u.YBottom + u.H);
      // Congruent origins mod phase is the whole crop argument.
      expect((r.X - u.X) % plan!.Phase).toBe(0);
      expect((r.YBottom - u.YBottom) % plan!.Phase).toBe(0);
    }
  });

  it('refuses three cards spread across the canvas: a union wider than its members loses', () => {
    // The win is not sharing, it is OVERLAP. Member regions that do not overlap union to more
    // area than they cover, every time, and the strict Fill < MemberFill test says so with no
    // separate distance heuristic needed beside it.
    const members = [RegionFor(200, 200, 300, 200), RegionFor(900, 200, 300, 200), RegionFor(1600, 200, 300, 200)];
    expect(PlanBackdropUnion(members, CANVAS_W, CANVAS_H, GLASS_RADIUS)).toBeNull();
  });
});

/**
 * The separation law, which is the filter that actually decides this on real layouts and the
 * reason glass-grid does not move. A glass surface's backdrop is the scene AS OF ITS OWN DRAW,
 * and a glass panel paints its body, its rim and a 16pt drop shadow. So a later sibling whose
 * SAMPLE REGION overlaps an earlier sibling's PAINT genuinely refracts that sibling today, and
 * one snapshot cannot reproduce two different scenes.
 *
 * Jaui.ts enforces this from the walk it just ran; these tests pin the geometry the law turns on
 * so that a layout change that silently moves glass-grid into or out of the window is visible
 * here rather than only in a pixel diff.
 */
describe('the separation law', () => {
  const PaintRect = (b: BackdropRect): BackdropRect => ({
    x: b.x - GLASS_PAINT_OUTSET_X, y: b.y - GLASS_PAINT_OUTSET_Y,
    w: b.w + GLASS_PAINT_OUTSET_X * 2, h: b.h + GLASS_PAINT_OUTSET_Y * 2,
  });

  it('glass-grid FAILS it: a 20pt gap is inside the 64.75px sample margin', () => {
    const cards = GlassGridCards();
    expect(Intersects(cards[1].Region, PaintRect(cards[0].Box))).toBe(true);
    // And it is not one unlucky pair — every card after the first has a predecessor under it.
    const dirty = cards.slice(1).filter((c, i) =>
      cards.slice(0, i + 1).some((e) => Intersects(c.Region, PaintRect(e.Box))));
    expect(dirty.length).toBe(19);
  });

  it('the window is not empty: the same grid at a 56pt gap clears both the law and the maths', () => {
    const cards = GlassGridCards(56);
    const dirty = cards.slice(1).filter((c, i) =>
      cards.slice(0, i + 1).some((e) => Intersects(c.Region, PaintRect(e.Box))));
    expect(dirty.length).toBe(0);
    const plan = PlanBackdropUnion(cards.map((c) => c.Region), CANVAS_W, CANVAS_H, GLASS_RADIUS);
    expect(plan).not.toBeNull();
    expect(plan!.Fill).toBeLessThan(plan!.MemberFill);
    // And this is the whole prize, on the tightest grid the law allows: 1.09x. Twenty builds
    // become one and the blur FILL falls by eight percent, because the pitch the law forces is
    // the pitch at which the member regions have almost stopped overlapping. See the law's own
    // describe() block below for why those two numbers cannot both be large.
    expect(plan!.MemberFill / plan!.Fill).toBeCloseTo(1.09, 2);
  });

  it('names the gap the law asks for, so the number is a fact and not a feeling', () => {
    // gap > later surface's sample margin + earlier surface's paint outset.
    expect(GLASS_MARGIN + GLASS_PAINT_OUTSET_X).toBeCloseTo(96.75, 5);
    expect((GLASS_MARGIN + GLASS_PAINT_OUTSET_X) / DPR).toBeCloseTo(48.375, 5);
  });
});

/**
 * THE RESULT, and it is a negative one. The two conditions a union has to satisfy are in direct
 * tension, and the band where both hold is both narrow and nearly worthless. Over a row or grid of
 * equal surfaces on pitch p:
 *
 *   LEGAL   needs p greater than box + margin + outset  — otherwise the earlier surface's PAINT
 *                                                         lands inside the later surface's SAMPLE
 *                                                         REGION, and the later one genuinely
 *                                                         refracts its neighbour today.
 *   WINS    needs p less than about box + 2*margin      — a union is (N-1)p + box + 2m across
 *                                                         against members summing to N(box + 2m),
 *                                                         so it saves only where the member regions
 *                                                         OVERLAP, i.e. where the pitch is under a
 *                                                         region's own width.
 *
 * Both are monotone in p and they point opposite ways, so the saving is largest exactly where the
 * law forbids it and has decayed to nothing by the time the law allows it. The sweep below is the
 * evidence: on glass-grid's own cards the union becomes legal at a 52pt gap and has stopped paying
 * by 68pt, and across that whole window it is worth at most 1.12x.
 *
 * The brief's 5.3x is not in here at any pitch. It is not a matter of the law: even ignoring
 * correctness completely and packing the cards at an 8pt gap, twenty of them union to 1.52x, and
 * six 38pt chips at a 6pt gap to 1.95x. The 5.3x is derived from twenty 38pt chips across a 393pt
 * phone, which is 1520 device px of chip in 786 px of screen — the chips would have to overlap each
 * other 2.5x. There is no arrangement of real surfaces that produces it.
 */
describe('the legal band and the winning band', () => {
  const BOX = 216 * DPR;
  const Row = (pitch: number, n = 5): { Box: BackdropRect; Region: BackdropRect }[] =>
    Array.from({ length: n }, (_, i) => {
      const Box = { x: 200 + i * pitch, y: 400, w: BOX, h: 150 * DPR };
      return { Box, Region: RegionFor(Box.x, Box.y, Box.w, Box.h) };
    });
  const PaintRect = (b: BackdropRect): BackdropRect => ({
    x: b.x - GLASS_PAINT_OUTSET_X, y: b.y - GLASS_PAINT_OUTSET_Y,
    w: b.w + GLASS_PAINT_OUTSET_X * 2, h: b.h + GLASS_PAINT_OUTSET_Y * 2,
  });
  const Legal = (row: { Box: BackdropRect; Region: BackdropRect }[]): boolean =>
    row.every((c, i) => row.slice(0, i).every((e) => !Intersects(c.Region, PaintRect(e.Box))));
  const Ratio = (cells: { Region: BackdropRect }[]): number => {
    const plan = PlanBackdropUnion(cells.map((c) => c.Region), CANVAS_W, CANVAS_H, GLASS_RADIUS);
    return plan === null ? 1 : plan.MemberFill / plan.Fill;
  };

  it('opens the law at a 52pt gap and closes the arithmetic by 68pt', () => {
    expect(Legal(GlassGridCards(48))).toBe(false);
    expect(Legal(GlassGridCards(52))).toBe(true);
    expect(Ratio(GlassGridCards(64))).toBeGreaterThan(1);
    expect(Ratio(GlassGridCards(68))).toBe(1);        // no plan survives: the union costs more
  });

  it('is worth at most 1.12x anywhere it is legal, on the grid the harness measures', () => {
    const legalRatios = [52, 56, 60, 64, 68, 80, 100]
      .map((gap) => GlassGridCards(gap))
      .filter(Legal)
      .map(Ratio);
    expect(legalRatios.length).toBeGreaterThan(3);
    expect(Math.max(...legalRatios)).toBeLessThan(1.12);
  });

  it('would still only be worth 1.52x if the law were ignored entirely', () => {
    // glass-grid's real 20pt gap, and then tighter than any layout in the app.
    expect(Legal(GlassGridCards(20))).toBe(false);
    expect(Ratio(GlassGridCards(20))).toBeCloseTo(1.385, 2);
    expect(Ratio(GlassGridCards(8))).toBeCloseTo(1.516, 2);
  });

  it('holds for a chip class too, where the margin dominates the box', () => {
    const Chips = (gapPt: number) => Array.from({ length: 6 }, (_, i) => {
      const Box = { x: 200 + i * (38 * DPR + gapPt * DPR), y: 400, w: 38 * DPR, h: 38 * DPR };
      return { Box, Region: RegionFor(Box.x, Box.y, Box.w, Box.h) };
    });
    expect(Legal(Chips(44))).toBe(false);
    expect(Ratio(Chips(44))).toBeCloseTo(1.233, 2);   // the win, and it is not available
    expect(Legal(Chips(52))).toBe(true);
    expect(Ratio(Chips(52))).toBeCloseTo(1.144, 2);   // what is available
    expect(Ratio(Chips(6))).toBeCloseTo(1.951, 2);    // the ceiling, at a pitch that overlaps
  });
});
