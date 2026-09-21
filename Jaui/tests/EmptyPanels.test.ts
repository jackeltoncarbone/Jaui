/**
 * `?emptypanels` — A PANEL THAT PAINTS NOTHING IS NOT PUSHED.
 *
 * The non-glass branch of the walk pushed an instance for EVERY panel, including one whose
 * background is fully transparent, whose border is absent and whose shadow is absent. That
 * instance's fragment program ran on every fragment of its quad, `result.a` came out exactly 0,
 * and the blend left the destination untouched. On `glass-grid` at dpr 2 that is ~12 Mpx a frame.
 *
 * THE WHOLE CLAIM IS PIXEL IDENTITY, so this file proves it from two ends and refuses to assert
 * anything in between:
 *
 *   1. THE ALPHA. `Jiv.Panel.frag`'s alpha chain for a non-glass, non-backdrop-filtered instance,
 *      transcribed term for term with the frag's own line numbers beside it, comes out EXACTLY 0
 *      on every branch the program can take — and the transcription is shown to be non-vacuous by
 *      moving one clause off zero and watching it stop being 0.
 *   2. THE BLEND. The equation the renderer actually sets, read out of `WebGL2.Renderer.ts` rather
 *      than remembered, leaves every destination code bit-identical at source alpha 0 — on the RGB
 *      half AND on the separate alpha half, which is NOT the same function.
 *
 * Then the rule itself, clause by clause, through the REAL predicate on real `Jiv`s; then the
 * WALK, driven headless through a recording renderer, to show that what changes is an instanced
 * draw's COUNT and never the order of the instances that remain.
 *
 * WHAT THIS FILE CANNOT SEE, plainly: there is no rasteriser here and no GPU. A transcription
 * agreeing with the GLSL it was transcribed from is not the GPU agreeing with either. The
 * orchestrator's pixel gate is the proof; this is the argument.
 */
import { describe, it, expect } from 'vitest';
import { Canvas } from '@jaui/Core/Jaui';
import type { Renderer } from '@jaui/Core/Renderer';
import { BrowserPlatform } from '@jaui/Core/Platform';
import { Jiv } from '@jaui/Jiv/Jiv';
import { JIV_FLOATS_PER_INSTANCE } from '@jaui/Jiv/Jiv.InstanceBuffer';
import { readJaui, readRenderer, readPerfJss, jssClass, jssNumber } from './Scene.ReadAfterWrite.Source';

// ── 1. THE ALPHA ───────────────────────────────────────────────────────────────────────────────

/**
 * `Jiv.Panel.frag`'s alpha, for an instance the walk routed to the NON-GLASS panel branch.
 *
 * Under that routing three things are pinned by the program VARIANT rather than by a value, and
 * the transcription is only honest because of them: `materialType` is the compile-time `0.0` of
 * MATERIAL_NONE / MATERIAL_FLAT / BORDERLESS (frag 1020), `borderOnly` is 0 (the rule refuses
 * every node whose `ownBorderMode` is not 'Normal', because that mode needs a painted border), and
 * `hasBackdropFilter` is false (a clause of the rule). So the two arms `materialType == 1.0 ||
 * hasBackdropFilter` opens — the glass composite at 1450 and the whole glass block at 1496, whose
 * rim, specular and border-refilter all write `result.a` — are not taken, and what is left is
 * this.
 *
 * Every argument is a free parameter rather than a derived one, so the sweep below can put the
 * shape field, the shadow field and the border annulus anywhere they can go without this function
 * having a second opinion about where that is.
 */
const PanelResultAlpha = (p: {
  /** frag 1114: `1 - smoothstep(-0.5, 0.5, dist)`. */
  FillAlpha: number;
  /** frag 1447/1456: `fillSrc.a` — `v_Tint.a` at u_BgMode 0, `sampleBgGradient`'s otherwise. */
  FillSrcA: number;
  /** frag 1431: `smoothstep(shadowBlur, -shadowBlur, shadowDist)`, whatever it evaluated to. */
  ShadowShape: number;
  /** frag 1428: `v_ShadowColor.a`, AFTER the vertex's `AdaptiveShadowAlpha` has had its say. */
  ShadowColorA: number;
  /** frag 1732: `(1 - borderOuter) * borderInner`, whatever the two smoothsteps evaluated to. */
  BorderAnnulus: number;
  /** frag 1336: `variedBorderWidth / drawnBorderWidth`. */
  BorderCoverage: number;
  /** frag 1733: `v_BorderColor.a`. */
  BorderColorA: number;
  /** frag 1009/1739. */
  Opacity: number;
  /** frag 972/1739. */
  ClipAlpha: number;
}): number => {
  const fillA = p.FillAlpha * p.FillSrcA;                                       // 1456
  const shadowAlpha = p.ShadowColorA > 1e-4 ? p.ShadowShape * p.ShadowColorA : 0.0;  // 1427-1432
  let a = fillA + shadowAlpha * (1.0 - fillA);                                  // 1464
  const borderBase = p.BorderAnnulus * p.BorderCoverage;                        // 1732
  const borderAlpha = borderBase * p.BorderColorA;                              // 1733
  a = a * (1.0 - borderAlpha) + borderAlpha;                                    // 1735
  return a * p.Opacity * p.ClipAlpha;                                           // 1739
};

