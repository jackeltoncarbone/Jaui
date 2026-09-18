import { describe, it, expect } from 'vitest';
import {
  PassTimers, PassWindowOf, PassWindowText, PASS_CLASSES,
  type PassTimerGl, type PassProfile,
} from '@jaui/Core/Pass.Timers';

/**
 * The per-pass GPU timer, against a fake GL whose query results are handed out on command.
 *
 * What these tests are FOR. The instrument is unrunnable on the device it is aimed at -- Safari
 * exposes no timer query, so the phone gets `n/a` -- and on the Mac it can only be checked by
 * reading numbers it produced itself. So the parts that can be wrong WITHOUT the numbers looking
 * wrong are pinned here: the alternation (a frame that ran both queries would be a GL error and a
 * silently wrong table), the HARD/SOFT flag (the whole reason the table can be read at all), and
 * the absence path (a zero-filled row is the failure this project has been bitten by twice).
 */

const TIME_ELAPSED = 0x88bf;
const GPU_DISJOINT = 0x8fbb;
const QUERY_RESULT = 0x8866;
const QUERY_RESULT_AVAILABLE = 0x8867;

interface FakeQuery { Id: number; Ns: number; Ready: boolean }

/** A GL that records what was asked of it and resolves query results only when told to. */
class FakeGl implements PassTimerGl<FakeQuery> {
  readonly QUERY_RESULT = QUERY_RESULT;
  readonly QUERY_RESULT_AVAILABLE = QUERY_RESULT_AVAILABLE;

  Created = 0;
  Deleted = 0;
  Active: FakeQuery | null = null;
  /** Every query begun, in issue order. */
  Issued: FakeQuery[] = [];
  Disjoint = 0;
  /** ns the next `endQuery` bills to the query it closes. */
  NextNs = 1_000_000;
  CounterBits: number | 'throw' = 0;

  createQuery = (): FakeQuery => { this.Created++; return { Id: this.Created, Ns: 0, Ready: false }; };
  deleteQuery = (): void => { this.Deleted++; };
  beginQuery = (target: number, query: FakeQuery): void => {
    expect(target).toBe(TIME_ELAPSED);
    // The rule the whole design turns on: one active TIME_ELAPSED query per context.
    if (this.Active !== null) throw new Error('INVALID_OPERATION: a query is already active');
    this.Active = query;
    this.Issued.push(query);
  };
  endQuery = (target: number): void => {
    expect(target).toBe(TIME_ELAPSED);
    if (this.Active === null) throw new Error('INVALID_OPERATION: no query is active');
    this.Active.Ns = this.NextNs;
    this.Active = null;
  };
  getQueryParameter = (query: FakeQuery, pname: number): unknown =>
    (pname === QUERY_RESULT_AVAILABLE ? query.Ready : query.Ns);
  getParameter = (pname: number): unknown => (pname === GPU_DISJOINT ? this.Disjoint : 0);
  getQuery = (): unknown => { if (this.CounterBits === 'throw') throw new Error('INVALID_ENUM'); return this.CounterBits; };

  /** Let every issued query resolve. Mirrors the driver finishing 2-3 frames later. */
  ResolveAll = (): void => { for (const q of this.Issued) q.Ready = true; };
}

const EXT = { TIME_ELAPSED_EXT: TIME_ELAPSED, GPU_DISJOINT_EXT: GPU_DISJOINT };

const make = (): { gl: FakeGl; t: PassTimers<FakeQuery> } => {
  const gl = new FakeGl();
  return { gl, t: new PassTimers<FakeQuery>(gl, EXT) };
};

