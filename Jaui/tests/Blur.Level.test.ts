import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BlurPass, PlanReadLevel, ReadLevelCost, READ_LEVEL_EPS, type BackdropRect, type ReadLevelPlan,
} from '../src/Core/BlurPass';
import { FakeGl } from './Blur.Chains.Source';

/**
 * `?blur-level` -- a glass rim that reads ONE constant LOD gets that level, not a pyramid.
 *
 * The phone's home page ran three `chain:a2@k1d1t0.7>s1.25` builds a frame. They are not pblur:
 * pblur builds at radius 0 on the `root` pass. They are the `CardGlass` rims (Surface.jss, extends
 * `JwiftSolidGlass`): no frost, so the radius floors at 1pt x dpr 2, and `BorderFilter: Blur(4pt)`,
 * a LOD offset of 4 that the rim reads at every fragment. These tests pin the shader facts that make
 * the read constant, the plan's arithmetic at the phone's geometry, the GL stream on both arms, and
 * the size of the picture change on a CPU port of the two kernels.
 */

// ── The phone: 420x713 css at dpr 2, a full-width card rim. ──
const W = 840;
const H = 1426;
const RADIUS = 2;             // max(1, 0 frost) * dpr 2
const LOD = 4;                // BorderFilter: Blur(4pt)
/** `_glassRimBlurPlan`'s margin at frost 1pt, dpr 2: frost*d + 8*d. */
const RIM_MARGIN = 1 * 2 + 8 * 2;
const CARD: BackdropRect = { x: 32, y: 300, w: 776, h: 366 };
const REGION: BackdropRect = {
  x: Math.max(0, Math.floor(CARD.x - RIM_MARGIN)),
  y: Math.max(0, Math.floor(CARD.y - RIM_MARGIN)),
  w: Math.min(W, Math.ceil(CARD.w + RIM_MARGIN * 2)),
  h: Math.min(H, Math.ceil(CARD.h + RIM_MARGIN * 2)),
};

const ok = (p: ReturnType<typeof PlanReadLevel>): ReadLevelPlan => {
  if (!p.Ok) throw new Error(`refused: ${p.Why}`);
  return p;
};

describe('the proof the walk relies on is still the shader', () => {
  const frag = readFileSync(fileURLToPath(new URL('../src/Jiv/Shaders/Jiv.Panel.frag', import.meta.url)), 'utf8');

  it('reads the border tap at lodBoost + BorderBackdropBlur', () => {
    expect(frag).toContain('float bLod = max(0.0, lodBoost + v_BorderFilter.w);');
    expect(frag).toContain('vec3 bSample = sampleBackdrop(bUv, bLod, frostLod);');
  });

  it('multiplies every lodBoost term by frostReq, which is 0 at an instance frost of 0', () => {
    expect(frag).toContain('float frostReq = clamp((frostLod - u_BaseFrostLod) * 4.0, 0.0, 1.0);');
    expect(frag).toMatch(/lodBoost = \(\(rimBoost \* 1\.5 \+ innerBlur \* 1\.0\) \* glassiness \+ refractLod\) \* frostReq;/);
    // Exactly one assignment besides the zero it starts at, so no other term can reach it.
    expect(frag.match(/\blodBoost\s*=/g)?.length).toBe(2);
  });

  it('sends a zero-frost, zero-extra tap to u_Scene, not the pyramid', () => {
    expect(frag).toContain('if (frostLod < 0.01 && extraLod < 0.01) return texture(u_Scene, uv).rgb;');
    expect(frag).toContain('float lod = max(0.0, frostLod - u_BaseFrostLod) + extraLod;');
  });
});

