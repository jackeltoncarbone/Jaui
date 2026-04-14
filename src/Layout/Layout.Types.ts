export type LayoutMode = 'Flex' | 'Grid' | 'Stack' | 'None';
export type FlexDirection = 'Row' | 'Column' | 'RowReverse' | 'ColumnReverse';
export type FlexWrap = 'NoWrap' | 'Wrap' | 'WrapReverse';
export type JustifyContent = 'Start' | 'End' | 'Center' | 'SpaceBetween' | 'SpaceAround' | 'SpaceEvenly';
export type AlignItems = 'Start' | 'End' | 'Center' | 'Stretch';
export type AlignContent = 'Start' | 'End' | 'Center' | 'Stretch' | 'SpaceBetween' | 'SpaceAround' | 'SpaceEvenly';
export type PositionMode = 'Flow' | 'Offset' | 'Placed' | 'Fixed' | 'Sticky' | 'Attach';

export interface AnchorPoint {
  /** 0..1 — horizontal position within the rect (0 = left, 0.5 = center, 1 = right) */
  X: number;
  /** 0..1 — vertical position within the rect */
  Y: number;
}

export type Overflow = 'Visible' | 'Hidden' | 'Scroll';

/** Jwift's equivalent of CSS anchor-positioning / SwiftUI `.alignmentGuide`.
 *  Set Position:'Attach' on a Jiv, then its rect is derived from another Jiv's
 *  current layout on every solve pass — so the attached node tracks its target
 *  automatically as the target moves, resizes, reflows. Instant-target
 *  cascade; springs animate to the derived rect like any other change.
 *
 *  Two placement modes:
 *    Anchor — map a point on target to a point on self, plus optional offset.
 *             Self size still comes from ChildLayout (fixed / Auto / intrinsic).
 *    Fill   — self fills the target's rect minus AttachInset. Self size derived.
 *
 *  Target can be ANY Jiv in the tree (not just an ancestor or sibling). The
 *  solver resolves Attach in a post-pass after the main top-down solve. If
 *  the target is itself Attach, subsequent iterations catch it — deep chains
 *  resolve in ≤N passes. Cycles don't infinite loop; they just fail to
 *  converge past the iteration cap (logged for debugging). */

export interface LayoutConfig {
  Mode: LayoutMode;
  Direction: FlexDirection;
  Wrap: FlexWrap;
  Justify: JustifyContent;
  Align: AlignItems;
  AlignContent: AlignContent;
  Gap: number;
  RowGap: number;
  ColumnGap: number;
  Padding: [number, number, number, number]; // top, right, bottom, left
}

/** Type shape of a Jiv referenced as an attach target. Avoids a circular
 *  import between Layout.Types and Jiv — only the bits the solver reads. */
export interface AttachTarget {
  Parent: AttachTarget | null;
}

export interface ChildLayout {
  Position: PositionMode;
  FlexGrow: number;
  FlexShrink: number;
  FlexBasis: number | 'Auto';
  AlignSelf: AlignItems | 'Auto';
  Order: number;
  Margin: [number | 'Auto', number | 'Auto', number | 'Auto', number | 'Auto'];
  Width: number | 'Auto' | string;
  Height: number | 'Auto' | string;
  MinWidth: number;
  MaxWidth: number;
  MinHeight: number;
  MaxHeight: number;
  AspectRatio: number | null;
  ZIndex: number | 'Auto';
  OffsetX: number;
  OffsetY: number;
  StickyTop: number | null;
  StickyBottom: number | null;
  StickyLeft: number | null;
  StickyRight: number | null;

  // Attach — only meaningful when Position === 'Attach'
  AttachTo: AttachTarget | null;
  AttachMode: 'Anchor' | 'Fill';
  AttachTargetAnchor: AnchorPoint;   // 0..1 on target rect
  AttachSelfAnchor: AnchorPoint;     // 0..1 on self rect (Anchor mode only)
  AttachOffsetX: number;
  AttachOffsetY: number;
  AttachInset: [number, number, number, number]; // top, right, bottom, left (Fill mode)
}

export interface LayoutResult {
  X: number;
  Y: number;
  Width: number;
  Height: number;
}

export interface GridConfig {
  Columns: GridTrack[];
  Rows: GridTrack[];
}

export interface GridTrack {
  Type: 'Fr' | 'Px' | 'Auto' | 'MinMax';
  Value: number;
  Min?: number;
  Max?: number;
}

export const DefaultLayoutConfig: LayoutConfig = {
  Mode: 'Flex',
  Direction: 'Column',
  Wrap: 'NoWrap',
  Justify: 'Start',
  Align: 'Stretch',
  AlignContent: 'Stretch',
  Gap: 0,
  RowGap: 0,
  ColumnGap: 0,
  Padding: [0, 0, 0, 0],
};

export const DefaultChildLayout: ChildLayout = {
  Position: 'Flow',
  FlexGrow: 0,
  FlexShrink: 1,
  FlexBasis: 'Auto',
  AlignSelf: 'Auto',
  Order: 0,
  Margin: [0, 0, 0, 0],
  Width: 'Auto',
  Height: 'Auto',
  MinWidth: 0,
  MaxWidth: Infinity,
  MinHeight: 0,
  MaxHeight: Infinity,
  AspectRatio: null,
  ZIndex: 'Auto',
  OffsetX: 0,
  OffsetY: 0,
  StickyTop: null,
  StickyBottom: null,
  StickyLeft: null,
  StickyRight: null,
  AttachTo: null,
  AttachMode: 'Anchor',
  AttachTargetAnchor: { X: 0.5, Y: 0.5 },
  AttachSelfAnchor: { X: 0.5, Y: 0.5 },
  AttachOffsetX: 0,
  AttachOffsetY: 0,
  AttachInset: [0, 0, 0, 0],
};
