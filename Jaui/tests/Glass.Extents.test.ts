/**
 * BLUR EXTENTS - how many distinct level-0 sizes a page's glass resolves to, what the pools do with
 * them, and the phone's shape.
 *
 * The lane this file belongs to was launched on "each distinct target size costs ~1.5-2.2 ms of
 * re-allocation". Two facts in the engine's own arithmetic decide how far that can be true, and both
 * are pinned here rather than argued:
 *
 *   1. `targets=` on the plan's gate line is the SEPARABLE TARGET POOL, and a k = 2 build puts two
 *      sizes in it (its hop and its temp). The dpr-3 union's `2:1840x1106+1858x1106` is ONE extent,
 *      and glass-grid's dpr-3 `8:` is FOUR. So the four measured arms are 1 / 1 / 1 / 4 extents, not
 *      1 / 1 / 2 / 8 -- and the dpr-3 union paid +1.5 ms over the pixel model with ONE.
 *   2. Both pools are keyed on size and hold every one of those sizes (4 chains <= 6, 8 targets <= 16),
 *      so a steady frame re-allocates nothing whatever its extent count. `resizes=` is the reading
 *      that can refute this; the prediction it is held to is 0.
 *
 * NO GL. The extents are the engine's own functions over the scene's own geometry; the phone scene's
 * grouping is the real walk against a recording renderer, as `Glass.Group.test.ts` does it.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  BaseDownsampleFactor, PyramidDepth, ResolveRegionRect, PlanBackdropUnion, RegionExtentSnap,
  MAX_CHAINS, SEPARABLE_TARGETS_MAX, SEPARABLE_TARGET_BUDGET_BYTES, type BackdropRect,
} from '@jaui/Core/BlurPass';
import { PlanSeparable, PlanSeparableTargets } from '@jaui/Core/Blur.Separable';
import { SceneReadLedger } from '@jaui/Core/Scene.Ledger';
import { GlassSoloReasonAt, GlassSoloTally, type GlassScanEntry } from '@jaui/Core/Glass.Group.Why';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { WebGL2Renderer } from '@jaui/Core/WebGL2.Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';
import { readPerfJss, readJwiftGlass, jssClass, jssNumber } from './Scene.ReadAfterWrite.Source';

// -- The sheets. -------------------------------------------------------------------------------

const PERF = readPerfJss();
const GLASS = readJwiftGlass();
const glassNumber = (prop: string): number => {
  const from = GLASS.indexOf('JwiftGlass {');
  const m = new RegExp(`\\n\\s*${prop}:\\s*([\\d.]+)`).exec(GLASS.slice(from));
  if (!m) throw new Error(`no ${prop} in the JwiftGlass rule`);
  return parseFloat(m[1]);
};
const FROST_PT = 4;
const VIEW_W = 1280, VIEW_H = 800;

/** `_glassFillBlurPlan`'s margin for a JwiftGlass surface at `dpr` (Fillet is 0 on the class). */
const marginAt = (dpr: number): number =>
  FROST_PT * dpr + glassNumber('Thickness') * dpr * glassNumber('Refraction')
  + glassNumber('ChromaticAberration') * 3 + 8 * dpr;

/** A box in CSS px -> `_glassFillBlurPlan`'s region in device px. */
const regionAt = (dpr: number, [x, y, w, h]: readonly number[]): BackdropRect => {
  const m = marginAt(dpr);
  return {
    x: Math.max(0, Math.floor(x * dpr - m)), y: Math.max(0, Math.floor(y * dpr - m)),
    w: Math.min(VIEW_W * dpr, Math.ceil(w * dpr + m * 2)), h: Math.min(VIEW_H * dpr, Math.ceil(h * dpr + m * 2)),
  };
};

interface Extent { L0: string; Hops: string[]; Temp: string; K: number }

/** What one solo build resolves to, through `Blur`'s own sequence: the chain's k and depth, the
 *  region snapped on its phase, the separable plan at the chain's delivered sigma, its targets. */