/** frag 1317-1336, verbatim. `widthScale` is `1 + borderVariance * widthAlign`, which is finite
 *  for any authored variance, so its value cannot rescue a zero width. */
const BorderCoverage = (borderWidth: number, widthScale: number): number => {
  const localBorderWidth = borderWidth * widthScale;
  const variedBorderWidth = Math.max(localBorderWidth, 0.0);
  const drawnBorderWidth = Math.max(variedBorderWidth, 1.0);   // BORDER_MIN_DEVICE_PX
  return variedBorderWidth / drawnBorderWidth;
};

/** The whole field a fragment can be standing in: deep inside, on the feather, outside. */
const FIELD = [0, 1e-7, 0.001, 0.259, 0.5, 0.741, 0.808, 0.9999999, 1];

describe('emptypanels — the shader takes result.a to EXACTLY 0, on every branch it can take', () => {
  it('a zero-width border has coverage exactly 0, at every variance the chain can produce', () => {
    for (let ws = 0; ws <= 2.0001; ws += 0.05) expect(BorderCoverage(0, ws)).toBe(0);
    // Signed zero included: `borderWidth * widthScale` is -0 at a negative scale, `max(-0, 0)` is
    // 0, and 0 / 1 is 0. The borderless program's routing rests on the same reading.
    expect(BorderCoverage(-0, 1)).toBe(0);
    expect(BorderCoverage(0, -3)).toBe(0);
  });

  it('...and BorderBlur cannot rescue it: the blur is the smoothsteps\' feather, not a factor', () => {
    // `borderEdgeAa` (lane 28, `BorderBlur * avgScale * dpr`) reaches the stroke ONLY as `aa`
    // inside `borderOuter` and `borderInner` — i.e. it can move `BorderAnnulus` anywhere in
    // [0, 1] and nowhere else. Coverage multiplies that, and coverage is 0.
    for (const annulus of FIELD) {
      expect(PanelResultAlpha({
        FillAlpha: 1, FillSrcA: 0, ShadowShape: 0, ShadowColorA: 0,
        BorderAnnulus: annulus, BorderCoverage: BorderCoverage(0, 1), BorderColorA: 1,
        Opacity: 1, ClipAlpha: 1,
      })).toBe(0);
    }
  });

  it('an empty panel is alpha 0 across the whole field, at every opacity and clip', () => {
    for (const fillAlpha of FIELD) {
      for (const shadowShape of FIELD) {
        for (const annulus of FIELD) {
          for (const opacity of [0, 0.37, 1]) {
            for (const clipAlpha of FIELD) {
              expect(PanelResultAlpha({
                FillAlpha: fillAlpha, FillSrcA: 0,
                ShadowShape: shadowShape, ShadowColorA: 0,
                BorderAnnulus: annulus, BorderCoverage: 0, BorderColorA: 0,
                Opacity: opacity, ClipAlpha: clipAlpha,
              })).toBe(0);
            }
          }
        }
      }
    }
  });

  it('the same in float32, which is what the GPU actually runs', () => {
    const f = Math.fround;
    for (const fillAlpha of FIELD) {
      for (const annulus of FIELD) {
        const fillA = f(f(fillAlpha) * f(0));
        let a = f(fillA + f(f(0) * f(1 - fillA)));
        const borderAlpha = f(f(f(annulus) * f(0)) * f(0));
        a = f(f(a * f(1 - borderAlpha)) + borderAlpha);
        expect(f(f(a * f(1)) * f(1))).toBe(0);
      }
    }
  });

  it('THE CLAIM IS NOT VACUOUS: one 8-bit step of background alpha and it stops being 0', () => {
    const lifted = PanelResultAlpha({
      FillAlpha: 1, FillSrcA: 1 / 255, ShadowShape: 0, ShadowColorA: 0,
      BorderAnnulus: 0, BorderCoverage: 0, BorderColorA: 0, Opacity: 1, ClipAlpha: 1,
    });
    expect(lifted).toBeGreaterThan(0);
    // ...and so does one step of shadow alpha, and one of border alpha at a real width. These are
    // the three clauses of the rule, each shown to be load-bearing on its own.
    expect(PanelResultAlpha({
      FillAlpha: 1, FillSrcA: 0, ShadowShape: 1, ShadowColorA: 1 / 255,
      BorderAnnulus: 0, BorderCoverage: 0, BorderColorA: 0, Opacity: 1, ClipAlpha: 1,
    })).toBeGreaterThan(0);
    expect(PanelResultAlpha({
      FillAlpha: 1, FillSrcA: 0, ShadowShape: 0, ShadowColorA: 0,
      BorderAnnulus: 1, BorderCoverage: BorderCoverage(2, 1), BorderColorA: 1 / 255,
      Opacity: 1, ClipAlpha: 1,
    })).toBeGreaterThan(0);
  });

  it('a shadow alpha of 0 survives the vertex\'s adaptive term, because that term MULTIPLIES', () => {
    // `Jiv.Panel.vert:40` — `authoredAlpha * mix(1.0, backdropFactor, adaptive)`. Whatever the
    // 1x1 shadow-state probe measured, 0 times it is 0. (The flat paths pass no shadow backdrop
    // at all, so `u_ShadowBackdrop.x` is -1 and the branch is not even taken; this is the answer
    // for the day one of them does.)
    const AdaptiveShadowAlpha = (authored: number, backdropFactor: number, adaptive: number): number =>
      authored * (1 - adaptive + backdropFactor * adaptive);
    for (const factor of [0, 0.5, 1, 4]) {
      for (const adaptive of [0, 0.5, 1]) expect(AdaptiveShadowAlpha(0, factor, adaptive)).toBe(0);
    }
  });
});

