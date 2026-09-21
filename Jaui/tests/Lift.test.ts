/**
 * `BackdropFilter: Lift(n)` and `BlendMode` -- Core/Lift.ts.
 *
 *   1. THE PARSE. `Lift(n)` is a backdrop function in 0-255 units that takes a bare var, and nothing
 *      else takes it.
 *   2. THE FOLD. The graded path's pair (b + 2L, bc / (b + 2L)) adds exactly L after ANY authored
 *      grade, and the naive product of pairs does not.
 *   3. THE EQUIVALENCE. The under-draw's blend and the graded fragment's source-over, modelled at
 *      the scene target's real precision (RGB10_A2) with the graded path's real dither, put the same
 *      value on screen; the one place they part (a clipping backdrop under partial coverage) is
 *      bounded and pinned.
 *   4. THE WALK, headless through a recording renderer: which path each element took, that the
 *      under-draw builds nothing and snapshots nothing, and that it is drawn BEFORE the element's
 *      own paint -- which is the whole guarantee that the ink is never lifted.
 *   5. THE ELEMENT BLEND. What `BlendMode` sets, around which draws, and what it refuses.
 *
 * WHAT THIS FILE CANNOT SEE: there is no rasteriser here. The blend equations are modelled from the
 * GL spec's definitions and pinned to the renderer's source; the orchestrator's shots are the proof.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';
import { JivInstanceBuffer, JIV_FLOATS_PER_INSTANCE } from '@jaui/Jiv/Jiv.InstanceBuffer';
import { ParseFilter } from '@jaui/Core/Filter.Parse';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';
import { FoldLift, Lift } from '@jaui/Core/Lift';
import { readRenderer, readJaui, arrowBody } from './Scene.ReadAfterWrite.Source';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_FRAG = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'Jiv', 'Shaders', 'Jiv.Panel.frag'), 'utf8',
).replace(/\r\n/g, '\n');

afterEach(() => { Lift.Mode = 'on'; });

// ── 1. THE PARSE ───────────────────────────────────────────────────────────────────────────────

describe('Lift() parses as a backdrop function, in 0-255 units', () => {
  it('reads a signed amount of 255', () => {
    expect(ParseFilter('Lift(18)').Lift).toBeCloseTo(18 / 255, 12);
    expect(ParseFilter('Lift(-12)').Lift).toBeCloseTo(-12 / 255, 12);
    expect(ParseFilter('None').Lift).toBe(0);
    expect(ParseFilter('Brightness(1.2)').Lift).toBe(0);
  });

  it('merges by function like every other: the last Lift wins, the rest persist', () => {
    const f = ParseFilter('Blur(8pt) Lift(18) Lift(29)');
    expect(f.Lift).toBeCloseTo(29 / 255, 12);
    expect(f.BlurRaw).toBe('8pt');
  });

  it('is refused on every zone but the backdrop, naming the tool that zone already has', () => {
    expect(() => ParseFilter('Lift(18)', 'foreground')).toThrow(/BlendMode: PlusLighter/);
    expect(() => ParseFilter('Lift(18)', 'border')).toThrow(/BackdropFilter function/);
    expect(() => ParseFilter('Lift(18)', 'fresnel')).toThrow(/BackdropFilter function/);
    expect(() => ParseFilter('Lift(300)')).toThrow(/signed amount of 255/);
  });

  it('takes a bare var, because the resolver evaluates a grade argument before the parse', () => {
    const vars = new Map([['JwiftWashLift', '18 * @Dark - 12 * @Light'], ['Dark', '1'], ['Light', '0']]);
    const rs = ResolveStyle({ ...DefaultJivStyle, BackdropFilter: 'Lift(@JwiftWashLift)' }, { ...SEED_CONTEXT, Vars: vars });
    expect(rs.BackdropLift).toBeCloseTo(18 / 255, 12);
    const light = new Map([...vars, ['Dark', '0'], ['Light', '1']]);
    const rl = ResolveStyle({ ...DefaultJivStyle, BackdropFilter: 'Lift(@JwiftWashLift)' }, { ...SEED_CONTEXT, Vars: light });
    expect(rl.BackdropLift).toBeCloseTo(-12 / 255, 12);
    // The authored grade is left exactly as written: the fold is a DRAW-time decision.
    expect(rl.BackdropBrightness).toBe(1);
    expect(rl.BackdropContrast).toBe(1);
  });
});

// ── 2. THE FOLD ────────────────────────────────────────────────────────────────────────────────

const LUMA = [0.2126, 0.7152, 0.0722];
/** `Jiv.Panel.frag`'s applyGrading, term for term. */
const applyGrading = (rgb: number[], b: number, s: number, c: number): number[] => {
  const cc = rgb.map((x) => (x - 0.5) * c + 0.5);
  const l = cc[0] * LUMA[0] + cc[1] * LUMA[1] + cc[2] * LUMA[2];
  return cc.map((x) => (l + (x - l) * s) * b);
};

