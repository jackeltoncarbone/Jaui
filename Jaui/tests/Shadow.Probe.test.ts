/**
 * `?shadow-probe=walk|group` - WHERE A GLASS GROUP MEMBER'S ADAPTIVE-SHADOW PROBE RUNS.
 *
 * Under `?glass-group` (the default) the builds no longer end the scene's encoder per card, so the
 * probe's 1x1 `shadow-state` bind does: the M4 read `EndsByKey {blur:1, shadow-state:19}`, twenty
 * scene segments either way. `group` probes every member at the group's capture, in one bind, and
 * the group's cards then draw in one segment.
 *
 * WHAT IS PROVED HERE, and on what:
 *
 *   1. The walk (the real `Canvas` over glass-grid's transcribed tree, against a recording
 *      renderer) hands the batch EXACTLY the arguments it hands each walk probe - key, rect, detail
 *      LOD, pyramid, sharp tap - and the draws that follow are identical, slot included.
 *   2. PIXEL-NEUTRALITY, from the walk's own draws: for every member N, nothing the walk draws
 *      between the group's capture and member N's walk-position probe covers a single texel any of
 *      the probe's 96 bilinear taps reads. The capture-time scene and the walk-time scene therefore
 *      agree on every texel the probe reads, so the reading - and every shadow pixel - is the same.
 *   3. The real `WebGL2Renderer`: the batch issues each probe's GL calls exactly as a lone probe
 *      does, minus its bind and its rebind, and the real ledger reads the counts the gate prints:
 *      20 probes / 20 binds / 19 `shadow-state` ends walked, 20 / 1 / 0 grouped.
 *   4. The flag: default `walk`, the mark, and every refusal by name.
 *
 * NOT HERE: a rasteriser. Point 2 bounds paint by the instance QUAD, which is a superset of what a
 * draw can touch, so it is conservative; the orchestrator's pixel gate is the proof on the GPU.
 */
import { describe, it, expect } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { WebGL2Renderer, type ShadowProbe } from '@jaui/Core/WebGL2.Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';
import { OnJauiTrace } from '@jaui/Diagnostics/Jaui.Trace';
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
const glassRaw = (prop: string): string => {
  const from = GLASS.indexOf('JwiftGlass {');
  if (from < 0) throw new Error('no JwiftGlass rule in Jwift.Glass.jss');
  const m = new RegExp(`\\n\\s*${prop}:\\s*([^\\n]+)`).exec(GLASS.slice(from));
  if (!m) throw new Error(`no ${prop} in the JwiftGlass rule`);
  return m[1].trim();
};
const glassNumber = (prop: string): number => parseFloat(glassRaw(prop));

const VIEW_W = 1280;
const VIEW_H = 800;
const DPR = 2;
const CANVAS_W = VIEW_W * DPR;
const CANVAS_H = VIEW_H * DPR;

// -- The recording renderer. -------------------------------------------------------------------

interface Rect { x: number; y: number; w: number; h: number }
type Event =
  | { Kind: 'group'; Handle: object }
  | { Kind: 'probe'; Key: object; Rect: Rect; DetailLod: number; Backdrop: unknown; Scene: unknown; Batched: boolean }
  | { Kind: 'batch'; Count: number }
  | { Kind: 'draw'; Site: 'fill' | 'rim' | 'panel'; Quads: number[][]; Instances: number[]; Shadow: unknown }
  | { Kind: 'text'; Quads: number[][] }
  | { Kind: 'other-draw'; Name: string };

const SCENE = { Id: 0 };

