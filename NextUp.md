# Next Up

Handoff doc for the next agent picking this up fresh. Read top-to-bottom.
Current as of 2026-04-17.

---

## Where we are

**Engine.** WebGL2 + WebGPU backends, both live. CSS-style overflow
clipping fully implemented — per-frame clip-stack buffer shared across
panel/text/progressive-blur shaders. Clip SDF matches the panel's own
superellipse so the discard edge exactly traces the painted rounded-
rect edge (no halo drift). Clip edges use a 1-pixel smoothstep AA
instead of a hard discard; progressive blur clamps UV lookups to the
clip AABB (inset by half a texel at the current LOD) so beyond-clip
content can't bleed into blurred pixels. `ParentOverflow: Inherit |
Visible | Hidden` on `ChildLayout` lets each child opt in or out of its
parent's clip.

**Presence (entry/exit).** M1 + M2 are live. Every Jiv has a
`Presence` spring (0..1). On mount it starts at 0 and springs to 1; on
`RequestLeave()` it springs to 0 and the node is hard-removed only once
the spring settles. Implicit opacity fade is wired directly in
`Jiv.InstanceBuffer` (`data[Opacity] = style.Opacity * jiv.Presence`),
so every Jiv fades in/out by default without any JSS authoring. Full
spec: `Jwift/src/Shared/Documents/Specifications/Presence.md`.

**Home demo.** `Jwift.Angular.Demo/src/Home/` renders the Show Studio
home page — the migration target (M7 in `Specification.md`). Card
widget ported with URL-backed `ImageSrc`, `FitMode: Cover`, and the
Show Studio mock data shape (Company, Channel, Item types). Chrome
layout uses the ChromeFrame pattern: Toolbar + TabBar nest inside one
Fixed full-viewport container with uniform 24 Padding and `Justify:
SpaceBetween` — uniform gap on every side makes the concentric radius
derivation unambiguous.

**Layout.** Intrinsic sizing tokens `'MinContent' | 'MaxContent'`
available on `ChildLayout.Width` / `Height`. Wrap layout uses real
allocated width for wrap height; stretch never shrinks lines.

**Image cache.** SVGs re-rasterize on DPR change so browser zoom
stays sharp.

**Core design rules (non-negotiable, in CLAUDE.md + memory):**
- Concentric radii: `child = parent - gap`. Always.
- "Everything animates, no hard seams." Changes spring from current to
  target. Motion emerges from the delta.
- Layout/compute is **instant**; springs chase the instant result to
  create motion. Shadow DOM (accessibility) is the instant truth; the
  render tree lags temporally via springs.

---

## Spec state of JSS language features

| Feature | Docs | Parser implements? | Notes |
|---|---|---|---|
| `@var name: value` + `@name` reference | Styling.md ✓ | **No** | Blocks Presence M3, `@when`, author-driven concentric chains — highest-leverage next item. |
| Arithmetic + parens in lengths | Length.ts grammar ✓ | Partially | Length resolver handles arithmetic; `@Name` refs need resolver wiring. |
| `BorderRadius: concentric` keyword | Styling.md ✓ | No | Owner said skip — "designer's job to compute." |
| `@when Width > N { … }` | Styling.md ✓ | No | Needed for responsive hero padding. |
| `@spring Property { … }` | Styling.md ✓ | **Yes** | Works. |
| `@style Foo : Base { … }` | Styling.md ✓ | **Yes** | RowCompact / CardCompact use it. |
| `@Presence` reserved var (also `@P`) | Presence.md ✓ | **No** (JSS-side) | Implicit Opacity fade is hardcoded in the instance buffer. Author-facing `@Presence` binding in JSS requires `@var` first. |
| `when(cond, a, b)` expression | Presence.md (draft) | No | Deferred — clean from examples until specced separately. |

---

## Presence implementation status

| Milestone | Status |
|---|---|
| M-Presence-1: `Element.Presence` + spring + default 0→1 on mount | **Done** — `Jwift/src/Animation/Presence.Manager.ts` |
| M-Presence-2: `RequestLeave()` + settle-then-remove + framework binding change | **Done** — `Jwift.Angular/src/Jiv/Jiv.ts` calls `RequestLeave()` in `ngOnDestroy` |
| M-Presence-3: JSS `@Presence` reserved var + resolver wiring + implicit Opacity fallback | **Partial** — fade is baked into `Jiv.InstanceBuffer` (`style.Opacity * jiv.Presence`). Authors cannot yet write `Opacity: @Presence * 0.5` or `OffsetY: -20 * (1 - @Presence)` in JSS. Completing requires `@var` support. |
| M-Presence-4: `@Entering` / `@Exiting` boolean flags | Not started |
| M-Presence-5: `@spring Presence` override per-class | Not started (engine default lives in `Presence.Manager.ts`) |

**Open Presence.md policy calls** (close before M3 lands):
1. Hit testing during exit — a Jiv at Presence=0.3 (leaving) still
   receives pointer events by default. Suggested: **no**, stop on
   `RequestLeave` to match the a11y-removes-immediately rule. Not yet
   written into the spec.
2. Default Presence spring params — the spec draft says Stiffness 220
   / Damping 26; gentler Stiffness 170 / Damping 22 matches Apple feel
   better. Check what `Presence.Manager.ts` actually ships and
   reconcile with the spec.
3. `when(cond, a, b)` syntax — used in examples, then listed as out of
   scope. Clean the examples to use pure arithmetic and drop the
   `when()` references until it's specced separately.
4. Add `@P` alias to the spec (owner approved).

---

## Backlog (priority order)

### 1. Close Presence.md spec gaps + add `@P` alias
~30 min. Items 1-4 in the "Open policy calls" list above.

### 2. Spec `@var` + JSS arithmetic
Short spec, mostly already in Styling.md. Needs:
- Grammar for `@Name` reference in expression contexts (Length parser
  already handles `+ - * /` and parens — just needs `@Name` lookup
  into a var table).
- Where `@var` declarations live in the parse tree (top-level only?
  nested inside selectors?).
- Scope resolution (lexical, dynamic via context?).
- Error behavior (missing var, circular refs).

### 3. Implement `@var` + arithmetic in parser + resolver
Files: `Jwift/src/Jss/Jss.Parser.ts`, `Jwift/src/Core/Length.ts`,
`Jwift/src/Core/Style.Resolver.ts`. Gate to Presence M3, `@when`, and
any author-driven concentric chains.

### 4. Presence M3 — `@Presence` as authorable JSS var
Wire the resolver so `Opacity: @Presence`, `OffsetY: -20 * (1 -
@Presence)`, `Transform: scale(0.96 + 0.04 * @Presence)` work in JSS
and re-resolve each frame from the Jiv's current Presence value.
Replace the hardcoded `style.Opacity * jiv.Presence` multiply in
`Jiv.InstanceBuffer` with the resolver-driven value (keeping the
implicit Opacity fallback when the author hasn't set Opacity).

### 5. "Get Started" CTA — first-paint intrinsic width
**Partially fixed** by the new intrinsic-sizing tokens
(`Width: MaxContent`). Owner reports the pill now lands at the correct
width, **but** it still starts wrong for the first second or two
before animating to the correct position. Likely path: text measurement
runs before `document.fonts.ready` → measureText returns 0-width on
custom-font glyphs → CTA collapses to min-content → wraps. When fonts
load later and re-measure kicks in, layout recomputes and the spring
animates to the correct size. Investigate `Jwift/src/Text/Text.Measure.ts`
and `_listenForFontLoad` in `Jwift/src/Core/Jwift.ts`: (a) defer the
first layout pass until `document.fonts.ready`, or (b) re-measure and
invalidate all text nodes on `fonts.ready` event, not just ones
explicitly changed.

### 6. Toolbar logo sizing mismatch
Owner observed: Show Studio logo in the Toolbar renders at a different
height than the Avatar (48×48 with 40×40 inner). Probe from this
session shows the Logo Jiv at W=120, H=50 when `Height: 40pt` is set
— implies PointScale is 1.25, so `40pt` resolves to 50 instead of 40.
Avatar uses fixed `40` and lands at 40×40. Two paths:
(a) Change `ToolbarLogo { Height: 40pt }` to `Height: 40` to pin to
px and match the avatar's fixed size.
(b) Keep `pt` but make sure the Toolbar group shares a consistent
PointScale such that avatar (fixed 40) and logo (40pt) resolve to the
same number.
Owner fixed this on a parallel machine but the fix didn't land in the
repo — re-fix here and commit.

### 7. Presence M4 — `@Entering` / `@Exiting` flags
Boolean values exposed to the resolver (true while Presence target is
1 or 0 respectively). Lets authors branch enter vs exit animation via
arithmetic without introducing `when()`.

### 8. Presence M5 — `@spring Presence` override per-class
`@spring` already cascades; wire it to the Presence spring specifically
so individual classes can tune stiffness/damping.

### 9. `@when Width > N { … }` responsive rules
Parser + resolver. Unlocks SS's `@media (min-width: 768px)` equivalents
in the demo — hero padding variant is the first use case.

### 10. Polish
- Scroll container clipping: content behind the tab bar should be
  clipped by Screen's overflow. The new clip stack should handle this
  — verify, fix if not.
- `"Renections"` glyph artifact on first render before
  `document.fonts.ready`. Cold-load repro. Related to #5.
- `<jiv>` template inputs for `X` / `Y` so floating chrome can use
  `Position: Placed` without imperative resize hooks.
- Visually verify the new smoothstep AA on clip corners — no shimmer
  at sub-pixel scales.

### 11. Migration: continue the Show Studio home
After card art (done), the 3D reality-view region in the hero needs
Three.js integration via the "External Canvas Compositing" feature in
`Features.md`. Not yet implemented.

---

## Visible probes in the demo

- **Double-click the page** to toggle an extra card in the Featured
  row (`ExtraCard` signal + `@HostListener('document:dblclick')` in
  `Home.ts`). With Presence M1 + M2 live, the card fades in/out instead
  of popping. Useful for eyeballing M3/M4/M5 changes too. Remove once
  Presence is fully polished.

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

**Engine core:** `Jwift/src/Core/`
- `Jwift.ts` — Canvas class, render loop, clip-stack walker
- `Clip.Stack.ts` — ClipShape type + per-frame accumulator
- `WebGPU.Renderer.ts`, `WebGL2.Renderer.ts` — GPU backends
- `Style.Resolver.ts` — JivStyle → JivRenderStyle (where `@var`
  resolution will live)

**Animation:** `Jwift/src/Animation/`
- `Animation.Manager.ts` — RAF loop, settle detection
- `Spring.ts` — spring physics
- `Presence.Manager.ts` — Presence springs + settle-then-remove

**JSS parser:** `Jwift/src/Jss/`
- `Jss.Parser.ts` — where `@var` needs to land
- `Jss.Routes.ts` — prop-name → slot routing

**Shaders** (edit source, regen via `npm run build:shaders`):
- `Jwift/src/Core/Shaders/` — WebGPU WGSL
- `Jwift/src/Jiv/Shaders/`, `Jwift/src/Text/Shaders/`,
  `Jwift/src/ProgressiveBlur/ProgressiveBlur.Shader.ts` — WebGL2 GLSL

**Demo:** `Jwift.Angular.Demo/src/Home/Home.jss` + `Home.ts`. Dev
server: `npm run dev` (port 6777).

**Design research** (next door, read-only):
`../show-studio/ShowStudio.Web/src/Libraries/Jwift/Shared/Research/`
— iOS 18 vs 26, Apple Media Player tokens, Apple app patterns,
concentric radius law, `Design.Guide.md` (canonical concentric formula
+ padding grid + text hierarchy).

**Show Studio reference implementation:**
`../show-studio/ShowStudio.Web/src/Libraries/Jwift/` (DOM-based `Jiv`
prototype of everything Jwift implements natively).
`../show-studio/ShowStudio.Web/src/App/Home/` (the home page Jwift is
porting).

---

## Key context a fresh agent should carry

1. **Jwift is an engine, Show Studio is the test customer.** Don't
   design for hypotheticals — everything must serve the Home page
   port.
2. **Concentric is non-negotiable** — every radius earns its value
   from its parent via `parent - gap`.
3. **Instant compute + spring motion** — discrete calculation, temporal
   animation. Spring state is the source of truth for visuals; the
   a11y/logic tree is the instant truth.
4. **"Everything animates"** — entry, exit, color, position, size.
   Hard pops are a bug.
5. **Vertical slices** — each feature (Glass, ProgressiveBlur, Clip,
   Presence) owns its full stack from shader to public API. Don't
   centralize types in a god-file.
6. **Read the spec before writing code** — `Specification.md`,
   `Features.md`, plus whichever feature-specific doc applies.
7. **Show Studio Design.Guide.md has the canonical numbers** —
   concentric formula, padding grid, text hierarchy, card tokens.
   Reference it for any visual authoring.
