/**
 * `PerfLevers.DamageRegions` -- the pure half: the prediction, its closure over the frame's scene reads,
 * and the two end-of-frame checks. The pixel proof is the lever A/B on a GPU; this pins the rules.
 */
import { describe, it, expect } from 'vitest';
import { PredictDamage, DamageHeld, DamageStale, DAMAGE_PREDICT_MARGIN_PX, type DamageRead } from '../src/Core/Damage';
import type { PixelRect } from '../src/Core/Occlusion';

const R = (X0: number, Y0: number, X1: number, Y1: number): PixelRect => ({ X0, Y0, X1, Y1 });
const read = (r: PixelRect, uses: PixelRect | null = null, held = false): DamageRead => ({ Read: r, Uses: uses, Held: held });
const W = 2000, H = 1000;

describe('PredictDamage', () => {
  it('is last frame\'s damage grown by the margin when nothing reads near it', () => {
    const m = DAMAGE_PREDICT_MARGIN_PX;
    expect(PredictDamage([R(500, 500, 540, 520)], [read(R(0, 0, 200, 100), R(0, 0, 200, 100))], W, H))
      .toEqual(R(500 - m, 500 - m, 540 + m, 520 + m));
  });

  it('has nothing to predict from a frame without damage', () => {
    expect(PredictDamage([], [], W, H)).toBeNull();
  });

  it('takes in a read that sees the change, with everything it drew', () => {
    const p = PredictDamage([R(500, 500, 540, 520)], [read(R(400, 400, 900, 700), R(420, 420, 880, 680))], W, H);
    expect(p).toEqual(R(400, 400, 900, 700));
  });

  it('takes in a read whose output lands in the rect even though it saw nothing change', () => {
    const p = PredictDamage([R(500, 500, 540, 520)], [read(R(0, 0, 300, 300), R(100, 100, 510, 510))], W, H);
    expect(p).toEqual(R(0, 0, 556, 536));
  });

  it('chains: what a taken-in read drew is a change for the reads after it', () => {
    const hero = read(R(400, 400, 900, 700), R(400, 400, 900, 700));
    const strip = read(R(0, 0, 2000, 450), R(0, 0, 2000, 420));
    expect(PredictDamage([R(500, 500, 540, 520)], [hero, strip], W, H)).toEqual(R(0, 0, 2000, 700));
  });

  it('leaves out a read beside the rect that sees nothing change and draws outside it', () => {
    const hero = read(R(400, 400, 900, 700), R(400, 400, 900, 700));
    const beside = read(R(1000, 400, 1400, 700), R(1000, 400, 1400, 700));
    expect(PredictDamage([R(500, 500, 540, 520)], [hero, beside], W, H)).toEqual(R(400, 400, 900, 700));
  });

  it('renders whole past the share it is worth', () => {
    expect(PredictDamage([R(0, 0, 1900, 950)], [], W, H)).toBeNull();
  });
});

describe('the end-of-frame checks', () => {
  it('DamageHeld: every piece inside the rect', () => {
    expect(DamageHeld(R(0, 0, 100, 100), [R(10, 10, 20, 20), R(90, 90, 100, 100)])).toBe(true);
    expect(DamageHeld(R(0, 0, 100, 100), [R(10, 10, 20, 20), R(90, 90, 101, 100)])).toBe(false);
  });

  it('DamageStale: a read outside the rect may not see the damage', () => {
    expect(DamageStale([R(10, 10, 20, 20)], [read(R(0, 0, 15, 15))])).toBe('stale');
    expect(DamageStale([R(10, 10, 20, 20)], [read(R(30, 30, 40, 40))])).toBe('');
  });

  it('DamageStale: nor what a read inside the rect drew', () => {
    const inside = read(R(10, 10, 50, 50), R(10, 10, 50, 50), true);
    expect(DamageStale([], [inside, read(R(40, 40, 60, 60))])).toBe('stale');
    expect(DamageStale([], [inside, read(R(60, 60, 80, 80))])).toBe('');
  });
});
