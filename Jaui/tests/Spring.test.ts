import { describe, it, expect } from 'vitest';
import { Spring } from '../src/Animation/Spring';

describe('Spring', () => {

  it('starts settled at initial value', () => {
    const s = new Spring(100);
    expect(s.Value).toBe(100);
    expect(s.Target).toBe(100);
    expect(s.IsSettled).toBe(true);
  });

  it('converges to target', () => {
    const s = new Spring(0);
    s.Target = 100;

    // Simulate 2 seconds at 60fps
    for (let i = 0; i < 120; i++) {
      s.Step(1 / 60);
    }

    expect(s.Value).toBe(100);
    expect(s.Velocity).toBe(0);
    expect(s.IsSettled).toBe(true);
  });

  it('settles within reasonable time at default params', () => {
    const s = new Spring(0, 170, 26, 1);
    s.Target = 100;

    let frames = 0;
    while (!s.IsSettled && frames < 300) {
      s.Step(1 / 60);
      frames++;
    }

    expect(s.IsSettled).toBe(true);
    expect(frames).toBeLessThan(90); // should settle in under 1.5 seconds
  });

  it('overshoots with low damping', () => {
    const s = new Spring(0, 170, 10, 1); // underdamped
    s.Target = 100;

    let maxValue = 0;
    for (let i = 0; i < 120; i++) {
      s.Step(1 / 60);
      maxValue = Math.max(maxValue, s.Value);
    }

    expect(maxValue).toBeGreaterThan(100); // overshoot
    expect(s.Value).toBe(100); // still converges
  });

  it('does not overshoot at critical damping', () => {
    // Critical damping: c = 2 * sqrt(k * m) ≈ 26.08 for k=170, m=1
    const s = new Spring(0, 170, 26, 1);
    s.Target = 100;

    let maxValue = 0;
    for (let i = 0; i < 120; i++) {
      s.Step(1 / 60);
      maxValue = Math.max(maxValue, s.Value);
    }

    // Should barely overshoot (within 1%)
    expect(maxValue).toBeLessThan(101);
  });

  it('Snap() jumps to target immediately', () => {
    const s = new Spring(0);
    s.Target = 500;
    s.Snap();

    expect(s.Value).toBe(500);
    expect(s.Velocity).toBe(0);
  });

  it('Set() returns false when already at target', () => {
    const s = new Spring(100);
    expect(s.Set(100)).toBe(false);
  });

  it('Set() returns true when target differs', () => {
    const s = new Spring(0);
    expect(s.Set(100)).toBe(true);
  });

  it('Step() returns false when settled', () => {
    const s = new Spring(100);
    s.Target = 100;
    expect(s.Step(1 / 60)).toBe(false);
  });

  it('Step() returns true while animating', () => {
    const s = new Spring(0);
    s.Target = 100;
    expect(s.Step(1 / 60)).toBe(true);
  });

  it('works with different mass values', () => {
    const s = new Spring(0, 170, 40, 2); // heavier, more damped
    s.Target = 100;

    for (let i = 0; i < 300; i++) {
      s.Step(1 / 60);
    }

    expect(s.IsSettled).toBe(true);
    expect(s.Value).toBe(100);
  });

  describe('non-finite hygiene', () => {
    it('a non-finite seed is sanitized to 0', () => {
      const s = new Spring(NaN);
      expect(s.Value).toBe(0);
      expect(s.Target).toBe(0);
    });

    it('Set refuses a NaN target and keeps the prior one', () => {
      const s = new Spring(50);
      expect(s.Set(NaN)).toBe(false);
      expect(s.Target).toBe(50);
      s.Step(1 / 60);
      expect(s.Value).toBe(50);
    });

    it('a poisoned state self-heals on the next finite Set', () => {
      const s = new Spring(0);
      s.Value = NaN;          // simulate a poisoned integrator
      s.Velocity = NaN;
      s.Set(120);
      expect(s.Value).toBe(120);
      expect(s.Velocity).toBe(0);
      expect(s.IsSettled).toBe(true);
    });

    it('a poisoned state self-heals in Step and stops animating', () => {
      const s = new Spring(0);
      s.Set(80);
      s.Value = NaN;          // poison mid-flight
      expect(s.Step(1 / 60)).toBe(false);
      expect(s.Value).toBe(80);
      expect(s.Velocity).toBe(0);
    });

    it('Snap with a non-finite target parks at 0 instead of propagating', () => {
      const s = new Spring(10);
      s.Target = NaN;         // simulate a pre-guard poisoned target
      s.Snap();
      expect(s.Value).toBe(0);
    });
  });
});
