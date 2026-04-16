# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Jwift is a canvas-based UI rendering engine for the web. It renders all UI to a WebGPU canvas — no DOM compositing, no browser CSS layout. The goal is pixel-identical rendering across all browsers by owning the entire rendering pipeline.

This repo currently contains **specification documents only** — no source code has been written yet. The specs define the target architecture, API, conventions, and style system. Implementation will follow the milestone plan in Specification.md.

## Key Specs

- **Specification.md** — architecture overview, rendering pipeline, project structure, milestones
- **Conventions.md** — coding conventions, file naming, architecture rules, testing strategy, build tooling
- **Layout.md** — flex layout solver design, spring animation integration, scroll containers
- **Styling.md** — JSS (Jack's Style Sheets) language spec: syntax, cascading, multi-inheritance, springs, materials, responsive
- **Examples.md** — target API for vanilla TypeScript, Angular bindings, and JSS usage

## Three Components

1. **Jwift Core** — TypeScript + WebGPU rendering engine (layout, painting, hit testing, text, animation, materials, input)
2. **Jwift.Angular** — Angular bindings (components/directives that describe Jwift UI in Angular templates)
3. **Jwift Materials** — GPU shader system (glass, blur, refraction, shadows, borders)

## Reference Implementation

Show Studio's DOM-based Jiv library (`show-studio/ShowStudio.Web/src/Libraries/Jwift/Jiv/`) is the reference. Jwift reimplements Jiv's visual effects as GPU shaders instead of CSS `backdrop-filter`/`clip-path`/SVG filters.

## Conventions (C#-Style TypeScript)

- **Public** members: `PascalCase` (properties, methods, interfaces, enums)
- **Private** members: `_camelCase` (fields, methods)
- **Local** variables: `camelCase`
- **Files**: `PascalCase.Purpose.ts` (e.g., `Glass.Material.ts`, `Spring.Animation.Manager.ts`)
- **Arrow function class members** preferred for callback-safe `this` binding
- **Regular methods** only for overridable/inherited behavior
- **Component selectors**: bare names (`panel`, `toolbar`), not prefixed (`jwift-panel`)

## Architecture Rules

- **Vertical slices**, not horizontal layers — each feature owns everything from shader to public API (e.g., `Glass/Glass.Material.ts`, `Glass/Glass.Shader.wgsl`, `Glass/Glass.Style.ts`)
- **Shared infrastructure** (WebGPU device, math) lives in `Core/`
- **Dependencies flow inward only**: Feature → Core (ok), Core → Feature (never), Feature A → Feature B (avoid — extract to Core)
- **Injectable services** over static classes (exception: pure math utilities like `Jath` can be static)
- **Config objects express constraints**, not concrete values — consumers derive actual values

## Design System Rules

- **Concentric radii**: nested element radius = parent radius - gap. Non-negotiable. Use `BorderRadius: concentric` in JSS.
- **Apple minimalism**: monochrome UI, Liquid Glass for overlays/interactive, Solid Glass for content surfaces, typography for hierarchy (not color)
- **Spring animation**: damped harmonic oscillator physics. No CSS transitions, no bounce/overshoot.

## JSS (Jack's Style Sheets)

Custom style language (`.jss` files) parsed by Jwift, not the browser. Key features:
- No semicolons, one property per line, typed values
- `@style Name { ... }` — reusable mixins with multi-inheritance via `: Base1, Base2`
- `@spring Property { Stiffness, Damping }` — declarative spring animation
- `@when Condition { ... }` — inline responsive breakpoints (replaces media queries)
- `@var Name: value` — typed variables referenced as `@Name`
- Material types (`LiquidGlass`, `SolidGlass`) are first-class values, not CSS filter hacks
- Vite plugin compiles `.jss` to typed style tree objects at build time

## Build & Test (Planned)

- **Build**: `tsc` (ESM + `.d.ts`). No bundler for the library — consumers bundle it.
- **Dev server**: Vite
- **Unit tests**: Vitest (layout math — pure functions, no DOM)
- **Shader tests**: snapshot tests (render known scene, compare pixels)
- **Visual regression**: Playwright screenshots across Chromium + WebKit
- **Interaction tests**: Playwright simulating pointer/keyboard on the canvas

## Performance Targets

- 60fps on iPhone 12 (A14, 4GB RAM)
- Layout pass: < 1ms for 200 nodes
- Total frame: < 8ms
- Memory: < 80MB
- Zero DOM measurement — no `getComputedStyle`, no `offsetWidth`, no forced reflows
