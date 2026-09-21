import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlurPass, GaussianKernelFor, PlanGaussianTemp, PyramidDepth, ResolveRegionRect,
  GAUSS_MATCH_SIGMA, type BackdropRect, type GaussianKernel,
} from '../src/Core/BlurPass';
import { CoverGl, SOURCE, type CoverDraw } from './Gaussian.Cover.Source';
import { arrowBody } from './Scene.ReadAfterWrite.Source';

/**
 * `?glass-gaussian=match` rendered differently ONE SHOT IN FOUR on the M4 (10 px, max channel delta
 * 75, x 849-2265 y 720-1064). The brief's candidate: a texel of the DontCare temp the V pass reads
 * and the H pass never wrote. This file drives the REAL pass on a texel-exact recording GL
 * (`Gaussian.Cover.Source.ts`) and takes the brief's four candidates in its order.
 *
 * THE VERDICT, stated before the tests that carry it: on the recording GL NONE of the four
 * reproduces -- not on today's code and not on the fix. Every texel either Gaussian pass reads was
 * written by the pass immediately before it, for all twenty fill and twenty rim regions of
 * `glass-grid`, both arms, both dprs, and a sweep of regions against every canvas edge. The fix
 * below is the brief's step 2 (the clamp moved from the WRITE into the READ, so the temp's cover is
 * a construction rather than a consequence) and it changes no uniform, no size and no draw on
 * `glass-grid`. Section 5 says why the observed defect's FOOTPRINT also rules the temp out, and
 * what the orchestrator should shoot (`?gauss-debug`) to find it on the GPU in one shot.
 */

const PASS = readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8').replace(/\r\n/g, '\n');
const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');

const CANVAS_W = 2560, CANVAS_H = 1600;

/** glass-grid's geometry at a dpr, exactly as `Glass.Gaussian.test.ts` pins it at dpr 2. */
const Grid = (dpr: number): { Fill: BackdropRect[]; Rim: BackdropRect[]; W: number; H: number; Radius: number } => {
  const w = Math.round(1280 * dpr), h = Math.round(800 * dpr);
  const fillMargin = 4 * dpr + (2.5 * dpr) * 8 + 0.25 * 3 + 8 * dpr;
  const rimMargin = 4 * dpr + 8 * dpr;
  const box = (i: number): BackdropRect => {
    const col = i % 5, row = (i / 5) | 0;
    return { x: (60 + col * 236) * dpr, y: (70 + row * 170) * dpr, w: 216 * dpr, h: 150 * dpr };
  };
  const region = (b: BackdropRect, m: number): BackdropRect => ({
    x: Math.max(0, Math.floor(b.x - m)), y: Math.max(0, Math.floor(b.y - m)),
    w: Math.min(w, Math.ceil(b.w + m * 2)), h: Math.min(h, Math.ceil(b.h + m * 2)),
  });
  const cards = Array.from({ length: 20 }, (_, i) => box(i));
  return {
    Fill: cards.map((b) => region(b, fillMargin)), Rim: cards.map((b) => region(b, rimMargin)),
    W: w, H: h, Radius: 4 * dpr,
  };
};

interface Rig { Gl: CoverGl; Pass: BlurPass; Src: object }
const Rig = (w: number, h: number): Rig => {
  const gl = new CoverGl();
  const pass = new BlurPass(gl.Gl, undefined, 1);
  pass.EnsureGaussianProgram();
  return { Gl: gl, Pass: pass, Src: gl.MakeSource(w, h) };
};
const Build = (
  r: Rig, w: number, h: number, radius: number, region: BackdropRect, mode: 'on' | 'match',
): CoverDraw[] => {
  const from = r.Gl.Draws.length;
  r.Pass.Blur(r.Src as WebGLTexture, w, h, radius, 0, region, undefined, false, mode);
  return r.Gl.Draws.slice(from);
};

afterEach(() => { BlurPass.GaussDebugMagenta = false; });

// ── 1. CANDIDATES (a) AND (b): THE V PASS READS NOTHING THE H PASS DID NOT WRITE ──────────────