const recorder = (log: Event[]) => {
  let seq = 0;
  let panel: number[] = [];
  let text: number[] = [];
  const slots = new Map<object, number>();
  const slotOf = (key: object): number => {
    let s = slots.get(key);
    if (s === undefined) { s = slots.size; slots.set(key, s); }
    return s;
  };
  let batched = false;
  const probe = (key: object, rect: Rect, detailLod: number, backdrop: unknown, scene: unknown): number => {
    log.push({ Kind: 'probe', Key: key, Rect: { ...rect }, DetailLod: detailLod, Backdrop: backdrop, Scene: scene, Batched: batched });
    return slotOf(key);
  };
  const mutable: Record<string, unknown> = {
    DiagNoBlur: false, DiagBlurDummy: false, DiagBlurSrc: null,
    CardCompositeEnabled: false, DiagNoDepth: false, DiagSnapOnce: false,
    ShadowSnap: false, ShadowSnapped: 0,
  };
  const fixed: Record<string, unknown> = {
    SceneTexture: SCENE,
    CardActive: false,
    GetGL: () => null,
    BeginCardComposite: () => false,
    SnapshotScreen: () => null,
    PaceTakeFence: () => null,
    PaceInFlight: () => 0,
    MeasureShadowBackdrop: probe,
    MeasureShadowBackdrops: (probes: readonly ShadowProbe[], backdrop: unknown, scene: unknown): number[] => {
      log.push({ Kind: 'batch', Count: probes.length });
      batched = true;
      const out = probes.map((p) => probe(p.Key, p.Rect, p.DetailLod, backdrop, scene));
      batched = false;
      return out;
    },
    ComputeBlur: () => ({ Id: ++seq }),
    ComputeBlurAtlas: (_i: unknown, _w: number, _h: number, _r: number, members: readonly unknown[]) =>
      members.map(() => ({ Id: ++seq })),
    ComputeBlurGroup: (): object => {
      const h = { Id: ++seq };
      log.push({ Kind: 'group', Handle: h });
      return h;
    },
    PanelBeginBatch: (): void => { panel = []; },
    PanelAddInstance: (data: Float32Array, offset: number, count: number): void => {
      for (let i = 0; i < count; i++) panel.push(data[offset + i]);
    },
    PanelDrawBatch: (...args: unknown[]): void => {
      const site = args.length >= 10 ? 'fill' : args[6] === true ? 'rim' : 'panel';
      const quads: number[][] = [];
      for (let o = 0; o + 60 <= panel.length; o += 60) quads.push(panel.slice(o, o + 4));
      log.push({ Kind: 'draw', Site: site, Quads: quads, Instances: [...panel], Shadow: args[9] });
    },
    TextBeginBatch: (): void => { text = []; },
    TextAddInstance: (data: Float32Array, offset: number, count: number): void => {
      for (let i = 0; i < count; i++) text.push(data[offset + i]);
    },
    TextDrawBatch: (): void => {
      const quads: number[][] = [];
      for (let o = 0; o + 20 <= text.length; o += 20) quads.push(text.slice(o, o + 4));
      log.push({ Kind: 'text', Quads: quads });
    },
    NoteGroupFallback: (): void => {},
    NoteGroupMember: (): void => {},
    GroupBuilds: 0, GroupMembers: 0, GroupFallbacks: 0, ShadowProbes: 0, ShadowProbeBinds: 0,
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
      // Any OTHER entry point that paints is logged by name, so the neutrality proof below cannot
      // be vacuous about a draw it never saw.
      if (/Draw/.test(k)) return () => { log.push({ Kind: 'other-draw', Name: k }); };
      return () => undefined;
    },
    set: (_t, key, value) => { mutable[key as string] = value; return true; },
  });
  return proxy as unknown as Renderer;
};

// -- The scene: glass-grid, transcribed as `Glass.Skip.test.ts` does, with the adaptive shadow. --

const OPAQUE = { Opacity: '1' } as const;
const CLEAR = 'rgba(0, 0, 0, 0)';

