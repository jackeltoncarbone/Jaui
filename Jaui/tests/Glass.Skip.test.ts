/**
 * `?glass-skip` - THE GLASS CARD DRAW, STAGE BY STAGE, against the real walk and the real draw site.
 *
 * The arms are picture-DIFFERENT instruments by design, so nothing here ports a pixel. What is
 * asserted is the only thing that makes a stage arm a measurement of ONE stage:
 *
 *   1. The WALK issues the same glass draws, in the same order, over the same quads, under every
 *      mask - off, `none`, each stage alone, and all ten. (The real `Canvas` walk over glass-grid's
 *      tree against a recording renderer, as `Glass.Group.test.ts` drives it.)
 *   2. The DRAW SITE issues the same GL call stream under every mask, blend state included, and
 *      the ONE difference is the value `u_GlassSkip` is uploaded with: the mask on a glass draw, 0
 *      on every other draw, and 0 unflagged. (The real `WebGL2Renderer.PanelDrawBatch` against a
 *      recording GL context, fed the card instances the walk actually packed.)
 *   3. The CENSUS: what each stage removes on glass-grid's own two instances, which is where the
 *      prediction for each shot and each timing cell comes from - including the stages that remove
 *      executed work and NO pixel on this page (FresnelStrength 0, SpecularIntensity 0).
 *   4. The shader and `Glass.Skip.ts` name the same ten bits, every gate is present, and none of
 *      it reaches MATERIAL_FLAT or computes anything in MATERIAL_NONE.
 *
 * The glass-grid tree is transcribed from `Glass.Group.test.ts` (which transcribes it from
 * `Perf.GlassGrid.ts` and the sheets), with every number read out of the sheets the same way.
 * `ShadowBlur` / `ShadowOffsetY` / `ShadowColor` are added here because the draw's EXTENT is the
 * thing this file is about and the shadow is what sets it: 16pt blur and a 2pt drop are 36 device
 * px of skirt on each vertical side and 32 on each horizontal one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { WebGL2Renderer } from '@jaui/Core/WebGL2.Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';
import {
  GLASS_SKIP_STAGES, GLASS_SKIP_ALL, GlassSkipNames, ParseGlassSkip, GlassInstanceCensus,
  EmptyGlassFragCensus, type GlassSkipStage, type GlassFragCensus,
} from '@jaui/Core/Glass.Skip';
import {
  GlassBatchPredicates, GlassProgramFor, ParseGlassPrograms, ParseGlassReg,
  GLASS_OFF_BORDER_EDGE_AA, GLASS_OFF_FRESNEL_STRENGTH, GLASS_OFF_SPECULAR_INTENSITY,
  ParseGlassGates, GLASS_GATE_BARRIERS, GLASS_GATE_OPEN, type GlassGateBarrier,
} from '@jaui/Core/Glass.Programs';
import { OnJauiTrace } from '@jaui/Diagnostics/Jaui.Trace';
import { readPerfJss, readAppJss, readJwiftGlass, jssClass, jssValue, jssNumber } from './Scene.ReadAfterWrite.Source';
import { preprocess, codeLines, readPanelFrag } from './Flat.Program.Source';

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
/** The text of a property in the `JwiftGlass` rule itself (first occurrence after it opens). */
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

// -- The recording renderer: what the walk ASKS FOR, with every instance it packed. -------------

interface Draw { Glass: boolean; Site: 'fill' | 'rim' | 'panel'; Instances: Float32Array; Backdrop: unknown }

const recorder = (draws: Draw[]) => {
  let seq = 0;
  let pending: number[] = [];
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
    PaceTakeFence: () => null,
    PaceInFlight: () => 0,
    MeasureShadowBackdrop: () => -1,
    ComputeBlur: () => ({ Id: ++seq }),
    ComputeBlurAtlas: (_i: unknown, _w: number, _h: number, _r: number, members: readonly unknown[]) =>
      members.map(() => ({ Id: ++seq })),
    ComputeBlurGroup: () => ({ Id: ++seq }),
    PanelBeginBatch: (): void => { pending = []; },
    PanelAddInstance: (data: Float32Array, offset: number, count: number): void => {
      for (let i = 0; i < count; i++) pending.push(data[offset + i]);
    },
    // WHICH SITE DREW, off the call's own shape (see `Glass.Group.test.ts`): the glass FILL passes
    // ten arguments, the glass RIM overlay nine with `useGlassShader` true.
    PanelDrawBatch: (...args: unknown[]): void => {
      const site = args.length >= 10 ? 'fill' : args[6] === true ? 'rim' : 'panel';
      const glass = args.length >= 7 ? args[6] === true : args[2] !== null;
      draws.push({ Glass: glass, Site: site, Instances: Float32Array.from(pending), Backdrop: args[2] });
    },
    NoteGroupFallback: (): void => {},
    NoteGroupMember: (): void => {},
    GroupBuilds: 0, GroupMembers: 0, GroupFallbacks: 0,
    GlassDraws: 0, GlassCensus: EmptyGlassFragCensus(),
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
  return { Renderer: proxy as unknown as Renderer, Mutable: mutable };
};

// -- The scene. `Perf.GlassGrid.ts` and `App.ts`, transcribed. ---------------------------------

const OPAQUE = { Opacity: '1' } as const;
const CLEAR = 'rgba(0, 0, 0, 0)';

const buildGlassGrid = (c: Canvas): void => {
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
        BorderRadius: jssValue(CARD, 'BorderRadius'), ...OPAQUE,
      },
    });
    card.AddChild(new Jiv({ Text: `Label ${i}`, Style: { Background: CLEAR, ...OPAQUE } }));
    card.AddChild(new Jiv({ Text: `Sub ${i}`, Style: { Background: CLEAR, ...OPAQUE } }));
    grid.AddChild(card);
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
};

interface Census { Armed: boolean; Mask: number; Stages: string[]; Refused: string }
interface Walked { Draws: Draw[]; Census: Census; Mutable: Record<string, unknown> }

