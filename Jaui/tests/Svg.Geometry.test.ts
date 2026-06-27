import { describe, it, expect } from 'vitest';
import { ParsePathData, ParseTransform } from '../src/Svg/Svg.Parse';
import { FlattenCubic } from '../src/Svg/Svg.Flatten';
import { TessellateFill } from '../src/Svg/Svg.Tessellate';
import { SVG_IDENTITY, SvgContour } from '../src/Svg/Svg.Types';

const TOL2 = 0.01;

function triArea(verts: Float32Array): number {
  // Sum unsigned area of all triangles with all-coverage-1 vertices (interior only).
  let area = 0;
  for (let i = 0; i + 8 < verts.length; i += 9) {
    if (verts[i + 2] !== 1 || verts[i + 5] !== 1 || verts[i + 8] !== 1) continue; // skip skirt
    const ax = verts[i], ay = verts[i + 1], bx = verts[i + 3], by = verts[i + 4], cx = verts[i + 6], cy = verts[i + 7];
    area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return area;
}

describe('ParseTransform', () => {
  it('translate', () => expect(ParseTransform('translate(5 3)')).toEqual([1, 0, 0, 1, 5, 3]));
  it('scale uniform + non-uniform', () => {
    expect(ParseTransform('scale(2)')).toEqual([2, 0, 0, 2, 0, 0]);
    expect(ParseTransform('scale(2 3)')).toEqual([2, 0, 0, 3, 0, 0]);
  });
  it('rotate 90deg', () => {
    const m = ParseTransform('rotate(90)');
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[1]).toBeCloseTo(1, 6);
    expect(m[2]).toBeCloseTo(-1, 6);
    expect(m[3]).toBeCloseTo(0, 6);
  });
  it('composes left-to-right', () => {
    // translate then scale: a point (1,0) -> scale -> (2,0) -> translate -> (12, 0)
    const m = ParseTransform('translate(10 0) scale(2)');
    expect(m[4]).toBe(10);
    expect(m[0]).toBe(2);
  });
  it('empty -> identity', () => expect(ParseTransform(null)).toEqual(SVG_IDENTITY));
});

describe('ParsePathData', () => {
  it('M/L/Z triangle -> one closed contour', () => {
    const out: SvgContour[] = [];
    ParsePathData('M0 0 L10 0 L10 10 Z', SVG_IDENTITY, TOL2, out);
    expect(out.length).toBe(1);
    expect(out[0].Closed).toBe(true);
    expect(out[0].Points).toEqual([0, 0, 10, 0, 10, 10]);
  });
  it('implicit lineto repeats after M', () => {
    const out: SvgContour[] = [];
    ParsePathData('M0 0 10 0 10 10', SVG_IDENTITY, TOL2, out);
    expect(out[0].Points).toEqual([0, 0, 10, 0, 10, 10]);
  });
  it('relative commands', () => {
    const out: SvgContour[] = [];
    ParsePathData('M5 5 l10 0 l0 10', SVG_IDENTITY, TOL2, out);
    expect(out[0].Points).toEqual([5, 5, 15, 5, 15, 15]);
  });
  it('cubic flattens to a polyline ending at the endpoint', () => {
    const out: SvgContour[] = [];
    ParsePathData('M0 0 C0 10 10 10 10 0', SVG_IDENTITY, TOL2, out);
    const p = out[0].Points;
    expect(p[0]).toBe(0); expect(p[1]).toBe(0);
    expect(p[p.length - 2]).toBeCloseTo(10, 6);
    expect(p[p.length - 1]).toBeCloseTo(0, 6);
    expect(p.length).toBeGreaterThan(6); // subdivided
  });
  it('transform is baked into points', () => {
    const out: SvgContour[] = [];
    ParsePathData('M0 0 L10 0', [2, 0, 0, 2, 5, 5], TOL2, out);
    expect(out[0].Points).toEqual([5, 5, 25, 5]);
  });
});

describe('FlattenCubic', () => {
  it('all points within tolerance of the true curve, monotone-ish', () => {
    const out = [0, 0];
    FlattenCubic(out, 0, 0, 0, 10, 10, 10, 10, 0, 0.01);
    expect(out.length).toBeGreaterThan(4);
    expect(out[out.length - 2]).toBeCloseTo(10, 6);
    expect(out[out.length - 1]).toBeCloseTo(0, 6);
  });
});

describe('TessellateFill', () => {
  it('square -> interior triangles cover the full area', () => {
    const sq: SvgContour = { Points: [0, 0, 10, 0, 10, 10, 0, 10], Closed: true };
    const mesh = TessellateFill([sq], 0);
    expect(triArea(mesh.Verts)).toBeCloseTo(100, 4);
  });
  it('skirt adds coverage-0 vertices around the boundary', () => {
    const sq: SvgContour = { Points: [0, 0, 10, 0, 10, 10, 0, 10], Closed: true };
    const noSkirt = TessellateFill([sq], 0).VertCount;
    const withSkirt = TessellateFill([sq], 1);
    expect(withSkirt.VertCount).toBeGreaterThan(noSkirt);
    let zeroCov = 0;
    for (let i = 0; i < withSkirt.Verts.length; i += 3) if (withSkirt.Verts[i + 2] === 0) zeroCov++;
    expect(zeroCov).toBeGreaterThan(0);
  });
  it('square with a hole punches out the counter (area = outer − hole)', () => {
    const outer: SvgContour = { Points: [0, 0, 10, 0, 10, 10, 0, 10], Closed: true };
    const hole: SvgContour = { Points: [3, 3, 3, 7, 7, 7, 7, 3], Closed: true }; // opposite winding
    const mesh = TessellateFill([outer, hole], 0);
    expect(triArea(mesh.Verts)).toBeCloseTo(84, 1); // 100 − 16
  });
  it('concave L-shape triangulates without leaving the polygon (area preserved)', () => {
    const lshape: SvgContour = { Points: [0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10], Closed: true };
    const mesh = TessellateFill([lshape], 0);
    // L area = 10*4 + 4*6 = 40 + 24 = 64
    expect(triArea(mesh.Verts)).toBeCloseTo(64, 3);
  });
});
