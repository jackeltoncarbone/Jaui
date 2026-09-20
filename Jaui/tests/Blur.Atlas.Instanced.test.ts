import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlurPass, BaseDownsampleFactor, PyramidDepth, ResolveRegionRect,
  type BackdropRect, type AtlasBuildMember,
} from '../src/Core/BlurPass';
import { PlanBackdropAtlas, ATLAS_LIMITS_WIRED, ATLAS_BUDGET_BYTES } from '../src/Core/Blur.Atlas';
import { FakeGl } from './Blur.Chains.Source';
import { arrowBody } from './Scene.ReadAfterWrite.Source';

/**
 * `?atlas-instanced`: ONE INSTANCED DRAW PER ATLAS LEVEL.
 *
 * THE QUESTION THIS ARM ASKS. The atlas collapsed 160 encoder-opening binds to 4 and 160 render
 * passes to 8 and recovered 1.69 ms of the 11.06 ms that forty pyramid builds cost per render at
 * dpr 2 -- 16% of its prediction, and the per-encoder model that predicted it is falsified. The
 * one counter the atlas left unchanged BY DESIGN is the draw count: 4 levels x 20 slot draws is
 * exactly the 20 builds x 4 passes it replaced. So the surviving ~85% tracks DRAWS, and this arm
 * removes 152 of the 160 without moving a texel.
 *
 * THE CLAIM UNDER TEST, in one line: the instanced arm is the per-slot arm's numbers, issued from
 * one draw a level instead of twenty. Every assertion below is therefore a COMPARISON against the
 * per-slot build of the same members -- the uniforms it set and the viewports it set them beside,
 * against the instance records that replace both -- rather than against a number written by hand.
 *
 * WHAT THIS HARNESS CANNOT SEE. `FakeGl` has no rasteriser, so it cannot tell you the instanced
 * quad covers the same pixels. What it CAN do is check the arithmetic that decides whether it
 * does, and one test below does exactly that: it runs the vertex shader's placement in fp32 for
 * every corner of every slot at every level and says how far from the integer boundary it lands.
 * The pixels themselves are the orchestrator's `glassshot` gate, and the lane predicts 0.
 */

// -- glass-grid, pinned, on the geometry `Blur.Atlas.Wired.test.ts` uses.
const CANVAS_W = 2560;
const CANVAS_H = 1600;
const DPR = 2;
const RADIUS = 4 * DPR;
const FILL_MARGIN = 4 * DPR + (2.5 * DPR) * 8 + 0.25 * 3 + 8 * DPR;
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
const HOPS = 2 * DEPTH;

const Resolved = (r: BackdropRect) => ResolveRegionRect(r, CANVAS_W, CANVAS_H, PHASE);

const MembersFor = (regions: BackdropRect[]): {
  Build: AtlasBuildMember[]; AtlasW: number; AtlasH: number;
} => {
  const plan = PlanBackdropAtlas(
    regions.map((r) => ({ Region: r, Paint: r })), CANVAS_W, CANVAS_H, RADIUS,
    { IgnoreSeparation: true, Limits: ATLAS_LIMITS_WIRED, MaxLod: 0 },
  );
  if (plan === null || plan.Groups.length !== 1) throw new Error('the pinned scene must plan as one group');
  const g = plan.Groups[0];
  return {
    Build: g.Members.map((mi, i) => ({ Rect: Resolved(regions[mi]), Slot: g.Slots[i] })),
    AtlasW: g.AtlasW,
    AtlasH: g.AtlasH,
  };
};

/** A `FakeGl` that records, per draw, the uniforms AND the viewport that draw ran with. The
 *  viewport matters here and did not in `Blur.Atlas.Wired.test.ts`: it is one of the two things
 *  the instanced arm removes, and the instance record's first four floats are what replaces it. */
