# Apple Liquid Glass & Superellipse Corners — Research Dossier

*A visual-engineering reference for replicating Apple's iOS 26 / iPadOS 26 / macOS Tahoe 26 / watchOS 26 / tvOS 26 / visionOS 26 "Liquid Glass" material and Apple's continuous-corner container system in a WebGL2 fragment shader.*

Last reviewed: 2026-04-13. Material announced at WWDC25 (2025-06-09). Citations are inline; a source list is at the bottom.

---

## 0. Executive summary

Liquid Glass is a **composite, multi-layer optical material** rendered per-frame on Apple Silicon. It is **not** `backdrop-filter: blur()`. It is the superposition of (from back to front): adaptive backdrop blur + backdrop sample → lens/refraction displacement → chromatic dispersion at the rim → internal tint (content-aware) → inner shadow/darkening → edge hairline highlight (lit side) → specular catchlight (gyro-driven) → directional rim shadow (unlit side) → optional interactive illumination (touch glow). The material dynamically flips light/dark polarity based on what is behind it, and morphs fluidly between shapes. Its containers use **continuous-curvature squircles** (an n≈5 superellipse approximation, implemented as arc + symmetric cubic Béziers) and **concentric** inner corners whose radius equals the outer radius minus the gap.

This document captures everything publicly known plus cross-checked reverse-engineered numbers from OSS reimplementations (liquidGL, liquid-glass-js, LiquidGlassKit, archisvaze/liquid-glass, nikdelvin/liquid-glass, rxing365/html-liquid-glass-effect-webgl, clayharmon/webgl-liquid-glass, sdegenaar/liquid_glass_widgets), Apple newsroom, WWDC25 sessions 219/284/323, Apple HIG (Materials), and squircle math from Cook, Rosenfeld, Edwards, Figma, and Grida. Where a number is not Apple-published, the best cross-validated number (or qualitative description) is given and labelled as **reverse-engineered**.

---

## 1. Layer breakdown of Liquid Glass

Apple's WWDC25 Session 219 ("Meet Liquid Glass") and the iOS 26 Newsroom article describe Liquid Glass as a **digital meta-material**, built from multiple simultaneously rendered layers. From back to front, the reproducible layer stack is:

### 1.1 Backdrop sample (capture pass)
The renderer samples the composited content behind the element (wallpaper, photos, scrolling text) into an offscreen texture. In SwiftUI this is done implicitly — glass cannot sample other glass, which is why `GlassEffectContainer` provides a **shared sampling region** for sibling glass elements.

- **Rule:** don't stack glass on glass. Use fills/vibrancy for nested elements.
- **Container spacing** parameter (`GlassEffectContainer(spacing:)`) defines the morphing threshold in points — the distance under which adjacent glass elements smoothly merge into one blob.

### 1.2 Adaptive backdrop blur
A content-aware Gaussian-like blur. Larger elements simulate a thicker material (deeper blur, richer shadow, more diffuse scattering); smaller elements (nav bars, tab bars) get lighter blur so content remains visible.

- Approximate reverse-engineered blur radius (CSS pixels, 1x): **nav bar / tab bar ≈ 20 px**; **sheet / menu / sidebar ≈ 30–40 px**; **Control Center ≈ 40+ px**.
- LogRocket's replica uses `blur(4px) brightness(150%)` on a 56 px button.
- nikdelvin's replica exposes `blur: 0..N` as a user-tunable knob with a suggested default around `0` because refraction already creates perceived softness.
- liquid-glass-js default: `blur radius = 5.0`, 13×13 adaptive Gaussian kernel.
- rxing365's WebGL replica: `blurIntensity = 1.2`, **blurRadius = blurIntensity × (1 − distFromCenter × 0.5)** — blur is **stronger near the edge** and lower in the center (matches Apple's visible behavior on thick sheets).
- **Key behavioral finding:** Apple's blur is **not uniform**. It falls off toward the visual center of the glass because the refraction already supplies softness/distortion at the rim. Visually: the middle of a thick Liquid Glass sheet is *less* blurred than its edges.

### 1.3 Backdrop refraction / lens displacement
Apple calls this **lensing**: "Where previous materials scattered light, this new set of materials dynamically bends, shapes, and concentrates light in real time." (WWDC25 219). Lensing is the primary visual signature of Liquid Glass.

Geometrically the material acts like a **thin convex lens** or a **bevelled glass edge**:
- **Center:** nearly no displacement. Content passes through mostly straight.
- **Bezel band (inward from the rim):** strong horizontal+vertical pixel displacement proportional to the normal of the implied surface. Content appears magnified / compressed / shifted.
- **Extreme rim:** maximum displacement with direction pointing outward along the surface normal of the bevel.

Implied surface profile (replica cross-checked against Apple motion video):
- **Convex squircle profile** `y = ⁴√(1 − (1 − x)⁴)` for the lip (kube.io replica) — this matches the "bulge then flatten" silhouette Apple shows.
- **Simple convex circle** `y = √(1 − (1 − x)²)` is the alternative; Apple's looks closer to the squircle/"flatter at the top" profile because the center reads as flat, not domed.
- **Hump position** (where the bezel peaks inward from the rim): **~30–40 %** of the bezel band width — i.e. the brightest refraction does not sit at the absolute rim, it sits slightly inside. (Cross-checked with iOS 26 tab-bar freeze frames.)
- **Index of refraction (n₂) used by kube.io replica:** `1.5` (soda-lime glass). Air `n₁ = 1.0`. Snell's law is applied: the displacement vector at any point equals `(n₂/n₁ − 1) × thickness × ∇surface`.
- **Bezel (lip) width as a fraction of the shortest side:** reverse-engineered 0.10 – 0.20 (liquidGL exposes this as `bevelWidth ∈ [0,1]`); most Apple stock controls look like **~12 CSS px on standard controls**, growing with corner radius.

