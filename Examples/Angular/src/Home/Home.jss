@ScreenR:   5pt
@ChromePad: 0.625pt
@GlassPad:  0.25pt

Screen {
  Direction: Column
  Background: rgb(0, 0, 0)
  FlexGrow: 1
  BorderRadius: @ScreenR
  Overflow: Hidden
  PointScale: 1
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
  Padding: 0.75pt
  Layer: 20
  PointerEvents: Auto
}

ToolbarLogo {
  Height: 2.5pt
  Width: 6.5pt
  FlexShrink: 0
}

Scroll {
  Direction: Column
  Justify: Start
  Align: Stretch
  Padding: 0pt 0pt 2pt 0pt
  Gap: 2.5pt
  Overflow: Scroll
  FlexGrow: 1
}

TabBarRow {
  Direction: Row
  Justify: Center
  Align: Center
  Height: 4pt
  PointerEvents: Auto
}

ContentBlur {
  ProgressiveBlurDirection: ToBottom
  Position: Fixed
  Width: 100vw
  Height: 15.625pt
  Left: 0pt
  Bottom: 0pt
  BackdropFrostBlur: 1.0625pt
  Background: rgba(0, 0, 0, 0.5)
  Layer: 5
}

TopBlur {
  ProgressiveBlurDirection: ToTop
  Position: Fixed
  Width: 100vw
  Height: 12.5pt
  Left: 0pt
  Top: 0pt
  BackdropFrostBlur: 1.5pt
  Background: rgba(0, 0, 0, 0)
  Layer: 5
}

HeroStub {
  Direction: Column
  Justify: End
  Align: Start
  Padding: 5pt 5pt 4pt 5pt
  Gap: 1.25pt
  Height: 60vh
  Background: rgba(81, 81, 81, 0.24)
  FlexGrow: 0
  FlexShrink: 0
}

HeroTitle {
  FontFamily: Inter
  FontSize: 2.75pt
  FontWeight: 700
  LineHeight: 1.1
  Color: rgba(255, 255, 255, 0.98)
  LetterSpacing: -0.06pt
  Width: 37.5pt
}

HeroCta {
  Direction: Row
  Justify: Center
  Align: Center
  Padding: 0.75pt 2pt
  BorderRadius: 62.5pt
  Background: rgba(255, 255, 255, 0.1)
  Width: 11.25pt
  Height: 3pt
  FlexGrow: 0
  FlexShrink: 0
}

HeroCtaLabel {
  FontFamily: Inter
  FontSize: 0.9375pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
  TextAlign: Center
  FlexGrow: 1
}

ThickRow {
  Direction: Row
  Justify: Center
  Align: Center
  Gap: 2pt
  Padding: 2pt 1.5pt 2pt 1.5pt
  FlexGrow: 0
  FlexShrink: 0
}

KeyLight {
  LightType: Directional
  LightColor: rgb(255, 250, 235)
  LightIntensity_: 1.3
  LightDirection: -0.4 0.5 -1
}

Slab {
  Width: 9pt
  Height: 6pt
  BorderRadius: 1.75pt
  Background: rgba(255, 255, 255, 0.92)
  ShadowColor: rgba(0, 0, 0, 0.45)
  FlexGrow: 0
  FlexShrink: 0
}

Slab0 : Slab {
  Elevation: 0
  Fillet: 0
}

Slab1 : Slab {
  Elevation: 8
  Fillet: 6
  ShadowBlur: 0.75pt
  ShadowOffsetY: 0.5pt
}

Slab2 : Slab {
  Elevation: 20
  Fillet: 14
  ShadowBlur: 1.5pt
  ShadowOffsetY: 1pt
}

Slab3 : Slab {
  Elevation: 40
  Fillet: 24
  ShadowBlur: 2.5pt
  ShadowOffsetY: 1.75pt
}

Section {
  Direction: Column
  Justify: Start
  Align: Stretch
  Gap: 0.875pt
  Padding: 0pt 1.5pt 0pt 1.5pt
  FlexGrow: 0
  FlexShrink: 0
}

SectionHeader {
  Direction: Row
  Justify: SpaceBetween
  Align: Center
  Gap: 0.5pt
}

SectionTitle {
  FontFamily: Inter
  FontSize: 1.375pt
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.96)
  LetterSpacing: -0.0125pt
}

LiquidGlass {
  Background: rgba(255, 255, 255, 0)
  BorderRadius: 2pt
  BorderWidth: 0.0625pt
  BorderBlur: 0.015625pt
  BorderColor: rgba(255, 255, 255, 0.18)
  BorderBrightness: 1.15
  BorderSaturation: 1

  ShadowColor: rgba(0, 0, 0, 0.18)
  ShadowBlur: 1.375pt
  ShadowOffsetY: 0.375pt

  BackdropFrostBlur: 0.25pt
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
  FresnelStrength: 0.4
  ChromaticAberration: 0
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
  Padding: 0.375pt 0.75pt
  BorderRadius: 62.5pt
  BorderWidth: 0.0625pt
  BorderColor: rgba(255, 255, 255, 0.18)
  BackdropFrostBlur: 0.875pt
  BackdropBrightness: 1.05
}

