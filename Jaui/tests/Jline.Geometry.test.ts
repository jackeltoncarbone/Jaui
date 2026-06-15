import { describe, it, expect } from 'vitest';
import { BuildStrokeInstances, WriteStrokeInstances, STROKE_FLOATS_PER_SEGMENT, type StrokePoint } from '../src/Jline/Jline.Geometry';

// Field offsets within one 12-float segment instance.
const SEG = 0;      // a_Seg.xyzw  (Ax,Ay,Bx,By)
const MITER = 4;    // a_Miter.xyzw (mAx,mAy,mBx,mBy)
const ARC = 8;      // a_Arc.xyzw  (t0,t1,phase,0)

const seg = (d: Float32Array, i: number) => d.subarray(i * STROKE_FLOATS_PER_SEGMENT, (i + 1) * STROKE_FLOATS_PER_SEGMENT);

describe('BuildStrokeInstances', () => {
  it('returns no segments for < 2 points', () => {
    expect(BuildStrokeInstances([], 1).SegmentCount).toBe(0);
    expect(BuildStrokeInstances([[0, 0]], 1).SegmentCount).toBe(0);
  });

  it('emits one 12-float instance per segment', () => {
    const pts: StrokePoint[] = [[0, 0], [10, 0], [10, 10]];
    const { Data, SegmentCount } = BuildStrokeInstances(pts, 2);
    expect(SegmentCount).toBe(2);
    expect(Data.length).toBe(2 * STROKE_FLOATS_PER_SEGMENT);
  });

  it('packs the true segment endpoints into a_Seg', () => {
    const { Data } = BuildStrokeInstances([[0, 0], [10, 0]], 2);
    const s = seg(Data, 0);
    expect([s[SEG], s[SEG + 1], s[SEG + 2], s[SEG + 3]]).toEqual([0, 0, 10, 0]);
  });

  it('miter is the perpendicular at the line ends, scaled to halfExtent', () => {
    // Horizontal line: dir=(1,0) → normal=(0,1). End miter = (0, halfExtent).
    const halfExtent = 3;
    const { Data } = BuildStrokeInstances([[0, 0], [10, 0]], halfExtent);
    const s = seg(Data, 0);
    expect(s[MITER + 0]).toBeCloseTo(0, 5);
    expect(s[MITER + 1]).toBeCloseTo(halfExtent, 5);
    expect(s[MITER + 2]).toBeCloseTo(0, 5);
    expect(s[MITER + 3]).toBeCloseTo(halfExtent, 5);
  });

  it('TILES: a shared vertex has the identical miter vector in both adjacent segments (no overlap → no beading)', () => {
    const pts: StrokePoint[] = [[0, 0], [10, 0], [16, 8], [22, 8]];
    const { Data, SegmentCount } = BuildStrokeInstances(pts, 2.5);
    for (let k = 0; k < SegmentCount - 1; k++) {
      const a = seg(Data, k);       // its B-end miter = a_Miter.zw
      const b = seg(Data, k + 1);   // next segment's A-end miter = a_Miter.xy
      expect(a[MITER + 2]).toBeCloseTo(b[MITER + 0], 6);
      expect(a[MITER + 3]).toBeCloseTo(b[MITER + 1], 6);
      // ...and the shared point's coordinates match (B of k == A of k+1)
      expect(a[SEG + 2]).toBeCloseTo(b[SEG + 0], 6);
      expect(a[SEG + 3]).toBeCloseTo(b[SEG + 1], 6);
    }
  });

  it('a collinear interior vertex keeps a pure perpendicular miter (scale 1)', () => {
    const halfExtent = 4;
    const { Data } = BuildStrokeInstances([[0, 0], [5, 0], [10, 0]], halfExtent);
    const s0 = seg(Data, 0);
    // seg0 B-end miter is the shared middle vertex — collinear → perpendicular, magnitude == halfExtent
    const mag = Math.hypot(s0[MITER + 2], s0[MITER + 3]);
    expect(mag).toBeCloseTo(halfExtent, 5);
    expect(s0[MITER + 2]).toBeCloseTo(0, 5);   // perpendicular to horizontal → x≈0
  });

  it('a turn lengthens the miter (1/cos(half-angle)) but stays bounded by the clamp', () => {
    const halfExtent = 2;
    // right angle at the middle vertex → miter length = halfExtent / cos(45°) ≈ halfExtent * 1.414
    const { Data } = BuildStrokeInstances([[0, 0], [0, 10], [10, 10]], halfExtent);
    const s0 = seg(Data, 0);
    const mag = Math.hypot(s0[MITER + 2], s0[MITER + 3]);
    expect(mag).toBeCloseTo(halfExtent * Math.SQRT2, 4);
    // a near-180° fold must NOT blow up — clamp caps it at halfExtent / 0.3
    const sharp = BuildStrokeInstances([[0, 0], [10, 0], [0, 0.01]], halfExtent);
    const ms = seg(sharp.Data, 0);
    expect(Math.hypot(ms[MITER + 2], ms[MITER + 3])).toBeLessThanOrEqual(halfExtent / 0.3 + 1e-6);
  });

  it('arc fraction t is 0 at the start, 1 at the end, and monotonically increasing', () => {
    const pts: StrokePoint[] = [[0, 0], [10, 0], [10, 10], [20, 10]];
    const { Data, SegmentCount } = BuildStrokeInstances(pts, 1);
    expect(seg(Data, 0)[ARC + 0]).toBeCloseTo(0, 6);
    expect(seg(Data, SegmentCount - 1)[ARC + 1]).toBeCloseTo(1, 6);
    let prev = -1;
    for (let k = 0; k < SegmentCount; k++) {
      const s = seg(Data, k);
      expect(s[ARC + 0]).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(s[ARC + 1]).toBeGreaterThan(s[ARC + 0]);   // each segment advances
      // a segment's t1 equals the next segment's t0 (continuous arc)
      if (k < SegmentCount - 1) expect(s[ARC + 1]).toBeCloseTo(seg(Data, k + 1)[ARC + 0], 6);
      prev = s[ARC + 1];
    }
  });

  it('packs the per-line phase into a_Arc.z', () => {
    const { Data } = BuildStrokeInstances([[0, 0], [1, 0], [2, 0]], 1, 0.37);
    expect(seg(Data, 0)[ARC + 2]).toBeCloseTo(0.37, 6);
    expect(seg(Data, 1)[ARC + 2]).toBeCloseTo(0.37, 6);
  });

  it('reuses an oversized output buffer instead of allocating', () => {
    const out = new Float32Array(100);
    const { Data, SegmentCount } = BuildStrokeInstances([[0, 0], [1, 1]], 1, 0, out);
    expect(Data).toBe(out);
    expect(SegmentCount).toBe(1);
  });
});

