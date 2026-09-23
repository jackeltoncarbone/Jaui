import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlurPass, BLUR_PROGRAMS_BOOT, BLUR_PROGRAMS_ATLAS } from '../src/Core/BlurPass';
import {
  PANEL_PROGRAM_COUNT, PANEL_PROGRAM_BORDER_DIRECT, GLASS_VARIANT_PROGRAMS, GLASS_REG_PROGRAMS, GLASS_GATE_PROGRAMS,
} from '../src/Core/WebGL2.Renderer';
import { FakeGl } from './Blur.Chains.Source';
import { arrowBody, readRenderer, readJaui } from './Scene.ReadAfterWrite.Source';

/**
 * LANES bootcompile + bootcompile2 -- A PROGRAM AN UNFLAGGED PAGE NEVER BINDS IS NOT COMPILED
 * AT BOOT.
 *
 * TWO SETS have left the boot batch by the one mechanism, and the test for both is the same
 * sentence: does a page that armed no flag ever BIND this program? `BlurPass`'s five atlas
 * kernels (bootcompile, 22 -> 17) and the sixth panel variant, MATERIAL_GLASS + BORDER_DIRECT
 * (bootcompile2, 17 -> 16). The second only became flag-only when `2bb107f` flipped
 * `?border-direct` to default OFF after the M4 priced the gather at +2.59 ms; while it defaulted
 * ON it belonged at boot, and this file says so rather than pretending it was always wrong.
 *
 * The claim in one line: nothing about WHAT any program computes moves, only WHEN it is compiled.
 * So every assertion here is about the batch a program lands in and the moment that batch is
 * issued -- never about a kernel's text, which the two atlas files already pin character for
 * character.
 *
 * THE THREE PLACES A PROGRAM CAN BE COMPILED, and why the middle one is new:
 *
 *   BOOT      `Init`'s `ShaderBatch`. Every program an unflagged page can bind lives here, issued
 *             together and collected once at the first `BeginFrame`.
 *   ARM TIME  after `_initDebugFromUrl` has parsed the URL and BEFORE the first tick. On the
 *             worker path -- the app's and the harness's -- `Worker.Boot` awaits `Init` and only
 *             THEN constructs the `Canvas` whose constructor parses, so this moment exists and is
 *             off both the boot batch and the frame. It did not used to be used.
 *   FIRST USE the frame that first needs the program. Which for anything blur-shaped is the first
 *             frame that has glass on it -- the frame every boot measurement reads. Refused.
 *
 * WHAT THIS FILE CANNOT SEE: how long a driver takes to compile anything. `FakeGl` links
 * instantly. The numbers are the orchestrator's `shaderCompileMs` and the `jaui:shaders:issued`
 * mark; this file pins the SET, which is what those numbers are a reading of.
 */

const BLUR = readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8').replace(/\r\n/g, '\n');
const RENDERER = readRenderer().replace(/\r\n/g, '\n');
const JAUI = readJaui().replace(/\r\n/g, '\n');
const WORKER_BOOT = readFileSync(join(__dirname, '../src/Worker/Worker.Boot.ts'), 'utf8').replace(/\r\n/g, '\n');

/** `Init`'s body. Not `arrowBody`: `Init` is `async`, which that helper's header regex does not
 *  match, and a helper shared by a dozen files is not this lane's to widen. */
const INIT = ((): string => {
  const at = RENDERER.indexOf('Init = async (');
  const open = RENDERER.indexOf('{', RENDERER.indexOf('=>', at));
  let depth = 0;
  for (let i = open; i < RENDERER.length; i++) {
    if (RENDERER[i] === '{') depth++;
    else if (RENDERER[i] === '}' && --depth === 0) return RENDERER.slice(open + 1, i);
  }
  throw new Error('could not find Init');
})();

/** A `BlurPass` on a fake context, with every `createProgram` counted. */
const Counted = (): { Pass: BlurPass; Programs: () => number } => {
  const gl = new FakeGl();
  let n = 0;
  const create = gl.createProgram;
  gl.createProgram = ((): ReturnType<typeof create> => { n++; return create(); }) as typeof create;
  return { Pass: new BlurPass(gl.Gl), Programs: () => n };
};

