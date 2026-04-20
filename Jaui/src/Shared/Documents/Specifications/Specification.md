# Jaui

A canvas-based UI rendering engine for the web. Every pixel is yours.

Jaui renders UI to a WebGPU canvas — no DOM compositing, no browser CSS layout, no platform rendering differences. The same glass material looks identical on Chrome, Safari, Firefox, and every mobile browser. You own the rendering pipeline.

## Why

The DOM was built for documents. We're building interfaces. The gap between what CSS compositors can do and what we need produces:

- `backdrop-filter` + `clip-path` breaking on WebKit
- `backdrop-filter` + `mask` not rendering on Safari
- SVG filter `feDisplacementMap` silently failing on iOS
- Progressive blur impossible without 7 stacked compositor layers
- Scroll artifacts from `IntersectionObserver` + `backdrop-filter` invalidation
- Per-browser font weight rendering differences
- Forced synchronous reflows from measuring layout
- Memory crashes on mobile from too many GPU compositor layers

These aren't bugs we can fix. They're architectural limits of asking a document renderer to be a GPU compositor. Jaui sidesteps all of them by rendering directly to a WebGPU canvas.

## What

Jaui is three things:

1. **Jaui Core** — the rendering engine. TypeScript + WebGPU. Handles layout, painting, hit testing, text, animation, materials, and input. Framework-agnostic — works with any JS framework or none.

2. **Jaui.Angular** — Angular bindings. Components and directives that let Angular templates describe Jaui UI. Angular handles state, routing, and data flow. Jaui handles rendering.

3. **Jaui Materials** — the visual system. Glass, blur, refraction, shadows, borders — implemented as GPU shaders. The material system from Show Studio's Jiv (`ShowStudio.Web/src/Libraries/Jaui/Jiv/`) is the reference implementation in DOM/CSS. Jaui reimplements these as shader programs.

## Reference Implementation

Show Studio (`show-studio/ShowStudio.Web/src/Libraries/Jaui/`) contains the DOM-based prototype of everything Jaui will do natively:

| Show Studio (DOM) | Jaui (Canvas) |
|---|---|
| `Jiv.ts` — component with clip-path, backdrop-filter, SVG borders | `Panel` — WebGPU-rendered rounded rect with blur, border, shadow shaders |
| `Jiv.Layout.Engine.ts` — spring-animated flex layout via DOM measurement | `Layout` — flex layout computed in JS, positioned by the engine, spring-animated |
| `Spring.ts` / `Spring.Animation.Manager.ts` — spring physics | `Spring` — same physics, drives layout and property animation |
| `ProgressiveBlur.Component.ts` — 7 stacked backdrop-filter layers | `BlurGradient` — single fragment shader with variable kernel |
| `GlassDropdown.Component.ts` — dropdown with glass material | `Dropdown` — Jaui primitive with glass material + clip animation |
| `PillButtonGroup.Component.ts` — responsive overflow button bar | `ButtonGroup` — layout primitive with overflow measurement |
| Superellipse `GeneratePath()` in `JivService` | `Shape.Superellipse` — SDF function in GLSL, used for clip + border + shadow |
| `--border-radius`, `--backdrop`, `--opacity` CSS vars | `style.borderRadius`, `style.backdrop`, `style.opacity` — direct properties on render nodes |

## Architecture

```
┌─────────────────────────────────────────┐
│  Your App (Angular, React, Vanilla)     │
├─────────────────────────────────────────┤
│  Jaui.Angular (or Jaui.React, etc.)   │
│  Template bindings → render tree        │
├─────────────────────────────────────────┤
│  Jaui Core                             │
│  ┌───────────┬──────────┬─────────────┐ │
│  │  Layout   │  Input   │  Animation  │ │
│  │  (Flex)   │  (Hit,   │  (Spring,   │ │
│  │           │   Text,  │   Tween)    │ │
│  │           │   IME)   │             │ │
│  ├───────────┴──────────┴─────────────┤ │
│  │  Render Pipeline                   │ │
│  │  Scene Graph → Batch → Draw Calls  │ │
│  ├────────────────────────────────────┤ │
│  │  Materials (Shaders)               │ │
│  │  Glass, Blur, Shadow, Refraction   │ │
│  ├────────────────────────────────────┤ │
│  │  WebGPU                            │ │
│  └────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│  Accessibility Shadow DOM               │
│  (Parallel DOM for screen readers)      │
└─────────────────────────────────────────┘
```