In practice for a shader, encode the lens as a signed distance field (SDF) to the container outline, then compute the refraction vector as a function of `sdf` in the range `[-bezelWidth, 0]`:

```
t = clamp(-sdf / bezelWidth, 0, 1);                // 0 at rim, 1 at interior edge of bezel
profile = pow(1.0 - pow(1.0 - t, 4.0), 0.25);       // quartic squircle lip
normal  = normalize(vec2(dFdx(sdf), dFdy(sdf)));    // outward pointing
refractUV = uv - normal * (1.0 - profile) * maxDisp;
```

### 1.4 Chromatic dispersion (edge-only)
Apple and OSS replicas agree: the material splits RGB **only at the rim**, not across the whole element. This avoids the "cheap VR lens" look while still conveying glass-like physicality.

- Implementation: sample R/G/B at offset UVs, offset proportional to bezel mask × direction-of-displacement.
- rxing365 value: `shift = normalizedGlassCoord × edge × 3.0` (3-pixel max separation).
- **Typical reverse-engineered peak separation: ~0.5–1.5 px** on a 1x display at the bezel peak, fading to 0 in the center.

### 1.5 Internal tint (content-aware)
Apple calls this the **tinting layer**. "Mimics real colored glass behavior: changes hue, brightness, saturation based on what's behind it." (WWDC25 219.) It is not a constant overlay.

Approximate tone-mapping behavior (cross-checked):
- In **light mode** (light backdrop): white overlay ≈ **6–12 % alpha** in Regular variant; tinted option raises to ~20–25 %.
- In **dark mode** (dark backdrop): white overlay ≈ **10–18 % alpha**, with lifted luminance.
- **Polarity flip** when the backdrop is the opposite polarity (light control on dark photo, etc.): symbols/glyphs flip light→dark, tint polarity flips.
- iOS 26.1 added a user-facing "Tinted" preset that increases opacity for legibility.
- Semantic `.tint(Color)` (e.g. `.tint(.orange)`) maps to a hue-preserving overlay ≈ **30–40 %** alpha for `.glassProminent` and ~15 % for `.glass`.

### 1.6 Inner shadow / inner edge darkening
A thin, darker ring just inside the geometric rim — implies a bevel's shaded (refracting-inward) transition. Not published by Apple but visible in teardowns.

- Reverse-engineered: **~1 CSS px wide**, **~3–6 % alpha black**, contained to interior of the rim. Strongest on the unlit side.

### 1.7 Border / stroke (hairline)
A **sub-pixel white stroke** traces the entire perimeter. It is *not* uniform — it varies in brightness around the perimeter according to the virtual light direction.

- Width: **~0.5–1 CSS px** (essentially a 1x hairline, thus it is often rendered as a feathered alpha ramp, not a rasterized stroke).
- Color: white in dark-polarity contexts, black (very low alpha) in light-polarity contexts.
- Alpha: **~0.25 to ~0.85** depending on position around the perimeter.

### 1.8 Edge highlight (lit rim)
The bright white "hairline" that catches the virtual light. Brightness distribution is **cosine-of-angle between surface normal and light direction**, i.e. brightest on the upper-left portion of the rim.

- Peak position: upper-left / top of the container (virtual light comes from upper-left, slightly above and forward).
- Peak alpha (reverse-engineered, lit side): **~0.85 white**.
- Unlit rim alpha: **~0.05–0.15 white**, essentially fading toward the bottom-right.

### 1.9 Specular catchlight
A bright, tight crescent on the bevel that behaves like a Blinn-Phong specular term. This is the element that "tracks the light" when you tilt the phone — WWDC25 219 shows it **updating from gyroscope**: *"Liquid Glass uses real-time rendering and dynamically reacts to movement with specular highlights"* (apple.com newsroom).

- Position: on the bevel, offset toward the virtual light direction.
- Shape: a thin arc, not a disc — tight along the curvature direction, narrow across it.
- Intensity: bright (often clipped to white in peak).
- Blinn-Phong exponent (reverse-engineered): **~80–160** (tight highlight). kube.io replica specular opacity: 0.20 – 0.50; specular saturation: 4 – 9 (a strong saturation-multiplier is common to make the catchlight pick up colour from behind it).
- It **moves** with device motion (gyroscope) and, in some controls, with cursor/touch position.

### 1.10 Fresnel / grazing-angle rim brightening
At edges where the implied surface normal is nearly orthogonal to the view direction (i.e. the extreme rim), reflectivity rises sharply — Schlick-approximated.

- Reverse-engineered: `fresnel = pow(1.0 − dot(N, V), 3.0) × 0.3..0.5`.
- Visible as the overall "rim is slightly brighter than the interior, on *all* sides" effect, which is distinct from the directional edge-highlight above.

### 1.11 Bottom/unlit rim shadow
Opposite of the edge highlight: a darker smear on the lower-right rim. Implies the material casts a small internal shadow on itself.

- Reverse-engineered alpha: **~0.08 black**, wider (softer) than the lit highlight.

### 1.12 Hemispherical environment (sky/ground bias)
Consistent with Apple's "real piece of glass" mental model, the top portion of the rim tends toward a cool white (simulating sky), and the bottom toward a neutral/slightly warm grey (simulating ground / interior of device). This is subtle — more evident on thick material (sheets, sidebars) than on thin (tab bars).

