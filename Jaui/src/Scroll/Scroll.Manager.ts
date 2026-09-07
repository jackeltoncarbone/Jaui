import type { Jiv } from '../Jiv/Jiv';
import type { Animatable } from '../Animation/Animation.Manager';
import { type Mat2x3, MAT_IDENTITY, matMul, matInvApply } from '../Transform/Mat2x3';

/**
 * Scroll physics for Overflow:Scroll Jivs. Two behaviors share the same state:
 *
 *   • Wheel / keyboard — writes a clamped TARGET; position eases toward it
 *                        with an exponential decay (~150 ms half-life). No
 *                        injected velocity, no momentum coasting — wheel
 *                        clicks should feel discrete and bounded, matching
 *                        browser/OS smooth-scroll convention.
 *
 *   • Touch / pointer drag — velocity model with momentum + rubber-band.
 *                            Position tracks the finger 1:1; release captures
 *                            EMA velocity which decays over ~0.6 s. Past
 *                            content bounds an elastic spring pulls back.
 *
 * Tick() integrates whichever path is active per Jiv. While dragging, both
 * paths are suspended and the caller drives position directly via DragMove.
 */

/** One DragMove sample: how much the content moved (after edge clamp) and
 *  when. The trailing window of these is what determines release velocity. */
interface DragSample {
  dx: number;
  dy: number;
  /** performance.now() ms timestamp. */
  t: number;
}

interface ScrollState {
  posX: number;
  posY: number;
  /** Wheel-driven smooth-scroll target (clamped to content bounds). Position
   *  eases toward this each tick; equals posX/Y when no wheel ease is pending. */
  targetX: number;
  targetY: number;
  /** Drag-driven momentum velocity (px/s). Only non-zero after a touch flick. */
  velX: number;
  velY: number;
  /** While true, physics is suspended — position is externally driven (drag). */
  dragging: boolean;
  /** Trailing-window of recent DragMove samples (oldest first). Pruned to the
   *  last RELEASE_WINDOW_MS each move. At DragEnd we sum these for momentum
   *  velocity — using a fixed time window (not an EMA) prevents older, faster
   *  samples from biasing the release: if you decelerate the finger before
   *  lifting, only the slow recent motion contributes, so content can't
   *  briefly outpace your finger after release. */
  samples: DragSample[];
  /** performance.now() of the last real scroll activity — drives the
   *  published @ScrollActive var's idle timeout. */
  lastActiveAt: number;
  /** TEMP demo auto-scroll: seconds left to pause at the current end before
   *  restarting. 0 = actively scrolling. See ScrollManager.AutoScrollSpeed. */
  autoHold: number;
}

/** Drag-momentum velocity retention per second. UIScrollView's normal
 *  decelerationRate is 0.998 per millisecond — 0.998^1000 ≈ 0.135/s — which
 *  is the long, light coast a flick is supposed to buy. The old 0.02/s
 *  settled everything in ~0.6 s and made long lists a rowing exercise. */
const FRICTION_PER_SEC = 0.135;
/** Rubber spring stiffness (1/s²-ish): pulls an overscrolled edge home. */
const RUBBER_K = 180;
/** Velocity retention per second while OVERSCROLLED — much heavier than
 *  in-bounds friction so the bounce is one soft beat, not a wobble. */
const OVER_FRICTION = 0.005;
/** Damping applied to the spring return so it lands without oscillating. */
const OVER_SETTLE_PX = 0.5;
/** Velocity magnitude below which we settle to zero (px/s). */
const SETTLE_V = 1;
/** Trailing window of DragMove samples used to derive release velocity, ms.
 *  Only motion inside this window contributes to momentum at DragEnd:
 *    • if the finger held still for longer than this, samples drain to empty
 *      → release velocity is zero (no leftover-fling drift);
 *    • if the finger decelerated before lifting, the high-velocity samples
 *      from earlier in the fling fall outside the window → momentum starts
 *      from the actual recent finger speed (no perceived acceleration).
 *  ~50 ms ≈ 3 frames @60fps; matches iOS's native flick-window. */
