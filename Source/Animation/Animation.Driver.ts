/**
 * Per-Jiv animation driver. Owns the state machine for every `@Animation`
 * applied to a single Jiv: phase position along the timeline, travel
 * direction (for Mirror), and done flag (for Once).
 *
 * Each frame the StyleAnimator calls `Tick(dt)` to advance phase, then
 * `Patch()` to read the live property snapshot the animations want
 * applied this frame. The snapshot is a `Record<string, string>` of
 * source-level property values (matching the form a Ruleset bag holds)
 * that the StyleAnimator merges on top of the Jiv's EffectiveStyle
 * before passing through ResolveStyle. The fully-resolved RenderStyle
 * then drives the per-channel springs as usual; springs supply the
 * smoothing pass over the linear stop interpolation.
 *
 * Lookup model for multi-stop animations: find the two adjacent stops
 * bracketing the current phase, lerp each property's value by the
 * sub-phase. Numeric values (`0.5`, `1pt`, `12.5em`) lerp by parseFloat;
 * `rgb(...)` and `rgba(...)` lerp per-channel; anything else snaps to
 * the nearer stop. Cross-unit lerps (`1pt` to `2em`) also snap. The
 * spring then smooths abrupt jumps the lerp can't avoid.
 *
 * Inline anonymous animations declared on the class (with a property
 * name, e.g. `@Animation Opacity { From, To, ... }`) target ONE property.
 * Named applications target every property listed in their stops. Both
 * shapes share the same driver state, distinguished only by the set of
 * keys their stops carry.
 */

import type {
  AnimationApplication,
  AnimationDefinition,
  AnimationStop,
  LoopMode,
  SpringConfig,
} from './Animation.Types';

interface _ActiveAnimation {
  Def: AnimationDefinition;
  /** Phase in [0, 1] along the timeline. */
  Phase: number;
  /** Travel direction. +1 forward, -1 backward (Mirror only). */
  Direction: 1 | -1;
  /** Loop mode is denormalised onto each state for fast access. */
  Loop: LoopMode;
  /** True once a Once animation reaches phase=1 and stops. */
  Done: boolean;
  /** Pre-computed set of property keys this animation drives (union of
   *  every stop's `Values` keys). Lets EaseFor() answer "is this animation
   *  driving property X right now" in O(1) per query. */
  Properties: Set<string>;
}

export class JivAnimationDriver {
  private _active: _ActiveAnimation[] = [];
  /** Reused buffer rebuilt each Tick. The StyleAnimator reads via Patch(). */
  private _patch: Record<string, string> = {};

  /** Replace the active animation set. Called by the StyleAnimator when
   *  the host Jiv's class list changes (the ruleset's Animations[] is
   *  the source of truth). Named applications are resolved against the
   *  passed `animationTable`; missing names throw at attach time. */
  Apply = (
    apps: AnimationApplication[],
    animationTable: Record<string, AnimationDefinition>,
  ): void => {
    this._active = [];
    for (const app of apps) {
      let def: AnimationDefinition | undefined;
      if (app.Kind === 'Named') {
        def = animationTable[app.Name];
        if (!def) {
          throw new Error(`[Jaui] @Animation ${app.Name} is not defined; declare it at the top level before applying it.`);
        }
      } else {
        def = app.Definition;
      }
      const props = new Set<string>();
      for (const stop of def.Stops) {
        for (const k of Object.keys(stop.Values)) props.add(k);
      }
      this._active.push({
        Def: def,
        Phase: 0,
        Direction: 1,
        Loop: def.Loop,
        Done: false,
        Properties: props,
      });
    }
    this._patch = {};
  };