describe('a BlurPass compiles what an unflagged page binds, and nothing else', () => {
  it('the constructor issues exactly BLUR_PROGRAMS_BOOT programs', () => {
    const { Pass, Programs } = Counted();
    expect(Programs()).toBe(BLUR_PROGRAMS_BOOT);
    expect(BLUR_PROGRAMS_BOOT).toBe(3);
    expect(Pass.AtlasProgramsCompiled).toBe(false);
  });

  it('arming adds exactly BLUR_PROGRAMS_ATLAS more, and says how many it added', () => {
    const { Pass, Programs } = Counted();
    const before = Programs();
    expect(Pass.EnsureAtlasPrograms()).toBe(BLUR_PROGRAMS_ATLAS);
    expect(BLUR_PROGRAMS_ATLAS).toBe(5);
    expect(Programs() - before).toBe(BLUR_PROGRAMS_ATLAS);
    expect(Pass.AtlasProgramsCompiled).toBe(true);
    // Eight in total, which is what every pass used to carry at boot.
    expect(Programs()).toBe(BLUR_PROGRAMS_BOOT + BLUR_PROGRAMS_ATLAS);
  });

  it('arming twice compiles nothing the second time, and returns 0 so a mark cannot double-count', () => {
    const { Pass, Programs } = Counted();
    Pass.EnsureAtlasPrograms();
    const after = Programs();
    expect(Pass.EnsureAtlasPrograms()).toBe(0);
    expect(Programs()).toBe(after);
  });

  it('an unarmed pass REFUSES an atlas build by name instead of binding a plain kernel', () => {
    // The silent fallback this throw exists to prevent: the plain kernel ignores `u_Slot`, so an
    // atlas build through it reads member 0's texels into every slot -- twenty cards wearing one
    // card's backdrop, which reads as a blur bug and not as a missing program.
    const { Pass } = Counted();
    expect(() => Pass.BlurAtlas(
      {} as never, 64, 64, 8, [] as never, 64, 64,
    )).toThrow(/atlas kernels were never compiled/);
  });

  it('the plain pyramid does not need the atlas kernels -- an unflagged page builds with three', () => {
    const gl = new FakeGl();
    const pass = new BlurPass(gl.Gl);
    const src = gl.MakeSource(512, 512, 'scene');
    expect(pass.AtlasProgramsCompiled).toBe(false);
    expect(() => pass.Blur(src as never, 512, 512, 8, undefined, undefined)).not.toThrow();
  });
});