## Rendering

### Scene Graph
Every UI element is a `Node`. Nodes form a tree. Each node has:
- Transform (position, scale, rotation)
- Layout constraints (flex properties)
- Style (material, border, shadow, opacity, clip shape)
- Children
- Hit test shape

### Draw Pipeline
Each frame:
1. **Layout pass** — resolve flex constraints, compute positions/sizes (pure math, no DOM)
2. **Animation pass** — step springs, update animated properties
3. **Cull pass** — skip nodes outside the viewport
4. **Batch pass** — group nodes by material/texture to minimize draw calls
5. **Render pass** — issue WebGPU draw calls
6. **Post-process pass** — blur, bloom, color grading (full-screen shaders)

### Materials

**Solid Glass** — opaque tinted surface with subtle gradient. One draw call per panel.

**Liquid Glass** — the frosted glass effect. Renders the scene behind the panel to a texture, applies a Gaussian blur shader, tints it, composites with the panel content. Equivalent to `backdrop-filter: blur() saturate() brightness()` but as a shader — works identically everywhere.

**Progressive Blur** — variable-kernel blur in a single shader pass. The blur radius varies by UV coordinate (e.g., stronger at top, weaker at bottom). Replaces 7 stacked DOM layers with one draw call.

**Superellipse SDF** — all clipping, borders, and shadows use a signed distance field for the superellipse shape. Computed per-pixel in the fragment shader. Infinitely smooth at any resolution. No SVG paths, no clip-path, no path caching.

**Refraction** — displacement mapping as a shader. The bezel/dome effect from Jiv's `feDisplacementMap` becomes a per-pixel UV offset in the glass shader. No canvas generation, no PNG encoding, no SVG filters.

## Layout

Jaui's layout engine is a pure-JS flex implementation. No DOM measurement. No `getComputedStyle`. No `offsetWidth`. No forced reflows.

Spec-compliant flex with:
- `direction`, `wrap`, `justify`, `align`, `gap`
- `grow`, `shrink`, `basis` per child
- `margin: auto` centering
- Percentage and em resolution against parent metrics
- Spring-animated transitions between layout states (from Jiv.Layout.Engine)

The layout from Show Studio's `Jiv.Layout.ts` and `Jiv.Layout.Engine.ts` is the starting point. The difference: Jaui computes layout in pure math, never touching the DOM.

## Text

Text is the hardest part. The approach:

1. Use the browser's `CanvasRenderingContext2D.measureText()` for text shaping and measurement — this gives us font metrics, line breaking, and glyph positioning for free without building a text shaper
2. Render text to an offscreen canvas, upload as a texture
3. Cache text textures by content + style hash
4. For text input: maintain a hidden DOM `<textarea>` for IME/clipboard/autocorrect, capture its events, render the text state to canvas

This is what Figma, Excalidraw, and rive all do. The hidden textarea gives you native IME, autocorrect, clipboard, and accessibility for free. The canvas renders the visual representation.

## Input

- **Hit testing** — walk the scene graph back-to-front, test point against each node's clip shape (superellipse SDF makes this a single `distance < 0` check)
- **Pointer events** — captured on the canvas element, dispatched to the hit node
- **Keyboard** — captured via the hidden textarea
- **Focus** — managed by the engine's focus chain, mirrored to the accessibility DOM
- **Scrolling** — spring-physics scroll containers with momentum, overscroll, and rubber-banding. No browser scroll — we own it

## Accessibility

