/**
 * ONE GPU TIMER PER PASS TYPE — and an honest account of what that can and cannot mean.
 *
 * The engine already times a WHOLE FRAME on the GPU (`WebGL2.Renderer`'s `_timerExt` ring). That
 * number says how much and never what: a frame at 9ms on a phone is a frame at 9ms whether the
 * blur pyramid ate it or the panel batch did. This splits the frame by PASS TYPE so the reading
 * names the shader that owns the time.
 *
 * WHY THE FRAME ALTERNATES, WHICH IS THE FIRST THING TO UNDERSTAND HERE.
 *
 * `TIME_ELAPSED_EXT` allows exactly ONE active query per context — queries cannot nest and cannot
 * overlap. The per-frame query is active for the whole frame, so a per-pass query CANNOT be opened
 * inside it. The two readings therefore cannot be taken on the same frame at all, and any design
 * that claims to have both for one frame is lying about one of them.
 *
 * So the frames ALTERNATE while armed: even frames run the existing whole-frame query untouched
 * (the REFERENCE), odd frames run one query per pass (the SPLIT). Both accumulate into this
 * object, and the reconciliation the report prints — sum-of-passes against the reference — is a
 * comparison of two AVERAGES over the same window, never of one frame against itself. On a steady
 * scene that is a real check; on a scene whose cost swings frame to frame it is not, and the
 * report has to say which it was looking at.
 *
 * (The extension also defines `TIMESTAMP_EXT` + `queryCounter`, which DOES nest and would give a
 * true per-pass split with no alternation. It is almost universally disabled — ANGLE over Metal
 * and over D3D both report 0 counter bits — so `CounterBits` is PROBED and reported rather than
 * assumed. A non-zero reading on some device is the signal that a better instrument is available
 * there; until one is seen, alternation is what there is.)
 *
 * WHY EVERY BRACKET CARRIES A HARD/SOFT FLAG.
 *
 * A begin/endQuery pair is a boundary in the GL COMMAND STREAM. A pass on a tile-based GPU (every
 * Apple part, every mobile part) is not. ANGLE merges adjacent draws into one Metal render-pass
 * encoder wherever the attachments and load actions allow, and the tile work for that encoder is
 * billed where the encoder RESOLVES — which may be inside the NEXT query. Two consequences, both
 * real on the M4 and on the phone:
 *
 *   • Adjacent same-target passes collapse. Panel, then shadow, then stroke, all into the scene
 *     FBO, can become ONE encoder: one query eats its neighbours' time and they read near-zero.
 *   • Bandwidth-resolve passes bill late. The blur ping-pong and the pblur pyramid pay at resolve.
 *
 * So a bracket is only trustworthy when a REAL attachment change sits on its boundary. That is not
 * asserted by hand here — it is MEASURED: `Target` is the key of the framebuffer currently bound,
 * maintained by every bind site in the renderer and in `BlurPass`, and a pass is HARD when the
 * target at its `Begin` differs from the target at the previous pass's `End`. A pass that draws
 * into the same attachment its predecessor just drew into is SOFT, and its number may contain or
 * have lost its neighbour's tile work.
 *
 * Deliberately NOT done: inserting `flush` between passes to force every boundary hard. That
 * changes the frame's cost, and the instrument would be measuring itself.
 *
 * COST. Two GL calls per bracketed pass while armed, plus one availability check per resolved
 * query. Query objects are POOLED — a glass-heavy frame opens ~100 of them and allocating that
 * many per frame would itself be the finding. Unarmed, this object is never constructed and the
 * render path pays one null check per pass entry point and no GL call whatsoever.
 */

/** The pass types, named to match `Diagnostics/Trace.ts`'s `DRAW_CLASSES` so the gesture meter's
 *  draw counts and these timings line up column for column. `blur` is split three ways because
 *  the down chain, the up chain and the mip chain are separately removable and separately priced;
 *  sum them for the meter's single `blur`. */