describe('PlanReadLevel', () => {
  it('admits the phone card rim: k1 d1 at the chain tap offset, levels 3..5 around LOD 4', () => {
    const p = ok(PlanReadLevel(RADIUS, W, H, REGION, LOD));
    expect(p.TapOffset).toBe(0.7);
    expect(p.Lo).toBe(3);
    expect(p.Stop).toBe(5);
    expect(p.Rect).toEqual({ X: 14, YBottom: 742, W: 812, H: 402, Full: false });
    expect(p.W).toEqual([812, 406, 203, 101, 50, 25]);
    expect(p.H).toEqual([402, 201, 100, 50, 25, 12]);
  });

  it('reaches both neighbours of a non-integer LOD and stays off level 0', () => {
    const p = ok(PlanReadLevel(RADIUS, W, H, REGION, 3.72));
    expect([p.Lo, p.Stop]).toEqual([3, 5]);
    const q = ok(PlanReadLevel(RADIUS, W, H, REGION, 1 + 2 * READ_LEVEL_EPS));
    expect([q.Lo, q.Stop]).toEqual([1, 3]);
  });

  it('refuses by name everything the identity does not cover', () => {
    const why = (r: number, reg: BackdropRect | undefined, lod: number): string => {
      const p = PlanReadLevel(r, W, H, reg, lod);
      return p.Ok ? 'ok' : p.Why;
    };
    expect(why(0, REGION, LOD)).toBe('root');
    expect(why(RADIUS, undefined, LOD)).toBe('full-canvas');
    expect(why(RADIUS, { x: 0, y: 0, w: W, h: H }, LOD)).toBe('full-canvas');
    expect(why(RADIUS, REGION, 1)).toBe('lod-under-1');
    expect(why(RADIUS, REGION, 0)).toBe('lod-under-1');
    expect(why(8, { x: 100, y: 100, w: 300, h: 200 }, LOD)).toBe('depth2');
    expect(why(8, REGION, LOD)).toBe('k2');                           // 27% of the canvas re-bases first
    expect(why(3, REGION, LOD)).toBe('ok');                         // dpr 3: still depth 1
    expect(why(24, { x: 0, y: 0, w: W, h: 800 }, LOD)).toBe('k4');
    expect(why(RADIUS, { x: 100, y: 100, w: 30, h: 30 }, 6)).toMatch(/^1x1-before-level/);
  });
});

describe('ReadLevelCost, the phone card rim', () => {
  const c = ReadLevelCost(ok(PlanReadLevel(RADIUS, W, H, REGION, LOD)));
  const A = 812 * 402;
  const HOPS = 406 * 201 + 203 * 100 + 101 * 50 + 50 * 25 + 25 * 12;

  it('the chain side is the Down/Up pair plus five hops and five blits', () => {
    expect(c.Chain.Passes).toBe(7);
    expect(c.Chain.Fill).toBe(406 * 201 + A + HOPS);
    expect(c.Chain.Reads).toBe(406 * 201 * 5 + A * 8 + HOPS * 5);
    expect(c.Chain.Blit).toBe(HOPS);
  });

  it('the level side is five hops and three blits, and the Up pass is gone', () => {
    expect(c.Level.Passes).toBe(5);
    expect(c.Level.Fill).toBe(HOPS);
    expect(c.Level.Reads).toBe(HOPS * 5);
    expect(c.Level.Blit).toBe(101 * 50 + 50 * 25 + 25 * 12);
    // Fill / 4.76, reads / 6.57: the Up pass was 63% of the fill and 73% of the reads.
    expect(Math.round(c.Chain.Fill / c.Level.Fill * 100) / 100).toBe(4.76);
    expect(Math.round(c.Chain.Reads / c.Level.Reads * 100) / 100).toBe(6.57);
  });
});

// ── The GL stream, on the recording stand-in. ──

const rig = (): { Gl: FakeGl; Pass: BlurPass; Src: WebGLTexture } => {
  const gl = new FakeGl();
  const pass = new BlurPass(gl.Gl, undefined, 1);
  return { Gl: gl, Pass: pass, Src: gl.MakeSource(W, H, 'scene') as unknown as WebGLTexture };
};

