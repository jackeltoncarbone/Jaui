import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EstimateBorderFragments, BORDER_DRAWN_MIN_DEVICE_PX,
} from '../src/Core/Border.Direct';
import { SceneReadLedger } from '../src/Core/Scene.Ledger';
import { arrowBody } from './Scene.ReadAfterWrite.Source';
import { PROGRAMS, preprocess, codeLines, readPanelFrag } from './Flat.Program.Source';

/**
 * Lane borderdirect3: WHERE THE GATHER RUNS, and the three arms that price the M4's +2.59 ms.
 *
 * The cell that sent this lane out read: `?border-direct` ON 26.79 ms per render at dpr 2 against
 * 24.19 off, one binary, unpaced, n=3, no overlap -- with eighty render passes AND eighty draws
 * removed from the frame. The hypothesis it carried was GEOMETRIC: that `sampleBackdropDirect`
 * runs on every fragment of the rim instance's quad (the whole card, ~3.5 Mpx over twenty at dpr
 * 2) rather than on the border band (~100 Kpx), because the call had been hoisted out of the
 * `borderBase > 0.001` branch or because the branch diverges.
 *
 * THE FIRST DESCRIBE BLOCK BELOW IS THAT HYPOTHESIS, AND IT REFUTES IT, off the shader source:
 * the gather is inside the branch, `borderBase` is computed before it, and nothing outside the
 * branch reads its result. What the file cannot refute is the SECOND whole-quad mechanism, which
 * is not taps at all: a program's register and stack footprint is allocated for every fragment it
 * shades whatever the branch then does, and this program's gather carries two dynamically-indexed
 * arrays. That is what `?border-direct=skipgather` measures, and this file pins its wiring.
 */

const FRAG = readPanelFrag();
const RENDERER = readFileSync(join(__dirname, '../src/Core/WebGL2.Renderer.ts'), 'utf8')
  .replace(/\r\n/g, '\n');
const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');
const INSTANCE = readFileSync(join(__dirname, '../src/Jiv/Jiv.InstanceBuffer.ts'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The BORDER_DIRECT program's own text, comments and blanks gone, in source order. */
const DIRECT = codeLines(preprocess(FRAG, ['MATERIAL_GLASS', 'BORDER_DIRECT']));

/** The index in `DIRECT` of the line that opens the border zone's branch, and of its closing
 *  brace -- walked by DEPTH over comment-free text, which is the only way to say "inside" about a
 *  block whose comments are full of prose braces. */
const borderZone = (): { Open: number; Close: number } => {
  const open = DIRECT.findIndex((l) => l.Text === 'if (borderBase > 0.001) {');
  expect(open, 'the border zone branch').toBeGreaterThan(0);
  let depth = 0;
  for (let i = open; i < DIRECT.length; i++) {
    for (const ch of DIRECT[i].Text) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return { Open: open, Close: i };
      }
    }
  }
  throw new Error('[Border.Arms] the border zone branch never closes');
};

