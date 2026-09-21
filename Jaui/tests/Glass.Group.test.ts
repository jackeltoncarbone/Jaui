/**
 * `?glass-group` ON GLASS-GRID - the container-scoped shared backdrop, driven through the REAL walk.
 *
 * Jack's ruling of 2026-09-20, stated as engine law and then checked against the engine:
 *
 *   A glass GROUP is a run of glass siblings under one parent. Its backdrop is the scene AS OF THE
 *   WALK'S ENTRY to the group - captured once, before any member paints - and every member samples
 *   it. Nothing painted inside the group is ever sampled by another member. A group entered later
 *   in the walk captures the scene with earlier groups' glass already in it.
 *
 * WHAT IS REAL HERE and what is not, because that distinction is the whole value of the file:
 *
 *   REAL - the walk (`_blurFirstNode`, which the plan scan rides, and `_render`, which builds and
 *   draws), the flex solver that wraps the grid 5 across and 4 down, `_composeTransform`,
 *   `_glassFillBlurPlan`, `_planGlassGroups`, `PlanBackdropUnion`, the flag's refusal chain, and
 *   the ORDER the engine issues its own calls in. One `RenderHeadless` is one real frame of the
 *   engine against a recording renderer.
 *
 *   TRANSCRIBED - the Angular templates. `Perf.GlassGrid.ts`'s tree and `App.ts`'s shell are built
 *   here as `Jiv`s with every NUMBER read out of `Perf.jss`, `App.jss` and `Jwift.Glass.jss`, as
 *   `Occlusion.GlassGrid.test.ts` does, so a re-spaced grid or a retuned glass moves this file
 *   instead of silently invalidating it. `ChromaticAberration` is transcribed here and is NOT in
 *   the occlusion file: it is 0.75 device px of sample margin, which is nothing to a coverage
 *   lever and is the difference between a 560 px member rect and the 568 px one the blur path
 *   documents.
 *
 *   NOT HERE - a rasteriser, and no GL at all. Nothing below proves a texel. It proves WHICH
 *   pyramid each surface samples and WHEN it was built; the orchestrator's pixel gate is the proof
 *   that the picture is the one Jack ruled.
 */
import { describe, it, expect } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { WebGL2Renderer } from '@jaui/Core/WebGL2.Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';
import {
  BaseDownsampleFactor, PyramidDepth, PyramidFill, ResolveRegionRect, PlanBackdropUnion,
  type BackdropRect,
} from '@jaui/Core/BlurPass';
import { readPerfJss, readAppJss, readJwiftGlass, jssClass, jssValue, jssNumber } from './Scene.ReadAfterWrite.Source';

// -- The sheets, read rather than restated. ----------------------------------------------------

const PERF = readPerfJss();
const PAGE = jssClass(PERF, 'PerfPage');
const BED = jssClass(PERF, 'PerfBed');
const GRID = jssClass(PERF, 'PerfGrid');
const CARD = jssClass(PERF, 'PerfCard');
const SCREEN = jssClass(readAppJss(), 'Screen');
const GLASS = readJwiftGlass();
const SCREEN_RADIUS_PT = (() => {
  const m = /@JwiftScreenRadius:\s*([\d.]+)pt/.exec(GLASS);
  if (!m) throw new Error('no @JwiftScreenRadius in Jwift.Glass.jss');
  return parseFloat(m[1]);
})();
/** A number authored in the `JwiftGlass` rule itself, taken from the FIRST occurrence after that
 *  rule opens so a later class overriding it cannot be read as the base's. */
const glassNumber = (prop: string): number => {
  const from = GLASS.indexOf('JwiftGlass {');
  if (from < 0) throw new Error('no JwiftGlass rule in Jwift.Glass.jss');
  const m = new RegExp(`\\n\\s*${prop}:\\s*([\\d.]+)`).exec(GLASS.slice(from));
  if (!m) throw new Error(`no ${prop} in the JwiftGlass rule`);
  return parseFloat(m[1]);
};

