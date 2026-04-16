# Jwift WebGPU Migration Plan

## Why

The current WebGL2 rendering pipeline cannot hit 60fps on mobile (iPad reports ~15fps). The bottleneck is GPU-side: the blur pyramid requires multiple full-screen FBO ping-pong passes, and the glass fragment shader does 6 texture samples + heavy ALU per pixel. WebGL2 has no compute shaders and high per-draw-call overhead.

**WebGPU** solves this from TypeScript — no language switch required:

- **Compute shaders** — replace the FBO blur ping-pong with a single compute dispatch
- **Explicit resource binding** — no implicit GL state machine overhead
- **Modern GPU features** — storage textures, indirect dispatch, better batching
- **WGSL** — validated shaders compiled to SPIR-V/MSL/HLSL/DXSL under the hood

WebGPU now ships in Chrome 113+, Edge 113+, Firefox 141+ (desktop), and Safari 26 (iOS 26, iPadOS 26, macOS Tahoe). Coverage is ~70% today and rising fast — by the time Jwift ships, well above 80%. Safari 26 this fall closes the last major gap.

### What about WebGL2 fallback?

We define a `Renderer` interface so a WebGL2 backend *could* plug in later, but we **do not implement it**. No two-renderer maintenance burden. If fallback becomes necessary, the interface is there. Until then, WebGPU only.

---

## Architecture

The engine stays TypeScript. The GPU layer switches from WebGL2 to WebGPU. Shaders switch from GLSL (embedded template literals) to WGSL (standalone `.wgsl` files).

```
Jwift/
  src/
    Core/
      Renderer.ts              — Renderer interface (WebGPU implements, WebGL2 could later)
      WebGPU.Renderer.ts       — WebGPU implementation of Renderer
      WebGPU.Device.ts         — GPUDevice/GPUAdapter lifecycle, surface config, limits
      WebGPU.Pipeline.Cache.ts — Caches GPURenderPipeline/GPUComputePipeline by shader+layout
      Node.ts                  — base scene graph node
      Layout.ts                — flex layout solver
      Spring.ts                — spring physics
      HitTest.ts               — point-in-shape testing
      Input.ts                 — pointer + keyboard dispatch
      Text.ts                  — text measurement + texture cache
      Accessibility.ts         — shadow DOM sync
    Materials/
      Glass.ts                 — Liquid Glass material (configures glass.wgsl pipeline)
      Blur.ts                  — Compute blur dispatch (configures blur_down/blur_up.wgsl)
      Shadow.ts                — drop shadow
      Border.ts                — SDF border
      Refraction.ts            — displacement/dome
      Progressive.Blur.ts      — progressive blur overlay
    Shaders/
      panel.wgsl               — non-glass panel: instanced quads, superellipse SDF
      glass.wgsl               — glass composite: refraction, CA, rim, specular, border
      blur_down.wgsl           — compute: downsample kernel (workgroup 8x8)
      blur_up.wgsl             — compute: upsample kernel (workgroup 8x8)
      text.wgsl                — text atlas quad rendering
      blit.wgsl                — fullscreen quad blit
      progressive.wgsl         — progressive blur overlay
      sdf.wgsl                 — superellipse SDF functions (imported by panel/glass)
    Primitives/
      Panel.ts
      Text.ts
      Image.ts
      ScrollView.ts
      Stack.ts
  angular/                     — Jwift.Angular (unchanged, calls same TS API)
```

### Renderer Interface

```typescript
interface Renderer {
    Init(canvas: HTMLCanvasElement): Promise<void>
    BeginFrame(): void
    RenderScene(nodes: Node[]): void     // scene pass — non-glass panels, text, images
    ComputeBlur(depth: number): void     // blur pyramid
    RenderGlass(nodes: Node[]): void     // glass composite pass
    Blit(): void                         // final composite to screen
    EndFrame(): void
    Resize(width: number, height: number): void
    Destroy(): void
}
```

`WebGPU.Renderer.ts` implements this. A hypothetical `WebGL2.Renderer.ts` could implement the same interface later with quality tiers (fewer blur levels, no chromatic aberration, hard-edge progressive blur). But we don't build it now.

---

## Key Performance Wins

