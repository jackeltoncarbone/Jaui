/**
 * Damped harmonic oscillator:  m·x'' + c·x' + k·(x - target) = 0.
 * Default k=170, c=26, m=1 is near critical damping — smooth, no overshoot.
 *
 * `Step` uses the CLOSED-FORM (analytic) solution of the ODE, not numerical
 * integration. Given (x, v, target, dt) it computes the exact (x, v) at the
 * end of the step from the system's eigenvalues — handling under-, critically-,
 * and over-damped regimes. Consequences vs the old semi-implicit-Euler path:
 *   • EXACT for any dt — no stability window, so stiff springs (short
 *     transitions) and huge frame times (slow software renderers) can never
 *     diverge into the white/black flashing the Euler path risked.
 *   • O(1) per channel — no substepping. The Euler path chopped large dts into
 *     `ceil(dt/safeDt)` micro-steps, so on a slow device (large dt) every spring
 *     paid ~16× the work — and ran it even when fully at rest. With ~9.5k spring
 *     channels per frame that was ~150k pointless iterations/frame on WARP.
 *   • At-rest early-out — a settled spring returns immediately with zero work.
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
    // Non-finite seeds (a node constructed before its first solve) must not
    // enter the integrator — one NaN poisons every subsequent Step forever
    // (NaN position → NaN force → NaN velocity, and the settle check never
    // trips, so the spring also never parks).
    this.Value = Number.isFinite(value) ? value : 0;
    this.Target = this.Value;
    this.Stiffness = stiffness;
    this.Damping = damping;
    this.Mass = mass;
  }

  Step = (dt: number): boolean => {
    // Self-heal a poisoned state: if Value/Velocity ever went non-finite
    // (a NaN target slipped in before Set() guarded, or external writes),
    // integration can never recover — snap to the target and settle.
    if (!Number.isFinite(this.Value) || !Number.isFinite(this.Velocity)) {
      this.Value = Number.isFinite(this.Target) ? this.Target : 0;
      this.Velocity = 0;
      return false;
    }
    // Stiffness: Infinity is the "no spring, just snap" sentinel produced by
    // TransitionToSpring for Duration: 0ms. Skip the integrator entirely.
    if (!isFinite(this.Stiffness)) {
      if (this.Value === this.Target && this.Velocity === 0) return false;
      this.Value = this.Target;
      this.Velocity = 0;
      return false;
    }
    // Displacement from target + current velocity.
    const r0 = this.Value - this.Target;
    const v0 = this.Velocity;

    // At-rest early-out — O(1). The dominant win on slow devices: a settled
    // spring does NO integration work (the old Euler path re-ran its whole
    // substep loop every frame for every channel even when nothing moved,
    // which on WARP was ~150k pointless iterations/frame across all springs).
    if (Math.abs(r0) < SETTLE_VALUE_EPSILON && Math.abs(v0) < SETTLE_VELOCITY_EPSILON) {
      this.Value = this.Target;
      this.Velocity = 0;
      return false;
    }
    if (dt <= 0) return true;

    // Analytic (closed-form) damped-harmonic step. Exact for ANY dt — there's
    // no semi-implicit-Euler stability window to blow past and no substepping,
    // so cost is O(1) per channel regardless of frame time AND the integrator
    // can never diverge. Equation (relative to target r = x - target):
    //   r'' + (c/m)·r' + (k/m)·r = 0,  ω₀ = √(k/m),  ζ = c / (2√(k·m)).
    const m  = this.Mass > 1e-9 ? this.Mass : 1e-9;
    const w0 = Math.sqrt(this.Stiffness / m);
    if (w0 < 1e-9) {            // no stiffness → treat as settled (no restoring force)
      this.Value = this.Target;
      this.Velocity = 0;
      return false;
    }
    const zeta = this.Damping / (2 * Math.sqrt(this.Stiffness * m));
    let r1: number, v1: number;
    if (zeta > 1 + 1e-4) {
      // Over-damped: two distinct real roots, monotonic decay.
      const s  = w0 * Math.sqrt(zeta * zeta - 1);
      const s1 = -zeta * w0 + s;
      const s2 = -zeta * w0 - s;
      const denom = s1 - s2;
      const a = (v0 - r0 * s2) / denom;
      const b = (r0 * s1 - v0) / denom;
      const e1 = Math.exp(s1 * dt);
      const e2 = Math.exp(s2 * dt);
      r1 = a * e1 + b * e2;
      v1 = a * s1 * e1 + b * s2 * e2;
    } else if (zeta < 1 - 1e-4) {
      // Under-damped: decaying oscillation (overshoots — only if an author
      // explicitly tunes a bouncy spring; the design default is critical).
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      const e  = Math.exp(-zeta * w0 * dt);
      const c  = Math.cos(wd * dt);
      const sn = Math.sin(wd * dt);
      const b  = (v0 + zeta * w0 * r0) / wd;
      r1 = e * (r0 * c + b * sn);
      v1 = e * (-zeta * w0 * (r0 * c + b * sn) + wd * (-r0 * sn + b * c));
    } else {
      // Critically damped — the design default (fastest settle, no overshoot).
      const e = Math.exp(-w0 * dt);
      const b = v0 + w0 * r0;
      r1 = (r0 + b * dt) * e;
      v1 = (v0 - w0 * b * dt) * e;
    }
    this.Value = this.Target + r1;
    this.Velocity = v1;

    // Settled?
    if (Math.abs(this.Velocity) < SETTLE_VELOCITY_EPSILON && Math.abs(r1) < SETTLE_VALUE_EPSILON) {
      this.Value = this.Target;
      this.Velocity = 0;
      return false; // no longer active
    }

    return true; // still animating
  };

  /** Snap to target immediately, no animation. */
  Snap = (): void => {
    this.Value = Number.isFinite(this.Target) ? this.Target : 0;
    this.Velocity = 0;
  };

  /** Set a new target. Returns true if the spring needs to animate.
   *  Non-finite targets are REFUSED (the spring keeps its prior target) —
   *  a single NaN frame from a degenerate layout input must not poison the
   *  integrator permanently. A poisoned current state heals against the
   *  incoming finite target instead. */
  Set = (target: number): boolean => {
    if (!Number.isFinite(target)) return false;
    if (!Number.isFinite(this.Value) || !Number.isFinite(this.Velocity)) {
      this.Target = target;
      this.Value = target;
      this.Velocity = 0;
      return false;
    }
    this.Target = target;
    return Math.abs(this.Value - this.Target) > SETTLE_VALUE_EPSILON || Math.abs(this.Velocity) > SETTLE_VELOCITY_EPSILON;
  };

  get IsSettled(): boolean {
    return Math.abs(this.Velocity) < SETTLE_VELOCITY_EPSILON && Math.abs(this.Value - this.Target) < SETTLE_VALUE_EPSILON;
  }
}
