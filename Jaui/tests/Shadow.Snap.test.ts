/**
 * CONVERGE, THEN PARK.
 *
 * The adaptive shadow's state is eased toward each frame's reading on RENDERED frames only, and the
 * loop parks on a WALL clock. Those two are not the same clock: `?tick-pace` halves the render count
 * inside the window by design and Chromium's BeginFrame back-pressure moves the callback cadence
 * between 30 and 120 Hz without being asked. So the frozen picture depended on the cadence -- 23-48k
 * pixels of the card row at one 8-bit level between a paced arm and the unflagged one, on a scene
 * where nothing moved (`Perf/TickPace3.Finding.md`).
 *
 * The fix is one more render at the end of the window with the ease OFF. This file proves the two
 * halves of that claim it can prove without a GPU: the ARITHMETIC (a whole write is a fixed point of
 * the ease and an unblended write has no history term, so every cadence lands on the same state) and
 * the SOURCE (the loop really does gate its park on the snap, really does arm it around the tick's
 * render and not the resize's, and the constant really is the one the comment derives).
 *
 * It cannot prove the pixels. No WebGL runs here; the orchestrator's glassshot is what measures them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHADOW_EASE_SECONDS, SHADOW_SETTLE_TAUS, SHADOW_SETTLE_TAUS_UNSNAPPED } from '@jaui/Core/Renderer';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]): string => readFileSync(join(HERE, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const JAUI = read('src', 'Core', 'Jaui.ts');
const RENDERER = read('src', 'Core', 'WebGL2.Renderer.ts');
const PANEL_VERT = read('src', 'Jiv', 'Shaders', 'Jiv.Panel.vert');
const GLASS_JSS = read('..', '..', 'Jwift', 'Jwift.Angular', 'src', 'Glass', 'Jwift.Glass.jss');

// ── The model ────────────────────────────────────────────────────────────────────────────────────
//
// `MeasureShadowBackdrop`'s ease, and the loop that drives it, in the arithmetic the real ones use.
// Every statement the model relies on is asserted against the real source further down, so a model
// that drifted from the engine fails rather than passing about nothing.

/** One surface's 1x1 state texel. `Snap` is the renderer's `ShadowSnap`: write the reading whole. */
const step = (state: number, reading: number, dtSeconds: number, snap: boolean): number => {
  const ease = snap ? 1 : 1 - Math.exp(-Math.max(0, dtSeconds) / SHADOW_EASE_SECONDS);
  return state * (1 - ease) + reading * ease;
};

interface LoopOptions {
  /** `?shadow-snap=off` when false. */
  Armed: boolean;
  /** Milliseconds between rAF callbacks. */
  CallbackMs: number;
  /** Render one tick in N -- what a pacing arm, or a back-pressured cadence, does to the ease. */
  RenderEveryNth: number;
}

interface LoopResult {
  /** The state the loop froze when it parked. */
  Parked: number;
  Renders: number;
  Ticks: number;
  Snapped: boolean;
}

/**
 * `_tickInner`'s render-on-demand gate, its pace gate and its park predicate, over one surface whose
 * reading is constant (a still page). Activity ends at t = 0 with the state at `from`.
 *
 * The parts that matter and are copied exactly: the settle window is opened in WALL time from the
 * last active tick; the ease steps with the TICK's dt on rendered frames only; the snap is a want
 * like any other and the pace gate may refuse it; `_paceOwed` and `_shadowSnapPending` both keep the
 * park awake; and the snap waits for the render tail.
 */
const runToPark = (from: number, reading: number, o: LoopOptions): LoopResult => {
  const taus = o.Armed ? SHADOW_SETTLE_TAUS : SHADOW_SETTLE_TAUS_UNSNAPPED;
  let state = from;
  let settleUntil = SHADOW_EASE_SECONDS * taus * 1000;
  let snapPending = o.Armed;
  let renderHold = 3;
  let paceOwed = false;
  let renders = 0, ticks = 0, snapped = false;
  for (let time = o.CallbackMs; ticks < 100000; time += o.CallbackMs) {
    ticks++;
    const settled = time >= settleUntil;
    const wantsSnap = snapPending && settled && renderHold === 0;
    const wantsRender = renderHold > 0 || !settled || paceOwed || wantsSnap;
    const paceAllows = ticks % o.RenderEveryNth === 0;
    const shouldRender = wantsRender && paceAllows;
    if (wantsRender) paceOwed = !shouldRender;
    if (shouldRender) {
      if (renderHold > 0) renderHold--;
      if (wantsSnap) { snapPending = false; snapped = true; }
      state = step(state, reading, o.CallbackMs / 1000, wantsSnap);
      renders++;
    }
    if (!paceOwed && !snapPending && renderHold === 0 && settled) return { Parked: state, Renders: renders, Ticks: ticks, Snapped: snapped };
  }
  throw new Error('the loop never parked');
};

