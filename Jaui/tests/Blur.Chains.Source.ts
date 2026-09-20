/**
 * A recording WebGL2 stand-in for `BlurPass`, built for one question: does rotating the level-chain
 * pool change a texel?
 *
 * There is no rasteriser here and there does not need to be one. Every pass in `BlurPass` covers its
 * whole destination and reads one source texture through uniforms, so a draw is a PURE FUNCTION of
 * (program, that program's uniforms, the value of the bound source). This fake gives each texture
 * level a symbolic value and applies exactly that function, so two builds agree here if and only if
 * they would agree on a GPU. What it deliberately does NOT model is filtering arithmetic — which is
 * fine, because the rotation changes no uniform, no source and no program, and the claim under test
 * is that it changes no INPUT to that function either.
 *
 * It also records every write in order, which is what turns "the same pixels" into an assertion:
 * two builds are identical when the ordered list of (destination size, value) they write is.
 */

interface FakeTexture {
  Id: number;
  /** level -> { W, H, Value }. `Value` is whatever the last write left there. */
  Levels: Map<number, { W: number; H: number; Value: string }>;
  Alive: boolean;
}

interface FakeFramebuffer {
  Id: number;
  Attachment: { Tex: FakeTexture; Level: number } | null;
  Alive: boolean;
}

interface FakeProgram {
  Id: number;
  /** The concatenated sources, so DOWN, UP and COPY are distinguishable without naming them. */
  Tag: string;
  Uniforms: Map<string, string>;
}

/** A buffer, and whatever was last uploaded into it. The instanced atlas path puts everything a
 *  slot draw used to set as uniforms in here, so a fake that dropped the upload would be blind to
 *  the very numbers that decide whether the two arms agree. */
interface FakeBuffer {
  Id: number;
  Data: Float32Array | null;
}

/** One instanced draw: how many instances, and the per-instance records it drew them from. */
export interface FakeInstancedDraw {
  Count: number;
  /** `INST_FLOATS`-wide records, one per instance, decoded from the bound buffer at the offset
   *  attribute 1 was pointed at. */
  Records: number[][];
}

/** One recorded write: where it landed, how big it was, and what value it left. */
export interface FakeWrite {
  Kind: 'draw' | 'blit';
  Tex: number;
  Level: number;
  W: number;
  H: number;
  Value: string;
}

/** FNV-1a. A draw's value composes its whole history, so it has to be bounded or a depth-3
 *  pyramid's strings grow past anything readable in a failure message. */
const Hash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

let _enum = 0x1000;
const E = (): number => ++_enum;

export class FakeGl {
  // ── Enums. Distinct numbers are all any caller here needs of them. ──
  readonly TEXTURE_2D = E();
  readonly RGBA = E();
  readonly RGB10_A2 = E();
  readonly UNSIGNED_BYTE = E();
  readonly UNSIGNED_INT_2_10_10_10_REV = E();
  readonly UNSIGNED_SHORT = E();
  readonly TEXTURE_MIN_FILTER = E();
  readonly TEXTURE_MAG_FILTER = E();
  readonly TEXTURE_WRAP_S = E();
  readonly TEXTURE_WRAP_T = E();
  readonly TEXTURE_MAX_LEVEL = E();
  readonly LINEAR = E();
  readonly LINEAR_MIPMAP_LINEAR = E();
  readonly CLAMP_TO_EDGE = E();
  readonly FRAMEBUFFER = E();
  readonly READ_FRAMEBUFFER = E();
  readonly DRAW_FRAMEBUFFER = E();
  readonly READ_FRAMEBUFFER_BINDING = E();
  readonly DRAW_FRAMEBUFFER_BINDING = E();
  readonly COLOR_ATTACHMENT0 = E();
  readonly DEPTH_STENCIL_ATTACHMENT = E();
  readonly DEPTH24_STENCIL8 = E();
  readonly RENDERBUFFER = E();
  readonly FRAMEBUFFER_COMPLETE = E();
  readonly COLOR_BUFFER_BIT = E();
  readonly NEAREST = E();
  readonly BLEND = E();
  readonly SCISSOR_TEST = E();
  readonly TEXTURE0 = E();
  readonly TRIANGLES = E();
  readonly ARRAY_BUFFER = E();
  readonly ELEMENT_ARRAY_BUFFER = E();
  readonly STATIC_DRAW = E();
  readonly DYNAMIC_DRAW = E();
  readonly FLOAT = E();
  readonly VERTEX_SHADER = E();
  readonly FRAGMENT_SHADER = E();
  readonly COMPILE_STATUS = E();
  readonly LINK_STATUS = E();
  readonly ACTIVE_UNIFORMS = E();
  readonly ACTIVE_ATTRIBUTES = E();

