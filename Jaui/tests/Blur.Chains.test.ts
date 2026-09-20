import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BlurPass, ChainBytes, MAX_CHAINS, CHAIN_BUDGET_BYTES,
  BaseDownsampleFactor, PyramidDepth, ResolveRegionRect, type BackdropRect,
} from '../src/Core/BlurPass';
import { OnJauiTrace } from '../src/Diagnostics/Jaui.Trace';
import { FakeGl } from './Blur.Chains.Source';

/**
 * `?blur-chains=N` — rotate the level-chain pool so consecutive builds never share a chain.
 *
 * The flag exists to put a frame-time number on H4: `BlurPass._useChain` keys a chain on its
 * LEVEL-0 SIZE, so all twenty glass-grid cards resolve to two sizes and forty builds a frame share
 * TWO chains — each build overwriting the level textures the previous card's draw just sampled.
 *
 * Two things have to be true for the reading to mean anything, and both are pinned here:
 *   1. It is PIXEL-IDENTICAL. A chain's contents are per-build, so which chain a build lands on
 *      cannot change a texel. Proved by running the same build twice on different chains through
 *      a GL stand-in that applies each draw as a pure function of its inputs, and comparing what
 *      they wrote.
 *   2. N=1 is the shipped pool, unchanged, and the pool REFUSES an N it cannot hold rather than
 *      evicting — because an evicting pool reallocates whole textures mid-frame, which is the
 *      thrash `_useChain` exists to prevent and would be read as this flag's own cost.
 */

// ── glass-grid, pinned. 1280x800 CSS at deviceScaleFactor 2; PerfGrid 216x150pt cards on a
//    236pt pitch, 5 across. The same geometry Blur.Union.test.ts works in. ──
const CANVAS_W = 2560;
const CANVAS_H = 1600;
const DPR = 2;
/** BackdropFilter Blur(4pt) at DPR 2. */
const RADIUS = 4 * DPR;
/** The FILL pipeline's margin: frost*d + (thickness*d + bulge)*Refraction + CA*3 + 8*d. */
const FILL_MARGIN = 4 * DPR + (2.5 * DPR) * 8 + 0.25 * 3 + 8 * DPR;
/** The BORDER-only pipeline's margin: frost*d + 8*d. A border fragment's only backdrop tap is
 *  the border zone's own inward `bUv`, so it needs nothing of the refraction reach. */
const RIM_MARGIN = 4 * DPR + 8 * DPR;

const CardBox = (i: number): BackdropRect => {
  const col = i % 5, row = (i / 5) | 0;
  return { x: (60 + col * 236) * DPR, y: (70 + row * 170) * DPR, w: 216 * DPR, h: 150 * DPR };
};

const RegionFor = (b: BackdropRect, margin: number): BackdropRect => ({
  x: Math.max(0, Math.floor(b.x - margin)),
  y: Math.max(0, Math.floor(b.y - margin)),
  w: Math.min(CANVAS_W, Math.ceil(b.w + margin * 2)),
  h: Math.min(CANVAS_H, Math.ceil(b.h + margin * 2)),
});

/** The level-0 size `Blur` will resolve a region to — its own arithmetic, not a second copy. */
const Level0 = (region: BackdropRect): { W: number; H: number } => {
  const k = BaseDownsampleFactor(RADIUS, CANVAS_W, CANVAS_H, region);
  const depth = PyramidDepth(RADIUS / k, 0);
  const rect = ResolveRegionRect(region, CANVAS_W, CANVAS_H, k * (1 << depth));
  return { W: rect.W, H: rect.H };
};

const FILL_REGION = RegionFor(CardBox(0), FILL_MARGIN);
const RIM_REGION = RegionFor(CardBox(0), RIM_MARGIN);

// ── Harness ──

interface Rig { Gl: FakeGl; Pass: BlurPass; Src: object }

const Rig = (chains: number): Rig => {
  const gl = new FakeGl();
  const pass = new BlurPass(gl.Gl, undefined, chains);
  const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
  return { Gl: gl, Pass: pass, Src: src };
};