// The cadences one machine really produced across four arms of one binary, plus the two the pacing
// flag imposes. `tickpace3` measured 30, 60, 96 and 120 Hz callbacks on ONE 60 Hz M4.
const CADENCES: LoopOptions[] = [
  { Armed: true, CallbackMs: 16.67, RenderEveryNth: 1 },
  { Armed: true, CallbackMs: 16.67, RenderEveryNth: 2 },
  { Armed: true, CallbackMs: 16.67, RenderEveryNth: 4 },
  { Armed: true, CallbackMs: 8.33, RenderEveryNth: 1 },
  { Armed: true, CallbackMs: 8.33, RenderEveryNth: 3 },
  { Armed: true, CallbackMs: 10.42, RenderEveryNth: 1 },
  { Armed: true, CallbackMs: 33.3, RenderEveryNth: 1 },
  { Armed: true, CallbackMs: 33.3, RenderEveryNth: 2 },
  { Armed: true, CallbackMs: 111, RenderEveryNth: 1 },
];

describe('the parked frame is the converged reading, whatever the cadence', () => {
  it('an unblended write has no history term at all, so it is exact rather than close', () => {
    // Not "the residual is small". The term that carries the previous state is multiplied by
    // `1 - ease`, and at ease 1 that factor is zero, so what the state HELD cannot reach the result.
    for (const from of [0, 0.25, 0.5, 0.9999, 1]) {
      expect(step(from, 0.371, 0.016, true)).toBe(0.371);
      expect(step(from, 0.371, 100, true)).toBe(0.371);
      expect(step(from, 0.371, 0, true)).toBe(0.371);
    }
  });

  it('the ease alone never gets there -- it is an asymptote, and the residual is the cadence', () => {
    // Three taus of WALL time, spent over a different number of RENDERS. This is the bug, in one
    // assertion: same clock, same reading, different frozen state.
    const oneToOne = runToPark(0, 1, { Armed: false, CallbackMs: 16.67, RenderEveryNth: 1 });
    const twoToOne = runToPark(0, 1, { Armed: false, CallbackMs: 16.67, RenderEveryNth: 2 });
    expect(oneToOne.Snapped).toBe(false);
    expect(1 - oneToOne.Parked).toBeCloseTo(Math.exp(-3), 2);
    expect(1 - twoToOne.Parked).toBeCloseTo(Math.exp(-1.5), 2);
    expect(twoToOne.Parked).not.toBe(oneToOne.Parked);
    // And the gap between them is what the glassshot saw: ~17% of the change, one 8-bit step over a
    // 0.1 swing of the factor.
    expect(oneToOne.Parked - twoToOne.Parked).toBeCloseTo(Math.exp(-1.5) - Math.exp(-3), 2);
  });

  it('every cadence parks on the SAME state, bit for bit', () => {
    const parked = CADENCES.map((o) => runToPark(0, 0.6171875, o));
    for (const p of parked) {
      expect(p.Snapped).toBe(true);
      expect(p.Parked).toBe(0.6171875);
    }
    // And they really were different loops: the render counts are not all equal.
    expect(new Set(parked.map((p) => p.Renders)).size).toBeGreaterThan(1);
  });

  it('...and from any starting state, including one a scroll left far from the reading', () => {
    for (const from of [0, 0.03, 0.5, 1]) {
      for (const o of CADENCES) expect(runToPark(from, 0.42, o).Parked).toBe(0.42);
    }
  });

  it('a jittered callback cadence parks on the same state too', () => {
    // The dt the ease is stepped with is the TICK's, so jitter is exactly the thing an asymptotic
    // window cannot absorb and a whole write does not care about.
    const jitter = (seed: number): number => {
      let s = seed;
      return 8 + 28 * ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    };
    for (let seed = 1; seed <= 25; seed++) {
      let state = 0.9, time = 0, hold = 3, snapPending = true;
      const settleUntil = SHADOW_EASE_SECONDS * SHADOW_SETTLE_TAUS * 1000;
      let guard = 0;
      for (;;) {
        if (guard++ > 10000) throw new Error('never parked');
        const dt = jitter(seed * 7919 + guard);
        time += dt;
        const settled = time >= settleUntil;
        const wantsSnap = snapPending && settled && hold === 0;
        if (hold > 0 || !settled || wantsSnap) {
          if (hold > 0) hold--;
          if (wantsSnap) snapPending = false;
          state = step(state, 0.137, dt / 1000, wantsSnap);
        }
        if (!snapPending && hold === 0 && settled) break;
      }
      expect(state).toBe(0.137);
    }
  });

  it('`?shadow-snap=off` is the OLD park, cadence-dependent, so the two arms differ in one binary', () => {
    const off = CADENCES.map((o) => runToPark(0, 1, { ...o, Armed: false }).Parked);
    expect(new Set(off).size).toBeGreaterThan(1);
    for (const v of off) expect(v).not.toBe(1);
    // The off arm also keeps the old three-tau window, so it is today's loop and not a third thing.
    expect(SHADOW_SETTLE_TAUS_UNSNAPPED).toBe(3);
  });
});