const buildGlassGrid = (c: Canvas): Jiv[] => {
  const page = new Jiv({
    Overflow: 'Hidden',
    ChildLayout: { FlexGrow: jssNumber(PAGE, 'FlexGrow') },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { PointScale: '1', Background: jssValue(PAGE, 'Background'), ...OPAQUE },
  });
  const bed = new Jiv({
    ChildLayout: {
      Position: 'Placed',
      Left: jssNumber(BED, 'Left') + 'pt', Top: jssNumber(BED, 'Top') + 'pt',
      Width: jssNumber(BED, 'Width') + 'pt', Height: jssNumber(BED, 'Height') + 'pt',
    },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { Layer: String(jssNumber(BED, 'Layer')), Background: CLEAR, ...OPAQUE },
  });
  for (let i = 0; i < 6; i++) {
    bed.AddChild(new Jiv({
      ChildLayout: { FlexGrow: jssNumber(jssClass(PERF, 'PerfBand'), 'FlexGrow') },
      Style: { Background: `LinearGradient(${i * 30}deg, rgb(${40 + i * 20}, 90, 120), rgb(20, 20, 20))`, ...OPAQUE },
    }));
  }
  page.AddChild(bed);
  const grid = new Jiv({
    ChildLayout: {
      Position: 'Placed',
      Left: jssNumber(GRID, 'Left') + 'pt', Top: jssNumber(GRID, 'Top') + 'pt',
      Width: jssNumber(GRID, 'Width') + 'pt',
    },
    Layout: { Direction: 'Row', Wrap: 'Wrap', Gap: jssValue(GRID, 'Gap') },
    Style: { Layer: String(jssNumber(GRID, 'Layer')), Background: CLEAR, ...OPAQUE },
  });
  const cards: Jiv[] = [];
  for (let i = 0; i < 20; i++) {
    const card = new Jiv({
      ChildLayout: { Width: jssNumber(CARD, 'Width') + 'pt', Height: jssNumber(CARD, 'Height') + 'pt', FlexShrink: 0 },
      Layout: { Direction: 'Column', Justify: 'End', Align: 'Stretch', Gap: '4pt', Padding: jssValue(CARD, 'Padding') },
      Style: {
        Background: CLEAR,
        Thickness: String(glassNumber('Thickness')), Refraction: String(glassNumber('Refraction')),
        BezelWidth: String(glassNumber('BezelWidth')), BezelScale: String(glassNumber('BezelScale')),
        Fillet: String(glassNumber('Fillet')),
        ChromaticAberration: String(glassNumber('ChromaticAberration')),
        BackdropFilter: 'Blur(4pt) Saturate(1.6) Contrast(0.6)', Tint: '0.45',
        BorderWidth: glassRaw('BorderWidth'), BorderBlur: glassRaw('BorderBlur'), BorderFade: glassRaw('BorderFade'),
        BorderColor: glassRaw('BorderColor'), BorderVariance: glassRaw('BorderVariance'),
        BorderLayer: String(glassNumber('BorderLayer')),
        FresnelStrength: glassRaw('FresnelStrength'), SpecularIntensity: glassRaw('SpecularIntensity'),
        LightAngle: glassRaw('LightAngle'), InnerBlur: glassRaw('InnerBlur'),
        ShadowColor: glassRaw('ShadowColor'), ShadowBlur: glassRaw('ShadowBlur'), ShadowOffsetY: glassRaw('ShadowOffsetY'),
        // The clause this file is about: every JwiftGlass surface probes its backdrop.
        ShadowAdaptive: glassRaw('ShadowAdaptive'),
        BorderRadius: jssValue(CARD, 'BorderRadius'), ...OPAQUE,
      },
    });
    card.AddChild(new Jiv({ Text: `Label ${i}`, Style: { Background: CLEAR, ...OPAQUE } }));
    card.AddChild(new Jiv({ Text: `Sub ${i}`, Style: { Background: CLEAR, ...OPAQUE } }));
    grid.AddChild(card);
    cards.push(card);
  }
  page.AddChild(grid);
  const screen = new Jiv({
    Overflow: 'Hidden',
    ChildLayout: { FlexGrow: jssNumber(SCREEN, 'FlexGrow') },
    Layout: { Direction: 'Column', Align: 'Stretch' },
    Style: { PointScale: '1', BorderRadius: SCREEN_RADIUS_PT + 'pt', Background: CLEAR, ...OPAQUE },
  });
  screen.AddChild(page);
  c.Root.AddChild(screen);
  return cards;
};

interface Census { Mode: string; Probes: number; Batches: number; Ends: number; Grouped: number; Moved: number; Refused: string }
interface Walked {
  Log: Event[];
  Cards: Jiv[];
  Census: Census;
  Marks: string[];
  Plans: { InstFrostLod: number; AdaptiveShadow: boolean }[];
}

