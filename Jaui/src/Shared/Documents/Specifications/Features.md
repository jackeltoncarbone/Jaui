# Features

Everything Jaui renders, organized by system.

## Jiv (The Node Primitive)

A Jiv is the Jaui equivalent of a `<div>` — a rectangular node in the scene graph that clips, styles, and contains children. Every visible element is a Jiv or a subtype of one.

**Shape**: Superellipse by default. Configurable smoothness per corner: `round` (n=2), `squircle` (n=4), `bevel` (n=1), `scoop` (n=-2), `notch` (n=-∞), or `superellipse(n)`. Pill mode auto-computes radius from height. Per-corner radius and per-corner shape (mixed convex/concave corners via InsetCorner system).

**Clip**: All children clip to the parent's superellipse SDF. No path caching — the SDF is evaluated per-pixel in the fragment shader.

**Background**: Solid color, gradient, material (LiquidGlass, SolidGlass), or transparent.

**Sizing**: Explicit (`Width`, `Height`), intrinsic (fit content), or flex-derived (`FlexGrow`, `FlexShrink`, `FlexBasis`).

**Overflow**: `Visible`, `Hidden`, `Scroll` (spring-physics scroll container with momentum, rubber-band overscroll).

## Layout

Pure-math flex solver. No DOM. Runs every frame (< 1ms for 200 nodes).

**Container properties**: `Direction` (row, column, reverse), `Wrap`, `JustifyContent` (start, end, center, space-between, space-around, space-evenly), `AlignItems`, `AlignContent`, `Gap` (row + column), `Padding` (4-part).

**Child properties**: `FlexGrow`, `FlexShrink`, `FlexBasis`, `AlignSelf`, `Order`, `Margin` (including `auto` for centering).

**Spring-animated**: Layout targets update instantly. Springs animate every node from current position to target simultaneously. Per-property spring config (`Stiffness`, `Damping`, `Mass`).

**Entry/exit**: Nodes entering spring from an entry state (configurable: scale, opacity, translate). Nodes exiting animate to exit state, then are removed from the tree. Siblings reflow simultaneously. Modes: `opacity`, `scale`, `both`, `none`, or custom `@Enter`/`@Exit` in JSS.

## Borders

SDF-based. Computed from the superellipse distance field in the fragment shader.

- `BorderColor` — any color, per-side possible
- `BorderWidth` — thickness
- `BorderBlur` — edge feather half-width (SDF AA / soft silhouette, not Gaussian)
- `BorderBackdropBlur` — extra LOD octave offset on the border-zone backdrop sample (sharper/softer rim optics; distinct from edge feather)
- `BorderOffset` — shift inward or outward from the edge
- `ContainBorder` — clip the border glow to the shape interior (prevents bleed outside the node)

All animatable via springs.

## Shadows

**Drop shadow**: blur radius, color, offset (x, y). Rendered from the superellipse SDF — not a box shadow, it follows the exact shape.

**Soft shadow**: material preset — subtle rgba(0,0,0, 0.25) with 0.5em blur. Default for glass panels.

**Inner shadow**: inward SDF distance. For inset/pressed states.

All animatable. Shadow shape matches the node's superellipse exactly.

## Glass Materials

### Liquid Glass
The frosted glass effect. Renders the scene behind the node to a texture, applies a filter chain, composites with content.

- `LiquidBrightness` — multiplier (default 1.0, ~1.7 for bright overlays)
- `LiquidBlur` — blur intensity behind the surface
- `LiquidSaturation` — color saturation of the backdrop
- `LiquidContrast` — contrast adjustment

Filter chain order: saturate → contrast → saturate → brightness → blur. This matches Show Studio's tuned pipeline.

### Solid Glass
Opaque tinted surface. Background color with subtle transparency. No backdrop blur. Lighter GPU cost.

- `SolidTint` — RGBA background

Both materials include border (rgba(255,255,255,0.4), 0.1em) and soft shadow by default.

## Refraction & Displacement

Per-pixel UV offset in the glass shader. Creates the dome/bezel effect — light bends at the edges of the panel as if it were a physical glass lens.

- `RefractionThickness` — dome depth (controls displacement intensity)
- `SurfaceBulge` — curvature multiplier
- Animated with eased tweens (400ms)

Replaces Show Studio's SVG `feDisplacementMap` filter (which silently fails on iOS) with a pure shader solution.

## Edge Lighting & Light Diffusion

Realistic lighting for Liquid Glass surfaces:

- **Edge light**: Fresnel-based brightness increase at grazing angles along the superellipse border. Simulates light catching the rim of a glass panel. Intensity varies with viewing/surface angle.
- **Light focus**: A radial gradient highlight (soft, ~400px diameter) that follows the pointer position across the glass surface. Fades on blur/touch-down. Creates the illusion of a reflective material responding to the user's hand.
- **Light diffusion**: Subsurface scattering approximation — light entering one edge of the panel softly illuminates adjacent areas. The glass "glows" faintly from nearby bright content.
- **Specular response**: Bright content behind the glass produces soft caustic highlights on the surface, not just a flat tinted blur.

## Progressive Blur

Variable-strength blur in a single shader pass. The blur kernel radius varies across the surface.