// ── 2. THE BLEND ───────────────────────────────────────────────────────────────────────────────

describe('emptypanels — source alpha 0 leaves the destination bit-identical', () => {
  const renderer = readRenderer();

  it('the blend equation is the one this proof assumes, read from the renderer', () => {
    // `EnableBlend` — RGB straight source-over, ALPHA accumulating coverage. The two halves are
    // DIFFERENT functions and the proof needs both, so both are read rather than one assumed.
    expect(renderer).toContain(
      'gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);',
    );
    // ...and the scene pass's own, which is what a panel drawn straight after `BeginScenePass`
    // inherits: the non-separate form, so alpha takes SRC_ALPHA too.
    expect(renderer).toContain('gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);');
    // And the equation. A MIN or a MAX would break every line below.
    expect(renderer).toContain('gl.blendEquation(gl.FUNC_ADD);');
  });

  it('every 8-bit destination code comes back unchanged, on RGB and on alpha alike', () => {
    const srcA = 0;
    // The fragment's rgb at alpha 0 is NOT necessarily 0: `applyGrading` (frag 1765) and the
    // gradient dither (frag 1770) both write `result.rgb` after the alpha is settled, and the
    // dither divides by `max(result.a, 0.25)`. So the destination has to survive an ARBITRARY
    // source colour, which is exactly what `x * 0` gives it.
    for (const srcC of [0, 0.5, 1, -0.25, 1.75, 1 / 255]) {
      for (let code = 0; code < 256; code++) {
        const dst = code / 255;
        expect(srcC * srcA + dst * (1 - srcA)).toBe(dst);            // RGB: SRC_ALPHA, 1-SRC_ALPHA
        expect(srcA * 1 + dst * (1 - srcA)).toBe(dst);               // A:   ONE,       1-SRC_ALPHA
        expect(srcA * srcA + dst * (1 - srcA)).toBe(dst);            // A under the scene pass's form
      }
    }
  });

  it('...and in float32, at the 10-bit codes the high-precision attachments carry', () => {
    const f = Math.fround;
    for (let code = 0; code < 1024; code++) {
      const dst = f(code / 1023);
      expect(f(f(f(0.73) * f(0)) + f(dst * f(1 - 0)))).toBe(dst);
    }
  });

  it('THE CLAIM IS NOT VACUOUS: one 8-bit step of source alpha moves the destination', () => {
    const srcA = 1 / 255;
    const moved = 1 * srcA + 0 * (1 - srcA);
    expect(moved).toBeGreaterThan(0);
  });
});

// ── 3. THE RULE, clause by clause, through the REAL predicate ───────────────────────────────────

const nullRenderer = (): Renderer =>
  new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => undefined) }) as unknown as Renderer;

const canvasOf = (search = '', w = 400, h = 300, renderer: Renderer = nullRenderer()): Canvas => {
  const platform = { ...BrowserPlatform, GetUrlSearch: (): string => search };
  const c = new Canvas(new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement, renderer, platform);
  c.SetSizePx(w, h);
  return c;
};

/** The predicate itself. An arrow-function property, so this is the real one and not a copy. */
const isEmpty = (c: Canvas, node: Jiv): boolean =>
  (c as unknown as { _isEmptyPanel: (n: Jiv) => boolean })._isEmptyPanel(node);

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