/** One build, recorded in isolation: the texture it handed back and everything it wrote. */
const Build = (r: Rig, region: BackdropRect, maxLod?: number): {
  Tex: object; Texels: string[]; Draws: number; Region: string; Depth: number;
} => {
  r.Gl.Reset();
  const tex = r.Pass.Blur(r.Src as WebGLTexture, CANVAS_W, CANVAS_H, RADIUS, 0, region);
  if (maxLod !== undefined) r.Pass.GenerateOutputMipmap(maxLod);
  return {
    Tex: tex,
    Texels: r.Gl.Texels,
    Draws: r.Gl.Calls.filter(c => c === 'drawElements').length,
    Region: JSON.stringify(r.Pass.LastRegion),
    Depth: r.Pass.LastDepth,
  };
};

let _trace: string[] = [];
beforeEach(() => { _trace = []; OnJauiTrace(n => { _trace.push(n); }); });
afterEach(() => { OnJauiTrace(null); });

// ── The geometry the whole hypothesis rests on ──

describe('two size classes, forty builds', () => {
  it('resolves the fill pipeline to 568x436', () => {
    expect(Level0(FILL_REGION)).toEqual({ W: 568, H: 436 });
  });

  it('resolves the border pipeline to 480x348 — the size the docstring used to name 484x352', () => {
    expect(Level0(RIM_REGION)).toEqual({ W: 480, H: 348 });
  });

  it('puts all twenty cards on the same two sizes, which is why two chains carry forty builds', () => {
    const sizes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const fill = Level0(RegionFor(CardBox(i), FILL_MARGIN));
      const rim = Level0(RegionFor(CardBox(i), RIM_MARGIN));
      sizes.add(`${fill.W}x${fill.H}`);
      sizes.add(`${rim.W}x${rim.H}`);
    }
    expect([...sizes].sort()).toEqual(['480x348', '568x436']);
  });
});

// ── What the budget admits ──

describe('the budget, on glass-grid', () => {
  const FILL = ChainBytes(568, 436);
  const RIM = ChainBytes(480, 348);

  it('holds 2.64 MB at N=1, 5.27 at N=2 and 7.91 at N=3', () => {
    expect(FILL).toBe(1650987);
    expect(RIM).toBe(1113600);
    const mib = (n: number): number => Math.round((n * (FILL + RIM) / (1024 * 1024)) * 100) / 100;
    expect(mib(1)).toBe(2.64);
    expect(mib(2)).toBe(5.27);
    expect(mib(3)).toBe(7.91);
  });

  it('is capped by MAX_CHAINS, not by bytes: the largest N glass-grid admits is 3', () => {
    // Two size classes x N chains, against the pool's two ceilings.
    const fitsChains = (n: number): boolean => 2 * n <= MAX_CHAINS;
    const fitsBytes = (n: number): boolean => n * (FILL + RIM) <= CHAIN_BUDGET_BYTES;
    expect([1, 2, 3].every(n => fitsChains(n) && fitsBytes(n))).toBe(true);
    expect(fitsChains(4)).toBe(false);
    // The 48 MB budget on its own would admit eighteen, so the cap is what binds.
    expect(fitsBytes(18)).toBe(true);
    expect(fitsBytes(19)).toBe(false);
  });
});

// ── The flag's own edges ──

describe('the constructor', () => {
  it('takes 1 by default — every shipping path', () => {
    const r = Rig(1);
    expect(r.Pass.ChainCensus.Asked).toBe(1);
    expect(new BlurPass(new FakeGl().Gl).ChainCensus.Asked).toBe(1);
  });

  it('throws rather than clamps an N outside 1..MAX_CHAINS', () => {
    for (const n of [0, -1, 1.5, MAX_CHAINS + 1, NaN]) {
      expect(() => new BlurPass(new FakeGl().Gl, undefined, n)).toThrow(/chains must be an integer/);
    }
  });
});

// ── N = 1 is the pool as shipped ──

describe('N=1', () => {
  it('lands every build of a size on the one chain, and reallocates nothing after the first', () => {
    const r = Rig(1);
    const a = Build(r, FILL_REGION);
    r.Gl.Reset();
    const b = Build(r, FILL_REGION);
    expect(b.Tex).toBe(a.Tex);
    expect(r.Pass.ChainCensus).toMatchObject({ Asked: 1, Live: 1, Resident: 1, Sizes: '568x436#1' });
    // The second build resizes nothing: `Framebuffer.Resize` is a no-op at the same size.
    expect(r.Gl.Calls).not.toContain('texImage2D');
  });

  it('keeps one chain per size, which is the two-chains-for-forty-builds cell', () => {
    const r = Rig(1);
    for (let i = 0; i < 20; i++) {
      Build(r, RegionFor(CardBox(i), FILL_MARGIN));
      Build(r, RegionFor(CardBox(i), RIM_MARGIN));
    }
    expect(r.Pass.ChainCensus).toMatchObject({ Live: 1, Resident: 2, Refused: null });
  });
});