describe('WHEN each program is compiled, in source', () => {
  it('the constructor batch carries no atlas kernel at all', () => {
    const ctor = BLUR.slice(BLUR.indexOf('this._maxChains = maxChains;'), BLUR.indexOf('get AtlasProgramsCompiled'));
    expect(ctor).toContain('this._down = b.Add(VERT, DOWN_FRAG(TAP_PLAIN));');
    expect(ctor).toContain('this._up = b.Add(VERT, UP_FRAG(TAP_PLAIN));');
    expect(ctor).toContain('this._copy = b.Add(VERT, COPY_FRAG);');
    expect(ctor).not.toContain('TAP_SLOT');
    expect(ctor).not.toContain('VERT_INST');
  });

  it('Init gates the atlas kernels on the flag, and records the boot set for the late mark', () => {
    expect(RENDERER).toContain('if (this.DiagPyramidAtlas) this._blur.EnsureAtlasPrograms(batch);');
    expect(RENDERER).toContain('this._bootShaderCount = batch.Count;');
    // The boot mark is untouched: on an unflagged page it is still the whole set.
    expect(RENDERER).toContain('JTrace(`jaui:shaders:issued n=${batch.Count} ${JMs(batch.IssueMs)}ms`);');
  });

  it('ArmFlaggedPrograms reconciles the pool FIRST, so the arming lands on the pass that runs', () => {
    // A rebuilt pass is a different pass. Arming before the rebuild would compile five kernels
    // onto an object about to be dropped and leave the live one without them.
    const body = arrowBody(RENDERER, 'ArmFlaggedPrograms');
    expect(body.indexOf('this._reconcileBlurPool()'))
      .toBeLessThan(body.indexOf('EnsureAtlasPrograms()'));
    // And it is inert before Init: main-thread mode parses the URL first and Init arms them there.
    expect(body).toContain('if ((this._blur as BlurPass | undefined) === undefined) return;');
  });

  it('the late mark books the cost to the flag that asked for it', () => {
    const body = arrowBody(RENDERER, 'ArmFlaggedPrograms');
    expect(body).toContain('jaui:shaders:issued n=${this._bootShaderCount} +${late}');
    expect(body).toContain('reason=${reason}');
    expect(body).toContain("this.DiagPyramidAtlas ? 'pyramid-atlas' : null");
    expect(body).toContain("border > 0 ? 'border-direct' : null,");
    // Nothing compiled, nothing printed: an unflagged page's trace is exactly what it was.
    expect(body).toContain('if (late === 0) return;');
  });

  it('a pass the pool REBUILDS is armed in the same batch, so it is one parallel compile', () => {
    const body = arrowBody(RENDERER, '_reconcileBlurPool');
    expect(body).toContain('const batch = new ShaderBatch(this._gl);');
    expect(body).toContain('const atlas = this.DiagPyramidAtlas ? pass.EnsureAtlasPrograms(batch) : 0;');
    // The separable kernel joins the SAME batch, for the same reason and with the same
    // consequence -- and unconditionally now, because it is the default per-surface plan's.
    expect(body).toContain("const gauss = pass.EnsureGaussianProgram(batch, 'pool');");
    expect(body).toContain('batch.Resolve();');
    expect(body).toContain('pass.WireLocations();');
    expect(body).toContain('return BLUR_PROGRAMS_BOOT + atlas + gauss;');
  });
});

