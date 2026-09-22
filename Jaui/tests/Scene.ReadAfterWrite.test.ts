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
  const refractMax = THICKNESS * 1 * dpr * REFRACTION;
  return FROST_PT * dpr + refractMax + 0.2 * CA * refractMax + 8 * dpr;
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
    // Exactly two, and BOTH are draws that cannot land in the scene because they render into a 1x1
    // target of their own. A new draw entry point that forgets the note lands here as a third
    // element and fails the lane, which is the point.
    expect(unnoted).toHaveLength(2);
    // (1) The adaptive-shadow probe, into `_shadowStateFbo`.
    const shadow = arrowBody(renderer, 'MeasureShadowBackdrop');
    expect(shadow).toContain('_shadowStateFbo');
    // (2) `?scene-restarts` / `?small-restarts`'s restart probe. It MUST NOT note a write: it is
    //     the draw that ENDS the scene's encoder by landing somewhere else -- the blur pass's own
    //     level 0 on the scene arm, a 1x1 target on the small one -- and booking it as a scene
    //     write would price a restart the frame did not take. Its ONE scene-side draw, which does
    //     land in the scene, is noted, so this method contributes exactly one unnoted site.
    const restart = arrowBody(renderer, '_restartProbe');
    expect(restart).toContain('_restartProbeFbos[slot]');
    expect(restart).toContain('level0.Bind();');
    expect(restart.match(/_noteSceneDraw\(\);/g)).toHaveLength(1);
    for (const d of unnoted) expect(shadow.includes(d.Line) || restart.includes(d.Line)).toBe(true);
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

  it('the fill margin is 66 device px and the rim margin 24, at dpr 2', () => {
    expect(fillMarginDev(DPR)).toBeCloseTo(66, 6);
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
    // The margin reaches 66 px back across a 40 px gap, so it lands 26 px INSIDE the previous
    // card's own box - never mind its shadow, which crosses the gap on its own.
    expect(fillMarginDev(DPR) - gapDev).toBeCloseTo(26, 6);
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

// ── THE THIRD COLUMN: ENCODER SWITCHES ────────────────────────────────────────────────────────
//
// `?snap-once` took `Restarts` from 40 to 1 on `glass-grid` and the frame did not move at all
// (72.85 -> 73.59 GPU ms at dpr 2 on an M4; ShowStudio.Documentation/Perf/README.md). A scene READ
// forcing a resolve is refuted as the mechanism behind the 34 ms `panels x blur` interaction. What
// is left is the encoder BOUNDARY, which a read is only one way to cause: a Metal render encoder on
// the scene ends whenever ANY other target is bound and drawn into, and every pyramid build binds
// the blur FBOs between one card's draw and the next. Under `?snap-once` that still happened forty
// times; only the reads were rerouted, and the ledger never counted the switches.
//
// Everything below pins the new column's semantics, that the renderer feeds it at every place a
// framebuffer is bound, what `?blur-dummy` does and does not touch, and the number the column
// should read in each cell -- derived from the real classes and the real walk, not asserted. The
// sections above are left byte-for-byte as they were: the M4 has measured numbers against them.

describe('SceneReadLedger — switch semantics', () => {
  it('binding a non-scene target over a dirty scene is a switch', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteTargetBind('blur');
    expect(l.Switches).toBe(1);
  });

  it('binding the scene is never a switch, however dirty it is', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteTargetBind('scene');
    l.NoteTargetBind('scene');
    expect(l.Switches).toBe(0);
  });

  it('a switch over a CLEAN scene costs nothing', () => {
    // Nothing was drawn, so there are no tiles to store: the encoder was never open over content.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteTargetBind('blur');
    l.NoteTargetBind('snapshot');
    expect(l.Switches).toBe(0);
  });

  it('ENCODER ENDS, not GL calls: one build binds four targets and books ONE', () => {
    // The semantic the brief asked to be decided rather than assumed. A `ComputeBlur` binds a level
    // FBO per pyramid level and `GenerateBlurMipmap` binds more, all with no scene draw between
    // them -- and the scene's encoder ended at the FIRST of them and cannot end again until
    // something is drawn back into the scene. So the number is builds, not binds.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteTargetBind('blur');
    l.NoteTargetBind('blur');
    l.NoteTargetBind('blur');
    l.NoteTargetBind('blur');
    expect(l.Switches).toBe(1);
    l.NoteWrite();               // back on the scene, and dirty again
    l.NoteTargetBind('blur');
    expect(l.Switches).toBe(2);
  });

  it('a read and a switch at the same instant are BOTH counted', () => {
    // `ComputeBlur` notes a read and then BlurPass binds its FBO. One shared dirty flag would let
    // whichever fired first swallow the other, and the two columns would stop being comparable --
    // which is exactly the comparison this lane needs to make on `?snap-once`.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteRead();
    l.NoteTargetBind('blur');
    expect(l.Restarts).toBe(1);
    expect(l.Switches).toBe(1);
  });

  it('the frame-end drain silences the present without counting it', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteFrameEndDrain();
    l.NoteTargetBind('default');   // PresentScene
    l.NoteTargetBind('default');   // InvalidateFrameTransients
    expect(l.Switches).toBe(0);
  });

  it('BeginFrame clears the switch counters and the pending switch, never the total', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite(); l.NoteTargetBind('blur'); l.NoteWrite();
    l.BeginFrame();
    l.NoteTargetBind('blur');      // the previous frame's pending write must not carry over
    expect(l.Switches).toBe(0);
    expect(l.TotalSwitches).toBe(1);
  });

  it('the two older columns are untouched by the third', () => {
    // A switch must not move `Reads` or `Restarts` by so much as one. Every table in the README was
    // read under their old meaning and the M4 has numbers against them.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteTargetBind('blur');
    l.NoteTargetBind('snapshot');
    expect(l.Reads).toBe(0);
    expect(l.Restarts).toBe(0);
    expect(l.TotalReads).toBe(0);
    expect(l.TotalRestarts).toBe(0);
  });
});

