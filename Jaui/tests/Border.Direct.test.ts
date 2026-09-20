import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PlanBorderDirect, BORDER_DIRECT_PHASE, BORDER_DIRECT_MAX_TAP_OFFSET,
} from '../src/Core/Border.Direct';
import { ResolveRegionRect, type BackdropRect } from '../src/Core/BlurPass';
import { PANEL_PROGRAM_COUNT } from '../src/Core/WebGL2.Renderer';
import { SceneReadLedger } from '../src/Core/Scene.Ledger';
import { arrowBody } from './Scene.ReadAfterWrite.Source';
import { PROGRAMS, preprocess, codeLines, braceBalance, readPanelFrag } from './Flat.Program.Source';

/**
 * `?border-direct` WIRED: the admission rule, the routing, the flag and the census.
 *
 * `Border.Kernel.test.ts` is the arithmetic -- what the four hops compute and that the gather
 * reproduces it. This file is everything AROUND that: which borders are admitted, what a refusal
 * costs, where the copy goes, which program the draw takes, and whether a frame that armed the
 * flag can be told apart from one that did not.
 *
 * WHAT THIS HARNESS CANNOT SEE, said plainly: there is no rasteriser here, so nothing below
 * proves a texel. It proves the ROUTING -- which branch each rim takes, what the copy is, which
 * program is bound -- which is what decides whether the pixels are right, and it cannot show that
 * they are. That is the orchestrator's `glassshot` gate, and the lane's report says what it
 * predicts there.
 */

// -- glass-grid, pinned, on the geometry `Blur.Atlas.Wired.test.ts` uses.
const CANVAS_W = 2560;
const CANVAS_H = 1600;
const DPR = 2;
/** `JwiftGlass`'s `BackdropFilter: Blur(4pt)` at dpr 2. */
const RADIUS = 4 * DPR;
/** The BORDER-only pipeline's margin: `frost*d + 8*d`. */
const RIM_MARGIN = 4 * DPR + 8 * DPR;

const CardBox = (i: number): BackdropRect => {
  const col = i % 5, row = (i / 5) | 0;
  return { x: (60 + col * 236) * DPR, y: (70 + row * 170) * DPR, w: 216 * DPR, h: 150 * DPR };
};
const RimRegion = (i: number): BackdropRect => {
  const b = CardBox(i);
  return {
    x: Math.max(0, Math.floor(b.x - RIM_MARGIN)),
    y: Math.max(0, Math.floor(b.y - RIM_MARGIN)),
    w: Math.min(CANVAS_W, Math.ceil(b.w + RIM_MARGIN * 2)),
    h: Math.min(CANVAS_H, Math.ceil(b.h + RIM_MARGIN * 2)),
  };
};

