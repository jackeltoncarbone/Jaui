/**
 * `?blur-phased` — the COUNT test.
 *
 * The join (`Perf/XcTrace.Finding.md`) priced `baseline - blur-dummy` on `glass-grid` at 33.45 ms
 * per frame = 25.47 ms more GPU WORK + 7.98 ms GPU IDLE, and found the work to be COUNT rather than
 * per-pass cost: +2 full-canvas-class fragment passes at an unchanged ~5.7 ms each, +38-44 mid-band
 * (~300 us) intervals that are NOT pyramid passes, and hundreds of sub-0.1 ms bubbles. H5: every
 * scene-encoder restart with real content in the target costs its tile load+store plus a fixed
 * bubble, and a CLEARED target's load/store is free. Its test is any change that removes ENCODERS
 * with pixels held constant.
 *
 * So: run the frame in three scene encoders. Bed; every fill pyramid; every fill and its children;
 * every rim pyramid; every rim overlay. Same forty builds, same regions, same radii, same depths,
 * same draws — a different number of encoder ENDS between them.
 *
 * There is no GPU here and no claim about milliseconds. What these tests pin is that the instrument
 * is the instrument: that the flag refuses everything that would make it mean something else, that
 * the phased walk reuses the walk's OWN traversal and the pre-pass's OWN build sites rather than a
 * second copy of either, that the pool is actually able to hold twenty pyramids at once (run
 * through `BlurPass` itself, not asserted), what the frame's counters must read (derived on
 * `Scene.Ledger.ts` itself), and exactly where the pixels may differ (derived from `Perf.jss` and
 * `Jwift.Glass.jss`, so a re-spaced grid or a retuned class moves the prediction rather than
 * silently invalidating it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readRenderer, readJaui, readPerfJss, readJwiftGlass, arrowBody, jssClass, jssNumber, jssBlurPt,
} from './Scene.ReadAfterWrite.Source';
import {
  BlurPass, ChainBytes, MAX_CHAINS, CHAIN_BUDGET_BYTES,
  BaseDownsampleFactor, PyramidDepth, ResolveRegionRect, type BackdropRect,
} from '../src/Core/BlurPass';
import { SceneReadLedger } from '../src/Core/Scene.Ledger';
import { OnJauiTrace } from '../src/Diagnostics/Jaui.Trace';
import { FakeGl } from './Blur.Chains.Source';

const jaui = readJaui();
const renderer = readRenderer();

// ── The scene, read from the sheets that own it ────────────────────────────────────────────────
// `glassshot` shoots `idle`, which is `glass-grid` standing still: the same twenty PerfCards on the
// same PerfGrid over the same six-band bed, at 1280x800 CSS with deviceScaleFactor 2.
const CANVAS_W = 2560;
const CANVAS_H = 1600;
const DPR = 2;

const perf = readPerfJss();
const glass = readJwiftGlass();
const CARD = jssClass(perf, 'PerfCard');
const GLASS = jssClass(glass, 'JwiftGlass');

const CARD_W = jssNumber(CARD, 'Width');            // 216pt
const CARD_H = jssNumber(CARD, 'Height');           // 150pt
const FROST = jssBlurPt(GLASS, 'BackdropFilter');   // 4pt
const THICKNESS = jssNumber(GLASS, 'Thickness');    // 2.5
const REFRACTION = jssNumber(GLASS, 'Refraction');  // 8
const FILLET = jssNumber(GLASS, 'Fillet');          // 0
const CA = jssNumber(GLASS, 'ChromaticAberration'); // 0.25
const BEZEL = jssNumber(GLASS, 'BezelWidth');       // 12
const BORDER_LAYER = jssNumber(GLASS, 'BorderLayer');
const SHADOW_ADAPTIVE = jssNumber(GLASS, 'ShadowAdaptive');

/** PerfGrid: five 216pt columns, 150pt auto rows, 20pt gap, at left 60pt / top 70pt. Twenty cards
 *  in tree order, which is also walk order (every card sits at Layer 0). */
const COLS = 5;
const GAP = 20;
const GRID_LEFT = 60;
const GRID_TOP = 70;

