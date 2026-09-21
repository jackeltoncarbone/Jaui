/**
 * `?flat-program` — a specialised fragment program for non-glass fills, DERIVED from the same
 * `Jiv.Panel.frag`, producing identical pixels.
 *
 * ── THE FACT ────────────────────────────────────────────────────────────────────────────────────
 * On `glass-grid` the bed — six horizontal LinearGradient bands plus the page's black fill, ~8 Mpx
 * of plain fill at dpr 2 — costs 12.6 ms of GPU per render (Perf/README, "Depth-1 fence"). Those
 * pixels already ran MATERIAL_NONE, which constant-folds `materialType` away. What MATERIAL_NONE
 * does NOT remove is the backdrop apparatus: two samplers (one mipmapped), `sampleBackdrop`, and a
 * runtime `hasBackdropFilter` branch. A uniform branch on a GPU skips the WORK and not the TAX —
 * the program's register footprint and instruction size are set by its heaviest path, and that
 * footprint bounds occupancy for every pixel it touches, flat ones included.
 *
 * ── THE CONSTRUCTION, AND WHY IT CANNOT CHANGE A PIXEL ──────────────────────────────────────────
 * MATERIAL_FLAT is a strict DELETION from the same source: every guard is a `#if` around a whole
 * declaration or statement, and not one line of the flat path's arithmetic is moved, duplicated or
 * rewritten. This file proves that as a property of the TEXT, by running the same preprocessor
 * `ShaderBatch.Add` runs and comparing the variants line by original line.
 *
 * That is the strongest claim available from source alone. It does NOT prove the driver emits the
 * same code for the same lines (an FMA contraction that fires in one variant and not the other
 * would move a last ULP), which is why the shipping gate is glassshot 0 on every glass scene.
 */
import { describe, it, expect } from 'vitest';
import {
  VARIANTS, preprocess, codeLines, braceBalance, variantCode, linesNotIn,
  readPanelFrag, readRenderer, readJaui, readInstanceBuffer, stripTsComments,
  NONE_ONLY_LINES, GLASS_ONLY_LINES,
} from './Flat.Program.Source';
import { PANEL_PROGRAM_COUNT, PANEL_PROGRAM_BORDER_DIRECT } from '../src/Core/WebGL2.Renderer';

const FRAG = readPanelFrag();
const RENDERER = stripTsComments(readRenderer());
const JAUI = stripTsComments(readJaui());

const flat = variantCode('MATERIAL_FLAT');
const none = variantCode('MATERIAL_NONE');
const glass = variantCode('MATERIAL_GLASS');
const text = (ls: ReadonlyArray<{ Text: string }>): string => ls.map((l) => l.Text).join('\n');

