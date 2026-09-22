/**
 * Lane glassreg - the glass program's variants, read out of the REAL `Jiv.Panel.frag`.
 *
 * No GLSL compiler runs here, so every claim is a claim about the TEXT the preprocessor leaves:
 *
 *   1. Every variant is syntactically whole and every local it reads is declared, earlier, in an
 *      enclosing block (`Glass.Reg.Source.walkScopes`) - the check a compiler would have made
 *      first, run on all fourteen define sets.
 *   2. The compile-time exclusions are DELETIONS: BORDER_ONLY adds one line (its starting `result`)
 *      and removes exactly the body stages; NO_GLOW removes exactly the rim glow's block, NO_SPEC
 *      exactly the catchlight's.
 *   3. GLASS_REG is a PERMUTATION of the glass program's lines, REMAT adds exactly its three
 *      recomputes, NOGATES differs in exactly `GlassSkips`' body.
 *   4. THE REGISTER MAP: the scalar components each program holds across each heavy statement,
 *      computed from the source and asserted as numbers.
 *
 * The pixel claim rests on (2) and (3) plus the arithmetic argument in the shader's header; the
 * shipping gate is still the fold's shots, because the text cannot see what a driver contracts.
 */
import { describe, it, expect } from 'vitest';
import { braceBalance, linesNotIn, readRenderer, stripTsComments } from './Flat.Program.Source';
import {
  GLASS_PROGRAMS, glassProgram, mainOf, walkScopes, multisetMinus, registerMap, ANCHORS,
  type GlassProgramName, type Anchor, type Line,
} from './Glass.Reg.Source';
import { GLASS_REG_DEFINES, GLASS_VARIANT_DEFINES } from '@jaui/Core/Glass.Programs';
import { PANEL_PROGRAM_COUNT, GLASS_VARIANT_PROGRAMS, GLASS_REG_PROGRAMS } from '@jaui/Core/WebGL2.Renderer';
import { arrowBody, readJaui } from './Scene.ReadAfterWrite.Source';

const NAMES = Object.keys(GLASS_PROGRAMS) as GlassProgramName[];
const text = (ls: readonly Line[]): string[] => ls.map((l) => l.Text);
const GLASS = glassProgram('GLASS');

/** Lines of `sup` whose original line number `sub` does not carry: what `sub` deleted. */
const deleted = (sub: readonly Line[], sup: readonly Line[]): Line[] => {
  const keep = new Set(sub.map((l) => l.N));
  return sup.filter((l) => !keep.has(l.N));
};

describe('every glass variant is whole: balanced, every read declared and in scope', () => {
  for (const name of NAMES) {
    it(name, () => {
      const lines = glassProgram(name);
      expect(braceBalance(lines)).toBe(0);
      const walk = walkScopes(mainOf(lines));
      expect(walk.Dangling, `${name} reads a local with no declaration in scope`).toEqual([]);
      expect(walk.Redeclared, `${name} redeclares a local in one scope`).toEqual([]);
      // Non-vacuity: the walk saw main's locals, and resolved their reads.
      expect(walk.Locals.length).toBeGreaterThan(60);
      expect(walk.Locals.find((v) => v.Name === 'dist')!.Uses.length).toBeGreaterThan(5);
    });
  }

  it('the scope walk catches the break it exists for', () => {
    // Move one read above its declaration and the walk names it: the negative control.
    const main = mainOf(GLASS);
    const at = main.findIndex((l) => l.Text.startsWith('float edgeDist = max(-dist, 0.0);'));
    const broken = [...main];
    broken.splice(at, 0, { N: -1, Text: 'float probe = fillAlpha;' });
    expect(walkScopes(broken).Dangling.map((d) => d.Name)).toEqual(['fillAlpha']);
  });
});

