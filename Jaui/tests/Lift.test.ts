/**
 * THE ADDITIVE COLOR -- `Lift(<color>, <amount>)` in three zones -- Core/Lift.ts.
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
 *   5. THE INK BLEND. What `Filter: Lift()` sets, around which draws, and what it refuses.
 *   6. THE CASCADE. `Lift:`'s algebra, its barrier, and the one refusal that is an author error.
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
import { ParseFilter, FILTER_PROPS, MergeFilterValue } from '@jaui/Core/Filter.Parse';
import { ResolveStyle, SEED_CONTEXT } from '@jaui/Core/Style.Resolver';
import { DefaultJivStyle } from '@jaui/Jiv/Jiv.Defaults';
import { CascadeLift, FoldLift, Lift, LiftGateLine, LiftIsGray, LiftTouchesInk } from '@jaui/Core/Lift';
import type { LiftCensus, LiftValue } from '@jaui/Core/Lift';
import { readRenderer, readJaui, arrowBody } from './Scene.ReadAfterWrite.Source';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_FRAG = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'Jiv', 'Shaders', 'Jiv.Panel.frag'), 'utf8',
).replace(/\r\n/g, '\n');

/** Core/Lift.ts's own source, for the pins that are about what the module SAYS rather than does. */
const readLiftSource = (): string => readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'Core', 'Lift.ts'), 'utf8',
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

  it('is refused on the FRESNEL zone only, naming the tool that zone already has', () => {
    // INVERTED THREE TIMES, and each inversion moved the LITERAL while the rule stood still. The
    // foreground zone used to refuse `Lift` and name `BlendMode: PlusLighter`; the foreground zone IS
    // that surface now. The TEXT zone joined it. On 2026-09-22 the BORDER zone joined it too, once the
    // glass rim's composite learned to ADD what it already gathered instead of mixing toward white.
    // The rule the original assertion protects -- "a zone that cannot do this names the tool that
    // can" -- is unchanged and is now pinned on the ONE zone left, the Fresnel.
    expect(ParseFilter('Lift(18)', 'foreground').Lift).toBeCloseTo(18 / 255, 12);
    expect(ParseFilter('Lift(18)', 'text').Lift).toBeCloseTo(18 / 255, 12);
    expect(ParseFilter('Lift(18)', 'border').Lift).toBeCloseTo(18 / 255, 12);
    expect(() => ParseFilter('Lift(18)', 'fresnel')).toThrow(/BorderFresnelFilter takes Brightness and Saturate only/);
    expect(() => ParseFilter('Lift(300)')).toThrow(/signed amount of 255/);
  });

  it('names what could not carry it when the FRESNEL refuses it, not the old hand-wave', () => {
    // The rule: a refusal has to say what could not carry the value, or the next author re-files it
    // as a bug. The message that shipped said "a stroke has no backdrop of its own to add to", which
    // was written when a lift only meant a shape draw and was not the real reason.
    //
    // THREE ASSERTIONS LEFT THIS TEST AND EVERY ONE IS ACCOUNTED FOR. `/same fragment as the fill/`
    // (one draw, one blend state) and `/borders-only element/` (what works instead) both moved to
    // `Jaui._refuseRimLift`, which is where the material is known and where a FLAT stroke is still
    // refused for exactly that reason -- Rim.Lift.test.ts pins both. `/three scalars/` was retired
    // with its claim: the glass rim's grade genuinely cannot carry a per-channel offset, which is why
    // the lift does not ride the grade at all but replaces the mix at the composite line, one step
    // later. What is pinned here is the Fresnel's own reason, which is not about a draw.
    let msg = '';
    try { ParseFilter('Lift(18)', 'fresnel'); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/normalized to\s+max-channel 1/);  // WHY this zone specifically cannot take one
    expect(msg).toMatch(/denormalizes it/);                // what the offset would do to it
    expect(msg).toMatch(/BorderFilter/);                   // and the property that DOES own it
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

interface Walked { Rec: Rec; Census: LiftCensus; Emits: Jiv[] }

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
    // `...rest` is recorded too, so a test can read the INK SCALE the text zone passed (the 5th of
    // the rest args -- m, clipOffset, clipCount, xformIndex, inkScale). Existing pins read Args[0].
    emits.push(n); rec.Calls.push({ Fn: 'EmitText', Args: [n, ...rest] }); real(n, ...rest);
  };
  c.RenderHeadless(1000);
  const g = globalThis as unknown as { __jauiLift: () => LiftCensus };
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

describe('Filter: Lift() makes the element\'s own paint ADD, one draw at a time', () => {
  it('the ink blend wraps the element\'s panel AND its text', () => {
    const w = walk('', (root) => root.AddChild(wash({ Filter: 'Lift(18)', Background: 'rgba(255,200,120,0.6)' })));
    // The additive SHAPE draw (LiftAdd), then the panel and the text, each in a batch of its own
    // because the blend state is per draw.
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend');
    expect(sets.map((c) => c.Args[0])).toEqual(['LiftAdd', 'PlusLighter', 'PlusLighter']);
    expect(fns(w.Rec).filter((f) => f === 'RestoreBlend').length).toBe(3);
  });

  it('a NEGATIVE foreground amount takes PlusDarker: the element paint SUBTRACTS', () => {
    const w = walk('', (root) => root.AddChild(wash({ Filter: 'Lift(-20)', Background: 'rgba(255,200,120,0.6)' })));
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend').map((c) => c.Args[0]);
    expect(sets).toEqual(['LiftSubtract', 'PlusDarker', 'PlusDarker']);
  });

  it('backdrop AND foreground on one element: the shape draw lands first, then the element adds onto it', () => {
    const w = walk('', (root) => root.AddChild(wash({
      Filter: 'Lift(18)', BackdropFilter: 'Lift(18)', Background: 'rgba(255,200,120,0.6)',
    })));
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend').map((c) => c.Args[0]);
    expect(sets).toEqual(['LiftAdd', 'PlusLighter', 'PlusLighter']);
    // ONE shape draw, not two: the backdrop zone's is the one emitted when both are authored,
    // because two would double the offset.
    expect(w.Census.Under).toBe(1);
  });

  it('an AUTHORED foreground lift refuses what it cannot reach whole, by name', () => {
    expect(() => walk('', (root) => root.AddChild(wash({ Filter: 'Lift(18)', BackdropFilter: 'Brightness(1.2)' }))))
      .toThrow(/samples its backdrop/);
    expect(() => walk('', (root) => root.AddChild(wash({ Filter: 'Lift(18)', Thickness: '4' })))).toThrow(/material/);
  });

  it('BlendMode is GONE from the authoring surface, not deprecated', () => {
    // It was the surface for PlusLighter and Screen. `Filter: Lift()` is that surface now, so the
    // property, its type and both of its values LEFT. A style that still sets it is an unknown
    // property, which is what any other misspelling is -- not a shim, not a warning.
    expect(Object.prototype.hasOwnProperty.call(DefaultJivStyle, 'BlendMode')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(DefaultJivStyle, 'Lift')).toBe(true);
    expect(DefaultJivStyle.Lift).toBe('Inherit');
  });
});

describe('the blend states, as the renderer sets them and as GL defines them', () => {
  const body = arrowBody(readRenderer(), 'SetCompositeBlend');

  it('each mode sets both halves of the equation and both halves of the factors', () => {
    expect(body).toContain("case 'LiftAdd':\n        gl.blendEquation(gl.FUNC_ADD);\n        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);");
    expect(body).toContain("case 'LiftSubtract':\n        gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD);\n        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);");
    expect(body).toContain("case 'PlusLighter':\n        gl.blendEquation(gl.FUNC_ADD);\n        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);");
    expect(body).toContain("case 'PlusDarker':\n        gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD);\n        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);");
    // `SRC_ALPHA` AND NOT `ONE`, on every one of the four. This is the load-bearing half of the
    // premultiplication reasoning and it OUTLIVED Screen: the panel and text programs write straight
    // alpha, so SRC_ALPHA is what makes a half-covered edge add half. Given a premultiplied source it
    // would be scaled by coverage twice and every antialiased edge would come out thin (a-squared
    // instead of a).
    expect(body.match(/gl\.SRC_ALPHA, gl\.ONE,/g)?.length).toBe(4);
    expect(body).not.toContain('gl.blendFuncSeparate(gl.ONE,');
    const restore = arrowBody(readRenderer(), 'RestoreBlend');
    expect(restore).toContain('gl.blendEquation(gl.FUNC_ADD);');
    expect(restore).toContain('this.EnableBlend();');
  });

  it('PlusLighter at SRC_ALPHA scales by coverage: a half-covered edge adds half', () => {
    const add = (dst: number, src: number, a: number): number => Math.min(1, dst + src * a);
    expect(add(0.2, 0.6, 0.5)).toBeCloseTo(0.5, 12);
    expect(add(0.2, 0.6, 1)).toBeCloseTo(0.8, 12);
  });

  it('the premultiplying uniform is GONE, and nothing is left setting it', () => {
    // The INVERSE of the pin it replaces. `u_PremulOut` existed for exactly one blend state --
    // Screen, whose destination factor `1 - src*a` is a product no blend factor forms -- and Screen
    // left with `BlendMode`. A uniform no draw can ever set is dead weight in the program this
    // project measured as REGISTER-BOUND, so it left too. Its reasoning is kept in Core/Lift.ts's
    // header, because it is why the four surviving states are correct.
    expect(PANEL_FRAG).not.toContain('uniform float u_PremulOut;');
    expect(PANEL_FRAG).not.toContain('u_PremulOut > 0.5');
    expect(readRenderer()).not.toContain('gl.uniform1f(locs.premulOut');
    expect(readRenderer()).not.toContain("gl.getUniformLocation(p, 'u_PremulOut')");
  });

  it('the under-draw is emitted before the node\'s own branch, so nothing of the element precedes it', () => {
    const walkSrc = readJaui();
    const lift = walkSrc.indexOf('emitLiftUnder(node, shape, eff');
    const chain = walkSrc.indexOf("} else if (material === 'ProgressiveBlur' && this._pblurOn(node)) {");
    expect(lift).toBeGreaterThan(0);
    expect(lift).toBeLessThan(chain);
  });
});

// == 6. THE ADDITIVE COLOR: A COLOR TIMES A SIGNED AMOUNT ========================================

describe('Lift(<color>, <amount>) is a color times a signed amount', () => {
  it('BYTE-IDENTITY: Lift(18) IS Lift(rgb(255,255,255), 18) -- the whole back-compatibility story', () => {
    // Every site that shipped wears the one-argument spelling. If these two are not the same bits,
    // the measured wash constants move, which the brief forbids outright. So this is pinned at three
    // levels: the parse, the resolve, and the packed instance float.
    const one = ParseFilter('Lift(18)');
    const two = ParseFilter('Lift(rgb(255, 255, 255), 18)');
    expect(two.Lift).toBe(one.Lift);
    expect(one.LiftColor).toBe(null);       // null IS white: no color is allocated
    expect(two.LiftColor).toBe('rgb(255, 255, 255)');

    const rs1 = ResolveStyle({ ...DefaultJivStyle, BackdropFilter: 'Lift(18)' }, SEED_CONTEXT);
    const rs2 = ResolveStyle({ ...DefaultJivStyle, BackdropFilter: 'Lift(rgb(255,255,255), 18)' }, SEED_CONTEXT);
    expect(rs2.BackdropLift).toBe(rs1.BackdropLift);
    expect(rs1.BackdropLiftColor).toEqual({ R: 1, G: 1, B: 1, A: 1 });
    expect(rs2.BackdropLiftColor).toEqual(rs1.BackdropLiftColor);

    // The packed instance: the fill lanes are |n| * color, and |n| * 1 === |n|.
    const push = (style: Record<string, string>): Float32Array => {
      const n = wash(style);
      const root = new Jiv({ ChildLayout: placed(0, 0, 400, 300), Style: { Background: TRANSPARENT } });
      root.AddChild(n);
      const b = new JivInstanceBuffer();
      b.Begin();
      b.Push(n, 1, undefined, 0, 0, -1, 'LiftOnly');
      return b.Data.slice(0, JIV_FLOATS_PER_INSTANCE);
    };
    const a = push({ BackdropFilter: 'Lift(18)' });
    const b = push({ BackdropFilter: 'Lift(rgb(255,255,255), 18)' });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('the amount is in 0-255 units in EVERY spelling, so one wash var reads the same in all three', () => {
    // The brief asserted @JwiftWashLift was `18 / 255 * @Dark ...` and that the two-argument amount
    // was therefore a FRACTION. It is not: the shipped var is `18 * @Dark - 12 * @Light`, in 255
    // units. One convention everywhere is what lets the same var be dropped into any of the three
    // zones with no edit and no seam.
    const vars = new Map([['W', '18 * @Dark - 12 * @Light'], ['Dark', '1'], ['Light', '0']]);
    const ctx = { ...SEED_CONTEXT, Vars: vars };
    expect(ResolveStyle({ ...DefaultJivStyle, BackdropFilter: 'Lift(@W)' }, ctx).BackdropLift)
      .toBeCloseTo(18 / 255, 12);
    expect(ResolveStyle({ ...DefaultJivStyle, BackdropFilter: 'Lift(rgb(255,255,255), @W)' }, ctx).BackdropLift)
      .toBeCloseTo(18 / 255, 12);
    expect(ResolveStyle({ ...DefaultJivStyle, Filter: 'Lift(rgb(255,255,255), @W)' }, ctx).ForegroundLift)
      .toBeCloseTo(18 / 255, 12);
    const d = ResolveStyle({ ...DefaultJivStyle, Lift: 'rgb(255,255,255) @W' }, ctx).LiftDeclaration;
    expect((d as LiftValue).Amount).toBeCloseTo(18 / 255, 12);
  });

  it('A NESTED COLOR ARGUMENT SURVIVES THE SCAN -- the defect the old regex had', () => {
    // `/([A-Za-z]+)\s*\(([^)]*)\)/g` stops at the FIRST `)`, so it read `Lift(rgb(255,220,180), 18)`
    // as `Lift(rgb(255,220,180)` and then found no second function: the AMOUNT vanished and the lift
    // silently became 0. Nothing caught it, because a dropped argument is not a parse error. This is
    // the assertion that would have.
    const f = ParseFilter('Lift(rgb(255, 220, 180), 18)');
    expect(f.Lift).toBeCloseTo(18 / 255, 12);
    expect(f.LiftColor).toBe('rgb(255, 220, 180)');
    // And beside another function, in either order.
    expect(ParseFilter('Brightness(1.2) Lift(rgb(255,220,180), 30)').Lift).toBeCloseTo(30 / 255, 12);
    expect(ParseFilter('Lift(rgb(255,220,180), 30) Brightness(1.2)').Brightness).toBe(1.2);
    // A var inside the amount of a two-argument lift resolves too -- the resolver's own regex had
    // the identical `[^()]*` defect and matched nothing at all.
    const vars = new Map([['W', '29'], ['Dark', '1'], ['Light', '0']]);
    const rs = ResolveStyle(
      { ...DefaultJivStyle, BackdropFilter: 'Lift(rgb(255,220,180), @W)' }, { ...SEED_CONTEXT, Vars: vars },
    );
    expect(rs.BackdropLift).toBeCloseTo(29 / 255, 12);
    expect(rs.BackdropLiftColor.G).toBeCloseTo(220 / 255, 6);
  });

  it('a chromatic lift fills the shape with |n| * color, per channel', () => {
    let node!: Jiv;
    const w = walk('', (root) => {
      node = wash({ BackdropFilter: 'Lift(rgb(255, 128, 0), 30)' });
      root.AddChild(node);
    });
    const set = fns(w.Rec).indexOf('SetCompositeBlend');
    const batchIdx = w.Rec.Calls.slice(0, set + 2).filter((c) => c.Fn === 'PanelDrawBatch').length - 1;
    const d = w.Rec.Batches[batchIdx][0];
    const l = 30 / 255;
    expect(d[12]).toBeCloseTo(l * 1, 6);
    expect(d[13]).toBeCloseTo(l * (128 / 255), 6);
    expect(d[14]).toBeCloseTo(l * 0, 6);
    expect(d[15]).toBe(1);
  });

  it('there is no Sink: the negative is the amount sign, and it is the same var', () => {
    const vars = new Map([['W', '18 * @Dark - 12 * @Light']]);
    const dark = ResolveStyle({ ...DefaultJivStyle, BackdropFilter: 'Lift(@W)' },
      { ...SEED_CONTEXT, Vars: new Map([...vars, ['Dark', '1'], ['Light', '0']]) });
    const light = ResolveStyle({ ...DefaultJivStyle, BackdropFilter: 'Lift(@W)' },
      { ...SEED_CONTEXT, Vars: new Map([...vars, ['Dark', '0'], ['Light', '1']]) });
    expect(dark.BackdropLift).toBeGreaterThan(0);
    expect(light.BackdropLift).toBeLessThan(0);
  });

  it('greyness is judged at one 8-bit step, so #fff and rgb(255,255,255) are both grey', () => {
    expect(LiftIsGray({ R: 1, G: 1, B: 1, Amount: 0.1 })).toBe(true);
    expect(LiftIsGray({ R: 1, G: 254 / 255, B: 1, Amount: 0.1 })).toBe(true);
    expect(LiftIsGray({ R: 1, G: 250 / 255, B: 1, Amount: 0.1 })).toBe(false);
    // Amount 0 is gray whatever the color: there is nothing to carry.
    expect(LiftIsGray({ R: 1, G: 0, B: 0, Amount: 0 })).toBe(true);
  });

  it('refuses a third argument, and an unbalanced parenthesis, rather than dropping it', () => {
    expect(() => ParseFilter('Lift(rgb(1,2,3), 18, 4)')).toThrow(/takes <amount> or <color>, <amount>/);
    expect(() => ParseFilter('Lift(rgb(1,2,3, 18)')).toThrow(/unbalanced parenthesis/);
  });
});

// == 7. THE CASCADE ==============================================================================

describe('the cascade carries a VALUE, like color, and Isolate is the barrier', () => {
  const V: LiftValue = { R: 1, G: 1, B: 1, Amount: 0.1 };
  const W: LiftValue = { R: 1, G: 0.5, B: 0, Amount: 0.2 };

  it('CascadeLift: the full truth table, in one place', () => {
    // not authored, no ancestor -> nothing
    expect(CascadeLift('Inherit', null, false, false))
      .toEqual({ Self: null, Authored: false, ToChildren: null });
    // not authored, an ancestor has one -> INHERITED, and it keeps travelling
    expect(CascadeLift('Inherit', V, false, false))
      .toEqual({ Self: V, Authored: false, ToChildren: V });
    // authored here -> AUTHORED (this node emits the shape draw), and it travels
    expect(CascadeLift(W, V, false, false))
      .toEqual({ Self: W, Authored: true, ToChildren: W });
    // `Lift: None` -> the reset, per node AND its subtree
    expect(CascadeLift('None', V, false, false))
      .toEqual({ Self: null, Authored: false, ToChildren: null });
    // Isolate -> the value neither ARRIVES...
    expect(CascadeLift('Inherit', V, false, true))
      .toEqual({ Self: null, Authored: false, ToChildren: null });
    // ...nor LEAVES: an isolated node's own authored lift applies to itself and stops
    expect(CascadeLift(W, V, false, true))
      .toEqual({ Self: W, Authored: true, ToChildren: null });
    // the Root is a base, like _cascadeFilterGrade's
    expect(CascadeLift('Inherit', V, true, false))
      .toEqual({ Self: null, Authored: false, ToChildren: null });
  });

  const tree = (containerStyle: Record<string, string>, childStyle: Record<string, string> = {}): Walked =>
    walk('', (root) => {
      const host = new Jiv({
        ChildLayout: placed(0, 0, 300, 200),
        Style: { Background: TRANSPARENT, Opacity: '1', ...containerStyle },
      });
      host.AddChild(wash(childStyle));
      root.AddChild(host);
    });

  it('a container with Lift: its OWN backdrop lifts ONCE, and the child INHERITS ink only', () => {
    const w = tree({ Lift: 'rgb(255,255,255) 30' });
    // ONE shape draw for the whole subtree: the container's. Cascading the shape draw would lift
    // the same pixels once per descendant, which is the one variant to argue against.
    expect(w.Census.Under).toBe(1);
    expect(w.Census.Authored).toBe(1);
    expect(w.Census.Inherited).toBe(1);
    // The container's own ink adds, AND the child's does: additive STACKS.
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend').map((c) => c.Args[0]);
    expect(sets[0]).toBe('LiftAdd');
    expect(sets.filter((x) => x === 'PlusLighter').length).toBeGreaterThanOrEqual(1);
  });

  it('Lift: None on the child is the reset -- the color: black override', () => {
    const w = tree({ Lift: 'rgb(255,255,255) 30' }, { Lift: 'None' });
    expect(w.Census.Authored).toBe(1);
    expect(w.Census.Inherited).toBe(0);
  });

  it('Isolate: true on the child is the subtree barrier, and it is the SAME word that stops Filter', () => {
    const w = tree({ Lift: 'rgb(255,255,255) 30' }, { Isolate: 'true' });
    expect(w.Census.Authored).toBe(1);
    expect(w.Census.Inherited).toBe(0);
    // No new vocabulary: this is the property `_cascadeFilterGrade` already reads.
    expect(readJaui()).toContain('const base = node === this.Root || rs.Isolate;');
  });

  it('a GLASS child IGNORES an inherited lift and paints normally, counted as its own key', () => {
    // A cascade that threw the moment it contained one glass child would be unusable, and the author
    // did not put the lift there.
    const w = tree({ Lift: 'rgb(255,255,255) 30' }, { Thickness: '4' });
    expect(w.Census.IgnoredSampling).toBe(1);
    expect(w.Census.Inherited).toBe(0);
    expect(w.Census.Authored).toBe(1);
  });

  it('an AUTHORED lift on a glass node still refuses BY NAME -- that is an author error', () => {
    expect(() => tree({}, { Lift: 'rgb(255,255,255) 30', Thickness: '4' })).toThrow(/material is LiquidGlass/);
  });

  it('the cascade costs one walk, and the census says how much of it carried anything', () => {
    const w = tree({ Lift: 'rgb(255,255,255) 30' });
    // Root + host + child, and every one of them visited exactly once.
    expect(w.Census.CascadeVisited).toBe(3);
    expect(w.Census.CascadeCarried).toBe(2);   // host + child; the Root is a base
    const none = tree({});
    expect(none.Census.CascadeVisited).toBe(3);
    expect(none.Census.CascadeCarried).toBe(0);
  });

  it('NO TARGET, NO PASS, NO COPY: the cascade is one more field on the walk that already runs', () => {
    const w = tree({ Lift: 'rgb(255,255,255) 30' });
    expect(fns(w.Rec)).not.toContain('SnapshotScreen');
    expect(fns(w.Rec)).not.toContain('ComputeBlur');
    expect(w.Census.Builds).toBe(0);
    // The walk is shaped like the two beside it, and is called beside them.
    expect(readJaui()).toContain('this._cascadeLift(this.Root, null);');
  });

  it('A CHROMATIC lift that must FOLD refuses by name -- the scalar grade cannot carry chroma', () => {
    expect(() => walk('', (root) => root.AddChild(wash({
      BackdropFilter: 'Brightness(1.2) Lift(rgb(255, 220, 180), 30)',
    })))).toThrow(/is CHROMATIC/);
    // A GRAY lift in the same place folds exactly as it always did.
    const gray = walk('', (root) => root.AddChild(wash({ BackdropFilter: 'Brightness(1.2) Lift(30)' })));
    expect(gray.Census.Refused).toEqual({ Grade: 1 });
  });

  it('a chromatic lift in the FOREGROUND zone works: that zone never folds', () => {
    const w = walk('', (root) => root.AddChild(wash({ Filter: 'Lift(rgb(255, 220, 180), 30)' })));
    expect(w.Census.Under).toBe(1);
    expect(w.Census.Graded).toBe(0);
    expect(w.Census.Refused).toEqual({});
  });

  it('THE LAYER CACHE READS THE CASCADE, not the node style -- the quiet way to lose a backdrop', () => {
    // An inherited lift is not in RenderStyle at all. A style-only check would let a cached subtree
    // capture into a CLEARED target, where the lift adds onto nothing and silently vanishes.
    const src = arrowBody(readJaui(), '_subtreeSamplesLiveScene');
    expect(src).toContain('LiftTouchesInk(s, node.EffectiveLift)');
    expect(src).not.toContain("s.BlendMode !== 'Normal'");
    // And the predicate itself reads BOTH halves: the cascade result (the only place an inherited
    // lift appears) and the node's own declaration (available even before the cascade has run).
    const lift = readLiftSource();
    const pred = lift.slice(lift.indexOf('export const LiftTouchesInk'), lift.indexOf('/** Null when the lift can be drawn'));
    expect(pred).toContain('effective !== null');
    expect(pred).toContain('rs.LiftDeclaration');
    expect(pred).toContain('rs.ForegroundLift');
  });

  it('ONE INSTRUMENT: the gate line is formatted from the census the probe returns', () => {
    const w = tree({ Lift: 'rgb(255,255,255) 30' });
    const line = LiftGateLine(w.Census);
    expect(line).toContain(`authored=${w.Census.Authored}`);
    expect(line).toContain(`inherited=${w.Census.Inherited}`);
    expect(line).toContain(`ignoredSampling=${w.Census.IgnoredSampling}`);
    expect(line).toContain(`liftBuilds=${w.Census.Builds}`);
    expect(line).toContain(`cascadeVisited=${w.Census.CascadeVisited}`);
    expect(line).toContain(`cascadeCarried=${w.Census.CascadeCarried}`);
    expect(line).toContain(`blends=${w.Census.Blends}`);
    // And the engine prints that exact function's output, so the two cannot drift apart again.
    expect(readJaui()).toContain('const line = LiftGateLine(this._liftCensus());');
  });

  it('an idle tree reads 0 authored and 0 inherited -- the attributable half of the gate', () => {
    const w = tree({});
    expect(w.Census.Authored).toBe(0);
    expect(w.Census.Inherited).toBe(0);
    expect(w.Census.IgnoredSampling).toBe(0);
    expect(w.Census.Under + w.Census.Graded).toBe(0);
    expect(w.Census.Blends).toBe(0);
    expect(fns(w.Rec)).not.toContain('SetCompositeBlend');
  });
});

// ── 7. THE INK ZONE: `TextFilter: Lift(n)` ─────────────────────────────────────────────────────
//
// The capability the other four zones cannot express: ONLY the ink adds. An element's fill, border
// and shadow are one fragment, so `Filter: Lift()` moves all of them together; the text is the one
// part already drawn separately, so it is the one part that can be separated.

describe('TextFilter is the fifth zone, and it takes Lift() and nothing else', () => {
  it('parses the one-argument form in the same 0-255 units as every other zone', () => {
    expect(ParseFilter('Lift(30)', 'text').Lift).toBeCloseTo(30 / 255, 12);
    expect(ParseFilter('Lift(-20)', 'text').Lift).toBeCloseTo(-20 / 255, 12);
    expect(ParseFilter('None', 'text').Lift).toBe(0);
    // ONE convention. The same string means the same amount in all three accepting zones.
    expect(ParseFilter('Lift(30)', 'text').Lift).toBe(ParseFilter('Lift(30)', 'backdrop').Lift);
    expect(ParseFilter('Lift(30)', 'text').Lift).toBe(ParseFilter('Lift(30)', 'foreground').Lift);
  });

  it('REFUSES the two-argument form, naming Color as the property that owns the ink', () => {
    // The rule: an argument that would mean something DIFFERENT in this zone than in the others is
    // refused, not quietly reinterpreted. In the shape zones the color IS the source; on ink it
    // could only multiply the glyph's own color.
    let msg = '';
    try { ParseFilter('Lift(rgb(255, 220, 180), 30)', 'text'); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/takes <amount> only/);
    expect(msg).toMatch(/Color/);
    expect(msg).toMatch(/channel by channel/);
    // ...while the two zones that have no color of their own still take it.
    expect(ParseFilter('Lift(rgb(255, 220, 180), 30)', 'backdrop').LiftColor).toBe('rgb(255, 220, 180)');
    expect(ParseFilter('Lift(rgb(255, 220, 180), 30)', 'foreground').LiftColor).toBe('rgb(255, 220, 180)');
  });

  it('REFUSES the grade functions and every blur, each naming what does own it', () => {
    for (const fn of ['Brightness(1.2)', 'Saturate(1.2)', 'Contrast(1.2)']) {
      expect(() => ParseFilter(fn, 'text')).toThrow(/TextFilter takes Lift\(\) only/);
      expect(() => ParseFilter(fn, 'text')).toThrow(/Author the grade on Filter/);
    }
    for (const fn of ['Blur(4pt)', 'LinearProgressiveBlur(Top, 8pt)', 'EdgeProgressiveBlur(8pt)']) {
      expect(() => ParseFilter(fn, 'text')).toThrow(/no ink-only blur pass/);
    }
    expect(() => ParseFilter('Sharpen(2)', 'text')).toThrow(/TextFilter takes Lift\(\) only/);
  });

  it('has its OWN parse cache, so a string the foreground cached cannot answer for it', () => {
    // The trap this closes: `Brightness(1.1)` is legal on the foreground and illegal on the ink. A
    // shared cache would hand the foreground's parse back and the refusal would never fire.
    expect(ParseFilter('Brightness(1.1)', 'foreground').Brightness).toBeCloseTo(1.1, 12);
    expect(() => ParseFilter('Brightness(1.1)', 'text')).toThrow(/TextFilter takes Lift\(\) only/);
    // ...and in the other order, so the test is not passing by cache-fill accident.
    expect(() => ParseFilter('Saturate(1.3)', 'text')).toThrow(/TextFilter takes Lift\(\) only/);
    expect(ParseFilter('Saturate(1.3)', 'foreground').Saturation).toBeCloseTo(1.3, 12);
  });

  it('merges by function like its four siblings, because it is a FILTER_PROP on JivStyle', () => {
    // Not decoration: merge-by-function only happens in the `Style` slot, so this is the observable
    // consequence of putting `TextFilter` on JivStyle rather than beside `Color` on TextStyle.
    expect(FILTER_PROPS as readonly string[]).toContain('TextFilter');
    expect(ParseFilter('Lift(18) Lift(30)', 'text').Lift).toBeCloseTo(30 / 255, 12);
    const merged = MergeFilterValue('Lift(18)', 'Lift(30)');
    expect(ParseFilter(merged, 'text').Lift).toBeCloseTo(30 / 255, 12);
  });

  it('resolves onto TextLift, and takes a bare var so it flips with the theme in one line', () => {
    const rs = ResolveStyle({ ...DefaultJivStyle, TextFilter: 'Lift(30)' }, SEED_CONTEXT);
    expect(rs.TextLift).toBeCloseTo(30 / 255, 12);
    expect(ResolveStyle({ ...DefaultJivStyle }, SEED_CONTEXT).TextLift).toBe(0);

    const vars = new Map([['Glow', '30 * @Dark - 20 * @Light'], ['Dark', '1'], ['Light', '0']]);
    const dark = ResolveStyle({ ...DefaultJivStyle, TextFilter: 'Lift(@Glow)' }, { ...SEED_CONTEXT, Vars: vars });
    expect(dark.TextLift).toBeCloseTo(30 / 255, 12);
    const light = ResolveStyle({ ...DefaultJivStyle, TextFilter: 'Lift(@Glow)' },
      { ...SEED_CONTEXT, Vars: new Map([...vars, ['Dark', '0'], ['Light', '1']]) });
    expect(light.TextLift).toBeCloseTo(-20 / 255, 12);
  });

  it('leaves the FILL, the BORDER and the SHADOW amounts untouched -- the whole deliverable', () => {
    const rs = ResolveStyle({ ...DefaultJivStyle, TextFilter: 'Lift(30)' }, SEED_CONTEXT);
    expect(rs.ForegroundLift).toBe(0);          // the fill does not add
    expect(rs.BackdropLift).toBe(0);            // nothing lifts the backdrop
    expect(rs.LiftDeclaration).toBe('Inherit'); // nothing cascades
    expect(rs.Brightness).toBe(1);              // and no grade was smuggled in
    expect(rs.Saturation).toBe(1);
    expect(rs.Contrast).toBe(1);
  });
});

describe('the ink zone at the DRAW: only the text batch blends', () => {
  it('sets PlusLighter around the TEXT draw and leaves the panel batch alone', () => {
    const w = walk('', (root) => {
      root.AddChild(wash({ TextFilter: 'Lift(30)', Background: 'rgb(40, 40, 40)' }));
    });
    const f = fns(w.Rec);
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend');
    expect(sets.length).toBe(1);
    expect(sets[0].Args[0]).toBe('PlusLighter');
    // The composite blend is set AFTER the text is emitted, which is what makes it the INK's blend
    // and not the panel's. NOTE: `TextDrawBatch` is unobservable in this harness -- the glyph atlas
    // is null without a real GL texture, so `flushText` returns before drawing. What IS observable
    // is that NO PANEL draw falls inside the blend, which is the actual claim: the fill kept
    // covering while the ink added.
    const set = f.indexOf('SetCompositeBlend');
    const restore = f.indexOf('RestoreBlend');
    expect(f.indexOf('EmitText')).toBeLessThan(set);
    expect(restore).toBeGreaterThan(set);
    expect(f.slice(set, restore)).not.toContain('PanelDrawBatch');
    // NO shape draw: this zone draws nothing of its own.
    expect(w.Census.Under).toBe(0);
    expect(w.Census.Graded).toBe(0);
    expect(w.Census.Authored).toBe(0);
    expect(w.Census.Inherited).toBe(0);
    expect(w.Census.Builds).toBe(0);
    expect(w.Census.TextInk).toBe(1);
  });

  it('a negative amount subtracts, so the theme flip lives in the sign here too', () => {
    const w = walk('', (root) => { root.AddChild(wash({ TextFilter: 'Lift(-20)' })); });
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend').map((c) => c.Args[0]);
    expect(sets).toEqual(['PlusDarker']);
    expect(w.Census.TextInk).toBe(1);
  });

  it('passes |amount| as the ink SCALE, and RGB-only is what keeps the edge linear', () => {
    const w = walk('', (root) => { root.AddChild(wash({ TextFilter: 'Lift(30)' })); });
    const emit = w.Rec.Calls.find((c) => c.Fn === 'EmitText');
    // Args are [node, m, clipOffset, clipCount, xformIndex, inkScale].
    expect(emit!.Args[5]).toBeCloseTo(30 / 255, 12);
    const neg = walk('', (root) => { root.AddChild(wash({ TextFilter: 'Lift(-30)' })); });
    // The SIGN is spent on the blend equation, so the scale is the MAGNITUDE. A negative scale would
    // subtract twice over and give back the positive picture.
    expect(neg.Rec.Calls.find((c) => c.Fn === 'EmitText')!.Args[5]).toBeCloseTo(30 / 255, 12);
  });

  it('passes scale 1 when there is no text lift, so every pre-existing path is byte-identical', () => {
    const plain = walk('', (root) => { root.AddChild(wash({})); });
    expect(plain.Rec.Calls.find((c) => c.Fn === 'EmitText')!.Args[5]).toBe(1);
    // ...including the element-wide ink lift, whose ink still adds at its own FULL color.
    const fg = walk('', (root) => { root.AddChild(wash({ Filter: 'Lift(30)' })); });
    expect(fg.Rec.Calls.find((c) => c.Fn === 'EmitText')!.Args[5]).toBe(1);
  });

  it('the null arm zeroes it: ?lift=off draws no blend and reads textInk=0', () => {
    const w = walk('?lift=off', (root) => { root.AddChild(wash({ TextFilter: 'Lift(30)' })); });
    expect(fns(w.Rec)).not.toContain('SetCompositeBlend');
    expect(w.Census.TextInk).toBe(0);
    expect(w.Census.Armed).toBe('off');
  });

  it('an element with a TextFilter but NO text reads textInk=0 -- counted where it DREW', () => {
    // The census must not credit a zone that painted nothing, or it cannot be used as evidence.
    const w = walk('', (root) => {
      root.AddChild(new Jiv({
        ChildLayout: placed(20, 20, 160, 40),
        Style: { Background: 'rgb(40, 40, 40)', TextFilter: 'Lift(30)' },
      }));
    });
    expect(w.Census.TextInk).toBe(0);
    expect(fns(w.Rec)).not.toContain('SetCompositeBlend');
  });
});

describe('the ink zone does NOT cascade -- it sits where Color sits', () => {
  it('a TextFilter on a container does not reach a child text element', () => {
    // I walked into this myself writing the gallery row: `TextFilter` is a per-element zone like its
    // four siblings, NOT the inherited `Lift:` property. A container with no text of its own and a
    // TextFilter therefore blends NOTHING, and the child's glyphs keep covering. That is the correct
    // behavior -- it is where `Color` lives too -- but it is worth a pin, because the failure mode is
    // a silent no-op and this row of the gallery was authored wrong the first time.
    const w = walk('', (root) => {
      const container = new Jiv({
        ChildLayout: placed(0, 0, 300, 200),
        Style: { Background: 'rgb(0,0,0)', TextFilter: 'Lift(30)' },
      });
      container.AddChild(wash({}, 'child'));
      root.AddChild(container);
    });
    expect(fns(w.Rec)).not.toContain('SetCompositeBlend');
    expect(w.Census.TextInk).toBe(0);
    // ...and authored on the CHILD, the same tree blends.
    const ok = walk('', (root) => {
      const container = new Jiv({ ChildLayout: placed(0, 0, 300, 200), Style: { Background: 'rgb(0,0,0)' } });
      container.AddChild(wash({ TextFilter: 'Lift(30)' }, 'child'));
      root.AddChild(container);
    });
    expect(ok.Census.TextInk).toBe(1);
  });

  it('the inherited Lift: property does NOT set the ink scale -- only TextFilter does', () => {
    // The cascade makes a descendant's ink ADD (blend), but at its own full color: the amount there
    // is spent on the container's shape draw. Only the text zone scales the ink.
    const w = walk('', (root) => {
      const container = new Jiv({ ChildLayout: placed(0, 0, 300, 200), Style: { Lift: 'rgb(255,255,255) 30' } });
      container.AddChild(wash({}, 'child'));
      root.AddChild(container);
    });
    expect(w.Census.Inherited).toBeGreaterThan(0);
    const emit = w.Rec.Calls.find((c) => c.Fn === 'EmitText');
    expect(emit!.Args[5]).toBe(1);
  });
});

describe('the ink zone WORKS ON GLASS, which is why it exists', () => {
  it('a glass surface honors TextFilter while an authored Filter: Lift() on it throws', () => {
    // An authored foreground lift is refused on glass because the element's own paint cannot be
    // reached whole. Its TEXT is not in that draw at all -- separate batch, separate atlas, after
    // the material has committed -- so the ink zone is not subject to that refusal.
    expect(() => walk('', (root) => {
      root.AddChild(wash({ Thickness: '8', Filter: 'Lift(30)' }));
    })).toThrow(/cannot be reached whole/);

    const w = walk('', (root) => { root.AddChild(wash({ Thickness: '8', TextFilter: 'Lift(30)' })); });
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend').map((c) => c.Args[0]);
    expect(sets).toEqual(['PlusLighter']);
    expect(w.Census.TextInk).toBe(1);
    expect(w.Census.IgnoredSampling).toBe(0);   // nothing was dropped: it was never refused
    expect(w.Census.Refused).toEqual({});
  });

  it('a glass child inside an additive cascade keeps its own TextFilter while ignoring the cascade', () => {
    const w = walk('', (root) => {
      const container = new Jiv({ ChildLayout: placed(0, 0, 300, 200), Style: { Lift: 'rgb(255,255,255) 30' } });
      container.AddChild(wash({ Thickness: '8', TextFilter: 'Lift(30)' }));
      root.AddChild(container);
    });
    // The inherited lift is dropped by the glass child (soft refusal, counted)...
    expect(w.Census.IgnoredSampling).toBe(1);
    // ...and its OWN ink zone still fires.
    expect(w.Census.TextInk).toBe(1);
  });
});

describe('the ink zone and the element-wide lift are different draws, so neither refuses the other', () => {
  it('TextFilter wins for the ink; Filter still governs the panel and the shape draw', () => {
    const w = walk('', (root) => {
      root.AddChild(wash({ Filter: 'Lift(30)', TextFilter: 'Lift(-20)', Background: 'rgb(40,40,40)' }));
    });
    const sets = w.Rec.Calls.filter((c) => c.Fn === 'SetCompositeBlend').map((c) => c.Args[0]);
    // Three draws: the shape under-draw (LiftAdd), the panel whose ink adds (PlusLighter), and the
    // text, which took the TEXT zone's sign and subtracts.
    expect(sets).toEqual(['LiftAdd', 'PlusLighter', 'PlusDarker']);
    expect(w.Census.Under).toBe(1);
    expect(w.Census.Authored).toBe(1);
    expect(w.Census.TextInk).toBe(1);
    // And the ink took the TEXT zone's magnitude, not the foreground zone's.
    expect(w.Rec.Calls.find((c) => c.Fn === 'EmitText')!.Args[5]).toBeCloseTo(20 / 255, 12);
  });
});

describe('the ink zone is one instrument with the gate line', () => {
  it('textInk appears in the gate line and equals the census field', () => {
    const w = walk('', (root) => {
      root.AddChild(wash({ TextFilter: 'Lift(30)' }));
      root.AddChild(wash({ TextFilter: 'Lift(30)' }, 'Bb'));
    });
    expect(w.Census.TextInk).toBe(2);
    const line = LiftGateLine(w.Census);
    expect(line).toContain('textInk=2');
    expect(line).toContain(`textInk=${w.Census.TextInk}`);
  });

  it('a lifted ink refuses the empty-panel cull and the layer cache, via LiftTouchesInk', () => {
    // A capture's destination is a CLEARED target, so ink that adds there adds onto nothing. The
    // predicate is deliberately conservative -- it also blocks two levers a text lift would not
    // actually break -- because refusing too rarely is a wrong picture.
    const rs = ResolveStyle({ ...DefaultJivStyle, TextFilter: 'Lift(30)' }, SEED_CONTEXT);
    expect(LiftTouchesInk(rs, null)).toBe(true);
    const plain = ResolveStyle({ ...DefaultJivStyle }, SEED_CONTEXT);
    expect(LiftTouchesInk(plain, null)).toBe(false);
    // ...and the null arm turns it off, like every other half of this feature.
    Lift.Mode = 'off';
    expect(LiftTouchesInk(rs, null)).toBe(false);
  });

  it('the ink scale multiplies the tint lane and never its alpha -- pinned on the source', () => {
    // The `a-squared` trap: the text fragment writes `texel * tint * opacity * clipAlpha` and the
    // blend's source factor is SRC_ALPHA, so the contribution is rgb * a. Scaling rgb keeps a
    // half-covered glyph edge adding half; scaling alpha too would square the coverage.
    const src = readJaui();
    expect(src).toContain('cmd.TintR = w.TintR.Value * inkScale;');
    expect(src).toContain('cmd.TintA = w.TintA.Value;');
    expect(src).not.toContain('cmd.TintA = w.TintA.Value * inkScale');
    expect(src).toContain('cmd3.TintR = w.TintR.Value * inkScale;');
    expect(src).not.toContain('cmd3.TintA = w.TintA.Value * inkScale');
  });
});
