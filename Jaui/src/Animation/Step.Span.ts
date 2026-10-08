/**
 * HOW MUCH WALL TIME ONE TICK STEPS THE SPRINGS THROUGH. `Jaui._tickInner` steps every spring through the time the
 * frame actually covered, in substeps, so an animation keeps real time on a slow device; a tab back from the background
 * reports seconds, and the budget bounds the catch up rather than simulating the whole absence.
 *
 * A MORPH IS THE EXCEPTION (`Element.MorphFrom`, Drill Sentences lane WW1). The tick that starts one draws its first
 * state, the box at the control it grows out of, and that frame is often the slowest of the open: the new panel's glass,
 * its backdrop and its rows' glyphs are all drawn for the first time. Stepped through the whole of it, the next frame
 * found the box most of the way to its end, and a slow renderer (a phone, a software GPU) drew the start and then the
 * end, never the growth between. The tick after a morph begins steps one display frame, so the growth starts from its
 * own first frame and runs its whole length in what follows.
 */

/** The most wall time one tick steps the springs through (in 33ms substeps). */
export const STEP_BUDGET_S = 0.25;
/** What the tick after a morph begins steps: one 60Hz frame. */
export const MORPH_FIRST_STEP_S = 1 / 60;

/** The time this tick steps its springs through, from the wall time its frame covered and whether a morph began in the
 *  tick before it. */
export const StepSpan = (elapsed: number, morphBegan: boolean): number =>
  Math.min(Math.max(0, elapsed), morphBegan ? MORPH_FIRST_STEP_S : STEP_BUDGET_S);