describe('the renderer feeds the switch column everywhere a target is bound', () => {
  const renderer = readRenderer();

  it('_tgt notes every bind it makes', () => {
    expect(arrowBody(renderer, '_tgt')).toContain('this._sceneLedger.NoteTargetBind(key);');
  });

  it('the layer-cache capture notes its own, because it bypasses _tgt', () => {
    const body = arrowBody(renderer, 'SetCaptureViewOffset');
    expect(body).toContain("this._boundTarget = 'cache';");
    expect(body).toContain("this._sceneLedger.NoteTargetBind('cache');");
  });

  it('ComputeBlur notes a switch before BlurPass binds its own levels', () => {
    // BlurPass binds its FBOs with raw GL that never reaches `_tgt`, so without this line the most
    // common encoder end in the frame would be invisible to the column built to see it.
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body.indexOf("this._sceneLedger.NoteTargetBind('blur');"))
      .toBeLessThan(body.indexOf('pass.Blur(_unwrap(input)'));
  });

  it('GenerateBlurMipmap and BuildSharedBackdrop note theirs too', () => {
    expect(arrowBody(renderer, 'GenerateBlurMipmap')).toContain("this._sceneLedger.NoteTargetBind('blur');");
    const shared = arrowBody(renderer, 'BuildSharedBackdrop');
    expect(shared.indexOf("this._sceneLedger.NoteTargetBind('blur');"))
      .toBeLessThan(shared.indexOf('pass.Blur(this._sceneFbo.Texture'));
  });

  it('PresentScene DRAINS rather than counts, ahead of its own bind', () => {
    const body = arrowBody(renderer, 'PresentScene');
    expect(body).toContain('this._sceneLedger.NoteFrameEndDrain();');
    expect(body.indexOf('NoteFrameEndDrain'))
      .toBeLessThan(body.indexOf('READ_FRAMEBUFFER, this._sceneFbo.Framebuffer'));
    // It must not book one either, or every cell would carry a constant the restart column does not.
    expect(body).not.toContain('NoteTargetBind');
  });

  it('the renderer exposes the column and the cumulative total', () => {
    expect(renderer).toContain('get SceneSwitches(): number { return this._sceneLedger.Switches; }');
    // Asserted against the file, not `getterBody`: this accessor's RETURN TYPE is an inline object
    // literal, so the first brace after the name is the type's and the brace matcher walks that.
    expect(renderer).toContain('Switches: l.TotalSwitches');
  });

  it('Jaui.ts carries it to all four readers', () => {
    const jaui = readJaui();
    expect(jaui).toContain('this._counts.SceneSwitches = this._renderer.SceneSwitches;');
    expect(jaui).toContain('sceneSwitches=');                    // jaui:render:end
    expect(jaui).toContain('/${this._counts.SceneSwitches}');    // the [Jaui] per-second line
    expect(jaui).toContain('switches ${c.SceneSwitches}');       // the debug HUD
    expect(jaui).toContain('Switches: number; Frames: number }'); // __jauiSceneLedger
    expect(jaui).toContain('this._counts.SceneSwitches = 0;');   // reset with the other two
  });
});

