/**
 * `?blur-cache` -- the pure half: the signature, the damage region, the paint ledger's verdicts and
 * the residency pick, each driven through the real module with no GL.
 *
 * The walk's half (which sites open records, which build is skipped, what verify binds) is
 * `Blur.Cache.Walk.test.ts`. Neither proves a texel: the verify arm on a GPU is the only thing that
 * can, and these files are what make a clean verify run mean something.
 */
import { describe, it, expect } from 'vitest';
import {
  Sig, DamageRegion, PaintLedger, PickEvictions, ChainBytesFor, GuardedRect, UnionRect,
  RECORD_NODE, RECORD_RIM, RECORD_JANVAS, READER_FILL, READER_PBLUR, DAMAGE_MAX_PIECES, BLUR_READ_GUARD_PX,
  type ReaderWhy,
} from '../src/Core/Blur.Cache';
import { RegionArea } from '../src/Core/Occlusion';

describe('Sig', () => {
  const of = (feed: (s: Sig) => void): [number, number] => { const s = new Sig(); feed(s); return [s.A, s.B]; };

  it('is a function of its words and nothing else', () => {
    const f = new Float32Array([1, 2.5, -3, 0.1]);
    expect(of((s) => s.Floats(f, 0, 4))).toEqual(of((s) => s.Floats(new Float32Array([1, 2.5, -3, 0.1]), 0, 4)));
  });

  it('one float one ulp away changes both lanes', () => {
    const a = new Float32Array([10, 20, 30]);
    const b = new Float32Array([10, 20, 30]);
    const u = new Uint32Array(b.buffer);
    u[1] += 1;
    const [a1, b1] = of((s) => s.Floats(a, 0, 3));
    const [a2, b2] = of((s) => s.Floats(b, 0, 3));
    expect(a1).not.toBe(a2);
    expect(b1).not.toBe(b2);
  });

  it('order matters, so a swap is a change', () => {
    expect(of((s) => { s.Word(1); s.Word(2); })).not.toEqual(of((s) => { s.Word(2); s.Word(1); }));
  });

  it('Number sees the full double: ids past 2^24 and fractions float32 would round together', () => {
    expect(of((s) => s.Number(16777217))).not.toEqual(of((s) => s.Number(16777216)));
    expect(of((s) => s.Number(0.1))).not.toEqual(of((s) => s.Number(Math.fround(0.1))));
  });
});

describe('DamageRegion', () => {
  it('starts empty and misses everything', () => {
    const d = new DamageRegion();
    d.Reset(100, 100);
    expect(d.Count).toBe(0);
    expect(d.Px).toBe(0);
    expect(d.Hits({ X0: 0, Y0: 0, X1: 100, Y1: 100 })).toBe(false);
  });

  it('rounds a footprint OUTWARD with a pixel of feather and clamps it to the canvas', () => {
    const d = new DamageRegion();
    d.Reset(100, 100);
    d.Add(10.5, 20.25, 30.5, 40.75);
    expect(d.Pieces).toEqual([{ X0: 9, Y0: 19, X1: 32, Y1: 42 }]);
    d.Reset(100, 100);
    d.Add(-50, -50, 5, 5);
    expect(d.Pieces).toEqual([{ X0: 0, Y0: 0, X1: 6, Y1: 6 }]);
  });

  it('keeps its pieces DISJOINT, so Px is an exact area and not a sum over overlaps', () => {
    const d = new DamageRegion();
    d.Reset(200, 200);
    d.Add(10, 10, 50, 50);
    d.Add(30, 30, 80, 80);
    d.Add(20, 20, 40, 40); // wholly inside the first
    for (let i = 0; i < d.Pieces.length; i++) {
      for (let j = i + 1; j < d.Pieces.length; j++) {
        const a = d.Pieces[i], b = d.Pieces[j];
        const overlap = a.X0 < b.X1 && b.X0 < a.X1 && a.Y0 < b.Y1 && b.Y0 < a.Y1;
        expect(overlap).toBe(false);
      }
    }
    // [9,51)^2 union [29,81)^2 = 42^2 + 52^2 - 22^2
    expect(d.Px).toBe(42 * 42 + 52 * 52 - 22 * 22);
    expect(d.Px).toBe(RegionArea(d.Pieces));
  });

  it('Hits is a strict overlap test: touching edges do not meet', () => {
    const d = new DamageRegion();
    d.Reset(200, 200);
    d.Add(11, 11, 19, 19); // -> [10, 20)
    expect(d.Hits({ X0: 20, Y0: 0, X1: 40, Y1: 40 })).toBe(false);
    expect(d.Hits({ X0: 19, Y0: 0, X1: 40, Y1: 40 })).toBe(true);
  });

  it('past maxPieces it gives up and is FULL, which hits everything and is always correct', () => {
    const d = new DamageRegion(4);
    d.Reset(1000, 1000);
    for (let i = 0; i < 5; i++) d.Add(i * 100 + 10, 10, i * 100 + 20, 20);
    expect(d.Full).toBe(true);
    expect(d.Count).toBe(1);
    expect(d.Px).toBe(1000 * 1000);
    expect(d.Hits({ X0: 900, Y0: 900, X1: 901, Y1: 901 })).toBe(true);
    expect(DAMAGE_MAX_PIECES).toBeGreaterThanOrEqual(8);
  });
});

