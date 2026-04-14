# Next Up

Outstanding work for a follow-up agent. Ordered roughly by how much polish /
architecture each needs, not by importance.

---

## 1. BackdropFrostBlur doesn't visibly respond to value changes

**Symptom:** Editing `BackdropFrostBlur` in `Jwift.Angular.Demo/src/Home/Home.jss`
(e.g. from `2` → `0.15`) produces no visible change in the glass blur, even
after a full page reload. The change flows through JSS parse → StyleResolver
→ spring → `RenderStyle.BackdropFrostBlur` correctly (verified in code), but
the rendered glass looks identical at any per-Jiv value.

**Likely cause:** Jwift's frost-blur pipeline uses a shared dual-filter blur
pyramid built once per frame at `_maxFrostBlur` (the MAX across all visible
glass Jivs — see `Jwift/src/Core/Jwift.ts` around line 195–265). Each Jiv
picks a mip level via `log2(blurPx * dpr)` clamped to `[0, 10]`. So:

- If another glass Jiv on screen has `BackdropFrostBlur: 3`, the pyramid
  base is 3px blur. Any Jiv with a smaller value clamps to mip 0 — but mip 0
  of a 3px-blur pyramid is still 3px blur. Per-Jiv lower values can't
  produce _sharper_ samples than the pyramid's base.
- Values above the max don't go past the pyramid depth either.

**Fix paths (any of these):**
1. Cheap: when per-Jiv `BackdropFrostBlur` is below `_maxFrostBlur`, sample
   a mix of mip 0 and the original (unblurred) framebuffer, blending toward
   the raw backdrop as the value drops toward 0.
2. Proper: build one pyramid per distinct blur radius (or bucket to e.g. 4
   tiers) and have each Jiv pick the closest tier. More fills, correct
   semantics.
3. Reframe: make `BackdropFrostBlur` non-per-Jiv and always a canvas-wide
   value — document that it's a global knob. Authors who want differential
   blur use `BackdropBrightness`/`BackdropSaturation` per-Jiv instead, which
   already do work per-instance.

**Files:** `Jwift/src/Core/Jwift.ts` (`_scanFrostBlur`, `_runBlurPyramid`),
`Jwift/src/Core/BlurPass.ts`, `Jwift/src/Jiv/Jiv.InstanceBuffer.ts`
(`data[offset + 35] = log2(blurPx)`), `Jwift/src/Jiv/Shaders/Jiv.Panel.frag`
(how `a_Grading.w` — frostLod — is consumed).

**How to reproduce:** Dev-serve `Jwift.Angular.Demo` (port 6777), open the
home page, edit `src/Home/Home.jss`'s `Toolbar.BackdropFrostBlur` to any
value between 0 and 30. Reload. Toolbar looks the same.

---

## 2. Selection highlight render-pass / z-order bugs (task #9)

**Symptom:** Text-selection highlight Jivs sometimes render under glass
during drag, and flicker mid-frame. Not currently reproducible in
casual use but the underlying concern stands.

**Status:** Audited the render-pass routing — `<jiv>` highlights correctly
route to the above-glass pass (`_collectNonGlassUnderGlass`) when their text
Jiv has a glass ancestor. No wrong-pass bug found on paper. The older
"color fade during drag" symptom was fixed by the `ParseColor` fresh-copy
change (cached colors were being mutated by spring targets).

**Files:** `Jwift/src/Selection/Selection.Manager.ts`,
`Jwift/src/Core/Jwift.ts` (passes 1, 4, 5, 6).

**What to do:** Reproduce the flicker in the playground. If it truly
happens, trace to whichever pass is emitting stale highlights. Otherwise
close the ticket.

---

## 3. Progressive blur shader (task #17)

Show Studio's home feathers content into the floating chrome via a 7-layer
progressive backdrop-filter stack. Jwift needs the same as a first-class
material — a gradient blur that varies from full-strength to 0 along a
direction.

**Design (per `Styling.md`):**
```jss
Header {
  BlurGradient: to bottom      // direction
  BlurStrength: 60             // px at full strength
  BlurFeather: 250             // px over which it ramps to 0
}
```

**Rough approach:** A single fullscreen-pass shader that samples the
backdrop blur pyramid at per-pixel LOD, where the LOD is computed from the
fragment's position within the gradient. Needs a new Jiv feature slice
(`src/Blur/` probably), new shader, `JivStyle` fields, `StyleResolver`
wiring, `JivRenderStyle` fields, sample in the demo.

**Why it matters:** Without this, chrome surfaces (toolbar, tab bar, sheets)
have a hard edge between the blurred inside and the unblurred outside.
Progressive blur is what makes the iOS 26 "floating glass" read as
integrated rather than a patch stuck on.

**Files to touch:** `Jwift/src/Jiv/Jiv.Types.ts` (add fields),
`Jwift/src/Jiv/Jiv.Defaults.ts` (defaults), `Jwift/src/Core/Style.Resolver.ts`
(resolve the new fields), `Jwift/src/Jiv/Jiv.InstanceBuffer.ts` (write to
GPU buffer), `Jwift/src/Jiv/Shaders/Jiv.Panel.frag` (or a new shader pass),
and `Jwift.Angular.Demo/src/Home/Home.jss` (apply to Toolbar/TabBar).

---

## 4. Polish — lower priority

- `<jiv>` needs `X` / `Y` inputs so templates can position floating chrome
  without an imperative resize hook. Would let us restore `Position:'Placed'`
  on the demo's Toolbar/TabBar (currently inline rows).
- Scroll container isn't visibly clipping its overflow — content behind the
  tab bar shows through. Either the `Overflow:'Scroll'` path skips the stencil
  clip, or z-ordering lets sibling children render beyond the container.
- Hero stub is declared first in the demo's Scroll but doesn't show up in
  screenshots. Probably a layout sizing issue specific to the `SectionCompact`
  / `Section` siblings — worth tracing.
- `"Renections"` glyph artifact on the first render before `document.fonts.ready`
  — the fonts-ready gate in `JwiftCanvas.ngOnInit` should catch this, but
  confirm with a cold-load repro.
