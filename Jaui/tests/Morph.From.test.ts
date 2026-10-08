import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { JivAnimator, SpringFromOrigin } from '../src/Jiv/Jiv.Animator';
import { JivRegistry } from '../src/Worker/Jiv.Registry';
import { MORPH_FIRST_STEP_S, STEP_BUDGET_S, StepSpan } from '../src/Animation/Step.Span';

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

describe('the commit spends the origin once, over a snap', () => {
  it('a box with an origin waiting starts there, and the next commit has none to spend', () => {
    const panel = new Jiv({});
    const anim = new JivAnimator(panel);
    anim.SetTargets({ X: 300, Y: 200, Width: 250, Height: 180 });
    anim.SnapToTargets();
    panel.SnapLayout = true;
    panel.MorphFrom = { X: 400, Y: 160, Width: 40, Height: 40 };
    expect(SpringFromOrigin(panel, anim)).toBe(true);
    expect(panel.MorphFrom).toBeNull();
    expect(panel.Width).toBe(40);
    expect(SpringFromOrigin(panel, anim)).toBeNull();
  });
});

// The tick after a morph begins steps one frame, never the time its first (slowest) frame took to draw.
describe('StepSpan: the growth starts from its own first frame', () => {
  it('an ordinary tick steps the time its frame covered, up to the budget', () => {
    expect(StepSpan(0.016, false)).toBeCloseTo(0.016, 9);
    expect(StepSpan(3, false)).toBe(STEP_BUDGET_S);
  });

  it('the tick after a morph begins steps one 60Hz frame, however slow the frame that drew its start', () => {
    expect(StepSpan(0.3, true)).toBe(MORPH_FIRST_STEP_S);
    expect(StepSpan(0.008, true)).toBeCloseTo(0.008, 9);
  });

  it('a 350ms open after a 300ms first frame has barely moved on its next frame', () => {
    const omega = 5 / 0.35;
    const panel = new Jiv({});
    const anim = new JivAnimator(panel, { Width: { Stiffness: omega * omega, Damping: 2 * omega, Mass: 1 } });
    anim.SetTargets({ X: 0, Y: 0, Width: 250, Height: 180 });
    anim.SpringFrom({ X: 0, Y: 0, Width: 40, Height: 40 });
    let left = StepSpan(0.3, true);
    while (left > 1e-9) { const s = Math.min(left, 0.033); anim.Tick(s); left -= s; }
    expect(panel.Width).toBeGreaterThan(40);
    expect(panel.Width).toBeLessThan(40 + 0.1 * 210);
  });
});
