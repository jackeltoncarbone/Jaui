import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SceneReadLedger } from '../src/Core/Scene.Ledger';
import { EstimateBorderFragments } from '../src/Core/Border.Direct';
import { arrowBody } from './Scene.ReadAfterWrite.Source';
import {
  ApplyGrading, ApplyTint, BedStops, BorderRgb, BSample, Delta8, FillFace, Hsl,
  JWIFT_GLASS_DARK, LumaDelta8, Stats,
} from './Border.FromFill.Source';

/**
 * Lane borderfromfill: a glass rim reads the pyramid its own FILL built, instead of building a
 * second one over the same region out of the scene the fill has since drawn into.
 *
 * The lane produces an ARM and a NUMBER, not a ruling. The arm is `?border-source=fill`; the number
 * is what the border band will look like on it, computed here from the shader's own arithmetic so
 * that the screenshots Jack rules on can be checked against a prediction rather than described.
 */

const SRC = (...p: string[]): string =>
  readFileSync(join(__dirname, '..', 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const JAUI = SRC('Core', 'Jaui.ts');
const RENDERER = SRC('Core', 'WebGL2.Renderer.ts');
const FRAG = SRC('Jiv', 'Shaders', 'Jiv.Panel.frag');

describe('borderfromfill > the ledger census', () => {
  it('counts the two branches separately and resets both per frame', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let i = 0; i < 18; i++) l.NoteBorderFromFill();
    l.NoteBorderRimBuilt();
    l.NoteBorderRimBuilt();
    expect(l.BordersFromFill).toBe(18);
    expect(l.BordersRimBuilt).toBe(2);
    l.BeginFrame();
    expect(l.BordersFromFill).toBe(0);
    expect(l.BordersRimBuilt).toBe(0);
  });

  it('neither column moves on a frame that took neither branch -- the `scene` arm reads 0 / 0', () => {
    // The whole of what makes `scene` the engine this lane inherited in its COUNTERS as well as in
    // its pixels: nothing on that arm calls either note, so a cell can compare the two columns.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteTargetBind('blur');
    l.NoteBorderPyramid();
    expect(l.BordersFromFill).toBe(0);
    expect(l.BordersRimBuilt).toBe(0);
  });
});