SectionViewAllLabel {
  FontFamily: Inter
  FontSize: 0.8125pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
}

Row {
  Direction: Row
  Wrap: Wrap
  Justify: Start
  Align: Start
  Gap: 0.875pt
  RowGap: 0.875pt
  Padding: 0.125pt 0.25pt 0.125pt 0.25pt
  FlexGrow: 0
  FlexShrink: 0
}

RowCompact : Row {
  Gap: 0.75pt
  RowGap: 0.75pt
}

RowHero : Row {
  Gap: 1pt
  RowGap: 1pt
}

Card {
  Direction: Column
  Justify: End
  Align: Stretch
  Width: 16.25pt
  Height: 12.1875pt
  BorderRadius: 3pt
  ShadowColor: rgba(0, 0, 0, 0.45)
  ShadowBlur: 1.5pt
  ShadowOffsetY: 0.625pt
  FlexGrow: 0
  FlexShrink: 0
  Overflow: Hidden
  FitMode: Cover
}

CardCompact : Card {
  Width: 12.5pt
  Height: 9.375pt
  ShadowColor: rgba(0, 0, 0, 0.4)
  ShadowBlur: 1.25pt
  ShadowOffsetY: 0.5pt
}

CardHero : Card {
  Width: 30pt
  Height: 22.5pt
  BorderRadius: 3.5pt
  ShadowColor: rgba(0, 0, 0, 0.5)
  ShadowBlur: 2pt
  ShadowOffsetY: 0.875pt
}

CardFooter {
  Direction: Column
  Justify: Start
  Align: Start
  Padding: 1.125pt
  Gap: 0.5pt
  ProgressiveBlurDirection: ToBottom
  BackdropFrostBlur: 2pt
  Background: rgba(0, 0, 0, 0.55)
}

CardBadge {
  Direction: Row
  Justify: Center
  Align: Center
  Padding: 0.1875pt 0.5pt
  BorderRadius: 62.5pt
  Background: rgba(255, 255, 255, 0.18)
}

CardBadgeLabel {
  FontFamily: Inter
  FontSize: 0.625pt
  FontWeight: 700
  Color: rgba(255, 255, 255, 0.95)
  LetterSpacing: 0.05pt
}

CardTitle {
  FontFamily: Inter
  FontSize: 1.375pt
  FontWeight: 700
  LineHeight: 1.1
  Color: rgba(255, 255, 255, 0.98)
  LetterSpacing: -0.0125pt
}

CardTitleCompact : CardTitle {
  FontSize: 1.0625pt
  FontWeight: 600
  LineHeight: 1.15
  Color: rgba(255, 255, 255, 0.97)
  LetterSpacing: 0pt
}

CardMeta {
  Direction: Row
  Justify: Start
  Align: Center
  Gap: 0.5pt
}

CardAvatar {
  Width: 1.25pt
  Height: 1.25pt
  BorderRadius: 62.5pt
  Background: rgba(255, 255, 255, 0.25)
}

CardMetaLabel {
  FontFamily: Inter
  FontSize: 0.75pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.85)
}

CardDescription {
  FontFamily: Inter
  FontSize: 0.75pt
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
  Width: 3pt
  Height: 3pt
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
  FontSize: 1.25pt
  Color: rgba(255, 255, 255, 0.9)
  TextAlign: Center
}

TabBar : LiquidGlass {
  Direction: Row
  Justify: Start
  Align: Stretch
  Gap: 0pt
  Padding: @GlassPad
  Width: 25pt
  MaxWidth: 100%
  Height: 4pt
  BorderRadius: @ScreenR - @ChromePad
}

TabItem {
  Direction: Column
  Justify: Center
  Align: Center
  Gap: 0.25pt
  Width: 20%
  BorderRadius: @ScreenR - @ChromePad - @GlassPad
}

TabItemActive : TabItem {
  Gap: 0pt
  BorderRadius: 6.25pt
  Background: rgba(255, 255, 255, 0.15)
}

TabIcon {
  FontFamily: JauiIcons
  FontSize: 1.5pt
  FontWeight: 400
  Color: rgba(255, 255, 255, 0.6)
  TextAlign: Center
}

TabIconActive : TabIcon {
  FontSize: 1.25pt
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.95)
}

TabLabel {
  FontFamily: Inter
  FontSize: 0.625pt
  FontWeight: 500
  Color: rgba(255, 255, 255, 0.6)
  TextAlign: Center
  LetterSpacing: 0.00625pt
}

TabLabelActive : TabLabel {
  FontWeight: 600
  Color: rgba(255, 255, 255, 0.95)
}
