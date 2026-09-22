import { describe, it, expect } from 'vitest';
import {
  BaseDownsampleFactor, PyramidDepth, ResolveRegionRect, ChainBytes, PlanBackdropUnion,
  MAX_LEVELS, type BackdropRect,
} from '../src/Core/BlurPass';
import {
  PyramidPasses, PlanBackdropAtlas, AtlasRunIsLegal, PackAtlasSlots, RectsOverlap,
  ATLAS_LIMITS_DEFAULT, type BackdropAtlasMember,
} from '../src/Core/Blur.Atlas';

/**
 * The atlas: one pyramid per LEVEL over N members' slots, so N x L encoders become L.
 *
 * Everything here is arithmetic over the SAME functions the pass runs. The two questions it
 * settles, in order, are: how many encoders IS a build (the brief assumed 15-20 and it is 4), and
 * may a frame's builds be issued together at all (on `glass-grid`, no).
 */

// The harness's geometry, pinned: 1280x800 CSS at deviceScaleFactor 2.
const CANVAS_W = 2560;
const CANVAS_H = 1600;
const DPR = 2;

/** JwiftGlass: BackdropFilter Blur(4pt), Thickness 2.5, Curvature 0, Refraction 8, CA 0.25.
 *  Jaui.ts `_glassFillBlurPlan`: margin = frostCssPx*d + (thicknessDev + bulge)*Refraction + CA*3 + 8*d. */
const GLASS_MARGIN = 4 * DPR + (2.5 * DPR) * 8 * (1 + 0.2 * 0.25) + 8 * DPR;   // 66
/** `_glassRimBlurPlan`: a border-only fragment makes ONE inward tap, so frost + a pixel pad. */
const RIM_MARGIN = 4 * DPR + 8 * DPR;                                   // 24
/** JwiftGlass: ShadowBlur 16pt, ShadowOffsetY 2pt — how far its fragments reach past the box. */
const PAINT_OUTSET_X = 16 * DPR;                                        // 32
const PAINT_OUTSET_Y = (16 + 2) * DPR;                                  // 36
const GLASS_RADIUS = 4 * DPR;
/** `GenerateBlurMipmap`'s argument for a JwiftGlass card: the pyramid is built AT the panel's own
 *  frost sigma, so `frostLod - baseFrostLod` is 0, `frostReq` is 0, the whole lodBoost is 0, and
 *  the adaptive shadow's own detail LOD (log2(max(frost, 4pt) * d) - baseFrostLod) is 0 too. */
const GLASS_MAX_LOD = 0;

const RegionFor = (b: BackdropRect, margin: number): BackdropRect => ({
  x: Math.max(0, Math.floor(b.x - margin)),
  y: Math.max(0, Math.floor(b.y - margin)),
  w: Math.min(CANVAS_W, Math.ceil(b.w + margin * 2)),
  h: Math.min(CANVAS_H, Math.ceil(b.h + margin * 2)),
});
const PaintFor = (b: BackdropRect): BackdropRect => ({
  x: b.x - PAINT_OUTSET_X, y: b.y - PAINT_OUTSET_Y,
  w: b.w + PAINT_OUTSET_X * 2, h: b.h + PAINT_OUTSET_Y * 2,
});

/** glass-grid / idle: PerfGrid at 60pt,70pt; 216x150pt cards, 20pt gap, 5 across, 4 down, in the
 *  walk order the grid emits them. */
const GlassGridBoxes = (gapPt = 20): BackdropRect[] =>
  Array.from({ length: 20 }, (_, i) => ({
    x: (60 + (i % 5) * (216 + gapPt)) * DPR,
    y: (70 + ((i / 5) | 0) * (150 + gapPt)) * DPR,
    w: 216 * DPR,
    h: 150 * DPR,
  }));

const Members = (boxes: BackdropRect[], margin = GLASS_MARGIN): BackdropAtlasMember[] =>
  boxes.map((b) => ({ Region: RegionFor(b, margin), Paint: PaintFor(b) }));