describe('borderfromfill > the flag, read off the source', () => {
  it('`?border-source` takes only `fill` and `scene`, and throws on anything else', () => {
    expect(JAUI).toContain("if (params.has('border-source')) {");
    expect(JAUI).toContain("if (raw !== '' && raw !== 'fill' && raw !== 'scene') {");
    expect(JAUI).toContain("[Jaui] ?border-source takes 'fill' or 'scene', got");
    // `raw !== 'scene'` and not `raw === 'fill'`: the BARE flag arms it, as every flag in the block
    // does, and `=scene` is the only spelling that turns it off.
    expect(JAUI).toContain("this._borderSourceFill = raw !== 'scene';");
  });

  it('the default is `scene`, declared on the field and not only in a comment', () => {
    expect(JAUI).toContain('private _borderSourceFill: boolean = false;');
  });

  it('the mark prints on both arms, says which is armed, and flags the picture change', () => {
    expect(JAUI).toContain(
      "JTrace(`jaui:border-source armed=${this._borderSourceFill ? 'fill' : 'scene'}`");
    // `default=` distinguishes "scene because nobody asked" from "scene because the URL said so" --
    // the distinction lane atlasinstanced had to add after a control shot was taken from an arm.
    expect(JAUI).toContain("+ ` default=${params.has('border-source') ? 'false' : 'true'}`");
    expect(JAUI).toContain("+ (this._borderSourceFill ? ' pixels=DIFFERENT' : ''));");
  });

  it('every flag it cannot run beside is refused BY NAME on the trace, and `fills` is not one', () => {
    const why = JAUI.slice(JAUI.indexOf('if (this._borderSourceFill) {\n      const r = this._renderer;'));
    for (const reason of [
      'webgl2-only',
      'border-direct-already-owns-the-rim-build-site',
      'no-blur-and-blur-dummy-answer-the-build-themselves',
      'blur-src-swaps-the-sampled-texture-under-both-pyramids',
      'shared-backdrop-binds-one-pyramid-that-is-no-surface-s-own',
      'pyramid-atlas-all-builds-every-rim-in-a-phase-and-they-would-go-unread',
      'blur-first-already-pre-built-every-rim',
      'blur-phased-pre-builds-every-rim-in-pass-three',
      'restart-probes-insert-at-a-rim-build-this-arm-does-not-make',
    ]) expect(why.slice(0, 2600), reason).toContain(reason);
    // A refusal DISARMS -- it does not leave the flag half-on, which is the failure mode
    // `?pyramid-atlas` carries the lesson of.
    expect(why.slice(0, 2600)).toContain('this._borderSourceFill = false;');
    expect(why.slice(0, 2600)).toContain('JTrace(`jaui:border-source armed=scene reason=${why}`);');
    // `?pyramid-atlas=fills` is the arm the lane most wants measured: its fills are atlas SLOTS and
    // its rims build in the walk. `_atlasRims` is `all` alone, so `fills` is admitted.
    expect(why.slice(0, 2600)).toContain('this._atlasRims ?');
    expect(why.slice(0, 2600)).not.toContain('this._pyramidAtlas ?');
  });

  it('the gate line prints `rimBuilt` and every refusal column, zeros included', () => {
    const gate = JAUI.slice(JAUI.indexOf('jaui:border-source source=fill'));
    for (const col of ['fromFill=', 'rimBuilt=', 'blur=', 'switches=', 'reads=', 'restarts=',
      'noFill=', 'stale=', 'snap=', 'sigma=', 'depth=', 'region=']) {
      expect(gate.slice(0, 900), col).toContain(col);
    }
    expect(gate.slice(0, 900)).toContain('pixels=DIFFERENT');
    // A SHAPE change, not a frame -- the same terms as the four gates above it.
    expect(gate.slice(0, 900)).toContain('if (line !== this._borderSourceLastLine)');
  });
});

