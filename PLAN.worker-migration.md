# Jaui → Worker Migration Plan

Move Jaui's tick (layout, animation, paint, hit-test) and the Three.js-based
"Reality" engine off the main thread into a Web Worker via `OffscreenCanvas`,
so heavy main-thread work (route module parse, drill build, Angular CD bursts)
can never freeze the UI. Mirrors the way HTML/CSS use the compositor thread to
keep painting through a blocked main thread — but for our canvas engine.

## Constraint

**No regressions, only improvement.** Worker is the only path forward — no
feature flag, no main-thread codepath kept around for fallback. Browsers
without `OffscreenCanvas` + `Worker` support hit a hard "update your browser"
gate at boot. Decision: humanity progresses; we don't carry two engines.

## Target architecture

```
┌──────────────────── Main thread ────────────────────┐
│ Angular app                                          │
│ • Components (Jiv, Janvas, Jext, Jyle, Jinput, …)    │
│ • RealityService → RPC proxy                         │
│ • DOM canvas element ─ transferControlToOffscreen ─┐ │
│ • Event capture (pointer/wheel/key/resize/font/DPR)│ │
│ • Cursor + setPointerCapture                       │ │
│ • Hidden <textarea> (Jinput IME)                   │ │
│ • DOM <svg> rasterization (SvgJiv)                 │ │
└──── postMessage / SharedArrayBuffer ───────────────┼─┘
                                                     │
┌──────────────── Worker (Dedicated) ────────────────▼─┐
│ Jaui Canvas (WebGL2 / WebGPU) — owns OffscreenCanvas │
│ • Layout, animation, hit-test, scroll, JSS, var-table│
│ • Image cache, Text cache (OffscreenCanvas 2D)       │
│ • Janvas pre-pass → THREE.WebGLRenderer (shared GL)  │
│   └ RealityCore, Camera, Marchers, Stadium, Grass    │
│ • Asset loaders (GLB, SVG, ImageBitmap)              │
└──────────────────────────────────────────────────────┘
```

## Decisions (locked)

1. **OrbitControls** — reimplement camera orbit math worker-side (~300 LOC).
   Rationale: simpler than chatty input forwarding, OrbitControls is small.
2. **GrassCanvas + drawing pipeline** — port to `OffscreenCanvas` inside the
   worker. Forward stroke commands from main-side pointer handlers.
3. **`captureStream` / MediaRecorder** — drop the MediaRecorder fallback path.
   `OffscreenCanvas` doesn't expose `captureStream()`. WebCodecs path stays.
4. **`RealityModel` ownership** — invert. Worker owns the model; main mutates
   via RPC. Unblocks the `ObservableCollection.Subscribe` patterns in
   `Reality.Core.ts:209,319,470,518`.
5. **Rollout** — full cutover, no flag. Hard gate at boot: feature-detect
   `OffscreenCanvas` + `Worker` + `transferControlToOffscreen`; missing → an
   "update your browser" page. The locked-out population in 2026 is iPhone 7/8/X
   holdouts on iOS ≤ 16.3 plus a tail of abandoned Android (≤ Chrome 68 era);
   both update or switch device. Main-thread codepath gets deleted as Phase 1
   lands — there is only one path.
6. **`<jinput>`** — the DOM-bound parts (hidden `<textarea>`, `selectionchange`,
   IME) stay on main, but its Jiv reads (`Width/X/Y`) become async/snapshot
   reads against the worker. If along the way it needs to be made nicer,
   we make it nicer properly — not punt it.

## Phases

### Phase 0 — Portability refactor (no behavior change)
Engine still on main, but all DOM-only call paths replaced with worker-safe
equivalents. Ships transparently.

- `Jaui/src/Core/Jaui.ts:1335` — never fall through to `Element.clientWidth`.
- Replace `document.createElement('canvas')` with `new OffscreenCanvas(w,h)`:
  - `Jaui/src/Image/Image.Cache.ts:181`
  - `Jaui/src/Text/Text.Measure.ts:8`
  - `Jaui/src/Text/Text.WordLayout.ts:25`
  - `Jaui/src/Text/Text.Cache.ts:230`
  - `Jaui/src/Core/Color.Parse.ts:53` (feature-detect; fall back if needed)
- Replace `new Image()` with `fetch + createImageBitmap`:
  - `Jaui/src/Image/Image.Cache.ts:68,125`
- Replace DOM canvas in Reality assets:
  - `src/App/Reality/Field/Field.Reality.Service.ts:213`
  - `src/App/Reality/Grass/Grass.Material.ts:6`
  - `src/App/Reality/Grass/Grass.Core.ts:53`
  - `src/App/Reality/Offscreen/OffscreenReality.Service.ts:97,179`
- Replace `THREE.TextureLoader` with `ImageBitmapLoader`:
  - `src/App/Reality/Grass/Grass.Core.ts:162`
- Loosen renderer `Init` signatures to accept `HTMLCanvasElement | OffscreenCanvas`:
  - `Jaui/src/Core/WebGL2.Renderer.ts:257`
  - `Jaui/src/Core/WebGPU.Renderer.ts:102`
- Add `Platform` shim in Jaui core — `getBoundingClientRect`,
  `devicePixelRatio`, `matchMedia`. Today resolves to direct DOM; later to
  bridged values.

**Acceptance:** identical behavior; profile shows no regressions; engine code
calls Platform shim, never DOM directly.

### Phase 1 — Worker boot, unconditional
- **Browser support gate.** Boot-time feature-detect; missing →
  "update your browser" page, no Angular start.