describe('border-direct > the admission rule', () => {
  it('admits all twenty glass-grid rims, on the rect `Blur` itself would have resolved', () => {
    for (let i = 0; i < 20; i++) {
      const region = RimRegion(i);
      const plan = PlanBorderDirect(region, CANVAS_W, CANVAS_H, RADIUS, 0);
      expect(plan.Ok, `card ${i}`).toBe(true);
      if (!plan.Ok) return;
      // Not a rect of its own: the SAME function, at the same phase, that `BlurPass.Blur` calls.
      expect(plan.Rect).toEqual(ResolveRegionRect(region, CANVAS_W, CANVAS_H, BORDER_DIRECT_PHASE));
      expect(plan.Rect.W).toBe(480);
      expect(plan.Rect.H).toBe(348);
      expect(plan.TapOffset).toBe(0.7);
    }
  });

  it('refuses a mip consumer, a pre-downsampled region, the wrong depth and a clamped rect', () => {
    const region = RimRegion(0);
    const ask = (r: number, maxLod: number, reg: BackdropRect | undefined = region) =>
      PlanBorderDirect(reg, CANVAS_W, CANVAS_H, r, maxLod);

    // `BorderFilter: Blur(n)` on the rim is the one thing that takes a border-only pass off LOD 0.
    expect(ask(RADIUS, 1).Ok).toBe(false);
    expect((ask(RADIUS, 1) as { Why: string }).Why).toBe('mip-consumer');
    // A full-screen scrim re-bases onto a downsampled backdrop; level 0 is then a coarser grid.
    const full: BackdropRect = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
    expect(ask(64, 0, full).Ok).toBe(false);
    // depth 1 (radius <= 3) and depth 3 (radius > 9) are different chains.
    expect((ask(2, 0) as { Why: string }).Why).toBe('depth1');
    expect((ask(20, 0) as { Why: string }).Why).toBe('depth3');
    // A region asked full-canvas has no `BackdropRegion` map to invert.
    expect((PlanBorderDirect(undefined, CANVAS_W, CANVAS_H, RADIUS, 0) as { Why: string }).Why)
      .toBe('full-canvas');
    // radius 9 is depth 2 but lands EXACTLY on the tap ceiling, where the level-1 window widens.
    const nine = ask(9, 0);
    expect(nine.Ok).toBe(false);
    expect((nine as { Why: string }).Why).toBe(`tap-offset-${BORDER_DIRECT_MAX_TAP_OFFSET}`);
  });

  it('refuses a rect the canvas edge clamped off the phase grid', () => {
    // It takes a canvas whose own size is off the grid, and that is a real case rather than a
    // contrived one: a device-pixel canvas at dpr 1.5 is `round(cssPx * 1.5)` and lands on an odd
    // number about half the time. With `width % 4 != 0`, a card hard against the right edge has its
    // extent rounded UP to 4 and then CLAMPED to the canvas, and what comes back is not a multiple
    // of 4 -- so `floor(W/2)` stops being `W/2` and the gather's grid drifts.
    const W = 2561;
    const region: BackdropRect = { x: W - 101, y: 100, w: 101, h: 200 };
    const rect = ResolveRegionRect(region, W, CANVAS_H, BORDER_DIRECT_PHASE);
    expect(rect.W % BORDER_DIRECT_PHASE).not.toBe(0);
    const plan = PlanBorderDirect(region, W, CANVAS_H, RADIUS, 0);
    expect(plan.Ok).toBe(false);
    expect((plan as { Why: string }).Why).toContain('clamped-rect');
    // And on a canvas whose width IS a multiple of the phase the clamp can never do it, because
    // `width - x0` is then a multiple of 4 for every grid-aligned `x0`. Recorded so a reader does
    // not take the refusal for a common case: on the harness's 2560x1600 it never fires.
    expect(ResolveRegionRect(region, CANVAS_W, CANVAS_H, BORDER_DIRECT_PHASE).W
      % BORDER_DIRECT_PHASE).toBe(0);
  });

  it('a refusal is a REASON, never a silently different picture', () => {
    // Every refusal names itself. A `Why` that is empty or missing would be a refusal nobody can
    // read off a trace, which on this lane is the difference between "twenty rims refused" and
    // "the flag did nothing" -- the two readings the census exists to separate.
    const bad = [
      PlanBorderDirect(undefined, CANVAS_W, CANVAS_H, RADIUS, 0),
      PlanBorderDirect(RimRegion(0), CANVAS_W, CANVAS_H, RADIUS, 2),
      PlanBorderDirect(RimRegion(0), CANVAS_W, CANVAS_H, 0, 0),
    ];
    for (const p of bad) {
      expect(p.Ok).toBe(false);
      expect((p as { Why: string }).Why.length).toBeGreaterThan(0);
    }
  });
});

describe('border-direct > the census', () => {
  it('splits every glass border by which backdrop it took, and resets per frame', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let i = 0; i < 18; i++) l.NoteBorderDirect();
    l.NoteBorderPyramid();
    l.NoteBorderPyramid();
    expect(l.BordersDirect).toBe(18);
    expect(l.BordersPyramid).toBe(2);
    l.BeginFrame();
    expect(l.BordersDirect).toBe(0);
    expect(l.BordersPyramid).toBe(0);
  });

  it('`border-copy` takes its own EndsByKey row, and one copy ends the encoder once', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    l.NoteWrite();
    l.NoteRead();
    l.NoteTargetBind('border-copy');
    // A second copy with no draw between them costs no further store, exactly as a second blur
    // bind does -- so the row counts encoder ENDS and not blits.
    l.NoteTargetBind('border-copy');
    expect(l.EndsByKey['border-copy']).toBe(1);
    l.NoteWrite();
    l.NoteTargetBind('border-copy');
    expect(l.EndsByKey['border-copy']).toBe(2);
    expect(l.Switches).toBe(2);
  });
});

