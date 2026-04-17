# Presence — entry, exit, and existence as a spring

Existence itself is a spring-driven value. Every Jiv has a `Presence` — a
number in `[0, 1]` that rises from 0 to 1 when the Jiv enters the tree and
falls from 1 to 0 when it's about to leave. The spring is the single source
of truth for "is this node here"; opacity, scale, offset, and anything else
derive from it.

The whole point: no Jiv ever pops in or out. Adding `<jiv>` to an Angular
template dissolves it in; removing it dissolves it out. Authors customize
how per class with one variable.

## The built-in identifier

`Presence` is a reserved built-in identifier, provided by the engine
per Jiv. In any property value context it resolves to the current
Jiv's Presence spring value (0..1), re-evaluated each frame as the
spring moves.

It lives in a separate namespace from user-declared `@Name` vars — no
`@` prefix because the author didn't declare it. The distinction is
visual and meaningful: `@MyR` = "I defined this at the top," `Presence`
= "the engine hands me this per Jiv."

```jss
Card {
  Opacity: Presence
  Transform: scale(0.96 + 0.04 * Presence)
}

Toast {
  Opacity: Presence
  OffsetY: -20 * (1 - Presence)
}
```

Reading `Presence` outside a Jiv context (e.g. in a top-level `@Name:`
declaration) is an error — it's a node-scoped value by definition.
Authors cannot declare `@Presence: …` (reserved identifier) or redefine
`Presence` at the property level.

## Default behavior

If an author writes no `Presence` reference, the engine still drives
entry/exit via an **implicit `Opacity: Presence` binding**. Every Jiv
fades in and out by default. This matches the engine's "everything
animates, no hard seams" posture.

Authors opt out of the default per class by setting Opacity explicitly:

```jss
InstantPopup {
  Opacity: 1          /* no fade — hard pop in/out */
}
```

The implicit binding is applied only when the author hasn't set `Opacity`
themselves (whether or not `Presence` is referenced elsewhere).

## Lifecycle

Four moments in a Jiv's existence:

1. **Mount.** The framework binding (Angular, etc.) adds the Jiv to the
   tree. The engine initializes `Presence = 0` and sets the target to 1.
   The spring takes over.

2. **Steady state.** Once `Presence ≥ 1 − ε`, the Jiv is fully present.
   The spring holds at 1. Properties bound to `Presence` sit at their
   fully-there value.

3. **Leave intent.** The framework binding wants to remove the Jiv (e.g.
   Angular's `ngOnDestroy`). The engine does NOT remove the node from the
   tree — it sets `Presence` target to 0 and marks the Jiv as leaving.
   The Jiv continues to participate in layout and rendering while the
   spring falls.

4. **Unmount.** Once `Presence ≤ ε`, the engine removes the Jiv from the
   tree for real. Framework bindings never see this — their lifecycle
   already ran at step 3.

The framework binding's `ngOnDestroy` must not call `parent.RemoveChild`
directly. Instead it calls a `RequestLeave()` method that triggers the
spring. The engine guarantees eventual removal once the spring settles.

## Layout and Presence

By default, a leaving Jiv **keeps its layout space** until Presence reaches
0. Siblings do not reflow while it fades. This preserves visual stability
during exit.

Authors can opt into collapsing-on-exit by binding sizing to `Presence`:

```jss
Collapsing {
  Opacity: Presence
  Height: Presence * 48        /* node shrinks to 0 height as it leaves */
}
```

The layout solver reads the `Presence`-resolved `Height` value each pass.
Neighbors flex into the vacated space smoothly, no special-case.

## Directional cues — Entering / Exiting

Most UIs look fine with symmetric enter/exit (the node enters from the
same place it exits to). For asymmetric cases, the engine provides two
boolean flags on the Jiv:

- `Entering` — true while Presence is below 1 AND the target is 1
- `Exiting` — true while Presence is above 0 AND the target is 0

These let an author branch via `when(...)` inside JSS:

```jss
Toast {
  Opacity: Presence
  /* enter from top, exit to the right */
  OffsetX: when(Exiting, 40 * (1 - Presence), 0)
  OffsetY: when(Entering, -20 * (1 - Presence), 0)
}
```

If you don't need asymmetry, you don't need these flags — `Presence`
alone produces clean symmetric animation.

## Interaction with `@Spring`

The Presence spring has sensible defaults (Stiffness 220, Damping 26,
Mass 1). Override per-class with `@Spring Presence { ... }` — same as
any other property spring. For a stylesheet-wide default, use the
universal selector `*`:

```jss
/* App-wide default — a touch gentler than the engine's 220/26. */
* {
  @Spring Presence { Stiffness: 200, Damping: 26 }
}

/* Modals feel heavier — override for just this class. */
Modal {
  @Spring Presence {
    Stiffness: 140
    Damping: 30
  }
}

/* Toasts snap in and out faster than the default. */
Toast {
  @Spring Presence {
    Stiffness: 320
    Damping: 28
  }
}
```

Same cascade rules as any other JSS property: more specific selector
wins, later declaration wins within equal specificity.

## Driving other animations off Presence

Because `Presence` is just a value, any animatable property can reference
it. Common idioms:

```jss
/* fade + scale (default-ish Apple feel) */
.Card {
  Opacity: Presence
  Transform: scale(0.94 + 0.06 * Presence)
}

/* slide up from below the viewport */
.BottomSheet {
  Opacity: Presence
  OffsetY: 400 * (1 - Presence)
}

/* fade and blur out */
.Page {
  Opacity: Presence
  BlurAmount: (1 - Presence) * 12
}

/* entry-only bounce, clean exit */
.Hero {
  Opacity: Presence
  Transform: when(Entering, scale(0.9 + 0.15 * Presence), scale(1))
}
```

No imperative animation calls. The spring drives Presence; Presence drives
everything else via the resolver.

## Implementation notes

- **Storage.** `Element.Presence: number` (current value) + a spring
  targeting 1 or 0. Integrated into the existing `AnimationManager` loop.

- **Default state.** On construction, `Presence = 0`, target = 1. The
  spring ticks toward 1 immediately.

- **Leave.** Public method `Element.RequestLeave()` sets target = 0 and
  registers a settle callback that removes the node from its parent.
  Idempotent — calling twice is a no-op after the first.

- **Resolver.** `Presence` is a reserved variable. When the style
  resolver encounters it in an expression, it substitutes the current Jiv's
  `Presence` value. Properties whose expressions contain `Presence` are
  marked "Presence-dependent" and re-resolved each frame (not spring-
  animated — the spring is on Presence, not on the derived property).
  Properties without `Presence` use the normal spring-to-target pipeline.

- **Implicit Opacity.** During style resolution, if `Opacity` is not set by
  any rule, it implicitly resolves to `Presence`. This is a one-line
  fallback at the end of style resolution — doesn't require any AST
  rewriting.

- **Framework bindings.** `Jwift.Angular`'s `Jiv.ngOnDestroy` calls
  `this.Node.RequestLeave()` instead of `Parent.RemoveChild(this.Node)`.
  No other framework changes.

## Edge cases and policy calls

### Remove API

`Element.RequestLeave()` is the public entry point for animated removal.
Framework bindings (Angular, React, etc.) route their destroy hooks
through it. For internal engine use or explicit "rip this out now" cases,
`Element.RemoveChildImmediate()` bypasses the spring and hard-removes —
useful when shutting down a canvas or swapping entire trees. Regular
`AddChild` / `RemoveChild` default to animated behavior.

### Accessibility during exit

A Jiv that's leaving (Presence target = 0, current > 0) is removed from
the accessibility shadow DOM **immediately on `RequestLeave`**. Screen
readers don't announce content that's on its way out; users who rely on
AT get the semantic update at the same moment a mouse user starts the
visual transition. The visual-only Jiv lingers in the render tree until
the spring settles.

### Nested exits

When a parent calls `RequestLeave`, only the parent's Presence springs.
Children keep their own Presence at 1 — they don't get their own fade.
The parent's opacity (via the implicit `Opacity: Presence` or an
explicit binding) cascades through the scene graph so children fade
along with the parent visually. When the parent's spring settles at 0
and is hard-removed, its entire subtree is hard-removed with it (no
per-child fade). This is visually fine — the subtree was already at
Opacity 0 when the parent hit 0.

