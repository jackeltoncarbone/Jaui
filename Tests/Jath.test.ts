import { describe, it, expect } from 'vitest';
import { Jath } from '@jaui/Core/Jath';

describe('Jath', () => {

  describe('Lerp', () => {
    it('interpolates between values', () => {
      expect(Jath.Lerp(0, 10, 0.5)).toBe(5);
      expect(Jath.Lerp(0, 10, 0)).toBe(0);
      expect(Jath.Lerp(0, 10, 1)).toBe(10);
    });
  });

  describe('Clamp', () => {
    it('clamps to range', () => {
      expect(Jath.Clamp(5, 0, 10)).toBe(5);
      expect(Jath.Clamp(-1, 0, 10)).toBe(0);
      expect(Jath.Clamp(15, 0, 10)).toBe(10);
    });
  });

  describe('SmoothStep', () => {
    it('returns 0 at 0 and 1 at 1', () => {
      expect(Jath.SmoothStep(0)).toBe(0);
      expect(Jath.SmoothStep(1)).toBe(1);
    });

    it('has inflection at 0.5', () => {
      expect(Jath.SmoothStep(0.5)).toBe(0.5);
    });

    it('clamps outside 0-1', () => {
      expect(Jath.SmoothStep(-1)).toBe(0);
      expect(Jath.SmoothStep(2)).toBe(1);
    });
  });

  describe('SuperellipseSDF', () => {
    const halfW = 100;
    const halfH = 50;
    const radius = 20;
    const smoothness = 0.6;

    it('returns negative inside the shape', () => {
      expect(Jath.SuperellipseSDF(0, 0, halfW, halfH, radius, smoothness)).toBeLessThan(0);
    });

    it('returns positive outside the shape', () => {
      expect(Jath.SuperellipseSDF(200, 200, halfW, halfH, radius, smoothness)).toBeGreaterThan(0);
    });

    it('returns ~0 near the edge', () => {
      // Point on the straight edge (top center)
      const dist = Jath.SuperellipseSDF(0, -halfH, halfW, halfH, radius, smoothness);
      expect(Math.abs(dist)).toBeLessThan(1);
    });
  });

  describe('CornerShapeExponent', () => {
    it('maps named shapes', () => {
      expect(Jath.CornerShapeExponent('Round')).toBe(2);
      expect(Jath.CornerShapeExponent('Squircle')).toBe(4);
      expect(Jath.CornerShapeExponent('Bevel')).toBe(1);
    });

    it('passes through numeric values', () => {
      expect(Jath.CornerShapeExponent(3.5)).toBe(3.5);
    });
  });
});