// ── The claim the flag rests on ──

describe('N>1 is pixel-identical', () => {
  it('runs two identical builds on DIFFERENT chains and they write identical texels', () => {
    const r = Rig(2);
    const a = Build(r, FILL_REGION);
    const b = Build(r, FILL_REGION);
    // Different chains: the two builds hand back different textures.
    expect(b.Tex).not.toBe(a.Tex);
    expect(r.Pass.ChainCensus.Resident).toBe(2);
    // Not vacuous: a build that wrote nothing would satisfy every line below it.
    expect(a.Draws).toBe(4);            // down x2, up x2, at depth 2
    expect(a.Texels.length).toBe(4);
    // Identical texels: every write, in order, at the same size and the same value.
    expect(b.Texels).toEqual(a.Texels);
    expect(b.Draws).toBe(a.Draws);
    // And identical everything the consumer reads off the handle.
    expect(b.Region).toBe(a.Region);
    expect(b.Depth).toBe(a.Depth);
    expect(r.Gl.ValueOf(b.Tex)).toBe(r.Gl.ValueOf(a.Tex));
  });

  it('holds through the mip chain a glass consumer actually samples', () => {
    const r = Rig(2);
    const a = Build(r, FILL_REGION, 3);
    const b = Build(r, FILL_REGION, 3);
    expect(b.Tex).not.toBe(a.Tex);
    expect(b.Texels).toEqual(a.Texels);
    // Every mip slot a `textureLod` up to 3 can reach is written by the build that hands the
    // texture over, so the level the consumer samples is this build's and never a neighbour's.
    for (let lod = 0; lod <= 4; lod++) {
      expect(r.Gl.ValueOf(b.Tex, lod)).toBe(r.Gl.ValueOf(a.Tex, lod));
    }
  });

  it('is a comparison with teeth — a build with different inputs does NOT match', () => {
    // The negative control for the two tests above. `Texels` drops the texture IDENTITY, which is
    // the only thing rotating changes; it keeps the value, which is a pure function of program,
    // uniforms, source and size. Change one of those and the comparison has to notice.
    const r = Rig(2);
    const a = Build(r, FILL_REGION);
    const b = Build(r, RegionFor(CardBox(3), FILL_MARGIN));
    expect(b.Texels.length).toBe(a.Texels.length);
    expect(b.Texels).not.toEqual(a.Texels);
  });

  it('writes every level a consumer can reach, so no chain ever hands over a neighbour mip', () => {
    // The one place a chain COULD carry state: `EnsureMipLevels` pins TEXTURE_MAX_LEVEL to a high
    // water mark, so a chain reused at a shallower maxLod keeps deeper levels from an older build.
    // It is unreachable because `stopLevel` is `ceil(maxLod) + 1` and every level up to it is
    // written by this build, which is one level past the deepest a trilinear tap at maxLod reads.
    const deep = Rig(1);
    Build(deep, FILL_REGION, 6);
    const shallow = Build(deep, FILL_REGION, 2);
    for (let lod = 0; lod <= 3; lod++) {
      expect(deep.Gl.ValueOf(shallow.Tex, lod)).not.toBe('unallocated');
      expect(shallow.Texels.some(t => t.startsWith(`blit ${lod} `)) || lod === 0).toBe(true);
    }
    // And on a fresh chain the same build reaches exactly as far.
    const rot = Rig(2);
    Build(rot, FILL_REGION, 2);
    const second = Build(rot, FILL_REGION, 2);
    expect(second.Tex).not.toBe(shallow.Tex);
    for (let lod = 0; lod <= 3; lod++) {
      expect(rot.Gl.ValueOf(second.Tex, lod)).not.toBe('unallocated');
    }
  });

  it('adds no pass, no draw and no allocation to a build', () => {
    const one = Rig(1);
    const two = Rig(2);
    Build(one, FILL_REGION, 3);
    Build(two, FILL_REGION, 3);
    // Second build of each: both pools are warm, so this is the steady state.
    const a = Build(one, FILL_REGION, 3);
    const b = Build(two, FILL_REGION, 3);
    expect(b.Draws).toBe(a.Draws);
    expect(b.Texels.length).toBe(a.Texels.length);
    expect(b.Texels.map(t => t.split(' ').slice(0, 3).join(' ')))
      .toEqual(a.Texels.map(t => t.split(' ').slice(0, 3).join(' ')));
  });
});