/** One split frame: panel into the scene, then a blur chain, then panel again. */
const runSplitFrame = (t: PassTimers<FakeQuery>, nsBy: Partial<Record<string, number>>, gl: FakeGl): void => {
  t.SetTarget('scene');
  gl.NextNs = nsBy['panel'] ?? 1_000_000;
  if (t.Begin('panel')) t.End();
  t.SetTarget('blur:l1');
  gl.NextNs = nsBy['blur-down'] ?? 1_000_000;
  if (t.Begin('blur-down')) { t.SetTarget('blur:l2'); t.End(); }
  t.SetTarget('blur:l1');
  gl.NextNs = nsBy['blur-up'] ?? 1_000_000;
  if (t.Begin('blur-up')) { t.SetTarget('default'); t.End(); }
  t.SetTarget('scene');
  gl.NextNs = nsBy['text'] ?? 1_000_000;
  if (t.Begin('text')) t.End();
};

const classOf = (p: PassProfile, name: string): { Ms: number; Samples: number; Soft: number } => {
  const row = p.Classes.find((c) => c.Class === name);
  if (row === undefined) throw new Error(`no class ${name}`);
  return row;
};

describe('PassTimers — the frame alternates', () => {
  it('opens a split frame every other frame and never two queries at once', () => {
    const { gl, t } = make();
    expect(t.BeginFrame()).toBe(false); // frame 0 is the REFERENCE: the renderer opens its own
    t.EndFrame();
    expect(t.BeginFrame()).toBe(true);  // frame 1 is the SPLIT
    t.EndFrame();
    expect(t.BeginFrame()).toBe(false);
    t.EndFrame();
    expect(gl.Active).toBeNull();
  });

  it('refuses every bracket on a reference frame, so the caller can hold its whole-frame query', () => {
    const { gl, t } = make();
    t.BeginFrame(); // reference
    expect(t.Begin('panel')).toBe(false);
    expect(t.Begin('blur-down')).toBe(false);
    t.EndFrame();
    expect(gl.Created).toBe(0);
  });

  it('counts a split frame only when the frame closed', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame(); runSplitFrame(t, {}, gl); t.EndFrame();
    expect(t.Snapshot().SplitFrames).toBe(1);
  });
});

describe('PassTimers — HARD and SOFT boundaries', () => {
  it('flags a pass that inherits its predecessor\'s target as SOFT', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame();
    t.SetTarget('scene');
    t.Begin('panel'); t.End();   // first of the frame: a real change from the frame start
    t.Begin('text'); t.End();    // same attachment, no flush between: SOFT
    t.EndFrame();
    gl.ResolveAll();
    t.Poll();
    const p = t.Snapshot();
    expect(classOf(p, 'panel').Soft).toBe(0);
    expect(classOf(p, 'text').Soft).toBe(1);
  });

  it('flags a pass that binds a different attachment as HARD', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame();
    runSplitFrame(t, {}, gl);
    t.EndFrame();
    gl.ResolveAll();
    t.Poll();
    const p = t.Snapshot();
    // panel -> blur:l1 -> blur:l1 (the up chain starts where the down chain did NOT end) -> scene
    expect(classOf(p, 'blur-down').Soft).toBe(0);
    expect(classOf(p, 'blur-up').Soft).toBe(0);
    expect(classOf(p, 'text').Soft).toBe(0);
  });

  it('is HARD when the pass binds its OWN target after its bracket opened', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame();
    t.SetTarget('default');
    t.Begin('panel'); t.End();                       // ends bound to the default framebuffer
    // The mip chain's real shape: a bracket has to open before the work it measures, so it opens
    // on the target it inherited and binds its own a moment later. Nothing was drawn into the
    // inherited one inside the bracket, so the boundary is real and the row must not read SOFT.
    t.Begin('blur-mip');
    t.SetTarget('blur:mip1');
    t.End();
    t.EndFrame();
    gl.ResolveAll();
    t.Poll();
    expect(classOf(t.Snapshot(), 'blur-mip').Soft).toBe(0);
  });

  it('is SOFT when a chain ends on the same attachment the next pass opens on', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame();
    t.SetTarget('blur:l1');
    t.Begin('blur-down'); t.End();             // ends bound to blur:l1
    t.Begin('blur-up'); t.End();               // opens on blur:l1 -- no attachment change
    t.EndFrame();
    gl.ResolveAll();
    t.Poll();
    expect(classOf(t.Snapshot(), 'blur-up').Soft).toBe(1);
  });
});

