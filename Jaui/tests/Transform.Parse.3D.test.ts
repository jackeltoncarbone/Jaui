import { describe, it, expect } from 'vitest';
import { ResolveTransform } from '../src/Transform/Transform.Parse';
import type { ResolveContext } from '../src/Core/Length';

const ctx: ResolveContext = {
  ParentWidth: 400,
  ParentHeight: 200,
  PointScale: 16,
  ParentPointScale: 16,
  RootPointScale: 16,
  ViewportWidth: 1000,
  ViewportHeight: 800,
};

describe('Transform.Parse — 3D tokens', () => {
  it('parses rotateX / rotateY in degrees', () => {
    const t = ResolveTransform('rotateX(30) rotateY(-12)', ctx);
    expect(t.RotateX).toBe(30);
    expect(t.RotateY).toBe(-12);
  });

  it('parses translateZ in px', () => {
    expect(ResolveTransform('translateZ(48)', ctx).TranslateZ).toBe(48);
  });

  it('translateZ resolves Length units (pt → PointScale)', () => {
    expect(ResolveTransform('translateZ(3pt)', ctx).TranslateZ).toBe(48);
  });

  it('composes 3D with the existing 2D functions, any order', () => {
    const t = ResolveTransform('translateZ(20) rotate(45) rotateX(10) scale(1.2)', ctx);
    expect(t.TranslateZ).toBe(20);
    expect(t.Rotation).toBe(45);
    expect(t.RotateX).toBe(10);
    expect(t.ScaleX).toBeCloseTo(1.2, 9);
    expect(t.RotateY).toBe(0); // untouched → default
  });

  it('empty string is identity (3D fields default to 0)', () => {
    const t = ResolveTransform('', ctx);
    expect(t.RotateX).toBe(0);
    expect(t.RotateY).toBe(0);
    expect(t.TranslateZ).toBe(0);
  });
});

// SS-Support-FAQ-2: DisclosureRow's chevron authored `Rotate(180deg)` for its rotation, assuming the
// `deg` suffix CSS uses was accepted here too (`Length` has no such unit — rotate()'s argument resolves
// through the same length parser as every other Transform function, UNITLESS, per the composition test
// above). The throw this produced inside the worker's style resolve (StyleAnimator never got built) left
// the chevron at the Presence-seeded Opacity of 0 — permanently invisible, open or closed. These pin the
// unitless form as the only one `rotate()`/`rotateX()`/`rotateY()` accept, so the mistake is caught here
// rather than live, as a chevron (or anything else) that silently never renders.
describe('Transform.Parse — rotate() takes a bare number, never a `deg` suffix', () => {
  it('rejects "deg" on rotate() — the CSS-style suffix this bug authored', () => {
    expect(() => ResolveTransform('rotate(180deg)', ctx)).toThrow(/Unexpected trailing input/);
  });

  it('rejects "deg" on rotateX()/rotateY() too — the same length parser, the same mistake', () => {
    expect(() => ResolveTransform('rotateX(30deg)', ctx)).toThrow(/Unexpected trailing input/);
    expect(() => ResolveTransform('rotateY(30deg)', ctx)).toThrow(/Unexpected trailing input/);
  });

  it('the correct, unitless form resolves cleanly at both of the chevron\'s two states', () => {
    expect(ResolveTransform('rotate(0)', ctx).Rotation).toBe(0);
    expect(ResolveTransform('rotate(180)', ctx).Rotation).toBe(180);
  });
});