const walk = (search: string): Walked => {
  const draws: Draw[] = [];
  const rec = recorder(draws);
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => search };
  const c = new Canvas(new OffscreenCanvas(CANVAS_W, CANVAS_H) as unknown as HTMLCanvasElement, rec.Renderer, platform);
  c.SetSizePx(VIEW_W, VIEW_H);
  (c as unknown as { _dpr: number })._dpr = DPR;
  buildGlassGrid(c);
  c.RenderHeadless(1000);
  const census = (globalThis as unknown as { __jauiGlassSkip: () => Census }).__jauiGlassSkip();
  return { Draws: draws, Census: census, Mutable: rec.Mutable };
};

const glassDraws = (w: Walked): Draw[] => w.Draws.filter((d) => d.Glass);
/** Everything about a draw the arm must not move: which site, how many instances, and every float
 *  of every instance (the quad rect is floats 0-3; the rest is what the fragment reads). */
const shape = (w: Walked): string[] =>
  w.Draws.map((d) => `${d.Site}:${d.Glass}:${Array.from(d.Instances).join(',')}`);

const SINGLE = Object.keys(GLASS_SKIP_STAGES) as GlassSkipStage[];

// -- 1. THE WALK ------------------------------------------------------------------------------

describe('?glass-skip on glass-grid - the walk draws the same draws under every mask', () => {
  const off = walk('');
  const none = walk('?glass-skip=none');

  it('unflagged: unarmed, mask 0 on the renderer, no census', () => {
    expect(off.Census).toMatchObject({ Armed: false, Mask: 0, Stages: [], Refused: '' });
    expect(off.Mutable.DiagGlassSkip).toBe(0);
    expect(off.Mutable.DiagGlassSkipCensus).toBe(false);
  });

  it('twenty glass fills and twenty glass rims, each one instance, each a 496x372 quad', () => {
    const g = glassDraws(off);
    expect(g.filter((d) => d.Site === 'fill').length).toBe(20);
    expect(g.filter((d) => d.Site === 'rim').length).toBe(20);
    expect(g.length).toBe(40);
    for (const d of g) {
      expect(d.Instances.length).toBe(60);
      // The QUAD is the face plus the shadow margin, not the 568x436 pyramid region: 432x300 face,
      // `ShadowBlur 16pt + |ShadowOffsetY 2pt|` = 36 px above and below, 32 px left and right.
      // The rim keeps the fill's margin (`Push` zeroes the rim's shadow ALPHA after the rect is
      // written), so the rim is a full-size quad too.
      expect([d.Instances[2], d.Instances[3]]).toEqual([496, 372]);
      expect([d.Instances[6] * 2, d.Instances[7] * 2]).toEqual([432, 300]);
    }
  });

  it('none: armed at mask 0, the census on, the same draws as unflagged', () => {
    expect(none.Census).toMatchObject({ Armed: true, Mask: 0, Stages: [], Refused: '' });
    expect(none.Mutable.DiagGlassSkip).toBe(0);
    expect(none.Mutable.DiagGlassSkipCensus).toBe(true);
    expect(shape(none)).toEqual(shape(off));
  });

  it('every single stage, and all ten: the same draws, the same quads, the mask on the renderer', () => {
    // Beside `?glass-programs=off`, the arm's own meaning: every stage gates code the one glass
    // program runs. (The default `on` refuses `rim` and `specular` by name; see the refusals.)
    for (const stage of [...SINGLE, 'all']) {
      const w = walk(`?glass-programs=off&glass-skip=${stage}`);
      const mask = stage === 'all' ? GLASS_SKIP_ALL : GLASS_SKIP_STAGES[stage as GlassSkipStage];
      expect(w.Census.Armed, stage).toBe(true);
      expect(w.Census.Mask, stage).toBe(mask);
      expect(w.Census.Refused, stage).toBe('');
      expect(w.Mutable.DiagGlassSkip, stage).toBe(mask);
      expect(shape(w), stage).toEqual(shape(off));
    }
  });

  it('a comma list is the union of its stages', () => {
    const w = walk('?glass-programs=off&glass-skip=rim,specular,border');
    expect(w.Census.Mask).toBe(4 | 8 | 16);
    expect(w.Census.Stages).toEqual(['rim', 'specular', 'border']);
    expect(shape(w)).toEqual(shape(off));
  });

  it('`?glass-group` (the default) COMPOSES: under it and without it, the arm moves no draw', () => {
    const groupOff = walk('?glass-group=off');
    const groupOffArm = walk('?glass-group=off&glass-programs=off&glass-skip=all');
    expect(groupOffArm.Census.Armed).toBe(true);
    expect(shape(groupOffArm)).toEqual(shape(groupOff));
    // The group changes which pyramid each draw binds, never the draw: the per-draw shapes match
    // across the two group arms except the backdrop handle, which `shape` does not read.
    expect(shape(groupOff)).toEqual(shape(off));
    const groupOn = walk('?glass-programs=off&glass-skip=all');
    expect(new Set(glassDraws(groupOn).filter((d) => d.Site === 'fill').map((d) => d.Backdrop)).size).toBe(1);
    expect(new Set(glassDraws(groupOffArm).filter((d) => d.Site === 'fill').map((d) => d.Backdrop)).size).toBe(20);
  });
});