describe('?blur-dummy — measurement only', () => {
  const renderer = readRenderer();
  const jaui = readJaui();

  it('ComputeBlur returns a FOREIGN texture, not the input', () => {
    // Returning the input is precisely what makes `?no-blur` a rendering feedback loop: the glass
    // draw binds the scene's own attachment as `u_Backdrop` while rendering into it, and all forty
    // instances are refused. The dummy is not the scene attachment, so every draw lands -- which is
    // the difference between an ablation of the BLUR and an ablation of the TARGET SWITCH.
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body).toContain('if (this.DiagBlurDummy) return this._blurDummyTexture();');
    expect(body).not.toContain('if (this.DiagBlurDummy) return input;');
  });

  it('?no-blur is checked FIRST and is not altered', () => {
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body).toContain('if (this.DiagNoBlur) return input;');
    expect(body.indexOf('DiagNoBlur')).toBeLessThan(body.indexOf('DiagBlurDummy'));
    // ...and no ledger call may sit between them, or `?no-blur`'s measured 20/20 would move.
    const between = body.slice(body.indexOf('DiagNoBlur'), body.indexOf('DiagBlurDummy'));
    expect(between).not.toContain('_sceneLedger');
  });

  it('the mipmap build issues nothing and books no switch', () => {
    const body = arrowBody(renderer, 'GenerateBlurMipmap');
    expect(body.indexOf('if (this.DiagBlurDummy) return;'))
      .toBeLessThan(body.indexOf("NoteTargetBind('blur')"));
  });

  it('SnapshotScreen returns the dummy WITHOUT blitting', () => {
    const body = arrowBody(renderer, 'SnapshotScreen');
    // Ahead of `?snap-once`, whose path does blit. Compared on the two RETURN STATEMENTS rather
    // than on the flag names, which also appear in the prose above them.
    expect(body.indexOf('if (this.DiagBlurDummy) return this._blurDummyTexture();'))
      .toBeLessThan(body.indexOf('if (this.DiagSnapOnce) return this._snapOnceTexture();'));
  });

  it("the adaptive shadow's sharp tap reads the dummy too, so it books no scene read", () => {
    // `MeasureShadowBackdrop` is handed `sceneSnap ?? r.SceneTexture`, and on a frosted card
    // `sceneSnap` is null -- so the getter is the only place this can be intercepted.
    const body = getterBody(renderer, 'SceneTexture');
    expect(body.indexOf('if (this.DiagBlurDummy) return this._blurDummyTexture();'))
      .toBeLessThan(body.indexOf('if (this.DiagSnapOnce) return this._snapOnceTexture();'));
  });

  it('the dummy is one opaque mid-grey texel over the IDENTITY region', () => {
    const body = arrowBody(renderer, '_blurDummyTexture');
    expect(body).toContain('new Uint8Array([128, 128, 128, 255])');
    // No region argument: like the `?no-blur` passthrough it covers the whole canvas, so every
    // consumer's backdrop transform is `BACKDROP_REGION_FULL`.
    expect(body).toContain('return _wrap(tex);');
    expect(body).not.toContain('_wrap(tex,');
    // LINEAR (not a mipmap filter) is what makes a single texel a legal answer to a textureLod at
    // the card's frost LOD of 3: with a non-mipmap min filter every LOD resolves to level 0.
    expect(body).toContain('gl.TEXTURE_MIN_FILTER, gl.LINEAR');
  });

  it('it does not touch the draws, the rebind, the probe or the pyramid pool', () => {
    expect(arrowBody(renderer, 'PanelDrawBatch')).not.toContain('DiagBlurDummy');
    expect(arrowBody(renderer, 'RebindSceneTarget')).not.toContain('DiagBlurDummy');
    expect(arrowBody(renderer, 'MeasureShadowBackdrop')).not.toContain('DiagBlurDummy');
    expect(arrowBody(renderer, 'BuildSharedBackdrop')).not.toContain('DiagBlurDummy');
  });

  it('is parsed as an exact query key and says so in the trace', () => {
    expect(jaui).toContain("params.has('blur-dummy')");
    expect(renderer).toContain("JTrace('jaui:blur-dummy armed=true pixels=WRONG')");
  });
});

