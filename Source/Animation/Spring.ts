/**
 * Damped harmonic oscillator.
 *   F = -k*(x - target) - c*v
 *   a = F / m
 *   v += a * dt
 *   x += v * dt
 *
 * Default k=170, c=26, m=1 is near critical damping — smooth, no overshoot.
 *
 * Integration is semi-implicit Euler; stability requires `dt * ω < 2`
 * where `ω = sqrt(k/m)`. Very stiff springs (short transitions — a 10ms
 * `@Transition` yields ω ≈ 500, far beyond stable at a 16ms RAF step)
 * would blow up into wild oscillation without intervention — the symptom
 * is BackdropBrightness flashing white/black as the value diverges. So
 * `Step` substeps internally: large dts get chopped into safe-sized
 * micro-steps, preserving the correct spring curve regardless of how
 * stiff the caller configured. Cost is proportional to ω·dt — typical
 * UI springs (ω < 20) take one step; only ultra-short transitions pay
 * the subdivision tax.
 */

/** Settle thresholds. Must be tight enough that springs with sub-unit
 *  deltas (VisualScale 1→1.03, Opacity 0→0.5) don't trip the check on
 *  their first frame and snap before the integrator can run — at a soft
 *  spring (ω=10) a 0.03 delta yields first-frame velocity ≈ 0.05, so
 *  a 0.1 threshold would treat the spring as already settled. 0.001 is
 *  comfortably invisible across every animatable property (sub-pixel,
 *  sub-percent) while still letting the spring park within a frame or
 *  two of the visible settle time. */
const SETTLE_VALUE_EPSILON = 0.001;
const SETTLE_VELOCITY_EPSILON = 0.001;

export class Spring {
  Value: number;
  Velocity: number = 0;
  Target: number;
  Stiffness: number;
  Damping: number;
  Mass: number;

  constructor(
    value: number,
    stiffness: number = 170,
    damping: number = 26,
    mass: number = 1,
  ) {
    this.Value = value;
    this.Target = value;
    this.Stiffness = stiffness;
    this.Damping = damping;
    this.Mass = mass;
  }

  Step = (dt: number): boolean => {
    // Stiffness: Infinity is the "no spring, just snap" sentinel produced by
    // TransitionToSpring for Duration: 0ms. Skip the integrator entirely.
    if (!isFinite(this.Stiffness)) {
      if (this.Value === this.Target && this.Velocity === 0) return false;
      this.Value = this.Target;
      this.Velocity = 0;
      return false;
    }
    // Substep to stay inside the semi-implicit-Euler stability window.
    // For the critically-damped case the tight bound is dt·ω < 1 and the
    // damping coefficient c = 2ωm requires dt·c/m < 2 ⇒ dt·ω < 1 as well,
    // so picking safeDt = 0.3/ω gives a comfortable margin on both. Cap
    // substeps so pathological stiffness can't grind a frame — anything
    // beyond 64 substeps is effectively a snap anyway.
    const omega = Math.sqrt(this.Stiffness / this.Mass);
    const damp = this.Damping / this.Mass;
    const stiffnessLimit = omega > 1e-6 ? 0.3 / omega : dt;
    const dampingLimit = damp > 1e-6 ? 1.0 / damp : dt;
    const safeDt = Math.min(stiffnessLimit, dampingLimit);
    const rawSubsteps = Math.max(1, Math.ceil(dt / safeDt));
    const substeps = Math.min(rawSubsteps, 64);
    const subDt = dt / substeps;
    for (let i = 0; i < substeps; i++) {
      const force = -this.Stiffness * (this.Value - this.Target) - this.Damping * this.Velocity;
      this.Velocity += (force / this.Mass) * subDt;
      this.Value += this.Velocity * subDt;
    }

    // Settled?
    if (Math.abs(this.Velocity) < SETTLE_VELOCITY_EPSILON && Math.abs(this.Value - this.Target) < SETTLE_VALUE_EPSILON) {
      this.Value = this.Target;
      this.Velocity = 0;
      return false; // no longer active
    }

    return true; // still animating
  };

  /** Snap to target immediately, no animation. */
  Snap = (): void => {
    this.Value = this.Target;
    this.Velocity = 0;
  };

  /** Set a new target. Returns true if the spring needs to animate. */
  Set = (target: number): boolean => {
    this.Target = target;
    return Math.abs(this.Value - this.Target) > SETTLE_VALUE_EPSILON || Math.abs(this.Velocity) > SETTLE_VELOCITY_EPSILON;
  };

  get IsSettled(): boolean {
    return Math.abs(this.Velocity) < SETTLE_VELOCITY_EPSILON && Math.abs(this.Value - this.Target) < SETTLE_VALUE_EPSILON;
  }
}