describe('the fold adds L after ANY authored grade, and the naive product of pairs does not', () => {
  const grades = [
    [1, 1, 1], [1.25, 1.25, 0.75], [0.8, 1.6, 1.1], [1.85, 1, 1], [0.6, 0.4, 1.4], [1.1, 1.8, 0.9],
  ];
  const colours = [[0, 0, 0], [1, 1, 1], [0.1, 0.4, 0.9], [0.64, 0.61, 0.56], [0.9, 0.2, 0.3]];
  const lifts = [18, 30, 29, -12, -20, -19].map((n) => n / 255);

  it('b\' = b + 2L, c\' = bc / (b + 2L): every channel moves by exactly L', () => {
    let worst = 0;
    for (const [b, s, c] of grades) for (const L of lifts) for (const x of colours) {
      const f = FoldLift(b, c, L);
      const want = applyGrading(x, b, s, c).map((v) => v + L);
      const got = applyGrading(x, f.Brightness, s, f.Contrast);
      for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
    }
    // Double precision, i.e. exact: 1e-12 of full scale is 2.6e-10 of an 8-bit step.
    expect(worst).toBeLessThan(1e-12);
  });

  it('the naive composition lifts by b * L instead, wrong whenever Brightness is authored', () => {
    const [b, s, c] = [1.25, 1.25, 0.75];
    const L = 18 / 255;
    const x = [0.3, 0.3, 0.3];
    const naive = applyGrading(x, b * (1 + 2 * L), s, c / (1 + 2 * L));
    const base = applyGrading(x, b, s, c);
    expect(naive[0] - base[0]).toBeCloseTo(b * L, 12);
    expect(naive[0] - base[0] - L).toBeCloseTo((b - 1) * L, 12);
  });

  it('at the identity grade the fold IS the washeffect pair (Jwift.Glass.jss, 13f74db)', () => {
    const f = FoldLift(1, 1, 18 / 255);
    expect(f.Brightness).toBeCloseTo(1.141176, 6);
    expect(f.Contrast).toBeCloseTo(0.876289, 6);
    const g = FoldLift(1, 1, -20 / 255);
    expect(g.Brightness).toBeCloseTo(0.843137, 6);
    expect(g.Contrast).toBeCloseTo(1.186047, 6);
  });

  it('Lift 0 hands back the authored floats untouched, not a recomputed pair', () => {
    const f = FoldLift(1.25, 0.75, 0);
    expect(f.Brightness).toBe(1.25);
    expect(f.Contrast).toBe(0.75);
  });

  it('a lift too deep for the grade is refused rather than inverted', () => {
    expect(() => FoldLift(0.2, 1, -30 / 255)).toThrow(/cannot be folded/);
  });
});

// ── 3. THE EQUIVALENCE, at the target's real precision ─────────────────────────────────────────