describe('WriteStrokeInstances (zero-copy multi-line fill)', () => {
  it('packs several lines into ONE shared buffer at successive offsets (no intermediate copies)', () => {
    const lineA: StrokePoint[] = [[0, 0], [10, 0], [10, 10]];   // 2 segments
    const lineB: StrokePoint[] = [[0, 5], [5, 5]];              // 1 segment
    const total = (2 + 1) * STROKE_FLOATS_PER_SEGMENT;
    const out = new Float32Array(total);

    let off = WriteStrokeInstances(lineA, 2, 0.1, out, 0);
    expect(off).toBe(2 * STROKE_FLOATS_PER_SEGMENT);
    off = WriteStrokeInstances(lineB, 2, 0.7, out, off);
    expect(off).toBe(total);

    // lineA's first segment endpoints landed at offset 0
    expect([out[0], out[1], out[2], out[3]]).toEqual([0, 0, 10, 0]);
    // lineB's segment landed right after lineA (offset 24), with its own phase in a_Arc.z
    const bBase = 2 * STROKE_FLOATS_PER_SEGMENT;
    expect([out[bBase + 0], out[bBase + 1], out[bBase + 2], out[bBase + 3]]).toEqual([0, 5, 5, 5]);
    expect(out[bBase + 10]).toBeCloseTo(0.7, 6);   // a_Arc.z = phase
    expect(out[10]).toBeCloseTo(0.1, 6);            // lineA's phase, untouched
  });

  it('matches BuildStrokeInstances for a single line written at offset 0', () => {
    const pts: StrokePoint[] = [[0, 0], [8, 2], [12, 9]];
    const built = BuildStrokeInstances(pts, 3, 0.25);
    const out = new Float32Array(built.SegmentCount * STROKE_FLOATS_PER_SEGMENT);
    WriteStrokeInstances(pts, 3, 0.25, out, 0);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(built.Data[i], 5);
  });

  it('throws if the buffer cannot hold the line (no silent overrun)', () => {
    const out = new Float32Array(STROKE_FLOATS_PER_SEGMENT); // room for 1 segment
    expect(() => WriteStrokeInstances([[0, 0], [1, 0], [2, 0]], 1, 0, out, 0)).toThrow(RangeError);
  });

  it('is a no-op (returns the offset unchanged) for < 2 points', () => {
    const out = new Float32Array(50);
    expect(WriteStrokeInstances([[0, 0]], 1, 0, out, 12)).toBe(12);
  });

  it('honors pointCount — reads a prefix of an oversized (reused) scratch, zero-alloc', () => {
    // scratch has 4 slots but only the first 2 are this frame's path → 1 segment.
    const scratch: StrokePoint[] = [[0, 0], [10, 0], [999, 999], [888, 888]];
    const out = new Float32Array(STROKE_FLOATS_PER_SEGMENT);
    const end = WriteStrokeInstances(scratch, 2, 0, out, 0, 'arc', 2);
    expect(end).toBe(STROKE_FLOATS_PER_SEGMENT);          // exactly 1 segment, stale tail ignored
    expect([out[0], out[1], out[2], out[3]]).toEqual([0, 0, 10, 0]);
  });
});

