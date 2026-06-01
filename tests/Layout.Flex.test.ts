import { describe, it, expect } from 'vitest';
import { SolveFlex, type FlexContainer, type FlexChild } from '../src/Layout/Layout.Flex';

// ─── Helpers ───

const container = (overrides?: Partial<FlexContainer>): FlexContainer => ({
  Width: 400,
  Height: 300,
  Direction: 'Row',
  Wrap: 'NoWrap',
  Justify: 'Start',
  Align: 'Stretch',
  AlignContent: 'Stretch',
  Gap: 0,
  RowGap: 0,
  ColumnGap: 0,
  Padding: [0, 0, 0, 0],
  ...overrides,
});

const child = (overrides?: Partial<FlexChild>, index: number = 0): FlexChild => ({
  Index: index,
  Order: 0,
  FlexGrow: 0,
  FlexShrink: 1,
  FlexBasis: 'Auto',
  AlignSelf: 'Auto',
  Margin: [0, 0, 0, 0],
  Width: 'Auto',
  Height: 'Auto',
  MinWidth: 0,
  MaxWidth: Infinity,
  MinHeight: 0,
  MaxHeight: Infinity,
  ...overrides,
});

const approx = (actual: number, expected: number, tolerance: number = 0.1) => {
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
};

// ─── Tests ───

