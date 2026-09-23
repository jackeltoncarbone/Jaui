import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `?ablate` -- the phone prices its own arms in one session. The fields it switches must all be
 * read per frame (or the arm would not change between two renders), and the blur cache must be off
 * under it (a pyramid kept under one arm would be served to another).
 */
const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('ablate > arms, the per-frame fields they flip, and the cache refusal', () => {
  it('knows its arms and throws on any other by name', () => {
    expect(JAUI).toContain("const ABLATE_ARMS = ['control', 'no-blur', 'no-pblur', 'no-panels', 'no-glass-draw', 'no-shadow', 'no-occlusion', 'no-ui'];");
    expect(JAUI).toContain("throw new Error(`[Jaui] ?ablate arm '${a}' is not one of ${known.join(',')}`);");
  });

  it('the blur cache refuses beside it', () => {
    expect(JAUI).toContain("params.has('ablate') ? 'ablate-switches-arms-mid-run-and-a-kept-pyramid-would-cross-arms'");
  });

  it('every arm clears the others, so an arm is ONE variable', () => {
    const start = JAUI.indexOf('private _ablateApply = ');
    const body = JAUI.slice(start, JAUI.indexOf('};', start));
    for (const f of ['_diagNoBlur', '_diagNoPblur', '_diagNoPanels', '_diagNoGlassDraw', '_diagNoShadow',
      'JivInstanceBuffer.DiagNoShadow', '_occlusion', '_diagNoUi']) {
      expect(body).toContain(f);
    }
  });

  it('the renderer takes the no-blur field per frame, which is what lets the arm switch mid-run', () => {
    expect(JAUI).toContain('if (this._renderer instanceof WebGL2Renderer) this._renderer.DiagNoBlur = this._diagNoBlur;');
  });
});
