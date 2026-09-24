# Glass

Implementation notes: how Jaui draws glass. Apple's own model (the laws, the values, the layer tree, the lens, the sizing) is in `Jwift/Apple/LiquidGlass.md` and `Jwift/Apple/Sizing.md`; section numbers below refer to them. The JSS mapping, what matches and what differs, and the migration are in `Glass.Jss.md`.

Every glass surface (`Thickness > 0`, material `LiquidGlass`) runs Apple's pipeline. The shader half is `Jiv/Shaders/Glass.Pipeline.glsl`, used by `Jiv.Panel.frag`. The CPU half is `Core/Glass.Pipeline.ts`, used by the instance packer, the blur plan and the shadow.

## Inputs

- `d` and `n` come from the panel SDF (`Corner.Continuous.glsl`), in points.
- `S` is `JivGlassSpan`; `u` and `v` are `GlassSizeRamps` (LiquidGlass.md 2).
- Variant: `GlassVariant: Regular | Clear`.

## The glassBackground pass

**Lens**: `GlassShift` and `GlassInnerShift` are LiquidGlass.md 3.1, with the outer sample mixed in at `0.3 * sat(d + 1)` on regular glass. `Refraction` scales the whole lens (1 is Apple's); it is ours, not an Apple lever.

**Blur, our mapping** [I]
- Apple samples a quarter (clear: half) resolution backdrop (LiquidGlass.md 3.2). We never render below native, so we sample our own native pyramid at the LOD with the same blur.
- Apple's level L has texels `2^L / backdropScale` device px wide. Our LOD n is a Gaussian `2^n` device px wide, so `n = L + log2(share / backdropScale)`.
- The share is fitted per backdrop scale to SwiftUI's own render, so the detail left in the body matches: 0.62 for regular's quarter-scale backdrop, 0.28 for clear's half scale (2026-09-24).
- The pyramid is built at the sharpest read (the edge ramp's half radius), with mips up to the deepest.

**Face**: QuartzCore's `set_ycc_composite` (LiquidGlass.md 3.3), with FITTED parameters. Apple's recipe values do not reproduce current Apple renders (see Verification), so ours are fitted, 2026-09-23:
- light and clear: to SwiftUI's own render of the same inputs (gpui-liquid-glass `validation/`, macOS 27), least squares on the label-free body over our own lensed read;
- dark: to Apple's native iOS 26 dark captures (LiquidGlassGallery `Dark/`: the Photos, App Store and Games bars and small controls), body against the backdrop beside it.

| glass | W | B | Sat | fill | as a line | fitted to |
|---|---|---|---|---|---|---|
| regular, light | 1.0054 | 0.0829 | 1.2246 | white 0.4 | Y -> 0.554 Y + 0.450, chroma x 0.735 | SwiftUI regular, macOS 27 |
| regular, dark | 0.9608 | 0.2941 | 1.4167 | black 0.4 | Y -> 0.40 Y + 0.176, chroma x 0.85 | iOS bars |
| regular, dark, 56 pt and under | 0.6879 | 0.1412 | 1.6 | black 0.25 | Y -> 0.41 Y + 0.106, chroma x 1.2 | iOS small controls |
| clear, both | 1.1054 | 0.1295 | 0.885 | none | Y -> 0.976 Y + 0.130, chroma x 0.885 | SwiftUI clear, macOS 27 |

**Edge bleed**: LiquidGlass.md 3.4 as written.

**Shadow**: LiquidGlass.md 3.5, except the radius: 10 pt at 48 pt ramping to 24 over `u` (`GlassShadowRadius`), fitted 2026-09-24 to Apple's iPhone Edit button over white (23 levels deep at the edge, gone by 18 pt; at 24 pt ours reached 34 pt). The black fill's 0.12 in dark, the distance offset 0, and the 40 pt blur's unit conversion (taken as the body blur's) are [I].

**Holding tone and clamp**: LiquidGlass.md 3.6; the clamp is `[0, 1]`, since Apple's ceilings sit above white on an SDR target.

## Tint

A glass Background is the seed of Apple's tint (LiquidGlass.md 4): `tint = mix(darkShade, seed, L)`. Our shade at L = 0 is the seed's own luma at 0.35 with its chroma at 1.10, `darkShade = ycc(seed, 0.35, 0, 1.10)`, fitted 2026-09-23 to SwiftUI's regular and clear tint of the same inputs (coral, macOS 27). Both variants share the one line; free per-channel lines fit to within 1.3 levels. Apple's iOS 26 orange and blue rows sit nearer 0.6 of the seed, so the shade is macOS 27's.

## The highlight (the rim)

LiquidGlass.md 5, with our fitted amounts (2026-09-24, Apple's iOS 26 dark rims, LiquidGlassGallery `Dark/`: the Games tab bar, its search button, the Play hero pill):
- On dark glass, M is the matrices mixed 0.6 light to 0.4 dark. The Games bar's and search button's lit lobes, (66, 215, 223) and (97, 230, 229) over teal, are that mix; either matrix alone misses them. Light glass takes the light rows.
- The shaping `c = 3`. Apple's lobe is sharper than the plain cosine: the lit lobe stands +100 over the body, the straight top 45 degrees off it +40.
- `RimStrength` 2, the lobe's alpha at the clamp. Apple's 0.5 lit iOS rims at a third of their brightness.
- Every surface wears the one rim, a hero's action included (Jack's call); Apple's Games Play pills stand quieter, +11 to +20.
- M is picked by the glass's appearance: its backdrop's luminance on glass 56 pt and under (the probe), its theme above that. A solid surface's rim takes its theme.

The rim rides `BorderLayer`: it lights what is drawn under it at that slot, so it lies over the glass's own content (a photo, a pill, a glyph). Both paths below compute one layer, `GlassRim` in Glass.Pipeline.glsl:
- Glass whose content below the slot stays clear of the band (the common case) lights the band in its own fragment, over its face. No extra reads.
- Glass whose content reaches the band, and a solid surface's edge, draw it in the `RIM_ONLY` program over a snapshot of the scene under the box, at the slot (`Jaui.ts`, `_glassRimInPass`).

The two give the same pixels where they both apply; the parity check renders both.

## Labels

LiquidGlass.md 6: a label on glass is white at 95% on dark glass and black on light glass, following the glass's appearance, not the theme. Jwift's label level (`@JwiftVibrancyLabel`, Vibrancy.md) is exactly that. Text inside glass that tracks its backdrop turns with it (`Text.Quad.frag`, `u_GlassInk`).

## The active lens [ours: fitted to Apple's frames]

This is not Apple's lens structure (LiquidGlass.md 7: a warped copy of the items over a warped backdrop). It is our fit of how Apple's lens looks, and every part of it is a deletion candidate in `Glass.Jss.md`.

A finger on a selection (Jwift's `Jwift_SelectionIndicator_Pressed`) lifts the resting pill into a clear lens. Apple's reference is its iOS 26 tab bar: a MacStories native screen recording (1320 px, 60 fps, light) and a dark Music capture (LiveBar and LiquidGlassGallery `ActiveLens/`).

- Size: a capsule sized against the BAR, not scaled from our cell: 1.173 bar heights tall (Apple's 217 px over its 185 px bar, 5.3 pt past the bar top and bottom) and 1.35 item pitches wide (316 px over Apple's 234 px pitch), capped at 1.708 bar heights. A bar denser than Apple's four items keeps the 1.35 pitches, so the lens stops short of the neighbours' labels as Apple's does; Apple ships no five-item iOS 26 bar to measure. `SelectionIndicator.ts` draws it as a `VisualScale` override, render-time, from the bar's height and pitch.
- Its backdrop is the bar as drawn: the lens draws above the tab items (Layer 2) and reads a snapshot of its box taken there, after the bar's glass and its items, sharp (no pyramid, no blur). What shows through the bar arrives frosted by the bar itself; our glyphs arrive crisp. Glass inside a drawn glass surface samples that surface, never a scroll edge's content (`Jaui.ts`, `closesEdge`).
- Refraction: a flat magnifying plate with a bezel-only fold. Every pixel of the body reads `centre + (p - centre) / 1.21`, the same in x and y (Apple's Home label reads 1.21 x wider; ours 1.22). Across the bezel, 0.095 of the span (7 pt), the read runs linearly back to 1 at the outline, so nothing past the lens is pulled into it: on a bar denser than Apple's a pull draws a copy of the neighbour's label beside the lensed one. Each channel reads out to its own edge, red past the outline and blue short of it: that is the fringe, 0.88 pt at the median in light and 0.11 pt in dark on Apple's frames. Down, the lens's height maps onto the bar's: the plate's 1 / 1.21 inside, the bar's own outline (its darker edge included) at the lens's rim, from the bar's top and bottom packed per lens (lanes 52/53), so however tall a drag stretches the lens it never reads the page above the bar. The plate is reconstructed by Catmull-Rom, so a magnified glyph stays as sharp as Apple's. The whole refraction fades with the glass, so a release leaves no fold behind.
- Body: a screen curve `1 - (1 - c)^g` that keeps the ink's depth. Light, g 2.3, lifts Apple's 177 bar body to its 238, capped at 0.935 so the clear rim (Apple: 250 over 238) still reads over a white bar. Dark, g 1.8, lifts our dark bar (44) to Apple's dark lens interior (73). Fitted.
- Shadow: a plain black shadow, 10% at the edge and gone 13 pt below it (Apple's light frames: 16 levels just below the rim, none above). `GLASS_LENS_SHADOW_PEAK`.
- Rim: the clear highlight, iridescent: each channel's band deeper by its own share, a third of a turn apart around the outline. 0.9 pt median split in light, a tenth of that in dark. Fitted.
- Timing: grow on a spring (409, 25.3: 8% overshoot), let go on another (2187, 112: no overshoot), both fitted to the 60 fps frames; the bar lets go the moment the finger lifts. Our engine's lens scale, frame by frame, tracks Apple's frames within 0.05 (grow) and 0.09 (release) rmse.

A tab switch is never cross-faded (App.Config.ts): the app is one canvas, so a route cross-fade blends the old frame over the new and draws the dock twice, the old bar and lens fading over the new ones.

The items under the lens take the selection's tint, as Apple's do: `LensInk` (the bar's accent, set by SelectionIndicator.ts) recolors the ink the lens magnifies, bright ink in dark and dark ink in light, over the lifted body; only ink near those extremes turns, so content frosted through the bar keeps its own color. The drag follow has no reference; the captures do not show the finger.

### Verify on our own bar, never over Apple's frames

Apple's frames are the REFERENCE, never the backdrop. Our lens is only ever rendered on our own tab bar: the real Jwift bar, glyphs and labels, over a real page, in Jaui's own engine (the LiveBar harness beside the parity check: `LiveBar/shoot.mjs`, measured by `LiveBar/measure.py`). A lens composited over an Apple screenshot magnifies Apple's bar and Apple's glyphs baked into it, and proves nothing about ours. The sheets put the two side by side, APPLE | NOW, and nothing of Apple's is drawn under ours. The optics and the geometry are read off our LIVE APP: our own build on our own port, pressed and dragged by the press helper's trusted mouse events (`LiveApp/press.mjs`, measured by `LiveApp/optics_live.py`), because a harness can miss what the app does around the engine (a route cross-fade drew the dock twice on release, which no engine harness could show).

## Cost per frame

Extra texture reads per fragment:

| | Reads |
|---|---|
| Face | 1 read (3 with dispersion), plus 1 in the outer point of regular glass |
| Edge bleed | 1 per face fragment, regular glass 64 pt and up |
| Colored shadow | 1 per shadow fragment, glass 64 pt and up; smaller glass's shadow reads nothing |
| Highlight on glass, content clear of the band | 0 |
| Highlight on glass with content at the band, or on a solid surface | 1 per rim-quad fragment, plus one snapshot copy of its box |

The rim pass is not free where it runs: on SwiftShader a library page's 12 glass surfaces at 3x cost 10 ms a frame more through it (24 to 34 ms), about nothing on a desktop GPU. Hence the in-fragment path wherever the content allows it.
| Probe | 96 taps, one 1x1 draw per glass surface |

## Verification

**SwiftUI reference.** Same inputs as SwiftUI's own render (gpui-liquid-glass `validation/`: `harbour.png`, a 440 x 96 pt capsule, radius 34, 2x, macOS 27). Mean absolute error over the label-free body, 0 to 255:

| variant | dump values | fitted |
|---|---|---|
| regular | 58 | 6.2 |
| clear | 11 | 1.8 |
| regular tint | 21 | 3.6 |
| clear tint | 37 | 4.7 |

**iOS dark captures.** Mean absolute body-luma residual in levels:

| | dump value (0.24 Y + 0.12) | fitted |
|---|---|---|
| bars (5 captures) | 25.7 | 11.7 |
| small controls, Lock Screen excluded | about 21 | about 10 |

The Mac hero pills carry a larger lift than iOS's and sit 26 to 47 over the fit.

## The parity check

Every property above has an isolated test against its Apple reference, and a live-path check that it is wired in the real resolve, pack and draw path. One command runs them all and prints `property | Apple | ours | metric | PASS/FAIL`, exiting non-zero on a FAIL:

```
sh C:/Users/jackc/AppData/Local/Temp/claude/C--Users-jackc/09ee8d5e-80fe-47d9-9f89-c18df11719be/scratchpad/Parity/run.sh
```

Run it after any change to glass: the engine (`Glass.Pipeline.*`, `Jiv.Panel.*`, the instance packer, the walk's glass path) or the Jwift glass sheet. It is outside the repository, in the session scratchpad; its table lists what is NOT BUILT as well.

## Sources

Apple sources are listed in `Jwift/Apple/LiquidGlass.md`. Our references: gpui-liquid-glass `validation/` (SwiftUI reference renders), LiquidGlassGallery native captures, the MacStories iOS 26 tab bar recording.
