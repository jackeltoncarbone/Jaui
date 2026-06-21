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
    s.posX = Math.max(0, Math.min(maxX, s.posX + dx));
    s.posY = Math.max(0, Math.min(maxY, s.posY + dy));
    // Effective delta is what actually moved (zero when clamped against an
    // edge) so velocity / momentum can't be charged from a finger that the
    // edge swallowed.
    const scaledDx = s.posX - prevX;
    const scaledDy = s.posY - prevY;
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
      if (cur.Overflow === 'Scroll') return cur;
      cur = cur.Parent as Jiv | null;
    }
    return null;
  };

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

      const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
      const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);

      const hasVel = s.velX !== 0 || s.velY !== 0;

      if (hasVel) {
        // ─── Drag-flick momentum path (touch / pointer release) ──────────────
        // No rubber-band: friction-decayed velocity, position hard-clamped to
        // bounds. When momentum carries into an edge the velocity on that axis
        // zeroes out so we don't keep accumulating energy against a wall.
        s.velX *= Math.pow(FRICTION_PER_SEC, dt);
        s.velY *= Math.pow(FRICTION_PER_SEC, dt);

        s.posX += s.velX * dt;
        s.posY += s.velY * dt;

        if (s.posX <= 0) { s.posX = 0; s.velX = 0; }
        else if (s.posX >= maxX) { s.posX = maxX; s.velX = 0; }
        if (s.posY <= 0) { s.posY = 0; s.velY = 0; }
        else if (s.posY >= maxY) { s.posY = maxY; s.velY = 0; }

        // Keep wheel-ease target tracking pos so an incoming wheel event
        // doesn't yank position back to a stale value.
        s.targetX = s.posX;
        s.targetY = s.posY;

        // Settle: velocity small → zero out so RAF can stop
        const slow = Math.abs(s.velX) < SETTLE_V && Math.abs(s.velY) < SETTLE_V;
        if (slow) {
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
        samples: [],
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
        const hit = this._hitTopmost(decorated[i].c, px, py, childM);
        if (hit) return hit;
      }
    } else {
      for (let i = children.length - 1; i >= 0; i--) {
        const hit = this._hitTopmost(children[i], px, py, childM);
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
