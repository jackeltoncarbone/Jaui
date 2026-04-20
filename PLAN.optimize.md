# Optimization Plan — Jaui Render Loop

Written 2026-04-17. Constraint: **zero visual change** — no quality
tradeoffs, no different z-order, no perceptible rendering difference.

---

## Current architecture (read this first)

`Canvas._tick` fires on every `requestAnimationFrame`. It:
1. Checks `_hasDirtyLayout` + `_hasDirtyText` (full tree walks)
2. If dirty: cascade PointScale → measure text → intrinsic sizes → solve layout
3. `_processTextTransitions` (full tree walk, every frame)
4. `_render` (always, every frame)

`_render` does a **single DFS tree walk** (`renderNode`). At each node:
- Encode clip stack
- If **glass** → `SnapshotScreen()` + `ComputeBlur()` + `GenerateBlurMipmap()` + draw 1 panel
- If **progressive blur** → similar snapshot+blur + draw
- If **non-glass** → `PanelBeginBatch` + `PanelAddInstance` + `PanelDrawBatch` (1 draw call per node)
- Image draw (if ImageSrc)
- Text draw (per-node batch)
- Recurse children (sorted by `Layer`)

`AnimationManager` runs a SEPARATE RAF loop (`_tick`) for springs. When
springs are active, it ticks them and calls `Canvas.RequestFrame()` —
which is currently a no-op (Canvas has its own RAF loop that always renders).

---

## Problem breakdown

### P1. Canvas renders every frame, even when idle
`_render` runs on every RAF tick unconditionally. When nothing is
animating (no springs, no scroll, no dirty flags), every frame still:
- Walks the full tree
- Encodes clip stacks
- Issues draw calls for every visible node
- Submits GPU work

On the Home page with ~40 nodes, that's ~40 draw calls × 60 fps =
2400 draw calls/sec doing nothing.

### P2. One draw call per non-glass node
Each non-glass panel issues its own `PanelBeginBatch → AddInstance →
DrawBatch` cycle. WebGL/WebGPU draw calls have fixed overhead
(~0.01–0.05 ms each on mobile). 30 non-glass nodes = 30 draw calls
= 0.3–1.5 ms of pure driver overhead.

The instance buffer already supports multiple instances — the batch
infrastructure exists, it's just not used. Every non-glass node CAN
share the same DrawBatch (same shader, same backdrop=null, same
uniforms) — they differ only in per-instance data (rect, style,
clip offset) which is already encoded per-instance.

### P3. One draw call per text node
Same issue as P2. Each text-bearing node emits its own text batch.
The text shader is identical across nodes (same atlas, same
uniforms). Could batch all text instances between glass boundaries.

### P4. Glass snapshot+blur per panel
Each glass panel triggers: `SnapshotScreen` (GPU copy) +
`ComputeBlur` (4–6 blur passes) + `GenerateBlurMipmap` (1 pass).
Home page has ~6 glass panels = 6 × (copy + blur + mipmap) = ~30
extra GPU passes.

Glass panels at the same Layer that don't overlap can share one
backdrop snapshot — the visual result is identical because glass
doesn't occlude (it's translucent refraction). Apple's glass panels
share a single pre-glass backdrop layer.

### P5. Full tree walks for dirty checks
`_hasDirtyLayout` and `_hasDirtyText` walk the entire tree each
frame to find ANY dirty node. O(N) per frame even when nothing is
dirty. Could use a single Canvas-level flag that `MarkLayoutDirty`
sets.

### P6. orderedChildren allocates on sort
`[...children].sort(...)` at line 291 allocates a new array for
every node with any non-zero Layer child. On the Home page, Screen
has Fixed children (Layer 10, 20) so this allocates + sorts every
frame. Cache the sorted order and invalidate only on child
add/remove/Layer change.

### P7. _processTextTransitions walks full tree every frame
Even when no text has changed, this walks every node to check for
wrap-change detection. Could gate on a "any text spring active" flag.

---

## Fix plan (ordered by impact, safe to implement independently)

### Fix 1: Idle-frame skip (P1) — HIGHEST IMPACT
When nothing is animating and nothing is dirty, skip `_render` entirely.

**Detection:** After layout solve + text transitions, check:
- `AnimationManager.IsRunning` — any spring active?
- `ScrollManager` has active scroll easing?
- `PresenceManager` has active presence springs?
- Any `_hasDirtyLayout` (already checked)?

If ALL false, skip `_render`. Set a `_needsRender` flag that gets
set by: `MarkLayoutDirty`, `AnimationManager.Kick`, scroll events,
pointer interaction state changes.

**Risk:** Zero visual change — idle frames produce identical output.
The only risk is missing a trigger (a change that doesn't set the
flag), causing a stuck frame. Mitigate: always render for N frames
after any input event, then check idle.

**Files:** `Jaui/src/Core/Jaui.ts` (`_tick`, `_render`,
`RequestFrame`).

### Fix 2: Batch non-glass panel draw calls (P2)
Accumulate non-glass panel instances into one batch. Flush when:
- A glass node is encountered (needs snapshot of current screen)
- A progressive-blur node is encountered (same)
- End of tree walk

Between glass panels, ALL non-glass nodes share:
- Same shader program
- Same backdrop (null)
- Same uniforms (resolution, specular tilt)
- Different per-instance data (already handled by instance buffer)