/** The harness pins 1280 x 800 CSS px at deviceScaleFactor 2. */
const VIEW_W = 1280;
const VIEW_H = 800;
const DPR = 2;
const CANVAS_W = VIEW_W * DPR;
const CANVAS_H = VIEW_H * DPR;
const GAP_PT = 20;

/** `_glassFillBlurPlan`'s margin for a JwiftGlass card, from the sheet's own numbers:
 *  `frost*d + (Thickness*d + Fillet*minHalf*0.175)*Refraction + CA*3 + 8*d`. Fillet is 0 on this
 *  class, so the bulge term vanishes and this is 8 + 40 + 0.75 + 16 = 64.75 device px. */
const GLASS_MARGIN = 4 * DPR + (glassNumber('Thickness') * DPR) * glassNumber('Refraction')
  + glassNumber('ChromaticAberration') * 3 + 8 * DPR;

/** `_glassFillBlurPlan`'s region for a card box already in device px. */
const RegionFor = (x: number, y: number, w: number, h: number): BackdropRect => ({
  x: Math.max(0, Math.floor(x - GLASS_MARGIN)),
  y: Math.max(0, Math.floor(y - GLASS_MARGIN)),
  w: Math.min(CANVAS_W, Math.ceil(w + GLASS_MARGIN * 2)),
  h: Math.min(CANVAS_H, Math.ceil(h + GLASS_MARGIN * 2)),
});

/** The twenty card regions, from the sheet: `PerfGrid` at 60pt,70pt; 216x150pt cards, 20pt gap,
 *  wrapping 5 across (5 x 216 + 4 x 20 = 1160, exactly the grid's width). */
const cardRegions = (): BackdropRect[] => {
  const out: BackdropRect[] = [];
  for (let i = 0; i < 20; i++) {
    const col = i % 5, row = (i / 5) | 0;
    out.push(RegionFor(
      (jssNumber(GRID, 'Left') + col * (jssNumber(CARD, 'Width') + GAP_PT)) * DPR,
      (jssNumber(GRID, 'Top') + row * (jssNumber(CARD, 'Height') + GAP_PT)) * DPR,
      jssNumber(CARD, 'Width') * DPR,
      jssNumber(CARD, 'Height') * DPR,
    ));
  }
  return out;
};

// -- The recording renderer. -------------------------------------------------------------------

interface Handle { Id: number }
type Event =
  | { Kind: 'blur'; Handle: Handle }
  | { Kind: 'group'; Handle: Handle; Region: BackdropRect; K: number; Members: number }
  | { Kind: 'draw'; Handle: Handle | null; Site: 'fill' | 'rim' | 'panel' };

/** A renderer that records what the walk ASKS FOR, in the order it asks.
 *
 *  Its prototype is `WebGL2Renderer.prototype` and nothing else about it is: `?glass-group` and
 *  every other blur arm gate on `r instanceof WebGL2Renderer`, because the group build lives on
 *  that class and nowhere else, and a fake that cannot pass that test can only ever measure the
 *  refusal. Every property the walk reads as a BOOLEAN is given an explicit falsy value - the
 *  catch-all returns a function, which is truthy, and would arm the card composite.
 *
 *  The LEDGER is not faked, so the counters this lane books there are not asserted off the census
 *  here - `_glassGroupStats`, which the walk itself keeps, is. The census's wiring from the ledger
 *  is one field read per column and it is the engine that exercises it, not this file.
 */
