import { describe, it, expect, beforeAll } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { SolveLayout } from '../src/Layout/Layout.Solver';
import { ComputeIntrinsicSizes } from '../src/Layout/Layout.Intrinsic';
import type { TextMeasurement } from '../src/Text/Text.Types';

// Solver re-measures text via MeasureText, which (when no ctx is passed) lazy-
// builds a shared canvas via document.createElement. Tests run under node, so
// we stub document with a fake that returns a 2D context measuring 8px/char —
// matches the convention used by Text.Measure.test.ts's mockCtx().
beforeAll(() => {
  if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
    const fakeCtx = {
      font: '',
      textBaseline: 'middle',
      textAlign: 'left',
      letterSpacing: '',
      measureText: (text: string) => ({ width: text.length * 8 }),
    };
    const fakeCanvas = { width: 1, height: 1, getContext: () => fakeCtx };
    (globalThis as { document: unknown }).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return fakeCanvas;
        return {};
      },
    };
  }
});

// These tests pin down a real layout bug we hit on the DrillAgent demo page:
// a sidebar of single-text-child rows with text labels longer than the rail.
//
// Pre-fix: text intrinsic was always measured unbounded (1 line). When the
// row's allocated width was smaller than the unbounded text width, the row
// rendered the text wrapped (multi-line) but kept its 1-line layout height
// — so neighbouring rows visually overlapped. With MaxLines:1 + Ellipsis,
// the ellipsis path never engaged because measurement was unbounded so no
// truncation was needed.
//
// Post-fix: the Solver re-measures text at the available width budget for
// both Column and Row direction parents, so finalH reflects the actual
// wrapped line count and ellipsis kicks in when MaxLines is set.

const _measure = (width: number, lines: string[], lineHeight: number = 16): TextMeasurement => ({
  Width: width,
  MinWidth: width,
  Height: lineHeight * lines.length,
  Lines: lines,
});

