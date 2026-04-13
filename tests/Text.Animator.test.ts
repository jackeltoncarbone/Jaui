import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TextAnimator } from '../src/Text/Text.Animator';
import { DefaultTextStyle } from '../src/Text/Text.Types';

// Mock 2D context used by LayoutWords (8px per char).
beforeEach(() => {
  const ctx = {
    font: '', textBaseline: 'top', textAlign: 'left', letterSpacing: '',
    canvas: { width: 1, height: 1 },
    measureText: (t: string) => ({ width: t.length * 8 }),
  };
  const canvas: Partial<HTMLCanvasElement> = {
    width: 1, height: 1,
    getContext: () => ctx as unknown as CanvasRenderingContext2D,
  };
  global.document = {
    createElement: vi.fn(() => canvas as HTMLCanvasElement),
  } as unknown as Document;
});

const style = (o: Partial<typeof DefaultTextStyle> = {}) => ({ ...DefaultTextStyle, ...o });

describe('TextAnimator (per-word)', () => {
  it('initializes with no words', () => {
    const a = new TextAnimator(DefaultTextStyle);
    expect(a.Words).toEqual([]);
    expect(a.Content).toBe('');
  });

  it('Update adds words for initial content', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('hello world', DefaultTextStyle, null);
    expect(a.Words).toHaveLength(2);
    expect(a.Words[0].Content).toBe('hello');
    expect(a.Words[1].Content).toBe('world');
  });

  it('new words start with opacity=0 and fade to 1', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('hi', DefaultTextStyle, null);
    const w = a.Words[0];
    expect(w.Opacity.Value).toBe(0);
    expect(w.Opacity.Target).toBe(1);
    expect(w.Opacity.IsSettled).toBe(false);
  });

  it('wrap change animates word positions but keeps same words', () => {
    const a = new TextAnimator(DefaultTextStyle);
    // "one two three" at maxWidth=200 → all on one line
    a.Update('one two three', DefaultTextStyle, 200);
    // Snap all springs to target for test determinism
    for (const w of a.Words) {
      w.SpringX.Snap();
      w.SpringY.Snap();
      w.Opacity.Snap();
    }

    // All on line 0 initially
    expect(a.Words.every((w) => w.TargetY === 0)).toBe(true);
    const wordCount = a.Words.length;

    // Shrink — force wrap ("one two three" = 13 chars * 8 = 104px, but 3 words at ~24-40px each)
    // At maxWidth=32, each word gets its own line
    a.Update('one two three', DefaultTextStyle, 32);

    // Same words, count unchanged
    expect(a.Words).toHaveLength(wordCount);
    expect(a.Words.map((w) => w.Content)).toEqual(['one', 'two', 'three']);

    // Targets should now be on different Y positions (wrapped)
    const ys = new Set(a.Words.map((w) => w.TargetY));
    expect(ys.size).toBeGreaterThan(1);
  });

  it('content change adds new words, fades out old', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('hello world', DefaultTextStyle, null);
    for (const w of a.Words) { w.SpringX.Snap(); w.SpringY.Snap(); w.Opacity.Snap(); }

    a.Update('hello there', DefaultTextStyle, null);

    // 'hello' is matched (kept), 'world' is dying, 'there' is new
    const living = a.Words.filter((w) => !w.Dying);
    const dying = a.Words.filter((w) => w.Dying);
    expect(living.map((w) => w.Content)).toEqual(['hello', 'there']);
    expect(dying.map((w) => w.Content)).toEqual(['world']);
  });

  it('dying words are pruned after opacity settles at 0', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('hello world', DefaultTextStyle, null);
    for (const w of a.Words) { w.SpringX.Snap(); w.SpringY.Snap(); w.Opacity.Snap(); }

    a.Update('hello', DefaultTextStyle, null);
    // 'world' is dying
    expect(a.Words.some((w) => w.Dying && w.Content === 'world')).toBe(true);

    // Tick until settled
    let frames = 0;
    while (a.Tick(1 / 60) && frames < 200) frames++;

    // Dying word should be pruned by next Update call
    a.Update('hello', DefaultTextStyle, null);
    expect(a.Words.some((w) => w.Content === 'world')).toBe(false);
  });

  it('style change updates all words and preserves their animation', () => {
    const a = new TextAnimator(style({ FontSize: 16 }));
    a.Update('a b', style({ FontSize: 16 }), null);
    for (const w of a.Words) { w.Opacity.Snap(); w.SpringX.Snap(); w.SpringY.Snap(); }

    a.Update('a b', style({ FontSize: 24 }), null);
    for (const w of a.Words.filter((x) => !x.Dying)) {
      expect(w.Style.FontSize).toBe(24);
    }
  });

  it('no change → no springs need animation', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('hi', DefaultTextStyle, null);
    for (const w of a.Words) { w.SpringX.Snap(); w.SpringY.Snap(); w.Opacity.Snap(); }

    const needsKick = a.Update('hi', DefaultTextStyle, null);
    expect(needsKick).toBe(false);
  });

  it('wrap change returns true (needs kick)', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('one two three', DefaultTextStyle, 200);
    for (const w of a.Words) { w.SpringX.Snap(); w.SpringY.Snap(); w.Opacity.Snap(); }

    const needsKick = a.Update('one two three', DefaultTextStyle, 32);
    expect(needsKick).toBe(true);
  });

  it('Tick steps springs and returns true while active', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('hi', DefaultTextStyle, null);
    expect(a.Tick(1 / 60)).toBe(true);
  });

  it('Tick returns false once all springs settled', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('hi', DefaultTextStyle, null);
    let frames = 0;
    while (a.Tick(1 / 60) && frames < 200) frames++;
    expect(a.Tick(1 / 60)).toBe(false);
  });

  it('empty content results in no words', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('', DefaultTextStyle, null);
    expect(a.Words).toEqual([]);
  });

  it('transitioning from text to empty fades all out', () => {
    const a = new TextAnimator(DefaultTextStyle);
    a.Update('hello', DefaultTextStyle, null);
    for (const w of a.Words) { w.SpringX.Snap(); w.SpringY.Snap(); w.Opacity.Snap(); }

    a.Update('', DefaultTextStyle, null);
    expect(a.Words.every((w) => w.Dying)).toBe(true);
  });
});
