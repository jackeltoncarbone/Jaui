/**
 * `?blur-first` — the ORDER test.
 *
 * `?blur-src-clear` and `?blur-src-static` both read the baseline to within 1%, which kills the
 * pyramid read's own bandwidth (H1) and a same-frame write→sample hazard (H2) together: sampling a
 * cleared opaque-black texture costs what sampling the live scene costs, and a texture written once
 * at boot costs what one written this frame costs. What survives is that the ~34 ms interaction
 * REQUIRES the bed to be drawn and is completely indifferent to what the pyramids read — and that
 * `gpuMs` is top-level task time in the GPU PROCESS, not hardware time. H3: the pyramid path does
 * something ANGLE Metal must serialise against in-flight GPU work, and each wait lasts as long as
 * the GPU's backlog, which is large only when the bed's fill is queued ahead of it.
 *
 * So: run every build BEFORE the bed's first draw. Same builds, same regions, same radii, same
 * depths, same source — different order. Legal only because `blur-src-clear` makes the pyramids
 * independent of the scene.
 *
 * There is no GPU here and no claim about milliseconds. What these tests pin is that the
 * instrument is the instrument: that the pre-pass and the walk resolve a build from ONE piece of
 * arithmetic rather than two copies of it, that the pre-pass descends through the walk's own
 * functions, that a disagreement between them is COUNTED instead of hidden, that the flag cannot
 * arm on a build where it would mean something else — and, on the ledger's own code and BlurPass's
 * own region functions, what the frame's counters must read under it.
 */
import { describe, it, expect } from 'vitest';
import { readRenderer, readJaui, arrowBody } from './Scene.ReadAfterWrite.Source';
import {
  BaseDownsampleFactor, PyramidDepth, ResolveRegionRect, type BackdropRect,
} from '../src/Core/BlurPass';
import { SceneReadLedger } from '../src/Core/Scene.Ledger';

const jaui = readJaui();
const renderer = readRenderer();

// ── The harness's geometry, pinned: 1280x800 CSS at deviceScaleFactor 2, the glass-grid scene ──
const CANVAS_W = 2560;
const CANVAS_H = 1600;
const DPR = 2;
/** JwiftGlass: BackdropFilter Blur(4pt), Thickness 2.5, Curvature 0, Refraction 8, CA 0.25.
 *  `_glassFillBlurPlan`: margin = frostCssPx*d + (thicknessDev + bulge)*Refraction + CA*3 + 8*d. */
const FILL_MARGIN = 4 * DPR + (2.5 * DPR) * 8 * (1 + 0.2 * 0.25) + 8 * DPR;   // 66
/** `_glassRimBlurPlan`: a border-only fragment makes ONE inward tap, so margin = frost*d + 8*d. */
const RIM_MARGIN = 4 * DPR + 8 * DPR;                                  // 24
const RADIUS = 4 * DPR;

const RegionFor = (x: number, y: number, w: number, h: number, margin: number): BackdropRect => ({
  x: Math.max(0, Math.floor(x - margin)),
  y: Math.max(0, Math.floor(y - margin)),
  w: Math.min(CANVAS_W, Math.ceil(w + margin * 2)),
  h: Math.min(CANVAS_H, Math.ceil(h + margin * 2)),
});

/** glass-grid: PerfGrid at 60pt,70pt; 216x150pt cards, 20pt gap, 5 across, 20 of them. */
const GlassGridBoxes = (): BackdropRect[] => {
  const out: BackdropRect[] = [];
  for (let i = 0; i < 20; i++) {
    const col = i % 5, row = (i / 5) | 0;
    out.push({
      x: (60 + col * (216 + 20)) * DPR,
      y: (70 + row * (150 + 20)) * DPR,
      w: 216 * DPR,
      h: 150 * DPR,
    });
  }
  return out;
};

/** The pyramid pool's own chain key for a build, from the pool's own functions — exactly what
 *  `_blurFirstBuild` records. `BlurPass._useChain` keys on the resolved level-0 size. */
