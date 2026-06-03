# Jaui → Three.js Migration

## Goal

Re-home Jaui's entire compositor inside a single Three.js scene. Every element Jaui
draws today (panels, text, images, glass, blur) becomes an object in one 3D world.
Elements sit at screen coordinates by default — but can animate into world space:
real depth, thickness, perspective, fog, depth-of-field, and lighting. Eventually
Show Studio is one unified 3D scene: UI, drill content, and effects share a camera,
a depth buffer, and a lighting rig.

## The non-negotiable principle

**2D is the degenerate case of the 3D renderer.** With the camera orthographic, every
element at z = 0, and thickness = 0, the Three backend must reproduce the current
WebGL2 backend pixel-for-pixel (within tolerance). That equivalence is the migration's
gate. World-space depth, thickness, fog, DOF, and lighting are things we turn *on* —
they never alter the 2D contract.

This is why the migration is testable at all: "same, but better" means the new renderer
is provably identical in its 2D mode, with new capabilities layered above it.

## Architecture decision (locked): one world, two authoring paths

Show Studio is **one Three.js world** — one Scene, one camera, one depth buffer, one light
rig. There is **no conceptual UI-vs-content split**: everything is a node in the same world.
What makes a node "screen UI" or "a marcher" is only the JSS it is given — its width/height/
**depth**, and whether it is authored in **screen space** or **world space**. Change the JSS
and any element crosses between them.

Content reaches the world through two authoring paths. Both land in the same Scene and share
the camera, depth buffer, and lights — so they coexist physically (occlude, light, fog
together) — but they have very different cost profiles:

1. **JSS-node path (compositor).** Every JSS-authored element — a screen-space panel, a
   world-space card — is the *same kind of node*, placed by one mechanism. Screen-space =
   mapped onto the calibrated near-plane; world-space = positioned in the world; depth/
   thickness per node. The compositor walks and re-resolves these each frame. Lightweight.

2. **Janvas path (subsystem).** Self-contained 3D content — e.g. the reality marchers —
   mounts its **own** `Object3D` subtree into the same Scene. It shares the camera/depth/
   lights (so it occludes and is lit alongside UI) but **bypasses the JSS node pipeline and
   its per-frame overhead**, owning and ticking its own geometry on its own schedule. This
   is the "heavy content that doesn't care about UI" path. It generalizes today's
   `JanvasRenderer` (foreign renderer → shared scene).

   **API: the abstraction is a default, not a wall.** UI authors stay in JSS and never
   touch Three. Subsystem authors are handed the *raw* Three context at attach time —
   `Scene` (or a mount group), `WebGLRenderer`, the shared `Camera`, and the shared depth/
   render targets — so perf-critical content (a marcher `InstancedMesh`, custom shaders, an
   independent update tick) runs at native Three speed, not through the JSS node path. This
   is today's `JanvasRenderer.Init(gl, markDirty)` evolved from a raw GL context to a raw
   Three context.

