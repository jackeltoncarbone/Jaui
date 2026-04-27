import type { Jiv } from '../Jiv/Jiv';
import type { Animatable } from '../Animation/Animation.Manager';

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
}

/** Drag-momentum velocity retention per second. Smaller = faster decay.
 *  0.02/s ⇒ half-life ≈ 0.18 s, full settle ≈ 0.6 s after a flick. */
const FRICTION_PER_SEC = 0.02;
/** Elastic spring constant for rubber-band (bigger = stiffer resist). */
const RUBBER_K = 180;
/** Extra damping when overscrolled, on top of normal friction. */
const OVER_FRICTION = 0.005;
/** Velocity magnitude below which we settle to zero (px/s). */
const SETTLE_V = 1;
/** Wheel-ease retention per second. 0.005/s ⇒ half-life ≈ 130 ms; pos reaches
 *  ~95 % of target in ~250 ms. Matches a snappy browser smooth-scroll feel. */
const WHEEL_EASE_PER_SEC = 0.005;
/** Distance below which wheel ease snaps to target (px). */
const WHEEL_SETTLE_PX = 0.5;

export class ScrollManager implements Animatable {
  private _states = new WeakMap<Jiv, ScrollState>();

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
    // Drag is authoritative — keep wheel-ease target locked to current pos
    // so a tap-then-wheel doesn't snap back to a stale target.
    s.targetX = s.posX;
    s.targetY = s.posY;

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
      if (cur.Overflow === 'Scroll') return cur;
      cur = cur.Parent as Jiv | null;
    }
    return null;
  };

  /** Topmost Jiv at (cssX, cssY) — respects Visible + PointerEvents. Shared
   *  by scroll, interaction-state tracking, and (soon) focus/click. */
  HitTopmost = (cssX: number, cssY: number): Jiv | null => {
    return this._hitTopmost(this._root, cssX, cssY, 0, 0);
  };

  Tick = (dt: number): boolean => {
    let active = false;
    this._stepWalk(this._root, (jiv) => {
      const s = this._ensureState(jiv);
      if (s.dragging) return;

      const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
      const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);

      const hasVel = s.velX !== 0 || s.velY !== 0;

      if (hasVel) {
        // ─── Drag-flick momentum path (touch / pointer release) ──────────────
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

        // Keep wheel-ease target tracking pos so an incoming wheel event
        // doesn't yank position back to a stale value.
        s.targetX = s.posX;
        s.targetY = s.posY;

        // Settle: inside bounds AND velocity small → zero out so RAF can stop
        const inBounds = !overX && !overY;
        const slow = Math.abs(s.velX) < SETTLE_V && Math.abs(s.velY) < SETTLE_V;
        if (inBounds && slow) {
          s.velX = 0;
          s.velY = 0;
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
  };

  private _stepWalk = (node: Jiv, fn: (j: Jiv) => void): void => {
    if (node.Overflow === 'Scroll') fn(node);
    for (const c of node.Children as Jiv[]) this._stepWalk(c, fn);
  };

  private _hitTopmost = (node: Jiv, x: number, y: number, offX: number, offY: number): Jiv | null => {
    if (!node.Visible) return null;

    const ox = node.X + offX;
    const oy = node.Y + offY;
    const inside = node === this._root
      ? true
      : x >= ox && x < ox + node.Width && y >= oy && y < oy + node.Height;

    // Overflow: Visible lets children extend past our rect (Placed/Fixed
    // or plain flow overflow). Only Hidden/Scroll clip children to us, so
    // we short-circuit the walk only when the pointer is outside a
    // clipping node. Otherwise descend and let a child pick the hit.
    if (!inside && node.Overflow !== 'Visible') return null;

    const dx = node.Overflow === 'Scroll' ? offX - node.ScrollX : offX;
    const dy = node.Overflow === 'Scroll' ? offY - node.ScrollY : offY;
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
        const hit = this._hitTopmost(decorated[i].c, x, y, dx, dy);
        if (hit) return hit;
      }
    } else {
      for (let i = children.length - 1; i >= 0; i--) {
        const hit = this._hitTopmost(children[i], x, y, dx, dy);
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
const _rubberResistance = (pos: number, minBound: number, maxBound: number): number => {
  let over = 0;
  if (pos < minBound) over = minBound - pos;
  else if (pos > maxBound) over = pos - maxBound;
  if (over <= 0) return 1;
  // 1 / (1 + over/size) — standard Apple rubber-band formula
  const size = Math.max(1, maxBound - minBound);
  return 1 / (1 + over / size);
};