export type PassClass =
  | 'panel'
  | 'text'
  | 'stroke'
  | 'svg'
  | 'shadow'
  | 'snapshot'
  | 'blur-down'
  | 'blur-up'
  | 'blur-mip'
  | 'pblur'
  | 'present';

export const PASS_CLASSES: readonly PassClass[] = [
  'panel', 'text', 'stroke', 'svg', 'shadow', 'snapshot',
  'blur-down', 'blur-up', 'blur-mip', 'pblur', 'present',
];

const CLASS_INDEX: Readonly<Record<string, number>> = (() => {
  const m: Record<string, number> = {};
  PASS_CLASSES.forEach((c, i) => { m[c] = i; });
  return m;
})();

/** The target key before the frame's first pass. Never equal to a real key, so the first bracket
 *  of a frame is always HARD — correctly: the frame opens by binding and clearing the scene FBO,
 *  which is a genuine attachment change from the default framebuffer the present left bound. */
const FRAME_START = '(frame-start)';

/** Queries allowed to sit unresolved before the oldest are thrown away. A device that stops
 *  resolving must not grow this list without bound; `Dropped` says it happened. ~100 queries is
 *  one glass-grid split frame, so this is roughly five split frames of slack. */
const MAX_IN_FLIGHT = 512;

export interface PassClassReading {
  Class: PassClass;
  /** GPU milliseconds billed to this class, totalled over every resolved bracket since arming. */
  Ms: number;
  /** Brackets folded in. Several per frame is normal — one per panel batch, per blur chain, etc. */
  Samples: number;
  /** How many of those had a SOFT boundary. Any soft sample makes the whole row suspect. */
  Soft: number;
}

/**
 * Everything the instrument knows, CUMULATIVE since arming. Two snapshots subtract into a window,
 * which is how both consumers use it (a gesture in `Trace.ts`, a measure window in the harness) —
 * a rolling average inside here would have to guess at their windows and would be wrong for both.
 */
export interface PassProfile {
  /** Frames that ran the per-pass split. */
  SplitFrames: number;
  /** Frames that ran the single whole-frame reference query AND have resolved. */
  RefFrames: number;
  /** Total GPU ms across those reference frames. */
  RefMs: number;
  Classes: PassClassReading[];
  /** Brackets refused because one was already open. Non-zero means a pass entry point is nested
   *  inside another and its time is being billed to the outer one — a wiring bug, not a reading. */
  Nested: number;
  /** Queries discarded unresolved: a disjoint event, or the in-flight cap. */
  Dropped: number;
  /** Disjoint events seen. Any non-zero value invalidates timings around it (the GPU changed
   *  power state or was reset mid-measurement). */
  Disjoint: number;
  /** `QUERY_COUNTER_BITS_EXT` for `TIMESTAMP_EXT`. 0 everywhere we have measured, which is why
   *  this alternates frames instead of nesting timestamps. Reported so the next device to say
   *  otherwise is noticed rather than assumed. */
  CounterBits: number;
}

/** The slice of `WebGL2RenderingContext` this needs. Narrow so a unit test can supply a fake. */
export interface PassTimerGl<Q> {
  createQuery(): Q | null;
  deleteQuery(query: Q): void;
  beginQuery(target: number, query: Q): void;
  endQuery(target: number): void;
  getQueryParameter(query: Q, pname: number): unknown;
  getParameter(pname: number): unknown;
  getQuery(target: number, pname: number): unknown;
  readonly QUERY_RESULT: number;
  readonly QUERY_RESULT_AVAILABLE: number;
}

export interface PassTimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** `EXT_disjoint_timer_query_webgl2`'s timestamp half, present on the extension object but inert
 *  on every driver measured so far. Probed once, never used. */
const TIMESTAMP_EXT = 0x8e28;
const QUERY_COUNTER_BITS_EXT = 0x8864;

/** `Hard` is mutable: a pass can EARN a hard boundary after its bracket opened, by binding its
 *  own target before it draws. See `SetTarget`. */
interface OpenBracket<Q> { Q: Q; Cls: number; Hard: boolean }

export class PassTimers<Q> {
  private _targetKey: string = 'default';
  private _beginTarget: string = '';

