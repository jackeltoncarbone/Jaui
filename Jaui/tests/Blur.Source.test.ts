/**
 * `?blur-src-static` / `?blur-src-clear` — the two flags that separate "reading a written texture"
 * from "a written texture".
 *
 * The perf ledger narrowed the glass frame's ~37 ms interaction to the pyramid BUILD when its source
 * holds written content: no builds at all read 34.32 GPU ms on `glass-grid`, 39 builds over a
 * CLEARED scene read 13.80, and 40 builds over real content read ~72 whether the bed is busy or
 * flat, whether the source is the attachment or the frame snapshot, and whether the scene encoder
 * ends 40 times or once. Two mechanisms survive that — the READ's own bandwidth (H1) and a
 * same-frame write→sample hazard (H2) — and they are told apart by pointing the DOWN pass at a
 * texture nothing wrote THIS frame while changing nothing else about the frame.
 *
 * "Nothing else" is the whole instrument, so it is what these tests pin. There is no GPU here and no
 * claim about milliseconds: what is asserted is that the substitution is a substitution — every
 * draw, every resolve, every ledger booking and every encoder end left where baseline puts them,
 * with only the sampled texture moving — and that the flag cannot be read on a build that did not
 * receive it.
 */
import { describe, it, expect } from 'vitest';
import { readRenderer, readJaui, arrowBody } from './Scene.ReadAfterWrite.Source';

const renderer = readRenderer();
const jaui = readJaui();

describe('?blur-src — the flag arrives and says so', () => {
  it('both spellings parse, exact-key, and only on the WebGL2 renderer', () => {
    expect(jaui).toContain("params.has('blur-src-static') && this._renderer instanceof WebGL2Renderer");
    expect(jaui).toContain("params.has('blur-src-clear') && this._renderer instanceof WebGL2Renderer");
  });

  it('clear is parsed AFTER static, so a run that typed both reads as the cheaper arm', () => {
    expect(jaui.indexOf("params.has('blur-src-static')")).toBeLessThan(jaui.indexOf("params.has('blur-src-clear')"));
  });

  it('Init marks the armed flag, beside the other two', () => {
    // A reading taken with this mark absent is a reading of the wrong build — the M4 lost `?no-depth`
    // once to an unquoted shell variable and the numbers looked perfectly reasonable.
    expect(renderer).toContain("JTrace(`jaui:blur-src armed=${this.DiagBlurSrc} pixels=WRONG`)");
    expect(renderer.indexOf("jaui:blur-dummy armed=true")).toBeLessThan(renderer.indexOf('jaui:blur-src armed='));
  });

  it('the fill marks itself too, with the size it built at', () => {
    expect(arrowBody(renderer, '_fillBlurSrcOnce')).toContain('jaui:blur-src filled=');
  });

  it('the field is a three-state, default OFF', () => {
    expect(renderer).toContain("DiagBlurSrc: 'static' | 'clear' | null = null;");
  });
});

describe('?blur-src — the substitution changes the READ and nothing else', () => {
  it('the in-scene pyramid keeps every argument and swaps only the texture', () => {
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body).toContain('if (this.DiagBlurSrc !== null) input = _wrap(this._blurSrcFor(_unwrap(input)), _regionOf(input));');
    // The call itself is left as the baseline line, region and all — which is also what keeps the
    // read-after-write ledger's own gate on it load-bearing rather than rewritten around.
    expect(body).toContain('pass.Blur(_unwrap(input), width, height, radius, minDepth, region, undefined,'
      + '\n      rebase, gaussMode, sepReq)');
  });

  it('the card branch still RESOLVES its source, so the copy and its encoder end survive', () => {
    // Swapping `_cardBackdropSource` out instead of swapping its result would remove work, and an
    // ablation that removes work cannot price anything — that is the rule the card composite bought.
    const body = arrowBody(renderer, 'ComputeBlur');
    const resolve = body.indexOf('let src = this._cardBackdropSource(');
    expect(resolve).toBeGreaterThan(-1);
    expect(body.indexOf('src = this._blurSrcFor(src);')).toBeGreaterThan(resolve);
    expect(body.indexOf('pass.Blur(src, this._width, this._height, radius, minDepth, region, undefined,'
      + '\n        rebase, gaussMode, sepReq)'))
      .toBeGreaterThan(body.indexOf('src = this._blurSrcFor(src);'));
  });

  it('it is checked after ?no-blur and after ?blur-dummy, which may not shift by a line', () => {
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body).toContain('if (this.DiagNoBlur) return input;');
    expect(body).toContain('if (this.DiagBlurDummy) return this._blurDummyTexture();');
    expect(body.indexOf('if (this.DiagBlurDummy)')).toBeLessThan(body.indexOf('this._blurSrcFor('));
  });

  it('the ledger is still told about the read and the build, ahead of the swap', () => {
    const body = arrowBody(renderer, 'ComputeBlur');
    expect(body.indexOf('this._sceneLedger.NoteRead();')).toBeLessThan(body.indexOf('this._blurSrcFor('));
    expect(body.indexOf("this._sceneLedger.NoteTargetBind('blur');")).toBeLessThan(body.indexOf('this._blurSrcFor('));
  });

  it('SnapshotScreen substitutes the RETURN, so the blit and its `snapshot` end still happen', () => {
    const body = arrowBody(renderer, 'SnapshotScreen');
    expect(body).toContain('this._cardIntoSnapshot(snapCard, scissor) : this._snapshotBlit(scissor)');
    expect(body).toContain('return sub === null ? snapped : _wrap(sub);');
    // …and after the two older flags, which return before it.
    expect(body.indexOf('if (this.DiagSnapOnce)')).toBeLessThan(body.indexOf('this._blurSrcSubstitute()'));
  });

  it('the adaptive shadow’s sharp tap takes the same substitution, after its card resolve', () => {
    const body = arrowBody(renderer, 'MeasureShadowBackdrop');
    expect(body.indexOf('sharp = this._cardSharpTap(probeCard, rect);'))
      .toBeLessThan(body.indexOf('sharp = this._blurSrcFor(sharp);'));
    // The ledger's own note reads `scene`, not `sharp`, so the swap cannot move the count.
    expect(body).toContain('if (_unwrap(scene) === this._sceneFbo.Texture) this._sceneLedger.NoteRead();');
  });

  it('nothing substitutes inside `SceneTexture` itself', () => {
    // It would break the identity test `ComputeBlur` books its read on, and the counters would move.
    expect(arrowBody(renderer, 'ComputeBlur')).toContain('if (_unwrap(input) === this._sceneFbo.Texture) this._sceneLedger.NoteRead();');
    expect(renderer).not.toContain('get SceneTexture(): GpuTextureHandle {\n    if (this.DiagBlurSrc');
  });
});

