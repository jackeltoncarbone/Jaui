import { describe, it, expect } from 'vitest';
import { ApplyTextStyle, ComposeFontFamily, FitWithEllipsis, MeasureText } from '../src/Text/Text.Measure';
import { DefaultTextStyle, ResolveTextStyle, type TextStyle } from '../src/Text/Text.Types';
import { SEED_CONTEXT } from '../src/Core/Style.Resolver';

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

// The CJK sans fallback (SS drill-sentences, live): Inter has no CJK glyphs, so a canvas named only
// `Inter`/`Inter, system-ui, sans-serif` fell through to the platform's SERIF default for Japanese,
// Chinese and Korean text. `ComposeFontFamily` is the one place that stack gets extended, and
// `ApplyTextStyle` is the one place that composed stack reaches a canvas's own `font` string — for
// every measure AND every fill, so the two can never drift the way the "1ain" bug once did.
describe('ComposeFontFamily', () => {
  it('extends a bare family with the CJK sans stack and ends in sans-serif', () => {
    const composed = ComposeFontFamily('Inter');
    expect(composed.startsWith('Inter, ')).toBe(true);
    expect(composed.endsWith(', sans-serif')).toBe(true);
    for (const face of [
      'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo',
      'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei',
      'Apple SD Gothic Neo', 'Malgun Gothic',
      'Noto Sans CJK JP', 'Noto Sans CJK SC', 'Noto Sans CJK KR',
      'Noto Sans JP', 'Noto Sans SC', 'Noto Sans KR',
    ]) {
      expect(composed).toContain(`"${face}"`);
    }
  });

  it('inserts the CJK stack before an authored generic fallback, not after', () => {
    const composed = ComposeFontFamily('Inter, system-ui, sans-serif');
    expect(composed.startsWith('Inter, "Hiragino Sans"')).toBe(true);
    expect(composed.endsWith(', sans-serif')).toBe(true);
  });

  it('extends a tabular-twinned stack without dropping the twin or its proportional fallback', () => {
    const composed = ComposeFontFamily('"Inter JauiTnum", Inter');
    expect(composed.startsWith('"Inter JauiTnum", Inter, "Hiragino Sans"')).toBe(true);
    expect(composed.endsWith(', sans-serif')).toBe(true);
  });

  it('is stable for the same input (memoized)', () => {
    expect(ComposeFontFamily('Inter')).toBe(ComposeFontFamily('Inter'));
  });

  // Drill Sentences lane YY3b, item 10: `-apple-system`/`BlinkMacSystemFont` read like generics ("pick
  // whatever the OS wants") but are not — they only resolve to San Francisco on Apple platforms, with
  // every other browser silently skipping the unknown name. An authored stack that names the app's own web
  // font AFTER them as a real fallback needs that name to survive composition, not be read as "past the
  // generic, drop it" the way an actual CSS generic (`system-ui`, `sans-serif`) correctly is.
  it('keeps a real fallback named after -apple-system/BlinkMacSystemFont, so Apple devices get San Francisco and everyone else still gets the web font', () => {
    const composed = ComposeFontFamily('-apple-system, BlinkMacSystemFont, Inter');
    expect(composed.startsWith('-apple-system, BlinkMacSystemFont, Inter, "Hiragino Sans"')).toBe(true);
    expect(composed.endsWith(', sans-serif')).toBe(true);
  });

  it('still truncates at a real CSS generic (system-ui) named after -apple-system', () => {
    const composed = ComposeFontFamily('-apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif');
    expect(composed.startsWith('-apple-system, BlinkMacSystemFont, Inter, "Hiragino Sans"')).toBe(true);
    expect(composed).not.toContain('system-ui');
    expect(composed.endsWith(', sans-serif')).toBe(true);
  });
});

describe('ApplyTextStyle', () => {
  it('builds the identical composed font string for a measure context and a fill context', () => {
    const resolved = ResolveTextStyle({ ...DefaultTextStyle, FontFamily: 'Inter' }, SEED_CONTEXT);
    const measureCtx = mockCtx();
    const fillCtx = mockCtx();

    ApplyTextStyle(measureCtx, resolved, 1);
    ApplyTextStyle(fillCtx, resolved, 1);

    expect(measureCtx.font).toBe(fillCtx.font);
    expect(measureCtx.font).toContain('"Hiragino Sans"');
    expect(measureCtx.font.endsWith('sans-serif')).toBe(true);
  });

  it('composes the CJK fallback into the actual ctx.font string it hands the canvas', () => {
    const resolved = ResolveTextStyle({ ...DefaultTextStyle, FontFamily: 'Inter' }, SEED_CONTEXT);
    const ctx = mockCtx();
    ApplyTextStyle(ctx, resolved, 1);
    expect(ctx.font).toBe(`${resolved.FontWeight} ${resolved.FontSize}px ${ComposeFontFamily('Inter')}`);
  });
});
