import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { JivAnimator } from '../src/Jiv/Jiv.Animator';
import { JivRegistry } from '../src/Worker/Jiv.Registry';
import type { M2W_JivOps } from '../src/Worker/Bridge.Types';

// Teleport = a LIVE reparent (AddChild while already mounted elsewhere). The flight
// itself is the existing rect-spring machinery (the solver re-targets, the animator
// springs); these tests pin the teleport-specific contracts: the recency stamp, its
// settle-clear, leave-free movement, and spring continuity across the move.

describe('Teleport — Element.AddChild live-reparent stamping', () => {
  it('stamps a monotonic TeleportSeq on a live reparent, not on first mount', () => {
    const root = new Jiv({ Width: 400, Height: 300 });
    const a = new Jiv({});
    const b = new Jiv({});
    const child = new Jiv({});
    root.AddChild(a);
    root.AddChild(b);

    a.AddChild(child);                       // first mount — not a teleport
    expect(child.TeleportSeq).toBe(0);

    b.AddChild(child);                       // live move a → b — teleport
    const seq1 = child.TeleportSeq;
    expect(seq1).toBeGreaterThan(0);
    expect(child.Parent).toBe(b);
    expect(a.Children).not.toContain(child);

    a.AddChild(child);                       // move back — newer seq
    expect(child.TeleportSeq).toBeGreaterThan(seq1);
  });

  it('same-parent re-add (reorder) does not stamp', () => {
    const root = new Jiv({ Width: 400, Height: 300 });
    const child = new Jiv({});
    root.AddChild(child);
    root.AddChild(child);
    expect(child.TeleportSeq).toBe(0);
  });

  it('the move is leave-free: no Presence fade is triggered', () => {
    const root = new Jiv({ Width: 400, Height: 300 });
    const a = new Jiv({});
    const b = new Jiv({});
    const child = new Jiv({});
    root.AddChild(a);
    root.AddChild(b);
    a.AddChild(child);
    b.AddChild(child);
    expect(child.LeaveRequested).toBe(false);
    expect(child.PresenceSpring.Target).toBe(1);
  });
});

describe('Teleport — spring continuity and settle-clear (JivAnimator)', () => {
  it('reparent does not snap: the spring flies from the old rect to the new', () => {
    const root = new Jiv({ Width: 400, Height: 300 });
    const a = new Jiv({});
    const b = new Jiv({});
    const child = new Jiv({});
    root.AddChild(a);
    root.AddChild(b);
    a.AddChild(child);

    // Element settled at (10, 10) under parent a.
    child.X = 10; child.Y = 10; child.Width = 50; child.Height = 50;
    const anim = new JivAnimator(child);     // springs seeded from current rect

    b.AddChild(child);                       // teleport; solver would now target (200, 100)
    anim.SetTargets({ X: 200, Y: 100, Width: 50, Height: 50 });

    anim.Tick(1 / 60);
    expect(child.X).toBeGreaterThan(10);     // moving…
    expect(child.X).toBeLessThan(200);       // …but NOT snapped — mid-flight
    expect(child.TeleportSeq).toBeGreaterThan(0); // still elevated mid-flight
  });

  it('clears TeleportSeq when the rect springs settle', () => {
    const child = new Jiv({});
    child.X = 0; child.Y = 0; child.Width = 10; child.Height = 10;
    const anim = new JivAnimator(child);
    child.TeleportSeq = 7;

    anim.SetTargets({ X: 40 });
    for (let i = 0; i < 600 && anim.Tick(1 / 60); i++) { /* fly to rest */ }
    anim.Tick(1 / 60);                       // the settle frame observes inactivity
    expect(child.X).toBeCloseTo(40, 1);
    expect(child.TeleportSeq).toBe(0);
  });

  it('SnapToTargets clears TeleportSeq immediately', () => {
    const child = new Jiv({});
    const anim = new JivAnimator(child);
    child.TeleportSeq = 3;
    anim.SnapToTargets();
    expect(child.TeleportSeq).toBe(0);
  });
});

describe('Teleport — registry attach op is the move (order-preserving, leave-free)', () => {
  const apply = (reg: JivRegistry, ops: M2W_JivOps['Ops']): void =>
    reg.ApplyOps({ T: 'jiv-ops', Ops: ops });

  it('a second attach with a different parent moves the node', () => {
    const root = new Jiv({ Width: 400, Height: 300 });
    const reg = new JivRegistry(root, () => {});
    apply(reg, [
      { K: 'create', Id: 1, Opts: {} },      // outlet A
      { K: 'create', Id: 2, Opts: {} },      // outlet B
      { K: 'create', Id: 3, Opts: {} },      // the surface
      { K: 'attach', ChildId: 1, ParentId: 0 },
      { K: 'attach', ChildId: 2, ParentId: 0 },
      { K: 'attach', ChildId: 3, ParentId: 1 },
    ]);
    const a = reg.Get(1)!;
    const b = reg.Get(2)!;
    const child = reg.Get(3)!;
    expect(child.Parent).toBe(a);
    expect(child.TeleportSeq).toBe(0);

    apply(reg, [{ K: 'attach', ChildId: 3, ParentId: 2 }]);  // teleport A → B
    expect(child.Parent).toBe(b);
    expect(a.Children).not.toContain(child);
    expect(b.Children).toContain(child);
    expect(child.TeleportSeq).toBeGreaterThan(0);
    expect(child.LeaveRequested).toBe(false);
  });
});