describe('?glass-skip - refusals by name, each falling back to the unflagged draw', () => {
  const refused = (search: string, why: string): void => {
    const w = walk(search);
    expect(w.Census.Armed, search).toBe(false);
    expect(w.Census.Refused, search).toBe(why);
    expect(w.Mutable.DiagGlassSkip, search).toBe(0);
    expect(w.Mutable.DiagGlassSkipCensus, search).toBe(false);
  };

  it('?glass-gaussian changes the SOURCE of the sample, not the draw', () => {
    refused('?glass-group=off&glass-gaussian=match&glass-skip=rim',
      'glass-gaussian-changes-the-source-of-the-sample-not-the-draw');
  });

  it('?border-direct draws the rim with a different program', () => {
    refused('?glass-group=off&border-direct&glass-skip=border',
      'border-direct-draws-the-rim-with-the-sixth-program-and-a-64-tap-gather');
  });

  it('?border-source=scene splits the card draw across a second build', () => {
    refused('?border-source=scene&glass-skip=backdrop',
      'border-source-scene-splits-the-card-draw-across-a-second-build');
  });

  it('?no-glass-draw removes the draws this arm prices', () => {
    refused('?no-glass-draw&glass-skip=sdf', 'a-no-star-diagnostic-removes-the-glass-draws-this-arm-prices');
  });

  it('?glass-programs (default on) compiles the rim glow and the catchlight away from under their bits', () => {
    refused('?glass-skip=rim', 'glass-programs-on-compiles-away-rim-add-glass-programs=off');
    refused('?glass-skip=specular', 'glass-programs-on-compiles-away-specular-add-glass-programs=off');
    refused('?glass-skip=all', 'glass-programs-on-compiles-away-rim-and-specular-add-glass-programs=off');
    refused('?glass-programs=border-only&glass-skip=specular',
      'glass-programs-border-only-compiles-away-specular-add-glass-programs=off');
    refused('?glass-programs=no-light&glass-skip=rim,border',
      'glass-programs-no-light-compiles-away-rim-add-glass-programs=off');
  });

  it('...and every other stage, and `none`, COMPOSE with the default', () => {
    // `ca`, `grade` and `shadow` are compiled out of the RIM program too, but they never executed on
    // a rim (inside `borderOnly == 0.0`, or at shadow alpha 0), and the fills keep them.
    for (const stage of ['none', ...SINGLE.filter((st) => st !== 'rim' && st !== 'specular')]) {
      const w = walk(`?glass-skip=${stage}`);
      expect(w.Census.Armed, stage).toBe(true);
      expect(w.Census.Refused, stage).toBe('');
    }
    // Under `border-only` the fills take the full program, so `rim` still gates code that runs.
    expect(walk('?glass-programs=border-only&glass-skip=rim').Census.Armed).toBe(true);
  });

  it('?glass-reg=nogates compiles all ten gates away: every non-zero mask is refused, `none` composes', () => {
    refused('?glass-programs=off&glass-reg=nogates&glass-skip=sdf', 'glass-reg-nogates-compiles-the-ten-gates-away');
    expect(walk('?glass-reg=nogates&glass-skip=none').Census.Armed).toBe(true);
  });

  it('?glass-reg=scope and =all COMPOSE: the gates live inside the stages they move with', () => {
    for (const arm of ['scope', 'all']) {
      const w = walk(`?glass-programs=off&glass-reg=${arm}&glass-skip=all`);
      expect(w.Census.Armed, arm).toBe(true);
      expect(w.Mutable.DiagGlassReg, arm).toBe(arm);
      expect(shape(w), arm).toEqual(shape(walk('')));
    }
  });

  it('an unknown stage throws by name rather than arming a partial mask', () => {
    expect(() => ParseGlassSkip('rim,speculr')).toThrow(/unknown stage 'speculr'/);
    expect(ParseGlassSkip('off')).toBeNull();
    expect(ParseGlassSkip('none')).toBe(0);
    expect(ParseGlassSkip('all')).toBe(GLASS_SKIP_ALL);
    expect(ParseGlassSkip('')).toBe(GLASS_SKIP_ALL);
    expect(GLASS_SKIP_ALL).toBe(1023);
    expect(GlassSkipNames(GLASS_SKIP_ALL)).toEqual(SINGLE);
  });
});

// -- 2. THE DRAW SITE -------------------------------------------------------------------------

const cards = walk('');
const FILL = glassDraws(cards).find((d) => d.Site === 'fill')!.Instances;
const RIM = glassDraws(cards).find((d) => d.Site === 'rim')!.Instances;

/** The real `PanelDrawBatch` against a GL context that records every call. The programs and
 *  uniform locations are stand-ins (`loc:<name>`); everything else is the renderer's own code. */
const drawSite = () => {
  const calls: string[] = [];
  const gl = new Proxy({}, {
    get: (_t, key) => {
      const k = String(key);
      if (/^[A-Z0-9_]+$/.test(k)) return k;
      return (...args: unknown[]) => {
        calls.push(`${k}(${args.map((a) => (a instanceof Float32Array ? `f32[${Array.from(a).join(',')}]` : String(a))).join(', ')})`);
        return null;
      };
    },
  });
  const r = new WebGL2Renderer();
  const locs = new Proxy({}, { get: (_t, key) => `loc:${String(key)}` });
  Object.assign(r as unknown as Record<string, unknown>, {
    _gl: gl,
    _panelShaderGlass: { Program: 'program:glass' }, _panelLocsGlass: locs,
    _panelShaderNone: { Program: 'program:none' }, _panelLocsNone: locs,
    _panelShaderGlassBorderOnly: { Program: 'program:glass-border-only' }, _panelLocsGlassBorderOnly: locs,
    _panelShaderGlassNoLight: { Program: 'program:glass-no-light' }, _panelLocsGlassNoLight: locs,
  });
  const draw = (inst: Float32Array, glass: boolean, mask: number, census: boolean): string[] => {
    r.DiagGlassSkip = mask;
    r.DiagGlassSkipCensus = census;
    r.PanelBeginBatch();
    r.PanelAddInstance(inst, 0, inst.length);
    // The renderer skips a `useProgram` for the program already bound. Two glass programs now
    // alternate (rim / fill), so every stream starts unbound and carries its own bind.
    (r as unknown as { _lastProgram: unknown })._lastProgram = null;
    calls.length = 0;
    const backdrop = { _brand: 'GpuTextureHandle', _glTex: 'tex:pyramid' } as never;
    r.PanelDrawBatch(CANVAS_W, CANVAS_H, backdrop, 3, 0, 0, glass, null);
    return [...calls];
  };
  return { Renderer: r, Draw: draw };
};