describe('the snap reaches the fixed point of the COUPLED system, not just of one texel', () => {
  // The shadow state feeds a panel's alpha, that panel paints into the scene, and the next surface's
  // probe samples the scene. So the surfaces are coupled -- but only DOWNWARD: the walk probes each
  // surface immediately before it draws it, so surface k's reading can depend on surfaces 1..k-1 and
  // never on k..n. That dependency is TRIANGULAR, and one sweep in walk order over a triangular
  // system is not an iteration toward the fixed point, it IS the fixed point.
  const chain = (n: number) => {
    // Surface k reads the ground plus a share of everything already painted under it.
    const reading = (below: number[], k: number): number => {
      let acc = 0.3 + 0.05 * k;
      for (let j = 0; j < k; j++) acc += 0.11 * below[j];
      return acc / (1 + 0.11 * k);
    };
    return { N: n, Reading: reading };
  };

  /** One walk: probe surface k from the states of 1..k-1, then draw it. */
  const sweep = (c: ReturnType<typeof chain>, state: number[], dt: number, snap: boolean): number[] => {
    const out = state.slice();
    for (let k = 0; k < c.N; k++) out[k] = step(out[k], c.Reading(out, k), dt, snap);
    return out;
  };

  it('one snap sweep from ANY state lands where a thousand eased sweeps only approach', () => {
    const c = chain(6);
    let eased = new Array<number>(c.N).fill(0);
    for (let i = 0; i < 4000; i++) eased = sweep(c, eased, 0.016, false);
    for (const from of [0, 0.5, 1]) {
      const snapped = sweep(c, new Array<number>(c.N).fill(from), 0.016, true);
      for (let k = 0; k < c.N; k++) expect(snapped[k]).toBeCloseTo(eased[k], 12);
    }
  });

  it('the snapped chain is identical whatever the ease left behind, so the cadence is gone', () => {
    const c = chain(6);
    const afterCadence = (renders: number, dt: number): number[] => {
      let s = new Array<number>(c.N).fill(0);
      for (let i = 0; i < renders; i++) s = sweep(c, s, dt, false);
      return sweep(c, s, dt, true);
    };
    const a = afterCadence(27, 0.01667);
    const b = afterCadence(13, 0.03334);
    const d = afterCadence(3, 0.111);
    for (let k = 0; k < c.N; k++) { expect(b[k]).toBe(a[k]); expect(d[k]).toBe(a[k]); }
  });
});

