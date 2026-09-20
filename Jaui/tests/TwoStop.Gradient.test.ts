/**
 * `?two-stop-gradient` — TWO_STOP_GRADIENT: the bed's two-stop bands must not run a sixteen-stop
 * loop.
 *
 * ── THE FACT ────────────────────────────────────────────────────────────────────────────────────
 * Every fragment of a `LinearGradient` band runs `sampleBgGradient`, whose body is
 *
 *     for (int i = 1; i < MAX_BG_GRAD_STOPS; i++) {   // 16
 *         if (i > last) break;
 *         float p1 = u_BgGradPos[i];
 *         if (t <= p1) { ...four-term Hermite over u_BgGradValue[i-1..i], u_BgGradTangent[i-1..i]...
 *                        break; }
 *     }
 *
 * — a trip count the compiler cannot prove, a data-dependent `break`, and three uniform arrays
 * indexed by a variable. The bed's six bands are `LinearGradient(angle, from, to)`: TWO stops, so
 * the body runs exactly once, at `i == 1`. Binding the loop to 2 makes that one straight-line
 * evaluation with constant indices, on ~8 Mpx at dpr 2.
 *
 * ── WHAT THIS FILE ASSERTS ──────────────────────────────────────────────────────────────────────
 *   1. The variant is the borderless program's text with ONE line substituted — the `#define` the
 *      `for` reads its bound from. `sampleBgGradient`, `oklabToSrgb` and `linearToSrgb` are byte
 *      for byte identical between the two, and the uniform ARRAYS stay 16 wide in both.
 *   2. Running both bounds: over every two-stop curve and every `t` the shader can see, the two
 *      loops produce the same float, by `Object.is`. Non-vacuously — at three stops they differ.
 *   3. The routing admits exactly the draws whose fragments cannot reach the loop past `i == 1`.
 *
 * It does NOT prove a driver emits the same instructions for the lines both programs share — the
 * one way an unrolled four-term Hermite sum could move a pixel is FMA contraction reassociating
 * it, which no source-level test can see. `glassshot 0` on every glass scene is the shipping gate,
 * as it was for `flatprogram` and `flatprogram2`.
 */
import { describe, it, expect } from 'vitest';
import {
  PROGRAMS, programCode, preprocess, codeLines, braceBalance, linesNotIn,
  readPanelFrag, readRenderer, readJaui, stripTsComments,
} from './Flat.Program.Source';
import { PANEL_PROGRAM_COUNT } from '../src/Core/WebGL2.Renderer';
import { GradientCurveOf } from '../src/Core/Gradient.Curve';
import { MAX_GRADIENT_STOPS, type GradientStop } from '../src/Jiv/Jiv.Types';

const FRAG = readPanelFrag();
const RENDERER = stripTsComments(readRenderer());
const JAUI = stripTsComments(readJaui());

const glass = programCode('MATERIAL_GLASS');
const none = programCode('MATERIAL_NONE');
const flat = programCode('MATERIAL_FLAT');
const borderless = programCode('BORDERLESS');
const twoStop = programCode('TWO_STOP');
const text = (ls: ReadonlyArray<{ Text: string }>): string => ls.map((l) => l.Text).join('\n');

/** One function's whole text out of a program, by its signature line. */
const fnOf = (src: string, signature: string): string => {
  const at = src.indexOf(signature);
  expect(at, `${signature} is not in this program`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`[TwoStop] unterminated function ${signature}`);
};

const stop = (position: number, grey: number, easing?: number): GradientStop =>
  ({ Position: position, Color: { R: grey, G: grey * 0.5, B: 1 - grey, A: 1 }, Easing: easing });

// ── 1. THE PROGRAM IS THE SAME TEXT WITH THE BOUND SUBSTITUTED ───────────────────────────────────

