# Three Jaui — Parity Bar & Depth-as-Layout Spec

## Intent

The Three.js-backed Jaui must behave **the same or better than the original WebGL2
Jaui (the frozen `Jaui Copy/`) on every existing capability** — pointer events,
keyboard, zoom, JSS parsing/resolution, styling, animation, layout, and layering.
The 3D world is **additive**: it introduces depth without regressing any 2D behavior.

The copy is the **oracle**. All of its logic is available to test against. We keep
testing — unit + visual + interaction + resize — until the new renderer matches or
beats it across the board, then the depth features layer on top.

## Layering: screen-space vs world-space

Depth/front-amount is now a **first-class layout axis alongside top/left**. This
changes z-index/layer semantics:

- **Screen space** (`Space: Screen`, the default; element on the calibrated z=0
  plane): layering is the classic **paint order** — `Layer` / `ZIndex`, painter's
  algorithm, exactly as the copy did. This must stay pixel-identical to the copy.
- **World space** (`Space: World`, element pushed in Z via `VisualTranslate z`):
  layering is **real depth** resolved by the shared camera + depth buffer. "Front
  amount" (z) decides occlusion, not paint order.

> The rule, stated plainly: **if in screen space, order by Layer/ZIndex; else (world
> space) order by depth.** The two must compose coherently — a World element in front
> (nearer Z) occludes a Screen element behind it, and vice versa.

### State: IMPLEMENTED & verified

Depth-as-layering is wired and proven:
- The scene target has an explicit depth buffer (cleared each frame in `BeginScenePass`).
- **Screen-space** panel batches draw with `depthTest/Write = false` → painter's order,
  pixel-identical to the copy. The 2D parity board stays MATCH.
- **World-space** batches (`Space:World`) are flushed separately and drawn with
  `depthTest/Write = true` (toggled per-batch on the panel/glass material, restored
  after), so they occlude / are occluded by 3D subsystem content and each other by
  true Z. The orchestrator (`Jaui.ts`) partitions: a `Space:World` node flushes the
  pending screen batch, then draws as its own depth-enabled batch via the new
  `worldSpace` arg to `PanelDrawBatch`.
- Proven by `tests/depthlayer-shot.mjs`: a NEAR (+Z) panel painted FIRST occludes a
  FAR (−Z) panel painted SECOND in the overlap (paint order would have shown the
  second) — overlap pixel reads the near color. **PASS.**

## Test matrix (must all pass; new vs copy where applicable)

| Area | Has unit test | Has new-vs-copy parity | Gap |
|---|---|---|---|
| Layout (flex/attach/length) | yes | static-scene only | motion/resize |
| JSS parse / vars / resolve | yes | — | applied-style diff vs copy |
| Animation (spring/driver/style-animator) | yes (logic) | **none** | animating visual diff |
| Pointer events / hit-testing | partial | **none** | interaction parity |
| Keyboard | partial | **none** | interaction parity |
| Zoom (wheel / browser zoom / dpr) | — | **none** | zoom parity |
| Resize (minimize/maximize/dpr) | now: `resize-parity.mjs` | n/a (engine invariant) | — |
| Layering (screen `Layer`) | — | static scenes | depth composition |
| Layering (world depth) | — | **none** | depth occlusion |
| Static visual (5 scenes) | — | `compare.mjs` / `Parity.test.ts` | more scenes |

The static parity board (`compare.mjs`) never exercised motion, resize, or input —
which is why the resize-blowup and frozen-size bugs slipped through. New harnesses
must cover the **bold "none"** rows.

## Resize invariant (CLOSED — green at dpr 1 & 2)

The canvas backing store = `cssBox × dpr`, the CSS box always equals the host's
intended size, and the page never scrolls/overflows from the canvas. THREE distinct
failure modes were found (all ResizeObserver timing) and fixed:

1. **Blowup** — observing the canvas itself fed a loop (backing-store write grew the
   attribute-driven CSS box → ×dpr each round → 2^26 px → GPU death). Fix: size from
   the **parent's client box**, not the canvas (parent box is unaffected by our write).
2. **Freeze** — the browser silently drops RO notifications when a callback mutates
   observed-subtree layout (`_resize` writes `Element.width`). Fix: **capture
   contentRect in the RO callback but DEFER `_resize` to a rAF** (out of the callback,
   so no drop).
3. **Lag / stuck-on-last-resize (dpr 2)** — a deferred re-measure could read a stale
   box (one frame behind), and a dropped final event left it stuck. Fix: a
   **post-apply verify** — one frame after applying, re-read the live parent box; if
   it no longer matches what was applied, re-queue. Self-corrects any missed
   transition; converges in one extra frame.

Final mechanism (in `_observeResize`): observe parent → capture contentRect → coalesce
to one rAF → apply `_resize` → verify-and-requeue next frame; plus a `window.resize`
fallback. Verified by `tests/resize-parity.mjs` (minimize/maximize/fullscreen at dpr 1
and 2 — **PASS**).

## Harnesses

- `tests/compare.mjs` — static new-vs-copy pixel diff, 5 scenes.
- `tests/resize-parity.mjs` — drives real resizes at dpr 1 & 2; asserts the canvas
  tracks the window (follows size, correct backing, no scroll, never collapses).
- TODO: `interaction-parity` — pointer (hit, hover, active, capture), keyboard,
  wheel/zoom — driven identically against copy and new, output compared.
- TODO: `layer-depth` — assert screen `Layer` order matches copy AND world-Z
  occludes correctly once depth ordering lands.