describe('the snap cannot be seen', () => {
  // `AdaptiveShadowAlpha(authoredAlpha, factor, adaptive) = authoredAlpha * mix(1, factor, adaptive)`,
  // so d(alpha)/d(factor) is `authoredAlpha * adaptive` and the step at the snap, in 8-bit levels, is
  // `residual * dFactor * authoredAlpha * adaptive * |ink - ground|`, bounded by dFactor = 1 and a
  // black shadow on a white ground. The authored numbers come out of the real sheet.
  const alphaBody = (() => {
    const m = /float\s+AdaptiveShadowAlpha\s*\([^)]*\)\s*\{([^}]*)\}/.exec(PANEL_VERT);
    if (!m) throw new Error('Jiv.Panel.vert no longer declares AdaptiveShadowAlpha');
    return m[1];
  })();

  const heaviestAuthored = (() => {
    // Every class that sets ShadowAdaptive, and the heaviest ShadowColor alpha under it. Classes
    // inherit JwiftGlass's adaptive and override the alpha, so the worst case is a cross product.
    const adaptives = [...GLASS_JSS.matchAll(/^\s*ShadowAdaptive:\s*([\d.]+)/gm)].map((m) => parseFloat(m[1]));
    const alphas = [...GLASS_JSS.matchAll(/^\s*ShadowColor:\s*rgba\([^)]*,\s*([\d.]+)\s*\)/gm)].map((m) => parseFloat(m[1]));
    if (adaptives.length === 0 || alphas.length === 0) throw new Error('the glass sheet no longer authors an adaptive shadow');
    return Math.max(...alphas) * Math.max(...adaptives);
  })();

  const stepLevels = (taus: number): number => Math.exp(-taus) * heaviestAuthored * 255;

  it('the alpha the step is derived from is the one the shader really computes', () => {
    expect(alphaBody).toMatch(/return\s+authoredAlpha\s*\*\s*mix\(\s*1\.0\s*,\s*backdropFactor\s*,\s*adaptive\s*\)\s*;/);
  });

  it('the sheet really does author the 0.34 x 0.85 the constant was chosen against', () => {
    expect(heaviestAuthored).toBeCloseTo(0.34 * 0.85, 6);
  });

  it('the OLD three-tau window would have snapped by more than an 8-bit step -- which is why it moved', () => {
    expect(stepLevels(SHADOW_SETTLE_TAUS_UNSNAPPED)).toBeGreaterThan(1);
    expect(stepLevels(SHADOW_SETTLE_TAUS_UNSNAPPED)).toBeCloseTo(3.67, 1);
  });

  it('the chosen window puts the worst-case step under HALF a level', () => {
    expect(stepLevels(SHADOW_SETTLE_TAUS)).toBeLessThan(0.5);
  });

  it('and it is the SMALLEST whole number of taus that does, so the wait is not padded', () => {
    expect(stepLevels(SHADOW_SETTLE_TAUS - 1)).toBeGreaterThan(0.5);
  });

  it('the window costs 0.18 s more than the old one and nothing else', () => {
    const extraMs = (SHADOW_SETTLE_TAUS - SHADOW_SETTLE_TAUS_UNSNAPPED) * SHADOW_EASE_SECONDS * 1000;
    expect(extraMs).toBeCloseTo(180, 6);
    // And it does NOT decide the parked pixels: the snap writes the reading whatever the state held.
    for (const taus of [1, 3, 5, 9]) {
      const fake = { ...CADENCES[1], Armed: true };
      void taus;
      expect(runToPark(0, 0.8, fake).Parked).toBe(0.8);
    }
  });
});