class ArmGl extends FakeGl {
  Live = new Map<string, string>();
  /** Per `drawElements`: the live uniforms and the viewport. The per-slot arm's column. */
  Draws: { U: Record<string, string>; Vp: number[] }[] = [];
  /** Per `drawElementsInstanced`: the live uniforms. The records themselves are on
   *  `InstancedDraws`, which `FakeGl` fills. */
  InstU: Record<string, string>[] = [];
  private _prog = '';
  private _vp: number[] = [0, 0, 0, 0];

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
    this.viewport = ((x: number, y: number, w: number, h: number): void => {
      this._vp = [x, y, w, h];
    }) as never;
    const draw = this.drawElements;
    this.drawElements = ((): never => {
      this.Draws.push({ U: this._live(), Vp: [...this._vp] });
      return (draw as () => void)() as never;
    }) as never;
    const drawInst = this.drawElementsInstanced;
    this.drawElementsInstanced = ((
      mode: number, count: number, type: number, offset: number, primCount: number,
    ): never => {
      this.InstU.push(this._live());
      return (drawInst as (...a: number[]) => void)(mode, count, type, offset, primCount) as never;
    }) as never;
  }

  private _live = (): Record<string, string> => {
    const u: Record<string, string> = {};
    for (const [k, v] of this.Live) {
      if (k.startsWith(`${this._prog}:`)) u[k.slice(this._prog.length + 1)] = v;
    }
    return u;
  };

  get Binds(): number { return this.Calls.filter((c) => c === 'invalidateFramebuffer').length; }
  get PlainDraws(): number { return this.Calls.filter((c) => c === 'drawElements').length; }
  get InstDraws(): number { return this.Calls.filter((c) => c === 'drawElementsInstanced').length; }
}

const NewPass = (instanced: boolean): { gl: ArmGl; pass: BlurPass } => {
  const gl = new ArmGl();
  const pass = new BlurPass(gl.Gl, undefined, 1, { MaxChains: 8, BudgetBytes: ATLAS_BUDGET_BYTES });
  pass.AtlasInstanced = instanced;
  return { gl, pass };
};

/** Run one atlas build on one arm and hand back everything both arms can be compared through. */
const Build = (instanced: boolean, regions: BackdropRect[] = FILL_REGIONS) => {
  const { Build: members, AtlasW, AtlasH } = MembersFor(regions);
  const { gl, pass } = NewPass(instanced);
  const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
  gl.Reset();
  pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, members, AtlasW, AtlasH);
  return { gl, pass, members, AtlasW, AtlasH };
};

/** The instance record, by the names `VERT_INST` reads it under. */
const Rec = (r: number[]) => ({
  Dst: r.slice(0, 4),
  Src: r.slice(4, 8).join(','),
  Slot: r.slice(8, 12).join(','),
  Clamp: r.slice(12, 16).join(','),
  Hp: r.slice(16, 18).join(','),
});

/** `gl.uniform4f` rounds its arguments to fp32 and so does a `Float32Array` store, so a uniform
 *  recorded as a JS double has to be rounded the same way before the two can be compared. */
const F = (csv: string): string => csv.split(',').map((n) => Math.fround(Number(n))).join(',');

const SRC = (): string =>
  readFileSync(join(__dirname, '../src/Core/BlurPass.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('one instanced draw per level, and the SAME draws', () => {
  it('issues 4 draws where the per-slot arm issues 80, and binds the same 4 targets', () => {
    const inst = Build(true);
    const slot = Build(false);
    // The binds -- the encoder-opening ones, which is what the atlas itself bought -- do not move.
    // This arm is about the DRAWS and must leave every other column where it found it.
    expect(inst.gl.Binds).toBe(2 * DEPTH);
    expect(slot.gl.Binds).toBe(2 * DEPTH);
    expect(inst.gl.InstDraws).toBe(2 * DEPTH);
    expect(inst.gl.PlainDraws).toBe(0);
    expect(slot.gl.PlainDraws).toBe(2 * DEPTH * 20);
    expect(slot.gl.InstDraws).toBe(0);
    // `AtlasDraws` is the engine's own count, and it is the effect field for the whole cell.
    expect(inst.pass.AtlasDraws).toBe(2 * DEPTH);
    expect(slot.pass.AtlasDraws).toBe(2 * DEPTH * 20);
  });

  it('every instanced draw carries all twenty members, so nothing is quietly dropped', () => {
    // A draw that instanced ONE member would read as 4 draws on the column under test and paint
    // one card -- the vacuous shape, and the only one the counter cannot rule out alone.
    const { gl } = Build(true);
    expect(gl.InstancedDraws.length).toBe(HOPS);
    for (const d of gl.InstancedDraws) expect(d.Count).toBe(20);
  });

  it('two phases are 8 instanced draws against 160, which is the lane in one line', () => {
    const fills = MembersFor(FILL_REGIONS);
    const rims = MembersFor(RIM_REGIONS);
    for (const instanced of [true, false]) {
      const { gl, pass } = NewPass(instanced);
      const src = gl.MakeSource(CANVAS_W, CANVAS_H, 'scene');
      gl.Reset();
      let draws = 0;
      pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, fills.Build, fills.AtlasW, fills.AtlasH);
      draws += pass.AtlasDraws;
      pass.BlurAtlas(src as never, CANVAS_W, CANVAS_H, RADIUS, rims.Build, rims.AtlasW, rims.AtlasH);
      draws += pass.AtlasDraws;
      expect(gl.Binds, `binds instanced=${instanced}`).toBe(8);
      expect(draws, `draws instanced=${instanced}`).toBe(instanced ? 8 : 160);
    }
  });

  it('uploads the whole build ONCE, not once a hop', () => {
    // One `bufferData` per build rather than one per hop: a mid-frame write to a buffer a draw is
    // still reading is the one way this path could cost more than it saves, and orphaning the
    // storage once is how it is avoided.
    const body = arrowBody(SRC(), '_atlasInstanced');
    expect((body.match(/gl\.bufferData\(/g) ?? []).length).toBe(1);
  });
});

