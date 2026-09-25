import { Spring } from '../Animation/Spring';

// UIKit's _UIFlexInteraction, the press every interactive glass wears (UIPlatformGlassFlexInteraction; variant 0,
// sources 3). The facts and their addresses are in Jwift/Apple/LiquidGlass.md 9; how JSS names them is Glass.Jss.md.

/** `Flex: None | Auto | Small | UltraSmall | Large | Menu`. Auto is UIKit's dynamic variant, picked by size. */
export type FlexKind = 'None' | 'Auto' | 'Small' | 'UltraSmall' | 'Large' | 'Menu';

/** One variant spec, in points and seconds. The springs are UIKit's (damping ratio, response). */
export interface FlexSpec {
  Lift: number;
  BigGlow: number;
  LittleGlow: number;
  Dissipation: number;
  Threshold: number;
  MoveNorm: number;
  MovePoints: number;
  MinScale: number;
  MaxScale: number;
  Damping: number;
  Response: number;
  TrackingDamping: number;
  TrackingResponse: number;
}

// setDefaultValues: Small 0x188C4F3C0, Large 0x188C4EBE0, UltraSmall is Small with scaleDistanceThreshold 2000.
const SMALL: FlexSpec = {
  Lift: 16, BigGlow: 1, LittleGlow: 0.3, Dissipation: 50, Threshold: 6000, MoveNorm: 10000, MovePoints: 10,
  MinScale: 0.9, MaxScale: 1.1, Damping: 0.375, Response: 0.4, TrackingDamping: 0.625, TrackingResponse: 0.262,
};
const ULTRA_SMALL: FlexSpec = { ...SMALL, Threshold: 2000 };
const LARGE: FlexSpec = {
  Lift: 4, BigGlow: 0, LittleGlow: 0.2, Dissipation: 50, Threshold: 24000, MoveNorm: 10000, MovePoints: 5,
  MinScale: 0.9, MaxScale: 1.1, Damping: 0.6, Response: 0.36, TrackingDamping: 0.625, TrackingResponse: 0.314,
};
// The menu variant answers through its interaction pulse, which is not ported: its glow only.
const MENU: FlexSpec = { ...SMALL, Lift: 0, BigGlow: 0, LittleGlow: 0.5, Threshold: Infinity, MoveNorm: Infinity };

const lerp = (t: number, a: number, b: number): number => a + (b - a) * t;

/** The spec for a control of `width` x `height` points (sub_188F76B80 for Auto): a longer side under 120 takes
 *  UltraSmall; otherwise Small to Large by the shorter side over 44 to 160, the movement fields staying Small's. */
export const FlexSpecFor = (kind: FlexKind, width: number, height: number): FlexSpec | null => {
  switch (kind) {
    case 'None': return null;
    case 'Small': return SMALL;
    case 'UltraSmall': return ULTRA_SMALL;
    case 'Large': return LARGE;
    case 'Menu': return MENU;
  }
  if (Math.max(width, height) < 120) return ULTRA_SMALL;
  const t = Math.min(1, Math.max(0, (Math.min(width, height) - 44) / (160 - 44)));
  return {
    ...SMALL,
    Lift: lerp(t, SMALL.Lift, LARGE.Lift),
    BigGlow: lerp(t, SMALL.BigGlow, LARGE.BigGlow),
    LittleGlow: lerp(t, SMALL.LittleGlow, LARGE.LittleGlow),
    Dissipation: lerp(t, SMALL.Dissipation, LARGE.Dissipation),
    Threshold: lerp(t, SMALL.Threshold, LARGE.Threshold),
    MoveNorm: lerp(t, SMALL.MoveNorm, LARGE.MoveNorm),
    Damping: lerp(t, SMALL.Damping, LARGE.Damping),
    Response: lerp(t, SMALL.Response, LARGE.Response),
    TrackingDamping: lerp(t, SMALL.TrackingDamping, LARGE.TrackingDamping),
    TrackingResponse: lerp(t, SMALL.TrackingResponse, LARGE.TrackingResponse),
  };
};

