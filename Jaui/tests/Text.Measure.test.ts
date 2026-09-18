import { describe, it, expect } from 'vitest';
import { FitWithEllipsis, MeasureText } from '../src/Text/Text.Measure';
import { DefaultTextStyle, type TextStyle } from '../src/Text/Text.Types';

// Mock 2D context: 8px per character.
const mockCtx = (): CanvasRenderingContext2D => {
  const obj: Partial<CanvasRenderingContext2D> = {
    font: '',
    textBaseline: 'top',
    textAlign: 'left',
    measureText: (text: string) => ({ width: text.length * 8 } as TextMetrics),
  };
  return obj as CanvasRenderingContext2D;
};

const style = (overrides: Partial<TextStyle> = {}): TextStyle => ({
  ...DefaultTextStyle,
  ...overrides,
});

describe('MeasureText', () => {
  describe('single line', () => {
    it('measures short text', () => {
      const r = MeasureText('Hello', style(), null, mockCtx());
      expect(r.Width).toBe(40); // 5 chars × 8px
      expect(r.Lines).toEqual(['Hello']);
    });

    it('returns height = FontSize × LineHeight for one line', () => {
      const r = MeasureText('x', style({ FontSize: 16, LineHeight: 1.5 }), null, mockCtx());
      expect(r.Height).toBe(24);
    });

    it('handles empty string', () => {
      const r = MeasureText('', style(), null, mockCtx());
      expect(r.Width).toBe(0);
      expect(r.Lines).toEqual(['']);
      expect(r.Height).toBeGreaterThan(0);
    });

    it('preserves explicit newlines as separate lines', () => {
      const r = MeasureText('Line 1\nLine 2', style(), null, mockCtx());
      expect(r.Lines).toEqual(['Line 1', 'Line 2']);
      expect(r.Height).toBe(16 * 1.2 * 2);
    });
  });

  describe('word wrapping', () => {
    it('wraps at word boundaries when exceeding maxWidth', () => {
      // "Hello World" = 11 chars × 8 = 88px. maxWidth=50 → "Hello" (40), "World" (40)
      const r = MeasureText('Hello World', style(), 50, mockCtx());
      expect(r.Lines).toEqual(['Hello', 'World']);
    });

    it('does not wrap when fits in maxWidth', () => {
      const r = MeasureText('Hi', style(), 100, mockCtx());
      expect(r.Lines).toEqual(['Hi']);
    });

    it('wraps multiple words correctly', () => {
      // maxWidth=80 → "a b c" = 5*8=40 fits, "a b c d" = 7*8=56 fits, "a b c d e" = 9*8=72 fits
      // Actually "one two three" = 13*8=104, too wide for 80.
      // "one two" = 7*8=56 fits. "one two three" = 104 doesn't.
      const r = MeasureText('one two three', style(), 80, mockCtx());
      expect(r.Lines).toEqual(['one two', 'three']);
    });

    it('long single word gets its own line even if overflowing', () => {
      const r = MeasureText('supercalifragilistic', style(), 50, mockCtx());
      expect(r.Lines).toEqual(['supercalifragilistic']);
    });

    it('respects paragraph breaks during wrap', () => {
      const r = MeasureText('one two\nthree four', style(), 32, mockCtx());
      // "one" (24) fits, "one two" (56) does not → "one", "two" | "three" (40) does not fit → "three", "four"
      expect(r.Lines).toEqual(['one', 'two', 'three', 'four']);
    });
  });

  describe('MaxLines', () => {
    it('limits to N lines', () => {
      const r = MeasureText('a b c d e', style({ MaxLines: 2 }), 8, mockCtx());
      expect(r.Lines).toHaveLength(2);
    });

    it('null MaxLines allows unlimited lines', () => {
      const r = MeasureText('a b c d e', style({ MaxLines: null }), 8, mockCtx());
      expect(r.Lines).toHaveLength(5);
    });
  });

  describe('FitWithEllipsis', () => {
    // 8px per char in the mock, and the ellipsis is one char.
    it('keeps the longest prefix whose advance INCLUDING the ellipsis fits', () => {
      expect(FitWithEllipsis('aaa bbb', 48, mockCtx())).toBe('aaa b');
    });

    it('returns the whole string when the whole string plus the ellipsis fits', () => {
      expect(FitWithEllipsis('abc', 1000, mockCtx())).toBe('abc');
      expect(FitWithEllipsis('abc', Infinity, mockCtx())).toBe('abc');
    });

    it('hangs a trailing space rather than painting `the …`', () => {
      // At 40px the cut lands after 'aaa ' -- CSS hangs that space, so it is trimmed.
      expect(FitWithEllipsis('aaa bbb', 40, mockCtx())).toBe('aaa');
    });

    it('keeps nothing when not even the ellipsis fits', () => {
      expect(FitWithEllipsis('abc', 0, mockCtx())).toBe('');
    });
  });

  describe('TextOverflow: Ellipsis', () => {
    it('cuts the last kept line from its TAIL, not from the wrapped line', () => {
      // 'aaa' fills the 48px line and 'bbb' wraps away; CSS still keeps its 'b', because the wrap
      // decides how many LINES there are and not where the ellipsis falls.
      const r = MeasureText('aaa bbb', style({ MaxLines: 1, TextOverflow: 'Ellipsis' }), 48, mockCtx());
      expect(r.Lines).toEqual(['aaa b…']);
    });

    it('appends ellipsis when text exceeds MaxLines', () => {
      const r = MeasureText('one two three four', style({ MaxLines: 2, TextOverflow: 'Ellipsis' }), 32, mockCtx());
      expect(r.Lines).toHaveLength(2);
      expect(r.Lines[1]).toMatch(/…$/);
    });

    it('no ellipsis when text fits within MaxLines', () => {
      const r = MeasureText('hi', style({ MaxLines: 5, TextOverflow: 'Ellipsis' }), 100, mockCtx());
      expect(r.Lines).toEqual(['hi']);
      expect(r.Lines[0]).not.toMatch(/…/);
    });

    it('clip overflow does not add ellipsis', () => {
      const r = MeasureText('one two three four', style({ MaxLines: 2, TextOverflow: 'Clip' }), 32, mockCtx());
      expect(r.Lines).toHaveLength(2);
      expect(r.Lines[1]).not.toMatch(/…/);
    });
  });

  describe('width calculation', () => {
    it('returns the widest line across multiple lines', () => {
      const r = MeasureText('hi\nlonger line', style(), null, mockCtx());
      expect(r.Width).toBe('longer line'.length * 8);
    });
  });
});