describe("every instance record is the per-slot arm's uniforms, hop for hop", () => {
  it('carries the same u_SrcRect, u_Slot, u_Clamp and u_HalfPixel for all twenty at all four hops', () => {
    // The strongest statement this harness can make about the pixels, and the same statement
    // `Blur.Atlas.Wired.test.ts` makes about the atlas against twenty standalone builds: the
    // numbers the kernel reads are the same numbers. 20 members x 4 hops x 4 fields.
    const inst = Build(true);
    const slot = Build(false);
    for (let h = 0; h < HOPS; h++) {
      for (let m = 0; m < 20; m++) {
        const got = Rec(inst.gl.InstancedDraws[h].Records[m]);
        const want = slot.gl.Draws[h * 20 + m].U;
        expect(got.Src, `hop ${h} member ${m} src`).toBe(F(want.u_SrcRect));
        expect(got.Hp, `hop ${h} member ${m} halfPixel`).toBe(F(want.u_HalfPixel));
        if (h === 0) {
          // The one hop that reads the SCENE takes the plain tap, so there is no slot to carry --
          // and zeros, rather than a plausible-looking value nothing consumes.
          expect(want.u_Slot, `hop 0 member ${m} is the plain kernel`).toBeUndefined();
          expect(got.Slot).toBe('0,0,0,0');
          expect(got.Clamp).toBe('0,0,0,0');
        } else {
          expect(got.Slot, `hop ${h} member ${m} slot`).toBe(F(want.u_Slot));
          expect(got.Clamp, `hop ${h} member ${m} clamp`).toBe(F(want.u_Clamp));
        }
      }
    }
  });

  it('keeps the tap scale a UNIFORM, at the per-slot arm’s value, because it does not vary', () => {
    // `u_Offset` is one float for the whole build and `u_Tex` is one texture unit. Instancing them
    // would be twenty copies of one number; they stay uniforms, and they stay the same numbers.
    const inst = Build(true);
    const slot = Build(false);
    for (let h = 0; h < HOPS; h++) {
      expect(inst.gl.InstU[h].u_Offset, `hop ${h} offset`).toBe(slot.gl.Draws[h * 20].U.u_Offset);
      expect(inst.gl.InstU[h].u_Tex, `hop ${h} sampler`).toBe(slot.gl.Draws[h * 20].U.u_Tex);
    }
  });

  it('is the destination LEVEL’s size in the one uniform that is new', () => {
    // `u_DstSize` is what turns a slot rect in level pixels into clip space, and it must be the
    // level the pass is bound to -- an atlas-sized value at level 2 would place every quad at a
    // quarter scale, which is a resample that looks like a blur.
    const { gl, AtlasW, AtlasH } = Build(true);
    for (let h = 0; h < HOPS; h++) {
      const level = h < DEPTH ? h + 1 : 2 * DEPTH - 1 - h;
      expect(gl.InstU[h].u_DstSize, `hop ${h}`).toBe(`${AtlasW >> level},${AtlasH >> level}`);
    }
  });
});