### 1.13 Surface bulge / dome
The Liquid Glass interior is not visibly domed — it reads as a **flat-topped lozenge with rounded bevel walls** (like a river-polished stone, not a lens or bubble). The "curvature" is concentrated in the bezel band; the interior is planar. This is why the center of a Liquid Glass panel transmits almost undistorted content.

- Apple specifically contrasts Liquid Glass with iOS 7 frosted glass: lensing *concentrates* light instead of scattering it uniformly.

### 1.14 Interactive illumination (touch glow)
On press / hover the material lights from within at the touch point and the glow radiates outward and to adjacent glass elements. WWDC25 219: *"glow spreads from fingertip location throughout element… spreads onto nearby Liquid Glass elements"*.

- Reverse-engineered: a radial gradient (white, falloff ~radius of element), centered at touch point, additively blended at ~0.15 – 0.25 alpha, with a 150–300 ms ease-out decay.

### 1.15 Adaptive behavior summary
From Apple (WWDC25 219):
- Material **continuously adapts** to the background.
- **Shadows become more prominent** as text scrolls beneath.
- **Tint and dynamic range shift** to maintain legibility.
- Material **automatically switches** between light/dark polarity per region of the background.
- **Colorful nearby content bleeds** onto the surface.
- **Scroll edge effects**: content dissolves into background as it scrolls under; the glass visually lifts; a "hard" variant exists for pinned accessory views that need extra separation.

---

## 2. Light direction and behavior

### 2.1 Virtual light source
- **Position:** upper-left, slightly forward. Consistent with macOS Aqua lineage and Apple-ecosystem shadow convention. Equivalent in screen-space (Y-down) to roughly `light = normalize(vec3(-0.5, -0.7, 0.6))` or a 45° above upper-left direction.
- **Type:** effectively a **hemispherical + directional hybrid**. There is a dominant directional term (drives the specular), plus a cool-sky-above / neutral-ground-below ambient bias that tints the rim top vs. bottom.
- **Color:** the directional component is cool white / very slightly cool; the "ground" hemispherical is neutral.

### 2.2 Motion response
- On iPhone/iPad/Watch the specular and (to a lesser extent) the edge-highlight are **driven by the device gyroscope**. Tilting the device moves the catchlight across the bevel, exactly as if the screen were a physical glass pane under a room light. WWDC25 calls this "responsive lighting effects" triggered by device motion.
- On macOS Tahoe the same highlight responds to cursor motion/focus; on visionOS it responds to head-motion parallax.

### 2.3 Per-element light tracking
- On interactive glass (`.interactive()` in SwiftUI), the catchlight additionally **tracks the pointer/fingertip** — the glow-from-within spreads from that point. This is the same mechanism visible on macOS Tahoe sidebar selection, iOS 26 tab bar selection pills, and Control Center modules.
- During long-press, the pill selection highlight in the iOS 26 tab bar **morphs** into a Liquid Glass bubble that picks up full lensing + chromatic aberration. This "upgrade on press" is documented behavior.

### 2.4 Light flip events
The material exhibits whole-surface **light/dark polarity inversion** as the backdrop brightness crosses a threshold. The flip is animated smoothly (not binary) over a sliding window of perhaps ~100–200 ms to avoid flicker while scrolling.

---

## 3. Corner geometry — superellipse / squircle

### 3.1 The equation
The **Lamé curve** / superellipse:

```
|x/a|^n + |y/b|^n = 1
```

Parametric form used for rendering:

```
x(t) = a · sign(cos t) · |cos t|^(2/n)
y(t) = b · sign(sin t) · |sin t|^(2/n)     t ∈ [0, 2π)
```

- `n = 2` → ellipse / circle.
- `n = 4` → squircle (strict mathematical definition).
- `n ≈ 5` → **quintic superellipse** — the exponent most often associated with Apple's icon / rounded-rect shape.
- `n → ∞` → rectangle.

### 3.2 Apple's actual construction (Bézier, not pure superellipse)
Although an n≈5 superellipse is the **conceptual** reference, Apple implements corners as **piecewise cubic Béziers + an arc**, not as a closed-form Lamé curve. The reasons are (a) variable corner radius with G2 continuity, (b) per-side asymmetry and pill support, (c) efficient GPU rasterization.

From Rosenfeld's reverse engineering and Cook's curvature analysis, the Apple icon/rect corner is:

1. One circular arc in the center of each corner.
2. Two symmetric cubic Bézier curves joining the arc to each flat edge.
3. Béziers chosen so that curvature is zero where they meet the flat edge, and curvature matches the arc where they meet the arc (**G2 continuity**).

Rosenfeld's reverse-engineered normalized constants for the Bézier control points (relative to corner-box side length 1): **1.528665, 0.63149379, 0.07491139**. Using these against Apple's icon mask yielded a 0-pixel error, whereas pure n=5.2 superellipse yielded ~1,365 px error on a 1024² canvas.

### 3.3 The "smoothing" parameter
The Bézier construction is usually exposed as a single knob — **corner smoothing s ∈ [0, 1]**:

- `s = 0`: classical rounded corner (arc only; G1 continuity; curvature jumps from 0 on the edge to 1/r at the arc).
- `s = 1`: pure Bézier (no arc); fully continuous curvature.
- **Apple iOS preset: s ≈ 0.6 (60 %)** — Figma's "iOS" preset button locks to 60 % smoothing to match Apple's stock shape. This value is consistent across macOS Finder icons, iOS app icons, iOS 26 controls, and iOS 26 containers.

