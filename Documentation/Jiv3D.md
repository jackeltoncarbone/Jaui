# Three Jaui — Jiv Becomes 3D-Native ("3DSS")

## Intent

Jiv is **the** element — the one universal box, and it is **one physical
surface**. There is **no "glass" vs "solid" vs "translucent" classification** —
those are not types or modes a Jiv gets bucketed into. Like a real material (or a
real div), a Jiv has *physical attributes* on continua: opacity, backdrop filter,
refraction, roughness, thickness, fillet, border. Setting transparency or a
backdrop filter does **not reclassify** the element into "a glass"; it just
changes how that one physical surface behaves. Every Jiv always has physicality.

We are **not** adding a separate "3D panel" primitive. We are making **Jiv itself
a real physical object in one lit 3D scene** — and JSS is the language that
describes it. Think HTML/CSS's single box model, but every box is a physical
thing in a shared 3D world: "3DTML / 3DSS" in spirit, still Jaui and JSS in fact.

- **One element, one surface model** — Jiv. Authoring is unchanged; it gains real
  presence. No material taxonomy: glass/solid/translucent are just where the
  attribute dials happen to sit, never a category.
- **The model and the code must match.** The implementation must mirror the
  concept: not "if these props are set, switch to the glass pipeline," but "every
  Jiv is a physical surface; these attributes describe it." Any pipeline branching
  left *under the covers* (for perf) must be invisible — never an author-visible
  type, never gating visibility, never causing a discontinuity.
- **One scene** — UI Jivs and 3D/Janvas content are the same lit world.
- **One stylesheet language** — JSS describes the 3D element ("3DSS").
- **Lights are Jivs** — a `<light>` is a Jiv role that emits light instead of
  (or in addition to) a surface. Because it is in the tree, it is in the scene;
  because it is in the scene, it lights everything.
- **`Space: Screen | World` is transform/styling only** — where the element
  sits and how it is projected. NOT a different scene, NOT a different lighting
  model, NOT a 2D-vs-3D mode. (See `ThreeParityAndDepth.md`.)

The Jiv we want: nice rubbery frosted / frosted-paper sheets — small fillet,
Apple corner radius, real thickness, physical presence — sitting in the scene and
lit by it. "Frosted" is an attribute (opacity + backdrop filter + roughness), not
a separate material kind.

## The continuity invariant (non-negotiable)

**Thickness is intrinsic and continuous (`0 → n`). There is no mode switch.**

Thickness is a real physical dimension every Jiv *has* — not a feature you turn
on. `0` is not "thickness-less" or a different mode; it is an **impossibly thin
sheet**: still the shape, still a physical surface, just zero depth.

- At `Thickness = 0`, a Jiv is **byte-identical** to the current flat appearance.
  No regression, pixel-faithful to the 2D look — because an impossibly thin slab
  IS the flat shape.
- As `Thickness` grows, the *same* surface gains real physical depth/presence
  smoothly.
- **Appearance is consistent throughout the whole range** because it is the same
  surface, not two things. Same footprint, same radius + fillet + border, same
  lighting response — only the depth value changes. A Jiv at thickness 0 and at
  thickness 8 are one element at two points on one continuum.
- The silhouette (2D outline: position, size, corner radius) **must not move**
  as thickness/fillet change. Depth/fillet add presence; they never distort the
  footprint. (`slabSdf` already encodes this: `halfDepth==0 && fillet==0`
  returns exactly the 2D SDF, and the fillet is clamped so it can't shrink the
  silhouette. The rewrite must preserve this as a hard rule everywhere —
  geometry, lighting, shadow, hit-test.)

Everything else in this spec is subordinate to this rule: any 3D-native change
that makes `Thickness:0` look different from today, or that makes appearance
jump discontinuously as thickness increases, is a bug.

## Performance bar

Performant **and** physically present — both, not one at the cost of the other.
"Physical presence" is the requirement; performance is the constraint; they are
reconciled by *how* the real 3D element is built (instancing, shared material,
shared environment, one batch where possible), never by faking presence flat.
Quads-on-a-billboard is not a goal to preserve — real presence is.

## Lights are Jivs

A `<light>` / `Light()` is a Jiv that contributes to the scene's light set. It
participates in the tree (parenting, `Space`, layout-derived transform) like any
Jiv. JSS describes it:

```
LightType:   Directional | Ambient | Point | Spot | Area | Environment   (open-ended)
Color:       <color>
Intensity:   <scalar>            // literal multiplier (ResolveScalar), not a length
Direction:   <x y z>             // Directional / Spot aim
Range:       <length>            // Point / Spot / Area falloff
ConeAngle:   <scalar deg>        // Spot
Penumbra:    <scalar 0..1>       // Spot
Size:        <w h>               // Area
Environment: <url | gradient>    // IBL / reflections (scene-level)
CastShadow:  <bool>              // opt-in (cost)
```

Position comes from the normal layout/`Space` system. `LightType` is additive —
a new type is one switch arm that builds the matching `THREE.Light` and packs
into the shared light data the Jiv material reads.

The existing per-Jiv lighting props (`LightAngle`, `LightIntensity`,
`SpecularIntensity`, `FresnelStrength`, `EdgeLight*`) become **local overrides**
for art-directing a surface's response, not the light source. Default: a Jiv is
lit by the scene's `<light>` set.