describe('border-direct > the wiring, read off the source', () => {
  const RENDERER = readFileSync(join(__dirname, '../src/Core/WebGL2.Renderer.ts'), 'utf8')
    .replace(/\r\n/g, '\n');
  const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');
  const FRAG = readFileSync(join(__dirname, '../src/Jiv/Shaders/Jiv.Panel.frag'), 'utf8')
    .replace(/\r\n/g, '\n');

  it('the copy is a blitFramebuffer on ANGLE\'s blit-encoder path, not a render pass', () => {
    const body = arrowBody(RENDERER, '_borderCopy');
    expect(body).toContain('gl.blitFramebuffer(');
    // Same size, same format, unflipped, unscaled, unmasked, unscissored -- the six conditions the
    // card composite's own note says ANGLE's Metal backend needs to take the MTLBlitCommandEncoder
    // path instead of drawing. NEAREST, and the destination is the whole scratch.
    expect(body).toContain('gl.COLOR_BUFFER_BIT, gl.NEAREST');
    expect(body).toContain('0, 0, rect.W, rect.H');
    // Not a single `drawElements` / `drawArrays` anywhere in it: a draw would be a render encoder
    // and the whole lever is that this is not one.
    expect(body).not.toMatch(/gl\.draw/);
    // Booked: one read, one `border-copy` end, one direct border.
    expect(body).toContain("this._sceneLedger.NoteRead();");
    expect(body).toContain("this._tgt('border-copy');");
    expect(body).toContain('this._sceneLedger.NoteBorderDirect();');
  });

  it('the handle carries `BlurPass._region`\'s map, so `u_BackdropXf` does not move', () => {
    const body = arrowBody(RENDERER, '_borderCopy');
    expect(body).toContain('ScaleX: width / rect.W, ScaleY: height / rect.H');
    expect(body).toContain('OffsetX: -rect.X / rect.W, OffsetY: -rect.YBottom / rect.H');
    expect(body).toContain('TexelsX: rect.W, TexelsY: rect.H');
    // And it is the same arithmetic `BlurPass._region` writes for a region-sized pyramid.
    const blur = readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(blur).toContain('OffsetX: -rect.X / rect.W,');
    expect(blur).toContain('OffsetY: -rect.YBottom / rect.H,');
  });

  it('every source diagnostic and the card composite REFUSE rather than half-arm', () => {
    const body = arrowBody(RENDERER, 'ComputeBorderDirect');
    expect(body).toContain('if (!this.DiagBorderDirect) return null;');
    expect(body).toContain('this.DiagNoBlur || this.DiagBlurDummy || this.DiagBlurSrc !== null');
    expect(body).toContain('if (this._activeCard !== null) return null;');
    // And the solidness question is asked HERE too, off the style, not only at the batch gate:
    // a surface that gets a scratch handle and then fails the gate is a throw, and no legitimate
    // stylesheet may reach it. `JwiftSolidGlass` (Refraction 0) is the class this holds out.
    expect(body).toContain('if (!(refraction >= BORDER_STRAIGHT_GATHER_REFRACTION)) return null;');
    expect(JAUI).toContain('plan.Radius, plan.MaxLod, node.RenderStyle.Refraction)');
  });

  it('a direct border skips the mip call and never counts itself as a pyramid build', () => {
    // The two lines a refusal restores, and the two a direct border must not run: under
    // `?pyramid-atlas=fills` a walk-built rim bumps `_atlasWalkSolo`, and a border that built
    // nothing must not, or `members + solo == built` stops meaning anything.
    expect(JAUI).toContain('const direct = this._borderDirect');
    expect(JAUI).toContain('.ComputeBorderDirect(region, w, h, plan.Radius, plan.MaxLod, node.RenderStyle.Refraction)');
    const directArm = JAUI.slice(JAUI.indexOf('if (direct !== null) {'));
    // Comments stripped: this is about what the arm RUNS, and the arm's own comment names the two
    // calls it deliberately does not make.
    const arm = directArm.slice(0, directArm.indexOf('} else {')).replace(/\/\/.*$/gm, '');
    expect(arm).not.toContain('GenerateBlurMipmap');
    expect(arm).not.toContain('_atlasWalkSolo');
    expect(arm).not.toContain('ComputeBlur');
    expect(arm).toContain('r.RebindSceneTarget();');
    // The pyramid arm still books itself, so `direct + pyramid` accounts for every glass border.
    expect(JAUI).toContain('if (this._borderDirect) (r as WebGL2Renderer).NoteBorderPyramid();');
  });

  it('the flag throws on a value it cannot run, and names every refusal on the trace', () => {
    expect(JAUI).toContain("if (params.has('border-direct')) {");
    expect(JAUI).toContain("[Jaui] ?border-direct takes 'on' or 'off', got '${raw}'");
    expect(JAUI).toContain('jaui:border-direct armed=false reason=${why}');
    for (const reason of [
      'webgl2-only',
      'no-blur-and-blur-dummy-answer-the-build-themselves',
      'blur-src-measures-a-read-the-gather-makes-sixty-four-of',
      'pyramid-atlas-all-builds-rims-in-a-phase-not-at-a-per-card-site',
      'blur-first-already-pre-built-every-rim',
      'blur-phased-pre-builds-every-rim-in-pass-three',
      'card-composite-backdrop-is-not-in-the-scene-target',
      'restart-probes-insert-at-the-rim-build-and-a-blit-is-not-one',
    ]) {
      expect(JAUI, reason).toContain(reason);
    }
    // The mark prints on BOTH arms, from the line that decides -- never from the renderer's `Init`,
    // which in worker mode is awaited before the URL is parsed at all (lane restarts2).
    expect(JAUI).toContain("JTrace(`jaui:border-direct armed=${this._borderDirect ? 'on' : 'off'}`");
  });

  it('the program is a SIXTH variant, issued unconditionally, and gated on the batch', () => {
    expect(PANEL_PROGRAM_COUNT).toBe(6);
    expect(RENDERER).toContain('{ MATERIAL_GLASS: true, BORDER_DIRECT: true }');
    // Issued outside any flag test, so `?border-direct=off` is the same binary with the same boot.
    const compile = arrowBody(RENDERER, '_compilePanelShader');
    expect(compile).not.toContain('DiagBorderDirect');
    // Routed on handle identity, and a batch that is not a straight-gathering border-only rim is a
    // THROW: the walk hands this handle to exactly one draw.
    expect(RENDERER).toContain('backdrop === this._borderScratchHandle');
    expect(RENDERER).toContain(
      "throw new Error('[Jaui] a border-direct backdrop reached a batch that is not a straight-gathering glass rim')");
    const gate = arrowBody(RENDERER, '_batchTakesBorderDirectProgram');
    expect(gate).toContain('PANEL_OFF_BORDER_EDGE_AA] < 0');
    expect(gate).toContain('PANEL_OFF_REFRACTION] >= BORDER_STRAIGHT_GATHER_REFRACTION');
  });

  it('the shader\'s solidness edge is the number the batch gate reads', () => {
    // A copy of a shader constant that could drift is the bug `BaseDownsampleFactor`'s own note
    // warns about, so the gate's literal is asserted against the `.frag`'s.
    expect(FRAG).toContain('float solidness = 1.0 - smoothstep(0.0, 4.0, refractionStrength);');
    expect(RENDERER).toContain('const BORDER_STRAIGHT_GATHER_REFRACTION = 4;');
  });

  it('the border arm is the ONLY tap that changes, and the pyramid arm is untouched', () => {
    expect(FRAG).toContain('vec3 bSample = sampleBackdropDirect(bUv, bLod, frostLod);');
    expect(FRAG).toContain('vec3 bSample = sampleBackdrop(bUv, bLod, frostLod);');
    // Four other `sampleBackdrop` call sites, all on the fill path, all unchanged and none of them
    // behind the define -- they are dead on a border-only instance and live on every other.
    expect(FRAG).toContain('backdrop = sampleBackdrop(baseUv, lodBoost, frostLod);');
    expect(FRAG).toContain('vec3 rimSample = sampleBackdrop(rimUv, 0.0, frostLod);');
    expect(FRAG).toContain('vec3 rimSpecBackdrop = sampleBackdrop(baseUv, max(0.0, lodBoost - 0.5), frostLod);');
    // The raw-scene branch is kept VERBATIM in the direct twin: a panel that authored no frost
    // reads `u_Scene` on both arms, off the same test.
    const direct = FRAG.slice(FRAG.indexOf('vec3 sampleBackdropDirect('));
    expect(direct.slice(0, 400))
      .toContain('if (frostLod < 0.01 && extraLod < 0.01) return texture(u_Scene, uv).rgb;');
  });

  it('the gather clamps at the LEVEL index on both levels, never at the source coordinate', () => {
    // Replicating source texels and then boxing them is a different number from replicating the
    // box, and replicating level-2 cells is what CLAMP_TO_EDGE gave the pyramid's UP hop.
    expect(FRAG).toContain('vec2 q = clamp(_bdQ0 + vec2(float(i), float(j)), vec2(0.0), l2n - 1.0);');
    expect(FRAG).toContain('vec2 m = clamp(_bdM0 + vec2(float(i), float(j)), vec2(0.0), l1n - 1.0);');
  });

  it('the two UP helpers are `UP_FRAG`\'s eight taps in `UP_FRAG`\'s order', () => {
    const blur = readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    const upFrag = blur.slice(blur.indexOf('const UP_FRAG'), blur.indexOf('const COPY_FRAG'));
    const offsets = [...upFrag.matchAll(/vec2\((.+?)\)\)(?:\.rgb)?( \* 2\.0)?/g)].map((m) => m[1]);
    expect(offsets.length).toBe(8);
    for (const helper of ['_bdUpFromL2', '_bdUpFromL1']) {
      const body = FRAG.slice(FRAG.indexOf(`vec3 ${helper}(`));
      const taps = body.slice(0, body.indexOf('return s / 12.0;'));
      // Same eight offsets, same order, same weights -- `h` is `u_HalfPixel * u_Offset` written in
      // the source level's own texels instead of in normalized UV.
      expect(taps.indexOf('vec2(-h * 2.0, 0.0)')).toBeGreaterThan(-1);
      expect(taps.indexOf('vec2(-h,  h)) * 2.0')).toBeGreaterThan(taps.indexOf('vec2(-h * 2.0, 0.0)'));
      expect(taps.indexOf('vec2(0.0,  h * 2.0)')).toBeGreaterThan(taps.indexOf('vec2(-h,  h)) * 2.0'));
      expect(taps.indexOf('vec2( h * 2.0, 0.0)')).toBeGreaterThan(taps.indexOf('vec2( h,  h)) * 2.0'));
      expect(taps.indexOf('vec2(0.0, -h * 2.0)')).toBeGreaterThan(taps.indexOf('vec2( h, -h)) * 2.0'));
      expect(taps.indexOf('vec2(-h, -h)) * 2.0')).toBeGreaterThan(taps.indexOf('vec2(0.0, -h * 2.0)'));
    }
  });

  it('the gate line prints `pyramid=` beside `direct=`, so a vacuous arm cannot hide', () => {
    expect(JAUI).toContain('jaui:border-direct direct=${gl2.BordersDirect} pyramid=${gl2.BordersPyramid}');
    expect(JAUI).toContain("copies=${gl2.SceneEndsByKey['border-copy'] ?? 0}");
  });
});