- New `Jaui.Worker.ts` entry; ships the Jaui core code, loaded as a
  `new Worker()` bundle.
- `Jaui.Angular/src/Jaui/Jaui.ts` becomes the main-thread bridge:
  - Creates `<canvas>`, `transferControlToOffscreen()`, posts the handle
    to the worker.
  - Forwards events (pointer / wheel / touch / key, with
    `getCoalescedEvents()` + canvas page-rect attached to each).
  - Forwards `ResizeObserver` `contentRect`, DPR change events,
    `document.fonts.loadingdone`, `(pointer: coarse)` state.
  - Relays cursor + `setPointerCapture` requests back to the proxy element.
- `WorkerPlatform`: implements `Platform` interface by reading bridge-pushed
  state instead of `window`/`document`.
- Replace HUD div with a main-side overlay receiving stats via postMessage.
- Delete the direct `new Canvas(...)` instantiation site on main —
  there is only one boot path.

**Acceptance:** home page renders + animates correctly (Reality excluded —
that's Phase 3). Hover / click / scroll / keyboard / hotkeys identical
to today.

### Phase 2 — `<jiv>` bridge protocol
- Worker-side `Jiv` proxy. Property writes buffered, flushed once per Angular CD.
- Hit-result round-trip for `OnClick` / `OnPointerDown/Move/Up` (so Angular
  `(click)` etc still fire).
- Async/snapshot reads for `Width/Height/X/Y/Parent/Overflow` (used by Jinput).
- Cursor + pointer-capture relayed back to main.

**Acceptance:** pages with text input, scroll, complex hover behavior all work.

### Phase 3 — Reality into the worker
The big one.
- Move into worker: `RealityCore`, `RealityCameraCore`, `CameraRigManager` +
  rigs, marcher entities, stadium, grass, selection picking, reimplemented
  OrbitControls, Marcher/Stadium caches, GrassCanvas pipeline.
- Stay on main: `RealityService` (RPC proxy), `RealityRevealService` (DOM).
- Recording / capture moves into the worker (parallel renderer shares worker
  GL context).
- VirtualCamera: WebCodecs-only; MediaRecorder path removed.
- SAB for hot per-frame state: marcher poses, camera transform.

**Acceptance:** home demo + drill page render correctly. FPS within 5% of
baseline. No regression in selection, hold-to-rotate, drawing, recording.

### Phase 4 — Stabilize
Bug-fix wave once Phases 1–3 are integrated. Long-tail: IME, a11y shadow tree,
snapshot/export, focus/blur, GL context-loss restore. No A/B — there's nothing
to A/B against. Telemetry on input-to-paint latency, FPS, crash rate confirms
no regression vs the pre-migration baseline (captured before Phase 1 lands).

**Exit:** zero open critical regressions; stable on Chrome Android, iOS Safari,
desktop Chrome/Edge/Firefox/Safari.

### (Phases 5–6: deleted.)
With no flag and no fallback codepath, there's nothing to "default-on" or
"delete later". Phase 1 delivers the only path; Phase 4 is the last stop.

## Top risks (file:line)

1. **GrassCanvas + DrawingCanvas** — `Jaui/...`, `src/App/Reality/Grass/Canvas/*.ts`,
   `src/App/Drill/Picture/DrawingCanvas.Component.ts:235`. Largest single port.
2. **OrbitControls + synthetic-event dispatch** — `src/App/Reality/Camera/RealityCamera.Core.ts:73`,
   `src/App/Reality/Reality.Component.ts:457`. Reimplementation needed.
3. **RecordingRendererService parallel renderer** — `src/App/Drill/Recording/RecordingRenderer.Service.ts:62`.
   Cross-thread GL share is impossible; export must run in the worker.
4. **`captureStream()` not on OffscreenCanvas** — `src/App/Drill/VirtualCamera/VirtualCamera.MediaRecorderEncoder.ts:43`.
5. **Per-frame model identity check** — `src/App/Reality/Reality.Core.ts:876`. Needs ownership inversion.
6. **`<jinput>` synchronous Jiv reads** — `Jaui.Angular/src/Jinput/Jinput.ts:382,630-647`.
   Async/snapshot bridge required.
7. **WebGL context loss in worker** — both Jaui and Three.js need a unified
   resource registry for restore.

## Bridge checklist (Phase 1+)

1. Forward DOM events: pointer*, wheel (`{passive:false}`), touchstart
   (preventDefault), contextmenu, keydown.
2. Forward `ResizeObserver.contentRect` deltas.
3. Forward DPR + `(pointer: coarse)` + `(resolution: Ndppx)` change events.
4. Forward `document.fonts.loadingdone`; mirror FontFace registrations into
   `self.fonts`.
5. Forward canvas page-rect snapshots.
6. Forward `document.activeElement` / `isContentEditable`.
7. Forward URL params (`?debug`, `?dpr=N`).
8. Relay back: cursor name, `OnClick` etc. invocations with payload, Jiv rect snapshots.
9. `setPointerCapture` / `releasePointerCapture` on main against the proxy element.
10. JSS var-Map propagation: serialize Map entries on every registry version bump.
11. Janvas: foreign renderers (Three.js) move into the worker.

## Out of scope for this migration

- Replacing JSS — it's the styling system, stays as is.
- Cross-tab `BroadcastChannel` coordination — possible follow-up, defer.

WebGL2 stays the rendering backend. WebGPU isn't a target.