// ── The ledger ────────────────────────────────────────────────────────────────────────────────

/** One scripted frame: records painted in order, each with a footprint and a content word, and
 *  readers placed between them. Returns every reader's verdict. */
interface Step {
  Rec?: { Owner: object; Kind?: number; Content: number; X0: number; Y0: number; X1: number; Y1: number; Fresh?: boolean; Hollow?: boolean };
  Read?: { Owner: object; Kind?: number; Key?: string; X0: number; Y0: number; X1: number; Y1: number };
}
const frame = (l: PaintLedger<string>, steps: Step[], seed = 1): ReaderWhy[] => {
  l.NewSeed().Number(seed);
  l.BeginFrame(1000, 1000);
  const out: ReaderWhy[] = [];
  for (const s of steps) {
    if (s.Rec) {
      const r = s.Rec;
      l.Open(r.Owner, r.Kind ?? RECORD_NODE);
      l.Sig.Number(r.Content);
      if (r.Fresh) l.Fresh('janvas');
      if (!r.Hollow) l.Extend(r.X0, r.Y0, r.X1, r.Y1);
      l.Close();
    } else if (s.Read) {
      const r = s.Read;
      l.Open(r.Owner, RECORD_NODE);
      const v = l.Reader(r.Owner, r.Kind ?? READER_FILL, r.Key ?? 'k', { X0: r.X0, Y0: r.Y0, X1: r.X1, Y1: r.Y1 });
      l.Sig.Number(v.Token);
      l.Extend(r.X0 + 10, r.Y0 + 10, r.X1 - 10, r.Y1 - 10);
      l.Close();
      out.push(v.Why);
    }
  }
  l.EndFrame(() => undefined);
  return out;
};