describe('glass-gaussian cover > every texel the V pass reads, the H pass wrote', () => {
  for (const dpr of [2, 1.5]) {
    for (const mode of ['match', 'on'] as const) {
      it(`glass-grid at dpr ${dpr}, ${mode}: all forty builds, in walk order, read nothing stale`, () => {
        const g = Grid(dpr);
        const r = Rig(g.W, g.H);
        for (let i = 0; i < 20; i++) {
          for (const region of [g.Fill[i], g.Rim[i]]) {
            const [h, v] = Build(r, g.W, g.H, g.Radius, region, mode);
            expect(h.Gaussian && v.Gaussian).toBe(true);
            expect(h.GarbageReads + h.StaleReads).toBe(0);
            expect(v.GarbageReads + v.StaleReads).toBe(0);
            // The V pass reads the temp the H pass JUST wrote, and every texel of both targets
            // belongs to the pass that last drew into it.
            expect(v.Src).toBe(h.Dst);
            expect(r.Gl.Unwritten(h.Dst)).toBe(0);
            expect(r.Gl.Unwritten(v.Dst)).toBe(0);
          }
        }
      });
    }
  }

  it('NEGATIVE CONTROL: a temp viewport one row short IS caught -- the instrument is not vacuous', () => {
    const g = Grid(2);
    const r = Rig(g.W, g.H);
    Build(r, g.W, g.H, g.Radius, g.Fill[6], 'match');   // card 6's pass leaves the temp whole
    // Now card 7's H pass writes all but the temp's top row: the rows the V pass's upper taps
    // reach for the region's last output rows are left holding DontCare garbage.
    r.Gl.ViewportHook = ([x, y, w, h]) => (h === 454 ? [x, y, w, h - 1] : [x, y, w, h]);
    const [h, v] = Build(r, g.W, g.H, g.Radius, g.Fill[7], 'match');
    expect(h.Dst).toBe(v.Src);
    expect(r.Gl.Unwritten(h.Dst)).toBe(568);
    expect(v.GarbageReads).toBe(568);
  });

  it('the V pass addresses EXACTLY the temp: its read rows are 0..H-1 and its columns 0..W-1', () => {
    const g = Grid(2);
    const r = Rig(g.W, g.H);
    const [h, v] = Build(r, g.W, g.H, g.Radius, g.Fill[7], 'match');
    expect(v.Rows).toEqual([0, h.DstH - 1]);
    expect(v.Cols).toEqual([0, h.DstW - 1]);
  });

  it('(b) the kernel never reaches past the pad: reach == Radius == pad, for every sigma a card can author', () => {
    for (let sigma = 0.5; sigma <= 20.5; sigma += 0.25) {
      const k = GaussianKernelFor(sigma);
      const t = PlanGaussianTemp({ YBottom: 100, W: 64, H: 64 }, k);
      expect(t.Ok).toBe(true);
      if (!t.Ok) continue;
      expect(t.Reach).toBe(k.Radius);
      expect(t.PadBelow).toBe(k.Radius);
      expect(t.Written).toBe(t.Readable);
    }
    // At the arm's own sigma: R = ceil(3 * 2.7988) = 9, and the pad is 9 on both sides.
    const m = GaussianKernelFor(GAUSS_MATCH_SIGMA);
    expect(m.Radius).toBe(9);
    const t = PlanGaussianTemp({ YBottom: 400, W: 568, H: 436 }, m);
    expect(t.Ok && [t.W, t.H, t.PadBelow]).toEqual([568, 454, 9]);
  });
});

// ── 2. THE FIX: THE CANVAS-EDGE CLAMP IS IN THE READ, NOT IN THE WRITE ─────────────────────────

