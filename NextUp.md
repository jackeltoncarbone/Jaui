# Next Up

Handoff doc for the next agent picking this up fresh. Current as of **2026-06-03**
(Jiv-3D-native arc: taxonomy collapse + `<light>` element + shared scene lighting
just shipped and verified).

Read `Documentation/Jiv3D.md` FIRST — it is the canonical design spec for the
current direction. `Documentation/ThreeParityAndDepth.md` covers the screen/world
depth model. This doc is the operational state + next steps.

---

## Branches (all repos, as of this handoff)

| Repo | Branch | Remote |
|---|---|---|
| show-studio (root) | `jev` | (parent repo) |
| Jaui (submodule) | `jev` (created from detached `067aef7` this session) | github.com/jackeltoncarbone/Jaui |
| Jwift (submodule) | `jev` (created from detached `1f20b8f` this session) | github.com/jackeltoncarbone/Jwift |

Note: `ShowStudio.Web/src/Plan.md` at the root is untracked and NOT mine — left
uncommitted; another agent may own it.

## The mission (user's words, distilled)

One unified 3D UI framework. **Jiv is the one universal element and it is one
physical surface** — NO glass/solid/translucent classification, ever. Physical
attributes on continua (opacity, backdrop filter, refraction, thickness, fillet).
**Thickness is intrinsic**: every Jiv has it; 0 = "impossibly thin" sheet, not a
mode. One THREE scene; `Space: Screen|World` is transform/styling ONLY (never
segregation). **Lights are Jivs** (`<light>`), JSS-authored, lighting everything
(surfaces + meshes) from one shared set. Wants "rubbery frosted-glass /
frosted-paper sheets, small fillet, Apple radius, real presence" — performant AND
physically present, both. Mental model and code must match. Build the ideal now,
no legacy paths.

## What shipped this arc (all verified live on the demo)

1. **Material taxonomy collapsed** (`Source/Core/Style.Resolver.ts`,
   `Jiv.Types.ts`, `Jiv.Defaults.ts`, `Jaui.ts`, `Jiv.StyleAnimator.ts`,
   `Jiv.InstanceBuffer.ts`): `MaterialType` enum + `_inferMaterial` +
   Thickness→glass promotion DELETED. Replaced by attribute-derived
   `SamplesBackdrop` / `HasProgressiveBlur` booleans + one unified `Depth`
   (= Thickness + Elevation, both JSS names still authorable/animatable, both
   drive the one Depth). The StyleAnimator's discontinuous material-flip
   machinery is gone — depth animates continuously through 0.
   `Tests/Jiv.Material.test.ts` fully rewritten for the new model (14/14 pass).
2. **`<light>` element** (`Angular/src/Light/Light.ts`, exported from
   public-api): a Jiv subclass, selector `light`. JSS props on every Jiv:
   `LightType` (Directional|Ambient|Point|Spot|Area, '' = not a light),
   `LightColor`, `LightIntensity_` (trailing underscore avoids collision with the
   receive-side `LightIntensity`), `LightDirection` ('x y z'), `LightRange`,
   `LightConeAngle`, `LightPenumbra`, `LightCastShadow`. Resolver builds
   `RenderStyle.Light: ResolvedLight | null` (`_resolveLight` in Style.Resolver).
3. **Shared scene lighting** (`Jaui.ts` `_collectLights` pre-pass →
   `Renderer.SetSceneLights` → `Three.Renderer.ts`): every frame, light Jivs are
   gathered (world pos from solved layout) BEFORE any draw; the renderer syncs a
   pool of real `THREE.Light`s (for World/Janvas meshes) + drives the surface
   shader. Directional lights feed `u_SceneLightDir/Color/Int/On` (bevel + face
   shading); Point/Spot additionally drive the positional sheen
   (`u_LightPos/Strength/Radius`, clamped — feeding a Directional into the sheen
   washes the screen white; that bug is fixed). Ambient lights sum into a
   `THREE.AmbientLight`. No lights ⇒ default ambient (nothing goes black).
4. **Slab presence**: PANEL_FRAG's `elevation>0` bevel block now lights from the
   scene light (`u_SceneLightOn` selects scene light vs per-instance LightAngle
   fallback) + a depth-scaled whole-face shade. With the demo's
   `<light class="KeyLight">` (Directional, warm, upper-right), deep slabs
   visibly catch light on their bevels; drop shadows scale with depth.
   Continuity invariant verified: Depth-0 slab pixel-identical to flat.
5. **Demo state** (`Examples/Angular/src/Home/`): Home has a temporary `ThickRow`
   slab strip (Slab0..3, Elevation 0/8/20/40 + fillets + shadows) as the live
   proving ground, plus the `KeyLight`. REMOVE the strip when presence tuning is
   done (or keep as showcase if user wants).

## Critical operational gotchas (will eat hours if unknown)

- **STALE-SERVING TRAP (worst one):** if the Angular build fails to compile,
  `ng serve` silently keeps serving the last-good bundle — screenshots stop
  reflecting edits and you chase phantoms. Lib `tsc` does NOT compile
  `Angular/src/public-api.ts` (a stale re-export there broke the build invisibly
  for an hour). ALWAYS check the ng serve output for `ERROR` vs
  `Application bundle generation complete`, or run a fresh `ng serve` on a new
  port to surface errors. When the build is green, the watcher DOES pick up
  `Source/` changes fine.