/** The pressed swell of a `width` x `height` pt control: (longer + liftScalePoints) / longer. */
export const FlexLiftScale = (width: number, height: number): number => {
  const spec = FlexSpecFor('Auto', width, height)!;
  return 1 + spec.Lift / Math.max(width, height, 1);
};

/** The big glow's opacity while pressed (bigGlowOpacity of the Auto spec). */
export const FlexBigGlow = (width: number, height: number): number => FlexSpecFor('Auto', width, height)!.BigGlow;

/** Resolved `Flex*` settings. NaN is Auto: the spec's own value. */
export interface FlexSettings {
  Kind: FlexKind;
  Lift: number;
  BigGlow: number;
  LittleGlow: number;
  Movement: boolean;
}

// UIKit's spring (damping ratio, response) as a unit-mass oscillator.
const tune = (spring: Spring, damping: number, response: number): void => {
  const w = (2 * Math.PI) / response;
  spring.Stiffness = w * w;
  spring.Damping = 2 * damping * w;
  spring.Mass = 1;
};

// Rubber-band clamp (sub_1891F05D0): past either bound the value eases into a band a third of the range wide,
// through tanh at 0.55.
const softClamp = (x: number, low: number, high: number): number => {
  const band = (high - low) / 3;
  if (band <= 0) return Math.min(high, Math.max(low, x));
  if (x < low) {
    const floor = low - band;
    return floor + band * (Math.tanh(((x - floor) / band) * 0.55 - 0.55) + 1);
  }
  if (x > high) return high + band * Math.tanh(((x - high) / band) * 0.55);
  return x;
};

// The finger's acceleration is smoothed over this window, standing in for UIKit's velocity integrator [I].
const ACCELERATION_SMOOTHING_S = 0.05;

/**
 * One control's flex while it is pressed: the lift, the stretch toward a finger that travels, the squash of its
 * acceleration, the big glow over the whole glass and the little glow under the finger. Positions are the
 * control's local CSS px; the spec is read in points.
 */
export class FlexMotion {
  readonly ScaleX = new Spring(1);
  readonly ScaleY = new Spring(1);
  readonly TranslateX = new Spring(0);
  readonly TranslateY = new Spring(0);
  readonly BigGlow = new Spring(0);
  readonly LittleAlpha = new Spring(0);
  readonly LittleScale = new Spring(1);
  readonly LittleX = new Spring(0);
  readonly LittleY = new Spring(0);
  /** The little glow's diameter at scale 1, in CSS px. */
  LittleDiameter = 0;
  Active = false;

  private _spec: FlexSpec = SMALL;
  private _movement = true;
  private _lift = 1;
  private _width = 1;
  private _height = 1;
  private _pointScale = 1;
  private _startX = 0;
  private _startY = 0;
  private _moved = false;
  private _dissipated = false;
  private _lastX = 0;
  private _lastY = 0;
  private _lastT = -1;
  private _velocityX = 0;
  private _velocityY = 0;
  private _accelerationX = 0;
  private _accelerationY = 0;
  private _sampleVelocityX = 0;
  private _sampleVelocityY = 0;

  /** True while anything is still moving. */
  get Moving(): boolean {
    return this.Active || !this.ScaleX.IsSettled || !this.ScaleY.IsSettled || !this.TranslateX.IsSettled
      || !this.TranslateY.IsSettled || !this.BigGlow.IsSettled || !this.LittleAlpha.IsSettled;
  }

