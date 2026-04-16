# Jwift wgpu Migration Plan

## Why

The current WebGL2 rendering pipeline cannot hit 60fps on mobile (iPad reports ~15fps). The bottleneck is GPU-side: the blur pyramid requires multiple full-screen FBO ping-pong passes, and the glass fragment shader does 6 texture samples + heavy ALU per pixel. WebGL2 has no compute shaders and high per-draw-call overhead. Rewriting CPU code (Rust/Wasm) would not help because the GPU is the constraint.

**wgpu** (Rust's WebGPU implementation) solves this by compiling to the native GPU API on every platform from a single codebase:

| Target | GPU Backend |
|--------|------------|
| Modern browsers (70%+ traffic) | WebGPU |
| Older browsers (fallback) | WebGL2 via wgpu-hal GL backend |
| macOS / iOS | Metal |
| Windows | DirectX 12 |
| Android / Linux | Vulkan |

WebGPU now ships in Chrome 113+, Edge 113+, Firefox 141+ (desktop), and Safari 26 (iOS 26, iPadOS 26, macOS Tahoe). ~70% of web traffic has WebGPU today.

---

## Architecture

```
jwift-core (Rust crate — the engine)
├── layout/          — Flex solver, intrinsic sizing, attach pass (pure Rust, no GC)
├── animation/       — Spring physics, damped oscillator, animation manager
├── render/          — wgpu render pipeline
│   ├── pipeline.rs      — Per-frame orchestration (scene → blur → glass → composite)
│   ├── blur.rs          — Compute shader blur (single dispatch, no FBO ping-pong)
│   ├── glass.rs         — Glass render pass (refraction, CA, rim lighting)
│   ├── panel.rs         — Non-glass panel instanced rendering
│   ├── text.rs          — Text atlas + quad rendering
│   └── progressive.rs   — Progressive blur overlay
├── shaders/         — WGSL shaders (one language, all backends)
│   ├── panel.wgsl
│   ├── glass.wgsl
│   ├── blur_down.wgsl   — Compute: downsample kernel
│   ├── blur_up.wgsl     — Compute: upsample kernel
│   ├── text.wgsl
│   ├── blit.wgsl
│   └── progressive.wgsl
├── tree/            — Jiv tree structure, dirty flags, style resolution
├── text/            — Text measurement, cache, atlas packing
├── scroll/          — Scroll physics, rubber-band, momentum
├── selection/       — Text selection, hit testing
├── hit_test/        — Pointer → Jiv resolution
└── lib.rs           — Public API surface exposed via wasm-bindgen

jwift (npm package — TypeScript wrapper)
├── index.ts         — Thin wrapper: Canvas, Jiv, styles — delegates to Wasm
├── jss/             — JSS parser (stays TypeScript, not perf-critical)
├── types.ts         — Public TypeScript types (JivStyle, LayoutConfig, etc.)
└── wasm/            — Built Wasm artifacts (checked in or published)

jwift-angular (npm package — unchanged)
├── Components and directives
└── Calls jwift npm API — no knowledge of Wasm/Rust underneath
```

---

## Key Performance Wins

### 1. Compute Shader Blur (biggest win)

Current WebGL2 blur requires 4-8 full-screen render passes with FBO bind/unbind between each. On wgpu:

```
// Single compute dispatch replaces entire ping-pong chain
blur_pass.dispatch(&mut encoder, &scene_texture, &blur_output, depth);
```

- No FBO state changes between levels
- No texture bind/unbind overhead
- Workgroup-shared memory for tap accumulation
- GPU stays busy — no pipeline bubbles between levels

Expected improvement: **3-5x faster blur** on the same hardware.

### 2. Metal / Vulkan / DX12 Native Backends

- ~10x lower CPU overhead per draw call vs WebGL
- Tile-based deferred rendering (Metal on iOS) keeps glass compositing on-chip
- Explicit resource barriers instead of implicit GL state machine
- Bindless textures / argument buffers reduce per-draw setup

### 3. No GC, Predictable Frame Times

Rust layout engine has zero per-frame heap allocation. No GC pauses. The current TypeScript layout allocates arrays per flex container per solve; the Rust version uses stack-allocated scratch buffers.

### 4. Single Shader Language (WGSL)

Current GLSL shaders are embedded as template literals in TypeScript. WGSL shaders are standalone files, validated at build time by `naga` (wgpu's shader compiler). One shader source compiles to SPIR-V (Vulkan), MSL (Metal), HLSL (DX12), and GLSL (WebGL fallback).

---

## Migration Phases

### Phase 1: Rust Crate Scaffold + Blur Compute Shader

**Goal**: Prove the concept. Rust crate that takes a texture and outputs a blurred texture via compute shader. Measure the improvement.

- [ ] `cargo init jwift-core --lib` with wgpu dependency
- [ ] Basic wgpu device/surface setup with `wasm-bindgen` canvas integration
- [ ] Port dual-filter blur to WGSL compute shaders (`blur_down.wgsl`, `blur_up.wgsl`)
- [ ] Benchmark: compute blur vs current WebGL2 FBO blur on same scene
- [ ] Verify on Chrome (WebGPU), Safari (WebGPU), and Firefox (WebGPU)

**Deliverable**: Side-by-side FPS comparison, same scene, WebGL2 vs wgpu compute blur.

### Phase 2: Glass Render Pipeline

**Goal**: Full glass rendering in wgpu. Scene pass, blur, glass composite, all in Rust.

- [ ] Port `Jiv.Panel.frag` → `panel.wgsl` (non-glass path)
- [ ] Port glass shader → `glass.wgsl` (refraction, CA, rim, specular, border)
- [ ] Port progressive blur → `progressive.wgsl`
- [ ] Instance buffer packing in Rust (replaces `Jiv.InstanceBuffer.ts`)
- [ ] Scene pass → blur compute → glass pass → blit pipeline
- [ ] Text rendering: atlas upload + quad shader in wgpu
- [ ] Wire up: TypeScript calls `render()` on Wasm module, passes Jiv tree data

**Deliverable**: Full visual parity with current WebGL2 renderer, running on wgpu.

### Phase 3: Layout Engine in Rust

**Goal**: Move layout off the JS main thread. Zero-allocation flex solver.

- [ ] Port `Layout.Solver.ts` → Rust flex solver
- [ ] Port `Layout.Flex.ts` → stack-allocated line arrays, no heap per-solve
- [ ] Port `Layout.Intrinsic.ts` → intrinsic sizing pass
- [ ] Port `Layout.Attach.ts` → attach resolution (up to 8 iterations)
- [ ] Port `Length.Tuple.ts` → length resolution (px, %, vw, vh)
- [ ] Serialization: JS sends tree structure → Rust solves → JS reads results
- [ ] Or: tree lives entirely in Rust, JS manipulates via handles

**Deliverable**: Layout benchmarks showing < 0.5ms for 200 nodes (target: < 1ms).

### Phase 4: Animation + Scroll + Input in Rust

**Goal**: Entire frame pipeline in Rust. JS only sends events and reads state.

- [ ] Port spring physics (`Animation.Manager.ts`, `Jiv.Animator.ts`)
- [ ] Port scroll physics (`Scroll.Manager.ts`) — momentum, rubber-band
- [ ] Port hit testing — pointer → Jiv resolution
- [ ] Port text selection — word-level selection, drag, click-count
- [ ] Port style resolution — `EffectiveStyle()`, hover/active/focus state
- [ ] Port text measurement and caching (atlas in Rust, rasterize via browser API or `ab_glyph`)

**Deliverable**: Full Jwift engine in Rust. TypeScript is a thin API wrapper only.

### Phase 5: WebGL2 Fallback Path

**Goal**: Graceful degradation for the ~30% of browsers without WebGPU.

- [ ] wgpu-hal GL backend for older browsers (automatic, wgpu handles this)
- [ ] Quality tier detection: if WebGL2 fallback, reduce effects:
  - Skip chromatic aberration (3 texture samples → 1)
  - Reduce blur depth by 1 level
  - Simplify rim-spec to math-only (no extra texture sample)
  - Skip progressive blur feather (use hard edge)
- [ ] Feature detection: `navigator.gpu` present → WebGPU path, else → WebGL2 + tiers
- [ ] Test matrix: Chrome (old), Safari < 26, Firefox Android

**Deliverable**: Works everywhere, fast where WebGPU is available, acceptable where it isn't.

### Phase 6: NPM Package + Angular Integration

**Goal**: Ship it. Same API, Wasm under the hood.

- [ ] `wasm-pack build` producing npm-publishable package
- [ ] TypeScript wrapper: `Canvas`, `Jiv`, `JivStyle`, all public types
- [ ] JSS parser stays in TypeScript (`.jss` → style tree, passed to Rust)
- [ ] Angular bindings: zero changes needed (they call the same TS API)
- [ ] Bundle size budget: Wasm blob < 500KB gzipped
- [ ] Published to npm as `jwift`

**Deliverable**: `npm install jwift` works, drop-in replacement for current package.

---

## Shader Porting Reference

| Current (GLSL) | New (WGSL) | Notes |
|-----------------|-----------|-------|
| `Jiv.Panel.vert` + `Jiv.Panel.frag` | `panel.wgsl` + `glass.wgsl` | Split non-glass and glass into separate pipelines for early-out |
| Blur `DOWN_FRAG` / `UP_FRAG` (in BlurPass.ts) | `blur_down.wgsl` / `blur_up.wgsl` | **Compute shaders** — workgroup size 8x8 or 16x16 |
| `Text.Quad.vert` + `Text.Quad.frag` | `text.wgsl` | Straightforward port |
| Blit (in Blit.ts) | `blit.wgsl` | Fullscreen quad |
| Progressive blur (in ProgressiveBlur.Shader.ts) | `progressive.wgsl` | Compute or fragment, TBD based on profiling |

### GLSL → WGSL Key Differences

- `vec2/3/4` → `vec2f/3f/4f`
- `uniform sampler2D` → `@group(0) @binding(0) var t: texture_2d<f32>` + `var s: sampler`
- `textureLod(tex, uv, lod)` → `textureSampleLevel(t, s, uv, lod)`
- `gl_FragCoord` → `@builtin(position)`
- `layout(location=N) in` → `@location(N)`
- No implicit type conversions — all casts explicit
- Compute shaders: `@compute @workgroup_size(8, 8)` + `@builtin(global_invocation_id)`

---

## Build Toolchain

```
Rust crate (jwift-core/)
├── Cargo.toml          — wgpu, wasm-bindgen, bytemuck, glam (math)
├── build.rs            — Optional: embed WGSL shaders at compile time
└── src/

Build commands:
  wasm-pack build --target web    → produces pkg/ with .wasm + .js glue
  cargo build --release           → native binary (for native app embedding)
  cargo test                      → layout math + shader snapshot tests

NPM integration:
  jwift/wasm/jwift_core_bg.wasm   — built artifact
  jwift/wasm/jwift_core.js        — wasm-bindgen glue
  jwift/index.ts                  — re-exports public API
```

### Key Rust Dependencies

| Crate | Purpose |
|-------|---------|
| `wgpu` | Cross-platform GPU abstraction |
| `wasm-bindgen` | Rust ↔ JS interop |
| `web-sys` | Browser API bindings (canvas, events) |
| `glam` | Fast math (vec2, vec4, mat4) — SIMD on native |
| `bytemuck` | Zero-copy struct ↔ byte slice for GPU buffers |
| `naga` | WGSL validation + cross-compilation (bundled with wgpu) |

---

## Performance Targets

| Metric | Current (WebGL2) | Target (wgpu) |
|--------|-----------------|---------------|
| iPad Pro (interaction) | ~15 fps | 60 fps |
| iPhone 15 | ~20 fps (est.) | 60 fps |
| Desktop Chrome | ~45 fps | 60 fps |
| Layout 200 nodes | < 1ms | < 0.5ms |
| Total frame budget | 30-66ms | < 8ms |
| Blur pyramid | 4-8 FBO passes | 1 compute dispatch |
| Glass texture samples | 6 per fragment | 5 per fragment (shared center) |
| Per-frame JS allocations | Multiple arrays | Zero (Rust stack buffers) |

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| wgpu Wasm binary too large | Medium | Tree-shaking, wasm-opt, only include needed backends |
| WebGL2 fallback path too slow | High (it's slow now) | Quality tiers — reduced effects, not broken rendering |
| WGSL shader parity with current GLSL | Low | Mechanical port, same math, validated by naga |
| wgpu on iOS Safari bugs | Medium | Test early on real devices, file WebKit bugs |
| Rust ↔ JS serialization overhead for tree | Medium | Keep tree in Rust, JS manipulates via opaque handles |
| Text rasterization in Rust (no Canvas 2D) | Medium | Use browser's Canvas 2D via web-sys for rasterization, Rust for atlas management |