describe('the two-stop program is a BOUND SUBSTITUTION, not a rewrite', () => {
  it('is cut from the same source by the same preprocessor, and is syntactically whole', () => {
    expect(() => preprocess(FRAG, PROGRAMS.TWO_STOP)).not.toThrow();
    expect(braceBalance(twoStop)).toBe(0);
    for (const name of ['MATERIAL_GLASS', 'MATERIAL_NONE', 'MATERIAL_FLAT', 'BORDERLESS'] as const) {
      expect(braceBalance(programCode(name))).toBe(0);
    }
    expect(braceBalance(codeLines(preprocess(FRAG, [])))).toBe(0);
  });

  it('differs from the borderless program in EXACTLY one line, both ways', () => {
    expect(linesNotIn(twoStop, borderless).map((l) => l.Text)).toEqual(['#define BG_GRAD_LOOP_STOPS 2']);
    expect(linesNotIn(borderless, twoStop).map((l) => l.Text))
      .toEqual(['#define BG_GRAD_LOOP_STOPS MAX_BG_GRAD_STOPS']);
    // Same line COUNT: nothing was added or removed, one line was swapped for another.
    expect(twoStop.length).toBe(borderless.length);
  });

  it('`sampleBgGradient` is byte for byte the same function in both programs', () => {
    // The brief's whole demand: the same p0/p1/h/u/u2/u3, the same four-term Hermite sum, the same
    // clamps, the same early returns. Nothing was hand-written for two stops.
    const sig = 'vec4 sampleBgGradient(float t) {';
    expect(fnOf(text(twoStop), sig)).toBe(fnOf(text(borderless), sig));
    expect(fnOf(text(twoStop), sig)).toBe(fnOf(text(glass), sig));
    // And the loop reads its bound from a macro in BOTH — the line itself never changes.
    expect(fnOf(text(twoStop), sig)).toContain('for (int i = 1; i < BG_GRAD_LOOP_STOPS; i++) {');
    expect(fnOf(text(twoStop), sig)).toContain('if (i > last) break;');
    expect(fnOf(text(twoStop), sig)).toContain(
      'v = (2.0 * u3 - 3.0 * u2 + 1.0) * u_BgGradValue[i - 1]');
    for (const early of ['if (u_BgGradStopCount <= 0) return vec4(0.0);',
                         'if (u_BgGradStopCount == 1 || t <= u_BgGradPos[0]) {',
                         'if (h <= 0.0) { v = u_BgGradValue[i]; break; }',
                         'float u = clamp((t - p0) / h, 0.0, 1.0);',
                         'if (a < 1e-4) return vec4(0.0);']) {
      expect(fnOf(text(twoStop), sig)).toContain(early);
    }
  });

  it('the OKLab path stays byte for byte, in every program', () => {
    for (const sig of ['vec3 oklabToSrgb(vec3 lab) {', 'float linearToSrgb(float c) {',
                       'vec4 resolveBgFill(vec2 panelLocal) {', 'float gradientNoise(vec2 pixel) {']) {
      expect(fnOf(text(twoStop), sig)).toBe(fnOf(text(borderless), sig));
      expect(fnOf(text(twoStop), sig)).toBe(fnOf(text(none), sig));
    }
    // Three pow() per stop conversion: linearToSrgb called once per channel. The brief asked for
    // that to be checked rather than assumed — here it is, and it is untouched.
    expect(fnOf(text(twoStop), 'float linearToSrgb(float c) {'))
      .toContain('1.055 * pow(c, 1.0 / 2.4) - 0.055');
    expect(fnOf(text(twoStop), 'vec3 oklabToSrgb(vec3 lab) {'))
      .toContain('return vec3(linearToSrgb(lin.r), linearToSrgb(lin.g), linearToSrgb(lin.b));');
  });

  it('the uniform ARRAYS keep all 16 slots in every variant — only the LOOP is bound', () => {
    // `_bindBgPaint` uploads `curve.Value`, a MAX_GRADIENT_STOPS-wide Float32Array, with one
    // `uniform4fv`. A narrower declaration would be a GL error, not an optimisation.
    for (const src of [text(twoStop), text(borderless), text(flat), text(none), text(glass)]) {
      expect(src).toContain('#define MAX_BG_GRAD_STOPS 16');
      expect(src).toContain('uniform vec4      u_BgGradValue[MAX_BG_GRAD_STOPS];');
      expect(src).toContain('uniform vec4      u_BgGradTangent[MAX_BG_GRAD_STOPS];');
      expect(src).toContain('uniform float     u_BgGradPos[MAX_BG_GRAD_STOPS];');
    }
    expect(MAX_GRADIENT_STOPS).toBe(16);
    expect(GradientCurveOf([stop(0, 0), stop(1, 1)]).Value.length).toBe(MAX_GRADIENT_STOPS * 4);
    expect(RENDERER).toContain('gl.uniform4fv(locs.bgGradValue, curve.Value);');
  });

  it('the bound macro is used in exactly one place, and it is the `for`', () => {
    const uses = FRAG.split('\n').map((l) => l.trim())
      .filter((l) => /\bBG_GRAD_LOOP_STOPS\b/.test(l) && !l.startsWith('//'));
    expect(uses).toEqual([
      '#define BG_GRAD_LOOP_STOPS 2',
      '#define BG_GRAD_LOOP_STOPS MAX_BG_GRAD_STOPS',
      'for (int i = 1; i < BG_GRAD_LOOP_STOPS; i++) {',
    ]);
    // Two definitions, one consumer, and the guard around them is the whole of it. `readPanelFrag`
    // normalises CRLF, so this is an LF comparison on either platform.
    expect(FRAG).toContain('#if defined(TWO_STOP_GRADIENT)\n#define BG_GRAD_LOOP_STOPS 2\n#else\n'
      + '#define BG_GRAD_LOOP_STOPS MAX_BG_GRAD_STOPS\n#endif');
    // The old bound is gone from the loop, and nowhere else was touched.
    expect(FRAG).not.toContain('i < MAX_BG_GRAD_STOPS');
  });

  it('every guard tests PRESENCE, and TWO_STOP_GRADIENT is never issued without the other two', () => {
    for (const m of FRAG.match(/^\s*#\s*(if|elif)\b.*$/gm) ?? []) expect(m).toMatch(/defined\s*\(/);
    expect(FRAG).toContain('#if defined(TWO_STOP_GRADIENT)');
    // Against the constant, not a literal: lane borderdirect issued a sixth variant and lane
    // bootcompile2 moved it off the boot batch, so this regex -- anchored on `batch.Add`, which is
    // the boot batch's parameter name -- counts the five the constant claims. The claim —
    // TWO_STOP_GRADIENT is never issued without the other two — is unchanged and asserted below.
    const adds = RENDERER.match(/batch\.Add\(panelVertSrc, panelFragSrc[^)]*\)/g) ?? [];
    expect(adds.length).toBe(PANEL_PROGRAM_COUNT);
    for (const add of adds) {
      if (add.includes('TWO_STOP_GRADIENT')) {
        expect(add).toContain('MATERIAL_FLAT');
        expect(add).toContain('NO_SHAPE_GRADIENT');
      }
    }
    expect(adds.filter((a) => a.includes('TWO_STOP_GRADIENT')).length).toBe(1);
  });

  it('leaves the four older programs exactly where flatprogram2 left them', () => {
    // The new `#if` must be invisible to every program that does not define TWO_STOP_GRADIENT:
    // those are the `?flat-program=off` arm, the `?borderless-program=off` arm and every glass
    // scene, and all three are gated by a pixel-zero claim of their own.
    expect(linesNotIn(none, glass).map((l) => l.Text)).toEqual(['const float materialType = 0.0;']);
    expect(linesNotIn(glass, none).map((l) => l.Text)).toEqual(['const float materialType = 1.0;']);
    expect(linesNotIn(flat, none).map((l) => l.Text)).toEqual(['const bool hasBackdropFilter = false;']);
    expect(linesNotIn(borderless, flat).map((l) => l.Text))
      .toEqual(['dist = CornerDist(p, panelHalfSize, v_Radii, effectiveSmooth);']);
    for (const p of [none, glass, flat, borderless]) {
      expect(text(p)).toContain('#define BG_GRAD_LOOP_STOPS MAX_BG_GRAD_STOPS');
    }
  });
});

// ── 2. THE TWO BOUNDS, RUN ───────────────────────────────────────────────────────────────────────

/** The shader's own loop bound, read out of the file rather than written here a second time. */
const glslMaxStops = Number(/#define\s+MAX_BG_GRAD_STOPS\s+(\d+)/.exec(FRAG)![1]);

/**
 * `sampleBgGradient`, transcribed term for term, with the loop bound as a parameter. Float64
 * rather than float32 on purpose: the claim is that the two BOUNDS take the same iterations over
 * the same operands, which is a claim about the algorithm and not about rounding — float32 would
 * round both sides identically and could only hide a difference.
 */
const sampleBgGradient = (
  bound: number, stopCount: number, pos: readonly number[],
  value: readonly number[][], tangent: readonly number[][], t: number,
): [number, number, number, number] => {
  if (stopCount <= 0) return [0, 0, 0, 0];
  const last = stopCount - 1;
  let v = value[last];
  if (stopCount === 1 || t <= pos[0]) {
    v = value[0];
  } else {
    for (let i = 1; i < bound; i++) {
      if (i > last) break;
      const p1 = pos[i];
      if (t <= p1) {
        const p0 = pos[i - 1];
        const h = p1 - p0;
        if (h <= 0) { v = value[i]; break; }
        const u = Math.min(1, Math.max(0, (t - p0) / h));
        const u2 = u * u;
        const u3 = u2 * u;
        v = [0, 1, 2, 3].map((c) =>
          (2 * u3 - 3 * u2 + 1) * value[i - 1][c]
          + (u3 - 2 * u2 + u) * h * tangent[i - 1][c]
          + (-2 * u3 + 3 * u2) * value[i][c]
          + (u3 - u2) * h * tangent[i][c]);
        break;
      }
    }
  }
  const a = Math.min(1, Math.max(0, v[3]));
  if (a < 1e-4) return [0, 0, 0, 0];
  return [v[0] / a, v[1] / a, v[2] / a, a];
};

const asRows = (packed: Float32Array): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i < packed.length; i += 4) out.push([packed[i], packed[i + 1], packed[i + 2], packed[i + 3]]);
  return out;
};

