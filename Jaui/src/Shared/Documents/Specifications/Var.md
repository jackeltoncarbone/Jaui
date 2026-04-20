# @var — declarative variables in JSS

Typed named values authors declare once and reference anywhere. Eliminates
hand-copied magic numbers (the concentric radius chain is the canonical
example: one `@ScreenR` value drives every downstream radius via
arithmetic) and unlocks engine-provided identifiers like `Presence`
(see `Presence.md`), `@If` breakpoints,
and any future context-provided value.

## Language

### Declaration

```jss
@ScreenR:    90
@ChromePad:  24
@GlassTint:  rgba(255, 255, 255, 0.4)
@HeroInset:  80pt
```

`@Name: value` at the **top level** of a `.jss` source file. No separate
`@var` keyword — the `@` prefix is already the signal, and the trailing
`:` distinguishes a declaration from a reference. `Name` is PascalCase.
`value` is any literal the matching property type accepts (number, Length,
color, string enum, etc.). Declarations live at the top level in V1 — no
selector-nested declarations, no scoped overrides. One global table per
stylesheet.

### Reference

Any property value that accepts a Length (or the declared type) can
reference a var with `@Name`:

```jss
Screen           { BorderRadius: @ScreenR }
ToolbarDropdown  { BorderRadius: @ScreenR - @ChromePad }
ToolbarAvatar    { BorderRadius: @ScreenR - @ChromePad - 4 }
HeroStub         { Padding: 128 32 32 @HeroInset }
```

References work inside arithmetic expressions — the Length parser already
handles `+ - * /` and parens, so `@ScreenR - @ChromePad - 4` resolves
exactly like `90 - 24 - 4 → 62`.

### Why not `@var Name:`?

The earlier Styling.md drafts showed `@var Name: value`. Dropped because:
- `@Name:` is already unambiguous — a trailing colon at top level means
  declaration, no colon in an expression means reference. No keyword
  needed.
- Shorter to type, cleaner to read, especially in long stylesheets.
- Matches CSS custom-property intuition (`--name: value` / `var(--name)`)
  without the `var()` wrapper noise at the call site.

The old syntax is a style-guide decision, not a grammar one. `@var` is a
keyword reserved so authors who reach for it by habit get a clear parse
error pointing at the new form.

### Resolution rules

- **Lazy / use-time.** Vars are substituted when a property is resolved to
  its final value, not at parse time. Cheap because the parse tree already
  carries unresolved expressions; style resolution walks them each time
  it runs anyway.
- **Single global table per stylesheet.** The registry (`Jss.Registry`)
  owns the var table; it's built during stylesheet registration, before
  any rulesets apply.
- **Vars reference other vars.** `@A: 10` then `@B: @A * 2` is valid.
  Resolved lazily, so declaration order doesn't matter as long as no cycle
  exists.
- **Reserved names.** Certain identifiers are engine-provided built-ins
  and live in a separate namespace from `@`-prefixed vars — no prefix,
  read-only in property expressions, per-Jiv. V1 reserves `Presence`
  (see `Presence.md`). Authors declaring `@Presence: …` get an error at
  registration pointing out that `Presence` is a built-in and doesn't
  take the `@` prefix.

### Error behavior

- **Missing var.** Resolving `@Foo` with no declaration is an error with a
  clear message naming the var and the property that referenced it. The
  property falls back to its type's default and the engine logs a warning
  once per (var, property) pair.
- **Circular reference.** `@A: @B`, `@B: @A` — detected during
  resolution (walk the chain, bail when depth > 16 or a name repeats).
  Treated the same as missing: warn, fall back.
- **Type mismatch.** `BorderRadius: @GlassTint` — the resolver receives
  a color where a number is expected. Warn, fall back. V1 doesn't type-
  check at parse time; trust the author.

## `concentric` keyword

First-class BorderRadius value that computes itself from the nearest
ancestor with a resolved BorderRadius, minus the cumulative inset from
that ancestor's inner edge to this node's outer edge. Eliminates the
last hand-copied number in the concentric chain.

