import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { SolveLayout } from '../src/Layout/Layout.Solver';
import { ComputeIntrinsicSizes } from '../src/Layout/Layout.Intrinsic';

describe('Text / intrinsic size integration', () => {
  it('text node with Auto width uses IntrinsicWidth', () => {
    const root = new Jiv({ Width: 400, Height: 200, Layout: { Direction: 'Row' } });
    const label = new Jiv();
    label.IntrinsicWidth = 80;
    label.IntrinsicHeight = 20;
    root.AddChild(label);

    const results = SolveLayout(root);
    const r = results.get(label)!;
    expect(r.Width).toBe(80);
    // Column cross (default Align=Stretch) → height stretches
  });

  it('text node with Auto height uses IntrinsicHeight in column layout', () => {
    const root = new Jiv({ Width: 400, Height: 300, Layout: { Direction: 'Column' } });
    const label = new Jiv();
    label.IntrinsicWidth = 120;
    label.IntrinsicHeight = 24;
    root.AddChild(label);

    const results = SolveLayout(root);
    const r = results.get(label)!;
    expect(r.Height).toBe(24);
  });

  it('text node with explicit width ignores IntrinsicWidth', () => {
    const root = new Jiv({ Width: 400, Height: 200, Layout: { Direction: 'Row' } });
    const label = new Jiv({ ChildLayout: { Width: 200 } });
    label.IntrinsicWidth = 50;
    root.AddChild(label);

    const results = SolveLayout(root);
    expect(results.get(label)!.Width).toBe(200);
  });

  it('text node alongside flex-grow siblings', () => {
    const root = new Jiv({ Width: 400, Height: 200, Layout: { Direction: 'Row' } });
    const label = new Jiv();
    label.IntrinsicWidth = 80;
    label.IntrinsicHeight = 20;
    const spacer = new Jiv({ ChildLayout: { FlexGrow: 1 } });
    root.AddChild(label);
    root.AddChild(spacer);

    const results = SolveLayout(root);
    expect(results.get(label)!.Width).toBe(80);
    expect(results.get(spacer)!.Width).toBe(320); // 400 - 80
  });

  it('column layout: intrinsic heights stack with grow sibling', () => {
    const root = new Jiv({ Width: 200, Height: 300, Layout: { Direction: 'Column' } });
    const header = new Jiv();
    header.IntrinsicWidth = 100;
    header.IntrinsicHeight = 40;
    const body = new Jiv({ ChildLayout: { FlexGrow: 1 } });
    root.AddChild(header);
    root.AddChild(body);

    const results = SolveLayout(root);
    expect(results.get(header)!.Height).toBe(40);
    expect(results.get(body)!.Height).toBe(260);
  });

  it('constructor Text sets DirtyFlag.Text', () => {
    const j = new Jiv({ Text: 'Hello' });
    expect(j.Text).toBe('Hello');
    // DirtyFlag.Text = 0b10000000 = 128
    expect(j.Dirty & 128).toBeGreaterThan(0);
  });

  it('SetText updates content and marks dirty', () => {
    const j = new Jiv();
    expect(j.Text).toBeNull();
    j.Dirty = 0; // clear initial flags
    j.SetText('Updated');
    expect(j.Text).toBe('Updated');
    expect(j.Dirty & 128).toBeGreaterThan(0); // Text
    expect(j.Dirty & 1).toBeGreaterThan(0); // Layout
  });

  it('SetText with style merges style fields', () => {
    const j = new Jiv({ TextStyle: { FontSize: '16' } });
    j.SetText('X', { FontSize: '24', Color: 'rgb(255, 0, 0)' });
    expect(j.TextStyle.FontSize).toBe('24');
    expect(j.TextStyle.Color).toBe('rgb(255, 0, 0)');
  });

  it('Jiv constructor TextStyle partial overrides defaults', () => {
    const j = new Jiv({ TextStyle: { FontSize: '20', FontWeight: 700 } });
    expect(j.TextStyle.FontSize).toBe('20');
    expect(j.TextStyle.FontWeight).toBe(700);
    expect(j.TextStyle.FontFamily).toBe('system-ui');
  });

  // ─── Cross-axis Stretch should override intrinsic width ───

  it('BUG: text child in Column with Align=Stretch stretches to parent width, not intrinsic', () => {
    // Parent: Column direction, Align=Stretch. Child has IntrinsicWidth=70.
    // Expected: child stretches to parent's cross (width) = 400, NOT 70.
    const root = new Jiv({
      Width: 400,
      Height: 200,
      Layout: { Direction: 'Column', Align: 'Stretch' },
    });
    const textChild = new Jiv({ ChildLayout: { Height: 40 } });
    textChild.IntrinsicWidth = 70;
    textChild.IntrinsicHeight = 20;
    root.AddChild(textChild);

    const results = SolveLayout(root);
    expect(results.get(textChild)!.Width).toBe(400); // stretches across cross axis
    expect(results.get(textChild)!.Height).toBe(40); // explicit main
  });

  it('text child in Column with Align=Center uses intrinsic width (cross)', () => {
    const root = new Jiv({
      Width: 400,
      Height: 200,
      Layout: { Direction: 'Column', Align: 'Center' },
    });
    const textChild = new Jiv({ ChildLayout: { Height: 40 } });
    textChild.IntrinsicWidth = 70;
    textChild.IntrinsicHeight = 20;
    root.AddChild(textChild);

    const results = SolveLayout(root);
    expect(results.get(textChild)!.Width).toBe(70); // uses intrinsic for center alignment
  });

  it('text child in Row with Align=Stretch stretches to parent height (cross)', () => {
    const root = new Jiv({
      Width: 400,
      Height: 200,
      Layout: { Direction: 'Row', Align: 'Stretch' },
    });
    const textChild = new Jiv({ ChildLayout: { Width: 80 } });
    textChild.IntrinsicWidth = 80;
    textChild.IntrinsicHeight = 20;
    root.AddChild(textChild);

    const results = SolveLayout(root);
    expect(results.get(textChild)!.Height).toBe(200); // stretches across cross
    expect(results.get(textChild)!.Width).toBe(80);
  });

  it('AlignSelf=Stretch overrides AlignItems when child has intrinsic size', () => {
    const root = new Jiv({
      Width: 400,
      Height: 200,
      Layout: { Direction: 'Column', Align: 'Start' },
    });
    const child = new Jiv({ ChildLayout: { Height: 30, AlignSelf: 'Stretch' } });
    child.IntrinsicWidth = 50;
    child.IntrinsicHeight = 15;
    root.AddChild(child);

    const results = SolveLayout(root);
    expect(results.get(child)!.Width).toBe(400); // AlignSelf:Stretch wins over intrinsic
  });

  // ─── Container intrinsic size from children ───

  it('BUG: Row container computes IntrinsicWidth from children', () => {
    // Parent: Row, containerNode (Auto/Auto) with 3 fixed children
    // Expected: containerNode.IntrinsicWidth ≈ 3*50 + 2*10 = 170 (plus any padding)
    const parent = new Jiv({
      Width: 400,
      Height: 100,
      Layout: { Direction: 'Row' },
    });
    const containerNode = new Jiv({
      Layout: { Direction: 'Row', Gap: 10 },
      ChildLayout: { FlexGrow: 0 },
    });
    const child1 = new Jiv({ ChildLayout: { Width: 50, Height: 30 } });
    const child2 = new Jiv({ ChildLayout: { Width: 50, Height: 30 } });
    const child3 = new Jiv({ ChildLayout: { Width: 50, Height: 30 } });
    containerNode.AddChild(child1);
    containerNode.AddChild(child2);
    containerNode.AddChild(child3);
    parent.AddChild(containerNode);

    // The "compute container intrinsics" step should happen before SolveLayout.
    // This test uses the helper directly.
    ComputeIntrinsicSizes(parent);

    expect(containerNode.IntrinsicWidth).toBe(170); // 3*50 + 2*10
    expect(containerNode.IntrinsicHeight).toBe(30);
  });

  it('Column container computes IntrinsicHeight from children', () => {
    const parent = new Jiv({ Width: 200, Height: 400 });
    const containerNode = new Jiv({ Layout: { Direction: 'Column', Gap: 8 } });
    const child1 = new Jiv({ ChildLayout: { Width: 100, Height: 20 } });
    const child2 = new Jiv({ ChildLayout: { Width: 100, Height: 20 } });
    containerNode.AddChild(child1);
    containerNode.AddChild(child2);
    parent.AddChild(containerNode);

    ComputeIntrinsicSizes(parent);

    expect(containerNode.IntrinsicHeight).toBe(48); // 2*20 + 8 gap
    expect(containerNode.IntrinsicWidth).toBe(100);
  });

  it('Container intrinsic includes padding', () => {
    const parent = new Jiv({ Width: 400, Height: 200 });
    const c = new Jiv({
      Layout: { Direction: 'Row', Gap: 0, Padding: '10 20 10 20' },
    });
    const child = new Jiv({ ChildLayout: { Width: 50, Height: 30 } });
    c.AddChild(child);
    parent.AddChild(c);

    ComputeIntrinsicSizes(parent);

    expect(c.IntrinsicWidth).toBe(90);  // 50 + 20 + 20 padding
    expect(c.IntrinsicHeight).toBe(50); // 30 + 10 + 10 padding
  });

  it('BUG: text node intrinsic size includes the node\'s own padding', () => {
    // A button: has Text + Padding. Its IntrinsicWidth should be text width + left/right padding.
    // Simulate MeasureText having run: set TextMeasurement manually.
    const btn = new Jiv({ Layout: { Padding: '8 14 8 14' } });
    btn.Text = 'Save';
    btn.TextMeasurement = { Width: 30, MinWidth: 30, Height: 20, Lines: ['Save'] };

    ComputeIntrinsicSizes(btn);

    // Text 30 wide + 14 + 14 padding = 58
    expect(btn.IntrinsicWidth).toBe(58);
    expect(btn.IntrinsicHeight).toBe(36); // 20 + 8 + 8
  });

  it('BUG: button in Row container uses padded intrinsic width', () => {
    // Full integration: button Auto-width should resolve to text+padding via SolveLayout
    const header = new Jiv({ Width: 800, Height: 60, Layout: { Direction: 'Row' } });
    const btn = new Jiv({
      Layout: { Padding: '8 14 8 14' },
      ChildLayout: { FlexGrow: 0, Height: 36 },
    });
    btn.Text = 'Save';
    btn.TextMeasurement = { Width: 30, MinWidth: 30, Height: 20, Lines: ['Save'] };
    header.AddChild(btn);

    ComputeIntrinsicSizes(header);
    const results = SolveLayout(header);
    expect(results.get(btn)!.Width).toBe(58); // padded intrinsic
  });

  it('BUG integration: Auto-width container sizes to fit its buttons', () => {
    // Simulates the playground "actions" bug: a Row container with no explicit width
    // should compute its width from its children so it doesn't render at 0.
    const header = new Jiv({
      Width: 800,
      Height: 60,
      Layout: { Direction: 'Row', Justify: 'SpaceBetween', Align: 'Center' },
    });
    const title = new Jiv({ ChildLayout: { FlexGrow: 0 } });
    title.IntrinsicWidth = 100;
    title.IntrinsicHeight = 24;

    const actions = new Jiv({
      Layout: { Direction: 'Row', Gap: 8 },
      ChildLayout: { FlexGrow: 0 },
    });
    const btn1 = new Jiv({ ChildLayout: { Width: 60, Height: 36 } });
    const btn2 = new Jiv({ ChildLayout: { Width: 60, Height: 36 } });
    const btn3 = new Jiv({ ChildLayout: { Width: 60, Height: 36 } });
    actions.AddChild(btn1);
    actions.AddChild(btn2);
    actions.AddChild(btn3);

    header.AddChild(title);
    header.AddChild(actions);

    ComputeIntrinsicSizes(header);

    expect(actions.IntrinsicWidth).toBe(60 * 3 + 8 * 2); // 196
    expect(actions.IntrinsicHeight).toBe(36);

    // After intrinsic computed, layout solve should use it
    const results = SolveLayout(header);
    expect(results.get(actions)!.Width).toBe(196);
    expect(results.get(btn1)!.Width).toBe(60);
  });
});