const walk = (search: string): Walked => {
  const log: Event[] = [];
  const marks: string[] = [];
  OnJauiTrace((name) => { if (name.startsWith('jaui:shadow-probe')) marks.push(name); });
  try {
    const platform = { ...BrowserPlatform, GetUrlSearch: (): string => search };
    const c = new Canvas(new OffscreenCanvas(CANVAS_W, CANVAS_H) as unknown as HTMLCanvasElement, recorder(log), platform);
    c.SetSizePx(VIEW_W, VIEW_H);
    (c as unknown as { _dpr: number })._dpr = DPR;
    const cards = buildGlassGrid(c);
    c.RenderHeadless(1000);
    const priv = c as unknown as { _glassGroups: Map<Jiv, { Plans: { InstFrostLod: number; AdaptiveShadow: boolean }[] }> };
    const g = priv._glassGroups.get(cards[0]);
    const census = (globalThis as unknown as { __jauiShadowProbe: () => Census }).__jauiShadowProbe();
    return { Log: log, Cards: cards, Census: census, Marks: marks, Plans: g === undefined ? [] : g.Plans };
  } finally {
    OnJauiTrace(null);
  }
};

const probes = (w: Walked) => w.Log.filter((e): e is Extract<Event, { Kind: 'probe' }> => e.Kind === 'probe');
const fills = (w: Walked) => w.Log.filter((e): e is Extract<Event, { Kind: 'draw' }> => e.Kind === 'draw' && e.Site === 'fill');
const groupAt = (w: Walked): number => w.Log.findIndex((e) => e.Kind === 'group');
const drawStream = (w: Walked): string[] => w.Log
  .filter((e) => e.Kind === 'draw' || e.Kind === 'text' || e.Kind === 'other-draw')
  .map((e) => JSON.stringify(e));

// -- The probe's footprint, from `Jiv.ShadowBackdrop.frag`'s own constants. ---------------------

const SHADOW_TAPS = 96;
const SHADOW_R2 = [0.7548776662, 0.5698402910];

/** Every texel the probe's sharp taps can READ, as an inclusive texel-index box. A tap lands at
 *  `rect.xy + cell * rect.zw` (cell in [0,1)) and a LINEAR fetch there reads the 2x2 texels whose
 *  centres straddle it, `floor(p - 0.5)` and one past it. NEAREST reads a subset. */
const footprint = (r: Rect): { X0: number; X1: number; Y0: number; Y1: number } => {
  let X0 = Infinity, X1 = -Infinity, Y0 = Infinity, Y1 = -Infinity;
  for (let k = 0; k < SHADOW_TAPS; k++) {
    const cx = (0.5 + (k + 1) * SHADOW_R2[0]) % 1;
    const cy = (0.5 + (k + 1) * SHADOW_R2[1]) % 1;
    const px = r.x + cx * r.w, py = r.y + cy * r.h;
    const tx = Math.floor(px - 0.5), ty = Math.floor(py - 0.5);
    X0 = Math.min(X0, tx); X1 = Math.max(X1, tx + 1);
    Y0 = Math.min(Y0, ty); Y1 = Math.max(Y1, ty + 1);
  }
  return { X0, X1, Y0, Y1 };
};

/** The texels a quad `[x, y, w, h]` rasterises: those whose centre lies inside it. */
const covered = (q: number[]): { X0: number; X1: number; Y0: number; Y1: number } => ({
  X0: Math.ceil(q[0] - 0.5), X1: Math.ceil(q[0] + q[2] - 0.5) - 1,
  Y0: Math.ceil(q[1] - 0.5), Y1: Math.ceil(q[1] + q[3] - 0.5) - 1,
});

/** Texels of clearance between two texel boxes: > 0 is apart, <= 0 overlaps. */
const clearance = (a: ReturnType<typeof covered>, b: ReturnType<typeof covered>): number => {
  const dx = Math.max(b.X0 - a.X1, a.X0 - b.X1) - 1;
  const dy = Math.max(b.Y0 - a.Y1, a.Y0 - b.Y1) - 1;
  return Math.max(dx, dy);
};

// -- 1. THE FLAG ----------------------------------------------------------------------------

