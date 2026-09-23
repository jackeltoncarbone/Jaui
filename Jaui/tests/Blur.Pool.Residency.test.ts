import { describe, it, expect } from 'vitest';
import { BlurPass, MAX_CHAINS } from '../src/Core/BlurPass';
import { Framebuffer } from '../src/Core/Framebuffer';
import { FakeGl } from './Blur.Chains.Source';

/**
 * The chain pool must hold every level-0 size a steady page draws, or it reallocates every frame.
 *
 * `_useChain` evicts least-recently-used, and LRU over a CYCLE is the pathological case: a frame
 * that visits N + 1 sizes in the same order through an N-slot pool misses on EVERY build, because
 * the size about to be asked for is always the one just evicted. The home page on an iPhone
 * (2026-09-23 trace, `/`, 420x713 at engine DPR 2) drew seven distinct extents a frame against the
 * old ceiling of six and reallocated ~15 textures per frame at rest (`extentAllocs=15`, every
 * frame, with nothing moving), holding it near 10 fps; frames that happened to need five or fewer
 * sizes ran at 50. Seven sizes, the phone's own, cycled for several frames: after the first frame
 * nothing may allocate.
 */

const W = 840;
const H = 1426;
const RADIUS = 16;

/** The seven level-0 extents of the resting home frame, as regions (`jaui:blur-plan extents=`). */
const REGIONS = [
  { x: 20, y: 40, w: 178, h: 140 },
  { x: 10, y: 1300, w: 412, h: 92 },
  { x: 10, y: 1100, w: 420, h: 156 },
  { x: 60, y: 200, w: 544, h: 216 },
  { x: 100, y: 420, w: 624, h: 296 },
  { x: 0, y: 0, w: 630, h: 796 },
  { x: 0, y: 900, w: 796, h: 50 },
];

describe('the chain pool holds a steady phone frame', () => {
  it('has room for the seven sizes the home page draws', () => {
    expect(MAX_CHAINS).toBeGreaterThanOrEqual(REGIONS.length);
  });

  it('cycling seven sizes allocates on the first frame and never again', () => {
    const gl = new FakeGl();
    const pass = new BlurPass(gl.Gl);
    const src = gl.MakeSource(W, H, 'scene') as WebGLTexture;
    const frame = (): void => { for (const r of REGIONS) pass.Blur(src, W, H, RADIUS, 0, r); };

    frame();
    const afterFirst = Framebuffer.FirstAllocations;
    const resident = pass.ChainCensus.Resident;
    for (let i = 0; i < 5; i++) frame();

    expect(Framebuffer.FirstAllocations - afterFirst).toBe(0);
    expect(pass.ChainCensus.Resident).toBe(resident);
  });
});