describe('SolveFlex', () => {

  // ─── Edge Cases ───

  describe('edge cases', () => {
    it('returns empty array for zero children', () => {
      const results = SolveFlex(container(), []);
      expect(results).toEqual([]);
    });

    it('handles single child with no constraints', () => {
      const results = SolveFlex(container(), [child()]);
      expect(results).toHaveLength(1);
      expect(results[0].X).toBe(0);
      expect(results[0].Y).toBe(0);
    });

    it('handles zero-size container', () => {
      const results = SolveFlex(container({ Width: 0, Height: 0 }), [
        child({ Width: 100, Height: 50 }),
      ]);
      expect(results).toHaveLength(1);
    });
  });

  // ─── Row Basics ───

  describe('Row basics', () => {
    it('single child with grow fills container', () => {
      const results = SolveFlex(container(), [
        child({ FlexGrow: 1 }),
      ]);
      expect(results[0].Width).toBe(400);
      expect(results[0].Height).toBe(300); // Stretch
    });

    it('two children with equal grow split space', () => {
      const results = SolveFlex(container(), [
        child({ FlexGrow: 1 }, 0),
        child({ FlexGrow: 1 }, 1),
      ]);
      expect(results[0].Width).toBe(200);
      expect(results[1].Width).toBe(200);
      expect(results[0].X).toBe(0);
      expect(results[1].X).toBe(200);
    });

    it('three children with different grow ratios', () => {
      const results = SolveFlex(container(), [
        child({ FlexGrow: 1 }, 0),
        child({ FlexGrow: 2 }, 1),
        child({ FlexGrow: 1 }, 2),
      ]);
      expect(results[0].Width).toBe(100);
      expect(results[1].Width).toBe(200);
      expect(results[2].Width).toBe(100);
    });

    it('fixed-size children pack to start', () => {
      const results = SolveFlex(container(), [
        child({ Width: 80 }, 0),
        child({ Width: 120 }, 1),
      ]);
      expect(results[0].X).toBe(0);
      expect(results[0].Width).toBe(80);
      expect(results[1].X).toBe(80);
      expect(results[1].Width).toBe(120);
    });
  });

  // ─── Column Basics ───

  describe('Column basics', () => {
    it('single child with grow fills container height', () => {
      const results = SolveFlex(container({ Direction: 'Column' }), [
        child({ FlexGrow: 1 }),
      ]);
      expect(results[0].Height).toBe(300);
      expect(results[0].Width).toBe(400); // Stretch on cross
    });

    it('two children split height equally', () => {
      const results = SolveFlex(container({ Direction: 'Column' }), [
        child({ FlexGrow: 1 }, 0),
        child({ FlexGrow: 1 }, 1),
      ]);
      expect(results[0].Height).toBe(150);
      expect(results[1].Height).toBe(150);
      expect(results[0].Y).toBe(0);
      expect(results[1].Y).toBe(150);
    });

    it('fixed-size children pack to start', () => {
      const results = SolveFlex(container({ Direction: 'Column' }), [
        child({ Height: 60 }, 0),
        child({ Height: 80 }, 1),
      ]);
      expect(results[0].Y).toBe(0);
      expect(results[0].Height).toBe(60);
      expect(results[1].Y).toBe(60);
      expect(results[1].Height).toBe(80);
    });
  });

  // ─── JustifyContent ───

  describe('JustifyContent', () => {
    const twoFixedChildren = (): FlexChild[] => [
      child({ Width: 100 }, 0),
      child({ Width: 100 }, 1),
    ];

    it('Start packs to left', () => {
      const results = SolveFlex(container({ Justify: 'Start' }), twoFixedChildren());
      expect(results[0].X).toBe(0);
      expect(results[1].X).toBe(100);
    });

    it('End packs to right', () => {
      const results = SolveFlex(container({ Justify: 'End' }), twoFixedChildren());
      expect(results[0].X).toBe(200);
      expect(results[1].X).toBe(300);
    });

    it('Center packs to middle', () => {
      const results = SolveFlex(container({ Justify: 'Center' }), twoFixedChildren());
      expect(results[0].X).toBe(100);
      expect(results[1].X).toBe(200);
    });

    it('SpaceBetween with 2 children', () => {
      const results = SolveFlex(container({ Justify: 'SpaceBetween' }), twoFixedChildren());
      expect(results[0].X).toBe(0);
      expect(results[1].X).toBe(300);
    });

    it('SpaceBetween with 3 children', () => {
      const results = SolveFlex(container({ Justify: 'SpaceBetween' }), [
        child({ Width: 100 }, 0),
        child({ Width: 100 }, 1),
        child({ Width: 100 }, 2),
      ]);
      expect(results[0].X).toBe(0);
      approx(results[1].X, 150);
      expect(results[2].X).toBe(300);
    });

    it('SpaceAround distributes equal space around items', () => {
      const results = SolveFlex(container({ Justify: 'SpaceAround' }), twoFixedChildren());
      // 200 free space / 2 items = 100 per item, 50 on each side
      approx(results[0].X, 50);
      approx(results[1].X, 250);
    });

    it('SpaceEvenly distributes equal gaps', () => {
      const results = SolveFlex(container({ Justify: 'SpaceEvenly' }), twoFixedChildren());
      // 200 free space / 3 gaps = 66.67
      approx(results[0].X, 66.67, 0.5);
      approx(results[1].X, 233.33, 0.5);
    });
  });

  // ─── AlignItems ───

  describe('AlignItems', () => {
    it('Stretch fills cross axis', () => {
      const results = SolveFlex(container({ Align: 'Stretch' }), [
        child({ Width: 100 }),
      ]);
      expect(results[0].Height).toBe(300);
    });

    it('Start aligns to top', () => {
      const results = SolveFlex(container({ Align: 'Start' }), [
        child({ Width: 100, Height: 80 }),
      ]);
      expect(results[0].Y).toBe(0);
      expect(results[0].Height).toBe(80);
    });

    it('End aligns to bottom', () => {
      const results = SolveFlex(container({ Align: 'End' }), [
        child({ Width: 100, Height: 80 }),
      ]);
      expect(results[0].Y).toBe(220);
      expect(results[0].Height).toBe(80);
    });

    it('Center aligns to middle', () => {
      const results = SolveFlex(container({ Align: 'Center' }), [
        child({ Width: 100, Height: 80 }),
      ]);
      expect(results[0].Y).toBe(110);
    });
  });

  // ─── AlignSelf ───

  describe('AlignSelf', () => {
    it('overrides AlignItems for a single child', () => {
      const results = SolveFlex(container({ Align: 'Start' }), [
        child({ Width: 100, Height: 80, AlignSelf: 'End' }, 0),
        child({ Width: 100, Height: 80 }, 1),
      ]);
      expect(results[0].Y).toBe(220); // End
      expect(results[1].Y).toBe(0);   // Start (from container)
    });
  });

  // ─── FlexShrink ───

  describe('FlexShrink', () => {
    it('shrinks proportionally when children exceed container', () => {
      const results = SolveFlex(container({ Width: 300 }), [
        child({ Width: 200, FlexShrink: 1 }, 0),
        child({ Width: 200, FlexShrink: 1 }, 1),
      ]);
      // 400 total, 300 available, 100 overflow, each shrinks by 50
      expect(results[0].Width).toBe(150);
      expect(results[1].Width).toBe(150);
    });

    it('child with shrink=0 does not shrink', () => {
      const results = SolveFlex(container({ Width: 300 }), [
        child({ Width: 200, FlexShrink: 0 }, 0),
        child({ Width: 200, FlexShrink: 1 }, 1),
      ]);
      expect(results[0].Width).toBe(200);
      expect(results[1].Width).toBe(100);
    });

    it('respects MinWidth during shrink', () => {
      const results = SolveFlex(container({ Width: 200 }), [
        child({ Width: 200, FlexShrink: 1, MinWidth: 150 }, 0),
        child({ Width: 200, FlexShrink: 1, MinWidth: 0 }, 1),
      ]);
      expect(results[0].Width).toBe(150); // clamped to min
      expect(results[1].Width).toBe(50);  // takes remaining overflow
    });
  });

  // ─── FlexBasis ───

  describe('FlexBasis', () => {
    it('uses explicit basis instead of Width', () => {
      const results = SolveFlex(container(), [
        child({ FlexBasis: 200, Width: 100 }, 0),
        child({ FlexGrow: 1 }, 1),
      ]);
      expect(results[0].Width).toBe(200);
      expect(results[1].Width).toBe(200); // remaining space
    });

    it('Auto falls back to Width', () => {
      const results = SolveFlex(container(), [
        child({ FlexBasis: 'Auto', Width: 150 }, 0),
        child({ FlexGrow: 1 }, 1),
      ]);
      expect(results[0].Width).toBe(150);
      expect(results[1].Width).toBe(250);
    });
  });

  // ─── Padding ───

  describe('Padding', () => {
    it('reduces available space', () => {
      const results = SolveFlex(
        container({ Padding: [10, 20, 10, 20] }),
        [child({ FlexGrow: 1 })],
      );
      expect(results[0].Width).toBe(360); // 400 - 20 - 20
      expect(results[0].Height).toBe(280); // 300 - 10 - 10
      expect(results[0].X).toBe(20);
      expect(results[0].Y).toBe(10);
    });
  });

  // ─── Gap ───

  describe('Gap', () => {
    it('adds space between children', () => {
      const results = SolveFlex(container({ Gap: 20 }), [
        child({ Width: 100 }, 0),
        child({ Width: 100 }, 1),
        child({ Width: 100 }, 2),
      ]);
      expect(results[0].X).toBe(0);
      expect(results[1].X).toBe(120);
      expect(results[2].X).toBe(240);
    });

    it('gap does not appear before first or after last', () => {
      const results = SolveFlex(container({ Gap: 50 }), [
        child({ Width: 100 }, 0),
        child({ Width: 100 }, 1),
      ]);
      expect(results[0].X).toBe(0);
      expect(results[1].X).toBe(150);
    });

    it('grow accounts for gap', () => {
      const results = SolveFlex(container({ Gap: 20 }), [
        child({ FlexGrow: 1 }, 0),
        child({ FlexGrow: 1 }, 1),
      ]);
      // 400 - 20 gap = 380, split in 2 = 190 each
      expect(results[0].Width).toBe(190);
      expect(results[1].Width).toBe(190);
    });
  });

  // ─── Margins ───

  describe('Margins', () => {
    it('fixed margins create space around children', () => {
      const results = SolveFlex(container(), [
        child({ Width: 100, Margin: [0, 20, 0, 10] }, 0),
        child({ Width: 100 }, 1),
      ]);
      expect(results[0].X).toBe(10);  // marginLeft = 10
      expect(results[1].X).toBe(130); // 10 + 100 + 20 = 130
    });

    it('auto margins center a single child', () => {
      const results = SolveFlex(container(), [
        child({ Width: 100, Margin: [0, 'Auto', 0, 'Auto'] }),
      ]);
      expect(results[0].X).toBe(150); // (400 - 100) / 2
    });

    it('auto margin on one side pushes to opposite', () => {
      const results = SolveFlex(container(), [
        child({ Width: 100, Margin: [0, 0, 0, 'Auto'] }),
      ]);
      expect(results[0].X).toBe(300); // pushed right: 400 - 100
    });
  });

  // ─── Min/Max Constraints ───

  describe('min/max constraints', () => {
    it('respects MaxWidth during grow', () => {
      const results = SolveFlex(container(), [
        child({ FlexGrow: 1, MaxWidth: 150 }, 0),
        child({ FlexGrow: 1 }, 1),
      ]);
      expect(results[0].Width).toBe(150);
      expect(results[1].Width).toBe(250); // remaining
    });

    it('respects MinHeight on cross axis with Stretch', () => {
      const results = SolveFlex(container({ Height: 50, Align: 'Stretch' }), [
        child({ Width: 100, MinHeight: 80 }),
      ]);
      expect(results[0].Height).toBe(80); // MinHeight wins
    });
  });

  // ─── Reverse ───

  describe('reverse directions', () => {
    it('RowReverse mirrors positions', () => {
      const results = SolveFlex(container({ Direction: 'RowReverse' }), [
        child({ Width: 100 }, 0),
        child({ Width: 100 }, 1),
      ]);
      // First child should be on the right
      expect(results[0].X).toBe(300);
      expect(results[1].X).toBe(200);
    });

    it('ColumnReverse mirrors positions', () => {
      const results = SolveFlex(container({ Direction: 'ColumnReverse' }), [
        child({ Height: 60 }, 0),
        child({ Height: 80 }, 1),
      ]);
      expect(results[0].Y).toBe(240);
      expect(results[1].Y).toBe(160);
    });
  });

  // ─── Wrapping ───

  describe('wrapping', () => {
    it('wraps children to new line when exceeding container', () => {
      const results = SolveFlex(container({ Wrap: 'Wrap', AlignContent: 'Start' }), [
        child({ Width: 250, Height: 80 }, 0),
        child({ Width: 250, Height: 80 }, 1),
      ]);
      // First child on line 1, second wraps to line 2
      expect(results[0].X).toBe(0);
      expect(results[0].Y).toBe(0);
      expect(results[1].X).toBe(0);
      expect(results[1].Y).toBe(80);
    });

    it('multiple items per line wrap correctly', () => {
      const results = SolveFlex(container({ Wrap: 'Wrap', AlignContent: 'Start' }), [
        child({ Width: 150, Height: 50 }, 0),
        child({ Width: 150, Height: 50 }, 1),
        child({ Width: 150, Height: 50 }, 2),
      ]);
      // Line 1: items 0, 1 (300 <= 400)
      // Line 2: item 2
      expect(results[0].Y).toBe(0);
      expect(results[1].Y).toBe(0);
      expect(results[2].Y).toBe(50);
    });
  });

  // ─── Order ───

  describe('Order', () => {
    it('reorders children by Order property', () => {
      const results = SolveFlex(container(), [
        child({ Width: 100, Order: 2 }, 0),
        child({ Width: 100, Order: 1 }, 1),
      ]);
      // Child 1 (Order 1) should come first visually
      expect(results[1].X).toBe(0);   // Order 1 first
      expect(results[0].X).toBe(100); // Order 2 second
    });
  });
});
