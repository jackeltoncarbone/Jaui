/**
 * Central animation loop. Steps all registered animatables each frame.
 * Auto-stops when everything settles. Auto-starts when anything moves.
 */

export interface Animatable {
  /** Step the animation by dt seconds. Return true if still animating. */
  Tick(dt: number): boolean;
}

export class AnimationManager {
  private _animatables = new Set<Animatable>();
  private _running: boolean = false;
  private _lastTime: number = 0;
  private _onFrame: (() => void) | null = null;

  /** Register a callback to fire after all animations step (triggers re-render). */
  OnFrame = (cb: () => void): void => {
    this._onFrame = cb;
  };

  Register = (animatable: Animatable): void => {
    this._animatables.add(animatable);
  };

  Unregister = (animatable: Animatable): void => {
    this._animatables.delete(animatable);
  };

  /** Kick the loop if it's not already running. */
  Kick = (): void => {
    if (this._running) return;
    this._running = true;
    this._lastTime = 0;
    requestAnimationFrame(this._tick);
  };

  private _tick = (time: number): void => {
    if (!this._lastTime) this._lastTime = time;
    // Cap at 1s of catch-up. Spring.Step substeps internally for stability
    // (up to 64 substeps), so honoring real wall-clock dt is safe — and
    // necessary, otherwise a main-thread block during a fade-in leaves
    // springs frozen mid-curve until they crawl back up at 33ms/frame
    // (the symptom that looks like UI "freezing mid-opacity"). 1s is a
    // long-enough cap that ~all visible blocks resolve in one Step, but
    // still bounds work after a backgrounded-tab return.
    const dt = Math.min((time - this._lastTime) / 1000, 1.0);
    this._lastTime = time;

    let anyActive = false;
    for (const a of this._animatables) {
      if (a.Tick(dt)) anyActive = true;
    }

    if (this._onFrame) this._onFrame();

    if (anyActive) {
      requestAnimationFrame(this._tick);
    } else {
      this._running = false;
      this._lastTime = 0;
    }
  };

  get IsRunning(): boolean { return this._running; }
}
