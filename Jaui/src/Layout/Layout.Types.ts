export type LayoutMode = 'Flex' | 'Grid' | 'Stack' | 'None';
export type FlexDirection = 'Row' | 'Column' | 'RowReverse' | 'ColumnReverse';
export type FlexWrap = 'NoWrap' | 'Wrap' | 'WrapReverse';
export type JustifyContent = 'Start' | 'End' | 'Center' | 'SpaceBetween' | 'SpaceAround' | 'SpaceEvenly';
export type AlignItems = 'Start' | 'End' | 'Center' | 'Stretch';
export type AlignContent = 'Start' | 'End' | 'Center' | 'Stretch' | 'SpaceBetween' | 'SpaceAround' | 'SpaceEvenly';
/** `Pinned` = Placed against a SCROLL CONTAINER'S FRAME: it does not ride the
 *  content translate, which is what a scrollbar, a floating header, or any
 *  scroll-driven overlay needs. Inside a non-scrolling parent it behaves
 *  exactly like Placed. */
export type PositionMode = 'Flow' | 'Offset' | 'Placed' | 'Fixed' | 'Sticky' | 'Attach' | 'Pinned';

export interface AnchorPoint {
  /** 0..1 — horizontal position within the rect (0 = left, 0.5 = center, 1 = right) */
  X: number;
  /** 0..1 — vertical position within the rect */
  Y: number;
}

export type Overflow = 'Visible' | 'Hidden' | 'Scroll';

/** Whether a node clips its descendants to its box — decoupled from `Overflow`
 *  (which owns scroll + layout). Lets a node scroll WITHOUT clipping, or clip
 *  WITHOUT scrolling.
 *  - `Auto` (default): clip iff `Overflow` is Hidden/Scroll (back-compat).
 *  - `Hidden`: always clip, even when `Overflow` is Visible.
 *  - `Visible`: never clip, even when `Overflow` is Scroll — e.g. a scroll rail
 *    that must let a teleporting card fly in over its edge un-sheared. */
export type Clip = 'Auto' | 'Hidden' | 'Visible';

/** Per-child override of the parent's clipping behavior.
 *  - `Inherit` (default): child is clipped iff parent's `Overflow` is Hidden/Scroll.
 *  - `Visible`: child escapes the parent's clip (back to grandparent's clip),
 *    even if parent is Hidden/Scroll. Escapes one level only.
 *  - `Hidden`: child is clipped to the parent's box even if parent is Visible. */
export type ParentOverflow = 'Inherit' | 'Visible' | 'Hidden';

/** Jaui's equivalent of CSS anchor-positioning / SwiftUI `.alignmentGuide`.
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
  Gap: string;
  RowGap: string;
  ColumnGap: string;
  /** CSS shorthand string: "0", "1 2", "1 2 3 4" (T R B L). Plain number =
   *  uniform on all sides. */
  Padding: string;
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
  FlexBasis: string | 'Auto';
  AlignSelf: AlignItems | 'Auto';
  Order: number;
  /** Space-separated shorthand or number (uniform). "Auto" permitted in any
   *  component for flex auto-margin behavior (pass via explicit "auto" token). */
  Margin: string;
  Width: string | 'Auto' | 'MinContent' | 'MaxContent';
  Height: string | 'Auto' | 'MinContent' | 'MaxContent';
  MinWidth: string;
  MaxWidth: string;
  MinHeight: string;
  MaxHeight: string;
  AspectRatio: number | null;
  ZIndex: number | 'Auto';
  OffsetX: string;
  OffsetY: string;
  StickyTop: string | null;
  StickyBottom: string | null;
  StickyLeft: string | null;
  StickyRight: string | null;

  /** CSS-style anchors for Position: 'Fixed'. When set, override the
   *  imperative X/Y with an offset from the named viewport edge. `Right`
   *  anchors `viewportWidth - Width - Right`; `Bottom` does the same on Y.
   *  Setting both `Left` and `Right` (or both `Top` and `Bottom`) is not
   *  currently supported — the start-edge one wins. */
  Top: string | null;
  Bottom: string | null;
  Left: string | null;
  Right: string | null;

  // Attach — only meaningful when Position === 'Attach'
  AttachTo: AttachTarget | null;
  AttachMode: 'Anchor' | 'Fill';
  AttachTargetAnchor: AnchorPoint;   // 0..1 on target rect
  AttachSelfAnchor: AnchorPoint;     // 0..1 on self rect (Anchor mode only)
  AttachOffsetX: string;
  AttachOffsetY: string;
  /** Space-separated shorthand, same as Padding. */
  AttachInset: string;

  /** Override the parent's clipping behavior for this child only. See
   *  `ParentOverflow` for semantics. Default `'Inherit'`. */
  ParentOverflow: ParentOverflow;
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
  Gap: '0',
  RowGap: '0',
  ColumnGap: '0',
  Padding: '0',
};

export const DefaultChildLayout: ChildLayout = {
  Position: 'Flow',
  FlexGrow: 0,
  FlexShrink: 1,
  FlexBasis: 'Auto',
  AlignSelf: 'Auto',
  Order: 0,
  Margin: '0',
  Width: 'Auto',
  Height: 'Auto',
  MinWidth: '0',
  MaxWidth: 'none',
  MinHeight: '0',
  MaxHeight: 'none',
  AspectRatio: null,
  ZIndex: 'Auto',
  OffsetX: '0',
  OffsetY: '0',
  StickyTop: null,
  StickyBottom: null,
  StickyLeft: null,
  StickyRight: null,
  Top: null,
  Bottom: null,
  Left: null,
  Right: null,
  AttachTo: null,
  AttachMode: 'Anchor',
  AttachTargetAnchor: { X: 0.5, Y: 0.5 },
  AttachSelfAnchor: { X: 0.5, Y: 0.5 },
  AttachOffsetX: '0',
  AttachOffsetY: '0',
  AttachInset: '0',
  ParentOverflow: 'Inherit',
};