describe('?shadow-probe - the flag, its mark and its refusals', () => {
  it('defaults to `walk`, marks itself SAME, and the default is today', () => {
    const w = walk('');
    expect(w.Census.Mode).toBe('walk');
    expect(w.Census.Refused).toBe('');
    expect(w.Marks).toContain('jaui:shadow-probe armed=walk default=true pixels=SAME');
  });

  it('`group` arms beside the default glass-group', () => {
    const w = walk('?shadow-probe=group');
    expect(w.Census.Mode).toBe('group');
    expect(w.Marks).toContain('jaui:shadow-probe armed=group default=false pixels=SAME');
  });

  it('refuses by name, most specific first, and falls back to `walk`', () => {
    const cases: [string, string][] = [
      ['?shadow-probe=group&glass-group=off', 'glass-group-off-no-group-no-capture-to-probe-at'],
      ['?shadow-probe=group&blur-phased', 'blur-phased-probes-in-its-own-pass-beside-its-own-builds'],
      ['?shadow-probe=group&scene-restarts=40', 'restart-probes-insert-after-the-walk-probe-and-price-the-segments-this-arm-moves'],
      ['?shadow-probe=group&small-restarts=40', 'restart-probes-insert-after-the-walk-probe-and-price-the-segments-this-arm-moves'],
      ['?shadow-probe=group&shadow-snap=off', 'shadow-snap-off-is-an-arm-of-the-probe-ease-held-to-the-walk-probe'],
      // A group refused for its OWN reason is still no group.
      ['?shadow-probe=group&border-direct=on', 'glass-group-off-no-group-no-capture-to-probe-at'],
    ];
    for (const [search, why] of cases) {
      const w = walk(search);
      expect(w.Census.Mode, search).toBe('walk');
      expect(w.Census.Refused, search).toBe(why);
      expect(w.Marks, search).toContain(`jaui:shadow-probe armed=walk default=false pixels=SAME reason=${why}`);
      expect(probes(w).every((p) => !p.Batched), search).toBe(true);
    }
  });

  it("takes only 'walk' and 'group', by name", () => {
    expect(() => walk('?shadow-probe=on')).toThrow(/takes 'walk' or 'group'/);
    expect(() => walk('?shadow-probe')).toThrow(/takes 'walk' or 'group'/);
  });
});

// -- 2. THE WALK: SAME PROBES, SAME DRAWS, A DIFFERENT INSTANT ---------------------------------

describe('?shadow-probe on glass-grid - twenty probes move to the capture and nothing else moves', () => {
  const walked = walk('?shadow-probe=walk');
  const grouped = walk('?shadow-probe=group');

  it('the scene the rule rests on: one group of twenty, all adaptive, none taking a snapshot', () => {
    expect(walked.Plans.length).toBe(20);
    for (const p of walked.Plans) {
      expect(p.AdaptiveShadow).toBe(true);
      // `SCENE_TAP_FROST_LOD` is 0.05: above it no snapshot is taken, so the sharp tap is the live
      // scene in both arms and the batch covers every member.
      expect(p.InstFrostLod).toBeGreaterThan(0.05);
    }
  });

  it('walk: twenty lone probes, each just before its own fill, member N after member N-1 drew', () => {
    const p = probes(walked);
    expect(p.length).toBe(20);
    expect(p.every((e) => !e.Batched)).toBe(true);
    expect(walked.Log.some((e) => e.Kind === 'batch')).toBe(false);
    const f = fills(walked);
    for (let i = 0; i < 20; i++) {
      expect(p[i].Key).toBe(walked.Cards[i]);
      const at = walked.Log.indexOf(p[i]);
      // Its own fill is the next glass fill in the log.
      expect(walked.Log.indexOf(f[i])).toBeGreaterThan(at);
      if (i > 0) expect(at).toBeGreaterThan(walked.Log.indexOf(f[i - 1]));
    }
  });

  it('group: ONE batch of twenty, right after the one build, before any member paints; no walk probe', () => {
    const b = grouped.Log.filter((e) => e.Kind === 'batch');
    expect(b).toEqual([{ Kind: 'batch', Count: 20 }]);
    const at = grouped.Log.indexOf(b[0]);
    expect(at).toBe(groupAt(grouped) + 1);
    expect(at).toBeLessThan(grouped.Log.indexOf(fills(grouped)[0]));
    const p = probes(grouped);
    expect(p.length).toBe(20);
    expect(p.every((e) => e.Batched)).toBe(true);
    expect(grouped.Census).toMatchObject({ Mode: 'group', Grouped: 20, Moved: 0 });
  });

  it('member by member the batch is handed exactly what the walk hands each probe', () => {
    const a = probes(walked), b = probes(grouped);
    const handleOf = (w: Walked) => (w.Log[groupAt(w)] as { Handle: object }).Handle;
    for (let i = 0; i < 20; i++) {
      expect(b[i].Key).toBe(grouped.Cards[i]);
      expect(b[i].Rect).toEqual(a[i].Rect);
      expect(b[i].DetailLod).toBe(a[i].DetailLod);
      // The pyramid is the group's in BOTH arms, and the sharp tap is the live scene attachment.
      expect(a[i].Backdrop).toBe(handleOf(walked));
      expect(b[i].Backdrop).toBe(handleOf(grouped));
      expect(a[i].Scene).toBe(SCENE);
      expect(b[i].Scene).toBe(SCENE);
    }
  });

  it('the draws are identical, the shadow slot each fill carries included', () => {
    expect(drawStream(grouped)).toEqual(drawStream(walked));
    const f = fills(grouped);
    for (let i = 0; i < 20; i++) expect(f[i].Shadow).toEqual({ Slot: i, Adaptive: glassNumber('ShadowAdaptive') });
  });

  it('everything before the capture is the same frame in both arms', () => {
    const before = (w: Walked) => w.Log.slice(0, groupAt(w)).map((e) => JSON.stringify(e));
    expect(groupAt(walked)).toBeGreaterThan(0);
    expect(before(grouped)).toEqual(before(walked));
  });
});

