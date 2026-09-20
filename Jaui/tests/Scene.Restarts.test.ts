import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RestartSpread, SrcOverChannel, QuantiseToBits, ProbeDraws, Per,
  PROBE_SRC_ALPHA, SCENE_PROBE_DRAWS, SMALL_PROBE_DRAWS } from '../src/Core/Restart.Diag';
import { SceneReadLedger } from '../src/Core/Scene.Ledger';

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

/** Comment text can name anything; only executable lines are evidence. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

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

  it('the blur level the scene arm ends on is the SAME FORMAT as the scene and the 1x1 target', () => {
    // The detour moved onto a real build target; the pixel claim did not widen by one code.
    // `Framebuffer`'s highPrecision attachment is RGB10_A2 - what the two tests above walk
    // exhaustively - so the two arms' detour targets differ in SIZE and in nothing else.
    const fb = src('Core', 'Framebuffer.ts');
    expect(fb).toContain('gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, this._width, this._height, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);');
    expect(RENDERER).toContain("new BlurPass(this._gl, undefined, this.DiagBlurChains ?? 1");
    const blur = src('Core', 'BlurPass.ts');
    expect(blur).toContain('new Framebuffer(gl, { highPrecision: true })');
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
    // TWO of them now, not three: (a) into the scene and (b) into the detour target.
    expect(probe.match(/gl\.viewport\(0, 0, 1, 1\)/g)?.length).toBe(2);
  });
});

// ── 2. The count claim: exactly N a frame, spread, and NOTHING at the frame end ──

/** Run `points` insertion points and a frame end; return what each point emitted, with the frame's
 *  SHORTFALL last. `FrameEnd` emits nothing -- see the third entry in this section. */
const runFrame = (s: RestartSpread, n: number, points: number): number[] => {
  s.BeginFrame();
  const emitted: number[] = [];
  for (let i = 0; i < points; i++) emitted.push(s.At(n));
  emitted.push(s.FrameEnd(n));
  return emitted;
};

/** What the points emitted, without the trailing shortfall. */
const emittedOnly = (f: number[]): number[] => f.slice(0, f.length - 1);
const shortfallOf = (f: number[]): number => f[f.length - 1];