describe('glass-gaussian cover > the canvas edge clamps the READ, and the temp is always padded whole', () => {
  const k = GaussianKernelFor(GAUSS_MATCH_SIGMA);
  const phase = 1 << PyramidDepth(8, 0);
  // Regions against every edge: bottom (y near the canvas top in screen space is the TOP in GL),
  // top, left, right, and one taller than the canvas allows padding for on either side.
  const EDGES: BackdropRect[] = [
    { x: 100, y: 0, w: 568, h: 436 },
    { x: 100, y: CANVAS_H - 436, w: 568, h: 436 },
    { x: 0, y: 500, w: 568, h: 436 },
    { x: CANVAS_W - 568, y: 500, w: 568, h: 436 },
    { x: 0, y: 0, w: 568, h: 436 },
    { x: 0, y: 3, w: 200, h: CANVAS_H - 6 },
  ];

  it('an edge region is padded like any other: one temp size for every card of one size', () => {
    const edge = PlanGaussianTemp(ResolveRegionRect(EDGES[0], CANVAS_W, CANVAS_H, phase), k);
    const mid = PlanGaussianTemp(ResolveRegionRect({ x: 100, y: 500, w: 568, h: 436 }, CANVAS_W, CANVAS_H, phase), k);
    expect(edge.Ok && mid.Ok).toBe(true);
    if (!edge.Ok || !mid.Ok) return;
    expect([edge.W, edge.H, edge.PadBelow]).toEqual([mid.W, mid.H, mid.PadBelow]);
  });

  it('...so the H pass addresses scene rows off the canvas, and the sampler clamps them', () => {
    const rect = ResolveRegionRect(EDGES[1], CANVAS_W, CANVAS_H, phase);
    expect(rect.YBottom).toBe(0);
    const t = PlanGaussianTemp(rect, k);
    expect(t.Ok && t.Y0).toBe(-9);
  });

  for (const region of EDGES) {
    it(`edge region ${JSON.stringify(region)}: nothing stale read, both targets written whole`, () => {
      const r = Rig(CANVAS_W, CANVAS_H);
      const draws = Build(r, CANVAS_W, CANVAS_H, 8, region, 'match');
      expect(draws.length).toBe(2);
      const [h, v] = draws;
      expect(h.GarbageReads + h.StaleReads + v.GarbageReads + v.StaleReads).toBe(0);
      expect(r.Gl.Unwritten(h.Dst)).toBe(0);
      expect(r.Gl.Unwritten(v.Dst)).toBe(0);
      // The V pass addresses the whole temp and nothing past it; the clamp happened in the H
      // pass's read of the scene, where CLAMP_TO_EDGE is the replication the chain takes too.
      expect(v.Rows).toEqual([0, h.DstH - 1]);
      const c = r.Pass.GaussTempCensus;
      expect(c.CoverWritten).toBe(c.CoverReadable);
    });
  }

  it('edge and interior builds share ONE temp: the pool no longer grows a size per clamped card', () => {
    const r = Rig(CANVAS_W, CANVAS_H);
    for (const region of [EDGES[0], EDGES[1], { x: 900, y: 600, w: 568, h: 436 }]) {
      Build(r, CANVAS_W, CANVAS_H, 8, region, 'match');
    }
    expect(r.Pass.GaussTempCensus.Count).toBe(1);
  });
});

// ── 3. CANDIDATE (c): THE SHARED TEMP, AND THE ORDER THE CALLS ARRIVE IN ───────────────────────

describe('glass-gaussian cover > (c) one temp for twenty cards is safe in ONE context, by the call order', () => {
  it('every build is: bind temp, invalidate, draw H; bind level 0, invalidate, draw V -- and nothing between', () => {
    const g = Grid(2);
    const r = Rig(g.W, g.H);
    for (let i = 0; i < 20; i++) {
      const from = r.Gl.Seq.length;
      Build(r, g.W, g.H, g.Radius, g.Fill[i], 'match');
      // The allocation binds (`_useChain`, `_useGaussTemp`) come first and draw nothing.
      const all = r.Gl.Seq.slice(from);
      const seq = all.slice(all.indexOf('invalidateFramebuffer') - 1);
      expect(all.slice(0, all.length - seq.length).every((c) => c === 'bindFramebuffer')).toBe(true);
      expect(seq).toEqual([
        'bindFramebuffer', 'invalidateFramebuffer', 'drawElements',
        'bindFramebuffer', 'invalidateFramebuffer', 'drawElements',
        'bindFramebuffer',
      ]);
    }
  });

  it('the V draw of card N reads the H draw of card N, never card N-1`s, though the texture is shared', () => {
    const g = Grid(2);
    const r = Rig(g.W, g.H);
    let temp: object | null = null;
    for (let i = 0; i < 20; i++) {
      const [h, v] = Build(r, g.W, g.H, g.Radius, g.Fill[i], 'match');
      if (temp !== null) expect(h.Dst).toBe(temp);
      temp = h.Dst;
      expect(v.Serial).toBe(h.Serial + 1);
      expect(v.StaleReads + v.GarbageReads).toBe(0);
    }
  });
});

