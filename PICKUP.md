# Pickup — Session Context

Resume point for continuing Jwift development. This captures everything discussed and decided.

## What Jwift Is

A WebGL2 canvas-based UI rendering engine for the web. Every pixel rendered to a single `<canvas>`. No DOM for visual elements. Inspired by SwiftUI (declarative composition, implicit animation, layout protocol) and Figma (canvas-owns-everything, scene graph, hidden textarea for input, accessibility shadow DOM).

Three components:
1. **Jwift Core** — TypeScript + WebGL2 rendering engine (this repo)
2. **Jwift.Angular** — Angular bindings (separate package, fully decoupled from Core)
3. **Jwift Materials** — GPU shader system for physical materials

## Key Design Decisions Made

### Jiv = Physical Material Node
A Jiv is the base rendering primitive (like a `<div>` but rendered as a superellipse). It has physics-based material properties — **not** glass-specific ones. "LiquidGlass" and "SolidGlass" are JSS `@style` presets that set physical properties to specific values. The rendering pipeline is driven by physical properties, not named material types.

Physical material properties on a Jiv:
- `Frost` — backdrop blur intensity (0 = clear, 1 = full)
- `FrostBlur` — blur radius in px
- `Thickness` — Z-depth of the slab (drives edge light, bulge, diffusion)
- `Fillet` — edge rounding in Z (sharp = hard catchlight, large = soft glow)
- `Refraction` — how much light bends through the material
- `Brightness`, `Saturation`, `Contrast` — general material properties (NOT frost-specific)

The renderer derives edge lighting, surface bulge, and subsurface scattering from Thickness + Fillet. No made-up knobs like `EdgeLight: 0.5`.

