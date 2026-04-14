/* Show Studio home — iOS 26 / Liquid Glass visual language.
 *
 * Layout:
 *   Screen        — full-viewport dark background
 *   Scroll        — vertical scroll container (content + padding for floating chrome)
 *   HeroStub      — large hero title (stub for the 3D reality view)
 *   Section       — carousel section (header + card row)
 *   Card          — cover art tile; opaque content, large rounded corners
 *   Toolbar       — floating top chrome (glass, pill)
 *   TabBar        — floating bottom nav (glass, pill)
 *
 * Spacing follows the 8pt grid. Corners are generous (iOS 26 convention).
 * Chrome is LiquidGlass; content surfaces stay solid. */

Screen {
  Direction: Column
  Justify: Start
  Align: Stretch
  Background: rgba(12, 14, 20, 1)
}

ToolbarRow {
  Direction: Row
  Justify: End
  Align: Center
  Padding: 16 20
  FlexGrow: 0
  FlexShrink: 0
  Height: 80
}

Scroll {
  Direction: Column
  Justify: Start
  Align: Stretch
  Padding: 0 0 32 0
  Gap: 40
  Overflow: Scroll
  FlexGrow: 1
}

TabBarRow {
  Direction: Row
  Justify: Center
  Align: Center
  Padding: 8 20 24 20
  FlexGrow: 0
  FlexShrink: 0
  Height: 100
}

HeroStub {
  Direction: Column
  Justify: End
  Align: Start
  Padding: 24 28 28 28
  Height: 520
  Background: rgb(32, 36, 52)
  BorderRadius: 0
}

HeroKicker {
  FontFamily: Inter
  FontSize: 13
  FontWeight: 600
  Color: rgba(255, 120, 140, 1)
  LetterSpacing: 0.2
}

HeroTitle {
  FontFamily: Inter
  FontSize: 48
  FontWeight: 700
  LineHeight: 1.05
  Color: rgba(255, 255, 255, 0.98)
  LetterSpacing: -0.5
}

Section {
  Direction: Column
  Justify: Start
  Align: Stretch
  Gap: 14
  Padding: 0 24 0 24
}

SectionHeader {
  Direction: Row
  Justify: SpaceBetween
  Align: Center
  Gap: 8
}

SectionTitle {
  FontFamily: Inter
  FontSize: 22
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.96)
  LetterSpacing: -0.2
}

SectionViewAll {
  Direction: Row
  Justify: End
  Align: Center
  Padding: 6 12
  BorderRadius: 999
  Material: LiquidGlass
  BorderWidth: 1
  BorderColor: rgba(255, 255, 255, 0.18)
  BackdropFrostBlur: 14
  BackdropBrightness: 1.05
}

SectionViewAllLabel {
  FontFamily: Inter
  FontSize: 13
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
}

Row {
  Direction: Row
  Justify: Start
  Align: Stretch
  Gap: 14
  Padding: 2 4 2 4
}

Card {
  Direction: Column
  Justify: End
  Align: Start
  Padding: 16 18 18 18
  Width: 260
  Height: 320
  BorderRadius: 28
  ShadowColor: rgba(0, 0, 0, 0.45)
  ShadowBlur: 24
  ShadowOffsetY: 10
}

CardCompact {
  Direction: Column
  Justify: End
  Align: Start
  Padding: 14 16 16 16
  Width: 200
  Height: 200
  BorderRadius: 24
  ShadowColor: rgba(0, 0, 0, 0.4)
  ShadowBlur: 20
  ShadowOffsetY: 8
}

CardKicker {
  FontFamily: Inter
  FontSize: 11
  FontWeight: 700
  Color: rgba(255, 255, 255, 0.72)
  LetterSpacing: 0.6
}

CardTitle {
  FontFamily: Inter
  FontSize: 22
  FontWeight: 700
  LineHeight: 1.1
  Color: rgba(255, 255, 255, 0.98)
  LetterSpacing: -0.2
}

CardTitleCompact {
  FontFamily: Inter
  FontSize: 17
  FontWeight: 600
  LineHeight: 1.15
  Color: rgba(255, 255, 255, 0.97)
}

Toolbar {
  Direction: Row
  Justify: End
  Align: Center
  Gap: 10
  Padding: 6
  Width: 220
  Height: 56
  BorderRadius: 28
  Material: LiquidGlass
  BorderWidth: 1
  BorderColor: rgba(255, 255, 255, 0.2)
  BackdropFrostBlur: 18
  BackdropSaturation: 1.25
  BackdropContrast: 0.9
}

ToolbarButton {
  Direction: Row
  Justify: Center
  Align: Center
  Width: 44
  Height: 44
  BorderRadius: 22
  Background: rgba(255, 255, 255, 0.1)
}

ToolbarButtonGlyph {
  FontFamily: Inter
  FontSize: 15
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.9)
  TextAlign: Center
}

TabBar {
  Direction: Row
  Justify: SpaceBetween
  Align: Stretch
  Gap: 2
  Padding: 6
  Width: 440
  Height: 64
  BorderRadius: 32
  Material: LiquidGlass
  BorderWidth: 1
  BorderColor: rgba(255, 255, 255, 0.22)
  BackdropFrostBlur: 20
  BackdropBrightness: 1.05
  BackdropSaturation: 1.35
  BackdropContrast: 0.85
}

TabItem {
  Direction: Row
  Justify: Center
  Align: Center
  FlexGrow: 1
  FlexBasis: 0
  BorderRadius: 26
}

TabItemActive {
  Direction: Row
  Justify: Center
  Align: Center
  FlexGrow: 1
  FlexBasis: 0
  BorderRadius: 26
  Background: rgba(255, 255, 255, 0.18)
}

TabLabel {
  FontFamily: Inter
  FontSize: 14
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.7)
  TextAlign: Center
}

TabLabelActive {
  FontFamily: Inter
  FontSize: 14
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.98)
  TextAlign: Center
}