describe('the draw site - one GL stream under every mask, the uniform the only difference', () => {
  const site = drawSite();
  const UNIFORM = 'uniform1i(loc:glassSkip, ';

  it('a fresh renderer uploads 0: the unflagged path is today\'s engine', () => {
    const r = new WebGL2Renderer();
    expect(r.DiagGlassSkip).toBe(0);
    expect(r.DiagGlassSkipCensus).toBe(false);
    const base = site.Draw(FILL, true, 0, false);
    expect(base.filter((c) => c.startsWith(UNIFORM))).toEqual([`${UNIFORM}0)`]);
  });

  it('every mask, both glass sites: identical calls but for the mask, and no blend call at all', () => {
    for (const inst of [FILL, RIM]) {
      const base = site.Draw(inst, true, 0, false);
      expect(base.some((c) => c.startsWith('drawElementsInstanced(TRIANGLES, 6, UNSIGNED_SHORT, 0, 1)'))).toBe(true);
      // Blend state is the scene pass's (`BeginScenePass`), never the draw's: no arm can move it here.
      expect(base.some((c) => /^blend|^enable\(BLEND|^disable\(BLEND/.test(c))).toBe(false);
      for (const mask of [...SINGLE.map((s) => GLASS_SKIP_STAGES[s]), GLASS_SKIP_ALL]) {
        const armed = site.Draw(inst, true, mask, false);
        expect(armed.filter((c) => c.startsWith(UNIFORM))).toEqual([`${UNIFORM}${mask})`]);
        expect(armed.map((c) => (c.startsWith(UNIFORM) ? `${UNIFORM}0)` : c))).toEqual(base);
      }
      // The census is CPU bookkeeping and issues no GL: the stream with it on is the same stream.
      expect(site.Draw(inst, true, 0, true)).toEqual(base);
    }
  });

  it('a NON-glass draw uploads 0 whatever the flag holds', () => {
    const calls = site.Draw(FILL, false, GLASS_SKIP_ALL, true);
    expect(calls.filter((c) => c.startsWith(UNIFORM))).toEqual([`${UNIFORM}0)`]);
    expect(calls).toContain('useProgram(program:none)');
  });

  it('the census books one glass draw per batch, and nothing when unarmed', () => {
    const r = site.Renderer;
    (r as unknown as { _sceneLedger: { BeginFrame: () => void } })._sceneLedger.BeginFrame();
    site.Draw(FILL, true, 0, false);
    expect(r.GlassDraws).toBe(0);
    site.Draw(FILL, true, 0, true);
    site.Draw(RIM, true, 0, true);
    expect(r.GlassDraws).toBe(2);
    expect(r.GlassCensus.Frags).toBe(2 * 496 * 372);
  });
});

// -- 2b. ?glass-programs ON GLASS-GRID'S REAL INSTANCES ---------------------------------------

describe('?glass-programs on glass-grid - every rim takes BORDER_ONLY, every fill NO_GLOW + NO_SPEC', () => {
  const g = glassDraws(cards);

  it('the predicates, on every glass draw the walk issued: forty batches, zero fallbacks', () => {
    const kinds = g.map((d) => GlassProgramFor(GlassBatchPredicates(d.Instances, d.Instances.length / 60, 60), 'on'));
    expect(kinds.length).toBe(40);
    g.forEach((d, i) => expect(kinds[i], d.Site).toBe(d.Site === 'rim' ? 'borderOnly' : 'noLight'));
    expect(kinds.filter((k) => k === 'full').length).toBe(0);
    // Each arm alone: `border-only` sends the fills back to the full program, `no-light` takes
    // every batch (a rim's Fresnel and Specular are the sheet's zeros too), `off` takes none.
    const under = (arm: 'border-only' | 'no-light' | 'off') =>
      g.map((d) => GlassProgramFor(GlassBatchPredicates(d.Instances, 1, 60), arm));
    expect(under('border-only')).toEqual(g.map((d) => (d.Site === 'rim' ? 'borderOnly' : 'full')));
    expect(under('no-light')).toEqual(g.map(() => 'noLight'));
    expect(under('off')).toEqual(g.map(() => 'full'));
  });

  it('the predicates are exact: one instance answering no sends the whole batch back', () => {
    const two = new Float32Array(120);
    two.set(RIM, 0); two.set(RIM, 60);
    expect(GlassProgramFor(GlassBatchPredicates(two, 2, 60), 'on')).toBe('borderOnly');
    two.set(FILL, 60);                        // a fill joins the rim batch: not every instance is a rim
    expect(GlassProgramFor(GlassBatchPredicates(two, 2, 60), 'on')).toBe('noLight');
    two[60 + GLASS_OFF_FRESNEL_STRENGTH] = 0.55;   // and one lit instance: the full program
    expect(GlassProgramFor(GlassBatchPredicates(two, 2, 60), 'on')).toBe('full');
    const neg = new Float32Array(FILL); neg[GLASS_OFF_SPECULAR_INTENSITY] = -0;
    expect(GlassBatchPredicates(neg, 1, 60).NoSpec).toBe(false);     // +0 exactly, never -0
    expect(GlassBatchPredicates(new Float32Array(0), 0, 60)).toEqual({ BorderOnly: false, NoGlow: false, NoSpec: false });
    // The offsets are the packer's.
    expect(RIM[GLASS_OFF_BORDER_EDGE_AA]).toBeLessThan(0);
    expect(FILL[GLASS_OFF_BORDER_EDGE_AA]).toBeGreaterThanOrEqual(0);
    const packer = readFileSync(new URL('../src/Jiv/Jiv.InstanceBuffer.ts', import.meta.url), 'utf8');
    expect(packer).toContain(`data[offset + ${GLASS_OFF_FRESNEL_STRENGTH}] = style.FresnelStrength;`);
    expect(packer).toContain(`data[offset + ${GLASS_OFF_SPECULAR_INTENSITY}] = style.SpecularIntensity;`);
    expect(packer).toContain(`data[offset + ${GLASS_OFF_BORDER_EDGE_AA}] = -Math.max(borderEdgeAa, 1e-3);`);
  });

  it('the real draw site binds the variant, books it, and changes nothing else in the stream', () => {
    const site = drawSite();
    const r = site.Renderer;
    const ledger = (r as unknown as { _sceneLedger: { BeginFrame: () => void } })._sceneLedger;
    ledger.BeginFrame();
    const rim = site.Draw(RIM, true, 0, false);
    const fill = site.Draw(FILL, true, 0, false);
    expect(rim).toContain('useProgram(program:glass-border-only)');
    expect(fill).toContain('useProgram(program:glass-no-light)');
    expect(r.GlassProgramCensus).toEqual({ BorderOnly: 1, NoGlow: 1, NoSpec: 1, Fallbacks: 0 });
    r.DiagGlassPrograms = 'off';
    const rimOff = site.Draw(RIM, true, 0, false);
    const fillOff = site.Draw(FILL, true, 0, false);
    expect(rimOff).toContain('useProgram(program:glass)');
    expect(fillOff).toContain('useProgram(program:glass)');
    // `off` books nothing: the arm is not consulted.
    expect(r.GlassProgramCensus).toEqual({ BorderOnly: 1, NoGlow: 1, NoSpec: 1, Fallbacks: 0 });
    // The ONE difference between the arms is the program bound: every other call, uniforms and
    // textures and the draw itself, is the same call with the same arguments.
    const unbind = (c: string[]) => c.filter((x) => !x.startsWith('useProgram('));
    expect(unbind(rim)).toEqual(unbind(rimOff));
    expect(unbind(fill)).toEqual(unbind(fillOff));
    // A lit batch under `on` falls back and is counted.
    r.DiagGlassPrograms = 'on';
    const lit = new Float32Array(FILL); lit[GLASS_OFF_FRESNEL_STRENGTH] = 0.7;
    expect(site.Draw(lit, true, 0, false)).toContain('useProgram(program:glass)');
    expect(r.GlassProgramCensus.Fallbacks).toBe(1);
    // A non-glass draw is never asked.
    site.Draw(FILL, false, 0, false);
    expect(r.GlassProgramCensus).toEqual({ BorderOnly: 1, NoGlow: 1, NoSpec: 1, Fallbacks: 1 });
  });

  it('?glass-reg binds its own family for every kind, and throws by name when it was never compiled', () => {
    const site = drawSite();
    const r = site.Renderer;
    r.DiagGlassReg = 'scope';
    expect(() => site.Draw(FILL, true, 0, false)).toThrow(/\?glass-reg=scope but its programs were never compiled/);
    const locs = new Proxy({}, { get: (_t, key) => `loc:${String(key)}` });
    const fam = (k: string) => ({ Shader: { Program: `program:reg-${k}` }, Locs: locs });
    Object.assign(r as unknown as Record<string, unknown>, {
      _glassRegPrograms: { full: fam('full'), borderOnly: fam('borderOnly'), noLight: fam('noLight') },
      _glassRegCut: 'scope',
    });
    expect(site.Draw(RIM, true, 0, false)).toContain('useProgram(program:reg-borderOnly)');
    expect(site.Draw(FILL, true, 0, false)).toContain('useProgram(program:reg-noLight)');
    r.DiagGlassPrograms = 'off';
    expect(site.Draw(FILL, true, 0, false)).toContain('useProgram(program:reg-full)');
    // A family cut for another value is not this arm's: the pick refuses rather than binding it.
    r.DiagGlassReg = 'all';
    expect(() => site.Draw(FILL, true, 0, false)).toThrow(/\?glass-reg=all/);
  });

  it('the walk: the default arm and its mark, and the renderer fields each arm hands over', () => {
    const d = walk('');
    expect(d.Mutable.DiagGlassPrograms).toBe('on');
    expect(d.Mutable.DiagGlassReg).toBe('off');
    const census = (globalThis as unknown as { __jauiGlassPrograms: () => { Arm: string; Reg: string; Programs: number } })
      .__jauiGlassPrograms();
    expect(census).toMatchObject({ Arm: 'on', Reg: 'off', Programs: 7 });
    for (const arm of ['off', 'border-only', 'no-light'] as const) {
      expect(walk(`?glass-programs=${arm}`).Mutable.DiagGlassPrograms, arm).toBe(arm);
    }
    for (const arm of ['scope', 'all', 'nogates'] as const) {
      expect(walk(`?glass-reg=${arm}`).Mutable.DiagGlassReg, arm).toBe(arm);
    }
    // No arm moves a draw: the programs differ, the draws do not.
    for (const q of ['?glass-programs=off', '?glass-reg=scope', '?glass-reg=nogates&glass-programs=no-light']) {
      expect(shape(walk(q)), q).toEqual(shape(d));
    }
  });

  it('the parses: named values only, bare flags pick the arm, anything else throws by name', () => {
    expect(ParseGlassPrograms(null)).toBe('on');
    expect(ParseGlassPrograms('')).toBe('on');
    expect(ParseGlassPrograms('border-only')).toBe('border-only');
    expect(() => ParseGlassPrograms('border')).toThrow(/got 'border'/);
    expect(ParseGlassReg(null)).toBe('off');
    expect(ParseGlassReg('')).toBe('scope');
    expect(ParseGlassReg('nogates')).toBe('nogates');
    expect(() => ParseGlassReg('lifetime')).toThrow(/got 'lifetime'/);
    expect(() => walk('?glass-programs=of')).toThrow(/glass-programs/);
  });
});

// -- 3. THE CENSUS ----------------------------------------------------------------------------

const censusOf = (inst: Float32Array, mask: number): GlassFragCensus => GlassInstanceCensus(inst, 0, mask);

describe('the census on glass-grid\'s own instances - what each stage removes', () => {
  const fill0 = censusOf(FILL, 0);
  const rim0 = censusOf(RIM, 0);

  it('the instances are the sheet\'s: no Fresnel, no specular, a 0.9 px border on the rim only', () => {
    // FresnelStrength 0 and SpecularIntensity 0 on JwiftGlass. Both stages still RUN, and that is
    // the finding the `rim` and `specular` arms are for.
    expect(FILL[43]).toBe(0);
    expect(FILL[44]).toBe(0);
    expect(FILL[27]).toBe(0);            // the fill is 'Suppress': its border moved to the rim
    expect(RIM[27]).toBeCloseTo(0.9, 5); // 0.45pt at dpr 2
    expect(RIM[28]).toBeLessThan(0);     // the border-only flag
    expect(FILL[23]).toBeGreaterThan(0); // the fill carries the shadow ...
    expect(RIM[23]).toBe(0);             // ... and the rim does not
    expect(FILL[55]).toBe(RIM[55]);
  });

  it('frags: every pixel centre of the 496x372 quad; the face, the skirt and the box cut', () => {
    for (const c of [fill0, rim0]) {
      expect(c.Frags).toBe(496 * 372);
      expect(c.Face + c.Skirt).toBe(c.Frags);
      expect(c.PillApprox).toBe(0);
      expect(c.Projective).toBe(0);
    }
    // A 432x300 face with 28pt (56 px) superellipse corners: the face is 432x300 less the four
    // corner pockets, and the skirt is the rest of the quad. Pinned as numbers so a change to the
    // corner field or the quad shows up here first.
    expect(fill0.Face).toBe(rim0.Face);
    expect(fill0.Face).toBeGreaterThan(432 * 300 - 4 * 56 * 56 * 0.25);
    expect(fill0.Face).toBeLessThan(432 * 300);
  });

  it('fill taps: one per fragment on the fill draw, three where the chromatic spread is >= 0.5 px', () => {
    expect(fill0.Ca3).toBeGreaterThan(0);
    // No specular tap (SpecularIntensity 0) and no border tap (the fill's border is suppressed).
    expect(fill0.Border).toBe(0);
    expect(fill0.TapsFull).toBe(fill0.Frags + 2 * fill0.Ca3 + fill0.Band);
    // The rim draw is border-only: no fill tap, no glow; its one tap is the border zone's.
    expect(rim0.Ca3).toBe(0);
    expect(rim0.Band).toBe(0);
    expect(rim0.Border).toBeGreaterThan(0);
    expect(rim0.TapsFull).toBe(rim0.Border);
  });

  const each = (mask: number) => ({ F: censusOf(FILL, mask), R: censusOf(RIM, mask) });

  it('every stage leaves frags and the unmasked count alone', () => {
    for (const stage of SINGLE) {
      const { F, R } = each(GLASS_SKIP_STAGES[stage]);
      expect(F.Frags, stage).toBe(fill0.Frags);
      expect(R.Frags, stage).toBe(rim0.Frags);
      expect(F.TapsFull, stage).toBe(fill0.TapsFull);
      expect(R.TapsFull, stage).toBe(rim0.TapsFull);
      // `sdf` is the exception: the sharp rectangle fills the corner pockets, the face and the
      // glow band grow, and the taps they pay grow with them.
      if (stage !== 'sdf') expect(F.Taps, stage).toBeLessThanOrEqual(F.TapsFull);
    }
  });

  it('backdrop: no tap at all', () => {
    const { F, R } = each(GLASS_SKIP_STAGES.backdrop);
    expect([F.Taps, R.Taps]).toEqual([0, 0]);
  });

  it('ca: the two extra chromatic taps, and only on the fill', () => {
    const { F, R } = each(GLASS_SKIP_STAGES.ca);
    expect(F.Taps).toBe(fill0.TapsFull - 2 * fill0.Ca3);
    expect(R.Taps).toBe(rim0.TapsFull);
  });

  it('rim: the glow band\'s tap - executed work that composites nothing at FresnelStrength 0', () => {
    const { F, R } = each(GLASS_SKIP_STAGES.rim);
    expect(F.Taps).toBe(fill0.TapsFull - fill0.Band);
    expect(fill0.Band).toBeGreaterThan(0);
    expect(R.Taps).toBe(rim0.TapsFull);
  });

  it('specular: NO tap on glass-grid - the rim-specular tap is gated off by SpecularIntensity 0', () => {
    // The arm still removes the Blinn-Phong catchlight's ALU, which runs on EVERY glass fragment
    // of both draws. So its taps read unchanged and its time is pure ALU; the shot must read 0.
    const { F, R } = each(GLASS_SKIP_STAGES.specular);
    expect([F.Taps, R.Taps]).toEqual([fill0.TapsFull, rim0.TapsFull]);
  });

  it('border: the rim draw\'s only tap', () => {
    const { F, R } = each(GLASS_SKIP_STAGES.border);
    expect(R.Taps).toBe(0);
    expect(F.Taps).toBe(fill0.TapsFull);
  });

  it('skirt: the box cut removes most of the skirt and every tap it paid', () => {
    const { F, R } = each(GLASS_SKIP_STAGES.skirt);
    expect(F.Cut).toBe(R.Cut);
    expect(F.Cut).toBeGreaterThan(0.8 * fill0.Skirt);
    expect(F.Cut).toBeLessThan(fill0.Skirt);
    expect(F.Taps).toBeLessThan(fill0.TapsFull - F.Cut + 1);
    expect(F.ClipFetches).toBe(fill0.ClipFetches - 3 * FILL[55] * F.Cut);
    expect(R.Taps).toBe(rim0.TapsFull);
  });

  it('clip: every clip fetch', () => {
    const { F, R } = each(GLASS_SKIP_STAGES.clip);
    expect([F.ClipFetches, R.ClipFetches]).toEqual([0, 0]);
    expect(fill0.ClipFetches).toBe(3 * FILL[55] * fill0.Frags);
  });

  it('sdf, grade, shadow: ALU stages - no tap moves (sdf re-shapes the corners, so the regions shift)', () => {
    for (const stage of ['grade', 'shadow'] as const) {
      const { F, R } = each(GLASS_SKIP_STAGES[stage]);
      expect([F.Taps, R.Taps], stage).toEqual([fill0.TapsFull, rim0.TapsFull]);
    }
    const { F } = each(GLASS_SKIP_STAGES.sdf);
    // The sharp rectangle fills the corner pockets: every one of them becomes face.
    expect(F.Face).toBeGreaterThan(fill0.Face);
    expect(F.Face).toBeLessThanOrEqual(436 * 304);
  });

  it('all ten: no tap, no clip fetch, the skirt cut', () => {
    const { F, R } = each(GLASS_SKIP_ALL);
    expect([F.Taps, R.Taps, F.ClipFetches, R.ClipFetches]).toEqual([0, 0, 0, 0]);
    expect(F.Cut).toBeGreaterThan(0);
  });
});

// -- 4. THE SHADER ----------------------------------------------------------------------------

describe('Jiv.Panel.frag - the same ten bits, every gate present, none of it outside the glass program', () => {
  const FRAG = readPanelFrag();

  it('declares exactly the ten bits Glass.Skip.ts names, with the same values', () => {
    const declared = [...FRAG.matchAll(/const int GLASS_SKIP_([A-Z]+)\s*=\s*(\d+);/g)]
      .map((m) => [m[1].toLowerCase(), Number(m[2])]);
    expect(Object.fromEntries(declared)).toEqual(GLASS_SKIP_STAGES);
  });

  it('gates every stage at least once, and the bits it gates are only the declared ones', () => {
    const gated = new Set([...FRAG.matchAll(/GlassSkips\(GLASS_SKIP_([A-Z]+)\)/g)].map((m) => m[1].toLowerCase()));
    expect([...gated].sort()).toEqual([...SINGLE].sort());
  });

  it('is ONE uniform: no stage is a define, so both arms of every cell run one compiled program', () => {
    expect((FRAG.match(/uniform int u_GlassSkip;/g) ?? []).length).toBe(1);
    for (const m of FRAG.match(/^\s*#\s*(if|elif|ifdef|define)\b.*$/gm) ?? []) expect(m).not.toMatch(/GLASS_SKIP|GlassSkip/);
  });

  it('MATERIAL_FLAT has none of it; MATERIAL_NONE has it as a constant false', () => {
    const text = (defines: string[]): string => codeLines(preprocess(FRAG, defines)).map((l) => l.Text).join('\n');
    expect(text(['MATERIAL_FLAT'])).not.toMatch(/GlassSkip|GLASS_SKIP|u_GlassSkip/);
    expect(text(['MATERIAL_FLAT', 'NO_SHAPE_GRADIENT'])).not.toMatch(/GlassSkip|GLASS_SKIP|u_GlassSkip/);
    expect(text(['MATERIAL_NONE'])).toContain('bool GlassSkips(int bit) { return false; }');
    expect(text(['MATERIAL_NONE'])).not.toContain('u_GlassSkip & bit');
    expect(text(['MATERIAL_GLASS'])).toContain('bool GlassSkips(int bit) { return (u_GlassSkip & bit) != 0; }');
  });

  it('the skirt discard is the FIRST statement of main, ahead of the clip stack', () => {
    const main = FRAG.slice(FRAG.indexOf('void main() {'));
    expect(main.indexOf('GlassSkirtCut()')).toBeLessThan(main.indexOf('clipStackDistance('));
  });
});

// -- 5. THE CACHE KEY (added at fold, 2026-09-20) ---------------------------------------------------
//
// A census miss costs ~53 ms of CPU per instance on this box. Keyed on all 60 floats, the cache missed
// on every frame of glass-grid while the adaptive shadow eased: 40 x 53 ms inside the draw batch, a
// two-second frame and a black canvas under `?glass-skip=none`. The key is now the geometry the census
// reads, with the rect origin as its pixel-centre phase.
describe('the census cache key is the geometry the census reads', () => {
  it('a shadow change and a whole-pixel move HIT; a width change MISSES', () => {
    censusOf(FILL, 0);
    const shadow = new Float32Array(FILL); shadow[23] = shadow[23] + 1e-3;
    const t0 = performance.now(); censusOf(shadow, 0); const t1 = performance.now();
    const moved = new Float32Array(FILL); moved[0] = moved[0] + 40; moved[1] = moved[1] + 40;
    const t2 = performance.now(); censusOf(moved, 0); const t3 = performance.now();
    const wider = new Float32Array(FILL); wider[2] = wider[2] + 2;
    const t4 = performance.now(); censusOf(wider, 0); const t5 = performance.now();
    expect(t1 - t0).toBeLessThan(5);
    expect(t3 - t2).toBeLessThan(5);
    expect(t5 - t4).toBeGreaterThan(5);
    expect(censusOf(moved, 0)).toEqual(censusOf(FILL, 0));
  });
  it('the key offsets are exactly the offsets the census reads', () => {
    const src = readFileSync(new URL('../src/Core/Glass.Skip.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const body = src.slice(src.indexOf('export const GlassInstanceCensus'));
    const reads = new Set([...body.matchAll(/O\.([A-Za-z]+)( \+ ([0-9]))?/g)].map((m) => m[1] + (m[3] ?? '')));
    reads.delete('RectX'); reads.delete('RectY');
    const keyed = new Set([...src.slice(src.indexOf('GLASS_CENSUS_KEY_OFFSETS'), src.indexOf('];', src.indexOf('GLASS_CENSUS_KEY_OFFSETS'))).matchAll(/O\.([A-Za-z]+)( \+ ([0-9]))?/g)].map((m) => m[1] + (m[3] ?? '')));
    expect([...keyed].sort()).toEqual([...reads].sort());
  });
});

// -- 6. ?glass-gates (lane gatebisect) ---------------------------------------------------------------
//
// The arm compiles the glass family again with gates removed (the ten, one at a time) or added (new
// TRUE gates). The walk must not notice: same draws, same quads, same floats, under every arm. The
// draw site binds the arm's family in place of the boot family and changes nothing else. The new
// gate word is uploaded as GLASS_GATE_OPEN on every glass draw of every arm - including the
// shipped one, where no program declares it and the location is null.

const BARRIER_NAMES = Object.keys(GLASS_GATE_BARRIERS) as GlassGateBarrier[];

interface GatesCensus { Armed: string; Removed: string[]; Barriers: string[]; Programs: number; Refused: string }
const gatesCensus = (): GatesCensus =>
  (globalThis as unknown as { __jauiGlassGates: () => GatesCensus }).__jauiGlassGates();
const gatesKey = (w: Walked): string | undefined => (w.Mutable.DiagGlassGates as { Key: string } | null)?.Key;

/** A walk with the engine's marks captured, so a refusal is read off the line that prints it. */
const walkMarked = (search: string): { W: Walked; Marks: string[] } => {
  const marks: string[] = [];
  OnJauiTrace((m) => marks.push(m));
  try {
    return { W: walk(search), Marks: marks };
  } finally {
    OnJauiTrace(null);
  }
};

describe('?glass-gates on glass-grid - the walk draws the same draws under every arm', () => {
  const off = walk('');

  it('unflagged: off, nothing handed to the renderer, the mark says so', () => {
    const { W, Marks } = walkMarked('');
    expect(W.Mutable.DiagGlassGates).toBeNull();
    expect(gatesCensus()).toMatchObject({ Armed: 'off', Removed: [], Barriers: [], Programs: 0, Refused: '' });
    expect(Marks).toContain('jaui:glass-gates armed=off programs=0 default=true pixels=SAME');
  });

  it('every single gate removed, all ten, every new gate, and all of them: the same draws, the same floats', () => {
    const arms = [...SINGLE, 'all', ...BARRIER_NAMES.map((b) => `+${b}`),
      `all,${BARRIER_NAMES.map((b) => `+${b}`).join(',')}`];
    for (const arm of arms) {
      const { W, Marks } = walkMarked(`?glass-gates=${encodeURIComponent(arm)}`);
      const parsed = ParseGlassGates(arm)!;
      expect(gatesKey(W), arm).toBe(parsed.Key);
      expect(gatesCensus().Programs, arm).toBe(3);
      expect(Marks, arm).toContain(`jaui:glass-gates armed=${parsed.Key} programs=3 default=false pixels=SAME`);
      // Draw count, extents and every instance float: the walk never reads the arm.
      expect(glassDraws(W).length, arm).toBe(40);
      expect(shape(W), arm).toEqual(shape(off));
    }
  });

  it('a `+` typed in the URL arrives as a space and still means a new gate', () => {
    const w = walk('?glass-gates=+lod,+grad');
    expect(gatesKey(w)).toBe('+lod,+grad');
    expect(shape(w)).toEqual(shape(off));
  });

  it('?glass-programs=off composes: the full program is cut the same way, the draws do not move', () => {
    const w = walk('?glass-programs=off&glass-gates=backdrop');
    expect(w.Mutable.DiagGlassPrograms).toBe('off');
    expect(gatesKey(w)).toBe('backdrop');
    expect(shape(w)).toEqual(shape(off));
  });
});

describe('?glass-gates - refusals by name', () => {
  it('?glass-skip with any non-zero mask is refused: the gates it would switch are the ones being priced', () => {
    for (const q of ['?glass-gates=rim&glass-skip=sdf', '?glass-gates=%2Blod&glass-skip=all', '?glass-gates=all&glass-skip=border']) {
      const w = walk(q);
      expect(w.Census.Armed, q).toBe(false);
      expect(w.Census.Refused, q).toBe('glass-gates-compiles-the-gates-away-add-glass-gates=off');
      expect(w.Mutable.DiagGlassSkip, q).toBe(0);
      expect(gatesKey(w), q).toBeDefined();
    }
  });

  it('...and `none` composes: mask 0 is the shipped value, the census rides along', () => {
    const w = walk('?glass-gates=all&glass-skip=none');
    expect(w.Census.Armed).toBe(true);
    expect(w.Census.Mask).toBe(0);
    expect(gatesKey(w)).toBe('all');
  });

  it('?glass-reg is refused beside it, by name: both cut the glass family', () => {
    for (const reg of ['scope', 'all', 'nogates'] as const) {
      const { W, Marks } = walkMarked(`?glass-gates=all&glass-reg=${reg}`);
      expect(W.Mutable.DiagGlassReg, reg).toBe('off');
      expect(gatesKey(W), reg).toBe('all');
      expect(Marks.find((m) => m.startsWith('jaui:glass-reg ')), reg)
        .toBe('jaui:glass-reg armed=off programs=0 default=false pixels=SAME reason=glass-gates-cuts-the-glass-family-add-glass-gates=off');
    }
    // Unarmed gates leave ?glass-reg alone.
    expect(walk('?glass-reg=nogates').Mutable.DiagGlassReg).toBe('nogates');
  });

  it('a name that is not a gate throws by name, and a removed gate written with `+` is refused', () => {
    expect(() => walk('?glass-gates=shadows')).toThrow(/glass-gates.*got 'shadows'/);
    expect(() => walk('?glass-gates=%2Brim')).toThrow(/'rim' is one of the ten gates/);
  });
});

describe('?glass-gates at the draw site - its own family, the gate word uploaded open', () => {
  const GATE = 'uniform1i(loc:glassGate, ';

  it('every glass draw uploads GLASS_GATE_OPEN, on the shipped path too; a non-glass draw 0', () => {
    expect(GLASS_GATE_OPEN).toBe(63);
    for (const b of BARRIER_NAMES) expect(GLASS_GATE_OPEN & GLASS_GATE_BARRIERS[b], b).not.toBe(0);
    const site = drawSite();
    for (const inst of [FILL, RIM]) {
      expect(site.Draw(inst, true, 0, false).filter((c) => c.startsWith(GATE))).toEqual([`${GATE}63)`]);
    }
    expect(site.Draw(FILL, false, 0, false).filter((c) => c.startsWith(GATE))).toEqual([`${GATE}0)`]);
  });

  it('binds its own family for every kind, throws by name when never compiled, and changes only the program', () => {
    const site = drawSite();
    const r = site.Renderer;
    const base = { rim: site.Draw(RIM, true, 0, false), fill: site.Draw(FILL, true, 0, false) };
    r.DiagGlassGates = ParseGlassGates('backdrop,+lod');
    expect(() => site.Draw(FILL, true, 0, false)).toThrow(/\?glass-gates=backdrop,\+lod but its programs were never compiled/);
    const locs = new Proxy({}, { get: (_t, key) => `loc:${String(key)}` });
    const fam = (k: string) => ({ Shader: { Program: `program:gates-${k}` }, Locs: locs });
    Object.assign(r as unknown as Record<string, unknown>, {
      _glassGatePrograms: { full: fam('full'), borderOnly: fam('borderOnly'), noLight: fam('noLight') },
      _glassGatesCut: 'backdrop,+lod',
    });
    const rim = site.Draw(RIM, true, 0, false);
    const fill = site.Draw(FILL, true, 0, false);
    expect(rim).toContain('useProgram(program:gates-borderOnly)');
    expect(fill).toContain('useProgram(program:gates-noLight)');
    const unbind = (c: string[]) => c.filter((x) => !x.startsWith('useProgram('));
    expect(unbind(rim)).toEqual(unbind(base.rim));
    expect(unbind(fill)).toEqual(unbind(base.fill));
    r.DiagGlassPrograms = 'off';
    expect(site.Draw(FILL, true, 0, false)).toContain('useProgram(program:gates-full)');
    // A family cut for another arm is not this arm's.
    r.DiagGlassGates = ParseGlassGates('sdf');
    expect(() => site.Draw(FILL, true, 0, false)).toThrow(/\?glass-gates=sdf/);
    // A non-glass draw never reaches the family.
    r.DiagGlassGates = ParseGlassGates('backdrop,+lod');
    expect(site.Draw(FILL, false, 0, false)).toContain('useProgram(program:none)');
  });
});
