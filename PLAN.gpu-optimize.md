# GPU Optimization Plan — Jwift Rendering

Written 2026-04-17. Constraint: **quality must equal or exceed current**.
No downsampling, no feature cuts. Every change is perf+quality or perf-neutral+quality, never perf+quality-loss.

Complements `PLAN.optimize.md` (CPU-side + idle-skip), which we are **not** pursuing — app has a constantly-moving video backdrop, no idle frames to skip.

## Context

Measured baseline from `?debug` HUD on user's machine:
- CPU cost per frame: ~1–3ms (not the bottleneck)
- Frame cost at 4fps big-window: ~250ms/frame → ~247ms on GPU
- 3 glass + 2 pblur + 138 panels + ~58 text nodes at peak

GPU-dominated. Each glass/pblur today runs: `SnapshotScreen` blit + `ComputeBlur` (2–4 passes) + `GenerateBlurMipmap` + draw = ~3.5 fullscreen-fill ops per surface. On Home, 5 surfaces × 3.5 = ~18 fullscreen fills per frame just for backdrop prep, plus the panel draws on top.

App has a **live video backdrop** — dirty-flag or snapshot-sharing across frames is not viable. Every frame is new. Optimization must make **per-frame work cheaper**, not skippable.

## Expected combined gain

| Workload | Current | After this plan | Gain |
|---|---|---|---|
| Home, browser-capped desktop | 32fps | 60fps+ | ceiling lifted |
| Home, big window, card pblurs | 10fps | 40–70fps | 4–7× |
| iPad (laggy) | ~15–25fps | ~60fps | 3–5× |
| Single glass/pblur GPU cost | ~1–2ms | ~0.3–0.5ms | 3–4× |

## Phased plan

### Phase A — Foundation: render to sceneFbo, not default framebuffer

**A1. Redirect all scene rendering through `_sceneFbo` instead of default FB.**

The infrastructure exists (`WebGL2.Renderer.ts:78` allocates `_sceneFbo`, `:319` has `BeginScenePass`) but is never called. Today the tree walks render directly to the default framebuffer, then calls `SnapshotScreen` (a full-canvas `blitFramebuffer`) every time a glass/pblur needs its backdrop. The snapshot is a dedicated texture that has to be fresh every frame because of the video backdrop.

Target flow:
```
BeginScenePass(sceneFbo, {black})           // bind sceneFbo, clear
  └─ walk tree; panels/images/text draw to sceneFbo
  └─ glass/pblur: sample sceneFbo.Texture directly (no blit)
  └─ glass/pblur draws back into sceneFbo
invalidateFramebuffer(depth, stencil)       // TBDR win (iPad)
Blit(sceneFbo → defaultFramebuffer)         // single final present
```

**Eliminates per-surface `SnapshotScreen` blits entirely.** Savings scale linearly with glass + pblur count. This is the single highest-ROI change in the plan.

Files: `Jwift.ts:_render`, `WebGL2.Renderer.ts` (already has `BeginScenePass`, `SceneTexture`, `Blit`).

### Phase B — Shader quality + perf wins

**B1. Evan Wallace closed-form drop shadow.** Current shadow is an SDF+smoothstep path inside the main panel fragment shader. Wallace's technique (analytical 1D Gaussian via erf, 4 samples per fragment, constant-time) produces better-looking soft shadows AND is independent of blur radius cost. Pull out to a pre-pass so panels don't pay shadow cost when they have no shadow.
- File: `Jiv.Panel.frag` (shadow section), new `Shadow.Shader.ts`
- Reference: https://madebyevan.com/shaders/fast-rounded-rectangle-shadows/

**B2. Split panel shader into glass vs non-glass variants.** Current `.frag` is ~900 lines with `if (materialType == 1.0)` branching throughout. 40-70% of rendered pixels are non-glass and pay mobile-GPU uniformity penalty. Two compiled programs; route by material at batch boundary.
- File: `Jiv.Panel.frag`, `WebGL2.Renderer.ts` (shader cache)
- 30-40% fragment shader cost saved on non-glass pixels

**B3. `fwidth()`-based scale-adaptive SDF anti-aliasing.** Current AA uses fixed smoothstep width in `Jiv.Panel.frag`. `fwidth()` gives the per-pixel derivative, so AA is sharp at all zoom levels. Pure quality win, zero perf cost.
- File: `Jiv.Panel.frag` edge AA
- Reference: https://www.redblobgames.com/blog/2024-09-22-sdf-antialiasing/

