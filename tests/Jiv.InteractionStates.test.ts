import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';

describe('Jiv interaction states', () => {

  it('EffectiveStyle returns base reference when no state active (no alloc)', () => {
    const j = new Jiv({ Style: { Opacity: 0.5 } });
    const eff = j.EffectiveStyle();
    expect(eff).toBe(j.Style); // same reference
  });

  it('Hover overrides specific props when Hover=true', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      HoverStyle: { Opacity: 0.7 },
    });
    expect(j.EffectiveStyle().Opacity).toBe(1.0);
    j.Hover = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.7);
  });

  it('priority order: Disabled > Focus > Active > Hover', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      HoverStyle: { Opacity: 0.9 },
      ActiveStyle: { Opacity: 0.8 },
      FocusStyle: { Opacity: 0.7 },
      DisabledStyle: { Opacity: 0.3 },
    });

    j.Hover = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.9);

    j.Active = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.8); // Active over Hover

    j.Focus = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.7); // Focus over Active

    j.Disabled = true;
    expect(j.EffectiveStyle().Opacity).toBe(0.3); // Disabled wins all
  });

  it('missing state style → falls through to base', () => {
    const j = new Jiv({ Style: { Opacity: 0.5 } });
    j.Hover = true; // no HoverStyle
    expect(j.EffectiveStyle().Opacity).toBe(0.5);
  });

  it('base unchanged after merge — does not mutate', () => {
    const j = new Jiv({
      Style: { Opacity: 1.0 },
      HoverStyle: { Opacity: 0.5 },
    });
    j.Hover = true;
    j.EffectiveStyle();
    expect(j.Style.Opacity).toBe(1.0); // base preserved
  });
});