describe('PyramidPasses — what a build actually costs in encoders', () => {
  it('prices a glass-grid FILL build at four passes, not the brief\'s fifteen', () => {
    const region = RegionFor(GlassGridBoxes()[0], GLASS_MARGIN);
    const k = BaseDownsampleFactor(GLASS_RADIUS, CANVAS_W, CANVAS_H, region);
    const depth = PyramidDepth(GLASS_RADIUS / k, 0);
    const r = ResolveRegionRect(region, CANVAS_W, CANVAS_H, k * (1 << depth));
    expect([k, depth, r.W, r.H]).toEqual([1, 2, 568, 436]);

    const p = PyramidPasses(r.W, r.H, k, depth, GLASS_MAX_LOD);
    // No pre-downsample (k=1), two DOWN, two UP, and NO mip chain: `GenerateOutputMipmap` with
    // maxLod <= 0 is `DisableMipmap()` and a return.
    expect(p).toEqual({ Pre: 0, Down: 2, Up: 2, MipDraws: 0, Blits: 0, Encoders: 4 });
  });

  it('prices the RIM build the same, so glass-grid is 160 encoders a render and not 600-800', () => {
    const rim = RegionFor(GlassGridBoxes()[0], RIM_MARGIN);
    const depth = PyramidDepth(GLASS_RADIUS, 0);
    const r = ResolveRegionRect(rim, CANVAS_W, CANVAS_H, 1 << depth);
    expect([r.W, r.H]).toEqual([480, 348]);
    expect(PyramidPasses(r.W, r.H, 1, depth, GLASS_MAX_LOD).Encoders).toBe(4);
    // Twenty fills and twenty rims.
    expect(20 * 4 + 20 * 4).toBe(160);
  });

  it('counts the mip chain and its blits when a consumer can actually read one', () => {
    // maxLod 2 -> stopLevel 3 -> three DOWN draws and three blits on top of the pyramid's four.
    const p = PyramidPasses(568, 436, 1, 2, 2);
    expect([p.MipDraws, p.Blits, p.Encoders]).toEqual([3, 3, 10]);
    // No cap at all walks to MAX_LEVELS-1 or to 1x1, whichever comes first. Asserted against the
    // constant rather than against a copy of its value: this used to say 8, which was MAX_LEVELS-1 when
    // MAX_LEVELS was 9, so raising the ceiling to buy a deeper blur turned a correct chain red. The rule
    // is the one the comment already states; only the number was a snapshot.
    expect(PyramidPasses(568, 436, 1, 2).MipDraws).toBe(MAX_LEVELS - 1);
    // And it really is the LEVELS bound biting here, not the 1x1 one -- 568x436 still has room to halve
    // at MAX_LEVELS-1, which is what makes this test about the cap at all.
    expect(Math.min(568, 436) >> (MAX_LEVELS - 1)).toBe(0);
  });

  it('counts the sigma-adaptive pre-downsample as the passes it issues', () => {
    // k = 8 is three halvings before the pyramid starts.
    expect(PyramidPasses(2048, 1280, 8, 3, 0)).toEqual(
      { Pre: 3, Down: 3, Up: 3, MipDraws: 0, Blits: 0, Encoders: 9 },
    );
  });

  it('prices the sharp-root build at the single copy it is', () => {
    expect(PyramidPasses(2560, 1600, 1, 0, 0).Encoders).toBe(1);
  });
});