describe('?blur-src — the stand-in is the same texture the scene target is', () => {
  const fill = arrowBody(renderer, '_fillBlurSrcOnce');

  it('canvas-sized RGB10_A2, LINEAR, CLAMP — the scene FBO and the snapshot to the letter', () => {
    expect(fill).toContain('gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, W, H, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null)');
    expect(fill).toContain('gl.TEXTURE_MIN_FILTER, gl.LINEAR');
    expect(fill).toContain('gl.TEXTURE_MAG_FILTER, gl.LINEAR');
    expect(fill).toContain('gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE');
    const snapshot = arrowBody(renderer, '_ensureSnapshotTexture');
    expect(snapshot).toContain('gl.RGB10_A2');
  });

  it('static BLITS the scene once; clear CLEARS to opaque black once', () => {
    expect(fill).toContain("if (this.DiagBlurSrc === 'clear')");
    expect(fill).toContain('gl.clearColor(0, 0, 0, 1);');
    expect(fill).toContain('gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);');
  });

  it('ONCE: a second call with the canvas unchanged returns before any GL', () => {
    expect(fill).toContain('if (this._blurSrcFilled && this._blurSrcTex !== null && this._blurSrcW === W && this._blurSrcH === H) return;');
  });

  it('a resize rebuilds it rather than handing back the old canvas’s region', () => {
    expect(arrowBody(renderer, '_blurSrcSubstitute'))
      .toContain('if (this._blurSrcW !== this._width || this._blurSrcH !== this._height) return null;');
    expect(fill).toContain('gl.deleteTexture(this._blurSrcTex)');
  });

  it('the clear restores the clear colour and both arms restore the scissor', () => {
    expect(fill).toContain('gl.getParameter(gl.COLOR_CLEAR_VALUE)');
    expect(fill).toContain('gl.clearColor(prev[0], prev[1], prev[2], prev[3]);');
    expect(fill).toContain('const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);');
    expect(fill).toContain('if (scissorOn) gl.enable(gl.SCISSOR_TEST);');
  });
});

describe('?blur-src — the fill books no encoder end', () => {
  it('it runs in PresentScene on the far side of NoteFrameEndDrain', () => {
    // That instant is the one place in the frame where the switch flag is provably drained, so the
    // fill’s binds count zero. Anywhere else and `EndsByKey` moves on the fill frame, and the
    // flag would have changed more than the read on the very frame it arms.
    const body = arrowBody(renderer, 'PresentScene');
    expect(body.indexOf('this._sceneLedger.NoteFrameEndDrain();'))
      .toBeLessThan(body.indexOf('if (this.DiagBlurSrc !== null) this._fillBlurSrcOnce();'));
    expect(body.indexOf('if (this.DiagBlurSrc !== null) this._fillBlurSrcOnce();'))
      .toBeLessThan(body.indexOf('gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._sceneFbo.Framebuffer);'));
  });

  it('the fill never calls `_tgt`, which is the booking call', () => {
    expect(arrowBody(renderer, '_fillBlurSrcOnce')).not.toContain('this._tgt(');
  });

  it('the fill notes no scene read either', () => {
    expect(arrowBody(renderer, '_fillBlurSrcOnce')).not.toContain('_sceneLedger');
  });
});

describe('?blur-src — off by default costs nothing and takes no path', () => {
  it('every site is behind a null check on the flag', () => {
    expect(arrowBody(renderer, 'PresentScene')).toContain('if (this.DiagBlurSrc !== null)');
    expect(arrowBody(renderer, '_blurSrcSubstitute')).toContain('if (this.DiagBlurSrc === null');
  });

  it('`_blurSrcFor` returns its argument unchanged when the flag is off', () => {
    const body = arrowBody(renderer, '_blurSrcFor');
    expect(body).toContain('if (sub === null) return src;');
  });

  it('it substitutes ONLY for the three canvas-sized scene-content textures', () => {
    // A smaller source would put every uniform the build computes on different floating-point
    // values, and the pyramid would stop being the baseline pyramid.
    expect(arrowBody(renderer, '_blurSrcFor'))
      .toContain('if (src !== this._sceneFbo.Texture && src !== this._snapshotTex && src !== this._frameSnapTex) return src;');
  });
});
