# Glass

Every glass surface (`Thickness > 0`, material `LiquidGlass`) runs Apple's Liquid Glass pipeline with Apple's constants. The shader half is `Jiv/Shaders/Glass.Pipeline.glsl`, used by `Jiv.Panel.frag`. The CPU half is `Core/Glass.Pipeline.ts`, used by the instance packer, the blur plan and the shadow. Nothing about a glass surface's optics is authored. Its size, its variant and its backdrop decide it.

Status: **[C]** is confirmed, read from Apple's binaries, shader IR or live layer dumps (see Sources). **[I]** is inferred: Apple's structure, with our best reading of a value.

## Inputs

- `d` is the signed distance to the outline in points, negative inside. `n` is the outward normal.
- `S` is the span, the shape's minor dimension in points. [C]
- `u = sat((S - 48) / 112)` and `v = sat((S - 64) / 96)`. [C]
- Variant: `GlassVariant: Regular | Clear`.

## The glassBackground pass

**Lens** [C]
- `shift(d, amount, height) = amount * (1 - sqrt(h(2 - h)))`, where `h = sat(-d / height)`.
- Inner shift: amount `max(-0.8 S, -60)`, height `min(0.25 S, 20)`.
- Outer shift: amount `+0.2 S`, height `0.125 S`.
- The outer sample is mixed in at `0.3 * sat(d + 1)` on regular glass, and not at all on clear glass.
- `Refraction` scales the lens (1 is Apple's).

**Blur** [C]
- `BlurRadius = 1.3333 + 2.6667 u` points on regular glass, 1 point on clear glass.
- It is scaled by a ramp against `d + innerShift`: 1 from `-0.5 S` inward, 0.5 over the last point.
- Apple's LOD is `log2(r)`, or `log2(1 + 0.5 r)` when `r < 2`, where `r = radius * backdropScale * dpr * 1.6`.
- `backdropScale` is 0.25 for regular glass and 0.5 for clear.

**Blur, our mapping** [I]
- Apple samples a quarter (clear: half) resolution backdrop. We never render below native, so we sample our own native pyramid at the LOD with the same blur.
- Apple's level L has texels `2^L / backdropScale` device px wide. Our LOD n is a Gaussian `2^n` device px wide.
- So `n = L + log2(share / backdropScale)`.
- The share is fitted per backdrop scale to SwiftUI's own render, so the detail left in the body matches: 0.62 for regular's quarter-scale backdrop, 0.28 for clear's half scale (2026-09-24).
- The pyramid is built at the sharpest read (the edge ramp's half radius), with mips up to the deepest.

**Face** [C structure, fitted parameters]
- QuartzCore's `set_ycc_composite`: BT.709 `Y' = (W - B) Y + B`, chroma scaled by `Sat`, then `* (1 - fill.a) + fill.rgb` (premultiplied).
- The macOS 26 dump values (light 1.03 / 0.5 / 1 / white 0.4, dark 0.6 / 0.2 / 1 / black 0.4, clear 1.15 / 0.075 / 1.06) do not reproduce current Apple. The parameters are therefore FITTED, 2026-09-23:
  - light and clear: to SwiftUI's own render of the same inputs (gpui-liquid-glass `validation/`, macOS 27), least squares on the label-free body over our own lensed read;
  - dark: to Apple's native iOS 26 dark captures (LiquidGlassGallery `Dark/`: the Photos, App Store and Games bars and small controls), body against the backdrop beside it.

| glass | W | B | Sat | fill | as a line | fitted to |
|---|---|---|---|---|---|---|
| regular, light | 1.0054 | 0.0829 | 1.2246 | white 0.4 | Y -> 0.554 Y + 0.450, chroma x 0.735 | SwiftUI regular, macOS 27 |
| regular, dark | 0.9608 | 0.2941 | 1.4167 | black 0.4 | Y -> 0.40 Y + 0.176, chroma x 0.85 | iOS bars |
| regular, dark, 56 pt and under | 0.6879 | 0.1412 | 1.6 | black 0.25 | Y -> 0.41 Y + 0.106, chroma x 1.2 | iOS small controls |
| clear, both | 1.1054 | 0.1295 | 0.885 | none | Y -> 0.976 Y + 0.130, chroma x 0.885 | SwiftUI clear, macOS 27 |

**Edge bleed** [C] (regular glass, S of 64 pt and up)
- Samples the backdrop `shift(d, 0.35 S, 0.35 S)` outward, blurred at `0.35 S`.
- Maps it by light `(1, 0.9, 1.2)` or dark `(0.5, 0, 1)`.
- Mixes it in by `(lum^2 * sat(1 - d))^2 * v * (0.5 light, 0.8 dark)`, where `lum` is the face's luma on light glass and `1 - lum` on dark.

**Shadow** [C structure; small-glass radius fitted]
- Offset `(0, 8)` pt. The erf-like fall runs over plus and minus two radii.
- Radius 24 pt on large glass (Apple's dumps), 10 pt at 48 pt, ramping over `u`. The 10 is fitted 2026-09-24 to Apple's iPhone Edit button over white: 23 levels deep at the edge, gone by 18 pt. At 24 pt the shadow reached 34 pt.
- Opacity `0.5 - 0.25 u`. Clear glass casts none.
- Small glass casts black at the fill `0.12 + SDR (0.08 + 0.16 u)`. The black fill's 0.12 in dark is [I].
- From 64 pt, `v` carries a colored read: the backdrop `min(0.625 S, 75)` pt past the outline, blurred at 40 pt, mapped light `(1, 0, 1.8)` or dark `(0.5, 0, 1)`.
- The shadow's distance offset is [I] 0. The 40 pt blur's unit conversion is [I], taken as the body blur's.

**Holding tone and clamp** [C]
- The interior is dimmed to 97%, easing to 100% over the outer one to two points.
- Output is clamped. Apple's clamp ceilings (1.0 to 1.376) are above white on an SDR target, so the clamp is `[0, 1]`.

## Tint [C structure, fitted shade]

A glass Background is the seed of Apple's `.tint(color)`. The face is replaced by a line in the glassed pixel's luma L, reaching the seed at full brightness [C]:

`tint = mix(darkShade, seed, L)`

The shade at L = 0 is the seed's own luma at 0.35 with its chroma at 1.10: `darkShade = ycc(seed, 0.35, 0, 1.10)`. It is fitted 2026-09-23 to SwiftUI's regular and clear tint of the same inputs (coral, macOS 27). Both variants share the one line; free per-channel lines fit to within 1.3 levels. Apple's iOS 26 orange and blue tint rows sit nearer 0.6 of the seed, so the shade is macOS 27's.

## The highlight (the rim) [C structure, fitted amounts]

Two lights over a band `RimWidth` deep (1 pt):
- the key upper left, the fill lower right (the handedness is [I]);
- a spread of 90 degrees on regular glass, 160 on clear;
- a fade of `1 - 0.7 depth`;
- each light weighted `w = a / ((1 - a) c + 1)` of its band alpha `a`.

The band recolors what is under it: `out = mix(D, sat(M D), alpha)`, `alpha = RimStrength * (w_key + w_fill)`, clamped to 1. Apple's two vibrant color matrices:
- light: `Y -> 0.90 + 0.10 Y`, chroma x 1.5;
- dark: `Y -> 0.15 + 1.35 Y`, chroma x 3.

M is picked by the glass's appearance, as Apple's is: its backdrop's luminance on glass 56 pt and under (the probe), its theme above that. A solid surface's rim takes its theme.

Fitted 2026-09-24 to Apple's iOS 26 dark rims (LiquidGlassGallery `Dark/`: the Games tab bar, its search button, the Play hero pill):
- On dark glass, M is the matrices mixed 0.6 light to 0.4 dark. The Games bar's and search button's lit lobes, (66, 215, 223) and (97, 230, 229) over teal, are that mix; either matrix alone misses them. Light glass takes the light rows.
- The shaping `c = 3`, not read from the dumps. Apple's lobe is sharper than the plain cosine: the lit lobe stands +100 over the body, the straight top 45 degrees off it +40.
- `RimStrength` 2, the lobe's alpha at the clamp. Apple's confirmed macOS 0.5 lit iOS rims at a third of their brightness.
- Every surface wears the one rim, a hero's action included (Jack's call); Apple's Games Play pills stand quieter, +11 to +20.

The rim rides `BorderLayer`: it lights what is drawn under it at that slot, so it lies over the glass's own content (a photo, a pill, a glyph). Both paths below compute one layer, `GlassRim` in Glass.Pipeline.glsl:
- Glass whose content below the slot stays clear of the band (the common case) lights the band in its own fragment, over its face. No extra reads.
- Glass whose content reaches the band, and a solid surface's edge, draw it in the `RIM_ONLY` program over a snapshot of the scene under the box, at the slot (`Jaui.ts`, `_glassRimInPass`).

The two give the same pixels where they both apply; the parity check renders both.

## Labels [C]

A label on glass is white at 95% on dark glass and black on light glass, following the glass's appearance, not the theme. Jwift's label level (`@JwiftVibrancyLabel`, Vibrancy.md) is exactly that. Text inside glass that tracks its backdrop turns with it (`Text.Quad.frag`, `u_GlassInk`).

## The active lens [measured, fitted]

A finger on a selection (Jwift's `Jwift_SelectionIndicator_Pressed`) lifts the resting pill into a clear lens. Apple's reference is its iOS 26 tab bar: a MacStories native screen recording (1320 px, 60 fps, light) and a dark Music capture (LiveBar and LiquidGlassGallery `ActiveLens/`).

- Size: a capsule sized against the BAR, not scaled from our cell: 1.173 bar heights tall (Apple's 217 px over its 185 px bar, 5.3 pt past the bar top and bottom) and 1.35 item pitches wide (316 px over Apple's 234 px pitch), capped at 1.708 bar heights. A bar denser than Apple's four items keeps the 1.35 pitches, so the lens stops short of the neighbours' labels as Apple's does; Apple ships no five-item iOS 26 bar to measure. `SelectionIndicator.ts` draws it as a `VisualScale` override, render-time, from the bar's height and pitch.
- Its backdrop is the bar as drawn: the lens draws above the tab items (Layer 2) and reads a snapshot of its box taken there, after the bar's glass and its items, sharp (no pyramid, no blur). What shows through the bar arrives frosted by the bar itself; our glyphs arrive crisp. Glass inside a drawn glass surface samples that surface, never a scroll edge's content (`Jaui.ts`, `closesEdge`).
- Refraction: a flat magnifying plate with a bezel-only fold. Every pixel of the body reads `centre + (p - centre) / 1.21`, the same in x and y (Apple's Home label reads 1.21 x wider; ours 1.22). Across the bezel, 0.095 of the span (7 pt), the read runs linearly back to 1 at the outline, so nothing past the lens is pulled into it: on a bar denser than Apple's a pull draws a copy of the neighbour's label beside the lensed one. Each channel reads out to its own edge, red past the outline and blue short of it: that is the fringe, 0.88 pt at the median in light and 0.11 pt in dark on Apple's frames. The lens stands 1.173 bar heights tall and reads only inside the bar it stands on, up to the bar's own outline and its darker edge, never the page. The plate is reconstructed by Catmull-Rom, so a magnified glyph stays as sharp as Apple's. The whole refraction fades with the glass, so a release leaves no fold behind.
- Body: a screen curve `1 - (1 - c)^g` that keeps the ink's depth. Light, g 2.3, lifts Apple's 177 bar body to its 238, capped at 0.935 so the clear rim (Apple: 250 over 238) still reads over a white bar. Dark, g 1.8, lifts our dark bar (44) to Apple's dark lens interior (73). Fitted.
- Shadow: a plain black shadow, 10% at the edge and gone 13 pt below it (Apple's light frames: 16 levels just below the rim, none above). `GLASS_LENS_SHADOW_PEAK`.
- Rim: the clear highlight, iridescent: each channel's band deeper by its own share, a third of a turn apart around the outline. 0.9 pt median split in light, a tenth of that in dark. Fitted.
- Timing: grow on a spring (409, 25.3: 8% overshoot), let go on another (2187, 112: no overshoot), both fitted to the 60 fps frames; the bar lets go the moment the finger lifts. Our engine's lens scale, frame by frame, tracks Apple's frames within 0.05 (grow) and 0.09 (release) rmse.

A tab switch is never cross-faded (App.Config.ts): the app is one canvas, so a route cross-fade blends the old frame over the new and draws the dock twice, the old bar and lens fading over the new ones.

The items under the lens take the selection's tint, as Apple's do: `LensInk` (the bar's accent, set by SelectionIndicator.ts) recolors the ink the lens magnifies, bright ink in dark and dark ink in light, over the lifted body. The drag follow has no reference; the captures do not show the finger.

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

- AlexStrNik/ShatteredGlass (layer tree, filter keys): https://github.com/AlexStrNik/ShatteredGlass
- SSFSKIM/designer, W12 G1 layer dump (size laws, highlight, tint): https://github.com/SSFSKIM/designer/blob/main/packages/calibration/results/2026-09-03-w12-lens/g1/g1-layer-dump.md
- Quince-Pie/walle (bit-exact shader replay, YCbCr constants): https://github.com/Quince-Pie/walle/blob/main/LIQUID_GLASS_EVIDENCE.md
- lennondotw/interaction-lab (macOS 27 metallib uniforms): https://github.com/lennondotw/interaction-lab/tree/main/archive/2026-08-liquid-glass-internals
- EthanArbuckle/iPhone18-3_26.1_23B85_Restore (iOS 26.1 QuartzCore and DesignLibrary): https://github.com/EthanArbuckle/iPhone18-3_26.1_23B85_Restore
- ktiays/GlassExplorer: https://github.com/ktiays/GlassExplorer
- gpui-liquid-glass (SwiftUI reference captures used for verification): its `validation/` folder.
