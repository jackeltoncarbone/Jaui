import { FakeGl } from './Blur.Chains.Source';

/**
 * A TEXEL-EXACT recording GL for one question about `?glass-gaussian`: does either pass ever read a
 * texel that the pass which last wrote its texture did not write?
 *
 * `FakeGl` answers "is the VALUE the same" and treats every draw as covering its whole destination,
 * which is exactly the assumption under test here, so it cannot be the instrument. This wraps it and
 * keeps, per texture, one stamp PER TEXEL:
 *
 *   -1  GARBAGE   `invalidateFramebuffer` was called and nothing has written it since -- Metal's
 *                 `LoadAction.DontCare`, whatever the tile memory held. Reading one is the defect.
 *    0  ZERO      `texImage2D(null)` -- WebGL zero-fills, so defined, but no pass's output.
 *   >0  a draw    the serial of the draw that last wrote it (or `SOURCE` for a seeded input).
 *
 * A draw stamps the texels its VIEWPORT covers (the quad is the whole viewport), a `clear` stamps the
 * whole attachment (scissor is off on every path here) with its own serial, and `invalidate` stamps
 * GARBAGE. For a Gaussian draw the READ footprint is computed from the uniforms the pass actually
 * uploaded -- `u_SrcRect`, `u_Step`, `u_Off`, `u_Fetches` -- and the destination's viewport, with the
 * bilinear footprint of every fetch at every destination pixel, `CLAMP_TO_EDGE`, and the GPU's 8-bit
 * sub-texel weight quantisation (a neighbour whose weight rounds to 0/256 is not read). The footprint
 * is separable because one axis of `u_Step` is always zero, so it is the product of a row set and a
 * column set and costs one pass over each axis.
 *
 * WHAT IT CANNOT MODEL, said once: rasterisation (it assumes the two triangles cover the viewport
 * exactly, which the top-left rule guarantees), a driver or tiler that does not honour an ordered
 * write-then-read within one context, and anything outside the Gaussian's two targets and its input.
 */

export const SOURCE = 1 << 30;

interface Tex { Levels: Map<number, { W: number; H: number }> }
interface Fb { Attachment: { Tex: Tex; Level: number } | null }
interface Loc { P: number; N: string }

export interface CoverDraw {
  Serial: number;
  Gaussian: boolean;
  Dst: Tex;
  DstW: number;
  DstH: number;
  Src: Tex | null;
  /** Inclusive texel bounds the draw READ in its source (Gaussian draws only). */
  Rows: [number, number];
  Cols: [number, number];
  /** Texels read whose stamp was not the source's latest write. 0 is the whole claim. */
  StaleReads: number;
  GarbageReads: number;
  /** `uniform1fv` lengths and `u_Fetches` at the draw -- candidate (d). */
  OffLen: number;
  WtLen: number;
  Fetches: number;
}

export class CoverGl {
  readonly Fake = new FakeGl();
  readonly Draws: CoverDraw[] = [];
  /** Every call the wrapped pass made, by name, in order -- the sequence candidate (c) is read off. */
  readonly Seq: string[] = [];
  readonly COLOR_CLEAR_VALUE = 0x0c22;
  /** The NEGATIVE CONTROL's lever: rewrite a viewport before it takes effect, so a test can make a
   *  pass leave rows unwritten and prove the instrument sees it. Null on every real reading. */
  ViewportHook: ((vp: [number, number, number, number]) => [number, number, number, number]) | null = null;
  private _stamps = new Map<Tex, Int32Array>();
  private _latest = new Map<Tex, number>();
  /** Textures whose EVERY stamp equals `_latest` -- the common case, answered without a scan. */
  private _whole = new Set<Tex>();
  private _serial = 0;
  private _draw: Fb | null = null;
  private _tex: Tex | null = null;
  private _program: object | null = null;
  private _uniforms = new Map<object, Map<string, number[]>>();
  private _vp: [number, number, number, number] = [0, 0, 0, 0];
  private _clear: [number, number, number, number] = [0, 0, 0, 0];
  readonly Gl: WebGL2RenderingContext;

