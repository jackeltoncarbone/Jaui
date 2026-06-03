import { Jiv } from '../Jiv/Jiv';
import type { JivStyle } from '../Jiv/Jiv.Types';
import type { LayoutConfig, ChildLayout } from '../Layout/Layout.Types';
import { Model3D } from './Model3D';

/**
 * RotationView — a Jiv that hosts a Model3D (the `Content`) and lets the user
 * spin the object sitting in its frame: drag-to-orbit, optional idle auto-spin,
 * and release-inertia. The view OWNS the pointer gesture via its own Jiv pointer
 * handlers — the engine hit-test routes the press to this Jiv (verified), so two
 * RotationViews on a page rotate independently and UI over them still clicks.
 *
 *   new RotationView({
 *     ChildLayout: { Width: '320', Height: '320' },
 *     AutoSpin: true,
 *     Content: new Model3D({ Object: someObject }),
 *   })
 *
 * No per-page boilerplate, no canvas-level listeners. The Model3D frames itself
 * to the view's rect; this wrapper only drives rotation.
 */
export interface RotationViewOptions {
  Content: Model3D;
  /** Slowly rotate while idle (no drag). Default true. */
  AutoSpin?: boolean;
  /** Idle spin speed, radians/sec. Default 0.2. */
  SpinSpeed?: number;
  /** Pitch clamp (radians). Default [-1.2, 1.2]. */
  MinPitch?: number;
  MaxPitch?: number;
  /** Starting yaw / pitch (radians). Default yaw 0.4, pitch -0.2. */
  Yaw?: number;
  Pitch?: number;
  Style?: Partial<JivStyle>;
  Layout?: Partial<LayoutConfig>;
  ChildLayout?: Partial<ChildLayout>;
}

export class RotationView extends Jiv {
  private _yaw: number;
  private _pitch: number;
  private readonly _minP: number;
  private readonly _maxP: number;
  private readonly _autoSpin: boolean;
  private readonly _spinSpeed: number;
  private readonly _model: Model3D;
  private _last: { x: number; y: number } | null = null;
  private _velYaw = 0;          // release inertia
  private _dragging = false;

  constructor(opts: RotationViewOptions) {
    super({
      Style: opts.Style,
      // The view stretches to fill its declared box; the model fills the view.
      // (Justify is main-axis: Start; Align:Stretch makes the single child fill
      // the cross axis. 'Stretch' is NOT a valid JustifyContent.)
      Layout: opts.Layout ?? { Direction: 'Column', Justify: 'Start', Align: 'Stretch' },
      ChildLayout: opts.ChildLayout,
    });
    this._model = opts.Content;
    this._yaw = opts.Yaw ?? 0.4;
    this._pitch = opts.Pitch ?? -0.2;
    this._minP = opts.MinPitch ?? -1.2;
    this._maxP = opts.MaxPitch ?? 1.2;
    this._autoSpin = opts.AutoSpin ?? true;
    this._spinSpeed = opts.SpinSpeed ?? 0.2;

    // Model fills the view.
    this._model.ChildLayout = { ...this._model.ChildLayout, FlexGrow: 1, FlexShrink: 1 };
    this.AddChild(this._model);
    this._model.Model.SetAnimating(this._autoSpin);   // tick while idle-spinning
    // Self-drive: the Model3D renderer's per-frame Update calls this, so idle
    // spin + inertia advance with NO external frame-loop wiring by the consumer.
    this._model.Model.OnTick = (dt) => this.Tick(dt);

    // Drag-orbit owned by this Jiv. The engine routes the press here.
    this.OnPointerDown = (e: PointerEvent) => {
      this._last = { x: e.clientX, y: e.clientY };
      this._dragging = true;
      this._velYaw = 0;
    };
    this.OnPointerMove = (e: PointerEvent) => {
      if (!this._last) return;
      const dx = e.clientX - this._last.x;
      const dy = e.clientY - this._last.y;
      this._yaw += dx * 0.01;
      this._velYaw = dx * 0.01;     // remember for inertia
      this._pitch = Math.max(this._minP, Math.min(this._maxP, this._pitch + dy * 0.01));
      this._last = { x: e.clientX, y: e.clientY };
      this._apply();
    };
    const end = (): void => { this._last = null; this._dragging = false; };
    this.OnPointerUp = end;

    this._apply();
  }

  private _apply(): void { this._model.Model.SetRotation(this._pitch, this._yaw); }

  /** Called by the host each frame (or wired to the animation loop) to advance
   *  idle spin + inertia. The Model3D already requests frames while animating;
   *  this just integrates rotation over time. dt in seconds. */
  Tick(dt: number): void {
    if (this._dragging) return;
    if (Math.abs(this._velYaw) > 0.0001) {
      this._yaw += this._velYaw;
      this._velYaw *= 0.92;       // decay
      this._apply();
    } else if (this._autoSpin) {
      this._yaw += this._spinSpeed * dt;
      this._apply();
    }
  }
}
