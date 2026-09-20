import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlurPass, BaseDownsampleFactor, PyramidDepth, ResolveRegionRect,
  type BackdropRect, type AtlasBuildMember,
} from '../src/Core/BlurPass';
import {
  PlanBackdropAtlas, AtlasAdmitsMember, ATLAS_LIMITS_WIRED, ATLAS_BUDGET_BYTES,
} from '../src/Core/Blur.Atlas';
import { FakeGl } from './Blur.Chains.Source';
import { arrowBody } from './Scene.ReadAfterWrite.Source';

/**
 * THE WIRED ATLAS: `?pyramid-atlas`, a MEASUREMENT ARM since Jack's fourth ruling.
 *
 * WHICH ARM THIS FILE IS ABOUT. Every build here runs `AtlasInstanced = false` -- the per-slot
 * path, one `gl.viewport` and one `drawElements` per member per level, which is the atlas exactly
 * as lane pyramidatlas2 shipped it and what `?atlas-instanced=off` selects. The instanced default
 * has its own file (`Blur.Atlas.Instanced.test.ts`) and its whole claim is that it agrees with
 * this one record for record, so the two are deliberately not merged.
 *
 * `Blur.Atlas.test.ts` is the planner's arithmetic -- what may be atlased, how the slots pack,
 * what it saves. This file is the BUILD: the passes `BlurPass.BlurAtlas` actually issues, the
 * uniforms it issues them with, and the two things a slot has that a standalone pyramid does not
 * (a neighbour instead of a hardware clamp, and a different denominator).
 *
 * THE CLAIM UNDER TEST, in one line: an atlas build is the standalone builds' ARITHMETIC issued
 * from four binds instead of eighty. So almost every assertion here is a COMPARISON against a
 * standalone build of the same member -- the uniforms it sets, hop for hop -- rather than against
 * a number written down by hand. A number written down by hand is a second answer to what the
 * pyramid does, and the whole point of the atlas is that there is only one.
 *
 * WHAT THIS HARNESS CANNOT SEE, said plainly: `FakeGl` has no rasteriser and ignores `viewport`,
 * so it cannot tell one slot's texels from another's. It can tell you the PASSES and the UNIFORMS
 * are right, which is what decides whether the pixels are, and it cannot tell you the pixels ARE
 * right. That is what the orchestrator's `glassshot` gate is for, and the lane's report says which
 * of the two numbers it predicts.
 */

// -- glass-grid, pinned, on the same geometry `Blur.Union.test.ts` and `Blur.Chains.test.ts` use.
const CANVAS_W = 2560;
const CANVAS_H = 1600;
const DPR = 2;
/** BackdropFilter Blur(4pt) at DPR 2. */
const RADIUS = 4 * DPR;
/** The FILL pipeline's margin: frost*d + (thickness*d + bulge)*Refraction + CA*3 + 8*d. */
const FILL_MARGIN = 4 * DPR + (2.5 * DPR) * 8 + 0.25 * 3 + 8 * DPR;
/** The BORDER-only pipeline's margin: frost*d + 8*d. */
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

const FILL_REGIONS = Array.from({ length: 20 }, (_, i) => RegionFor(CardBox(i), FILL_MARGIN));
const RIM_REGIONS = Array.from({ length: 20 }, (_, i) => RegionFor(CardBox(i), RIM_MARGIN));

const K = BaseDownsampleFactor(RADIUS, CANVAS_W, CANVAS_H, FILL_REGIONS[0]);
const DEPTH = PyramidDepth(RADIUS / K, 0);
const PHASE = K * (1 << DEPTH);

const Resolved = (r: BackdropRect) => ResolveRegionRect(r, CANVAS_W, CANVAS_H, PHASE);

/** The plan the walk would hand the atlas for a phase of regions. */
const PlanFor = (regions: BackdropRect[]) => PlanBackdropAtlas(
  regions.map((r) => ({ Region: r, Paint: r })), CANVAS_W, CANVAS_H, RADIUS,
  { IgnoreSeparation: true, Limits: ATLAS_LIMITS_WIRED, MaxLod: 0 },
);

const MembersFor = (regions: BackdropRect[]): {
  Build: AtlasBuildMember[]; AtlasW: number; AtlasH: number;
} => {
  const plan = PlanFor(regions);
  expect(plan).not.toBeNull();
  expect(plan!.Groups.length).toBe(1);
  const g = plan!.Groups[0];
  return {
    Build: g.Members.map((mi, i) => ({ Rect: Resolved(regions[mi]), Slot: g.Slots[i] })),
    AtlasW: g.AtlasW,
    AtlasH: g.AtlasH,
  };
};

/** A `FakeGl` that also records, for every draw, the uniforms that draw ran with. `FakeGl` keeps
 *  those private and hashes them into the written value; the atlas's whole claim is about the
 *  VALUES, so they are intercepted on the way in. */