const RELEASE_WINDOW_MS = 50;
/** Wheel-ease retention per second — for the SMOOTH (mouse-wheel) path ONLY.
 *  Trackpads / touch take the instant path (ApplyDeltaInstant) and never ease.
 *  1e-6/s ⇒ half-life ≈ 50 ms; a ~100px wheel click animates over ~120 ms —
 *  snappy like a browser's mouse-wheel smooth-scroll, not a floaty spring
 *  (was 0.005/s ≈ 130 ms half-life, which read as laggy). */
const WHEEL_EASE_PER_SEC = 1e-6;
/** Distance below which wheel ease snaps to target (px). */
const WHEEL_SETTLE_PX = 0.5;

export class ScrollManager implements Animatable {
  private _states = new WeakMap<Jiv, ScrollState>();

  /** TEMPORARY demo auto-scroll (for recording product footage). When > 0,
   *  every Overflow:Scroll box advances toward its end at this many CSS px/sec,
   *  pauses briefly, then restarts from the top — looping forever. Driven by
   *  `?autoscroll=NN` on the page URL (see Canvas init). 0 = off (normal). */
  AutoScrollSpeed = 0;
  /** Seconds to dwell at each end before restarting — gives the loop a beat. */
  private _autoHoldSec = 1.2;

  constructor(private _root: Jiv) {}

  /** Wheel/keyboard delta entry point. Pushes the TARGET and lets Tick's
   *  wheel-ease path exponentially decay toward it — matches browser
   *  smooth-scroll feel (rapid wheels stack because deltas accumulate on
   *  the target, not the current position).
   *
   *  Rubber-band and momentum are TOUCH-only; wheel always clamps at bounds
   *  and produces zero velocity. */
  ApplyDelta = (jiv: Jiv, dx: number, dy: number): void => {
    const s = this._ensureState(jiv);
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    s.targetX = Math.max(0, Math.min(maxX, s.targetX + dx));
    s.targetY = Math.max(0, Math.min(maxY, s.targetY + dy));
    // Wheel cancels any leftover drag-flick momentum so the two inputs don't
    // fight each other (e.g. user flicks then immediately wheels — wheel wins).
    s.velX = 0;
    s.velY = 0;
  };

  /** Instant delta — trackpad / precise-pointer scrolling. The OS already
   *  streams smoothed momentum deltas, so we move the position 1:1 with ZERO
   *  ease for a fully-responsive, native feel. Position and target advance
   *  together (no pending ease); _syncJiv commits it on the kicked tick.
   *  Mouse wheels use ApplyDelta's smooth path instead. */
  ApplyDeltaInstant = (jiv: Jiv, dx: number, dy: number): void => {
    const s = this._ensureState(jiv);
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    s.targetX = Math.max(0, Math.min(maxX, s.targetX + dx));
    s.targetY = Math.max(0, Math.min(maxY, s.targetY + dy));
    s.posX = s.targetX;
    s.posY = s.targetY;
    s.velX = 0;
    s.velY = 0;
  };

  /** Start a drag (touch/pointer). Disables physics; caller will push
   *  positions via DragMove until DragEnd. */
  /** Scroll a container to an ABSOLUTE offset. 'smooth' rides the same ease
   *  the wheel uses; 'instant' lands this frame. This is the consumer-facing
   *  primitive the engine never had — callers were poking ScrollY directly,
   *  bypassing the physics and racing the per-frame sync. */
  ScrollTo = (jiv: Jiv, x: number | null, y: number | null, behavior: 'smooth' | 'instant' = 'smooth'): void => {
    const s = this._ensureState(jiv);
    const dx = x === null ? 0 : x - s.targetX;
    const dy = y === null ? 0 : y - s.targetY;
    if (behavior === 'smooth') this.ApplyDelta(jiv, dx, dy);
    else this.ApplyDeltaInstant(jiv, dx, dy);
  };