describe('emptypanels — the admission rule, said exactly', () => {
  const c = canvasOf();
  const at = (style: Record<string, string>): Jiv =>
    new Jiv({ X: 10, Y: 10, Width: 120, Height: 80, Style: { Background: TRANSPARENT, ...style } });

  it('a transparent Color background with no border and no shadow is EMPTY', () => {
    expect(isEmpty(c, at({}))).toBe(true);
  });

  it('...and one 8-bit step of background alpha is not', () => {
    expect(isEmpty(c, at({ Background: 'rgba(0, 0, 0, 0.0039216)' }))).toBe(false);
    expect(isEmpty(c, at({ Background: 'rgb(0, 0, 0)' }))).toBe(false);
  });

  it('a border is refused on WIDTH or on ALPHA — both exactly zero, not an epsilon', () => {
    expect(isEmpty(c, at({ BorderWidth: '1', BorderColor: 'rgb(255,255,255)' }))).toBe(false);
    // Width 0 but a coloured stroke: refused, because `borderAlpha = borderBase * 0 * a` is only
    // exactly 0 through the COVERAGE, and a rule that leaned on one of the two would be leaning
    // on `_hasPaintedBorder`'s 0.001 tolerance.
    expect(isEmpty(c, at({ BorderColor: 'rgb(255,255,255)' }))).toBe(false);
    // A width with a transparent colour: also refused, same reason from the other side.
    expect(isEmpty(c, at({ BorderWidth: '2', BorderColor: TRANSPARENT }))).toBe(false);
    // A zero-width border with a blur IS empty — the blur is the feather, and coverage is 0.
    expect(isEmpty(c, at({ BorderWidth: '0', BorderBlur: '4' }))).toBe(true);
  });

  it('a shadow is refused on its ALPHA, blur and offset alone are not ink', () => {
    expect(isEmpty(c, at({ ShadowColor: 'rgba(0,0,0,0.5)', ShadowBlur: '12' }))).toBe(false);
    expect(isEmpty(c, at({ ShadowBlur: '12', ShadowOffsetY: '4' }))).toBe(true);
  });

  it('glass and progressive blur are refused outright', () => {
    expect(isEmpty(c, at({ Thickness: '2' }))).toBe(false);
    expect(isEmpty(c, at({ ProgressiveBlurDirection: 'ToBottom' }))).toBe(false);
  });

  it('THE CLAUSE THAT IS NOT OBVIOUS: a backdrop filter takes fillA = fillAlpha, NOT * fillSrc.a', () => {
    // frag 1450. A transparent background over a filtered backdrop paints the FILTERED BACKDROP at
    // full alpha; withholding it would blank a frosted panel. All five of the shader's terms.
    expect(isEmpty(c, at({ BackdropFilter: 'Blur(4pt)' }))).toBe(false);
    expect(isEmpty(c, at({ BackdropFilter: 'Brightness(1.4)' }))).toBe(false);
    expect(isEmpty(c, at({ BackdropFilter: 'Saturate(1.6)' }))).toBe(false);
    expect(isEmpty(c, at({ BackdropFilter: 'Contrast(0.8)' }))).toBe(false);
    expect(isEmpty(c, at({ Tint: '0.4' }))).toBe(false);
  });

  it('a blend mode that could read the destination is refused', () => {
    // Both admitted modes happen to leave the destination alone at source alpha 0, and they are
    // refused anyway: the rule is written about SOURCE-OVER, and a future mode need not be so kind.
    expect(isEmpty(c, at({ BlendMode: 'PlusLighter' }))).toBe(false);
    expect(isEmpty(c, at({ BlendMode: 'Screen' }))).toBe(false);
    expect(isEmpty(c, at({ BlendMode: 'Normal' }))).toBe(true);
  });

  it('an Image background is refused whatever its placeholder says: the CPU cannot read a texture', () => {
    expect(isEmpty(c, at({ Background: `Url('nothing.png', ${TRANSPARENT})` }))).toBe(false);
  });

  it('a gradient is empty only when EVERY stop is fully transparent', () => {
    expect(isEmpty(c, at({ Background: `LinearGradient(90deg, ${TRANSPARENT}, ${TRANSPARENT})` }))).toBe(true);
    expect(isEmpty(c, at({ Background: `LinearGradient(90deg, ${TRANSPARENT}, rgba(255,0,0,0.004))` }))).toBe(false);
    expect(isEmpty(c, at({ Background: `RadialGradient(${TRANSPARENT}, ${TRANSPARENT})` }))).toBe(true);
  });

  it('EffectiveOpacity is NOT a clause, because 0 times anything is already 0', () => {
    const faded = at({ Opacity: '0.35' });
    expect(isEmpty(c, faded)).toBe(true);
    // ...and it does not make an INKED panel empty either. Opacity is orthogonal to the rule.
    expect(isEmpty(c, at({ Background: 'rgb(9,9,9)', Opacity: '0.35' }))).toBe(false);
  });
});

