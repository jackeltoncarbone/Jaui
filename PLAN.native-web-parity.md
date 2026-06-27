# Native-Web Parity — Audit & Plan

> Canvas replaced the DOM, so every affordance the browser gives for free is gone
> unless Jaui re-implements it. The investor noticing arrow keys don't scroll the
> home page is one symptom of a systemic gap. This plan covers all of it, abstracted
> at the framework level, browser-matching, additive (never overwriting existing
> behavior).

## Root cause (one architecture problem behind most gaps)

Jaui owns **two disconnected models**:

1. **The canvas interaction model** (engine `Core/`): owns hit-testing, scroll
   physics, hover/active, selection, cursor. All input listeners (`window` keydown,
   canvas pointer/wheel) route *here*.
2. **The Semantic Mirror** (`Jaui.Angular/src/Seo/`): a painted DOM underlay that
   projects **static** role/label/href/tabindex for crawlers + screen readers. It
   is **never updated** when canvas state changes, its nodes sit at `(0,0)` ignoring
   real layout, and they carry `tabindex=-1` (non-focusable). "Real tab order /
   positional sync" is an explicit deferred milestone (`Semantics.md:90-93`).

Because the two never talk, focus lives nowhere, keyboard input has no target,
ARIA state is a frozen snapshot, and Tab navigates empty hidden nodes that bypass
the canvas. **Every keyboard / focus / a11y gap below is a child of this split.**

### The unifying abstraction

Introduce an **engine-owned Semantic Layer** that is the single source of truth.
Both the canvas (visual projection) and the DOM mirror (focusable/AT projection)
derive from it. Concretely, three new Core services:

- **`AccessibilityTree`** (Core) — canonical semantic nodes (role, name, live
  state: expanded/selected/checked/pressed/disabled/current, set/posinset, rect).
  Projected *out* to the DOM mirror as real elements positioned over their canvas
  rects, and consumed by the renderer for focus rings.
- **`FocusManager`** (Core) — owns `CurrentFocus`, `FocusedScroller`, input
  modality (keyboard vs pointer for `:focus-visible`), tab-order computation,
  focus trap stack, focus restoration, `Focus()/Blur()` API.
- **`InputRouter`** (Core) — one keydown dispatcher. Looks at current focus and
  routes: text field → Jinput; button/link → activate (Enter/Space); scroll
  container → scroll keys; global → selection shortcuts.

**Focus authority is bidirectional but engine-canonical:** the DOM mirror must be
*really* focusable (`tabindex=0`, positioned over the element) because native Tab,
screen-reader cursor, and find-in-page can only operate on real DOM — those native
focus events sync *into* `FocusManager`. The engine, not the Angular mirror, owns
the canonical state and pushes projections both ways. This keeps scroll physics,
ring rendering, and routing in the framework-agnostic core, not the Angular layer.

---

## Full gap inventory (everything the audit found, no matter how small)

Severity: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low

### A. Keyboard scrolling — *the reported regression*
- 🔴 No keyboard scroll at all: Arrow keys, PageUp/Down, Space/Shift+Space,
  Home/End, Ctrl+Home/End do nothing. `Scroll.Manager` only has wheel/touch entry
  points (`ApplyDelta`/`ApplyDeltaInstant`); no keydown path.
- 🔴 No notion of "the active/focused scroller" to receive the deltas.
- 🟡 No per-container `scroll-behavior` (smooth vs instant) authoring surface.
- 🟡 No scroll anchoring (content inserted above viewport jumps the page).

### B. Focus & tab order
- 🔴 No Tab/Shift+Tab traversal; no focusable registry; no tab-order computation.
- 🔴 No focus state actually driven by the engine (`Jiv.Focus` exists but is only
  set in a test — dead). No `Focus()`/`activeElement` API.
- 🟠 Mirror nodes are `tabindex=-1` and unsynced — Tab navigates empty hidden
  nodes and bypasses the canvas entirely.