  // ── Recording ──
  /** Every write since the last `Reset`, in order. */
  Writes: FakeWrite[] = [];
  /** Every entry point called since the last `Reset`, by name. */
  Calls: string[] = [];
  /** Every instanced draw since the last `Reset`, with the records it read. */
  InstancedDraws: FakeInstancedDraw[] = [];

  private _nextId = 1;
  private _textures = new Map<number, FakeTexture>();
  private _boundTex: FakeTexture | null = null;
  private _draw: FakeFramebuffer | null = null;
  private _read: FakeFramebuffer | null = null;
  private _program: FakeProgram | null = null;
  private _shaderSrc = new Map<object, string>();
  private _locNames = new Map<object, string>();
  private _arrayBuf: FakeBuffer | null = null;
  private _instStride = 0;
  private _instOffset = 0;

  Reset = (): void => { this.Writes = []; this.Calls = []; this.InstancedDraws = []; };

  /** The symbolic contents of a texture level — what a consumer would sample. */
  ValueOf = (tex: object, level = 0): string => {
    const t = tex as FakeTexture;
    return t.Levels.get(level)?.Value ?? 'unallocated';
  };

  /** Seed a texture the pass can read as its input. */
  MakeSource = (w: number, h: number, value: string): FakeTexture => {
    const t = this.createTexture();
    t.Levels.set(0, { W: w, H: h, Value: value });
    return t;
  };

  private _call = (name: string): void => { this.Calls.push(name); };

  // ── Textures ──
  createTexture = (): FakeTexture => {
    this._call('createTexture');
    const t: FakeTexture = { Id: this._nextId++, Levels: new Map(), Alive: true };
    this._textures.set(t.Id, t);
    return t;
  };
  deleteTexture = (t: FakeTexture | null): void => { this._call('deleteTexture'); if (t) t.Alive = false; };
  bindTexture = (_target: number, t: FakeTexture | null): void => { this._boundTex = t; };
  texParameteri = (): void => { /* filter and clamp state changes no value here */ };
  texImage2D = (
    _target: number, level: number, _ifmt: number, w: number, h: number,
    _border: number, _fmt: number, _type: number, _data: unknown,
  ): void => {
    this._call('texImage2D');
    if (!this._boundTex) throw new Error('texImage2D with no bound texture');
    this._boundTex.Levels.set(level, { W: w, H: h, Value: `empty:${w}x${h}` });
  };

  // ── Framebuffers ──
  createFramebuffer = (): FakeFramebuffer => {
    this._call('createFramebuffer');
    return { Id: this._nextId++, Attachment: null, Alive: true };
  };
  deleteFramebuffer = (f: FakeFramebuffer | null): void => { this._call('deleteFramebuffer'); if (f) f.Alive = false; };
  bindFramebuffer = (target: number, f: FakeFramebuffer | null): void => {
    if (target === this.FRAMEBUFFER) { this._draw = f; this._read = f; return; }
    if (target === this.DRAW_FRAMEBUFFER) { this._draw = f; return; }
    if (target === this.READ_FRAMEBUFFER) { this._read = f; return; }
    throw new Error(`bindFramebuffer: unknown target ${target}`);
  };
  framebufferTexture2D = (target: number, _att: number, _texTarget: number, t: FakeTexture | null, level: number): void => {
    const fb = target === this.READ_FRAMEBUFFER ? this._read : this._draw;
    if (!fb) throw new Error('framebufferTexture2D with no bound framebuffer');
    fb.Attachment = t === null ? null : { Tex: t, Level: level };
  };
  checkFramebufferStatus = (): number => this.FRAMEBUFFER_COMPLETE;
  createRenderbuffer = (): object => ({ Id: this._nextId++ });
  deleteRenderbuffer = (): void => { /* BlurPass never asks for depth */ };
  bindRenderbuffer = (): void => { /* ditto */ };
  renderbufferStorage = (): void => { /* ditto */ };
  framebufferRenderbuffer = (): void => { /* ditto */ };
  invalidateFramebuffer = (): void => { this._call('invalidateFramebuffer'); };
  getParameter = (p: number): unknown => {
    if (p === this.READ_FRAMEBUFFER_BINDING) return this._read;
    if (p === this.DRAW_FRAMEBUFFER_BINDING) return this._draw;
    throw new Error(`getParameter: unknown pname ${p}`);
  };