**Directional modes**:
- `to bottom`, `to top`, `to left`, `to right` — linear gradient blur from one edge
- Per-side control (like per-corner radius): specify blur strength independently for top, right, bottom, left edges. Unspecified sides default to 0.

**Fog mode**: All four sides blur inward simultaneously — the center is sharp, edges are blurred. Creates a depth-of-field vignette.

**Properties**:
- `BlurStrength` — maximum blur radius (per side in multi-side mode)
- `BlurFeather` — fade zone width (how gradually the blur ramps)
- `BlurFalloff` — exponential curve for non-linear ramp (default 2.0)
- `BlurBackground` — optional color overlay that fades in with the blur

Replaces Show Studio's 7-layer stacked `backdrop-filter` approach with one fragment shader.

## Text & Typography

Text is rendered to an offscreen `Canvas2D`, uploaded as a texture, and composited into the scene.

- `FontFamily`, `FontSize`, `FontWeight` (including variable font `wght` axis), `Color`
- Line breaking via `measureText()` — browser text shaping for free
- Text texture cache keyed by content + style hash
- Optical vertical centering for text beside icons (the 0.075em translate trick from Show Studio)

### Text Input
Hidden DOM `<textarea>` captures keyboard input. Gives native IME, clipboard, autocorrect, and accessibility without building a text input system. The canvas renders the visual representation of the text state.

## Icons

Icon font rendered as text nodes. The JauiIcons font uses SF Symbols-like naming (`house.fill`, `chevron.left`).

- `IconName` — codepoint lookup from icon name
- `IconSize` — defaults to 1.5em
- `IconWeight` — variable font weight axis
- Rendered through the text system — same texture cache, same shaping

The icon font is a Show Studio asset, not a Jaui-specific dependency. Jaui's text system renders any icon font.

## External Canvas Compositing

Any existing `<canvas>` element (Three.js, WebGL, Canvas2D) can be composited into the Jaui scene as a texture source.

- **Background mode**: external canvas serves as the scene background — Jaui UI layers on top with glass blur sampling the 3D scene beneath
- **Inline mode**: external canvas renders into a node at any position in the tree — behaves like an `<img>` but live-updating
- **Texture source**: the external canvas's pixel data is uploaded as a WebGL texture each frame (or on-demand). Jaui's blur, glass, and refraction shaders sample from it like any other scene content

This enables Three.js 3D scenes as backgrounds with Liquid Glass UI floating on top — the glass blurs and refracts the 3D content in real time.

## Scroll Containers

A Jiv with `Overflow: Scroll`. Content exceeds bounds. Scroll position is a spring.

- Momentum-based flick scrolling (spring velocity from gesture)
- Rubber-band overscroll at edges (stiffer spring constant pulls back)
- Configurable spring: `Stiffness`, `Damping`
- Scroll position clamped to `[0, contentHeight - viewportHeight]`

## Interaction

**Hit testing**: Walk the scene graph back-to-front, test point against each node's superellipse SDF. `distance < 0` = hit.

**Pointer events**: `Tap`, `Hover`, `Active`, `LongPress`. Captured on the canvas element, dispatched to the hit node.

**Liquify**: Press-and-stretch deformation. Drag offset from press point → proportional scale deformation (max 5% per axis) with volume preservation. Springs back on release.

**Hover indicator**: Spring-animated highlight that follows the hovered node, smoothly transitioning size and position between targets.

## Overlays & Dropdowns

**GlassDropdown**: Expandable pill button that opens into a menu panel. Smooth width/height spring animation during expansion. Multi-page support with page stack (push/pop). Per-page sizing and radius. Item icons, labels, disabled/destructive states, dividers, confirmation flows.

**Modals**: Glass-morphed overlay with backdrop blur. Drawer variant for side panels.

## Button Primitives

**GlassButton**: Circular or pill-shaped. Hover: scale 1.05. Active: scale 0.98. Glass material.

**PillButtonGroup**: Auto-overflow hiding — buttons collapse (width → 0, opacity → 0) when space is tight. Last button always visible. Expandable mode to reveal all.

**PillButton**: 2.5em circular icon button. Active state with color tint.

## Device Adaptation

**DeviceTier** detection: `low`, `mid`, `high` — from `navigator.deviceMemory`, `hardwareConcurrency`, or touch/pointer fallback.

Tier controls:
- Blur quality (fewer samples on low)
- Shadow resolution
- Refraction enabled/disabled
- Progressive blur layer count
- Animation complexity

**Mobile/iOS detection** for touch behavior and WebKit workarounds.

## Animation

**Springs**: Damped harmonic oscillator. Configurable `Stiffness`, `Damping`, `Mass`. Settling threshold 0.1. Drives layout, scroll, opacity, scale, refraction, shadows, borders — everything.

**Tweens**: Duration-based easing for discrete transitions. `EaseOutCubic` default (200ms). Used where spring physics doesn't fit (refraction animation, color transitions).

**RAF loop**: Single `requestAnimationFrame` loop drives all springs and tweens. Automatic settling detection stops the loop when nothing is moving.

## Accessibility

Shadow DOM mirrors the render tree:
- Interactive nodes → `<div role="button">`, `<input>`, etc.
- `aria-label`, `aria-expanded`, focus state synced bidirectionally
- Screen readers see the shadow DOM, users see the canvas