/** The scene target is RGB10_A2 (`Framebuffer`, highPrecision): 1023 codes a channel. */
const Q = 1023;
const q10 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * Q) / Q;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** UNDER: FUNC_ADD / FUNC_REVERSE_SUBTRACT of src = |L| at SRC_ALPHA over ONE. */
const under = (dst: number, L: number, a: number): number => q10(dst + Math.sign(L) * Math.abs(L) * a);
/** GRADED: the fragment reads x, grades to x + L, adds `triDither` (+-1/255 triangular), is clamped
 *  to [0, 1] on output to a UNORM target, and source-over blends at the same alpha. */
const graded = (dst: number, L: number, a: number, dither: number): number =>
  q10(clamp01(dst + L + dither) * a + dst * (1 - a));

const DITHERS = [-1, -0.5, -0.25, 0, 0.25, 0.5, 1].map((d) => d * 0.999 / 255);
const LIFTS = [18, 30, 29, -12, -20, -19];

describe('the under-draw and the graded fragment put the same value on screen', () => {
  const sweep = (a: number, clipping: boolean): { Worst: number; Mean: number } => {
    let worst = 0, sum = 0, n = 0;
    for (const n255 of LIFTS) {
      const L = n255 / 255;
      for (let code = 0; code <= Q; code++) {
        const x = code / Q;
        const clips = x + L > 1 || x + L < 0;
        if (clips !== clipping) continue;
        for (const d of DITHERS) {
          const dev = Math.abs(under(x, L, a) - graded(x, L, a, d));
          worst = Math.max(worst, dev);
          sum += dev; n++;
        }
      }
    }
    return { Worst: worst, Mean: sum / Math.max(1, n) };
  };

  it('where nothing clips: within the graded path\'s own dither, at every coverage', () => {
    for (const a of [1, 0.75, 0.5, 0.25, 0.1]) {
      const r = sweep(a, false);
      // triDither's peak (1/255, which is 4.01 ten-bit codes) scaled by the coverage, plus one
      // ten-bit rounding. The under-draw has no dither at all: it is the graded path's MEAN.
      expect(r.Worst).toBeLessThanOrEqual(a / 255 + 1 / Q + 1e-9);
    }
    // The pinned headline: 0.0049 of full scale = 1.25 8-bit steps, interior, worst dither sample.
    expect(sweep(1, false).Worst).toBeLessThan(1.26 / 255);
  });

  it('where the backdrop clips: identical when fully covered, apart by at most a(1 - a)|L| at an edge', () => {
    // Fully covered, both clip to the same code -- except that the graded path's dither can pull a
    // value just past the clip back under it, so the bound is the dither's, as above.
    const inside = sweep(1, true);
    expect(inside.Worst).toBeLessThanOrEqual(1 / 255 + 1 / Q + 1e-9);
    // Partial coverage over a clipping backdrop is the one real difference: the graded source is
    // clamped to 1 BEFORE the blend scales it; the under-draw adds L*a and clamps AFTER. The two meet
    // at a = 0 and a = 1 and part most at a = 1/2, by |L| / 4: 7.5 codes of 255 for the hover lift
    // (29 / 4 = 7.25), 4.5 for the resting wash (18 / 4).
    for (const a of [0.75, 0.5, 0.25]) {
      for (const n255 of LIFTS) {
        const L = n255 / 255;
        let worst = 0;
        for (let code = 0; code <= Q; code++) {
          const x = code / Q;
          if (!(x + L > 1 || x + L < 0)) continue;
          worst = Math.max(worst, Math.abs(under(x, L, a) - graded(x, L, a, 0)));
        }
        expect(worst).toBeLessThanOrEqual(a * (1 - a) * Math.abs(L) + 1 / Q + 1e-9);
      }
    }
  });

  it('a lift carries the colour at 1: equal on every channel, so chroma is held', () => {
    const L = 18 / 255;
    const x = [183, 175, 163].map((v) => v / 255);
    const out = x.map((v) => under(v, L, 1));
    const chroma = (c: number[]): number => Math.max(...c) - Math.min(...c);
    expect(Math.abs(chroma(out) - chroma(x))).toBeLessThanOrEqual(2 / Q);
  });

  it('the headroom each lift has: the first 8-bit backdrop code at which it starts to clip', () => {
    // Measured through the under-draw model, not restated: the first code whose lifted value is no
    // longer backdrop + n.
    const lost = (code: number, n: number): boolean =>
      Math.abs(under(code / 255, n / 255, 1) - (code / 255 + n / 255)) > 1 / Q;
    const clipsFrom = (n: number): number => { for (let k = 0; k <= 255; k++) if (lost(k, n)) return k; return -1; };
    const clipsBelow = (n: number): number => { for (let k = 255; k >= 0; k--) if (lost(k, n)) return k; return -1; };
    expect(clipsFrom(18)).toBe(238);    // JwiftWash, dark: 238..255 all land on 255
    expect(clipsFrom(30)).toBe(226);    // JwiftWashStrong, dark
    expect(clipsFrom(29)).toBe(227);    // JwiftHoverWash, dark
    expect(clipsBelow(-12)).toBe(11);   // JwiftWash, light: 0..11 all land on 0
    expect(clipsBelow(-20)).toBe(19);   // JwiftWashStrong, light
    expect(clipsBelow(-19)).toBe(18);   // JwiftHoverWash, light
  });
});