  // ── Shaders and programs ──
  getExtension = (): null => null;
  createShader = (type: number): object => { const s = { Type: type }; this._shaderSrc.set(s, ''); return s; };
  shaderSource = (s: object, src: string): void => { this._shaderSrc.set(s, src); };
  compileShader = (): void => { /* always succeeds */ };
  deleteShader = (): void => { /* no-op */ };
  getShaderParameter = (): boolean => true;
  getShaderInfoLog = (): string => '';
  createProgram = (): FakeProgram => ({ Id: this._nextId++, Tag: '', Uniforms: new Map() });
  attachShader = (p: FakeProgram, s: object): void => { p.Tag += Hash(this._shaderSrc.get(s) ?? ''); };
  linkProgram = (): void => { /* always succeeds */ };
  deleteProgram = (): void => { /* no-op */ };
  getProgramParameter = (_p: FakeProgram, pname: number): unknown => {
    if (pname === this.LINK_STATUS) return true;
    if (pname === this.ACTIVE_UNIFORMS || pname === this.ACTIVE_ATTRIBUTES) return 0;
    throw new Error(`getProgramParameter: unknown pname ${pname}`);
  };
  getProgramInfoLog = (): string => '';
  getActiveUniform = (): null => null;
  getActiveAttrib = (): null => null;
  getAttribLocation = (): number => 0;
  getUniformLocation = (p: FakeProgram, name: string): object => {
    const loc = { P: p.Id, N: name };
    this._locNames.set(loc, name);
    return loc;
  };
  useProgram = (p: FakeProgram | null): void => { this._program = p; };

  private _uniform = (loc: object | null, value: string): void => {
    if (loc === null || !this._program) return;
    this._program.Uniforms.set(this._locNames.get(loc) ?? 'unknown', value);
  };
  uniform1i = (loc: object | null, a: number): void => this._uniform(loc, String(a));
  uniform1f = (loc: object | null, a: number): void => this._uniform(loc, String(a));
  uniform2f = (loc: object | null, a: number, b: number): void => this._uniform(loc, `${a},${b}`);
  uniform4f = (loc: object | null, a: number, b: number, c: number, d: number): void =>
    this._uniform(loc, `${a},${b},${c},${d}`);

  // ── Geometry and state ──
  createBuffer = (): FakeBuffer => ({ Id: this._nextId++, Data: null });
  bindBuffer = (target: number, b: FakeBuffer | null): void => {
    if (target === this.ARRAY_BUFFER) this._arrayBuf = b;
  };
  bufferData = (target: number, data: unknown): void => {
    if (target !== this.ARRAY_BUFFER || this._arrayBuf === null) return;
    this._arrayBuf.Data = data instanceof Float32Array ? new Float32Array(data) : null;
  };
  createVertexArray = (): object => ({ Id: this._nextId++ });
  bindVertexArray = (): void => { /* no-op */ };
  enableVertexAttribArray = (): void => { /* no-op */ };
  /** Only attribute 1's byte offset is kept, and that is enough: every per-instance attribute in
   *  `BlurPass` is pointed at the same hop's slice of the same buffer with the same stride, so
   *  attribute 1's offset names the hop. */
  vertexAttribPointer = (
    index: number, _size: number, _type: number, _norm: boolean, stride?: number, offset?: number,
  ): void => {
    if (index !== 1) return;
    this._instStride = stride ?? 0;
    this._instOffset = offset ?? 0;
  };
  vertexAttribDivisor = (): void => { this._call('vertexAttribDivisor'); };
  disable = (): void => { /* no-op */ };
  enable = (): void => { /* no-op */ };
  activeTexture = (): void => { /* one unit is the only one BlurPass uses */ };
  viewport = (): void => { /* the quad always covers the whole destination */ };