describe('borderfromfill > the admission rule', () => {
  const BODY = arrowBody(JAUI, '_borderReadsFill');

  it('is the first thing the rim asks, before the snapshot and before the build', () => {
    const ask = JAUI.indexOf('const fromFill = this._borderReadsFill(node, plan);');
    const snap = JAUI.indexOf('const sceneSnap = plan.InstFrostLod < SCENE_TAP_FROST_LOD');
    const build = JAUI.indexOf('lastBackdrop = r.ComputeBlur(r.SceneTexture, w, h, plan.Radius, undefined, region);');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(snap);
    expect(ask).toBeLessThan(build);
  });

  it('refuses unless the flag is armed and the renderer is the one that holds the sequence', () => {
    expect(BODY).toContain('if (!this._borderSourceFill) return null;');
    expect(BODY).toContain('if (!(r instanceof WebGL2Renderer)) return null;');
  });

  it('has a clause for each of the seven ways the handle can be wrong, each counted', () => {
    // Read as a list, because the gate line prints one column per clause and a clause with no
    // counter is a refusal nobody can see.
    expect(BODY).toContain('if (fill === undefined || fill.Frame !== this._fillPyramidFrame) { st.NoFill++; return null; }');
    expect(BODY).toContain('if (fill.Seq !== r.BackdropBuildSeq) { st.Stale++; return null; }');
    expect(BODY).toContain('if (rim.InstFrostLod < SCENE_TAP_FROST_LOD) { st.Snap++; return null; }');
    expect(BODY).toContain('if (fill.BaseFrostLod !== rim.BaseFrostLod || fill.Radius !== rim.Radius) { st.Sigma++; return null; }');
    expect(BODY).toContain('if (fill.MaxLod < rim.MaxLod) { st.Depth++; return null; }');
    expect(BODY).toContain('if (!_regionContains(fill.Region, rim.Region)) { st.Region++; return null; }');
  });

  it('the staleness guard is a MONOTONIC COUNTER bumped at every pyramid writer', () => {
    // The choice of failure this lane can have. A per-texture map is exact and is WRONG the moment
    // a writer forgets to stamp -- a wrong picture with nothing to notice it. A counter can only
    // be pessimistic: a handle taken before any later build reads stale and its rim builds, which
    // is today's engine. So the test that matters is that every entry point bumps it.
    expect(RENDERER).toContain('private _backdropBuildSeq = 0;');
    expect(RENDERER).toContain('get BackdropBuildSeq(): number { return this._backdropBuildSeq; }');
    for (const fn of ['ComputeBlur', 'ComputeBlurAtlas', 'BuildSharedBackdrop', 'ComputeBorderDirect']) {
      const body = arrowBody(RENDERER, fn);
      expect(body, fn).toContain('this._backdropBuildSeq++;');
    }
    // And in `ComputeBlur` it is bumped BEFORE the two source diagnostics return their stand-ins,
    // so a handle held across the call reads stale on every arm and not only on the arms that
    // reach a `BlurPass`.
    const cb = arrowBody(RENDERER, 'ComputeBlur');
    expect(cb.indexOf('this._backdropBuildSeq++;')).toBeLessThan(cb.indexOf('if (this.DiagNoBlur)'));
  });

  it('the record is written once, for all three of the fill\'s backdrop sources', () => {
    // One site, after the `preFill` lookup / atlas slot / walk build have all resolved into
    // `lastBackdrop`, and after the mip chain -- so the sequence it stamps is the post-build one.
    expect(JAUI.split('this._fillPyramids.set(node, {').length - 1).toBe(1);
    const rec = JAUI.slice(JAUI.indexOf('this._fillPyramids.set(node, {'));
    for (const field of ['Handle: lastBackdrop,', 'Seq: r2.BackdropBuildSeq,',
      'BaseFrostLod: lastBaseFrostLod,', 'Radius: plan.Radius,', 'MaxLod: plan.MaxLod,',
      'Region: region,', 'Frame: this._fillPyramidFrame,']) {
      expect(rec.slice(0, 500), field).toContain(field);
    }
    // Nothing is recorded on the `scene` arm, and nothing under the shared backdrop, whose one
    // canvas-wide quarter-res pyramid is no surface's own.
    expect(JAUI).toContain('if (this._borderSourceFill && !this._sharedBackdrop');
  });

  it('the frame stamp is bumped once per rendered frame, not at a clear', () => {
    expect(JAUI).toContain('this._fillPyramidFrame++;');
    expect(JAUI.split('this._fillPyramidFrame++;').length - 1).toBe(1);
    // A WeakMap, so a Jiv that leaves the tree takes its record with it and no lifecycle hook owns
    // the cleanup. The three walk entry points cannot disagree about a clear that does not exist.
    expect(JAUI).toContain('private _fillPyramids = new WeakMap<Jiv, FillPyramid>();');
  });
});

