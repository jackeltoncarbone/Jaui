# Next Up

Handoff doc for the next agent picking this up fresh. Current as of 2026-04-17.

---

## Where we are

**Engine.** WebGL2 + WebGPU backends, both live. CSS-style overflow
clipping fully implemented — per-frame clip-stack buffer shared across
panel/text/progressive-blur shaders. Clip SDF matches the panel's own
superellipse so the discard edge exactly traces the painted rounded-rect
edge. Clip edges use a 1-pixel smoothstep AA; progressive blur clamps UV
lookups to the clip AABB so beyond-clip content can't bleed.

**JSS language.** Parser supports:
- `@Name: value` variable declarations + `@Name` reference in expressions
- `Name : Base1, Base2 { … }` multi-class inheritance (build-time flatten)
- `@spring Property { Stiffness, Damping }` per-property spring overrides
- `Presence`, `Entering`, `Exiting` as first-class built-in identifiers
  (resolved per-Jiv per-frame from the Presence spring)
- Full arithmetic in Length values (`+`, `-`, `*`, `/`, parens, `vh`/`vw`/`%`/`pt`)

**Presence (entry/exit).** Fully live through M4. Every Jiv has a
`Presence` spring (0→1 on mount, 1→0 on `RequestLeave()`, removed on
settle). `Entering` / `Exiting` boolean flags exposed as built-in
identifiers. Default `Opacity: Presence` in Jiv.Defaults.ts gives
implicit fade without any JSS authoring. Authors can write
`OffsetY: Entering * -20 * (1 - Presence)` etc.

**Progressive blur.** True per-pixel variable Gaussian — shader samples
unblurred scene + mipmapped pyramid with ramp-driven LOD, blending
entirely in RGB (no alpha-masked haze). Background tint + grading ramp
along the gradient.

**Home demo.** Show Studio home page port with hero, card widgets
(URL-backed ImageSrc, FitMode: Cover), Liquid Glass chrome (Toolbar +
TabBar in a ChromeFrame with concentric radii), progressive blur
feathers, icon font. `npm run dev` → port 6777.

**Core design rules (non-negotiable):**
- Concentric radii: `child = parent - gap`. Always.
- "Everything animates, no hard seams." Springs chase instant layout.
- Layout/compute is instant; springs create motion from the delta.

---

## Remaining work (priority order)

### 1. Optimize Jwift engine
Profile and reduce per-frame cost. Canvas._tick calls _render every RAF
frame unconditionally even when nothing is dirty and no spring is active.
Progressive blur chain rebuilds 4 Gaussian passes per frame when visible.
Audit: idle-frame early-out, dirty tracking, GPU fill-rate, texture
allocation, tree-walk cost. Target: 60 fps on iPhone 12 (A14, 4GB).

### 2. `when(cond, a, b)` expression in Length resolver
Branching expression for JSS: `OffsetX: when(Exiting, 40 * (1 - Presence), 0)`.
Currently authors approximate with arithmetic (`Exiting * 40 * ...`) but
that breaks for non-linear properties (e.g. different enter vs exit
transforms). Parser + Length.ts need a `when()` function node.

### 3. Presence M5 — `@spring Presence` override per-class
`@spring` already cascades for style properties; wire it to the Presence
spring specifically so individual classes can tune stiffness/damping for
their own enter/exit animation.

### 4. `@when Width > N { … }` responsive rules
Parser + resolver. Unlocks media-query equivalents in JSS — hero padding
variant is the first use case.

### 5. Polish
- Scroll container clipping: verify content behind the tab bar is
  clipped by the overflow clip-stack. Fix if not.
- `"Renections"` glyph artifact on cold-load before fonts ready.
  Related to text measurement timing.
- `<jiv>` template inputs for `X` / `Y` so floating chrome can use
  `Position: Placed` without imperative resize hooks.
- Visually verify smoothstep AA on clip corners — no shimmer at
  sub-pixel scales.

### 6. Three.js hero integration
The 3D reality-view region in the hero needs Three.js via the "External
Canvas Compositing" feature in `Features.md`. Not yet implemented.

---

## Where things live

**Specs:** `Jwift/src/Shared/Documents/Specifications/`
- `Specification.md` — architecture, pipeline, milestones M1–M7
- `Features.md` — every visual/interaction feature
- `Styling.md` — JSS language
- `Layout.md` — flex solver design
- `Presence.md` — entry/exit animation system
- `Conventions.md` — code style
- `Examples.md` — target API
- `Var.md` — `@var` spec

**Engine core:** `Jwift/src/Core/`
- `Jwift.ts` — Canvas class, render loop, clip-stack walker
- `Clip.Stack.ts` — ClipShape type + per-frame accumulator
- `WebGPU.Renderer.ts`, `WebGL2.Renderer.ts` — GPU backends
- `Style.Resolver.ts` — JivStyle → JivRenderStyle
- `Length.ts` — expression parser (arithmetic, `@Name` vars, built-ins)

**Animation:** `Jwift/src/Animation/`
- `Animation.Manager.ts` — RAF loop, settle detection
- `Spring.ts` — spring physics
- `Presence.Manager.ts` — Presence springs + settle-then-remove

**JSS parser:** `Jwift/src/Jss/`
- `Jss.Parser.ts` — rulesets, extends, `@var`, `@spring`
- `Jss.Routes.ts` — prop-name → slot routing

**Shaders** (edit source, regen via `npm run build:shaders`):
- `Jwift/src/Core/Shaders/` — WebGPU WGSL
- `Jwift/src/Jiv/Shaders/`, `Jwift/src/Text/Shaders/`,
  `Jwift/src/ProgressiveBlur/ProgressiveBlur.Shader.ts` — WebGL2 GLSL

**Demo:** `Jwift.Angular.Demo/src/Home/Home.jss` + `Home.ts`
Dev server: `npm run dev` (port 6777).

**Show Studio reference:**
`../show-studio/ShowStudio.Web/src/Libraries/Jwift/` — DOM-based Jiv.
`../show-studio/ShowStudio.Web/src/App/Home/` — the home page being ported.

---

## Key context

1. **Jwift is an engine, Show Studio is the test customer.** Everything
   must serve the Home page port.
2. **Concentric is non-negotiable** — every radius = parent - gap.
3. **Instant compute + spring motion** — discrete calculation, temporal
   animation.
4. **"Everything animates"** — hard pops are a bug.
5. **Vertical slices** — each feature owns its full stack from shader
   to public API.
6. **Read the spec before writing code.**