// ── 4. THE WALK: a count changes, an order does not ────────────────────────────────────────────

interface Emission {
  /** One entry per `PanelDrawBatch`, holding that batch's instances. */
  Batches: Float32Array[][];
  /** Calls to `_emitTextFor`, and the node each was for. Counted at the EMISSION rather than at
   *  a draw: a null renderer has no glyph atlas, so `flushText` bails before it issues one and a
   *  draw count would read 0 on both arms — an assertion that could not fail. */
  TextEmits: Jiv[];
}

const recordingRenderer = (log: Emission): Renderer => {
  let pending: Float32Array[] = [];
  const handlers: Record<string, (...a: never[]) => unknown> = {
    PanelAddInstance: ((data: Float32Array, offset: number, floats: number) => {
      for (let i = 0; i < floats; i += JIV_FLOATS_PER_INSTANCE) {
        pending.push(data.slice(offset + i, offset + i + JIV_FLOATS_PER_INSTANCE));
      }
    }) as unknown as (...a: never[]) => unknown,
    PanelDrawBatch: (() => { log.Batches.push(pending); pending = []; }) as unknown as (...a: never[]) => unknown,
  };
  return new Proxy({}, {
    get: (_t, key) => (key === 'then' ? undefined : handlers[key as string] ?? (() => undefined)),
  }) as unknown as Renderer;
};

/** Lane 15 of the instance — `a_Tint.a`. The one number that tells two panels apart here. */
const TINT_A = 15;
/** Lane 55 — `clipCount`. Zero means the shader short-circuits the clip stack. */
const CLIP_COUNT = 55;

const flatten = (log: Emission): Float32Array[] => log.Batches.flat();

const placed = (x: number, y: number, w: number, h: number): Record<string, string> => ({
  Position: 'Placed', Left: x + 'px', Top: y + 'px', Width: w + 'px', Height: h + 'px',
});

/** The scene both arms walk: an empty container that CLIPS, holding an inked child and a text
 *  node whose own panel is empty, beside two more inked panels at distinct tint alphas. */
const buildScene = (c: Canvas): Jiv => {
  const shell = new Jiv({
    ChildLayout: placed(0, 0, 300, 200),
    Overflow: 'Hidden',
    Style: { Background: TRANSPARENT, BorderRadius: '12', Opacity: '1' },
  });
  shell.AddChild(new Jiv({
    ChildLayout: placed(10, 10, 80, 40),
    Style: { Background: 'rgba(255, 0, 0, 0.25)', Opacity: '1' },
  }));
  const text = new Jiv({
    ChildLayout: placed(10, 60, 200, 30),
    Text: 'Aa', Style: { Background: TRANSPARENT, Opacity: '1' },
  });
  shell.AddChild(text);
  c.Root.AddChild(shell);
  c.Root.AddChild(new Jiv({
    ChildLayout: placed(0, 210, 100, 40),
    Style: { Background: 'rgba(0, 255, 0, 0.5)', Opacity: '1' },
  }));
  c.Root.AddChild(new Jiv({
    ChildLayout: placed(110, 210, 100, 40),
    Style: { Background: 'rgba(0, 0, 255, 0.75)', Opacity: '1' },
  }));
  return text;
};

interface Walked {
  Log: Emission;
  Census: { Armed: boolean; Panels: number; Px: number };
  TextWords: number;
}

const walk = (search: string): Walked => {
  const log: Emission = { Batches: [], TextEmits: [] };
  const c = canvasOf(search, 400, 300, recordingRenderer(log));
  const text = buildScene(c);
  // The text counter, installed on the REAL emitter: `_emitTextFor` is an arrow-function property,
  // so this wraps the very call the walk makes, one line below the panel branch.
  const priv = c as unknown as { _emitTextFor: (n: Jiv, ...rest: never[]) => void };
  const realEmit = priv._emitTextFor;
  priv._emitTextFor = (n: Jiv, ...rest: never[]): void => { log.TextEmits.push(n); realEmit(n, ...rest); };
  // ONE frame, the first. Every node is authored `Opacity: 1` so no Presence spring is in flight
  // and the two arms are compared at the same instance floats; a later frame would be skipped by
  // the render-on-demand gate, which is what makes a settle loop the wrong shape here.
  c.RenderHeadless(1000);
  const g = globalThis as unknown as {
    __jauiEmptyPanels: () => { Armed: boolean; Panels: number; Px: number };
  };
  const words = (c as unknown as { _textAnimators: Map<Jiv, { Words: unknown[] }> })
    ._textAnimators.get(text)?.Words.length ?? 0;
  return { Log: log, Census: g.__jauiEmptyPanels(), TextWords: words };
};