  /** Scroll the nearest scrollable ancestor the minimum distance that brings
   *  `rect` (container-content coordinates) fully into view, plus a margin —
   *  the web's scrollIntoView({block:'nearest'}), which focus-reveal and the
   *  caret both need. */
  ScrollRectIntoView = (jiv: Jiv, rect: { x: number; y: number; width: number; height: number }, marginPx = 8, behavior: 'smooth' | 'instant' = 'smooth'): void => {
    // Measure against the PENDING target so stacked reveals compose instead
    // of re-fighting an ease already in flight.
    const st = this._ensureState(jiv);
    const viewTop = st.targetY;
    const viewBottom = viewTop + jiv.Height;
    const viewLeft = st.targetX;
    const viewRight = viewLeft + jiv.Width;
    let dy = 0, dx = 0;
    if (rect.y - marginPx < viewTop) dy = rect.y - marginPx - viewTop;
    else if (rect.y + rect.height + marginPx > viewBottom) dy = rect.y + rect.height + marginPx - viewBottom;
    if (rect.x - marginPx < viewLeft) dx = rect.x - marginPx - viewLeft;
    else if (rect.x + rect.width + marginPx > viewRight) dx = rect.x + rect.width + marginPx - viewRight;
    if (dx === 0 && dy === 0) return;
    if (behavior === 'smooth') this.ApplyDelta(jiv, dx, dy);
    else this.ApplyDeltaInstant(jiv, dx, dy);
  };

  DragStart = (jiv: Jiv): void => {
    const s = this._ensureState(jiv);
    s.dragging = true;
    s.velX = 0;
    s.velY = 0;
    s.samples.length = 0;
  };

  /** Direct positional update during a drag — position tracks the finger 1:1
   *  inside bounds, and is hard-clamped at the edges (no rubber-band overshoot:
   *  exposing whitespace past the content bounds reveals chrome that's only
   *  ever supposed to be visible inside the scroll, so we'd rather the finger
   *  feel "stuck" at the edge than peel back the curtain).
   *  Also records the move into the trailing window so DragEnd can derive
   *  release velocity from the most recent ~RELEASE_WINDOW_MS only. */
  DragMove = (jiv: Jiv, dx: number, dy: number, _dt: number): void => {
    const s = this._ensureState(jiv);
    if (!s.dragging) return;

    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);

    const prevX = s.posX;
    const prevY = s.posY;
    // Past an edge the finger still moves the content — through Apple's
    // resistance curve, so the stretch asymptotes instead of running away.
    // The audit found the header PROMISING this while the code hard-clamped;
    // now the code keeps the promise. Integrated in small chunks: resistance
    // depends on how far over you already are, and one fast 60px event
    // evaluated at its start would tunnel straight through the curve.
    // Rubber-band only an axis that actually scrolls; a fixed axis clamps hard
    // (no bounce on a direction with nowhere to go — the iOS/web rule).
    s.posX = maxX > 0 ? _integrateRubber(s.posX, dx, 0, maxX) : Math.max(0, Math.min(maxX, s.posX + dx));
    s.posY = maxY > 0 ? _integrateRubber(s.posY, dy, 0, maxY) : Math.max(0, Math.min(maxY, s.posY + dy));
    // Momentum is still charged only from IN-BOUNDS travel: overscroll
    // stretch is the spring's business, not the fling's.
    const scaledDx = Math.max(0, Math.min(maxX, s.posX)) - Math.max(0, Math.min(maxX, prevX));
    const scaledDy = Math.max(0, Math.min(maxY, s.posY)) - Math.max(0, Math.min(maxY, prevY));
    // Drag is authoritative — keep wheel-ease target locked to current pos
    // so a tap-then-wheel doesn't snap back to a stale target.
    s.targetX = s.posX;
    s.targetY = s.posY;

    const now = performance.now();
    s.samples.push({ dx: scaledDx, dy: scaledDy, t: now });
    // Drop anything older than the trailing window so the buffer can never
    // grow unbounded and DragEnd's sum is O(window-size).
    const cutoff = now - RELEASE_WINDOW_MS;
    while (s.samples.length > 0 && s.samples[0].t < cutoff) s.samples.shift();

