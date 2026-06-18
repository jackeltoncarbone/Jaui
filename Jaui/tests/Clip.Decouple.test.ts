import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { SlotFor } from '../src/Jss/Jss.Routes';

// Clip is decoupled from Overflow: Overflow owns scroll + layout, Clip owns
// whether the node shears its descendants. `Auto` preserves the legacy
// Overflow-derived behavior; the explicit values override it.
describe('Clip decoupled from Overflow (ClipsChildren)', () => {
  it('Auto derives from Overflow — Visible does not clip', () => {
    expect(new Jiv({ Overflow: 'Visible' }).ClipsChildren).toBe(false);
  });

  it('Auto derives from Overflow — Hidden and Scroll clip', () => {
    expect(new Jiv({ Overflow: 'Hidden' }).ClipsChildren).toBe(true);
    expect(new Jiv({ Overflow: 'Scroll' }).ClipsChildren).toBe(true);
  });

  it('Clip: Visible un-clips a Scroll box (scroll without shearing)', () => {
    expect(new Jiv({ Overflow: 'Scroll', Clip: 'Visible' }).ClipsChildren).toBe(false);
  });

  it('Clip: Hidden clips a Visible box (clip without scrolling)', () => {
    expect(new Jiv({ Overflow: 'Visible', Clip: 'Hidden' }).ClipsChildren).toBe(true);
  });

  it('defaults to Auto when unset', () => {
    const j = new Jiv({});
    expect(j.Clip).toBe('Auto');
    expect(j.ClipsChildren).toBe(false); // Overflow defaults Visible
  });
});

// Routing regressions: a node-level Clip must reach the Style catch-all (pulled
// onto the element like Overflow), and ParentOverflow must reach ChildLayout —
// it previously fell through to Style and was silently dropped from JSS.
describe('JSS property routing for clip props', () => {
  it('Clip routes to Style (node-level, like Overflow)', () => {
    expect(SlotFor('Clip')).toBe('Style');
    expect(SlotFor('Overflow')).toBe('Style');
  });

  it('ParentOverflow routes to ChildLayout (not dropped to Style)', () => {
    expect(SlotFor('ParentOverflow')).toBe('ChildLayout');
  });
});