describe('borderdirect3 > step 1: does the gather run on the quad or on the band?', () => {
  it('the gather is INSIDE `borderBase > 0.001`, and `borderBase` is computed before it', () => {
    const { Open, Close } = borderZone();
    const base = DIRECT.findIndex((l) =>
      l.Text === 'float borderBase = (1.0 - borderOuter) * borderInner * borderCoverage;');
    const gather = DIRECT.findIndex((l) => l.Text.includes('sampleBackdropDirect(bUv'));
    // The whole of the brief's first hypothesis, in three inequalities: the mask is computable
    // before the gather (it is a function of `dist` and the two widths and nothing else), the
    // branch opens on it, and the gather is inside the branch.
    expect(base).toBeGreaterThan(0);
    expect(Open).toBeGreaterThan(base);
    expect(gather).toBeGreaterThan(Open);
    expect(gather).toBeLessThan(Close);
    // And the three inputs the mask is built from all precede the branch, so no reordering is
    // needed to make the early-out possible -- it already IS the shape of the code.
    for (const text of [
      'float borderOuter = smoothstep(-aa, aa, dist);',
      'float fadeIn = max(borderFade * widthScale, aa);',
      'float borderInner = smoothstep(-drawnBorderWidth - fadeIn, -drawnBorderWidth + aa, dist);',
    ]) {
      const at = DIRECT.findIndex((l) => l.Text === text);
      expect(at, text).toBeGreaterThan(0);
      expect(at).toBeLessThan(Open);
    }
  });

  it('nothing outside that branch reads `bSample` -- there is no second consumer to hoist for', () => {
    const { Open, Close } = borderZone();
    const users = DIRECT
      .map((l, i) => ({ i, Text: l.Text }))
      .filter((l) => l.Text.includes('bSample'));
    // Four lines: the declaration, the two arms of the gate, and the one read (`applyGrading`).
    expect(users.length).toBe(4);
    for (const u of users) {
      expect(u.i, u.Text).toBeGreaterThan(Open);
      expect(u.i, u.Text).toBeLessThan(Close);
    }
    // The Fresnel's gather, `rimCarry` and the stroke tint all consume `borderBackdrop`, which is
    // derived from `bSample` INSIDE the branch -- so they cannot pull the tap out of it either.
    const carry = DIRECT.findIndex((l) => l.Text.startsWith('float rimCarry = smoothstep'));
    expect(carry).toBeGreaterThan(Open);
    expect(carry).toBeLessThan(Close);
  });

  it('the gather carries two DYNAMICALLY INDEXED windows, which is what the probes price', () => {
    // This is the mechanism the lane's report names in place of the refuted one. `_bdL2` and
    // `_bdL1` are indexed by a value computed per tap (`k = ivec2(f0 - _bdQ0)`), so they cannot be
    // promoted to registers: they are allocated on the thread's stack for the whole PROGRAM, and
    // the program shades the whole quad whether or not its branch is taken.
    expect(FRAG).toContain('vec3 _bdL2[16];');
    expect(FRAG).toContain('vec3 _bdL1[9];');
    expect(FRAG).toContain('ivec2 k = ivec2(f0 - _bdQ0);');
    expect(FRAG).toContain('ivec2 k = ivec2(f0 - _bdM0);');
    expect(FRAG).toContain('return mix(a, b, fr.y);');
  });
});

