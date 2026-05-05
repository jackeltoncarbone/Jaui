// Functional-only styles for `<jinput>` — layout, hit area, caret + selection
// rect placement. Font / colors are overridden by wrapper components and
// app-level JSS. Default colors are reasonable fallbacks (white-on-translucent)
// so a bare jinput renders visibly without a wrapper.

JinputRoot {
  Direction: Column
  Justify: Start
  Align: Stretch
  Width: 100%
  Height: 100%
  MinHeight: 28pt
  FlexGrow: 1
  Cursor: Text
  Interactive: true
  UserSelect: None
}

JinputWrap {
  Direction: Row
  Wrap: Wrap
  Justify: Start
  Align: Start
  // Inter-segment space comes from each segment's measured width, which
  // includes any trailing whitespace's advance. ColumnGap stays 0 so adjacent
  // segments render at the natural single-space distance.
  ColumnGap: 0pt
  RowGap: 4pt
  Width: 100%
}

JinputSegment {
  // Default text style — wrapper components override Color / FontFamily /
  // FontSize via their own JSS or by passing a textStyle.
  Color: rgba(255, 255, 255, 0.85)
}

JinputPlaceholder {
  Color: rgba(255, 255, 255, 0.32)
  FontStyle: Italic
}

JinputCaret {
  Background: rgba(255, 255, 255, 0.95)
}

JinputSelectionRect {
  // Soft Apple-style rounded corners — matches macOS / iOS text selection.
  Background: rgba(120, 170, 255, 0.32)
  BorderRadius: 4pt
}
