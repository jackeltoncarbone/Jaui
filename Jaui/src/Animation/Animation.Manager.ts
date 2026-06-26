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

  /**
   * Advance every animatable by `dt` synchronously — the HOST (Jaui) calls this
   * once per frame at the TOP of its render frame, so spring writes (e.g.
   * Transform.Rotation via JivStyleAnimator) land BEFORE the same frame's render
   * reads them. Previously the springs advanced in this manager's OWN rAF
   * callback, a separate frame from the render, so the render read a one-frame-
   * stale value — visible as a rotating panel's progressive blur lagging its
   * edge. This is the fix; it does NOT schedule rAF (the host owns the loop).
   */
  StepFrame = (dt: number): void => {
    let anyActive = false;
    this._activeTally.clear();
    for (const a of this._animatables) {
      if (a.Tick(dt)) {
        anyActive = true;
        const n = a.constructor.name;
        this._activeTally.set(n, (this._activeTally.get(n) ?? 0) + 1);
      }
    }
    this._running = anyActive;
    // OnFrame stays wired (currently a no-op RequestFrame) for compatibility.
    if (this._onFrame) this._onFrame();
  };

  /** DIAGNOSTIC: per-frame tally of which animatable kinds are still ticking —
   *  reveals what's keeping the loop alive (perpetual `ir1`). */
  private _activeTally = new Map<string, number>();
  get ActiveSummary(): string {
    if (this._activeTally.size === 0) return 'none';
    return [...this._activeTally.entries()].map(([k, v]) => `${k}:${v}`).join(',');
  }

  // Schedule-only loop: the host's frame loop now advances the springs via
  // StepFrame, so this just keeps an rAF armed while animations are running
  // (so Kick from idle has a frame to settle on). It no longer steps the
  // animatables itself — that would double-advance them against StepFrame.
  private _tick = (): void => {
    if (this._running) {
      requestAnimationFrame(this._tick);
    } else {
      this._lastTime = 0;
    }
  };

  get IsRunning(): boolean { return this._running; }
}