describe('borderdirect3 > the arm gate, read off the source', () => {
  it('the gate is a UNIFORM, so both arms compile the same program', () => {
    expect(FRAG).toContain('uniform float u_BorderGather;');
    expect(FRAG).toContain('if (u_BorderGather > 0.5) bSample = sampleBackdropDirect(bUv, bLod, frostLod);');
    expect(FRAG).toContain('else bSample = sampleBackdrop(bUv, bLod, frostLod);');
    // A `#define` would let the compiler delete the gather AND its stack, which is the one thing
    // this arm must not do: `skipgather` minus `on` is only "what the band work costs" if the
    // program's shape is identical on both sides.
    expect(FRAG).not.toContain('#if defined(BORDER_DIRECT_SKIPGATHER)');
  });

  it('nothing the arm needs leaks into the other five programs', () => {
    for (const set of Object.values(PROGRAMS)) {
      const code = codeLines(preprocess(FRAG, set)).map((l) => l.Text).join('\n');
      expect(code, set.join('+')).not.toContain('u_BorderGather');
    }
  });

  it('the renderer sets it on every draw, and `nogather` swaps the PROGRAM and nothing else', () => {
    expect(RENDERER).toContain(
      "gl.uniform1f(locs.borderGather, this.DiagBorderArm === 'skipgather' ? 0 : 1);");
    expect(RENDERER).toContain("borderGather:   gl.getUniformLocation(p, 'u_BorderGather'),");
    // `nogather` is a ROUTING change: the copy still happens (`ComputeBorderDirect` is still
    // called, because `_borderDirect` is still true), the pyramids are still not built, the draw
    // count does not move -- only the bound program does.
    expect(RENDERER).toContain(
      "const isBorderDirect = hasBorderScratch && this.DiagBorderArm !== 'nogather';");
    // And the five-way pick below it is the same text it was: the arm is decided ABOVE the
    // ladder, so `?two-stop-gradient`'s and `?borderless-program`'s own routing tests still read
    // the line they pinned.
    // Since lane bootcompile2 the pick goes through the null-safe local the deferral demands: the arm
    // still decides ONE line ('direct' is derived from isBorderDirect) and the ladder reads that local.
    expect(RENDERER).toContain('const direct = isBorderDirect ? this._panelBorderDirectOrThrow() : null;');
    expect(RENDERER).toContain('const program = direct !== null ? direct.Shader');
    expect(RENDERER).toContain('const locs = direct !== null ? direct.Locs');
    // The batch gate still guards the handle on EVERY arm: a rim that is not border-only would
    // shade its interior out of a raw scene copy under the glass program exactly as it would
    // under the direct one.
    expect(RENDERER).toContain('const hasBorderScratch = isGlass && backdrop !== null');
    expect(RENDERER).toContain('if (hasBorderScratch && !this._batchTakesBorderDirectProgram()) {');
  });

  it('the flag takes four values and throws on a fifth, and the mark names the arm', () => {
    expect(JAUI).toContain(
      "[Jaui] ?border-direct takes 'on', 'off', 'skipgather' or 'nogather', got '${raw}'");
    expect(JAUI).toContain(
      "this._borderArm = raw === 'skipgather' ? 'skipgather' : raw === 'nogather' ? 'nogather' : 'on';");
    // The probes ARM the path. An arm that left `_borderDirect` false would skip the blit and be
    // `off` wearing another name -- the vacuous shape this ledger keeps being bitten by.
    expect(JAUI).toContain("this._borderDirect = raw !== 'off';");
    expect(JAUI).toContain('r.DiagBorderArm = this._borderArm;');
    expect(JAUI).toContain("+ ` arm=${this._borderDirect ? this._borderArm : 'off'}`");
    // The rim is still ONE QUAD. `geometry=` is on the mark so a later lane that narrows the
    // rasterised geometry to the band can be told from this one by reading a run.
    expect(JAUI).toContain("+ ' geometry=quad'");
    // And the two probes do not draw the shipping picture, which the mark says rather than leaves
    // to a reader who knows the lane.
    expect(JAUI).toContain("' pixels=DIFFERENT-PROBE-ARM'");
  });

  it('the gate line carries the two fragment counts, so the ratio is readable from a run', () => {
    expect(JAUI).toContain('bandPx=${Math.round(gl2.BorderFragments)}');
    expect(JAUI).toContain('quadPx=${Math.round(gl2.BorderQuadFragments)}');
  });
});