describe('PassTimers — the brackets cannot nest', () => {
  it('refuses a bracket inside a bracket and says so, rather than throwing in the render path', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame();
    expect(t.Begin('pblur')).toBe(true);
    expect(t.Begin('blur-down')).toBe(false); // would be INVALID_OPERATION on a real context
    t.End();
    t.EndFrame();
    expect(t.Snapshot().Nested).toBe(1);
    expect(gl.Active).toBeNull();
  });

  it('closes a bracket the render path left open, and charges it to nobody', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame();
    t.Begin('panel'); // a pass that threw before its End
    t.EndFrame();
    expect(gl.Active).toBeNull();
    const p = t.Snapshot();
    expect(p.Dropped).toBe(1);
    expect(classOf(p, 'panel').Samples).toBe(0);
  });
});

describe('PassTimers — harvesting', () => {
  it('bills nanoseconds to the right class as milliseconds', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame();
    runSplitFrame(t, { panel: 2_500_000, 'blur-down': 4_000_000, 'blur-up': 3_000_000, text: 500_000 }, gl);
    t.EndFrame();
    gl.ResolveAll();
    t.Poll();
    const p = t.Snapshot();
    expect(classOf(p, 'panel').Ms).toBeCloseTo(2.5, 6);
    expect(classOf(p, 'blur-down').Ms).toBeCloseTo(4, 6);
    expect(classOf(p, 'blur-up').Ms).toBeCloseTo(3, 6);
    expect(classOf(p, 'text').Ms).toBeCloseTo(0.5, 6);
  });

  it('stops at the first unresolved query, because results complete in issue order', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame(); runSplitFrame(t, {}, gl); t.EndFrame();
    gl.Issued[0].Ready = true;
    gl.Issued[2].Ready = true; // out of order: must NOT be harvested ahead of #1
    t.Poll();
    const p = t.Snapshot();
    expect(classOf(p, 'panel').Samples).toBe(1);
    expect(classOf(p, 'blur-up').Samples).toBe(0);
  });

  it('reuses resolved query objects instead of allocating one per pass per frame', () => {
    const { gl, t } = make();
    for (let f = 0; f < 20; f++) {
      const split = t.BeginFrame();
      if (split) runSplitFrame(t, {}, gl);
      gl.ResolveAll();
      t.EndFrame();
    }
    // Ten split frames of four passes each. Without pooling that is forty query objects.
    expect(gl.Created).toBeLessThanOrEqual(8);
    expect(t.Snapshot().SplitFrames).toBe(10);
  });

  it('throws away every in-flight result on a disjoint event and says it happened', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();
    t.BeginFrame(); runSplitFrame(t, {}, gl); t.EndFrame();
    gl.Disjoint = 1;
    t.Poll();
    const p = t.Snapshot();
    expect(p.Disjoint).toBeGreaterThan(0);
    expect(p.Dropped).toBe(4);
    for (const c of p.Classes) expect(c.Samples).toBe(0);
  });

  it('reports the timestamp counter bits, and reads an enum the driver rejects as zero', () => {
    const gl = new FakeGl();
    gl.CounterBits = 64;
    expect(new PassTimers<FakeQuery>(gl, EXT).CounterBits).toBe(64);
    const rude = new FakeGl();
    rude.CounterBits = 'throw';
    expect(new PassTimers<FakeQuery>(rude, EXT).CounterBits).toBe(0);
  });
});

