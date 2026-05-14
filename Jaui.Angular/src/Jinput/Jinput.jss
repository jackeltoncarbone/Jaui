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

// Visual treatment for read-only state. Drops opacity on the whole input so
// segments + placeholder dim uniformly without per-element overrides, and
// switches the cursor to the default pointer (no `Cursor: Text`).
JinputReadOnly {
  Cursor: Default
  Opacity: 0.55
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

// Visual matches Selection.Manager's DEFAULT_SELECTION_STYLE so plain-text
// and input selection rects read as the same primitive. Per-line rect
// position / size are mutated in TS each frame.
// BorderRadius is set inline per-rect to height × 0.4, so the curve scales
// with text size. Background + transitions live here; per-line position /
// size / radius are mutated in TS each frame.
JinputSelectionRect {
  Background: rgba(120, 170, 255, 0.32)
  @Transition Width  { Duration: 90ms }
  @Transition Height { Duration: 90ms }
}