const recorder = (log: Event[]) => {
  let seq = 0;
  const notes = { Fallbacks: 0, Members: 0 };
  const mutable: Record<string, unknown> = {
    DiagNoBlur: false, DiagBlurDummy: false, DiagBlurSrc: null,
    CardCompositeEnabled: false, DiagNoDepth: false, DiagSnapOnce: false,
    ShadowSnap: false, ShadowSnapped: 0,
  };
  const fixed: Record<string, unknown> = {
    SceneTexture: { Id: 0 },
    CardActive: false,
    GetGL: () => null,
    BeginCardComposite: () => false,
    SnapshotScreen: () => null,
    // The tick pacer holds this renderer as its fence gate whenever the default mode asks for one.
    // A catch-all stub would hand it `undefined` where the contract says `null`, which is a crash
    // inside the pacer and nothing to do with this lane.
    PaceTakeFence: () => null,
    PaceInFlight: () => 0,
    MeasureShadowBackdrop: () => -1,
    ComputeBlur: (): Handle => {
      const h: Handle = { Id: ++seq };
      log.push({ Kind: 'blur', Handle: h });
      return h;
    },
    ComputeBlurAtlas: (
      _input: unknown, _w: number, _h: number, _radius: number, members: readonly unknown[],
    ): Handle[] => members.map(() => {
      const h: Handle = { Id: ++seq };
      log.push({ Kind: 'blur', Handle: h });
      return h;
    }),
    ComputeBlurGroup: (
      _input: unknown, _w: number, _h: number, _radius: number,
      region: BackdropRect, k: number, members: number,
    ): Handle => {
      const h: Handle = { Id: ++seq };
      log.push({ Kind: 'group', Handle: h, Region: region, K: k, Members: members });
      return h;
    },
    // WHICH SITE DREW, off the call's own shape. `Core/Jaui.ts` has exactly two glass draw
    // sites and they are distinguishable without a new argument: the FILL passes ten (it carries
    // the adaptive shadow's slot) and the glass RIM overlay passes nine. A test that could not
    // tell them apart would read forty glass draws on a page with twenty cards and be unable to
    // say which twenty this lane moved.
    PanelDrawBatch: (...args: unknown[]): void => {
      const backdrop = args[2] as Handle | null;
      const site = args.length >= 10 ? 'fill' : args[6] === true ? 'rim' : 'panel';
      log.push({ Kind: 'draw', Handle: backdrop, Site: site });
    },
    NoteGroupFallback: (n: number): void => { notes.Fallbacks += n; },
    NoteGroupMember: (): void => { notes.Members++; },
    GroupBuilds: 0, GroupMembers: 0, GroupFallbacks: 0,
    SceneEndsByKey: {}, SceneSwitches: 0, SceneReads: 0, SceneRestarts: 0,
    SceneAtlasDraws: 0, BlurPoolCensus: 'none', BackdropBuildSeq: 0,
    BordersFromFill: 0, BordersRimBuilt: 0, PresampledBuilds: 0, LastPresampleK: 1,
  };
  const target = Object.create(WebGL2Renderer.prototype) as object;
  const proxy = new Proxy(target, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      const k = key as string;
      if (k in fixed) return fixed[k];
      if (k in mutable) return mutable[k];
      return () => undefined;
    },
    set: (_t, key, value) => { mutable[key as string] = value; return true; },
  });
  return { Renderer: proxy as unknown as Renderer, Notes: notes };
};

// -- The scene. `Perf.GlassGrid.ts` and `App.ts`, transcribed. ---------------------------------

const OPAQUE = { Opacity: '1' } as const;
const CLEAR = 'rgba(0, 0, 0, 0)';

