import { describe, it, expect } from 'vitest';
import { ParseFilter } from '../src/Core/Filter.Parse';

describe('Filter foreground blur grammar', () => {
  it('parses uniform Blur() in the foreground zone', () => {
    const f = ParseFilter('Blur(12pt)', 'foreground');
    expect(f.ForegroundBlur).not.toBeNull();
    expect(f.ForegroundBlur!.Uniform).toBe(true);
    expect(f.ForegroundBlur!.RadiusRaw).toBe('12pt');
    // Foreground Blur() must NOT populate the backdrop BlurRaw.
    expect(f.BlurRaw).toBeNull();
  });

  it('keeps Blur() as a backdrop frost in the backdrop zone', () => {
    const f = ParseFilter('Blur(16pt) Brightness(1.25)');
    expect(f.BlurRaw).toBe('16pt');
    expect(f.Brightness).toBeCloseTo(1.25);
    expect(f.ForegroundBlur).toBeNull();
  });

  it('parses LinearProgressiveBlur(direction, radius, feather, easing) — directional', () => {
    const f = ParseFilter('LinearProgressiveBlur(Top, 24pt, 64pt, 0.6)', 'foreground');
    const fb = f.ForegroundBlur!;
    expect(fb.Mode).toBe('linear');
    expect(fb.Direction).toBe('ToTop');
    expect(fb.RadiusRaw).toBe('24pt');
    expect(fb.FeatherRaw).toBe('64pt');
    expect(fb.Easing).toBeCloseTo(0.6);
    expect(fb.Uniform).toBe(false);
  });

  it('parses LinearProgressiveBlur with the four edges', () => {
    expect(ParseFilter('LinearProgressiveBlur(Bottom, 10pt)', 'foreground').ForegroundBlur!.Direction).toBe('ToBottom');
    expect(ParseFilter('LinearProgressiveBlur(Left, 10pt)', 'foreground').ForegroundBlur!.Direction).toBe('ToLeft');
    expect(ParseFilter('LinearProgressiveBlur(Right, 10pt)', 'foreground').ForegroundBlur!.Direction).toBe('ToRight');
  });

  it('parses EdgeProgressiveBlur(radius [, feather] [, easing] [, edges]) — all-around, no direction', () => {
    const fb = ParseFilter('EdgeProgressiveBlur(24pt, 0.2, 0.6)', 'foreground').ForegroundBlur!;
    expect(fb.Mode).toBe('edge');
    expect(fb.Edges).toBe('All');
    expect(fb.RadiusRaw).toBe('24pt');
    expect(fb.FeatherRaw).toBe('0.2');
    expect(fb.Easing).toBeCloseTo(0.6);
    expect(fb.Uniform).toBe(false);
  });

  it('EdgeProgressiveBlur edges mask selects which edges fade', () => {
    expect(ParseFilter('EdgeProgressiveBlur(24pt, Top+Bottom)', 'foreground').ForegroundBlur!.Edges).toBe('Vertical');
    expect(ParseFilter('EdgeProgressiveBlur(24pt, Left+Right)', 'foreground').ForegroundBlur!.Edges).toBe('Horizontal');
    expect(ParseFilter('EdgeProgressiveBlur(24pt, 0.2, 1, Left+Right)', 'foreground').ForegroundBlur!.Edges).toBe('Horizontal');
    expect(ParseFilter('EdgeProgressiveBlur(24pt, Vertical)', 'foreground').ForegroundBlur!.Edges).toBe('Vertical');
  });

  it('EdgeProgressiveBlur rejects a direction (that is Linear’s job)', () => {
    expect(() => ParseFilter('EdgeProgressiveBlur(Top, 24pt)', 'foreground')).toThrow();
  });

  it('accepts an angle as the first arg (180deg → ToTop)', () => {
    expect(ParseFilter('LinearProgressiveBlur(180deg, 10pt)', 'foreground').ForegroundBlur!.Direction).toBe('ToTop');
    expect(ParseFilter('LinearProgressiveBlur(90, 10pt)', 'foreground').ForegroundBlur!.Direction).toBe('ToRight');
  });

  it('composes with grade functions and last-occurrence-wins still holds', () => {
    const f = ParseFilter('LinearProgressiveBlur(Top, 24pt, 64pt) Brightness(0.8) Brightness(1.2)', 'foreground');
    expect(f.ForegroundBlur!.Direction).toBe('ToTop');
    expect(f.Brightness).toBeCloseTo(1.2);
  });

  it('feather + easing are optional on both', () => {
    const lin = ParseFilter('LinearProgressiveBlur(Top, 24pt)', 'foreground').ForegroundBlur!;
    expect(lin.FeatherRaw).toBeNull();
    expect(lin.Easing).toBe(1);
    const edge = ParseFilter('EdgeProgressiveBlur(24pt)', 'foreground').ForegroundBlur!;
    expect(edge.Mode).toBe('edge');
    expect(edge.Edges).toBe('All');
    expect(edge.FeatherRaw).toBeNull();
    expect(edge.Easing).toBe(1);
  });

  it('throws on a bad Linear direction', () => {
    expect(() => ParseFilter('LinearProgressiveBlur(Sideways, 10pt)', 'foreground')).toThrow();
  });

  it('throws on a bad Edge mask', () => {
    expect(() => ParseFilter('EdgeProgressiveBlur(24pt, Diagonal)', 'foreground')).toThrow();
  });

  it('None is identity', () => {
    expect(ParseFilter('None', 'foreground').ForegroundBlur).toBeNull();
  });
});
