export interface SpringConfig {
  Stiffness: number;
  Damping: number;
  Mass: number;
}

export interface TransitionConfig {
  Duration: number;            // ms
  Easing: 'Linear' | 'EaseOut' | 'EaseInOut' | 'Spring';
  Spring: SpringConfig | null; // used when Easing = 'Spring'
}

export const DefaultSpringConfig: SpringConfig = {
  Stiffness: 170,
  Damping: 26,
  Mass: 1,
};

// Default transition: dissolve linearly (opacity animation)
export const DefaultTransition: TransitionConfig = {
  Duration: 200,
  Easing: 'Linear',
  Spring: null,
};

/** Critically-damped spring whose 5%-settle time matches the requested
 *  TransitionConfig.Duration (ms). Used by JSS authoring so writers can
 *  specify either a spring directly OR a CSS-style duration; both reach
 *  the same animator. EaseInOut nudges the damping ratio slightly under
 *  critical for symmetrical in-out feel. Linear is treated as critical
 *  (springs don't do linear; author should use @Spring directly for
 *  hard non-physics curves).
 *
 *  Math: t_s ≈ 5/ω for critical damping → ω = 5 / DurationSeconds.
 *  Stiffness = ω²·m, Damping = 2·ω·m·dampingRatio. */
export const TransitionToSpring = (cfg: Partial<TransitionConfig>): SpringConfig => {
  const durationMs = cfg.Duration ?? DefaultTransition.Duration;
  const mass = cfg.Spring?.Mass ?? 1;
  const seconds = Math.max(0.016, durationMs / 1000);
  const omega = 5 / seconds;
  const stiffness = omega * omega * mass;
  const dampingRatio = cfg.Easing === 'EaseInOut' ? 0.85 : 1;
  const damping = 2 * omega * mass * dampingRatio;
  return { Stiffness: stiffness, Damping: damping, Mass: mass };
};