class RecordingGl extends FakeGl {
  Live = new Map<string, string>();
  Draws: { Program: string; U: Record<string, string> }[] = [];
  private _prog = '';

  constructor() {
    super();
    const names = new Map<object, string>();
    const getLoc = this.getUniformLocation;
    this.getUniformLocation = (p: never, name: string): never => {
      const loc = getLoc(p, name) as object;
      names.set(loc, name);
      return loc as never;
    };
    const note = (loc: object | null, v: string): void => {
      if (loc === null) return;
      const n = names.get(loc);
      if (n !== undefined) this.Live.set(`${this._prog}:${n}`, v);
    };
    const u1i = this.uniform1i, u1f = this.uniform1f, u2f = this.uniform2f, u4f = this.uniform4f;
    this.uniform1i = (l: never, a: number): never => { note(l, String(a)); return u1i(l, a) as never; };
    this.uniform1f = (l: never, a: number): never => { note(l, String(a)); return u1f(l, a) as never; };
    this.uniform2f = (l: never, a: number, b: number): never => {
      note(l, `${a},${b}`); return u2f(l, a, b) as never;
    };
    this.uniform4f = (l: never, a: number, b: number, c: number, d: number): never => {
      note(l, `${a},${b},${c},${d}`); return u4f(l, a, b, c, d) as never;
    };
    const use = this.useProgram;
    this.useProgram = (p: never): never => {
      this._prog = p === null ? '' : String((p as { Id: number }).Id);
      return use(p) as never;
    };
    const draw = this.drawElements;
    this.drawElements = ((): never => {
      const u: Record<string, string> = {};
      for (const [k, v] of this.Live) {
        if (k.startsWith(`${this._prog}:`)) u[k.slice(this._prog.length + 1)] = v;
      }
      this.Draws.push({ Program: this._prog, U: u });
      return (draw as () => void)() as never;
    }) as never;
  }

  /** Every level bind is one `invalidateFramebuffer` in `_bindTarget`, and a level bind is what
   *  opens a render command encoder. This is the column the whole lever moves. */
  get Binds(): number { return this.Calls.filter((c) => c === 'invalidateFramebuffer').length; }
  get DrawCount(): number { return this.Calls.filter((c) => c === 'drawElements').length; }
}

const NewPass = (): { gl: RecordingGl; pass: BlurPass } => {
  const gl = new RecordingGl();
  const pass = new BlurPass(gl.Gl, undefined, 1, { MaxChains: 8, BudgetBytes: ATLAS_BUDGET_BYTES });
  // The atlas kernels are NOT in a BlurPass's constructor batch any more -- they are compiled when
  // an atlas arm arms, which is what `WebGL2Renderer.ArmFlaggedPrograms` does off `?pyramid-atlas`.
  // This is that call; `BlurAtlas` throws without it, and `Boot.Compile.test.ts` covers the throw.
  pass.EnsureAtlasPrograms();
  // THE PER-SLOT ARM. Every assertion below is about the draws, the viewports and the uniforms
  // that arm issues; the instanced default issues one draw a level and no uniforms at all, and
  // `Blur.Atlas.Instanced.test.ts` compares the two.
  pass.AtlasInstanced = false;
  return { gl, pass };
};