- Worker-source edits need `Examples/Angular/src/app/jaui.worker.ts` touched to
  force the worker chunk rebuild (HMR misses it).
- Playwright: full-page `page.screenshot` at deviceScaleFactor 1 ONLY (clipped
  and 2× shots hang on the animating canvas). Race `document.fonts.load` against
  a timeout (it can hang headless; serif/tofu in shots = headless font quirk,
  fonts are fine in real browsers). Verify with code reasoning first, screenshot
  once at the end (user preference).
- Two dev servers existed at handoff: the user's long-running `ng serve` on
  **:6777** (was serving the stale bundle — needs restart to pick up this work)
  and my fresh verified one on **:6779** (background task; may be dead by the
  time you read this — start your own: `cd Examples/Angular && npx ng serve
  --port 6779`).
- Angular demo is THE test surface (user directive). Don't use the Vanilla
  corpus. Scope vitest runs to what you touched.
- The user's standing rules: execute decisively, don't ask A/B questions, no
  commits/pushes without fresh permission, shared worktree (no stash/destructive
  git), minimal comments-style, PascalCase, point-first JSS (bare number = pt;
  1pt = 16px; ratios/material scalars resolve literal via `ResolveScalar`).

## Known remaining work (task list lives in session, mirrored here)

1. **Presence tuning** — bevels read but subtly; user wants "rubbery frosted
   paper". Iterate bevel strength/width, face shade range, shadow defaults;
   consider frost-on-slab (SamplesBackdrop + Depth together) for the
   frosted-sheet look. The mechanism is proven; this is aesthetics.
2. **Shader unification (cleanup)** — PANEL_FRAG vs GLASS_FRAG still two GPU
   programs selected by `samplesBackdrop` (under-the-covers only — fine per
   user). Eventually fold into one surface shader where every term scales to
   zero at default. `GLASS_FRAG`'s `materialType` branches are now dead-ish
   (glass batch always materialType==1) — safe to simplify.
3. **Pluggable cross-section shape** — Jiv footprint as a base-path/SDF attribute
   (NOT clip); default = current superellipse box→pill→circle. See Jiv3D.md
   "shape as an attribute".
4. **Volumetric frost + spatial child containment** — progressive blur becomes a
   participating medium with real Z depth; children live INSIDE the parent slab
   (between back/front face), hazed by fog-depth traversed (Beer-Lambert over Z),
   not paint order. See Jiv3D.md "frost/blur is volumetric". Big arc; depends on
   the lighting/depth foundation that now exists.
5. **More light kinds** — Point/Spot THREE-side exist crudely (pool is all
   DirectionalLight currently — make kind-correct THREE.PointLight/SpotLight),
   Area + Environment/IBL (scene.environment for reflections) not started.
   Multi-light surface shading (currently dominant-light-only on surfaces).
6. **pt-flip test debt** — ~25 pre-existing failures (Length/Layout.Attach/
   Text.Layout/StyleAnimator.Animation tests) assert old bare-number=px values;
   the unitless→pt (×16) flip invalidated them. Update assertions (use explicit
   `px` or expect ×16). NOT from this arc's changes.
7. **Home polish (Show Studio)** — hero recognizability (field/marchers idea),
   scroll feel, nav color-outline tuning (ChromaticAberration now 0), volumetric
   "Disney World" inline 3D content once the framework supports it.

## My current thoughts / judgment calls made

- Depth = Thickness + Elevation **summed** (not max) — both names kept authorable
  on purpose; could collapse to one JSS name later but the user values authoring
  continuity.
- A light Jiv early-returns from the paint walk (`Jaui.ts` renderNode) — it has
  no surface. If a light should ALSO paint (glowing panel), that's a future
  attribute (`LightType` + visible body); trivial to add by removing the early
  return behind a flag.
- `LightIntensity_` naming is ugly (collision with receive-side LightIntensity).
  Consider renaming the receive-side prop to `SurfaceLightIntensity` or similar
  in a follow-up — but that touches existing JSS/docs.
- The positional-sheen clamp (intensity×0.3 max 0.6, radius default 700) is a
  taste call — revisit with the user during presence tuning.
- I did NOT touch the frozen `Jaui Copy/` golden reference (OneDrive). 2D parity
  harnesses (`Tests/Compare.mjs` etc.) still reference it as oracle.

## Open questions for the user (ask when relevant, don't block)

- Should the slab strip stay in Home as a permanent material/lighting showcase
  row, or be removed once tuning lands?
- Frosted-paper look: how much frost should a thick OPAQUE sheet have by default
  (frost currently requires explicitly setting BackdropFrostBlur — should Depth
  imply a touch of edge frost)?
- Multi-light on surfaces: dominant-light-only is cheap and looks fine for one
  key light — is N-light surface accumulation worth the fragment cost now, or
  after the volumetric arc?
- Keep `Elevation` as an alias forever, or deprecate toward a single `Thickness`?

## How to verify your changes (closed loop)

1. `npx tsc --noEmit -p tsconfig.json` (lib) AND `cd Examples/Angular &&
   npx tsc --noEmit` (demo types) AND watch the ng serve output compiles.
2. Touch `Examples/Angular/src/app/jaui.worker.ts` if you changed `Source/`.
3. One full-page Playwright shot at dsf 1 against the demo; compare against the
   continuity oracle (flat Jivs unchanged) + whatever you intended to change.
4. `npx vitest run Tests/Jiv.Material.test.ts` (the no-taxonomy contract) +
   scoped tests for whatever you touched.