/** `_glassFillBlurPlan`: frost*d + (thickness*d + Fillet*minHalf*0.25*0.7)*Refraction + CA*3 + 8*d. */
const MIN_HALF = Math.min(CARD_W, CARD_H) * DPR * 0.5;
const FILL_MARGIN =
  FROST * DPR + (THICKNESS * DPR + FILLET * MIN_HALF * 0.25 * 0.7) * REFRACTION + CA * 3 + 8 * DPR;
/** `_glassRimBlurPlan`: a border-only fragment makes ONE inward tap, so frost*d + 8*d. */
const RIM_MARGIN = FROST * DPR + 8 * DPR;
const RADIUS = FROST * DPR;

const CardBox = (i: number): BackdropRect => ({
  x: (GRID_LEFT + (i % COLS) * (CARD_W + GAP)) * DPR,
  y: (GRID_TOP + ((i / COLS) | 0) * (CARD_H + GAP)) * DPR,
  w: CARD_W * DPR,
  h: CARD_H * DPR,
});

const RegionFor = (b: BackdropRect, margin: number): BackdropRect => ({
  x: Math.max(0, Math.floor(b.x - margin)),
  y: Math.max(0, Math.floor(b.y - margin)),
  w: Math.min(CANVAS_W, Math.ceil(b.w + margin * 2)),
  h: Math.min(CANVAS_H, Math.ceil(b.h + margin * 2)),
});

/** The level-0 size `Blur` resolves a region to — the pool's own arithmetic, not a copy of it. */
const Level0 = (region: BackdropRect): { W: number; H: number } => {
  const k = BaseDownsampleFactor(RADIUS, CANVAS_W, CANVAS_H, region);
  const depth = PyramidDepth(RADIUS / k, 0);
  const r = ResolveRegionRect(region, CANVAS_W, CANVAS_H, k * (1 << depth));
  return { W: r.W, H: r.H };
};

