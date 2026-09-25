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
| size class 0 / 1 / 2 (2) | `GlassSize: Auto \| 0 \| 1 \| 2` | size class 0 laws only | missing |
| S, u, v (2) | derived, not authored | `JivGlassSpan`, `GlassSizeRamps` | matches |
| inner / outer lens (3.1) | `GlassRefraction: Auto \| Inner(<amount>, <height>) Outer(<amount>, <height>) Opacity(<n>)` | `GlassInnerShift`, the outer shift in `Jiv.Panel.frag`, lane 39 `Refraction` as a multiplier | matches the laws; `Refraction` as a free multiplier is ours only |
| blur radius and ramp (3.2) | `GlassBlur: Auto \| <pt>` | `GlassBlurRadius`, `GlassBodyLod` | matches the radius; we read a native pyramid mapped to Apple's LOD (`GLASS_TEXEL_SIGMA_*`, fitted), since we never render below native |
| face matrix (3.3) | `GlassFace: Auto \| Ycc(<white>, <black>, <saturation>, <fill>)` | the face table in `Glass.md` (fitted) | differs: fitted to SwiftUI and iOS captures, not the recipe's [C] numbers (the recipe's numbers rendered 58 levels off SwiftUI regular); to settle in phase 2 |
| thin-glass luma tracking (3.3) | derived | the probe (`u_ShadowState`, 56 pt gate) | differs: Apple's law is now [C] (LiquidGlass.md 3.3): a hysteresis switch between the regular light and dark faces, gated at 64 pt; ours blends a fitted face by the mean. No JSS option yet |
| edge bleed (3.4) | `GlassBleed: Auto \| None` | shader | matches |
| drop shadow (3.5) | `GlassShadow: Auto \| None` | shader, `GlassShadowRadius` 10 + 14 u | differs: our small-glass radius is 10 pt (fitted to one Edit button) where Apple's is 24 |
| holding tone, clamp (3.6) | derived | shader, clamp `[0, 1]` | matches (SDR) |
| dispersion (3.7) | `GlassDispersion: 0` (`aberration_amount`) | `ChromaticAberration`, a per-channel read | differs: ours is not Apple's 6-tap filter; Apple sets 0 on standard glass and on the lens |
| tint (4) | `GlassTint: None \| <color>` | a glass `Background` is the seed; dark shade fitted | matches in structure, shade fitted |
| rim (5) | `GlassRim: Auto \| None \| Rim(<amount>, <height>)` | `RimWidth` 1 pt, `RimStrength` 2, c = 3, dark matrix mixed 0.6 / 0.4 | differs: Apple's amount is 0.5 per light and its dark rows are unmixed |
| labels (6) | derived | `@JwiftVibrancyLabel`, `u_GlassInk` | matches |
| grouping (8) | `GlassGroup: None \| <name>`, `GlassSmoothness: 8` | none (the parity row is NOT BUILT); `?glass-group` only shares a backdrop | missing |
| corner (10) | `BorderRadius`, one continuous-corner model, smoothing 0.6 | `Corner.Continuous.glsl` | matches (done) |
| `Tint`, `TintTone` on glass | none | `Tint`, `TintTone` (glass ignores them) | ours only: delete from glass |

## 2. The liquid lens (LiquidGlass.md 7)

