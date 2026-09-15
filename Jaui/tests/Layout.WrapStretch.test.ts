import { describe, it, expect } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { SolveLayout } from '../src/Layout/Layout.Solver';
import { ComputeIntrinsicSizes } from '../src/Layout/Layout.Intrinsic';
import { SolveFlex, type FlexContainer, type FlexChild } from '../src/Layout/Layout.Flex';

// CSS flexbox §9.4: in a MULTI-LINE container, Align Stretch sizes an auto-cross item to its own LINE's
// cross size, and a line is as tall as its tallest item. Only a single-line container stretches to the
// container's inner cross size.

const solve = (root: Jiv, vw: number, vh: number) => {
  ComputeIntrinsicSizes(root, { Width: vw, Height: vh });
  return SolveLayout(root, { Width: vw, Height: vh });
};

/** A chip: fixed width, Auto height, its height coming from a 32-tall label inside. */
const chip = (width: number, labelHeight = 32): Jiv => {
  const c = new Jiv({ ChildLayout: { Width: String(width), Height: 'Auto' } });
  c.AddChild(new Jiv({ ChildLayout: { Height: String(labelHeight) } }));
  return c;
};

describe('Wrap + Align Stretch stretches to the line, not the container', () => {
  it('an auto-height wrapping chip row keeps every chip one line tall', () => {
    const root = new Jiv({ Width: 300, Height: 800, Layout: { Direction: 'Column', Align: 'Stretch' } });
    const row = new Jiv({ Layout: { Direction: 'Row', Wrap: 'Wrap', Align: 'Stretch', Gap: '8' } });
    const chips = [chip(120), chip(120), chip(120)];
    for (const c of chips) row.AddChild(c);
    root.AddChild(row);

    const results = solve(root, 300, 800);
    const rowRect = results.get(row)!;
    // Two lines of 32 with an 8 gap.
    expect(rowRect.Height).toBeCloseTo(72, 3);
    for (const c of chips) expect(results.get(c)!.Height).toBeCloseTo(32, 3);
    expect(results.get(chips[0])!.Y).toBeCloseTo(results.get(chips[1])!.Y, 3);
    // The wrapped chip starts one line + gap down and stays inside the row.
    const third = results.get(chips[2])!;
    expect(third.Y - rowRect.Y).toBeCloseTo(40, 3);
    expect(third.Y + third.Height).toBeLessThanOrEqual(rowRect.Y + rowRect.Height + 0.001);
  });

  it('a line is as tall as its tallest item and its shorter items stretch to it', () => {
    const root = new Jiv({ Width: 300, Height: 800, Layout: { Direction: 'Column', Align: 'Stretch' } });
    const row = new Jiv({ Layout: { Direction: 'Row', Wrap: 'Wrap', Align: 'Stretch', AlignContent: 'Start' }, ChildLayout: { Height: '400' } });
    const chips = [chip(120, 20), chip(120, 50), chip(120, 30)];
    for (const c of chips) row.AddChild(c);
    root.AddChild(row);

    const results = solve(root, 300, 800);
    expect(results.get(chips[0])!.Height).toBeCloseTo(50, 3);
    expect(results.get(chips[1])!.Height).toBeCloseTo(50, 3);
    expect(results.get(chips[2])!.Height).toBeCloseTo(30, 3);
    expect(results.get(chips[2])!.Y - results.get(row)!.Y).toBeCloseTo(50, 3);
  });

  it('SolveFlex: stretched items take their line cross size, lines grow under AlignContent Stretch', () => {
    const container: FlexContainer = {
      Width: 300, Height: 200, Direction: 'Row', Wrap: 'Wrap', Justify: 'Start', Align: 'Stretch',
      AlignContent: 'Stretch', Gap: 0, RowGap: 0, ColumnGap: 0, Padding: [0, 0, 0, 0],
    };
    const item = (index: number, contentCross: number): FlexChild => ({
      Index: index, Order: 0, FlexGrow: 0, FlexShrink: 1, FlexBasis: 'Auto', AlignSelf: 'Auto',
      Margin: [0, 0, 0, 0], Width: 200, Height: 'Auto', ContentCross: contentCross,
      MinWidth: 0, MaxWidth: Infinity, MinHeight: 0, MaxHeight: Infinity,
    });
    const results = SolveFlex(container, [item(0, 40), item(1, 60)]);
    // Two lines (40 + 60) share the 100 of slack: 90 and 110.
    expect(results[0].Height).toBeCloseTo(90, 3);
    expect(results[1].Y).toBeCloseTo(90, 3);
    expect(results[1].Height).toBeCloseTo(110, 3);
  });

  it('a single-line (NoWrap) row still stretches to the container', () => {
    const container: FlexContainer = {
      Width: 300, Height: 200, Direction: 'Row', Wrap: 'NoWrap', Justify: 'Start', Align: 'Stretch',
      AlignContent: 'Stretch', Gap: 0, RowGap: 0, ColumnGap: 0, Padding: [0, 0, 0, 0],
    };
    const results = SolveFlex(container, [{
      Index: 0, Order: 0, FlexGrow: 0, FlexShrink: 1, FlexBasis: 'Auto', AlignSelf: 'Auto',
      Margin: [0, 0, 0, 0], Width: 100, Height: 'Auto', ContentCross: 40,
      MinWidth: 0, MaxWidth: Infinity, MinHeight: 0, MaxHeight: Infinity,
    }]);
    expect(results[0].Height).toBe(200);
  });
});