  constructor() {
    const fake = this.Fake as unknown as Record<string | symbol, unknown>;
    const own: Record<string, unknown> = {
      COLOR_CLEAR_VALUE: this.COLOR_CLEAR_VALUE,
      bindFramebuffer: (target: number, f: Fb | null) => {
        this.Seq.push('bindFramebuffer');
        if (target !== this.Fake.READ_FRAMEBUFFER) this._draw = f;
        this.Fake.bindFramebuffer(target, f as never);
      },
      bindTexture: (target: number, t: Tex | null) => {
        this._tex = t;
        this.Fake.bindTexture(target, t as never);
      },
      texImage2D: (...a: unknown[]) => {
        (this.Fake.texImage2D as (...x: unknown[]) => void)(...a);
        const t = this._tex!;
        if (a[1] === 0) {
          this._stamps.set(t, new Int32Array((a[3] as number) * (a[4] as number)));
          this._latest.set(t, 0);
          this._whole.add(t);
        }
      },
      useProgram: (p: object | null) => { this._program = p; this.Fake.useProgram(p as never); },
      viewport: (x: number, y: number, w: number, h: number) => {
        this._vp = this.ViewportHook === null ? [x, y, w, h] : this.ViewportHook([x, y, w, h]);
      },
      invalidateFramebuffer: () => {
        this.Seq.push('invalidateFramebuffer');
        const t = this._attached();
        this._stamps.get(t)!.fill(-1);
        this._latest.set(t, -1);
        this._whole.add(t);
      },
      clearColor: (r: number, g: number, b: number, a: number) => { this._clear = [r, g, b, a]; },
      clear: () => {
        this.Seq.push('clear');
        const t = this._attached();
        const s = ++this._serial;
        this._stamps.get(t)!.fill(s);
        this._latest.set(t, s);
        this._whole.add(t);
      },
      getParameter: (p: number) => (p === this.COLOR_CLEAR_VALUE
        ? new Float32Array(this._clear) : this.Fake.getParameter(p)),
      uniform1i: (l: Loc | null, v: number) => { this._u(l, [v]); this.Fake.uniform1i(l, v); },
      uniform1f: (l: Loc | null, v: number) => { this._u(l, [v]); this.Fake.uniform1f(l, v); },
      uniform2f: (l: Loc | null, a: number, b: number) => { this._u(l, [a, b]); this.Fake.uniform2f(l, a, b); },
      uniform4f: (l: Loc | null, a: number, b: number, c: number, d: number) => {
        this._u(l, [a, b, c, d]); this.Fake.uniform4f(l, a, b, c, d);
      },
      uniform1fv: (l: Loc | null, v: Float32Array) => { this._u(l, Array.from(v)); this.Fake.uniform1fv(l, v); },
      drawElements: (...a: unknown[]) => {
        this.Seq.push('drawElements');
        this._onDraw();
        (this.Fake.drawElements as (...x: unknown[]) => void)(...a);
      },
    };
    this.Gl = new Proxy(fake, {
      get: (target, prop) => (typeof prop === 'string' && prop in own ? own[prop] : target[prop]),
    }) as unknown as WebGL2RenderingContext;
  }

  /** Seed an input the pass reads, every texel defined. */
  MakeSource = (w: number, h: number): Tex => {
    const t = this.Fake.MakeSource(w, h, 'scene') as unknown as Tex;
    this._stamps.set(t, new Int32Array(w * h).fill(SOURCE));
    this._latest.set(t, SOURCE);
    this._whole.add(t);
    return t;
  };

