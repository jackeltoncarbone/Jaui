import { describe, it, expect } from 'vitest';
import {
  MAT3_IDENTITY,
  mat3FromAffine,
  mat3Mul,
  mat3ApplyPoint,
  mat3Inverse,
  mat3InvApplyPoint,
  mat3IsAffine,
  mat3Project3D,
  type Project3DParams,
} from '../src/Transform/Mat3x3';
import type { Mat2x3 } from '../src/Transform/Mat2x3';
import { matApplyX, matApplyY } from '../src/Transform/Mat2x3';

describe('Mat3x3 — affine subset', () => {
  it('identity maps points unchanged', () => {
    expect(mat3ApplyPoint(MAT3_IDENTITY, 7, -3)).toEqual([7, -3]);
    expect(mat3IsAffine(MAT3_IDENTITY)).toBe(true);
  });

  it('mat3FromAffine reproduces the Mat2x3 mapping exactly', () => {
    const a: Mat2x3 = [1.5, 0.2, -0.3, 0.9, 40, 12]; // arbitrary affine
    const h = mat3FromAffine(a);
    expect(mat3IsAffine(h)).toBe(true);
    for (const [x, y] of [[0, 0], [10, 5], [-4, 8]] as const) {
      const [hx, hy] = mat3ApplyPoint(h, x, y);
      expect(hx).toBeCloseTo(matApplyX(a, x, y), 9);
      expect(hy).toBeCloseTo(matApplyY(a, x, y), 9);
    }
  });

  it('compose with identity is a no-op', () => {
    const a: Mat2x3 = [1.5, 0.2, -0.3, 0.9, 40, 12];
    const h = mat3FromAffine(a);
    const composed = mat3Mul(h, MAT3_IDENTITY);
    for (let k = 0; k < 9; k++) expect(composed[k]).toBeCloseTo(h[k], 9);
  });
});

describe('Mat3x3 — inverse round-trip (incl. perspective)', () => {
  const cases: Project3DParams[] = [
    { RotateXDeg: 35, RotateYDeg: 0, TranslateZ: 0, PivotX: 100, PivotY: 80, Perspective: 600, OriginX: 100, OriginY: 80 },
    { RotateXDeg: -20, RotateYDeg: 15, TranslateZ: 40, PivotX: 50, PivotY: 50, Perspective: 1000, OriginX: 60, OriginY: 40 },
  ];
  it('mat3InvApplyPoint undoes mat3ApplyPoint under perspective', () => {
    for (const p of cases) {
      const h = mat3Project3D(p);
      for (const [x, y] of [[10, 10], [120, 30], [70, 110]] as const) {
        const [sx, sy] = mat3ApplyPoint(h, x, y);
        const [bx, by] = mat3InvApplyPoint(h, sx, sy);
        expect(bx).toBeCloseTo(x, 6);
        expect(by).toBeCloseTo(y, 6);
      }
    }
  });
  it('inverse of inverse is the original (affine)', () => {
    const h = mat3FromAffine([1.2, 0.1, 0.05, 0.8, 5, 9]);
    const back = mat3Inverse(mat3Inverse(h));
    for (let k = 0; k < 9; k++) expect(back[k]).toBeCloseTo(h[k], 6);
  });
});

describe('mat3Project3D — flat-quad projection', () => {
  it('is identity when there is no 3D transform', () => {
    const h = mat3Project3D({ RotateXDeg: 0, RotateYDeg: 0, TranslateZ: 0, PivotX: 30, PivotY: 40, Perspective: 0, OriginX: 30, OriginY: 40 });
    expect(mat3ApplyPoint(h, 5, 9)).toEqual([5, 9]);
    expect(mat3ApplyPoint(h, -12, 100)).toEqual([-12, 100]);
  });

  it('leaves the vanishing point fixed under rotation', () => {
    // A point AT the origin/pivot projects to itself (no in-plane offset).
    const h = mat3Project3D({ RotateXDeg: 40, RotateYDeg: 0, TranslateZ: 0, PivotX: 100, PivotY: 80, Perspective: 800, OriginX: 100, OriginY: 80 });
    const [x, y] = mat3ApplyPoint(h, 100, 80);
    expect(x).toBeCloseTo(100, 6);
    expect(y).toBeCloseTo(80, 6);
  });

  it('foreshortens: a rotateX tilt compresses the projected vertical extent', () => {
    const p: Project3DParams = { RotateXDeg: 50, RotateYDeg: 0, TranslateZ: 0, PivotX: 0, PivotY: 0, Perspective: 600, OriginX: 0, OriginY: 0 };
    const h = mat3Project3D(p);
    const [, yTop] = mat3ApplyPoint(h, 0, -50);
    const [, yBot] = mat3ApplyPoint(h, 0, 50);
    // Tilted plane: 100px of real height projects to LESS than 100px on screen.
    expect(Math.abs(yBot - yTop)).toBeLessThan(100);
    // ...and the near edge (toward the viewer) is magnified vs the far edge —
    // perspective makes the projection asymmetric about the pivot.
    expect(Math.abs(yBot)).not.toBeCloseTo(Math.abs(yTop), 1);
  });

  it('reproduces the underlying projection at arbitrary points (3-sample exactness)', () => {
    // The builder fits a homography from 3 samples of an affine-in-(x,y)
    // pre-divide; it must therefore be exact everywhere. Re-derive the
    // projection by hand for a probe point and compare.
    const p: Project3DParams = { RotateXDeg: 25, RotateYDeg: 0, TranslateZ: 0, PivotX: 0, PivotY: 0, Perspective: 500, OriginX: 0, OriginY: 0 };
    const h = mat3Project3D(p);
    const th = (25 * Math.PI) / 180;
    const probe = (y: number): number => {
      const z2 = y * Math.sin(th);              // rotateX of (0, y, 0) → z = y·sinθ
      const yRot = y * Math.cos(th);
      return yRot * (500 / (500 - z2));         // perspective magnify
    };
    for (const y of [13, -27, 60]) {
      const [, sy] = mat3ApplyPoint(h, 0, y);
      expect(sy).toBeCloseTo(probe(y), 6);
    }
  });
});