describe('the destination: an instanced quad where the viewport was', () => {
  it("each instance's a_Dst is exactly the viewport the per-slot arm set", () => {
    const inst = Build(true);
    const slot = Build(false);
    for (let h = 0; h < HOPS; h++) {
      for (let m = 0; m < 20; m++) {
        const dst = Rec(inst.gl.InstancedDraws[h].Records[m]).Dst;
        expect(dst, `hop ${h} member ${m}`).toEqual(slot.gl.Draws[h * 20 + m].Vp);
      }
    }
  });

  it('places every corner on the integer pixel the viewport transform placed it on', () => {
    // THE GEOMETRIC CLAIM, run rather than asserted. The per-slot arm's quad corners land on
    // window coordinates `slotX` and `slotX + slotW` EXACTLY: `gl_Position = a * 2 - 1` with `a`
    // in {0, 1} is exact, and the viewport transform of -1 and +1 is the viewport's own edge. The
    // instanced arm computes `(dst.x + a * dst.w) / levelSize * 2 - 1` in fp32 and hands it to a
    // viewport of the whole level. The two agree to within a rounding of the divide -- and the
    // rasterizer snaps vertex positions to a 1/16 or 1/256 subpixel grid before it computes either
    // coverage or barycentrics, so a disagreement under half a subpixel cannot move a snapped
    // value that starts on an integer boundary. Same snapped vertices, same covered fragments,
    // same `v_Uv` at each of them.
    const f = Math.fround;
    const { gl, AtlasW, AtlasH } = Build(true);
    // The window coordinate the instanced arm's vertex shader produces, through a viewport of
    // (0, 0, size, size): the shader's own expression, then GL's viewport transform.
    const windowPx = (origin: number, extent: number, a: number, size: number): number => {
      const ndc = f(f(f(origin + f(a * extent)) / size) * 2 - 1);
      const half = f(size / 2);
      return f(f(ndc * half) + half);
    };
    let worst = 0;
    for (let h = 0; h < HOPS; h++) {
      const level = h < DEPTH ? h + 1 : 2 * DEPTH - 1 - h;
      const lw = AtlasW >> level, lh = AtlasH >> level;
      for (let m = 0; m < 20; m++) {
        const [dx, dy, dw, dh] = Rec(gl.InstancedDraws[h].Records[m]).Dst;
        for (const a of [0, 1]) {
          worst = Math.max(worst, Math.abs(windowPx(dx, dw, a, lw) - (dx + a * dw)));
          worst = Math.max(worst, Math.abs(windowPx(dy, dh, a, lh) - (dy + a * dh)));
        }
      }
    }
    // Half of a 1/256 subpixel is 0.00195: the threshold at which a snapped integer could move.
    // The measured worst case is orders below it, and the assertion is stated against the
    // threshold rather than against the measurement so it fails for the right reason.
    expect(worst).toBeLessThan(0.00195 / 4);
  });

  it('never sets a per-slot viewport, because the quad IS the slot', () => {
    // A stray `gl.viewport` per member would be the per-slot arm wearing this one's name -- and it
    // is the call the lever removes 152 of.
    const src = SRC();
    const body = arrowBody(src, '_atlasInstanced');
    expect(body).not.toContain('gl.viewport(');
    // ...while the per-slot arm still does, once per member per level.
    expect(arrowBody(src, '_atlasPerSlot')).toContain('gl.viewport(m.Slot.X >> 1');
  });
});