// ── 4. THE WALK ────────────────────────────────────────────────────────────────────────────────

interface Call { Fn: string; Args: unknown[] }
interface Rec { Calls: Call[]; Batches: Float32Array[][]; Builds: number }

const recordingRenderer = (rec: Rec): Renderer => {
  let pending: Float32Array[] = [];
  const log = (fn: string) => (...args: unknown[]): unknown => { rec.Calls.push({ Fn: fn, Args: args }); return undefined; };
  const handlers: Record<string, unknown> = {
    PanelAddInstance: (data: Float32Array, offset: number, floats: number) => {
      for (let i = 0; i < floats; i += JIV_FLOATS_PER_INSTANCE) {
        pending.push(data.slice(offset + i, offset + i + JIV_FLOATS_PER_INSTANCE));
      }
    },
    PanelDrawBatch: () => { rec.Calls.push({ Fn: 'PanelDrawBatch', Args: [] }); rec.Batches.push(pending); pending = []; },
    ComputeBlur: () => { rec.Builds++; rec.Calls.push({ Fn: 'ComputeBlur', Args: [] }); return undefined; },
    SnapshotScreen: log('SnapshotScreen'),
    SetCompositeBlend: log('SetCompositeBlend'),
    RestoreBlend: log('RestoreBlend'),
    TextDrawBatch: log('TextDrawBatch'),
  };
  return new Proxy({}, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      if (key === 'PyramidBuilds') return rec.Builds;
      return handlers[key as string] ?? (() => undefined);
    },
  }) as unknown as Renderer;
};

const placed = (x: number, y: number, w: number, h: number): Record<string, string> => ({
  Position: 'Placed', Left: x + 'px', Top: y + 'px', Width: w + 'px', Height: h + 'px',
});

interface Walked { Rec: Rec; Census: { Under: number; Graded: number; Builds: number; Refused: Record<string, number> }; Emits: Jiv[] }

