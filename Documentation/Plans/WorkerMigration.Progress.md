# Worker Migration — Progress Log

Companion to `PLAN.worker-migration.md`. One entry per change, newest first.
Each entry: phase, file(s), what changed, why, follow-ups.

---

## 2026-05-09

### Started
- Plan written (`PLAN.worker-migration.md`).
- Both repos verified clean + synced.
- Beginning Phase 0 — portability refactor.

### Phase 1 — backend complete + Phase 2 architecture built (uncommitted, dormant)

**Status:** all worker-side architecture is in place and tested in
isolation (309 passing tests, +46 new on top of dev4 baseline). The
Angular `<jaui>` / `<jiv>` / `<janvas>` components and Jwift's
`JivHost` are intentionally still on their main-thread JivCore code
path — the consumer migration to `JivHandle` is much larger than first
estimated and reaches deep into engine internals that show-studio +
Jwift consume directly (see "What's left" below). Build is green; dev
server runs the home page exactly as before.

**Built and tested in isolation:**
- **P1a** Browser support gate (boot-time `CheckBrowserSupport` →
  static "update browser" page on fail). 5 tests.
- **P1b** Bridge protocol (`Jaui/src/Worker/Bridge.Types.ts` — full M2W /
  W2M shape including Jiv tree ops). 5 tests.
- **P1c** `WorkerPlatform` (`Jaui/src/Worker/Worker.Platform.ts` —
  Platform impl backed by bridge-pushed state). 16 tests.
- **P1d** Worker entry + bridge runtime
  (`Jaui/src/Worker/Bridge.Worker.ts`,
  `Jaui/src/Worker/Jaui.Worker.ts`). 13 tests.
- **P1f** Engine listener extraction — `Canvas` exposes `IngestEvent`,
  `_pageRect`, cursor / pointer-capture relays; all 30+ DOM call
  sites in `Core/Jaui.ts` migrated. 5 tests.
- **Phase 2 architecture** —
  - `Jaui/src/Worker/Jiv.Handle.ts` — main-thread `JivHandle` with
    Proxy'd `Style` / `Layout` / `ChildLayout` / `TextStyle`,
    AddChild/RemoveChild, RequestLeave/Destroy, MarkLayoutDirty,
    OnClick / OnPointerDown/Move/Up setters, WatchRect subscription,
    cached geometry from rect snapshots.
  - `Jaui/src/Worker/Jiv.Registry.ts` — worker-side mirror that
    receives `JivOps` and rebuilds the JivCore tree under
    `Canvas.Root`. Hit handlers wired to post `W2M_HitEvent`.
  - `Jaui/src/Worker/Bridge.Main.ts` — main-thread bridge spawns the
    worker, transfers OffscreenCanvas, forwards events, batches Jiv
    ops once per microtask, applies cursor / capture from W2M.
  - `Jaui/src/Worker/Canvas.Proxy.ts` — drop-in replacement for the
    old main-thread `Canvas` (Images.LoadSvg / LoadUrl, Dpr,
    SetJssVars, Start/Stop, Animations.Kick).
  - `Jaui/src/Worker/Worker.Spawn.ts` — `SpawnJauiWorker()` wraps the
    static-URL `new Worker(new URL(...))` pattern bundlers detect.

**What's left for the consumer migration:**

The `<jaui>` / `<jiv>` / `<janvas>` Angular components and Jwift's
`JivHost` need to switch from constructing JivCore on main to
allocating a JivHandle through the bridge. That much is small. The
hard part is that show-studio + Jwift consumers reach into engine
internals that JivHandle doesn't expose:

- `node.SetText(...)` (Jwift `Icon`).
- `node.ResolveCtx?.PointScale` (Jwift `GlassActionGroup`,
  `SelectionIndicator`).
- `node.Children[0].Y`, `node.ScrollY`, walking `node.Parent` chains
  (Jwift `ToolbarTitle`, show-studio `Reality.View.Component`).
- `fill.ChildLayout.Width = '50%'`, `fill.SnapLayout = true`,
  `fill.MarkLayoutDirty()` (show-studio `Drill.Page`).
- `node.RenderStyle.Layer` (Jaui-internal layering).

Each is mechanically fixable but every consumer needs auditing. Until
then, the worker bundle exists but is not invoked at boot. Phase 2's
acceptance criterion ("home page renders + animates") requires this
consumer migration to land alongside the Angular component cutover —
they can't ship one without the other without breaking either the home
page or every other page that uses Drill / Jwift internals.

**Recommendation for next session:** dedicate a focused session to:
1. Expand `JivHandle` with stub methods covering `SetText`,
   `ResolveCtx`-shaped fields, and other engine internals consumers
   touch (mostly no-ops or value-buffered).
2. Walk every consumer file (~25 files across show-studio + Jwift +
   Jaui.Angular) and replace `JivCore` references with `JivHandle`.
3. Cut over the Angular `<jaui>` / `<jiv>` / `<janvas>` and Jwift
   `JivHost` to spawn the worker.
4. Smoke-test the home page in the browser.

---

### Phase 1 — partial (5/8 sub-tasks, uncommitted)

**Done:**
- **P1a** Browser support gate. `Jaui/src/Worker/Browser.Support.ts` exports
  `CheckBrowserSupport()`. Show-studio's `Program.ts` calls it at boot
  before Angular bootstrap; on fail, renders a static "update your browser"
  page (`src/App/Shared/Boot/UnsupportedBrowser.ts`) and exits. 5 tests.
