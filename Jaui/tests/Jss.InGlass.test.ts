import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { ParseJss } from '../src/Jss/Jss.Parser';

// `InGlass`: the engine's ancestry state. iOS 26 puts no glass on glass, so a glass control inside a glass container is
// styled as a fill there; the engine answers the state from the live tree, never from anything an author sets.

const SHEET = ParseJss(`
Pane {
  Glass: Regular
}
Control {
  Glass: Regular
}
Control:InGlass {
  Glass: None
  BackdropFilter: Vibrancy(9)
}
`).Sheet;

const node = (cls: 'Pane' | 'Control' | null): Jiv => {
  const rule = cls === null ? null : SHEET[cls];
  return new Jiv({ Style: { ...(rule?.Style ?? {}) }, PredicateStyles: rule?.PredicateStyles });
};

describe('InGlass is answered from the tree', () => {
  it('a control over content keeps its glass', () => {
    const root = node(null);
    const control = node('Control');
    root.AddChild(control);
    expect(control.EffectiveStyle().Glass).toBe('Regular');
  });

  it('a control anywhere inside a glass pane is a fill', () => {
    const root = node(null);
    const pane = node('Pane');
    const row = node(null);
    const control = node('Control');
    root.AddChild(pane);
    pane.AddChild(row);
    row.AddChild(control);
    expect(control.EffectiveStyle().Glass).toBe('None');
    expect(control.EffectiveStyle().BackdropFilter).toContain('Vibrancy');
  });

  it('moved out of the pane (a popover presented over it), it is glass again', () => {
    const root = node(null);
    const pane = node('Pane');
    const outlet = node(null);
    const control = node('Control');
    root.AddChild(pane);
    root.AddChild(outlet);
    pane.AddChild(control);
    expect(control.EffectiveStyle().Glass).toBe('None');
    outlet.AddChild(control);
    expect(control.EffectiveStyle().Glass).toBe('Regular');
  });

  it('an author cannot set it: only the tree can', () => {
    const root = node(null);
    const control = node('Control');
    root.AddChild(control);
    control.SetState('InGlass', true);
    expect(control.EffectiveStyle().Glass).toBe('Regular');
  });
});