## Architecture (build order — each step shippable, parity-guarded)

The oracle for "Thickness:0 looks like today" is the current rendered Home and
the 2D parity board (`tests/compare.mjs`). Guard every step against it.

1. **Collapse the material taxonomy.** Remove `_inferMaterial` as a type bucketer
   and the `Thickness>0 ⇒ glass` promotion; make the surface shader one consistent
   model where backdrop sampling / refraction / roughness / thickness+fillet bevel
   are all terms that scale to zero at default (so the *same* shader yields flat,
   thin-transparent, thick-frosted, thick-opaque by attribute *values*, not a
   `materialType` branch). Unify `Thickness`||`Elevation` into one physical depth.
   Defaults ⇒ byte-identical to today (continuity invariant). No combination of
   (thickness, backdrop filter, opacity) may make a Jiv vanish.
2. **`Light` Jiv + JSS schema + resolver** — parses/holds, no render effect yet.
   Dimensionless props via `ResolveScalar`, lengths via `Resolve`.
3. **Worker bridge + scene light collection** — lights flow through the normal
   create/attach/apply/destroy op stream; the registry maintains the live light
   set (non-painting node, Janvas pattern).
4. **Unified lighting** — the Jiv surface + World meshes read the SAME scene lights
   + environment. One `Directional + Ambient` first (the 90% case); per-Jiv
   props become overrides. Then `Point`, `Spot`, `Area`, then `Environment`/IBL
   (surface reflections + mesh ambient from one source).

`Space` stays transform-only throughout (screen = on the calibrated plane, world
units = device px; world = positioned in 3D). Lights apply in world coordinates;
a screen-space Jiv is lit as if on the z=0 plane within the same lit world.

## Tests

- **Continuity:** `Thickness:0` Jiv is pixel-faithful to today's 2D Jiv; sweeping
  thickness `0→n` changes only depth/presence, never the silhouette, never a
  discontinuous appearance jump. (New harness; oracle = current render + 2D
  board.)
- **Default look unchanged:** with zero `<light>`s, a sensible default key+ambient
  keeps the current Home from going black.
- **No taxonomy / no vanish:** a `Thickness>0` Jiv with an opaque fill is visible
  as a lit thick surface (never invisible); adding a backdrop filter to that same
  Jiv makes it frosted **without** it becoming "a glass" — same element, attribute
  changed. No (thickness, backdrop filter, opacity) combo makes a Jiv disappear.
- **Unification proof:** one `Directional` `<light>` rakes BOTH a thick Jiv and a
  World mesh with the same direction/intensity; moving/recoloring it updates both
  in one frame.
- **Perf:** frame time at-or-below the current pipeline on the Home scene.

## Future: shape as an attribute (not clip)

A Jiv's 2D cross-section/footprint should be a **base path / shape attribute**
(static or animatable), defaulting to the current smooth superellipse
box→pill→circle. This is NOT `clip` (which masks *content*) — it is the actual
silhouette that gets extruded into the slab, so any shape automatically inherits
thickness + fillet + lighting. Builds on `shapeSdf2D` / `shapeMode`
(`Three.ShapeSdf.ts`). Design fork (deferred): a set of analytic SDF primitives
(rect/pill/circle/polygon/superellipse-params) vs. a general path→SDF compile.
Fits the "one surface, attributes not types" model — a different footprint, same
physical surface, no new element. Tracked as follow-up after lighting lands.

## Future: frost/blur is volumetric, and children are spatially contained

Progressive blur / frost stops being a 2D screen-space backdrop ramp. In the one
real lit scene it becomes a **participating medium with depth** — a volume of
fog/frost occupying the Jiv's Z extent (its `Depth`). Same "thickness is real,
attributes not types" principle applied to frost:

- **Frost has depth.** A thin frost slab reads like today's frosted sheet; a deep
  one is a volume of haze you can see *into*. How blurred/hazed something behind
  reads = density × the fog-depth actually traversed between it and the viewer
  (real Beer-Lambert over Z), not a flat LOD ramp.
- **Children are spatially contained in their parent.** A child's Z sits *within*
  the parent's slab (`[parent back face → front face]`) — it is literally inside
  the parent's medium, in front of its back face. The parent's frost integrates
  over the depth between the viewer and the child, so a card inside a frosted
  panel is suspended *in the frost*, getting progressively clearer toward the
  front face. Occlusion/haze is by real depth, not paint order.
- This yields the Vision-Pro "content suspended in glass/fog" feel directly from
  real depth + volumetric frost + spatial nesting — no special-casing.

Build phase: right after lighting (it depends on the same real-depth scene the
lighting work establishes). The current `ProgressiveBlur` ramp + `BackdropFrost`
become the thin/degenerate slice of this volumetric model (continuity: a
zero-depth frost = today's flat frost). Affects the compositing/order model in
`Jaui.ts` (child containment by Z) and the frost integration in the surface
shader.

## Status: PLANNED

Foundation present: `slabSdf` (real thickness + fillet + silhouette-preserving),
one `THREE.Scene` + `_world`, `Space` screen/world projection wired
(`ThreeParityAndDepth.md`). Missing: Jiv as real scene geometry across 0→n,
`<light>` as a Jiv, unified scene lighting for Jiv material + meshes.