describe('emptypanels — the walk withholds an instance and moves nothing else', () => {
  const on = walk('');
  const off = walk('?emptypanels=off');

  it('the control arm pushes an instance for every panel, empty ones included', () => {
    const tints = flatten(off.Log).map((d) => d[TINT_A]);
    // The root, the shell and the text node are empty; the three inked ones are not.
    expect(tints.filter((a) => a === 0).length).toBe(3);
    expect(tints.filter((a) => a !== 0).length).toBe(3);
  });

  it('the armed arm pushes the inked ones and nothing else', () => {
    const tints = flatten(on.Log).map((d) => d[TINT_A]);
    expect(tints.filter((a) => a === 0).length).toBe(0);
    expect(tints.length).toBe(3);
  });

  it("THE INVARIANT: the surviving instances are the control's, in order, float for float", () => {
    const kept = flatten(off.Log).filter((d) => d[TINT_A] !== 0);
    const armed = flatten(on.Log);
    expect(armed.length).toBe(kept.length);
    for (let i = 0; i < armed.length; i++) {
      expect(Array.from(armed[i])).toEqual(Array.from(kept[i]));
    }
  });

  it('an empty panel still CLIPS its children — the clip stack is not the instance', () => {
    // The shell has `Overflow: Hidden` and no ink. Its inked child's instance must still carry a
    // clip, and the control arm must agree that it is the SAME clip: that is the null result.
    const clipped = flatten(on.Log).filter((d) => d[CLIP_COUNT] > 0);
    expect(clipped.length).toBe(1);
    const control = flatten(off.Log).filter((d) => d[CLIP_COUNT] > 0 && d[TINT_A] !== 0);
    expect(control.length).toBe(1);
    expect(Array.from(clipped[0])).toEqual(Array.from(control[0]));
  });

  it('a text node keeps its TEXT when its panel is withheld', () => {
    expect(on.TextWords).toBe(1);
    // Its PANEL is gone from the armed arm's instances...
    expect(flatten(on.Log).length).toBeLessThan(flatten(off.Log).length);
    // ...and its TEXT is emitted on both arms, for the same node, the same number of times.
    expect(on.Log.TextEmits.length).toBe(1);
    expect(on.Log.TextEmits.map((n) => n.Text)).toEqual(['Aa']);
    expect(on.Log.TextEmits.length).toBe(off.Log.TextEmits.length);
  });

  it('the counters read what was withheld, and the control arm reads zero', () => {
    expect(on.Census.Armed).toBe(true);
    expect(on.Census.Panels).toBe(3);
    // The root's own quad fills the buffer; the shell and the text node sit on top of it.
    expect(on.Census.Px).toBeGreaterThan(400 * 300);
    expect(off.Census.Armed).toBe(false);
    expect(off.Census.Panels).toBe(0);
    expect(off.Census.Px).toBe(0);
  });

  it('the flag refuses a value it does not understand rather than arming the default', () => {
    expect(() => canvasOf('?emptypanels=0')).toThrow(/emptypanels takes/);
    expect(() => canvasOf('?emptypanels=yes')).toThrow(/emptypanels takes/);
    expect(() => canvasOf('?emptypanels')).not.toThrow();
    expect(() => canvasOf('?emptypanels=on')).not.toThrow();
  });

  it('a no-star diagnostic refuses the lever rather than reporting a saving nobody paid for', () => {
    const g = globalThis as unknown as { __jauiEmptyPanels: () => { Armed: boolean; Refused: string } };
    canvasOf('?no-panels', 400, 300);
    expect(g.__jauiEmptyPanels().Armed).toBe(false);
    expect(g.__jauiEmptyPanels().Refused).toContain('no-star');
  });
});

describe('emptypanels — a batch whose only instances were empty disappears', () => {
  /** The root (empty by default) with ONE text node (empty panel, real text) under it and nothing
   *  inked before them. `_emitTextFor` is preceded by a `flushPanels()` for z-order, so today that
   *  pending Color batch is drained as a real instanced draw carrying two instances of nothing. */
  const drawsFor = (search: string): number => {
    const log: Emission = { Batches: [], TextEmits: [] };
    const c = canvasOf(search, 400, 300, recordingRenderer(log));
    c.Root.AddChild(new Jiv({
      ChildLayout: placed(10, 10, 200, 30),
      Text: 'Aa', Style: { Background: TRANSPARENT, Opacity: '1' },
    }));
    c.RenderHeadless(1000);
    return log.Batches.length;
  };

  it('the control draws that batch; the armed arm has nothing to draw', () => {
    expect(drawsFor('?emptypanels=off')).toBe(1);
    expect(drawsFor('')).toBe(0);
  });

  it('...and an inked panel in the same batch keeps the draw, at one instance instead of three', () => {
    const log: Emission = { Batches: [], TextEmits: [] };
    const c = canvasOf('', 400, 300, recordingRenderer(log));
    c.Root.AddChild(new Jiv({
      ChildLayout: placed(10, 50, 60, 20), Style: { Background: 'rgb(1, 2, 3)', Opacity: '1' },
    }));
    c.Root.AddChild(new Jiv({
      ChildLayout: placed(10, 10, 200, 30),
      Text: 'Aa', Style: { Background: TRANSPARENT, Opacity: '1' },
    }));
    c.RenderHeadless(1000);
    expect(log.Batches.length).toBe(1);
    expect(log.Batches[0].length).toBe(1);
  });
});

