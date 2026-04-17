# Inspiration

Jwift draws from two systems that solved hard UI problems in fundamentally different ways — then combines what works from each.

## SwiftUI

SwiftUI proved that declarative UI doesn't need a DOM. Views are value types. The framework diffs descriptions, not nodes. Layout is a protocol, not a black-box engine.

What Jwift takes from SwiftUI:

**Declarative composition.** UI is a tree of descriptions. You say *what*, not *how*. A `Panel` with children is a struct-like declaration — the engine decides when and how to render it.

**Layout as a protocol.** SwiftUI's layout contract is simple: parent proposes size, child responds with size, parent positions child. Jwift's flex solver follows the same top-down pattern — parent provides constraints, children resolve within them, no backtracking.

**Implicit animation.** In SwiftUI, `.animation(.spring())` makes any state change animate automatically. JSS's `@Spring *` does the same — declare the physics once, every property change animates. No imperative `UIView.animate` calls.

**View identity and lifetime.** SwiftUI tracks views by identity (structural position or explicit `id`). When identity changes, the view exits and a new one enters. Jwift's `@Enter`/`@Exit` system works the same way — node identity drives animation lifecycle.

**Primitives, not widgets.** SwiftUI ships `Text`, `Image`, `Color`, `Shape` — not `UIButton`, `UITableView`. Complex components are compositions of primitives. Jwift follows this: `Panel`, `Text`, `Image`, `ScrollView`, `Stack`. No premade widgets.

**Environment and preferences.** SwiftUI passes values down the tree (environment) and up the tree (preferences). Jwift's JSS cascade is the downward channel. Concentric radius computation — where a child reads its parent's radius — is an upward preference.

## Figma's Rendering Engine

Figma proved that a WebGL canvas can replace native rendering for complex, interactive UI. Every design tool said "you need native" — Figma shipped a browser-based editor that outperforms most of them.

What Jwift takes from Figma:

**Canvas owns every pixel.** Figma renders to a single `<canvas>`. No DOM elements for shapes, text, or controls. The browser is a viewport, not a layout engine. Jwift does the same — one WebGL canvas, zero DOM rendering.

**Scene graph architecture.** Figma maintains a tree of nodes with transforms, styles, and children. The renderer walks the tree, batches draw calls, and composites. Jwift's node tree → batch pass → draw call pipeline mirrors this.

**Text via offscreen canvas.** Figma uses `CanvasRenderingContext2D` for text shaping and measurement, then uploads glyphs as textures. Jwift does the same — browser text shaping for free, canvas rendering for consistency.

**Hidden textarea for input.** Figma captures keyboard input through an invisible `<textarea>` to get native IME, clipboard, autocorrect, and accessibility without building a text input system from scratch. Jwift uses the same technique.

**Accessibility shadow DOM.** Figma maintains a parallel DOM tree that screen readers can traverse while users see the canvas. Interactive elements get `role`, `aria-label`, and focus management. Jwift mirrors this approach — the shadow DOM is the accessibility layer, the canvas is the visual layer.

**GPU-first rendering.** Figma uses WebGL for fills, strokes, blurs, and blending. Complex effects that would require stacked DOM layers or SVG filters become single shader passes. Jwift's material system (Liquid Glass, progressive blur, SDF shapes) follows the same philosophy.

**C++ compiled to WebAssembly (aspirational).** Figma's core is C++ compiled to WASM for performance-critical paths (layout, rendering, vector math). Jwift starts in TypeScript but the layout solver and SDF math are pure functions designed to be portable to WASM if performance demands it.

## What Neither Does

SwiftUI delegates rendering to platform compositors (Core Animation, Metal). It doesn't own the GPU pipeline. Figma owns the GPU pipeline but isn't a UI framework — it doesn't have layout constraints, state management, or component composition.

Jwift sits in the gap: SwiftUI's declarative model and layout protocol, rendered through Figma's canvas-owns-everything architecture.

| Concept | SwiftUI | Figma | Jwift |
|---|---|---|---|
| Rendering | Platform compositor | WebGL canvas | WebGL canvas |
| Layout | Protocol-based (propose/respond) | Manual positioning | Flex solver (top-down) |
| Animation | Implicit spring/tween | Timeline-based | Implicit spring (from SwiftUI) |
| Styling | ViewModifiers | Fill/stroke properties | JSS (cascading, multi-inherit) |
| Text | Native text engine | Offscreen canvas + texture | Offscreen canvas + texture (from Figma) |
| Input | Native responder chain | Hidden textarea | Hidden textarea (from Figma) |
| Accessibility | Native (automatic) | Shadow DOM | Shadow DOM (from Figma) |
| State | @State, @Binding, @Observable | Internal object model | Framework-agnostic (Angular, React, vanilla) |
| Components | Struct-based views | None (design tool) | Node tree + JSS |
