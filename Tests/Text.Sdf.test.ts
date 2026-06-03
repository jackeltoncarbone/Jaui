import { describe, it, expect } from 'vitest';
import { ComputeSdf, DecodeSdf } from '@jaui/Text/Text.Sdf';

describe('Text.Sdf', () => {

  const SPREAD = 8;

  // Filled 8x8 square (cols/rows 4..11) centered in a 16x16 field.
  const buildSquare = (): { alpha: Uint8Array; w: number; h: number } => {
    const w = 16;
    const h = 16;
    const alpha = new Uint8Array(w * h);
    for (let y = 4; y < 12; y++) {
      for (let x = 4; x < 12; x++) {
        alpha[y * w + x] = 255;
      }
    }
    return { alpha, w, h };
  };

  describe('ComputeSdf — 8x8 square', () => {
    it('center pixel decodes to a positive distance ~ +4', () => {
      const { alpha, w, h } = buildSquare();
      const sdf = ComputeSdf(alpha, w, h, SPREAD);
      const center = sdf[8 * w + 8]; // pixel (8,8), inside the square
      const dist = DecodeSdf(center, SPREAD);
      expect(dist).toBeGreaterThan(0);
      // Nearest edge of an 8-wide square from a near-center pixel is ~4px.
      expect(Math.abs(dist - 4)).toBeLessThan(1.5);
    });

    it('corner pixel (well outside) decodes negative', () => {
      const { alpha, w, h } = buildSquare();
      const sdf = ComputeSdf(alpha, w, h, SPREAD);
      const corner = sdf[0]; // pixel (0,0)
      const dist = DecodeSdf(corner, SPREAD);
      expect(dist).toBeLessThan(0);
    });

    it('pixel on the square edge decodes near 0 (within ~1px)', () => {
      const { alpha, w, h } = buildSquare();
      const sdf = ComputeSdf(alpha, w, h, SPREAD);
      // Pixel (4,8) is the leftmost inside column — its nearest outside
      // neighbor is one step away, so signed distance is ~1px.
      const edge = sdf[8 * w + 4];
      const dist = DecodeSdf(edge, SPREAD);
      expect(Math.abs(dist)).toBeLessThan(1.5);
    });
  });

  describe('ComputeSdf — degenerate fields', () => {
    it('all-inside bitmap: every byte >= 128', () => {
      const w = 8;
      const h = 8;
      const alpha = new Uint8Array(w * h).fill(255);
      const sdf = ComputeSdf(alpha, w, h, SPREAD);
      for (let i = 0; i < sdf.length; i++) {
        expect(sdf[i]).toBeGreaterThanOrEqual(128);
      }
    });

    it('all-outside bitmap: every byte <= 128', () => {
      const w = 8;
      const h = 8;
      const alpha = new Uint8Array(w * h); // all zeros
      const sdf = ComputeSdf(alpha, w, h, SPREAD);
      for (let i = 0; i < sdf.length; i++) {
        expect(sdf[i]).toBeLessThanOrEqual(128);
      }
    });
  });

  describe('DecodeSdf', () => {
    it('is the inverse of the encode mapping', () => {
      expect(DecodeSdf(128, SPREAD)).toBeCloseTo(0, 1);
      expect(DecodeSdf(255, SPREAD)).toBeCloseTo(SPREAD, 1);
      expect(DecodeSdf(0, SPREAD)).toBeCloseTo(-SPREAD, 1);
    });
  });
});