describe('emptypanels — EmptyPx is the QUAD, not the box', () => {
  const census = (): { Panels: number; Px: number } =>
    (globalThis as unknown as { __jauiEmptyPanels: () => { Panels: number; Px: number } })
      .__jauiEmptyPanels();

  it("the default BorderBlur's margin is counted, and the viewport clips it", () => {
    const c = canvasOf('', 400, 300);
    // Wholly inside the buffer, so nothing is clipped and the margin is all there. `BorderBlur`
    // defaults to 0.5; at dpr 1 that is a 0.5 device px margin a side: 121 x 81.
    c.Root.AddChild(new Jiv({ ChildLayout: placed(40, 40, 120, 80), Style: { Background: TRANSPARENT } }));
    c.RenderHeadless(1000);
    expect(census().Panels).toBe(2);                    // the root and this one
    // The root's own quad is 401 x 301, clipped to the 400 x 300 buffer.
    expect(census().Px).toBeCloseTo(400 * 300 + 121 * 81, 6);
  });

  it('a quad hanging off the buffer counts only the part the hardware rasterises', () => {
    const c = canvasOf('', 400, 300);
    c.Root.AddChild(new Jiv({ ChildLayout: placed(-100, -50, 200, 100), Style: { Background: TRANSPARENT } }));
    c.RenderHeadless(1000);
    // On-canvas quad: x in [0, 100.5), y in [0, 50.5).
    expect(census().Px).toBeCloseTo(400 * 300 + 100.5 * 50.5, 6);
  });

  it('a panel wholly off the buffer contributes nothing', () => {
    const c = canvasOf('', 400, 300);
    c.Root.AddChild(new Jiv({ ChildLayout: placed(900, 900, 50, 50), Style: { Background: TRANSPARENT } }));
    c.RenderHeadless(1000);
    expect(census().Px).toBe(400 * 300);
  });
});

// ── 5. THE SCENE, derived from the sheet that owns it ──────────────────────────────────────────