### 1. Compute Shader Blur (biggest win)

Current WebGL2 blur requires 4-8 full-screen render passes with FBO bind/unbind between each. WebGPU compute:

```typescript
// Single compute dispatch replaces entire ping-pong chain
const pass = encoder.BeginComputePass();
pass.SetPipeline(this._blurDownPipeline);
pass.SetBindGroup(0, this._blurBindGroup);
pass.DispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
pass.End();
```

- No FBO state changes between levels
- Workgroup-shared memory for tap accumulation
- GPU stays busy — no pipeline bubbles between levels

Expected improvement: **3-5x faster blur** on the same hardware.

### 2. Explicit Resource Binding

- No implicit GL state machine — bind groups are immutable, validated at creation
- Pipeline objects pre-baked at init, not per-draw
- Command encoder records all work, submits in one `queue.Submit()` — no per-call driver overhead

### 3. Single Shader Language (WGSL)

Current GLSL shaders are embedded as template literals in TypeScript. WGSL shaders are standalone `.wgsl` files imported at build time (Vite plugin). Validated by the browser's shader compiler at pipeline creation — errors at init, not at draw.

### 4. Better Batching

- Instance buffers with `@builtin(instance_index)` — one draw call for all same-material panels
- Indirect draw for variable instance counts without CPU readback
- Storage buffers for per-instance data (style, transform) instead of uniform buffer packing

---

## Migration Phases

### Phase 1: WebGPU Scaffold + Compute Blur

**Goal**: Prove the performance win. WebGPU device setup + compute blur on a test scene.

- [ ] `Renderer` interface definition
- [ ] `WebGPU.Device.ts` — adapter request, device creation, surface config, capability detection
- [ ] `WebGPU.Renderer.ts` — skeleton implementing `Renderer`
- [ ] Port dual-filter blur to WGSL compute shaders (`blur_down.wgsl`, `blur_up.wgsl`)
- [ ] Benchmark: compute blur vs current WebGL2 FBO blur on same scene
- [ ] Verify on Chrome, Safari 26+, Firefox

**Deliverable**: Side-by-side FPS comparison, same blur workload, WebGL2 vs WebGPU compute.

### Phase 2: Panel + Glass Render Pipeline

**Goal**: Full rendering pipeline in WebGPU. Scene, blur, glass, composite.

- [ ] Port `Jiv.Panel.frag` → `panel.wgsl` (non-glass panels, superellipse SDF, instanced)
- [ ] Port glass shader → `glass.wgsl` (refraction, chromatic aberration, rim, specular, border)
- [ ] Port progressive blur → `progressive.wgsl`
- [ ] Instance buffer packing for per-panel data (transform, style, material uniforms)
- [ ] Render pipeline: scene pass → blur compute → glass pass → blit
- [ ] `WebGPU.Pipeline.Cache.ts` — cache render/compute pipelines by shader + vertex layout
- [ ] Text rendering: atlas upload via `queue.WriteTexture()` + text quad shader

**Deliverable**: Full visual parity with current WebGL2 renderer, running on WebGPU.

### Phase 3: Layout + Animation + Text

**Goal**: Complete the engine core. Layout solver, spring animation, text pipeline.

- [ ] Flex layout solver (pure TypeScript, no DOM — same as current spec)
- [ ] Spring animation manager — damped harmonic oscillator driving layout + property values
- [ ] Text measurement via `CanvasRenderingContext2D.measureText()`
- [ ] Text atlas: pack glyphs, upload to GPU texture, render as quads
- [ ] Text input via hidden `<textarea>` (IME, clipboard, autocorrect)

**Deliverable**: Panels with text, animated layout transitions, glass materials — all WebGPU.

### Phase 4: Interaction + Scroll

**Goal**: Interactive UI. Hit testing, pointer events, scroll containers.

- [ ] Hit testing — pointer → node resolution via superellipse SDF
- [ ] Pointer event dispatch (down, move, up, hover, press states)
- [ ] Focus chain management
- [ ] Scroll containers — spring-physics momentum, rubber-band, overscroll
- [ ] Text selection — cross-Jiv word-level selection
- [ ] Style resolution — hover/active/focus state, `EffectiveStyle()` resolution