  // ── The one call that carries meaning ──
  drawElements = (): void => {
    this._call('drawElements');
    const dst = this._draw?.Attachment;
    if (!dst) throw new Error('drawElements with no colour attachment');
    if (!this._program) throw new Error('drawElements with no program');
    if (!this._boundTex) throw new Error('drawElements with no source texture');
    const level = dst.Tex.Levels.get(dst.Level);
    if (!level) throw new Error('drawElements into an unallocated level');
    const uniforms = [...this._program.Uniforms].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`).join(',');
    const src = this.ValueOf(this._boundTex, 0);
    level.Value = Hash(`${this._program.Tag}|${uniforms}|${src}|${level.W}x${level.H}`);
    this.Writes.push({ Kind: 'draw', Tex: dst.Tex.Id, Level: dst.Level, W: level.W, H: level.H, Value: level.Value });
  };

  /** One instanced draw is the fake's one draw with the instance records folded into the value it
   *  writes. It has to be: the per-instance attributes are the uniforms the per-slot arm set, so a
   *  write that ignored them would report two builds identical whatever the buffer held. */
  drawElementsInstanced = (
    _mode: number, _count: number, _type: number, _offset: number, primCount: number,
  ): void => {
    this._call('drawElementsInstanced');
    const dst = this._draw?.Attachment;
    if (!dst) throw new Error('drawElementsInstanced with no colour attachment');
    if (!this._program) throw new Error('drawElementsInstanced with no program');
    if (!this._boundTex) throw new Error('drawElementsInstanced with no source texture');
    if (!this._arrayBuf?.Data) throw new Error('drawElementsInstanced with no instance data');
    const level = dst.Tex.Levels.get(dst.Level);
    if (!level) throw new Error('drawElementsInstanced into an unallocated level');
    const wide = this._instStride / 4;
    const base = this._instOffset / 4;
    const records: number[][] = [];
    for (let i = 0; i < primCount; i++) {
      records.push([...this._arrayBuf.Data.subarray(base + i * wide, base + (i + 1) * wide)]);
    }
    const uniforms = [...this._program.Uniforms].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`).join(',');
    const src = this.ValueOf(this._boundTex, 0);
    level.Value = Hash(`${this._program.Tag}|${uniforms}|${records.join(';')}|${src}|${level.W}x${level.H}`);
    this.Writes.push({ Kind: 'draw', Tex: dst.Tex.Id, Level: dst.Level, W: level.W, H: level.H, Value: level.Value });
    this.InstancedDraws.push({ Count: primCount, Records: records });
  };

  blitFramebuffer = (
    _sx0: number, _sy0: number, _sx1: number, _sy1: number,
    _dx0: number, _dy0: number, _dx1: number, _dy1: number,
    _mask: number, _filter: number,
  ): void => {
    this._call('blitFramebuffer');
    const src = this._read?.Attachment;
    const dst = this._draw?.Attachment;
    if (!src || !dst) throw new Error('blitFramebuffer with an incomplete pair');
    const from = src.Tex.Levels.get(src.Level);
    const to = dst.Tex.Levels.get(dst.Level);
    if (!from || !to) throw new Error('blitFramebuffer over an unallocated level');
    to.Value = from.Value;
    this.Writes.push({ Kind: 'blit', Tex: dst.Tex.Id, Level: dst.Level, W: to.W, H: to.H, Value: to.Value });
  };

  /** The recorded writes with the TEXTURE IDENTITY dropped — what a consumer can see. Two builds
   *  that agree on this agree on every texel a shader could read; they differ only in which
   *  framebuffer object the result happens to live in, which is precisely what rotating changes. */
  get Texels(): string[] {
    return this.Writes.map(w => `${w.Kind} ${w.Level} ${w.W}x${w.H} ${w.Value}`);
  }

  /** Cast for the passes under test. */
  get Gl(): WebGL2RenderingContext { return this as unknown as WebGL2RenderingContext; }
}
