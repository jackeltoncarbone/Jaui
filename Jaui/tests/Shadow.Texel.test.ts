import { describe, expect, it } from 'vitest';
import { ShadowTexelStep, SHADOW_TEXEL_UNKNOWN_GAP } from '../src/Core/Shadow.Texel';
import { SHADOW_EASE_SECONDS } from '../src/Core/Renderer';

/**
 * The probe's "did my texel move" declaration, held to a simulation of what the GPU does: a 10-bit unorm
 * store, round to nearest, blended by a constant alpha. The declaration may call a still texel moved (a
 * lost cache hit); it must NEVER call a moved texel still (a stale pixel).
 */

const easeOf = (dt: number): number => 1 - Math.exp(-dt / SHADOW_EASE_SECONDS);

/** Deterministic PRNG, so a failure reproduces. */
const rng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
};

interface Sim { Code: number; Gap: number; Frozen: number }

/** One probe write, GPU and CPU side by side. `reading` is in LSBs (0..1023, real). */
const write = (sim: Sim, reading: number, ease: number, fresh: boolean, inputsSame: boolean): boolean => {
  const before = sim.Code;
  sim.Code = fresh || ease >= 1 ? Math.round(reading) : Math.round(sim.Code + ease * (reading - sim.Code));
  const step = ShadowTexelStep(fresh, sim.Gap, sim.Frozen, ease, inputsSame);
  sim.Gap = step.Gap;
  sim.Frozen = step.Frozen;
  const moved = sim.Code !== before;
  if (moved && !step.Moved) throw new Error(`declared still but moved: ${before} -> ${sim.Code}, reading ${reading}, ease ${ease}`);
  // The bound holds.
  if (Math.abs(reading - sim.Code) > sim.Gap + 1e-9) throw new Error(`gap bound broken: |${reading} - ${sim.Code}| > ${sim.Gap}`);
  return step.Moved;
};

describe('Shadow.Texel', () => {
  it('a fresh slot and a changed reading are always declared moved', () => {
    expect(ShadowTexelStep(true, 0, 0, 0.2, true).Moved).toBe(true);
    expect(ShadowTexelStep(false, 0.5, 0, 0.2, false).Moved).toBe(true);
    expect(ShadowTexelStep(false, 0.5, 0, 0.2, false).Gap).toBeGreaterThan(100);
  });

  it('a snap over a texel already at its reading is still; a snap after motion is moved', () => {
    expect(ShadowTexelStep(false, 0.5, 0, 1, true).Moved).toBe(false);
    expect(ShadowTexelStep(false, 3, 0, 1, true).Moved).toBe(true);
    expect(ShadowTexelStep(false, 3, 0, 1, true).Gap).toBe(0.5);
  });

  it('SOUND: across random scenes, cadences and snaps, no texel that moved is ever declared still', () => {
    const rand = rng(0x5eed);
    let stillDeclared = 0;
    let writes = 0;
    for (let trial = 0; trial < 400; trial++) {
      const sim: Sim = { Code: 0, Gap: 0, Frozen: 0 };
      let reading = rand() * SHADOW_TEXEL_UNKNOWN_GAP;
      write(sim, reading, 1, true, false);
      for (let f = 0; f < 240; f++) {
        // Scenes change now and then; cadence jitters between 30 and 144 Hz; a snap now and then.
        const change = rand() < 0.03;
        if (change) reading = rand() * SHADOW_TEXEL_UNKNOWN_GAP;
        const dt = 1 / (30 + rand() * 114);
        const snap = rand() < 0.01;
        const moved = write(sim, reading, snap ? 1 : easeOf(dt), false, !change);
        writes++;
        if (!moved) stillDeclared++;
      }
    }
    // Not vacuous even here, where every frame draws a new cadence: a new largest ease is a real chance
    // for a stuck texel to take one more step, so this adversarial clock earns fewer rests than a real one.
    expect(stillDeclared / writes).toBeGreaterThan(0.3);
  });

  it('a static scene under a real clock (60 Hz, +-5% jitter) is declared still on at least 9 frames in 10 after its first second', () => {
    const rand = rng(0xc0ffee);
    for (let trial = 0; trial < 50; trial++) {
      const sim: Sim = { Code: 0, Gap: 0, Frozen: 0 };
      const reading = rand() * SHADOW_TEXEL_UNKNOWN_GAP;
      write(sim, rand() * SHADOW_TEXEL_UNKNOWN_GAP, 1, true, false);
      write(sim, reading, easeOf(1 / 60), false, false);
      let still = 0;
      for (let f = 0; f < 600; f++) {
        const moved = write(sim, reading, easeOf((1 + (rand() - 0.5) * 0.1) / 60), false, true);
        if (f >= 60 && !moved) still++;
      }
      expect(still / 540, `trial ${trial}`).toBeGreaterThan(0.9);
    }
  });

  it('a static scene at 60 Hz comes to rest, and stays at rest, within a bounded number of frames', () => {
    for (const reading of [0, 1, 511.5, 700.3, 1023]) {
      const sim: Sim = { Code: 0, Gap: 0, Frozen: 0 };
      write(sim, 0, 1, true, false);
      write(sim, reading, easeOf(1 / 60), false, false);
      let restAt = -1;
      for (let f = 0; f < 120; f++) {
        const moved = write(sim, reading, easeOf(1 / 60), false, true);
        if (!moved && restAt < 0) restAt = f;
        if (restAt >= 0) expect(moved, `reading ${reading} frame ${f}`).toBe(false);
      }
      expect(restAt, `reading ${reading}`).toBeGreaterThanOrEqual(0);
      expect(restAt).toBeLessThan(60);
    }
  });
});