const walk = (search: string, build: (root: Jiv) => void): Walked => {
  const rec: Rec = { Calls: [], Batches: [], Builds: 0 };
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => search };
  const c = new Canvas(new OffscreenCanvas(400, 300) as unknown as HTMLCanvasElement, recordingRenderer(rec), platform);
  c.SetSizePx(400, 300);
  build(c.Root);
  const emits: Jiv[] = [];
  const priv = c as unknown as { _emitTextFor: (n: Jiv, ...rest: never[]) => void };
  const real = priv._emitTextFor;
  priv._emitTextFor = (n: Jiv, ...rest: never[]): void => {
    emits.push(n); rec.Calls.push({ Fn: 'EmitText', Args: [n] }); real(n, ...rest);
  };
  c.RenderHeadless(1000);
  const g = globalThis as unknown as { __jauiLift: () => Walked['Census'] };
  return { Rec: rec, Census: g.__jauiLift(), Emits: emits };
};

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const wash = (style: Record<string, string>, text = 'Aa'): Jiv => new Jiv({
  ChildLayout: placed(20, 20, 160, 40),
  Text: text,
  Style: { Background: TRANSPARENT, BorderRadius: '12', Opacity: '1', ...style },
});

const fns = (r: Rec): string[] => r.Calls.map((c) => c.Fn);

describe('the walk: a lift alone is drawn UNDER the element, and builds nothing', () => {
  it('one LiftAdd draw of the element\'s shape, before its text, with no snapshot and no build', () => {
    let node!: Jiv;
    const w = walk('', (root) => { node = wash({ BackdropFilter: 'Lift(18)' }); root.AddChild(node); });
    const f = fns(w.Rec);
    const set = f.indexOf('SetCompositeBlend');
    expect(set).toBeGreaterThanOrEqual(0);
    expect(w.Rec.Calls[set].Args[0]).toBe('LiftAdd');
    expect(f[set + 1]).toBe('PanelDrawBatch');
    expect(f[set + 2]).toBe('RestoreBlend');
    // THE INK: the element's own text is emitted after the lift is restored.
    expect(f.indexOf('EmitText')).toBeGreaterThan(set + 2);
    expect(f).not.toContain('SnapshotScreen');
    expect(f).not.toContain('ComputeBlur');
    expect(w.Census.Under).toBe(1);
    expect(w.Census.Graded).toBe(0);
    expect(w.Census.Builds).toBe(0);
  });

  it('the lift instance is the element\'s shape filled with |n| / 255, and nothing else', () => {
    let node!: Jiv;
    const w = walk('', (root) => { node = wash({ BackdropFilter: 'Lift(18)', BorderWidth: '1', BorderColor: '#fff' }); root.AddChild(node); });
    const set = fns(w.Rec).indexOf('SetCompositeBlend');
    const batchIdx = w.Rec.Calls.slice(0, set + 2).filter((c) => c.Fn === 'PanelDrawBatch').length - 1;
    const lift = w.Rec.Batches[batchIdx];
    expect(lift.length).toBe(1);
    const d = lift[0];
    const ref = new JivInstanceBuffer();
    ref.Begin();
    ref.Push(node, 1);
    const own = ref.Data;
    // Shape: rect, rotation basis, half-size, radii, smoothness, opacity, clip -- the fill's own.
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 29, 30, 54, 55]) expect(d[i]).toBe(own[i]);
    expect([d[12], d[13], d[14], d[15]]).toEqual([Math.fround(18 / 255), Math.fround(18 / 255), Math.fround(18 / 255), 1]);
    expect(d[19]).toBe(0);          // no border colour
    expect(d[27]).toBe(0);          // no border width
    expect(d[23]).toBe(0);          // no shadow
    expect([d[32], d[33], d[34], d[35]]).toEqual([1, 1, 1, 0]);   // no backdrop grade: nothing to sample
    expect(d[41]).toBe(0);          // no body tint
  });

  it('a negative lift takes FUNC_REVERSE_SUBTRACT, never a multiply', () => {
    const w = walk('', (root) => root.AddChild(wash({ BackdropFilter: 'Lift(-12)' })));
    const set = w.Rec.Calls.find((c) => c.Fn === 'SetCompositeBlend');
    expect(set?.Args[0]).toBe('LiftSubtract');
  });

  it('an element with no lift makes no blend call at all', () => {
    const w = walk('', (root) => root.AddChild(wash({})));
    expect(fns(w.Rec)).not.toContain('SetCompositeBlend');
    expect(w.Census.Under + w.Census.Graded).toBe(0);
  });
});