// -- 3. PIXEL-NEUTRALITY, FROM THE WALK'S OWN DRAWS ---------------------------------------------

describe('?shadow-probe=group is pixel-neutral on glass-grid - no earlier paint reaches a probe', () => {
  const walked = walk('?shadow-probe=walk');
  const p = probes(walked);
  const g = groupAt(walked);

  /** Every quad the walk rasterised between the capture and member N's own probe. */
  const paintedBefore = (n: number): number[][] => {
    const out: number[][] = [];
    for (const e of walked.Log.slice(g + 1, walked.Log.indexOf(p[n]))) {
      if (e.Kind === 'draw' || e.Kind === 'text') out.push(...e.Quads);
      if (e.Kind === 'other-draw') throw new Error(`an unmodelled draw landed in the group: ${e.Name}`);
    }
    return out;
  };

  it('the proof is not vacuous: member N sees every earlier member paint first', () => {
    // Nineteen of the twenty probes follow at least one member's fill (the rim and text too,
    // wherever the walk put them); member 0 follows nothing.
    expect(paintedBefore(0).length).toBe(0);
    for (let n = 1; n < 20; n++) expect(paintedBefore(n).length).toBeGreaterThanOrEqual(n);
    const shadowed = fills(walked)[0].Quads[0];
    // The fill quad is the face grown by the shadow: 16pt blur + 2pt drop = 36 device px above and
    // below, 32 left and right, on a 432x300 face.
    expect([shadowed[2], shadowed[3]]).toEqual([496, 372]);
  });

  it('the footprint is the member\'s own box plus at most one texel of a linear tap', () => {
    for (const e of p) {
      const f = footprint(e.Rect);
      expect(f.X0).toBeGreaterThanOrEqual(Math.floor(e.Rect.x) - 1);
      expect(f.Y0).toBeGreaterThanOrEqual(Math.floor(e.Rect.y) - 1);
      expect(f.X1).toBeLessThanOrEqual(Math.ceil(e.Rect.x + e.Rect.w));
      expect(f.Y1).toBeLessThanOrEqual(Math.ceil(e.Rect.y + e.Rect.h));
    }
  });

  it('no quad drawn between the capture and member N\'s probe covers a texel it reads, for all N', () => {
    let min = Infinity;
    for (let n = 0; n < 20; n++) {
      const f = footprint(p[n].Rect);
      for (const q of paintedBefore(n)) {
        const c = clearance(f, covered(q));
        expect(c, `member ${n} vs quad ${q.join(',')}`).toBeGreaterThan(0);
        min = Math.min(min, c);
      }
    }
    // THE NUMBER: 40 px of gap less the 36 px vertical shadow skirt (16pt blur + 2pt drop) is 4 -
    // the whole of it, because the R2 taps' first row lands on the box's own top texel row and no
    // linear footprint reaches above it.
    expect(min).toBe(4);
  });

  it('...and the margins by axis are the geometry stated, not luck', () => {
    // Card 6 (row 1, col 1, box 592,480 432x300) against card 5 (left) and card 1 (above).
    const f = footprint(p[6].Rect);
    expect(f).toEqual({ X0: 595, X1: 1023, Y0: 480, Y1: 778 });
    const quadOf = (i: number) => covered(fills(walked)[i].Quads[0]);
    const left = quadOf(5), above = quadOf(1);
    // Sideways: 40 - 32 = 8 px of gap past the neighbour's skirt, plus 3 because the R2 sequence's
    // smallest x cell lands 3.5 px inside the box.
    expect(f.X0 - left.X1 - 1).toBe(11);
    // Vertically: 40 - 36 = 4, and the taps' top row sits on the box's first texel row.
    expect(f.Y0 - above.Y1 - 1).toBe(4);
  });

  it('NEGATIVE CONTROL: the instrument sees a skirt that does reach a probe', () => {
    // Card 1's fill quad grown downward by 5 px - a 41 px skirt across the 40 px gap - covers the
    // top texel row card 6's taps read, and only that one extra pixel separates pass from fail.
    const f = footprint(p[6].Rect);
    const above = fills(walked)[1].Quads[0];
    expect(clearance(f, covered([above[0], above[1], above[2], above[3] + 4]))).toBe(0);
    expect(clearance(f, covered([above[0], above[1], above[2], above[3] + 5]))).toBe(-1);
  });

  it('the rim draws its fill quad, and every card label lies inside its own card', () => {
    // Each member's rim overlay follows its fill before the next member's probe, over the SAME
    // 496x372 quad (its shadow alpha zeroed), so it is inside the bound above already.
    const rims = walked.Log.filter((e): e is Extract<Event, { Kind: 'draw' }> => e.Kind === 'draw' && e.Site === 'rim');
    expect(rims.length).toBe(20);
    for (let i = 0; i < 20; i++) expect(rims[i].Quads).toEqual(fills(walked)[i].Quads);
    // Text is not drawn by this harness (no glyph atlas headless), so it is bounded by LAYOUT: both
    // labels sit inside their own card's box, which is 40 device px from any other card's box and
    // so from any other probe footprint - a glyph's ink overhangs its line box by a pixel or two.
    for (const card of walked.Cards) {
      expect(card.Children.length).toBe(2);
      for (const t of card.Children) {
        // Layout X / Y are absolute CSS px, the card's as well as the label's.
        expect(t.X).toBeGreaterThanOrEqual(card.X);
        expect(t.Y).toBeGreaterThanOrEqual(card.Y);
        expect(t.X + t.Width).toBeLessThanOrEqual(card.X + card.Width);
        expect(t.Y + t.Height).toBeLessThanOrEqual(card.Y + card.Height);
      }
    }
    expect(walked.Log.some((e) => e.Kind === 'other-draw')).toBe(false);
  });
});

