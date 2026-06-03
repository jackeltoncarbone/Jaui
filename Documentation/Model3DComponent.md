# 3D Content as a Jiv Component

## Intent

3D models and animated scenes should be **first-class UI content** — you say "in
this Jiv, put a model" and it just works, the same way you'd drop in text or an
image. No per-page subsystem boilerplate, no hand-wired pointer math, no manual
rect plumbing. Then you wrap that model in reusable **behavior components** (a
rotation/orbit view) so the user can spin the object sitting in its frame.

The unit of composition is the Jiv. A model is a Jiv whose pixels are 3D. A
rotation view is a Jiv that hosts a model Jiv and adds spin-on-drag. They nest
like any other UI.

## Layers (build on what exists)

- **`Janvas`** (exists) — the primitive: a layout-participating Jiv that reserves
  a rect and hands it to a `JanvasRenderer` which mounts an Object3D subtree into
  the shared scene. This is the plumbing; consumers should rarely touch it.
- **`Model3D`** (new) — a Janvas with a BUILT-IN renderer that loads/holds a model
  (glTF URL, or a procedural/`THREE.Object3D` you pass) and frames it to the
  rect. Declarative: `new Model3D({ Src: '...', ChildLayout: { FlexGrow: 1 } })`.
  Handles load, center+fit-to-rect, lighting defaults, and animation playback.
- **`RotationView`** (new) — a Jiv wrapper that hosts a `Model3D` (or any content)
  and adds **orbit-on-drag + idle spin + inertia**, scoped to its own rect. The
  object "sits in front of the frame" and rotates; the view owns the pointer
  gesture so the page doesn't wire it. Optional `AutoSpin`, `MinPitch/MaxPitch`,
  `Inertia`.

## Declarative API (target)

```ts
// "In this Jiv, a model the user can rotate."
new RotationView({
  ChildLayout: { Width: '320', Height: '320' },
  AutoSpin: true,
  Content: new Model3D({ Src: 'uniform.glb' }),
});
```

Angular binding (Jaui.Angular) mirrors it:

```html
<rotation-view [autoSpin]="true" style="width:320px;height:320px">
  <model-3d src="uniform.glb"></model-3d>
</rotation-view>
```

## Why this is the right shape

- **Composability**: a model is content; a rotation view is a behavior wrapper.
  Either nests anywhere a Jiv can — in a card, a shop tile, a hero, a sheet.
- **No boilerplate**: the demo today hand-writes a `JanvasRenderer` subclass +
  canvas-level pointer listeners per page. That collapses to one declarative tag.
- **Pointer scoping**: `RotationView` owns its drag via the Jiv's own pointer
  handlers (engine hit-test already routes to the right Jiv — verified), so two
  models on a page each rotate independently, and UI over them still clicks.
- **Depth-aware**: built on Janvas → shares the one scene/camera/depth buffer, so
  a `Model3D` in `Space:World` occludes/are-occluded correctly (see
  ThreeParityAndDepth.md). Screen-space models sit flat in the frame.

## Design rules

- **Frame to the Jiv rect, not the screen.** `Model3D` centers + fits the model to
  ITS OWN rect (origin at rect center, scale to fit min(W,H)). Multiple models on
  one page each frame independently. (The current demo centers on a quirky hero
  rect — `Model3D` fixes this structurally.)
- **No external-CDN dependency for core UI.** Accept a URL, but bundled/procedural
  content must be a first-class option (a flaky fetch must never blank the UI —
  that bit the demo).
- **Idle is cheap.** A static model marks dirty once and costs nothing per frame;
  only `AutoSpin`/active drag ticks. (Janvas dirty model already supports this.)
- **Animated scenes**: `Model3D` drives `THREE.AnimationMixer` when the glTF has
  clips; `Play/Pause/Seek` on the component.

## Open questions

- Pointer routing for a `RotationView` over/under other UI in world space (hit-test
  currently uses the layout rect, not the perspective-projected rect — fine for
  screen-space, needs thought for deep world-space models).
- Whether `Model3D` owns its lights or inherits scene lights (default: a sensible
  built-in 3-point rig, overridable).

## Format & JSS-asset vision (target)

`Model3D` should accept **any common 3D asset** — glTF/GLB, OBJ (+MTL), STL —
animated or static, materialed or not, via a pluggable loader registry keyed by
extension. The core stays loader-agnostic (consumer injects loaders) so the
bundle doesn't carry every format.

Bigger: **customize assets with JSS.** An asset in a Model3D should be stylable
like any Jiv — material tint/roughness/metalness, emissive, scale, the 3-point
rig's intensity/color, auto-spin speed, fit — expressed as JSS properties on the
component, not imperative Three code. "Put the uniform here, make it glossier and
tint it crimson" becomes a stylesheet rule. (Design sketch: a `Material` override
block mapping to the loaded meshes' materials; an `Asset` block for src/fit/spin.)
This makes 3D assets first-class, themeable content.

## Status

`Model3D` + `RotationView` BUILT (Source/Model3D/), exported from `jaui`, type-
clean. Model3D: Object or Src+Loader, frame-to-rect, 3-point rig, glTF clips.
RotationView: drag-orbit + auto-spin + inertia, self-driven via Model3D's per-
frame OnTick (no consumer frame-loop wiring). NEXT: bake into the home demo as a
pointer-inspect element; then the loader registry (obj/stl/glb) + JSS asset
styling above.
