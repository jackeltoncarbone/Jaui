# Glass in JSS: Apple's levers, our properties

The goal: Jaui's glass is Apple's glass model. Every Apple lever is a JSS property. Its default is Apple's value, so plain `Glass: Regular` gives Apple's result with nothing tuned.

This document maps Apple onto Jaui and proposes the syntax. The Apple facts it cites live in `Jwift/Apple/LiquidGlass.md` (the material) and `Jwift/Apple/Sizing.md` (the controls); section numbers below refer to those files. `Glass.md` keeps our implementation notes. Nothing here is built yet: Jack approves the syntax before phase 2.

Status column:
- **matches**: our output is Apple's value.
- **differs**: we draw something else; the gap is given.
- **missing**: Apple has it, we don't.
- **ours only**: not Apple's. Each one is a deletion candidate.

## 1. The material

| Apple lever (LiquidGlass.md) | proposed JSS, default | implemented today by | status |
|---|---|---|---|
| a glass exists; variant 0 / 1 (3.8) | `Glass: None \| Regular \| Clear \| Lens`, default None | `Thickness > 0` → `Material: LiquidGlass`; `GlassVariant` | differs in form: two properties for one lever; Thickness doubles as a 0..1 fade |
| variant 14, 15 (3.8, 7) | `Glass: Lens` | none | missing (values [I]) |
| frost, the blur class: Automatic / Reduced / None (2, 3.2 Frost) | `GlassFrost: Inherit \| Automatic \| Reduced \| None`, built; Inherit at the root is Automatic | the cascade (`_cascadeGlassFrost`, `EffectiveGlassFrost`), lane 46 above the exterior switches (4 x 16384 a class), `GlassBlurRadius` / `GlassBackdropScale` / `GlassNativeLod` | matches: Apple's `GlassFrostTrait`, set by the scroll pocket; ours is set by `Jwift_PageHeader` and `JwiftScrollEdge` (None, their pockets blur), `Jwift_TabBar` (Automatic, as Apple's frames read [I]), menus and sheets (Automatic). Measured at 44 pt, 3x: 4.21 / 1.22 / 2.38 px; Apple's Photos bar in its pocket 2.5 to 2.7 |
| S, u, v (2) | derived, not authored | `JivGlassSpan`, `GlassSizeRamps` | matches |
| inner / outer lens (3.1) | `GlassRefraction: Auto \| Inner(<amount>, <height>) Outer(<amount>, <height>) Opacity(<n>)` | `GlassInnerShift`, the outer shift in `Jiv.Panel.frag`, lane 39 `Refraction` as a multiplier | matches the laws; `Refraction` as a free multiplier is ours only |
| blur radius and ramp (3.2) | `GlassBlur: Auto \| <pt>`, built | `GlassBlurRadius`, `GlassBodyLod`; an authored value rides lane 46 above the dispersion in sixteenths of a point (0 is Auto) | matches: Apple's LOD names a Gaussian (`GLASS_TEXEL_SIGMA_*` x its texel, fitted 0.62, Apple's own x1.6 read back), and each read finds the level of whatever pyramid it gets that delivers it (`GlassPyramidLevel`, from the level-0 texel and sigma the build records on its region), since we never render below native. Measured: 11.6 px at 3x on large glass (law 11.9, Apple 10.7 to 11.8), 4.9 on a 62 pt bar (Apple 5.0 to 5.3) |
| face matrix (3.3) | `GlassFace: Auto \| Ycc(<white>, <black>, <saturation>, <fill>)` | the face table in `Glass.md`; `GlassFaceParamsOf` | matches from 96 pt: the recipe's [C] regular faces (Drill Sentences lane GL1), handed off from the fitted ones over 64 to 96 pt. Differs at 64 pt and under: fitted to SwiftUI and iOS captures of glass that size (the recipe's numbers rendered 58 levels off SwiftUI's 96 pt capsule, macOS 27); to settle with the adaptive switch |
| thin-glass luma tracking (3.3) | derived | the probe (`u_ShadowState`, 56 pt gate) | differs: Apple's law is now [C] (LiquidGlass.md 3.3): a hysteresis switch between the regular light and dark faces, gated at 64 pt; ours blends a fitted face by the mean. No JSS option yet |
| edge bleed (3.4) | `GlassBleed: Auto \| None`, built | shader; None zeroes the reach (amount, height) and keeps the blur and opacity, riding lane 46 as 2 x 16384 | matches: DesignLibrary zeroes `EdgeBleed.amount` and `height` when Layers lacks 0x40, which the sheet subvariants 27 to 29 remove (`sub_18AE83CAC`, `sub_18AE88C0C`) [C] |
| outer lens past the outline (3.1) | `GlassOuterRefraction: Auto \| None`, built | shader outer shift; None rides lane 46 as 1 x 16384 | matches: DesignLibrary zeroes `Refraction.outerHeight` and `outerAmount` when Layers lacks 0x10 (the sheet subvariants, `SolariumDisableOuterRefraction`) [C] |
| drop shadow (3.5) | `GlassShadow: Auto \| Platter \| None`, built | shader, `GlassShadowRadius` 10 + 14 u; `GlassShadowPeak`; the flat draw (black) or the glass program's colored read (v > 0) | differs: our small-glass radius is 10 pt (fitted to one Edit button) where Apple's is 24. Large glass matches the law, which is faint: 7.4% darker at 4 pt below a 250 pt dark menu over luma 0.3, 5.1% at 12, 2.1% at 24, 0.4% at 40, and nothing in light (M_shadow keeps luma) |
| the platter's own shadow (LiquidGlass.md 3.5, [I]) | `GlassShadow: Platter`, built; worn by menus, popovers, sheets and the sheet's ask | a second flat draw under Apple's: black, sigma 30 pt, 10 pt down, 0.18 light / 0.35 dark, all over `v` (none at 64 pt and under; half sigma and offset there), Apple's fall at reach 2 sqrt 2 sigma (`GlassPlatterShadowOf`) | [I]: UIKit's platter and sheet drop-shadow views, not read. With it the 250 pt dark menu darkens 26% at 4 pt below, 21% at 12, 13% at 24, 6% at 40, 1% at 64; light 10%, 9%, 6%, 3%, 0.6% |
| a carried row's platter (Drill Sentences lane SH2, [I]) | `GlassShadow: Lift`, built; worn by a sortable list's lifted row | the platter shadow above at its size's sigma and offset, its opacity whole at any size (`GlassPlatterShadowOf`'s `Lift`): UIKit lifts a dragged item onto a platter (`_UIPlatterView`) however thin it is, and `Platter`'s `v` ramp left a 68 pt row none | [I]: the drag platter's shadow values are not read |
| the popover arrow (Jwift/Apple/Sizing.md 13, [C]) | `GlassArrow: None \| Top \| Bottom \| Leading \| Trailing`, `GlassArrowOffset: <length>` (from the edge's centre, UIKit's `arrowOffset`), built | the glass SDF is the body's continuous corner unioned with Apple's arrow (`GlassArrowUnion`, Glass.Pipeline.glsl and .ts): 13 pt tall on a 26 pt base, the tip one cubic on the peak, concave fillets meeting the edge over 37 pt. The face, lens, rim, bleed, Apple's shadow and the platter's all read that one distance; under the arrow's footprint the body's own edge is no edge, so no rim runs along the seam. It rides lane 38 above the shadow draw's mode (`GlassArrowLane`); the quad, the pyramid's region and the paint extents grow by its height (`GlassArrowReach`, `GlassShadowExtent`). Jwift's `<popover>` wears it at regular width, beside or below its anchor (Drill Sentences lane GL4) | matches the outline; ours never pins into a corner: the offset is clamped so the 37 pt stay clear of the corner radius |
| holding tone, clamp (3.6) | derived | shader, clamp `[0, 1]` | matches (SDR) |
| dispersion (3.7) | `GlassDispersion: 0` (`aberration_amount`) | `ChromaticAberration`, a per-channel read | differs: ours is not Apple's 6-tap filter; Apple sets 0 on standard glass and on the lens |
| tint (4) | `GlassTint: None \| <color>`, built | `GlassTint` (or, as before, a glass `Background`) is the seed, riding the Background channel (`_resolveGlassSeed`; ignored off glass, so a tint is never a flat fill); `mix(darkShade, seed, L)` over the finished glassBackground, holding tone included, under the rim (`GlassTint`, Jiv.Panel.frag; `GlassTintOf`, `GlassTintedBodyOf`). Worn by `JwiftProminent`, Apple's `.glassProminent` (Drill Sentences lane GL6) | matches the structure and the order [C]; the dark shade `ycc(seed, 0.58, 0, 0.63)` is the general law fitted to Apple's two iOS 26 rows [I], within 8 levels of both |
| rim (5) | `GlassRim: Auto \| None \| Rim(<amount>, <height>)` | `RimWidth` 1 pt, `RimStrength` 2, c = 3, dark matrix mixed 0.6 / 0.4 | differs: Apple's amount is 0.5 per light and its dark rows are unmixed |
| labels (6) | derived | `@JwiftVibrancyLabel`, `u_GlassInk` | matches |
| grouping (8) | `GlassGroup: None \| <name>`, `GlassSmoothness: 8` | none (the parity row is NOT BUILT); `?glass-group` only shares a backdrop | missing |
| glass over glass: `_UITraitGlassElevationLevel` (8.1) | derived, not authored | the walk (`Jaui.ts`): a glass face that reads the content takes the share of its box over earlier glass face boxes (`GlassCoveredShare`) to an elevation, none to half, all from 0.9 (`GlassElevationOf`). An elevated face reads the glass it is presented over (`GlassReadsComposite`, Drill Sentences lane GL5): its pyramid, sharp tap and shadow read come from the scene as drawn, the lower glass's final pixels and its content, not the plate, so a sheet's rows show through a menu as a soft blur, lensed at its edge. It takes no busy-backdrop frost there (the 4 pt law holds). The elevation rides lane 42 above the scheme bit in 31sts, and large dark glass moves to `GLASS_FACE_APPLE_DARK_ELEVATED`, Y -> 0.24 Y + 0.222, chroma held (x 1) (`GlassFaceParamsOf`) | differs, [I]: Apple's trait changes no face, only the tint's weights [C]; Apple's menu reads a step up because its backdrop holds the sheet, as ours now does. Apple's face alone over our sheet (0.18, it reads the page through its dim) would darken it -6 L*, so the presented face lifts and holds chroma: the 250 pt dark menu over the bare sheet over the field draws (48.7, 59.1, 37) on (38.5, 49, 26), +4.5 L* (Apple's measured menu over a sheet +4.8); over any dark sheet, clear to its large-detent face, +3.5 to +15.5 L*, and each level of a stack lighter than the one under it with 97% of its chroma. One row of white text under the menu swings its body about 13 levels at 4 pt. Light keeps its face, which lifts on its own. Glass 64 pt and under never steps; a sheet over the tab bar never elevates and reads the plate. The tint's weaker weights are not built. Cost: none extra; the presented face's build reads the scene texture in place of the plate (the plate sync over its own region is usually empty) |
| corner (10) | `BorderRadius`, one continuous-corner model, smoothing 0.6 | `Corner.Continuous.glsl` | matches (done) |
| `Tint`, `TintTone` on glass | none | `Tint`, `TintTone` (glass ignores them) | ours only: delete from glass |

## 2. The liquid lens (LiquidGlass.md 7)

| Apple piece | proposed JSS, default | today | status |
|---|---|---|---|
| the lens view on a selection | `Lens: None \| Tab \| Segment` on the indicator | `Jwift_SelectionIndicator_Pressed`, a Layer 2 glass | differs: ours is one glass over a snapshot |
| lens size, item + 8 pt all round (Tab); pill + 12 / 8 pt (Segment) | derived from `Lens`; `LensOutset: Auto \| <x> <y>` | `SelectionIndicator.Geometry.ts`: the pill + 8 / 8 (Tab), + 12 / 8 (Segment), grown by bounds, concentric with the bar | matches, and ours holds the ends at the lens's own inset |
| warped copy of the items, real items erased (destOut) | derived from `Lens` | none; the lens magnifies a snapshot of bar and items (flat plate 1.21) | missing; the plate is ours only |
| backdrop below, warped and blurred (warpsContentBelow) | `LensWarpBelow: Auto \| None` | none | missing (lifted values [I]) |
| warpSDF amount −17.5, SDF displacement 11.2 | `LensWarp: Auto` | none | missing (law [I]) |
| inner shadow radius 3, opacity 0.12, y 7 | derived | `GLASS_LENS_SHADOW_PEAK` 0.1, an outer shadow | differs; ours only |
| glass variant 14, no tint, no aberration | derived | Clear glass, `ChromaticAberration` 0.25, `LensInk` recolor, `GlassLensBody` screen curve and 0.935 ceiling, iridescent rim heights | ours only: delete |
| hang time 0.22 s | derived | none (the bar lets go at once) | missing |
| selection springs (Sizing.md 1) | `@Spring X { Damping: 0.85, Response: 0.2s }` (Apple's form, proposed) | grow 409 / 25.3, release 2187 / 112 (fitted), position 85 ms, size 220 ms | differs |

Also ours only, and deletion candidates: `Magnification`, `LensInk`, `GLASS_LENS_BEZEL`, `GLASS_LENS_SPLIT`, `GLASS_LENS_OVER_BAR`, `GLASS_LENS_BAR_INSET`, lanes 50 to 53 as the lens uses them, `GlassLensBody`, `GlassLensRimHeights`, `GLASS_LENS_SHADOW_PEAK`.

## 3. Sizing: Apple against ours

Apple's column is `Sizing.md`; ours is the Jwift sheet named.

### Tab bar (Jwift TabBar.jss, SelectionIndicator)

| part | Apple | ours | delta |
|---|---|---|---|
| bar height | 54 pt content [C]; 61.7 to 62 pt outer measured [I] | 62 pt | 0 against the measured outer |
| inset to the pill | 4 pt measured [I] (item vertical padding 4 [C]) | 4 pt | 0 |
| side margins | 21 pt [C value] | 12 pt dock padding | −9 pt |
| item horizontal padding | 24 pt under 5 items, 15 at 5+ [C] | cells split the bar, 3.75 pt inner padding | differs (ours equal slices) |
| gap between items | 0 measured [I] | 0 | 0 |
| selected pill | the item frame [C]; 54 pt tall measured | the cell, 54 pt | 0 |
| symbol | 18 pt medium, large scale [C]; 24 pt box measured [I] | 21 pt JwiftIcons face (drawn ≈ 24 pt) | matches the box |
| label | system 10 pt, medium; semibold when selected [C] | Inter 10 pt, 500; 600 selected (`Jwift_TabLabel`, `_TabLabelActive`) | 0 in weight; Inter's strokes still read heavier than SF's |
| symbol centre | 20 pt below the item top [C] (`_UITabButton` layoutSubviews) | 19.8 pt when the item `Gap` is 3.8 pt and the label `LineHeight` 1.05 (held, see Sizing.md 1) | 0.2 pt; today 20.8 pt |
| label baseline | frame bottom 7 pt above the item bottom [C], so 44.6 pt with SF's 2.41 pt descent | 44.67 pt with the same (held) values | 0.1 pt; today 43.0 pt |
| search circle | the bar's inner height [I] | 62 pt (`Jwift_TabAccessory`) | ≈ 0 |
| lens size | item + 16 × item + 16 [C]: ≈ 70 pt tall | item + 16 × 70 pt, by bounds, radius 35 = 31 + 4 | 0 |
| lens width, measured | 105 pt on a 78 pt pitch [I] | 106 pt at that pitch | +1 |
| bar swell pressed | 1.04 measured [I] | 1.02 (`Jwift_TabBar_Pressed`) | −0.02 |
| item scale | none [C]; the copy reads 1.16 icon, 1.19 label [I] | the plate reads 1.21 about the lens centre | differs |
| drag stretch | the flex formula, min 0.75 / max 1.15 (Loupe) [C] | the Loupe row on velocity (FlexMovement.ts), area kept, no narrower than square | min differs: square keeps it concentric |
| springs | 0.85 / 0.2 s, 0.85 / 0.3 s dragging; 0.85 / 0.4 s, 0.85 / 0.6 s release [C] | the same for position and bounds; lift 409 / 25.3 grow, 2187 / 112 release (fitted) | lift springs lost to decompilation |

### Segmented control (our tab bar with label-only items)

| part | Apple | ours | delta |
|---|---|---|---|
| height | 32 pt (26 at size 1) [C] | 56 pt bar, 4 pt inset (the pricing finder) | +24 pt |
| lens | pill + 24 wide, + 16 tall, never narrower [C] | the dock's rule (96 pt on a 170 pt pill) | narrower than the pill: wrong |
| font | 15 pt [C] | the tab label, 10 pt (solo label: its own size) | differs |

### Glass button (GlassButton.jss)

| part | Apple | ours | delta |
|---|---|---|---|
| round, icon only | corner style 4 [C]; diameter not found | 48 pt | [I] |
| pill | capsule [C]; height not found | 48 pt, 22 pt side padding | [I] |
| square corner | small 14, medium 17, large 25 [C] | 14 pt at 48 pt | 0 at small |
| hit region | ≥ 44 pt [C] | 48 pt | ok |
| press | `_UIFlexInteraction`, the dynamic variant [C] (LiquidGlass.md 9) | `Flex: Auto` from `JwiftPressGlass` / `JwiftFlex` (Core/Flex.ts) | matches; no hover swell (Apple has none) |

### Menu (ContextMenu.jss, GlassDropdown.jss)

| part | Apple | ours | delta |
|---|---|---|---|
| corner radius | 32 [C] | context menu 12, dropdown 28 | −20, −4 |
| width | 250 [C] | context menu 180 to 280, dropdown 260 | ≈ |
| row | 42 pt from baselines [I from C], 44 measured [I] | 6 / 10 pt padding on a 13 pt label | shorter |
| row side padding | 28 [C] | 10 | −18 |
| section insets | 10 top and bottom [C] | 4 / 6 | −6 / −4 |
| highlight | radius 24, insets 10 / 2 [C] | radius 8 | differs |
| blur | regular glass, BlurRadius 4 pt [C]; the page behind reads σ 3.6 pt on Apple's frames [I] | `JwiftGlass`, Auto: σ 3.9 pt at the centre, 2.8 pt a quarter in | 0 within Apple's spread |
| flex | variant 5, Menu [C] | `Flex: Menu` exists (glow only, the pulse not ported); the open dropdown wears `Flex: None` (Jack: an open menu is inert) | differs |

### Search field (TextInput.jss `Jwift_Field_Glass`)

| part | Apple | ours | delta |
|---|---|---|---|
| height | 44, 48 floating [C] | 48 | 0 floating, +4 otherwise |
| shape | capsule [C] | capsule | 0 |
| leading inset | 12 (13 floating) to the icon, 7 (8) to the text [C] | 18 pt padding | +5 |

## 3a. The press: `_UIFlexInteraction` (LiquidGlass.md 9), built

| Apple lever | JSS, default | Apple's default | status |
|---|---|---|---|
| the variant | `Flex: None \| Auto \| Small \| UltraSmall \| Large \| Menu`, default None | Auto: UltraSmall under a 120 pt longer side, else Small to Large by the shorter side [C] | matches |
| liftScalePoints | `FlexLift: Auto \| <points>` | 16 small, 4 large; scale `(longer + pts) / longer` [C] | matches |
| bigGlowOpacity | `FlexBigGlow: Auto \| <0..1>` | 1 small, 0 large [C] | matches; drawn on glass only (`GlassPressGlow`, lane 43 with `GlassGlow`) |
| littleGlowOpacity | `FlexLittleGlow: Auto \| <0..1>` | 0.3 small, 0.2 large, 0.5 menu [C] | matches in value; the disc's blur law and its colour matrix are [I] (`GlassTouchGlow`, lanes 48 and 49) |
| translation stretch, acceleration squash | `FlexStretch: Auto \| <number>` | on, 1 (sources 3) [C] | matches the law; the integrator's smoothing is [I] (50 ms); a multiple of Apple's, ours |
| springs | none (Apple's) | scale, tracking and glow springs [C] | matches |

**The amounts are ordinary numeric properties.** `FlexLift`, `FlexBigGlow`, `FlexLittleGlow` and `FlexStretch` spring like any other (default Stiffness 260, Damping 32) and take `@Transition` / `@Spring` under their own names, so a state rule that changes one eases in, mid-press too, and Auto eases to a number and back (Auto is a weight on the spec's value for the control's size). `FlexStretch` multiplies the stretch toward the finger and the acceleration squash about the lift: 0 is none (the lift and glows alone), 1 is Apple's, 1.5 half again. It scales `movementPoints` and the squash range around 1 together, so it holds on a small control and a large one. The stretch is a render transform, but the panel is redrawn at its stretched size with a true continuous corner (radius times the mean scale, clamped to the half side), never a scaled corner. `Flex: None` mid-press lets the press settle home on its springs.

```
Jwift_Thing : JwiftGlass, JwiftPressGlass {
  FlexStretch: 1.5
  @Transition FlexStretch { Duration: 200ms }
}
Jwift_Thing:Disabled { FlexStretch: 0 }       // eases the stretch out, keeps the lift and glows
```

`FlexHold: <0..1>`, default 0 -- ours, no Apple lever: the fraction of the pressed lift and big glow held with
nobody touching it, as if the control sat pressed on its own. No Auto, and no stretch toward a finger; it
springs under its own name like the other amounts, so a state rule that sets it eases in. A real press on top
takes the larger of its own lift/glow and the held ones, so holding never doubles a press. Requires `Flex` not
`None`.

```
Jwift_Field_Glass:(Editing) { FlexHold: 1 }   // the active field sits lifted and glowing, no finger down
```

Worn by: `JwiftPressGlass` (every glass button, the avatar pill, the drill sync button, the item page's glass actions, the hero's button), `JwiftProminent`, `JwiftDangerProminent` (solid plates: the lift and movement, no glow), and the tab bar (`Jwift_TabBar : JwiftGlass, JwiftFlex`), whose selection lens rides the bar's flex as its child and adds only its own loupe stretch. Not worn: rows, cells and chips (`JwiftPress`, a fill highlight), the open dropdown, the tab bar's round accessory (its lens and 1.02 swell). A field (`Jwift_Field_Glass`) wears only `FlexHold`, with `FlexStretch: 0`: a place, not a target, that holds its lift and glow while editing but never stretches toward a finger.

## 3b. Sheets (Jwift/Apple/Sheets.md), built

| Apple lever | JSS / input, default | Apple's default | status |
|---|---|---|---|
| detents | `<sheet [detents]>`, `['content']` | `[.large]`; a fitted sheet is the custom detent [C] | matches |
| `largestUndimmedDetentIdentifier` | `[largestUndimmedDetent]`, null | nil: dimmed at every detent [D] | matches |
| `prefersGrabberVisible` | `[grabber]`, shown only when resizable | off; the HIG asks for it on a resizable sheet [C][D] | matches |
| `isModalInPresentation` + discard ask | `[hasUnsavedChanges]`, false | false [D] | matches |
| the dimming view | `Jwift_SheetDim`, black at 0.2 / 0.48 | `_alertControllerDimmingViewColor` [C] | matches |
| partial-height inset | 8 pt closing to 0 at large, as layout | 8 pt as a uniform scale [C] | differs in form: reflow, not scale |
| corners | top `@JwiftSheetRadius` (44), bottom `max(@JwiftScreenRadius - inset, 20)`, form sheet `@JwiftSheetRadius` | `sub_189108DF4` [C]: top 38, bottom `max(display - 14 v, 20)`, form sheet 32 | differs by decision: Jack's concentric rule, one outer corner on every device |
| the display's corner | none: the app's outer corner is `@JwiftScreenRadius`, the tab bar's radius plus its inset | `displayCornerRadius` [C] | differs by decision (Jwift/Apple/Sizing.md 11) |
| the sheet pan | `PanClaim: None \| Down \| Vertical` on the card | UIKit's sheet pan yields to a scroller not at its top [C] | matches |
| spring | `@Spring { Stiffness: 333.3, Damping: 36.5 }` | damping 1, response 0.344 s [C] | matches; 0.8 on a fast flick is not built |
| the bar button | `<glass-button size="bar">`, 44 pt | 44 pt [I] | matches |

## 4. Sizing in JSS

Sizing stays ordinary layout (`Height`, `Padding`, `Gap`, `BorderRadius`); what changes is where the values come from. Each Jwift control's numbers become Apple's, named once as variables in the Jwift sheet (for example `@AppleTabBarHeight`, `@AppleMenuRadius`), each citing `Sizing.md`. Three behaviours become properties, because they are rules rather than numbers:

```
Lens: None | Tab | Segment                  // outsets (8 / 8, 12 / 8), hang time 0.22 s, its springs
LensOutset: Auto | <x> <y>                  // override of the outset only
Flex: None | Auto | Small | UltraSmall | Large | Menu   // built (section 3a); Loupe stays the tab lens's own
@Spring X { Damping: 0.85, Response: 0.2s } // Apple's spring form beside Stiffness / Damping / Mass
```

## 5. The proposed syntax, in full

```
Glass: None | Regular | Clear | Lens
GlassFrost: Inherit | Automatic | Reduced | None
GlassBlur: Auto | <pt>
GlassRefraction: Auto | Inner(<amount>, <height>) Outer(<amount>, <height>) Opacity(<n>)
GlassFace: Auto | Ycc(<white>, <black>, <saturation>, <fill>)
GlassOuterRefraction: Auto | None
GlassBleed: Auto | None
GlassShadow: Auto | Platter | None
GlassArrow: None | Top | Bottom | Leading | Trailing
GlassArrowOffset: 0 | <length>
GlassDispersion: 0 | <n>
GlassTint: None | <color>
GlassRim: Auto | None | Rim(<amount>, <height>)
GlassGroup: None | <name>
GlassSmoothness: 8 | <n>
BackdropRoot: false | true
BackdropScope: Page | Parent | Root
Lens: None | Tab | Segment
LensOutset: Auto | <x> <y>
LensWarp: Auto | <n>
LensWarpBelow: Auto | None
Flex: None | Auto | Small | UltraSmall | Large | Menu
FlexLift: Auto | <points>
FlexBigGlow: Auto | <0..1>
FlexLittleGlow: Auto | <0..1>
FlexStretch: Auto | <number>
```

`Auto` is Apple's law for the shape's S. Plain `Glass: Regular` is Apple's regular glass.

### 5a. `BackdropRoot` / `BackdropScope` — scoped backdrop sampling

A `BackdropFilter` normally sees the whole scene as painted so far — every element the walk drew
before this one, anywhere on the page. `BackdropScope` narrows that:

- `Page` (the default) — today's behavior: the whole scene so far.
- `Parent` — only this element's direct parent's children painted before it.
- `Root` — everything painted since the nearest `BackdropRoot: true` ancestor (falls back to
  `Page` with no such ancestor).

`BackdropRoot: true` on an ancestor is what bounds `BackdropScope: Root`; it does nothing on its
own and does not inherit — a container opts in once, and every scoped descendant below it (until a
nested `BackdropRoot`) resolves against it.

Apple's iOS 26 scroll edge is the motivating case: a toolbar floats over a scrolling list, and its
glass should read only the rows behind it, never the chrome around the scroller (a tab bar, a
sibling panel) that happens to sit earlier in paint order:

```
ScrollHost { Overflow: Scroll  BackdropRoot: true }
Bar        { Glass: Regular  BackdropFilter: Blur(16pt)  BackdropScope: Root  Position: Pinned }
```

`Bar`'s frost now blurs only what `ScrollHost` paints — the rows scrolling under it — and is blind
to whatever else shares the page with the scroller.

## 6. How Jwift reads under it

```
JwiftGlass                        { Glass: Regular }
JwiftClearGlass                   { Glass: Clear }
Jwift_TabBar : JwiftGlass         { Height: @AppleTabBarHeight  Flex: Auto }       // built: JwiftFlex, the swell is the flex lift
Jwift_SelectionIndicator          { Background: @JwiftSelectionFill }             // the resting pill: no glass
Jwift_SelectionIndicator_Pressed  { Glass: Lens  Lens: Tab }
Jwift_SegmentIndicator_Pressed    { Glass: Lens  Lens: Segment }
Jwift_GlassBtn : JwiftGlass       { Flex: Auto }                                  // built: JwiftPressGlass carries it
Jwift_ContextMenuPanel : JwiftGlass { BorderRadius: @AppleMenuRadius  Width: @AppleMenuWidth  Flex: Menu }
Jwift_GlassDropdown : JwiftGlass  { GlassGroup: Toolbar }
Jwift_Field_Glass : JwiftGlass    { Height: @AppleSearchFieldFloating }
```

## 7. Migration plan

Each step is its own commit, behind the gate.

1. **The surface.** Add every property above, parsed, resolved and packed, with `Auto` equal to today's output. Nothing moves: the resting bar is pixel-identical.
2. **Apple's confirmed values, one lever at a time.** Face, rim amount, shadow radius, blur mapping. A lever switches to Apple's [C] value only when its same-backdrop measurement moves toward Apple. If the [C] value renders further from Apple's frames than our fit (the face did), that is a finding to settle first.
3. **Delete the material's extras.** `Thickness` as the switch and `GlassVariant` (replaced by `Glass`), `Tint` / `TintTone` on glass, `Refraction` as a free multiplier, `ChromaticAberration` (replaced by `GlassDispersion`).
4. **Grouping.** The SDF union at smoothness 8 / 12.
5. **The liquid lens, Apple's structure.** The warped item copy with the real items erased, the warped backdrop below, the inner shadow, the outset size rule, the springs, the hang time. The warp law stays [I] until read, and it is verified on the same backdrop against Apple's frames. Then delete `Magnification`, `LensInk`, the plate and fold constants, `GlassLensBody`, `GlassLensRimHeights`, the lens shadow peak, the lens sizing and velocity stretch in `SelectionIndicator.ts`, and the lanes that carried them.
6. **Flex.** Built for buttons (section 3a): the lift, stretch, squash and both glows replace `JwiftPressMotion`'s 1.06 / 0.92. Still to fold in: the bar swell (`TabBar.ts` overrides) and the lens's velocity stretch.
7. **Sizing.** Each control's values from `Sizing.md`, one control per commit, with the delta table above as its checklist.
8. **Variant 15, Apple's 6-tap dispersion.** (Frost, once read as size classes 1 and 2, is built.)

**The gate**, at every step:
- The resting bar is pixel-identical (rmse 0 against the frozen baseline) unless the step is proven to move toward Apple on the same-backdrop measurement.
- Every parity row that passes still passes. A row that measured our old model is replaced only by a row that measures Apple's, named in the commit.
- The lens behaviour holds: no slivers, labels upright, no page read in the lens, mid-drag strokes no worse, and grow and release timing within their rows.