  /** The framebuffer currently bound, as a key. */
  get Target(): string { return this._targetKey; }

  /**
   * Report a framebuffer bind. Every bind site in the renderer and in `BlurPass` calls this, and
   * it is the whole basis of the HARD/SOFT flag: a key nobody updates makes every pass read SOFT,
   * which is the safe direction to be wrong in.
   *
   * A bracket is HARD when a real attachment change sits on its boundary, and there are TWO ways
   * that happens. The obvious one is the target at `Begin` already differing from where the last
   * pass ended. The other is a pass that opens its bracket on the target it inherited and then
   * BINDS ITS OWN before drawing anything -- the blur chains and the mip chain all do, because a
   * bracket has to open before the work it is measuring. Nothing was drawn into the inherited
   * target inside that bracket, so the previous encoder still had to close, and calling such a
   * pass SOFT would flag six trustworthy rows for a bookkeeping reason.
   */
  SetTarget = (key: string): void => {
    if (key === this._targetKey) return;
    this._targetKey = key;
    const open = this._open;
    if (open !== null && !open.Hard && key !== this._beginTarget) open.Hard = true;
  };

  readonly CounterBits: number;

  private readonly _gl: PassTimerGl<Q>;
  private readonly _ext: PassTimerExt;

  private readonly _ms: Float64Array = new Float64Array(PASS_CLASSES.length);
  private readonly _samples: Int32Array = new Int32Array(PASS_CLASSES.length);
  private readonly _soft: Int32Array = new Int32Array(PASS_CLASSES.length);

  private readonly _pool: Q[] = [];
  private readonly _inFlight: OpenBracket<Q>[] = [];
  private _open: OpenBracket<Q> | null = null;

  private _frameNo: number = 0;
  private _split: boolean = false;
  private _prevEnd: string = FRAME_START;

  private _splitFrames: number = 0;
  private _refFrames: number = 0;
  private _refMs: number = 0;
  private _nested: number = 0;
  private _dropped: number = 0;
  private _disjoint: number = 0;

  constructor(gl: PassTimerGl<Q>, ext: PassTimerExt) {
    this._gl = gl;
    this._ext = ext;
    this.CounterBits = PassTimers._probeCounterBits(gl);
  }

  /** Does the driver expose a usable GPU timestamp counter? A non-zero answer means per-pass
   *  timing could nest and the frame would not have to alternate. Every device measured says 0,
   *  and an enum some driver rejects must read as "no" rather than throw into the render path. */
  private static _probeCounterBits = <T>(gl: PassTimerGl<T>): number => {
    try {
      const bits = gl.getQuery(TIMESTAMP_EXT, QUERY_COUNTER_BITS_EXT);
      return typeof bits === 'number' && Number.isFinite(bits) ? bits : 0;
    } catch {
      return 0;
    }
  };

  /** Open a frame. Returns true when this is a SPLIT frame — the caller must then NOT open its own
   *  whole-frame query, because only one may be active at a time. */
  BeginFrame = (): boolean => {
    // A bracket left open by a pass that threw would block every query after it for the life of
    // the context. Close it, and charge it to `Dropped` rather than to a class it may not have
    // finished measuring.
    if (this._open !== null) {
      this._gl.endQuery(this._ext.TIME_ELAPSED_EXT);
      this._gl.deleteQuery(this._open.Q);
      this._open = null;
      this._dropped++;
    }
    this._split = (this._frameNo++ & 1) === 1;
    this._prevEnd = FRAME_START;
    return this._split;
  };

  /** Close a frame and harvest whatever the GPU has finished. */
  EndFrame = (): void => {
    if (this._open !== null) {
      this._gl.endQuery(this._ext.TIME_ELAPSED_EXT);
      this._gl.deleteQuery(this._open.Q);
      this._open = null;
      this._dropped++;
    }
    if (this._split) this._splitFrames++;
    this.Poll();
  };

