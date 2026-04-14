import type { Jiv } from '../Jiv/Jiv';
import type { Animatable } from '../Animation/Animation.Manager';

/**
 * Scroll physics for Overflow:Scroll Jivs — position + velocity model rather
 * than target-chasing springs. This is what gives us:
 *
 *   • Momentum.  Wheel/flick deposits velocity; damping decays it over time,
 *                so a hard flick keeps scrolling after the gesture ends.
 *   • Rubber-band. Past the content bounds, an elastic force pulls back
 *                  toward the edge, AND extra damping slows incoming
 *                  velocity. Matches Apple's UIScrollView behavior — stiff
 *                  resistance + snap-back without visible pop.
 *   • Direct control. While a pointer is dragging, velocity is suppressed
 *                     and position tracks the finger 1:1; release captures
 *                     the most-recent movement as the exit velocity.
 *
 * Tick() iterates every scroll Jiv, integrates physics, writes ScrollX/Y.
 * ApplyDelta() is wheel's entry point — treats the delta as an instant
 * position shift plus a small velocity burst so repeated wheel ticks feel
 * like a continuous scroll.
 */

interface ScrollState {
  posX: number;
  posY: number;
  velX: number;
  velY: number;
  /** While true, physics is suspended — position is externally driven (drag). */
  dragging: boolean;
}

/** Per-frame velocity damping (how much velocity is retained each second).
 *  Inside bounds, slower decay = longer coast after a flick. Apple's feel
 *  is around 1.5-2 seconds for a full decay — achieved with ~0.15 retention. */
const FRICTION_PER_SEC = 0.08;
/** Elastic spring constant for rubber-band (bigger = stiffer resist). */
const RUBBER_K = 180;
/** Extra damping when overscrolled, on top of normal friction. */
const OVER_FRICTION = 0.005;
/** Velocity magnitude below which we settle to zero (px/s). */
const SETTLE_V = 1;
/** Scale wheel delta → added velocity. High enough that rapid scroll chains
 *  feel like momentum but the typical one-click delta doesn't overshoot. */
const WHEEL_VELOCITY_SCALE = 6;

export class ScrollManager implements Animatable {
  private _states = new WeakMap<Jiv, ScrollState>();

  constructor(private _root: Jiv) {}

  /** Wheel/keyboard delta entry point. Shifts position immediately AND
   *  injects some velocity so repeated wheel ticks coast naturally.
   *
   *  Wheel is CLAMPED to bounds — no rubber-band from mouse wheel (Apple's
   *  convention: rubber-band is a TOUCH/trackpad-gesture thing). This keeps
   *  discrete wheel ticks from producing visible bounce when the user hits
   *  the content edge. Touch drag uses DragMove/DragEnd which DO rubber-band. */
  ApplyDelta = (jiv: Jiv, dx: number, dy: number): void => {
    const s = this._ensureState(jiv);
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    s.posX = Math.max(0, Math.min(maxX, s.posX + dx));
    s.posY = Math.max(0, Math.min(maxY, s.posY + dy));
    // Momentum burst, zeroed at bounds so coasting doesn't fight the edge
    s.velX = s.posX <= 0 || s.posX >= maxX ? 0 : s.velX + dx * WHEEL_VELOCITY_SCALE;
    s.velY = s.posY <= 0 || s.posY >= maxY ? 0 : s.velY + dy * WHEEL_VELOCITY_SCALE;
    this._syncJiv(jiv, s);
  };

  /** Start a drag (touch/pointer). Disables physics; caller will push
   *  positions via DragMove until DragEnd. */
  DragStart = (jiv: Jiv): void => {
    const s = this._ensureState(jiv);
    s.dragging = true;
    s.velX = 0;
    s.velY = 0;
  };

  /** Direct positional update during a drag — position tracks the finger 1:1.
   *  Also records a running-average velocity so DragEnd can hand off momentum. */
  DragMove = (jiv: Jiv, dx: number, dy: number, dt: number): void => {
    const s = this._ensureState(jiv);
    if (!s.dragging) return;

    // Rubber-band: reduce the effective delta when past bounds so the drag
    // feels resistant, not free. resistance grows with overscroll distance.
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    const scaledDx = dx * _rubberResistance(s.posX, 0, maxX);
    const scaledDy = dy * _rubberResistance(s.posY, 0, maxY);

    s.posX += scaledDx;
    s.posY += scaledDy;

    // EMA velocity estimate (for handoff to momentum at DragEnd)
    if (dt > 0) {
      const instVX = scaledDx / dt;
      const instVY = scaledDy / dt;
      s.velX = s.velX * 0.6 + instVX * 0.4;
      s.velY = s.velY * 0.6 + instVY * 0.4;
    }
    this._syncJiv(jiv, s);
  };