describe('glass-grid — what the switch column should read in each cell', () => {
  /** The walk, per card, in switch terms. `blur` is the pyramid build's first level bind (one per
   *  build, whatever the depth); `shadow-state` is the adaptive probe's 1x1 target. */
  const walk = (opts: { Blur: boolean; Bed: boolean; Shadow: boolean }): SceneReadLedger => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    if (opts.Bed) for (let band = 0; band < 6; band++) l.NoteWrite();
    for (let card = 0; card < CARDS; card++) {
      if (opts.Blur) l.NoteTargetBind('blur');        // glass fill: ComputeBlur
      if (opts.Shadow) l.NoteTargetBind('shadow-state');
      l.NoteWrite();                                  // the glass instance
      l.NoteWrite();                                  // label + sub, one text batch
      if (opts.Blur) l.NoteTargetBind('blur');        // rim overlay: ComputeBlur
      l.NoteWrite();                                  // the rim instance
    }
    l.NoteFrameEndDrain();
    return l;
  };

  it('baseline: 40 switches, the same number as the measured restarts', () => {
    // Two pyramid builds per card and nothing else gets there first. The adaptive probe binds its
    // own target immediately after the fill's build, with no scene draw between, so it is free.
    expect(walk({ Blur: true, Bed: true, Shadow: true }).Switches).toBe(40);
  });

  it('?snap-once: 40 switches, UNCHANGED - which is the one-line explanation of its null', () => {
    // The reads go to one snapshot (`Restarts` 1, measured on the M4). The pyramids still build,
    // and they still build BETWEEN one card's draws and the next, so the encoder still ends forty
    // times with the bed loaded back each time. The first switch is the snapshot's own target bind
    // instead of card 0's blur bind; the count does not move.
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let band = 0; band < 6; band++) l.NoteWrite();
    l.NoteRead(); l.NoteTargetBind('snapshot');     // the one full-canvas blit
    for (let card = 0; card < CARDS; card++) {
      l.NoteTargetBind('blur');                     // fill build: free on card 0, a switch after
      l.NoteTargetBind('shadow-state');
      l.NoteWrite(); l.NoteWrite();
      l.NoteTargetBind('blur');                     // rim build
      l.NoteWrite();
    }
    l.NoteFrameEndDrain();
    expect(l.Restarts).toBe(1);
    expect(l.Switches).toBe(40);
  });

  it('?no-panels: 39, for the same reason its restarts are 39', () => {
    // The bed never draws, so card 0's fill build crosses a clean scene.
    expect(walk({ Blur: true, Bed: false, Shadow: true }).Switches).toBe(39);
  });

  it('?no-blur: 20, the adaptive probes', () => {
    // No pyramid binds anything. The probe's 1x1 target is the only non-scene bind left, and it now
    // has the PREVIOUS card's draws in front of it instead of its own card's build.
    expect(walk({ Blur: false, Bed: true, Shadow: true }).Switches).toBe(20);
  });

  it('?blur-dummy: 20, and they are the adaptive probes and nothing else', () => {
    // NOT zero, and this is the lane's own correction to its brief. `JwiftGlass` authors
    // `ShadowAdaptive: 0.85` over a 0.28-alpha shadow, so every card runs `MeasureShadowBackdrop`,
    // which binds a 1x1 RGB10_A2 state target -- a real encoder end over a scene the previous
    // card's rim has just dirtied. The flag removes the forty blur binds and cannot remove these
    // twenty. `?blur-dummy&no-shadow` is the cell that reaches 0, and `?no-shadow` already exists.
    expect(SHADOW_ADAPTIVE).toBeGreaterThan(0);
    const l = walk({ Blur: false, Bed: true, Shadow: true });
    expect(l.Switches).toBe(20);
    // `SceneTexture` hands out the dummy under the flag, so nothing samples the attachment at all.
    expect(l.Reads).toBe(0);
    expect(l.Restarts).toBe(0);
  });

  it('?blur-dummy&no-shadow: 0 switches, 0 reads, 0 restarts', () => {
    const l = walk({ Blur: false, Bed: true, Shadow: false });
    expect(l.Switches).toBe(0);
    expect(l.Reads).toBe(0);
    expect(l.Restarts).toBe(0);
  });

  it('glass-grid-flat reads exactly what glass-grid reads, in all three columns', () => {
    // The flat bed changes the CONTENT of the target and nothing about the walk: same six bands,
    // same twenty cards, same two builds each, same probe. If the flat scene ever reports a
    // different count it has stopped being the same scene, and its cell is void.
    const gradient = walk({ Blur: true, Bed: true, Shadow: true });
    const flat = walk({ Blur: true, Bed: true, Shadow: true });
    expect(flat.Switches).toBe(gradient.Switches);
    expect(flat.Reads).toBe(gradient.Reads);
    expect(flat.Restarts).toBe(gradient.Restarts);
  });
});