// -- 4. THE REAL RENDERER: ONE BIND, THE SAME PROBES, THE LEDGER'S COUNTS ------------------------

describe('MeasureShadowBackdrops on the real renderer - one bind, each probe unchanged', () => {
  const make = () => {
    const calls: string[] = [];
    const gl = new Proxy({}, {
      get: (_t, key) => {
        const k = String(key);
        if (/^[A-Z0-9_]+$/.test(k)) return k;
        return (...args: unknown[]) => { calls.push(`${k}(${args.map(String).join(', ')})`); return null; };
      },
    });
    const r = new WebGL2Renderer();
    Object.assign(r as unknown as Record<string, unknown>, {
      _gl: gl, _width: CANVAS_W, _height: CANVAS_H,
      _shadowShader: { Program: 'program:shadow' },
      _shadowLocs: new Proxy({}, { get: (_t, key) => `loc:${String(key)}` }),
      _shadowStateFbo: 'fbo:state',
      _sceneFbo: { Texture: 'tex:scene', Bind: () => { calls.push('scene.Bind()'); } },
      _quad: { Vao: 'vao:quad' },
      _shadowFreeSlots: Array.from({ length: 64 }, (_v, i) => 63 - i),
    });
    const priv = r as unknown as {
      _sceneLedger: { BeginFrame: () => void; NoteWrite: () => void; NoteRead: () => void; NoteFrameEndDrain: () => void };
      _tgt: (k: string) => void;
      _noteSceneDraw: () => void;
    };
    return { R: r, Calls: calls, Priv: priv };
  };
  const scene = { _brand: 'GpuTextureHandle', _glTex: 'tex:scene' } as never;
  const pyramid = { _brand: 'GpuTextureHandle', _glTex: 'tex:group' } as never;
  const keys = Array.from({ length: 20 }, () => ({}));
  const rectOf = (i: number): Rect => ({ x: 120 + (i % 5) * 472, y: 140 + ((i / 5) | 0) * 340, w: 432, h: 300 });
  const REBIND = ['scene.Bind()', `viewport(0, 0, ${CANVAS_W}, ${CANVAS_H})`, 'enable(BLEND)', 'blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)'];

  /** Bed, the group's build, then twenty members each drawing: the frame's scene-side events. */
  const frame = (grouped: boolean) => {
    const m = make();
    const l = m.Priv._sceneLedger;
    l.BeginFrame();
    m.Priv._tgt('scene');
    m.Priv._noteSceneDraw();                 // the bed
    l.NoteRead(); m.Priv._tgt('blur');       // the group build ends the scene's encoder
    const perProbe: string[][] = [];
    if (grouped) {
      m.Calls.length = 0;
      m.R.MeasureShadowBackdrops(keys.map((k, i) => ({ Key: k, Rect: rectOf(i), DetailLod: 1 })), pyramid, scene, 0.016);
      perProbe.push([...m.Calls]);
      for (let i = 0; i < 20; i++) m.Priv._noteSceneDraw();
    } else {
      m.R.RebindSceneTarget();
      for (let i = 0; i < 20; i++) {
        m.Calls.length = 0;
        m.R.MeasureShadowBackdrop(keys[i], rectOf(i), 1, pyramid, scene, 0.016);
        perProbe.push([...m.Calls]);
        m.Priv._noteSceneDraw();             // member i's fill
      }
    }
    l.NoteFrameEndDrain();
    return { R: m.R, Streams: perProbe };
  };

  it('walk: 20 probes, 20 binds, 19 `shadow-state` ends - the M4\'s reading', () => {
    const f = frame(false);
    expect(f.R.SceneEndsByKey).toEqual({ blur: 1, 'shadow-state': 19 });
    expect(f.R.SceneSwitches).toBe(20);
    expect([f.R.ShadowProbes, f.R.ShadowProbeBinds]).toEqual([20, 20]);
  });

  it('group: 20 probes, ONE bind, no `shadow-state` end - one scene segment for the twenty', () => {
    const f = frame(true);
    expect(f.R.SceneEndsByKey).toEqual({ blur: 1 });
    expect(f.R.SceneSwitches).toBe(1);
    expect([f.R.ShadowProbes, f.R.ShadowProbeBinds]).toEqual([20, 1]);
    // Reads are the same column in both arms: every probe still samples the scene once.
    expect(f.R.SceneReads).toBe(frame(false).R.SceneReads);
  });

  it('the batch\'s GL stream is the twenty lone probes with their binds and rebinds hoisted out', () => {
    const lone = frame(false).Streams;
    const batch = frame(true).Streams[0];
    const BIND = 'bindFramebuffer(FRAMEBUFFER, fbo:state)';
    for (const s of lone) {
      expect(s[0]).toBe(BIND);
      expect(s.slice(-4)).toEqual(REBIND);
    }
    const expected = [BIND, ...lone.flatMap((s) => s.slice(1, -4)), ...REBIND];
    expect(batch).toEqual(expected);
    expect(batch.filter((c) => c === BIND).length).toBe(1);
    expect(batch.filter((c) => c.startsWith('drawElements(')).length).toBe(20);
  });

  it('refuses to hold the bind across an open card target', () => {
    const m = make();
    (m.R as unknown as { _cardStack: unknown[] })._cardStack.push({});
    expect(() => m.R.MeasureShadowBackdrops([{ Key: {}, Rect: rectOf(0), DetailLod: 1 }], pyramid, scene, 0.016))
      .toThrow(/card target is open/);
  });
});
