# Layout

## The Core Principle

**Layout is instant. Animation is visual.**

Every frame, the layout solver computes exact final positions for every node in the tree. Pure math. No waiting, no settling, no cascading delays. The result is a complete snapshot of where everything *should* be.

Then springs animate every node from where it *is* to where it *should* be. Every node moves simultaneously toward its target. Nothing waits for a sibling to finish. Nothing skips then moves then skips again.

```
Layout pass (< 1ms):
  ┌──────────────────────────────────────┐
  │  Solve flex constraints              │
  │  All nodes get final x, y, w, h     │
  │  This is the TRUTH — rigid, instant  │
  └──────────────────────────────────────┘
                    │
                    ▼
Animation pass (every frame):
  ┌──────────────────────────────────────┐
  │  For each node:                      │
  │    spring.x → target.x              │
  │    spring.y → target.y              │
  │    spring.w → target.w              │
  │    spring.h → target.h              │
  │  All nodes animate simultaneously    │
  └──────────────────────────────────────┘
                    │
                    ▼
Render pass:
  ┌──────────────────────────────────────┐
  │  Draw each node at spring.value      │
  │  (not at target — at current spring) │
  └──────────────────────────────────────┘
```

When something changes (child added, removed, resized, window resized, style changed), the layout solver re-runs instantly — all targets update in one shot. Springs are already in motion from their current positions; they just get new targets. No interruption, no restart, no jank.

## Why This Matters

The DOM approach (what Jiv.Layout.Engine does today in Show Studio) has a fundamental problem: it measures, then positions, then measures again. Each measurement can trigger a reflow. Each reflow can change dimensions. The cascade is serial and observable — you see elements settle one at a time.

Jwift's approach: the layout solver never reads from the DOM. It reads from its own node tree (sizes, constraints, flex properties). It writes target positions. Springs interpolate. The renderer draws. No DOM in the loop at all.

## JSS Drives Targets

Style sheets provide the constraints. When a JSS property changes (class toggle, responsive breakpoint, state change), the layout solver re-runs with the new constraints and produces new targets. Springs animate to those targets.

```jss
.Sidebar {
  Width: 20em

  @spring Width { Stiffness: 170, Damping: 26 }

  @when Viewport.Width < 900 {
    Width: 0em   // collapses — springs animate the width to 0
  }
}

.Content {
  FlexGrow: 1   // fills remaining space — layout solver computes exact width
  // As Sidebar spring-animates from 20em to 0, layout re-solves every frame,
  // and Content's target width updates every frame.
  // Content's own spring chases that moving target smoothly.
}
```

The layout solver runs every frame (it's fast — pure math on a flat array of nodes). Targets are always fresh. Springs are always chasing. The visual result: everything moves together, nothing waits.

## Two-Phase Separation

| Phase | What it does | Speed | Reads from | Writes to |
|---|---|---|---|---|
| **Layout** | Flex solve, compute positions | Instant (< 1ms for 200 nodes) | Node tree (sizes, constraints) | Target positions |
| **Animation** | Step springs toward targets | Per-frame (16ms budget) | Current spring values + targets | Current spring values |
| **Render** | Draw to WebGL | Per-frame | Current spring values | Pixels |

Layout never waits for animation. Animation never blocks layout. Render reads whatever the springs are at right now.

## Entry and Exit

When a node is added:
1. Layout solver includes it immediately — all sibling targets shift
2. The new node's springs start at an entry state (scale: 0.9, opacity: 0) and animate to (scale: 1, opacity: 1)
3. Siblings spring-animate to their new positions
4. Everything moves simultaneously

When a node is removed:
1. Node is marked as exiting — layout solver excludes it from constraints
2. All sibling targets shift immediately
3. The exiting node's springs animate to exit state (scale: 0.9, opacity: 0)
4. Siblings spring-animate to new positions
5. When exit springs settle, node is removed from the render tree

The entry/exit mode is configurable per node via JSS:

```jss
.ListItem {
  @spring * { Stiffness: 200, Damping: 28 }
  @enter { Scale: 0.9, Opacity: 0 }
  @exit { Scale: 0.9, Opacity: 0 }
}

.ModalPanel {
  @enter { Transform: TranslateY(100%) }
  @exit { Transform: TranslateY(100%) }
}
```

## Nested Layout

Nodes can contain nodes. Each container runs its own flex solve. The parent's layout provides the container dimensions for the child's layout.

```
Root (1440 x 900)
├── Toolbar (1440 x 54)          ← row, justify: space-between
│   ├── BackButton (54 x 54)
│   ├── Title (auto x 54)
│   └── Actions (auto x 54)     ← row, gap: 0.75em
│       ├── Pill (3em x 3em)
│       └── Pill (3em x 3em)
├── Content (1440 x 792)         ← column, flex-grow: 1
│   ├── Hero (1440 x 400)
│   └── Grid (1440 x auto)      ← row, wrap, gap: 1em
│       ├── Card (30% x auto)
│       ├── Card (30% x auto)
│       └── Card (30% x auto)
└── NavBar (1440 x 54)          ← row, justify: space-evenly
```

Each container resolves independently. The solve is top-down: Root first, then children use the computed dimensions as their container constraints. One pass, no backtracking.

## Scroll Containers

A scroll container is a layout node with `Overflow: Scroll`. Its content can exceed its bounds. The scroll position is a spring — momentum-based, with rubber-band overscroll at edges.

```jss
.ListView {
  Overflow: Scroll
  Direction: Column
  @spring ScrollPosition { Stiffness: 120, Damping: 20 }
}
```

Layout computes the full content height. The scroll spring targets are clamped to `[0, contentHeight - viewportHeight]`. Flick gestures set velocity on the spring. The spring decelerates naturally. Overscroll beyond bounds gets a stiffer spring constant that pulls back.

## Reference Implementation

Show Studio's `Jiv.Layout.ts` is the flex solver — 343 lines of pure math. It handles:
- Row / column / reverse directions
- Flex grow, shrink, basis
- Justify: start, end, center, space-between, space-around, space-evenly
- Align: start, end, center, stretch
- Align-content for wrapped layouts
- Auto margins (consume free space before flex-grow)
- Wrapping with wrap-reverse
- Padding, gap, per-child margins
- Content bounds computation

It has 40+ unit tests in `Jiv.Layout.Test.ts` covering every flex behavior including CSS parity tests.

Show Studio's `Jiv.Layout.Engine.ts` is the spring animation layer on top. It:
- Tracks children via MutationObserver (Jwift won't need this — we own the node tree)
- Measures natural sizes via DOM (Jwift won't need this — sizes come from the style system)
- Runs springs per-child for x, y, w, h, scale, opacity
- Handles entry/exit animation with configurable presence modes

For Jwift, the layout solver (`Jiv.Layout.ts`) ports directly — it's already pure math with no DOM dependency. The engine (`Jiv.Layout.Engine.ts`) gets simplified: no MutationObserver, no ResizeObserver, no DOM measurement. Just node tree → solver → springs → render.
