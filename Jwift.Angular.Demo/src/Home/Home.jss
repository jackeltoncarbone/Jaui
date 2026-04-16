/* Show Studio home — iOS 26 / Liquid Glass visual language.
 *
 * Layout:
 *   Screen        — full-viewport dark background
 *   Scroll        — vertical scroll container
 *   HeroStub      — large hero (70vh) with title + CTA
 *   Section       — carousel section (header + card row)
 *   Card          — cover art tile; opaque content, large rounded corners
 *   Toolbar       — floating top chrome (glass, pill, Position: Fixed)
 *   TabBar        — floating bottom nav (glass, pill)
 *
 * Spacing follows the 8pt grid. Corners are generous (iOS 26 convention).
 * Chrome is LiquidGlass; content surfaces stay solid. */

Screen {
  Direction: Column
  Background: rgb(255, 255, 255)
  FlexGrow: 1
  BorderRadius: 90
  Overflow: Hidden
}

/* Chrome frame — single uniformly-padded container the size of Screen.
 * Toolbar sits at its top, TabBar at its bottom, both inset exactly 24 from
 * every Screen edge. This uniform gap is what makes the concentric radius
 * derivation unambiguous: children's radii = Screen radius - 24 everywhere. */
ChromeFrame {
  Position: Fixed
  Top: 0
  Left: 0
  Width: 100vw
  Height: 100vh
  Direction: Column
  Justify: SpaceBetween
  Align: Stretch
  Padding: 24
  Layer: 10
  PointerEvents: None
}

ToolbarRow {
  Direction: Row
  Justify: SpaceBetween
  Align: Center
  Height: 48
  Layer: 20
  PointerEvents: Auto
}

ToolbarLogo {
  Height: 40
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
  Height: 64
  PointerEvents: Auto
}

/* Progressive blur feathers — Layer 5 sits above scroll content (Layer 0)
 * and below the glass nav (Layer 10+). */
ContentBlur {
  ProgressiveBlurDirection: ToBottom
  Position: Fixed
  Width: 100vw
  Height: 150
  Left: 0
  Bottom: 0
  BackdropFrostBlur: 5
  Background: rgba(0, 0, 0, 0.5)
  Layer: 5
}

TopBlur {
  ProgressiveBlurDirection: ToTop
  Position: Fixed
  Width: 100vw
  Height: 100
  Left: 0
  Top: 0
  BackdropFrostBlur: 8
  Background: rgba(0, 0, 0, 0)
  Layer: 5
}

/* Hero — matches Show Studio's HeroContent pattern:
 * vertically centered, left-aligned, generous left inset, title above CTA
 * with a small 20px gap. Top padding is tall (128) to clear the floating
 * Toolbar chrome; left inset (80) matches SS's min(7%, 12.5em) at desktop.
 * Eventually replaced by 3D reality view. */
HeroStub {
  Direction: Column
  Justify: Center
  Align: Start
  Padding: 128 32 32 80
  Gap: 20
  Height: 70vh
  Background: rgba(29, 43, 92, 0.18)
  FlexGrow: 0
  FlexShrink: 0
}

HeroTitle {
  FontFamily: Inter
  FontSize: 36
  FontWeight: 600
  LineHeight: 1.15
  Color: rgba(255, 255, 255, 0.98)
  LetterSpacing: -0.72
  Width: 500
}

HeroCta {
  Direction: Row
  Justify: Center
  Align: Center
  Padding: 12 32
  BorderRadius: 999
  Background: rgba(255, 255, 255, 0.1)
  FlexShrink: 0
}

HeroCtaLabel {
  FontFamily: Inter
  FontSize: 15
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
}

