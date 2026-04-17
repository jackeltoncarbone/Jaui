# Next Up

Handoff doc for the next agent picking this up fresh. Current as of 2026-04-17 (late session — GPU-perf arc just shipped).

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

## GPU-perf arc shipped this session (2026-04-17)

All in the WebGL2 render path. Full details in `PLAN.gpu-optimize.md`.

- **Scene FBO routing** (`_render`) — scene draws into `_sceneFbo` not the default framebuffer. Glass samples sceneFbo.Texture directly (zero blits). Final `PresentScene()` hardware-blit composites to swap chain. Pblurs still need a one-shot `SnapshotScreen` per pass because the shader samples both unblurred scene and blur pyramid (feedback-loop on sceneFbo otherwise).
- **Rect-scoped blur** (`BlurPass.ts`) — `ComputeBlur` accepts an optional `scissor` rect. Glass and pblur pass their panel rect + LOD-aware margin so the blur only fills the region the panel will sample. 20–50× fill reduction for localized glass at HD.
- **Non-glass panel batching** (`_render.flushPanels`) — 30–100 individual panel draw calls collapse into 3–5 batched instanced draws. Flush points: glass/pblur/image/text/end-of-walk.
- **Text batching** (`_render.flushText`) — same pattern. On Home the count doesn't drop much because text is heavily interleaved with panels, but infrastructure is in place for UIs with long text runs.
- **Shader variants** (`ShaderCompiler` + `Jiv.Panel.frag`) — `MATERIAL_GLASS` / `MATERIAL_NONE` defines let GLSL DCE strip the unused branches. Non-glass fragments run a ~400-line shader instead of ~900. `PanelDrawBatch` selects program by `backdrop != null`.
- **Shadow early-out** — skips `ShapeSDF` + smoothstep when `ShadowColor.a ≈ 0`. Most non-Card panels benefit.
- **`invalidateFramebuffer`** end-of-frame — default-FB depth/stencil + scene-FBO color marked discard-after-use. Mobile TBDR bandwidth win.
- **`useProgram` state cache** — skip redundant JS→GL program binds. Invalidated after BlurPass (which uses raw gl.useProgram).
- **Custom Gaussian mipmap** (`BlurPass.GenerateOutputMipmap`) — replaces driver's `generateMipmap` box filter with iterated dual-filter DOWN passes. Blurred output pyramid has Gaussian-quality mip levels through LOD 8 — no blocky artifacts at any LOD. `MAX_LEVELS = 9`.

**HUD metrics for verification:** demo URL with `?debug` shows an overlay + console logs `[Jwift perf]` each frame with per-phase CPU time + draw counts. CPU render on HD dropped from ~2ms baseline to ~0.7ms over the arc (headless readings; real machine will vary with 30/60/120Hz display).

---

## Remaining work (priority order)

### 1. MSDF / SDF text rendering (half-started — DO NOT SHIP HALF-BAKED)
Current text atlas rasterizes whole words via Canvas 2D `fillText` into RGBA tiles. Text scales poorly — aliasing when zoomed out, blurriness when scaled up. MSDF is the standard fix.

**Realistic constraints:**
- Browsers don't expose TrueType outlines → true MSDF (needs edge coloring) is unreachable in-browser. Single-channel SDF is the achievable target.
- Jump flooding in JS is ~100-200ms per cache-miss word. Prohibitive at runtime. **The SDF pass must run on the GPU** (fragment-shader JFA chain, ping-pong FBOs, ~log₂(maxDim) passes).
- Alternatively: pre-bake a font atlas at build time and ship as a binary asset. Trade: runtime font-loading flexibility for correctness + startup speed.

**Components needed:**
1. GPU JFA compute chain (or build-time atlas generator).
2. `Text.Cache` atlas format: single-channel distance in R (or 8-bit R in RGBA8).
3. `Text.Quad.frag`: `alpha = smoothstep(0.5 - fwidth(d), 0.5 + fwidth(d), d)`.
4. Atlas padding / spread knobs; test visually at multiple scales.