describe("'index' parameterization (the comet's time/beat sampling)", () => {
  // Points unevenly spaced in DISTANCE but evenly spaced in TIME (one per beat). 'index' must give
  // t = i/(n-1) regardless of segment length — so the head at t=progress tracks the marcher under
  // non-uniform footwork speed. 'arc' would (wrongly, for a comet) bias t toward the long segments.
  const pts: StrokePoint[] = [[0, 0], [1, 0], [11, 0], [12, 0]];  // seg lengths 1, 10, 1

  it("'index' assigns t = i/(n-1), independent of segment lengths", () => {
    const { Data, SegmentCount } = BuildStrokeInstances(pts, 1, 0, undefined, 'index');
    expect(SegmentCount).toBe(3);
    // t0/t1 per segment should be 0,1/3,2/3,1 — even thirds
    expect(seg(Data, 0)[ARC + 0]).toBeCloseTo(0, 6);
    expect(seg(Data, 0)[ARC + 1]).toBeCloseTo(1 / 3, 6);
    expect(seg(Data, 1)[ARC + 0]).toBeCloseTo(1 / 3, 6);
    expect(seg(Data, 1)[ARC + 1]).toBeCloseTo(2 / 3, 6);
    expect(seg(Data, 2)[ARC + 1]).toBeCloseTo(1, 6);
  });

  it("'arc' (default) instead weights t by distance — the long middle segment dominates", () => {
    const { Data } = BuildStrokeInstances(pts, 1);   // default 'arc'
    // total length 12; after seg0 (len1) t=1/12; after seg1 (len10) t=11/12
    expect(seg(Data, 0)[ARC + 1]).toBeCloseTo(1 / 12, 6);
    expect(seg(Data, 1)[ARC + 1]).toBeCloseTo(11 / 12, 6);
  });
});