describe('the SIXTH panel program leaves the boot batch by the same mechanism', () => {
  it('nothing in _compilePanelShader mentions it, and exactly one Add in the file does', () => {
    const compile = arrowBody(RENDERER, '_compilePanelShader');
    expect(compile).not.toContain('BORDER_DIRECT: true');
    expect(compile).not.toContain('DiagBorderDirect');
    expect(compile).not.toContain('_panelShaderBorderDirect');
    // The whole edit, stated as an identity: ONE `Add`, the same two sources, the same defines,
    // in a different batch. Nothing about what it computes can have moved.
    expect((RENDERER.match(/BORDER_DIRECT: true/g) ?? []).length).toBe(1);
    const ensure = arrowBody(RENDERER, 'EnsurePanelBorderDirectProgram');
    expect(ensure).toContain('b.Add(panelVertSrc, panelFragSrc,');
    expect(ensure).toContain('{ MATERIAL_GLASS: true, BORDER_DIRECT: true });');
  });

  it('it is idempotent, owns its batch when it has none, and returns what it issued', () => {
    // The same three properties `EnsureAtlasPrograms` has, for the same three reasons: a second
    // call must compile nothing and return 0 so the late mark cannot double-count, a caller with
    // an open batch must be joined rather than serialised, and a caller without one gets a
    // parallel batch of its own that is resolved and wired before it returns.
    const ensure = arrowBody(RENDERER, 'EnsurePanelBorderDirectProgram');
    expect(ensure).toContain('if (this._panelShaderBorderDirect !== null) return 0;');
    expect(ensure).toContain('const b = batch ?? new ShaderBatch(this._gl);');
    expect(ensure).toContain('if (batch === undefined) { b.Resolve(); this._wirePanelBorderDirect(); }');
    expect(ensure).toContain('return PANEL_PROGRAM_BORDER_DIRECT;');
    expect(PANEL_PROGRAM_BORDER_DIRECT).toBe(1);
  });

  it('an unarmed page cannot route a border to it: the pick throws by name', () => {
    // The atlas kernels' own answer, for the panel program. A fallback to `_panelShaderGlass`
    // would shade the rim with the PYRAMID tap against a handle holding a raw scene copy -- a
    // wrong picture that reads as a blur bug and not as a missing program -- and there is no
    // other program that could be right.
    const orThrow = arrowBody(RENDERER, '_panelBorderDirectOrThrow');
    expect(orThrow).toContain('if (shader === null || locs === null) {');
    expect(orThrow).toContain('was never compiled');
    expect(orThrow).toContain('EnsurePanelBorderDirectProgram');
    expect(RENDERER).toContain(
      'const direct = isBorderDirect ? this._panelBorderDirectOrThrow() : null;');
    expect(RENDERER).toContain('const program = direct !== null ? direct.Shader');
    expect(RENDERER).toContain('const locs = direct !== null ? direct.Locs');
  });

  it('the wiring follows whichever batch carried it, once', () => {
    // Two compile paths, one wire. `Init`'s batch (main-thread order) resolves in
    // `_ensureShaders`, which calls `_wirePanelShader`; the arm's own batch resolves inside
    // `EnsurePanelBorderDirectProgram`. `_panelBorderDirectWired` is what stops the second from
    // re-reading locations the first already has -- `BlurPass._atlasWired`'s shape exactly.
    const wirePanel = arrowBody(RENDERER, '_wirePanelShader');
    expect(wirePanel).toContain('if (this._panelShaderBorderDirect !== null && !this._panelBorderDirectWired) {');
    const wireDirect = arrowBody(RENDERER, '_wirePanelBorderDirect');
    expect(wireDirect).toContain('this._panelBorderDirectWired = true;');
    expect(wireDirect).toContain('_preparePanelProgram(this._gl, shader.Program)');
  });

  it('the flag and the renderer field agree on OFF, so the worker path cannot compile it by default', () => {
    // On the worker path `Init` is awaited BEFORE the URL is parsed, so `Init`'s gate reads this
    // field's DEFAULT however the URL reads. A `true` default there would have put the program
    // back in every boot batch while the mark still said the flag was off -- the vacuous shape.
    expect(RENDERER).toContain('DiagBorderDirect = false;');
    expect(JAUI).toContain('private _borderDirect: boolean = false;');
    // And Jaui hands the SURVIVING arm over on both arms, outside the refusal block.
    expect(JAUI).toContain('this._renderer.DiagBorderDirect = this._borderDirect;');
    expect(JAUI).not.toContain('if (r instanceof WebGL2Renderer) r.DiagBorderDirect = this._borderDirect;');
  });

  it('a restored context drops it, because the ensure method would otherwise skip the rebuild', () => {
    // Every other panel variant is overwritten by `Init`'s batch. This one is guarded by its own
    // `!== null`, so a handle from the dead context would survive the restore and be bound.
    expect(INIT).toContain('this._panelShaderBorderDirect = null;');
    expect(INIT).toContain('this._panelLocsBorderDirect = null;');
    expect(INIT).toContain('this._panelBorderDirectWired = false;');
    expect(INIT.indexOf('this._panelShaderBorderDirect = null;'))
      .toBeLessThan(INIT.indexOf('const batch = new ShaderBatch(gl);'));
  });
});

describe('the arming moment is after the URL and before the first frame', () => {
  it('the worker awaits Init, THEN constructs the Canvas that parses the URL', () => {
    // The Init-order trap, from the other end: this is why a flag-gated compile inside `Init`
    // would be dead on the worker path, and why there is a moment after it that is not a frame.
    expect(WORKER_BOOT.indexOf('await renderer.Init(m.Canvas);'))
      .toBeLessThan(WORKER_BOOT.indexOf('const canvas = new Canvas('));
  });

  it('_initDebugFromUrl parses in the Canvas constructor and arms LAST, after every refusal', () => {
    const body = arrowBody(JAUI, '_initDebugFromUrl');
    expect(body).toContain('if (this._renderer instanceof WebGL2Renderer) this._renderer.ArmFlaggedPrograms();');
    // LAST: a `?pyramid-atlas` refused for one of its named conflicts must leave no kernels behind.
    // The CALL, not the first mention: a comment elsewhere in the method may name the method.
    const armAt = body.indexOf('this._renderer.ArmFlaggedPrograms();');
    expect(body.indexOf("jaui:pyramid-atlas armed=false reason=")).toBeLessThan(armAt);
    expect(body.slice(armAt)).not.toContain('params.');
    // And the parse itself is in the constructor, ahead of `Start` and so ahead of the first tick.
    expect(JAUI).toContain('this._initDebugFromUrl();');
  });
});

