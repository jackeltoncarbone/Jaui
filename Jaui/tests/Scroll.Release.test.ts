import { describe, it, expect } from 'vitest';
import {
  ComputeReleaseVelocity,
  PruneReleaseSamples,
  type ReleaseSample,
} from '../src/Scroll/Scroll.Release';

// Nobody in this loop has an iPhone. So the flick model is pinned here instead,
// where a synthetic finger has an answer you can work out on paper.
//
// Jack, on an iPhone: "whenever I flick my finger ... it goes really fast and
// jumps to like the bottom of the page." A release velocity wrong by a large
// factor produces exactly that, so these tests are about the FACTOR.

const WINDOW = 50;

/** The brief's finger: a constant 800 px/s for 300 ms, then a linear decel to
 *  0 over the next 100 ms, then lift. Returns travel in px at `ms`. */
const fingerAt = (ms: number): number => {
  if (ms <= 300) return 0.8 * ms;
  const u = (ms - 300) / 1000;         // seconds into the decel
  return 240 + 800 * u - 4000 * u * u; // the integral of (800 - 8000u) du
};

/** Sample a finger at a fixed rate into the stream the manager would record:
 *  each sample is the travel since the previous one, paired with how long that
 *  took. A final sample always lands exactly on `untilMs` — that is the lift,
 *  which carries a position of its own and which the drag wiring now feeds in
 *  as a move before ending the drag. */
const sampleFinger = (
  posAt: (ms: number) => number,
  periodMs: number,
  untilMs: number,
): ReleaseSample[] => {
  const out: ReleaseSample[] = [];
  let prev = 0;
  for (let t = periodMs; t < untilMs - 1e-9; t += periodMs) {
    out.push({ dx: 0, dy: posAt(t) - posAt(prev), dt: t - prev, t });
    prev = t;
  }
  out.push({ dx: 0, dy: posAt(untilMs) - posAt(prev), dt: untilMs - prev, t: untilMs });
  return out;
};

/** The model as it was written before this lane: sum the window's distance, and
 *  divide by (release - oldest survivor's timestamp). Kept here as the thing
 *  under comparison, so the reported factor is derived, not remembered. */
const legacyVelocity = (
  samples: readonly ReleaseSample[],
  releaseMs: number,
  windowMs: number,
): number => {
  const kept = samples.filter(s => s.t >= releaseMs - windowMs);
  if (kept.length === 0) return 0;
  const dy = kept.reduce((a, s) => a + s.dy, 0);
  const span = (releaseMs - kept[0].t) / 1000;
  return span > 0 ? dy / span : 0;
};

/** True mean finger speed across the interval the surviving samples cover. */
const trueMeanOverSurvivors = (
  samples: readonly ReleaseSample[],
  releaseMs: number,
  windowMs: number,
  posAt: (ms: number) => number,
): number => {
  const kept = samples.filter(s => s.t >= releaseMs - windowMs);
  const startedAt = kept[0].t - kept[0].dt;
  const endedAt = kept[kept.length - 1].t;
  return (posAt(endedAt) - posAt(startedAt)) / ((endedAt - startedAt) / 1000);
};