describe('the kernels: the same taps, reading varyings instead of uniforms', () => {
  it('expands TAP to the slot tap with the same operands in the same order', () => {
    const src = SRC();
    expect(src).toContain('#define TAP(p) textureLod(u_Tex, u_Slot.xy + clamp((p), u_Clamp.xy, u_Clamp.zw) * u_Slot.zw, 0.0)');
    expect(src).toContain('#define TAP(p) textureLod(u_Tex, v_Slot.xy + clamp((p), v_Clamp.xy, v_Clamp.zw) * v_Slot.zw, 0.0)');
    // And the kernel BODY is untouched: the half-pixel arrives as a flat varying and is `#define`d
    // back to the name the body has always used, so `u_HalfPixel * u_Offset` is still what a
    // driver compiles.
    expect(src).toContain('#define u_HalfPixel v_HalfPixel');
    expect(src).toContain('vec2 hp = u_HalfPixel * u_Offset;');
  });

  it('declares every instanced varying FLAT and HIGHP in both stages', () => {
    // `flat` is what makes a per-instance value a per-instance value: no interpolation arithmetic
    // runs on it, so the fragment shader reads the float the vertex shader was handed. An explicit
    // `highp` on both sides means the two stages cannot disagree about which float that is -- the
    // default is highp in both, and a default is not a contract.
    const src = SRC();
    for (const v of ['v_Slot', 'v_Clamp', 'v_HalfPixel']) {
      const type = v === 'v_HalfPixel' ? 'vec2' : 'vec4';
      expect(src, `${v} out`).toContain(`flat out highp ${type} ${v};`);
      expect(src, `${v} in`).toContain(`flat in highp ${type} ${v}`);
    }
  });

  it("builds the three instanced programs in the constructor's batch", () => {
    // Lazily, the compile would land on the first frame with glass on it -- which is the frame
    // every boot measurement reads. Same rule the slot kernels are built under.
    const src = SRC();
    expect(src).toContain('this._downInst = b.Add(VERT_INST, DOWN_FRAG(TAP_PLAIN, HP_INST));');
    expect(src).toContain('this._downSlotInst = b.Add(VERT_INST, DOWN_FRAG(TAP_SLOT_INST, HP_INST));');
    expect(src).toContain('this._upSlotInst = b.Add(VERT_INST, UP_FRAG(TAP_SLOT_INST, HP_INST));');
  });

  it('leaves the shipping kernel textually what it was', () => {
    // The unflagged engine is `?pyramid-atlas=off` now, and it compiles `DOWN_FRAG(TAP_PLAIN)`
    // with its default half-pixel declaration -- the same source text, character for character.
    const src = SRC();
    expect(src).toContain("const TAP_PLAIN = '#define TAP(p) textureLod(u_Tex, (p), 0.0)';");
    expect(src).toContain('this._down = b.Add(VERT, DOWN_FRAG(TAP_PLAIN));');
    expect(src).toContain('this._up = b.Add(VERT, UP_FRAG(TAP_PLAIN));');
    expect(src).toContain("const HP_DOWN = 'uniform vec2 u_HalfPixel;     // half-texel size of the SOURCE';");
  });

  it('gives the instanced path its own VAO rather than divisors on the shared quad', () => {
    // `QuadGeometry`'s VAO is bound by a dozen draw sites in this engine; attribute divisors are
    // VAO state, and a divisor left on the shared quad would be a blast radius nobody asked for.
    const body = arrowBody(SRC(), '_ensureInstanceVao');
    expect(body).toContain('gl.vertexAttribDivisor(a, 1);');
    expect(body).toContain('new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])');
    expect(body).toContain('new Uint16Array([0, 1, 2, 2, 1, 3])');
    expect(body).not.toContain('this._quad');
  });
});

describe('the flag', () => {
  const JAUI = (): string =>
    readFileSync(join(__dirname, '../src/Core/Jaui.ts'), 'utf8').replace(/\r\n/g, '\n');

  it('is ON by default and takes `on` or `off` and nothing else', () => {
    const jaui = JAUI();
    expect(jaui).toContain('private _atlasInstanced: boolean = true;');
    expect(jaui).toContain("this._atlasInstanced = raw !== 'off';");
    expect(jaui).toContain("?atlas-instanced takes 'on' or 'off'");
    expect(jaui).toContain("raw !== '' && raw !== 'on' && raw !== 'off'");
  });

  it('marks the arm, says whether there is an atlas to instance, and claims SAME pixels', () => {
    const jaui = JAUI();
    expect(jaui).toContain("jaui:atlas-instanced armed=${this._atlasInstanced ? 'on' : 'off'}");
    expect(jaui).toContain('inert=${!this._pyramidAtlas} pixels=SAME');
  });

  it('reaches the renderer, and the renderer reaches the pass PER BUILD', () => {
    expect(JAUI()).toContain('this._renderer.DiagAtlasInstanced = this._atlasInstanced;');
    const renderer = readFileSync(join(__dirname, '../src/Core/WebGL2.Renderer.ts'), 'utf8').replace(/\r\n/g, '\n');
    const compute = arrowBody(renderer, 'ComputeBlurAtlas');
    expect(compute).toContain('pass.AtlasInstanced = this.DiagAtlasInstanced;');
    expect(compute).toContain('this._sceneLedger.NoteAtlasDraws(pass.AtlasDraws);');
  });

  it('carries the draw count on the ledger, per frame', () => {
    const ledger = readFileSync(join(__dirname, '../src/Core/Scene.Ledger.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(ledger).toContain('AtlasDraws = 0;');
    expect(ledger).toContain('NoteAtlasDraws = (n: number): void => { this.AtlasDraws += n; };');
    // Reset every frame, or the column is a boot total wearing a frame's name.
    const begin = ledger.slice(ledger.indexOf('BeginFrame = ('), ledger.indexOf('NoteWrite'));
    expect(begin).toContain('this.AtlasDraws = 0;');
  });
});