  /** The touch lands at (`x`, `y`) on a `width` x `height` px control (showGlowAt, activateIfPermitted). */
  Begin(x: number, y: number, width: number, height: number, pointScale: number, settings: FlexSettings, timeMs: number): boolean {
    const scale = pointScale > 0 ? pointScale : 1;
    const spec = FlexSpecFor(settings.Kind, width / scale, height / scale);
    if (spec === null || width <= 0 || height <= 0) return false;
    this._spec = {
      ...spec,
      Lift: Number.isNaN(settings.Lift) ? spec.Lift : settings.Lift,
      BigGlow: Number.isNaN(settings.BigGlow) ? spec.BigGlow : settings.BigGlow,
      LittleGlow: Number.isNaN(settings.LittleGlow) ? spec.LittleGlow : settings.LittleGlow,
    };
    this._movement = settings.Movement;
    this._width = width;
    this._height = height;
    this._pointScale = scale;
    this.Active = true;
    this._moved = false;
    this._dissipated = false;
    const cx = Math.min(width, Math.max(0, x));
    const cy = Math.min(height, Math.max(0, y));
    this._startX = cx;
    this._startY = cy;
    this._lastX = x;
    this._lastY = y;
    this._lastT = timeMs;
    this._velocityX = this._velocityY = this._accelerationX = this._accelerationY = 0;
    this._sampleVelocityX = this._sampleVelocityY = 0;
    const longer = Math.max(width, height) / scale;
    this._lift = (longer + this._spec.Lift) / longer;
    // The little glow: a white disc 1.5 x the shorter side, at most 160 pt, laid at the touch (sub_188D881C8).
    this.LittleDiameter = Math.min(1.5 * Math.min(width, height), 160 * scale);
    this.LittleX.Value = this.LittleX.Target = cx;
    this.LittleY.Value = this.LittleY.Target = cy;
    this.LittleX.Velocity = this.LittleY.Velocity = 0;
    this.LittleScale.Value = this.LittleScale.Target = 1;
    this.LittleScale.Velocity = 0;
    this.LittleAlpha.Value = 0;
    this.LittleAlpha.Velocity = 0;
    // Both glows come up on 1.0 / 0.1 s (sub_188D768F0), the little one following on 1.0 / 0.15 s (sub_188D76F28).
    tune(this.BigGlow, 1, 0.1);
    tune(this.LittleAlpha, 1, 0.1);
    tune(this.LittleX, 1, 0.15);
    tune(this.LittleY, 1, 0.15);
    this.BigGlow.Target = this._spec.BigGlow;
    this.LittleAlpha.Target = this._spec.LittleGlow;
    this._retarget();
    return true;
  }

  /** The finger is at (`x`, `y`) (handlePan, state changed). */
  Move(x: number, y: number, timeMs: number): void {
    if (!this.Active) return;
    const dt = (timeMs - this._lastT) / 1000;
    if (dt > 0) {
      const vx = (x - this._lastX) / this._pointScale / dt;
      const vy = (y - this._lastY) / this._pointScale / dt;
      this._sampleVelocityX = vx;
      this._sampleVelocityY = vy;
    }
    this._lastX = x;
    this._lastY = y;
    this._lastT = timeMs;
    this._moved = true;
    const cx = Math.min(this._width, Math.max(0, x));
    const cy = Math.min(this._height, Math.max(0, y));
    this.LittleX.Target = cx;
    this.LittleY.Target = cy;
    // Past the dissipation distance the little glow halves and doubles (sub_188EA9218, 1.0 / 0.5 s).
    const travel = Math.hypot(x - this._startX, y - this._startY) / this._pointScale;
    if (!this._dissipated && travel > this._spec.Dissipation) {
      this._dissipated = true;
      tune(this.LittleAlpha, 1, 0.5);
      tune(this.LittleScale, 1, 0.5);
      this.LittleAlpha.Target = this._spec.LittleGlow * 0.5;
      this.LittleScale.Target = 2;
    }
    this._retarget();
  }

  /** The finger lifts, or the gesture is lost (hideGlow, deactivate): everything settles home on 1.0 / 0.5 s. */
  End(): void {
    if (!this.Active) return;
    this.Active = false;
    this._moved = false;
    this._velocityX = this._velocityY = this._accelerationX = this._accelerationY = 0;
    tune(this.BigGlow, 1, 0.5);
    tune(this.LittleAlpha, 1, 0.5);
    tune(this.LittleScale, 1, 0.5);
    this.BigGlow.Target = 0;
    this.LittleAlpha.Target = 0;
    this.LittleScale.Target = 4;
    this._retarget();
  }

