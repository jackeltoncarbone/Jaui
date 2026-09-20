import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RestartSpread, SrcOverChannel, QuantiseToBits, PROBE_SRC_ALPHA } from '../src/Core/Restart.Diag';

/**
 * `?scene-restarts=N` and `?small-restarts=N` — the pair that prices H5.
 *
 * H5 (ShowStudio.Documentation/Perf/README.md, "THE JOIN"): the frame's cost is the sum over
 * ENCODERS of a fixed bubble plus the target's tile load/store. Every ordering experiment is dead,
 * so it can only be priced by a pair that moves encoder COUNT and nothing else. Two things have to
 * be true for either reading to mean anything, and both are pinned here:
 *
 *   1. They are PIXEL-IDENTICAL. Every probe draw writes alpha 0 through
 *      `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` under `FUNC_ADD`, which is `dst' = dst` on every
 *      channel of every format. Proved on the ARITHMETIC over the whole RGB10_A2 code space, not
 *      asserted back to itself — and proved to be non-vacuous by showing the same arithmetic DOES
 *      move the destination at any other alpha.
 *   2. The frame emits exactly N of them, spread over the frame's insertion points, for any N and
 *      any point count — including N above the point count, the first frame (when the point count
 *      is not yet known) and a frame whose point count fell.
 *
 * The rest is a source scan, because the construction lives in `WebGL2.Renderer.ts`, whose shader
 * imports only resolve after a build and which therefore cannot be instantiated here. What the scan
 * pins is exactly the set of things that would silently VOID a reading: a `gl.clear` instead of a
 * draw, a missing scissor drop, an insertion point on the wrong side of a build, and the
 * draws-per-tick arithmetic the M4 gates on.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (...p: string[]): string => readFileSync(join(HERE, '..', 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

const RENDERER = src('Core', 'WebGL2.Renderer.ts');
const JAUI = src('Core', 'Jaui.ts');

/** The body of one named arrow member of `WebGL2Renderer`, from its declaration to the next
 *  two-space-indented member. Used so a claim about `_restartProbe` cannot be satisfied by a line
 *  somewhere else in a 3000-line file. */
const member = (file: string, name: string): string => {
  const start = Math.max(file.indexOf(`\n  ${name} = `), file.indexOf(`\n  private ${name} = `));
  expect(start, `member ${name} not found`).toBeGreaterThan(-1);
  const end = file.indexOf('\n  };', start);
  expect(end, `member ${name} has no close`).toBeGreaterThan(start);
  return file.slice(start, end);
};

// ── 1. The pixel claim: the probe draw cannot move a destination channel ──

describe('the probe draw is transparent', () => {
  // RGB10_A2: 10 bits of R, G and B, 2 of A. The scene FBO's format (`highPrecision: true`), and
  // the probe target's, so the two arms differ in target BYTES and in nothing else.
  const RGB_MAX = 1023;
  const A_MAX = 3;

  it('leaves every 10-bit destination code exactly where it found it, for every source colour', () => {
    // Every source value the shader could conceivably write, against every destination code.
    for (const src01 of [0, 0.25, 0.5, 1 / 3, 0.75, 1]) {
      for (let code = 0; code <= RGB_MAX; code++) {
        const dst = code / RGB_MAX;
        const out = QuantiseToBits(SrcOverChannel(src01, dst, PROBE_SRC_ALPHA), 10);
        expect(out).toBe(code);
      }
    }
  });

  it('leaves every 2-bit alpha code where it found it — the non-separate blend func applies the same two factors to A', () => {
    for (let code = 0; code <= A_MAX; code++) {
      const dst = code / A_MAX;
      expect(QuantiseToBits(SrcOverChannel(PROBE_SRC_ALPHA, dst, PROBE_SRC_ALPHA), 2)).toBe(code);
    }
  });

  it('is not vacuous: the SAME arithmetic moves the destination at any other alpha', () => {
    // If this passed too, the first two would be proving that a no-op is a no-op.
    const moved: number[] = [];
    for (const alpha of [1 / RGB_MAX, 0.001, 0.5, 1]) {
      let n = 0;
      for (let code = 0; code <= RGB_MAX; code++) {
        const dst = code / RGB_MAX;
        if (QuantiseToBits(SrcOverChannel(1, dst, alpha), 10) !== code) n++;
      }
      moved.push(n);
    }
    // A single LSB of source alpha already moves most of the range; full alpha moves all but white.
    expect(moved.every((n) => n > 0)).toBe(true);
    expect(moved[moved.length - 1]).toBe(RGB_MAX);
  });

  it('the shader writes exactly that alpha, and the constant is shared with this test', () => {
    expect(PROBE_SRC_ALPHA).toBe(0);
    const frag = RENDERER.slice(RENDERER.indexOf('const RESTART_PROBE_FRAG'), RENDERER.indexOf('const RESTART_PROBE_KEY'));
    expect(frag).toContain('fragColor = vec4(0.0, 0.0, 0.0, ${PROBE_SRC_ALPHA.toFixed(1)});');
    // No sampler, no uniform, no varying: the output is a compile-time constant, so there is no
    // input that could make it anything else.
    expect(frag).not.toContain('uniform');
    expect(frag).not.toContain('sampler');
  });

  it('the probe sets BOTH halves of the blend it depends on, and never clears', () => {
    const probe = member(RENDERER, '_restartProbe');
    expect(probe).toContain('gl.blendEquation(gl.FUNC_ADD)');
    expect(probe).toContain('gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)');
    expect(probe).toContain('gl.enable(gl.BLEND)');
    // `gl.clear` is a LOAD-CLEAR, which is precisely what a tile-based driver optimises away — the
    // flags would then measure nothing under their own name.
    expect(probe).not.toContain('gl.clear');
  });

  it('the probe drops the walk\'s scissor and puts it back, so no probe draw can be culled', () => {
    const probe = member(RENDERER, '_restartProbe');
    expect(probe).toContain('const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);');
    expect(probe).toContain('if (scissorOn) gl.disable(gl.SCISSOR_TEST);');
    expect(probe).toContain('if (scissorOn) gl.enable(gl.SCISSOR_TEST);');
    // A culled draw opens no encoder, so a scissor the walk happened to set elsewhere would publish
    // the baseline under the flag's name. The 1x1 VIEWPORT is what keeps the draw to one pixel.
    expect(probe.match(/gl\.viewport\(0, 0, 1, 1\)/g)?.length).toBe(3);
  });
});