const extentOf = (dpr: number, region: BackdropRect): Extent => {
  const W = VIEW_W * dpr, H = VIEW_H * dpr, radius = FROST_PT * dpr;
  const k = BaseDownsampleFactor(radius, W, H, region);
  const depth = PyramidDepth(radius / k, 0);
  const rect = ResolveRegionRect(region, W, H, k * (1 << depth));
  const tap = Math.max(0.7, Math.min(1.3, Math.max(1, radius / k) / (3 * Math.pow(2, depth))));
  const plan = PlanSeparable(radius, k, depth, tap, { Sigma: 'delivered', Fetches: null });
  if (!plan.Ok) throw new Error(`separable refused: ${plan.Why}`);
  const t = PlanSeparableTargets(rect, plan.K, plan.Kernel);
  return {
    L0: `${t.Bw}x${t.Bh}`, Hops: t.Hops.map((hp) => `${hp.W}x${hp.H}`), Temp: `${t.TempW}x${t.TempH}`, K: plan.K,
  };
};

/** A page's extents: distinct level-0 sizes (chains) and distinct target sizes (the `targets=` pool). */
const census = (extents: Extent[]): { Chains: string[]; Targets: string[]; TargetBytes: number } => {
  const chains = [...new Set(extents.map((e) => e.L0))].sort();
  const targets = [...new Set(extents.flatMap((e) => [...e.Hops, e.Temp]))].sort();
  const bytes = targets.reduce((n, s) => { const [w, h] = s.split('x').map(Number); return n + w * h * 4; }, 0);
  return { Chains: chains, Targets: targets, TargetBytes: bytes };
};

/** glass-grid's twenty cards, CSS px: `PerfGrid` at 60,70; 216x150 on a 236 x 170 pitch. */
const GRID_BOXES = Array.from({ length: 20 }, (_v, i) => [60 + (i % 5) * 236, 70 + ((i / 5) | 0) * 170, 216, 150]);

/** phone-home's six glass boxes, CSS px, read off Perf.jss: `PerfPhone`'s origin plus each slot. */
const PHONE = jssClass(PERF, 'PerfPhone');
const PHONE_SLOTS = ['PerfPhoneBar', 'PerfPhoneHero', 'PerfPhoneTileA', 'PerfPhoneTileB', 'PerfPhoneChip', 'PerfPhoneTabs'];
const PHONE_BOXES = PHONE_SLOTS.map((n) => {
  const c = jssClass(PERF, n);
  return [
    jssNumber(PHONE, 'Left') + jssNumber(c, 'Left'), jssNumber(PHONE, 'Top') + jssNumber(c, 'Top'),
    jssNumber(c, 'Width'), jssNumber(c, 'Height'),
  ];
});

afterEach(() => { RegionExtentSnap.Unit = 1; });

// -- 1. The four measured arms, in extents. ----------------------------------------------------

