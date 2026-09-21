/**
 * DID THE PROBE'S STATE TEXEL MOVE THIS FRAME? The declaration `?blur-cache` needs from the adaptive
 * shadow, which until now was "always": `Fresh {shadow: 20}` on glass-grid, every frame, so the cache
 * could hit once in twenty and never rested.
 *
 * Pure, no GL, so it can be tested without the renderer. The renderer keeps one `Gap` per slot and
 * calls this once per probe write.
 *
 * ── WHAT THE GPU DOES, AND WHAT THE CPU CAN KNOW ────────────────────────────────────────────────────
 *
 * Each probe writes `stored' = round(stored + e (reading - stored))` into a 10-bit texel (hardware blend
 * with constant alpha e; e = 1 on a fresh slot and on the snap). The CPU never sees `reading` or
 * `stored`. What it can know is whether the reading is the SAME as last frame's: the probe is a pure
 * function of its rect, its detail LOD, its pyramid and the sharp scene under the rect, and when the
 * blur cache has just called that surface's fill reader `clean` (same build key, same prefix, no damage
 * over the guarded region, which contains the rect), all four are what they were.
 *
 * So the CPU tracks a BOUND, `Gap`, on |reading - stored| in LSBs, and the write moves the code only if
 * the ease step can reach half an LSB (round to nearest: `stored + e d` rounds to `stored + round(e d)`):
 *
 *   inputs changed        Gap = 1023 (anything)                            -> moved iff e * 1023 >= 0.5
 *   a whole write (e = 1) stored = round(reading), Gap = 0.5            -> moved unless the inputs were
 *                                                                         the same AND Gap was already 0.5
 *   an ease step          still if e * Gap < 0.5, or if e <= `Frozen`; otherwise it may move, and
 *                           if it moved, |d'| = |d| - round(e|d|) <= min(Gap - 1, (1 - e) Gap + 0.5),
 *                             and never below the half-LSB an overshoot can leave;
 *                           if it did not, |d| < 0.5 / e.
 *
 * `Frozen` is the largest ease under which the stored code is PROVEN not to move: a code that did not
 * move at ease e stays put at every ease up to e, and so does one that moved to within 0.5 / e. It is
 * what lets a steady cadence rest -- without it the bound sits exactly on 0.5 / e and every frame is a
 * tie -- and it is why a frame-time spike (a larger e) is honestly declared moved: at a larger ease the
 * same stuck texel can take one more step, and sometimes does.
 *
 * The code moves toward the reading monotonically and by at least one LSB whenever it moves, so the
 * bound reaches 0.5 / e in a bounded number of frames and the texel is then declared still -- and is.
 * It is SOUND, not exact: a texel declared moved may not have moved (a lost hit), a texel declared still
 * cannot have (a stale pixel). Two assumptions, stated: the unorm store rounds to nearest (D3D11 and
 * Metal require it; GLES permits either neighbour), and the blend runs at no less than the texel's
 * precision. `?blur-cache=verify` is the check that fails if either is false on some GPU.
 */

/** Bound on |reading - stored| after a write whose reading nothing constrains: the whole 10-bit range. */
export const SHADOW_TEXEL_UNKNOWN_GAP = 1023;

export interface ShadowTexelWrite {
  /** The code may have changed. */
  Moved: boolean;
  /** Bound on |reading - stored| after the write, in LSBs. */
  Gap: number;
  /** The largest ease under which the code is proven not to move, 0 when nothing is proven. */
  Frozen: number;
}

/** One probe write. `gap` / `frozen` are the slot's state going in (ignored on a fresh slot); `ease` the
 *  blend share (1 for a whole write); `inputsSame` whether the reading is provably last frame's. */
export const ShadowTexelStep = (
  fresh: boolean, gap: number, frozen: number, ease: number, inputsSame: boolean,
): ShadowTexelWrite => {
  if (fresh) return { Moved: true, Gap: 0.5, Frozen: 0 };
  const g = inputsSame ? gap : SHADOW_TEXEL_UNKNOWN_GAP;
  const f = inputsSame ? frozen : 0;
  if (ease >= 1) return { Moved: !(inputsSame && gap <= 0.5), Gap: 0.5, Frozen: 0 };
  if (!(ease * g >= 0.5) || ease <= f) return { Moved: false, Gap: g, Frozen: f };
  const ifMoved = Math.max(0.5, Math.min(g - 1, (1 - ease) * g + 0.5));
  const ifStill = Math.min(g, 0.5 / ease);
  return { Moved: true, Gap: Math.max(ifMoved, ifStill), Frozen: ease * ifMoved < 0.5 ? ease : 0 };
};
