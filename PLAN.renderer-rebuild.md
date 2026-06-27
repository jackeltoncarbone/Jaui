# Jaui renderer rebuild — clean architecture, in place, behind the same API

## Decision

The 10s/frame on the GPU-less VM is an **architecture** problem in Jaui's
renderer, not the hardware, not the language, and not the API. Proven by a
standalone WebGL2 demo (`ShowStudio.Jaui3.Test/`) that renders a visually
equivalent scene (animated field + varied-radius/stacked Liquid Glass) at
**~50–150 ms/frame on the same SwiftShader backend vs Jaui's ~9,500 ms — ~65–190×**.

So: **rebuild Jaui's RENDERER from the ground up, in place, keeping everything
above it.** Show Studio does not re-port — it gets a new engine under the same API.

## Scope

**KEEP (not the problem; it's the app's interface):**
- Jiv tree, layout solver, JSS, animation/spring system, Angular components, public API.
- Per-frame CPU here is ~10 ms — fine. Leave it alone.

**REBUILD (this is the 9.5 s):**
- The frame orchestration: `Jaui.ts` `_render` / `renderNode`, the per-surface
  blur invocation, the immediate-mode "redraw everything every frame" loop.

**REUSE (the shaders mostly work; the orchestration calling them is what's wrong):**
- Panel SDF/shadow/border shader, glass shader, text atlas + shader, BlurPass
  down/up kernels. Re-wire how/when they run; don't rewrite them from zero.

## The new architecture (from the proven demo)

1. **Shared blur pyramid, per stacking LAYER — not per surface.** One pyramid of
   the scene per layer (~2–3), built at **quarter resolution**; every glass /
   pblur / backdrop-filter surface samples it via `textureLod` at its own frost
   radius. Replaces ~53 full-res per-surface rebuilds. (Lossless: blur is
   low-frequency; quarter-res upsamples identically; LOD covers every radius.)
2. **Retained + damage-region.** Persist the scene FBO across frames; re-render
   only the screen region that actually changed (the marchers + any animating
   UI), composite the rest from last frame. Static UI over a still camera →
   ~0 cost. (Field's marcher screen-AABBs come from Reality.)
3. **Fixed-timestep playback** so the per-frame dirty area stays small.

Honest split (already measured): **playback (still camera)** → 30fps, realistically
60, losslessly. **Active camera-orbit** → the residual is the 3D field itself
(WebGL in any framework); needs separate field optimization (LOD/cull/RTT) and is
the harder case — but it is ~4.5× over budget, not 70×.

## How it ships safely (app keeps working throughout)

1. New render core as a **second path behind a flag** (`?jaui-v2`). Old path
   untouched and default until v2 is proven.
2. **Develop + measure in the clean harness** (`ShowStudio.Jaui3.Test`, evolved
   to consume real Jiv trees + reuse Jaui's shaders) — seconds per cycle, reliable.
   NOT the hostile full-app trace loop (fresh-profile decode failures, crashes,
   throttling) that made verification take days.
3. **Validate pixel-identical** to the old renderer on representative Jiv trees
   (screenshot diff) AND faster (the harness timer). Then flip `?jaui-v2` to
   default and delete the old `_render`.

## Phases

- **P1 — New core skeleton + shared-pyramid-per-layer blur.** Generalize the demo
  into a data-driven renderer (arbitrary styled panels/glass/text), reusing
  Jaui's primitives. Prove: many varied-radius glass, N stacking layers → ~N
  builds, quarter-res, fast. (Most of this is the demo already.)
- **P2 — Retained + damage-region.** Persist + redraw only the dirty rect; static
  UI → ~0. Wire marcher screen-AABBs from Reality for the field dirty region.
- **P3 — Feature parity.** Text, images, borders, shadows, gradients, clips,
  transforms, progressive blur — every Jaui primitive, on the new orchestration.
- **P4 — Integrate into Jaui behind `?jaui-v2`.** Consume the real Jiv tree;
  pixel-diff vs old on real Show Studio screens.
- **P5 — Field optimization** (Reality RTT + LOD/cull) for the orbit case.
- **P6 — Swap to default, delete old `_render`.** (Later: WASM+multicore as a
  2–4× amplifier on the hot paths — not needed for 30fps, but a ceiling-raiser.)

## What does NOT change
Show Studio's screens, components, `.jss`, layout, animations, public API. This is
an engine swap under the hood.