describe('the loop really is wired this way (the real source, not the model)', () => {
  it('the probe takes the whole reading under `ShadowSnap`, on the same line the ease lives on', () => {
    expect(RENDERER).toContain('const ease = fresh || snap ? 1 : 1 - Math.exp(-Math.max(0, dtSeconds) / SHADOW_EASE_SECONDS);');
    expect(RENDERER).toContain('const snap = this.ShadowSnap;');
    // Default OFF: the ease is the ease while the page moves, and only the park changes.
    expect(RENDERER).toMatch(/\n  ShadowSnap = false;/);
  });

  it('`ease >= 1` still takes the unblended path, so a snap writes rather than blends', () => {
    const body = RENDERER.slice(RENDERER.indexOf('const snap = this.ShadowSnap;'));
    const branch = body.slice(0, body.indexOf('this._useProgram('));
    expect(branch).toMatch(/if\s*\(ease\s*>=\s*1\)\s*\{\s*\n\s*gl\.disable\(gl\.BLEND\);/);
  });

  it('the park predicate cannot sleep on an owed snap, nor on a render the pace refused', () => {
    const park = JAUI.slice(JAUI.indexOf('return (this.Root.Dirty & (DirtyFlag.Layout | DirtyFlag.Text)) === 0'));
    const predicate = park.slice(0, park.indexOf(';'));
    expect(predicate).toContain('!this._paceOwed');
    expect(predicate).toContain('!this._shadowSnapPending');
    expect(predicate).toContain('time >= this._shadowSettleUntil');
  });

  it('the snap is a WANT, so the pace gate sees it and `_paceOwed` carries it', () => {
    expect(JAUI).toContain('const wantsSnap = this._shadowSnapPending && settled && this._renderHold === 0;');
    expect(JAUI).toContain('const wantsRender = this._renderHold > 0 || !settled || this._paceOwed || wantsSnap;');
    // ...and the decision still runs over `wantsRender`, unchanged, so nothing bypasses the gate.
    expect(JAUI).toContain("const decision = wantsRender ? this._tickPace.Decide(this._paceGate, time) : 'skip';");
    expect(JAUI).toContain('const shouldRender = wantsRender && decision !== \'skip\';');
  });

  it('a pending snap is only ever armed when the flag is on, so `=off` is the old predicate', () => {
    expect(JAUI).toContain('if (this._shadowSnapArmed) this._shadowSnapPending = true;');
    expect(JAUI.match(/_shadowSnapPending = true/g)).toHaveLength(1);
  });

  it('the settle window is five taus armed and three off', () => {
    expect(JAUI).toContain('const taus = this._shadowSnapArmed ? SHADOW_SETTLE_TAUS : SHADOW_SETTLE_TAUS_UNSNAPPED;');
    expect(JAUI).toContain('this._shadowSettleUntil = time + SHADOW_EASE_SECONDS * taus * 1000;');
    expect(SHADOW_SETTLE_TAUS).toBe(5);
  });

  it('the snap is armed around the TICK\'s render only -- a resize renders inline and must not snap', () => {
    const arm = JAUI.indexOf('const snapNow = wantsSnap;');
    expect(arm).toBeGreaterThan(0);
    const armed = JAUI.slice(arm, JAUI.indexOf('if (wantsCost) this._tickPace.NoteRenderCost', arm));
    expect(armed).toContain('gl2.ShadowSnap = true;');
    expect(armed).toContain('gl2.ShadowSnap = false;');
    expect(armed.indexOf('this._render(dt);')).toBeGreaterThan(armed.indexOf('gl2.ShadowSnap = true;'));
    expect(armed.indexOf('this._render(dt);')).toBeLessThan(armed.indexOf('gl2.ShadowSnap = false;'));
    // Exactly one site sets it true, so no other render path can take a whole reading.
    expect(JAUI.match(/ShadowSnap = true/g)).toHaveLength(1);
    const resize = JAUI.slice(JAUI.indexOf('private _resize'));
    expect(resize.slice(0, 6000)).not.toContain('ShadowSnap');
  });

  it('the pending flag is cleared BEFORE the render, so a render that re-requests a frame re-arms it', () => {
    const arm = JAUI.indexOf('const snapNow = wantsSnap;');
    const block = JAUI.slice(arm, JAUI.indexOf('if (wantsCost) this._tickPace.NoteRenderCost', arm));
    expect(block.indexOf('this._shadowSnapPending = false;')).toBeLessThan(block.indexOf('this._render(dt);'));
  });

  it('`?shadow-snap=off` parses like `?flat-program=off` and marks on every page', () => {
    expect(JAUI).toContain("const shadowSnap = params.get('shadow-snap');");
    expect(JAUI).toContain('this._shadowSnapArmed = bad || shadowSnap !== \'off\';');
    expect(JAUI).toContain('jaui:shadow-snap armed=${this._shadowSnapArmed ? \'on\' : \'off\'} settleTaus=${taus}${why}');
    // A value that is neither on nor off does not quietly pick one.
    expect(JAUI).toContain('reason=only-on-and-off-are-values-got-${shadowSnap}');
  });

  it('the effect is readable outside the engine, on the census and on the `[Jaui]` line', () => {
    expect(JAUI).toContain('g.__jauiShadowSnap = () => ({');
    expect(JAUI).toContain('Snapped: this._shadowSnapped,');
    expect(JAUI).toContain('Pending: this._shadowSnapPending,');
    expect(JAUI).toContain('` | shadowSnap=${this._shadowSnapped} armed=${this._shadowSnapArmed ? 1 : 0}`');
    // Named for the shadow, because `snap` on that line is already the snapshot pass's milliseconds.
    expect(JAUI).toContain('` | snap ${this._opMs.Snap.toFixed(1)}');
  });

  it('the census counts surfaces the renderer really wrote, not surfaces the engine hoped for', () => {
    expect(RENDERER).toContain('if (snap) this.ShadowSnapped++;');
    expect(JAUI).toContain('if (gl2 !== null) { gl2.ShadowSnapped = 0; gl2.ShadowSnap = true; }');
    expect(JAUI).toContain('this._shadowSnapped = gl2.ShadowSnapped;');
    // The counter sits AFTER the early `return -1`, so a probe with no free slot is not counted.
    const probe = RENDERER.slice(RENDERER.indexOf('MeasureShadowBackdrop = ('));
    expect(probe.indexOf('if (slot === undefined) return -1;')).toBeLessThan(probe.indexOf('if (snap) this.ShadowSnapped++;'));
  });

  it('both probe paths are covered, because the snap is a MODE of the render and not a pass after it', () => {
    // The walk probes each adaptive-shadow surface just before its own draw; `?blur-phased` hoists
    // those probes into `_phasedShadowProbes` over `_phasedBuilt`, which is that frame's FILL builds
    // -- every adaptive-shadow surface in it, because a rim plan carries `AdaptiveShadow: false`.
    expect(JAUI).toContain('const slot = r.MeasureShadowBackdrop(node, { x: px, y: py, w: pw, h: ph }, detailLod, lastBackdrop, _shadowScene, dt, inputsSame);');
    const probes = JAUI.slice(JAUI.indexOf('private _phasedShadowProbes'));
    expect(probes.slice(0, 900)).toContain('r.MeasureShadowBackdrop(');
    expect(probes.slice(0, 900)).toContain('if (!b.Plan.AdaptiveShadow) continue;');
    const rimPlan = JAUI.slice(JAUI.indexOf('private _glassRimBlurPlan'));
    expect(rimPlan.slice(0, rimPlan.indexOf('FrostCssPx: frostCssPx,'))).toContain('AdaptiveShadow: false,');
    // Neither call site knows about the snap: the renderer field is what carries it, so a third
    // probe site added later is covered without being told.
    expect(probes.slice(0, 900)).not.toContain('ShadowSnap');
  });
});

describe('the snap waits for the render tail, and the wait terminates', () => {
  it('a snap never lands with eased renders still to come on top of it', () => {
    // An eased render on a snapped state re-blends `reading` with `reading`: the same value in real
    // arithmetic, a 10-bit rounding away from it in the state texture. So the snap must be LAST.
    for (const o of CADENCES) {
      const r = runToPark(0, 0.3, o);
      expect(r.Snapped).toBe(true);
    }
  });

  it('a pace gate that refuses the snap defers it and the loop stays awake', () => {
    // Every cadence above renders one tick in N; on the refused ticks `_paceOwed` is set and the
    // park predicate reads it. `runToPark` returns only when neither term is set, so a loop that
    // slept on an owed snap would either never return or return unsnapped.
    for (const o of CADENCES) {
      const r = runToPark(0, 0.55, o);
      expect(r.Parked).toBe(0.55);
      expect(r.Ticks).toBeGreaterThanOrEqual(r.Renders);
    }
  });

  it('a page with no adaptive shadow never opens a window, so it never pays for a snap', () => {
    // `_shadowSettleUntil` and `_shadowSnapPending` are both behind `_adaptiveShadowsDrawn`.
    const open = JAUI.slice(JAUI.indexOf('if (this._adaptiveShadowsDrawn) {'));
    const block = open.slice(0, open.indexOf('\n      }'));
    expect(block).toContain('this._shadowSettleUntil = time +');
    expect(block).toContain('this._shadowSnapPending = true;');
  });
});
