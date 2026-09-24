import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContinuousCorner } from '../src/Jiv/Corner.Continuous';

/**
 * THE CORNER IS APPLE'S (Jwift/Apple/LiquidGlass.md 10): SwiftUI RenderBox's `add_rounded_rect`. Each corner is
 * three cubics; the lead-in on each edge follows that edge's room t, lead 1 + 0.528665 t, control points
 * 0.96 + 0.12849 t and 0.82 + 0.048407 t, and the middle cubic is fixed. These tests evaluate Apple's cubics
 * with Apple's literals, independently of the implementation, and hold the CPU field and the shader to them.
 */
type P = [number, number];
const MID: P[] = [[0.631493986, 0.0749114007], [0.372824013, 0.169060007], [0.169060007, 0.372824013], [0.0749114007, 0.631493986]];
const room = (side: number, rSum: number): number => Math.min(Math.max((side - rSum) / (rSum * 0.52866), 0), 1);
const bez = (a: P, b: P, c: P, d: P, t: number): P => {
  const u = 1 - t;
  return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
          u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]];
};

/** Apple's top-right corner of a w x h box centred on the origin, radius r on every corner, as points. */
const appleCorner = (w: number, h: number, r: number): P[] => {
  r = Math.min(r, w / 2, h / 2);
  const tt = room(w, 2 * r), ts = room(h, 2 * r);
  const top = [1 + 0.528665 * tt, 0.96 + 0.12849003 * tt, 0.82 + 0.048407 * tt];
  const side = [1 + 0.528665 * ts, 0.96 + 0.12849003 * ts, 0.82 + 0.048407 * ts];
  // (u along the top edge from the vertex, v down the side) -> the shape's frame (x right, y down).
  const at = ([u, v]: P): P => [w / 2 - u * r, -h / 2 + v * r];
  const segs: P[][] = [
    [[top[0], 0], [top[1], 0], [top[2], 0], MID[0]],
    [MID[0], MID[1], MID[2], MID[3]],
    [MID[3], [0, side[2]], [0, side[1]], [0, side[0]]],
  ];
  const out: P[] = [];
  for (const [a, b, c, d] of segs) for (let i = 0; i <= 64; i++) out.push(at(bez(a, b, c, d, i / 64)));
  return out;
};

describe("the corner is Apple's construction", () => {
  const shapes: [number, number, number][] = [[300, 300, 40], [300, 120, 60], [300, 100, 50], [100, 100, 50], [200, 60, 30], [200, 90, 30], [80, 44, 22]];
  for (const [w, h, r] of shapes) {
    it(`${w} x ${h}, r ${r}: every point of Apple's curve lies on the field's zero line`, () => {
      for (const [x, y] of appleCorner(w, h, r)) {
        expect(Math.abs(ContinuousCorner(x, y, w / 2, h / 2, [r, r, r, r], 1))).toBeLessThan(0.001 * r);
      }
    });
  }
  it('with room the curve leaves each edge 1.528665 r from the vertex; a capsule leaves its short edge at r', () => {
    const w = 400, h = 100, r = 20;
    expect(Math.abs(ContinuousCorner(w / 2 - 1.528665 * r, -h / 2, w / 2, h / 2, [r, r, r, r], 1))).toBeLessThan(1e-6);
    const cap = 50;
    expect(Math.abs(ContinuousCorner(w / 2, -h / 2 + cap, w / 2, h / 2, [cap, cap, cap, cap], 1))).toBeLessThan(1e-6);
  });
  it('smoothing 0 is the circular corner', () => {
    const w = 200, h = 100, r = 30, a = Math.PI / 4;
    const x = w / 2 - r + r * Math.cos(a), y = -h / 2 + r - r * Math.sin(a);
    expect(Math.abs(ContinuousCorner(x, y, w / 2, h / 2, [r, r, r, r], 0))).toBeLessThan(1e-9);
  });
  it("the shader carries Apple's literals, the same as the CPU copy", () => {
    const glsl = readFileSync(join(__dirname, '../src/Jiv/Shaders/Corner.Continuous.glsl'), 'utf8');
    for (const k of ['0.528665', '0.12849003', '0.048407', '0.96', '0.82', '0.52866', '0.631493986', '0.0749114007', '0.372824013', '0.169060007']) {
      expect(glsl).toContain(k);
    }
  });
});
