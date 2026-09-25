/**
 * `PerfLevers.DamageRegions` -- AN AWAKE FRAME REDRAWS ONLY WHAT CHANGED.
 *
 * Pure bookkeeping, no GL, so the rect arithmetic is unit-tested without the renderer (the reason
 * `Blur.Cache` and `Occlusion` are modules of their own).
 *
 * The scene target persists across frames. A partial frame scissors every scene draw to ONE device
 * rect `P`, clears it to the ground and redraws the whole walk inside it; outside `P` the target keeps
 * the last presented frame. The frame is EXACT when both hold:
 *
 *   1. nothing outside `P` changed. `P` is chosen before the walk, from last frame's damage, so it is a
 *      prediction; the paint ledger's damage region (`Blur.Cache`), closed after the walk, is the check.
 *   2. everything inside `P` is what a whole redraw gives. A draw that reads no texture is local. A draw
 *      that reads the scene (a pyramid build, a snapshot, a shadow probe) is exact when its read rect
 *      lies inside `P`, since every pixel there was cleared and redrawn in order this frame; a read that
 *      misses `P` entirely sees last frame's pixels and TAINTS what it produced, which is fine only
 *      while nothing drawn inside `P` consumes it. A cache hit reads nothing and is exact anywhere.
 *
 * A frame that fails either is thrown away before its present and redrawn whole in the same tick, and
 * next frame's prediction grows by what it learned. So no frame is ever shown that a whole redraw would
 * not have produced.
 */
import { type PixelRect, PixelRectArea } from './Occlusion';

/** How far past last frame's damage the prediction reaches, in device px: a spring's next step lands
 *  within it, so a fill that grows a few pixels a frame keeps predicting right. */
export const DAMAGE_PREDICT_MARGIN_PX = 16;

/** How far past its region a pyramid build may read the scene, in device px. The paint ledger's own
 *  guard is 8; this is its eight-fold, since claiming too much only costs a whole redraw. */
export const DAMAGE_BLUR_READ_GUARD_PX = 64;

/** A predicted rect past this share of the canvas renders whole: the scissor saves little there, and
 *  a whole frame is the one that can never be wrong. */
export const DAMAGE_MAX_SHARE = 0.75;

/** Frames a thrown-away partial frame waits before the next attempt, doubling per miss up to the max. */
export const DAMAGE_BACKOFF_MIN = 2;
export const DAMAGE_BACKOFF_MAX = 64;

/** One scene read of a frame: the device rect it sampled, the union of the scene draws that consumed
 *  what it produced (null while nothing has), and whether it lay inside the frame's redraw rect. */
export interface DamageRead {
  Read: PixelRect;
  Uses: PixelRect | null;
  Held: boolean;
}

export const RectMeets = (a: PixelRect, b: PixelRect): boolean =>
  a.X0 < b.X1 && b.X0 < a.X1 && a.Y0 < b.Y1 && b.Y0 < a.Y1;

export const RectHolds = (outer: PixelRect, inner: PixelRect): boolean =>
  inner.X1 <= inner.X0 || inner.Y1 <= inner.Y0
  || (inner.X0 >= outer.X0 && inner.Y0 >= outer.Y0 && inner.X1 <= outer.X1 && inner.Y1 <= outer.Y1);

export const RectJoin = (a: PixelRect | null, b: PixelRect): PixelRect => a === null ? { ...b } : {
  X0: Math.min(a.X0, b.X0), Y0: Math.min(a.Y0, b.Y0), X1: Math.max(a.X1, b.X1), Y1: Math.max(a.Y1, b.Y1),
};

/** A fractional device rect, rounded outward and clamped to the canvas. */
export const RectClamp = (x0: number, y0: number, x1: number, y1: number, w: number, h: number): PixelRect => ({
  X0: Math.max(0, Math.floor(x0)), Y0: Math.max(0, Math.floor(y0)),
  X1: Math.min(w, Math.ceil(x1)), Y1: Math.min(h, Math.ceil(y1)),
});

/**
 * Why the partial frame's reads cannot stand, or '' when they can: a read outside the rect that saw
 * something change. What can change is the ledger's damage and whatever the reads inside the rect
 * drew, since those are redrawn from this frame's pixels. (A read outside the rect whose output landed
 * inside it, and one inside whose output landed outside, were refused as they drew.)
 */
export const DamageStale = (pieces: readonly PixelRect[], reads: readonly DamageRead[]): string => {
  for (const rd of reads) {
    if (rd.Held) continue;
    for (const c of pieces) if (RectMeets(rd.Read, c)) return 'stale';
    for (const other of reads) if (other.Held && other.Uses !== null && RectMeets(rd.Read, other.Uses)) return 'stale';
  }
  return '';
};

/**
 * The rect to redraw this frame, or null for a whole frame.
 *
 * Last frame's damage, grown by the margin, then CLOSED over last frame's reads the way `DamageStale`
 * and the draw-time refusals will judge them: a read that would see a change, or whose output would
 * land in the rect, joins it with its output; a read the rect already holds brings its output in. Null
 * when there is nothing to predict from (the first frame after a rest, or a frame the ledger called
 * entirely dirty) or when the closed rect is too large to be worth it.
 */
export const PredictDamage = (
  pieces: readonly PixelRect[], reads: readonly DamageRead[], w: number, h: number,
): PixelRect | null => {
  if (pieces.length === 0 || w <= 0 || h <= 0) return null;
  const m = DAMAGE_PREDICT_MARGIN_PX;
  const grown = pieces.map((r) => RectClamp(r.X0 - m, r.Y0 - m, r.X1 + m, r.Y1 + m, w, h));
  let p: PixelRect | null = null;
  for (const r of grown) p = RectJoin(p, r);
  for (let moved = true; moved;) {
    moved = false;
    const changed: PixelRect[] = [...grown];
    for (const rd of reads) if (rd.Uses !== null && RectHolds(p!, rd.Read)) changed.push(rd.Uses);
    for (const rd of reads) {
      const touch = rd.Uses === null ? rd.Read : RectJoin(rd.Read, rd.Uses);
      if (RectHolds(p!, touch)) continue;
      const joins = RectHolds(p!, rd.Read)
        || (rd.Uses !== null && RectMeets(rd.Uses, p!))
        || changed.some((c) => RectMeets(rd.Read, c));
      if (joins) { p = RectJoin(p, touch); moved = true; }
    }
  }
  if (PixelRectArea(p!) > DAMAGE_MAX_SHARE * w * h) return null;
  return p;
};

/** Every piece of the frame's damage lies inside the redrawn rect. */
export const DamageHeld = (p: PixelRect, pieces: readonly PixelRect[]): boolean => {
  for (const r of pieces) if (!RectHolds(p, r)) return false;
  return true;
};