// ── 2. The count claim: exactly N a frame, spread ──

/** Run `points` insertion points and a frame end; return what each point emitted. */
const runFrame = (s: RestartSpread, n: number, points: number): number[] => {
  s.BeginFrame();
  const emitted: number[] = [];
  for (let i = 0; i < points; i++) emitted.push(s.At(n));
  emitted.push(s.FrameEnd(n));
  return emitted;
};

describe('RestartSpread emits exactly N a frame', () => {
  it('pays the whole balance at the frame end on the first frame, when the point count is unknown', () => {
    const s = new RestartSpread();
    const f1 = runFrame(s, 40, 40);
    expect(f1.slice(0, 40)).toEqual(new Array(40).fill(0));
    expect(f1[40]).toBe(40);
    expect(s.Emitted).toBe(40);
  });

  it('is one per point from frame two onwards on a steady scene, with nothing left at the end', () => {
    const s = new RestartSpread();
    runFrame(s, 40, 40);
    for (let frame = 0; frame < 5; frame++) {
      const f = runFrame(s, 40, 40);
      expect(f.slice(0, 40)).toEqual(new Array(40).fill(1));
      expect(f[40]).toBe(0);
    }
  });

  it('N above the point count is two per point, not a refusal — that is the second point on the line', () => {
    const s = new RestartSpread();
    runFrame(s, 80, 40);
    const f = runFrame(s, 80, 40);
    expect(f.slice(0, 40)).toEqual(new Array(40).fill(2));
    expect(f[40]).toBe(0);
  });

  it('N below the point count spreads EVENLY rather than bunching at the front', () => {
    const s = new RestartSpread();
    runFrame(s, 5, 40);
    const f = runFrame(s, 5, 40).slice(0, 40);
    const at = f.flatMap((k, i) => (k > 0 ? [i] : []));
    expect(at).toEqual([7, 15, 23, 31, 39]);
    expect(f.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('still emits exactly N when the point count falls, and when it rises', () => {
    const s = new RestartSpread();
    runFrame(s, 40, 40);
    runFrame(s, 40, 40);
    // A frame with fewer builds: the balance lands at the end rather than going missing.
    const fell = runFrame(s, 40, 12);
    expect(fell.reduce((a, b) => a + b, 0)).toBe(40);
    // And a frame with more: the extra points emit nothing rather than overshooting N.
    const rose = runFrame(s, 40, 60);
    expect(rose.reduce((a, b) => a + b, 0)).toBe(40);
    expect(rose.slice(0, 60).every((k) => k >= 0)).toBe(true);
  });

  it('holds for every N from 1 to 120 over a forty-build frame', () => {
    for (let n = 1; n <= 120; n++) {
      const s = new RestartSpread();
      runFrame(s, n, 40);
      const f = runFrame(s, n, 40);
      expect(f.reduce((a, b) => a + b, 0), `N=${n}`).toBe(n);
      expect(f[40], `N=${n} left a balance`).toBe(0);
    }
  });
});

// ── 3. The construction: where the points are, and what each one costs in draws ──

describe('the insertion points and the draw budget', () => {
  it('sits immediately after a pyramid build handed the scene target back — both build sites', () => {
    // The instant matters more than the place: the build has just drawn into the blur FBOs, so the
    // scene encoder has ended and nothing has been drawn into the scene since. That is what lets
    // `?small-restarts` add a trivial encoder and NO scene restart.
    const hooks = JAUI.match(/r\.RebindSceneTarget\(\);\n(?:\s*\/\/.*\n)*\s*if \(this\._restartRenderer !== null\) this\._restartRenderer\.DiagRestartPoint\(\);/g);
    expect(hooks?.length, 'expected one hook per build site (fill and rim)').toBe(2);
  });

  it('pays the frame balance before the present, while the scene is still bound', () => {
    const i = JAUI.indexOf('this._restartRenderer.DiagRestartFrameEnd();');
    const present = JAUI.indexOf('r.PresentScene();');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(present);
  });

  it('costs exactly 3 draws a point on the scene arm and 1 on the small arm', () => {
    const probe = member(RENDERER, '_restartProbe');
    const draws = probe.match(/gl\.drawElements\(gl\.TRIANGLES, 6, gl\.UNSIGNED_SHORT, 0\);/g);
    expect(draws?.length, 'three draw sites in the probe').toBe(3);
    // Two of the three are inside `if (intoScene)`: (a) starts the scene encoder so that (b) has
    // one to END, and (c) restarts it. The small arm issues only (b). So draws/tick is +3N under
    // `?scene-restarts=N`, +N under `?small-restarts=N`, +4N under both.
    expect(probe.match(/if \(intoScene\) \{/g)?.length).toBe(2);
  });

  it('alternates two 1x1 probe targets, so consecutive probes cannot fuse into one encoder', () => {
    const probe = member(RENDERER, '_restartProbe');
    expect(probe).toContain('this._restartProbeSlot = slot ^ 1;');
    const init = member(RENDERER, '_initRestartProbeTargets');
    expect(init).toContain('for (let i = 0; i < 2; i++)');
    // Same FORMAT as the scene, smallest possible SIZE: the arms differ in target bytes alone.
    expect(init).toContain('gl.RGB10_A2, 1, 1, 0');
  });

  it('books the scene arm\'s ends under their own key and refuses to run off the scene target', () => {
    expect(RENDERER).toContain("const RESTART_PROBE_KEY = 'restart-probe';");
    const probe = member(RENDERER, '_restartProbe');
    expect(probe).toContain('this._tgt(RESTART_PROBE_KEY);');
    expect(probe).toContain("if (this._boundTarget !== 'scene') { this._restartStats.Skipped++; return; }");
  });
});

// ── 4. The gate: a refused flag says so, and an unarmed binary is untouched ──

describe('the flag gate', () => {
  const parse = JAUI.slice(JAUI.indexOf("for (const flag of ['scene-restarts', 'small-restarts'] as const)"));

  it('refuses a non-integer, a zero, a negative and an empty N, naming itself on the trace', () => {
    expect(parse).toContain("raw.trim() === '' || !Number.isInteger(n) || n < 1");
    expect(parse).toContain('JTrace(`jaui:${flag} armed=false reason=${why}`)');
  });

  it('refuses the two flags that would break the construction', () => {
    // A card composite would land the probe draws in a CARD target, where `_noteSceneDraw` marks
    // the card dirty and changes which source a later backdrop read takes — a PIXEL change.
    expect(parse).toContain('r.CardCompositeEnabled ?');
    // `?blur-first` moves every build off the insertion point, so the scene may be mid-encoder
    // there and the small arm's claim would not hold.
    expect(parse).toContain('this._blurFirst ?');
    // `?no-blur` / `?blur-dummy` break the same precondition from the other side: the build issues
    // no GL, so nothing unbound the scene and its encoder is still live at the insertion point.
    expect(parse).toContain('this._diagNoBlur || r.DiagBlurDummy ?');
  });

  it('is parsed AFTER `?blur-first`, or its own refusal would read a flag that is not set yet', () => {
    expect(JAUI.indexOf('this._blurFirst = true;')).toBeLessThan(JAUI.indexOf("for (const flag of ['scene-restarts'"));
  });

  it('marks itself armed at init, with no `pixels=WRONG` — these two are identical by construction', () => {
    expect(RENDERER).toContain('JTrace(`jaui:scene-restarts armed=${this.DiagSceneRestarts}`)');
    expect(RENDERER).toContain('JTrace(`jaui:small-restarts armed=${this.DiagSmallRestarts}`)');
    const marks = RENDERER.match(/jaui:(scene|small)-restarts armed=\$\{this\.Diag\w+\}`\);/g) ?? [];
    expect(marks.every((m) => !m.includes('pixels=WRONG'))).toBe(true);
  });

  it('builds nothing at all when neither flag is armed', () => {
    const compile = member(RENDERER, '_compileRestartProbeShader');
    expect(compile).toContain('if (this.DiagSceneRestarts === null && this.DiagSmallRestarts === null) return;');
    const init = member(RENDERER, '_initRestartProbeTargets');
    expect(init).toContain('if (this._restartProbeShader === null) return;');
  });
});
