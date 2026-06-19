# Foreground `Filter` — design + deferred work

## What shipped

A general foreground `Filter:` grammar mirroring the backdrop effects. The
`Filter` property (already a `JivStyle` key, already cascading its grade) now
also parses three foreground blur functions:

```
Filter: Blur(<radius>)
Filter: LinearProgressiveBlur(<direction>, <radius> [, <feather>] [, <easing>])
Filter: EdgeProgressiveBlur(<radius> [, <feather>] [, <easing>] [, <edges>])
```

**The two progressive functions are genuinely distinct shapes:**

- **`LinearProgressiveBlur`** is the DIRECTIONAL one-axis ramp. It OWNS a
  direction: sharp at one edge, ramping to blurred AT `direction` over the
  feather band. One side blurs; the opposite side stays clear.
  - `<direction>` = `Top | Bottom | Left | Right` (or an angle in deg → nearest
    axis edge).
  - `<radius>` = heavy-end frost sigma (Length; resolves under live context).
  - `<feather>` = ramp length from the clear edge (Length, px); omitted = spans
    the axis.
  - `<easing>` = smoothstep exponent (default 1).
  - Example: `LinearProgressiveBlur(Top, 24pt, 200pt, 1)` — top-only scroll fade.

- **`EdgeProgressiveBlur`** is the ALL-AROUND symmetric vignette. It takes **NO
  direction**. The border band fades inward on every selected edge while the
  CENTER stays sharp. Conceptually: Edge == Linear applied symmetrically on the
  selected edges at once.
  - `<radius>` = heavy-end frost sigma (Length).
  - `<feather>` = band depth as a **fraction** of the axis (`0.2` or `20%`),
    distinct from Linear's px feather because the symmetric band is expressed in
    the normalized Stops space; omitted = `0.5` (ramps meet at center).
  - `<easing>` = per-segment exponent (default 1).
  - `<edges>` = `All` (default) | `Top+Bottom` (alias `Vertical`) | `Left+Right`
    (alias `Horizontal`). This is "WHICH edges fade" — a mask, NOT a direction —
    which is what keeps Edge conceptually distinct from Linear.
  - A leading direction word (`EdgeProgressiveBlur(Top, …)`) is REJECTED with a
    message steering the author to `LinearProgressiveBlur` — the old ambiguous
    spelling is gone.
  - Example: `EdgeProgressiveBlur(24pt, 0.22, 1)` — symmetric frame vignette.

Composable with the grade functions in one list (`LinearProgressiveBlur(Top,
24pt) Brightness(0.9)`), merge-by-function / last-occurrence-wins like the other
filter zones.

### How it's wired (reuse, not reinvent)

`Filter.Parse.ts` gained a `zone` param. In the `foreground` zone, `Blur()` and
the two progressive functions populate a new `ForegroundBlur` sub-spec instead
of the backdrop `BlurRaw`. `Style.Resolver.ts` maps that spec onto the EXISTING
resolved `ProgressiveBlur*` render fields (`ProgressiveBlurDirection`,
`ProgressiveBlurFeather`, `ProgressiveBlurEasing`, `ProgressiveBlurStops`,
`BackdropFrostBlur`) and forces `Material: ProgressiveBlur`. So the entire pblur
shader (`ProgressiveBlur.Shader.ts`) and the `Jaui.ts` pblur orchestration are
reused unchanged. A uniform `Blur()` becomes a flat 2-stop ramp (`1@0, 1@1`).

Explicit standalone `ProgressiveBlur*` props still win over `Filter` (back-compat).

## Honest limitation — "foreground" vs scene-backed

The existing pblur material samples the **scene snapshot / blur pyramid** (the
composited content behind the element), the same source glass uses. It does NOT
render the element's own subtree to an offscreen target and blur only that.

For the real use cases (a transparent veil over a scroll region fading content
toward an edge — drill drawer top fade, demo top fade) this is exactly the
desired result: the scroll content IS the scene directly behind the veil, so it
feathers correctly. The veil is `PointerEvents: None` and carries no own fill.

### Deferred: true own-content foreground blur

To blur an element's OWN painted pixels (fill + text + children) in isolation —
independent of what's behind it — render the subtree to an offscreen FBO, build
a pyramid from THAT (not the scene snapshot), and run the same pblur shader with
the subtree texture as `u_Pyramid`/`u_Scene`. This is the CSS `filter: blur()`
semantic. Plan:
1. New render path in `Jaui.ts` keyed off a `ForegroundBlur.OwnContent` flag:
   bind an element-sized FBO, recurse-draw the subtree into it, `ComputeBlur` on
   it, then composite with the pblur shader (ramp drives LOD as today).
2. Honor `Isolate` as the cascade barrier (already a resolved field).
3. Cost: one extra FBO + blur per such element — scope to small subtrees.

Most consumers want the scene-backed feather, so this is intentionally deferred.

### Deferred: edge-to-edge "clip-visible" scrolling cards

Goal: scroll content bleeds to the panel's screen edges while padding is
preserved for insets (cards visible edge-to-edge, content inset for text). Today
`DrawerBody` uses `Overflow: Scroll` whose clip is the padding box. Plan: split
"clip rect" from "content inset" — let `Overflow: Scroll` clip at the border box
(edge-to-edge) while children keep their `Padding`. Needs a Layout/Scroll change
(a `ClipInset` / `ClipToBorderBox` knob on the scroll container), out of scope
for the filter slice.

## Verify

- Jaui demo (http://localhost:6777): the home scroll's top edge fade is now
  driven by `Filter: EdgeProgressiveBlur(Top, 24pt, 200pt, 1)` (Home.jss
  `FilterEdgeDemo`), replacing the legacy `TopBlur` ProgressiveBlur* class.
- App (http://localhost:6767): open the Add-cue drawer — the cards now feather
  into the glass top rim (`AddDrawer.jss` `DrawerTopFade`) instead of a hard
  scroll-clip cutoff.
- Unit: `tests/Filter.Foreground.test.ts` (grammar + zone separation).
