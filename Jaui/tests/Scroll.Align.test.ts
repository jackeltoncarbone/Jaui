import { describe, it, expect } from 'vitest';
import { AlignTarget, type AlignSpan } from '../src/Scroll/Scroll.Align';

// A column laid out the way a surface lays one out: sections of `section` tall
// at `gap`, starting on the leading padding line.
const column = (count: number, section: number, gap: number, pad: number): AlignSpan[] =>
  Array.from({ length: count }, (_, i) => ({ Start: pad + i * (section + gap), Size: section }));

const maxOf = (spans: AlignSpan[], view: number, pad: number): number =>
  Math.max(0, spans[spans.length - 1].Start + spans[spans.length - 1].Size + pad - view);

describe('AlignTarget: where a jump lands', () => {
  const section = 520, gap = 48, pad = 24, view = 900;
  const spans = column(6, section, gap, pad);
  const max = maxOf(spans, view, pad);

  it('Start sets the section on the leading PADDING line, not the border', () => {
    // The first section is already there, so jumping to it is a jump to 0 —
    // the padding is above it, and scrolling it away would show the section
    // flush with an edge nothing else on the page touches.
    expect(AlignTarget(spans[0], 0, view, pad, pad, max, 'Start')).toBe(0);
    expect(AlignTarget(spans[2], 0, view, pad, pad, max, 'Start')).toBe(2 * (section + gap));
  });

  it('a section past the last screenful clamps at the end', () => {
    expect(AlignTarget(spans[5], 0, view, pad, pad, max, 'Start')).toBe(max);
  });

  it('End brings the section to the trailing padding line', () => {
    const s = spans[3];
    expect(AlignTarget(s, 0, view, pad, pad, max, 'End')).toBe(
      Math.min(max, s.Start + s.Size + pad - view),
    );
  });

  it('Center puts the section in the middle of the PADDED window', () => {
    const s = spans[3];
    const window = view - pad - pad;
    expect(AlignTarget(s, 0, view, pad, pad, max, 'Center')).toBeCloseTo(
      Math.min(max, s.Start + s.Size / 2 - (pad + window / 2)), 5,
    );
  });

  it('Nearest does nothing at all when the section is already whole', () => {
    // Section 0 fills the window from the top; nothing to reveal.
    const from = AlignTarget(spans[0], 0, view, pad, pad, max, 'Start');
    expect(AlignTarget(spans[0], from, view, pad, pad, max, 'Nearest')).toBe(from);
  });

  it('Nearest travels the minimum, from whichever edge the section is past', () => {
    const below = spans[1];
    expect(AlignTarget(below, 0, view, pad, pad, max, 'Nearest'))
      .toBe(Math.min(max, below.Start + below.Size + pad - view));   // came up from below: trailing line
    const above = spans[0];
    const parked = 2 * (section + gap);
    expect(AlignTarget(above, parked, view, pad, pad, max, 'Nearest'))
      .toBe(0);                                                       // came down from above: leading line
  });

  it('Nearest shows the START of a section too tall to ever be whole', () => {
    const tall: AlignSpan = { Start: pad + 3 * (section + gap), Size: view * 2 };
    const tallMax = tall.Start + tall.Size + pad - view;
    expect(AlignTarget(tall, 0, view, pad, pad, tallMax, 'Nearest')).toBe(tall.Start - pad);
  });

  it('measures Nearest from the PENDING target, so two jumps compose', () => {
    // A press while an ease is still in flight must judge against where the
    // scroll is GOING, or the second jump re-decides from a position halfway
    // through an animation and lands somewhere nobody asked for.
    const pending = 2 * (section + gap);
    expect(AlignTarget(spans[2], pending, view, pad, pad, max, 'Nearest')).toBe(pending);
  });

  it('never returns a target outside the content', () => {
    for (const s of spans) {
      for (const align of ['Start', 'Center', 'End', 'Nearest'] as const) {
        const t = AlignTarget(s, 0, view, pad, pad, max, align);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(max);
      }
    }
  });
});
