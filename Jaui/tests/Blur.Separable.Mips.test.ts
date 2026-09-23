import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlurPass, type BackdropRect } from '../src/Core/BlurPass';
import { type SeparableRequest } from '../src/Core/Blur.Separable';
import { FakeGl } from './Blur.Chains.Source';

/**
 * `?blur-mips=separable` -- A SHALLOW MIP CONSUMER TAKES THE SEPARABLE PLAN.
 *
 * The phone's hero: `HeroPill`'s `BorderFilter: Blur(0.5pt)` reads its pyramid at LOD 0.5, which
 * made it a mip consumer, and `_maySeparable` sent every mip consumer to the 8-pass chain -- for its
 * fill AND its rim, on every scrolled frame. The trace put the hero at 28-32 blur passes a frame and
 * the page below it at 12-16, and the hero at half the frame rate.
 *
 * What the rule rests on is that the mip stack after a separable build is built FROM that build:
 * `_blurSeparable` writes level 0 of the chain `_useChain` selected, and `GenerateOutputMipmap`
 * halves from exactly that level. So no level a consumer can reach is left over from another frame.
 */

const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');
const DELIVERED: SeparableRequest = { Sigma: 'delivered', Fetches: null };

// The hero pill at dpr 2, phone width: Blur(20pt) = radius 40 device px, its fill region.
const W = 840, H = 1426;
const PILL: BackdropRect = { x: 108, y: 900, w: 624, h: 296 };

const Rig = (): { Gl: FakeGl; Pass: BlurPass } => {
  const gl = new FakeGl();
  const pass = new BlurPass(gl.Gl, undefined, 1);
  pass.EnsureGaussianProgram(undefined, 'boot');
  return { Gl: gl, Pass: pass };
};

const build = (r: { Gl: FakeGl; Pass: BlurPass }, scene: string, maxLod: number): object => {
  const src = r.Gl.MakeSource(W, H, scene);
  const out = r.Pass.Blur(src as unknown as WebGLTexture, W, H, 40, 0, PILL, undefined, false, 'off', DELIVERED);
  r.Pass.GenerateOutputMipmap(maxLod);
  return out as unknown as object;
};

describe('blur-mips > the mip stack of a separable build is built from that build', () => {
  it('the hero pill takes the separable plan, re-based (k > 1), in fewer passes than the chain`s 8', () => {
    const r = Rig();
    build(r, 'scene', 0.5);
    const b = r.Pass.LastBuild;
    expect(b.Plan).toBe('separable');
    expect(b.K).toBeGreaterThan(1);
    expect(b.Passes).toBeLessThan(8);
  });

  it('LOD 0.5 builds levels 1 and 2, and both hold THIS frame`s pixels -- never a previous frame`s', () => {
    const r = Rig();
    const a = build(r, 'frame-A', 0.5);
    const a1 = r.Gl.ValueOf(a, 1), a2 = r.Gl.ValueOf(a, 2);
    expect(a1.startsWith('empty')).toBe(false);
    expect(a2.startsWith('empty')).toBe(false);

    // A different scene moves every level; the same scene again lands on the same levels.
    const b = build(r, 'frame-B', 0.5);
    expect(b).toBe(a);
    const b1 = r.Gl.ValueOf(b, 1), b2 = r.Gl.ValueOf(b, 2);
    expect(b1).not.toBe(a1);
    expect(b2).not.toBe(a2);

    const again = build(r, 'frame-A', 0.5);
    expect(r.Gl.ValueOf(again, 1)).toBe(a1);
    expect(r.Gl.ValueOf(again, 2)).toBe(a2);
  });

  it('LOD 0 still builds no mips at all', () => {
    const r = Rig();
    r.Gl.Reset();
    const out = build(r, 'scene', 0);
    expect(r.Gl.ValueOf(out, 1)).toBe('unallocated');
    expect(r.Gl.Calls).not.toContain('blitFramebuffer');
  });
});

describe('blur-mips > the walk`s admission rule and its control arm (source)', () => {
  it('a mip consumer takes the plan up to ONE LOD, and never on the Gaussian arm', () => {
    expect(JAUI).toContain('const SEPARABLE_MIP_MAX_LOD = 1;');
    expect(JAUI).toContain(`  private _maySeparable = (plan: GlassBlurPlan): boolean =>
    plan.MaxLod === 0
      ? this._glassGaussian !== 'off' || this._blurSeparable
      : this._blurSeparable && this._glassGaussian === 'off' && this._blurSeparableMips
        && plan.MaxLod <= SEPARABLE_MIP_MAX_LOD;`);
  });

  it('DEFAULT separable; `?blur-mips=chain` is the control; anything else throws by name', () => {
    expect(JAUI).toContain('private _blurSeparableMips = true;');
    expect(JAUI).toContain("this._blurSeparableMips = raw === 'separable';");
    expect(JAUI).toContain("throw new Error(`[Jaui] ?blur-mips takes 'separable' or 'chain', got '${raw}'`);");
    expect(JAUI).toContain("` mips=${this._blurSeparable && this._blurSeparableMips ? 'separable' : 'chain'}`");
  });
});
