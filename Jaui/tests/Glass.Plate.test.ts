import { describe, it, expect } from 'vitest';
import { GlassFaceExclusion, PLATE_PIECES_MAX, PlateSyncRects, type PlateRect } from '../src/Core/Glass.Plate';
import { ResolveStyle, SEED_CONTEXT } from '../src/Core/Style.Resolver';
import { DefaultJivStyle } from '../src/Jiv/Jiv.Defaults';

describe('GlassReads: what a glass face reads', () => {
  it('defaults to the content under every glass, and resolves Surface for glass that reads what it sits on', () => {
    expect(ResolveStyle({ ...DefaultJivStyle }, SEED_CONTEXT).GlassReads).toBe('Content');
    expect(ResolveStyle({ ...DefaultJivStyle, GlassReads: 'Surface' }, SEED_CONTEXT).GlassReads).toBe('Surface');
  });

  it('throws on anything else, by name', () => {
    expect(() => ResolveStyle({ ...DefaultJivStyle, GlassReads: 'Scene' }, SEED_CONTEXT)).toThrow(/GlassReads/);
  });
});

// Glass never samples glass: the plate a glass surface reads is the scene less every earlier glass face.

const area = (rs: readonly PlateRect[]): number => rs.reduce((s, r) => s + r.w * r.h, 0);
const covers = (rs: readonly PlateRect[], x: number, y: number): boolean => rs.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

describe('PlateSyncRects: the region less every earlier face, as disjoint rects', () => {
  it('no face: the whole region', () => {
    expect(PlateSyncRects({ x: 10, y: 20, w: 100, h: 50 }, [])).toEqual([{ x: 10, y: 20, w: 100, h: 50 }]);
  });

  it('a face inside the region: four pieces around it, exactly the region less the face', () => {
    const region = { x: 0, y: 0, w: 100, h: 100 };
    const face = { x: 30, y: 40, w: 20, h: 10 };
    const pieces = PlateSyncRects(region, [face]);
    expect(pieces.length).toBe(4);
    expect(area(pieces)).toBe(100 * 100 - 20 * 10);
    expect(covers(pieces, 35, 45)).toBe(false);
    expect(covers(pieces, 5, 5)).toBe(true);
    expect(covers(pieces, 55, 45)).toBe(true);
  });

  it('a face covering the region: nothing to take from the scene', () => {
    expect(PlateSyncRects({ x: 10, y: 10, w: 20, h: 20 }, [{ x: 0, y: 0, w: 100, h: 100 }])).toEqual([]);
  });

  it('two overlapping faces: the union is out, everything else in, no piece counted twice', () => {
    const region = { x: 0, y: 0, w: 200, h: 100 };
    const pieces = PlateSyncRects(region, [{ x: 20, y: 0, w: 60, h: 100 }, { x: 60, y: 20, w: 60, h: 40 }]);
    expect(area(pieces)).toBe(200 * 100 - 60 * 100 - 40 * 40);
    for (const [x, y] of [[25, 50], [70, 30], [110, 50]]) expect(covers(pieces, x, y)).toBe(false);
    for (const [x, y] of [[5, 5], [110, 80], [150, 30]]) expect(covers(pieces, x, y)).toBe(true);
  });

  it('never cut into more than its ceiling', () => {
    const faces = Array.from({ length: 60 }, (_, i) => ({ x: 3 * i + 1, y: (i % 7) * 13 + 1, w: 1, h: 1 }));
    expect(PlateSyncRects({ x: 0, y: 0, w: 400, h: 100 }, faces).length).toBeLessThanOrEqual(PLATE_PIECES_MAX);
  });
});

describe('GlassFaceExclusion: the face and its shadow, within what it synced', () => {
  it('grows the face by its shadow\'s reach and holds it to the synced region', () => {
    const face = { x: 100, y: 100, w: 50, h: 40 };
    expect(GlassFaceExclusion(face, 10, { x: 0, y: 0, w: 1000, h: 1000 })).toEqual({ x: 90, y: 90, w: 70, h: 60 });
    expect(GlassFaceExclusion(face, 10, { x: 95, y: 95, w: 1000, h: 1000 })).toEqual({ x: 95, y: 95, w: 65, h: 55 });
  });

  it('a face outside what it synced keeps nothing out', () => {
    expect(GlassFaceExclusion({ x: 0, y: 0, w: 5, h: 5 }, 0, { x: 50, y: 50, w: 10, h: 10 })).toBeNull();
  });
});
