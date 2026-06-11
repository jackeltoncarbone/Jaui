@ScreenR:   80pt
@ChromePad: 10pt
@GlassPad:  4pt

Screen {
  Direction: Column
  Background: rgb(0, 0, 0)
  FlexGrow: 1
  BorderRadius: @ScreenR
  Overflow: Hidden
  PointScale: 1.25
}

ChromeFrame {
  Position: Fixed
  Top: 0pt
  Left: 0pt
  Width: 100vw
  Height: 100vh
  Direction: Column
  Justify: SpaceBetween
  Align: Stretch
  Padding: @ChromePad
  Layer: 10
  PointerEvents: None
}

ToolbarRow {
  Direction: Row
  Justify: SpaceBetween
  Align: Center
  Padding: 12pt
  Layer: 20
  PointerEvents: Auto
}

ToolbarLogo {
  Height: 40pt
  Width: 104pt
  FlexShrink: 0
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

ContentBlur {
  ProgressiveBlurDirection: ToBottom
  Position: Fixed
  Width: 100vw
  Height: 250pt
  Left: 0pt
  Bottom: 0pt
  BackdropFilter: Blur(17pt)
  Background: rgba(0, 0, 0, 0.5)
  Layer: 5
}

TopBlur {
  ProgressiveBlurDirection: ToTop
  Position: Fixed
  Width: 100vw
  Height: 200pt
  Left: 0pt
  Top: 0pt
  BackdropFilter: Blur(24pt)
  Background: rgba(0, 0, 0, 0)
  Layer: 5
}

HeroStub {
  Direction: Column
  Justify: Center
  Align: Start
  Padding: 128pt 32pt 32pt 80pt
  Gap: 30pt
  Height: 70vh
  Background: rgba(81, 81, 81, 0.24)
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
  Width: 180pt
  FlexShrink: 0
}

HeroCtaLabel {
  FontFamily: Inter
  FontSize: 15pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
  TextAlign: Center
  FlexGrow: 1
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

LiquidGlass {
  Background: rgba(255, 255, 255, 0)
  BorderRadius: 32pt
  BorderWidth: 1pt
  BorderBlur: 0.25pt
  BorderFilter: Brightness(1.25) Saturate(1.5)

  ShadowColor: rgba(0, 0, 0, 0.18)
  ShadowBlur: 22pt
  ShadowOffsetY: 6pt

  BackdropFilter: Blur(4pt) Brightness(1.25) Saturate(1.25) Contrast(0.75)

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
  BackdropFilter: Blur(14pt) Brightness(1.05)
}

SectionViewAllLabel {
  FontFamily: Inter
  FontSize: 13pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
}

Row {
  Direction: Row
  Wrap: Wrap
  Justify: Start
  Align: Start
  Gap: 14pt
  RowGap: 14pt
  Padding: 2pt 4pt 2pt 4pt
  FlexGrow: 0
  FlexShrink: 0
}

RowCompact : Row {
  Gap: 12pt
  RowGap: 12pt
}

RowHero : Row {
  Gap: 16pt
  RowGap: 16pt
}

Card {
  Direction: Column
  Justify: End
  Align: Stretch
  Width: 260pt
  Height: 195pt
  BorderRadius: 48pt
  ShadowColor: rgba(0, 0, 0, 0.45)
  ShadowBlur: 24pt
  ShadowOffsetY: 10pt
  FlexGrow: 0
  FlexShrink: 0
  Overflow: Hidden
  FitMode: Cover
}

CardCompact : Card {
  Width: 200pt
  Height: 150pt
  ShadowColor: rgba(0, 0, 0, 0.4)
  ShadowBlur: 20pt
  ShadowOffsetY: 8pt
}

CardHero : Card {
  Width: 480pt
  Height: 360pt
  BorderRadius: 56pt
  ShadowColor: rgba(0, 0, 0, 0.5)
  ShadowBlur: 32pt
  ShadowOffsetY: 14pt
}

CardFooter {
  Direction: Column
  Justify: Start
  Align: Start
  Padding: 18pt
  Gap: 8pt
  ProgressiveBlurDirection: ToBottom
  BackdropFilter: Blur(32pt)
  Background: rgba(0, 0, 0, 0.55)
}

CardBadge {
  Direction: Row
  Justify: Center
  Align: Center
  Padding: 3pt 8pt
  BorderRadius: 999pt
  Background: rgba(255, 255, 255, 0.18)
}

CardBadgeLabel {
  FontFamily: Inter
  FontSize: 10pt
  FontWeight: 700
  Color: rgba(255, 255, 255, 0.95)
  LetterSpacing: 0.8pt
}

CardTitle {
  FontFamily: Inter
  FontSize: 22pt
  FontWeight: 700
  LineHeight: 1.1
  Color: rgba(255, 255, 255, 0.98)
  LetterSpacing: -0.2pt
}

CardTitleCompact : CardTitle {
  FontSize: 17pt
  FontWeight: 600
  LineHeight: 1.15
  Color: rgba(255, 255, 255, 0.97)
  LetterSpacing: 0pt
}

CardMeta {
  Direction: Row
  Justify: Start
  Align: Center
  Gap: 8pt
}

CardAvatar {
  Width: 20pt
  Height: 20pt
  BorderRadius: 999pt
  Background: rgba(255, 255, 255, 0.25)
}

CardMetaLabel {
  FontFamily: Inter
  FontSize: 12pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
}

CardDescription {
  FontFamily: Inter
  FontSize: 12pt
  FontWeight: 400
  LineHeight: 1.3
  Color: rgba(255, 255, 255, 0.75)
  MaxLines: 2
  TextOverflow: Ellipsis
}

ToolbarDropdown : LiquidGlass {
  Direction: Row
  Justify: Center
  Align: Center
  Width: 48pt
  Height: 48pt
  BorderRadius: @ScreenR - @ChromePad
}

ToolbarAvatar {
  Direction: Row
  Justify: Center
  Align: Center
  Width: 100%
  Height: 100%
  BorderRadius: @ScreenR - @ChromePad
}

ToolbarAvatarGlyph {
  FontFamily: JauiIcons
  FontSize: 20pt
  Color: rgba(255, 255, 255, 0.9)
  TextAlign: Center
}

TabBar : LiquidGlass {
  Direction: Row
  Justify: Start
  Align: Stretch
  Gap: 0pt
  Padding: @GlassPad
  Width: 400pt
  MaxWidth: 100%
  Height: 64pt
  BorderRadius: @ScreenR - @ChromePad
}

TabItem {
  Direction: Column
  Justify: Center
  Align: Center
  Gap: 4pt
  Width: 20%
  BorderRadius: @ScreenR - @ChromePad - @GlassPad
}

TabItemActive : TabItem {
  Gap: 0pt
  BorderRadius: 100pt
  Background: rgba(255, 255, 255, 0.15)
}

TabIcon {
  FontFamily: JauiIcons
  FontSize: 24pt
  FontWeight: 400
  Color: rgba(255, 255, 255, 0.6)
  TextAlign: Center
}

TabIconActive : TabIcon {
  FontSize: 20pt
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.95)
}

TabLabel {
  FontFamily: Inter
  FontSize: 10pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.6)
  TextAlign: Center
  LetterSpacing: 0.1pt
}

TabLabelActive : TabLabel {
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.95)
}