describe('the atlas is the standalone builds, issued from four binds', () => {
  it('collapses 80 encoder-opening binds to 4 and does not move a single draw', () => {
    const { Build, AtlasW, AtlasH } = MembersFor(FILL_REGIONS);
    const atlas = NewPass();
    const src = atlas.gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    atlas.gl.Reset();
    atlas.pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, Build, AtlasW, AtlasH);

    const solo = NewPass();
    const soloSrc = solo.gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    solo.gl.Reset();
    for (const r of FILL_REGIONS) {
      solo.pass.Blur(soloSrc as never, CANVAS_W, CANVAS_H, RADIUS, 0, r);
    }

    // FOUR passes per build on this scene (Down 2 + Up 2, no mip chain), twenty builds.
    expect(solo.gl.Binds).toBe(2 * DEPTH * 20);
    expect(solo.gl.DrawCount).toBe(2 * DEPTH * 20);
    // The atlas binds once per LEVEL and draws once per slot per level. The draws do not move.
    expect(atlas.gl.Binds).toBe(2 * DEPTH);
    expect(atlas.gl.DrawCount).toBe(2 * DEPTH * 20);
    // Which is the control invariant, stated the way a cell must quote it.
    expect(atlas.gl.DrawCount).toBe(solo.gl.DrawCount);
    expect(solo.gl.Binds - atlas.gl.Binds).toBe(76);
  });

  it('the rims collapse the same way, and the two phases are 160 binds against 8', () => {
    const fills = MembersFor(FILL_REGIONS);
    const rims = MembersFor(RIM_REGIONS);
    const a = NewPass();
    const src = a.gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    a.gl.Reset();
    a.pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, fills.Build, fills.AtlasW, fills.AtlasH);
    a.pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, rims.Build, rims.AtlasW, rims.AtlasH);
    expect(a.gl.Binds).toBe(8);
    expect(a.gl.DrawCount).toBe(160);
  });

  it("every uniform the KERNEL reads is the standalone build's, hop for hop", () => {
    // The strongest statement this harness can make about the pixels: the atlas sets the same
    // `u_SrcRect` and the same `u_HalfPixel` the per-card build sets, for every member at every
    // hop. `u_HalfPixel` is the SLOT's half-texel, never the atlas's -- which is what keeps the
    // kernel's taps in the same units and the same floats.
    const { Build, AtlasW, AtlasH } = MembersFor(FILL_REGIONS);
    const atlas = NewPass();
    const src = atlas.gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    atlas.gl.Reset();
    atlas.pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, Build, AtlasW, AtlasH);

    // The atlas issues level by level: hop 1 for all twenty, then hop 2 for all twenty, ...
    // A standalone build issues hop 1..4 for one member. So the comparison is per (member, hop).
    for (let m = 0; m < 20; m++) {
      const solo = NewPass();
      const soloSrc = solo.gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
      solo.gl.Reset();
      solo.pass.Blur(soloSrc as never, CANVAS_W, CANVAS_H, RADIUS, 0, FILL_REGIONS[m]);
      expect(solo.gl.Draws.length).toBe(2 * DEPTH);
      for (let hop = 0; hop < 2 * DEPTH; hop++) {
        const want = solo.gl.Draws[hop].U;
        const got = atlas.gl.Draws[hop * 20 + m].U;
        expect(got.u_HalfPixel, `member ${m} hop ${hop} u_HalfPixel`).toBe(want.u_HalfPixel);
        expect(got.u_SrcRect, `member ${m} hop ${hop} u_SrcRect`).toBe(want.u_SrcRect);
        expect(got.u_Offset, `member ${m} hop ${hop} u_Offset`).toBe(want.u_Offset);
      }
    }
  });

  it('the DOWN hop that reads the SCENE takes the plain kernel, and only it', () => {
    // Hop 1 reads the canvas, where the hardware's own CLAMP_TO_EDGE is the same clamp the
    // standalone build got -- so it is the one hop that needs no slot mapping at all. Every other
    // hop reads the atlas and must carry one.
    const { Build, AtlasW, AtlasH } = MembersFor(FILL_REGIONS);
    const { gl, pass } = NewPass();
    const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    gl.Reset();
    pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, Build, AtlasW, AtlasH);
    for (let i = 0; i < gl.Draws.length; i++) {
      const slotted = gl.Draws[i].U.u_Slot !== undefined;
      expect(slotted, `draw ${i}`).toBe(i >= 20);
    }
  });
});

describe('the clamp is CLAMP_TO_EDGE, written down', () => {
  /** What `TAP_SLOT` computes: `u_Slot.xy + clamp(p, u_Clamp.xy, u_Clamp.zw) * u_Slot.zw`. */
  const Tap = (u: Record<string, string>, p: number): number => {
    const slot = u.u_Slot.split(',').map(Number);
    const cl = u.u_Clamp.split(',').map(Number);
    return slot[0] + Math.min(Math.max(p, cl[0]), cl[2]) * slot[2];
  };

  it('lands every in-slot texel centre on the atlas texel that holds it', () => {
    const { Build, AtlasW, AtlasH } = MembersFor(FILL_REGIONS);
    const { gl, pass } = NewPass();
    const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    gl.Reset();
    pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, Build, AtlasW, AtlasH);
    // The first slotted level: DOWN hop 2, whose SOURCE is atlas level 1.
    const levelW = AtlasW >> 1;
    for (let m = 0; m < 20; m++) {
      const u = gl.Draws[20 + m].U;
      const slot = Build[m].Slot;
      const sw = slot.W >> 1, sx = slot.X >> 1;
      for (const j of [0, 1, (sw >> 1), sw - 2, sw - 1]) {
        // Slot uv of texel j's centre -> the atlas uv of the SAME texel.
        expect(Tap(u, (j + 0.5) / sw) * levelW).toBeCloseTo(sx + j + 0.5, 6);
      }
    }
  });

  it('replicates the border texel exactly where the hardware would have', () => {
    // GL ES 3.0 3.8.9: CLAMP_TO_EDGE clamps the COORDINATE to the texel-centre range, so a tap
    // past the edge lands on the edge texel with weight 1. A slot is interior to the atlas, so
    // the kernel has to do it -- and the test is that it lands on the same texel.
    const { Build, AtlasW, AtlasH } = MembersFor(FILL_REGIONS);
    const { gl, pass } = NewPass();
    const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    gl.Reset();
    pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, Build, AtlasW, AtlasH);
    const levelW = AtlasW >> 1;
    const u = gl.Draws[20].U;
    const slot = Build[0].Slot;
    const sw = slot.W >> 1, sx = slot.X >> 1;
    for (const p of [-1, -0.25, -1 / (2 * sw), 0]) {
      expect(Tap(u, p) * levelW).toBeCloseTo(sx + 0.5, 6);
    }
    for (const p of [1, 1.25, 1 + 1 / sw]) {
      expect(Tap(u, p) * levelW).toBeCloseTo(sx + sw - 0.5, 6);
    }
  });

  it('the clamp is a NO-OP everywhere the standalone tap was already inside', () => {
    // The whole identity argument: for a coordinate the hardware would not have clamped, the
    // kernel clamps nothing and the only difference left is the mad's denominator.
    const { Build, AtlasW, AtlasH } = MembersFor(FILL_REGIONS);
    const { gl, pass } = NewPass();
    const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    gl.Reset();
    pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, Build, AtlasW, AtlasH);
    const u = gl.Draws[20].U;
    const cl = u.u_Clamp.split(',').map(Number);
    const slot = Build[0].Slot;
    const sw = slot.W >> 1, sh = slot.H >> 1;
    expect(cl[0]).toBe(0.5 / sw);
    expect(cl[1]).toBe(0.5 / sh);
    expect(cl[2]).toBe(1 - 0.5 / sw);
    expect(cl[3]).toBe(1 - 0.5 / sh);
  });
});