If per-child cascade IS wanted (e.g., stagger children leaving one by
one before the parent does), the author coordinates that explicitly by
calling `RequestLeave` on the children first, waiting for their springs
to settle, then calling it on the parent.

### Settling threshold

The spring is considered settled when `|Presence − target| < 0.005` AND
`|velocity| < 0.02`. At 60fps with default stiffness/damping, the fade-
out completes in ~400ms and the engine removes the Jiv within 1–2 frames
of the visual fade finishing.

### Interruption

Spring targets can change mid-flight. If a Jiv is entering (target=1,
current=0.6) and the binding calls `RequestLeave` (target=0), the spring
reverses from its current velocity. `Entering` becomes false and
`Exiting` becomes true the moment the target changes, regardless of
current value. The Jiv never "snaps" — one continuous spring trajectory.

Re-entering during a leave works the same way: setting target back to 1
while Presence is falling reverses it. The Jiv is never hard-removed as
long as the target is 1 (or newly set to 1 before settle).

## Not in scope

- **Staggered entry.** List children entering with offset delays. Doable
  via per-child `@EnterDelay` or on the parent as a stagger config, but
  out of this spec.
- **Per-property entry/exit curves** beyond what `Presence * f` can
  express. If someone wants a completely different curve shape for exit
  than entry, they use `Entering` / `Exiting` branching — good enough.
- **Imperative Presence scrubbing.** Author code setting `jiv.Presence`
  directly (e.g. for drag-driven reveal gestures) is not part of V1.
  Presence is engine-managed. Gesture-driven appearance is expressible
  via other animatable properties referencing a gesture signal.
- **SSR / instant first paint.** Initial mount starts at Presence = 0
  and springs to 1, so the app fades in on first load. For environments
  that need instant-on (e.g. SSR hydration), a future `InstantMount` mode
  would set Presence = 1 on the first frame without a spring. Out of V1.
- **`when(cond, a, b)` expression syntax** used in the Entering /
  Exiting examples. Requires a small Length grammar extension; specced
  separately when that feature lands. Without it, authors can express
  the same logic with arithmetic: `Entering * (-20) * (1 - Presence)`.

## Milestones

1. **M-Presence-1** — `Element.Presence` field + spring + default 0→1 on
   mount. Hook into animation manager. Visual: newly-created Jivs fade in.
2. **M-Presence-2** — `RequestLeave()` + settle-then-remove + framework
   binding change. Visual: removed Jivs fade out and clear from the tree.
3. **M-Presence-3** — JSS `Presence` reserved var + resolver support.
   Visual: authors can customize per class (scale on Cards, slide on
   Toasts).
4. **M-Presence-4** — `Entering` / `Exiting` flags + `when(...)`
   branching. Visual: asymmetric animations.
5. **M-Presence-5** — `@Spring Presence` override per class. Visual:
   different materials get different feels.