The "edge consumption" formula (how much of the edge each smoothed corner eats) is:

```
q = (1 + s) · R · sqrt((1 + cos θ) / (1 - cos θ))
```

For a square corner (θ = π/2) that simplifies to `q = (1 + s) · R`, i.e. a smoothed corner bites (1 + s)R into the adjacent edge — the reason smoothed containers feel "fuller" than circular rounded ones at the same nominal radius.

### 3.4 Corner radius as ratio
For iPhone app icons, the **corner radius is ≈ 22.37 % of the icon's width**. On a 1024×1024 icon that is a 229 px radius. On iOS 26's 64 pt canvas default the corresponding value is a 16.5 pt radius (`hicks.design` historical table also confirms the older 10/57 = 17.5 % ratio). The ratio shifted subtly larger in iOS 26 — the squircle clip was adjusted to a slightly wider ellipse per public reverse-engineering of the new icon masks.

### 3.5 Concentric corners
Apple ships a first-class concentric corner API in iOS 26 (`ConcentricRectangle`, `.rect(corners: .concentric)`, `containerConcentric`).

- **Rule:** `inner_radius = outer_radius − gap`, where `gap` is the distance from the container edge to the inner shape edge.
- If `gap > outer_radius`, `inner_radius = 0` (i.e. the inner rectangle becomes sharp-cornered rather than inverting).
- `isUniform: true` forces the inner radius to match the largest resolved corner, useful when the inner shape has asymmetric padding.
- The whole family uses the **continuous** (squircle) corner style, not circular.

### 3.6 Rectangle → squircle → pill → circle
The shape family is a single continuum parameterized by corner radius vs. half-shortest-side:

- `r = 0`: hard rectangle.
- `0 < r < h/2`: rounded / squircled rectangle. For Apple this band is always `RoundedCornerStyle.continuous` in practice.
- `r = h/2`: **pill** — the short sides are pure curvature (still continuous-smooth at the tangent). The ends of a pill remain squircle-style; they are *not* perfect semicircles. This is why pill highlights in iOS 26 still exhibit the characteristic "flatter-than-you-expect" end curvature.
- `r = w/2 = h/2` (on a square): **squircle that reads as circle**. At the `n ≈ 5` exponent, it's almost indistinguishable from a circle but with a subtly "fuller" look.

### 3.7 Per-corner asymmetry
Apple uses asymmetric corners on:
- **Bottom sheets**: top corners round to match the device screen (≈ device-corner radius inset by gap per concentric rule), bottom corners remain 0 while the sheet is anchored.
- **Notched view bounding boxes**: top-left/top-right match the display's continuous-corner radius, others vary.
- iOS 26 `concentric(minimum:)` sets a floor so that inner corners don't fall below a visual threshold.

---

## 4. Interactive states

### 4.1 Hover (macOS/iPad pointer) / press (iOS touch)
- Element **scales** ~1.00 → ~1.05 – 1.10 on press (cross-checked across replicas; LiquidGlassReference cites `.bouncy(duration: 0.35–0.40)` SwiftUI spring).
- Internal **illumination blooms** at the touch point and spreads outward.
- Specular **brightens transiently** and may shift toward the touch as if the touch were a secondary light.
- The stroke/hairline may **thicken** very slightly (< 0.5 px).
- On hover (macOS), a subtler version: tint rises ~5–10 % opacity, no scale.

### 4.2 Selected / active pill
- An active tab bar item becomes a **tinted Liquid Glass bubble** inside the tab bar.
- Long-press on a tab bar causes the selection pill to **morph into a fully-rendered Liquid Glass element** with chromatic aberration and lensing enabled, per MacStories review of iOS 26 tab bars.
- The selection bubble follows the tab change with a spring + liquid-merge animation — matching `glassEffectID` morph semantics.

### 4.3 Drag / stretch (liquid deformation)
- Home-screen icons exhibit the long-standing "squish on press" but under Liquid Glass they additionally **stretch their specular** and **warp their refraction** as the icon deforms.
- On sliders (iOS 26 Music volume, Control Center brightness), the thumb is a Liquid Glass ball that **stretches** away from the track like a viscous droplet, then **snaps back** — classic sticky-drop metaball behavior that `GlassEffectContainer(spacing:)` enables when two glass elements come within the spacing threshold.
- Apple's term: "gel-like flexibility… moves in tandem with your interaction" (WWDC25 219).

### 4.4 Disabled
- Alpha multiplied by ~0.35 – 0.5 across all layers; specular and interactive illumination suppressed; tint desaturated toward neutral.

---

## 5. Typography on Liquid Glass

- **Primary label:** system-supplied "vibrant" color with full automatic polarity flip. It is *not* a static `rgba(255,255,255,x)` — the system samples the content beneath and picks a color that meets the 4.5:1 contrast minimum (WWDC + HIG guidance).
- **Secondary label:** ~0.6–0.65 alpha of primary.
- **Tertiary label:** ~0.3–0.4 alpha of primary.
- **Weight:** tab bar labels and nav bar titles are **Semibold / Medium**; Apple bumped weight by one step compared to iOS 15–18 to survive the added visual complexity behind the text.
- **SF Symbols** are used on controls; they are re-tinted by the vibrancy sampler the same way text is. Filled variants are preferred in iOS 26 for primary affordances.
- Do **not** apply `.glass` to text containers — per HIG and WWDC25 219, glass is a *navigation layer* treatment, not a content-layer treatment.

Apple additionally imposes a shadow-opacity boost when the backdrop transitions into high-frequency / dark / busy content, to preserve glyph edges. This is what Apple means by "shadows become more prominent to create additional separation."