describe("the consumer map is the member's own map, composed with its slot", () => {
  it("sends a screen point to the atlas texel holding that point's blurred value", () => {
    const { Build, AtlasW, AtlasH } = MembersFor(FILL_REGIONS);
    const { gl, pass } = NewPass();
    const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
    const built = pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, Build, AtlasW, AtlasH);
    expect(built.Regions.length).toBe(20);
    for (let m = 0; m < 20; m++) {
      const region = built.Regions[m];
      const rect = Build[m].Rect;
      const slot = Build[m].Slot;
      // A device-px point inside the member's rect, in screen UV, through `u_BackdropXf`.
      for (const [px, py] of [[rect.X + 0.5, CANVAS_H - (rect.YBottom + 0.5)],
                              [rect.X + rect.W - 0.5, CANVAS_H - (rect.YBottom + rect.H - 0.5)],
                              [rect.X + rect.W / 2, CANVAS_H - (rect.YBottom + rect.H / 2)]]) {
        const uv = px / CANVAS_W;
        const vv = (CANVAS_H - py) / CANVAS_H;
        expect((uv * region.ScaleX + region.OffsetX) * AtlasW)
          .toBeCloseTo(slot.X + (px - rect.X), 6);
        expect((vv * region.ScaleY + region.OffsetY) * AtlasH)
          .toBeCloseTo(slot.YBottom + ((CANVAS_H - py) - rect.YBottom), 6);
      }
      expect(region.TexelsX).toBe(AtlasW);
      expect(region.TexelsY).toBe(AtlasH);
    }
  });

  it('is AFFINE, so `Jiv.Panel.frag` is untouched', () => {
    const frag = readFileSync(join(__dirname, '../src/Jiv/Shaders/Jiv.Panel.frag'), 'utf8').replace(/\r\n/g, '\n');
    expect(frag).toContain('vec2 backdropUv = uv * u_BackdropXf.xy + u_BackdropXf.zw;');
  });
});

describe('it refuses a layout it cannot build faithfully, rather than drawing a resample', () => {
  let gl: RecordingGl;
  let pass: BlurPass;
  let src: object;
  beforeEach(() => {
    const p = NewPass();
    gl = p.gl; pass = p.pass;
    src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
  });

  const one = (): AtlasBuildMember[] => {
    const { Build } = MembersFor(FILL_REGIONS);
    return [Build[0], Build[1]];
  };

  it('throws on a slot off the phase grid', () => {
    const ms = one();
    ms[1] = { ...ms[1], Slot: { ...ms[1].Slot, X: ms[1].Slot.X + 1 } };
    expect(() => pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, ms, 4096, 4096))
      .toThrow(/phase grid/);
  });

  it('throws on an atlas off the phase grid', () => {
    expect(() => pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, one(), 4095, 4096))
      .toThrow(/phase grid/);
  });

  it('throws when a slot does not hold its own rect', () => {
    const ms = one();
    ms[0] = { ...ms[0], Slot: { ...ms[0].Slot, W: ms[0].Slot.W - PHASE } };
    expect(() => pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, ms, 4096, 4096))
      .toThrow(/does not hold its rect/);
  });

  it('throws when a slot leaves the atlas', () => {
    expect(() => pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, one(), 512, 512))
      .toThrow(/leaves the/);
  });

  it('throws on an empty member list and on a sharp root', () => {
    expect(() => pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, [], 512, 512))
      .toThrow(/at least one member/);
    expect(() => pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, 0, one(), 4096, 4096))
      .toThrow(/radius must be > 0/);
  });
});