describe('PaintLedger -- what makes a reader clean', () => {
  const bed = {}, near = {}, far = {}, after = {}, glassA = {}, glassB = {}, extra = {};
  const scene = (o: { near?: number; far?: number; after?: number; extraFirst?: boolean; swap?: boolean } = {}): Step[] => {
    const nearRec: Step = { Rec: { Owner: near, Content: o.near ?? 1, X0: 100, Y0: 100, X1: 150, Y1: 150 } };
    const farRec: Step = { Rec: { Owner: far, Content: o.far ?? 1, X0: 800, Y0: 800, X1: 850, Y1: 850 } };
    return [
      ...(o.extraFirst ? [{ Rec: { Owner: extra, Content: 1, X0: 900, Y0: 10, X1: 950, Y1: 50 } } as Step] : []),
      { Rec: { Owner: bed, Content: 1, X0: 0, Y0: 0, X1: 1000, Y1: 1000 } },
      ...(o.swap ? [farRec, nearRec] : [nearRec, farRec]),
      { Read: { Owner: glassA, X0: 50, Y0: 50, X1: 300, Y1: 300 } },
      { Read: { Owner: glassB, X0: 500, Y0: 50, X1: 750, Y1: 300 } },
      { Rec: { Owner: after, Content: o.after ?? 1, X0: 60, Y0: 60, X1: 120, Y1: 120 } },
    ];
  };

  it('first sight is `first`; the same frame again is clean for everyone', () => {
    const l = new PaintLedger<string>();
    expect(frame(l, scene())).toEqual(['first', 'first']);
    expect(frame(l, scene())).toEqual(['clean', 'clean']);
    expect(l.Region.Count).toBe(0);
    expect(frame(l, scene())).toEqual(['clean', 'clean']);
  });

  it('a record that changed UNDER a reader dirties it -- and only it', () => {
    const l = new PaintLedger<string>();
    frame(l, scene());
    frame(l, scene());
    expect(frame(l, scene({ near: 2 }))).toEqual(['damage', 'clean']);
    expect(l.Stats.Changed).toBeGreaterThanOrEqual(1);
    // ...and it is clean again the frame after it stops changing.
    expect(frame(l, scene({ near: 2 }))).toEqual(['clean', 'clean']);
  });

  it('a change far from every reader dirties nobody (the video beside five static cards)', () => {
    const l = new PaintLedger<string>();
    frame(l, scene());
    for (let f = 2; f < 10; f++) expect(frame(l, scene({ far: f }))).toEqual(['clean', 'clean']);
    expect(l.Region.Px).toBeGreaterThan(0);
  });

  it('a change painted AFTER a reader is not in its backdrop', () => {
    const l = new PaintLedger<string>();
    frame(l, scene());
    expect(frame(l, scene({ after: 7 }))).toEqual(['clean', 'clean']);
  });

  it('content appearing BEFORE a reader is `prefix` for every reader after it, wherever it lands', () => {
    const l = new PaintLedger<string>();
    frame(l, scene());
    expect(frame(l, scene({ extraFirst: true }))).toEqual(['prefix', 'prefix']);
    // Gone again: the vanished record is caught the same way, not at the end of the walk.
    expect(frame(l, scene())).toEqual(['prefix', 'prefix']);
  });

  it('two records swapping paint order is `prefix`, even with identical content', () => {
    const l = new PaintLedger<string>();
    frame(l, scene());
    expect(frame(l, scene({ swap: true }))).toEqual(['prefix', 'prefix']);
  });

  it('a record that paints nothing is not in the prefix: an empty container coming and going is free', () => {
    const l = new PaintLedger<string>();
    const hollow: Step = { Rec: { Owner: {}, Content: 1, Hollow: true, X0: 0, Y0: 0, X1: 1000, Y1: 1000 } };
    frame(l, scene());
    expect(frame(l, [hollow, ...scene()])).toEqual(['clean', 'clean']);
    expect(frame(l, scene())).toEqual(['clean', 'clean']);
  });

  it('a changed build key is `key`; a frame skipped is `gap` and hands the slot back', () => {
    const l = new PaintLedger<string>();
    const released: string[] = [];
    frame(l, scene());
    // Give glassA a slot, then skip it for a frame.
    l.NewSeed().Number(1);
    l.BeginFrame(1000, 1000);
    l.Open(glassA, RECORD_NODE);
    const v = l.Reader(glassA, READER_FILL, 'k', { X0: 50, Y0: 50, X1: 300, Y1: 300 });
    v.State.Slot = 'slot-A';
    l.Close();
    l.EndFrame((s) => released.push(s));
    expect(released).toEqual([]);
    const without = scene().filter((s) => s.Read?.Owner !== glassA);
    l.NewSeed().Number(1);
    l.BeginFrame(1000, 1000);
    for (const s of without) {
      if (s.Rec) { l.Open(s.Rec.Owner, RECORD_NODE); l.Sig.Number(s.Rec.Content); l.Extend(s.Rec.X0, s.Rec.Y0, s.Rec.X1, s.Rec.Y1); l.Close(); }
    }
    l.EndFrame((s) => released.push(s));
    expect(released).toEqual(['slot-A']);
    // A reader not evaluated in a frame is forgotten, not kept: it can never be clean again.
    expect(frame(l, scene())).toEqual(['first', 'first']);
    const keyed = scene().map((s) => (s.Read?.Owner === glassA ? { Read: { ...s.Read, Key: 'other' } } : s));
    expect(frame(l, keyed)[0]).toBe('key');
  });

  it('a moved seed is the whole canvas: every reader is dirty', () => {
    const l = new PaintLedger<string>();
    frame(l, scene());
    frame(l, scene());
    expect(frame(l, scene(), 2)).toEqual(['prefix', 'prefix']);
    expect(l.Stats.Seeded).toBe(true);
  });

  it('GLASS OVER GLASS composes through the token: B over A is dirty exactly when A is', () => {
    const l = new PaintLedger<string>();
    const under = {};
    const stack = (content: number): Step[] => [
      { Rec: { Owner: bed, Content: 1, X0: 0, Y0: 0, X1: 1000, Y1: 1000 } },
      { Rec: { Owner: under, Content: content, X0: 100, Y0: 100, X1: 140, Y1: 140 } },
      { Read: { Owner: glassA, X0: 50, Y0: 50, X1: 300, Y1: 300 } },
      // B's sample rect meets A's footprint but NOT `under`.
      { Read: { Owner: glassB, X0: 250, Y0: 250, X1: 500, Y1: 500 } },
    ];
    frame(l, stack(1));
    expect(frame(l, stack(1))).toEqual(['clean', 'clean']);
    expect(frame(l, stack(2))).toEqual(['damage', 'damage']);
    expect(frame(l, stack(2))).toEqual(['clean', 'clean']);
  });

  it('a FRESH record (a janvas) is damage every frame over its own footprint and nowhere else', () => {
    const l = new PaintLedger<string>();
    const janvas = {};
    const withField = (): Step[] => [
      { Rec: { Owner: janvas, Kind: RECORD_JANVAS, Content: 1, Fresh: true, X0: 0, Y0: 0, X1: 400, Y1: 400 } },
      { Read: { Owner: glassA, X0: 300, Y0: 300, X1: 500, Y1: 500 } },
      { Read: { Owner: glassB, X0: 600, Y0: 600, X1: 900, Y1: 900 } },
    ];
    frame(l, withField());
    for (let f = 0; f < 3; f++) {
      expect(frame(l, withField())).toEqual(['damage', 'clean']);
      expect(l.Stats.Fresh.janvas).toBe(1);
    }
  });

  it('RECORD_RIM is its own record: a node\'s rim and its fill never collide as a duplicate', () => {
    const l = new PaintLedger<string>();
    const n = {};
    l.NewSeed().Number(1);
    l.BeginFrame(100, 100);
    l.Open(n, RECORD_NODE); l.Extend(0, 0, 10, 10); l.Close();
    l.Open(n, RECORD_RIM); l.Extend(0, 0, 10, 10); l.Close();
    expect(l.Stats.Duplicate).toBe(0);
    l.Open(n, RECORD_NODE); l.Extend(0, 0, 10, 10); l.Close();
    expect(l.Stats.Duplicate).toBe(1);
    expect(l.Region.Full).toBe(true);
    l.EndFrame(() => undefined);
  });

  it('a push with no record open calls the frame FULL rather than slipping past', () => {
    const l = new PaintLedger<string>();
    l.NewSeed().Number(1);
    l.BeginFrame(100, 100);
    l.NoteUntracked();
    expect(l.Region.Full).toBe(true);
    expect(l.Stats.Untracked).toBe(1);
    l.EndFrame(() => undefined);
  });

  it('refuses to nest or to end the frame with a record open', () => {
    const l = new PaintLedger<string>();
    l.NewSeed().Number(1);
    l.BeginFrame(100, 100);
    l.Open({}, RECORD_NODE);
    expect(() => l.Open({}, RECORD_NODE)).toThrow(/inside another/);
    expect(() => l.EndFrame(() => undefined)).toThrow(/record open/);
  });

  it('TokenOf is the reader\'s token this frame, and fresh for one not evaluated', () => {
    const l = new PaintLedger<string>();
    const n = {};
    frame(l, [{ Read: { Owner: n, X0: 0, Y0: 0, X1: 10, Y1: 10 } }]);
    l.NewSeed().Number(1);
    l.BeginFrame(1000, 1000);
    l.Open(n, RECORD_NODE);
    const v = l.Reader(n, READER_FILL, 'k', { X0: 0, Y0: 0, X1: 10, Y1: 10 });
    l.Close();
    expect(v.Why).toBe('clean');
    expect(l.TokenOf(n, READER_FILL)).toBe(v.Token);
    const other = l.TokenOf(n, READER_PBLUR);
    expect(other).not.toBe(v.Token);
    expect(l.TokenOf(n, READER_PBLUR)).not.toBe(other);
    l.EndFrame(() => undefined);
  });
});

