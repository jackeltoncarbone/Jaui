import type { Jiv } from '../Jiv/Jiv';
import type { Animatable } from '../Animation/Animation.Manager';
import { type Mat2x3, MAT_IDENTITY, matMul, matInvApply } from '../Transform/Mat2x3';
import { PageTarget, type PageSpan } from './Scroll.Page';
import { AlignTarget } from './Scroll.Align';
import type { ScrollAlign, ScrollAxis, ScrollMotion } from './Scroll.Types';
import type { OverscrollMode } from '../Layout/Layout.Types';
import {
  ComputeReleaseVelocity,
  PruneReleaseSamples,
  type ReleaseSample,
} from './Scroll.Release';
import { JTrace, JauiTracing, JMs } from '../Diagnostics/Jaui.Trace';
import { LAYER_TOP } from '../Jiv/Jiv.Types';
import { Element } from '../Element/Element';
import { SCROLL_VARS, SubtreeReadsScrollVars, AnalyzeScrollVarUsage } from './Scroll.VarReaders';

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
 *                            Position tracks the finger 1:1; release takes the
 *                            trailing-window velocity (Scroll.Release.ts) and
 *                            coasts it down under FRICTION_PER_SEC. Past
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
  /** Trailing-window of recent DragMove samples (oldest first). Pruned to the
   *  last RELEASE_WINDOW_MS each move. At DragEnd these become momentum
   *  velocity — a fixed time window, not an EMA, so that if you decelerate the
   *  finger before lifting, only the slow recent motion contributes and the
   *  content can't briefly outpace your finger after release. Each sample
   *  carries the DURATION of its own interval; see Scroll.Release.ts for why
   *  that pairing is the whole model. */
  samples: ReleaseSample[];
  /** Event time (ms, main-thread clock) of the previous drag sample, so the
   *  next one can measure its own interval. -1 before the first move. */
  lastSampleT: number;
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

  /** Set by the render walk on a frame that painted a `Layer: Top` subtree, so the hit test only
   *  looks for them while one is up. */
  TopLayerPresent = false;

  constructor(private _root: Jiv) {}

  /** Wheel/keyboard delta entry point. Pushes the TARGET and lets Tick's
   *  wheel-ease path exponentially decay toward it — matches browser
   *  smooth-scroll feel (rapid wheels stack because deltas accumulate on
   *  the target, not the current position).
   *
   *  Rubber-band and momentum are the TOUCH default; wheel always hard-clamps
   *  here UNLESS the target's `OverscrollInput` is `All` (Scroll.Types), which
   *  is the one policy that lets a line-stepped wheel overscroll too — then
   *  this takes the same resistance-integrated path DragMove does, and the
   *  release spring in Tick() picks it up exactly like a touch release. */
  ApplyDelta = (jiv: Jiv, dx: number, dy: number): void => {
    const s = this._ensureState(jiv);
    _repairState(s);
    dx = ScrollDelta(dx);
    dy = ScrollDelta(dy);
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    if (jiv.OverscrollInput === 'All') {
      const r = _resistanceMultiplier(jiv.OverscrollResistance);
      s.targetX = maxX > 0
        ? _integrateRubber(s.targetX, dx, 0, maxX, r, jiv.OverscrollLeft, jiv.OverscrollRight, jiv.Width)
        : Math.max(0, Math.min(maxX, s.targetX + dx));
      s.targetY = maxY > 0
        ? _integrateRubber(s.targetY, dy, 0, maxY, r, jiv.OverscrollTop, jiv.OverscrollBottom, jiv.Height)
        : Math.max(0, Math.min(maxY, s.targetY + dy));
      // No pending ease once overscrolling — land the same frame, like DragMove/
      // ApplyDeltaInstant, so the release spring (not the wheel-ease decay) is
      // what carries it home; the two easers fighting over an out-of-bounds
      // target would otherwise fight each other.
      s.posX = s.targetX;
      s.posY = s.targetY;
    } else {
      s.targetX = Math.max(0, Math.min(maxX, s.targetX + dx));
      s.targetY = Math.max(0, Math.min(maxY, s.targetY + dy));
    }
    // Wheel cancels any leftover drag-flick momentum so the two inputs don't
    // fight each other (e.g. user flicks then immediately wheels — wheel wins).
    s.velX = 0;
    s.velY = 0;
  };

  /** Instant delta — trackpad / precise-pointer scrolling. The OS already
   *  streams smoothed momentum deltas, so we move the position 1:1 with ZERO
   *  ease for a fully-responsive, native feel. Position and target advance
   *  together (no pending ease); _syncJiv commits it on the kicked tick.
   *  Mouse wheels use ApplyDelta's smooth path instead.
   *
   *  `allowOverscroll` — false (the default) hard-clamps, exactly as before
   *  this feature. The wheel handler passes true once it has decided (via
   *  the target's `OverscrollInput`) that this precise/trackpad delta is
   *  allowed to rubber-band; DragMove never calls this (it has its own path)
   *  so touch is unaffected either way. */
  ApplyDeltaInstant = (jiv: Jiv, dx: number, dy: number, allowOverscroll: boolean = false): void => {
    const s = this._ensureState(jiv);
    _repairState(s);
    dx = ScrollDelta(dx);
    dy = ScrollDelta(dy);
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    if (allowOverscroll) {
      const r = _resistanceMultiplier(jiv.OverscrollResistance);
      s.posX = maxX > 0
        ? _integrateRubber(s.posX, dx, 0, maxX, r, jiv.OverscrollLeft, jiv.OverscrollRight, jiv.Width)
        : Math.max(0, Math.min(maxX, s.posX + dx));
      s.posY = maxY > 0
        ? _integrateRubber(s.posY, dy, 0, maxY, r, jiv.OverscrollTop, jiv.OverscrollBottom, jiv.Height)
        : Math.max(0, Math.min(maxY, s.posY + dy));
    } else {
      s.posX = Math.max(0, Math.min(maxX, s.posX + dx));
      s.posY = Math.max(0, Math.min(maxY, s.posY + dy));
    }
    s.targetX = s.posX;
    s.targetY = s.posY;
    s.velX = 0;
    s.velY = 0;
  };

  /** Scroll a container to an ABSOLUTE offset. `Smooth` rides the same ease
   *  the wheel uses; `Instant` lands this frame. This is the consumer-facing
   *  primitive the engine never had — callers were poking ScrollY directly,
   *  bypassing the physics and racing the per-frame sync. */
  ScrollTo = (jiv: Jiv, x: number | null, y: number | null, motion: ScrollMotion = 'Smooth'): void => {
    const s = this._ensureState(jiv);
    const dx = x === null ? 0 : x - s.targetX;
    const dy = y === null ? 0 : y - s.targetY;
    if (motion === 'Smooth') this.ApplyDelta(jiv, dx, dy);
    else this.ApplyDeltaInstant(jiv, dx, dy);
  };

  /** Scroll a container so a descendant's box lands at an alignment inside the
   *  window — the element half of the scroll-to primitive, and what a rail that
   *  jumps to a section presses.
   *
   *  `rect` is the element in the CONTAINER'S un-scrolled content coordinates;
   *  the caller resolves it, because only the canvas knows the tree. `pad` is
   *  the container's resolved padding, which is the line the element lands on
   *  (see Scroll.Align). `offset` is added AFTER alignment and before the
   *  clamp, so a sticky head's height can pull the landing down without
   *  letting the request run off the end of the content.
   *
   *  Alignment is measured from the PENDING target, so a second jump made
   *  while the first is still easing composes with it instead of restarting
   *  the arithmetic from a position halfway through an animation. */
  AlignInto = (
    jiv: Jiv,
    rect: { x: number; y: number; width: number; height: number },
    pad: { Left: number; Right: number; Top: number; Bottom: number },
    align: ScrollAlign,
    axis: ScrollAxis,
    offset: { X: number; Y: number },
    motion: ScrollMotion,
  ): void => {
    const s = this._ensureState(jiv);
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    const x = axis === 'Y' ? null
      : AlignTarget({ Start: rect.x, Size: rect.width }, s.targetX, jiv.Width, pad.Left, pad.Right, maxX, align) + offset.X;
    const y = axis === 'X' ? null
      : AlignTarget({ Start: rect.y, Size: rect.height }, s.targetY, jiv.Height, pad.Top, pad.Bottom, maxY, align) + offset.Y;
    // No clamp here: ScrollTo resolves to a delta and ApplyDelta clamps the
    // target to the content bounds, so an offset past an edge lands AT it.
    this.ScrollTo(jiv, x, y, motion);
  };

  /** Page a row one screen of whole cards along X (see `PageTarget`). The
   *  padding is the container's resolved leading and trailing padding, which
   *  is the line a paged card lands on. Content extents must be current. */
  PageX = (jiv: Jiv, direction: 1 | -1, padStart: number, padEnd: number): void => {
    const s = this._ensureState(jiv);
    const spans: PageSpan[] = [];
    for (const c of jiv.Children) {
      if (c.ChildLayout.Position !== 'Flow' && c.ChildLayout.Position !== 'Offset') continue;
      spans.push({ Start: c.X - jiv.X, End: c.X - jiv.X + c.Width });
    }
    spans.sort((a, b) => a.Start - b.Start);
    const max = Math.max(0, jiv.ContentWidth - jiv.Width);
    this.ScrollTo(jiv, PageTarget(spans, s.targetX, jiv.Width, padStart, padEnd, max, direction), null, 'Smooth');
  };

  /** Scroll the nearest scrollable ancestor the minimum distance that brings
   *  `rect` (container-content coordinates) fully into view, plus a margin —
   *  the web's scrollIntoView({block:'nearest'}), which focus-reveal and the
   *  caret both need. */
  ScrollRectIntoView = (jiv: Jiv, rect: { x: number; y: number; width: number; height: number }, marginPx = 8, motion: ScrollMotion = 'Smooth'): void => {
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
    if (motion === 'Smooth') this.ApplyDelta(jiv, dx, dy);
    else this.ApplyDeltaInstant(jiv, dx, dy);
  };

  /** Start a drag (touch/pointer). Disables physics; caller will push
   *  positions via DragMove until DragEnd. */
  DragStart = (jiv: Jiv): void => {
    const s = this._ensureState(jiv);
    s.dragging = true;
    s.velX = 0;
    s.velY = 0;
    s.samples.length = 0;
    s.lastSampleT = -1;
  };

  /** Direct positional update during a drag — position tracks the finger 1:1 inside bounds; past an
   *  edge it takes that edge's `OverscrollMode` (Bounce stretches and shows it, Pin stretches but
   *  holds the content at the line, None hard-clamps with no give at all — Scroll.Types).
   *  Also records the move into the trailing window so DragEnd can derive
   *  release velocity from the most recent ~RELEASE_WINDOW_MS only.
   *
   *  `tMs` is the EVENT's own time, not the moment this call happened. The two
   *  are different numbers and the difference is bridge latency: pointer samples
   *  cross to the worker in batches, so several samples can arrive within the
   *  same microsecond carrying tens of milliseconds of finger travel between
   *  them. Stamping arrival would price that travel at the queue's speed rather
   *  than the finger's. Any single consistent millisecond clock will do — only
   *  DIFFERENCES are ever taken — but every sample of one drag must use the
   *  same one, and it must be the one the finger moved on. */
  DragMove = (jiv: Jiv, dx: number, dy: number, tMs: number): void => {
    const s = this._ensureState(jiv);
    if (!s.dragging) return;
    _repairState(s);
    dx = ScrollDelta(dx);
    dy = ScrollDelta(dy);

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
    // (no bounce on a direction with nowhere to go — the iOS/web rule). Touch
    // is always eligible for whatever each edge's OverscrollMode allows
    // (OverscrollInput only gates wheel/trackpad — see ApplyDelta/Instant).
    const r = _resistanceMultiplier(jiv.OverscrollResistance);
    s.posX = maxX > 0
      ? _integrateRubber(s.posX, dx, 0, maxX, r, jiv.OverscrollLeft, jiv.OverscrollRight, jiv.Width)
      : Math.max(0, Math.min(maxX, s.posX + dx));
    s.posY = maxY > 0
      ? _integrateRubber(s.posY, dy, 0, maxY, r, jiv.OverscrollTop, jiv.OverscrollBottom, jiv.Height)
      : Math.max(0, Math.min(maxY, s.posY + dy));
    // Momentum is still charged only from IN-BOUNDS travel: overscroll
    // stretch is the spring's business, not the fling's.
    const scaledDx = Math.max(0, Math.min(maxX, s.posX)) - Math.max(0, Math.min(maxX, prevX));
    const scaledDy = Math.max(0, Math.min(maxY, s.posY)) - Math.max(0, Math.min(maxY, prevY));
    // Drag is authoritative — keep wheel-ease target locked to current pos
    // so a tap-then-wheel doesn't snap back to a stale target.
    s.targetX = s.posX;
    s.targetY = s.posY;

    // The first move of a drag has no predecessor to measure against, so it has
    // no honest duration. It still moves the content; it just carries no weight
    // in the release — better than guessing a nominal frame time for it.
    const dt = s.lastSampleT < 0 ? 0 : Math.max(0, tMs - s.lastSampleT);
    s.lastSampleT = tMs;
    s.samples.push({ dx: scaledDx, dy: scaledDy, dt, t: tMs });
    // Drop anything older than the trailing window so the buffer can never
    // grow unbounded and DragEnd's sum is O(window-size).
    PruneReleaseSamples(s.samples, tMs, RELEASE_WINDOW_MS);

    this._syncJiv(jiv, s);
  };

  /** Stop a drag with NO momentum — the gesture was claimed by something
   *  else (a selection handle), so the container must freeze where it is
   *  rather than flick onward from the finger's speed. */
  DragCancel = (jiv: Jiv): void => {
    const s = this._states.get(jiv);
    if (!s) return;
    s.dragging = false;
    s.samples.length = 0;
    s.lastSampleT = -1;
    s.velX = 0;
    s.velY = 0;
  };

  /** Release a drag — physics resumes and the trailing window becomes momentum.
   *  `tMs` is the lift event's own time, on the same clock the samples carry.
   *  A finger that held still before lifting releases nothing: its samples have
   *  either drained out of the window or carry no distance across real time. */
  DragEnd = (jiv: Jiv, tMs: number): void => {
    const s = this._states.get(jiv);
    if (!s) return;
    s.dragging = false;

    const v = ComputeReleaseVelocity(s.samples, tMs, RELEASE_WINDOW_MS);
    s.velX = v.vx;
    s.velY = v.vy;
    if (JauiTracing()) {
      JTrace(`scroll:fling:${JMs(v.vx)}x${JMs(v.vy)}px/s:n${s.samples.length}`);
    }
    s.samples.length = 0;
    s.lastSampleT = -1;
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

  /** Every scroll container under a finger, innermost first: the ones a touch
   *  COULD drive. Which one it does is not known until the finger has moved
   *  far enough to have a direction; see `PickDragTarget`. */
  ResolveScrollCandidates = (cssX: number, cssY: number): Jiv[] => {
    const out: Jiv[] = [];
    for (let cur: Jiv | null = this.HitTopmost(cssX, cssY); cur; cur = cur.Parent as Jiv | null) {
      if (cur.Overflow === 'Scroll' && this._canScrollEither(cur)) out.push(cur);
    }
    return out;
  };

  /** The container a touch drag belongs to, once its direction is known: the
   *  innermost candidate that scrolls on the drag's DOMINANT axis. This is the
   *  browser's and iOS's rule for nested scrollers: a vertical swipe that
   *  starts inside a horizontal carousel scrolls the page, and a horizontal
   *  one scrolls the carousel. (The carousel owning the finger just because it
   *  was under it first is the bug this replaces.) A candidate at its bound
   *  still owns its axis and rubber-bands; chaining past a bound is wheel
   *  behavior, not touch. Falls back to the innermost when nothing scrolls on
   *  that axis, which is what the old rule always did. */
  PickDragTarget = (candidates: readonly Jiv[], dx: number, dy: number): Jiv | null => {
    if (candidates.length === 0) return null;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    for (const c of candidates) {
      const room = horizontal ? c.ContentWidth - c.Width : c.ContentHeight - c.Height;
      if (room > 0.5) return c;
    }
    return candidates[0];
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
    precise: boolean = false,
  ): { xTarget: Jiv | null; yTarget: Jiv | null } =>
    this.ScrollChainFrom(this.HitTopmost(cssX, cssY), dx, dy, precise);

  /** The chain walk itself, from an already-hit node up. A scroller that can really move on an axis
   *  always wins it, innermost first -- that is the chaining. Only when NOTHING on the chain can move
   *  does the axis fall back to the innermost scroller allowed to overscroll there for this input
   *  (`WheelMayOverscroll`). Without the fallback a wheel or trackpad pull at an edge found no target
   *  and was dropped before the rubber band ever saw it, so `Pin`'s `@OverscrollTop` stayed 0 and a
   *  stretchy header never stretched (measured 2026-09-27, Chromium and Safari: 0 throughout a pull). */
  ScrollChainFrom = (
    hit: Jiv | null,
    dx: number,
    dy: number,
    precise: boolean = false,
  ): { xTarget: Jiv | null; yTarget: Jiv | null } => {
    let xTarget: Jiv | null = null;
    let yTarget: Jiv | null = null;
    let xEdge: Jiv | null = null;
    let yEdge: Jiv | null = null;
    for (let cur: Jiv | null = hit; cur; cur = cur.Parent as Jiv | null) {
      if (cur.Overflow !== 'Scroll') continue;
      if (!xTarget && this._canScrollAxis(cur, 'x', dx)) xTarget = cur;
      if (!yTarget && this._canScrollAxis(cur, 'y', dy)) yTarget = cur;
      if (!xEdge && WheelMayOverscroll(cur, 'x', dx, precise)) xEdge = cur;
      if (!yEdge && WheelMayOverscroll(cur, 'y', dy, precise)) yEdge = cur;
      if (xTarget && yTarget) break;
    }
    return { xTarget: xTarget ?? xEdge, yTarget: yTarget ?? yEdge };
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
    // `Layer: Top` subtrees paint after the whole tree, so they take the pointer first, last painted first.
    if (this.TopLayerPresent) {
      const tops: { N: Jiv; M: Mat2x3 }[] = [];
      this._collectTopLayer(this._root, MAT_IDENTITY, tops);
      for (let i = tops.length - 1; i >= 0; i--) {
        const hit = this._hitTopmost(tops[i].N, cssX, cssY, tops[i].M);
        if (hit) return hit;
      }
    }
    return this._hitTopmost(this._root, cssX, cssY, MAT_IDENTITY);
  };

  /** Every visible `Layer: Top` node in paint order, each with the parent frame `_hitTopmost` takes.
   *  Ignores clips: a top-layer subtree is outside all of them. */
  private _collectTopLayer = (node: Jiv, m: Mat2x3, out: { N: Jiv; M: Mat2x3 }[]): void => {
    if (!node.Visible) return;
    const eff = this._rotated(node, m);
    const childM = node.Overflow === 'Scroll' ? matMul(eff, [1, 0, 0, 1, -node.ScrollX, -node.ScrollY]) : eff;
    for (const c of this._paintOrder(node.Children as Jiv[])) {
      const cm = c.ChildLayout.Position === 'Pinned' && node.Overflow === 'Scroll' ? eff : childM;
      if (c.RenderStyle.Layer >= LAYER_TOP && c.Visible) out.push({ N: c, M: cm });
      this._collectTopLayer(c, cm, out);
    }
  };

  /** Children in paint order: Layer ascending, tree order breaking ties. */
  private _paintOrder = (children: Jiv[]): Jiv[] => {
    for (let i = 0; i < children.length; i++) {
      if (children[i].RenderStyle.Layer !== 0) return [...children].sort((a, b) => a.RenderStyle.Layer - b.RenderStyle.Layer);
    }
    return children;
  };

  /** `m` with the node's own rotation about its Transform origin, exactly as renderNode composes it. */
  private _rotated = (node: Jiv, m: Mat2x3): Mat2x3 => {
    const rotDeg = node.RenderStyle.Transform.Rotation;
    if (rotDeg === 0) return m;
    const th = rotDeg * (Math.PI / 180), rc = Math.cos(th), rs = Math.sin(th);
    const rpx = node.X + node.Width * node.RenderStyle.Transform.OriginX;
    const rpy = node.Y + node.Height * node.RenderStyle.Transform.OriginY;
    return matMul(m, [rc, rs, -rs, rc, rpx * (1 - rc) + rpy * rs, rpy * (1 - rc) - rpx * rs]);
  };

  Tick = (dt: number): boolean => {
    let active = false;
    this._stepWalk(this._root, (jiv) => {
      const s = this._ensureState(jiv);
      if (s.dragging) return;
      _repairState(s);

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

        // A `None` edge takes no bounce at all: once momentum (a fresh coast, or
        // the spring above) carries it past that edge, stop dead exactly at the
        // line rather than let the frame's residual travel push it into the wall.
        if (jiv.OverscrollLeft === 'None' && s.posX < 0) { s.posX = 0; s.velX = 0; }
        if (jiv.OverscrollRight === 'None' && s.posX > maxX) { s.posX = maxX; s.velX = 0; }
        if (jiv.OverscrollTop === 'None' && s.posY < 0) { s.posY = 0; s.velY = 0; }
        if (jiv.OverscrollBottom === 'None' && s.posY > maxY) { s.posY = maxY; s.velY = 0; }

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
        lastSampleT: -1,
        lastActiveAt: 0,
        autoHold: 0,
      };
      this._states.set(jiv, s);
    }
    return s;
  };

  private _syncJiv = (jiv: Jiv, s: ScrollState): void => {
    const maxX = Math.max(0, jiv.ContentWidth - jiv.Width);
    const maxY = Math.max(0, jiv.ContentHeight - jiv.Height);
    // The VISIBLE content offset: `Bounce` lets the raw physics position show past its bound;
    // `Pin` (and `None`, which never carries an overshoot to begin with — see Tick/DragMove/
    // ApplyDelta*'s per-edge clamps) holds the visible content at the line while the raw
    // position keeps tracking the overshoot for `@OverscrollTop`/etc below.
    // Default (undefined — e.g. an older fixture, or a Jiv built before this feature) is `Bounce`,
    // same as the engine field's own default (Element.ts): only an EXPLICIT Pin/None holds the line.
    let visualX = s.posX;
    if (visualX < 0 && (jiv.OverscrollLeft ?? 'Bounce') !== 'Bounce') visualX = 0;
    else if (visualX > maxX && (jiv.OverscrollRight ?? 'Bounce') !== 'Bounce') visualX = maxX;
    let visualY = s.posY;
    if (visualY < 0 && (jiv.OverscrollTop ?? 'Bounce') !== 'Bounce') visualY = 0;
    else if (visualY > maxY && (jiv.OverscrollBottom ?? 'Bounce') !== 'Bounce') visualY = maxY;

    jiv.ScrollX = visualX;
    jiv.ScrollY = visualY;
    // Keep Target in sync so external code inspecting targets sees the real (visible) pos.
    jiv.ScrollTargetX = visualX;
    jiv.ScrollTargetY = visualY;
    this._publishVars(jiv, s, visualX, visualY, maxX, maxY);
  };

  /** The container's scroll FACTS, published as element vars that cascade to
   *  its subtree — so scroll-driven UI is authored in JSS, not hardcoded. A
   *  scrollbar is one composition of these; a minimap, an edge glow, a
   *  progress label, a back-to-top pill are others, and none of them need the
   *  engine to know they exist. Values are rounded so a sub-pixel ease step
   *  doesn't churn re-resolves; SetVar no-ops on equal values. */
  private _publishVars = (
    jiv: Jiv, s: ScrollState, visualX: number, visualY: number, maxX: number, maxY: number,
  ): void => {
    jiv.SetVar('ScrollY', Math.round(visualY));
    jiv.SetVar('ScrollX', Math.round(visualX));
    jiv.SetVar('ScrollMaxY', Math.round(maxY));
    jiv.SetVar('ScrollMaxX', Math.round(maxX));
    jiv.SetVar('ScrollFracY', maxY > 0 ? Math.round((visualY / maxY) * 1000) / 1000 : 0);
    jiv.SetVar('ScrollFracX', maxX > 0 ? Math.round((visualX / maxX) * 1000) / 1000 : 0);
    // The fraction along whichever axis actually scrolls (0..1) — vertical wins when a container
    // scrolls both, since that is the common page-scroll reading a header/rail wants.
    const progress = maxY > 0 ? visualY / maxY : maxX > 0 ? visualX / maxX : 0;
    jiv.SetVar('ScrollProgress', Math.round(Math.max(0, Math.min(1, progress)) * 1000) / 1000);
    jiv.SetVar('ViewportH', Math.round(jiv.Height));
    jiv.SetVar('ViewportW', Math.round(jiv.Width));
    jiv.SetVar('ContentH', Math.round(Math.max(1, jiv.ContentHeight)));
    jiv.SetVar('ContentW', Math.round(Math.max(1, jiv.ContentWidth)));
    // The RAW physics position carries the overshoot even in `Pin` mode, where the visible
    // position above stays clamped; `None` never leaves bounds so these are always 0 there.
    jiv.SetVar('OverscrollTop', Math.round(Math.max(0, -s.posY)));
    jiv.SetVar('OverscrollBottom', Math.round(Math.max(0, s.posY - maxY)));
    jiv.SetVar('OverscrollLeft', Math.round(Math.max(0, -s.posX)));
    jiv.SetVar('OverscrollRight', Math.round(Math.max(0, s.posX - maxX)));
    const active = s.dragging || s.velX !== 0 || s.velY !== 0
      || s.posX !== s.targetX || s.posY !== s.targetY;
    if (active) s.lastActiveAt = performance.now();
    // 0/1 — the FADE is the stylesheet's business (`@Transition Opacity`).
    jiv.SetVar('ScrollActive', active || performance.now() - s.lastActiveAt < 900 ? 1 : 0);

    if (!this._readsScrollVars(jiv)) return;

    if (!Element.AuthoredTracked) {
      // No reliable per-node authoring tracking to classify by — always take the correct
      // (expensive) path rather than risk a stale render-only node.
      jiv.MarkLayoutDirty();
      return;
    }

    // PERFORMANCE: keep the shared, already-cascaded vars map in sync IN PLACE — a descendant with
    // no `[vars]` of its own shares this exact Map object BY REFERENCE with this scroller
    // (Layout.Solver's `_buildChildCtx`/`_mergeVars` short-circuits to the same reference when a
    // node has nothing of its own to merge). Mutating it lets a style-only wake below see the fresh
    // value on its very next Tick with NO fresh layout solve. Guarded against the map still being
    // the bare global vars table — that one isn't scoped to this node (pre-first-solve, or this
    // scroller hasn't been visited by one since it started publishing) and must never be written.
    const ctxVars = jiv.ResolveCtx?.Vars;
    const globalVars = this.GlobalVars();
    const ownsMergedMap = ctxVars !== undefined && ctxVars !== globalVars;
    if (ownsMergedMap) {
      const m = ctxVars as Map<string, string>;
      for (const name of SCROLL_VARS) {
        const v = jiv.VarMap.get(name);
        if (v !== undefined) m.set(name, String(v));
      }
    }

    const usage = AnalyzeScrollVarUsage(jiv, SCROLL_VARS, globalVars);
    if (usage.NeedsLayout || !ownsMergedMap) {
      // A Layout/ChildLayout/TextStyle/PointScale bag depends on a scroll var — a real re-solve is
      // required regardless (it re-resolves everyone's style too, layout or not) — OR the shared map
      // isn't scoped to this node yet: MarkLayoutDirty bootstraps it (the next solve's
      // `_buildChildCtx` merges this scroller's VarMap into its own dedicated map, so subsequent
      // ticks take the cheap branch above).
      jiv.MarkLayoutDirty();
    } else {
      for (const node of usage.RenderOnly) node.MarkStyleDirty();
    }
  };

  /** The canvas's global JSS vars, which a subtree's var references resolve through. */
  GlobalVars: () => ReadonlyMap<string, string> = () => new Map();

  /** Whether a re-solve after this scroller moves could change anything. Without a registry carrying every
   *  authored write the answer cannot be cached, so it is always yes. */
  private _readsScrollVars = (jiv: Jiv): boolean =>
    !Element.AuthoredTracked || SubtreeReadsScrollVars(jiv, this.GlobalVars());

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
    const eff = this._rotated(node, m);

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
        if (c.RenderStyle.Layer >= LAYER_TOP) continue;
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

/** `OverscrollResistance` string ('Auto' | numeric) to a multiplier on the resistance formula's
 *  `size` term: `Auto` (or anything non-positive/unparseable) is Apple's curve unscaled (1); a
 *  number N makes the same drag stretch further for N > 1 (softer) or less for N < 1 (stiffer). */
const _resistanceMultiplier = (raw: string): number => {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/** Rubber-band drag resistance: 1 inside bounds, drops off past bounds so the
 *  content feels elastic — dragging 100 px past the edge only moves ~50 px.
 *  Advance `pos` by `delta` through the resistance curve, a few px at a time, so the curve is
 *  honored across the whole travel and not just its start. `lowMode`/`highMode` are the edge's
 *  own `OverscrollMode` (Scroll.Types): `None` hard-clamps that side (no resistance, no overshoot —
 *  the finger/wheel feels stuck at the line); `Bounce`/`Pin` both take the resistance curve — they
 *  differ only in whether `ScrollManager._syncJiv` shows the resulting overshoot as a moved content
 *  position (`Bounce`) or holds it at the line while still publishing it (`Pin`). */
const _integrateRubber = (
  pos: number, delta: number, minBound: number, maxBound: number,
  resistance: number, lowMode: OverscrollMode, highMode: OverscrollMode, reach: number,
): number => {
  const STEP = 4;
  // THE PULL PAST AN EDGE IS BOUNDED (a fast trackpad fling, or a synthetic wheel of -10000 over the drill editor's
  // phrase list). The curve's stretch grows as the square root of the pull, without limit, and the loop below walks
  // the whole delta four pixels at a time: a pull of ten thousand pixels stretched the list thousands of pixels off its
  // edge, and an infinite one never left this loop. Whatever travel lies inside the bounds is kept, and past the edge
  // the pull counts for at most one viewport (`reach`, the scroller's own size on this axis): a flick lands at the
  // edge with the same stretch a long finger pull would show, never more.
  const pull = Math.max(1, Number.isFinite(reach) ? reach : 1);
  const lo = Math.min(0, minBound - pos) - pull;
  const hi = Math.max(0, maxBound - pos) + pull;
  let remaining = Math.max(lo, Math.min(hi, ScrollDelta(delta)));
  // A long list's in-bounds travel is taken in one move rather than a few thousand four-pixel ones: inside the bounds
  // the resistance is exactly 1, so whole steps that start inside land where the loop would have put them. Only a
  // travel this long takes the shortcut; every ordinary delta runs the loop exactly as before.
  if (pos >= minBound && pos <= maxBound && remaining !== 0) {
    const room = remaining > 0 ? maxBound - pos : pos - minBound;
    const steps = Math.floor(Math.min(Math.abs(remaining), room) / STEP);
    if (steps > 1024) {
      const move = Math.sign(remaining) * steps * STEP;
      pos += move;
      remaining -= move;
    }
  }
  while (remaining !== 0) {
    const step = Math.abs(remaining) <= STEP ? remaining : Math.sign(remaining) * STEP;
    pos += step * _rubberResistance(pos, minBound, maxBound, resistance);
    remaining -= step;
  }
  // A `None` edge takes no overshoot at all — a fast single-step delta that would otherwise cross
  // the line before the loop above ever re-checked it lands exactly on the line instead.
  if (lowMode === 'None' && pos < minBound) pos = minBound;
  if (highMode === 'None' && pos > maxBound) pos = maxBound;
  return pos;
};

const _rubberResistance = (pos: number, minBound: number, maxBound: number, resistance: number): number => {
  let over = 0;
  if (pos < minBound) over = minBound - pos;
  else if (pos > maxBound) over = pos - maxBound;
  if (over <= 0) return 1;
  // 1 / (1 + over/size) — standard Apple rubber-band formula; `resistance` scales `size` so a
  // configured value softens (>1) or stiffens (<1) the same curve.
  const size = Math.max(1, (maxBound - minBound) * resistance);
  return 1 / (1 + over / size);
};

/** May a wheel or trackpad delta push `jiv` past the edge it points at? The same gates the wheel path
 *  applies once it has a target: `OverscrollInput` (`Touch` never; a line-stepped wheel only under
 *  `All`; a precise/trackpad delta under the `Precise` default), the edge's `OverscrollMode` (not
 *  `None`), and an axis that scrolls at all, since the rubber band integrates only where there is
 *  extent (`ApplyDeltaInstant`). */
export const WheelMayOverscroll = (jiv: Jiv, axis: 'x' | 'y', delta: number, precise: boolean): boolean => {
  if (delta === 0) return false;
  const input = jiv.OverscrollInput ?? 'Precise';
  if (input === 'Touch' || (!precise && input !== 'All')) return false;
  const extent = axis === 'y' ? jiv.ContentHeight - jiv.Height : jiv.ContentWidth - jiv.Width;
  if (extent <= 0) return false;
  const mode = axis === 'y'
    ? (delta < 0 ? jiv.OverscrollTop : jiv.OverscrollBottom)
    : (delta < 0 ? jiv.OverscrollLeft : jiv.OverscrollRight);
  return (mode ?? 'Bounce') !== 'None';
};

/** A scroll delta the physics can take: NaN (a broken event, or arithmetic on a box with no size) moves nothing, and
 *  either infinity moves as far as anything can, which every path then clamps to the edge it points at. Finite deltas
 *  pass through untouched. */
export const ScrollDelta = (d: number): number => {
  if (Number.isNaN(d)) return 0;
  if (d === Infinity) return Number.MAX_SAFE_INTEGER;
  if (d === -Infinity) return -Number.MAX_SAFE_INTEGER;
  return d;
};

/** A scroll state that something upstream poisoned (a NaN content size, a non-finite programmatic target) is put back
 *  at its target, or at 0, before the physics reads it: a NaN offset never reaches `ScrollY`, the scroll vars, or the
 *  render walk's translate. Costs four `isFinite` reads per scroller per tick. */
const _repairState = (s: ScrollState): void => {
  if (!Number.isFinite(s.targetX)) s.targetX = Number.isFinite(s.posX) ? s.posX : 0;
  if (!Number.isFinite(s.targetY)) s.targetY = Number.isFinite(s.posY) ? s.posY : 0;
  if (!Number.isFinite(s.posX)) s.posX = s.targetX;
  if (!Number.isFinite(s.posY)) s.posY = s.targetY;
  if (!Number.isFinite(s.velX)) s.velX = 0;
  if (!Number.isFinite(s.velY)) s.velY = 0;
};
