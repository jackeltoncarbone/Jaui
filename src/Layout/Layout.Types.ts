export type LayoutMode = 'Flex' | 'Grid' | 'Stack' | 'None';
export type FlexDirection = 'Row' | 'Column' | 'RowReverse' | 'ColumnReverse';
export type FlexWrap = 'NoWrap' | 'Wrap' | 'WrapReverse';
export type JustifyContent = 'Start' | 'End' | 'Center' | 'SpaceBetween' | 'SpaceAround' | 'SpaceEvenly';
export type AlignItems = 'Start' | 'End' | 'Center' | 'Stretch';
export type AlignContent = 'Start' | 'End' | 'Center' | 'Stretch' | 'SpaceBetween' | 'SpaceAround' | 'SpaceEvenly';
export type PositionMode = 'Flow' | 'Offset' | 'Placed' | 'Fixed' | 'Sticky';
export type Overflow = 'Visible' | 'Hidden' | 'Scroll';

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
};