// ── ADDED: the per-target breakdown of the switch column ──────────────────────────────────────
//
// Everything above this line is byte-for-byte what it was: the M4 has measured numbers against
// every table in it, and `Reads`, `Restarts` and `Switches` must keep meaning exactly what they
// meant when those numbers were taken.
//
// What is new is a FOURTH reading of the same events. An encoder end prices by TARGET SIZE -- the
// per-end cost floors measured at dpr 0.375/0.5 put it at ~0.12 ms below the 6.4-9.2 MB cliff and
// 1.1-1.5 ms above it -- so "one end" is not a cost and "four ends" is not four times one. A frame
// with four ends on 1 MB card targets and a frame with four ends on the 16 MB scene read the same
// in the scalar and are ~5 ms apart on the clock. Three columns each reading low while the frame
// stayed slow is the failure mode this phase has already paid for once; this one names the target.

describe('EndsByKey — the switch column priced by what it ended ON', () => {
  it('sums to Switches exactly, because it is incremented in the same branch', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite(); l.NoteTargetBind('snapshot');
    l.NoteWrite(); l.NoteTargetBind('blur');
    l.NoteWrite(); l.NoteTargetBind('blur');
    l.NoteWrite(); l.NoteTargetBind('card');
    const total = Object.values(l.EndsByKey).reduce((a, b) => a + b, 0);
    expect(total).toBe(l.Switches);
    expect(l.EndsByKey).toEqual({ snapshot: 1, blur: 2, card: 1 });
  });

  it('a bind that is NOT an end is not in the breakdown either', () => {
    // The dirty flag clears on the first end, so the three blur-level binds inside one pyramid
    // build are one end and one entry -- the same rule the scalar follows, not a second one.
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteTargetBind('blur');
    l.NoteTargetBind('blur');
    l.NoteTargetBind('blur');
    expect(l.EndsByKey).toEqual({ blur: 1 });
    // `scene` is not a switch by definition and never appears.
    l.NoteWrite();
    l.NoteTargetBind('scene');
    expect(l.EndsByKey.scene).toBeUndefined();
  });

  it('resets with the frame, and the cumulative copy does not', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite(); l.NoteTargetBind('snapshot');
    l.BeginFrame();
    expect(l.EndsByKey).toEqual({});
    expect(l.TotalEndsByKey).toEqual({ snapshot: 1 });
    l.NoteWrite(); l.NoteTargetBind('snapshot');
    expect(l.EndsByKey).toEqual({ snapshot: 1 });
    expect(l.TotalEndsByKey).toEqual({ snapshot: 2 });
  });

  it('UNDER `?cardcomposite` the glass-grid frame ends ONE encoder, and the SNAPSHOT takes it', () => {
    // Under the FLAG, and only under it: the composite defaults to off (it was measured and the
    // frame got slower, so encoder ends are not the cost), and an unflagged `glass-grid` frame
    // ends forty encoders, every one of them on `blur` -- which is the table above in this file.
    // The whole claim of the design in one line: the only end in the frame is on a canvas-sized
    // target above the cliff, and it is the frame snapshot's cut, once. Every card bind, every
    // pyramid build and every backdrop resolve after it is free, because nothing has drawn into the
    // scene since. If this ever reads `card: 20` or `snapshot: 21` the write-back went eager.
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let band = 0; band < 6; band++) l.NoteWrite();
    l.NoteRead(); l.NoteTargetBind('snapshot');
    for (let card = 0; card < 20; card++) {
      l.NoteTargetBind('card');                              // the seed blit
      l.NoteTargetBind('blur');                              // fill build
      l.NoteTargetBind('snapshot');                          // fill build's backdrop resolve
      l.NoteTargetBind('shadow-state');                      // the adaptive probe
      l.NoteTargetBind('snapshot');                          // rim build's backdrop resolve
      l.NoteTargetBind('blur');                              // rim build
      l.NoteTargetBind('card');
    }
    l.NoteFrameEndDrain();
    expect(l.Switches).toBe(1);
    expect(l.EndsByKey).toEqual({ snapshot: 1 });
  });

  it('the renderer and Jaui.ts both carry it, and the three-column shape is untouched', () => {
    const renderer = readRenderer();
    const jaui = readJaui();
    expect(renderer).toContain('get SceneEndsByKey(): Record<string, number> { return this._sceneLedger.EndsByKey; }');
    expect(renderer).toContain('EndsByKey: { ...l.TotalEndsByKey }');
    expect(jaui).toContain('this._counts.SceneEndsByKey = this._renderer.SceneEndsByKey;');
    expect(jaui).toContain('endsByKey=${_endsByKey(c.SceneEndsByKey)}');   // jaui:render:end
    expect(jaui).toContain('_endsByKey(this._counts.SceneEndsByKey)');      // the [Jaui] line
    expect(jaui).toContain('& { EndsByKey: Record<string, number> }');      // __jauiSceneLedger
    expect(jaui).toContain('this._counts.SceneEndsByKey = {};');            // reset with the rest
  });
});