    this._syncJiv(jiv, s);
  };

  /** Release a drag — physics resumes, exit velocity drives momentum.
   *  Velocity is the average over the trailing RELEASE_WINDOW_MS:
   *  total displacement in the window ÷ span. Held-still releases collapse
   *  to zero (samples drained by the prune in DragMove), and decelerated
   *  releases match the actual recent finger speed instead of a stale EMA. */
  /** Stop a drag with NO momentum — the gesture was claimed by something
   *  else (a selection handle), so the container must freeze where it is
   *  rather than flick onward from the finger's speed. */
  DragCancel = (jiv: Jiv): void => {
    const s = this._states.get(jiv);
    if (!s) return;
    s.dragging = false;
    s.samples.length = 0;
    s.velX = 0;
    s.velY = 0;
  };

  DragEnd = (jiv: Jiv): void => {
    const s = this._states.get(jiv);
    if (!s) return;
    s.dragging = false;

    const now = performance.now();
    const cutoff = now - RELEASE_WINDOW_MS;
    while (s.samples.length > 0 && s.samples[0].t < cutoff) s.samples.shift();

    if (s.samples.length === 0) {
      s.velX = 0;
      s.velY = 0;
      return;
    }

    let totalDx = 0;
    let totalDy = 0;
    for (let i = 0; i < s.samples.length; i++) {
      totalDx += s.samples[i].dx;
      totalDy += s.samples[i].dy;
    }
    // Span from the first sample's timestamp to now — using `now` (not the
    // last sample's t) is what makes a "decelerate-then-release" release
    // honest: a long quiet tail between the last sample and lift-off
    // stretches the denominator and lowers velocity, instead of being
    // hidden by the EMA.
    const span = (now - s.samples[0].t) / 1000;
    if (span > 0) {
      s.velX = totalDx / span;
      s.velY = totalDy / span;
    } else {
      s.velX = 0;
      s.velY = 0;
    }
  };

  /** Snap immediately to ScrollTargetX/Y (used for resize / programmatic jumps). */
  Snap = (jiv: Jiv): void => {
    const s = this._ensureState(jiv);
    s.posX = jiv.ScrollTargetX;
    s.posY = jiv.ScrollTargetY;
    s.targetX = s.posX;
    s.targetY = s.posY;
    s.velX = 0;
    s.velY = 0;
    this._syncJiv(jiv, s);
  };

  /** DOM-style scroll target: topmost hit, walk UP for scrollable ancestor. */
  ResolveScrollTarget = (cssX: number, cssY: number): Jiv | null => {
    const hit = this.HitTopmost(cssX, cssY);
    if (!hit) return null;
    let cur: Jiv | null = hit;
    while (cur) {
      if (cur.Overflow === 'Scroll' && this._canScrollEither(cur)) return cur;
      cur = cur.Parent as Jiv | null;
    }
    return null;
  };

  /** Whether a container has anything to scroll on either axis right now.
   *  A scroll box whose content fits (a single-line input, an empty list) is
   *  not a scroll target — the gesture belongs to whatever CAN move. */
  private _canScrollEither = (jiv: Jiv): boolean =>
    jiv.ContentWidth - jiv.Width > 0.5 || jiv.ContentHeight - jiv.Height > 0.5;

  /** Per-axis scroll chaining for wheel input. From the topmost hit we walk UP
   *  the ancestor chain and, for EACH axis independently, pick the nearest
   *  Overflow:Scroll container that can actually move in the delta's direction.
   *
   *  This is what makes a vertical wheel over a horizontal card row scroll the
   *  PAGE behind it: the row has no vertical extent (maxY === 0), so it can't
   *  consume dy and the chain falls through to the page's vertical Scroll —
   *  matching browser/Apple scroll-chaining instead of swallowing the wheel.
   *
   *  An axis with zero delta yields a null target (nothing to apply); a target
   *  already pinned at the bound in the wheel's direction is skipped so a
   *  maxed-out inner list chains to its parent rather than dead-ending. */
  ResolveScrollChain = (
    cssX: number,
    cssY: number,
    dx: number,
    dy: number,
  ): { xTarget: Jiv | null; yTarget: Jiv | null } => {
    const hit = this.HitTopmost(cssX, cssY);
    let xTarget: Jiv | null = null;
    let yTarget: Jiv | null = null;
    for (let cur: Jiv | null = hit; cur; cur = cur.Parent as Jiv | null) {
      if (cur.Overflow !== 'Scroll') continue;
      if (!xTarget && this._canScrollAxis(cur, 'x', dx)) xTarget = cur;
      if (!yTarget && this._canScrollAxis(cur, 'y', dy)) yTarget = cur;
      if (xTarget && yTarget) break;
    }
    return { xTarget, yTarget };
  };

  /** Whether `jiv` has room to move in `delta`'s direction on `axis`. Uses the
   *  pending wheel TARGET (not the eased position) so rapid wheels that have
   *  already queued the container to its bound correctly chain to the parent
   *  on the next tick instead of re-targeting the maxed-out child. */
  private _canScrollAxis = (jiv: Jiv, axis: 'x' | 'y', delta: number): boolean => {
    if (delta === 0) return false;
    const s = this._states.get(jiv);
    if (axis === 'x') {
      const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
      if (maxX <= 0) return false;
      const pos = s ? s.targetX : jiv.ScrollX;
      return delta > 0 ? pos < maxX - 0.5 : pos > 0.5;
    }
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    if (maxY <= 0) return false;
    const pos = s ? s.targetY : jiv.ScrollY;
    return delta > 0 ? pos < maxY - 0.5 : pos > 0.5;
  };

  /** Topmost Jiv at (cssX, cssY) — respects Visible + PointerEvents. Shared
   *  by scroll, interaction-state tracking, and (soon) focus/click. */
  HitTopmost = (cssX: number, cssY: number): Jiv | null => {
    return this._hitTopmost(this._root, cssX, cssY, MAT_IDENTITY);
  };

  Tick = (dt: number): boolean => {
    let active = false;
    this._stepWalk(this._root, (jiv) => {
      const s = this._ensureState(jiv);
      if (s.dragging) return;

      // TEMP demo auto-scroll overrides all physics while enabled.
      if (this.AutoScrollSpeed > 0) {
        if (this._autoTick(jiv, s, dt)) active = true;
        this._syncJiv(jiv, s);
        return;
      }

      const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
      const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);

      const hasVel = s.velX !== 0 || s.velY !== 0;

      const overX = s.posX < 0 ? s.posX : s.posX > maxX ? s.posX - maxX : 0;
      const overY = s.posY < 0 ? s.posY : s.posY > maxY ? s.posY - maxY : 0;

      if (hasVel || overX !== 0 || overY !== 0) {
        // ─── Momentum + rubber-band path (touch release) ─────────────────────
        // In bounds: friction-decayed coast. Past an edge (a fling carrying
        // into the wall, or a released stretch): a stiff damped spring pulls
        // the edge home — the iOS bounce, one soft beat.
        const inK = Math.pow(FRICTION_PER_SEC, dt);
        const overK = Math.pow(OVER_FRICTION, dt);
        s.velX = overX !== 0 ? (s.velX - overX * RUBBER_K * dt) * overK : s.velX * inK;
        s.velY = overY !== 0 ? (s.velY - overY * RUBBER_K * dt) * overK : s.velY * inK;

        s.posX += s.velX * dt;
        s.posY += s.velY * dt;

        // A spring never overshoots INTO bounds: once it crosses home, land.
        if (overX < 0 && s.posX >= 0) { s.posX = 0; s.velX = 0; }
        if (overX > 0 && s.posX <= maxX) { s.posX = maxX; s.velX = 0; }
        if (overY < 0 && s.posY >= 0) { s.posY = 0; s.velY = 0; }
        if (overY > 0 && s.posY <= maxY) { s.posY = maxY; s.velY = 0; }

        // Keep wheel-ease target tracking pos so an incoming wheel event
        // doesn't yank position back to a stale value.
        s.targetX = Math.max(0, Math.min(maxX, s.posX));
        s.targetY = Math.max(0, Math.min(maxY, s.posY));

        // Settle: slow AND home → zero out so RAF can stop.
        const nowOverX = s.posX < 0 || s.posX > maxX;
        const nowOverY = s.posY < 0 || s.posY > maxY;
        const slow = Math.abs(s.velX) < SETTLE_V && Math.abs(s.velY) < SETTLE_V;
        if (slow && !nowOverX && !nowOverY) {
          s.velX = 0;
          s.velY = 0;
          if (Math.abs(s.posX - s.targetX) < OVER_SETTLE_PX) s.posX = s.targetX;
          if (Math.abs(s.posY - s.targetY) < OVER_SETTLE_PX) s.posY = s.targetY;
        } else {
          active = true;
        }
      } else if (s.posX !== s.targetX || s.posY !== s.targetY) {
        // ─── Wheel-ease path: exponential decay toward clamped target ────────
        const k = Math.pow(WHEEL_EASE_PER_SEC, dt);
        s.posX = s.targetX + (s.posX - s.targetX) * k;
        s.posY = s.targetY + (s.posY - s.targetY) * k;

        if (Math.abs(s.posX - s.targetX) < WHEEL_SETTLE_PX) s.posX = s.targetX;
        if (Math.abs(s.posY - s.targetY) < WHEEL_SETTLE_PX) s.posY = s.targetY;

        if (s.posX !== s.targetX || s.posY !== s.targetY) active = true;
      }

      this._syncJiv(jiv, s);
    });
    return active;
  };

  /** TEMP demo auto-scroll step for one Overflow:Scroll box. Drives the axis
   *  that has travel (vertical preferred), holds `_autoHoldSec` at the end,
   *  then snaps back to the start and loops. Returns true while it wants more
   *  frames (always, once enabled — so the RAF loop never parks). */
  private _autoTick = (jiv: Jiv, s: ScrollState, dt: number): boolean => {
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    const vertical = maxY > 0;
    const max = vertical ? maxY : maxX;
    if (max <= 0) return false; // nothing to scroll in this box

    if (s.autoHold > 0) {
      s.autoHold = Math.max(0, s.autoHold - dt);
      if (s.autoHold === 0) {
        // Dwell elapsed — restart from the top/left for the next pass.
        if (vertical) s.posY = 0; else s.posX = 0;
      }
    } else {
      const adv = this.AutoScrollSpeed * dt;
      if (vertical) {
        s.posY += adv;
        if (s.posY >= maxY) { s.posY = maxY; s.autoHold = this._autoHoldSec; }
      } else {
        s.posX += adv;
        if (s.posX >= maxX) { s.posX = maxX; s.autoHold = this._autoHoldSec; }
      }
    }
    // Keep wheel-ease / momentum targets pinned to the driven position so a
    // stray input can't yank us back to a stale target mid-loop.
    s.targetX = s.posX;
    s.targetY = s.posY;
    return true;
  };

  private _ensureState = (jiv: Jiv): ScrollState => {
    let s = this._states.get(jiv);
    if (!s) {
      s = {
        posX: jiv.ScrollX,
        posY: jiv.ScrollY,
        targetX: jiv.ScrollX,
        targetY: jiv.ScrollY,
        velX: 0,
        velY: 0,
        dragging: false,
        samples: [],
        lastActiveAt: 0,
        autoHold: 0,
      };
      this._states.set(jiv, s);
    }
    return s;
  };

  private _syncJiv = (jiv: Jiv, s: ScrollState): void => {
    jiv.ScrollX = s.posX;
    jiv.ScrollY = s.posY;
    // Keep Target in sync so external code inspecting targets sees the real pos
    jiv.ScrollTargetX = s.posX;
    jiv.ScrollTargetY = s.posY;
    this._publishVars(jiv, s);
  };

  /** The container's scroll FACTS, published as element vars that cascade to
   *  its subtree — so scroll-driven UI is authored in JSS, not hardcoded. A
   *  scrollbar is one composition of these; a minimap, an edge glow, a
   *  progress label, a back-to-top pill are others, and none of them need the
   *  engine to know they exist. Values are rounded so a sub-pixel ease step
   *  doesn't churn re-resolves; SetVar no-ops on equal values. */
  private _publishVars = (jiv: Jiv, s: ScrollState): void => {
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    const before = jiv.VarMap.get('ScrollY');
    jiv.SetVar('ScrollY', Math.round(s.posY));
    jiv.SetVar('ScrollX', Math.round(s.posX));
    jiv.SetVar('ScrollMaxY', Math.round(maxY));
    jiv.SetVar('ScrollMaxX', Math.round(maxX));
    jiv.SetVar('ScrollFracY', maxY > 0 ? Math.round((s.posY / maxY) * 1000) / 1000 : 0);
    jiv.SetVar('ScrollFracX', maxX > 0 ? Math.round((s.posX / maxX) * 1000) / 1000 : 0);
    jiv.SetVar('ViewportH', Math.round(jiv.Height));
    jiv.SetVar('ViewportW', Math.round(jiv.Width));
    jiv.SetVar('ContentH', Math.round(Math.max(1, jiv.ContentHeight)));
    jiv.SetVar('ContentW', Math.round(Math.max(1, jiv.ContentWidth)));
    const active = s.dragging || s.velX !== 0 || s.velY !== 0
      || s.posX !== s.targetX || s.posY !== s.targetY;
    if (active) s.lastActiveAt = performance.now();
    // 0/1 — the FADE is the stylesheet's business (`@Transition Opacity`).
    jiv.SetVar('ScrollActive', active || performance.now() - s.lastActiveAt < 900 ? 1 : 0);
    // Var-driven LENGTHS in the overlay subtree re-resolve on the next solve;
    // SetVar wakes styles but not layout, so say it moved.
    if (jiv.VarMap.get('ScrollY') !== before) jiv.MarkLayoutDirty();
  };

  private _stepWalk = (node: Jiv, fn: (j: Jiv) => void): void => {
    if (node.Overflow === 'Scroll') fn(node);
    for (const c of node.Children as Jiv[]) this._stepWalk(c, fn);
  };

  private _hitTopmost = (node: Jiv, px: number, py: number, m: Mat2x3): Jiv | null => {
    if (!node.Visible) return null;

    // Build this node's effective matrix EXACTLY as renderNode does (rotation
    // about Transform.Origin), so hit-test and paint agree to the pixel. Note:
    // Visual* is intentionally NOT applied here — the legacy hit-test ignored
    // VisualScale/Translate, and preserving that keeps a VisualScale'd node
    // hit-testable at its layout box (paint/hit already diverged under Visual*).
    let eff = m;
    const rotDeg = node.RenderStyle.Transform.Rotation;
    if (rotDeg !== 0) {
      const th = rotDeg * (Math.PI / 180), rc = Math.cos(th), rs = Math.sin(th);
      const rpx = node.X + node.Width * node.RenderStyle.Transform.OriginX;
      const rpy = node.Y + node.Height * node.RenderStyle.Transform.OriginY;
      eff = matMul(eff, [rc, rs, -rs, rc, rpx * (1 - rc) + rpy * rs, rpy * (1 - rc) - rpx * rs]);
    }

    // Invert eff to map the canvas pointer into this node's local (node.X/Y)
    // frame. node.X/Y are ROOT-ABSOLUTE, so containment tests them directly.
    // The pointer (px,py) stays in canvas space across the whole recursion;
    // each node inverts its own accumulated matrix — so ANCESTOR rotation
    // cascades into the hit-test, not just the node's own rotation.
    const [lx, ly] = matInvApply(eff, px, py);
    const inside = node === this._root
      ? true
      : lx >= node.X && lx < node.X + node.Width && ly >= node.Y && ly < node.Y + node.Height;

    // A non-clipping node lets children extend past our rect (Placed/Fixed,
    // plain flow overflow, or a Scroll box with Clip:Visible). Only a node
    // that actually clips short-circuits the walk when the pointer is outside
    // it; otherwise descend and let a child (e.g. a flown-out card) pick the
    // hit. Reads ClipsChildren so clip stays decoupled from scroll.
    if (!inside && node.ClipsChildren) return null;

    // Scroll = local translate composed into the child matrix (mirrors render's
    // _descendOffset), so children are hit in the scrolled (and rotated) frame.
    const childM = node.Overflow === 'Scroll'
      ? matMul(eff, [1, 0, 0, 1, -node.ScrollX, -node.ScrollY])
      : eff;
    // Hit-test must walk children in the SAME z-order as paint: highest
    // Layer first. Paint uses `orderedChildren` (Layer asc, paint late =
    // on top); hit-test wants the inverse. For same-Layer ties, walk
    // INSERTION ORDER REVERSED — matches the no-layer behavior so a
    // late-mounted sibling (e.g. PageChrome's children attached after
    // the page's Scroll) takes precedence the way insertion-order reverse
    // already did. Without the tie-break reversal, a janvas (Layer 0)
    // mounted before a Scroll (Layer 0) wins over the Scroll for middle-
    // screen pointers, breaking scroll-target resolution.
    const children = node.Children as Jiv[];
    let needsSort = false;
    for (let i = 0; i < children.length; i++) {
      if (children[i].RenderStyle.Layer !== 0) { needsSort = true; break; }
    }
    if (needsSort) {
      const decorated = children.map((c, i) => ({ c, i }));
      decorated.sort((a, b) => {
        const dl = b.c.RenderStyle.Layer - a.c.RenderStyle.Layer;
        return dl !== 0 ? dl : b.i - a.i;
      });
      for (let i = 0; i < decorated.length; i++) {
        const c = decorated[i].c;
        const m = c.ChildLayout.Position === 'Pinned' && node.Overflow === 'Scroll' ? eff : childM;
        const hit = this._hitTopmost(c, px, py, m);
        if (hit) return hit;
      }
    } else {
      for (let i = children.length - 1; i >= 0; i--) {
        const c = children[i];
        const m = c.ChildLayout.Position === 'Pinned' && node.Overflow === 'Scroll' ? eff : childM;
        const hit = this._hitTopmost(c, px, py, m);
        if (hit) return hit;
      }
    }
    if (!inside) return null;
    // Descend through PointerEvents:None parents (they're transparent to
    // hit-test) but never return them as a hit themselves.
    return node.PointerEvents === 'None' ? null : node;
  };
}

/** Rubber-band drag resistance: 1 inside bounds, drops off past bounds so the
 *  content feels elastic — dragging 100 px past the edge only moves ~50 px. */
/** Advance `pos` by `delta` through the resistance curve, a few px at a time,
 *  so the curve is honored across the whole travel and not just its start. */
const _integrateRubber = (pos: number, delta: number, minBound: number, maxBound: number): number => {
  const STEP = 4;
  let remaining = delta;
  while (remaining !== 0) {
    const step = Math.abs(remaining) <= STEP ? remaining : Math.sign(remaining) * STEP;
    pos += step * _rubberResistance(pos, minBound, maxBound);
    remaining -= step;
  }
  return pos;
};

const _rubberResistance = (pos: number, minBound: number, maxBound: number): number => {
  let over = 0;
  if (pos < minBound) over = minBound - pos;
  else if (pos > maxBound) over = pos - maxBound;
  if (over <= 0) return 1;
  // 1 / (1 + over/size) — standard Apple rubber-band formula
  const size = Math.max(1, maxBound - minBound);
  return 1 / (1 + over / size);
};