describe('the four measured arms, recounted in EXTENTS rather than target sizes', () => {
  it('dpr 2, twenty builds: ONE extent, the gate line\'s 1:568x454', () => {
    const c = census(GRID_BOXES.map((b) => extentOf(2, regionAt(2, b))));
    expect(c.Chains).toEqual(['568x436']);
    expect(c.Targets).toEqual(['568x454']);
  });

  it('dpr 3, twenty builds: FOUR extents holding the eight 424-446 x 342-346 target sizes', () => {
    const ex = GRID_BOXES.map((b) => extentOf(3, regionAt(3, b)));
    expect(new Set(ex.map((e) => e.K))).toEqual(new Set([2]));
    const c = census(ex);
    expect(c.Chains).toEqual(['424x324', '424x328', '428x324', '428x328']);
    expect(c.Targets).toEqual([
      '424x342', '424x346', '428x342', '428x346', '442x342', '442x346', '446x342', '446x346',
    ]);
    // Both pools hold all of it, so no steady frame allocates: the prediction `resizes=0` is held to.
    expect(c.Chains.length).toBeLessThanOrEqual(MAX_CHAINS);
    expect(c.Targets.length).toBeLessThanOrEqual(SEPARABLE_TARGETS_MAX);
    expect(c.TargetBytes).toBeLessThanOrEqual(SEPARABLE_TARGET_BUDGET_BYTES);
  });

  it('dpr 3 under ?blur-k=floor: k drops to 1 and the extents stay four -- the cell that splits k from extents', () => {
    const W = 3840, H = 2400, radius = 12;
    const ex = GRID_BOXES.map((b) => {
      const region = regionAt(3, b);
      const depth = PyramidDepth(radius, 0);
      const rect = ResolveRegionRect(region, W, H, 1 << depth);
      const tap = Math.max(0.7, Math.min(1.3, radius / (3 * Math.pow(2, depth))));
      const plan = PlanSeparable(radius, 1, depth, tap, { Sigma: 'delivered', Fetches: null, KRule: 'floor' });
      if (!plan.Ok) throw new Error(plan.Why);
      const t = PlanSeparableTargets(rect, plan.K, plan.Kernel);
      return { L0: `${t.Bw}x${t.Bh}`, Hops: t.Hops.map((hp) => `${hp.W}x${hp.H}`), Temp: `${t.TempW}x${t.TempH}`, K: plan.K };
    });
    expect(new Set(ex.map((e) => e.K))).toEqual(new Set([1]));
    const c = census(ex);
    expect(c.Chains).toEqual(['848x648', '848x656', '856x648', '856x656']);
    expect(c.Targets.length).toBe(4);
  });

  it('dpr 3, the union: ONE extent, whose hop and temp are the gate line\'s two sizes', () => {
    const regions = GRID_BOXES.map((b) => regionAt(3, b));
    const u = PlanBackdropUnion(regions, VIEW_W * 3, VIEW_H * 3, FROST_PT * 3)!;
    expect([u.RectW, u.RectH, u.K, u.Depth]).toEqual([3680, 2176, 1, 3]);
    const tap = Math.max(0.7, Math.min(1.3, 12 / (3 * Math.pow(2, u.Depth))));
    const plan = PlanSeparable(12, u.K, u.Depth, tap, { Sigma: 'delivered', Fetches: null });
    if (!plan.Ok) throw new Error(plan.Why);
    const t = PlanSeparableTargets({ X: 0, YBottom: 0, W: u.RectW, H: u.RectH }, plan.K, plan.Kernel);
    expect(`${t.Bw}x${t.Bh}`).toBe('1840x1088');
    expect([...t.Hops.map((h) => `${h.W}x${h.H}`), `${t.TempW}x${t.TempH}`].sort()).toEqual(['1840x1106', '1858x1106']);
  });
});

// -- 2. The phone's shape. ---------------------------------------------------------------------

describe('phone-home: six solo surfaces, six extents', () => {
  it('six distinct extents at dpr 2 and at dpr 3, and the six-chain pool exactly full', () => {
    for (const dpr of [2, 3]) {
      const c = census(PHONE_BOXES.map((b) => extentOf(dpr, regionAt(dpr, b))));
      expect(c.Chains.length).toBe(6);
      expect(c.Chains.length).toBe(MAX_CHAINS);
      expect(c.Targets.length).toBeLessThanOrEqual(SEPARABLE_TARGETS_MAX);
    }
    expect(census(PHONE_BOXES.map((b) => extentOf(2, regionAt(2, b)))).Chains)
      .toEqual(['264x264', '516x436', '516x516', '736x264', '928x240', '928x576']);
  });

  it('through the real walk: groups=0, solo=6, every one alone in its container', () => {
    const w = walkPhone();
    expect(w.Stats).toMatchObject({
      Groups: 0, Builds: 0, Solo: 6, Fallbacks: 6, MaxLod: 0, Unplanned: 0, Why: 'only-glass-in-parent:6',
    });
    expect(w.Builds).toBe(6);
  });
});

// -- 3. `?extent-snap`: moves the extent count and nothing else. -------------------------------

describe('RegionExtentSnap', () => {
  it('unit 1 is the phase snap exactly', () => {
    for (const b of GRID_BOXES) {
      const r = regionAt(3, b);
      const a = ResolveRegionRect(r, 3840, 2400, 8);
      RegionExtentSnap.Unit = 1;
      expect(ResolveRegionRect(r, 3840, 2400, 8)).toEqual(a);
    }
  });

  it('unit 32 puts glass-grid\'s four dpr-3 extents on one, origin and grid untouched', () => {
    const before = GRID_BOXES.map((b) => ResolveRegionRect(regionAt(3, b), 3840, 2400, 8));
    RegionExtentSnap.Unit = 32;
    const ex = GRID_BOXES.map((b) => extentOf(3, regionAt(3, b)));
    expect(census(ex).Chains).toEqual(['432x336']);
    GRID_BOXES.forEach((b, i) => {
      const r = ResolveRegionRect(regionAt(3, b), 3840, 2400, 8);
      expect([r.X, r.YBottom]).toEqual([before[i].X, before[i].YBottom]);
      expect([r.W % 32, r.H % 32]).toEqual([0, 0]);
      expect(r.W).toBeGreaterThanOrEqual(before[i].W);
      expect(r.H).toBeGreaterThanOrEqual(before[i].H);
    });
  });

  it('a unit below the phase is the phase', () => {
    const r = regionAt(3, GRID_BOXES[1]);
    const a = ResolveRegionRect(r, 3840, 2400, 8);
    RegionExtentSnap.Unit = 4;
    expect(ResolveRegionRect(r, 3840, 2400, 8)).toEqual(a);
  });
});