const ChainKey = (region: BackdropRect): string => {
  const k = BaseDownsampleFactor(RADIUS, CANVAS_W, CANVAS_H, region);
  const depth = PyramidDepth(RADIUS / k, 0);
  const r = ResolveRegionRect(region, CANVAS_W, CANVAS_H, k * (1 << depth));
  return `${r.W}x${r.H}`;
};

describe('?blur-first — the flag arrives, and refuses where it would mean something else', () => {
  it('parses exact-key and marks itself in Init beside the other three', () => {
    expect(jaui).toContain("params.has('blur-first')");
    expect(renderer).toContain("if (this.DiagBlurFirst) JTrace('jaui:blur-first armed=true pixels=WRONG');");
    // Beside, and AFTER, the blur-src mark it depends on — the marks read in the order the flags
    // compose. A reading taken with this line absent is a reading of the wrong build.
    expect(renderer.indexOf('jaui:blur-src armed=')).toBeLessThan(renderer.indexOf('jaui:blur-first armed=true'));
  });

  it('refuses without a blur source, and says which refusal it took', () => {
    const body = arrowBody(jaui, '_initDebugFromUrl');
    expect(body).toContain("r.DiagBlurSrc === null ? 'needs-blur-src-clear-or-blur-src-static'");
    expect(body).toContain('JTrace(`jaui:blur-first armed=false reason=${why}`)');
    // Without one, the pyramids would sample a scene nothing has drawn into yet — which is the
    // `?no-panels`-shaped experiment, not this one.
    expect(body).toContain('this._blurFirst = true;');
  });

  it('refuses the four other flags that change WHICH pyramids get built', () => {
    const body = arrowBody(jaui, '_initDebugFromUrl');
    for (const guard of [
      'this._diagNoBlur || r.DiagBlurDummy',       // no builds at all to move
      'r.CardCompositeEnabled',                     // a build inside a card resolves a different source
      'this._sharedBackdrop',                       // one lazy pyramid, not one per surface
      'this._layerCacheEnabled',                    // whole subtrees the walk never descends
    ]) expect(body).toContain(guard);
  });

  it('is parsed AFTER the flags it interrogates, or every guard would read a default', () => {
    // `?layer-cache`, `?wkr-shared-backdrop` and `?cardcomposite` are assigned further up the same
    // function. A guard that ran first would be asking a question nobody had answered yet.
    const body = arrowBody(jaui, '_initDebugFromUrl');
    expect(body.indexOf("params.has('layer-cache')")).toBeLessThan(body.indexOf("params.has('blur-first')"));
    expect(body.indexOf("params.has('cardcomposite')")).toBeLessThan(body.indexOf("params.has('blur-first')"));
    expect(body.indexOf("params.has('wkr-shared-backdrop')")).toBeLessThan(body.indexOf("params.has('blur-first')"));
  });

  it('says out loud that a static source fills from an undrawn scene under it', () => {
    // `?blur-src-static` fills its stand-in on FIRST USE, and under this flag the first use is the
    // pre-pass — before anything is drawn. The static arm therefore collapses into the clear arm.
    // The two already measure within 1% of each other, so this costs the experiment nothing; a
    // reader who sees `static` in the URL must not be left thinking it still held frame 1.
    expect(jaui).toContain('jaui:blur-first note=static-source-fills-from-an-undrawn-scene-so-it-reads-as-clear');
  });
});