describe('bound 2 and bound 16 agree, bit for bit, on every gradient the routing admits', () => {
  // Every `t` a band fragment can produce: `resolveBgFill` clamps to [0, 1] before the call.
  const TS: number[] = [];
  for (let k = 0; k <= 512; k++) TS.push(k / 512);
  TS.push(Number.EPSILON, 1 - Number.EPSILON, 0.3333333333333333);

  const agree = (curveStops: GradientStop[]): { Same: number; Count: number } => {
    const curve = GradientCurveOf(curveStops);
    const pos = Array.from(curve.Position);
    const value = asRows(curve.Value);
    const tangent = asRows(curve.Tangent);
    let same = 0;
    for (const t of TS) {
      const a = sampleBgGradient(glslMaxStops, curve.Count, pos, value, tangent, t);
      const b = sampleBgGradient(2, curve.Count, pos, value, tangent, t);
      if (a.every((x, i) => Object.is(x, b[i]))) same++;
    }
    return { Same: same, Count: curve.Count };
  };

  it('a two-stop gradient reads the same under both bounds, for every t', () => {
    // The bed's own shape: two stops, no easing, the endpoints at 0 and 1.
    const r = agree([stop(0, 0.9), stop(1, 0.12)]);
    expect(r.Count).toBe(2);
    expect(r.Same).toBe(TS.length);
    expect(TS.length).toBeGreaterThan(500);
  });

  it('and for two-stop gradients whose knots are NOT at the ends, and for degenerate ones', () => {
    for (const stops of [
      [stop(0.25, 0.8), stop(0.75, 0.1)],
      [stop(0, 1), stop(0.001, 0)],
      [stop(0.5, 0.3), stop(0.5, 0.7)],   // h == 0 — the `if (h <= 0.0)` arm
      [stop(0, 0), stop(1, 0)],
    ]) {
      const r = agree(stops);
      expect(r.Count).toBeLessThanOrEqual(2);
      expect(r.Same, JSON.stringify(stops)).toBe(TS.length);
    }
  });

  it('a one-stop and a zero-stop gradient never reach the loop at all', () => {
    const one = agree([stop(0.4, 0.5)]);
    expect(one.Count).toBe(1);
    expect(one.Same).toBe(TS.length);
    for (const t of [0, 0.5, 1]) {
      expect(sampleBgGradient(2, 0, [], [], [], t)).toEqual([0, 0, 0, 0]);
      expect(sampleBgGradient(glslMaxStops, 0, [], [], [], t)).toEqual([0, 0, 0, 0]);
    }
  });

  it('NON-VACUITY: at three stops the two bounds DISAGREE, which is why the routing exists', () => {
    const r = agree([stop(0, 0.9), stop(0.5, 0.3), stop(1, 0.05)]);
    expect(r.Count).toBe(3);
    expect(r.Same).toBeLessThan(TS.length);
    // They still agree on the first segment, so the difference is the missing iterations and not
    // a broken transcription.
    expect(r.Same).toBeGreaterThan(0);
  });

  it('an EASED two-stop gradient is MORE than two knots, and is refused by the routing', () => {
    // `GradientCurveOf` lays an eased segment down as extra knots before fitting tangents, so
    // "two authored stops" is not "two knots". `Count` is what the routing reads, and it is right.
    const eased = GradientCurveOf([stop(0, 0.9, 1.6), stop(1, 0.1)]);
    expect(eased.Count).toBeGreaterThan(2);
    expect(agree([stop(0, 0.9, 1.6), stop(1, 0.1)]).Same).toBeLessThan(TS.length);
  });
});