describe('the walk: a lift beside anything that samples is folded, and says why', () => {
  const refusalOf = (style: Record<string, string>, search = '', parentStyle: Record<string, string> = {}): Walked => walk(search, (root) => {
    const host = new Jiv({ ChildLayout: placed(0, 0, 300, 200), Style: { Background: TRANSPARENT, Opacity: '1', ...parentStyle } });
    host.AddChild(wash(style));
    root.AddChild(host);
  });

  it('Brightness beside it: Grade, and the instance carries the folded pair', () => {
    const w = refusalOf({ BackdropFilter: 'Brightness(1.2) Lift(18)' });
    expect(w.Census.Graded).toBe(1);
    expect(w.Census.Refused).toEqual({ Grade: 1 });
    expect(fns(w.Rec)).not.toContain('SetCompositeBlend');
    expect(fns(w.Rec)).toContain('SnapshotScreen');
    const f = FoldLift(1.2, 1, 18 / 255);
    const inst = w.Rec.Batches.flat().find((d) => Math.abs(d[32] - Math.fround(f.Brightness)) < 1e-6);
    expect(inst).toBeDefined();
    expect(inst![34]).toBeCloseTo(f.Contrast, 6);
  });

  it('Blur beside it: Blur', () => {
    expect(refusalOf({ BackdropFilter: 'Blur(8pt) Lift(18)' }).Census.Refused).toEqual({ Blur: 1 });
  });

  it('an ancestor\'s foreground Filter: Filter, because the graded fragment grades the lifted backdrop too', () => {
    const w = refusalOf({ BackdropFilter: 'Lift(18)' }, '', { Filter: 'Brightness(1.2)' });
    expect(w.Census.Refused).toEqual({ Filter: 1 });
  });

  it('a drop shadow: Shadow', () => {
    const w = refusalOf({ BackdropFilter: 'Lift(18)', ShadowColor: 'rgba(0,0,0,0.3)', ShadowBlur: '4' });
    expect(w.Census.Refused).toEqual({ Shadow: 1 });
  });

  it('?lift=graded forces every lift through the fold; ?lift=off draws none', () => {
    const g = walk('?lift=graded', (root) => root.AddChild(wash({ BackdropFilter: 'Lift(18)' })));
    expect(g.Census.Refused).toEqual({ Forced: 1 });
    expect(fns(g.Rec)).not.toContain('SetCompositeBlend');
    const o = walk('?lift=off', (root) => root.AddChild(wash({ BackdropFilter: 'Lift(18)' })));
    expect(o.Census.Under + o.Census.Graded).toBe(0);
    expect(fns(o.Rec)).not.toContain('SetCompositeBlend');
    expect(fns(o.Rec)).not.toContain('SnapshotScreen');
  });
});

// ── 5. THE ELEMENT BLEND ───────────────────────────────────────────────────────────────────────

