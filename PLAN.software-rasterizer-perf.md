# Jaui Software‑Rasterizer Performance — Master Plan

> **You are an agent picking this up cold. Read §0 then §1, then start at §9 (Rollout).**
> Goal: make Jaui render the Show Studio drill app like HTML/CSS does on a **no‑GPU (software‑rasterized) machine**, keeping **every current visual identical**. This is an authorized large change. Never keep a change that regresses the look or isn't proven faster.

---

## 0. How to use this doc / working protocol

- **Branch:** `jev` (superproject and the Jaui submodule are both on `jev`). The §2 idle‑skip work + this plan are already COMMITTED (superproject `a9050377`, submodule `3159099`). A prior local jev collision‑refactor commit is parked on `jev-backup-collision`. Jaui engine code is the **git submodule** at `ShowStudio.Libraries/Jaui` (its source root is `ShowStudio.Libraries/Jaui/Jaui/src`). App code is `ShowStudio.App`.
- **Line numbers in this doc are approximate (current tree). Grep the named symbol** — code shifts. All paths are from repo root `C:/Users/jackc/Code/Repositories/show-studio`.
- **Run the app:** dedupe first (a stale nested Angular breaks the build): `rm -rf ShowStudio.Libraries/Jaui/node_modules` (the repo root is an npm workspace that provides the shared `@angular/*`). Then `cd ShowStudio.App && npm run generate:assets && npx ng serve --host 127.0.0.1 --port 6767 --proxy-config proxy.conf.json --no-hmr`. Target page: `http://127.0.0.1:6767/drill/playground` (localStorage backend, **no API/login needed**). Jaui renders in a **Web Worker** — a full reload (fresh Chrome) is required to pick up Jaui changes, not HMR.
- **Reproduce the no‑GPU machine locally:** launch Chrome with `--disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader`. This is genuine software rasterization (SwiftShader) and matches the user's remote PC (which runs Microsoft Basic Render Driver / D3D11‑WARP — see §1).
- **Measure + verify (every change):** harness at `<scratchpad>/measure.mjs` and `verify.mjs` (Node CDP, no deps; `<scratchpad>` = the session scratch dir; if missing, recreate from this doc's §8). `measure.mjs` launches HW or `--software` Chrome, warms up past the slow SwiftShader shader‑compile, reports rAF `fps/avgMs/p95Ms`, captures the **worker‑target** console (auto‑attach), and screenshots. `verify.mjs` runs idle→resize→drag and asserts the canvas wakes + updates.
- **Quality gate:** `Page.captureScreenshot` per change, **pixel‑diff vs a baseline**. Same‑quality changes MUST be 0‑diff. "Imperceptible" changes get a human look at the heaviest frost/gradient on screen.
- **Honest timing:** rAF interval is a proxy. For true software frame cost, do a **1×1 `gl.readPixels` right after `PresentScene`** to force completion — NEVER `gl.finish()`/`clientWaitSync()` (they lie on this ANGLE stack). The prior `[wkr-fps]`/`[wkr-reality]` instrumentation was temporary and removed; re‑add a `[wkr-frame]` readPixels timer when you need real numbers, then remove before commit.
- **Iteration loop:** pick ONE item → implement in the submodule (no commit) → rebuild (dev server auto) → warm up → measure (software) + screenshot‑diff → if win + identical look, keep + record; else revert. Commit per landed, verified item. **Never commit without the user's OK on non‑perf branches; on `jev-jaui-perf` commit freely per verified item.**

---

## 1. Context & root cause (why we're doing this)

The drill app is ~4 s/frame on the user's remote/virtual PC. `chrome://gpu` there is definitive: **there is no GPU.** `WebGL: Software only`, `GL_RENDERER: ANGLE (Microsoft Basic Render Driver … D3D11‑WARP)`, `Software Rendering: Yes`, 32 Hz display. SwiftShader locally reproduces it.

The user's reframing nailed the real question: the **same app in HTML/CSS + the same Three.js field ran fine on that same machine.** So it is NOT "a few glass + solid panels are inherently expensive." The gap is architectural:

1. **Skia.** Chrome's 2D software rasterizer (multi‑threaded, SIMD) has hand‑tuned fast paths for fill‑rounded‑rect / text / blur. Jaui draws the same rounded rect by running **~400–1100‑line WebGL fragment shaders per pixel on WARP** — orders of magnitude more software work for identical output.
2. **Retention.** The DOM rasterizes each element **once**, caches it as a layer, and only re‑rasterizes what changed; it composites the cached UI over the Three.js `<canvas>` cheaply. **Jaui re‑shades the ENTIRE UI (≈237 panels + 16 glass + 4 progressive‑blur + text) into one WebGL scene FBO every single frame** (immediate mode).

So even with the whole 3D background changing every frame: HTML pays `[3D on WARP] + [cheap composite of retained UI]`; Jaui pays `[3D field on WARP] + [re‑shade the whole UI every frame]`. **The 3D part is equal; the entire gap is the per‑frame UI re‑shading.**

**Goal:** keep every visual; make Jaui's UI overhead beyond the field ≈ the DOM's (≈free for static UI), and make the pixels that *do* re‑shade far cheaper.
**Honest target:** the 3D field's software cost is a *shared floor* (HTML+Three has it too; a 32 Hz software display caps everyone). We make the UI stop being the bottleneck. We do **not** gut the field or cut output resolution.

---

## 2. Already done (verified + COMMITTED on `jev`)

**Render‑on‑demand.** Jaui's `_render` was unconditional every frame. Now gated: `renderActive = layoutDirty || _animationManager.IsRunning || _needsRender` with a 3‑frame settle tail (`Jaui.ts` `_tickInner`, ~859). Made `RequestFrame` functional (sets `_needsRender`); wired `Janvas.MarkDirty → Janvas.Invalidate → RequestFrame`; fixed `AnimationManager.StepFrame` firing `OnFrame` (→RequestFrame) every frame regardless of activity; added reality‑worker input change‑detection (`Reality.Worker.Renderer.ts` — camera/poses/progress/drag compared, `_dirty`/`_settleUntil` gate); and **killed a forever‑looping reveal‑pulse `@Animation` (Mirror loop)** in `ShowStudio.App/src/App/Reality/Reveal/RealityReveal.Jaui.ts` (now `@if (IsCovered())` gates the pulse jiv) that kept the canvas re‑rendering every frame even when idle. **Verified:** idle now renders **0 frames** (was 39/s HW, 0.19/s = 5 s/frame SW); resize/drag/playback wake it; screenshots pixel‑identical. This solves the **idle/static** case. This plan attacks the **active** (field‑moving) case.

---

## 3. Strategy — three levers, all same‑quality

- **Lever A — Retained‑layer compositing (the headline = the DOM model, §6).** Cache static UI subtrees into offscreen textures; composite them as cheap quad blits each frame; re‑bake a layer only when its subtree changes. Glass/field stay live. This is what makes Jaui behave like HTML on software.
- **Lever B — Per‑primitive per‑pixel cuts (§4).** Make the pixels that DO re‑shade (live glass, the field overlay, comet, the playhead, any re‑baked layer) cheaper, pixel‑identically.
- **Lever C — Unified clip‑distance cache (§5).** The clip‑stack SDF is the single biggest per‑pixel cost and is paid by panels, text, AND progressive‑blur. One cache helps ~80% of fragments.

**What's live vs static on the playground (per playback frame) — the prioritization:**
- **LIVE (must re‑render):** the **field** (janvas/Three.js into the scene FBO), the **comet** (Jaui **Jline** stroke — only its `Progress` uniform changes; geometry is static), the **transport scrub fill + time text** (a few nodes), and **glass that overlaps the moving field** (re‑samples its backdrop).
- **STATIC (should be cached, not re‑shaded):** the ~235 non‑glass panels, the toolbar, the Library/cue‑palette cards, timeline labels, most text. This is the bulk and the entire win.

---

## 4. Per‑primitive optimization catalog (the audit)

Each item is **same‑quality**. Treat ALU figures as estimates — **prove on software + screenshot‑diff before keeping.** Renderer draws live in `Jaui/Jaui/src/Core/WebGL2.Renderer.ts`; shaders in `Jaui/Jaui/src/{Jiv,Jline,Text,ProgressiveBlur}/Shaders/`; the tree walk + batch flush in `Jaui/Jaui/src/Core/Jaui.ts`.

### 4.1 Panel / Jiv (`Jiv.Panel.frag`, `PanelDrawBatch` ~625)
Two compiled variants today: `MATERIAL_GLASS`, `MATERIAL_NONE` (`WebGL2.Renderer.ts` ~1150). Worst case (glass) ≈ 1100 ALU/fragment; flat ≈ 100. No minimal "solid" variant exists.
- **(P1) `MATERIAL_SOLID` variant.** Most of the 237 panels are opaque solid rounded rects (Color paint, no border/shadow/image/gradient) but still run `MATERIAL_NONE` (full SDF + gradient via `CornerEval`, border composite, dither). Add a third `#if defined(MATERIAL_SOLID)` variant → distance‑only SDF + solid fill + AA (~20‑25 lines after DCE). Route in the non‑glass branch (`Jaui.ts` ~1764) when: Color paint + no painted border (`_hasPaintedBorder` ~2070) + `ShadowColor.A ≤ 0.001` + Normal border mode. Batch solids separately. **Pixel‑identical** (same `ShapeSDF` + `1-smoothstep(-0.5,0.5,dist)`). Drops ~2 of ~5 `pow`s + 2 `smoothstep`s ≈ 30‑40% per‑pixel ALU on the dominant panels.
- **(P2) Blend‑off for the opaque‑solid batch.** `flushPanels` always `EnableBlend` (`Jaui.ts` ~1102). For the P1 solid batch (gate strictly `Color.A ≥ 0.999`) `DisableBlend` → kills the per‑pixel dst‑read + blend. Compounds with P1. **Risk:** must gate ≥0.999 (a 0.99 panel would harden its AA rim).
- **(P3) Interior CA collapse threshold.** `Jiv.Panel.frag` already collapses chromatic aberration to 1 tap when `caSpreadPx < 0.5` (~857). Sub‑pixel CA is invisible → raise to `< 1.0`, saving 2 backdrop taps on most glass interiors. Imperceptible — verify on a heavy‑refraction panel.
- **(P4) Pill‑SDF lookup.** `SS_PillEval` (~263) scans ~32 Bézier samples/fragment for pill‑shaped panels. Replace with a small pre‑baked 1D SDF (256×1 texture) per size class → 1 tap vs 32 distance checks. Argued‑imperceptible (polyline was already an approximation). Lower priority (pills are a minority).

### 4.2 Jline / stroke — the comet (`Jline/Shaders/Jline.frag`, `StrokeDrawBatch` ~795; app: `ShowStudio.App/src/App/Reality/Paths/MarcherPathStroke.ts`)
GPU stroke primitive; ~35 ALU/fragment, **0 texture taps**; instances are miter quads per path segment (12 floats each), built once and reused — only the `Progress` uniform changes per frame. Typical 250–1000 segment‑instances during playback in 1 instanced draw. It IS live (Progress moves the trail head).
- **(J1) Shrink the miter quad in the vertex shader.** Quads extend to `halfExtent` (~20px) so ~75% of interior fragments `discard`. Compute the per‑vertex effective extent (width + max blur + head radius) in `Jline.vert` (~24) and scale the unit‑quad corners before the miter expand → pre‑eliminate the exterior corners. **Pixel‑identical** (same coverage test passes), big software win (software has no cheap discard).
- **(J2) Collapse the blur ramp for far‑from‑head segments** (`Jline.frag` ~65): when `age > BlurSharp`, set `blur = u_Blur` and skip the `smoothstep`. Spatially coherent. Imperceptible (tail is already at max blur).

### 4.3 Text (`Text/Shaders/Text.Quad.frag`, `TextDrawBatch` ~750)
~85 ALU/fragment **dominated by the clip‑stack loop (~80)** + 1 atlas tap. Glyph atlas is persistent; per‑glyph tint/opacity/clip are live.
- **(T1) Hoist clip distance to a `flat` varying** computed in `Text.Quad.vert` (clip distance is constant along the quad's clip‑perpendicular edge) → drop the per‑fragment clip loop. **Pixel‑identical.** (Subsumed by §5 if the unified clip cache lands.)
- **(T2) Clip‑feather early‑out** (`< -1.0` → `clipAlpha=1`, skip `smoothstep`) and **(T3) discard near‑transparent glyphs** (`Opacity*Tint.a < 0.01`) before the atlas tap.

### 4.4 Progressive blur (`ProgressiveBlur/ProgressiveBlur.Shader.ts`, `DrawProgressiveBlur` ~879)
Full‑screen quad; ~140 ALU + 1–4 pyramid taps; **clip loop ~80 again.** Static ramp, live pyramid.
- **(PB1) Early‑out the bicubic blend** (~365): if `cubicBlend < 0.01` use trilinear (1 tap), if `> 0.99` use bicubic only — skip the unused 4‑tap path at the band edges. Pixel‑identical.
- **(PB2) Pre‑bake the gradient‑stop ramp** to a 256×1 texture when `u_HasStops` (replaces a ≤12‑stop per‑fragment loop). Exact.
- **(PB3) Clip cache** — §5.

### 4.5 Image (panel shader `resolveBgFill`, `_bindBgPaint` ~688)
~108 ALU + 1 image tap; clip loop ~80. Static texture/UV, live cross‑fade alpha.
- **(I1) Skip the cross‑fade `mix` when alpha ≈0/≈1** (not in‑flight). **(I2) Atlas multiple card images** to cut per‑texture rebinds (one `PanelDrawBatch` per unique texture today). Clip cache — §5.

### 4.6 Gradients (panel shader `sampleBgGradient` ~86)
~140 ALU, 0 taps, fully static.
- **(G1) Pre‑bake the gradient to a 256×1 texture** → 1 tap vs a ≤8‑stop loop. Exact. **(G2) radial: use squared distance** (pre‑square stop positions) to drop the `sqrt`.

### 4.7 Janvas clip‑mask (`DrawClipMask` ~1253) & shadows/dividers/dots (baked into panel shader)
- **(C1) Pre‑rasterize the janvas rounded‑clip mask** to a texture on layout change; reuse as a blend mask instead of re‑evaluating the SDF on a full‑screen quad every frame. Static geometry → exact.
- Shadow/divider/dot are panel‑shader variants; covered by P1/§5. A baked shadow map is possible but low priority.

### 4.8 Full‑canvas passes & precision (cross‑cutting)
- **(F1) Skip the offscreen FBO + clear + present on glass‑free frames.** When a frame has no glass/pblur (pre‑walk scan `_scanFrostBlur` ~2152), render straight to the default framebuffer — drop the `BeginScenePass` clear (~597) and the full‑canvas `PresentScene` blit (~1107). Each full‑canvas pass is ~tens of ms on software (~250 MB/s). Also skip the clear when the root panel is opaque + canvas‑filling.
- **(F2) RGBA8 scene FBO on software.** Scene FBO + snapshot + blur levels are `RGB10_A2` (`Framebuffer.ts` ~56) — same 32 bpp as RGBA8 (no bandwidth change) but software pays `2_10_10_10_REV` pack/unpack on every texel R/W and every blur tap. Flip to RGBA8 when the renderer string is software. **Highest quality risk** (wide‑blur gradient banding over the field); existing dither should hide it; if not, keep 10‑bit only for the pblur levels. **Verify banding before keeping.**
- **(F3) DPR clamp on software.** Confirm `devicePixelRatio` on target (Windows fractional scaling → 1.25–2.25× pixels = 1.5–5× fill). Clamp the Jaui backing‑store DPR to 1 on software‑renderer detection (the app reality tier already caps its own pixel ratio in `ShowStudio.App/src/App/Reality/Reality.Render.Config.ts`, but Jaui's canvas DPR is separate — check `Jaui.ts` `_dpr`/`_dprOverride`). Log `window.devicePixelRatio` in the harness.

---

## 5. ★ The single highest‑leverage win: unified clip‑distance cache

**The clip‑stack SDF loop (~80 ALU/fragment, up to 16 clips) is the #1 per‑pixel cost and is paid identically by panels, text, AND progressive‑blur** — i.e. ~80% of all shaded fragments. `clipStackDistance` re‑solves the full rounded‑rect clip stack per fragment every frame (`Jiv.Panel.frag` ~604, `Text.Quad.frag` ~47, `ProgressiveBlur.Shader.ts` ~183). Clip geometry only changes on layout.

**Fix:** compute clip coverage **once per layout change** into a low‑res clip‑distance texture (e.g. 4px tiles, or per‑clip‑region) and have all three shaders **bilinear‑sample** it instead of re‑evaluating the loop. Recompute only on clip‑stack change. Shared infrastructure (`Core/Clip.Stack.ts`, `SetClipBuffer` ~286). **Pixel‑identical** for the interior; keep the per‑fragment SDF only within ~1px of a clip edge (a thin feather band) for crisp AA, or store enough texture resolution that the feather is exact. This is a unified change, not per‑primitive — do it once, it benefits everything. **Prove the AA edge is identical** (screenshot‑diff a rounded‑clip corner).

---

## 6. Retained‑layer compositing (Lever A — the architectural headline)

Cache the rendered output of **static UI subtrees** into offscreen RGBA8 textures and composite them as cheap **premultiplied** quad blits **at their z‑position inside the existing walk** — re‑baking a layer only when its subtree changes. Glass / progressive‑blur / the 3D field stay **live**. During playback the ~235 static panels become a few blits instead of full re‑shades — exactly how the browser composites a retained layer over the Three.js canvas.

**Load‑bearing insight (keeps glass correct for free):** do NOT build a separate compositor. At a cacheable subtree's slot in the walk, replace "walk + shade the subtree" with "blit its cached texture into the scene FBO." Because the blit lands in the scene FBO in z‑order, any glass drawn *later* samples a scene that already contains the composited band — backdrop correct, zero new bookkeeping. **Unit of caching = a subtree** (anchored at a Jiv); reuse `descendChildren` (`Jaui.ts` ~1174) verbatim for both the live walk and the bake.

**Mechanics:**
- New opt‑in `Jiv.CacheLayer: boolean`; `Map<Jiv, LayerCache>` on `Canvas` (FBO handle, valid bit, baked AABB/size in device px, `LastDirtyFrame`/`BakedAtFrame`/`LastUseFrame`, bytes). Layer FBO = pooled `Framebuffer { highPrecision:false, depth:false }` → **RGBA8** (premult‑able 8‑bit alpha; the scene's RGB10_A2 only has 2‑bit alpha, unusable as a premult target — `Framebuffer.ts` ~60).
- **Premultiplied compositing (pixel‑identical for AA/rounded edges):** bake with blend `(ONE, ONE_MINUS_SRC_ALPHA)` and a `u_Premultiply` uniform (`fragColor.rgb *= a`) on panel/text frags (default 0 → live path byte‑identical); composite the layer quad over the scene with the same premult‑over blend. Premult‑over of the whole layer == having drawn each element straight‑alpha src‑over directly, including AA‑transparent rounded corners. This is the only formulation that's pixel‑identical for non‑opaque edges; use it even for "opaque" fills.
- **Cacheability guard at the root, every frame** (else fall back to the normal walk — never risk a wrong pixel): subtree has no glass/pblur/backdrop‑filter, no janvas, no in‑flight teleport (`TeleportSeq !== 0`), is clip‑bounded (`ClipsChildren`, Overflow Hidden/Scroll → finite AABB), no 3D/rotation/VisualScale transform in scope (`effH === null`), `EffectiveOpacity === 1` + identity ancestor grade (animating opacity → not cached that frame), and all active clips originate at/below the root (self‑contained clip SDF). Items 1–2 memoize as a subtree flag invalidated on `Children`/material change; the rest are O(1) at the root.
- **Invalidation** (reuse iff `LastDirtyFrame < BakedAtFrame`): layout/text/children already bubble (`Element.MarkLayoutDirty` ~398) — during that bubble, stamp any `CacheLayer` ancestor passed. Visual‑only spring changes don't bubble → hook the animator (`AnimationManager.StepFrame` ~47 / `JivStyleAnimator.Tick` active‑return ~342) to stamp the nearest `CacheLayer` ancestor of an active animator (bounded by active‑animator count; zero when settled). Hover/state flips retarget springs (covered) + belt‑and‑suspenders stamp in the pointer handler (`Jiv.ts` ~95/208). Async image fades stamp while fading.
- **Render‑flow change is localized to `renderNode`** (`Jaui.ts` ~1311, after cull/clip/visibility): if `node.CacheLayer` and eligible → `flushPanels(); flushText();` → get/alloc layer → reuse‑or‑bake (bake = `BeginLayerPass` + translate coords by `-aabbOrigin` + run existing `descendChildren` into the layer + flush + `EndLayerPass`) → `CompositeLayer(tex, dx,dy,dw,dh, 1.0)` into the scene FBO → push the band AABB into `_sceneDirtyRects` (so glass‑over‑band rebuilds its shared pyramid; mirror ~1812) → `return` (skip `descendChildren` — the win).
- **Renderer additions (maximal reuse):** layer pool over `Framebuffer`; `BeginLayerPass/EndLayerPass` (mirror `BeginScenePass`/`RebindSceneTarget` ~1083); `CompositeLayer` = extend the existing `Blit`/`BLIT_*` quad (~204/1003) with `u_DstRect` (NDC) + `u_Opacity`, premult‑over blend, reuse `_quad.Vao`; `u_Premultiply` arg on `PanelDrawBatch`/`TextDrawBatch`. LRU eviction under a ~64 MB budget. Invalidate all layers on resize/DPR change.

**Z‑order/glass cases (all handled in‑line):** band→glass→band, glass‑above‑cache (samples the scene that already holds the band; the `_sceneDirtyRects` push keeps its pyramid fresh), glass‑below‑cache (drew earlier; band composites over it). Teleport/`Layer!=0` escaping the band → band uncacheable that frame (fallback).

---

## 7. Workflow‑driven prove‑out (how to run the whole effort)

The user wants this audited and proven systematically. Use a **Workflow** (multi‑agent) only when the user has opted in for that run; otherwise do it inline. Either way the SHAPE is:
1. **Audit (fan‑out):** one agent per primitive/subsystem (this doc §4–§6 is the seed catalog) returns *specific, code‑grounded, file:line* candidate changes with an expected‑savings + visual‑risk tag.
2. **Prove (pipeline, per candidate):** implement in the submodule → rebuild → **measure under software GL** (`measure.mjs --software`, readPixels frame timer) → **screenshot‑diff vs baseline** → keep iff (faster AND 0‑diff) or (faster AND argued‑imperceptible + human‑checked). Otherwise revert. Adversarially verify "imperceptible" claims with a second look at the worst‑case element.
3. **Record:** append result + learning to this file's §10 log. Never delete learnings. Re‑baseline after each kept win.
This keeps it transparent and proven (no black‑box "trust me" summaries — the user has been burned by those).

---

## 8. Verification harness

`<scratchpad>/measure.mjs` (recreate if missing): Node, global `fetch`+`WebSocket` (no deps). Spawns `C:/Program Files/Google/Chrome/Application/chrome.exe` with a fresh `--user-data-dir`, `--no-first-run`, anti‑throttle flags (`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion`), and **`--software` →** `--disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader`. CDP: `Target.setAutoAttach {flatten:true}` then `Runtime.enable` on the **worker** session (the field + Jaui render in a Web Worker — the page target alone misses their console). Measures rAF deltas, captures `[wkr-*]`/`reality` logs, `Page.captureScreenshot`. Args: `<url> [--software] [--warmup=N] [--seconds=N] [--shot=path]`. Use `--warmup=40+` for software (SwiftShader shader‑compile is ~40 s the first time). `verify.mjs` adds idle/resize/drag wake assertions. **True frame cost:** add a 1px `gl.readPixels` after `PresentScene` and log `[wkr-frame] <ms>` (remove before commit). NEVER trust `gl.finish`/`clientWaitSync` here.

---

## 9. Rollout (do in this order; each independently verified)

1. ~~Commit the §2 idle‑skip + pulse fix~~ — **DONE** (superproject `a9050377`, submodule `3159099`, on `jev`). Start at item 2.
2. **§5 unified clip‑distance cache** — biggest single per‑pixel win, helps ~80% of fragments. Verify rounded‑clip AA edge is identical.
3. **§4.1 P1 `MATERIAL_SOLID` + P2 blend‑off** — pixel‑identical, large win on the 237 panels.
4. **§4.8 F1 (glass‑free FBO/clear/present skip) + F2 (RGBA8, banding‑gated) + F3 (DPR clamp).**
5. **§4 the rest of the per‑primitive sweep** (Jline J1/J2, Text T1‑T3, PBlur PB1‑PB3, Image I1‑I2, Gradient G1‑G2, Janvas C1) — run as the §7 prove‑out loop.
6. **§6 retained‑layer compositing** — Phase 0 (plumbing: `u_Premultiply`, layer pool, `CompositeLayer`, `Begin/EndLayerPass`; dormant, screenshots identical) → Phase 1 (cache the single largest static clipped subtree, the Library/side panel; implement eligibility/alloc/bake/composite + invalidation stamps; verify caching‑on vs ‑off = 0‑diff, the band's panel/text counts drop to ~0 during field scrub, software frame‑time drops, hover a row rebakes once then reuses) → Phase 2 (multiple layers + scroll‑stable content‑space caching) → Phase 3 (glass‑interleave hardening + LRU eviction) → Phase 4 (auto‑promote static subtrees over a count threshold; composite through transform/opacity to lift the no‑rotation/opacity guards).

After steps 3–4 a playback frame on software ≈ `[field on WARP (= HTML's cost)] + [cheaper live glass/comet] + [composite cached UI]` → HTML‑parity UI overhead. Step 6 is what fully closes it.

---

## 10. Results / learnings log (append; never delete)
- 2026‑06‑26 — §2 render‑on‑demand + reveal‑pulse fix landed (uncommitted). Idle SW: 5 s/frame → 0 renders. Active case still full re‑render (this plan).
- (append each kept/reverted change with software fps before/after + screenshot‑diff result)

---

## 11. Key files (all references)
- **Jaui core:** `ShowStudio.Libraries/Jaui/Jaui/src/Core/Jaui.ts` (`_render` ~951, `renderNode` ~1311, `descendChildren` ~1174, render‑gate ~859, shared pyramid ~1660, `flushPanels`/`flushText` ~1100/1123, `_scanFrostBlur` ~2152, `_dpr`/`_dprOverride`), `Core/WebGL2.Renderer.ts` (`BeginScenePass` ~592, `PresentScene` ~1107, `RebindSceneTarget` ~1083, `PanelDrawBatch` ~625, `TextDrawBatch` ~750, `StrokeDrawBatch` ~795, `DrawProgressiveBlur` ~879, `DrawClipMask` ~1253, `BuildSharedBackdrop` ~864, `Blit`/`BLIT_*` ~204/1003, panel‑variant compile ~1150, `SetClipBuffer` ~286, `_sceneFbo` ~390), `Core/BlurPass.ts` (σ‑downsample ~216, mip cap ~405), `Core/Framebuffer.ts` (RGBA8 vs RGB10_A2 ~56‑62), `Core/Clip.Stack.ts`.
- **Shaders:** `Jaui/Jaui/src/Jiv/Shaders/Jiv.Panel.frag` (+ `MATERIAL_SOLID`), `Jline/Shaders/Jline.{frag,vert}`, `Text/Shaders/Text.Quad.{frag,vert}`, `ProgressiveBlur/ProgressiveBlur.Shader.ts`.
- **Dirty/invalidation:** `Element/Element.ts` (`MarkLayoutDirty` ~398), `Jiv/Jiv.StyleAnimator.ts` (`Tick` ~285/342), `Animation/Animation.Manager.ts` (`StepFrame` ~47), `Jiv/Jiv.ts` (`CacheLayer` flag, hover ~95/208).
- **App (already‑fixed + the live primitives):** `ShowStudio.App/src/App/Reality/Reveal/RealityReveal.Jaui.ts`, `App/Reality/Reality.Worker.Renderer.ts` (field `RenderToTarget`, comet `DrawComet`), `App/Reality/Paths/MarcherPathStroke.ts` (Jline), `App/Drill/Drill.Page.ts` (UI tree), `App/Drill/Drill.Transport.Component.ts` (live scrub/time), `App/App.ts` (`<janvas key='reality'>`), `App/Reality/Reality.Render.Config.ts` (tier DPR).
- **Prior perf docs (read for history):** `ShowStudio.Libraries/Jaui/PLAN.gpu-optimize.md`, `PLAN.optimize.md`, `NextUp.md`, and `Blur.Performance.Log.md` (NOTE: that log's "rendering isn't the bottleneck / it's the present path" conclusion was from a **GPU Mac contaminated by Parsec + a Chrome ANGLE‑Metal present bug** — it is FALSE for the no‑GPU software case this plan targets; the render genuinely IS the cost on WARP).

---

## 12. What NOT to do
- **Do not cut output/canvas resolution** or **gut the 3D field to 2D dots** — the user requires identical visuals; the field cost is shared with the HTML baseline anyway.
- **Do not narrow the blur up/down kernels** (`BlurPass.ts` ~286 — striation/oil‑pastel risk) and **do not retry cross‑surface pyramid reuse** (`Jaui.ts` ~1070 — proven ~2× regression on a software device).
- **Do not trust `gl.finish`/`clientWaitSync`** for timing on this stack.
- **Do not keep any change that isn't both faster on software AND pixel‑identical** (or argued‑imperceptible + human‑verified on the worst‑case element).
