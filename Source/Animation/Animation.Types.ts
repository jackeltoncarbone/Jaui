export interface SpringConfig {
  Stiffness: number;
  Damping: number;
  Mass: number;
}

/** Loop semantics for `@Animation`. Duration is one-direction travel
 *  time, not the full cycle:
 *    Once   - play 0% -> 100% and stop at 100%.
 *    Repeat - at 100%, jump back to 0% and replay forward (discontinuous).
 *    Mirror - at 100%, reverse direction back to 0% (smooth ping-pong).
 *  Default when Loop is omitted is Once. */
export type LoopMode = 'Once' | 'Repeat' | 'Mirror';

/** One keyframe stop. The runtime resolves each stop's `Values` through
 *  the normal style cascade per Jiv (so vars and units inherit), then
 *  blends numerically between adjacent stops by phase. */
export interface AnimationStop {
  /** Position in `[0, 1]` along the animation timeline. `From` = 0, `To` = 1.
   *  Percent stops (`50%: ...`) land here as `0.5`. */
  Phase: number;
  /** Raw property string values, source-level (e.g. `"rgb(34, 34, 34)"`,
   *  `"0.5"`, `"1pt"`). Mirrors the value form on a Ruleset's Style /
   *  Layout / TextStyle slots so the same resolver pipeline applies. */
  Values: Record<string, string>;
}

/** Root-level `@Animation Name { ... }` definition. Stops are compile-
 *  time resolved (class-refs baked to their property bags). */
export interface AnimationDefinition {
  Name: string;
  /** One-direction travel time in milliseconds. */
  Duration: number;
  Loop: LoopMode;
  /** Optional explicit spring tuning. When null, the runtime falls back
   *  to the property's `@Spring` / `@Transition` declared on the host
   *  class, or to the global defaults if none. */
  Ease: SpringConfig | 'Linear' | null;
  Stops: AnimationStop[];
}

/** Per-class application of one or more animations.
 *    `@Animation Pulse`                  -> { Kind: 'Named', Name: 'Pulse' }
 *    `@Animation Opacity { From, To }`   -> { Kind: 'Inline', Definition: ... }
 *  Class-scoped only. Multiple applications stack; the precedence cascade
 *  resolves conflicts (inline beats named, source-order last-wins). */
export type AnimationApplication =
  | { Kind: 'Named'; Name: string }
  | { Kind: 'Inline'; Property: string; Definition: AnimationDefinition };

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
  // Duration 0 means snap — Spring.Step short-circuits on non-finite stiffness.
  if (durationMs <= 0) return { Stiffness: Infinity, Damping: Infinity, Mass: mass };
  const seconds = durationMs / 1000;
  const omega = 5 / seconds;
  const stiffness = omega * omega * mass;
  const dampingRatio = cfg.Easing === 'EaseInOut' ? 0.85 : 1;
  const damping = 2 * omega * mass * dampingRatio;
  return { Stiffness: stiffness, Damping: damping, Mass: mass };
};