describe('the separation law, which is what decides this', () => {
  it('glass-grid FAILS it: the fill margin reaches 26px into the neighbour\'s box', () => {
    expect(GLASS_MARGIN).toBeCloseTo(66, 5);
    expect(GLASS_MARGIN - 20 * DPR).toBeCloseTo(26, 5);   // margin minus the gutter
    const m = Members(GlassGridBoxes());
    expect(RectsOverlap(m[0].Paint, m[1].Region)).toBe(true);
    expect(AtlasRunIsLegal(m, 0, 1)).toBe(false);
  });

  it('a checkerboard does not rescue it, which is why runs must be CONTIGUOUS', () => {
    const m = Members(GlassGridBoxes());
    // Cards 0 and 2 are far enough apart on their own...
    expect(RectsOverlap(m[0].Paint, m[2].Region)).toBe(false);
    // ...but card 1 is drawn between them, and card 1's paint IS inside card 2's region. Hoisting
    // card 2's build to card 0's point moves it past that draw.
    expect(RectsOverlap(m[1].Paint, m[2].Region)).toBe(true);
    expect(AtlasRunIsLegal(m, 0, 2)).toBe(false);
  });

  it('the row ABOVE counts too — the grid is connected in both axes, not just along a row', () => {
    const m = Members(GlassGridBoxes());
    // The 20pt row gap is the same 20pt, so a card's region reaches 26px up into the card
    // directly above it as well as sideways into its left neighbour.
    expect(RectsOverlap(m[0].Paint, m[5].Region)).toBe(true);    // card above card 5
    expect(RectsOverlap(m[1].Paint, m[5].Region)).toBe(true);    // and diagonally
  });

  it('the ONE adjacency it does not block is the row WRAP, at opposite ends of the grid', () => {
    const m = Members(GlassGridBoxes());
    // Card 4 is row 0 column 4 and card 5 is row 1 column 0 — 1004pt apart. They are consecutive
    // in walk order and nowhere near each other, so hoisting 5's build past 4's draw changes
    // nothing. It is the only legal pair on this layout, and there are three of them.
    expect(RectsOverlap(m[4].Paint, m[5].Region)).toBe(false);
    expect(AtlasRunIsLegal(m, 4, 5)).toBe(true);
    expect(AtlasRunIsLegal(m, 4, 6)).toBe(false);                // card 5's paint is in 6's region
  });

  it('every card after the first has a predecessor under it — nineteen of twenty', () => {
    const m = Members(GlassGridBoxes());
    const dirty = m.filter((c, j) => m.slice(0, j).some((e) => RectsOverlap(e.Paint, c.Region)));
    expect(dirty.length).toBe(19);
  });

  it('names the gap the law asks for, so the number is a fact and not a feeling', () => {
    // gap > the later surface's sample margin + the earlier surface's paint outset.
    expect(GLASS_MARGIN + PAINT_OUTSET_X).toBeCloseTo(98, 5);
    expect((GLASS_MARGIN + PAINT_OUTSET_X) / DPR).toBeCloseTo(49, 5);
  });

  it('opens at the same 52pt gap the union lane measured, on the same cards', () => {
    expect(AtlasRunIsLegal(Members(GlassGridBoxes(48)), 0, 19)).toBe(false);
    expect(AtlasRunIsLegal(Members(GlassGridBoxes(52)), 0, 19)).toBe(true);
  });
});

