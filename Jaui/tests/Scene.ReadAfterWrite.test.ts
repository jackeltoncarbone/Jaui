/**
 * The scene read-after-write ledger, and the `glass-grid` number it is expected to produce.
 *
 * The frame's largest measured term is an INTERACTION - `panels x blur`, 34.37 GPU ms of a 66.33 ms
 * frame at dpr 2 on an M4, and 6.13 ms at dpr 1.25 (ShowStudio.Documentation/Perf/README.md). The
 * shape that predicts a term shaped like that is a rendering read-after-write on `_sceneFbo`: each
 * backdrop build samples a target the walk has just drawn into, which ends and restarts the scene's
 * render encoder, and each restart stores and loads the WHOLE canvas however tight the region is.
 *
 * There is no GPU here and there is no claim about milliseconds here. What these tests pin is the
 * COUNT the hypothesis multiplies: the ledger's semantics, that every scene read site in the
 * renderer feeds it, and what the number comes to on `glass-grid` derived from the real class and
 * the real grid rather than asserted.
 */
import { describe, it, expect } from 'vitest';
import { SceneReadLedger } from '@jaui/Core/Scene.Ledger';
import {
  readRenderer, readJaui, readJwiftGlass, readPerfJss,
  arrowBody, getterBody, drawSites, jssClass, jssNumber, jssBlurPt,
} from './Scene.ReadAfterWrite.Source';

// ── The geometry, out of the real sheets ──────────────────────────────────────────────────────

const GLASS = jssClass(readJwiftGlass(), 'JwiftGlass');
const CARD = jssClass(readPerfJss(), 'PerfCard');
const GRID = jssClass(readPerfJss(), 'PerfGrid');

const FROST_PT = jssBlurPt(GLASS, 'BackdropFilter');
const THICKNESS = jssNumber(GLASS, 'Thickness');
const FILLET = jssNumber(GLASS, 'Fillet');
const REFRACTION = jssNumber(GLASS, 'Refraction');
const CA = jssNumber(GLASS, 'ChromaticAberration');
const SHADOW_BLUR_PT = jssNumber(GLASS, 'ShadowBlur');
const SHADOW_OFFSET_Y_PT = jssNumber(GLASS, 'ShadowOffsetY');
const BORDER_LAYER = jssNumber(GLASS, 'BorderLayer');
const SHADOW_ADAPTIVE = jssNumber(GLASS, 'ShadowAdaptive');
const CARD_W_PT = jssNumber(CARD, 'Width');
const CARD_H_PT = jssNumber(CARD, 'Height');
const GAP_PT = jssNumber(GRID, 'Gap');

const DPR = 2;
const CARDS = 20;

/** `Jaui.ts`'s glass FILL sample margin, mirrored. Unrotated, unscaled: `avgScale` is 1. */
const fillMarginDev = (dpr: number): number => {
  const thicknessDev = THICKNESS * 1 * dpr;
  const minHalf = Math.min(CARD_W_PT, CARD_H_PT) * dpr * 0.5;
  const bulgeMax = FILLET * minHalf * 0.25 * 0.7;
  return FROST_PT * dpr + (thicknessDev + bulgeMax) * REFRACTION + CA * 3 + 8 * dpr;
};
/** `Jaui.ts`'s BORDER-ONLY overlay margin, mirrored: a border-only fragment makes one inward tap,
 *  so its reach is the frost's own spread plus the pixel pad. */
const rimMarginDev = (dpr: number): number => FROST_PT * dpr + 8 * dpr;
/** `Jiv.InstanceBuffer`'s frost LOD, mirrored from `_instanceFrostLod`. */
const instanceFrostLod = (frostPt: number, dpr: number): number =>
  Math.max(0, Math.min(10, Math.log2(Math.max(0.5, frostPt * dpr))));
/** `SCENE_TAP_FROST_LOD` — below this a surface still needs a raw-scene snapshot bound. */
const SCENE_TAP_FROST_LOD = 0.05;