describe('BlendMode blends the element\'s own paint, one draw at a time', () => {
  it('PlusLighter wraps the element\'s panel AND its text', () => {
    const w = walk('', (root) => root.AddChild(wash({ BlendMode: 'PlusLighter', Background: 'rgba(255,200,120,0.6)' })));
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend');
    expect(sets.map((c) => c.Args[0])).toEqual(['PlusLighter', 'PlusLighter']);
    expect(fns(w.Rec).filter((f) => f === 'RestoreBlend').length).toBe(2);
  });

  it('Lift under, PlusLighter on top: the lift lands first, then the element adds onto it', () => {
    const w = walk('', (root) => root.AddChild(wash({ BlendMode: 'PlusLighter', BackdropFilter: 'Lift(18)', Background: 'rgba(255,200,120,0.6)' })));
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend').map((c) => c.Args[0]);
    expect(sets).toEqual(['LiftAdd', 'PlusLighter', 'PlusLighter']);
  });

  it('refuses what it cannot blend whole, by name', () => {
    expect(() => walk('', (root) => root.AddChild(wash({ BlendMode: 'Screen' })))).toThrow(/Screen cannot blend text/);
    expect(() => walk('', (root) => root.AddChild(wash({ BlendMode: 'PlusLighter', BackdropFilter: 'Brightness(1.2)' }))))
      .toThrow(/samples its backdrop/);
    expect(() => walk('', (root) => root.AddChild(wash({ BlendMode: 'PlusLighter', Thickness: '4' })))).toThrow(/material/);
    expect(() => new Jiv({ Style: { BlendMode: 'Multiply' as never } })).toThrow(/not drawn by this engine/);
  });

  it('Screen without text draws, with the premultiplied output', () => {
    const w = walk('', (root) => root.AddChild(wash({ BlendMode: 'Screen', Background: '#446' }, '')));
    expect(w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend').map((c) => c.Args[0])).toEqual(['Screen']);
  });
});

describe('the blend states, as the renderer sets them and as GL defines them', () => {
  const body = arrowBody(readRenderer(), 'SetCompositeBlend');

  it('each mode sets both halves of the equation and both halves of the factors', () => {
    expect(body).toContain("case 'LiftAdd':\n        gl.blendEquation(gl.FUNC_ADD);\n        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);");
    expect(body).toContain("case 'LiftSubtract':\n        gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD);\n        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);");
    expect(body).toContain("case 'PlusLighter':\n        gl.blendEquation(gl.FUNC_ADD);\n        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);");
    expect(body).toContain("case 'Screen':\n        gl.blendEquation(gl.FUNC_ADD);\n        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);\n        this._premulOut = 1;");
    const restore = arrowBody(readRenderer(), 'RestoreBlend');
    expect(restore).toContain('gl.blendEquation(gl.FUNC_ADD);');
    expect(restore).toContain('this.EnableBlend();');
    expect(restore).toContain('this._premulOut = 0;');
  });

  it('Screen, premultiplied, is 1 - (1 - dst)(1 - src) at full coverage and a coverage lerp of it at an edge', () => {
    for (const dst of [0, 0.2, 0.5, 0.9]) for (const src of [0, 0.3, 0.7, 1]) for (const a of [1, 0.5, 0.25]) {
      const ps = src * a;                         // u_PremulOut: rgb *= a
      const out = ps * 1 + dst * (1 - ps);        // ONE, ONE_MINUS_SRC_COLOR
      const screen = 1 - (1 - dst) * (1 - src);
      expect(out).toBeCloseTo(dst + a * (screen - dst), 12);
    }
  });

  it('PlusLighter at SRC_ALPHA scales by coverage: a half-covered edge adds half', () => {
    const add = (dst: number, src: number, a: number): number => Math.min(1, dst + src * a);
    expect(add(0.2, 0.6, 0.5)).toBeCloseTo(0.5, 12);
    expect(add(0.2, 0.6, 1)).toBeCloseTo(0.8, 12);
  });

  it('the panel program premultiplies only under Screen, on the line before it writes', () => {
    expect(PANEL_FRAG).toContain('uniform float u_PremulOut;');
    expect(PANEL_FRAG).toContain('    if (u_PremulOut > 0.5) result.rgb *= result.a;\n    fragColor = result;\n}');
    expect(readRenderer()).toContain('gl.uniform1f(locs.premulOut, this._premulOut);');
  });

  it('the under-draw is emitted before the node\'s own branch, so nothing of the element precedes it', () => {
    const walkSrc = readJaui();
    const lift = walkSrc.indexOf('emitLiftUnder(node, lift, eff');
    const chain = walkSrc.indexOf("} else if (material === 'ProgressiveBlur' && !this._diagNoPblur) {");
    expect(lift).toBeGreaterThan(0);
    expect(lift).toBeLessThan(chain);
  });
});