describe('PassWindowOf — two snapshots into one table', () => {
  const windowOf = (): ReturnType<typeof PassWindowOf> => {
    const { gl, t } = make();
    // Two reference frames at 10ms each, two split frames whose passes total 8ms each.
    for (let f = 0; f < 4; f++) {
      const split = t.BeginFrame();
      if (split) runSplitFrame(t, { panel: 1_000_000, 'blur-down': 4_000_000, 'blur-up': 2_000_000, text: 1_000_000 }, gl);
      else t.AddRefSample(10);
      gl.ResolveAll();
      t.EndFrame();
    }
    return PassWindowOf(null, t.Snapshot());
  };

  it('divides by SPLIT frames and ranks the rows busiest first', () => {
    const w = windowOf();
    if (w === null) throw new Error('expected a window');
    expect(w.SplitFrames).toBe(2);
    expect(w.Rows[0].Class).toBe('blur-down');
    expect(w.Rows[0].MsPerFrame).toBeCloseTo(4, 6);
    expect(w.Rows.map((r) => r.Class)).toEqual(['blur-down', 'blur-up', 'panel', 'text']);
  });

  it('prints the sum beside the frame\'s own reference and the ratio between them', () => {
    const w = windowOf();
    if (w === null) throw new Error('expected a window');
    expect(w.SumMsPerFrame).toBeCloseTo(8, 6);
    expect(w.RefMsPerFrame).toBeCloseTo(10, 6);
    expect(w.Reconciliation).toBeCloseTo(0.8, 6);
    // 80% is the finding, not a rounding error: a fifth of the frame is untimed.
    expect(PassWindowText(w)).toContain('sum 8.00 vs frame 10.00 (80%)');
  });

  it('omits a class that never ran rather than printing it as zero', () => {
    const w = windowOf();
    if (w === null) throw new Error('expected a window');
    expect(w.Rows.some((r) => r.Class === 'pblur')).toBe(false);
    expect(w.Rows.length).toBeLessThan(PASS_CLASSES.length);
  });

  it('subtracts, so a second window carries only its own frames', () => {
    const { gl, t } = make();
    for (let f = 0; f < 4; f++) {
      const split = t.BeginFrame();
      if (split) runSplitFrame(t, { panel: 1_000_000 }, gl);
      gl.ResolveAll();
      t.EndFrame();
    }
    const mark = t.Snapshot();
    for (let f = 0; f < 4; f++) {
      const split = t.BeginFrame();
      if (split) runSplitFrame(t, { panel: 3_000_000 }, gl);
      gl.ResolveAll();
      t.EndFrame();
    }
    const w = PassWindowOf(mark, t.Snapshot());
    if (w === null) throw new Error('expected a window');
    expect(w.SplitFrames).toBe(2);
    const panel = w.Rows.find((r) => r.Class === 'panel');
    expect(panel?.MsPerFrame).toBeCloseTo(3, 6);
  });

  it('is ABSENT, not zero, when no split frame happened in the window', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();   // one reference frame and nothing else
    gl.ResolveAll();
    expect(PassWindowOf(null, t.Snapshot())).toBeNull();
    expect(PassWindowOf(null, null)).toBeNull();
    expect(PassWindowText(null)).toBe('gpu n/a (no timer query)');
  });
});

describe('PassWindowText', () => {
  it('marks a soft row and says what the mark means', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.AddRefSample(4); t.EndFrame();
    t.BeginFrame();
    t.SetTarget('scene');
    gl.NextNs = 3_000_000;
    t.Begin('panel'); t.End();
    gl.NextNs = 1_000_000;
    t.Begin('text'); t.End();   // same target, SOFT
    t.EndFrame();
    gl.ResolveAll();
    t.Poll();
    const text = PassWindowText(PassWindowOf(null, t.Snapshot()));
    expect(text).toContain('panel 3.00 ');
    expect(text).toContain('text 1.00?');
    expect(text).toContain('? = soft bracket');
  });

  it('refuses to rank rows against a frame it never measured', () => {
    const { gl, t } = make();
    t.BeginFrame(); t.EndFrame();          // reference frame, but no sample was ever handed over
    t.BeginFrame(); runSplitFrame(t, {}, gl); t.EndFrame();
    gl.ResolveAll();
    t.Poll();
    expect(PassWindowText(PassWindowOf(null, t.Snapshot()))).toContain('NO REFERENCE FRAME');
  });
});