describe('PlanBackdropAtlas on the scene the phase is measured on', () => {
  it('finds only the three ROW WRAPS: 12 of 160 encoders, which is the lane\'s answer', () => {
    const plan = PlanBackdropAtlas(Members(GlassGridBoxes()), CANVAS_W, CANVAS_H, GLASS_RADIUS,
      { MaxLod: GLASS_MAX_LOD })!;
    expect(plan.Groups.map((g) => g.Members)).toEqual([[4, 5], [9, 10], [14, 15]]);
    expect(plan.Solo).toBe(14);
    // Three pairs, each 8 encoders collapsing to 4.
    expect(plan.EncodersSaved).toBe(12);
    // Against the frame's whole pyramid cost: 12 of 160, 7.5%. At the four-cell's 276 us per
    // four-pass build that is ~0.83 ms of a 25.42 ms render, for three atlases nothing else on
    // the page can reuse. It is a real saving and it is not a lever.
    expect(plan.EncodersSaved / 160).toBeCloseTo(0.075, 3);
  });

  it('refuses the RIM builds outright, for a different reason and with a harder answer', () => {
    // A rim's own margin (24px) clears the 40px gutter, so rim regions do NOT touch a neighbour's
    // box. What blocks them is that the card's OWN fill is drawn between one rim build and the
    // next, and a rim's region contains its card's whole box — so not even the row wrap survives.
    const boxes = GlassGridBoxes();
    const rims: BackdropAtlasMember[] = boxes.map((b, j) => ({
      Region: RegionFor(b, RIM_MARGIN),
      // Between rim j's build and rim j+1's, the walk draws rim j AND card j+1's whole fill.
      Paint: PaintFor(boxes[Math.min(boxes.length - 1, j + 1)]),
    }));
    expect(RectsOverlap(rims[0].Paint, rims[1].Region)).toBe(true);
    expect(RectsOverlap(rims[4].Paint, rims[5].Region)).toBe(true);   // the wrap, blocked here
    expect(PlanBackdropAtlas(rims, CANVAS_W, CANVAS_H, GLASS_RADIUS)).toBeNull();
  });

  it('is available on the same grid at a 52pt gap, and takes all twenty in ONE atlas', () => {
    const plan = PlanBackdropAtlas(Members(GlassGridBoxes(52)), CANVAS_W, CANVAS_H, GLASS_RADIUS,
      { MaxLod: GLASS_MAX_LOD });
    expect(plan).not.toBeNull();
    expect(plan!.Groups.length).toBe(1);
    expect(plan!.Groups[0].Members.length).toBe(20);
    expect(plan!.Solo).toBe(0);
    // Twenty four-pass builds become one four-pass build.
    expect(plan!.Groups[0].SoloEncoders).toBe(80);
    expect(plan!.Groups[0].Encoders).toBe(4);
    expect(plan!.EncodersSaved).toBe(76);
  });

  it('DOES NOT DECAY WITH PITCH, which is the whole difference from the union', () => {
    // The union saves only where the member regions OVERLAP, so its ratio collapses to nothing as
    // the pitch grows past a region's width — 1.09x at the legal edge and no plan at all by 68pt.
    // The atlas's slots are disjoint at every pitch, so its saving is the same 76 encoders at a
    // 52pt gap and at a 200pt one.
    const wide = PlanBackdropAtlas(Members(GlassGridBoxes(200)), CANVAS_W, CANVAS_H, GLASS_RADIUS,
      { MaxLod: GLASS_MAX_LOD });
    expect(PlanBackdropUnion(Members(GlassGridBoxes(68)).map((m) => m.Region),
      CANVAS_W, CANVAS_H, GLASS_RADIUS)).toBeNull();
    expect(wide).not.toBeNull();
    expect(wide!.EncodersSaved).toBe(76);
  });

  it('IgnoreSeparation prices the ruling: 160 encoders become 8, at ?blur-phased\'s pixels', () => {
    const fills = PlanBackdropAtlas(Members(GlassGridBoxes()), CANVAS_W, CANVAS_H, GLASS_RADIUS,
      { IgnoreSeparation: true, MaxLod: GLASS_MAX_LOD });
    const rims = PlanBackdropAtlas(Members(GlassGridBoxes(), RIM_MARGIN), CANVAS_W, CANVAS_H,
      GLASS_RADIUS, { IgnoreSeparation: true, MaxLod: GLASS_MAX_LOD });
    expect(fills!.Groups.length).toBe(1);
    expect(rims!.Groups.length).toBe(1);
    expect(fills!.Groups[0].Encoders + rims!.Groups[0].Encoders).toBe(8);
    expect(fills!.EncodersSaved + rims!.EncodersSaved).toBe(152);
  });

  it('prices the storage the ruling costs: ~55MB of atlas against 2.6MB of rotating pool', () => {
    const fills = PlanBackdropAtlas(Members(GlassGridBoxes()), CANVAS_W, CANVAS_H, GLASS_RADIUS,
      { IgnoreSeparation: true, Limits: { MaxTexture: 8192, BudgetBytes: 1 << 30 } });
    const rims = PlanBackdropAtlas(Members(GlassGridBoxes(), RIM_MARGIN), CANVAS_W, CANVAS_H,
      GLASS_RADIUS, { IgnoreSeparation: true, Limits: { MaxTexture: 8192, BudgetBytes: 1 << 30 } });
    // 1704x3052 and 1440x2436 — each slot at its own 568x436 / 480x348, shelved five deep.
    expect([fills!.Groups[0].AtlasW, fills!.Groups[0].AtlasH]).toEqual([1704, 3052]);
    expect([rims!.Groups[0].AtlasW, rims!.Groups[0].AtlasH]).toEqual([1440, 2436]);
    const atlasMb = (fills!.Groups[0].Bytes + rims!.Groups[0].Bytes) / (1024 * 1024);
    // Today: one chain per level-0 SIZE, and glass-grid produces exactly two sizes, so the whole
    // rotating pool for forty builds is two chains.
    const poolMb = (ChainBytes(568, 436) + ChainBytes(480, 348)) / (1024 * 1024);
    expect(poolMb).toBeCloseTo(2.637, 3);
    expect(atlasMb).toBeCloseTo(55.367, 2);         // 21x the storage, for the same fill
    expect(atlasMb).toBeGreaterThan(48);
    // The shipped 48MB ceiling admits ONE of the two atlases, not both — so a wired atlas needs
    // its own `ChainLimits`, exactly as `?blur-phased` needed one to hold twenty chains at once.
    expect(fills!.Groups[0].Bytes / (1024 * 1024)).toBeLessThan(48);
  });
});