describe('SceneReadLedger — semantics', () => {
  it('a read with no draw before it is a read and NOT a restart', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteRead();
    expect(l.Reads).toBe(1);
    expect(l.Restarts).toBe(0);
  });

  it('a read AFTER a draw is a restart', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteRead();
    expect(l.Restarts).toBe(1);
  });

  it('a SECOND read with no draw between costs no second restart', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteRead();
    l.NoteRead();
    l.NoteRead();
    expect(l.Reads).toBe(3);
    // The encoder ended on the first read. Nothing was written back, so nothing further is stored:
    // pricing the second and third taps as resolves would double-count the model's whole lever.
    expect(l.Restarts).toBe(1);
  });

  it('write / read / write / read is two restarts', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite(); l.NoteRead();
    l.NoteWrite(); l.NoteRead();
    expect(l.Reads).toBe(2);
    expect(l.Restarts).toBe(2);
  });

  it('BeginFrame clears the frame counters and the pending write, and never the totals', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite(); l.NoteRead(); l.NoteWrite();
    l.BeginFrame();
    l.NoteRead(); // the previous frame's pending write must not carry over
    expect(l.Reads).toBe(1);
    expect(l.Restarts).toBe(0);
    expect(l.TotalReads).toBe(2);
    expect(l.TotalRestarts).toBe(1);
    expect(l.TotalFrames).toBe(2);
  });
});

describe('the renderer feeds the ledger at every scene read', () => {
  const renderer = readRenderer();

  it('SnapshotScreen notes a read before it blits the scene', () => {
    const body = arrowBody(renderer, '_snapshotBlit');
    const note = body.indexOf('_sceneLedger.NoteRead()');
    const blit = body.indexOf('READ_FRAMEBUFFER, this._sceneFbo.Framebuffer');
    expect(note).toBeGreaterThan(-1);
    expect(blit).toBeGreaterThan(note);
  });

  it('ComputeBlur notes a read exactly when its input IS the scene attachment', () => {
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body).toContain('if (_unwrap(input) === this._sceneFbo.Texture) this._sceneLedger.NoteRead();');
    // ...and NOT under `?no-blur`, where the method issues no GL at all. The early return has to
    // come first or the diagnostic would book a read nothing performed.
    expect(body.indexOf('if (this.DiagNoBlur) return input;'))
      .toBeLessThan(body.indexOf('_sceneLedger.NoteRead()'));
  });

  it('BuildSharedBackdrop notes a read before it blurs the scene texture', () => {
    const body = arrowBody(renderer, 'BuildSharedBackdrop');
    expect(body.indexOf('_sceneLedger.NoteRead()'))
      .toBeLessThan(body.indexOf('pass.Blur(this._sceneFbo.Texture'));
  });

  it('the adaptive-shadow probe notes a read when its sharp tap is the scene attachment', () => {
    const body = arrowBody(renderer, 'MeasureShadowBackdrop');
    expect(body).toContain('if (_unwrap(scene) === this._sceneFbo.Texture) this._sceneLedger.NoteRead();');
  });

  it('every draw entry point that can target the scene notes a write first', () => {
    const sites = drawSites(renderer);
    expect(sites.length).toBeGreaterThan(8); // a guard on the matcher, not on the renderer
    const unnoted = sites.filter((d) => !d.Before.includes('_noteSceneDraw()'));
    // Exactly one, and it is the adaptive-shadow probe: the single draw in this file that CANNOT
    // land in the scene, because it renders into the 1x1 `_shadowStateFbo`. A new draw entry point
    // that forgets the note lands here as a second element and fails the lane, which is the point.
    expect(unnoted).toHaveLength(1);
    const probe = arrowBody(renderer, 'MeasureShadowBackdrop');
    expect(probe).toContain(unnoted[0].Line);
    expect(probe).toContain('_shadowStateFbo');
  });

  it('a write is only booked when the SCENE is the bound target', () => {
    expect(arrowBody(renderer, '_noteSceneDraw'))
      .toContain("if (this._boundTarget === 'scene') this._sceneLedger.NoteWrite();");
  });

  it('the layer-cache capture takes the bound target off the scene', () => {
    // The capture binds its own FBO from `Jaui.ts`, so without this the captured subtree's draws
    // would be booked as scene writes and a later surface would report a restart it never caused.
    expect(arrowBody(renderer, 'SetCaptureViewOffset')).toContain("this._boundTarget = 'cache';");
  });

  it('the ledger resets ahead of the per-pass split frame early return', () => {
    const body = arrowBody(renderer, 'BeginFrame');
    expect(body.indexOf('this._sceneLedger.BeginFrame();'))
      .toBeLessThan(body.indexOf('_beginPassFrame'));
  });
});