describe('border-direct > the SIXTH program, cut from the one source', () => {
  const FRAG = readPanelFrag();
  const DEFINES = ['MATERIAL_GLASS', 'BORDER_DIRECT'];

  it('preprocesses and brace-balances, and so does every variant WITHOUT the define', () => {
    // The one build break a lane cannot see, because a lane does not build: an unbalanced `#if`
    // or a stray brace inside a new block surfaces as a link error on a machine that compiles.
    expect(braceBalance(codeLines(preprocess(FRAG, DEFINES)))).toBe(0);
    for (const set of Object.values(PROGRAMS)) {
      expect(braceBalance(codeLines(preprocess(FRAG, set)))).toBe(0);
    }
  });

  it('is a strict SUPERSET of MATERIAL_GLASS: it adds lines and removes exactly one', () => {
    const glass = codeLines(preprocess(FRAG, ['MATERIAL_GLASS']));
    const direct = codeLines(preprocess(FRAG, DEFINES));
    const directLines = new Set(direct.map((l) => l.N));
    // Every line the glass program runs is in the direct program too, EXCEPT the one the define
    // swaps: the border zone's `sampleBackdrop` call. One line out, one line in, and the rest of
    // the shader is the same text at the same line numbers.
    const missing = glass.filter((l) => !directLines.has(l.N));
    expect(missing.length).toBe(1);
    expect(missing[0].Text).toBe('vec3 bSample = sampleBackdrop(bUv, bLod, frostLod);');
    // And the direct twin is what replaced it.
    expect(direct.some((l) => l.Text === 'vec3 bSample = sampleBackdropDirect(bUv, bLod, frostLod);'))
      .toBe(true);
  });

  it('nothing the gather needs leaks into the OTHER five programs', () => {
    for (const set of Object.values(PROGRAMS)) {
      const code = codeLines(preprocess(FRAG, set)).map((l) => l.Text).join('\n');
      expect(code, set.join('+')).not.toContain('sampleBackdropDirect');
      expect(code, set.join('+')).not.toContain('u_BorderTexels');
      expect(code, set.join('+')).not.toContain('_bdL2');
    }
  });
});
