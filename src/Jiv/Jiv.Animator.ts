import { Spring } from '../Animation/Spring';
import type { Animatable } from '../Animation/Animation.Manager';
import type { Jiv } from './Jiv';

/**
 * Drives a Jiv's layout properties (X, Y, Width, Height) and
 * visual properties (Opacity, BorderRadius, etc.) via springs.
 *
 * Call SetTarget() to update where the Jiv should be.
 * Each Tick() steps the springs and writes current values to the Jiv.
 */
export class JivAnimator implements Animatable {
  readonly Springs: {
    X: Spring;
    Y: Spring;
    Width: Spring;
    Height: Spring;
    Opacity: Spring;
    ScaleX: Spring;
    ScaleY: Spring;
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
      Opacity: new Spring(_jiv.Style.Opacity, stiffness, damping, mass),
      ScaleX: new Spring(_jiv.Style.Transform.ScaleX, stiffness, damping, mass),
      ScaleY: new Spring(_jiv.Style.Transform.ScaleY, stiffness, damping, mass),
    };
  }

  /** Update targets. Returns true if any spring needs to animate. */
  SetTargets = (targets: {
    X?: number; Y?: number; Width?: number; Height?: number;
    Opacity?: number; ScaleX?: number; ScaleY?: number;
  }): boolean => {
    let needsKick = false;
    if (targets.X !== undefined) needsKick = this.Springs.X.Set(targets.X) || needsKick;
    if (targets.Y !== undefined) needsKick = this.Springs.Y.Set(targets.Y) || needsKick;
    if (targets.Width !== undefined) needsKick = this.Springs.Width.Set(targets.Width) || needsKick;
    if (targets.Height !== undefined) needsKick = this.Springs.Height.Set(targets.Height) || needsKick;
    if (targets.Opacity !== undefined) needsKick = this.Springs.Opacity.Set(targets.Opacity) || needsKick;
    if (targets.ScaleX !== undefined) needsKick = this.Springs.ScaleX.Set(targets.ScaleX) || needsKick;
    if (targets.ScaleY !== undefined) needsKick = this.Springs.ScaleY.Set(targets.ScaleY) || needsKick;
    return needsKick;
  };

  /** Force current spring values to their targets (zero velocity). Used on
   *  first layout so a newly-appeared Jiv renders at its final position
   *  immediately — no "swoop in from 0,0" even if the animator was created
   *  before node.X/Y/W/H were set. Prefer this over relying on the constructor
   *  reading a particular ordering. */
  SnapToTargets = (): void => {
    this.Springs.X.Snap();
    this.Springs.Y.Snap();
    this.Springs.Width.Snap();
    this.Springs.Height.Snap();
    this.Springs.Opacity.Snap();
    this.Springs.ScaleX.Snap();
    this.Springs.ScaleY.Snap();
    // Mirror the snapped values back to the Jiv immediately
    this._jiv.X = this.Springs.X.Value;
    this._jiv.Y = this.Springs.Y.Value;
    this._jiv.Width = this.Springs.Width.Value;
    this._jiv.Height = this.Springs.Height.Value;
    this._jiv.Style.Opacity = this.Springs.Opacity.Value;
    this._jiv.Style.Transform.ScaleX = this.Springs.ScaleX.Value;
    this._jiv.Style.Transform.ScaleY = this.Springs.ScaleY.Value;
  };

  Tick = (dt: number): boolean => {
    let active = false;
    const s = this.Springs;

    active = s.X.Step(dt) || active;
    active = s.Y.Step(dt) || active;
    active = s.Width.Step(dt) || active;
    active = s.Height.Step(dt) || active;
    active = s.Opacity.Step(dt) || active;
    active = s.ScaleX.Step(dt) || active;
    active = s.ScaleY.Step(dt) || active;

    // Write spring values to the Jiv
    this._jiv.X = s.X.Value;
    this._jiv.Y = s.Y.Value;
    this._jiv.Width = s.Width.Value;
    this._jiv.Height = s.Height.Value;
    this._jiv.Style.Opacity = s.Opacity.Value;
    this._jiv.Style.Transform.ScaleX = s.ScaleX.Value;
    this._jiv.Style.Transform.ScaleY = s.ScaleY.Value;

    return active;
  };
}