  /** Texels of `tex` whose stamp is not the latest write into it -- 0 means the last pass wrote all. */
  Unwritten = (tex: object): number => {
    const t = tex as Tex;
    if (this._whole.has(t)) return 0;
    const s = this._stamps.get(t)!, want = this._latest.get(t)!;
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s[i] !== want) n++;
    return n;
  };

  /** How many texels of `tex` still carry stamp `serial` (a clear's, say). */
  Carrying = (tex: object, serial: number): number => {
    const s = this._stamps.get(tex as Tex)!;
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === serial) n++;
    return n;
  };

  get LastSerial(): number { return this._serial; }

  private _attached = (): Tex => {
    const t = this._draw?.Attachment?.Tex;
    if (!t) throw new Error('CoverGl: no colour attachment bound');
    return t;
  };

  private _u = (l: Loc | null, v: number[]): void => {
    if (l === null || this._program === null) return;
    let m = this._uniforms.get(this._program);
    if (!m) { m = new Map(); this._uniforms.set(this._program, m); }
    m.set(l.N.replace('[0]', ''), v);
  };

  private _onDraw = (): void => {
    const dst = this._attached();
    const { W: dw, H: dh } = dst.Levels.get(0)!;
    const stamps = this._stamps.get(dst)!;
    const u = this._uniforms.get(this._program!) ?? new Map<string, number[]>();
    const gaussian = u.has('u_Fetches');
    const serial = ++this._serial;
    const [vx, vy, vw, vh] = this._vp;
    const draw: CoverDraw = {
      Serial: serial, Gaussian: gaussian, Dst: dst, DstW: dw, DstH: dh, Src: this._tex,
      Rows: [0, -1], Cols: [0, -1], StaleReads: 0, GarbageReads: 0, OffLen: 0, WtLen: 0, Fetches: 0,
    };

    if (gaussian) {
      const src = this._tex!;
      if (src === dst) throw new Error('CoverGl: a Gaussian draw samples its own destination');
      const { W: sw, H: sh } = src.Levels.get(0)!;
      const rect = u.get('u_SrcRect')!, step = u.get('u_Step')!;
      const n = u.get('u_Fetches')![0];
      const off = u.get('u_Off')!, wt = u.get('u_Wt')!;
      draw.OffLen = off.length; draw.WtLen = wt.length; draw.Fetches = n;
      if (step[0] !== 0 && step[1] !== 0) throw new Error('CoverGl: a pass with a diagonal step');
      const axis = (base: number, span: number, count: number, stepUv: number, size: number): Set<number> => {
        const out = new Set<number>();
        for (let p = 0; p < count; p++) {
          const uv = base + ((p + 0.5) / count) * span;
          for (let k = 0; k < (stepUv === 0 ? 1 : n); k++) {
            const x = (uv + stepUv * (stepUv === 0 ? 0 : off[k])) * size - 0.5;
            const lo = Math.floor(x);
            const q = Math.round((x - lo) * 256);
            if (q < 256) out.add(Math.min(size - 1, Math.max(0, lo)));
            if (q > 0) out.add(Math.min(size - 1, Math.max(0, lo + 1)));
          }
        }
        return out;
      };
      const cols = axis(rect[0], rect[2], vw, step[0], sw);
      const rows = axis(rect[1], rect[3], vh, step[1], sh);
      draw.Cols = [Math.min(...cols), Math.max(...cols)];
      draw.Rows = [Math.min(...rows), Math.max(...rows)];
      const ss = this._stamps.get(src)!, latest = this._latest.get(src)!;
      if (this._whole.has(src)) {
        if (latest === -1) draw.GarbageReads = rows.size * cols.size;
      } else for (const r of rows) {
        for (const c of cols) {
          const s = ss[r * sw + c];
          if (s === -1) draw.GarbageReads++;
          else if (s !== latest) draw.StaleReads++;
        }
      }
    }

    const x0 = Math.max(0, vx), x1 = Math.min(dw, vx + vw);
    const y0 = Math.max(0, vy), y1 = Math.min(dh, vy + vh);
    for (let y = y0; y < y1; y++) stamps.fill(serial, y * dw + x0, y * dw + x1);
    this._latest.set(dst, serial);
    if (x0 === 0 && y0 === 0 && x1 === dw && y1 === dh) this._whole.add(dst);
    else this._whole.delete(dst);
    this.Draws.push(draw);
  };
}