- 🟠 No roving-tabindex for composite widgets (menu/toolbar/listbox arrow nav).
- 🟠 No focus trap / inert for modals; no focus restoration on close.
- 🟡 No autofocus; no pointer→focus bridge (clicking doesn't focus).

### C. Focus rings (WCAG 2.4.7)
- 🔴 No focus-ring rendering on canvas — no ring style props, no shader stroke.
- 🟠 No input-modality detection → can't do `:focus-visible` (ring for keyboard,
  not mouse).
- 🟠 No forced-colors / high-contrast ring.
- 🟡 Disabled elements don't clear focus.

### D. Accessibility tree / screen-reader operability
- 🔴 Mirror projects **no live ARIA state**: `aria-expanded/selected/checked/
  pressed/disabled/current` never written; canvas state changes never reach it.
- 🔴 No positional sync — nodes at `(0,0)`; screen-reader touch exploration and
  focus land in the wrong place.
- 🟠 No `aria-setsize`/`aria-posinset` for lists ("item X of Y").
- 🟠 No `aria-live` regions for dynamic announcements (toasts, validation, route
  changes).
- 🟡 `Accessibility.Types.ts` is an unused 3-field stub; no `role=textbox` etc.

### E. SEO / crawlability — *mostly done, residual only*
- 🟢 Heading hierarchy, real `<a href>` link graph, landmarks, alt, contentful
  paint, opt-in role resolution all present and tested.
- 🟡 `tabindex` hardcoded `-1` on interactive mirror nodes (skips tab order —
  overlaps B). Verify residual: structured data (JSON-LD), OpenGraph/social meta,
  per-route `<title>`/meta, sitemap/robots are app concerns, confirm coverage.

### F. Text selection, clipboard, find-in-page
- 🟢 Pointer drag-select, double/triple-click, Cmd/Ctrl+A, copy/cut present.
- 🔴 **Ctrl/Cmd+F find-in-page is impossible on canvas text** — needs the mirror
  to carry the real text so the browser's native find works. High-value, easy to
  miss.
- 🟠 No keyboard caret / Shift+Arrow selection extension outside Jinput.
- 🟡 No drag-select autoscroll near edges.

### G. Forms & text input
- 🟢 `Jinput` hidden real input handles caret, IME/composition, clipboard.
- 🟠 Verify: `type=password` masking, autocomplete/autofill tokens, spellcheck,
  inputmode, mobile "scroll focused field above keyboard".
- 🟡 No undo/redo stack; no native validation bubbles → need `aria-invalid` +
  canvas error rendering (ties to D).

### H. Links & navigation (*auditor failed schema — from spec knowledge*)
- 🟠 Modifier-click / middle-click / Ctrl/Cmd+Click to open link in new tab, and
  right-click → "Open in new tab", likely broken: the canvas swallows pointer
  events and navigates via router. The mirror `<a href>` must receive the real
  click so the browser handles modified clicks natively.
- 🟡 Hover shows target URL in status bar (free if mirror `<a href>` is the hit
  target); `target=_blank`, `download`, back/forward gestures.

### I. Cursor, tooltips, hover, drag-and-drop
- 🟢 Cursor model exists (`Default/Pointer/Text/Move/None`).
- 🟠 No native `title=` tooltips.
- 🟡 No HTML5 drag-and-drop / file drop; richer cursors (grab/not-allowed/resize).

### J. Browser chrome & user preferences
- 🟢 Browser zoom honored via DPR (`Platform.ObserveDprChange`); Ctrl+wheel passes
  through.
- 🔴 **No `prefers-reduced-motion`** — springs animate regardless; accessibility +
  vestibular-safety violation. Engine-wide knob needed.
- 🟠 No print support (`Ctrl+P` → blank canvas) — print path must render the mirror
  or a print stylesheet.
- 🟠 No `prefers-color-scheme` / `prefers-contrast` / forced-colors reaction.

### K. Critic-surfaced misses
- 🔴 **No visible scrollbars** — `Overflow:Scroll` containers give no thumb/track,
  so users can't tell a region scrolls or where they are. Major usability gap.
- 🟠 RTL / bidi text & layout: **zero** support; LTR-only; `lang` static `en`.
- 🟠 Scroll-position restoration on back-nav + History API integration.
- 🟡 Anchor `#hash` deep-linking → scrollIntoView on the matching element.
- 🟡 Touch gestures: double-tap-zoom, pinch-zoom, two-finger pan, swipe; declare
  consumed vs passed gestures.