  /** Bracket a pass. Returns false when nothing was opened — a reference frame, a nested call, or
   *  a driver that refused the query — and the caller must then NOT call `End`. */
  Begin = (cls: PassClass): boolean => {
    if (!this._split) return false;
    if (this._open !== null) { this._nested++; return false; }
    const q = this._pool.pop() ?? this._gl.createQuery();
    if (q === null || q === undefined) return false;
    const hard = this._targetKey !== this._prevEnd;
    this._beginTarget = this._targetKey;
    this._gl.beginQuery(this._ext.TIME_ELAPSED_EXT, q);
    this._open = { Q: q, Cls: CLASS_INDEX[cls], Hard: hard };
    return true;
  };

  /** Close the open bracket. The target bound RIGHT NOW becomes the boundary the next pass is
   *  judged against, so this must be called after the pass has finished its last bind. */
  End = (): void => {
    const open = this._open;
    if (open === null) return;
    this._open = null;
    this._gl.endQuery(this._ext.TIME_ELAPSED_EXT);
    this._prevEnd = this._targetKey;
    this._inFlight.push(open);
  };

  /** The whole-frame reference reading, handed over by the renderer's existing ring as each query
   *  resolves. While armed those queries only exist on reference frames, so this is exactly the
   *  frame cost with no per-pass queries in it. */
  AddRefSample = (ms: number): void => {
    this._refMs += ms;
    this._refFrames++;
  };