  /** Release a drag — physics resumes, exit velocity drives momentum. */
  DragEnd = (jiv: Jiv): void => {
    const s = this._states.get(jiv);
    if (!s) return;
    s.dragging = false;
  };

  /** Snap immediately to ScrollTargetX/Y (used for resize / programmatic jumps). */
  Snap = (jiv: Jiv): void => {
    const s = this._ensureState(jiv);
    s.posX = jiv.ScrollTargetX;
    s.posY = jiv.ScrollTargetY;
    s.velX = 0;
    s.velY = 0;
    this._syncJiv(jiv, s);
  };

  /** DOM-style scroll target: topmost hit, walk UP for scrollable ancestor. */
  ResolveScrollTarget = (cssX: number, cssY: number): Jiv | null => {
    const hit = this._hitTopmost(this._root, cssX, cssY, 0, 0);
    if (!hit) return null;
    let cur: Jiv | null = hit;
    while (cur) {
      if (cur.Style.Overflow === 'Scroll') return cur;
      cur = cur.Parent;
    }
    return null;
  };

  Tick = (dt: number): boolean => {
    let active = false;
    this._stepWalk(this._root, (jiv) => {
      const s = this._ensureState(jiv);
      if (s.dragging) return;

      const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
      const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);

      // Rubber-band: elastic force past bounds
      if (s.posX < 0) s.velX += (-s.posX) * RUBBER_K * dt;
      else if (s.posX > maxX) s.velX -= (s.posX - maxX) * RUBBER_K * dt;
      if (s.posY < 0) s.velY += (-s.posY) * RUBBER_K * dt;
      else if (s.posY > maxY) s.velY -= (s.posY - maxY) * RUBBER_K * dt;

      // Friction (normal inside bounds, stronger past bounds)
      const overX = s.posX < 0 || s.posX > maxX;
      const overY = s.posY < 0 || s.posY > maxY;
      const fx = overX ? OVER_FRICTION : FRICTION_PER_SEC;
      const fy = overY ? OVER_FRICTION : FRICTION_PER_SEC;
      s.velX *= Math.pow(fx, dt);
      s.velY *= Math.pow(fy, dt);

      // Integrate
      s.posX += s.velX * dt;
      s.posY += s.velY * dt;

      // Settle: inside bounds AND velocity small → zero out so RAF can stop
      const inBounds = !overX && !overY;
      const slow = Math.abs(s.velX) < SETTLE_V && Math.abs(s.velY) < SETTLE_V;
      if (inBounds && slow) {
        s.velX = 0;
        s.velY = 0;
      } else {
        active = true;
      }

      this._syncJiv(jiv, s);
    });
    return active;
  };

  private _ensureState = (jiv: Jiv): ScrollState => {
    let s = this._states.get(jiv);
    if (!s) {
      s = { posX: jiv.ScrollX, posY: jiv.ScrollY, velX: 0, velY: 0, dragging: false };
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
  };

  private _stepWalk = (node: Jiv, fn: (j: Jiv) => void): void => {
    if (node.Style.Overflow === 'Scroll') fn(node);
    for (const c of node.Children) this._stepWalk(c, fn);
  };

  private _hitTopmost = (node: Jiv, x: number, y: number, offX: number, offY: number): Jiv | null => {
    if (!node.Style.Visible || node.Style.PointerEvents === 'None') return null;

    const ox = node.X + offX;
    const oy = node.Y + offY;
    const inside = node === this._root
      ? true
      : x >= ox && x < ox + node.Width && y >= oy && y < oy + node.Height;

    if (!inside) return null;

    const dx = node.Style.Overflow === 'Scroll' ? offX - node.ScrollX : offX;
    const dy = node.Style.Overflow === 'Scroll' ? offY - node.ScrollY : offY;
    for (let i = node.Children.length - 1; i >= 0; i--) {
      const hit = this._hitTopmost(node.Children[i], x, y, dx, dy);
      if (hit) return hit;
    }
    return node;
  };
}

/** Rubber-band drag resistance: 1 inside bounds, drops off past bounds so the
 *  content feels elastic — dragging 100 px past the edge only moves ~50 px. */
const _rubberResistance = (pos: number, minBound: number, maxBound: number): number => {
  let over = 0;
  if (pos < minBound) over = minBound - pos;
  else if (pos > maxBound) over = pos - maxBound;
  if (over <= 0) return 1;
  // 1 / (1 + over/size) — standard Apple rubber-band formula
  const size = Math.max(1, maxBound - minBound);
  return 1 / (1 + over / size);
};
