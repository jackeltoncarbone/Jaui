import { describe, it, expect } from 'vitest';
import { HashTextKey } from '@jaui/Text/Text.Hash';
import { DefaultTextStyle, type TextStyle } from '@jaui/Text/Text.Types';

const s = (o: Partial<TextStyle> = {}): TextStyle => ({ ...DefaultTextStyle, ...o });

describe('HashTextKey', () => {
  it('produces identical hash for identical inputs', () => {
    const a = HashTextKey('Hello', s(), 2);
    const b = HashTextKey('Hello', s(), 2);
    expect(a).toBe(b);
  });

  it('produces different hash for different content', () => {
    const a = HashTextKey('Hello', s(), 2);
    const b = HashTextKey('World', s(), 2);
    expect(a).not.toBe(b);
  });

  it('produces different hash for different font size', () => {
    const a = HashTextKey('x', s({ FontSize: 16 }), 1);
    const b = HashTextKey('x', s({ FontSize: 18 }), 1);
    expect(a).not.toBe(b);
  });

  it('produces different hash for different dpr', () => {
    const a = HashTextKey('x', s(), 1);
    const b = HashTextKey('x', s(), 2);
    expect(a).not.toBe(b);
  });

  it('produces different hash for different color', () => {
    const a = HashTextKey('x', s({ Color: { R: 1, G: 0, B: 0, A: 1 } }), 1);
    const b = HashTextKey('x', s({ Color: { R: 0, G: 1, B: 0, A: 1 } }), 1);
    expect(a).not.toBe(b);
  });

  it('produces different hash for different font weight', () => {
    const a = HashTextKey('x', s({ FontWeight: 400 }), 1);
    const b = HashTextKey('x', s({ FontWeight: 700 }), 1);
    expect(a).not.toBe(b);
  });

  it('produces different hash for different max lines', () => {
    const a = HashTextKey('x', s({ MaxLines: null }), 1);
    const b = HashTextKey('x', s({ MaxLines: 2 }), 1);
    expect(a).not.toBe(b);
  });

  it('returns a non-empty string', () => {
    const h = HashTextKey('x', s(), 1);
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });
});