```jss
@ScreenR:   90
@ChromePad: 24

Screen           { BorderRadius: @ScreenR }         /* root — explicit */
ChromeFrame      { Padding: @ChromePad }            /* contributes to inset */
ToolbarDropdown  { BorderRadius: concentric }       /* = @ScreenR - @ChromePad */
ToolbarAvatar    { Padding: 4; BorderRadius: concentric }
                 /* walk: Avatar's parent is Dropdown (has BR, not concentric yet
                  * when resolving Avatar; but see "resolution order" below).
                  * Falls back to ScreenR chain:
                  * = @ScreenR - @ChromePad - (Dropdown padding 4)
                  * = 90 - 24 - 4 = 62 */
```

### Resolution

When a BorderRadius is `concentric`, the resolver:

1. Walks up the tree from this node toward the root.
2. At each ancestor, adds the gap between that ancestor's content box
   and this node's outer edge — uses the ancestor's `Padding` plus any
   intervening `Margin` / flex gap.
3. Stops at the first ancestor with a **resolved** BorderRadius (i.e.,
   a non-`concentric` value, or a `concentric` that's already been
   resolved for that ancestor this frame).
4. Returns `ancestor.BorderRadius - cumulativeInset`.

If the walk reaches the root without finding a resolved radius, the
result is 0 (sharp corners). This matches the real behavior when nothing
up the chain is round.

The resolver runs after layout, so it has resolved Padding values to
work with. `concentric` is a BorderRadius-only keyword in V1 — the
inverse direction (parent's radius derived from child's) is cross-cut
and deferred.

### Non-uniform padding

If an ancestor has non-uniform Padding (e.g., `Padding: 20 24 20 24`),
the concentric formula reads **the padding on the edge facing this
node's side**. For a child inset from all four edges (typical chrome
case), `concentric` uses the minimum padding — the concentric curve
only truly matches if all four edges share the same gap. If the
designer needs per-corner values they set them explicitly.

In practice: keep chrome containers uniform-padded (as `ChromeFrame`
is today, `Padding: 24`) and concentric Just Works.

## @If — inline responsive rules

Not in scope for V1 implementation, but covered here so its interaction
with `@var` and `concentric` is clear. The syntax from `Styling.md`:

```jss
HeroStub {
  Padding: 128 32 32 32
  /* Show Studio's min(7%, 12.5em) desktop rule, expressed as a
   * viewport-width breakpoint. */
  @If Width > 768 {
    Padding: 128 32 32 @HeroInset    /* 80pt on wide viewports */
  }
}
```

Self-queried (the element checking its own size rather than the
viewport):

```jss
Card {
  Width: 260
  Padding: 16 18 18 18

  @If Self.Width < 180 {
    Padding: 10              /* collapse padding on narrow cards */
  }
}
```

Paired with `@var` to parameterize breakpoints:

```jss
@Breakpoint: 768

HeroStub {
  Padding: 128 32 32 32
  @If Width > @Breakpoint {
    Padding: 128 32 32 80pt
  }
}
```

Conditions evaluate at layout time — when the viewport crosses 768px,
the conflicting `Padding` inside `@If` wins and cascades through the
resolver. No JS breakpoint listeners, no media-query strings.

## Nested scoping (not in V1, for reference)

Vars declared inside a selector are only visible to that selector and
its descendants:

```jss
/* NOT implemented in V1 */
Card {
  @R: 28
  BorderRadius: @R
  CardKicker { FontSize: @R / 2 }    /* 14 — @R visible here */
}

Section {
  /* @R: ERROR — undeclared in this scope */
}
```

Useful for component-local sizing tables without global-namespace
pollution. Adds lexical scope + shadow resolution to the parser. V1
skips this — the top-level flat table covers the concentric-chain and
responsive use cases. Revisit once components want to carry their own
tokens independently.

## Implementation plan

### Touch points