const buildGlassGrid = (c: Canvas): Map<Jiv, string> => {
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
      Left: jssNumber(BED, 'Left') + 'pt',
      Top: jssNumber(BED, 'Top') + 'pt',
      Width: jssNumber(BED, 'Width') + 'pt',
      Height: jssNumber(BED, 'Height') + 'pt',
    },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { Layer: String(jssNumber(BED, 'Layer')), Background: CLEAR, ...OPAQUE },
  }), 'PerfBed');
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
    const card = name(new Jiv({
      ChildLayout: { Width: jssNumber(CARD, 'Width') + 'pt', Height: jssNumber(CARD, 'Height') + 'pt', FlexShrink: 0 },
      Layout: { Direction: 'Column', Justify: 'End', Align: 'Stretch', Gap: '4pt', Padding: jssValue(CARD, 'Padding') },
      Style: {
        Background: CLEAR,
        Thickness: String(glassNumber('Thickness')), Refraction: String(glassNumber('Refraction')),
        BezelWidth: '12', BezelScale: '0.25', Fillet: String(glassNumber('Fillet')),
        ChromaticAberration: String(glassNumber('ChromaticAberration')),
        BackdropFilter: 'Blur(4pt) Saturate(1.6) Contrast(0.6)', Tint: '0.45',
        BorderWidth: '0.45pt', BorderBlur: '0.3pt', BorderFade: '0.7pt',
        BorderColor: 'rgba(255, 255, 255, 0.35)',
        // `BorderLayer: 10` is what makes the rim a SEPARATE overlay, drawn at its own slot after
        // the card's children. It is the clause `?border-source` is about, and a transcription
        // without it has no rims at all.
        BorderLayer: String(glassNumber('BorderLayer')),
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
  c.Root.AddChild(name(new Jiv({
    ChildLayout: { Position: 'Fixed', Top: '0pt', Left: '0pt', Width: '100vw', Height: '100vh' },
    PointerEvents: 'None',
    Style: { PointScale: '1', Background: CLEAR, ...OPAQUE },
  }), 'Presentation'));
  return named;
};

interface GroupShape {
  Names: string[];
  RectW: number; RectH: number; K: number; Depth: number; Fill: number; MemberFill: number;
  Region: BackdropRect;
}

interface Stats {
  Groups: number; Builds: number; Members: number; Fallbacks: number;
  Solo: number; MaxLod: number; Unplanned: number; Rects: string; Why: string;
}

interface Walked {
  Log: Event[];
  Census: { Armed: boolean; Groups: number; Rects: string; Refused: string };
  Stats: Stats;
  Groups: GroupShape[];
  LedgerFallbacks: number;
  LedgerMembers: number;
}

const walk = (search: string): Walked => {
  const log: Event[] = [];
  const rec = recorder(log);
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => search };
  const c = new Canvas(new OffscreenCanvas(CANVAS_W, CANVAS_H) as unknown as HTMLCanvasElement, rec.Renderer, platform);
  c.SetSizePx(VIEW_W, VIEW_H);
  // `SetSizePx` pins dpr at 1 for the headless render-to-texture host. The harness runs at 2, and
  // the drawing buffer the walk is handed is `round(width * dpr)`.
  (c as unknown as { _dpr: number })._dpr = DPR;
  const named = buildGlassGrid(c);
  c.RenderHeadless(1000);

  const priv = c as unknown as {
    _glassGroups: Map<Jiv, { Members: Jiv[]; Plan: { Region: BackdropRect; K: number; Depth: number; RectW: number; RectH: number; Fill: number; MemberFill: number } }>;
    _glassGroupStats: Stats;
  };
  const seen = new Set<object>();
  const groups: GroupShape[] = [];
  for (const g of priv._glassGroups.values()) {
    if (seen.has(g)) continue;
    seen.add(g);
    groups.push({
      Names: g.Members.map((m) => named.get(m) ?? '?'),
      RectW: g.Plan.RectW, RectH: g.Plan.RectH, K: g.Plan.K, Depth: g.Plan.Depth,
      Fill: g.Plan.Fill, MemberFill: g.Plan.MemberFill, Region: g.Plan.Region,
    });
  }
  const census = (globalThis as unknown as { __jauiGlassGroup: () => Walked['Census'] }).__jauiGlassGroup();
  return {
    Log: log, Census: census, Stats: { ...priv._glassGroupStats }, Groups: groups,
    LedgerFallbacks: rec.Notes.Fallbacks, LedgerMembers: rec.Notes.Members,
  };
};

const fillDraws = (w: Walked): Event[] => w.Log.filter((e) => e.Kind === 'draw' && e.Site === 'fill');
const rimDraws = (w: Walked): Event[] => w.Log.filter((e) => e.Kind === 'draw' && e.Site === 'rim');
const builds = (w: Walked): Event[] => w.Log.filter((e) => e.Kind === 'blur' || e.Kind === 'group');

// -- 0. THE MARGIN THE WHOLE GEOMETRY RESTS ON ------------------------------------------------

describe('the sheet the numbers come from', () => {
  it('reads JwiftGlass off its own rule, chromatic aberration included', () => {
    expect(glassNumber('Thickness')).toBe(2.5);
    expect(glassNumber('Refraction')).toBe(8);
    expect(glassNumber('Fillet')).toBe(0);
    expect(glassNumber('ChromaticAberration')).toBe(0.25);
    expect(GLASS_MARGIN).toBe(64.75);
  });

  it('resolves a card to the 568x436 the blur path documents', () => {
    const r = ResolveRegionRect(cardRegions()[0], CANVAS_W, CANVAS_H, 4);
    expect([r.W, r.H]).toEqual([568, 436]);
    expect(PyramidFill(568, 436, 1, 2)).toBe(386_950);
  });
});

// -- 1. WHAT GLASS-GRID'S TREE ACTUALLY PRODUCES -----------------------------------------------

describe('?glass-group on glass-grid - the grouping the tree produces', () => {
  const on = walk('?glass-group=on');

  it('is ONE group of twenty, not four of five: the cards are children of PerfGrid', () => {
    // The brief guessed four bands of five, from `Perf/Occlusion2.Finding.md`'s four COVERING
    // bands. Those are the BED's bands (`PerfBed > PerfBand[0..5]`) and they cover the cards
    // rather than parenting them. `Perf.GlassGrid.ts`'s template is
    // `PerfPage > (PerfBed > 6 bands, PerfGrid > 20 cards)`: all twenty cards are siblings under
    // one `PerfGrid`, which wraps them 5 across and 4 down. One container, one group.
    expect(on.Groups.length).toBe(1);
    expect(on.Groups[0].Names).toEqual(Array.from({ length: 20 }, (_v, i) => `PerfCard[${i}]`));
  });

  it('arms, builds once, serves twenty, falls back on nobody', () => {
    expect(on.Census.Armed).toBe(true);
    expect(on.Census.Refused).toBe('');
    expect(on.Stats).toEqual({
      Groups: 1, Builds: 1, Members: 20, Fallbacks: 0,
      Solo: 0, MaxLod: 0, Unplanned: 0, Rects: '2456x1456@k1/d2x20', Why: 'none',
    });
    // THE VACUOUS-SUCCESS GUARD. `groups=0 members=0 fallbacks=20` is the engine this lane
    // inherited wearing the flag's name, and it would pass every timing comparison by having done
    // nothing. The ledger is told the fallbacks even when there are none, so the column exists.
    expect(on.LedgerFallbacks).toBe(0);
    // Booked once per TAKE, not in a lump off the plan: a member the walk culls after the scan saw
    // it would make these two disagree, which is the gap a lump count hides.
    expect(on.LedgerMembers).toBe(20);
  });

  it('the union rect, and the fill it trades for twenty pyramids', () => {
    const g = on.Groups[0];
    // 2456x1456 at k=1, depth=2 - the phase-4 snap of the twenty regions' bounding box. `k` is
    // PINNED to the members': the union is 87% of a 2560x1600 canvas, so `BaseDownsampleFactor`'s
    // 15% gate would hand it 2 where every 6% member resolved at 1, and a different phase is a
    // resample rather than a crop.
    expect({ W: g.RectW, H: g.RectH, K: g.K, Depth: g.Depth }).toEqual({ W: 2456, H: 1456, K: 1, Depth: 2 });
    expect(BaseDownsampleFactor(4 * DPR, CANVAS_W, CANVAS_H, g.Region)).toBe(2);
    expect(g.RectW * g.RectH / (CANVAS_W * CANVAS_H)).toBeGreaterThan(0.15);
    // The currency `PlanBackdropUnion` trades in, counted with the same `Math.floor` halvings the
    // pass's own loops use. 5,587,400 against 20 x 386,950 is 1.385x - the number
    // `Perf/PyramidUnion.Finding.md` priced glass-grid's 20pt gap at and could not then take.
    expect(g.Fill).toBe(PyramidFill(2456, 1456, 1, 2));
    expect(g.Fill).toBe(5_587_400);
    expect(g.MemberFill).toBe(20 * PyramidFill(568, 436, 1, 2));
    expect(g.MemberFill).toBe(7_739_000);
    expect(Math.round(g.MemberFill / g.Fill * 1000) / 1000).toBe(1.385);
    // The SCENE READ, which is the other thing that moves and the one the atlas could not move:
    // the union reads its own rect ONCE where twenty builds read 247,648 scene texels each.
    expect(g.RectW * g.RectH).toBe(3_575_936);
    expect(20 * 568 * 436).toBe(4_952_960);
  });

  it('every member is a texel-exact CROP of the union: same phase, exact halvings, contained', () => {
    const g = on.Groups[0];
    const phase = g.K * (1 << g.Depth);
    expect(phase).toBe(4);
    const u = ResolveRegionRect(g.Region, CANVAS_W, CANVAS_H, phase);
    expect([u.W, u.H]).toEqual([g.RectW, g.RectH]);
    // The union's own extent halves exactly at every level, or `floor(W/2)` stops being `W/2` and
    // the level-i grid drifts by a sub-texel that grows with depth.
    expect([u.W % phase, u.H % phase]).toEqual([0, 0]);
    for (const region of cardRegions()) {
      const r = ResolveRegionRect(region, CANVAS_W, CANVAS_H, phase);
      expect([r.W, r.H]).toEqual([568, 436]);
      // CONGRUENCE: the member's origin differs from the union's by a multiple of the phase, which
      // is precisely the condition under which every level of the union chain averages the same
      // source texels, in the same groups, that the member's own chain would have.
      expect(Math.abs((r.X - u.X) % phase)).toBe(0);
      expect(Math.abs((r.YBottom - u.YBottom) % phase)).toBe(0);
      // CONTAINMENT, against the union the ENGINE planned.
      expect(r.X).toBeGreaterThanOrEqual(u.X);
      expect(r.YBottom).toBeGreaterThanOrEqual(u.YBottom);
      expect(r.X + r.W).toBeLessThanOrEqual(u.X + u.W);
      expect(r.YBottom + r.H).toBeLessThanOrEqual(u.YBottom + u.H);
    }
  });
});

// -- 2. THE LAW: NO MEMBER SAMPLES ANOTHER MEMBER'S PAINT --------------------------------------

describe('?glass-group - the capture is at group entry, and it is the whole ruling', () => {
  const off = walk('?glass-group=off');
  const on = walk('?glass-group=on');

  it('OFF: twenty builds, one per card, each made after the card before it drew', () => {
    // Today's engine. `renderNode` walks once and each card's pyramid is built from the scene as
    // of its OWN draw, so card N's backdrop contains card N-1's glass, rim and shadow wherever
    // they reach into its 64.75 px sample margin - which at a 20pt (40 device px) gap they do.
    const draws = fillDraws(off);
    expect(draws.length).toBe(20);
    // Twenty rims beside them, each reading its own fill's pyramid rather than building a second
    // one: `?border-source=fill` is the default since Jaui `f1834cf`, so the frame's builds are
    // the twenty fills and nothing else.
    expect(rimDraws(off).length).toBe(20);
    expect(builds(off).every((e) => e.Kind === 'blur')).toBe(true);
    const handles = draws.map((d) => (d as { Handle: Handle }).Handle);
    expect(new Set(handles).size).toBe(20);
    for (let i = 1; i < 20; i++) {
      const prevDraw = off.Log.indexOf(draws[i - 1]);
      const build = off.Log.findIndex((e) => e.Kind === 'blur' && e.Handle === handles[i]);
      expect(build).toBeGreaterThan(prevDraw);
    }
    expect(off.Census.Armed).toBe(false);
    expect(off.Groups.length).toBe(0);
  });

  it('ON: ONE build, before any member paints, and all twenty draws carry it', () => {
    const draws = fillDraws(on);
    expect(draws.length).toBe(20);
    const b = builds(on);
    expect(b.length).toBe(1);
    expect(b[0].Kind).toBe('group');
    expect((b[0] as { Members: number }).Members).toBe(20);
    // THE LAW, read off the engine's own call order: the single build precedes EVERY glass draw,
    // so nothing any member paints can be in what any member samples.
    expect(on.Log.indexOf(b[0])).toBeLessThan(on.Log.indexOf(draws[0]));
    const handles = draws.map((d) => (d as { Handle: Handle }).Handle);
    expect(new Set(handles).size).toBe(1);
    expect(handles[0]).toBe((b[0] as { Handle: Handle }).Handle);
  });

  it('the two arms differ in the backdrop and in NOTHING else: same draws, same order', () => {
    // The control invariant. A composition change that also moved a draw would not be a test of
    // the composition. Both arms push the same panel instances in the same walk order, and the
    // only column that moves is which pyramid each glass draw binds.
    expect(on.Log.filter((e) => e.Kind === 'draw').map((e) => (e as { Site: string }).Site))
      .toEqual(off.Log.filter((e) => e.Kind === 'draw').map((e) => (e as { Site: string }).Site));
    // And the arithmetic of what was removed: 20 builds -> 1, and 80 render passes -> 4, since a
    // build is `2 x depth` passes at this sigma and the depth did not move.
    expect(builds(off).length).toBe(20);
    expect(builds(on).length).toBe(1);
    expect(builds(off).length * 2 * 2).toBe(80);
    expect(builds(on).length * 2 * on.Groups[0].Depth).toBe(4);
  });

  it('`?border-source=fill` composes: the rim binds the group handle, not a second pyramid', () => {
    // The default since Jaui `f1834cf`. A rim admitted onto its own fill takes the handle the fill
    // recorded, which under this arm is the GROUP's - one texture, one `BackdropRegion`, the same
    // two mads in `Jiv.Panel.frag`. So the twenty rims add no build here either, and the whole
    // page's `EndsByKey.blur` is the single group build.
    const withFill = walk('?glass-group=on&border-source=fill');
    expect(withFill.Census.Refused).toBe('');
    expect(withFill.Stats.Members).toBe(20);
    expect(builds(withFill).length).toBe(1);
    expect(builds(withFill)[0].Kind).toBe('group');
    // Every one of the twenty rims bound the GROUP's handle - the same texture and the same
    // `BackdropRegion` its fill bound, which is what "the rim reads the fill's pyramid" now means.
    const groupHandle = (builds(withFill)[0] as { Handle: Handle }).Handle;
    expect(rimDraws(withFill).length).toBe(20);
    for (const d of rimDraws(withFill)) expect((d as { Handle: Handle }).Handle).toBe(groupHandle);
    // `=scene` puts every rim back on its own pyramid IN THE SAME BINARY, and the group's fill
    // build is still exactly one: a rim is not a member. It paints at its own BorderLayer slot,
    // after its siblings, so it was never in the run - `_glassGroupPrepass` pins the scan to the
    // FILL site for exactly that reason.
    const withScene = walk('?glass-group=on&border-source=scene');
    expect(withScene.Stats.Members).toBe(20);
    expect(withScene.Log.filter((e) => e.Kind === 'group').length).toBe(1);
    expect(withScene.Log.filter((e) => e.Kind === 'blur').length).toBe(20);
    // And every fill still bound the group's, so the two levers are orthogonal in the same binary.
    const gh = (withScene.Log.filter((e) => e.Kind === 'group')[0] as { Handle: Handle }).Handle;
    for (const d of fillDraws(withScene)) expect((d as { Handle: Handle }).Handle).toBe(gh);
  });
});

// -- 3. THE REFUSALS, BY NAME ------------------------------------------------------------------

describe('?glass-group - the arms it refuses to stand beside, each by name', () => {
  const refusalFor = (search: string): string => walk(search).Census.Refused;

  it('refuses `?pyramid-atlas`: the atlas packs a chain per member into slots of one texture', () => {
    expect(refusalFor('?glass-group=on&pyramid-atlas=fills'))
      .toBe('pyramid-atlas-packs-a-chain-per-member-into-slots-of-one-texture');
  });

  it('refuses `?border-direct`: it reproduces a per-rim kernel from its own copy', () => {
    expect(refusalFor('?glass-group=on&border-direct=on'))
      .toBe('border-direct-reproduces-a-per-rim-kernel-from-its-own-copy');
  });

  it('refuses `?glass-presample`: a lifted gate and a pinned k are two answers to one number', () => {
    // `border-source=scene` because `?glass-presample` self-refuses beside the default `fill`, and
    // a refusal this lane cannot reach is a clause this lane cannot claim to have tested.
    expect(refusalFor('?glass-group=on&glass-presample=on&border-source=scene'))
      .toBe('glass-presample-re-bases-a-build-onto-a-k-the-union-pin-contradicts');
  });

  it('refuses `?wkr-shared-backdrop`, and this lane is NOT that lever', () => {
    // The one worth saying out loud. That arm builds ONE canvas-wide QUARTER-RESOLUTION sharp-root
    // pyramid per frame, hands it to every surface in the tree whatever its container, and makes
    // each climb a mip chain from a base LOD of 2 to find its own sigma. This builds a
    // FULL-RESOLUTION level 0 at the MEMBERS' OWN sigma over the union of ONE container, with no
    // LOD constant anywhere: every member still samples level 0 at lod 0.
    expect(refusalFor('?glass-group=on&wkr-shared-backdrop'))
      .toBe('wkr-shared-backdrop-is-one-global-quarter-res-pyramid-at-a-lod-constant');
  });

  it('refuses the two arms that move the capture point this law is about', () => {
    expect(refusalFor('?glass-group=on&blur-first'))
      .toBe('blur-first-already-built-every-pyramid-ahead-of-the-walk');
    expect(refusalFor('?glass-group=on&blur-phased'))
      .toBe('blur-phased-captures-every-build-at-one-instant-not-at-group-entry');
  });

  it("every refusal falls back to TODAY'S engine: no group, no member, nothing withheld", () => {
    // A refusal is not a degradation. It is the path the page takes with the flag absent, which is
    // the only fallback this lane is willing to have.
    const w = walk('?glass-group=on&border-direct=on');
    expect(w.Groups.length).toBe(0);
    expect(w.Stats.Members).toBe(0);
    expect(fillDraws(w).length).toBe(20);
  });

  it("takes only 'on' and 'off', by name", () => {
    expect(() => walk('?glass-group=yes')).toThrow(/takes 'on' or 'off'/);
  });
});

// -- 4. WHAT A GROUP IS, AND WHAT ENDS ONE -----------------------------------------------------

describe('PlanBackdropUnion under the repealed separation law', () => {
  it('plans the twenty at a 20pt gap - the pitch the old law forbade and the ruling allows', () => {
    // `Perf/PyramidUnion.Finding.md` measured this exact arrangement at 1.385x and refused it: the
    // gap had to clear ~97 device px (the later card's 64.75 sample margin plus the earlier one's
    // 32 px shadow outset) and 20pt is 40. Under Apple's rule the gap is irrelevant, because the
    // earlier card's paint is not in the backdrop at all.
    const plan = PlanBackdropUnion(cardRegions(), CANVAS_W, CANVAS_H, 4 * DPR);
    expect(plan).not.toBeNull();
    expect([plan!.RectW, plan!.RectH]).toEqual([2456, 1456]);
    expect(plan!.K).toBe(1);
    expect(plan!.Depth).toBe(PyramidDepth(4 * DPR, 0));
  });

  it('still refuses a class of one: a surface with no sibling costs exactly what it costs today', () => {
    expect(PlanBackdropUnion(cardRegions().slice(0, 1), CANVAS_W, CANVAS_H, 4 * DPR)).toBeNull();
  });

  it('still refuses two cards at opposite corners: the union is bigger than both together', () => {
    const r = cardRegions();
    expect(PlanBackdropUnion([r[0], r[19]], CANVAS_W, CANVAS_H, 4 * DPR)).toBeNull();
  });
});