describe('GLASS_BORDER_ONLY - the rim overlay program is a deletion plus its starting result', () => {
  const bo = glassProgram('BORDER_ONLY');
  const gone = text(deleted(bo, GLASS));

  it('adds exactly one line: the vec4(0.0) the border-only reset would have written anyway', () => {
    expect(text(linesNotIn(bo, GLASS))).toEqual(['vec4 result = vec4(0.0);']);
    // And the reset itself is still there, so the argument is checkable on the page: every
    // fragment of an admitted batch runs it.
    expect(text(bo)).toContain('if (borderOnly == 1.0) {');
    expect(text(bo)).toContain('result = vec4(0.0);');
  });

  it('removes the body: taps, grade, absorption, shadow, fill composite, rim glow, ambient, catchlight', () => {
    for (const stmt of [
      'float caSpreadPx = 0.2 * chromaticAberration * length(refractOffset);',
      'vec3 sG = sampleBackdrop(uvG, lodBoost, frostLod);',
      'backdrop = applyTint(applyGrading(backdrop, brightness, saturation, contrast), bodyTint);',
      'vec3 absorb = pow(max(v_Tint.rgb, vec3(0.0001)), vec3(pathLength * v_Tint.a));',
      'float shadowDist = ShapeSDF(sp, panelHalfSize, v_Radii, effectiveSmooth, mode);',
      'vec4 fillSrc = resolveBgFill(panelLocal);',
      'vec3 rimSample = sampleBackdrop(rimUv, 0.0, frostLod);',
      'float hemiAmbient = (edgeLightTop * hemiTop + edgeLightBottom * hemiBottom);',
      'float spec = 0.5 * min(glowTerm + edgeTerm, 1.0) * lightIntensity * glassiness * fillAlpha;',
      'result.rgb = max(mix(result.rgb + spec, result.rgb * (1.0 - spec), darken), vec3(0.0));',
    ]) expect(gone, stmt).toContain(stmt);
  });

  it('keeps everything the border zone reads, and everything after it', () => {
    for (const stmt of [
      'float clipD = clipStackDistance(v_PixelPos, int(v_Outline.z), int(v_Outline.w));',
      'ShapeEval(p, panelHalfSize, v_Radii, effectiveSmooth, mode, dist, normal);',
      'float refractFp = length(fwidth(refractOffset));',
      'lodBoost = ((rimBoost * 1.5 + innerBlur * 1.0) * glassiness + refractLod) * frostReq;',
      'float borderCoverage = variedBorderWidth / drawnBorderWidth;',
      'vec3 bSample = sampleBackdrop(bUv, bLod, frostLod);',
      'float borderZoneAlpha = mix(fillAlpha, 1.0, borderOnly);',
      'result.rgb = result.rgb * (1.0 - edgeLightAlpha) + edgeLightRgb * edgeLightAlpha;',
      'result.a *= opacity * clipAlpha;',
      'result.rgb += triDither(v_PixelPos);',
    ]) {
      expect(text(bo), stmt).toContain(stmt);
      expect(gone, stmt).not.toContain(stmt);
    }
  });
});

/** The deleted lines are ONE contiguous, balanced block of the glass program starting at `head`. */
const exactlyTheBlock = (gone: readonly Line[], head: string): void => {
  const at = GLASS.findIndex((l) => l.N === gone[0].N);
  expect(gone[0].Text).toBe(head);
  expect(text(gone)).toEqual(text(GLASS.slice(at, at + gone.length)));
  expect(braceBalance(gone)).toBe(0);
};