  Step(dt: number): boolean {
    if (this.Active && this._movement && dt > 0) {
      // The integrator's acceleration: the smoothed change of the finger's velocity, decaying when it rests.
      const k = 1 - Math.exp(-dt / ACCELERATION_SMOOTHING_S);
      const vx = this._velocityX + (this._sampleVelocityX - this._velocityX) * k;
      const vy = this._velocityY + (this._sampleVelocityY - this._velocityY) * k;
      this._accelerationX += ((vx - this._velocityX) / dt - this._accelerationX) * k;
      this._accelerationY += ((vy - this._velocityY) / dt - this._accelerationY) * k;
      this._velocityX = vx;
      this._velocityY = vy;
      this._sampleVelocityX *= 1 - k;
      this._sampleVelocityY *= 1 - k;
      this._retarget();
    }
    let moving = false;
    for (const s of [this.ScaleX, this.ScaleY, this.TranslateX, this.TranslateY, this.BigGlow, this.LittleAlpha,
      this.LittleScale, this.LittleX, this.LittleY]) {
      if (s.Step(dt)) moving = true;
    }
    return moving || this.Active;
  }

  // updateFlex (sub_188EA7518): the lift, then the translation stretch, then the acceleration squash.
  private _retarget(): void {
    const spec = this._spec;
    const tracking = this.Active && this._moved;
    for (const s of [this.ScaleX, this.ScaleY, this.TranslateX, this.TranslateY]) {
      tune(s, tracking ? spec.TrackingDamping : spec.Damping, tracking ? spec.TrackingResponse : spec.Response);
    }
    if (!this.Active) {
      this.ScaleX.Target = this.ScaleY.Target = 1;
      this.TranslateX.Target = this.TranslateY.Target = 0;
      return;
    }
    let sx = this._lift;
    let sy = this._lift;
    let tx = 0;
    let ty = 0;
    if (this._movement && Number.isFinite(spec.Threshold) && spec.Threshold > 0) {
      const ps = this._pointScale;
      const x = this._lastX;
      const y = this._lastY;
      const translationX = (x - this._startX) / ps;
      const translationY = (y - this._startY) / ps;
      const insideX = (Math.min(this._width, Math.max(0, x)) - this._startX) / ps;
      const insideY = (Math.min(this._height, Math.max(0, y)) - this._startY) / ps;
      // Travel inside the control counts a quarter; past its edge, whole.
      if (translationX !== 0) {
        const k = Math.abs(insideX) / (4 * spec.Threshold) + (Math.abs(translationX) - Math.abs(insideX)) / spec.Threshold;
        sx += k;
        sy -= k;
        tx = this._width * k * Math.sign(translationX);
      }
      if (translationY !== 0) {
        const k = Math.abs(insideY) / (4 * spec.Threshold) + (Math.abs(translationY) - Math.abs(insideY)) / spec.Threshold;
        sx -= k;
        sy += k;
        ty = this._height * k * Math.sign(translationY);
      }
    }
    if (this._movement && Number.isFinite(spec.MoveNorm)) {
      const bounds = (side: number): [number, number] => {
        const pts = side / this._pointScale;
        return [Math.max(spec.MinScale, (pts - spec.MovePoints) / pts), Math.min(spec.MaxScale, (pts + spec.MovePoints) / pts)];
      };
      const [minX, maxX] = bounds(this._width);
      const [minY, maxY] = bounds(this._height);
      const ax = this._accelerationX / spec.MoveNorm;
      const ay = this._accelerationY / spec.MoveNorm;
      if (ax !== 0) {
        const along = softClamp(lerp(ax, 1, maxX), minX, maxX);
        sx += along - 1;
        tx += (1 - along) * 0.2 * this._width;
        sy += softClamp(lerp(ax, 1, minY), minY, maxY) - 1;
      }
      if (ay !== 0) {
        const along = softClamp(lerp(ay, 1, maxY), minY, maxY);
        sy += along - 1;
        ty += (1 - along) * 0.2 * this._height;
        sx += softClamp(lerp(ay, 1, minX), minX, maxX) - 1;
      }
    }
    this.ScaleX.Target = sx;
    this.ScaleY.Target = sy;
    this.TranslateX.Target = tx;
    this.TranslateY.Target = ty;
  }
}