// ── 3. ROUTING ───────────────────────────────────────────────────────────────────────────────────

describe('routing: which draws take the two-stop program', () => {
  it('narrows the BORDERLESS classification rather than replacing it', () => {
    const pick = /const isTwoStop = ([\s\S]*?);\n/.exec(RENDERER);
    expect(pick).not.toBeNull();
    const cond = pick![1];
    expect(cond).toContain('isBorderless');
    expect(cond).toContain('this.DiagTwoStopGradient');
    expect(cond).toContain('_paintFitsTwoStops(bgPaint)');
    // A glass batch, a backdrop-filtered batch and a bordered batch cannot reach it: `isBorderless`
    // gates it, and is itself gated by `isFlat`.
    expect(RENDERER).toContain(
      'const isBorderless = isFlat && this.DiagBorderlessProgram && this._batchTakesBorderlessProgram();');
  });

  it('the five-way pick puts it ahead of borderless and behind glass', () => {
    // Six-way since lane borderdirect, which put the border-direct arm ahead of glass. The
    // two-stop arm's own position — after glass, ahead of borderless — is what this tests and it
    // did not move. The first arm is `direct` since lane bootcompile2: that program is compiled
    // only when `?border-direct` arms, so the pick resolves it through a throw rather than naming
    // a field that can be null. Position unchanged, and everything below it unchanged.
    expect(RENDERER).toContain('const program = direct !== null ? direct.Shader');
    expect(RENDERER).toContain(': isGlass ? this._panelShaderGlass');
    expect(RENDERER).toContain(': isTwoStop ? this._panelShaderTwoStop');
    expect(RENDERER).toContain(': isBorderless ? this._panelShaderBorderless');
    expect(RENDERER).toContain(': isFlat ? this._panelShaderFlat');
    expect(RENDERER).toContain(': this._panelShaderNone;');
    expect(RENDERER).toContain(': isGlass ? this._panelLocsGlass');
    expect(RENDERER).toContain(': isTwoStop ? this._panelLocsTwoStop');
    // And its locations are extracted like every other variant's.
    expect(RENDERER).toContain(
      'this._panelLocsTwoStop = _extractPanelLocs(gl, this._panelShaderTwoStop.Program);');
  });

  it('asks the question of the DRAW, not of the instances: the stop count is a batch uniform', () => {
    const fn = /const _paintFitsTwoStops = \(bgPaint: BgPaint \| undefined\): boolean => \{([\s\S]*?)\n\};/
      .exec(RENDERER);
    expect(fn).not.toBeNull();
    const body = fn![1];
    expect(body).toContain(
      "if (bgPaint === undefined || bgPaint.Mode === 'Color' || bgPaint.Mode === 'Image') return true;");
    expect(body).toContain('return bgPaint.Curve.Count <= 2;');
    // There is no per-instance scan here, and there must not be: `u_BgGradStopCount` is one
    // uniform per DRAW, set from this very `bgPaint`.
    expect(body).not.toContain('_panelInstanceCount');
    expect(RENDERER).toContain('gl.uniform1i(locs.bgGradStopCount, curve.Count);');
    // …and every non-gradient arm of `_bindBgPaint` writes 0, so the loop is unreachable there.
    expect((RENDERER.match(/gl\.uniform1i\(locs\.bgGradStopCount, 0\);/g) ?? []).length).toBe(2);
  });

  it('the classifier`s own arithmetic, run', () => {
    const fits = (paint: { Mode: string; Curve?: { Count: number } } | undefined): boolean => {
      if (paint === undefined || paint.Mode === 'Color' || paint.Mode === 'Image') return true;
      return paint.Curve!.Count <= 2;
    };
    // The page's black fill: `_computeBgPaint` returns undefined for a Color background, so the
    // draw arrives with no paint at all. Mode 0 never calls `sampleBgGradient`.
    expect(fits(undefined)).toBe(true);
    expect(fits({ Mode: 'Color' })).toBe(true);
    expect(fits({ Mode: 'Image' })).toBe(true);
    // One of the bed's bands.
    expect(fits({ Mode: 'LinearGradient', Curve: GradientCurveOf([stop(0, 0.9), stop(1, 0.1)]) })).toBe(true);
    // A three-stop gradient, and an eased two-stop one, both keep the borderless program.
    expect(fits({ Mode: 'LinearGradient', Curve: GradientCurveOf([stop(0, 0.9), stop(0.5, 0.4), stop(1, 0.1)]) }))
      .toBe(false);
    expect(fits({ Mode: 'RadialGradient', Curve: GradientCurveOf([stop(0, 0.9, 1.6), stop(1, 0.1)]) }))
      .toBe(false);
  });

  it('a Color draw is admitted ON PURPOSE — the page fill is the biggest surface on the bed', () => {
    // Not an oversight and not a convenience: a program's register footprint and instruction size
    // are set by its heaviest path whether a fragment takes it or not, which is flatprogram's
    // whole thesis. The page's ~8 Mpx of mode-0 black should not be shaded by a program that can
    // walk a sixteen-knot spline. It is bit-safe for a reason the shader itself makes plain.
    const resolve = fnOf(text(twoStop), 'vec4 resolveBgFill(vec2 panelLocal) {');
    expect(resolve).toContain('if (u_BgMode == 1) {');
    expect(resolve).toContain('} else if (u_BgMode == 2) {');
    expect(resolve).toContain('} else if (u_BgMode == 3) {');
    // Mode 0 falls out of the chain to `v_Tint` without touching `sampleBgGradient`, and the two
    // gradient arms are the ONLY callers of it in the whole program.
    expect(resolve.trimEnd().endsWith('return v_Tint;\n}')).toBe(true);
    expect((text(twoStop).match(/sampleBgGradient\(/g) ?? []).length).toBe(3); // the decl + two calls
    expect(resolve).toContain('return sampleBgGradient(clamp(t, 0.0, 1.0));');
    expect(resolve).toContain('return sampleBgGradient(clamp(d, 0.0, 1.0));');
  });

  it('issues the fifth program unconditionally, so both arms are ONE binary', () => {
    const compile = /_compilePanelShader = \(batch: ShaderBatch\): void => \{([\s\S]*?)\n  \};/.exec(RENDERER);
    expect(compile).not.toBeNull();
    expect(compile![1]).not.toContain('DiagTwoStopGradient');
    expect(compile![1]).not.toContain('if (');
    expect(RENDERER).toContain(`export const PANEL_PROGRAM_COUNT = ${PANEL_PROGRAM_COUNT};`);
  });
});

describe('the flag', () => {
  it('defaults ON and is turned off only by the literal value `off`', () => {
    expect(RENDERER).toContain('DiagTwoStopGradient = true;');
    expect(JAUI).toContain("const twoStop = params.get('two-stop-gradient');");
    expect(JAUI).toContain("const tsArmed = blArmed && (tsBad || twoStop !== 'off');");
    expect(JAUI).toContain('if (webgl2) (r as WebGL2Renderer).DiagTwoStopGradient = tsArmed;');
  });

  it('BOTH flags above imply it off, and the mark names which', () => {
    expect(JAUI).toContain('reason=flat-program-off');
    expect(JAUI).toContain('reason=borderless-program-off');
    // `tsArmed` is gated on `blArmed`, which is itself gated on `armed` — one chain, so the third
    // mark can never claim a program the first two have routed nothing to.
    expect(JAUI).toContain('const blArmed = armed && (');
    expect(JAUI).toContain('const tsArmed = blArmed && (');
  });

  it('prints its mark on EVERY page, armed or not, and names its refusals', () => {
    expect(JAUI).toContain(
      'JTrace(`jaui:two-stop-gradient armed=${tsArmed ? \'on\' : \'off\'} programs=${webgl2 ? PANEL_PROGRAM_COUNT : 0}${tsWhy}`);');
    expect(JAUI).toContain('reason=webgl2-only');
    expect(JAUI).toContain('reason=only-on-and-off-are-values-got-');
    // The count is read from the renderer's exported constant, never written into the line.
    expect(JAUI).not.toMatch(/jaui:two-stop-gradient[^`]*programs=5/);
  });

  it('refuses a value that is neither `on` nor `off` rather than quietly picking one', () => {
    expect(JAUI).toContain(
      "const tsBad = twoStop !== null && twoStop !== '' && twoStop !== 'on' && twoStop !== 'off';");
    // The bare flag (`?two-stop-gradient`) is the DEFAULT arm, not a toggle: `params.get` returns
    // '' for it, and '' is not 'off'.
    const armedOf = (v: string | null): boolean => {
      const bad = v !== null && v !== '' && v !== 'on' && v !== 'off';
      return bad || v !== 'off';
    };
    expect(armedOf(null)).toBe(true);
    expect(armedOf('')).toBe(true);
    expect(armedOf('on')).toBe(true);
    expect(armedOf('off')).toBe(false);
    expect(armedOf('of')).toBe(true);
  });
});