const Overlaps = (a: BackdropRect, b: BackdropRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// ── The flag arrives, and refuses where it would mean something else ───────────────────────────

describe('?blur-phased — the flag, and its refusals', () => {
  it('parses exact-key and marks itself in Init as DIFFERENT, not WRONG', () => {
    expect(jaui).toContain("params.has('blur-phased')");
    expect(renderer).toContain("JTrace('jaui:blur-phased armed=true pixels=DIFFERENT'");
    // The mark carries the pool it ran under, because a phased arm read under the SHIPPED pool is
    // twenty builds sharing one chain — a different experiment wearing this flag's name.
    const init = renderer.slice(renderer.indexOf('jaui:blur-phased armed=true'), renderer.indexOf('jaui:blur-phased armed=true') + 500);
    expect(init).toContain('chains=');
    expect(init).toContain('max=');
    expect(init).toContain('budget=');
  });

  it('refuses everything that changes WHICH pyramids get built, or WHERE they are built from', () => {
    const body = jaui.slice(jaui.indexOf("params.has('blur-phased')"));
    for (const guard of [
      "!(r instanceof WebGL2Renderer) ? 'webgl2-only'",
      "this._diagNoBlur || r.DiagBlurDummy ? 'no-blur-and-blur-dummy-build-nothing-to-phase'",
      "this._blurFirst ? 'blur-first-already-moved-every-build-ahead-of-the-bed'",
      "r.CardCompositeEnabled ? 'card-composite-builds-from-the-card-target'",
      "this._sharedBackdrop ? 'shared-backdrop-builds-one-pyramid-lazily'",
      "this._layerCacheEnabled ? 'layer-cache-skips-subtrees-the-phased-walk-would-paint'",
    ]) expect(body).toContain(guard);
    expect(body).toContain('JTrace(`jaui:blur-phased armed=false reason=${why}`)');
    expect(body).toContain('this._blurPhased = true;');
  });

  it('is parsed AFTER ?blur-first, which it has to interrogate', () => {
    expect(jaui.indexOf("params.has('blur-first')")).toBeLessThan(jaui.indexOf("params.has('blur-phased')"));
    // And after every other flag the guards read, so none of them reads a default.
    for (const earlier of ["params.has('blur-dummy')", "params.has('layer-cache')",
      "params.has('wkr-shared-backdrop')"]) {
      expect(jaui.indexOf(earlier)).toBeLessThan(jaui.indexOf("params.has('blur-phased')"));
    }
  });

  it('COMPOSES with ?blur-src-*, and says that the pairing is a pure count test', () => {
    const body = jaui.slice(jaui.indexOf("params.has('blur-phased')"));
    // `?blur-src-*` is deliberately NOT a refusal: it holds the source constant, which removes the
    // pixel change entirely and leaves the encoder count as the only variable.
    expect(body).not.toContain('r.DiagBlurSrc === null ?');
    expect(body).toContain('jaui:blur-phased note=blur-src-holds-the-source-constant-so-this-arm-is-a-pure-count-test');
  });

  it('?blur-chains given alongside WINS, so a bigger scene is measured by saying it is bigger', () => {
    const body = jaui.slice(jaui.indexOf("params.has('blur-phased')"));
    expect(body).toContain('if (gl2.DiagBlurChains === null) gl2.DiagBlurChains = PHASED_CHAINS;');
  });
});

// ── One traversal, not two ─────────────────────────────────────────────────────────────────────

describe('?blur-phased — the walk\'s own functions, and the pre-pass\'s own build sites', () => {
  it('adds NO third copy of the two plan resolvers or of the transform composition', () => {
    // The whole fidelity argument, inherited from `?blur-first` and extended: the phased walk runs
    // `renderNode` itself and the phased BUILD runs `_blurFirstNode` itself, so the counts that
    // lane pinned must not move. A third call site would be a third answer to "which pyramid".
    expect((jaui.match(/_glassFillBlurPlan\s*=\s*\(/g) ?? []).length).toBe(1);
    expect((jaui.match(/this\._glassFillBlurPlan\(/g) ?? []).length).toBe(2);
    expect((jaui.match(/_glassRimBlurPlan\s*=\s*\(/g) ?? []).length).toBe(1);
    expect((jaui.match(/this\._glassRimBlurPlan\(/g) ?? []).length).toBe(2);
    expect((jaui.match(/_composeTransform\s*=\s*\(/g) ?? []).length).toBe(1);
    expect((jaui.match(/this\._composeTransform\(/g) ?? []).length).toBe(2);
  });

  it('runs the pre-pass traversal twice, once per SITE, and nothing else about it moves', () => {
    const build = arrowBody(jaui, '_blurPhasedBuild');
    expect(build).toContain('this._prepassSites = site;');
    expect(build).toContain('this._blurFirstNode(this.Root, MAT_IDENTITY, EmptyClipStack, scope, null, null, w, h);');
    expect(build).toContain('this._blurFirstReplay(scope, w, h);');
    expect(build).toContain("this._prepassSites = 'both';");
    // It does NOT rebind the scene: the caller decides when the scene comes back, because a rebind
    // between the builds and the probes would put a bind where the baseline has none.
    expect(build).not.toContain('RebindSceneTarget');
    // The two sites read the selector, and `'both'` (which is `?blur-first`) still builds both.
    expect(arrowBody(jaui, '_blurFirstNode')).toContain("this._prepassSites !== 'rim'");
    expect(arrowBody(jaui, '_blurFirstDescend')).toContain("if (this._prepassSites === 'fill') return;");
  });

  it('takes the recorded handle at BOTH build sites, and a disagreement is still counted', () => {
    expect((jaui.match(/this\._blurFirstStats\.Missed\+\+/g) ?? []).length).toBe(2);
    expect((jaui.match(/this\._blurFirstStats\.Used\+\+/g) ?? []).length).toBe(2);
    expect(jaui).toContain('const preFill = this._blurFirst || this._blurPhased ? this._blurFirstFill.get(node) : undefined;');
    expect(jaui).toContain('const preRim = this._blurFirst || this._blurPhased ? this._blurFirstRim.get(node) : undefined;');
  });

  it('gates the walk through THREE predicates and nothing else', () => {
    // An unflagged frame must take the branches it took before this lane, so every predicate
    // answers the walk's own answer at pass 0 and the walk asks them by name.
    for (const fn of ['_phasedHoldsBack', '_phasedPaints', '_phasedEmitsRim']) {
      expect((jaui.match(new RegExp(`${fn}\\s*=\\s*\\(`, 'g')) ?? []).length).toBe(1);
    }
    expect(arrowBody(jaui, '_phasedPaints')).toContain('default:');
    expect(arrowBody(jaui, '_phasedEmitsRim')).toContain('default: return true;');
    const render = arrowBody(jaui, '_render');
    expect(render).toContain('const phasedPaints = this._phasedPass === 0 || this._phasedPaints(node);');
    expect(render).toContain('if (!this._phasedEmitsRim(overlayGlass)) return;');
    expect(render).toContain('if (this._phasedPass === 1 && this._phasedStop) return;');
  });

  it('runs the five passes in the one order that gives three encoders', () => {
    const render = arrowBody(jaui, '_render');
    const block = render.slice(render.indexOf('if (this._blurPhased && !this._diagNoUi)'));
    const steps = [
      'phase(1);',
      "this._blurPhasedBuild('fill', w, h);",
      'this._phasedShadowProbes(dt);',
      'r.RebindSceneTarget();',
      'phase(2);',
      "this._blurPhasedBuild('rim', w, h);",
      'phase(3);',
    ];
    let at = 0;
    for (const step of steps) {
      const next = block.indexOf(step, at);
      expect(next, step).toBeGreaterThan(-1);
      at = next + step.length;
    }
    // And it restores the unflagged pass before anything after the walk runs.
    expect(block.indexOf('this._phasedPass = 0;')).toBeGreaterThan(block.indexOf('phase(3);'));
  });

  it('the adaptive-shadow probe MOVES, and the walk site it leaves behind is untouched', () => {
    // `?blur-first`'s contract: the probe stays in the walk, verbatim. This lane does not edit that
    // line — it adds a branch AHEAD of it that takes phase 2's reading, and the phased probe is in
    // its own function so the pre-pass bodies stay free of it (`Blur.First.test.ts` asserts that).
    expect(jaui).toContain('const slot = r.MeasureShadowBackdrop(node, { x: px, y: py, w: pw, h: ph }, detailLod, lastBackdrop, _shadowScene, dt);');
    const probes = arrowBody(jaui, '_phasedShadowProbes');
    expect(probes).toContain('r.MeasureShadowBackdrop(');
    expect(probes).toContain('if (!b.Plan.AdaptiveShadow) continue;');
    for (const forbidden of ['_blurFirstPrepass', '_blurFirstNode', '_blurFirstDescend', '_blurFirstBuild']) {
      expect(probes).not.toContain(forbidden);
    }
    const render = arrowBody(jaui, '_render');
    expect(render).toContain('const preShadow = this._blurPhased ? this._phasedShadow.get(node) : undefined;');
  });

  it('counts the two things that make an arm incomparable instead of hiding them', () => {
    const render = arrowBody(jaui, '_render');
    expect((render.match(/this\._phasedStrays\.Snaps\+\+/g) ?? []).length).toBe(2);   // fill site + rim site
    expect(arrowBody(jaui, '_blurFirstNode')).toContain('this._phasedStrays.Pblur++');
    expect(render).toContain('snaps=${this._phasedStrays.Snaps}');
    expect(render).toContain('pblur=${this._phasedStrays.Pblur}');
    expect(render).toContain('missed=${st.Missed}');
    expect(render).toContain('pixels=DIFFERENT');
    expect(render).toContain('if (line !== this._phasedLastLine)');
  });
});

// ── The pool: twenty pyramids alive at once, run through BlurPass itself ───────────────────────

let _trace: string[] = [];
beforeEach(() => { _trace = []; OnJauiTrace(n => { _trace.push(n); }); });
afterEach(() => { OnJauiTrace(null); });

describe('the pool has to hold twenty fill pyramids at once, and the shipped pool cannot', () => {
  const FILL = ChainBytes(568, 436);
  const RIM = ChainBytes(480, 348);
  /** `?blur-phased`'s N. Read from the source so a change to it moves this arithmetic rather than
   *  leaving it a comment. */
  const PHASED_CHAINS = Number(/const PHASED_CHAINS = (\d+);/.exec(jaui)![1]);
  const LIMITS = { MaxChains: MAX_CHAINS * PHASED_CHAINS, BudgetBytes: CHAIN_BUDGET_BYTES * 2 };

  it('resolves the grid to the same two size classes the chains lane measured', () => {
    expect(Level0(RegionFor(CardBox(0), FILL_MARGIN))).toEqual({ W: 568, H: 436 });
    expect(Level0(RegionFor(CardBox(0), RIM_MARGIN))).toEqual({ W: 480, H: 348 });
    const sizes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const f = Level0(RegionFor(CardBox(i), FILL_MARGIN));
      const m = Level0(RegionFor(CardBox(i), RIM_MARGIN));
      sizes.add(`${f.W}x${f.H}`); sizes.add(`${m.W}x${m.H}`);
    }
    expect([...sizes].sort()).toEqual(['480x348', '568x436']);
  });

  it('needs 52.7 MiB in 40 chains — over the shipped 48 MiB budget AND over MAX_CHAINS 6', () => {
    const bytes = PHASED_CHAINS * (FILL + RIM);
    expect(bytes).toBe(55291740);
    expect(Math.round(bytes / (1024 * 1024) * 100) / 100).toBe(52.73);
    expect(2 * PHASED_CHAINS).toBeGreaterThan(MAX_CHAINS);
    expect(bytes).toBeGreaterThan(CHAIN_BUDGET_BYTES);
    // The raised pair, and the headroom it leaves. Comfortably over, so an eviction under this
    // flag means the SCENE is bigger than the flag was sized for — not that the flag is too tight.
    expect(LIMITS.MaxChains).toBeGreaterThanOrEqual(2 * PHASED_CHAINS);
    expect(LIMITS.BudgetBytes).toBeGreaterThan(bytes);
    // What the arm COSTS over an unflagged frame, which holds two chains: +50.1 MiB.
    expect(Math.round((bytes - (FILL + RIM)) / (1024 * 1024) * 10) / 10).toBe(50.1);
  });

  it('forty builds land on forty distinct chains, with no eviction and no refusal', () => {
    const gl = new FakeGl();
    const pass = new BlurPass(gl.Gl, undefined, PHASED_CHAINS, LIMITS);
    const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene') as WebGLTexture;
    // Phase 2, then phase 4 — the phased order, not the walk's interleave.
    const fills: object[] = [];
    const rims: object[] = [];
    for (let i = 0; i < 20; i++) {
      fills.push(pass.Blur(src, CANVAS_W, CANVAS_H, RADIUS, 0, RegionFor(CardBox(i), FILL_MARGIN)));
    }
    for (let i = 0; i < 20; i++) {
      rims.push(pass.Blur(src, CANVAS_W, CANVAS_H, RADIUS, 0, RegionFor(CardBox(i), RIM_MARGIN)));
    }
    // TWENTY distinct level-0 textures per size class: every fill pyramid is still alive when its
    // card draws in pass 2, which is the whole reason the rotation is not optional under this flag.
    expect(new Set(fills).size).toBe(20);
    expect(new Set(rims).size).toBe(20);
    expect(new Set([...fills, ...rims]).size).toBe(40);
    expect(pass.ChainCensus).toMatchObject({
      Asked: 20, Live: 20, Resident: 40, Sizes: '568x436#20+480x348#20', Refused: null,
      Max: LIMITS.MaxChains, BudgetMb: 96, ResidentMb: 52.7,
    });
    expect(_trace.filter(t => t.includes('refused='))).toEqual([]);
  });

  it('the SHIPPED pool cannot: at N=1 all twenty share ONE chain, at its widest N six', () => {
    // The control, and the failure the raised ceilings exist to avoid — both RUN rather than
    // asserted, which is also what makes the forty-distinct-chains test above non-vacuous: `Blur`
    // returns the chain's own level-0 texture, so identity IS the chain.
    const run = (chains: number): Set<object> => {
      const gl = new FakeGl();
      const pass = new BlurPass(gl.Gl, undefined, chains);
      const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene') as WebGLTexture;
      const out = new Set<object>();
      for (let i = 0; i < 20; i++) {
        out.add(pass.Blur(src, CANVAS_W, CANVAS_H, RADIUS, 0, RegionFor(CardBox(i), FILL_MARGIN)));
      }
      return out;
    };
    // N=1 is the shipped pool: ONE chain for twenty builds, so nineteen fill pyramids are gone
    // before their cards draw in pass 2. This is what `?blur-phased` would measure without the
    // rotation, and it is not the experiment.
    expect(run(1).size).toBe(1);
    // And the shipped CAP is six, not twenty — which is why the ceilings had to come up and not
    // just the N.
    expect(run(MAX_CHAINS).size).toBe(MAX_CHAINS);
    expect(MAX_CHAINS).toBeLessThan(PHASED_CHAINS);
  });

  it('a second frame reuses the forty chains rather than reallocating them', () => {
    // `_chainSeq` advances per build and never resets, so twenty builds a frame at N=20 wrap the
    // phase exactly. If they did not, frame 2 would land on a different twenty and evict frame 1's
    // — reallocation thrash, published under this flag's name.
    const gl = new FakeGl();
    const pass = new BlurPass(gl.Gl, undefined, PHASED_CHAINS, LIMITS);
    const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene') as WebGLTexture;
    const frame = (): object[] => {
      const out: object[] = [];
      for (let i = 0; i < 20; i++) out.push(pass.Blur(src, CANVAS_W, CANVAS_H, RADIUS, 0, RegionFor(CardBox(i), FILL_MARGIN)));
      for (let i = 0; i < 20; i++) out.push(pass.Blur(src, CANVAS_W, CANVAS_H, RADIUS, 0, RegionFor(CardBox(i), RIM_MARGIN)));
      return out;
    };
    const a = frame();
    const b = frame();
    expect(b).toEqual(a);
    expect(pass.ChainCensus).toMatchObject({ Resident: 40, Live: 20, Refused: null });
  });

  it('an unflagged pass keeps the shipped ceilings, because they are per-pass and never mutated', () => {
    const gl = new FakeGl();
    expect(new BlurPass(gl.Gl).ChainCensus).toMatchObject({ Max: MAX_CHAINS, BudgetMb: 48 });
    // And the constructor's range check follows the pass's OWN ceiling, not the module's.
    expect(() => new BlurPass(new FakeGl().Gl, undefined, MAX_CHAINS + 1)).toThrow();
    expect(() => new BlurPass(new FakeGl().Gl, undefined, MAX_CHAINS + 1, LIMITS)).not.toThrow();
  });
});

// ── What the ledger must read, on the ledger's own code ────────────────────────────────────────

describe('the counters, derived on Scene.Ledger.ts itself', () => {
  /** One card at BASELINE, in source order — the cell `Blur.First.test.ts` already matched against
   *  the measured Metal capture, restated here so the phased row is read against it. */
  const baselineCard = (l: SceneReadLedger): void => {
    l.NoteRead(); l.NoteTargetBind('blur');            // fill ComputeBlur
    l.NoteTargetBind('blur');                          // fill GenerateBlurMipmap
    l.NoteTargetBind('scene');                         // RebindSceneTarget
    l.NoteTargetBind('shadow-state'); l.NoteRead();    // MeasureShadowBackdrop
    l.NoteTargetBind('scene');
    l.NoteWrite();                                     // fill PanelDrawBatch
    l.NoteRead(); l.NoteTargetBind('blur');            // rim ComputeBlur
    l.NoteTargetBind('blur');                          // rim GenerateBlurMipmap
    l.NoteTargetBind('scene');
    l.NoteWrite();                                     // rim PanelDrawBatch
  };

  it('baseline: 60 reads, 40 restarts, 40 ends, all on `blur`', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();                                     // the bed
    for (let i = 0; i < 20; i++) baselineCard(l);
    l.NoteFrameEndDrain();
    expect([l.Reads, l.Restarts, l.Switches]).toEqual([60, 40, 40]);
    expect(l.EndsByKey).toEqual({ blur: 40 });
  });

  it('phased: reads UNCHANGED at 60, and the ends fall from 40 to TWO', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    // Pass 1 — the bed. `BeginScenePass`'s clear is not a write; the bed's draw is.
    l.NoteWrite();
    // Phase 2 — twenty fill builds. The FIRST read finds the scene written and ends encoder A; its
    // `blur` bind takes the end. Every later read finds the flag already cleared, so nineteen
    // builds ride free — which is the whole mechanism the flag is testing.
    for (let i = 0; i < 20; i++) { l.NoteRead(); l.NoteTargetBind('blur'); l.NoteTargetBind('blur'); }
    expect([l.Reads, l.Restarts, l.Switches]).toEqual([20, 1, 1]);
    // The twenty probes, beside their builds. Nothing has been drawn into the scene since the end
    // the first build paid, so every `shadow-state` bind is free — exactly as at baseline.
    for (let i = 0; i < 20; i++) { l.NoteTargetBind('shadow-state'); l.NoteRead(); l.NoteTargetBind('scene'); }
    expect([l.Reads, l.Restarts, l.Switches]).toEqual([40, 1, 1]);
    // Rebind, then pass 2 — encoder B. Twenty fills and their children draw.
    l.NoteTargetBind('scene');
    for (let i = 0; i < 20; i++) l.NoteWrite();
    // Phase 4 — twenty rim builds. First read ends B; nineteen ride free.
    for (let i = 0; i < 20; i++) { l.NoteRead(); l.NoteTargetBind('blur'); l.NoteTargetBind('blur'); }
    // Rebind, then pass 3 — encoder C. Twenty rim overlays draw.
    l.NoteTargetBind('scene');
    for (let i = 0; i < 20; i++) l.NoteWrite();
    // The present ends C, and the ledger drains it rather than counting it — the same constant it
    // excludes at baseline, which is why 2 and 40 are comparable numbers.
    l.NoteFrameEndDrain();
    expect([l.Reads, l.Restarts, l.Switches]).toEqual([60, 2, 2]);
    expect(l.EndsByKey).toEqual({ blur: 2 });
  });

  it('THREE encoders read as TWO ends, and the third is the present the ledger excludes', () => {
    // Stated because the brief predicted `SceneSwitches` 3. The frame does run in three scene
    // encoders — A ends at the first fill build, B at the first rim build, C at the present — and
    // `NoteFrameEndDrain` exists precisely so the present's end is not counted in any arm.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteRead(); l.NoteTargetBind('blur');            // A ends
    l.NoteTargetBind('scene'); l.NoteWrite();
    l.NoteRead(); l.NoteTargetBind('blur');            // B ends
    l.NoteTargetBind('scene'); l.NoteWrite();
    expect(l.Switches).toBe(2);
    l.NoteFrameEndDrain();                             // C ends here, uncounted, in every arm
    expect(l.Switches).toBe(2);
  });

  it('the probe MUST ride its build: left in pass 2 it would cost nineteen ends', () => {
    // The counting reason the probe moved, run rather than argued. In pass 2 the scene is bound and
    // each card's fill has drawn, so the next card's `shadow-state` bind ends the encoder.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    for (let i = 0; i < 20; i++) { l.NoteRead(); l.NoteTargetBind('blur'); }
    l.NoteTargetBind('scene');
    for (let i = 0; i < 20; i++) {
      l.NoteTargetBind('shadow-state'); l.NoteRead(); l.NoteTargetBind('scene');
      l.NoteWrite();                                   // the fill draw that dirties it again
    }
    l.NoteFrameEndDrain();
    expect(l.Switches).toBe(1 + 19);
    expect(l.EndsByKey).toEqual({ blur: 1, 'shadow-state': 19 });
  });
});

// ── Where the pixels may differ, and where they may NOT ────────────────────────────────────────

describe('the pixel change, derived from the two sheets that own the geometry', () => {
  it('reads the geometry it depends on, so a retuned class moves the prediction', () => {
    expect([CARD_W, CARD_H, GAP]).toEqual([216, 150, 20]);
    expect([FROST, THICKNESS, REFRACTION, FILLET, CA]).toEqual([4, 2.5, 8, 0, 0.25]);
    expect(FILL_MARGIN).toBe(64.75);
    expect(RIM_MARGIN).toBe(24);
    // The rim IS an overlay on this class, which is why phase 5 exists at all, and the shadow IS
    // adaptive, which is why the probe had to move.
    expect(BORDER_LAYER).toBe(10);
    expect(SHADOW_ADAPTIVE).toBeGreaterThan(0);
  });

  it('a FILL pyramid reaches 24.75 device px into a neighbour box; a RIM pyramid reaches none', () => {
    const gutter = GAP * DPR;                          // 40 device px
    expect(FILL_MARGIN - gutter).toBeCloseTo(24.75, 6);
    expect(RIM_MARGIN - gutter).toBeLessThan(0);
    // So on this grid the RIM pyramids read the same texels in both arms: rim N's region contains
    // card N's own fill and the bed, and nothing of any neighbour, in either arm. Every differing
    // pixel this flag can produce is downstream of a FILL pyramid.
    for (let i = 0; i < 20; i++) {
      const rim = RegionFor(CardBox(i), RIM_MARGIN);
      for (let j = 0; j < 20; j++) if (j !== i) expect(Overlaps(rim, CardBox(j))).toBe(false);
    }
  });

  it('exactly nineteen of twenty cards have an EARLIER neighbour inside their fill region', () => {
    // Walk order is tree order, so card N's pyramid at baseline sees fills 0..N-1 and phased sees
    // none of them. A later neighbour is undrawn in BOTH arms and cannot differ.
    const earlier: number[] = [];
    for (let i = 0; i < 20; i++) {
      const region = RegionFor(CardBox(i), FILL_MARGIN);
      for (let j = 0; j < i; j++) if (Overlaps(region, CardBox(j))) { earlier.push(i); break; }
    }
    expect(earlier.length).toBe(19);
    // Card 0 is the top-left card: no left neighbour, no card above. It must be pixel-identical.
    expect(earlier).not.toContain(0);
    expect(earlier[0]).toBe(1);
  });

  it('the reached neighbours are left, above and the two upper diagonals — never right or below', () => {
    const reached = (i: number): number[] => {
      const region = RegionFor(CardBox(i), FILL_MARGIN);
      const out: number[] = [];
      for (let j = 0; j < 20; j++) if (j !== i && Overlaps(region, CardBox(j))) out.push(j);
      return out;
    };
    // Card 6 sits in the middle of the grid: row 1, col 1.
    expect(reached(6)).toEqual([0, 1, 2, 5, 7, 10, 11, 12]);
    // Of those, the EARLIER ones — the only ones that can differ — are up-left, up, up-right, left.
    expect(reached(6).filter(j => j < 6)).toEqual([0, 1, 2, 5]);
  });

  it('bounds the differing area: inside card boxes only, 24 px deep, at most 6.4% of the frame', () => {
    // A tap can only reach a neighbour where the bezel displaces outward. The budget is
    // (thickness*d + bulge) * Refraction = 40 device px of displacement plus the pyramid's own
    // +-3 sigma spread (sigma = RADIUS), against a 40 px gutter — so a neighbour's content reaches
    // at most (40 + 3*RADIUS - gutter) device px inside the card's own edge, and the bezel is no
    // wider than that either.
    const disp = (THICKNESS * DPR + FILLET * MIN_HALF * 0.25 * 0.7) * REFRACTION;
    expect(disp).toBe(40);
    const depth = Math.min(disp + 3 * RADIUS - GAP * DPR, BEZEL * DPR);
    expect(depth).toBe(24);
    // Upper bound on the count: a left band on every card with a column to its left, a top band on
    // every card with a row above, minus the corner both cover.
    let area = 0;
    for (let i = 0; i < 20; i++) {
      const left = i % COLS > 0, above = (i / COLS | 0) > 0;
      if (left) area += depth * CARD_H * DPR;
      if (above) area += depth * CARD_W * DPR;
      if (left && above) area -= depth * depth;
    }
    expect(area).toBe(263808);
    expect(Math.round(area / (CANVAS_W * CANVAS_H) * 1000) / 10).toBe(6.4);
  });

  it('nothing may differ OUTSIDE the grid: the adaptive shadow reads the same bed in both arms', () => {
    // The shadow is the only thing this flag touches that paints outside a card box, and its probe
    // samples strictly inside the surface's own rect. Nothing else paints inside a card's box in
    // either arm, so the reading — and therefore every shadow pixel — is identical.
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 20; j++) if (j !== i) expect(Overlaps(CardBox(i), CardBox(j))).toBe(false);
    }
    // The box `glassshot diff` should report, at the widest: the grid, inset by nothing.
    const x0 = CardBox(0).x, y0 = CardBox(0).y;
    const x1 = CardBox(19).x + CardBox(19).w, y1 = CardBox(19).y + CardBox(19).h;
    expect([x0, y0, x1, y1]).toEqual([120, 140, 2440, 1460]);
  });
});