describe('the preprocessor this test reasons with is the one the engine uses', () => {
  it('handles every conditional in Jiv.Panel.frag without guessing', () => {
    // `preprocess` throws on an expression it does not understand and on an unbalanced `#if`.
    // If it ever silently mis-evaluated, every assertion below would be vacuous.
    for (const v of VARIANTS) expect(() => preprocess(FRAG, [v])).not.toThrow();
    expect(() => preprocess(FRAG, [])).not.toThrow();
  });

  it('agrees with ShaderBatch: defines are injected, and the shader reads them with #if defined', () => {
    // `Shader.Compiler._inject` emits a bare `#define NAME` for a `true` value. The shader must
    // therefore test PRESENCE, never a value — `#if MATERIAL_FLAT == 1` would read as 0.
    expect(FRAG).toContain('#if defined(MATERIAL_GLASS)');
    expect(FRAG).toContain('#elif defined(MATERIAL_NONE) || defined(MATERIAL_FLAT)');
    for (const m of FRAG.match(/^\s*#\s*(if|elif)\b.*$/gm) ?? []) {
      expect(m).toMatch(/defined\s*\(/);
    }
  });

  it('every variant is syntactically whole', () => {
    for (const v of VARIANTS) expect(braceBalance(variantCode(v))).toBe(0);
    // The undefined-variant build (test builds, per the source's own note) too.
    expect(braceBalance(codeLines(preprocess(FRAG, [])))).toBe(0);
  });
});

describe('the flat program is a DELETION, not a second shader', () => {
  it('is strictly smaller than the program it comes from', () => {
    expect(flat.length).toBeLessThan(none.length);
    // Not a token trim: the bulk of the glass/backdrop apparatus is gone.
    expect(flat.length).toBeLessThan(none.length * 0.85);
  });

  it('adds exactly ONE line to the non-glass program, and that line is a declaration', () => {
    // Every other line of the flat program is a line of the non-glass program, at the same line
    // number, character for character. The one exception pins `hasBackdropFilter` to a
    // compile-time false — it computes nothing and composites nothing.
    const added = linesNotIn(flat, none);
    expect(added.map((l) => l.Text)).toEqual(['const bool hasBackdropFilter = false;']);
  });

  it('the non-glass and glass programs differ in exactly the constant and the glass-skip gate', () => {
    // MATERIAL_NONE and MATERIAL_GLASS must come out of the guarded source exactly as they did
    // before it was guarded. They are the `?flat-program=off` arm and every glass scene, and the
    // `#elif` this lane widened to `defined(MATERIAL_NONE) || defined(MATERIAL_FLAT)` sits right
    // between them. Their whole difference is the constant that names them and `?glass-skip`'s
    // `GlassSkips`, which is a constant false in the non-glass program (Flat.Program.Source).
    expect(linesNotIn(none, glass).map((l) => l.Text)).toEqual(NONE_ONLY_LINES);
    expect(linesNotIn(glass, none).map((l) => l.Text)).toEqual(GLASS_ONLY_LINES);
    expect(none.length).toBe(glass.length);
  });

  it('the plain border stroke and the gradient dither are shared, never copied', () => {
    // Both are reached under MATERIAL_FLAT through a DANGLING `else` whose `if` arm the `#if`
    // removes. A second copy of either under `#if defined(MATERIAL_FLAT)` is the hand-written
    // second shader this lane exists to avoid, and it would show up as two occurrences.
    const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
    for (const src of [text(flat), text(none), text(glass)]) {
      expect(occurrences(src, 'float borderAlpha = borderBase * v_BorderColor.a;')).toBe(1);
      expect(occurrences(src, 'result.rgb += gradDither / max(result.a, 0.25);')).toBe(1);
    }
    expect(FRAG).not.toContain('#if defined(MATERIAL_FLAT)\n    {');
  });
});

describe('what the flat program removes', () => {
  const gone = ['u_Backdrop', 'u_BackdropXf', 'u_Scene', 'u_BaseFrostLod', 'u_SpecularTilt',
                'sampleBackdrop', 'applyTint', 'triDither', 'textureLod'];

  it('has no backdrop apparatus left at all', () => {
    const src = text(flat);
    for (const name of gone) expect(src, `${name} survived into MATERIAL_FLAT`).not.toContain(name);
  });

  it('declares exactly two samplers — the clip stack and the background image', () => {
    const samplers = [...text(flat).matchAll(/uniform\s+sampler2D\s+(\w+)/g)].map((m) => m[1]);
    expect(samplers.sort()).toEqual(['u_BgTexture', 'u_ClipTex']);
    // The program it replaces declares four.
    const noneSamplers = [...text(none).matchAll(/uniform\s+sampler2D\s+(\w+)/g)].map((m) => m[1]);
    expect(noneSamplers.sort()).toEqual(['u_Backdrop', 'u_BgTexture', 'u_ClipTex', 'u_Scene']);
  });

  it('keeps every removed name in the OTHER two programs', () => {
    // Non-vacuity: the assertions above would pass on a source that had never had these at all.
    for (const src of [text(none), text(glass)]) {
      for (const name of gone) expect(src).toContain(name);
    }
  });
});

describe('what the flat program keeps, byte for byte', () => {
  const src = text(flat);

  it('keeps the GRADIENT dither — the glass dither is the only one that goes', () => {
    expect(src).toContain('float gradientNoise(vec2 pixel) {');
    expect(src).toContain('return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));');
    expect(src).toContain('float gradDither = (gradientNoise(floor(gl_FragCoord.xy)) - 0.5) / 255.0;');
    expect(src).toContain('result.rgb += gradDither / max(result.a, 0.25);');
    // And it is reached by a plain `if` now that the glass arm is gone.
    expect(src).toContain('if (u_BgMode >= 2) {');
  });

  it('keeps the gradient evaluation whole — curve, OKLab, and the mode dispatch', () => {
    expect(src).toContain('vec4 sampleBgGradient(float t) {');
    expect(src).toContain('vec3 oklabToSrgb(vec3 lab) {');
    expect(src).toContain('vec4 resolveBgFill(vec2 panelLocal) {');
    expect(src).toContain('#define MAX_BG_GRAD_STOPS 16');
  });

  it('keeps the corner SDF, the clip stack, the hairline floor and applyGrading', () => {
    expect(src).toContain('float clipStackDistance(vec2 pixel, int offset, int count) {');
    expect(src).toContain('vec3 applyGrading(vec3 color, float brightness, float saturation, float contrast) {');
    expect(src).toContain('const float BORDER_MIN_DEVICE_PX = 1.0;');
    expect(src).toContain('float borderCoverage = variedBorderWidth / drawnBorderWidth;');
    expect(src).toContain('void ShapeEval(vec2 p, vec2 halfSize, vec4 radii, float smoothness, int mode,');
    expect(src).toContain('float fillAlpha = 1.0 - smoothstep(-0.5, 0.5, dist);');
  });

  it('keeps the shadow and the foreground grade', () => {
    expect(src).toContain('shadowAlpha = smoothstep(shadowBlur, -shadowBlur, shadowDist) * v_ShadowColor.a;');
    expect(src).toContain('result.rgb = applyGrading(result.rgb, fgB / 256.0, fgS / 32.0, fgC / 32.0);');
    expect(src).toContain('result.a *= opacity * clipAlpha;');
  });

  it('keeps ONE vertex shader for all three programs', () => {
    // The flat fragment needs no varying the others do not produce, so there is nothing to cut
    // that a pixel gate could see — and the adaptive-shadow texel fetch is per VERTEX anyway.
    expect(RENDERER).toContain('batch.Add(panelVertSrc, panelFragSrc, { MATERIAL_FLAT:  true })');
    // Counted against the two constants rather than a literal: the claim is "one vertex shader
    // however many fragment variants there are", and lane borderdirect added a sixth which lane
    // bootcompile2 moved out of the boot batch. Both counts, because the file still declares the
    // sixth -- in `EnsurePanelBorderDirectProgram` rather than in `_compilePanelShader`. One for
    // the import, one per Add. Re-aimed twice, intent unchanged.
    // Lane glassreg's `?glass-reg` family is one more `Add`, in a loop over its three kinds, and
    // lane gatebisect's `?glass-gates` family one more again.
    expect((RENDERER.match(/panelVertSrc/g) ?? []).length)
      .toBe(1 + PANEL_PROGRAM_COUNT + PANEL_PROGRAM_BORDER_DIRECT + 1 + 1);
  });
});

describe('routing: which batches take the flat program', () => {
  it('compiles exactly PANEL_PROGRAM_COUNT panel variants at BOOT, and the constant says so', () => {
    // The constant and the Adds, against each other rather than against a literal on both sides —
    // which is what the test is FOR. Back to `5` since lane bootcompile2: lane borderdirect's
    // MATERIAL_GLASS + BORDER_DIRECT is still built, by `EnsurePanelBorderDirectProgram`, and it
    // is not in the boot batch -- which is what this constant counts and what the three
    // `programs=` marks that print it are claiming.
    expect(RENDERER).toContain(`export const PANEL_PROGRAM_COUNT = ${PANEL_PROGRAM_COUNT};`);
    // Seven since lane glassreg: the glass program's two `?glass-programs` cuts joined the boot.
    expect(PANEL_PROGRAM_COUNT).toBe(7);
    const adds = RENDERER.match(/batch\.Add\(panelVertSrc, panelFragSrc/g) ?? [];
    expect(adds.length).toBe(PANEL_PROGRAM_COUNT);
    // And the sixth, on its own batch, on the arm.
    expect(RENDERER).toContain(`export const PANEL_PROGRAM_BORDER_DIRECT = ${PANEL_PROGRAM_BORDER_DIRECT};`);
    expect(RENDERER).toContain('EnsurePanelBorderDirectProgram = (batch?: ShaderBatch): number =>');
    expect(RENDERER).toContain('this._panelShaderBorderDirect = b.Add(panelVertSrc, panelFragSrc,');
  });

  it('issues the flat program unconditionally, so both arms are one binary', () => {
    // `?flat-program=off` must not change what is COMPILED, or the two arms would differ in boot
    // cost as well as in routing and the comparison would price both at once.
    const compile = /_compilePanelShader = \(batch: ShaderBatch\): void => \{([\s\S]*?)\n  \};/.exec(RENDERER);
    expect(compile).not.toBeNull();
    expect(compile![1]).not.toContain('DiagFlatProgram');
    expect(compile![1]).not.toContain('if (');
  });

  it('requires non-glass AND no bound backdrop AND a clean batch', () => {
    const pick = /const isFlat = ([\s\S]*?);\n/.exec(RENDERER);
    expect(pick).not.toBeNull();
    const cond = pick![1];
    expect(cond).toContain('!isGlass');
    expect(cond).toContain('this.DiagFlatProgram');
    expect(cond).toContain('backdrop === null');
    expect(cond).toContain('this._batchTakesFlatProgram(baseFrostLod)');
  });

  it('classifies a batch on the SAME five numbers, epsilons and base LOD the fragment reads', () => {
    // The fragment:
    //   hasBackdropFilter = abs(brightness-1)>e || abs(saturation-1)>e || abs(contrast-1)>e
    //                       || frostLod > u_BaseFrostLod + e || abs(bodyTint) > e
    const frag = text(none);
    expect(frag).toContain('bool hasBackdropFilter = abs(brightness - 1.0) > 0.001');
    expect(frag).toContain('|| abs(saturation - 1.0) > 0.001');
    expect(frag).toContain('|| abs(contrast - 1.0) > 0.001');
    expect(frag).toContain('|| frostLod > u_BaseFrostLod + 0.001');
    expect(frag).toContain('|| abs(bodyTint) > 0.001');
    // The renderer, term for term.
    expect(RENDERER).toContain('const PANEL_BACKDROP_FILTER_EPSILON = 0.001;');
    const fn = /_batchTakesFlatProgram = \(baseFrostLod: number\): boolean => \{([\s\S]*?)\n  \};/.exec(RENDERER);
    expect(fn).not.toBeNull();
    const body = fn![1];
    expect(body).toContain('const frostCeiling = baseFrostLod + e;');
    expect(body).toContain('Math.abs(d[b + PANEL_OFF_BACKDROP_BRIGHTNESS] - 1) > e');
    expect(body).toContain('Math.abs(d[b + PANEL_OFF_BACKDROP_SATURATION] - 1) > e');
    expect(body).toContain('Math.abs(d[b + PANEL_OFF_BACKDROP_CONTRAST] - 1) > e');
    expect(body).toContain('d[b + PANEL_OFF_FROST_LOD] > frostCeiling');
    expect(body).toContain('Math.abs(d[b + PANEL_OFF_BODY_TINT]) > e');
    // ONE instance disqualifies the whole batch — the loop returns false, never continues.
    expect(body).not.toMatch(/continue\b/);
    expect((body.match(/return false;/g) ?? []).length).toBe(5);
  });

  it('reads the five offsets the instance packer actually writes', () => {
    // The classifier indexes raw floats. If the packer's layout moves and this does not, a
    // filtered panel would be routed to a program with no sampler to filter with. Pin the layout
    // to the packer's own source so a move fails HERE instead of on a screen.
    const packer = stripTsComments(readInstanceBuffer());
    const at = (n: number, field: string): void => {
      expect(packer, `instance offset ${n} is no longer ${field}`)
        .toMatch(new RegExp(`data\\[offset \\+ ${n}\\] = ${field}`));
    };
    at(32, 'style\\.BackdropBrightness');
    at(33, 'style\\.BackdropSaturation');
    at(34, 'style\\.BackdropContrast');
    at(41, 'style\\.Tint');
    // frostLod is derived, not copied: log2 of the frost in device px, floored at 0.
    expect(packer).toContain('const blurPx = Math.max(0.5, style.BackdropFrostBlur * d);');
    expect(packer).toContain('data[offset + 35] = Math.max(0, Math.min(10, Math.log2(blurPx)));');
    for (const n of [32, 33, 34, 35, 41]) {
      expect(RENDERER).toMatch(new RegExp(`= ${n};`));
    }
  });

  it('a BorderOnly overlay is classified flat, because the packer already neutralised its filter', () => {
    // The one path that draws a filtered node's quad with a NULL backdrop. The packer zeroes the
    // filter on it (or the overlay would grade the dummy BLACK texture over the whole interior),
    // so the classifier sees identity and routes it flat — and the fragment would have computed
    // hasBackdropFilter false there too. Same answer, both programs.
    const packer = stripTsComments(readInstanceBuffer());
    const arm = /else if \(borderMode === 'BorderOnly'\) \{([\s\S]*?)\n    \} else if/.exec(packer);
    expect(arm).not.toBeNull();
    for (const line of ['data[offset + 32] = 1;', 'data[offset + 33] = 1;', 'data[offset + 34] = 1;',
                        'data[offset + 35] = 0;', 'data[offset + 41] = 0;']) {
      expect(arm![1]).toContain(line);
    }
  });

  it('binds the program without touching the scene ledger', () => {
    // `SceneSwitches` / `SceneRestarts` count TARGET binds, not program binds, so a third program
    // cannot move them. `_useProgram` also dedupes, so a run of same-variant batches binds once.
    expect(RENDERER).toContain('private _useProgram = (program: WebGLProgram): void => {');
    const use = /_useProgram = \(program: WebGLProgram\): void => \{([\s\S]*?)\n  \};/.exec(RENDERER);
    expect(use![1]).toContain('if (this._lastProgram === program) return;');
    expect(use![1]).not.toContain('_sceneLedger');
    expect(use![1]).not.toContain('NoteTargetBind');
  });
});

describe('the flag', () => {
  it('defaults ON and is turned off only by the literal value `off`', () => {
    expect(RENDERER).toContain('DiagFlatProgram = true;');
    expect(JAUI).toContain("const flatProgram = params.get('flat-program');");
    expect(JAUI).toContain("const armed = webgl2 && (bad || flatProgram !== 'off');");
  });

  it('prints its mark on EVERY page, armed or not', () => {
    // Inside no `params.has(...)` guard — a reader has to be able to tell the ON arm from a build
    // that has not got the lane at all.
    expect(JAUI).toContain('JTrace(`jaui:flat-program armed=${armed ? \'on\' : \'off\'} programs=${webgl2 ? PANEL_PROGRAM_COUNT : 0}${why}`);');
    const block = /\{\n      const flatProgram = params\.get\('flat-program'\);([\s\S]*?)\n    \}\n/.exec(JAUI);
    expect(block).not.toBeNull();
    expect(block![1]).not.toContain("params.has('flat-program')");
  });

  it('names its refusals rather than degrading quietly', () => {
    expect(JAUI).toContain('reason=webgl2-only');
    expect(JAUI).toContain('reason=only-on-and-off-are-values-got-');
  });

  it('reports the program count from the renderer, never a literal', () => {
    expect(JAUI).toContain("import { WebGL2Renderer, PANEL_PROGRAM_COUNT, GLASS_REG_PROGRAMS, GLASS_GATE_PROGRAMS } from './WebGL2.Renderer';");
    expect(JAUI).not.toMatch(/jaui:flat-program[^`]*programs=3/);
  });
});