// ── 4. CANDIDATE (d): THE UNIFORM TABLE'S TAIL ─────────────────────────────────────────────────

describe('glass-gaussian cover > (d) the loop never reads an entry the build did not upload', () => {
  it('both tables are uploaded u_Fetches long, and the loop is bounded by u_Fetches', () => {
    const g = Grid(2);
    for (const mode of ['match', 'on'] as const) {
      const r = Rig(g.W, g.H);
      for (const d of Build(r, g.W, g.H, g.Radius, g.Fill[0], mode)) {
        expect(d.OffLen).toBe(d.Fetches);
        expect(d.WtLen).toBe(d.Fetches);
      }
    }
    expect(PASS).toContain('for (int i = 0; i < u_Fetches; i++) {');
  });

  it('the live prefix is finite and convex, so no entry the loop reads can be garbage', () => {
    for (const k of [GaussianKernelFor(GAUSS_MATCH_SIGMA), GaussianKernelFor(8)]) {
      let sum = 0;
      for (let i = 0; i < k.Fetches; i++) {
        expect(Number.isFinite(k.Offsets[i])).toBe(true);
        expect(k.Weights[i]).toBeGreaterThan(0);
        sum += k.Weights[i];
      }
      expect(sum).toBeCloseTo(1, 6);
    }
  });
});

// ── 5. THE REFUSAL, THE CENSUS, AND THE ONE-SHOT INSTRUMENT ────────────────────────────────────

describe('glass-gaussian cover > a plan that would read past its write is REFUSED by name', () => {
  it('a table reaching one row past its pad refuses, naming both numbers', () => {
    const k = GaussianKernelFor(GAUSS_MATCH_SIGMA);
    const bad: GaussianKernel = { ...k, Offsets: Float32Array.from(k.Offsets) };
    bad.Offsets[k.Fetches - 1] = -(k.Radius + 0.5);
    const t = PlanGaussianTemp({ YBottom: 100, W: 64, H: 64 }, bad);
    expect(t).toEqual({ Ok: false, Why: 'temp-reads-10-rows-past-a-9-row-pad' });
  });

  it('Blur asks the temp plan before it builds, and a refusal takes the chain with its name', () => {
    const blur = arrowBody(PASS, 'Blur');
    expect(blur).toContain('const temp = PlanGaussianTemp(rect, plan.Kernel);');
    expect(blur).toContain('if (temp.Ok) return this._blurGaussian(input, width, height, rect, scaleX, scaleY, plan, temp);');
    expect(blur).toContain('this._lastGaussianRefusal = temp.Why;');
  });

  it('the census carries tempCover, and on glass-grid it reads 568x454 texels written AND readable', () => {
    const g = Grid(2);
    const r = Rig(g.W, g.H);
    for (let i = 0; i < 20; i++) Build(r, g.W, g.H, g.Radius, g.Fill[i], 'match');
    const c = r.Pass.GaussTempCensus;
    expect(c.Sizes).toBe('568x454');
    expect([c.CoverWritten, c.CoverReadable]).toEqual([568 * 454, 568 * 454]);
  });

  it('the gate line prints tempCover=<written>/<readable>, and the census exports both', () => {
    expect(JAUI).toContain('+ ` tempCover=${tmp.CoverWritten}/${tmp.CoverReadable}`');
    expect(JAUI).toContain('TempCoverWritten: on ? r.GaussTempCensus.CoverWritten : 0,');
    expect(JAUI).toContain('TempCoverReadable: on ? r.GaussTempCensus.CoverReadable : 0,');
  });
});