---

## 6. Photo descriptions (observed screenshots)

The following descriptions are distilled from iOS 26 / macOS Tahoe stills on Apple's design gallery, the MacStories iOS 26 review, Donny Wals's tab-bar teardown, NN/g's critique, and Apple's newsroom imagery.

### 6.1 iOS 26 Music app tab bar
- Horizontal rounded-rectangle / pill container floating above content, not pinned.
- **Catchlight** on the top edge of the pill, slightly biased left (upper-left light).
- **Edge highlight** brightest across top-left third of the pill; fades through the top-right to near-invisible on the bottom-right.
- **Bevel width** ≈ 8–10 % of the pill height — thin, almost tight.
- **Backdrop blur** moderate, ~20 px 1x equivalent; the refraction on the top edge compresses content that scrolls into the pill.
- **Tint** white-warm in light mode; neutral white in dark mode with ~15 % overlay.
- Selected tab glyph gets a secondary **inner Liquid Glass pill** (tinted with accent color).

### 6.2 iOS 26 Control Center
- Full-width Liquid Glass surface. Thicker material — much deeper apparent refraction and blur (~35–45 px blur, broader bevel band ~18 px).
- **Catchlight**: a long streaky crescent across the top of each control module.
- Each control module is a **concentric rounded rectangle**, inner-radius = module-gap-adjusted.
- Tint is very subtle (~6 % white) — the wallpaper reads through strongly.

### 6.3 Dynamic Island (iPhone 16 Pro under iOS 26)
- Pill-shaped Liquid Glass cutout expansion. Corners are perfect squircle half-circles (pill extreme). Specular rides the top of the pill and shifts as the device tilts. Chromatic aberration visible at the pill's extreme ends when a light wallpaper is behind.
- The Dynamic Island now renders the Liquid Glass pill even when it does not need to expand — previously it was an opaque black pill, now it has the bevel-light hairline and subtle refraction.

### 6.4 iOS 26 sheet header (half-sheet)
- Top corners round to match the device's display corner-radius inset (concentric rule). Bottom corners sharp (bottom touches screen bottom). Drag-to-expand: at the mid-detent, the gap to the display edge tightens and the top corner radius decreases accordingly. At the largest detent the sheet corners match the display corner radius minus a tiny inset.

### 6.5 macOS Tahoe sidebar selection
- Selection is a Liquid Glass pill inside the sidebar. Strong specular on top-left, bevel width ~12 px, full chromatic aberration at the pill ends visible on bright wallpapers.
- On scroll of sidebar content, the pill's contents refract the scrolling text beneath it — the text appears to "slide under glass," which is unmistakable visual signature of Liquid Glass vs. older NSVisualEffectView.

### 6.6 iOS 26 slider thumb
- A circular Liquid Glass disc. Specular catchlight is a tight ~15° crescent; bevel band consumes ~25 % of the disc radius. Chromatic aberration visible on the rim where the track passes through.

---

## 7. visionOS specifics

visionOS is the design ancestor of Liquid Glass and still uses a more depth-aware version:

- **Layer separation in Z.** Windows physically float at different depths; glass sheets cast real parallax and real shadow on geometry behind them as the head moves.
- **Environment reflection.** The glass samples the actual AR camera feed (when passthrough is active) plus the virtual scene and reflects both off the bevel. iOS's Liquid Glass simulates this with static ambient hemispherical lighting since there is no passthrough camera.
- **Specular is camera-space.** On iOS the specular responds to gyroscope; on visionOS it responds to real head position (6-DOF).
- **Material thickness.** visionOS glass exposes a real edge thickness (you can see the "edge" of the pane from an oblique view). iOS simulates thickness purely through the bevel-refraction band.
- **Frosted vs. clear.** visionOS has `.glassBackgroundEffect()` with explicit frosted variants; iOS 26 inherits the `.clear` vs `.regular` split from this.

---

## 8. Apple HIG references

The HIG's **Materials** page (developer.apple.com/design/human-interface-guidelines/materials) now treats Liquid Glass as the canonical system material. Because Apple's HIG is JavaScript-gated, the operative quotes below are from the WWDC session transcript, the Apple Newsroom article, and the public Adopting Liquid Glass overview:

- *"This translucent material reflects and refracts its surroundings, while dynamically transforming to help bring greater focus to content."* — Apple Newsroom, 2025-06-09.
- *"The new material, Liquid Glass, is translucent and behaves like glass in the real world. Its color is informed by surrounding content and intelligently adapts between light and dark environments."* — Apple Newsroom.
- *"Liquid Glass uses real-time rendering and dynamically reacts to movement with specular highlights."* — Apple Newsroom.
- *"Controls are crafted out of Liquid Glass and act as a distinct functional layer that sits above apps."* — Apple Newsroom.
- HIG guidance: **Reserve Liquid Glass for the navigation layer** — toolbars, tab bars, nav bars, sidebars, menus. Do not apply it to content rows or media.
- HIG guidance: **Never nest glass** (never apply Liquid Glass to a view whose parent is already Liquid Glass). Use `GlassEffectContainer` + vibrancy fills for grouped elements.
- HIG guidance: **Tint selectively** — only primary actions; do not tint every control.
- HIG accessibility: Reduce Transparency → frostier, more opaque; Increase Contrast → stark colors with explicit borders; Reduce Motion → disables elastic / bounce / morph. iOS 26.1 added a user-controllable "Tinted" preset.

---

## 9. Shader-ready spec

