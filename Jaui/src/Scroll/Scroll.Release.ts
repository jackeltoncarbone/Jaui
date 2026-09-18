/**
 * Scroll.Release — the flick model, as a pure function.
 *
 * A release velocity cannot be tested on a device by anyone in this loop, so it
 * does not live inside the manager's gesture state where only a finger can reach
 * it. Give it a sample stream, get back px/s. A synthetic stream has a known
 * right answer, so the model can be pinned by arithmetic instead of impression.
 *
 * THE UNIT RULE, which is the whole point of this file: a sample carries a
 * DISTANCE and the DURATION over which that distance was travelled. Summing
 * distances gives a distance; it is a velocity only once divided by the elapsed
 * time those distances actually took. Pairing `dt` with `dx` on the sample makes
 * that pairing impossible to get wrong — you cannot admit a sample's distance to
 * the numerator without admitting its duration to the denominator.
 */

/** One drag sample: in-bounds content travel, and the interval it took. */
export interface ReleaseSample {
  /** Content travel during this sample's interval, px. Edge-clamped: overscroll
   *  stretch is the spring's business, not the fling's. */
  dx: number;
  dy: number;
  /** MEASURED duration of the interval that produced dx/dy, ms. Not the nominal
   *  frame time — a coalesced batch and a janked frame have very different real
   *  durations and the same nominal one. */
  dt: number;
  /** Event time at the END of that interval, ms. Main-thread event clock: the
   *  moment the finger was there, not the moment the worker heard about it. */
  t: number;
}

export interface ReleaseVelocity {
  /** px/s. */
  vx: number;
  vy: number;
}

const ZERO: ReleaseVelocity = { vx: 0, vy: 0 };

/** Drop samples whose interval ended before the trailing window opened.
 *  Mutates in place (oldest first), returns the array for chaining. */
export const PruneReleaseSamples = (
  samples: ReleaseSample[],
  nowMs: number,
  windowMs: number,
): ReleaseSample[] => {
  const cutoff = nowMs - windowMs;
  let drop = 0;
  while (drop < samples.length && samples[drop].t < cutoff) drop++;
  if (drop > 0) samples.splice(0, drop);
  return samples;
};

/**
 * Release velocity from the trailing window, px/s.
 *
 * Numerator: the distance the surviving samples travelled.
 * Denominator: the time those same samples took (Σ dt), plus the quiet tail
 * between the last sample and lift-off.
 *
 * The tail is deliberate and predates this file: a finger that stops moving and
 * then lifts has a long tail, which stretches the denominator and kills the
 * fling — which is what should happen. The Σ dt is the correction. The previous
 * model used `releaseMs - samples[0].t` as the whole denominator, which counts
 * N samples' distance over N-1 samples' time: the oldest survivor's distance was
 * travelled BEFORE its own timestamp, so the interval that produced it sat
 * entirely outside the span. See Scroll.Release.test.ts for the size of that.
 *
 * A survivor whose interval straddles the cutoff contributes its whole distance
 * AND its whole duration, so the window is slightly wider than nominal but never
 * dimensionally wrong — which is the trade this file exists to make.
 *
 * Zero elapsed time yields zero velocity. That is a refusal, not a fallback: if
 * the clock says no time passed, there is no velocity to be had, and inventing
 * one is precisely the failure that launches a list to its bottom.
 */
export const ComputeReleaseVelocity = (
  samples: readonly ReleaseSample[],
  releaseMs: number,
  windowMs: number,
): ReleaseVelocity => {
  if (samples.length === 0) return ZERO;

  const cutoff = releaseMs - windowMs;
  let dx = 0, dy = 0, elapsedMs = 0, lastT = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.t < cutoff) continue;
    dx += s.dx;
    dy += s.dy;
    elapsedMs += Math.max(0, s.dt);
    lastT = s.t;
  }
  if (lastT === -Infinity) return ZERO;

  elapsedMs += Math.max(0, releaseMs - lastT);
  if (elapsedMs <= 0) return ZERO;

  const perSec = 1000 / elapsedMs;
  return { vx: dx * perSec, vy: dy * perSec };
};