// -- 4. The census's own arithmetic. -----------------------------------------------------------

describe('SceneReadLedger extent census', () => {
  it('counts distinct level-0 sizes, their builds and their allocations, and resets per frame', () => {
    const l = new SceneReadLedger();
    expect([l.DistinctExtents, l.ExtentCensus, l.SurfaceExtentList, l.ExtentAllocations]).toEqual([0, 'none', 'none', 0]);
    l.NoteSurfaceExtent(424, 324, 2, 1);
    l.NoteSurfaceExtent(428, 324, 2, 1);
    l.NoteSurfaceExtent(424, 324, 2, 0);
    expect(l.DistinctExtents).toBe(2);
    expect(l.ExtentCensus).toBe('424x324#2+428x324#1');
    expect(l.SurfaceExtentList).toBe('424x324@k2:1,428x324@k2:1,424x324@k2:0');
    expect(l.ExtentAllocations).toBe(2);
    l.BeginFrame();
    expect([l.DistinctExtents, l.ExtentCensus, l.ExtentAllocations]).toEqual([0, 'none', 0]);
  });
});

describe('GlassSoloReasonAt', () => {
  const A = { id: 'A' }, B = { id: 'B' };
  const e = (Parent: unknown, Radius = 8, MaxLod = 0): GlassScanEntry => ({ Parent, Radius, MaxLod });

  it('names each way a fill ends up alone', () => {
    const scan = [e(A), e(B), e(A), e(B, 16), e(null), e(A, 8, 2), e({ id: 'C' })];
    expect(scan.map((_s, i) => GlassSoloReasonAt(scan, i))).toEqual([
      'run-broken', 'radius-differs', 'run-broken', 'radius-differs', 'no-parent', 'mip-consumer',
      'only-glass-in-parent',
    ]);
  });

  it('a mip consumer beside it does not count as a sibling it could have grouped with', () => {
    const scan = [e(A), e(A, 8, 3)];
    expect(GlassSoloReasonAt(scan, 0)).toBe('only-glass-in-parent');
  });

  it('tallies sorted, and none for none', () => {
    expect(GlassSoloTally([])).toBe('none');
    expect(GlassSoloTally(['run-broken', 'no-parent', 'run-broken'])).toBe('no-parent:1,run-broken:2');
  });
});

// -- The walk: `Perf.PhoneHome.ts` transcribed, against a recording renderer. -------------------

interface Stats {
  Groups: number; Builds: number; Members: number; Fallbacks: number;
  Solo: number; MaxLod: number; Unplanned: number; Rects: string; Why: string;
}

/** `Glass.Group.test.ts`'s recorder, reduced to what this walk reads: its prototype is
 *  `WebGL2Renderer.prototype` so `?glass-group` arms, and every boolean the walk reads is falsy. */
const recorder = (): { Renderer: Renderer; Builds: () => number } => {
  let builds = 0;
  const mutable: Record<string, unknown> = {
    DiagNoBlur: false, DiagBlurDummy: false, DiagBlurSrc: null,
    CardCompositeEnabled: false, DiagNoDepth: false, DiagSnapOnce: false,
    ShadowSnap: false, ShadowSnapped: 0,
  };
  const fixed: Record<string, unknown> = {
    SceneTexture: { Id: 0 }, CardActive: false, GetGL: () => null,
    BeginCardComposite: () => false, SnapshotScreen: () => null,
    PaceTakeFence: () => null, PaceInFlight: () => 0, MeasureShadowBackdrop: () => -1,
    ComputeBlur: () => { builds++; return { Id: builds }; },
    ComputeBlurGroup: () => { throw new Error('phone-home must not group'); },
    GroupBuilds: 0, GroupMembers: 0, GroupFallbacks: 0,
    SceneEndsByKey: {}, SceneSwitches: 0, SceneReads: 0, SceneRestarts: 0,
    SceneAtlasDraws: 0, BlurPoolCensus: 'none', BackdropBuildSeq: 0,
    BordersFromFill: 0, BordersRimBuilt: 0, PresampledBuilds: 0, LastPresampleK: 1,
  };
  const proxy = new Proxy(Object.create(WebGL2Renderer.prototype) as object, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      const k = key as string;
      if (k in fixed) return fixed[k];
      if (k in mutable) return mutable[k];
      return () => undefined;
    },
    set: (_t, key, value) => { mutable[key as string] = value; return true; },
  });
  return { Renderer: proxy as unknown as Renderer, Builds: () => builds };
};

