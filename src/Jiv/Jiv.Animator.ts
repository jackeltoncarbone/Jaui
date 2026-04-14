import { Spring } from '../Animation/Spring';
import type { Animatable } from '../Animation/Animation.Manager';
import type { Jiv } from './Jiv';

/**
 * Layout animator — springs the Jiv's X / Y / Width / Height toward targets
 * set by the layout solver. Every other animatable property (colors, border,
 * shadow, material, transform, opacity) is owned by JivStyleAnimator, which
 * chases jiv.EffectiveStyle() into jiv.RenderStyle.
 */
export class JivAnimator implements Animatable {
  readonly Springs: {
    X: Spring;
    Y: Spring;
    Width: Spring;
    Height: Spring;
  };

  constructor(
    private _jiv: Jiv,
    stiffness: number = 170,
    damping: number = 26,
    mass: number = 1,
  ) {
    this.Springs = {
      X: new Spring(_jiv.X, stiffness, damping, mass),
      Y: new Spring(_jiv.Y, stiffness, damping, mass),
      Width: new Spring(_jiv.Width, stiffness, damping, mass),
      Height: new Spring(_jiv.Height, stiffness, damping, mass),
    };
  }

  /** Update targets. Returns true if any spring needs to animate. */
  SetTargets = (targets: { X?: number; Y?: number; Width?: number; Height?: number }): boolean => {
    let needsKick = false;
    if (targets.X !== undefined) needsKick = this.Springs.X.Set(targets.X) || needsKick;
    if (targets.Y !== undefined) needsKick = this.Springs.Y.Set(targets.Y) || needsKick;
    if (targets.Width !== undefined) needsKick = this.Springs.Width.Set(targets.Width) || needsKick;
    if (targets.Height !== undefined) needsKick = this.Springs.Height.Set(targets.Height) || needsKick;
    return needsKick;
  };

  /** Force current spring values to their targets (zero velocity). Used on
   *  first layout so a newly-appeared Jiv renders at its final position
   *  immediately — no "swoop in from 0,0". */
  SnapToTargets = (): void => {
    this.Springs.X.Snap();
    this.Springs.Y.Snap();
    this.Springs.Width.Snap();
    this.Springs.Height.Snap();
    this._jiv.X = this.Springs.X.Value;
    this._jiv.Y = this.Springs.Y.Value;
    this._jiv.Width = this.Springs.Width.Value;
    this._jiv.Height = this.Springs.Height.Value;
  };

  Tick = (dt: number): boolean => {
    const s = this.Springs;
    let active = false;
    if (s.X.Step(dt)) active = true;
    if (s.Y.Step(dt)) active = true;
    if (s.Width.Step(dt)) active = true;
    if (s.Height.Step(dt)) active = true;

    this._jiv.X = s.X.Value;
    this._jiv.Y = s.Y.Value;
    this._jiv.Width = s.Width.Value;
    this._jiv.Height = s.Height.Value;

    return active;
  };
}