describe('borderdirect3 > the fragment census', () => {
  // `glass-grid`'s card at dpr 2, on the geometry `Border.Direct.test.ts` pins: 216x150 pt.
  const W = 432;
  const H = 300;
  // The quad is the card plus its margin -- `max(ShadowBlur + |ShadowOffset|, BorderWidth +
  // BorderBlur)` per axis, and on a glass card the shadow is what wins it.
  const MARGIN = 34;
  const RADIUS = 44;
  /** `JwiftGlass`: BorderWidth 0.45pt, BorderFade 0.7pt, BorderBlur 0.3pt, at dpr 2. */
  const BORDER_W = 0.9;
  const FADE = 1.4;
  const AA = 0.6;

  it('the band is a fraction of a percent of the quad -- the ratio the whole cell turns on', () => {
    const e = EstimateBorderFragments(
      W + MARGIN * 2, H + MARGIN * 2, W / 2, H / 2, RADIUS,
      BORDER_W, -AA, FADE);
    expect(e.Quad).toBe(500 * 368);
    // Band width: drawn (floored at 1) + fadeIn + aa = 1 + 1.4 + 0.6 = 3.0 device px.
    // Perimeter: 2*(432 - 88) + 2*(300 - 88) + 2*pi*44 = 688 + 424 + 276.46 = 1388.46.
    expect(e.Band).toBeCloseTo(1388.46 * 3, 1);
    // Twenty cards: ~83 Kpx of band against ~3.7 Mpx of quad. The gather runs on 2.3% of the
    // fragments the program is invoked on, which is the whole of step 1 in one number, and it is
    // the bracket `BorderDirect.Finding.md` derived independently (60-120 Kpx) before the cell.
    expect(e.Band / e.Quad).toBeLessThan(0.03);
    expect(e.Band * 20).toBeGreaterThan(60_000);
    expect(e.Band * 20).toBeLessThan(120_000);
  });

  it('the hairline floor is IN the band, and a negated feather reads as its magnitude', () => {
    // A rim instance carries a NEGATIVE `borderEdgeAa` (the shader's border-only flag), so an
    // estimate that took the sign would compute a band narrower than the one that paints.
    const neg = EstimateBorderFragments(100, 100, 50, 50, 0, 0.4, -0.6, 1.4);
    const pos = EstimateBorderFragments(100, 100, 50, 50, 0, 0.4, 0.6, 1.4);
    expect(neg.Band).toBe(pos.Band);
    // BorderWidth 0.4 is drawn at the 1 px floor with the rest carried as coverage, so the BAND
    // is a pixel wide whatever the author asked for.
    expect(BORDER_DRAWN_MIN_DEVICE_PX).toBe(1);
    expect(neg.Band).toBeCloseTo(400 * (1 + 1.4 + 0.6), 6);
  });

  it('a radius cannot exceed the half-extent, and a square rect is its own perimeter', () => {
    const square = EstimateBorderFragments(200, 200, 100, 100, 0, 2, 0, 0);
    expect(square.Band).toBeCloseTo(800 * (2 + 1e-4 + 1e-4), 3);
    // Radius clamped to min(w, h) / 2: the shape is a circle and the perimeter is its circumference.
    const circle = EstimateBorderFragments(200, 200, 100, 100, 999, 2, 0, 0);
    expect(circle.Band / (2 + 2e-4)).toBeCloseTo(2 * Math.PI * 100, 3);
  });

  it('the ledger accumulates per rim and resets per frame', () => {
    const l = new SceneReadLedger();
    l.BeginFrame();
    for (let i = 0; i < 20; i++) l.NoteBorderFragments(4_165, 184_000);
    expect(l.BorderFragments).toBe(83_300);
    expect(l.BorderQuadFragments).toBe(3_680_000);
    l.BeginFrame();
    expect(l.BorderFragments).toBe(0);
    expect(l.BorderQuadFragments).toBe(0);
  });

  it('the census reads the instance the GPU is handed, over the whole batch', () => {
    const body = arrowBody(RENDERER, '_noteBorderFragments');
    expect(body).toContain('for (let i = 0; i < this._panelInstanceCount; i++)');
    expect(body).toContain('const b = i * PANEL_FLOATS_PER_INSTANCE;');
    expect(body).toContain('this._sceneLedger.NoteBorderFragments(e.Band, e.Quad);');
    expect(RENDERER).toContain('if (hasBorderScratch) this._noteBorderFragments();');
    // And the five offsets it reads still carry what they are named after, in the file that
    // writes them -- the same guard the borderless program's four offsets are held by.
    expect(RENDERER).toContain('const PANEL_OFF_QUAD_W = 2;');
    expect(RENDERER).toContain('const PANEL_OFF_QUAD_H = 3;');
    expect(RENDERER).toContain('const PANEL_OFF_RADII = 8;');
    expect(RENDERER).toContain('const PANEL_OFF_SPECULAR_PACKED = 47;');
    expect(INSTANCE).toContain('data[offset + 2] = rotHalfX * 2;');
    expect(INSTANCE).toContain('data[offset + 3] = rotHalfY * 2;');
    expect(INSTANCE).toContain('loc  3: a_Radii        (tl, tr, br, bl)');
    // `a_Specular` is loc 12, so its `.w` is float 47, and the high half is the fade in quarter px.
    expect(INSTANCE).toContain(
      'loc 12: a_Specular     (specularIntensity, specularSharpness, chromaticAberration, innerBlur + borderFade packed)');
    expect(INSTANCE).toContain('Math.round(Math.min(63.75, Math.max(0, fadePx)) * 4) * 1024');
    expect(RENDERER).toContain('Math.floor(d[b + PANEL_OFF_SPECULAR_PACKED] / 1024) / 4;');
  });
});
