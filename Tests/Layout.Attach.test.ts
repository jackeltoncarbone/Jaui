import { describe, it, expect } from 'vitest';
import { Jiv } from '@jaui/Jiv/Jiv';
import { SolveLayout } from '@jaui/Layout/Layout.Solver';

describe('Attach positioning mode', () => {

  it('Anchor mode: self-center on target-center produces centered rect', () => {
    const root = new Jiv({ Width: 400, Height: 300 });

    const target = new Jiv({
      ChildLayout: { Position: 'Placed', Width: 200, Height: 100 },
      X: 100, Y: 100, Width: 200, Height: 100,
    });
    root.AddChild(target);

    const attached = new Jiv({
      ChildLayout: {
        Position: 'Attach',
        AttachTo: target,
        AttachMode: 'Anchor',
        AttachTargetAnchor: { X: 0.5, Y: 0.5 },
        AttachSelfAnchor: { X: 0.5, Y: 0.5 },
        Width: 60, Height: 30,
      },
    });
    root.AddChild(attached);

    const res = SolveLayout(root);
    const r = res.get(attached)!;
    expect(r.Width).toBe(60);
    expect(r.Height).toBe(30);
    expect(r.X).toBe(100 + 100 - 30);  // target.X + target.W/2 - self.W/2 = 170
    expect(r.Y).toBe(100 + 50 - 15);   // 135
  });

  it('Fill mode: self fills target rect minus inset', () => {
    const root = new Jiv({ Width: 400, Height: 300 });
    const target = new Jiv({
      ChildLayout: { Position: 'Placed', Width: 200, Height: 100 },
      X: 100, Y: 100, Width: 200, Height: 100,
    });
    root.AddChild(target);

    const attached = new Jiv({
      ChildLayout: {
        Position: 'Attach',
        AttachTo: target,
        AttachMode: 'Fill',
        AttachInset: '10 20 10 20',  // top, right, bottom, left
      },
    });
    root.AddChild(attached);

    const res = SolveLayout(root);
    const r = res.get(attached)!;
    expect(r.X).toBe(100 + 20);         // +left
    expect(r.Y).toBe(100 + 10);         // +top
    expect(r.Width).toBe(200 - 20 - 20); // -left -right
    expect(r.Height).toBe(100 - 10 - 10);
  });

  it('AttachOffsetX/Y shifts the anchored self', () => {
    const root = new Jiv({ Width: 400, Height: 300 });
    const target = new Jiv({
      ChildLayout: { Position: 'Placed', Width: 100, Height: 100 },
      X: 50, Y: 50, Width: 100, Height: 100,
    });
    root.AddChild(target);

    const attached = new Jiv({
      ChildLayout: {
        Position: 'Attach',
        AttachTo: target,
        AttachTargetAnchor: { X: 0.5, Y: 0.5 },
        AttachSelfAnchor: { X: 0.5, Y: 0.5 },
        AttachOffsetX: 20, AttachOffsetY: -10,
        Width: 40, Height: 20,
      },
    });
    root.AddChild(attached);

    const res = SolveLayout(root);
    const r = res.get(attached)!;
    // target center = (100, 100); self center offset = (50, 100 - 10 = 90)... wait let me redo
    // target.X=50, W=100 → centerX=100. self.W=40, selfAnchor.X=0.5 → selfAX=20
    // X = targetCX - selfAX + offsetX = 100 - 20 + 20 = 100
    expect(r.X).toBe(100);
    // targetCY=100, selfAY=10. Y = 100 - 10 - 10 = 80
    expect(r.Y).toBe(80);
  });

  it('Changing AttachTo re-resolves on next solve', () => {
    const root = new Jiv({ Width: 400, Height: 400 });
    const a = new Jiv({
      ChildLayout: { Position: 'Placed', Width: 50, Height: 50 },
      X: 0, Y: 0, Width: 50, Height: 50,
    });
    const b = new Jiv({
      ChildLayout: { Position: 'Placed', Width: 50, Height: 50 },
      X: 200, Y: 200, Width: 50, Height: 50,
    });
    const attached = new Jiv({
      ChildLayout: { Position: 'Attach', AttachTo: a, Width: 10, Height: 10 },
    });
    root.AddChild(a);
    root.AddChild(b);
    root.AddChild(attached);

    const res1 = SolveLayout(root);
    expect(res1.get(attached)?.X).toBe(20);  // a-center - self-center = 25 - 5 = 20

    attached.ChildLayout.AttachTo = b;
    const res2 = SolveLayout(root);
    expect(res2.get(attached)?.X).toBe(220); // b-center - self-center = 225 - 5 = 220
  });

  it('Chain: A attaches to B which attaches to C — resolves in ≤ N iterations', () => {
    const root = new Jiv({ Width: 500, Height: 500 });
    const c = new Jiv({
      ChildLayout: { Position: 'Placed', Width: 100, Height: 100 },
      X: 100, Y: 100, Width: 100, Height: 100,
    });
    const b = new Jiv({
      ChildLayout: { Position: 'Attach', AttachTo: c, Width: 40, Height: 40 },
    });
    const a = new Jiv({
      ChildLayout: { Position: 'Attach', AttachTo: b, Width: 10, Height: 10 },
    });
    root.AddChild(c);
    root.AddChild(b);
    root.AddChild(a);

    const res = SolveLayout(root);
    // c center = (150, 150); b is 40x40 centered on c → b at (130, 130)
    // a is 10x10 centered on b center (150, 150) → a at (145, 145)
    expect(res.get(b)?.X).toBe(130);
    expect(res.get(a)?.X).toBe(145);
  });

  it('Null AttachTo leaves node unresolved (no crash)', () => {
    const root = new Jiv({ Width: 400, Height: 300 });
    const attached = new Jiv({
      ChildLayout: { Position: 'Attach', AttachTo: null },
    });
    root.AddChild(attached);

    const res = SolveLayout(root);
    expect(res.get(attached)).toBeUndefined();
  });
});