**Implementation:** In `renderNode`, instead of calling
PanelDrawBatch immediately for non-glass, push to a pending list.
Add a `flushPanels()` helper that draws all pending instances in one
batch. Call it before glass/progressive-blur nodes and at the end.

**Clip buffer:** Already per-instance (each instance carries its own
clip offset+count). No change needed.

**Z-order concern:** Non-glass panels are opaque fills or transparent
with alpha blending. Between two non-glass nodes with no glass between
them, the z-order is panel-A → text-A → children-A → panel-B →
text-B → children-B. If we batch panel-A and panel-B together,
panel-B renders first (before text-A and children-A finish). This
is ONLY safe if panel-B doesn't visually overlap with text-A or
children-A. In practice, siblings don't overlap their panels (children
are clipped inside parents, siblings are laid out by flex). So this
is safe for non-overlapping trees. For safety, only batch siblings
at the same parent.

**Files:** `Jaui/src/Core/Jaui.ts` (`renderNode`).

### Fix 3: Batch text draw calls (P3)
Same strategy as Fix 2: accumulate text instances, flush before
glass/blur boundaries. All text uses the same atlas texture per
frame. Flush at the same points as panel flush.

**Z-order:** Text for node A must paint after panel A. If we batch
text separately from panels, we need a two-pass approach: first all
panels in a run, then all text in that run. This preserves
panel-under-text ordering.

**Files:** `Jaui/src/Core/Jaui.ts` (`_emitTextFor`, `renderNode`).

### Fix 4: Share glass backdrop within a layer (P4)
When multiple glass panels appear without intervening non-glass
content, reuse the same snapshot+blur. Current code sets
`backdropDirty = true` after every glass draw — change to only set
it when non-glass content draws AFTER glass.

**Implementation:** Move `backdropDirty = true` from the glass
branch to the non-glass branch (guarded by `lastBackdrop !== null`).

**Visual impact:** Glass panels will see the pre-glass scene in their
refraction instead of seeing prior glass panels' output. This matches
Apple's behavior (glass panels at the same z-level share one backdrop
layer). Imperceptible difference — glass panels don't typically
overlap.

**Caveat:** If two glass panels DO overlap (e.g. a tooltip over a
toolbar), the second should see the first in its refraction. On this
page, no glass panels overlap, so safe. For correctness, gate on
AABB overlap: if next glass panel overlaps any prior glass panel's
rect, re-snapshot; otherwise reuse.

**Files:** `Jaui/src/Core/Jaui.ts` (`renderNode` glass branch).

### Fix 5: Canvas-level dirty flag (P5)
Replace the O(N) `_hasDirtyLayout` tree walk with a single boolean
on Canvas. `Element.MarkLayoutDirty()` sets `Canvas._layoutDirty =
true` (needs a back-pointer from Element to Canvas, or a global
flag). Clear after layout solve.

**Files:** `Jaui/src/Element/Element.ts`, `Jaui/src/Core/Jaui.ts`.

### Fix 6: Cache sorted children (P6)
Cache `orderedChildren` result on the Jiv. Invalidate when:
- Child added/removed
- Child's Layer value changes

Store as a `_sortedChildren: Jiv[] | null` field on Element. Return
`Children` directly when null (no sort needed).

**Files:** `Jaui/src/Element/Element.ts` or `Jaui/src/Jiv/Jiv.ts`,
`Jaui/src/Core/Jaui.ts`.

### Fix 7: Gate text transition walk (P7)
Only walk `_processTextTransitions` when at least one TextAnimator
has an active spring. Track via a counter incremented when a text
spring kicks and decremented when it settles.

**Files:** `Jaui/src/Core/Jaui.ts`, `Jaui/src/Text/Text.Animator.ts`.

---

## Measurement approach

Before implementing, instrument `_tick` to measure per-frame timing:
```ts
const t0 = performance.now();
// ... layout
const t1 = performance.now();
// ... text transitions  
const t2 = performance.now();
// ... render
const t3 = performance.now();
console.log(`layout=${(t1-t0).toFixed(1)} text=${(t2-t1).toFixed(1)} render=${(t3-t2).toFixed(1)}`);
```

Also count draw calls per frame (increment a counter in each
`DrawBatch` call) to measure batching effectiveness.

Target: < 4 ms total frame time on MacBook Air M1, < 8 ms on
iPhone 12. Currently likely 8–12 ms on Mac (estimated from the
"laggy" report on user's fastest device).

---

## Implementation order

Idle-frame skip (Fix 1) is a DEFERRED afterthought — it hides bad
base performance instead of fixing it. Implement it last, behind a
`Canvas.IdleSkip` toggle (default OFF during development so the
always-rendering path stays honest and measurable).

Priority order — fix the actual per-frame cost first:

1. **Fix 4 (shared glass backdrop)** — reduces GPU work substantially,
   biggest single-frame cost reduction
2. **Fix 2 + Fix 3 (batch panels + text)** — reduces draw call count,
   the main CPU→GPU overhead
3. **Fix 5 (dirty flag)** — cheap tree-walk elimination
4. **Fix 6 + Fix 7 (cache/gate)** — minor but clean
5. **Fix 1 (idle skip)** — add last, behind `Canvas.IdleSkip` toggle

Each fix is independently deployable and testable. Run the 230 test
suite after each. Visual verification via the Home demo on port 6777.
