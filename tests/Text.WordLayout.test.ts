import { describe, it, expect } from 'vitest';
import { LayoutWords, Tokenize } from '../src/Text/Text.WordLayout';
import { DefaultTextStyle, type TextStyle } from '../src/Text/Text.Types';

// Mock ctx — 8px per char
const mockCtx = (): CanvasRenderingContext2D => ({
  font: '', textBaseline: 'top', textAlign: 'left',
  measureText: (t: string) => ({ width: t.length * 8 } as TextMetrics),
} as unknown as CanvasRenderingContext2D);

const style = (o: Partial<TextStyle> = {}): TextStyle => ({ ...DefaultTextStyle, ...o });

describe('Tokenize', () => {
  it('splits words on whitespace', () => {
    expect(Tokenize('hello world')).toEqual(['hello', 'world']);
  });
  it('filters empty tokens from multiple spaces', () => {
    expect(Tokenize('a  b')).toEqual(['a', 'b']);
  });
  it('treats newlines as whitespace separator', () => {
    expect(Tokenize('a\nb')).toEqual(['a', 'b']);
  });
  it('empty string → empty array', () => {
    expect(Tokenize('')).toEqual([]);
  });
});

describe('LayoutWords', () => {
  describe('single line (no wrap)', () => {
    it('places words left-to-right with space between', () => {
      const positions = LayoutWords('one two three', style(), null, mockCtx());
      expect(positions).toHaveLength(3);
      expect(positions[0].X).toBe(0);
      expect(positions[0].Width).toBe(24); // 'one' = 3*8
      // space = 1 char * 8 = 8, so 'two' at 24 + 8 = 32
      expect(positions[1].X).toBe(32);
      expect(positions[1].Width).toBe(24);
      // 'three' at 32 + 24 + 8 = 64
      expect(positions[2].X).toBe(64);
      expect(positions[2].Width).toBe(40);
    });

    it('all words on line 0 when no wrap', () => {
      const p = LayoutWords('a b c', style(), null, mockCtx());
      expect(p.every((w) => w.Line === 0)).toBe(true);
      expect(p.every((w) => w.Y === 0)).toBe(true);
    });

    it('assigns line height from FontSize × LineHeight', () => {
      const p = LayoutWords('x', style({ FontSize: 20, LineHeight: 1.5 }), null, mockCtx());
      expect(p[0].Height).toBe(30);
    });
  });

  describe('wrapping', () => {
    it('wraps when a word would exceed maxWidth', () => {
      // 'one two three' — each 'x two' pair: 24+8+24 = 56. At maxWidth=50, 'two' wraps
      const p = LayoutWords('one two three', style(), 50, mockCtx());
      // 'one' at 0,0 ; 'two' wraps to line 1 ; 'three' also wraps
      expect(p[0].Line).toBe(0);
      expect(p[1].Line).toBe(1);
    });

    it('words on wrapped line have incremented Y', () => {
      const p = LayoutWords('one two', style({ FontSize: 16, LineHeight: 1 }), 24, mockCtx());
      expect(p[0].Y).toBe(0);
      expect(p[1].Y).toBe(16); // line height
      expect(p[1].Line).toBe(1);
    });

    it('long single word gets its own line', () => {
      const p = LayoutWords('supercalifragilistic', style(), 20, mockCtx());
      expect(p).toHaveLength(1);
      expect(p[0].X).toBe(0);
    });
  });

  describe('TextAlign', () => {
    it('Left alignment (default) — words start at X=0', () => {
      const p = LayoutWords('hi', style({ TextAlign: 'Left' }), 100, mockCtx());
      expect(p[0].X).toBe(0);
    });

    it('Center alignment shifts each line to center', () => {
      // 'hi' = 16px wide. maxWidth=100. offset = (100-16)/2 = 42
      const p = LayoutWords('hi', style({ TextAlign: 'Center' }), 100, mockCtx());
      expect(p[0].X).toBe(42);
    });

    it('Right alignment pushes line to right edge', () => {
      const p = LayoutWords('hi', style({ TextAlign: 'Right' }), 100, mockCtx());
      // lineWidth=16, maxWidth=100, offset=84
      expect(p[0].X).toBe(84);
    });

    it('Center alignment handles multi-line independently', () => {
      // 'a bb ccc' at maxWidth=24
      // line 1: 'a' (8) wrap when 'bb' would exceed
      // actually let's check: 'a' (8), +space=16, +'bb' (16) = 32 > 24 → wrap
      // line 0: 'a' at X=0, lineWidth=8. center offset = (24-8)/2 = 8 → X=8
      // line 1: 'bb' at X=0, lineWidth=16. center offset = (24-16)/2 = 4 → X=4
      const p = LayoutWords('a bb', style({ TextAlign: 'Center' }), 24, mockCtx());
      expect(p[0].X).toBe(8);  // centered on line 0
      expect(p[1].X).toBe(4);  // centered on line 1
    });
  });

  describe('edge cases', () => {
    it('empty content → empty array', () => {
      expect(LayoutWords('', style(), null, mockCtx())).toEqual([]);
    });

    it('newlines split into tokens (current v1 behavior)', () => {
      const p = LayoutWords('a\nb', style(), null, mockCtx());
      expect(p).toHaveLength(2);
      expect(p[0].Content).toBe('a');
      expect(p[1].Content).toBe('b');
    });
  });
});
