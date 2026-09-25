/**
 * Central animation loop. Steps the registered animatables each frame.
 * Auto-stops when everything settles. Auto-starts when anything moves.
 *
 * AN ANIMATABLE AT REST IS NOT STEPPED. One that carries a `Rouse` slot promises that once its Tick
 * returns false and `CanSleep` agrees, every further Tick is an exact no-op until it calls `Rouse`
 * from whatever changed it. So a page with one moving leaf steps that leaf, not every node it holds.
 */

import { PerfLevers } from '../Core/Perf.Levers';

export interface Animatable {
  /** Step the animation by dt seconds. Return true if still animating. */
  Tick(dt: number): boolean;
  /** Installed by the manager on a sleeper; the animatable calls it from every mutation of its state. */
  Rouse?: (() => void) | null;
  /** Asked after a Tick returned false: may this animatable sleep now. Absent means yes. */
  CanSleep?(): boolean;
  /** Frames after falling asleep at which it is stepped once anyway (the style animator's backstop). */
  BackstopIn?(): number;
  /** Called just before that backstop step. */
  Backstop?(): void;
}

interface Entry {
  Animatable: Animatable;
  Sequence: number;
  /** Present in `_awake` (until the next compaction). */
  Listed: boolean;
  /** Fell asleep this frame; dropped from `_awake` at the compaction unless roused first. */
  Sleeping: boolean;
  Removed: boolean;
  /** The frame its backstop is due, or -1. */
  Due: number;
}

export class AnimationManager {
  private _animatables = new Set<Animatable>();
  private _entries = new Map<Animatable, Entry>();
  /** The sleepers that are awake plus every non-sleeper, in registration order. */
  private _awake: Entry[] = [];
  private _sequence = 0;
  private _frame = 0;
  private _cursor = -1;
  private _backstops = new Map<number, Entry[]>();
  /** False after a frame stepped with the lever off, so the next lever-on frame relists everything. */
  private _listedAll = true;
  private _running: boolean = false;
  private _lastTime: number = 0;
  private _onFrame: (() => void) | null = null;
  private _onWake: (() => void) | null = null;

  /** Register a callback to fire after all animations step (triggers re-render). */
  OnFrame = (cb: () => void): void => {
    this._onFrame = cb;
  };

  /** Register the host's frame-loop wake. Fired by `Kick` BEFORE its own early-out, because the
   *  host may have parked its loop while `_running` was already true in a tick that has since
   *  settled -- and a Kick that returned early without waking would leave the animation registered,
   *  live and never stepped. This is one of the three funnels the host's park depends on; see
   *  `Canvas._tickInner`'s park block. */
  OnWake = (cb: () => void): void => {
    this._onWake = cb;
  };

  Register = (animatable: Animatable): void => {
    if (this._animatables.has(animatable)) return;
    this._animatables.add(animatable);
    const entry: Entry = { Animatable: animatable, Sequence: this._sequence++, Listed: true, Sleeping: false, Removed: false, Due: -1 };
    this._entries.set(animatable, entry);
    this._awake.push(entry);
    if ('Rouse' in animatable) animatable.Rouse = () => this._rouse(entry);
  };

  Unregister = (animatable: Animatable): void => {
    this._animatables.delete(animatable);
    const entry = this._entries.get(animatable);
    if (entry === undefined) return;
    this._entries.delete(animatable);
    entry.Removed = true;
    if ('Rouse' in animatable) animatable.Rouse = null;
  };

  /** Back into the stepped list, at its registration position. Roused behind the cursor mid-frame,
   *  it is stepped next frame, which is when the full walk would next have reached it too. */
  private _rouse = (entry: Entry): void => {
    if (entry.Removed) return;
    entry.Sleeping = false;
    if (entry.Listed) return;
    entry.Listed = true;
    const list = this._awake;
    let low = 0, high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle].Sequence < entry.Sequence) low = middle + 1; else high = middle;
    }
    list.splice(low, 0, entry);
    if (low <= this._cursor) this._cursor++;
  };

  /** Kick the loop if it's not already running. Always wakes the host first. */
  Kick = (): void => {
    this._onWake?.();
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
    const names = this.ActiveNames;
    const note = (a: Animatable): void => {
      anyActive = true;
      if (names !== null) {
        // Name the NODE when the animatable owns one, or `JivStyleAnimator:61` says only that
        // some style somewhere is moving.
        const own = a as unknown as { _jiv?: { Classes?: readonly string[] }; _element?: { Classes?: readonly string[] } };
        const cls = (own._jiv ?? own._element)?.Classes;
        const kind = a.constructor?.name || 'anonymous';
        names.push(cls !== undefined && cls.length > 0 ? `${kind}(${cls.join('.')})` : kind);
      }
    };
    this._frame++;
    if (!PerfLevers.SleepingAnimators) {
      for (const a of this._animatables) if (a.Tick(dt)) note(a);
      this._listedAll = false;
    } else {
      if (!this._listedAll) this._relistAll();
      const due = this._backstops.get(this._frame);
      if (due !== undefined) {
        this._backstops.delete(this._frame);
        for (const entry of due) {
          if (entry.Removed || entry.Listed || entry.Due !== this._frame) continue;
          entry.Due = -1;
          entry.Animatable.Backstop?.();
          this._rouse(entry);
        }
      }
      const list = this._awake;
      let sleepers = false;
      for (this._cursor = 0; this._cursor < list.length; this._cursor++) {
        const entry = list[this._cursor];
        if (entry.Removed) { sleepers = true; continue; }
        const a = entry.Animatable;
        if (a.Tick(dt)) note(a);
        else if (a.Rouse !== undefined && (a.CanSleep?.() ?? true)) { entry.Sleeping = true; sleepers = true; }
      }
      this._cursor = -1;
      if (sleepers) this._compact();
    }
    this._running = anyActive;
    // Fire OnFrame (→ RequestFrame) ONLY when something actually animated this frame.
    // It used to fire unconditionally back when RequestFrame was a no-op; now that
    // RequestFrame drives render-on-demand, an unconditional call would re-arm a render
    // every frame and defeat idle-skip entirely.
    if (anyActive && this._onFrame) this._onFrame();
  };

  /** Drops the removed and the newly asleep from the stepped list and books each sleeper's backstop. */
  private _compact = (): void => {
    const list = this._awake;
    let kept = 0;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry.Removed && !entry.Sleeping) { list[kept++] = entry; continue; }
      entry.Listed = false;
      if (entry.Removed || !entry.Sleeping) continue;
      entry.Sleeping = false;
      const frames = entry.Animatable.BackstopIn?.() ?? 0;
      if (frames <= 0) continue;
      entry.Due = this._frame + frames;
      const bucket = this._backstops.get(entry.Due);
      if (bucket === undefined) this._backstops.set(entry.Due, [entry]); else bucket.push(entry);
    }
    list.length = kept;
  };

  /** Every registered animatable back in the stepped list, for the first lever-on frame after the full walk. */
  private _relistAll = (): void => {
    this._awake = [];
    for (const entry of this._entries.values()) {
      entry.Listed = true;
      entry.Sleeping = false;
      entry.Due = -1;
      this._awake.push(entry);
    }
    this._awake.sort((a, b) => a.Sequence - b.Sequence);
    this._backstops.clear();
    this._listedAll = true;
  };

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

  /** `?trace` only: the host sets this to an array and every animatable that reports itself still
   *  running pushes its class name, so `jaui:awake` can say WHICH animation kept a still page
   *  drawing. Null (the shipping case) costs one comparison per animatable per frame. */
  ActiveNames: string[] | null = null;
}