// ── The rotation itself ──

describe('the rotation', () => {
  it('cycles a size class with period N and never gives two consecutive builds one chain', () => {
    const r = Rig(2);
    const seen = [0, 1, 2, 3].map(() => Build(r, FILL_REGION).Tex);
    expect(seen[1]).not.toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
    expect(seen[3]).toBe(seen[1]);
    expect(r.Pass.ChainCensus).toMatchObject({ Asked: 2, Live: 2, Resident: 2, Refused: null });
  });

  it('rotates each size class on its own phase across a whole glass-grid frame', () => {
    const r = Rig(2);
    const fill: object[] = [];
    const rim: object[] = [];
    for (let i = 0; i < 20; i++) {
      fill.push(Build(r, RegionFor(CardBox(i), FILL_MARGIN)).Tex);
      rim.push(Build(r, RegionFor(CardBox(i), RIM_MARGIN)).Tex);
    }
    // Forty builds, four chains — two per size — and no eviction anywhere in the frame.
    expect(r.Pass.ChainCensus).toMatchObject({
      Asked: 2, Live: 2, Resident: 4, Sizes: '568x436#2+480x348#2', Refused: null,
    });
    for (let i = 1; i < 20; i++) {
      expect(fill[i]).not.toBe(fill[i - 1]);
      expect(rim[i]).not.toBe(rim[i - 1]);
    }
    expect(new Set(fill).size).toBe(2);
    expect(new Set(rim).size).toBe(2);
    // The two size classes never share a chain with each other either.
    expect(new Set([...fill, ...rim]).size).toBe(4);
    expect(_trace.filter(t => t.includes('refused'))).toEqual([]);
  });

  it('reaches N=3 on glass-grid, which is what the cap admits', () => {
    const r = Rig(3);
    for (let i = 0; i < 20; i++) {
      Build(r, RegionFor(CardBox(i), FILL_MARGIN));
      Build(r, RegionFor(CardBox(i), RIM_MARGIN));
    }
    expect(r.Pass.ChainCensus).toMatchObject({ Live: 3, Resident: 6, Refused: null });
  });
});

// ── Refusal ──

describe('an N the pool cannot hold', () => {
  it('stops rotating and names itself on the trace rather than evicting', () => {
    // Three size classes at N=3 wants nine chains against a cap of six.
    const r = Rig(3);
    const sizes = [FILL_MARGIN, RIM_MARGIN, 40, 80, 120];
    for (const m of sizes) for (let k = 0; k < 3; k++) Build(r, RegionFor(CardBox(0), m));
    const census = r.Pass.ChainCensus;
    expect(census.Asked).toBe(3);
    expect(census.Live).toBe(1);
    expect(census.Refused).not.toBeNull();
    const line = _trace.find(t => t.startsWith('jaui:blur-chains') && t.includes('refused='));
    expect(line).toBeDefined();
    expect(line).toContain('armed=3');
    expect(line).toContain('effective=1');
    expect(line).toContain(`max=${MAX_CHAINS}`);
  });

  it('says it once, however many builds follow', () => {
    const r = Rig(3);
    for (const m of [FILL_MARGIN, RIM_MARGIN, 40, 80, 120]) {
      for (let k = 0; k < 6; k++) Build(r, RegionFor(CardBox(0), m));
    }
    expect(_trace.filter(t => t.includes('refused=')).length).toBe(1);
  });

  it('keeps drawing after it refuses — slot 0 is the shipped pool and always exists', () => {
    const r = Rig(3);
    for (const m of [FILL_MARGIN, RIM_MARGIN, 40, 80, 120]) {
      for (let k = 0; k < 3; k++) Build(r, RegionFor(CardBox(0), m));
    }
    expect(r.Pass.ChainCensus.Live).toBe(1);
    const a = Build(r, FILL_REGION);
    const b = Build(r, FILL_REGION);
    expect(b.Tex).toBe(a.Tex);
    expect(b.Texels).toEqual(a.Texels);
  });
});