describe('THE ADMISSION RULE -- what a slot cannot represent', () => {
  const Candidate = (over: Partial<Parameters<typeof AtlasAdmitsMember>[0]> = {}) => {
    const box = CardBox(6);
    return {
      Region: RegionFor(box, FILL_MARGIN),
      Radius: RADIUS,
      MaxLod: 0,
      Px: box.x, Py: box.y, Pw: box.w, Ph: box.h,
      // A 16pt drop shadow at dpr 2 with a 4pt offset: the glass-grid card's own quad.
      TapReach: 16 * DPR + 4 * DPR,
      ...over,
    };
  };

  it('admits a glass-grid card: its 65 px margin contains its 40 px quad', () => {
    expect(AtlasAdmitsMember(Candidate(), CANVAS_W, CANVAS_H)).toBe(true);
  });

  it('REFUSES the same card the moment its draw can tap outside its region', () => {
    // The failure this catches is a structural one and not a dusting: a tap that leaves a slot
    // reads the NEIGHBOUR, so it would paint one card's blur into another's edge band.
    expect(AtlasAdmitsMember(Candidate({ TapReach: 200 }), CANVAS_W, CANVAS_H)).toBe(false);
    // And the margin is what buys the headroom, so a card with the same quad and no frost fails.
    const box = CardBox(6);
    expect(AtlasAdmitsMember({
      ...Candidate(), Region: RegionFor(box, 4), TapReach: 40,
    }, CANVAS_W, CANVAS_H)).toBe(false);
  });

  it('REFUSES a mip consumer and a k > 1 surface', () => {
    expect(AtlasAdmitsMember(Candidate({ MaxLod: 2 }), CANVAS_W, CANVAS_H)).toBe(false);
    // k > 1 needs a region over 15% of the canvas AND a sigma past 4: a full-screen modal.
    const big: BackdropRect = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
    expect(BaseDownsampleFactor(64, CANVAS_W, CANVAS_H, big)).toBeGreaterThan(1);
    expect(AtlasAdmitsMember({
      Region: big, Radius: 64, MaxLod: 0, Px: 0, Py: 0, Pw: CANVAS_W, Ph: CANVAS_H, TapReach: 0,
    }, CANVAS_W, CANVAS_H)).toBe(false);
  });

  it("REFUSES a full-canvas region, which is the shared backdrop's shape and not a member's", () => {
    expect(AtlasAdmitsMember({
      Region: { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H },
      Radius: RADIUS, MaxLod: 0, Px: 0, Py: 0, Pw: CANVAS_W, Ph: CANVAS_H, TapReach: 0,
    }, CANVAS_W, CANVAS_H)).toBe(false);
  });

  it('clips the reach to the canvas, because a fragment outside it is never rasterized', () => {
    // Card 0 sits 120 device px from the left edge, so nothing here is clipped; move a card onto
    // the edge and the reach that would leave the canvas must stop counting against it.
    const box: BackdropRect = { x: 0, y: 400, w: 216 * DPR, h: 150 * DPR };
    const c = {
      Region: RegionFor(box, FILL_MARGIN), Radius: RADIUS, MaxLod: 0,
      Px: box.x, Py: box.y, Pw: box.w, Ph: box.h, TapReach: 40,
    };
    expect(AtlasAdmitsMember(c, CANVAS_W, CANVAS_H)).toBe(true);
  });

  it('admits every RIM on glass-grid, because a border-only pass taps only inward', () => {
    for (let i = 0; i < 20; i++) {
      const box = CardBox(i);
      expect(AtlasAdmitsMember({
        Region: RIM_REGIONS[i], Radius: RADIUS, MaxLod: 0,
        Px: box.x, Py: box.y, Pw: box.w, Ph: box.h, TapReach: 0,
      }, CANVAS_W, CANVAS_H), `card ${i}`).toBe(true);
    }
  });
});