**B4. MSDF text rendering.** Current text is Canvas 2D `fillText` rasterized into atlas at DPR. MSDF atlases produce razor-sharp text at any scale with one rasterization. No re-rasterization on zoom, less atlas thrash, sharper text.
- File: `Text.Cache.ts`, `Text.Quad.frag.gen.ts`, new atlas generator
- Reference: https://www.redblobgames.com/articles/sdf-fonts/

### Phase C — Draw calls + GPU state

**C1. Batch non-glass panels between glass boundaries.** 30-100 individual `PanelBeginBatch/AddInstance/DrawBatch` cycles today. The instance buffer already supports multiple instances — just accumulate panels between glass-boundary flushes.
- File: `Jwift.ts:_render` (non-glass branch)
- 10-20× fewer draw calls per frame

**C2. `invalidateFramebuffer(depth, stencil)` at end of scene pass.** On iPad and other TBDRs, tells the tile memory manager to skip storing the depth/stencil back to main memory. Big bandwidth win on tile GPUs, zero cost on desktop.
- File: `Jwift.ts:_render`, `WebGL2.Renderer.ts`

**C3. `texStorage2D` for scene FBO allocation.** Driver pre-allocates vs. per-call texImage2D limbo.
- File: `Framebuffer.ts:Resize`

**C4. Cache GL state: `useProgram`, `SetClipBuffer`, viewport, per-batch uniforms.** Skip the JS→GL crossing when values haven't changed (CPU-submit-bound mobile win, free on desktop).
- File: `WebGL2.Renderer.ts`

### Phase D — Blur pipeline finesse

**D1. Two-LOD manual blend in progressive-blur shader.** Sample `textureLod(pyramid, uv, floor(lod))` + `textureLod(pyramid, uv, floor(lod)+1)`, mix by `fract(lod)`. Hardware trilinear already does this, but manual gives us the blend control to add a subtle mip-bias for smoother high-blur. ~3 extra ops.
- File: `ProgressiveBlur.Shader.ts`
- Quality win; perf-neutral

**D2. Deeper dual-filter pyramid for progressive blur.** Current `baseBlurCssPx = 1` → depth = 1, only one mip level of dual-filter quality. Progressive blur samples LOD 5-6 → rest is box-filter `generateMipmap`. Pass `minDepth = ceil(maxLod)` when calling `ComputeBlur` from the pblur path. Adds 1-2 extra blur passes per pblur, eliminates box-filter tail → smoother heavy blur.
- File: `Jwift.ts` (pblur branch), `BlurPass.ts`
- Quality win; mild perf cost offset by Phase A savings

## Implementation order

1. **A1** — foundation. Everything else composes on top.
2. **C2 + C3 + C4** — cheap wins while hands are in the renderer.
3. **B3** — one shader edit, pure quality win.
4. **D1 + D2** — blur refinement.
5. **B1** — Wallace shadow.
6. **C1** — panel batching.
7. **B2** — shader variants.
8. **B4** — MSDF text (biggest quality win, medium complexity).

Phases 1-2 land together; each subsequent phase is independently shippable and individually measurable via the `?debug` HUD.

## What's intentionally NOT in this plan

- **Idle-frame skip** — video backdrop means no idle frames.
- **Dirty-region snapshot sharing** — video means every frame is new.
- **Downsampling the backdrop FBO** — quality regression, rejected.
- **Per-card snapshot sharing via region tracking** — overlap logic fragile; Phase A makes per-card snapshots cheap enough that this optimization isn't needed.

## Sources

- [WebGL best practices — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- [Fast Rounded Rectangle Shadows — Evan Wallace](https://madebyevan.com/shaders/fast-rounded-rectangle-shadows/)
- [Blurred Rounded Rectangles — Raph Levien](https://raphlinus.github.io/graphics/2020/04/21/blurred-rounded-rects.html)
- [SDF Antialiasing — Red Blob Games](https://www.redblobgames.com/blog/2024-09-22-sdf-antialiasing/)
- [SDF+MSDF Fonts — Red Blob Games](https://www.redblobgames.com/articles/sdf-fonts/)
- [Dual-Kawase Blur — frost.kiwi](https://blog.frost.kiwi/dual-kawase/)
- [Bandwidth-Efficient Rendering — ARM SIGGRAPH 2015](https://community.arm.com/cfs-file/__key/communityserver-blogs-components-weblogfiles/00-00-00-20-66/siggraph2015_2D00_mmg_2D00_marius_2D00_notes.pdf)
- [Composite Rendering — Codrops 2026](https://tympanus.net/codrops/2026/02/23/composite-rendering-the-brilliance-behind-inspiring-webgl-transitions/)
- [iOS Liquid Glass — Apple Newsroom](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)
