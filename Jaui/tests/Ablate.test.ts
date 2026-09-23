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
    expect(JAUI).toContain(`const ABLATE_ARMS = ['control', 'no-blur', 'no-pblur', 'no-panels', 'no-glass-draw', 'no-shadow', 'no-occlusion', 'no-ui',
  'snap64', 'snap256', 'no-pblur-draw', 'no-pblur-deep', 'no-pblur-shallow'];`);
    expect(JAUI).toContain('const ABLATE_SNAP: Record<string, number> = { snap64: 64, snap256: 256 };');
    expect(JAUI).toContain("throw new Error(`[Jaui] ?ablate arm '${a}' is not one of ${known.join(',')}`);");
  });

  it('the blur cache refuses beside it', () => {
    expect(JAUI).toContain("params.has('ablate') ? 'ablate-switches-arms-mid-run-and-a-kept-pyramid-would-cross-arms'");
  });

  it('every arm clears the others, so an arm is ONE variable', () => {
    const start = JAUI.indexOf('private _ablateApply = ');
    const body = JAUI.slice(start, JAUI.indexOf('};', start));
    for (const f of ['_diagNoBlur', '_diagNoPblur', '_diagNoPanels', '_diagNoGlassDraw', '_diagNoShadow',
      'JivInstanceBuffer.DiagNoShadow', '_occlusion', '_diagNoUi', 'RegionExtentSnap.Unit',
      '_diagNoPblurDraw', '_ablatePblur']) {
      expect(body).toContain(f);
    }
  });

  it('the renderer takes the no-blur field per frame, which is what lets the arm switch mid-run', () => {
    expect(JAUI).toContain('if (this._renderer instanceof WebGL2Renderer) this._renderer.DiagNoBlur = this._diagNoBlur;');
  });

  it('a control slot sits beside every arm, and each arm prints once a cycle', () => {
    expect(JAUI).toContain("for (const a of tested) arms.push('control', a);");
    expect(JAUI).toContain('for (const name of new Set(a.Arms)) {');
    expect(JAUI).toContain('RegionExtentSnap.Unit = ABLATE_SNAP[arm] ?? this._ablateSnapBase;');
    expect(JAUI).toContain('this._ablateSnapBase = RegionExtentSnap.Unit;');
  });

  it('the depth arms drop ONE class of progressive blur, at the depth the walk itself computes', () => {
    expect(JAUI).toContain("} else if (material === 'ProgressiveBlur' && this._pblurOn(node)) {");
    expect(JAUI).toContain("const isPblur = node.RenderStyle.Material === 'ProgressiveBlur' && this._pblurOn(node);");
    expect(JAUI).toContain('const lod = Math.max(1, Math.log2(Math.max(1, node.RenderStyle.BackdropFrostBlur)));');
    expect(JAUI).not.toContain("'ProgressiveBlur' && !this._diagNoPblur");
  });
});