describe('the boot set is every program an unflagged page can bind, and only those', () => {
  it('Init issues the five panel programs, the eight singles and the blur pass, and no arm-only one', () => {
    const init = INIT;
    for (const compile of [
      '_compilePanelShader', '_compileTextShader', '_compileStrokeShader', '_compileSvgFillShader',
      '_compileSvgStrokeShader', '_compileBlitShader', '_compileClipMaskShader',
      '_compileProgBlurShader', '_compileShadowBackdropShader',
    ]) expect(init).toContain(`this.${compile}(batch);`);
    // TWO conditional adds in the batch now, and each one's condition is a flag. Both are
    // MAIN-THREAD ORDER ONLY -- that path parses the URL in the `Canvas` constructor, ahead of
    // `Init`, so a flag that armed there joins the boot batch for free. On the worker path both
    // fields still hold their OFF defaults here however the URL read.
    const atlasAdds = init.split('\n').filter((l) => l.includes('EnsureAtlasPrograms'));
    expect(atlasAdds.length).toBe(1);
    expect(atlasAdds[0]).toContain('if (this.DiagPyramidAtlas)');
    const borderAdds = init.split('\n')
      .filter((l) => l.includes('this.EnsurePanelBorderDirectProgram(batch);'));
    expect(borderAdds.length).toBe(1);
    expect(borderAdds[0]).toContain('if (this.DiagBorderDirect)');
  });

  it('the boot set is EIGHTEEN, and the three places that say so agree', () => {
    // Seven panel variants, the eight singles (text, stroke, two SVG, blit, clip mask, progressive
    // blur, adaptive-shadow probe), and a `BlurPass`'s three. Arithmetic rather than a literal so
    // that a variant added anywhere has to move this line too -- as lane glassreg's two
    // `?glass-programs` cuts did (sixteen -> eighteen): the default binds them on glass-grid.
    const SINGLES = 8;
    expect(PANEL_PROGRAM_COUNT + SINGLES + BLUR_PROGRAMS_BOOT).toBe(18);
    expect(GLASS_VARIANT_PROGRAMS).toBe(2);
    expect(INIT).toContain('EIGHTEEN programs stand between a cold tab and its first pixel');
    expect(readFileSync(join(__dirname, '../src/Core/Shader.Compiler.ts'), 'utf8'))
      .toContain('EIGHTEEN IS THE UNFLAGGED SET');
    // And the twelve that are NOT in it are exactly the four flags' sets (lane gatebisect's
    // `?glass-gates` family made it twelve).
    expect(BLUR_PROGRAMS_ATLAS + PANEL_PROGRAM_BORDER_DIRECT + GLASS_REG_PROGRAMS + GLASS_GATE_PROGRAMS).toBe(12);
  });

  it('the restart probe and the instanced VAO stay where they are: off the boot batch', () => {
    // Two things this lane deliberately did not move. The probe is already built on first use
    // (lane restarts2's own remedy for the same trap) and the instanced VAO is not a program.
    expect(RENDERER).toContain('this._ensureRestartProbe();');
    // Named in an Init comment, CALLED from `BeginFrame` -- which is the distinction.
    expect(INIT).not.toContain('this._ensureRestartProbe();');
    expect(BLUR).toContain('private _ensureInstanceVao');
  });
});

describe('a restored context rebuilds every pass, not just the one Init owns', () => {
  it('Init drops the two LAZY blur passes, whose programs died with the old context', () => {
    const init = INIT;
    expect(init).toContain('this._rootBlur = null;');
    expect(init).toContain('this._sharedBlur = null;');
    expect(init).toContain('this._lastBlur = null;');
    // Before the batch: they are cleared with the other things the dead context owned.
    expect(init.indexOf('this._rootBlur = null;')).toBeLessThan(init.indexOf('const batch = new ShaderBatch(gl);'));
  });
});
