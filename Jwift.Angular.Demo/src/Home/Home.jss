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
  BorderRadius: 80pt
  Overflow: Hidden
  PointScale: 1.25
}

/* Chrome frame — single uniformly-padded container the size of Screen.
 * Toolbar sits at its top, TabBar at its bottom, both inset exactly 24 from
 * every Screen edge. This uniform gap is what makes the concentric radius
 * derivation unambiguous: children's radii = Screen radius - 24 everywhere. */
ChromeFrame {
  Position: Fixed
  Top: 0pt
  Left: 0pt
  Width: 100vw
  Height: 100vh
  Direction: Column
  Justify: SpaceBetween
  Align: Stretch
  Padding: 10pt
  Layer: 10
  PointerEvents: None
}

ToolbarRow {
  Direction: Row
  Justify: SpaceBetween
  Align: Center
  Layer: 20
  PointerEvents: Auto
}

ToolbarLogo {
  Height: 40pt
}

Scroll {
  Direction: Column
  Justify: Start
  Align: Stretch
  Padding: 0pt 0pt 32pt 0pt
  Gap: 40pt
  Overflow: Scroll
  FlexGrow: 1
}

TabBarRow {
  Direction: Row
  Justify: Center
  Align: Center
  Height: 64pt
  PointerEvents: Auto
}

/* Progressive blur feathers — Layer 5 sits above scroll content (Layer 0)
 * and below the glass nav (Layer 10+). */
ContentBlur {
  ProgressiveBlurDirection: ToBottom
  Position: Fixed
  Width: 100vw
  Height: 150pt
  Left: 0pt
  Bottom: 0pt
  BackdropFrostBlur: 5pt
  Background: rgba(0, 0, 0, 0.5)
  Layer: 5
}

TopBlur {
  ProgressiveBlurDirection: ToTop
  Position: Fixed
  Width: 100vw
  Height: 100pt
  Left: 0pt
  Top: 0pt
  BackdropFrostBlur: 8pt
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
  Padding: 128pt 32pt 32pt 80pt
  Gap: 20pt
  Height: 70vh
  Background: rgba(29, 43, 92, 0.18)
  FlexGrow: 0
  FlexShrink: 0
}

HeroTitle {
  FontFamily: Inter
  FontSize: 36pt
  FontWeight: 600
  LineHeight: 1.15
  Color: rgba(255, 255, 255, 0.98)
  LetterSpacing: -0.72pt
  Width: 500pt
}

HeroCta {
  Direction: Row
  Justify: Center
  Align: Center
  Padding: 12pt 32pt
  BorderRadius: 999pt
  Background: rgba(255, 255, 255, 0.1)
  FlexShrink: 0
}

HeroCtaLabel {
  FontFamily: Inter
  FontSize: 15pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
}

Section {
  Direction: Column
  Justify: Start
  Align: Stretch
  Gap: 14pt
  Padding: 0pt 24pt 0pt 24pt
  FlexGrow: 0
  FlexShrink: 0
}

SectionHeader {
  Direction: Row
  Justify: SpaceBetween
  Align: Center
  Gap: 8pt
}

SectionTitle {
  FontFamily: Inter
  FontSize: 22pt
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.96)
  LetterSpacing: -0.2pt
}

/* Shared LiquidGlass base for every glass surface. */
LiquidGlass {
  Background: rgba(255, 255, 255, 0)
  BorderRadius: 32pt
  BorderWidth: 0.5pt
  BorderBlur: 0pt
  BorderColor: rgba(255, 255, 255, 0.45)

  ShadowColor: rgba(0, 0, 0, 0.18)
  ShadowBlur: 22pt
  ShadowOffsetY: 6pt

  BackdropFrostBlur: 4pt
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
  Padding: 6pt 12pt
  BorderRadius: 999pt
  BorderWidth: 1pt
  BorderColor: rgba(255, 255, 255, 0.18)
  BackdropFrostBlur: 14pt
  BackdropBrightness: 1.05
}

SectionViewAllLabel {
  FontFamily: Inter
  FontSize: 13pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
}

Row {
  Direction: Row
  Justify: Start
  Align: Stretch
  Gap: 14pt
  Padding: 2pt 4pt 2pt 4pt
  FlexGrow: 0
  FlexShrink: 0
  Height: 340pt
}

RowCompact : Row {
  Height: 220pt
}

Card {
  Direction: Column
  Justify: End
  Align: Start
  Padding: 20pt
  Width: 260pt
  BorderRadius: 48pt
  ShadowColor: rgba(0, 0, 0, 0.45)
  ShadowBlur: 24pt
  ShadowOffsetY: 10pt
  FlexGrow: 1
  Overflow: Hidden
}

CardCompact : Card {
  Padding: 14pt 16pt 16pt 16pt
  Width: 200pt
  ShadowColor: rgba(0, 0, 0, 0.4)
  ShadowBlur: 20pt
  ShadowOffsetY: 8pt
}

CardKicker {
  FontFamily: Inter
  FontSize: 11pt
  FontWeight: 700
  Color: rgba(255, 255, 255, 0.72)
  LetterSpacing: 0.6pt
}

CardTitle {
  FontFamily: Inter
  FontSize: 22pt
  FontWeight: 700
  LineHeight: 1.1
  Color: rgba(255, 255, 255, 0.98)
  LetterSpacing: -0.2pt
}

CardTitleCompact {
  FontFamily: Inter
  FontSize: 17pt
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
  Padding: 4pt
  Margin: 22pt 22pt 0pt 0pt
  Width: 48pt
  Height: 48pt
  BorderRadius: 66pt
}

/* Concentric with ToolbarDropdown: 66 - 4 (Dropdown padding) = 62. */
ToolbarAvatar {
  Direction: Row
  Justify: Center
  Align: Center
  Width: 40pt
  Height: 40pt
  BorderRadius: 62pt
  Background: rgba(255, 255, 255, 0.08)
}

ToolbarAvatarGlyph {
  FontFamily: JwiftIcons
  FontSize: 20pt
  Color: rgba(255, 255, 255, 0.9)
  TextAlign: Center
}

/* Concentric with Screen: 90 - 24 (ChromeFrame padding) = 66. */
TabBar : LiquidGlass {
  Direction: Row
  Justify: Start
  Align: Stretch
  Gap: 0pt
  Padding: 4pt
  Width: 400pt
  MaxWidth: 100%
  Height: 64pt
  BorderRadius: 66pt
}

/* Concentric with TabBar: 66 - 4 (TabBar padding) = 62. */
TabItem {
  Direction: Column
  Justify: Center
  Align: Center
  Gap: 4pt
  Width: 20%
  BorderRadius: 62pt
}

TabItemActive {
  Direction: Column
  Justify: Center
  Align: Center
  Gap: 0pt
  Width: 20%
  BorderRadius: 100pt
  Background: rgba(255, 255, 255, 0.15)
}

TabIcon {
  FontFamily: JwiftIcons
  FontSize: 24pt
  FontWeight: 400
  Color: rgba(255, 255, 255, 0.6)
  TextAlign: Center
}

TabIconActive {
  FontFamily: JwiftIcons
  FontSize: 20pt
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.95)
  TextAlign: Center
}

TabLabel {
  FontFamily: Inter
  FontSize: 10pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.6)
  TextAlign: Center
  LetterSpacing: 0.1pt
}

TabLabelActive {
  FontFamily: Inter
  FontSize: 10pt
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.95)
  TextAlign: Center
  LetterSpacing: 0.1pt
}