  /**
   * Harvest resolved queries.
   *
   * Results complete IN ISSUE ORDER on a single queue, so the first unavailable one ends the
   * sweep: a frame's worth of availability checks, not the whole backlog's, every frame.
   */
  Poll = (): void => {
    const gl = this._gl;
    const ext = this._ext;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      // The GPU changed power state or was reset. Every in-flight result is now meaningless.
      this._disjoint++;
      for (const e of this._inFlight) { gl.deleteQuery(e.Q); this._dropped++; }
      this._inFlight.length = 0;
      return;
    }
    let done = 0;
    while (done < this._inFlight.length) {
      const e = this._inFlight[done];
      if (!gl.getQueryParameter(e.Q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(e.Q, gl.QUERY_RESULT) as number;
      this._ms[e.Cls] += ns / 1_000_000;
      this._samples[e.Cls]++;
      if (!e.Hard) this._soft[e.Cls]++;
      // Resolved queries are reusable. A dropped one is NOT: re-beginning a query whose result
      // was never read is an INVALID_OPERATION, so those are deleted instead of pooled.
      this._pool.push(e.Q);
      done++;
    }
    if (done > 0) this._inFlight.splice(0, done);
    while (this._inFlight.length > MAX_IN_FLIGHT) {
      const e = this._inFlight.shift();
      if (e === undefined) break;
      gl.deleteQuery(e.Q);
      this._dropped++;
    }
  };

  Snapshot = (): PassProfile => ({
    SplitFrames: this._splitFrames,
    RefFrames: this._refFrames,
    RefMs: this._refMs,
    Classes: PASS_CLASSES.map((Class, i) => ({
      Class,
      Ms: this._ms[i],
      Samples: this._samples[i],
      Soft: this._soft[i],
    })),
    Nested: this._nested,
    Dropped: this._dropped,
    Disjoint: this._disjoint,
    CounterBits: this.CounterBits,
  });
}

/** One class's share of a window, as the report prints it. */
export interface PassWindowRow {
  Class: PassClass;
  /** GPU ms this class cost on an average SPLIT frame in the window. */
  MsPerFrame: number;
  Samples: number;
  /** False when any bracket in the window had a soft boundary — see the note at the top of this
   *  file. A soft row's neighbours may be holding its tile work, or it theirs. */
  Hard: boolean;
}

export interface PassWindow {
  SplitFrames: number;
  RefFrames: number;
  /** The whole-frame reference cost, ms per frame, from the frames that did NOT carry per-pass
   *  queries. The thing the rows are checked against, never one of the rows. */
  RefMsPerFrame: number;
  /** Rows, busiest first. Only classes that actually ran. */
  Rows: PassWindowRow[];
  /** Sum of every row. */
  SumMsPerFrame: number;
  /** `SumMsPerFrame / RefMsPerFrame`. 1.0 means the passes account for the frame. Well under 1
   *  means something in the frame is UNTIMED and the rows cannot be ranked against each other as
   *  if they were the whole story; well over 1 means brackets are double-counting or the split
   *  frames cost more than the reference ones. 0 when there is no reference to divide by. */
  Reconciliation: number;
  Nested: number;
  Dropped: number;
  Disjoint: number;
  CounterBits: number;
}

/**
 * Two cumulative snapshots into one window's table.
 *
 * Shared by every consumer — the `?trace` overlay, the harness, the console dump — because a
 * second implementation of this arithmetic is a second answer to "what did the blur cost", and
 * the first time they disagreed nobody would know which was right.
 *
 * Returns null when the window holds no split frame at all: an absence, which must never print as
 * a table of zeros. A zeroed row reads as "this pass is free" to the next person scanning it.
 */
export const PassWindowOf = (before: PassProfile | null, after: PassProfile | null): PassWindow | null => {
  if (after === null) return null;
  const splitFrames = after.SplitFrames - (before?.SplitFrames ?? 0);
  if (splitFrames <= 0) return null;
  const refFrames = after.RefFrames - (before?.RefFrames ?? 0);
  const refMs = after.RefMs - (before?.RefMs ?? 0);
  const rows: PassWindowRow[] = [];
  let sum = 0;
  for (let i = 0; i < after.Classes.length; i++) {
    const a = after.Classes[i];
    const b = before?.Classes[i];
    const samples = a.Samples - (b?.Samples ?? 0);
    if (samples <= 0) continue;
    const ms = a.Ms - (b?.Ms ?? 0);
    const soft = a.Soft - (b?.Soft ?? 0);
    const perFrame = ms / splitFrames;
    sum += perFrame;
    rows.push({ Class: a.Class, MsPerFrame: perFrame, Samples: samples, Hard: soft === 0 });
  }
  rows.sort((x, y) => y.MsPerFrame - x.MsPerFrame);
  const refPerFrame = refFrames > 0 ? refMs / refFrames : 0;
  return {
    SplitFrames: splitFrames,
    RefFrames: refFrames,
    RefMsPerFrame: refPerFrame,
    Rows: rows,
    SumMsPerFrame: sum,
    Reconciliation: refPerFrame > 0 ? sum / refPerFrame : 0,
    Nested: after.Nested - (before?.Nested ?? 0),
    Dropped: after.Dropped - (before?.Dropped ?? 0),
    Disjoint: after.Disjoint - (before?.Disjoint ?? 0),
    CounterBits: after.CounterBits,
  };
};

/** The window as one line, busiest first, with every row's boundary flagged. The same text in the
 *  `?trace` overlay, in the worker's console dump and in the harness console, so a screenshot of
 *  one can be compared with a paste of another. */
export const PassWindowText = (w: PassWindow | null): string => {
  if (w === null) return 'gpu n/a (no timer query)';
  if (w.Rows.length === 0) return `gpu no pass ran in ${w.SplitFrames} split frames`;
  const body = w.Rows
    .map((r) => `${r.Class} ${r.MsPerFrame.toFixed(2)}${r.Hard ? '' : '?'}`)
    .join(' ');
  const recon = w.RefMsPerFrame > 0
    ? `sum ${w.SumMsPerFrame.toFixed(2)} vs frame ${w.RefMsPerFrame.toFixed(2)} (${(w.Reconciliation * 100).toFixed(0)}%)`
    : 'NO REFERENCE FRAME — sum unattributable';
  const faults = [
    w.Nested > 0 ? `nested ${w.Nested}` : '',
    w.Dropped > 0 ? `dropped ${w.Dropped}` : '',
    w.Disjoint > 0 ? `DISJOINT ${w.Disjoint}` : '',
  ].filter(Boolean).join(' ');
  return `gpu ${body} ms/frame  [${recon}${faults ? `  ${faults}` : ''}]  ? = soft bracket`;
};