describe('GLASS_NO_GLOW / GLASS_NO_SPEC - each deletes exactly its own block and adds nothing', () => {
  it('NO_GLOW: the wide rim glow, tap and three pow, and nothing else', () => {
    const p = glassProgram('NO_GLOW');
    expect(linesNotIn(p, GLASS)).toEqual([]);
    const gone = deleted(p, GLASS);
    exactlyTheBlock(gone, 'if (GlassSkips(GLASS_SKIP_RIM)) {} else');
    expect(text(gone)).toContain('edgeLightAlpha = falloff * directional * fresnelStrength * fillAlpha;');
    // The initialisers and the composite stay: `r*1 + (+0)` on both sides.
    expect(text(p)).toContain('float edgeLightAlpha = 0.0;');
    expect(text(p)).toContain('result.a = result.a * (1.0 - edgeLightAlpha) + edgeLightAlpha;');
  });

  it('NO_SPEC: the highlight (the aave glow and edge band, adaptive), and nothing else', () => {
    const p = glassProgram('NO_SPEC');
    expect(linesNotIn(p, GLASS)).toEqual([]);
    const gone = deleted(p, GLASS);
    exactlyTheBlock(gone, 'if (!GlassSkips(GLASS_SKIP_SPECULAR)) {');
    expect(text(gone)).toContain('float spec = 0.5 * min(glowTerm + edgeTerm, 1.0) * lightIntensity * glassiness * fillAlpha;');
  });

  it('NO_LIGHT is the two deletions together, and the renderer cuts it with both defines', () => {
    const pair = new Set(deleted(glassProgram('NO_LIGHT'), GLASS).map((l) => l.N));
    const union = new Set([...deleted(glassProgram('NO_GLOW'), GLASS), ...deleted(glassProgram('NO_SPEC'), GLASS)].map((l) => l.N));
    expect([...pair].sort()).toEqual([...union].sort());
    expect(GLASS_VARIANT_DEFINES.noLight).toEqual({ GLASS_NO_GLOW: true, GLASS_NO_SPEC: true });
    expect(GLASS_VARIANT_DEFINES.borderOnly).toEqual({ GLASS_BORDER_ONLY: true });
  });
});

describe('GLASS_REG - the same lines in another order', () => {
  const reg = glassProgram('REG');

  it('is a permutation of the glass program: no line added, none lost, none rewritten', () => {
    expect(multisetMinus(reg, GLASS)).toEqual([]);
    expect(multisetMinus(GLASS, reg)).toEqual([]);
    // Non-vacuity: the order DID change.
    expect(text(reg)).not.toEqual(text(GLASS));
  });

  it('and so are its border-only and no-light cuts, of theirs', () => {
    for (const [a, b] of [['REG_BORDER_ONLY', 'BORDER_ONLY'], ['REG_NO_LIGHT', 'NO_LIGHT']] as const) {
      expect(multisetMinus(glassProgram(a), glassProgram(b)), a).toEqual([]);
      expect(multisetMinus(glassProgram(b), glassProgram(a)), a).toEqual([]);
    }
  });

  const pos = (lines: readonly Line[], stmt: string): number => {
    const i = lines.findIndex((l) => l.Text.startsWith(stmt));
    if (i < 0) throw new Error(`no '${stmt}'`);
    return i;
  };

  it('moves what the register map says it moves', () => {
    const before = (lines: readonly Line[], a: string, b: string): boolean => pos(lines, a) < pos(lines, b);
    // The drop shadow's corner field beside the main one, ahead of the bezel.
    expect(before(reg, 'float shadowDist = ShapeSDF(sp,', 'float edgeDist = max(-dist, 0.0);')).toBe(true);
    expect(before(GLASS, 'float shadowDist = ShapeSDF(sp,', 'float edgeDist = max(-dist, 0.0);')).toBe(false);
    // The fill composite straight after the taps: before the border chain and the rim glow.
    expect(before(reg, 'vec4 result = vec4(outRGB, outA);', 'float keyAlign = dot(normal, lightDir);')).toBe(true);
    expect(before(reg, 'vec4 result = vec4(outRGB, outA);', 'vec3 rimSample = sampleBackdrop(rimUv,')).toBe(true);
    expect(before(GLASS, 'vec4 result = vec4(outRGB, outA);', 'vec3 rimSample = sampleBackdrop(rimUv,')).toBe(false);
    // `lightDir` and `aa` declared at their first reader.
    expect(pos(reg, 'vec2 lightDir =') + 1).toBe(pos(reg, 'const float GROUND_BOUNCE = 0.95;'));
    expect(before(reg, 'vec3 rimSample = sampleBackdrop(rimUv,', 'float aa = max(borderEdgeAa, 1e-4);')).toBe(true);
    // The chromatic tap coordinates inside the 3-tap branch.
    expect(pos(reg, 'vec3 sR = sampleBackdrop(uvR,') - pos(reg, 'vec2 uvR =')).toBe(4);
    // The order in which `result` is written is untouched: that sequence IS the picture.
    const writes = (lines: readonly Line[]) => text(lines).filter((t) => /^result(\.[a-z]+)?\s*(\*|\+)?=/.test(t));
    expect(writes(reg)).toEqual(writes(GLASS));
  });
});