Section {
  Direction: Column
  Justify: Start
  Align: Stretch
  Gap: 14
  Padding: 0 24 0 24
  FlexGrow: 0
  FlexShrink: 0
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

/* Shared LiquidGlass base for every glass surface. */
LiquidGlass {
  Background: rgba(255, 255, 255, 0)
  BorderRadius: 32
  BorderWidth: 0.5
  BorderBlur: 0
  BorderColor: rgba(255, 255, 255, 0.45)

  ShadowColor: rgba(0, 0, 0, 0.18)
  ShadowBlur: 22
  ShadowOffsetY: 6

  BackdropFrostBlur: 4
  BackdropBrightness: 1.25
  BackdropSaturation: 1.25
  BackdropContrast: 0.75

  Thickness: 2
  Fillet: 0.25
  BezelWidth: 11
  BezelScale: 0.25
  Refraction: 20

  LightAngle: 135
  LightIntensity: 1
  SpecularIntensity: 0
  SpecularSharpness: 10
  FresnelStrength: 0.55
  ChromaticAberration: 0.3
  EdgeLightTop: 0
  EdgeLightBottom: 0.03
  BorderVariance: 0
  BorderAlphaVariance: 0
  BorderFresnelBrightness: 0
  InnerBlur: 0
}

SectionViewAll : LiquidGlass {
  Direction: Row
  Justify: End
  Align: Center
  Padding: 6 12
  BorderRadius: 999
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
  FlexGrow: 0
  FlexShrink: 0
  Height: 340
}

RowCompact : Row {
  Height: 220
}

Card {
  Direction: Column
  Justify: End
  Align: Start
  Padding: 16 18 18 18
  Width: 260
  BorderRadius: 28
  ShadowColor: rgba(0, 0, 0, 0.45)
  ShadowBlur: 24
  ShadowOffsetY: 10
  FlexGrow: 1
}

CardCompact : Card {
  Padding: 14 16 16 16
  Width: 200
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

/* Glass dropdown — collapsed: single avatar pill. Expands on tap (TBD).
 * Concentric with Screen: 90 - 24 (ChromeFrame padding) = 66. */
ToolbarDropdown : LiquidGlass {
  Direction: Row
  Justify: Center
  Align: Center
  Padding: 4
  Width: 48
  Height: 48
  BorderRadius: 66
}

/* Concentric with ToolbarDropdown: 66 - 4 (Dropdown padding) = 62. */
ToolbarAvatar {
  Direction: Row
  Justify: Center
  Align: Center
  Width: 40
  Height: 40
  BorderRadius: 62
  Background: rgba(255, 255, 255, 0.08)
}

ToolbarAvatarGlyph {
  FontFamily: JwiftIcons
  FontSize: 20
  Color: rgba(255, 255, 255, 0.9)
  TextAlign: Center
}

/* Concentric with Screen: 90 - 24 (ChromeFrame padding) = 66. */
TabBar : LiquidGlass {
  Direction: Row
  Justify: Start
  Align: Stretch
  Gap: 0
  Padding: 4
  Width: 400
  MaxWidth: 100%
  Height: 64
  BorderRadius: 66
}

/* Concentric with TabBar: 66 - 4 (TabBar padding) = 62. */
TabItem {
  Direction: Column
  Justify: Center
  Align: Center
  Gap: 4
  Width: 20%
  BorderRadius: 62
}

TabItemActive {
  Direction: Column
  Justify: Center
  Align: Center
  Gap: 4
  Width: 20%
  BorderRadius: 100
  Background: rgba(255, 255, 255, 0.15)
}

TabIcon {
  FontFamily: JwiftIcons
  FontSize: 20
  FontWeight: 400
  Color: rgba(255, 255, 255, 0.6)
  TextAlign: Center
}

TabIconActive {
  FontFamily: JwiftIcons
  FontSize: 20
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.95)
  TextAlign: Center
}

TabLabel {
  FontFamily: Inter
  FontSize: 10
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.6)
  TextAlign: Center
  LetterSpacing: 0.1
}

TabLabelActive {
  FontFamily: Inter
  FontSize: 10
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.95)
  TextAlign: Center
  LetterSpacing: 0.1
}