**Deliverable**: Fully interactive Jwift canvas with scroll, selection, hover, focus.

### Phase 5: JSS + Angular + Ship

**Goal**: Ship it. JSS compiler, Angular bindings, npm package.

- [ ] JSS parser + Vite plugin (`.jss` → typed style trees at build time)
- [ ] Angular bindings: `<jwift-canvas>`, panel/text/image directives
- [ ] Angular bindings call `Renderer` interface — no WebGPU knowledge in Angular layer
- [ ] Published to npm as `jwift`
- [ ] Bundle size: engine < 100KB gzipped (no Wasm)

**Deliverable**: `npm install jwift` — drop-in, Angular-ready, WebGPU-powered.

---

## Shader Porting Reference

| Current (GLSL) | New (WGSL) | Notes |
|-----------------|-----------|-------|
| `Jiv.Panel.vert` + `Jiv.Panel.frag` | `panel.wgsl` + `glass.wgsl` | Split non-glass and glass into separate pipelines for early-out |
| Blur `DOWN_FRAG` / `UP_FRAG` (in BlurPass.ts) | `blur_down.wgsl` / `blur_up.wgsl` | **Compute shaders** — workgroup size 8x8 |
| `Text.Quad.vert` + `Text.Quad.frag` | `text.wgsl` | Straightforward port |
| Blit (in Blit.ts) | `blit.wgsl` | Fullscreen quad |
| Progressive blur (in ProgressiveBlur.Shader.ts) | `progressive.wgsl` | Compute or fragment, TBD based on profiling |

### GLSL to WGSL Key Differences

- `vec2/3/4` → `vec2f/3f/4f`
- `uniform sampler2D` → `@group(0) @binding(0) var t: texture_2d<f32>` + `var s: sampler`
- `textureLod(tex, uv, lod)` → `textureSampleLevel(t, s, uv, lod)`
- `gl_FragCoord` → `@builtin(position)`
- `layout(location=N) in` → `@location(N)`
- No implicit type conversions — all casts explicit
- Compute shaders: `@compute @workgroup_size(8, 8)` + `@builtin(global_invocation_id)`

---

## Build Toolchain

No change from current setup — stays TypeScript:

```
Build:    tsc (ESM + .d.ts)
Dev:      vite (with WGSL import plugin)
Test:     vitest (layout math, spring physics — pure functions)
Shaders:  .wgsl files imported as strings via Vite plugin
Visual:   playwright screenshots (Chromium + WebKit)
```

### WGSL Import in Vite

Use `vite-plugin-glsl` (supports WGSL) or a minimal custom plugin:

```typescript
// vite.config.ts
export default {
    plugins: [{
        name: 'wgsl',
        transform(code, id) {
            if (id.endsWith('.wgsl')) {
                return `export default ${JSON.stringify(code)};`
            }
        }
    }]
}
```

Shaders are imported as strings and passed to `device.createShaderModule({ code })`.

---

## Performance Targets

| Metric | Current (WebGL2) | Target (WebGPU) |
|--------|-----------------|-----------------|
| iPad Pro (interaction) | ~15 fps | 60 fps |
| iPhone 15 | ~20 fps (est.) | 60 fps |
| Desktop Chrome | ~45 fps | 60 fps |
| Layout 200 nodes | < 1ms | < 1ms (same — not GPU-bound) |
| Total frame budget | 30-66ms | < 8ms |
| Blur pyramid | 4-8 FBO passes | 1 compute dispatch |
| Glass texture samples | 6 per fragment | 5 per fragment (shared center) |
| Bundle size | ~60KB | < 100KB (no Wasm) |

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| WebGPU browser bugs (especially Safari 26) | Medium | Test early on real devices, file WebKit bugs, keep effects simple initially |
| WGSL shader parity with current GLSL | Low | Mechanical port, same math, browser validates at pipeline creation |
| No WebGL2 fallback for older browsers | Accepted | ~70% coverage today, 80%+ by ship. Revisit if analytics show need |
| Compute shader perf varies by GPU | Low | Workgroup size tuning, fallback to fragment shader blur if needed |
| `navigator.gpu` feature detection edge cases | Low | Clean capability detection at init, hard fail with message |