describe('GLASS_REG_REMAT and GLASS_NO_SKIP_GATES', () => {
  it('REMAT adds exactly three recomputes, each a copy of its own defining statement', () => {
    const remat = glassProgram('REMAT');
    const reg = glassProgram('REG');
    expect(multisetMinus(reg, remat)).toEqual([]);
    // As a multiset: a common line (`}`) is attributed to whichever copy the difference meets last.
    const added = multisetMinus(remat, reg).sort();
    expect(added).toEqual([
      'edgeDist = max(-dist, 0.0);',
      'if (v_Is3D > 0.5) {',
      'pLocal = panelCenter + v_Local;',
      '} else {',
      'vec2 _rel = v_PixelPos - v_Rot.zw;',
      'pLocal = vec2(',
      '_rel.x * v_Rot.x + _rel.y * v_Rot.y,',
      '-_rel.x * v_Rot.y + _rel.y * v_Rot.x',
      ') + v_Rot.zw;',
      '}',
      'glassiness = smoothstep(0.0, 1.0, thickness);',
    ].sort());
    const regText = text(reg);
    expect(regText).toContain('float edgeDist = max(-dist, 0.0);');
    expect(regText).toContain('float glassiness = smoothstep(0.0, 1.0, thickness);');
    for (const l of added.filter((t) => !t.startsWith('edgeDist =') && !t.startsWith('glassiness ='))) {
      expect(regText, l).toContain(l);
    }
  });

  it('NOGATES differs from the glass program in GlassSkips\' body alone', () => {
    const ng = glassProgram('NOGATES');
    expect(text(linesNotIn(ng, GLASS))).toEqual(['bool GlassSkips(int bit) { return false; }']);
    expect(text(linesNotIn(GLASS, ng))).toEqual(['bool GlassSkips(int bit) { return (u_GlassSkip & bit) != 0; }']);
  });

  it('the renderer cuts each armed value with exactly these defines, on every kind', () => {
    expect(GLASS_REG_DEFINES).toEqual({
      scope: { GLASS_REG: true },
      all: { GLASS_REG: true, GLASS_REG_REMAT: true },
      nogates: { GLASS_NO_SKIP_GATES: true },
    });
    const R = stripTsComments(readRenderer());
    expect(R).toContain('{ MATERIAL_GLASS: true, ...GLASS_VARIANT_DEFINES[kind], ...GLASS_REG_DEFINES[arm] });');
    expect(R).toContain('{ MATERIAL_GLASS: true, GLASS_BORDER_ONLY: true });');
    expect(R).toContain('{ MATERIAL_GLASS: true, GLASS_NO_GLOW: true, GLASS_NO_SPEC: true });');
  });
});