**Cheap alternative if MSDF is too big to ship this pass:** supersample + mipmap the existing Canvas-2D rasterization. Render words at 1.5-2× supersample, add mipmap to text atlas (currently `MIN_FILTER: LINEAR` with no mipmap), trilinear sample. Not SDF's "sharp at any scale" but solid improvement at fixed render sizes — which is Home's use case. ~30 min of work.

### 2. Verify perf on real hardware (iPad / Macbook)
Session probe ran in headless Chromium which caps FPS at ~1 regardless. Real perf across all the GPU-perf changes needs validation on the target devices. Use Safari Web Inspector via USB for iPad, or DevTools on Macbook, to read `[Jwift perf]` console output. User previously reported "laggy as f" on iPad — should be dramatically better now. HD desktop user reported 30fps cap which turned out to be display-level / Chrome-setting (not Jwift's doing; see PLAN.gpu-optimize.md sources).

### 3. `when(cond, a, b)` expression in Length resolver
Branching expression for JSS: `OffsetX: when(Exiting, 40 * (1 - Presence), 0)`.
Currently authors approximate with arithmetic (`Exiting * 40 * ...`) but
that breaks for non-linear properties (e.g. different enter vs exit
transforms). Parser + Length.ts need a `when()` function node.

### 4. Presence M5 — `@spring Presence` override per-class
`@spring` already cascades for style properties; wire it to the Presence
spring specifically so individual classes can tune stiffness/damping for
their own enter/exit animation.

### 5. `@when Width > N { … }` responsive rules
Parser + resolver. Unlocks media-query equivalents in JSS — hero padding
variant is the first use case.

### 6. Wallace analytic drop shadow (perf + quality bump)
Current shadow is `ShapeSDF + smoothstep` inside the panel shader. Early-out already lands (skips when ShadowColor.a≈0), but for panels WITH shadows the SDF path remains. Evan Wallace's erf-based analytic shadow (https://madebyevan.com/shaders/fast-rounded-rectangle-shadows/) is constant-time, better-looking at large blur radii, and could move to its own pre-pass so panels without shadows never even reference the shadow varyings. Medium-complexity refactor.

### 7. Batch text draws — infrastructure in place, but re-evaluate
The flushText() pattern landed in this session. On Home it gave ~0 improvement because text is heavily interleaved with panels. If a future page has long text runs (chat, list, menu), batching will pay off. Meanwhile: worth looking at the clip-buffer upload pattern during text batches — `SetClipBuffer` gets called per-flush; verify it's actually dedup'd.

### 8. Polish
- Scroll container clipping: verify content behind the tab bar is
  clipped by the overflow clip-stack. Fix if not.
- `"Renections"` glyph artifact on cold-load before fonts ready.
  Related to text measurement timing.
- `<jiv>` template inputs for `X` / `Y` so floating chrome can use
  `Position: Placed` without imperative resize hooks.
- Visually verify smoothstep AA on clip corners — no shimmer at
  sub-pixel scales.

### 9. Three.js hero integration
The 3D reality-view region in the hero needs Three.js via the "External
Canvas Compositing" feature in `Features.md`. Not yet implemented.

---

## Suggested: set up Playwright perf probe for verification

The session used a local Playwright script (gitignored at `perf-probe.mjs`) that launched the dev server, captured `[Jwift perf]` console logs across three viewport sizes (small / medium / HD), and screenshot each for visual regression verification. **Strongly recommended** for any future perf/visual work — catches regressions instantly.

Minimal setup:
```bash
# playwright already in node_modules
# dev server must be running on :6777
# create perf-probe.mjs: launch chromium, goto ?debug, wait for rAF
#   samples, resize viewport, screenshot. ~80 lines.
```

Notes:
- Headless Chromium throttles WebGL aggressively — **FPS readings are meaningless** (~1 fps regardless of load). Use it for visual regression + CPU phase timing + draw counts + screenshot diffs, NOT for FPS numbers.
- Real perf validation needs actual browser on real device.
- The perf probe + screenshots directory should stay gitignored (local artifacts).

See `PLAN.gpu-optimize.md` for the full shipped work and pending items (e.g. `C3 texStorage2D`, full Wallace shadow pass) that were scoped but not done.

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