describe('the slot grid, which is the texel argument', () => {
  const plan = PlanBackdropAtlas(Members(GlassGridBoxes(52)), CANVAS_W, CANVAS_H, GLASS_RADIUS,
    { MaxLod: GLASS_MAX_LOD })!;
  const g = plan.Groups[0];

  it('puts every slot origin and extent on the phase grid', () => {
    expect(plan.Phase).toBe(4);
    for (const s of g.Slots) {
      expect(s.X % plan.Phase).toBe(0);
      expect(s.YBottom % plan.Phase).toBe(0);
      expect(s.W % plan.Phase).toBe(0);
      expect(s.H % plan.Phase).toBe(0);
    }
    expect(g.AtlasW % plan.Phase).toBe(0);
    expect(g.AtlasH % plan.Phase).toBe(0);
  });

  it('halves exactly at every level the chain uses, for the atlas and for every slot at once', () => {
    for (let i = 1; i <= plan.Depth; i++) {
      const step = 1 << i;
      expect(g.AtlasW % step).toBe(0);
      expect(g.AtlasH % step).toBe(0);
      for (const s of g.Slots) {
        // Level i of the slot sits at origin / 2^i and is extent / 2^i across, with no slot
        // straddling a texel — which is what makes an atlas level a sub-grid of the standalone
        // level it replaces.
        expect(s.X % step).toBe(0);
        expect(s.YBottom % step).toBe(0);
        expect(s.W % step).toBe(0);
        expect(s.H % step).toBe(0);
      }
    }
  });

  it('keeps the slots disjoint, so one member\'s level never lands in another\'s', () => {
    for (let a = 0; a < g.Slots.length; a++) {
      for (let b = a + 1; b < g.Slots.length; b++) {
        const p = g.Slots[a], q = g.Slots[b];
        const overlap = p.X < q.X + q.W && p.X + p.W > q.X
          && p.YBottom < q.YBottom + q.H && p.YBottom + p.H > q.YBottom;
        expect(overlap).toBe(false);
      }
    }
  });

  it('holds every member at its OWN level-0 size — the fill is unchanged, only the binds are', () => {
    const rects = Members(GlassGridBoxes(52)).map((m) =>
      ResolveRegionRect(m.Region, CANVAS_W, CANVAS_H, plan.Phase));
    g.Members.forEach((idx, at) => {
      expect(g.Slots[at].W).toBe(rects[idx].W);
      expect(g.Slots[at].H).toBe(rects[idx].H);
    });
  });
});

