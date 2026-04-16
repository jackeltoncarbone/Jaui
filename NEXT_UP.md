# Next Up

Handoff doc for the next agent picking this up fresh. Read top-to-bottom.

---

## Where we are

**Engine:** WebGL2 + WebGPU backends, both live. CSS-style overflow
clipping fully implemented — per-frame clip-stack buffer shared across
panel/text/progressive-blur shaders. Clip SDF matches the panel's own
superellipse so discard exactly traces the painted rounded-rect edge (no
halo drift at the clip boundary). `ParentOverflow: Inherit | Visible |
Hidden` on `ChildLayout` lets each child opt in or out of its parent's
clip.

**Demo:** `Jwift.Angular.Demo` renders the Show Studio home page. This
IS the migration target — not a throwaway. The visual skeleton is in;
fine details (card art, 3D hero, real data wiring) are what remains.

**Recent structural wins (this session):**
- ChromeFrame pattern: Toolbar + TabBar nest inside one Fixed
  full-viewport container with uniform 24 Padding and
  `Justify: SpaceBetween`. Uniform gap on all sides makes the concentric
  radius derivation unambiguous — one `ScreenBR` number drives the whole
  chain.
- Hero matches Show Studio's HeroContent (vertically centered,
  left-inset ~80, 36/600/1.15 title, pill CTA with optical padding,
  20px gap).
- Redundant JSS classes collapsed via multi-inheritance
  (`RowCompact : Row`, `CardCompact : Card`). `SectionCompact`
  (byte-identical to `Section`) deleted.
- Four repeated `@for` blocks consolidated into one data-driven loop via
  a `Sections` computed signal in `Home.ts`.

**Core design rules (non-negotiable, in CLAUDE.md + memory):**
- Concentric radii: `child = parent - gap`. Always.
- "Everything animates, no hard seams" — changes spring from current to
  target. Motion emerges from the delta.
- Layout/compute happens **instantly**; springs chase the instant result
  to create motion. Shadow DOM (accessibility) is the instant truth;
  render tree lags temporally via springs.

---

## In-flight: Presence system (specced, not implemented)

Full spec: `Jwift/src/Shared/Documents/Specifications/Presence.md`.

**Concept.** Every Jiv has a `Presence` spring (0..1). Rises 0→1 on
mount, falls 1→0 on leave intent. Node is only hard-removed from the
tree after the spring settles. Opacity, transform, offset — anything —
can be bound to `@Presence` in JSS and will animate automatically.

**JSS integration.** `@Presence` is a reserved built-in `@var` provided
per-Jiv. `@P` alias for brevity (both resolve to the same value).
Implicit `Opacity: @Presence` default when the author doesn't set
Opacity — every Jiv fades in/out unless opted out with `Opacity: 1`.

**Still-open policy calls in Presence.md** (close before implementing):
1. Hit testing during exit — does a Jiv at Presence=0.3 (leaving) still
   receive pointer events? Suggested: **no**, stop on `RequestLeave` to
   match the a11y-removes-immediately rule. Not yet written.
2. Default Presence spring params — picked Stiffness 220, Damping 26 in
   the spec draft; gentler Stiffness 170 / Damping 22 matches Apple feel
   better. Pick one.
3. `when(cond, a, b)` syntax — used in examples, then listed as out of
   scope. Clean the examples up to use pure arithmetic
   (`@Entering * -20 * (1 - @Presence)`) and drop the `when()`
   references until that syntax is specced separately.

**Dependency.** Presence resolution piggybacks on `@var` + arithmetic in
the JSS resolver. Without `@var` support in the parser, Presence is
just prose.

---

## Spec state of JSS language features

| Feature | Docs | Parser implements? | Notes |
|---|---|---|---|
| `@var name: value` + `@name` reference | Styling.md ✓ | **No** | Blocks Presence — needed first |
| Arithmetic + parens in lengths | Length.ts has grammar ✓ | Yes (in Length resolver) | `@Name + 4` type expressions need resolver wiring |
| `BorderRadius: concentric` keyword | Styling.md ✓ | **No** | User said skip — "designer's job to compute" |
| `@when Width > N { … }` | Styling.md ✓ | **No** | Needed for responsive hero padding etc. |
| `@spring Property { … }` | Styling.md ✓ | Yes | Works |
| `@style Foo : Base { … }` | Styling.md ✓ | Yes | Confirmed working in this session (RowCompact/CardCompact) |
| `@Presence` reserved var | Presence.md ✓ | **No** | Depends on `@var` machinery |
| `when(cond, a, b)` expression | Presence.md (draft) | **No** | Deferred |

---

## Backlog (priority order)

### 1. Close Presence.md spec gaps + add @P alias
30 min. Items 1-3 in the "in-flight" section above. Then the spec is
implementation-ready.

### 2. Spec `@var` + JSS arithmetic
Short spec, mostly already in Styling.md. Needs:
- Grammar for `@Name` reference (the Length parser already handles
  arithmetic; just needs `@Name` lookup into a var table).
- Where @var declarations live in the parse tree (top-level + nested?).
- How @var resolves against scope (lexical, dynamic via context?).
- Error behavior (missing var, circular refs).

### 3. Implement `@var` + arithmetic in parser
Files: `Jwift/src/Jss/Jss.Parser.ts`, `Jwift/src/Core/Length.ts` (resolver).
Gate to Presence implementation.

### 4. Implement Presence milestones M-Presence-1 through M-Presence-5
Specced in `Presence.md`. Progression:
1. `Element.Presence` field + spring + default 0→1 on mount.
2. `RequestLeave()` + settle-then-remove + framework binding change
   (`Jwift.Angular/src/Jiv/Jiv.ts` `ngOnDestroy`).
