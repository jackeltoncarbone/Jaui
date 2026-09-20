/**
 * `?borderless-program` — NO_SHAPE_GRADIENT: a borderless flat panel must not compute the SDF
 * normal it throws away.
 *
 * ── THE FACT ────────────────────────────────────────────────────────────────────────────────────
 * Under MATERIAL_FLAT the main fragment still calls `ShapeEval` → `CornerEval`, which returns the
 * distance AND the outward normal. The normal feeds exactly one chain that survives MATERIAL_FLAT:
 *
 *     keyAlign = dot(normal, lightDir) → alignment → widthAlign → widthScale
 *       → localBorderWidth = borderWidth * widthScale
 *       → variedBorderWidth = max(localBorderWidth, 0)
 *       → drawnBorderWidth  = max(variedBorderWidth, BORDER_MIN_DEVICE_PX = 1)
 *       → borderCoverage    = variedBorderWidth / drawnBorderWidth
 *     and, in the flat border arm:
 *       → borderBase  = (1 - borderOuter) * borderInner * borderCoverage
 *       → borderAlpha = borderBase * v_BorderColor.a
 *       → result.rgb  = result.rgb * (1 - borderAlpha) + v_BorderColor.rgb * borderAlpha
 *       → result.a    = result.a   * (1 - borderAlpha) + borderAlpha
 *
 * At `borderWidth == 0` every one of those is exactly 0 or exactly 1 for any finite `widthScale`,
 * so the two blends are `x * 1.0 + c * 0.0` — an exact no-op in IEEE. The gradient of the SDF is
 * computed and discarded: two `pow()`, a `length` and a `normalize` per fragment on the
 * superellipse leg, by the file's own comment. The bed's six bands and the page fill are
 * borderless and cover ~8 Mpx at dpr 2.
 *
 * ── WHAT THIS FILE ASSERTS ──────────────────────────────────────────────────────────────────────
 * Three things, all as properties of the real sources:
 *   1. EVERY surviving read of `normal` / `widthScale` / `localBorderWidth` / `drawnBorderWidth` /
 *      `borderCoverage` under MATERIAL_FLAT is inside the region the new guards remove — nothing
 *      else in the flat program consumes any of them.
 *   2. The borderless program is a strict DELETION from MATERIAL_FLAT plus exactly one
 *      substituted line, the `CornerDist` call.
 *   3. The routing is exact on BOTH terms: `borderWidth === 0` and `pillW === 0`, computed off the
 *      packed instance floats with `CornerParams`' own expressions in float32.
 *
 * It does NOT prove that a driver emits the same instructions for the lines both programs share.
 * `glassshot 0` on every glass scene is the shipping gate, as it was for `flatprogram`.
 */
import { describe, it, expect } from 'vitest';
import {
  PROGRAMS, programCode, preprocess, codeLines, braceBalance, linesNotIn,
  readPanelFrag, readRenderer, readJaui, readInstanceBuffer, stripTsComments,
} from './Flat.Program.Source';
import { PANEL_PROGRAM_COUNT } from '../src/Core/WebGL2.Renderer';

const FRAG = readPanelFrag();
const RENDERER = stripTsComments(readRenderer());
const JAUI = stripTsComments(readJaui());
const PACKER = stripTsComments(readInstanceBuffer());

const flat = programCode('MATERIAL_FLAT');
const none = programCode('MATERIAL_NONE');
const glass = programCode('MATERIAL_GLASS');
const borderless = programCode('BORDERLESS');
const text = (ls: ReadonlyArray<{ Text: string }>): string => ls.map((l) => l.Text).join('\n');

// ── 1. THE CLAIM THE LANE RESTS ON, RE-VERIFIED AGAINST THE FILE ─────────────────────────────────

