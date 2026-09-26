import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { InertUnderDisabled } from '../src/Core/Pointer.Inert';

// A disabled control takes no press: not on itself, and not through its own label or glyph, whose click would
// otherwise bubble to the control's (click) binding on the main thread.
describe('a disabled node receives no press', () => {
  const button = (): { Button: Jiv; Label: Jiv } => {
    const Button = new Jiv({});
    const Label = new Jiv({});
    Button.AddChild(Label);
    return { Button, Label };
  };

  it('an enabled control takes the press where it lands', () => {
    const { Button, Label } = button();
    expect(InertUnderDisabled(Label)).toBe(Label);
    expect(InertUnderDisabled(Button)).toBe(Button);
    expect(InertUnderDisabled(null)).toBeNull();
  });

  it('a disabled control and everything inside it are inert', () => {
    const { Button, Label } = button();
    Button.Disabled = true;
    expect(InertUnderDisabled(Button)).toBeNull();
    expect(InertUnderDisabled(Label)).toBeNull();
  });

  it('enabling it again restores the press', () => {
    const { Button, Label } = button();
    Button.Disabled = true;
    Button.Disabled = false;
    expect(InertUnderDisabled(Label)).toBe(Label);
  });
});