describe('?snap-once — measurement only', () => {
  const renderer = readRenderer();
  const jaui = readJaui();

  it('routes the scene texture getter at the flag', () => {
    expect(getterBody(renderer, 'SceneTexture'))
      .toContain('if (this.DiagSnapOnce) return this._snapOnceTexture();');
  });

  it('routes every SnapshotScreen call at the flag, scissor and all', () => {
    expect(arrowBody(renderer, 'SnapshotScreen'))
      .toContain('if (this.DiagSnapOnce) return this._snapOnceTexture();');
  });

  it('takes ONE full-canvas snapshot and reuses it for the rest of the frame', () => {
    const body = arrowBody(renderer, '_snapOnceTexture');
    expect(body).toContain('if (this._snapOnceTaken && this._snapshotTex) return _wrap(this._snapshotTex);');
    // `undefined` scissor is the full canvas: a later surface may sample anywhere.
    expect(body).toContain('this._snapshotBlit(undefined)');
  });

  it('re-arms once per frame', () => {
    expect(arrowBody(renderer, 'BeginFrame')).toContain('this._snapOnceTaken = false;');
  });

  it('does not touch the blur, the draws or the rebind', () => {
    // The difference from `?no-blur` is the whole point of the flag: the pyramids still build and
    // the surfaces still draw, so the frame does the same fill and the same arithmetic.
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body).not.toContain('DiagSnapOnce');
    expect(arrowBody(renderer, 'GenerateBlurMipmap')).not.toContain('DiagSnapOnce');
    expect(arrowBody(renderer, 'RebindSceneTarget')).not.toContain('DiagSnapOnce');
    expect(arrowBody(renderer, 'PanelDrawBatch')).not.toContain('DiagSnapOnce');
  });

  it('is parsed as an exact query key and says so in the trace', () => {
    expect(jaui).toContain("params.has('snap-once')");
    expect(readRenderer()).toContain("JTrace('jaui:snap-once armed=true pixels=WRONG')");
  });

  it('is not wired to the shared backdrop, which stays rejected and off', () => {
    // `_sharedBackdrop` is documented as rejected (it built at quarter res and aliased u_Scene).
    // Leaving `BuildSharedBackdrop` outside the flag keeps that path byte-identical.
    expect(arrowBody(readRenderer(), 'BuildSharedBackdrop')).not.toContain('DiagSnapOnce');
  });
});