describe('the level build against today\'s build', () => {
  const today = rig();
  today.Gl.Reset();
  const todayTex = today.Pass.Blur(today.Src, W, H, RADIUS, 0, REGION);
  today.Pass.GenerateOutputMipmap(LOD);
  const todayWrites = today.Gl.Writes.slice();
  const todayRegion = JSON.stringify(today.Pass.LastRegion);

  const lvl = rig();
  const plan = ok(PlanReadLevel(RADIUS, W, H, REGION, LOD));
  lvl.Gl.Reset();
  const lvlTex = lvl.Pass.BlurReadLevel(lvl.Src, W, H, RADIUS, plan);
  const lvlWrites = lvl.Gl.Writes.slice();

  it('today: Down, Up, five mip hops and five blits', () => {
    expect(todayWrites.filter(w => w.Kind === 'draw').map(w => `${w.W}x${w.H}`))
      .toEqual(['406x201', '812x402', '406x201', '203x100', '101x50', '50x25', '25x12']);
    expect(todayWrites.filter(w => w.Kind === 'blit').map(w => w.Level)).toEqual([1, 2, 3, 4, 5]);
  });

  it('level: the SAME first write, then four hops and blits of 3..5 only', () => {
    expect(lvlWrites[0]).toEqual(todayWrites[0]);
    expect(lvlWrites.filter(w => w.Kind === 'draw').map(w => `${w.W}x${w.H}`))
      .toEqual(['406x201', '203x100', '101x50', '50x25', '25x12']);
    expect(lvlWrites.filter(w => w.Kind === 'blit').map(w => w.Level)).toEqual([3, 4, 5]);
  });

  it('never writes the output\'s level 0 or the levels below the read', () => {
    const outId = (lvlTex as unknown as { Id: number }).Id;
    expect(lvlWrites.filter(w => w.Tex === outId).map(w => w.Level)).toEqual([3, 4, 5]);
  });

  it('hands back level 0\'s texture with the chain\'s map, so the consumer\'s transform is unchanged', () => {
    expect(JSON.stringify(lvl.Pass.LastRegion)).toBe(todayRegion);
    expect((lvlTex as unknown as { Id: number }).Id).toBeGreaterThan(0);
    expect((todayTex as unknown as { Id: number }).Id).toBeGreaterThan(0);
  });

  it('books a level build in the census currency', () => {
    const b = lvl.Pass.LastBuild;
    expect(b.Plan).toBe('level');
    expect(b.Passes).toBe(5);
    expect(b.Fill).toBe(406 * 201 + 203 * 100 + 101 * 50 + 50 * 25 + 25 * 12);
    expect(lvl.Pass.LastDepth).toBe(1);
  });
});

// ── The picture change, on a CPU port of DOWN_FRAG and UP_FRAG. ──

type Img = { D: Float64Array; W: number; H: number };
const at = (m: Img, i: number, j: number): number =>
  m.D[Math.min(m.H - 1, Math.max(0, j)) * m.W + Math.min(m.W - 1, Math.max(0, i))];