  /** Return the Ease setting of whichever active animation is currently
   *  driving `property`, or null if none. Source-order last-wins matches
   *  the Patch() merge: if two active animations both drive the same
   *  property, the later application's Ease wins. Done animations no
   *  longer impose Ease so the chase-to-final-value uses default tuning. */
  EaseFor = (property: string): SpringConfig | 'Linear' | null => {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const s = this._active[i];
      if (s.Done) continue;
      if (s.Properties.has(property)) return s.Def.Ease;
    }
    return null;
  };

  /** Advance each active animation's phase by `dt` seconds. Returns true
   *  if at least one animation is still running (not yet Done in Once
   *  mode). Used by the StyleAnimator to keep the rAF tick alive. */
  Tick = (dt: number): boolean => {
    if (this._active.length === 0) return false;
    let anyActive = false;
    for (const s of this._active) {
      if (s.Done) continue;
      const stepPhase = (dt * 1000) / s.Def.Duration;
      s.Phase += s.Direction * stepPhase;
      // Loop boundary handling: overshoot is reflected back so phase
      // stays in [0, 1] without truncation. Mirror flips direction;
      // Repeat wraps modulo 1; Once clamps and marks Done.
      while (true) {
        if (s.Phase > 1) {
          if (s.Loop === 'Once') {
            s.Phase = 1;
            s.Done = true;
            break;
          } else if (s.Loop === 'Repeat') {
            s.Phase -= 1;
          } else { // Mirror
            s.Phase = 2 - s.Phase;
            s.Direction = -1;
          }
          continue;
        }
        if (s.Phase < 0) {
          if (s.Loop === 'Mirror') {
            s.Phase = -s.Phase;
            s.Direction = 1;
          } else {
            s.Phase = 0;
          }
          continue;
        }
        break;
      }
      if (!s.Done) anyActive = true;
    }
    return anyActive;
  };

  /** Build the per-property string patch for the current frame. Source-
   *  order traversal so later animations win on conflict (mirrors the
   *  cascade rule the StyleAnimator's outer wiring expects). */
  Patch = (): Record<string, string> => {
    this._patch = {};
    for (const s of this._active) {
      const [lo, hi, t] = _bracket(s.Def.Stops, s.Phase);
      // Walk every property declared at either stop. Properties present
      // only at one stop interpolate against themselves (no motion) and
      // can be omitted; but emitting them is simpler and harmless.
      const keys = new Set<string>([...Object.keys(lo.Values), ...Object.keys(hi.Values)]);
      for (const k of keys) {
        const lv = lo.Values[k];
        const rv = hi.Values[k] ?? lv;
        if (lv === undefined) { this._patch[k] = rv; continue; }
        if (rv === undefined) { this._patch[k] = lv; continue; }
        this._patch[k] = _lerpValue(lv, rv, t);
      }
    }
    return this._patch;
  };

  /** True when the driver has any animation registered. Cheap probe
   *  for the StyleAnimator to skip work when no animations are active. */
  get HasAnimations(): boolean { return this._active.length > 0; }
}

/** Find the two stops bracketing the given phase. Stops are assumed
 *  pre-sorted by Phase (the parser sorts them). Returns the lower stop,
 *  the upper stop, and the sub-phase t in [0, 1] between them. */
const _bracket = (stops: AnimationStop[], phase: number): [AnimationStop, AnimationStop, number] => {
  if (stops.length === 0) {
    throw new Error('[Jaui] animation has no stops');
  }
  if (stops.length === 1 || phase <= stops[0].Phase) {
    return [stops[0], stops[0], 0];
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (phase <= b.Phase) {
      const span = b.Phase - a.Phase;
      const t = span > 0 ? (phase - a.Phase) / span : 0;
      return [a, b, t];
    }
  }
  const last = stops[stops.length - 1];
  return [last, last, 0];
};

/** Linear interpolate two string values by `t` in [0, 1]. Supported
 *  forms: numeric (with or without unit), rgb()/rgba()/#hex colors.
 *  Other forms snap to whichever stop t is closer to. */
const _lerpValue = (a: string, b: string, t: number): string => {
  if (a === b) return a;

  // Numeric, optionally unit-suffixed: "0.5", "1pt", "12.5em".
  const aNum = _parseNumericWithUnit(a);
  const bNum = _parseNumericWithUnit(b);
  if (aNum && bNum && aNum.Unit === bNum.Unit) {
    const v = aNum.Value + (bNum.Value - aNum.Value) * t;
    return aNum.Unit === '' ? _trimZero(v) : `${_trimZero(v)}${aNum.Unit}`;
  }

  // rgb()/rgba()/#hex colors.
  const aCol = _parseColor(a);
  const bCol = _parseColor(b);
  if (aCol && bCol) {
    const r = Math.round(aCol[0] + (bCol[0] - aCol[0]) * t);
    const g = Math.round(aCol[1] + (bCol[1] - aCol[1]) * t);
    const bl = Math.round(aCol[2] + (bCol[2] - aCol[2]) * t);
    const alpha = aCol[3] + (bCol[3] - aCol[3]) * t;
    if (alpha < 0.999) return `rgba(${r}, ${g}, ${bl}, ${_trimZero(alpha)})`;
    return `rgb(${r}, ${g}, ${bl})`;
  }

  // Fall back to snap at midpoint.
  return t < 0.5 ? a : b;
};

interface _ParsedNumeric { Value: number; Unit: string; }

const _parseNumericWithUnit = (s: string): _ParsedNumeric | null => {
  const m = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/i.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  return { Value: n, Unit: m[2] };
};

const _parseColor = (s: string): [number, number, number, number] | null => {
  const t = s.trim();
  // Hex form: #rgb / #rrggbb.
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16),
        parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16),
        1,
      ];
    }
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      1,
    ];
  }
  // rgb()/rgba() with comma- or space-separated channels.
  const rgb = /^rgba?\(\s*([^)]+)\)$/i.exec(t);
  if (!rgb) return null;
  const parts = rgb[1].split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = parseFloat(parts[0]);
  const g = parseFloat(parts[1]);
  const b = parseFloat(parts[2]);
  const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
  if ([r, g, b, a].some(Number.isNaN)) return null;
  return [r, g, b, a];
};

/** Format a number for output. Drops the decimal when whole, otherwise
 *  trims trailing zeros so `0.5` stays `0.5` and not `0.5000`. */
const _trimZero = (n: number): string => {
  if (Number.isInteger(n)) return n.toString();
  return parseFloat(n.toFixed(3)).toString();
};
