/**
 * Damped harmonic oscillator.
 *   F = -k*(x - target) - c*v
 *   a = F / m
 *   v += a * dt
 *   x += v * dt
 *
 * Default k=170, c=26, m=1 is near critical damping — smooth, no overshoot.
 */
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
    const force = -this.Stiffness * (this.Value - this.Target) - this.Damping * this.Velocity;
    this.Velocity += (force / this.Mass) * dt;
    this.Value += this.Velocity * dt;

    // Settled?
    if (Math.abs(this.Velocity) < 0.1 && Math.abs(this.Value - this.Target) < 0.1) {
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
    return Math.abs(this.Value - this.Target) > 0.1 || Math.abs(this.Velocity) > 0.1;
  };

  get IsSettled(): boolean {
    return Math.abs(this.Velocity) < 0.1 && Math.abs(this.Value - this.Target) < 0.1;
  }
}