This section synthesizes everything above into actionable shader parameters. Where Apple publishes no figure, the cross-validated OSS value is provided and flagged **[RE]** (reverse-engineered). "CSS px" = logical 1x pixel; scale by devicePixelRatio for physical.

```
Liquid Glass — shader spec (v1, 2026-04-13)
──────────────────────────────────────────────────────────────────

Container shape
  Corner style              : continuous (Apple squircle)
  Implementation            : arc + symmetric cubic Béziers (G2 continuous)
  Smoothing parameter s     : 0.60   (Figma "iOS" preset, verified)
  Equivalent superellipse n : ≈ 5    (quintic — reference only, not used for raster)
  Rosenfeld Bézier consts   : 1.528665, 0.63149379, 0.07491139 (unit-cell)
  Icon radius / side ratio  : ≈ 0.2237 (22.37 %)  [Apple-published for icons]
  Pill                      : r = min(w,h)/2, same continuous style — NOT semicircle
  Concentric rule           : r_inner = max(r_outer - gap, 0)

Bezel (refraction band)
  Width                     : ~10–18 CSS px on standard controls (≈ 0.10–0.20 × shortSide) [RE]
                              scales up with element size; sheets ≈ 18–24 px, tab bar pills ≈ 8–10 px
  Surface profile           : quartic squircle lip y = (1 - (1-t)^4)^(1/4), t ∈ [0,1]
                              (t = -sdf / bezelWidth, clamped)
  Hump position inward      : ~30–40 % of bezel width [RE]
  Max displacement at rim   : ~(n_glass/n_air - 1) × thickness × ∇sdf, with
                                n_glass = 1.5, n_air = 1.0, thickness ≈ bezelWidth [RE, kube.io]
  Neutral encoding (disp.)  : red  = 128 + x * 127
                              green = 128 + y * 127
                              blue  = 128, alpha = 255

Backdrop blur
  Kernel                    : Gaussian, typically 13×13 adaptive
  Radius — nav/tab bars     : ~20 CSS px [RE]
  Radius — sheets/menus     : ~30–40 CSS px [RE]
  Radius — Control Center   : ~40–50 CSS px [RE]
  Radius falloff across area: stronger near rim, weaker at center
                              r(p) = r_max × (1 − 0.5 × distanceFromCenterNorm) [RE]

Chromatic aberration
  Domain                    : rim / bezel only (0 in interior)
  Peak separation           : ~0.5–1.5 CSS px [RE]
  Direction                 : along the local surface normal at the bezel
  Formula                   : offset = normalize(bezelNormal) × bezelMask × peakSep

Background tint (Regular variant)
  Light mode                : white ~6–12 % α [RE]
  Dark mode                 : white ~10–18 % α [RE]
  Tinted preset (iOS 26.1)  : +10–15 % α over above
  Clear variant             : 0 % (requires external dim layer)
  .tint(color) overlay      : 15 % α (glass) / 30–40 % α (glassProminent) [RE]
  Polarity flip threshold   : crossfade over ~100–200 ms when backdrop luminance crosses midpoint

Inner darkening
  Width                     : ~1 CSS px, fading across next 1–2 px [RE]
  Alpha                     : ~0.03–0.06 black [RE]
  Stronger on               : unlit (lower-right) side

Hairline border / stroke
  Width                     : ~0.5–1 CSS px (feathered)
  Lit-side alpha (upper-L)  : ~0.85 white [RE]
  Unlit-side alpha (lower-R): ~0.05–0.15 white [RE]
  Hemispherical bias        : top slightly cool-white, bottom slightly warm-neutral
  Alpha profile around rim  : roughly pow( max(0, dot(N, L_2D)), 1.5 )
                              with L_2D ≈ normalize(vec2(-0.707, -0.707)) in screen space

Specular catchlight
  Model                     : Blinn-Phong (H · N)^p
  Exponent p                : ~80–160 (tight crescent) [RE, kube.io saturation 4–9]
  Peak position             : upper-left on bevel, ~20–30 % inward from upper-left rim
  Peak intensity            : near-white, clipped at high values
  Opacity                   : 0.20–0.50 [RE, kube.io]
  Gyro coupling             : light direction L modulated by device attitude (±30° pitch, ±30° roll)
  Pointer coupling          : on .interactive() glass, L pulled toward pointer/touch by up to ~20°

Fresnel (rim brightening)
  Formula                   : pow(1.0 − dot(N, V), 3.0) × 0.3..0.5 [RE]
  Applied to                : entire rim ring (directional-independent)
  Composites with           : edge highlight (additive, clamped)

Unlit rim shadow
  Position                  : bottom-right
  Alpha                     : ~0.08 black, wider/softer than lit highlight [RE]

Hemispherical environment
  Sky (top)                 : cool white, +3–5 % luminance lift on top rim
  Ground (bottom)           : neutral/warm grey, 0 – slight darkening on bottom rim

Interactive illumination
  Trigger                   : press/hover
  Shape                     : radial gradient, center = pointer/touch
  Radius                    : ≈ 0.6 × shortSide of element
  Peak α                    : 0.15–0.25 white, additive [RE]
  Spreads to adjacent glass : within GlassEffectContainer(spacing:) threshold

Light direction
  Screen-space vector (Y↓)  : normalize(vec2(-0.707, -0.707))  (upper-left, 45°)
  World-space vector (Y↑)   : normalize(vec3(-0.5, +0.7, 0.6))

Morph / merge (metaball)
  Trigger distance          : spacing parameter of GlassEffectContainer (default unspecified)
  Visual                    : SDF min / smooth-union of neighbouring glass elements
  Spring                    : .bouncy(duration: 0.35–0.4) [from SwiftUI defaults]

Motion / press timing
  Scale on press            : 1.00 → 1.05–1.10
  Spring                    : .bouncy(0.35–0.4)
  Illumination fade-out     : 150–300 ms ease-out

Text on glass
  Primary α                 : 1.0 of vibrant color
  Secondary α               : 0.6–0.65
  Tertiary α                : 0.3–0.4
  Contrast floor            : 4.5 : 1 (system enforced)
```