// ── THE REGISTER MAP ────────────────────────────────────────────────────────────────────────────
//
// Scalar components HELD ACROSS each heavy statement: declared before it, read after it, in program
// order, with the non-glass arms `materialType` folds away removed. Not counted: flat-varying reads
// and constants (`Glass.Reg.Source.FREE_ALIASES`), and each stage's own temporaries (the same in
// every program, since no stage's inside is edited). `-` = the program does not contain the
// statement. The FILL draw runs NO_LIGHT on glass-grid, the RIM draw BORDER_ONLY; today both ran GLASS.
//
//                     sdf  shadow  lod  taps  fill  glow  spec  zone   peak
// Re-pinned 2026-09-22 for aave's lens (Jwift/Shared/Research/Aave.Glass.md): the rim-specular tap and
// the Blinn-Phong catchlight are gone, the highlight is one adaptive composite, and the taps read the lens
// field's offset. No stage holds more than before; the glow tap drops 34 -> 31 and the highlight 23 -> 18.
const MAP: Record<string, Array<number | null>> = {
  GLASS:             [13,   28,   26,   25,   26,   31,   18,    8],
  NO_LIGHT:          [13,   23,   26,   25,   21, null, null,    8],
  BORDER_ONLY:       [10, null,   13, null, null, null, null,    8],
  REG:               [11,   11,   23,   22,   14,   28,   18,    8],
  REG_NO_LIGHT:      [11,   11,   21,   20,   11, null, null,    8],
  REG_BORDER_ONLY:   [ 8, null,   10, null, null, null, null,    8],
  REMAT:             [ 9,    9,   20,   19,   13,   27,   18,    8],
  REMAT_NO_LIGHT:    [ 9,    9,   18,   17,   11, null, null,    8],
  REMAT_BORDER_ONLY: [ 8, null,   10, null, null, null, null,    8],
  NOGATES:           [13,   28,   26,   25,   26,   31,   18,    8],
};
const PEAK: Record<string, number> = {
  GLASS: 31, NO_LIGHT: 26, BORDER_ONLY: 13, REG: 28, REG_NO_LIGHT: 21, REG_BORDER_ONLY: 10,
  REMAT: 27, REMAT_NO_LIGHT: 18, REMAT_BORDER_ONLY: 10, NOGATES: 31,
};

describe('the register map, computed from the source', () => {
  const anchors = Object.keys(ANCHORS) as Anchor[];

  it('every anchor statement exists in the glass program, exactly once', () => {
    for (const a of anchors) {
      expect(GLASS.filter((l) => l.Text.includes(ANCHORS[a])).length, a).toBe(1);
    }
  });

  for (const [name, row] of Object.entries(MAP)) {
    it(`${name}: held components at each heavy statement, and the peak`, () => {
      const map = registerMap(name as GlassProgramName);
      expect(anchors.map((a) => map[a]?.Components ?? null)).toEqual(row);
      expect(Math.max(...anchors.map((a) => map[a]?.Components ?? 0))).toBe(PEAK[name]);
    });
  }

  it('the named findings the table rests on', () => {
    const g = registerMap('GLASS');
    const r = registerMap('REG_NO_LIGHT');
    // Today the rim glow's tap holds the whole body: the backdrop, the border chain, the edge light it
    // is about to write, and `p` / `pLocal` / `mode` for stages that come after it. It no longer holds
    // the fill's texture coordinate: `baseUv`'s last reader was the rim-specular tap, which went with
    // the catchlight when the highlight became aave's.
    expect(g.glow!.Names).toEqual(expect.arrayContaining(['backdrop', 'widthScale', 'edgeLightRgb', 'pLocal', 'mode']));
    expect(g.glow!.Names).not.toContain('baseUv');
    // Today the shadow's corner field (a second 6 pow) runs holding 28; under REG it holds 11.
    expect(g.shadow!.Components).toBe(28);
    expect(r.shadow!.Names).toEqual(['borderFade', 'clipAlpha', 'dist', 'innerBlur', 'normal', 'p', 'pLocal', 'shadowAlpha']);
    // Under REG the backdrop dies at the fill composite and never meets the border chain.
    expect(r.fill!.Names).not.toContain('widthScale');
    expect(r.zone!.Names).toEqual(['alignment', 'borderBase', 'clipAlpha', 'fillAlpha', 'result']);
    // Under REMAT `pLocal` is dead by the shadow: its recompute is a new value.
    expect(registerMap('REMAT_NO_LIGHT').shadow!.Names).not.toContain('pLocal');
  });
});

// ── THE WIRING ──────────────────────────────────────────────────────────────────────────────────