describe('a sum of distances is not a velocity until it is divided by its own duration', () => {
  it('a steady 800 px/s finger releases at 800 px/s, whatever the sample rate', () => {
    // The "really unstable" complaint: the same finger must not release
    // differently on a 60 Hz phone and a 120 Hz one.
    for (const period of [8, 100 / 6, 16.667, 25, 50 / 3]) {
      const s = sampleFinger(t => 0.8 * t, period, 600);
      const { vy } = ComputeReleaseVelocity(s, 600, WINDOW);
      expect(vy).toBeCloseTo(800, 6);
    }
  });

  it('the old formula charged N samples of distance to N-1 samples of time', () => {
    // Every sample carries the distance travelled BEFORE its own timestamp, so
    // the oldest survivor's interval sat entirely outside `release - t[0]`.
    const rows: string[] = [];
    for (const period of [8, 100 / 6, 25]) {
      const s = sampleFinger(t => 0.8 * t, period, 600);
      const kept = s.filter(x => x.t >= 600 - WINDOW).length;
      const was = legacyVelocity(s, 600, WINDOW);
      const now = ComputeReleaseVelocity(s, 600, WINDOW).vy;
      rows.push(`${period.toFixed(2)}ms n=${kept} was=${was.toFixed(0)} now=${now.toFixed(0)} x${(was / now).toFixed(3)}`);
      expect(now).toBeCloseTo(800, 6);
      expect(was / now).toBeCloseTo(kept / (kept - 1), 6);
    }
    console.log('  steady-finger release, per sample period:\n   ' + rows.join('\n   '));
  });

  it('the brief decelerating finger: 800 px/s for 300 ms, decel to 0, lift', () => {
    const s = sampleFinger(fingerAt, 50 / 3, 400); // 60 Hz, lift on a sample
    const truth = trueMeanOverSurvivors(s, 400, WINDOW, fingerAt);
    const now = ComputeReleaseVelocity(s, 400, WINDOW).vy;
    const was = legacyVelocity(s, 400, WINDOW);
    console.log(`  decel stream: truth=${truth.toFixed(1)} now=${now.toFixed(1)} was=${was.toFixed(1)} (x${(was / now).toFixed(3)})`);

    // The model reports the finger's actual mean speed over the span it covers.
    expect(now).toBeCloseTo(truth, 6);
    // And it is nowhere near the 800 px/s the finger had already given up on.
    expect(now).toBeLessThan(300);
    // The old one was a third fast, on a gesture that had been DECELERATING.
    expect(was / now).toBeGreaterThan(1.3);
  });

  it('a slow lift lowers the release, it does not raise it', () => {
    const s = sampleFinger(t => 0.8 * t, 100 / 6, 600);
    const prompt = ComputeReleaseVelocity(s, 600, WINDOW).vy;
    const dawdled = ComputeReleaseVelocity(s, 615, WINDOW).vy;
    expect(dawdled).toBeLessThan(prompt);
    // The quiet tail is real time the finger did not move; it belongs in the
    // denominator, which is the one thing the old model got right.
    expect(dawdled).toBeGreaterThan(0);
    // And it is exactly the time that was added, nothing else: 50 ms of samples
    // stretched over 65 ms.
    expect(dawdled).toBeCloseTo(prompt * (50 / 65), 6);
  });

  it('a finger that stopped and rested releases nothing', () => {
    const s = sampleFinger(t => 0.8 * t, 100 / 6, 600);
    expect(ComputeReleaseVelocity(s, 900, WINDOW).vy).toBe(0);
    expect(ComputeReleaseVelocity([], 900, WINDOW).vy).toBe(0);
  });
});

describe('samples timed by arrival instead of by the finger', () => {
  // Bridge.Main batches pointer samples to the worker; getCoalescedEvents hands
  // over several points in one delivery. The drag wiring used to read the clock
  // once per sample INSIDE that loop, so a whole batch got one instant.
  const batchStampedOnArrival = (
    finger: readonly ReleaseSample[],
    arrivalMs: number,
  ): ReleaseSample[] => finger.map(s => ({ ...s, t: arrivalMs, dt: 0 }));

  it('a coalesced batch stamped at one instant reads as an enormous fling', () => {
    const finger = sampleFinger(t => 0.8 * t, 100 / 6, (100 / 6) * 4); // 4 samples
    expect(finger).toHaveLength(4);
    const arrival = 500;
    const asArrived = batchStampedOnArrival(finger, arrival);
    const release = arrival + 5; // 5 ms from last pointermove to pointerup

    const was = legacyVelocity(asArrived, release, WINDOW);
    console.log(`  arrival-stamped batch: was=${was.toFixed(0)} px/s for an 800 px/s finger (x${(was / 800).toFixed(1)})`);
    expect(was / 800).toBeGreaterThan(10);

    // Same finger, samples carrying their OWN times: the model is unmoved.
    expect(ComputeReleaseVelocity(finger, finger[finger.length - 1].t, WINDOW).vy)
      .toBeCloseTo(800, 6);
  });

  it('with no time between samples there is no velocity to report', () => {
    // The refusal case. Better a dead flick than an invented one.
    const stuck: ReleaseSample[] = [
      { dx: 0, dy: 40, dt: 0, t: 500 },
      { dx: 0, dy: 40, dt: 0, t: 500 },
    ];
    expect(ComputeReleaseVelocity(stuck, 500, WINDOW).vy).toBe(0);
  });
});

describe('pruning', () => {
  it('drops only what the window has left behind, oldest first', () => {
    const s = sampleFinger(t => 0.8 * t, 10, 100);
    PruneReleaseSamples(s, 100, WINDOW);
    expect(s.map(x => x.t)).toEqual([50, 60, 70, 80, 90, 100]);
  });

  it('keeps the buffer bounded across a long drag', () => {
    const s: ReleaseSample[] = [];
    for (let t = 10; t <= 10_000; t += 10) {
      s.push({ dx: 0, dy: 8, dt: 10, t });
      PruneReleaseSamples(s, t, WINDOW);
    }
    expect(s.length).toBeLessThanOrEqual(6);
  });
});