const CLEAR = 'rgba(0, 0, 0, 0)';
const OPAQUE = { Opacity: '1' } as const;

const walkPhone = (): { Stats: Stats; Builds: number } => {
  const rec = recorder();
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => '' };
  const c = new Canvas(new OffscreenCanvas(VIEW_W * 2, VIEW_H * 2) as unknown as HTMLCanvasElement, rec.Renderer, platform);
  c.SetSizePx(VIEW_W, VIEW_H);
  (c as unknown as { _dpr: number })._dpr = 2;

  const page = new Jiv({
    Overflow: 'Hidden', ChildLayout: { FlexGrow: 1 }, Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { PointScale: '1', Background: 'rgb(0, 0, 0)', ...OPAQUE },
  });
  const bed = new Jiv({
    ChildLayout: { Position: 'Placed', Left: '-240pt', Top: '-200pt', Width: '1800pt', Height: '1300pt' },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { Layer: '0', Background: CLEAR, ...OPAQUE },
  });
  for (let i = 0; i < 6; i++) {
    bed.AddChild(new Jiv({
      ChildLayout: { FlexGrow: 1 },
      Style: { Background: `LinearGradient(${i * 30}deg, rgb(${40 + i * 20}, 90, 120), rgb(20, 20, 20))`, ...OPAQUE },
    }));
  }
  page.AddChild(bed);
  const phone = new Jiv({
    ChildLayout: {
      Position: 'Placed', Left: jssNumber(PHONE, 'Left') + 'pt', Top: jssNumber(PHONE, 'Top') + 'pt',
      Width: jssNumber(PHONE, 'Width') + 'pt', Height: jssNumber(PHONE, 'Height') + 'pt',
    },
    Style: { Layer: String(jssNumber(PHONE, 'Layer')), Background: CLEAR, ...OPAQUE },
  });
  for (const name of PHONE_SLOTS) {
    const s = jssClass(PERF, name);
    const slot = new Jiv({
      ChildLayout: {
        Position: 'Placed', Left: jssNumber(s, 'Left') + 'pt', Top: jssNumber(s, 'Top') + 'pt',
        Width: jssNumber(s, 'Width') + 'pt', Height: jssNumber(s, 'Height') + 'pt',
      },
      Layout: { Direction: 'Column', Align: 'Stretch' },
      Style: { Background: CLEAR, ...OPAQUE },
    });
    slot.AddChild(new Jiv({
      ChildLayout: { FlexGrow: 1 },
      Style: {
        Background: CLEAR,
        Thickness: String(glassNumber('Thickness')), Refraction: String(glassNumber('Refraction')),
        BezelWidth: '12', BezelScale: '0.25', Fillet: String(glassNumber('Fillet')),
        ChromaticAberration: String(glassNumber('ChromaticAberration')),
        BackdropFilter: 'Blur(4pt) Saturate(1.6) Contrast(0.6)', Tint: '0.45',
        BorderWidth: '0.45pt', BorderBlur: '0.3pt', BorderFade: '0.7pt',
        BorderColor: 'rgba(255, 255, 255, 0.35)', BorderLayer: String(glassNumber('BorderLayer')),
        BorderRadius: '22pt', ...OPAQUE,
      },
    }));
    phone.AddChild(slot);
  }
  page.AddChild(phone);
  const screen = new Jiv({
    Overflow: 'Hidden', ChildLayout: { FlexGrow: 1 }, Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { PointScale: '1', Background: CLEAR, ...OPAQUE },
  });
  screen.AddChild(page);
  c.Root.AddChild(screen);
  c.RenderHeadless(1000);

  const stats = (c as unknown as { _glassGroupStats: Stats })._glassGroupStats;
  return { Stats: { ...stats }, Builds: rec.Builds() };
};