describe('Layout — Row-direction text wrap (was column-only)', () => {

  it('row child text wraps and grows row height when text wider than parent budget', () => {
    // LeftRail (column, 280 wide) → ExampleRow (row, single text child).
    // Text natural width 500 > rail content width ~ 280 → wrap to 2 lines.
    const rail = new Jiv({
      Width: 280,
      Height: 600,
      Layout: { Direction: 'Column', Padding: '0 0 0 0' },
    });
    const row = new Jiv({
      Layout: { Direction: 'Row', Padding: '8 12 8 12' },
      // No explicit Height — should grow to wrapped text height + padding.
    });
    const label = new Jiv();
    label.Text = 'a long label that does not fit on one line in the rail';
    label.TextMeasurement = _measure(500, ['a long label that does not fit on one line in the rail']);
    label.IntrinsicWidth = 500;
    label.IntrinsicHeight = 16;
    label.IntrinsicMinWidth = 30;
    label.IntrinsicMinHeight = 16;
    row.AddChild(label);
    rail.AddChild(row);

    ComputeIntrinsicSizes(rail);
    const r = SolveLayout(rail);

    const rowRect = r.get(row)!;
    // Available text width inside row = 280 (rail) - 12 - 12 (row padding) = 256.
    // 500-px wide text wraps; the solver should re-measure and grow the row.
    // Height should be > 1 line + padding = 16 + 16 = 32.
    expect(rowRect.Height).toBeGreaterThan(32);
  });

  it('row child text with MaxLines:1 + Ellipsis stays single-line height', () => {
    const rail = new Jiv({
      Width: 280,
      Height: 600,
      Layout: { Direction: 'Column', Padding: '0 0 0 0' },
    });
    const row = new Jiv({
      Layout: { Direction: 'Row', Padding: '8 12 8 12' },
    });
    const label = new Jiv({
      TextStyle: { MaxLines: '1', TextOverflow: 'Ellipsis', LineHeight: '1' },
    });
    label.Text = 'a long label that does not fit on one line';
    label.TextMeasurement = _measure(500, ['a long label that does not fit on one line']);
    label.IntrinsicWidth = 500;
    label.IntrinsicHeight = 16;
    label.IntrinsicMinWidth = 30;
    label.IntrinsicMinHeight = 16;
    row.AddChild(label);
    rail.AddChild(row);

    ComputeIntrinsicSizes(rail);
    const r = SolveLayout(rail);

    const rowRect = r.get(row)!;
    // Even though raw text is 500 wide, MaxLines:1 + Ellipsis should clamp
    // the wrapped Height to 1 line. With LineHeight:1 + FontSize:16, that's
    // a 16-px line + 16-px padding = 32. (Default LineHeight 1.2 → 35.2.)
    expect(rowRect.Height).toBe(32);
  });

  it('row child text that fits stays at single-line row height', () => {
    // Control: a short label should not trigger any re-measure.
    const rail = new Jiv({
      Width: 280,
      Height: 600,
      Layout: { Direction: 'Column', Padding: '0 0 0 0' },
    });
    const row = new Jiv({
      Layout: { Direction: 'Row', Padding: '8 12 8 12' },
      ChildLayout: { MinHeight: 32 },
    });
    const label = new Jiv();
    label.Text = 'fm 8';
    label.TextMeasurement = _measure(40, ['fm 8']);
    label.IntrinsicWidth = 40;
    label.IntrinsicHeight = 16;
    label.IntrinsicMinWidth = 24;
    label.IntrinsicMinHeight = 16;
    row.AddChild(label);
    rail.AddChild(row);

    ComputeIntrinsicSizes(rail);
    const r = SolveLayout(rail);

    expect(r.get(row)!.Height).toBe(32);
  });

  it('two stacked rows with long text do not visually overlap', () => {
    // The actual sidebar bug: rows stacked without Gap. Each row's resolved
    // Height must be ≥ what its wrapped text needs, otherwise rows overlap.
    const rail = new Jiv({
      Width: 280,
      Height: 600,
      Layout: { Direction: 'Column', Padding: '0 0 0 0', Gap: 0 },
    });

    const makeRow = (text: string, naturalWidth: number) => {
      const row = new Jiv({ Layout: { Direction: 'Row', Padding: '8 12 8 12' } });
      const label = new Jiv();
      label.Text = text;
      label.TextMeasurement = _measure(naturalWidth, [text]);
      label.IntrinsicWidth = naturalWidth;
      label.IntrinsicHeight = 16;
      label.IntrinsicMinWidth = 30;
      label.IntrinsicMinHeight = 16;
      row.AddChild(label);
      return row;
    };

    const r1 = makeRow('the brass forms a wedge then they march forward 16', 480);
    const r2 = makeRow('half the band turns left while the other half turns right', 520);
    rail.AddChild(r1);
    rail.AddChild(r2);

    ComputeIntrinsicSizes(rail);
    const r = SolveLayout(rail);

    const r1Rect = r.get(r1)!;
    const r2Rect = r.get(r2)!;
    // r2 should sit at or after r1's bottom edge — i.e., r2.Y >= r1.Y + r1.Height.
    // Pre-fix this failed because both rows reported 1-line heights but rendered
    // multi-line, so r2 visually started before r1 finished.
    expect(r2Rect.Y).toBeGreaterThanOrEqual(r1Rect.Y + r1Rect.Height - 0.5);
  });

  it('regression — column-direction parent text wrap still works', () => {
    // This is the original column behavior (line 401 of Solver.ts before edit).
    // The new generalized block must not regress it.
    const root = new Jiv({
      Width: 200,
      Height: 600,
      Layout: { Direction: 'Column', Padding: '0 0 0 0' },
    });
    const label = new Jiv();
    label.Text = 'a long label that wraps in a narrow column';
    label.TextMeasurement = _measure(400, ['a long label that wraps in a narrow column']);
    label.IntrinsicWidth = 400;
    label.IntrinsicHeight = 16;
    label.IntrinsicMinWidth = 30;
    label.IntrinsicMinHeight = 16;
    root.AddChild(label);

    ComputeIntrinsicSizes(root);
    const r = SolveLayout(root);
    expect(r.get(label)!.Height).toBeGreaterThan(16);
  });
});
