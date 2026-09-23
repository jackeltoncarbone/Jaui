# Vibrancy

Vibrancy is how content reads through a surface that already dims or blocks what is behind it. Jaui has one model for it, implemented in `Vibrancy.ts`. Jwift states Apple's levels as tokens in `Jwift.Glass.jss`.

## Apple's model

- **UIKit.** `UIVibrancyEffect(blurEffect:style:)` takes a `UIVibrancyEffectStyle`:
  - `label`, `secondaryLabel`, `tertiaryLabel` and `quaternaryLabel`, for text;
  - `fill`, `secondaryFill` and `tertiaryFill`, "for views with large filled areas";
  - `separator`, "for separator lines".
- **HIG, Materials.** "iOS and iPadOS also define vibrant colors for labels, fills, and separators that are specifically designed to work with each material. Labels and fills both have several levels of vibrancy; separators have one level."
- **SwiftUI, `Material`.** "When you add a material, foreground elements exhibit vibrancy." The hierarchical styles `.primary` through `.quaternary` pick the level.

## The formula

Every zone draws the same thing, where `a` is the coverage of the draw:

```
out = dst * (1 - cover * a)  +/-  (|amount| / 255) * color * a
```

| Argument | Range | Meaning |
|---|---|---|
| `amount` | -255 to 255 | Signed, in 0-255 units. The sign is the theme flip: positive brings light, negative darkens. |
| `cover` | 0 to 1 (default 0) | How much of what is under the draw is dimmed. 0 is a pure add (a fill, a glow). 1 with amount 255 is ordinary ink. |
| `color` | a color (default white) | Shape zones only. In the ink zone the color is the text's own `Color`. |

## Zones and syntax

```
BackdropFilter: Vibrancy([color,] amount [, cover])   what is under the element; its own paint still covers
Filter:         Vibrancy([color,] amount [, cover])   the element's own paint is vibrant too
TextFilter:     Vibrancy(amount [, cover])            only the ink; works on glass
Vibrancy:       <color> <amount> [<cover>]            cascades to descendants; None resets; Isolate stops it
```

Examples:

```
BackdropFilter: Vibrancy(@JwiftVibrancySecondaryFill)                  a resting fill
Title : JwiftLabelVibrancy { }                                        Apple's label on glass
TextFilter: Vibrancy(@JwiftVibrancyLabel, @JwiftVibrancyLabelCover)   the same, spelled out
Vibrancy: rgb(255, 220, 180) 30                                       a warm vibrancy for a subtree
```

Filters merge by function, and `None` keeps the base's value. Reset an inherited level with `Vibrancy(0)`.

## Apple's levels in Jwift

Each level was fitted per theme on Apple's native captures (LiquidGlassGallery), taking each ink pixel against the glass beside it. Cover is fitted from how much of the glass's chroma the ink keeps, and checked against a fit of luma against luma. Text wears a white `Color`, and the amount carries the ink.

| Apple level | Jwift token (amount, cover) | Dark | Light | Measured on |
|---|---|---|---|---|
| `label` | `@JwiftVibrancyLabel`, `@JwiftVibrancyLabelCover` | 212, 0.55 | 5, 0.88 | Dark: iPhone App Store and Photos tab bars (0.63 and 0.48). Light: Music. The macOS menu label agrees at 0.80. |
| `secondaryLabel` | `@JwiftVibrancySecondaryLabel`, `...Cover` | 160, 0.51 | -7, 0.24 | Light: macOS menu shortcuts. Dark is interpolated, because no dark capture held a clean one. |
| `tertiaryLabel` | `@JwiftVibrancyTertiaryLabel`, `...Cover` | 108, 0.47 | -4, 0.26 | Dark: the footnote on a macOS widget. Light: disabled macOS menu items. |
| `quaternaryLabel` | none | none | none | No capture in the gallery shows it. |
| `separator` | `@JwiftVibrancySeparator`, `...Cover` | 33, 0.13 | -2, 0.11 | Separators on a macOS widget and a macOS menu. |
| `fill` | `@JwiftVibrancyFill` | +30 | -20 | The selected Liquid Glass tab. The visionOS hover (+29) is this level, because Apple has no hover level. |
| `secondaryFill` | `@JwiftVibrancySecondaryFill` | +18 | -12 | Three resting fills (16.7, 18 and 19.7). |
| `tertiaryFill` | `@JwiftVibrancyTertiaryFill` | +9 | -6 | Half the secondary fill. |
| press | `@JwiftVibrancyFillPressed` | +50 | -29 | Derived rather than measured: Apple publishes no press. |

The fills have cover 0: Apple's fills add a constant and keep the colour under them whole. The classes `JwiftLabelVibrancy`, `JwiftSecondaryLabelVibrancy`, `JwiftTertiaryLabelVibrancy` and `JwiftSeparatorVibrancy` apply a level to an element. Extend one to use it.

## How it is drawn

Every vibrancy draw writes premultiplied `(rgb * a, cover * a)`. The panel and text programs do this through the uniform `u_VibrancyCover`, which is -1 for every ordinary draw. All vibrancy draws use one blend family, `SetVibrancyBlend`:

| Channel | Blend |
|---|---|
| rgb | `ONE, ONE_MINUS_SRC_ALPHA`, with `FUNC_ADD`, or `FUNC_REVERSE_SUBTRACT` when the amount is negative |
| alpha, shape draw | `ZERO, ONE` (a transparent element stays transparent) |
| alpha, ink | `ONE, ONE_MINUS_SRC_ALPHA` |

- **The shape draw.** The backdrop zone, the foreground zone and an authored property each draw one instance of the element's silhouette, with the same SDF, radii, clip stack and opacity as its fill. The draw is `|amount| x color`, under the element.
- **The graded path.** When something beside the shape draw already samples the backdrop (glass, a grade, a frost, a Tint or a progressive blur), the vibrancy folds into that grade instead: `b' = (1 - cover) b + 2 amount` and `c' = (1 - cover) b c / b'`.
- **Chromatic colors.** A chromatic vibrancy there is refused by name (`ChromaticGraded`), because the grade is three scalars.
- **The ink zone.** The text is its own batch. Its tint lane is scaled by `|amount|`.

## What it costs

- **A shape draw.** One draw call and two blend switches. It needs no snapshot, no sampler and no render target. It splits the shared panel batch, and `panelBatches=` counts that.
- **A folded vibrancy.** Nothing: it rides in the grade the fragment already runs.
- **Vibrant text.** One text batch of its own per element.
- **The layer cache.** Any vibrancy keeps its element out of the retained layer cache, because a capture draws over a cleared target and vibrancy over nothing is a different picture.
- **The gate line.** `jaui:vibrancy` reports every count, and `__jauiVibrancy()` returns the same census. `builds=` must stay 0. The URL flag `?vibrancy=on|graded|off` selects the implementations, the equivalence arm or the null arm.