describe('?blur-first — ONE piece of arithmetic, not two copies of it', () => {
  it('the fill site and the pre-pass both resolve their build from _glassFillBlurPlan', () => {
    // Defined once, called twice. A pre-pass with its own copy of the region maths is a pre-pass
    // that can silently build a different pyramid and hand it over as if it were the same one.
    expect((jaui.match(/_glassFillBlurPlan\s*=\s*\(/g) ?? []).length).toBe(1);
    expect((jaui.match(/this\._glassFillBlurPlan\(/g) ?? []).length).toBe(2);
    expect((jaui.match(/_glassRimBlurPlan\s*=\s*\(/g) ?? []).length).toBe(1);
    expect((jaui.match(/this\._glassRimBlurPlan\(/g) ?? []).length).toBe(2);
  });

  it('the walk no longer computes a glass region itself', () => {
    // The named locals the region used to be built from are gone from the file entirely: if any
    // survived, one of the two sites would be reachable without the resolver.
    for (const gone of ['_gThicknessDev', '_gRefractMax', '_gBulgeMax', '_gCaMax', '_gMinHalf']) {
      expect(jaui).not.toContain(gone);
    }
  });

  it('the transform composition is one function both walks call', () => {
    expect((jaui.match(/_composeTransform\s*=\s*\(/g) ?? []).length).toBe(1);
    expect((jaui.match(/this\._composeTransform\(/g) ?? []).length).toBe(2);
    // It hands back the affine and leaves the homography and the descendants' perspective in
    // fields, because it runs for EVERY node and a per-node object is an allocation the walk does
    // not make today — so an unflagged frame must not get slower for this lane's benefit.
    expect(arrowBody(jaui, '_composeTransform')).toContain('this._xfH = effH;');
    expect(arrowBody(jaui, '_composeTransform')).toContain('this._xfPersp = childPersp;');
  });

  it('the pre-pass descends through the walk\'s own culls, ordering and clip functions', () => {
    const node = arrowBody(jaui, '_blurFirstNode');
    const descend = arrowBody(jaui, '_blurFirstDescend');
    for (const fn of ['_composeTransform', '_isInsideClipStack', '_damageCulls', '_glassFillTakesPyramid']) {
      expect(node).toContain(`this.${fn}(`);
    }
    for (const fn of ['_boxClip', '_childClip', '_descendOffset', '_orderedChildren', '_rimEmits']) {
      expect(descend).toContain(`this.${fn}(`);
    }
    // ClipsChildren short-circuits the subtree on both culls, exactly as `renderNode` does — an
    // overflow-visible box recurses so its children self-cull.
    expect((node.match(/node\.ClipsChildren/g) ?? []).length).toBe(2);
  });

  it('the pre-pass builds in the walk\'s order: the rim lands at its BorderLayer slot', () => {
    const descend = arrowBody(jaui, '_blurFirstDescend');
    expect(descend).toContain('if (rimPending && child.RenderStyle.Layer >= borderLayer) emitRim();');
    // And after every child when BorderLayer sits above all of them — the walk's trailing emit.
    expect(descend.trimEnd().endsWith('emitRim();')).toBe(true);
  });

  it('the pre-pass issues the two build calls and NOTHING else', () => {
    // The two calls live in `_prepassIssue`, which `_blurFirstBuild` tail-calls. Lane
    // pyramidatlas2 split them apart so the ATLAS arm can RECORD a build instead of issuing it --
    // and this assertion follows the calls rather than the name, because what it protects is that
    // a pre-pass build is the walk's two calls and nothing else, wherever they are written.
    const issue = arrowBody(jaui, '_prepassIssue');
    expect(issue).toContain('r.ComputeBlur(r.SceneTexture, w, h, plan.Radius, undefined, plan.Region,');
    expect(issue).toContain('r.GenerateBlurMipmap(plan.MaxLod)');
    // And the decision in front of them is a decision and nothing more: record, or issue.
    const build = arrowBody(jaui, '_blurFirstBuild');
    expect(build).toContain('return this._prepassIssue(into, node, plan, w, h);');
    expect(build).not.toContain('ComputeBlur');
    // No snapshot (that is a scene READ, not a build, and it stays where the walk puts it), no
    // shadow probe, no draw, no buffer encode.
    const prepass = [build, issue, arrowBody(jaui, '_blurFirstNode'),
                     arrowBody(jaui, '_blurFirstDescend'),
                     arrowBody(jaui, '_blurFirstPrepass')].join('\n');
    for (const forbidden of ['SnapshotScreen', 'MeasureShadowBackdrop', 'DrawBatch',
                             'DrawProgressiveBlur', 'BeginCardComposite', '_panelBuffer',
                             '_textBuffer', '_clipBuffer', '_counts']) {
      expect(prepass).not.toContain(forbidden);
    }
  });

  it('the adaptive-shadow probe stays in the walk, where it always ran', () => {
    // It reads the pyramid, which now exists earlier — fine. Moving it would move a scene READ.
    expect(jaui).toContain('const slot = r.MeasureShadowBackdrop(node, { x: px, y: py, w: pw, h: ph }, detailLod, lastBackdrop, _shadowScene, dt, inputsSame);');
  });

  it('runs before the walk, and rebinds the scene so the first draw lands where it always did', () => {
    const render = arrowBody(jaui, '_render');
    expect(render.indexOf('this._blurFirstPrepass(w, h)'))
      .toBeLessThan(render.indexOf('renderNode(this.Root, MAT_IDENTITY, EmptyClipStack, rootScope)'));
    expect(arrowBody(jaui, '_blurFirstPrepass')).toContain('this._renderer.RebindSceneTarget();');
  });
});

describe('?blur-first — a disagreement is a number, not a silence', () => {
  it('both sites count a MISS and build, rather than drawing without a backdrop', () => {
    // A miss is the walk reaching a build site the pre-pass never reached. The flag's whole claim
    // is that the SAME builds moved; a site that quietly fell back would make that claim false
    // while every other counter still read correct.
    expect((jaui.match(/this\._blurFirstStats\.Missed\+\+/g) ?? []).length).toBe(2);
    expect((jaui.match(/this\._blurFirstStats\.Used\+\+/g) ?? []).length).toBe(2);
  });

  it('the fill site keeps RebindSceneTarget inside the branch that actually left the scene', () => {
    // Taking a recorded handle binds nothing, so a rebind there would be a target bind the
    // baseline does not make — and the ledger prices target binds.
    const walk = jaui.slice(jaui.indexOf('const preFill = this._blurFirst'));
    const branch = walk.slice(0, walk.indexOf('// Adaptive shadow'));
    expect(branch).toContain('lastBackdrop = preFill;');
    const rebindAt = branch.indexOf('r.RebindSceneTarget();');
    const elseAt = branch.indexOf('} else {');
    expect(elseAt).toBeGreaterThanOrEqual(0);
    expect(rebindAt).toBeGreaterThan(elseAt);
  });

  it('the gate line carries used/missed/dup and the pool\'s chain count', () => {
    const render = arrowBody(jaui, '_render');
    expect(render).toContain('used=${st.Used} missed=${st.Missed} dup=${st.Dup}');
    expect(render).toContain('chains=${st.Chains}');
    expect(render).toContain('pixels=WRONG');
    // Printed on a SHAPE CHANGE: a line per frame drowns the channel, a line on frame one misses a
    // walk that starts disagreeing once something animates.
    expect(render).toContain('if (line !== this._blurFirstLastLine)');
  });

  it('a node can be pre-built once per site, and a second attempt is refused and counted', () => {
    const build = arrowBody(jaui, '_blurFirstBuild');
    expect(build).toContain('if (into.has(node)) { st.Dup++; return false; }');
    // Two maps, because a node's fill region and its rim region are different sizes.
    expect(jaui).toContain('private _blurFirstFill = new Map<Jiv, GpuTextureHandle>();');
    expect(jaui).toContain('private _blurFirstRim = new Map<Jiv, GpuTextureHandle>();');
  });
});

describe('the pool cannot hold forty pyramids, and that is the finding', () => {
  it('glass-grid\'s forty builds resolve to exactly TWO chain keys', () => {
    // `BlurPass._useChain` keys a chain on its LEVEL-0 SIZE, not on the build. Twenty equal cards
    // on a regular pitch resolve to one extent each side, so the twenty fill builds share one set
    // of level textures and the twenty rim builds share another — and each build overwrites the
    // last. Pre-building all forty therefore leaves every card sampling the LAST pyramid of its
    // size, which is why this flag's pixels are wrong.
    const keys = new Set<string>();
    for (const b of GlassGridBoxes()) {
      keys.add(ChainKey(RegionFor(b.x, b.y, b.w, b.h, FILL_MARGIN)));
      keys.add(ChainKey(RegionFor(b.x, b.y, b.w, b.h, RIM_MARGIN)));
    }
    // 568x436 is the fill extent `ResolveRegionRect`'s own docstring names. The rim's is 480x348,
    // NOT the 484x352 `BlurPass._useChain`'s docstring names beside it — that figure predates the
    // border-only margin's current value (frost·d + 8·d = 24 px, which puts the region at 480x348
    // exactly on the depth-2 phase). Derived here rather than restated, so the number moves with
    // the margin instead of going quietly stale a second time.
    expect([...keys].sort()).toEqual(['480x348', '568x436']);
  });

  it('two chains sit far inside MAX_CHAINS and the 48 MB budget, so nothing is evicted', () => {
    // `_evictChains` bills a chain at ceil(w*h*4*5/3) bytes. Nothing a later card needs is dropped
    // by a build the pre-pass made, so the split the brief allows for does not arise: 40 of 40 are
    // pre-built. The pixels are wrong for the OTHER reason — reuse, not eviction.
    const bytes = (w: number, h: number): number => Math.ceil(w * h * 4 * 5 / 3);
    const total = bytes(568, 436) + bytes(480, 348);
    expect(total).toBeLessThan(48 * 1024 * 1024);
    expect(total / (1024 * 1024)).toBeCloseTo(2.64, 2);
  });

  it('under a CLEARED source the reuse costs no pixels either, and under a static one it does', () => {
    // The texels of a pyramid built from a uniform source do not depend on WHERE the region sat,
    // so under `?blur-src-clear` every same-sized build produces the same texels and handing card
    // 3 card 20's texture is a substitution of equals. Only `LastRegion` differs per build, and
    // each handle carries its OWN. Under `?blur-src-static` the source is not uniform and the
    // substitution is visible — which is the second reason the static arm is worth a warning.
    const first = RegionFor(GlassGridBoxes()[0].x, GlassGridBoxes()[0].y, 432, 300, FILL_MARGIN);
    const last = RegionFor(GlassGridBoxes()[19].x, GlassGridBoxes()[19].y, 432, 300, FILL_MARGIN);
    expect(ChainKey(first)).toBe(ChainKey(last));
    expect(first.x).not.toBe(last.x);
  });
});

describe('what the ledger must read, on the ledger\'s own code', () => {
  /** One glass surface's ledger events at BASELINE, in source order. Fill `ComputeBlur` notes a
   *  read then binds `blur`; the mipmap binds `blur` again; `RebindSceneTarget` binds `scene`; the
   *  shadow probe binds `shadow-state` and then notes a read; the fill draw writes; the rim repeats
   *  the build; the rim draw writes. */
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

  /** The same card under `?blur-first`: both builds have already happened, so what is left in the
   *  walk is the shadow probe and the two draws. */
  const blurFirstCard = (l: SceneReadLedger): void => {
    l.NoteTargetBind('shadow-state'); l.NoteRead();
    l.NoteTargetBind('scene');
    l.NoteWrite();
    l.NoteWrite();
  };

  it('baseline reproduces the measured cell exactly: 60 reads, 40 restarts, 40 ends, all blur', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();                                     // the bed
    for (let i = 0; i < 20; i++) baselineCard(l);
    l.NoteFrameEndDrain();
    expect([l.Reads, l.Restarts, l.Switches]).toEqual([60, 40, 40]);
    expect(l.EndsByKey).toEqual({ blur: 40 });
  });

  it('blur-first: reads UNCHANGED at 60, restarts and ends HALVED, and the ends change key', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    // The pre-pass, ahead of every draw. `BeginScenePass`'s clear is a load-clear a tile-based
    // driver resolves for free and the ledger does not count it as a write — so forty builds over
    // an unwritten scene end the encoder ZERO times, not once. That is a sharper answer than the
    // brief's "~1 + the walk's own", and it is the ledger's own rule that gives it.
    for (let i = 0; i < 40; i++) { l.NoteRead(); l.NoteTargetBind('blur'); l.NoteTargetBind('blur'); }
    expect([l.Reads, l.Restarts, l.Switches]).toEqual([40, 0, 0]);
    l.NoteTargetBind('scene');
    l.NoteWrite();                                     // the bed
    for (let i = 0; i < 20; i++) blurFirstCard(l);
    l.NoteFrameEndDrain();
    expect([l.Reads, l.Restarts, l.Switches]).toEqual([60, 20, 20]);
    expect(l.EndsByKey).toEqual({ 'shadow-state': 20 });
  });

  it('the flag lands on ?blur-dummy\'s SWITCH PROFILE with every build still present', () => {
    // This is the cell the 40 -> 20 -> 0 ladder never had. `?blur-dummy` reached 20 switches by
    // REMOVING the builds (reads 0, fill 0); `?blur-first` reaches the same 20, with the same key,
    // while keeping all 40 builds, all their fill and all 60 reads. What it cannot do is separate
    // ORDER from END COUNT — an encoder end IS the interleave, so moving the builds out of it
    // necessarily takes the ends with them. That is a property of the frame, not of this flag,
    // and it is why the report states a two-arm prediction and not a three-arm one.
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let i = 0; i < 40; i++) { l.NoteRead(); l.NoteTargetBind('blur'); }
    l.NoteWrite();
    for (let i = 0; i < 20; i++) { l.NoteTargetBind('shadow-state'); l.NoteRead(); l.NoteTargetBind('scene'); l.NoteWrite(); l.NoteWrite(); }
    // `?blur-dummy` measured restarts 0 / reads 0 / switches 20 on Metal. Same switches, same key,
    // and the reads are all still there.
    expect(l.Switches).toBe(20);
    expect(l.EndsByKey).toEqual({ 'shadow-state': 20 });
    expect(l.Reads).toBe(60);
  });

  it('the two arms the measurement has to choose between, on the ladder\'s own numbers', () => {
    // The ladder (dpr 2, M4, 2026-09-19): switches 40 -> 20 -> 0 give 72.85 -> 34.32 -> 11.32, and
    // ~9 ms of every blur-dummy cell is BLUR_FILL the pyramids themselves no longer pay there.
    const LADDER_BASE = 72.85, BLUR_DUMMY = 34.32, BLUR_FILL = 9;
    // Arm 1 — the interaction is the INTERLEAVE (an encoder end per build, and/or H3's backlog-
    // scaled wait, which this flag cannot tell apart): blur-dummy's frame with the fill added back.
    const interleave = BLUR_DUMMY + BLUR_FILL;
    expect(interleave).toBeCloseTo(43.3, 1);
    // Re-based onto the blur-src day, whose baseline is 67.77 rather than 72.85.
    const SAME_DAY_BASE = 67.77;
    expect(interleave * (SAME_DAY_BASE / LADDER_BASE)).toBeCloseTo(40.3, 1);
    expect(SAME_DAY_BASE - (LADDER_BASE - BLUR_DUMMY - BLUR_FILL)).toBeCloseTo(38.24, 2);
    // Arm 2 — a build costs what it costs wherever it runs: nothing moves.
    expect(SAME_DAY_BASE).toBeCloseTo(67.8, 1);
    // ~28 ms apart. A measurement landing on either is not ambiguous, even at the 9% spread the
    // blur-dummy cell carried.
    expect(SAME_DAY_BASE - 40.3).toBeGreaterThan(25);
  });
});