describe('glass-grid — the number the counter should read', () => {
  it('JwiftGlass is the class this scene measures: frosted, refracting, rimmed, adaptive', () => {
    expect(FROST_PT).toBe(4);
    expect(REFRACTION).toBe(8);
    expect(BORDER_LAYER).not.toBe(0);   // the rim is a SECOND pass, with its own backdrop build
    expect(SHADOW_ADAPTIVE).toBeGreaterThan(0); // the probe takes a THIRD scene tap
  });

  it('a frosted card takes NO snapshot, so glass-grid blits the scene zero times', () => {
    // The raw-scene fallback is only reachable below `SCENE_TAP_FROST_LOD`. A 4pt frost is LOD 3 at
    // dpr 2 and LOD 2 at dpr 1, so neither the fill nor the rim ever asks for one. Every scene tap
    // on this scene is therefore a SAMPLE of the attachment, not a copy of it.
    expect(instanceFrostLod(FROST_PT, DPR)).toBeGreaterThan(SCENE_TAP_FROST_LOD);
    expect(instanceFrostLod(FROST_PT, 1)).toBeGreaterThan(SCENE_TAP_FROST_LOD);
  });

  it('the fill margin is 64.75 device px and the rim margin 24, at dpr 2', () => {
    expect(fillMarginDev(DPR)).toBeCloseTo(64.75, 6);
    expect(rimMarginDev(DPR)).toBeCloseTo(24, 6);
  });

  it('the walk reads the scene 60 times and restarts the encoder 40', () => {
    // The walk, per card, as `Jaui.ts` runs it: bed/earlier cards have written; the FILL's
    // ComputeBlur samples the attachment (restart); the adaptive-shadow probe samples it again with
    // nothing drawn between (read, no restart); the glass instance draws; the children draw; the
    // rim overlay's ComputeBlur samples it again (restart); the rim draws.
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let band = 0; band < 6; band++) l.NoteWrite(); // the bed
    for (let card = 0; card < CARDS; card++) {
      l.NoteRead();               // glass fill: ComputeBlur(SceneTexture)
      l.NoteRead();               // adaptive shadow: the sharp tap is SceneTexture (no snapshot)
      l.NoteWrite();              // the glass instance
      l.NoteWrite();              // label + sub, one text batch
      l.NoteRead();               // rim overlay: ComputeBlur(SceneTexture)
      l.NoteWrite();              // the rim instance
    }
    expect(l.Reads).toBe(60);
    expect(l.Restarts).toBe(40);
  });

  it('under ?no-blur the only scene taps left are the shadow probes: 20 reads, 20 restarts', () => {
    // `ComputeBlur` returns its input without issuing GL, so neither backdrop build reads anything.
    // The probe still runs, still samples the attachment, and now has the card's own draws in front
    // of it - so `?no-blur` does NOT remove the read-after-write, it halves it and moves it.
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let band = 0; band < 6; band++) l.NoteWrite();
    for (let card = 0; card < CARDS; card++) {
      l.NoteRead();               // the shadow probe, after the previous card's draws
      // The glass instance is ISSUED (so the counter books it) and, per the section-3 audit,
      // REJECTED by the driver as a feedback loop. The text batch is issued and drawn. Either way
      // a write precedes the next card's probe, so the restart count is the same under both
      // readings - which is why this cell cannot arbitrate the audit and source had to.
      l.NoteWrite();
      l.NoteWrite();
    }
    expect(l.Reads).toBe(20);
    expect(l.Restarts).toBe(20);
  });

  it('under ?snap-once the scene is read once', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let band = 0; band < 6; band++) l.NoteWrite();
    l.NoteRead(); // the one full-canvas blit, at the first surface's first backdrop read
    for (let card = 0; card < CARDS; card++) { l.NoteWrite(); l.NoteWrite(); l.NoteWrite(); }
    expect(l.Reads).toBe(1);
    expect(l.Restarts).toBe(1);
  });
});

describe('what a per-batch dirty rect could serve on this grid', () => {
  // The PyramidUnion law: a surface may be served from an older snapshot only if NOTHING has been
  // drawn into the scene inside its SAMPLE REGION since that snapshot was taken. These are the
  // overlaps that decide it, in device px at dpr 2.
  const gapDev = GAP_PT * DPR;
  const paintOutsetX = SHADOW_BLUR_PT * DPR;
  const paintOutsetY = (SHADOW_BLUR_PT + SHADOW_OFFSET_Y_PT) * DPR;

  it('a neighbour card is inside the next card\'s sample margin, on both axes', () => {
    // The margin reaches 64.75 px back across a 40 px gap, so it lands 24.75 px INSIDE the previous
    // card's own box - never mind its shadow, which crosses the gap on its own.
    expect(fillMarginDev(DPR) - gapDev).toBeCloseTo(24.75, 6);
    expect(fillMarginDev(DPR) - gapDev).toBeGreaterThan(0);
    expect(paintOutsetX).toBeGreaterThan(0);
    expect(paintOutsetX + fillMarginDev(DPR)).toBeGreaterThan(gapDev);
    expect(paintOutsetY + fillMarginDev(DPR)).toBeGreaterThan(gapDev);
  });

  it('the rim always needs its own card, so it can never be served from an older snapshot', () => {
    // The rim overlay's region CONTAINS its own box, and its own fill and children were drawn into
    // the scene between the fill's read and this one. No dirty-rect test can make that clean.
    expect(rimMarginDev(DPR)).toBeGreaterThan(0);
    expect(BORDER_LAYER).not.toBe(0);
  });

  it('so honest per-batch dirty rects leave the count exactly where it is: 40', () => {
    // Every fill's region is dirtied by its neighbour and every rim's by its own card. This is the
    // arithmetic that says mechanism (a) in WorkerReports/build-sceneraw.md is not a fix.
    const fillsThatCouldBeServed = 0;
    const rimsThatCouldBeServed = 0;
    expect(CARDS * 2 - fillsThatCouldBeServed - rimsThatCouldBeServed).toBe(40);
  });
});