describe('RestartSpread emits exactly N a frame at the INSERTION POINTS and nowhere else', () => {
  it('emits nothing on the first frame and reports the whole N as a shortfall', () => {
    // The point count is not known until a frame has ended, so frame one cannot spread anything.
    // It used to pay the whole balance at `PresentScene` instead -- see the third test.
    const s = new RestartSpread();
    const f1 = runFrame(s, 40, 40);
    expect(emittedOnly(f1)).toEqual(new Array(40).fill(0));
    expect(shortfallOf(f1)).toBe(40);
    expect(s.Emitted).toBe(0);
  });

  it('is one per point from frame two onwards on a steady scene, owing nothing at the end', () => {
    const s = new RestartSpread();
    runFrame(s, 40, 40);
    for (let frame = 0; frame < 5; frame++) {
      const f = runFrame(s, 40, 40);
      expect(emittedOnly(f)).toEqual(new Array(40).fill(1));
      expect(shortfallOf(f)).toBe(0);
      expect(s.Emitted).toBe(40);
    }
  });

  it('FrameEnd EMITS NOTHING - the small arm\'s `restart-probe:1` transient, killed at the source', () => {
    // The M4 read one small-arm frame as `switches=41 endsByKey=blur:40,restart-probe:1`, which is
    // that arm's own void condition. The cause is not the probe: it is WHERE the balance was paid.
    // `PresentScene` is the end of the walk, where the scene has been drawn into all frame, so a
    // probe there ends a LIVE scene encoder and books a switch at an instant that is not an
    // insertion point. `FrameEnd` now returns the shortfall for the gate and draws nothing.
    const s = new RestartSpread();
    const f1 = runFrame(s, 40, 40);
    expect(shortfallOf(f1)).toBe(40);
    // And the renderer does not turn that number into probes: it books it on the gate.
    const end = member(RENDERER, 'DiagRestartFrameEnd');
    expect(end).not.toContain('_emitRestarts');
    expect(end).toContain('this._restartStats.Shortfall += this._smallRestartSpread.FrameEnd(small);');
    expect(end).toContain('this._restartStats.Shortfall += this._sceneRestartSpread.FrameEnd(scene);');
  });

  it('N above the point count is two per point, not a refusal - that is the second point on the line', () => {
    const s = new RestartSpread();
    runFrame(s, 80, 40);
    const f = runFrame(s, 80, 40);
    expect(emittedOnly(f)).toEqual(new Array(40).fill(2));
    expect(shortfallOf(f)).toBe(0);
  });

  it('N below the point count spreads EVENLY rather than bunching at the front', () => {
    const s = new RestartSpread();
    runFrame(s, 5, 40);
    const f = emittedOnly(runFrame(s, 5, 40));
    const at = f.flatMap((k, i) => (k > 0 ? [i] : []));
    expect(at).toEqual([7, 15, 23, 31, 39]);
    expect(f.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('a frame whose point count FELL reports the difference instead of paying it somewhere else', () => {
    const s = new RestartSpread();
    runFrame(s, 40, 40);
    runFrame(s, 40, 40);
    const fell = runFrame(s, 40, 12);
    // Twelve points against a denominator of forty: each owes floor((i+1)*40/40) = i+1, so twelve
    // land and twenty-eight do not. They are REPORTED, not drawn at a dirty scene.
    expect(emittedOnly(fell).reduce((a, b) => a + b, 0)).toBe(12);
    expect(shortfallOf(fell)).toBe(28);
    // A frame with MORE points still stops at N rather than overshooting.
    const rose = runFrame(s, 40, 60);
    expect(emittedOnly(rose).reduce((a, b) => a + b, 0)).toBe(40);
    expect(shortfallOf(rose)).toBe(0);
  });

  it('holds for every N from 1 to 120 over a forty-build frame', () => {
    for (let n = 1; n <= 120; n++) {
      const s = new RestartSpread();
      runFrame(s, n, 40);
      const f = runFrame(s, n, 40);
      expect(emittedOnly(f).reduce((a, b) => a + b, 0), `N=${n}`).toBe(n);
      expect(shortfallOf(f), `N=${n} left a shortfall`).toBe(0);
    }
  });
});

// ── 3. The construction: where the points are, and what each one costs in draws ──

describe('the insertion points and the draw budget', () => {
  it('the RIM build takes its point on the `RebindSceneTarget()` that handed the scene back', () => {
    // Nothing READS the scene between the rim build and the rim draw, so the scene arm's opening
    // draw has nothing free to make expensive there and the point stays where the build left it.
    const hooks = JAUI.match(/r\.RebindSceneTarget\(\);\n(?:\s*\/\/.*\n)*\s*if \(this\._restartRenderer !== null\) this\._restartRenderer\.DiagRestartPoint\(\);/g);
    expect(hooks?.length, 'exactly one hook sits on a RebindSceneTarget - the rim build').toBe(1);
  });

  it('the FILL build takes its point AFTER `MeasureShadowBackdrop`, not before it', () => {
    // THE SECOND LANE'S UNPREDICTED LEDGER SHAPE, fixed at the call site. Taken before the shadow
    // measure, the scene arm's opening draw left the scene dirty at the probe's 1x1 bind - which
    // rides the build's end for free at baseline - so every point bought a second encoder end
    // (`shadow-state:20`) and a second restart (60, not 40). Section 5 runs both placements
    // through the real ledger and reproduces the M4's cell from the wrong one.
    const measure = JAUI.indexOf('r.MeasureShadowBackdrop(node,');
    const point = JAUI.indexOf('if (fillBuilt && this._restartRenderer !== null) this._restartRenderer.DiagRestartPoint();');
    expect(measure, 'the adaptive-shadow measure').toBeGreaterThan(-1);
    expect(point, 'the fill build\'s insertion point').toBeGreaterThan(-1);
    expect(point).toBeGreaterThan(measure);
    // And it only fires where a build actually happened on this surface, not on a pre-built one.
    expect(JAUI).toContain('            fillBuilt = true;');
    expect(JAUI).toContain('        let fillBuilt = false;');
  });

  it('closes the frame without emitting - no probe runs at the present, where the scene is dirty', () => {
    const i = JAUI.indexOf('this._restartRenderer.DiagRestartFrameEnd();');
    const present = JAUI.indexOf('r.PresentScene();');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(present);
    expect(member(RENDERER, 'DiagRestartFrameEnd')).not.toContain('_emitRestarts');
  });

  it('costs exactly 2 draws a point on the scene arm and 1 on the small arm', () => {
    const probe = member(RENDERER, '_restartProbe');
    const draws = probe.match(/gl\.drawElements\(gl\.TRIANGLES, 6, gl\.UNSIGNED_SHORT, 0\);/g);
    expect(draws?.length, 'two draw sites in the probe').toBe(2);
    // ONE of the two is inside `if (intoScene)`: (a) opens the scene's encoder so that (b) can END
    // it. There is no (c) - see section 5 for what it cost. So draws per ENGINE FRAME are +2N under
    // `?scene-restarts=N`, +N under `?small-restarts=N`, +3N under both.
    expect(probe.match(/if \(intoScene\) \{/g)?.length).toBe(1);
    expect(SCENE_PROBE_DRAWS).toBe(2);
    expect(SMALL_PROBE_DRAWS).toBe(1);
    expect(ProbeDraws(40, 0)).toBe(80);
    expect(ProbeDraws(0, 40)).toBe(40);
    expect(ProbeDraws(40, 40)).toBe(120);
  });

  it('the SCENE arm ends on the blur pass\'s own level 0 - a real build\'s target, never invalidated', () => {
    const probe = member(RENDERER, '_restartProbe');
    expect(probe).toContain('const level0 = intoScene ? (this._lastBlur?.DiagLevel0 ?? null) : null;');
    expect(probe).toContain('level0.Bind();');
    // `BlurPass._bindTarget` invalidates the level because it is about to overwrite it. The probe
    // is NOT about to overwrite it - the card draw below samples that pyramid - so invalidating
    // here would be a pixel change wearing a pixel-identical flag's name.
    expect(stripComments(probe)).not.toContain('invalidateFramebuffer');
    // The accessor is a getter and nothing else: no arithmetic, no bind, no resize.
    const blur = src('Core', 'BlurPass.ts');
    const body = blur.slice(blur.indexOf('get DiagLevel0()'), blur.indexOf('get ChainCensus()'));
    expect(body).toContain('return this._levels.length > 0 ? this._levels[0] : null;');
    expect(body).not.toContain('Resize');
    expect(body).not.toContain('Bind()');
    // And it IS the target a build ends on: the upsample chain's last hop draws into `_levels[0]`.
    expect(blur).toContain('for (let i = depth - 1; i >= 0; i--) {');
    expect(blur).toContain('      const dst = this._levels[i];');
  });

  it('the SMALL arm keeps its two 1x1 targets, and only it allocates them', () => {
    const probe = member(RENDERER, '_restartProbe');
    expect(probe).toContain('this._restartProbeSlot = slot ^ 1;');
    const init = member(RENDERER, '_initRestartProbeTargets');
    expect(init).toContain('for (let i = 0; i < 2; i++)');
    // Same FORMAT as the scene, smallest possible SIZE: the bubble with as little under it as a
    // colour attachment can carry.
    expect(init).toContain('gl.RGB10_A2, 1, 1, 0');
    // A scene-arm-only run allocates none of it - its detour lands in the blur level.
    expect(member(RENDERER, '_ensureRestartProbe'))
      .toContain('if (this.DiagSmallRestarts !== null) this._initRestartProbeTargets(gl);');
  });

  it('books both arms\' detour binds under their own key and refuses to run off the scene target', () => {
    expect(RENDERER).toContain("const RESTART_PROBE_KEY = 'restart-probe';");
    const probe = member(RENDERER, '_restartProbe');
    expect(probe).toContain('this._tgt(RESTART_PROBE_KEY);');
    expect(probe).toContain("if (this._boundTarget !== 'scene') {");
    expect(probe).toContain('this._restartStats.NotScene++;');
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

  it('marks itself armed where the probe is BUILT, with no `pixels=WRONG` — identical by construction', () => {
    // Not at init any more, and that is the fix: see section 5. The mark rides the build, so it
    // cannot print unless a real program and two real targets exist on the instance that draws.
    const ensure = member(RENDERER, '_ensureRestartProbe');
    expect(ensure).toContain('JTrace(`jaui:scene-restarts armed=${this.DiagSceneRestarts}`)');
    expect(ensure).toContain('JTrace(`jaui:small-restarts armed=${this.DiagSmallRestarts}`)');
    const marks = RENDERER.match(/jaui:(scene|small)-restarts armed=\$\{this\.Diag\w+\}`\);/g) ?? [];
    expect(marks.every((m) => !m.includes('pixels=WRONG'))).toBe(true);
  });

  it('builds nothing at all when neither flag is armed', () => {
    const ensure = member(RENDERER, '_ensureRestartProbe');
    expect(ensure).toContain('if (this.DiagSceneRestarts === null && this.DiagSmallRestarts === null) return;');
    const init = member(RENDERER, '_initRestartProbeTargets');
    expect(init).toContain('if (this._restartProbeShader === null) return;');
  });
});

// ── 5. The boot order, which voided the first run ─────────────────────────────────────────────

/**
 * `probes=0 skipped=40` on all five M4 arms, with the flag armed and all forty insertion points
 * reached. The cause is an ORDER, and it is visible only across three files:
 *
 *   `Worker/Worker.Boot.ts`   `new WebGL2Renderer()` -> `await renderer.Init(...)` -> `new Canvas(...)`
 *   `Core/Jaui.ts`            the `Canvas` constructor runs `_initDebugFromUrl`, which parses the flags
 *   `Core/WebGL2.Renderer.ts` `Init` used to be where the probe was built
 *
 * So on the worker path — the path the app and the perf harness take — the build ran before the
 * flag existed, saw two nulls, built nothing, and every probe was skipped. The main-thread path
 * (`Canvas` constructed first, `Init` at `Start`) has the opposite order, which is why source
 * review and a main-thread eye both found the code perfectly correct.
 *
 * These tests take the two orders out of the real files and run a model of the arming lifecycle
 * whose ONE parameter — where the build happens — is read out of the renderer. Against the shipped
 * source both orders arm; against an `Init`-time build the worker order reports zero probes, which
 * is the M4's reading reproduced from source in a millisecond.
 */

const WORKER_BOOT = src('Worker', 'Worker.Boot.ts');

/** Where the probe's program and targets are built, read from the renderer rather than assumed. */
type BuildSite = 'init' | 'begin-frame' | 'nowhere';
const buildSite = (): BuildSite => {
  const BUILD = /ShaderCompiler\.Compile\(gl, BLIT_VERT, RESTART_PROBE_FRAG\)|batch\.Add\(BLIT_VERT, RESTART_PROBE_FRAG\)/;
  const init = stripComments(member(RENDERER, 'Init'));
  if (BUILD.test(init) || /_compileRestartProbeShader\(|_initRestartProbeTargets\(/.test(init)) return 'init';
  const ensure = stripComments(member(RENDERER, '_ensureRestartProbe'));
  const begin = stripComments(member(RENDERER, 'BeginFrame'));
  if (BUILD.test(ensure) && begin.includes('this._ensureRestartProbe();')) return 'begin-frame';
  return 'nowhere';
};

/** The arming lifecycle and nothing else: a flag, a probe that may or may not exist, and insertion
 *  points that either draw or name why they did not. The skip name is the renderer's. */
class ArmingModel {
  constructor(private readonly Site: BuildSite) {}
  DiagSceneRestarts: number | null = null;
  DiagSmallRestarts: number | null = null;
  private _probe: object | null = null;
  Probes = 0;
  SkippedNoShader = 0;
  Init = (): void => { if (this.Site === 'init') this._build(); };
  BeginFrame = (): void => { if (this.Site === 'begin-frame') this._build(); };
  Point = (): void => {
    if (this._probe === null) { this.SkippedNoShader++; return; }
    this.Probes++;
  };
  private _build = (): void => {
    if (this.DiagSceneRestarts === null && this.DiagSmallRestarts === null) return;
    this._probe = {};
  };
}

/** `Jaui._initDebugFromUrl`'s parse, to the letter: `?scene-restarts=N` sets the field. */
const armFromUrl = (r: ArmingModel, url: string): void => {
  const params = new URLSearchParams(url);
  for (const flag of ['scene-restarts', 'small-restarts'] as const) {
    const raw = params.get(flag);
    if (raw === null) continue;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(n) || n < 1) continue;
    if (flag === 'scene-restarts') r.DiagSceneRestarts = n;
    else r.DiagSmallRestarts = n;
  }
};

/** One frame of a walk with two pyramid builds: `BeginFrame`, then the two insertion points. */
const runOneFrame = (r: ArmingModel): void => { r.BeginFrame(); r.Point(); r.Point(); };

describe('the boot order the flag has to survive', () => {
  it('the WORKER boots Init BEFORE the Canvas whose constructor parses the flag', () => {
    const boot = stripComments(WORKER_BOOT);
    const init = boot.indexOf('await renderer.Init(m.Canvas);');
    const canvas = boot.indexOf('const canvas = new Canvas(');
    expect(init, 'worker Init call').toBeGreaterThan(-1);
    expect(canvas, 'worker Canvas construction').toBeGreaterThan(-1);
    expect(init).toBeLessThan(canvas);
    // And the flag is parsed inside that Canvas constructor, not before it.
    const ctor = JAUI.slice(JAUI.indexOf('constructor(canvas: HTMLCanvasElement, renderer: Renderer'));
    expect(ctor.slice(0, ctor.indexOf('\n  }')).includes('this._initDebugFromUrl();')).toBe(true);
    expect(JAUI.indexOf("for (const flag of ['scene-restarts'"))
      .toBeGreaterThan(JAUI.indexOf('private _initDebugFromUrl = ()'));
  });

  it('arms on the WORKER order — Init, then the flag, then the first frame', () => {
    const r = new ArmingModel(buildSite());
    r.Init();
    armFromUrl(r, '?scene-restarts=40');
    runOneFrame(r);
    expect(r.SkippedNoShader, 'the probe did not exist at the insertion points').toBe(0);
    expect(r.Probes).toBeGreaterThan(0);
  });

  it('arms on the MAIN-THREAD order too — the flag, then Init, then the first frame', () => {
    const r = new ArmingModel(buildSite());
    armFromUrl(r, '?small-restarts=40');
    r.Init();
    runOneFrame(r);
    expect(r.SkippedNoShader).toBe(0);
    expect(r.Probes).toBeGreaterThan(0);
  });

  it('is not vacuous: an Init-time build reproduces the M4 reading on the worker order', () => {
    // The shipped source scores 2/2 above. This is the same model with the OLD build site, and it
    // is the first run's cell: every point reached, every probe skipped, nothing drawn.
    const r = new ArmingModel('init');
    r.Init();
    armFromUrl(r, '?scene-restarts=40');
    runOneFrame(r);
    expect(r.Probes).toBe(0);
    expect(r.SkippedNoShader).toBe(2);
  });

  it('builds somewhere — "nowhere" is a failure, not a pass', () => {
    expect(buildSite()).toBe('begin-frame');
  });

  it('a context restore drops the probe so the next frame rebuilds it against the live context', () => {
    const init = stripComments(member(RENDERER, 'Init'));
    expect(init).toContain('this._restartProbeShader = null;');
    expect(init).toContain('this._restartProbeFbos[0] = null;');
    expect(init).toContain('this._restartProbeFbos[1] = null;');
  });

  it('the armed binary now issues exactly the shipped boot batch, same as the unarmed one', () => {
    // The probe is compiled one-off, outside the batch, so `jaui:shaders:issued n=` no longer
    // moves under the flag — the two arms of every pair share one boot.
    const init = stripComments(member(RENDERER, 'Init'));
    expect(init).not.toContain('RESTART_PROBE_FRAG');
    const ensure = member(RENDERER, '_ensureRestartProbe');
    expect(ensure).toContain('ShaderCompiler.Compile(gl, BLIT_VERT, RESTART_PROBE_FRAG)');
  });
});

// ── 6. Every skip has a name ──────────────────────────────────────────────────────────────────

describe('the skip counters', () => {
  it('split into five branches, each incrementing its own counter', () => {
    const probe = member(RENDERER, '_restartProbe');
    expect(probe).toContain('this._restartStats.NoShader++;');
    expect(probe).toContain('this._restartStats.NoTarget++;');
    // The fifth: the scene arm had no blur level 0 to end on, which says the INSERTION POINT is
    // wrong rather than the instrument, and is a different diagnosis from every other skip.
    expect(probe).toContain('this._restartStats.NoLevel0++;');
    expect(probe).toContain('this._restartStats.NotScene++;');
    // The fourth is upstream of the probe: a point taken on an instance neither flag reached.
    const point = member(RENDERER, 'DiagRestartPoint');
    expect(point).toContain('this._restartStats.Unarmed++;');
    // And no branch may share a counter with another — that is the whole of this lane's step 1.
    expect(RENDERER).not.toContain('this._restartStats.Skipped++');
  });

  it('are printed on the gate line whatever their value, zeros included', () => {
    const gate = member(RENDERER, '_restartGate');
    for (const name of ['skippedUnarmed', 'skippedNoShader', 'skippedNoTarget', 'skippedNoLevel0',
      'skippedNotScene', 'shortfall', 'probeDraws=', 'drawsPerRestart=']) {
      expect(gate).toContain(name);
    }
    // `drawsPerRestart` ADDS the two arms rather than picking one, so a cell that armed both
    // reports 3 and not 2. The gate's own arithmetic is the module's, not a second copy.
    expect(gate).toContain('const probeDraws = ProbeDraws(s.Scene, s.Small);');
    expect(gate).toContain('(this.DiagSceneRestarts !== null ? SCENE_PROBE_DRAWS : 0)');
    expect(gate).toContain('(this.DiagSmallRestarts !== null ? SMALL_PROBE_DRAWS : 0)');
    // The target that was bound instead is named, because "which target" IS the diagnosis.
    expect(gate).toContain('notSceneKeys=');
  });

  it('let an instance the flag never reached print a line, naming itself', () => {
    const end = member(RENDERER, 'DiagRestartFrameEnd');
    expect(end).toContain('this._restartStats.Unarmed > 0');
    expect(member(RENDERER, '_restartGate')).toContain('instance=not-the-one-the-flag-reached');
  });

  it('reset at the top of the frame they report', () => {
    const begin = member(RENDERER, 'BeginFrame');
    for (const f of ['Scene', 'Small', 'Shortfall', 'Unarmed', 'NoShader', 'NoTarget', 'NoLevel0', 'NotScene']) {
      expect(begin).toContain(`this._restartStats.${f} = 0;`);
    }
    expect(begin).toContain('this._restartNotSceneKeys = {};');
  });
});


// ── 7. THE LEDGER, DERIVED ON THE LEDGER'S OWN CODE ───────────────────────────────────────────

/**
 * What each arm's counters MUST read, worked out by running a glass-grid frame through the real
 * `SceneReadLedger` rather than predicting it.
 *
 * This is the section the third lane exists for. The M4's scene arm printed `switches=100
 * restarts=60 endsByKey=blur:40,restart-probe:40,shadow-state:20` against a spec of 80 / 40 /
 * `{blur:40, restart-probe:40}`, and nobody could say from the trace which of the probe's three
 * draws bought the extra twenty ends. The ledger is pure and importable, so the walk can be run
 * here in all three shapes - baseline, the old probe, the new one - and the shapes compared. The
 * OLD shape reproduces the M4's cell to the number, which is what makes the new shape's 80 / 40 /
 * 60 a derivation and not a hope.
 *
 * The walk per card is `Scene.ReadAfterWrite.test.ts`'s, which is itself checked against the
 * measured baseline (40 switches, 40 restarts, 60 reads): the fill build reads the scene and binds
 * `blur`; the adaptive shadow reads it again and binds its own 1x1 `shadow-state`; the glass
 * instance and the text batch draw; the rim build reads and binds `blur`; the rim instance draws.
 */

const CARDS = 20;

type ProbeShape = 'none' | 'old' | 'new' | 'small';

/** One glass-grid frame. `shape` is which probe runs at the two insertion points, and `fillAfter`
 *  is whether the FILL build's point is taken after the adaptive-shadow measure (the shipped
 *  placement) or before it (the second lane's). */
const glassGridFrame = (
  shape: ProbeShape, fillAfterShadow: boolean, opts: { Drain: boolean } = { Drain: true },
): SceneReadLedger => {
  const l = new SceneReadLedger();
  l.BeginFrame();
  // The probe, exactly as `_restartProbe` issues it.
  const probe = (): void => {
    if (shape === 'none') return;
    if (shape === 'small') { l.NoteTargetBind('restart-probe'); return; }   // (b) alone
    l.NoteWrite();                                                          // (a) into the scene
    l.NoteTargetBind('restart-probe');                                      // (b) the END
    if (shape === 'old') l.NoteWrite();                                     // (c), the one removed
  };
  for (let band = 0; band < 6; band++) l.NoteWrite();  // the bed
  for (let card = 0; card < CARDS; card++) {
    l.NoteRead(); l.NoteTargetBind('blur');            // the FILL build
    if (!fillAfterShadow) probe();
    l.NoteRead(); l.NoteTargetBind('shadow-state');    // the adaptive-shadow measure
    if (fillAfterShadow) probe();
    l.NoteWrite();                                     // the glass instance
    l.NoteWrite();                                     // label + sub, one text batch
    l.NoteRead(); l.NoteTargetBind('blur');            // the RIM build
    probe();                                           // the rim point, on the rebind either way
    l.NoteWrite();                                     // the rim instance
  }
  if (opts.Drain) l.NoteFrameEndDrain();
  return l;
};

const shapeOf = (l: SceneReadLedger): Record<string, number> => ({ ...l.EndsByKey });

describe('what the fixed instrument reads, on the ledger itself', () => {
  it('baseline is 40 switches, 40 restarts, 60 reads, {blur: 40} - the measured cell', () => {
    const l = glassGridFrame('none', true);
    expect(l.Switches).toBe(40);
    expect(l.Restarts).toBe(40);
    expect(l.Reads).toBe(60);
    expect(shapeOf(l)).toEqual({ blur: 40 });
  });

  it('?scene-restarts=40: switches 80, restarts 40, reads 60, {blur:40, restart-probe:40}', () => {
    // THE SPEC, and every number in it comes out of the ledger rather than out of the brief.
    const l = glassGridFrame('new', true);
    expect(l.Switches).toBe(80);
    expect(l.Restarts).toBe(40);
    expect(l.Reads).toBe(60);
    expect(shapeOf(l)).toEqual({ blur: 40, 'restart-probe': 40 });
    // `shadow-state` ABSENT, exactly as at baseline: the probe no longer re-dirties the scene in
    // front of the measure, so its 1x1 bind rides the build's end for free again.
    expect(shapeOf(l)['shadow-state']).toBeUndefined();
  });

  it('?small-restarts=40: switches 40, restarts 40, reads 60, {blur: 40} and NO new key', () => {
    // The small arm's row is its own proof. Its probe runs where the scene encoder has already
    // ended, so its bind books no switch, and a `small` cell showing `restart-probe` is void.
    const l = glassGridFrame('small', true);
    expect(l.Switches).toBe(40);
    expect(l.Restarts).toBe(40);
    expect(l.Reads).toBe(60);
    expect(shapeOf(l)).toEqual({ blur: 40 });
  });

  it('IS NOT VACUOUS: the old three-draw probe reproduces the M4 cell, 100 / 60 / shadow-state:20', () => {
    // Perf/README.md, "H4 REFUTED ON A LIVE FLAG": `switches 100 (spec 80), restarts 60 (spec 40),
    // plus an unpredicted shadow-state:20`. Both deviations fall out of one draw - (c) - landing
    // in front of a measure that was riding a build's end for free.
    const l = glassGridFrame('old', false);
    expect(l.Switches).toBe(100);
    expect(l.Restarts).toBe(60);
    expect(l.Reads).toBe(60);
    expect(shapeOf(l)).toEqual({ blur: 40, 'restart-probe': 40, 'shadow-state': 20 });
  });

  it('separates the two causes: (c) buys the extra ends, the PLACEMENT alone buys nothing', () => {
    // Dropping (c) but leaving the point before the measure fixes the switch column and not the
    // restart column: the scene is clean at the bind (no shadow-state end) but `_written` is still
    // set by (a), so the measure's READ is still a restart. Both changes are needed and this says
    // which does which.
    const cDroppedOnly = glassGridFrame('new', false);
    expect(shapeOf(cDroppedOnly)).toEqual({ blur: 40, 'restart-probe': 40 });
    expect(cDroppedOnly.Switches).toBe(80);
    expect(cDroppedOnly.Restarts).toBe(60);   // <- still wrong, and only the placement fixes it
    expect(glassGridFrame('new', true).Restarts).toBe(40);
  });

  it('holds at N=80 - two probes a point, the second point on the line through the origin', () => {
    // At `=80` a point emits two restarts, so the walk takes each probe twice in a row. The scene
    // arm's two level-0 draws are separated by its own scene draw, so neither fuses and both book.
    const l = new SceneReadLedger();
    l.BeginFrame();
    const probe2 = (): void => {
      for (let k = 0; k < 2; k++) { l.NoteWrite(); l.NoteTargetBind('restart-probe'); }
    };
    for (let band = 0; band < 6; band++) l.NoteWrite();
    for (let card = 0; card < CARDS; card++) {
      l.NoteRead(); l.NoteTargetBind('blur');
      l.NoteRead(); l.NoteTargetBind('shadow-state');
      probe2();
      l.NoteWrite(); l.NoteWrite();
      l.NoteRead(); l.NoteTargetBind('blur');
      probe2();
      l.NoteWrite();
    }
    l.NoteFrameEndDrain();
    expect(l.Switches).toBe(120);
    expect(l.Restarts).toBe(40);
    expect(l.Reads).toBe(60);
    expect(shapeOf(l)).toEqual({ blur: 40, 'restart-probe': 80 });
  });

  it('the frame-end balance is what booked `restart-probe:1` on the small arm - and it is gone', () => {
    // The M4 saw one small-arm frame at `switches=41 endsByKey=blur:40,restart-probe:1`. Reproduce
    // it: on frame ONE the spread knows no point count, so every point emits nothing and the whole
    // balance of forty fires at the end of the walk - where the rim instance has just drawn into
    // the scene. The FIRST of the forty binds ends that live encoder and the other thirty-nine are
    // free, which is why the count is 1 and not 40. It fires BEFORE `NoteFrameEndDrain`, because
    // `DiagRestartFrameEnd` is called before `PresentScene`.
    const l = glassGridFrame('none', true, { Drain: false });
    for (let k = 0; k < 40; k++) l.NoteTargetBind('restart-probe');   // the balance, at a dirty scene
    l.NoteFrameEndDrain();
    expect(l.Switches).toBe(41);
    expect(shapeOf(l)).toEqual({ blur: 40, 'restart-probe': 1 });
    // The shipped frame end emits nothing, so this sequence cannot occur.
    expect(member(RENDERER, 'DiagRestartFrameEnd')).not.toContain('_emitRestarts');
  });
});

// ── 8. THE DENOMINATOR: draws per FRAME are not draws per TICK ────────────────────────────────

/**
 * Every restarts arm the M4 read came back at EXACTLY half its specified draws per tick:
 *
 *     scene=40  +60 vs +120      small=40  +20 vs +40
 *     scene=80 +120 vs +240      small=80  +40 vs +80
 *
 * while the gate said `emitted=40 points=40 probes=40` and the ledger said `restart-probe:40`.
 * Forty probes cannot issue twenty probes' worth of draws, so the disagreement is in the UNIT. The
 * harness reports `drawCalls / engineTicks`, an engine tick is a rAF callback counted in the render
 * worker (`Tools/PerfHarness/instrument.mjs` patches `requestAnimationFrame` and counts every
 * callback), and the engine's frame loop is not the only rAF loop in that worker:
 * `Animation/Animation.Manager.ts` keeps a SCHEDULE-ONLY loop armed while any animatable is
 * unsettled, and it draws nothing. Two callbacks a rendered frame is the reading that fits all four
 * cells at once, and the cardcomposite cell's own raw numbers agree: a -1,696 `drawCalls` delta
 * over a 6,000 ms window at 66.75 -> 71.49 ms a frame needs ticks = 1.88 x frames.
 *
 * Nothing in this lane can change the harness's denominator. What it can do is stop the two
 * instruments disagreeing in silence: the engine now states its own frame count, its own probe-draw
 * count and - when the harness's counter is in this worker to read - the tick count beside them.
 */

describe('the census line states the denominator instead of leaving it to be inferred', () => {
  it('prints frames, probe draws and both per-unit ratios, with the harness ticks when present', () => {
    const census = member(RENDERER, '_restartCensus');
    for (const field of ['frames=', 'probeDraws=', 'probeDrawsPerFrame=', 'ticks=', 'ticksPerFrame=',
      'probeDrawsPerTick=']) {
      expect(census, `census field ${field}`).toContain(field);
    }
    // The harness counter is READ, never written, and never required.
    expect(census).toContain('__perfWorker');
    expect(census).toContain("ticks = null");
    expect(census).toContain("'n/a'");
    expect(census).not.toContain('__perfWorker.Raf =');
  });

  it('the frame and draw counters advance once a frame, off the frame end', () => {
    const end = member(RENDERER, 'DiagRestartFrameEnd');
    expect(end).toContain('this._restartFrames++;');
    expect(end).toContain('this._restartProbeDraws += ProbeDraws(this._restartStats.Scene, this._restartStats.Small);');
  });

  it('the ratios are the arithmetic the M4 reads, and a zero denominator is not a zero', () => {
    // 40 points x 2 draws = 80 a frame. Over 240 frames that is 19,200 probe draws; at two ticks a
    // frame the harness divides them by 480 and sees 40 per tick - exactly the half the second
    // lane's cells came back at, stated now on the engine's own line instead of inferred from it.
    const FRAMES = 240;
    const perFrame = ProbeDraws(40, 0);
    expect(perFrame).toBe(80);
    expect(Per(perFrame * FRAMES, FRAMES)).toBe(80);         // probeDrawsPerFrame
    expect(Per(FRAMES * 2, FRAMES)).toBe(2);                  // ticksPerFrame
    expect(Per(perFrame * FRAMES, FRAMES * 2)).toBe(40);      // probeDrawsPerTick - the M4's +40
    expect(Per(1, 3)).toBe(0.33);
    expect(Per(5, 0)).toBeNull();
  });

  it('the harness really does count every rAF callback in the worker, not the engine\'s frames', () => {
    // The claim above is about a file this lane does not own, so it is read rather than asserted
    // from memory: the patch counts on the callback, and the counter is the one the run subtracts
    // into `engineTicks`.
    const instrument = readFileSync(join(HERE, '..', '..', '..', '..', 'ShowStudio.App', 'Tools',
      'PerfHarness', 'instrument.mjs'), 'utf8').replace(/\r\n/g, '\n');
    expect(instrument).toContain('self.requestAnimationFrame = function (cb) {');
    expect(instrument).toContain('c.Raf++;');
    const run = readFileSync(join(HERE, '..', '..', '..', '..', 'ShowStudio.App', 'Tools',
      'PerfHarness', 'run.mjs'), 'utf8').replace(/\r\n/g, '\n');
    expect(run).toContain('EngineTicks: after.Worker.Raf - before.Worker.Raf,');
    // And the second rAF armer: a loop that re-arms every frame and draws nothing.
    const anim = src('Animation', 'Animation.Manager.ts');
    expect(anim).toContain('private _tick = (): void => {');
    const tick = anim.slice(anim.indexOf('private _tick = (): void => {'));
    expect(tick.slice(0, tick.indexOf('\n  };'))).toContain('requestAnimationFrame(this._tick);');
  });
});