| File | Change |
|---|---|
| `Jaui/src/Jss/Jss.Parser.ts` | Recognize `@Name: value` at top level (no preceding keyword). Emit a `VarDecl` node with the raw value expression. Keep `@var` as a reserved-keyword error message pointing to the new form. |
| `Jaui/src/Jss/Jss.Registry.ts` | Hold the var table `Map<string, ParsedExpr>`. Built from `VarDecl` nodes during stylesheet registration. |
| `Jaui/src/Core/Length.ts` | Extend the Length grammar to accept `@Name` as a primary (new `_VarRef { Name: string }` AST node). |
| `Jaui/src/Core/Length.ts` | Extend `ResolveContext` with `Vars: VarTable`. Resolver recurses into `_VarRef`, looks up the name, resolves the referenced expression. |
| `Jaui/src/Core/Style.Resolver.ts` | Thread the var table into every `Resolve` / `ResolveLengthTuple4` call via the context. Add `concentric` handling in the BorderRadius path. |
| `Jaui.Angular/src/Jss/Jss.Registry.ts` | When `<jyle>` parses a source, seed the registry's var table. |
| Tests: `Jaui/tests/Jss.Var.test.ts` | Declaration, reference, arithmetic, chained vars, missing var, circular ref, concentric. |

### Milestones

1. **M-Var-1: parse `@Name: value` declarations.** Parser reads the
   declarations at the top of a `.jss` file, builds the var table on the
   registry. No references yet — just the table. Verify by dumping the
   registry's vars in a test.
2. **M-Var-2: `@Name` in Length expressions.** Length parser accepts
   `@Name` as a primary. Resolver looks up the name in the context's
   var table and resolves the referenced expression recursively. Error +
   fallback on missing / circular.
3. **M-Var-3: pipe the var table through style resolution.** Every
   property that uses `Resolve` / `ResolveLengthTuple4` gets the table.
   Author can now write `BorderRadius: @ScreenR - @ChromePad` and it
   resolves at layout time.
4. **M-Var-4: reserved name guard.** Parser errors if the author
   declares `@Presence: …` — `Presence` is an engine built-in and
   belongs to a different namespace. Clear error message points to
   the no-`@` built-in form.
5. **M-Var-5: `concentric` keyword.** Resolver walks ancestors at
   BorderRadius resolution time. Layout-order dependency: must run after
   layout for Padding to be resolved. Rewrite `Home.jss` chrome chain to
   prove it.
6. **M-Var-6: author-facing polish.** Source locations in errors, chain
   depth limit, consistent warning format.

### Tests to write

- `@X: 40` → referenced as `@X` → resolves to 40
- `@X: 40; @Y: @X * 2` → `@Y` resolves to 80
- `@X: @Y; @Y: @X` → circular → warn + fall back
- `@X: 5` → `@Z` (undeclared) → warn + fall back
- `@X: 40pt` → `@X` at PointScale 1.25 → 50
- `@var X: 40` → error: "use `@X: 40` instead"
- Properties using `@X`: `BorderRadius`, `Padding`, `Gap`, `Width`,
  `Height`, `FontSize`.
- Multi-inheritance: a base style using `@X` is extended — var still
  resolves correctly.
- `concentric`: nested two levels deep with different paddings, verify
  cumulative inset math.
- `concentric` on the root (no ancestor radius) → 0.
- `concentric` with non-uniform padding → uses min of relevant edges.

## Not in scope (V1)

- **Nested `@Name` inside selectors** (lexical scoping). Useful for
  component-local vars, but adds parser complexity and scope resolution
  rules. V1 is flat top-level only.
- **Inverse-direction `concentric`** (parent's radius derived from a
  child's radius + padding). Ambiguous semantics when the parent has
  multiple children with different radii; deferred.
- **Type declarations.** `@Radius: Length 90` or similar. V1 infers
  from the value literal's syntactic form.
- **Cross-stylesheet vars.** If two `.jss` sources are both registered,
  each has its own var table. Sharing is done by importing / prefacing.
  No namespacing in V1.

## Sample: concentric chain rewrite with everything in

```jss
@ScreenR:   90
@ChromePad: 24
@GlassPad:  4

Screen          { BorderRadius: @ScreenR }
ChromeFrame     { Padding: @ChromePad }
ToolbarDropdown { Padding: @GlassPad;  BorderRadius: concentric }
ToolbarAvatar   {                       BorderRadius: concentric }
TabBar          { Padding: @GlassPad;  BorderRadius: concentric }
TabItem         {                       BorderRadius: concentric }
```

Bump `@ScreenR` from 90 to 100 and every radius updates correctly.
Bump `@ChromePad` from 24 to 32 and the whole chrome inset moves
with all derived radii. No chain to hand-maintain, no comments-as-math
to keep in sync.