describe('glass-gaussian cover > ?gauss-debug: an unwritten texel would be MAGENTA in one shot', () => {
  it('each build clears both targets to magenta before its draw, and the draw overwrites every one', () => {
    BlurPass.GaussDebugMagenta = true;
    const g = Grid(2);
    const r = Rig(g.W, g.H);
    r.Gl.Gl.clearColor(0.1, 0.2, 0.3, 1);
    const from = r.Gl.Seq.length;
    const [h, v] = Build(r, g.W, g.H, g.Radius, g.Fill[3], 'match');
    expect(r.Gl.Seq.slice(from).filter((c) => c === 'clear').length).toBe(2);
    expect(r.Pass.GaussTempCensus.DebugClears).toBe(2);
    // The magenta clear's stamp survives nowhere: the picture is the `match` picture exactly.
    expect(r.Gl.Unwritten(h.Dst)).toBe(0);
    expect(r.Gl.Unwritten(v.Dst)).toBe(0);
    // And the clear colour every other clear in the engine relies on is handed back untouched.
    expect(Array.from(r.Gl.Gl.getParameter(r.Gl.COLOR_CLEAR_VALUE) as Float32Array))
      .toEqual(Array.from(new Float32Array([0.1, 0.2, 0.3, 1])));
  });

  it('off by default, armed only beside the arm, and refused BY NAME without it', () => {
    expect(PASS).toContain('static GaussDebugMagenta = false;');
    expect(JAUI).toContain('this._gaussDebug = this._glassGaussian !== \'off\';');
    expect(JAUI).toContain("JTrace('jaui:gauss-debug armed=off reason=glass-gaussian-is-off');");
    expect(JAUI).toContain('BlurPass.GaussDebugMagenta = this._gaussDebug;');
    expect(JAUI).toContain("+ (this._gaussDebug ? ' debug=magenta' : '')");
  });

  it('an unflagged build issues no clear at all', () => {
    const g = Grid(2);
    const r = Rig(g.W, g.H);
    const from = r.Gl.Seq.length;
    Build(r, g.W, g.H, g.Radius, g.Fill[3], 'match');
    expect(r.Gl.Seq.slice(from)).not.toContain('clear');
  });
});

// ── 6. THE DEFECT'S FOOTPRINT RULES THE TEMP OUT ───────────────────────────────────────────────

describe('glass-gaussian cover > the observed defect cannot come from one unwritten TEMP texel', () => {
  // The V pass is a convex combination of temp texels, so one wrong temp texel moves an output
  // pixel by at most (its discrete tap weight) x (how wrong it is) <= w0 x 255. At sigma 2.7988 the
  // centre tap weighs 0.1425: ONE garbage temp texel moves level 0 by at most 36/255, and it moves a
  // COLUMN of level-0 texels (15 of them by >= 1/255), not one. The shot saw max 75 across 10 pixels spread over six cards.
  const k = GaussianKernelFor(GAUSS_MATCH_SIGMA);
  const w = Array.from({ length: k.Radius + 1 }, (_, i) => Math.exp(-(i * i) / (2 * k.Sigma * k.Sigma)));
  const total = w.reduce((s, v, i) => s + (i === 0 ? v : 2 * v), 0);
  const w0 = w[0] / total;

  it('one garbage temp texel moves a level-0 texel by at most 36 of 255', () => {
    expect(w0).toBeCloseTo(0.1425, 3);
    expect(Math.floor(w0 * 255)).toBe(36);
    expect(w0 * 255).toBeLessThan(75);
  });

  it('...and it streaks: at full error, 15 vertically adjacent level-0 texels move by >= 1/255', () => {
    const streak = w.filter((v) => (v / total) * 255 >= 1).length * 2 - 1;
    expect(streak).toBe(15);
  });

  it('the input scene is not the source either: the H pass reads only SOURCE-stamped texels', () => {
    const g = Grid(2);
    const r = Rig(g.W, g.H);
    const [h] = Build(r, g.W, g.H, g.Radius, g.Fill[12], 'match');
    expect(h.Src).toBe(r.Src);
    expect(h.StaleReads + h.GarbageReads).toBe(0);
    expect(SOURCE).toBeGreaterThan(r.Gl.LastSerial);
  });
});
