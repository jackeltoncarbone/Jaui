import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { JivAnimator } from '../src/Jiv/Jiv.Animator';
import { JivRegistry } from '../src/Worker/Jiv.Registry';

// `Element.MorphFrom`: a one-shot origin for a node's rect spring. A menu is laid out where it opens and its box
// springs there from the control that opened it, so the control's own glass reads as growing into the menu.

describe('MorphFrom: the box springs from the given origin to its laid out rect', () => {
  it('starts at the origin, moves toward the target, and lands on it', () => {
    const panel = new Jiv({});
    panel.X = 300; panel.Y = 200; panel.Width = 250; panel.Height = 180;
    const anim = new JivAnimator(panel);
    anim.SetTargets({ X: 300, Y: 200, Width: 250, Height: 180 });

    const moves = anim.SpringFrom({ X: 400, Y: 160, Width: 40, Height: 40 });
    expect(moves).toBe(true);
    expect([panel.X, panel.Y, panel.Width, panel.Height]).toEqual([400, 160, 40, 40]);

    anim.Tick(1 / 60);
    expect(panel.Width).toBeGreaterThan(40);
    expect(panel.Width).toBeLessThan(250);
    expect(panel.X).toBeLessThan(400);

    for (let i = 0; i < 240; i++) anim.Tick(1 / 60);
    expect([panel.X, panel.Y, panel.Width, panel.Height]).toEqual([300, 200, 250, 180]);
  });

  it('an origin already on the target does not move', () => {
    const panel = new Jiv({});
    const anim = new JivAnimator(panel);
    anim.SetTargets({ X: 10, Y: 10, Width: 20, Height: 20 });
    anim.SnapToTargets();
    expect(anim.SpringFrom({ X: 10, Y: 10, Width: 20, Height: 20 })).toBe(false);
  });
});

describe('MorphFrom rides the apply op once', () => {
  it('the registry hands the origin to the node and asks for a layout', () => {
    const root = new Jiv({ Width: 400, Height: 300 });
    const reg = new JivRegistry(root, () => {});
    reg.ApplyOps({ T: 'jiv-ops', Ops: [
      { K: 'create', Id: 1, Opts: {} },
      { K: 'attach', ChildId: 1, ParentId: 0 },
    ] });
    const node = reg.Get(1)!;
    expect(node.MorphFrom).toBeNull();
    reg.ApplyOps({ T: 'jiv-ops', Ops: [
      { K: 'apply', Id: 1, Opts: { ElementProps: { MorphFrom: { X: 5, Y: 6, Width: 7, Height: 8 } } } },
    ] });
    expect(node.MorphFrom).toEqual({ X: 5, Y: 6, Width: 7, Height: 8 });
    // An apply without it leaves the waiting origin alone; the layout commit is what spends it.
    reg.ApplyOps({ T: 'jiv-ops', Ops: [{ K: 'apply', Id: 1, Opts: { ElementProps: { Visible: true } } }] });
    expect(node.MorphFrom).toEqual({ X: 5, Y: 6, Width: 7, Height: 8 });
  });
});