### Layout System
Replaces CSS `display`. Multi-mode:
- `Flex` — row/column (porting Show Studio's Jiv.Layout.ts, 343 lines, 40+ tests)
- `Grid` — 2D rows + columns (fr, px, auto, minmax)
- `Stack` — z-axis layering (SwiftUI ZStack)
- `None` — explicit positioning only

Convenience aliases: `JHStack` = Flex Row, `JVStack` = Flex Column, `JZStack` = Stack.

### Positioning Modes (replaces CSS `position`)
- `Flow` — default, participates in parent layout (CSS static)
- `Offset` — in flow but visually shifted (CSS relative)
- `Placed` — removed from flow, relative to ancestor (CSS absolute)
- `Fixed` — removed from flow, relative to viewport (CSS fixed)
- `Sticky` — flow until scroll threshold, then clamps (CSS sticky)

### Animation
- **Everything animates by default** — no hard seams ever
- Default transition = linear opacity dissolve (200ms), overridable via JSS `@spring` or transition config
- Opacity and backdrop/physical material properties animate together — as a Jiv fades out, its frost/blur fades proportionally
- Spring physics: `F = -k*(x - target) - c*v`, default k=170, c=26, m=1 (near critical damping)

### JSS (Jack's Style Sheets)
Custom style language (`.jss` files). Needed early in the build — can't test material visuals without it. Key features:
- `@style Name { ... }` — reusable mixins with multi-inheritance via `: Base1, Base2`
- `@spring Property { Stiffness, Damping }` — declarative spring animation
- `@when Condition { ... }` — inline responsive breakpoints
- State selectors: `:Hover`, `:Active`, `:Focus`, `:Disabled`
- `@enter`/`@exit` — entry/exit animation declarations
- Vite plugin compiles `.jss` → typed JS module

### Architecture
- **Vertical slices** — each feature owns its types, renderer, shader, defaults
- **Dependencies flow inward**: Feature → Core (ok), Core → Feature (never)
- **C#-style TypeScript**: PascalCase public, _camelCase private, `PascalCase.Purpose.ts` files
- **Arrow functions** for callback-safe `this` binding
- **Types in their feature slice**, not one big file. Core/Types.ts only has primitives (Vec2, Color, Rect)

### Performance Architecture
- **Hybrid SoA + Tree** scene graph: tree API for developers, flat Float32Arrays for hot-path rendering
- **Instanced rendering**: 1 draw call per material type, not per node. 200 nodes = 8-15 draw calls.
- **Dual Kawase blur**: 2-4x faster than Gaussian, 4-5 passes for ~48px blur
- **Glyph atlas**: single 2048×2048 texture, shelf-packed, instanced quads
- **Dirty flags**: hierarchical bits, RAF loop stops when nothing moves
- **Target**: 60fps on iPhone 12, < 8ms per frame, < 80MB memory

### External Canvas Compositing
Any `<canvas>` (Three.js, etc.) can be used as a texture source:
- Background mode: 3D scene behind UI, glass blurs it
- Inline mode: canvas as an image node at any tree position

### Progressive Blur
Single shader pass with variable kernel radius. Per-side control (like per-corner radius): independent blur strength for top/right/bottom/left. Fog mode = all four sides blur inward.

## What Exists Right Now

### Files
```
src/
  Core/
    Jwift.ts              — Canvas class (WebGL2 context, RAF loop, DPR-aware resize)
    Types.ts              — Primitives only (Vec2, Color, Rect, DirtyFlags)
    Jath.ts               — Pure math (lerp, clamp, smoothstep, superellipse SDF, easing)
    Shader.Compiler.ts    — Compile/link GLSL, extract uniforms/attributes
    Geometry.Quad.ts      — Unit quad VAO (shared by all panel rendering)
  Jiv/
    Jiv.ts                — Jiv node class (X, Y, Width, Height, Style, tree structure)
    Jiv.Types.ts          — JivStyle interface (physical material props, border, shadow, transform)
    Jiv.Defaults.ts       — DefaultJivStyle
    Jiv.Renderer.ts       — Renders a Jiv via SDF shader (DPR-scaled)
    Jiv.Animator.ts       — Springs for X, Y, Width, Height, Opacity, ScaleX, ScaleY
    Shaders/
      Jiv.Panel.vert      — Vertex shader: unit quad → panel rect in clip space
      Jiv.Panel.frag      — Fragment shader: superellipse SDF + fill + border + shadow
      Jiv.SDF.glsl         — Shared SDF function (not yet used as include, inlined in frag)
  Layout/
    Layout.Types.ts       — LayoutConfig, ChildLayout, Grid types, positioning modes
  Transform/
    Transform.Types.ts    — Transform (translate, scale, rotation, skew, origin)
  Text/
    Text.Types.ts         — TextStyle (font, align, overflow, max lines)
  Image/
    Image.Types.ts        — ImageStyle (src, object-fit, position)
  Scroll/
    Scroll.Types.ts       — ScrollConfig (position, spring params)
  Animation/
    Animation.Types.ts    — SpringConfig, TransitionConfig
    Spring.ts             — Damped harmonic oscillator
    Animation.Manager.ts  — RAF loop with auto-start/stop on settling
  Accessibility/
    Accessibility.Types.ts — Role, AriaLabel, TabIndex
  glsl.d.ts               — Type declarations for ?raw shader imports
playground/
  index.html              — Fullscreen canvas
  main.ts                 — Creates two Jivs, click toggles spring animation
tests/
  Jath.test.ts            — 10 tests (math utilities)
  Spring.test.ts          — 11 tests (spring physics)
```

### Commands
- `npm run dev` — Vite dev server on port 6777
- `npm run build` — tsc to dist/
- `npm test` — Vitest (21 tests passing)

### What Works
- WebGL2 canvas renders Jivs with superellipse SDF (antialiased edges)
- Border with blur/glow
- Drop shadow (shape-matching via SDF)
- DPR-aware rendering (CSS pixels in API, device pixels in GPU)
- Flicker-free resize
- Spring animation (click toggles panel size, pill position)
- RAF loop auto-stops when springs settle

### Git
- Branch: `feature/J-1-init`
- Remote: `origin` (GitHub: jackeltoncarbone/Jwift)
- Last commit: Phase 0-1 (project skeleton + first Jiv on screen)
- Uncommitted: Phase 2 (springs, animation manager, interactive playground)

## Build Phase Plan

Current: **Phase 2 just completed** (springs + animation). Next up: **Phase 3** (layout solver + instanced rendering).

```
P0: Skeleton ✅
P1: WebGL + SDF ✅
P2: Springs + Animation ✅
P3: Layout + Instanced Rendering ← NEXT
P4: Text
P5: JSS Core (moved up — needed for material testing)
P6: Jiv Material Pipeline + Blur (frost, refraction, physical properties)
P7: Shadow + Border + Shape Refinements
P8: Progressive Blur
P9: Input + Hit Testing (hover, active, focus states, scroll containers)
P10: External Canvas Compositing (Three.js backgrounds)
P11: Edge Lighting + Light Diffusion
P12: Accessibility Shadow DOM
P13: JSS Advanced (cascade, multi-inherit, @when, @enter/@exit)
P14: Angular Bindings (separate package)
P15: Device Tier Adaptation
```

## Show Studio Reference

The DOM-based prototype lives at:
`show-studio/ShowStudio.Web/src/Libraries/Jwift/`

Key files to reference:
- `Jiv/Jiv.ts` (1409 lines) — component with superellipse paths, borders, shadows, refraction, opacity
- `Jiv/Jiv.Layout.ts` (343 lines) — flex solver (pure math, ports directly)
- `Jiv/Jiv.Layout.Engine.ts` (550 lines) — spring-animated layout
- `Jiv/Spring.ts` (35 lines) — spring physics (already ported)
- `Material/Glass/Liquid/Material.scss` — LiquidGlass backdrop-filter chain
- `ProgressiveBlur/ProgressiveBlur.Component.ts` — 7-layer stacked blur
- `Fog/Fog.Component.ts` — 16-layer progressive fog
- `LightFocus/LightFocus.Component.ts` — pointer-tracking radial highlight

Show Studio uses Angular 21, TypeScript 5.9, Vitest + Playwright.

## Spec Documents in This Repo

- `Specification.md` — architecture, rendering pipeline, project structure, milestones
- `Conventions.md` — coding conventions, vertical slice architecture, testing strategy
- `Features.md` — complete feature inventory (Jiv, layout, materials, blur, text, input, etc.)
- `Layout.md` — flex solver design, spring integration, scroll containers
- `Styling.md` — JSS language spec (syntax, cascade, multi-inherit, springs, materials)
- `Examples.md` — target API for vanilla TypeScript, Angular, and JSS
- `Inspiration.md` — what's borrowed from SwiftUI vs Figma
- `CLAUDE.md` — Claude Code guidance for this repo