| Apple piece | proposed JSS, default | today | status |
|---|---|---|---|
| the lens view on a selection | `Lens: None \| Tab \| Segment` on the indicator | `Jwift_SelectionIndicator_Pressed`, a Layer 2 glass | differs: ours is one glass over a snapshot |
| lens size, item + 8 pt all round (Tab); pill + 12 / 8 pt (Segment) | derived from `Lens`; `LensOutset: Auto \| <x> <y>` | `SelectionIndicator.ts`: `min(1.708 bar, 1.35 pitch)` × `1.173 bar` | differs: our rule can be narrower than the pill (the pricing control shows it); Apple's never is |
| warped copy of the items, real items erased (destOut) | derived from `Lens` | none; the lens magnifies a snapshot of bar and items (flat plate 1.21) | missing; the plate is ours only |
| backdrop below, warped and blurred (warpsContentBelow) | `LensWarpBelow: Auto \| None` | none | missing (lifted values [I]) |
| warpSDF amount −17.5, SDF displacement 11.2 | `LensWarp: Auto` | none | missing (law [I]) |
| inner shadow radius 3, opacity 0.12, y 7 | derived | `GLASS_LENS_SHADOW_PEAK` 0.1, an outer shadow | differs; ours only |
| glass variant 14, no tint, no aberration | derived | Clear glass, `ChromaticAberration` 0.25, `LensInk` recolor, `GlassLensBody` screen curve and 0.935 ceiling, iridescent rim heights | ours only: delete |
| hang time 0.22 s | derived | none (the bar lets go at once) | missing |
| selection springs (Sizing.md 1) | `@Spring X { Damping: 0.85, Response: 0.2s }` (Apple's form, proposed) | grow 409 / 25.3, release 2187 / 112 (fitted), position 85 ms, size 220 ms | differs |

Also ours only, and deletion candidates: `Magnification`, `LensInk`, `GLASS_LENS_BEZEL`, `GLASS_LENS_SPLIT`, `GLASS_LENS_OVER_BAR`, `GLASS_LENS_BAR_INSET`, lanes 50 to 53 as the lens uses them, `GlassLensBody`, `GlassLensRimHeights`, `GLASS_LENS_SHADOW_PEAK`, the lens `VisualScale` sizing in `SelectionIndicator.ts`, and its velocity stretch (`STRETCH_MAX`, `SPEED_HALF`, `PERP_GAIN`, `SQUISH_*`).

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
| lens size | item + 16 × item + 16 [C]: ≈ 70 pt tall | 72.7 pt tall, 1.35 pitch wide (1.708 bar cap) | +2.7 pt tall; width rule differs |
| lens width, measured | 105 pt on a 78 pt pitch [I] | 106 pt at that pitch | +1 |
| bar swell pressed | 1.04 measured [I] | 1.02 (`Jwift_TabBar_Pressed`) | −0.02 |
| item scale | none [C]; the copy reads 1.16 icon, 1.19 label [I] | the plate reads 1.21 about the lens centre | differs |
| drag stretch | the flex formula, min 0.75 / max 1.15 (Loupe) [C] | velocity stretch up to 0.35, squish 0.22 | differs |
| springs | 0.85 / 0.2 s, 0.85 / 0.3 s dragging; 0.85 / 0.4 s, 0.85 / 0.6 s release [C] | 409 / 25.3 grow, 2187 / 112 release; 85 ms, 220 ms transitions | differs |

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
| translation stretch, acceleration squash | `FlexMovement: Auto \| None` | on (sources 3) [C] | matches the law; the integrator's smoothing is [I] (50 ms) |
| springs | none (Apple's) | scale, tracking and glow springs [C] | matches |

Worn by: `JwiftPressGlass` (every glass button, the avatar pill, the drill sync button, the item page's glass actions), `JwiftProminent`, `JwiftDangerProminent` (solid plates: the lift and movement, no glow). Not worn: rows, cells and chips (`JwiftPress`, a fill highlight), fields, the open dropdown. The tab bar still sets its swell and glow from `TabBar.ts` through `FlexLiftScale` / `FlexBigGlow`, which now read the same spec.

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
GlassSize: Auto | 0 | 1 | 2
GlassBlur: Auto | <pt>
GlassRefraction: Auto | Inner(<amount>, <height>) Outer(<amount>, <height>) Opacity(<n>)
GlassFace: Auto | Ycc(<white>, <black>, <saturation>, <fill>)
GlassBleed: Auto | None
GlassShadow: Auto | None
GlassDispersion: 0 | <n>
GlassTint: None | <color>
GlassRim: Auto | None | Rim(<amount>, <height>)
GlassGroup: None | <name>
GlassSmoothness: 8 | <n>
Lens: None | Tab | Segment
LensOutset: Auto | <x> <y>
LensWarp: Auto | <n>
LensWarpBelow: Auto | None
Flex: None | Auto | Small | UltraSmall | Large | Menu
FlexLift: Auto | <points>
FlexBigGlow: Auto | <0..1>
FlexLittleGlow: Auto | <0..1>
FlexMovement: Auto | None
```

`Auto` is Apple's law for the shape's S. Plain `Glass: Regular` is Apple's regular glass.

## 6. How Jwift reads under it

```
JwiftGlass                        { Glass: Regular }
JwiftClearGlass                   { Glass: Clear }
Jwift_TabBar : JwiftGlass         { Height: @AppleTabBarHeight  Flex: Auto }       // the 1.02 swell goes; the flex lift replaces it
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
8. **Size classes 1 and 2, variant 15, Apple's 6-tap dispersion.**

**The gate**, at every step:
- The resting bar is pixel-identical (rmse 0 against the frozen baseline) unless the step is proven to move toward Apple on the same-backdrop measurement.
- Every parity row that passes still passes. A row that measured our old model is replaced only by a row that measures Apple's, named in the commit.
- The lens behaviour holds: no slivers, labels upright, no page read in the lens, mid-drag strokes no worse, and grow and release timing within their rows.