describe('PackAtlasSlots refuses rather than guesses', () => {
  it('refuses a slot that is not on the phase grid', () => {
    expect(PackAtlasSlots([{ W: 566, H: 436 }], 4, ATLAS_LIMITS_DEFAULT)).toBeNull();
  });

  it('refuses a pack whose square-ish sheet is past MAX_TEXTURE_SIZE', () => {
    const wide = Array.from({ length: 4 }, () => ({ W: 4096, H: 4096 }));
    expect(PackAtlasSlots(wide, 4, { MaxTexture: 4096, BudgetBytes: 1 << 30 })).toBeNull();
  });

  it('shelves in member order, so slot k belongs to member k', () => {
    const p = PackAtlasSlots([{ W: 8, H: 4 }, { W: 8, H: 4 }, { W: 8, H: 4 }, { W: 8, H: 4 }],
      4, ATLAS_LIMITS_DEFAULT)!;
    // Area 128, sqrt 12 -> shelf target 12, so two 8-wide slots never share a shelf.
    expect(p.AtlasW).toBe(8);
    expect(p.AtlasH).toBe(16);
    expect(p.Slots.map((s) => s.X)).toEqual([0, 0, 0, 0]);
    expect(p.Slots.map((s) => s.YBottom)).toEqual([12, 8, 4, 0]);
  });
});

describe('the classification an atlas shares with the union, and the one it does not', () => {
  it('refuses a class whose members do not agree on k', () => {
    const small = { Region: RegionFor({ x: 100, y: 100, w: 300, h: 200 }, 0), Paint: { x: 0, y: 0, w: 0, h: 0 } };
    const huge = { Region: { x: 0, y: 0, w: 2000, h: 1400 }, Paint: { x: 0, y: 0, w: 0, h: 0 } };
    expect(BaseDownsampleFactor(32, CANVAS_W, CANVAS_H, small.Region)).toBe(1);
    expect(BaseDownsampleFactor(32, CANVAS_W, CANVAS_H, huge.Region)).toBe(8);
    expect(PlanBackdropAtlas([small, huge], CANVAS_W, CANVAS_H, 32)).toBeNull();
  });

  it('refuses a class of one, so a lone surface costs exactly what it costs today', () => {
    expect(PlanBackdropAtlas(Members(GlassGridBoxes()).slice(0, 1), CANVAS_W, CANVAS_H,
      GLASS_RADIUS)).toBeNull();
  });

  it('sends a canvas-clamped member SOLO instead of killing the class, unlike a union', () => {
    // A rect against a canvas edge whose width is not a multiple of phase comes back with an
    // extent floor(W/2) cannot halve. The union disqualifies the whole class for it (all its
    // members share one rect); an atlas disqualifies only that slot.
    const W = 1234, H = 800, phase = 4;
    const boxes: BackdropRect[] = [
      { x: 200, y: 400, w: 200, h: 120 },
      { x: 600, y: 400, w: 200, h: 120 },
      { x: W - 120, y: 400, w: 100, h: 120 },
    ];
    const members: BackdropAtlasMember[] = boxes.map((b) => ({
      Region: { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 24),
        w: Math.min(W, b.w + 48), h: Math.min(H, b.h + 48) },
      Paint: b,
    }));
    expect(ResolveRegionRect(members[2].Region, W, H, phase).W % phase).not.toBe(0);
    expect(PlanBackdropUnion(members.map((m) => m.Region), W, H, GLASS_RADIUS)).toBeNull();
    const plan = PlanBackdropAtlas(members, W, H, GLASS_RADIUS, { MaxLod: GLASS_MAX_LOD });
    expect(plan).not.toBeNull();
    expect(plan!.Groups.length).toBe(1);
    expect(plan!.Groups[0].Members).toEqual([0, 1]);
    expect(plan!.Solo).toBe(1);
  });
});