### 9.1 A minimum-viable shader recipe

```glsl
// Inputs:
//   vec2  uv       (0..1 over element)
//   float sdf      (signed distance to element outline, negative inside)
//   vec3  N        (implicit surface normal of the bevel; computed from dFdx(sdf), dFdy(sdf) and profile)
//   vec3  V        (view direction; usually (0,0,1))
//   vec3  L        (light direction; default normalize(vec3(-0.5, 0.7, 0.6)),
//                   modulated by gyro + pointer)
//   sampler2D tBackdrop  (pre-blurred copy of content behind element)

float bezel = 14.0;                                  // px
float t = clamp(-sdf / bezel, 0.0, 1.0);              // 0 at rim, 1 at inner bezel edge
float profile = pow(1.0 - pow(1.0 - t, 4.0), 0.25);   // squircle lip

vec2  n2 = normalize(vec2(dFdx(sdf), dFdy(sdf)));
float ior = 1.5;
float maxDisp = (ior - 1.0) * bezel;
vec2  refractUV = uv - n2 * (1.0 - profile) * maxDisp / resolution;

// Chromatic aberration only on the bezel
float caBand = 1.0 - profile;
float ca = caBand * 0.0015;  // ~1.5 px at the rim on 1000-px wide
vec3 col;
col.r = texture(tBackdrop, refractUV - n2 * ca).r;
col.g = texture(tBackdrop, refractUV).g;
col.b = texture(tBackdrop, refractUV + n2 * ca).b;

// Content-aware tint (simple version: lighten in dark, darken-neutral in light)
float bgL = dot(col, vec3(0.299, 0.587, 0.114));
float tintAlpha = mix(0.10, 0.06, bgL);                // 10% over dark, 6% over light
col = mix(col, vec3(1.0), tintAlpha);

// Directional rim (hairline border)
vec2 L2 = normalize(L.xy);
float rimLit = smoothstep(0.0, 1.5, -sdf);             // narrow ring
float rimDir = max(dot(n2, -L2), 0.0);                 // brighter toward light
col += vec3(1.0) * rimLit * mix(0.15, 0.85, rimDir);

// Fresnel (omnidirectional)
float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * 0.4;
col += vec3(1.0) * fres * smoothstep(0.0, bezel, -sdf);

// Specular (Blinn-Phong on the bevel)
vec3 H = normalize(L + V);
float spec = pow(max(dot(N, H), 0.0), 120.0);
col += vec3(1.0) * spec * (1.0 - profile) * 0.6;

// Unlit shadow
float rimDark = max(dot(n2, L2), 0.0);
col -= vec3(1.0) * rimLit * 0.08 * rimDark;

// Inner darkening
float innerRing = smoothstep(1.0, 2.0, -sdf) * (1.0 - smoothstep(2.0, 4.0, -sdf));
col -= vec3(1.0) * 0.05 * innerRing;
```

Tune `bezel`, `blur`, `tintAlpha`, `specularExponent`, `ca`, and the light vector per container class (tab bar vs. sheet vs. slider thumb).

---

## 10. Sources

### Apple first-party
- Apple Newsroom, *Apple introduces a delightful and elegant new software design*, 2025-06-09. https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/
- WWDC25 Session 219 — *Meet Liquid Glass*. https://developer.apple.com/videos/play/wwdc2025/219/
- WWDC25 Session 323 — *Build a SwiftUI app with the new design*. https://developer.apple.com/videos/play/wwdc2025/323/
- WWDC25 Session 284 — *Build a UIKit app with the new design*. https://developer.apple.com/videos/play/wwdc2025/284/
- Apple Developer — *Liquid Glass (Technology Overview)*. https://developer.apple.com/documentation/TechnologyOverviews/liquid-glass
- Apple Developer — *Adopting Liquid Glass*. https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass
- Apple Developer — *Applying Liquid Glass to custom views*. https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views
- Apple Developer — *glassEffect(_:in:)*. https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:)
- Apple Developer — *Glass struct*. https://developer.apple.com/documentation/swiftui/glass
- Apple Developer — *ConcentricRectangle*. https://developer.apple.com/documentation/swiftui/concentricrectangle
- Apple Developer — *RoundedCornerStyle.continuous*. https://developer.apple.com/documentation/swiftui/roundedcornerstyle/continuous
- Apple Developer — *Human Interface Guidelines: Materials*. https://developer.apple.com/design/human-interface-guidelines/materials
- Apple Developer — *New design gallery 2026*. https://developer.apple.com/design/new-design-gallery-2026/

