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

// Single-line inputs center their one line on the box's vertical midline. The root carries a 28pt
// MinHeight (a comfortable hit/caret area), so a lone 1-line field would otherwise pin its text to the
// top and read as off-centre inside a taller pill. No-op when the box is already line-height (Justify
// has no slack to distribute). Multi-line inputs keep Justify: Start so text fills from the top down.
JinputRootSingleLine : JinputRoot {
  Justify: Center
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
  // Match TextAnimator's FontWeight spring config (stiffness 260, damping 30
  // in Text.Animator.ts). JivAnimator's defaults (170 / 26) settle slower
  // than the weight spring, so the surrounding-text slide trailed the bold
  // and read as a separate "snap" event rather than part of the same motion.
  @Spring X     { Stiffness: 260, Damping: 30 }
  @Spring Y     { Stiffness: 260, Damping: 30 }
  @Spring Width { Stiffness: 260, Damping: 30 }
}

JinputPlaceholder {
  Color: rgba(255, 255, 255, 0.32)
  FontStyle: Italic
}

// The touch selection's pins: a bar the height of the line and a round knob,
// caret-white so the selection primitives read as one family. Layered with
// the caret, above text.
JinputHandleBar {
  Background: rgba(255, 255, 255, 1)
  BorderRadius: 1.25px
  Layer: 6
}
JinputHandleKnob {
  Background: rgba(255, 255, 255, 1)
  BorderRadius: 6px
  Layer: 6
  Shadow: 0 1px 3px rgba(0, 0, 0, 0.35)
}

JinputCaret {
  Background: rgba(255, 255, 255, 1)
  // Float above the text segments + placeholder so a focused EMPTY field shows a
  // clear caret at the start instead of it hiding behind the placeholder's first
  // glyph. Width is set inline in the template.
  Layer: 6
}

// Visual matches Selection.Manager's DEFAULT_SELECTION_STYLE so plain-text
// and input selection rects read as the same primitive. Per-line rect
// position / size are mutated in TS each frame.
// BorderRadius is set inline per-rect to height × 0.4, so the curve scales
// with text size. Background + transitions live here; per-line position /
// size / radius are mutated in TS each frame.
// Opacity is left at the engine default of `Presence` so mount fades in
// and ngOnDestroy (→ RequestLeave → spring 1→0) fades out without any
// inline override. Setting Opacity explicitly here OR in the template
// would lock the rect at the chosen value for the entire ~400ms
// Presence settle, making leaving rects "stack" at full opacity and
// then pop. Override Presence's spring tuning instead — a stiffer
// 600/30 settles in ~140ms which feels right for selection halos.
JinputSelectionRect {
  Background: rgba(120, 170, 255, 0.32)
  @Spring Presence { Stiffness: 600, Damping: 30 }
  @Transition Width   { Duration: 90ms }
  @Transition Height  { Duration: 90ms }
}

// Remote peer's selection halo. Higher Layer than the local
// JinputSelectionRect so the peer's accent halo stays visible when the
// local user's selection overlaps. NOT Interactive — hover is detected
// upstream via char-index (Jinput tracks the pointer at the window level
// and resolves it to a char position; that index is then matched against
// peer Start/End in `_onWindowHoverMove`). Leaving Interactive off
// preserves click-through so the local user can drop their own caret
// inside a peer's highlighted range.
// Same Presence-driven fade as the local JinputSelectionRect — no
// inline Opacity in the template, just the engine's implicit
// `Opacity: Presence`. Tuned to the same 600/30 spring for parity.
JinputPeerSelectionRect {
  Layer: 5
  @Spring Presence { Stiffness: 600, Damping: 30 }
  @Transition Width   { Duration: 90ms }
  @Transition Height  { Duration: 90ms }
}

// Per-peer wrapper holding that peer's selection rects, caret hit,
// and name pill. Exists ONLY so that the engine's default
// `Opacity: Presence` binding fires on the wrapper when the peer
// leaves the room — the Presence spring then cascades visually
// through to every child via the renderer's opacity multiply (per
// Presence.md nested-exit semantics). Without this wrapper a peer
// disappearing from the room would pop instantly because the
// individual rects override Opacity for in-place state animation.
// No layout footprint of its own — children are all Position:Placed.
JinputPeerGroup {}

// 16pt-wide region centered on the 2pt peer caret line. Used to be an
// invisible hit-target for Angular pointer-enter/leave handlers, but
// Jaui jivs are `display:contents` so Angular host-bound pointer events
// never fired — hover now flows through `_onWindowHoverMove` →
// `_hoveredPeerKey`. This wrapper is kept only as a positioning anchor
// for the caret line.
JinputPeerCaretHit {}

// The 2pt vertical caret line. Background is set inline per-peer from
// the awareness accent color.
JinputPeerCaretLine {
}

// Name pill floated above the caret/selection. Filled with the peer's
// accent color (set inline), small Apple-style label. Display-only —
// no Interactive flag so it never captures pointer events and the
// user can always drop their cursor "through" it. Opacity is driven
// from the host signal via inline style; the transition lives here so
// the fade matches across hover in/out at the same cadence. Layer
// pushes it above text segments so the pill never hides behind
// rendered glyphs.
JinputPeerCaretLabel {
  Layer: 21
  FontFamily: Inter
  FontSize: 10pt
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.98)
  Padding: 2pt 7pt
  BorderRadius: 999pt
  WhiteSpace: NoWrap
  @Transition Opacity { Duration: 140ms }
}
