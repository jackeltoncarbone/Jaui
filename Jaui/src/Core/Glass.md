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
- So `n = L + log2(GLASS_TEXEL_SIGMA / backdropScale)`.
- `GLASS_TEXEL_SIGMA = 0.35` is fitted to SwiftUI's own render: the detail left in the body matches to within 0.3 levels on regular and clear glass.
- The pyramid is built at the sharpest read (the edge ramp's half radius), with mips up to the deepest.

**Face** [C]
- QuartzCore's `set_ycc_composite`: BT.709 `Y' = (W - B) Y + B`, chroma scaled by `Sat`, then `* (1 - fill.a) + fill.rgb` (premultiplied).

| glass | W | B | Sat | fill |
|---|---|---|---|---|
| regular, light | 1.03 | 0.5 | 1 | white 0.4 |
| regular, dark | 0.6 | 0.2 | 1 | black 0.4 |
| clear, both | 1.15 | 0.075 | 1.06 | none |

**Appearance and thin glass**
- Glass 56 pt and under tracks its backdrop's luma through the probe's eased mean (`Jiv.ShadowBackdrop.frag`). [C]
- Its appearance is light over bright content and dark over dim. The 0.45 to 0.55 band is [I].
- Its face moves between Apple's observed settled values [C values, I law]:
  - light: photo `0.319 / 0.919 / fill 0.516`, up to light solid `0.819 / 1.03 / fill 0.266` over mean 0.45 to 0.95;
  - dark: dark solid `0.1 / 0.45 / black 0.25`, up to the table's dark over mean 0 to 0.45.
- Larger glass takes the theme's appearance.
- The probe eases at 0.5 s [I]. Apple settles over about 1 to 8 s.

**Edge bleed** [C] (regular glass, S of 64 pt and up)
- Samples the backdrop `shift(d, 0.35 S, 0.35 S)` outward, blurred at `0.35 S`.
- Maps it by light `(1, 0.9, 1.2)` or dark `(0.5, 0, 1)`.
- Mixes it in by `(lum^2 * sat(1 - d))^2 * v * (0.5 light, 0.8 dark)`, where `lum` is the face's luma on light glass and `1 - lum` on dark.

**Shadow** [C]
- Offset `(0, 8)` pt, radius 24 pt. The erf-like fall runs over plus and minus two radii.
- Opacity `0.5 - 0.25 u`. Clear glass casts none.
- Small glass casts black at the fill `0.12 + SDR (0.08 + 0.16 u)`. The black fill's 0.12 in dark is [I].
- From 64 pt, `v` carries a colored read: the backdrop `min(0.625 S, 75)` pt past the outline, blurred at 40 pt, mapped light `(1, 0, 1.8)` or dark `(0.5, 0, 1)`.
- The shadow's distance offset is [I] 0. The 40 pt blur's unit conversion is [I], taken as the body blur's.

**Holding tone and clamp** [C]
- The interior is dimmed to 97%, easing to 100% over the outer one to two points.
- Output is clamped. Apple's clamp ceilings (1.0 to 1.376) are above white on an SDR target, so the clamp is `[0, 1]`.

## Tint [C structure, I shade]

A glass Background is the seed of Apple's `.tint(color)`. The face is replaced by `mix(darkShade, seed, luma(face))`, reaching the seed at full brightness. `darkShade = 0.6 * seed` [I]: Apple's orange matrix has exactly that red row, and blue's rows are within 0.04 of it.

## The highlight (the rim) [C]

Two lights, 0.5 each (`RimStrength`), over a band `RimWidth` deep (1 pt):
- the key upper left, the fill lower right (the handedness is [I]);
- a spread of 90 degrees on regular glass, 160 on clear;
- a fade of `1 - 0.7 depth`.

The band recolors what is under it: `out = mix(D, sat(M D), alpha)`. M is Apple's vibrant color matrix:
- light: `Y -> 0.90 + 0.10 Y`, chroma x 1.5;
- dark: `Y -> 0.15 + 1.35 Y`, chroma x 3.

M is picked by the glass's appearance. Each light's shaping parameter `c` in `w = a / ((1 - a) c + 1)` is [I] 0.

Glass draws the highlight in its own fragment, over its face, so there are no extra reads. A surface that is not glass (a solid card's edge) draws it in the `RIM_ONLY` program over a snapshot of the scene under its box. Its matrix follows the pixel's own luma [I].

## Labels [C]

A label on glass is white at 95% on dark glass and black on light glass, following the glass's appearance, not the theme. Jwift's label level (`@JwiftVibrancyLabel`, Vibrancy.md) is exactly that. Text inside glass that tracks its backdrop turns with it (`Text.Quad.frag`, `u_GlassInk`).

## Cost per frame

Extra texture reads per fragment:

| | Reads |
|---|---|
| Face | 1 read (3 with dispersion), plus 1 in the outer point of regular glass |
| Edge bleed | 1 per face fragment, regular glass 64 pt and up |
| Colored shadow | 1 per shadow fragment, glass 64 pt and up; smaller glass's shadow reads nothing |
| Highlight on glass | 0 |
| Highlight on a solid surface | 1 per rim-quad fragment, plus one snapshot copy of its box |
| Probe | 96 taps, one 1x1 draw per glass surface |

## Verification

Same inputs as SwiftUI's own render (the gpui-liquid-glass validation set: `harbour.png`, a 440 x 96 pt capsule, radius 34, 2x, macOS 27 reference). Mean absolute error over the label-free body, 0 to 255:

| variant | error |
|---|---|
| clear | 11 |
| regular | 58 |
| regular tint | 21 |
| clear tint | 37 |

- Blur and lens match. The regular face's gap is the table: macOS 27's regular light body reads 127 over a dark hull where the table gives 185.
- On iOS dark captures, Apple's bars read 65 to 97 where the dark table gives about 44.

## Sources

- AlexStrNik/ShatteredGlass (layer tree, filter keys): https://github.com/AlexStrNik/ShatteredGlass
- SSFSKIM/designer, W12 G1 layer dump (size laws, highlight, tint): https://github.com/SSFSKIM/designer/blob/main/packages/calibration/results/2026-09-03-w12-lens/g1/g1-layer-dump.md
- Quince-Pie/walle (bit-exact shader replay, YCbCr constants): https://github.com/Quince-Pie/walle/blob/main/LIQUID_GLASS_EVIDENCE.md
- lennondotw/interaction-lab (macOS 27 metallib uniforms): https://github.com/lennondotw/interaction-lab/tree/main/archive/2026-08-liquid-glass-internals
- EthanArbuckle/iPhone18-3_26.1_23B85_Restore (iOS 26.1 QuartzCore and DesignLibrary): https://github.com/EthanArbuckle/iPhone18-3_26.1_23B85_Restore
- ktiays/GlassExplorer: https://github.com/ktiays/GlassExplorer
- gpui-liquid-glass (SwiftUI reference captures used for verification): its `validation/` folder.