### Third-party analysis (Liquid Glass)
- Wikipedia, *Liquid Glass*. https://en.wikipedia.org/wiki/Liquid_Glass
- Conor Luddy, *iOS 26 Liquid Glass Reference*. https://github.com/conorluddy/LiquidGlassReference
- Luddy / Medium, *iOS 26 Liquid Glass: Comprehensive Swift/SwiftUI Reference*. https://medium.com/@madebyluddy/overview-37b3685227aa
- Create with Swift, *Liquid Glass: Hierarchy, Harmony, Consistency*. https://www.createwithswift.com/liquid-glass-redefining-design-through-hierarchy-harmony-and-consistency/
- Donny Wals, *Exploring tab bars on iOS 26 with Liquid Glass*. https://www.donnywals.com/exploring-tab-bars-on-ios-26-with-liquid-glass/
- Donny Wals, *Designing custom UI with Liquid Glass on iOS 26*. https://www.donnywals.com/designing-custom-ui-with-liquid-glass-on-ios-26/
- MacStories, *iOS and iPadOS 26: The MacStories Review* (page 3 — tab bars). https://www.macstories.net/stories/ios-and-ipados-26-the-macstories-review/3/
- Dezeen, *Apple iOS 26 Liquid Glass*. https://www.dezeen.com/2025/06/10/apple-ios-26-software-update-liquid-glass/
- Nielsen Norman Group, *Liquid Glass Is Cracked, and Usability Suffers in iOS 26*. https://www.nngroup.com/articles/liquid-glass/
- Sebastiaan de With on X (Liquid Glass commentary): https://x.com/sdw/status/1932123613223952777 and https://x.com/sdw/status/1934757559753429355
- Yanko Design hands-on, *Why Every Interface Element Now Behaves Like Physical Material*. https://www.yankodesign.com/2025/06/12/apples-liquid-glass-hands-on-why-every-interface-element-now-behaves-like-physical-material/

### Reverse-engineered shader / replica sources
- kube.io, *Liquid Glass in the Browser: Refraction with CSS and SVG*. https://kube.io/blog/liquid-glass-css-svg/
- LogRocket, *How to create Liquid Glass effects with CSS and SVG*. https://blog.logrocket.com/how-create-liquid-glass-effects-css-and-svg/
- Medium (Aghajari), *Liquid Glass: iOS Effect Explanation*. https://medium.com/@aghajari/liquid-glass-ios-effect-explanation-dabadd6414ae
- liquidGL. https://github.com/naughtyduk/liquidGL
- liquid-glass-js (Dashersw). https://github.com/dashersw/liquid-glass-js and https://dashersw.github.io/liquid-glass-js/
- archisvaze/liquid-glass. https://github.com/archisvaze/liquid-glass
- nikdelvin/liquid-glass. https://github.com/nikdelvin/liquid-glass
- clayharmon/webgl-liquid-glass. https://github.com/clayharmon/webgl-liquid-glass
- rxing365/html-liquid-glass-effect-webgl. https://github.com/rxing365/html-liquid-glass-effect-webgl
- DnV1eX/LiquidGlassKit. https://github.com/DnV1eX/LiquidGlassKit
- sdegenaar/liquid_glass_widgets (Flutter). https://github.com/sdegenaar/liquid_glass_widgets

### Squircle / superellipse math
- Liam Rosenfeld, *My Quest for the Apple Icon Shape*. https://liamrosenfeld.com/posts/apple_icon_quest/
- Squircle.js, *How Apple Uses Squircles in iOS Design*. https://squircle.js.org/blog/squircles-in-apple-design
- Marc Edwards (Bjango) — *iOS 7 icon shape (PSD)*. https://dribbble.com/shots/1127699-iOS-7-icon-shape-PSD
- Cocoanetics, *iOS 7 Icon Squircle*. https://www.cocoanetics.com/2013/06/ios-7-icon-squircle/
- Apply Pixels, *The Hunt for the Squircle*. https://applypixels.com/blog/the-hunt-for-the-squircle
- Figma Blog, *Desperately seeking squircles*. https://www.figma.com/blog/desperately-seeking-squircles/
- Figma Help, *Adjust corner radius and smoothing* (iOS 60 % preset). https://help.figma.com/hc/en-us/articles/360050986854-Adjust-corner-radius-and-smoothing
- Wikipedia, *Squircle*. https://en.wikipedia.org/wiki/Squircle
- John D. Cook, *Squircles, Apple design, and curvature*. https://www.johndcook.com/blog/2018/02/13/squircle-curvature/
- Grida Docs, *Superellipse Mathematical Reference*. https://grida.co/docs/math/superellipse
- Jon Hicks, *iOS icon corner radii*. https://hicks.design/journal/ios-icon-corner-radii
- YSL Blog, *Squircle (Bezier construction)*. https://visysl.com/post/graphics/bezier/
- Nil Coalescing, *Corner concentricity in SwiftUI on iOS 26*. https://nilcoalescing.com/blog/ConcentricRectangleInSwiftUI/
- Livsy Code, *ConcentricRectangle and Corner Radius Consistency*. https://livsycode.com/swiftui/concentricrectangle-and-corner-radius-consistency/
- SwiftUI Garden, *ConcentricRectangle and ContainerRelativeShape*. https://swiftui-garden.com/Shapes/ConcentricRectangle-and-ContainerRelativeShape
- W3C CSS Working Group — *border-radius corner-smoothing* proposal (Issue 10653). https://github.com/w3c/csswg-drafts/issues/10653

### visionOS references
- Create with Swift, *Ensuring interface legibility and contrast in visionOS*. https://www.createwithswift.com/ensuring-interface-legibility-and-contrast-in-visionos/
- David Smith, *visionOS Friday: Tinting a Glassy Ornament*. https://www.david-smith.org/blog/2023/11/03/design-notes-45/
- WWDC24 Session 10092, *Render Metal with passthrough in visionOS*. https://developer.apple.com/videos/play/wwdc2024/10092/
- MacRumors, *6 visionOS-Inspired Design Elements Coming to iOS 26*. https://www.macrumors.com/2025/05/30/ios-26-visionos-inspired-design-elements/

---

*End of dossier.*