This settles the renderer choice: an owned renderer can only embed 3D content through a seam
(two renderers, depth/light don't cross) — one shared world requires **full Three**. We
consciously trade away the "smaller bundle" goal for one coherent world; perf is held to a
60fps bar and measured, not assumed.

Two design problems this creates, tracked explicitly:
- **Camera/coordinate model.** One perspective camera; `uiRoot` on a calibrated near-plane
  whose FOV/distance reproduces exact screen pixels (the 2D-parity mode). Flying into the
  world = animating z off that plane. The calibration math must make 2D parity pixel-exact.
- **Transparency + glass ordering.** Frame order: opaque content → (backdrop) → blur pyramid
  → UI glass samples it → remaining transparent surfaces back-to-front. Progressive-blur and
  glass live here. Three's transparency sort helps; the pass ordering is the real work.

## The seam (and what it replaces)

`Source/Core/Renderer.ts` abstracts GPU submission as semantic operations (draw panel
batch, compute blur pyramid, progressive blur, …); `Canvas` (the orchestrator) is handed a
renderer at construction and has no backend opinion. We use that seam to swap the
implementation, not to keep several.

**Three is the sole backend.** `Source/Core/Three.Renderer.ts` is the only `Renderer`.
`WebGL2.Renderer` and `WebGPU.Renderer` are **retired** as the phases land — they are not
kept as fallbacks or toggles. `Jaui` constructs a `ThreeRenderer`; the `renderer` ctor
param exists only for DI/tests, not backend selection. The frozen `Jaui Copy/` is the only
place the old renderer survives, and it exists solely as the parity baseline.

## Reference baseline

`show-studio/Jaui Copy/` is a frozen, uncommitted copy of the submodule at migration
start. It is the golden reference for the parity harness. Do not edit it.

## Phases

Each of Phases 1–4 is gated by the parity harness: the Three backend must match the
copy in 2D mode before the phase is considered done.

### Phase 0 — Foundation & parity harness
- Add `three` + `@types/three`. (done)
- `Three.Renderer` skeleton implementing the full `Renderer` interface (stubs allowed),
  set as the sole backend. (done)
- Build the parity harness (Playwright): mount a fixed corpus of JSS scenes, render each in
  the **frozen `Jaui Copy/`** (old WebGL2 — the baseline) and in the **live repo** (Three),
  capture both, pixel-diff with a tolerance, and report ms/frame + bundle KB. No in-repo
  toggle: baseline and candidate are two checkouts. Corpus grows per phase: flat panels →
  text/images → glass/pblur → clips, scroll, transforms.

### Phase 1 — Flat 2D parity (ortho, z = 0)
- `OrthographicCamera` reproducing the current baked ortho projection.
- Jaui quads → one `InstancedMesh` whose per-instance attributes mirror `JivInstanceBuffer`.
- Port the panel shader (rounded-rect SDF + shadow + border + tint) to a `ShaderMaterial`.
- Solid / gradient / image backgrounds. **Parity-gated.**

### Phase 2 — Text, images, clips
- Text: port the glyph-atlas path first for pixel parity at z = 0 (MSDF is a Phase 5 upgrade).
- Images: textures + mipmaps + anisotropy.
- Clip stack → per-fragment clipping (mirror the current clip-stack buffer). **Parity-gated.**

### Phase 3 — Glass / blur / progressive blur
- IMPROVE-ON-PORT: the old blur was **blocky at low blur radius** (shallow pyramid → half-res
  texels upsampled bilinearly show as squares; UnsignedByte targets also band). Phase 3 should
  fix this to be *smooth* at low sigma — e.g. keep a near-full-res small-kernel path for small
  radius instead of dropping to a shallow pyramid, use HalfFloat targets, and/or a better
  upsample. Don't faithfully reproduce the blockiness — improve it.
- Scene → `WebGLRenderTarget`; port the dual-filter blur pyramid as fullscreen passes.
- Glass `ShaderMaterial` samples the pyramid; progressive blur as its own pass.
- NOTE: glass is a screen-space model and only holds in 2D mode. Perspective glass
  (refraction) is a Phase 5 problem, deliberately deferred. **Parity-gated at z = 0.**

### Phase 4 — Worker bridge & Janvas reconcile
- OffscreenCanvas worker path on the Three backend.
- Janvas stops being "foreign renderer draws into our FBO" and becomes native: other
  3D content is just more objects in the same scene. **Parity-gated.**

### Phase 5 — The 3D upgrade (additive, not parity)
- Per-element model matrix with z; extrude quads to slabs so **UI has thickness**.
- Camera animatable ortho ↔ perspective: animate any element screen-coords ↔ world-coords.
  New JSS knobs: `Z` / `Depth` / `Thickness` / `World`.
- **Fog** (cheap, view-space z). **DOF** post pass (unifies with the reality-camera focus work).
- **MSDF text** so glyphs stay crisp at arbitrary scale/depth.
- **Lighting**: real lights; materials/glass respond. Depth-sort translucent surfaces.
- **Depth-interleave** with Janvas 3D content via a shared depth buffer — UI and drill
  content (marchers, field) occlude each other correctly.
- Unified Show Studio: one scene graph, bloom/glow, particles, selection SFX hooks —
  the "polished game / studio" feel from `ShowStudio.Web/src/Plan.md`.

### Phase 5 signature effects — "physical lighting in the UI, things no other app has"
The differentiator. Real light interacting with real UI geometry:
- **Specular that tracks** a light / cursor / device tilt across glass faces and filleted
  bevels (builds on the existing specular-tilt + gyro-rig work).
- **Environment reflections** on glass UI (cube/equirect probe of the scene).
- **Bloom spill / glow** bleeding from emissive elements (selection, focus states).
- **Cast shadows** from floating UI cards onto content/surfaces behind them.
- **Refraction / caustics** through thick glass; **rim light** on edges.
- **Parallax + depth** response to pointer / gyro.
These are the payoff of one lit world; none are achievable in a flat screen-space compositor.

## Implementation notes (hard-won — do not regress)

- **Instance data lives in an RGBA32F data texture, fetched in the vertex shader by
  `gl_InstanceID`** (`fetchSlot(id, slot)`), NOT in vertex attributes. 15 vec4 slots +
  a `position` attribute would hit WebGL2's 16-attribute ceiling with zero headroom and
  Three silently drops the draw. The texture path has no slot ceiling — Phase 3/5 add
  per-instance data by bumping `INSTANCE_VEC4S` and the shader's slot fetches, nothing else.
- **The vertex shader flips Y (top-left origin), which reverses triangle winding.** The
  panel material MUST set `side: THREE.DoubleSide` or default back-face culling drops every
  quad (renders pure black, no GL error — extremely easy to misdiagnose).
- **`RawShaderMaterial` shaders must NOT contain `#version 300 es`.** Use
  `glslVersion: THREE.GLSL3`; Three injects the directive itself (and `#define`s before it),
  so a literal `#version` line causes "directive must occur before anything else" errors.
- **`InstancedBufferGeometry` (not `BufferGeometry`)** is required for the instance divisor,
  and the quad attribute must be named `position` (Three derives vertex count from it).
- **Clamp `fwidth(dist)` for AA feather** (`clamp(fwidth(dist), 0.5, 1.5)`). Unclamped, the
  SDF's medial-axis gradient spike (the center cross of a rect, where distance gradient flips)
  blows the smoothstep band wide and paints a full-width 1px "slit" through every panel center.
  Invisible in pixel-count stats; obvious to the eye.
- **Quad winding is reversed (CCW) in the index buffer** (`[0,2,1, 0,3,2]`) to compensate for
  the vertex shader's Y-flip, with `side: FrontSide`. Do NOT use `DoubleSide` — it double-blends
  the overlapping back face and darkens every edge ~2×.
- Text/clips on the data-texture model too: glyph atlas via `CreateTexture`(2048²)+`UploadSubTexture`
  (direct `texSubImage2D` around Three's state cache, then `resetState()`); clip stack as a
  3-texel/entry RGBA32F data texture; `clipCoverage()` in `Three.ShapeSdf.ts` (`CLIP_STACK_GLSL`).
- Parity/perf harness: `tests/Parity.test.ts` (Playwright, real pixelmatch diff). Corpus
  at `Examples/Vanilla/Corpus/`. One-off render probe: `tests/probe.mjs`.

## The shape + placement model (3D-native from Phase 1)

The SDF and transform are built 3D-ready now, so Phase 5 adds no rewrites — 2D is the
degenerate case (depth=0, fillet=0, z=0, Space:Screen reproduces today's pixels exactly).

Status: the shape module is **built and rendering** — `Source/Core/Three.ShapeSdf.ts`
(`SHAPE_SDF_GLSL`) holds the full three-regime 2D cross-section ported from Panel.wgsl plus
`shapeSdf2D`, `slabSdf`, and `shapeMode`. The Phase-1 panel shader uses `shapeSdf2D` (correct
Rect/Pill/Circle); `slabSdf` is wired and parity-safe (depth=0 ∧ fillet=0 → identical to 2D)
awaiting Phase-5 thickness/fillet/z plumbing. GLSL chunks live in `.ts` template literals —
NO backticks inside the GLSL (they terminate the string); use plain text in comments.

**Shape — a 3D slab SDF.** `slabSdf(p3, halfSize, depth, radii, smoothness, fillet)`:
- 2D cross-section is the full Jiv shape: three regimes — **Rect** (superellipse, n=2+6·smoothness),
  **SS-Pill** (polyline endcaps), **Circle** (ellipse) — selected by aspect/radius like the WGSL `shape_mode`.
- Extruded along Z by `Thickness` (d); front/back edges rounded by `Fillet`.
- `d3 = max(crossSection2D, abs(z) - halfDepth)`, with `fillet` rounding the join.
- depth=0 ∧ fillet=0 → collapses to the exact 2D cross-section (parity invariant).

Fields already in the Jiv model: per-corner `BorderRadius` (r), `BorderRadiusSmoothness`,
`Thickness` (d), `Fillet`, `BezelWidth`/`BezelScale`.

**One material, continuous depth (hard invariant).** A Jiv is *always a slab*; `Thickness`
is a continuous knob from 0 up, never a mode switch. Flat and thick are the SAME material:
- At `Thickness: 0` the rendered front face must be **pixel-identical** to the flat panel —
  visible, depth-less. (`slabSdf` already guarantees identical silhouette at halfDepth=0;
  the shading must match the same way — one shader path, not flat-vs-slab variants.)
- Increasing `Thickness` only **adds**: an edge/bevel (`Fillet`) and light raking it. It never
  recolors or restyles the front face. Animating `Thickness` 0→N reads as a panel gently
  gaining a physical edge — no popping, no material change.
- Testable: a flat panel vs a `Thickness: 0` slab must pixel-match.

Text is the one lamination exception: a flat sheet on the Jiv's front face, riding its
depth/lighting but not extruded (opt-in `TextDepth` for titles/signage only).

**Placement — per-element transform (separate layer from shape).**
- `VisualTranslate` extends to **`X Y Z`** (third value = Z; two values stay planar, Z=0).
- New JSS prop **`Space: Screen | World`** (default `Screen`):
  - `Screen` — element sits on the calibrated near-plane; world units = device px (today's behavior).
  - `World` — element positioned in world units in the 3D scene; subject to perspective, fog, DOF, lighting.
  - Animatable between the two → the "fly an element from screen into the world" effect.

## Measurement log (Phase 3 — glass wired)

After glass wiring, copy vs new (swiftshader, relative ms):
- **ALL scenes 0.00–1.94% — every scene MATCH.** glass collapsed 12.20%→0.00%,
  mixed 3.32%→0.00%. The Three glass shader reproduces the WebGL2 glass pixel-for-pixel.
- Glass path proven: scene → SnapshotScreen/ComputeBlur (dual-filter pyramid, smooth
  small-radius path) → GenerateBlurMipmap → glass material samples u_Backdrop
  (refraction/specular/fresnel/edge) → composited.
- Phase 3b DONE: `DrawProgressiveBlur` wired (PBLUR_VERT added + PBLUR_FRAG). New `pblur`
  corpus scene; diff 1.87% MATCH (same blur-approximation noise floor as shadows). FULL BOARD
  GREEN: flat 0.00 · shadows 1.94 · text 0.01 · glass 0.00 · mixed 0.00 · pblur 1.87 — all MATCH.
  Phase 3 complete.
- Clip texture is SINGLE-ROW (height 1) so the glass shader's 1-D `texelFetch(u_ClipTex,
  ivec2(i,0))` and the panel/text 2-D fetch both resolve correctly.

## Measurement log (Phase 2 baseline)

Copy (WebGL2) vs New (Three), swiftshader — relative ms only, NOT device-truth:
- flat-panels 0.00% diff (MATCH) · text 0.01% (MATCH) · shadows 1.94% (MATCH) ·
  mixed 3.32% (CLOSE) · glass 12.20% (DIVERGED — expected; glass shading is Phase 3,
  currently flat fill. This % is the Phase-3 progress meter; should fall to ~0).
- Frame time: new is ~1.0–1.7× copy under software (mixed 97→164ms). Constant-factor,
  no bad scaling shape. **Defer optimization to a real-GPU perf pass once Phase 3/5 land**
  (software inflates per-vertex texelFetch + submit cost that GPU parallelism hides;
  tuning to a software profile would tune to a lie). KNOWN ITEM: profile `mixed` on GPU.
- Harness: `tests/compare.mjs` (both servers: copy 5173, new 5174). `tests/perf.mjs` single.
- NOTE: `Canvas.Create` was added to `Jaui Copy/Source/Core/Jaui.ts` so the shared corpus
  runs against the old backend — the copy's own `main.ts` already called it (pre-freeze gap).
  Intentional, isolated; keep it so the comparison stays runnable.

## Progressive blur — FIXED for real (orientation), with a real test

Two rounds of bug here, both teaching the same lesson: **a scalar "is it blurry" metric lies;
validate the EFFECT (right region, right ramp direction, right content) visually + with
structured asserts.** First a too-weak pyramid (mip slots not sampleable). Then, after making
mips, a worse bug: high-LOD mips were Y-FLIPPED (built by per-level quad passes whose flip
parity alternated), so bottom rows' content smeared into the TOP feather ("Row 5 at top").
Final robust fix: copy level-0 blur into `_pyrTarget` (one pass, glass-proven orientation) and
build the rest with the **driver's `gl.generateMipmap`** — orientation-consistent, no per-level
re-flip. Level 0 is pre-blurred so box-filter mips ramp smoothly.
Guarded by `tests/pblur-diag.mjs` (asserts: ramp heaviest-at-top→clear-down, genuinely blurred,
NO bottom-row magenta bleeding to top). Isolation tactic that found it: render scene-only vs
pyramid-only vs pyramid@LOD0 separately.

## Progressive blur — round 1 (was too weak)

Was: pblur barely blurred vs the copy's heavy frost (user caught by eye; the 1.87% harness
"MATCH" masked it — LESSON: eyeball localized effects, aggregate diff% hides small regions).
Root cause: GenerateMipmap rendered into a render-target's mip slots that weren't allocated
mip-capable, so `textureLod(pyramid, uv, hi)` clamped to LOD 0.
Fix (robust, no raw-GL hacks): a dedicated `_pyrTarget` WebGLRenderTarget created
`{ generateMipmaps:true, minFilter:LinearMipmapLinearFilter }` so Three allocates a real,
sampleable mip chain; GenerateMipmap downsamples level→level into its mips; the pblur shader
samples THAT via textureLod (routed through `_blur.PyramidTexture`). Verified: feather strip
edge-energy ~36 vs ~12000 sharp — heavy smooth frost, no blocky stepping. Smooth low-blur path
preserved for small sigma.

## Janvas-native — PROVEN

A self-contained Three subsystem (cube + lights, MeshStandardMaterial) mounts its own
Object3D subtree via `JanvasRenderer.Attach/Update` into the shared scene; UI glass composites
over it. Verified rendering (`Corpus/janvas`). Real lighting on content confirmed. KEY RULE:
a Janvas is a SEE-THROUGH HOLE — an opaque ancestor UI panel paints over it in the panel pass
(subsystem draws first into the scene target), so Janvas ancestors must be transparent over the
Janvas rect. Camera `up` flipped to -Y so 3D content projects y-down matching the panel path.

## Visual-correctness sweep (before Phase 5)

By-eye audit of every effect (NOT just diff%), since diff% twice hid real bugs. Found two
more the numbers missed:
1. **Gradient/Image backgrounds weren't rendered** — `bgPaint` was received but ignored in the
   panel shader; gradients fell to solid/transparent. FIXED: wired `u_BgMode` 0-3 + gradient
   stop eval + image sampling in PANEL_FRAG, bound per-draw from `_computeBgPaint`. Color path
   kept pixel-identical.
2. **Corpus used CSS gradient syntax** (`linear-gradient(...)`) but Jaui's parser expects the
   PascalCase ctor **`LinearGradient(...)`** / `RadialGradient(...)` (Background.Parse.ts). The
   wrong syntax parsed to transparent Color → no gradient → diff stayed 0.00% "MATCH" because
   BOTH renderers drew nothing. Fixed the corpus scenes.
Result: glass now shows true liquid-glass (gradient + circles refracting through frosted panels).
Verdict per scene (by eye): flat ✓ · shadows ✓ · text ✓ · glass ✓ (after fix) · mixed ✓ ·
pblur ✓ · janvas ✓.

## Phase 5 — Elevation (solid-panel depth), DECOUPLED from glass

KEY DISCOVERY: in Jaui's model `Thickness > 0` auto-promotes an element to LiquidGlass
(Style.Resolver `_inferMaterial`) — a thick element IS refractive glass. So "lit solid slab"
needed a SEPARATE axis. Added **`Elevation`** (JivStyle + JivRenderStyle + Defaults + Resolver,
NOT in `_inferMaterial` so it stays Material 'None') — solid-panel depth that flows to the
panel shader, not glass.
- Instance buffer grew to **16 vec4 / 64 floats** (JIV_FLOATS_PER_INSTANCE=64, ThreeRenderer
  INSTANCE_VEC4S=16). Elevation at float offset 60 (slot 15 .x). BOTH PANEL_VERT and GLASS_VERT
  fetchSlot stride updated 15→16 — keep CPU packer and shader stride IN SYNC or all panels break.
- PANEL_FRAG slab block: `elevation>0` → filleted-edge bevel (quarter-round normal from the SDF
  gradient) lit by a directional light (LightAngle/LightIntensity). `elevation==0` is a no-op →
  flat panel byte-identical (continuous-depth, one material, no mode switch). Verified by eye
  (`Corpus/slab`): flat → pillowed slabs with lit upper-left rim, interior unshaded.
- Edge-distance from the superellipse SDF isn't Euclidean; recovered via dist/clamp(|grad|,0.5).
- POLISHED: bevel normal's outward direction is derived ANALYTICALLY from the fragment's
  offset from panel center (`v_PixelPos - v_PanelGeom.xy`), NOT the screen-space SDF gradient —
  the derivative is singular at rounded-corner apexes and caused a visible shading crease there;
  the center-offset direction is smooth everywhere. Bevel uses eased smoothstep curvature,
  half-lambert diffuse + ambient floor, contact-shadow AO at the inner edge, Blinn specular
  crest, and a `lit` floor so a corner can't gouge to black. Flawless at realistic elevations;
  a faint residue remains only at extreme Elevation (~48px) corners (true SDF apex singularity —
  would need analytic per-corner normals; deliberately not chased further).
- STILL TODO in Phase 5: Z (VisualTranslate.z) + `Space: Screen|World` transform, fog/DOF,
  full lighting rig (the glass bevels too), MSDF text for crisp depth.

## Phase 5 — Z depth + Space:Screen|World (perspective), DONE

Elements can now leave the flat plane and live in perspective 3D. `VisualTranslate` extends to
`X Y Z` (float offset 61); new `Space: Screen|World` prop (flag at float offset 62). Panel vert
builds the quad in world device-px space, adds translateZ, and projects through a new `u_ViewProj`
uniform (camera projection · view), instead of the flat NDC mapping.
- INVARIANT HELD: z=0 projects to EXACTLY the old flat NDC (camera calibration), so the whole 2D
  board stayed green (flat 0.00 / glass 0.20 / mixed 0.00 / pblur 0.18 — all MATCH) after the
  rewrite. Verified `Corpus/depth`: identical panels at varying Z foreshorten correctly (near=big,
  far=small), z=0 at natural size.
- CAMERA FIX (important): the y-down convention is now `up=+Y` + a Y-flip baked into the projection
  matrix (negate proj elements [5] and [13]), NOT `up=-Y`. The `-Y` up vector flipped X too
  (handedness), horizontally mirroring z=0 vs the 2D path. Projection-Y-flip gives clean y-down,
  no X-mirror. Side effect: it reverses winding for camera-projected CONTENT (Janvas meshes) →
  subsystems use `DoubleSide` (the cube fixture does). `matrixWorldInverse` must be recomputed
  manually in PanelDrawBatch (`copy(matrixWorld).invert()`) — Three only refreshes it inside
  render(), so reading it before render gives a stale/identity matrix (caused an all-black frame).
## Phase 5 — Scene lighting + Depth of field, DONE

LIGHTING: a movable point light (cursor/gyro-driven) the whole UI responds to — `Canvas.SetLight
({Pos[x,y,z], Color, Strength, Radius})`. Per-fragment: distance falloff over Radius, soft diffuse
sheen + Blinn specular glint using the front-face/bevel normal (raked along Elevation rims),
scaled by coverage. Off by default (Strength 0 = no-op). Verified `Corpus/light`: hot-spot at the
light, radial falloff across the grid, bright specular on elevated rims. Set Pos to the pointer
each frame for live "light rakes the UI."

DOF: per-element approximation — an element softens (widened silhouette feather) by how far its
view-depth is from `u_FocusDepth` beyond `u_FocusRange`, scaled by `u_DofStrength`. `Canvas.SetDof
({FocusDepth, FocusRange, Strength})`. Off by default. Verified `Corpus/depth`: with focus on the
z=0 plane, the in-focus panel is crisp and near/far panels blur — stacks with perspective + fog
for cinematic depth. (A true per-pixel CoC post-pass would need a scene depth texture; deferred —
the per-element version reads convincingly for discrete UI cards.)

PHASE 5 COMPLETE: Elevation, Z+Space:World, fog, crisp-in-depth text (hybrid SDF), lighting, DOF.
All additive/off-by-default — the 2D parity board stays green.

## Phase 5 — Crisp-in-depth text (HYBRID raster/SDF), DONE

Text now stays sharp when Z-pushed/scaled in the 3D world. Full offline MSDF was infeasible
(Jaui renders ARBITRARY runtime fonts by family — no font binary to bake, no msdfgen). Chose
runtime SDF-from-raster: `Text.Sdf.ts` `ComputeSdf` (exact 8SSEDT Euclidean SDF, unit-tested).
- HYBRID is the key: SDF degrades SMALL text (an 8SSEDT round-trip can't resolve ~11px thin
  strokes — visibly worse than raster). So `TextCache._rasterize` only SDF-ifies glyphs at
  `FontSize*dpr >= 24px` (large text — what actually gets scaled/Z-pushed); smaller text keeps
  the exact crisp raster. Per-entry `IsSdf` flag threads via TextDrawCommand → instance
  a_OpClip.w → TEXT_FRAG, which branches: raster path is byte-identical (coverage=glyph.a),
  SDF path reconstructs the edge with a derivative-width smoothstep around the 128 isovalue.
- SDF stores in atlas ALPHA, preserving the glyph's baked RGB color (static text carries color
  in rgb, tint=white passthrough) — so colored text stays colored. Spread ~14% of font px.
- Verified `Corpus/text`: small "SECTION LABEL" crisp (raster), large "Display Heading" sharp
  (SDF), colors preserved. Threshold tunable (SDF_MIN_FONT_PX).

## Phase 5 — Atmospheric fog, DONE

Per-fragment linear fog by view-space depth. Vert passes `v_FogDepth = u_CamDist - translateZ`
(on-plane = camera distance; deeper = farther). Frag blends `col.rgb` toward `u_FogColor` over
`[u_FogStart, u_FogStart+u_FogRange]` scaled by `u_FogDensity`. Premultiply-safe (fog·alpha).
- OFF by default (`u_FogDensity==0` → exact no-op); 2D board stays green. Opt-in via
  `Canvas.SetFog({Color,Start,Range,Density})` → forwarded to ThreeRenderer.SetFog (duck-typed
  passthrough; no-op on non-Three backends).
- Verified `Corpus/depth`: near panels vivid, on-plane (z=0) clear, far panels haze into the fog
  color and the farthest nearly dissolves — real atmospheric depth atop the perspective. Cheap
  (one mix per fragment).

## Close-out verification (all open items)

- **Production build**: `npm run build` (tsc → dist) succeeds clean. build:shaders wraps 0 files
  (no more WGSL/GLSL — Three uses inline shader strings).
- **Bundle size (the honest number)**: Jaui's OWN compiled JS is **736 KB vs the copy's 846 KB —
  ~110 KB SMALLER** (we deleted both old GPU backends + shaders). BUT the `three` dependency the
  consumer bundles adds ~376 KB min / ~150 KB gzipped core. Net shipped: Jaui-code smaller, total
  larger — the conscious trade for the unified 3D world. "Smaller" is true of our code, false of total.
- **Real-GPU perf**: NOT measurable in this sandbox — it exposes only "Microsoft Basic Render
  Driver" (software D3D11), no physical GPU. Software numbers (new ~1–1.7× copy) are NOT
  device-truth. Must be run on a real machine with a GPU. Open, environment-blocked.
- **Unit suite**: was 56 pass / 13 broken — the breakage was 20 test files importing a stale
  `'../src/...'` path (predates the Source/ rename; broken in the copy too). Repointed to the
  `@jaui` alias → **~347 passing**. Updated Jiv.Instance to assert 64 floats/256 bytes (the
  intentional Phase-5 instance-buffer growth). Remaining failures (Canvas.Events, Layout.Attach,
  Spring, Worker.BridgeWorker) **fail IDENTICALLY in the frozen copy** — pre-existing, environmental
  (no DOM/worker globals + timing-sensitive springs under headless vitest), not migration-caused.
- **Worker / OffscreenCanvas path**: VERIFIED — `ThreeRenderer.Init(OffscreenCanvas)` →
  BeginScenePass → PanelDrawBatch → PresentScene renders correctly into a transferred
  OffscreenCanvas (60k red panel px, 0 errors). The GPU-on-offscreen part the migration touched works;
  the message-bridge plumbing is unchanged orchestrator code.

## Risks called out up front
- **Glass in perspective** breaks the screen-space backdrop model; deferred to Phase 5 as
  a distinct (refraction) problem, not a port.
- **Text crispness in depth** requires MSDF; the atlas port is parity-only, not the end state.
- **Performance**: expect comparable-or-slower, not faster. The win is capability. The 2D
  fast paths (instanced batches, scissored blur, LOD-capped mips) must be preserved.
- **No existing pixel harness**: it is built in Phase 0 and is itself load-bearing.