describe('PickEvictions', () => {
  const slot = (bytes: number, last: number) => ({ Bytes: bytes, LastUse: last });

  it('evicts nothing when it fits', () => {
    expect(PickEvictions([slot(10, 1)], 10, 5, 100, 9)).toEqual([]);
  });

  it('evicts least-recently-used first, and only as many as it needs', () => {
    const a = slot(40, 3), b = slot(40, 1), c = slot(40, 2);
    expect(PickEvictions([a, b, c], 120, 30, 120, 9)).toEqual([b]);
    expect(PickEvictions([a, b, c], 120, 60, 120, 9)).toEqual([b, c]);
  });

  it('NEVER evicts a slot used this frame -- and refuses the store instead', () => {
    const live = slot(100, 9);
    expect(PickEvictions([live], 100, 10, 100, 9)).toBeNull();
    const old = slot(50, 2);
    expect(PickEvictions([live, old], 150, 10, 105, 9)).toBeNull();
    expect(PickEvictions([live, old], 150, 10, 110, 9)).toEqual([old]);
  });
});

describe('the small helpers', () => {
  it('ChainBytesFor halves with >> like Framebuffer.EnsureMipLevels', () => {
    expect(ChainBytesFor(568, 436, 1, 4)).toBe(568 * 436 * 4);
    expect(ChainBytesFor(568, 436, 3, 4)).toBe((568 * 436 + 284 * 218 + 142 * 109) * 4);
    expect(ChainBytesFor(3, 1, 3, 8)).toBe((3 + 1 + 1) * 8);
  });

  it('GuardedRect grows a y-down rect by the guard on every side; UnionRect bounds both', () => {
    expect(GuardedRect(10.5, 20, 30, 40.2, BLUR_READ_GUARD_PX)).toEqual({ X0: 2, Y0: 12, X1: 49, Y1: 69 });
    expect(UnionRect({ X0: 0, Y0: 5, X1: 10, Y1: 10 }, { X0: 3, Y0: 0, X1: 20, Y1: 8 })).toEqual({ X0: 0, Y0: 0, X1: 20, Y1: 10 });
  });
});