3. `@Presence` reserved var + resolver wiring + implicit Opacity
   fallback.
4. `@Entering` / `@Exiting` boolean flags.
5. `@spring Presence` override per-class.

### 5. "Get Started" CTA wrapping bug
In `Home.jss`, `HeroCta` renders "Get" / "Started" on two lines. CTA
shrinks to min-content (longest word) instead of max-content (full
label). Pre-existing, visible in every recent screenshot. Likely a
text-intrinsic-width bug in the flex solver. `Jwift/src/Layout/Layout.*`
and `Jwift/src/Text/Text.Measure.ts`.

### 6. Card background images (Home demo polish)
Show Studio cards have cover art, not flat colors. `Home.ts` has
`Background: c.Color` today. Replace with image-backed cards so the Home
demo matches Show Studio's home visually. Image + tint overlay pattern.
Check `Jwift/src/Image/Image.Cache.ts` for existing image support.

### 7. `@when` responsive rules
So the demo's hero padding can do mobile/desktop the way Show Studio's
`@media (min-width: 768px)` block does. Parser work.

### 8. Polish — lower priority
- `BackdropFrostBlur` per-Jiv: old NEXT_UP flagged this as broken. User
  reports it works for them now. Close ticket unless new repro.
- Scroll container clip: content behind tab bar should be clipped. The
  new overflow clipping should handle this — verify, fix if not.
- `"Renections"` glyph artifact on first render before
  `document.fonts.ready`. Cold-load repro needed.
- `<jiv>` inputs for `X` / `Y` to allow template-driven `Position: Placed`
  on floating chrome without imperative resize hooks.

### 9. Migration: continue the home page
Home IS the migration target per M7 in `Specification.md`. After card
art, the 3D reality-view region (the hero's eventual replacement) will
need Three.js integration via the "External Canvas Compositing" feature
in `Features.md` — not yet implemented.

---

## Where things live

**Specs:** `Jwift/src/Shared/Documents/Specifications/`
- `Specification.md` — architecture, pipeline, milestones M1–M7
- `Features.md` — every visual/interaction feature
- `Styling.md` — JSS language
- `Layout.md` — flex solver design
- `Presence.md` — entry/exit animation system (new this session)
- `Conventions.md` — code style
- `Examples.md` — target API

**Engine core:** `Jwift/src/Core/`
- `Jwift.ts` — main Canvas class, render loop, clip-stack walker
- `Clip.Stack.ts` — ClipShape type + per-frame accumulator
- `WebGPU.Renderer.ts`, `WebGL2.Renderer.ts` — GPU backends
- `Style.Resolver.ts` — JivStyle → JivRenderStyle (where @var resolution
  will live)

**JSS parser:** `Jwift/src/Jss/`
- `Jss.Parser.ts` — where @var needs to land
- `Jss.Routes.ts` — prop-name → slot routing (Style/Layout/ChildLayout/
  TextStyle)

**Shaders** (edit `.wgsl` / `.frag`, regen via `npm run build:shaders`):
- `Jwift/src/Core/Shaders/` — WebGPU WGSL
- `Jwift/src/Jiv/Shaders/`, `Jwift/src/Text/Shaders/`,
  `Jwift/src/ProgressiveBlur/ProgressiveBlur.Shader.ts` — WebGL2 GLSL

**Demo:** `Jwift.Angular.Demo/src/Home/Home.jss` + `Home.ts`. Dev server:
`npm run dev` in that dir, port 6777.

**Design research** (next door, read-only):
`../show-studio/ShowStudio.Web/src/Libraries/Jwift/Shared/Research/` —
iOS 18 vs 26, Apple Media Player tokens, Apple app patterns, concentric
radius law, Design.Guide.md (the canonical concentric formula + padding
grid).

**Show Studio reference implementation:**
`../show-studio/ShowStudio.Web/src/Libraries/Jwift/` (DOM-based `Jiv`
prototype of everything Jwift implements natively).
`../show-studio/ShowStudio.Web/src/App/Home/` (the home page Jwift is
porting).

---

## Uncommitted work-in-progress

- `Jwift/src/Shared/Documents/Specifications/Presence.md` — new spec.
  Commit.
- `Jwift/src/Shared/Documents/Specifications/Styling.md` — one-paragraph
  cross-reference to Presence.md in the Springs section. Commit.
- `Jwift.Angular.Demo/src/Home/Home.ts` — `ExtraCard` signal +
  `@HostListener('document:dblclick')` toggle that adds/removes a card
  in the Featured row. Kept as a visual probe for observing
  entry/exit behavior once Presence is wired up. Decide whether to
  commit as debug infra or revert.

---

## Key context a fresh agent should carry

1. **Jwift is an engine, Show Studio is the test customer.** Don't
   design for hypotheticals — everything must serve the Home page port.
2. **Concentric is non-negotiable** — every radius earns its value from
   its parent via `parent - gap`.
3. **Instant compute + spring motion** — discrete calculation, temporal
   animation. Spring state is the source of truth for visuals; the
   a11y/logic tree is the instant truth.
4. **"Everything animates"** — per user's persistent memory. Entry,
   exit, color, position, size. Hard pops are a bug.
5. **Vertical slices** — each feature (Glass, ProgressiveBlur, Clip,
   Presence) owns its full stack from shader to public API. Don't
   centralize types in a god-file.
6. **Read the spec before writing code** — `Specification.md`,
   `Features.md`, plus whichever feature-specific doc applies.
7. **Show Studio Design.Guide.md has the canonical numbers** —
   concentric formula, padding grid, text hierarchy, card tokens.
   Reference it for any visual authoring.