describe('borderfromfill > containment, the clause the brief asked to be proved', () => {
  // `_regionContains` is module-private, so it is re-stated here and then pinned against the
  // source: the assertion is that the shipped predicate is THIS predicate, not that a copy works.
  const contains = (o: { x: number; y: number; w: number; h: number },
    i: { x: number; y: number; w: number; h: number }): boolean =>
    i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;

  it('the shipped predicate is a closed-interval rect containment', () => {
    const body = JAUI.slice(JAUI.indexOf('const _regionContains = ('), JAUI.indexOf('const _regionContains = (') + 500);
    expect(body).toContain('inner.x >= outer.x && inner.y >= outer.y');
    expect(body).toContain('&& inner.x + inner.w <= outer.x + outer.w');
    expect(body).toContain('&& inner.y + inner.h <= outer.y + outer.h');
  });

  it('the FILL region contains the RIM region for `PerfCard` at dpr 2, corner and edge', () => {
    // Both plans are `_glassFillBlurPlan` / `_glassRimBlurPlan`, transcribed here on the numbers
    // `PerfCard : JwiftGlass` resolves to at dpr 2: a 216x150pt card, frost 4pt, Thickness 2.5,
    // Refraction 8, Fillet 0, ChromaticAberration 0.25, ShadowBlur 16pt, ShadowOffsetY 2pt.
    const d = 2;
    const frost = 4;
    const pw = 216 * d;
    const ph = 150 * d;
    const thicknessDev = 2.5 * 1 * d;
    const bulgeMax = 0 * Math.min(pw, ph) * 0.5 * 0.25 * 0.7;
    const refractMax = (thicknessDev + bulgeMax) * 8;
    const caMax = 0.25 * 3;
    const fillMargin = frost * d + refractMax + caMax + 8 * d;
    const rimMargin = frost * d + 8 * d;
    expect(fillMargin).toBeGreaterThan(rimMargin);
    const region = (px: number, py: number, margin: number, w: number, h: number) => ({
      x: Math.max(0, Math.floor(px - margin)),
      y: Math.max(0, Math.floor(py - margin)),
      w: Math.min(w, Math.ceil(pw + margin * 2)),
      h: Math.min(h, Math.ceil(ph + margin * 2)),
    });
    // The five grid columns at dpr 2, and the four rows: left 60pt + n*(216+20)pt, top 70pt + ...
    const W = 2560;
    const H = 1600;
    for (let col = 0; col < 5; col++) {
      for (let row = 0; row < 4; row++) {
        const px = (60 + col * 236) * d;
        const py = (70 + row * 170) * d;
        const fill = region(px, py, fillMargin, W, H);
        const rim = region(px, py, rimMargin, W, H);
        expect(contains(fill, rim), `card ${col},${row}`).toBe(true);
      }
    }
  });

  it('and it FAILS where a canvas clamp would cut the fill region short -- the case that is checked', () => {
    // A card hard against the left edge: the fill's wider margin clamps to 0 on x and its width
    // clamps to the canvas, while the rim's does not. This is the shape the clause exists for, and
    // the point of checking rather than arguing: a class that lands here builds its own rim.
    const fill = { x: 0, y: 0, w: 40, h: 40 };
    const rim = { x: 10, y: 10, w: 60, h: 20 };
    expect(contains(fill, rim)).toBe(false);
  });
});

describe('borderfromfill > what a border-only fragment can actually reach', () => {
  it('the border zone makes exactly ONE backdrop tap, and the Fresnel adds none', () => {
    // The prediction "every differing pixel is inside a border band" rests on this: the taps the
    // Fresnel chain reads are all derived from `borderBackdrop`, which is derived from the one
    // `bSample`. Nothing in the chain samples again, so the gather has no reach of its own.
    const zone = FRAG.slice(FRAG.indexOf('if (borderBase > 0.001) {'));
    const close = zone.indexOf('float borderZoneAlpha');
    const body = zone.slice(0, close);
    expect(body.split('sampleBackdrop(').length - 1).toBe(2); // the two arms of the BORDER_DIRECT gate
    expect(body).toContain('vec3 gather = clamp(borderBackdrop, 0.0, 1.0);');
    expect(body).not.toContain('textureLod(u_Backdrop');
  });

  it('ALPHA does not read the backdrop, so a pixel outside a band cannot move', () => {
    // `borderBase` is a function of `dist` and the two widths; `borderZoneAlpha` is 1 on a
    // border-only pass. Neither reads `bSample`, so the arm changes `result.rgb` inside the band
    // and nothing else -- which is what makes "a differing pixel outside a band is a DEFECT" a
    // checkable claim rather than a hope.
    expect(FRAG).toContain('float borderZoneAlpha = mix(fillAlpha, 1.0, borderOnly);');
    expect(FRAG).toContain('result.a = max(result.a, borderBase * borderZoneAlpha);');
    expect(FRAG).toContain('float borderBase = (1.0 - borderOuter) * borderInner * borderCoverage;');
  });

  it('the band is ~80,300 device px of 3.69 Mpx of quad on glass-grid at dpr 2', () => {
    // The M4 read `bandPx=80297 quadPx=3690240` on the borderdirect3 cell. Reproduced here off
    // `PerfCard`'s own geometry so the pixel prediction below is anchored to a measured number.
    const est = EstimateBorderFragments(
      /* quadW */ 432 + 2 * 36, /* quadH */ 300 + 2 * 36,
      /* halfW */ 216, /* halfH */ 150, /* radius */ 56,
      /* borderWidth */ 0.9, /* borderEdgeAa */ 0.535, /* borderFade */ 1.4);
    expect(est.Band * 20).toBeGreaterThan(75_000);
    expect(est.Band * 20).toBeLessThan(85_000);
  });
});