---

## Phased implementation plan

Each phase is shippable and additive. Foundation first because B–D, F, H all hang
off it.

### Phase 0 — Foundation: the Semantic Layer (Core)
1. `Core/Accessibility/AccessibilityTree.ts` — canonical semantic node model with
   live state; built from the Jiv tree, single source of truth.
2. `Core/Focus/FocusManager.ts` — `CurrentFocus`, `FocusedScroller`, input
   modality, `Focus()/Blur()/FocusNext()/FocusPrev()`, tab-order computation,
   trap stack, restoration. Public on `Canvas`.
3. `Core/Input/InputRouter.ts` — single keydown dispatcher; absorb the existing
   `_listenForSelectionKeys` into it (no behavior change).
4. Rework the Angular Semantic Mirror to be a **projection** of `AccessibilityTree`:
   positioned over real rects, `tabindex=0` where focusable, real focus events
   sync into `FocusManager`. Keep SEO output identical (regression-guard the SEO
   benchmark + `vitest run Seo`).

### Phase 1 — Keyboard scrolling (closes the reported bug)
- `InputRouter`: Arrow (±line), PageUp/Down + Space/Shift+Space (±viewport),
  Home/End (bounds), Ctrl+Home/End (root) → `FocusManager.FocusedScroller` →
  `Scroll.Manager.ApplyDelta` (animate, like browser smooth wheel). Default
  scroller = root page when nothing focused, matching browsers.
- Space suppressed when a text field is focused. `preventDefault` to stop browser.
- JSS `ScrollBehavior: Smooth | Instant` per container.
- Tests: arrow/page/home/end move `ScrollY`; vitest + Playwright on the home page.

### Phase 2 — Focus traversal + rings
- Tab/Shift+Tab via `FocusManager` over computed order (Interactive && !Disabled,
  tabindex semantics). Pointer press sets pointer-modality focus.
- Focus-ring render: `:FocusVisible` JSS predicate + SDF rounded-rect stroke
  following `BorderRadius`/corner shape, unclipped (outline semantics),
  modality-gated; forced-colors variant.
- Scroll-into-view on focus change (animate the nearest scroller).
- Roving-tabindex, focus trap + restoration for overlays.

### Phase 3 — Live ARIA + operability
- Project live state (`aria-expanded/selected/checked/pressed/disabled/current`,
  `setsize/posinset`) from `AccessibilityTree`; `aria-live` regions API.
- `role=textbox` + `aria-invalid`/`aria-required` wired from Jinput/validation.

### Phase 4 — Find-in-page, links, clipboard parity
- Mirror carries real selectable text so native Ctrl/Cmd+F works (optionally
  scroll-canvas-to-match on find highlight).
- Route modified/middle clicks + context-menu through the mirror `<a href>` so the
  browser handles new-tab/open natively; hover URL preview falls out for free.
- Keyboard caret / Shift+Arrow selection extension via SelectionManager.

### Phase 5 — Preferences, scrollbars, print, the long tail
- `prefers-reduced-motion` engine knob (springs → snap/short). `prefers-color-
  scheme`/`prefers-contrast`/forced-colors hooks.
- Visible scrollbar affordance (auto-hide thumb/track on `Overflow:Scroll`).
- Print path (render mirror / print sheet). Scroll restoration + History API.
- `#hash` deep-link scrollIntoView. `title=` tooltips, richer cursors, DnD.
- RTL/bidi (largest; scope separately) + touch-gesture set (double-tap/pinch).

---

## Principles (per the brief)
- **Abstracted**: gaps solved by the three Core services + mirror-as-projection,
  not per-consumer patches.
- **Robust / not overwritten**: every phase is additive; existing wheel/touch
  scroll, selection, SEO output are regression-guarded, never replaced.
- **Correct / browser-matching**: deltas, `:focus-visible` modality, smooth-scroll
  feel, new-tab click semantics, reduced-motion all match real browser behavior.