- **P1b** Bridge protocol. `Jaui/src/Worker/Bridge.Types.ts` defines the
  full M2W / W2M postMessage contract. 5 tests.
- **P1c** WorkerPlatform. `Jaui/src/Worker/Worker.Platform.ts` implements
  the `Platform` interface from cached state pushed by main via M2W
  messages. 16 tests.
- **P1d** Worker entry + bridge runtime. `Jaui/src/Worker/Bridge.Worker.ts`
  (message pump) + `Jaui/src/Worker/Jaui.Worker.ts` (entry that constructs
  Renderer + WorkerPlatform + Canvas). 13 tests.
- **P1f** Per-element listeners extracted from engine. `Canvas` now has a
  worker-safe internal event API: `_on(kind, h)` → `IngestEvent(kind, e)`
  driven by the bridge. `_pageRect()` substitutes for
  `getBoundingClientRect`; `_setCursor` / `_capturePointer` /
  `_releasePointer` / `_hasCapture` substitute for the corresponding
  `Element` calls (and forward via bridge callbacks). All 30+ DOM
  call sites in `Core/Jaui.ts` migrated. Cursor + pointer-capture
  relays + ResizeFromBridge added. 5 tests.

**Test infra:** added `Jaui/tests/setup.ts` with polyfills for
`OffscreenCanvas`, `createImageBitmap`, `requestAnimationFrame`, and
`ResizeObserver` so vitest in Node can run the engine code paths that
Phase 0 introduced. Wired in `vitest.config.ts`.

**Test totals:** 286 passing, 5 pre-existing failures (Layout.Attach × 4,
Pill.SDF.Match × 1 — both on dev4 baseline before our changes; not
caused by this work). 23 new tests landed on top of the prior 263.

**Remaining for Phase 1:**
- **P1e** Angular `<jaui>` main-thread bridge. Needs to spawn the worker,
  `transferControlToOffscreen`, and forward all events / resize / DPR /
  fonts. Coupled to Phase 2 because children's `inject(Jaui).Canvas.Root`
  reads can't work cross-thread; the Jiv proxy has to land alongside.
- **P1g** Quarantine debug HUD to main side. The HUD div + DOMContentLoaded
  body-attach in `Core/Jaui.ts:2055,2070` is the last main-thread DOM use
  in the engine. Move to a main-side overlay component; engine emits
  HUD strings via W2M_HudStats.
- **P1h** Verify Phase 1 (build + smoke). Real-browser run: home page
  boots, animates, scrolls, hovers, clicks. Pending P1e + Phase 2.

---

### Phase 0 — complete (uncommitted)

All seven sub-tasks landed. tsc clean, Angular dev build clean (just
pre-existing NG8113 unused-import warnings on unrelated files).

Files touched in Jaui submodule:
- `Jaui/src/Core/Platform.ts` *(new)* — shim over `window`/`document` globals.
- `Jaui/src/Core/Jaui.ts` — wired Platform; killed `clientWidth/Height` fallback.
- `Jaui/src/Core/Renderer.ts`, `Core/WebGL2.Renderer.ts`, `Core/WebGPU.Renderer.ts`,
  `Core/WebGPU.Device.ts` — `Init` + `UploadSubTexture` accept `OffscreenCanvas`.
- `Jaui/src/Core/Color.Parse.ts` — color-canonicalizer probe → OffscreenCanvas.
- `Jaui/src/Image/Image.Cache.ts` — raster ctx → OffscreenCanvas; `new Image()` →
  `fetch + createImageBitmap`; `LoadCanvas` accepts OffscreenCanvas.
- `Jaui/src/Text/Text.Cache.ts`, `Text/Text.Measure.ts`, `Text/Text.WordLayout.ts` —
  measurement/raster ctx → OffscreenCanvas; ctx params widened to
  `Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D`.

Files touched in show-studio (Reality side):
- `src/App/Reality/Field/Field.Reality.Service.ts` — MAX_TEXTURE_SIZE probe.
- `src/App/Reality/Grass/Grass.Material.ts` — empty CanvasTexture.
- `src/App/Reality/Grass/Grass.Core.ts` — direction texture; replaced
  `THREE.TextureLoader` with `ImageBitmapLoader` + Texture-supertype returns.
- `src/App/Reality/Offscreen/OffscreenReality.Service.ts` — both renderer
  paths now use OffscreenCanvas; `toBlob`/`toDataURL` → `convertToBlob`.

What's intentionally NOT done in Phase 0 (deferred to Phase 1):
- Per-element pointer/wheel/touch listeners on `this.Element` (those move
  to a main-thread bridge that forwards to the worker).
- `getBoundingClientRect()` on the canvas (replaced by event-payload rects
  pushed from main).
- Cursor writes + `setPointerCapture` (relayed to main-thread proxy).
- Debug HUD DOM creation (will be quarantined / relocated to main-side).
- New `Jaui.Worker.ts` entry point + worker-mode `?worker=1` flag.

Behavior delta on main thread: none expected. The OffscreenCanvas
substitutions are spec-equivalent for measureText / fillText / fillStyle
/ getImageData / drawImage, and `fetch + createImageBitmap` matches the
old `new Image()` path for both regular URL and SVG-blob loads. The
removal of the `clientWidth` fallback is gated by `_pendingResize`, which
is populated by the same ResizeObserver that already runs.