A lightweight shadow DOM tree mirrors the render tree structure:
- Each interactive node gets a corresponding `<div role="button">` or `<input>` etc.
- `aria-label`, `aria-expanded`, etc. are synced from the render tree
- Screen readers see the shadow DOM, users see the canvas
- Focus state is bidirectional: focusing the shadow element focuses the render node and vice versa

## Animation

Two systems, same as Show Studio:

1. **Spring physics** — damped harmonic oscillator. Drives layout transitions, scroll momentum, gesture responses. `Spring.ts` from Show Studio moves over directly.

2. **Tween** — duration-based easing for discrete state changes (opacity fade, color transitions). CSS-like but computed in JS.

Both systems feed into the render tree's property values. The render pipeline reads current animated values each frame — no DOM style writes, no forced reflows.

## Performance Budget

Target: 60fps on an iPhone 12 (A14, 4GB RAM).

- Layout pass: < 1ms for 200 nodes
- Render pass: < 4ms (batched draw calls, instanced rendering for repeated shapes)
- Total frame: < 8ms (leaves headroom for app logic)
- Memory: < 80MB total (well under iOS WKWebView's ~200MB kill threshold)
- No `getComputedStyle`, no forced reflow, no DOM measurement — ever

## Project Structure

```
Jaui/
  src/
    Core/
      Node.ts              — base scene graph node
      Layout.ts            — flex layout solver
      Spring.ts            — spring physics
      Renderer.ts          — Renderer interface (GPU backend abstraction)
      WebGPU.Renderer.ts   — WebGPU implementation of Renderer
      WebGPU.Device.ts     — GPUDevice/GPUAdapter lifecycle, surface config
      WebGPU.Pipeline.Cache.ts — render/compute pipeline cache
      HitTest.ts           — point-in-shape testing
      Input.ts             — pointer + keyboard dispatch
      Text.ts              — text measurement + texture cache
      Accessibility.ts     — shadow DOM sync
    Materials/
      Glass.ts             — Liquid Glass material
      Blur.ts              — compute blur dispatch
      Shadow.ts            — drop shadow
      Border.ts            — SDF border
      Refraction.ts        — displacement/dome
      Progressive.Blur.ts  — progressive blur overlay
    Shaders/
      panel.wgsl           — non-glass panel rendering (WGSL)
      glass.wgsl           — glass composite (refraction, CA, rim, specular)
      blur_down.wgsl       — compute: downsample kernel
      blur_up.wgsl         — compute: upsample kernel
      text.wgsl            — text atlas quad rendering
      blit.wgsl            — fullscreen quad blit
      progressive.wgsl     — progressive blur overlay
      sdf.wgsl             — superellipse SDF functions
    Primitives/
      Panel.ts             — rounded rect with material
      Text.ts              — text node
      Image.ts             — image node
      ScrollView.ts        — spring-physics scroll container
      Stack.ts             — flex container (HStack, VStack, ZStack)
  angular/                 — Jaui.Angular package
    JauiCanvas.Component.ts
    JauiPanel.Directive.ts
    JauiText.Directive.ts
    ...
```

## Milestones

### M1 — Render a glass panel
WebGL canvas. One rounded rect. Superellipse SDF. Solid color fill. Confirm it renders identically on Chrome, Safari, Firefox.

### M2 — Glass material
Blur the scene behind a panel. Tint. Brightness. The Liquid Glass effect as a shader. Compare side-by-side with Show Studio's Jiv on the same screen.

### M3 — Layout
Flex layout solver. Position children. Spring-animated transitions. No DOM.

### M4 — Text
Render text. Measure text. Line breaking. Text input via hidden textarea.

### M5 — Interaction
Hit testing. Pointer events. Focus. Scroll containers with spring physics.

### M6 — Angular bindings
`<jaui-canvas>` component. Directives for panels, text, images. Use in Show Studio alongside existing DOM UI.

### M7 — Migration
Replace Jiv in Show Studio with Jaui-rendered equivalents. Page by page. DOM content inside Jaui layout containers.
