/**
 * Property-name → slot routing for JSS rulesets.
 *
 * JSS authors write flat declarations inside a class block:
 *
 *   .Toolbar {
 *     Material: LiquidGlass        ← Style
 *     Padding: 0.5pt                ← Layout
 *     Width: 3pt                    ← ChildLayout
 *     FontSize: 14                  ← TextStyle
 *   }
 *
 * The parser doesn't force the author to annotate which slot a property
 * belongs to. This map hardcodes the routing — any property in JSS gets
 * looked up here and assigned to the right slot on the emitted ruleset.
 *
 * Adding a new field to JivStyle / LayoutConfig / ChildLayout / TextStyle
 * requires adding its name here OR it falls through to Style (the catch-all).
 */

export type Slot = 'Style' | 'Layout' | 'ChildLayout' | 'TextStyle';

const LAYOUT_PROPS = new Set([
  'Mode', 'Direction', 'Wrap', 'Justify', 'Align', 'AlignContent',
  'Gap', 'RowGap', 'ColumnGap', 'Padding',
]);

const CHILD_LAYOUT_PROPS = new Set([
  'Position', 'FlexGrow', 'FlexShrink', 'FlexBasis', 'AlignSelf', 'Order',
  'Margin', 'Width', 'Height',
  'MinWidth', 'MaxWidth', 'MinHeight', 'MaxHeight',
  'AspectRatio', 'ZIndex',
  'OffsetX', 'OffsetY',
  'StickyTop', 'StickyBottom', 'StickyLeft', 'StickyRight',
  'Top', 'Bottom', 'Left', 'Right',
  'AttachTo', 'AttachMode',
  'AttachTargetAnchor', 'AttachSelfAnchor',
  'AttachOffsetX', 'AttachOffsetY', 'AttachInset',
  // Per-child clip-escape override. Without this it fell through to Style and
  // was silently dropped — so `ParentOverflow: Visible` in JSS did nothing.
  'ParentOverflow',
]);

const TEXT_STYLE_PROPS = new Set([
  'FontFamily', 'FontSize', 'FontWeight', 'FontStyle',
  'Color', 'LineHeight', 'LetterSpacing',
  'TextAlign', 'TextAlignLast', 'TextOverflow', 'MaxLines',
]);

/** Resolve a property name to its target slot. Unknown → Style (catch-all). */
export const SlotFor = (propertyName: string): Slot => {
  if (LAYOUT_PROPS.has(propertyName)) return 'Layout';
  if (CHILD_LAYOUT_PROPS.has(propertyName)) return 'ChildLayout';
  if (TEXT_STYLE_PROPS.has(propertyName)) return 'TextStyle';
  return 'Style';
};