describe('emptypanels — what glass-grid should read, derived from Perf.jss', () => {
  const perf = readPerfJss();
  const BED = jssClass(perf, 'PerfBed');
  const GRID = jssClass(perf, 'PerfGrid');
  const CARD = jssClass(perf, 'PerfCard');
  const DPR = 2;
  const CANVAS_W = 2560, CANVAS_H = 1600;

  /** A quad's on-canvas device pixels: the node's device rect grown by the default `BorderBlur`
   *  margin (0.5pt x dpr = 1 device px a side at dpr 2), intersected with the drawing buffer. */
  const onCanvas = (x: number, y: number, w: number, h: number): number => {
    const m = 0.5 * DPR;
    const x0 = Math.max(0, x * DPR - m), y0 = Math.max(0, y * DPR - m);
    const x1 = Math.min(CANVAS_W, (x + w) * DPR + m), y1 = Math.min(CANVAS_H, (y + h) * DPR + m);
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  };

  it('PerfBed and PerfGrid declare no Background, so both are empty by this rule', () => {
    expect(BED).not.toMatch(/\bBackground\s*:/);
    expect(GRID).not.toMatch(/\bBackground\s*:/);
    // PerfPage does, and it is opaque — the occlusion lane's coverer, not this lane's.
    expect(jssClass(perf, 'PerfPage')).toMatch(/Background\s*:\s*rgb\(0,\s*0,\s*0\)/);
  });

  it('the bed and the grid alone are 7.2 Mpx of empty quad at dpr 2', () => {
    const bed = onCanvas(
      jssNumber(BED, 'Left'), jssNumber(BED, 'Top'), jssNumber(BED, 'Width'), jssNumber(BED, 'Height'),
    );
    // The grid's height is its four wrapped rows of cards plus three gaps — not authored, derived.
    const gap = jssNumber(GRID, 'Gap');
    const gridH = 4 * jssNumber(CARD, 'Height') + 3 * gap;
    const grid = onCanvas(
      jssNumber(GRID, 'Left'), jssNumber(GRID, 'Top'), jssNumber(GRID, 'Width'), gridH,
    );
    expect(bed).toBe(CANVAS_W * CANVAS_H);        // 1800x1300pt at (-240,-200): the whole buffer
    expect(grid).toBeCloseTo(2322 * 1322, 6);
    expect((bed + grid) / 1e6).toBeCloseTo(7.17, 2);
  });

  it('the root Jiv is a third full buffer, because its default Background is transparent', () => {
    const c = canvasOf('', CANVAS_W, CANVAS_H);
    expect(c.Root.RenderStyle.Background.Kind).toBe('Color');
    expect(c.Root.RenderStyle.Background.Color.A).toBe(0);
    expect(isEmpty(c, c.Root)).toBe(true);
  });

  it("the forty jext panels are the SMALL half of it, and this lane counts them anyway", () => {
    // Forty label/sub nodes, each the card's content width (Width - 2 x horizontal Padding) by its
    // own line box. Padding is authored `18pt 22pt`, so the horizontal inset is 22.
    const contentW = jssNumber(CARD, 'Width') - 2 * 22;
    expect(contentW).toBe(172);
    // Placed well inside the buffer, because a quad at the origin would have its own margin
    // clipped away by the viewport and under-report every one of the forty.
    const label = onCanvas(100, 100, contentW, 17 * 1.2);
    const sub = onCanvas(100, 100, contentW, 13 * 1.3);
    expect((20 * (label + sub)) / 1e6).toBeCloseTo(0.544, 3);
  });

  it('the whole scene is ~11.8 Mpx of empty quad across 43 panels', () => {
    const bed = onCanvas(
      jssNumber(BED, 'Left'), jssNumber(BED, 'Top'), jssNumber(BED, 'Width'), jssNumber(BED, 'Height'),
    );
    const gridH = 4 * jssNumber(CARD, 'Height') + 3 * jssNumber(GRID, 'Gap');
    const grid = onCanvas(
      jssNumber(GRID, 'Left'), jssNumber(GRID, 'Top'), jssNumber(GRID, 'Width'), gridH,
    );
    const contentW = jssNumber(CARD, 'Width') - 2 * 22;
    const text = 20 * (onCanvas(100, 100, contentW, 17 * 1.2) + onCanvas(100, 100, contentW, 13 * 1.3));
    const root = CANVAS_W * CANVAS_H;
    expect((root + bed + grid + text) / 1e6).toBeCloseTo(11.81, 2);
    // 1 root + 1 bed + 1 grid + 20 labels + 20 subs. The six bands are inked and the twenty cards
    // are glass, so neither is this lane's.
    expect(1 + 1 + 1 + 20 + 20).toBe(43);
  });
});

// ── 6. THE SITE, read from the walk itself ─────────────────────────────────────────────────────

describe('emptypanels — only the instance push is withheld', () => {
  const jaui = readJaui();

  it('the test guards the non-glass push and nothing above it', () => {
    // The empty test sits INSIDE `else if (!this._diagNoPanels)`, i.e. after `flushText()`, after
    // the occlusion verdict lookup, and after `ownBorderMode` and the clip encode. Everything a
    // panel does other than push is upstream of it.
    const site = jaui.indexOf('const empty = this._emptyPanelCull && this._isEmptyPanel(node);');
    expect(site).toBeGreaterThan(0);
    const before = jaui.slice(0, site);
    expect(before.lastIndexOf('const clipMeta = this._clipBuffer.Encode(')).toBeLessThan(site);
    expect(before.lastIndexOf('} else if (!this._diagNoPanels) {')).toBeLessThan(site);
    // ...and AFTER the occlusion branch, so a carved fill still carves.
    expect(before.lastIndexOf('this._emitCarvedFill(')).toBeLessThan(site);
  });

  it('the gradient path keeps its batch BOUNDARY when its draw is dropped', () => {
    expect(jaui).toContain("if (node.RenderStyle.Background.Kind !== 'Color') flushPanels();");
  });

  it('the flag parses on/off by name and installs the census accessor', () => {
    expect(jaui).toContain("this._emptyPanelCull = raw !== 'off';");
    expect(jaui).toContain('g.__jauiEmptyPanels = () =>');
    expect(jaui).toContain('jaui:emptypanels armed=');
    expect(jaui).toContain('` | empty=${this._emptyPanelStats.Panels}`');
  });

  it('no shader, no renderer and no other lane\'s file is touched by this one', () => {
    // A structural claim the diff can be checked against: the predicate and the counter live in
    // the walk, and the only thing they read off the instance buffer is its static no-shadow diag.
    expect(jaui).toContain('private _isEmptyPanel = (node: Jiv): boolean => {');
    expect(jaui).toContain('private _emptyPanelQuadPx = (');
    expect(readRenderer()).not.toContain('EmptyPanel');
  });
});