describe('under MATERIAL_FLAT the normal feeds EXACTLY the border chain, and nothing else', () => {
  // Every line of the flat program that mentions one of these names, by original line number.
  const readsOf = (name: string): Array<{ N: number; Text: string }> => {
    const re = new RegExp(`\\b${name}\\b`);
    return flat.filter((l) => re.test(l.Text));
  };

  it('`normal` is declared once and read once, and the read is `keyAlign`', () => {
    const lines = readsOf('normal');
    expect(lines.map((l) => l.Text)).toEqual([
      'vec2 normal;',
      'ShapeEval(p, panelHalfSize, v_Radii, effectiveSmooth, mode, dist, normal);',
      'float keyAlign = dot(normal, lightDir);',
    ]);
    // Non-vacuity: the glass program has many more reads of it (refraction, CA, hemispherical
    // ambient, the bevel's 3D normal, the rim spec, the border's inward tap).
    expect(glass.filter((l) => /\bnormal\b/.test(l.Text)).length).toBeGreaterThan(8);
  });

  it('every link of the chain has exactly the consumers the arithmetic below reasons about', () => {
    const chain: Record<string, string[]> = {
      keyAlign: [
        'float keyAlign = dot(normal, lightDir);',
        'float alignment = max(keyAlign, -keyAlign * GROUND_BOUNCE);',
      ],
      alignment: [
        'float alignment = max(keyAlign, -keyAlign * GROUND_BOUNCE);',
        'float widthAlign = alignment * 2.0 - 1.0;',
      ],
      widthAlign: [
        'float widthAlign = alignment * 2.0 - 1.0;',
        'float widthScale = 1.0 + borderVariance * widthAlign;',
      ],
      widthScale: [
        'float widthScale = 1.0 + borderVariance * widthAlign;',
        'float localBorderWidth = borderWidth * widthScale;',
        'float fadeIn = max(borderFade * widthScale, aa);',
      ],
      localBorderWidth: [
        'float localBorderWidth = borderWidth * widthScale;',
        'float variedBorderWidth = max(localBorderWidth, 0.0);',
      ],
      variedBorderWidth: [
        'float variedBorderWidth = max(localBorderWidth, 0.0);',
        'float drawnBorderWidth = max(variedBorderWidth, BORDER_MIN_DEVICE_PX);',
        'float borderCoverage = variedBorderWidth / drawnBorderWidth;',
      ],
      drawnBorderWidth: [
        'float drawnBorderWidth = max(variedBorderWidth, BORDER_MIN_DEVICE_PX);',
        'float borderCoverage = variedBorderWidth / drawnBorderWidth;',
        'float borderInner = smoothstep(-drawnBorderWidth - fadeIn, -drawnBorderWidth + aa, dist);',
      ],
      borderCoverage: [
        'float borderCoverage = variedBorderWidth / drawnBorderWidth;',
        'float borderBase = (1.0 - borderOuter) * borderInner * borderCoverage;',
      ],
      borderWidth: [
        'float borderWidth = v_ShadowParams.w;',
        'float localBorderWidth = borderWidth * widthScale;',
      ],
    };
    for (const [name, expected] of Object.entries(chain)) {
      expect(readsOf(name).map((l) => l.Text), `reads of ${name} under MATERIAL_FLAT`).toEqual(expected);
    }
  });

  it('the terminal consumers are the two blends, and they touch only `result`', () => {
    const src = text(flat);
    expect(src).toContain('float borderBase = (1.0 - borderOuter) * borderInner * borderCoverage;');
    expect(src).toContain('float borderAlpha = borderBase * v_BorderColor.a;');
    expect(src).toContain('result.rgb = result.rgb * (1.0 - borderAlpha) + v_BorderColor.rgb * borderAlpha;');
    expect(src).toContain('result.a = result.a * (1.0 - borderAlpha) + borderAlpha;');
    // `borderBase` and `borderAlpha` are locals of the stroke block: nothing outside reads them.
    expect(flat.filter((l) => /\bborderBase\b/.test(l.Text)).length).toBe(2);
    expect(flat.filter((l) => /\bborderAlpha\b/.test(l.Text)).length).toBe(3);
  });

  it('the hairline floor is 1.0, which is what makes borderCoverage exactly 0 at width 0', () => {
    // 0 / 1 = 0. If the floor were ever 0 the coverage would be 0/0 = NaN and the chain would
    // NOT be a no-op — it would be the difference between a panel and a black square.
    expect(text(flat)).toContain('const float BORDER_MIN_DEVICE_PX = 1.0;');
  });

  it('the arithmetic, run: at borderWidth 0 every widthScale gives borderAlpha === 0', () => {
    // The chain, transcribed. Swept over the whole reachable domain of its inputs: `keyAlign` is
    // a dot of two unit vectors, `borderVariance` is the authored 0..1, and `v_BorderColor.a` and
    // the two smoothsteps are whatever they are.
    const GROUND_BOUNCE = 0.95;
    const BORDER_MIN_DEVICE_PX = 1.0;
    const chainAlpha = (keyAlign: number, borderVariance: number, borderWidth: number,
                        borderOuter: number, borderInner: number, borderColorA: number): number => {
      const alignment = Math.max(keyAlign, -keyAlign * GROUND_BOUNCE);
      const widthAlign = alignment * 2.0 - 1.0;
      const widthScale = 1.0 + borderVariance * widthAlign;
      const localBorderWidth = borderWidth * widthScale;
      const variedBorderWidth = Math.max(localBorderWidth, 0.0);
      const drawnBorderWidth = Math.max(variedBorderWidth, BORDER_MIN_DEVICE_PX);
      const borderCoverage = variedBorderWidth / drawnBorderWidth;
      return (1.0 - borderOuter) * borderInner * borderCoverage * borderColorA;
    };
    let cases = 0;
    for (let k = -1; k <= 1.0000001; k += 1 / 64) {
      for (const bv of [0, 0.25, 0.4, 0.5, 0.75, 1]) {
        for (const outer of [0, 0.5, 1]) {
          for (const inner of [0, 0.5, 1]) {
            for (const a of [0, 0.5, 1]) {
              for (const bw of [0, -0]) {
                const alpha = chainAlpha(k, bv, bw, outer, inner, a);
                expect(Object.is(Math.abs(alpha), 0), `keyAlign=${k} bv=${bv} bw=${bw}`).toBe(true);
                // And the two blends are exact no-ops for every finite channel value.
                for (const x of [0, 0.25, 1, 0.003921568859368563]) {
                  expect(x * (1.0 - alpha) + 0.5 * alpha).toBe(x);
                }
                cases++;
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(20_000);
  });

  it('a NON-zero width is NOT a no-op — which is why the routing is `=== 0`, not an epsilon', () => {
    // Non-vacuity for the test above, and the reason `_batchTakesBorderlessProgram` refuses an
    // epsilon: the hairline floor means a 0.001 px border still paints, at 0.001 coverage.
    const widthScale = 1.0;
    const variedBorderWidth = Math.max(0.001 * widthScale, 0);
    const drawnBorderWidth = Math.max(variedBorderWidth, 1.0);
    expect(variedBorderWidth / drawnBorderWidth).toBe(0.001);
  });
});

// ── 2. THE PROGRAM IS A DELETION ─────────────────────────────────────────────────────────────────

describe('the borderless program is a deletion from the flat program, plus one line', () => {
  it('is cut from the same source by the same preprocessor, and is syntactically whole', () => {
    expect(() => preprocess(FRAG, PROGRAMS.BORDERLESS)).not.toThrow();
    expect(braceBalance(borderless)).toBe(0);
    // And the three older programs still are, with the new guards in place.
    for (const name of ['MATERIAL_GLASS', 'MATERIAL_NONE', 'MATERIAL_FLAT'] as const) {
      expect(braceBalance(programCode(name))).toBe(0);
    }
    expect(braceBalance(codeLines(preprocess(FRAG, [])))).toBe(0);
  });

  it('adds exactly ONE line to the flat program, and it is the CornerDist substitution', () => {
    expect(linesNotIn(borderless, flat).map((l) => l.Text))
      .toEqual(['dist = CornerDist(p, panelHalfSize, v_Radii, effectiveSmooth);']);
  });

  it('is strictly smaller than the flat program, and not by a token', () => {
    expect(borderless.length).toBeLessThan(flat.length);
    expect(borderless.length).toBeLessThan(flat.length * 0.8);
  });

  it('leaves MATERIAL_NONE and MATERIAL_GLASS exactly where flatprogram left them', () => {
    // The new guards must be invisible to every program that does not define NO_SHAPE_GRADIENT.
    // These two are the `?flat-program=off` arm and every glass scene.
    expect(linesNotIn(none, glass).map((l) => l.Text)).toEqual(['const float materialType = 0.0;']);
    expect(linesNotIn(glass, none).map((l) => l.Text)).toEqual(['const float materialType = 1.0;']);
    expect(none.length).toBe(glass.length);
    expect(linesNotIn(flat, none).map((l) => l.Text)).toEqual(['const bool hasBackdropFilter = false;']);
  });

  it('every new guard tests PRESENCE, the only thing ShaderBatch`s bare #define can be read as', () => {
    for (const m of FRAG.match(/^\s*#\s*(if|elif)\b.*$/gm) ?? []) expect(m).toMatch(/defined\s*\(/);
    expect(FRAG).toContain('#if !defined(NO_SHAPE_GRADIENT)');
    expect(FRAG).toContain('#if defined(NO_SHAPE_GRADIENT)');
  });
});

describe('what the borderless program removes', () => {
  const src = text(borderless);
  const gone = ['ShapeGrad_inner', 'SS_PillEval', 'SS_PillGrad', 'CornerEval', 'ShapeEval',
                'ShapeGrad(', 'normal', 'keyAlign', 'alignment', 'widthAlign', 'widthScale',
                'localBorderWidth', 'variedBorderWidth', 'drawnBorderWidth', 'borderCoverage',
                'borderBase', 'borderAlpha', 'GROUND_BOUNCE', 'BORDER_MIN_DEVICE_PX'];

  it('has no gradient path and no border chain left at all', () => {
    for (const name of gone) expect(src, `${name} survived into the borderless program`).not.toContain(name);
  });

  it('keeps every removed name in the flat program it narrows', () => {
    // Non-vacuity: these assertions would pass on a source that had never had any of it.
    for (const name of gone) expect(text(flat), `${name} was never in MATERIAL_FLAT`).toContain(name);
  });

  it('drops two of the shape path`s pow() calls and keeps the rest of the shader`s', () => {
    // `ShapeGrad_inner` is "two pow() calls, a length and a normalize" by the file's own comment.
    // `ShapeSDF_inner` (six) and `linearToSrgb` (one, called three times per OKLab stop) stay.
    const powCount = (s: string): number => (s.match(/pow\(/g) ?? []).length;
    expect(powCount(text(flat)) - powCount(src)).toBe(2);
    expect(src).toContain('float un = pow(uvE.x, n);');
    expect(src).toContain('return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;');
  });
});

describe('what the borderless program keeps, byte for byte', () => {
  const src = text(borderless);

  it('keeps the distance path — CornerParams, CornerDist, ShapeSDF_inner, SS_PillSDF', () => {
    expect(src).toContain('void CornerParams(vec2 p, vec2 halfSize, vec4 radii, float smoothness,');
    expect(src).toContain('float CornerDist(vec2 p, vec2 halfSize, vec4 radii, float smoothness) {');
    expect(src).toContain('float ShapeSDF_inner(vec2 p, vec2 halfSize, vec2 rAxis, float n) {');
    expect(src).toContain('float SS_PillSDF(vec2 p, vec2 halfSize) {');
    expect(src).toContain('float fillAlpha = 1.0 - smoothstep(-0.5, 0.5, dist);');
  });

  it('CornerDist and CornerEval return the SAME expression on the leg the routing admits', () => {
    // pillW <= 0: CornerDist returns `dSuper`, CornerEval assigns `distOut = dSuper` — and both
    // compute `dSuper` as `ShapeSDF_inner(p, halfSize, vec2(rCorner), n)` off the same
    // `CornerParams` call. Identical by inspection, which is what the pillW routing term buys.
    const f = text(flat);
    const cornerDist = /float CornerDist\([\s\S]*?\n\}/.exec(f)![0];
    const cornerEval = /void CornerEval\([\s\S]*?\n\}/.exec(f)![0];
    for (const fn of [cornerDist, cornerEval]) {
      expect(fn).toContain('CornerParams(p, halfSize, radii, smoothness, pillW, n, rCorner);');
      expect(fn).toContain('ShapeSDF_inner(p, halfSize, vec2(rCorner), n)');
      expect(fn).toContain('pillW <= 0.0');
    }
    // And the substituted call passes exactly what ShapeEval passed, minus the two out params.
    expect(text(flat)).toContain('ShapeEval(p, panelHalfSize, v_Radii, effectiveSmooth, mode, dist, normal);');
    expect(src).toContain('dist = CornerDist(p, panelHalfSize, v_Radii, effectiveSmooth);');
  });

  it('keeps the gradient fill, the dither, the clip stack, the shadow and both grades', () => {
    expect(src).toContain('vec4 sampleBgGradient(float t) {');
    expect(src).toContain('vec3 oklabToSrgb(vec3 lab) {');
    expect(src).toContain('vec4 resolveBgFill(vec2 panelLocal) {');
    expect(src).toContain('float gradDither = (gradientNoise(floor(gl_FragCoord.xy)) - 0.5) / 255.0;');
    expect(src).toContain('result.rgb += gradDither / max(result.a, 0.25);');
    expect(src).toContain('float clipStackDistance(vec2 pixel, int offset, int count) {');
    expect(src).toContain('shadowAlpha = smoothstep(shadowBlur, -shadowBlur, shadowDist) * v_ShadowColor.a;');
    expect(src).toContain('vec3 applyGrading(vec3 color, float brightness, float saturation, float contrast) {');
    expect(src).toContain('result.rgb = applyGrading(result.rgb, fgB / 256.0, fgS / 32.0, fgC / 32.0);');
    expect(src).toContain('result.a *= opacity * clipAlpha;');
  });

  it('keeps the composite and the border-only reset untouched', () => {
    expect(src).toContain('float outA = fillA + shadowAlpha * (1.0 - fillA);');
    expect(src).toContain('if (borderOnly == 1.0) {');
  });

  it('the stroke and the gradient dither still occur ONCE — no hand-written second copy', () => {
    const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;
    for (const s of [text(flat), text(none), text(glass)]) {
      expect(occurrences(s, 'float borderAlpha = borderBase * v_BorderColor.a;')).toBe(1);
    }
    for (const s of [src, text(flat), text(none), text(glass)]) {
      expect(occurrences(s, 'result.rgb += gradDither / max(result.a, 0.25);')).toBe(1);
    }
  });
});

// ── 3. ROUTING ───────────────────────────────────────────────────────────────────────────────────

describe('routing: which batches take the borderless program', () => {
  it('compiles a FOURTH program, and NO_SHAPE_GRADIENT is never issued without MATERIAL_FLAT', () => {
    // Five variants now: lane bgfill stacked TWO_STOP_GRADIENT on this one. The claim this test
    // makes is unchanged and is about the DEFINE SET, not the count - every Add that carries
    // NO_SHAPE_GRADIENT carries MATERIAL_FLAT too.
    // Re-aimed at the constant, not a literal: lane borderdirect issued a SIXTH variant
    // (MATERIAL_GLASS + BORDER_DIRECT). What this test is about — NO_SHAPE_GRADIENT is never
    // issued without MATERIAL_FLAT, and the count the constant claims is the count compiled — is
    // unchanged.
    expect(RENDERER).toContain(`export const PANEL_PROGRAM_COUNT = ${PANEL_PROGRAM_COUNT};`);
    expect(RENDERER).toContain(
      'batch.Add(panelVertSrc, panelFragSrc, { MATERIAL_FLAT: true, NO_SHAPE_GRADIENT: true })');
    const adds = RENDERER.match(/batch\.Add\(panelVertSrc, panelFragSrc[^)]*\)/g) ?? [];
    expect(adds.length).toBe(PANEL_PROGRAM_COUNT);
    for (const add of adds) {
      if (add.includes('NO_SHAPE_GRADIENT')) expect(add).toContain('MATERIAL_FLAT');
    }
  });

  it('issues it unconditionally, so both arms are ONE binary', () => {
    const compile = /_compilePanelShader = \(batch: ShaderBatch\): void => \{([\s\S]*?)\n  \};/.exec(RENDERER);
    expect(compile).not.toBeNull();
    expect(compile![1]).not.toContain('DiagBorderlessProgram');
    expect(compile![1]).not.toContain('if (');
  });

  it('narrows the FLAT classification rather than replacing it', () => {
    const pick = /const isBorderless = ([\s\S]*?);\n/.exec(RENDERER);
    expect(pick).not.toBeNull();
    const cond = pick![1];
    expect(cond).toContain('isFlat');
    expect(cond).toContain('this.DiagBorderlessProgram');
    expect(cond).toContain('this._batchTakesBorderlessProgram()');
    // A glass batch and a backdrop-filtered batch cannot reach it, because `isFlat` gates it.
    expect(RENDERER).toContain('const isFlat = !isGlass');
  });

  it('every bordered flat batch and every glass instance keeps its current program', () => {
    // The four-way pick, in order. Glass first (so no glass batch can fall through), then
    // borderless, then flat, then the full program. Lane borderdirect put ONE arm ahead of glass —
    // a glass batch whose backdrop handle is the border scratch — so the anchor moved by one line
    // and glass is now the second test rather than the first. Nothing below it moved.
    expect(RENDERER).toContain('const program = isBorderDirect ? this._panelShaderBorderDirect');
    expect(RENDERER).toContain(': isGlass ? this._panelShaderGlass');
    expect(RENDERER).toContain(': isBorderless ? this._panelShaderBorderless');
    expect(RENDERER).toContain(': isFlat ? this._panelShaderFlat');
    expect(RENDERER).toContain(': this._panelShaderNone;');
    expect(RENDERER).toContain('const locs = isBorderDirect ? this._panelLocsBorderDirect');
    expect(RENDERER).toContain(': isGlass ? this._panelLocsGlass');
    expect(RENDERER).toContain(': isBorderless ? this._panelLocsBorderless');
  });

  it('tests borderWidth for EXACT zero at the offset the packer writes it to', () => {
    const fn = /_batchTakesBorderlessProgram = \(\): boolean => \{([\s\S]*?)\n  \};/.exec(RENDERER);
    expect(fn).not.toBeNull();
    const body = fn![1];
    expect(body).toContain('if (d[b + PANEL_OFF_BORDER_WIDTH] !== 0) return false;');
    expect(RENDERER).toContain('const PANEL_OFF_BORDER_WIDTH = 27;');
    // a_ShadowParams is loc 7 → floats 24..27, and .w is borderWidth.
    expect(PACKER).toMatch(/data\[offset \+ 27\] = borderWidth;/);
    expect(PACKER).toContain('const borderWidth = style.BorderWidth * avgScale * d;');
    expect(readInstanceBuffer()).toContain('//   loc  7: a_ShadowParams (offsetX, offsetY, blur, borderWidth)');
    expect(text(none)).toContain('float borderWidth = v_ShadowParams.w;');
    // `!== 0` is true for BOTH signed zeros, which is correct: `±0 * widthScale` is ±0 and
    // `max(±0, 0.0)` is 0 either way. A `> epsilon` here would admit a border that paints.
    expect(body).not.toMatch(/Math\.abs\(d\[b \+ PANEL_OFF_BORDER_WIDTH\]\)/);
  });

  it('a BorderLayer `Suppress` instance is admitted, because the packer zeroes its width', () => {
    // The panel draws without its border (the border re-appears as a separate BorderOnly
    // instance), so the chain paints nothing there and removing it is a no-op — and the packer
    // writes a LITERAL 0, so the classifier sees exact zero rather than a scaled float.
    expect(PACKER).toMatch(/if \(borderMode === 'Suppress'\) \{\s*\n\s*data\[offset \+ 27\] = 0;/);
  });

  it('tests pillW for EXACT zero, with CornerParams` own expressions and constants', () => {
    const fn = /_batchTakesBorderlessProgram = \(\): boolean => \{([\s\S]*?)\n  \};/.exec(RENDERER)!;
    const body = fn[1];
    // The shader's constants, term for term.
    const frag = text(none);
    expect(frag).toContain('const float CORNER_SAT_FRAC    = 0.12;');
    expect(frag).toContain('const float CORNER_ASPECT_LO   = 1.02;');
    expect(frag).toContain('float satBand = max(minHalf * CORNER_SAT_FRAC, 1.0);');
    expect(frag).toContain('float sat   = smoothstep(minHalf - satBand, minHalf - 1.0, authoredR);');
    expect(frag).toContain('float elong = smoothstep(CORNER_ASPECT_LO, CORNER_ASPECT_HI, aspect);');
    expect(frag).toContain('pillW = sat * elong;');
    expect(frag).toContain('float authoredR  = floor(smoothness * 0.5) / 16.0;');
    expect(frag).toContain('float aspect  = maxHalf / max(minHalf, 0.0001);');
    expect(RENDERER).toContain('const CORNER_SAT_FRAC = Math.fround(0.12);');
    expect(RENDERER).toContain('const CORNER_ASPECT_LO = Math.fround(1.02);');
    expect(RENDERER).toContain('const CORNER_MIN_HALF = Math.fround(0.0001);');
    expect(body).toContain('const satBand = Math.max(fr(minHalf * CORNER_SAT_FRAC), 1);');
    expect(body).toContain('const satE0 = fr(minHalf - satBand);');
    expect(body).toContain('const satE1 = fr(minHalf - 1);');
    expect(body).toContain('const authoredR = Math.floor(d[b + PANEL_OFF_SMOOTH_PACKED] * 0.5) / 16;');
    expect(body).toContain('const aspect = fr(maxHalf / Math.max(minHalf, CORNER_MIN_HALF));');
    expect(body).toContain('if (authoredR <= satE0) continue;');
    expect(body).toContain('if (aspect <= CORNER_ASPECT_LO) continue;');
    // A degenerate smoothstep band is REFUSED, never reasoned about.
    expect(body).toContain('if (!(satE0 < satE1)) return false;');
  });

  it('reads pillW`s three inputs at the offsets the packer writes them to', () => {
    expect(RENDERER).toContain('const PANEL_OFF_HALF_W = 6;');
    expect(RENDERER).toContain('const PANEL_OFF_HALF_H = 7;');
    expect(RENDERER).toContain('const PANEL_OFF_SMOOTH_PACKED = 29;');
    expect(PACKER).toMatch(/data\[offset \+ 6\] = halfW;/);
    expect(PACKER).toMatch(/data\[offset \+ 7\] = halfH;/);
    expect(PACKER).toContain('data[offset + 29] = Math.max(0, Math.min(1, style.BorderRadiusSmoothness))');
    expect(PACKER).toContain('+ 2 * Math.round(authoredMin * 16);');
    // And the fragment reads the same lane back out of a_PanelGeom.zw / a_StyleParams.y.
    expect(text(none)).toContain('vec2 panelHalfSize = v_PanelGeom.zw;');
    expect(text(none)).toContain('float smoothness = v_StyleParams.y;');
  });

  it('ONE instance disqualifies the whole batch', () => {
    const body = /_batchTakesBorderlessProgram = \(\): boolean => \{([\s\S]*?)\n  \};/.exec(RENDERER)![1];
    expect((body.match(/return false;/g) ?? []).length).toBe(3);
    expect(body).toContain('return true;');
  });

  it('the classifier`s own arithmetic, run against a transcription of CornerParams', () => {
    // Everything above pins TEXT. This runs the two sides on the same numbers: a port of the
    // shader's `pillW`, and a port of the renderer's predicate, over the shapes this app draws.
    const fr = Math.fround;
    const smoothstep = (e0: number, e1: number, x: number): number => {
      const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    const shaderPillW = (halfW: number, halfH: number, packed: number): number => {
      const minHalf = Math.min(halfW, halfH);
      const maxHalf = Math.max(halfW, halfH);
      const aspect = maxHalf / Math.max(minHalf, 0.0001);
      const authoredR = Math.floor(packed * 0.5) / 16;
      const satBand = Math.max(minHalf * 0.12, 1);
      const sat = smoothstep(minHalf - satBand, minHalf - 1, authoredR);
      const elong = smoothstep(1.02, 1.1, aspect);
      return sat * elong;
    };
    const rendererAdmits = (halfW: number, halfH: number, packed: number): boolean => {
      const minHalf = Math.min(halfW, halfH);
      const maxHalf = Math.max(halfW, halfH);
      const satBand = Math.max(fr(minHalf * fr(0.12)), 1);
      const satE0 = fr(minHalf - satBand);
      const satE1 = fr(minHalf - 1);
      if (!(satE0 < satE1)) return false;
      const authoredR = Math.floor(packed * 0.5) / 16;
      if (authoredR <= satE0) return true;
      const aspect = fr(maxHalf / Math.max(minHalf, fr(0.0001)));
      return aspect <= fr(1.02);
    };
    const pack = (radiusPx: number, smooth = 0.6): number => smooth + 2 * Math.round(radiusPx * 16);

    // Every shape the classifier admits really is on the superellipse leg.
    let admitted = 0;
    let refusedButFlat = 0;
    for (const halfW of [8, 27, 54, 108, 216, 400, 900, 1470]) {
      for (const halfH of [4, 8, 15, 27, 75, 150, 216, 478]) {
        for (const r of [0, 1, 4, 16, 28, 56, 150, 478]) {
          const packed = pack(r);
          const admits = rendererAdmits(halfW, halfH, packed);
          const pillW = shaderPillW(halfW, halfH, packed);
          if (admits) { expect(pillW, `${halfW}x${halfH} r=${r}`).toBe(0); admitted++; }
          else if (pillW === 0) refusedButFlat++;
        }
      }
    }
    expect(admitted).toBeGreaterThan(100);
    // Non-vacuity in the other direction: the predicate is conservative, not universally true.
    expect(admitted + refusedButFlat).toBeLessThan(8 * 8 * 8);

    // The two shapes the bed is made of, named. `PerfPage` is the page's black fill at dpr 2 on
    // the measuring machine's 1470x956 desktop; `PerfBand` is one of the six gradient bands
    // (1800 x 1300/6 pt). Both radius 0, both borderless — both take the program.
    expect(rendererAdmits(1470, 956, pack(0))).toBe(true);
    expect(shaderPillW(1470, 956, pack(0))).toBe(0);
    expect(rendererAdmits(1800, 216.66, pack(0))).toBe(true);
    expect(shaderPillW(1800, 216.66, pack(0))).toBe(0);
    // A capsule is refused — that is the pill leg, which this lane does NOT admit.
    expect(rendererAdmits(78, 29, pack(29))).toBe(false);
    expect(shaderPillW(78, 29, pack(29))).toBeGreaterThan(0);
    // And a tiny panel whose smoothstep band is degenerate is refused rather than guessed at.
    expect(rendererAdmits(6, 6, pack(3))).toBe(false);
  });

  it('binds the fourth program without touching the scene ledger', () => {
    const use = /_useProgram = \(program: WebGLProgram\): void => \{([\s\S]*?)\n  \};/.exec(RENDERER)!;
    expect(use[1]).toContain('if (this._lastProgram === program) return;');
    expect(use[1]).not.toContain('_sceneLedger');
    expect(use[1]).not.toContain('NoteTargetBind');
  });
});

describe('the flag', () => {
  it('defaults ON and is turned off only by the literal value `off`', () => {
    expect(RENDERER).toContain('DiagBorderlessProgram = true;');
    expect(JAUI).toContain("const borderless = params.get('borderless-program');");
    expect(JAUI).toContain("const blArmed = armed && (blBad || borderless !== 'off');");
  });

  it('`?flat-program=off` implies it off, and the mark says so', () => {
    // With the flat routing gone there is no flat batch left to narrow, so claiming armed=on
    // would name a program no batch can reach.
    expect(JAUI).toContain("const blArmed = armed && (");
    expect(JAUI).toContain("reason=flat-program-off");
  });

  it('prints its mark on EVERY page, armed or not, and names its refusals', () => {
    expect(JAUI).toContain(
      'JTrace(`jaui:borderless-program armed=${blArmed ? \'on\' : \'off\'} programs=${webgl2 ? PANEL_PROGRAM_COUNT : 0}${blWhy}`);');
    expect(JAUI).toContain('reason=webgl2-only');
    expect(JAUI).toContain('reason=only-on-and-off-are-values-got-');
    expect(JAUI).not.toMatch(/jaui:borderless-program[^`]*programs=4/);
  });

  it('sets the renderer field only on a WebGL2 renderer', () => {
    expect(JAUI).toContain('if (webgl2) (r as WebGL2Renderer).DiagBorderlessProgram = blArmed;');
  });
});