describe('borderfromfill > THE PICTURE: what the band shows on each arm', () => {
  const G = JWIFT_GLASS_DARK;
  const stops = BedStops();

  it('the port reproduces the shader`s grade and tint exactly as written', () => {
    // Contrast about 0.5, saturation about luma, brightness last; tint a mix toward black at a
    // NEGATIVE signed tint, which is what `TintTone: Ground` resolves to under @Dark.
    expect(ApplyGrading({ R: 0.5, G: 0.5, B: 0.5 }, 1, 1.6, 0.6)).toEqual({ R: 0.5, G: 0.5, B: 0.5 });
    expect(ApplyGrading({ R: 1, G: 1, B: 1 }, 2, 1, 1).R).toBeCloseTo(2, 12);
    expect(ApplyTint({ R: 1, G: 1, B: 1 }, -0.45).R).toBeCloseTo(0.55, 12);
    expect(ApplyTint({ R: 0, G: 0, B: 0 }, 0.45).R).toBeCloseTo(0.45, 12);
    expect(Hsl(4, 92, 52)).toEqual({ R: 245 / 255, G: 35 / 255, B: 20 / 255 });
  });

  it('the two arms differ by ONE application of the body grade and ONE of the body tint', () => {
    // The whole picture claim, stated as an identity rather than as prose. The `scene` arm's sample
    // passes through the FILL's grade and tint on its way into the rim's pyramid; the `fill` arm's
    // does not, and the rim then grades and tints once either way.
    const bed = stops[0];
    const deepInside = BSample(bed, 'scene', 0, G);
    expect(deepInside).toEqual(FillFace(bed, G));
    expect(BSample(bed, 'fill', 0, G)).toEqual(bed);
  });

  it('PREDICTION: the band moves by a mean of ~16 and a max of ~32 of 255 at the outline', () => {
    // `outsideShare` 0.5: the rim's tap sits ON the outline and its kernel straddles it, so half
    // of today's sample is raw bed and half is the card's graded face. This is the number a
    // screenshot diff of `?border-source=fill` against the default should land on.
    const lit = stops.map((s) => Delta8(BorderRgb(BSample(s, 'fill', 0.5, G), 1, G),
      BorderRgb(BSample(s, 'scene', 0.5, G), 1, G)));
    const unlit = stops.map((s) => Delta8(BorderRgb(BSample(s, 'fill', 0.5, G), 0, G),
      BorderRgb(BSample(s, 'scene', 0.5, G), 0, G)));
    const L = Stats(lit);
    const U = Stats(unlit);
    expect(L.Mean).toBeGreaterThan(13); expect(L.Mean).toBeLessThan(19);
    expect(U.Mean).toBeGreaterThan(17); expect(U.Mean).toBeLessThan(24);
    expect(Math.max(L.Max, U.Max)).toBeGreaterThan(25);
    expect(Math.max(L.Max, U.Max)).toBeLessThan(40);
    // Every band moves. There is no bed colour on this scene for which the two arms agree, so a
    // shot that shows an unchanged card is a REFUSED rim, not a matching picture.
    expect(Math.min(L.Min, U.Min)).toBeGreaterThan(3);
  });

  it('and by ~39-41 where the tap sees only the card`s face -- the upper bound', () => {
    // `outsideShare` 0: a tap far enough inside that today's kernel holds no raw bed at all. A
    // JwiftGlass rim never gets there (its `borderInset` is 0 at `Refraction: 8`), so this is the
    // bound the band cannot exceed rather than the value it takes.
    const lit = stops.map((s) => Delta8(BorderRgb(BSample(s, 'fill', 0, G), 1, G),
      BorderRgb(BSample(s, 'scene', 0, G), 1, G)));
    const S = Stats(lit);
    expect(S.Mean).toBeGreaterThan(35);
    expect(S.Mean).toBeLessThan(45);
  });

  it('the change is NOT a uniform darkening: it is more contrast, both ways', () => {
    // Worth pinning because it is the first thing anyone will say about the shot, and it is wrong.
    // Two of the fill arm's differences pull opposite ways -- one fewer Contrast(0.6) compression
    // (more contrast) and one fewer Tint 0.45 pull toward black (brighter) against one fewer
    // Saturate(1.6) (less chroma) -- so a bright saturated band reads DARKER on the fill arm and a
    // dark band reads BRIGHTER. "The border takes its tone from the backdrop" is the honest
    // sentence; "the border goes darker" is not.
    const signed = stops.map((s) => LumaDelta8(BorderRgb(BSample(s, 'fill', 0.5, G), 1, G),
      BorderRgb(BSample(s, 'scene', 0.5, G), 1, G)));
    expect(Math.max(...signed)).toBeGreaterThan(8);
    expect(Math.min(...signed)).toBeLessThan(-5);
  });

  it('a NEUTRAL backdrop still moves, so the effect is not only chroma', () => {
    // Grey in, grey out on both arms -- the saturation terms cancel and only the contrast and the
    // tint remain. A rim over a grey bed is the cleanest read of the change there is.
    const grey = { R: 0.5, G: 0.5, B: 0.5 };
    const d = Delta8(BorderRgb(BSample(grey, 'fill', 0.5, G), 1, G),
      BorderRgb(BSample(grey, 'scene', 0.5, G), 1, G));
    expect(d).toBeGreaterThan(2);
  });
});