describe('the renderer and Jaui: what is compiled when, and what is printed', () => {
  const R = stripTsComments(readRenderer());
  const J = readJaui().replace(/\r\n/g, '\n');
  const INIT = ((): string => {
    const at = R.indexOf('Init = async (');
    const open = R.indexOf('{', R.indexOf('=>', at));
    let depth = 0;
    for (let i = open; i < R.length; i++) {
      if (R[i] === '{') depth++;
      else if (R[i] === '}' && --depth === 0) return R.slice(open + 1, i);
    }
    throw new Error('could not find Init');
  })();

  it('the two variants are in the boot batch on both arms: the compile never reads the flag', () => {
    const compile = arrowBody(R, '_compilePanelShader');
    expect(compile).toContain('this._panelShaderGlassBorderOnly = batch.Add(panelVertSrc, panelFragSrc,');
    expect(compile).toContain('this._panelShaderGlassNoLight = batch.Add(panelVertSrc, panelFragSrc,');
    expect(compile).not.toContain('DiagGlassPrograms');
    expect(compile).not.toContain('GLASS_REG');
    expect(PANEL_PROGRAM_COUNT).toBe(7);
    expect(GLASS_VARIANT_PROGRAMS).toBe(2);
    const wire = arrowBody(R, '_wirePanelShader');
    expect(wire).toContain('this._panelLocsGlassBorderOnly = _extractPanelLocs(gl, this._panelShaderGlassBorderOnly.Program);');
    expect(wire).toContain('this._panelLocsGlassNoLight = _extractPanelLocs(gl, this._panelShaderGlassNoLight.Program);');
  });

  it('?glass-reg compiles on the ARM, off the surviving value, and a restore drops it', () => {
    expect(GLASS_REG_PROGRAMS).toBe(3);
    const arm = arrowBody(R, 'ArmFlaggedPrograms');
    expect(arm).toContain("const reg = this.DiagGlassReg !== 'off' ? this.EnsureGlassRegPrograms() : 0;");
    expect(INIT).toContain("if (this.DiagGlassReg !== 'off') this.EnsureGlassRegPrograms(batch);");
    expect(INIT.indexOf('this._glassRegShaders = null;')).toBeLessThan(INIT.indexOf('const batch = new ShaderBatch(gl);'));
    const ensure = arrowBody(R, 'EnsureGlassRegPrograms');
    expect(ensure).toContain("if (arm === 'off') return 0;");
    expect(ensure).toContain('if (this._glassRegShaders !== null && this._glassRegCut === arm) return 0;');
    expect(ensure).toContain('for (const kind of GLASS_PROGRAM_KINDS) {');
    expect(ensure).toContain('return GLASS_REG_PROGRAMS;');
    expect(R).toContain("DiagGlassReg: GlassRegArm = 'off';");
    expect(R).toContain("DiagGlassPrograms: GlassProgramsArm = 'on';");
  });

  it('the pick: border-direct first, then ?glass-reg, then the two variants, then the full glass program', () => {
    expect(R).toContain('const glassKind = isGlass && !hasBorderScratch ? this._glassBatchKind() : null;');
    const at = R.indexOf('const program = direct !== null ? direct.Shader');
    const ladder = R.slice(at, R.indexOf(';', at));
    const order = [': reg !== null ? reg.Shader', ": glassKind === 'borderOnly' ? this._panelShaderGlassBorderOnly",
      ": glassKind === 'noLight' ? this._panelShaderGlassNoLight", ': isGlass ? this._panelShaderGlass'];
    const idx = order.map((o) => ladder.indexOf(o));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('the marks: both flags print on every page from the line that decides, with programs= and pixels=SAME', () => {
    expect(J).toContain('JTrace(`jaui:glass-programs armed=${this._glassPrograms} programs=${webgl2 ? PANEL_PROGRAM_COUNT : 0}`');
    expect(J).toContain('JTrace(`jaui:glass-reg armed=${this._glassReg} programs=${this._glassReg === \'off\' ? 0 : GLASS_REG_PROGRAMS}`');
    expect(J).toContain('+ ` borderOnlyBatches=${c.BorderOnly} noGlow=${c.NoGlow} noSpec=${c.NoSpec} fallbacks=${c.Fallbacks}`');
    // Parsed ahead of ?glass-skip, whose refusals read them.
    expect(J.indexOf("ParseGlassPrograms(params.has('glass-programs')")).toBeLessThan(J.indexOf("ParseGlassSkip(params.get('glass-skip')"));
    expect(J).toContain(': this._glassSkipPreempted();');
  });
});
