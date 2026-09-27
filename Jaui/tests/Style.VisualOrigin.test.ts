import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';

// VisualOrigin/VisualScale/VisualTranslate share one shorthand parser (Core/Style.Resolver
// `_parseVisualPair`). These pin the CSS-style origin keywords JwiftStretchyHeader's
// `VisualOrigin: Bottom` needs, and the "arithmetic vs two-axis-pair" disambiguation its
// `VisualScale: 1 + (@OverscrollTop / @Height) * @OverscrollZoom` needs — a bare operator token,
// or more than two tokens, means "one expression, spaced for readability", not two axis values.

describe('VisualOrigin — CSS-style keywords', () => {
  it('Bottom sets Y=1, X stays centered (0.5)', () => {
    const j = new Jiv({ Style: { VisualOrigin: 'Bottom' } });
    expect(j.RenderStyle.VisualOriginX).toBe(0.5);
    expect(j.RenderStyle.VisualOriginY).toBe(1);
  });

  it('Top/Left/Right/Center all resolve, case-insensitively', () => {
    expect(new Jiv({ Style: { VisualOrigin: 'top' } }).RenderStyle.VisualOriginY).toBe(0);
    expect(new Jiv({ Style: { VisualOrigin: 'Left' } }).RenderStyle.VisualOriginX).toBe(0);
    expect(new Jiv({ Style: { VisualOrigin: 'RIGHT' } }).RenderStyle.VisualOriginX).toBe(1);
    const c = new Jiv({ Style: { VisualOrigin: 'Center' } });
    expect([c.RenderStyle.VisualOriginX, c.RenderStyle.VisualOriginY]).toEqual([0.5, 0.5]);
  });

  it('a two-token pair mixes a keyword with a plain number', () => {
    const j = new Jiv({ Style: { VisualOrigin: '0.25 Bottom' } });
    expect(j.RenderStyle.VisualOriginX).toBe(0.25);
    expect(j.RenderStyle.VisualOriginY).toBe(1);
  });

  it('a plain number pair is unaffected (existing behavior)', () => {
    const j = new Jiv({ Style: { VisualOrigin: '0.2 0.8' } });
    expect(j.RenderStyle.VisualOriginX).toBe(0.2);
    expect(j.RenderStyle.VisualOriginY).toBe(0.8);
  });
});

describe('VisualScale — a spaced arithmetic expression resolves whole, uniformly', () => {
  it('a single-value shorthand still means uniform (existing behavior)', () => {
    const j = new Jiv({ Style: { VisualScale: '1.2' } });
    expect(j.RenderStyle.VisualScaleX).toBe(1.2);
    expect(j.RenderStyle.VisualScaleY).toBe(1.2);
  });

  it('a two-number shorthand is still per-axis (existing behavior)', () => {
    const j = new Jiv({ Style: { VisualScale: '0.92 1.06' } });
    expect(j.RenderStyle.VisualScaleX).toBeCloseTo(0.92);
    expect(j.RenderStyle.VisualScaleY).toBeCloseTo(1.06);
  });

  it('an arithmetic expression with spaced operators applies uniformly, not per-axis', () => {
    const j = new Jiv({ Style: { VisualScale: '1 + 2 / 10' } });
    expect(j.RenderStyle.VisualScaleX).toBeCloseTo(1.2);
    expect(j.RenderStyle.VisualScaleY).toBeCloseTo(1.2);
  });
});

describe('VisualTranslate — a per-axis pair keeps each axis to one token', () => {
  it('resolves two unspaced sub-expressions as X then Y', () => {
    const j = new Jiv({ Style: { VisualTranslate: '0pt (2pt*3)' } });
    expect(j.RenderStyle.VisualTranslateX).toBe(0);
    expect(j.RenderStyle.VisualTranslateY).toBeCloseTo(6 * 16); // 1pt = 16px at default PointScale
  });
});