describe('borderfromfill > JwiftSolidGlass keeps its own rim, and that is the right answer', () => {
  it('a slab with `Refraction: 0` and no backdrop filter takes no fill pyramid at all', () => {
    // `_glassFillTakesPyramid` is `(_isGlass && Refraction !== 0) || _hasBackdropFilter`. The class
    // authors `Refraction: 0`, no `BackdropFilter`, no `Tint` -- so its FILL renders as a plain
    // panel and there is no record for its rim to find. Clause 2 refuses it as `noFill`, and the
    // refusal is CORRECT rather than a miss: a solid card occludes what is behind it, its rim
    // gathers from the card's own content through `solidness`'s inward inset, and a pyramid of the
    // bed does not hold that content.
    const body = arrowBody(JAUI, '_glassFillTakesPyramid');
    expect(body).toContain("node.RenderStyle.Refraction !== 0");
    expect(body).toContain('_hasBackdropFilter(node)');
    expect(FRAG).toContain('float solidness = 1.0 - smoothstep(0.0, 4.0, refractionStrength);');
    expect(FRAG).toContain(
      'float borderInset = (max(bezelWidth * 0.75, 6.0) * 1.2 + localBorderWidth) * solidness;');
  });

  it('and the refusal is counted, so a scene of them reads `fromFill=0 noFill=20`', () => {
    expect(JAUI).toContain('st.NoFill++');
    expect(JAUI).toContain('` noFill=${st.NoFill} stale=${st.Stale} snap=${st.Snap}`');
  });
});
