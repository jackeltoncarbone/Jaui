import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { SolveLayout } from '../src/Layout/Layout.Solver';
import { ComputeIntrinsicSizes } from '../src/Layout/Layout.Intrinsic';

describe('Length — end-to-end integration through SolveLayout', () => {
  it('pt resolves against the Jiv\'s PointScale cascade', () => {
    const root = new Jiv({
      Width: 400, Height: 300,
      Style: { PointScale: '10' },
      Layout: { Padding: '1pt' },
    });
    const child = new Jiv();
    root.AddChild(child);

    ComputeIntrinsicSizes(root, { Width: 400, Height: 300 });
    const results = SolveLayout(root, { Width: 400, Height: 300 });

    const r = results.get(child)!;
    expect(r.X).toBe(10);
    expect(r.Y).toBe(10);
    expect(r.Width).toBe(380);
  });

  it('pt cascades to children that don\'t override PointScale', () => {
    const root = new Jiv({
      Width: 400, Height: 300,
      Style: { PointScale: '20' },
    });
    const child = new Jiv({
      Layout: { Padding: '2pt' },
    });
    const grand = new Jiv();
    child.AddChild(grand);
    root.AddChild(child);

    ComputeIntrinsicSizes(root, { Width: 400, Height: 300 });
    const results = SolveLayout(root, { Width: 400, Height: 300 });

    const gr = results.get(grand)!;
    expect(gr.X).toBe(40);
    expect(gr.Y).toBe(40);
  });

  it('child can override its own PointScale relative to parent', () => {
    const root = new Jiv({
      Width: 400, Height: 300,
      Style: { PointScale: '16' },
    });
    const child = new Jiv({
      Style: { PointScale: '2pt' },   // 2× parent = 32
      Layout: { Padding: '1pt' },      // 1 × 32 = 32
    });
    const grand = new Jiv();
    child.AddChild(grand);
    root.AddChild(child);

    ComputeIntrinsicSizes(root, { Width: 400, Height: 300 });
    const results = SolveLayout(root, { Width: 400, Height: 300 });

    const gr = results.get(grand)!;
    expect(gr.X).toBe(32);
    expect(gr.Y).toBe(32);
  });

  it('% resolves against parent dims', () => {
    const root = new Jiv({
      Width: 400, Height: 300,
      Layout: { Padding: '10%' },
    });
    const child = new Jiv();
    root.AddChild(child);

    ComputeIntrinsicSizes(root, { Width: 400, Height: 300 });
    const results = SolveLayout(root, { Width: 400, Height: 300 });

    const r = results.get(child)!;
    expect(r.X).toBe(40);
    expect(r.Y).toBe(30);
  });

  it('%h explicitly uses parent height regardless of field axis', () => {
    const root = new Jiv({
      Width: 400, Height: 200,
      Layout: { Padding: '0 10%h 0 10%h' },
    });
    const child = new Jiv();
    root.AddChild(child);

    ComputeIntrinsicSizes(root, { Width: 400, Height: 200 });
    const results = SolveLayout(root, { Width: 400, Height: 200 });

    const r = results.get(child)!;
    expect(r.X).toBe(20);
    expect(r.Width).toBe(360);
  });

  it('arithmetic in plain string form works in a real layout', () => {
    const root = new Jiv({
      Width: 400, Height: 300,
      Style: { PointScale: '16' },
      Layout: { Padding: '(1pt + 4)' },
    });
    const child = new Jiv();
    root.AddChild(child);

    ComputeIntrinsicSizes(root, { Width: 400, Height: 300 });
    const results = SolveLayout(root, { Width: 400, Height: 300 });

    const r = results.get(child)!;
    expect(r.X).toBe(20);
    expect(r.Y).toBe(20);
  });

  it('rpt anchors to root PointScale even when intermediates override', () => {
    const root = new Jiv({
      Width: 400, Height: 300,
      Style: { PointScale: '16' },
    });
    const outer = new Jiv({
      Style: { PointScale: '100' },
    });
    const inner = new Jiv({
      Layout: { Padding: '1rpt' },
    });
    outer.AddChild(inner);
    root.AddChild(outer);
    const leaf = new Jiv();
    inner.AddChild(leaf);

    ComputeIntrinsicSizes(root, { Width: 400, Height: 300 });
    const results = SolveLayout(root, { Width: 400, Height: 300 });

    const lr = results.get(leaf)!;
    expect(lr.X).toBe(16);
    expect(lr.Y).toBe(16);
  });
});