/** Bilinear at texel coords (centres at n + 0.5), CLAMP_TO_EDGE. */
const bil = (m: Img, x: number, y: number): number => {
  const fx = x - 0.5, fy = y - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
  return (1 - ay) * ((1 - ax) * at(m, x0, y0) + ax * at(m, x0 + 1, y0))
    + ay * ((1 - ax) * at(m, x0, y0 + 1) + ax * at(m, x0 + 1, y0 + 1));
};
const q10 = (m: Img): Img => ({ ...m, D: m.D.map(v => Math.round(Math.min(1, Math.max(0, v)) * 1023) / 1023) });
const down = (m: Img, t: number): Img => {
  const w = m.W >> 1, h = m.H >> 1, o = new Float64Array(w * h), a = 0.5 * t;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = (i + 0.5) * m.W / w, y = (j + 0.5) * m.H / h;
      o[j * w + i] = (4 * bil(m, x, y) + bil(m, x - a, y - a) + bil(m, x + a, y + a)
        + bil(m, x + a, y - a) + bil(m, x - a, y + a)) / 8;
    }
  }
  return { D: o, W: w, H: h };
};
const up = (m: Img, w2: number, h2: number, t: number): Img => {
  const o = new Float64Array(w2 * h2), a = 0.5 * t;
  for (let j = 0; j < h2; j++) {
    for (let i = 0; i < w2; i++) {
      const x = (i + 0.5) * m.W / w2, y = (j + 0.5) * m.H / h2;
      o[j * w2 + i] = (bil(m, x - 2 * a, y) + 2 * bil(m, x - a, y + a) + bil(m, x, y + 2 * a)
        + 2 * bil(m, x + a, y + a) + bil(m, x + 2 * a, y) + 2 * bil(m, x + a, y - a)
        + bil(m, x, y - 2 * a) + 2 * bil(m, x - a, y - a)) / 12;
    }
  }
  return { D: o, W: w2, H: h2 };
};
const hops = (m: Img, n: number): Img => { let r = m; for (let k = 0; k < n; k++) r = q10(down(r, 1.0)); return r; };
const box = (m: Img, s: number): Img => {
  const w = m.W / s, h = m.H / s, o = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let v = 0; v < s; v++) for (let u = 0; u < s; u++) sum += m.D[(j * s + v) * m.W + i * s + u];
      o[j * w + i] = sum / (s * s);
    }
  }
  return { D: o, W: w, H: h };
};
/** Level 4 both ways: today's box16(Up(Down(S))) and the plan's box8(Down(S)). Max / mean in 8-bit. */
const level4 = (s: Img): { Max: number; Mean: number } => {
  const l1 = q10(down(s, 0.7));
  const today = hops(q10(up(l1, s.W, s.H, 0.7)), 4);
  const plan = hops(l1, 3);
  let max = 0, sum = 0;
  for (let i = 0; i < today.D.length; i++) {
    const d = Math.abs(today.D[i] - plan.D[i]) * 255;
    max = Math.max(max, d);
    sum += d;
  }
  return { Max: max, Mean: sum / today.D.length };
};
const make = (w: number, h: number, f: (i: number, j: number) => number): Img => {
  const d = new Float64Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) d[j * w + i] = f(i, j);
  return { D: d, W: w, H: h };
};
let seed = 1;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

describe('the picture change, on the port', () => {
  it('a Down hop at t = 0.7 IS a 2x2 box, so the plan\'s level i is box(2^i) of the region', () => {
    seed = 7;
    const s = make(64, 32, () => rnd());
    const d = down(s, 0.7), b = box(s, 2);
    let worst = 0;
    for (let i = 0; i < d.D.length; i++) worst = Math.max(worst, Math.abs(d.D[i] - b.D[i]));
    expect(worst).toBeLessThan(1e-12);
  });

  it('moves level 4 by under one 8-bit level on average, and by at most ~12 on a worst-case text raster', () => {
    seed = 1;
    const cases = {
      noise: level4(make(256, 128, () => rnd())),
      photo: level4(make(256, 128, (i, j) => 0.5 + 0.3 * Math.sin(i / 7) * Math.cos(j / 11) + 0.1 * rnd())),
      gradient: level4(make(256, 128, i => i / 256)),
      edgeOnGrid: level4(make(256, 128, i => (i < 136 ? 0.9 : 0.05))),
      edgeOnCell: level4(make(256, 128, i => (i < 128 ? 0.9 : 0.05))),
      text: level4(make(256, 128, (i, j) => ((i % 6) < 3 && (j % 9) < 6 ? 1 : 0.05))),
    };
    expect(cases.gradient.Max).toBeLessThan(0.5);
    expect(cases.edgeOnGrid.Max).toBe(0);            // an edge inside a 16px cell: the box absorbs it
    expect(cases.photo.Mean).toBeLessThan(0.6);
    expect(cases.noise.Mean).toBeLessThan(0.8);
    expect(cases.noise.Max).toBeLessThan(2.5);
    expect(cases.edgeOnCell.Max).toBeLessThan(6);
    expect(cases.text.Max).toBeLessThan(12);
    expect(cases.text.Max).toBeGreaterThan(8);        // the worst case is real and is reported, not hidden
  });
});