describe('the storage, and what happens when it does not fit', () => {
  it("holds glass-grid's two atlases and says what they cost", () => {
    const fills = PlanFor(FILL_REGIONS)!;
    const rims = PlanFor(RIM_REGIONS)!;
    expect(fills.Groups.length).toBe(1);
    expect(rims.Groups.length).toBe(1);
    const bytes = fills.Groups[0].Bytes + rims.Groups[0].Bytes;
    // The finding's priced number: 33.06 + 22.30 MB, past the shipped 48 MB chain budget and
    // inside the atlas's own 64.
    expect(bytes / (1024 * 1024)).toBeGreaterThan(48);
    expect(bytes).toBeLessThan(ATLAS_BUDGET_BYTES);
    expect(fills.EncodersSaved + rims.EncodersSaved).toBe(152);
  });

  it('SPLITS a run it cannot fit instead of evicting -- which is the phone', () => {
    // dpr 3 is 2.25x the texels. Planned under a budget that cannot hold one atlas of twenty, the
    // planner must come back with SEVERAL groups and no member dropped, because an evicting pool
    // reallocates whole textures mid-frame and that thrash would be read as the atlas's cost.
    const tight = PlanBackdropAtlas(
      FILL_REGIONS.map((r) => ({ Region: r, Paint: r })), CANVAS_W, CANVAS_H, RADIUS,
      { IgnoreSeparation: true, Limits: { MaxTexture: 8192, BudgetBytes: 8 * 1024 * 1024 }, MaxLod: 0 },
    );
    expect(tight).not.toBeNull();
    expect(tight!.Groups.length).toBeGreaterThan(1);
    const carried = tight!.Groups.reduce((n, g) => n + g.Members.length, 0) + tight!.Solo;
    expect(carried).toBe(20);
    for (const g of tight!.Groups) expect(g.Bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    // And it still saves most of the lever.
    expect(tight!.EncodersSaved).toBeGreaterThan(60);
  });
});

describe('the shipping kernel is textually what it was', () => {
  const SRC = readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8').replace(/\r\n/g, '\n');

  it("expands TAP to today's `textureLod(u_Tex, p, 0.0)` when no slot is involved", () => {
    // A MACRO and not a function, so the preprocessed source a driver compiles for the unflagged
    // path is character for character what it was, modulo parentheses that cannot move a float.
    expect(SRC).toContain("const TAP_PLAIN = '#define TAP(p) textureLod(u_Tex, (p), 0.0)';");
    expect(SRC).toContain('#define TAP(p) textureLod(u_Tex, u_Slot.xy + clamp((p), u_Clamp.xy, u_Clamp.zw) * u_Slot.zw, 0.0)');
  });

  it('builds both variants of both kernels, the plain pair at boot and the slot pair at arm time', () => {
    // The plain pair is in the constructor's batch because an UNFLAGGED page binds it. The slot
    // pair is not, because an unflagged page never does: `?pyramid-atlas` is off by default and
    // the atlas path is the only thing that binds them. Neither is lazy-on-first-use -- that would
    // land the compile on the first frame with glass on it, the frame every boot measurement
    // reads. See lane bootcompile and `WebGL2Renderer.ArmFlaggedPrograms`.
    expect(SRC).toContain('this._down = b.Add(VERT, DOWN_FRAG(TAP_PLAIN));');
    expect(SRC).toContain('this._up = b.Add(VERT, UP_FRAG(TAP_PLAIN));');
    expect(SRC).toContain('DownSlot: b.Add(VERT, DOWN_FRAG(TAP_SLOT)),');
    expect(SRC).toContain('UpSlot: b.Add(VERT, UP_FRAG(TAP_SLOT)),');
    // The kernel SOURCES are untouched: only which batch issues them moved.
    const ctor = SRC.slice(SRC.indexOf('this._maxChains = maxChains;'), SRC.indexOf('get AtlasProgramsCompiled'));
    expect(ctor).not.toContain('TAP_SLOT');
    expect(ctor).not.toContain('VERT_INST');
  });

  it('never opens a mip chain for an atlas, because there is no mip atlas', () => {
    const body = SRC.slice(SRC.indexOf('BlurAtlas = ('), SRC.indexOf('private _slotUniforms'));
    expect(body).toContain('this._levels[0].DisableMipmap();');
    expect(body).not.toContain('EnsureMipLevels');
    expect(body).not.toContain('GenerateOutputMipmap');
  });
});

describe('the walk, and the flag', () => {
  const JAUI = readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');

  it('is OFF unless asked for, the bare flag is `fills`, and the three values are the only ones', () => {
    // JACK'S FOURTH RULING (2026-09-20 ~14:20): the default composition goes back to today's
    // picture. The arm bought 1.69 ms (`all`) / 0.78 (`fills`) against a predicted 10.5 / 5.2, it
    // moved no frame rate, and it is not "more accurate" -- a real glass edge refracts its
    // neighbour. So an ABSENT flag is `off` and the arms have to be asked for by name.
    expect(JAUI).toContain('private _pyramidAtlas: boolean = false;');
    expect(JAUI).toContain("this._pyramidAtlas = raw !== 'off';");
    // ...and the bare flag is still `fills`, which is what makes `?pyramid-atlas` a one-word arm
    // rather than a fourth spelling of the default.
    expect(JAUI).not.toContain('private _pyramidAtlas: boolean = true;');
    // `fills` is the DEFAULT arm: the fills' atlas with every rim still building per-card in the
    // walk, so z-order is the baseline's. `all` is pyramidatlas2's composition, which moves every
    // rim draw to pass 3 -- the full lever, and a z-order change Jack's ruling does not cover.
    expect(JAUI).toContain('private _atlasRims: boolean = false;');
    expect(JAUI).toContain('private _rimsInWalk: boolean = false;');
    expect(JAUI).toContain("this._atlasRims = raw === 'all';");
    expect(JAUI).toContain('this._rimsInWalk = this._pyramidAtlas && !this._atlasRims;');
    // A flag whose value was ignored would let `=false` and `=no` arm the default while reading
    // as if they had turned it off, which is what an instrument exists to prevent. With TWO armed
    // arms it is sharper still: a typo'd `=fill` would silently publish the other composition.
    expect(JAUI).toContain("?pyramid-atlas takes 'all', 'fills' or 'off'");
    expect(JAUI).toContain("raw !== '' && raw !== 'all' && raw !== 'fills' && raw !== 'off'");
  });

  it('routes the RIMS, and nothing else, off the arm -- at exactly three sites', () => {
    // The `fills` arm is one term in one predicate plus the two lines that look a pre-built rim
    // handle up. `_phasedHoldsBack` and `_phasedPaints` are NOT among them, deliberately: the
    // pass-1/pass-2 boundary has to land on the same node under both arms or the fill pyramids
    // would be built from a different bed and `fills` against `all` would stop being a test of
    // the rims alone.
    const emits = arrowBody(JAUI, '_phasedEmitsRim');
    expect(emits).toContain('const held = overlayGlass && !this._rimsInWalk;');
    expect(emits).toContain('case 3: return held;');
    expect(arrowBody(JAUI, '_phasedHoldsBack')).not.toContain('_rimsInWalk');
    expect(arrowBody(JAUI, '_phasedPaints')).not.toContain('_rimsInWalk');
    // The rim's build under `fills` is the BASELINE's build, on the baseline's line: from the live
    // scene texture, at this node's own point in the walk. That is why the rim PIXELS as well as
    // the rim z-order are the engine's as it shipped.
    const render = arrowBody(JAUI, '_render');
    expect(render).toContain('const preRim = (this._blurFirst || this._phasedWalk) && !this._rimsInWalk');
    // Re-aimed by lane borderdirect: the walk-built-rim census and the build itself moved into the
    // `else` arm of the direct path's `if`, so the `else if` became a plain `if` on the line below
    // a `} else {`. Intent unchanged and now sharper — a rim that takes the DIRECT path builds no
    // pyramid, so it must NOT be counted as a walk-built solo member, and the census line being
    // inside that arm is what says so.
    expect(render).toContain('if (this._rimsInWalk) { this._blurFirstStats.Rim++; this._atlasWalkSolo++; }');
    // Re-aimed by lane presample: the call gained `?glass-presample`'s seventh argument and wrapped
    // onto a second line. The pin follows the arguments that decide the BUILD -- the live scene
    // texture, this node's own region -- and stops before the arm, which is off by default.
    expect(render).toContain('lastBackdrop = r.ComputeBlur(r.SceneTexture, w, h, plan.Radius, undefined, region,');
    const solo = render.slice(0, render.indexOf('this._atlasWalkSolo++;'));
    expect(solo.lastIndexOf('} else {')).toBeGreaterThan(solo.lastIndexOf('if (direct !== null) {'));
  });

  it('does not issue a rim phase or walk pass 3 under `fills`', () => {
    const render = arrowBody(JAUI, '_render');
    const block = render.slice(render.indexOf('if (this._phasedWalk && !this._diagNoUi)'));
    const guard = block.indexOf('if (!this._rimsInWalk) {');
    expect(guard).toBeGreaterThan(block.indexOf('phase(2);'));
    // Both the rim build AND pass 3 are inside the guard -- a pass 3 that still ran would walk the
    // whole tree to emit nothing, and a rim phase that still ran would pre-build twenty pyramids
    // the walk is about to build again.
    const guarded = block.slice(guard, block.indexOf('this._phasedPass = 0;', guard));
    expect(guarded).toContain("this._blurPhasedBuild('rim', w, h);");
    expect(guarded).toContain('phase(3);');
  });

  it('counts the walk-built rims as SOLO, so `members + solo` still equals `built`', () => {
    // Twenty per-card rim builds beside an atlas of twenty fills. If they went uncounted the gate
    // would read `built=20 members=20 solo=0` and a reader could not tell this arm from `all`.
    const render = arrowBody(JAUI, '_render');
    expect(render).toContain('this._atlasWalkSolo = 0;');
    expect(render).toContain('ast.Solo += this._atlasWalkSolo;');
    expect(render).toContain('if (r instanceof WebGL2Renderer) r.NoteAtlasSolo(this._atlasWalkSolo);');
    expect(render).toContain("arm=${this._atlasRims ? 'all' : 'fills'}");
  });

  it("reuses `?blur-phased`'s traversal rather than inventing a fourth ordering", () => {
    // The two arms must differ in the ATLAS and in nothing else, or `?pyramid-atlas` against
    // `?blur-phased` is not a test of the atlas.
    expect(JAUI).toContain('private _phasedWalk: boolean = false;');
    expect(JAUI).toContain('if (this._phasedWalk && !this._diagNoUi) {');
    expect((JAUI.match(/this\._blurPhasedBuild\(/g) ?? []).length).toBe(2);
    // THREE callers now, and the count is the point rather than the number: `?blur-first`'s
    // pre-pass, `_blurPhasedBuild`, and `?occlusion`'s pre-pass, which rides the same traversal
    // for the same reason (one answer to "which nodes paint, in what order"). A FOURTH ordering
    // is what this test refuses, not a fourth caller of this one.
    expect((JAUI.match(/_blurFirstNode\(this\.Root, MAT_IDENTITY/g) ?? []).length).toBe(3);
  });

  it('refuses every flag it cannot run beside, by name, on the trace', () => {
    const block = JAUI.slice(JAUI.indexOf("if (this._pyramidAtlas) {\n      const r = this._renderer;"));
    for (const why of ['webgl2-only', 'no-blur-and-blur-dummy-build-nothing-to-atlas',
                       'blur-first-already-moved-every-build-ahead-of-the-bed',
                       'blur-phased-is-the-gate-arm-and-runs-the-builds-per-card',
                       'card-composite-builds-from-the-card-target',
                       'shared-backdrop-builds-one-pyramid-lazily',
                       'layer-cache-skips-subtrees-the-phased-walk-would-paint',
                       'restart-probes-need-a-per-card-build-to-insert-after']) {
      expect(block.slice(0, 2400), why).toContain(why);
    }
    expect(block.slice(0, 3000)).toContain('jaui:pyramid-atlas armed=false reason=');
  });

  it("marks the arm where the flag is DECIDED, not in the renderer's Init", () => {
    // Worker mode awaits `Init` before the URL is parsed, so a mark there says `off` on every arm.
    // And it names the ARM, not just on/off: with two armed compositions in one binary, a mark
    // that said `on` would leave a cell unable to say which of them it measured.
    expect(JAUI).toContain("jaui:pyramid-atlas armed=${this._pyramidAtlas ? (this._atlasRims ? 'all' : 'fills') : 'off'}");
    const renderer = readFileSync(join(__dirname, '../src/Core/WebGL2.Renderer.ts'), 'utf8').replace(/\r\n/g, '\n');
    const init = renderer.slice(renderer.indexOf('  Init = async ('));
    expect(init.slice(0, 4000)).not.toContain('JTrace(`jaui:pyramid-atlas');
  });

  it('prints solo and refused beside members, so a vacuous arm cannot pass', () => {
    // `atlases=0 members=0 solo=40` is the unflagged engine wearing the flag's name.
    const render = JAUI.slice(JAUI.indexOf('jaui:pyramid-atlas arm='));
    for (const col of ['atlases=${a.Atlases}', 'members=${a.Members}', 'solo=${a.Solo}',
                       'refused=${a.Refused}', 'missed=${st.Missed}', 'switches=${sw}',
                       // The draws the atlas ISSUED, and which arm issued them. The harness's
                       // `drawCalls` cannot see a pyramid draw, so this is the one place a cell
                       // about draws can read one.
                       'draws=${dr}', "inst=${this._atlasInstanced ? 'on' : 'off'}"]) {
      expect(render.slice(0, 1800), col).toContain(col);
    }
  });

  it('a REFUSED member takes the per-card path, which is the engine as it ships', () => {
    expect(JAUI).toContain('for (const c of solo) this._prepassIssue(c.Into, c.Node, c.Plan, w, h);');
    const issue = JAUI.slice(JAUI.indexOf('private _prepassIssue = ('));
    expect(issue.slice(0, 1600)).toContain('r.ComputeBlur(r.SceneTexture, w, h, plan.Radius, undefined, plan.Region,');
    expect(issue.slice(0, 1600)).toContain('r.GenerateBlurMipmap(plan.MaxLod)');
  });

  it('carries the atlas census on the ledger, per frame', () => {
    const ledger = readFileSync(join(__dirname, '../src/Core/Scene.Ledger.ts'), 'utf8').replace(/\r\n/g, '\n');
    for (const f of ['Atlases = 0;', 'AtlasMembers = 0;', 'AtlasSolo = 0;', 'AtlasBytes = 0;']) {
      expect(ledger).toContain(f);
    }
    // Reset every frame, or the census is a boot total wearing a frame's name.
    const begin = ledger.slice(ledger.indexOf('BeginFrame = ('), ledger.indexOf('NoteWrite'));
    for (const f of ['this.Atlases = 0;', 'this.AtlasMembers = 0;', 'this.AtlasSolo = 0;',
                     'this.AtlasBytes = 0;']) {
      expect(begin).toContain(f);
    }
  });
});
